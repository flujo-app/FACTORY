import { randomBytes } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FactoryCloudLiteFleet } from './fleet.mjs';
import { validateCloudLitePlan } from './protocol.mjs';
import { packFactorySdk } from './bundle.mjs';

/** Fly.io's Sprites API. */
export const SPRITES_API = 'https://api.sprites.dev/v1';
/** A Sprite has no image: every one starts as the same ready-made Ubuntu computer. The fleet journal records this name instead. */
export const SPRITE_IMAGE = 'sprite:ubuntu';
/** The provider commands a fleet sends. A fleet command missing here would fail on Sprites, so a test compares the two. */
export const SPRITES_FLEET_COMMANDS = Object.freeze(['apps create', 'apps destroy', 'secrets import', 'volumes create', 'volumes list',
  'machine list', 'machine start', 'machine stop', 'machine update', 'machine exec', 'ssh sftp']);

const SERVICE = 'factory';
// Not /run: a Sprite that wakes from a cold start has an empty /run, and its service starts again from these files.
const ROOT = '/etc/factory';
const START = `${ROOT}/start.sh`;
const STAGING = '/home/sprite/.factory-staging';
const BOARD_PORT = 4200;
// Larger files go through the Sprite's file API to a staging folder; smaller ones travel inside one command's input.
const INLINE_LIMIT = 4 * 1024 * 1024;
// A command longer than this goes to the Sprite as its input: an address that long may be refused.
const SCRIPT_IN_ADDRESS = 2048;
const STOP_SECONDS = 30;
const STATES = { running: 'started', starting: 'starting', stopping: 'stopping', stopped: 'stopped', failed: 'failed' };
const VALUE_FLAGS = new Set(['--app', '--org', '--network', '--region', '--size', '--machine-config', '--file-local', '--timeout', '--machine']);

const checked = (value, pattern, what) => { if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`Invalid ${what}.`); return value; };
const appName = value => checked(value, /^[a-z][a-z0-9-]{2,55}$/, 'app');
const quote = text => `'${String(text).replaceAll("'", `'\\''`)}'`;

/**
 * The script a machine's service runs, as root. It loads the machine's settings and secrets from root-only files,
 * holds a Sprite task so the Sprite stays awake while the worker runs (a Sprite otherwise pauses about 30 seconds
 * after its last connection, even in the middle of a model call), and lets it go when the worker stops. The task
 * lasts five minutes and is renewed every minute, only while this script is alive.
 */
export const SPRITE_START_SCRIPT = `#!/bin/bash
for f in ${ROOT}/env/* ${ROOT}/secrets/*; do [ -f "$f" ] && export "$(basename "$f")=$(cat "$f")"; done
task() { curl -s -o /dev/null --max-time 10 --unix-socket /.sprite/api.sock -X "$1" -H 'content-type: application/json' \${2:+-d "$2"} http://sprite/v1/tasks/${SERVICE} || true; }
( while kill -0 $$ 2>/dev/null; do task PUT '{"expire":"5m"}'; sleep 60; done ) &
keeper=$!
"$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT
wait "$child"; code=$?
while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
kill "$keeper" 2>/dev/null
task DELETE
exit "$code"
`;

function parse(args) {
  const words = [], flags = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const cut = arg.indexOf('=');
    const name = cut === -1 ? arg : arg.slice(0, cut);
    (flags[name] ??= []).push(cut !== -1 ? arg.slice(cut + 1) : VALUE_FLAGS.has(name) ? args[++index] : true);
  }
  return { words, flags };
}

function writePrivate(file, text) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.next`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
}

/** The HTTP exec answer is framed: 0x01 before standard output, 0x02 before errors, 0x03 and the exit code at the end. */
export function readExecOutput(bytes) {
  const exit = bytes.length >= 2 && bytes[bytes.length - 2] === 3 ? bytes[bytes.length - 1] : null;
  const text = bytes.subarray(0, exit === null ? bytes.length : bytes.length - 2).toString('utf8').replace(/[\x01\x02]/g, '');
  return { exit, text };
}

/**
 * Fly.io Sprites in place of Fly Machines, for the same fleet. It answers the provider commands a fleet sends:
 * a machine is a Sprite named `<app>-m<index>`, the worker runs as the Sprite service "factory", and a "volume" is
 * the Sprite's own disk, which keeps its files. Sprites have no private network, so the first machine's board is
 * reached on its public Sprite address and protected by the fleet's own per-agent credentials, as on Fly.
 * What the fleet created is recorded in `sprites-state.json`; only Sprites recorded there are changed or removed.
 */
export function createSpritesInfrastructure({ directory, token, tokenFile, api = SPRITES_API, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!isAbsolute(directory ?? '')) throw new TypeError('An absolute private fleet directory is required.');
  if (token === undefined && tokenFile !== undefined) token = readFileSync(tokenFile, 'utf8').trim();
  token ??= process.env.SPRITES_TOKEN;
  if (typeof token !== 'string' || token.length < 20 || /\s/.test(token)) throw new TypeError('A Sprites token is required (token, tokenFile or SPRITES_TOKEN).');
  if (!/^https:\/\/[^/]+(\/[^?#]*)?$/.test(api)) throw new TypeError('The Sprites API address must be https.');
  const stateFile = join(directory, 'sprites-state.json'), secretsFile = join(directory, 'sprites-secrets.json');
  const load = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const state = () => ({ apps: {}, ...load(stateFile) });
  const saveState = value => writePrivate(stateFile, JSON.stringify(value, null, 2));
  const hide = text => String(text).split(token).join('[sprites token]');

  async function call(method, path, { json, body, headers = {}, timeoutMs = 60000, stream = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${api}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: json !== undefined ? JSON.stringify(json) : body });
    } catch (error) { throw new Error(`Sprites ${method} ${path.split('?')[0]} failed: ${hide(error.message)}`); }
    if (stream && response.ok) return response;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw Object.assign(new Error(`Sprites ${method} ${path.split('?')[0]} returned ${response.status}: ${hide(bytes.toString('utf8').slice(0, 300))}`), { status: response.status });
    return bytes;
  }
  const json = async (method, path, options) => { const bytes = await call(method, path, options); const text = bytes.toString('utf8').trim(); return text ? JSON.parse(text) : null; };
  // A Sprite's own fields sit both at the top level and under `data`.
  const sprite = async name => { try { const body = await json('GET', `/sprites/${name}`); return body?.data ?? body; } catch (error) { if (error.status === 404) return null; throw error; } };
  async function spritesNamed(app) {
    const found = []; let continuation;
    do {
      const page = await json('GET', `/sprites?prefix=${encodeURIComponent(`${app}-m`)}&max_results=500${continuation ? `&continuation_token=${encodeURIComponent(continuation)}` : ''}`);
      found.push(...(page?.sprites ?? []).filter(value => new RegExp(`^${app}-m\\d+$`).test(value.name)));
      continuation = page?.has_more ? page.next_continuation_token : undefined;
    } while (continuation);
    return found;
  }

  /**
   * Runs a shell script as root on a Sprite (the Sprite user has password-less sudo) and returns its output.
   * A long script without its own input travels as the command's input rather than in the address.
   */
  async function root(name, script, { input, timeoutMs = 120000 } = {}) {
    const query = new URLSearchParams();
    if (input === undefined && script.length > SCRIPT_IN_ADDRESS) input = script, script = null;
    for (const word of ['/bin/sh', '-c', `exec sudo -n env "PATH=$PATH" /bin/sh ${script === null ? '-s' : `-c ${quote(script)}`}`]) query.append('cmd', word);
    if (input !== undefined) query.set('stdin', 'true');
    const bytes = await call('POST', `/sprites/${name}/exec?${query}`, { body: input, timeoutMs, headers: input !== undefined ? { 'content-type': 'application/octet-stream' } : {} });
    const { exit, text } = readExecOutput(bytes);
    if (exit !== null && exit !== 0) throw new Error(`A command on Sprite ${name} failed (exit ${exit}): ${hide(text.trim().slice(-1500))}`);
    return text;
  }

  /** Writes files as root with exact modes: small ones inside one command's input, large ones through a staging folder. */
  async function writeFiles(name, files) {
    const inline = files.filter(file => file.bytes.length <= INLINE_LIMIT), staged = files.filter(file => file.bytes.length > INLINE_LIMIT);
    for (const file of files) checked(file.path, /^\/[A-Za-z0-9_.@/+-]+$/, 'file path');
    const moves = [];
    for (const file of staged) {
      const temporary = `${STAGING}/${randomBytes(8).toString('hex')}`;
      await call('PUT', `/sprites/${name}/fs/write?${new URLSearchParams({ path: temporary, workingDir: '/', mode: '0600', mkdir: 'true' })}`,
        { body: file.bytes, headers: { 'content-type': 'application/octet-stream' }, timeoutMs: 600000 });
      moves.push(`install -D -o root -g root -m ${file.mode.toString(8)} ${quote(temporary)} ${quote(file.path)} && rm -f ${quote(temporary)}`);
    }
    if (moves.length) await root(name, moves.join(' && '));
    if (!inline.length) return;
    const writer = `const fs=require('node:fs'),path=require('node:path');let d='';process.stdin.setEncoding('utf8').on('data',c=>d+=c).on('end',()=>{for(const f of JSON.parse(d)){fs.mkdirSync(path.dirname(f.path),{recursive:true,mode:0o700});const t=f.path+'.next';fs.rmSync(t,{force:true});fs.writeFileSync(t,Buffer.from(f.data,'base64'),{mode:f.mode});fs.chmodSync(t,f.mode);fs.renameSync(t,f.path);}})`;
    await root(name, `umask 077 && node -e ${quote(writer)}`, { input: JSON.stringify(inline.map(file => ({ path: file.path, mode: file.mode, data: file.bytes.toString('base64') }))) });
  }

  function appState(value, app) { const found = value.apps[app]; if (!found) throw new Error(`The Sprite fleet ${app} was not created by this fleet directory.`); return found; }
  function recorded(app, id) {
    const found = appState(state(), app).machines?.[id];
    if (!found) throw new Error(`Machine ${id} was not found in ${app}.`);
    return found;
  }
  const startWords = config => config.init?.exec ?? [...(config.init?.entrypoint ?? []), ...(config.init?.cmd ?? [])];

  /** Everything a machine's service needs, as root-only files: its settings, the fleet's secrets, the start script and the config's files. */
  async function machineFiles(app, id, config) {
    // The service starts through sudo, which resets PATH; the Sprite user's PATH is where node and npm are.
    const env = { PATH: (await root(id, 'printf %s "$PATH"')).trim() || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...config.env };
    for (const [key, value] of Object.entries(env)) { checked(key, /^[A-Za-z_][A-Za-z0-9_]*$/, 'environment name'); if (typeof value !== 'string') throw new TypeError('Environment values must be text.'); }
    // A worker machine reaches the board on the first machine's public Sprite address (Sprites have no private network).
    if (env.FACTORY_BOARD_MACHINE_ID) {
      const board = await sprite(checked(env.FACTORY_BOARD_MACHINE_ID, /^[a-z][a-z0-9-]{2,62}$/, 'board machine'));
      if (!board?.url || !board.url.startsWith('https://')) throw new Error('The first machine of the fleet has no public address for its board.');
      env.FACTORY_BOARD_ORIGIN = board.url.replace(/\/+$/, '');
    }
    const secrets = load(secretsFile)[app] ?? {};
    return [
      { path: START, mode: 0o700, bytes: Buffer.from(SPRITE_START_SCRIPT) },
      ...Object.entries(env).map(([key, value]) => ({ path: `${ROOT}/env/${key}`, mode: 0o600, bytes: Buffer.from(value) })),
      ...Object.entries(secrets).map(([key, value]) => ({ path: `${ROOT}/secrets/${key}`, mode: 0o600, bytes: Buffer.from(value) })),
      ...(config.files ?? []).map(file => ({ path: checked(file.guest_path, /^\/[^\0]+$/, 'file path'), mode: 0o644, bytes: Buffer.from(file.raw_value, 'base64') })),
    ];
  }
  /** The service: sudo runs the start script as root, which runs the machine's start command. Only the board machine takes the Sprite's address. */
  async function putService(name, config, { boardMachine }) {
    const words = startWords(config);
    if (!words.length || words.some(word => typeof word !== 'string')) throw new TypeError('A Sprite machine needs its start command.');
    const port = boardMachine ? Number(config.env?.FACTORY_BOARD_PORT ?? BOARD_PORT) : null;
    await call('PUT', `/sprites/${name}/services/${SERVICE}?duration=0`, { json: { cmd: '/usr/bin/sudo', args: ['-n', '/bin/bash', START, ...words], needs: [], dir: '/', http_port: port }, timeoutMs: 120000 });
  }
  async function serviceState(name) {
    try { const body = await json('GET', `/sprites/${name}/services/${SERVICE}`); return STATES[body?.state?.status] ?? (body?.state ? 'unknown' : 'created'); }
    catch (error) { if (error.status === 404) return 'created'; throw error; }
  }
  async function machines(app) {
    const value = appState(state(), app), listed = await spritesNamed(app), out = [];
    for (const found of listed) {
      const own = value.machines?.[found.name];
      // A Sprite named like this fleet's but not recorded by it is shown without the fleet's labels, so a fleet refuses it.
      if (!own) { out.push({ id: found.name, name: found.name, state: 'unknown', region: 'sprites', config: {} }); continue; }
      const { files: _files, ...config } = own.config;
      out.push({ id: found.name, name: own.name, state: await serviceState(found.name), region: 'sprites', url: found.url, config });
    }
    return out;
  }

  async function run(args, options = {}) {
    const { words, flags } = parse(args);
    const flag = name => flags[name]?.[0];
    const app = () => appName(flag('--app'));
    switch (`${words[0]} ${words[1]}`) {
      case 'apps create': {
        const name = appName(words[2]);
        if (flag('--network') !== undefined) throw new TypeError('A Fly network name does not apply to a Sprite fleet.');
        const value = state();
        if (value.apps[name]) throw new Error(`The Sprite fleet ${name} already exists in this fleet directory.`);
        // Sprites with this fleet's names that it did not create are never adopted.
        if ((await spritesNamed(name)).length) throw new Error(`Sprites named ${name}-m<index> already exist.`);
        value.apps[name] = { createdAt: new Date().toISOString(), volumes: {}, machines: {} }; saveState(value);
        return '';
      }
      case 'apps destroy': {
        const name = appName(words[2]), value = state(), own = value.apps[name];
        if (own) for (const id of Object.keys(own.machines ?? {})) {
          try { await call('DELETE', `/sprites/${id}`); } catch (error) { if (error.status !== 404) throw error; }
        }
        delete value.apps[name]; saveState(value);
        const secrets = load(secretsFile);
        if (secrets[name]) { delete secrets[name]; writePrivate(secretsFile, JSON.stringify(secrets)); }
        return '';
      }
      case 'secrets import': {
        const name = app(), secrets = load(secretsFile);
        secrets[name] = { ...secrets[name] };
        for (const line of String(options.input ?? '').split('\n').filter(Boolean)) {
          const cut = line.indexOf('=');
          secrets[name][checked(line.slice(0, Math.max(cut, 0)), /^[A-Z_][A-Z0-9_]*$/, 'secret name')] = line.slice(cut + 1);
        }
        writePrivate(secretsFile, JSON.stringify(secrets));
        return '';
      }
      case 'volumes create': {
        // A Sprite keeps its own disk, so a fleet volume is that disk: it is recorded here and named after the machine.
        const name = app(), volume = `${name}-${checked(words[2], /^[A-Za-z0-9_.-]{1,64}$/, 'volume name')}`, value = state(), own = appState(value, name);
        if (own.volumes[volume]) throw new Error(`Volume ${volume} already exists.`);
        own.volumes[volume] = { name: words[2] }; saveState(value);
        return JSON.stringify({ id: volume, name: words[2] });
      }
      case 'volumes list': return JSON.stringify(Object.keys(appState(state(), app()).volumes).map(id => ({ id })));
      case 'machine list': return JSON.stringify(await machines(app()));
      case 'machine start': {
        const name = app(); recorded(name, words[2]);
        await call('POST', `/sprites/${words[2]}/services/${SERVICE}/start?duration=0`, { timeoutMs: 120000 });
        return '';
      }
      case 'machine stop': {
        const name = app(); recorded(name, words[2]);
        await call('POST', `/sprites/${words[2]}/services/${SERVICE}/stop?timeout=${STOP_SECONDS}`, { timeoutMs: (STOP_SECONDS + 60) * 1000 });
        return '';
      }
      case 'machine update': {
        // A Sprite keeps its disk, so an update writes the new settings and files and starts the service again.
        const name = app(), id = words[2], own = recorded(name, id);
        const config = JSON.parse(readFileSync(flag('--machine-config'), 'utf8'));
        const files = (flags['--file-local'] ?? []).map(pair => ({ guest_path: pair.slice(0, pair.indexOf('=')), raw_value: readFileSync(pair.slice(pair.indexOf('=') + 1)).toString('base64') }));
        const running = (await serviceState(id)) === 'started';
        // Settings that are gone from the new config must not linger: the old settings files go first.
        await root(id, `rm -rf ${ROOT}/env`);
        await writeFiles(id, await machineFiles(name, id, { ...config, files }));
        await putService(id, config, { boardMachine: config.metadata?.['factory.machine'] === 'm0' });
        if (running) await call('POST', `/sprites/${id}/services/${SERVICE}/restart?duration=0`, { timeoutMs: 120000 });
        else await call('POST', `/sprites/${id}/services/${SERVICE}/stop?timeout=${STOP_SECONDS}`, { timeoutMs: (STOP_SECONDS + 60) * 1000 }).catch(() => {});
        const value = state(); appState(value, name).machines[id] = { ...own, config }; saveState(value);
        return '';
      }
      case 'machine exec': {
        const name = app(); recorded(name, words[2]);
        const seconds = Number(flag('--timeout')) || 30;
        return root(words[2], `cd /data 2>/dev/null || cd /; ${words[3]}`, { timeoutMs: seconds * 1000 + 5000 });
      }
      case 'ssh sftp': {
        if (words[2] !== 'get') break;
        const name = app(), id = flag('--machine'); recorded(name, id);
        if (existsSync(words[4])) throw new Error(`${words[4]} already exists.`);
        checked(words[3], /^\/[^\0]+$/, 'remote path');
        // The Sprite's file API reads as root and streams the file as it is.
        const response = await call('GET', `/sprites/${id}/fs/read?${new URLSearchParams({ path: words[3], workingDir: '/' })}`, { stream: true, timeoutMs: options.timeoutMs ?? 7200000 });
        try { await pipeline(Readable.fromWeb(response.body), createWriteStream(words[4], { flags: 'wx', mode: 0o600 })); }
        catch (error) { rmSync(words[4], { force: true }); throw error; }
        return '';
      }
    }
    throw new Error(`A Sprite fleet has no equivalent of: ${words.slice(0, 3).join(' ')}`);
  }

  return {
    run,
    /** Refuse early, before a fleet records anything, when the token does not reach the Sprites API. */
    async preflight() {
      let page;
      try { page = await json('GET', '/sprites?max_results=1'); }
      catch (error) { throw new Error(`The Sprites API refused this token or cannot be reached. (${error.message})`); }
      return { organization: page?.name, runningLimit: page?.running_limit, warmLimit: page?.warm_limit };
    },
    async createMachine({ app, name, config }) {
      app = appName(app); checked(name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/, 'machine name');
      const index = checked(/-(m\d+)$/.exec(name)?.[1] ?? '', /^m\d+$/, 'machine index');
      const id = `${app}-${index}`;
      checked(id, /^[a-z][a-z0-9-]{2,62}$/, 'Sprite name');
      const value = state(), own = appState(value, app);
      if (own.machines[id]) throw new Error(`Machine ${id} already exists.`);
      for (const mount of config.mounts ?? []) if (!own.volumes[mount.volume]) throw new Error(`Volume ${mount.volume} does not belong to ${app}.`);
      for (const [key, metadata] of Object.entries(config.metadata ?? {})) { checked(key, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'metadata name'); checked(metadata, /^[^\r\n]*$/, 'metadata value'); }
      if (await sprite(id)) throw new Error(`Sprite ${id} already exists.`);
      const boardMachine = config.metadata?.['factory.machine'] === 'm0';
      // Only the board's Sprite answers on a public address; the board checks every caller's own credential.
      await call('POST', '/sprites', { json: { name: id, url_settings: { auth: boardMachine ? 'public' : 'sprite' } }, timeoutMs: 180000 });
      const { files: _files, ...stored } = config;
      own.machines[id] = { name, config: stored, createdAt: new Date().toISOString() }; saveState(value);
      try {
        await writeFiles(id, await machineFiles(app, id, config));
        await putService(id, config, { boardMachine });
      } catch (error) {
        // This call created the Sprite, so this call may remove it again.
        await call('DELETE', `/sprites/${id}`).catch(() => {});
        const after = state(); delete appState(after, app).machines[id]; saveState(after);
        throw error;
      }
      return { id, name };
    },
    /** The board of the first machine, on its public Sprite address. Nothing runs on this computer. */
    async proxy({ app, machineId }) {
      recorded(appName(app), machineId);
      const found = await sprite(machineId);
      if (!found?.url?.startsWith('https://')) throw new Error('The coordinator Sprite has no public address for its board.');
      return { origin: found.url.replace(/\/+$/, ''), check() {}, async stop() {} };
    },
    unusedLoopbackPort: async () => 0,
    buildMachineConfig: () => ({}),
    resolveWorkerImage: async () => { throw new TypeError('A Sprite fleet has no image; Fly image sources do not apply.'); },
  };
}

/**
 * The lite fleet on Fly.io Sprites instead of Fly Machines: one Sprite per machine of the plan, the worker as a
 * Sprite service, and the same shared board on the first machine. Plans, worker programs, logins and every fleet
 * action are those of FactoryCloudLiteFleet. A Sprite has 8 CPUs, memory the platform manages and 100 GB of disk,
 * so `cpus`, `cpuKind`, `memoryMb`, `diskGb` and `region` have no effect.
 */
export class FactorySpriteLiteFleet extends FactoryCloudLiteFleet {
  constructor({ directory, token, tokenFile, api, fetch, auth, onEvent } = {}) {
    if (!isAbsolute(directory ?? '')) throw new TypeError('An absolute private fleet directory is required.');
    super({ directory, auth, onEvent, infrastructure: createSpritesInfrastructure({ directory, token, tokenFile, api, fetch }) });
  }
  async prepare(input) {
    const plan = validateCloudLitePlan(input);
    if (plan.network !== undefined) throw new TypeError('network is a Fly setting; Sprites have no private network.');
    await this.infrastructure.preflight();
    return super.prepare(input);
  }
  /**
   * Without `bundlePath`, this installed SDK is packed into the fleet directory once and kept, so a resumed fleet
   * uses the same bundle. Each Sprite sets itself up on its first start (a few minutes) and keeps that set-up on its disk.
   */
  async deploy(input, { image, imageSource, channel, bundlePath, prebuild, ...options } = {}) {
    if (image !== undefined || imageSource !== undefined || channel !== undefined || prebuild !== undefined) {
      throw new TypeError('A Sprite fleet takes no image: every Sprite starts as the same ready-made Ubuntu computer and sets itself up once.');
    }
    if (bundlePath === false) throw new TypeError('A Sprite fleet installs the SDK bundle on each Sprite; bundlePath cannot be false.');
    if (bundlePath === undefined) {
      bundlePath = join(this.directory, 'factory-sdk.tgz');
      if (!existsSync(bundlePath)) packFactorySdk(bundlePath);
    }
    return super.deploy(input, { ...options, image: SPRITE_IMAGE, bundlePath });
  }
}

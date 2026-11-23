import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { FactoryCloudLiteFleet } from './fleet.mjs';
import { validateCloudLitePlan } from './protocol.mjs';
import { packFactorySdk, tarHeader } from './bundle.mjs';

/** A stock image the bootstrap can prepare: Debian with apt-get and a Node this SDK supports. */
export const DOCKER_WORKER_IMAGE = 'node:24-bookworm-slim';

/** The provider commands a fleet sends. A fleet command missing here would fail on Docker, so a test compares the two. */
export const DOCKER_FLEET_COMMANDS = Object.freeze(['apps create', 'apps destroy', 'secrets import', 'volumes create', 'volumes list',
  'machine list', 'machine start', 'machine stop', 'machine update', 'machine exec', 'ssh sftp']);

const APP_LABEL = 'factory.docker.app', ID_LABEL = 'factory.docker.id', CONFIG_LABEL = 'factory.docker.config', VOLUME_LABEL = 'factory.docker.volume';
const SECRETS_FOLDER = 'run/factory/secrets';
const BOARD_PORT = 4200;
// Every machine starts through this: each secret file becomes an environment variable, then the real command runs.
// Secrets therefore never appear on a command line or in `docker inspect`.
const LOAD_SECRETS = `for f in /${SECRETS_FOLDER}/*; do [ -f "$f" ] && export "$(basename "$f")=$(cat "$f")"; done; exec "$@"`;
const STATES = { created: 'created', running: 'started', paused: 'suspended', restarting: 'starting', removing: 'destroying', exited: 'stopped', dead: 'failed' };
const VALUE_FLAGS = new Set(['--app', '--org', '--network', '--region', '--size', '--machine-config', '--file-local', '--timeout', '--machine']);
const OUTPUT_LIMIT = 64 * 1024 * 1024;
const STOP_SECONDS = 30;

const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);
const checked = (value, pattern, what) => { if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`Invalid ${what}.`); return value; };
const appName = value => checked(value, /^[a-z][a-z0-9-]{2,62}$/, 'app');

function runDocker(command, args, { env, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const what = `docker ${['network', 'volume'].includes(args[0]) ? args.slice(0, 2).join(' ') : args[0]}`;
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let bytes = 0, overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) { overflow = true; child.kill(); } else stdout.push(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 64) stderr.push(chunk); });
    child.stdin.on('error', () => {});
    child.once('error', error => {
      clearTimeout(timer);
      reject(new Error(error.code === 'ENOENT' ? `Docker was not found (${command}). Install Docker and put it on the PATH.` : `Docker could not be started: ${error.message}`));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${what} did not finish within ${timeoutMs} ms.`));
      if (overflow) return reject(new Error(`${what} printed more than expected.`));
      if (code !== 0) return reject(new Error(`${what} failed: ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 2000) || `exit ${code}`}`));
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

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

/** A tar stream for `docker cp`: files and folders owned by root, with the given modes. */
function archive(entries) {
  const parts = [];
  for (const entry of entries) {
    if (entry.folder) { parts.push(tarHeader(entry.path, 0, entry.mode, '5')); continue; }
    parts.push(tarHeader(entry.path, entry.bytes.length, entry.mode), entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function writePrivate(file, text) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.next`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
}

/**
 * Local Docker in place of Fly, for the same fleet. It answers the provider commands a fleet sends:
 * an app is a private network, a Fly volume is a Docker volume, a Machine is a container. Everything
 * it creates carries the app's label, and only labelled resources are listed, changed or removed.
 */
export function createDockerInfrastructure({ directory, command = 'docker', env = process.env, execute } = {}) {
  if (!isAbsolute(directory ?? '')) throw new TypeError('An absolute private fleet directory is required.');
  const secretsFile = join(directory, 'docker-secrets.json');
  const docker = (args, options = {}) => execute ? execute(command, args, { env, ...options }) : runDocker(command, args, { env, ...options });
  const stagedSecrets = () => existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : {};

  const volumeNames = async app => lines(await docker(['volume', 'ls', '--filter', `label=${APP_LABEL}=${app}`, '--format', '{{.Name}}']));
  const ownsNetwork = async app => lines(await docker(['network', 'ls', '--filter', `label=${APP_LABEL}=${app}`, '--format', '{{.Name}}'])).includes(app);
  async function containers(app) {
    const ids = lines(await docker(['ps', '--all', '--no-trunc', '--filter', `label=${APP_LABEL}=${app}`, '--format', '{{.ID}}']));
    return ids.length ? JSON.parse(await docker(['inspect', '--type', 'container', ...ids])) : [];
  }
  function machineView(value) {
    const labels = value.Config?.Labels ?? {};
    const config = JSON.parse(Buffer.from(labels[CONFIG_LABEL] ?? '', 'base64').toString('utf8') || '{}');
    // What the container really has, not what it was asked to have: its own labels and its own mounts.
    const mounts = value.Mounts?.length ? value.Mounts.filter(mount => mount.Type === 'volume').map(mount => ({ volume: mount.Name, path: mount.Destination }))
      : (value.HostConfig?.Mounts ?? []).filter(mount => mount.Type === 'volume').map(mount => ({ volume: mount.Source, path: mount.Target }));
    return { id: labels[ID_LABEL], name: value.Name.replace(/^\//, ''), state: STATES[value.State?.Status] ?? 'unknown', region: 'local', container: value.Id,
      config: { ...config, image: value.Config?.Image, mounts, metadata: Object.fromEntries(Object.keys(config.metadata ?? {}).map(key => [key, labels[key]])) } };
  }
  // A container set aside during a runtime update is not a machine of the fleet.
  const machines = async app => (await containers(app)).filter(value => value.Config?.Labels?.[ID_LABEL] && !value.Name.includes('.replaced-')).map(machineView);
  async function machine(app, id) {
    const found = (await machines(app)).filter(value => value.id === id);
    if (found.length !== 1) throw new Error(`Machine ${id} was not found in ${app}.`);
    return found[0];
  }
  const boardPort = config => Number(config?.env?.FACTORY_BOARD_PORT ?? BOARD_PORT);

  async function createContainer({ app, name, id, config, files = [] }) {
    checked(name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/, 'machine name');
    checked(config?.image, /^[A-Za-z0-9][A-Za-z0-9_.\-/:@]*$/, 'image');
    const start = config.init?.exec ?? [...(config.init?.entrypoint ?? []), ...(config.init?.cmd ?? [])];
    if (!start.length || start.some(word => typeof word !== 'string')) throw new TypeError('A Docker machine needs its start command.');
    const owned = new Set(await volumeNames(app));
    for (const mount of config.mounts ?? []) {
      checked(mount.path, /^\/[A-Za-z0-9_./-]*$/, 'mount path');
      if (!owned.has(mount.volume)) throw new Error(`Volume ${mount.volume} does not belong to ${app}.`);
    }
    for (const [key, value] of Object.entries(config.env ?? {})) { checked(key, /^[A-Za-z_][A-Za-z0-9_]*$/, 'environment name'); if (typeof value !== 'string') throw new TypeError('Environment values must be text.'); }
    for (const [key, value] of Object.entries(config.metadata ?? {})) { checked(key, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'metadata name'); checked(value, /^[^\r\n]*$/, 'metadata value'); }
    const { files: _files, ...stored } = config;
    const secrets = stagedSecrets()[app] ?? {};
    await docker(['create', '--name', name, '--network', app, '--network-alias', `${id}.vm.${app}.internal`,
      '--label', `${APP_LABEL}=${app}`, '--label', `${ID_LABEL}=${id}`, '--label', `${CONFIG_LABEL}=${Buffer.from(JSON.stringify(stored)).toString('base64')}`,
      ...Object.entries(config.metadata ?? {}).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      ...(config.mounts ?? []).flatMap(mount => ['--mount', `type=volume,source=${mount.volume},target=${mount.path}`]),
      ...(config.guest?.cpus ? ['--cpus', String(config.guest.cpus)] : []),
      ...(config.guest?.memory_mb ? ['--memory', `${config.guest.memory_mb}m`] : []),
      // Workers reach a model server on this computer as host.docker.internal.
      '--restart', 'no', '--init', '--add-host', 'host.docker.internal:host-gateway',
      ...Object.entries(config.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      // The host reaches the board on a loopback-only port that Docker picks; nothing is open to the network.
      ...(config.metadata?.['factory.machine'] === 'm0' ? ['--publish', `127.0.0.1::${boardPort(config)}`] : []),
      '--entrypoint', '/bin/sh', config.image, '-c', LOAD_SECRETS, 'factory-init', ...start], { timeoutMs: 1800000 });
    try {
      await docker(['cp', '-', `${name}:/`], { timeoutMs: 600000, input: archive([
        { path: 'run/factory/', mode: 0o700, folder: true }, { path: `${SECRETS_FOLDER}/`, mode: 0o700, folder: true },
        ...Object.entries(secrets).map(([key, value]) => ({ path: `${SECRETS_FOLDER}/${key}`, mode: 0o600, bytes: Buffer.from(value, 'utf8') })),
        ...files]) });
      await docker(['start', name]);
    } catch (error) {
      // This call created the container, so this call may remove it again.
      await docker(['rm', '--force', '--volumes', name]).catch(() => {});
      throw error;
    }
  }

  async function run(args, options = {}) {
    const { words, flags } = parse(args);
    const flag = name => flags[name]?.[0];
    const app = () => appName(flag('--app'));
    switch (`${words[0]} ${words[1]}`) {
      case 'apps create': {
        const name = appName(words[2]);
        if (flag('--network') !== undefined) throw new TypeError('A Fly network name does not apply to a Docker fleet.');
        await docker(['network', 'create', '--label', `${APP_LABEL}=${name}`, name]);
        return '';
      }
      case 'apps destroy': {
        const name = appName(words[2]);
        for (const value of await containers(name)) await docker(['rm', '--force', '--volumes', value.Id]);
        for (const volume of await volumeNames(name)) await docker(['volume', 'rm', volume]);
        if (await ownsNetwork(name)) await docker(['network', 'rm', name]);
        const secrets = stagedSecrets();
        if (secrets[name]) { delete secrets[name]; writePrivate(secretsFile, JSON.stringify(secrets)); }
        return '';
      }
      case 'secrets import': {
        const name = app(), secrets = stagedSecrets();
        secrets[name] = { ...secrets[name] };
        for (const line of String(options.input ?? '').split('\n').filter(Boolean)) {
          const cut = line.indexOf('=');
          secrets[name][checked(line.slice(0, Math.max(cut, 0)), /^[A-Z_][A-Z0-9_]*$/, 'secret name')] = line.slice(cut + 1);
        }
        writePrivate(secretsFile, JSON.stringify(secrets));
        return '';
      }
      case 'volumes create': {
        const name = app(), volume = `${name}-${checked(words[2], /^[A-Za-z0-9_.-]{1,64}$/, 'volume name')}`;
        // `docker volume create` quietly returns a volume that already exists; a fleet must never adopt one.
        if (lines(await docker(['volume', 'ls', '--filter', `name=${volume}`, '--format', '{{.Name}}'])).includes(volume)) throw new Error(`Volume ${volume} already exists.`);
        await docker(['volume', 'create', '--label', `${APP_LABEL}=${name}`, '--label', `${VOLUME_LABEL}=${words[2]}`, volume]);
        return JSON.stringify({ id: volume, name: words[2] });
      }
      case 'volumes list': return JSON.stringify((await volumeNames(app())).map(id => ({ id })));
      case 'machine list': return JSON.stringify(await machines(app()));
      case 'machine start': await docker(['start', (await machine(app(), words[2])).container]); return '';
      case 'machine stop': await docker(['stop', '-t', String(STOP_SECONDS), (await machine(app(), words[2])).container], { timeoutMs: (STOP_SECONDS + 60) * 1000 }); return '';
      case 'machine update': {
        // A container's settings are fixed, so an update is a new container with the same name, identity
        // and volume. The old one is set aside first and only removed once the new one is running.
        const name = app(), target = await machine(name, words[2]);
        const config = JSON.parse(readFileSync(flag('--machine-config'), 'utf8'));
        const files = (flags['--file-local'] ?? []).map(pair => ({ path: pair.slice(0, pair.indexOf('=')).replace(/^\/+/, ''), mode: 0o644, bytes: readFileSync(pair.slice(pair.indexOf('=') + 1)) }));
        const running = target.state === 'started';
        if (running) await docker(['stop', '-t', String(STOP_SECONDS), target.container], { timeoutMs: (STOP_SECONDS + 60) * 1000 });
        await docker(['rename', target.container, `${target.name}.replaced-${randomBytes(4).toString('hex')}`]);
        try { await createContainer({ app: name, name: target.name, id: target.id, config, files }); }
        catch (error) {
          await docker(['rename', target.container, target.name]).catch(() => {});
          if (running) await docker(['start', target.container]).catch(() => {});
          throw error;
        }
        await docker(['rm', '--force', '--volumes', target.container]);
        return '';
      }
      case 'machine exec': {
        const seconds = Number(flag('--timeout')) || 30;
        return docker(['exec', (await machine(app(), words[2])).container, '/bin/sh', '-c', words[3]], { timeoutMs: seconds * 1000 + 5000 });
      }
      case 'ssh sftp': {
        if (words[2] !== 'get') break;
        if (existsSync(words[4])) throw new Error(`${words[4]} already exists.`);
        await docker(['cp', `${(await machine(app(), flag('--machine'))).container}:${words[3]}`, words[4]], { timeoutMs: options.timeoutMs ?? 7200000 });
        return '';
      }
    }
    throw new Error(`A Docker fleet has no equivalent of: ${words.slice(0, 3).join(' ')}`);
  }

  return {
    run,
    /** Refuse early, before a fleet records anything, when Docker cannot run the plan. */
    async preflight({ cpus } = {}) {
      let info;
      try { info = JSON.parse(await docker(['info', '--format', '{{json .}}'], { timeoutMs: 30000 })); }
      catch (error) { throw new Error(`Docker is not running or cannot be reached; start Docker and try again. (${error.message})`); }
      if (info.ServerErrors?.length) throw new Error(`Docker is not running or cannot be reached; start Docker and try again. (${info.ServerErrors[0]})`);
      if (info.OSType !== 'linux') throw new Error('Workers need Linux containers; switch Docker to Linux containers.');
      if (Number.isFinite(cpus) && Number.isFinite(info.NCPU) && cpus > info.NCPU) throw new Error(`The plan gives each machine ${cpus} CPUs, but this Docker has ${info.NCPU}. Lower cpus in the plan.`);
      return { version: info.ServerVersion, cpus: info.NCPU, memoryBytes: info.MemTotal };
    },
    async createMachine({ app, name, config }) {
      const id = randomBytes(7).toString('hex');
      await createContainer({ app: appName(app), name, id, config,
        files: (config.files ?? []).map(file => ({ path: checked(file.guest_path, /^\/[^\0]+$/, 'file path').replace(/^\/+/, ''), mode: 0o644, bytes: Buffer.from(file.raw_value, 'base64') })) });
      return { id, name };
    },
    /** The board of the first machine, on the loopback port Docker picked for it. */
    async proxy({ app, machineId }) {
      const target = await machine(appName(app), machineId);
      const port = lines(await docker(['port', target.container, `${boardPort(target.config)}/tcp`])).map(line => /^127\.0\.0\.1:(\d+)$/.exec(line)?.[1]).find(Boolean);
      if (!port) throw new Error('The coordinator container has no loopback port for its board.');
      return { origin: `http://127.0.0.1:${port}`, check() {}, async stop() {} };
    },
    unusedLoopbackPort: async () => 0,
    // Everything a container needs comes from the fleet's own machine settings.
    buildMachineConfig: () => ({}),
    resolveWorkerImage: async () => { throw new TypeError('A Docker fleet takes an image name; Fly image sources do not apply.'); },
  };
}

/**
 * The lite fleet on local Docker instead of Fly: one container per machine of the plan, one Docker
 * volume each for /data, one private network, and the same shared board on the first machine.
 * Plans, worker programs, logins and every fleet action are those of FactoryCloudLiteFleet.
 * `region`, `cpuKind` and `diskGb` have no effect here; `cpus` and `memoryMb` limit each container.
 */
export class FactoryDockerLiteFleet extends FactoryCloudLiteFleet {
  constructor({ directory, dockerCommand = 'docker', dockerEnv = process.env, dockerExecute, auth, onEvent } = {}) {
    if (!isAbsolute(directory ?? '')) throw new TypeError('An absolute private fleet directory is required.');
    super({ directory, auth, onEvent, infrastructure: createDockerInfrastructure({ directory, command: dockerCommand, env: dockerEnv, execute: dockerExecute }) });
  }
  async prepare(input) {
    const plan = validateCloudLitePlan(input);
    if (plan.network !== undefined) throw new TypeError('network is a Fly setting; a Docker fleet always gets its own private network.');
    await this.infrastructure.preflight({ cpus: plan.cpus });
    return super.prepare(input);
  }
  /**
   * Without `image`, workers start from the stock Node image. Without `bundlePath`, this installed SDK
   * is packed into the fleet directory once and kept, so a resumed fleet uses the same bundle. Pass
   * `bundlePath: false` for an image that already has the runtime in /opt/factory.
   */
  async deploy(input, { image = DOCKER_WORKER_IMAGE, imageSource, channel, bundlePath, ...options } = {}) {
    if (imageSource !== undefined || channel !== undefined) throw new TypeError('A Docker fleet takes an image name; Fly image sources do not apply.');
    if (bundlePath === undefined) {
      bundlePath = join(this.directory, 'factory-sdk.tgz');
      if (!existsSync(bundlePath)) packFactorySdk(bundlePath);
    }
    return super.deploy(input, { ...options, image, bundlePath: bundlePath === false ? undefined : bundlePath });
  }
}

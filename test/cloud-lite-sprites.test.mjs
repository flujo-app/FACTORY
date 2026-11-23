import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FactorySpriteLiteFleet, createSpritesInfrastructure, readExecOutput, servicePath, SPRITE_IMAGE, SPRITE_START_SCRIPT, SPRITES_FLEET_COMMANDS } from '../src/cloud-lite/sprites.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';
import { hash, secret } from '../src/cloud-lite/protocol.mjs';
import { tempDir } from './support/temp-dir.mjs';

const fresh = () => tempDir('factory-sprites-lite-');
const API = 'https://sprites.test/v1';
const APP = 'factory-sprite-test';
const plan = (overrides = {}) => ({ runId: 'sprite-test', app: APP, goal: 'Work on the shared board', machines: 2, agentsPerMachine: 2, ...overrides });
// The PATH of the Sprite user, as measured on a real Sprite.
const SPRITE_PATH = '/home/sprite/.local/bin:/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const framed = text => Buffer.concat([Buffer.from([1]), Buffer.from(text), Buffer.from([3, 0])]);
const unquote = text => text.slice(1, -1).replaceAll(`'\\''`, `'`);

/** A Sprites API that keeps its Sprites, services and files in memory and answers the calls the fleet makes. */
function fakeSprites({ token = `sprites-${secret()}` } = {}) {
  const state = { sprites: new Map(), calls: [], exec: () => '', archive: Buffer.alloc(0), failNextService: null };
  const reply = (status, body) => new Response(body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), { status });
  const view = value => ({ id: `sprite-${value.name}`, name: value.name, organization: 'test-org', url: value.url, status: value.status, url_settings: value.url_settings,
    created_at: '2026-11-23T00:00:00Z', updated_at: '2026-11-23T00:00:00Z' });
  async function fetch(url, init = {}) {
    const address = new URL(url), path = address.pathname.replace(/^\/v1/, ''), method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body);
    state.calls.push({ method, url, path, query: address.search, body });
    if (init.headers?.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'sprites') return reply(404, { error: 'not found' });
    if (parts.length === 1 && method === 'GET') {
      const prefix = address.searchParams.get('prefix') ?? '';
      return reply(200, { sprites: [...state.sprites.values()].filter(value => value.name.startsWith(prefix)).map(view), has_more: false, name: 'test-org', running_limit: 10, warm_limit: 10 });
    }
    if (parts.length === 1 && method === 'POST') {
      const request = JSON.parse(body.toString());
      if (state.sprites.has(request.name)) return reply(400, { error: 'name taken' });
      state.sprites.set(request.name, { name: request.name, url: `https://${request.name}-ab12c.sprites.app`, status: 'running', url_settings: { auth: 'sprite', ...request.url_settings },
        services: new Map(), files: new Map() });
      return reply(201, view(state.sprites.get(request.name)));
    }
    const target = state.sprites.get(parts[1]);
    if (!target) return reply(404, { error: 'sprite not found' });
    if (parts.length === 2 && method === 'GET') return reply(200, { data: view(target), ...view(target) });
    if (parts.length === 2 && method === 'DELETE') { state.sprites.delete(parts[1]); return reply(204); }
    if (parts[2] === 'services') {
      const name = parts[3], service = target.services.get(name);
      if (parts.length === 4 && method === 'PUT') {
        if (state.failNextService) { const message = state.failNextService; state.failNextService = null; return reply(500, { error: message }); }
        target.services.set(name, { ...JSON.parse(body.toString()), state: { name, status: 'running' } }); return reply(200, target.services.get(name));
      }
      if (!service) return reply(404, { error: 'service not found' });
      if (parts.length === 4 && method === 'GET') return reply(200, service);
      const action = parts[4];
      service.state.status = { start: 'running', restart: 'running', stop: 'stopped' }[action] ?? fail(`unknown service action ${action}`);
      return reply(200, `{"type":"complete","timestamp":1}\n`);
    }
    if (parts[2] === 'fs' && parts[3] === 'write') { target.files.set(address.searchParams.get('path'), { mode: parseInt(address.searchParams.get('mode'), 8), bytes: body }); return reply(200, { path: address.searchParams.get('path') }); }
    if (parts[2] === 'fs' && parts[3] === 'read') return reply(200, state.archive);
    if (parts[2] === 'exec' && method === 'POST') {
      const words = address.searchParams.getAll('cmd');
      assert.deepEqual(words.slice(0, 2), ['/bin/sh', '-c']);
      const outer = words[2], marker = `exec sudo -n env "PATH=$PATH" /bin/sh -c `;
      // A long script arrives as the command's input instead of in the address.
      const fromInput = outer === `exec sudo -n env "PATH=$PATH" /bin/sh -s`;
      if (fromInput) { assert.equal(address.searchParams.get('stdin'), 'true'); state.scriptsFromInput = (state.scriptsFromInput ?? 0) + 1; }
      else assert.equal(outer.startsWith(marker), true, outer);
      const script = fromInput ? body.toString() : unquote(outer.slice(marker.length));
      if (script === 'printf %s "$PATH"') return reply(200, framed(SPRITE_PATH));
      if (script.startsWith('umask 077 && node -e ')) {
        assert.equal(address.searchParams.get('stdin'), 'true');
        for (const file of JSON.parse(body.toString())) target.files.set(file.path, { mode: file.mode, bytes: Buffer.from(file.data, 'base64') });
        return reply(200, framed(''));
      }
      if (script.startsWith('install -D ')) {
        for (const move of script.split(' && rm -f ').map(part => /install -D -o root -g root -m (\d+) '([^']+)' '([^']+)'/.exec(part)).filter(Boolean)) {
          target.files.set(move[3], { mode: parseInt(move[1], 8), bytes: target.files.get(move[2]).bytes }); target.files.delete(move[2]);
        }
        return reply(200, framed(''));
      }
      if (script === 'rm -rf /etc/factory/env') { for (const key of [...target.files.keys()]) if (key.startsWith('/etc/factory/env/')) target.files.delete(key); return reply(200, framed('')); }
      const prefix = 'cd /data 2>/dev/null || cd /; ';
      if (script.startsWith(prefix)) return reply(200, framed(state.exec(target, script.slice(prefix.length))));
      return reply(400, { error: `The fake Sprites API does not know: ${script.slice(0, 80)}` });
    }
    return reply(404, { error: `unknown route ${method} ${path}` });
  }
  const fail = message => { throw new Error(message); };
  return { state, fetch, token };
}

const auth = () => { const accessToken = secret(); return { read: () => ({ accessToken, chatgptAccountId: 'account' }), refresh: async () => ({ accessToken, chatgptAccountId: 'account' }) }; };
function bundle(directory, name = 'bundle.tgz', content = 'sdk-bytes') { const file = join(directory, name); writeFileSync(file, content); return file; }
async function deployed(overrides = {}) {
  const directory = fresh(), sprites = fakeSprites(), broker = auth();
  const fleet = new FactorySpriteLiteFleet({ directory, token: sprites.token, api: API, fetch: sprites.fetch, auth: broker });
  const result = await fleet.deploy(plan(overrides), { bundlePath: bundle(directory) });
  return { directory, sprites, fleet, result, broker };
}
const text = (sprite, path) => sprite.files.get(path)?.bytes.toString('utf8');

test('a Sprite fleet becomes one Sprite per machine, with the worker as a Sprite service', async () => {
  const { sprites, result, directory } = await deployed();
  assert.equal(result.status, 'provisioned'); assert.equal(result.image, SPRITE_IMAGE);
  assert.deepEqual([...sprites.state.sprites.keys()], [`${APP}-m0`, `${APP}-m1`]);
  const [first, second] = sprites.state.sprites.values();
  for (const [index, sprite] of [first, second].entries()) {
    const service = sprite.services.get('factory');
    // sudo runs the start script as root; it loads the settings and keeps the Sprite awake, then runs the same bootstrap as on Fly.
    assert.equal(service.cmd, '/usr/bin/sudo');
    assert.deepEqual(service.args, ['-n', '/bin/bash', '/etc/factory/start.sh', '/bin/bash', '/opt/factory-bootstrap.sh']);
    assert.deepEqual(service.needs, []);
    assert.equal(text(sprite, '/etc/factory/start.sh'), SPRITE_START_SCRIPT); assert.equal(sprite.files.get('/etc/factory/start.sh').mode, 0o700);
    assert.equal(text(sprite, '/etc/factory/env/FACTORY_MACHINE_INDEX'), String(index));
    // The pinned worker program in /usr/local/bin comes first; the Sprite's own Claude Code in ~/.local/bin is left out.
    assert.equal(text(sprite, '/etc/factory/env/PATH'), '/usr/local/sbin:/usr/local/bin:/.sprite/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    assert.deepEqual(result.machines[index], { id: `${APP}-m${index}`, name: `factory-sprite-test-m${index}`, volumeId: `${APP}-factory_m${index}`,
      config: { cpuKind: 'shared', cpus: 2, memoryMb: 4096, diskGb: 20 } });
  }
  // Only the board's Sprite is public, and only it routes its address to the board's port.
  assert.equal(first.url_settings.auth, 'public'); assert.equal(second.url_settings.auth, 'sprite');
  assert.equal(first.services.get('factory').http_port, 4200); assert.equal(second.services.get('factory').http_port, null);
  // Sprites have no private network: the second machine reaches the board on the first one's public address.
  assert.equal(text(second, '/etc/factory/env/FACTORY_BOARD_MACHINE_ID'), result.machines[0].id);
  assert.equal(text(second, '/etc/factory/env/FACTORY_BOARD_ORIGIN'), first.url);
  assert.equal(first.files.has('/etc/factory/env/FACTORY_BOARD_ORIGIN'), false);
  assert.equal(JSON.parse(readFileSync(join(directory, 'fleet.json'), 'utf8')).operations['m1.machine-create'].state, 'succeeded');
});

test('logins, board credentials and the Sprites token never travel in an address or land in the journals', async () => {
  const { sprites, directory, broker } = await deployed();
  const { credentials, operatorToken } = JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf8'));
  const staged = JSON.parse(readFileSync(join(directory, 'sprites-secrets.json'), 'utf8'))[APP].FACTORY_CLOUD_BOOTSTRAP_B64;
  const secrets = [broker.read().accessToken, operatorToken, staged, ...Object.values(credentials)];
  const addresses = JSON.stringify(sprites.state.calls.map(call => call.url));
  assert.equal(secrets.some(value => addresses.includes(value)), false);
  for (const file of ['fleet.json', 'sprites-state.json']) assert.equal(readFileSync(join(directory, file), 'utf8').includes(sprites.token), false);
  assert.equal(addresses.includes(sprites.token), false);
  for (const sprite of sprites.state.sprites.values()) {
    const file = sprite.files.get('/etc/factory/secrets/FACTORY_CLOUD_BOOTSTRAP_B64');
    assert.equal(file.mode, 0o600);
    const config = JSON.parse(Buffer.from(file.bytes.toString('utf8'), 'base64').toString('utf8'));
    assert.equal(config.plan.runId, 'sprite-test'); assert.equal(config.operatorToken, operatorToken); assert.equal(config.initialAuth.accessToken, broker.read().accessToken);
    assert.equal(text(sprite, '/tmp/factory-sdk.tgz'), 'sdk-bytes');
    assert.match(text(sprite, '/opt/factory-bootstrap.sh'), new RegExp(hash('sdk-bytes')));
    // The settings files hold no secret.
    for (const [path, value] of sprite.files) if (path.startsWith('/etc/factory/env/')) assert.equal(secrets.some(secretValue => value.bytes.toString().includes(secretValue)), false);
  }
});

test('a large file goes through the Sprite file API to a staging folder and is moved into place as root', async () => {
  const sprites = fakeSprites(), directory = fresh();
  const infrastructure = createSpritesInfrastructure({ directory, token: sprites.token, api: API, fetch: sprites.fetch });
  await infrastructure.run(['apps', 'create', APP, '--org', 'personal']);
  await infrastructure.run(['volumes', 'create', 'factory_m0', '--app', APP, '--json']);
  const large = Buffer.alloc(5 * 1024 * 1024, 7);
  await infrastructure.createMachine({ app: APP, name: 'factory-x-m0', config: { image: SPRITE_IMAGE, init: { exec: ['/bin/bash', '/opt/factory-bootstrap.sh'] },
    env: {}, metadata: { 'factory.machine': 'm0' }, mounts: [{ volume: `${APP}-factory_m0`, path: '/data' }], files: [{ guest_path: '/tmp/factory-sdk.tgz', raw_value: large.toString('base64') }] } });
  const sprite = sprites.state.sprites.get(`${APP}-m0`);
  assert.deepEqual(sprite.files.get('/tmp/factory-sdk.tgz'), { mode: 0o644, bytes: large });
  assert.equal([...sprite.files.keys()].some(path => path.startsWith('/home/sprite/.factory-staging/')), false);
  const write = sprites.state.calls.find(call => call.path.endsWith('/fs/write'));
  assert.equal(new URL(write.url).searchParams.get('mode'), '0600');
});

test('the host reaches the board on the first Sprite\'s public address', async () => {
  const { sprites, fleet, directory } = await deployed();
  const { credentials, operatorToken } = JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf8'));
  const coordinator = await startCloudLiteCoordinator({ database: join(directory, 'board.sqlite'), plan: fleet.state.plan, credentials, operatorToken,
    auth: { accessToken: secret(), chatgptAccountId: 'account' }, githubToken: secret(), host: '127.0.0.1', port: 0 });
  const realFetch = globalThis.fetch, board = [...sprites.state.sprites.values()][0].url;
  // The board's public Sprite address leads to the local coordinator for this test.
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith(board) ? `http://127.0.0.1:${coordinator.server.address().port}${String(url).slice(board.length)}` : url, init);
  try {
    const status = await fleet.observe();
    assert.deepEqual(status.agents.map(agent => agent.id), ['m0-a0', 'm0-a1', 'm1-a0', 'm1-a1']);
    assert.equal(fleet.connection.origin, board);
    assert.deepEqual(await fleet.command('m1-a1', { id: 'first-message', message: 'Start' }), { recorded: true });
    await fleet.disconnect();
    // A stopped coordinator service is refused instead of woken by a guess.
    [...sprites.state.sprites.values()][0].services.get('factory').state.status = 'stopped';
    await assert.rejects(fleet.observe(), /coordinator Machine is not started/);
  } finally { globalThis.fetch = realFetch; await fleet.disconnect(); await coordinator.close(); }
});

test('stop and start act on the same Sprites through their service', async () => {
  const { sprites, fleet } = await deployed();
  const status = () => [...sprites.state.sprites.values()].map(sprite => sprite.services.get('factory').state.status);
  await fleet.stop();
  assert.deepEqual(status(), ['stopped', 'stopped']);
  // A real Sprite recorded a worker that ended on the stop signal as failed (exit 143): that still counts as stopped.
  for (const sprite of sprites.state.sprites.values()) Object.assign(sprite.services.get('factory').state, { status: 'failed', error: 'exited with code 143' });
  await fleet.start({ attempt: 'after-stop' });
  assert.deepEqual(status(), ['running', 'running']);
  assert.deepEqual([...sprites.state.sprites.keys()], [`${APP}-m0`, `${APP}-m1`]);
  await fleet.stop();
  assert.deepEqual(status(), ['stopped', 'stopped']);
  assert.equal(fleet.state.status, 'stopped');
});

test('a runtime update writes the new bundle and settings on the same Sprites and restarts their service', async () => {
  const { sprites, fleet, directory, result } = await deployed();
  const next = bundle(directory, 'next.tgz', 'newer-sdk-bytes');
  assert.deepEqual(await fleet.updateRuntime({ bundlePath: next }), { updated: 2, digest: hash('newer-sdk-bytes') });
  assert.deepEqual([...sprites.state.sprites.keys()], [`${APP}-m0`, `${APP}-m1`]);
  for (const sprite of sprites.state.sprites.values()) {
    assert.equal(text(sprite, '/tmp/factory-sdk.tgz'), 'newer-sdk-bytes');
    assert.match(text(sprite, '/opt/factory-bootstrap.sh'), new RegExp(hash('newer-sdk-bytes')));
    assert.equal(sprite.files.get('/etc/factory/secrets/FACTORY_CLOUD_BOOTSTRAP_B64').mode, 0o600);
    assert.equal(sprite.services.get('factory').state.status, 'running');
  }
  const second = sprites.state.sprites.get(`${APP}-m1`);
  assert.equal(text(second, '/etc/factory/env/FACTORY_BOARD_MACHINE_ID'), result.machines[0].id);
  assert.equal(text(second, '/etc/factory/env/FACTORY_BOARD_ORIGIN'), sprites.state.sprites.get(`${APP}-m0`).url);
  assert.equal(sprites.state.calls.filter(call => call.path.endsWith('/services/factory/restart')).length, 2);
});

test('collection runs its job on the Sprite as root and streams the archive out', async () => {
  const { sprites, fleet } = await deployed({ machines: 1 });
  const archive = Buffer.from('collected-evidence'); sprites.state.archive = archive;
  sprites.state.exec = (_sprite, command) => {
    assert.match(command, /^node -e "eval\(Buffer\.from\('/);
    return JSON.stringify({ state: 'completed', archive: '/data/evidence.tgz', bytes: archive.length, sha256: hash(archive) });
  };
  fleet.quiesce = async () => ({ agents: 2 });
  const collected = await fleet.collect({ concurrency: 1 });
  assert.equal(collected.complete, true);
  // The collection commands are long: they reached the Sprite as input, and no address carried them.
  assert.equal(sprites.state.scriptsFromInput > 0, true);
  assert.equal(sprites.state.calls.every(call => call.url.length < 4096), true);
  const read = sprites.state.calls.find(call => call.path.endsWith('/fs/read'));
  assert.equal(new URL(read.url).searchParams.get('path'), '/data/evidence.tgz');
  assert.deepEqual(readFileSync(fleet.state.artifacts[0].file), archive);
});

test('retire deletes the Sprites the fleet created and nothing else', async () => {
  const { sprites, fleet, directory } = await deployed();
  sprites.state.sprites.set('someone-else', { name: 'someone-else', url: 'https://someone-else.sprites.app', status: 'warm', url_settings: { auth: 'sprite' }, services: new Map(), files: new Map() });
  // A Sprite named like the fleet's but not created by it blocks retirement; nothing is removed.
  sprites.state.sprites.set(`${APP}-m7`, { name: `${APP}-m7`, url: 'https://intruder.sprites.app', status: 'warm', url_settings: { auth: 'sprite' }, services: new Map(), files: new Map() });
  await assert.rejects(fleet.retire(), /exact original Machine and volume inventory|Provider ownership changed/);
  assert.equal(sprites.state.sprites.size, 4);
  sprites.state.sprites.delete(`${APP}-m7`);
  await fleet.retire();
  assert.deepEqual([...sprites.state.sprites.keys()], ['someone-else']);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'sprites-secrets.json'), 'utf8')), {});
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'sprites-state.json'), 'utf8')).apps, {});
  assert.equal(fleet.state.status, 'retired');
});

test('Sprites named like the fleet are never adopted, and a failed set-up removes the Sprite it made', async () => {
  const taken = fakeSprites();
  taken.state.sprites.set(`${APP}-m0`, { name: `${APP}-m0`, url: 'https://taken.sprites.app', status: 'cold', url_settings: { auth: 'sprite' }, services: new Map(), files: new Map() });
  const directory = fresh();
  await assert.rejects(new FactorySpriteLiteFleet({ directory, token: taken.token, api: API, fetch: taken.fetch, auth: auth() }).deploy(plan(), { bundlePath: bundle(directory) }), /already exist/);
  assert.equal(taken.state.sprites.size, 1);
  const failing = fakeSprites(); failing.state.failNextService = 'service manager unavailable';
  const second = fresh();
  await assert.rejects(new FactorySpriteLiteFleet({ directory: second, token: failing.token, api: API, fetch: failing.fetch, auth: auth() }).deploy(plan(), { bundlePath: bundle(second) }), /service manager unavailable/);
  assert.equal(failing.state.sprites.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(second, 'sprites-state.json'), 'utf8')).apps[APP].machines, {});
});

test('a Sprite fleet refuses images, image builds, Fly networks and a missing or refused token', async () => {
  const sprites = fakeSprites(), directory = fresh();
  const fleet = new FactorySpriteLiteFleet({ directory, token: sprites.token, api: API, fetch: sprites.fetch, auth: auth() });
  await assert.rejects(fleet.deploy(plan(), { image: 'node:24', bundlePath: bundle(directory) }), /takes no image/);
  await assert.rejects(fleet.deploy(plan(), { prebuild: true, bundlePath: bundle(directory) }), /takes no image/);
  await assert.rejects(fleet.deploy(plan(), { bundlePath: false }), /bundlePath cannot be false/);
  await assert.rejects(fleet.deploy(plan({ network: 'private-net' }), { bundlePath: bundle(directory) }), /no private network/);
  const saved = process.env.SPRITES_TOKEN; delete process.env.SPRITES_TOKEN;
  try { assert.throws(() => new FactorySpriteLiteFleet({ directory: fresh(), api: API, fetch: sprites.fetch }), /Sprites token is required/); }
  finally { if (saved !== undefined) process.env.SPRITES_TOKEN = saved; }
  // A refused token stops the fleet before anything is recorded, and the error does not repeat the token.
  const wrong = `sprites-${secret()}`, refused = fresh();
  const error = await new FactorySpriteLiteFleet({ directory: refused, token: wrong, api: API, fetch: sprites.fetch, auth: auth() })
    .deploy(plan(), { bundlePath: bundle(refused) }).catch(value => value);
  assert.match(error.message, /refused this token/); assert.equal(error.message.includes(wrong), false);
  assert.equal(sprites.state.sprites.size, 0);
});

test('every provider command a fleet sends has a Sprites equivalent', async () => {
  const source = readFileSync(new URL('../src/cloud-lite/fleet.mjs', import.meta.url), 'utf8');
  const sent = new Set([...source.matchAll(/this\.fly\(\[\s*'([a-z]+)'\s*,\s*'([a-z]+)'/g)].map(match => `${match[1]} ${match[2]}`));
  assert.deepEqual([...sent].sort(), [...SPRITES_FLEET_COMMANDS].sort());
  const sprites = fakeSprites(), infrastructure = createSpritesInfrastructure({ directory: fresh(), token: sprites.token, api: API, fetch: sprites.fetch });
  await assert.rejects(infrastructure.run(['deploy', '--app', APP]), /no equivalent of: deploy/);
  await assert.rejects(infrastructure.run(['ssh', 'sftp', 'put', 'a', 'b', '--app', APP]), /no equivalent/);
  await assert.rejects(infrastructure.run(['machine', 'list', '--app', 'Not A Valid App']), /Invalid app/);
  await assert.rejects(infrastructure.run(['secrets', 'import', '--app', APP], { input: 'lower-case=value\n' }), /Invalid secret name/);
  assert.equal(sprites.state.calls.length, 0);
});

test('the start script is valid bash, keeps the Sprite awake only while the worker runs, and reads the exec framing', () => {
  const checkedSyntax = spawnSync('bash', ['-n'], { input: SPRITE_START_SCRIPT, encoding: 'utf8' });
  if (!checkedSyntax.error) assert.equal(checkedSyntax.status, 0, checkedSyntax.stderr);
  assert.match(SPRITE_START_SCRIPT, /\/etc\/factory\/env\/\* \/etc\/factory\/secrets\/\*/);
  assert.match(SPRITE_START_SCRIPT, /--unix-socket \/\.sprite\/api\.sock/);
  // The keeper renews the task only while the start script itself is alive, and the task is released when the worker ends.
  assert.match(SPRITE_START_SCRIPT, /while kill -0 \$\$ 2>\/dev\/null; do task PUT '\{"expire":"5m"\}'; sleep 60; done/);
  // A requested stop ends cleanly (a Sprite would record the signal exit as a crash); otherwise the worker's own exit code is passed on.
  assert.match(SPRITE_START_SCRIPT, /\ntask DELETE\n#[^\n]*\n\[ -n "\$\{stopping:-\}" \] && exit 0\nexit "\$code"\n$/);
  assert.deepEqual(readExecOutput(Buffer.concat([Buffer.from([1]), Buffer.from('hello\n'), Buffer.from([2]), Buffer.from('warn\n'), Buffer.from([3, 7])])), { exit: 7, text: 'hello\nwarn\n' });
  assert.deepEqual(readExecOutput(Buffer.from([1, 0x6f, 0x6b])), { exit: null, text: 'ok' });
  assert.equal(servicePath(''), '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  assert.equal(servicePath('/home/sprite/bin:relative:/opt/tools:/usr/local/bin'), '/usr/local/sbin:/usr/local/bin:/opt/tools');
});

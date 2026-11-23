import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FactoryDockerLiteFleet, createDockerInfrastructure, DOCKER_FLEET_COMMANDS, DOCKER_WORKER_IMAGE } from '../src/cloud-lite/docker.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';
import { cloudLiteBootstrap, cloudLiteImageSetup } from '../src/cloud-lite/bootstrap.mjs';
import { hash, secret } from '../src/cloud-lite/protocol.mjs';
import { tempDir } from './support/temp-dir.mjs';

const fresh = () => tempDir('factory-docker-lite-');
const plan = (overrides = {}) => ({ runId: 'docker-test', app: 'factory-docker-test', goal: 'Work on the shared board', machines: 2, agentsPerMachine: 2, ...overrides });
const APP = 'factory.docker.app';

/** Reads the tar stream the fleet hands to `docker cp -`. */
function untar(bytes) {
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const prefix = text(345, 155), size = parseInt(text(124, 12), 8);
    entries.set((prefix ? `${prefix}/` : '') + text(0, 100), { mode: parseInt(text(100, 8), 8), type: text(156, 1), owner: parseInt(text(108, 8), 8),
      bytes: Buffer.from(bytes.subarray(offset + 512, offset + 512 + size)) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** A Docker that keeps its networks, volumes and containers in memory and answers the CLI calls the fleet makes. */
function fakeDocker({ info = { ServerVersion: '29.0.0', NCPU: 8, MemTotal: 16e9, OSType: 'linux' } } = {}) {
  const state = { networks: new Map(), volumes: new Map(), images: new Map(), containers: [], calls: [], boardPort: 0, failNextCreate: null, exec: () => '', archive: Buffer.alloc(0), sequence: 0 };
  const fail = message => { throw new Error(message); };
  const find = reference => state.containers.find(value => value.Id === reference || value.Name === `/${reference}`) ?? fail(`No such container: ${reference}`);
  const filtered = (collection, args) => {
    const filter = args[args.indexOf('--filter') + 1], [kind, ...rest] = filter.split('=');
    return [...collection].filter(([name, labels]) => kind === 'name' ? name.includes(rest.join('=')) : labels[rest[0]] === rest.slice(1).join('='));
  };
  const labelsOf = args => Object.fromEntries(args.flatMap((arg, index) => arg === '--label' ? [[args[index + 1].split('=')[0], args[index + 1].split('=').slice(1).join('=')]] : []));
  async function execute(_command, args, options = {}) {
    state.calls.push({ args, input: options.input });
    const [verb, ...rest] = args;
    if (verb === 'info') return typeof info === 'function' ? info() : JSON.stringify(info);
    if (verb === 'network') {
      if (rest[0] === 'create') { const name = rest.at(-1); if (state.networks.has(name)) fail(`network with name ${name} already exists`); state.networks.set(name, labelsOf(rest)); return name; }
      if (rest[0] === 'ls') return filtered(state.networks, rest).map(([name]) => name).join('\n');
      if (rest[0] === 'rm') { if (!state.networks.delete(rest[1])) fail('network not found'); return ''; }
    }
    if (verb === 'volume') {
      if (rest[0] === 'create') { state.volumes.set(rest.at(-1), labelsOf(rest)); return rest.at(-1); }
      if (rest[0] === 'ls') return filtered(state.volumes, rest).map(([name]) => name).join('\n');
      if (rest[0] === 'rm') { if (!state.volumes.delete(rest[1])) fail('no such volume'); return ''; }
    }
    if (verb === 'image' && rest[0] === 'ls') { const wanted = rest[rest.indexOf('--filter') + 1].replace('reference=', ''); return state.images.has(wanted) ? wanted : ''; }
    if (verb === 'build') { state.images.set(rest[rest.indexOf('--tag') + 1], { labels: labelsOf(rest), context: untar(options.input) }); return ''; }
    if (verb === 'ps') return state.containers.filter(value => filtered([[value.Id, value.Config.Labels]], rest).length).map(value => value.Id).join('\n');
    if (verb === 'inspect') return JSON.stringify(rest.slice(2).map(find).map(({ files, ...value }) => value));
    if (verb === 'create') {
      if (state.failNextCreate) { const message = state.failNextCreate; state.failNextCreate = null; fail(message); }
      const valued = new Set(['--name', '--network', '--network-alias', '--label', '--mount', '--cpus', '--memory', '--restart', '--add-host', '--env', '--publish', '--entrypoint']);
      const options = {}; let index = 0;
      for (; index < rest.length && rest[index].startsWith('--'); index++) {
        if (valued.has(rest[index])) (options[rest[index]] ??= []).push(rest[++index]);
        else options[rest[index]] = true;
      }
      const name = options['--name'][0];
      if (state.containers.some(value => value.Name === `/${name}`)) fail(`Conflict. The container name "/${name}" is already in use`);
      if (!state.networks.has(options['--network'][0])) fail('network not found');
      const mounts = (options['--mount'] ?? []).map(spec => Object.fromEntries(spec.split(',').map(part => part.split('='))));
      for (const mount of mounts) if (!state.volumes.has(mount.source)) fail(`a missing volume ${mount.source} would have been created silently`);
      state.containers.push({ Id: (++state.sequence).toString(16).padStart(64, 'c'), Name: `/${name}`, State: { Status: 'created' }, files: new Map(),
        Config: { Image: rest[index], Labels: labelsOf(rest.slice(0, index)), Env: options['--env'] ?? [], Entrypoint: options['--entrypoint'], Cmd: rest.slice(index + 1) },
        HostConfig: { NetworkMode: options['--network'][0], NanoCpus: Number(options['--cpus']?.[0] ?? 0) * 1e9, Memory: options['--memory']?.[0], Init: options['--init'] === true,
          RestartPolicy: { Name: options['--restart']?.[0] }, ExtraHosts: options['--add-host'] ?? [], PortBindings: Object.fromEntries((options['--publish'] ?? []).map(spec => [`${spec.split(':').at(-1)}/tcp`, [{ HostIp: spec.split(':')[0], HostPort: '' }]])) },
        NetworkSettings: { Networks: { [options['--network'][0]]: { Aliases: options['--network-alias'] } } },
        Mounts: mounts.map(mount => ({ Type: 'volume', Name: mount.source, Destination: mount.target })) });
      return state.containers.at(-1).Id;
    }
    if (verb === 'cp' && rest[0] === '-') { const target = find(rest[1].split(':')[0]); for (const [path, entry] of untar(options.input)) target.files.set(path, entry); return ''; }
    if (verb === 'cp') { find(rest[0].split(':')[0]); writeFileSync(rest[1], state.archive); return ''; }
    if (verb === 'start') { find(rest[0]).State.Status = 'running'; return rest[0]; }
    if (verb === 'stop') { find(rest.at(-1)).State.Status = 'exited'; return rest.at(-1); }
    if (verb === 'rm') { const target = find(rest.at(-1)); state.containers.splice(state.containers.indexOf(target), 1); return ''; }
    if (verb === 'rename') { find(rest[0]).Name = `/${rest[1]}`; return ''; }
    if (verb === 'exec') return state.exec(find(rest[0]), rest.slice(1));
    if (verb === 'port') { const target = find(rest[0]); if (target.State.Status !== 'running' || !target.HostConfig.PortBindings[rest[1]]) fail('no public port'); return `127.0.0.1:${state.boardPort}\n`; }
    fail(`The fake Docker does not know: ${args.join(' ')}`);
  }
  return { state, execute };
}

const auth = () => { const accessToken = secret(); return { read: () => ({ accessToken, chatgptAccountId: 'account' }), refresh: async () => ({ accessToken, chatgptAccountId: 'account' }) }; };
function bundle(directory, name = 'bundle.tgz', content = 'sdk-bytes') { const file = join(directory, name); writeFileSync(file, content); return file; }
async function deployed(overrides = {}) {
  const directory = fresh(), docker = fakeDocker(), broker = auth();
  const fleet = new FactoryDockerLiteFleet({ directory, dockerExecute: docker.execute, auth: broker });
  const result = await fleet.deploy(plan(overrides), { bundlePath: bundle(directory) });
  return { directory, docker, fleet, result, broker };
}

test('a Docker fleet becomes one private network, one volume and one container per machine', async () => {
  const { docker, result, directory } = await deployed();
  const { state } = docker; const app = 'factory-docker-test';
  assert.equal(result.status, 'provisioned'); assert.equal(result.image, DOCKER_WORKER_IMAGE);
  assert.deepEqual([...state.networks], [[app, { [APP]: app }]]);
  assert.deepEqual([...state.volumes.keys()], [`${app}-factory_m0`, `${app}-factory_m1`]);
  assert.equal([...state.volumes.values()].every(labels => labels[APP] === app), true);
  assert.deepEqual(state.containers.map(value => value.Name), ['/factory-docker-test-m0', '/factory-docker-test-m1']);
  const [first, second] = state.containers;
  for (const [index, container] of state.containers.entries()) {
    assert.equal(container.State.Status, 'running'); assert.equal(container.Config.Image, DOCKER_WORKER_IMAGE);
    assert.equal(container.HostConfig.NetworkMode, app); assert.equal(container.HostConfig.Init, true); assert.equal(container.HostConfig.RestartPolicy.Name, 'no');
    assert.equal(container.HostConfig.NanoCpus, 2e9); assert.equal(container.HostConfig.Memory, '4096m');
    assert.deepEqual(container.HostConfig.ExtraHosts, ['host.docker.internal:host-gateway']);
    assert.deepEqual(container.Mounts, [{ Type: 'volume', Name: `${app}-factory_m${index}`, Destination: '/data' }]);
    assert.equal(container.Config.Labels['factory.run'], 'docker-test'); assert.equal(container.Config.Labels['factory.machine'], `m${index}`);
    assert.equal(container.Config.Labels[APP], app);
    // The start command reads the secret files, then runs the bootstrap the Fly machines run.
    assert.deepEqual(container.Config.Entrypoint, ['/bin/sh']);
    assert.equal(container.Config.Cmd[0], '-c'); assert.match(container.Config.Cmd[1], /run\/factory\/secrets/);
    assert.deepEqual(container.Config.Cmd.slice(2), ['factory-init', '/bin/bash', '/opt/factory-bootstrap.sh']);
    assert.deepEqual(result.machines[index], { id: container.Config.Labels['factory.docker.id'], name: container.Name.slice(1), volumeId: `${app}-factory_m${index}`,
      config: { cpuKind: 'shared', cpus: 2, memoryMb: 4096, diskGb: 20 } });
  }
  // Only the board of the first machine is published, and only on loopback.
  assert.deepEqual(first.HostConfig.PortBindings, { '4200/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] });
  assert.deepEqual(second.HostConfig.PortBindings, {});
  // The second machine finds the board under the first machine's private name, as it does on Fly.
  const boardMachine = second.Config.Env.find(entry => entry.startsWith('FACTORY_BOARD_MACHINE_ID=')).split('=')[1];
  assert.equal(boardMachine, result.machines[0].id);
  assert.deepEqual(first.NetworkSettings.Networks[app].Aliases, [`${boardMachine}.vm.${app}.internal`]);
  assert.equal(JSON.parse(readFileSync(join(directory, 'fleet.json'), 'utf8')).operations['m1.machine-create'].state, 'succeeded');
});

test('logins and board credentials travel as root-only files, never on a command line', async () => {
  const { docker, directory, broker } = await deployed();
  const { credentials, operatorToken } = JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf8'));
  const staged = JSON.parse(readFileSync(join(directory, 'docker-secrets.json'), 'utf8'))['factory-docker-test'].FACTORY_CLOUD_BOOTSTRAP_B64;
  const secrets = [broker.read().accessToken, operatorToken, staged, ...Object.values(credentials)];
  const commandLines = JSON.stringify(docker.state.calls.map(call => call.args));
  assert.equal(secrets.some(value => commandLines.includes(value)), false);
  const visible = JSON.stringify(docker.state.containers.map(({ files, ...value }) => value));
  assert.equal(secrets.some(value => visible.includes(value)), false);
  for (const container of docker.state.containers) {
    const file = container.files.get('run/factory/secrets/FACTORY_CLOUD_BOOTSTRAP_B64');
    assert.equal(file.mode, 0o600); assert.equal(file.owner, 0);
    assert.equal(container.files.get('run/factory/secrets/').mode, 0o700); assert.equal(container.files.get('run/factory/secrets/').type, '5');
    const config = JSON.parse(Buffer.from(file.bytes.toString('utf8'), 'base64').toString('utf8'));
    assert.equal(config.plan.runId, 'docker-test'); assert.equal(config.operatorToken, operatorToken); assert.equal(config.initialAuth.accessToken, broker.read().accessToken);
    assert.equal(container.files.get('tmp/factory-sdk.tgz').bytes.toString(), 'sdk-bytes');
    assert.match(container.files.get('opt/factory-bootstrap.sh').bytes.toString(), new RegExp(hash('sdk-bytes')));
  }
});

test('without a bundle the installed SDK is packed once and reused when the fleet is resumed', async () => {
  const directory = fresh(), docker = fakeDocker();
  const fleet = new FactoryDockerLiteFleet({ directory, dockerExecute: docker.execute, auth: auth() });
  await fleet.deploy(plan({ machines: 1 }));
  const packed = readFileSync(join(directory, 'factory-sdk.tgz'));
  assert.equal(gunzipSync(packed).subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''), 'package/LICENSE');
  assert.equal(hash(docker.state.containers[0].files.get('tmp/factory-sdk.tgz').bytes), hash(packed));
  const resumed = new FactoryDockerLiteFleet({ directory, dockerExecute: docker.execute, auth: auth() });
  assert.equal((await resumed.deploy(plan({ machines: 1 }))).bundleSha256, hash(packed));
  assert.equal(docker.state.containers.length, 1);
  // An image that already holds the runtime starts it directly, as on Fly.
  const prebuilt = fakeDocker();
  await new FactoryDockerLiteFleet({ directory: fresh(), dockerExecute: prebuilt.execute, auth: auth() }).deploy(plan({ machines: 1 }), { image: 'registry.example/factory-worker:1', bundlePath: false });
  assert.deepEqual(prebuilt.state.containers[0].Config.Cmd.slice(2), ['factory-init', 'node', '/opt/factory/bin/factory-cloud-runtime.mjs']);
  assert.equal(prebuilt.state.containers[0].files.has('tmp/factory-sdk.tgz'), false);
});

test('the host reaches the board on the loopback port Docker picked', async () => {
  const { docker, fleet, directory } = await deployed();
  const { credentials, operatorToken } = JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf8'));
  const coordinator = await startCloudLiteCoordinator({ database: join(directory, 'board.sqlite'), plan: fleet.state.plan, credentials, operatorToken,
    auth: { accessToken: secret(), chatgptAccountId: 'account' }, githubToken: secret(), host: '127.0.0.1', port: 0 });
  try {
    docker.state.boardPort = coordinator.server.address().port;
    const status = await fleet.observe();
    assert.deepEqual(status.agents.map(agent => agent.id), ['m0-a0', 'm0-a1', 'm1-a0', 'm1-a1']);
    assert.equal(fleet.connection.origin, `http://127.0.0.1:${docker.state.boardPort}`);
    assert.deepEqual(await fleet.command('m1-a1', { id: 'first-message', message: 'Start' }), { recorded: true });
    assert.equal(coordinator.board.db.prepare('SELECT recipient FROM cloud_lite_commands WHERE id=?').get('first-message').recipient, 'm1-a1');
    await fleet.disconnect();
    // A stopped coordinator has no port: the fleet refuses instead of guessing.
    docker.state.containers[0].State.Status = 'exited';
    await assert.rejects(fleet.observe(), /coordinator Machine is not started/);
  } finally { await fleet.disconnect(); await coordinator.close(); }
});

test('stop and start act on the same containers', async () => {
  const { docker, fleet } = await deployed();
  const identities = docker.state.containers.map(value => value.Id);
  await fleet.stop();
  assert.deepEqual(docker.state.containers.map(value => value.State.Status), ['exited', 'exited']);
  assert.deepEqual(docker.state.calls.filter(call => call.args[0] === 'stop').map(call => call.args.at(-1)), [...identities].reverse());
  await fleet.start({ attempt: 'after-stop' });
  assert.deepEqual(docker.state.containers.map(value => value.State.Status), ['running', 'running']);
  assert.deepEqual(docker.state.containers.map(value => value.Id), identities);
  // Stopping again after that start stops the containers again.
  await fleet.stop();
  assert.deepEqual(docker.state.containers.map(value => value.State.Status), ['exited', 'exited']);
  assert.equal(fleet.state.status, 'stopped');
});

test('a runtime update replaces each container and keeps its identity, name, volume and secrets', async () => {
  const { docker, fleet, directory, result } = await deployed();
  const before = docker.state.containers.map(value => value.Id);
  const next = bundle(directory, 'next.tgz', 'newer-sdk-bytes');
  assert.deepEqual(await fleet.updateRuntime({ bundlePath: next }), { updated: 2, digest: hash('newer-sdk-bytes') });
  assert.equal(docker.state.containers.length, 2);
  for (const [index, container] of docker.state.containers.entries()) {
    assert.equal(before.includes(container.Id), false);
    assert.equal(container.Name, `/factory-docker-test-m${index}`); assert.equal(container.State.Status, 'running');
    assert.equal(container.Config.Labels['factory.docker.id'], result.machines[index].id);
    assert.equal(container.Config.Labels['factory.bundle'], hash('newer-sdk-bytes'));
    assert.deepEqual(container.Mounts, [{ Type: 'volume', Name: `factory-docker-test-factory_m${index}`, Destination: '/data' }]);
    assert.equal(container.files.get('tmp/factory-sdk.tgz').bytes.toString(), 'newer-sdk-bytes');
    assert.equal(container.files.get('run/factory/secrets/FACTORY_CLOUD_BOOTSTRAP_B64').mode, 0o600);
    assert.equal(container.Config.Env.includes(`FACTORY_BOARD_MACHINE_ID=${result.machines[0].id}`), true);
  }
  assert.equal(docker.state.volumes.size, 2);
  // A replacement that cannot be created puts the original back under its name and starts it again.
  const original = docker.state.containers.map(value => value.Id);
  docker.state.failNextCreate = 'no space left on device';
  await assert.rejects(fleet.updateRuntime({ bundlePath: bundle(directory, 'third.tgz', 'third-sdk-bytes') }), /no space left/);
  assert.deepEqual(docker.state.containers.map(value => [value.Id, value.Name, value.State.Status]),
    [[original[0], '/factory-docker-test-m0', 'running'], [original[1], '/factory-docker-test-m1', 'running']]);
});

test('collection runs its job inside the container and copies the archive out', async () => {
  const { docker, fleet } = await deployed({ machines: 1 });
  const archive = Buffer.from('collected-evidence'); docker.state.archive = archive;
  docker.state.exec = (_container, command) => {
    assert.deepEqual(command.slice(0, 2), ['/bin/sh', '-c']); assert.match(command[2], /^node -e "eval\(Buffer\.from\('/);
    return JSON.stringify({ state: 'completed', archive: '/data/evidence.tgz', bytes: archive.length, sha256: hash(archive) });
  };
  fleet.quiesce = async () => ({ agents: 2 });
  const collected = await fleet.collect({ concurrency: 1 });
  assert.equal(collected.complete, true);
  const copy = docker.state.calls.find(call => call.args[0] === 'cp' && call.args[1] !== '-');
  assert.equal(copy.args[1], `${docker.state.containers[0].Id}:/data/evidence.tgz`);
  assert.deepEqual(readFileSync(fleet.state.artifacts[0].file), archive);
});

test('retire removes what the fleet created and nothing else', async () => {
  const { docker, fleet, directory } = await deployed();
  const { state } = docker;
  state.networks.set('someone-else', {}); state.volumes.set('someone-else-data', {});
  await docker.execute('docker', ['create', '--name', 'someone-else', '--network', 'someone-else', 'alpine']);
  // A container in the app that the journal does not know blocks retirement; nothing is removed.
  await docker.execute('docker', ['create', '--name', 'intruder', '--network', 'factory-docker-test', '--label', `${APP}=factory-docker-test`, '--label', 'factory.docker.id=feedfacefeed00', 'alpine']);
  await assert.rejects(fleet.retire(), /exact original Machine and volume inventory/);
  assert.equal(state.containers.length, 4); assert.equal(state.volumes.size, 3);
  await docker.execute('docker', ['rm', '--force', 'intruder']);
  await fleet.retire();
  assert.deepEqual(state.containers.map(value => value.Name), ['/someone-else']);
  assert.deepEqual([...state.volumes.keys()], ['someone-else-data']); assert.deepEqual([...state.networks.keys()], ['someone-else']);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'docker-secrets.json'), 'utf8')), {});
  assert.equal(fleet.state.status, 'retired');
  await assert.rejects(fleet.observe(), /retired/);
});

test('a Docker that cannot run the plan is refused before anything is recorded', async () => {
  const attempt = async (docker, input = plan(), options = {}) => {
    const directory = fresh();
    const fleet = new FactoryDockerLiteFleet({ directory, auth: auth(), ...docker });
    const outcome = await fleet.deploy(input, { bundlePath: bundle(directory), ...options }).then(() => null, error => error);
    return { outcome, recorded: existsSync(join(directory, 'fleet.json')) };
  };
  const stopped = await attempt({ dockerExecute: fakeDocker({ info: () => { throw new Error('Cannot connect to the Docker daemon'); } }).execute });
  assert.match(stopped.outcome.message, /Docker is not running or cannot be reached/); assert.equal(stopped.recorded, false);
  const missing = await attempt({ dockerCommand: 'factory-test-no-such-docker-binary' });
  assert.match(missing.outcome.message, /Docker was not found/); assert.equal(missing.recorded, false);
  const serverDown = await attempt({ dockerExecute: fakeDocker({ info: { ServerErrors: ['error during connect'] } }).execute });
  assert.match(serverDown.outcome.message, /error during connect/); assert.equal(serverDown.recorded, false);
  const small = await attempt({ dockerExecute: fakeDocker({ info: { NCPU: 2, OSType: 'linux' } }).execute }, plan({ cpus: 4 }));
  assert.match(small.outcome.message, /4 CPUs, but this Docker has 2/); assert.equal(small.recorded, false);
  const windows = await attempt({ dockerExecute: fakeDocker({ info: { NCPU: 8, OSType: 'windows' } }).execute });
  assert.match(windows.outcome.message, /Linux containers/); assert.equal(windows.recorded, false);
  const network = await attempt({ dockerExecute: fakeDocker().execute }, plan({ network: 'custom-net' }));
  assert.match(network.outcome.message, /network is a Fly setting/); assert.equal(network.recorded, false);
  const source = await attempt({ dockerExecute: fakeDocker().execute }, plan(), { imageSource: 'https://flujo.example' });
  assert.match(source.outcome.message, /Fly image sources do not apply/); assert.equal(source.recorded, false);
});

test('an existing volume or network is never adopted', async () => {
  const taken = fakeDocker(); taken.state.volumes.set('factory-docker-test-factory_m0', {});
  const directory = fresh();
  const fleet = new FactoryDockerLiteFleet({ directory, dockerExecute: taken.execute, auth: auth() });
  await assert.rejects(fleet.deploy(plan(), { bundlePath: bundle(directory) }), /already exists/);
  assert.equal(taken.state.containers.length, 0);
  assert.equal(JSON.parse(readFileSync(join(directory, 'fleet.json'), 'utf8')).operations['m0.volume'].state, 'unknown');
  const named = fakeDocker(); named.state.networks.set('factory-docker-test', {});
  const second = fresh();
  await assert.rejects(new FactoryDockerLiteFleet({ directory: second, dockerExecute: named.execute, auth: auth() }).deploy(plan(), { bundlePath: bundle(second) }), /already exists/);
  assert.equal(named.state.volumes.size, 0);
  // A foreign volume is refused as a mount even when it is named like one of the fleet's.
  const infrastructure = createDockerInfrastructure({ directory: fresh(), execute: named.execute });
  await assert.rejects(infrastructure.createMachine({ app: 'factory-docker-test', name: 'factory-x-m0',
    config: { image: 'node:24', init: { exec: ['node'] }, mounts: [{ volume: 'someone-else-data', path: '/data' }] } }), /does not belong/);
  // Machine settings cannot replace the labels that say which fleet owns a container, or pass an option as an image name.
  await assert.rejects(infrastructure.createMachine({ app: 'factory-docker-test', name: 'factory-x-m0',
    config: { image: 'node:24', init: { exec: ['node'] }, metadata: { 'factory.docker.app': 'another-fleet' } } }), /Invalid metadata name/);
  await assert.rejects(infrastructure.createMachine({ app: 'factory-docker-test', name: 'factory-x-m0', config: { image: '--privileged', init: { exec: ['node'] } } }), /Invalid image/);
  assert.equal(named.state.containers.length, 0);
});

test('every provider command a fleet sends has a Docker equivalent', async () => {
  const source = readFileSync(new URL('../src/cloud-lite/fleet.mjs', import.meta.url), 'utf8');
  const sent = new Set([...source.matchAll(/this\.fly\(\[\s*'([a-z]+)'\s*,\s*'([a-z]+)'/g)].map(match => `${match[1]} ${match[2]}`));
  assert.equal(source.split('this.fly([').length - 1, [...source.matchAll(/this\.fly\(\[\s*'([a-z]+)'\s*,\s*'([a-z]+)'/g)].length);
  assert.deepEqual([...sent].sort(), [...DOCKER_FLEET_COMMANDS].sort());
  const docker = fakeDocker(), infrastructure = createDockerInfrastructure({ directory: fresh(), execute: docker.execute });
  await assert.rejects(infrastructure.run(['deploy', '--app', 'factory-docker-test']), /no equivalent of: deploy/);
  await assert.rejects(infrastructure.run(['ssh', 'sftp', 'put', 'a', 'b', '--app', 'factory-docker-test']), /no equivalent/);
  await assert.rejects(infrastructure.run(['machine', 'list', '--app', 'Not A Valid App']), /Invalid app/);
  await assert.rejects(infrastructure.run(['secrets', 'import', '--app', 'factory-docker-test'], { input: 'lower-case=value\n' }), /Invalid secret name/);
  assert.equal(docker.state.calls.length, 0);
});

test('a machine skips a set-up that was already done for the same bundle and program', () => {
  const digest = 'c'.repeat(64);
  for (const program of ['codex', 'claude', 'flujo']) {
    const script = cloudLiteBootstrap(digest, { workerProgram: program }).split('\n');
    const record = script.indexOf(`echo '${digest} ${program}' > /opt/factory/.factory-setup`);
    const order = [script.indexOf(`echo '${digest}  /tmp/factory-sdk.tgz' | sha256sum -c -`),
      script.indexOf(`if [ "$(cat /opt/factory/.factory-setup 2>/dev/null || true)" != '${digest} ${program}' ]; then`), script.indexOf('apt-get update'),
      script.findIndex(line => line.startsWith('npm install --prefix /opt/flujo-bash')), record, script.indexOf('fi', record), script.indexOf('exec node bin/factory-cloud-runtime.mjs')];
    // The bundle is checked every time; the record is written only after every set-up step; the runtime starts either way.
    assert.equal(order.includes(-1), false, program); assert.deepEqual(order, [...order].sort((a, b) => a - b), program);
    assert.equal(script[record + 1], 'fi');
  }
  // The same steps as an image build: nothing touches a machine's volume, and FLUJO goes into the image.
  const codex = cloudLiteImageSetup(digest), flujo = cloudLiteImageSetup(digest, { workerProgram: 'flujo' });
  assert.equal(codex.includes('/data'), false); assert.equal(flujo.includes('/data'), false);
  assert.match(flujo, /^npm install --prefix \/opt\/flujo-program /m);
  assert.equal(codex.trimEnd().split('\n').at(-1), `echo '${digest} codex' > /opt/factory/.factory-setup`);
  assert.equal(codex.includes('factory-cloud-runtime'), false);
  assert.throws(() => cloudLiteImageSetup('short'), /exact SDK bundle/);
  assert.throws(() => cloudLiteImageSetup(digest, { workerProgram: 'other' }), /Unknown worker program/);
});

test('prebuild builds one image for a bundle and program and every later fleet reuses it', async () => {
  const docker = fakeDocker(), directory = fresh(), file = bundle(directory), events = [];
  const builds = () => docker.state.calls.filter(call => call.args[0] === 'build').length;
  const fleet = new FactoryDockerLiteFleet({ directory, dockerExecute: docker.execute, auth: auth(), onEvent: event => events.push(event.type) });
  const result = await fleet.deploy(plan(), { bundlePath: file, prebuild: true });
  assert.equal(builds(), 1);
  const [[tag, built]] = [...docker.state.images];
  assert.match(tag, /^factory-worker:codex-[a-f0-9]{16}$/); assert.equal(result.image, tag);
  assert.deepEqual(built.labels, { 'factory.docker.image': 'codex' });
  assert.equal(built.context.get('Dockerfile').bytes.toString(),
    `FROM ${DOCKER_WORKER_IMAGE}\nCOPY factory-sdk.tgz /tmp/factory-sdk.tgz\nCOPY factory-image-setup.sh /opt/factory-image-setup.sh\nRUN /bin/bash /opt/factory-image-setup.sh\n`);
  assert.equal(built.context.get('factory-sdk.tgz').bytes.toString(), 'sdk-bytes');
  assert.equal(built.context.get('factory-image-setup.sh').bytes.toString(), cloudLiteImageSetup(hash('sdk-bytes')));
  // Containers come from that image and still get the bundle and the start script, which finds the set-up done.
  assert.deepEqual(docker.state.containers.map(value => value.Config.Image), [tag, tag]);
  assert.equal(docker.state.containers[0].files.get('tmp/factory-sdk.tgz').bytes.toString(), 'sdk-bytes');
  assert.match(docker.state.containers[0].files.get('opt/factory-bootstrap.sh').bytes.toString(), new RegExp(`!= '${hash('sdk-bytes')} codex' \\]; then`));
  assert.deepEqual(events.filter(type => type.startsWith('image.')), ['image.started', 'image.ready']);
  // The same bundle and program in another fleet: no second build. Another program: its own image.
  const second = fresh();
  await new FactoryDockerLiteFleet({ directory: second, dockerExecute: docker.execute, auth: auth() })
    .deploy(plan({ runId: 'docker-second', app: 'factory-docker-second' }), { bundlePath: bundle(second), prebuild: true });
  assert.equal(builds(), 1);
  const third = fresh();
  await new FactoryDockerLiteFleet({ directory: third, dockerExecute: docker.execute, auth: { program: 'claude', read: () => ({ accessToken: secret() }) } })
    .deploy(plan({ runId: 'docker-third', app: 'factory-docker-third', workerProgram: 'claude' }), { bundlePath: bundle(third), prebuild: true });
  assert.equal(builds(), 2); assert.equal([...docker.state.images.keys()].some(name => name.startsWith('factory-worker:claude-')), true);
  // Resuming the first fleet names the same image, so its journal still matches.
  assert.equal((await new FactoryDockerLiteFleet({ directory, dockerExecute: docker.execute, auth: auth() }).deploy(plan(), { bundlePath: file, prebuild: true })).image, tag);
  assert.equal(builds(), 2);
  // Refused before any build: a wrong setting, an image that needs no bundle, a Docker that does not run.
  const refused = async (options, engine = docker) => {
    const folder = fresh(), before = engine.state.images.size;
    const outcome = await new FactoryDockerLiteFleet({ directory: folder, dockerExecute: engine.execute, auth: auth() })
      .deploy(plan({ runId: 'docker-refused', app: 'factory-docker-refused' }), { bundlePath: bundle(folder), ...options }).then(() => null, error => error);
    assert.equal(engine.state.images.size, before); assert.equal(existsSync(join(folder, 'fleet.json')), false);
    return outcome.message;
  };
  assert.match(await refused({ prebuild: 'yes' }), /prebuild must be true or false/);
  assert.match(await refused({ prebuild: true, bundlePath: false }), /cannot be combined with bundlePath: false/);
  assert.match(await refused({ prebuild: true }, fakeDocker({ info: () => { throw new Error('Cannot connect to the Docker daemon'); } })), /Docker is not running/);
});

test('containers may use a model server on this computer, but only under the name they can reach', async () => {
  const attempt = async url => {
    const docker = fakeDocker(), directory = fresh();
    const outcome = await new FactoryDockerLiteFleet({ directory, dockerExecute: docker.execute })
      .deploy(plan({ machines: 1, model: 'served-model', subagentModel: 'served-model', modelProvider: { id: 'local', envKey: 'LOCAL_MODEL_KEY', baseUrls: [url], model: 'served-model' } }),
        { bundlePath: bundle(directory), providerKey: 'local-key-0001' }).then(() => null, error => error);
    return { outcome, docker, recorded: existsSync(join(directory, 'fleet.json')) };
  };
  const reachable = await attempt('http://host.docker.internal:11434/v1');
  assert.equal(reachable.outcome, null);
  assert.deepEqual(reachable.docker.state.containers[0].HostConfig.ExtraHosts, ['host.docker.internal:host-gateway']);
  const config = JSON.parse(Buffer.from(reachable.docker.state.containers[0].files.get('run/factory/secrets/FACTORY_CLOUD_BOOTSTRAP_B64').bytes.toString(), 'base64').toString());
  assert.deepEqual(config.plan.modelProvider.baseUrls, ['http://host.docker.internal:11434/v1']); assert.equal(config.providerKey, 'local-key-0001');
  for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1']) {
    const loopback = await attempt(url);
    assert.match(loopback.outcome.message, /localhost is the container itself; reach a model server on this computer as http:\/\/host\.docker\.internal:<port>/);
    assert.equal(loopback.recorded, false); assert.equal(loopback.docker.state.networks.size, 0);
  }
});

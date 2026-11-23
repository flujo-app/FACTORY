#!/usr/bin/env node
/**
 * A real lite fleet on local Docker, start to finish: containers, shared board, a stop and a start,
 * a runtime update, collection and removal. It makes no model call unless --turn is given; then one
 * agent on the last machine gets one short message and must record a claim on the shared board.
 *
 *   node scripts/docker-fleet-smoke.mjs --directory <absolute folder> --evidence <absolute file>
 *     [--program codex|claude|flujo] [--codex-auth <auth.json>] [--claude-token <file>]
 *     [--machines 2] [--agents 2] [--image <name>] [--turn] [--quick] [--keep]
 *
 * --quick stops after every agent has enrolled and removes the fleet. FLUJO workers need a model
 * endpoint; without --turn none is called, so this script gives them a placeholder one.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { FactoryDockerLiteFleet, CodexSubscriptionBroker, ClaudeSubscriptionBroker, DOCKER_WORKER_IMAGE, agentInventory } from '../src/public-sdk.mjs';

const flags = {};
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (['--turn', '--keep', '--quick'].includes(name)) flags[name] = true;
  else flags[name] = process.argv[++index];
}
const directory = flags['--directory'], evidenceFile = flags['--evidence'];
if (!isAbsolute(directory ?? '') || !isAbsolute(evidenceFile ?? '')) throw new Error('Select an absolute --directory and an absolute --evidence file.');
const program = flags['--program'] ?? 'codex';
const machines = Number(flags['--machines'] ?? 2), agentsPerMachine = Number(flags['--agents'] ?? 2);
const image = flags['--image'] ?? DOCKER_WORKER_IMAGE;
if (program === 'flujo' && flags['--turn']) throw new Error('A FLUJO turn needs a real model endpoint; run FLUJO without --turn.');
const auth = program === 'flujo' ? undefined : program === 'claude' ? new ClaudeSubscriptionBroker({ tokenFile: flags['--claude-token'] })
  : new CodexSubscriptionBroker({ authFile: flags['--codex-auth'] ?? join(homedir(), '.codex', 'auth.json') });
const provider = program === 'flujo' ? { modelProvider: { id: 'acceptance', envKey: 'ACCEPTANCE_MODEL_KEY', baseUrls: ['https://model.invalid/v1'], apis: ['chat'], model: 'acceptance-model' } } : {};
const providerKey = program === 'flujo' ? 'acceptance-placeholder-key' : undefined;

const docker = async args => (await promisify(execFile)('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout;
const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = Date.now();
const checks = [], events = [];
const check = (name, details = {}) => { checks.push({ name, atMs: Date.now() - started, ...details }); console.log(`ok   ${name}`); };

mkdirSync(directory, { recursive: true, mode: 0o700 });
const journal = join(directory, 'fleet.json'), traceFile = join(directory, 'traces.jsonl');
const stamp = existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')).plan.runId.split('-').at(-1) : Date.now().toString(36);
const plan = { runId: `docker-smoke-${stamp}`, app: `factory-docker-${stamp}`, workerProgram: program, machines, agentsPerMachine,
  cpus: 1, memoryMb: 2048, supervision: 'operator', reasoningEffort: 'low', ...provider,
  goal: 'Acceptance check of a FACTORY fleet on local Docker. Wait for operator messages.' };
const agents = agentInventory(plan).map(agent => agent.id);
const fleet = new FactoryDockerLiteFleet({ directory, auth, onEvent: event => events.push({ type: event.type, key: event.body?.key }) });
const label = `label=factory.docker.app=${plan.app}`;
const inspectAll = async () => { const ids = lines(await docker(['ps', '--all', '--no-trunc', '--filter', label, '--format', '{{.ID}}'])); return ids.length ? JSON.parse(await docker(['inspect', ...ids])) : []; };
const traces = () => existsSync(traceFile) ? lines(readFileSync(traceFile, 'utf8')).map(line => JSON.parse(line)) : [];
const lastTrace = () => traces().at(-1)?.seq ?? 0;

/**
 * Waits until, after trace number `after`, every machine has reported ready and every agent has
 * enrolled on the board. The board keeps earlier sessions, so only fresh trace records prove a start.
 */
async function settled(after, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await fleet.observe(); } catch { /* The board is not up yet while a machine sets itself up. */ }
    const fresh = traces().filter(event => event.seq > after);
    const ready = fresh.filter(event => event.kind === 'machine.ready');
    const threads = Object.fromEntries(fresh.filter(event => event.kind === 'agent.enrolled').map(event => [event.body.agentId, event.body.threadId]));
    if (new Set(ready.map(event => event.body.machine)).size === machines && agents.every(id => threads[id])) return { fresh, ready, threads };
    if (Date.now() >= deadline) throw new Error('Agents did not all enrol in time; see `docker logs` of the fleet containers.');
    await sleep(5000);
  }
}
/** After a restart on the same volume an agent resumes its session, or reports the kept session it could not resume. */
function continued(fresh, previous) {
  return Object.fromEntries(agents.map(id => {
    const resumed = fresh.some(event => event.source === id && event.kind === 'native.thread.resumed' && event.body.threadId === previous[id]);
    const kept = fresh.some(event => event.source === id && event.kind === 'agent.session_unavailable' && event.body.previousThreadId === previous[id]);
    assert.equal(resumed || kept, true, `${id} did not find its earlier session on its volume`);
    return [id, resumed ? 'resumed' : 'kept-but-empty'];
  }));
}

let failure = null;
try {
  const deployed = await fleet.deploy(plan, { image, ...(providerKey ? { providerKey } : {}) });
  assert.equal(deployed.machines.length, machines);
  check('deploy: one container per machine', { machines: deployed.machines.map(machine => ({ id: machine.id, name: machine.name, volumeId: machine.volumeId })) });

  const before = await inspectAll();
  assert.equal(before.length, machines);
  const published = before.flatMap(value => Object.entries(value.HostConfig.PortBindings ?? {}).flatMap(([port, bindings]) => bindings.map(binding => ({ name: value.Name, port, host: binding.HostIp }))));
  assert.deepEqual(published.map(entry => [entry.name, entry.host]), [[`/factory-${plan.runId}-m0`, '127.0.0.1']]);
  check('network: only the board of the first machine is published, on loopback only', { published });

  // No login token, board credential or operator token may be visible to `docker inspect`.
  const { credentials, operatorToken } = JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf8'));
  const staged = Object.values(JSON.parse(readFileSync(join(directory, 'docker-secrets.json'), 'utf8'))[plan.app]);
  const secrets = [operatorToken, ...Object.values(credentials), ...staged, auth?.read().accessToken ?? providerKey];
  assert.equal(secrets.some(secret => JSON.stringify(before).includes(secret)), false);
  check('secrets: none in container settings', { checkedSecrets: secrets.length });

  const first = await settled(0);
  check('board: every agent on every machine enrolled through the shared board', { threads: first.threads,
    machinesReady: first.ready.map(event => ({ machine: event.body.machine, node: event.body.node, [program]: String(event.body[program]).trim() })) });

  // One real model turn: the last agent of the last machine is told to record a claim on the shared board.
  const turnAgent = `m${machines - 1}-a${agentsPerMachine - 1}`;
  async function claimTurn(name) {
    const resource = `task:docker-smoke-${stamp}-${name}`, after = lastTrace();
    await fleet.command(turnAgent, { id: `smoke-${stamp}-${name}`, message: `Call the FACTORY board tool factory_claim once with resource "${resource}". Then answer with the single word DONE. Do nothing else.` });
    const deadline = Date.now() + 600000; let claim, completed;
    while (!claim || !completed) {
      claim = (await fleet.observe()).claims.find(value => value.resource === resource);
      completed = traces().find(event => event.seq > after && event.source === turnAgent && event.kind === 'native.turn.completed');
      if (Date.now() >= deadline) throw new Error('The agent did not record its claim and finish its turn in time.');
      if (!claim || !completed) await sleep(5000);
    }
    assert.equal(claim.owner, turnAgent); assert.equal(claim.machine, `m${machines - 1}`); assert.equal(completed.body.turn.status, 'completed');
    return { agent: turnAgent, turn: completed.body.turn.status, claim: { resource: claim.resource, owner: claim.owner, machine: claim.machine, status: claim.status } };
  }
  if (flags['--turn']) check('real turn: an agent on the last machine recorded a claim on the shared board', await claimTurn('first'));

  if (!flags['--quick']) {
    let mark = lastTrace();
    await fleet.stop();
    assert.equal((await inspectAll()).every(value => value.State.Status === 'exited'), true);
    check('stop: every container stopped', { exitCodes: (await inspectAll()).map(value => value.State.ExitCode) });
    const identities = (await inspectAll()).map(value => value.Id).sort();
    await fleet.start({ attempt: `smoke-${stamp}` });
    const second = await settled(mark);
    assert.deepEqual((await inspectAll()).map(value => value.Id).sort(), identities);
    const afterStart = continued(second.fresh, first.threads);
    if (flags['--turn']) assert.equal(afterStart[turnAgent], 'resumed');
    check('start: the same containers came back and every agent found its earlier session', { sessions: afterStart });
    if (flags['--turn']) check('real turn after the restart: the resumed agent took a new message and recorded a second claim', await claimTurn('restarted'));

    mark = lastTrace();
    const updated = await fleet.updateRuntime({ bundlePath: join(directory, 'factory-sdk.tgz') });
    const replaced = await inspectAll();
    assert.equal(replaced.length, machines); assert.equal(updated.updated, machines);
    assert.equal(replaced.some(value => identities.includes(value.Id)), false);
    assert.equal(replaced.every(value => value.Config.Labels['factory.bundle'] === updated.digest), true);
    const third = await settled(mark);
    const afterUpdate = continued(third.fresh, second.threads);
    if (flags['--turn']) assert.equal(afterUpdate[turnAgent], 'resumed');
    check('runtime update: new containers on the same volumes, every agent found its earlier session', { digest: updated.digest, sessions: afterUpdate });

    const collected = await fleet.collect({ attempt: `smoke-${stamp}`.slice(0, 32) });
    assert.equal(collected.complete, true);
    const artifacts = fleet.snapshot().artifacts.map(receipt => {
      assert.equal(createHash('sha256').update(readFileSync(receipt.file)).digest('hex'), receipt.sha256);
      return { machineId: receipt.machineId, bytes: statSync(receipt.file).size, sha256: receipt.sha256 };
    });
    check('collect: one verified archive per machine', { artifacts });
  }

  if (!flags['--keep']) {
    await fleet.retire();
    assert.equal((await inspectAll()).length, 0);
    assert.equal(lines(await docker(['volume', 'ls', '--filter', label, '--format', '{{.Name}}'])).length, 0);
    assert.equal(lines(await docker(['network', 'ls', '--filter', label, '--format', '{{.Name}}'])).length, 0);
    assert.equal(JSON.parse(readFileSync(join(directory, 'docker-secrets.json'), 'utf8'))[plan.app], undefined);
    check('retire: containers, volumes, network and staged secrets are gone');
  }
} catch (error) {
  failure = error.message; console.error(`FAIL ${failure}`); process.exitCode = 1;
} finally {
  await fleet.disconnect().catch(() => {});
  const info = JSON.parse(await docker(['version', '--format', '{{json .}}']).catch(() => '{}'));
  writeFileSync(evidenceFile, JSON.stringify({ format: 'factory-docker-fleet-acceptance', schemaVersion: 1, accepted: failure === null, failure,
    plan: { runId: plan.runId, app: plan.app, workerProgram: program, machines, agentsPerMachine, cpus: plan.cpus, memoryMb: plan.memoryMb, supervision: plan.supervision },
    image, realModelTurn: Boolean(flags['--turn']), quick: Boolean(flags['--quick']),
    host: { platform: process.platform, node: process.version, dockerServer: info.Server?.Version, dockerClient: info.Client?.Version },
    checks, providerOperations: events.filter(event => event.type === 'provider.succeeded').map(event => event.key),
    durationMs: Date.now() - started, completedAt: new Date().toISOString(),
    scope: 'Real local Docker containers, volumes and network, the real worker program and the real shared board. No Fly resource. A model is called only when realModelTurn is true; otherwise agents enrol and wait.' }, null, 2));
}

#!/usr/bin/env node
/**
 * A real lite fleet on local Docker, start to finish: containers, shared board, a stop and a start,
 * a runtime update, collection and removal. It makes no model call unless --turn or --teams is given.
 *
 *   node scripts/docker-fleet-smoke.mjs --directory <absolute folder> --evidence <absolute file>
 *     [--program codex|claude|flujo] [--codex-auth <auth.json>] [--claude-token <file>]
 *     [--model-url <http(s) address ending in /v1> --model <name> [--model-api responses|chat|anthropic] [--context <tokens>]]
 *     [--machines 2] [--agents 2] [--cpus 1] [--memory 2048] [--image <name>] [--prebuild]
 *     [--turn] [--reply] [--teams] [--quick] [--keep]
 *
 * --turn      one agent on the last machine gets a short message and must record a claim on the shared
 *             board; after the restart it gets a second one.
 * --reply     one agent gets a short message and only has to answer: for a model too small to use tools.
 * --teams     every agent takes one real turn, two machines at a time: each worker records a claim and
 *             messages its lead, then each lead reads its inbox and records how many messages it found.
 * --model-url the workers use this model server instead of a subscription login. For a server on this
 *             computer use http://host.docker.internal:<port>/v1. Its key is read from LOCAL_MODEL_KEY.
 * --prebuild  the set-up runs once, in an image, instead of in every container.
 * --quick     stops after the turns (or after enrolment) and removes the fleet.
 * FLUJO workers need a model server; without --model-url they get a placeholder and may only enrol.
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
  if (['--turn', '--reply', '--teams', '--keep', '--quick', '--prebuild'].includes(name)) flags[name] = true;
  else flags[name] = process.argv[++index];
}
const directory = flags['--directory'], evidenceFile = flags['--evidence'];
if (!isAbsolute(directory ?? '') || !isAbsolute(evidenceFile ?? '')) throw new Error('Select an absolute --directory and an absolute --evidence file.');
const program = flags['--program'] ?? 'codex';
const machines = Number(flags['--machines'] ?? 2), agentsPerMachine = Number(flags['--agents'] ?? 2);
const image = flags['--image'] ?? DOCKER_WORKER_IMAGE;
const modelUrl = flags['--model-url'], model = flags['--model'];
if (modelUrl && !model) throw new Error('Name the served model with --model.');
const realTurns = Boolean(flags['--turn'] || flags['--reply'] || flags['--teams']);
if (program === 'flujo' && realTurns && !modelUrl) throw new Error('A FLUJO turn needs a real model server; give one with --model-url.');
const placeholder = program === 'flujo' && !modelUrl;
const auth = modelUrl || program === 'flujo' ? undefined : program === 'claude' ? new ClaudeSubscriptionBroker({ tokenFile: flags['--claude-token'] })
  : new CodexSubscriptionBroker({ authFile: flags['--codex-auth'] ?? join(homedir(), '.codex', 'auth.json') });
const api = flags['--model-api'] ?? { codex: 'responses', claude: 'anthropic', flujo: 'chat' }[program];
const provider = modelUrl ? { model, subagentModel: model, modelProvider: { id: 'local', envKey: 'LOCAL_MODEL_KEY', baseUrls: [modelUrl], apis: [api], model,
    ...(flags['--context'] ? { contextWindow: Number(flags['--context']) } : {}) } }
  : placeholder ? { modelProvider: { id: 'acceptance', envKey: 'ACCEPTANCE_MODEL_KEY', baseUrls: ['https://model.invalid/v1'], apis: ['chat'], model: 'acceptance-model' } } : {};
const providerKey = modelUrl ? process.env.LOCAL_MODEL_KEY ?? 'local-model-key' : placeholder ? 'acceptance-placeholder-key' : undefined;

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
  cpus: Number(flags['--cpus'] ?? 1), memoryMb: Number(flags['--memory'] ?? 2048), supervision: 'operator', monitorIntervalMs: 4000, reasoningEffort: 'low', ...provider,
  goal: 'Acceptance check of a FACTORY fleet on local Docker. Wait for operator messages.' };
const agents = agentInventory(plan);
const fleet = new FactoryDockerLiteFleet({ directory, auth, onEvent: event => events.push({ type: event.type, key: event.body?.key, atMs: Date.now() - started }) });
const label = `label=factory.docker.app=${plan.app}`;
const inspectAll = async () => { const ids = lines(await docker(['ps', '--all', '--no-trunc', '--filter', label, '--format', '{{.ID}}'])); return ids.length ? JSON.parse(await docker(['inspect', ...ids])) : []; };
const traces = () => existsSync(traceFile) ? lines(readFileSync(traceFile, 'utf8')).map(line => JSON.parse(line)) : [];
const lastTrace = () => traces().at(-1)?.seq ?? 0;

/**
 * Waits until, after trace number `after`, every machine has reported ready and every agent has
 * enrolled on the board. The board keeps earlier sessions, so only fresh trace records prove a start.
 */
async function settled(after, timeoutMs = 1200000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await fleet.observe({ maxPages: 25 }); } catch { /* The board is not up yet while a machine sets itself up. */ }
    const fresh = traces().filter(event => event.seq > after);
    const ready = fresh.filter(event => event.kind === 'machine.ready');
    const threads = Object.fromEntries(fresh.filter(event => event.kind === 'agent.enrolled').map(event => [event.body.agentId, event.body.threadId]));
    if (new Set(ready.map(event => event.body.machine)).size === machines && agents.every(agent => threads[agent.id])) return { fresh, ready, threads };
    if (Date.now() >= deadline) throw new Error('Agents did not all enrol in time; see `docker logs` of the fleet containers.');
    await sleep(3000);
  }
}
/** After a restart on the same volume an agent resumes its session. A session that never ran a turn has no history to resume: the agent names it and opens a new one. */
function continued(fresh, previous) {
  return Object.fromEntries(agents.map(({ id }) => {
    const resumed = fresh.some(event => event.source === id && event.kind === 'native.thread.resumed' && event.body.threadId === previous[id]);
    const kept = fresh.some(event => event.source === id && event.kind === 'agent.session_unavailable' && event.body.previousThreadId === previous[id]);
    assert.equal(resumed || kept, true, `${id} did not find its earlier session on its volume`);
    return [id, resumed ? 'resumed' : 'no-history-new-session'];
  }));
}
/** Sends each listed agent one message and waits until each has recorded the claim it was asked for and ended its turn. */
async function claims(jobs, timeoutMs = 900000) {
  const after = lastTrace(), deadline = Date.now() + timeoutMs, done = new Map();
  for (const job of jobs) await fleet.command(job.agent, { id: job.id, message: job.message });
  while (done.size < jobs.length) {
    const status = await fleet.observe({ maxPages: 25 }), fresh = traces().filter(event => event.seq > after);
    for (const job of jobs) {
      const claim = status.claims.find(value => value.owner === job.agent && job.matches(value.resource));
      const ended = fresh.find(event => event.source === job.agent && event.kind === 'native.turn.completed');
      if (claim && ended && !done.has(job.agent)) done.set(job.agent, { agent: job.agent, turn: ended.body.turn.status, resource: claim.resource, machine: claim.machine });
    }
    if (done.size < jobs.length && Date.now() >= deadline) throw new Error(`These agents did not record their claim and end their turn in time: ${jobs.filter(job => !done.has(job.agent)).map(job => job.agent).join(', ')}.`);
    if (done.size < jobs.length) await sleep(3000);
  }
  return [...done.values()];
}
const claimJob = (agent, name) => { const resource = `task:docker-smoke-${stamp}-${name}`; return { agent, id: `smoke-${stamp}-${name}`, matches: value => value === resource,
  message: `Call the FACTORY board tool factory_claim once with resource "${resource}". Then answer with the single word DONE. Do nothing else.` }; };

let failure = null;
try {
  const deployed = await fleet.deploy(plan, { image, ...(providerKey ? { providerKey } : {}), ...(flags['--prebuild'] ? { prebuild: true } : {}) });
  assert.equal(deployed.machines.length, machines);
  const built = events.find(event => event.type === 'image.ready');
  check('deploy: one container per machine', { image: deployed.image, ...(built ? { imageReadyAtMs: built.atMs } : {}),
    machines: deployed.machines.map(machine => ({ id: machine.id, name: machine.name, volumeId: machine.volumeId })) });

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
  check('board: every agent on every machine enrolled through the shared board', { agents: agents.length,
    machinesReady: first.ready.map(event => ({ machine: event.body.machine, node: event.body.node, [program]: String(event.body[program]).trim() })) });

  const turnAgent = `m${machines - 1}-a${agentsPerMachine - 1}`;
  if (flags['--turn']) check('real turn: an agent on the last machine recorded a claim on the shared board', (await claims([claimJob(turnAgent, 'first')]))[0]);

  if (flags['--reply']) {
    // For a model too small to use tools: it only has to answer, which shows the whole path to the model server.
    const after = lastTrace(), deadline = Date.now() + 600000; let ended, reply;
    await fleet.command(turnAgent, { id: `smoke-${stamp}-reply`, message: 'Say hello in one short sentence.' });
    while (!ended) {
      await fleet.observe({ maxPages: 25 });
      const fresh = traces().filter(event => event.seq > after && event.source === turnAgent);
      ended = fresh.find(event => event.kind === 'native.turn.completed');
      reply = fresh.filter(event => event.kind === 'item/completed' && event.body.item?.type === 'agentMessage').map(event => event.body.item.text).join(' ');
      if (!ended && Date.now() >= deadline) throw new Error('The agent did not end its turn in time.');
      if (!ended) await sleep(3000);
    }
    assert.equal(ended.body.turn.status, 'completed'); assert.ok(reply.trim().length > 0, 'the model sent no text');
    check('real turn: an agent on the last machine got an answer from the model server', { agent: turnAgent, turn: ended.body.turn.status, replyCharacters: reply.length, replyStart: reply.trim().slice(0, 80) });
  }

  if (flags['--teams']) {
    // Workers first, two machines at a time, so one subscription is not asked for a hundred turns at once.
    const workers = agents.filter(agent => agent.role === 'subagent'), leads = agents.filter(agent => agent.role === 'orchestrator');
    const waves = [];
    for (let index = 0; index < machines; index += 2) {
      const wave = workers.filter(agent => [`m${index}`, `m${index + 1}`].includes(agent.machine)), from = Date.now();
      const result = await claims(wave.map(agent => { const resource = `task:docker-smoke-${stamp}-${agent.id}`; return { agent: agent.id, id: `smoke-${stamp}-${agent.id}`, matches: value => value === resource,
        message: `Do exactly two things with the FACTORY board tools. First call factory_claim with resource "${resource}". Then call factory_message with recipient "${agent.parentId}", messageId "${stamp}-${agent.id}" and message {"done":"${agent.id}"}. Then answer with the single word DONE.` }; }));
      assert.equal(result.every(entry => entry.turn === 'completed'), true);
      waves.push({ machines: [...new Set(wave.map(agent => agent.machine))], agents: wave.length, seconds: Math.round((Date.now() - from) / 1000) });
    }
    check('teams: every worker took a real turn, recorded its own claim and messaged its lead', { workers: workers.length, waves });
    const prefix = agent => `task:docker-smoke-${stamp}-${agent.id}-inbox-`;
    const reports = await claims(leads.map(agent => ({ agent: agent.id, id: `smoke-${stamp}-${agent.id}`, matches: value => value.startsWith(prefix(agent)),
      message: `Call the FACTORY board tool factory_inbox once and count the messages it returns. Then call factory_claim with resource "${prefix(agent)}N", where N is that count as a number. Then answer with the single word DONE.` })));
    const counted = Object.fromEntries(reports.map(entry => [entry.agent, entry.resource.split('-inbox-')[1]]));
    assert.equal(Object.values(counted).every(count => count === String(agentsPerMachine - 1)), true, `Leads counted ${JSON.stringify(counted)}`);
    const all = (await fleet.observe({ maxPages: 25 })).claims.filter(claim => claim.resource.startsWith(`task:docker-smoke-${stamp}-`));
    assert.equal(all.length, agents.length); assert.equal(all.every(claim => claim.machine === claim.owner.split('-')[0]), true);
    check('teams: every lead read its inbox and found one message from each of its workers', { leads: leads.length, messagesFound: counted, claims: all.length });
    const usage = lines(await docker(['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'])).filter(line => line.includes(plan.runId));
    check('teams: memory in use per container after the turns', { containers: usage });
  }

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
    if (flags['--turn']) check('real turn after the restart: the resumed agent took a new message and recorded a second claim', (await claims([claimJob(turnAgent, 'restarted')]))[0]);

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
  writeFileSync(evidenceFile, JSON.stringify({ format: 'factory-docker-fleet-acceptance', schemaVersion: 2, accepted: failure === null, failure,
    plan: { runId: plan.runId, app: plan.app, workerProgram: program, machines, agentsPerMachine, cpus: plan.cpus, memoryMb: plan.memoryMb, supervision: plan.supervision },
    image, prebuild: Boolean(flags['--prebuild']), login: modelUrl ? 'model server' : placeholder ? 'placeholder' : 'subscription',
    ...(modelUrl ? { modelServer: { address: modelUrl, model, api } } : {}),
    realModelTurns: (flags['--teams'] ? agents.length : 0) + (flags['--turn'] ? (flags['--quick'] ? 1 : 2) : 0) + (flags['--reply'] ? 1 : 0), quick: Boolean(flags['--quick']),
    host: { platform: process.platform, node: process.version, dockerServer: info.Server?.Version, dockerClient: info.Client?.Version },
    checks, providerOperations: events.filter(event => event.type === 'provider.succeeded').map(event => event.key),
    durationMs: Date.now() - started, completedAt: new Date().toISOString(),
    scope: 'Real local Docker containers, volumes and network, the real worker program and the real shared board. No Fly resource. A model is called only for the turns counted in realModelTurns; otherwise agents enrol and wait.' }, null, 2));
}

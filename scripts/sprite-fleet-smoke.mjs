#!/usr/bin/env node
/**
 * A real lite fleet on Fly.io Sprites, start to finish: one Sprite per machine, the shared board on the first
 * Sprite's public address, every agent enrolled through it, the Sprites kept awake while the workers run, a stop
 * that lets them sleep, a start, and removal. No model is called unless --turn is given, which needs a real
 * --claude-token; without one the agents get a placeholder login and only enrol (supervision is 'operator').
 *
 *   node scripts/sprite-fleet-smoke.mjs --directory <absolute folder> --evidence <absolute file> --sprites-token <file>
 *     [--app <name>] [--machines 2] [--agents 2] [--claude-token <file>] [--turn] [--idle-seconds 90] [--keep]
 *
 * --app           the fleet's name; its Sprites are <app>-m0, <app>-m1, ... A token limited to a name prefix needs an app
 *                 name that starts with that prefix.
 * --idle-seconds  how long nothing on this computer talks to the fleet before the check that every Sprite is still awake.
 * --keep          leaves the fleet running at the end instead of removing it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { FactorySpriteLiteFleet, ClaudeSubscriptionBroker, SPRITES_API, agentInventory } from '../src/public-sdk.mjs';

const flags = {};
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (['--turn', '--keep'].includes(name)) flags[name] = true;
  else flags[name] = process.argv[++index];
}
const directory = flags['--directory'], evidenceFile = flags['--evidence'];
if (!isAbsolute(directory ?? '') || !isAbsolute(evidenceFile ?? '')) throw new Error('Select an absolute --directory and an absolute --evidence file.');
if (!flags['--sprites-token']) throw new Error('Give the Sprites token file with --sprites-token.');
if (flags['--turn'] && !flags['--claude-token']) throw new Error('A real turn needs a Claude token file from `claude setup-token` (--claude-token).');
const machines = Number(flags['--machines'] ?? 2), agentsPerMachine = Number(flags['--agents'] ?? 2), idleSeconds = Number(flags['--idle-seconds'] ?? 90);
const spritesToken = readFileSync(flags['--sprites-token'], 'utf8').trim();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);
const started = Date.now();
const checks = [], events = [], measurements = {};
const check = (name, details = {}) => { checks.push({ name, atMs: Date.now() - started, ...details }); console.log(`ok   ${name}`); };

mkdirSync(directory, { recursive: true, mode: 0o700 });
const journal = join(directory, 'fleet.json'), traceFile = join(directory, 'traces.jsonl');
const stamp = existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')).plan.runId.split('-').at(-1) : Date.now().toString(36);
let tokenFile = flags['--claude-token'];
if (!tokenFile) {
  // A placeholder login: enough to start Claude Code and enrol, never used for a model call (agents wait for operator messages).
  tokenFile = join(directory, 'placeholder-claude-token');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, `placeholder-${stamp}-not-a-real-login-token`, { mode: 0o600 });
}
const plan = { runId: `sprite-smoke-${stamp}`, app: flags['--app'] ?? `factory-sprite-${stamp}`, workerProgram: 'claude', machines, agentsPerMachine,
  supervision: 'operator', monitorIntervalMs: 4000, reasoningEffort: 'low',
  goal: 'Acceptance check of a FACTORY fleet on Fly.io Sprites. Wait for operator messages.' };
const agents = agentInventory(plan);
const fleet = new FactorySpriteLiteFleet({ directory, token: spritesToken, auth: new ClaudeSubscriptionBroker({ tokenFile }),
  onEvent: event => events.push({ type: event.type, key: event.body?.key, atMs: Date.now() - started }) });
const traces = () => existsSync(traceFile) ? lines(readFileSync(traceFile, 'utf8')).map(line => JSON.parse(line)) : [];
const lastTrace = () => traces().at(-1)?.seq ?? 0;
const spriteNames = () => Array.from({ length: machines }, (_, index) => `${plan.app}-m${index}`);
async function spriteStatus(name) {
  const response = await fetch(`${SPRITES_API}/sprites/${name}`, { headers: { authorization: `Bearer ${spritesToken}` }, signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return 'absent';
  const body = await response.json(); return (body.data ?? body).status;
}
const onSprite = (id, command) => fleet.infrastructure.run(['machine', 'exec', id, command, '--app', plan.app, '--timeout', '60']);

/** Waits until, after trace number `after`, every machine has reported ready and every agent has enrolled on the board. */
async function settled(after, timeoutMs = 1500000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await fleet.observe({ maxPages: 25 }); } catch { /* The board is not up yet while a Sprite sets itself up. */ }
    const fresh = traces().filter(event => event.seq > after);
    const ready = fresh.filter(event => event.kind === 'machine.ready');
    const threads = Object.fromEntries(fresh.filter(event => event.kind === 'agent.enrolled').map(event => [event.body.agentId, event.body.threadId]));
    if (new Set(ready.map(event => event.body.machine)).size === machines && agents.every(agent => threads[agent.id])) return { fresh, ready, threads };
    if (Date.now() >= deadline) throw new Error('Agents did not all enrol in time; read /data/factory/bootstrap.log and /.sprite/logs/services/factory.log on the Sprites.');
    await sleep(5000);
  }
}
async function claim(agent, name, timeoutMs = 900000) {
  const resource = `task:sprite-smoke-${stamp}-${name}`, after = lastTrace(), deadline = Date.now() + timeoutMs;
  await fleet.command(agent, { id: `smoke-${stamp}-${name}`, message: `Call the FACTORY board tool factory_claim once with resource "${resource}". Then answer with the single word DONE. Do nothing else.` });
  for (;;) {
    const status = await fleet.observe({ maxPages: 25 });
    const found = status.claims.find(value => value.owner === agent && value.resource === resource);
    const ended = traces().find(event => event.seq > after && event.source === agent && event.kind === 'native.turn.completed');
    if (found && ended) return { agent, resource, machine: found.machine, turn: ended.body.turn.status };
    if (Date.now() >= deadline) throw new Error(`${agent} did not record its claim in time.`);
    await sleep(3000);
  }
}
async function measure(label) {
  const out = {};
  for (const id of spriteNames()) {
    const raw = await onSprite(id, `printf '{"usedMb":%s,"totalMb":%s,"load":"%s","processes":%s,"claude":%s,"tasks":%s}' "$(free -m | awk 'NR==2{print $3}')" "$(free -m | awk 'NR==2{print $2}')" "$(cut -d' ' -f1-3 /proc/loadavg)" "$(ps -e --no-headers | wc -l)" "$(pgrep -c -x claude || true)" "$(curl -s --unix-socket /.sprite/api.sock http://sprite/v1/tasks || echo null)"`);
    out[id] = JSON.parse(raw.trim().split('\n').findLast(line => line.startsWith('{')));
  }
  measurements[label] = out; return out;
}

let failure = null;
try {
  const deployed = await fleet.deploy(plan);
  assert.equal(deployed.machines.length, machines);
  check('deploy: one Sprite per machine, the worker as a Sprite service', { machines: deployed.machines.map(machine => ({ id: machine.id, name: machine.name })) });

  const first = await settled(0);
  check('board: every agent on every Sprite enrolled through the board on the first Sprite\'s public address', { agents: agents.length,
    machinesReady: first.ready.map(event => ({ machine: event.body.machine, node: event.body.node, claude: String(event.body.claude ?? '').trim() })) });
  const busy = await measure('enrolled');
  assert.equal(Object.values(busy).every(value => value.tasks?.tasks?.some(task => task.name === 'factory')), true, 'Every running Sprite should hold the keep-awake task.');
  check('keep-awake: every running Sprite holds its "factory" task', busy);

  // Nothing on this computer talks to the fleet for a while: a Sprite that is not held awake would pause after about 30 seconds.
  await fleet.disconnect();
  await sleep(idleSeconds * 1000);
  const awake = Object.fromEntries(await Promise.all(spriteNames().map(async name => [name, await spriteStatus(name)])));
  assert.equal(Object.values(awake).every(status => status === 'running'), true, `Sprites paused although their workers run: ${JSON.stringify(awake)}`);
  check(`keep-awake: every Sprite was still running after ${idleSeconds} s without any connection`, { status: awake });

  if (flags['--turn']) check('real turn: an agent on the last Sprite recorded a claim on the shared board', await claim(`m${machines - 1}-a${agentsPerMachine - 1}`, 'first'));

  await fleet.stop();
  // A stopped worker gives its task back; with nothing else running the Sprites pause.
  await sleep(90000);
  const resting = Object.fromEntries(await Promise.all(spriteNames().map(async name => [name, await spriteStatus(name)])));
  check('stop: the services stopped and the Sprites paused', { status: resting });

  const restartFrom = lastTrace();
  await fleet.start({ attempt: 'after-stop' });
  const again = await settled(restartFrom);
  check('start: the same Sprites woke, skipped their set-up and every agent enrolled again', { agents: Object.keys(again.threads).length,
    secondsToEnrol: Math.round((Date.now() - started - checks.at(-1).atMs) / 1000) });
  if (flags['--turn']) check('real turn after the restart', await claim(`m${machines - 1}-a${agentsPerMachine - 1}`, 'restarted'));

  if (!flags['--keep']) {
    await fleet.retire();
    const left = await Promise.all(spriteNames().map(spriteStatus));
    assert.equal(left.every(status => status === 'absent'), true);
    check('retire: every Sprite of the fleet was deleted');
  }
} catch (error) {
  failure = error.message;
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  await fleet.disconnect().catch(() => {});
  writeFileSync(evidenceFile, JSON.stringify({ observedAt: new Date().toISOString(), result: failure ? 'failed' : 'passed', failure,
    plan: { runId: plan.runId, app: plan.app, workerProgram: plan.workerProgram, machines, agentsPerMachine, supervision: plan.supervision },
    realModelTurns: flags['--turn'] ? 2 : 0, checks, measurements, durationMs: Date.now() - started,
    providerEvents: events.filter(event => /provider\.(succeeded|unknown)/.test(event.type)),
    command: 'node scripts/sprite-fleet-smoke.mjs --directory <folder> --evidence <file> --sprites-token <file> [--app <name>] [--machines N] [--agents N] [--claude-token <file> --turn]',
    scope: 'Real Fly.io Sprites, the real worker program (Claude Code) and the real shared board. A model is called only for the turns counted in realModelTurns; otherwise agents enrol and wait.' }, null, 2));
}

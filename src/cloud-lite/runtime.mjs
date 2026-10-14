import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freemem, totalmem, loadavg } from 'node:os';
import { CodexRpc } from './rpc.mjs';
import { startCloudLiteCoordinator } from './server.mjs';
import { CloudLiteTrace } from './trace.mjs';
import { NativeOperatorStop } from './operator-stop.mjs';
import { hash } from './protocol.mjs';

const threadStatuses = new Set(['active','idle','archived','notLoaded','systemError','notFound']);
const turnStatuses = new Set(['inProgress','completed','interrupted','failed']);

function nativeThreadStatus(value) { return threadStatuses.has(value) ? value : 'unknown'; }
function nativeTurnStatus(value) { return turnStatuses.has(value) ? value : 'unknown'; }
export function nativeStopTurn(turns, terminalTurns, threadId) {
  const id = turns.get(threadId) ?? terminalTurns.get(threadId)?.id;
  if (!id) return null;
  const terminal = terminalTurns.get(threadId);
  return { id, status: terminal?.id === id ? terminal.status : 'inProgress' };
}
export function isCurrentNativeTurn(turns, threadId, notificationTurnId) {
  const current = turns.get(threadId);
  return !notificationTurnId || !current || notificationTurnId === current;
}
export async function runCloudLiteMachine(config) {
  const { plan, index, credentials, operatorToken, initialAuth, githubToken } = config;
  mkdirSync('/data/factory', { recursive: true, mode: 0o700 });
  let coordinator;
  const boardPort = Number(process.env.FACTORY_BOARD_PORT ?? 4200);
  if (index === 0) coordinator = await startCloudLiteCoordinator({ database: '/data/factory/control.sqlite', plan, credentials, operatorToken, auth: initialAuth, githubToken, port: boardPort });
  const boardMachine = process.env.FACTORY_BOARD_MACHINE_ID;
  const boardUrl = index === 0 ? `http://127.0.0.1:${boardPort}` : boardMachine
    ? `http://${boardMachine}.vm.${plan.app}.internal:${boardPort}` : `https://${plan.app}.fly.dev`;
  const machine = `m${index}`; const rootId = `${machine}-a0`; const rootToken = credentials[rootId];
  const request = async (route, body, token = rootToken) => {
    // These control reads/checkpoints and stable-id commands are replay safe.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(boardUrl + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw Object.assign(new Error(`Coordinator ${route} returned ${response.status}.`), { status: response.status });
        return response.json();
      } catch (error) {
        if (attempt >= 4 || error.status && error.status < 500) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  };
  let bootstrap;
  for (;;) { try { bootstrap = await request('/bootstrap', {}); break; } catch { await new Promise(resolve => setTimeout(resolve, 3000)); } }
  const repositoryDirectory = '/data/repository';
  const gitEnv = { ...process.env, GH_TOKEN: githubToken, GIT_TERMINAL_PROMPT: '0' };
  const execute = promisify(execFile);
  const run = async (command, args, cwd) => {
    try { return (await execute(command, args, { cwd, env: gitEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout; }
    catch (error) { throw new Error(`${command} failed (${error.code}).`); }
  };
  if (!existsSync(join(repositoryDirectory, '.git'))) await run('git', ['clone', `https://github.com/${plan.repository}.git`, repositoryDirectory]);
  await run('git', ['config', 'user.name', 'FACTORY swarm'], repositoryDirectory);
  await run('git', ['config', 'user.email', 'flujo.com.co@gmail.com'], repositoryDirectory);
  await run('gh', ['auth', 'setup-git'], repositoryDirectory);
  const home = '/data/codex'; mkdirSync(home, { recursive: true, mode: 0o700 });
  // A fresh native harness has only the explicitly configured FACTORY MCP server.
  writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store="ephemeral"\nforced_login_method="chatgpt"\n', { mode: 0o600 });
  const traces = new Map();
  for (const agent of bootstrap.agents) {
    const position = await request('/trace-position', {}, agent.token);
    traces.set(agent.id, new CloudLiteTrace({ file: `/data/factory/${agent.id}.jsonl`, url: boardUrl, token: agent.token, remoteSequence: position.sequence,
      secrets: [githubToken, initialAuth.accessToken, operatorToken, ...Object.values(credentials)] }));
  }
  const rootTrace = traces.get(rootId); const threadAgents = new Map(); const states = new Map(); const turns = new Map(); const terminalTurns = new Map(); const inboxVersions = new Map(); const stoppedThreads = new Set(); const stoppingThreads = new Set(); const revokedStopCommands = new Set(); const pendingStopCommands = new Map(); const stopControllers = new Map(); const stopTasks = new Map(); let stopping = false; let stopPromise; let timer; let monitoring; let liveAuth = bootstrap.auth;
  const rpc = new CodexRpc({ env: { PATH: process.env.PATH, HOME: '/data', CODEX_HOME: home, GH_TOKEN: githubToken, GIT_TERMINAL_PROMPT: '0' }, cwd: repositoryDirectory,
    onStderr: text => rootTrace.record('codex.stderr', { text }),
    onRequest: async (method, params) => {
      if (method === 'account/chatgptAuthTokens/refresh') {
        const auth = await request('/auth', { refresh: true, previousTokenHash: hash(liveAuth.accessToken) });
        if (auth.chatgptAccountId !== initialAuth.chatgptAccountId) throw new Error('Subscription identity changed.');
        for (const trace of traces.values()) trace.secrets.push(auth.accessToken);
        liveAuth = auth;
        return auth;
      }
      throw new Error(`Unexpected Codex host request: ${method}`);
    } });
  rpc.on('notification', value => {
    const threadId = value.params?.threadId ?? value.params?.thread?.id;
    const agent = threadAgents.get(threadId) ?? rootId;
    traces.get(agent).record(value.method, value.params ?? {});
    if (value.method === 'thread/started' || value.method === 'thread/resumed'
      || value.method === 'thread/status/changed' && value.params?.status?.type === 'active') stopControllers.get(threadId)?.invalidateReceipts();
    const turn = value.params?.turn ?? {};
    const turnId = turn.id ?? turns.get(threadId);
    if (value.method === 'turn/started') {
      states.delete(threadId);
      terminalTurns.delete(threadId);
      turns.set(threadId, turnId);
      stopControllers.get(threadId)?.observeTurnStarted({ threadId, turnId });
      if (threadId) traces.get(agent).record('native.turn.started', { threadId, turn: { ...(turnId ? { id: turnId } : {}), status: 'inProgress' } });
    }
    if (value.method === 'turn/completed') {
      if (!isCurrentNativeTurn(turns, threadId, turnId)) return;
      const status = nativeTurnStatus(turn.status);
      terminalTurns.set(threadId, { id: turnId, status });
      states.set(threadId, { status: stoppedThreads.has(threadId) ? 'stopped' : status, completed: Date.now(), inboxVersion: inboxVersions.get(threadId) ?? 0 });
      if (threadId) {
        const errorCode = turn.error?.code;
        traces.get(agent).record('native.turn.completed', { threadId, turn: { ...(turnId ? { id: turnId } : {}), status,
          ...((status === 'failed' || status === 'interrupted')
            ? { error: { ...(Number.isSafeInteger(errorCode) && Math.abs(errorCode) <= 1000000 ? { code: errorCode } : {}) } } : {}) } });
      }
      stopControllers.get(threadId)?.observeTerminal({ threadId, turnId, status });
    }
  });
  rpc.on('exit', result => { rootTrace.record('codex.exit', result); void stop(); });
  timer = setInterval(async () => {
    for (const [id, trace] of traces) {
      try { await trace.flush(); } catch (error) { rootTrace.record('trace.delivery_pending', { agent: id, message: error.message }); }
    }
  }, 1000);
  await rpc.initialize();
  await rpc.request('account/login/start', { type: 'chatgptAuthTokens', ...bootstrap.auth });
  rootTrace.record('machine.ready', { machine, node: process.version, codex: await run('codex', ['--version']), configuration: { cpuKind: plan.cpuKind, cpus: plan.cpus, memoryMb: plan.memoryMb, diskGb: plan.diskGb }, agents: bootstrap.agents.map(x => ({ id: x.id, role: x.role })) });
  const proxy = fileURLToPath(new URL('../../bin/factory-cloud-mcp.mjs', import.meta.url));
  for (const agent of bootstrap.agents) {
    const directory = join('/data/worktrees', agent.id); mkdirSync('/data/worktrees', { recursive: true });
    if (!existsSync(directory)) await run('git', ['worktree', 'add', '--detach', directory, 'HEAD'], repositoryDirectory);
    const sessionFile = `/data/factory/${agent.id}.session.json`;
    const configOverride = { mcp_servers: { factory: { command: process.execPath, args: [proxy], env: { FACTORY_BOARD_URL: boardUrl, FACTORY_BOARD_TOKEN: agent.token, FACTORY_WORKTREE: directory }, required: true } },
      'features.apps': false, 'features.plugins': false, 'features.multi_agent': false,
      'model_reasoning_effort': plan.reasoningEffort };
    const instructions = `You are ${agent.id}, ${agent.role}, on machine ${machine}. Your orchestrator is ${rootId}. Team: ${bootstrap.agents.map(x => x.id).join(', ')}.\nUse FACTORY MCP identity/status/claim/message/inbox/checkpoint tools. Claim a stable pr:<number> or issue:<number> before work. One machine owns each item; coordinate within your machine rather than duplicate edits. Orchestrators talk to other orchestrators and their own subagents. Subagents may communicate only with agents on their own machine.\n${agent.role === 'orchestrator' ? 'Your configured subagents are already started by the SDK. Coordinate them through FACTORY messages, delegate useful implementation and independent reviews, and coordinate ownership with peer orchestrators.' : 'Receive assignments from your orchestrator, implement or review its claimed work, and report exact revision and validation results.'}\nRetain native Codex tools. Record progress, command/test evidence, failures and PR links on the board. Follow repository AGENTS.md and Moe’s existing validation rules: relevant local CI parity on both Windows and Linux before pushing/updating PRs or merging; CI on merge is paused. Use factory_validation_request for the exact revision when Windows validation cannot run on this Linux host. No invented features or duplicate work. Credentials must never enter Git, messages, traces or public artifacts.\nThe original user goal follows unchanged.`;
    let result; let recovering = existsSync(sessionFile); let unavailableSession;
    if (recovering) {
      const retained = JSON.parse(readFileSync(sessionFile));
      try {
        result = await rpc.request('thread/resume', { threadId: retained.threadId, cwd: directory, config: configOverride, approvalPolicy: 'never', sandbox: 'danger-full-access' });
      } catch (error) {
        if (error.code !== -32600 || error.message !== `no rollout found for thread id ${retained.threadId}`) throw error;
        unavailableSession = retained.threadId; recovering = false;
        const preserved = `${sessionFile}.${hash(readFileSync(sessionFile))}.unavailable`;
        try { copyFileSync(sessionFile, preserved, constants.COPYFILE_EXCL); } catch (copyError) { if (copyError.code !== 'EEXIST') throw copyError; }
        traces.get(agent.id).record('agent.session_unavailable', { previousThreadId: unavailableSession, preserved,
          reason: 'Upstream Codex confirmed that the prepared thread has no persisted rollout. Original board claims and repository state remain; reconcile before continuing.' });
      }
    }
    if (!result) {
      result = await rpc.request('thread/start', { model: agent.role === 'orchestrator' ? plan.model : plan.subagentModel, cwd: directory, approvalPolicy: 'never', sandbox: 'danger-full-access', config: configOverride,
        developerInstructions: instructions, serviceName: `factory.${plan.runId}.${agent.id}`, historyMode: 'legacy' });
      const fd = await open(sessionFile, 'w', 0o600);
      try { await fd.writeFile(JSON.stringify({ threadId: result.thread.id, agentId: agent.id })); await fd.sync(); } finally { await fd.close(); }
    }
    const threadId = result.thread.id; threadAgents.set(threadId, agent.id);
    stopControllers.set(threadId, new NativeOperatorStop({ rpc, threadId,
      getTurn: () => nativeStopTurn(turns, terminalTurns, threadId),
      trace: (kind, body) => traces.get(agent.id).record(kind, body), flush: () => traces.get(agent.id).flush() }));
    await request('/operator/session', { agent: agent.id, session: threadId }, operatorToken);
    traces.get(agent.id).record('agent.enrolled', { threadId, agentId: agent.id, machine, parentId: agent.id === rootId ? null : rootId });
    // Recovery observes existing live work; it never replays a retained running turn.
    const current = recovering ? await rpc.request('thread/read', { threadId, includeTurns: false }) : null;
    const observedThreadStatus = current?.thread?.status?.type ?? result.thread?.status?.type;
    const threadEvent = recovering ? 'thread.resumed' : 'thread.started';
    traces.get(agent.id).record('native.' + threadEvent, { threadId,
      ...(observedThreadStatus ? { threadStatus: nativeThreadStatus(observedThreadStatus) } : {}) });
    if (current?.thread.status?.type !== 'active') {
      const recoveryNote = unavailableSession ? `The prior prepared session ${unavailableSession} has no persisted rollout. Reconcile your existing FACTORY claims, inbox, checkout and GitHub state before continuing; do not replay previous delivery operations.\n` : '';
      const input = recoveryNote + (agent.role === 'orchestrator' ? plan.goal : `Work under ${rootId} toward this goal. Check inbox and shared ownership first:\n${plan.goal}`);
      await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: input }], effort: plan.reasoningEffort });
    }
  }
  let monitoringBusy = false;
  monitoring = setInterval(async () => {
    if (monitoringBusy) return; monitoringBusy = true;
    try {
    rootTrace.record('machine.health', { uptime: process.uptime(), freeMemory: freemem(), totalMemory: totalmem(), load: loadavg(), process: process.memoryUsage(),
      disk: (await run('df', ['-B1', '/data'])).trim(), processes: (await run('ps', ['-eo', 'pid,ppid,rss,pcpu,comm'])).trim() });
    for (const [threadId, agentId] of threadAgents) {
      const agent = bootstrap.agents.find(x => x.id === agentId);
      const incoming = await request('/commands', {}, agent.token);
      inboxVersions.set(threadId, incoming.inboxVersion ?? 0);
      for (const command of incoming.commands) {
        if (command.action === 'stop') {
          stoppingThreads.add(threadId);
          if (!stopTasks.has(command.id)) {
            const stopTask = (async () => {
              await stopControllers.get(threadId).stop(command.id, {
                expectedThreadId: command.expectedThreadId, expectedTurnId: command.expectedTurnId,
              });
              if (revokedStopCommands.has(command.id)) return;
              const acknowledgement = await request('/commands', { acknowledge: command.id }, agent.token);
              if (!acknowledgement.acknowledged) {
                revokedStopCommands.add(command.id);
                return;
              }
              stoppedThreads.add(threadId);
              states.set(threadId, { status: 'stopped', completed: Date.now(), inboxVersion: inboxVersions.get(threadId) ?? 0 });
              traces.get(agentId).record('supervisor.command', { id: command.id, action: 'stop' });
              await traces.get(agentId).flush();
            })().catch(() => {
              rootTrace.record('operator.stop.failed', { agent: agentId, commandId: command.id, category: 'native_stop_unconfirmed' });
              void rootTrace.flush().catch(() => {});
            }).finally(() => { if (pendingStopCommands.get(threadId) === command.id) pendingStopCommands.delete(threadId); });
            pendingStopCommands.set(threadId, command.id);
            stopTasks.set(command.id, stopTask);
          }
          continue;
        } else if (command.action === 'message') {
          const pendingStop = pendingStopCommands.get(threadId);
          if (pendingStop) revokedStopCommands.add(pendingStop);
          stopControllers.get(threadId)?.invalidateReceipts();
          stoppingThreads.delete(threadId);
          stoppedThreads.delete(threadId);
          const turnId = turns.get(threadId);
          const input = [{ type: 'text', text: command.message }];
          if (turnId && states.get(threadId)?.status !== 'completed') {
            try { await rpc.request('turn/steer', { threadId, expectedTurnId: turnId, input }); }
            catch (error) {
              if (error.message !== 'no active turn to steer') throw error;
              const current = await rpc.request('thread/read', { threadId, includeTurns: false });
              if (current.thread.status?.type === 'active') throw error;
              await rpc.request('turn/start', { threadId, input, effort: plan.reasoningEffort });
            }
          } else await rpc.request('turn/start', { threadId, input, effort: plan.reasoningEffort });
        }
        traces.get(agentId).record('supervisor.command', { id: command.id, action: command.action });
        await request('/commands', { acknowledge: command.id }, agent.token);
      }
    }
    for (const [threadId, state] of states) {
      const agentId = threadAgents.get(threadId);
      const newMail = (inboxVersions.get(threadId) ?? 0) > state.inboxVersion;
      const leaderFollowup = agentId === rootId && Date.now() - state.completed >= 120000;
      if (stopping || stoppingThreads.has(threadId) || state.status !== 'completed' || !newMail && !leaderFollowup) continue;
      states.delete(threadId);
      try { await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Continue the active goal. Check the FACTORY inbox and current claims, report useful progress and evidence, and take the next available action. Coordinate with your orchestrator and avoid duplicate work.' }], effort: plan.reasoningEffort }); }
      catch (error) { rootTrace.record('continuation.failed', { threadId, message: error.message }); }
    }
    } catch (error) { rootTrace.record('monitor.pending', { message: error.message }); }
    finally { monitoringBusy = false; }
  }, 15000);
  function stop() { return stopPromise ??= (async () => {
    stopping = true; clearInterval(timer); clearInterval(monitoring);
    for (const threadId of threadAgents.keys()) { try { const turnId = turns.get(threadId); if (turnId) await rpc.request('turn/interrupt', { threadId, turnId }, 10000); } catch { /* Retained native state remains authoritative. */ } }
    for (const trace of traces.values()) { try { await trace.flush(); } catch { /* Durable outboxes are retained on the volume. */ } }
    rpc.close(); await coordinator?.close();
  })(); }
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
  return { rpc, traces, stop, threadAgents };
}

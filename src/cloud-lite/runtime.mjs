import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, constants, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { freemem, totalmem, loadavg } from 'node:os';
import { CodexRpc } from './rpc.mjs';
import { startCloudLiteCoordinator } from './server.mjs';
import { CloudLiteTrace } from './trace.mjs';
import { hash } from './protocol.mjs';

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
  const run = (command, args, cwd) => { const p = spawnSync(command, args, { cwd, env: gitEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); if (p.status !== 0) throw new Error(`${command} failed (${p.status}).`); return p.stdout; };
  if (!existsSync(join(repositoryDirectory, '.git'))) run('git', ['clone', `https://github.com/${plan.repository}.git`, repositoryDirectory]);
  run('git', ['config', 'user.name', 'FACTORY swarm'], repositoryDirectory);
  run('git', ['config', 'user.email', 'flujo.com.co@gmail.com'], repositoryDirectory);
  run('gh', ['auth', 'setup-git'], repositoryDirectory);
  const home = '/data/codex'; mkdirSync(home, { recursive: true, mode: 0o700 });
  // A fresh native harness has only the explicitly configured FACTORY MCP server.
  writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store="ephemeral"\nforced_login_method="chatgpt"\n', { mode: 0o600 });
  const traces = new Map();
  for (const agent of bootstrap.agents) {
    const position = await request('/trace-position', {}, agent.token);
    traces.set(agent.id, new CloudLiteTrace({ file: `/data/factory/${agent.id}.jsonl`, url: boardUrl, token: agent.token, remoteSequence: position.sequence,
      secrets: [githubToken, initialAuth.accessToken, operatorToken, ...Object.values(credentials)] }));
  }
  const rootTrace = traces.get(rootId); const threadAgents = new Map(); const states = new Map(); const turns = new Map(); const inboxVersions = new Map(); let stopping = false; let stopPromise; let timer; let monitoring; let liveAuth = bootstrap.auth;
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
    if (value.method === 'turn/started') {
      states.delete(threadId);
      turns.set(threadId, value.params?.turn?.id);
      const actor = bootstrap.agents.find(x => x.id === agent);
      void request('/tool', { name: 'factory_checkpoint', arguments: { status: 'running' } }, actor.token).catch(() => {});
    }
    if (value.method === 'turn/completed') states.set(threadId, { status: value.params?.turn?.status, completed: Date.now(), inboxVersion: inboxVersions.get(threadId) ?? 0 });
  });
  rpc.on('exit', result => { rootTrace.record('codex.exit', result); void stop(); });
  timer = setInterval(async () => {
    for (const [id, trace] of traces) {
      try { await trace.flush(); } catch (error) { rootTrace.record('trace.delivery_pending', { agent: id, message: error.message }); }
    }
  }, 1000);
  await rpc.initialize();
  await rpc.request('account/login/start', { type: 'chatgptAuthTokens', ...bootstrap.auth });
  rootTrace.record('machine.ready', { machine, node: process.version, codex: run('codex', ['--version']), configuration: { cpuKind: plan.cpuKind, cpus: plan.cpus, memoryMb: plan.memoryMb, diskGb: plan.diskGb }, agents: bootstrap.agents.map(x => ({ id: x.id, role: x.role })) });
  const proxy = fileURLToPath(new URL('../../bin/factory-cloud-mcp.mjs', import.meta.url));
  for (const agent of bootstrap.agents) {
    const directory = join('/data/worktrees', agent.id); mkdirSync('/data/worktrees', { recursive: true });
    if (!existsSync(directory)) run('git', ['worktree', 'add', '--detach', directory, 'HEAD'], repositoryDirectory);
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
      const fd = openSync(sessionFile, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify({ threadId: result.thread.id, agentId: agent.id })); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const threadId = result.thread.id; threadAgents.set(threadId, agent.id);
    await request('/operator/session', { agent: agent.id, session: threadId }, operatorToken);
    await request('/tool', { name: 'factory_checkpoint', arguments: { status: 'ready' } }, agent.token);
    traces.get(agent.id).record('agent.enrolled', { threadId, agentId: agent.id, machine, parentId: agent.id === rootId ? null : rootId });
    // Recovery observes existing live work; it never replays a retained running turn.
    const current = recovering ? await rpc.request('thread/read', { threadId, includeTurns: false }) : null;
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
      disk: run('df', ['-B1', '/data']).trim(), processes: run('ps', ['-eo', 'pid,ppid,rss,pcpu,comm']).trim() });
    for (const [threadId, agentId] of threadAgents) {
      const agent = bootstrap.agents.find(x => x.id === agentId);
      const incoming = await request('/commands', {}, agent.token);
      inboxVersions.set(threadId, incoming.inboxVersion ?? 0);
      for (const command of incoming.commands) {
        if (command.action === 'stop') {
          const turnId = turns.get(threadId); if (turnId) { try { await rpc.request('turn/interrupt', { threadId, turnId }); } catch {} }
          states.set(threadId, { status: 'stopped', completed: Date.now() });
          await request('/tool', { name: 'factory_checkpoint', arguments: { status: 'stopped' } }, agent.token);
        } else if (command.action === 'message') {
          const turnId = turns.get(threadId);
          if (turnId && states.get(threadId)?.status !== 'completed') await rpc.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: command.message }] });
          else await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: command.message }] });
        }
        traces.get(agentId).record('supervisor.command', { id: command.id, action: command.action });
        await request('/commands', { acknowledge: command.id }, agent.token);
      }
    }
    for (const [threadId, state] of states) {
      const agentId = threadAgents.get(threadId);
      const newMail = (inboxVersions.get(threadId) ?? 0) > state.inboxVersion;
      const leaderFollowup = agentId === rootId && Date.now() - state.completed >= 120000;
      if (stopping || state.status !== 'completed' || !newMail && !leaderFollowup) continue;
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

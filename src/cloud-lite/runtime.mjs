import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { freemem, totalmem, loadavg } from 'node:os';
import { CodexRpc } from './rpc.mjs';
import { startCloudLiteCoordinator } from './server.mjs';
import { CloudLiteTrace } from './trace.mjs';
import { NativeOperatorStop } from './operator-stop.mjs';
import { NativeWorkflowWake } from './workflow-wake.mjs';
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
export async function finalizeNativeStopCommand({ prove, publish, flush, acknowledge, isRevoked, markStopped }) {
  await prove();
  if (isRevoked()) return false;
  publish();
  await flush();
  if (isRevoked()) return false;
  const result = await acknowledge();
  if (!result?.acknowledged || isRevoked()) return false;
  markStopped();
  return true;
}
export async function runCloudLiteMachine(config) {
  const { plan, index, credentials, operatorToken, initialAuth, githubToken, evidenceTokens } = config;
  mkdirSync('/data/factory', { recursive: true, mode: 0o700 });
  let coordinator, evidenceProcess, evidenceSealing=false, evidenceFinal=false, deadlineRequested=false, sealRequested=false;
  const stopIds=new Map();
  const boardPort = Number(process.env.FACTORY_BOARD_PORT ?? 4200);
  if (index === 0) coordinator = await startCloudLiteCoordinator({ database: '/data/factory/control.sqlite', plan, credentials, operatorToken, auth: initialAuth, githubToken, port: boardPort });
  const retainedEvidence=existsSync('/data/factory-evidence/state.json')?JSON.parse(readFileSync('/data/factory-evidence/state.json')):null;
  const sealedCheckpoint=retainedEvidence?.receipt?.checkpoint?.final?retainedEvidence.receipt.checkpoint:retainedEvidence?.pending?.final?retainedEvidence.pending:null;
  if(sealedCheckpoint){
    if(!retainedEvidence.receipt?.checkpoint.final){
      const child=fork(fileURLToPath(new URL('./evidence-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
      child.on('error',()=>{});
      child.send({action:'start',runId:plan.runId,machineId:`m${index}`,url:plan.collection.url,token:evidenceTokens?.[`m${index}`],intervalMs:plan.collection.intervalMs??60000,sessions:sealedCheckpoint.sessions});
      child.send({action:'finalize',sessions:sealedCheckpoint.sessions});
    }
    return {sealed:true,stop:async()=>coordinator?.close()};
  }
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
  if(bootstrap.sealRequested){
    const sessions=bootstrap.agents.map(agent=>{
      const native=agent.nativeRuntime,receipt=native?.operatorStopReceipt;
      if(!receipt || receipt.threadId!==native.threadId)throw new Error('Sealed run has incomplete native stop evidence.');
      return{agentId:agent.id,threadId:receipt.threadId,stopId:receipt.commandId};
    });
    const child=fork(fileURLToPath(new URL('./evidence-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});child.on('error',()=>{});
    child.send({action:'start',runId:plan.runId,machineId:machine,url:plan.collection.url,token:evidenceTokens?.[machine],intervalMs:plan.collection.intervalMs??60000,sessions});
    child.send({action:'finalize',sessions});return{sealed:true,stop:async()=>coordinator?.close()};
  }
  if(plan.shutdown && Date.now()>=Date.parse(plan.shutdown.deadlineUtc))throw new Error('Work deadline has passed; preserve existing evidence and reconcile shutdown without restarting agents.');
  const repositoryDirectory = plan.repository ? '/data/repository' : '/data/workspace';
  if(!plan.repository)mkdirSync(repositoryDirectory,{recursive:true,mode:0o700});
  const gitEnv = { ...process.env, GH_TOKEN: githubToken, GIT_TERMINAL_PROMPT: '0' };
  const execute = promisify(execFile);
  const run = async (command, args, cwd) => {
    try { return (await execute(command, args, { cwd, env: gitEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout; }
    catch (error) { throw new Error(`${command} failed (${error.code}).`); }
  };
  if (plan.repository && !existsSync(join(repositoryDirectory, '.git'))) await run('git', ['clone', `https://github.com/${plan.repository}.git`, repositoryDirectory]);
  if (plan.repositoryRevision) {
    await run('git', ['fetch', 'origin', plan.repositoryRevision], repositoryDirectory);
    const pinned = (await run('git', ['rev-parse', `${plan.repositoryRevision}^{commit}`], repositoryDirectory)).trim();
    if (pinned !== plan.repositoryRevision) throw new Error('Repository snapshot identity mismatch.');
  }
  if(plan.repository){
    await run('git', ['config', 'user.name', 'FACTORY swarm'], repositoryDirectory);
    await run('git', ['config', 'user.email', 'flujo.com.co@gmail.com'], repositoryDirectory);
    await run('gh', ['auth', 'setup-git'], repositoryDirectory);
  }
  const home = '/data/codex'; mkdirSync(home, { recursive: true, mode: 0o700 });
  // A fresh native harness has only the explicitly configured FACTORY MCP server.
  writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store="ephemeral"\nforced_login_method="chatgpt"\n', { mode: 0o600 });
  const traces = new Map();
  const workflowWakes = new Map();
  for (const agent of bootstrap.agents) {
    const position = await request('/trace-position', {}, agent.token);
    traces.set(agent.id, new CloudLiteTrace({ file: `/data/factory/${agent.id}.jsonl`, url: boardUrl, token: agent.token, remoteSequence: position.sequence,
      secrets: [githubToken, initialAuth.accessToken, operatorToken, ...Object.values(credentials),...Object.values(evidenceTokens??{})] }));
  }
  const rootTrace = traces.get(rootId); const threadAgents = new Map(); const states = new Map(); const turns = new Map(); const terminalTurns = new Map(); const inboxVersions = new Map(); const workflowVersions = new Map(); const consumedVersions = new Map(); const stoppedThreads = new Set(); const stoppingThreads = new Set(); const revokedStopCommands = new Set(); const pendingStopCommands = new Map(); const stopControllers = new Map(); const stopTasks = new Map(); let stopping = false; let stopPromise; let timer; let monitoring; let liveAuth = bootstrap.auth;
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
      if (plan.workflow) consumedVersions.set(threadId, { inboxVersion: inboxVersions.get(threadId) ?? 0, workflowVersion: workflowVersions.get(threadId) ?? 0 });
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
      states.set(threadId, { status: stoppedThreads.has(threadId) ? 'stopped' : status, completed: Date.now(), inboxVersion: inboxVersions.get(threadId) ?? 0,
        ...(plan.workflow ? consumedVersions.get(threadId) ?? { inboxVersion: 0, workflowVersion: 0 } : {}) });
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
    if (!existsSync(directory)) {
      if(plan.repository)await run('git', ['worktree', 'add', '--detach', directory, plan.repositoryRevision ?? 'HEAD'], repositoryDirectory);
      else mkdirSync(directory,{recursive:true,mode:0o700});
    }
    const sessionFile = `/data/factory/${agent.id}.session.json`;
    const configOverride = { mcp_servers: { factory: { command: process.execPath, args: [proxy], env: { FACTORY_BOARD_URL: boardUrl, FACTORY_BOARD_TOKEN: agent.token, FACTORY_WORKTREE: directory }, required: true } },
      'features.apps': false, 'features.plugins': false, 'features.multi_agent': false,
      'model_reasoning_effort': plan.reasoningEffort };
    const instructions = `You are ${agent.id}, ${agent.role}, on machine ${machine}. Your orchestrator is ${rootId}. Team: ${bootstrap.agents.map(x => x.id).join(', ')}.\nUse FACTORY identity/status/claim/message/inbox/checkpoint tools. Claim a stable task:<name> before work (issue:/pr: are available for repository work). One team owns each item. Orchestrators coordinate across teams; workers communicate within their team.\n${agent.role === 'orchestrator' ? 'Actively decompose and complete the original goal. Delegate useful work, resolve dependencies, and integrate the outputs into one coherent final deliverable. Keep unmet acceptance requirements open.' : 'Produce or independently review your assigned deliverable and report evidence and remaining requirements.'}\nRetain native tools. Respect task-specific instructions and validation/publication policy. Work can be research, analysis, documents, data, operations or software; do not invent a repository or software checks for unrelated tasks. Save deliverables under your workspace or /data/results. Record progress and evidence. Credentials must never enter deliverables, messages or traces.\nThe original user goal follows unchanged.`;
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
    if(plan.workflow)workflowWakes.set(threadId,new NativeWorkflowWake({rpc,threadId,file:`/data/factory/${agent.id}.${threadId}.wake.json`,effort:plan.reasoningEffort,onEvent:body=>traces.get(agent.id).record('workflow.wake.pending',body)}));
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
      const workflowNote = plan.workflow ? `\nYour team has exactly one independent reviewer: ${machine}-a${plan.agentsPerMachine-1}. Other workers produce deliverables. Orchestrators use factory_assign to retain the original goal/acceptance as a parent task and delegate child tasks; the SDK selects your reviewer. Choose task-appropriate executable gates or explicitly explain a review-only policy when objective checks do not apply. The orchestrator integrates accepted child outputs and submits the parent deliverable. Use factory_submit_workspace with selected relative paths, a stable submissionId and a summary; the SDK freezes files, transfers chunks and renews the claim. No Git metadata is required. Reviewers inspect the frozen packet and artifacts, then use factory_review; never edit the candidate or approve their own work. Semantic review, executable checks and delivery permission are separate. Revise rejected candidates. Continue useful unblocked work while checks are unavailable. Read your inbox/next actions and finish idle turns; the SDK wakes you on relevant events.\n` : '';
      const input = recoveryNote + workflowNote + (agent.role === 'orchestrator' ? plan.goal : `Work under ${rootId} toward this goal. Check inbox and shared ownership first:\n${plan.goal}`);
      if(plan.workflow){
        states.set(threadId,{status:'completed',completed:Date.now(),inboxVersion:0,workflowVersion:0});
        const wake=await workflowWakes.get(threadId).wake({trigger:'initial',input,initial:!recovering});
        if(wake.status!=='delivered')traces.get(agent.id).record('workflow.wake.pending',{threadId,status:wake.status});
      }else await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: input }], effort: plan.reasoningEffort });
    }
  }
  let monitoringBusy = false;
  const evidenceSessions=()=>[...threadAgents].map(([threadId,agentId])=>({threadId,agentId,...(stopIds.has(threadId)?{stopId:stopIds.get(threadId)}:{})}));
  const launchCollector=()=>{
    if(!plan.collection || evidenceFinal || evidenceProcess?.connected)return;
    evidenceProcess=fork(fileURLToPath(new URL('./evidence-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    evidenceProcess.on('error',()=>{});
    evidenceProcess.on('message',message=>{
      if(message.type==='evidence.final')evidenceFinal=true;
      writeFileSync('/data/factory-evidence-status.json',JSON.stringify({at:new Date().toISOString(),...message}),{mode:0o600});
    });
    evidenceProcess.send({action:'start',runId:plan.runId,machineId:machine,url:plan.collection.url,token:evidenceTokens?.[machine],intervalMs:plan.collection.intervalMs??60000,sessions:evidenceSessions()});
  };
  launchCollector();
  monitoring = setInterval(async () => {
    if (monitoringBusy) return; monitoringBusy = true;
    try {
    if(!evidenceSealing)rootTrace.record('machine.health', { uptime: process.uptime(), freeMemory: freemem(), totalMemory: totalmem(), load: loadavg(), process: process.memoryUsage(),
      disk: (await run('df', ['-B1', '/data'])).trim(), processes: (await run('ps', ['-eo', 'pid,ppid,rss,pcpu,comm'])).trim() });
    if(plan.shutdown && Date.now()>=Date.parse(plan.shutdown.deadlineUtc) && !deadlineRequested){
      for(const [threadId,agentId]of threadAgents)await request('/operator/command',{id:`deadline-${plan.runId}-${agentId}`,recipient:agentId,action:'stop',expectedThreadId:threadId},operatorToken);
      deadlineRequested=true;
    }
    for (const [threadId, agentId] of threadAgents) {
      const agent = bootstrap.agents.find(x => x.id === agentId);
      const incoming = await request('/commands', {}, agent.token);
      if(incoming.sealRequested)sealRequested=true;
      inboxVersions.set(threadId, incoming.inboxVersion ?? 0);
      workflowVersions.set(threadId, incoming.workflowVersion ?? 0);
      for (const command of incoming.commands) {
        if (command.action === 'stop') {
          stoppingThreads.add(threadId);
          if (!stopTasks.has(command.id)) {
            const stopTask = (async () => {
              const completed = await finalizeNativeStopCommand({
                prove: () => stopControllers.get(threadId).stop(command.id, {
                  expectedThreadId: command.expectedThreadId, expectedTurnId: command.expectedTurnId,
                }),
                publish: () => traces.get(agentId).record('supervisor.command', { id: command.id, action: 'stop' }),
                flush: () => traces.get(agentId).flush(),
                acknowledge: () => request('/commands', { acknowledge: command.id }, agent.token),
                isRevoked: () => revokedStopCommands.has(command.id),
                markStopped: () => {
                  stoppedThreads.add(threadId);
                  stopIds.set(threadId,command.id);
                  states.set(threadId, { status: 'stopped', completed: Date.now(), inboxVersion: inboxVersions.get(threadId) ?? 0 });
                },
              });
              if (!completed) {
                revokedStopCommands.add(command.id);
                return;
              }
            })().catch(() => {
              rootTrace.record('operator.stop.failed', { agent: agentId, commandId: command.id, category: 'native_stop_unconfirmed' });
              void rootTrace.flush().catch(() => {});
            }).finally(() => { if (pendingStopCommands.get(threadId) === command.id) pendingStopCommands.delete(threadId); });
            pendingStopCommands.set(threadId, command.id);
            stopTasks.set(command.id, stopTask);
          }
          continue;
        } else if (command.action === 'message') {
          if(evidenceSealing)throw new Error('Final evidence is sealed; start a new run to resume work.');
          const pendingStop = pendingStopCommands.get(threadId);
          if (pendingStop) revokedStopCommands.add(pendingStop);
          stopControllers.get(threadId)?.invalidateReceipts();
          stoppingThreads.delete(threadId);
          stoppedThreads.delete(threadId);
          stopIds.delete(threadId);
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
    if(plan.collection && (sealRequested || deadlineRequested) && stoppedThreads.size===threadAgents.size){
      evidenceSealing=true;launchCollector();
      if(!evidenceFinal && evidenceProcess?.connected){for(const trace of traces.values())await trace.flush();evidenceProcess.send({action:'finalize',sessions:evidenceSessions()});}
    }else launchCollector();
    for (const [threadId, state] of states) {
      const agentId = threadAgents.get(threadId);
      const newMail = (inboxVersions.get(threadId) ?? 0) > state.inboxVersion;
      const newWorkflowEvent = plan.workflow && (workflowVersions.get(threadId) ?? 0) > (state.workflowVersion ?? 0);
      const pendingWorkflowWake = plan.workflow && ['unknown','rejected'].includes(workflowWakes.get(threadId)?.intent?.status);
      const leaderFollowup = !plan.workflow && agentId === rootId && Date.now() - state.completed >= 120000;
      if (stopping || evidenceSealing || stoppingThreads.has(threadId) || state.status !== 'completed' || !newMail && !leaderFollowup && !newWorkflowEvent && !pendingWorkflowWake) continue;
      try {
        if(plan.workflow){
          const wake=await workflowWakes.get(threadId).wake({trigger:`${inboxVersions.get(threadId)??0}:${workflowVersions.get(threadId)??0}`,
            input:'New FACTORY work is available. Read incremental workflow events and inbox, take the next assigned action, and finish the turn when waiting. Preserve original candidate and delivery identities.'});
          if(wake.status==='delivered'&&states.get(threadId)===state)states.delete(threadId);
        }else{states.delete(threadId);await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Continue the active goal. Check the FACTORY inbox and current claims, report useful progress and evidence, and take the next available action. Coordinate with your orchestrator and avoid duplicate work.' }], effort: plan.reasoningEffort });}
      }
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
    if(evidenceProcess?.connected)evidenceProcess.disconnect();
  })(); }
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
  return { rpc, traces, stop, threadAgents };
}

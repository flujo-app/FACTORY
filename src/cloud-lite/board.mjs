import { FactoryControl } from '../control.mjs';
import { agentInventory, canMessage, hash, redact } from './protocol.mjs';
import { FactoryWorkflow } from '../workflows/engine.mjs';
import { callWorkflowTool, workflowTools } from '../workflows/tools.mjs';

class NativeStopReceiptRejected extends Error {}

function decodeNativeFailure(value) {
  let failure = value;
  for (let attempt = 0; typeof failure === 'string' && attempt < 2; attempt++) {
    try { failure = JSON.parse(failure); } catch { return null; }
  }
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)
    || !['turn_failed','turn_interrupted'].includes(failure.category)) return null;
  return { category: failure.category,
    ...(Number.isSafeInteger(failure.errorCode) && Math.abs(failure.errorCode) <= 1000000 ? { errorCode: failure.errorCode } : {}) };
}

export class CloudLiteBoard {
  constructor(database, { plan, credentials, operatorToken } = {}) {
    this.control = new FactoryControl(database);
    this.db = this.control.db;
    this.operatorHash = operatorToken && hash(operatorToken);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cloud_lite_agents(id TEXT PRIMARY KEY, machine TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL, session TEXT, status TEXT NOT NULL DEFAULT 'pending', updated INTEGER);
      CREATE TABLE IF NOT EXISTS cloud_lite_claims(resource TEXT PRIMARY KEY, machine TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_lite_traces(seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_seq INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, observed INTEGER NOT NULL, UNIQUE(source,source_seq));
      CREATE TABLE IF NOT EXISTS cloud_lite_command_cancellations(command_id TEXT PRIMARY KEY, superseded_by TEXT NOT NULL, cancelled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_lite_commands(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, body TEXT NOT NULL, acknowledged INTEGER);
      CREATE TABLE IF NOT EXISTS cloud_lite_validations(resource TEXT NOT NULL, revision TEXT NOT NULL, machine TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(resource,revision));
      CREATE TABLE IF NOT EXISTS cloud_lite_native_runtime(agent_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, event_seq INTEGER NOT NULL, thread_lifecycle TEXT NOT NULL, thread_status TEXT, turn_id TEXT, turn_status TEXT, failure TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_lite_native_stop_receipts(agent_id TEXT NOT NULL, command_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT, thread_status TEXT NOT NULL, turn_status TEXT, event_seq INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(agent_id,command_id));
      CREATE TABLE IF NOT EXISTS cloud_lite_native_stop_receipt_rejections(source TEXT NOT NULL, source_seq INTEGER NOT NULL, PRIMARY KEY(source,source_seq));
      CREATE TABLE IF NOT EXISTS cloud_lite_run(id INTEGER PRIMARY KEY CHECK(id=1), plan TEXT NOT NULL, digest TEXT NOT NULL);`);
    if (plan) {
      const previous = this.db.prepare('SELECT digest FROM cloud_lite_run WHERE id=1').get();
      if (previous && previous.digest !== hash(plan)) throw new Error('Existing fleet plan differs; recovery must retain original identities.');
      this.db.prepare('INSERT OR IGNORE INTO cloud_lite_run VALUES(1,?,?)').run(JSON.stringify(plan), hash(plan));
      if (!this.db.prepare('SELECT id FROM control WHERE id=1').get()) {
        this.control.initialize({ mission: plan.goal, budgetCents: 0, maxCells: plan.machines * plan.agentsPerMachine + 1, maxDepth: 2 });
        for (const agent of agentInventory(plan)) {
          this.control.reserveCell({ cellId: agent.id, parentId: agent.parentId, role: agent.role === 'orchestrator' ? 'coordinator' : plan.workflow && agent.id.endsWith(`-a${plan.agentsPerMachine - 1}`) ? 'verifier' : 'developer', budgetCents: 0, purpose: plan.goal });
          this.control.enrollCell(agent.id);
        }
      }
      for (const agent of agentInventory(plan)) {
        const token = credentials?.[agent.id];
        if (!token) throw new Error('Every agent requires an individual board credential.');
        const old = this.db.prepare('SELECT token_hash FROM cloud_lite_agents WHERE id=?').get(agent.id);
        if (old && old.token_hash !== hash(token)) throw new Error('Credential replacement requires explicit recovery.');
        this.db.prepare('INSERT OR IGNORE INTO cloud_lite_agents(id,machine,role,token_hash) VALUES(?,?,?,?)').run(agent.id, agent.machine, agent.role, hash(token));
      }
    }
    const savedPlan = this.db.prepare('SELECT plan FROM cloud_lite_run WHERE id=1').get();
    if (savedPlan && JSON.parse(savedPlan.plan).workflow === 'verified-v1') this.workflow = new FactoryWorkflow(database, { control: this.control });
  }
  authenticate(token) {
    if (this.operatorHash && hash(token) === this.operatorHash) return { id: 'operator', role: 'operator' };
    const actor = this.db.prepare('SELECT id,machine,role FROM cloud_lite_agents WHERE token_hash=?').get(hash(token));
    if (!actor) throw Object.assign(new Error('Board authentication failed.'), { code: 'AUTH' });
    return actor;
  }
  inventory() {
    return this.db.prepare(`SELECT a.id,a.machine,a.role,a.session,a.status,a.updated,
      n.thread_id AS native_thread_id,n.event_seq AS native_event_seq,n.thread_lifecycle,n.thread_status,
      n.turn_id AS native_turn_id,n.turn_status,n.failure AS native_failure,n.updated AS native_updated
      FROM cloud_lite_agents a LEFT JOIN cloud_lite_native_runtime n ON n.agent_id=a.id ORDER BY a.machine,a.id`).all()
      .map(agent => {
        const { native_thread_id, native_event_seq, thread_lifecycle, thread_status, native_turn_id, turn_status, native_failure, native_updated, ...rest } = agent;
        const operatorStopReceipt = this.latestNativeStop(agent.id);
        return { ...rest, nativeRuntime: native_thread_id ? {
          threadId: native_thread_id, eventSequence: native_event_seq, threadLifecycle: thread_lifecycle,
          ...(thread_status ? { threadStatus: thread_status } : {}),
          ...(native_turn_id ? { turnId: native_turn_id } : {}),
          ...(turn_status ? { turnStatus: turn_status } : {}),
          ...(native_failure ? { failure: JSON.parse(native_failure) } : {}), updated: native_updated,
          ...(operatorStopReceipt ? { operatorStopReceipt } : {}),
        } : null };
      });
  }
  latestNativeStop(agentId) {
    const receipt = this.db.prepare('SELECT command_id,thread_id,turn_id,thread_status,turn_status,event_seq,updated FROM cloud_lite_native_stop_receipts WHERE agent_id=? ORDER BY event_seq DESC LIMIT 1').get(agentId);
    return receipt ? { commandId: receipt.command_id, threadId: receipt.thread_id, ...(receipt.turn_id ? { turnId: receipt.turn_id } : {}),
      threadStatus: receipt.thread_status, ...(receipt.turn_status ? { turnStatus: receipt.turn_status } : {}), eventSequence: receipt.event_seq, updated: receipt.updated } : null;
  }
  registerSession(agent, session) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(session ?? '')) throw new TypeError('Provide the real native Codex thread identity.');
    const previous = this.db.prepare('SELECT session FROM cloud_lite_agents WHERE id=?').get(agent);
    if (previous && previous.session !== session) {
      this.db.prepare('DELETE FROM cloud_lite_native_runtime WHERE agent_id=?').run(agent);
      this.db.prepare('DELETE FROM cloud_lite_native_stop_receipts WHERE agent_id=?').run(agent);
    }
    const result = this.db.prepare('UPDATE cloud_lite_agents SET session=?,updated=? WHERE id=?').run(session,Date.now(),agent);
    if (!result.changes) throw new Error('Unknown configured agent.');
    return { registered: true };
  }
  observeNativeRuntime(actor, eventSequence, kind, body = {}) {
    if (!actor || actor.role === 'operator' || typeof actor.id !== 'string') throw new Error('Native runtime observations require an authenticated agent.');
    const params = body?.params ?? body;
    const threadId = params?.threadId ?? params?.thread?.id;
    const turn = params?.turn ?? {};
    const event = kind === 'native.thread.started' || kind === 'thread/started' ? 'thread.started'
      : kind === 'native.thread.resumed' || kind === 'thread/resumed' ? 'thread.resumed'
        : kind === 'thread/status/changed' ? 'thread.status'
          : kind === 'turn/started' || kind === 'native.turn.started' ? 'turn.started'
            : kind === 'turn/completed' || kind === 'native.turn.completed' ? 'turn.completed' : null;
    if (!event) return { recorded: false, irrelevant: true };
    const rawThreadStatus = params?.threadStatus ?? params?.thread?.status?.type ?? params?.status?.type ?? params?.status;
    const threadStatus = rawThreadStatus === undefined ? undefined
      : ['active','idle','archived','notLoaded','systemError','notFound','unknown'].includes(rawThreadStatus) ? rawThreadStatus : 'unknown';
    const turnId = typeof turn.id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(turn.id) ? turn.id : null;
    const rawTurnStatus = event === 'turn.started' ? 'inProgress' : turn.status;
    const turnStatus = rawTurnStatus === undefined ? undefined
      : ['inProgress','completed','failed','interrupted','unknown'].includes(rawTurnStatus) ? rawTurnStatus : 'unknown';
    const errorCode = turn.error?.code;
    const failure = turn.status === 'failed' || turn.status === 'interrupted'
      ? { category: turn.status === 'failed' ? 'turn_failed' : 'turn_interrupted',
        ...(Number.isSafeInteger(errorCode) && Math.abs(errorCode) <= 1000000 ? { errorCode } : {}) }
      : null;
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
      throw new TypeError('Provide the registered native thread and positive trace sequence.');
    }
    let safeFailure = null;
    if (failure !== undefined && failure !== null) {
      if (typeof failure !== 'object' || Array.isArray(failure) || !['turn_failed','turn_interrupted'].includes(failure.category)) throw new TypeError('Failure metadata must use a safe category.');
      safeFailure = { category: failure.category };
      if (Number.isSafeInteger(failure.errorCode) && Math.abs(failure.errorCode) <= 1000000) safeFailure.errorCode = failure.errorCode;
    }
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId ?? '')) return { recorded: false, identityMismatch: true };
    const session = this.db.prepare('SELECT session FROM cloud_lite_agents WHERE id=?').get(actor.id);
    if (!session || session.session !== threadId) return { recorded: false, identityMismatch: true };
    const old = this.db.prepare('SELECT * FROM cloud_lite_native_runtime WHERE agent_id=?').get(actor.id);
    if (old && old.thread_id === threadId && old.event_seq >= eventSequence) return { recorded: false, stale: true };
    const sameThread = old?.thread_id === threadId;
    if (event === 'turn.completed' && sameThread && old.turn_id && old.turn_status === 'inProgress'
      && turnId && turnId !== old.turn_id) return { recorded: false, staleTurn: true };
    const nextLifecycle = event === 'thread.started' ? 'started' : event === 'thread.resumed' ? 'resumed' : sameThread ? old.thread_lifecycle : 'observed';
    const nextThreadStatus = threadStatus ?? (sameThread ? old.thread_status : null);
    const nextTurnId = event === 'turn.started' ? turnId ?? null : event === 'turn.completed' && turnId ? turnId : sameThread ? old.turn_id : null;
    const nextTurnStatus = event === 'turn.started' ? turnStatus ?? 'inProgress' : turnStatus ?? (sameThread ? old.turn_status : null);
    const priorFailure = sameThread ? decodeNativeFailure(old.failure) : null;
    const nextFailure = event === 'turn.started' ? null : event === 'turn.completed' ? safeFailure : safeFailure ?? priorFailure;
    if (event === 'thread.started' || event === 'thread.resumed' || event === 'turn.started'
      || event === 'thread.status' && threadStatus === 'active') {
      this.db.prepare('DELETE FROM cloud_lite_native_stop_receipts WHERE agent_id=?').run(actor.id);
    }
    this.db.prepare(`INSERT INTO cloud_lite_native_runtime(agent_id,thread_id,event_seq,thread_lifecycle,thread_status,turn_id,turn_status,failure,updated)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET thread_id=excluded.thread_id,event_seq=excluded.event_seq,
      thread_lifecycle=excluded.thread_lifecycle,thread_status=excluded.thread_status,turn_id=excluded.turn_id,
      turn_status=excluded.turn_status,failure=excluded.failure,updated=excluded.updated`)
      .run(actor.id, threadId, eventSequence, nextLifecycle, nextThreadStatus, nextTurnId, nextTurnStatus,
        nextFailure ? JSON.stringify(nextFailure) : null, Date.now());
    return { recorded: true };
  }
  snapshot() { return { plan: JSON.parse(this.db.prepare('SELECT plan FROM cloud_lite_run WHERE id=1').get().plan),
    ...(this.workflow ? { workflows: this.workflow.listTasks(), workflowSequence: this.workflow.events({limit:1}).through } : {}),
    agents: this.inventory(), claims: this.db.prepare('SELECT * FROM cloud_lite_claims ORDER BY updated DESC').all().map(r => ({ ...r, details: JSON.parse(r.details) })),
    validations: this.db.prepare('SELECT * FROM cloud_lite_validations ORDER BY updated').all().map(r => ({ ...r, evidence: JSON.parse(r.evidence) })),
    traceSequence: this.db.prepare('SELECT max(seq) AS n FROM cloud_lite_traces').get().n ?? 0 }; }
  call(actor, name, args = {}) {
    if (workflowTools.some(tool => tool.name === name)) {
      if (!this.workflow) throw new Error('This fleet uses the baseline workflow profile.');
      return callWorkflowTool(this.workflow, actor.id === 'operator' ? 'root' : actor.id, name, args, {
        supervisor: actor.role === 'operator', authorize: task => {
          if (actor.role === 'operator') return;
          for (const member of [task.assignee,task.reviewerId]) {
            if (this.db.prepare('SELECT machine FROM cloud_lite_agents WHERE id=?').get(member)?.machine !== actor.machine) throw new Error('An orchestrator assigns only its own machine; the supervisor may coordinate cross-machine work.');
          }
        },
      });
    }
    if (name === 'factory_status') return this.snapshot();
    if (name === 'factory_identity') return actor;
    if (name === 'factory_inbox') return { messages: this.control.inbox(actor.id) };
    if (name === 'factory_message') {
      const recipient = this.db.prepare('SELECT id,machine,role FROM cloud_lite_agents WHERE id=?').get(args.recipient);
      if (!recipient || !canMessage(actor, recipient)) throw Object.assign(new Error('Messages must follow the machine/orchestrator communication policy.'), { code: 'MESSAGE_SCOPE' });
      return this.control.sendMessage({ sender: actor.id, messageId: args.messageId, recipient: recipient.id, payload: args.message });
    }
    if (name === 'factory_claim') {
      if (typeof args.resource !== 'string' || !/^(pr|issue|review):[\w./:-]+$/.test(args.resource)) throw new TypeError('Use a stable pr:, issue:, or review: resource identity.');
      return this.control.transaction(() => {
        const old = this.db.prepare('SELECT * FROM cloud_lite_claims WHERE resource=?').get(args.resource);
        if (old) return { claimed: old.machine === actor.machine && !['merged', 'closed'].includes(old.status), claim: old };
        this.db.prepare('INSERT INTO cloud_lite_claims VALUES(?,?,?,?,?,?)').run(args.resource, actor.machine, actor.id, 'claimed', '{}', Date.now());
        return { claimed: true, claim: this.db.prepare('SELECT * FROM cloud_lite_claims WHERE resource=?').get(args.resource) };
      });
    }
    if (name === 'factory_task_update') {
      const claim = this.db.prepare('SELECT * FROM cloud_lite_claims WHERE resource=?').get(args.resource);
      if (!claim || claim.machine !== actor.machine || actor.id !== claim.owner && actor.role !== 'orchestrator') throw new Error('Only the assigned owner or its orchestrator can update work.');
      if (!['claimed', 'running', 'review', 'ready', 'merged', 'closed', 'failed', 'held'].includes(args.status)) throw new TypeError('Invalid task status.');
      this.db.prepare('UPDATE cloud_lite_claims SET status=?,details=?,updated=? WHERE resource=?').run(args.status, JSON.stringify(args.details ?? {}), Date.now(), args.resource);
      return { recorded: true, provenance: 'agent-reported' };
    }
    if (name === 'factory_checkpoint') {
      this.control.heartbeat(actor.id);
      this.db.prepare('UPDATE cloud_lite_agents SET status=?,updated=? WHERE id=?').run(args.status ?? 'working', Date.now(), actor.id);
      return { recorded: true };
    }
    if (name === 'factory_validation_request') {
      if (!/^[0-9a-f]{40}$/.test(args.revision ?? '')) throw new TypeError('Provide the exact immutable Git revision.');
      const claim = this.db.prepare('SELECT machine FROM cloud_lite_claims WHERE resource=?').get(args.resource);
      if (!claim || claim.machine !== actor.machine) throw new Error('Validation must concern your assigned work.');
      this.db.prepare('INSERT OR IGNORE INTO cloud_lite_validations VALUES(?,?,?,?,?,?)').run(args.resource, args.revision, actor.machine, 'pending', '{}', Date.now());
      const result = this.db.prepare('SELECT * FROM cloud_lite_validations WHERE resource=? AND revision=?').get(args.resource, args.revision);
      return { ...result, evidence: JSON.parse(result.evidence) };
    }
    throw new Error('Unknown board tool.');
  }
  trace(actor, events) {
    if (!Array.isArray(events) || events.length > 200) throw new TypeError('A bounded trace batch is required.');
    return this.control.transaction(() => {
      for (const event of events) {
        if (!Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.kind !== 'string') throw new TypeError('Invalid trace identity.');
        const body = JSON.stringify(redact(event.body ?? {}));
        const old = this.db.prepare('SELECT kind,body FROM cloud_lite_traces WHERE source=? AND source_seq=?').get(actor.id, event.seq);
        if (old && (old.kind !== event.kind || old.body !== body)) throw new Error('A trace sequence cannot identify different bytes.');
        this.db.prepare('INSERT OR IGNORE INTO cloud_lite_traces(source,source_seq,kind,body,observed) VALUES(?,?,?,?,?)').run(actor.id, event.seq, event.kind, body, Date.now());
        if (event.kind === 'native.operator.stop.completed') {
          const rejected = this.db.prepare('SELECT 1 FROM cloud_lite_native_stop_receipt_rejections WHERE source=? AND source_seq=?').get(actor.id, event.seq);
          if (!rejected) {
            try { this.recordNativeStopReceipt(actor, event.seq, JSON.parse(body)); }
            catch (error) {
              if (!(error instanceof NativeStopReceiptRejected)) throw error;
              this.db.prepare('INSERT OR IGNORE INTO cloud_lite_native_stop_receipt_rejections VALUES(?,?)').run(actor.id, event.seq);
            }
          }
        }
        else this.observeNativeRuntime(actor, event.seq, event.kind, JSON.parse(body));
      }
      return { acknowledged: events.at(-1)?.seq ?? 0 };
    });
  }
  recordNativeStopReceipt(actor, eventSequence, body) {
    if (!actor || actor.role === 'operator' || typeof actor.id !== 'string') throw new NativeStopReceiptRejected('Operator stop receipts require an authenticated agent.');
    const params = body?.params ?? body;
    const threadId = params?.threadId;
    const commandId = params?.commandId;
    const threadStatus = params?.threadStatus;
    const turn = params?.turn;
    const turnId = turn?.id;
    const turnStatus = turn?.status;
    const expectedThreadId = params?.expectedThreadId;
    const expectedTurnId = params?.expectedTurnId;
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 1 || typeof commandId !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(commandId)
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId ?? '')
      || expectedThreadId !== threadId
      || expectedTurnId !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expectedTurnId ?? '')
      || !['idle','archived'].includes(threadStatus)
      || turnId !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(turnId)
      || turnStatus !== undefined && !['completed','interrupted','failed'].includes(turnStatus)) throw new NativeStopReceiptRejected('Native stop receipt must contain stable identity and a safe inactive state.');
    const session = this.db.prepare('SELECT session FROM cloud_lite_agents WHERE id=?').get(actor.id);
    if (!session || session.session !== threadId) throw new NativeStopReceiptRejected('Native stop receipt does not match the registered thread.');
    const issued = this.db.prepare('SELECT recipient,body FROM cloud_lite_commands WHERE id=?').get(commandId);
    const command = issued ? JSON.parse(issued.body) : null;
    if (!issued || issued.recipient !== actor.id || command?.action !== 'stop'
      || command.expectedThreadId !== expectedThreadId || command.expectedTurnId !== expectedTurnId) {
      throw new NativeStopReceiptRejected('Native stop receipt does not match an issued stop command for this agent and target.');
    }
    if ((turnId ?? null) !== expectedTurnId) throw new NativeStopReceiptRejected('Native stop receipt turn differs from the issued command target.');
    if (this.db.prepare('SELECT 1 FROM cloud_lite_command_cancellations WHERE command_id=?').get(commandId)) {
      throw new NativeStopReceiptRejected('Native stop receipt belongs to a superseded command.');
    }
    const native = this.db.prepare('SELECT * FROM cloud_lite_native_runtime WHERE agent_id=?').get(actor.id);
    if (!native || native.thread_id !== threadId || native.thread_status !== threadStatus || native.turn_status === 'inProgress') throw new NativeStopReceiptRejected('Native stop receipt is stale or the thread remains active.');
    if (turnId && (native.turn_id !== turnId || native.turn_status !== turnStatus)) throw new NativeStopReceiptRejected('Native stop receipt does not match the latest terminal turn.');
    const old = this.db.prepare('SELECT * FROM cloud_lite_native_stop_receipts WHERE agent_id=? AND command_id=?').get(actor.id, commandId);
    if (old) {
      if (old.thread_id !== threadId || old.turn_id !== (turnId ?? null) || old.thread_status !== threadStatus || old.turn_status !== (turnStatus ?? null)) throw new NativeStopReceiptRejected('Stable operator stop identity cannot identify different proof.');
      return { recorded: false, duplicate: true };
    }
    this.db.prepare('INSERT INTO cloud_lite_native_stop_receipts VALUES(?,?,?,?,?,?,?,?)')
      .run(actor.id, commandId, threadId, turnId ?? null, threadStatus, turnStatus ?? null, eventSequence, Date.now());
    return { recorded: true };
  }
  events(after = 0, through = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < after) throw new TypeError('Select a bounded trace cursor and watermark.');
    const result = []; let bytes = 0;
    for (const row of this.db.prepare('SELECT * FROM cloud_lite_traces WHERE seq>? AND seq<=? ORDER BY seq LIMIT 100').all(after, through)) {
      const event = { ...row, body: JSON.parse(row.body) };
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 512 * 1024) {
        if (!result.length) result.push(event); // Preserve legacy progress for one accepted oversized first record.
        break;
      }
      result.push(event); bytes += size;
    }
    return result;
  }
  close() { this.control.close(); }
}

export const cloudBoardTools = [
  ['factory_identity', 'Read your machine, agent identity and role.'],
  ['factory_status', 'Read fleet agents and shared PR/issue claims before choosing work.'],
  ['factory_claim', 'Atomically claim a PR/issue/review for your machine; another machine cannot duplicate it.', { resource: { type: 'string' } }, ['resource']],
  ['factory_task_update', 'Record progress and evidence links for your assigned work.', { resource: { type: 'string' }, status: { type: 'string' }, details: { type: 'object' } }, ['resource', 'status']],
  ['factory_message', 'Message your machine peers; only orchestrators may message other orchestrators.', { recipient: { type: 'string' }, messageId: { type: 'string' }, message: { type: 'object' } }, ['recipient', 'messageId', 'message']],
  ['factory_inbox', 'Read messages addressed to your identity.'],
  ['factory_checkpoint', 'Record current activity. Native session identity is registered by the SDK.', { status: { type: 'string' } }],
  ['factory_validation_request', 'Request or read supervisor Windows/Linux local CI parity for an exact claimed Git revision before GitHub delivery.', { resource: { type: 'string' }, revision: { type: 'string' } }, ['resource','revision']],
  ['factory_cleanup', 'Delete task files/caches inside your own worktree through upstream FLUJO Bash MCP.', { paths: { type: 'array', items: { type: 'string' } } }, ['paths']],
].map(([name, description, properties = {}, required = []]) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } })).concat(workflowTools);

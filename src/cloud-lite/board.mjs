import { FactoryControl } from '../control.mjs';
import { agentInventory, canMessage, hash, redact } from './protocol.mjs';

export class CloudLiteBoard {
  constructor(database, { plan, credentials, operatorToken } = {}) {
    this.control = new FactoryControl(database);
    this.db = this.control.db;
    this.operatorHash = operatorToken && hash(operatorToken);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cloud_lite_agents(id TEXT PRIMARY KEY, machine TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL, session TEXT, status TEXT NOT NULL DEFAULT 'pending', updated INTEGER);
      CREATE TABLE IF NOT EXISTS cloud_lite_claims(resource TEXT PRIMARY KEY, machine TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_lite_traces(seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_seq INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, observed INTEGER NOT NULL, UNIQUE(source,source_seq));
      CREATE TABLE IF NOT EXISTS cloud_lite_commands(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, body TEXT NOT NULL, acknowledged INTEGER);
      CREATE TABLE IF NOT EXISTS cloud_lite_validations(resource TEXT NOT NULL, revision TEXT NOT NULL, machine TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(resource,revision));
      CREATE TABLE IF NOT EXISTS cloud_lite_run(id INTEGER PRIMARY KEY CHECK(id=1), plan TEXT NOT NULL, digest TEXT NOT NULL);`);
    if (plan) {
      const previous = this.db.prepare('SELECT digest FROM cloud_lite_run WHERE id=1').get();
      if (previous && previous.digest !== hash(plan)) throw new Error('Existing fleet plan differs; recovery must retain original identities.');
      this.db.prepare('INSERT OR IGNORE INTO cloud_lite_run VALUES(1,?,?)').run(JSON.stringify(plan), hash(plan));
      if (!this.db.prepare('SELECT id FROM control WHERE id=1').get()) {
        this.control.initialize({ mission: plan.goal, budgetCents: 0, maxCells: plan.machines * plan.agentsPerMachine + 1, maxDepth: 2 });
        for (const agent of agentInventory(plan)) {
          this.control.reserveCell({ cellId: agent.id, parentId: agent.parentId, role: agent.role === 'orchestrator' ? 'coordinator' : 'developer', budgetCents: 0, purpose: plan.goal });
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
  }
  authenticate(token) {
    if (this.operatorHash && hash(token) === this.operatorHash) return { id: 'operator', role: 'operator' };
    const actor = this.db.prepare('SELECT id,machine,role FROM cloud_lite_agents WHERE token_hash=?').get(hash(token));
    if (!actor) throw Object.assign(new Error('Board authentication failed.'), { code: 'AUTH' });
    return actor;
  }
  inventory() { return this.db.prepare('SELECT id,machine,role,session,status,updated FROM cloud_lite_agents ORDER BY machine,id').all(); }
  registerSession(agent, session) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(session ?? '')) throw new TypeError('Provide the real native Codex thread identity.');
    const result = this.db.prepare('UPDATE cloud_lite_agents SET session=?,updated=? WHERE id=?').run(session,Date.now(),agent);
    if (!result.changes) throw new Error('Unknown configured agent.');
    return { registered: true };
  }
  snapshot() { return { plan: JSON.parse(this.db.prepare('SELECT plan FROM cloud_lite_run WHERE id=1').get().plan),
    agents: this.inventory(), claims: this.db.prepare('SELECT * FROM cloud_lite_claims ORDER BY updated DESC').all().map(r => ({ ...r, details: JSON.parse(r.details) })),
    validations: this.db.prepare('SELECT * FROM cloud_lite_validations ORDER BY updated').all().map(r => ({ ...r, evidence: JSON.parse(r.evidence) })),
    traceSequence: this.db.prepare('SELECT max(seq) AS n FROM cloud_lite_traces').get().n ?? 0 }; }
  call(actor, name, args = {}) {
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
      }
      return { acknowledged: events.at(-1)?.seq ?? 0 };
    });
  }
  events(after = 0) {
    const result = []; let bytes = 0;
    for (const row of this.db.prepare('SELECT * FROM cloud_lite_traces WHERE seq>? ORDER BY seq LIMIT 100').all(after)) {
      const size = Buffer.byteLength(row.body);
      if (result.length && bytes + size > 512 * 1024) break;
      result.push({ ...row, body: JSON.parse(row.body) }); bytes += size;
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
  inputSchema: { type: 'object', properties, required, additionalProperties: false } }));

import { resolve, dirname } from 'node:path';
import { FactoryControl } from '../control.mjs';
import { FactoryArtifactStore, contentDigest } from './artifacts.mjs';
import { getWorkflowTemplate } from './templates.mjs';

const parse = row => row ? JSON.parse(row.body) : null;
const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`); return value; };
const id = value => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value ?? '')) throw new TypeError('Invalid workflow identifier.'); return value; };
const list = value => { if (!Array.isArray(value)) throw new TypeError('Expected an array.'); return value; };

/** Durable workflow authority, backed by the same tasks, leases and delivery fences as FactoryControl. */
export class FactoryWorkflow {
  constructor(database, { control, artifactDirectory, clock = Date.now } = {}) {
    this.ownedControl = !control; this.control = control ?? new FactoryControl(database, { clock }); this.db = this.control.db;
    this.artifacts = new FactoryArtifactStore(artifactDirectory ?? resolve(dirname(database), 'workflow-artifacts'));
    this.clock = this.control.clock;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_tasks(id TEXT PRIMARY KEY REFERENCES tasks(id), body TEXT NOT NULL, current TEXT, paused INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS workflow_leases(task TEXT PRIMARY KEY REFERENCES tasks(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_candidates(id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), round INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(task,round));
      CREATE TABLE IF NOT EXISTS workflow_reviews(candidate TEXT PRIMARY KEY REFERENCES workflow_candidates(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_verifications(candidate TEXT NOT NULL REFERENCES workflow_candidates(id), gate TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(candidate,gate));
      CREATE TABLE IF NOT EXISTS workflow_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, task TEXT, actor TEXT, body TEXT NOT NULL, observed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_knowledge(id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, candidate TEXT NOT NULL, gate TEXT NOT NULL, body TEXT NOT NULL);
    `);
  }
  close() { if (this.ownedControl) this.control.close(); }
  event(type, task, actor, body = {}) {
    this.db.prepare('INSERT INTO workflow_events(type,task,actor,body,observed) VALUES(?,?,?,?,?)').run(type, task ?? null, actor ?? null, JSON.stringify(body), this.clock());
  }
  actor(actor, roles) {
    const cell = this.db.prepare("SELECT id,role FROM cells WHERE id=? AND status='ready'").get(id(actor));
    if (!cell || roles && !roles.includes(cell.role)) throw new Error('Actor lacks the required workflow role.');
    return cell;
  }
  createTask(input) {
    const { taskId, projectId, branch, problem, acceptance, baseline, assignee, reviewerId, parentTask = null,
      dependencies = [], gates = [], template = { name: 'verified-task', revision: 1 }, context = {} } = input;
    id(taskId); id(projectId); this.actor(assignee, ['developer','coordinator']); this.actor(reviewerId, ['verifier']);
    if (assignee === reviewerId) throw new Error('Implementer and reviewer must be independent.');
    required(problem, 'problem'); required(acceptance, 'acceptance'); required(baseline, 'baseline');
    const definition = getWorkflowTemplate(template.name);
    if (template.revision !== definition.revision) throw new TypeError('Unsupported template revision.');
    list(dependencies).forEach(id); if (new Set(dependencies).size !== dependencies.length || dependencies.includes(taskId)) throw new TypeError('Dependencies must be unique and acyclic.');
    list(gates).forEach(gate => {
      id(gate.id); required(gate.command, 'gate command'); list(gate.args).forEach(arg => { if (typeof arg !== 'string') throw new TypeError('Command arguments must be strings.'); });
      if (!['exit-code','node-tap','json-summary'].includes(gate.adapter)) throw new TypeError('Select a supported verifier adapter.');
      if (!['development','publication','release','live'].includes(gate.scope)) throw new TypeError('Verifier scope is required.');
      if (gate.timeoutMs !== undefined && (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs < 1)) throw new TypeError('Invalid optional verifier timeout.');
      if (gate.minimumTests !== undefined && (!Number.isSafeInteger(gate.minimumTests) || gate.minimumTests < 1)) throw new TypeError('minimumTests must be positive.');
    });
    if (new Set(gates.map(g => g.id)).size !== gates.length) throw new TypeError('Gate identifiers must be unique.');
    const body = JSON.parse(JSON.stringify({ taskId, projectId, branch, problem, acceptance, baseline, assignee, reviewerId, parentTask, dependencies, gates, template, context }));
    return this.control.transaction(() => {
      for (const dependency of dependencies) this.getTask(dependency);
      if (parentTask) this.getTask(id(parentTask));
      const old = this.db.prepare('SELECT body FROM workflow_tasks WHERE id=?').get(taskId);
      if (old && contentDigest(parse(old)) !== contentDigest(body)) throw new Error('Task identity has different immutable input.');
      this.control.createTask({ taskId, projectId, branch, specification: { problem, acceptance, baseline, workflow: body } });
      if (!old) {
        this.db.prepare('INSERT INTO workflow_tasks(id,body) VALUES(?,?)').run(taskId, JSON.stringify(body));
        this.event('assignment_available', taskId, assignee, { dependencies });
      }
      return this.getTask(taskId);
    });
  }
  candidate(candidateId) {
    const value = parse(this.db.prepare('SELECT body FROM workflow_candidates WHERE id=?').get(candidateId));
    if (!value) throw new Error('Candidate not found.');
    this.artifacts.get(value.manifestRef); for (const artifact of value.artifacts) this.artifacts.get(artifact.ref);
    return value;
  }
  getTask(taskId) {
    const row = this.db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(id(taskId));
    if (!row) throw new Error('Workflow task not found.');
    const spec = parse(row), core = this.control.task(taskId);
    const candidate = row.current ? this.candidate(row.current) : null;
    const review = candidate && parse(this.db.prepare('SELECT body FROM workflow_reviews WHERE candidate=?').get(candidate.id));
    const verifications = candidate ? this.db.prepare('SELECT body FROM workflow_verifications WHERE candidate=? ORDER BY gate').all(candidate.id).map(parse) : [];
    const waitingFor = spec.dependencies.filter(dependency => !['verified','delivered'].includes(this.control.task(dependency).status));
    let status = ({ ready: 'ready', running: 'running', review: review?.accepted ? 'verification' : 'review', verified: 'accepted', rejected: 'revision_required', delivered: 'delivered' })[core.status] ?? core.status;
    if (row.paused) status = 'paused'; else if (waitingFor.length) status = 'waiting_dependency';
    return { ...spec, status, coreStatus: core.status, candidate, review, verifications, waitingFor, paused: Boolean(row.paused),
      lease: core.status === 'running' ? { owner: core.owner, epoch: core.epoch, expires: core.expires, controlEpoch: core.control_epoch } : null };
  }
  listTasks() { return this.db.prepare('SELECT id FROM workflow_tasks ORDER BY id').all().map(row => this.getTask(row.id)); }
  active(taskId) {
    this.control.active(); const task = this.getTask(taskId);
    if (task.paused || task.waitingFor.length) throw new Error('Task is paused or waiting for a dependency.');
    return task;
  }
  claim(taskId, actor, { ttlMs = 300000 } = {}) {
    return this.control.transaction(() => {
      const task = this.active(taskId); if (task.assignee !== actor) throw new Error('Only the assigned implementer may claim work.');
      const existing = parse(this.db.prepare('SELECT body FROM workflow_leases WHERE task=?').get(taskId));
      let lease;
      if (task.coreStatus === 'running' && existing?.cellId === actor && existing.epoch === task.lease.epoch && existing.expires > this.clock()
        && existing.controlEpoch === this.control.control().epoch) lease = this.control.renew(existing, ttlMs);
      else lease = this.control.claimTask(taskId, actor, ttlMs);
      this.db.prepare('INSERT INTO workflow_leases VALUES(?,?) ON CONFLICT(task) DO UPDATE SET body=excluded.body').run(taskId, JSON.stringify(lease));
      this.event('task_claimed', taskId, actor, { epoch: lease.epoch }); return this.getTask(taskId);
    });
  }
  submit(taskId, actor, { submissionId, source, artifacts, summary, resolvedFindings = [] }) {
    id(submissionId); required(summary, 'summary');
    if (!source || typeof source.repository !== 'string' || !/^[a-f0-9]{40}$/.test(source.commit ?? '') || !/^[a-f0-9]{40}$/.test(source.tree ?? '') || !/^[a-f0-9]{40}$/.test(source.baseline ?? '')) throw new TypeError('Candidate source requires repository, baseline, commit and tree.');
    if (!list(artifacts).length) throw new TypeError('A candidate needs portable artifact bytes.');
    for (const artifact of artifacts) { required(artifact.name, 'artifact name'); required(artifact.kind, 'artifact kind'); this.artifacts.get(artifact.ref); }
    const manifest = { schemaVersion: 1, taskId, submissionId, source, artifacts, summary, resolvedFindings: list(resolvedFindings).map(id) };
    const manifestRef = this.artifacts.putJSON(manifest).ref;
    return this.control.transaction(() => {
      const task = this.active(taskId); if (actor !== task.assignee) throw new Error('Only the assigned implementer may submit.');
      const old = parse(this.db.prepare('SELECT body FROM workflow_candidates WHERE id=?').get(submissionId));
      if (old) { if (old.manifestRef !== manifestRef || old.taskId !== taskId) throw new Error('Submission identity conflicts.'); return old; }
      if (source.baseline !== task.baseline) throw new Error('Candidate baseline differs from the frozen task.');
      const lease = parse(this.db.prepare('SELECT body FROM workflow_leases WHERE task=?').get(taskId));
      if (!lease || lease.cellId !== actor) throw new Error('Claim the task before submission.');
      const previous = task.candidate;
      const round = this.db.prepare('SELECT COALESCE(max(round),0)+1 AS n FROM workflow_candidates WHERE task=?').get(taskId).n;
      const candidate = { ...manifest, id: submissionId, manifestRef, round, supersedes: previous?.id ?? null, specDigest: this.control.task(taskId).spec_digest, submittedAt: this.clock() };
      this.control.submit(lease, { artifactPath: this.artifacts.path(manifestRef) });
      this.db.prepare('INSERT INTO workflow_candidates VALUES(?,?,?,?)').run(submissionId, taskId, round, JSON.stringify(candidate));
      this.db.prepare('UPDATE workflow_tasks SET current=? WHERE id=?').run(submissionId, taskId);
      this.event('candidate_submitted', taskId, task.reviewerId, { candidateId: submissionId, round });
      return candidate;
    });
  }
  review(candidateId, actor, { accepted, findings = [], rationale }) {
    if (typeof accepted !== 'boolean') throw new TypeError('Review verdict must be boolean.'); required(rationale, 'rationale');
    list(findings).forEach(finding => { id(finding.id); required(finding.description, 'finding description'); required(finding.requirement, 'finding requirement'); });
    if (new Set(findings.map(f => f.id)).size !== findings.length || accepted && findings.length) throw new Error('Accepted reviews cannot have unresolved findings.');
    return this.control.transaction(() => {
      const candidate = this.candidate(candidateId), task = this.active(candidate.taskId);
      this.actor(actor, ['verifier']); if (actor !== task.reviewerId || actor === task.assignee) throw new Error('Only the assigned independent reviewer may review.');
      if (task.candidate?.id !== candidateId) throw new Error('Review targets a superseded candidate.');
      const body = { candidateId, reviewerId: actor, accepted, findings, rationale, specDigest: candidate.specDigest, manifestRef: candidate.manifestRef };
      const old = parse(this.db.prepare('SELECT body FROM workflow_reviews WHERE candidate=?').get(candidateId));
      if (old && contentDigest(old) !== contentDigest(body)) throw new Error('A frozen review cannot be replaced.');
      if (!old) {
        if (task.coreStatus !== 'review') throw new Error('Candidate is not awaiting review.');
        this.db.prepare('INSERT INTO workflow_reviews VALUES(?,?)').run(candidateId, JSON.stringify(body));
        this.event('review_recorded', task.taskId, task.assignee, { candidateId, accepted, findings: findings.map(f => f.id) });
      }
      this.settle(task.taskId); return this.getTask(task.taskId);
    });
  }
  /** Trusted verifier/supervisor only. Agent-facing transports must not expose this mutation. */
  recordVerification(candidateId, gateId, result) {
    return this.control.transaction(() => {
      const candidate = this.candidate(candidateId), task = this.active(candidate.taskId), gate = task.gates.find(g => g.id === gateId);
      if (!gate || task.candidate?.id !== candidateId) throw new Error('Unknown gate or superseded candidate.');
      if (!['passed','failed','unknown','cancelled','timed_out'].includes(result.outcome)
        || result.candidateRef !== candidate.manifestRef || result.gateDigest !== contentDigest(gate)
        || !result.environment || !result.diagnosticsRef || !result.runId) throw new TypeError('Verifier evidence must bind candidate, gate, environment, diagnostics and run.');
      this.artifacts.get(result.diagnosticsRef);
      const old = parse(this.db.prepare('SELECT body FROM workflow_verifications WHERE candidate=? AND gate=?').get(candidateId, gateId));
      if (old && contentDigest(old) !== contentDigest(result)) throw new Error('Verifier result is immutable; submit another candidate for another attempt.');
      if (!old) {
        this.db.prepare('INSERT INTO workflow_verifications VALUES(?,?,?)').run(candidateId, gateId, JSON.stringify(result));
        this.event('verification_recorded', task.taskId, task.assignee, { candidateId, gateId, outcome: result.outcome });
      }
      this.settle(task.taskId); return this.getTask(task.taskId);
    });
  }
  settle(taskId) {
    const task = this.getTask(taskId); if (task.coreStatus !== 'review') return;
    const failed = task.verifications.some(result => ['failed','cancelled','timed_out'].includes(result.outcome));
    const accepted = task.review?.accepted && task.gates.every(gate => task.verifications.some(result => result.gateDigest === contentDigest(gate) && result.outcome === 'passed'));
    if (!task.review || !accepted && task.review.accepted && !failed) return;
    if (failed && task.review.accepted) {
      // Machine failure is distinct from the semantic review. Keep both original records.
      const core = this.control.task(taskId);
      this.db.prepare("UPDATE tasks SET status='rejected' WHERE id=? AND status='review'").run(taskId);
      this.control.event('verification_rejected', taskId, { candidateDigest: core.candidate.sha256 });
    } else {
      const receipt = this.artifacts.putJSON({ taskId, candidate: task.candidate.id, review: task.review, verifications: task.verifications });
      this.control.reviewTask(taskId, task.reviewerId, { accepted: Boolean(accepted), evidencePath: this.artifacts.path(receipt.ref) });
    }
    this.event(accepted ? 'candidate_accepted' : 'revision_required', taskId, task.assignee, { candidateId: task.candidate.id });
    if (accepted) for (const dependent of this.listTasks().filter(t => t.dependencies.includes(taskId) && !t.waitingFor.length)) this.event('dependency_ready', dependent.taskId, dependent.assignee, { dependency: taskId });
  }
  revise(taskId, actor) {
    return this.control.transaction(() => {
      const task = this.active(taskId); if (actor !== task.assignee) throw new Error('Only the implementer can start a revision.');
      this.control.reviseTask(taskId, this.control.task(taskId).candidate?.sha256);
      this.event('assignment_available', taskId, actor, { previousCandidate: task.candidate.id }); return this.getTask(taskId);
    });
  }
  pauseTask(taskId, paused, actor = 'root') {
    if (typeof paused !== 'boolean') throw new TypeError('paused must be boolean.');
    this.actor(actor, ['coordinator']);
    return this.control.transaction(() => {
      const task = this.getTask(taskId);
      if (task.paused !== paused) {
        this.db.prepare('UPDATE workflow_tasks SET paused=? WHERE id=?').run(paused ? 1 : 0, taskId);
        // Revoke any outstanding implementer lease; a resumed worker must claim again.
        if (task.coreStatus === 'running') this.db.prepare('UPDATE tasks SET expires=0 WHERE id=?').run(taskId);
        this.event(paused ? 'interrupted' : 'resumed', taskId, task.assignee, {});
      }
      return this.getTask(taskId);
    });
  }
  reviewPacket(candidateId) {
    const candidate = this.candidate(candidateId), task = this.getTask(candidate.taskId);
    return { problem: task.problem, acceptance: task.acceptance, baseline: task.baseline, gates: task.gates, candidate,
      instructions: 'Inspect frozen bytes against the original requirements. Return findings; do not silently repair the candidate.' };
  }
  nextActions(actor) {
    this.actor(actor);
    return this.listTasks().flatMap(task => {
      if (task.paused || task.waitingFor.length) return [];
      if (task.assignee === actor && ['ready','running','revision_required'].includes(task.status)) return [{ taskId: task.taskId, action: task.status === 'revision_required' ? 'revise' : task.status === 'running' ? 'continue' : 'claim', candidateId: task.candidate?.id ?? null }];
      if (task.reviewerId === actor && task.status === 'review') return [{ taskId: task.taskId, action: 'review', candidateId: task.candidate.id }];
      return [];
    });
  }
  events({ after = 0, limit = 100, taskId, actor, types } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid event cursor or limit.');
    const through = this.db.prepare('SELECT COALESCE(max(seq),0) AS n FROM workflow_events').get().n;
    const rows = this.db.prepare('SELECT * FROM workflow_events WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?').all(after, through, limit);
    return { events: rows.filter(row => (!taskId || row.task === taskId) && (!actor || row.actor === actor) && (!types || types.includes(row.type))).map(row => ({ ...row, body: JSON.parse(row.body) })),
      cursor: rows.at(-1)?.seq ?? Math.max(after, through), through, hasMore: Boolean(rows.length && rows.at(-1).seq < through) };
  }
  async *subscribe(options = {}) {
    let after = options.after ?? 0;
    while (!options.signal?.aborted) {
      const page = this.events({ ...options, after }); after = page.cursor;
      yield page;
      if (!page.hasMore) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, options.intervalMs ?? 1000); options.signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  curateKnowledge({ id: knowledgeId, expectedVersion = 0, title, content, applicability, candidateId, sources }, actor) {
    id(knowledgeId); this.actor(actor, ['verifier','coordinator']); required(title, 'title'); required(content, 'content'); required(applicability, 'applicability');
    if (!list(sources).length || sources.some(source => !source.ref || !source.location)) throw new TypeError('Knowledge requires provenance with source locations.');
    return this.control.transaction(() => {
      const candidate = this.candidate(candidateId), task = this.getTask(candidate.taskId);
      if (task.candidate?.id !== candidateId || !['accepted','delivered'].includes(task.status)) throw new Error('Knowledge must originate from an accepted candidate.');
      for (const source of sources) { this.artifacts.get(source.ref); if (!candidate.artifacts.some(artifact => artifact.ref === source.ref)) throw new Error('Knowledge source is not part of the accepted candidate.'); }
      const version = this.db.prepare('SELECT COALESCE(max(version),0) AS n FROM workflow_knowledge WHERE id=?').get(knowledgeId).n;
      if (version !== expectedVersion) throw new Error('Knowledge version conflict.');
      const body = { id: knowledgeId, version: version + 1, title, content, applicability, candidateId, sources, curator: actor, verifiedAt: this.clock() };
      this.db.prepare('INSERT INTO workflow_knowledge VALUES(?,?,?)').run(knowledgeId, body.version, JSON.stringify(body));
      this.event('knowledge_curated', task.taskId, null, { id: knowledgeId, version: body.version }); return body;
    });
  }
  searchKnowledge(query, { limit = 8 } = {}) {
    required(query, 'query'); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new TypeError('Knowledge retrieval limit is 1–20.');
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.db.prepare('SELECT k.body FROM workflow_knowledge k JOIN (SELECT id,max(version) AS version FROM workflow_knowledge GROUP BY id) latest USING(id,version)').all().map(parse)
      .map(value => ({ value, score: words.filter(word => `${value.title} ${value.content} ${value.applicability}`.toLowerCase().includes(word)).length }))
      .filter(row => row.score).sort((a,b) => b.score - a.score || a.value.id.localeCompare(b.value.id)).slice(0,limit).map(row => row.value);
  }
}

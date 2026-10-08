import { isAbsolute, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FactoryControl, FactoryError, digest } from './control.mjs';
import { FactorySwarmEngine, conversationEffectKey } from './swarm-engine.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const APP = /^[a-z][a-z0-9-]{2,62}$/;
const CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || typeof plan.mission !== 'string' || !plan.mission.trim()
    || !Number.isSafeInteger(plan.budgetCents) || plan.budgetCents < 0
    || !Array.isArray(plan.workers) || plan.workers.length < 1
    || typeof plan.projectId !== 'string' || !ID.test(plan.projectId)
    || typeof plan.baseline !== 'string' || !plan.baseline.trim()) {
    throw new TypeError('A mission, budget, project, baseline and worker plan are required');
  }
  const workers = new Map(), apps = new Set(), conversations = new Set(),
    conversationBindings = new Set(), outputPaths = new Set();
  for (const worker of plan.workers) {
    if (!worker || !ID.test(worker.id ?? '') || !APP.test(worker.app ?? '')
      || workers.has(worker.id) || apps.has(worker.app)
      || !Number.isSafeInteger(worker.budgetCents) || worker.budgetCents < 0
      || typeof worker.purpose !== 'string' || !worker.purpose.trim()
      || !worker.provisionInput || typeof worker.provisionInput !== 'object'
      || worker.provisionInput.app !== worker.app || !Array.isArray(worker.conversations)) {
      throw new TypeError('Worker identities, allocations and provision inputs must be exact');
    }
    workers.set(worker.id, worker); apps.add(worker.app);
    for (const job of worker.conversations) {
      const outputIdentity = typeof job?.outputPath === 'string' && isAbsolute(job.outputPath)
        ? (process.platform === 'win32' ? resolve(job.outputPath).toLowerCase() : resolve(job.outputPath)) : null;
      if (!job || !ID.test(job.id ?? '') || conversations.has(job.id)
        || !job.input || typeof job.input !== 'object' || !CONVERSATION.test(job.input.conversationId ?? '')
        || !outputIdentity || outputPaths.has(outputIdentity)
        || conversationBindings.has(`${worker.app}\0${job.input?.conversationId}`)) {
        throw new TypeError('Conversation jobs need distinct IDs, worker bindings and private output paths');
      }
      conversations.add(job.id); outputPaths.add(outputIdentity);
      conversationBindings.add(`${worker.app}\0${job.input.conversationId}`);
    }
  }
  const depth = new Map(), visiting = new Set();
  const visit = worker => {
    if (depth.has(worker.id)) return depth.get(worker.id);
    if (visiting.has(worker.id)) throw new TypeError('Worker plan contains a cycle');
    visiting.add(worker.id);
    const parentId = worker.parentId ?? 'root';
    const parent = parentId === 'root' ? null : workers.get(parentId);
    if (parentId !== 'root' && !parent) throw new TypeError('Worker parent is absent');
    const level = parent ? visit(parent) + 1 : 1;
    visiting.delete(worker.id); depth.set(worker.id, level);
    return level;
  };
  for (const worker of plan.workers) visit(worker);
  for (const [parentId, allocation] of [['root', plan.budgetCents],
    ...plan.workers.map(worker => [worker.id, worker.budgetCents])]) {
    const total = plan.workers.filter(worker => (worker.parentId ?? 'root') === parentId)
      .reduce((sum, worker) => sum + BigInt(worker.budgetCents), 0n);
    if (total > BigInt(allocation)) throw new TypeError('Child allocations exceed parent budget');
  }
  return { workers, depth };
}

async function boundedMap(values, concurrency, operation) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]);
    }
  }));
  return results;
}

/** Local FLUJO fleet planning over one FACTORY controller, without a second worker registry. */
export class FactoryLocalFleet {
  constructor(database, adapter, { leaseTtlMs = 600000, renewEveryMs = 60000 } = {}) {
    if (adapter?.capabilities?.adapter !== 'flujo-workspace') {
      throw new TypeError('FactoryLocalFleet requires the local FLUJO workspace adapter');
    }
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 2
      || !Number.isSafeInteger(renewEveryMs) || renewEveryMs < 1 || renewEveryMs >= leaseTtlMs / 2) {
      throw new TypeError('Lease renewal interval must be positive and less than half the lease TTL');
    }
    this.database = resolve(database);
    this.engine = new FactorySwarmEngine(this.database, adapter);
    this.activeConversations = new Map();
    this.leaseTtlMs = leaseTtlMs;
    this.renewEveryMs = renewEveryMs;
  }

  #control(operation) {
    const control = new FactoryControl(this.database);
    try { return operation(control); } finally { control.close(); }
  }

  async #withLeaseRenewal(lease, operation) {
    let renewalError = null;
    const timer = setInterval(() => {
      try { Object.assign(lease, this.#control(control => control.renew(lease, this.leaseTtlMs))); }
      catch (error) { renewalError = error; clearInterval(timer); }
    }, this.renewEveryMs);
    timer.unref?.();
    try {
      const result = await operation(() => { if (renewalError) throw renewalError; });
      if (renewalError) throw renewalError;
      return result;
    } finally { clearInterval(timer); }
  }

  prepare(plan) {
    validatePlan(plan);
    return this.#control(control => {
      control.initialize({ mission: plan.mission, budgetCents: plan.budgetCents, growthMode: 'budget-only' });
      for (const worker of plan.workers) {
        control.createTask({ taskId: `launch-${worker.id}`, projectId: plan.projectId,
          branch: `codex/launch-${worker.id}`, specification: { taskType: 'operation',
            problem: `Provision ${worker.id}`, baseline: plan.baseline,
            acceptance: { scope: 'recorded-controller-operation-receipts-only' },
            operation: { kind: 'provision', cellId: worker.id, app: worker.app },
            parentId: worker.parentId ?? 'root', allocationCents: worker.budgetCents,
            purpose: worker.purpose,
            provisionInputDigest: digest(worker.provisionInput) } });
        for (const job of worker.conversations) {
          control.createTask({ taskId: `run-${job.id}`, projectId: plan.projectId,
            branch: `codex/run-${job.id}`, specification: { taskType: 'conversation',
              problem: `Run ${job.id}`, baseline: plan.baseline,
              acceptance: { scope: 'recorded-controller-conversation-receipt-only' },
              operation: { kind: 'flow_call', cellId: worker.id, app: worker.app,
                conversationId: job.input.conversationId, provisionKey: `provision-${worker.id}`,
                inputDigest: digest(job.input), outputPath: job.outputPath } } });
        }
      }
      return { workers: plan.workers.length,
        conversations: plan.workers.reduce((sum, worker) => sum + worker.conversations.length, 0),
        growthMode: control.control().policy.growthMode };
    });
  }

  async #launch(worker) {
    const taskId = `launch-${worker.id}`;
    let lease;
    try {
      lease = this.#control(control => {
        if (control.task(taskId).status === 'completed') {
          const owned = control.ownedWorker(worker.app);
          const cell = control.db.prepare('SELECT parent_id,status,allocation,purpose FROM cells WHERE id=?').get(worker.id);
          if (owned.provisionKey !== `provision-${worker.id}` || !cell || cell.status !== 'ready'
            || cell.parent_id !== (worker.parentId ?? 'root') || cell.allocation !== worker.budgetCents
            || cell.purpose !== worker.purpose) throw new FactoryError('WORKER', 'Worker binding changed');
          return null;
        }
        return control.claimTask(taskId, worker.parentId ?? 'root', this.leaseTtlMs);
      });
      if (lease === null) return { workerId: worker.id, status: 'ready', replayed: true };
      return await this.#withLeaseRenewal(lease, async checkRenewal => {
        const result = await this.engine.provisionWorker({ lease, cellId: worker.id, app: worker.app,
          parentId: worker.parentId ?? 'root', role: 'developer', budgetCents: worker.budgetCents,
          purpose: worker.purpose, input: worker.provisionInput });
        if (result.effect.state !== 'succeeded') return { workerId: worker.id, status: 'held' };
        checkRenewal();
        const closed = this.#control(control => {
          const task = control.task(taskId);
          return control.completeOperationalTask(taskId, { closureId: `complete-${taskId}`,
            expectedAttempt: task.epoch, expectedOwner: task.owner, expectedStatus: task.status,
            expectedTaskControlEpoch: task.control_epoch, expectedFactoryEpoch: control.control().epoch,
            completionEffectKeys: [result.effect.key] });
        });
        return { workerId: worker.id, status: closed.status, replayed: !result.dispatched };
      });
    } catch (error) {
      return { workerId: worker.id, status: 'held', code: error.code ?? 'UNCONFIRMED' };
    }
  }

  async #runConversation(worker, job) {
    const taskId = `run-${job.id}`;
    try {
      const lease = this.#control(control => {
        if (control.task(taskId).status === 'completed') {
          const effect = control.effect(conversationEffectKey(worker.app,job.input.conversationId));
          let sha256;
          try { sha256 = createHash('sha256').update(readFileSync(job.outputPath)).digest('hex'); }
          catch { throw new FactoryError('OUTPUT', 'Recorded conversation output is unavailable.'); }
          if (effect.state !== 'succeeded' || effect.receipt?.outputPath !== job.outputPath
            || effect.receipt?.outputSha256 !== sha256) throw new FactoryError('OUTPUT', 'Recorded conversation output changed.');
          return null;
        }
        return control.claimTask(taskId, worker.id, this.leaseTtlMs);
      });
      if (lease === null) return { conversationId: job.input.conversationId, status: 'completed', replayed: true };
      if (this.activeConversations.has(job.id)) throw new FactoryError('BUSY', 'Conversation is already active in this fleet');
      this.activeConversations.set(job.id, { lease, worker: worker.app, conversationId: job.input.conversationId });
      return await this.#withLeaseRenewal(lease, async checkRenewal => {
        const result = await this.engine.callWorker({ lease, worker: worker.app, input: job.input,
          outputPath: job.outputPath });
        if (result.effect.state !== 'succeeded') return { conversationId: job.input.conversationId, status: 'held' };
        checkRenewal();
        const closed = this.engine.completeConversation({ taskId, worker: worker.app,
          conversationId: job.input.conversationId });
        return { conversationId: job.input.conversationId, status: closed.status, replayed: !result.dispatched,
          effectKey: conversationEffectKey(worker.app, job.input.conversationId) };
      });
    } catch (error) {
      return { conversationId: job.input.conversationId, status: 'held', code: error.code ?? 'UNCONFIRMED' };
    } finally {
      this.activeConversations.delete(job.id);
    }
  }

  /** Send to a conversation currently running in this local fleet instance. */
  async message({ jobId, messageId, content }) {
    const active = this.activeConversations.get(jobId);
    if (!active) throw new FactoryError('NOT_RUNNING', 'Conversation is not active in this fleet instance');
    return this.engine.messageWorker({ ...active, messageId, content });
  }

  /** Request cancellation of a running FLUJO conversation without claiming task closure. */
  async cancel({ jobId }) {
    const active = this.activeConversations.get(jobId);
    if (!active) throw new FactoryError('NOT_RUNNING', 'Conversation is not active in this fleet instance');
    return this.engine.cancelWorkerConversation(active);
  }

  async run(plan, { workerConcurrency = 4, conversationConcurrency = 30 } = {}) {
    const { depth } = validatePlan(plan);
    if (![workerConcurrency,conversationConcurrency].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 100)) {
      throw new TypeError('Fleet concurrency must be from 1 to 100');
    }
    this.prepare(plan);
    const launches = [];
    for (const level of [...new Set(depth.values())].sort((a,b) => a-b)) {
      const group = plan.workers.filter(worker => depth.get(worker.id) === level);
      launches.push(...await boundedMap(group,workerConcurrency,worker => this.#launch(worker)));
    }
    const ready = new Set(launches.filter(result => ['ready','completed'].includes(result.status)).map(result => result.workerId));
    const work = plan.workers.flatMap(worker => worker.conversations.map(job => ({ worker, job })))
      .filter(item => ready.has(item.worker.id));
    const conversations = await boundedMap(work,conversationConcurrency,
      item => this.#runConversation(item.worker,item.job));
    return { launches, conversations,
      skippedConversations: plan.workers.reduce((sum, worker) => sum + (ready.has(worker.id) ? 0 : worker.conversations.length), 0) };
  }
}

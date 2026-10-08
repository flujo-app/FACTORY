import { isAbsolute, resolve } from 'node:path';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FactoryControl, FactoryError, digest } from './control.mjs';
import { executeEffect } from './gateway.mjs';

function completedEffect(control, lease, key, kind, request) {
  let effect;
  try { effect = control.effect(key); }
  catch (error) { if (error.code === 'EFFECT') return null; throw error; }
  if (effect.kind !== kind || effect.scope !== 'task' || effect.scope_id !== lease.scopeId
    || effect.task_id !== lease.scopeId || effect.request_digest !== digest(request)) {
    throw new FactoryError('CONFLICT', 'Effect identity belongs to another operation.');
  }
  return effect.state === 'succeeded' ? effect : null;
}

export function conversationEffectKey(worker, conversationId) {
  return `conversation-${digest({ worker, conversationId })}`;
}

export function conversationMessageKey(worker, conversationId, messageId) {
  return `message-${digest({ worker, conversationId, messageId })}`;
}

export function conversationCancelKey(worker, conversationId) {
  return `cancel-${digest({ worker, conversationId })}`;
}

/** FACTORY-owned dispatch surface for an explicitly configured FLUJO worker adapter. */
export class FactorySwarmEngine {
  constructor(database, adapter) {
    if (typeof database !== 'string' || !database.trim()) throw new TypeError('database path is required');
    if (!adapter || ['provision', 'call', 'retire'].some(name => typeof adapter[name] !== 'function')) {
      throw new TypeError('A worker adapter with provision, call and retire is required');
    }
    this.database = resolve(database);
    this.adapter = adapter;
  }

  async #control(operation) {
    const control = new FactoryControl(this.database);
    try { return await operation(control); } finally { control.close(); }
  }

  /** The caller supplies a claimed task lease and a unique, previously reserved app identity. */
  async provisionWorker({ lease, cellId, app, parentId = lease?.cellId, role = 'developer',
    budgetCents = 0, purpose, input, key = `provision-${cellId}` }) {
    if (typeof app !== 'string' || !/^[a-z][a-z0-9-]{2,62}$/.test(app)
      || !input || typeof input !== 'object' || Array.isArray(input)
      || typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(key)
      || input.app !== undefined && input.app !== app) {
      throw new TypeError('A valid app and matching provision input are required');
    }
    return this.#control(async control => {
      control.authority(lease);
      control.reserveCell({ cellId, parentId, role, budgetCents, purpose });
      const request = { cellId, app, inputDigest: digest(input) };
      const previous = completedEffect(control, lease, key, 'provision', request);
      if (previous) {
        const owned = control.ownedWorker(app);
        if (owned.provisionKey !== key || previous.receipt?.worker !== app
          || previous.receipt?.state !== 'ready') throw new FactoryError('PROVISION_BINDING', 'Recorded worker identity is inconsistent.');
        control.enrollCell(cellId);
        return { dispatched: false, effect: previous };
      }
      const result = await executeEffect(control, lease, { key, kind: 'provision', request },
        async () => {
          const receipt = await this.adapter.provision(input);
          if (receipt?.worker !== app || receipt?.app !== undefined && receipt.app !== app
            || receipt?.state !== 'ready') {
            throw new Error('Worker identity or readiness was not confirmed.');
          }
          return receipt;
        });
      if (result.effect.state === 'succeeded') control.enrollCell(cellId);
      return result;
    });
  }

  /** One immutable call key per external submission. A repeated key observes its prior effect. */
  async callWorker({ lease, worker, input, outputPath }) {
    if (typeof input?.conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.conversationId)) {
      throw new TypeError('An explicit conversationId is required for recoverable FLUJO calls');
    }
    if (typeof outputPath !== 'string' || !isAbsolute(outputPath)) {
      throw new TypeError('An absolute private outputPath is required before dispatch');
    }
    const key = conversationEffectKey(worker, input.conversationId);
    return this.#control(control => {
      control.authority(lease);
      const owned = control.ownedWorker(worker);
      const request = { worker, cellId: lease.cellId, conversationId: input.conversationId,
        provisionKey: owned.provisionKey, inputDigest: digest(input) };
      const previous = completedEffect(control, lease, key, 'flow_call', request);
      if (previous) {
        const receipt = previous.receipt;
        let actual;
        try { actual = createHash('sha256').update(readFileSync(outputPath)).digest('hex'); }
        catch { throw new FactoryError('OUTPUT', 'Recorded conversation output is unavailable.'); }
        if (receipt?.outputPath !== outputPath || receipt?.outputSha256 !== actual) {
          throw new FactoryError('OUTPUT', 'Recorded conversation output changed.');
        }
        return { dispatched: false, effect: previous };
      }
      if (existsSync(outputPath)) throw new FactoryError('OUTPUT', 'Output path already exists before dispatch.');
      return executeEffect(control, lease,
        { key, kind: 'flow_call', request },
        () => this.adapter.call(worker, input), { outputPath });
    });
  }

  /** Admit one steering message during a running Flow call; queued means accepted, not consumed. */
  async messageWorker({ lease, worker, conversationId, messageId, content }) {
    if (typeof this.adapter.message !== 'function') throw new TypeError('Worker adapter cannot steer conversations');
    if (typeof messageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)
      || typeof content !== 'string' || !content.trim()) throw new TypeError('A UUID messageId and content are required');
    const key = conversationMessageKey(worker, conversationId, messageId);
    return this.#control(control => {
      control.authority(lease);
      const owned = control.ownedWorker(worker);
      const request = { worker, cellId: lease.cellId, conversationId,
        provisionKey: owned.provisionKey, messageId, contentDigest: digest(content) };
      const previous = completedEffect(control, lease, key, 'message', request);
      if (previous) {
        if (previous.receipt?.messageId !== messageId || previous.receipt?.state !== 'queued')
          throw new FactoryError('MESSAGE', 'Recorded steering acknowledgement is inconsistent.');
        return { dispatched: false, effect: previous };
      }
      return executeEffect(control, lease, { key, kind: 'message', request }, async () => {
        const receipt = await this.adapter.message(worker, { conversationId, messageId, content });
        if (receipt?.messageId !== messageId || receipt?.state !== 'queued')
          throw new Error('Steering acknowledgement is unconfirmed.');
        return receipt;
      });
    });
  }

  /** Request FLUJO stop an active run; task closure still needs terminal evidence. */
  async cancelWorkerConversation({ lease, worker, conversationId }) {
    if (typeof this.adapter.cancel !== 'function') throw new TypeError('Worker adapter cannot cancel conversations');
    const key = conversationCancelKey(worker, conversationId);
    return this.#control(control => {
      control.authority(lease);
      const owned = control.ownedWorker(worker);
      const request = { worker, cellId: lease.cellId, conversationId,
        provisionKey: owned.provisionKey, reason: 'operator-request' };
      const previous = completedEffect(control, lease, key, 'flow_cancel', request);
      if (previous) {
        if (previous.receipt?.state !== 'requested')
          throw new FactoryError('CANCEL', 'Recorded cancellation acknowledgement is inconsistent.');
        return { dispatched: false, effect: previous };
      }
      return executeEffect(control, lease, { key, kind: 'flow_cancel', request }, async () => {
        const receipt = await this.adapter.cancel(worker, { conversationId });
        if (receipt?.state !== 'requested') throw new Error('Cancellation request was not confirmed.');
        return receipt;
      });
    });
  }

  /** Bounded fanout over independently claimed FACTORY tasks and immutable conversation IDs. */
  async runConversations(jobs, { concurrency = 10 } = {}) {
    if (!Array.isArray(jobs) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
      throw new TypeError('Provide conversation jobs and concurrency from 1 to 100');
    }
    const ids = new Set(), tasks = new Set();
    for (const job of jobs) {
      const conversationId = job?.input?.conversationId;
      if (typeof conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(conversationId)
        || typeof job.worker !== 'string' || !job.worker
        || typeof job.lease?.scopeId !== 'string' || job.lease.scope !== 'task'
        || ids.has(`${job.worker}\0${conversationId}`) || tasks.has(job.lease.scopeId)) {
        throw new TypeError('Jobs need distinct worker/conversation and task identities');
      }
      ids.add(`${job.worker}\0${conversationId}`); tasks.add(job.lease.scopeId);
    }
    const results = new Array(jobs.length);
    let next = 0;
    const work = async () => {
      while (next < jobs.length) {
        const index = next++;
        try { results[index] = { status: 'fulfilled', value: await this.callWorker(jobs[index]) }; }
        catch (reason) { results[index] = { status: 'rejected', reason }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, work));
    return results;
  }

  completeConversation({ taskId, worker, conversationId, closureId = `complete-${taskId}` }) {
    const control = new FactoryControl(this.database);
    try {
      const task = control.task(taskId);
      return control.completeConversationTask(taskId, { closureId, expectedAttempt: task.epoch,
        expectedOwner: task.owner, expectedStatus: task.status,
        expectedTaskControlEpoch: task.control_epoch, expectedFactoryEpoch: control.control().epoch,
        completionEffectKey: conversationEffectKey(worker, conversationId) });
    } finally { control.close(); }
  }

  /** Recover an original completed FLUJO run by read-only observation of its fixed conversation ID. */
  async reconcileCompletedConversation({ taskId, worker, conversationId, outputPath,
    closureId = `complete-${taskId}` }) {
    if (typeof outputPath !== 'string' || !isAbsolute(outputPath))
      throw new TypeError('An absolute private outputPath is required');
    const control = new FactoryControl(this.database);
    try {
      const task = control.task(taskId);
      const operation = task.specification?.operation;
      if (task.specification?.taskType !== 'conversation' || operation?.app !== worker
        || operation?.conversationId !== conversationId || operation?.outputPath !== outputPath)
        throw new FactoryError('CONVERSATION_BINDING', 'Recovery must match the immutable conversation task');
      const key = conversationEffectKey(worker, conversationId);
      const effect = control.effect(key);
      if (effect.kind !== 'flow_call' || effect.scope !== 'task' || effect.scope_id !== taskId
        || effect.task_id !== taskId || effect.owner !== operation.cellId
        || effect.owner_epoch !== task.epoch || effect.control_epoch !== task.control_epoch && task.status !== 'completed'
        || effect.request_digest !== digest({worker,cellId:operation.cellId,conversationId,
          provisionKey:operation.provisionKey,inputDigest:operation.inputDigest}))
        throw new FactoryError('CONVERSATION_BINDING', 'Original Flow call identity is inconsistent');
      if (task.status === 'completed') {
        const prior = control.db.prepare("SELECT details FROM events WHERE type='task_completed' AND subject=? ORDER BY seq DESC LIMIT 1").get(taskId);
        const recorded = prior ? JSON.parse(prior.details) : null;
        if (recorded?.closureId !== closureId || recorded?.result?.completionEffectKey !== key
          || effect.state !== 'succeeded')
          throw new FactoryError('CONVERSATION_EVIDENCE', 'Recorded completion is inconsistent');
        const actual = createHash('sha256').update(readFileSync(outputPath)).digest('hex');
        if (effect.receipt?.outputPath !== outputPath || effect.receipt?.outputSha256 !== actual)
          throw new FactoryError('CONVERSATION_EVIDENCE', 'Recorded output changed');
        return control.completeConversationTask(taskId, { closureId,
          expectedAttempt: recorded.result.attempt, expectedOwner: recorded.result.previousOwner,
          expectedStatus: 'running', expectedTaskControlEpoch: recorded.result.previousTaskControlEpoch,
          expectedFactoryEpoch: recorded.expectedFactoryEpoch, completionEffectKey: key });
      }
      if (task.status !== 'running') throw new FactoryError('TASK', 'Running conversation task is required');
      if (!['running','unknown','succeeded'].includes(effect.state))
        throw new FactoryError('CONVERSATION_EVIDENCE', 'Original Flow call is not recoverable as completed');
      if (effect.state !== 'succeeded') {
        if (typeof this.adapter.observeCompleted !== 'function')
          throw new TypeError('Worker adapter cannot observe completed conversations');
        const observed = await this.adapter.observeCompleted(worker, { conversationId });
        if (observed?.conversationId !== conversationId || observed?.status !== 'completed'
          || typeof observed.output !== 'string')
          throw new FactoryError('CONVERSATION_EVIDENCE', 'FLUJO completion is not confirmed');
        const bytes = Buffer.from(observed.output, 'utf8');
        const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
        if (!existsSync(outputPath)) await writeFile(outputPath, bytes, { mode: 0o600, flag: 'wx' });
        const file = lstatSync(outputPath);
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1
          || createHash('sha256').update(readFileSync(outputPath)).digest('hex') !== expectedSha256)
          throw new FactoryError('OUTPUT', 'Recovered conversation output conflicts with retained bytes');
        if (control.effect(key).state !== 'succeeded')
          control.settleEffect(key, 'succeeded', { outputPath, outputSha256: expectedSha256, reconciled: true });
      }
      const current = control.task(taskId);
      return control.completeConversationTask(taskId, { closureId,
        expectedAttempt: current.epoch, expectedOwner: current.owner,
        expectedStatus: current.status, expectedTaskControlEpoch: current.control_epoch,
        expectedFactoryEpoch: control.control().epoch, completionEffectKey: key });
    } finally { control.close(); }
  }

  /** Observe FLUJO after a stop request and atomically close only its terminal cancelled task. */
  async reconcileCancelledConversation({ taskId, worker, conversationId,
    closureId = `cancel-${taskId}` }) {
    const control = new FactoryControl(this.database);
    try {
      const task = control.task(taskId);
      const prior = task.status === 'cancelled'
        ? control.db.prepare("SELECT details FROM events WHERE type='task_cancelled' AND subject=? ORDER BY seq DESC LIMIT 1").get(taskId)
        : null;
      const recorded = prior ? JSON.parse(prior.details) : null;
      if (task.status !== 'cancelled' && typeof this.adapter.observeCancelled !== 'function')
        throw new TypeError('Worker adapter cannot observe cancelled conversations');
      const observation = task.status === 'cancelled' ? null
        : await this.adapter.observeCancelled(worker, { conversationId });
      return control.cancelConfirmedConversationTask(taskId, {
        closureId, expectedAttempt: recorded?.result?.attempt ?? task.epoch,
        expectedOwner: recorded?.result?.previousOwner ?? task.owner,
        expectedStatus: recorded ? 'running' : task.status,
        expectedTaskControlEpoch: recorded?.result?.previousTaskControlEpoch ?? task.control_epoch,
        expectedFactoryEpoch: recorded?.expectedFactoryEpoch ?? control.control().epoch,
        flowEffectKey: conversationEffectKey(worker, conversationId),
        cancellationEffectKey: conversationCancelKey(worker, conversationId),
      }, observation);
    } finally { control.close(); }
  }

  /** Provider retirement is recorded; cell closure still requires provider evidence. */
  async retireWorker({ app, key = `retire-${app}` }) {
    return this.#control(async control => {
      const admitted = control.admitOwnedRetirement({ key, app });
      if (!admitted.fresh) return { dispatched: false, effect: control.effect(key) };
      control.startOwnedRetirement(key);
      try {
        const receipt = await this.adapter.retire(app);
        if (receipt?.worker !== app || receipt?.app !== undefined && receipt.app !== app
          || !['destroyed', 'retired'].includes(receipt?.state)) {
          throw new Error('Worker retirement was not confirmed.');
        }
        return { dispatched: true, effect: control.settleEffect(key, 'succeeded', receipt) };
      } catch {
        return { dispatched: true, effect: control.settleEffect(key, 'unknown',
          { reason: 'Provider retirement requires reconciliation.' }) };
      }
    });
  }

  /** Resolve a held retirement from a fresh, read-only provider observation. */
  async reconcileRetiredWorker({ app, key = `retire-${app}` }) {
    if (typeof this.adapter.observeRetired !== 'function')
      throw new TypeError('The adapter must provide read-only retirement observation.');
    return this.#control(async control => {
      const effect = control.effect(key);
      if (effect.kind !== 'retire' || effect.scope !== 'cleanup' || effect.scope_id !== app)
        throw new FactoryError('CONFLICT', 'Retirement effect belongs to another worker.');
      if (effect.state === 'succeeded') return { reconciled: false, effect };
      if (!['running', 'unknown'].includes(effect.state))
        throw new FactoryError('EFFECT', 'An unsettled retirement is required.');
      const observation = await this.adapter.observeRetired(app);
      if (observation?.app !== app || observation?.worker !== app)
        throw new FactoryError('RETIREMENT', 'Retirement observation identity did not match.');
      if (observation.state !== 'destroyed') return { reconciled: false, effect: control.effect(key) };
      return { reconciled: true, effect: control.settleEffect(key, 'succeeded',
        { app, worker: app, state: 'destroyed', reconciled: true }) };
    });
  }
}

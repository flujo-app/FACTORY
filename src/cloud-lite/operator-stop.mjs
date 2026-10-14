const stoppedThreadStatuses = new Set(['idle', 'archived']);
const controlledStopTurnStatuses = new Set(['completed', 'interrupted']);
const observedTerminalTurnStatuses = new Set(['completed', 'interrupted', 'failed']);

function validIdentity(value) { return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value); }

/** A stop receipt is emitted only after native control and a readback prove this thread idle. */
export class NativeOperatorStop {
  constructor({ rpc, threadId, getTurn, trace, flush, timeoutMs = 30000 }) {
    this.rpc = rpc; this.threadId = threadId; this.getTurn = getTurn; this.trace = trace; this.flush = flush; this.timeoutMs = timeoutMs;
    this.pendingCommands = new Map(); this.terminalWaiters = new Map(); this.completed = new Map(); this.terminals = new Map(); this.commandTargets = new Map();
  }

  observeTerminal({ threadId, turnId, status }) {
    if (threadId !== this.threadId || !validIdentity(turnId) || !['completed', 'interrupted', 'failed'].includes(status)) return;
    this.terminals.set(turnId, status);
    const pending = this.terminalWaiters.get(turnId);
    if (pending) { clearTimeout(pending.timer); this.terminalWaiters.delete(turnId); pending.resolve(status); }
  }

  observeTurnStarted({ threadId }) {
    if (threadId === this.threadId) this.completed.clear();
  }

  invalidateReceipts() { this.completed.clear(); }

  stop(commandId, target = {}) {
    if (typeof commandId !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(commandId)) return Promise.reject(new TypeError('Operator stop requires a stable command identity.'));
    if (target.expectedThreadId !== this.threadId || target.expectedTurnId !== null && !validIdentity(target.expectedTurnId)) {
      return Promise.reject(new TypeError('Operator stop requires the exact expected thread and turn identities.'));
    }
    const targetKey = JSON.stringify([target.expectedThreadId, target.expectedTurnId]);
    const previousTarget = this.commandTargets.get(commandId);
    if (previousTarget && previousTarget !== targetKey) return Promise.reject(new Error('Stable operator stop identity cannot change its native target.'));
    this.commandTargets.set(commandId, targetKey);
    if (this.completed.has(commandId)) return Promise.resolve(this.completed.get(commandId));
    if (this.pendingCommands.has(commandId)) return this.pendingCommands.get(commandId);
    const task = this.perform(commandId, target).then(receipt => { this.completed.set(commandId, receipt); return receipt; });
    this.pendingCommands.set(commandId, task);
    task.finally(() => { if (this.pendingCommands.get(commandId) === task) this.pendingCommands.delete(commandId); }).catch(() => {});
    return task;
  }

  async perform(commandId, target) {
    const initial = await this.readThread();
    let turn = this.getTurn();
    if ((turn?.id ?? null) !== target.expectedTurnId) throw new Error('Current native turn differs from the stop command target.');
    let turnStatus = turn?.status;
    let targetTurnId;
    if (initial.status === 'active') {
      if (!validIdentity(turn?.id) || turnStatus && turnStatus !== 'inProgress') throw new Error('Active native thread has no matching active turn identity.');
      targetTurnId = turn.id;
      const terminal = this.waitForTerminal(targetTurnId);
      // Do not acknowledge or report success unless native interrupt itself succeeded.
      try { await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: turn.id }, this.timeoutMs); }
      catch (error) { this.cancelTerminalWait(targetTurnId); throw error; }
      turnStatus = await terminal;
      if (!controlledStopTurnStatuses.has(turnStatus)) throw new Error('The requested turn ended in failure, not a controlled stop.');
      turn = this.getTurn();
      if (turn?.id !== targetTurnId) throw new Error('A newer turn replaced the requested stop target.');
    } else if (!stoppedThreadStatuses.has(initial.status)) {
      throw new Error('Native thread readback did not prove an idle or archived thread.');
    } else if (turnStatus === 'inProgress') {
      throw new Error('Native thread is idle but its latest observed turn is still active.');
    }

    targetTurnId ??= turn?.id;
    const readback = await this.readThread();
    if (!stoppedThreadStatuses.has(readback.status)) throw new Error('Native thread became active before stop confirmation.');
    const currentTurn = this.getTurn();
    if ((currentTurn?.id ?? null) !== target.expectedTurnId) throw new Error('Native turn changed while confirming the stop target.');
    if (targetTurnId && currentTurn?.id !== targetTurnId) throw new Error('A newer turn replaced the requested stop target.');
    const finalTurnStatus = initial.status === 'active' ? turnStatus : currentTurn?.status;
    if (finalTurnStatus && !observedTerminalTurnStatuses.has(finalTurnStatus)) throw new Error('Native stop target is not terminal.');
    const receipt = { commandId, expectedThreadId: target.expectedThreadId, expectedTurnId: target.expectedTurnId,
      threadId: this.threadId, threadStatus: readback.status,
      ...(targetTurnId ? { turn: { id: targetTurnId, ...(finalTurnStatus ? { status: finalTurnStatus } : {}) } } : {}) };
    this.trace('thread/status/changed', { threadId: this.threadId, status: { type: readback.status } });
    this.trace('native.operator.stop.completed', receipt);
    await this.flush();
    return receipt;
  }

  waitForTerminal(turnId) {
    const existing = this.terminals.get(turnId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.terminalWaiters.delete(turnId); reject(new Error('Native turn did not reach a terminal notification before stop timeout.')); }, this.timeoutMs);
      this.terminalWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  cancelTerminalWait(turnId) {
    const pending = this.terminalWaiters.get(turnId);
    if (pending) { clearTimeout(pending.timer); this.terminalWaiters.delete(turnId); }
  }

  async readThread() {
    const result = await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: false }, this.timeoutMs);
    if (result?.thread?.id !== this.threadId) throw new Error('Native thread readback identity did not match the stop target.');
    return { status: result.thread.status?.type };
  }
}

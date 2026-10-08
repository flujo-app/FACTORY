import { resolve } from 'node:path';
import { FactoryControl } from './control.mjs';

/** A local, durable coordinator. No provider calls or worker processes are started. */
export class Factory {
  constructor(database) {
    if (typeof database !== 'string' || !database.trim()) throw new TypeError('database path is required');
    this.database = resolve(database);
  }

  #withControl(operation) {
    const control = new FactoryControl(this.database);
    try { return operation(control); } finally { control.close(); }
  }

  createSwarm({ mission, budgetCents = 0, agents = [], maxCells = agents.length + 1, maxDepth = 2 } = {}) {
    if (!Array.isArray(agents)) throw new TypeError('agents must be an array');
    return this.#withControl(control => {
      control.initialize({ mission, budgetCents, maxCells, maxDepth });
      for (const agent of agents) {
        control.reserveCell({ cellId: agent.id, parentId: agent.parentId ?? 'root', role: agent.role ?? 'developer', budgetCents: agent.budgetCents ?? 0, purpose: agent.purpose ?? mission });
        control.enrollCell(agent.id);
      }
      return control.status();
    });
  }

  addAgent({ id, parentId = 'root', role = 'developer', budgetCents = 0, purpose } = {}) {
    return this.#withControl(control => {
      const cell = control.reserveCell({ cellId: id, parentId, role, budgetCents, purpose: purpose ?? control.control().policy.mission });
      control.enrollCell(id);
      return { ...cell, status: 'ready' };
    });
  }

  addTask({ id, projectId, branch, problem, acceptance, baseline } = {}) {
    return this.#withControl(control => control.createTask({ taskId: id, projectId, branch,
      specification: { problem, acceptance, baseline } }));
  }

  claimTask({ taskId, agentId, ttlMs = 60000 } = {}) {
    return this.#withControl(control => control.claimTask(taskId, agentId, ttlMs));
  }

  status() { return this.#withControl(control => control.status()); }
  pause() { return this.#withControl(control => control.pause()); }
  resume() { return this.#withControl(control => control.resume()); }
}

export { FactoryControl } from './control.mjs';

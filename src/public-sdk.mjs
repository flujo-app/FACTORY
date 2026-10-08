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
    if (typeof mission !== 'string' || !mission.trim()) throw new TypeError('mission is required');
    if (!Number.isSafeInteger(budgetCents) || budgetCents < 0) throw new TypeError('budgetCents must be a nonnegative integer');
    if (!Number.isSafeInteger(maxCells) || maxCells < agents.length + 1) throw new TypeError('maxCells must include the root and every agent');
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new TypeError('maxDepth must be positive');
    const ids = new Set();
    let allocated = 0;
    for (const agent of agents) {
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)
        || typeof agent.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(agent.id)
        || agent.id === 'root' || ids.has(agent.id)) throw new TypeError('agent ids must be unique and valid');
      if (agent.parentId !== undefined && agent.parentId !== 'root') throw new TypeError('createSwarm agents must have root as parent; use addAgent for nested cells');
      if (agent.role !== undefined && !['developer', 'verifier', 'watcher', 'coordinator'].includes(agent.role)) throw new TypeError('invalid agent role');
      if (agent.purpose !== undefined && (typeof agent.purpose !== 'string' || !agent.purpose.trim())) throw new TypeError('agent purpose must be nonempty');
      const allocation = agent.budgetCents ?? 0;
      if (!Number.isSafeInteger(allocation) || allocation < 0) throw new TypeError('agent budgetCents must be a nonnegative integer');
      allocated += allocation;
      if (!Number.isSafeInteger(allocated) || allocated > budgetCents) throw new TypeError('agent allocations exceed swarm budget');
      ids.add(agent.id);
    }
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

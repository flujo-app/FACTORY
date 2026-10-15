import { createHash, randomBytes } from 'node:crypto';

export const secret = () => randomBytes(32).toString('hex');
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function validateCloudLitePlan(input) {
  if (!input || typeof input !== 'object') throw new TypeError('A cloud lite-worker plan is required.');
  const plan = { cpuKind: 'shared', cpus: 2, memoryMb: 4096, diskGb: 20, machines: 1,
    agentsPerMachine: 10, region: 'iad', model: 'gpt-6.1-sol', subagentModel: 'gpt-6-luna', reasoningEffort: 'medium', ...input };
  for (const name of ['runId', 'app']) if (!/^[a-z][a-z0-9-]{2,62}$/.test(plan[name] ?? '')) throw new TypeError(`Invalid ${name}.`);
  if (!['shared', 'performance'].includes(plan.cpuKind)) throw new TypeError('Invalid cpuKind.');
  for (const name of ['cpus', 'memoryMb', 'diskGb', 'machines', 'agentsPerMachine']) {
    if (!Number.isSafeInteger(plan[name]) || plan[name] < 1) throw new TypeError(`${name} must be a positive integer.`);
  }
  if (plan.memoryMb % 256) throw new TypeError('memoryMb must be a multiple of 256.');
  if (!/^[a-z]{3}$/.test(plan.region)) throw new TypeError('Invalid region.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(plan.repository ?? '')) throw new TypeError('A GitHub owner/repository is required.');
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) throw new TypeError('A goal is required.');
  if (plan.workflow !== undefined && plan.workflow !== 'verified-v1') throw new TypeError('Unsupported workflow profile.');
  if (plan.workflow && plan.agentsPerMachine < 3) throw new TypeError('Verified workflows require a coordinator, implementer and independent verifier.');
  if (plan.repositoryRevision !== undefined && !/^[0-9a-f]{40}$/.test(plan.repositoryRevision)) throw new TypeError('repositoryRevision must be an immutable commit.');
  return plan;
}
export function agentInventory(plan) {
  return Array.from({ length: plan.machines }, (_, machine) => Array.from({ length: plan.agentsPerMachine }, (_, agent) => ({
    id: `m${machine}-a${agent}`, machine: `m${machine}`, role: agent === 0 ? 'orchestrator' : 'subagent',
    parentId: agent === 0 ? 'root' : `m${machine}-a0`,
  }))).flat();
}
export function canMessage(sender, recipient) {
  return sender.machine === recipient.machine || sender.role === 'orchestrator' && recipient.role === 'orchestrator';
}
export function redact(value, secrets = []) {
  let raw = JSON.stringify(value);
  for (const credential of secrets.filter(x => typeof x === 'string' && x.length >= 8)) {
    raw = raw.split(JSON.stringify(credential).slice(1, -1)).join('[REDACTED]');
  }
  raw = raw.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]');
  return JSON.parse(raw);
}
export function machineConfig(plan, { image, volumeId, index, environment }) {
  return {
    image, env: environment,
    guest: { cpu_kind: plan.cpuKind, cpus: plan.cpus, memory_mb: plan.memoryMb },
    mounts: [{ volume: volumeId, path: '/data' }],
    metadata: { 'factory.run': plan.runId, 'factory.machine': `m${index}`, 'factory.runtime': 'codex-lite' },
    restart: { policy: 'no' },
    // Same private topology as flujo-cloud: host connects using its owned proxy;
    // remote Codex sessions use the coordinator's exact Fly private Machine DNS.
    services: [],
  };
}

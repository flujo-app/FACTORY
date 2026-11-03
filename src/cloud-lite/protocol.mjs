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
  if (plan.repository !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(plan.repository)) throw new TypeError('Optional repository must be a GitHub owner/repository.');
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) throw new TypeError('A goal is required.');
  if (plan.workflow !== undefined && plan.workflow !== 'verified-v1') throw new TypeError('Unsupported workflow profile.');
  if (plan.workflow && plan.agentsPerMachine < 3) throw new TypeError('Verified workflows require a coordinator, implementer and independent verifier.');
  if (plan.repositoryRevision !== undefined && (!plan.repository || !/^[0-9a-f]{40}$/.test(plan.repositoryRevision))) throw new TypeError('repositoryRevision requires a repository and immutable commit.');
  if(plan.collection){
    const url=new URL(plan.collection.url);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new TypeError('Use an archive URL without credentials.');
    if(plan.collection.intervalMs!==undefined&&(!Number.isSafeInteger(plan.collection.intervalMs)||plan.collection.intervalMs<1000))throw new TypeError('Collection interval must be at least 1000 ms.');
  }
  if(plan.shutdown){
    if(!plan.collection || typeof plan.shutdown.deadlineUtc!=='string' || !Number.isFinite(Date.parse(plan.shutdown.deadlineUtc)))throw new TypeError('Automatic deadline shutdown requires evidence collection and an explicit UTC deadline.');
  }
  if (plan.modelProvider !== undefined) validateModelProvider(plan.modelProvider);
  if (plan.supervision !== undefined && !['autonomous', 'operator'].includes(plan.supervision)) throw new TypeError('supervision must be autonomous or operator.');
  if (plan.sandbox !== undefined && !CODEX_SANDBOXES.includes(plan.sandbox)) throw new TypeError(`sandbox must be one of ${CODEX_SANDBOXES.join(', ')}.`);
  for (const name of ['boardTools', 'traceDeltas']) if (plan[name] !== undefined && typeof plan[name] !== 'boolean') throw new TypeError(`${name} must be true or false.`);
  if (plan.workflow && (plan.supervision === 'operator' || plan.boardTools === false)) throw new TypeError('Verified workflows need automatic wakes and the board tools.');
  if (plan.monitorIntervalMs !== undefined && (!Number.isSafeInteger(plan.monitorIntervalMs) || plan.monitorIntervalMs < 1000)) throw new TypeError('monitorIntervalMs must be at least 1000.');
  if (plan.agentInstructions !== undefined && (typeof plan.agentInstructions !== 'string' || !plan.agentInstructions.trim())) throw new TypeError('agentInstructions must be non-empty text.');
  if (plan.prepare !== undefined) {
    const prepare = plan.prepare;
    if (!prepare || typeof prepare !== 'object' || !Array.isArray(prepare.argv) || !prepare.argv.length || prepare.argv.some(arg => typeof arg !== 'string' || !arg))
      throw new TypeError('prepare needs a non-empty argv list of strings.');
    if (prepare.spec !== undefined && (!prepare.spec || typeof prepare.spec !== 'object' || Array.isArray(prepare.spec))) throw new TypeError('prepare.spec must be an object.');
    if (prepare.timeoutMs !== undefined && (!Number.isSafeInteger(prepare.timeoutMs) || prepare.timeoutMs < 1000)) throw new TypeError('prepare.timeoutMs must be at least 1000.');
  }
  return plan;
}
export const CODEX_SANDBOXES = ['danger-full-access', 'workspace-write', 'read-only'];
// Variables the runtime sets for the Codex process itself; a provider key must not replace them.
const RESERVED_ENVIRONMENT = new Set(['PATH', 'HOME', 'CODEX_HOME', 'GH_TOKEN', 'GIT_TERMINAL_PROMPT']);
const credentialFreeHttps = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
};
/** A self-hosted OpenAI-compatible (Responses API) model provider for the Codex workers. */
export function validateModelProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new TypeError('modelProvider must be an object.');
  if (!/^[a-z][a-z0-9_-]{1,40}$/.test(provider.id ?? '')) throw new TypeError('modelProvider.id must be a short lowercase name.');
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(provider.envKey ?? '') || RESERVED_ENVIRONMENT.has(provider.envKey)) throw new TypeError('modelProvider.envKey must name a dedicated environment variable.');
  if (!Array.isArray(provider.baseUrls) || !provider.baseUrls.length || provider.baseUrls.length > 64 || !provider.baseUrls.every(credentialFreeHttps))
    throw new TypeError('modelProvider.baseUrls must list https URLs without credentials, query or fragment.');
  for (const name of ['name', 'model']) if (provider[name] !== undefined && (typeof provider[name] !== 'string' || !provider[name].trim() || provider[name].length > 200)) throw new TypeError(`modelProvider.${name} must be short text.`);
  for (const name of ['contextWindow', 'autoCompactTokenLimit', 'toolOutputTokenLimit']) {
    if (provider[name] !== undefined && (!Number.isSafeInteger(provider[name]) || provider[name] < 1000)) throw new TypeError(`modelProvider.${name} must be a token count of at least 1000.`);
  }
  if (provider.contextWindow && provider.autoCompactTokenLimit && provider.autoCompactTokenLimit >= provider.contextWindow) throw new TypeError('modelProvider.autoCompactTokenLimit must be below contextWindow.');
  for (const name of ['requestMaxRetries', 'streamMaxRetries']) {
    if (provider[name] !== undefined && (!Number.isSafeInteger(provider[name]) || provider[name] < 0 || provider[name] > 100)) throw new TypeError(`modelProvider.${name} must be between 0 and 100.`);
  }
  if (provider.streamIdleTimeoutMs !== undefined && (!Number.isSafeInteger(provider.streamIdleTimeoutMs) || provider.streamIdleTimeoutMs < 1000)) throw new TypeError('modelProvider.streamIdleTimeoutMs must be at least 1000.');
  return provider;
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

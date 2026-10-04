import { validateNativeMission } from './native-mission-contract.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
export function powerCheck(value, code = 'WORKER_POWER_BINDING') {
  if (!value) throw Object.assign(new Error('Worker power operation refused.'), { code });
}
export function validateWorkerPowerBinding(value) {
  const fields = ['schemaVersion', 'cellId', 'app', 'provisionKey', 'machineId', 'instanceId',
    'machineName', 'owner', 'imageDigest', 'configSha256', 'worker'];
  powerCheck(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k)));
  powerCheck(value.schemaVersion === 1 && ['cellId', 'provisionKey', 'machineId', 'instanceId', 'machineName'].every(k => ID.test(value[k] ?? ''))
    && /^[a-z][a-z0-9-]{2,62}$/.test(value.app ?? '')
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.owner ?? '') && /^sha256:[a-f0-9]{64}$/.test(value.imageDigest ?? '')
    && HASH.test(value.configSha256 ?? ''));
  validateNativeMission({ schemaVersion: 1, missionId: '0'.repeat(32), cellId: value.cellId,
    app: value.app, provisionKey: value.provisionKey, worker: value.worker,
    flowId: 'power-binding', flowSha256: '0'.repeat(64), paid: { provider: 'fly', ceilingCents: 1 } });
  return structuredClone(value);
}

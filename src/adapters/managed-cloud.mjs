import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createManagedCloudSourceBinding } from './managed-cloud-source.mjs';

const METHODS = ['sources', 'preflight', 'up', 'call', 'list', 'down'];
const SAFE_CODES = new Set(['MANAGED_BUSY', 'EEXIST', 'ENOENT', 'IMAGE_REGISTRY', 'IMAGE_COMPATIBILITY']);
const NO_PROGRESS = () => {};

function inputError(message) {
  const error = new TypeError(message);
  error.code = 'MANAGED_CLOUD_INPUT_INVALID';
  return error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw inputError(`${label} must be a plain object.`);
  }
  return value;
}

function workerId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{2,62}$/.test(value)) {
    throw inputError('Provide a valid managed worker ID.');
  }
  return value;
}

function operationError(operation, original) {
  // Never attach the original error as a cause: messages/stacks can contain credentials.
  const error = new Error(`ManagedCloud ${operation} did not provide a confirmed result. Reconcile before retrying.`);
  error.code = SAFE_CODES.has(original?.code) ? original.code : 'MANAGED_CLOUD_OPERATION_UNCONFIRMED';
  error.operation = operation;
  error.outcome = 'unknown';
  error.reconciliationRequired = true;
  return error;
}

function selected(value, keys) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined)
    .map(key => {
      const field = value[key];
      if (field !== null && !['string', 'number', 'boolean'].includes(typeof field)) {
        throw new Error('Invalid receipt field.');
      }
      if (typeof field === 'number' && !Number.isFinite(field)) throw new Error('Invalid receipt number.');
      return [key, field];
    }));
}

function knownSecrets(...environments) {
  return [...new Set(environments.flatMap(environment => Object.entries(environment ?? {})
    .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL/i.test(key)
      && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value)))];
}

function withholdKnownSecrets(value, secrets) {
  const serialized = JSON.stringify(value);
  if (secrets.some(secret => serialized.includes(secret)
      || serialized.includes(JSON.stringify(secret).slice(1, -1)))) {
    throw new Error('A known credential was present in the result.');
  }
  return value;
}

function origin(value) {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid source origin.');
  }
  return url.origin;
}

function flowReceipt(flows) {
  if (flows === undefined) return undefined;
  if (!Array.isArray(flows)) throw new Error('Invalid flow inventory.');
  return flows.map(flow => selected(object(flow, 'Flow'), ['id', 'name']));
}

function imageReceipt(image) {
  if (image === undefined) return undefined;
  if (typeof image === 'string') return image;
  return selected(object(image, 'Image'), [
    'image', 'mode', 'compatibility', 'applicationVersion', 'version', 'revision',
    'selectedTag', 'snapshotFormatVersion', 'layoutVersion', 'workerProtocolVersion',
    'architecture', 'os', 'indexDigest',
  ]);
}

function deploymentReceipt(value) {
  object(value, 'Managed result');
  const receipt = selected(value, [
    'app', 'worker', 'workspace', 'org', 'region', 'machineId', 'state', 'phase', 'localOnly', 'stateSource',
  ]);
  if (value.source !== undefined) receipt.source = origin(value.source);
  if (value.flows !== undefined) receipt.flows = flowReceipt(value.flows);
  if (value.image !== undefined) receipt.image = imageReceipt(value.image);
  if (typeof value.readyToDeploy === 'boolean') receipt.readyToDeploy = value.readyToDeploy;
  // Journal filenames, auth material, environment and arbitrary nested fields stay private.
  return receipt;
}

async function packageInformation(modulePath) {
  // ManagedCloud is exported from lib/managed.mjs. Metadata is informational only.
  try {
    const info = JSON.parse(await readFile(path.join(path.dirname(modulePath), '..', 'package.json'), 'utf8'));
    if (info.name === 'flujo-cloud' && typeof info.version === 'string'
        && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(info.version)) {
      return { packageName: info.name, packageVersion: info.version };
    }
  } catch { /* Optional metadata never changes execution capability. */ }
  return {};
}

/**
 * Thin adapter over flujo-cloud's ManagedCloud. Constructing/importing performs no cloud operation.
 * Receipts omit credentials. call() returns untrusted worker output separately from status evidence;
 * callers must not place its body into a public operational receipt or treat it as task acceptance.
 */
export async function createManagedCloudAdapter({ modulePath, options = {}, service, sourceWorkerProfile, privateFiles } = {}) {
  object(options, 'ManagedCloud options');
  if (sourceWorkerProfile !== undefined && (service !== undefined || Object.hasOwn(options, 'discover'))) {
    throw inputError('A bound source requires module construction without a discovery override.');
  }
  const binding = sourceWorkerProfile === undefined ? null
    : createManagedCloudSourceBinding({ sourceWorkerProfile, privateFiles });
  let source;
  if (service !== undefined) {
    source = { kind: 'injected', serviceName: 'ManagedCloud' };
  } else {
    if (typeof modulePath !== 'string' || !path.isAbsolute(modulePath)) {
      throw inputError('Provide an explicit absolute ManagedCloud module path.');
    }
    try {
      const { ManagedCloud } = await import(pathToFileURL(modulePath).href);
      if (typeof ManagedCloud !== 'function') throw new Error('Missing ManagedCloud export.');
      service = new ManagedCloud({ ...options, ...(binding ? { discover: binding.discover } : {}), progress: NO_PROGRESS });
    } catch (error) {
      throw operationError('load', error);
    }
    source = { kind: 'module', serviceName: 'ManagedCloud', modulePath,
      ...await packageInformation(modulePath) };
  }
  if (!service || METHODS.some(method => typeof service[method] !== 'function')) {
    throw inputError('The service must implement sources, preflight, up, call, list and down.');
  }

  async function invoke(operation, method, args, receipt) {
    try {
      if (binding) await binding.refreshSecrets();
      const result = receipt(await service[method](...args));
      // Upstream also checks per-worker control credentials before returning call output.
      return withholdKnownSecrets(result, [...knownSecrets(options.env, service.env), ...(binding?.secrets() ?? [])]);
    }
    catch (error) { throw operationError(operation, error); }
  }

  return Object.freeze({
    source: Object.freeze(source),
    capabilities: Object.freeze({
      adapter: 'managed-cloud', protocolVersion: 1,
      executionModel: 'delegated-workspace-copy', nativePeerAutonomy: false,
      recursiveProvisioning: false, workspaceSynchronization: false,
      liveHealthInspection: false, inventorySource: 'local-managed-records',
      automaticRetry: false, automaticCleanup: false,
    }),
    async sources() {
      return invoke('sources', 'sources', [], values => {
        if (!Array.isArray(values)) throw new Error('Invalid source inventory.');
        return values.map(value => {
          object(value, 'Source');
          return { ...selected(value, ['instanceId', 'appRoot', 'dataRoot']), source: origin(value.source) };
        });
      });
    },
    async preflight(input) {
      const value = object(input, 'Preflight input');
      const admitted = binding ? binding.input(value) : value;
      if (binding) {
        try { await binding.discover({ source: admitted.source }); }
        catch (error) { throw operationError('preflight', error); }
      }
      return invoke('preflight', 'preflight', [admitted], deploymentReceipt);
    },
    async provision(input) {
      const value = object(input, 'Provision input');
      const admitted = binding ? binding.input(value) : value;
      if (binding) {
        try { await binding.discover({ source: admitted.source }); }
        catch (error) { throw operationError('provision', error); }
      }
      return invoke('provision', 'up', [admitted], deploymentReceipt);
    },
    async call(id, input) {
      workerId(id);
      object(input, 'Call input');
      object(input.request, 'Flow request');
      if (input.conversationId !== undefined && (typeof input.conversationId !== 'string' || !input.conversationId.trim())) {
        throw inputError('conversationId must be a nonempty string.');
      }
      if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs)
          || input.timeoutMs < 1_000 || input.timeoutMs > 3_600_000)) {
        throw inputError('timeoutMs must be an integer between 1000 and 3600000.');
      }
      return invoke('call', 'call', [id, input], value => {
        object(value, 'Call result');
        if (typeof value.body !== 'string' || (value.contentType !== null && typeof value.contentType !== 'string')) {
          throw new Error('Invalid call output.');
        }
        return { contentType: value.contentType, body: value.body };
      });
    },
    async inspect(id) {
      workerId(id);
      return invoke('inspect', 'list', [], values => {
        if (!Array.isArray(values)) throw new Error('Invalid managed inventory.');
        const matches = values.filter(value => value?.worker === id);
        if (matches.length > 1) throw new Error('Ambiguous managed inventory.');
        return {
          worker: id, found: matches.length === 1,
          inventory: matches.length ? deploymentReceipt(matches[0]) : null,
          inventoryEvidence: 'cached-local-records',
          liveHealth: { status: 'unobserved', reason: 'ManagedCloud.list does not poll the live worker.' },
        };
      });
    },
    async retire(id) {
      return invoke('retire', 'down', [workerId(id)], deploymentReceipt);
    },
  });
}

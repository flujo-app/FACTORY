import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined)
  .map(key => [key, value[key]]));

/** Read-only discovery, workspace counts and official-image selection. Never provisions or runs a Flow. */
export async function readOnlyCloudPreflight({ modulePath, source, workspace, includeModelMetadata = false, env = process.env } = {}) {
  if (typeof modulePath !== 'string' || !path.isAbsolute(modulePath)) throw new Error('An absolute ManagedCloud module path is required.');
  if (typeof source !== 'string') throw new Error('Select an explicit local FLUJO origin.');
  if (workspace !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)) throw new Error('Invalid workspace name.');
  const { ManagedCloud } = await import(pathToFileURL(modulePath).href);
  if (typeof ManagedCloud !== 'function') throw new Error('The selected module does not export ManagedCloud.');
  const managed = new ManagedCloud({ env, progress: () => {} });
  // ManagedCloud verifies loopback origin and the source process before returning its private token.
  const selected = await managed.source({ source });
  const inventory = await managed.workspaces({ source });
  const chosenWorkspace = workspace ?? inventory.defaultWorkspace;
  const exists = inventory.workspaces.some(item => item.name === chosenWorkspace);
  const report = {
    readOnly: true,
    source: { origin: selected.source, instanceId: selected.instanceId, appRoot: selected.appRoot, dataRoot: selected.dataRoot },
    workspaces: { count: inventory.workspaces.length, names: inventory.workspaces.map(item => item.name) },
    selectedWorkspace: { name: chosenWorkspace, exists },
  };
  if (!exists) {
    report.imageSelection = { status: 'not-checked', reason: 'The selected workspace does not exist.' };
    return report;
  }
  const infoUrl = new URL('/api/snapshot/info', selected.source);
  infoUrl.searchParams.set('workspace', chosenWorkspace);
  const info = await managed.json(infoUrl, { token: selected.token, workspace: chosenWorkspace,
    label: 'Read-only snapshot metadata', maxBytes: 64 * 1024 });
  report.snapshot = {
    capability: info.capability,
    workerCompatibility: pick(info.workerCompatibility, ['applicationVersion', 'snapshotFormatVersion',
      'layoutVersion', 'workerProtocolVersion', 'revision']),
  };
  const configurations = await Promise.all(['/api/model', '/api/flow'].map(async pathname => {
    const url = new URL(pathname, selected.source);
    url.searchParams.set('workspace', chosenWorkspace);
    const values = await managed.json(url, { token: selected.token, workspace: chosenWorkspace,
      label: 'Read-only configuration count' });
    if (!Array.isArray(values)) throw new Error('Configuration inventory returned an unexpected shape.');
    // Configurations stay in memory; only counts or explicitly permitted metadata enter the report.
    return values;
  }));
  const [models, flows] = configurations;
  report.selectedWorkspace.counts = { models: models.length, flows: flows.length };
  if (includeModelMetadata) {
    report.modelCandidates = models.map(model => pick(model, ['id', 'name', 'provider', 'adapter']));
    const bundled = flows.filter(flow => flow.id === 'default-agent-flujo');
    report.bundledAgentBinding = {
      flowId: 'default-agent-flujo', found: bundled.length === 1,
      bindings: bundled.flatMap(flow => (flow.nodes ?? []).filter(node => node.type === 'process')
        .map(node => ({ nodeId: node.id, boundModel: node.data?.properties?.boundModel }))
        .filter(binding => typeof binding.boundModel === 'string' && binding.boundModel.length > 0)),
    };
  }
  try {
    const image = await managed.resolveImage({ source: info.workerCompatibility, fetchImpl: managed.fetch });
    report.imageSelection = { status: 'compatible', ...pick(image, ['image', 'mode', 'compatibility',
      'applicationVersion', 'revision', 'selectedTag', 'snapshotFormatVersion', 'layoutVersion',
      'workerProtocolVersion', 'architecture', 'os', 'indexDigest']) };
  } catch (error) {
    const code = typeof error.code === 'string' && /^IMAGE_[A-Z_]+$/.test(error.code) ? error.code : 'IMAGE_SELECTION_UNCONFIRMED';
    report.imageSelection = { status: 'unconfirmed', code };
  }
  return report;
}

function argumentsFor(values) {
  const allowed = new Map([['--module-path', 'modulePath'], ['--source', 'source'], ['--workspace', 'workspace']]);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    if (values[index] === '--model-metadata' && options.includeModelMetadata === undefined) {
      options.includeModelMetadata = true;
      index -= 1;
      continue;
    }
    const key = allowed.get(values[index]);
    if (!key || typeof values[index + 1] !== 'string' || values[index + 1].startsWith('--') || options[key] !== undefined) {
      throw new Error('Use --module-path ABSOLUTE_PATH --source LOOPBACK_ORIGIN [--workspace NAME] [--model-metadata].');
    }
    options[key] = values[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await readOnlyCloudPreflight(argumentsFor(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.imageSelection.status !== 'compatible') process.exitCode = 2;
  } catch {
    // Provider configs, bearer tokens and arbitrary exception strings never reach stdout/stderr.
    process.stderr.write('Read-only cloud preflight could not be confirmed. No provisioning or Flow execution was requested.\n');
    process.exitCode = 1;
  }
}

import path from 'node:path';
import fs from 'node:fs/promises';
import { createPairConfigurations, validatePeerConfig, wireBytes, requirePeer } from './peer-messaging.mjs';

async function privateParent(files, filename) {
  const parent = path.dirname(filename);
  try { await fs.lstat(parent); await files.assertPrivateDirectory(parent); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await files.ensurePrivateDirectory(parent); }
}
function identical(a, b) { return wireBytes(a).equals(wireBytes(b)); }
/** Local private setup intent precedes publication of either shared credential. */
export async function bootstrapPeerPair(privateFiles, request) {
  requirePeer(Object.keys(request).sort().join(',') === 'a,b,bootstrapPath,configAPath,configBPath,credentialExpiresAt,generation', 'INPUT');
  const paths = [request.bootstrapPath, request.configAPath, request.configBPath];
  const comparisonPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  requirePeer(paths.every(value => typeof value === 'string' && path.isAbsolute(value))
    && new Set(paths.map(comparisonPath)).size === 3, 'INPUT');
  for (const filename of paths) await privateParent(privateFiles, filename);
  let intent;
  try { intent = await privateFiles.readPrivateJson(request.bootstrapPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    intent = { schemaVersion: 1, request: structuredClone(request), configs: createPairConfigurations(request) };
    try { await privateFiles.writePrivateJson(request.bootstrapPath, intent, { exclusive: true }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; intent = await privateFiles.readPrivateJson(request.bootstrapPath); }
  }
  requirePeer(intent && Object.keys(intent).sort().join(',') === 'configs,request,schemaVersion'
    && intent.schemaVersion === 1 && identical(intent.request, request), 'BOOTSTRAP_CONFLICT');
  requirePeer(Object.keys(intent.configs).sort().join(',') === 'a,b', 'BOOTSTRAP_CONFLICT');
  const a = validatePeerConfig(intent.configs.a), b = validatePeerConfig(intent.configs.b);
  requirePeer(a.key === b.key && identical(a.local, request.a.identity) && identical(b.local, request.b.identity)
    && identical(a.peer, b.local) && identical(b.peer, a.local)
    && a.generation === request.generation && b.generation === request.generation
    && a.credentialExpiresAt === request.credentialExpiresAt && b.credentialExpiresAt === request.credentialExpiresAt
    && a.endpoint === new URL(request.b.endpoint).href && b.endpoint === new URL(request.a.endpoint).href, 'BOOTSTRAP_CONFLICT');
  for (const [filename, config] of [[request.configAPath, a], [request.configBPath, b]]) {
    let existing;
    try { existing = await privateFiles.readPrivateJson(filename); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await privateFiles.writePrivateJson(filename, config, { exclusive: true }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
      existing = await privateFiles.readPrivateJson(filename);
    }
    requirePeer(identical(existing, config), 'BOOTSTRAP_CONFLICT');
  }
  return { configured: true, generation: a.generation, scope: 'advisory-pair-only' };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PeerStore, PeerError, requirePeer, BODY_LIMIT } from '../src/peer-messaging.mjs';
import { startPeerServer, dispatchPeerMessage } from '../src/peer-gateway.mjs';
import { bootstrapPeerPair } from '../src/peer-bootstrap.mjs';
import { validateWatchConfig, runPeerWatcher } from '../src/peer-watch.mjs';
import { createLocalHealthSource } from '../src/peer-health.mjs';

const [command, ...arguments_] = process.argv.slice(2);
let store;
const safePrint = value => process.stdout.write(JSON.stringify(value) + '\n');
async function input() {
  const chunks = []; let count = 0;
  for await (const chunk of process.stdin) { count += chunk.length; requirePeer(count <= BODY_LIMIT, 'INPUT_LIMIT'); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new PeerError('INPUT'); }
}
async function privateParent(privateFiles, parent) {
  try { await fs.lstat(parent); await privateFiles.assertPrivateDirectory(parent); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await privateFiles.ensurePrivateDirectory(parent); }
}
try {
  const flags = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index], value = arguments_[index + 1];
    requirePeer(['--private-module', '--config', '--database', '--host', '--port', '--tls-file', '--message-id', '--expected-generation', '--output', '--watch-file'].includes(name)
      && value !== undefined && !Object.hasOwn(flags, name), 'CLI');
    flags[name] = value;
  }
  requirePeer(['pair', 'serve', 'watch', 'enqueue', 'send', 'inbox', 'read', 'status', 'rotate'].includes(command), 'CLI');
  requirePeer(typeof flags['--private-module'] === 'string' && path.isAbsolute(flags['--private-module']), 'PRIVATE_MODULE');
  // This is an explicitly selected trusted local operator module, never a peer input.
  const privateFiles = await import(pathToFileURL(flags['--private-module']).href);
  for (const name of ['readPrivateJson', 'writePrivateJson', 'ensurePrivateDirectory', 'assertPrivateDirectory']) requirePeer(typeof privateFiles[name] === 'function', 'PRIVATE_MODULE');
  if (command === 'pair') {
    const request = await input();
    safePrint(await bootstrapPeerPair(privateFiles, request));
  } else {
    requirePeer(typeof flags['--config'] === 'string' && path.isAbsolute(flags['--config'])
      && typeof flags['--database'] === 'string' && path.isAbsolute(flags['--database']), 'CLI');
    const config = await privateFiles.readPrivateJson(flags['--config']);
    const parent = path.dirname(flags['--database']);
    // Existing parents must already be owner-private; creation is explicit and
    // restricted to the selected peer-data directory, not a shared owner folder.
    await privateParent(privateFiles, parent);
    const rotateFromGeneration = command === 'rotate' ? Number(flags['--expected-generation']) : null;
    if (command === 'rotate') requirePeer(Number.isSafeInteger(rotateFromGeneration) && rotateFromGeneration >= 1, 'CLI');
    store = new PeerStore(flags['--database'], { config, rotateFromGeneration });
    if (command === 'enqueue') {
      const row = store.enqueue(await input()); safePrint({ state: row.state, messageId: row.messageId, digest: row.digest });
    } else if (command === 'send') {
      safePrint(await dispatchPeerMessage({ store, messageId: flags['--message-id'] }));
    } else if (command === 'inbox') {
      // Metadata listing only. A trusted consumer uses readInbox(id) for data.
      safePrint({ inbox: store.inbox(), scope: 'advisory-metadata' });
    } else if (command === 'read') {
      requirePeer(typeof flags['--output'] === 'string' && path.isAbsolute(flags['--output']), 'CLI');
      const envelope = store.readInbox(flags['--message-id']); requirePeer(envelope !== null, 'INBOX');
      await privateParent(privateFiles, path.dirname(flags['--output']));
      await privateFiles.writePrivateJson(flags['--output'], envelope, { exclusive: true });
      safePrint({ exported: true, messageId: envelope.messageId, scope: 'advisory-private-export' });
    } else if (command === 'status' || command === 'rotate') {
      safePrint({ ...store.counts(), generation: store.config.generation, scope: 'advisory-pair-only' });
    } else {
      const host = flags['--host'] ?? '127.0.0.1', port = Number(flags['--port'] ?? '4350');
      const tls = flags['--tls-file'] ? await privateFiles.readPrivateJson(path.resolve(flags['--tls-file']), { maxBytes: 64 * 1024 }) : undefined;
      if (tls) requirePeer(Object.keys(tls).sort().join(',') === 'cert,key' && typeof tls.key === 'string' && typeof tls.cert === 'string', 'TLS');
      if (command === 'watch') {
        requirePeer(typeof flags['--watch-file'] === 'string' && path.isAbsolute(flags['--watch-file']), 'CLI');
        const configuration = validateWatchConfig(await privateFiles.readPrivateJson(flags['--watch-file'], { maxBytes: 8192 }), store.config);
        const sourceReader = await createLocalHealthSource({ configuration, privateFiles });
        const controller = new AbortController(), stop = () => controller.abort();
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        try { await runPeerWatcher({ store, configuration, sourceReader, host, port, tls, onEvent: safePrint, signal: controller.signal }); }
        finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      } else {
      const server = await startPeerServer({ store, host, port, tls });
      safePrint({ state: 'listening', port: server.address().port, tls: Boolean(tls), scope: 'advisory-pair-only' });
      let stopping = false;
      const stop = () => {
        if (stopping) return; stopping = true;
        server.closeAllConnections(); server.close(() => { store.close(); store = null; });
      };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      await new Promise(resolve => server.once('close', resolve));
      }
    }
  }
} catch (error) {
  // Withhold raw config, peer bodies, keys, filesystem and network error text.
  process.stderr.write(JSON.stringify({ error: { code: error instanceof PeerError ? error.code : 'PEER_OPERATION_FAILED' } }) + '\n');
  process.exitCode = 1;
} finally { store?.close(); }

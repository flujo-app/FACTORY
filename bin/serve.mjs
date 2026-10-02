#!/usr/bin/env node
import path from 'node:path';
import { loadViewerToken, startPresentationServer } from '../src/presentation.mjs';

let server;
try {
  const options = {}, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value || !['--database', '--spending-ledger', '--factory-id', '--token-file', '--port', '--host', '--build-revision'].includes(key)) throw new Error('Invalid arguments.');
    const mapping = { '--database': 'databasePath', '--factory-id': 'factoryId', '--token-file': 'tokenFile',
      '--spending-ledger': 'spendingLedgerPath', '--port': 'port', '--host': 'host', '--build-revision': 'buildRevision' };
    options[mapping[key]] = key === '--port' ? Number(value) : ['--database', '--token-file'].includes(key) ? path.resolve(value) : value;
  }
  const token = await loadViewerToken({ tokenFile: options.tokenFile });
  server = await startPresentationServer({ ...options, token });
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ listening: { host: address.address, port: address.port }, factoryId: options.factoryId,
    schemaVersion: 1, scope: 'local-coordinator', capabilities: { snapshot: true, events: true, commands: false } })}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { process.exitCode = 0; });
    server.closeIdleConnections();
  });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'PRESENTATION_START_UNAVAILABLE' } })}\n`);
  process.exitCode = 1;
  server?.close();
}

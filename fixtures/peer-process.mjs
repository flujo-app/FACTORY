import { PeerStore } from '../src/peer-messaging.mjs';
import { startPeerServer, dispatchPeerMessage } from '../src/peer-gateway.mjs';

let store, server;
process.on('message', async request => {
  try {
    let result;
    if (request.command === 'open') {
      store = new PeerStore(request.database, { config: request.config });
      if (request.receiver) {
        if (request.crashAfterCommit) {
          const receive = store.receiveEnvelope.bind(store);
          store.receiveEnvelope = envelope => {
            receive(envelope); // The production transaction has committed synchronously.
            process.exit(91); // No acknowledgement can be constructed or sent.
          };
        }
        server = await startPeerServer({ store, port: request.port });
      }
      result = { opened: true, port: server?.address().port ?? null };
    } else if (request.command === 'enqueue') {
      const row = store.enqueue(request.message); result = { messageId: row.messageId, digest: row.digest, state: row.state };
    } else if (request.command === 'send') {
      result = await dispatchPeerMessage({ store, messageId: request.messageId });
    } else if (request.command === 'inspect') {
      const row = request.messageId ? store.outbox(request.messageId) : null;
      result = { counts: store.counts(), inbox: store.inbox(), events: store.events(),
        outbox: row ? { messageId: row.messageId, digest: row.digest, state: row.state, endpoint: row.endpoint } : null };
    } else if (request.command === 'close') {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      store.close(); process.send({ requestId: request.requestId, result: { closed: true } }, () => process.exit(0)); return;
    } else throw new Error('UNKNOWN_COMMAND');
    process.send({ requestId: request.requestId, result });
  } catch { process.send({ requestId: request.requestId, error: 'FIXTURE_OPERATION_FAILED' }); }
});
process.send({ ready: true });

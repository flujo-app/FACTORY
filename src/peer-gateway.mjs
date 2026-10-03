import http from 'node:http';
import https from 'node:https';
import { BODY_LIMIT, ACK_LIMIT, PEER_PATH, PeerError, requirePeer, wireBytes,
  requestHeaders, verifyRequest, acknowledgementHeaders, verifyAcknowledgement } from './peer-messaging.mjs';

function errorResponse(response, status, code) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code } }));
}
/** Advisory-only receiver. An ACK follows the committed inbox transaction. */
function createPeerServer({ store, config = store.config, tls } = {}) {
  requirePeer(config === store.config, 'CONFIG_CONFLICT');
  const handler = (request, response) => {
    if (request.method !== 'POST' || request.url !== PEER_PATH) return errorResponse(response, 404, 'ROUTE');
    const length = request.headers['content-length'];
    if (!length || !/^[1-9][0-9]{0,5}$/.test(length) || Number(length) > BODY_LIMIT || request.headers['transfer-encoding'])
      return errorResponse(response, 413, 'BODY_LIMIT');
    const chunks = []; let count = 0;
    const bodyTimer = setTimeout(() => request.destroy(), 5000);
    request.once('close', () => clearTimeout(bodyTimer));
    request.on('data', chunk => { count += chunk.length; if (count > BODY_LIMIT) request.destroy(); else chunks.push(chunk); });
    request.on('error', () => {});
    request.on('end', () => {
      try {
        requirePeer(count === Number(length), 'BODY_LIMIT'); store.assertCurrentCredential();
        const body = Buffer.concat(chunks), envelope = verifyRequest(config, body, request.headers, store.clock());
        const acknowledgement = store.receiveEnvelope(envelope);
        const ackBytes = wireBytes(acknowledgement, ACK_LIMIT);
        store.assertCurrentCredential();
        response.writeHead(200, { ...acknowledgementHeaders(config, acknowledgement.digest, ackBytes, store.clock()),
          'content-length': String(ackBytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(ackBytes);
      } catch (error) {
        const code = error instanceof PeerError ? error.code : 'STORAGE';
        const status = ['AUTHENTICATION', 'IDENTITY', 'CREDENTIAL_EXPIRED', 'CREDENTIAL_GENERATION'].includes(code) ? 401 : code === 'CONFLICT' ? 409 : 400;
        errorResponse(response, status, code);
      }
    });
  };
  const server = tls ? https.createServer({ ...tls, maxHeaderSize: 8192 }, handler) : http.createServer({ maxHeaderSize: 8192 }, handler);
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
  server.maxConnections = 32; server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return server;
}
export async function startPeerServer({ host = '127.0.0.1', port = 0, tls, ...options } = {}) {
  requirePeer(Number.isInteger(port) && port >= 0 && port <= 65535, 'BIND');
  requirePeer(['127.0.0.1', '::1'].includes(host) || (tls && typeof tls.key === 'string' || tls && Buffer.isBuffer(tls.key)), 'BIND');
  const server = createPeerServer({ ...options, tls });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
/** One bounded attempt to the endpoint already bound in the durable outbox. */
export async function dispatchPeerMessage({ store, messageId, timeoutMs = 5000 } = {}) {
  requirePeer(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000, 'DEADLINE');
  store.assertCurrentCredential(); const outbox = store.outbox(messageId); requirePeer(outbox !== null, 'OUTBOX');
  if (outbox.state === 'acknowledged') return { state: 'acknowledged', messageId, digest: outbox.digest, dispatched: false };
  const url = new URL(outbox.endpoint), body = outbox.body;
  const auth = requestHeaders(store.config, body, store.clock());
  const result = await new Promise(resolve => {
    let request, timer, finished = false;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
    timer = setTimeout(() => { request?.destroy(); finish({ failure: 'DEADLINE' }); }, timeoutMs);
    try {
      request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', path: PEER_PATH,
        headers: { ...auth, 'content-length': String(body.length) }, agent: false, rejectUnauthorized: true }, response => {
        if (response.statusCode !== 200) { response.destroy(); finish({ failure: 'REMOTE_REJECTION' }); return; }
        const chunks = []; let count = 0;
        response.on('data', chunk => {
          count += chunk.length;
          if (count > ACK_LIMIT) { response.destroy(); finish({ failure: 'ACK_LIMIT' }); } else chunks.push(chunk);
        });
        response.on('error', () => finish({ failure: 'RESPONSE_INTERRUPTED' }));
        response.on('end', () => finish({ body: Buffer.concat(chunks), headers: response.headers }));
      });
      request.once('error', () => finish({ failure: 'CONNECTION' })); request.end(body);
    } catch { request?.destroy(); finish({ failure: 'CONNECTION' }); }
  });
  if (result.failure) return { state: 'pending', messageId, digest: outbox.digest, failure: result.failure };
  try {
    store.assertCurrentCredential();
    verifyAcknowledgement(store.config, outbox, result.body, result.headers, store.clock());
    store.acknowledge(messageId, result.body, result.headers);
    return { state: 'acknowledged', messageId, digest: outbox.digest, dispatched: true };
  } catch (error) {
    return { state: 'pending', messageId, digest: outbox.digest, failure: error instanceof PeerError ? error.code : 'STORAGE' };
  }
}

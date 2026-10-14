import { createServer } from 'node:http';
import { CloudLiteBoard } from './board.mjs';
import { redact, hash } from './protocol.mjs';

export async function startCloudLiteCoordinator({ database, plan, credentials, operatorToken, auth, githubToken, port = 8080, host = '::' }) {
  const board = new CloudLiteBoard(database, { plan, credentials, operatorToken });
  let currentAuth = auth; let refreshRequested = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
    const send = (status, value) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    try {
      if (request.url === '/health' && request.method === 'GET') return send(200, { runtime: 'factory-cloud-lite', runId: plan.runId });
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      if (!token) return send(401, { error: 'Authentication required.' });
      const actor = board.authenticate(token);
      let body = {}; if (request.method === 'POST') {
        let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Request too large.'); }
        body = JSON.parse(raw || '{}');
      }
      if (request.url === '/bootstrap' && actor.role !== 'operator') return send(200, {
        plan, agents: board.inventory().filter(x => x.machine === actor.machine).map(x => ({ ...x, token: credentials[x.id] })),
        auth: currentAuth, githubToken,
      });
      if (request.url === '/auth' && actor.role !== 'operator') {
        if (body.refresh && body.previousTokenHash === hash(currentAuth.accessToken)) {
          refreshRequested = true;
          const deadline = Date.now() + 8000;
          while (body.previousTokenHash === hash(currentAuth.accessToken) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
          if (body.previousTokenHash === hash(currentAuth.accessToken)) throw new Error('Host authentication refresh remains pending.');
        }
        return send(200, currentAuth);
      }
      if (request.url === '/operator/auth' && actor.role === 'operator' && request.method === 'POST') {
        if (!body.accessToken || body.chatgptAccountId !== currentAuth.chatgptAccountId) throw new Error('Subscription account binding changed.');
        currentAuth = body; refreshRequested = false; return send(200, { updated: true });
      }
      if (request.url?.startsWith('/operator/events') && actor.role === 'operator') {
        const parameters = new URL(request.url, 'http://localhost').searchParams;
        const after = Number(parameters.get('after') ?? 0);
        const through = Number(parameters.get('through') ?? Number.MAX_SAFE_INTEGER);
        return send(200, { events: board.events(after, through), refreshRequested });
      }
      if (request.url === '/operator/status' && actor.role === 'operator') return send(200, { ...board.snapshot(), refreshRequested });
      if (request.url === '/operator/session' && actor.role === 'operator' && request.method === 'POST') return send(200,board.registerSession(body.agent,body.session));
      if (request.url === '/operator/validation' && actor.role === 'operator' && request.method === 'POST') {
        if (!['passed','failed','running','held'].includes(body.status)) throw new Error('Invalid supervisor validation status.');
        const result = board.db.prepare('UPDATE cloud_lite_validations SET status=?,evidence=?,updated=? WHERE resource=? AND revision=?').run(body.status, JSON.stringify(body.evidence ?? {}), Date.now(), body.resource, body.revision);
        if (!result.changes) throw new Error('Unknown validation request.');
        return send(200, { recorded: true });
      }
      if (request.url === '/operator/command' && actor.role === 'operator' && request.method === 'POST') {
        if (!body.id || !board.inventory().some(x => x.id === body.recipient)) throw new Error('Select a known agent and stable command id.');
        if (!['message','stop'].includes(body.action) || body.action === 'message' && typeof body.message !== 'string') throw new Error('Select a stop or text message command.');
        let expectedThreadId = body.expectedThreadId; let expectedTurnId = body.expectedTurnId;
        if (body.action === 'stop' && (expectedThreadId === undefined || expectedTurnId === undefined)) {
          const native = board.inventory().find(value => value.id === body.recipient)?.nativeRuntime;
          if (!native) throw new Error('Legacy stop command cannot be bound without a registered native thread.');
          if (expectedThreadId !== undefined && expectedThreadId !== native.threadId
            || expectedTurnId !== undefined && expectedTurnId !== (native.turnId ?? null)) throw new Error('Supplied stop target differs from the current native thread/turn.');
          expectedThreadId = native.threadId; expectedTurnId = native.turnId ?? null;
        }
        if (body.action === 'stop' && (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expectedThreadId ?? '')
          || expectedTurnId !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expectedTurnId ?? ''))) {
          throw new Error('Stop commands must bind the exact expected native thread and turn.');
        }
        const original = board.db.prepare('SELECT body FROM cloud_lite_commands WHERE id=?').get(body.id);
        const serialized = JSON.stringify({ action: body.action, message: body.message,
          ...(body.action === 'stop' ? { expectedThreadId, expectedTurnId } : {}) });
        if (original && original.body !== serialized) throw new Error('Command id belongs to different bytes.');
        board.db.exec('BEGIN IMMEDIATE');
        try {
          // A newly requested stop supersedes earlier queued work. Retrying its
          // durable id does not cancel a later explicit resume/message command.
          if (!original && body.action === 'stop') {
            const cancelled = Date.now();
            board.db.prepare('INSERT OR IGNORE INTO cloud_lite_command_cancellations SELECT id,?,? FROM cloud_lite_commands WHERE recipient=? AND acknowledged IS NULL').run(body.id, cancelled, body.recipient);
            board.db.prepare('DELETE FROM cloud_lite_native_stop_receipts WHERE agent_id=? AND command_id IN (SELECT command_id FROM cloud_lite_command_cancellations WHERE superseded_by=?)').run(body.recipient, body.id);
            board.db.prepare('UPDATE cloud_lite_commands SET acknowledged=? WHERE recipient=? AND acknowledged IS NULL').run(cancelled, body.recipient);
          }
          board.db.prepare('INSERT OR IGNORE INTO cloud_lite_commands VALUES(?,?,?,NULL)').run(body.id, body.recipient, serialized);
          board.db.exec('COMMIT');
        } catch (error) { board.db.exec('ROLLBACK'); throw error; }
        return send(200, { recorded: true });
      }
      if (request.url === '/commands' && actor.role !== 'operator') {
        if (body.acknowledge) board.db.prepare('UPDATE cloud_lite_commands SET acknowledged=? WHERE id=? AND recipient=?').run(Date.now(), body.acknowledge, actor.id);
        return send(200, { commands: board.db.prepare('SELECT id,body FROM cloud_lite_commands WHERE recipient=? AND acknowledged IS NULL').all(actor.id).map(x => ({ id: x.id, ...JSON.parse(x.body) })),
          inboxVersion: board.db.prepare('SELECT count(*) AS count FROM messages WHERE recipient=?').get(actor.id).count });
      }
      if (request.url === '/trace' && actor.role !== 'operator' && request.method === 'POST') return send(200, board.trace(actor, body.events));
      if (request.url === '/trace-position' && actor.role !== 'operator') return send(200, {
        sequence: board.db.prepare('SELECT max(source_seq) AS sequence FROM cloud_lite_traces WHERE source=?').get(actor.id).sequence ?? 0,
      });
      if (request.url === '/tool' && actor.role !== 'operator' && request.method === 'POST') return send(200, board.call(actor, body.name,
        redact(body.arguments ?? {}, [operatorToken, currentAuth.accessToken, githubToken, ...Object.values(credentials)])));
      send(404, { error: 'Unknown endpoint.' });
    } catch (error) {
      send(error.code === 'AUTH' ? 401 : 400, { error: redact(error.message, [operatorToken, currentAuth.accessToken, githubToken, ...Object.values(credentials)]) });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { board, server, close: () => new Promise(resolve => server.close(() => { board.close(); resolve(); })) };
}

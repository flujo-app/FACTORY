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
      if (request.url === '/operator/workflow' && actor.role === 'operator' && request.method === 'POST') return send(200, board.call(actor, body.name, body.arguments));
      if (request.url === '/operator/workflow/verification' && actor.role === 'operator' && request.method === 'POST') {
        if (!board.workflow) throw new Error('Verified workflow profile required.');
        return send(200, board.workflow.recordVerification(body.candidateId, body.gateId, body.result));
      }
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
        const original = board.db.prepare('SELECT recipient,body FROM cloud_lite_commands WHERE id=?').get(body.id);
        if (original && original.recipient !== body.recipient) throw new Error('Command id belongs to a different recipient.');
        let expectedThreadId = body.expectedThreadId; let expectedTurnId = body.expectedTurnId;
        if (body.action === 'stop' && (expectedThreadId === undefined || expectedTurnId === undefined)) {
          const previous = original && JSON.parse(original.body);
          if (previous?.action === 'stop') {
            // A stable legacy retry keeps its original binding even after the
            // runtime has observed a later thread or turn. Supplied partial
            // fields must still agree with the original complete binding.
            if (expectedThreadId !== undefined && expectedThreadId !== previous.expectedThreadId
              || expectedTurnId !== undefined && expectedTurnId !== previous.expectedTurnId) {
              throw new Error('Stable stop command target cannot change on replay.');
            }
            expectedThreadId = previous.expectedThreadId; expectedTurnId = previous.expectedTurnId;
          } else {
            const native = board.inventory().find(value => value.id === body.recipient)?.nativeRuntime;
            if (!native) throw new Error('Legacy stop command cannot be bound without a registered native thread.');
            if (expectedThreadId !== undefined && expectedThreadId !== native.threadId
              || expectedTurnId !== undefined && expectedTurnId !== (native.turnId ?? null)) throw new Error('Supplied stop target differs from the current native thread/turn.');
            expectedThreadId = native.threadId; expectedTurnId = native.turnId ?? null;
          }
        }
        if (body.action === 'stop' && (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expectedThreadId ?? '')
          || expectedTurnId !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expectedTurnId ?? ''))) {
          throw new Error('Stop commands must bind the exact expected native thread and turn.');
        }
        const serialized = JSON.stringify({ action: body.action, message: body.message,
          ...(body.action === 'stop' ? { expectedThreadId, expectedTurnId } : {}) });
        if (original && original.body !== serialized) throw new Error('Command id belongs to different bytes.');
        board.db.exec('BEGIN IMMEDIATE');
        try {
          // A new command supersedes older queued work and revokes any older
          // stop proof, including a stop already acknowledged by the runtime.
          // Retrying an existing stable id never cancels newer work.
          if (!original) {
            const cancelled = Date.now();
            const newAction = JSON.parse(serialized).action;
            const prior = board.db.prepare('SELECT id,body,acknowledged FROM cloud_lite_commands WHERE recipient=?').all(body.recipient);
            for (const command of prior) {
              const priorAction = JSON.parse(command.body).action;
              if (newAction === 'stop' ? command.acknowledged !== null : priorAction !== 'stop') continue;
              board.db.prepare('INSERT OR IGNORE INTO cloud_lite_command_cancellations VALUES(?,?,?)').run(command.id, body.id, cancelled);
            }
            board.db.prepare('DELETE FROM cloud_lite_native_stop_receipts WHERE agent_id=? AND command_id IN (SELECT command_id FROM cloud_lite_command_cancellations WHERE superseded_by=?)').run(body.recipient, body.id);
            board.db.prepare('UPDATE cloud_lite_commands SET acknowledged=? WHERE id IN (SELECT command_id FROM cloud_lite_command_cancellations WHERE superseded_by=?) AND acknowledged IS NULL').run(cancelled, body.id);
          }
          board.db.prepare('INSERT OR IGNORE INTO cloud_lite_commands VALUES(?,?,?,NULL)').run(body.id, body.recipient, serialized);
          board.db.exec('COMMIT');
        } catch (error) { board.db.exec('ROLLBACK'); throw error; }
        return send(200, { recorded: true });
      }
      if (request.url === '/commands' && actor.role !== 'operator') {
        if (body.acknowledge) {
          const command = board.db.prepare('SELECT body,acknowledged FROM cloud_lite_commands WHERE id=? AND recipient=?').get(body.acknowledge, actor.id);
          const cancelled = board.db.prepare('SELECT 1 FROM cloud_lite_command_cancellations WHERE command_id=?').get(body.acknowledge);
          if (!command || cancelled) return send(200, { acknowledged: false, cancelled: true });
          const issued = JSON.parse(command.body);
          if (issued.action === 'stop') {
            const receipt = board.db.prepare('SELECT * FROM cloud_lite_native_stop_receipts WHERE agent_id=? AND command_id=?')
              .get(actor.id, body.acknowledge);
            const current = board.db.prepare(`SELECT a.session,n.thread_id,n.thread_status,n.turn_id,n.turn_status
              FROM cloud_lite_agents a LEFT JOIN cloud_lite_native_runtime n ON n.agent_id=a.id WHERE a.id=?`).get(actor.id);
            if (!receipt || receipt.thread_id !== issued.expectedThreadId || receipt.turn_id !== issued.expectedTurnId
              || current.session !== receipt.thread_id || current.thread_id !== receipt.thread_id
              || current.thread_status !== receipt.thread_status || current.turn_id !== receipt.turn_id
              || current.turn_status !== receipt.turn_status || current.turn_status === 'inProgress') {
              return send(200, { acknowledged: false, cancelled: false, receiptAccepted: false });
            }
          }
          if (command.acknowledged !== null) return send(200, { acknowledged: true, cancelled: false, receiptAccepted: true });
          const result = board.db.prepare('UPDATE cloud_lite_commands SET acknowledged=? WHERE id=? AND recipient=? AND acknowledged IS NULL').run(Date.now(), body.acknowledge, actor.id);
          return send(200, { acknowledged: result.changes === 1, cancelled: false, receiptAccepted: true });
        }
        return send(200, { commands: board.db.prepare('SELECT id,body FROM cloud_lite_commands WHERE recipient=? AND acknowledged IS NULL ORDER BY rowid').all(actor.id).map(x => ({ id: x.id, ...JSON.parse(x.body) })),
          inboxVersion: board.db.prepare('SELECT count(*) AS count FROM messages WHERE recipient=?').get(actor.id).count,
          ...(board.workflow ? { workflowVersion: board.db.prepare('SELECT COALESCE(max(seq),0) AS n FROM workflow_events WHERE actor=?').get(actor.id).n } : {}) });
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

#!/usr/bin/env node
// Plays Claude Code's stream-json side as observed from the pinned release, driven by the words of
// each message: LONG waits to be interrupted, DEAF ignores the interrupt, TOOL uses a tool, CRASH
// exits at once, REFUSED reports a refused key. QUEUE keeps later messages for after the turn, and
// BRIEF ends such a turn by itself shortly after. DROP loses later messages.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const resumed = flag('--resume');
const session = resumed ?? flag('--session-id');
const transcript = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-fake', `${session}.jsonl`);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), env: process.env }) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const emit = (type, extra = {}) => send({ type, session_id: session, uuid: randomUUID(), ...extra });

if (resumed && !existsSync(transcript)) {
  emit('result', { subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${session}`] });
  process.exit(1);
}
mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-fake'), { recursive: true });
writeFileSync(transcript, '{}\n', { flag: 'a' });
send({ type: 'system', subtype: 'init', session_id: flag('--session-id') && args.includes('--fake-other') ? randomUUID() : session, tools: [],
  mcp_servers: args.includes('--fake-board-failed') ? [{ name: 'factory', status: 'failed' }] : [{ name: 'factory', status: 'connected' }] });
emit('command_lifecycle');

const queue = []; let running = null; let inputEnded = false;
const assistant = content => emit('assistant', { message: { role: 'assistant', content } });
const usage = { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 };
function finish(result, delayMs = 0) {
  running = null;
  emit('result', { usage, ...result });
  if (delayMs) setTimeout(next, delayMs); else next();
}
function next() {
  if (running) return;
  const message = queue.shift();
  if (!message) { if (inputEnded) process.exit(0); return; }
  const text = message.message.content.map(block => block.text).join(' ');
  running = { text, deaf: text.includes('DEAF'), queueing: text.includes('QUEUE'), drop: text.includes('DROP') };
  emit('user', { isReplay: true, message: message.message });
  if (text.includes('CRASH')) process.exit(3);
  if (text.includes('BRIEF')) { setTimeout(() => finish({ subtype: 'success', is_error: false, result: 'brief' }), 200); return; }
  if (text.includes('LONG') || text.includes('DEAF')) return;
  if (text.includes('REFUSED')) {
    emit('system', { subtype: 'api_retry', attempt: 1, error_status: 401, error: 'authentication_failed' });
    finish({ subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate' });
    return;
  }
  if (text.includes('TOOL')) {
    assistant([{ type: 'thinking', thinking: 'choosing' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'true' } }]);
    emit('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
  }
  assistant([{ type: 'text', text: `reply to: ${text}` }]);
  finish({ subtype: 'success', is_error: false, result: `reply to: ${text}` });
}
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  if (value.type === 'control_request' && value.request?.subtype === 'interrupt') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id } });
    if (!running || running.deaf) return;
    emit('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    finish({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] }, 1000);
    return;
  }
  // A message written during a running turn joins it: it comes back at once and ends that turn.
  if (value.type === 'user' && running?.drop) return;
  if (value.type === 'user' && running && !running.deaf && !running.queueing) {
    const text = value.message.content.map(block => block.text).join(' ');
    emit('user', { isReplay: true, message: value.message });
    assistant([{ type: 'text', text: `steered by: ${text}` }]);
    finish({ subtype: 'success', is_error: false, result: `steered by: ${text}` });
    return;
  }
  if (value.type === 'user') { queue.push(value); next(); }
}).on('close', () => { inputEnded = true; if (!running && !queue.length) process.exit(0); });
setInterval(() => {}, 1000);

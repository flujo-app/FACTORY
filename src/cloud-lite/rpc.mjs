import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

/** Native Codex app-server transport; the Codex harness retains its built-in tools. */
export class CodexRpc extends EventEmitter {
  constructor({ command = 'codex', args = [], env = process.env, cwd, onRequest, onStderr } = {}) {
    super(); this.pending = new Map(); this.next = 0; this.onRequest = onRequest;
    this.child = spawn(command, [...args, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', chunk => onStderr?.(chunk.toString()));
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => { this.fail(new Error(`Codex exited (${code}/${signal}).`)); this.emit('exit', { code, signal }); });
  }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  send(value) { this.child.stdin.write(JSON.stringify(value) + '\n'); }
  async receive(line) {
    let value; try { value = JSON.parse(line); } catch { this.emit('protocolError', { bytes: line.length }); return; }
    if (value.method && value.id !== undefined) {
      try { const result = await this.onRequest?.(value.method, value.params); this.send({ id: value.id, result: result ?? {} }); }
      catch { this.send({ id: value.id, error: { code: -32000, message: 'Host request failed; inspect private trace.' } }); }
    } else if (value.id !== undefined) {
      const p = this.pending.get(value.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(value.id);
      value.error ? p.reject(Object.assign(new Error(value.error.message), { code: value.error.code })) : p.resolve(value.result);
    } else this.emit('notification', value);
  }
  request(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; original outcome is unknown.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'factory_cloud_lite', version: '0.3.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}

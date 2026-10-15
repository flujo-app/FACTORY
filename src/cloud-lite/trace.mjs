import { existsSync, readFileSync, openSync, writeSync, fsyncSync, fsync, closeSync, renameSync, copyFileSync, constants } from 'node:fs';
import { rename } from 'node:fs/promises';
import { promisify } from 'node:util';
import { redact, hash } from './protocol.mjs';

/** Persist before sending; original sequence and bytes survive lost acknowledgements. */
export class CloudLiteTrace {
  constructor({ file, url, token, secrets = [], remoteSequence = 0, sync = promisify(fsync) }) {
    this.file = file; this.url = url; this.token = token; this.secrets = [token, ...secrets];
    this.sync = sync; this.pendingDurability = new Set();
    this.ackFile = `${file}.ack`;
    if (!Number.isSafeInteger(remoteSequence) || remoteSequence < 0) throw new TypeError('Invalid authoritative trace position.');
    // The receiver's durable position is authoritative; a local ACK cannot prove remote storage.
    this.ack = remoteSequence;
    const original = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
    const retained = []; let damaged = 0;
    for (const line of original.toString('utf8').split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error('Invalid sequence.'); }
      catch { damaged++; continue; }
      if (retained.length && event.seq <= retained.at(-1).seq) throw new Error('Retained trace sequences are duplicated or reordered; reconcile the original file.');
      retained.push(event);
    }
    this.sequence = Math.max(this.ack, retained.at(-1)?.seq ?? 0); this.queue = retained.filter(x => x.seq > this.ack).map(x => this.project(x));
    if (damaged) {
      const evidence = `${file}.recovery-${hash(original)}.raw`;
      try { copyFileSync(file, evidence, constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const preservedFd = openSync(evidence, 'r+'); try { fsyncSync(preservedFd); } finally { closeSync(preservedFd); }
      const next = `${file}.recovered`;
      const fd = openSync(next, 'w', 0o600);
      try { writeSync(fd, retained.map(x => JSON.stringify(x)).join('\n') + (retained.length ? '\n' : '')); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(next, file);
      this.record('trace.recovery', { damagedRecords: damaged, preservedEvidence: evidence, originalSha256: hash(original), remoteSequence,
        limitation: 'Damaged local bytes are preserved; missing unacknowledged events are not reconstructed or claimed as delivered.' });
    }
  }
  record(kind, body) {
    const event = { seq: ++this.sequence, kind, body: redact(body, this.secrets), observedAt: new Date().toISOString() };
    const fd = openSync(this.file, 'a', 0o600);
    let deferred = false;
    try {
      writeSync(fd, JSON.stringify(event) + '\n');
      if (['turn/started','turn/completed','native.turn.started','native.turn.completed','native.thread.started','native.thread.resumed','agent.enrolled','supervisor.command','native.operator.stop.completed','codex.exit','trace.recovery'].includes(kind)) {
        // Fly volume commits can wait behind repository installs. Keep the
        // coordinator responsive; flush still waits for durability before send.
        const durability = Promise.resolve().then(() => this.sync(fd)).finally(() => closeSync(fd));
        deferred = true; this.pendingDurability.add(durability);
        void durability.then(() => this.pendingDurability.delete(durability), () => this.pendingDurability.delete(durability));
      }
    } finally { if (!deferred) closeSync(fd); }
    this.queue.push(this.project(event)); return event;
  }
  project(event) {
    const raw = JSON.stringify(event.body);
    return Buffer.byteLength(raw) > 128 * 1024 ? { ...event, body: { retainedLocally: true, sha256: hash(raw), bytes: Buffer.byteLength(raw), preview: raw.slice(0, 16000) } } : event;
  }
  async flush() {
    if (this.flushing) {
      await this.flushing;
      if (this.queue.length) await this.flush();
      return;
    }
    if (!this.queue.length) return;
    const active = this.flushBatch();
    this.flushing = active;
    try { await active; }
    finally { if (this.flushing === active) this.flushing = null; }
    if (this.queue.length) await this.flush();
  }
  async flushBatch() {
    const events = []; let bytes = 0;
    // Freeze the batch before the asynchronous sync so later writes cannot
    // enter a receipt whose durability barrier began before those writes.
    for (const event of this.queue.slice(0, 100)) { const size = Buffer.byteLength(JSON.stringify(event)); if (bytes + size > 1024 * 1024) break; events.push(event); bytes += size; }
    await Promise.all([...this.pendingDurability]);
    const traceFd = openSync(this.file, 'r+'); try { await this.sync(traceFd); } finally { closeSync(traceFd); }
    const response = await fetch(`${this.url}/trace`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Trace receiver refused the original batch.');
    const receipt = await response.json();
    if (receipt.acknowledged !== events.at(-1).seq) throw new Error('Trace acknowledgement does not match the original batch.');
    const next = `${this.ackFile}.next`; const fd = openSync(next, 'w', 0o600);
    try { writeSync(fd, String(receipt.acknowledged)); await this.sync(fd); } finally { closeSync(fd); }
    await rename(next, this.ackFile);
    this.ack = receipt.acknowledged;
    this.queue.splice(0, events.length);
  }
}

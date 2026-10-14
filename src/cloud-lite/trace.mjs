import { existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, copyFileSync, constants } from 'node:fs';
import { redact, hash } from './protocol.mjs';

/** Persist before sending; original sequence and bytes survive lost acknowledgements. */
export class CloudLiteTrace {
  constructor({ file, url, token, secrets = [], remoteSequence = 0 }) {
    this.file = file; this.url = url; this.token = token; this.secrets = [token, ...secrets];
    this.ackFile = `${file}.ack`;
    const localAck = existsSync(this.ackFile) ? Number(readFileSync(this.ackFile, 'utf8')) : 0;
    this.ack = Math.max(Number.isSafeInteger(localAck) ? localAck : 0, remoteSequence);
    const original = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
    const retained = []; let damaged = 0;
    for (const line of original.toString('utf8').split('\n').filter(Boolean)) {
      try { const event = JSON.parse(line); if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error('Invalid sequence.'); retained.push(event); }
      catch { damaged++; }
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
    try {
      writeSync(fd, JSON.stringify(event) + '\n');
      if (['turn/completed','agent.enrolled','supervisor.command','codex.exit','trace.recovery'].includes(kind)) fsyncSync(fd);
    } finally { closeSync(fd); }
    this.queue.push(this.project(event)); return event;
  }
  project(event) {
    const raw = JSON.stringify(event.body);
    return Buffer.byteLength(raw) > 128 * 1024 ? { ...event, body: { retainedLocally: true, sha256: hash(raw), bytes: Buffer.byteLength(raw), preview: raw.slice(0, 16000) } } : event;
  }
  async flush() {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    try {
      const traceFd = openSync(this.file, 'r+'); try { fsyncSync(traceFd); } finally { closeSync(traceFd); }
      const events = []; let bytes = 0;
      for (const event of this.queue.slice(0, 100)) { const size = Buffer.byteLength(JSON.stringify(event)); if (bytes + size > 1024 * 1024) break; events.push(event); bytes += size; }
      const response = await fetch(`${this.url}/trace`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }), redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Trace receiver refused the original batch.');
      const receipt = await response.json();
      if (receipt.acknowledged !== events.at(-1).seq) throw new Error('Trace acknowledgement does not match the original batch.');
      this.ack = receipt.acknowledged;
      const next = `${this.ackFile}.next`; const fd = openSync(next, 'w', 0o600);
      try { writeSync(fd, String(this.ack)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(next, this.ackFile);
      this.queue.splice(0, events.length);
    } finally { this.flushing = false; }
  }
}

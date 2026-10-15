import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { sourceIdentity, interpretVerification } from './verifier.mjs';
import { redact } from '../cloud-lite/protocol.mjs';

const requestPath = process.argv[2];
const run = JSON.parse(readFileSync(requestPath,'utf8'));
// Exclusive admission survives crashes. A second launcher must reconcile, never repeat effects.
const lock = openSync(requestPath + '.started', 'wx', 0o600); closeSync(lock);
const startedAt = Date.now();
let result, diagnostics = {};
try {
  const before = sourceIdentity(run.cwd);
  if (before.dirty || before.commit !== run.source.commit || before.tree !== run.source.tree) throw new Error('Candidate changed before verifier execution.');
  diagnostics = await new Promise(resolve => {
    const child = spawn(run.gate.command === '$node' ? process.execPath : run.gate.command, run.gate.args, { cwd: run.cwd, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', overflow = false, timedOut = false, timer;
    const collect = target => chunk => {
      const text = chunk.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 8 * 1024 * 1024) { overflow = true; child.kill(); return; }
      if (target === 'stdout') stdout += text; else stderr += text;
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    if (run.gate.timeoutMs) timer = setTimeout(() => { timedOut = true; child.kill(); }, run.gate.timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: null, signal: null, error: error.message, timedOut, overflow }); });
    child.once('close', (exitCode, signal) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode, signal, timedOut, overflow }); });
  });
  result = interpretVerification(run.gate, diagnostics);
  const after = sourceIdentity(run.cwd);
  if (after.dirty || after.commit !== run.source.commit || after.tree !== run.source.tree) result = { outcome: 'failed', reason: 'Verifier changed the frozen source or left untracked source files.' };
  if (diagnostics.overflow) result = { outcome: 'failed', reason: 'Diagnostic output exceeded the retained evidence limit.' };
} catch (error) { result = { outcome: 'failed', reason: error.message }; }
const receipt = { ...result, requestDigest: run.requestDigest, candidateRef: run.candidateRef, startedAt, completedAt: Date.now(), diagnostics: redact(diagnostics) };
const temporary = run.receiptPath + '.next';
const fd = openSync(temporary, 'wx', 0o600);
try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
renameSync(temporary, run.receiptPath);

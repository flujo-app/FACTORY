import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { sourceIdentity, interpretVerification } from './verifier.mjs';
import { redact } from '../cloud-lite/protocol.mjs';
import { gitArchive } from './source.mjs';
import { sha256, canonical } from './artifacts.mjs';

const requestPath = process.argv[2];
const run = JSON.parse(readFileSync(requestPath,'utf8'));
const receiptKey = await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Trusted runner channel unavailable.')),5000);
  process.once('message',message=>{clearTimeout(timeout); if(!/^[a-f0-9]{64}$/.test(message?.receiptKey??''))reject(new Error('Invalid runner credential.'));else resolve(message.receiptKey);});
});
// Exclusive admission survives crashes. A second launcher must reconcile, never repeat effects.
const lock = openSync(requestPath + '.started', 'wx', 0o600); closeSync(lock);
const startedAt = Date.now();
let result, diagnostics = {};
try {
  const before = sourceIdentity(run.cwd);
  if (before.dirty || before.commit !== run.source.commit || before.tree !== run.source.tree) throw new Error('Candidate changed before verifier execution.');
  if (run.sourceRef !== 'sha256:' + sha256(gitArchive(run.cwd,run.source.commit))) throw new Error('Portable candidate source changed.');
  diagnostics = await new Promise(resolve => {
    const environment={};
    for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','PATHEXT','TEMP','TMP','TMPDIR','LANG','LC_ALL','TZ']) if(process.env[key]!==undefined) environment[key]=process.env[key];
    const home = run.requestPath + '.home'; mkdirSync(home,{recursive:true,mode:0o700});
    environment.HOME=home; environment.USERPROFILE=home; environment.CI='true';
    const child = spawn(run.gate.command === '$node' ? process.execPath : run.gate.command, run.gate.args, { cwd: run.cwd, env:environment, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
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
receipt.signature=createHmac('sha256',receiptKey).update(canonical(receipt)).digest('hex');
const temporary = run.receiptPath + '.next';
const fd = openSync(temporary, 'wx', 0o600);
try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
renameSync(temporary, run.receiptPath);

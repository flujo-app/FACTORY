import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { sourceIdentity, interpretVerification } from './verifier.mjs';
import { redact } from '../cloud-lite/protocol.mjs';
import { gitArchive, assertCheckoutSource } from './source.mjs';
import { sha256, canonical } from './artifacts.mjs';

const requestPath = process.argv[2];
const run = JSON.parse(readFileSync(requestPath,'utf8'));
const receiptKey = await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Trusted runner channel unavailable.')),5000);
  process.once('message',message=>{clearTimeout(timeout); if(!/^[a-f0-9]{64}$/.test(message?.receiptKey??''))reject(new Error('Invalid runner credential.'));else resolve(message.receiptKey);});
  process.send?.({ready:true});
});
// Exclusive admission survives crashes. A second launcher must reconcile, never repeat effects.
const lock = openSync(requestPath + '.started', 'wx', 0o600); closeSync(lock);
const startedAt = Date.now();
let result, diagnostics = {};
try {
  const before = sourceIdentity(run.cwd);
  if (before.dirty || before.commit !== run.source.commit || before.tree !== run.source.tree) throw new Error('Candidate changed before verifier execution.');
  if (run.sourceRef !== 'sha256:' + sha256(gitArchive(run.cwd,run.source.commit))) throw new Error('Portable candidate source changed.');
  const environment={};
  for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','PATHEXT','TEMP','TMP','TMPDIR','LANG','LC_ALL','TZ']) if(process.env[key]!==undefined) environment[key]=process.env[key];
  const home=resolve(dirname(requestPath),'h'),executionCwd=resolve(dirname(requestPath),'s'),hooks=resolve(dirname(requestPath),'hooks');
  mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(hooks,{recursive:true,mode:0o700});
  Object.assign(environment,{HOME:home,USERPROFILE:home,CI:'true',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'});
  const git=args=>execFileSync('git',['-c','core.longpaths=true','-c',`core.hooksPath=${hooks}`,...args],{env:environment,windowsHide:true,stdio:'pipe'});
  git(['clone','--shared','--no-checkout',run.cwd,executionCwd]);
  git(['-C',executionCwd,'checkout','--detach',run.source.commit]);
  if(run.sourceRef!=='sha256:'+sha256(gitArchive(executionCwd,run.source.commit)))throw new Error('Isolated execution source differs from the artifact.');
  assertCheckoutSource(executionCwd,run.source.commit);
  diagnostics = await new Promise(resolve => {
    const child = spawn(run.gate.command === '$node' ? process.execPath : run.gate.command, run.gate.args, { cwd: executionCwd, env:environment, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
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
  const after = sourceIdentity(executionCwd);
  assertCheckoutSource(executionCwd,run.source.commit);
  if (after.dirty || after.commit !== run.source.commit || after.tree !== run.source.tree) result = { outcome: 'failed', reason: 'Verifier changed the frozen source or left untracked source files.' };
  if (diagnostics.overflow) result = { outcome: 'failed', reason: 'Diagnostic output exceeded the retained evidence limit.' };
} catch (error) { result = { outcome: 'failed', reason: error.message }; }
const receipt = { ...result, requestDigest: run.requestDigest, candidateRef: run.candidateRef, startedAt, completedAt: Date.now(), diagnostics: redact(diagnostics) };
receipt.signature=createHmac('sha256',receiptKey).update(canonical(receipt)).digest('hex');
const temporary = run.receiptPath + '.next';
const fd = openSync(temporary, 'wx', 0o600);
try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
renameSync(temporary, run.receiptPath);

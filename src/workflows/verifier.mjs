import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, openSync, writeFileSync, closeSync, fsyncSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentDigest, canonical } from './artifacts.mjs';
import { randomBytes, createHmac } from 'node:crypto';
import { assertCandidateSource } from './source.mjs';

export function sourceIdentity(cwd) {
  const git = args => execFileSync('git', ['-c','core.longpaths=true','-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  return { commit: git(['rev-parse','HEAD']), tree: git(['rev-parse','HEAD^{tree}']), dirty: Boolean(git(['status','--porcelain','--untracked-files=normal'])) };
}
export function interpretVerification({ adapter, minimumTests = 1 }, { exitCode, signal, stdout, stderr, timedOut = false }) {
  if (timedOut) return { outcome: 'timed_out', reason: 'Verifier exceeded its explicit timeout.' };
  if (signal || exitCode !== 0) return { outcome: 'failed', reason: 'Verifier process did not exit successfully.' };
  if (adapter === 'node-tap') {
    const tests = [...stdout.matchAll(/^# tests (\d+)\s*$/gm)].at(-1), failures = [...stdout.matchAll(/^# fail (\d+)\s*$/gm)].at(-1);
    const cancelled = [...stdout.matchAll(/^# cancelled (\d+)\s*$/gm)].at(-1);
    const passed = [...stdout.matchAll(/^# pass (\d+)\s*$/gm)].at(-1);
    if (!tests || !failures || !cancelled || !passed || Number(passed[1]) < minimumTests || Number(passed[1]) !== Number(tests[1])) return { outcome: 'failed', reason: 'Missing, skipped or incomplete TAP summary.' };
    if (Number(failures[1]) || Number(cancelled[1]) || /^\s*not ok\b/m.test(stdout)) return { outcome: 'failed', reason: 'TAP reports failures despite exit zero.' };
    return { outcome: 'passed', tests: Number(tests[1]) };
  }
  if (adapter === 'json-summary') {
    let result; try { result = JSON.parse(stdout); } catch { return { outcome: 'failed', reason: 'Verifier output is not a complete JSON summary.' }; }
    if (result.success !== true || !Number.isSafeInteger(result.numTotalTests) || result.numTotalTests < minimumTests
      || result.numFailedTests !== 0 || result.numFailedTestSuites !== 0 || result.numPassedTests !== result.numTotalTests) return { outcome: 'failed', reason: 'Structured test results are incomplete or contain failures.' };
    return { outcome: 'passed', tests: result.numTotalTests };
  }
  if (adapter !== 'exit-code') throw new TypeError('Unknown verifier adapter.');
  return { outcome: 'passed' };
}
function durableJSON(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}

/** A separate runner retains its own receipt if the supervising process exits. Never blindly reruns an existing ID. */
export function startVerification(workflow, { runId, candidateId, gateId, cwd, allowedScopes = ['development'], environment = {} }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId ?? '') || !isAbsolute(cwd ?? '')) throw new TypeError('Stable runId and absolute checkout path are required.');
  const boundEnvironment = { ...environment, platform: process.platform, architecture: process.arch, node: process.version };
  const prior = workflow.db.prepare('SELECT body FROM workflow_runs WHERE id=?').get(runId);
  if (prior) {
    const old = JSON.parse(prior.body);
    if (old.candidateId !== candidateId || old.gateId !== gateId || old.cwd !== resolve(cwd) || contentDigest(old.environment) !== contentDigest(boundEnvironment)) throw new Error('Verifier run identity has different inputs.');
    return reconcileVerification(workflow,runId);
  }
  const candidate = workflow.candidate(candidateId), task = workflow.active(candidate.taskId), gate = task.gates.find(value => value.id === gateId);
  if (!gate || task.candidate?.id !== candidateId || task.coreStatus !== 'review') throw new Error('Verification requires the current submitted candidate.');
  if (!allowedScopes.includes(gate.scope)) throw new Error(`Explicit ${gate.scope} verification authorization is required.`);
  const source = sourceIdentity(cwd);
  if (source.dirty || source.commit !== candidate.source.commit || source.tree !== candidate.source.tree) throw new Error('Verifier checkout must be clean and match the exact candidate commit/tree.');
  const sourceRef = assertCandidateSource(candidate, cwd);
  const bound = { runId, candidateId, gateId, cwd: resolve(cwd), gate, candidateRef: candidate.manifestRef, source, sourceRef,
    environment: boundEnvironment };
  const directory = resolve(workflow.artifacts.directory, '..', 'workflow-runs', runId), requestPath = resolve(directory,'request.json'), receiptPath = resolve(directory,'receipt.json');
  const requestDigest = contentDigest(bound);
  const previous = workflow.db.prepare('SELECT body FROM workflow_runs WHERE id=?').get(runId);
  if (previous) {
    const old = JSON.parse(previous.body); if (old.requestDigest !== requestDigest) throw new Error('Verifier run identity has different inputs.');
    return reconcileVerification(workflow, runId);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run = { ...bound, requestDigest, requestPath, receiptPath, receiptKey: randomBytes(32).toString('hex'), status: 'admitted', startedAt: workflow.clock() };
  workflow.control.transaction(() => {
    workflow.db.prepare('INSERT INTO workflow_runs VALUES(?,?,?,?)').run(runId, candidateId, gateId, JSON.stringify(run));
    workflow.event('verification_started', task.taskId, null, { runId, candidateId, gateId });
  });
  try {
    const {receiptKey,...request}=run; durableJSON(requestPath, request);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./runner.mjs', import.meta.url)), requestPath], { stdio: ['ignore','ignore','ignore','ipc'], detached: true, windowsHide: true });
    child.once('message',message=>{
      if(message?.ready===true && child.connected) child.send({receiptKey},()=>{if(child.connected)child.disconnect();});
    });
    child.once('error', () => { /* Persisted admission remains unknown until reconciled. */ }); child.unref();
    run.pid = child.pid ?? null; run.status = child.pid ? 'running' : 'unknown';
    workflow.db.prepare('UPDATE workflow_runs SET body=? WHERE id=?').run(JSON.stringify(run), runId);
  } catch (error) {
    run.status = 'unknown'; run.failure = 'Runner dispatch was not confirmed.';
    workflow.db.prepare('UPDATE workflow_runs SET body=? WHERE id=?').run(JSON.stringify(run), runId);
    throw error;
  }
  return { runId, status: run.status, candidateId, gateId };
}
export function reconcileVerification(workflow, runId) {
  const row = workflow.db.prepare('SELECT body FROM workflow_runs WHERE id=?').get(runId);
  if (!row) throw new Error('Verifier run not found.');
  const run = JSON.parse(row.body);
  if (run.result) return { runId, status: 'completed', result: run.result };
  if (!existsSync(run.receiptPath)) {
    let running = false; try { if (run.pid) { process.kill(run.pid, 0); running = true; } } catch { /* Absence is not proof of failed external effects. */ }
    return { runId, status: running ? 'running' : 'unknown', reason: 'No durable receipt yet; do not replay.', candidateId: run.candidateId, gateId: run.gateId };
  }
  const receipt = JSON.parse(readFileSync(run.receiptPath,'utf8'));
  const {signature,...unsigned}=receipt;
  if (signature !== createHmac('sha256',run.receiptKey).update(canonical(unsigned)).digest('hex')) throw new Error('Verifier receipt authentication failed.');
  if (receipt.requestDigest !== run.requestDigest || receipt.candidateRef !== run.candidateRef) throw new Error('Verifier receipt binding mismatch.');
  const diagnosticsRef = workflow.artifacts.putJSON(receipt.diagnostics).ref;
  const result = { runId, candidateRef: run.candidateRef, gateDigest: contentDigest(run.gate), environment: run.environment,
    outcome: receipt.outcome, reason: receipt.reason ?? null, tests: receipt.tests ?? null, diagnosticsRef,
    source: run.source, sourceRef: run.sourceRef, startedAt: receipt.startedAt, completedAt: receipt.completedAt, provenance: 'executable-runner' };
  workflow.control.transaction(() => {
    workflow.recordVerification(run.candidateId, run.gateId, result);
    run.status = 'completed'; run.result = result; workflow.db.prepare('UPDATE workflow_runs SET body=? WHERE id=?').run(JSON.stringify(run), runId);
  });
  return { runId, status: 'completed', result };
}
export async function runVerification(workflow, input, { signal, intervalMs = 100 } = {}) {
  let state = startVerification(workflow, input);
  while (['running','admitted'].includes(state.status) && !signal?.aborted) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    state = reconcileVerification(workflow, input.runId);
  }
  return state;
}

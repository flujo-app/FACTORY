import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { runPilot } from '../scripts/pilot.mjs';

test('real Git mutation survives abrupt process exit and is reconciled without another delivery',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'factory-recovery-'));
  try {
    const report=await runPilot(join(parent,'proof'));
    assert.equal(report.passed,true);assert.equal(report.results.filter(x=>x.passed).length,1);
    assert.equal(report.final.taskStatus,'delivered');assert.equal(report.recovery.blindReplay,false);assert.equal(report.recovery.staleAdmissionRejected,true);
    assert.equal(report.cloudProvisioned,false);assert.equal(report.providerCalls,0);assert.equal(report.networkFederationQualified,false);
  } finally {
    assert.equal(dirname(resolve(parent)),resolve(tmpdir()));assert.ok(basename(parent).startsWith('factory-recovery-'));
    await rm(parent,{recursive:true,force:true,maxRetries:3});
  }
});

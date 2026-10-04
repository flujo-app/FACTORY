import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FactoryControl, digest } from '../../src/control.mjs';
import { SpendingLedger } from '../../src/spending.mjs';
import { createOriginalInferenceBootstrap } from '../../src/original-inference-contract.mjs';
import { OriginalModelStepJournal, initializeOriginalModelStepSchema } from '../../src/original-model-step-journal.mjs';
import { canonicalMissionPacket, nativeMissionRequest, nativeMissionEffectKey } from '../../src/native-mission-contract.mjs';

export const canonical = canonicalMissionPacket;
export const encoded = value => Buffer.from(canonical(value));
export const sha = value => createHash('sha256').update(value).digest('hex');
export const proof = Buffer.from('synthetic-owned-issuer-proof-v2');
export const privateFiles = process.env.FACTORY_PRIVATE_MODULE ? await import(pathToFileURL(process.env.FACTORY_PRIVATE_MODULE).href) : {
  ensurePrivateDirectory: p => fs.mkdir(p, { recursive: true }),
  readPrivateJson: async p => JSON.parse(await fs.readFile(p, 'utf8')),
  writePrivateJson: async (p, value) => fs.writeFile(p, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
};
export function makeSyntheticHost(records) {
  const originals = new Map(records.map(r => [sha(encoded(r)), r]));
  let verificationCalls = 0, receiverCalls = 0;
  const bootstrap = createOriginalInferenceBootstrap({ issuerId: 'fixture-issuer', keyId: 'fixture-key', verifyOriginal(input) {
    verificationCalls++;
    const record = originals.get(input.envelopeSha256);
    if (!record || !input.proofBytes.equals(proof)) throw new Error('synthetic original mismatch');
    return { format: 'factory-original-inference-authentication', schemaVersion: 1,
      issuerId: 'fixture-issuer', keyId: 'fixture-key', envelopeSha256: input.envelopeSha256,
      principalId: record.call.principalId, requestId: record.call.requestId, nonce: record.call.nonce };
  } });
  const compareReceiver = record => {
    receiverCalls++;
    // Declared fixture comparison only; no Python/CommunityAI receiver exists in these tests.
    return { format: 'factory-original-model-step-receiver-comparison', schemaVersion: 1,
      renderer: record.body.renderer, bodySha256: record.body.sha256,
      modelManifestDigest: record.model.manifestDigest, recipientId: record.call.recipientId };
  };
  return { bootstrap, compareReceiver, capability: r => bootstrap.authenticate(encoded(r), proof),
    get verificationCalls() { return verificationCalls; }, get receiverCalls() { return receiverCalls; } };
}
export async function fixture(t, { slots = 2, register = true, paidReady = true, parentRunning = true, preMigrationWriter = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fms-')); await privateFiles.ensurePrivateDirectory(dir);
  let now = 1791078000000, control = new FactoryControl(path.join(dir, 'control.sqlite'), { clock: () => now });
  let paid = new SpendingLedger(path.join(dir, 'paid.sqlite'), { clock: () => now });
  control.initialize({ mission: 'synthetic fixture only', budgetCents: 10000, maxCells: 4, maxDepth: 2 });
  paid.initialize({ limitCents: 1000, currency: 'USD' });
  const oldWriter = preMigrationWriter ? new DatabaseSync(path.join(dir, 'control.sqlite')) : null;
  const oldUpdate = oldWriter?.prepare('UPDATE effects SET state=? WHERE key=?');
  const oldTaskUpdate = oldWriter?.prepare('UPDATE tasks SET specification=?,spec_digest=? WHERE id=?');
  control.pause(); initializeOriginalModelStepSchema(control); control.resume();
  control.reserveCell({ cellId: 'child', role: 'developer', budgetCents: 1000, purpose: 'synthetic original-step journal' });
  control.createTask({ taskId: 'launch', projectId: 'fixture', branch: 'codex/launch', specification: { problem: 'fixture provision', acceptance: ['fixture ready'], baseline: 'fixture' } });
  const launcher = control.claimTask('launch', 'root', 600000);
  control.admitEffect(launcher, { key: 'provision', kind: 'provision', request: { cellId: 'child', app: 'factory-child' } });
  control.startEffect(launcher, 'provision'); control.settleEffect('provision', 'succeeded', { worker: 'factory-child', app: 'factory-child', state: 'ready' });
  const worker = { workspace: 'mission', archiveSha256: 'a'.repeat(64), compatibility: {
    applicationVersion: '3.46.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1, revision: 'c'.repeat(40) } };
  const nativeMission = { schemaVersion: 1, missionId: 'b'.repeat(32), cellId: 'child', app: 'factory-child', provisionKey: 'provision', worker,
    flowId: 'flow', flowSha256: 'f'.repeat(64), paid: { provider: 'modal', ceilingCents: 500 } };
  const model = { manifestDigest: 'sha256:' + '1'.repeat(64), revision: '3'.repeat(40), numBlocks: 4, policyVersion: 1 };
  const recipients = [{ id: 'community-fixture', principalId: 'developer-fixture', role: 'developer', kind: 'communityai-coordinator',
    origin: 'http://127.0.0.1:8000', identitySha256: '4'.repeat(64), buildSha256: '5'.repeat(64), generationSha256: '6'.repeat(64),
    classification: { confidentialityClass: 'ordinary', classVersion: 1 } }];
  const canonicalUtf8 = '{"messages":[{"content":"synthetic body","role":"user"}],"model":"' + model.manifestDigest + '","n":1,"stream":false,"temperature":1.0}';
  const body = { kind: 'chat', renderer: 'communityai-python-json-v1', canonicalUtf8, sha256: sha(Buffer.from(canonicalUtf8)) };
  const calls = Array.from({ length: slots }, (_, ordinal) => ({ requestId: String(ordinal + 10).padStart(32, '0'), nonce: String(ordinal + 100).padStart(32, '0'),
    slot: { nodeId: 'model-node', ordinal }, principalId: 'developer-fixture', role: 'developer', recipientId: 'community-fixture' }));
  const plan = { format: 'factory-original-call-plan', schemaVersion: 1, slots: calls.map(call => ({ requestId: call.requestId, nonce: call.nonce,
    slot: call.slot, bindingSha256: digest({ call, model, recipients, body }),requiredOutcome:'succeeded' })) };
  const originalInference = { schemaVersion: 1, classification: { confidentialityClass: 'ordinary', classVersion: 1 }, issuerId: 'fixture-issuer', keyId: 'fixture-key',
    factoryId: 'fixture-factory', originId: 'fixture-original', completeOriginalSha256: '7'.repeat(64), planSha256: digest(plan), plan };
  const specification = { taskType: 'software', problem: 'synthetic journal fixture', acceptance: ['local journal state only'], baseline: 'fixture', nativeMission, originalInference };
  control.createTask({ taskId: 'develop', projectId: 'fixture', branch: 'codex/develop', specification });
  const task = control.task('develop');
  const lease = control.claimNativeMission({ taskId: task.id, expectedSpecDigest: task.spec_digest, expectedFactoryEpoch: control.control().epoch, workerProof: worker, ttlMs: 600000 });
  const outputDirectory = path.join(dir, 'output'); await privateFiles.ensurePrivateDirectory(outputDirectory);
  const outputFile = path.join(outputDirectory, nativeMission.missionId + '.private.json');
  const request = nativeMissionRequest(control.task('develop'), lease, outputFile), parentKey = nativeMissionEffectKey(request);
  const records = calls.map(call => ({ format: 'factory-original-inference', schemaVersion: 2, canonicalization: 'factory-json-safe-integer-v1',
    issuer: { id: 'fixture-issuer', keyId: 'fixture-key' }, authority: { factoryId: 'fixture-factory', originId: 'fixture-original', contractVersion: 2 },
    classification: { confidentialityClass: 'ordinary', classVersion: 1 }, task: { id: task.id, projectId: task.project_id, branch: task.branch, specification, specDigest: task.spec_digest },
    parent: { request, requestSha256: digest(request), effectKey: parentKey },
    lease: { scope: lease.scope, scopeId: lease.scopeId, cellId: lease.cellId, epoch: lease.epoch, controlEpoch: lease.controlEpoch, expires: lease.expires, tokenSha256: sha(lease.token) },
    reservation: { reservationId: 'paid.' + parentKey, provider: 'modal', ceilingCents: 500 }, call, model, recipients, body, plan }));
  let host = makeSyntheticHost(records), journal = new OriginalModelStepJournal({ control, paidAdmission: paid, bootstrap: host.bootstrap, compareReceiver: host.compareReceiver });
  let capabilities = records.map(host.capability);
  journal.admitParent(lease, capabilities[0]);
  if (parentRunning) control.transaction(() => control.db.prepare("UPDATE effects SET state='running' WHERE key=?").run(parentKey)); // Synthetic fixture only: never calls native dispatcher.
  if (paidReady) { paid.reserveFresh({ reservationId: 'paid.' + parentKey, provider: 'modal', ceilingCents: 500 }); paid.start('paid.' + parentKey); }
  if (register) for (const capability of capabilities) journal.register(lease, capability);
  t.after(() => { control.close(); paid.close(); oldWriter?.close(); }); // Retain owned evidence; no recursive deletion.
  t.diagnostic('Owned synthetic fixture: ' + dir);
  return { dir, records, capabilities, lease, parentKey, outputFile, worker, outputDirectory, oldUpdate,oldTaskUpdate,
    get control() { return control; }, get paid() { return paid; }, get journal() { return journal; }, get host() { return host; },
    advance(ms) { now += ms; },
    reopen() { control.close(); paid.close(); control = new FactoryControl(path.join(dir, 'control.sqlite'), { clock: () => now }); paid = new SpendingLedger(path.join(dir, 'paid.sqlite'), { clock: () => now });
      host = makeSyntheticHost(records); capabilities = records.map(host.capability); journal = new OriginalModelStepJournal({ control, paidAdmission: paid, bootstrap: host.bootstrap, compareReceiver: host.compareReceiver });
      this.capabilities = capabilities; },
    closeParent() { for (const cap of capabilities) { const s = journal.observe(cap).state; if (s === 'accepted') journal.claim(lease,cap); if (['accepted','running', 'unknown'].includes(s)) journal.settle(cap, 'succeeded', { state: 'synthetic_observed' }); }
      control.settleEffect(parentKey, 'succeeded', { state: 'synthetic_completed' }); }
  };
}

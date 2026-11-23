import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunPodSelfHostedModel, runpodEndpointOrigin, runpodGpus, runpodPodRequest, runCommand, selfHostedProfiles, SELFHOST_RUNPOD_DIR,
  codexProviderConfig, claudeProviderEnvironment, validateCloudLitePlan } from '../src/public-sdk.mjs';
import { tempDir } from './support/temp-dir.mjs';

const fresh = () => tempDir('factory-runpod-');
const ACCOUNT_KEY = 'rpa_fixture_account_key_0123456789abcdef';
const B300 = 'NVIDIA B300 SXM6 AC';
const decode = value => Buffer.from(value, 'base64').toString('utf8');

// A fake RunPod account (REST API v2) and the vLLM servers its pods run. The settings come from
// the real profiles through the real Python script; nothing leaves this process.
function fixture({ busyGpus = [], freeAfterTries = Infinity, catalogue = null, loseCreate = false, refuseStart = false, refuseKey = false,
  completion, notServingReads = 2, accountKeys = [ACCOUNT_KEY], modelOptions = {} } = {}) {
  const pods = new Map(), api = [], model = [], creates = [], calls = [];
  let tries = 0, serial = 0, reads = notServingReads;
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    if (target.hostname === 'api.runpod.io') {
      const authorization = options.headers?.authorization;
      api.push({ method: options.method ?? 'GET', path: target.pathname + target.search, authorization, body: options.body });
      if (!accountKeys.some(key => authorization === `Bearer ${key}`)) return reply(401, { detail: 'unauthorized' });
      const [, , resource, id, action] = target.pathname.split('/');
      if (resource === 'catalog') return catalogue ? reply(200, { gpus: catalogue }) : reply(403, { detail: 'scope' });
      if (resource !== 'pods') return reply(404, { detail: 'no such route' });
      if (!id && options.method === 'POST') {
        const body = JSON.parse(options.body);
        creates.push(body);
        if (refuseKey) return reply(403, { detail: 'forbidden' });
        tries++;
        if (busyGpus.includes(body.gpu.id) && tries <= freeAfterTries) return reply(400, { detail: 'There are no instances available with the requested specifications.' });
        const pod = { id: `pod${String(++serial).padStart(6, '0')}`, name: body.name, status: 'PROVISIONING', gpu: body.gpu, env: body.env, image: body.image, reads: 0 };
        pods.set(pod.id, pod);
        if (loseCreate) throw new TypeError('fetch failed');
        return reply(201, { id: pod.id, name: pod.name, status: pod.status });
      }
      if (!id) return reply(200, { pods: [...pods.values()].map(({ id: podId, name, status }) => ({ id: podId, name, status })), pagination: { hasNextPage: false, nextCursor: null } });
      const pod = pods.get(id);
      if (!pod) return reply(404, { detail: 'not found' });
      if (options.method === 'DELETE') { pods.delete(id); return new Response(null, { status: 204 }); }
      if (action === 'action') {
        const { action: kind } = JSON.parse(options.body);
        if (kind === 'stop') { pod.status = 'EXITED'; return reply(200, { id, status: pod.status }); }
        if (kind === 'start') {
          if (refuseStart) return reply(400, { detail: 'The GPU of this machine is taken.' });
          pod.status = 'RUNNING'; return reply(200, { id, status: pod.status });
        }
      }
      if (pod.status === 'PROVISIONING' && ++pod.reads > 1) pod.status = 'RUNNING';
      return reply(200, { id, name: pod.name, status: pod.status, env: pod.env });
    }
    const match = target.hostname.match(/^(pod\d{6})-8000\.proxy\.runpod\.net$/);
    model.push({ url, authorization: options.headers?.authorization });
    const pod = match && pods.get(match[1]);
    if (!pod || pod.status !== 'RUNNING') return new Response('no pod', { status: 502 });
    if (target.pathname === '/v1/models') {
      if (reads-- > 0) return new Response('starting', { status: 502 });
      return options.headers?.authorization === `Bearer ${pod.env.VLLM_API_KEY}` ? reply(200, { data: [{ id: 'nemotron-3.5-super-vl' }] }) : reply(401, {});
    }
    const body = JSON.parse(options.body);
    const challenge = body.messages[0].content.match(/FACTORY-[A-F0-9]{8}/)?.[0];
    return reply(200, completion?.(body, challenge) ?? { model: body.model, choices: [{ message: { role: 'assistant', content: challenge }, finish_reason: 'stop' }] });
  };
  const commandRunner = (command, args, options) => { calls.push({ command, args, env: options.env, input: options.input }); return runCommand(command, args, options); };
  let now = Date.parse('2026-11-23T12:00:00Z');
  const clock = () => (now += 1000);
  const runpod = new RunPodSelfHostedModel({ directory: fresh(), apiKey: ACCOUNT_KEY, fetchImpl, commandRunner, clock, pollMs: 1, gpuRetryMs: 1, stopWaitMs: 60_000,
    env: { ...process.env, FACTORY_SELFHOST_SETTINGS_B64: 'inherited-must-be-dropped', RUNPOD_API_KEY: 'must-not-reach-python' }, ...modelOptions });
  return { runpod, pods, api, model, creates, calls, setAccountKeys: keys => { accountKeys = keys; } };
}

const pythonSettings = (profile, overrides = {}) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['-B', fileURLToPath(new URL('../selfhost/modal/deploy.py', import.meta.url))], { encoding: 'utf8',
    input: JSON.stringify({ action: 'describe', appName: `factory-${profile}-0123456789ab`, profile, overrides }) });
  return JSON.parse(result.stdout).settings;
};

test('a Nemotron pod: official image and weights, the Modal profile\'s own vLLM command, the key only where it belongs', async () => {
  const f = fixture();
  const ready = await f.runpod.deploy();
  assert.equal(ready.phase, 'ready'); assert.equal(ready.verified, true); assert.equal(ready.cloud, 'runpod');
  assert.equal(ready.gpu, 'B300'); assert.equal(ready.usdPerHourPerReplica, 8.99); assert.equal(ready.scaledownMinutes, 8);
  const [body] = f.creates;
  assert.match(body.image, /^vllm\/vllm-openai@sha256:[a-f0-9]{64}$/);
  assert.equal(body.image, JSON.parse(readFileSync(fileURLToPath(new URL('../selfhost/modal/profiles/nemotron.json', import.meta.url)), 'utf8')).image);
  assert.deepEqual(body.gpu, { id: B300, count: 1 }); assert.equal(body.cloud, 'SECURE');
  assert.deepEqual(body.ports, ['8000/http']); assert.deepEqual(body.mounts, { persistent: { size: 110, path: '/workspace' } });
  assert.deepEqual(body.entrypoint.slice(0, 2), ['python3', '-c']);
  assert.equal(body.startSsh, undefined); assert.equal(body.startJupyter, undefined);
  const plan = JSON.parse(decode(body.env.FACTORY_SELFHOST_PLAN_B64));
  assert.deepEqual(plan.argv, pythonSettings('nemotron').vllmCommand, 'the same server settings as on Modal');
  assert.deepEqual(plan.argv.slice(0, 3), ['vllm', 'serve', 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4']);
  assert.equal(plan.argv[plan.argv.indexOf('--revision') + 1], '2e5cc3953bb1ea66b2fb7c831fee3aa317427e69');
  assert.equal(plan.argv[plan.argv.indexOf('--mamba-cache-mode') + 1], 'align');
  assert.deepEqual(JSON.parse(plan.argv[plan.argv.indexOf('--speculative-config') + 1]), { method: 'mtp', num_speculative_tokens: 1 });
  assert.deepEqual(plan.env, { OMP_NUM_THREADS: '1' }); assert.equal(plan.idleMinutes, 8); assert.equal(plan.startupMinutes, 40);
  assert.equal(decode(body.env.FACTORY_SELFHOST_BOOT_B64), readFileSync(join(SELFHOST_RUNPOD_DIR, 'boot.py'), 'utf8'));
  assert.match(decode(body.env.FACTORY_SELFHOST_DISCOVERY_B64), /async def models_metadata/);
  assert.equal(body.env.RUNPOD_API_KEY, undefined, 'the account key never enters a pod');
  assert.ok(JSON.stringify(body).length < 100_000); assert.ok(Object.keys(body.env).length < 50);

  const key = await f.runpod.key();
  assert.equal(body.env.VLLM_API_KEY, key); assert.ok(key.length >= 48);
  const journal = readFileSync(join(f.runpod.directory, 'model.json'), 'utf8');
  for (const text of [journal, JSON.stringify(ready)]) { assert.equal(text.includes(key), false); assert.equal(text.includes(ACCOUNT_KEY), false); }
  assert.doesNotMatch(JSON.stringify(ready), /proxy\.runpod\.net|pod0000|factory-nemotron-/);
  assert.ok(f.api.every(call => call.authorization === `Bearer ${ACCOUNT_KEY}`));
  assert.equal(f.api.filter(call => call.body?.includes(key)).length, 1, 'the endpoint key reaches RunPod only in the pod request');
  assert.ok(f.model.every(call => call.authorization === `Bearer ${key}`), 'the account key never goes to the model');
  assert.ok(f.calls.every(call => call.env.RUNPOD_API_KEY === undefined && call.env.FACTORY_SELFHOST_SETTINGS_B64 === undefined));

  const provider = f.runpod.endpoint();
  assert.deepEqual(provider.baseUrls, ['https://pod000001-8000.proxy.runpod.net/v1']);
  assert.equal(provider.model, 'nemotron-3.5-super-vl'); assert.equal(provider.envKey, 'FACTORY_SELFHOSTED_MODEL_KEY');
  assert.equal(provider.contextWindow, 262144); assert.equal(provider.autoCompactTokenLimit, 80000);
  assert.deepEqual(provider.apis, ['responses', 'chat', 'anthropic']);
  assert.equal(validateCloudLitePlan({ runId: 'runpod-run', app: 'runpod-app', goal: 'x', modelProvider: provider }).modelProvider.model, 'nemotron-3.5-super-vl');
  assert.match(codexProviderConfig(provider), /pod000001-8000\.proxy\.runpod\.net\/v1/);
  assert.match(claudeProviderEnvironment(provider, { key }).ANTHROPIC_BASE_URL, /proxy\.runpod\.net$/);

  assert.equal((await f.runpod.stop()).phase, 'stopped');
  assert.equal(f.pods.get('pod000001').status, 'EXITED');
  assert.throws(() => f.runpod.endpoint(), /not verified/);
  await assert.rejects(f.runpod.deploy({ overrides: { variant: 'fast' } }), /keeps its profile/);
  const resumed = await f.runpod.deploy();
  assert.equal(resumed.phase, 'ready'); assert.equal(f.creates.length, 1, 'the stopped pod starts again');
  assert.equal(await f.runpod.key(), key, 'a redeploy keeps its key');
  const retired = await f.runpod.retire();
  assert.equal(retired.phase, 'retired'); assert.equal(retired.cleanupVerified, true);
  assert.equal(f.pods.size, 0); assert.equal(existsSync(join(f.runpod.directory, 'selfhosted-model.key')), false);
});

test('no B300 free: the profile\'s fallbacks are tried in order, with the live catalogue\'s id and price', async () => {
  const f = fixture({ busyGpus: [B300], catalogue: [{ id: 'NVIDIA B200', name: 'B200', price: { secure: 7.49, community: 5.5 } }] });
  const ready = await f.runpod.deploy();
  assert.equal(ready.gpu, 'B200'); assert.equal(ready.usdPerHourPerReplica, 7.49);
  assert.deepEqual(f.creates.map(body => body.gpu.id), [B300, 'NVIDIA B200']);
  assert.deepEqual(selfHostedProfiles().find(profile => profile.id === 'nemotron').gpuFallbacks, ['B200', 'H200']);

  const renamed = fixture({ catalogue: [{ id: 'NVIDIA B300 SXM6', name: 'B300', price: { secure: 9.5 } }] });
  const placed = await renamed.runpod.deploy({ gpus: ['B300'] });
  assert.equal(renamed.creates[0].gpu.id, 'NVIDIA B300 SXM6', 'a renamed GPU id is found by its name'); assert.equal(placed.usdPerHourPerReplica, 9.5);
});

test('no GPU free at all: nothing is created and nothing is left; with waitForGpuMinutes it waits for one', async () => {
  const all = [B300, 'NVIDIA B200', 'NVIDIA H200'];
  const f = fixture({ busyGpus: all });
  await assert.rejects(f.runpod.deploy(), error => error.outcome === 'not_applied' && /No B300, B200, H200 GPU is free/.test(error.message));
  assert.equal(f.runpod.status().phase, 'retired'); assert.equal(f.pods.size, 0);
  assert.equal(existsSync(join(f.runpod.directory, 'selfhosted-model.key')), false);

  const waited = fixture({ busyGpus: all, freeAfterTries: 6 });
  assert.equal((await waited.runpod.deploy({ waitForGpuMinutes: 30 })).phase, 'ready');
  assert.equal(waited.creates.length, 7, 'two rounds of three refused, then the B300 of the third round');
});

test('a lost create answer is uncertain, never replayed, and retire finds the pod by its name', async () => {
  const f = fixture({ loseCreate: true });
  await assert.rejects(f.runpod.deploy(), error => error.outcome === 'unknown');
  assert.equal(f.runpod.status().phase, 'unknown'); assert.equal(f.pods.size, 1);
  await assert.rejects(f.runpod.deploy(), /retire it to reconcile/);
  assert.equal(f.creates.length, 1);
  const retired = await f.runpod.retire();
  assert.equal(retired.phase, 'retired'); assert.equal(retired.cleanupVerified, true); assert.equal(f.pods.size, 0);
});

test('the profile pins the weights and only the official vLLM image runs; a variant is a normal setting', async () => {
  for (const overrides of [{ model: 'someone/Nemotron-copy' }, { revision: 'main' }, { weights_volume: 'earlier-hf-cache' }]) {
    const f = fixture();
    await assert.rejects(f.runpod.deploy({ overrides }), /cannot be changed/);
    assert.equal(f.runpod.status().phase, 'off'); assert.equal(f.api.length, 0);
  }
  const copy = fixture();
  await assert.rejects(copy.runpod.deploy({ overrides: { image: `someone/vllm-openai@sha256:${'a'.repeat(64)}` } }), /official vLLM image/);
  assert.equal(copy.runpod.status().phase, 'retired'); assert.equal(copy.creates.length, 0);
  const qwen = fixture();
  await assert.rejects(qwen.runpod.deploy({ profile: 'qwen' }), /RunPod GPUs here are B300, B200, H200/);
  const fast = fixture();
  await fast.runpod.deploy({ overrides: { variant: 'fast' } });
  const plan = JSON.parse(decode(fast.creates[0].env.FACTORY_SELFHOST_PLAN_B64));
  assert.deepEqual(plan.argv, pythonSettings('nemotron', { variant: 'fast' }).vllmCommand);
  assert.ok(plan.argv.includes('--async-scheduling')); assert.equal(plan.argv.includes('--speculative-config'), false);
  const fp16 = fixture();
  await fp16.runpod.deploy({ overrides: { variant: 'mtp1-fp16' } });
  const argv = JSON.parse(decode(fp16.creates[0].env.FACTORY_SELFHOST_PLAN_B64)).argv;
  assert.equal(argv[argv.indexOf('--mamba-ssm-cache-dtype') + 1], 'float16');
});

test('a pod that stopped itself when idle is noticed and started again; a taken GPU gets a new pod', async () => {
  const f = fixture();
  await f.runpod.deploy();
  f.pods.get('pod000001').status = 'EXITED';    // boot.py stopped it after the idle minutes
  const refreshed = await f.runpod.refresh();
  assert.equal(refreshed.phase, 'stopped'); assert.equal(refreshed.stoppedBy, 'idle');
  assert.equal((await f.runpod.deploy()).phase, 'ready');
  assert.equal(f.pods.get('pod000001').status, 'RUNNING');

  const taken = fixture({ refuseStart: true });
  await taken.runpod.deploy();
  taken.pods.get('pod000001').status = 'EXITED';
  const ready = await taken.runpod.deploy();     // deploy refreshes a ready model first
  assert.equal(ready.phase, 'ready');
  assert.deepEqual([...taken.pods.keys()], ['pod000002'], 'the old pod is deleted, a new one serves');
  assert.deepEqual(taken.runpod.endpoint().baseUrls, ['https://pod000002-8000.proxy.runpod.net/v1']);
});

test('stop and retire refuse a key that does not reach the owned pods; a missing key stops everything before it starts', async () => {
  const f = fixture({ accountKeys: [ACCOUNT_KEY, 'rpa_other_account_key_000000000000'] });
  await f.runpod.deploy();
  f.setAccountKeys([ACCOUNT_KEY]);
  const other = new RunPodSelfHostedModel({ directory: f.runpod.directory, apiKey: 'rpa_other_account_key_000000000000', fetchImpl: f.runpod.fetch, clock: f.runpod.clock, pollMs: 1 });
  await assert.rejects(other.retire(), /does not reach the owned pods/);
  await assert.rejects(other.stop(), /does not reach the owned pods/);
  assert.equal(f.pods.size, 1);
  f.setAccountKeys([ACCOUNT_KEY, 'rpa_other_account_key_000000000000']);
  assert.equal((await other.retire()).phase, 'retired', 'a new key of the same account sees the pods');
  assert.equal(f.pods.size, 0);

  const none = fixture({ modelOptions: { apiKey: () => undefined } });
  await assert.rejects(none.runpod.deploy(), /Set RUNPOD_API_KEY/);
  assert.equal(none.api.length, 0); assert.equal(none.calls.length, 0);
  const refused = fixture({ refuseKey: true });
  await assert.rejects(refused.runpod.deploy(), /refused the API key/);
  assert.equal(refused.runpod.status().phase, 'retired');
});

test('a wrong model, a broken challenge or a pod that gives up never becomes ready', async () => {
  for (const completion of [(body, challenge) => ({ model: 'other-model', choices: [{ message: { role: 'assistant', content: challenge }, finish_reason: 'stop' }] }),
    () => ({ model: 'nemotron-3.5-super-vl', choices: [{ message: { role: 'assistant', content: 'something else' }, finish_reason: 'stop' }] })]) {
    const f = fixture({ completion });
    await assert.rejects(f.runpod.deploy(), error => error.outcome === 'unknown');
    assert.equal(f.runpod.status().phase, 'unknown'); assert.throws(() => f.runpod.endpoint(), /not verified/);
    assert.equal((await f.runpod.retire()).phase, 'retired'); assert.equal(f.pods.size, 0);
  }
  // vLLM never answers and boot.py stops the pod: the wait ends at once.
  const stuck = fixture({ notServingReads: Infinity });
  const pending = stuck.runpod.deploy();
  const timer = setInterval(() => { const pod = stuck.pods.get('pod000001'); if (pod?.status === 'RUNNING' && stuck.model.length > 3) pod.status = 'EXITED'; }, 1);
  await assert.rejects(pending, error => error.outcome === 'unknown');
  clearInterval(timer);
  assert.equal(stuck.runpod.status().phase, 'unknown');
});

test('only RunPod proxy origins are accepted as endpoints; an adopted model is only retired', async () => {
  assert.equal(runpodEndpointOrigin('https://abc123xyz-8000.proxy.runpod.net'), 'https://abc123xyz-8000.proxy.runpod.net');
  for (const raw of ['http://abc123xyz-8000.proxy.runpod.net', 'https://abc123xyz-8000.proxy.runpod.net.example.test', 'https://abc123xyz-8000.proxy.runpod.net/v1',
    'https://user:pw@abc123xyz-8000.proxy.runpod.net', 'https://evil.example.test', 'not a url']) assert.equal(runpodEndpointOrigin(raw), null, raw);
  assert.deepEqual(Object.keys(runpodGpus().gpus), ['B300', 'B200', 'H200']);
  const request = runpodPodRequest({ name: 'factory-nemotron-0123456789ab-r1', gpuId: B300, image: 'vllm/vllm-openai@sha256:' + 'a'.repeat(64),
    launch: { port: 8000, argv: ['vllm', 'serve', 'x'] }, key: 'k'.repeat(48), networkVolumeId: 'vol123abc', dataCenterIds: ['EU-RO-1'] });
  assert.deepEqual(request.mounts, { network: [{ volumeId: 'vol123abc', path: '/workspace' }] }); assert.deepEqual(request.dataCenterIds, ['EU-RO-1']);

  const f = fixture();
  const appName = 'factory-nemotron-00112233aabb';
  f.pods.set('pod777777', { id: 'pod777777', name: `${appName}-r1`, status: 'RUNNING', env: {} });
  f.pods.set('pod888888', { id: 'pod888888', name: 'someone-elses-pod', status: 'RUNNING', env: {} });
  assert.throws(() => f.runpod.adopt({ appName: 'other-nemotron-00112233aabb' }), /owner prefix/);
  assert.equal(f.runpod.adopt({ appName }).phase, 'unknown');
  await assert.rejects(f.runpod.deploy(), /retire it to reconcile/);
  assert.equal((await f.runpod.retire()).phase, 'retired');
  assert.deepEqual([...f.pods.keys()], ['pod888888'], 'only the owned pod is deleted');
});

test('factory-selfhost drives a RunPod folder and keeps each folder to one cloud', () => {
  const cli = fileURLToPath(new URL('../bin/factory-selfhost.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, RUNPOD_API_KEY: '' } });
  const dir = fresh();
  const status = JSON.parse(run('status', '--dir', dir, '--cloud', 'runpod').stdout);
  assert.equal(status.phase, 'off'); assert.equal(status.cloud, 'runpod');
  assert.match(run('deploy', '--dir', dir, '--cloud', 'runpod', '--prefetch').stderr, /--prefetch is for Modal/);
  assert.match(run('deploy', '--dir', dir, '--cloud', 'runpod').stderr, /Set RUNPOD_API_KEY/);
  assert.match(run('deploy', '--dir', dir, '--gpu', 'B300').stderr, /is for RunPod/);
  assert.match(run('refresh', '--dir', dir).stderr, /for RunPod models/);
  writeFileSync(join(dir, 'model.json'), JSON.stringify({ version: 1, cloud: 'runpod', appName: 'factory-nemotron-00112233aabb', phase: 'retired' }));
  assert.equal(JSON.parse(run('status', '--dir', dir).stdout).cloud, 'runpod', 'the folder remembers its cloud');
  assert.match(run('status', '--dir', dir, '--cloud', 'modal').stderr, /holds a runpod model/);
  assert.match(run('--help').stdout, /--wait-gpu/);
});

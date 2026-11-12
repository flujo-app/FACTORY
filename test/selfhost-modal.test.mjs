import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModalSelfHostedModel, selfHostedProfiles, codexProviderConfig, claudeProviderEnvironment, validateCloudLitePlan } from '../src/public-sdk.mjs';
import { tempDir } from './support/temp-dir.mjs';

const fresh = () => tempDir('factory-selfhost-');
const read = (path) => readFileSync(path, 'utf8');

// A fake Modal account: the deploy script, the Modal CLI and the served model.
function fixture({ deployError, describeError, holdDescribe, workspace = 'fixture-workspace', completion, redirect, catalogueBytes, stoppingReads = 0, refusedDeletes = 0, stopFor = Infinity, modelOptions = {} } = {}) {
  const calls = [], requests = [], apps = new Map(), secrets = new Set(), volumes = new Set();
  let reads = stoppingReads, refusals = refusedDeletes;
  let key, appName, account = workspace;
  const runner = async (command, args, options) => {
    calls.push({ command, args, input: options.input, env: options.env });
    if (args.at(-1)?.endsWith('deploy.py')) {
      const request = JSON.parse(options.input);
      appName = request.appName;
      assert.match(appName, /^factory-(qwen|nemotron)-[a-f0-9]{12}$/);
      if (request.action === 'describe') {
        if (holdDescribe) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
        if (describeError) return { code: 1, stdout: JSON.stringify({ error: describeError }) };
        const nemotron = request.profile === 'nemotron';
        return { code: 0, stdout: `noise\n${JSON.stringify({ settings: { appName, profile: request.profile, label: nemotron ? 'Nemotron on B300' : 'Qwen on H100',
          model: nemotron ? 'nemotron-3.5-super-vl' : 'qwen3.8-27b', gpu: nemotron ? 'B300' : 'H100', replicas: request.overrides.replicas ?? 1,
          contextWindow: 262144, usdPerHourPerReplica: nemotron ? 8.43 : 4.84, scaledownMinutes: 10, startupTimeoutMinutes: 40 }, hints: { compact_tokens: 80000 } })}` };
      }
      if (request.action === 'deploy') {
        if (deployError) return { code: 1, stdout: JSON.stringify({ error: deployError }) };
        if (!request.reuseSecret) { assert.equal(secrets.has(`${appName}-auth`), false); secrets.add(`${appName}-auth`); }
        key = request.key;
        // a reused volume must exist already; only the app's own ones are created
        for (const [name, own] of [[request.overrides.weights_volume, `${appName}-hf-cache`], [request.overrides.compile_volume, `${appName}-vllm-cache`]]) {
          if (name) assert.ok(volumes.has(name), `${name} exists before the deployment`); else volumes.add(own);
        }
        apps.set(appName, 'deployed');
        const replicas = request.overrides.replicas ?? 1;
        return { code: 0, stdout: JSON.stringify({ endpoints: ['serve', 'serve-b'].slice(0, replicas).map(name => `https://fixture--${appName}-${name}.modal.run`) }) };
      }
      return { code: 0, stdout: JSON.stringify({ seconds: 1 }) };
    }
    const cli = args.slice(args.indexOf('modal') + 1);
    if (cli[0] === 'profile') return { code: 0, stdout: JSON.stringify([{ name: 'fixture', workspace: account, active: true }]) };
    if (cli[0] === 'app' && cli[1] === 'stop') { const known = apps.has(cli.at(-1)); if (known) apps.set(cli.at(-1), reads > 0 ? 'stopping' : 'stopped'); return { code: known ? 0 : 1, stdout: '' }; }
    if (cli[0] === 'app' && cli[1] === 'list') {
      if (reads > 0 && --reads === 0 && stopFor === Infinity) for (const [name, state] of apps) if (state === 'stopping') apps.set(name, 'stopped');
      return { code: 0, stdout: JSON.stringify([...apps].map(([description, state]) => ({ description, state }))) };
    }
    if (cli[1] === 'delete') {
      if (refusals > 0) { refusals--; return { code: 1, stdout: '' }; }
      (cli[0] === 'secret' ? secrets : volumes).delete(cli.at(-1)); return { code: 0, stdout: '' };
    }
    if (cli[1] === 'list') return { code: 0, stdout: JSON.stringify([...(cli[0] === 'secret' ? secrets : volumes)].map(name => ({ name }))) };
    throw new Error(`Unexpected command ${cli.join(' ')}`);
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, authorization: options.headers?.authorization });
    const target = new URL(url);
    if (redirect && options.method === 'POST') return new Response(null, { status: 303, headers: { location: redirect(target) } });
    if (target.pathname === '/v1/models') return new Response(catalogueBytes ? ' '.repeat(catalogueBytes) : JSON.stringify({ data: [{ id: 'qwen3.8-27b' }, { id: 'nemotron-3.5-super-vl' }] }));
    const body = options.method === 'POST' ? JSON.parse(options.body) : { model: 'qwen3.8-27b', messages: [{ content: target.searchParams.get('challenge') }] };
    const challenge = body.messages[0].content.match(/FACTORY-[A-F0-9]{8}/)?.[0];
    return new Response(JSON.stringify(completion?.(body, challenge) ?? { model: body.model, choices: [{ message: { role: 'assistant', content: challenge }, finish_reason: 'stop' }] }));
  };
  const model = new ModalSelfHostedModel({ directory: fresh(), python: 'fixture-python', commandRunner: runner, fetchImpl, stopPollMs: 1, ...modelOptions,
    env: { PATH: 'fixture-path', FACTORY_SELFHOST_SETTINGS_B64: 'inherited-must-be-dropped' } });
  return { model, calls, requests, apps, secrets, volumes, key: () => key, appName: () => appName, setWorkspace: value => { account = value; } };
}

test('bundled profiles carry list-price estimates per running replica', () => {
  const profiles = Object.fromEntries(selfHostedProfiles().map(profile => [profile.id, profile]));
  assert.deepEqual(Object.keys(profiles), ['nemotron', 'qwen']);
  assert.equal(profiles.qwen.gpu, 'H100'); assert.equal(profiles.qwen.usdPerHour, 4.84); assert.equal(profiles.qwen.model, 'qwen3.8-27b');
  assert.equal(profiles.nemotron.gpu, 'B300'); assert.equal(profiles.nemotron.usdPerHour, 8.43); assert.equal(profiles.nemotron.variant, 'mtp1');
  assert.ok(profiles.nemotron.variants.includes('fast'));
  for (const profile of Object.values(profiles)) { assert.equal(profile.contextWindow, 262144); assert.equal(profile.autoCompactTokenLimit, 80000); }
});

test('one retire right after a busy replica finishes: it waits for the stop and retries refused deletes', async () => {
  const f = fixture({ stoppingReads: 3, refusedDeletes: 2 });
  await f.model.deploy({ profile: 'qwen' });
  const retired = await f.model.retire();
  assert.equal(retired.phase, 'retired'); assert.equal(retired.cleanupVerified, true);
  assert.equal(f.secrets.size, 0); assert.equal(f.volumes.size, 0);
  const deletes = f.calls.filter(call => call.args.includes('delete') && call.args.includes('--allow-missing'));
  assert.equal(deletes.length, 5, 'three resources, two of the tries refused');
});

test('an app still stopping at the deadline, or a delete that keeps failing, stays uncertain and is never reported as success', async () => {
  const stuck = fixture({ stoppingReads: 10000, stopFor: 0, modelOptions: { stopWaitMs: 20 } });
  await stuck.model.deploy({ profile: 'qwen' });
  await assert.rejects(stuck.model.retire(), /uncertain/);
  assert.equal(stuck.model.status().phase, 'unknown');
  assert.equal(stuck.secrets.size, 1, 'nothing is deleted while the app may still run');
  const refused = fixture({ refusedDeletes: 100 });
  await refused.model.deploy({ profile: 'qwen' });
  await assert.rejects(refused.model.retire(), /uncertain/);
  assert.equal(refused.model.status().phase, 'unknown');
  assert.equal(refused.calls.filter(call => call.args.includes('delete') && call.args.includes('--allow-missing')).length, 5, 'the tries are bounded');
  // The stop path waits too, and a later retire can still finish.
  const stopping = fixture({ stoppingReads: 2 });
  await stopping.model.deploy({ profile: 'qwen' });
  assert.equal((await stopping.model.stop()).phase, 'stopped');
  assert.equal((await stopping.model.retire()).phase, 'retired');
});

test('deploy, verify, describe, stop, redeploy and retire touch only the owned resources', async () => {
  const f = fixture();
  const ready = await f.model.deploy({ profile: 'qwen', overrides: { replicas: 2 } });
  assert.equal(ready.phase, 'ready'); assert.equal(ready.verified, true); assert.equal(ready.endpoints, 2);
  const key = await f.model.key();
  assert.equal(key, f.key()); assert.ok(key.length >= 48);
  const journal = read(join(f.model.directory, 'model.json'));
  for (const text of [JSON.stringify(ready), journal]) assert.equal(text.includes(key), false);
  assert.doesNotMatch(JSON.stringify(ready), /modal\.run|factory-qwen-/);
  assert.ok(f.calls.every(call => call.env.FACTORY_SELFHOST_SETTINGS_B64 === undefined));
  assert.ok(f.calls.filter(call => !call.args.at(-1)?.endsWith('deploy.py')).every(call => call.env.MODAL_PROFILE === 'fixture' || call.args.includes('profile')));
  assert.equal(f.calls.filter(call => call.input?.includes(key)).length, 1, 'the key reaches only the deploy request');
  assert.ok(f.requests.every(request => request.authorization === `Bearer ${key}`));
  const provider = f.model.endpoint();
  assert.deepEqual(provider.baseUrls, [`https://fixture--${f.appName()}-serve.modal.run/v1`, `https://fixture--${f.appName()}-serve-b.modal.run/v1`]);
  assert.equal(provider.envKey, 'FACTORY_SELFHOSTED_MODEL_KEY'); assert.equal(provider.autoCompactTokenLimit, 80000);
  assert.equal(validateCloudLitePlan({ runId: 'selfhost-run', app: 'selfhost-app', goal: 'x', modelProvider: provider }).modelProvider.model, 'qwen3.8-27b');
  assert.match(codexProviderConfig(provider, { index: 1 }), /serve-b\.modal\.run\/v1/);
  assert.match(claudeProviderEnvironment(provider, { key }).ANTHROPIC_BASE_URL, /-serve\.modal\.run$/);
  assert.equal((await f.model.stop()).phase, 'stopped');
  assert.equal(f.apps.get(f.appName()), 'stopped');
  assert.throws(() => f.model.endpoint(), /not verified/);
  await assert.rejects(f.model.deploy({ profile: 'nemotron' }), /keeps its profile/);
  const resumed = await f.model.deploy({ profile: 'qwen', overrides: { replicas: 2 } });
  assert.equal(resumed.phase, 'ready'); assert.equal(await f.model.key(), key, 'a redeploy keeps its key and secret');
  const retired = await f.model.retire();
  assert.equal(retired.phase, 'retired'); assert.equal(retired.cleanupVerified, true);
  assert.equal(f.secrets.size, 0); assert.equal(f.volumes.size, 0);
  assert.equal(existsSync(join(f.model.directory, 'selfhosted-model.key')), false);
  const named = f.calls.filter(call => call.args.includes('stop') || call.args.includes('delete')).map(call => call.args.at(-1));
  assert.ok(named.every(name => name.startsWith(f.appName())), named.join(','));
});

test('volumes an earlier deployment filled are used and survive the retire', async () => {
  const f = fixture();
  f.volumes.add('earlier-hf-cache'); f.volumes.add('earlier-vllm-cache');
  const ready = await f.model.deploy({ profile: 'nemotron', overrides: { weights_volume: 'earlier-hf-cache', compile_volume: 'earlier-vllm-cache' } });
  assert.equal(ready.phase, 'ready');
  assert.deepEqual([...f.volumes].sort(), ['earlier-hf-cache', 'earlier-vllm-cache'], 'no volume of its own is created');
  assert.equal((await f.model.retire()).phase, 'retired');
  assert.deepEqual([...f.volumes].sort(), ['earlier-hf-cache', 'earlier-vllm-cache'], 'the reused volumes are kept');
  const named = f.calls.filter(call => call.args.includes('delete')).map(call => call.args.at(-1));
  assert.ok(named.every(name => name.startsWith(f.appName())), named.join(','));
});

test('an uncertain deployment is kept for reconciliation and never replayed', async () => {
  const f = fixture({ deployError: 'The Modal deployment did not complete.' });
  await assert.rejects(f.model.deploy({ profile: 'nemotron' }), error => error.outcome === 'unknown');
  assert.equal(f.model.status().phase, 'unknown');
  await assert.rejects(f.model.deploy({ profile: 'nemotron' }), /retire it to reconcile/);
  assert.equal(f.calls.filter(call => call.input?.includes('"deploy"')).length, 1);
  const retired = await f.model.retire();
  assert.equal(retired.phase, 'retired', 'a never-created app counts as stopped; secret and volumes are deleted and checked');
});

test('a wrong model or a broken challenge never becomes ready', async () => {
  for (const completion of [(body, challenge) => ({ model: 'other-model', choices: [{ message: { role: 'assistant', content: challenge }, finish_reason: 'stop' }] }),
    () => ({ model: 'qwen3.8-27b', choices: [{ message: { role: 'assistant', content: 'something else' }, finish_reason: 'stop' }] }),
    (body, challenge) => ({ model: 'qwen3.8-27b', choices: [{ message: { role: 'assistant', content: challenge }, finish_reason: 'length' }] })]) {
    const f = fixture({ completion });
    await assert.rejects(f.model.deploy(), error => error.outcome === 'unknown');
    assert.equal(f.model.status().phase, 'unknown');
    assert.throws(() => f.model.endpoint(), /not verified/);
  }
  const oversized = fixture({ catalogueBytes: 70_000 });
  await assert.rejects(oversized.model.deploy(), error => error.outcome === 'unknown');
});

test('Modal result redirects are followed on the same origin only, without replaying the POST', async () => {
  const same = fixture({ redirect: target => `${target.origin}${target.pathname}?__modal_function_call_id=fixture` });
  await assert.rejects(same.model.deploy(), error => error.outcome === 'unknown', 'a GET result without the original body cannot echo a challenge');
  assert.equal(same.requests.filter(request => request.url.endsWith('/v1/chat/completions')).length, 1);
  assert.ok(same.requests.some(request => request.url.includes('__modal_function_call_id=fixture')));
  const away = fixture({ redirect: () => 'https://elsewhere.example.test/v1/chat/completions?x=1' });
  await assert.rejects(away.model.deploy(), error => error.outcome === 'unknown');
  assert.equal(away.requests.some(request => request.url.startsWith('https://elsewhere')), false, 'the key never goes to another origin');
});

test('cleanup refuses a changed Modal workspace and cancellation before remote work leaves nothing behind', async () => {
  const f = fixture();
  await f.model.deploy();
  f.setWorkspace('another-workspace');
  await assert.rejects(f.model.retire(), /workspace changed/);
  await assert.rejects(f.model.stop(), /workspace changed/);
  assert.equal(f.calls.some(call => call.args.includes('stop')), false);
  f.setWorkspace('fixture-workspace');
  assert.equal((await f.model.retire()).phase, 'retired');

  const cancelled = fixture({ holdDescribe: true }); const controller = new AbortController();
  const pending = cancelled.model.deploy({ signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, error => error.outcome === 'not_applied');
  assert.equal(cancelled.model.status().phase, 'retired');
  assert.equal(cancelled.calls.some(call => call.input?.includes('"deploy"')), false);
  const refused = fixture({ describeError: 'unknown gpu' });
  await assert.rejects(refused.model.deploy({ overrides: { gpu: 'TPU' } }), /unknown gpu/);
  assert.equal(refused.model.status().phase, 'retired');
});

test('an owned app from an earlier version can be adopted for verified retirement only', async () => {
  const f = fixture();
  const appName = 'factory-qwen-00112233aabb';
  f.apps.set(appName, 'deployed'); f.secrets.add(`${appName}-auth`); f.volumes.add(`${appName}-hf-cache`);
  assert.throws(() => f.model.adopt({ appName: 'other-qwen-00112233aabb', profileName: 'fixture', workspaceName: 'fixture-workspace' }), /owner prefix/);
  assert.throws(() => f.model.adopt({ appName, profileName: 'fixture' }), /profile and workspace/);
  assert.throws(() => f.model.adopt({ appName, profileName: 'fixture', workspaceName: 'fixture-workspace', endpoints: ['https://elsewhere.example.test'] }), /owned Modal origins/);
  const adopted = f.model.adopt({ appName, profileName: 'fixture', workspaceName: 'fixture-workspace', endpoints: [`https://fixture--${appName}-inference.modal.run`] });
  assert.equal(adopted.phase, 'unknown');
  assert.throws(() => f.model.endpoint(), /not verified/);
  await assert.rejects(f.model.deploy(), /retire it to reconcile/);
  assert.throws(() => f.model.adopt({ appName, profileName: 'fixture', workspaceName: 'fixture-workspace' }), /already journaled/);
  const retired = await f.model.retire();
  assert.equal(retired.phase, 'retired'); assert.equal(retired.cleanupVerified, true);
  assert.equal(f.apps.get(appName), 'stopped'); assert.equal(f.secrets.size, 0); assert.equal(f.volumes.size, 0);
});

test('factory-selfhost lists profiles and never prints the key', () => {
  const cli = fileURLToPath(new URL('../bin/factory-selfhost.mjs', import.meta.url));
  const listed = spawnSync(process.execPath, [cli, 'profiles'], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).map(profile => profile.id), ['nemotron', 'qwen']);
  const dir = fresh();
  assert.equal(JSON.parse(spawnSync(process.execPath, [cli, 'status', '--dir', dir], { encoding: 'utf8' }).stdout).phase, 'off');
  const key = spawnSync(process.execPath, [cli, 'key', '--dir', dir], { encoding: 'utf8' });
  assert.equal(key.status, 1); assert.match(key.stderr, /never printed/);
  assert.match(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout, /retire/);
});

test('a deployment stages the profiles next to the Python sources that read them', async () => {
  const { model } = fixture();
  await model.deploy({ profile: 'qwen' });
  const staged = join(model.directory, 'source', 'profiles');
  for (const name of ['qwen.json', 'nemotron.json']) assert.equal(existsSync(join(staged, name)), true, name);
  assert.equal(JSON.parse(read(join(staged, 'qwen.json'))).served_name, selfHostedProfiles().find(profile => profile.id === 'qwen').model);
});

test('helper runs define no serving function, which would need the secret the deployment creates', () => {
  const source = read(fileURLToPath(new URL('../selfhost/modal/app.py', import.meta.url)));
  const guard = source.indexOf('if not HELPERS:');
  assert.ok(guard > 0);
  for (const name of ['GPU_FUNCTION = dict(', 'def serve():', 'def serve_b():', 'def serve_d():']) assert.ok(source.indexOf(name) > guard, name);
});

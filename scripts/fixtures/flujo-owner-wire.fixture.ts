import type { ExecutionExtensionAdapter, ExecutionOwnerModelDispatchRequest } from '@/backend/execution/extensions';
import type { Model } from '@/shared/types/model';

// This fixture enters the real FLUJO adapter and installed OpenAI SDK, ending
// at the owner callback. It never invokes runFlow, a native route or a provider.
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { fixedWireCommitment } = require('../../test/fixtures/owner-wire-input.mjs');
const FIXTURE_NOW = 10000;
// The trusted fixture helper fixes literal body/headers independently. Never
// construct this commitment from an observed SDK request.
const COMMITMENT = fixedWireCommitment();
const MODEL = Object.freeze({ ...COMMITMENT.wire.model, ApiKey: '' }) as Model;
const RECEIVER_PROFILE = Object.freeze({
  scope: 'selected strict factory admission ingress source; not imported or exercised',
  server: { path: 'C:/Users/Moe/.codex/worktrees/factory-ingress-no-redirect/petals-revival/src/drift/api/server.py',
    bytes: 30193, sha256: '665bcde7f4fae8462d049cf8c3cb54232ad0cc1d474b6644d42f89291077674b' },
  admission: { path: 'C:/Users/Moe/.codex/worktrees/factory-ingress-no-redirect/petals-revival/src/drift/factory_admission.py',
    bytes: 4865, sha256: 'c38fe244152332b2c24ec07128948cc77f28aedae321e3cdd58e1d0b8430f888' },
});

test('real FLUJO SDK streaming bytes reach one fixture claim and physical-send HOLD', async () => {
  expect(process.platform).toBe('win32');
  expect(process.arch).toBe('x64');
  expect(process.version).toBe('v24.19.0');
  const factoryRoot = path.resolve(__dirname, '../..');
  const reportDir = process.env.FACTORY_OWNER_WIRE_REPORT_DIRECTORY;
  if (!reportDir || !/^\.factory[\\/]flujo-owner-wire-sdk-run-[0-9a-f-]{36}[\\/]cases$/.test(path.relative(factoryRoot, reportDir))) {
    throw new Error('FIXTURE_REPORT_DIRECTORY_REQUIRED');
  }
  const reportPath = path.join(reportDir, 'case-report.json');
  fs.writeFileSync(path.join(reportDir, 'precommitted-wire.json'), JSON.stringify(COMMITMENT, null, 2) + '\n', { flag: 'wx' });

  const attempts: Record<string, number> = { globalFetch: 0, socketConnect: 0, netConnect: 0,
    netCreateConnection: 0, tlsConnect: 0, httpRequest: 0, httpGet: 0, httpsRequest: 0,
    httpsGet: 0, undiciFetch: 0 };
  const restores: Array<() => void> = [];
  const deny = (name: keyof typeof attempts) => (..._args: unknown[]) => {
    attempts[name] += 1;
    throw new Error(`OFFLINE_FIXTURE_${name}_FORBIDDEN`);
  };
  const guard = (target: Record<string, any>, key: string, name: keyof typeof attempts) => {
    const prior = target[key]; target[key] = deny(name); restores.push(() => { target[key] = prior; });
  };
  // All transport guards precede app/SDK imports. No real credential exists.
  guard(globalThis as any, 'fetch', 'globalFetch');
  const net = require('node:net');
  guard(net.Socket.prototype, 'connect', 'socketConnect');
  guard(net, 'connect', 'netConnect'); guard(net, 'createConnection', 'netCreateConnection');
  guard(require('node:tls'), 'connect', 'tlsConnect');
  const http = require('node:http'); const https = require('node:https');
  guard(http, 'request', 'httpRequest'); guard(http, 'get', 'httpGet');
  guard(https, 'request', 'httpsRequest'); guard(https, 'get', 'httpsGet');
  guard(require('undici'), 'fetch', 'undiciFetch');
  let restoreExtension: (() => void) | undefined;
  let owner: any;
  let dispatches = 0; let flowEntries = 0;
  let actualWire: unknown; let observed: unknown; let failure: unknown;
  try {
    const { createFixtureOwnerWire, FixtureWireError } = require('../../src/fixture-owner-wire.mjs');
    const { createExecutionExtensionContext, issueExecutionModelStepContext, registerExecutionExtension,
      ExecutionExtensionError } = require('@/backend/execution/extensions');
    const { OpenAiAdapter } = require('@/backend/services/model/adapters/openaiAdapter');
    expect(require('openai/version').VERSION).toBe('7.3.0');
    owner = createFixtureOwnerWire({ databasePath: path.join(reportDir, 'fixture-owner.sqlite'),
      commitment: COMMITMENT, now: () => FIXTURE_NOW });
    const privateValues = new WeakSet<object>();
    const assertRun = async (value: object) => {
      if (!privateValues.has(value)) throw new ExecutionExtensionError('fixture_authorization_denied');
    };
    const extension: ExecutionExtensionAdapter = {
      isProtectedServer: () => false,
      assertServerConfig: () => { throw new ExecutionExtensionError('fixture_mcp_forbidden'); },
      assertRun, bindRun: async value => assertRun(value), signal: () => undefined,
      commit: async (value, task) => { await assertRun(value); const result = await task(); await assertRun(value); return result; },
      protectedServer: () => { throw new ExecutionExtensionError('fixture_mcp_forbidden'); },
      authorizeHandoffs: () => { throw new ExecutionExtensionError('fixture_handoff_forbidden'); },
      assertModelTool: async () => { throw new ExecutionExtensionError('fixture_tool_forbidden'); },
      assertDispatch: async () => { throw new ExecutionExtensionError('fixture_mcp_forbidden'); },
      normalizeArguments: () => { throw new ExecutionExtensionError('fixture_mcp_forbidden'); },
      requestMeta: async () => { throw new ExecutionExtensionError('fixture_mcp_forbidden'); },
      validateResult: () => { throw new ExecutionExtensionError('fixture_mcp_forbidden'); },
      modelAttemptPolicy: async value => { await assertRun(value); return { version: 1, maxPhysicalAttempts: 1 }; },
      issueModelStep: async (parent, model) => {
        await assertRun(parent);
        expect(model).toEqual(COMMITMENT.wire.model);
        const slot = owner.issueFixedSlot({ parent, slotId: COMMITMENT.slotId });
        privateValues.add(slot); return slot;
      },
      dispatchModelRequest: async (slot, request: ExecutionOwnerModelDispatchRequest) => {
        dispatches += 1; await assertRun(slot);
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(request.signal?.aborted).toBe(false);
        // This only captures evidence. The comparison source remains COMMITMENT.
        const { body, signal: _signal, ...rest } = request;
        actualWire = { ...rest, bodyUtf8: Buffer.from(body).toString('utf8') };
        expect(actualWire).toEqual(COMMITMENT.wire);
        expect(JSON.stringify(actualWire)).not.toContain('owner-credential-not-present-in-flujo');
        try { return owner.dispatch(slot, request); }
        catch (error) {
          if (error instanceof FixtureWireError) throw new ExecutionExtensionError(error.code);
          throw error;
        }
      },
    };
    restoreExtension = registerExecutionExtension(extension);
    let adapter: any;
    let input: any;
    await expect(owner.startFixtureFlow({ taskId: COMMITMENT.taskId, startNonce: COMMITMENT.startNonce }, async (parent: object) => {
      flowEntries += 1; privateValues.add(parent);
      expect(owner.observe().parent).toMatchObject({ state: 'running' });
      expect(owner.observe().parent.witness).toBeTruthy();
      const parentContext = createExecutionExtensionContext(extension, parent);
      const child = await issueExecutionModelStepContext(parentContext, MODEL);
      adapter = new OpenAiAdapter();
      input = { model: MODEL, apiKey: '', messages: [{ role: 'user', content: 'offline bridge fixture' }],
        temperature: 1, maxTokens: 8, executionExtensionContext: child };
      // Let HOLD escape through start, preserving the started parent as unknown.
      return adapter.createStreamCompletion(input);
    })).rejects.toMatchObject({ code: 'PHYSICAL_SEND_HOLD' });
    expect(flowEntries).toBe(1); expect(dispatches).toBe(1);
    await expect(adapter.createStreamCompletion(input)).rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
    expect(dispatches).toBe(1);
    observed = owner.observe();
    expect(observed).toMatchObject({ parent: { state: 'unknown' }, child: { state: 'unknown' },
      physicalSend: 'HOLD', receiverQualification: 'HOLD' });
    const duplicate = await owner.startFixtureFlow({ taskId: COMMITMENT.taskId, startNonce: COMMITMENT.startNonce }, async () => {
      flowEntries += 1; throw new Error('FIXTURE_REENTERED');
    });
    expect(duplicate.kind).toBe('observation'); expect(flowEntries).toBe(1); expect(dispatches).toBe(1);
    owner.close();
    owner = undefined;
    owner = createFixtureOwnerWire({ databasePath: path.join(reportDir, 'fixture-owner.sqlite'),
      commitment: COMMITMENT, now: () => FIXTURE_NOW });
    const restarted = await owner.startFixtureFlow({ taskId: COMMITMENT.taskId, startNonce: COMMITMENT.startNonce }, async () => {
      flowEntries += 1; throw new Error('FIXTURE_RESTART_REENTERED');
    });
    expect(restarted.kind).toBe('observation'); expect(flowEntries).toBe(1); expect(dispatches).toBe(1);
    expect(owner.observe()).toEqual(observed);
    observed = owner.observe();
    expect(Object.values(attempts)).toEqual(Object.values(attempts).map(() => 0));
  } catch (error) { failure = error; throw error; }
  finally {
    let finalizerFailure: unknown;
    if (owner) {
      try { observed ??= owner.observe(); } catch (error) { finalizerFailure = error; }
      try { owner.close(); } catch (error) { finalizerFailure ??= error; }
    }
    restoreExtension?.(); for (const restore of restores.reverse()) restore();
    fs.writeFileSync(reportPath, JSON.stringify({ format: 'factory-flujo-sdk-offline-fixture-v1',
      accepted: !failure && !finalizerFailure, scope: 'real-adapter-and-sdk-final-fetch-only',
      productionAuthority: 'HOLD', originalJournalAuthority: 'HOLD',
      receiverCompatibility: 'PINNED_FACTORY_INGRESS_HOLD_STREAM_OPTIONS', receiverProfile: RECEIVER_PROFILE,
      physicalSend: 'PHYSICAL_SEND_HOLD', flowGraphExecution: 'NOT_EXERCISED',
      credentialAccess: 'NO_REAL_CREDENTIAL_CONFIGURED; resolver not present in fixture owner',
      platform: process.platform, arch: process.arch, nodeVersion: process.version,
      commitment: COMMITMENT, actualWire, flowEntries, dispatches, transportAttempts: attempts, observed,
      ...(failure ? { failure: { name: (failure as Error).name, message: String((failure as Error).message).slice(0, 500) } } : {}),
      ...(finalizerFailure ? { finalizerFailure: { name: (finalizerFailure as Error).name, message: String((finalizerFailure as Error).message).slice(0, 500) } } : {}),
    }, null, 2) + '\n', { flag: 'wx' });
    if (!failure && finalizerFailure) throw finalizerFailure;
  }
});

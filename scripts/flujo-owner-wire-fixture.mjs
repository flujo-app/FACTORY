import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Offline, one-case fixture launcher. No command-line overrides, inherited
// credentials, Next/application configuration or application .env loading.
const FACTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLUJO = 'C:/Users/Moe/.codex/worktrees/flujo-owner-model-step-transport/FLUJO';
const NODE = 'C:/Users/Moe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';
const PRIVATE_FILES = 'C:/Users/Moe/Documents/GitHub/flujo-cloud/lib/private-files.mjs';
const RECEIVER_SOURCE_PINS = [
  ['C:/Users/Moe/.codex/worktrees/factory-ingress-no-redirect/petals-revival/src/drift/api/server.py',
    '665bcde7f4fae8462d049cf8c3cb54232ad0cc1d474b6644d42f89291077674b'],
  ['C:/Users/Moe/.codex/worktrees/factory-ingress-no-redirect/petals-revival/src/drift/factory_admission.py',
    'c38fe244152332b2c24ec07128948cc77f28aedae321e3cdd58e1d0b8430f888'],
];
const SELECTED_PINS = [
  ['src/backend/services/model/adapters/openaiAdapter.ts', '2b0d46fa50b393e33aa1e564759c7111d6e4c7aac814975b3a8cf26e21c28088'],
  ['src/backend/services/model/openaiClient.ts', '46d31a65a0613312dadd93c3099ea392ba0776df91d3e6e834a08d4f4f46d561'],
  ['src/backend/execution/extensions/index.ts', 'a838e0031f035d9df7a83f68f04bd2c2845fa69f840ff0b252a0761e0fa15fd9'],
  ['src/backend/execution/extensions/configuredAdapter.ts', '8dd494c0ac42f02e00ab5b0641b43140fff227e282a270d290c51b748e858ca6'],
  ['src/backend/services/model/adapters/types.ts', 'd3f27bdc1850fa45404eec45df39e29d87e9a8501f188a3448cf2a9cdce57270'],
  ['src/backend/services/model/adapters/contextUsage.ts', '76dbf10709baf059e0439b3b9e06c1d779467b48b6068a42e04992f22c7181b6'],
  ['src/backend/services/model/adapters/openaiUsage.ts', '78156c47c25dcd368b13116775fbbf96107fff7c6d0139ff006c63a80596b64c'],
  ['src/backend/services/model/adapters/messageUtils.ts', 'e2ee29cdd83502486c20aacf62c42b4e61d7a013063dcfdf5c0aaab93e42c16a'],
  ['src/backend/services/model/adapters/openaiPromptCaching.ts', '23f267da09a1f997bf43499bf5a58ec2c50ae9c387f6c54729fec4152585d28c'],
  ['src/backend/services/model/adapters/providerToolNames.ts', '1525e178ff5b4004124a452d558c8495dcc679c971fc9713f7be9c5229960c36'],
  ['src/backend/services/model/adapters/completionRoute.ts', 'f7f9f18ed78978dd00cfe0caa52a77d391cf455a98ed6cda81956be092f05a63'],
  ['src/backend/services/model/adapters/openrouterMediaRouting.ts', 'c2644200ce5588048df1ba939af5cfbe007daf985b956c8862fc9de0fd4b8015'],
  ['src/backend/execution/flow/handlers/toolNamespace.ts', '69dbcedfeab29ad3da30b26e9c40f9b929a26e01cf4aae4544c86afaa631cf32'],
  ['src/backend/execution/flow/executionAuthority.ts', 'c72bae486a0d781fc726236024da2d05331c79d239ea4e21d8f82d0128727285'],
  ['src/backend/utils/transientRetry.ts', '65de3279fda53b4b0ed454ea54508a43a21534636f40a3191aac9928bdf41f07'],
  ['src/shared/config/timeouts.ts', '7ae16133d2d6789dc15033c4cc5efcc8673a2335a9fd09ee8345ca476714342c'],
  ['src/shared/types/model/index.ts', '0857fe01144bbffd3b60a58e591e102f238022f9c61a8deeb2b4a1f67269858b'],
  ['src/shared/types/model/model.ts', 'b6923a6f63ab1dfa8fe48c57f91972910a61e8b1ae0b1e248688cea19ae6baa4'],
  ['src/shared/types/model/response.ts', '8031e140a0dd8d9234999a716231d6fda4a803723b13855ee928de10b4b4e87a'],
  ['src/shared/types/model/provider.ts', '306da168b07c6870587d3e1875a4874407a1dbbbac1b3bc35e69a31e4c181e09'],
  ['src/shared/types/model/media.ts', 'ada3162b6c72fb2b7827ec4cfea4295a4332cce68361d582a0fc429eba75edc5'],
  ['src/shared/types/model/embeddings.ts', 'a207feb33b706c3f2102b40215b2daa187ad9e6d123abe53737a70a80eda492b'],
  ['src/utils/logger/index.ts', '880b59370c5985c8d9545192513a3e50a3fcfc7e208ed178cfcc76c3be98312f'],
  ['src/utils/logger/logger.ts', '7549bccb190c0964341cfb526086660876ac54c988368b113d121ec47c18fc4f'],
  ['src/config/features.ts', '280c7eab44f4642ce9d189343aa4e713691d47cf65f0755072ca7c52074486e7'],
  ['node_modules/openai/package.json', 'c3c25e84b67af9006df68038091940c252fa6829acc7836640f0d78ee53cf625'],
  ['node_modules/openai/version.js', 'e2a5988bb70e4044332c11a01286ee2d102164a57cd767d2ab1f8ed0491b0368'],
  ['node_modules/openai/index.js', '7b9f1c56213e093265cb0831dfe39b7ff847215576c8b55b969b7c6360a77133'],
  ['node_modules/openai/client.js', '3ec9c24d71bd083c45090e4e40e96ed552300c31f4abdac83e0deae7a711c562'],
  ['node_modules/openai/internal/detect-platform.js', 'daedb313fa18d38c8eb7db2fc8903dccbf69d5a8af5de205da0efa857f285106'],
  ['node_modules/openai/internal/request-options.js', 'd7fa9ca3f486330c9119fef7a79f09c5a5cdd3a5be2d2b4907d438774a144d1e'],
  ['node_modules/openai/resources/chat/completions/completions.js', 'e309080729c1c0a93aa1bfeb25f61f7c7f7fa8d8b821e34b7868abaf31e3cca7'],
  ['node_modules/jest/package.json', '90b2d495b4fdef80faefeeb26e275478bb3c1eeac15d587bbffb192ca3a4fa52'],
  ['node_modules/jest/bin/jest.js', '2a9b435eab8a343bd09fe285b2e2043ff9ff89fae4e1d1f46ba3df28659d8a2c'],
  ['node_modules/next/package.json', '73192ad53e2c6f25f5f81177819607dff0b254548932a0a225aad09307fd6772'],
  ['node_modules/next/dist/build/swc/jest-transformer.js', '5d291c5cbae7cfbf62ca59701a86c8cf46a49a84be0ec04dd8d57b3d7d13dc72'],
  ['node_modules/next/dist/build/swc/options.js', '57c27c44a6f9e79fa3eb04b03791eb8aac23c29e454d451dae2f937aba0f308e'],
  ['node_modules/next/dist/build/swc/index.js', 'e80c2d8841180a8797b25181ed89072f3264e7ef1169db1a46446586e27be822'],
  ['node_modules/@next/swc-win32-x64-msvc/package.json', 'a845560f1dd48df707d2e8919c906b75b103a8fa4fc51f7dde0809db98fd7916'],
  ['node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node', '802caaf2f698005ad3d9fdb29ea1d4aa0da4e76c47e6a9f75151fe73b5f3e4e1'],
  ['node_modules/undici/package.json', 'd2fb5736b5adad6a74c3fba9345d756258e1e953a3a2a13c03fca1bd6c9f6c52'],
  ['node_modules/uuid/package.json', 'c799ba49b586a7205ed6c0b6c1b06052118f6d0ed98cdad46af3f682658d5758'],
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = st => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'mode', 'nlink', 'uid', 'gid'].map(k => [k, String(st[k])]));

function readPinned(file, expectedSha256) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 128n * 1024n * 1024n) throw new Error('FIXTURE_INPUT_NOT_BOUNDED_REGULAR_FILE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    if (!same(identity(before), identity(fs.fstatSync(fd, { bigint: true })))) throw new Error('FIXTURE_INPUT_CHANGED_BEFORE_READ');
    bytes = fs.readFileSync(fd);
    if (!same(identity(before), identity(fs.fstatSync(fd, { bigint: true })))) throw new Error('FIXTURE_INPUT_CHANGED_DURING_READ');
  } finally { fs.closeSync(fd); }
  const after = fs.lstatSync(file, { bigint: true });
  if (!same(identity(before), identity(after)) || BigInt(bytes.length) !== before.size) throw new Error('FIXTURE_INPUT_CHANGED_AFTER_READ');
  const sha256 = hash(bytes);
  if (expectedSha256 && sha256 !== expectedSha256) throw new Error(`FIXTURE_SOURCE_PIN_MISMATCH:${path.basename(file)}`);
  return { path: file, bytes: bytes.length, sha256, generation: identity(after) };
}

async function main() {
  if (process.argv.length !== 2 || process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.19.0' ||
      path.resolve(process.execPath).toLowerCase() !== path.resolve(NODE).toLowerCase()) throw new Error('FIXTURE_PINNED_INVOCATION_REQUIRED');
  // Read and hash only: no application, SDK, adapter, configuration or SQL module
  // is evaluated during source pin inspection.
  const fixed = [
    readPinned(NODE, '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'),
    readPinned(PRIVATE_FILES, '7ae5ba87ec1cd387ee1b914105894d29254e07c0a3644c86f65810f461dcd54d'),
    ...SELECTED_PINS.map(([file, expected]) => readPinned(path.join(FLUJO, file), expected)),
    ...RECEIVER_SOURCE_PINS.map(([file, expected]) => readPinned(file, expected)),
  ];
  const local = ['scripts/flujo-owner-wire-fixture.mjs', 'scripts/fixtures/flujo-owner-wire.jest.cjs',
    'scripts/fixtures/flujo-owner-wire.fixture.ts', 'test/fixtures/owner-wire-input.mjs',
    'src/fixture-owner-wire.mjs'].map(file => readPinned(path.join(FACTORY, file)));
  const allBefore = [...fixed, ...local];
  const privateFiles = await import(pathToFileURL(PRIVATE_FILES).href);
  const receipt = path.join(FACTORY, '.factory', `flujo-owner-wire-sdk-run-${randomUUID()}`);
  await privateFiles.ensurePrivateDirectory(receipt);
  const dirs = Object.fromEntries(['raw', 'records', 'cases', 'cache', 'working', 'temp'].map(name => [name, path.join(receipt, name)]));
  for (const dir of Object.values(dirs)) await privateFiles.ensurePrivateDirectory(dir);
  // Keep raw/case leaves separate from JSON records. Re-protecting the records
  // parent cannot change the recorded inherited raw-leaf ctime on Windows.
  await privateFiles.writePrivateJson(path.join(dirs.records, 'preflight.json'), {
    format: 'factory-flujo-sdk-offline-preflight-v1', createdAt: new Date().toISOString(),
    scope: 'selected-source-and-runtime-pins', selectedFlujoPins: SELECTED_PINS.length,
    receiverSourceOnlyPins: RECEIVER_SOURCE_PINS.length, originalReads: 0, providerActions: 0,
    sources: allBefore,
  });
  const argv = [path.join(FLUJO, 'node_modules/jest/bin/jest.js'), '--config',
    path.join(FACTORY, 'scripts/fixtures/flujo-owner-wire.jest.cjs'), '--runInBand', '--no-cache',
    '--cacheDirectory', dirs.cache, '--runTestsByPath', path.join(FACTORY, 'scripts/fixtures/flujo-owner-wire.fixture.ts'),
    '--json', '--outputFile', path.join(dirs.cases, 'jest-result.json')];
  const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
    PATH: `${path.dirname(NODE)};C:\\Windows\\System32`, TEMP: dirs.temp, TMP: dirs.temp,
    NODE_ENV: 'test', CI: '1', NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
    FACTORY_OWNER_WIRE_REPORT_DIRECTORY: dirs.cases };
  const outputLimit = 1024 * 1024;
  const stdout = fs.openSync(path.join(dirs.raw, 'stdout.bin'), 'wx');
  const stderr = fs.openSync(path.join(dirs.raw, 'stderr.bin'), 'wx');
  const startedAt = new Date().toISOString();
  let child; let stopReason = null; let spawnError = null;
  const byteCounts = { stdout: 0, stderr: 0 };
  const result = await new Promise(resolve => {
    child = spawn(NODE, argv, { cwd: dirs.working, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = reason => { stopReason ??= reason; child.kill(); };
    const onInterrupt = () => stop('FIXTURE_PARENT_INTERRUPTED');
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
    const deadline = setTimeout(() => stop('FIXTURE_DEADLINE'), 60000);
    const record = (name, fd) => chunk => {
      byteCounts[name] += chunk.length;
      if (byteCounts[name] > outputLimit) return stop('FIXTURE_OUTPUT_LIMIT');
      try { fs.writeSync(fd, chunk); }
      catch { stop('FIXTURE_OUTPUT_WRITE_FAILURE'); }
    };
    child.stdout.on('data', record('stdout', stdout)); child.stderr.on('data', record('stderr', stderr));
    child.on('error', error => { spawnError = { code: error.code ?? null, message: String(error.message).slice(0, 500) }; });
    child.on('close', (code, signal) => {
      clearTimeout(deadline); process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
      resolve({ code, signal, directChildClosed: true });
    });
  });
  fs.closeSync(stdout); fs.closeSync(stderr);
  const sourceInspectionErrors = [];
  const allAfter = allBefore.map(pin => {
    try { return readPinned(pin.path); }
    catch (error) { sourceInspectionErrors.push({ path: pin.path, error: String(error.message).slice(0, 500) }); return null; }
  });
  const stable = allBefore.every((pin, i) => same(pin, allAfter[i]));
  const artifactInspectionErrors = [];
  const inspectArtifact = location => {
    try { return [readPinned(location)]; }
    catch (error) { artifactInspectionErrors.push({ path: location, error: String(error.message).slice(0, 500) }); return []; }
  };
  const raw = ['stdout.bin', 'stderr.bin'].flatMap(file => inspectArtifact(path.join(dirs.raw, file)));
  const casePins = ['precommitted-wire.json', 'case-report.json', 'jest-result.json', 'fixture-owner.sqlite'].flatMap(file => {
    const location = path.join(dirs.cases, file); return fs.existsSync(location) ? inspectArtifact(location) : [];
  });
  const parseCaseArtifact = file => {
    const pin = casePins.find(item => path.basename(item.path) === file);
    if (!pin) return null;
    try {
      if (pin.bytes > 1024 * 1024 || !same(pin, readPinned(pin.path))) throw new Error('FIXTURE_CASE_JSON_NOT_STABLE_BOUNDED');
      const bytes = fs.readFileSync(pin.path);
      if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256 || !same(pin, readPinned(pin.path))) throw new Error('FIXTURE_CASE_JSON_CHANGED');
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) { artifactInspectionErrors.push({ path: pin.path, error: String(error.message).slice(0, 500) }); return null; }
  };
  const caseReport = parseCaseArtifact('case-report.json');
  const jestReport = parseCaseArtifact('jest-result.json');
  const accepted = result.code === 0 && !result.signal && !spawnError && !stopReason && stable && artifactInspectionErrors.length === 0 &&
    caseReport?.accepted === true && jestReport?.success === true && jestReport.numTotalTests === 1 &&
    jestReport.numPassedTests === 1 && jestReport.numFailedTests === 0;
  const summary = { format: 'factory-flujo-sdk-offline-run-v1', receipt, startedAt, endedAt: new Date().toISOString(),
    accepted, scope: 'real-adapter-and-sdk-final-fetch-only', argv, environmentKeys: Object.keys(env).sort(),
    pid: child.pid ?? null, result, spawnError, stopReason, byteCounts, selectedSourcesStable: stable, sourceInspectionErrors,
    sourcesBefore: allBefore, sourcesAfter: allAfter, raw, casePins, artifactInspectionErrors,
    jestCounts: jestReport ? { total: jestReport.numTotalTests, passed: jestReport.numPassedTests, failed: jestReport.numFailedTests } : null,
    physicalSend: accepted ? 'PHYSICAL_SEND_HOLD' : 'UNVERIFIED_FAILED_FIXTURE', originalJournalAuthority: 'HOLD', receiverCompatibility: 'PINNED_FACTORY_INGRESS_HOLD_STREAM_OPTIONS',
    receiverSourceOnlyPins: RECEIVER_SOURCE_PINS, credentialAccess: 'NO_REAL_CREDENTIAL_CONFIGURED; resolver not present in fixture owner',
    flowGraphExecution: 'NOT_EXERCISED', productionAuthority: 'HOLD', globalDescendantQuiescence: 'UNVERIFIED' };
  await privateFiles.writePrivateJson(path.join(dirs.records, 'run.json'), summary);
  process.stdout.write(JSON.stringify({ accepted, receipt, counts: summary.jestCounts, result,
    selectedSourcesStable: stable, physicalSend: summary.physicalSend, receiverCompatibility: summary.receiverCompatibility }) + '\n');
  process.exitCode = accepted ? 0 : 1;
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ accepted: false, error: String(error.message).slice(0, 500) }) + '\n');
  process.exitCode = 1;
});

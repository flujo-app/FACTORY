import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run in an independently extracted, clean source snapshot on Windows or Linux.
const source = dirname(dirname(fileURLToPath(import.meta.url))); const npm = process.argv[2]; const resultFile = process.argv[3];
if (!npm || !resultFile) throw new Error('Select the exact runtime npm CLI and evidence destination.');
const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
const commands = [];
const run = (command, args, cwd = source, extraEnv = {}) => {
  commands.push({ command, args, cwd }); console.log(JSON.stringify({ phase: 'start', command, args, node: process.version }));
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}/${result.signal}`);
};
const npmRun = args => run(process.execPath, [npm, ...args]);
try {
  npmRun(['ci']); npmRun(['audit', '--omit=dev', '--audit-level=high']);
  const workflow = readFileSync(join(source, '.github/workflows/public-sdk.yml'), 'utf8');
  const tests = workflow.split('\n').find(line => line.includes('- run: node --test ')).split('node --test ')[1].trim().split(/\s+/);
  run(process.execPath, ['--test', ...tests]);
  const output = join(source, '.ci-consumer'); mkdirSync(output, { recursive: true });
  npmRun(['pack', '--pack-destination', output]);
  const version = JSON.parse(readFileSync(join(source, 'package.json'))).version; const tarball = join(output, `flujo-factory-${version}.tgz`);
  npmRun(['install', '--prefix', join(output, 'installed'), tarball, '--ignore-scripts', '--no-audit', '--no-fund']);
  const consumer = join(output, 'installed');
  run(process.execPath, ['scripts/verify-public-sdk.mjs'], source, { FACTORY_CONSUMER: consumer });
  run(process.execPath, [join(consumer, 'node_modules/flujo-factory/bin/factory-public.mjs'), '--help']);
  run(process.execPath, [join(consumer, 'node_modules/flujo-factory/bin/factory-lite.mjs'), '--help']);
  run(process.execPath, ['--test', '--test-name-pattern=public MCP stdio', 'test/public-sdk.test.mjs'], source,
    { FACTORY_TEST_MCP: join(consumer, 'node_modules/flujo-factory/bin/factory-mcp.mjs') });
  writeFileSync(resultFile, JSON.stringify({ passed: true, node: process.version, platform: process.platform, commands, sourceSnapshot: process.env.FACTORY_SOURCE_SNAPSHOT }, null, 2));
  console.log('CI_SUCCESS');
} catch (error) {
  writeFileSync(resultFile, JSON.stringify({ passed: false, node: process.version, platform: process.platform, commands, error: error.message }, null, 2));
  throw error;
}

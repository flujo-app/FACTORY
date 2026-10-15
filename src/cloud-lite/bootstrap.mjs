/** Bootstrap on the pinned upstream Node image when a custom registry is unavailable. */
export function cloudLiteBootstrap(bundleSha256) {
  if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw new TypeError('Bind the exact SDK bundle SHA256.');
  return `#!/bin/bash
set -euo pipefail
mkdir -p /data/factory /data/codex /opt/factory
exec > >(tee -a /data/factory/bootstrap.log) 2>&1
echo '${bundleSha256}  /tmp/factory-sdk.tgz' | sha256sum -c -
apt-get update
apt-get install -y --no-install-recommends git gh ca-certificates curl procps python3 make g++ xz-utils bubblewrap
curl -fsSL https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-x86_64-unknown-linux-musl.tar.gz -o /tmp/codex.tar.gz
echo '86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057  /tmp/codex.tar.gz' | sha256sum -c -
tar -xzf /tmp/codex.tar.gz -C /usr/local/bin
mv /usr/local/bin/codex-x86_64-unknown-linux-musl /usr/local/bin/codex
curl -fsSL https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz -o /tmp/code-mode.tar.gz
echo '458239ea45c1fc508d89695f180ab352f2834709a8a46929a4466f4f04399ada  /tmp/code-mode.tar.gz' | sha256sum -c -
tar -xzf /tmp/code-mode.tar.gz -C /usr/local/bin
mv /usr/local/bin/codex-code-mode-host-x86_64-unknown-linux-musl /usr/local/bin/codex-code-mode-host
tar -xzf /tmp/factory-sdk.tgz --strip-components=1 -C /opt/factory
cd /opt/factory
npm install --omit=dev --ignore-scripts --no-audit --no-fund
npm install --prefix /opt/flujo-bash --no-audit --no-fund @mario.andreschak/mcp-bash@3.46.2
export HOME=/data CODEX_HOME=/data/codex
node --input-type=module - <<'FACTORY_PIN_SOURCE'
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const config = JSON.parse(Buffer.from(process.env.FACTORY_CLOUD_BOOTSTRAP_B64, 'base64').toString());
if (config.plan.repositoryRevision) {
  if (!/^[a-f0-9]{40}$/.test(config.plan.repositoryRevision)) throw new Error('Invalid source revision.');
  const cwd = '/data/repository', env = { ...process.env, GH_TOKEN: config.githubToken, GIT_TERMINAL_PROMPT: '0' };
  const run = (command,args,options={}) => execFileSync(command,args,{env,stdio:['ignore','pipe','pipe'],...options});
  run('gh',['auth','setup-git']);
  if (!existsSync(cwd + '/.git')) {
    run('git',['clone','https://github.com/' + config.plan.repository + '.git',cwd]);
    run('git',['fetch','origin',config.plan.repositoryRevision],{cwd});
    run('git',['checkout','--detach',config.plan.repositoryRevision],{cwd});
  }
  if (run('git',['rev-parse','HEAD'],{cwd}).toString().trim() !== config.plan.repositoryRevision) throw new Error('Retained repository differs from the frozen comparison source.');
}
FACTORY_PIN_SOURCE
exec node bin/factory-cloud-runtime.mjs
`;
}

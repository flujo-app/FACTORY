/** Bootstrap on the pinned upstream Node image when a custom registry is unavailable. */
const CLAUDE_CODE_VERSION = '2.1.311';
const CLAUDE_CODE_LINUX_X64_SHA256 = '86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada';
const FLUJO_VERSION = '3.48.3';
const FLUJO_SHA256 = '09e954ec5b15e30748c28576b2c0bbe3d4f5cdc34afbbbc139d92759474b6b98';
const programInstall = {
  codex: {
    folder: '/data/codex', packages: '', home: 'CODEX_HOME=/data/codex',
    install: `curl -fsSL https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-x86_64-unknown-linux-musl.tar.gz -o /tmp/codex.tar.gz
echo '86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057  /tmp/codex.tar.gz' | sha256sum -c -
tar -xzf /tmp/codex.tar.gz -C /usr/local/bin
mv /usr/local/bin/codex-x86_64-unknown-linux-musl /usr/local/bin/codex
curl -fsSL https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz -o /tmp/code-mode.tar.gz
echo '458239ea45c1fc508d89695f180ab352f2834709a8a46929a4466f4f04399ada  /tmp/code-mode.tar.gz' | sha256sum -c -
tar -xzf /tmp/code-mode.tar.gz -C /usr/local/bin
mv /usr/local/bin/codex-code-mode-host-x86_64-unknown-linux-musl /usr/local/bin/codex-code-mode-host`,
  },
  // socat carries Claude Code's sandbox network proxy.
  claude: {
    folder: '/data/claude', packages: ' socat', home: 'CLAUDE_CONFIG_DIR=/data/claude',
    install: `curl -fsSL https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/linux-x64/claude -o /tmp/claude
echo '${CLAUDE_CODE_LINUX_X64_SHA256}  /tmp/claude' | sha256sum -c -
install -m 755 /tmp/claude /usr/local/bin/claude
rm -f /tmp/claude`,
  },
  // Kept on the volume, so a restarted Machine does not install it again. An image that already has
  // `flujo` on its path skips this. Install scripts stay off: they only download a browser workers leave off.
  flujo: {
    folder: '/data/flujo /data/factory-private /data/results', packages: ' ripgrep python3-venv python3-pip', home: 'FLUJO_DATA_DIR=/data/flujo',
    install: `if ! command -v flujo >/dev/null 2>&1; then
if [ ! -f /data/flujo-program/.installed-${FLUJO_VERSION} ]; then
rm -rf /data/flujo-program
curl -fsSL https://registry.npmjs.org/flujo-ai/-/flujo-ai-${FLUJO_VERSION}.tgz -o /tmp/flujo.tgz
echo '${FLUJO_SHA256}  /tmp/flujo.tgz' | sha256sum -c -
npm install --prefix /data/flujo-program /tmp/flujo.tgz --ignore-scripts --omit=dev --no-audit --no-fund
rm -f /tmp/flujo.tgz
touch /data/flujo-program/.installed-${FLUJO_VERSION}
fi
ln -sf /data/flujo-program/node_modules/.bin/flujo /usr/local/bin/flujo
fi`,
  },
};

export function cloudLiteBootstrap(bundleSha256, { workerProgram = 'codex' } = {}) {
  if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw new TypeError('Bind the exact SDK bundle SHA256.');
  const program = programInstall[workerProgram];
  if (!program) throw new TypeError('Unknown worker program.');
  return `#!/bin/bash
set -euo pipefail
mkdir -p /data/factory ${program.folder} /opt/factory
exec > >(tee -a /data/factory/bootstrap.log) 2>&1
echo '${bundleSha256}  /tmp/factory-sdk.tgz' | sha256sum -c -
apt-get update
apt-get install -y --no-install-recommends git gh openssh-client ca-certificates curl procps python3 make g++ xz-utils bubblewrap${program.packages}
${program.install}
tar -xzf /tmp/factory-sdk.tgz --strip-components=1 -C /opt/factory
cd /opt/factory
npm install --omit=dev --ignore-scripts --no-audit --no-fund
npm install --prefix /opt/flujo-bash --no-audit --no-fund @mario.andreschak/mcp-bash@3.46.2
export HOME=/data ${program.home}
node --input-type=module - <<'FACTORY_PIN_SOURCE'
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const config = JSON.parse(Buffer.from(process.env.FACTORY_CLOUD_BOOTSTRAP_B64, 'base64').toString());
// Deploy-key fleets clone and pin inside the runtime over SSH.
if (config.plan.repositoryRevision && !config.deployKey) {
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

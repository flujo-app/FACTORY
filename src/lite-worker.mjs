import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const mcp = fileURLToPath(new URL('../bin/factory-mcp.mjs', import.meta.url));

/** Start a normal provider CLI with its native tools and only FACTORY's MCP server. */
export function liteWorkerCommand({ provider, database, prompt, cwd = process.cwd() } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new TypeError('provider must be codex or claude');
  if (typeof database !== 'string' || !database.trim()) throw new TypeError('database path is required');
  if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim())) throw new TypeError('prompt must be nonempty');
  const db = resolve(database);
  const server = { command: process.execPath, args: [mcp, db] };
  if (provider === 'claude') return {
    command: 'claude', cwd, args: ['--dangerously-skip-permissions', '--strict-mcp-config',
      '--mcp-config', JSON.stringify({ mcpServers: { factory: server } }), ...(prompt === undefined ? [] : [prompt])],
  };
  const toml = value => JSON.stringify(value);
  const config = `mcp_servers={factory={command=${toml(server.command)},args=[${server.args.map(toml).join(',')}]}}`;
  return { command: 'codex', cwd, env: { ...process.env, CODEX_HOME: resolve(homedir(), '.factory', 'lite-codex') },
    args: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never',
    '--config', config, ...(prompt === undefined ? [] : [prompt])] };
}

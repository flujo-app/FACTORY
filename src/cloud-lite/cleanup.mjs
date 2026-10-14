import { realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Route task cleanup through upstream FLUJO Bash MCP, with this agent's root. */
export async function cleanupCloudLitePaths(paths, { root = process.env.FACTORY_WORKTREE,
  modulePath = process.env.FACTORY_CLEANUP_MCP_PATH ?? '/opt/flujo-bash/node_modules/@mario.andreschak/mcp-bash/dist/index.js' } = {}) {
  if (!isAbsolute(root ?? '') || !Array.isArray(paths) || !paths.length) throw new TypeError('Select paths inside the current agent worktree.');
  const canonicalRoot = await realpath(root); const selected = [];
  for (const input of paths) {
    if (typeof input !== 'string' || input.includes('\0')) throw new TypeError('Invalid cleanup path.');
    const path = resolve(root, input); const rel = relative(canonicalRoot, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Cleanup cannot leave the assigned worktree or delete its root.');
    let actual; try { actual = await realpath(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const actualRel = relative(canonicalRoot, actual);
    if (!actualRel || actualRel === '..' || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) throw new Error('Cleanup target resolves outside the assigned worktree.');
    selected.push(path);
  }
  if (!selected.length) return { removed: [], transport: 'flujo-bash-mcp' };
  const client = new Client({ name: 'factory-cloud-cleanup', version: '1' }, { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(canonicalRoot).href, name: 'agent-worktree' }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [modulePath],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, FLUJO_BASH_ROOTS: canonicalRoot } });
  try {
    await client.connect(transport); await client.callTool({ name: 'shell_info', arguments: {} });
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `rm -rf -- ${selected.map(quote).join(' ')}`;
    const receipt = await client.callTool({ name: 'run', arguments: { command, cwd: canonicalRoot, shell: 'bash', timeout: 120, maxOutputChars: 2000 } }, undefined, { timeout: 130000 });
    if (receipt.isError) throw new Error('FLUJO Bash MCP did not confirm cleanup.');
    for (const path of selected) {
      try { await lstat(path); throw new Error('Cleanup target still exists.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { removed: selected, transport: 'flujo-bash-mcp' };
  } finally { await client.close(); }
}

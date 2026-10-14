import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { cloudBoardTools } from './board.mjs';
import { cleanupCloudLitePaths } from './cleanup.mjs';

export async function startCloudBoardMcp({ url = process.env.FACTORY_BOARD_URL, token = process.env.FACTORY_BOARD_TOKEN } = {}) {
  const server = new Server({ name: 'factory-board', version: '0.3.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: cloudBoardTools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name === 'factory_cleanup') {
        const result = await cleanupCloudLitePaths(request.params.arguments?.paths);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      const response = await fetch(`${url}/tool`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments }), redirect: 'error', signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      return { isError: !response.ok, content: [{ type: 'text', text: JSON.stringify(result) }], ...(response.ok ? { structuredContent: result } : {}) };
    } catch { return { isError: true, content: [{ type: 'text', text: 'Board delivery is unconfirmed; retain the same message/resource identity when retrying.' }] }; }
  });
  await server.connect(new StdioServerTransport());
  return server;
}

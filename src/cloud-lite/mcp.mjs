import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { cloudBoardTools } from './board.mjs';
import { cleanupCloudLitePaths } from './cleanup.mjs';
import { candidateTool, submitWorkspaceCandidate } from '../workflows/candidate.mjs';
import { createWorkflowClient } from '../workflows/client.mjs';
import { resolve } from 'node:path';
import { redact } from './protocol.mjs';

export async function startCloudBoardMcp({ url = process.env.FACTORY_BOARD_URL, token = process.env.FACTORY_BOARD_TOKEN } = {}) {
  const server = new Server({ name: 'factory-board', version: '0.3.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...cloudBoardTools,candidateTool] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if(request.params.name===candidateTool.name){
        const client=createWorkflowClient({url,token}),identity=await client.call('factory_identity',{});
        const result=await submitWorkspaceCandidate({...request.params.arguments,client,cwd:process.env.FACTORY_WORKTREE,directory:resolve('/data/factory/candidates',identity.id)});
        return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
      }
      if (request.params.name === 'factory_cleanup') {
        const result = await cleanupCloudLitePaths(request.params.arguments?.paths);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      const response = await fetch(`${url}/tool`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments }), redirect: 'error', signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      return { isError: !response.ok, content: [{ type: 'text', text: JSON.stringify(result) }], ...(response.ok ? { structuredContent: result } : {}) };
    } catch(error) { return { isError: true, content: [{ type: 'text', text: error.code==='OUTCOME_UNKNOWN' || error.message==='fetch failed' || error.name==='TimeoutError'
      ? 'Board delivery is unconfirmed; retain the same message/resource identity when retrying.' : redact(error.message,[token]) }] }; }
  });
  await server.connect(new StdioServerTransport());
  return server;
}

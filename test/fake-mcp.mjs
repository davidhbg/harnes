// Kleiner MCP-Server für Tests: ein Werkzeug „wetter“, das eine feste Antwort gibt.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'testserver', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'wetter', description: 'Wetter für eine Stadt', inputSchema: { type: 'object', properties: { stadt: { type: 'string' } }, required: ['stadt'] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `Sonnig in ${req.params.arguments?.stadt ?? '?'}` }],
}));
await server.connect(new StdioServerTransport());

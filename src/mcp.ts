#!/usr/bin/env node
/**
 * Harnes-MCP-Server: kleine Brücke zwischen einer KI-Sitzung (Claude Code, Codex, …)
 * und der Harnes-Zentrale. Die Sitzung startet dieses Programm über stdio;
 * es reicht die Team-Werkzeuge an die Zentrale weiter.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const url = process.env.REMOTEHARNES_URL ?? '';
const token = process.env.REMOTEHARNES_TOKEN ?? '';

interface RemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  if (!url || !token) throw new Error('REMOTEHARNES_URL oder REMOTEHARNES_TOKEN fehlt');
  const res = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Zentrale antwortet mit Status ${res.status}`);
  return (await res.json()) as T;
}

const server = new Server({ name: 'remoteharnes', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await api<{ tools: RemoteTool[] }>('/tools');
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object'; properties?: Record<string, object> },
      annotations: { readOnlyHint: Boolean(t.readOnly), destructiveHint: false, openWorldHint: false },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const r = await api<{ text: string; isError: boolean }>('/tool', {
      name: req.params.name,
      args: req.params.arguments ?? {},
    });
    return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text' as const, text: `Harnes ist nicht erreichbar: ${msg}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());

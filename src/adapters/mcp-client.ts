import { cleanEnv } from './common.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '../config.js';
import type { ToolDef } from '../types.js';
import { errText } from '../util.js';

/**
 * MCP für Modelle ohne eigenen MCP-Anschluss (Ollama, LM Studio, DeepSeek, OpenRouter):
 * RemoteHarnes startet die eingerichteten MCP-Server selbst und reicht ihre Werkzeuge als
 * Funktionen an das Modell weiter. Name im Modell: mcp__<server>__<werkzeug>.
 */
export class McpTools {
  private clients = new Map<string, Client>();
  /** Funktionsname -> Server und Werkzeug */
  private routes = new Map<string, { server: string; tool: string }>();
  readonly defs: ToolDef[] = [];
  /** Server, die nicht starten wollten: Name -> Grund */
  readonly failed = new Map<string, string>();

  async connect(servers: Record<string, McpServer>, cwd: string): Promise<void> {
    await Promise.all(
      Object.entries(servers).map(async ([server, m]) => {
        try {
          const transport = new StdioClientTransport({
            command: m.befehl,
            args: m.args ?? [],
            env: { ...cleanEnv(), ...(m.env ?? {}) },
            cwd,
            stderr: 'ignore',
          });
          const client = new Client({ name: 'remoteharnes', version: '0.1.0' });
          await withTimeout(client.connect(transport), 30_000, 'startet nicht');
          const { tools } = await withTimeout(client.listTools(), 15_000, 'meldet keine Werkzeuge');
          this.clients.set(server, client);
          for (const t of tools) {
            const name = `mcp__${server}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
            this.routes.set(name, { server, tool: t.name });
            const schema = (t.inputSchema ?? { type: 'object', properties: {} }) as ToolDef['inputSchema'];
            this.defs.push({ name, description: `[MCP ${server}] ${t.description ?? t.name}`.slice(0, 1000), inputSchema: { ...schema, type: 'object', properties: schema.properties ?? {} } });
          }
        } catch (e) {
          this.failed.set(server, errText(e));
        }
      }),
    );
  }

  has(name: string): boolean {
    return this.routes.has(name);
  }

  serverOf(name: string): string {
    return this.routes.get(name)?.server ?? '';
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const route = this.routes.get(name);
    const client = route && this.clients.get(route.server);
    if (!route || !client) throw new Error(`Werkzeug ${name} gibt es nicht.`);
    const res = await client.callTool({ name: route.tool, arguments: args });
    const content = (res.content ?? []) as { type: string; text?: string; resource?: { text?: string } }[];
    const text = content
      .map((c) => (c.type === 'text' ? (c.text ?? '') : c.type === 'resource' ? (c.resource?.text ?? '') : `[${c.type}]`))
      .join('\n')
      .slice(0, 30_000);
    return res.isError ? `Fehler: ${text}` : text || '(keine Ausgabe)';
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`MCP-Server ${what} (nach ${ms / 1000} s)`)), ms).unref())]);
}

import type { Adapter, AdapterContext, AgentSpec } from './adapter.js';

/** Lädt die passende Anbindung erst, wenn sie gebraucht wird (schneller Start). */
export async function createAdapter(spec: AgentSpec, ctx: AdapterContext): Promise<Adapter> {
  switch (spec.kind) {
    case 'echo':
      return new (await import('./echo.js')).EchoAdapter(ctx);
    case 'claude-api':
      return new (await import('./claude-api.js')).ClaudeApiAdapter(ctx);
    case 'claude-abo':
      return new (await import('./claude-abo.js')).ClaudeAboAdapter(ctx);
    case 'codex':
      return new (await import('./codex.js')).CodexAdapter(ctx);
    case 'openai':
      return new (await import('./openai.js')).OpenAiAdapter(ctx);
  }
}

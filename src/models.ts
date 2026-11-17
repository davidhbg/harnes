import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cleanEnv } from './adapters/common.js';
import { codexProgram } from './auth.js';
import { getKey, type Config } from './config.js';
import type { AgentSpec } from './adapters/adapter.js';

/**
 * Welche Modelle eine Sitzung nehmen kann – direkt beim Anbieter abgefragt, damit die Liste
 * nicht veraltet (DeepSeek, OpenRouter, Ollama … über /models, Codex über seinen app-server).
 * Claude Code im Abo bietet keine Abfrage, dort steht eine feste Liste.
 */
export interface ModelChoice {
  id: string;
  hint?: string;
}

export const CLAUDE_MODELS: ModelChoice[] = [
  { id: 'claude-opus-5-5', hint: 'Opus 5.5 · am stärksten' },
  { id: 'claude-sonnet-5-5', hint: 'Sonnet 5.5 · ausgewogen' },
  { id: 'claude-haiku-5-5', hint: 'Haiku 5.5 · schnell, günstig' },
  { id: 'claude-fable-5-2', hint: 'Fable 5.2' },
];

const cache = new Map<string, { at: number; list: ModelChoice[] }>();
const TTL = 10 * 60_000;

/** Schlüssel für den Zwischenspeicher: Art und Anbieter */
function cacheKey(spec: Pick<AgentSpec, 'kind' | 'provider'>): string {
  return `${spec.kind}:${spec.provider ?? ''}`;
}

/** Schon bekannte Liste (ohne Abfrage), sonst undefined. */
export function cachedModels(spec: Pick<AgentSpec, 'kind' | 'provider'>): ModelChoice[] | undefined {
  if (spec.kind === 'claude-abo') return CLAUDE_MODELS;
  const hit = cache.get(cacheKey(spec));
  return hit && Date.now() - hit.at < TTL ? hit.list : undefined;
}

export async function listModels(config: Config, spec: Pick<AgentSpec, 'kind' | 'provider'>): Promise<ModelChoice[]> {
  const known = cachedModels(spec);
  if (known) return known;
  let list: ModelChoice[];
  if (spec.kind === 'claude-api') list = await anthropicModels(config);
  else if (spec.kind === 'codex') list = await codexModels(config);
  else if (spec.kind === 'openai') list = await openaiModels(config, spec.provider ?? '');
  else list = [];
  cache.set(cacheKey(spec), { at: Date.now(), list });
  return list;
}

async function anthropicModels(config: Config): Promise<ModelChoice[]> {
  const key = getKey(config.claudeApi.apiKeyEnv);
  if (!key) return CLAUDE_MODELS;
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=50', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return CLAUDE_MODELS;
    const data = (await res.json()) as { data?: { id?: string; display_name?: string }[] };
    const list = (data.data ?? []).filter((m) => m.id).map((m) => ({ id: m.id!, hint: m.display_name }));
    return list.length ? list : CLAUDE_MODELS;
  } catch {
    return CLAUDE_MODELS;
  }
}

/** OpenAI-kompatible Anbieter: GET <baseUrl>/models */
async function openaiModels(config: Config, provider: string): Promise<ModelChoice[]> {
  const p = config.anbieter[provider];
  if (!p) throw new Error(`Anbieter ${provider} ist nicht eingerichtet.`);
  const key = p.apiKeyEnv ? getKey(p.apiKeyEnv) : undefined;
  if (p.apiKeyEnv && !key) throw new Error(`Für ${provider} ist kein Schlüssel hinterlegt (Esc › API-Schlüssel).`);
  let res: Response;
  try {
    res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`${provider} ist unter ${p.baseUrl} nicht erreichbar.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`Der Schlüssel für ${provider} wird abgelehnt.`);
  if (!res.ok) throw new Error(`${provider} liefert keine Modellliste (Status ${res.status}).`);
  const data = (await res.json()) as { data?: { id?: string; name?: string }[]; models?: { name?: string }[] };
  const ids = (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
  // Ollama ohne /v1 liefert „models“ mit „name“
  for (const m of data.models ?? []) if (m.name) ids.push(m.name);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).map((id) => ({ id }));
}

/** Codex: Modellliste über „codex app-server“ (model/list), mit Anzeigename und Beschreibung */
function codexModels(config: Config): Promise<ModelChoice[]> {
  const p = codexProgram(config);
  return new Promise((done, fail) => {
    const child = spawn(p.command, [...p.prefix, 'app-server'], { env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let finished = false;
    const finish = (err: Error | null, list?: ModelChoice[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* schon weg */
      }
      if (err) fail(err);
      else done(list ?? []);
    };
    const timer = setTimeout(() => finish(new Error('Codex antwortet nicht.')), 25_000);
    child.on('error', (e) => finish(e));
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n');
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: { id?: number; result?: { data?: { id?: string; model?: string; displayName?: string; description?: string; hidden?: boolean; isDefault?: boolean }[] }; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ method: 'model/list', id: 2, params: {} });
      } else if (msg.id === 2) {
        if (msg.error) return finish(new Error(`Codex: ${msg.error.message ?? 'Modellliste nicht lesbar'}`));
        const list = (msg.result?.data ?? [])
          .filter((m) => !m.hidden && (m.model || m.id))
          .map((m) => ({ id: (m.model || m.id)!, hint: [m.displayName, m.isDefault ? 'Standard' : ''].filter(Boolean).join(' · ') || m.description }));
        finish(null, list);
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'harnes', title: 'Harnes', version: '0.1' }, capabilities: null } });
  });
}

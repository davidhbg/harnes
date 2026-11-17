import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export interface ProviderConfig {
  /** OpenAI-kompatible Basis-URL, z. B. https://api.deepseek.com/v1 */
  baseUrl: string;
  /** Name der Umgebungsvariable mit dem Schlüssel (leer = kein Schlüssel nötig) */
  apiKeyEnv?: string;
  modell: string;
}

export interface McpServer {
  befehl: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Config {
  /** Einrichtung beim ersten Start abgeschlossen: danach geht es direkt in die Chats */
  eingerichtet?: boolean;
  /** Name des Menschen, der das Team führt */
  benutzer: string;
  /** Ordner, in dem pro Projekt ein Team-Vault (Obsidian) angelegt wird */
  vaultRoot: string;
  /** Nach so vielen Agent-zu-Agent-Nachrichten ohne Beitrag des Menschen pausiert der Austausch */
  kettenLimit: number;
  /** Grenze je Sitzung: Ist sie erreicht, bekommt die Sitzung keine Nachrichten mehr. 0 = keine Grenze. */
  budget: { tokensProSitzung: number; usdProSitzung: number };
  /** Signalton, wenn eine Sitzung dich braucht (Freigabe, Privatnachricht) */
  signalton: boolean;
  claudeApi: { modell: string; apiKeyEnv: string; budgetUsd: number };
  claudeAbo: { befehl: string; modell: string; extraArgs: string[] };
  codex: { befehl: string; modell: string; approvalPolicy: string; sandbox: string };
  anbieter: Record<string, ProviderConfig>;
  /** Zusätzliche MCP-Server, die jede neue Sitzung bekommt (Name -> Befehl) */
  mcp?: Record<string, McpServer>;
}

export function homeDir(): string {
  return process.env.REMOTEHARNES_HOME || join(homedir(), '.remoteharnes');
}

/** Vorschlag für den eigenen Namen: Systemkonto, erster Buchstabe groß (Tests: HARNES_BENUTZER) */
export function defaultUserName(): string {
  if (process.env.HARNES_BENUTZER) return process.env.HARNES_BENUTZER;
  let n = '';
  try {
    n = userInfo().username;
  } catch {
    n = process.env.USERNAME || process.env.USER || '';
  }
  n = n.replace(/[^\p{L}\p{N}_ -]/gu, '').trim();
  return n ? n[0]!.toUpperCase() + n.slice(1) : 'Ich';
}

export function defaultConfig(): Config {
  return {
    benutzer: defaultUserName(),
    vaultRoot: join(homeDir(), 'vault'),
    kettenLimit: 6,
    budget: { tokensProSitzung: 0, usdProSitzung: 0 },
    signalton: true,
    claudeApi: { modell: 'claude-opus-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY', budgetUsd: 5 },
    claudeAbo: { befehl: 'claude', modell: '', extraArgs: [] },
    codex: { befehl: '', modell: '', approvalPolicy: 'on-request', sandbox: 'workspace-write' },
    anbieter: {
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', modell: 'deepseek-chat' },
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', modell: 'deepseek/deepseek-chat' },
      ollama: { baseUrl: 'http://127.0.0.1:11434/v1', modell: 'gemma4' },
      lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', modell: '' },
    },
  };
}

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? merge(out[k], v) : v;
  }
  return out as T;
}

/** Einzelne Einstellung dauerhaft ändern (Datei lesen, Wert setzen, schreiben). */
export function updateConfig(change: (c: Config) => void): Config {
  const c = loadConfig();
  change(c);
  writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8');
  return c;
}

export function configPath(): string {
  return join(homeDir(), 'config.json');
}

export function loadConfig(): Config {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true });
  const file = configPath();
  const def = defaultConfig();
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(def, null, 2), 'utf8');
    return def;
  }
  try {
    return merge(def, JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return def;
  }
}

function keysPath(): string {
  return join(homeDir(), 'keys.json');
}

function readKeys(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Schlüssel kommen aus der Umgebungsvariable oder aus ~/.remoteharnes/keys.json
 * (Eintrag unter dem Namen der Umgebungsvariable). Nie aus Vault oder Repository.
 */
export function getKey(envName: string | undefined): string | undefined {
  if (!envName) return undefined;
  return process.env[envName] || readKeys()[envName] || undefined;
}

export function saveKey(envName: string, value: string): void {
  mkdirSync(homeDir(), { recursive: true });
  const keys = readKeys();
  keys[envName] = value;
  writeFileSync(keysPath(), JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Welcher Schlüsselname gehört zu welchem Kurznamen (für /schluessel). */
/**
 * MCP-Server, die nur für diesen Lauf gelten (z. B. der HarnesBrowser, wenn RemoteHarnes darin läuft).
 * Sie landen nie in der config.json.
 */
export const runtimeMcp: Record<string, McpServer> = {};

/** Alle MCP-Server für neue Sitzungen: eigene aus den Einstellungen plus die des Laufs */
export function allMcp(config: Config): Record<string, McpServer> {
  return { ...(config.mcp ?? {}), ...runtimeMcp };
}

export function keyEnvFor(config: Config, provider: string): string | undefined {
  if (provider === 'anthropic' || provider === 'claude' || provider === 'claude-api') return config.claudeApi.apiKeyEnv;
  return config.anbieter[provider]?.apiKeyEnv;
}

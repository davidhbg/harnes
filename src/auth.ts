import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { cleanEnv, findOnPath } from './adapters/common.js';
import { findCodex } from './adapters/codex.js';
import { getKey, type Config } from './config.js';
import { errText } from './util.js';

/**
 * Anmeldestatus der Dienste. Harnes liest dafür keine Anmeldedaten,
 * sondern fragt die offiziellen Programme selbst („claude auth status“,
 * Codex über seine app-server-Schnittstelle) bzw. prüft gespeicherte API-Schlüssel.
 */
export type AuthState = 'pruefe' | 'ok' | 'fehlt' | 'abgelaufen' | 'fehler';

export interface AuthInfo {
  state: AuthState;
  /** kurze Beschreibung für die Anzeige */
  text: string;
}

export interface Program {
  command: string;
  prefix: string[];
}

/** Startbefehl für Claude Code: Einstellung, sonst „claude“ aus dem PATH. */
export function claudeProgram(config: Config): Program {
  const configured = config.claudeAbo.befehl || 'claude';
  if (/\.(mjs|cjs|js)$/i.test(configured)) return { command: process.execPath, prefix: [configured] };
  const found = isAbsolute(configured)
    ? configured
    : findOnPath(process.platform === 'win32' ? [`${configured}.exe`, `${configured}.cmd`] : [configured]);
  if (!found) throw new Error('Claude Code wurde nicht gefunden. Installiere es oder trage den Pfad in der config.json unter claudeAbo.befehl ein.');
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(found)) return { command: 'cmd.exe', prefix: ['/c', found] };
  return { command: found, prefix: [] };
}

export function codexProgram(config: Config): Program {
  const configured = config.codex.befehl;
  if (/\.(mjs|cjs|js)$/i.test(configured)) return { command: process.execPath, prefix: [configured] };
  return findCodex(configured);
}

function run(p: Program, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    let out = '';
    const child = spawn(p.command, [...p.prefix, ...args], { env: cleanEnv(), windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: -1, out: errText(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

export async function claudeStatus(config: Config): Promise<AuthInfo> {
  let p: Program;
  try {
    p = claudeProgram(config);
  } catch (e) {
    return { state: 'fehler', text: errText(e) };
  }
  const r = await run(p, ['auth', 'status', '--json'], 20_000);
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)) as {
      loggedIn?: boolean;
      authMethod?: string;
      subscriptionType?: string;
      loginExpiresAt?: string | number | null;
    };
    if (!j.loggedIn) return { state: 'fehlt', text: 'nicht angemeldet' };
    const method = j.authMethod === 'claude.ai' || j.authMethod === 'oauth' ? 'Claude-Abo' : (j.authMethod ?? 'angemeldet');
    const sub = j.subscriptionType ? ` (${j.subscriptionType})` : '';
    return { state: 'ok', text: `angemeldet · ${method}${sub}` };
  } catch {
    return { state: 'fehler', text: r.out.trim().split('\n')[0]?.slice(0, 80) || 'Status nicht lesbar' };
  }
}

/**
 * Abmelden über das offizielle Programm („claude auth logout“ bzw. „codex logout“).
 * Das meldet das Programm auf dem ganzen Rechner ab – Harnes fasst die Anmeldedaten selbst nicht an.
 */
export async function logoutOf(config: Config, which: 'claude' | 'codex'): Promise<string> {
  const prog = which === 'claude' ? 'Claude Code' : 'Codex';
  const p = which === 'claude' ? claudeProgram(config) : codexProgram(config);
  const r = await run(p, which === 'claude' ? ['auth', 'logout'] : ['logout'], 20_000);
  if (r.code !== 0) {
    const why = r.out.trim().split('\n')[0]?.slice(0, 100) || `Fehlercode ${r.code}`;
    throw new Error(`${prog}: Abmelden hat nicht geklappt – ${why}`);
  }
  return `${prog} ist abgemeldet. Neu anmelden: Esc › Anbieter verbinden oder /einrichtung.`;
}

/**
 * Codex: „codex login status“ sieht nur, ob eine Anmeldung gespeichert ist. Ob sie noch gilt,
 * zeigt erst der app-server beim Auffrischen – deshalb wird dort nachgefragt.
 */
export async function codexStatus(config: Config): Promise<AuthInfo> {
  let p: Program;
  try {
    p = codexProgram(config);
  } catch (e) {
    return { state: 'fehler', text: errText(e) };
  }
  return new Promise((done) => {
    const child = spawn(p.command, [...p.prefix, 'app-server'], { env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let finished = false;
    let refreshFailed = false;
    const finish = (info: AuthInfo) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* schon weg */
      }
      done(info);
    };
    const timer = setTimeout(() => finish({ state: 'fehler', text: 'Codex antwortet nicht' }), 25_000);
    child.on('error', (e) => finish({ state: 'fehler', text: errText(e) }));
    child.stderr.on('data', (d: Buffer) => {
      if (/could not be refreshed|sign in again|refresh token/i.test(d.toString('utf8'))) refreshFailed = true;
    });
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n');
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ method: 'account/read', id: 2, params: { refreshToken: true } });
      } else if (msg.id === 2) {
        if (msg.error) return finish({ state: 'fehler', text: String(msg.error.message ?? 'Fehler').slice(0, 80) });
        const acc = msg.result?.account as { type?: string; planType?: string } | null | undefined;
        if (acc && !refreshFailed) {
          const what = acc.type === 'chatgpt' ? `ChatGPT${acc.planType ? ` ${acc.planType}` : ''}` : acc.type === 'apiKey' ? 'API-Schlüssel' : acc.type;
          return finish({ state: 'ok', text: `angemeldet · ${what}` });
        }
        if (acc && refreshFailed) return finish({ state: 'abgelaufen', text: 'Anmeldung abgelaufen' });
        return finish({ state: 'fehlt', text: 'nicht angemeldet' });
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'remoteharnes', title: 'Harnes', version: '0.1.0' }, capabilities: null } });
  });
}

/** API-Schlüssel prüfen: gespeichert? Und nimmt der Anbieter ihn an? */
export async function keyStatus(config: Config, provider: string, verify: boolean): Promise<AuthInfo> {
  const envName = provider === 'anthropic' ? config.claudeApi.apiKeyEnv : config.anbieter[provider]?.apiKeyEnv;
  const key = getKey(envName);
  if (!key) return { state: 'fehlt', text: 'kein Schlüssel' };
  if (!verify) return { state: 'ok', text: 'Schlüssel hinterlegt' };
  try {
    let res: Response;
    if (provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      const base = (config.anbieter[provider]?.baseUrl ?? '').replace(/\/+$/, '');
      const path = provider === 'openrouter' ? '/key' : '/models';
      res = await fetch(base + path, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    }
    if (res.ok) return { state: 'ok', text: 'Schlüssel gültig' };
    if (res.status === 401 || res.status === 403) return { state: 'abgelaufen', text: 'Schlüssel wird abgelehnt' };
    return { state: 'ok', text: `Schlüssel hinterlegt (Prüfung: Status ${res.status})` };
  } catch {
    return { state: 'ok', text: 'Schlüssel hinterlegt (nicht geprüft, keine Verbindung)' };
  }
}

export async function localStatus(config: Config, provider: string): Promise<AuthInfo> {
  const p = config.anbieter[provider];
  if (!p) return { state: 'fehler', text: 'nicht eingerichtet' };
  try {
    const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { state: 'fehler', text: `antwortet mit Status ${res.status}` };
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
    return { state: 'ok', text: `läuft${models.length ? ` · ${models.slice(0, 3).join(', ')}` : ''}` };
  } catch {
    return { state: 'fehlt', text: provider === 'ollama' ? 'läuft nicht (Enter startet Ollama)' : 'läuft nicht' };
  }
}

/** Ist ein Programm überhaupt vorhanden? (für die Anzeige, ohne es zu starten) */
export function hasOllama(): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { windowsHide: true });
  return r.status === 0;
}

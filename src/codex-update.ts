import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv } from './adapters/common.js';
import { codexProgram } from './auth.js';
import { homeDir, type Config } from './config.js';
import { errText } from './util.js';

/**
 * Codex aktuell halten: Ein altes Codex kennt die aktuellen Modelle von OpenAI nicht mehr
 * (dann geht gar kein Modell). Beim Start einer Codex-Sitzung prüft Harnes höchstens einmal
 * am Tag die Version und installiert die neueste offizielle Codex-CLI still im Hintergrund
 * (npm i -g @openai/codex). Abschalten: codex.autoUpdate = false in der config.json.
 */

const DAY = 24 * 60 * 60_000;
let running: Promise<void> | undefined;

function stateFile(): string {
  return join(homeDir(), 'codex-update.json');
}

/** Versionen wie 0.169.0 oder 0.130.0-alpha.5 vergleichen (Vorabversionen zählen als älter). */
export function olderThan(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main = '', pre] = v.trim().replace(/^v/, '').split('-');
    return { nums: main.split('.').map((x) => parseInt(x, 10) || 0), pre: !!pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0;
  }
  return x.pre && !y.pre;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    let out = '';
    const child = spawn(cmd, args, { env: cleanEnv(), windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
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

/** Installierte Codex-Version oder undefined */
export async function installedCodexVersion(config: Config): Promise<string | undefined> {
  try {
    const p = codexProgram(config);
    const r = await run(p.command, [...p.prefix, '--version'], 20_000);
    return /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(r.out)?.[1];
  } catch {
    return undefined;
  }
}

/** Neueste Version laut npm-Verzeichnis */
async function latestCodexVersion(): Promise<string | undefined> {
  try {
    const res = await fetch('https://registry.npmjs.org/@openai/codex/latest', { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    return ((await res.json()) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Prüft (höchstens einmal am Tag, `force` erzwingt es) und aktualisiert bei Bedarf.
 * `notify` bekommt kurze Meldungen für den Team-Chat.
 */
export function keepCodexCurrent(config: Config, notify: (text: string) => void, force = false): Promise<void> {
  if (config.codex.autoUpdate === false || config.codex.befehl || process.env.VITEST || process.env.RH_NO_UPDATE) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    let state: { checkedAt?: number } = {};
    try {
      if (existsSync(stateFile())) state = JSON.parse(readFileSync(stateFile(), 'utf8')) as typeof state;
    } catch {
      state = {};
    }
    if (!force && state.checkedAt && Date.now() - state.checkedAt < DAY) return;
    const [have, latest] = await Promise.all([installedCodexVersion(config), latestCodexVersion()]);
    if (!latest || (have && !olderThan(have, latest))) {
      if (latest) writeFileSync(stateFile(), JSON.stringify({ checkedAt: Date.now() }), 'utf8');
      return;
    }
    notify(`Codex wird im Hintergrund aktualisiert (${have ?? 'nicht installiert'} → ${latest}) …`);
    const npm = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const args = ['i', '-g', '@openai/codex@latest', '--no-audit', '--no-fund', '--loglevel=error'];
    const r = await run(npm, process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args, 10 * 60_000);
    if (r.code === 0) {
      writeFileSync(stateFile(), JSON.stringify({ checkedAt: Date.now() }), 'utf8');
      notify(`Codex ist jetzt aktuell (${latest}). Neue Codex-Sitzungen nutzen es.`);
    } else {
      notify(`Codex ließ sich nicht aktualisieren (wird beim nächsten Start erneut versucht): ${r.out.trim().split('\n').pop()?.slice(0, 160) ?? ''}`);
    }
  })().finally(() => (running = undefined));
  return running;
}

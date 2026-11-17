import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { truncate } from '../util.js';

/**
 * Umgebung für gestartete Sitzungen. Läuft RemoteHarnes selbst innerhalb einer
 * Claude-Code-Sitzung (z. B. im Terminal der Desktop-App), hat diese Variablen gesetzt,
 * die nur für sie gelten. Die werden entfernt, damit sich jede gestartete Sitzung
 * so verhält wie in einem normalen Terminal und ihr eigenes Login benutzt.
 */
export function cleanEnv(keep: string[] = []): Record<string, string> {
  const nested = Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // API-Schlüssel und Zugangsdaten nur dorthin, wo sie gebraucht werden (keep), nie an alle
    if (isSecretName(k) && !keep.includes(k)) continue;
    if (nested) {
      if (k === 'CLAUDECODE' || k === 'CLAUDE_EFFORT' || k === 'CLAUDE_PID') continue;
      if (/^CLAUDE_(CODE|AGENT_SDK|PREVIEW)_/.test(k)) continue;
      if (k === 'ANTHROPIC_BASE_URL') continue;
    }
    out[k] = v;
  }
  return out;
}

/** Umgebungsvariablen, die nach Schlüssel oder Zugangsdaten aussehen */
export function isSecretName(k: string): boolean {
  return /(_API_KEY|_APIKEY|_SECRET|_TOKEN|_ACCESS_KEY|_PASSWORD)$/i.test(k) || /^(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|AWS_SECRET_ACCESS_KEY)$/i.test(k);
}

/** Sucht ein Programm im PATH (unter Windows mit den üblichen Endungen). */
export function findOnPath(names: string[]): string | undefined {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Kurze, lesbare Zusammenfassung eines Werkzeug-Aufrufs für Freigabe-Karte und Protokoll. */
export function summarizeToolInput(tool: string, input: Record<string, unknown> | undefined, max = 600): string {
  const i = input ?? {};
  if (typeof i.command === 'string') return truncateKeepLines(`$ ${i.command}`, max);
  if (typeof i.file_path === 'string') {
    const extra =
      typeof i.new_string === 'string'
        ? ` (ersetzt ${String(i.old_string ?? '').length} → ${i.new_string.length} Zeichen)`
        : typeof i.content === 'string'
          ? ` (${i.content.length} Zeichen)`
          : '';
    return `${i.file_path}${extra}`;
  }
  if (typeof i.url === 'string') return i.url;
  if (typeof i.pattern === 'string') return `${i.pattern}${i.path ? ` in ${String(i.path)}` : ''}`;
  if (typeof i.query === 'string') return i.query;
  const json = JSON.stringify(i);
  return json === '{}' ? tool : truncate(json, max);
}

function truncateKeepLines(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Öffnet eine Adresse im Standardbrowser. Unter Windows bewusst nicht über „cmd /c start“:
 * Das würde Adressen mit „&“ (wie bei Anmeldungen üblich) abschneiden.
 */
export function openInBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    /* dann muss die Adresse von Hand geöffnet werden */
  }
}

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '../config.js';

/**
 * Store: GitHub-Repos suchen und den Sitzungen bereitstellen. Ein bereitgestelltes Repo wird
 * (nur die neueste Fassung) in den Ordner „repos“ von Harnes geholt; alle Sitzungen dürfen
 * dort lesen – als Beispiel, Nachschlagewerk oder Vorlage. Ausgeführt wird davon nichts.
 */

export interface RepoHit {
  name: string;
  beschreibung: string;
  sterne: number;
  sprache: string;
  url: string;
}

export function reposDir(): string {
  return join(homeDir(), 'repos');
}

/** Ordnername für ein Repo („besitzer/name“ -> „besitzer__name“) */
export function repoFolder(fullName: string): string {
  return join(reposDir(), fullName.replace('/', '__'));
}

export async function searchRepos(query: string): Promise<RepoHit[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=12`;
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Harnes' }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub lässt gerade keine weiteren Suchen zu (Limit). In einer Minute noch einmal.');
  if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}.`);
  const data = (await res.json()) as { items?: { full_name: string; description: string | null; stargazers_count: number; language: string | null; html_url: string }[] };
  return (data.items ?? []).map((r) => ({
    name: r.full_name,
    beschreibung: r.description ?? '',
    sterne: r.stargazers_count,
    sprache: r.language ?? '',
    url: r.html_url,
  }));
}

/** Holt ein Repo (git clone, nur neuester Stand). Gibt den Ordner zurück. */
export function cloneRepo(fullName: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return Promise.reject(new Error(`„${fullName}“ ist kein Repo-Name (besitzer/name).`));
  const dir = repoFolder(fullName);
  if (existsSync(dir)) return Promise.resolve(dir);
  mkdirSync(reposDir(), { recursive: true });
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['clone', '--depth', '1', '--quiet', `https://github.com/${fullName}.git`, dir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    git.stderr.on('data', (d) => (err += d));
    git.on('error', () => reject(new Error('git ist nicht installiert oder nicht zu finden.')));
    git.on('exit', (code) => (code === 0 ? resolve(dir) : reject(new Error(`Holen fehlgeschlagen: ${err.trim().split('\n').pop() ?? code}`))));
  });
}

/** Bereitgestellte Repos (als „besitzer/name“) */
export function listRepos(): string[] {
  if (!existsSync(reposDir())) return [];
  return readdirSync(reposDir(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.includes('__'))
    .map((d) => d.name.replace('__', '/'));
}

export function removeRepo(fullName: string): void {
  rmSync(repoFolder(fullName), { recursive: true, force: true });
}

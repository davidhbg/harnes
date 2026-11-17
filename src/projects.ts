import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './config.js';

/** Zuletzt geöffnete Projekte (für „Projekt wechseln“ auf der Startseite). */
export interface RecentProject {
  name: string;
  cwd: string;
  last: number;
}

const file = () => join(homeDir(), 'projekte.json');

export function recentProjects(): RecentProject[] {
  try {
    return (JSON.parse(readFileSync(file(), 'utf8')) as RecentProject[]).sort((a, b) => b.last - a.last);
  } catch {
    return [];
  }
}

export function rememberProject(name: string, cwd: string): void {
  const list = recentProjects().filter((p) => p.cwd.toLowerCase() !== cwd.toLowerCase());
  list.unshift({ name, cwd, last: Date.now() });
  try {
    writeFileSync(file(), JSON.stringify(list.slice(0, 12), null, 2), 'utf8');
  } catch {
    /* nicht wichtig */
  }
}

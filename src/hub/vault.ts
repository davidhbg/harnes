import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Message, Task } from '../types.js';
import { dateStr, hhmm, safeName } from '../util.js';

export interface TeamMember {
  name: string;
  label: string;
  model?: string;
  status: string;
}

/**
 * Gemeinsames Gedächtnis als Obsidian-Vault.
 * Lesen darf jede Sitzung alles. Geschrieben wird nur über diese Klasse:
 * Chat-Protokolle, Aufgaben und Team pflegt das Tool; jeder Agent schreibt
 * nur in seine eigene Notiz und legt Wissen an.
 */
export class Vault {
  constructor(
    readonly root: string,
    private project: string,
    private humanLabel: string,
  ) {}

  init(): void {
    for (const d of ['', 'Chat', 'Agenten', 'Wissen']) mkdirSync(join(this.root, d), { recursive: true });
    const overview = join(this.root, `00 ${safeName(this.project)} – Übersicht.md`);
    if (!existsSync(overview)) {
      writeFileSync(
        overview,
        [
          '---',
          'tags: [remoteharnes, team]',
          `aktualisiert: ${dateStr(Date.now())}`,
          '---',
          `# ${this.project} – Übersicht`,
          '',
          `Team-Vault von Harnes für das Projekt **${this.project}**. Teamleiter: ${this.humanLabel}.`,
          '',
          '- [[Team]] – wer gerade dabei ist',
          '- [[Aufgaben]] – Aufgabenbrett (pflegt das Tool)',
          '- [[Entscheidungen]] – wichtige Absprachen',
          '- `Chat/` – Protokolle von Teamchat und Privatchats',
          '- `Agenten/` – Arbeitsnotizen je Agent',
          '- `Wissen/` – Erkenntnisse für alle',
          '',
          '## Ziel',
          '',
          '_(hier trägt der Teamleiter das Ziel des Projekts ein)_',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    const decisions = join(this.root, 'Entscheidungen.md');
    if (!existsSync(decisions)) {
      writeFileSync(decisions, '---\ntags: [remoteharnes, entscheidungen]\n---\n# Entscheidungen\n\n', 'utf8');
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* Vault-Probleme dürfen den Chat nie anhalten */
    }
  }

  private appendWithHeader(file: string, header: string, line: string): void {
    if (!existsSync(file)) writeFileSync(file, header, 'utf8');
    appendFileSync(file, line, 'utf8');
  }

  private bullet(prefix: string, text: string): string {
    const lines = text.replace(/\r/g, '').split('\n');
    return `- ${prefix} ${lines[0]}\n` + lines.slice(1).map((l) => `  ${l}\n`).join('');
  }

  logMessage(m: Message, label: (id: string) => string): void {
    if (m.system) return;
    this.safe(() => {
      const day = dateStr(m.ts);
      const urgent = m.urgent ? ' !!' : '';
      if (m.to === 'team') {
        this.appendWithHeader(
          join(this.root, 'Chat', `${day} Team.md`),
          `---\ntags: [remoteharnes, chat]\n---\n# Teamchat ${day}\n\n`,
          this.bullet(`**${hhmm(m.ts)} ${label(m.from)}:**${urgent}`, m.text),
        );
      } else {
        const pair = [m.from, m.to].sort((a, b) => a.localeCompare(b)).map(label);
        this.appendWithHeader(
          join(this.root, 'Chat', `${day} Privat ${safeName(pair.join(' + '))}.md`),
          `---\ntags: [remoteharnes, chat, privat]\n---\n# Privatchat ${pair.join(' und ')} – ${day}\n\n`,
          this.bullet(`**${hhmm(m.ts)} ${label(m.from)} → ${label(m.to)}:**${urgent}`, m.text),
        );
      }
    });
  }

  writeTasks(tasks: Task[], files: Map<string, string>): void {
    this.safe(() => {
      const rows = tasks.map(
        (t) =>
          `| ${t.id} | ${t.title.replace(/\|/g, '/')} | ${t.owner ?? '–'} | ${t.status} | ${(t.proof ?? '').replace(/\|/g, '/')} |`,
      );
      const fileRows = [...files].map(([p, a]) => `- \`${p}\` → ${a}`);
      writeFileSync(
        join(this.root, 'Aufgaben.md'),
        [
          '---',
          'tags: [remoteharnes, aufgaben]',
          `aktualisiert: ${dateStr(Date.now())}`,
          '---',
          '# Aufgaben',
          '',
          '> Diese Notiz schreibt Harnes. Änderungen bitte über das Tool (Aufgaben-Tab oder Werkzeuge).',
          '',
          '| Nr. | Aufgabe | Wer | Status | Nachweis |',
          '|---|---|---|---|---|',
          ...(rows.length ? rows : ['| – | _noch keine Aufgaben_ | | | |']),
          '',
          '## Reservierte Dateien',
          '',
          ...(fileRows.length ? fileRows : ['_keine_']),
          '',
        ].join('\n'),
        'utf8',
      );
    });
  }

  writeTeam(members: TeamMember[]): void {
    this.safe(() => {
      writeFileSync(
        join(this.root, 'Team.md'),
        [
          '---',
          'tags: [remoteharnes, team]',
          `aktualisiert: ${dateStr(Date.now())}`,
          '---',
          '# Team',
          '',
          `Teamleiter: **${this.humanLabel}** (Mensch)`,
          '',
          '| Name | Art | Modell | Notiz |',
          '|---|---|---|---|',
          ...members.map((m) => `| ${m.name} | ${m.label} | ${m.model ?? '–'} | [[Agenten/${m.name}]] |`),
          '',
        ].join('\n'),
        'utf8',
      );
    });
  }

  appendDecision(by: string, text: string): void {
    const now = Date.now();
    appendFileSync(
      join(this.root, 'Entscheidungen.md'),
      this.bullet(`**${dateStr(now)} ${hhmm(now)} ${by}:**`, text.trim()),
      'utf8',
    );
  }

  appendAgentNote(agent: string, text: string): string {
    const now = Date.now();
    const file = join(this.root, 'Agenten', `${safeName(agent)}.md`);
    this.appendWithHeader(
      file,
      `---\ntags: [remoteharnes, agent]\n---\n# Arbeitsnotizen ${agent}\n\n`,
      this.bullet(`**${dateStr(now)} ${hhmm(now)}:**`, text.trim()),
    );
    return this.rel(file);
  }

  writeKnowledge(agent: string, title: string, text: string): string {
    const now = Date.now();
    const file = join(this.root, 'Wissen', `${safeName(title)}.md`);
    if (existsSync(file)) {
      appendFileSync(file, `\n## Ergänzung ${dateStr(now)} ${hhmm(now)} (${agent})\n\n${text.trim()}\n`, 'utf8');
    } else {
      writeFileSync(
        file,
        `---\ntags: [remoteharnes, wissen]\nautor: ${agent}\naktualisiert: ${dateStr(now)}\n---\n# ${title.trim()}\n\n${text.trim()}\n`,
        'utf8',
      );
    }
    return this.rel(file);
  }

  private rel(file: string): string {
    return relative(this.root, file).split(sep).join('/');
  }

  private inside(relPath: string): string {
    const abs = resolve(this.root, relPath);
    const rootAbs = resolve(this.root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) throw new Error('Pfad liegt außerhalb des Team-Vaults.');
    return abs;
  }

  private walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) this.walk(p, out);
      else if (name.toLowerCase().endsWith('.md')) out.push(p);
    }
  }

  list(): string[] {
    const out: string[] = [];
    this.walk(this.root, out);
    return out.map((p) => this.rel(p));
  }

  read(relPath: string): string {
    let abs = this.inside(relPath);
    if (!existsSync(abs) && existsSync(abs + '.md')) abs += '.md';
    if (!existsSync(abs)) throw new Error(`Notiz „${relPath}“ gibt es nicht. vault_liste zeigt alle Notizen.`);
    const text = readFileSync(abs, 'utf8');
    return text.length > 40_000 ? text.slice(-40_000) + '\n…(nur die letzten 40.000 Zeichen)' : text;
  }

  search(term: string, max = 40): string {
    const needle = term.toLowerCase().trim();
    if (!needle) return 'Suchbegriff fehlt.';
    const hits: string[] = [];
    for (const rel of this.list()) {
      const lines = readFileSync(join(this.root, rel), 'utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
      }
      if (hits.length >= max) break;
    }
    return hits.length ? hits.join('\n') : `Keine Treffer für „${term}“.`;
  }
}

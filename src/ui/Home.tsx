import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Box, Text, useAnimation, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useEffect, useReducer, useRef } from 'react';
import { openInBrowser } from '../adapters/common.js';
import { connectVaultRoot } from '../vault-connect.js';
import { updateConfig, type Config } from '../config.js';
import type { Hub } from '../hub/hub.js';
import { cloneRepo, listRepos, removeRepo, repoFolder, searchRepos, type RepoHit } from '../hub/repos.js';
import { recentProjects } from '../projects.js';
import { errText, truncate } from '../util.js';
import { brailleImage, galaxy, muse, overlay, starfield } from './art.js';
import { ownImages } from './eigene-bilder.js';
import { startBegleiter } from '../begleiter.js';
import { mouseEnabled, mouseEvents, setMouseEnabled, useMouse } from './mouse.js';
import { Lines, Row } from './Spans.js';
import { T, barSpans, bigLogo, fmtTokens, gradientSpans, logoLine, smallLogo, type Line, type Span } from './theme.js';

/**
 * Startseite: erst der Ladebildschirm, dann „Wohin?“ – Team-Chat, Aufgaben, neue Sitzung,
 * Verlauf, wiederkehrende Aufgaben, Store, Projekte, Einstellungen, MCP-Server, Vault, Verbrauch.
 * Rechts ein Bild (Braille-Zeichnung aus ui/bilder.ts).
 */

export type HomeAction =
  | { type: 'team'; channel: string; menu?: string }
  | { type: 'einrichtung' }
  | { type: 'konten' }
  | { type: 'projekt'; cwd: string }
  | { type: 'quit' };

interface Props {
  hub: Hub;
  config: Config;
  project: string;
  /** Ladebildschirm zeigen (beim Programmstart) */
  boot: boolean;
  /** nach dem Laden gleich in die Einrichtung (erster Start) */
  needsSetup: boolean;
  /** gleich diese Ansicht zeigen (z. B. „Projekt wechseln“ aus der Teamansicht) */
  startView?: 'projekte';
  onAction: (a: HomeAction) => void;
}

interface Item {
  icon: string;
  label: string;
  hint: string;
  run: () => void;
}

type View = 'boot' | 'haupt' | 'einstellungen' | 'mcp' | 'plaene' | 'store' | 'projekte' | 'formular';

interface Form {
  title: string;
  note: string;
  fields: { label: string; value: string }[];
  field: number;
  back: View;
  save: (values: string[]) => void | Promise<void>;
}

const BOOT_MS = 2600;
const BOOT_TEXT = ['Sterne werden gezählt …', 'Sitzungen werden geweckt …', 'Vault wird aufgeschlagen …', 'Bereit.'];

/** Befehlszeile in Wörter teilen; Anführungszeichen halten Teile mit Leerzeichen zusammen. */
export function splitCommand(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

export function Home({ hub, config, project, boot, needsSetup, startView, onAction }: Props) {
  const { exit } = useApp();
  const { columns: C, rows: R } = useWindowSize();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const st = useRef({
    view: (boot && !process.env.RH_NO_ANIM ? 'boot' : (startView ?? 'haupt')) as View,
    cursor: 0,
    started: Date.now(),
    notice: '',
    confirm: '',
    busy: '',
    form: undefined as Form | undefined,
    query: '',
    hits: [] as RepoHit[],
  }).current;
  const { time } = useAnimation({ interval: st.view === 'boot' ? 50 : 110 });

  const doAction = (a: HomeAction) => {
    onAction(a);
    exit();
  };
  const go = (view: View) => {
    st.view = view;
    st.cursor = 0;
    st.confirm = '';
    rerender();
  };
  const openForm = (f: Omit<Form, 'field'>) => {
    st.form = { ...f, field: 0 };
    go('formular');
  };
  /** Längere Arbeit (Suche, Herunterladen) mit Hinweis unten */
  const work = (label: string, p: Promise<string | void>) => {
    st.busy = label;
    rerender();
    p.then((msg) => {
      if (msg) st.notice = msg;
    })
      .catch((e) => {
        st.notice = errText(e);
      })
      .finally(() => {
        st.busy = '';
        rerender();
      });
  };
  const finishBoot = () => {
    if (st.view !== 'boot') return;
    if (needsSetup) doAction({ type: 'einrichtung' });
    else go('haupt');
  };
  useEffect(() => {
    if (st.view !== 'boot') return;
    const t = setTimeout(finishBoot, BOOT_MS);
    return () => clearTimeout(t);
  }, []);
  if (st.view === 'boot' && Date.now() - st.started > BOOT_MS + 200) finishBoot();
  useEffect(() => {
    if (st.view === 'haupt' && needsSetup) doAction({ type: 'einrichtung' });
  }, []);

  const mcp = config.mcp ?? {};
  const total = hub.totalUsage();
  const openTasks = hub.tasks.tasks.filter((t) => t.status !== 'erledigt').length;
  const live = hub.agents.size;
  const plans = hub.plans.plans;
  const repos = listRepos();

  let title = '';
  let items: Item[] = [];
  let note = '';
  switch (st.view) {
    case 'haupt':
      title = 'Wohin?';
      items = [
        { icon: '#', label: 'Team-Chat', hint: live ? `${live} Sitzung${live === 1 ? '' : 'en'}` : 'noch leer', run: () => doAction({ type: 'team', channel: 'team' }) },
        { icon: '≡', label: 'Aufgaben', hint: openTasks ? `${openTasks} offen` : 'keine offen', run: () => doAction({ type: 'team', channel: 'aufgaben' }) },
        { icon: '+', label: 'Neue Sitzung', hint: 'mit Rolle: Tester, Reviewer …', run: () => doAction({ type: 'team', channel: 'team', menu: 'neu' }) },
        { icon: '?', label: 'Verlauf durchsuchen', hint: 'alle Chats', run: () => doAction({ type: 'team', channel: 'team', menu: 'suche' }) },
        { icon: '↻', label: 'Wiederkehrende Aufgaben', hint: plans.length ? `${plans.filter((p) => p.aktiv).length} aktiv` : 'z. B. täglich Tests', run: () => go('plaene') },
        { icon: '~', label: 'Begleiter', hint: 'Sprechen mit Strg+Alt', run: () => { st.notice = startBegleiter(); rerender(); } },
        { icon: '◆', label: 'Store', hint: repos.length ? `${repos.length} Repos bereit` : 'GitHub-Repos für das Team', run: () => go('store') },
        { icon: '›', label: 'Projekt wechseln', hint: project, run: () => go('projekte') },
        { icon: '*', label: 'Einstellungen', hint: 'Zugänge, MCP, Maus', run: () => go('einstellungen') },
        {
          icon: '◇',
          label: 'Vault öffnen',
          hint: 'in Obsidian',
          run: () => {
            openInBrowser(`obsidian://open?path=${encodeURIComponent(hub.opts.vault.root)}`);
            st.notice = `Öffnet Obsidian mit ${hub.opts.vault.root}`;
          },
        },
        { icon: 'Σ', label: 'Verbrauch', hint: `${fmtTokens(total.inputTokens + total.outputTokens)} Tokens`, run: () => doAction({ type: 'team', channel: 'verbrauch' }) },
        { icon: '×', label: 'Beenden', hint: '', run: () => doAction({ type: 'quit' }) },
      ];
      break;
    case 'einstellungen':
      title = 'Einstellungen';
      items = [
        { icon: '›', label: 'Zugänge verbinden', hint: 'Abo, API, lokal', run: () => doAction({ type: 'einrichtung' }) },
        { icon: '›', label: 'Anmeldungen und Schlüssel', hint: 'alles auf einen Blick', run: () => doAction({ type: 'konten' }) },
        { icon: '@', label: 'MCP-Server', hint: `${Object.keys(mcp).length} eingerichtet`, run: () => go('mcp') },
        {
          icon: '◇',
          label: 'Vault verbinden',
          hint: truncate(config.vaultRoot, 34),
          run: () =>
            openForm({
              title: 'Vault verbinden',
              note: 'Ordner deines Obsidian-Vaults oder ein neuer Ordner. Harnes legt darin je Projekt einen Unterordner an und überschreibt nichts.',
              fields: [{ label: 'Ordner', value: config.vaultRoot }],
              back: 'einstellungen',
              save: ([p = '']) => {
                config.vaultRoot = connectVaultRoot(p);
                doAction({ type: 'projekt', cwd: hub.opts.cwd });
              },
            }),
        },
        {
          icon: '›',
          label: mouseEnabled() ? 'Maus ausschalten' : 'Maus einschalten',
          hint: 'aus: Text direkt markieren',
          run: () => {
            setMouseEnabled(!mouseEnabled());
            st.notice = mouseEnabled() ? 'Maus an.' : 'Maus aus.';
          },
        },
        { icon: '‹', label: 'Zurück', hint: '', run: () => go('haupt') },
      ];
      break;
    case 'mcp':
      title = 'MCP-Server';
      note = 'Jede neue Sitzung bekommt diese Server (Claude, Codex, Claude-API). Claude Code nutzt zusätzlich deine eigenen MCP-Server aus Claude.';
      items = Object.entries(mcp).map(([name, m]) => ({
        icon: '@',
        label: name,
        hint: st.confirm === name ? 'Enter: wirklich entfernen' : truncate([m.befehl, ...(m.args ?? [])].join(' '), 36),
        run: () => {
          if (st.confirm !== name) {
            st.confirm = name;
            return;
          }
          const next = { ...mcp };
          delete next[name];
          config.mcp = next;
          updateConfig((c) => {
            c.mcp = next;
          });
          st.confirm = '';
          st.notice = `${name} entfernt. Gilt für neue Sitzungen.`;
        },
      }));
      items.push(
        {
          icon: '+',
          label: 'Server hinzufügen',
          hint: 'Name und Befehl',
          run: () =>
            openForm({
              title: 'MCP-Server hinzufügen',
              note: 'Beispiel: Name „memory“, Befehl „npx -y @modelcontextprotocol/server-memory“',
              fields: [
                { label: 'Name', value: '' },
                { label: 'Befehl', value: '' },
              ],
              back: 'mcp',
              save: ([n = '', b = '']) => {
                const name = n.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                const parts = splitCommand(b.trim());
                if (!name || !parts.length) throw new Error('Bitte Name und Befehl eingeben.');
                if (name === 'remoteharnes') throw new Error('Diesen Namen nutzt Harnes selbst.');
                const next = { ...mcp, [name]: { befehl: parts[0]!, args: parts.slice(1) } };
                config.mcp = next;
                updateConfig((c) => {
                  c.mcp = next;
                });
                st.notice = `${name} eingerichtet. Neue Sitzungen bekommen den Server.`;
                go('mcp');
              },
            }),
        },
        { icon: '‹', label: 'Zurück', hint: '', run: () => go('einstellungen') },
      );
      break;
    case 'plaene':
      title = 'Wiederkehrende Aufgaben';
      note = 'Harnes schickt die Nachricht zur festen Zeit an das Team oder eine Sitzung – solange es geöffnet ist. Enter: an/aus, Entf: löschen.';
      items = plans.map((p) => ({
        icon: p.aktiv ? '●' : '○',
        label: truncate(p.text, 26),
        hint: st.confirm === String(p.id) ? 'Entf: wirklich löschen' : `${p.wann} → ${p.an}${p.aktiv ? '' : ' (aus)'}`,
        run: () => {
          const x = hub.plans.toggle(p.id);
          st.notice = x.aktiv ? 'Wieder an.' : 'Pausiert.';
        },
      }));
      items.push(
        {
          icon: '+',
          label: 'Neue wiederkehrende Aufgabe',
          hint: '',
          run: () =>
            openForm({
              title: 'Neue wiederkehrende Aufgabe',
              note: 'Wann: „täglich 08:00“, „alle 30 min“, „alle 2 std“ oder „stündlich“. An: „team“ oder der Name einer Sitzung.',
              fields: [
                { label: 'Was', value: '' },
                { label: 'An', value: 'team' },
                { label: 'Wann', value: 'täglich 08:00' },
              ],
              back: 'plaene',
              save: ([was = '', an = '', wann = '']) => {
                const target = an.trim().toLowerCase().replace(/^@/, '') || 'team';
                const p = hub.plans.add(was, target, wann);
                st.notice = `Angelegt: ${p.wann} → ${p.an}.`;
                go('plaene');
              },
            }),
        },
        { icon: '‹', label: 'Zurück', hint: '', run: () => go('haupt') },
      );
      break;
    case 'store':
      title = 'Store';
      note = 'GitHub-Repos suchen und dem Team bereitstellen: Sie werden geholt, alle Sitzungen dürfen darin lesen (Beispiele, Vorlagen, Doku). Ausgeführt wird nichts.';
      items = [
        {
          icon: '?',
          label: st.query ? `Suche: ${truncate(st.query, 22)}` : 'Repos suchen',
          hint: 'Stichwort, z. B. „react table“',
          run: () =>
            openForm({
              title: 'GitHub durchsuchen',
              note: 'Stichworte wie bei GitHub, z. B. „markdown parser language:typescript“',
              fields: [{ label: 'Suche', value: st.query }],
              back: 'store',
              save: ([q = '']) => {
                st.query = q.trim();
                go('store');
                work(
                  'Suche bei GitHub …',
                  searchRepos(st.query).then((hits) => {
                    st.hits = hits;
                    st.cursor = 1;
                    return hits.length ? `${hits.length} Treffer. Enter stellt ein Repo bereit.` : 'Nichts gefunden.';
                  }),
                );
              },
            }),
        },
      ];
      for (const h of st.hits) {
        const have = repos.includes(h.name);
        items.push({
          icon: have ? '●' : '○',
          label: truncate(h.name, 30),
          hint: have ? 'bereitgestellt' : `★ ${fmtTokens(h.sterne)}  ${truncate(h.beschreibung || h.sprache, 34)}`,
          run: () => {
            if (have) return;
            work(
              `${h.name} wird geholt …`,
              cloneRepo(h.name).then((dir) => {
                hub.noteAll(`Neues Repo zum Nachlesen bereitgestellt: ${h.name} unter ${dir}`);
                hub.system(`Store: ${h.name} bereitgestellt (${dir}).`);
                return `${h.name} bereit. Die Sitzungen erfahren es mit ihrer nächsten Nachricht.`;
              }),
            );
          },
        });
      }
      for (const name of repos.filter((r) => !st.hits.some((h) => h.name === r))) {
        items.push({
          icon: '●',
          label: truncate(name, 30),
          hint: st.confirm === name ? 'Enter: wirklich entfernen' : 'bereitgestellt · Enter zweimal entfernt',
          run: () => {
            if (st.confirm !== name) {
              st.confirm = name;
              return;
            }
            removeRepo(name);
            st.confirm = '';
            st.notice = `${name} entfernt (${repoFolder(name)}).`;
          },
        });
      }
      items.push({ icon: '‹', label: 'Zurück', hint: '', run: () => go('haupt') });
      break;
    case 'projekte': {
      title = 'Projekt wechseln';
      note = 'Jedes Projekt hat eigene Chats, Aufgaben, Sitzungen und einen eigenen Vault.';
      const here = hub.opts.cwd.toLowerCase();
      items = recentProjects().map((p) => ({
        icon: p.cwd.toLowerCase() === here ? '●' : '○',
        label: truncate(p.name, 24),
        hint: truncate(p.cwd, 38),
        run: () => {
          if (p.cwd.toLowerCase() === here) return go('haupt');
          if (!existsSync(p.cwd)) {
            st.notice = `Den Ordner ${p.cwd} gibt es nicht mehr.`;
            return;
          }
          doAction({ type: 'projekt', cwd: p.cwd });
        },
      }));
      items.push(
        {
          icon: '+',
          label: 'Anderer Ordner …',
          hint: 'Pfad eingeben',
          run: () =>
            openForm({
              title: 'Projektordner öffnen',
              note: 'Ganzer Pfad, z. B. C:\\Users\\du\\Projekte\\Shop',
              fields: [{ label: 'Ordner', value: '' }],
              back: 'projekte',
              save: ([p = '']) => {
                const dir = resolve(p.trim().replace(/^"|"$/g, ''));
                if (!p.trim() || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Den Ordner ${dir} gibt es nicht.`);
                doAction({ type: 'projekt', cwd: dir });
              },
            }),
        },
        { icon: '‹', label: 'Zurück', hint: '', run: () => go('haupt') },
      );
      break;
    }
    case 'formular':
      title = st.form?.title ?? '';
      note = st.form?.note ?? '';
      break;
  }
  if (st.cursor >= items.length) st.cursor = Math.max(0, items.length - 1);

  const saveForm = () => {
    const f = st.form;
    if (!f) return;
    try {
      const r = f.save(f.fields.map((x) => x.value));
      if (r instanceof Promise) r.catch((e) => ((st.notice = errText(e)), rerender()));
    } catch (e) {
      st.notice = errText(e);
    }
  };

  // Klickstellen
  const hits: Record<number, () => void> = {};
  useMouse((e) => {
    if (st.view === 'boot') return finishBoot();
    if (e.kind === 'press' && hits[e.y]) {
      st.notice = '';
      hits[e.y]!();
      rerender();
    }
  });

  usePaste((text) => {
    const f = st.form;
    if (st.view !== 'formular' || !f) return;
    f.fields[f.field]!.value += text.replace(/\r?\n/g, ' ');
    rerender();
  });

  useInput((input, key) => {
    if (mouseEvents(input)) return;
    if (st.view === 'boot') return finishBoot();
    st.notice = '';
    if (key.ctrl && input === 'c') return doAction({ type: 'quit' });
    if (st.view === 'formular' && st.form) {
      const f = st.form;
      const cur = f.fields[f.field]!;
      if (key.escape) return go(f.back);
      if (key.tab || key.downArrow) f.field = (f.field + 1) % f.fields.length;
      else if (key.upArrow) f.field = (f.field - 1 + f.fields.length) % f.fields.length;
      else if (key.return) {
        if (f.field < f.fields.length - 1) f.field++;
        else saveForm();
      } else if (key.backspace) cur.value = cur.value.slice(0, -1);
      else if (input && !key.ctrl && !key.meta) cur.value += input;
      return rerender();
    }
    if (key.escape) {
      if (st.view === 'haupt') return doAction({ type: 'team', channel: 'team' });
      return go(st.view === 'mcp' ? 'einstellungen' : 'haupt');
    }
    // Entf löscht einen Zeitplan (zweimal drücken)
    if (key.delete && st.view === 'plaene') {
      const p = plans[st.cursor];
      if (p) {
        if (st.confirm === String(p.id)) {
          hub.plans.remove(p.id);
          st.confirm = '';
          st.notice = 'Gelöscht.';
        } else st.confirm = String(p.id);
      }
      return rerender();
    }
    if (key.upArrow) st.cursor = (st.cursor - 1 + items.length) % items.length;
    else if (key.downArrow || key.tab) st.cursor = (st.cursor + 1) % items.length;
    else if (key.return) items[st.cursor]?.run();
    else if (/^[1-9]$/.test(input)) {
      st.cursor = Math.min(items.length - 1, Number(input) - 1);
      items[st.cursor]?.run();
    } else if (input.toLowerCase() === 'q' && st.view === 'haupt') return doAction({ type: 'quit' });
    rerender();
  });

  // ---------- Ladebildschirm ----------
  if (st.view === 'boot') {
    const p = Math.min(1, (Date.now() - st.started) / BOOT_MS);
    const logo = C >= 60 ? bigLogo('HARNES') : smallLogo('HARNES');
    const gH = Math.max(0, Math.min(14, R - logo.length - 8));
    const gW = Math.min(C - 4, 76);
    const lines: Line[] = [];
    if (gH >= 5) lines.push(...galaxy(gW, gH, Date.now()).map((l) => [{ text: ' '.repeat(Math.max(0, Math.floor((C - gW) / 2))) }, ...l]));
    lines.push([]);
    const lw = [...(logo[0] ?? '')].length;
    logo.forEach((l, i) => lines.push([{ text: ' '.repeat(Math.max(0, Math.floor((C - lw) / 2))) }, ...logoLine(l, i, { reveal: Math.min(1, p * 1.6), phase: time / 4000, shine: p })]));
    lines.push([]);
    const barW = Math.min(40, C - 10);
    const msg = BOOT_TEXT[Math.min(BOOT_TEXT.length - 1, Math.floor(p * BOOT_TEXT.length))]!;
    lines.push([{ text: ' '.repeat(Math.max(0, Math.floor((C - barW - 6) / 2))) }, ...barSpans(p, barW, -time / 3000), { text: ` ${Math.round(p * 100)}%`, color: T.muted }]);
    lines.push([{ text: ' '.repeat(Math.max(0, Math.floor((C - msg.length) / 2))) }, { text: msg, color: T.faint }]);
    const top = Math.max(0, Math.floor((R - lines.length) / 2));
    return (
      <Box flexDirection="column" width={C} height={R}>
        <Lines lines={[...Array.from({ length: top }, () => [] as Line), ...lines]} height={R} />
      </Box>
    );
  }

  // ---------- Auswahl ----------
  const artW = C >= 100 ? Math.min(Math.floor(C * 0.45), 86) : 0;
  const leftW = C - artW - (artW ? 2 : 0);
  const k = (t: string): Span => ({ text: t, color: T.violet, bold: true });
  const d = (t: string): Span => ({ text: t, color: T.faint });
  const left: Line[] = [];
  // Viele Punkte: kleines Logo, damit alles passt
  const logo = leftW >= 58 && R >= 34 ? bigLogo('HARNES') : smallLogo('HARNES');
  logo.forEach((l, i) => left.push(logoLine(l, i, { phase: time / 5000 })));
  left.push([]);
  left.push(gradientSpans(title, time / 4000, { bold: true }));
  if (note) for (const l of note.match(new RegExp(`.{1,${Math.max(30, leftW - 8)}}(\\s|$)`, 'g')) ?? [note]) left.push([d(l.trim())]);
  left.push([]);
  if (st.view === 'formular' && st.form) {
    const f = st.form;
    f.fields.forEach((x, i) => {
      const active = i === f.field;
      hits[1 + left.length] = () => {
        f.field = i;
      };
      left.push([
        { text: active ? '❯ ' : '  ', color: T.pink, bold: true },
        { text: x.label.padEnd(8), color: active ? T.text : T.muted, bold: active },
        { text: ` ${truncate(x.value, Math.max(10, leftW - 20))}`, color: T.text, bg: T.night },
        { text: active ? ' ' : '', bg: T.violet },
      ]);
      left.push([]);
    });
    left.push([k('Tab'), d(' nächstes Feld  '), k('Enter'), d(' weiter/speichern  '), k('Esc'), d(' zurück')]);
  } else {
    // Bei langen Listen nur einen Ausschnitt um die Markierung zeigen
    const room = Math.max(4, R - 4 - left.length);
    const from = Math.max(0, Math.min(st.cursor - Math.floor(room / 2), items.length - room));
    items.slice(from, from + room).forEach((it, j) => {
      const i = from + j;
      const at = i === st.cursor;
      const bg = at ? T.night : undefined;
      const label: Span[] = [
        { text: at ? ' ❯ ' : '   ', color: T.pink, bold: true, bg },
        { text: `${it.icon}  `, color: at ? T.pink : T.violet, bold: true, bg },
        { text: it.label, color: at ? T.text : T.muted, bold: at, bg },
      ];
      const used = label.reduce((s, x) => s + [...x.text].length, 0);
      // Hinweise in einer gemeinsamen Spalte
      const gap = Math.max(2, 32 - used);
      const hintW = Math.max(0, leftW - 6 - used - gap);
      hits[1 + left.length] = () => {
        st.cursor = i;
        it.run();
      };
      left.push([...label, { text: ' '.repeat(gap), bg }, { text: truncate(it.hint, hintW), color: T.faint, bg }, { text: ' ', bg }]);
    });
  }
  // eigene Bilder (~/.remoteharnes/bilder/startseite-*.txt) im Wechsel alle 15 Sekunden, sonst das eingebaute
  const own = ownImages('startseite');
  const bild = own[Math.floor(Date.now() / 15_000) % Math.max(1, own.length)];
  const art = !artW ? [] : bild ? brailleImage(bild, artW, R - 2, time) : muse(artW, R - 2, time);
  const leftTop = Math.max(0, Math.floor((R - 2 - left.length) / 2) - 1);
  if (leftTop) {
    for (const key of Object.keys(hits).map(Number).sort((a, b) => b - a)) {
      hits[key + leftTop] = hits[key]!;
      delete hits[key];
    }
  }

  // funkelnde Sterne rund um Logo und Menü (hinter dem Text frei geräumt)
  const leftLines = [...Array.from({ length: leftTop }, () => [] as Line), ...left];
  const skyW = Math.max(1, leftW - 3);
  const leftSky = overlay(starfield(skyW, R - 2, time, 0.06, 7), leftLines, 0, skyW);

  return (
    <Box flexDirection="column" width={C} height={R}>
      {/* leere Kopfzeile: hält den Abstand (Mausklicks rechnen mit ihr) */}
      <Box height={1} />
      <Box height={R - 2} flexDirection="row">
        <Box width={leftW} paddingLeft={3} flexDirection="column">
          <Lines lines={leftSky} height={R - 2} />
        </Box>
        {artW > 0 && (
          <Box width={artW} marginLeft={2}>
            <Lines lines={art} height={R - 2} />
          </Box>
        )}
      </Box>
      <Box height={1} justifyContent="space-between">
        {st.busy ? (
          <Text color={T.pink}>{` ${st.busy}`}</Text>
        ) : st.notice ? (
          <Text color={T.warn}>{` ${st.notice}`}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

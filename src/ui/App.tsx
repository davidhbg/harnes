import type { EventEmitter } from 'node:events';
import { Box, Text, useAnimation, useApp, useInput, usePaste, useStdin, useWindowSize } from 'ink';
import { useEffect, useReducer, useRef } from 'react';
import { fmtMoney, providerLabel } from '../balance.js';
import { keyEnvFor, saveKey } from '../config.js';
import type { Hub } from '../hub/hub.js';
import { errText, truncate, width as textWidth, wrapText } from '../util.js';
import { agentScene, centered, dissolve, galaxy, overlay, scene, type SceneName } from './art.js';
import { parseSpec, runCommand, suggest } from './commands.js';
import { REVEAL_MS, chatLines, colorOf, helpLines, logLines, searchLines, statusDot, statusWord, taskLines, usageLines } from './lines.js';
import { mouseEnabled, mouseEvents, setMouseEnabled, useMouse } from './mouse.js';
import { Lines, Row } from './Spans.js';
import { startRows } from './Start.js';
import { ROLES, roleById } from '../hub/roles.js';
import type { Menu, MenuItem, UiAction, UiState } from './state.js';
import { SPINNER, T, fmtDuration, fmtTokens, gradient, gradientSpans, mix, type Line, type Span } from './theme.js';

interface Props {
  hub: Hub;
  ui: UiState;
  project: string;
  onAction: (a: UiAction) => void;
}

const BUSY = ['arbeitet', 'freigabe', 'startet'];
/** So lange löst sich das Hintergrundbild auf, wenn die erste Nachricht kommt. */
const FADE_MS = 700;
/** Merkt sich das erste Strg+W, damit erst das zweite die Sitzung schließt. */
const closeAsked = { name: '', at: 0 };
/** UI-Zustände, deren frühere Eingaben schon geladen sind */
const historyLoaded = new WeakSet<UiState>();

/** Bekannte Modelle je Art; „Eigenes Modell“ geht immer. */
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];

const spansW = (l: Span[]) => l.reduce((s, x) => s + textWidth(x.text), 0);
/** Bild hinter einem Menü abdunkeln */
const dimLines = (lines: Line[]): Line[] => lines.map((l) => l.map((s) => ({ ...s, bold: false, color: mix(s.color ?? T.faint, '#0E0B1C', 0.62), bg: undefined })));

interface Hit {
  y: number;
  x0: number;
  x1: number;
  run: () => void;
}

export function App({ hub, ui, project, onAction }: Props) {
  const { exit } = useApp();
  const { columns: C, rows: R } = useWindowSize();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const stdinCtx = useStdin() as unknown as { internal_eventEmitter?: EventEmitter };

  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    const onChange = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        rerender();
      }, 40);
    };
    hub.on('change', onChange);
    return () => {
      hub.off('change', onChange);
      if (timer) clearTimeout(timer);
    };
  }, [hub]);

  // ---------- Animation: läuft nur, wenn sich wirklich etwas tut ----------
  const now = Date.now();
  const busy = [...hub.agents.values()].filter((a) => BUSY.includes(a.status));
  // gedreht wird nur, wenn wirklich gearbeitet wird (nicht beim Starten)
  const working = busy.filter((a) => a.status !== 'startet');
  const lastMsg = hub.messages[hub.messages.length - 1];
  const fresh = Boolean(lastMsg && !lastMsg.system && now - lastMsg.ts < REVEAL_MS + 150);
  const animating = working.length > 0 || fresh || hub.approvals.length > 0;
  const { frame, time } = useAnimation({ interval: animating ? 90 : 260 });
  const clock = now - hub.startedAt;
  const spin = SPINNER[frame % SPINNER.length]!;
  const phase = time / 5000;

  const channels = ['team', 'aufgaben', ...[...hub.agents.keys()].map((n) => `agent:${n}`)];
  if (!['hilfe', 'verbrauch', 'suche'].includes(ui.channel) && !channels.includes(ui.channel)) ui.channel = 'team';
  const agentName = ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined;
  const agent = agentName ? hub.agents.get(agentName) : undefined;

  const doAction = (a: UiAction) => {
    onAction(a);
    exit();
  };

  const tryAttach = () => {
    if (agent?.adapter?.attachable) doAction({ type: 'attach', agent: agent.name });
    else {
      ui.notice = 'F12 öffnet das Terminal einer Claude-Abo-Sitzung. Wähle sie links aus.';
      rerender();
    }
  };

  // F12 erkennt Ink nicht als Taste, deshalb auf die Rohdaten hören.
  useEffect(() => {
    const em = stdinCtx.internal_eventEmitter;
    if (!em) return;
    const onRaw = (data: string | Buffer) => {
      if (String(data).includes('\u001b[24~')) tryAttach();
    };
    em.on('input', onRaw);
    return () => {
      em.off('input', onRaw);
    };
  });

  const approval = !ui.approvalsDeferred && !ui.menu ? hub.approvals[0] : undefined;
  if (!hub.approvals.length) ui.approvalsDeferred = false;

  // ---------- Menü (Esc) ----------
  const open = (m?: Menu) => {
    ui.menu = m;
    rerender();
  };
  const close = () => open(undefined);
  /** Ergebnis einer Aktion als Hinweis unten zeigen */
  const report = (p: unknown, ok?: string) => {
    Promise.resolve(p)
      .then((r) => {
        ui.notice = typeof r === 'string' ? r : (ok ?? '');
      })
      .catch((e) => {
        ui.notice = errText(e);
      })
      .finally(rerender);
  };
  const pickAgent = (title: string, then: (name: string) => Menu | undefined): Menu | undefined => {
    if (agentName) return then(agentName);
    return {
      kind: 'liste',
      title,
      cursor: 0,
      back: mainMenu,
      items: [...hub.agents.values()].map((a) => ({ label: a.name, hint: a.label, run: () => open(then(a.name)) })),
    };
  };
  const renameMenu = (n: string): Menu => ({
    kind: 'eingabe',
    title: `${n} umbenennen`,
    label: 'Neuer Name',
    value: '',
    back: mainMenu,
    submit: (v) => {
      const done = hub.renameAgent(n, v);
      if (ui.channel === `agent:${n}`) ui.channel = `agent:${done}`;
      ui.notice = `${n} heißt jetzt ${done}.`;
      close();
    },
  });
  const modelMenu = (n: string): Menu => {
    const a = hub.agents.get(n)!;
    const cfg = hub.opts.config;
    let models: string[] = [];
    if (a.spec.kind === 'claude-abo' || a.spec.kind === 'claude-api') models = CLAUDE_MODELS;
    else if (a.spec.kind === 'openai') models = [cfg.anbieter[a.spec.provider ?? '']?.modell ?? ''].filter(Boolean);
    const items: MenuItem[] = models.map((m) => ({ label: m, hint: m === a.spec.model ? 'aktuell' : '', run: () => (close(), report(hub.setModel(n, m))) }));
    if (a.spec.kind !== 'openai') items.push({ label: 'Standard', hint: !a.spec.model ? 'aktuell' : '', run: () => (close(), report(hub.setModel(n, ''))) });
    items.push({
      label: 'Eigenes Modell eingeben …',
      run: () =>
        open({
          kind: 'eingabe',
          title: `Modell für ${n}`,
          label: 'Modellname',
          value: a.spec.model ?? '',
          back: () => modelMenu(n),
          submit: (v) => {
            close();
            report(hub.setModel(n, v));
          },
        }),
    });
    return { kind: 'liste', title: `Modell für ${n}`, cursor: 0, back: mainMenu, items };
  };
  const newSessionMenu = (): Menu => ({
    kind: 'liste',
    title: 'Neue Sitzung',
    cursor: 0,
    back: mainMenu,
    items: startRows(hub.opts.config).map((row) => ({
      label: row.label,
      run: () =>
        open({
          kind: 'eingabe',
          title: row.label,
          label: `Name (Enter = ${row.name})`,
          value: '',
          back: newSessionMenu,
          submit: (v) => {
            const name = v.trim() || row.name;
            const start = (rolle?: string) => {
              close();
              const spec = { ...parseSpec(hub, row.kind, name), ...(rolle ? { rolle } : {}) };
              report(
                hub.addAgent(spec).then((rec) => {
                  ui.channel = `agent:${rec.name}`;
                  return rec.status === 'fehler' ? `${rec.name}: ${rec.detail ?? 'Start fehlgeschlagen'}` : `${rec.name} (${rec.label}) gestartet.`;
                }),
              );
            };
            open({
              kind: 'liste',
              title: `Rolle für ${name}`,
              cursor: 0,
              back: newSessionMenu,
              items: [{ label: 'Ohne Rolle', hint: 'macht, was anfällt', run: () => start() }, ...ROLES.map((r) => ({ label: r.label, hint: r.about, run: () => start(r.id) }))],
            });
          },
        }),
    })),
  });
  const keyMenu = (): Menu => {
    const cfg = hub.opts.config;
    const providers = [{ id: 'anthropic', label: 'Claude (Anthropic)' }, ...Object.entries(cfg.anbieter).filter(([, p]) => p.apiKeyEnv).map(([id]) => ({ id, label: id }))];
    return {
      kind: 'liste',
      title: 'API-Schlüssel eintragen',
      cursor: 0,
      back: mainMenu,
      items: providers.map((p) => ({
        label: p.label,
        run: () =>
          open({
            kind: 'eingabe',
            title: `Schlüssel für ${p.label}`,
            label: 'Schlüssel (bleibt nur auf diesem Rechner)',
            value: '',
            secret: true,
            back: keyMenu,
            submit: (v) => {
              const env = keyEnvFor(cfg, p.id);
              if (!env || !v.trim()) throw new Error('Kein Schlüssel eingegeben.');
              saveKey(env, v.trim());
              void hub.balance?.refresh();
              ui.notice = `Schlüssel für ${p.label} gespeichert. Neue Sitzung über Esc → Neue Sitzung.`;
              close();
            },
          }),
      })),
    };
  };
  const roleMenu = (n: string): Menu => ({
    kind: 'liste',
    title: `Rolle für ${n}`,
    cursor: 0,
    back: mainMenu,
    items: ROLES.map((r) => ({ label: r.label, hint: r.about, run: () => (close(), report(hub.setRole(n, r.id))) })),
  });
  const searchMenu = (): Menu => ({
    kind: 'eingabe',
    title: 'Verlauf durchsuchen',
    label: 'Wonach suchen? (Wort, Name oder Satzteil)',
    value: ui.search ?? '',
    back: mainMenu,
    submit: (v) => {
      ui.search = v.trim();
      ui.channel = 'suche';
      close();
    },
  });
  function mainMenu(): Menu {
    const items: MenuItem[] = [
      { label: 'Startseite', hint: 'Einstellungen, MCP, Vault', run: () => (close(), doAction({ type: 'home' })) },
      { label: 'Neue Sitzung', hint: 'Claude, Codex, API, lokal', run: () => open(newSessionMenu()) },
    ];
    if (hub.agents.size) {
      items.push(
        { label: 'Umbenennen', hint: agentName ?? '', run: () => open(pickAgent('Umbenennen', renameMenu)) },
        { label: 'Modell wechseln', hint: agent ? agent.spec.model || 'Standard' : '', run: () => open(pickAgent('Modell wechseln', modelMenu)) },
        { label: 'Rolle ändern', hint: agent ? (roleById(agent.spec.rolle)?.label ?? 'ohne Rolle') : '', run: () => open(pickAgent('Rolle ändern', roleMenu)) },
        {
          label: 'Sitzung schließen',
          hint: agentName ?? '',
          run: () =>
            open(
              pickAgent('Sitzung schließen', (n) => {
                ui.channel = 'team';
                report(hub.removeAgent(n), `${n} geschlossen.`);
                return undefined;
              }),
            ),
        },
      );
    }
    if (ui.channel === 'team' || agent) {
      const ch = ui.channel;
      items.push({
        label: 'Chat leeren',
        hint: ch === 'team' ? 'Team-Chat' : `Privatchat ${agentName ?? ''}`,
        run: () => {
          const n = hub.clearChannel(ch);
          ui.seen[ch] = 0;
          ui.notice = n ? 'Chat geleert.' : 'Der Chat war schon leer.';
          close();
        },
      });
    }
    items.push(
      { label: 'Anbieter verbinden', hint: 'Abo, API, lokal', run: () => (close(), doAction({ type: 'einrichtung' })) },
      { label: 'API-Schlüssel eintragen', run: () => open(keyMenu()) },
      { label: 'Verlauf durchsuchen', hint: 'alle Chats', run: () => open(searchMenu()) },
      { label: 'Verbrauch', run: () => ((ui.channel = 'verbrauch'), close()) },
      { label: mouseEnabled() ? 'Maus ausschalten' : 'Maus einschalten', hint: 'zum Markieren von Text', run: () => (setMouseEnabled(!mouseEnabled()), close()) },
      { label: 'Hilfe', hint: 'alle Befehle', run: () => ((ui.channel = 'hilfe'), close()) },
      { label: 'Beenden', run: () => doAction({ type: 'quit' }) },
    );
    return { kind: 'liste', title: 'Menü', cursor: 0, items };
  }

  // Befehle können ein Menü anfordern (/model ohne Modell, /rename ohne Namen, /menu)
  if (ui.openMenu) {
    const want = ui.openMenu;
    ui.openMenu = undefined;
    if (want === 'modell' && agentName) ui.menu = modelMenu(agentName);
    else if (want === 'umbenennen' && agentName) ui.menu = renameMenu(agentName);
    else if (want === 'neu') ui.menu = newSessionMenu();
    else if (want === 'suche') ui.menu = searchMenu();
    else if (want === 'rolle' && agentName) ui.menu = roleMenu(agentName);
    else ui.menu = mainMenu();
  }

  /**
   * Auswahl per Zifferntaste. Bis 9 Einträge sofort; bei mehr ist auch eine zweistellige Nummer möglich
   * (z. B. 1 und dann 2 für den zwölften). Kann noch eine Ziffer folgen, springt die Markierung hin und
   * der Eintrag öffnet sich nach einem kurzen Moment, wenn keine weitere Ziffer kommt.
   */
  const digitTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const pickByNumber = (m: Extract<Menu, { kind: 'liste' }>, digit: string) => {
    if (digitTimer.current) clearTimeout(digitTimer.current);
    const now = Date.now();
    const typed = m.typed && m.typedAt && now - m.typedAt < 900 ? m.typed + digit : digit;
    const n = Number(typed);
    if (n < 1 || n > m.items.length) {
      m.typed = undefined;
      return rerender();
    }
    // kann noch eine Ziffer folgen (es gibt Einträge mit dieser Nummer als Anfang)?
    if (n * 10 <= m.items.length) {
      m.typed = typed;
      m.typedAt = now;
      m.cursor = n - 1;
      digitTimer.current = setTimeout(() => {
        if (ui.menu === m && m.typed === typed) {
          m.typed = undefined;
          runMenuItem(m, n - 1);
          rerender();
        }
      }, 900);
      return rerender();
    }
    m.typed = undefined;
    return runMenuItem(m, n - 1);
  };
  const runMenuItem = (m: Extract<Menu, { kind: 'liste' }>, i: number) => {
    const item = m.items[i];
    if (!item) return;
    m.cursor = i;
    try {
      report(item.run());
    } catch (e) {
      ui.notice = errText(e);
    }
    rerender();
  };
  const submitMenu = (m: Extract<Menu, { kind: 'eingabe' }>) => {
    try {
      report(m.submit(m.value));
    } catch (e) {
      ui.notice = errText(e);
    }
    rerender();
  };

  // ---------- Eingabe ----------
  // Frühere Eingaben dieses Projekts einmal laden (Strg+R, ↑)
  if (!historyLoaded.has(ui)) {
    historyLoaded.add(ui);
    if (!ui.history.length) ui.history = hub.opts.store.loadJson<string[]>('eingaben.json', []);
  }
  /** Text an der Schreibmarke einfügen; mit keepNewlines bleiben Zeilenumbrüche (Einfügen, Umschalt+Enter). */
  const insert = (text: string, keepNewlines = false) => {
    const clean = keepNewlines
      ? text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
      : text.replace(/\r?\n/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
    if (!clean) return;
    ui.draft = ui.draft.slice(0, ui.cursor) + clean + ui.draft.slice(ui.cursor);
    ui.cursor += clean.length;
  };

  const cycle = (dir: number) => {
    const idx = Math.max(0, channels.indexOf(ui.channel));
    ui.channel = channels[(idx + dir + channels.length) % channels.length]!;
    ui.logView = false;
  };

  const submit = () => {
    const line = ui.draft.trim();
    if (!line) return;
    if (!/^\/(schluessel|key)\b/i.test(line)) {
      if (ui.history[ui.history.length - 1] !== ui.draft) ui.history.push(ui.draft);
      hub.opts.store.saveJson('eingaben.json', ui.history.slice(-300));
    }
    ui.histIdx = -1;
    ui.draft = '';
    ui.cursor = 0;
    if (line.startsWith('/')) {
      runCommand(line, { hub, ui, action: doAction })
        .then((n) => {
          if (n) ui.notice = n;
          rerender();
        })
        .catch((e) => {
          ui.notice = errText(e);
          rerender();
        });
      return;
    }
    try {
      if (ui.channel === 'aufgaben') {
        const t = hub.tasks.add(hub.human, line);
        ui.notice = `Aufgabe #${t.id} angelegt.`;
      } else if (agentName) {
        hub.post(hub.human, agentName, line);
      } else {
        ui.channel = 'team';
        hub.post(hub.human, 'team', line);
        if (!hub.liveAgents().length) ui.notice = 'Noch keine Sitzung im Team. Esc → Neue Sitzung.';
      }
      ui.scroll[ui.channel] = 0;
    } catch (e) {
      ui.notice = errText(e);
    }
  };

  const sugg = !ui.menu && !approval ? suggest(ui.draft, agent?.spec.kind) : [];
  if (ui.suggestIdx >= sugg.length) ui.suggestIdx = 0;
  const complete = () => {
    const s = sugg[ui.suggestIdx];
    if (!s) return false;
    ui.draft = s.name + (s.args ? ' ' : '');
    ui.cursor = ui.draft.length;
    ui.suggestIdx = 0;
    return true;
  };

  usePaste((text) => {
    if (approval) return;
    if (ui.menu?.kind === 'eingabe') ui.menu.value += text.replace(/\r?\n/g, ' ').trim();
    else if (!ui.menu) insert(text, true);
    rerender();
  });

  /** Strg+R: die nächste ältere Eingabe suchen, die den Suchtext enthält */
  const findHistory = (q: string, from: number): number => {
    const needle = q.toLowerCase();
    for (let i = Math.min(from, ui.history.length) - 1; i >= 0; i--) if (ui.history[i]!.toLowerCase().includes(needle)) return i;
    return -1;
  };

  // Klickbare Stellen: werden beim Zeichnen gefüllt, der Maus-Empfänger liest sie
  const hits: Hit[] = [];
  const scrollBy = (n: number) => {
    const k = ui.channel + (ui.logView ? ':log' : '');
    ui.scroll[k] = Math.max(0, (ui.scroll[k] ?? 0) + n);
    rerender();
  };
  useMouse((e) => {
    if (e.kind === 'wheelUp') return scrollBy(3);
    if (e.kind === 'wheelDown') return scrollBy(-3);
    if (e.kind !== 'press' || e.button !== 0) return;
    const hit = hits.find((h) => h.y === e.y && e.x >= h.x0 && e.x < h.x1);
    if (hit) {
      ui.notice = '';
      hit.run();
      rerender();
    }
  });

  useInput((input, key) => {
    if (mouseEvents(input)) return;
    ui.notice = '';
    if (key.ctrl && input === 'c') {
      if (ui.menu) return close();
      if (ui.draft) {
        ui.draft = '';
        ui.cursor = 0;
      } else if (Date.now() - ui.lastCtrlC < 2000) {
        doAction({ type: 'quit' });
        return;
      } else {
        ui.lastCtrlC = Date.now();
        ui.notice = 'Noch einmal Strg+C zum Beenden.';
      }
      return rerender();
    }

    // Menü offen: es bekommt alle Tasten
    const m = ui.menu;
    if (m) {
      if (key.escape) return open(m.back?.());
      if (m.kind === 'liste') {
        if (key.upArrow) m.cursor = (m.cursor - 1 + m.items.length) % m.items.length;
        else if (key.downArrow || key.tab) m.cursor = (m.cursor + 1) % m.items.length;
        else if (key.return) return runMenuItem(m, m.cursor);
        else if (/^[0-9]$/.test(input)) return pickByNumber(m, input);
        return rerender();
      }
      if (key.return) return submitMenu(m);
      if (key.backspace || key.delete) m.value = m.value.slice(0, -1);
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) m.value += input.replace(/[\r\n]/g, '');
      return rerender();
    }

    // Strg+R: frühere Eingaben durchsuchen (wie in Claude Code und der Shell)
    const hs = ui.histSearch;
    if (hs) {
      if (key.escape) ui.histSearch = undefined;
      else if (key.ctrl && input === 'r') {
        const next = findHistory(hs.q, hs.idx);
        if (next >= 0) hs.idx = next;
      } else if (key.backspace || key.delete) {
        hs.q = hs.q.slice(0, -1);
        hs.idx = findHistory(hs.q, ui.history.length);
      } else if (key.return || key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
        // übernehmen (Enter schickt nicht gleich ab, damit man noch ändern kann)
        if (hs.idx >= 0) {
          ui.draft = ui.history[hs.idx]!;
          ui.cursor = ui.draft.length;
        }
        ui.histSearch = undefined;
      } else if (input && !key.ctrl && !key.meta) {
        hs.q += input;
        hs.idx = findHistory(hs.q, ui.history.length);
      }
      return rerender();
    }
    if (key.ctrl && input === 'r') {
      if (!ui.history.length) ui.notice = 'Noch keine früheren Eingaben.';
      else ui.histSearch = { q: '', idx: ui.history.length - 1 };
      return rerender();
    }

    if (key.pageUp || key.pageDown) return scrollBy((key.pageUp ? 1 : -1) * Math.max(3, R - 12));
    if (approval) {
      const ch = input.toLowerCase();
      if (key.escape) ui.approvalsDeferred = true;
      else if (ch === 'j' || ch === 'y') hub.resolveApproval(approval.id, 'ja');
      else if ((ch === 'i' || ch === 'a') && approval.allowAlways) hub.resolveApproval(approval.id, 'immer');
      else if (ch === 'n') hub.resolveApproval(approval.id, 'nein');
      return rerender();
    }
    if (sugg.length) {
      if (key.upArrow) {
        ui.suggestIdx = (ui.suggestIdx - 1 + sugg.length) % sugg.length;
        return rerender();
      }
      if (key.downArrow) {
        ui.suggestIdx = (ui.suggestIdx + 1) % sugg.length;
        return rerender();
      }
      if (key.tab) {
        complete();
        return rerender();
      }
      if (key.return) {
        const s = sugg[ui.suggestIdx]!;
        complete();
        if (!s.args) submit();
        return rerender();
      }
    }
    if (key.tab) {
      cycle(key.shift ? -1 : 1);
      return rerender();
    }
    if (key.meta && /^[1-9]$/.test(input)) {
      const target = channels[Number(input) - 1];
      if (target) ui.channel = target;
      return rerender();
    }
    if (key.ctrl && input === 'l') {
      if (agent) ui.logView = !ui.logView;
      return rerender();
    }
    if (key.ctrl && input === 't') return tryAttach();
    if (key.return) {
      // Zeilenumbruch: Umschalt+Enter (kommt als Alt+Enter an), Alt+Enter oder \ am Zeilenende
      if (key.meta || key.shift) {
        insert('\n', true);
        return rerender();
      }
      if (ui.cursor > 0 && ui.draft[ui.cursor - 1] === '\\') {
        ui.draft = ui.draft.slice(0, ui.cursor - 1) + ui.draft.slice(ui.cursor);
        ui.cursor--;
        insert('\n', true);
        return rerender();
      }
      submit();
      return rerender();
    }
    if (key.escape) {
      const working = agent ? (BUSY.includes(agent.status) ? [agent] : []) : ui.channel === 'team' ? busy : [];
      if (ui.draft) {
        ui.draft = '';
        ui.cursor = 0;
      } else if (working.length) {
        // wie in Claude Code: Esc bricht die laufende Runde ab
        report(Promise.all(working.map((a) => hub.interrupt(a.name))), `${working.map((a) => a.name).join(', ')} abgebrochen. Esc noch einmal: Menü.`);
      } else if (ui.channel === 'hilfe' || ui.channel === 'verbrauch' || ui.channel === 'suche') ui.channel = 'team';
      else ui.menu = mainMenu();
      return rerender();
    }
    if (key.backspace) {
      if (ui.cursor > 0) {
        ui.draft = ui.draft.slice(0, ui.cursor - 1) + ui.draft.slice(ui.cursor);
        ui.cursor--;
      }
      return rerender();
    }
    if (key.delete) {
      ui.draft = ui.draft.slice(0, ui.cursor) + ui.draft.slice(ui.cursor + 1);
      return rerender();
    }
    if (key.leftArrow) {
      ui.cursor = Math.max(0, ui.cursor - 1);
      return rerender();
    }
    if (key.rightArrow) {
      ui.cursor = Math.min(ui.draft.length, ui.cursor + 1);
      return rerender();
    }
    if (key.home || (key.ctrl && input === 'a')) {
      ui.cursor = 0;
      return rerender();
    }
    if (key.end || (key.ctrl && input === 'e')) {
      ui.cursor = ui.draft.length;
      return rerender();
    }
    if (key.ctrl && input === 'u') {
      ui.draft = ui.draft.slice(ui.cursor);
      ui.cursor = 0;
      return rerender();
    }
    if (key.ctrl && input === 'w' && !ui.draft && agentName) {
      // Strg+W schließt die Sitzung des aktuellen Kanals (zur Sicherheit zweimal drücken)
      if (closeAsked.name === agentName && Date.now() - closeAsked.at < 2500) {
        closeAsked.name = '';
        ui.channel = 'team';
        ui.notice = `${agentName} geschlossen.`;
        report(hub.removeAgent(agentName), `${agentName} geschlossen.`);
      } else {
        closeAsked.name = agentName;
        closeAsked.at = Date.now();
        ui.notice = `Noch einmal Strg+W schließt die Sitzung ${agentName}.`;
      }
      return rerender();
    }
    if (key.ctrl && input === 'w') {
      const left = ui.draft.slice(0, ui.cursor).replace(/\S+\s*$/, '');
      ui.draft = left + ui.draft.slice(ui.cursor);
      ui.cursor = left.length;
      return rerender();
    }
    if (key.upArrow || key.downArrow) {
      if (!ui.history.length) return;
      if (key.upArrow) ui.histIdx = ui.histIdx < 0 ? ui.history.length - 1 : Math.max(0, ui.histIdx - 1);
      else ui.histIdx = ui.histIdx < 0 ? -1 : ui.histIdx + 1;
      if (ui.histIdx >= ui.history.length) ui.histIdx = -1;
      ui.draft = ui.histIdx < 0 ? '' : ui.history[ui.histIdx]!;
      ui.cursor = ui.draft.length;
      return rerender();
    }
    if (key.ctrl || key.meta) return;
    if (input) {
      // Schnell getippt kommen Text und Enter manchmal als ein Stück an: dann auch abschicken
      const glued = input.length > 1 && /[\r\n]$/.test(input) && !/[\r\n]/.test(input.slice(0, -1));
      insert(glued ? input.slice(0, -1) : input);
      ui.suggestIdx = 0;
      if (glued && ui.cursor > 0 && ui.draft[ui.cursor - 1] === '\\') {
        // „\“ am Zeilenende + Enter: neue Zeile statt abschicken
        ui.draft = ui.draft.slice(0, ui.cursor - 1) + ui.draft.slice(ui.cursor);
        ui.cursor--;
        insert('\n', true);
      } else if (glued) submit();
      rerender();
    }
  });

  if (C < 50 || R < 14) {
    return (
      <Box width={C} height={R} alignItems="center" justifyContent="center" flexDirection="column">
        <Row spans={gradientSpans('Harnes', 0, { bold: true })} />
        <Text color={T.warn}>Fenster zu klein – bitte größer ziehen.</Text>
      </Box>
    );
  }

  // ---------- Maße ----------
  // Aufbau wie eine App: Kopfzeile, links die Seitenleiste mit allen Chats, rechts der Chat
  // mit Titel, Verlauf und Eingabefeld, ganz unten Tasten und Verbrauch.
  const SW = C >= 100 ? 28 : C >= 76 ? 24 : 0;
  const x0 = SW ? SW + 1 : 0;
  const MW = C - x0;
  const innerW = MW - 2;
  const bodyH = R - 2;
  let approvalBody: string[] = [];
  if (approval) approvalBody = [...wrapText(approval.title, MW - 6).slice(0, 2), ...wrapText(approval.detail, MW - 6).slice(0, 5)];
  const approvalH = approval ? approvalBody.length + 4 : 0;
  const activityH = busy.length ? 1 : 0;
  const suggH = sugg.length;
  // Mehrzeilige Eingabe (Umschalt+Enter): das Eingabefeld wächst bis 6 Zeilen
  const draftLines = ui.draft.split('\n');
  const inputRows = ui.histSearch ? 1 : Math.min(6, draftLines.length);
  const inputH = inputRows + 2;
  const contentH = Math.max(1, bodyH - 3 - activityH - suggH - approvalH - inputH);
  const contentY = 4; // Bildschirmzeile der ersten Chatzeile

  // ---------- Inhalt des Hauptbereichs ----------
  let title: Span[];
  let subtitle: Span[];
  let lines: Line[];
  let backdrop: SceneName | undefined;
  let welcome: Line[] | undefined;
  let firstTs: number | undefined;
  const k = (text: string): Span => ({ text, color: T.violet, bold: true });
  const d = (text: string): Span => ({ text, color: T.muted });
  const scrollKey = ui.channel + (ui.logView ? ':log' : '');
  const total = hub.totalUsage();
  if (ui.channel === 'suche') {
    const found = hub.search(ui.search ?? '');
    title = [{ text: 'Suche', bold: true, color: T.text }, { text: `   „${ui.search ?? ''}“`, color: T.violet }];
    subtitle = [d(`${found.length} Treffer in allen Chats · neueste zuerst · Esc zurück · Esc → Verlauf durchsuchen für eine neue Suche`)];
    lines = searchLines(hub, found, ui.search ?? '', innerW);
  } else if (ui.channel === 'hilfe') {
    title = [{ text: 'Hilfe', bold: true, color: T.text }];
    subtitle = [d('Alle Befehle und Tasten. Esc führt zurück.')];
    lines = helpLines(hub.humanLabel);
  } else if (ui.channel === 'verbrauch') {
    title = [{ text: 'Verbrauch', bold: true, color: T.text }];
    subtitle = [d(`${fmtTokens(total.inputTokens + total.outputTokens)} Tokens neu · ${total.turns} Runden · läuft seit ${fmtDuration(now - hub.startedAt)} · Esc zurück`)];
    lines = usageLines(hub, innerW, -phase);
  } else if (ui.channel === 'aufgaben') {
    const openT = hub.tasks.tasks.filter((t) => t.status !== 'erledigt').length;
    title = [{ text: 'Aufgaben', bold: true, color: T.text }];
    subtitle = [d(`${openT} offen · ${hub.tasks.tasks.length} gesamt · die Sitzungen teilen sie sich selbst auf`)];
    lines = taskLines(hub, innerW);
    if (!hub.tasks.tasks.length) {
      backdrop = 'sonnensystem';
      welcome = [[d('Noch keine Aufgaben auf dem Brett.')], [], [d('Einfach eintippen und Enter – oder '), k('/aufgabe <Titel>'), d(' im Teamchat.')]];
      lines = [];
    }
  } else if (agent) {
    const used = agent.usage.inputTokens + agent.usage.outputTokens;
    title = [
      { text: '● ', color: colorOf(hub, agent.name), bold: true },
      { text: agent.name, bold: true, color: T.text },
      { text: `   ${statusWord(agent.status)}`, color: BUSY.includes(agent.status) ? T.pink : T.faint },
    ];
    subtitle = [d(`${agent.label}${agent.spec.model ? ` · ${agent.spec.model}` : ''}${used ? ` · ${fmtTokens(used)} Tokens` : ''}${ui.logView ? ' · Arbeitsprotokoll' : ' · Privatchat'}`)];
    if (ui.logView) lines = logLines(agent, innerW);
    else {
      const msgs = hub.channelMessages(ui.channel);
      lines = chatLines(hub, msgs, innerW, now);
      backdrop = agentScene([...hub.agents.keys()].indexOf(agent.name));
      firstTs = msgs.find((m) => !m.system)?.ts;
      if (firstTs === undefined) {
        welcome = [[d(`Schreib ${agent.name} hier eine private Nachricht.`)], [k('Esc'), d(' Modell wechseln, umbenennen, schließen')]];
        if (agent.adapter?.attachable) welcome.push([k('F12'), d(' öffnet das Terminal dieser Sitzung (Claude Code)')]);
      }
      if (agent.status === 'fehler' && agent.detail) {
        lines.push([], ...wrapText(`Fehler: ${agent.detail}`, innerW).map((l) => [{ text: l, color: T.bad }]));
      }
    }
  } else {
    title = [{ text: 'Team', bold: true, color: T.text }];
    subtitle = [d(`${hub.liveAgents().length} Sitzung(en) · alle lesen mit · @name spricht eine Sitzung direkt an`)];
    const msgs = hub.channelMessages('team');
    lines = chatLines(hub, msgs, innerW, now);
    backdrop = 'pegasus';
    firstTs = msgs.find((m) => !m.system)?.ts;
    if (firstTs === undefined) {
      welcome = [
        gradientSpans('Willkommen im Team.', phase, { bold: true }),
        [],
        [d('Hier schreiben – alle Sitzungen lesen mit.')],
        [k('Esc'), d(' Menü: neue Sitzung, Modell, Anbieter   '), k('/'), d(' Befehle')],
      ];
    }
  }

  const maxScroll = Math.max(0, lines.length - contentH);
  const scroll = Math.min(ui.scroll[scrollKey] ?? 0, maxScroll);
  ui.scroll[scrollKey] = scroll;
  const start = Math.max(0, lines.length - contentH - scroll);
  let visible = lines.slice(start, start + contentH);
  if (scroll > 0) subtitle = [...subtitle, { text: `   ↓ ${scroll} Zeilen weiter unten`, color: T.warn }];
  if (welcome) {
    // jede Zeile für sich mittig
    const block = welcome.flatMap((l) => centered([l], spansW(l), innerW));
    if (backdrop && innerW >= 40 && contentH >= welcome.length + 6) {
      // Bild füllt den ganzen Chat; Meldungen stehen oben, die Begrüßung im unteren Drittel
      const top = Math.max(visible.length + 1, Math.min(contentH - welcome.length - 2, Math.round(contentH * 0.64 - welcome.length / 2)));
      visible = overlay(overlay(scene(backdrop, innerW, contentH, clock), block, top, innerW, { box: true }), visible, 0, innerW);
    } else visible = [...visible, [], ...block];
  } else if (backdrop && firstTs !== undefined && now - firstTs < FADE_MS && scroll === 0 && innerW >= 40) {
    visible = overlay(dissolve(scene(backdrop, innerW, contentH, clock), (now - firstTs) / FADE_MS, innerW), visible, 0, innerW);
  }

  // ---------- Menü über dem Chat ----------
  if (ui.menu) {
    const m = ui.menu;
    const w = Math.min(58, innerW - 2);
    const left = Math.max(0, Math.floor((innerW - w) / 2));
    const pad: Span = { text: ' '.repeat(left) };
    const edge = T.purple;
    const box: Line[] = [];
    box.push([pad, { text: '╭─ ', color: edge }, { text: m.title, color: T.text, bold: true }, { text: ` ${'─'.repeat(Math.max(0, w - textWidth(m.title) - 5))}╮`, color: edge }]);
    const row = (spans: Span[], bg?: string): Line => {
      const fill = Math.max(0, w - 4 - spansW(spans));
      return [pad, { text: '│ ', color: edge }, ...spans.map((s) => ({ ...s, bg })), { text: ' '.repeat(fill), bg }, { text: ' │', color: edge }];
    };
    const menuTop = 1;
    if (m.kind === 'liste') {
      m.items.forEach((it, i) => {
        const at = i === m.cursor;
        const bg = at ? T.night : undefined;
        const numW = String(m.items.length).length;
        const num = `${String(i + 1).padStart(numW)} `;
        const hint = it.hint ? truncate(it.hint, Math.max(4, w - 10 - textWidth(it.label))) : '';
        const label: Span[] = [
          { text: at ? '❯ ' : '  ', color: T.pink, bold: true },
          { text: num, color: T.faint },
          { text: it.label, color: at ? T.text : T.muted, bold: at },
        ];
        const gap = Math.max(1, w - 4 - spansW(label) - textWidth(hint));
        box.push(row([...label, { text: ' '.repeat(gap) }, { text: hint, color: T.faint }], bg));
        hits.push({ y: contentY + menuTop + 1 + i, x0: x0 + 1 + left, x1: x0 + 1 + left + w, run: () => runMenuItem(m, i) });
      });
    } else {
      const shown = m.secret && m.value ? `${m.value.slice(0, 6)}${'•'.repeat(Math.min(28, Math.max(0, m.value.length - 6)))}` : m.value;
      box.push(row([{ text: m.label, color: T.muted }]));
      box.push(row([{ text: '❯ ', color: T.pink, bold: true }, { text: truncate(shown, w - 8), color: T.text }, { text: ' ', bg: T.violet }]));
    }
    box.push([pad, { text: `╰${'─'.repeat(w - 2)}╯`, color: edge }]);
    const help = m.kind === 'liste' ? '↑↓ wählen · Enter oder Klick · Esc zurück' : 'Enter bestätigen · Esc zurück';
    box.push([{ text: ' '.repeat(left + 2) }, { text: help, color: T.faint }]);
    const base = visible.length < contentH ? [...visible, ...Array.from({ length: contentH - visible.length }, () => [] as Line)] : visible;
    visible = overlay(dimLines(base), box, menuTop, innerW);
  }

  // gelesen-Stand des aktiven Kanals
  const countOf = (ch: string) => hub.channelMessages(ch).filter((m) => !m.system).length;
  if (ui.channel === 'team' || agent) ui.seen[ui.channel] = countOf(ui.channel);
  const unread = (ch: string) => Math.max(0, countOf(ch) - (ui.seen[ch] ?? 0));

  // Wer arbeitet gerade? (unterste Zeile im Chat)
  const activity: Span[] = [];
  for (const a of busy) {
    if (activity.length) activity.push({ text: '   ', color: T.night });
    const word = a.status === 'freigabe' ? 'braucht Freigabe' : a.status === 'startet' ? 'startet' : 'arbeitet';
    activity.push(
      { text: `${a.status === 'freigabe' ? '!' : a.status === 'startet' ? '◌' : spin} `, color: a.status === 'arbeitet' ? T.pink : T.warn, bold: true },
      { text: a.name, color: colorOf(hub, a.name), bold: true },
      { text: ` ${word} ${fmtDuration(now - a.since)}`, color: T.faint },
    );
  }

  // ---------- Seitenleiste ----------
  const side: Line[] = [];
  if (SW) {
    const w = SW - 4;
    const sideY = 2; // Bildschirmzeile der ersten Zeile in der Leiste (Kopfzeile + Rahmen)
    const item = (icon: Span, label: Span[], badge: string, active: boolean, run: () => void, sub?: string) => {
      hits.push({ y: sideY + side.length, x0: 0, x1: SW, run });
      const bg = active ? T.night : undefined;
      const lab = label.map((s) => ({ ...s, bg, bold: active || s.bold, color: active && s.color === T.muted ? T.text : s.color }));
      const used = textWidth(icon.text) + 1 + spansW(lab) + (badge ? textWidth(badge) + 2 : 0);
      side.push([
        { ...icon, bg },
        { text: ' ', bg },
        ...lab,
        { text: ' '.repeat(Math.max(0, w - used)), bg },
        ...(badge ? [{ text: ` ${badge} `, bg: T.pink, color: '#17122B', bold: true }] : []),
      ]);
      if (sub !== undefined) {
        hits.push({ y: sideY + side.length, x0: 0, x1: SW, run });
        side.push([{ text: `  ${truncate(sub, w - 2)}`.padEnd(w), color: T.faint, bg }]);
      }
    };
    side.push([{ text: '◆ ', color: T.pink, bold: true }, ...gradientSpans('HARNES', phase, { bold: true })], []);
    const go = (ch: string) => () => {
      ui.channel = ch;
      ui.logView = false;
      ui.menu = undefined;
    };
    const teamUnread = unread('team');
    item({ text: '#', color: T.violet, bold: true }, [{ text: 'Team', color: T.muted }], teamUnread ? String(teamUnread) : '', ui.channel === 'team', go('team'));
    const openTasks = hub.tasks.tasks.filter((t) => t.status !== 'erledigt').length;
    item({ text: '≡', color: T.violet, bold: true }, [{ text: 'Aufgaben', color: T.muted }], openTasks ? String(openTasks) : '', ui.channel === 'aufgaben', go('aufgaben'));
    side.push([], [{ text: 'Sitzungen', color: T.faint }]);
    for (const a of hub.agents.values()) {
      const dot = statusDot(a.status);
      const turning = a.status === 'arbeitet';
      const n = unread(`agent:${a.name}`);
      const used = a.usage.inputTokens + a.usage.outputTokens;
      item(
        { text: turning ? spin : dot.ch, color: turning ? T.pink : dot.color, bold: true },
        [{ text: truncate(a.name, w - 8), color: colorOf(hub, a.name) }],
        n ? String(n) : '',
        ui.channel === `agent:${a.name}`,
        go(`agent:${a.name}`),
        `${roleById(a.spec.rolle) ? `${roleById(a.spec.rolle)!.label} · ` : ''}${a.spec.model || a.label}${used ? ` · ${fmtTokens(used)}` : ''}`,
      );
    }
    item({ text: '+', color: T.faint, bold: true }, [{ text: 'Neue Sitzung', color: T.faint }], '', false, () => {
      ui.menu = newSessionMenu();
    });
    // Rest der Leiste: eine kleine Galaxie, die sich langsam dreht
    const rest = bodyH - 2 - side.length;
    if (rest >= 7) {
      const artH = Math.min(rest - 1, 9);
      for (let i = 0; i < rest - artH; i++) side.push([]);
      side.push(...galaxy(w, artH, clock));
    }
  }

  // ---------- Eingabezeile ----------
  const inputW = MW - 6;
  // Zeile und Spalte der Schreibmarke
  let curLine = 0;
  let curCol = ui.cursor;
  while (curLine < draftLines.length - 1 && curCol > draftLines[curLine]!.length) {
    curCol -= draftLines[curLine]!.length + 1;
    curLine++;
  }
  const firstRow = Math.max(0, Math.min(curLine - inputRows + 1, draftLines.length - inputRows));
  const showCursor = !approval && !ui.menu;
  const inputLines: Span[][] = [];
  for (let r = firstRow; r < firstRow + inputRows; r++) {
    const text = draftLines[r] ?? '';
    const lead: Span = { text: r === 0 ? '❯ ' : '  ', color: T.pink, bold: true };
    if (r !== curLine) {
      inputLines.push([lead, { text: truncate(text, inputW - 1) || ' ', color: T.text }]);
      continue;
    }
    let shown = text;
    let cur = curCol;
    if (shown.length > inputW - 1) {
      const from = Math.max(0, Math.min(cur - Math.floor(inputW / 2), shown.length - inputW + 1));
      shown = shown.slice(from, from + inputW - 1);
      cur -= from;
    }
    inputLines.push([
      lead,
      { text: shown.slice(0, cur), color: T.text },
      showCursor ? { text: shown.slice(cur, cur + 1) || ' ', color: '#17122B', bg: T.text } : { text: shown.slice(cur, cur + 1), color: T.text },
      { text: shown.slice(cur + 1), color: T.text },
    ]);
  }
  if (ui.histSearch) {
    const hs = ui.histSearch;
    const hit = hs.idx >= 0 ? (ui.history[hs.idx] ?? '').replace(/\n/g, ' ⏎ ') : 'kein Treffer';
    inputLines.splice(0, inputLines.length, [
      { text: '↺ ', color: T.pink, bold: true },
      { text: 'Frühere Eingaben: ', color: T.faint },
      { text: hs.q, color: T.text, bg: T.night },
      { text: ' ', bg: T.violet },
      { text: `   ${truncate(hit, Math.max(10, inputW - 30 - hs.q.length))}`, color: hs.idx >= 0 ? T.violet : T.faint },
    ]);
  } else if (ui.draft === '' && showCursor) {
    inputLines.splice(0, inputLines.length, [{ text: '❯ ', color: T.pink, bold: true }, { text: ' ', bg: T.text }, { text: '' }]);
  }
  const placeholder =
    ui.channel === 'aufgaben' ? 'Neue Aufgabe eintippen …' : agentName ? `Privat an ${agentName} …   (Esc Menü · / Befehle)` : 'Nachricht an das Team …   (Esc Menü · / Befehle)';
  const inputColor = ui.menu || approval ? T.line : animating ? gradient([T.deep, T.purple, T.magenta], time / 2400) : T.deep;

  // Vorschläge beim Tippen von „/“
  const suggLines: Line[] = sugg.map((s, i) => {
    const sel = i === ui.suggestIdx;
    const bg = sel ? T.night : undefined;
    hits.push({ y: R - 1 - inputH - approvalH - suggH + i, x0, x1: C, run: () => ((ui.suggestIdx = i), complete()) });
    return [
      { text: sel ? ' ❯ ' : '   ', color: T.pink, bold: true, bg },
      { text: s.name, color: T.violet, bold: true, bg },
      { text: s.args ? ` ${s.args}` : '', color: T.muted, bg },
      { text: `   ${s.desc}`, color: T.faint, bg },
    ];
  });

  // ---------- Kopf- und Fußzeile ----------
  const right: Span[] = [];
  const addRight = (s: Span) => {
    if (right.length) right.push({ text: ' · ', color: T.night });
    right.push(s);
  };
  if (hub.paused) addRight({ text: '‖ pausiert', color: T.warn, bold: true });
  if (hub.heldCount) addRight({ text: `${hub.heldCount} angehalten`, color: T.warn });
  if (hub.approvals.length && ui.approvalsDeferred) addRight({ text: `${hub.approvals.length} Freigabe(n) offen – /freigaben`, color: T.warn });
  // Guthaben der API-Anbieter (nur wo abfragbar)
  for (const b of hub.balance?.balances ?? []) {
    if (b.betrag === undefined) continue;
    addRight({ text: `${providerLabel(b.anbieter)} ${fmtMoney(b)}`, color: b.betrag < 1 ? T.warn : T.ok });
  }
  const usedAll = total.inputTokens + total.outputTokens;
  addRight({ text: `Σ ${fmtTokens(usedAll)} Tokens`, color: usedAll ? T.violet : T.faint, bold: Boolean(usedAll) });
  if (total.turns) addRight({ text: `${total.turns} Runden`, color: T.faint });
  if (total.costUsd > 0) addRight({ text: `$${total.costUsd.toFixed(2)}`, color: T.warn });
  right.push({ text: ' ' });
  const rightW = spansW(right);
  // unten links: Projektordner; ein Klick öffnet „Projekt wechseln“
  const pathText = truncate(hub.opts.cwd, Math.max(10, C - rightW - 6));
  const hints: Span[] = [{ text: ' › ', color: T.violet, bold: true }, { text: pathText, color: T.faint }];
  hits.push({ y: R - 1, x0: 0, x1: spansW(hints), run: () => doAction({ type: 'home', view: 'projekte' }) });
  hits.push({ y: R - 1, x0: C - rightW, x1: C, run: () => ((ui.channel = 'verbrauch'), (ui.menu = undefined)) });
  const headRight: Span[] = working.length
    ? [
        { text: `${spin} `, color: T.pink, bold: true },
        { text: `${working.length} aktiv`, color: T.pink },
        { text: `  ${fmtDuration(now - hub.startedAt)} `, color: T.faint },
      ]
    : [{ text: `${fmtDuration(now - hub.startedAt)} `, color: T.faint }];

  return (
    <Box flexDirection="column" width={C} height={R}>
      <Box height={1} justifyContent="space-between">
        <Text> </Text>
        <Row spans={headRight} />
      </Box>

      <Box height={bodyH} flexDirection="row">
        {SW > 0 && (
          <Box width={SW} height={bodyH} borderStyle="round" borderColor={T.line} paddingX={1} flexDirection="column">
            <Lines lines={side} height={bodyH - 2} />
          </Box>
        )}
        {SW > 0 && <Box width={1} />}
        <Box width={MW} height={bodyH} flexDirection="column">
          <Box paddingX={1} flexDirection="column">
            <Row spans={title} />
            <Row spans={subtitle} />
            <Text> </Text>
            <Lines lines={visible} height={contentH} />
            {activityH > 0 && <Row spans={activity} />}
          </Box>
          {suggH > 0 && <Lines lines={suggLines} height={suggH} />}
          {approval && (
            <Box height={approvalH} borderStyle="round" borderColor={T.warn} paddingX={1} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={T.warn} bold>
                  ! Freigabe für {approval.agent}
                </Text>
                <Text color={T.muted}>{hub.approvals.length > 1 ? `  (1 von ${hub.approvals.length})` : ''}</Text>
              </Text>
              {approvalBody.map((l, i) => (
                <Text key={i} wrap="truncate-end" color={T.text}>
                  {l || ' '}
                </Text>
              ))}
              <Text wrap="truncate-end">
                <Text color={T.ok} bold>
                  [j] Ja
                </Text>
                {approval.allowAlways && <Text color={T.cyan}>{'   [i] Immer erlauben'}</Text>}
                <Text color={T.bad}>{'   [n] Nein'}</Text>
                <Text color={T.faint}>{'   [Esc] später'}</Text>
              </Text>
            </Box>
          )}
          <Box height={inputH} borderStyle="round" borderColor={inputColor} paddingX={1} flexDirection="column">
            {ui.draft === '' && showCursor && !ui.histSearch ? (
              <Row spans={[{ text: '❯ ', color: T.pink, bold: true }, { text: ' ', bg: T.text }, { text: placeholder, color: T.faint }]} />
            ) : (
              <Lines lines={inputLines} height={inputRows} />
            )}
          </Box>
        </Box>
      </Box>

      <Box height={1} justifyContent="space-between">
        {ui.notice ? (
          <Text wrap="truncate-end" color={T.warn}>
            {` ${ui.notice}`}
          </Text>
        ) : (
          <Row spans={hints} />
        )}
        <Row spans={right} />
      </Box>
    </Box>
  );
}

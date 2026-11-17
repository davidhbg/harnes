import { Box, Text, useAnimation, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useEffect, useReducer, useState } from 'react';
import type { AuthInfo } from '../auth.js';
import { keyEnvFor, saveKey, updateConfig, type Config } from '../config.js';
import { errText, wrapText } from '../util.js';
import { brailleImage, galaxy, muse } from './art.js';
import { ownImages } from './eigene-bilder.js';
import { mouseEvents, useMouse } from './mouse.js';
import { Lines, Row } from './Spans.js';
import { checkRow, type StartRow } from './Start.js';
import { T, bigLogo, gradientSpans, logoLine, type Line, type Span } from './theme.js';

/**
 * Einrichtung beim ersten Start: ein Schritt nach dem anderen statt aller Anbieter auf einmal.
 * 1. Willkommen  2. Womit arbeitest du?  3. je Zugang verbinden  4. Fertig.
 * Danach geht es bei jedem Start direkt in die Chats.
 */

export interface SetupState {
  step: 'willkommen' | 'auswahl' | 'verbinden' | 'fertig';
  /** gewählte Zugänge (IDs aus startRows) */
  chosen: string[];
  /** welcher Zugang gerade verbunden wird */
  idx: number;
  /** Markierung in der Auswahl */
  cursor: number;
  /** eigener Name (erster Schritt); undefined = noch nicht angefasst */
  name?: string;
}

export type SetupAction = { type: 'login'; row: string } | { type: 'done'; rows: string[]; nameChanged?: boolean } | { type: 'quit' };

export function createSetupState(): SetupState {
  return { step: 'willkommen', chosen: ['claude'], idx: 0, cursor: 0 };
}

const ABOUT: Record<string, string> = {
  claude: 'Dein Claude-Abo (Pro, Max, Team). Läuft als echtes Claude Code.',
  codex: 'Dein ChatGPT-Konto. Läuft als Codex.',
  'claude-api': 'Claude mit API-Schlüssel, Abrechnung pro Nutzung.',
  deepseek: 'DeepSeek mit API-Schlüssel, günstig, Abrechnung pro Nutzung.',
  openrouter: 'Viele Modelle über einen API-Schlüssel.',
  ollama: 'Modelle auf deinem Rechner, kostenlos. Für kleine Aufgaben.',
  lmstudio: 'Modelle auf deinem Rechner, kostenlos. Für kleine Aufgaben.',
  test: 'Übungs-Sitzung ohne KI. Kostet nichts.',
};

const HOW: Record<StartRow['login'], string> = {
  claude: 'Die Anmeldung läuft über das offizielle Claude-Programm in deinem Browser. Harnes sieht deine Zugangsdaten nie.',
  codex: 'Die Anmeldung läuft über das offizielle Codex-Programm in deinem Browser. Harnes sieht deine Zugangsdaten nie.',
  key: 'Füge deinen API-Schlüssel ein. Er bleibt nur auf diesem Rechner (im Ordner .remoteharnes in deinem Benutzerordner).',
  lokal: 'Starte das Programm auf deinem Rechner. Harnes findet es von selbst.',
  keine: 'Hier gibt es nichts zu verbinden.',
};

const MARK: Record<AuthInfo['state'], { ch: string; color: string }> = {
  pruefe: { ch: '◌', color: T.warn },
  ok: { ch: '●', color: T.ok },
  fehlt: { ch: '○', color: T.faint },
  abgelaufen: { ch: '!', color: T.warn },
  fehler: { ch: '✕', color: T.bad },
};

interface Props {
  config: Config;
  rows: StartRow[];
  status: Record<string, AuthInfo>;
  state: SetupState;
  /** nach einer Anmeldung diese Zugänge neu prüfen */
  recheck: string[];
  notice?: string;
  onAction: (a: SetupAction) => void;
}

export function Setup({ config, rows, status, state, recheck, notice: initialNotice, onAction }: Props) {
  const { exit } = useApp();
  const { columns: C, rows: R } = useWindowSize();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [notice, setNotice] = useState(initialNotice ?? '');
  const [keyValue, setKeyValue] = useState('');
  const { time } = useAnimation({ interval: state.step === 'willkommen' ? 70 : 140 });

  const check = (row: StartRow, verify = true) => {
    status[row.id] = { state: 'pruefe', text: 'wird geprüft …' };
    rerender();
    checkRow(config, row, verify)
      .then((s) => (status[row.id] = s))
      .catch((e) => (status[row.id] = { state: 'fehler', text: errText(e) }))
      .finally(rerender);
  };

  useEffect(() => {
    for (const row of rows) if (!status[row.id] || recheck.includes(row.id)) check(row, false);
  }, []);

  const doAction = (a: SetupAction) => {
    onAction(a);
    exit();
  };

  const choices = rows;
  const chosenRows = rows.filter((r) => state.chosen.includes(r.id));
  const current = state.step === 'verbinden' ? chosenRows[state.idx] : undefined;
  const st = (r: StartRow): AuthInfo => status[r.id] ?? { state: 'pruefe', text: 'wird geprüft …' };

  let nameChanged = false;
  const go = (step: SetupState['step'], idx = 0) => {
    state.step = step;
    state.idx = idx;
    setKeyValue('');
    setNotice('');
    rerender();
  };
  const next = () => {
    if (state.step === 'willkommen') {
      const name = (state.name ?? config.benutzer).trim();
      if (!name) return setNotice('Wie sollen dich die Sitzungen nennen?');
      if (name !== config.benutzer) {
        config.benutzer = name;
        updateConfig((c) => {
          c.benutzer = name;
        });
        nameChanged = true;
      }
      return go('auswahl');
    }
    if (state.step === 'auswahl') {
      if (!state.chosen.length) return setNotice('Wähle mindestens einen Zugang (Leertaste).');
      return go('verbinden', 0);
    }
    if (state.step === 'verbinden') return state.idx + 1 < chosenRows.length ? go('verbinden', state.idx + 1) : go('fertig');
    const ready = chosenRows.filter((r) => st(r).state === 'ok').map((r) => r.id);
    doAction({ type: 'done', rows: ready, nameChanged });
  };
  const back = () => {
    if (state.step === 'auswahl') return go('willkommen');
    if (state.step === 'verbinden') return state.idx > 0 ? go('verbinden', state.idx - 1) : go('auswahl');
    if (state.step === 'fertig') return go('verbinden', Math.max(0, chosenRows.length - 1));
  };
  const toggle = (id: string) => {
    state.chosen = state.chosen.includes(id) ? state.chosen.filter((x) => x !== id) : [...state.chosen, id];
    rerender();
  };

  /** Enter im Verbinden-Schritt: anmelden, Schlüssel speichern oder weiter */
  const connect = () => {
    if (!current) return;
    const s = st(current);
    if (current.login === 'key' && keyValue.trim()) {
      const env = keyEnvFor(config, current.provider!);
      if (!env) return setNotice('Für diesen Anbieter ist kein Schlüssel vorgesehen.');
      saveKey(env, keyValue.trim());
      setKeyValue('');
      setNotice('Schlüssel gespeichert, wird geprüft …');
      return check(current, true);
    }
    if (s.state === 'ok') return next();
    if (current.login === 'claude' || current.login === 'codex') return doAction({ type: 'login', row: current.id });
    if (current.login === 'lokal') return check(current, false);
    if (current.login === 'key') return setNotice('Bitte den Schlüssel einfügen (Strg+V oder Rechtsklick) und Enter drücken.');
  };

  usePaste((text) => {
    if (current?.login === 'key') setKeyValue((v) => v + text.replace(/\s+/g, ''));
  });

  // Klickbare Stellen: Zeile -> Aktion (wird beim Zeichnen gefüllt)
  const hits: Record<number, () => void> = {};
  useMouse((e) => {
    if (e.kind === 'press' && hits[e.y]) hits[e.y]!();
  });

  useInput((input, key) => {
    if (mouseEvents(input)) return;
    if (key.ctrl && input === 'c') return doAction({ type: 'quit' });
    if (key.escape) return back();
    if (current?.login === 'key' && !key.return) {
      if (key.backspace || key.delete) return setKeyValue((v) => v.slice(0, -1));
      if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) return setKeyValue((v) => v + input.replace(/\s+/g, ''));
    }
    if (state.step === 'auswahl') {
      if (key.upArrow) state.cursor = (state.cursor - 1 + choices.length) % choices.length;
      else if (key.downArrow || key.tab) state.cursor = (state.cursor + 1) % choices.length;
      else if (input === ' ') toggle(choices[state.cursor]!.id);
      else if (key.return) return next();
      return rerender();
    }
    if (state.step === 'verbinden') {
      if (key.return) return connect();
      const ch = input.toLowerCase();
      if (ch === 's') return next();
      if (ch === 'r' && current) return check(current, true);
      return;
    }
    if (key.return) return next();
    if (state.step === 'willkommen') {
      // Name tippen (Q beendet nicht mehr, sonst ließe sich kein Q schreiben; Strg+C beendet)
      const cur = state.name ?? config.benutzer;
      if (key.backspace || key.delete) state.name = cur.slice(0, -1);
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && cur.length < 30) state.name = cur + input.replace(/[\r\n]/g, '');
      return rerender();
    }
  });

  // ---------- Zeichnen ----------
  // Breites Fenster: Bild rechts daneben
  const sideW = C >= 118 ? Math.min(64, C - 84) : 0;
  const LC = C - sideW;
  const W = Math.min(76, LC - 4);
  const inner = W - 4;
  const steps = ['willkommen', 'auswahl', 'verbinden', 'fertig'] as const;
  const stepNo = steps.indexOf(state.step);
  const dots: Span[] = [];
  steps.forEach((s, i) => {
    if (i) dots.push({ text: ' ' });
    dots.push({ text: i < stepNo ? '●' : i === stepNo ? '◆' : '○', color: i <= stepNo ? T.violet : T.faint, bold: i === stepNo });
  });
  const k = (t: string): Span => ({ text: t, color: T.violet, bold: true });
  const d = (t: string): Span => ({ text: t, color: T.faint });

  let title = '';
  let sub = '';
  const body: Line[] = [];
  /** Zeile im Kasten, die bei einem Klick etwas tut */
  const bodyHits: Record<number, () => void> = {};
  let hint: Span[] = [];
  switch (state.step) {
    case 'willkommen':
      title = 'Willkommen bei Harnes';
      sub = 'Mehrere KI-Sitzungen arbeiten als ein Team – du führst es aus einem Fenster.';
      body.push(
        [d('In drei kurzen Schritten verbindest du deine Zugänge:')],
        [],
        [k('1  '), { text: 'Auswählen, womit du arbeitest', color: T.text }],
        [k('2  '), { text: 'Jeden Zugang einmal verbinden', color: T.text }],
        [k('3  '), { text: 'Loslegen – ab dann startest du direkt in den Chats', color: T.text }],
        [],
        [{ text: 'Wie heißt du? ', color: T.muted }, { text: state.name ?? config.benutzer, color: T.text, bold: true }, { text: ' ', bg: T.text }],
        [d('So nennen dich die Sitzungen im Team-Chat. Tippen ändert den Namen.')],
      );
      hint = [k('Enter'), d(' los  '), k('Strg+C'), d(' beenden')];
      break;
    case 'auswahl':
      title = 'Womit willst du arbeiten?';
      sub = 'Wähle alles, was du hast. Später kannst du jederzeit mehr hinzufügen (Esc im Chat).';
      choices.forEach((r, i) => {
        const on = state.chosen.includes(r.id);
        const at = i === state.cursor;
        const s = st(r);
        bodyHits[body.length] = () => {
          state.cursor = i;
          toggle(r.id);
        };
        body.push([
          { text: at ? '❯ ' : '  ', color: T.pink, bold: true },
          { text: on ? '[x] ' : '[ ] ', color: on ? T.ok : T.faint, bold: on },
          { text: r.label, color: at ? T.text : T.muted, bold: at },
          { text: s.state === 'ok' ? '  ● bereit' : '', color: T.ok },
        ]);
        if (at) body.push([{ text: `      ${ABOUT[r.id] ?? ''}`, color: T.faint }]);
      });
      hint = [k('↑↓'), d(' wählen  '), k('Leertaste'), d(' an/aus  '), k('Enter'), d(' weiter  '), k('Esc'), d(' zurück')];
      break;
    case 'verbinden': {
      const r = current!;
      const s = st(r);
      const m = MARK[s.state];
      title = r.label;
      sub = `Zugang ${state.idx + 1} von ${chosenRows.length} · ${ABOUT[r.id] ?? ''}`;
      body.push([d(HOW[r.login])], [], [{ text: `${m.ch} `, color: m.color, bold: true }, { text: s.text, color: s.state === 'ok' ? T.ok : T.text }], []);
      if (s.state === 'ok') {
        if (r.login === 'claude' || r.login === 'codex') {
          // Die Anmeldung gehört dem Programm selbst (Claude Code bzw. Codex), Harnes prüft sie nur
          const prog = r.login === 'claude' ? 'Claude Code' : 'Codex';
          const out = r.login === 'claude' ? 'claude auth logout' : 'codex logout';
          body.push([d(`${prog} ist auf diesem Rechner schon angemeldet – Harnes nutzt diese Anmeldung mit.`)]);
          body.push([d('Anderes Konto? In einem Terminal '), { text: out, color: T.text }, d(' eingeben und hier neu anmelden.')], []);
        }
        bodyHits[body.length] = next;
        body.push([k('[ Weiter ]'), d('  verbunden')]);
      } else if (r.login === 'claude' || r.login === 'codex') {
        bodyHits[body.length] = connect;
        body.push([k('[ Jetzt anmelden ]'), d('  öffnet die Anmeldung im Browser')]);
      } else if (r.login === 'key') {
        const shown = keyValue ? `${keyValue.slice(0, 6)}${'•'.repeat(Math.min(24, Math.max(0, keyValue.length - 6)))}` : '';
        body.push([d('Schlüssel  '), { text: shown || ' ', color: T.text, bg: T.night }, { text: ' ', bg: T.violet }]);
      } else if (r.login === 'lokal') {
        bodyHits[body.length] = () => check(r, false);
        body.push([k('[ Erneut suchen ]')]);
      }
      hint = [k('Enter'), d(s.state === 'ok' ? ' weiter  ' : r.login === 'key' ? ' speichern  ' : ' verbinden  '), k('S'), d(' überspringen  '), k('R'), d(' neu prüfen  '), k('Esc'), d(' zurück')];
      break;
    }
    case 'fertig': {
      const ready = chosenRows.filter((r) => st(r).state === 'ok');
      title = ready.length ? 'Alles bereit' : 'Noch nichts verbunden';
      sub = ready.length ? 'Diese Sitzungen kommen gleich ins Team:' : 'Du kannst trotzdem starten und später verbinden (Esc im Chat).';
      for (const r of chosenRows) {
        const s = st(r);
        const m = MARK[s.state];
        body.push([{ text: `${m.ch} `, color: m.color, bold: true }, { text: r.label, color: s.state === 'ok' ? T.text : T.faint }, d(s.state === 'ok' ? '' : `  ${s.text}`)]);
      }
      body.push([]);
      bodyHits[body.length] = next;
      body.push([k('[ Zu den Chats ]')]);
      hint = [k('Enter'), d(' zu den Chats  '), k('Esc'), d(' zurück')];
      break;
    }
  }

  // Bild oben: Logo und Galaxie (je nach Platz)
  const art: Line[] = [];
  const room = R - body.length - 11;
  if (room >= 8) {
    const logo = C >= 60 ? bigLogo('HARNES') : [];
    const gH = Math.min(9, room - logo.length - 1);
    if (gH >= 5 && !sideW) art.push(...galaxy(Math.min(56, C - 8), gH, time));
    if (logo.length && room >= gH + logo.length + 1) {
      art.push([]);
      logo.forEach((l, i) => art.push(logoLine(l, i, { phase: time / 5000 })));
    }
  }
  const artPad = (l: Line, w: number): Line => [{ text: ' '.repeat(Math.max(0, Math.floor((LC - w) / 2))) }, ...l];
  const lineW = (l: Line) => l.reduce((s, x) => s + [...x.text].length, 0);

  // Klickzeilen auf den Bildschirm umrechnen: Kopf 1, Leerzeile, Bild, Kasten (Rand, Titel, Unterzeile, Leerzeile)
  const subLines = wrapText(sub, W - 4);
  const top = 2 + art.length + (art.length ? 1 : 0);
  for (const [i, fn] of Object.entries(bodyHits)) hits[top + 3 + subLines.length + Number(i)] = fn;

  return (
    <Box flexDirection="column" width={C} height={R}>
      <Box height={1} justifyContent="space-between">
        <Row spans={[{ text: ' ◆ ', color: T.pink, bold: true }, ...gradientSpans('Harnes', time / 5000, { bold: true }), d('  Einrichtung')]} />
        <Row spans={[...dots, { text: ' ' }]} />
      </Box>
      <Box flexDirection="row" height={R - 2}>
      <Box width={LC} flexDirection="column">
      <Text> </Text>
      {art.length > 0 && <Lines lines={art.map((l) => artPad(l, lineW(l)))} height={art.length} />}
      {art.length > 0 && <Text> </Text>}
      <Box width={LC} justifyContent="center">
        <Box width={W} borderStyle="round" borderColor={T.line} paddingX={1} flexDirection="column">
          <Row spans={[{ text: title, color: T.text, bold: true }]} />
          {subLines.map((l, i) => (
            <Row key={i} spans={[{ text: l, color: T.muted }]} />
          ))}
          <Text> </Text>
          <Lines lines={body.map((l) => l)} height={body.length} />
        </Box>
      </Box>
      </Box>
      {sideW > 0 && (
        <Box width={sideW}>
          <Lines lines={ownImages('verbinden')[0] ? brailleImage(ownImages('verbinden')[0]!, sideW, R - 2, time) : muse(sideW, R - 2, time)} height={R - 2} />
        </Box>
      )}
      </Box>
      <Box height={1}>
        {notice ? <Text color={T.warn}>{` ${notice}`}</Text> : <Row spans={[{ text: ' ' }, ...hint]} />}
      </Box>
    </Box>
  );
  void inner;
}

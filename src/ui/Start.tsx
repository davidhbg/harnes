import { spawn } from 'node:child_process';
import { Box, Text, useAnimation, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useEffect, useReducer, useState } from 'react';
import { claudeStatus, codexStatus, keyStatus, localStatus, type AuthInfo } from '../auth.js';
import { saveKey, type Config } from '../config.js';
import { errText, truncate } from '../util.js';
import { galaxy } from './art.js';
import { Row } from './Spans.js';
import { SPINNER, T, barSpans, bigLogo, gradientSpans, logoLine, smallLogo, type Span } from './theme.js';

/** Eine Zeile im Anmeldebildschirm. */
export interface StartRow {
  id: string;
  label: string;
  /** Art für parseSpec */
  kind: string;
  /** Name der Sitzung im Team */
  name: string;
  login: 'claude' | 'codex' | 'key' | 'lokal' | 'keine';
  /** Anbieter für API-Schlüssel */
  provider?: string;
}

export type StartAction = { type: 'login'; row: string } | { type: 'start'; rows: string[] } | { type: 'quit' };

export function startRows(config: Config): StartRow[] {
  const rows: StartRow[] = [
    { id: 'claude', label: 'Claude Code · Abo', kind: 'claude', name: 'claude', login: 'claude' },
    { id: 'codex', label: 'Codex · ChatGPT', kind: 'codex', name: 'codex', login: 'codex' },
    { id: 'claude-api', label: 'Claude · API-Schlüssel', kind: 'claude-api', name: 'claude-api', login: 'key', provider: 'anthropic' },
  ];
  const names: Record<string, string> = { deepseek: 'DeepSeek · API-Schlüssel', openrouter: 'OpenRouter · API-Schlüssel', ollama: 'Ollama · lokal', lmstudio: 'LM Studio · lokal' };
  for (const [id, p] of Object.entries(config.anbieter)) {
    rows.push({
      id,
      label: names[id] ?? id,
      kind: id,
      name: id === 'ollama' || id === 'lmstudio' ? 'lokal' : id,
      login: p.apiKeyEnv ? 'key' : 'lokal',
      provider: id,
    });
  }
  rows.push({ id: 'test', label: 'Test-Agent · ohne KI', kind: 'test', name: 'test', login: 'keine' });
  return rows;
}

/** Status einer Zeile neu ermitteln. */
export async function checkRow(config: Config, row: StartRow, verifyKey = true): Promise<AuthInfo> {
  switch (row.login) {
    case 'claude':
      return claudeStatus(config);
    case 'codex':
      return codexStatus(config);
    case 'key':
      return keyStatus(config, row.provider!, verifyKey);
    case 'lokal':
      return localStatus(config, row.provider!);
    case 'keine':
      return { state: 'ok', text: 'immer bereit, kostet nichts' };
  }
}

/** Kleiner Schriftzug (für Tests und schmale Fenster). */
export function banner(word: string): string[] {
  return smallLogo(word);
}

const MARK: Record<AuthInfo['state'], { ch: string; color: string }> = {
  pruefe: { ch: '◌', color: T.warn },
  ok: { ch: '●', color: T.ok },
  fehlt: { ch: '○', color: T.faint },
  abgelaufen: { ch: '!', color: T.warn },
  fehler: { ch: '✕', color: T.bad },
};

interface Props {
  config: Config;
  project: string;
  cwd: string;
  rows: StartRow[];
  /** Status je Zeile; lebt außerhalb, damit er die Anmeldung übersteht */
  status: Record<string, AuthInfo>;
  /** Auswahl „ins Team“; lebt ebenfalls außerhalb */
  selected: Set<string>;
  /** Zeilen, deren Sitzung schon läuft (beim Zurückkommen aus dem Team) */
  running: Set<string>;
  /** diese Zeilen beim Öffnen neu prüfen (z. B. nach einer Anmeldung) */
  recheck: string[];
  /** Markierung; lebt außerhalb, damit sie nach einer Anmeldung an derselben Stelle steht */
  pos: { cursor: number };
  /** Lade-Animation zeigen (nur beim allerersten Öffnen) */
  boot?: boolean;
  notice?: string;
  onAction: (a: StartAction) => void;
}

const BOOT_MIN_MS = 2200;
const BOOT_MAX_MS = 7000;

export function Start({ config, project, cwd, rows, status, selected, running, recheck, pos, boot, notice: initialNotice, onAction }: Props) {
  const { exit } = useApp();
  const { columns: C, rows: R } = useWindowSize();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [cursor, setCursorState] = useState(pos.cursor);
  const setCursor = (c: number) => {
    pos.cursor = c;
    setCursorState(c);
  };
  const [notice, setNotice] = useState(initialNotice ?? '');
  const [keyEdit, setKeyEdit] = useState<{ row: StartRow; value: string } | null>(null);
  const [booting, setBooting] = useState(Boolean(boot) && !process.env.RH_NO_ANIM);
  const { frame, time } = useAnimation({ interval: booting ? 50 : 90 });

  const check = (row: StartRow, verify = true) => {
    status[row.id] = { state: 'pruefe', text: 'wird geprüft …' };
    rerender();
    checkRow(config, row, verify)
      .then((s) => {
        status[row.id] = s;
        // Ist eine Anmeldung erfolgreich, kommt die Zeile gleich mit ins Team.
        if (s.state === 'ok' && recheck.includes(row.id)) selected.add(row.id);
        if (s.state !== 'ok' && !running.has(row.id)) selected.delete(row.id);
      })
      .catch((e) => (status[row.id] = { state: 'fehler', text: errText(e) }))
      .finally(rerender);
  };

  useEffect(() => {
    for (const row of rows) if (!status[row.id] || recheck.includes(row.id)) check(row);
  }, []);

  const doAction = (a: StartAction) => {
    onAction(a);
    exit();
  };

  const total = rows.length + 1; // letzte Zeile: Team starten
  const current = cursor < rows.length ? rows[cursor] : undefined;
  const chosen = rows.filter((r) => selected.has(r.id) && !running.has(r.id));
  const checked = rows.filter((r) => status[r.id] && status[r.id]!.state !== 'pruefe').length;

  // Lade-Animation endet, wenn alles geprüft ist (frühestens nach der Mindestzeit)
  const bootProgress = Math.min(time / BOOT_MIN_MS, 0.25 + 0.75 * (checked / rows.length));
  useEffect(() => {
    if (booting && ((bootProgress >= 1 && time >= BOOT_MIN_MS + 250) || time > BOOT_MAX_MS)) setBooting(false);
  }, [booting, bootProgress, time]);

  const login = (row: StartRow) => {
    if (row.login === 'claude' || row.login === 'codex') return doAction({ type: 'login', row: row.id });
    if (row.login === 'key') return setKeyEdit({ row, value: '' });
    if (row.login === 'lokal') {
      if (row.id !== 'ollama') return setNotice(`${row.label}: Bitte das Programm selbst starten, dann R drücken.`);
      try {
        spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        setNotice('Ollama wird gestartet …');
        status[row.id] = { state: 'pruefe', text: 'wird gestartet …' };
        setTimeout(() => check(row), 3000);
      } catch (e) {
        setNotice(`Ollama ließ sich nicht starten: ${errText(e)}`);
      }
      return;
    }
    setNotice('Für den Test-Agenten braucht es keine Anmeldung.');
  };

  const toggle = (row: StartRow) => {
    if (running.has(row.id)) return setNotice(`${row.label} läuft schon im Team.`);
    if (selected.has(row.id)) {
      selected.delete(row.id);
      return rerender();
    }
    const s = status[row.id];
    if (s?.state !== 'ok') return setNotice(`${row.label}: erst anmelden (Enter drücken).`);
    selected.add(row.id);
    rerender();
  };

  usePaste((text) => {
    if (!keyEdit) return;
    setKeyEdit({ ...keyEdit, value: keyEdit.value + text.replace(/\s+/g, '') });
  });

  useInput((input, key) => {
    if (booting) return setBooting(false); // jede Taste überspringt die Lade-Animation
    if (keyEdit) {
      if (key.escape) return setKeyEdit(null);
      if (key.return) {
        const value = keyEdit.value.trim();
        const row = keyEdit.row;
        setKeyEdit(null);
        if (!value) return;
        const envName = row.provider === 'anthropic' ? config.claudeApi.apiKeyEnv : config.anbieter[row.provider!]?.apiKeyEnv;
        if (!envName) return setNotice('Für diesen Anbieter ist kein Schlüssel vorgesehen.');
        saveKey(envName, value);
        setNotice(`Schlüssel für ${row.label.split(' · ')[0]} gespeichert, wird geprüft …`);
        recheck.push(row.id);
        check(row, true);
        return;
      }
      if (key.backspace || key.delete) return setKeyEdit({ ...keyEdit, value: keyEdit.value.slice(0, -1) });
      if (key.ctrl || key.meta) return;
      if (input) setKeyEdit({ ...keyEdit, value: keyEdit.value + input.replace(/\s+/g, '') });
      return;
    }
    setNotice('');
    if ((key.ctrl && input === 'c') || input === 'q' || input === 'Q') return doAction({ type: 'quit' });
    if (key.upArrow) return setCursor((cursor - 1 + total) % total);
    if (key.downArrow || key.tab) return setCursor((cursor + 1) % total);
    if (input === 'r' || input === 'R') {
      for (const row of rows) check(row);
      return setNotice('Alle Anmeldungen werden neu geprüft …');
    }
    if (input === 's' || input === 'S') return doAction({ type: 'start', rows: chosen.map((r) => r.id) });
    if (input === ' ' && current) return toggle(current);
    if (key.return) {
      if (!current) return doAction({ type: 'start', rows: chosen.map((r) => r.id) });
      return login(current);
    }
  });

  // ---------- Logo ----------
  const W = Math.min(C - 2, 92);
  const inner = W - 4;
  const big = bigLogo('HARNES');
  const logoW = big[0]!.length;
  const need = rows.length + 23 + (keyEdit ? 5 : 0);
  const useBig = C >= logoW + 4 && R >= (booting ? 18 : need);
  const useSmall = !useBig && C >= 60 && R >= (booting ? 12 : rows.length + 16);
  const art = useBig ? big : useSmall ? smallLogo('HARNES REMOTE') : [];
  const reveal = booting ? Math.min(1, time / 1100) : 1;
  const cycle = 4200;
  const shine = booting ? undefined : ((time % cycle) / 1000) * (art[0]?.length ?? 0) * 0.9 - 6;
  const phase = time / 9000;
  const logo = art.map((l, i) => logoLine(l, i, { reveal, phase, shine, seed: frame }));
  const sub: Span[] = useBig
    ? [
        { text: ' '.repeat(Math.max(0, logoW - 23)) },
        ...gradientSpans('R  E  M  O  T  E', phase, { bold: true, spread: 24 }),
        { text: '  ◆', color: T.pink },
      ]
    : [];
  const spin = SPINNER[frame % SPINNER.length]!;

  // ---------- Lade-Animation ----------
  if (booting) {
    const steps: { done: boolean; text: string }[] = [
      { done: time > 350, text: 'Zentrale gestartet' },
      { done: time > 750, text: 'Team-Vault verbunden' },
      { done: time > 1100, text: 'Team-Werkzeuge bereit' },
      { done: checked === rows.length, text: `Anmeldungen prüfen (${checked}/${rows.length})` },
    ];
    const visible = steps.filter((_, i) => i === 0 || steps[i - 1]!.done);
    const barW = Math.max(16, Math.min(46, C - 14));
    const pct = Math.round(Math.min(1, bootProgress) * 100);
    // Galaxie über dem Logo, wenn das Fenster hoch genug ist
    const gW = Math.min(66, C - 6);
    const gH = Math.min(12, R - 19);
    const sky = gH >= 7 && gW >= 40 ? galaxy(gW, gH, time * 3) : [];
    return (
      <Box flexDirection="column" width={C} height={R} alignItems="center" justifyContent="center">
        {sky.length ? (
          <Box flexDirection="column" marginBottom={1}>
            {sky.map((l, i) => (
              <Row key={i} spans={l} />
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column">
          {art.length ? logo.map((l, i) => <Row key={i} spans={l} />) : <Row spans={gradientSpans('HARNES REMOTE', phase, { bold: true })} />}
          {useBig && reveal >= 1 ? <Row spans={sub} /> : <Text> </Text>}
        </Box>
        <Box flexDirection="column" marginTop={1} width={barW + 8}>
          <Row spans={[...barSpans(bootProgress, barW, -time / 2500), { text: ` ${String(pct).padStart(3)} %`, color: T.violet, bold: true }]} />
          <Text> </Text>
          {visible.map((s, i) => (
            <Row
              key={i}
              spans={[
                { text: s.done ? '✓ ' : `${spin} `, color: s.done ? T.ok : T.pink, bold: true },
                { text: s.text, color: s.done ? T.muted : T.text },
              ]}
            />
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={T.faint}>beliebige Taste überspringt</Text>
        </Box>
      </Box>
    );
  }

  // ---------- Liste ----------
  const nameW = 26;
  const teamW = 9;
  const statusW = Math.max(12, inner - nameW - teamW - 2);
  const key = (k: string, d: string): Span[] => [
    { text: k, color: T.violet, bold: true },
    { text: ` ${d}   `, color: T.muted },
  ];
  const enterWord = !current
    ? 'Team starten'
    : current.login === 'keine'
      ? '–'
      : status[current.id]?.state === 'ok'
        ? 'neu anmelden'
        : current.login === 'key'
          ? 'Schlüssel eingeben'
          : current.login === 'lokal'
            ? 'starten'
            : 'anmelden';
  const hint: Span[] = keyEdit
    ? [...key('Strg+V', 'einfügen'), ...key('Enter', 'speichern'), ...key('Esc', 'abbrechen')]
    : [...key('↑↓', 'wählen'), ...key('Enter', enterWord), ...key('Leertaste', 'ins Team'), ...key('S', 'Team starten'), ...key('R', 'neu prüfen'), ...key('Q', 'beenden')];
  const startFocus = cursor === rows.length;
  const startLabel = ` ▶ Team starten${chosen.length ? ` (${chosen.map((r) => r.name).join(', ')})` : running.size ? ' (zurück zum Team)' : ' (ohne Sitzungen)'} `;

  return (
    <Box flexDirection="column" width={C} height={R} paddingX={1}>
      {art.length ? (
        <Box flexDirection="row" marginTop={useBig ? 1 : 0}>
          <Box flexDirection="column">
            {logo.map((l, i) => (
              <Row key={i} spans={l} />
            ))}
            {useBig ? <Row spans={sub} /> : null}
          </Box>
          {useBig && W - logoW >= 30 ? (
            <Box flexDirection="column" marginLeft={3}>
              {galaxy(Math.min(40, W - logoW - 4), 7, time).map((l, i) => (
                <Row key={i} spans={l} />
              ))}
            </Box>
          ) : null}
        </Box>
      ) : (
        <Row spans={[{ text: '◆ ', color: T.pink }, ...gradientSpans('Harnes', phase, { bold: true })]} />
      )}
      <Row
        spans={[
          { text: 'KI-Sitzungen als Team', color: T.text },
          { text: ' · Claude, Codex und weitere in einem Chat', color: T.muted },
        ]}
      />
      <Box marginTop={1}>
        <Row
          spans={[
            { text: 'Projekt ', color: T.muted },
            { text: project, color: T.pink, bold: true },
            { text: `  ${truncate(cwd, Math.max(10, W - project.length - 12))}`, color: T.faint },
          ]}
        />
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={T.line} paddingX={1} width={W} marginTop={1}>
        <Row spans={gradientSpans('Anmelden und Team zusammenstellen', phase * 2, { bold: true, stops: [T.violet, T.pink], spread: 40 })} />
        <Text color={T.faint}>
          {'  '}
          {'Dienst'.padEnd(nameW)}
          {'Status'.padEnd(statusW)}
          {' Im Team'}
        </Text>
        {rows.map((row, i) => {
          const s = status[row.id] ?? { state: 'pruefe', text: 'wird geprüft …' };
          const m = MARK[s.state];
          const active = i === cursor;
          const isRunning = running.has(row.id);
          const on = selected.has(row.id);
          const box = isRunning ? '[läuft]' : on ? '[x]' : '[ ]';
          return (
            <Row
              key={row.id}
              spans={[
                { text: active ? '▸ ' : '  ', color: T.pink, bold: true },
                { text: truncate(row.label, nameW - 1).padEnd(nameW), color: active ? T.text : T.muted, bold: active },
                { text: `${s.state === 'pruefe' ? spin : m.ch} `, color: s.state === 'pruefe' ? T.pink : m.color, bold: true },
                { text: truncate(s.text, statusW - 3).padEnd(statusW - 2), color: s.state === 'ok' ? T.text : s.state === 'fehlt' ? T.faint : m.color },
                { text: ` ${box}`, color: isRunning ? T.ok : on ? T.pink : T.faint, bold: on },
              ]}
            />
          );
        })}
        <Text> </Text>
        <Text>
          <Text color={T.pink} bold>
            {startFocus ? '▸ ' : '  '}
          </Text>
          <Text backgroundColor={startFocus ? T.purple : undefined} color={startFocus ? '#0B0613' : T.violet} bold>
            {startLabel}
          </Text>
        </Text>
      </Box>

      {keyEdit && (
        <Box borderStyle="round" borderColor={T.pink} paddingX={1} width={W} flexDirection="column">
          <Text bold color={T.violet}>{`API-Schlüssel für ${keyEdit.row.label.split(' · ')[0]}`}</Text>
          <Text color={T.muted}>Bleibt nur auf diesem Rechner (~/.remoteharnes/keys.json), nie im Vault.</Text>
          <Text>
            <Text color={T.pink}>{'❯ '}</Text>
            <Text color={T.violet}>{'•'.repeat(Math.min(keyEdit.value.length, inner - 4))}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {notice ? (
          <Text color={T.warn} wrap="truncate-end">
            {notice}
          </Text>
        ) : null}
        <Row spans={hint} />
      </Box>
    </Box>
  );
}

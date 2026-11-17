import type { AgentRec, Hub } from '../hub/hub.js';
import type { AgentStatus, Message } from '../types.js';
import { fmtMoney, providerLabel } from '../balance.js';
import { dateStr, hhmm, hhmmss, width as textWidth, wrapText } from '../util.js';
import { AGENT_COLORS, T, barSpans, fmtTokens, type Line, type Span } from './theme.js';

export type { Line, Span } from './theme.js';

/** Hauptfarbe der Oberfläche (für ältere Aufrufer) */
export const ACCENT = T.purple;

/** So lange „tippt“ sich eine neue Nachricht auf den Bildschirm. */
export const REVEAL_MS = 650;

export function colorOf(hub: Hub, id: string): string {
  if (id === hub.human) return T.pink;
  if (id === 'system') return T.faint;
  const names = [...hub.agents.keys()];
  let i = names.indexOf(id);
  if (i < 0) i = [...id].reduce((s, c) => s + c.charCodeAt(0), 0);
  return AGENT_COLORS[i % AGENT_COLORS.length]!;
}

export function statusDot(s: AgentStatus): { ch: string; color: string } {
  switch (s) {
    case 'startet':
      return { ch: '◌', color: T.warn };
    case 'wartet':
      return { ch: '○', color: T.faint };
    case 'arbeitet':
      return { ch: '●', color: T.ok };
    case 'freigabe':
      return { ch: '!', color: T.warn };
    case 'fehler':
      return { ch: '✕', color: T.bad };
    case 'beendet':
      return { ch: '·', color: T.faint };
  }
}

export function statusWord(s: AgentStatus): string {
  return { startet: 'startet', wartet: 'wartet', arbeitet: 'arbeitet', freigabe: 'braucht Freigabe', fehler: 'Fehler', beendet: 'beendet' }[s];
}

/** Zerlegt eine Textzeile so, dass @Erwähnungen und `Code` farbig werden. */
function richText(text: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(/(@[\p{L}\p{N}_-]+)|(`[^`]+`)/gu)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), color: T.text });
    out.push(m[1] ? { text: m[0], color: T.cyan, bold: true } : { text: m[0], color: T.violet });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), color: T.text });
  return out;
}

/** Breite einer Zeile aus Abschnitten */
const spanWidth = (spans: Span[]) => spans.reduce((s, x) => s + textWidth(x.text), 0);

/**
 * Chat als Karten: Nachrichten der Sitzungen links mit farbigem Balken,
 * die eigenen rechts. Aufeinanderfolgende Nachrichten derselben Person rücken zusammen.
 */
export function chatLines(hub: Hub, msgs: Message[], width: number, now = 0): Line[] {
  const out: Line[] = [];
  let lastDay = '';
  const today = dateStr(Date.now());
  const maxW = Math.max(24, Math.min(width - 4, Math.floor(width * 0.8)));
  let prev: Message | undefined;
  for (const m of msgs) {
    const day = dateStr(m.ts);
    if (day !== lastDay) {
      if (day !== today || lastDay !== '') {
        const label = ` ${day} `;
        const side = Math.max(2, Math.floor((width - label.length) / 2));
        out.push([], [{ text: '─'.repeat(side), color: T.night }, { text: label, color: T.faint }, { text: '─'.repeat(side), color: T.night }]);
      }
      lastDay = day;
      prev = undefined;
    }
    if (m.system) {
      for (const l of wrapText(m.text, width - 6)) {
        const pad = Math.max(0, Math.floor((width - textWidth(l) - 4) / 2));
        out.push([{ text: ' '.repeat(pad) }, { text: `· ${l} ·`, color: T.faint, italic: true }]);
      }
      prev = undefined;
      continue;
    }
    // Neue Nachrichten tippen sich kurz auf den Bildschirm
    let text = m.text;
    let typing = false;
    const age = now - m.ts;
    if (now && age >= 0 && age < REVEAL_MS) {
      const chars = [...m.text];
      text = chars.slice(0, Math.max(1, Math.ceil((age / REVEAL_MS) * chars.length))).join('');
      typing = true;
    }
    const mine = m.from === hub.human;
    const color = m.urgent ? T.bad : colorOf(hub, m.from);
    const agentToAgent = m.to !== 'team' && m.to !== hub.human && !mine;
    const grouped = prev && prev.from === m.from && prev.to === m.to && m.ts - prev.ts < 120_000 && !m.urgent;
    const body = wrapText(text, maxW - 2);
    if (!grouped) {
      if (out.length) out.push([]);
      const name = hub.label(m.from) + (agentToAgent ? ` → ${hub.label(m.to)}` : '');
      if (mine) {
        const head: Span[] = [
          { text: m.urgent ? 'dringend  ' : '', color: T.bad, bold: true },
          { text: `${hhmm(m.ts)}  `, color: T.faint },
          { text: name, color, bold: true },
          { text: ' ▕', color },
        ];
        out.push([{ text: ' '.repeat(Math.max(0, width - spanWidth(head))) }, ...head]);
      } else {
        out.push([
          { text: '▎ ', color },
          { text: name, color, bold: true },
          { text: `  ${hhmm(m.ts)}`, color: T.faint },
          { text: m.urgent ? '  dringend' : '', color: T.bad, bold: true },
        ]);
      }
    }
    const blockW = Math.max(...body.map((l) => textWidth(l)), 1) + (typing ? 1 : 0);
    body.forEach((l, idx) => {
      const cursor: Span[] = typing && idx === body.length - 1 ? [{ text: '▌', color }] : [];
      const rich = [...richText(l), ...cursor];
      if (mine) {
        const fill = Math.max(0, blockW - spanWidth(rich));
        out.push([{ text: ' '.repeat(Math.max(0, width - blockW - 2)) }, ...rich, { text: ' '.repeat(fill) }, { text: ' ▕', color }]);
      } else {
        out.push([{ text: '▎ ', color }, ...rich]);
      }
    });
    prev = m;
  }
  return out;
}

const TASK_COLOR: Record<string, string> = {
  offen: T.text,
  reserviert: T.warn,
  in_arbeit: T.cyan,
  erledigt: T.ok,
  blockiert: T.bad,
};

export function taskLines(hub: Hub, width: number): Line[] {
  const out: Line[] = [];
  const tasks = hub.tasks.tasks;
  if (!tasks.length) out.push([{ text: 'Noch keine Aufgaben auf dem Brett.', color: T.muted }]);
  const done = tasks.filter((t) => t.status === 'erledigt').length;
  if (tasks.length) {
    out.push([...barSpans(done / tasks.length, Math.max(8, Math.min(30, width - 24))), { text: `  ${done} von ${tasks.length} erledigt`, color: T.muted }], []);
  }
  for (const t of tasks) {
    const head = `#${t.id} `;
    const status = `[${t.status}] `;
    const owner = t.owner ? ` · ${t.owner}` : '';
    const wrapped = wrapText(`${t.title}${owner}`, width - head.length - status.length);
    wrapped.forEach((l, idx) => {
      if (idx === 0) {
        out.push([
          { text: head, bold: true, color: T.violet },
          { text: status, color: TASK_COLOR[t.status] },
          { text: l, color: t.status === 'erledigt' ? T.muted : T.text },
        ]);
      } else out.push([{ text: ' '.repeat(head.length + status.length) + l, color: t.status === 'erledigt' ? T.muted : T.text }]);
    });
    if (t.description) for (const l of wrapText(t.description, width - 6)) out.push([{ text: `      ${l}`, color: T.muted }]);
    if (t.proof) for (const l of wrapText(`Nachweis: ${t.proof}`, width - 6)) out.push([{ text: `      ${l}`, color: T.ok }]);
  }
  if (hub.tasks.files.size) {
    out.push([], [{ text: 'Gesperrte Dateien', bold: true, color: T.violet }]);
    for (const [p, a] of hub.tasks.files) {
      const kind = hub.tasks.auto.has(p) ? 'wird bearbeitet' : 'reserviert';
      for (const l of wrapText(`${p} → ${a} (${kind})`, width - 2)) out.push([{ text: `  ${l}`, color: T.text }]);
    }
  }
  out.push([], [{ text: 'Neue Aufgabe: Text eingeben und Enter · /zuweisen <Nr> <Name> · /erledigt <Nr> [Nachweis]', color: T.faint }]);
  return out;
}

export function logLines(a: AgentRec, width: number): Line[] {
  const out: Line[] = [];
  if (a.adapter?.screenLines) {
    out.push([{ text: 'Bildschirm der Sitzung (F12 öffnet das Terminal):', color: T.muted }], []);
    for (const l of a.adapter.screenLines()) out.push([{ text: l.slice(0, width), color: T.text }]);
    out.push([], [{ text: 'Ereignisse:', color: T.muted }]);
  }
  if (!a.log.length) out.push([{ text: 'Noch keine Einträge.', color: T.muted }]);
  for (const e of a.log) {
    const mark = e.kind === 'tool' ? '› ' : e.kind === 'fehler' ? '✕ ' : e.kind === 'info' ? '· ' : '';
    const color = e.kind === 'tool' ? T.cyan : e.kind === 'fehler' ? T.bad : e.kind === 'info' || e.kind === 'status' ? T.faint : T.text;
    wrapText(mark + e.text, width - 9).forEach((l, idx) => {
      out.push([
        { text: idx === 0 ? `${hhmmss(e.ts)} ` : '         ', color: T.faint },
        { text: l, color },
      ]);
    });
  }
  return out;
}

const cell = (s: string, w: number, right = false) => (right ? s.padStart(w) : s.padEnd(w));

/** Verbrauch aller Sitzungen als Tabelle mit Erklärung. */
export function usageLines(hub: Hub, width: number, phase = 0): Line[] {
  const out: Line[] = [];
  const agents = [...hub.agents.values()];
  const cols = [14, 7, 9, 9, 9, 9];
  const header = ['Sitzung', 'Runden', 'Neu', 'Cache', 'Ausgabe', 'Kontext'];
  const ruler = '─'.repeat(Math.max(10, Math.min(width, cols.reduce((s, c) => s + c + 1, 0) + 22)));
  out.push(header.map((h, i) => ({ text: cell(h, cols[i]!, i > 0) + ' ', color: T.muted, bold: true })));
  out.push([{ text: ruler, color: T.night }]);
  if (!agents.length) out.push([{ text: 'Noch keine Sitzung offen.', color: T.muted }]);
  const maxNew = Math.max(1, ...agents.map((a) => a.usage.inputTokens + a.usage.outputTokens));
  for (const a of agents) {
    const u = a.usage;
    const used = u.inputTokens + u.outputTokens;
    const share = a.budgetTokens ? used / a.budgetTokens : used / maxNew;
    out.push([
      { text: cell(a.name.slice(0, cols[0]!), cols[0]!) + ' ', color: colorOf(hub, a.name), bold: true },
      { text: cell(String(u.turns), cols[1]!, true) + ' ', color: T.text },
      { text: cell(fmtTokens(u.inputTokens), cols[2]!, true) + ' ', color: T.pink },
      { text: cell(fmtTokens(u.cacheReadTokens), cols[3]!, true) + ' ', color: T.faint },
      { text: cell(fmtTokens(u.outputTokens), cols[4]!, true) + ' ', color: T.cyan },
      { text: cell(u.contextTokens ? fmtTokens(u.contextTokens) : '–', cols[5]!, true) + '  ', color: T.violet },
      ...barSpans(share, 12, phase),
      { text: a.budgetTokens ? ` ${Math.round(share * 100)} % von ${fmtTokens(a.budgetTokens)}` : '', color: a.budgetHit ? T.bad : T.muted },
    ]);
  }
  const t = hub.totalUsage();
  if (agents.length > 1) {
    out.push([{ text: ruler, color: T.night }]);
    out.push([
      { text: cell('Σ gesamt', cols[0]!) + ' ', color: T.text, bold: true },
      { text: cell(String(t.turns), cols[1]!, true) + ' ', color: T.text, bold: true },
      { text: cell(fmtTokens(t.inputTokens), cols[2]!, true) + ' ', color: T.pink, bold: true },
      { text: cell(fmtTokens(t.cacheReadTokens), cols[3]!, true) + ' ', color: T.faint },
      { text: cell(fmtTokens(t.outputTokens), cols[4]!, true) + ' ', color: T.cyan, bold: true },
      { text: cell(fmtTokens(t.contextTokens), cols[5]!, true), color: T.violet },
    ]);
  }
  if (t.costUsd > 0) out.push([], [{ text: `Kosten über API-Schlüssel: $${t.costUsd.toFixed(2)}`, color: T.warn }]);
  const balances = hub.balance?.balances ?? [];
  if (balances.length) {
    out.push([], [{ text: 'Guthaben', color: T.muted, bold: true }, { text: '   /guthaben fragt neu ab', color: T.faint }]);
    for (const b of balances) {
      out.push([
        { text: cell(providerLabel(b.anbieter), 14) + ' ', color: T.text, bold: true },
        { text: fmtMoney(b), color: b.betrag === undefined ? T.faint : b.betrag < 1 ? T.warn : T.ok, bold: b.betrag !== undefined },
        { text: b.betrag !== undefined ? '   Stand ' + new Date(b.zeit).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '', color: T.faint },
      ]);
    }
  }
  const sent = hub.messages.filter((m) => !m.system).length;
  const doneTasks = hub.tasks.tasks.filter((x) => x.status === 'erledigt').length;
  out.push([], [{ text: `${sent} Nachrichten · ${doneTasks} von ${hub.tasks.tasks.length} Aufgaben erledigt`, color: T.muted }], []);
  const explain: [string, string, string][] = [
    ['Neu', T.pink, 'frisch verarbeitete Eingabe. Das ist der Teil, der wirklich zählt.'],
    ['Cache', T.faint, 'wiederverwendeter Kontext aus dem Zwischenspeicher, kostet etwa ein Zehntel.'],
    ['Ausgabe', T.cyan, 'was die Sitzung geschrieben hat.'],
    ['Kontext', T.violet, 'wie groß das Gespräch gerade ist. Jede Claude-Sitzung startet mit einer Grundlast (Claude Code selbst, Werkzeuge, deine Konnektoren).'],
  ];
  for (const [k, c, d] of explain) {
    wrapText(d, width - 10).forEach((l, i) => out.push([{ text: i === 0 ? cell(k, 9) : ' '.repeat(9), color: c, bold: true }, { text: l, color: T.muted }]));
  }
  out.push(
    [],
    [{ text: 'Tipp: Für Helfer-Sitzungen ein kleines Modell wählen, z. B. /neu claude ben haiku', color: T.faint }],
    [{ text: 'Budget je Sitzung: /budget <name|alle> <zahl|aus>', color: T.faint }],
  );
  return out;
}

export function helpLines(humanLabel: string): Line[] {
  const h = (text: string): Line => [{ text, bold: true, color: T.pink }];
  const row = (cmd: string, text: string): Line => [{ text: `  ${cmd.padEnd(42)}`, color: T.violet }, { text, color: T.text }];
  return [
    h('Schreiben'),
    row('Text + Enter', 'im Team-Kanal an alle, im Kanal einer Sitzung privat an sie'),
    row('@name im Team-Kanal', 'nur die Erwähnten bekommen die Nachricht'),
    row('/dm <name> <text>', 'Privatnachricht, egal in welchem Kanal'),
    row('/dringend <name> <text>', 'unterbricht die Sitzung und stellt sofort zu'),
    [],
    h('Sitzungen'),
    row('/konten', 'zurück zum Anmeldebildschirm (Claude, Codex, API)'),
    row('/neu claude [name] [modell]', 'Claude Code mit Abo (echtes Claude Code im Tab)'),
    row('/neu claude-api [name] [modell]', 'Claude über API-Schlüssel'),
    row('/neu codex [name] [modell]', 'Codex (ChatGPT-Anmeldung)'),
    row('/neu deepseek | openrouter [name]', 'über API-Schlüssel'),
    row('/neu ollama | lmstudio [name] [modell]', 'lokales Modell'),
    row('/neu test [name]', 'Test-Agent ohne KI (kostet nichts)'),
    row('/stop <name|alle>', 'laufende Runde abbrechen'),
    row('/anmelden <name>', 'Sitzung neu anmelden'),
    row('/ende <name>', 'Sitzung schließen (auch /schliessen, /close, Strg+W zweimal)'),
    row('/trennen <name>  ·  /verbinden <name>', 'Sitzung vom Team trennen / wieder verbinden'),
    row('/pause  ·  /weiter', 'Zustellung für alle anhalten / fortsetzen'),
    row('/wieder', 'Sitzungen vom letzten Mal erneut öffnen'),
    [],
    h('Aufgaben und Freigaben'),
    row('/aufgabe <titel>', 'Aufgabe anlegen (oder im Aufgaben-Kanal einfach tippen)'),
    row('/zuweisen <nr> <name>', 'Aufgabe zuweisen'),
    row('/erledigt <nr> [nachweis]  ·  /offen <nr>', 'Aufgabe abhaken / wieder öffnen'),
    row('/freigaben', 'offene Freigaben wieder anzeigen'),
    [],
    h('Verbrauch'),
    row('/verbrauch', 'Tokens je Sitzung: neu, Cache, Ausgabe, Kontext'),
    row('/budget <name|alle> <zahl|aus>', 'Token-Grenze je Sitzung, z. B. /budget alle 500k'),
    row('/guthaben', 'Guthaben der API-Anbieter (DeepSeek, OpenRouter, Kimi) neu abfragen'),
    [],
    h('Sitzungen einstellen'),
    row('/model [modell]', 'Modell wechseln (ohne Angabe: Auswahl)'),
    row('/rename <neuer name>', 'Sitzung umbenennen'),
    row('/rolle <rolle>', 'Rolle: tester, reviewer, planer, doku, sicherheit, entwickler'),
    row('/suche <text>', 'Verlauf aller Chats durchsuchen'),
    row('/leeren  ·  /clear', 'diesen Chat leeren (bei Claude Code auch das Gespräch)'),
    row('/projekt', 'anderen Projektordner öffnen (oder Klick auf den Pfad unten links)'),
    row('/vault [ordner]', 'Vault anzeigen oder einen anderen verbinden'),
    row('/start', 'Startseite: Zeitpläne, Store, Projekte, MCP, Einstellungen'),
    row('/einrichtung (/setup, /config)', 'Zugänge verbinden'),
    row('/maus an|aus', 'Mausbedienung an oder aus'),
    [],
    h('Vertraute Befehle aus Claude Code und Codex'),
    row('/cost  /usage  /status', 'Verbrauch anzeigen'),
    row('/help  /exit  /quit  /new', 'wie gewohnt'),
    row('im Kanal einer Claude-Sitzung', '/compact /clear /context /review /init /memory /agents'),
    row('', '/mcp /hooks /permissions /todos /export /doctor – und jeder andere'),
    row('', 'Befehl von Claude Code wird direkt an die Sitzung gegeben'),
    row('im Kanal einer Codex-Sitzung', '/new (neues Gespräch), /model'),
    [],
    h('Sonstiges'),
    row('/schluessel <anbieter> <wert>', 'API-Schlüssel speichern (anthropic, deepseek, openrouter)'),
    row('/vault', 'zeigt, wo der Team-Vault liegt'),
    row('/quit', 'beenden'),
    [],
    h('Tasten'),
    row('/', 'Befehlsliste: ↑↓ wählen, Tab ergänzt, Enter führt aus'),
    row('Esc', 'Menü (neue Sitzung, Modell, Rolle, Anbieter …); im Menü: zurück'),
    row('Tab / Umschalt+Tab', 'Chat wechseln (oder links in der Seitenleiste klicken)'),
    row('Alt+1 … Alt+9', 'direkt zu einem Chat'),
    row('Bild↑ / Bild↓, Mausrad', 'blättern'),
    row('↑ / ↓', 'frühere Eingaben'),
    row('Strg+A / Strg+E', 'Anfang / Ende der Zeile'),
    row('Strg+U / Strg+W', 'bis zum Anfang löschen / letztes Wort löschen'),
    row('Strg+W zweimal (leere Zeile)', 'Sitzung des aktuellen Chats schließen'),
    row('Strg+L', 'bei einer Sitzung: Privatchat ↔ Arbeitsprotokoll'),
    row('F12 (oder Strg+T)', 'Terminal einer Claude-Abo-Sitzung öffnen, F12 wieder zurück'),
    row('Strg+C', 'Eingabe leeren; zweimal: beenden'),
    [],
    [{ text: `Teamleiter: ${humanLabel}. Mit Tab geht es zurück in den Chat.`, color: T.faint }],
  ];
}

/** Treffer einer Suche im Verlauf: Kanal, Absender, Zeit und die Fundstelle hervorgehoben. */
export function searchLines(hub: Hub, found: Message[], query: string, width: number): Line[] {
  const out: Line[] = [];
  if (!query.trim()) return [[{ text: 'Esc → Verlauf durchsuchen oder /suche <text>', color: T.muted }]];
  if (!found.length) return [[{ text: `Nichts gefunden zu „${query}“.`, color: T.muted }]];
  const q = query.toLowerCase();
  for (const m of found) {
    const where = m.to === 'team' ? '# Team' : m.from === hub.human ? `privat → ${hub.label(m.to)}` : m.to === hub.human ? `privat ← ${hub.label(m.from)}` : `${hub.label(m.from)} → ${hub.label(m.to)}`;
    out.push([
      { text: '▎ ', color: colorOf(hub, m.from) },
      { text: hub.label(m.from), color: colorOf(hub, m.from), bold: true },
      { text: `  ${dateStr(m.ts)} ${hhmm(m.ts)}  ·  ${where}`, color: T.faint },
    ]);
    // Ausschnitt um die Fundstelle
    const flat = m.text.replace(/\s+/g, ' ');
    const at = flat.toLowerCase().indexOf(q);
    const from = Math.max(0, at - Math.floor((width - 8) / 3));
    const snippet = (from > 0 ? '…' : '') + flat.slice(from, from + width * 2);
    for (const l of wrapText(snippet, width - 4).slice(0, 2)) {
      const i = l.toLowerCase().indexOf(q);
      if (i < 0 || at < 0) out.push([{ text: '▎ ', color: colorOf(hub, m.from) }, { text: l, color: T.text }]);
      else
        out.push([
          { text: '▎ ', color: colorOf(hub, m.from) },
          { text: l.slice(0, i), color: T.text },
          { text: l.slice(i, i + q.length), color: '#17122B', bg: T.pink, bold: true },
          { text: l.slice(i + q.length), color: T.text },
        ]);
    }
    out.push([]);
  }
  return out;
}

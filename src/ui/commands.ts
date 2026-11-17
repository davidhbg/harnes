import type { AgentSpec } from '../adapters/adapter.js';
import { logoutOf } from '../auth.js';
import { keyEnvFor, saveKey } from '../config.js';
import type { Hub } from '../hub/hub.js';
import type { AgentKind } from '../types.js';
import { startBegleiter } from '../begleiter.js';
import { fmtMoney, providerLabel } from '../balance.js';
import { connectVaultRoot } from '../vault-connect.js';
import { setMouseEnabled } from './mouse.js';
import type { UiAction, UiState } from './state.js';

/** Befehle für die Vorschlagsliste beim Tippen von „/“ (deutsche und vertraute Namen aus Claude Code und Codex). */
export const COMMANDS: { name: string; args?: string; desc: string; kinds?: AgentKind[] }[] = [
  { name: '/neu', args: '<art> [name] [modell]', desc: 'neue Sitzung (claude, codex, claude-api, ollama, test …)' },
  { name: '/model', args: '[modell]', desc: 'Modell der Sitzung wechseln' },
  { name: '/rename', args: '<neuer name>', desc: 'Sitzung umbenennen' },
  { name: '/schliessen', args: '[name]', desc: 'Sitzung schließen (auch /close)' },
  { name: '/stop', args: '[name|alle]', desc: 'laufende Runde abbrechen' },
  { name: '/dm', args: '<name> <text>', desc: 'Privatnachricht' },
  { name: '/dringend', args: '<name> <text>', desc: 'unterbricht und stellt sofort zu' },
  { name: '/aufgabe', args: '<titel>', desc: 'Aufgabe anlegen' },
  { name: '/erledigt', args: '<nr> [nachweis]', desc: 'Aufgabe abhaken' },
  { name: '/zuweisen', args: '<nr> <name>', desc: 'Aufgabe zuweisen' },
  { name: '/verbrauch', desc: 'Tokens und Kosten (auch /cost, /usage, /status)' },
  { name: '/budget', args: '<name|alle> <zahl|aus>', desc: 'Token-Grenze je Sitzung' },
  { name: '/compact', desc: 'Gespräch verdichten, spart Tokens (Claude Code)', kinds: ['claude-abo'] },
  { name: '/clear', desc: 'Gespräch leeren, neu anfangen (Claude Code)', kinds: ['claude-abo'] },
  { name: '/context', desc: 'wie voll der Kontext ist (Claude Code)', kinds: ['claude-abo'] },
  { name: '/review', desc: 'Änderungen prüfen lassen (Claude Code)', kinds: ['claude-abo'] },
  { name: '/security-review', desc: 'Sicherheitsprüfung der Änderungen (Claude Code)', kinds: ['claude-abo'] },
  { name: '/init', desc: 'CLAUDE.md für das Projekt anlegen (Claude Code)', kinds: ['claude-abo'] },
  { name: '/memory', desc: 'Gedächtnis (CLAUDE.md) bearbeiten (Claude Code)', kinds: ['claude-abo'] },
  { name: '/agents', desc: 'eigene Unteragenten verwalten (Claude Code)', kinds: ['claude-abo'] },
  { name: '/mcp', desc: 'MCP-Server von Claude Code (Claude Code)', kinds: ['claude-abo'] },
  { name: '/hooks', desc: 'Hooks von Claude Code (Claude Code)', kinds: ['claude-abo'] },
  { name: '/permissions', desc: 'Erlaubnisse verwalten (Claude Code)', kinds: ['claude-abo'] },
  { name: '/todos', desc: 'aktuelle Aufgabenliste von Claude (Claude Code)', kinds: ['claude-abo'] },
  { name: '/export', desc: 'Gespräch exportieren (Claude Code)', kinds: ['claude-abo'] },
  { name: '/doctor', desc: 'Installation von Claude Code prüfen (Claude Code)', kinds: ['claude-abo'] },
  { name: '/new', desc: 'neues Gespräch beginnen (Codex)', kinds: ['codex'] },
  { name: '/menu', desc: 'Menü öffnen (auch Esc)' },
  { name: '/projekt', desc: 'anderen Projektordner öffnen' },
  { name: '/start', desc: 'Startseite: Einstellungen, MCP, Store, Projekte' },
  { name: '/suche', args: '<text>', desc: 'Verlauf aller Chats durchsuchen' },
  { name: '/rolle', args: '[rolle]', desc: 'Rolle: tester, reviewer, planer, doku, sicherheit' },
  { name: '/einrichtung', desc: 'Zugänge verbinden (auch /setup, /config)' },
  { name: '/abmelden', args: '[claude|codex]', desc: 'Claude Code oder Codex abmelden (auch /logout)' },
  { name: '/konten', desc: 'alle Anmeldungen und Schlüssel auf einen Blick' },
  { name: '/schluessel', args: '<anbieter> <schlüssel>', desc: 'API-Schlüssel speichern' },
  { name: '/pause', desc: 'Zustellung anhalten' },
  { name: '/weiter', desc: 'Zustellung fortsetzen' },
  { name: '/wieder', desc: 'Sitzungen vom letzten Mal öffnen' },
  { name: '/leeren', desc: 'diesen Chat leeren (auch /clear)' },
  { name: '/guthaben', desc: 'Guthaben der API-Anbieter neu abfragen' },
  { name: '/vault', args: '[ordner]', desc: 'Vault anzeigen oder einen anderen verbinden' },
  { name: '/freigaben', desc: 'offene Freigaben anzeigen' },
  { name: '/begleiter', desc: 'Begleiter starten: Zeiger an der Maus, Sprechen mit Strg+Alt' },
  { name: '/terminal', desc: 'Terminal der Sitzung öffnen (F12)' },
  { name: '/maus', args: '[an|aus]', desc: 'Mausbedienung an oder aus' },
  { name: '/vault', desc: 'Ordner des Team-Vaults' },
  { name: '/hilfe', desc: 'alle Befehle und Tasten (auch /help)' },
  { name: '/beenden', desc: 'Harnes beenden (auch /exit, /quit)' },
];

/** Vorschläge zu einem angefangenen Befehl */
export function suggest(draft: string, kind?: AgentKind): typeof COMMANDS {
  const d = draft.toLowerCase();
  if (!d.startsWith('/') || /\s/.test(d)) return [];
  // Befehle einer bestimmten Sitzungsart nur in deren Kanal, dann zuerst
  const fits = COMMANDS.filter((c) => c.name.startsWith(d) && c.name !== d && (!c.kinds || (kind && c.kinds.includes(kind))));
  return [...fits.filter((c) => c.kinds), ...fits.filter((c) => !c.kinds)].slice(0, 7);
}

export interface CommandEnv {
  hub: Hub;
  ui: UiState;
  action: (a: UiAction) => void;
}

interface KindInfo {
  kind: AgentKind;
  provider?: string;
  name: string;
}

export function resolveKind(hub: Hub, word: string): KindInfo | undefined {
  const w = word.toLowerCase();
  const fixed: Record<string, KindInfo> = {
    test: { kind: 'echo', name: 'test' },
    echo: { kind: 'echo', name: 'test' },
    claude: { kind: 'claude-abo', name: 'claude' },
    'claude-abo': { kind: 'claude-abo', name: 'claude' },
    'claude-api': { kind: 'claude-api', name: 'claude' },
    codex: { kind: 'codex', name: 'codex' },
    lokal: { kind: 'openai', provider: 'ollama', name: 'lokal' },
    local: { kind: 'openai', provider: 'ollama', name: 'lokal' },
  };
  if (fixed[w]) return fixed[w];
  if (hub.opts.config.anbieter[w]) return { kind: 'openai', provider: w, name: w };
  return undefined;
}

/** "claude:max" oder "codex" → Spezifikation einer Sitzung (für /neu und --mit). */
export function parseSpec(hub: Hub, kindWord: string, name?: string, model?: string): AgentSpec {
  const info = resolveKind(hub, kindWord);
  if (!info) {
    const known = ['claude', 'claude-api', 'codex', ...Object.keys(hub.opts.config.anbieter), 'test'];
    throw new Error(`Art „${kindWord}“ kenne ich nicht. Möglich: ${known.join(', ')}`);
  }
  return { kind: info.kind, provider: info.provider, name: name || info.name, model: model || undefined };
}

/** Entfernt Anführungszeichen um den ganzen Text: /all "Hallo" → Hallo */
function unquote(s: string): string {
  const m = /^["'„“”](.*)["'“”]$/s.exec(s.trim());
  return m ? m[1]!.trim() : s.trim();
}

function agentArg(hub: Hub, word: string | undefined): string {
  if (!word) throw new Error('Name der Sitzung fehlt.');
  const id = hub.resolveId(word);
  if (!id || !hub.agents.has(id)) throw new Error(`Sitzung „${word}“ gibt es nicht.`);
  return id;
}

/** Verbindet einen anderen Vault und lädt das Projekt neu (die Sitzungen kommen wieder). */
function connectVault(hub: Hub, input: string, env: CommandEnv): string {
  const dir = connectVaultRoot(input);
  env.action({ type: 'projekt', cwd: hub.opts.cwd });
  return `Vault verbunden: ${dir}`;
}

/** Führt einen /befehl aus. Rückgabe ist ein kurzer Hinweis für die Fußzeile. */
export async function runCommand(line: string, env: CommandEnv): Promise<string | void> {
  const { hub, ui } = env;
  const [cmdRaw = '', ...rest] = line.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const restText = unquote(line.trim().slice(cmdRaw.length));

  switch (cmd) {
    case '/neu':
    case '/new': {
      if (!rest[0]) throw new Error('Welche Art? Zum Beispiel: /neu claude  ·  /neu codex  ·  /neu test');
      const spec = parseSpec(hub, rest[0], rest[1], rest[2]);
      const rec = await hub.addAgent(spec);
      ui.channel = `agent:${rec.name}`;
      ui.logView = false;
      if (rec.status === 'fehler') return `${rec.name}: ${rec.detail ?? 'Start fehlgeschlagen'}`;
      return `${rec.name} (${rec.label}) gestartet.`;
    }
    case '/dm':
    case '/privat': {
      const to = agentArg(hub, rest[0]);
      const text = unquote(line.trim().slice(cmdRaw.length).trim().slice(rest[0]!.length));
      if (!text) throw new Error('Text fehlt: /dm <name> <text>');
      hub.post(hub.human, to, text);
      ui.channel = `agent:${to}`;
      ui.logView = false;
      return;
    }
    case '/dringend': {
      const to = agentArg(hub, rest[0]);
      const text = unquote(line.trim().slice(cmdRaw.length).trim().slice(rest[0]!.length));
      if (!text) throw new Error('Text fehlt: /dringend <name> <text>');
      hub.post(hub.human, to, text, { urgent: true });
      ui.channel = `agent:${to}`;
      return `${to} wird unterbrochen.`;
    }
    case '/all':
    case '/alle':
    case '/team': {
      if (!restText) {
        ui.channel = 'team';
        return;
      }
      hub.post(hub.human, 'team', restText);
      ui.channel = 'team';
      return;
    }
    case '/aufgabe': {
      if (!restText) throw new Error('Titel fehlt: /aufgabe <titel>');
      const t = hub.tasks.add(hub.human, restText);
      return `Aufgabe #${t.id} angelegt.`;
    }
    case '/erledigt': {
      const id = Number((rest[0] ?? '').replace('#', ''));
      if (!Number.isInteger(id)) throw new Error('Nummer fehlt: /erledigt <nr> [nachweis]');
      const proof = restText.slice(rest[0]!.length).trim();
      hub.tasks.setStatus(hub.human, id, 'erledigt', proof || undefined);
      return `Aufgabe #${id} ist erledigt.`;
    }
    case '/offen': {
      const id = Number((rest[0] ?? '').replace('#', ''));
      if (!Number.isInteger(id)) throw new Error('Nummer fehlt: /offen <nr>');
      hub.tasks.setStatus(hub.human, id, 'offen');
      return `Aufgabe #${id} ist wieder offen.`;
    }
    case '/zuweisen': {
      const id = Number((rest[0] ?? '').replace('#', ''));
      if (!Number.isInteger(id)) throw new Error('So geht es: /zuweisen <nr> <name>');
      const name = agentArg(hub, rest[1]);
      const t = hub.tasks.assign(id, name);
      hub.post(hub.human, name, `Ich habe dir Aufgabe #${t.id} zugewiesen: ${t.title}${t.description ? ` – ${t.description}` : ''}. Bitte übernimm sie und melde dich, wenn du fertig bist.`);
      return `Aufgabe #${id} an ${name} zugewiesen.`;
    }
    case '/loeschen':
    case '/löschen': {
      const id = Number((rest[0] ?? '').replace('#', ''));
      if (!Number.isInteger(id)) throw new Error('Nummer fehlt: /loeschen <nr>');
      hub.tasks.remove(id);
      return `Aufgabe #${id} gelöscht.`;
    }
    case '/budget': {
      if (!rest[0]) {
        const parts = [...hub.agents.values()].map((a) => `${a.name}: ${a.budgetTokens ? a.budgetTokens.toLocaleString('de-DE') + ' Tokens' : 'keine Grenze'}`);
        return parts.length ? parts.join(' · ') : 'Keine Sitzungen offen.';
      }
      const raw = (rest[1] ?? '').toLowerCase().replace(',', '.');
      if (!raw) throw new Error('So geht es: /budget <name|alle> <zahl, z. B. 500k oder 2m> oder „aus“');
      let tokens = 0;
      if (raw !== 'aus' && raw !== '0') {
        const m = /^([0-9]+(?:\.[0-9]+)?)\s*([km]?)$/.exec(raw);
        if (!m) throw new Error('Die Zahl verstehe ich nicht. Beispiele: 500k, 2m, 300000, aus');
        tokens = Math.round(Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1000 : 1));
      }
      const names = rest[0].toLowerCase() === 'alle' ? [...hub.agents.keys()] : [agentArg(hub, rest[0])];
      for (const n of names) hub.setBudget(n, tokens);
      return tokens ? `Budget für ${names.join(', ')}: ${tokens.toLocaleString('de-DE')} Tokens.` : `Budget für ${names.join(', ')} aufgehoben.`;
    }
    case '/wieder': {
      if (!hub.lastRoster.length) return 'Beim letzten Mal war keine Sitzung offen.';
      const opened = await hub.reopenLast();
      return opened.length ? `Wieder geöffnet: ${opened.join(', ')}.` : 'Alle Sitzungen vom letzten Mal sind schon offen.';
    }
    case '/aufgaben':
      ui.channel = 'aufgaben';
      return;
    case '/verbrauch':
    case '/tokens':
      ui.channel = 'verbrauch';
      return;
    case '/stop': {
      if ((rest[0] ?? '').toLowerCase() === 'alle') {
        await Promise.allSettled([...hub.agents.keys()].map((n) => hub.interrupt(n)));
        return 'Alle Sitzungen unterbrochen.';
      }
      const name = agentArg(hub, rest[0] ?? (ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined));
      await hub.interrupt(name);
      return `${name} unterbrochen.`;
    }
    case '/ende':
    case '/schliessen':
    case '/close':
    case '/zu': {
      const name = agentArg(hub, rest[0] ?? (ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined));
      await hub.removeAgent(name);
      ui.channel = 'team';
      return `${name} geschlossen.`;
    }
    case '/trennen':
    case '/verbinden': {
      const name = agentArg(hub, rest[0] ?? (ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined));
      hub.setConnected(name, cmd === '/verbinden');
      return;
    }
    case '/pause':
      hub.pause();
      return 'Zustellung pausiert. Laufende Runden laufen zu Ende. /weiter setzt fort.';
    case '/weiter':
      hub.resume();
      return 'Es geht weiter.';
    case '/freigaben':
      ui.approvalsDeferred = false;
      return hub.approvals.length ? undefined : 'Keine offenen Freigaben.';
    case '/ja':
    case '/nein':
    case '/immer': {
      const ap = hub.approvals[0];
      if (!ap) return 'Keine offenen Freigaben.';
      hub.resolveApproval(ap.id, cmd.slice(1) as 'ja' | 'nein' | 'immer');
      return;
    }
    case '/terminal': {
      const name = agentArg(hub, rest[0] ?? (ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined));
      if (!hub.agents.get(name)?.adapter?.attachable) throw new Error(`${name} hat kein eigenes Terminal (nur Claude im Abo).`);
      env.action({ type: 'attach', agent: name });
      return;
    }
    case '/anmelden':
    case '/login': {
      if (!rest[0] && !ui.channel.startsWith('agent:')) {
        env.action({ type: 'konten' });
        return;
      }
      const name = agentArg(hub, rest[0] ?? (ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined));
      const a = hub.agents.get(name)!;
      if (a.adapter?.login) {
        void a.adapter.login().catch((e) => hub.system(`${name}: Anmeldung fehlgeschlagen – ${e instanceof Error ? e.message : String(e)}`));
        return `Anmeldung für ${name} gestartet – bitte im Browser abschließen.`;
      }
      if (a.adapter?.attachable) return `Bei ${name}: F12 drücken und im Terminal /login eingeben.`;
      return `${name} braucht einen API-Schlüssel: /schluessel <anbieter> <wert>, danach /ende ${name} und neu öffnen.`;
    }
    case '/konten':
    case '/anmeldung':
      env.action({ type: 'konten' });
      return;
    case '/vault':
      if (!restText.trim()) return `Team-Vault: ${hub.opts.vault.root}   (anderen verbinden: /vault <ordner>)`;
      return connectVault(hub, restText, env);
    case '/leeren':
    case '/chat-leeren': {
      if (ui.channel !== 'team' && !ui.channel.startsWith('agent:')) throw new Error('Hier gibt es nichts zu leeren. Wechsle in den Team-Chat oder einen Privatchat.');
      const n = hub.clearChannel(ui.channel);
      ui.seen[ui.channel] = 0;
      return n ? 'Chat geleert.' : 'Der Chat war schon leer.';
    }
    case '/guthaben':
    case '/balance': {
      if (!hub.balance) return 'Guthaben wird hier nicht abgefragt.';
      const watch = hub.balance;
      return watch.refresh().then(() => {
        if (!watch.balances.length) return 'Kein API-Anbieter mit Schlüssel verbunden.';
        return watch.balances.map((b) => `${providerLabel(b.anbieter)}: ${fmtMoney(b)}`).join(' · ');
      });
    }
    case '/schluessel':
    case '/key': {
      const provider = (rest[0] ?? '').toLowerCase();
      const value = rest[1];
      const envName = keyEnvFor(hub.opts.config, provider);
      if (!envName) throw new Error('Anbieter unbekannt. Möglich: anthropic, deepseek, openrouter');
      if (!value) throw new Error(`Wert fehlt: /schluessel ${provider} <schlüssel>`);
      saveKey(envName, value);
      void hub.balance?.refresh();
      return `Schlüssel für ${provider} gespeichert (nur auf diesem Rechner, in ~/.remoteharnes/keys.json).`;
    }
    case '/hilfe':
    case '/help':
    case '/?':
      ui.channel = 'hilfe';
      ui.scroll.hilfe = 9999; // Hilfe beginnt oben
      return;
    case '/quit':
    case '/exit':
    case '/beenden':
      env.action({ type: 'quit' });
      return;
    // ---------- vertraute Befehle aus Claude Code und Codex ----------
    case '/model':
    case '/modell': {
      // /model [name] <modell> – im Kanal einer Sitzung genügt das Modell
      const here = ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined;
      const first = rest[0] && hub.agents.has(rest[0].toLowerCase()) ? rest[0].toLowerCase() : undefined;
      const name = first ?? here;
      const model = (first ? rest.slice(1) : rest).join(' ');
      if (!name) throw new Error('Für welche Sitzung? Wechsle in ihren Kanal oder: /model <name> <modell>');
      if (!model) {
        ui.channel = `agent:${name}`;
        ui.openMenu = 'modell';
        return;
      }
      return hub.setModel(name, model);
    }
    case '/rename':
    case '/umbenennen': {
      const here = ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined;
      const [oldName, newName] = rest.length >= 2 ? [agentArg(hub, rest[0]), rest[1]!] : [here, rest[0]];
      if (!oldName) throw new Error('Welche Sitzung? Wechsle in ihren Kanal oder: /rename <alt> <neu>');
      if (!newName) {
        ui.channel = `agent:${oldName}`;
        ui.openMenu = 'umbenennen';
        return;
      }
      const done = hub.renameAgent(oldName, newName);
      if (ui.channel === `agent:${oldName}`) ui.channel = `agent:${done}`;
      return `${oldName} heißt jetzt ${done}.`;
    }
    case '/cost':
    case '/usage':
    case '/status':
    case '/kosten':
      ui.channel = 'verbrauch';
      return;
    case '/begleiter':
      return startBegleiter();
    case '/zeige':
    case '/zeig': {
      // Zeige-Modus (vom HarnesBrowser): Frage an eine Sitzung, die auf dem Bildschirm zeigt
      if (!restText.trim()) throw new Error('Was soll ich zeigen? /zeige <frage>');
      const here = ui.channel.startsWith('agent:') ? hub.agents.get(ui.channel.slice(6)) : undefined;
      const live = hub.liveAgents();
      const pick = here ?? live.find((a) => a.spec.kind === 'claude-abo' || a.spec.kind === 'claude-api') ?? live[0];
      if (!pick) throw new Error('Keine Sitzung offen, die zeigen könnte. Esc → Neue Sitzung.');
      hub.post(hub.human, pick.name, `[Zeige-Modus] ${restText.trim()}

Rufe zuerst bildschirm_foto auf (Bildschirm im Moment der Frage). Antworte kurz und zeige mit bildschirm_zeigen Schritt für Schritt auf die Stellen.`);
      ui.channel = `agent:${pick.name}`;
      return `${pick.name} schaut sich deinen Bildschirm an …`;
    }
    case '/suche':
    case '/search': {
      if (!restText.trim()) {
        ui.openMenu = 'suche';
        return;
      }
      ui.search = restText.trim();
      ui.channel = 'suche';
      return;
    }
    case '/rolle':
    case '/role': {
      const here = ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined;
      const [n, r] = rest.length >= 2 ? [agentArg(hub, rest[0]), rest[1]!] : [here, rest[0]];
      if (!n) throw new Error('Für welche Sitzung? Wechsle in ihren Kanal oder: /rolle <name> <rolle>');
      if (!r) {
        ui.channel = `agent:${n}`;
        ui.openMenu = 'rolle';
        return;
      }
      return hub.setRole(n, r);
    }
    case '/projekt':
    case '/projekte':
    case '/ordner':
      env.action({ type: 'home', view: 'projekte' });
      return;
    case '/start':
    case '/home':
    case '/startseite':
      env.action({ type: 'home' });
      return;
    case '/menu':
    case '/menue':
    case '/menü':
      ui.openMenu = 'haupt';
      return;
    case '/einrichtung':
    case '/setup':
    case '/config':
      env.action({ type: 'einrichtung' });
      return;
    case '/abmelden':
    case '/logout': {
      const which = (rest[0] ?? 'claude').toLowerCase().startsWith('codex') ? 'codex' : 'claude';
      return logoutOf(hub.opts.config, which);
    }
    case '/maus':
    case '/mouse': {
      const on = !['aus', 'off', '0', 'nein'].includes((rest[0] ?? '').toLowerCase());
      setMouseEnabled(on);
      return on ? 'Maus an: klicken und mit dem Rad blättern. Text markieren mit gedrückter Umschalttaste.' : 'Maus aus: Text lässt sich wieder direkt markieren.';
    }
    default: {
      // Unbekannte Befehle im Kanal einer Sitzung gehen an die Sitzung selbst (z. B. /compact, /review)
      const here = ui.channel.startsWith('agent:') ? ui.channel.slice(6) : undefined;
      // /clear im Privatchat: Chat in Harnes leeren und (bei Claude Code) auch das Gespräch der Sitzung neu beginnen
      if (cmd === '/clear' && here) {
        hub.clearChannel(ui.channel);
        ui.seen[ui.channel] = 0;
        if (hub.agents.get(here)?.adapter?.command) await hub.sendCommand(here, line.trim());
        return 'Chat geleert.';
      }
      if (here && hub.agents.get(here)?.adapter?.command) return hub.sendCommand(here, line.trim());
      if (cmd === '/clear' && ui.channel === 'team') {
        const n = hub.clearChannel('team');
        ui.seen.team = 0;
        return n ? 'Team-Chat geleert.' : 'Der Team-Chat war schon leer.';
      }
      if (cmd === '/clear' || cmd === '/compact') throw new Error(`${cmd} wirkt im Kanal einer Sitzung – wechsle dorthin (Tab).`);
      throw new Error(`Befehl ${cmd} kenne ich nicht. /hilfe zeigt alle Befehle.`);
    }
  }
}

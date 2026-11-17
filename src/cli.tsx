#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { createAdapter } from './adapters/index.js';
import { claudeProgram, codexProgram, type AuthInfo } from './auth.js';
import { configPath, homeDir, loadConfig, runtimeMcp, updateConfig, type Config } from './config.js';
import { startBrowser } from './browser-start.js';
import { notifyBegleiter, startBegleiter } from './begleiter.js';
import { BalanceWatch } from './balance.js';
import { rememberProject } from './projects.js';
import { Hub } from './hub/hub.js';
import { startServer } from './hub/server.js';
import { Store } from './hub/store.js';
import { Vault } from './hub/vault.js';
import { App } from './ui/App.js';
import { parseSpec } from './ui/commands.js';
import { runInteractive } from './ui/interactive.js';
import { passthrough, type AttachTarget } from './ui/passthrough.js';
import { Start, startRows, type StartAction, type StartRow } from './ui/Start.js';
import { Home, type HomeAction } from './ui/Home.js';
import { Setup, createSetupState, type SetupAction } from './ui/Setup.js';
import { createUiState, type UiAction } from './ui/state.js';
import { pauseInput, resumeInput, terminalInput } from './ui/wininput.js';
import { errText, safeName } from './util.js';

const VERSION = '0.1.9';

const HELP = `Harnes ${VERSION} – KI-Sitzungen als Team

Aufruf:
  harnes [projektordner] [optionen]

Optionen:
  --name <projekt>     Name des Projekts (Vorgabe: Name des Ordners)
  --vault <ordner>     Ordner für den Team-Vault dieses Projekts
  --mit <liste>        Sitzungen gleich öffnen, z. B. --mit claude,codex
                       oder mit Namen: --mit test:anna,test:ben
  --fenster, -f        in einem eigenen Terminal-Fenster öffnen
  --browser            im HarnesBrowser öffnen (Webseiten links, Team rechts)
  --begleiter          den Begleiter starten (Zeiger an der Maus, Sprechen mit Strg+Alt)
  --direkt             gleich in die Chats
  --konten             mit der Übersicht aller Anmeldungen beginnen
  --einrichtung        die Einrichtung (erster Start) erneut durchlaufen
  --hilfe, --help      diese Hilfe
  --version            Version

Arten von Sitzungen: claude (Abo), claude-api, codex, deepseek, openrouter,
ollama, lmstudio, test (ohne KI).

Einstellungen: ${configPath()}
Lizenz: kostenlos nutzbar, Code © davidhbg, alle Rechte vorbehalten (siehe LICENSE)
`;

interface Args {
  cwd: string;
  name?: string;
  vault?: string;
  mit: string[];
  fenster: boolean;
  direkt: boolean;
  konten: boolean;
  einrichtung: boolean;
  /** alle Angaben außer --fenster, zum Weiterreichen an das neue Fenster */
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { cwd: process.cwd(), mit: [], fenster: false, direkt: false, konten: false, einrichtung: false, rest: [] };
  for (const a of argv) if (a !== '--fenster' && a !== '-f') out.rest.push(a);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--hilfe' || a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '--version' || a === '-v') {
      process.stdout.write(VERSION + '\n');
      process.exit(0);
    } else if (a === '--fenster' || a === '-f') out.fenster = true;
    else if (a === '--direkt') out.direkt = true;
    else if (a === '--konten') out.konten = true;
    else if (a === '--einrichtung') out.einrichtung = true;
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--vault') out.vault = argv[++i];
    else if (a === '--mit') out.mit.push(...(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith('--')) {
      process.stderr.write(`Unbekannte Option ${a}\n\n${HELP}`);
      process.exit(2);
    } else out.cwd = resolve(a);
  }
  return out;
}

/** Öffnet Harnes in einem eigenen Terminal-Fenster und kehrt sofort zurück. */
function openInNewWindow(args: Args): void {
  const cli = fileURLToPath(import.meta.url);
  const rest = args.rest.filter((a) => a.startsWith('-') || resolve(a) !== args.cwd);
  const run = [process.execPath, cli, args.cwd, ...rest];
  let cmd: string;
  let cmdArgs: string[];
  let verbatim = false;
  if (process.platform === 'win32') {
    // Über cmd starten: Windows Terminal reicht einen direkt übergebenen node-Aufruf nicht zuverlässig weiter.
    const line = run.map((a) => (/^[A-Za-z0-9_.:,\\/-]+$/.test(a) ? a : `"${a}"`)).join(' ');
    // wt.exe ist eine App-Verknüpfung, die existsSync nicht erkennt – deshalb einfach versuchen.
    cmd = 'wt.exe';
    cmdArgs = ['-w', 'new', '--title', 'Harnes', '-d', args.cwd, 'cmd', '/c', line];
    const fallback = () => {
      // Ohne Windows Terminal: klassisches Konsolenfenster
      const c = spawn('cmd.exe', ['/c', `start "Harnes" cmd /c "${line}"`], {
        cwd: args.cwd,
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      });
      c.on('spawn', () => done(c));
      c.on('error', (e) => fail(e));
    };
    const first = spawn(cmd, cmdArgs, { cwd: args.cwd, detached: true, stdio: 'ignore' });
    first.on('spawn', () => done(first));
    first.on('error', () => fallback());
    return;
  } else if (process.platform === 'darwin') {
    const line = run.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    cmd = 'osascript';
    cmdArgs = ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'];
  } else {
    cmd = 'x-terminal-emulator';
    cmdArgs = ['-e', ...run];
  }
  const child = spawn(cmd, cmdArgs, { cwd: args.cwd, detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim });
  child.on('error', (e) => fail(e));
  child.on('spawn', () => done(child));

  function fail(e: unknown): void {
    process.stderr.write(`Ein eigenes Fenster ging nicht (${errText(e)}). Starte ohne --fenster.\n`);
    process.exit(1);
  }
  function done(c: ReturnType<typeof spawn>): void {
    c.unref();
    process.stdout.write(`Harnes öffnet sich in einem eigenen Fenster (${args.cwd}).\n`);
    // Kurz warten, bis das Terminal das Fenster übernommen hat; sonst geht der Aufruf verloren.
    setTimeout(() => process.exit(0), 1500);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--begleiter')) {
    process.stdout.write(startBegleiter() + '\n');
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (process.argv.includes('--browser')) {
    startBrowser(process.argv.slice(2).filter((a) => a !== '--browser'));
    setTimeout(() => process.exit(0), 800);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.fenster) {
    if (!existsSync(args.cwd) || !statSync(args.cwd).isDirectory()) {
      process.stderr.write(`Den Ordner ${args.cwd} gibt es nicht.\n`);
      process.exit(2);
    }
    args.cwd = realpathSync.native(args.cwd);
    openInNewWindow(args);
    return;
  }
  if (!existsSync(args.cwd) || !statSync(args.cwd).isDirectory()) {
    process.stderr.write(`Den Ordner ${args.cwd} gibt es nicht.\n`);
    process.exit(2);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('Harnes braucht ein richtiges Terminal (z. B. Windows Terminal).\n');
    process.exit(2);
  }

  // Warnungen von Node würden mitten in die Oberfläche geschrieben – unterdrücken.
  process.removeAllListeners('warning');
  process.on('warning', () => undefined);

  // Ein Durchlauf je Projekt; „Projekt wechseln“ beendet ihn und startet den nächsten im selben Fenster
  for (;;) {
  let nextCwd: string | undefined;
  let reloadTo: 'home' | 'team' = 'home';
  let carryMit: string[] | undefined;
  args.cwd = realpathSync.native(args.cwd); // ausgeschriebener Pfad ohne Kurznamen
  const config = loadConfig();
  const project = args.name?.trim() || basename(args.cwd) || 'Projekt';
  rememberProject(project, args.cwd);
  const distDir = dirname(fileURLToPath(import.meta.url));
  // Läuft Harnes im HarnesBrowser, bekommt jede Sitzung den Browser als Werkzeug
  if (process.env.RH_BROWSER_URL && process.env.RH_BROWSER_TOKEN) {
    runtimeMcp.browser = {
      befehl: process.execPath,
      args: [join(distDir, 'browser-mcp.js')],
      env: { RH_BROWSER_URL: process.env.RH_BROWSER_URL, RH_BROWSER_TOKEN: process.env.RH_BROWSER_TOKEN },
    };
  }
  const vault = new Vault(args.vault ? resolve(args.vault) : join(config.vaultRoot, safeName(project)), project, config.benutzer);
  vault.init();
  const hub = new Hub({
    project,
    cwd: args.cwd,
    config,
    store: new Store(join(homeDir(), 'projects', safeName(project))),
    vault,
    mcpServerPath: join(distDir, 'mcp.js'),
    createAdapter,
  });
  const server = await startServer(hub);
  // Guthaben der API-Anbieter: beim Start und alle 5 Minuten (nur wo abfragbar)
  hub.balance = new BalanceWatch(config, () => hub.notifyChange());
  hub.balance.start();
  // Wichtiges (Freigaben, Nachrichten an dich, Budget) zeigt und sagt auch der Begleiter an, falls er läuft
  hub.on('attention', (a: { titel?: string; text?: string }) => void notifyBegleiter(a.titel ?? 'Harnes', a.text ?? ''));

  for (const item of args.mit) {
    const [kind = '', name, model] = item.split(':');
    try {
      void hub.addAgent(parseSpec(hub, kind, name, model));
    } catch (e) {
      hub.system(errText(e));
    }
  }

  const ui = createUiState();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    hub.balance?.stop();
    await Promise.race([hub.shutdown(), new Promise((r) => setTimeout(r, 4000))]);
    await server.close().catch(() => undefined);
  };
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGHUP', () => void shutdown().then(() => process.exit(0)));

  // ---------- Anmeldebildschirm ----------
  const rows = startRows(config);
  const status: Record<string, AuthInfo> = {};
  const selected = new Set<string>(loadSelection().filter((id) => rows.some((r) => r.id === id)));
  // Erster Start: Einrichtung Schritt für Schritt. Danach geht es direkt in die Chats.
  // Start: Ladebildschirm und Startseite (beim ersten Mal mit Einrichtung dazwischen)
  let phase: 'home' | 'setup' | 'start' | 'team' = args.konten ? 'start' : args.einrichtung ? 'setup' : args.mit.length || args.direkt ? 'team' : 'home';
  let firstBoot = true;
  let homeView: 'projekte' | undefined;
  const setup = createSetupState();
  if (!args.mit.length && config.eingerichtet) {
    // genau die Sitzungen wieder öffnen, die beim letzten Beenden offen waren (geschlossene bleiben zu)
    void hub.reopenLast().catch((e) => hub.system(errText(e)));
  }
  let recheck: string[] = [];
  let startNotice = '';
  const pos = { cursor: 0 };
  let firstStart = true;
  // Eigener Eingabestrom: nimmt Mausmeldungen heraus; unter Windows liest ein Hilfsprogramm (ui/wininput.ts)
  const stdin = terminalInput();
  const renderOpts = { exitOnCtrlC: false, alternateScreen: true, incrementalRendering: true, patchConsole: false, ...(stdin ? { stdin } : {}) } as const;

  for (;;) {
    if (phase === 'home') {
      const result: { action: HomeAction } = { action: { type: 'quit' } };
      const app = render(
        <Home
          hub={hub}
          config={config}
          project={project}
          boot={firstBoot}
          needsSetup={!config.eingerichtet}
          startView={homeView}
          onAction={(a) => {
            result.action = a;
          }}
        />,
        renderOpts,
      );
      await app.waitUntilExit();
      homeView = undefined;
      firstBoot = false;
      firstStart = false;
      const action = result.action;
      if (action.type === 'quit') break;
      if (action.type === 'einrichtung') {
        phase = 'setup';
        if (config.eingerichtet) {
          // Prüfen und reparieren: alle Zugänge neu prüfen, gleich bei der Auswahl beginnen
          setup.step = 'auswahl';
          setup.chosen = [...selected];
          recheck = rows.map((r) => r.id);
        }
        continue;
      }
      if (action.type === 'konten') {
        phase = 'start';
        recheck = rows.map((r) => r.id);
        continue;
      }
      if (action.type === 'projekt') {
        nextCwd = action.cwd;
        reloadTo = 'home';
        break;
      }
      ui.channel = action.channel;
      if (action.menu) ui.openMenu = action.menu;
      phase = 'team';
      continue;
    }
    if (phase === 'setup') {
      const result: { action: SetupAction } = { action: { type: 'quit' } };
      const app = render(
        <Setup
          config={config}
          rows={rows}
          status={status}
          state={setup}
          recheck={recheck}
          notice={startNotice}
          onAction={(a) => {
            result.action = a;
          }}
        />,
        renderOpts,
      );
      await app.waitUntilExit();
      recheck = [];
      startNotice = '';
      const action = result.action;
      if (action.type === 'quit') break;
      if (action.type === 'login') {
        const row = rows.find((r) => r.id === action.row)!;
        pauseInput();
        startNotice = await loginWith(row, config, args.cwd);
        resumeInput();
        recheck = [row.id];
        continue;
      }
      config.eingerichtet = true;
      updateConfig((c) => {
        c.eingerichtet = true;
      });
      selected.clear();
      for (const id of action.rows) selected.add(id);
      saveSelection([...selected]);
      if (action.nameChanged || action.vaultChanged) {
        // neuer Name oder neues Gedächtnis: Projekt neu laden, die gewählten Sitzungen gleich mit öffnen
        carryMit = action.rows.map((id) => rows.find((r) => r.id === id)!).map((r) => `${r.kind}:${r.name}`);
        nextCwd = args.cwd;
        reloadTo = 'team';
        break;
      }
      for (const id of action.rows) {
        const row = rows.find((r) => r.id === id)!;
        if (hub.agents.has(row.name)) continue;
        try {
          void hub.addAgent(parseSpec(hub, row.kind, row.name));
        } catch (e) {
          hub.system(errText(e));
        }
      }
      phase = 'home';
      continue;
    }
    if (phase === 'start') {
      const running = new Set(rows.filter((r) => hub.agents.has(r.name)).map((r) => r.id));
      const result: { action: StartAction } = { action: { type: 'quit' } };
      const app = render(
        <Start
          config={config}
          project={project}
          cwd={args.cwd}
          rows={rows}
          status={status}
          selected={selected}
          running={running}
          recheck={recheck}
          pos={pos}
          boot={firstStart}
          notice={startNotice}
          onAction={(a) => {
            result.action = a;
          }}
        />,
        renderOpts,
      );
      await app.waitUntilExit();
      firstStart = false;
      recheck = [];
      startNotice = '';
      const action = result.action;
      if (action.type === 'quit') break;
      if (action.type === 'login') {
        const row = rows.find((r) => r.id === action.row)!;
        pauseInput();
        startNotice = await loginWith(row, config, args.cwd);
        resumeInput();
        recheck = [row.id];
        continue;
      }
      // Team starten
      saveSelection([...selected]);
      for (const id of action.rows) {
        const row = rows.find((r) => r.id === id)!;
        if (hub.agents.has(row.name)) continue;
        try {
          void hub.addAgent(parseSpec(hub, row.kind, row.name));
        } catch (e) {
          hub.system(errText(e));
        }
      }
      phase = 'team';
      continue;
    }

    const result: { action: UiAction } = { action: { type: 'quit' } };
    void hub.balance?.refresh(false);
    const app = render(
      <App
        hub={hub}
        ui={ui}
        project={project}
        onAction={(a) => {
          result.action = a;
        }}
      />,
      renderOpts,
    );
    await app.waitUntilExit();
    const action = result.action;
    if (action.type === 'home') {
      phase = 'home';
      homeView = action.view;
      continue;
    }
    if (action.type === 'einrichtung') {
      phase = 'setup';
      setup.step = 'auswahl';
      setup.chosen = [...selected];
      recheck = rows.map((r) => r.id);
      continue;
    }
    if (action.type === 'konten') {
      phase = 'start';
      recheck = rows.map((r) => r.id);
      continue;
    }
    if (action.type === 'projekt') {
      nextCwd = action.cwd;
      reloadTo = 'team';
      break;
    }
    if (action.type !== 'attach') break;
    const target = hub.agents.get(action.agent)?.adapter as unknown as AttachTarget | undefined;
    if (target?.attach) await passthrough(target, action.agent, stdin);
  }

  await shutdown();
  if (!nextCwd) break;
  const same = nextCwd.toLowerCase() === args.cwd.toLowerCase();
  args.cwd = nextCwd;
  args.mit = carryMit ?? [];
  carryMit = undefined;
  if (!same) args.name = undefined;
  args.vault = undefined;
  args.konten = false;
  args.einrichtung = false;
  // derselbe Ordner (z. B. nach „Vault verbinden“): dorthin zurück, wo man war
  args.direkt = same && reloadTo === 'team';
  }
  process.exit(0);
}

function loadSelection(): string[] {
  try {
    return JSON.parse(readFileSync(join(homeDir(), 'start.json'), 'utf8')) as string[];
  } catch {
    return [];
  }
}

function saveSelection(ids: string[]): void {
  try {
    writeFileSync(join(homeDir(), 'start.json'), JSON.stringify(ids), 'utf8');
  } catch {
    /* nicht wichtig */
  }
}

/**
 * Anmeldung über das offizielle Programm im echten Terminal: „claude auth login“
 * bzw. „codex login“. Harnes sieht dabei keine Anmeldedaten.
 */
async function loginWith(row: StartRow, config: Config, cwd: string): Promise<string> {
  try {
    if (row.login === 'claude') {
      const p = claudeProgram(config);
      const code = await runInteractive(p.command, [...p.prefix, 'auth', 'login', '--claudeai'], { cwd, title: 'Anmeldung bei Claude' });
      return code === 0 ? 'Claude: Anmeldung abgeschlossen, wird geprüft …' : 'Claude: Anmeldung abgebrochen oder fehlgeschlagen.';
    }
    if (row.login === 'codex') {
      const p = codexProgram(config);
      const code = await runInteractive(p.command, [...p.prefix, 'login'], { cwd, title: 'Anmeldung bei Codex (ChatGPT)' });
      return code === 0 ? 'Codex: Anmeldung abgeschlossen, wird geprüft …' : 'Codex: Anmeldung abgebrochen oder fehlgeschlagen.';
    }
  } catch (e) {
    return `${row.label}: ${errText(e)}`;
  }
  return '';
}

main().catch((e) => {
  process.stderr.write(`Harnes: ${errText(e)}\n`);
  process.exit(1);
});

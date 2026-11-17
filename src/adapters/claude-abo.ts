import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import serializePkg from '@xterm/addon-serialize';
import xtermPkg from '@xterm/headless';
import pty from 'node-pty';
import type { Message } from '../types.js';
import { errText, truncate } from '../util.js';
import type { Adapter, AdapterContext } from './adapter.js';
import { cleanEnv, findOnPath, summarizeToolInput } from './common.js';
import { reposDir } from '../hub/repos.js';
import { allMcp } from '../config.js';
import { BROWSER_FREE } from '../hub/browser.js';

const { Terminal } = xtermPkg;
const { SerializeAddon } = serializePkg;

const NUDGE = 'Harnes: neue Nachrichten';
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

type Json = Record<string, unknown>;

/**
 * Claude Variante B: das echte Claude Code mit dem eigenen Abo.
 * Claude Code läuft unverändert in einem Pseudo-Terminal und meldet sich mit
 * seinem eigenen Login an – Harnes liest oder verwendet die Anmeldedaten nie.
 * Die Verbindung zum Team läuft über offizielle Wege: einen MCP-Server
 * (Team-Werkzeuge) und Hooks (Post zustellen, wenn Claude eine Pause macht).
 */
export class ClaudeAboAdapter implements Adapter {
  readonly controlled = false;
  readonly attachable = true;
  private proc?: pty.IPty;
  private term?: InstanceType<typeof Terminal>;
  private ser?: InstanceType<typeof SerializeAddon>;
  private attached?: { onData: (d: string) => void; onExit: () => void };
  private attachBuffer: string[] | null = null;
  private stopped = false;
  private exited = false;
  private ready = false;
  private blocks = 0;
  private nudgeAt = 0;
  private working = false;
  private exclusive = false;
  private tmp = '';
  private transcript = '';
  private transcriptOffset = 0;
  private transcriptTail = '';
  private usageById = new Map<string, { input: number; output: number; cache: number; context: number }>();
  private readyTimer?: NodeJS.Timeout;
  private onResize = () => this.resize(process.stdout.columns || 120, process.stdout.rows || 40);

  constructor(private ctx: AdapterContext) {}

  async start(): Promise<void> {
    const { ctx } = this;
    const configured = ctx.config.claudeAbo.befehl || 'claude';
    const command = isAbsolute(configured)
      ? configured
      : findOnPath(process.platform === 'win32' ? [`${configured}.exe`, `${configured}.cmd`] : [configured]);
    if (!command) {
      throw new Error('Claude Code wurde nicht gefunden. Installiere es oder trage den Pfad in der config.json unter claudeAbo.befehl ein.');
    }

    this.tmp = join(tmpdir(), `remoteharnes-${ctx.token.slice(0, 10)}`);
    mkdirSync(this.tmp, { recursive: true });
    // Befehls-Hooks (direkt gestartet, ohne Shell): Sie funktionieren bei jedem Ereignis,
    // HTTP-Hooks löst Claude Code z. B. beim Sitzungsstart nicht aus.
    const hookScript = join(dirname(ctx.mcpServerPath), 'hook.js');
    const hook = (event: string, timeout: number, matcher?: string) => [
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          { type: 'command', command: process.execPath, args: [hookScript, `${ctx.hubUrl}/hook/${ctx.token}/${event}`], timeout },
        ],
      },
    ];
    const settings = {
      hooks: {
        SessionStart: hook('SessionStart', 15),
        UserPromptSubmit: hook('UserPromptSubmit', 20),
        Stop: hook('Stop', 20),
        StopFailure: hook('StopFailure', 10),
        Notification: hook('Notification', 10),
        PreToolUse: hook('PreToolUse', 10, 'Edit|Write|MultiEdit|NotebookEdit'),
        PermissionRequest: hook('PermissionRequest', 300),
      },
      // Team-Werkzeuge und Browser frei; JavaScript im Browser fragt weiter nach
      permissions: { allow: ['mcp__remoteharnes', ...BROWSER_FREE.map((t) => `mcp__browser__${t}`)] },
    };
    const mcp = {
      mcpServers: {
        remoteharnes: {
          command: process.execPath,
          args: [ctx.mcpServerPath],
          env: { REMOTEHARNES_URL: ctx.hubUrl, REMOTEHARNES_TOKEN: ctx.token },
        },
        // eigene MCP-Server aus den Einstellungen
        ...Object.fromEntries(Object.entries(allMcp(ctx.config)).map(([n, m]) => [n, { command: m.befehl, args: m.args ?? [], env: m.env ?? {} }])),
      },
    };
    const settingsFile = join(this.tmp, 'settings.json');
    const mcpFile = join(this.tmp, 'mcp.json');
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    writeFileSync(mcpFile, JSON.stringify(mcp, null, 2), 'utf8');

    const model = ctx.spec.model || ctx.config.claudeAbo.modell;
    const args = ['--mcp-config', mcpFile, '--settings', settingsFile, '--name', `Harnes · ${ctx.name}`];
    // Ordner mit den bereitgestellten Repos aus dem Store: lesen ohne Rückfrage
    mkdirSync(reposDir(), { recursive: true });
    args.push('--add-dir', reposDir());
    if (model) args.push('--model', model);
    args.push(...ctx.config.claudeAbo.extraArgs);

    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    this.term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.ser = new SerializeAddon();
    this.term.loadAddon(this.ser);
    this.proc = pty.spawn(viaCmd ? 'cmd.exe' : command, viaCmd ? ['/c', command, ...args] : args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: ctx.cwd,
      env: cleanEnv(['CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']),
    });
    this.proc.onData((d) => {
      this.term!.write(d);
      if (this.attachBuffer) this.attachBuffer.push(d);
      else this.attached?.onData(d);
    });
    // Solange niemand zuschaut, beantwortet das Hintergrund-Terminal die Rückfragen des Programms.
    this.term.onData((d) => {
      if (!this.attached && !this.attachBuffer) this.proc?.write(d);
    });
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.attached?.onExit();
      this.attached = undefined;
      if (this.stopped) return;
      ctx.log('info', `Claude Code wurde beendet (Code ${exitCode}).`);
      ctx.status(this.ready ? 'beendet' : 'fehler', this.ready ? undefined : 'Claude Code hat sich sofort beendet. Mit /neu claude neu starten.');
    });
    process.stdout.on('resize', this.onResize);

    ctx.status('startet', 'Claude Code startet');
    this.readyTimer = setTimeout(() => {
      if (!this.ready && !this.stopped) {
        ctx.status('startet', 'Claude Code wartet vermutlich auf eine Bestätigung (Ordner vertrauen oder Anmeldung). Bitte im Terminal der Sitzung nachsehen.');
        ctx.notice(`${ctx.name}: Claude Code wartet möglicherweise auf eine Bestätigung (Ordner vertrauen oder Anmeldung). Öffne das Terminal der Sitzung und bestätige dort.`);
      }
    }, 25_000);
    this.readyTimer.unref();
  }

  private resize(cols: number, rows: number): void {
    if (this.stopped || !this.proc || !this.term) return;
    if (cols === this.term.cols && rows === this.term.rows) return;
    try {
      this.proc.resize(cols, rows);
      this.term.resize(cols, rows);
    } catch {
      /* Sitzung schon weg */
    }
  }

  /**
   * Verbrauch aus dem Gesprächsprotokoll von Claude Code lesen (nur die neuen Zeilen).
   * Jede Antwort steht dort mit ihrem Token-Verbrauch; mehrere Zeilen derselben Antwort
   * tragen dieselbe Kennung und zählen nur einmal.
   */
  private updateUsage(transcriptPath: string): void {
    if (!transcriptPath) return;
    try {
      const path = transcriptPath.startsWith('~') ? join(homedir(), transcriptPath.slice(1)) : transcriptPath;
      if (path !== this.transcript) {
        this.transcript = path;
        this.transcriptOffset = 0;
        this.transcriptTail = '';
        this.usageById.clear();
      }
      const size = statSync(path).size;
      if (size < this.transcriptOffset) {
        this.transcriptOffset = 0;
        this.transcriptTail = '';
        this.usageById.clear();
      }
      if (size === this.transcriptOffset) return;
      const fd = openSync(path, 'r');
      const buf = Buffer.alloc(size - this.transcriptOffset);
      readSync(fd, buf, 0, buf.length, this.transcriptOffset);
      closeSync(fd);
      this.transcriptOffset = size;
      const lines = (this.transcriptTail + buf.toString('utf8')).split('\n');
      this.transcriptTail = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        try {
          const entry = JSON.parse(line) as { type?: string; message?: { id?: string; usage?: Record<string, number> } };
          const u = entry.message?.usage;
          if (entry.type !== 'assistant' || !u) continue;
          this.usageById.set(entry.message?.id ?? `zeile-${this.usageById.size}`, {
            // Zwischengespeicherte Wiederholungen (cache_read) zählen nicht: kosten kaum etwas
            input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            output: u.output_tokens ?? 0,
            cache: u.cache_read_input_tokens ?? 0,
            context: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
          });
        } catch {
          /* unvollständige Zeile */
        }
      }
      let input = 0;
      let output = 0;
      let cache = 0;
      let context = 0;
      for (const u of this.usageById.values()) {
        input += u.input;
        output += u.output;
        cache += u.cache;
        context = u.context; // die letzte Antwort zeigt die aktuelle Größe
      }
      this.ctx.usage({ inputTokens: input, outputTokens: output, cacheReadTokens: cache, contextTokens: context }, 'set');
    } catch {
      /* Protokoll nicht lesbar: dann eben ohne Verbrauchsanzeige */
    }
  }

  // ---------- Hooks aus Claude Code ----------

  async onHook(event: string, input: Json): Promise<Json | null> {
    const { ctx } = this;
    switch (event) {
      case 'SessionStart': {
        if (!this.ready) ctx.log('info', 'Claude Code ist bereit.');
        this.ready = true;
        this.blocks = 0;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        ctx.status('wartet');
        return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx.systemPrompt } };
      }
      case 'UserPromptSubmit': {
        this.ready = true;
        this.nudgeAt = 0;
        this.working = true;
        const delivery = ctx.takeDelivery();
        ctx.status('arbeitet');
        if (delivery) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: delivery } };
        if (String(input.prompt ?? '').startsWith(NUDGE)) {
          return {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: 'Der Posteingang ist inzwischen leer. Antworte nur mit [kein Beitrag].',
            },
          };
        }
        return null;
      }
      case 'Stop': {
        this.updateUsage(String(input.transcript_path ?? ''));
        // Das Protokoll enthält die letzte Antwort manchmal erst kurz nach dem Rundenende: noch einmal nachlesen.
        setTimeout(() => !this.stopped && this.updateUsage(String(input.transcript_path ?? '')), 1500).unref();
        ctx.finalText(String(input.last_assistant_message ?? ''));
        // Höchstens 6 Zustellungen direkt hintereinander (Claude Code bricht nach 8 ab), danach neu anstoßen.
        if (this.blocks < 6) {
          const delivery = ctx.takeDelivery();
          if (delivery) {
            this.blocks++;
            ctx.status('arbeitet');
            return { decision: 'block', reason: delivery };
          }
        }
        this.blocks = 0;
        this.working = false;
        ctx.status('wartet');
        return null;
      }
      case 'StopFailure': {
        // Runde endete mit einem API-Fehler (z. B. Login abgelaufen, Limit erreicht).
        this.updateUsage(String(input.transcript_path ?? ''));
        this.working = false;
        this.blocks = 0;
        ctx.finalText('');
        const kind = String(input.error ?? 'unknown');
        const shown = truncate(String(input.last_assistant_message ?? input.error_details ?? kind), 160);
        const hint =
          kind === 'authentication_failed' || /login/i.test(shown)
            ? 'Die Anmeldung von Claude Code ist abgelaufen. Im Kanal F12 drücken und dort /login eingeben.'
            : kind === 'rate_limit'
              ? 'Das Nutzungslimit ist erreicht. Später mit einer neuen Nachricht weitermachen.'
              : 'Im Kanal F12 drücken, um im Terminal nachzusehen.';
        ctx.log('fehler', `${shown} (${kind})`);
        ctx.notice(`${ctx.name}: ${shown}. ${hint}`);
        ctx.status('fehler', `${shown} – ${hint}`);
        return null;
      }
      case 'Notification': {
        if (input.notification_type === 'auth_success') {
          ctx.notice(`${ctx.name}: Anmeldung bei Claude erfolgreich.`);
          this.working = false;
          ctx.status('wartet');
          return null;
        }
        if (input.notification_type === 'permission_prompt' && this.ready) {
          ctx.status('freigabe', truncate(String(input.message ?? 'Claude braucht eine Freigabe'), 120));
        }
        return null;
      }
      case 'PreToolUse': {
        const tool = String(input.tool_name ?? '');
        if (!EDIT_TOOLS.test(tool)) return null;
        const ti = (input.tool_input ?? {}) as Json;
        const path = String(ti.file_path ?? ti.notebook_path ?? '');
        const holder = path ? ctx.claimFile(path) : undefined;
        if (!holder) return null;
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Die Datei wird gerade von ${holder} bearbeitet oder ist für ${holder} reserviert. Bearbeite sie nicht, sondern sprich dich mit @${holder} ab.`,
          },
        };
      }
      case 'PermissionRequest': {
        const tool = String(input.tool_name ?? '');
        const allow = (extra: Json = {}) => ({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', ...extra } },
        });
        if (tool.startsWith('mcp__remoteharnes__')) return allow();
        // Schaut der Teamleiter gerade selbst ins Terminal, entscheidet er dort.
        if (this.exclusive) return null;
        const decision = await ctx.requestApproval({
          title: `${ctx.name} möchte ${tool} verwenden`,
          detail: summarizeToolInput(tool, input.tool_input as Json),
          allowAlways: Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0,
          timeoutMs: 270_000,
        });
        ctx.status('arbeitet');
        if (decision === 'timeout') return null;
        if (decision === 'ja') return allow();
        if (decision === 'immer') return allow({ updatedPermissions: input.permission_suggestions });
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message: `${ctx.humanLabel} hat das abgelehnt.` },
          },
        };
      }
      case 'SessionEnd':
        return null;
      default:
        return null;
    }
  }

  // ---------- Adapter ----------

  deliver(_text: string, _msgs: Message[]): void {
    this.nudge();
  }

  /** Tippt einen kurzen Anstoß ins Terminal; die Nachrichten selbst liefert der Hook. */
  nudge(): void {
    if (!this.ready || this.stopped || !this.proc) return;
    if (this.exclusive) return; // der Teamleiter tippt gerade selbst im durchgeschalteten Terminal
    if (Date.now() - this.nudgeAt < 15_000) return;
    this.nudgeAt = Date.now();
    this.proc.write(NUDGE);
    setTimeout(() => {
      if (!this.stopped) this.proc?.write('\r');
    }, 300);
  }

  /** Tippt eine Zeile in Claude Code, als hätte der Teamleiter sie eingegeben. */
  private typeLine(line: string): void {
    if (!this.ready || this.stopped || !this.proc) throw new Error('Claude Code ist noch nicht bereit.');
    this.proc.write(line);
    setTimeout(() => {
      if (!this.stopped) this.proc?.write('\r');
    }, 300);
  }

  async setModel(model: string): Promise<string> {
    this.typeLine(model ? `/model ${model}` : '/model');
    return model ? `Modell ${model} an Claude Code geschickt.` : 'Claude Code zeigt die Modellauswahl – mit F12 ins Terminal und dort wählen.';
  }

  async command(line: string): Promise<string> {
    this.typeLine(line);
    return `${line} an Claude Code geschickt. Fragt Claude Code etwas nach, mit F12 ins Terminal.`;
  }

  async interrupt(): Promise<void> {
    if (!this.proc || this.stopped) return;
    this.proc.write('\u001b');
    // Nach einer Unterbrechung meldet Claude Code kein Rundenende, deshalb selbst weitermachen.
    setTimeout(() => {
      if (this.stopped) return;
      this.blocks = 0;
      this.nudgeAt = 0;
      this.working = false;
      this.ctx.finalText('');
      this.ctx.status('wartet');
    }, 900);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    process.stdout.off('resize', this.onResize);
    try {
      if (!this.exited) this.proc?.kill();
    } catch (e) {
      this.ctx.log('info', errText(e));
    }
    try {
      if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
    } catch {
      /* egal */
    }
    this.ctx.status('beendet');
  }

  // ---------- Terminal durchschalten ----------

  /**
   * Terminal übernehmen. `viewer` = nur zuschauen und mittippen (App-Fenster): Post und
   * Freigabe-Karten laufen dann normal weiter. Ohne `viewer` gehört das Terminal ganz dem Teamleiter.
   */
  attach(onData: (d: string) => void, onExit: () => void, cols: number, rows: number, viewer = false) {
    if (!viewer) this.ctx.cancelApprovals();
    this.exclusive = !viewer;
    this.attachBuffer = [];
    this.resize(cols, rows);
    // Erst alles Ausstehende verarbeiten, dann den aktuellen Bildschirm übergeben, dann live weiter.
    this.term!.write('', () => {
      onData(this.ser!.serialize());
      const pending = this.attachBuffer ?? [];
      this.attachBuffer = null;
      this.attached = { onData, onExit };
      for (const d of pending) onData(d);
    });
    return {
      write: (d: string) => {
        if (!this.stopped) this.proc?.write(d);
      },
      resize: (c: number, r: number) => this.resize(c, r),
      detach: () => {
        this.attached = undefined;
        this.attachBuffer = null;
        this.exclusive = false;
        // Post, die währenddessen liegen blieb, jetzt zustellen
        setTimeout(() => {
          if (!this.stopped && !this.working && this.ctx.hasInbox()) this.nudge();
        }, 500);
      },
    };
  }

  screenLines(): string[] {
    const buf = this.term?.buffer.active;
    if (!buf || !this.term) return [];
    const out: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + this.term.rows; y++) {
      out.push(buf.getLine(y)?.translateToString(true) ?? '');
    }
    while (out.length && !out[out.length - 1]!.trim()) out.pop();
    while (out.length && !out[0]!.trim()) out.shift();
    return out;
  }
}

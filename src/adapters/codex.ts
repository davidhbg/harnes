import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Message } from '../types.js';
import { errText, truncate } from '../util.js';
import type { Adapter, AdapterContext } from './adapter.js';
import { cleanEnv, findOnPath, openInBrowser } from './common.js';
import { allMcp } from '../config.js';

type Json = Record<string, unknown>;

/** Findet das Codex-Programm: Einstellung, PATH oder die Codex-Desktop-App. */
export function findCodex(configured: string): { command: string; prefix: string[] } {
  if (/.(mjs|cjs|js)$/i.test(configured)) return { command: process.execPath, prefix: [configured] };
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  const onPath = findOnPath(process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']);
  if (onPath) candidates.push(onPath);
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (/\.(cmd|bat)$/i.test(c)) {
      // npm legt nur eine .cmd-Hülle an; das eigentliche Skript direkt mit node starten
      const script = join(dirname(c), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(script)) return { command: process.execPath, prefix: [script] };
      continue;
    }
    return { command: c, prefix: [] };
  }
  throw new Error(
    'Codex wurde nicht gefunden. Installiere die Codex-CLI (npm i -g @openai/codex) oder trage den Pfad in der config.json unter codex.befehl ein.',
  );
}

/**
 * Codex über die offizielle Schnittstelle `codex app-server` (JSON-RPC über stdio).
 * Die Anmeldung läuft über Codex selbst (ChatGPT-Konto oder API-Schlüssel).
 */
export class CodexAdapter implements Adapter {
  readonly controlled = true;
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private threadId = '';
  private turnId = '';
  private turnOpen = false;
  private lastText = '';
  private stopped = false;
  private loginWaiter?: { resolve: () => void; reject: (e: Error) => void };
  private fileChanges = new Map<string, string>();
  private seenErrors = new Set<string>();

  constructor(private ctx: AdapterContext) {}

  async start(): Promise<void> {
    const { ctx } = this;
    const { command, prefix } = findCodex(ctx.config.codex.befehl);
    const mcpEnv = `{REMOTEHARNES_URL=${JSON.stringify(ctx.hubUrl)},REMOTEHARNES_TOKEN=${JSON.stringify(ctx.token)}}`;
    const args = [
      ...prefix,
      'app-server',
      '-c',
      `mcp_servers.remoteharnes.command=${JSON.stringify(process.execPath)}`,
      '-c',
      `mcp_servers.remoteharnes.args=[${JSON.stringify(ctx.mcpServerPath)}]`,
      '-c',
      `mcp_servers.remoteharnes.env=${mcpEnv}`,
      // eigene MCP-Server aus den Einstellungen
      ...Object.entries(allMcp(ctx.config))
        .filter(([n]) => /^[A-Za-z0-9_-]+$/.test(n))
        .flatMap(([n, m]) => [
        '-c',
        `mcp_servers.${n}.command=${JSON.stringify(m.befehl)}`,
        '-c',
        `mcp_servers.${n}.args=[${(m.args ?? []).map((a) => JSON.stringify(a)).join(',')}]`,
        ...(m.env && Object.keys(m.env).length ? ['-c', `mcp_servers.${n}.env={${Object.entries(m.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`] : []),
      ]),
    ];
    this.proc = spawn(command, args, { cwd: ctx.cwd, env: cleanEnv(['OPENAI_API_KEY', 'CODEX_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.on('error', (e) => this.fail(`Codex ließ sich nicht starten: ${errText(e)}`));
    this.proc.on('exit', (code) => {
      if (!this.stopped) this.fail(`Codex wurde beendet (Code ${code ?? '?'}).`);
    });
    this.proc.stderr.on('data', (d: Buffer) => {
      for (const raw of d.toString('utf8').split(/\r?\n/)) {
        // Farbcodes und Zeitstempel entfernen, gleiche Meldungen nur einmal zeigen
        const line = raw.replace(/\u001b\[[0-9;]*m/g, '').replace(/^\S+Z\s+/, '').trim();
        if (!line || !/error|panic|failed/i.test(line)) continue;
        const key = line.replace(/^ERROR\s+/, '');
        if (this.seenErrors.has(key)) continue;
        this.seenErrors.add(key);
        if (this.seenErrors.size > 200) this.seenErrors.clear();
        ctx.log('fehler', truncate(key, 300));
      }
    });
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));

    await this.request('initialize', {
      clientInfo: { name: 'remoteharnes', title: 'Harnes', version: '0.1.0' },
      capabilities: null,
    });
    this.notify('initialized', {});

    // Anmeldung prüfen (mit Auffrischen des Zugangs). Ist sie abgelaufen, bleibt die
    // Sitzung offen und der Teamleiter meldet sich mit /anmelden neu an.
    let loggedIn = false;
    try {
      const acc = await this.request('account/read', { refreshToken: true });
      loggedIn = Boolean(acc.account) || !acc.requiresOpenaiAuth;
    } catch {
      loggedIn = false;
    }
    if (!loggedIn) {
      this.needLogin('Codex ist nicht angemeldet oder die Anmeldung ist abgelaufen.');
      return;
    }
    await this.startThread();
  }

  private needLogin(reason: string): void {
    const { ctx } = this;
    const hint = `${reason} Mit /anmelden ${ctx.name} neu anmelden (öffnet den Browser).`;
    ctx.log('fehler', hint);
    ctx.notice(`${ctx.name}: ${hint}`);
    ctx.status('fehler', hint);
  }

  private async startThread(): Promise<void> {
    const { ctx } = this;
    const model = ctx.spec.model || ctx.config.codex.modell || null;
    const res = await this.request('thread/start', {
      cwd: ctx.cwd,
      model,
      approvalPolicy: ctx.config.codex.approvalPolicy,
      sandbox: ctx.config.codex.sandbox,
      developerInstructions: ctx.systemPrompt,
    });
    this.threadId = String((res.thread as Json).id);
    ctx.log('info', `Bereit. Modell: ${String(res.model ?? model ?? 'Standard')}`);
    ctx.status('wartet');
  }

  /** Neu anmelden (ChatGPT-Konto im Browser). Aufgerufen durch /anmelden <name>. */
  async login(): Promise<void> {
    const { ctx } = this;
    const res = await this.request('account/login/start', { type: 'chatgpt' });
    const url = String(res.authUrl ?? '');
    if (!url) throw new Error('Codex hat keine Anmelde-Adresse geliefert.');
    ctx.status('startet', 'Anmeldung läuft: bitte im Browser bei ChatGPT anmelden. Danach geht es hier von selbst weiter.');
    ctx.notice(`${ctx.name}: Der Browser öffnet sich für die Anmeldung bei ChatGPT. Falls nicht, diese Adresse öffnen: ${url}`);
    if (!process.env.RH_NO_BROWSER) openInBrowser(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Die Anmeldung bei Codex wurde nicht innerhalb von 5 Minuten abgeschlossen.')), 300_000);
      this.loginWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
    ctx.notice(`${ctx.name}: Anmeldung bei Codex erfolgreich.`);
    this.seenErrors.clear();
    if (!this.threadId) await this.startThread();
    else ctx.status('wartet');
  }

  // ---------- JSON-RPC ----------

  private send(obj: Json): void {
    if (!this.proc || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ method, id, params });
    });
  }

  private notify(method: string, params: Json): void {
    this.send({ method, params });
  }

  private fail(message: string): void {
    if (this.stopped) return;
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    this.loginWaiter?.reject(new Error(message));
    this.ctx.log('fehler', message);
    this.ctx.status('fehler', message);
  }

  private onLine(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method !== 'string') {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(String((msg.error as Json).message ?? 'Fehler von Codex')));
      else p.resolve((msg.result ?? {}) as Json);
      return;
    }
    if (typeof msg.method !== 'string') return;
    const params = (msg.params ?? {}) as Json;
    if (hasId) void this.onServerRequest(msg.id as number | string, msg.method, params);
    else this.onNotification(msg.method, params);
  }

  private onNotification(method: string, p: Json): void {
    const { ctx } = this;
    switch (method) {
      case 'turn/started':
        this.turnId = String((p.turn as Json)?.id ?? this.turnId);
        break;
      case 'item/started': {
        const item = (p.item ?? {}) as Json;
        if (item.type === 'commandExecution') ctx.log('tool', `$ ${truncate(String(item.command ?? ''), 160)}`);
        else if (item.type === 'fileChange') {
          const paths = ((item.changes as Json[]) ?? []).map((c) => String(c.path)).join(', ');
          this.fileChanges.set(String(item.id), paths);
          ctx.log('tool', `ändert ${truncate(paths, 160)}`);
          // Codex fragt bei Änderungen im Projektordner nicht nach. Deshalb hier sperren und Konflikte melden.
          for (const c of (item.changes as Json[]) ?? []) {
            const holder = ctx.claimFile(String(c.path));
            if (holder) ctx.notice(`Konflikt: ${ctx.name} ändert ${String(c.path)}, obwohl die Datei gerade ${holder} gehört. Bitte prüfen.`);
          }
        } else if (item.type === 'mcpToolCall' && item.server !== 'remoteharnes') {
          ctx.log('tool', `${String(item.server)}.${String(item.tool)}`);
        } else if (item.type === 'webSearch') ctx.log('tool', `Websuche: ${truncate(String(item.query ?? ''), 120)}`);
        break;
      }
      case 'item/completed': {
        const item = (p.item ?? {}) as Json;
        if (item.type === 'agentMessage' && String(item.text ?? '').trim()) {
          this.lastText = String(item.text);
          ctx.log('text', this.lastText);
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const total = ((p.tokenUsage as Json)?.total ?? {}) as Json;
        const last = ((p.tokenUsage as Json)?.last ?? {}) as Json;
        const cached = Number(total.cachedInputTokens ?? 0);
        ctx.usage(
          {
            // bei Codex steckt der Zwischenspeicher in der Eingabe: getrennt ausweisen
            inputTokens: Math.max(0, Number(total.inputTokens ?? 0) - cached),
            outputTokens: Number(total.outputTokens ?? 0),
            cacheReadTokens: cached,
            contextTokens: Number(last.totalTokens ?? 0),
          },
          'set',
        );
        break;
      }
      case 'turn/completed': {
        const turn = (p.turn ?? {}) as Json;
        let text = '';
        if (turn.status === 'completed') text = this.lastText;
        else if (turn.status === 'failed') {
          const m = String((turn.error as Json)?.message ?? 'unbekannter Fehler');
          ctx.log('fehler', m);
          if (/sign in again|log out|unauthorized|\b401\b|not logged in/i.test(m)) {
            this.lastText = '';
            this.turnOpen = false;
            ctx.finalText('');
            this.needLogin('Die Anmeldung bei Codex ist abgelaufen.');
            break;
          }
          ctx.notice(`${ctx.name}: Runde fehlgeschlagen – ${truncate(m, 200)}`);
        }
        this.lastText = '';
        if (this.turnOpen) {
          this.turnOpen = false;
          ctx.turnDone(text);
        }
        break;
      }
      case 'error': {
        const m = String((p.error as Json)?.message ?? '');
        if (m && !this.seenErrors.has(m)) {
          this.seenErrors.add(m);
          ctx.log('fehler', `${m}${p.willRetry ? ' (neuer Versuch läuft)' : ''}`);
        }
        break;
      }
      case 'account/login/completed':
        if (p.success) this.loginWaiter?.resolve();
        else this.loginWaiter?.reject(new Error(`Anmeldung fehlgeschlagen: ${String(p.error ?? '')}`));
        this.loginWaiter = undefined;
        break;
      default:
        break;
    }
  }

  private async onServerRequest(id: number | string, method: string, p: Json): Promise<void> {
    const { ctx } = this;
    const respond = (result: Json) => this.send({ id, result });
    const refuse = (message: string) => this.send({ id, error: { code: -32601, message } });
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval': {
          const detail = [`$ ${String(p.command ?? '(Befehl unbekannt)')}`, p.cwd ? `in ${String(p.cwd)}` : '', p.reason ? `Grund: ${String(p.reason)}` : '']
            .filter(Boolean)
            .join('\n');
          const d = await ctx.requestApproval({ title: `${ctx.name} möchte einen Befehl ausführen`, detail });
          respond({ decision: d === 'ja' ? 'accept' : d === 'immer' ? 'acceptForSession' : 'decline' });
          break;
        }
        case 'item/fileChange/requestApproval': {
          const paths = this.fileChanges.get(String(p.itemId)) ?? '';
          const holder = paths
            .split(', ')
            .map((x) => ctx.claimFile(x))
            .find((h) => Boolean(h));
          if (holder) {
            ctx.log('info', `Änderung abgelehnt: Datei von ${holder} reserviert`);
            respond({ decision: 'decline' });
            break;
          }
          const detail = [paths, p.reason ? `Grund: ${String(p.reason)}` : ''].filter(Boolean).join('\n') || 'Dateien ändern';
          const d = await ctx.requestApproval({ title: `${ctx.name} möchte Dateien ändern`, detail });
          respond({ decision: d === 'ja' ? 'accept' : d === 'immer' ? 'acceptForSession' : 'decline' });
          break;
        }
        case 'execCommandApproval':
        case 'applyPatchApproval': {
          const detail = method === 'execCommandApproval' ? `$ ${((p.command as string[]) ?? []).join(' ')}` : 'Dateien ändern';
          const d = await ctx.requestApproval({ title: `${ctx.name} bittet um Freigabe`, detail });
          respond({ decision: d === 'ja' ? 'approved' : d === 'immer' ? 'approved_for_session' : 'denied' });
          break;
        }
        case 'mcpServer/elicitation/request': {
          // Rückfragen zu den eigenen Team-Werkzeugen sind immer in Ordnung
          if (p.serverName === 'remoteharnes') {
            respond({ action: 'accept', content: p.mode === 'form' ? {} : null, _meta: null });
            break;
          }
          const d = await ctx.requestApproval({
            title: `${ctx.name}: Rückfrage des Werkzeugs „${String(p.serverName)}“`,
            detail: String(p.message ?? ''),
            allowAlways: false,
          });
          respond({ action: d === 'ja' ? 'accept' : 'decline', content: d === 'ja' && p.mode === 'form' ? {} : null, _meta: null });
          break;
        }
        default:
          refuse(`Harnes unterstützt ${method} nicht.`);
      }
    } catch (e) {
      refuse(errText(e));
    }
  }

  // ---------- Adapter ----------

  async deliver(text: string, _msgs: Message[]): Promise<void> {
    this.turnOpen = true;
    this.lastText = '';
    try {
      const res = await this.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(this.model ? { model: this.model } : {}),
      });
      this.turnId = String((res.turn as Json)?.id ?? this.turnId);
    } catch (e) {
      this.turnOpen = false;
      throw e;
    }
  }

  private model = '';

  async command(line: string): Promise<string> {
    const cmd = line.trim().split(/\s+/)[0]!.toLowerCase();
    if (cmd === '/new' || cmd === '/neu' || cmd === '/clear') {
      await this.startThread();
      return 'Codex beginnt ein neues Gespräch.';
    }
    throw new Error(`${cmd} kennt Codex hier nicht. Möglich: /new, /model.`);
  }

  async setModel(model: string): Promise<string> {
    this.model = model;
    return `Modell ${model || 'Standard'} gilt ab der nächsten Runde.`;
  }

  async interrupt(): Promise<void> {
    if (!this.turnOpen || !this.turnId) return;
    await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => undefined);
    setTimeout(() => {
      if (this.turnOpen && !this.stopped) {
        this.turnOpen = false;
        this.ctx.turnDone('');
      }
    }, 3000).unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const p of this.pending.values()) p.reject(new Error('Sitzung beendet'));
    this.pending.clear();
    try {
      this.proc?.kill();
    } catch {
      /* egal */
    }
    this.ctx.status('beendet');
  }
}

import { cleanEnv } from './common.js';
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { getKey } from '../config.js';
import { teamPrompt } from '../hub/prompts.js';
import type { Message, ToolDef } from '../types.js';
import { errText, truncate } from '../util.js';
import type { Adapter, AdapterContext } from './adapter.js';
import { McpTools } from './mcp-client.js';
import { allMcp } from '../config.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const FILE_TOOLS: ToolDef[] = [
  {
    name: 'datei_lesen',
    description: 'Liest eine Textdatei aus dem Projektordner.',
    inputSchema: { type: 'object', properties: { pfad: { type: 'string', description: 'Pfad relativ zum Projektordner' } }, required: ['pfad'] },
    readOnly: true,
  },
  {
    name: 'ordner_auflisten',
    description: 'Listet Dateien und Unterordner eines Ordners im Projekt.',
    inputSchema: { type: 'object', properties: { pfad: { type: 'string', description: 'Ordner relativ zum Projektordner, „.“ für die oberste Ebene' } } },
    readOnly: true,
  },
  {
    name: 'datei_schreiben',
    description: 'Schreibt eine Textdatei im Projektordner (legt sie an oder ersetzt sie vollständig). Vorher mit datei_reservieren reservieren.',
    inputSchema: {
      type: 'object',
      properties: { pfad: { type: 'string', description: 'Pfad relativ zum Projektordner' }, inhalt: { type: 'string', description: 'Der vollständige neue Inhalt' } },
      required: ['pfad', 'inhalt'],
    },
  },
  {
    name: 'befehl_ausfuehren',
    description: 'Führt einen Shell-Befehl im Projektordner aus (z. B. Tests). Der Teamleiter muss jeden Befehl freigeben.',
    inputSchema: { type: 'object', properties: { befehl: { type: 'string', description: 'Der Befehl' } }, required: ['befehl'] },
  },
];

/**
 * Anbindung für alles, was die OpenAI-Chat-Schnittstelle spricht:
 * DeepSeek, OpenRouter, Ollama, LM Studio. Eigene kleine Werkzeug-Schleife;
 * gedacht für kleinere Aufgaben. Kann ein Modell keine Werkzeuge, chattet es nur mit.
 */
export class OpenAiAdapter implements Adapter {
  readonly controlled = true;
  private history: ChatMessage[] = [];
  private abort?: AbortController;
  private stopped = false;
  private toolsSupported = true;
  private alwaysAllowShell = false;
  private alwaysAllowWrite = false;
  private baseUrl = '';
  private model = '';
  private key?: string;
  private tools: ToolDef[] = [];
  private mcp = new McpTools();
  /** MCP-Server, deren Werkzeuge ohne Rückfrage laufen dürfen („Immer erlauben“) */
  private mcpAllowed = new Set<string>();

  constructor(private ctx: AdapterContext) {}

  async start(): Promise<void> {
    const { ctx } = this;
    const providerName = ctx.spec.provider ?? '';
    const provider = ctx.config.anbieter[providerName];
    if (!provider) throw new Error(`Anbieter „${providerName}“ steht nicht in der config.json (Abschnitt anbieter).`);
    this.baseUrl = provider.baseUrl.replace(/\/+$/, '');
    this.model = ctx.spec.model || provider.modell;
    if (!this.model) throw new Error(`Für ${providerName} ist kein Modell eingestellt. Beispiel: /neu ${providerName} name modellname`);
    if (provider.apiKeyEnv) {
      this.key = getKey(provider.apiKeyEnv);
      if (!this.key) {
        throw new Error(
          `Kein API-Schlüssel für ${providerName}. Umgebungsvariable ${provider.apiKeyEnv} setzen oder eingeben: /schluessel ${providerName} <schlüssel>`,
        );
      }
    }
    // eigene MCP-Server aus den Einstellungen anschließen
    const servers = allMcp(ctx.config);
    // Browser-Werkzeuge ohne Rückfrage (außer JavaScript, das prüft runTool)
    this.mcpAllowed.add('browser');
    if (Object.keys(servers).length) {
      await this.mcp.connect(servers, ctx.cwd);
      for (const [n, why] of this.mcp.failed) ctx.notice(`${ctx.name}: MCP-Server ${n} – ${why}`);
      if (this.mcp.defs.length) ctx.log('info', `MCP: ${this.mcp.defs.length} Werkzeuge von ${Object.keys(servers).filter((n) => !this.mcp.failed.has(n)).join(', ')}`);
    }
    this.tools = [...ctx.toolDefs, ...FILE_TOOLS, ...this.mcp.defs];
    // Erreichbarkeit kurz prüfen (lokale Server laufen oft nicht)
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(8000) });
      if (res.status === 401 || res.status === 403) throw new Error(`Der Schlüssel für ${providerName} wurde abgelehnt (Status ${res.status}).`);
    } catch (e) {
      if (/abgelehnt/.test(errText(e))) throw e;
      throw new Error(`${providerName} ist unter ${this.baseUrl} nicht erreichbar. Läuft der Dienst? (${truncate(errText(e), 80)})`);
    }
    ctx.log('info', `Bereit. Modell: ${this.model}`);
    ctx.status('wartet');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.key) h.authorization = `Bearer ${this.key}`;
    return h;
  }

  private systemMessage(): ChatMessage {
    const { ctx } = this;
    if (this.toolsSupported) {
      return {
        role: 'system',
        content:
          ctx.systemPrompt +
          '\n- Für Dateien im Projektordner hast du datei_lesen, ordner_auflisten, datei_schreiben und befehl_ausfuehren.' +
          '\n- Du übernimmst kleinere, klar umrissene Aufgaben. Größere Aufgaben gibst du im Teamchat an Kollegen ab.',
      };
    }
    // Modell ohne Werkzeuge: nur die Chat-Regeln
    const base = ctx.systemPrompt.split('\n').filter((l) => !/team_senden|aufgabe_|datei_|vault_|wissen_schreiben/.test(l));
    return { role: 'system', content: base.join('\n') || teamPrompt({ name: ctx.name, human: ctx.humanLabel, members: [], cwd: ctx.cwd, vaultDir: '', tools: false }) };
  }

  private async chat(signal: AbortSignal): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [this.systemMessage(), ...this.history],
      stream: false,
    };
    if (this.toolsSupported) {
      body.tools = this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    const raw = await res.text();
    if (!res.ok) {
      if (this.toolsSupported && /tool|function/i.test(raw) && (res.status === 400 || res.status === 404 || res.status === 422 || res.status === 500)) {
        // Modell kann keine Werkzeuge → ab jetzt nur Chat
        this.toolsSupported = false;
        this.ctx.log('info', 'Dieses Modell unterstützt keine Werkzeuge. Es chattet nur mit.');
        this.history = this.history.filter((m) => m.role !== 'tool' && !m.tool_calls);
        return this.chat(signal);
      }
      throw new Error(`Anfrage fehlgeschlagen (Status ${res.status}): ${truncate(raw, 200)}`);
    }
    const data = JSON.parse(raw) as {
      choices?: { message?: ChatMessage }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (data.usage) {
      const inp = data.usage.prompt_tokens ?? 0;
      const out = data.usage.completion_tokens ?? 0;
      this.ctx.usage({ inputTokens: inp, outputTokens: out, contextTokens: inp + out }, 'add');
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Leere Antwort vom Modell.');
    return { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined };
  }

  async deliver(text: string, _msgs: Message[]): Promise<void> {
    const { ctx } = this;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.history.push({ role: 'user', content: text });
    this.trim();
    let final = '';
    try {
      for (let step = 0; step < 25; step++) {
        const msg = await this.chat(signal);
        this.history.push(msg);
        const visible = stripThinking(msg.content ?? '');
        if (visible.trim()) ctx.log('text', visible);
        if (!msg.tool_calls?.length) {
          final = visible;
          break;
        }
        for (const call of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
          } catch {
            /* leere Argumente */
          }
          const result = await this.runTool(call.function.name, args);
          this.history.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 30_000) });
          if (signal.aborted) break;
        }
        if (signal.aborted) break;
        if (step === 24) final = 'Ich habe die Grenze von 25 Arbeitsschritten erreicht und halte hier an.';
      }
    } catch (e) {
      if (this.stopped) return;
      if (!signal.aborted) {
        ctx.log('fehler', errText(e));
        ctx.notice(`${ctx.name}: ${truncate(errText(e), 200)}`);
      }
      final = '';
    }
    if (this.stopped) return;
    ctx.turnDone(signal.aborted ? '' : final);
  }

  private inside(path: string): string {
    const root = resolve(this.ctx.cwd);
    const abs = resolve(root, path || '.');
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error('Der Pfad liegt außerhalb des Projektordners.');
    // Verknüpfungen (Symlinks, Junctions) dürfen nicht aus dem Projekt herausführen
    try {
      const realRoot = realpathSync.native(root);
      let probe = abs;
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
      const real = realpathSync.native(probe);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('Der Pfad führt über eine Verknüpfung aus dem Projektordner heraus.');
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Der Pfad')) throw e;
    }
    return abs;
  }

  /** Dateien, über die beim nächsten Befehl Code laufen würde (Git-Hooks, Einstellungen, Paket-Skripte) */
  private sensitive(abs: string): boolean {
    const rel = relative(resolve(this.ctx.cwd), abs).replace(/\\/g, '/').toLowerCase();
    return (
      /(^|\/)\.git(\/|$)/.test(rel) ||
      /(^|\/)\.(claude|codex|vscode|idea|husky|github)(\/|$)/.test(rel) ||
      /(^|\/)(package\.json|\.npmrc|\.env[^/]*|makefile|\.bashrc|\.profile)$/.test(rel) ||
      /\.(ps1|bat|cmd|sh|exe|dll)$/.test(rel)
    );
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const { ctx } = this;
    try {
      switch (name) {
        case 'datei_lesen': {
          const abs = this.inside(String(args.pfad ?? ''));
          ctx.log('tool', `liest ${relative(ctx.cwd, abs)}`);
          const text = readFileSync(abs, 'utf8');
          return text.length > 60_000 ? text.slice(0, 60_000) + '\n…(gekürzt)' : text;
        }
        case 'ordner_auflisten': {
          const abs = this.inside(String(args.pfad ?? '.'));
          ctx.log('tool', `listet ${relative(ctx.cwd, abs) || '.'}`);
          return (
            readdirSync(abs)
              .filter((n) => n !== 'node_modules' && n !== '.git')
              .slice(0, 300)
              .map((n) => (statSync(resolve(abs, n)).isDirectory() ? `${n}/` : n))
              .join('\n') || '(leer)'
          );
        }
        case 'datei_schreiben': {
          const abs = this.inside(String(args.pfad ?? ''));
          if (this.sensitive(abs)) {
            const d = await ctx.requestApproval({
              title: `${ctx.name} möchte eine heikle Datei schreiben`,
              detail: `${relative(ctx.cwd, abs)}\n(Git-Hooks, Einstellungen, Skripte oder Paketdatei: darüber kann Code laufen)`,
              art: 'heikel',
            });
            if (d !== 'ja' && d !== 'immer') return `${ctx.humanLabel} hat das Schreiben von ${relative(ctx.cwd, abs)} abgelehnt.`;
          } else if (!this.alwaysAllowWrite) {
            // Im Modus Manuell fragt das nach, sonst entscheidet der Hub ohne Karte
            const d = await ctx.requestApproval({ title: `${ctx.name} möchte eine Datei schreiben`, detail: relative(ctx.cwd, abs), art: 'bearbeiten' });
            if (d === 'immer') this.alwaysAllowWrite = true;
            else if (d !== 'ja') return `${ctx.humanLabel} hat das Schreiben von ${relative(ctx.cwd, abs)} abgelehnt.`;
          }
          const holder = ctx.claimFile(abs);
          if (holder) return `Fehler: Die Datei ist von ${holder} reserviert. Sprich dich mit @${holder} ab.`;
          const existed = existsSync(abs);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, String(args.inhalt ?? ''), 'utf8');
          ctx.log('tool', `${existed ? 'ändert' : 'legt an'} ${relative(ctx.cwd, abs)}`);
          return `Datei ${existed ? 'geändert' : 'angelegt'}: ${relative(ctx.cwd, abs)}`;
        }
        case 'befehl_ausfuehren': {
          const cmd = String(args.befehl ?? '').trim();
          if (!cmd) return 'Fehler: Befehl fehlt.';
          if (!this.alwaysAllowShell) {
            const d = await ctx.requestApproval({ title: `${ctx.name} möchte einen Befehl ausführen`, detail: `$ ${cmd}`, art: 'befehl', befehl: cmd });
            if (d === 'immer') this.alwaysAllowShell = true;
            else if (d !== 'ja') return `${ctx.humanLabel} hat den Befehl abgelehnt.`;
          }
          ctx.log('tool', `$ ${truncate(cmd, 160)}`);
          return await new Promise<string>((done) => {
            exec(cmd, { cwd: ctx.cwd, env: cleanEnv(), timeout: 120_000, maxBuffer: 2_000_000, windowsHide: true }, (err, stdout, stderr) => {
              const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim().slice(-20_000);
              done(err ? `Beendet mit Fehler (${err.code ?? err.signal ?? '?'}):\n${out}` : out || '(keine Ausgabe)');
            });
          });
        }
        default: {
          if (this.mcp.has(name)) {
            const server = this.mcp.serverOf(name);
            if (!this.mcpAllowed.has(server) || name.endsWith('browser_js')) {
              const d = await ctx.requestApproval({
                title: `${ctx.name} möchte ein MCP-Werkzeug nutzen (${server})`,
                detail: `${name}\n${truncate(JSON.stringify(args), 400)}`,
                allowAlways: true,
                art: 'werkzeug',
              });
              if (d === 'immer') this.mcpAllowed.add(server);
              else if (d !== 'ja') return `${ctx.humanLabel} hat das Werkzeug abgelehnt.`;
            }
            ctx.log('tool', `${name} ${truncate(JSON.stringify(args), 120)}`);
            return await this.mcp.call(name, args);
          }
          const r = await ctx.callTool(name, args);
          return r.text;
        }
      }
    } catch (e) {
      return `Fehler: ${errText(e)}`;
    }
  }

  /** Verlauf begrenzen, damit der Kontext nicht überläuft. */
  private trim(): void {
    const size = () => this.history.reduce((s, m) => s + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0);
    while (this.history.length > 6 && size() > 160_000) {
      this.history.shift();
      while (this.history.length && this.history[0]!.role !== 'user') this.history.shift();
    }
  }

  async setModel(model: string): Promise<string> {
    if (!model) throw new Error('Bitte ein Modell angeben.');
    this.model = model;
    return `Modell ${model} gilt ab der nächsten Runde.`;
  }

  async interrupt(): Promise<void> {
    this.abort?.abort();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    await this.mcp.close();
    this.ctx.status('beendet');
  }
}

/** Manche lokalen Modelle schreiben ihr Nachdenken in <think>…</think>; das gehört nicht in den Chat. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

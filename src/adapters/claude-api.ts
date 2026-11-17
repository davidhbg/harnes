import { query, type CanUseTool, type HookCallback, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getKey } from '../config.js';
import type { Message } from '../types.js';
import { errText, truncate } from '../util.js';
import type { Adapter, AdapterContext } from './adapter.js';
import { cleanEnv, summarizeToolInput } from './common.js';
import { allMcp } from '../config.js';
import { BROWSER_FREE } from '../hub/browser.js';
import { artVonWerkzeug } from '../hub/freigabe.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Claude Variante A: über API-Schlüssel mit dem Claude Agent SDK.
 * Vollwertiger Coding-Agent (Dateien, Bash, MCP). Abrechnung nach Verbrauch.
 * Ohne Schlüssel startet diese Variante nicht – das Abo wird hier nie benutzt.
 */
export class ClaudeApiAdapter implements Adapter {
  readonly controlled = true;
  private q?: Query;
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  private turnOpen = false;
  private lastText = '';
  private turnError = '';
  private sessionId = '';

  constructor(private ctx: AdapterContext) {}

  async start(): Promise<void> {
    const { ctx } = this;
    const envName = ctx.config.claudeApi.apiKeyEnv;
    const key = getKey(envName);
    if (!key) {
      throw new Error(
        `Kein API-Schlüssel für Claude gefunden. Entweder die Umgebungsvariable ${envName} setzen oder eingeben: /schluessel anthropic <schlüssel>`,
      );
    }
    const model = ctx.spec.model || ctx.config.claudeApi.modell;
    const self = this;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (!self.closed) {
        const next = self.queue.shift();
        if (next) yield next;
        else await new Promise<void>((r) => (self.wake = r));
      }
    }

    const canUseTool: CanUseTool = async (toolName, toolInput, opts) => {
      if (toolName.startsWith('mcp__remoteharnes__')) return { behavior: 'allow', updatedInput: toolInput };
      if (toolName.startsWith('mcp__browser__') && BROWSER_FREE.includes(toolName.slice(13))) return { behavior: 'allow', updatedInput: toolInput };
      const decision = await ctx.requestApproval({
        title: opts.title ?? `${ctx.name} möchte ${toolName} verwenden`,
        detail: summarizeToolInput(toolName, toolInput),
        allowAlways: Boolean(opts.suggestions?.length),
        art: artVonWerkzeug(toolName),
        befehl: String((toolInput as Record<string, unknown>)?.command ?? ''),
      });
      if (decision === 'ja') return { behavior: 'allow', updatedInput: toolInput };
      if (decision === 'immer') return { behavior: 'allow', updatedInput: toolInput, updatedPermissions: opts.suggestions };
      return { behavior: 'deny', message: `${ctx.humanLabel} hat das abgelehnt.` };
    };

    // Datei-Sperre: läuft vor JEDEM Bearbeiten, auch wenn keine Freigabe nötig wäre.
    const fileGuard: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== 'PreToolUse' || !EDIT_TOOLS.has(hookInput.tool_name)) return {};
      const ti = (hookInput.tool_input ?? {}) as Record<string, unknown>;
      const path = String(ti.file_path ?? ti.notebook_path ?? '');
      const holder = path ? ctx.claimFile(path) : undefined;
      if (!holder) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Die Datei wird gerade von ${holder} bearbeitet oder ist für ${holder} reserviert. Bearbeite sie nicht, sondern sprich dich mit @${holder} ab.`,
        },
      };
    };

    const budget = ctx.config.claudeApi.budgetUsd;
    this.q = query({
      prompt: input(),
      options: {
        cwd: ctx.cwd,
        model,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: ctx.systemPrompt },
        mcpServers: {
          remoteharnes: {
            type: 'stdio',
            command: process.execPath,
            args: [ctx.mcpServerPath],
            env: { REMOTEHARNES_URL: ctx.hubUrl, REMOTEHARNES_TOKEN: ctx.token },
          },
          // eigene MCP-Server aus den Einstellungen
          ...Object.fromEntries(Object.entries(allMcp(ctx.config)).map(([n, m]) => [n, { type: 'stdio' as const, command: m.befehl, args: m.args ?? [], env: m.env ?? {} }])),
        },
        // Die Team-Werkzeuge gibt canUseTool unten automatisch frei.
        settingSources: ['user', 'project', 'local'],
        canUseTool,
        hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [fileGuard] }] },
        maxBudgetUsd: budget > 0 ? budget : undefined,
        env: { ...cleanEnv(['GITHUB_TOKEN', 'GH_TOKEN']), ANTHROPIC_API_KEY: key, CLAUDE_AGENT_SDK_CLIENT_APP: 'remoteharnes/0.1.0' },
        stderr: (data) => {
          const line = data.trim();
          if (line && /error|fehler|invalid|unauthorized/i.test(line)) ctx.log('fehler', truncate(line, 300));
        },
      },
    });
    void this.pump();
    await Promise.race([
      this.q.initializationResult(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Claude hat nicht innerhalb von 60 Sekunden gestartet.')), 60_000)),
    ]);
    ctx.log('info', `Bereit. Modell: ${model}${budget > 0 ? `, Budget: $${budget}` : ''}`);
    ctx.status('wartet');
  }

  private async pump(): Promise<void> {
    const { ctx } = this;
    try {
      for await (const msg of this.q!) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
        } else if (msg.type === 'assistant') {
          if (msg.error) this.turnError = msg.error;
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              this.lastText = block.text;
              ctx.log('text', block.text);
            } else if (block.type === 'tool_use' && !block.name.startsWith('mcp__remoteharnes__')) {
              ctx.log('tool', `${block.name} ${summarizeToolInput(block.name, block.input as Record<string, unknown>, 140)}`);
            }
          }
        } else if (msg.type === 'result') {
          const u = msg.usage;
          ctx.usage(
            {
              // ohne zwischengespeicherte Wiederholungen (cache_read), die kaum etwas kosten
              inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
            },
            'add',
          );
          ctx.usage({ costUsd: msg.total_cost_usd }, 'set');
          let text = '';
          const apiError = this.turnError || (msg.subtype === 'success' && msg.is_error ? 'unknown' : '');
          this.turnError = '';
          if (apiError) {
            // Die Runde endete mit einem API-Fehler; der Text ist die Fehlermeldung, keine Antwort.
            const shown = truncate((msg.subtype === 'success' ? msg.result : '') || this.lastText || apiError, 200);
            const hint =
              apiError === 'authentication_failed'
                ? ` Der API-Schlüssel wird nicht angenommen. Neuen Schlüssel mit /schluessel anthropic <wert> speichern, dann /ende ${ctx.name} und neu öffnen.`
                : apiError === 'billing_error'
                  ? ' Bitte das Guthaben im Anthropic-Konto prüfen.'
                  : '';
            ctx.log('fehler', `${shown} (${apiError})`);
            ctx.notice(`${ctx.name}: ${shown}.${hint}`);
            this.lastText = '';
            if (this.turnOpen) {
              this.turnOpen = false;
              ctx.turnDone('');
            }
            if (apiError === 'authentication_failed' || apiError === 'billing_error') ctx.status('fehler', `${shown}.${hint}`);
            continue;
          }
          if (msg.subtype === 'success') text = msg.result || this.lastText;
          else if (msg.subtype === 'error_max_budget_usd') {
            ctx.notice(`${ctx.name}: Das Budget von $${ctx.config.claudeApi.budgetUsd} ist aufgebraucht (einstellbar in der config.json unter claudeApi.budgetUsd).`);
          } else if (this.turnOpen && msg.subtype !== 'error_during_execution') {
            ctx.log('fehler', `Runde endete mit: ${msg.subtype}`);
          }
          this.lastText = '';
          if (this.turnOpen) {
            this.turnOpen = false;
            ctx.turnDone(text);
          }
        }
      }
      if (!this.closed) ctx.status('beendet');
    } catch (e) {
      if (this.closed) return;
      ctx.log('fehler', errText(e));
      ctx.status('fehler', errText(e));
      ctx.notice(`${ctx.name}: ${errText(e)}`);
    }
  }

  deliver(text: string, _msgs: Message[]): void {
    this.turnOpen = true;
    this.lastText = '';
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    } as SDKUserMessage);
    this.wake?.();
  }

  async setModel(model: string): Promise<string> {
    await this.q?.setModel(model || undefined);
    return `Modell ${model || 'Standard'} gilt ab der nächsten Runde.`;
  }

  async interrupt(): Promise<void> {
    if (!this.turnOpen || !this.q) return;
    await this.q.interrupt().catch(() => undefined);
    setTimeout(() => {
      if (this.turnOpen && !this.closed) {
        this.turnOpen = false;
        this.ctx.turnDone('');
      }
    }, 3000).unref();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.wake?.();
    try {
      this.q?.close();
    } catch {
      /* egal */
    }
    this.ctx.status('beendet');
  }
}

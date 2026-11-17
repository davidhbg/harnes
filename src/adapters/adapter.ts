import type { Config } from '../config.js';
import type { AgentKind, AgentStatus, ApprovalDecision, LogEntry, Message, ToolDef, Usage } from '../types.js';

export interface AgentSpec {
  kind: AgentKind;
  name: string;
  model?: string;
  /** nur bei kind 'openai': Eintrag aus config.anbieter (deepseek, ollama, …) */
  provider?: string;
  /** Rollen-Vorlage (entwickler, tester, reviewer, …) */
  rolle?: string;
}

/** Alles, was eine Sitzung von der Zentrale braucht. */
export interface AdapterContext {
  readonly name: string;
  readonly spec: AgentSpec;
  readonly cwd: string;
  readonly config: Config;
  readonly humanLabel: string;
  /** Teamregeln als Text für die Systemanweisung */
  readonly systemPrompt: string;
  readonly hubUrl: string;
  readonly token: string;
  readonly mcpServerPath: string;
  readonly toolDefs: ToolDef[];
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  status(s: AgentStatus, detail?: string): void;
  log(kind: LogEntry['kind'], text: string): void;
  /** Runde fertig: Der Text geht als Antwort in den Chat, der Agent wartet wieder. */
  turnDone(finalText: string): void;
  /** Nur den Antworttext zustellen, Status bleibt (für Sitzungen, die sich selbst steuern). */
  finalText(text: string): void;
  usage(u: Partial<Usage>, mode?: 'add' | 'set'): void;
  requestApproval(req: {
    title: string;
    detail: string;
    allowAlways?: boolean;
    timeoutMs?: number;
  }): Promise<ApprovalDecision | 'timeout'>;
  /** Offene Freigabe-Karten dieser Sitzung zurückziehen (Ergebnis: 'timeout'). */
  cancelApprovals(): void;
  /** Wartende Nachrichten abholen (als fertiger Text) oder null. */
  takeDelivery(): string | null;
  hasInbox(): boolean;
  fileHolder(path: string): string | undefined;
  /**
   * Vor dem Bearbeiten einer Datei aufrufen. Gehört sie gerade jemand anderem, kommt
   * dessen Name zurück (dann nicht bearbeiten). Sonst ist sie bis zum Rundenende gesperrt.
   */
  claimFile(path: string): string | undefined;
  /** Hinweis an den Menschen im Teamchat */
  notice(text: string): void;
}

export interface Adapter {
  /** true: Die Zentrale startet jede Runde selbst. false: Die Sitzung holt sich Post über Hooks. */
  readonly controlled: boolean;
  /** true: Das Terminal der Sitzung lässt sich durchschalten (Claude im Abo). */
  readonly attachable?: boolean;
  start(): Promise<void>;
  /** Neue Runde mit diesem Text beginnen (nur bei controlled). */
  deliver(text: string, msgs: Message[]): Promise<void> | void;
  /** Sitzung anstoßen, ihre Post abzuholen (nur bei !controlled). */
  nudge?(): void;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  /** Neu anmelden, falls die Sitzung das selbst kann (Codex). */
  login?(): Promise<void>;
  /** Hook-Ereignis aus Claude Code; Rückgabe ist die Hook-Antwort (JSON) oder null. */
  onHook?(event: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** Aktueller Bildschirm der Sitzung als Textzeilen (für die Vorschau). */
  screenLines?(): string[];
  /** Modell wechseln; Rückgabe ist ein Hinweis für den Teamleiter. */
  setModel?(model: string): Promise<string | void>;
  /** Einen eigenen Befehl der Sitzung ausführen (z. B. /compact); Rückgabe ist ein Hinweis. */
  command?(line: string): Promise<string | void>;
}

export function kindLabel(spec: AgentSpec): string {
  switch (spec.kind) {
    case 'claude-api':
      return 'Claude · API';
    case 'claude-abo':
      return 'Claude · Abo';
    case 'codex':
      return 'Codex';
    case 'echo':
      return 'Test-Agent';
    case 'openai': {
      const p = spec.provider ?? 'openai';
      const names: Record<string, string> = {
        deepseek: 'DeepSeek',
        openrouter: 'OpenRouter',
        ollama: 'Ollama · lokal',
        lmstudio: 'LM Studio · lokal',
      };
      return names[p] ?? p;
    }
  }
}

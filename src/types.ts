export type AgentKind = 'echo' | 'claude-api' | 'claude-abo' | 'codex' | 'openai';

export type AgentStatus =
  | 'startet'
  | 'wartet'
  | 'arbeitet'
  | 'freigabe'
  | 'fehler'
  | 'beendet';

export interface Message {
  id: string;
  ts: number;
  /** Teilnehmer-ID (klein geschrieben) oder 'system' */
  from: string;
  /** 'team' oder Teilnehmer-ID */
  to: string;
  text: string;
  mentions: string[];
  urgent?: boolean;
  system?: boolean;
  /** Systemhinweis zu dieser Sitzung: steht auch in ihrem Privatchat */
  about?: string;
}

export type TaskStatus = 'offen' | 'reserviert' | 'in_arbeit' | 'erledigt' | 'blockiert';

export interface Task {
  id: number;
  title: string;
  description?: string;
  owner?: string;
  status: TaskStatus;
  proof?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export type ApprovalDecision = 'ja' | 'immer' | 'nein';

export interface Approval {
  id: string;
  agent: string;
  title: string;
  detail: string;
  allowAlways: boolean;
  createdAt: number;
}

export interface LogEntry {
  ts: number;
  kind: 'text' | 'tool' | 'status' | 'fehler' | 'info';
  text: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  /** aus dem Zwischenspeicher wiederverwendete Eingabe (kostet nur einen Bruchteil) */
  cacheReadTokens: number;
  /** aktuelle Größe des Gesprächs (Kontext) in Tokens */
  contextTokens: number;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** true = ändert nichts (für Freigabe-Hinweise an den Client) */
  readOnly?: boolean;
}

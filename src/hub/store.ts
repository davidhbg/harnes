import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '../types.js';

/** Speichert Nachrichten und Aufgaben, damit nach einem Neustart alles wieder da ist. */
export class Store {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private get messagesFile() {
    return join(this.dir, 'messages.jsonl');
  }

  appendMessage(m: Message): void {
    appendFileSync(this.messagesFile, JSON.stringify(m) + '\n', 'utf8');
  }

  /** Verlauf neu schreiben (z. B. nach „Chat leeren“) */
  rewriteMessages(msgs: Message[]): void {
    writeFileSync(this.messagesFile, msgs.map((m) => JSON.stringify(m) + '\n').join(''), 'utf8');
  }

  loadMessages(limit: number): Message[] {
    if (!existsSync(this.messagesFile)) return [];
    const lines = readFileSync(this.messagesFile, 'utf8').split('\n').filter(Boolean);
    const out: Message[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as Message);
      } catch {
        /* kaputte Zeile überspringen */
      }
    }
    return out;
  }

  saveJson(name: string, data: unknown): void {
    writeFileSync(join(this.dir, name), JSON.stringify(data, null, 2), 'utf8');
  }

  loadJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
}

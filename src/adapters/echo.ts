import type { Message } from '../types.js';
import { sleep, truncate } from '../util.js';
import type { Adapter, AdapterContext } from './adapter.js';

/**
 * Test-Agent ohne KI: antwortet nach festen Regeln. Damit lässt sich alles
 * ausprobieren, ohne einen einzigen Token zu verbrauchen.
 *
 * Versteht in Nachrichten:
 *   schweig          → kein Beitrag
 *   aufgabe: <text>  → legt eine Aufgabe an und reserviert sie
 *   frag <name>      → fragt im Teamchat einen Kollegen
 *   pingpong         → spielt die Nachricht an einen Kollegen zurück (testet die Ketten-Grenze)
 *   notiz: <text>    → schreibt in die eigene Vault-Notiz
 *   warte            → arbeitet 3 Sekunden (zum Testen von „dringend“)
 */
export class EchoAdapter implements Adapter {
  readonly controlled = true;
  private stopped = false;
  private abort?: () => void;

  constructor(
    private ctx: AdapterContext,
    private delayMs = 250,
  ) {}

  async start(): Promise<void> {
    this.ctx.status('wartet');
  }

  async deliver(_text: string, msgs: Message[]): Promise<void> {
    const last = msgs[msgs.length - 1];
    if (!last) return this.ctx.turnDone('');
    const lower = last.text.toLowerCase();
    let interrupted = false;
    this.abort = () => {
      interrupted = true;
    };
    await sleep(this.delayMs);
    if (lower.includes('warte')) {
      for (let i = 0; i < 30 && !interrupted && !this.stopped; i++) await sleep(100);
    }
    this.abort = undefined;
    if (this.stopped) return;
    if (interrupted) {
      this.ctx.log('info', 'unterbrochen');
      return this.ctx.turnDone('');
    }
    const reply = await this.answer(last, lower);
    this.ctx.log('text', reply);
    this.ctx.turnDone(reply);
  }

  private async answer(last: Message, lower: string): Promise<string> {
    const me = this.ctx.name;
    if (lower.includes('schweig')) return '[kein Beitrag]';

    const task = /aufgabe:\s*(.+)/i.exec(last.text);
    if (task) {
      const created = await this.ctx.callTool('aufgabe_anlegen', { titel: task[1]!.trim() });
      const id = /#(\d+)/.exec(created.text)?.[1];
      if (id) await this.ctx.callTool('aufgabe_reservieren', { id: Number(id) });
      return `Aufgabe #${id ?? '?'} angelegt und übernommen.`;
    }

    const ask = /frag\s+@?([a-z0-9_-]+)/i.exec(last.text);
    if (ask) {
      const r = await this.ctx.callTool('team_senden', { text: `@${ask[1]} kannst du mir kurz helfen?` });
      return r.isError ? r.text : '[kein Beitrag]';
    }

    const note = /notiz:\s*(.+)/i.exec(last.text);
    if (note) {
      await this.ctx.callTool('vault_notiz', { text: note[1]!.trim() });
      return 'Notiert.';
    }

    const edit = /bearbeite\s+(\S+)/i.exec(last.text);
    if (edit) {
      const holder = this.ctx.claimFile(edit[1]!);
      if (holder) return `Die Datei ${edit[1]} gehört gerade ${holder}. Ich fasse sie nicht an.`;
      await sleep(this.delayMs * 4);
      return `Datei ${edit[1]} bearbeitet.`;
    }

    if (lower.includes('arbeite')) {
      const list = await this.ctx.callTool('aufgaben_liste', {});
      const open = [...list.text.matchAll(/^#(\d+) \[offen\]/gm)].map((m) => Number(m[1]));
      let mine = 0;
      for (const id of open) {
        const r = await this.ctx.callTool('aufgabe_reservieren', { id });
        if (!r.isError) {
          mine = id;
          break;
        }
      }
      if (!mine) return 'Keine offene Aufgabe mehr für mich.';
      const file = `aufgabe-${mine}.txt`;
      const holder = this.ctx.claimFile(file);
      if (holder) return `Die Datei ${file} gehört ${holder}.`;
      await this.ctx.callTool('aufgabe_status', { id: mine, status: 'in_arbeit' });
      await sleep(this.delayMs * 2);
      await this.ctx.callTool('aufgabe_status', { id: mine, status: 'erledigt', nachweis: file });
      return `Aufgabe #${mine} erledigt (${file}).`;
    }

    if (lower.includes('pingpong')) {
      const team = await this.ctx.callTool('team_liste', {});
      const others = [...team.text.matchAll(/^- ([a-z0-9_-]+) \(/gm)].map((m) => m[1]!).filter((n) => n !== me);
      const target = others.find((n) => n !== last.from) ?? others[0];
      return target ? `@${target} pingpong` : 'Niemand zum Spielen da.';
    }

    if (lower.includes('helfen') && last.from !== me) return `@${last.from} klar, was brauchst du?`;
    return `${me} hier: verstanden – „${truncate(last.text, 60)}“`;
  }

  async interrupt(): Promise<void> {
    this.abort?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.();
    this.ctx.status('beendet');
  }
}

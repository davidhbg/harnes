import serializePkg from '@xterm/addon-serialize';
import xtermPkg from '@xterm/headless';
import pty from 'node-pty';

const { Terminal } = xtermPkg;
void serializePkg;

/**
 * Startet ein Programm in einem Pseudo-Terminal und liest dessen Bildschirm –
 * so lässt sich die Oberfläche bedienen und prüfen wie von einem Menschen.
 */
export class TermSession {
  private proc: pty.IPty;
  private term: InstanceType<typeof Terminal>;
  exited = false;
  exitCode: number | undefined;
  raw = '';

  constructor(file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number; modern?: boolean }) {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 36;
    this.term = new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true });
    // modern: die neuere Konsolen-Technik (wie in Windows Terminal), nötig z. B. für Maus-Eingaben
    this.proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: opts.env, useConptyDll: opts.modern });
    this.proc.onData((d) => {
      this.raw += d;
      this.term.write(d);
    });
    this.term.onData((d) => this.proc.write(d));
    this.proc.onExit((e) => {
      this.exited = true;
      this.exitCode = e.exitCode;
    });
  }

  write(data: string): void {
    this.proc.write(data);
  }

  /** Tippt Text und drückt Enter. */
  async line(text: string): Promise<void> {
    this.proc.write(text);
    await new Promise((r) => setTimeout(r, 150));
    // Enter erst, wenn der Text wirklich angekommen ist (unter Last kommt er sonst nach dem Enter an)
    const tail = text.slice(-12);
    for (let i = 0; i < 30; i++) {
      if ((await this.screen()).includes(tail)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.proc.write('\r');
  }

  async screen(): Promise<string> {
    await new Promise<void>((r) => this.term.write('', r));
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + this.term.rows; y++) {
      out.push(buf.getLine(y)?.translateToString(true) ?? '');
    }
    return out.join('\n');
  }

  async waitFor(pattern: RegExp | string, ms = 8000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const s = await this.screen();
      if (typeof pattern === 'string' ? s.includes(pattern) : pattern.test(s)) return s;
      if (Date.now() - start > ms) throw new Error(`Nicht auf dem Bildschirm erschienen: ${pattern}\n--- Bildschirm ---\n${s}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.proc.kill();
    } catch {
      /* schon beendet */
    }
  }
}

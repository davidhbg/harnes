import { spawn } from 'node:child_process';
import { cleanEnv } from '../adapters/common.js';

/**
 * Führt ein Programm direkt im selben Terminal aus (z. B. „claude auth login“) und gibt
 * danach die Kontrolle an die Oberfläche zurück. Kein Pseudo-Terminal: Unter Windows
 * verliert der Hauptprozess sonst nach dem Ende des Kindprozesses die Tastatur.
 * Strg+C bricht nur das Programm ab, nicht Harnes.
 */
export function runInteractive(command: string, args: string[], opts: { cwd: string; title: string }): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  return new Promise<number>((resolve) => {
    stdout.write('\u001b[?1049h\u001b[2J\u001b[H\u001b[?25h');
    stdout.write(`\u001b]0;Harnes – ${opts.title}\u0007`);
    stdout.write(`\u001b[38;2;232;121;249m\u001b[1m◆ Harnes\u001b[0m  \u001b[2m${opts.title} · Strg+C bricht ab\u001b[0m\r\n\r\n`);
    // Das Programm liest die Tastatur selbst; Harnes hört so lange nicht zu.
    stdin.pause();
    const ignoreSigint = () => undefined;
    process.on('SIGINT', ignoreSigint);
    let child;
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: cleanEnv(), stdio: 'inherit' });
    } catch (e) {
      stdout.write(`Konnte nicht starten: ${e instanceof Error ? e.message : String(e)}\r\n`);
      return setTimeout(() => finish(-1), 2500);
    }
    child.on('error', (e) => {
      stdout.write(`\r\nKonnte nicht starten: ${e.message}\r\n`);
      setTimeout(() => finish(-1), 2500);
    });
    child.on('exit', (code) => setTimeout(() => finish(code ?? -1), 1000));

    let done = false;
    function finish(code: number) {
      if (done) return;
      done = true;
      process.off('SIGINT', ignoreSigint);
      stdout.write('\u001b[?2004l\u001b[?1004l\u001b[<u\u001b[0m\u001b[?25h\u001b[?1049l\u001b]0;Harnes\u0007');
      resolve(code);
    }
  });
}

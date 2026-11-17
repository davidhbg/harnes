/** Eine Sitzung mit eigenem Terminal (Claude Code im Abo). */
export interface AttachTarget {
  /**
   * Terminal übernehmen. `onData` bekommt alles, was die Sitzung ausgibt
   * (zuerst den aktuellen Bildschirm). `onExit` meldet, wenn die Sitzung endet.
   */
  attach(
    onData: (data: string) => void,
    onExit: () => void,
    cols: number,
    rows: number,
    viewer?: boolean,
  ): { write(data: string): void; resize(cols: number, rows: number): void; detach(): void };
}

const DETACH = ['\u001b[24~', '\u001b[24;1~', '\u001d'];

/**
 * Schaltet das echte Terminal auf eine Sitzung durch, bis F12 (oder Strg+]) gedrückt wird.
 * Währenddessen läuft die Harnes-Oberfläche nicht.
 */
export function passthrough(target: AttachTarget, label: string, input?: NodeJS.ReadStream): Promise<void> {
  // eigener Eingabestrom (ui/wininput.ts) oder wie gewohnt process.stdin
  const stdin = input ?? process.stdin;
  const stdout = process.stdout;
  return new Promise<void>((resolve) => {
    let done = false;
    stdout.write('\u001b[?1049h\u001b[2J\u001b[H');
    stdout.write(`\u001b]0;Harnes – ${label}  (F12 = zurück)\u0007`);
    const session = target.attach(
      (data) => {
        if (!done) stdout.write(data);
      },
      () => finish(),
      stdout.columns || 100,
      stdout.rows || 30,
    );

    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8');
      let cut = -1;
      for (const seq of DETACH) {
        const i = s.indexOf(seq);
        if (i >= 0 && (cut < 0 || i < cut)) cut = i;
      }
      if (cut >= 0) {
        if (cut > 0) session.write(s.slice(0, cut));
        finish();
      } else session.write(s);
    };
    const onResize = () => session.resize(stdout.columns || 100, stdout.rows || 30);

    function finish() {
      if (done) return;
      done = true;
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      session.detach();
      // Nur pausieren. Den Rohmodus hier NICHT ausschalten: Unter Windows bricht das die
      // Verbindung zum Terminal (Schreibfehler EPIPE). Die Oberfläche setzt ihn gleich wieder selbst.
      stdin.pause();
      // Maus, Einfügen-Modus und Tastatur-Protokolle zurücksetzen, Bildschirm zurückgeben
      stdout.write('\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?2004l\u001b[?1004l\u001b[<u\u001b[0m\u001b[?25h\u001b[?1049l');
      stdout.write('\u001b]0;Harnes\u0007');
      resolve();
    }

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
    stdout.on('resize', onResize);
  });
}

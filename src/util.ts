import stringWidth from 'string-width';

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function hhmmss(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function dateStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, Math.max(0, n - 1)) + '…' : one;
}

/** Für Dateinamen im Vault: verbotene Zeichen raus. */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Notiz';
}

export function width(s: string): number {
  return stringWidth(s);
}

/** Bricht Text auf eine Breite um (beachtet Zeilenumbrüche und breite Zeichen). */
export function wrapText(text: string, maxWidth: number): string[] {
  const w = Math.max(4, maxWidth);
  const out: string[] = [];
  for (const rawLine of text.replace(/\r/g, '').replace(/\t/g, '  ').split('\n')) {
    if (rawLine === '') {
      out.push('');
      continue;
    }
    let line = '';
    let lineW = 0;
    for (const word of rawLine.split(/(\s+)/)) {
      if (word === '') continue;
      const ww = stringWidth(word);
      if (lineW + ww <= w) {
        line += word;
        lineW += ww;
        continue;
      }
      if (/^\s+$/.test(word)) {
        // Leerraum am Zeilenende fällt weg
        if (line !== '') out.push(line);
        line = '';
        lineW = 0;
        continue;
      }
      if (line.trim() !== '') out.push(line.replace(/\s+$/, ''));
      line = '';
      lineW = 0;
      if (ww <= w) {
        line = word;
        lineW = ww;
      } else {
        // sehr langes Wort hart teilen
        let chunk = '';
        let chunkW = 0;
        for (const ch of word) {
          const cw = stringWidth(ch);
          if (chunkW + cw > w) {
            out.push(chunk);
            chunk = '';
            chunkW = 0;
          }
          chunk += ch;
          chunkW += cw;
        }
        line = chunk;
        lineW = chunkW;
      }
    }
    if (line !== '' || out.length === 0) out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}

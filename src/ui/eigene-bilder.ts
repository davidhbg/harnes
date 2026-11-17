/**
 * Eigene Bilder (Braille-Zeichen) aus dem Harnes-Ordner, z. B. ~/.remoteharnes/bilder/startseite-1.txt.
 * Sie kommen zu den eingebauten Bildern (ui/bilder.ts) dazu; ein eigenes verbinden.txt ersetzt das
 * eingebaute Bild neben der Einrichtung.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '../config.js';

const cache = new Map<string, string[]>();

function folder(): string {
  return join(homeDir(), 'bilder');
}

/** Alle Bilder, deren Dateiname mit `prefix` beginnt (sortiert), einmal gelesen. */
export function ownImages(prefix: string): string[] {
  const hit = cache.get(prefix);
  if (hit) return hit;
  let out: string[] = [];
  try {
    if (existsSync(folder())) {
      out = readdirSync(folder())
        .filter((f) => f.startsWith(prefix) && f.endsWith('.txt'))
        .sort()
        .map((f) => readFileSync(join(folder(), f), 'utf8').replace(/\r/g, '').replace(/\n+$/, ''))
        .filter((s) => s.trim().length > 0);
    }
  } catch {
    out = [];
  }
  cache.set(prefix, out);
  return out;
}

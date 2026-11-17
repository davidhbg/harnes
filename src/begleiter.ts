/**
 * Verbindung zum Harnes Begleiter (Rust-Programm in begleiter/): starten und ihm Meldungen schicken,
 * die er neben dem Mauszeiger zeigt und vorliest (Freigabe nötig, jemand schreibt dir …).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from './config.js';

export function begleiterExe(): string {
  const file = process.platform === 'win32' ? 'harnes-begleiter.exe' : 'harnes-begleiter';
  const base = join(dirname(fileURLToPath(import.meta.url)), '..', 'begleiter');
  // frisch gebaut (Entwicklung) oder fertig mitgeliefert (Installationspaket)
  const built = join(base, 'target', 'release', file);
  return existsSync(built) ? built : join(base, 'bin', file);
}

/** Startet den Begleiter (läuft er schon, beendet sich der zweite Start von selbst). */
export function startBegleiter(): string {
  if (process.platform !== 'win32') return 'Den Begleiter gibt es bisher nur für Windows.';
  const exe = begleiterExe();
  if (!existsSync(exe)) return 'Der Begleiter ist noch nicht gebaut (im Ordner begleiter: cargo build --release).';
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return 'Begleiter gestartet: Strg+Alt halten und sprechen, zweimal tippen für ein Gespräch.';
}

/** Meldung an den Begleiter (still, wenn er nicht läuft). */
export async function notifyBegleiter(titel: string, text: string): Promise<void> {
  try {
    const conn = JSON.parse(readFileSync(join(homeDir(), 'begleiter-verbindung.json'), 'utf8')) as { port: number; token: string };
    await fetch(`http://127.0.0.1:${conn.port}/melden`, {
      method: 'POST',
      headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ titel, text }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* Begleiter läuft nicht */
  }
}

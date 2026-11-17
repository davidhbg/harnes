import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TermSession } from './term.js';

const cli = resolve('dist/cli.js');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let session: TermSession | undefined;
afterEach(() => {
  session?.kill();
  session = undefined;
});

function frisch() {
  const home = mkdtempSync(join(tmpdir(), 'rh-neu-'));
  const proj = join(home, 'Demo');
  mkdirSync(proj);
  // frischer Rechner: kein Harnes-Ordner, keine eigenen Bilder
  const env = { ...process.env, REMOTEHARNES_HOME: join(home, 'home'), HARNES_BENUTZER: 'Gast', RH_NO_ANIM: '1' } as Record<string, string>;
  session = new TermSession(process.execPath, [cli, proj], { cwd: proj, env, cols: 120, rows: 40 });
  return { t: session, home };
}

describe('Erster Start für neue Nutzer', () => {
  it('fragt nach dem Namen, speichert ihn und zeigt keine fremden Bilder', async () => {
    expect(existsSync(cli), 'vorher npm run build ausführen').toBe(true);
    const { t, home } = frisch();
    let s = await t.waitFor('Willkommen bei Harnes', 15_000);
    expect(s).toContain('Wie heißt du? Gast');
    expect(s).toContain('Gedächtnis für dein Team anlegen');
    // Namen ändern: alten löschen, neuen tippen
    for (let i = 0; i < 4; i++) t.write('\u007f');
    await pause(150);
    t.write('Mia');
    s = await t.waitFor('Wie heißt du? Mia');
    t.write('\r');
    await t.waitFor('Womit willst du arbeiten?');
    const config = JSON.parse(readFileSync(join(home, 'home', 'config.json'), 'utf8'));
    expect(config.benutzer).toBe('Mia');
    expect(config.eingerichtet).toBeFalsy();
    t.write('\u0003');
    for (let i = 0; i < 60 && !t.exited; i++) await pause(100);
    expect(t.exited).toBe(true);
  }, 60_000);

  it('Zugang später verbinden, dann vorhandenen Obsidian-Vault verbinden und im Team ankommen', async () => {
    const { t, home } = frisch();
    const vault = join(home, 'Mein Vault');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    await t.waitFor('Willkommen bei Harnes', 15_000);
    t.write('\r');
    await t.waitFor('Womit willst du arbeiten?');
    t.write('\r');
    // Verbinden: deutlich sichtbares „Später verbinden“ (oder schon verbunden)
    let s = await t.waitFor(/Später verbinden|\[ Weiter \]/, 20_000);
    t.write('s');
    // Gedächtnis-Schritt
    s = await t.waitFor('Gedächtnis für dein Team');
    expect(s).toContain('Neues Gedächtnis anlegen  (empfohlen)');
    expect(s).toContain('Vorhandenen Obsidian-Vault verbinden');
    t.write('\u001b[B'); // Pfeil runter: vorhandenen Vault
    await t.waitFor(/Ordner\s/);
    t.write(vault);
    await t.waitFor('Obsidian-Vault erkannt');
    t.write('\r');
    s = await t.waitFor('Zu den Chats');
    expect(s).toContain('Gedächtnis');
    const config = JSON.parse(readFileSync(join(home, 'home', 'config.json'), 'utf8'));
    expect(config.vaultRoot).toBe(vault);
    t.write('\r');
    // Projekt lädt mit dem neuen Gedächtnis neu und landet im Team
    await t.waitFor('Nachricht an das Team', 20_000);
    expect(existsSync(join(vault, 'Demo'))).toBe(true);
    t.write('\u0003');
  }, 90_000);
});

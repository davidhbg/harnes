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

describe('Erster Start für neue Nutzer', () => {
  it('fragt nach dem Namen, speichert ihn und zeigt keine fremden Bilder', async () => {
    expect(existsSync(cli), 'vorher npm run build ausführen').toBe(true);
    const home = mkdtempSync(join(tmpdir(), 'rh-neu-'));
    const proj = join(home, 'Demo');
    mkdirSync(proj);
    // frischer Rechner: kein Harnes-Ordner, keine eigenen Bilder
    const env = { ...process.env, REMOTEHARNES_HOME: join(home, 'home'), HARNES_BENUTZER: 'Gast', RH_NO_ANIM: '1' } as Record<string, string>;
    session = new TermSession(process.execPath, [cli, proj], { cwd: proj, env, cols: 120, rows: 34 });
    const t = session;
    let s = await t.waitFor('Willkommen bei Harnes', 15_000);
    expect(s).toContain('Wie heißt du? Gast');
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
});

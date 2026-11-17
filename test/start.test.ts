import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { banner } from '../src/ui/Start.js';
import { TermSession } from './term.js';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let session: TermSession | undefined;
afterEach(() => {
  session?.kill();
  session = undefined;
});

/** Startet RemoteHarnes mit nachgebauten Claude- und Codex-Programmen. */
function start() {
  const home = mkdtempSync(join(tmpdir(), 'rh-start-'));
  const proj = join(home, 'Shop');
  const state = join(home, 'zustand');
  mkdirSync(proj);
  mkdirSync(state);
  mkdirSync(join(home, 'home'));
  const fake = resolve('test/fake-login.mjs');
  const claudeCmd = join(home, 'claude-nachbau.cmd');
  writeFileSync(claudeCmd, `@set FAKE_ROLLE=claude\r\n@"${process.execPath}" "${fake}" %*\r\n`);
  const codexJs = join(home, 'codex-nachbau.mjs');
  writeFileSync(codexJs, `process.env.FAKE_ROLLE = 'codex';\nawait import(${JSON.stringify('file:///' + fake.split('\\').join('/'))});\n`);
  writeFileSync(
    join(home, 'home', 'config.json'),
    JSON.stringify({ claudeAbo: { befehl: claudeCmd }, codex: { befehl: codexJs }, anbieter: { ollama: { baseUrl: 'http://127.0.0.1:9/v1', modell: 'x' } } }),
  );
  const env = { ...process.env, REMOTEHARNES_HOME: join(home, 'home'), FAKE_STATE: state } as Record<string, string>;
  session = new TermSession(process.execPath, [resolve('dist/cli.js'), proj, '--konten'], { cwd: proj, env, cols: 110, rows: 34 });
  return { t: session, state, home };
}

describe('Anmeldebildschirm', () => {
  it('Schriftzug hat gleich breite Zeilen', () => {
    const b = banner('Remote Harnes');
    expect(b).toHaveLength(3);
    expect(b[0]!.length).toBeGreaterThan(40);
  });

  it('zeigt Status, meldet bei Claude und Codex an, startet das Team', async () => {
    expect(existsSync(resolve('dist/cli.js')), 'vorher npm run build').toBe(true);
    const { t, state } = start();
    let s = await t.waitFor('Anmelden und Team zusammenstellen', 15_000);
    expect(s).toContain('██╗'); // großer Schriftzug
    s = await t.waitFor(/Claude Code · Abo\s+○ nicht angemeldet/, 20_000);
    s = await t.waitFor(/Codex · ChatGPT\s+○ nicht angemeldet/, 20_000);
    expect(s).toMatch(/Test-Agent · ohne KI\s+● immer bereit/);

    // nicht angemeldet → Leertaste geht nicht
    t.write(' ');
    await t.waitFor('erst anmelden (Enter drücken)');

    // Claude anmelden (Enter auf erster Zeile) – das echte Login läuft im Terminal
    t.write('\r');
    await t.waitFor('Anmeldung bei Claude', 10_000);
    await t.waitFor('Code eingeben', 10_000);
    t.write('abc123\r');
    s = await t.waitFor(/Claude Code · Abo\s+● angemeldet · Claude-Abo \(max\)/, 20_000);
    expect(existsSync(join(state, 'claude-angemeldet'))).toBe(true);
    expect(s).toMatch(/Claude Code · Abo.*\[x\]/); // nach Anmeldung gleich im Team

    // Codex: erst fehlgeschlagene, dann erfolgreiche Anmeldung
    t.write('\u001b[B'); // runter
    await pause(200);
    t.write('\r');
    await t.waitFor('Anmeldung bei Codex', 10_000);
    await t.waitFor('Code eingeben', 10_000);
    t.write('falsch\r');
    await t.waitFor('Codex: Anmeldung abgebrochen oder fehlgeschlagen', 15_000);
    t.write('\r');
    await t.waitFor('Code eingeben', 10_000);
    t.write('richtig\r');
    s = await t.waitFor(/Codex · ChatGPT\s+● angemeldet · ChatGPT plus/, 20_000);
    expect(s).toMatch(/Codex · ChatGPT.*\[x\]/);
    // Für Codex-Sitzungen gibt es hier keinen Nachbau: wieder abwählen
    t.write(' ');
    await t.waitFor(/Codex · ChatGPT.*\[ \]/);

    // API-Schlüssel eingeben (verdeckt)
    t.write('\u001b[B');
    await pause(200);
    t.write('\r');
    await t.waitFor('API-Schlüssel für Claude', 5000);
    t.write('sk-test-geheim');
    s = await t.waitFor('••••••••••••••', 5000);
    expect(s).not.toContain('sk-test-geheim');
    t.write('\r');
    await t.waitFor(/Claude · API-Schlüssel\s+[●!] Schlüssel/, 20_000);

    // Test-Agent dazunehmen und starten
    for (let i = 0; i < 10; i++) {
      const cur = await t.screen();
      if (/▸ Test-Agent/.test(cur)) break;
      t.write('\u001b[B');
      await pause(150);
    }
    t.write(' ');
    await t.waitFor(/Test-Agent · ohne KI.*\[x\]/);
    s = await t.waitFor(/Team starten \(claude.*test\)/);
    t.write('s');
    s = await t.waitFor('claude (Claude · Abo) ist dem Team beigetreten', 20_000);
    await t.waitFor('test (Test-Agent) ist dem Team beigetreten', 20_000);

    // /konten führt zurück zum Anmeldebildschirm, laufende Sitzungen sind markiert
    await t.line('/konten');
    s = await t.waitFor(/Claude Code · Abo.*\[läuft\]/, 20_000);
    t.write('q');
    for (let i = 0; i < 60 && !t.exited; i++) await pause(100);
    expect(t.exited).toBe(true);
  }, 120_000);
});

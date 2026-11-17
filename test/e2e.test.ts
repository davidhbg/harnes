import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TermSession } from './term.js';

const cli = resolve('dist/cli.js');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let session: TermSession | undefined;

function start(mit: string, cols = 110, rows = 32, config?: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'rh-e2e-'));
  const proj = join(home, 'Demo');
  mkdirSync(proj);
  if (config) {
    mkdirSync(join(home, 'home'), { recursive: true });
    writeFileSync(join(home, 'home', 'config.json'), JSON.stringify(config));
  }
  const env = { ...process.env, REMOTEHARNES_HOME: join(home, 'home') } as Record<string, string>;
  session = new TermSession(process.execPath, [cli, proj, '--mit', mit], { cwd: proj, env, cols, rows });
  return { t: session, vault: join(home, 'home', 'vault', 'Demo'), proj };
}

afterEach(() => {
  session?.kill();
  session = undefined;
});

describe('Oberfläche im echten Terminal (ohne KI)', () => {
  it('Teamchat, Privatchat, Aufgaben, Vault und Beenden', async () => {
    expect(existsSync(cli), 'vorher npm run build ausführen').toBe(true);
    const { t, vault } = start('test:anna,test:ben');
    await t.waitFor('ben (Test-Agent) ist dem Team beigetreten');

    // 1. Teamchat: alle lesen mit und antworten
    await t.line('Moin, eure Aufgaben sind heute: Login und Tests');
    let s = await t.waitFor(/ben hier: verstanden/);
    expect(s).toMatch(/Moin, eure Aufgaben/);
    expect(s).toMatch(/anna hier: verstanden/);

    // 2. Privatchat: Tab, Tab → Kanal von anna
    t.write('\t');
    await pause(150);
    t.write('\t');
    await t.waitFor('Privat an anna');
    await t.line('aufgabe: Login bauen');
    s = await t.waitFor('Aufgabe #1 angelegt und übernommen');
    expect(s).not.toMatch(/Aufgabe #2/);

    // 3. Agenten sprechen miteinander (anna fragt ben im Teamchat)
    await t.line('frag ben');
    await pause(200);
    t.write('\u001b[Z');
    await pause(150);
    t.write('\u001b[Z');
    s = await t.waitFor(/@anna klar, was brauchst du\?/);
    expect(s).toMatch(/@ben kannst du mir kurz helfen\?/);

    // 4. Aufgaben-Kanal: eigene Aufgabe anlegen und abhaken
    t.write('\t');
    await t.waitFor('Neue Aufgabe eintippen');
    await t.line('Tests schreiben');
    s = await t.waitFor(/#2 \[offen\] Tests schreiben/);
    expect(s).toMatch(/#1 \[reserviert\] Login bauen · anna/);
    await t.line('/erledigt 2 von Hand geprüft');
    await t.waitFor(/#2 \[erledigt\] Tests schreiben/);

    // 5. /dm aus jedem Kanal, Anführungszeichen wie im Wunsch „/all "…"“
    await t.line('/all "Feierabend für heute"');
    await t.waitFor(/Feierabend für heute/);

    // 6. Vault: Protokolle und Aufgaben liegen als Notizen vor
    const chat = readdirSync(join(vault, 'Chat'));
    expect(chat.some((f) => f.endsWith('Team.md'))).toBe(true);
    expect(chat.some((f) => f.includes('Privat anna + David'))).toBe(true);
    expect(readFileSync(join(vault, 'Aufgaben.md'), 'utf8')).toMatch(/Tests schreiben \| – \| erledigt \| von Hand geprüft/);

    // 7. Beenden
    await t.line('/quit');
    for (let i = 0; i < 150 && !t.exited; i++) await pause(100);
    if (!t.exited) console.log(`--- Bildschirm beim Hängen ---\n${await t.screen()}`);
    expect(t.exited).toBe(true);
    expect(t.exitCode).toBe(0);
  }, 60_000);

  it('Verlauf ist nach einem Neustart wieder da', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rh-e2e-'));
    const proj = join(home, 'Demo');
    mkdirSync(proj);
    const env = { ...process.env, REMOTEHARNES_HOME: join(home, 'home') } as Record<string, string>;
    const run = () => new TermSession(process.execPath, [cli, proj, '--mit', 'test:anna'], { cwd: proj, env, cols: 110, rows: 30 });
    let t = (session = run());
    await t.waitFor('anna (Test-Agent) ist dem Team beigetreten');
    await t.line('Das ist ein Satz von gestern');
    await t.waitFor(/anna hier: verstanden/);
    await t.line('/quit');
    for (let i = 0; i < 150 && !t.exited; i++) await pause(100);
    t = session = run();
    const s = await t.waitFor('anna (Test-Agent) ist dem Team beigetreten');
    expect(s).toMatch(/Das ist ein Satz von gestern/);
  }, 30_000);

  it('Claude im Abo: F12 schaltet ins Terminal und zurück, Freigabe-Karte per Taste', async () => {
    // Nachbau von Claude Code als Starter-Datei
    const dir = mkdtempSync(join(tmpdir(), 'rh-fake-'));
    const script = resolve('test/fake-claude.mjs');
    const fake = join(dir, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');
    writeFileSync(fake, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });

    const { t } = start('claude:max', 110, 32, { claudeAbo: { befehl: fake } });
    await t.waitFor('max (Claude · Abo) ist dem Team beigetreten', 15_000);
    t.write('\t');
    await pause(150);
    t.write('\t');
    await t.waitFor('Privat an max');
    await t.waitFor(/○ max/, 15_000);

    // F12: jetzt ist das Terminal der Sitzung zu sehen, mit dem bisherigen Bildschirm
    t.write('\u001b[24~');
    await t.waitFor('FAKE CLAUDE CODE', 10_000);
    await t.line('hallo direkt');
    await t.waitFor('> hallo direkt', 10_000);
    await t.waitFor('● [kein Beitrag]', 10_000);

    // F12: zurück in RemoteHarnes, die Sitzung läuft weiter
    t.write('\u001b[24~');
    await t.waitFor('Privat an max', 10_000);
    await t.line('Wie weit bist du?');
    await t.waitFor(/Fake-Claude: verstanden/, 15_000);

    // Freigabe-Karte erscheint und lässt sich mit „j“ bestätigen
    await t.line('erlaubnis bitte');
    const card = await t.waitFor('Freigabe für max', 15_000);
    expect(card).toContain('$ npm test');
    expect(card).toContain('[j] Ja');
    t.write('j');
    await t.waitFor(/Befehl ausgeführt: Tests grün/, 15_000);

    await t.line('/quit');
    for (let i = 0; i < 80 && !t.exited; i++) await pause(100);
    expect(t.exited).toBe(true);
  }, 90_000);

  it('Menü: alle Einträge haben eine Nummer, auch zweistellig per Taste wählbar', async () => {
    const { t } = start('test:anna', 110, 34, { eingerichtet: true });
    await t.waitFor('anna (Test-Agent) ist dem Team beigetreten');
    t.write('\u001b');
    let s = await t.waitFor('Startseite');
    expect(s).toMatch(/ 1 Startseite/);
    expect(s).toMatch(/10 Verlauf durchsuchen/);
    expect(s).toMatch(/14 Beenden/);
    // 1 und 3 schnell hintereinander: Eintrag 13 (Hilfe)
    t.write('1');
    await pause(150);
    t.write('3');
    await t.waitFor('Alle Befehle und Tasten');
    // 1 allein: nach kurzem Warten Eintrag 1 (Startseite)
    t.write('\u001b');
    await pause(300);
    t.write('\u001b');
    await t.waitFor(/14 Beenden/);
    t.write('1');
    await t.waitFor('Wohin?', 5000);
  }, 60_000);

  it('kleines Fenster und Größenänderung brechen nichts', async () => {
    const { t } = start('test:anna', 60, 16);
    await t.waitFor('Nachricht an das Team');
    await t.line('Hallo');
    await t.waitFor(/anna hier: verstanden/);
    t.resize(130, 40);
    const s = await t.waitFor('Sitzungen');
    expect(s).toMatch(/anna hier: verstanden/);
  }, 20_000);
});

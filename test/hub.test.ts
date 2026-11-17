import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanFinal, isNoContribution } from '../src/hub/prompts.js';
import { idle, makeHub, until } from './helpers.js';

const texts = (hub: ReturnType<typeof makeHub>['hub'], channel: string) =>
  hub.channelMessages(channel).filter((m) => !m.system).map((m) => `${m.from}: ${m.text}`);

describe('Zustellung', () => {
  it('Team-Nachricht des Menschen geht an alle, jeder antwortet im Teamchat', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'team', 'Moin zusammen');
    await until(() => texts(hub, 'team').length === 3 && idle(hub));
    const t = texts(hub, 'team');
    expect(t[0]).toBe('david: Moin zusammen');
    expect(t.some((x) => x.startsWith('anna: anna hier'))).toBe(true);
    expect(t.some((x) => x.startsWith('ben: ben hier'))).toBe(true);
  });

  it('mit @-Erwähnung bekommt nur der Erwähnte die Nachricht', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'team', '@ben wie weit bist du?');
    await until(() => texts(hub, 'team').length === 2 && idle(hub));
    expect(texts(hub, 'team')[1]).toMatch(/^ben: /);
    expect(hub.agents.get('anna')!.usage.turns).toBe(0);
  });

  it('Privatnachricht bleibt privat und wird privat beantwortet', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'anna', 'Was ist mit Punkt 3?');
    await until(() => texts(hub, 'agent:anna').length === 2 && idle(hub));
    expect(texts(hub, 'agent:anna')[1]).toMatch(/^anna: anna hier/);
    expect(texts(hub, 'team')).toHaveLength(0);
    expect(texts(hub, 'agent:ben')).toHaveLength(0);
  });

  it('„kein Beitrag“ erzeugt keine Nachricht', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    hub.post(hub.human, 'team', 'schweig bitte');
    await until(() => hub.agents.get('anna')!.usage.turns === 1 && idle(hub));
    expect(texts(hub, 'team')).toHaveLength(1);
    expect(isNoContribution('[kein Beitrag]')).toBe(true);
    expect(isNoContribution('Kein Beitrag.')).toBe(true);
    expect(isNoContribution('Ich habe keinen Beitrag, aber eine Frage')).toBe(false);
  });

  it('Agenten sprechen miteinander: Frage per @-Erwähnung und Antwort', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'anna', 'frag ben');
    await until(() => texts(hub, 'team').length >= 3 && idle(hub));
    const t = texts(hub, 'team');
    expect(t[0]).toBe('anna: @ben kannst du mir kurz helfen?');
    expect(t[1]).toBe('ben: @anna klar, was brauchst du?');
    expect(t[2]).toMatch(/^anna: anna hier/);
  });

  it('Ketten-Grenze hält Agenten-Gerede an, /weiter setzt fort', async () => {
    const { hub } = makeHub({ kettenLimit: 4 });
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'team', '@anna pingpong');
    await until(() => hub.heldCount > 0 && idle(hub));
    const before = texts(hub, 'team').length;
    expect(hub.messages.some((m) => m.system && m.text.includes('pausiert'))).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(texts(hub, 'team').length).toBe(before);
    hub.resume();
    await until(() => texts(hub, 'team').length > before);
  });

  it('dringend unterbricht eine laufende Runde', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    hub.post(hub.human, 'anna', 'warte mal');
    await until(() => hub.agents.get('anna')!.status === 'arbeitet');
    const start = Date.now();
    hub.post(hub.human, 'anna', 'Stopp, neue Lage', { urgent: true });
    await until(() => texts(hub, 'agent:anna').some((x) => x.includes('neue Lage“')) && idle(hub));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(texts(hub, 'agent:anna').some((x) => x.includes('warte mal“'))).toBe(false);
  });

  it('/pause stellt nichts zu, bis /weiter kommt', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    hub.pause();
    hub.post(hub.human, 'team', 'Hallo');
    await new Promise((r) => setTimeout(r, 80));
    expect(texts(hub, 'team')).toHaveLength(1);
    hub.resume();
    await until(() => texts(hub, 'team').length === 2);
  });
});

describe('Verbinden und Trennen', () => {
  it('getrennte Sitzung bekommt keine Team-Nachrichten, aber weiter Privates vom Teamleiter', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.setConnected('ben', false);
    hub.post(hub.human, 'team', 'Moin');
    await until(() => texts(hub, 'team').length === 2 && idle(hub));
    expect(texts(hub, 'team')[1]).toMatch(/^anna: /);
    expect(hub.agents.get('ben')!.usage.turns).toBe(0);
    hub.post(hub.human, 'ben', 'Bist du noch da?');
    await until(() => texts(hub, 'agent:ben').length === 2 && idle(hub));
    hub.setConnected('ben', true);
    hub.post(hub.human, 'team', 'Alle wieder da?');
    await until(() => texts(hub, 'team').filter((t) => t.startsWith('ben: ')).length === 1 && idle(hub));
  });
});

describe('Antworttext', () => {
  it('nachgeahmtes Zustell-Format wird entfernt', () => {
    const raw = [
      '[Harnes – neue Nachrichten]',
      '1) Teamchat – David: Aufgabe 1 ist reserviert.',
      '',
      'Nichts beizutragen? Antworte nur mit [kein Beitrag]',
    ].join('\n');
    expect(cleanFinal(raw)).toBe('Aufgabe 1 ist reserviert.');
    expect(cleanFinal('Punkt 1) ist fertig.\nZweite Zeile')).toBe('Punkt 1) ist fertig.\nZweite Zeile');
  });
});

describe('Aufgaben und Dateien', () => {
  it('Agent legt Aufgabe an und reserviert sie; ein zweiter bekommt sie nicht', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'anna', 'aufgabe: Login bauen');
    await until(() => hub.tasks.tasks.length === 1 && idle(hub));
    expect(hub.tasks.tasks[0]).toMatchObject({ title: 'Login bauen', owner: 'anna', status: 'reserviert' });
    const r = await hub.callTool('ben', 'aufgabe_reservieren', { id: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('anna');
    const done = await hub.callTool('anna', 'aufgabe_status', { id: 1, status: 'erledigt', nachweis: 'src/login.ts' });
    expect(done.isError).toBe(false);
    expect(hub.tasks.tasks[0]!.proof).toBe('src/login.ts');
  });

  it('Datei-Reservierung schützt vor doppelter Bearbeitung', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    expect((await hub.callTool('anna', 'datei_reservieren', { pfad: 'src/app.ts' })).text).toContain('reserviert');
    expect((await hub.callTool('ben', 'datei_reservieren', { pfad: './src/app.ts' })).text).toContain('bereits von anna');
    expect(hub.tasks.holderOf('src/app.ts')).toBe('anna');
    await hub.callTool('anna', 'datei_freigeben', { pfad: 'src/app.ts' });
    expect((await hub.callTool('ben', 'datei_reservieren', { pfad: 'src/app.ts' })).text).toContain('Datei reserviert');
  });
});

describe('Vault', () => {
  it('protokolliert Chats, Aufgaben, Team und Notizen; jeder kann alles lesen', async () => {
    const { hub, vault } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'team', 'Moin Team');
    hub.post(hub.human, 'anna', 'notiz: Datenbank ist Postgres');
    await until(() => idle(hub) && texts(hub, 'agent:anna').length === 2);
    const chat = readdirSync(join(vault.root, 'Chat'));
    expect(chat.some((f) => f.endsWith('Team.md'))).toBe(true);
    expect(chat.some((f) => f.includes('Privat anna + David'))).toBe(true);
    expect(readFileSync(join(vault.root, 'Agenten', 'anna.md'), 'utf8')).toContain('Datenbank ist Postgres');
    expect(existsSync(join(vault.root, 'Aufgaben.md'))).toBe(true);
    expect(readFileSync(join(vault.root, 'Team.md'), 'utf8')).toContain('| ben |');

    // ben liest annas Privatchat und annas Notiz
    const list = (await hub.callTool('ben', 'vault_liste', {})).text;
    const privat = list.split('\n').find((l) => l.includes('Privat anna'))!;
    expect((await hub.callTool('ben', 'vault_lesen', { pfad: privat })).text).toContain('Datenbank ist Postgres');
    expect((await hub.callTool('ben', 'vault_suchen', { begriff: 'postgres' })).text).toContain('Agenten/anna.md');
    await hub.callTool('ben', 'wissen_schreiben', { titel: 'Datenbank', text: 'Wir nutzen Postgres 17.' });
    await hub.callTool('ben', 'entscheidung_festhalten', { text: 'Postgres statt SQLite' });
    expect(readFileSync(join(vault.root, 'Wissen', 'Datenbank.md'), 'utf8')).toContain('Postgres 17');
    expect(readFileSync(join(vault.root, 'Entscheidungen.md'), 'utf8')).toContain('Postgres statt SQLite');
    // kein Ausbruch aus dem Vault
    expect((await hub.callTool('ben', 'vault_lesen', { pfad: '../../etwas.md' })).isError).toBe(true);
  });
});

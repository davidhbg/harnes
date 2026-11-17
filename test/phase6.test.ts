import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { idle, makeHub, until } from './helpers.js';

const texts = (hub: ReturnType<typeof makeHub>['hub'], channel: string) =>
  hub.channelMessages(channel).filter((m) => !m.system).map((m) => `${m.from}: ${m.text}`);

describe('Budget', () => {
  it('Sitzung bekommt nach erreichtem Budget keine Post mehr, bis es angehoben wird', async () => {
    const { hub } = makeHub();
    const anna = await hub.addAgent({ kind: 'echo', name: 'anna' });
    hub.setBudget('anna', 1000);
    // Verbrauch melden wie eine echte Sitzung
    (anna.adapter as unknown as { ctx: { usage: (u: object) => void } }).ctx.usage({ inputTokens: 900, outputTokens: 200 });
    expect(anna.budgetHit).toBe(true);
    expect(hub.messages.some((m) => m.system && m.text.includes('Budget'))).toBe(true);
    hub.post(hub.human, 'anna', 'Hallo?');
    await new Promise((r) => setTimeout(r, 80));
    expect(texts(hub, 'agent:anna')).toHaveLength(1);
    hub.setBudget('anna', 5000);
    await until(() => texts(hub, 'agent:anna').length === 2 && idle(hub));
  });
});

describe('Automatische Datei-Sperre', () => {
  it('sperrt während der Runde, gibt am Rundenende frei; Reservierung bleibt', async () => {
    const { hub } = makeHub({}, 60);
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'anna', 'bearbeite src/app.ts');
    await until(() => hub.tasks.holderOf('src/app.ts') === 'anna');
    expect(hub.tasks.auto.size).toBe(1);
    hub.post(hub.human, 'ben', 'bearbeite src/app.ts');
    await until(() => texts(hub, 'agent:ben').length === 2 && texts(hub, 'agent:anna').length === 2 && idle(hub), 5000);
    expect(texts(hub, 'agent:ben')[1]).toContain('gehört gerade anna');
    expect(texts(hub, 'agent:anna')[1]).toContain('bearbeitet');
    expect(hub.tasks.holderOf('src/app.ts')).toBeUndefined();
    // ausdrückliche Reservierung überdauert die Runde
    await hub.callTool('anna', 'datei_reservieren', { pfad: 'src/app.ts' });
    hub.post(hub.human, 'anna', 'bearbeite src/app.ts');
    await until(() => texts(hub, 'agent:anna').length === 4 && idle(hub), 5000);
    expect(hub.tasks.holderOf('src/app.ts')).toBe('anna');
  });
});

describe('Aufgaben verteilen sich selbst (drei Agenten, ohne Chaos)', () => {
  it('jede Aufgabe genau einmal erledigt, mit Nachweis', async () => {
    const { hub } = makeHub({}, 30);
    for (const n of ['anna', 'ben', 'carl']) await hub.addAgent({ kind: 'echo', name: n });
    for (const t of ['Login', 'Tests', 'Doku', 'Datenbank', 'Design']) hub.tasks.add(hub.human, t);
    hub.post(hub.human, 'team', 'Bitte arbeite die offenen Aufgaben ab.');
    await until(() => idle(hub), 8000);
    // noch eine Runde, bis alles weg ist
    for (let i = 0; i < 3 && hub.tasks.tasks.some((t) => t.status !== 'erledigt'); i++) {
      hub.post(hub.human, 'team', 'arbeite weiter');
      await until(() => idle(hub), 8000);
    }
    expect(hub.tasks.tasks.every((t) => t.status === 'erledigt')).toBe(true);
    expect(hub.tasks.tasks.every((t) => t.proof === `aufgabe-${t.id}.txt`)).toBe(true);
    const owners = new Set(hub.tasks.tasks.map((t) => t.owner));
    expect(owners.size).toBeGreaterThan(1);
  });
});

describe('Aufgaben zuweisen, löschen, Sitzungen wieder öffnen', () => {
  it('zuweisen benachrichtigt den Agenten; /wieder öffnet die letzte Runde', async () => {
    const { hub, dir } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    const t = hub.tasks.add(hub.human, 'Login');
    hub.tasks.assign(t.id, 'anna');
    expect(hub.tasks.get(t.id)).toMatchObject({ owner: 'anna', status: 'reserviert' });
    hub.tasks.remove(t.id);
    expect(hub.tasks.tasks).toHaveLength(0);

    // zweite Zentrale auf demselben Speicher: kennt die Sitzung vom letzten Mal
    const { Hub } = await import('../src/hub/hub.js');
    const { Store } = await import('../src/hub/store.js');
    const hub2 = new Hub({ ...hub.opts, store: new Store(join(dir, 'state')) });
    expect(hub2.lastRoster.map((s) => s.name)).toEqual(['anna']);
    const opened = await hub2.reopenLast();
    expect(opened).toEqual(['anna']);
  });
});

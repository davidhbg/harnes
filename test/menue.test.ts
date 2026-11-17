import { join, resolve } from 'node:path';
import { McpTools } from '../src/adapters/mcp-client.js';
import { describe, expect, it } from 'vitest';
import { isDue, parseWann } from '../src/hub/plans.js';
import { teamPrompt } from '../src/hub/prompts.js';
import { roleById } from '../src/hub/roles.js';
import { Store } from '../src/hub/store.js';
import { splitCommand } from '../src/ui/Home.js';
import { suggest } from '../src/ui/commands.js';
import { mouseEvents, parseMouse } from '../src/ui/mouse.js';
import { idle, makeHub, until } from './helpers.js';

describe('Sitzungen verwalten', () => {
  it('Umbenennen: Verlauf, Aufgaben und Sperren ziehen mit, Doppelte werden abgelehnt', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    hub.post(hub.human, 'anna', 'hallo anna');
    await until(() => idle(hub));
    const t = hub.tasks.add(hub.human, 'Tests schreiben');
    hub.tasks.assign(t.id, 'anna');
    expect(() => hub.renameAgent('anna', 'ben')).toThrow(/gibt es schon/);
    expect(hub.renameAgent('anna', 'Mia')).toBe('mia');
    expect([...hub.agents.keys()]).toEqual(['mia', 'ben']);
    expect(hub.channelMessages('agent:mia').some((m) => m.text === 'hallo anna')).toBe(true);
    expect(hub.tasks.tasks[0]!.owner).toBe('mia');
    expect(hub.messages.some((m) => m.system && m.text.includes('anna heißt jetzt mia'))).toBe(true);
    // Die Sitzung arbeitet unter dem neuen Namen weiter
    hub.post(hub.human, 'mia', 'noch da?');
    await until(() => hub.channelMessages('agent:mia').some((m) => m.from === 'mia' && m.text.includes('noch da?')));
  });

  it('Modell wechseln setzt das Modell der Sitzung', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    const note = await hub.setModel('anna', 'klein-1');
    expect(hub.agents.get('anna')!.spec.model).toBe('klein-1');
    expect(note).toContain('klein-1');
  });

  it('eigene Befehle der Sitzung: ohne Unterstützung eine klare Meldung', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await expect(hub.sendCommand('anna', '/compact')).rejects.toThrow(/keine eigenen Befehle/);
  });
});

describe('Eingabehilfen', () => {
  it('Vorschläge beim Tippen von /', () => {
    expect(suggest('/mo').map((c) => c.name)).toEqual(['/model']);
    expect(suggest('/model ').length).toBe(0);
    expect(suggest('hallo').length).toBe(0);
    expect(suggest('/').length).toBeGreaterThan(3);
  });

  it('Maus-Meldungen werden erkannt und nicht als Text getippt', () => {
    expect(parseMouse('\u001b[<0;10;5M\u001b[<0;10;5m\u001b[<64;3;4M\u001b[<65;3;4M')).toEqual([
      { kind: 'press', button: 0, x: 9, y: 4 },
      { kind: 'release', button: 0, x: 9, y: 4 },
      { kind: 'wheelUp', button: 0, x: 2, y: 3 },
      { kind: 'wheelDown', button: 1, x: 2, y: 3 },
    ]);
    expect(mouseEvents('[<0;10;5M')).toBe(true);
    expect(mouseEvents('hallo')).toBe(false);
  });
});

describe('Startseite, Sitzungsarten und MCP', () => {
  it('Befehle je Sitzungsart: Claude-Befehle nur im Claude-Kanal, /new bei Codex', () => {
    expect(suggest('/comp', 'claude-abo').map((c) => c.name)).toContain('/compact');
    expect(suggest('/comp').map((c) => c.name)).not.toContain('/compact');
    expect(suggest('/ne', 'codex')[0]!.name).toBe('/new');
    expect(suggest('/ne').map((c) => c.name)).toEqual(['/neu']);
  });

  it('eine geschlossene Sitzung kommt beim nächsten Start nicht wieder', async () => {
    const { hub, dir } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'claude' });
    await hub.addAgent({ kind: 'echo', name: 'ben' });
    await hub.removeAgent('claude');
    await hub.shutdown();
    const roster = new Store(join(dir, 'state')).loadJson<{ name: string }[]>('roster.json', []);
    expect(roster.map((r) => r.name)).toEqual(['ben']);
  });

  it('MCP-Befehlszeile wird richtig zerlegt', () => {
    expect(splitCommand('npx -y @modelcontextprotocol/server-filesystem "C:\Mein Ordner"')).toEqual(['npx', '-y', '@modelcontextprotocol/server-filesystem', 'C:\Mein Ordner']);
  });
});

describe('Rollen, Zeitpläne, Suche', () => {
  it('Zeitpläne: Angaben verstehen und zur richtigen Zeit auslösen', async () => {
    expect(parseWann('täglich 08:00')).toEqual({ kind: 'taeglich', minute: 480 });
    expect(parseWann('alle 30 min')).toEqual({ kind: 'alle', ms: 1_800_000 });
    expect(parseWann('alle 2 std')).toEqual({ kind: 'alle', ms: 7_200_000 });
    expect(() => parseWann('irgendwann')).toThrow(/Wann/);
    expect(() => parseWann('alle 1 min')).toThrow(/5 Minuten/);
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    const p = hub.plans.add('Tests starten', 'anna', 'alle 30 min');
    expect(hub.runDuePlans(p.seit + 60_000)).toEqual([]);
    expect(hub.runDuePlans(p.seit + 31 * 60_000).map((x) => x.id)).toEqual([p.id]);
    expect(hub.channelMessages('agent:anna').some((m) => m.text === '[Zeitplan] Tests starten')).toBe(true);
    // gleich danach nicht noch einmal
    expect(hub.runDuePlans(p.seit + 32 * 60_000)).toEqual([]);
    const morning = new Date(2026, 10, 16, 8, 0).getTime();
    const daily = { id: 9, text: 'x', an: 'team', wann: 'täglich 08:00', aktiv: true, zuletzt: 0, seit: 0 };
    expect(isDue(daily, morning - 60_000)).toBe(false);
    expect(isDue(daily, morning + 60_000)).toBe(true);
    expect(isDue({ ...daily, zuletzt: morning + 1000 }, morning + 60_000)).toBe(false);
    await hub.shutdown();
  });

  it('Rolle setzen: Sitzung erfährt sie, Teamregeln enthalten sie', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna', rolle: 'tester' });
    expect(teamPrompt({ name: 'anna', human: 'David', members: [], cwd: '.', vaultDir: '.', tools: true, role: roleById('tester')!.prompt })).toContain('Deine Rolle: Tester');
    expect(hub.setRole('anna', 'reviewer')).toContain('Reviewer');
    expect(hub.agents.get('anna')!.spec.rolle).toBe('reviewer');
    expect(hub.agents.get('anna')!.inbox.some((m) => m.text.includes('Deine Rolle: Reviewer'))).toBe(true);
    expect(() => hub.setRole('anna', 'koch')).toThrow(/kenne ich nicht/);
    await hub.shutdown();
  });

  it('Verlauf durchsuchen findet Nachrichten aus allen Chats', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    hub.post(hub.human, 'team', 'Bitte die Login-Seite bauen');
    hub.post(hub.human, 'anna', 'privat: Datenbank prüfen');
    expect(hub.search('login').length).toBeGreaterThan(0);
    expect(hub.search('DATENBANK')[0]!.to).toBe('anna');
    expect(hub.search('gibtsnicht')).toEqual([]);
    await hub.shutdown();
  });
});

describe('MCP für lokale Modelle', () => {
  it('startet einen MCP-Server, meldet seine Werkzeuge und ruft sie auf', async () => {
    const mcp = new McpTools();
    await mcp.connect({ demo: { befehl: process.execPath, args: [resolve('test/fake-mcp.mjs')] }, kaputt: { befehl: 'gibt-es-nicht-xyz' } }, process.cwd());
    expect(mcp.defs.map((d) => d.name)).toEqual(['mcp__demo__wetter']);
    expect(mcp.defs[0]!.inputSchema.required).toEqual(['stadt']);
    expect(await mcp.call('mcp__demo__wetter', { stadt: 'Erfurt' })).toBe('Sonnig in Erfurt');
    expect(mcp.failed.has('kaputt')).toBe(true);
    await mcp.close();
  }, 40_000);
});

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter } from '../src/adapters/index.js';
import { defaultConfig } from '../src/config.js';
import { Hub } from '../src/hub/hub.js';
import { Store } from '../src/hub/store.js';
import { Vault } from '../src/hub/vault.js';
import { until } from './helpers.js';

interface Req {
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[];
  tools?: unknown[];
}
type Script = (req: Req, n: number) => { status?: number; body: unknown };

let server: Server | undefined;
let hubRef: Hub | undefined;
afterEach(async () => {
  await hubRef?.shutdown();
  server?.close();
});

const call = (id: string, name: string, args: unknown) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});
const text = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });

/** Nachbau einer OpenAI-kompatiblen Schnittstelle (wie DeepSeek, Ollama, LM Studio). */
async function setup(script: Script) {
  let n = 0;
  const requests: Req[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"data":[]}');
      }
      const body = JSON.parse(raw) as Req;
      requests.push(body);
      const out = script(body, n++);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'rh-oai-'));
  const config = defaultConfig();
  config.vaultRoot = join(dir, 'vault');
  config.anbieter.mock = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, modell: 'mock-1' };
  const vault = new Vault(join(dir, 'vault', 'T'), 'T', config.benutzer);
  vault.init();
  const hub = (hubRef = new Hub({ project: 'T', cwd: dir, config, store: new Store(join(dir, 'state')), vault, mcpServerPath: 'unused', createAdapter }));
  const rec = await hub.addAgent({ kind: 'openai', provider: 'mock', name: 'lokal' });
  await until(() => rec.status === 'wartet');
  return { hub, rec, dir, requests };
}

const replies = (hub: Hub) => hub.channelMessages('agent:lokal').filter((m) => m.from === 'lokal').map((m) => m.text);

describe('OpenAI-kompatible Modelle (DeepSeek, Ollama, LM Studio)', () => {
  it('Werkzeug-Schleife: Team-Werkzeug, Datei schreiben, Antwort im Privatchat', async () => {
    const { hub, rec, dir, requests } = await setup((_req, n) => {
      if (n === 0) return { body: call('c1', 'aufgabe_anlegen', { titel: 'Notiz schreiben' }) };
      if (n === 1) return { body: call('c2', 'datei_schreiben', { pfad: 'notizen/hallo.txt', inhalt: 'Hallo Team' }) };
      return { body: text('Fertig: notizen/hallo.txt angelegt.') };
    });
    hub.post(hub.human, 'lokal', 'Leg bitte eine Notiz an');
    await until(() => replies(hub).length === 1, 8000);
    expect(replies(hub)[0]).toBe('Fertig: notizen/hallo.txt angelegt.');
    expect(readFileSync(join(dir, 'notizen', 'hallo.txt'), 'utf8')).toBe('Hallo Team');
    expect(hub.tasks.tasks[0]).toMatchObject({ title: 'Notiz schreiben', createdBy: 'lokal' });
    expect(rec.usage.inputTokens).toBe(300);
    // Teamregeln und Werkzeuge wurden mitgeschickt, das Werkzeug-Ergebnis kam zurück
    expect(requests[0]!.messages[0]!.content).toContain('Mitglied eines KI-Teams');
    expect(requests[0]!.tools!.length).toBeGreaterThan(15);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', content: 'Aufgabe #1 angelegt: Notiz schreiben' });
  });

  it('Schutz: kein Schreiben außerhalb des Projekts, reservierte Dateien bleiben tabu', async () => {
    const { hub, dir } = await setup((req, n) => {
      if (n === 0) return { body: call('c1', 'datei_schreiben', { pfad: '../draussen.txt', inhalt: 'x' }) };
      if (n === 1) return { body: call('c2', 'datei_schreiben', { pfad: 'app.ts', inhalt: 'x' }) };
      const results = req.messages.filter((m) => m.role === 'tool').map((m) => m.content);
      return { body: text(results.join(' | ')) };
    });
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await hub.callTool('anna', 'datei_reservieren', { pfad: 'app.ts' });
    hub.post(hub.human, 'lokal', 'Schreib zwei Dateien');
    await until(() => replies(hub).length === 1, 8000);
    expect(replies(hub)[0]).toContain('außerhalb des Projektordners');
    expect(replies(hub)[0]).toContain('von anna reserviert');
    expect(existsSync(join(dir, '..', 'draussen.txt'))).toBe(false);
    expect(existsSync(join(dir, 'app.ts'))).toBe(false);
  });

  it('Heikle Dateien (Git-Hooks, Paket-Skripte) nur mit Freigabe', async () => {
    const { hub, dir } = await setup((req, n) => {
      if (n === 0) return { body: call('c1', 'datei_schreiben', { pfad: '.git/hooks/pre-commit', inhalt: 'echo boese' }) };
      return { body: text(String(req.messages.at(-1)!.content)) };
    });
    hub.post(hub.human, 'lokal', 'Richte einen Hook ein');
    await until(() => hub.approvals.length === 1, 8000);
    expect(hub.approvals[0]!.title).toContain('heikle Datei');
    hub.resolveApproval(hub.approvals[0]!.id, 'nein');
    await until(() => replies(hub).length === 1, 8000);
    expect(replies(hub)[0]).toContain('abgelehnt');
    expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  }, 30_000);

  it('Befehle laufen nur mit Freigabe', async () => {
    const { hub, rec } = await setup((req, n) => {
      if (n === 0) return { body: call('c1', 'befehl_ausfuehren', { befehl: 'node -e "console.log(6*7)"' }) };
      return { body: text(`Ausgabe: ${req.messages.at(-1)!.content}`) };
    });
    hub.post(hub.human, 'lokal', 'Rechne');
    await until(() => hub.approvals.length === 1, 8000);
    expect(rec.status).toBe('freigabe');
    expect(hub.approvals[0]!.detail).toContain('node -e');
    hub.resolveApproval(hub.approvals[0]!.id, 'ja');
    await until(() => replies(hub).length === 1, 15_000);
    expect(replies(hub)[0]).toBe('Ausgabe: 42');
  }, 30_000);

  it('Modell ohne Werkzeuge chattet trotzdem mit', async () => {
    const { hub, requests } = await setup((req) => {
      if (req.tools) return { status: 400, body: { error: { message: 'registry.ollama.ai/library/x does not support tools' } } };
      return { body: text('<think>hm</think>Moin, ich bin dabei.') };
    });
    hub.post(hub.human, 'team', 'Moin');
    await until(() => hub.channelMessages('team').some((m) => m.from === 'lokal'), 8000);
    expect(hub.channelMessages('team').find((m) => m.from === 'lokal')!.text).toBe('Moin, ich bin dabei.');
    expect(requests.at(-1)!.tools).toBeUndefined();
    expect(requests.at(-1)!.messages[0]!.content).not.toContain('aufgabe_reservieren');
  });
});

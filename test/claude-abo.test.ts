import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter } from '../src/adapters/index.js';
import { defaultConfig } from '../src/config.js';
import { Hub } from '../src/hub/hub.js';
import { startServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { Vault } from '../src/hub/vault.js';
import { until } from './helpers.js';

/** Legt einen Starter für den Claude-Nachbau an (unter Windows eine .cmd-Datei). */
function fakeClaudeCommand(dir: string): string {
  const script = resolve('test/fake-claude.mjs');
  if (process.platform === 'win32') {
    const file = join(dir, 'fake-claude.cmd');
    writeFileSync(file, `@"${process.execPath}" "${script}" %*\r\n`);
    return file;
  }
  const file = join(dir, 'fake-claude');
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup() {
  expect(existsSync(resolve('dist/hook.js')), 'vorher npm run build ausführen').toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'rh-abo-'));
  const config = defaultConfig();
  config.vaultRoot = join(dir, 'vault');
  config.claudeAbo.befehl = fakeClaudeCommand(dir);
  const vault = new Vault(join(dir, 'vault', 'T'), 'T', config.benutzer);
  vault.init();
  const hub = new Hub({ project: 'T', cwd: dir, config, store: new Store(join(dir, 'state')), vault, mcpServerPath: resolve('dist/mcp.js'), createAdapter });
  const server = await startServer(hub);
  cleanup = async () => {
    await hub.shutdown();
    await server.close();
  };
  return { hub, dir };
}

const from = (hub: Hub, who: string, channel: string) =>
  hub.channelMessages(channel).filter((m) => m.from === who).map((m) => m.text);

describe('Claude im Abo (mit Nachbau von Claude Code)', () => {
  it('startet, bekommt Post in der Pause und antwortet in den richtigen Chat', async () => {
    const { hub } = await setup();
    const rec = await hub.addAgent({ kind: 'claude-abo', name: 'claude' });
    await until(() => rec.status === 'wartet', 15_000);
    await until(() => rec.adapter!.screenLines!().join('\n').includes('Teamregeln erhalten: ja'), 5000);

    hub.post(hub.human, 'claude', 'Wie weit bist du?');
    await until(() => from(hub, 'claude', 'agent:claude').length === 1, 15_000);
    expect(from(hub, 'claude', 'agent:claude')[0]).toBe('Fake-Claude: verstanden – Wie weit bist du?');

    hub.post(hub.human, 'team', 'Moin Team');
    await until(() => from(hub, 'claude', 'team').length === 1, 15_000);
    await until(() => rec.status === 'wartet', 5000);
  }, 60_000);

  it('Post, die während der Arbeit ankommt, wird am Rundenende direkt nachgereicht', async () => {
    const { hub } = await setup();
    const rec = await hub.addAgent({ kind: 'claude-abo', name: 'claude' });
    await until(() => rec.status === 'wartet', 15_000);
    hub.post(hub.human, 'claude', 'langsam bitte');
    await until(() => rec.status === 'arbeitet', 15_000);
    hub.post(hub.human, 'claude', 'zweite Frage');
    await until(() => from(hub, 'claude', 'agent:claude').length === 2, 20_000);
    expect(from(hub, 'claude', 'agent:claude')[1]).toContain('zweite Frage');
    // nur ein Anstoß wurde getippt: die zweite Nachricht kam über den Stop-Hook
    const screen = rec.adapter!.screenLines!().join('\n');
    expect(screen.match(/> Harnes: neue Nachrichten/g)?.length).toBe(1);
  }, 60_000);

  it('dringend unterbricht, Datei-Reservierung und Freigabe-Karte greifen', async () => {
    const { hub, dir } = await setup();
    const rec = await hub.addAgent({ kind: 'claude-abo', name: 'claude' });
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    await until(() => rec.status === 'wartet', 15_000);

    // dringend
    hub.post(hub.human, 'claude', 'langsam bitte');
    await until(() => rec.status === 'arbeitet', 15_000);
    hub.post(hub.human, 'claude', 'Stopp, neue Lage', { urgent: true });
    await until(() => from(hub, 'claude', 'agent:claude').some((t) => t.includes('neue Lage')), 20_000);
    expect(from(hub, 'claude', 'agent:claude').some((t) => t.includes('langsam'))).toBe(false);
    await until(() => rec.status === 'wartet', 5000);

    // Datei von anna reserviert → Claude darf sie nicht bearbeiten
    const file = join(dir, 'app.ts');
    await hub.callTool('anna', 'datei_reservieren', { pfad: file });
    hub.post(hub.human, 'claude', `bearbeite ${file}`);
    await until(() => from(hub, 'claude', 'agent:claude').some((t) => t.includes('verweigert')), 20_000);
    expect(from(hub, 'claude', 'agent:claude').at(-1)).toContain('für anna reserviert');
    await until(() => rec.status === 'wartet', 5000);

    // Freigabe-Karte: ablehnen
    hub.post(hub.human, 'claude', 'erlaubnis bitte');
    await until(() => hub.approvals.length === 1, 20_000);
    expect(rec.status).toBe('freigabe');
    expect(hub.approvals[0]!.detail).toBe('$ npm test');
    hub.resolveApproval(hub.approvals[0]!.id, 'nein');
    await until(() => from(hub, 'claude', 'agent:claude').some((t) => t.includes('abgelehnt')), 20_000);
  }, 90_000);

  it('API-Fehler (Login abgelaufen) wird verständlich gemeldet', async () => {
    const { hub } = await setup();
    const rec = await hub.addAgent({ kind: 'claude-abo', name: 'claude' });
    await until(() => rec.status === 'wartet', 15_000);
    hub.post(hub.human, 'claude', 'fehlschlag');
    await until(() => rec.status === 'fehler', 15_000);
    expect(rec.detail).toContain('/login');
    expect(hub.messages.some((m) => m.system && m.text.includes('abgelaufen'))).toBe(true);
  }, 40_000);
});

describe('MCP-Server (Team-Werkzeuge für Claude Code und Codex)', () => {
  it('listet die Werkzeuge und reicht Aufrufe an die Zentrale weiter', async () => {
    const { hub } = await setup();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    const ben = await hub.addAgent({ kind: 'echo', name: 'ben' });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/mcp.js')],
        env: { ...(process.env as Record<string, string>), REMOTEHARNES_URL: hub.url, REMOTEHARNES_TOKEN: ben.token },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['team_senden', 'privat_senden', 'aufgabe_reservieren', 'vault_lesen']));
    const res = (await client.callTool({ name: 'team_senden', arguments: { text: 'kannst du mir kurz helfen?', an: ['anna'] } })) as {
      content: { text: string }[];
    };
    expect(res.content[0]!.text).toContain('Zugestellt an: anna');
    await until(() => hub.channelMessages('team').some((m) => m.from === 'anna' && m.text.includes('@ben klar')), 5000);
    const bad = (await client.callTool({ name: 'aufgabe_reservieren', arguments: { id: 99 } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    await client.close();
  }, 30_000);
});

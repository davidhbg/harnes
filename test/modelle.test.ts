import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { friendlyCodexError } from '../src/adapters/codex.js';
import { createAdapter } from '../src/adapters/index.js';
import { defaultConfig } from '../src/config.js';
import { Hub } from '../src/hub/hub.js';
import { Store } from '../src/hub/store.js';
import { Vault } from '../src/hub/vault.js';
import { CLAUDE_MODELS, cachedModels, listModels } from '../src/models.js';

describe('Modelllisten', () => {
  it('fragt OpenAI-kompatible Anbieter nach ihren Modellen (sortiert, ohne Doppelte)', async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.url?.endsWith('/models') ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'v4-pro' }, { id: 'flash' }, { id: 'flash' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const config = defaultConfig();
    config.anbieter.mock = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, modell: 'flash' };
    const list = await listModels(config, { kind: 'openai', provider: 'mock' });
    server.close();
    expect(list.map((m) => m.id)).toEqual(['flash', 'v4-pro']);
    expect(cachedModels({ kind: 'openai', provider: 'mock' })?.length).toBe(2);
  });

  it('meldet einen nicht erreichbaren Anbieter verständlich', async () => {
    const config = defaultConfig();
    config.anbieter.weg = { baseUrl: 'http://127.0.0.1:9/v1', modell: 'x' };
    await expect(listModels(config, { kind: 'openai', provider: 'weg' })).rejects.toThrow(/nicht erreichbar/);
  });

  it('Claude im Abo hat eine feste Liste', () => {
    expect(cachedModels({ kind: 'claude-abo' })).toBe(CLAUDE_MODELS);
  });

  it('Codex: „Modell geht mit diesem Konto nicht“ statt rohem JSON', () => {
    const raw = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.4-mini\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}';
    expect(friendlyCodexError(raw, 'gpt-5.4-mini')).toContain('Das Modell gpt-5.4-mini geht mit diesem Konto nicht.');
    expect(friendlyCodexError("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.")).toContain('Das Modell gpt-5.5 geht mit diesem Konto nicht.');
    expect(friendlyCodexError('Netzwerk weg')).toBe('Netzwerk weg');
  });

  it('Hinweise einer Sitzung stehen im Team-Chat und in ihrem Privatchat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rh-mod-'));
    const config = defaultConfig();
    const vault = new Vault(join(dir, 'vault', 'T'), 'T', config.benutzer);
    vault.init();
    const hub = new Hub({ project: 'T', cwd: dir, config, store: new Store(join(dir, 'state')), vault, mcpServerPath: 'unused', createAdapter });
    hub.system('codex: Runde fehlgeschlagen', 'codex');
    hub.system('allgemein');
    expect(hub.channelMessages('team').map((m) => m.text)).toEqual(['codex: Runde fehlgeschlagen', 'allgemein']);
    expect(hub.channelMessages('agent:codex').map((m) => m.text)).toEqual(['codex: Runde fehlgeschlagen']);
    await hub.shutdown();
  });
});

describe('Codex aktuell halten', () => {
  it('vergleicht Versionen richtig (Vorabversionen sind älter)', async () => {
    const { olderThan } = await import('../src/codex-update.js');
    expect(olderThan('0.130.0-alpha.5', '0.169.0')).toBe(true);
    expect(olderThan('0.169.0', '0.169.0')).toBe(false);
    expect(olderThan('0.169.0-alpha.1', '0.169.0')).toBe(true);
    expect(olderThan('0.170.0', '0.169.0')).toBe(false);
    expect(olderThan('1.0.0', '0.999.9')).toBe(false);
  });
});

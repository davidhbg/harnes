import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BalanceWatch, connectedProviders, fetchBalance, fmtMoney } from '../src/balance.js';
import { defaultConfig, loadConfig, saveKey } from '../src/config.js';
import { Store } from '../src/hub/store.js';
import { runCommand } from '../src/ui/commands.js';
import { createUiState, type UiAction } from '../src/ui/state.js';
import { connectVaultRoot } from '../src/vault-connect.js';
import { idle, makeHub, until } from './helpers.js';

// Eigener Harnes-Ordner für diese Tests (Einstellungen, Schlüssel)
const home = mkdtempSync(join(tmpdir(), 'rh-home-'));
const oldHome = process.env.REMOTEHARNES_HOME;
process.env.REMOTEHARNES_HOME = home;
afterAll(() => {
  if (oldHome === undefined) delete process.env.REMOTEHARNES_HOME;
  else process.env.REMOTEHARNES_HOME = oldHome;
});

// Nachbau der Guthaben-Schnittstellen von DeepSeek und OpenRouter
let server: Server;
let base = '';
const seen: { url: string; auth: string }[] = [];
beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? '') });
    const ok = req.headers.authorization === 'Bearer gut';
    res.setHeader('content-type', 'application/json');
    if (!ok) {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (req.url === '/user/balance') {
      return res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '30.00' }, { currency: 'USD', total_balance: '4.20' }] }));
    }
    if (req.url === '/api/v1/credits') return res.end(JSON.stringify({ data: { total_credits: 10, total_usage: 2.5 } }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => server?.close());

describe('Guthaben der API-Anbieter', () => {
  it('DeepSeek: liest das Guthaben in Dollar und schickt den Schlüssel nur als Bearer', async () => {
    const b = await fetchBalance('deepseek', `${base}/v1`, 'gut');
    expect(b.betrag).toBeCloseTo(4.2);
    expect(b.waehrung).toBe('USD');
    expect(fmtMoney(b)).toBe('4,20 $');
    expect(seen.at(-1)).toEqual({ url: '/user/balance', auth: 'Bearer gut' });
  });

  it('OpenRouter: Guthaben = gekauft minus verbraucht', async () => {
    const b = await fetchBalance('openrouter', `${base}/api/v1`, 'gut');
    expect(b.betrag).toBeCloseTo(7.5);
    expect(fmtMoney(b)).toBe('7,50 $');
  });

  it('falscher Schlüssel und Anbieter ohne Abfrage werden ehrlich gemeldet', async () => {
    expect((await fetchBalance('deepseek', `${base}/v1`, 'falsch')).hinweis).toBe('Schlüssel abgelehnt');
    const none = await fetchBalance('anthropic', 'https://api.anthropic.com/v1', 'x');
    expect(none.betrag).toBeUndefined();
    expect(none.hinweis).toBe('Guthaben nicht abrufbar');
  });

  it('fragt nur Anbieter mit Schlüssel ab und meldet die Änderung', async () => {
    const config = defaultConfig();
    config.claudeApi.apiKeyEnv = 'RH_TEST_KEIN_CLAUDE';
    config.anbieter = {
      deepseek: { baseUrl: `${base}/v1`, apiKeyEnv: 'RH_TEST_DS', modell: 'x' },
      openrouter: { baseUrl: `${base}/api/v1`, apiKeyEnv: 'RH_TEST_OR', modell: 'x' },
      ollama: { baseUrl: 'http://127.0.0.1:9/v1', modell: 'x' },
    };
    saveKey('RH_TEST_DS', 'gut');
    expect(connectedProviders(config).map((p) => p.name)).toEqual(['deepseek']);
    let changes = 0;
    const watch = new BalanceWatch(config, () => changes++);
    await watch.refresh();
    expect(changes).toBe(1);
    expect(watch.balances).toHaveLength(1);
    expect(fmtMoney(watch.balances[0]!)).toBe('4,20 $');
    // ohne force höchstens alle 30 Sekunden
    await watch.refresh(false);
    expect(changes).toBe(1);
  });

  it('/guthaben zeigt das Ergebnis in der Fußzeile', async () => {
    const { hub } = makeHub();
    const config = defaultConfig();
    config.claudeApi.apiKeyEnv = 'RH_TEST_KEIN_CLAUDE';
    config.anbieter = { deepseek: { baseUrl: `${base}/v1`, apiKeyEnv: 'RH_TEST_DS', modell: 'x' } };
    hub.balance = new BalanceWatch(config, () => hub.notifyChange());
    const ui = createUiState();
    const msg = await runCommand('/guthaben', { hub, ui, action: () => undefined });
    expect(msg).toBe('DeepSeek: 4,20 $');
  });
});

describe('Chat leeren', () => {
  it('leert nur den gewählten Chat, auch im gespeicherten Verlauf', async () => {
    const { hub, dir } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    hub.post(hub.human, 'team', 'schweig');
    hub.post(hub.human, 'anna', 'Wie weit bist du?');
    await until(() => hub.channelMessages('agent:anna').filter((m) => !m.system).length === 2 && idle(hub));
    expect(hub.channelMessages('team').filter((m) => !m.system).length).toBe(1);

    const ui = createUiState();
    ui.channel = 'team';
    expect(await runCommand('/leeren', { hub, ui, action: () => undefined })).toBe('Chat geleert.');
    expect(hub.channelMessages('team')).toHaveLength(0);
    expect(hub.channelMessages('agent:anna').length).toBe(2);
    // nach einem Neustart bleibt der Team-Chat leer, der Privatchat ist noch da
    const again = new Store(join(dir, 'state')).loadMessages(100);
    expect(again.filter((m) => m.to === 'team')).toHaveLength(0);
    expect(again.filter((m) => m.to === 'anna' || m.from === 'anna')).toHaveLength(2);
    expect(await runCommand('/leeren', { hub, ui, action: () => undefined })).toBe('Der Chat war schon leer.');
  });

  it('/clear im Team-Chat leert den Team-Chat; im Privatchat leert /leeren nur diesen', async () => {
    const { hub } = makeHub();
    await hub.addAgent({ kind: 'echo', name: 'anna' });
    hub.post(hub.human, 'team', 'schweig');
    hub.post(hub.human, 'anna', 'schweig');
    await until(() => idle(hub) && hub.agents.get('anna')!.usage.turns === 2);
    const ui = createUiState();
    ui.channel = 'team';
    expect(await runCommand('/clear', { hub, ui, action: () => undefined })).toBe('Team-Chat geleert.');
    expect(hub.channelMessages('agent:anna').length).toBe(1);
    ui.channel = 'agent:anna';
    expect(await runCommand('/leeren', { hub, ui, action: () => undefined })).toBe('Chat geleert.');
    expect(hub.channelMessages('agent:anna')).toHaveLength(0);
  });
});

describe('Anderen Vault verbinden', () => {
  it('vorhandenen Ordner verbinden: Einstellung gespeichert, Projekt lädt neu', async () => {
    const target = mkdtempSync(join(tmpdir(), 'rh-vault-'));
    const { hub } = makeHub();
    const ui = createUiState();
    const actions: UiAction[] = [];
    const msg = await runCommand(`/vault ${target}`, { hub, ui, action: (a) => actions.push(a) });
    expect(msg).toBe(`Vault verbunden: ${target}`);
    expect(loadConfig().vaultRoot).toBe(target);
    expect(actions).toEqual([{ type: 'projekt', cwd: hub.opts.cwd }]);
  });

  it('neuer Ordner wird angelegt; fehlender Oberordner oder Datei werden abgelehnt', () => {
    const parent = mkdtempSync(join(tmpdir(), 'rh-vault-'));
    const fresh = join(parent, 'Neuer Vault');
    expect(connectVaultRoot(`"${fresh}"`)).toBe(fresh);
    expect(existsSync(fresh)).toBe(true);
    expect(() => connectVaultRoot(join(parent, 'gibt', 'es nicht'))).toThrow(/gibt es nicht/);
    const file = join(parent, 'datei.txt');
    writeFileSync(file, 'x');
    expect(() => connectVaultRoot(file)).toThrow(/kein Ordner/);
    expect(() => connectVaultRoot('  ')).toThrow(/Welcher Ordner/);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).vaultRoot).toBe(fresh);
  });

  it('/vault ohne Ordner zeigt den aktuellen Vault', async () => {
    const { hub } = makeHub();
    const msg = await runCommand('/vault', { hub, ui: createUiState(), action: () => undefined });
    expect(msg).toContain(hub.opts.vault.root);
  });
});

// Prüft den Anmeldeweg von Codex bis zur Anmelde-Adresse, ohne den Browser zu öffnen.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdapter } from '../src/adapters/index.js';
import { defaultConfig } from '../src/config.js';
import { Hub } from '../src/hub/hub.js';
import { startServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { Vault } from '../src/hub/vault.js';

process.env.RH_NO_BROWSER = '1';
const tmp = mkdtempSync(join(tmpdir(), 'rh-codex-'));
const config = defaultConfig();
const vault = new Vault(join(tmp, 'vault'), 'T', 'David');
vault.init();
const hub = new Hub({ project: 'T', cwd: tmp, config, store: new Store(join(tmp, 'state')), vault, mcpServerPath: resolve('dist/mcp.js'), createAdapter });
const server = await startServer(hub);
const rec = await hub.addAgent({ kind: 'codex', name: 'codex' });
console.log('Status nach Start:', rec.status, '|', (rec.detail ?? '').slice(0, 90));
if (rec.adapter?.login) {
  void rec.adapter.login().catch((e) => console.log('login():', e.message));
  await new Promise((r) => setTimeout(r, 4000));
  const notice = hub.messages.filter((m) => m.system).map((m) => m.text).find((t) => t.includes('http'));
  const url = /https?:\/\/\S+/.exec(notice ?? '')?.[0] ?? '';
  console.log('Anmelde-Adresse erhalten:', url ? `${new URL(url).origin}${new URL(url).pathname} (mit ${[...new URL(url).searchParams.keys()].length} Parametern)` : 'NEIN');
  console.log('Status:', rec.status, '|', (rec.detail ?? '').slice(0, 80));
}
await hub.shutdown();
await server.close();
process.exit(0);

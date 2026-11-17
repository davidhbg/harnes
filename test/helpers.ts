import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EchoAdapter } from '../src/adapters/echo.js';
import { defaultConfig, type Config } from '../src/config.js';
import { Hub } from '../src/hub/hub.js';
import { Store } from '../src/hub/store.js';
import { Vault } from '../src/hub/vault.js';

export function makeHub(over: Partial<Config> = {}, echoDelay = 5) {
  const dir = mkdtempSync(join(tmpdir(), 'rh-test-'));
  const config: Config = { ...defaultConfig(), ...over, vaultRoot: join(dir, 'vault') };
  const vault = new Vault(join(dir, 'vault', 'Testprojekt'), 'Testprojekt', config.benutzer);
  vault.init();
  const hub = new Hub({
    project: 'Testprojekt',
    cwd: dir,
    config,
    store: new Store(join(dir, 'state')),
    vault,
    mcpServerPath: 'unused',
    createAdapter: async (_spec, ctx) => new EchoAdapter(ctx, echoDelay),
  });
  return { hub, dir, vault };
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('Zeitüberschreitung beim Warten');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const idle = (hub: Hub) => [...hub.agents.values()].every((a) => a.status === 'wartet' && a.inbox.length === 0);

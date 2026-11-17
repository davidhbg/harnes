// Live-Probe einer echten Anbindung ohne Oberfläche.
// Aufruf: npx tsx scratch/live.mts <art> <name> <modell|-> <wartezeit-s> "<nachricht>" ["<nachricht 2>" …]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdapter } from '../src/adapters/index.js';
import { loadConfig } from '../src/config.js';
import { Hub } from '../src/hub/hub.js';
import { startServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { Vault } from '../src/hub/vault.js';
import { parseSpec } from '../src/ui/commands.js';

const [kind = 'test', name = 'probe', model = '-', waitS = '120', ...messages] = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), 'rh-live-'));
const config = loadConfig();
const cwd = process.env.RH_CWD ? resolve(process.env.RH_CWD) : process.cwd();
const vault = new Vault(join(tmp, 'vault'), 'Live', config.benutzer);
vault.init();
const hub = new Hub({ project: 'Live', cwd, config, store: new Store(join(tmp, 'state')), vault, mcpServerPath: resolve('dist/mcp.js'), createAdapter });
const server = await startServer(hub);
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;
let seenMsgs = 0;
const seenLog = new Map<string, number>();
const lastStatus = new Map<string, string>();
hub.on('change', () => {
  for (; seenMsgs < hub.messages.length; seenMsgs++) {
    const m = hub.messages[seenMsgs]!;
    console.log(`${stamp()} MSG ${m.from} → ${m.to}: ${m.text.replace(/\n/g, ' ⏎ ').slice(0, 400)}`);
  }
  for (const a of hub.agents.values()) {
    const st = `${a.status}${a.detail ? ` (${a.detail})` : ''}`;
    if (lastStatus.get(a.name) !== st) {
      lastStatus.set(a.name, st);
      console.log(`${stamp()} STATUS ${a.name}: ${st}`);
    }
    for (let i = seenLog.get(a.name) ?? 0; i < a.log.length; i++) console.log(`${stamp()} LOG ${a.name} [${a.log[i]!.kind}] ${a.log[i]!.text.replace(/\n/g, ' ⏎ ').slice(0, 300)}`);
    seenLog.set(a.name, a.log.length);
  }
  for (const ap of hub.approvals) {
    console.log(`${stamp()} FREIGABE ${ap.agent}: ${ap.title} | ${ap.detail.slice(0, 200)} → ${process.env.RH_APPROVE ?? 'ja'}`);
    hub.resolveApproval(ap.id, (process.env.RH_APPROVE as 'ja' | 'nein') ?? 'ja');
  }
});
const until = async (cond: () => boolean, s: number) => {
  const end = Date.now() + s * 1000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  return cond();
};

const rec = await hub.addAgent(parseSpec(hub, kind, name, model === '-' ? undefined : model));
console.log(`${stamp()} gestartet: ${rec.name} (${rec.label})`);
if (!(await until(() => rec.status === 'wartet' || rec.status === 'fehler', 90))) console.log(`${stamp()} NICHT BEREIT, Status: ${rec.status}`);
if (rec.status === 'wartet') {
  for (const text of messages) {
    const to = text.startsWith('team:') ? 'team' : rec.name;
    const before = hub.messages.filter((m) => m.from === rec.name).length;
    hub.post(hub.human, to, text.replace(/^team:/, ''));
    await until(() => rec.status === 'arbeitet', 20);
    const ok = await until(() => rec.status === 'wartet' && rec.inbox.length === 0, Number(waitS));
    console.log(`${stamp()} Runde ${ok ? 'fertig' : 'NICHT fertig'}, Antworten: ${hub.messages.filter((m) => m.from === rec.name).length - before}, Verbrauch: ${JSON.stringify(rec.usage)}`);
  }
}
if (rec.adapter?.screenLines && process.env.RH_SCREEN) console.log('--- Bildschirm ---\n' + rec.adapter.screenLines().join('\n'));
console.log('--- Aufgaben ---\n' + hub.tasks.listText());
await hub.shutdown();
await server.close();
process.exit(0);

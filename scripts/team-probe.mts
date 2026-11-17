// Echte Teamrunde: mehrere Sitzungen, eine Team-Nachricht, beobachten bis alle fertig sind.
// Aufruf: RH_CWD=<ordner> npx tsx scripts/team-probe.mts <art:name:modell,...> <sekunden> "<teamnachricht>" [aufgabe1|aufgabe2|...]
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

const [list = '', waitS = '300', text = '', tasks = ''] = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), 'rh-team-'));
const config = loadConfig();
const cwd = resolve(process.env.RH_CWD ?? '.');
const vault = new Vault(join(tmp, 'vault'), 'Teamtest', config.benutzer);
vault.init();
const hub = new Hub({ project: 'Teamtest', cwd, config, store: new Store(join(tmp, 'state')), vault, mcpServerPath: resolve('dist/mcp.js'), createAdapter });
const server = await startServer(hub);
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`;
let seen = 0;
const logSeen = new Map<string, number>();
hub.on('change', () => {
  for (; seen < hub.messages.length; seen++) {
    const m = hub.messages[seen]!;
    console.log(`${stamp()} ${m.system ? '·' : 'MSG'} ${m.from} → ${m.to}: ${m.text.replace(/\n/g, ' ⏎ ').slice(0, 300)}`);
  }
  for (const a of hub.agents.values()) {
    for (let i = logSeen.get(a.name) ?? 0; i < a.log.length; i++) {
      const e = a.log[i]!;
      if (e.kind === 'tool' || e.kind === 'fehler') console.log(`${stamp()}   ${a.name} [${e.kind}] ${e.text.slice(0, 160)}`);
    }
    logSeen.set(a.name, a.log.length);
  }
  for (const ap of hub.approvals) {
    console.log(`${stamp()}   FREIGABE ${ap.agent}: ${ap.title} | ${ap.detail.slice(0, 120)} → ja`);
    hub.resolveApproval(ap.id, 'ja');
  }
});
const until = async (cond: () => boolean, s: number) => {
  const end = Date.now() + s * 1000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 300));
  return cond();
};

for (const t of tasks.split('|').filter(Boolean)) hub.tasks.add(hub.human, t);
for (const item of list.split(',')) {
  const [kind = '', name, model] = item.split(':');
  await hub.addAgent(parseSpec(hub, kind, name, model));
}
await until(() => [...hub.agents.values()].every((a) => a.status === 'wartet' || a.status === 'fehler'), 90);
hub.post(hub.human, 'team', text);
await new Promise((r) => setTimeout(r, 5000));
const idle = () => [...hub.agents.values()].every((a) => (a.status === 'wartet' || a.status === 'fehler') && a.inbox.length === 0);
// fertig, wenn 20 s lang alle ruhig sind
let quietSince = 0;
await until(() => {
  if (!idle()) quietSince = 0;
  else if (!quietSince) quietSince = Date.now();
  return quietSince > 0 && Date.now() - quietSince > 20_000;
}, Number(waitS));
console.log('--- Aufgaben ---\n' + hub.tasks.listText());
for (const a of hub.agents.values()) console.log(`--- ${a.name}: ${a.status}, Runden ${a.usage.turns}, Tokens ${a.usage.inputTokens + a.usage.outputTokens}`);
await hub.shutdown();
await server.close();
process.exit(0);

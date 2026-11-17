// Kurze Vorführung mit Test-Agenten über den installierten Befehl `remoteharnes`.
// Zeigt am Ende den Bildschirm. Schreibt nur in einen temporären Ordner.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TermSession } from '../test/term.js';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = mkdtempSync(join(tmpdir(), 'rh-demo-'));
const proj = join(home, 'Webshop');
mkdirSync(proj);
const win = process.platform === 'win32';
const t = new TermSession(win ? 'cmd.exe' : 'remoteharnes', [...(win ? ['/c', 'remoteharnes'] : []), proj, '--vault', join(home, 'vault'), '--mit', 'test:anna,test:ben'], {
  cwd: proj,
  env: { ...(process.env as Record<string, string>), REMOTEHARNES_HOME: join(home, 'home') },
  cols: 104,
  rows: 26,
});
await t.waitFor('ben (Test-Agent) ist dem Team beigetreten', 15000);
await t.line('Moin, heute bauen wir den Login.');
await t.waitFor(/ben: ben hier/);
await t.line('@anna frag ben');
await t.waitFor(/anna: anna hier: verstanden – „@anna klar/);
await t.line('/aufgabe Login-Formular bauen');
await pause(500);
console.log(await t.screen());
await t.line('/quit');
await pause(1500);
t.kill();
process.exit(0);

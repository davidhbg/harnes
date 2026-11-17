// Läuft nach „npm install -g“: entfernt die PowerShell-Starter (.ps1) von Harnes.
// Sind PowerShell-Skripte gesperrt (Windows-Standard), würde „harnes“ sonst dort scheitern;
// ohne .ps1 nimmt PowerShell die .cmd-Starter, die immer laufen. Die Sperre selbst bleibt, wie sie ist.
const { existsSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

if (process.platform !== 'win32' || process.env.npm_config_global !== 'true') process.exit(0);
const prefix = process.env.npm_config_prefix;
if (!prefix) process.exit(0);
const names = ['harnes', 'harnes-browser', 'rh', 'remoteharnes', 'harnesremote'];
// npm legt die Starter erst nach diesem Schritt an – deshalb kurz danach noch einmal nachsehen
const clean = () => {
  for (const n of names) {
    const f = join(prefix, `${n}.ps1`);
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* egal */
    }
  }
};
clean();
const { spawn } = require('node:child_process');
const later = `setTimeout(() => { const fs = require('fs'), p = require('path'); for (const n of ${JSON.stringify(names)}) { try { fs.unlinkSync(p.join(${JSON.stringify(prefix)}, n + '.ps1')); } catch {} } }, 4000);`;
spawn(process.execPath, ['-e', later], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

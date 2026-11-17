// Läuft nach jeder Installation von Harnes.
//
// macOS: node-pty bringt ein Hilfsprogramm (spawn-helper) mit, das npm ohne Ausführrecht entpackt.
//        Ohne dieses Recht scheitert jedes Pseudo-Terminal mit „posix_spawnp failed“ – also setzen wir es.
// Windows (globale Installation): entfernt die PowerShell-Starter (.ps1) von Harnes. Sind PowerShell-
//        Skripte gesperrt (Windows-Standard), würde „harnes“ sonst dort scheitern; ohne .ps1 nimmt
//        PowerShell die .cmd-Starter, die immer laufen. Die Sperre selbst bleibt, wie sie ist.
const { chmodSync, existsSync, readdirSync, unlinkSync } = require('node:fs');
const { dirname, join } = require('node:path');

if (process.platform === 'darwin') {
  try {
    const pty = dirname(require.resolve('node-pty/package.json'));
    for (const dir of ['prebuilds', join('build', 'Release')]) {
      const base = join(pty, dir);
      if (!existsSync(base)) continue;
      const targets = dir === 'prebuilds' ? readdirSync(base).map((d) => join(base, d, 'spawn-helper')) : [join(base, 'spawn-helper')];
      for (const f of targets) if (existsSync(f)) chmodSync(f, 0o755);
    }
  } catch {
    /* node-pty nicht gefunden: nichts zu tun */
  }
}

if (process.platform === 'win32' && process.env.npm_config_global === 'true' && process.env.npm_config_prefix) {
  const prefix = process.env.npm_config_prefix;
  const names = ['harnes', 'harnes-browser', 'rh', 'remoteharnes', 'harnesremote'];
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
  // npm legt die Starter erst nach diesem Schritt an – deshalb kurz danach noch einmal nachsehen.
  // Eigener Arbeitsordner, damit der Paketordner nicht belegt bleibt (sonst EBUSY beim Deinstallieren).
  const { spawn } = require('node:child_process');
  const later = `setTimeout(() => { const fs = require('fs'), p = require('path'); for (const n of ${JSON.stringify(names)}) { try { fs.unlinkSync(p.join(${JSON.stringify(prefix)}, n + '.ps1')); } catch {} } }, 4000);`;
  spawn(process.execPath, ['-e', later], { cwd: prefix, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

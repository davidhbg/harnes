// Baut das Installationspaket: npm run paket
// Ergebnis im Ordner paket/: harnes-<version>.tgz und installieren.cmd (ein Befehl, alles drin).
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// 1. Begleiter fertig gebaut mitliefern (dann braucht der Zielrechner kein Rust)
const exe = join(root, 'begleiter', 'target', 'release', 'harnes-begleiter.exe');
const binDir = join(root, 'begleiter', 'bin');
if (existsSync(exe)) {
  mkdirSync(binDir, { recursive: true });
  copyFileSync(exe, join(binDir, 'harnes-begleiter.exe'));
  console.log('Begleiter eingepackt.');
} else console.log('Hinweis: Begleiter nicht gebaut (cargo build --release in begleiter/), Paket ohne Begleiter.');

// 2. TypeScript frisch bauen und packen (npm pack ruft „prepare“ auf); alte Dateien in dist/ fliegen raus
rmSync(join(root, 'dist'), { recursive: true, force: true });
const out = join(root, 'paket');
mkdirSync(out, { recursive: true });
run(`npm pack --pack-destination "${out}"`);
const tgz = `harnes-${version}.tgz`;
if (!existsSync(join(out, tgz))) throw new Error(`${tgz} fehlt`);
// gleicher Inhalt unter festem Namen: …/releases/latest/download/harnes.tgz holt immer die neueste Fassung
copyFileSync(join(out, tgz), join(out, 'harnes.tgz'));

// 3. Installationsbefehl neben das Paket legen
writeFileSync(
  join(out, 'installieren.cmd'),
  [
    '@echo off',
    'rem Harnes installieren: ein Befehl, danach in jedem Terminal "harnes"',
    'where node >nul 2>nul || (echo Node.js fehlt. Bitte zuerst von https://nodejs.org installieren. & exit /b 1)',
    `call npm install -g "%~dp0${tgz}" --no-audit --no-fund || exit /b 1`,
    'echo.',
    'echo Fertig. In einem neuen Terminal einfach "harnes" eingeben.',
    '',
  ].join('\r\n'),
);
console.log(`\nFertig: ${join(out, tgz)}\nInstallieren: npm install -g "${join(out, tgz)}"   (oder installieren.cmd doppelklicken)`);

#!/usr/bin/env node
/**
 * Startet den HarnesBrowser (Electron) in einem eigenen Fenster und kehrt sofort zurück.
 * Aufruf: harnes-browser [projektordner] [adresse]
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startBrowser(args: string[]): void {
  const require = createRequire(import.meta.url);
  let electron: string;
  try {
    electron = require('electron') as unknown as string;
  } catch {
    process.stderr.write('Electron fehlt. Im Ordner von Harnes „npm install“ ausführen.\n');
    process.exit(1);
  }
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'main.mjs');
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Projektordner für Harnes im Browser (sonst das zuletzt benutzte Projekt)
  const dir = args.find((a) => !a.startsWith('-') && !/^https?:\/\//.test(a));
  if (dir && existsSync(dir) && statSync(dir).isDirectory()) env.HARNES_PROJEKT = realpathSync.native(resolve(dir));
  const urls = args.filter((a) => /^https?:\/\//.test(a));
  const child = spawn(electron, [main, ...urls], { env, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  process.stdout.write('HarnesBrowser startet …\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync.native(process.argv[1])) startBrowser(process.argv.slice(2));

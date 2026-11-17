/**
 * Anderen Vault verbinden: Der Ordner wird der neue Vault-Ordner von Harnes (z. B. dein Obsidian-Vault).
 * Harnes legt darin je Projekt einen Unterordner an und überschreibt nichts, was schon da ist.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { updateConfig } from './config.js';

export function connectVaultRoot(input: string): string {
  const raw = input.trim().replace(/^["'„“]|["'“”]$/g, '');
  if (!raw) throw new Error('Welcher Ordner? Zum Beispiel: /vault C:\\Users\\du\\Obsidian\\Mein Vault');
  const dir = resolve(raw);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} ist eine Datei, kein Ordner.`);
  } else {
    // neuer Vault: Ordner anlegen, wenn es den Ordner darüber gibt
    if (!existsSync(dirname(dir))) throw new Error(`Den Ordner ${dirname(dir)} gibt es nicht.`);
    mkdirSync(dir);
  }
  updateConfig((c) => {
    c.vaultRoot = dir;
  });
  return dir;
}

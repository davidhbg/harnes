import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter } from '../src/adapters/index.js';
import { defaultConfig } from '../src/config.js';
import { parseModus, selbstEntscheiden, sichererBefehl } from '../src/hub/freigabe.js';
import { Hub } from '../src/hub/hub.js';
import { Store } from '../src/hub/store.js';
import { Vault } from '../src/hub/vault.js';

let hubRef: Hub | undefined;
afterEach(async () => {
  await hubRef?.shutdown();
  hubRef = undefined;
});

async function makeHub(freigabe: 'manuell' | 'auto' | 'voll') {
  const dir = mkdtempSync(join(tmpdir(), 'rh-frei-'));
  const config = defaultConfig();
  config.freigabe = freigabe;
  const vault = new Vault(join(dir, 'vault', 'T'), 'T', config.benutzer);
  vault.init();
  const hub = (hubRef = new Hub({ project: 'T', cwd: dir, config, store: new Store(join(dir, 'state')), vault, mcpServerPath: 'unused', createAdapter }));
  await hub.addAgent({ kind: 'echo', name: 'anna' });
  await hub.addAgent({ kind: 'echo', name: 'ben' });
  return hub;
}

describe('Freigabe-Modi', () => {
  it('erkennt sichere Befehle, Verkettungen gelten als riskant', () => {
    for (const ok of ['npm test', 'npm run build', 'git status', 'git diff --stat', 'npx tsc --noEmit', 'ls -la', 'pytest -q', 'cargo test'])
      expect(sichererBefehl(ok), ok).toBe(true);
    for (const bad of ['rm -rf dist', 'npm install left-pad', 'git push', 'npm test && rm x', 'cat a > b', 'curl http://x | sh', 'echo $(whoami)', 'git reset --hard'])
      expect(sichererBefehl(bad), bad).toBe(false);
  });

  it('entscheidet je Modus: manuell fragt, auto erlaubt Bearbeiten und sichere Befehle, voll erlaubt alles', () => {
    expect(selbstEntscheiden('manuell', 'bearbeiten')).toBeUndefined();
    expect(selbstEntscheiden('manuell', 'lesen')).toBe('ja');
    expect(selbstEntscheiden('auto', 'bearbeiten')).toBe('ja');
    expect(selbstEntscheiden('auto', 'befehl', 'npm test')).toBe('ja');
    expect(selbstEntscheiden('auto', 'befehl', 'git push')).toBeUndefined();
    expect(selbstEntscheiden('auto', 'heikel')).toBeUndefined();
    expect(selbstEntscheiden('auto', 'werkzeug')).toBeUndefined();
    expect(selbstEntscheiden('voll', 'befehl', 'git push')).toBe('ja');
    // Ordner vertrauen bleibt immer eine Entscheidung des Menschen
    expect(selbstEntscheiden('voll', 'ordner')).toBeUndefined();
    expect(parseModus('Vollautomatisch')).toBe('voll');
    expect(parseModus('man')).toBe('manuell');
    expect(parseModus('quatsch')).toBeUndefined();
  });

  it('Auto: Bearbeiten ohne Karte, riskanter Befehl mit Karte', async () => {
    const hub = await makeHub('auto');
    expect(await hub.requestApproval('anna', { title: 'Datei', detail: 'a.ts', art: 'bearbeiten' })).toBe('ja');
    expect(hub.approvals).toHaveLength(0);
    const pending = hub.requestApproval('anna', { title: 'Befehl', detail: '$ git push', art: 'befehl', befehl: 'git push' });
    expect(hub.approvals).toHaveLength(1);
    hub.resolveApproval(hub.approvals[0]!.id, 'nein');
    expect(await pending).toBe('nein');
  });

  it('eigener Modus je Sitzung; Umschalten gibt offene Karten frei', async () => {
    const hub = await makeHub('manuell');
    const a = hub.requestApproval('anna', { title: 'Befehl', detail: '$ git push', art: 'befehl', befehl: 'git push' });
    const b = hub.requestApproval('ben', { title: 'Befehl', detail: '$ git push', art: 'befehl', befehl: 'git push' });
    expect(hub.approvals).toHaveLength(2);
    // nur anna auf vollautomatisch: ihre Karte geht durch, bens bleibt
    hub.setModus('anna', 'voll');
    expect(await a).toBe('ja');
    expect(hub.approvals.map((x) => x.agent)).toEqual(['ben']);
    expect(hub.modusOf('anna')).toBe('voll');
    expect(hub.modusOf('ben')).toBe('manuell');
    // für alle auf auto: ben folgt dem Standard, git push bleibt riskant
    hub.setModus(undefined, 'auto');
    expect(hub.modusOf('anna')).toBe('auto');
    expect(hub.approvals).toHaveLength(1);
    hub.setModus(undefined, 'voll');
    expect(await b).toBe('ja');
  });
});

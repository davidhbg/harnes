#!/usr/bin/env node
/**
 * Hook-Brücke für Claude Code: reicht das Hook-Ereignis (JSON auf stdin) an die
 * RemoteHarnes-Zentrale weiter und gibt deren Antwort zurück.
 * Aufruf durch Claude Code: node hook.js <adresse-der-zentrale-mit-schlüssel-und-ereignis>
 * Ist die Zentrale nicht erreichbar, passiert einfach nichts – Claude Code läuft normal weiter.
 */
const url = process.argv[2] ?? '';
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => (data += chunk));
process.stdin.on('end', () => {
  if (!url) process.exit(0);
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: data.trim() || '{}' })
    .then(async (res) => {
      const text = await res.text();
      if (res.ok && text.trim()) process.stdout.write(text);
      process.exit(0);
    })
    .catch(() => process.exit(0));
});

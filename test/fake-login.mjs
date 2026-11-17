// Nachbau der Anmelde-Befehle von Claude Code und Codex für Tests.
// Rolle über FAKE_ROLLE (claude | codex), Zustand in FAKE_STATE (Ordner).
//   claude auth status --json · claude auth login · (sonst: Claude-Nachbau aus fake-claude.mjs)
//   codex login status · codex login · codex app-server (nur initialize + account/read)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const role = process.env.FAKE_ROLLE ?? 'claude';
const stateFile = join(process.env.FAKE_STATE ?? '.', `${role}-angemeldet`);
const loggedIn = () => existsSync(stateFile) && readFileSync(stateFile, 'utf8') === 'ja';

async function interactiveLogin(name) {
  process.stdout.write(`${name}: Browser öffnen … (Nachbau)\r\nCode eingeben und Enter drücken: `);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  let code = '';
  await new Promise((done) => {
    process.stdin.on('data', (b) => {
      for (const ch of b.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done();
        code += ch;
        process.stdout.write('*');
      }
    });
  });
  if (code === 'falsch') {
    process.stdout.write('\r\nAnmeldung fehlgeschlagen.\r\n');
    process.exit(1);
  }
  writeFileSync(stateFile, 'ja');
  process.stdout.write('\r\nLogin successful.\r\n');
  process.exit(0);
}

if (role === 'claude') {
  if (args[0] === 'auth' && args[1] === 'status') {
    process.stdout.write(JSON.stringify({ loggedIn: loggedIn(), authMethod: loggedIn() ? 'claude.ai' : 'none', subscriptionType: loggedIn() ? 'max' : undefined }));
    process.exit(loggedIn() ? 0 : 1);
  } else if (args[0] === 'auth' && args[1] === 'login') {
    await interactiveLogin('Claude');
  } else {
    await import('./fake-claude.mjs');
  }
} else {
  if (args[0] === 'login' && args[1] === 'status') {
    process.stdout.write(loggedIn() ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
    process.exit(loggedIn() ? 0 : 1);
  } else if (args[0] === 'login') {
    await interactiveLogin('Codex');
  } else if (args[0] === 'app-server') {
    createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: 'fake' } }) + '\n');
      if (m.method === 'account/read') {
        const account = loggedIn() ? { type: 'chatgpt', email: 'x@y', planType: 'plus' } : null;
        process.stdout.write(JSON.stringify({ id: m.id, result: { account, requiresOpenaiAuth: true } }) + '\n');
      }
    });
  }
}

// Nachbau von Claude Code für Tests: verhält sich an den Hooks wie das echte Programm,
// braucht aber kein Login und kostet nichts. Versteht in zugestellten Nachrichten:
//   bearbeite <pfad>   → fragt den PreToolUse-Hook (Datei-Reservierung)
//   erlaubnis          → fragt den PermissionRequest-Hook (Freigabe-Karte)
//   langsam            → arbeitet 4 Sekunden (zum Unterbrechen mit Esc)
//   fehlschlag         → Runde endet mit StopFailure (wie „Login expired“)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
// „claude auth status“ / „claude auth logout“ wie das echte Programm
if (argv[0] === 'auth') {
  if (argv[1] === 'logout') console.log('Successfully logged out from your Anthropic account.');
  else console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(0);
}
const settings = JSON.parse(readFileSync(opt('--settings'), 'utf8'));

function runHook(event, input, matcherValue) {
  const groups = settings.hooks?.[event] ?? [];
  const handlers = groups
    .filter((g) => !g.matcher || (matcherValue && new RegExp(`^(${g.matcher})$`).test(matcherValue)))
    .flatMap((g) => g.hooks);
  if (!handlers.length) return Promise.resolve(null);
  const h = handlers[0];
  return new Promise((resolve) => {
    const child = spawn(h.command, h.args ?? [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      try {
        resolve(out.trim() ? JSON.parse(out) : null);
      } catch {
        resolve(null);
      }
    });
    child.on('error', () => resolve(null));
    child.stdin.end(JSON.stringify({ session_id: 'fake-1', hook_event_name: event, cwd: process.cwd(), ...input }));
  });
}

const say = (s) => process.stdout.write(s + '\r\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;
let interrupted = false;

async function answer(context) {
  // letzte zugestellte Nachricht: "n) Kanal – Absender: Text"
  const lines = String(context ?? '').split('\n').filter((l) => /^\d+\) /.test(l));
  const last = lines[lines.length - 1] ?? '';
  const text = last.replace(/^\d+\) [^:]*: /, '');
  const lower = text.toLowerCase();
  if (!lines.length) return '[kein Beitrag]';
  if (lower.includes('fehlschlag')) return { failure: true };
  if (lower.includes('langsam')) {
    for (let i = 0; i < 40 && !interrupted; i++) await sleep(100);
    if (interrupted) return { interrupted: true };
  }
  const edit = /bearbeite\s+(\S+)/i.exec(text);
  if (edit) {
    const r = await runHook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: edit[1] } }, 'Edit');
    const d = r?.hookSpecificOutput;
    return d?.permissionDecision === 'deny' ? `Bearbeiten verweigert: ${d.permissionDecisionReason}` : `Datei ${edit[1]} bearbeitet.`;
  }
  if (lower.includes('erlaubnis')) {
    say('  (wartet auf Freigabe für Bash: npm test)');
    const r = await runHook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const b = r?.hookSpecificOutput?.decision?.behavior;
    return b === 'allow' ? 'Befehl ausgeführt: Tests grün.' : b === 'deny' ? 'Befehl wurde abgelehnt.' : 'Keine Entscheidung erhalten.';
  }
  return `Fake-Claude: verstanden – ${text.slice(0, 50)}`;
}

async function turn(prompt) {
  busy = true;
  interrupted = false;
  say(`> ${prompt}`);
  const ups = await runHook('UserPromptSubmit', { prompt });
  let context = ups?.hookSpecificOutput?.additionalContext;
  let active = false;
  for (;;) {
    const reply = await answer(context);
    if (reply?.interrupted) {
      say('  ⎿ Interrupted');
      break; // wie beim echten Claude Code: kein Stop-Hook nach Unterbrechung
    }
    if (reply?.failure) {
      say('● Login expired · Please run /login');
      await runHook('StopFailure', { error: 'authentication_failed', last_assistant_message: 'Login expired · Please run /login' });
      break;
    }
    say(`● ${reply}`);
    const stop = await runHook('Stop', { stop_hook_active: active, last_assistant_message: reply });
    if (stop?.decision === 'block' && stop.reason) {
      context = stop.reason;
      active = true;
      continue;
    }
    break;
  }
  busy = false;
  say('❯ ');
}

say('FAKE CLAUDE CODE v0 (Test)');
const startOut = await runHook('SessionStart', { source: 'startup' });
say(`Teamregeln erhalten: ${startOut?.hookSpecificOutput?.additionalContext ? 'ja' : 'nein'}`);
say('❯ ');

let line = '';
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (buf) => {
  for (const ch of buf.toString('utf8')) {
    if (ch === '\u0003') process.exit(0);
    if (ch === '\u001b') {
      if (busy) interrupted = true;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const prompt = line.trim();
      line = '';
      if (prompt === '/exit') process.exit(0);
      if (prompt && !busy) void turn(prompt);
      continue;
    }
    line += ch;
    process.stdout.write(ch);
  }
});

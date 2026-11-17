# Harnes – Hinweise für KI-Sitzungen, die an diesem Code arbeiten

Bedienung und Überblick: `README.md`.

## Befehle
- `remoteharnes` bzw. `remoteharnes --fenster` – starten (im aktuellen Terminal bzw. in einem eigenen Terminal-Fenster)
- **wt.exe** ist eine App-Verknüpfung: `existsSync` meldet sie als nicht vorhanden, also direkt starten und bei Fehler ausweichen
- `npm run build` – TypeScript nach `dist/` (die Tests der Oberfläche brauchen den Build)
- `npm test` – alle Tests (ohne KI, ohne Tokens)
- `npx tsx scripts/probe.mts <art> <name> <modell|-> <sekunden> "<nachricht>"` – echte Anbindung prüfen

## Feste Regeln
- **Claude im Abo:** RemoteHarnes startet nur das echte `claude`-Programm. Anmeldedaten von Claude
  werden nie gelesen, kopiert oder weitergereicht. Das Agent SDK läuft nur mit API-Schlüssel.
- Schlüssel nie in den Vault, ins Repository oder in Protokolle schreiben.
- Der lokale Server lauscht nur auf `127.0.0.1`; jede Sitzung hat einen eigenen Zugangsschlüssel.
- Oberflächentexte, Kommentare und Commit-Nachrichten sind deutsch.

## Stolperfallen (alle schon einmal aufgetreten)
- **Hooks von Claude Code:** `SessionStart` wird als HTTP-Hook nicht ausgelöst, deshalb laufen alle
  Hooks als Befehls-Hook über `dist/hook.js` (ohne Shell, mit `args`).
- **Durchschalten (F12):** Beim Zurückgeben der Tastatur `stdin` nur pausieren. `setRawMode(false)`
  an dieser Stelle führt unter Windows zu `write EPIPE` beim nächsten Start der Oberfläche.
- **node-pty unter Windows:** `kill()` auf einen schon beendeten Prozess schreibt „AttachConsole failed“.
  Vorher prüfen, ob der Prozess noch läuft.
- **Verschachtelter Start:** Läuft RemoteHarnes innerhalb einer Claude-Code-Sitzung, entfernt
  `cleanEnv()` deren Umgebungsvariablen, damit gestartete Sitzungen ihr eigenes Login benutzen.
- **Zeichenbreite:** Symbole wie ☰ sind zwei Zellen breit und verschieben den Rahmen. Nur Zeichen
  verwenden, die `string-width` als 1 meldet.
- **Kleine Modelle** ahmen das Zustell-Format nach; `cleanFinal()` in `hub/prompts.ts` räumt das auf.
- **Kurznamen unter Windows** (`C:\Users\NAME~1\…`): Claude Code erkennt einen vertrauten Ordner
  daran nicht wieder und fragt erneut. Projektpfade deshalb mit `realpathSync.native()` ausschreiben.
- **Ordner vertrauen:** Claude Code fragt beim ersten Start in einem Ordner (im Benutzerordner bei *jedem* Start),
  vorausgewählt ist „No, exit“ – ein Enter beendet die Sitzung sofort. `checkTrust()` in `adapters/claude-abo.ts`
  erkennt die Frage auf dem Bildschirm und zeigt eine Freigabe-Karte.
- **Adressen öffnen unter Windows** nie über `cmd /c start` (schneidet bei `&` ab), sondern `openInBrowser()`.
- **`fetch` ignoriert eine eigene `host`-Kopfzeile**; für Tests der Host-Prüfung `node:http` nehmen.
- **Anmelden (claude auth login, codex login)** läuft per `spawn` mit `stdio: 'inherit'` im selben Terminal,
  NICHT über node-pty: Endet ein Pseudo-Terminal-Kindprozess, bekommt RemoteHarnes unter Windows keine Tasten mehr.
- **Zeichen-Kunst:** Galaxie und Sternbild Pegasus werden in `src/ui/art.ts` berechnet (Braille-Punkte), nicht abgetippt.
- **Aufbau der Teamansicht (nach Kiro):** Kopfzeile, links Seitenleiste mit Rahmen (Team, Aufgaben, Sitzungen, + Neue Sitzung),
  rechts Titel, Unterzeile, Chat, Eingabefeld mit Rahmen; unten Tasten und Verbrauch (kein Verbrauchs-Reiter mehr).
  Esc öffnet das Menü (`ui.menu`), `/` zeigt Befehlsvorschläge (`COMMANDS` in `ui/commands.ts`). Die Tests prüfen Texte, nicht Positionen.
- **Ablauf beim Start:** Ladebildschirm und Startseite (`ui/Home.tsx`: Team-Chat, Aufgaben, neue Sitzung,
  Einstellungen, MCP-Server, Vault, Verbrauch); beim ersten Start liegt die Einrichtung (`ui/Setup.tsx`, setzt
  `eingerichtet`) dazwischen. Wieder geöffnet werden genau die Sitzungen aus `roster.json` (beim Beenden offen),
  nicht die alte Auswahl aus `start.json` – sonst kommen geschlossene Sitzungen zurück. `--konten` zeigt die alte Übersicht.
- **MCP-Server** aus `config.mcp` bekommen alle neuen Sitzungen (Claude Abo über `--mcp-config`, Claude API über
  `mcpServers`, Codex über `-c mcp_servers.<name>…`, lokale Modelle über `adapters/mcp-client.ts`: RemoteHarnes startet
  die Server selbst und gibt die Werkzeuge als Funktionen `mcp__<server>__<werkzeug>` weiter, mit Freigabe je Server).
- **Maus unter Windows:** Node liest Konsolen-Mausereignisse nicht (libuv wirft MOUSE_EVENT weg). Deshalb liest
  `ui/wininput.ts` die Konsole mit einem kleinen C#-Hilfsprogramm (einmal mit `csc.exe` aus .NET Framework nach
  `%LOCALAPPDATA%RemoteHarnes` übersetzt) und speist einen eigenen Eingabestrom für Ink. Stolperfallen: kein
  `windowsHide` beim Start (sonst eigene unsichtbare Konsole), Fenstergröße meldet das Hilfsprogramm mit
  (`_refreshSize`), F12 liest aus demselben Strom, Anmeldung hält es an (`pauseInput`). Ink verschluckt
  SGR-Mausmeldungen, deshalb nimmt `feedMouse` sie vorher heraus. `Add-Type -OutputType ConsoleApplication`
  erzeugt in PowerShell 5.1 eine DLL – nicht verwenden. Fehlersuche: `RH_MAUS_LOG=<datei>`; `RH_NO_MOUSE=1` schaltet alles ab.
- **Design:** Farben, Verläufe, Logo und Spinner liegen in `src/ui/theme.ts`. Animationen laufen über `useAnimation`
  und nur, solange sich etwas tut (`isActive`), sonst schreibt das Terminal ununterbrochen.
- **Verbrauch von Claude (Abo):** Das Gesprächsprotokoll enthält die letzte Antwort beim Stop-Hook manchmal noch nicht,
  deshalb wird 1,5 s später noch einmal gelesen. `--strict-mcp-config` spart praktisch nichts (gemessen).
- Eine neue Art von Sitzung braucht: Adapter in `src/adapters/`, Eintrag in `adapters/index.ts`,
  Art in `ui/commands.ts` (`resolveKind`) und einen Test mit Nachbau.

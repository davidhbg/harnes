/**
 * Freigabe-Modus: wie viel eine Sitzung ohne Nachfrage darf.
 *   manuell – fragt bei jeder Aktion (nur Lesen geht ohne Frage)
 *   auto    – Dateien bearbeiten und sichere Befehle (Tests, Build, git status …) ohne Frage, Riskantes fragt
 *   voll    – fragt nie (nur „Ordner vertrauen“ bleibt eine Entscheidung des Menschen)
 * Die Entscheidung fällt zentral im Hub, bevor eine Freigabe-Karte entsteht.
 */
export type FreigabeModus = 'manuell' | 'auto' | 'voll';

export const MODI: { id: FreigabeModus; label: string; about: string }[] = [
  { id: 'manuell', label: 'Manuell', about: 'fragt bei jeder Aktion' },
  { id: 'auto', label: 'Auto', about: 'bearbeitet und testet selbst, fragt nur bei Riskantem' },
  { id: 'voll', label: 'Vollautomatisch', about: 'fragt nie' },
];

export function modusLabel(m: FreigabeModus): string {
  return MODI.find((x) => x.id === m)?.label ?? m;
}

/** Eingabe wie „auto“, „Manuell“, „voll“, „vollautomatisch“ verstehen */
export function parseModus(s: string): FreigabeModus | undefined {
  const t = s.trim().toLowerCase();
  if (!t) return undefined;
  if ('manuell'.startsWith(t) || t === 'manual') return 'manuell';
  if (t === 'auto' || t === 'automatisch') return 'auto';
  if (t.startsWith('voll') || t === 'full' || t === 'yolo') return 'voll';
  return undefined;
}

/** Art der Aktion, nach der die Sitzung fragt */
export type AktionsArt = 'lesen' | 'bearbeiten' | 'heikel' | 'befehl' | 'werkzeug' | 'ordner';

/** Werkzeugnamen von Claude Code / Agent SDK einer Art zuordnen */
export function artVonWerkzeug(tool: string): AktionsArt {
  if (/^(Read|Glob|Grep|LS|NotebookRead|TodoWrite|TodoRead)$/.test(tool)) return 'lesen';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return 'bearbeiten';
  if (/^(Bash|PowerShell|BashOutput|KillShell)$/.test(tool)) return 'befehl';
  return 'werkzeug';
}

/**
 * Befehle, die nur lesen, prüfen oder bauen. Alles mit Verkettung, Umleitung oder
 * Ersetzung (; && || | > ` $( ) gilt als riskant und fragt nach.
 */
export function sichererBefehl(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || /[;&|><`]|\$\(/.test(c)) return false;
  const safe = [
    /^(ls|dir|pwd|cat|type|head|tail|wc|echo|tree|which|where|whoami|date)(\s|$)/i,
    /^(rg|grep|findstr|find)\s/i,
    /^git\s+(status|diff|log|show|branch|remote -v|rev-parse|ls-files|blame)(\s|$)/i,
    /^(npm|pnpm|yarn|bun)\s+(test|t|run\s+(test|build|lint|typecheck|check)|ls|outdated|-v|--version)(\s|$)/i,
    /^npx\s+(tsc|vitest|jest|eslint|prettier\s+--check|playwright\s+test)(\s|$)/i,
    /^(tsc|vitest|jest|eslint|pytest|ruff|mypy)(\s|$)/i,
    /^(node|python|python3|py|cargo|go|dotnet|java|rustc)\s+(--version|-v|-V|version)$/i,
    /^cargo\s+(test|build|check|clippy|fmt\s+--check)(\s|$)/i,
    /^go\s+(test|build|vet)(\s|$)/i,
    /^dotnet\s+(build|test)(\s|$)/i,
    /^python3?\s+-m\s+(pytest|unittest|mypy|ruff)(\s|$)/i,
  ];
  return safe.some((r) => r.test(c));
}

/**
 * Entscheidung ohne Menschen: 'ja', wenn der Modus diese Aktion erlaubt, sonst undefined
 * (dann kommt eine Freigabe-Karte). Ohne Angabe der Art wird wie bei einem Befehl entschieden.
 */
export function selbstEntscheiden(modus: FreigabeModus, art: AktionsArt | undefined, befehl?: string): 'ja' | undefined {
  if (art === 'ordner') return undefined;
  if (art === 'lesen') return 'ja';
  if (modus === 'voll') return 'ja';
  if (modus === 'manuell') return undefined;
  // auto
  if (art === 'bearbeiten') return 'ja';
  if (art === 'befehl' && befehl && sichererBefehl(befehl)) return 'ja';
  return undefined;
}

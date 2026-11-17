/** Farben und Animations-Bausteine: Schwarz mit gedecktem Violett, Altrosa und einem warmen Pfirsich-Akzent. */

export const T = {
  violet: '#A99BDC',
  purple: '#8676C4',
  deep: '#5B4E96',
  night: '#2A2347',
  /** warmer Akzent (Pfirsich, wie der Kern einer Galaxie) */
  pink: '#E3B48F',
  magenta: '#C59BC0',
  cyan: '#8FB4D8',
  text: '#E4DFF0',
  muted: '#938BAD',
  faint: '#625B80',
  line: '#3D3562',
  ok: '#9CC7A4',
  warn: '#DDBF84',
  bad: '#D58C96',
} as const;

/** Farben für die Sitzungen (der Mensch hat immer den warmen Akzent). */
export const AGENT_COLORS = ['#A99BDC', '#8FB4D8', '#C59BC0', '#DDBF84', '#9CC7A4', '#8DA0D6', '#D9A0A0', '#B7ACDF'];

/** Verlauf des Logos und der Balken: Indigo über Violett und Altrosa nach Pfirsich */
export const GLOW = ['#5B4E96', '#8676C4', '#C59BC0', '#E3B48F'];

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Span {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}
export type Line = Span[];

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return hex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** Farbe an Position t (0..1) eines Verlaufs; t läuft zyklisch. */
export function gradient(stops: readonly string[], t: number): string {
  const x = ((t % 1) + 1) % 1;
  const scaled = x * stops.length;
  const i = Math.floor(scaled);
  return mix(stops[i % stops.length]!, stops[(i + 1) % stops.length]!, scaled - i);
}

/**
 * Text mit Farbverlauf. `phase` verschiebt den Verlauf (für wandernden Schimmer),
 * `spread` bestimmt, über wie viele Zeichen sich der Verlauf einmal wiederholt.
 */
export function gradientSpans(text: string, phase = 0, opts: { stops?: readonly string[]; spread?: number; bold?: boolean; offset?: number } = {}): Span[] {
  const stops = opts.stops ?? GLOW;
  const spread = opts.spread ?? Math.max(12, text.length);
  const out: Span[] = [];
  const chars = [...text];
  let run = '';
  let runColor = '';
  chars.forEach((ch, i) => {
    // in 2er-Schritten färben: halb so viele Farbwechsel, sieht gleich aus
    const color = ch === ' ' ? runColor || stops[0]! : gradient(stops, (Math.floor((i + (opts.offset ?? 0)) / 2) * 2) / spread - phase);
    if (color !== runColor && run) {
      out.push({ text: run, color: runColor, bold: opts.bold });
      run = '';
    }
    runColor = color;
    run += ch;
  });
  if (run) out.push({ text: run, color: runColor, bold: opts.bold });
  return out;
}

/** Fortschrittsbalken als zwei Spans (gefüllt mit Verlauf, Rest blass). */
export function barSpans(fraction: number, width: number, phase = 0, color?: string): Span[] {
  const f = Math.max(0, Math.min(1, fraction));
  const full = Math.round(f * width);
  const filled = color ? [{ text: '━'.repeat(full), color }] : gradientSpans('━'.repeat(full), phase, { spread: Math.max(8, width) });
  return [...(full ? filled : []), { text: '━'.repeat(width - full), color: T.night }];
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

// ---------- Schriftzug ----------

/** Große Blockschrift (6 Zeilen) für die Buchstaben, die wir brauchen. */
const BIG: Record<string, string[]> = {
  H: ['██╗  ██╗', '██║  ██║', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
};

/** Kleine Schrift (3 Zeilen) für schmale oder niedrige Fenster. */
const SMALL: Record<string, [string, string, string]> = {
  R: ['█▀█', '█▀▄', '▀ ▀'],
  E: ['█▀▀', '█▀▀', '▀▀▀'],
  M: ['█▀▄▀█', '█ ▀ █', '▀   ▀'],
  O: ['█▀█', '█ █', '▀▀▀'],
  T: ['▀█▀', ' █ ', ' ▀ '],
  H: ['█ █', '█▀█', '▀ ▀'],
  A: ['▄▀█', '█▀█', '▀ ▀'],
  N: ['█▄ █', '█ ▀█', '▀  ▀'],
  S: ['█▀▀', '▀▀█', '▀▀▀'],
  ' ': ['  ', '  ', '  '],
};

export function bigLogo(word = 'HARNES'): string[] {
  const out = ['', '', '', '', '', ''];
  for (const ch of word) {
    const g = BIG[ch];
    if (!g) continue;
    for (let i = 0; i < 6; i++) out[i] += g[i];
  }
  return out;
}

export function smallLogo(word = 'HARNES'): string[] {
  const out = ['', '', ''];
  for (const ch of word.toUpperCase()) {
    const g = SMALL[ch] ?? SMALL[' ']!;
    for (let i = 0; i < 3; i++) out[i] += g[i] + ' ';
  }
  return out.map((l) => l.trimEnd());
}

const NOISE = '░▒▓█▚▞';

/**
 * Logo-Zeile mit Verlauf. `reveal` (0..1) deckt von links nach rechts auf; davor rauscht es.
 * `shine` ist die Position (in Spalten) eines hellen Lichtstreifens, der darüber wandert.
 */
export function logoLine(line: string, row: number, opts: { reveal?: number; phase?: number; shine?: number; seed?: number }): Span[] {
  const chars = [...line];
  const reveal = opts.reveal ?? 1;
  const edge = reveal * (chars.length + 16);
  const out: Span[] = [];
  let run = '';
  let runColor = '';
  const push = () => {
    if (run) out.push({ text: run, color: runColor, bold: true });
    run = '';
  };
  chars.forEach((ch, i) => {
    let c = ch;
    let color: string;
    const pos = i + row * 1.5; // leichte Schräge
    if (reveal < 1 && pos > edge) {
      c = ' ';
      color = T.night;
    } else if (reveal < 1 && pos > edge - 6 && ch !== ' ') {
      // Kante: Rauschen
      c = NOISE[(i * 7 + row * 13 + (opts.seed ?? 0)) % NOISE.length]!;
      color = T.cyan;
    } else {
      color = gradient(GLOW, (Math.floor(i / 2) * 2) / chars.length * 0.75 + row * 0.03 - (opts.phase ?? 0));
      if (opts.shine !== undefined) {
        const d = Math.abs(pos - opts.shine);
        if (d < 4) color = mix(color, '#FFF4E0', 0.5 * (1 - d / 4));
      }
    }
    if (color !== runColor) push();
    runColor = color;
    run += c;
  });
  push();
  return out;
}

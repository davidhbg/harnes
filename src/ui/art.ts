import { width as textWidth } from '../util.js';
import { T, mix, type Line, type Span } from './theme.js';

/**
 * Zeichen-Kunst für die Oberfläche: Galaxie, Sternbilder, Planeten, Nebel, schwarzes Loch,
 * Komet, Rakete, Gebirge. Alles wird berechnet (nicht abgetippt) und aus Braille-Punkten
 * gesetzt, so entstehen je Zeichen 2×4 Bildpunkte. `time` in Millisekunden lässt die Bilder
 * langsam leben: Sterne funkeln, die Galaxie dreht sich, Planeten ziehen ihre Bahn.
 */

/** Stabiler Zufallswert 0..1 aus Koordinaten (damit nichts flackert, was nicht soll). */
function hash(x: number, y: number, s = 0): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Weiches Rauschen (zwischen Gitterpunkten geglättet) */
function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Wolkiges Rauschen aus drei Größen übereinander */
function fbm(x: number, y: number, s: number): number {
  return vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 1) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 2) * 0.15;
}

// Braille: Bit je Bildpunkt (Spalte dx 0..1, Zeile dy 0..3)
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

// Gleichmäßiges Raster für glatte Flächen (Planeten, Mond)
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const bayer = (px: number, py: number): number => (BAYER[py & 3]![px & 3]! + 0.5) / 16;

/** Farben der Galaxie von innen nach außen: Creme, Pfirsich, Altrosa, Violett, Nachtblau */
const GALAXY = ['#F4E6C8', '#EBC79E', '#D9A58F', '#B48FB0', '#8676C4', '#5C62A6', '#3B3F78'];
const HOT = ['#FFF4DC', '#F4E6C8', '#EBC79E', '#D9A58F', '#B48FB0', '#8676C4', '#5C62A6', '#3B3F78'];
const NEBULA = ['#EBC79E', '#D9A58F', '#C59BC0', '#A99BDC', '#8676C4', '#5C62A6', '#4A5A9A'];
const RING = ['#D9CFF0', '#B7ACDF', '#A99BDC', '#8676C4', '#6E64B0', '#5B4E96'];
const SATURN = ['#F4E6C8', '#EBC79E', '#E3B48F', '#D9A58F'];
const JUPITER = ['#EBC79E', '#D9A58F', '#C59BC0', '#B48FB0'];
const ICE = ['#D9E6F4', '#B7CBE6', '#8FB4D8', '#7C8FCB'];
const SHADOW = '#3B3F78';
const STAR_CHARS = ['·', '∙', '+', '✦', '·', '˙'];

function shade(stops: string[], t: number): string {
  const x = Math.max(0, Math.min(0.9999, t)) * (stops.length - 1);
  const i = Math.floor(x);
  // in vier Stufen je Abschnitt runden: weniger Farbwechsel, gleiche Wirkung
  return mix(stops[i]!, stops[i + 1]!, Math.round((x - i) * 4) / 4);
}

function pushRun(out: Span[], text: string, color: string | undefined): void {
  const last = out[out.length - 1];
  if (last && last.color === color) last.text += text;
  else out.push({ text, color });
}

/** Sternenhimmel-Zeichen für eine leere Zelle (oder Leerzeichen). */
function star(x: number, y: number, time: number, density: number): { ch: string; color?: string } {
  const h = hash(x, y, 7);
  if (h >= density) return { ch: ' ' };
  const kind = Math.floor(hash(x, y, 11) * STAR_CHARS.length);
  // jeder Stern funkelt in seinem eigenen Takt
  const beat = Math.floor(time / (500 + hash(x, y, 13) * 1400) + hash(x, y, 17) * 10);
  const glow = hash(x, y, beat);
  const color = glow > 0.8 ? '#F4E6C8' : glow > 0.45 ? '#B7ACDF' : T.faint;
  return { ch: STAR_CHARS[kind]!, color };
}

/** Zeichenfläche aus Braille-Punkten; jede Zelle hat eine Farbe. */
class Canvas {
  readonly W: number;
  readonly H: number;
  private bits: Uint8Array;
  private rank: Uint8Array;
  private tint: (string | undefined)[];
  private blocked: Uint8Array;
  private glyphs = new Map<number, { ch: string; color: string }>();

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.W = cols * 2;
    this.H = rows * 4;
    this.bits = new Uint8Array(cols * rows);
    this.rank = new Uint8Array(cols * rows);
    this.blocked = new Uint8Array(cols * rows);
    this.tint = new Array<string | undefined>(cols * rows);
  }

  private cell(px: number, py: number): number {
    if (px < 0 || py < 0 || px >= this.W || py >= this.H) return -1;
    return (py >> 2) * this.cols + (px >> 1);
  }

  /** Bildpunkt setzen. Höherer Rang bestimmt die Farbe der Zelle. */
  dot(x: number, y: number, color: string, rank = 1): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    const k = this.cell(px, py);
    if (k < 0) return;
    this.bits[k] = this.bits[k]! | DOT[px & 1]![py & 3]!;
    if (rank >= this.rank[k]!) {
      this.rank[k] = rank;
      this.tint[k] = color;
    }
  }

  /** Bildpunkt löschen und die Zelle für Hintergrundsterne sperren (Körper verdeckt, was dahinter liegt). */
  erase(x: number, y: number): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    const k = this.cell(px, py);
    if (k < 0) return;
    this.bits[k] = this.bits[k]! & ~DOT[px & 1]![py & 3]!;
    this.blocked[k] = 1;
    this.glyphs.delete(k);
  }

  /** Ein einzelnes Zeichen in eine Zelle setzen (Sterne der Sternbilder). */
  glyph(x: number, y: number, ch: string, color: string): void {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(x / 2)));
    const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(y / 4)));
    this.glyphs.set(cy * this.cols + cx, { ch, color });
  }

  /** Durchgezogene oder gepunktete Linie */
  line(x1: number, y1: number, x2: number, y2: number, color: string, dotted = false, rank = 0): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))));
    for (let i = 0; i <= steps; i++) {
      if (dotted && i % 2) continue;
      this.dot(Math.round(x1 + ((x2 - x1) * i) / steps), Math.round(y1 + ((y2 - y1) * i) / steps), color, rank);
    }
  }

  lines(time: number, density = 0.04, seed = 0, plainStars = false): Line[] {
    const out: Line[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line: Span[] = [];
      for (let x = 0; x < this.cols; x++) {
        const k = y * this.cols + x;
        const g = this.glyphs.get(k);
        if (g) pushRun(line, g.ch, g.color);
        else if (this.bits[k]) pushRun(line, String.fromCharCode(0x2800 + this.bits[k]!), this.tint[k]);
        else if (this.blocked[k]) pushRun(line, ' ', undefined);
        else {
          const s = star(x + seed * 131, y + seed * 17, time, density);
          if (plainStars) pushRun(line, s.ch === ' ' ? ' ' : '·', s.color ? T.faint : undefined);
          else pushRun(line, s.ch, s.color);
        }
      }
      out.push(line);
    }
    return out;
  }
}

/** Läuft über alle Bildpunkte im Umkreis r um (cx, cy), soweit sie auf der Fläche liegen. */
function around(c: Canvas, cx: number, cy: number, r: number, fn: (px: number, py: number, u: number, v: number) => void): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(c.W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(c.H - 1, Math.ceil(cy + r));
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) fn(px, py, px + 0.5 - cx, py + 0.5 - cy);
}

// ------------------------------------------------------------ Bausteine

/** Spiralgalaxie mit hellem Kern und zwei Armen, schräg im Bild. */
function drawGalaxy(c: Canvas, cx: number, cy: number, radius: number, time: number, angle = -0.42, tilt = 0.4): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rot = time / 14000;
  const flicker = Math.floor(time / 450);
  around(c, cx, cy, radius * 1.1, (px, py, u, v) => {
    const x = (u * cos + v * sin) / radius;
    const y = (-u * sin + v * cos) / (radius * tilt);
    const r = Math.hypot(x, y);
    if (r > 1.08) return;
    const th = Math.atan2(y, x);
    const core = Math.exp(-(r * r) / 0.022);
    const bulge = Math.exp(-(r * r) / 0.16) * 0.42;
    const arm = Math.pow(0.5 + 0.5 * Math.cos(2 * (th + 3.1 * Math.log(r + 0.06) - rot)), 3) * Math.exp(-(r * r) / 0.6) * 0.9;
    const edge = r > 0.92 ? (1.08 - r) / 0.16 : 1;
    const density = Math.min(1, core + bulge + arm) * edge;
    const noise = hash(px, py, 3) * 0.86 + hash(px, py, flicker) * 0.14;
    if (noise < density) c.dot(px, py, shade(GALAXY, r * 0.95));
  });
}

interface Constellation {
  /** Position 0..1 und Helligkeit 1 (hell) bis 3 */
  stars: Record<string, [number, number, number]>;
  lines: [string, string][];
}

/** Kurzschreibweise: Linien als Ketten von Sternnamen */
const chain = (...names: string[]): [string, string][] => names.slice(1).map((n, i) => [names[i]!, n]);

const PEGASUS: Constellation = {
  stars: {
    alpheratz: [0.86, 0.3, 1],
    scheat: [0.6, 0.18, 1],
    markab: [0.58, 0.66, 1],
    algenib: [0.88, 0.76, 1],
    homam: [0.42, 0.74, 2],
    biham: [0.27, 0.86, 3],
    enif: [0.06, 0.66, 1],
    matar: [0.44, 0.1, 2],
    pi: [0.26, 0.02, 3],
    mu: [0.5, 0.34, 3],
    lambda: [0.4, 0.38, 3],
    iota: [0.24, 0.36, 2],
    kappa: [0.1, 0.3, 3],
  },
  lines: [
    ...chain('alpheratz', 'scheat', 'markab', 'algenib', 'alpheratz'),
    ...chain('markab', 'homam', 'biham', 'enif'),
    ...chain('scheat', 'matar', 'pi'),
    ...chain('scheat', 'mu', 'lambda', 'iota', 'kappa'),
  ],
};

const ORION: Constellation = {
  stars: {
    meissa: [0.5, 0.06, 3],
    beteigeuze: [0.28, 0.2, 1],
    bellatrix: [0.68, 0.22, 1],
    mintaka: [0.57, 0.47, 2],
    alnilam: [0.5, 0.5, 1],
    alnitak: [0.43, 0.53, 2],
    saiph: [0.34, 0.88, 1],
    rigel: [0.74, 0.84, 1],
    keule1: [0.16, 0.08, 3],
    keule2: [0.08, 0.0, 3],
    schild1: [0.9, 0.12, 3],
    schild2: [0.96, 0.26, 3],
    schild3: [0.92, 0.4, 3],
  },
  lines: [
    ...chain('beteigeuze', 'meissa', 'bellatrix', 'beteigeuze', 'alnitak', 'saiph', 'rigel', 'mintaka', 'bellatrix', 'schild2'),
    ...chain('mintaka', 'alnilam', 'alnitak'),
    ...chain('beteigeuze', 'keule1', 'keule2'),
    ...chain('schild1', 'schild2', 'schild3'),
  ],
};

const WAGEN: Constellation = {
  stars: {
    dubhe: [0.92, 0.2, 1],
    merak: [0.9, 0.6, 1],
    phecda: [0.62, 0.74, 1],
    megrez: [0.58, 0.38, 2],
    alioth: [0.4, 0.3, 1],
    mizar: [0.22, 0.2, 1],
    alkaid: [0.03, 0.38, 1],
  },
  lines: chain('megrez', 'dubhe', 'merak', 'phecda', 'megrez', 'alioth', 'mizar', 'alkaid'),
};

const KASSIOPEIA: Constellation = {
  stars: {
    caph: [0.04, 0.3, 1],
    schedar: [0.27, 0.74, 1],
    navi: [0.5, 0.42, 1],
    ruchbah: [0.73, 0.8, 2],
    segin: [0.96, 0.2, 2],
  },
  lines: chain('caph', 'schedar', 'navi', 'ruchbah', 'segin'),
};

const SCHWAN: Constellation = {
  stars: {
    deneb: [0.5, 0.05, 1],
    sadr: [0.5, 0.34, 1],
    eta: [0.5, 0.66, 3],
    albireo: [0.5, 0.96, 1],
    gienah: [0.2, 0.48, 2],
    spitze1: [0.02, 0.62, 3],
    delta: [0.8, 0.24, 2],
    spitze2: [0.98, 0.12, 3],
  },
  lines: [...chain('deneb', 'sadr', 'eta', 'albireo'), ...chain('sadr', 'gienah', 'spitze1'), ...chain('sadr', 'delta', 'spitze2')],
};

const LOEWE: Constellation = {
  stars: {
    regulus: [0.22, 0.82, 1],
    eta: [0.24, 0.58, 3],
    algieba: [0.33, 0.42, 1],
    zeta: [0.26, 0.24, 3],
    rasalas: [0.14, 0.1, 3],
    epsilon: [0.04, 0.22, 3],
    zosma: [0.76, 0.4, 2],
    chertan: [0.76, 0.66, 2],
    denebola: [0.97, 0.68, 1],
  },
  lines: [...chain('regulus', 'eta', 'algieba', 'zeta', 'rasalas', 'epsilon'), ...chain('algieba', 'zosma', 'denebola', 'chertan', 'regulus'), ...chain('zosma', 'chertan')],
};

/** Sternbild als Sternkarte: Linien aus feinen Punkten, Sterne funkeln. */
function drawConstellation(c: Canvas, def: Constellation, x0: number, y0: number, w: number, h: number, time: number): void {
  const at = (name: string): [number, number] => {
    const [x, y] = def.stars[name]!;
    return [x0 + x * w, y0 + y * h];
  };
  for (const [a, b] of def.lines) {
    const [x1, y1] = at(a);
    const [x2, y2] = at(b);
    c.line(x1, y1, x2, y2, T.deep, true, 0);
  }
  Object.entries(def.stars).forEach(([name, s], i) => {
    const [px, py] = at(name);
    const glow = hash(i, 5, Math.floor(time / (600 + i * 90)));
    const bright = s[2] === 1;
    const color = bright ? (glow > 0.5 ? '#FFF4DC' : '#EBC79E') : glow > 0.6 ? '#D9CFF0' : '#A99BDC';
    c.glyph(px, py, bright ? '✦' : s[2] === 2 ? '+' : '∙', color);
  });
}

/** Kugel mit Licht von links oben und Wolkenbändern; verdeckt, was dahinter liegt. */
function drawSphere(c: Canvas, cx: number, cy: number, r: number, colors: string[], opts: { bands?: number; tilt?: number; time?: number; spin?: number } = {}): void {
  const cos = Math.cos(opts.tilt ?? 0);
  const sin = Math.sin(opts.tilt ?? 0);
  const bands = opts.bands ?? 0;
  const drift = (opts.time ?? 0) / (opts.spin ?? 9000);
  around(c, cx, cy, r, (px, py, du, dv) => {
    const u = du / r;
    const v = dv / r;
    const d2 = u * u + v * v;
    if (d2 > 1) return;
    c.erase(px, py);
    // Licht von links oben vorn
    const lum = Math.max(0, u * -0.55 + v * -0.5 + Math.sqrt(1 - d2) * 0.67);
    const lat = -u * sin + v * cos;
    const lon = u * cos + v * sin;
    // Bänder: leicht gewellt, wandern langsam (der Planet dreht sich)
    const wave = bands ? Math.sin(lat * bands + 0.5 * Math.sin(lon * 3 + drift) + 0.8) : 0;
    const density = Math.min(1, (0.1 + 0.95 * lum) * (bands ? 0.84 + 0.16 * wave : 1));
    if (bayer(px, py) < density) {
      const base = shade(colors, bands ? 0.5 + 0.5 * wave : 1 - lum);
      c.dot(px, py, mix(base, SHADOW, Math.min(0.8, (1 - lum) * 0.75)), 3);
    }
  });
}

/** Saturn: Kugel mit zwei Ringen (hinten verdeckt, vorn über dem Planeten). */
function drawSaturn(c: Canvas, cx: number, cy: number, r: number, time: number): void {
  const tilt = -0.3;
  const flat = 0.3;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const beat = Math.floor(time / 800);
  const ring = (front: boolean) =>
    around(c, cx, cy, r * 2.4, (px, py, u, v) => {
      const x = u * cos + v * sin;
      const y = (-u * sin + v * cos) / flat;
      if (y > 0 !== front) return;
      const d = Math.hypot(x, y) / r;
      if (d < 1.36 || d > 2.32) return;
      // heller B-Ring, Cassini-Lücke, äußerer A-Ring; dazu feine Rillen
      let density = d < 1.8 ? 0.8 : d < 1.92 ? 0.05 : 0.52;
      density *= 0.7 + 0.3 * hash(Math.floor(d * 34), 0, 5);
      const noise = hash(px, py, 9) * 0.85 + hash(px, py, beat) * 0.15;
      if (noise < density) c.dot(px, py, shade(RING, (d - 1.36) / 0.96), 4);
    });
  ring(false);
  drawSphere(c, cx, cy, r, SATURN, { bands: 7, tilt, time });
  ring(true);
  // kleiner Mond auf weiter Bahn
  const a = time / 9000;
  const mx = Math.cos(a) * r * 3.3;
  const my = Math.sin(a) * r * 3.3 * flat;
  const px = cx + mx * cos - my * sin;
  const py = cy + mx * sin + my * cos;
  if (!(my < 0 && Math.hypot(px - cx, py - cy) < r)) c.glyph(px, py, '∙', '#D9CFF0');
}

/** Schwarzes Loch: dunkler Schatten, leuchtender Bogen darüber, flache Scheibe davor. */
function drawBlackHole(c: Canvas, cx: number, cy: number, r: number, time: number): void {
  const tilt = -0.1;
  const flat = 0.2;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const beat = Math.floor(time / 300);
  around(c, cx, cy, r * 4.6, (px, py, u, v) => {
    const x = u * cos + v * sin;
    const y = -u * sin + v * cos;
    const dd = Math.hypot(u, v) / r; // Abstand im Bild
    const de = Math.hypot(x, y / flat) / r; // Abstand in der Scheibe
    const inDisk = de > 1.7 && de < 4.5;
    if (dd < 1 && !(y > 0 && inDisk)) {
      c.erase(px, py);
      return;
    }
    let density = 0;
    let heat = 0;
    if (inDisk) {
      const th = Math.atan2(y / flat, x);
      // Wirbel, die langsam um das Loch laufen; links heller (kommt auf uns zu)
      const swirl = 0.62 + 0.38 * Math.sin(3 * th + de * 2.4 - time / 1700);
      density = Math.exp(-(de - 1.7) / 1.25) * swirl * (0.72 + 0.28 * Math.cos(th - Math.PI)) * 1.7;
      heat = (de - 1.7) / 2.8;
    }
    if (dd >= 1 && dd < 1.8) {
      // das Licht der Rückseite, um das Loch herumgebogen
      const arc = Math.exp(-Math.pow((dd - 1.2) / 0.2, 2)) * (v < 0 ? 1.2 : 0.55);
      if (arc > density) {
        density = arc;
        heat = 0.04 + (dd - 1) * 0.45;
      }
    }
    if (density <= 0.02) return;
    if (hash(px, py, 3) * 0.8 + hash(px, py, beat) * 0.2 < density) c.dot(px, py, shade(HOT, heat), 2);
  });
}

/** Mondsichel mit schwachem Erdschein auf der dunklen Seite. */
function drawMoon(c: Canvas, cx: number, cy: number, r: number): void {
  around(c, cx, cy, r, (px, py, u, v) => {
    if (u * u + v * v > r * r) return;
    c.erase(px, py);
    if (Math.hypot(u - r * 0.5, v + r * 0.16) < r * 0.98) {
      if (hash(px, py, 4) < 0.05) c.dot(px, py, T.deep, 1);
      return;
    }
    // Krater: wolkige Flecken
    const crater = fbm(px / (r * 0.35), py / (r * 0.35), 31);
    if (bayer(px, py) < 0.62 + crater * 0.5) c.dot(px, py, crater > 0.55 ? '#F4E6C8' : '#D9CFF0', 3);
  });
}

/** Zwei Bergketten am unteren Rand: heller Kamm, nach unten ausdünnend. */
function drawMountains(c: Canvas, seed: number): void {
  for (let px = 0; px < c.W; px++) {
    const t = px / c.H;
    const far = c.H * (0.1 + 0.2 * fbm(t * 1.6 + 3, 0.5, seed));
    const near = c.H * (0.03 + 0.16 * fbm(t * 2.6 + 9, 1.5, seed + 4));
    const topFar = Math.round(c.H - far);
    const topNear = Math.round(c.H - near);
    for (let py = Math.min(topFar, topNear); py < c.H; py++) {
      c.erase(px, py);
      if (py >= topNear) {
        if (py === topNear) c.dot(px, py, T.purple, 3);
        else if (hash(px, py, 6) < 0.34 * (1 - ((py - topNear) / Math.max(1, near)) * 0.8)) c.dot(px, py, T.deep, 2);
      } else if (py === topFar) c.dot(px, py, '#5C62A6', 2);
      else if (hash(px, py, 8) < 0.12 * (1 - (py - topFar) / Math.max(1, far))) c.dot(px, py, SHADOW, 1);
    }
  }
}

/** Leuchtender Nebel: Wolken aus Rauschen, zieht sehr langsam. */
function drawNebula(c: Canvas, x0: number, y0: number, w: number, h: number, time: number, seed: number, strength = 1): void {
  const drift = time / 50000;
  const scale = 2.4 / Math.max(1, h);
  for (let py = Math.max(0, Math.floor(y0)); py < Math.min(c.H, y0 + h); py++) {
    for (let px = Math.max(0, Math.floor(x0)); px < Math.min(c.W, x0 + w); px++) {
      const ex = (px - (x0 + w / 2)) / (w / 2);
      const ey = (py - (y0 + h / 2)) / (h / 2);
      const mask = 1 - (ex * ex + ey * ey);
      if (mask <= 0) continue;
      const n = fbm(px * scale + drift, py * scale, seed);
      const n2 = fbm(px * scale * 0.55 + 5, py * scale * 0.55 - drift, seed + 7);
      const density = Math.max(0, n - 0.4) * 2.7 * Math.pow(mask, 0.7) * (0.5 + 0.6 * n2) * strength;
      if (hash(px, py, 3) < density) c.dot(px, py, shade(NEBULA, n2 * 1.25 - 0.1), 1);
    }
  }
}

/** Komet: heller Kopf, breiter Staubschweif und ein schmaler zweiter Schweif. */
function drawComet(c: Canvas, hx: number, hy: number, length: number, angle: number, time: number): void {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const beat = Math.floor(time / 350);
  around(c, hx, hy, length * 1.05, (px, py, dx, dy) => {
    const u = dx * ca + dy * sa; // entlang des Schweifs
    const v0 = -dx * sa + dy * ca;
    if (u < -2.5 || u > length) return;
    let density = 0;
    if (u < 0) density = Math.hypot(u, v0) < 2.4 ? 1 : 0;
    else {
      // Staubschweif: leicht gebogen, wird breiter und dünner
      const v = v0 - (u * u) / (length * 5);
      const wide = 1.6 + u * 0.16;
      density = Math.exp(-u / (length * 0.42)) * Math.exp(-(v * v) / (wide * wide)) * 1.2;
      // schmaler, gerader Gasschweif
      const v2 = v0 + u * 0.16;
      density = Math.max(density, Math.exp(-u / (length * 0.6)) * Math.exp(-(v2 * v2) / 2.2) * 0.7);
    }
    if (hash(px, py, 3) * 0.8 + hash(px, py, beat) * 0.2 < density) c.dot(px, py, u < 0 ? '#FFF4DC' : shade(HOT, 0.08 + (u / length) * 0.9), 2);
  });
  c.glyph(hx, hy, '✦', '#FFF4DC');
}

/** Rakete: Rumpf mit Fenster, Flossen und flackerndem Feuerstrahl. Der Winkel zeigt zur Spitze. */
function drawRocket(c: Canvas, cx: number, cy: number, len: number, angle: number, time: number): void {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const bw = len * 0.17;
  const beat = Math.floor(time / 130);
  around(c, cx, cy, len * 3, (px, py, dx, dy) => {
    const u = dx * ca + dy * sa;
    const v = -dx * sa + dy * ca;
    const t = u / len; // -0.5 (Heck) bis 0.5 (Spitze)
    const av = Math.abs(v);
    if (t >= -0.5 && t <= 0.5) {
      const prof = t < 0.05 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.05) / 0.45, 2)));
      if (av <= bw * prof) {
        c.erase(px, py);
        const wd = Math.hypot(u - 0.1 * len, v);
        if (wd < bw * 0.58) {
          if (wd > bw * 0.32) c.dot(px, py, T.cyan, 5);
          return;
        }
        // Rumpf: zur Schattenseite hin dünner gerastert
        const side = v / (bw * Math.max(0.2, prof));
        if (bayer(px, py) < 0.95 - Math.max(0, side) * 0.55) c.dot(px, py, t > 0.3 ? '#D9A58F' : t < -0.4 ? '#B48FB0' : '#F4E6C8', 4);
        return;
      }
    }
    // Flossen am Heck
    if (t >= -0.56 && t <= -0.18 && av > bw * 0.9 && av <= bw * (1 + 1.25 * ((-0.18 - t) / 0.38))) {
      c.erase(px, py);
      c.dot(px, py, '#C59BC0', 4);
      return;
    }
    // Feuerstrahl und Funken dahinter
    if (t < -0.5 && t > -2.6) {
      const k = (-0.5 - t) / 0.9;
      if (k < 1 && av < bw * (0.9 - 0.62 * k) * (1 + 0.22 * Math.sin(time / 110 + k * 9))) {
        if (hash(px, py, beat) < (1 - k) * 0.98) c.dot(px, py, shade(HOT, k * 0.75), 3);
        return;
      }
      if (av < bw * (0.5 + k * 0.5) && hash(px, py, beat >> 1) < 0.11 * Math.max(0, 1 - k / 2.4)) c.dot(px, py, T.deep, 1);
    }
  });
}

/** Sonne mit Planeten auf schrägen Bahnen. */
function drawSolarSystem(c: Canvas, cx: number, cy: number, a: number, time: number): void {
  const flat = 0.36;
  const cos = Math.cos(-0.14);
  const sin = Math.sin(-0.14);
  const orbits = [
    { r: 0.2, period: 9000, size: 0.9, color: '#D9A58F' },
    { r: 0.34, period: 16000, size: 1.3, color: '#EBC79E' },
    { r: 0.5, period: 26000, size: 1.4, color: '#8FB4D8' },
    { r: 0.66, period: 41000, size: 1.1, color: '#D58C96' },
    { r: 1, period: 90000, size: 2.2, color: '#C59BC0' },
  ];
  const place = (r: number, ang: number): [number, number] => {
    const x = Math.cos(ang) * r * a;
    const y = Math.sin(ang) * r * a * flat;
    return [cx + x * cos - y * sin, cy + x * sin + y * cos];
  };
  // Bahnen als feine Punkte
  for (const o of orbits) {
    const steps = Math.max(24, Math.round(o.r * a * 2.2));
    for (let i = 0; i < steps; i++) c.dot(...place(o.r, (i / steps) * Math.PI * 2), T.line, 0);
  }
  // Asteroidengürtel zwischen der vierten und fünften Bahn
  for (let i = 0; i < Math.round(a * 1.6); i++) {
    c.dot(...place(0.78 + hash(i, 2, 41) * 0.1, hash(i, 1, 41) * Math.PI * 2 + time / 120000), T.faint, 0);
  }
  // Sonne mit Schein
  const rs = Math.max(2.5, a * 0.075);
  const beat = Math.floor(time / 400);
  around(c, cx, cy, rs * 2.2, (px, py, u, v) => {
    const d = Math.hypot(u, v) / rs;
    const density = d < 1 ? 1 : Math.exp(-(d - 1) * 2.6) * 0.7;
    if (hash(px, py, 3) * 0.7 + hash(px, py, beat) * 0.3 < density) c.dot(px, py, shade(HOT, d * 0.32), 4);
  });
  // Planeten
  orbits.forEach((o, i) => {
    const [x, y] = place(o.r, (time / o.period) * Math.PI * 2 + i * 1.9);
    const s = o.size * Math.max(1, a / 60);
    around(c, x, y, s, (px, py, u, v) => {
      if (Math.hypot(u, v) <= s) c.dot(px, py, o.color, 5);
    });
  });
}

/** Sternschnuppe: alle paar Sekunden zieht eine kurz durchs Bild. */
function drawMeteor(c: Canvas, time: number, seed: number): void {
  const every = 9000;
  const n = Math.floor(time / every);
  const t = (time - n * every) / 1100;
  if (t >= 1 || hash(n, seed, 51) < 0.25) return;
  const len = Math.min(c.W, c.H) * 0.5;
  const hx = (0.25 + hash(n, seed, 52) * 0.7) * c.W - t * len * 1.6;
  const hy = hash(n, seed, 53) * 0.3 * c.H + t * len * 0.7;
  const tail = 16;
  for (let i = 0; i < tail; i++) {
    const k = i / tail;
    if (hash(i, n, 54) < k * 0.7) continue;
    c.dot(hx + k * tail * 1.6, hy - k * tail * 0.7, shade(HOT, 0.05 + k * 0.9), 2);
  }
}

// Profil einer Frau, nach links blickend (Stirn, Nase, Lippen, Kinn, Hals, Schulter, Hinterkopf), 0..1
const PROFILE: [number, number][] = [
  [0.47, 0.1], [0.41, 0.14], [0.375, 0.21], [0.36, 0.28], [0.355, 0.31], [0.365, 0.345],
  [0.33, 0.4], [0.3, 0.45], [0.315, 0.468], [0.333, 0.478], [0.335, 0.5], [0.318, 0.52],
  [0.328, 0.533], [0.345, 0.54], [0.33, 0.55], [0.325, 0.563], [0.35, 0.585], [0.338, 0.61],
  [0.34, 0.63], [0.37, 0.655], [0.43, 0.68], [0.45, 0.78], [0.42, 0.88], [0.37, 1.0],
  [0.9, 1.0], [0.76, 0.87], [0.66, 0.78], [0.64, 0.68], [0.68, 0.56], [0.71, 0.42],
  [0.69, 0.27], [0.63, 0.16], [0.55, 0.105],
];

function inPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Retro-Sonne mit Streifen in der unteren Hälfte (wie auf alten Plattenhüllen). */
function drawRetroSun(c: Canvas, cx: number, cy: number, r: number, time: number): void {
  const drift = (time / 260) % 8;
  around(c, cx, cy, r, (px, py, u, v) => {
    const d = Math.hypot(u, v) / r;
    if (d > 1) return;
    const t = (v / r + 1) / 2; // 0 oben, 1 unten
    if (t > 0.5) {
      // Streifen: nach unten breiter, wandern langsam nach unten
      const band = ((v + drift) % 8) / 8;
      if (band < (t - 0.5) * 1.3) return;
    }
    if (bayer(px, py) < 0.75 - d * 0.25) c.dot(px, py, shade(['#F4E6C8', '#EBC79E', '#E3B48F', '#D9A58F', '#C59BC0', '#B48FB0'], t), 1);
  });
}

/**
 * Frauenprofil als dunkle Silhouette vor der Sonne, mit hellem Lichtsaum an Gesicht und Haar
 * und langem Haar, das sich langsam im Wind bewegt.
 */
function drawMuse(c: Canvas, ox: number, oy: number, S: number, time: number): void {
  const inside = (px: number, py: number) => inPoly((px + 0.5 - ox) / S, (py + 0.5 - oy) / S, PROFILE);
  // Körper: dunkel, mit feinem Raster; Saum zur Lichtseite hell
  for (let py = Math.max(0, Math.floor(oy)); py < Math.min(c.H, oy + S); py++) {
    for (let px = Math.max(0, Math.floor(ox)); px < Math.min(c.W, ox + S); px++) {
      if (!inside(px, py)) continue;
      c.erase(px, py);
      const edgeL = !inside(px - 1, py) || !inside(px - 1, py - 1);
      const edgeT = !inside(px, py - 1);
      const y = (py - oy) / S;
      if (edgeL || edgeT) {
        const lips = y > 0.5 && y < 0.58;
        c.dot(px, py, lips ? '#D9A0A0' : y < 0.7 ? '#EBC79E' : '#B48FB0', 4);
      } else if (!inside(px + 1, py) || !inside(px, py + 1)) c.dot(px, py, '#5B4E96', 3);
      else if (bayer(px, py) < 0.05) c.dot(px, py, '#3B3F78', 2);
    }
  }
  // geschlossenes Auge mit Wimpern
  const ex = ox + 0.385 * S;
  const ey = oy + 0.365 * S;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    c.dot(ex + t * 0.04 * S, ey + Math.sin(t * Math.PI) * 0.008 * S, '#EBC79E', 5);
  }
  for (let i = 0; i < 3; i++) c.dot(ex + (0.008 + i * 0.012) * S, ey + 0.016 * S, '#C59BC0', 5);
  // Haar: viele Strähnen vom Scheitel nach hinten, wehen im Wind
  const strands = Math.max(14, Math.round(S / 3));
  const sway = time / 1600;
  for (let k = 0; k < strands; k++) {
    const a = k / (strands - 1);
    // Ansatz entlang des Kopfes: Stirn oben bis Hinterkopf
    const sx = 0.47 + a * 0.24;
    const sy = 0.1 + Math.pow(a, 1.4) * 0.34;
    const len = 0.5 + 0.35 * hash(k, 3, 19);
    const steps = Math.round(S * len * 1.4);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const wave = Math.sin(t * 5 + k * 0.7 + sway) * 0.035 * t + Math.sin(t * 11 + k) * 0.008 * t;
      const x = sx + t * (0.18 + 0.12 * a) + wave;
      const y = sy + t * len * 0.9 + Math.sin(t * 2.2) * 0.04;
      if (y > 1.02) break;
      const px = ox + x * S;
      const py = oy + y * S;
      if (hash(k, i, 23) < 0.3) continue;
      const color = shade(['#F4E6C8', '#C59BC0', '#A99BDC', '#8676C4', '#5B4E96'], 0.15 + t * 0.85);
      c.dot(px, py, color, t < 0.08 ? 5 : 4);
    }
  }
}

/** Ästhetisches Bild: Frauenprofil vor einer Retro-Sonne unter Sternen, mit Sternschnuppen. */
export function muse(cols: number, rows: number, time: number): Line[] {
  const c = new Canvas(cols, rows);
  const S = Math.min(c.H * 1.02, c.W * 0.95);
  const ox = (c.W - S) / 2 + S * 0.02;
  const oy = c.H - S;
  drawRetroSun(c, ox + S * 0.6, oy + S * 0.42, S * 0.36, time);
  drawMuse(c, ox, oy, S, time);
  drawMeteor(c, time, 9);
  return c.lines(time, 0.05, 41);
}

// ------------------------------------------------------------ eigene Bilder (Braille-Text)

interface Bitmap {
  w: number;
  h: number;
  px: Uint8Array;
  /** Anteil gesetzter Punkte (klein = Strichzeichnung) */
  fill: number;
}
const bitmaps = new Map<string, Bitmap>();

/** Braille-Text in Bildpunkte zerlegen, helle Fläche als Hintergrund erkennen, leeren Rand abschneiden. */
function decodeBraille(src: string): Bitmap {
  const cached = bitmaps.get(src);
  if (cached) return cached;
  const rowsTxt = src.split(/\r?\n/).map((l) => [...l]);
  const SW = Math.max(1, ...rowsTxt.map((l) => l.length)) * 2;
  const SH = rowsTxt.length * 4;
  let px = new Uint8Array(SW * SH);
  let on = 0;
  rowsTxt.forEach((l, y) =>
    l.forEach((ch, x) => {
      const code = ch.codePointAt(0)! - 0x2800;
      if (code <= 0 || code > 255) return;
      for (let dx = 0; dx < 2; dx++)
        for (let dy = 0; dy < 4; dy++)
          if (code & DOT[dx]![dy]!) {
            px[(y * 4 + dy) * SW + x * 2 + dx] = 1;
            on++;
          }
    }),
  );
  // Überwiegend gefüllt: das Bild ist „negativ“ gezeichnet, also umdrehen
  if (on > px.length * 0.5) for (let i = 0; i < px.length; i++) px[i] = px[i] ? 0 : 1;
  let x0 = SW;
  let x1 = 0;
  let y0 = SH;
  let y1 = 0;
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++)
      if (px[y * SW + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < x0) return { w: 1, h: 1, px: new Uint8Array(1), fill: 0 };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const crop = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) crop[y * w + x] = px[(y + y0) * SW + x + x0]!;
  px = crop;
  let set = 0;
  for (const v of px) set += v;
  const bm = { w, h, px, fill: set / px.length };
  bitmaps.set(src, bm);
  return bm;
}

/**
 * Ein Bild aus Braille-Text auf die Fläche einpassen: verkleinern (Flächenmittel mit Raster,
 * damit Graustufen erhalten bleiben), im Verlauf Creme – Altrosa – Violett einfärben, Sterne dahinter.
 */
export function brailleImage(src: string, cols: number, rows: number, time: number): Line[] {
  const bm = decodeBraille(src);
  const c = new Canvas(cols, rows);
  const scale = Math.min(c.W / bm.w, c.H / bm.h, 1);
  const tw = Math.max(1, Math.floor(bm.w * scale));
  const th = Math.max(1, Math.floor(bm.h * scale));
  const ox = Math.floor((c.W - tw) / 2);
  const oy = Math.floor((c.H - th) / 2);
  const stops = ['#F4E6C8', '#EBC79E', '#D9A58F', '#C59BC0', '#A99BDC', '#8676C4', '#5C62A6'];
  const shimmer = (time / 9000) % 1;
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor(ty / scale);
    const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) / scale));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor(tx / scale);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) / scale));
      let sum = 0;
      let n = 0;
      for (let y = sy0; y < sy1 && y < bm.h; y++)
        for (let x = sx0; x < sx1 && x < bm.w; x++) {
          sum += bm.px[y * bm.w + x]!;
          n++;
        }
      const avg = n ? sum / n : 0;
      // Strichzeichnungen: schon wenige Punkte reichen, sonst verschwinden dünne Linien beim Verkleinern
      if (avg > bayer(tx, ty) * (bm.fill < 0.3 ? 0.3 : 0.85) + (bm.fill < 0.3 ? 0.02 : 0.08)) {
        // leichter Schimmer, der langsam über das Bild wandert
        const t = ty / th + 0.12 * Math.sin((tx / tw + shimmer) * Math.PI * 2);
        c.dot(ox + tx, oy + ty, shade(stops, Math.max(0, Math.min(1, t))), 3);
      }
    }
  }
  return c.lines(time, 0.03, 55);
}

// ------------------------------------------------------------ fertige Bilder

/** Spiralgalaxie, schräg von links unten nach rechts oben. Größe in Zeichen; sinnvoll ab etwa 24×7. */
export function galaxy(cols: number, rows: number, time: number): Line[] {
  const c = new Canvas(cols, rows);
  const radius = Math.min(c.W * 0.52, (c.H * 0.5) / (0.4 + Math.abs(Math.sin(-0.42)) * 0.55));
  drawGalaxy(c, c.W / 2, c.H / 2, radius, time);
  return c.lines(time, 0.045);
}

/** Nur Sternenhimmel (für Ränder und Lücken). */
export function starfield(cols: number, rows: number, time: number, density = 0.05, seed = 0): Line[] {
  return new Canvas(cols, rows).lines(time, density, seed);
}

/** Sternbild Pegasus als Sternkarte. */
export function pegasus(cols: number, rows: number, time: number): Line[] {
  const c = new Canvas(cols, rows);
  drawConstellation(c, PEGASUS, 1, 2, c.W - 3, c.H - 5, time);
  return c.lines(time, 0.03, 3, true);
}

/** Bilder für leere Chats. Das erste gehört dem Teamchat, das letzte den Aufgaben. */
export const SCENES = ['pegasus', 'saturn', 'orion', 'loch', 'rakete', 'berge', 'nebel', 'komet', 'loewe', 'sonnensystem'] as const;
export type SceneName = (typeof SCENES)[number];

/** Bilder, die sich die Sitzungen der Reihe nach teilen. */
const AGENT_SCENES: SceneName[] = ['saturn', 'orion', 'loch', 'rakete', 'berge', 'nebel', 'komet', 'loewe'];
export const agentScene = (index: number): SceneName => AGENT_SCENES[Math.abs(index) % AGENT_SCENES.length]!;

const CAPTION: Record<SceneName, string> = {
  pegasus: 'PEGASUS',
  saturn: 'SATURN',
  orion: 'ORION',
  loch: 'SCHWARZES LOCH',
  rakete: 'AUFBRUCH',
  berge: 'GROSSER WAGEN',
  nebel: 'KASSIOPEIA',
  komet: 'KOMET',
  loewe: 'LÖWE UND JUPITER',
  sonnensystem: 'SONNENSYSTEM',
};

/**
 * Ein ganzes Bild in der Größe des Chats. Die Hauptfigur steht im oberen Teil,
 * damit der Begrüßungstext darunter Platz hat.
 */
export function scene(name: SceneName, cols: number, rows: number, time: number): Line[] {
  const c = new Canvas(cols, rows);
  const { W, H } = c;
  const unit = Math.min(H, W * 0.55);
  let density = 0.04;
  switch (name) {
    case 'pegasus': {
      drawNebula(c, W * 0.5, H * 0.55, W * 0.6, H * 0.5, time, 12, 0.5);
      const w = Math.min(W * 0.56, unit * 1.5);
      drawConstellation(c, PEGASUS, W * 0.4 - w / 2, H * 0.05, w, Math.min(H * 0.48, w * 0.55), time);
      drawGalaxy(c, W * 0.86, H * 0.2, Math.min(W * 0.13, unit * 0.3), time);
      drawMeteor(c, time, 1);
      break;
    }
    case 'saturn': {
      drawSaturn(c, W * 0.5, H * 0.28, Math.max(5, Math.min(unit * 0.15, W * 0.085)), time);
      const w = Math.min(W * 0.2, unit * 0.5);
      drawConstellation(c, KASSIOPEIA, W * 0.05, H * 0.08, w, w * 0.45, time);
      drawGalaxy(c, W * 0.9, H * 0.82, Math.min(W * 0.1, unit * 0.22), time, 0.5, 0.36);
      drawMeteor(c, time, 2);
      break;
    }
    case 'orion': {
      const h = H * 0.52;
      const w = Math.min(W * 0.4, h * 0.8);
      drawNebula(c, W * 0.5 - w * 0.7, H * 0.18, w * 1.4, h * 0.75, time, 21, 0.55);
      drawConstellation(c, ORION, W * 0.5 - w / 2, H * 0.03, w, h, time);
      drawMoon(c, W * 0.88, H * 0.16, Math.max(4, Math.min(unit * 0.09, W * 0.05)));
      drawMeteor(c, time, 3);
      break;
    }
    case 'loch': {
      density = 0.05;
      drawBlackHole(c, W * 0.5, H * 0.28, Math.max(5, Math.min(unit * 0.12, W * 0.06)), time);
      const w = Math.min(W * 0.18, unit * 0.45);
      drawConstellation(c, SCHWAN, W * 0.04, H * 0.5, w, w, time);
      break;
    }
    case 'rakete': {
      drawSphere(c, W * 0.08, H * 1.02, Math.max(10, unit * 0.36), ICE, { bands: 5, tilt: 0.3, time, spin: 14000 });
      drawRocket(c, W * 0.58, H * 0.22, Math.max(14, Math.min(unit * 0.28, W * 0.17)), -0.5, time);
      const w = Math.min(W * 0.16, unit * 0.4);
      drawConstellation(c, KASSIOPEIA, W * 0.06, H * 0.08, w, w * 0.45, time);
      break;
    }
    case 'berge': {
      const w = Math.min(W * 0.46, unit * 1.2);
      drawConstellation(c, WAGEN, W * 0.12, H * 0.07, w, Math.min(H * 0.3, w * 0.4), time);
      drawMoon(c, W * 0.84, H * 0.2, Math.max(5, Math.min(unit * 0.11, W * 0.06)));
      drawMeteor(c, time, 4);
      drawMountains(c, 5);
      break;
    }
    case 'nebel': {
      density = 0.05;
      drawNebula(c, W * 0.12, -H * 0.05, W * 0.8, H * 0.66, time, 33, 1.15);
      const w = Math.min(W * 0.26, unit * 0.6);
      drawConstellation(c, KASSIOPEIA, W * 0.5 - w / 2, H * 0.16, w, w * 0.42, time);
      drawGalaxy(c, W * 0.08, H * 0.84, Math.min(W * 0.08, unit * 0.2), time, 0.3, 0.42);
      break;
    }
    case 'komet': {
      drawComet(c, W * 0.34, H * 0.4, Math.min(W * 0.5, unit * 1.3), -0.38, time);
      const w = Math.min(W * 0.16, unit * 0.4);
      drawConstellation(c, SCHWAN, W * 0.84 - w / 2, H * 0.5, w, w, time);
      drawMoon(c, W * 0.1, H * 0.16, Math.max(3, Math.min(unit * 0.06, W * 0.035)));
      break;
    }
    case 'loewe': {
      const w = Math.min(W * 0.42, unit * 1.05);
      drawConstellation(c, LOEWE, W * 0.1, H * 0.06, w, Math.min(H * 0.4, w * 0.5), time);
      drawSphere(c, W * 0.8, H * 0.26, Math.max(5, Math.min(unit * 0.16, W * 0.09)), JUPITER, { bands: 11, tilt: 0.12, time, spin: 6000 });
      c.glyph(W * 0.8 + Math.cos(time / 7000) * unit * 0.32, H * 0.26 + Math.sin(time / 7000) * unit * 0.05, '∙', '#D9CFF0');
      drawMeteor(c, time, 5);
      break;
    }
    case 'sonnensystem': {
      drawSolarSystem(c, W * 0.5, H * 0.3, Math.min(W * 0.44, (H * 0.27) / 0.36), time);
      break;
    }
  }
  const out = c.lines(time, density, SCENES.indexOf(name) + 1);
  // Beschriftung wie auf einer Sternkarte, unten rechts
  const label = [...CAPTION[name]].join(' ');
  if (cols >= label.length + 8 && rows >= 8) {
    return overlay(out, [[{ text: ' '.repeat(cols - label.length - 2) }, { text: label, color: T.faint }]], rows - 1, cols);
  }
  return out;
}

// ------------------------------------------------------------ Bild und Text mischen

interface Cell {
  ch: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}

function toCells(line: Line | undefined, width: number): Cell[] {
  const out: Cell[] = [];
  for (const s of line ?? []) {
    for (const ch of s.text) {
      if (out.length >= width) break;
      out.push({ ch, color: s.color, bg: s.bg, bold: s.bold, dim: s.dim, italic: s.italic });
      // breite Zeichen belegen zwei Zellen
      if (ch.codePointAt(0)! >= 0x2e80 && textWidth(ch) === 2 && out.length < width) out.push({ ch: '' });
    }
  }
  while (out.length < width) out.push({ ch: ' ' });
  return out;
}

function fromCells(cells: Cell[]): Line {
  const out: Span[] = [];
  for (const c of cells) {
    const last = out[out.length - 1];
    if (last && last.color === c.color && last.bg === c.bg && last.bold === c.bold && last.dim === c.dim && last.italic === c.italic) last.text += c.ch;
    else out.push({ text: c.ch, color: c.color, bg: c.bg, bold: c.bold, dim: c.dim, italic: c.italic });
  }
  return out;
}

const isInk = (c: Cell): boolean => (c.ch !== ' ' && c.ch !== '') || Boolean(c.bg);

/**
 * Legt Text über ein Bild. Die Zeilen des Textes sind schon waagerecht gesetzt (volle Breite);
 * `top` ist die Zeile im Bild, in der die erste Textzeile steht. Hinter dem Text wird das Bild
 * frei geräumt: je Zeile oder – mit `box` – als ein gemeinsames Feld mit etwas Rand.
 */
export function overlay(bg: Line[], fg: Line[], top: number, width: number, opts: { box?: boolean } = {}): Line[] {
  const grid = bg.map((l) => toCells(l, width));
  const rows = fg.map((l) => toCells(l, width));
  const extent = rows.map((r) => {
    let a = -1;
    let b = -1;
    r.forEach((c, i) => {
      if (!isInk(c)) return;
      if (a < 0) a = i;
      b = i;
    });
    return [a, b] as const;
  });
  if (opts.box) {
    const inked = extent.filter(([a]) => a >= 0);
    if (inked.length) {
      const A = Math.max(0, Math.min(...inked.map(([a]) => a)) - 3);
      const B = Math.min(width - 1, Math.max(...inked.map(([, b]) => b)) + 3);
      for (let y = top - 1; y <= top + rows.length; y++) {
        const row = grid[y];
        if (!row) continue;
        for (let x = A; x <= B; x++) row[x] = { ch: ' ' };
      }
    }
  }
  rows.forEach((r, i) => {
    const row = grid[top + i];
    const [a, b] = extent[i]!;
    if (!row || a < 0) return;
    for (let x = Math.max(0, a - 1); x <= Math.min(width - 1, b + 1); x++) row[x] = x >= a && x <= b ? r[x]! : { ch: ' ' };
  });
  return grid.map(fromCells);
}

/** Löst ein Bild auf (t von 0 bis 1): Punkte fallen weg, der Rest wird dunkler. */
export function dissolve(lines: Line[], t: number, width: number): Line[] {
  const k = Math.max(0, Math.min(1, t));
  return lines.map((l, y) =>
    fromCells(
      toCells(l, width).map((c, x) => {
        if (c.ch === ' ' || hash(x, y, 61) < k * 1.1) return { ch: ' ' };
        return { ...c, color: mix(c.color ?? T.faint, '#0E0B1C', k * 0.75) };
      }),
    ),
  );
}

/** Mittig setzen: gibt die Zeilen mit linkem Rand zurück. */
export function centered(lines: Line[], artWidth: number, width: number): Line[] {
  const pad = Math.max(0, Math.floor((width - artWidth) / 2));
  return lines.map((l) => [{ text: ' '.repeat(pad) }, ...l]);
}

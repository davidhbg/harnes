import type { Store } from './store.js';

/**
 * Wiederkehrende Aufgaben: Zu festen Zeiten schickt RemoteHarnes eine Nachricht an das Team
 * oder an eine Sitzung (z. B. „Starte die Tests und melde Fehler“ jeden Morgen um 8 Uhr).
 * Läuft nur, solange RemoteHarnes geöffnet ist.
 */
export interface Plan {
  id: number;
  /** Nachricht, die gesendet wird */
  text: string;
  /** 'team' oder Name einer Sitzung */
  an: string;
  /** wie eingegeben, z. B. „täglich 08:00“ oder „alle 30 min“ */
  wann: string;
  aktiv: boolean;
  /** zuletzt ausgeführt (ms) */
  zuletzt: number;
  /** angelegt (ms) */
  seit: number;
}

type Rule = { kind: 'taeglich'; minute: number } | { kind: 'alle'; ms: number };

/** Versteht „täglich 08:00“, „08:00“, „alle 30 min“, „alle 2 std“, „stündlich“. */
export function parseWann(text: string): Rule {
  const t = text.trim().toLowerCase();
  const clock = t.match(/(\d{1,2})[:.](\d{2})/);
  if (clock && !/alle/.test(t)) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h > 23 || m > 59) throw new Error('Uhrzeit ungültig, z. B. „täglich 08:00“.');
    return { kind: 'taeglich', minute: h * 60 + m };
  }
  if (/st(ü|ue)ndlich/.test(t)) return { kind: 'alle', ms: 3_600_000 };
  const every = t.match(/alle\s+(\d+)\s*(min|minuten|m|std|stunden|h|tage?|d)\b/);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2]!;
    const ms = unit.startsWith('m') ? n * 60_000 : unit.startsWith('t') || unit === 'd' ? n * 86_400_000 : n * 3_600_000;
    if (ms < 5 * 60_000) throw new Error('Kürzestes Intervall sind 5 Minuten.');
    return { kind: 'alle', ms };
  }
  throw new Error('Wann? Zum Beispiel „täglich 08:00“, „alle 30 min“, „alle 2 std“ oder „stündlich“.');
}

/** Ist der Plan jetzt dran? */
export function isDue(plan: Plan, now: number): boolean {
  if (!plan.aktiv) return false;
  const rule = parseWann(plan.wann);
  if (rule.kind === 'alle') return now - Math.max(plan.zuletzt, plan.seit) >= rule.ms;
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(rule.minute / 60), rule.minute % 60).getTime();
  // heute fällig, noch nicht heute ausgeführt, und nicht länger als 2 Stunden verpasst
  return now >= target && now - target < 2 * 3_600_000 && plan.zuletzt < target;
}

export class PlanBoard {
  plans: Plan[] = [];
  private nextId = 1;

  constructor(private store: Store) {
    const saved = store.loadJson<{ nextId: number; plans: Plan[] }>('plaene.json', { nextId: 1, plans: [] });
    this.plans = saved.plans;
    this.nextId = saved.nextId;
  }

  private save(): void {
    this.store.saveJson('plaene.json', { nextId: this.nextId, plans: this.plans });
  }

  add(text: string, an: string, wann: string): Plan {
    if (!text.trim()) throw new Error('Was soll gesendet werden?');
    parseWann(wann);
    const p: Plan = { id: this.nextId++, text: text.trim(), an, wann: wann.trim(), aktiv: true, zuletzt: 0, seit: Date.now() };
    this.plans.push(p);
    this.save();
    return p;
  }

  remove(id: number): void {
    this.plans = this.plans.filter((p) => p.id !== id);
    this.save();
  }

  toggle(id: number): Plan {
    const p = this.plans.find((x) => x.id === id);
    if (!p) throw new Error(`Zeitplan #${id} gibt es nicht.`);
    p.aktiv = !p.aktiv;
    this.save();
    return p;
  }

  /** Fällige Pläne holen und als ausgeführt markieren. */
  takeDue(now = Date.now()): Plan[] {
    const due = this.plans.filter((p) => {
      try {
        return isDue(p, now);
      } catch {
        return false;
      }
    });
    for (const p of due) p.zuletzt = now;
    if (due.length) this.save();
    return due;
  }
}

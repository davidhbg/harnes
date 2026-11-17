import { isAbsolute, resolve } from 'node:path';
import type { Task, TaskStatus } from '../types.js';
import type { Store } from './store.js';

const STATUSES: TaskStatus[] = ['offen', 'reserviert', 'in_arbeit', 'erledigt', 'blockiert'];

interface Saved {
  nextId: number;
  tasks: Task[];
  files: Record<string, string>;
}

/** Aufgabenbrett mit Reservierung von Aufgaben und Dateien. */
export class TaskBoard {
  tasks: Task[] = [];
  /** normalisierter Pfad → Agent (ausdrücklich reserviert oder automatisch gesperrt) */
  files = new Map<string, string>();
  /**
   * Automatische Sperren: entstehen, sobald eine Sitzung eine Datei bearbeitet,
   * und enden mit ihrer Runde. So kommen sich zwei Sitzungen auch dann nicht in
   * die Quere, wenn keine an datei_reservieren gedacht hat.
   */
  auto = new Set<string>();
  private nextId = 1;

  constructor(
    private store: Store,
    private cwd: string,
    private human: string,
    private onChange: () => void,
  ) {
    const saved = store.loadJson<Saved>('tasks.json', { nextId: 1, tasks: [], files: {} });
    this.tasks = saved.tasks ?? [];
    this.nextId = saved.nextId ?? this.tasks.reduce((m, t) => Math.max(m, t.id + 1), 1);
    for (const [k, v] of Object.entries(saved.files ?? {})) this.files.set(k, v);
  }

  private save(): void {
    const explicit: Record<string, string> = {};
    for (const [k, v] of this.files) if (!this.auto.has(k)) explicit[k] = v;
    this.store.saveJson('tasks.json', { nextId: this.nextId, tasks: this.tasks, files: explicit } satisfies Saved);
    this.onChange();
  }

  add(by: string, title: string, description?: string): Task {
    const now = Date.now();
    const t: Task = {
      id: this.nextId++,
      title: title.trim(),
      description: description?.trim() || undefined,
      status: 'offen',
      createdBy: by,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(t);
    this.save();
    return t;
  }

  get(id: number): Task {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`Aufgabe #${id} gibt es nicht.`);
    return t;
  }

  claim(by: string, id: number): Task {
    const t = this.get(id);
    if (t.status === 'erledigt') throw new Error(`Aufgabe #${id} ist schon erledigt.`);
    if (t.owner && t.owner !== by && t.status !== 'offen') {
      const free = this.tasks.filter((x) => x.status === 'offen').map((x) => `#${x.id} ${x.title}`);
      throw new Error(
        `Aufgabe #${id} ist bereits von ${t.owner} reserviert. ` +
          (free.length ? `Frei sind noch: ${free.join('; ')}.` : 'Es ist keine Aufgabe mehr frei – unterstütze die anderen oder warte auf neue Aufgaben.'),
      );
    }
    t.owner = by;
    if (t.status === 'offen') t.status = 'reserviert';
    t.updatedAt = Date.now();
    this.save();
    return t;
  }

  /** Der Teamleiter weist eine Aufgabe zu (auch wenn sie schon jemand hatte). */
  assign(id: number, agent: string): Task {
    const t = this.get(id);
    t.owner = agent;
    if (t.status === 'offen' || t.status === 'erledigt') t.status = 'reserviert';
    t.updatedAt = Date.now();
    this.save();
    return t;
  }

  remove(id: number): Task {
    const t = this.get(id);
    this.tasks = this.tasks.filter((x) => x.id !== id);
    this.save();
    return t;
  }

  setStatus(by: string, id: number, status: string, proof?: string): Task {
    const t = this.get(id);
    if (!STATUSES.includes(status as TaskStatus)) {
      throw new Error(`Unbekannter Status „${status}“. Erlaubt: ${STATUSES.join(', ')}.`);
    }
    if (t.owner && t.owner !== by && by !== this.human) {
      throw new Error(`Aufgabe #${id} gehört ${t.owner}. Nur ${t.owner} oder der Teamleiter ändert den Status.`);
    }
    if (!t.owner && status !== 'offen' && by !== this.human) t.owner = by;
    t.status = status as TaskStatus;
    if (status === 'offen') t.owner = undefined;
    if (proof?.trim()) t.proof = proof.trim();
    t.updatedAt = Date.now();
    this.save();
    return t;
  }

  normalize(path: string): string {
    const abs = isAbsolute(path) ? path : resolve(this.cwd, path);
    const norm = abs.replace(/\\/g, '/');
    return process.platform === 'win32' ? norm.toLowerCase() : norm;
  }

  holderOf(path: string): string | undefined {
    return this.files.get(this.normalize(path));
  }

  /** Ausdrückliche Reservierung (Werkzeug datei_reservieren). Bleibt bis zur Freigabe. */
  reserveFile(by: string, path: string): { ok: boolean; holder: string } {
    const key = this.normalize(path);
    const holder = this.files.get(key);
    if (holder && holder !== by) return { ok: false, holder };
    this.files.set(key, by);
    this.auto.delete(key);
    this.save();
    return { ok: true, holder: by };
  }

  /**
   * Eine Sitzung will die Datei jetzt bearbeiten. Hat sie jemand anderes, kommt dessen
   * Name zurück. Sonst wird die Datei bis zum Ende der Runde automatisch gesperrt.
   */
  touch(by: string, path: string): string | undefined {
    const key = this.normalize(path);
    const holder = this.files.get(key);
    if (holder && holder !== by) return holder;
    if (!holder) {
      this.files.set(key, by);
      this.auto.add(key);
      this.onChange();
    }
    return undefined;
  }

  /** Automatische Sperren einer Sitzung aufheben (am Ende ihrer Runde). */
  releaseAuto(agent: string): void {
    let changed = false;
    for (const key of [...this.auto]) {
      if (this.files.get(key) === agent) {
        this.files.delete(key);
        this.auto.delete(key);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  releaseFile(by: string, path: string): boolean {
    const key = this.normalize(path);
    const holder = this.files.get(key);
    if (!holder) return false;
    if (holder !== by && by !== this.human) throw new Error(`Die Datei ist von ${holder} reserviert, nicht von dir.`);
    this.files.delete(key);
    this.auto.delete(key);
    this.save();
    return true;
  }

  releaseAllOf(agent: string): void {
    let changed = false;
    for (const [k, v] of [...this.files]) {
      if (v === agent) {
        this.files.delete(k);
        this.auto.delete(k);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  describe(t: Task): string {
    const owner = t.owner ? ` · ${t.owner}` : '';
    const proof = t.proof ? ` · Nachweis: ${t.proof}` : '';
    const desc = t.description ? ` — ${t.description}` : '';
    return `#${t.id} [${t.status}] ${t.title}${desc}${owner}${proof}`;
  }

  listText(): string {
    const lines: string[] = [];
    if (!this.tasks.length) lines.push('Keine Aufgaben auf dem Brett.');
    for (const t of this.tasks) lines.push(this.describe(t));
    if (this.files.size) {
      lines.push('', 'Gesperrte Dateien:');
      for (const [p, a] of this.files) lines.push(`- ${p} → ${a}${this.auto.has(p) ? ' (wird gerade bearbeitet)' : ' (reserviert)'}`);
    }
    return lines.join('\n');
  }

  /** Eine Sitzung wurde umbenannt: Aufgaben und Sperren ziehen mit. */
  renameAgent(oldName: string, newName: string): void {
    for (const task of this.tasks) if (task.owner === oldName) task.owner = newName;
    for (const [p, a] of this.files) if (a === oldName) this.files.set(p, newName);
    this.save();
  }
}

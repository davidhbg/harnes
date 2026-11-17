import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Adapter, AdapterContext, AgentSpec } from '../adapters/adapter.js';
import { kindLabel } from '../adapters/adapter.js';
import { runtimeMcp, type Config } from '../config.js';
import type {
  AgentStatus,
  Approval,
  ApprovalDecision,
  LogEntry,
  Message,
  Usage,
} from '../types.js';
import { errText, truncate, uid } from '../util.js';
import { cleanFinal, formatDelivery, isNoContribution, teamPrompt } from './prompts.js';
import type { BalanceWatch } from '../balance.js';
import type { Store } from './store.js';
import { PlanBoard, type Plan } from './plans.js';
import { listRepos, reposDir } from './repos.js';
import { roleById } from './roles.js';
import { TaskBoard } from './tasks.js';
import { TOOL_DEFS, runTool } from './tools.js';
import type { Vault } from './vault.js';
import { MODI, modusLabel, selbstEntscheiden, type AktionsArt, type FreigabeModus } from './freigabe.js';

export interface AgentRec {
  name: string;
  spec: AgentSpec;
  label: string;
  status: AgentStatus;
  detail?: string;
  adapter?: Adapter;
  token: string;
  /** wartet auf Zustellung */
  inbox: Message[];
  /** Nachrichten, auf die die laufende Runde antwortet */
  trigger: Message[];
  usage: Usage;
  log: LogEntry[];
  /** vom Team getrennt (/trennen) */
  paused: boolean;
  /** Token-Grenze dieser Sitzung, 0 = keine */
  budgetTokens: number;
  /** Kosten-Grenze in US-Dollar, 0 = keine */
  budgetUsd: number;
  /** Grenze erreicht: Es wird nichts mehr zugestellt, bis sie angehoben wird. */
  budgetHit: boolean;
  /** seit wann der aktuelle Status gilt */
  since: number;
  /** abgeschlossene Arbeitszeit in ms (Status „arbeitet“), die laufende Runde kommt in workedMs() dazu */
  workedMs: number;
  /** Ziele ('team' oder Teilnehmer), an die die Sitzung in dieser Runde schon per Werkzeug geschrieben hat */
  sentViaTool: Set<string>;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

interface PendingApproval extends Approval {
  resolve: (d: ApprovalDecision | 'timeout') => void;
  art?: AktionsArt;
  befehl?: string;
  timer?: NodeJS.Timeout;
}

export interface HubOptions {
  project: string;
  cwd: string;
  config: Config;
  store: Store;
  vault: Vault;
  mcpServerPath: string;
  createAdapter: (spec: AgentSpec, ctx: AdapterContext) => Promise<Adapter>;
}

const RESERVED = new Set(['team', 'alle', 'all', 'system', 'aufgaben', 'hilfe']);
const LIVE: AgentStatus[] = ['startet', 'wartet', 'arbeitet', 'freigabe'];

/**
 * Die Zentrale: kennt alle Sitzungen, verteilt Nachrichten nach den Teamregeln,
 * führt Posteingänge, Freigaben und das Aufgabenbrett.
 * Ereignis 'change' = irgendetwas Sichtbares hat sich geändert.
 */
export class Hub extends EventEmitter {
  readonly messages: Message[] = [];
  /** Guthaben der API-Anbieter (setzt harnes.tsx; in Tests leer) */
  balance?: BalanceWatch;
  readonly agents = new Map<string, AgentRec>();
  readonly approvals: PendingApproval[] = [];
  readonly tasks: TaskBoard;
  readonly human: string;
  readonly humanLabel: string;
  /** Adresse des lokalen Servers (setzt server.ts) */
  url = '';
  paused = false;
  readonly startedAt = Date.now();
  private chainCount = 0;
  private held: { msg: Message; recipients: string[] }[] = [];
  private holdNotified = false;
  /** Sitzungen, die beim letzten Lauf offen waren (für /wieder) */
  readonly lastRoster: AgentSpec[];

  constructor(readonly opts: HubOptions) {
    super();
    this.setMaxListeners(50);
    this.lastRoster = opts.store.loadJson<AgentSpec[]>('roster.json', []);
    this.humanLabel = opts.config.benutzer.trim() || 'Mensch';
    this.human = this.humanLabel.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'mensch';
    this.messages.push(...opts.store.loadMessages(500));
    this.tasks = new TaskBoard(opts.store, opts.cwd, this.human, () => {
      opts.vault.writeTasks(this.tasks.tasks, this.explicitFiles());
      this.changed();
    });
    opts.vault.writeTasks(this.tasks.tasks, this.explicitFiles());
    this.plans = new PlanBoard(opts.store);
    // Wiederkehrende Aufgaben: jede halbe Minute nachsehen, ob etwas dran ist
    this.planTimer = setInterval(() => this.runDuePlans(), 30_000);
    this.planTimer.unref();
  }

  readonly plans: PlanBoard;
  private planTimer: NodeJS.Timeout;

  /** Fällige Zeitpläne ausführen: Nachricht an Team oder Sitzung. */
  runDuePlans(now = Date.now()): Plan[] {
    const due = this.plans.takeDue(now);
    for (const p of due) this.runPlan(p);
    return due;
  }

  runPlan(p: Plan): void {
    const to = p.an === 'team' ? 'team' : this.agents.has(p.an) ? p.an : undefined;
    if (!to) {
      this.system(`Zeitplan #${p.id}: Sitzung „${p.an}“ ist nicht offen – übersprungen.`);
      return;
    }
    this.post(this.human, to, `[Zeitplan] ${p.text}`);
  }

  /** Hinweis an eine Sitzung, der mit ihrer nächsten Post ankommt (startet keine eigene Runde). */
  note(name: string, text: string): void {
    const a = this.agents.get(name);
    if (!a) return;
    a.inbox.push({ id: uid('m'), ts: Date.now(), from: this.human, to: name, text: `Hinweis: ${text}`, mentions: [] });
  }

  noteAll(text: string): void {
    for (const name of this.agents.keys()) this.note(name, text);
  }

  /** Rolle einer Sitzung setzen; laufende Sitzungen erfahren es mit ihrer nächsten Post. */
  setRole(name: string, roleId: string): string {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Sitzung „${name}“ gibt es nicht.`);
    const role = roleById(roleId);
    if (!role) throw new Error(`Rolle „${roleId}“ kenne ich nicht.`);
    a.spec.rolle = role.id;
    this.saveRoster();
    this.note(name, role.prompt);
    this.system(`${name} ist jetzt ${role.label}.`);
    this.changed();
    return `${name} ist jetzt ${role.label}.`;
  }

  /** Verlauf durchsuchen (alle Kanäle dieses Projekts), neueste zuerst. */
  search(query: string, limit = 200): Message[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.messages.filter((m) => m.text.toLowerCase().includes(q) || this.label(m.from).toLowerCase().includes(q)).reverse().slice(0, limit);
  }

  /** Nur ausdrücklich reservierte Dateien (ohne die automatischen Sperren laufender Runden). */
  private explicitFiles(): Map<string, string> {
    return new Map([...this.tasks.files].filter(([k]) => !this.tasks.auto.has(k)));
  }

  // ---------- Teilnehmer ----------

  label = (id: string): string => {
    if (id === this.human) return this.humanLabel;
    if (id === 'system') return 'System';
    return id;
  };

  /** Löst einen eingegebenen Namen in eine Teilnehmer-ID auf (oder undefined). */
  resolveId(name: string): string | undefined {
    const n = name.trim().replace(/^@/, '').toLowerCase();
    if (n === this.human || n === this.humanLabel.toLowerCase()) return this.human;
    if (this.agents.has(n)) return n;
    return undefined;
  }

  private isLive(a: AgentRec): boolean {
    return LIVE.includes(a.status);
  }

  liveAgents(): AgentRec[] {
    return [...this.agents.values()].filter((a) => this.isLive(a));
  }

  private uniqueName(base: string): string {
    let clean = base.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'agent';
    if (RESERVED.has(clean) || clean === this.human) clean += '1';
    if (!this.agents.has(clean)) return clean;
    for (let i = 2; ; i++) if (!this.agents.has(`${clean}${i}`)) return `${clean}${i}`;
  }

  async addAgent(spec: AgentSpec): Promise<AgentRec> {
    const name = this.uniqueName(spec.name);
    const full: AgentSpec = { ...spec, name };
    const rec: AgentRec = {
      name,
      spec: full,
      label: kindLabel(full),
      status: 'startet',
      token: randomBytes(18).toString('hex'),
      inbox: [],
      trigger: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, cacheReadTokens: 0, contextTokens: 0 },
      log: [],
      paused: false,
      budgetTokens: Math.max(0, this.opts.config.budget.tokensProSitzung),
      budgetUsd: Math.max(0, this.opts.config.budget.usdProSitzung),
      budgetHit: false,
      since: Date.now(),
      workedMs: 0,
      sentViaTool: new Set(),
    };
    this.agents.set(name, rec);
    this.saveRoster();
    this.syncTeam();
    this.changed();
    try {
      rec.adapter = await this.opts.createAdapter(full, this.makeContext(rec));
      await rec.adapter.start();
      this.system(`${name} (${rec.label}) ist dem Team beigetreten.`);
    } catch (e) {
      this.setStatus(rec, 'fehler', errText(e));
      this.logTo(rec, 'fehler', errText(e));
      this.system(`${name}: Start fehlgeschlagen – ${errText(e)}`);
    }
    return rec;
  }

  async removeAgent(name: string): Promise<void> {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Sitzung „${name}“ gibt es nicht.`);
    for (const ap of this.approvals.filter((x) => x.agent === name)) this.resolveApproval(ap.id, 'nein');
    try {
      await a.adapter?.stop();
    } catch {
      /* egal */
    }
    this.tasks.releaseAllOf(name);
    this.agents.delete(name);
    this.saveRoster();
    this.syncTeam();
    this.system(`${name} hat das Team verlassen.`);
  }

  /** Sitzung umbenennen: Verläufe, Aufgaben und Dateisperren ziehen mit. Gibt den neuen Namen zurück. */
  renameAgent(oldName: string, wanted: string): string {
    const a = this.agents.get(oldName);
    if (!a) throw new Error(`Sitzung „${oldName}“ gibt es nicht.`);
    const clean = wanted.trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    if (!clean) throw new Error('Der Name braucht Buchstaben oder Ziffern (a–z, 0–9, - und _).');
    if (clean === oldName) return clean;
    if (this.agents.has(clean) || RESERVED.has(clean) || clean === this.human) throw new Error(`Den Namen „${clean}“ gibt es schon.`);
    // Reihenfolge der Reiter behalten
    const entries = [...this.agents.entries()];
    this.agents.clear();
    for (const [k, v] of entries) this.agents.set(k === oldName ? clean : k, v);
    a.name = clean;
    a.spec.name = clean;
    for (const m of this.messages) {
      if (m.from === oldName) m.from = clean;
      if (m.to === oldName) m.to = clean;
      m.mentions = m.mentions.map((x) => (x === oldName ? clean : x));
    }
    this.tasks.renameAgent(oldName, clean);
    this.saveRoster();
    this.syncTeam();
    this.system(`${oldName} heißt jetzt ${clean}.`);
    // Die Sitzung erfährt es mit ihrer nächsten Post, ohne dass dafür eine eigene Runde startet.
    this.note(clean, `Du heißt im Team ab jetzt „${clean}“ (vorher ${oldName}).`);
    this.changed();
    return clean;
  }

  /** Modell einer Sitzung wechseln. */
  async setModel(name: string, model: string): Promise<string> {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Sitzung „${name}“ gibt es nicht.`);
    a.spec.model = model.trim() || undefined;
    a.label = kindLabel(a.spec);
    this.saveRoster();
    const res = await a.adapter?.setModel?.(model.trim());
    this.changed();
    return res ?? `${name}: Modell ${model.trim() || 'Standard'} – gilt ab der nächsten Runde.`;
  }

  /** Einen Befehl der Sitzung selbst ausführen (z. B. /compact in Claude Code). */
  async sendCommand(name: string, line: string): Promise<string> {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Sitzung „${name}“ gibt es nicht.`);
    if (!a.adapter?.command) throw new Error(`${name} (${a.label}) hat keine eigenen Befehle. /hilfe zeigt die Befehle von Harnes.`);
    return (await a.adapter.command(line)) ?? `${line} an ${name} geschickt.`;
  }

  private saveRoster(): void {
    this.opts.store.saveJson(
      'roster.json',
      [...this.agents.values()].map((a) => a.spec),
    );
  }

  /** /wieder: die Sitzungen des letzten Laufs erneut öffnen (ohne ihr altes Gespräch). */
  async reopenLast(): Promise<string[]> {
    const opened: string[] = [];
    for (const spec of this.lastRoster) {
      if (this.agents.has(spec.name)) continue;
      const rec = await this.addAgent(spec);
      opened.push(rec.name);
    }
    return opened;
  }

  // ---------- Budget ----------

  private checkBudget(a: AgentRec): void {
    if (a.budgetHit) return;
    const used = a.usage.inputTokens + a.usage.outputTokens;
    const overTokens = a.budgetTokens > 0 && used >= a.budgetTokens;
    const overUsd = a.budgetUsd > 0 && a.usage.costUsd >= a.budgetUsd;
    if (!overTokens && !overUsd) return;
    a.budgetHit = true;
    const what = overTokens ? `${fmtTokens(a.budgetTokens)} Tokens` : `$${a.budgetUsd}`;
    this.system(
      `${a.name} hat das Budget von ${what} erreicht und bekommt keine neuen Nachrichten mehr. Anheben mit /budget ${a.name} <zahl>, aufheben mit /budget ${a.name} aus.`,
    );
    this.emit('attention', { titel: `${a.name}: Budget erreicht`, text: `Das Budget von ${what} ist aufgebraucht.` });
  }

  /** /budget: Token-Grenze einer Sitzung setzen (0 = keine). Wartende Post wird danach zugestellt. */
  setBudget(name: string, tokens: number): void {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Sitzung „${name}“ gibt es nicht.`);
    a.budgetTokens = Math.max(0, Math.floor(tokens));
    if (a.budgetTokens === 0) a.budgetUsd = 0;
    a.budgetHit = false;
    this.checkBudget(a);
    this.changed();
    this.pump(a);
  }

  private syncTeam(): void {
    this.opts.vault.writeTeam(
      [...this.agents.values()].map((a) => ({ name: a.name, label: a.label, model: a.spec.model, status: a.status })),
    );
  }

  private makeContext(rec: AgentRec): AdapterContext {
    const hub = this;
    return {
      get name() {
        return rec.name;
      },
      spec: rec.spec,
      cwd: this.opts.cwd,
      config: this.opts.config,
      humanLabel: this.humanLabel,
      get systemPrompt() {
        return teamPrompt({
          name: rec.name,
          human: hub.humanLabel,
          members: [...hub.agents.values()].map((a) => ({ name: a.name, label: a.label })),
          cwd: hub.opts.cwd,
          vaultDir: hub.opts.vault.root,
          tools: true,
          role: roleById(rec.spec.rolle)?.prompt,
          reposDir: reposDir(),
          repos: listRepos(),
          browser: Boolean(runtimeMcp.browser),
        });
      },
      get hubUrl() {
        return hub.url;
      },
      token: rec.token,
      mcpServerPath: this.opts.mcpServerPath,
      toolDefs: TOOL_DEFS,
      callTool: (name, args) => this.callTool(rec.name, name, args),
      status: (s, detail) => this.setStatus(rec, s, detail),
      log: (kind, text) => this.logTo(rec, kind, text),
      turnDone: (text) => this.turnDone(rec, text),
      finalText: (text) => this.routeFinal(rec, text),
      usage: (u, mode = 'add') => {
        const add = mode === 'add';
        if (u.inputTokens !== undefined) rec.usage.inputTokens = (add ? rec.usage.inputTokens : 0) + u.inputTokens;
        if (u.outputTokens !== undefined) rec.usage.outputTokens = (add ? rec.usage.outputTokens : 0) + u.outputTokens;
        if (u.costUsd !== undefined) rec.usage.costUsd = (add ? rec.usage.costUsd : 0) + u.costUsd;
        if (u.cacheReadTokens !== undefined) rec.usage.cacheReadTokens = (add ? rec.usage.cacheReadTokens : 0) + u.cacheReadTokens;
        if (u.contextTokens !== undefined) rec.usage.contextTokens = u.contextTokens;
        this.checkBudget(rec);
        this.changed();
      },
      requestApproval: (req) => this.requestApproval(rec.name, req),
      cancelApprovals: () => {
        for (const ap of this.approvals.filter((x) => x.agent === rec.name)) this.finishApproval(ap.id, 'timeout');
      },
      takeDelivery: () => this.takeDelivery(rec.name, true),
      hasInbox: () => rec.inbox.length > 0 && !this.paused && !rec.budgetHit,
      fileHolder: (path) => this.tasks.holderOf(path),
      claimFile: (path) => this.tasks.touch(rec.name, path),
      notice: (text) => this.system(text, rec.name),
    };
  }

  agentByToken(token: string): AgentRec | undefined {
    // Vergleich in fester Zeit (verrät nichts über richtige Anfangszeichen)
    const given = Buffer.from(token);
    for (const a of this.agents.values()) {
      const real = Buffer.from(a.token);
      if (given.length === real.length && timingSafeEqual(given, real)) return a;
    }
    return undefined;
  }

  // ---------- Status, Protokoll ----------

  private changed(): void {
    this.emit('change');
  }

  /** Für Teile außerhalb des Hubs (z. B. Guthaben): Oberfläche neu zeichnen */
  notifyChange(): void {
    this.changed();
  }

  /**
   * Leert einen Chat ('team' oder 'agent:<name>') in der Anzeige und im gespeicherten Verlauf.
   * Was die Sitzungen schon gelesen haben, bleibt in ihrem Gedächtnis; das Protokoll im Vault bleibt.
   */
  clearChannel(channel: string): number {
    const keep = this.messages.filter((m) => !this.channelsOf(m).includes(channel));
    const removed = this.messages.length - keep.length;
    this.messages.splice(0, this.messages.length, ...keep);
    this.opts.store.rewriteMessages(keep.filter((m) => !m.system));
    this.changed();
    return removed;
  }

  /** Wie lange die Sitzungen zusammen gearbeitet haben (nur Status „arbeitet“, nicht Start oder Warten). */
  workedMs(now = Date.now()): number {
    let sum = 0;
    for (const a of this.agents.values()) sum += a.workedMs + (a.status === 'arbeitet' ? now - a.since : 0);
    return sum;
  }

  setStatus(a: AgentRec, s: AgentStatus, detail?: string): void {
    if (a.status === s && a.detail === detail) return;
    if (a.status !== s) {
      const now = Date.now();
      if (a.status === 'arbeitet') a.workedMs += now - a.since;
      a.since = now;
    }
    a.status = s;
    a.detail = detail;
    this.changed();
    if (s === 'wartet') this.pump(a);
  }

  logTo(a: AgentRec, kind: LogEntry['kind'], text: string): void {
    if (!text.trim()) return;
    a.log.push({ ts: Date.now(), kind, text });
    if (a.log.length > 400) a.log.splice(0, a.log.length - 400);
    this.changed();
  }

  /** Hinweis des Systems im Teamchat (geht an keinen Agenten); mit `about` auch im Privatchat dieser Sitzung. */
  system(text: string, about?: string): void {
    this.messages.push({ id: uid('s'), ts: Date.now(), from: 'system', to: 'team', text, mentions: [], system: true, ...(about ? { about } : {}) });
    this.changed();
  }

  // ---------- Nachrichten ----------

  mentionsOf(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
      const n = m[1]!.toLowerCase();
      if (n === 'alle' || n === 'all' || n === 'team') {
        for (const a of this.agents.keys()) out.add(a);
        continue;
      }
      const id = this.resolveId(n);
      if (id) out.add(id);
    }
    return [...out];
  }

  /**
   * Nachricht senden. `to` ist 'team' oder ein Teilnehmer.
   * Regeln: Team-Nachrichten des Menschen gehen an alle (oder nur an die Erwähnten),
   * Team-Nachrichten von Agenten nur an die Erwähnten, private nur an den Empfänger.
   */
  post(from: string, to: string, text: string, o: { urgent?: boolean } = {}): Message {
    const body = text.trim();
    if (!body) throw new Error('Leere Nachricht.');
    const toId = to === 'team' ? 'team' : this.resolveId(to);
    if (!toId) throw new Error(`Empfänger „${to}“ gibt es nicht. team_liste zeigt, wer im Team ist.`);
    if (toId === from) throw new Error('Du kannst dir nicht selbst schreiben.');
    const fromHuman = from === this.human;
    const mentions = this.mentionsOf(body).filter((m) => m !== from);
    const msg: Message = { id: uid('m'), ts: Date.now(), from, to: toId, text: body, mentions };
    if (o.urgent) msg.urgent = true;
    this.messages.push(msg);
    this.opts.store.appendMessage(msg);
    this.opts.vault.logMessage(msg, this.label);
    // Jemand schreibt dem Teamleiter privat oder erwähnt ihn: darauf aufmerksam machen.
    if (!fromHuman && (toId === this.human || mentions.includes(this.human))) this.emit('attention', { titel: `${this.label(from)} schreibt dir`, text: truncate(body, 220) });

    let recipients: string[];
    if (toId === 'team') {
      const mentioned = mentions.filter((m) => this.agents.has(m));
      const everyone = [...this.agents.keys()].filter((n) => n !== from);
      recipients = fromHuman ? (mentioned.length ? mentioned : everyone) : mentioned;
    } else {
      recipients = this.agents.has(toId) ? [toId] : [];
    }
    // Getrennte Sitzungen bekommen nur noch Privatnachrichten des Teamleiters.
    const direct = fromHuman && toId !== 'team';
    recipients = recipients.filter((r) => {
      const a = this.agents.get(r)!;
      return this.isLive(a) && (direct || !a.paused);
    });

    if (fromHuman) {
      this.chainCount = 0;
      this.holdNotified = false;
      this.releaseHeld();
    } else if (recipients.length) {
      this.chainCount++;
      if (this.chainCount > this.opts.config.kettenLimit) {
        this.held.push({ msg, recipients });
        if (!this.holdNotified) {
          this.holdNotified = true;
          this.system(
            `‖ Der Austausch zwischen den Agenten ist pausiert (Grenze von ${this.opts.config.kettenLimit} Nachrichten ohne dich erreicht). Schreib etwas oder gib /weiter ein.`,
          );
        }
        this.changed();
        return msg;
      }
    }
    this.enqueue(msg, recipients);
    this.changed();
    return msg;
  }

  private enqueue(msg: Message, recipients: string[]): void {
    for (const r of recipients) {
      const a = this.agents.get(r);
      if (!a || !this.isLive(a)) continue;
      if (msg.urgent) a.inbox.unshift(msg);
      else a.inbox.push(msg);
      if (msg.urgent && (a.status === 'arbeitet' || a.status === 'freigabe')) {
        void this.interrupt(r).catch(() => undefined);
      } else {
        this.pump(a);
      }
    }
  }

  private releaseHeld(): void {
    const held = this.held.splice(0);
    for (const h of held) this.enqueue(h.msg, h.recipients);
  }

  get heldCount(): number {
    return this.held.length;
  }

  /** /weiter: Pause aufheben und angehaltene Nachrichten zustellen. */
  resume(): void {
    this.paused = false;
    this.chainCount = 0;
    this.holdNotified = false;
    this.releaseHeld();
    for (const a of this.agents.values()) this.pump(a);
    this.changed();
  }

  /** /trennen und /verbinden: Eine getrennte Sitzung bekommt keine Team-Nachrichten mehr. */
  setConnected(name: string, connected: boolean): void {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Sitzung „${name}“ gibt es nicht.`);
    a.paused = !connected;
    this.system(connected ? `${name} ist wieder mit dem Team verbunden.` : `${name} ist vom Team getrennt (Privatnachrichten von dir kommen weiter an).`);
  }

  /** /pause: Es wird nichts mehr zugestellt, laufende Runden laufen zu Ende. */
  pause(): void {
    this.paused = true;
    this.changed();
  }

  private pump(a: AgentRec): void {
    if (this.paused || a.budgetHit || !a.inbox.length || a.status !== 'wartet' || !a.adapter) return;
    if (!a.adapter.controlled) {
      a.adapter.nudge?.();
      return;
    }
    const msgs = a.inbox.splice(0);
    a.trigger = msgs;
    const text = formatDelivery(a.name, msgs, this.label, { autoReply: true });
    this.setStatus(a, 'arbeitet');
    this.logTo(a, 'info', `← ${msgs.length} Nachricht(en) zugestellt`);
    Promise.resolve()
      .then(() => a.adapter!.deliver(text, msgs))
      .catch((e) => {
        this.logTo(a, 'fehler', errText(e));
        this.system(`${a.name}: ${errText(e)}`);
        a.trigger = [];
        if (this.isLive(a)) this.setStatus(a, 'wartet');
      });
  }

  /** Wartende Nachrichten abholen (Werkzeug posteingang_lesen und Hooks). */
  takeDelivery(name: string, autoReply = false): string | null {
    const a = this.agents.get(name);
    if (!a || !a.inbox.length || this.paused || a.budgetHit) return null;
    const msgs = a.inbox.splice(0);
    a.trigger.push(...msgs);
    this.logTo(a, 'info', `← ${msgs.length} Nachricht(en) abgeholt`);
    return formatDelivery(a.name, msgs, this.label, { autoReply });
  }

  /** Antworttext einer Runde dorthin zustellen, wo die auslösende Nachricht herkam. */
  private routeFinal(a: AgentRec, finalText: string): void {
    const trig = a.trigger;
    a.trigger = [];
    a.usage.turns++;
    // Runde vorbei: Dateien, die nur automatisch gesperrt waren, sind wieder frei.
    this.tasks.releaseAuto(a.name);
    const text = cleanFinal(finalText);
    if (!trig.length || !text || isNoContribution(text)) {
      a.sentViaTool.clear();
      this.changed();
      return;
    }
    const last = trig[trig.length - 1]!;
    const target = last.to === 'team' ? 'team' : last.from;
    const already = a.sentViaTool.has(target);
    a.sentViaTool.clear();
    if (already) {
      // Die Sitzung hat sich in dieser Runde schon per Werkzeug dorthin gemeldet: nicht doppelt zustellen.
      this.logTo(a, 'info', 'Schlussantwort nicht zugestellt (schon per Werkzeug gemeldet)');
      this.changed();
      return;
    }
    try {
      this.post(a.name, target, text);
    } catch (e) {
      this.logTo(a, 'fehler', `Antwort nicht zustellbar: ${errText(e)}`);
    }
  }

  private turnDone(a: AgentRec, finalText: string): void {
    this.routeFinal(a, finalText);
    if (this.isLive(a)) this.setStatus(a, 'wartet');
  }

  async interrupt(name: string): Promise<void> {
    const a = this.agents.get(name);
    if (!a?.adapter) throw new Error(`Sitzung „${name}“ gibt es nicht.`);
    this.logTo(a, 'info', 'Unterbrechung angefordert');
    for (const ap of this.approvals.filter((x) => x.agent === name)) this.finishApproval(ap.id, 'nein');
    await a.adapter.interrupt();
  }

  // ---------- Freigaben ----------

  /** Freigabe-Modus einer Sitzung: eigener Modus, sonst der Standard aus den Einstellungen */
  modusOf(name: string): FreigabeModus {
    return this.agents.get(name)?.spec.modus ?? this.opts.config.freigabe ?? 'auto';
  }

  /**
   * Freigabe-Modus setzen: für eine Sitzung oder (ohne Namen) als Standard für alle –
   * dann folgen alle Sitzungen dem Standard. Offene Karten, die der neue Modus erlaubt, gehen durch.
   */
  setModus(name: string | undefined, modus: FreigabeModus): string {
    const targets = name ? [this.agents.get(name)] : [...this.agents.values()];
    if (name && !targets[0]) throw new Error(`Sitzung „${name}“ gibt es nicht.`);
    if (!name) this.opts.config.freigabe = modus;
    for (const a of targets) {
      if (!a) continue;
      if (name) a.spec.modus = modus;
      else delete a.spec.modus;
      a.adapter?.setModus?.(this.modusOf(a.name));
    }
    this.saveRoster();
    for (const ap of [...this.approvals]) {
      if (name && ap.agent !== name) continue;
      if (selbstEntscheiden(this.modusOf(ap.agent), ap.art, ap.befehl)) this.finishApproval(ap.id, 'ja');
    }
    this.changed();
    const label = modusLabel(modus);
    return name ? `${name}: Freigaben ${label} (${MODI.find((m) => m.id === modus)?.about}).` : `Alle Sitzungen: Freigaben ${label} (${MODI.find((m) => m.id === modus)?.about}).`;
  }

  requestApproval(
    agent: string,
    req: { title: string; detail: string; allowAlways?: boolean; timeoutMs?: number; art?: AktionsArt; befehl?: string },
  ): Promise<ApprovalDecision | 'timeout'> {
    const a = this.agents.get(agent);
    // Erlaubt der Freigabe-Modus die Aktion, gibt es keine Karte
    const modus = this.modusOf(agent);
    if (selbstEntscheiden(modus, req.art, req.befehl)) {
      if (a) this.logTo(a, 'info', `ohne Nachfrage erlaubt (Freigaben ${modusLabel(modus)}): ${truncate(req.title, 120)}`);
      return Promise.resolve('ja');
    }
    return new Promise((resolve) => {
      const ap: PendingApproval = {
        id: uid('f'),
        agent,
        title: truncate(req.title, 200),
        detail: req.detail.slice(0, 2000),
        allowAlways: req.allowAlways ?? true,
        createdAt: Date.now(),
        resolve,
        art: req.art,
        befehl: req.befehl,
      };
      if (req.timeoutMs) {
        ap.timer = setTimeout(() => this.finishApproval(ap.id, 'timeout'), req.timeoutMs);
        ap.timer.unref?.();
      }
      this.approvals.push(ap);
      if (a && this.isLive(a)) this.setStatus(a, 'freigabe', ap.title);
      this.emit('attention', { titel: `${agent} braucht deine Freigabe`, text: ap.title });
      this.changed();
    });
  }

  resolveApproval(id: string, decision: ApprovalDecision): void {
    this.finishApproval(id, decision);
  }

  private finishApproval(id: string, decision: ApprovalDecision | 'timeout'): void {
    const idx = this.approvals.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const [ap] = this.approvals.splice(idx, 1);
    if (ap!.timer) clearTimeout(ap!.timer);
    const a = this.agents.get(ap!.agent);
    if (a) {
      this.logTo(a, 'info', `Freigabe „${truncate(ap!.title, 60)}“: ${decision}`);
      if (a.status === 'freigabe' && !this.approvals.some((x) => x.agent === a.name)) this.setStatus(a, 'arbeitet');
    }
    ap!.resolve(decision);
    this.changed();
  }

  // ---------- Werkzeuge ----------

  async callTool(agent: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const a = this.agents.get(agent);
    try {
      const text = await runTool(this, agent, name, args ?? {});
      if (a) this.logTo(a, 'tool', `${name} ${truncate(JSON.stringify(args ?? {}), 100)}`);
      return { text, isError: false };
    } catch (e) {
      if (a) this.logTo(a, 'fehler', `${name}: ${errText(e)}`);
      return { text: `Fehler: ${errText(e)}`, isError: true };
    }
  }

  // ---------- Ansichten für die Oberfläche ----------

  /** Kanal einer Nachricht: 'team' oder 'agent:<name>' (bei Agent↔Agent beide). */
  channelsOf(m: Message): string[] {
    if (m.to === 'team') return m.system && m.about ? ['team', `agent:${m.about}`] : ['team'];
    const out: string[] = [];
    for (const p of [m.from, m.to]) if (p !== this.human && p !== 'system') out.push(`agent:${p}`);
    return out;
  }

  channelMessages(channel: string): Message[] {
    return this.messages.filter((m) => this.channelsOf(m).includes(channel));
  }

  totalUsage(): Usage {
    const t: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, cacheReadTokens: 0, contextTokens: 0 };
    for (const a of this.agents.values()) {
      t.inputTokens += a.usage.inputTokens;
      t.outputTokens += a.usage.outputTokens;
      t.costUsd += a.usage.costUsd;
      t.turns += a.usage.turns;
      t.cacheReadTokens += a.usage.cacheReadTokens;
      t.contextTokens += a.usage.contextTokens;
    }
    return t;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.planTimer);
    for (const ap of [...this.approvals]) this.finishApproval(ap.id, 'nein');
    await Promise.allSettled([...this.agents.values()].map((a) => a.adapter?.stop()));
  }
}

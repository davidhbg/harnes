/**
 * Guthaben der angebundenen API-Anbieter. Nur wo der Anbieter es abfragen lässt:
 * DeepSeek (/user/balance), OpenRouter (/credits), Moonshot/Kimi (/v1/users/me/balance).
 * Anthropic und OpenAI bieten mit einem normalen API-Schlüssel keine Abfrage an.
 * Der Schlüssel geht nur an den Anbieter selbst und wird nirgends gespeichert oder protokolliert.
 */
import { getKey, keyEnvFor, type Config } from './config.js';

export interface Balance {
  anbieter: string;
  /** verfügbares Guthaben; undefined, wenn der Anbieter keine Abfrage anbietet oder sie scheiterte */
  betrag?: number;
  waehrung?: string;
  /** Hinweis, z. B. „nicht abrufbar“ oder die Fehlermeldung */
  hinweis?: string;
  zeit: number;
}

const NAMES: Record<string, string> = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', moonshot: 'Kimi', anthropic: 'Claude API', openai: 'OpenAI' };
export const providerLabel = (p: string) => NAMES[p] ?? p;

/** Abfrage-Adresse und Auswertung je Anbieter (über den Namen oder die Adresse erkannt) */
function endpoint(provider: string, baseUrl: string): { url: string; read: (j: any) => { betrag: number; waehrung: string } } | undefined {
  const origin = new URL(baseUrl).origin;
  const host = new URL(baseUrl).hostname;
  if (provider === 'deepseek' || host.endsWith('deepseek.com')) {
    return {
      url: `${origin}/user/balance`,
      read: (j) => {
        const infos: any[] = j?.balance_infos ?? [];
        const info = infos.find((b) => b.currency === 'USD') ?? infos[0];
        if (!info) throw new Error('keine Angabe');
        return { betrag: Number(info.total_balance), waehrung: String(info.currency) };
      },
    };
  }
  if (provider === 'openrouter' || host.endsWith('openrouter.ai')) {
    return {
      url: `${baseUrl.replace(/\/$/, '')}/credits`,
      read: (j) => ({ betrag: Number(j?.data?.total_credits ?? 0) - Number(j?.data?.total_usage ?? 0), waehrung: 'USD' }),
    };
  }
  if (provider === 'moonshot' || host.includes('moonshot')) {
    return { url: `${origin}/v1/users/me/balance`, read: (j) => ({ betrag: Number(j?.data?.available_balance), waehrung: host.endsWith('.cn') ? 'CNY' : 'USD' }) };
  }
  return undefined;
}

/** Fragt das Guthaben eines Anbieters ab (Zeitlimit 8 s). */
export async function fetchBalance(provider: string, baseUrl: string, key: string): Promise<Balance> {
  const ep = endpoint(provider, baseUrl);
  if (!ep) return { anbieter: provider, hinweis: 'Guthaben nicht abrufbar', zeit: Date.now() };
  try {
    const res = await fetch(ep.url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return { anbieter: provider, hinweis: 'Schlüssel abgelehnt', zeit: Date.now() };
    if (!res.ok) return { anbieter: provider, hinweis: `Abfrage ging nicht (${res.status})`, zeit: Date.now() };
    const { betrag, waehrung } = ep.read(await res.json());
    if (!Number.isFinite(betrag)) return { anbieter: provider, hinweis: 'keine Angabe', zeit: Date.now() };
    return { anbieter: provider, betrag, waehrung, zeit: Date.now() };
  } catch (e) {
    return { anbieter: provider, hinweis: e instanceof Error && e.name === 'TimeoutError' ? 'keine Antwort' : 'Abfrage ging nicht', zeit: Date.now() };
  }
}

/** Alle Anbieter mit hinterlegtem Schlüssel (lokale Modelle ohne Schlüssel zählen nicht). */
export function connectedProviders(config: Config): { name: string; baseUrl: string; key: string }[] {
  const out: { name: string; baseUrl: string; key: string }[] = [];
  for (const [name, p] of Object.entries(config.anbieter)) {
    const key = getKey(p.apiKeyEnv);
    if (key) out.push({ name, baseUrl: p.baseUrl, key });
  }
  const claudeKey = getKey(keyEnvFor(config, 'anthropic'));
  if (claudeKey) out.push({ name: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', key: claudeKey });
  return out;
}

/** Hält die Guthaben aktuell (beim Start, alle 5 Minuten und auf Wunsch). */
export class BalanceWatch {
  balances: Balance[] = [];
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private lastAt = 0;
  constructor(
    private config: Config,
    private onChange: () => void,
  ) {}

  start(intervalMs = 5 * 60_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Neu abfragen; ohne `force` höchstens alle 30 Sekunden */
  refresh(force = true): Promise<void> {
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastAt < 30_000) return Promise.resolve();
    this.lastAt = Date.now();
    this.running = (async () => {
      const list = connectedProviders(this.config);
      this.balances = await Promise.all(list.map((p) => fetchBalance(p.name, p.baseUrl, p.key)));
      this.onChange();
    })().finally(() => (this.running = undefined));
    return this.running;
  }
}

export function fmtMoney(b: Balance): string {
  if (b.betrag === undefined) return b.hinweis ?? '–';
  const n = b.betrag.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return b.waehrung === 'USD' ? `${n} $` : b.waehrung === 'CNY' ? `${n} ¥` : `${n} ${b.waehrung ?? ''}`.trim();
}

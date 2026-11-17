/** Zustand der Oberfläche. Lebt außerhalb von React, damit er das Durchschalten in ein Terminal übersteht. */
export interface UiState {
  /** 'team' | 'aufgaben' | 'verbrauch' | 'agent:<name>' | 'hilfe' */
  channel: string;
  /** Bei Sitzungen: Arbeitsprotokoll statt Privatchat zeigen */
  logView: boolean;
  draft: string;
  cursor: number;
  history: string[];
  histIdx: number;
  /** Zeilen, die je Kanal nach oben geblättert sind (0 = ganz unten) */
  scroll: Record<string, number>;
  /** Anzahl gesehener Nachrichten je Kanal */
  seen: Record<string, number>;
  notice: string;
  approvalsDeferred: boolean;
  lastCtrlC: number;
  /** offenes Menü (Esc) */
  menu?: Menu;
  /** Wunsch eines Befehls, ein Menü zu öffnen: 'haupt' | 'modell' | 'umbenennen' */
  openMenu?: string;
  /** Strg+R: Suche in früheren Eingaben (idx = Treffer, -1 = keiner) */
  histSearch?: { q: string; idx: number };
  /** letzte Suche im Verlauf */
  search?: string;
  /** gewählter Vorschlag beim Tippen von „/“ */
  suggestIdx: number;
}

export interface MenuItem {
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/** Ein Menü ist eine Liste zum Auswählen oder ein Eingabefeld. */
export type Menu =
  | { kind: 'liste'; title: string; items: MenuItem[]; cursor: number; back?: () => Menu | undefined; typed?: string; typedAt?: number }
  | { kind: 'eingabe'; title: string; label: string; value: string; secret?: boolean; submit: (value: string) => void | Promise<void>; back?: () => Menu | undefined }

export function createUiState(): UiState {
  return {
    channel: 'team',
    logView: false,
    draft: '',
    cursor: 0,
    history: [],
    histIdx: -1,
    scroll: {},
    seen: {},
    notice: '',
    approvalsDeferred: false,
    lastCtrlC: 0,
    suggestIdx: 0,
  };
}

export type UiAction = { type: 'quit' } | { type: 'attach'; agent: string } | { type: 'konten' } | { type: 'einrichtung' } | { type: 'home'; view?: 'projekte' } | { type: 'projekt'; cwd: string };

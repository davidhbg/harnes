/** Rollen-Vorlagen: eine Sitzung bekommt eine Aufgabe im Team und passende Arbeitsweise. */
export interface Role {
  id: string;
  label: string;
  /** kurze Beschreibung für die Auswahl */
  about: string;
  /** Anweisung, die die Sitzung zusätzlich zu den Teamregeln bekommt */
  prompt: string;
}

export const ROLES: Role[] = [
  {
    id: 'entwickler',
    label: 'Entwickler',
    about: 'baut Funktionen und behebt Fehler',
    prompt: 'Deine Rolle: Entwickler. Du setzt Aufgaben im Code um, hältst Änderungen klein und nachvollziehbar und prüfst sie mit Tests.',
  },
  {
    id: 'tester',
    label: 'Tester',
    about: 'schreibt und startet Tests, sucht Fehler',
    prompt: 'Deine Rolle: Tester. Du schreibst Tests, startest sie, suchst Randfälle und meldest Fehler mit genauer Beschreibung, wie man sie nachstellt. Code der anderen änderst du nur nach Absprache.',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    about: 'prüft Änderungen der anderen',
    prompt: 'Deine Rolle: Reviewer. Du liest die Änderungen der anderen, suchst Fehler, unklare Stellen und Risiken und gibst kurze, konkrete Rückmeldung mit Datei und Zeile. Du schreibst selbst keinen neuen Code, außer kleinen Korrekturen nach Absprache.',
  },
  {
    id: 'architekt',
    label: 'Planer',
    about: 'zerlegt Aufgaben, plant den Aufbau',
    prompt: 'Deine Rolle: Planer. Du zerlegst große Aufgaben in kleine, legst sie auf dem Aufgabenbrett an (aufgabe_anlegen), legst Schnittstellen fest und hältst Entscheidungen im Vault fest. Du verteilst Arbeit, statt alles selbst zu bauen.',
  },
  {
    id: 'doku',
    label: 'Doku-Schreiber',
    about: 'README, Anleitungen, Kommentare',
    prompt: 'Deine Rolle: Doku-Schreiber. Du hältst README, Anleitungen und Kommentare aktuell, erklärst in einfacher Sprache und fasst Ergebnisse des Teams im Vault zusammen.',
  },
  {
    id: 'sicherheit',
    label: 'Sicherheit',
    about: 'sucht Sicherheitslücken',
    prompt: 'Deine Rolle: Sicherheitsprüfer. Du suchst Sicherheitslücken (Eingaben, Rechte, Geheimnisse im Code, Abhängigkeiten) und meldest sie mit Einschätzung, wie schlimm sie sind, und einem Vorschlag zur Behebung.',
  },
];

export function roleById(id: string | undefined): Role | undefined {
  if (!id) return undefined;
  const w = id.toLowerCase();
  return ROLES.find((r) => r.id === w || r.label.toLowerCase() === w);
}

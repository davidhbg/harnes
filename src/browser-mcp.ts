#!/usr/bin/env node
/**
 * MCP-Server „browser“: gibt den KI-Sitzungen den HarnesBrowser in die Hand.
 * Läuft als eigener Prozess je Sitzung und reicht die Aufrufe an die Steuerschnittstelle
 * des Browsers weiter (127.0.0.1, Adresse und Schlüssel aus RH_BROWSER_URL / RH_BROWSER_TOKEN).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const URL_ = process.env.RH_BROWSER_URL ?? '';
const TOKEN = process.env.RH_BROWSER_TOKEN ?? '';

type Props = Record<string, { type: string; description: string }>;
const tool = (name: string, description: string, properties: Props = {}, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object' as const, properties, required },
});
const s = (description: string) => ({ type: 'string', description });
const n = (description: string) => ({ type: 'number', description });
const b = (description: string) => ({ type: 'boolean', description });

const ZIEL: Props = {
  ref: s('Kennung aus browser_lesen, z. B. „e12“ (am zuverlässigsten)'),
  text: s('alternativ: sichtbarer Text des Elements, z. B. „Anmelden“'),
  x: n('alternativ: x im Seitenfenster (Pixel)'),
  y: n('alternativ: y im Seitenfenster (Pixel)'),
};

export const BROWSER_TOOLS = [
  tool(
    'browser_lesen',
    'Liest die aktuelle Seite des HarnesBrowsers: Adresse, Überschriften und alle Bedienelemente mit Kennungen (e1, e2 …) für klicken/tippen. Immer zuerst aufrufen. Nach jeder Aktion kommt die neue Übersicht automatisch mit.',
    { text: b('auch den ganzen Seitentext liefern'), alles: b('mehr Elemente (bis 600)'), suche: s('nur Elemente, deren Name diesen Text enthält'), tab: n('Tab-Nummer (sonst der aktive)') },
  ),
  tool('browser_oeffnen', 'Öffnet eine Adresse oder Suche im Browser (der Mensch sieht mit).', { url: s('Adresse oder Suchbegriff'), neuer_tab: b('in neuem Tab öffnen') }, ['url']),
  tool('browser_klicken', 'Klickt auf ein Element. Der Mensch sieht den Zeiger der KI dorthin fliegen.', { ...ZIEL, doppelt: b('Doppelklick'), rechts: b('Rechtsklick') }),
  tool(
    'browser_tippen',
    'Tippt Text in ein Feld (klickt es vorher an und leert es). Ohne ref/text: in das Feld mit Fokus.',
    { ...ZIEL, eingabe: s('der Text'), enter: b('danach Enter drücken'), leeren: b('Feld vorher leeren (Standard: ja)') },
    ['eingabe'],
  ),
  tool('browser_taste', 'Drückt eine Taste oder Kombination: Enter, Tab, Escape, ArrowDown, PageDown, Strg+A …', { taste: s('z. B. „Enter“ oder „Strg+A“') }, ['taste']),
  tool('browser_waehlen', 'Wählt eine Option in einem Auswahlfeld.', { ref: s('Kennung des Auswahlfelds'), wert: s('Text oder Wert der Option') }, ['ref', 'wert']),
  tool('browser_scrollen', 'Scrollt die Seite (runter, hoch, oben, unten) oder zu einem Element.', { richtung: s('runter | hoch | oben | unten'), ref: s('zu diesem Element scrollen') }),
  tool('browser_warten', 'Wartet, bis ein Text auf der Seite steht, oder eine feste Zeit.', { text: s('auf diesen Text warten'), ms: n('höchstens so lange (Millisekunden, bis 30000)') }),
  tool('browser_bild', 'Bildschirmfoto der aktuellen Seite (wenn die Übersicht nicht reicht, z. B. bei Grafiken).', { tab: n('Tab-Nummer') }),
  {
    name: 'browser_schritte',
    description:
      'Mehrere Aktionen in einem Zug (spart Runden), z. B. Formular ausfüllen und absenden. Jeder Schritt: { aktion: klicken|tippen|taste|waehlen|scrollen|warten|oeffnen|zeigen, …Angaben wie beim einzelnen Werkzeug }. Bricht beim ersten Fehler ab und liefert danach die neue Übersicht.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        schritte: {
          type: 'array',
          description: 'z. B. [{"aktion":"tippen","ref":"e3","eingabe":"Max"},{"aktion":"klicken","text":"Weiter"}]',
          items: { type: 'object' },
        },
      },
      required: ['schritte'],
    },
  },
  tool('browser_tabs', 'Listet die offenen Tabs.'),
  tool('browser_tab_wechseln', 'Wechselt zu einem Tab.', { tab: n('Tab-Nummer') }, ['tab']),
  tool('browser_tab_schliessen', 'Schließt einen Tab.', { tab: n('Tab-Nummer (sonst der aktive)') }),
  tool('browser_zurueck', 'Eine Seite zurück.'),
  tool('browser_js', 'Führt JavaScript in der Seite aus und gibt das Ergebnis zurück (nur wenn die anderen Werkzeuge nicht reichen).', { code: s('JavaScript-Ausdruck') }, ['code']),
  tool(
    'browser_zeigen',
    'Zeigt dem Menschen eine Stelle auf der Webseite: Der Zeiger fliegt hin, das Element wird markiert, daneben erscheint deine Erklärung (wird auch vorgelesen). Für Erklärungen „wo ist was“.',
    { ...ZIEL, erklaerung: s('kurzer Satz, was dort ist oder was zu tun ist') },
    ['erklaerung'],
  ),
  tool(
    'bildschirm_foto',
    'Bildschirmfoto des ganzen Bildschirms (auch außerhalb des Browsers). Koordinaten für bildschirm_zeigen beziehen sich auf dieses Bild.',
  ),
  tool(
    'bildschirm_zeigen',
    'Zeigt auf eine Stelle des ganzen Bildschirms: Der Zeiger der KI fliegt hin und zeigt deine Erklärung an (wird vorgelesen). Mehrere Aufrufe hintereinander zeigen Schritt für Schritt. Koordinaten im zuletzt aufgenommenen Bildschirmfoto.',
    { x: n('x im Bildschirmfoto'), y: n('y im Bildschirmfoto'), erklaerung: s('kurzer Satz zu dieser Stelle') },
    ['x', 'y', 'erklaerung'],
  ),
];

async function call(name: string, args: Record<string, unknown>) {
  const short = name.replace(/^browser_/, '');
  const res = await fetch(`${URL_}/werkzeug`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name: short, args }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json()) as { text?: string; image?: string; error?: string };
  if (data.error) return { content: [{ type: 'text' as const, text: `Fehler: ${data.error}` }], isError: true };
  const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
  if (data.image) content.push({ type: 'image', data: data.image, mimeType: 'image/png' });
  if (data.text) content.push({ type: 'text', text: data.text });
  return { content };
}

async function main(): Promise<void> {
  const server = new Server({ name: 'browser', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BROWSER_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Der HarnesBrowser antwortet nicht (${e instanceof Error ? e.message : String(e)}). Ist er noch offen?` }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

if (URL_) void main();

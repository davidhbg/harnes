import type { ToolDef } from '../types.js';
import type { Hub } from './hub.js';

const str = (description: string) => ({ type: 'string', description });

/** Die Team-Werkzeuge, die jede Sitzung bekommt (über MCP oder direkt). */
export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'team_senden',
    description:
      'Schreibt in den Teamchat. Andere Agenten erhalten die Nachricht nur, wenn sie mit @name erwähnt sind (im Text oder über „an“). @alle erreicht alle.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('Die Nachricht, kurz und sachlich'),
        an: { type: 'array', items: { type: 'string' }, description: 'Optional: Namen, die erwähnt werden sollen' },
      },
      required: ['text'],
    },
  },
  {
    name: 'privat_senden',
    description: 'Schickt eine Privatnachricht an eine Person im Team (Teamleiter oder anderer Agent).',
    inputSchema: {
      type: 'object',
      properties: { an: str('Name des Empfängers'), text: str('Die Nachricht') },
      required: ['an', 'text'],
    },
  },
  {
    name: 'posteingang_lesen',
    description: 'Holt neue Nachrichten ab, die während deiner Arbeit eingegangen sind.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'team_liste',
    description: 'Zeigt, wer im Team ist, mit Art, Status und aktueller Aufgabe.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'aufgaben_liste',
    description: 'Zeigt das Aufgabenbrett und alle reservierten Dateien.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'aufgabe_anlegen',
    description: 'Legt eine neue Aufgabe auf dem Brett an (z. B. um eine große Aufgabe aufzuteilen).',
    inputSchema: {
      type: 'object',
      properties: { titel: str('Kurzer Titel'), beschreibung: str('Optional: Details') },
      required: ['titel'],
    },
  },
  {
    name: 'aufgabe_reservieren',
    description: 'Reserviert eine Aufgabe für dich. Schlägt fehl, wenn sie schon jemand anderes hat.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'Nummer der Aufgabe' } }, required: ['id'] },
  },
  {
    name: 'aufgabe_status',
    description:
      'Setzt den Status einer Aufgabe: offen, reserviert, in_arbeit, erledigt, blockiert. Bei „erledigt“ einen Nachweis angeben (Datei, Commit, Testergebnis).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Nummer der Aufgabe' },
        status: { type: 'string', enum: ['offen', 'reserviert', 'in_arbeit', 'erledigt', 'blockiert'] },
        nachweis: str('Optional: Nachweis oder Grund'),
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'datei_reservieren',
    description: 'Reserviert eine Datei, bevor du sie bearbeitest. Meldet, wenn sie jemand anderes reserviert hat.',
    inputSchema: { type: 'object', properties: { pfad: str('Pfad der Datei (relativ zum Projektordner oder absolut)') }, required: ['pfad'] },
  },
  {
    name: 'datei_freigeben',
    description: 'Gibt eine von dir reservierte Datei wieder frei.',
    inputSchema: { type: 'object', properties: { pfad: str('Pfad der Datei') }, required: ['pfad'] },
  },
  {
    name: 'vault_liste',
    description: 'Listet alle Notizen im gemeinsamen Team-Vault (Obsidian).',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'vault_lesen',
    description: 'Liest eine Notiz aus dem Team-Vault, z. B. „Aufgaben.md“ oder „Chat/2026-11-13 Team.md“.',
    inputSchema: { type: 'object', properties: { pfad: str('Pfad relativ zum Team-Vault') }, required: ['pfad'] },
    readOnly: true,
  },
  {
    name: 'vault_suchen',
    description: 'Durchsucht alle Notizen im Team-Vault nach einem Begriff.',
    inputSchema: { type: 'object', properties: { begriff: str('Suchbegriff') }, required: ['begriff'] },
    readOnly: true,
  },
  {
    name: 'vault_notiz',
    description: 'Hängt einen Eintrag an deine eigene Arbeitsnotiz im Vault an (Agenten/<dein Name>.md).',
    inputSchema: { type: 'object', properties: { text: str('Der Eintrag') }, required: ['text'] },
  },
  {
    name: 'wissen_schreiben',
    description: 'Legt eine Wissens-Notiz für alle an (Wissen/<Titel>.md). Gibt es den Titel schon, wird ergänzt.',
    inputSchema: {
      type: 'object',
      properties: { titel: str('Titel der Notiz'), text: str('Inhalt in Markdown') },
      required: ['titel', 'text'],
    },
  },
  {
    name: 'entscheidung_festhalten',
    description: 'Hält eine Absprache oder Entscheidung des Teams dauerhaft fest (Entscheidungen.md).',
    inputSchema: { type: 'object', properties: { text: str('Die Entscheidung in einem Satz') }, required: ['text'] },
  },
];

function need(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v === undefined || v === null || String(v).trim() === '') throw new Error(`Angabe „${key}“ fehlt.`);
  return String(v);
}

function num(args: Record<string, unknown>, key: string): number {
  const n = Number(String(args[key] ?? '').replace('#', ''));
  if (!Number.isInteger(n)) throw new Error(`„${key}“ muss eine Aufgabennummer sein.`);
  return n;
}

export async function runTool(hub: Hub, agent: string, name: string, args: Record<string, unknown>): Promise<string> {
  const vault = hub.opts.vault;
  switch (name) {
    case 'team_senden': {
      let text = need(args, 'text');
      const an = Array.isArray(args.an) ? (args.an as unknown[]).map(String) : [];
      const missing = an
        .map((n) => n.replace(/^@/, '').toLowerCase())
        .filter((n) => n && !new RegExp(`@${n}\\b`, 'i').test(text));
      if (missing.length) text = missing.map((n) => `@${n}`).join(' ') + ' ' + text;
      const msg = hub.post(agent, 'team', text);
      hub.agents.get(agent)?.sentViaTool.add('team');
      for (const m of msg.mentions) hub.agents.get(agent)?.sentViaTool.add(m);
      const reached = msg.mentions.filter((m) => hub.agents.has(m));
      return reached.length
        ? `Im Teamchat gesendet. Zugestellt an: ${reached.join(', ')}.`
        : 'Im Teamchat gesendet (für alle sichtbar, niemand erwähnt).';
    }
    case 'privat_senden': {
      const to = need(args, 'an');
      const msg = hub.post(agent, to, need(args, 'text'));
      hub.agents.get(agent)?.sentViaTool.add(msg.to);
      return `Privat an ${to} gesendet.`;
    }
    case 'posteingang_lesen':
      return hub.takeDelivery(agent, true) ?? 'Keine neuen Nachrichten.';
    case 'team_liste': {
      const lines = [`Teamleiter: ${hub.humanLabel} (Mensch)`];
      for (const a of hub.agents.values()) {
        const task = hub.tasks.tasks.find((t) => t.owner === a.name && t.status !== 'erledigt');
        const me = a.name === agent ? ' ← das bist du' : '';
        lines.push(`- ${a.name} (${a.label}), Status: ${a.paused ? 'getrennt' : a.status}${task ? `, Aufgabe #${task.id} ${task.title}` : ''}${me}`);
      }
      return lines.join('\n');
    }
    case 'aufgaben_liste':
      return hub.tasks.listText();
    case 'aufgabe_anlegen': {
      const t = hub.tasks.add(agent, need(args, 'titel'), args.beschreibung ? String(args.beschreibung) : undefined);
      return `Aufgabe #${t.id} angelegt: ${t.title}`;
    }
    case 'aufgabe_reservieren': {
      const t = hub.tasks.claim(agent, num(args, 'id'));
      return `Aufgabe #${t.id} ist jetzt für dich reserviert: ${t.title}`;
    }
    case 'aufgabe_status': {
      const t = hub.tasks.setStatus(agent, num(args, 'id'), need(args, 'status'), args.nachweis ? String(args.nachweis) : undefined);
      const hint = t.status === 'erledigt' && !t.proof ? ' Bitte noch einen Nachweis nachtragen.' : '';
      return `Aufgabe #${t.id} steht jetzt auf „${t.status}“.${hint}`;
    }
    case 'datei_reservieren': {
      const path = need(args, 'pfad');
      const r = hub.tasks.reserveFile(agent, path);
      return r.ok
        ? `Datei reserviert: ${path}`
        : `Die Datei ist bereits von ${r.holder} reserviert. Nicht bearbeiten – sprich dich mit @${r.holder} ab.`;
    }
    case 'datei_freigeben': {
      const path = need(args, 'pfad');
      return hub.tasks.releaseFile(agent, path) ? `Datei freigegeben: ${path}` : 'Die Datei war nicht reserviert.';
    }
    case 'vault_liste': {
      const list = vault.list();
      return list.length ? list.join('\n') : 'Der Vault ist noch leer.';
    }
    case 'vault_lesen':
      return vault.read(need(args, 'pfad'));
    case 'vault_suchen':
      return vault.search(need(args, 'begriff'));
    case 'vault_notiz':
      return `Notiert in ${vault.appendAgentNote(agent, need(args, 'text'))}`;
    case 'wissen_schreiben':
      return `Gespeichert in ${vault.writeKnowledge(agent, need(args, 'titel'), need(args, 'text'))}`;
    case 'entscheidung_festhalten':
      vault.appendDecision(hub.label(agent), need(args, 'text'));
      return 'Entscheidung festgehalten (Entscheidungen.md).';
    default:
      throw new Error(`Werkzeug „${name}“ gibt es nicht.`);
  }
}

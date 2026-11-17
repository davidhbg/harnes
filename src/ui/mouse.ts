import { EventEmitter } from 'node:events';
import { useStdin } from 'ink';
import { useEffect, useRef } from 'react';

/**
 * Maus im Terminal („Mouse Reporting“): Das Terminal meldet Klicks und das Mausrad als
 * Steuerzeichen (SGR-Format, z. B. ESC [ < 0 ; 12 ; 5 M). Windows Terminal, iTerm2 und die
 * meisten modernen Terminals können das. Solange es an ist, markiert man Text mit gedrückter
 * Umschalttaste. Abschalten mit /maus aus.
 */

export interface MouseEvent {
  kind: 'press' | 'release' | 'wheelUp' | 'wheelDown' | 'drag';
  /** 0 links, 1 Mitte, 2 rechts */
  button: number;
  /** Spalte und Zeile, bei 0 beginnend */
  x: number;
  y: number;
}

const SGR = /\u001b?\[<(\d+);(\d+);(\d+)([Mm])/g;
const ON = '\u001b[?1000h\u001b[?1006h';
const OFF = '\u001b[?1000l\u001b[?1006l';

let enabled = !process.env.RH_NO_MOUSE;
let exitHook = false;

export function mouseEnabled(): boolean {
  return enabled;
}

export function setMouseEnabled(on: boolean): void {
  enabled = on;
  if (!process.stdout.isTTY) return;
  process.stdout.write(on ? ON : OFF);
}

export function parseMouse(data: string): MouseEvent[] {
  const out: MouseEvent[] = [];
  for (const m of data.matchAll(SGR)) {
    const code = Number(m[1]);
    const x = Number(m[2]) - 1;
    const y = Number(m[3]) - 1;
    const button = code & 3;
    if (code & 64) out.push({ kind: button === 0 ? 'wheelUp' : 'wheelDown', button, x, y });
    else if (code & 32) out.push({ kind: 'drag', button, x, y });
    else out.push({ kind: m[4] === 'M' ? 'press' : 'release', button, x, y });
  }
  return out;
}

/** true, wenn eine Eingabe eine Maus-Meldung ist – dann nicht als getippten Text behandeln. */
export function mouseEvents(input: string): boolean {
  return /\[<\d+;\d+;\d+[Mm]/.test(input) || /^<\d+;\d+;\d+[Mm]/.test(input);
}

/** Hier landen Maus-Meldungen aus dem eigenen Eingabestrom (ui/wininput.ts). */
const bus = new EventEmitter();

/**
 * Nimmt Maus-Meldungen aus einem Stück Eingabe heraus, meldet sie und gibt den Rest zurück.
 * Ink würde sie sonst verschlucken oder als Text sehen.
 */
export function feedMouse(data: string): string {
  if (!data.includes('[<')) return data;
  const events = parseMouse(data);
  if (!events.length) return data;
  if (enabled) for (const e of events) bus.emit('mouse', e);
  return data.replace(SGR, '');
}

/** Maus-Meldungen empfangen, solange die Komponente angezeigt wird. */
export function useMouse(handler: (e: MouseEvent) => void): void {
  const ctx = useStdin() as unknown as { internal_eventEmitter?: EventEmitter };
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    if (enabled) process.stdout.write(ON);
    if (!exitHook) {
      exitHook = true;
      process.on('exit', () => process.stdout.write(OFF));
    }
    const onEvent = (e: MouseEvent) => ref.current(e);
    // ohne eigenen Eingabestrom: was Ink selbst durchreicht
    const onData = (data: string | Buffer) => {
      if (enabled) for (const e of parseMouse(String(data))) ref.current(e);
    };
    bus.on('mouse', onEvent);
    ctx.internal_eventEmitter?.on('input', onData);
    return () => {
      bus.off('mouse', onEvent);
      ctx.internal_eventEmitter?.off('input', onData);
      process.stdout.write(OFF);
    };
  }, []);
}

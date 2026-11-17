import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { feedMouse } from './mouse.js';

const dbg = (t: string) => {
  if (process.env.RH_MAUS_LOG) appendFileSync(process.env.RH_MAUS_LOG, `[eingabe] ${t}
`);
};

/**
 * Tastatur und Maus unter Windows.
 *
 * Windows meldet Mausklicks als eigene Konsolen-Ereignisse; Node liest nur Tasten und wirft
 * diese Ereignisse weg. Deshalb liest unter Windows ein kleines Hilfsprogramm (C#, von PowerShell
 * übersetzt, nichts zu installieren) die Konsole selbst: Tasten kommen als Zeichen durch,
 * Klicks und Mausrad als Maus-Meldungen im SGR-Format, wie sie andere Terminals schicken.
 * Für Anmeldung und F12 (fremdes Programm braucht die Tastatur) wird es angehalten.
 */

const HELPER = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RHEingabe {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool ReadConsoleInputW(IntPtr h, [Out] Rec[] buf, uint len, out uint read);

  [StructLayout(LayoutKind.Explicit, Size = 20)]
  public struct Rec {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(4)] public int KeyDown;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort Vk;
    [FieldOffset(14)] public char Ch;
    [FieldOffset(4)] public short X;
    [FieldOffset(6)] public short Y;
    [FieldOffset(8)] public uint Buttons;
    [FieldOffset(16)] public uint Flags;
  }

  [StructLayout(LayoutKind.Explicit, Size = 22)]
  public struct BufInfo {
    [FieldOffset(10)] public short Left;
    [FieldOffset(12)] public short Top;
  }
  [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out BufInfo info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  // Windows zählt Mauspositionen ab Pufferanfang; das Terminal will sie ab dem sichtbaren Ausschnitt.
  static void Origin(out int left, out int top) {
    left = 0; top = 0;
    IntPtr o = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    BufInfo bi;
    if (GetConsoleScreenBufferInfo(o, out bi)) { left = bi.Left; top = bi.Top; }
    CloseHandle(o);
  }

  static volatile bool paused = false;

  public static void Main() { Run(); }

  public static void Run() {
    IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    uint orig;
    GetConsoleMode(h, out orig);
    // VT-Eingabe, Maus, erweiterte Flags (Schnellbearbeitung aus), Fenstergröße; ohne Zeilen-, Echo- und Strg+C-Verarbeitung
    uint mode = 0x200 | 0x10 | 0x80 | 0x8;
    SetConsoleMode(h, mode);
    Stream outp = Console.OpenStandardOutput();
    outp.WriteByte(0); outp.Flush(); // Zeichen „bereit“
    Thread ctl = new Thread(() => {
      string l;
      while ((l = Console.In.ReadLine()) != null) {
        if (l == "p") { paused = true; SetConsoleMode(h, orig); }
        else if (l == "r") { SetConsoleMode(h, mode); paused = false; }
        else if (l == "q") break;
      }
      SetConsoleMode(h, orig);
      Environment.Exit(0);
    });
    ctl.IsBackground = true;
    ctl.Start();
    Rec[] buf = new Rec[64];
    uint last = 0;
    StringBuilder sb = new StringBuilder();
    while (true) {
      if (paused) { Thread.Sleep(30); continue; }
      if (WaitForSingleObject(h, 100) != 0) continue;
      if (paused) continue;
      uint n;
      if (!ReadConsoleInputW(h, buf, 64, out n)) { Thread.Sleep(50); continue; }
      sb.Clear();
      for (int i = 0; i < n; i++) {
        Rec r = buf[i];
        if (r.Type == 1) {
          // Umschalt+Enter: als Alt+Enter weitergeben (ESC + Enter), das verstehen alle als „neue Zeile“
          if (r.KeyDown != 0 && r.Vk == 0x0D && (r.Flags & 0x10) != 0) sb.Append("\\u001b\\r");
          else if (r.KeyDown != 0 && r.Ch != (char)0) for (int j = 0; j < Math.Max(1, (int)r.Repeat); j++) sb.Append(r.Ch);
        } else if (r.Type == 4) {
          sb.Append("\\u0000R"); // Fenstergröße geändert
        } else if (r.Type == 2) {
          int ol, ot;
          Origin(out ol, out ot);
          int x = r.X - ol + 1, y = r.Y - ot + 1;
          if ((r.Flags & 4) != 0) {
            sb.Append("\\u001b[<" + (((int)r.Buttons) > 0 ? 64 : 65) + ";" + x + ";" + y + "M");
          } else if ((r.Flags & 1) == 0) {
            bool down = (r.Buttons & 1) != 0, was = (last & 1) != 0;
            if (down && !was) sb.Append("\\u001b[<0;" + x + ";" + y + "M");
            else if (!down && was) sb.Append("\\u001b[<0;" + x + ";" + y + "m");
            last = r.Buttons;
          } else last = r.Buttons;
        }
      }
      if (sb.Length > 0) { byte[] b = Encoding.UTF8.GetBytes(sb.ToString()); outp.Write(b, 0, b.Length); outp.Flush(); }
    }
  }
}
`;

let child: ChildProcess | undefined;
let stream: PassThrough | undefined;
/** angehalten: Eingaben gehören gerade einem anderen Programm (Anmeldung, F12) */
let paused = false;

/** Eingabe anhalten (für Anmeldung und F12) bzw. weiterlaufen lassen. */
export function pauseInput(): void {
  paused = true;
  child?.stdin?.write('p\n');
}
export function resumeInput(): void {
  paused = false;
  child?.stdin?.write('r\n');
  if (direct) {
    // die Anmeldung hat process.stdin angehalten
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
}
/** liest selbst von process.stdin (ohne Hilfsprogramm) */
let direct = false;

/** Das Hilfsprogramm wird einmal übersetzt und liegt dann hier (Name enthält eine Prüfsumme des Quelltexts). */
function helperExe(): string {
  const hash = createHash('sha1').update(HELPER).digest('hex').slice(0, 10);
  return join(process.env.LOCALAPPDATA || tmpdir(), 'RemoteHarnes', `rh-eingabe-${hash}.exe`);
}

/** Übersetzt das Hilfsprogramm mit dem C#-Übersetzer, der in Windows steckt (.NET Framework). */
function compileHelper(exe: string): Promise<boolean> {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const csc = [join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((p) => existsSync(p));
  if (!csc) return Promise.resolve(false);
  mkdirSync(dirname(exe), { recursive: true });
  // Erst unter einem eigenen Namen bauen, dann umbenennen: so stört sich ein zweiter Start nicht daran
  const tmp = `${exe}.${process.pid}`;
  const src = `${tmp}.cs`;
  writeFileSync(src, HELPER, 'utf8');
  return new Promise((done) => {
    const c = spawn(csc, ['/nologo', '/target:exe', '/optimize', `/out:${tmp}.exe`, src], { stdio: 'ignore', windowsHide: true });
    c.on('error', () => done(false));
    c.on('exit', (code) => {
      try {
        rmSync(src, { force: true });
        if (code === 0 && !existsSync(exe)) renameSync(`${tmp}.exe`, exe);
        else rmSync(`${tmp}.exe`, { force: true });
      } catch {
        /* ein anderer Start war schneller */
      }
      done(existsSync(exe));
    });
  });
}

/**
 * Eigener Eingabestrom für Ink. Maus-Meldungen werden hier herausgenommen und an die
 * Oberfläche gemeldet (Ink würde sie sonst verschlucken); alles andere geht an Ink.
 * Unter Windows liest das Hilfsprogramm die Konsole, sonst process.stdin.
 * Ohne Terminal (oder mit RH_NO_MOUSE) undefined: dann liest Ink wie gewohnt process.stdin.
 */
export function terminalInput(): NodeJS.ReadStream | undefined {
  if (process.env.RH_NO_MOUSE || !process.stdin.isTTY) return undefined;
  if (stream) return stream as unknown as NodeJS.ReadStream;
  const s = new PassThrough();
  stream = s;
  // So sieht der Strom für Ink wie ein Terminal aus
  Object.assign(s, { isTTY: true, isRaw: true, setRawMode: () => s, ref: () => s, unref: () => s });
  const feed = (d: Buffer | string) => {
    let text = String(d);
    if (text.includes('\u0000R')) {
      // Fenstergröße geändert: Node liest die Konsole nicht mehr selbst und merkt es sonst nicht
      text = text.split('\u0000R').join('');
      (process.stdout as unknown as { _refreshSize?: () => void })._refreshSize?.();
    }
    const rest = feedMouse(text);
    if (process.env.RH_MAUS_LOG) dbg('daten ' + JSON.stringify(String(d)));
    if (rest) s.write(rest);
  };

  let ready = false;
  const fallback = () => {
    if (ready) return;
    ready = true;
    child = undefined;
    dbg('liest process.stdin');
    direct = true;
    process.stdin.setRawMode(true);
    process.stdin.on('data', (d) => {
      if (!paused) feed(d);
    });
    process.stdin.resume();
  };
  if (process.platform !== 'win32') {
    fallback();
    return s as unknown as NodeJS.ReadStream;
  }

  const run = (exe: string) => {
    try {
      // Ohne „windowsHide“: sonst bekäme das Hilfsprogramm eine eigene, unsichtbare Konsole
      const c = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
      child = c;
      dbg('gestartet');
      c.stdout!.on('data', (d: Buffer) => {
        if (!ready) {
          ready = true;
          if (d[0] === 0) d = d.subarray(1);
        }
        if (d.length) feed(d);
      });
      c.on('error', (e) => {
        dbg('Fehler ' + String(e));
        fallback();
      });
      c.on('exit', (code) => {
        dbg('beendet ' + code);
        if (!ready) fallback();
        child = undefined;
      });
      if (paused) c.stdin?.write('p\n');
      process.on('exit', () => {
        try {
          c.stdin?.write('q\n');
        } catch {
          /* schon beendet */
        }
      });
    } catch (e) {
      dbg('Fehler ' + String(e));
      fallback();
    }
  };
  // Startet es nicht rechtzeitig, lieber ohne Maus weiter
  setTimeout(() => {
    if (ready) return;
    child?.kill();
    fallback();
  }, 15000).unref();
  const exe = helperExe();
  if (existsSync(exe)) run(exe);
  else
    compileHelper(exe).then((ok) => {
      dbg(ok ? 'übersetzt' : 'Übersetzen fehlgeschlagen');
      if (ready) return;
      if (ok) run(exe);
      else fallback();
    });
  return s as unknown as NodeJS.ReadStream;
}

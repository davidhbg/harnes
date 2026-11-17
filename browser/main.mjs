// HarnesBrowser – Hauptprogramm (Electron).
// Links Webseiten mit Tabs, rechts RemoteHarnes im Terminal. Die KI-Sitzungen steuern den Browser
// über eine Schnittstelle auf 127.0.0.1 (mit Zugangsschlüssel); der Zeige-Modus (Strg+Alt+H)
// lässt die KI auf Stellen im Browser oder auf dem ganzen Bildschirm zeigen.
import { app, BrowserWindow, Menu, WebContentsView, clipboard, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } from 'electron';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const home = process.env.REMOTEHARNES_HOME || join(homedir(), '.remoteharnes');
const PAGE_AGENT = readFileSync(join(here, 'page-agent.js'), 'utf8');
const START_URL = 'harnes://start';
// Strg+Alt+Leertaste belegt schon das Claude-Desktop-Programm; die erste freie Kombination gewinnt
const HOTKEYS = ['Control+Alt+H', 'Control+Shift+H', 'F9'];
let HOTKEY = '';

app.setName('HarnesBrowser');
// eigene Startseite und gespeicherte Anmeldungen der Webseiten
const PARTITION = 'persist:harnes';

/** @type {BrowserWindow} */
let win;
/** @type {BrowserWindow | undefined} */
let overlay;
/** Tabs: id -> { view, id } */
const tabs = new Map();
let activeId = 0;
let nextId = 1;
let webRect = { x: 0, y: 84, width: 800, height: 600 };
let term;
let lastShot = { w: 0, h: 0, display: null, png: '', at: 0 };
const token = process.env.HARNES_TOKEN || randomBytes(24).toString('hex');
let controlUrl = '';

// ---------------------------------------------------------------- Tabs

function tabInfo() {
  return [...tabs.values()].map((t) => ({
    id: t.id,
    title: t.view.webContents.getTitle() || 'Neuer Tab',
    icon: t.icon ?? '',
    url: displayUrl(t.view.webContents.getURL()),
    loading: t.view.webContents.isLoading(),
    active: t.id === activeId,
    canBack: t.view.webContents.navigationHistory.canGoBack(),
    canForward: t.view.webContents.navigationHistory.canGoForward(),
  }));
}

function displayUrl(url) {
  return url.startsWith('file:') && url.includes('/browser/ui/start.html') ? '' : url;
}

function sendTabs() {
  if (win && !win.isDestroyed()) win.webContents.send('tabs', tabInfo());
}

function activeTab() {
  return tabs.get(activeId);
}

function layoutViews() {
  for (const t of tabs.values()) {
    if (t.id === activeId) {
      t.view.setBounds({ x: Math.round(webRect.x), y: Math.round(webRect.y), width: Math.max(0, Math.round(webRect.width)), height: Math.max(0, Math.round(webRect.height)) });
      t.view.setVisible(true);
    } else t.view.setVisible(false);
  }
}

function toUrl(input) {
  const s = String(input || '').trim();
  if (!s || s === START_URL) return startPage();
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith('about:') || s.startsWith('file:')) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`.replace('https://localhost', 'http://localhost');
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function startPage() {
  return 'file:///' + join(here, 'ui', 'start.html').replace(/\\/g, '/');
}

function newTab(url, activate = true) {
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true } });
  view.setBackgroundColor('#0E0B1C');
  const id = nextId++;
  const t = { id, view };
  tabs.set(id, t);
  const wc = view.webContents;
  for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) wc.on(ev, sendTabs);
  wc.on('did-navigate', () => {
    t.icon = '';
    saveTabs();
  });
  wc.on('page-favicon-updated', (_e, icons) => {
    t.icon = icons[0] ?? '';
    sendTabs();
  });
  wc.on('context-menu', (_e, p) => contextMenu(wc, p));
  // Links mit target=_blank öffnen einen neuen Tab statt eines Fensters
  wc.setWindowOpenHandler(({ url: u }) => {
    newTab(u);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (handleShortcut(input)) e.preventDefault();
  });
  win.contentView.addChildView(view);
  wc.loadURL(toUrl(url));
  if (activate) activate_(id);
  sendTabs();
  return t;
}

function activate_(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  layoutViews();
  sendTabs();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  tabs.delete(id);
  if (activeId === id) {
    const rest = [...tabs.keys()];
    if (rest.length) activate_(rest[rest.length - 1]);
    else newTab(START_URL);
  }
  sendTabs();
}

/** Tastenkürzel im Webbereich (das Terminal bekommt seine Tasten selbst). */
function handleShortcut(input) {
  const ctrl = input.control || input.meta;
  const k = input.key.toLowerCase();
  if (ctrl && k === 't') return newTab(START_URL), true;
  if (ctrl && k === 'w') return closeTab(activeId), true;
  if (ctrl && k === 'l') return win.webContents.send('focus-address'), true;
  if ((ctrl && k === 'r') || k === 'f5') return activeTab()?.view.webContents.reload(), true;
  if (ctrl && k === 'tab') {
    const ids = [...tabs.keys()];
    const i = ids.indexOf(activeId);
    activate_(ids[(i + (input.shift ? -1 : 1) + ids.length) % ids.length]);
    return true;
  }
  if (input.alt && k === 'arrowleft') return activeTab()?.view.webContents.navigationHistory.goBack(), true;
  if (input.alt && k === 'arrowright') return activeTab()?.view.webContents.navigationHistory.goForward(), true;
  if (k === 'f12') return activeTab()?.view.webContents.toggleDevTools(), true;
  const z = activeTab()?.view.webContents;
  if (ctrl && (k === '+' || k === '=') && z) return z.setZoomLevel(z.getZoomLevel() + 0.5), true;
  if (ctrl && k === '-' && z) return z.setZoomLevel(z.getZoomLevel() - 0.5), true;
  if (ctrl && k === '0' && z) return z.setZoomLevel(0), true;
  if (ctrl && k === '`') return win.webContents.send('toggle-terminal'), true;
  return false;
}

// ---------------------------------------------------------------- Seite: Helfer im Dokument

async function page(wc, call) {
  // Helfer (Schnappschuss, Zeiger, Markierung) einmal je Dokument einsetzen, dann aufrufen
  return wc.executeJavaScript(`(function(){ if(!window.__rh){ ${PAGE_AGENT} } return ${call}; })()`, true);
}

function wcOf(args) {
  const t = args?.tab ? tabs.get(Number(args.tab)) : activeTab();
  if (!t) throw new Error('Kein Tab offen.');
  return t.view.webContents;
}

function waitLoad(wc, ms = 15000) {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    wc.once('did-stop-loading', () => {
      clearTimeout(t);
      done();
    });
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nach einer Aktion: kurz warten, ob die Seite neu lädt, dann ein knapper Schnappschuss */
async function settle(wc) {
  await pause(200);
  await waitLoad(wc, 10000);
  // warten, bis sich die Seite 300 ms lang nicht mehr ändert (höchstens 3 s)
  await page(wc, 'window.__rh.quiet(300, 3000)').catch(() => undefined);
}

function activity(text) {
  if (win && !win.isDestroyed()) win.webContents.send('activity', text);
}

async function target(wc, args) {
  if (args.ref) return page(wc, `window.__rh.locate(${JSON.stringify(String(args.ref))})`);
  if (args.text) return page(wc, `window.__rh.locateText(${JSON.stringify(String(args.text))})`);
  if (args.x !== undefined && args.y !== undefined) return { x: Number(args.x), y: Number(args.y), w: 0, h: 0, name: `Punkt ${args.x},${args.y}` };
  throw new Error('Wohin? ref (z. B. e12), text oder x/y angeben.');
}

async function clickAt(wc, p, button = 'left', count = 1) {
  await page(wc, `window.__rh.fly(${p.x}, ${p.y})`);
  await pause(320);
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  for (let i = 1; i <= count; i++) {
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: i });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: i });
  }
  await page(wc, `window.__rh.pulse()`);
}

const KEYS = { enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', entf: 'Delete', space: 'Space', leertaste: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End' };

function pressKey(wc, combo) {
  const parts = String(combo).split('+').map((s) => s.trim());
  const keyName = parts.pop();
  const modifiers = parts.map((m) => ({ strg: 'control', ctrl: 'control', control: 'control', alt: 'alt', shift: 'shift', umschalt: 'shift', meta: 'meta', cmd: 'meta' })[m.toLowerCase()]).filter(Boolean);
  const keyCode = KEYS[keyName.toLowerCase()] ?? keyName;
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode.length === 1 && !modifiers.includes('control') && !modifiers.includes('alt')) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
  if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

async function snapshotText(wc, opts = {}) {
  const snap = await page(wc, `window.__rh.snapshot(${JSON.stringify(opts)})`);
  return `Tab ${activeId} · ${wc.getTitle()}\n${wc.getURL()}\n\n${snap}`;
}

async function screenshotPng(wc) {
  let img = await wc.capturePage();
  const { width } = img.getSize();
  if (width > 1400) img = img.resize({ width: 1400 });
  return img.toPNG().toString('base64');
}

// ---------------------------------------------------------------- Werkzeuge für die KI

const TOOLS = {
  async tabs() {
    return tabInfo()
      .map((t) => `${t.active ? '▶' : ' '} Tab ${t.id}: ${t.title} – ${t.url || '(Startseite)'}`)
      .join('\n');
  },
  async oeffnen(a) {
    let wc;
    if (a.neuer_tab) wc = newTab(a.url).view.webContents;
    else {
      wc = wcOf(a);
      wc.loadURL(toUrl(a.url)).catch(() => undefined);
    }
    activity(`öffnet ${a.url}`);
    await pause(300);
    await waitLoad(wc);
    return snapshotText(wc, { max: 120 });
  },
  async tab_wechseln(a) {
    activate_(Number(a.tab));
    return snapshotText(activeTab().view.webContents, { max: 80 });
  },
  async tab_schliessen(a) {
    closeTab(Number(a.tab ?? activeId));
    return TOOLS.tabs();
  },
  async zurueck(a) {
    const wc = wcOf(a);
    wc.navigationHistory.goBack();
    await settle(wc);
    return snapshotText(wc, { max: 80 });
  },
  async lesen(a) {
    const wc = wcOf(a);
    await waitLoad(wc, 5000);
    return snapshotText(wc, { max: a.alles ? 600 : 250, text: Boolean(a.text), suche: a.suche });
  },
  async klicken(a) {
    const wc = wcOf(a);
    const p = await target(wc, a);
    if (!p) throw new Error(`Element ${a.ref ?? a.text} nicht gefunden. Erst browser_lesen aufrufen.`);
    activity(`klickt ${p.name ?? ''}`);
    await clickAt(wc, p, a.rechts ? 'right' : 'left', a.doppelt ? 2 : 1);
    await settle(wc);
    return `Geklickt: ${p.name ?? ''}\n\n${await snapshotText(wc, { max: 80 })}`;
  },
  async tippen(a) {
    const wc = wcOf(a);
    if (a.ref || a.text) {
      const p = await target(wc, a);
      if (!p) throw new Error(`Feld ${a.ref ?? a.text} nicht gefunden.`);
      await clickAt(wc, p);
      if (a.leeren !== false) await page(wc, `window.__rh.clear(${JSON.stringify(String(a.ref ?? ''))})`);
    }
    activity(`tippt „${String(a.eingabe).slice(0, 40)}“`);
    wc.insertText(String(a.eingabe ?? ''));
    if (a.enter) {
      await pause(80);
      pressKey(wc, 'Enter');
    }
    await settle(wc);
    return `Getippt.\n\n${await snapshotText(wc, { max: 80 })}`;
  },
  async taste(a) {
    const wc = wcOf(a);
    pressKey(wc, a.taste);
    activity(`drückt ${a.taste}`);
    await settle(wc);
    return `Taste ${a.taste} gedrückt.\n\n${await snapshotText(wc, { max: 60 })}`;
  },
  async waehlen(a) {
    const wc = wcOf(a);
    const r = await page(wc, `window.__rh.select(${JSON.stringify(String(a.ref))}, ${JSON.stringify(String(a.wert))})`);
    await settle(wc);
    return r;
  },
  async scrollen(a) {
    const wc = wcOf(a);
    const r = await page(wc, `window.__rh.scroll(${JSON.stringify(a.richtung ?? 'runter')}, ${JSON.stringify(a.ref ?? null)})`);
    await pause(250);
    return `${r}\n\n${await snapshotText(wc, { max: 80 })}`;
  },
  async warten(a) {
    const wc = wcOf(a);
    const until = Date.now() + Math.min(30000, Number(a.ms ?? 3000));
    if (a.text) {
      while (Date.now() < until) {
        if (await page(wc, `document.body && document.body.innerText.includes(${JSON.stringify(String(a.text))})`)) return `„${a.text}“ ist da.`;
        await pause(300);
      }
      return `„${a.text}“ nicht erschienen.`;
    }
    await pause(until - Date.now());
    return 'Gewartet.';
  },
  async bild(a) {
    const wc = wcOf(a);
    return { image: await screenshotPng(wc), text: `Bildschirmfoto von Tab ${activeId}: ${wc.getTitle()}` };
  },
  async js(a) {
    const wc = wcOf(a);
    activity('führt JavaScript aus');
    const r = await wc.executeJavaScript(String(a.code), true);
    return typeof r === 'string' ? r : JSON.stringify(r, null, 2)?.slice(0, 20000) ?? 'undefined';
  },
  async zeigen(a) {
    const wc = wcOf(a);
    const p = await target(wc, a);
    if (!p) throw new Error('Stelle nicht gefunden.');
    await page(wc, `window.__rh.show(${JSON.stringify(p)}, ${JSON.stringify(String(a.erklaerung ?? ''))})`);
    speak(a.erklaerung);
    return `Zeigt auf ${p.name ?? `${p.x},${p.y}`}.`;
  },
  async bildschirm_foto(a) {
    // Kurz nach einer Frage im Zeige-Modus: das Foto vom Moment der Frage
    const shot = lastShot.png && Date.now() - lastShot.at < 120000 && !a?.neu ? { png: lastShot.png, w: lastShot.w, h: lastShot.h } : await captureScreen();
    return { image: shot.png, text: `Bildschirmfoto ${shot.w}×${shot.h} Pixel. Für bildschirm_zeigen Koordinaten in diesem Bild angeben.` };
  },
  async schritte(a) {
    // mehrere Aktionen in einem Zug, z. B. ein Formular ausfüllen und absenden
    const done = [];
    const list = Array.isArray(a.schritte) ? a.schritte : [];
    for (const [i, st] of list.entries()) {
      const name = String(st.aktion ?? '');
      if (!['klicken', 'tippen', 'taste', 'waehlen', 'scrollen', 'warten', 'oeffnen', 'zeigen'].includes(name)) throw new Error(`Schritt ${i + 1}: Aktion „${name}“ geht hier nicht.`);
      try {
        await TOOLS[name]({ ...st, tab: a.tab });
        done.push(`${i + 1}. ${name} ✓`);
      } catch (e) {
        done.push(`${i + 1}. ${name} ✗ ${e?.message ?? e}`);
        break;
      }
    }
    return `${done.join('\n')}\n\n${await snapshotText(wcOf(a), { max: 100 })}`;
  },
  async bildschirm_zeigen(a) {
    showOnScreen(Number(a.x), Number(a.y), String(a.erklaerung ?? ''));
    return 'Gezeigt.';
  },
};

// ---------------------------------------------------------------- ganzer Bildschirm (Zeige-Modus)

async function captureScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = Math.round(display.bounds.width * display.scaleFactor);
  const h = Math.round(display.bounds.height * display.scaleFactor);
  if (overlay) overlay.setOpacity(0);
  await pause(60);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
  if (overlay) overlay.setOpacity(1);
  const src = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
  let img = src.thumbnail;
  // für die KI verkleinern (spart Tokens), Koordinaten beziehen sich auf dieses Bild
  if (img.getSize().width > 1600) img = img.resize({ width: 1600 });
  const size = img.getSize();
  const png = img.toPNG();
  lastShot = { w: size.width, h: size.height, display, png: png.toString('base64'), at: Date.now() };
  const file = join(tmpdir(), `harnes-bildschirm-${Date.now()}.png`);
  writeFileSync(file, png);
  return { png: png.toString('base64'), w: size.width, h: size.height, file };
}

function ensureOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const d = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(join(here, 'ui', 'overlay.html'));
  overlay.once('ready-to-show', () => overlay.showInactive());
  return overlay;
}

function moveOverlayTo(display) {
  const o = ensureOverlay();
  o.setBounds(display.bounds);
}

function showOnScreen(x, y, text) {
  const display = lastShot.display ?? screen.getPrimaryDisplay();
  moveOverlayTo(display);
  // Bildkoordinaten -> Fensterkoordinaten der Überlagerung
  const sx = lastShot.w ? display.bounds.width / lastShot.w : 1;
  const sy = lastShot.h ? display.bounds.height / lastShot.h : 1;
  ensureOverlay().webContents.send('overlay', { type: 'point', x: x * sx, y: y * sy, text });
  speak(text);
}

function speak(text) {
  if (!text || !settings.sprechen) return;
  ensureOverlay().webContents.send('overlay', { type: 'speak', text: String(text) });
}

/** Zeige-Modus: Frage eintippen, Bildschirmfoto, Frage an RemoteHarnes */
/** @type {BrowserWindow | undefined} */
let askWin;

/** Zeige-Modus: kleines Fragefenster an der Maus (eigenes Fenster, damit es den Fokus bekommt) */
function startAsk() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  moveOverlayTo(display);
  ensureOverlay().webContents.send('overlay', { type: 'ask', x: point.x - display.bounds.x, y: point.y - display.bounds.y });
  const W = 420;
  const H = 142;
  const b = display.workArea;
  const x = Math.min(Math.max(point.x + 18, b.x + 8), b.x + b.width - W - 8);
  const y = Math.min(Math.max(point.y + 18, b.y + 8), b.y + b.height - H - 8);
  if (!askWin || askWin.isDestroyed()) {
    askWin = new BrowserWindow({
      width: W,
      height: H,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true },
    });
    askWin.setAlwaysOnTop(true, 'screen-saver');
    askWin.loadFile(join(here, 'ui', 'ask.html'));
    askWin.once('ready-to-show', () => {
      askWin.show();
      askWin.focus();
    });
  } else {
    askWin.setBounds({ x, y, width: W, height: H });
    askWin.webContents.send('ask-reset');
    askWin.show();
    askWin.focus();
  }
}

ipcMain.on('ask-done', (_e, question) => void askDone(question));

async function askDone(question) {
  const o = ensureOverlay();
  askWin?.hide();
  if (!question) {
    o.webContents.send('overlay', { type: 'cancel' });
    return;
  }
  o.webContents.send('overlay', { type: 'thinking' });
  const shot = await captureScreen();
  void shot;
  sendToTerminal(`/zeige ${question}`);
}

// Nur für automatische Tests (HARNES_TEST=1): ins Terminal tippen und den Zeige-Modus auslösen
if (process.env.HARNES_TEST === '1') {
  TOOLS._terminal = async (a) => (term?.write(String(a.text ?? '')), 'ok');
  TOOLS._ask = async (a) => (await askDone(String(a.frage ?? '')), 'ok');
}

/** Eine Zeile in RemoteHarnes eingeben (Ende, Zeile leeren, Text, Enter) */
function sendToTerminal(line) {
  if (!term) return;
  term.write('\u001b[F\u0015');
  setTimeout(() => term.write(line.replace(/[\r\n]+/g, ' ')), 60);
  setTimeout(() => term.write('\r'), 260);
  win.webContents.send('terminal-show');
}

// ---------------------------------------------------------------- Einstellungen

const settingsFile = join(home, 'browser.json');
const settings = { sprechen: true, terminalBreite: 0.42 };
try {
  Object.assign(settings, JSON.parse(readFileSync(settingsFile, 'utf8')).einstellungen ?? {});
} catch {
  /* erste Nutzung */
}
function saveTabs() {
  settings.tabs = [...tabs.values()].map((t) => t.view.webContents.getURL()).filter((u) => /^https?:/.test(u));
  saveSettings();
}

/** Rechtsklick in einer Webseite */
function contextMenu(wc, p) {
  const items = [];
  if (p.linkURL) items.push({ label: 'Link in neuem Tab öffnen', click: () => newTab(p.linkURL) }, { label: 'Link kopieren', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
  if (p.selectionText) items.push({ label: 'Kopieren', role: 'copy' }, { label: `„${p.selectionText.slice(0, 24)}“ suchen`, click: () => newTab(p.selectionText) });
  if (p.isEditable) items.push({ label: 'Ausschneiden', role: 'cut' }, { label: 'Einfügen', role: 'paste' }, { label: 'Alles markieren', role: 'selectAll' });
  if (items.length) items.push({ type: 'separator' });
  items.push(
    { label: 'Zurück', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Neu laden', click: () => wc.reload() },
    { label: 'Erkläre mir diese Seite', click: () => sendToTerminal(`/zeige Erkläre mir kurz die Seite ${wc.getURL()} und zeige die wichtigsten Stellen mit browser_zeigen.`) },
    { type: 'separator' },
    { label: 'Untersuchen', click: () => wc.inspectElement(p.x, p.y) },
  );
  Menu.buildFromTemplate(items).popup({ window: win });
}

function saveSettings() {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ einstellungen: settings, url: controlUrl }, null, 2));
  } catch {
    /* egal */
  }
}

// ---------------------------------------------------------------- Steuerschnittstelle (nur 127.0.0.1)

function startControlServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const given = Buffer.from(String(req.headers.authorization ?? ''));
      const want = Buffer.from(`Bearer ${token}`);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return send(401, { error: 'Zugang verweigert.' });
      if (req.headers.origin) return send(403, { error: 'Keine Anfragen aus dem Browser.' });
      if (req.method !== 'POST' || req.url !== '/werkzeug') return send(404, { error: 'Unbekannt.' });
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        try {
          const { name, args } = JSON.parse(body || '{}');
          const fn = TOOLS[name];
          if (!fn) return send(404, { error: `Werkzeug ${name} gibt es nicht.` });
          const r = await fn(args ?? {});
          send(200, typeof r === 'string' ? { text: r } : r);
        } catch (e) {
          send(200, { error: String(e?.message ?? e) });
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      controlUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

// ---------------------------------------------------------------- Terminal mit RemoteHarnes

function lastProject() {
  try {
    const list = JSON.parse(readFileSync(join(home, 'projekte.json'), 'utf8'));
    const p = list.sort((a, b) => b.last - a.last).find((x) => existsSync(x.cwd));
    if (p) return p.cwd;
  } catch {
    /* keins */
  }
  return homedir();
}

function startTerminal(cols, rows) {
  if (term) return;
  const cwd = process.env.HARNES_PROJEKT || lastProject();
  const env = { ...process.env, RH_BROWSER_URL: controlUrl, RH_BROWSER_TOKEN: token, FORCE_COLOR: '3', COLORTERM: 'truecolor' };
  delete env.ELECTRON_RUN_AS_NODE;
  const node = process.platform === 'win32' ? 'node.exe' : 'node';
  term = pty.spawn(node, [join(repo, 'dist', 'cli.js'), cwd], { name: 'xterm-256color', cols, rows, cwd, env, useConptyDll: true });
  term.onData((d) => win && !win.isDestroyed() && win.webContents.send('pty-data', d));
  term.onExit(() => {
    term = undefined;
    if (win && !win.isDestroyed()) win.webContents.send('pty-exit');
  });
}

ipcMain.on('pty-start', (_e, { cols, rows }) => startTerminal(cols, rows));
ipcMain.on('pty-write', (_e, d) => term?.write(d));
ipcMain.on('pty-resize', (_e, { cols, rows }) => {
  try {
    term?.resize(cols, rows);
  } catch {
    /* schon beendet */
  }
});

// ---------------------------------------------------------------- Fenster und Bedienung

ipcMain.on('layout', (_e, rect) => {
  webRect = rect;
  layoutViews();
});
ipcMain.on('navigate', (_e, url) => {
  const t = activeTab();
  if (t) t.view.webContents.loadURL(toUrl(url)).catch(() => undefined);
});
ipcMain.on('tab-new', () => newTab(START_URL));
ipcMain.on('tab-close', (_e, id) => closeTab(id));
ipcMain.on('tab-activate', (_e, id) => activate_(id));
ipcMain.on('back', () => activeTab()?.view.webContents.navigationHistory.goBack());
ipcMain.on('forward', () => activeTab()?.view.webContents.navigationHistory.goForward());
ipcMain.on('reload', () => activeTab()?.view.webContents.reload());
ipcMain.on('ask', () => startAsk());
ipcMain.on('settings', (_e, s) => {
  Object.assign(settings, s);
  saveSettings();
});
ipcMain.handle('get-settings', () => ({ ...settings, hotkey: HOTKEY.replace('Control', 'Strg').replace('Shift', 'Umschalt') }));
ipcMain.on('overlay-idle', () => {
  const o = ensureOverlay();
  o.setIgnoreMouseEvents(true, { forward: true });
  o.setFocusable(false);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0E0B1C',
    title: 'HarnesBrowser',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0E0B1C', symbolColor: '#A99BDC', height: 40 },
    icon: join(here, 'ui', 'icon.png'),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true },
  });
  win.loadFile(join(here, 'ui', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    // im Fenster (nicht im Terminal) gelten die Browser-Tasten; das Terminal meldet seinen Fokus selbst
    if (input.type === 'keyDown' && !terminalFocused && handleShortcut(input)) e.preventDefault();
  });
  win.on('close', () => saveTabs());
  win.on('closed', () => {
    term?.kill();
    app.quit();
  });
  const fromArgs = process.argv.filter((a) => /^https?:\/\//.test(a));
  const restore = (settings.tabs ?? []).filter((u) => /^https?:/.test(u));
  const open = fromArgs.length ? fromArgs : restore.length ? restore : [START_URL];
  open.forEach((u, i) => newTab(u, i === open.length - 1));
}

let terminalFocused = false;
ipcMain.on('terminal-focus', (_e, f) => (terminalFocused = Boolean(f)));

app.whenReady().then(async () => {
  await startControlServer();
  saveSettings();
  // Links aus der Startseite (harnes://) und externe Protokolle
  session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'fullscreen', 'notifications'].includes(perm)));
  createWindow();
  ensureOverlay();
  HOTKEY = HOTKEYS.find((k) => globalShortcut.register(k, startAsk)) ?? '';
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => {
    if (url.startsWith('mailto:')) {
      ev.preventDefault();
      shell.openExternal(url);
    }
  });
});

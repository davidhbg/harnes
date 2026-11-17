// Oberfläche des HarnesBrowsers: Tabs, Adresszeile, Terminal mit RemoteHarnes, Statuszeile.
/* global Terminal, FitAddon */
const h = window.harnes;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- Tabs und Adresszeile
let tabs = [];
let urlEditing = false;

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.active ? ' active' : '');
    el.title = t.url || t.title;
    if (t.loading) {
      const s = document.createElement('span');
      s.className = 'spin';
      el.appendChild(s);
    } else if (t.icon) {
      const img = document.createElement('img');
      img.className = 'fav';
      img.src = t.icon;
      img.onerror = () => img.remove();
      el.appendChild(img);
    }
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = t.url ? t.title : 'Startseite';
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Tab schließen (Strg+W)';
    x.onclick = (e) => {
      e.stopPropagation();
      h.send('tab-close', t.id);
    };
    el.append(title, x);
    el.onclick = () => h.send('tab-activate', t.id);
    el.onauxclick = (e) => e.button === 1 && h.send('tab-close', t.id);
    box.appendChild(el);
  }
  const a = tabs.find((t) => t.active);
  if (a) {
    if (!urlEditing) $('url').value = a.url;
    $('back').disabled = !a.canBack;
    $('forward').disabled = !a.canForward;
    $('loading').classList.toggle('on', a.loading);
    $('lock').textContent = a.url.startsWith('https://') ? '◆' : '◇';
    $('lock').style.color = a.url.startsWith('https://') ? 'var(--ok)' : '';
    document.title = `${a.title || 'Startseite'} – HarnesBrowser`;
  }
}

h.on('tabs', (list) => {
  tabs = list;
  renderTabs();
});
h.on('focus-address', () => {
  $('url').focus();
  $('url').select();
});

$('url').addEventListener('focus', () => {
  urlEditing = true;
  setTimeout(() => $('url').select(), 0);
});
$('url').addEventListener('blur', () => {
  urlEditing = false;
  renderTabs();
});
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    urlEditing = false;
    $('url').blur();
  }
});
$('addr').addEventListener('submit', (e) => {
  e.preventDefault();
  h.send('navigate', $('url').value);
  urlEditing = false;
  $('url').blur();
});
$('newtab').onclick = () => h.send('tab-new');
$('back').onclick = () => h.send('back');
$('forward').onclick = () => h.send('forward');
$('reload').onclick = () => h.send('reload');
$('ask').onclick = () => h.send('ask');

// ---------------------------------------------------------------- Webbereich: Lage an das Hauptprogramm melden
function reportLayout() {
  const r = $('web').getBoundingClientRect();
  // 1 Pixel Rand innen frei lassen, damit der abgerundete Rahmen sichtbar bleibt
  h.send('layout', { x: r.left + 1, y: r.top + 1, width: r.width - 2, height: r.height - 2 });
}
new ResizeObserver(reportLayout).observe($('web'));
window.addEventListener('resize', reportLayout);

// Trennlinie zwischen Web und Terminal ziehen
let dragging = false;
$('split').addEventListener('mousedown', () => {
  dragging = true;
  document.body.style.cursor = 'col-resize';
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  document.body.style.cursor = '';
  h.send('settings', { terminalBreite: $('side').getBoundingClientRect().width / window.innerWidth });
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const w = Math.min(window.innerWidth - 320, Math.max(320, window.innerWidth - e.clientX - 10));
  $('side').style.width = w + 'px';
  fitTerm();
});

function toggleTerminal(show) {
  const on = show ?? document.body.classList.contains('no-term');
  document.body.classList.toggle('no-term', !on);
  $('toggleTerm').classList.toggle('on', on);
  setTimeout(() => {
    reportLayout();
    fitTerm();
    if (on) term.focus();
  }, 30);
}
$('toggleTerm').onclick = () => toggleTerminal();
h.on('toggle-terminal', () => toggleTerminal());
h.on('terminal-show', () => toggleTerminal(true));

// ---------------------------------------------------------------- Terminal mit RemoteHarnes
const term = new Terminal({
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
  fontSize: 13,
  lineHeight: 1,
  customGlyphs: true,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 2000,
  theme: {
    background: '#0b0917',
    foreground: '#E4DFF0',
    cursor: '#E3B48F',
    selectionBackground: '#5B4E9688',
    black: '#0b0917',
    brightBlack: '#625B80',
    magenta: '#C59BC0',
    brightMagenta: '#D9CFF0',
    blue: '#8676C4',
    brightBlue: '#A99BDC',
    cyan: '#8FB4D8',
    yellow: '#DDBF84',
    green: '#9CC7A4',
    red: '#D58C96',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('term'));

function fitTerm() {
  try {
    fit.fit();
    h.send('pty-resize', { cols: term.cols, rows: term.rows });
  } catch {
    /* noch nicht sichtbar */
  }
}
new ResizeObserver(() => fitTerm()).observe($('term'));

let started = false;
function startTerm() {
  fitTerm();
  h.send('pty-start', { cols: term.cols, rows: term.rows });
  started = true;
  $('term-state').textContent = '';
  $('term-restart').classList.remove('show');
}
term.onData((d) => h.send('pty-write', d));
h.on('pty-data', (d) => term.write(d));
h.on('pty-exit', () => {
  $('term-state').textContent = 'beendet';
  $('term-restart').classList.add('show');
  term.write('\r\n\x1b[38;2;98;91;128mRemoteHarnes wurde beendet. „neu starten“ oben rechts.\x1b[0m\r\n');
});
$('term-restart').onclick = () => {
  term.reset();
  startTerm();
  term.focus();
};
term.textarea?.addEventListener('focus', () => h.send('terminal-focus', true));
term.textarea?.addEventListener('blur', () => h.send('terminal-focus', false));

// ---------------------------------------------------------------- Statuszeile: was die KI gerade tut
let actTimer = 0;
h.on('activity', (text) => {
  $('activity-text').textContent = 'KI ' + text;
  $('activity').classList.add('busy');
  clearTimeout(actTimer);
  actTimer = setTimeout(() => {
    $('activity').classList.remove('busy');
    $('activity-text').textContent = 'Bereit';
  }, 2500);
});

// ---------------------------------------------------------------- Einstellungen
h.invoke('get-settings').then((s) => {
  if (s.terminalBreite) $('side').style.width = Math.round(window.innerWidth * s.terminalBreite) + 'px';
  $('speak').classList.toggle('off', !s.sprechen);
  $('ask').querySelector('kbd').textContent = s.hotkey || 'Knopf';
  setTimeout(() => {
    reportLayout();
    startTerm();
  }, 50);
});
$('speak').onclick = () => {
  const off = !$('speak').classList.toggle('off');
  h.send('settings', { sprechen: off });
};

// Tasten im Fenster (außerhalb des Terminals): Strg+L, Strg+T usw. erledigt das Hauptprogramm
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === '`') {
    e.preventDefault();
    toggleTerminal();
  }
});

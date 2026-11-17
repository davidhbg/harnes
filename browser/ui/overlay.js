// Überlagerung über dem ganzen Bildschirm: Frage-Feld, fliegender Zeiger der KI, Sprechblase, Vorlesen.
const h = window.harnes;
const $ = (id) => document.getElementById(id);
const buddy = $('buddy');
const bubble = $('bubble');
const ask = $('ask');
const q = $('q');

let pos = { x: -100, y: -100 };
let queue = [];
let busy = false;
let hideTimer = 0;
let thinkTimer = 0;

function place(el, x, y) {
  // Karte neben dem Punkt, aber immer ganz auf dem Bildschirm
  const w = el.offsetWidth || 380;
  const hgt = el.offsetHeight || 80;
  let left = x + 28;
  let top = y + 22;
  if (left + w > innerWidth - 12) left = x - w - 20;
  if (top + hgt > innerHeight - 12) top = y - hgt - 16;
  el.style.left = Math.max(12, left) + 'px';
  el.style.top = Math.max(12, top) + 'px';
}

/** Zeiger im Bogen zum Ziel fliegen lassen */
function flyTo(x, y, ms = 700) {
  return new Promise((done) => {
    const from = { ...pos };
    if (from.x < 0) {
      from.x = x - 160;
      from.y = y + 120;
    }
    const start = performance.now();
    const lift = Math.min(120, Math.hypot(x - from.x, y - from.y) * 0.25);
    buddy.classList.add('on');
    function step(t) {
      const k = Math.min(1, (t - start) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const cx = from.x + (x - from.x) * e;
      const cy = from.y + (y - from.y) * e - Math.sin(Math.PI * e) * lift;
      buddy.style.transform = `translate(${cx - 5}px, ${cy - 4}px)`;
      pos = { x: cx, y: cy };
      if (k < 1) requestAnimationFrame(step);
      else done();
    }
    requestAnimationFrame(step);
  });
}

function halo(x, y) {
  const el = $('halo');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
}

function showBubble(html, x, y) {
  bubble.innerHTML = html;
  bubble.classList.add('on');
  place(bubble, x, y);
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

async function nextPoint() {
  if (busy) return;
  const p = queue.shift();
  if (!p) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      buddy.classList.remove('on');
      bubble.classList.remove('on');
      pos = { x: -100, y: -100 };
      h.send('overlay-idle');
    }, 12000);
    return;
  }
  busy = true;
  clearTimeout(hideTimer);
  clearTimeout(thinkTimer);
  bubble.classList.remove('on');
  await flyTo(p.x, p.y);
  halo(p.x, p.y);
  if (p.text) showBubble(esc(p.text), p.x, p.y);
  // je nach Textlänge stehen lassen, dann zur nächsten Stelle
  const wait = Math.min(9000, 2200 + String(p.text || '').length * 45);
  setTimeout(() => {
    busy = false;
    nextPoint();
  }, queue.length ? wait : 0);
}

// ---------------------------------------------------------------- Vorlesen (Stimmen von Windows, offline)
let voice = null;
function pickVoice() {
  const all = speechSynthesis.getVoices();
  voice = all.find((v) => /de-DE/i.test(v.lang) && /Katja|Hedda|Seraphina|Amala|Conrad/i.test(v.name)) || all.find((v) => /^de/i.test(v.lang)) || null;
}
speechSynthesis.onvoiceschanged = pickVoice;
pickVoice();
function speak(text) {
  const u = new SpeechSynthesisUtterance(String(text));
  u.lang = 'de-DE';
  if (voice) u.voice = voice;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- Ereignisse vom Hauptprogramm
h.on('overlay', (m) => {
  if (m.type === 'ask') {
    queue = [];
    speechSynthesis.cancel();
    bubble.classList.remove('on');
    // das Fragefeld ist ein eigenes Fenster; hier nur der Zeiger an der Maus
    pos = { x: m.x, y: m.y };
    buddy.classList.add('on');
    buddy.style.transform = `translate(${m.x - 5}px, ${m.y - 4}px)`;
    setTimeout(() => q.focus(), 30);
  } else if (m.type === 'cancel') {
    buddy.classList.remove('on');
    bubble.classList.remove('on');
  } else if (m.type === 'thinking') {
    showBubble('<div class="think"><span class="spin"></span>Ich schaue mir das an …</div>', pos.x, pos.y);
    clearTimeout(thinkTimer);
    thinkTimer = setTimeout(() => bubble.classList.remove('on'), 90000);
  } else if (m.type === 'point') {
    queue.push(m);
    nextPoint();
  } else if (m.type === 'speak') {
    speak(m.text);
  }
});

q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && q.value.trim()) {
    ask.classList.remove('on');
    h.send('ask-done', q.value.trim());
  } else if (e.key === 'Escape') {
    ask.classList.remove('on');
    buddy.classList.remove('on');
    h.send('ask-done', '');
  }
});

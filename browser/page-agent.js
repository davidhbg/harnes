// Wird in jede Webseite eingesetzt (Aufruf über executeJavaScript). Stellt window.__rh bereit:
// Übersicht der Bedienelemente mit festen Kennungen (e1, e2 …), Suchen, Zeiger der KI,
// Markierungen und Sprechblasen. Keine Abhängigkeiten, läuft in jeder Seite.
window.__rh = (function () {
  var counter = 0;
  var SEL =
    'a[href],button,input,select,textarea,summary,label[for],[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  function inView(el) {
    var r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function clean(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function nameOf(el) {
    // Reihenfolge: ausdrücklicher Name, Beschriftung, sichtbarer Text, Wert/Platzhalter, Tooltip
    var lab = el.getAttribute('aria-label') || '';
    if (!lab && el.labels && el.labels.length) lab = el.labels[0].innerText;
    if (!lab && el.getAttribute('aria-labelledby')) {
      var l = document.getElementById(el.getAttribute('aria-labelledby'));
      if (l) lab = l.innerText;
    }
    if (!lab) lab = el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || '';
    if (!lab) {
      var img = el.querySelector && el.querySelector('img[alt],svg[aria-label]');
      if (img) lab = img.getAttribute('alt') || img.getAttribute('aria-label');
    }
    return clean(lab, 70);
  }
  function kind(el) {
    var t = el.tagName.toLowerCase();
    var role = el.getAttribute('role');
    if (t === 'a') return 'link';
    if (t === 'button' || role === 'button') return 'knopf';
    if (t === 'select' || role === 'combobox') return 'auswahl';
    if (t === 'textarea' || role === 'textbox' || el.isContentEditable) return 'textfeld';
    if (t === 'input') {
      var ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty === 'checkbox' ? 'haken' : 'option';
      if (ty === 'submit' || ty === 'button') return 'knopf';
      return 'eingabe(' + ty + ')';
    }
    if (role) return role;
    if (t === 'summary') return 'aufklappen';
    if (t === 'label') return 'beschriftung';
    return t;
  }
  function ref(el) {
    if (!el.dataset.rhRef) {
      counter = Math.max(counter, Number(window.__rhMax || 0)) + 1;
      window.__rhMax = counter;
      el.dataset.rhRef = 'e' + counter;
    }
    return el.dataset.rhRef;
  }
  function line(el) {
    var k = kind(el);
    var s = '[' + ref(el) + '] ' + k + ' "' + nameOf(el) + '"';
    if (el.tagName === 'A') {
      var h = el.getAttribute('href') || '';
      if (h && h.indexOf('javascript:') !== 0) s += ' → ' + clean(h, 60);
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') s += el.checked ? ' [x]' : ' [ ]';
      else if (el.value) s += ' wert="' + clean(el.type === 'password' ? '••••' : el.value, 40) + '"';
      if (el.disabled) s += ' (gesperrt)';
    }
    if (el.tagName === 'SELECT') {
      var opts = Array.prototype.slice.call(el.options, 0, 12).map(function (o) {
        return (o.selected ? '*' : '') + clean(o.text, 20);
      });
      s += ' optionen: ' + opts.join(' | ');
    }
    return s;
  }

  function snapshot(o) {
    o = o || {};
    var max = o.max || 250;
    var all = Array.prototype.slice.call(document.querySelectorAll(SEL)).filter(visible);
    if (o.suche) {
      var q = String(o.suche).toLowerCase();
      all = all.filter(function (el) {
        return nameOf(el).toLowerCase().indexOf(q) >= 0;
      });
    }
    var seen = new Set();
    var vis = [];
    var rest = [];
    all.forEach(function (el) {
      // verschachtelte Doppelungen (Link in Knopf usw.) nur einmal
      if (el.parentElement && el.parentElement.closest(SEL) && nameOf(el) === nameOf(el.parentElement.closest(SEL))) return;
      if (seen.has(el)) return;
      seen.add(el);
      (inView(el) ? vis : rest).push(el);
    });
    var out = [];
    var heads = Array.prototype.slice
      .call(document.querySelectorAll('h1,h2,h3'))
      .filter(visible)
      .slice(0, 12)
      .map(function (h) {
        return '#'.repeat(Number(h.tagName[1])) + ' ' + clean(h.innerText, 80);
      });
    if (heads.length) out.push('Überschriften:', heads.join('\n'), '');
    out.push('Bedienelemente im sichtbaren Bereich:');
    vis.slice(0, max).forEach(function (el) {
      out.push(line(el));
    });
    if (rest.length) {
      out.push('', 'Weiter unten/außerhalb (' + rest.length + '):');
      rest.slice(0, Math.max(0, max - vis.length)).forEach(function (el) {
        out.push(line(el));
      });
    }
    if (o.text) out.push('', 'Text der Seite:', clean(document.body ? document.body.innerText : '', 6000));
    else {
      var main = document.querySelector('main,article,[role=main]') || document.body;
      out.push('', 'Text (Auszug): ' + clean(main ? main.innerText : '', 1200));
    }
    return out.join('\n');
  }

  function byRef(r) {
    return document.querySelector('[data-rh-ref="' + String(r).replace(/[^\w-]/g, '') + '"]');
  }
  function point(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top, name: nameOf(el) || kind(el) };
  }
  function locate(r) {
    var el = byRef(r);
    return el ? point(el) : null;
  }
  function locateText(t) {
    var q = String(t).toLowerCase().trim();
    // Bedienelemente und Überschriften; exakter Text schlägt Teiltreffer, sichtbare schlagen verdeckte
    var cands = Array.prototype.slice.call(document.querySelectorAll(SEL + ',h1,h2,h3,h4,h5,h6,th,legend')).filter(visible);
    var textOf = function (el) {
      return /^H\d|TH|LEGEND$/.test(el.tagName) ? clean(el.innerText, 70).replace(/\s*\[.*?\]\s*$/, '') : nameOf(el);
    };
    var score = function (el) {
      var s = textOf(el).toLowerCase();
      return (s === q ? 0 : s.indexOf(q) === 0 ? 1 : 2) + (inView(el) ? 0 : 0.5);
    };
    var hits = cands.filter(function (el) {
      return textOf(el).toLowerCase().indexOf(q) >= 0;
    });
    hits.sort(function (a, b) {
      return score(a) - score(b);
    });
    var el = hits[0];
    if (!el) {
      // irgendein sichtbares Element mit diesem Text
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        var n = walker.currentNode;
        if (n.children.length === 0 && visible(n) && (n.innerText || '').toLowerCase().indexOf(q) >= 0) {
          el = n;
          break;
        }
      }
    }
    if (!el) return null;
    ref(el);
    return point(el);
  }
  function clear(r) {
    var el = (r && byRef(r)) || document.activeElement;
    if (!el) return;
    if (el.select) el.select();
    else if (el.isContentEditable) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  function select(r, wert) {
    var el = byRef(r);
    if (!el || el.tagName !== 'SELECT') return 'Kein Auswahlfeld ' + r + '.';
    var w = String(wert).toLowerCase();
    var opt = Array.prototype.find.call(el.options, function (o) {
      return o.value.toLowerCase() === w || o.text.toLowerCase() === w;
    }) || Array.prototype.find.call(el.options, function (o) {
      return o.text.toLowerCase().indexOf(w) >= 0;
    });
    if (!opt) return 'Option „' + wert + '“ gibt es nicht.';
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'Gewählt: ' + opt.text;
  }
  function scroll(dir, r) {
    var el = r ? byRef(r) : null;
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      return 'Zu ' + r + ' gescrollt.';
    }
    var dy = { runter: 0.85, down: 0.85, hoch: -0.85, up: -0.85, oben: -1e9, top: -1e9, unten: 1e9, bottom: 1e9 }[dir] || 0.85;
    scrollBy(0, Math.abs(dy) > 10 ? dy : dy * innerHeight);
    return 'Gescrollt (' + Math.round(scrollY) + ' von ' + Math.round(document.documentElement.scrollHeight - innerHeight) + ').';
  }

  // ------------------------------------------------ Zeiger, Markierung, Sprechblase
  var ui = null;
  function overlay() {
    if (ui && document.documentElement.contains(ui.host)) return ui;
    var host = document.createElement('div');
    host.setAttribute('data-harnes', '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '.c{position:fixed;left:0;top:0;width:28px;height:28px;transform:translate(-200px,-200px);transition:transform .32s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 2px 6px rgba(20,10,40,.6))}' +
      '.b{position:fixed;border:2px solid #E3B48F;border-radius:10px;box-shadow:0 0 0 4px rgba(227,180,143,.18),0 0 24px rgba(197,155,192,.45);opacity:0;transition:all .3s ease}' +
      '.t{position:fixed;max-width:320px;padding:10px 14px;border-radius:14px;background:#15112699;backdrop-filter:blur(8px);background:rgba(21,17,38,.94);color:#E4DFF0;font:500 13.5px/1.45 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;border:1px solid #5B4E96;box-shadow:0 8px 30px rgba(10,5,25,.55);opacity:0;transform:translateY(6px);transition:opacity .25s,transform .25s}' +
      '.t.on,.b.on{opacity:1;transform:none}' +
      '.r{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid #E3B48F;opacity:0}' +
      '.r.go{animation:r .5s ease-out}@keyframes r{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(2.6)}}' +
      '</style>' +
      '<div class="b"></div><div class="t"></div><div class="r"></div>' +
      '<svg class="c" viewBox="0 0 28 28"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F4E6C8"/><stop offset=".5" stop-color="#C59BC0"/><stop offset="1" stop-color="#8676C4"/></linearGradient></defs><path d="M4 3 L24 12 L14 14.5 L10.5 25 Z" fill="url(#g)" stroke="#17122B" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(host);
    ui = { host: host, c: root.querySelector('.c'), b: root.querySelector('.b'), t: root.querySelector('.t'), r: root.querySelector('.r'), x: -200, y: -200, timer: 0 };
    return ui;
  }
  function fly(x, y) {
    var u = overlay();
    u.x = x;
    u.y = y;
    u.c.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 3) + 'px)';
    return new Promise(function (res) {
      setTimeout(res, 330);
    });
  }
  function pulse() {
    var u = overlay();
    u.r.style.left = u.x + 'px';
    u.r.style.top = u.y + 'px';
    u.r.classList.remove('go');
    void u.r.offsetWidth;
    u.r.classList.add('go');
  }
  function show(p, text) {
    var u = overlay();
    fly(p.x + Math.min(18, (p.w || 0) / 2), p.y + Math.min(10, (p.h || 0) / 2));
    if (p.w && p.h) {
      u.b.style.left = p.left - 6 + 'px';
      u.b.style.top = p.top - 6 + 'px';
      u.b.style.width = p.w + 12 + 'px';
      u.b.style.height = p.h + 12 + 'px';
      u.b.classList.add('on');
    } else u.b.classList.remove('on');
    if (text) {
      u.t.textContent = text;
      var tx = Math.min(innerWidth - 340, p.x + 24);
      var ty = p.y + (p.h || 0) / 2 + 18;
      if (ty > innerHeight - 120) ty = Math.max(10, p.y - (p.h || 0) / 2 - 90);
      u.t.style.left = Math.max(10, tx) + 'px';
      u.t.style.top = ty + 'px';
      u.t.classList.add('on');
    } else u.t.classList.remove('on');
    clearTimeout(u.timer);
    u.timer = setTimeout(function () {
      u.b.classList.remove('on');
      u.t.classList.remove('on');
    }, 9000);
    return true;
  }

  /** Wartet, bis sich die Seite eine Weile nicht mehr ändert (für Web-Apps ohne Neuladen) */
  function quiet(ms, max) {
    return new Promise(function (res) {
      var last = Date.now();
      var start = last;
      var mo = new MutationObserver(function () {
        last = Date.now();
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      (function check() {
        var now = Date.now();
        if (now - last >= ms || now - start >= max) {
          mo.disconnect();
          res(true);
        } else setTimeout(check, 60);
      })();
    });
  }

  return { quiet: quiet, snapshot: snapshot, locate: locate, locateText: locateText, clear: clear, select: select, scroll: scroll, fly: fly, pulse: pulse, show: show };
})();

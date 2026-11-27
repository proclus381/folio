// DOM overlay: title marquee, footer, reader bar, go-to popover, details / index panel, toasts.

import { CLOTHS, themePalette } from './textures.js';
import { clamp } from './anim.js';
import * as store from './store.js';
import { BINDINGS, bindingKind, defaultBinding, setDefaultBinding } from './binding.js';
import { PAPER_TYPES, PAPER_ORDER, GSM_RANGE, fullSettings, resolvePaper, describeWeight } from './paper.js';
import { LIGHTS } from './lighting.js';
import { GROUPS, ORDERS, sectionsOf } from './arrange.js';
import { PLANK_STYLES } from './shelfdeco.js';
import { inkSettings, PEN_COLORS, MARKER_COLORS, PENCIL_COLORS, PENCIL_GRADES, RANGES, TOOL_KIND, makeStroke, drawStroke, pointFactors } from './ink.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtDate(t) {
  if (!t) return '—';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export class UI {
  constructor(app) {
    this.app = app;
    this.body = document.body;
    this.marquee = $('marquee');
    this.track = this.marquee.querySelector('.track');
    this.titles = [];
    this.toastEl = $('toast');
    this.panel = $('panel');
    this.panelBody = $('panel-body');
    this.panelMode = null;
    this.bind();
    this.initChrome();
  }

  // ------------------------------------------------------------------ wiring
  bind() {
    const app = this.app;
    // one add button: PDF files, or a folder (which becomes a shelf)
    $('add-btn').addEventListener('click', () => this.toggleAddMenu());
    $('add-files').addEventListener('click', () => {
      this.toggleAddMenu(false);
      app.pickFiles();
    });
    $('add-folder-btn').addEventListener('click', () => {
      this.toggleAddMenu(false);
      app.pickFolder();
    });
    $('empty-add').addEventListener('click', () => app.pickFiles());
    $('empty-folder').addEventListener('click', () => app.pickFolder());
    $('brand').addEventListener('click', () => {
      if (app.reader.isOpen) app.reader.close();
      this.closePanel();
    });
    $('theme-btn').addEventListener('click', () => app.cycleTheme());
    $('settings-btn').addEventListener('click', () => {
      if (this.panelMode === 'settings') this.closePanel();
      else this.openSettings();
    });
    $('sort-btn').addEventListener('click', () => this.toggleArrangePop());
    this.initArrangePop();
    $('details-btn').addEventListener('click', () => {
      if (this.panelMode === 'details') this.closePanel();
      else this.openDetails(app.currentMeta());
    });
    $('now-btn').addEventListener('click', () => {
      if (this.panelMode === 'index') this.closePanel();
      else this.openIndex();
    });
    $('panel-close').addEventListener('click', () => this.closePanel());

    // reader bar
    const r = () => app.reader;
    $('rb-prev').addEventListener('click', () => r().prev());
    $('rb-next').addEventListener('click', () => r().next());
    $('rb-close').addEventListener('click', () => r().close());
    $('rb-bookmark').addEventListener('click', () => r().toggleBookmark());
    $('rb-back').addEventListener('click', () => r().returnToFinger());
    $('flag-tip').addEventListener('click', () => this.flagTipGo && this.flagTipGo());
    $('rb-undo').addEventListener('click', () => r().undo());
    $('rb-mag').addEventListener('click', () => app.toggleMagnifier());
    this.initLightPop();
    for (const id of ['rb-pink', 'rb-yellow', 'rb-pen', 'rb-pencil', 'rb-eraser']) {
      const b = $(id);
      const tool = b.dataset.tool;
      b.title = 'Hold for settings';
      // press and hold (or right-click) a tool for its settings; a plain tap picks it up / puts it down
      let timer = 0;
      let held = false;
      const clear = () => clearTimeout(timer);
      b.addEventListener('pointerdown', () => {
        held = false;
        clear();
        timer = setTimeout(() => {
          held = true;
          this.toolSettings(tool);
        }, 420);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, clear);
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        clear();
        held = true;
        this.toolSettings(tool);
      });
      b.addEventListener('click', () => {
        if (held) held = false;
        else this.toolTap(tool);
      });
    }
    this.initInkPop();
    $('rb-pages').addEventListener('click', () => this.toggleGoto());
    const range = $('goto-range');
    const num = $('goto-num');
    range.addEventListener('input', () => (num.value = range.value));
    num.addEventListener('input', () => (range.value = num.value));
    const go = () => {
      const p = parseInt(num.value, 10);
      if (Number.isFinite(p)) r().goToPage(p);
      this.toggleGoto(false);
    };
    $('goto-go').addEventListener('click', go);
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      e.stopPropagation();
    });
    range.addEventListener('change', go);
  }

  // ------------------------------------------------------------------ metrics for the reading layout
  readTop() {
    const m = this.track.getBoundingClientRect();
    return Math.max(70, m.top + m.height * 0.42);
  }
  readBottom() {
    const bar = $('readerbar').getBoundingClientRect();
    return Math.max(80, window.innerHeight - bar.top + 10);
  }

  // ------------------------------------------------------------------ the title row
  // Every title of the shelf in a row that glides with it, the selected one upright and dark, the others
  // italic and grey. While a book is open the row steps back (CSS, body[data-mode='reading']): the neighbours
  // part and fade, the open book's title shrinks up into the line above the book, like a running head.
  setTitles(metas) {
    this.track.textContent = '';
    this.titles = metas.map((m) => {
      const el = document.createElement('span');
      el.className = 't';
      const pages = m.pages ? `${m.pages} pp` : '';
      el.innerHTML = `<span class="ti">${esc(m.title)}<sup>(${esc(pages)})</sup></span>`;
      this.track.appendChild(el);
      return { el, w: [0, 0], x: 0 };
    });
    this.measureTitles();
    this.lastP = null;
  }

  measureTitles() {
    for (const t of this.titles) {
      t.el.classList.remove('on');
      t.w[0] = t.el.offsetWidth;
      t.el.classList.add('on');
      t.w[1] = t.el.offsetWidth;
      t.el.classList.remove('on');
    }
    this.gap = Math.max(24, (this.titles[0] ? this.titles[0].el.offsetHeight : 60) * 0.42);
    this.lastP = null;
  }

  updateTitles(p, sel) {
    if (!this.titles.length) return;
    if (this.lastP !== null && Math.abs(this.lastP - p) < 1e-4 && this.lastSel === sel) return;
    this.lastP = p;
    this.lastSel = sel;
    let x = 0;
    const centers = [];
    this.titles.forEach((t, i) => {
      const on = i === sel;
      t.el.classList.toggle('on', on);
      // which side of the selected title it stands on (they part that way when a book opens)
      t.el.classList.toggle('l', i < sel);
      t.el.classList.toggle('r', i > sel);
      const w = t.w[on ? 1 : 0];
      t.x = x;
      t.el.style.transform = `translateX(${x}px)`;
      centers.push(x + w / 2);
      x += w + this.gap;
    });
    const n = this.titles.length;
    const pc = clamp(p, 0, n - 1);
    const i0 = Math.floor(pc);
    const i1 = Math.min(n - 1, i0 + 1);
    const c = centers[i0] + (centers[i1] - centers[i0]) * (pc - i0);
    this.track.style.transform = `translateX(${window.innerWidth / 2 - c}px)`;
  }

  // ------------------------------------------------------------------ footer, counts, empty
  /** (The selected book's title lives in the title row alone; kept for callers.) */
  setNow() {}

  setCount(n) {
    $('count').textContent = `[ ${n} ${n === 1 ? 'BOOK' : 'BOOKS'} ]`;
    $('empty').hidden = n > 0;
    $('details-btn').disabled = n === 0;
  }

  setSortLabel(label) {
    $('sort-btn').textContent = `[ ${label} ]`;
  }

  setTheme(theme, look) {
    this.body.dataset.theme = theme;
    const btn = $('theme-btn');
    btn.setAttribute('aria-label', `Theme: ${theme}`);
    if (theme === 'color' && look) {
      const { bg, fg } = themePalette(look);
      this.body.style.setProperty('--bg', bg);
      this.body.style.setProperty('--fg', fg);
    } else {
      this.body.style.removeProperty('--bg');
      this.body.style.removeProperty('--fg');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(this.body).getPropertyValue('--bg').trim() || '#e8e7e0';
  }

  setReading(on) {
    this.body.dataset.mode = on ? 'reading' : 'shelf';
    this.toggleAddMenu(false);
    $('readerbar').hidden = !on;
    if (!on) this.closePopovers();
    this.pokeChrome();
  }

  // ------------------------------------------------------------------ the bars over a book (Reading view: Full)
  // While a book fills the screen, the top bar, the title row, the reader bar and the footer float over it and fade
  // after a few seconds of reading. They come back for a tap in the middle of the page, a touch at the top or bottom
  // edge, the mouse near either, or a key; they stay while a panel, a menu or a tool is open, the mouse is on them,
  // or the book isn't open yet. Turning a page lets them go.
  setChrome(shown) {
    if (shown) delete this.body.dataset.chrome;
    else this.body.dataset.chrome = 'hidden';
  }

  get chromeHidden() {
    return this.body.dataset.chrome === 'hidden';
  }

  /** Show the bars, and let them fade after `ms` of quiet. */
  pokeChrome(ms = 3200) {
    this.setChrome(true);
    clearTimeout(this.chromeT);
    if (this.app.fullView && this.body.dataset.mode === 'reading') this.chromeT = setTimeout(() => this.restChrome(), ms);
  }

  /** Let the bars fade now, unless something holds them. */
  restChrome() {
    clearTimeout(this.chromeT);
    if (!this.app.fullView || this.body.dataset.mode !== 'reading') return this.setChrome(true);
    if (this.chromeHeld()) {
      this.chromeT = setTimeout(() => this.restChrome(), 1200);
      return;
    }
    this.setChrome(false);
  }

  toggleChrome() {
    if (this.chromeHidden) this.pokeChrome();
    else if (!this.chromeHeld()) {
      clearTimeout(this.chromeT);
      this.setChrome(false);
    }
  }

  chromeHeld() {
    const r = this.app.reader;
    if (this.panelMode || this.chromeHover) return true;
    if (['add-menu', 'goto', 'light-pop', 'ink-pop', 'arrange-pop'].some((id) => !$(id).hidden)) return true;
    return !r || !r.isOpen || r.phase !== 'reading' || !!r.tool;
  }

  initChrome() {
    for (const el of [document.querySelector('.top'), document.querySelector('.bottom'), $('readerbar')]) {
      if (!el) continue;
      el.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.chromeHover = true;
      });
      el.addEventListener('pointerleave', () => {
        this.chromeHover = false;
        if (this.app.fullView && this.body.dataset.mode === 'reading') this.pokeChrome(1800);
      });
    }
  }


  // ------------------------------------------------------------------ reader bar
  updateReaderBar(s) {
    $('rb-left').textContent = s.left ?? '—';
    $('rb-right').textContent = s.right ?? '—';
    $('rb-bookmark').setAttribute('aria-pressed', String(s.bookmarked));
    $('rb-prev').disabled = !s.canPrev;
    $('rb-next').disabled = !s.canNext;
    $('rb-undo').disabled = !s.undo;
    for (const [id, tool] of [
      ['rb-pink', 'pink'],
      ['rb-yellow', 'yellow'],
      ['rb-pen', 'pen'],
      ['rb-pencil', 'pencil'],
      ['rb-eraser', 'eraser'],
    ])
      $(id).setAttribute('aria-pressed', String(s.tool === tool));
    this.barState = s;
    if (!$('goto').hidden) this.syncGoto();
  }

  /** After a jump: page `page` is where you were reading, to go back to (null: you are there). */
  setFinger(page) {
    const b = $('rb-back');
    b.hidden = page == null;
    if (page != null) {
      $('rb-back-p').textContent = page;
      b.setAttribute('aria-label', `Back to page ${page}, where you were reading`);
      b.title = 'Back to where you were reading (R)';
    }
  }

  // ------------------------------------------------------------------ a raised flag's label
  showFlagTip(flag, go) {
    const t = $('flag-tip');
    t.querySelector('.ft-p').textContent = `Bookmark · p. ${flag.page}`;
    t.querySelector('.ft-h').textContent = this.app.reader.isOpen ? 'Tap again to go there' : 'Tap again to open here';
    t.setAttribute('aria-label', `Go to page ${flag.page}`);
    this.flagTipGo = go;
    t.hidden = false;
    t.classList.remove('on');
    this.flagTipShown = false;
  }

  hideFlagTip() {
    const t = $('flag-tip');
    t.hidden = true;
    t.classList.remove('on');
    this.flagTipGo = null;
  }

  /** Beside the flag (to its right, or its left near the screen's edge), level with its top. */
  placeFlagTip(box) {
    const t = $('flag-tip');
    if (t.hidden) return;
    const w = t.offsetWidth;
    const right = box.r + 10 + w < window.innerWidth - 8;
    const x = right ? box.r + 10 : box.l - 10 - w;
    const y = clamp(box.t - 4, 8, window.innerHeight - 60);
    t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    t.classList.toggle('right', right);
    t.classList.toggle('left', !right);
    if (!this.flagTipShown) {
      this.flagTipShown = true;
      requestAnimationFrame(() => t.classList.add('on'));
    }
  }

  setMagnifier(on) {
    $('rb-mag').setAttribute('aria-pressed', String(on));
    $('rb-mag').setAttribute('aria-label', on ? 'Turn off magnifier' : 'Turn on magnifier');
  }

  // ------------------------------------------------------------------ reading light
  initLightPop() {
    const app = this.app;
    const pop = $('light-pop');
    const L = () => app.lighting;
    $('light-btn').addEventListener('click', () => this.toggleLightPop());
    $('lp-done').addEventListener('click', () => this.toggleLightPop(false));
    pop.querySelectorAll('[data-light]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.light;
        L().setChoice(id);
        // with a room light on, choosing another room light switches over to it
        if (!LIGHTS[id].timer && L().room && L().room !== id) L().toggle(id, true);
        this.buildLightPop();
      }),
    );
    for (const k of ['warmth', 'time', 'brightness', 'liveliness'])
      $(`lp-${k}`).addEventListener('input', (e) => {
        L().set(L().choice, k, parseFloat(e.target.value));
        this.syncLightValues();
      });
    $('lp-clock').addEventListener('click', () => {
      const id = L().choice;
      L().set(id, 'clock', !L().settings(id).clock);
      this.syncLightValues();
    });
    pop.querySelectorAll('[data-side]').forEach((b) =>
      b.addEventListener('click', () => {
        L().set(L().choice, 'side', parseInt(b.dataset.side, 10));
        this.syncLightValues();
      }),
    );
    $('lp-toggle').addEventListener('click', () => {
      L().toggle(L().choice);
      this.syncLight(L());
    });
    pop.querySelectorAll('[data-min]').forEach((b) =>
      b.addEventListener('click', () => {
        L().lightCandle(parseInt(b.dataset.min, 10));
        this.syncLight(L());
        this.toggleLightPop(false);
      }),
    );
    pop.querySelector('[data-act="more"]').addEventListener('click', () => {
      L().addCandleTime(5);
      this.syncLight(L());
    });
    pop.querySelector('[data-act="snuff"]').addEventListener('click', () => {
      L().snuffCandle();
      this.syncLight(L());
      this.toggleLightPop(false);
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
    });
  }

  toggleLightPop(force) {
    const el = $('light-pop');
    const show = force ?? el.hidden;
    el.hidden = !show;
    $('light-btn').setAttribute('aria-expanded', String(show));
    if (show) {
      this.toggleGoto(false);
      this.toggleInkPop(false);
      if (!$('arrange-pop').hidden) this.toggleArrangePop(false);
      this.buildLightPop();
    }
  }

  buildLightPop() {
    const L = this.app.lighting;
    const id = L.choice;
    const def = LIGHTS[id];
    $('light-pop').querySelectorAll('[data-light]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.light === id)));
    $('lp-note').textContent = def.note;
    const rows = { warmth: !!def.warmth, time: !!def.time, clock: !!def.time, brightness: true, side: true, liveliness: !!def.liveliness };
    $('light-pop').querySelectorAll('.ip-row').forEach((r) => (r.hidden = !rows[r.dataset.k]));
    const range = (k, [lo, hi]) => {
      $(`lp-${k}`).min = lo;
      $(`lp-${k}`).max = hi;
    };
    if (def.warmth) range('warmth', def.warmth);
    range('brightness', def.brightness);
    if (def.liveliness) range('liveliness', def.liveliness);
    const s = L.settings(id);
    for (const k of ['warmth', 'time', 'brightness', 'liveliness']) if (s[k] != null) $(`lp-${k}`).value = s[k];
    $('lp-brightness-l').textContent = { candle: 'Brightness', oil: 'Wick', desk: 'Dimmer', fire: 'Fire', sun: 'Sun', rain: 'Daylight' }[id];
    $('lp-liveliness-l').textContent = { candle: 'Flicker', oil: 'Flicker', fire: 'Flames', sun: 'Breeze', rain: 'Rain' }[id] || 'Liveliness';
    this.syncLightValues();
    this.syncLight(L);
  }

  syncLightValues() {
    const id = this.app.lighting.choice;
    const s = this.app.lighting.settings(id);
    const pct = (x) => `${Math.round(x * 100)}%`;
    if (s.warmth != null) $('lp-warmth-v').textContent = `${Math.round(s.warmth / 50) * 50} K`;
    if (s.time != null) {
      const h = s.clock ? new Date().getHours() + new Date().getMinutes() / 60 : s.time;
      $('lp-time-v').textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
      $('lp-time').disabled = !!s.clock;
      $('lp-clock').setAttribute('aria-checked', String(!!s.clock));
    }
    $('lp-brightness-v').textContent = pct(s.brightness);
    if (s.liveliness != null) $('lp-liveliness-v').textContent = s.liveliness < 0.03 ? 'Still' : pct(s.liveliness);
    $('light-pop').querySelectorAll('[data-side]').forEach((b) => b.setAttribute('aria-checked', String(parseInt(b.dataset.side, 10) === (s.side >= 0 ? 1 : -1))));
  }

  setLightIcon(id) {
    const b = $('light-pop').querySelector(`[data-light="${id}"] svg`);
    if (b) $('light-icon').innerHTML = b.innerHTML;
  }

  /** Header button and popover state (a couple of times a second while the candle burns). */
  syncLight(L) {
    const candle = L.candleLit;
    const room = L.room;
    // the header shows the room light that is on, else the candle (or the one last chosen)
    this.setLightIcon(room || (candle ? 'candle' : L.choice));
    const left = candle ? candle.remaining : 0;
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    const on = !!(room || candle);
    const btn = $('light-btn');
    btn.setAttribute('aria-pressed', String(on));
    const parts = [];
    if (room) parts.push(`${LIGHTS[room].label} on`);
    if (candle) parts.push(`candle, ${mm} minutes left`);
    btn.setAttribute('aria-label', on ? `Reading light: ${parts.join(', ')}` : 'Reading light');
    $('light-time').textContent = candle ? `${mm + (ss > 0 ? 1 : 0)}′` : '';
    const pop = $('light-pop');
    pop.querySelectorAll('[data-light]').forEach((b) => b.setAttribute('data-on', String(L.isOn(b.dataset.light))));
    const id = L.choice;
    const isCandle = !!LIGHTS[id].timer;
    pop.querySelector('.lp-candle-off').hidden = !isCandle || !!candle;
    pop.querySelector('.lp-candle-on').hidden = !isCandle || !candle;
    pop.querySelector('.lp-room').hidden = isCandle;
    if (candle) $('lp-left').textContent = `[ ${mm}:${String(ss).padStart(2, '0')} left ]`;
    if (!isCandle) {
      const isOn = room === id;
      const t = $('lp-toggle');
      t.textContent = `[ ${isOn ? LIGHTS[id].off : LIGHTS[id].on} ]`;
      t.setAttribute('aria-checked', String(isOn));
    }
  }

  toggleGoto(force) {
    const el = $('goto');
    const show = force ?? el.hidden;
    el.hidden = !show;
    if (show) {
      this.toggleInkPop(false);
      this.toggleLightPop(false);
      this.syncGoto();
    }
  }

  toggleAddMenu(force) {
    const el = $('add-menu');
    const show = force ?? el.hidden;
    el.hidden = !show;
    $('add-btn').setAttribute('aria-expanded', String(show));
    if (show) {
      this.toggleArrangePop(false);
      this.toggleLightPop(false);
    }
  }

  closePopovers() {
    if (!$('add-menu').hidden) this.toggleAddMenu(false);
    if (!$('goto').hidden) this.toggleGoto(false);
    if (!$('light-pop').hidden) this.toggleLightPop(false);
    if (!$('ink-pop').hidden) this.toggleInkPop(false);
    if (!$('arrange-pop').hidden) this.toggleArrangePop(false);
  }

  // ------------------------------------------------------------------ arranging the shelf
  initArrangePop() {
    const app = this.app;
    const make = (box, list, key) => {
      for (const o of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mono-btn';
        b.setAttribute('role', 'radio');
        b.dataset[key] = o.key;
        b.textContent = `[ ${o.label} ]`;
        b.addEventListener('click', () => {
          app.setArrangement({ [key]: o.key });
          this.syncArrangePop();
        });
        box.appendChild(b);
      }
    };
    make($('ap-group'), GROUPS, 'group');
    make($('ap-order'), ORDERS, 'order');
    make($('ap-plank'), PLANK_STYLES, 'plank');
    $('ap-done').addEventListener('click', () => this.toggleArrangePop(false));
    $('ap-reverse').addEventListener('click', () => {
      app.setArrangement({ reverse: !app.reverse });
      this.syncArrangePop();
    });
    const add = () => {
      const input = $('ap-new-shelf');
      const name = input.value.trim();
      if (!name) return input.focus();
      app.createShelf(name);
      input.value = '';
      this.syncArrangePop();
    };
    $('ap-add-shelf').addEventListener('click', add);
    $('ap-new-shelf').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') add();
    });
    $('arrange-pop').addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
    });
  }

  toggleArrangePop(force) {
    const el = $('arrange-pop');
    const show = (force ?? el.hidden) && !this.app.reader.isOpen;
    el.hidden = !show;
    $('sort-btn').setAttribute('aria-expanded', String(show));
    if (show) {
      this.toggleLightPop(false);
      this.toggleAddMenu(false);
      this.syncArrangePop();
    }
  }

  syncArrangePop() {
    const app = this.app;
    const on = (box, key, val) => box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset[key] === val)));
    on($('ap-group'), 'group', app.group);
    on($('ap-order'), 'order', app.sort);
    on($('ap-plank'), 'plank', app.plank);
    $('ap-reverse').setAttribute('aria-checked', String(app.reverse));
    const shelves = app.group === 'shelves';
    $('ap-shelves').hidden = !shelves;
    if (shelves) {
      const list = $('ap-shelf-list');
      list.textContent = '';
      app.shelves.forEach((s, i) => {
        const n = app.metas.filter((m) => m.shelf === s.id).length;
        const li = document.createElement('li');
        li.innerHTML = `<button type="button" class="open"><span>${esc(s.name)}</span><span class="pg">${n}</span></button><button type="button" class="mv" aria-label="Move up"${i ? '' : ' disabled'}>↑</button><button type="button" class="mv" aria-label="Move down"${i < app.shelves.length - 1 ? '' : ' disabled'}>↓</button>`;
        const [open, up, down] = li.querySelectorAll('button');
        open.addEventListener('click', () => {
          this.toggleArrangePop(false);
          const ri = app.shelf.rows.findIndex((r) => r.shelfId === s.id);
          if (ri >= 0) app.shelf.goToRow(ri);
          this.openShelfPanel(app.shelf.rows[ri] || { shelfId: s.id, label: s.name });
        });
        up.addEventListener('click', () => {
          app.moveShelf(s.id, -1);
          this.syncArrangePop();
        });
        down.addEventListener('click', () => {
          app.moveShelf(s.id, 1);
          this.syncArrangePop();
        });
        list.appendChild(li);
      });
      if (!app.shelves.length) list.innerHTML = '<li class="note">No shelves yet. Name one below, then give it books from its name here or a book’s details.</li>';
    }
    // labels and name plates hang on a plank's edge: without a plank there are none
    const plank = app.plank !== 'none';
    const notes = {
      none: 'One shelf, in the order you choose.',
      author: `A section for every author with two or more books; the others stand under their letter.${plank ? ' Tap a label on the shelf’s edge to go to its section.' : ' Their labels sit on a shelf’s edge: pick one under Shelf.'}`,
      letter: `A section for every first letter of the title.${plank ? ' Tap a label on the shelf’s edge to go to it.' : ' Their labels sit on a shelf’s edge: pick one under Shelf.'}`,
      status: 'Reading now, not started, finished.',
      shelves: `A bookcase of your own shelves, one shelf per book. Swipe up and down between them; ${plank ? 'tap a shelf’s name plate (or its name here)' : 'tap a shelf’s name here'} to rename it or choose its books.`,
    };
    let note = notes[app.group] || '';
    if (app.sort === 'manual') note += ' Press and hold a book to carry it to a new place.';
    else note += ' Press and hold a book to move it by hand.';
    $('ap-note').textContent = note;
  }

  /** A shelf of the bookcase: its name, its place, which books stand on it. */
  openShelfPanel(row) {
    const app = this.app;
    this.toggleArrangePop(false);
    const s = app.shelves.find((x) => x.id === row.shelfId);
    const books = [...app.metas].sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true }));
    const nameOf = (id) => (app.shelves.find((x) => x.id === id) || {}).name;
    if (!s) {
      // the books that stand on no shelf yet
      this.openPanel(
        'details',
        '[ SHELF ]',
        `<section><h2>${esc(row.label || 'Not on a shelf')}</h2><p class="byline">+ ${books.filter((m) => !m.shelf).length} books +</p></section>
         <section><p class="note">Books you haven't put on one of your shelves stand here. Give them a shelf from a shelf's name plate, or from a book's details.</p></section>
         <section><span class="k">[ New shelf ]</span><div class="new-shelf-row"><input class="field" id="f-new-shelf" placeholder="Name" autocomplete="off"><button type="button" class="mono-btn" data-act="create">[ CREATE ]</button></div></section>`,
      );
      const input = this.panelBody.querySelector('#f-new-shelf');
      const create = () => {
        const v = input.value.trim();
        if (!v) return input.focus();
        const ns = app.createShelf(v);
        this.openShelfPanel({ shelfId: ns.id, label: ns.name });
      };
      this.panelBody.querySelector('[data-act="create"]').addEventListener('click', create);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') create();
      });
      return;
    }
    const count = app.metas.filter((m) => m.shelf === s.id).length;
    const secs = sectionsOf(app.metas, s.id);
    this.openPanel(
      'details',
      '[ SHELF ]',
      `<section><h2>${esc(s.name)}</h2><p class="byline">+ ${count} ${count === 1 ? 'book' : 'books'} +</p></section>
       <section><span class="k">[ Name ]</span><input class="field" id="f-shelf-name" value="${esc(s.name)}" aria-label="Shelf name" autocomplete="off"></section>
       <section><span class="k">[ Sections ]</span>${
         secs.length
           ? `<p class="note">Rename a section here; clear its name to let its books stand loose. To move a book between sections, carry it over the gap (press and hold), or set it in the book's details.</p>${secs
               .map((x) => `<input class="field sec-name" data-sec="${esc(x)}" value="${esc(x)}" aria-label="Section name" autocomplete="off">`)
               .join('')}`
           : '<p class="note">No sections. An added folder\'s subfolders become sections; you can also name a book\'s section in its details.</p>'
       }</section>
       <section><span class="k">[ Books on this shelf ]</span><p class="note">A book stands on one shelf: ticking it here takes it off its other shelf.</p>
         <ul class="list check-list">${books
           .map((m) => `<li><label><input type="checkbox" data-id="${esc(m.id)}"${m.shelf === s.id ? ' checked' : ''}><span>${esc(m.title)}</span>${m.shelf && m.shelf !== s.id ? `<span class="dim">on ${esc(nameOf(m.shelf) || 'another shelf')}</span>` : ''}</label></li>`)
           .join('')}</ul></section>
       <section class="panel-actions">
         <button type="button" class="mono-btn danger" data-act="delete">[ REMOVE SHELF ]</button>
         <div id="confirm-delete" hidden><p class="note">Remove the shelf “${esc(s.name)}”? Its books stay in your library, on no shelf.</p>
           <div class="seg"><button type="button" class="mono-btn danger" data-act="delete-yes">[ YES, REMOVE IT ]</button><button type="button" class="mono-btn" data-act="delete-no">[ KEEP IT ]</button></div></div>
       </section>`,
    );
    const body = this.panelBody;
    body.querySelectorAll('.sec-name').forEach((f) => {
      f.addEventListener('change', async () => {
        await app.renameSection(s.id, f.dataset.sec, f.value);
        f.dataset.sec = f.value.trim();
      });
      f.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') f.blur();
      });
    });
    const name = body.querySelector('#f-shelf-name');
    name.addEventListener('change', () => {
      app.renameShelf(s.id, name.value);
      body.querySelector('h2').textContent = s.name;
    });
    name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') name.blur();
    });
    body.querySelectorAll('input[type="checkbox"]').forEach((c) =>
      c.addEventListener('change', async () => {
        const m = app.metas.find((x) => x.id === c.dataset.id);
        if (!m) return;
        await app.setBookShelf(m, c.checked ? s.id : null);
        const tag = c.closest('label').querySelector('.dim');
        if (tag && c.checked) tag.remove();
        const n = app.metas.filter((x) => x.shelf === s.id).length;
        body.querySelector('.byline').textContent = `+ ${n} ${n === 1 ? 'book' : 'books'} +`;
      }),
    );
    body.querySelector('[data-act="delete"]').addEventListener('click', () => (body.querySelector('#confirm-delete').hidden = false));
    body.querySelector('[data-act="delete-no"]').addEventListener('click', () => (body.querySelector('#confirm-delete').hidden = true));
    body.querySelector('[data-act="delete-yes"]').addEventListener('click', async () => {
      this.closePanel();
      await app.deleteShelf(s.id);
      this.toast(`Removed the shelf “${s.name}”`, 2400);
    });
  }

  // ------------------------------------------------------------------ pen & highlighter settings
  /** Tap: pick a tool up or put it down. With the settings open, a tap shows that tool's settings instead. */
  toolTap(tool) {
    const r = this.app.reader;
    if (!$('ink-pop').hidden) {
      if (this.inkTool === tool) this.toggleInkPop(false);
      else this.toolSettings(tool);
      return;
    }
    r.setTool(tool);
    if (r.tool === tool) this.settingsHint();
  }

  /** Hold: pick the tool up (if it isn't already) and open its settings. */
  toolSettings(tool) {
    const r = this.app.reader;
    if (r.tool !== tool) r.setTool(tool);
    this.toggleInkPop(true, tool);
  }

  settingsHint() {
    try {
      if (localStorage.getItem('folio.hint.ink')) return;
      localStorage.setItem('folio.hint.ink', '1');
    } catch {
      return;
    }
    this.toast('Press and hold a tool for its thickness, pressure and colour', 3400);
  }

  toggleInkPop(force, tool = this.inkTool) {
    const el = $('ink-pop');
    const show = (force ?? el.hidden) && !!tool;
    el.hidden = !show;
    for (const id of ['rb-pink', 'rb-yellow', 'rb-pen', 'rb-pencil', 'rb-eraser']) $(id).setAttribute('aria-expanded', String(show && $(id).dataset.tool === tool));
    if (!show) return;
    this.toggleGoto(false);
    this.toggleLightPop(false);
    this.inkTool = tool;
    this.buildInkPop();
  }

  initInkPop() {
    const pop = $('ink-pop');
    $('ip-done').addEventListener('click', () => this.toggleInkPop(false));
    $('ip-reset').addEventListener('click', () => {
      inkSettings.reset(this.inkTool);
      this.buildInkPop();
    });
    const sliders = { size: 'ip-size', pressure: 'ip-pressure', opacity: 'ip-opacity', smooth: 'ip-smooth' };
    for (const [k, id] of Object.entries(sliders))
      $(id).addEventListener('input', (e) => {
        inkSettings.set(this.inkTool, k, parseFloat(e.target.value));
        this.syncInkPop();
      });
    pop.querySelectorAll('[data-tip]').forEach((b) =>
      b.addEventListener('click', () => {
        inkSettings.set(this.inkTool, 'tip', b.dataset.tip);
        this.syncInkPop();
      }),
    );
    pop.querySelectorAll('[data-grade]').forEach((b) => {
      const g = PENCIL_GRADES.find((x) => x.id === b.dataset.grade);
      b.title = g.name;
      b.addEventListener('click', () => {
        inkSettings.set('pencil', 'grade', b.dataset.grade);
        this.buildInkPop(); // the graphite swatch takes the lead's grey
      });
    });
    // keep keys typed into the sliders away from the reader's shortcuts
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
    });
    inkSettings.onChange(() => this.syncInkSwatches());
    this.syncInkSwatches();
  }

  buildInkPop() {
    const tool = this.inkTool;
    const kind = tool === 'eraser' ? 'eraser' : TOOL_KIND[tool];
    const st = inkSettings.get(tool);
    const names = { pen: 'Pen', pencil: 'Pencil', marker: 'Highlighter', eraser: 'Eraser' };
    $('ip-title').textContent = `[ ${names[kind]} ]`;
    const show = {
      color: kind !== 'eraser',
      size: true,
      pressure: kind !== 'eraser',
      opacity: kind === 'marker',
      smooth: kind !== 'eraser',
      tip: kind === 'marker',
      grade: kind === 'pencil',
    };
    $('ink-pop').querySelectorAll('.ip-row').forEach((row) => (row.hidden = !show[row.dataset.k]));
    // colours
    const box = $('ip-colors');
    box.textContent = '';
    if (show.color) {
      const list = kind === 'pen' ? PEN_COLORS : kind === 'pencil' ? PENCIL_COLORS : MARKER_COLORS;
      const lead = inkSettings.pencilGrade();
      for (const c of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', c.name);
        b.dataset.color = c.id;
        const i = document.createElement('i');
        i.style.setProperty('--sw', c.rgb ? c.ui || `rgb(${c.rgb.join(',')})` : `rgb(${lead.rgb.map((v) => Math.round(v + (255 - v) * 0.18)).join(',')})`);
        b.appendChild(i);
        b.addEventListener('click', () => {
          inkSettings.set(tool, 'color', c.id);
          this.syncInkPop();
        });
        box.appendChild(b);
      }
    }
    const rng = RANGES[kind];
    const size = $('ip-size');
    size.min = rng.size[0];
    size.max = rng.size[1];
    size.value = st.size;
    if (show.opacity) {
      $('ip-opacity').min = rng.opacity[0];
      $('ip-opacity').max = rng.opacity[1];
      $('ip-opacity').value = st.opacity;
    }
    if (show.pressure) $('ip-pressure').value = st.pressure;
    if (show.smooth) $('ip-smooth').value = st.smooth;
    $('ip-note').textContent =
      kind === 'eraser'
        ? 'Touch a mark to lift it off the page.'
        : kind === 'pencil'
          ? 'Press harder for a darker line. Lay the Pencil low to shade with the side of the lead.'
          : this.app.penSeen
          ? 'Pressure follows the Apple Pencil; fingers draw at an even weight.'
          : 'With an Apple Pencil the line follows how hard you press. Fingers and mice draw at an even weight.';
    this.syncInkPop();
  }

  syncInkPop() {
    const tool = this.inkTool;
    if (!tool || $('ink-pop').hidden) return;
    const st = inkSettings.get(tool);
    const pct = (x) => `${Math.round(x * 100)}%`;
    $('ip-size-v').textContent = `${st.size.toFixed(1)}×`;
    if (st.pressure != null) $('ip-pressure-v').textContent = st.pressure > 0 ? pct(st.pressure) : 'Off';
    if (st.opacity != null) $('ip-opacity-v').textContent = pct(st.opacity);
    if (st.smooth != null) $('ip-smooth-v').textContent = st.smooth > 0 ? pct(st.smooth) : 'Off';
    $('ip-colors').querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === st.color)));
    $('ink-pop').querySelectorAll('[data-tip]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tip === st.tip)));
    $('ink-pop').querySelectorAll('[data-grade]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.grade === st.grade)));
    this.drawInkPreview();
  }

  /** A sample line on a scrap of printed paper, at roughly the size it will have on the page. */
  drawInkPreview() {
    const cv = $('ip-preview');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 360;
    const h = cv.clientHeight || 74;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#f2f0ea';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const tool = this.inkTool;
    const kind = tool === 'eraser' ? 'eraser' : TOOL_KIND[tool];
    const pageW = Math.min(700, window.innerWidth * 0.42) * dpr; // a page's width on screen, about
    // a few lines of "type"
    ctx.fillStyle = 'rgba(40,36,30,0.38)';
    const lh = 0.0118 * pageW * 1.55;
    for (let y = cv.height * 0.5 - lh * 1.5, i = 0; i < 4; i++, y += lh) {
      let x = cv.width * 0.04;
      const seed = [0.21, 0.13, 0.17, 0.09, 0.14, 0.2, 0.11, 0.16, 0.12];
      for (let k = 0; x < cv.width * 0.96; k++) {
        const ww = seed[(k + i * 3) % seed.length] * pageW * 0.42;
        ctx.fillRect(x, y - lh * 0.22, Math.min(ww, cv.width * 0.96 - x), lh * 0.42);
        x += ww + lh * 0.45;
      }
    }
    if (kind === 'eraser') {
      const r = 0.018 * inkSettings.get('eraser').size * pageW;
      ctx.strokeStyle = 'rgba(25,23,21,0.8)';
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.arc(cv.width / 2, cv.height / 2, r, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    const s = makeStroke(tool);
    const sens = inkSettings.get(tool).pressure;
    const n = 90;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = cv.width * (0.06 + 0.88 * t);
      const y = kind !== 'marker' ? cv.height * (0.5 + 0.26 * Math.sin(t * Math.PI * 3.2)) : cv.height * 0.5 - lh * 0.05 + Math.sin(t * 7) * lh * 0.06;
      // a stroke as a Pencil draws it: light in, firm through the middle, lifting off
      const p = 0.06 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      const f = pointFactors(tool, p, sens);
      s.pts.push(x / pageW, y / pageW);
      s.wf.push(f.wf);
      if (s.gf) s.gf.push(f.gf);
    }
    ctx.save();
    if (kind !== 'pen') ctx.globalCompositeOperation = 'multiply';
    drawStroke(ctx, s, pageW, pageW);
    ctx.restore();
  }

  /** The reader bar's highlighter swatches and pen show the chosen inks. */
  syncInkSwatches() {
    for (const tool of ['pink', 'yellow']) {
      const c = inkSettings.markerColor(tool);
      const b = $(`rb-${tool}`);
      b.querySelector('i').style.setProperty('--ink', c.ui);
      b.setAttribute('aria-label', `${c.name} highlighter`);
    }
    const pc = inkSettings.penColor();
    $('rb-pen').style.color = pc.id === 'ink' ? '' : `rgb(${pc.rgb.join(',')})`;
    const gc = inkSettings.pencilColor();
    $('rb-pencil').style.color = gc.rgb ? `rgb(${gc.rgb.join(',')})` : '';
  }
  syncGoto() {
    const s = this.barState;
    if (!s) return;
    const range = $('goto-range');
    const num = $('goto-num');
    range.max = s.pages;
    num.max = s.pages;
    const cur = s.right || s.left || 1;
    range.value = cur;
    num.value = cur;
    $('goto-of').textContent = `/ ${s.pages}`;
  }

  nudge(which) {
    this.toast(which === 'end' ? 'End of the book' : 'Front cover');
  }

  // ------------------------------------------------------------------ toast
  toast(msg, ms = 2200) {
    const t = this.toastEl;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => t.classList.remove('on'), ms);
  }

  // ------------------------------------------------------------------ panel
  openPanel(mode, kicker, html) {
    this.panelMode = mode;
    $('panel-kicker').textContent = kicker;
    this.panelBody.innerHTML = html;
    this.panel.hidden = false;
    this.panelBody.scrollTop = 0;
  }

  closePanel() {
    this.panel.hidden = true;
    this.panelMode = null;
    $('details-btn').textContent = 'VIEW DETAILS [+]';
  }

  // ------------------------------------------------------------------ settings
  /** The app's settings: the library's paper, wear as you read, binding for new books, storage, keys. */
  openSettings() {
    const app = this.app;
    this.openPanel(
      'settings',
      '[ SETTINGS ]',
      `<section><span class="k">[ Paper ]</span>
         <p class="note">The paper of every book that hasn't one of its own. A book's own paper is set in its details.</p>
         <div id="pe-lib"></div></section>
       <section><span class="k">[ Paper surface ]</span>
         <div class="seg"><button type="button" class="mono-btn" data-psrc="sim" aria-pressed="${app.shared.paper.source === 'sim'}">Simulated</button><button type="button" class="mono-btn" data-psrc="classic" aria-pressed="${app.shared.paper.source === 'classic'}">Classic</button></div>
         <p class="note">Simulated: each paper's fibres, formation, marks and finish made from how that paper is made, in Blender. Classic: the surfaces Folio drew before.</p></section>
       <section><span class="k">[ Reading view ]</span>
         <div class="seg"><button type="button" class="mono-btn" data-view="full" aria-pressed="${app.fullView}">Full</button><button type="button" class="mono-btn" data-view="framed" aria-pressed="${!app.fullView}">Framed</button></div>
         <p class="note">Full: an open book fills the screen and reads alone (the shelf is hidden, which also makes reading lighter work for the iPad); the bars float over it and fade while you read. Tap the middle of the page, or touch the top or bottom edge, to bring them back. Framed: the book between the bars with the shelf beside it, as before.</p></section>
       <section><span class="k">[ Turning ]</span>
         <div class="seg"><button type="button" class="mono-btn" data-turn="peel" data-on="1" aria-pressed="${app.cornerPeel}">Peel</button><button type="button" class="mono-btn" data-turn="peel" data-on="0" aria-pressed="${!app.cornerPeel}">Classic</button><span class="mono dim">Corners</span></div>
         <p class="note">Peel: a leaf lifts where you take hold of it. A corner peels off diagonally and the leaf rolls into a cone as it turns; held near the spine it bends softer.</p>
         <div class="seg"><button type="button" class="mono-btn" data-turn="flop" data-on="1" aria-pressed="${app.freeLeaf}">Physical</button><button type="button" class="mono-btn" data-turn="flop" data-on="0" aria-pressed="${!app.freeLeaf}">Classic</button><span class="mono dim">Leaf in the air</span></div>
         <p class="note">Physical: let go of a leaf and its edge flops under its own weight; it trails in the air and, as the leaf lands, whips over and slaps down. Supple paper flops more.</p>
         <div class="seg"><button type="button" class="mono-btn" data-turn="catch" data-on="1" aria-pressed="${app.catchLeaf}">On</button><button type="button" class="mono-btn" data-turn="catch" data-on="0" aria-pressed="${!app.catchLeaf}">Off</button><span class="mono dim">Catch a leaf</span></div>
         <p class="note">Touch a leaf in the air and it stops; hold it a moment, or pull it back, and it is in your hand. A swipe on with it, or a quick tap, still turns the next page.</p>
         <div class="seg"><button type="button" class="mono-btn" data-turn="clump" data-on="1" aria-pressed="${app.clumpTurns}">Clump</button><button type="button" class="mono-btn" data-turn="clump" data-on="0" aria-pressed="${!app.clumpTurns}">Fan</button><span class="mono dim">Several leaves</span></div>
         <p class="note">Clump: a jump of more than three leaves (a bookmark, the contents, a page number) turns as one block, bound at the spine, lifted by its top leaf. Fan: they fly one after another.</p>
         <div class="seg"><button type="button" class="mono-btn" data-turn="riffle" data-on="1" aria-pressed="${app.riffle}">On</button><button type="button" class="mono-btn" data-turn="riffle" data-on="0" aria-pressed="${!app.riffle}">Off</button><span class="mono dim">Riffle and gather</span></div>
         <p class="note">Put a finger on a page's outer edge and slide along it: leaves flick past like a flipbook. Hold it there a moment first, then slide down: you gather a block of leaves, more the further you slide; turn it toward the spine and let go. </p>
         <div class="seg"><button type="button" class="mono-btn" data-turn="settle" data-on="1" aria-pressed="${app.settleOpen}">Settle</button><button type="button" class="mono-btn" data-turn="settle" data-on="0" aria-pressed="${!app.settleOpen}">Classic</button><span class="mono dim">Opening</span></div>
         <p class="note">Settle: as a book lands open, its top leaves spring up a little from the spine and settle back onto their stacks, one after another.</p>
         <div class="seg"><button type="button" class="mono-btn" data-turn="pphys" data-on="1" aria-pressed="${app.paperPhysics}">Own</button><button type="button" class="mono-btn" data-turn="pphys" data-on="0" aria-pressed="${!app.paperPhysics}">Classic</button><span class="mono dim">Paper</span></div>
         <p class="note">Own: each paper moves as it is made, from its weight and stiffness. Bible paper floats down slowly and flutters, newsprint is limp, coated paper falls heavy, a card turns stiffly; a book's weight setting changes it too. Classic and Off are the turning Folio had.</p></section>
       <section><span class="k">[ Wear ]</span>
         <div class="seg"><button type="button" class="mono-btn" id="st-wear" aria-pressed="${app.livingWear}">${app.livingWear ? '[ ON ]' : '[ OFF ]'}</button><span class="mono dim">Books wear as you read them</span></div>
         <p class="note">The leaves you turn pick up a little finger soil at their corners, and a book grows softer and a touch wavier the more it is read. Off, a book is as worn as its paper's Wear says.</p></section>
       <section><span class="k">[ Binding for new books ]</span>
         <div class="seg">${Object.entries(BINDINGS)
           .map(([k, b]) => `<button type="button" class="mono-btn" data-newbind="${k}" aria-pressed="${defaultBinding() === k}">${b.label}</button>`)
           .join('')}</div></section>
       <section><span class="k">[ Storage ]</span><p class="note" id="st-storage">Checking…</p></section>
       <section><span class="k">[ Keys ]</span><div class="facts">
         <span>← →</span><span>Browse / turn pages</span>
         <span>Enter</span><span>Open book</span>
         <span>Esc</span><span>Close / back</span>
         <span>H P G E</span><span>Highlighter, pen, pencil, eraser</span>
         <span>B</span><span>Bookmark spread</span>
         <span>R</span><span>Back to where you were reading</span>
         <span>+ − 0</span><span>Zoom</span>
         <span>M</span><span>Magnifier</span>
         <span>L</span><span>Reading light</span>
         <span>⌘Z</span><span>Undo mark</span>
       </div></section>`,
    );
    const body = this.panelBody;
    this.mountPaperEditor(body.querySelector('#pe-lib'), app.libraryPaper, (st, final) => app.setLibraryPaper(st, { final }));
    body.querySelectorAll('[data-psrc]').forEach((b) =>
      b.addEventListener('click', () => {
        app.shared.paper.setSource(b.dataset.psrc);
        body.querySelectorAll('[data-psrc]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        app.invalidate();
      }),
    );
    body.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        app.setFullView(b.dataset.view === 'full');
        body.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }),
    );
    const turnSet = {
      peel: (on) => app.setCornerPeel(on),
      flop: (on) => app.setFreeLeaf(on),
      catch: (on) => app.setCatchLeaf(on),
      clump: (on) => app.setClumpTurns(on),
      riffle: (on) => app.setRiffle(on),
      settle: (on) => app.setSettleOpen(on),
      pphys: (on) => app.setPaperPhysics(on),
    };
    body.querySelectorAll('[data-turn]').forEach((b) =>
      b.addEventListener('click', () => {
        turnSet[b.dataset.turn](b.dataset.on === '1');
        body.querySelectorAll(`[data-turn="${b.dataset.turn}"]`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }),
    );
    const wear = body.querySelector('#st-wear');
    wear.addEventListener('click', () => {
      app.setLivingWear(!app.livingWear);
      wear.setAttribute('aria-pressed', String(app.livingWear));
      wear.textContent = app.livingWear ? '[ ON ]' : '[ OFF ]';
    });
    body.querySelectorAll('[data-newbind]').forEach((b) =>
      b.addEventListener('click', () => {
        setDefaultBinding(b.dataset.newbind);
        body.querySelectorAll('[data-newbind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }),
    );
    const st = body.querySelector('#st-storage');
    const mb = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
    Promise.all([navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : null, navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : null])
      .then(([est, kept]) => {
        const n = app.metas.length;
        let t = `${n} ${n === 1 ? 'book' : 'books'}, kept on this device only.`;
        if (est && est.usage != null) t += ` Using ${mb(est.usage)}${est.quota ? ` of the ${mb(est.quota)} this browser allows` : ''}.`;
        if (kept === false) t += ' The browser may clear it if space runs short: adding the app to the Home Screen keeps it.';
        st.textContent = t;
      })
      .catch(() => (st.textContent = 'Kept on this device only.'));
  }

  /**
   * The paper controls, for the library (Settings) or one book (Details): type, weight, surface (finish, for
   * coated paper), shade, age, wear. onChange(settings, final): final=false while a slider moves (an open book
   * shows it at once), true when it is let go or a type is chosen.
   */
  mountPaperEditor(host, settings, onChange) {
    const s = fullSettings(settings);
    const T = PAPER_TYPES[s.type];
    const preset = fullSettings({ type: s.type });
    // weight on a logarithmic scale (20 … 300 gsm), the rest 0 … 1
    const [g0, g1] = GSM_RANGE;
    const toPos = (k, v) => (k === 'gsm' ? Math.log(v / g0) / Math.log(g1 / g0) : v);
    const fromPos = (k, p) => (k === 'gsm' ? Math.round(g0 * Math.pow(g1 / g0, p)) : Math.round(p * 100) / 100);
    const row = (k, label) =>
      `<label class="ip-row pe-row"><span class="ip-l mono">${label}</span><span class="pe-track"><input type="range" data-k="${k}" min="0" max="1" step="0.005" value="${toPos(k, s[k])}" aria-label="${label}"><i class="pe-mark" style="left:calc(8px + (100% - 16px) * ${toPos(k, preset[k]).toFixed(4)})" title="${esc(T.label)}"></i></span><span class="ip-v mono" data-v="${k}"></span></label>`;
    host.innerHTML = `
      <div class="ap-opts pe-types" role="radiogroup" aria-label="Paper">${PAPER_ORDER.map((k) => `<button type="button" class="mono-btn" role="radio" data-ptype="${k}" aria-checked="${k === s.type}">[ ${PAPER_TYPES[k].label} ]</button>`).join('')}</div>
      <p class="note pe-note">${esc(T.note)} The marks under the sliders show where this paper really is; every slider goes all the way.</p>
      ${row('gsm', 'Weight')}
      ${row('surface', 'Surface')}
      ${row('sheen', 'Sheen')}
      ${row('shade', 'Shade')}
      ${row('age', 'Age')}
      ${row('wear', 'Wear')}
      <p class="pe-facts mono dim" data-v="facts"></p>
      <div class="seg"><button type="button" class="mono-btn dim" data-act="pe-reset">Back to ${esc(T.label)}</button></div>`;
    const word = (k, v) => {
      if (k === 'gsm') return `${Math.round(v)} gsm`;
      if (k === 'surface') return v < 0.1 ? 'Glass' : v < 0.25 ? 'Smooth' : v < 0.45 ? 'Fine' : v < 0.65 ? 'Vellum' : v < 0.85 ? 'Toothy' : 'Rough';
      if (k === 'sheen') return v < 0.1 ? 'Dry' : v < 0.3 ? 'Matte' : v < 0.5 ? 'Satin' : v < 0.75 ? 'Silk' : 'Gloss';
      if (k === 'shade') return v < 0.12 ? 'Brilliant' : v < 0.3 ? 'White' : v < 0.6 ? 'Natural' : v < 0.82 ? 'Ivory' : 'Buff';
      if (k === 'age') return v < 0.05 ? 'New' : v < 0.35 ? 'Years' : v < 0.7 ? 'Decades' : 'A century';
      return v < 0.05 ? 'Crisp' : v < 0.35 ? 'Read' : v < 0.7 ? 'Well read' : 'Worn';
    };
    const sync = () => {
      for (const k of ['gsm', 'surface', 'sheen', 'shade', 'age', 'wear']) host.querySelector(`[data-v="${k}"]`).textContent = word(k, s[k]);
      const r = resolvePaper(s);
      host.querySelector('[data-v="facts"]').textContent = `${describeWeight(r).split(' · ').slice(1).join(' · ')} · a 300-page book ${Math.min(5.6, 0.55 + 300 * 0.0082 * r.calRel).toFixed(1)} cm thick`;
    };
    host.querySelectorAll('input[type="range"]').forEach((inp) => {
      const k = inp.dataset.k;
      inp.addEventListener('input', () => {
        s[k] = fromPos(k, parseFloat(inp.value));
        // snap to the paper's own value when close, so "where it really is" is easy to find again
        if (Math.abs(parseFloat(inp.value) - toPos(k, preset[k])) < 0.012) s[k] = preset[k];
        sync();
        onChange({ ...s }, false);
      });
      inp.addEventListener('change', () => onChange({ ...s }, true));
    });
    host.querySelectorAll('[data-ptype]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.ptype === s.type) return;
        // a new type starts from its own weight, surface, sheen and shade; the book's age and wear stay
        const next = { type: b.dataset.ptype, age: s.age, wear: s.wear };
        this.mountPaperEditor(host, next, onChange);
        onChange(fullSettings(next), true);
      }),
    );
    host.querySelector('[data-act="pe-reset"]').addEventListener('click', () => {
      const next = { type: s.type };
      this.mountPaperEditor(host, next, onChange);
      onChange(fullSettings(next), true);
    });
    sync();
  }

  openIndex() {
    const app = this.app;
    const metas = app.sortedMetas();
    const cur = app.currentMeta();
    const items = metas
      .map((m) => {
        const pct = m.pages ? Math.round(((m.spread || 0) * 2 * 100) / m.pages) : 0;
        return `<li class="${cur && cur.id === m.id ? 'sel' : ''}"><button type="button" data-id="${esc(m.id)}"><span>${esc(m.title)}${m.author ? ` <span class="dim">— ${esc(m.author)}</span>` : ''}</span><span class="pg">${Math.min(100, pct)}%</span></button></li>`;
      })
      .join('');
    this.openPanel(
      'index',
      '[ LIBRARY INDEX ]',
      `<section><span class="k">${metas.length} ${metas.length === 1 ? 'book' : 'books'} on the shelf</span><ul class="list">${items || '<li class="note">Nothing here yet.</li>'}</ul></section>`,
    );
    this.panelBody.querySelectorAll('button[data-id]').forEach((b) =>
      b.addEventListener('click', () => {
        this.closePanel();
        if (app.reader.isOpen) app.openBookById(b.dataset.id);
        else app.selectBook(b.dataset.id);
      }),
    );
  }

  async openDetails(meta) {
    if (!meta) return;
    const app = this.app;
    $('details-btn').textContent = 'HIDE DETAILS [-]';
    const reading = app.reader.isOpen && app.reader.meta && app.reader.meta.id === meta.id;
    const spread = reading ? app.reader.s : meta.spread || 0;
    const curPage = Math.max(1, Math.min(meta.pages, spread * 2 || 1));
    const pct = meta.pages ? Math.min(100, Math.round((spread * 2 * 100) / meta.pages)) : 0;
    const outline = (reading && app.reader.outline) || meta.outline || [];
    const bookmarks = meta.bookmarks || [];
    const look = meta.look;
    // two tabs: reading (where you are, contents, bookmarks, annotations) and the book itself (its name, shelf,
    // binding, file); the last one chosen opens again
    const tab = this.detailsTab || 'reading';
    const cloths = CLOTHS.map(
      (c) => `<button type="button" style="--c:${c}" data-cloth="${c}" aria-label="Cloth ${c}" aria-pressed="${look.cloth === c}"></button>`,
    ).join('');

    this.openPanel(
      'details',
      '[ BOOK DETAILS ]',
      `<section>
        <h2>${esc(meta.title)}</h2>
        ${meta.author ? `<p class="byline">+ by ${esc(meta.author)} +</p>` : ''}
      </section>
      <div class="tabs" role="tablist" aria-label="Details">
        <button type="button" class="mono-btn" role="tab" data-tab="reading" aria-selected="${tab === 'reading'}">Reading</button>
        <button type="button" class="mono-btn" role="tab" data-tab="book" aria-selected="${tab === 'book'}">Book</button>
      </div>
      <div class="tab-pane" data-pane="reading"${tab === 'reading' ? '' : ' hidden'}>
      <section>
        <div class="facts"><span>Position</span><span>Page ${curPage} of ${meta.pages}</span><span>Last opened</span><span>${fmtDate(meta.openedAt)}</span></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="panel-actions"><button type="button" class="mono-btn" data-act="open">${reading ? '[ BACK TO THE PAGE ]' : spread ? '[ CONTINUE READING ]' : '[ OPEN BOOK ]'}</button></div>
      </section>
      ${
        outline.length
          ? `<section><span class="k">[ Contents ]</span><ul class="list">${outline
              .slice(0, 300)
              .map((o) => `<li class="d${Math.min(3, o.depth)}"><button type="button" data-page="${o.page || ''}"><span>${esc(o.title)}</span><span class="pg">${o.page || ''}</span></button></li>`)
              .join('')}</ul></section>`
          : ''
      }
      <section><span class="k">[ Bookmarks ]</span>${
        bookmarks.length
          ? `<ul class="list">${bookmarks.map((s) => `<li><button type="button" data-spread="${s}"><span>Pages ${Math.max(1, s * 2)}–${Math.min(meta.pages, s * 2 + 1)}</span></button></li>`).join('')}</ul>`
          : '<p class="note">Bookmark a spread with the flag in the reader bar (or B). Its flag sticks out of the top of the book: tap it twice to go there.</p>'
      }</section>
      <section id="marks-sec"><span class="k">[ Annotations ]</span><p class="note">Counting…</p></section>
      </div>
      <div class="tab-pane" data-pane="book"${tab === 'book' ? '' : ' hidden'}>
      <section>
        <span class="k">[ Title + Author ]</span>
        <input class="field" id="f-title" value="${esc(meta.title)}" aria-label="Title" autocomplete="off">
        <input class="field" id="f-author" value="${esc(meta.author)}" placeholder="Author" aria-label="Author" autocomplete="off">
      </section>
      <section>
        <span class="k">[ Shelf ]</span>
        <select class="field" id="f-shelf" aria-label="Shelf">
          <option value="">On no shelf</option>
          ${app.shelves.map((x) => `<option value="${esc(x.id)}"${meta.shelf === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
          <option value="__new">New shelf…</option>
        </select>
        <div class="new-shelf-row" id="f-new-shelf-row" hidden><input class="field" id="f-new-shelf-name" placeholder="Name of the new shelf" autocomplete="off"><button type="button" class="mono-btn" data-act="new-shelf">[ CREATE ]</button></div>
        <div id="f-section-row" class="f-labelled"${meta.shelf ? '' : ' hidden'}>
          <span class="mono dim">Section</span>
          <input class="field" id="f-section" value="${esc(meta.section || '')}" placeholder="None" aria-label="Section" autocomplete="off" list="f-sections">
          <datalist id="f-sections">${sectionsOf(app.metas, meta.shelf).map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
        </div>
      </section>
      <section>
        <span class="k">[ Binding ]</span>
        <div class="cloths">${cloths}</div>
        <div class="seg"><span class="mono dim">Material</span>
          ${Object.entries(BINDINGS).map(([k, b]) => `<button type="button" class="mono-btn" data-material="${k}" aria-pressed="${bindingKind(look) === k}">${b.label}</button>`).join('')}
          <button type="button" class="mono-btn dim" data-act="material-all">Use for all books</button>
        </div>
        <div class="seg"><span class="mono dim">Cover</span>
          <button type="button" class="mono-btn" data-cover="image" aria-pressed="${look.coverMode === 'image'}">PDF page 1</button>
          <button type="button" class="mono-btn" data-cover="cloth" aria-pressed="${look.coverMode === 'cloth'}">Stamped title</button>
        </div>
        <div class="seg"><span class="mono dim">Spine</span>
          ${['serif', 'mono', 'sans'].map((s) => `<button type="button" class="mono-btn" data-spine="${s}" aria-pressed="${look.spineStyle === s}">${s}</button>`).join('')}
        </div>
      </section>
      <section>
        <span class="k">[ Paper ]</span>
        <p class="note" id="pe-own-note">${meta.paper ? 'This book has its own paper.' : `The library's paper (${esc(PAPER_TYPES[fullSettings(app.libraryPaper).type].label)}, set in Settings). Changing it here gives this book its own.`}</p>
        <div id="pe-book"></div>
        <div class="seg" id="pe-lib-row"${meta.paper ? '' : ' hidden'}><button type="button" class="mono-btn dim" data-act="paper-lib">Use the library's paper</button></div>
        ${reading ? '<p class="note">A new weight shows in the book\'s thickness once it is closed.</p>' : ''}
      </section>
      <section>
        <span class="k">[ File ]</span>
        <div class="facts">
          <span>Name</span><span style="text-transform:none">${esc(meta.fileName || '—')}</span>
          <span>Size</span><span>${fmtBytes(meta.size)}</span>
          <span>Pages</span><span>${meta.pages}</span>
          <span>Page size</span><span>${meta.pageW ? `${Math.round(meta.pageW)} × ${Math.round(meta.pageH)} pt` : '—'}</span>
          <span>Added</span><span>${fmtDate(meta.addedAt)}</span>
        </div>
      </section>
      <section class="panel-actions">
        <button type="button" class="mono-btn" data-act="export">[ EXPORT PDF WITH ANNOTATIONS ]</button>
        <button type="button" class="mono-btn danger" data-act="remove">[ REMOVE FROM LIBRARY ]</button>
        <div id="confirm-remove" hidden><p class="note">Remove “${esc(meta.title)}”, its notes and bookmarks from this device?</p>
          <div class="seg"><button type="button" class="mono-btn danger" data-act="remove-yes">[ YES, REMOVE ]</button><button type="button" class="mono-btn" data-act="remove-no">[ KEEP IT ]</button></div></div>
      </section>
      </div>`,
    );

    const body = this.panelBody;
    body.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.detailsTab = b.dataset.tab;
        body.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        body.querySelectorAll('[data-pane]').forEach((x) => (x.hidden = x.dataset.pane !== b.dataset.tab));
      }),
    );
    body.querySelector('[data-act="open"]').addEventListener('click', () => {
      this.closePanel();
      if (!reading) app.openBookById(meta.id);
    });
    body.querySelectorAll('[data-page]').forEach((b) =>
      b.addEventListener('click', () => {
        const p = parseInt(b.dataset.page, 10);
        if (!p) return;
        this.closePanel();
        app.openBookById(meta.id, p);
      }),
    );
    body.querySelectorAll('[data-spread]').forEach((b) =>
      b.addEventListener('click', () => {
        this.closePanel();
        app.openBookById(meta.id, Math.max(1, parseInt(b.dataset.spread, 10) * 2));
      }),
    );
    const saveText = () => {
      const t = body.querySelector('#f-title').value.trim();
      const a = body.querySelector('#f-author').value.trim();
      if ((t && t !== meta.title) || a !== meta.author) {
        if (t) meta.title = t;
        meta.author = a;
        app.updateMeta(meta, { retexture: true });
        body.querySelector('h2').textContent = meta.title;
      }
    };
    for (const id of ['#f-title', '#f-author']) {
      const f = body.querySelector(id);
      f.addEventListener('change', saveText);
      f.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') f.blur();
      });
    }
    body.querySelectorAll('[data-cloth]').forEach((b) =>
      b.addEventListener('click', () => {
        app.setLook(meta, { cloth: b.dataset.cloth });
        body.querySelectorAll('[data-cloth]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }),
    );
    body.querySelectorAll('[data-material]').forEach((b) =>
      b.addEventListener('click', () => {
        app.setLook(meta, { material: b.dataset.material });
        body.querySelectorAll('[data-material]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }),
    );
    body.querySelector('[data-act="material-all"]').addEventListener('click', async () => {
      const kind = bindingKind(meta.look);
      await app.setMaterialAll(kind);
      this.toast(`Every book is now bound in ${BINDINGS[kind].label.toLowerCase()}, new ones too`, 2600);
    });
    body.querySelectorAll('[data-cover]').forEach((b) =>
      b.addEventListener('click', () => {
        app.setLook(meta, { coverMode: b.dataset.cover });
        body.querySelectorAll('[data-cover]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }),
    );
    body.querySelectorAll('[data-spine]').forEach((b) =>
      b.addEventListener('click', () => {
        app.setLook(meta, { spineStyle: b.dataset.spine });
        body.querySelectorAll('[data-spine]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }),
    );
    // paper: the library's, until changed here
    const peHost = body.querySelector('#pe-book');
    const peNote = body.querySelector('#pe-own-note');
    const peLib = body.querySelector('#pe-lib-row');
    const onPaper = (st, final) => {
      app.setBookPaper(meta, st, { final });
      peNote.textContent = 'This book has its own paper.';
      peLib.hidden = false;
    };
    this.mountPaperEditor(peHost, meta.paper || app.libraryPaper, onPaper);
    body.querySelector('[data-act="paper-lib"]').addEventListener('click', () => {
      app.setBookPaper(meta, null);
      this.mountPaperEditor(peHost, app.libraryPaper, onPaper);
      peNote.textContent = `The library's paper (${PAPER_TYPES[fullSettings(app.libraryPaper).type].label}, set in Settings). Changing it here gives this book its own.`;
      peLib.hidden = true;
    });
    const shelfSel = body.querySelector('#f-shelf');
    const newRow = body.querySelector('#f-new-shelf-row');
    shelfSel.addEventListener('change', async () => {
      if (shelfSel.value === '__new') {
        newRow.hidden = false;
        body.querySelector('#f-new-shelf-name').focus();
        return;
      }
      newRow.hidden = true;
      await app.setBookShelf(meta, shelfSel.value || null);
      body.querySelector('#f-section-row').hidden = !meta.shelf;
      body.querySelector('#f-section').value = '';
      body.querySelector('#f-sections').innerHTML = sectionsOf(app.metas, meta.shelf).map((x) => `<option value="${esc(x)}">`).join('');
      this.toast(shelfSel.value ? `On the shelf “${app.shelves.find((x) => x.id === shelfSel.value).name}”` : 'On no shelf', 2000);
    });
    const createShelf = async () => {
      const input = body.querySelector('#f-new-shelf-name');
      const v = input.value.trim();
      if (!v) return input.focus();
      const ns = app.createShelf(v);
      await app.setBookShelf(meta, ns.id);
      this.openDetails(meta);
      this.toast(`On the new shelf “${ns.name}”`, 2000);
    };
    body.querySelector('[data-act="new-shelf"]').addEventListener('click', createShelf);
    const secField = body.querySelector('#f-section');
    secField.addEventListener('change', async () => {
      await app.setBookSection(meta, secField.value);
      this.toast(meta.section ? `In the section “${meta.section}”` : 'In no section', 1800);
    });
    secField.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') secField.blur();
    });
    body.querySelector('#f-new-shelf-name').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') createShelf();
    });
    body.querySelector('[data-act="export"]').addEventListener('click', () => app.exportBook(meta));
    body.querySelector('[data-act="remove"]').addEventListener('click', () => (body.querySelector('#confirm-remove').hidden = false));
    body.querySelector('[data-act="remove-no"]').addEventListener('click', () => (body.querySelector('#confirm-remove').hidden = true));
    body.querySelector('[data-act="remove-yes"]').addEventListener('click', () => {
      this.closePanel();
      app.removeBook(meta);
    });

    // annotations (async)
    const marks = reading ? app.reader.ink.marks : await store.getMarks(meta.id);
    if (this.panelMode !== 'details') return;
    const sec = body.querySelector('#marks-sec');
    const pages = [...marks.keys()].filter((p) => marks.get(p).length).sort((a, b) => a - b);
    const total = pages.reduce((n, p) => n + marks.get(p).length, 0);
    sec.innerHTML = `<span class="k">[ Annotations ]</span>${
      total
        ? `<p class="note" style="margin:0 0 6px">${total} mark${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}.</p><ul class="list">${pages
            .slice(0, 200)
            .map((p) => `<li><button type="button" data-mpage="${p}"><span>Page ${p}</span><span class="pg">${marks.get(p).length}</span></button></li>`)
            .join('')}</ul>`
        : '<p class="note">No highlights yet. Pick a highlighter, the pen or the pencil in the reader bar. With an Apple Pencil, the pencil draws and fingers keep turning pages.</p>'
    }`;
    sec.querySelectorAll('[data-mpage]').forEach((b) =>
      b.addEventListener('click', () => {
        this.closePanel();
        app.openBookById(meta.id, parseInt(b.dataset.mpage, 10));
      }),
    );
  }

  onOutline() {
    if (this.panelMode === 'details') this.openDetails(this.app.currentMeta());
  }
}

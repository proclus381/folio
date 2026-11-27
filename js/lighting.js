// Reading lights. A candle for a timed sitting, and room lights you switch on and leave on: an oil lamp, a
// banker's lamp, a fire off to one side, a sunny window or a rainy one. Each is a finished scene (its colour,
// its movement, how far the room dims) with a few settings kept inside what that real source can do: warmth
// (or time of day), brightness, side, liveliness.
//
// One room light at a time; it stays on across books, on the shelf too, and across sessions. The candle
// burns for its sitting (10–45 min) beside the book, alongside a room light if one is on, and reports the
// pages read when it goes out.
//
// The manager places the lights around the open book or, on the shelf, around the face-out book (gliding
// between the two), mixes the room's own lights toward the lights' moods, drives the CSS layers behind the
// 3D canvas (a dimmed room, a pool of warm light, a window's pattern on the wall, a lightning flash), and
// keeps the settings.

import * as THREE from 'three';
import { clamp, lerp } from './anim.js';
import { setRoomLight } from './room.js';

// ------------------------------------------------------------------ colour of light
// Hand-tuned linear colours for paper (black-body hues, desaturated the way a page under them reads).
const KELVIN = [
  [1500, [1.0, 0.46, 0.16]],
  [1900, [1.0, 0.62, 0.3]],
  [2200, [1.0, 0.68, 0.38]],
  [2700, [1.0, 0.76, 0.52]],
  [3200, [1.0, 0.82, 0.64]],
  [4000, [1.0, 0.89, 0.78]],
  [5000, [1.0, 0.95, 0.9]],
  [5600, [1.0, 0.98, 0.96]],
  [6500, [0.94, 0.97, 1.0]],
  [7500, [0.86, 0.92, 1.0]],
];
export function kelvinColor(k, out = new THREE.Color()) {
  if (k <= KELVIN[0][0]) return out.setRGB(...KELVIN[0][1]);
  for (let i = 1; i < KELVIN.length; i++) {
    const [k1, c1] = KELVIN[i];
    if (k <= k1) {
      const [k0, c0] = KELVIN[i - 1];
      const t = (k - k0) / (k1 - k0);
      return out.setRGB(lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t));
    }
  }
  return out.setRGB(...KELVIN[KELVIN.length - 1][1]);
}

// ------------------------------------------------------------------ noise
export function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

// ------------------------------------------------------------------ the lights on offer
// settings: [min, max, default]. Only the candle has a timer; the rest switch on and off.
export const LIGHTS = {
  candle: {
    label: 'Candle',
    note: 'Light a candle for a sitting: it burns down beside the book, flickers when a page turns, and goes out when the time is up. It can burn alongside a room light.',
    warmth: [1700, 2100, 1900],
    brightness: [0.6, 1.4, 1],
    liveliness: [0, 1.5, 1],
    side: 1,
    timer: true,
    off: 'Put it out',
    ended: 'The candle burned down',
    out: 'Candle out',
  },
  oil: {
    label: 'Oil lamp',
    note: 'A glass oil lamp beside the book: a steadier, brighter flame behind its chimney.',
    warmth: [1800, 2300, 2050],
    brightness: [0.6, 1.4, 1],
    liveliness: [0, 1.5, 0.6],
    side: 1,
    on: 'Light the lamp',
    off: 'Turn down the wick',
  },
  desk: {
    label: "Banker's lamp",
    note: 'A green glass shade throws a steady pool of warm light across the page.',
    warmth: [2400, 3200, 2700],
    brightness: [0.45, 1.3, 1],
    liveliness: null,
    side: 1,
    on: 'Switch on',
    off: 'Switch off',
  },
  fire: {
    label: 'Fireside',
    note: 'A fire just out of view: big, slow, warm light from one side, now and then a log settling.',
    warmth: [1700, 2300, 1950],
    brightness: [0.5, 1.4, 1],
    liveliness: [0, 1.5, 1],
    side: -1,
    on: 'Light the fire',
    off: 'Let it die',
  },
  sun: {
    label: 'Sunny window',
    note: 'Sun through a window, leaves moving in the breeze. Follow your clock and the light changes with the day.',
    time: [7, 20, 16.5],
    brightness: [0.5, 1.3, 1],
    liveliness: [0, 1.5, 0.8],
    side: -1,
    on: 'Open the curtains',
    off: 'Draw the curtains',
  },
  rain: {
    label: 'Rainy window',
    note: 'Soft grey daylight, rain running down the glass, now and then lightning.',
    warmth: [5600, 7500, 6500],
    brightness: [0.5, 1.3, 1],
    liveliness: [0, 1.5, 0.8],
    side: -1,
    on: 'Open the curtains',
    off: 'Draw the curtains',
  },
};

const LS_KEY = 'folio.light.v1';
// the side each light's room was rendered with (tools/blender/room_lights.py); the other side mirrors it
const ROOM_SIDE = { candle: 1, oil: 1, desk: 1, fire: -1, sun: -1, rain: -1 };
function defaults() {
  const s = {};
  for (const [id, L] of Object.entries(LIGHTS)) {
    s[id] = { side: L.side };
    if (L.warmth) s[id].warmth = L.warmth[2];
    if (L.time) {
      s[id].time = L.time[2];
      s[id].clock = false;
    }
    s[id].brightness = L.brightness[2];
    if (L.liveliness) s[id].liveliness = L.liveliness[2];
  }
  return { choice: 'candle', room: null, settings: s };
}

// ------------------------------------------------------------------ base for the new lights
/**
 * Timeline shared by the lights: off → starting → on → ending → out → off. `level` follows it as the
 * light's own envelope (0…1); `dim` is how far the room has gone over to this light's mood.
 * Subclasses set startTime / endTime / outTime and implement step(dt, camera), place(L), applySettings(s);
 * they describe the room through `room` and may offer `glow(camera, w, h)` and `wall`.
 */
export class LightSource {
  constructor(app, id) {
    this.app = app;
    this.id = id;
    this.group = new THREE.Group();
    this.group.name = id;
    this.group.visible = false;
    app.scene.add(this.group);
    this.state = 'off';
    this.stateT = 0;
    this.duration = 0;
    this.elapsed = 0;
    this.level = 0;
    this.dim = 0;
    this.time = 0;
    this.startTime = 1.2;
    this.endTime = 3;
    this.outTime = 3;
    this.fps = 30;
    this.onDone = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.s = {};
  }
  get isBurning() {
    return this.state === 'starting' || this.state === 'on';
  }
  get active() {
    return this.state !== 'off';
  }
  get remaining() {
    return this.duration === Infinity ? Infinity : Math.max(0, this.duration - this.elapsed);
  }
  get progress() {
    return this.duration === Infinity || !this.duration ? 0 : clamp(this.elapsed / this.duration, 0, 1);
  }
  /** Liveliness after the system's "reduce motion". */
  get lively() {
    const l = this.s.liveliness ?? 1;
    return this.reduced ? Math.min(l, 0.3) : l;
  }

  start(seconds) {
    this.duration = seconds;
    this.elapsed = 0;
    this.state = 'starting';
    this.stateT = 0;
    this.group.visible = true;
    this.onStart && this.onStart();
  }
  addTime(seconds) {
    if (this.isBurning && this.duration !== Infinity) this.duration += seconds;
  }
  /** reason: 'snuffed' | 'closed' | 'switch' (another light takes over; no report). */
  stop(reason = 'snuffed') {
    if (!this.isBurning && this.state !== 'ending') return;
    this.endReason = reason;
    this.toOut();
  }
  toOut() {
    this.state = 'out';
    this.stateT = 0;
    const reason = this.endReason || 'done';
    this.endReason = null;
    if (reason !== 'switch' && this.onDone) this.onDone({ reason, minutes: Math.round(this.elapsed / 60) });
  }

  update(dt, camera) {
    if (this.state === 'off' && this.level <= 0 && this.dim <= 0) return false;
    this.time += dt;
    this.stateT += dt;
    if (this.state === 'starting') {
      this.elapsed += dt;
      if (this.stateT >= this.startTime) {
        this.state = 'on';
        this.stateT = 0;
      }
    } else if (this.state === 'on') {
      this.elapsed += dt;
      if (this.elapsed >= this.duration) {
        this.state = 'ending';
        this.stateT = 0;
      }
    } else if (this.state === 'ending') {
      if (this.stateT >= this.endTime) {
        this.endReason = 'done';
        this.toOut();
      }
    } else if (this.state === 'out' && this.stateT >= this.outTime) {
      this.state = 'off';
      this.stateT = 0;
    }
    const on = this.state === 'starting' || this.state === 'on' || this.state === 'ending';
    const dimTarget = on ? 1 : 0;
    this.dim += (dimTarget - this.dim) * (1 - Math.exp(-dt * (dimTarget > this.dim ? 1.5 : 1.0)));
    if (!on && this.dim < 0.004) this.dim = 0;
    this.step(dt, camera);
    if (this.state === 'off' && this.level <= 0.001 && this.dim === 0) {
      this.level = 0;
      this.group.visible = false;
      this.hide && this.hide();
    }
    return true;
  }
}

// ------------------------------------------------------------------ the manager
const LAYOUT_VEC = ['center', 'R', 'U', 'N'];
const LAYOUT_NUM = ['s', 'cx', 'edge', 'span', 'bottomY', 'topY', 'nearZ', 'farZ', 'camX'];

export class Lighting {
  constructor(app, factories) {
    this.app = app;
    this.factories = factories; // id → (app) => source
    this.sources = {};
    this.pagesRead = 0; // spreads turned one by one, ×2 — counted across books for the candle's report
    this.sittingStart = 0;
    this.Ls = null; // the layout the lights stand in, eased between the shelf and the open book
    this.load();
    this.dimEl = document.getElementById('room-dim');
    this.glowEl = document.getElementById('room-glow');
    this.flashEl = document.getElementById('room-flash');
    this.wallEl = document.getElementById('room-wall');
    this.wallCtx = this.wallEl ? this.wallEl.getContext('2d') : null;
    this.baseAmbient = app.ambient.color.clone();
    this.baseFill = app.fill.color.clone();
    this.baseKey = app.key.color.clone();
    this._c = new THREE.Color();
    document.addEventListener('visibilitychange', () => {
      // a sitting keeps time while the app is in the background
      const c = this.sources.candle;
      if (document.hidden) this.hiddenAt = performance.now();
      else if (this.hiddenAt && c && c.isBurning) c.elapsed += (performance.now() - this.hiddenAt) / 1000;
    });
  }

  load() {
    const d = defaults();
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved) {
        if (LIGHTS[saved.choice]) d.choice = saved.choice;
        if (LIGHTS[saved.room] && !LIGHTS[saved.room].timer) d.room = saved.room;
        for (const id in d.settings) Object.assign(d.settings[id], (saved.settings || {})[id] || {});
      }
    } catch {
      /* defaults */
    }
    this.store = d;
  }
  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.store));
    } catch {
      /* not remembered */
    }
  }

  /** At start-up: the room light that was on last time comes back on. */
  restore() {
    if (this.store.room) this.source(this.store.room).start(Infinity);
  }

  get choice() {
    return this.store.choice;
  }
  /** The room light that is on (id), or null. */
  get room() {
    return this.store.room;
  }
  settings(id = this.choice) {
    return this.store.settings[id];
  }
  setChoice(id) {
    if (!LIGHTS[id]) return;
    this.store.choice = id;
    this.save();
  }
  set(id, key, value) {
    this.store.settings[id][key] = value;
    this.save();
    const s = this.sources[id];
    if (s) s.applySettings(this.store.settings[id]);
    this.app.invalidate();
  }

  source(id) {
    if (!this.sources[id]) {
      const s = this.factories[id](this.app);
      s.onDone = (info) => this.onSourceDone(s, info);
      s.applySettings(this.store.settings[id]);
      this.sources[id] = s;
    }
    return this.sources[id];
  }

  get candle() {
    return this.source('candle');
  }
  /** The candle, while it burns. */
  get candleLit() {
    const c = this.sources.candle;
    return c && c.isBurning ? c : null;
  }
  get anyActive() {
    return Object.values(this.sources).some((s) => s.active);
  }
  isOn(id) {
    return LIGHTS[id].timer ? !!this.candleLit : this.store.room === id;
  }

  /** Switch a room light on (putting out any other room light) or off. Remembered across sessions. */
  toggle(id, on = !this.isOn(id)) {
    if (LIGHTS[id].timer) return;
    const cur = this.store.room;
    if (on) {
      if (cur === id) return;
      if (cur) this.source(cur).stop('switch');
      this.source(id).start(Infinity);
      this.store.room = id;
    } else if (cur === id) {
      this.source(id).stop('switch');
      this.store.room = null;
    }
    this.save();
    this.app.invalidate();
  }

  lightCandle(minutes) {
    this.sittingStart = this.pagesRead;
    this.candle.start(minutes * 60);
    this.app.invalidate();
  }
  addCandleTime(minutes) {
    if (this.candleLit) this.candleLit.addTime(minutes * 60);
  }
  snuffCandle() {
    if (this.sources.candle) this.sources.candle.stop('snuffed');
  }
  gust(dir, strength) {
    for (const s of Object.values(this.sources)) if (s.active && s.gust) s.gust(dir, strength);
  }

  /** The candle went out (burned down or put out): how the sitting went. */
  onSourceDone(s, { reason, minutes }) {
    if (s.id !== 'candle') return;
    const pages = Math.max(0, this.pagesRead - this.sittingStart);
    const L = LIGHTS.candle;
    const pp = `${pages} page${pages === 1 ? '' : 's'}`;
    const mins = `${Math.max(1, minutes)} min`;
    this.app.ui.toast(`${reason === 'done' ? L.ended : L.out} · ${mins} · ${pp}`, reason === 'done' ? 4200 : 3000);
    this.app.ui.syncLight(this);
  }

  /** Ease the layout toward where the lights belong now (the open book, or the shelf). */
  layout(dt) {
    const L = this.app.reader.isOpen ? this.app.reader.lightLayout() : this.app.shelf.lightLayout();
    if (!this.Ls || this.fresh) {
      this.fresh = false;
      this.Ls = { ...L, center: L.center.clone(), R: L.R.clone(), U: L.U.clone(), N: L.N.clone() };
      return this.Ls;
    }
    const k = 1 - Math.exp(-dt * 5);
    const S = this.Ls;
    for (const n of LAYOUT_NUM) S[n] += (L[n] - S[n]) * k;
    for (const v of LAYOUT_VEC) {
      S[v].lerp(L[v], k);
      if (v !== 'center') S[v].normalize();
    }
    S.halfWAt = L.halfWAt;
    return S;
  }

  // ---------------------------------------------------------------- frame
  /** Returns the frame rate the lights need when nothing else moves (0: none). */
  update(dt, camera) {
    let fps = 0;
    if (this.anyActive) {
      const L = this.layout(dt);
      for (const s of Object.values(this.sources)) if (s.active) s.place(L);
    } else this.fresh = true; // the next light lit starts where it belongs, no glide
    for (const s of Object.values(this.sources)) if (s.update(dt, camera)) fps = Math.max(fps, s.fps);
    // a light coming on or going out moves what casts shadows (a candle rising into place); steady, it doesn't
    this.shaping = Object.values(this.sources).some((s) => s.active && s.state !== 'on' && s.state !== 'lit');
    this.apply(camera);
    return fps;
  }

  /** The reading lights that cast shadows (main.js keeps their shadow maps only as fresh as they need to be). */
  shadowLights() {
    const out = [];
    for (const s of Object.values(this.sources)) {
      if (!s.active) continue;
      for (const l of [s.spot, s.sun]) if (l && l.castShadow) out.push(l);
    }
    return out;
  }

  /** Mix the room's lights and the CSS layers toward the active sources. */
  apply(camera) {
    const app = this.app;
    const b = app.lightBase;
    // the room is as dark as the darkest mood (a candle by the fire doesn't darken it further)
    let amb = 1;
    let key = 1;
    let fill = 1;
    let rake = 1;
    const ambC = this._c.copy(this.baseAmbient);
    const fillC = app.fill.color.copy(this.baseFill);
    app.key.color.copy(this.baseKey);
    let darkest = null;
    let darkness = 0;
    let glow = null;
    let flash = 0;
    let wall = null;
    for (const s of Object.values(this.sources)) {
      if (s.dim <= 0) continue;
      const R = s.room;
      amb = Math.min(amb, lerp(1, R.ambient, s.dim));
      key = Math.min(key, lerp(1, R.key, s.dim));
      fill = Math.min(fill, lerp(1, R.fill, s.dim));
      rake = Math.min(rake, lerp(1, R.rake ?? R.key, s.dim));
      if (R.tint) {
        ambC.lerp(R.tint, s.dim * 0.85);
        fillC.lerp(R.tint, s.dim * 0.6);
      }
      const d = s.dim * ((s.css && s.css.dimAmount) ?? 1);
      if (d > darkness) {
        darkness = d;
        darkest = s;
      }
      const g = s.glow ? s.glow(camera, app.width, app.height) : null;
      if (g && (!glow || g.opacity > glow.opacity)) glow = g;
      flash = Math.max(flash, s.flash || 0);
      if (!wall && s.wall) wall = s.wall(camera, app.width, app.height);
    }
    // reflections: blend toward the room of the strongest room light (else the candle's), mirrored to its side
    let rl = null;
    for (const [id, s] of Object.entries(this.sources)) {
      if (s.dim <= 0.001) continue;
      if (!rl || (rl.id === 'candle' && id !== 'candle') || ((id === 'candle') === (rl.id === 'candle') && s.dim > rl.s.dim)) rl = { id, s };
    }
    if (rl) setRoomLight(rl.id, rl.s.dim, (this.store.settings[rl.id]?.side ?? ROOM_SIDE[rl.id]) * ROOM_SIDE[rl.id] >= 0 ? 1 : -1);
    else setRoomLight(null, 0);
    app.ambient.intensity = b.ambient * amb;
    app.ambient.color.copy(ambC);
    app.key.intensity = b.key * key;
    app.fill.intensity = b.fill * fill;
    app.onRoomLight(rake, amb);

    // CSS: the room behind the book
    const dark = app.theme === 'dark';
    const ds = this.dimEl.style;
    if (darkest) {
      const css = darkest.css || {};
      ds.setProperty('--d1', css.dim1 || 'rgba(26,18,10,0.34)');
      ds.setProperty('--d2', css.dim2 || 'rgba(14,9,4,0.5)');
      ds.opacity = (darkness * (dark ? 0.25 : 1)).toFixed(3);
    } else ds.opacity = '0';
    const gs = this.glowEl.style;
    if (glow && glow.opacity > 0.001) {
      gs.setProperty('--gx', `${glow.x.toFixed(1)}px`);
      gs.setProperty('--gy', `${glow.y.toFixed(1)}px`);
      gs.setProperty('--g1', glow.c1);
      gs.setProperty('--g2', glow.c2);
      gs.setProperty('--gr', `${glow.r || 30}vmin`);
      gs.opacity = (glow.opacity * (dark ? 1.2 : 1)).toFixed(3);
    } else gs.opacity = '0';
    this.flashEl.style.opacity = flash.toFixed(3);
    this.drawWall(wall, dark);
  }

  /** A window's light on the wall: its pattern, skewed into a patch beside the book. */
  drawWall(w, dark) {
    const el = this.wallEl;
    if (!el) return;
    if (!w || w.opacity <= 0.002) {
      if (this.wallShown) {
        this.wallCtx.clearRect(0, 0, el.width, el.height);
        el.style.opacity = '0';
        this.wallShown = false;
      }
      return;
    }
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    if (el.width !== W || el.height !== H) {
      el.width = W;
      el.height = H;
    }
    const ctx = this.wallCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // the patch: a parallelogram (the window seen slant on the wall)
    const [ax, ay, bx, by, cx, cy] = w.quad; // corner, along-x corner, along-y corner (CSS px)
    ctx.setTransform(((bx - ax) * dpr) / w.image.width, ((by - ay) * dpr) / w.image.width, ((cx - ax) * dpr) / w.image.height, ((cy - ay) * dpr) / w.image.height, ax * dpr, ay * dpr);
    ctx.globalAlpha = 1;
    ctx.drawImage(w.image, 0, 0);
    el.style.opacity = (w.opacity * (dark ? 0.35 : 1)).toFixed(3);
    el.style.setProperty('--wall-tint', w.tint || 'rgb(255,236,200)');
    this.wallShown = true;
  }
}

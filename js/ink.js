// Annotations: freehand highlighters (multiplied like real ink), a pen and a pencil, stored in page-relative
// coordinates (u across, v down from the top), rendered into per-page overlay textures.
//
// Strokes carry everything needed to draw them, so changing the tool settings later never changes old marks:
//   { tool, pts: [u, v, …], w (base width, fraction of page width), c: [r, g, b], a (alpha),
//     tip: 'round' | 'chisel', wf: [width factor per point] }
// A pencil stroke also has gf: [how much of the paper's tooth the graphite covers, per point, 0…1] and g (its
// lead grade). Strokes saved before pressure existed have only { tool, w, pts } and draw as they always did.
//
// Every stroke is drawn as the union of simple polygons with one winding (capsules for a round tip, swept
// nib rectangles for a chisel) filled once with the nonzero rule — so a stroke never darkens where it
// overlaps itself, and the very same outlines go into the exported PDF.

import * as THREE from 'three';
import * as store from './store.js';

// ------------------------------------------------------------------ inks & settings
export const PEN_COLORS = [
  { id: 'ink', rgb: [30, 28, 52], name: 'Blue-black' },
  { id: 'black', rgb: [24, 23, 22], name: 'Black' },
  { id: 'red', rgb: [172, 36, 34], name: 'Red' },
  { id: 'blue', rgb: [28, 68, 168], name: 'Blue' },
  { id: 'green', rgb: [26, 104, 70], name: 'Green' },
];
// alpha is per colour: under multiply a pale yellow needs more ink than a pink to read the same
export const MARKER_COLORS = [
  { id: 'yellow', rgb: [255, 240, 130], a: 0.8, ui: '#f4e400', name: 'Yellow' },
  { id: 'pink', rgb: [255, 150, 200], a: 0.48, ui: '#ff5fa8', name: 'Pink' },
  { id: 'green', rgb: [176, 238, 142], a: 0.62, ui: '#5fd35a', name: 'Green' },
  { id: 'blue', rgb: [150, 208, 255], a: 0.55, ui: '#3fa9f5', name: 'Blue' },
  { id: 'orange', rgb: [255, 186, 104], a: 0.6, ui: '#ff9a2e', name: 'Orange' },
  { id: 'violet', rgb: [208, 176, 255], a: 0.55, ui: '#a77bff', name: 'Violet' },
];

// legacy look of strokes saved without their own colour
export const INKS = {
  pink: { rgb: [255, 150, 200], alpha: 0.48, width: 21 / 1024 },
  yellow: { rgb: [255, 240, 130], alpha: 0.8, width: 21 / 1024 },
  pen: { rgb: [30, 28, 52], alpha: 0.96, width: 2.4 / 1024 },
};

/**
 * Pencil leads. Graphite lies on the peaks of the paper's tooth and leaves the valleys white, so a pencil line
 * is grainy and its grey is mostly how much of the tooth it covers (cov, at an everyday pressure); where it lies
 * the graphite itself is dark. Harder leads (more clay) are paler, finer and cover less; softer ones darker and
 * broader. Measured against a printed page: 2H about L* 85, HB about 73, 2B about 66, 4B about 56. soft: how
 * gradually a pixel fills as the cover rises (hard leads skip more of the valleys: grainier).
 */
export const PENCIL_GRADES = [
  { id: '2H', rgb: [76, 78, 84], a: 0.86, w: 1.6, cov: 0.58, soft: 0.5, name: '2H, hard and pale' },
  { id: 'HB', rgb: [48, 48, 52], a: 0.92, w: 1.9, cov: 0.74, soft: 0.62, name: 'HB' },
  { id: '2B', rgb: [40, 40, 43], a: 0.94, w: 2.3, cov: 0.82, soft: 0.72, name: '2B' },
  { id: '4B', rgb: [30, 30, 33], a: 0.96, w: 2.8, cov: 0.9, soft: 0.82, name: '4B, soft and dark' },
];
// graphite takes its grey from the lead; the editor's red and blue pencils are waxier and a touch lighter
export const PENCIL_COLORS = [
  { id: 'graphite', rgb: null, ui: '#5a5b60', name: 'Graphite' },
  { id: 'red', rgb: [184, 50, 44], a: 0.9, name: 'Red' },
  { id: 'blue', rgb: [44, 84, 170], a: 0.9, name: 'Blue' },
];

export const TOOL_KIND = { pen: 'pen', pencil: 'pencil', pink: 'marker', yellow: 'marker' };
const BASE_W = { pen: 2.4 / 1024, marker: 21 / 1024 };
// ranges for the settings sliders (size is a multiple of the base width)
export const RANGES = {
  pen: { size: [0.4, 3.5] },
  pencil: { size: [0.5, 3] },
  marker: { size: [0.5, 1.8], opacity: [0.4, 1.25] },
  eraser: { size: [0.5, 3] },
};

const DEFAULTS = {
  pen: { color: 'ink', size: 1, pressure: 0.75, smooth: 0.3 },
  pencil: { color: 'graphite', grade: 'HB', size: 1, pressure: 0.8, smooth: 0.25 },
  pink: { color: 'pink', size: 1, pressure: 0.35, opacity: 1, tip: 'chisel', smooth: 0.35 },
  yellow: { color: 'yellow', size: 1, pressure: 0.35, opacity: 1, tip: 'chisel', smooth: 0.35 },
  eraser: { size: 1 },
};
const LS_KEY = 'folio.ink.v1';

class InkSettings {
  constructor() {
    this.v = structuredClone(DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved) for (const t in DEFAULTS) Object.assign(this.v[t], saved[t] || {});
    } catch {
      /* private mode or corrupt — defaults */
    }
    this.listeners = new Set();
  }
  get(tool) {
    return this.v[tool] || this.v.yellow;
  }
  set(tool, key, value) {
    this.v[tool][key] = value;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.v));
    } catch {
      /* not persisted this time */
    }
    for (const f of this.listeners) f(tool, key, value);
  }
  reset(tool) {
    for (const k in DEFAULTS[tool]) this.set(tool, k, DEFAULTS[tool][k]);
  }
  onChange(f) {
    this.listeners.add(f);
  }
  markerColor(tool) {
    const id = this.get(tool).color;
    return MARKER_COLORS.find((c) => c.id === id) || MARKER_COLORS[0];
  }
  penColor() {
    const id = this.v.pen.color;
    return PEN_COLORS.find((c) => c.id === id) || PEN_COLORS[0];
  }
  pencilGrade() {
    const id = this.v.pencil.grade;
    return PENCIL_GRADES.find((g) => g.id === id) || PENCIL_GRADES[1];
  }
  pencilColor() {
    const id = this.v.pencil.color;
    return PENCIL_COLORS.find((c) => c.id === id) || PENCIL_COLORS[0];
  }
}
export const inkSettings = new InkSettings();

/**
 * Pencil pressure (0…1) → width factor. Apple Pencil writing pressure sits around 0.2–0.45; a light touch
 * draws a hairline, a firm press about twice the set width. `sens` blends from even (0) to fully pressure-led.
 */
export function pressureFactor(kind, p, sens) {
  if (p == null) return 1;
  const q = Math.pow(Math.min(1, Math.max(0, p)), 0.8);
  // a lead hardly spreads when pressed: the pencil mostly gets darker (see pencilDensity), a little wider
  const f =
    kind === 'pen' ? Math.min(2.2, 0.15 + 2.0 * q) : kind === 'pencil' ? Math.min(1.5, 0.7 + 0.8 * q) : Math.min(1.45, 0.55 + 0.95 * q);
  return 1 + (f - 1) * sens;
}

/** How much of the tooth a pencil covers: `cov` at an everyday press, a little at a light touch, all when bearing down. */
export function pencilDensity(cov, p, sens) {
  if (p == null) return cov;
  const q = Math.pow(Math.min(1, Math.max(0, p)), 0.8);
  return Math.min(1, cov * (1 + (0.3 + 1.6 * q - 1) * sens));
}

/**
 * Laid low (the Pencil's altitude under about 50°), a pencil shades with the side of its lead: 0 upright … 1 flat.
 * `alt`: radians above the page, or null when the device doesn't say.
 */
export function tiltShade(alt) {
  if (alt == null) return 0;
  const t = Math.min(1, Math.max(0, (0.9 - alt) / 0.5));
  return t * t * (3 - 2 * t);
}

/** A point's width factor (wf) and, for a pencil, its graphite cover (gf). */
export function pointFactors(tool, p, sens, tilt = null, settings = inkSettings) {
  const kind = TOOL_KIND[tool] || 'marker';
  const wf = pressureFactor(kind, p, sens);
  if (kind !== 'pencil') return { wf, gf: null };
  const sh = tiltShade(tilt);
  return { wf: wf * (1 + 3 * sh), gf: pencilDensity(settings.pencilGrade().cov, p, sens) * (1 - 0.35 * sh) };
}

/** A new stroke for `tool` with the current settings. */
export function makeStroke(tool, settings = inkSettings) {
  const kind = TOOL_KIND[tool] || 'marker';
  const st = settings.get(tool);
  if (kind === 'pen') {
    const col = settings.penColor();
    return { tool, c: col.rgb, a: 0.96, w: round5(BASE_W.pen * st.size), tip: 'round', pts: [], wf: [] };
  }
  if (kind === 'pencil') {
    const g = settings.pencilGrade();
    const col = settings.pencilColor();
    return { tool, g: g.id, c: col.rgb || g.rgb, a: col.a || g.a, w: round5((g.w / 1024) * st.size), tip: 'round', pts: [], wf: [], gf: [] };
  }
  const col = settings.markerColor(tool);
  return {
    tool,
    c: col.rgb,
    a: round2(Math.min(1, col.a * st.opacity)),
    w: round5(BASE_W.marker * st.size),
    tip: st.tip,
    pts: [],
    wf: [],
  };
}

// ------------------------------------------------------------------ overlay layers
const OVERLAY_W = 1024;

export class InkLayer {
  constructor(bookId, pageAspect, onTexture, onDirty = null) {
    this.bookId = bookId;
    this.aspect = pageAspect; // width / height of the page box
    this.marks = new Map(); // page → strokes[]
    this.layers = new Map(); // page → { canvas, ctx, base, bctx, tex, dirty, baseDirty }
    this.undoStack = [];
    this.live = null; // { page, stroke, kind, sens, k, su, sv, sp, ru, rv, rp }
    this.saveTimers = new Map();
    this.onTexture = onTexture; // (page) => void — tell the reader a texture appeared / changed
    this.onDirty = onDirty; // (page) => void — a texture's pixels need drawing (at the next frame, see flush)
  }

  async load() {
    this.marks = await store.getMarks(this.bookId);
  }

  count() {
    let n = 0;
    for (const s of this.marks.values()) n += s.length;
    return n;
  }

  pagesWithMarks() {
    return [...this.marks.keys()].filter((p) => this.marks.get(p).length).sort((a, b) => a - b);
  }

  /** Overlay texture for a page, or null when the page has no ink. */
  texture(page) {
    const strokes = this.marks.get(page);
    const live = this.live && this.live.page === page;
    if ((!strokes || !strokes.length) && !live) {
      const l = this.layers.get(page);
      if (l) {
        l.tex.dispose();
        this.layers.delete(page);
      }
      return null;
    }
    let l = this.layers.get(page);
    if (!l) {
      const mk = () => {
        const c = document.createElement('canvas');
        c.width = OVERLAY_W;
        c.height = Math.round(OVERLAY_W / this.aspect);
        return c;
      };
      const canvas = mk();
      const base = mk();
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      // read back in small pieces while writing (see flush): keep these canvases where reading back is cheap
      l = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), base, bctx: base.getContext('2d'), tex, dirty: true, baseDirty: true, full: true, rect: null };
      this.layers.set(page, l);
      this.onDirty && this.onDirty(page);
    }
    return l.tex;
  }

  /**
   * Let go of the layers of pages not in `keep` (a page with marks holds two page-sized canvases and a texture,
   * ≈ 13 MB: over a long sitting they added up). The marks stay; a page shown again gets its layer back.
   */
  evict(keep) {
    for (const [page, l] of this.layers) {
      if (keep.has(page) || (this.live && this.live.page === page)) continue;
      l.tex.dispose();
      l.canvas.width = l.canvas.height = 1;
      l.base.width = l.base.height = 1;
      this.layers.delete(page);
    }
  }

  /**
   * Draw what changed, once a frame (the reader calls this before rendering). While a stroke is being written
   * only the few pixels around its newest part are redrawn, and `upload(tex, canvas, rect)` puts just those on the
   * GPU (returns false to fall back to a whole upload). Before, every Pencil sample (up to 240 a second) redrew
   * the whole page and sent all of it to the GPU, several times a frame.
   */
  flush(upload = null) {
    for (const [page, l] of this.layers) {
      if (!l.dirty) continue;
      const W = l.canvas.width;
      const H = l.canvas.height;
      if (l.full || l.baseDirty || !l.rect) this.redraw(page);
      else {
        const x = Math.max(0, Math.floor(l.rect.x0));
        const y = Math.max(0, Math.floor(l.rect.y0));
        const r = { x, y, w: Math.min(W, Math.ceil(l.rect.x1)) - x, h: Math.min(H, Math.ceil(l.rect.y1)) - y };
        if (r.w > 0 && r.h > 0) {
          this.redrawRect(page, l, r);
          if (!upload || !upload(l.tex, l.canvas, r)) l.tex.needsUpdate = true;
        }
      }
      l.dirty = false;
      l.full = false;
      l.rect = null;
    }
  }

  /** Redraw one rectangle of a page's layer: the committed marks under it, and the stroke being written. */
  redrawRect(page, l, r) {
    const { ctx, canvas, base } = l;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(base, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    if (this.live && this.live.page === page) drawStroke(ctx, this.liveForDrawing(), canvas.width, canvas.height, r);
    ctx.restore();
  }

  /** The stroke being written, with the points the Pencil is predicted to reach next drawn on (not kept). */
  liveForDrawing() {
    const L = this.live;
    if (!L.pred || !L.pred.length) return L.stroke;
    const { wf, gf } = L.stroke;
    const more = (a) => a.concat(L.pred.filter((_, i) => i % 2 === 0).map(() => a[a.length - 1] ?? 1));
    return { ...L.stroke, pts: L.stroke.pts.concat(L.pred), wf: more(wf), gf: gf ? more(gf) : gf };
  }

  /** The rectangle (canvas px) a piece of the live stroke covers, from point index i (in pts) on. */
  liveRect(from) {
    const L = this.live;
    const l = this.layers.get(L.page);
    if (!l) return null;
    const W = l.canvas.width;
    const H = l.canvas.height;
    const s = L.stroke;
    const pad = s.w * W * Math.max(1, maxOf(s.wf)) * 0.9 + 4;
    const pts = s.pts.concat(L.pred || []);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = Math.max(0, from); i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i] * W);
      x1 = Math.max(x1, pts[i] * W);
      y0 = Math.min(y0, pts[i + 1] * H);
      y1 = Math.max(y1, pts[i + 1] * H);
    }
    if (x0 === Infinity) return null;
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }

  /** Mark part of the live stroke for redrawing (and whatever the last prediction covered). */
  touchLive(from) {
    const L = this.live;
    const l = this.layers.get(L.page);
    if (!l) return this.invalidate(L.page, false);
    let r = this.liveRect(from);
    if (L.predRect) r = r ? unionRect(r, L.predRect) : L.predRect;
    L.predRect = L.pred && L.pred.length ? this.liveRect(L.stroke.pts.length - 2) : null;
    if (!r) return;
    l.rect = l.rect ? unionRect(l.rect, r) : r;
    l.dirty = true;
    this.onDirty && this.onDirty(L.page);
  }

  /** Where the Pencil is predicted to be next ([u, v, …]; empty when the browser doesn't say). */
  predict(pts) {
    if (!this.live) return;
    this.live.pred = pts.length ? pts.slice(0, 6) : null;
    this.touchLive(this.live.stroke.pts.length - 2);
  }

  redraw(page) {
    const l = this.layers.get(page);
    if (!l) return;
    const { ctx, canvas, base, bctx } = l;
    const W = canvas.width;
    const H = canvas.height;
    if (l.baseDirty) {
      bctx.clearRect(0, 0, W, H);
      for (const s of this.marks.get(page) || []) drawStroke(bctx, s, W, H);
      l.baseDirty = false;
    }
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0);
    if (this.live && this.live.page === page) drawStroke(ctx, this.liveForDrawing(), W, H);
    l.dirty = false;
    l.tex.needsUpdate = true;
  }

  /**
   * `strokes`: the committed marks changed (a texture may appear or go: the reader is told). Otherwise only the
   * live stroke moved, and its pixels are drawn at the next frame.
   */
  invalidate(page, strokes = true) {
    const l = this.layers.get(page);
    if (l) {
      l.dirty = true;
      l.full = true;
      if (strokes) l.baseDirty = true;
    }
    if (strokes || !l) this.onTexture && this.onTexture(page);
    else this.onDirty && this.onDirty(page);
  }

  // -------------------------------------------------------------- drawing
  /** p: pen pressure 0…1, or null for fingers and mice (even weight); tilt: the Pencil's altitude (radians) or null. */
  begin(page, tool, u, v, p = null, tilt = null) {
    const stroke = makeStroke(tool);
    const kind = TOOL_KIND[tool] || 'marker';
    const st = inkSettings.get(tool);
    this.live = {
      page,
      stroke,
      kind,
      sens: p == null ? 0 : st.pressure,
      k: st.smooth || 0,
      su: u,
      sv: v,
      sp: p,
      ru: u,
      rv: v,
      rp: p,
      st: tilt,
    };
    this.push(u, v, p, tilt);
    if (!this.layers.get(page)) this.invalidate(page, false); // a page's first ink: the reader gives it a texture
  }

  push(u, v, p, tilt = null) {
    const L = this.live;
    const f = pointFactors(L.stroke.tool, p, L.sens, tilt);
    L.stroke.pts.push(round4(u), round4(v));
    L.stroke.wf.push(round2(f.wf));
    if (L.stroke.gf) L.stroke.gf.push(round2(f.gf));
    // the new segment (from the previous point) is what needs drawing
    if (this.layers.get(L.page)) this.touchLive(L.stroke.pts.length - 4);
  }

  extend(u, v, p = null, tilt = null) {
    const L = this.live;
    if (!L) return;
    L.ru = u;
    L.rv = v;
    L.rp = p;
    if (tilt != null) L.st = L.st == null ? tilt : L.st + (tilt - L.st) * 0.3; // tilt wobbles too
    // steadiness: the drawn point trails the pencil a little, ironing out tremor
    const f = 1 - 0.82 * L.k;
    L.su += (u - L.su) * f;
    L.sv += (v - L.sv) * f;
    if (p != null) L.sp = L.sp == null ? p : L.sp + (p - L.sp) * 0.5; // pressure is jittery; always calm it
    const pts = L.stroke.pts;
    const du = L.su - pts[pts.length - 2];
    const dv = (L.sv - pts[pts.length - 1]) / this.aspect;
    if (du * du + dv * dv < 0.0011 * 0.0011) {
      // too close for a new point, but let the pressure through (pressing harder in place)
      if (p != null) {
        const f = pointFactors(L.stroke.tool, L.sp, L.sens, L.st);
        L.stroke.wf[L.stroke.wf.length - 1] = round2(f.wf);
        if (L.stroke.gf) L.stroke.gf[L.stroke.gf.length - 1] = round2(f.gf);
        this.touchLive(L.stroke.pts.length - 2);
      }
      return;
    }
    this.push(L.su, L.sv, L.sp, L.st);
  }

  end() {
    const L = this.live;
    if (!L) return;
    L.pred = null; // the predicted points were only for show
    const { page, stroke } = L;
    // catch up with where the pencil actually lifted
    const pts = stroke.pts;
    const du = L.ru - pts[pts.length - 2];
    const dv = (L.rv - pts[pts.length - 1]) / this.aspect;
    if (du * du + dv * dv > 0.0006 * 0.0006) this.push(L.ru, L.rv, L.sp, L.st);
    this.live = null;
    if (pts.length === 2) {
      // a dot
      pts.push(round4(pts[0] + 0.0005), pts[1]);
      stroke.wf.push(stroke.wf[0]);
      if (stroke.gf) stroke.gf.push(stroke.gf[0]);
    }
    const list = this.marks.get(page) || [];
    list.push(stroke);
    this.marks.set(page, list);
    this.undoStack.push({ type: 'add', page, stroke });
    // a new mark goes on top of the others: draw just it onto the cached layer (rebuilding every mark on the page
    // at each stroke grows slow with a well-pencilled page); undo and the eraser still rebuild
    const l = this.layers.get(page);
    if (l && !l.baseDirty) {
      drawStroke(l.bctx, stroke, l.base.width, l.base.height);
      l.dirty = true;
      l.full = true;
      this.onTexture && this.onTexture(page);
    } else this.invalidate(page);
    this.save(page);
  }

  cancel() {
    if (!this.live) return;
    const p = this.live.page;
    this.live = null;
    this.invalidate(p, false);
  }

  /** Remove every stroke touched by an eraser at (u, v). Returns the number removed. */
  eraseAt(page, u, v, radius = 0.018 * inkSettings.get('eraser').size) {
    const list = this.marks.get(page);
    if (!list || !list.length) return 0;
    const a = this.aspect;
    const keep = [];
    let removed = 0;
    for (const s of list) {
      if (hitStroke(s, u, v / a, radius + (s.w * maxOf(s.wf)) / 2, a)) {
        this.undoStack.push({ type: 'remove', page, stroke: s });
        removed++;
      } else keep.push(s);
    }
    if (removed) {
      this.marks.set(page, keep);
      this.invalidate(page);
      this.save(page);
    }
    return removed;
  }

  clearPage(page) {
    const list = this.marks.get(page);
    if (!list || !list.length) return;
    for (const s of list) this.undoStack.push({ type: 'remove', page, stroke: s });
    this.marks.set(page, []);
    this.invalidate(page);
    this.save(page);
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return null;
    const list = this.marks.get(op.page) || [];
    if (op.type === 'add') {
      const i = list.lastIndexOf(op.stroke);
      if (i >= 0) list.splice(i, 1);
    } else list.push(op.stroke);
    this.marks.set(op.page, list);
    this.invalidate(op.page);
    this.save(op.page);
    return op.page;
  }

  save(page) {
    clearTimeout(this.saveTimers.get(page));
    this.saveTimers.set(
      page,
      setTimeout(() => {
        store.putMarks(this.bookId, page, this.marks.get(page) || []).catch((e) => console.warn('save marks', e));
      }, 350),
    );
  }

  dispose() {
    for (const l of this.layers.values()) l.tex.dispose();
    this.layers.clear();
    // flush pending saves
    for (const [page, t] of this.saveTimers) {
      clearTimeout(t);
      store.putMarks(this.bookId, page, this.marks.get(page) || []).catch(() => {});
    }
    this.saveTimers.clear();
  }
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
function round4(x) {
  return Math.round(x * 10000) / 10000;
}
function round5(x) {
  return Math.round(x * 100000) / 100000;
}
function unionRect(a, b) {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
function maxOf(a) {
  if (!a || !a.length) return 1;
  let m = 0;
  for (const x of a) if (x > m) m = x;
  return m;
}

// ------------------------------------------------------------------ geometry
/** Colour, alpha and tip of a stroke (falling back to the old fixed inks). */
export function strokeLook(s) {
  const legacy = INKS[s.tool] || INKS.yellow;
  return {
    rgb: s.c || legacy.rgb,
    alpha: s.a ?? legacy.alpha,
    tip: s.tip || 'round',
    kind: TOOL_KIND[s.tool] || 'marker',
    cover: s.gf && s.gf.length ? s.gf.reduce((a, b) => a + b, 0) / s.gf.length : 1, // a pencil's average grain, for flat fills
  };
}

const NIB_ANGLE = (-72 * Math.PI) / 180; // a chisel held the usual way: broad edge steep, leaning right
const NIB_THIN = 0.2; // nib thickness / nib length

/**
 * The stroke smoothed into a dense polyline in a W×H box: midpoint quadratics through the samples (as the
 * strokes have always been drawn), each split into short pieces, with interpolated half-widths (rs) and, for a
 * pencil, graphite cover (ds).
 */
function strokePath(s, W, H) {
  const p = s.pts;
  const n = p.length / 2;
  const wf = s.wf;
  const gf = s.gf;
  const r0 = Math.max(s.w * W, 0.9) / 2;
  const X = (i) => p[2 * i] * W;
  const Y = (i) => p[2 * i + 1] * H;
  const R = (i) => r0 * (wf && wf[i] != null ? wf[i] : 1);
  const D = (i) => (gf && gf[i] != null ? gf[i] : 1);
  const xs = [X(0)];
  const ys = [Y(0)];
  const rs = [R(0)];
  const ds = [D(0)];
  if (n === 1) return { xs, ys, rs, ds };
  const quad = (ax, ay, ar, ad, i, bx, by, br, bd) => {
    const cx = X(i);
    const cy = Y(i);
    const cr = R(i);
    const cd = D(i);
    const len = Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy);
    const steps = Math.max(1, Math.min(12, Math.ceil(len / 2.5)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const a = (1 - t) * (1 - t);
      const b = 2 * t * (1 - t);
      const c = t * t;
      xs.push(a * ax + b * cx + c * bx);
      ys.push(a * ay + b * cy + c * by);
      rs.push(a * ar + b * cr + c * br);
      ds.push(a * ad + b * cd + c * bd);
    }
  };
  if (n === 2) {
    xs.push(X(1));
    ys.push(Y(1));
    rs.push(R(1));
    ds.push(D(1));
    return { xs, ys, rs, ds };
  }
  let ax = X(0);
  let ay = Y(0);
  let ar = R(0);
  let ad = D(0);
  for (let i = 1; i < n - 1; i++) {
    const bx = (X(i) + X(i + 1)) / 2;
    const by = (Y(i) + Y(i + 1)) / 2;
    const br = (R(i) + R(i + 1)) / 2;
    const bd = (D(i) + D(i + 1)) / 2;
    quad(ax, ay, ar, ad, i, bx, by, br, bd);
    ax = bx;
    ay = by;
    ar = br;
    ad = bd;
  }
  xs.push(X(n - 1));
  ys.push(Y(n - 1));
  rs.push(R(n - 1));
  ds.push(D(n - 1));
  return { xs, ys, rs, ds };
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1];
  }
  return a / 2;
}
function orient(poly) {
  // every piece wound the same way, so the nonzero fill is their union
  if (signedArea(poly) < 0) {
    const out = new Array(poly.length);
    for (let i = 0, n = poly.length / 2; i < n; i++) {
      out[2 * i] = poly[2 * (n - 1 - i)];
      out[2 * i + 1] = poly[2 * (n - 1 - i) + 1];
    }
    return out;
  }
  return poly;
}
function arcSteps(r) {
  return Math.max(2, Math.min(9, Math.ceil(Math.sqrt(r) * 2.2)));
}
function circlePoly(x, y, r) {
  const n = arcSteps(r) * 2 + 2;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  return out;
}
/** Hull of two discs: half a circle round each end joined by straight sides. */
function capsulePoly(ax, ay, ar, bx, by, br) {
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.hypot(dx, dy);
  if (L + Math.min(ar, br) <= Math.max(ar, br) + 1e-6) return ar > br ? circlePoly(ax, ay, ar) : circlePoly(bx, by, br);
  const ang = Math.atan2(dy, dx);
  const out = [];
  const sb = arcSteps(br);
  for (let k = 0; k <= sb; k++) {
    const a = ang - Math.PI / 2 + (k / sb) * Math.PI;
    out.push(bx + Math.cos(a) * br, by + Math.sin(a) * br);
  }
  const sa = arcSteps(ar);
  for (let k = 0; k <= sa; k++) {
    const a = ang + Math.PI / 2 + (k / sa) * Math.PI;
    out.push(ax + Math.cos(a) * ar, ay + Math.sin(a) * ar);
  }
  return out;
}
/** Convex hull (monotone chain) of a handful of points, as a flat array. */
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop();
  up.pop();
  const out = [];
  for (const q of lo.concat(up)) out.push(q[0], q[1]);
  return out;
}
function nibCorners(x, y, r) {
  const ex = Math.cos(NIB_ANGLE) * r;
  const ey = Math.sin(NIB_ANGLE) * r;
  const tx = -ey * NIB_THIN;
  const ty = ex * NIB_THIN;
  return [
    [x + ex + tx, y + ey + ty],
    [x + ex - tx, y + ey - ty],
    [x - ex - tx, y - ey - ty],
    [x - ex + tx, y - ey + ty],
  ];
}

/** The stroke as polygons (flat [x, y, …] arrays in a W×H box), all wound the same way. */
export function strokePolygons(s, W, H) {
  const { xs, ys, rs } = strokePath(s, W, H);
  const tip = strokeLook(s).tip;
  const polys = [];
  const n = xs.length;
  if (tip === 'chisel') {
    if (n === 1) polys.push(hull(nibCorners(xs[0], ys[0], rs[0])));
    for (let i = 0; i + 1 < n; i++) polys.push(hull(nibCorners(xs[i], ys[i], rs[i]).concat(nibCorners(xs[i + 1], ys[i + 1], rs[i + 1]))));
  } else {
    if (n === 1) polys.push(circlePoly(xs[0], ys[0], rs[0]));
    for (let i = 0; i + 1 < n; i++) polys.push(capsulePoly(xs[i], ys[i], rs[i], xs[i + 1], ys[i + 1], rs[i + 1]));
  }
  return polys.map(orient);
}

/** Draw a stroke into a 2D context. `clip` ({ x, y, w, h }): only this part is wanted (a pencil draws less). */
export function drawStroke(ctx, s, W, H, clip = null) {
  const look = strokeLook(s);
  if (!s.pts || s.pts.length < 2) return;
  if (look.kind === 'pencil') return drawGraphite(ctx, s, look, W, H, clip);
  const polys = strokePolygons(s, W, H);
  ctx.save();
  ctx.globalAlpha = look.alpha;
  ctx.fillStyle = `rgb(${look.rgb.join(',')})`;
  ctx.beginPath();
  for (const q of polys) {
    ctx.moveTo(q[0], q[1]);
    for (let i = 2; i < q.length; i += 2) ctx.lineTo(q[i], q[i + 1]);
    ctx.closePath();
  }
  ctx.fill('nonzero');
  ctx.restore();
}

// ------------------------------------------------------------------ graphite
// A pencil line is graphite caught on the peaks of the paper's tooth. One pixel of an ink layer is about 0.15 mm
// of page, a few peaks wide, so each pixel holds *some* graphite: how much is the stroke's cover there (pressure,
// grade, tilt) against how high the tooth stands at that pixel. The tooth is one seamless field, ranked so that a
// cover c leaves on average a fraction c of the paper covered; a soft threshold turns rank and cover into the
// pixel's graphite (a hard lead skips more of the valleys, so its threshold is sharper and its line grainier).
// The grain belongs to the page, so lines drawn over the same spot catch on the same peaks, as on paper.
// Drawing: the stroke's cover is painted into a scratch canvas piece by piece, keeping the larger value where
// pieces overlap (so a stroke never doubles up on itself), with a rough fringe (wider, sparser) to fray the edges;
// then each pixel is turned into graphite and the result laid down once at the lead's alpha.
const TOOTH_N = 256;
const COVER_STEPS = 48;
const EVEN = 0.3;
const FRAY = [
  { r: 1.4, d: 0.34 }, // the fringe: the lead's edge only touches the highest peaks
  { r: 1, d: 1 },
];
let toothRank = null;
let scratch = null;
let sctx = null;

function toothField() {
  if (toothRank) return toothRank;
  const N = TOOTH_N;
  const NN = N * N;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const noise = () => {
    const a = new Float32Array(NN);
    for (let i = 0; i < NN; i++) a[i] = rnd();
    return a;
  };
  // wrapping box blur, so the tile repeats without seams
  const blur = (a, r) => {
    const t = new Float32Array(NN);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += a[y * N + ((x + k + N) % N)];
        t[y * N + x] = sum / (2 * r + 1);
      }
    const o = new Float32Array(NN);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += t[((y + k + N) % N) * N + x];
        o[y * N + x] = sum / (2 * r + 1);
      }
    return o;
  };
  const unit = (a) => {
    let m = 0;
    let v = 0;
    for (const x of a) m += x;
    m /= NN;
    for (const x of a) v += (x - m) * (x - m);
    const sd = Math.sqrt(v / NN) || 1;
    for (let i = 0; i < NN; i++) a[i] = (a[i] - m) / sd;
    return a;
  };
  // peaks finer than a pixel and about one, the clumps fibres make, and a little of the sheet's formation; no
  // direction (lines run every way, and a grain along them breaks them into dashes)
  const white = unit(noise());
  const fine = unit(blur(noise(), 1));
  const clump = unit(blur(blur(noise(), 2), 2));
  const cloud = unit(blur(blur(noise(), 9), 9));
  const f = new Float32Array(NN);
  for (let i = 0; i < NN; i++) f[i] = 0.32 * white[i] + 0.65 * fine[i] + 0.14 * clump[i] + 0.08 * cloud[i];
  const order = Array.from({ length: NN }, (_, i) => i).sort((a, b) => f[a] - f[b]);
  toothRank = new Float32Array(NN);
  for (let k = 0; k < NN; k++) toothRank[order[k]] = k / (NN - 1);
  return toothRank;
}

/** Make the tooth ahead of the first stroke (picked up: the pencil), so that stroke doesn't wait for it. */
export function warmGraphite() {
  toothField();
  scratchFor(1, 1);
}

function scratchFor(w, h) {
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratch.width = scratch.height = 64;
    sctx = scratch.getContext('2d', { willReadFrequently: true }); // read back every draw: keep it on the CPU
  }
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, Math.ceil(w / 64) * 64);
    scratch.height = Math.max(scratch.height, Math.ceil(h / 64) * 64);
  }
  return sctx;
}

function drawGraphite(ctx, s, look, W, H, clip) {
  const { xs, ys, rs, ds } = strokePath(s, W, H);
  const n = xs.length;
  const fr = FRAY[0].r;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = rs[i] * fr + 1.5;
    x0 = Math.min(x0, xs[i] - r);
    x1 = Math.max(x1, xs[i] + r);
    y0 = Math.min(y0, ys[i] - r);
    y1 = Math.max(y1, ys[i] + r);
  }
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1));
  y1 = Math.min(H, Math.ceil(y1));
  if (clip) {
    x0 = Math.max(x0, Math.floor(clip.x));
    y0 = Math.max(y0, Math.floor(clip.y));
    x1 = Math.min(x1, Math.ceil(clip.x + clip.w));
    y1 = Math.min(y1, Math.ceil(clip.y + clip.h));
  }
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return;
  const g = scratchFor(bw, bh);
  // 1. the cover, as grey on black; 'lighten' keeps the larger where pieces overlap
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000';
  g.fillRect(0, 0, bw, bh);
  g.globalCompositeOperation = 'lighten';
  g.setTransform(1, 0, 0, 1, -x0, -y0);
  const step = (d) => Math.min(COVER_STEPS, Math.round(d * COVER_STEPS));
  for (const pass of FRAY) {
    const bins = [];
    const add = (k, poly) => {
      if (k > 0) (bins[k] || (bins[k] = [])).push(orient(poly));
    };
    if (n === 1) add(step(ds[0] * pass.d), circlePoly(xs[0], ys[0], rs[0] * pass.r));
    for (let i = 0; i + 1 < n; i++) {
      // pieces wholly outside the wanted part are skipped
      const m = Math.max(rs[i], rs[i + 1]) * pass.r + 1;
      if (Math.max(xs[i], xs[i + 1]) + m < x0 || Math.min(xs[i], xs[i + 1]) - m > x1) continue;
      if (Math.max(ys[i], ys[i + 1]) + m < y0 || Math.min(ys[i], ys[i + 1]) - m > y1) continue;
      add(step(((ds[i] + ds[i + 1]) / 2) * pass.d), capsulePoly(xs[i], ys[i], rs[i] * pass.r, xs[i + 1], ys[i + 1], rs[i + 1] * pass.r));
    }
    bins.forEach((polys, k) => {
      if (!polys) return;
      const v = Math.round((k / COVER_STEPS) * 255);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.beginPath();
      for (const q of polys) {
        g.moveTo(q[0], q[1]);
        for (let i = 2; i < q.length; i += 2) g.lineTo(q[i], q[i + 1]);
        g.closePath();
      }
      g.fill('nonzero');
    });
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  // 2. cover × tooth → graphite, pixel by pixel
  const img = g.getImageData(0, 0, bw, bh);
  const px = img.data;
  const rank = toothField();
  const N = TOOTH_N;
  const inv = OVERLAY_W / W; // the tooth is the page's: the same size however large the page is drawn
  const grade = PENCIL_GRADES.find((q) => q.id === s.g) || PENCIL_GRADES[1];
  const soft = grade.soft;
  const [cr, cg, cb] = look.rgb;
  for (let y = 0; y < bh; y++) {
    const row = ((Math.floor((y + y0) * inv) % N) + N) % N * N;
    for (let x = 0; x < bw; x++) {
      const i = 4 * (y * bw + x);
      const d = px[i] / 255;
      if (d === 0) {
        px[i + 3] = 0;
        continue;
      }
      const t = rank[row + (Math.floor((x + x0) * inv) % N)];
      let a = (t - 1 + d) / soft + 0.5;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      // a pixel spans a few peaks: part of it is simply the cover, the rest the grain (a thin line thins, not breaks)
      a = EVEN * d + (1 - EVEN) * a;
      if (d < 0.12) a *= d / 0.12; // a vanishing cover (an antialiased edge) stays vanishing
      px[i] = cr;
      px[i + 1] = cg;
      px[i + 2] = cb;
      px[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalAlpha = look.alpha;
  ctx.drawImage(scratch, 0, 0, bw, bh, x0, y0, bw, bh);
  ctx.restore();
}

function hitStroke(s, u, vy, r, aspect) {
  const p = s.pts;
  const r2 = r * r;
  for (let i = 0; i < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1] / aspect;
    if (i + 2 >= p.length) {
      const dx = u - ax;
      const dy = vy - ay;
      if (dx * dx + dy * dy <= r2) return true;
      break;
    }
    const bx = p[i + 2];
    const by = p[i + 3] / aspect;
    const vx = bx - ax;
    const vy2 = by - ay;
    const L = vx * vx + vy2 * vy2 || 1e-9;
    let t = ((u - ax) * vx + (vy - ay) * vy2) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = u - (ax + vx * t);
    const dy = vy - (ay + vy2 * t);
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

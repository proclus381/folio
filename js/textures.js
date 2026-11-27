// Procedural canvas textures: cloth weave, spines, typeset cloth covers, image covers, endpapers,
// page edges, paper. Everything is generated — no bitmap assets.

import * as THREE from 'three';
import { hash01, rng, clamp } from './anim.js';
import { defaultBinding } from './binding.js';

export const FONTS = {
  serif: '"Instrument Serif", "Iowan Old Style", Georgia, serif',
  mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  sans: '"Inter", -apple-system, "Helvetica Neue", Arial, sans-serif',
};

// Binding cloths, sampled from the kinds of colours seen on the reference shelf.
export const CLOTHS = [
  '#c3263c', // signal red
  '#3f434b', // slate
  '#8b8580', // warm grey
  '#4d5140', // olive
  '#d6be74', // ochre
  '#2c56a3', // cobalt
  '#6b2238', // oxblood
  '#cbb48e', // sand
  '#a8815e', // tan
  '#27282c', // ink
  '#2b3fb4', // ultramarine
  '#76726e', // stone
  '#2f4a3d', // forest
  '#d8a2b0', // rose
  '#e4e0d6', // bone
];

// ---------------------------------------------------------------- colour helpers
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function hexToHsl(hex) {
  let [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** Turn an arbitrary colour into something that reads as bookcloth. */
export function clothify(hex) {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, clamp(s * 0.85, 0.04, 0.62), clamp(l, 0.16, 0.74));
}

/** Choose the binding look for a book. */
export function chooseLook(id, title, analysis) {
  const r = rng(hash01(id + title));
  let cloth;
  if (analysis && analysis.designed && (analysis.edge || analysis.dominant)) {
    cloth = clothify(analysis.edge || analysis.dominant);
  } else {
    cloth = CLOTHS[Math.floor(hash01(title || id, 7) * CLOTHS.length)];
  }
  const dark = luminance(cloth) < 0.3;
  // stamped foils: gold, pale gold or ivory on dark cloth (the same family on every book), ink colours on light
  const foils = dark ? ['#d9ab5f', '#e2c48a', '#f0ece2'] : ['#1d1b19', '#7a1f2b', '#1f3b7a', '#1d1b19'];
  const accent = foils[Math.floor(r() * foils.length)];
  const ink = dark ? '#efebe2' : '#1f1d1a';
  const motifs = ['rings', 'grid', 'waves', 'stack', 'orbit'];
  return {
    cloth,
    ink,
    accent,
    spineStyle: 'serif', // every book in the same type (see makeSpineCanvas); Details offers mono and sans
    type: 2,
    motif: motifs[Math.floor(r() * motifs.length)],
    coverMode: analysis && analysis.designed ? 'image' : 'cloth',
    material: defaultBinding(),
  };
}

/** Palette for the "color" theme, derived from the selected book. */
export function themePalette(look) {
  // background: the cloth, deepened; ink: the book's foil when it reads on that ground
  const [h, s] = hexToHsl(look.cloth);
  const bg = hslToHex(h, clamp(s, 0.08, 0.35), 0.17);
  const foil = look.accent && luminance(look.accent) > 0.3 ? look.accent : null;
  const fg = foil || hslToHex(h, clamp(s + 0.15, 0.25, 0.6), 0.78);
  return { bg, fg };
}

// ---------------------------------------------------------------- texture helpers
export function canvasTexture(canvas, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.needsUpdate = true;
  return t;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

let grainCanvasCache = null;
function grainCanvas() {
  if (grainCanvasCache) return grainCanvasCache;
  const c = makeCanvas(128, 128);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(128, 128);
  const r = rng(0.4242);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 200 + r() * 55;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainCanvasCache = c;
  return c;
}

export function makeGrainTexture() {
  return canvasTexture(grainCanvas(), { srgb: false, repeat: [1, 1] });
}

// tileable gradient noise with separate periods along x and y (so features can lie along the grain)
function perlinTile(px, py, r) {
  const gx = new Float32Array(px * py);
  const gy = new Float32Array(px * py);
  for (let i = 0; i < gx.length; i++) {
    const a = r() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  return (x, y) => {
    const fx = x * px;
    const fy = y * py;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const i0 = ((x0 % px) + px) % px;
    const j0 = ((y0 % py) + py) % py;
    const i1 = (i0 + 1) % px;
    const j1 = (j0 + 1) % py;
    const a00 = j0 * px + i0;
    const a10 = j0 * px + i1;
    const a01 = j1 * px + i0;
    const a11 = j1 * px + i1;
    const n00 = gx[a00] * tx + gy[a00] * ty;
    const n10 = gx[a10] * (tx - 1) + gy[a10] * ty;
    const n01 = gx[a01] * tx + gy[a01] * (ty - 1);
    const n11 = gx[a11] * (tx - 1) + gy[a11] * (ty - 1);
    const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const a = n00 + (n10 - n00) * sx;
    const b = n01 + (n11 - n01) * sx;
    return a + (b - a) * sy; // ≈ −0.7 … 0.7
  };
}

/** Height field → slope texture (R, G = dh/dx, dh/dy scaled to fill the byte range; B = height). Tiles. */
function slopeCanvas(h, N, gain) {
  const g = slopeSteps(h, N, gain);
  let it = g.next();
  while (!it.done) it = g.next();
  return it.value;
}
function* slopeSteps(h, N, gain) {
  const c = makeCanvas(N, N);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      // Sobel, so single-pixel noise does not dominate
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
      const i = (y * N + x) * 4;
      // tangent-space normal ∝ (−∂h/∂u, −∂h/∂v, 1); the canvas is flipped into v, so ∂h/∂v = −∂h/∂y
      img.data[i] = clamp(128 - dx * gain * 127, 0, 255);
      img.data[i + 1] = clamp(128 + dy * gain * 127, 0, 255);
      img.data[i + 2] = ((at(x, y) - lo) / (hi - lo || 1)) * 255;
      img.data[i + 3] = 255;
      if (x === N - 1 && (y & 63) === 63) yield;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Binding surfaces, tileable, as two maps:
 *   slope  — R, G: the surface's slopes (as for the paper), B: height
 *   detail — R: albedo (0.5 = the binding's own colour), G: roughness offset (0.5 = none), B: height
 * `tile` is the size of one tile in book units (≈ cm).
 *
 * cloth   — book cloth: a plain weave of ≈10 threads/cm, threads a little uneven with slubs, the gaps
 *           filled with the starch coating, warp and weft each passing over and under.
 * leather — pebble-grained leather (or a leather-grain buckram): rounded pebbles ≈1.2 mm with creases
 *           between them, a few long wrinkles, the tops a touch glossier and paler.
 */
export function makeBindingTextures(kind) {
  const N = 512;
  const r = rng(kind === 'leather' ? 0.618 : 0.314);
  const h = new Float32Array(N * N);
  const alb = new Float32Array(N * N);
  const rough = new Float32Array(N * N);
  let tile;
  let gain;
  if (kind === 'leather') {
    tile = 2.4;
    gain = 4.2;
    // jittered grid of pebble centres (wraps)
    const G = 20;
    const cs = N / G;
    const px = new Float32Array(G * G);
    const py = new Float32Array(G * G);
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        px[j * G + i] = (i + 0.15 + r() * 0.7) * cs;
        py[j * G + i] = (j + 0.15 + r() * 0.7) * cs;
      }
    const wr1 = perlinTile(3, 4, r);
    const wr2 = perlinTile(7, 5, r);
    const mott = perlinTile(6, 6, r);
    const fine = perlinTile(96, 96, r);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const gi = Math.floor(x / cs);
        const gj = Math.floor(y / cs);
        let f1 = 1e9;
        let f2 = 1e9;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            let ii = gi + di;
            let jj = gj + dj;
            let ox = 0;
            let oy = 0;
            if (ii < 0) {
              ii += G;
              ox = -N;
            } else if (ii >= G) {
              ii -= G;
              ox = N;
            }
            if (jj < 0) {
              jj += G;
              oy = -N;
            } else if (jj >= G) {
              jj -= G;
              oy = N;
            }
            const dx = px[jj * G + ii] + ox - x;
            const dy = py[jj * G + ii] + oy - y;
            const d = dx * dx + dy * dy;
            if (d < f1) {
              f2 = f1;
              f1 = d;
            } else if (d < f2) f2 = d;
          }
        // distance to the border between the two nearest pebbles
        const edge = (Math.sqrt(f2) - Math.sqrt(f1)) / cs;
        const dome = Math.sqrt(Math.min(1, edge / 0.42));
        // long soft wrinkles: thin valleys along the zero lines of a low noise
        const w = Math.abs(wr1(x / N, y / N) * 0.7 + wr2(x / N, y / N) * 0.3);
        const wrinkle = 1 - Math.min(1, w / 0.022);
        const k = y * N + x;
        h[k] = dome * 0.8 - wrinkle * 0.16 + fine(x / N, y / N) * 0.05;
        const m = mott(x / N, y / N);
        alb[k] = 0.5 + (dome - 0.6) * 0.18 - wrinkle * 0.04 + m * 0.07;
        rough[k] = 0.5 - (dome - 0.6) * 0.35 + wrinkle * 0.1;
      }
  } else {
    tile = 3.2;
    gain = 6;
    const T = 32; // threads per tile each way
    const p = N / T;
    const tw = new Float32Array(T); // thread width (fraction of the pitch)
    const tt = new Float32Array(T); // thread tone
    const fw = new Float32Array(T);
    const ft = new Float32Array(T);
    for (let i = 0; i < T; i++) {
      tw[i] = 0.78 + r() * 0.16;
      tt[i] = (r() - 0.5) * 0.08;
      fw[i] = 0.76 + r() * 0.18;
      ft[i] = (r() - 0.5) * 0.08;
    }
    const slubW = perlinTile(T, 10, r); // thickening along each warp
    const slubF = perlinTile(10, T, r);
    const fuzz = perlinTile(128, 128, r);
    const mott = perlinTile(5, 5, r);
    // threads are never quite straight: each wanders a little across its neighbours' lines
    const wanderX = perlinTile(6, 3, r);
    const wanderY = perlinTile(3, 6, r);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const xx = x + wanderX(x / N, y / N) * p * 0.45;
        const yy = y + wanderY(x / N, y / N) * p * 0.45;
        const i = ((Math.floor(xx / p) % T) + T) % T;
        const j = ((Math.floor(yy / p) % T) + T) % T;
        const fx = xx / p - Math.floor(xx / p);
        const fy = yy / p - Math.floor(yy / p);
        const sw = 1 + slubW((i + 0.5) / T, y / N) * 0.35;
        const sf = 1 + slubF(x / N, (j + 0.5) / T) * 0.35;
        const aw = Math.max(0, 1 - Math.pow((fx - 0.5) / (0.5 * tw[i] * sw), 2));
        const af = Math.max(0, 1 - Math.pow((fy - 0.5) / (0.5 * fw[j] * sf), 2));
        // over and under: warp i is on top where (i + j) is even
        const zw = 0.5 + 0.5 * Math.sin(Math.PI * (yy / p) + Math.PI * i);
        const zf = 0.5 - 0.5 * Math.sin(Math.PI * (xx / p) + Math.PI * j);
        const hw = aw > 0 ? Math.sqrt(aw) * 0.55 + zw * 0.45 : 0;
        const hf = af > 0 ? Math.sqrt(af) * 0.55 + zf * 0.45 : 0;
        const k = y * N + x;
        const top = hw >= hf;
        let v = Math.max(hw, hf);
        v = Math.max(v, 0.32); // the coating fills the gaps
        v += fuzz(x / N, y / N) * 0.06;
        h[k] = v;
        alb[k] = 0.5 + (top ? tt[i] : ft[j]) + (v - 0.6) * 0.08 + mott(x / N, y / N) * 0.05;
        rough[k] = 0.5 - (v - 0.6) * 0.2;
      }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  // centre albedo and roughness on 0.5 so the binding keeps its chosen colour and finish on average
  let ma = 0;
  let mr = 0;
  for (let k = 0; k < N * N; k++) {
    ma += alb[k];
    mr += rough[k];
  }
  ma = ma / (N * N) - 0.5;
  mr = mr / (N * N) - 0.5;
  const dc = makeCanvas(N, N);
  const dctx = dc.getContext('2d');
  const img = dctx.createImageData(N, N);
  for (let k = 0; k < N * N; k++) {
    img.data[k * 4] = clamp((alb[k] - ma) * 255, 0, 255);
    img.data[k * 4 + 1] = clamp((rough[k] - mr) * 255, 0, 255);
    img.data[k * 4 + 2] = ((h[k] - lo) / (hi - lo || 1)) * 255;
    img.data[k * 4 + 3] = 255;
  }
  dctx.putImageData(img, 0, 0);
  return {
    slope: canvasTexture(slopeCanvas(h, N, gain), { srgb: false, repeat: [1, 1] }),
    detail: canvasTexture(dc, { srgb: false, repeat: [1, 1] }),
    tile,
  };
}

/**
 * The paper maps: flat stand-ins until a book's type is wanted (`use`), then each paper's own maps, simulated
 * from how it is made in Blender (tools/blender/paper.py → assets/paper/<type>-{surface,fibre,cockle}.webp).
 * Book wove's are cached for offline use; another type is fetched the first time a book uses it, and until then
 * (offline, say) it shows book wove's.
 */
export function makeDeferredPaperTextures() {
  const flat = () => {
    const c = makeCanvas(2, 2);
    const x = c.getContext('2d');
    x.fillStyle = 'rgb(128,128,128)';
    x.fillRect(0, 0, 2, 2);
    return canvasTexture(c, { srgb: false, repeat: [1, 1] });
  };
  const KEYS = ['normal', 'fibre', 'cockle'];
  const t = { normal: flat(), fibre: flat(), cockle: flat(), ready: false, type: null, want: null, onReady: null };
  // the last few types kept (≈ 5 MB each)
  const cache = new Map();
  const jobs = new Map();
  const loadImg = (url) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  const simulated = (type) =>
    Promise.all(['surface', 'fibre', 'cockle'].map((k) => loadImg(`assets/paper/${type}-${k}.webp`))).then(([normal, fibre, cockle]) => ({
      normal,
      fibre,
      cockle,
    }));
  const make = (type) => {
    const key = type;
    if (cache.has(key)) {
      const maps = cache.get(key);
      cache.delete(key);
      cache.set(key, maps); // most recently used last
      return Promise.resolve(maps);
    }
    if (jobs.has(key)) return jobs.get(key);
    const remember = (maps) => {
      cache.set(key, maps);
      for (const old of [...cache.keys()]) if (cache.size > 4 && old !== t.type && old !== key) cache.delete(old);
      jobs.delete(key);
      return maps;
    };
    // (a type whose images won't load, offline before it was ever fetched, shows book wove's for now, and is
    // tried again next time)
    const job = simulated(type).then(remember, () => {
      jobs.delete(key);
      if (type === 'wove') throw new Error('no paper maps');
      return make('wove');
    });
    jobs.set(key, job);
    return job;
  };
  const show = (type, maps) => {
    for (const k of KEYS) {
      t[k].image = maps[k];
      // The stand-in (or another type's map) may already be on the GPU at another size, in storage that can't
      // change: let it go, so the next use uploads this map at its own size (without this the paper stayed flat
      // grey whenever a book was opened before the maps were ready).
      t[k].dispose();
      t[k].needsUpdate = true;
    }
    t.type = type;
    t.ready = true;
    t.onReady && t.onReady();
  };
  /** Make a type's maps ahead of need (a book chosen on the shelf). */
  t.prepare = (type = 'wove') => make(type);
  /** Put a type's maps on the paper: now if they are made, else as soon as they are. */
  t.use = (type = 'wove') => {
    t.want = type;
    if (t.type === type) return;
    make(type)
      .then((maps) => {
        if (t.want === type) show(type, maps);
      })
      .catch(() => {
        /* the flat stand-in stays */
      });
  };
  t.fill = () => t.use(t.want || 'wove');
  return t;
}

export function makePageEdgeTexture() {
  const c = makeCanvas(8, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e3e2dc';
  ctx.fillRect(0, 0, 8, 256);
  const r = rng(0.31);
  for (let y = 0; y < 256; y += 3) {
    const a = 0.26 + r() * 0.26;
    ctx.fillStyle = `rgba(118,110,98,${a})`;
    ctx.fillRect(0, y + (r() < 0.3 ? 1 : 0), 8, 1);
    if (r() < 0.25) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(0, y + 2, 8, 1);
    }
  }
  const t = canvasTexture(c, { repeat: [1, 1] });
  t.magFilter = THREE.LinearFilter;
  return t;
}

/**
 * Marks of age and use, one tile ≈ 10 cm of paper (not colour; the shader tints them):
 *   R  foxing: scattered reddish-brown spots, ½–3 mm, some in loose clusters, with darker cores
 *   G  soil: slow, blotchy variation, so finger soil and toning are never an even wash
 *   B  a ragged line for the deckled fore-edge (read along y at any x)
 */
export function makeMarksTexture() {
  const N = 256;
  const c = makeCanvas(N, N);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const r = rng(0.5731);
  const fox = new Float32Array(N * N);
  const spot = (cx, cy, rad, k) => {
    const R = Math.ceil(rad * 2.2);
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++) {
        const d = Math.hypot(x, y * (0.8 + 0.4 * r())) / rad;
        if (d > 2.2) continue;
        const v = k * (d < 1 ? 1 - 0.35 * d : Math.exp(-(d - 1) * 2.6)) * (0.75 + 0.25 * r());
        const i = (((cy + y) % N) + N) % N * N + ((((cx + x) % N) + N) % N);
        fox[i] = Math.max(fox[i], v);
      }
  };
  for (let n = 0; n < 7; n++) {
    // a cluster
    const cx = r() * N;
    const cy = r() * N;
    const m = 3 + Math.floor(r() * 7);
    for (let j = 0; j < m; j++) spot(Math.round(cx + (r() - 0.5) * 40), Math.round(cy + (r() - 0.5) * 40), 0.8 + r() * 2.4, 0.5 + r() * 0.5);
  }
  for (let n = 0; n < 26; n++) spot(Math.round(r() * N), Math.round(r() * N), 0.6 + r() * 1.6, 0.35 + r() * 0.5);
  // soil: a few soft octaves of value noise, tileable
  const oct = [
    [4, 0.55],
    [8, 0.3],
    [16, 0.15],
  ].map(([g, a]) => ({ g, a, v: Array.from({ length: g * g }, () => r()) }));
  const smooth = (t) => t * t * (3 - 2 * t);
  const soil = (x, y) => {
    let v = 0;
    for (const o of oct) {
      const fx = (x / N) * o.g;
      const fy = (y / N) * o.g;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const at = (i, j) => o.v[(((j % o.g) + o.g) % o.g) * o.g + (((i % o.g) + o.g) % o.g)];
      v += o.a * ((at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty);
    }
    return v;
  };
  // deckle: a rough line, varying fast and slow
  const deck = Array.from({ length: N }, (_, y) => 0.5 + 0.5 * (soil(y * 7.3, 13) - 0.5) + 0.35 * (r() - 0.5));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      img.data[i] = Math.round(Math.min(1, fox[y * N + x]) * 255);
      img.data[i + 1] = Math.round(Math.min(1, Math.max(0, soil(x, y))) * 255);
      img.data[i + 2] = Math.round(Math.min(1, Math.max(0, deck[y])) * 255);
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(c, { srgb: false, repeat: [1, 1] });
}

/** A blank sheet with faint text blocks — stands in for a page while it renders, and for fanned leaves. */
export function makePaperCanvas(aspect = 0.7, seed = 0.5, lines = true) {
  const w = 256;
  const h = Math.round(w / aspect);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fbfbf9';
  ctx.fillRect(0, 0, w, h);
  if (lines) {
    const r = rng(seed);
    ctx.fillStyle = 'rgba(40,36,30,0.10)';
    const m = w * 0.13;
    let y = h * 0.1;
    while (y < h * 0.88) {
      if (r() < 0.12) {
        y += 9;
        continue;
      }
      const len = (w - 2 * m) * (r() < 0.15 ? 0.3 + r() * 0.5 : 0.92 + r() * 0.08);
      ctx.fillRect(m, y, len, 2.2);
      y += 6.2;
    }
  }
  return c;
}

// ---------------------------------------------------------------- endpaper
// ---------------------------------------------------------------- text helpers
function drawSpaced(ctx, text, x, y, spacing) {
  if (!spacing) {
    ctx.fillText(text, x, y);
    return;
  }
  // assumes textAlign = 'left'
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
}
function spacedWidth(ctx, text, spacing) {
  if (!spacing) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return w - spacing;
}
function wrapLines(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (ctx.measureText(next).width <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
function ellipsize(ctx, text, maxW, spacing = 0) {
  if (spacedWidth(ctx, text, spacing) <= maxW) return text;
  let t = text;
  while (t.length > 1 && spacedWidth(ctx, t + '…', spacing) > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

/** Small library mark: two leaning spines in a rounded frame. */
function drawMark(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.2, size * 0.075);
  const s = size / 2;
  ctx.beginPath();
  ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.stroke();
  // open-book glyph
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.36);
  ctx.quadraticCurveTo(-s * 0.32, -s * 0.5, -s * 0.58, -s * 0.36);
  ctx.lineTo(-s * 0.58, s * 0.36);
  ctx.quadraticCurveTo(-s * 0.32, s * 0.22, 0, s * 0.38);
  ctx.quadraticCurveTo(s * 0.32, s * 0.22, s * 0.58, s * 0.36);
  ctx.lineTo(s * 0.58, -s * 0.36);
  ctx.quadraticCurveTo(s * 0.32, -s * 0.5, 0, -s * 0.36);
  ctx.lineTo(0, s * 0.38);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- spine
/**
 * Spine lettering, in one type system for every book (the app's own): the author in small IBM Plex Mono capitals
 * at the head, the title in Instrument Serif in the middle of the run, the library mark at the tail. Sizes come
 * from the spine's height, which is about the same on every book, not from its thickness, so titles stand at one
 * size along the shelf; only a spine too thin to hold them sets them smaller. A long title steps down once (one
 * line, then two on a spine thick enough), and is cut short only after that. The Details panel's other spine
 * styles (mono, sans) change the title's face only.
 * `mask`: draw only what is stamped, white on black (see stampedTexture).
 */
/**
 * A spine's artwork. `spineWorldW` is the width the canvas covers (round the spine's curve); `faceW` the
 * width the spine shows head-on, which the lettering and the mark are sized for (the round only bends them).
 */
export function makeSpineCanvas(meta, look, spineWorldW, spineWorldH, mask = false, faceW = spineWorldW) {
  const H = 1024;
  const W = Math.max(72, Math.round((H * spineWorldW) / spineWorldH));
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = mask ? '#000' : look.cloth;
  ctx.fillRect(0, 0, W, H);

  // one foil for all of it: gold (or the binding's accent) on dark cloth, ink on light
  const col = mask ? '#fff' : luminance(look.cloth) < 0.3 ? look.accent : look.ink;
  const Wf = W * Math.min(1, faceW / spineWorldW); // the canvas width of the face the type is sized for
  const markSize = Math.min(Wf * 0.42, 44);
  const markY = H - markSize * 1.6;
  drawMark(ctx, W / 2, markY, markSize, col);

  const title = (meta.title || 'Untitled').trim();
  const author = (meta.author || '').trim();
  const style = look.spineStyle === 'mono' || look.spineStyle === 'sans' ? look.spineStyle : 'serif';
  const across = Wf * 0.74; // room across the spine for type

  ctx.save();
  ctx.translate(W / 2, 0);
  ctx.rotate(Math.PI / 2);
  // rotated space: x runs down the spine (0 → H), y runs across (−W/2 … W/2), letter tops face +canvas-x
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = col;
  const bottom = markY - markSize * 1.1;
  let cursor = H * 0.055;

  // author: small mono capitals, tracked like the app's labels
  if (author) {
    const aSize = Math.min(H * 0.0185, across * 0.36);
    ctx.font = `400 ${aSize}px ${FONTS.mono}`;
    const spacing = aSize * 0.08;
    const txt = ellipsize(ctx, author.toUpperCase(), H * 0.3, spacing);
    drawSpaced(ctx, txt, cursor, 0, spacing);
    cursor += spacedWidth(ctx, txt, spacing) + H * 0.045;
  }

  // title
  const avail = bottom - cursor;
  const base = Math.min(H * 0.046, across);
  let spacing = 0;
  const setFont = (sz) => {
    if (style === 'mono') {
      ctx.font = `400 ${sz * 0.74}px ${FONTS.mono}`;
      spacing = sz * 0.05;
    } else if (style === 'sans') {
      ctx.font = `500 ${sz * 0.76}px ${FONTS.sans}`;
      spacing = sz * 0.04;
    } else {
      ctx.font = `400 ${sz}px ${FONTS.serif}`;
      spacing = 0;
    }
  };
  const tText = style === 'serif' ? title : title.toUpperCase();
  const centred = (t, y) => drawSpaced(ctx, t, cursor + (avail - spacedWidth(ctx, t, spacing)) / 2, y, spacing);
  setFont(base);
  if (spacedWidth(ctx, tText, spacing) <= avail) centred(tText, 0);
  else {
    const small = base * 0.8;
    setFont(small);
    const lh = small * 1.06;
    if (spacedWidth(ctx, tText, spacing) <= avail) centred(tText, 0);
    else if (across >= lh * 2 && /\s/.test(tText)) {
      // two lines, split where they come out most even
      const words = tText.split(/\s+/);
      let best = 1;
      let bestDiff = Infinity;
      for (let i = 1; i < words.length; i++) {
        const d = Math.abs(spacedWidth(ctx, words.slice(0, i).join(' '), spacing) - spacedWidth(ctx, words.slice(i).join(' '), spacing));
        if (d < bestDiff) [best, bestDiff] = [i, d];
      }
      centred(ellipsize(ctx, words.slice(0, best).join(' '), avail, spacing), -lh / 2);
      centred(ellipsize(ctx, words.slice(best).join(' '), avail, spacing), lh / 2);
    } else centred(ellipsize(ctx, tText, avail, spacing), 0);
  }
  ctx.restore();
  return c;
}

// ---------------------------------------------------------------- covers
function drawMotif(ctx, look, W, H, seed) {
  const r = rng(seed);
  ctx.save();
  ctx.strokeStyle = look.accent;
  ctx.fillStyle = look.accent;
  const cx = W * 0.5;
  const cy = H * 0.55;
  switch (look.motif) {
    case 'rings': {
      ctx.lineWidth = Math.max(1.5, W * 0.0035);
      const n = 7 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        const rad = W * (0.06 + i * 0.026);
        ctx.beginPath();
        ctx.arc(cx + (i - n / 2) * W * 0.008, cy, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 'grid': {
      const cols = 9;
      const rows = 13;
      const gap = W * 0.042;
      const ox = cx - ((cols - 1) * gap) / 2;
      const oy = cy - ((rows - 1) * gap) / 2;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const big = r() < 0.12;
          if (r() < 0.08) continue;
          ctx.beginPath();
          ctx.arc(ox + x * gap, oy + y * gap, big ? W * 0.009 : W * 0.0035, 0, Math.PI * 2);
          ctx.fill();
        }
      break;
    }
    case 'waves': {
      ctx.lineWidth = Math.max(1.5, W * 0.003);
      const n = 16;
      const amp = W * 0.02 + r() * W * 0.02;
      const freq = 2 + r() * 2;
      for (let i = 0; i < n; i++) {
        const y = H * 0.36 + i * H * 0.022;
        ctx.beginPath();
        for (let x = W * 0.16; x <= W * 0.84; x += 4) {
          const yy = y + Math.sin((x / W) * Math.PI * freq + i * 0.35) * amp * Math.sin((x / W) * Math.PI);
          if (x === W * 0.16) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      break;
    }
    case 'stack': {
      const n = 14;
      const h = H * 0.011;
      for (let i = 0; i < n; i++) {
        const len = W * (0.2 + r() * 0.42);
        const x = cx - len / 2 + (r() - 0.5) * W * 0.06;
        ctx.fillRect(x, H * 0.4 + i * h * 2.1, len, h);
      }
      break;
    }
    default: {
      // orbit: dots on an ellipse with a centre
      ctx.lineWidth = Math.max(1.2, W * 0.0028);
      ctx.beginPath();
      ctx.ellipse(cx, cy, W * 0.26, W * 0.1, -0.35, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx, cy, W * 0.16, W * 0.27, 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, W * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * A typeset cloth cover for PDFs whose first page is not a designed cover, in the spine's type system: the title
 * in Instrument Serif at one size for every book (long titles step down once), a short rule, the ornament, and
 * the author in small IBM Plex Mono capitals at the foot.
 */
export function makeClothCoverCanvas(meta, look, aspect /* W/H of the board */, mask = false) {
  const W = 768;
  const H = Math.round(W / aspect);
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = mask ? '#000' : look.cloth;
  ctx.fillRect(0, 0, W, H);
  if (mask) look = { ...look, accent: '#fff', ink: '#fff' };
  const title = (meta.title || 'Untitled').trim();
  const author = (meta.author || '').trim();
  const m = W * 0.1;
  const col = mask ? '#fff' : luminance(look.cloth) < 0.3 ? look.accent : look.ink;

  // title block, top-left
  ctx.fillStyle = col;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  let size = W * 0.08;
  ctx.font = `400 ${size}px ${FONTS.serif}`;
  let lines = wrapLines(ctx, title, W * 0.62);
  if (lines.length > 4) {
    size = W * 0.064;
    ctx.font = `400 ${size}px ${FONTS.serif}`;
    lines = wrapLines(ctx, title, W * 0.68);
  }
  if (lines.length > 6) {
    lines = lines.slice(0, 6);
    lines[5] = ellipsize(ctx, lines[5] + ' …', W * 0.68);
  }
  let y = m + size * 0.9;
  for (const l of lines) {
    ctx.fillText(l, m, y);
    y += size * 1.04;
  }
  ctx.fillRect(m, y - size * 0.42, W * 0.07, Math.max(2, W * 0.003));

  drawMotif(ctx, look, W, H, hash01(title, 11));

  // author, bottom-left: the spine's small capitals
  if (author) {
    const aSize = W * 0.03;
    const spacing = aSize * 0.08;
    ctx.font = `400 ${aSize}px ${FONTS.mono}`;
    const al = wrapLines(ctx, author.toUpperCase(), W * 0.6).slice(0, 2);
    let ay = H - m - (al.length - 1) * aSize * 1.5;
    for (const l of al) {
      drawSpaced(ctx, l, m, ay, spacing);
      ay += aSize * 1.5;
    }
  }
  // corner mark
  drawMark(ctx, W - m * 0.95, m * 0.95, W * 0.07, col);
  return c;
}

/** Cover from the PDF's own first page (cover-fit onto the board). */
export function makeImageCoverCanvas(image, aspect) {
  const W = 768;
  const H = Math.round(W / aspect);
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const iw = image.width;
  const ih = image.height;
  const s = Math.max(W / iw, H / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.fillStyle = '#ddd';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return c;
}

/**
 * Colour artwork + its stamp mask in one texture: RGB from `color`, alpha = how much of the spot is
 * stamped into the binding (0 where the binding shows, 1 inside a letter). No mask → nothing stamped.
 * Built as raw data so the colour survives where the alpha is 0 (a canvas would premultiply it away).
 */
export function stampedTexture(color, mask = null, aniso = 8) {
  const W = color.width;
  const H = color.height;
  const cd = color.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const md = mask ? mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data : null;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const src = y * W * 4;
    const dst = (H - 1 - y) * W * 4; // rows bottom-up, as a flipped canvas texture would be
    for (let x = 0; x < W * 4; x += 4) {
      out[dst + x] = cd[src + x];
      out[dst + x + 1] = cd[src + x + 1];
      out[dst + x + 2] = cd[src + x + 2];
      out[dst + x + 3] = md ? md[src + x] : 0;
    }
  }
  const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * A headband: silk in two colours (`light`, `deep`) worked over a core in slanting beads, as in the Blender
 * model. u runs along it (one light and one dark bead per unit), v round it. Cached by colour.
 */
const bandCache = new Map();
export function makeHeadbandTexture(light, deep) {
  const key = light + deep;
  if (bandCache.has(key)) return bandCache.get(key);
  const W = 64;
  const H = 32;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  // (in sRGB, as the canvas is)
  const A = new THREE.Color(light).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const B = new THREE.Color(deep).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // a bead's slant: the phase climbs along the band and round it
      const ph = x / W + (y / H) * 0.5;
      const f = ph - Math.floor(ph);
      // two beads per tile, softened over a pixel at their borders
      const e = 1.2 / W;
      const t = Math.min(1, Math.max(0, (Math.min(f, 1 - f) - 0.25 + e) / (2 * e)));
      // t 1: light (the middle of [0.25, 0.75]), 0: deep
      const col = { r: B.r + (A.r - B.r) * t, g: B.g + (A.g - B.g) * t, b: B.b + (A.b - B.b) * t };
      // the silk's threads: fine lines along the slant, and each bead rounded a little by the light
      const th = 0.9 + 0.1 * Math.cos(ph * W * 0.5 * Math.PI);
      const bead = 0.86 + 0.14 * Math.sin(Math.PI * ((f * 2) % 1));
      const k = (y * W + x) * 4;
      img.data[k] = Math.round(255 * Math.min(1, col.r * th * bead));
      img.data[k + 1] = Math.round(255 * Math.min(1, col.g * th * bead));
      img.data[k + 2] = Math.round(255 * Math.min(1, col.b * th * bead));
      img.data[k + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = canvasTexture(c, { repeat: [1, 1], aniso: 4 });
  bandCache.set(key, t);
  return t;
}

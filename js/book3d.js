// Procedural hardcover book.
//
// Book frame (shared by the shelf and the reader):
//   x  across the page, spine/gutter at x = 0, fore-edge at x = +Wp (right half) / −Wp (left half)
//   y  up the page, centred
//   z  out of the pages; the boards' inner surfaces lie on z = 0 when the book is open flat
//
// The back board + right page stack never move. The front board + left stack + left resting leaf live
// in `leftContent`, which hinges around the axis (x = 0, z = tp/2): at angle 0 the book is open flat,
// at angle π that half lies exactly on top of the right half — the book is shut.

import * as THREE from 'three';
import { clamp } from './anim.js';
import { bindingKind, makeBindingMaterial, setBindingArt, setBindingKind } from './binding.js';
import { makeHeadbandTexture } from './textures.js';
import { reflectRoom } from './room.js';

export const SHELF_SCALE = 0.8;

/** calRel: the paper's thickness relative to Folio's own book wove (1), see paper.js. */
export function bookDims(pages, aspect, calRel = 1) {
  aspect = clamp(aspect || 0.7, 0.42, 2.2);
  let Hp = 22.6;
  let Wp = Hp * aspect;
  if (Wp > 17.4) {
    Wp = 17.4;
    Hp = Wp / aspect;
  }
  const ov = 0.36; // board overhang beyond the leaves
  const bt = 0.2; // board thickness
  const jb = 0.3; // half the joint gap between boards at the spine
  const tp = clamp(0.55 + pages * 0.0082 * calRel, 0.7, 5.6); // text block thickness
  const leaves = Math.max(1, Math.ceil(pages / 2));
  const Hc = Hp + 2 * ov;
  const Wc = Wp + ov - jb;
  const T = tp + 2 * bt;
  // the block is rounded and backed: its spine bulges out and its fore-edge is hollow by as much (as modelled
  // in tools/blender/folio_book.py), more for a thicker book
  const rd = clamp(0.11 * tp + 0.1, 0.1, 0.5);
  const d = { pages, aspect, calRel, Hp, Wp, ov, bt, jb, tp, leaves, Hc, Wc, T, rd };
  // the shut spine: its outer extent and its arc (the spine's artwork is laid out for that width)
  const c = spineCurve(d, Math.PI, 0);
  d.arc = c.outerArc;
  // closed-book bounding box (book frame) → centre used as the rotation pivot on the shelf
  const minX = Math.min(-0.42, c.minX);
  const maxX = jb + Wc;
  d.center = new THREE.Vector3((minX + maxX) / 2, 0, tp / 2);
  d.closedW = maxX - minX;
  return d;
}

// ------------------------------------------------------------------------------------------- the spine's curve
// The case spine runs from the back board's spine edge round to the front board's. Shut, it must clear the
// block's round with a little hollow behind it; open, it lies nearly flat under the gutter. Between the
// board and the spine's round the cloth dips into a French groove (the joint).
const SPINE_NS = 26;
const SPINE_CLEAR = 0.05; // the hollow between the block's round and the spine
const SPINE_TUCK = 0.08; // the spine's ends run this far into the boards' edges (no chink at the corners)
const GROOVE = { depth: 0.12, at: 0.32 + SPINE_TUCK, width: 0.17 }; // cm: how deep, how far from the board, how wide

/** The spine's centre line for a cover angle (0 open … π shut) and openness: points, unit tangents, arc. */
function spineCurve(d, angle, o) {
  const { jb, bt, tp, rd } = d;
  const zc = tp / 2;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const rot = (x, z) => [x * ca + (z - zc) * sa, -x * sa + (z - zc) * ca + zc];
  const x0 = jb + SPINE_TUCK;
  const A = [x0, -bt / 2];
  const dA = [-1, 0];
  const B = rot(-x0, -bt / 2);
  const dB = [-ca, sa];
  const dist = Math.hypot(B[0] - A[0], B[1] - A[1]) - 2 * SPINE_TUCK;
  // shut, the handles reach far enough for the curve to clear the round (x at mid-curve = x0 − ¾k)
  const kRound = (x0 + rd + SPINE_CLEAR + bt / 2) / 0.75;
  const k = Math.max(Math.min(0.9, dist * 0.36), kRound * (1 - o));
  const sag = 0.28 * o;
  const P1 = [A[0] + dA[0] * k, A[1] + dA[1] * k - sag];
  const P2 = [B[0] - dB[0] * k, B[1] - dB[1] * k - sag];
  const pts = [];
  const tans = [];
  for (let i = 0; i <= SPINE_NS; i++) {
    const t = i / SPINE_NS;
    const it = 1 - t;
    const x = it * it * it * A[0] + 3 * it * it * t * P1[0] + 3 * it * t * t * P2[0] + t * t * t * B[0];
    const z = it * it * it * A[1] + 3 * it * it * t * P1[1] + 3 * it * t * t * P2[1] + t * t * t * B[1];
    const dx = 3 * it * it * (P1[0] - A[0]) + 6 * it * t * (P2[0] - P1[0]) + 3 * t * t * (B[0] - P2[0]);
    const dz = 3 * it * it * (P1[1] - A[1]) + 6 * it * t * (P2[1] - P1[1]) + 3 * t * t * (B[1] - P2[1]);
    const l = Math.hypot(dx, dz) || 1;
    pts.push([x, z]);
    tans.push([dx / l, dz / l]);
  }
  const arc = [0];
  for (let i = 1; i <= SPINE_NS; i++) arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = arc[SPINE_NS] || 1;
  // the outer surface: half the spine's thickness out, less the groove near each end
  const half = bt / 2;
  const dips = arc.map((a) => grooveDip(a) + grooveDip(L - a));
  let outerArc = 0;
  let minX = Infinity;
  let prev = null;
  for (let i = 0; i <= SPINE_NS; i++) {
    const ho = half - dips[i];
    const q = [pts[i][0] - tans[i][1] * ho, pts[i][1] + tans[i][0] * ho];
    if (prev) outerArc += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    prev = q;
    minX = Math.min(minX, q[0]);
  }
  return { pts, tans, arc, L, dips, outerArc, minX };
}

/** How far the cloth dips into the French groove at arc distance a from a board. */
function grooveDip(a) {
  const t = (a - GROOVE.at) / GROOVE.width;
  return GROOVE.depth * Math.exp(-t * t);
}

/** Height of a page stack's top surface at distance x from the gutter. o = openness (0 shut … 1 flat open). */
export function stackProfile(h, o, Wp) {
  const g = Math.min(Wp * 0.45, 0.16 * Wp + 1.0 * h + 0.6);
  return (x) => {
    const xx = x < 0 ? 0 : x;
    const r = xx >= g ? 1 : 1 - Math.pow(1 - xx / g, 2.3);
    return h * (1 - o + o * r);
  };
}

// ------------------------------------------------------------------------------------------- stacks
// A page block is built from layers of leaves. Every layer follows the stack profile scaled to its
// height and is exactly Wp long along that curve — so in an open book the lower leaves reach further
// out than the top ones and the fore-edge slopes up toward the reader, showing its paper lines.
const STACK_NT = 36; // points along a leaf
const STACK_NL = 8; // layers through the thickness
const EDGE_LINES_PER_UNIT = 1 / 1.15;

const _lx = new Float32Array(STACK_NT + 1);
const _lz = new Float32Array(STACK_NT + 1);
/** Points at fixed arc-length fractions along z = scale·prof(x). Denser near the gutter. */
function layerPoints(prof, scale, len) {
  const steps = 500;
  const dx = (len * 1.15) / steps;
  let x = 0;
  let z = scale * prof(0);
  let s = 0;
  let i = 0;
  const target = (k) => {
    const t = k / STACK_NT;
    return len * (t * t * 0.35 + t * 0.65);
  };
  _lx[0] = 0;
  _lz[0] = z;
  i = 1;
  for (let n = 0; n < steps && i <= STACK_NT; n++) {
    const x1 = x + dx;
    const z1 = scale * prof(x1);
    const l = Math.hypot(dx, z1 - z);
    while (i <= STACK_NT && s + l >= target(i)) {
      const f = (target(i) - s) / l;
      _lx[i] = x + dx * f;
      _lz[i] = z + (z1 - z) * f;
      i++;
    }
    s += l;
    x = x1;
    z = z1;
  }
  for (; i <= STACK_NT; i++) {
    _lx[i] = x;
    _lz[i] = z;
  }
}

class StackMesh {
  constructor(d, paperMat, edgeMat, side) {
    this.d = d;
    this.side = side;
    const NT = STACK_NT;
    const NL = STACK_NL;
    const nCap = (NL + 1) * (NT + 1);
    const nFore = (NL + 1) * 2;
    const nTop = (NT + 1) * 2;
    const n = nTop + nFore + nCap * 2;
    this.pos = new Float32Array(n * 3);
    this.uv = new Float32Array(n * 2);
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    const ua = new THREE.BufferAttribute(this.uv, 2);
    ua.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('uv', ua);
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const idx = [];
    const tri = (a, b, c) => (side > 0 ? idx.push(a, b, c) : idx.push(a, c, b));
    // top: T(r,i) = r*(NT+1)+i, r 0 → y−, 1 → y+
    for (let i = 0; i < NT; i++) {
      const a = i;
      const b = i + 1;
      const c = NT + 1 + i;
      const e = NT + 1 + i + 1;
      tri(a, b, c);
      tri(b, e, c);
    }
    const topCount = idx.length;
    // fore edge: F(l,r) = nTop + l*2 + r
    const F = (l, r) => nTop + l * 2 + r;
    for (let l = 0; l < NL; l++) {
      tri(F(l, 0), F(l, 1), F(l + 1, 0));
      tri(F(l, 1), F(l + 1, 1), F(l + 1, 0));
    }
    // caps: head (y+) then tail (y−); C(l,i) = base + l*(NT+1) + i
    const head = nTop + nFore;
    const tail = head + nCap;
    for (let l = 0; l < NL; l++)
      for (let i = 0; i < NT; i++) {
        const a = l * (NT + 1) + i;
        const b = (l + 1) * (NT + 1) + i;
        const c = a + 1;
        const e = b + 1;
        tri(head + a, head + b, head + c);
        tri(head + c, head + b, head + e);
        tri(tail + a, tail + c, tail + b);
        tri(tail + c, tail + e, tail + b);
      }
    g.setIndex(idx);
    g.addGroup(0, topCount, 0);
    g.addGroup(topCount, idx.length - topCount, 1);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, [paperMat, edgeMat]);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.nTop = nTop;
    this.nFore = nFore;
    this.nCap = nCap;
    this.h = -1;
    this.o = -1;
  }

  update(h, o) {
    if (Math.abs(h - this.h) < 1e-5 && Math.abs(o - this.o) < 1e-5) return;
    this.h = h;
    this.o = o;
    this.mesh.visible = h > 0.004;
    if (!this.mesh.visible) return;
    const { Wp, Hp } = this.d;
    const s = this.side;
    const NT = STACK_NT;
    const NL = STACK_NL;
    const prof = stackProfile(h, o, Wp);
    const lines = h * EDGE_LINES_PER_UNIT;
    const P = this.pos;
    const U = this.uv;
    const set = (k, x, y, z, u, v) => {
      P[k * 3] = x * s;
      P[k * 3 + 1] = y;
      P[k * 3 + 2] = z;
      U[k * 2] = u;
      U[k * 2 + 1] = v;
    };
    const head = this.nTop + this.nFore;
    const tail = head + this.nCap;
    const { tp, rd } = this.d;
    for (let l = 0; l <= NL; l++) {
      const f = l / NL;
      // lower leaves bend less at the gutter, so they reach a little further out
      layerPoints(prof, f, Wp + (1 - f) * Math.min(0.5 * h, 0.3));
      // shut, the block is rounded: each leaf sits out toward the spine by the round at its depth through the
      // whole block (the spine bulges, the fore-edge is hollow); open, the leaves lie square
      const t = s > 0 ? f * h : tp - f * h;
      const q = clamp((2 * t) / tp - 1, -1, 1);
      const dx = -rd * (1 - q * q) * (1 - o);
      for (let i = 0; i <= NT; i++) {
        const v = f * lines;
        set(head + l * (NT + 1) + i, _lx[i] + dx, Hp / 2, _lz[i], i / NT, v);
        set(tail + l * (NT + 1) + i, _lx[i] + dx, -Hp / 2, _lz[i], i / NT, v);
      }
      set(this.nTop + l * 2, _lx[NT] + dx, -Hp / 2, _lz[NT], 0, f * lines);
      set(this.nTop + l * 2 + 1, _lx[NT] + dx, Hp / 2, _lz[NT], 1, f * lines);
      if (l === NL) {
        for (let i = 0; i <= NT; i++) {
          set(i, _lx[i] + dx, -Hp / 2, _lz[i], i / NT, 0);
          set(NT + 1 + i, _lx[i] + dx, Hp / 2, _lz[i], i / NT, 1);
        }
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

// ------------------------------------------------------------------------------------------- spine
// The case spine as a loop round its cross-section, for every point along its curve: up the outer face (the
// spine's artwork), rolled over into a head cap, down the inside (cloth), and rolled under at the tail. The
// cloth dips into the French groove next to each board (spineCurve). Headbands sit in the hollow at the head
// and tail of the block, against the spine's inside.
const CAP_STEPS = 4; // segments round a rolled cap
const BAND_R = 0.15; // a headband's core, ≈ 1.5 mm
const BAND_SEG = 10; // round it
const BAND_NS = 24; // along it
const BAND_PITCH = 0.16; // one light and one dark bead

class SpineMesh {
  constructor(d, spineMat, clothMat, bandMat = null) {
    this.d = d;
    // the loop: outer face tail → head (rows a little in from each end, for the caps' shading), the head cap,
    // the inside head → tail, the tail cap; it closes on row 0
    const rows = [];
    for (const f of [0, 0.035, 0.965, 1]) rows.push({ kind: 'out', f });
    for (let k = 1; k < CAP_STEPS; k++) rows.push({ kind: 'head', th: (k / CAP_STEPS) * Math.PI });
    for (const f of [1, 0.965, 0.035, 0]) rows.push({ kind: 'in', f });
    for (let k = 1; k < CAP_STEPS; k++) rows.push({ kind: 'tail', th: (k / CAP_STEPS) * Math.PI });
    this.rows = rows;
    const J = rows.length;
    const C = SPINE_NS + 1;
    const n = J * C;
    this.pos = new Float32Array(n * 3);
    this.uv = new Float32Array(n * 2);
    this.occ = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    const ua = new THREE.BufferAttribute(this.uv, 2);
    ua.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('uv', ua);
    g.setAttribute('folioOcc', new THREE.BufferAttribute(this.occ, 1));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    // the outer side of the loop carries the artwork; the inside and the turned-under half of each cap, cloth
    const outerSideT = (r) => r.kind === 'out' || (r.kind === 'head' && r.th <= Math.PI / 2 + 1e-6) || (r.kind === 'tail' && r.th >= Math.PI / 2 - 1e-6);
    const art = [];
    const cloth = [];
    for (let jr = 0; jr < J; jr++) {
      const jn = (jr + 1) % J;
      const list = outerSideT(rows[jr]) && outerSideT(rows[jn]) ? art : cloth;
      for (let i = 0; i < SPINE_NS; i++) {
        const a = jr * C + i;
        const b = jr * C + i + 1;
        const c = jn * C + i;
        const e = jn * C + i + 1;
        list.push(a, b, c, b, e, c);
      }
    }
    g.setIndex([...art, ...cloth]);
    g.addGroup(0, art.length, 0);
    g.addGroup(art.length, cloth.length, 1);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, [spineMat, clothMat]);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.key = '';
    if (bandMat) this.band = new BandMesh(bandMat);
  }

  /** Outer arc length of the spine when shut — the spine texture is laid out for this. */
  static closedArcLength(d) {
    return d.arc;
  }

  update(angle, o) {
    const key = angle.toFixed(4) + '|' + o.toFixed(4);
    if (key === this.key) return;
    this.key = key;
    const { bt, Hc, Hp } = this.d;
    const { pts, tans, arc, L, dips } = spineCurve(this.d, angle, o);
    const P = this.pos;
    const U = this.uv;
    const O = this.occ;
    const C = SPINE_NS + 1;
    const half = bt / 2;
    for (let i = 0; i <= SPINE_NS; i++) {
      const [px, pz] = pts[i];
      const nx = -tans[i][1]; // outward
      const nz = tans[i][0];
      const ho = half - dips[i];
      const hi = half;
      const r = (ho + hi) / 2;
      const c = (ho - hi) / 2;
      const ytop = Hc / 2 - r;
      const u = arc[i] / L;
      const sEnd = Math.min(arc[i], L - arc[i]);
      for (let jr = 0; jr < this.rows.length; jr++) {
        const row = this.rows[jr];
        let off;
        let y;
        if (row.kind === 'out') {
          off = ho;
          y = -ytop + 2 * ytop * row.f;
        } else if (row.kind === 'in') {
          off = -hi;
          y = -ytop + 2 * ytop * row.f;
        } else if (row.kind === 'head') {
          off = c + r * Math.cos(row.th);
          y = ytop + r * Math.sin(row.th);
        } else {
          off = c - r * Math.cos(row.th);
          y = -ytop - r * Math.sin(row.th);
        }
        const k = jr * C + i;
        P[k * 3] = px + nx * off;
        P[k * 3 + 1] = y;
        P[k * 3 + 2] = pz + nz * off;
        U[k * 2] = u;
        U[k * 2 + 1] = (y + Hc / 2) / Hc;
        O[k] = spineOcclusion(row, sEnd, Hc / 2 - Math.abs(y), off < c, u);
      }
    }
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.attributes.folioOcc.needsUpdate = true;
    g.computeVertexNormals();
    if (this.band) this.band.update(pts, tans, arc, L, half, Hp);
  }
}

/**
 * How much of the room's light a point of the spine loses to its own folds (0 none … 1 all), fitted to an
 * ambient-occlusion bake of this very geometry in Blender (tools/blender/folio_book.py, bake_spine_ao; rays
 * out to 1.2 cm, Walden's size, shut):
 *   outer face   ≈ 0.09 on the floor of the French groove, nothing elsewhere
 *   rolled caps  ≈ 0.10 on their inner side, where they turn under into the hollow
 *   inside       ≈ 0.30 near the head and tail, deepening to ≈ 0.57 behind the middle of the round
 */
function spineOcclusion(row, sEnd, fromEnd, inside, u) {
  if (row.kind === 'out') {
    const g = (sEnd - GROOVE.at) / GROOVE.width;
    return 0.09 * Math.exp(-g * g);
  }
  if (row.kind === 'head' || row.kind === 'tail') {
    // head caps run from the outside (th 0) over to the inside (π), tail caps the other way
    const inward = row.kind === 'head' ? row.th / Math.PI : 1 - row.th / Math.PI;
    return 0.1 * Math.max(0, (inward - 0.5) * 2) ** 1.5;
  }
  const deep = Math.sin(Math.PI * u) ** 3;
  return 0.3 + 0.27 * deep * Math.min(1, Math.max(0, (fromEnd - 0.1) / 0.7));
}

/** A headband: a two-coloured silk bead worked over a core, in the hollow at one end of the spine. */
class BandMesh {
  constructor(mat) {
    const C = BAND_SEG + 1;
    const n = (BAND_NS + 1) * C * 2;
    this.pos = new Float32Array(n * 3);
    this.uv = new Float32Array(n * 2);
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const idx = [];
    for (let b = 0; b < 2; b++)
      for (let j = 0; j < BAND_NS; j++)
        for (let k = 0; k < BAND_SEG; k++) {
          const a = (b * (BAND_NS + 1) + j) * C + k;
          const c = a + C;
          if (b === 0) idx.push(a, c, a + 1, a + 1, c, c + 1);
          else idx.push(a, a + 1, c, a + 1, c + 1, c);
        }
    g.setIndex(idx);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  update(pts, tans, arc, L, half, Hp) {
    // along the middle of the spine's curve (not into the joints), against its inside
    const trim = Math.min(0.32, 0.2 * L);
    const P = this.pos;
    const U = this.uv;
    const C = BAND_SEG + 1;
    let seg = 0;
    for (let j = 0; j <= BAND_NS; j++) {
      const sj = trim + ((L - 2 * trim) * j) / BAND_NS;
      while (seg < SPINE_NS - 1 && arc[seg + 1] < sj) seg++;
      const f = Math.min(1, Math.max(0, (sj - arc[seg]) / (arc[seg + 1] - arc[seg] || 1)));
      const px = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * f;
      const pz = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * f;
      let tx = tans[seg][0] + (tans[seg + 1][0] - tans[seg][0]) * f;
      let tz = tans[seg][1] + (tans[seg + 1][1] - tans[seg][1]) * f;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const nx = -tz; // outward from the spine
      const nz = tx;
      const cx = px - nx * (half + BAND_R * 0.9);
      const cz = pz - nz * (half + BAND_R * 0.9);
      for (let b = 0; b < 2; b++) {
        const sy = b === 0 ? 1 : -1;
        const cy = sy * (Hp / 2 - BAND_R * 0.3);
        for (let k = 0; k <= BAND_SEG; k++) {
          const a = (k / BAND_SEG) * Math.PI * 2;
          const v = (b * (BAND_NS + 1) + j) * C + k;
          P[v * 3] = cx + nx * Math.cos(a) * BAND_R;
          P[v * 3 + 1] = cy + Math.sin(a) * BAND_R;
          P[v * 3 + 2] = cz + nz * Math.cos(a) * BAND_R;
          U[v * 2] = (sj - trim) / BAND_PITCH;
          U[v * 2 + 1] = k / BAND_SEG;
        }
      }
    }
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.computeVertexNormals();
  }
}

// ------------------------------------------------------------------------------------------- boards
// A board under cloth: its outer corners a little rounded, the spine-side ones barely (they sit in the
// joint), the cloth rolled softly over every edge. Faces and UVs as BoxGeometry laid them out before, so the
// cover artwork lands where it did: groups 0 the edges (cloth), 1 the inside (endpaper), 2 the outside.
const BOARD_RC = 0.18;
const BOARD_RS = 0.07;
const BOARD_EDGE = 0.06;
const BOARD_ROLL = 3;
const BOARD_ARC = 6;

function boardGeometry(W, H, bt, fore) {
  const h = bt / 2;
  const E = BOARD_EDGE;
  // the outline round the corners, CCW seen from +z: (+x,−y) → (+x,+y) → (−x,+y) → (−x,−y)
  const corners = [
    [1, -1, -Math.PI / 2],
    [1, 1, 0],
    [-1, 1, Math.PI / 2],
    [-1, -1, Math.PI],
  ];
  const outline = []; // { cx, cy, r, dx, dy }
  for (const [sx, sy, a0] of corners) {
    const r = sx === fore ? BOARD_RC : BOARD_RS;
    const cx = sx * (W / 2 - r);
    const cy = sy * (H / 2 - r);
    for (let k = 0; k <= BOARD_ARC; k++) {
      const a = a0 + ((k / BOARD_ARC) * Math.PI) / 2;
      outline.push({ cx, cy, r, dx: Math.cos(a), dy: Math.sin(a) });
    }
  }
  outline.push(outline[0]); // closed, so the edges' u runs on without a jump
  const N = outline.length;
  // the edge's profile from the outside face round to the inside: (inset, z, normal xy part, normal z part)
  const prof = [];
  for (let k = 0; k <= BOARD_ROLL; k++) {
    const p = ((k / BOARD_ROLL) * Math.PI) / 2;
    prof.push([E - E * Math.sin(p), -h + E - E * Math.cos(p), Math.sin(p), -Math.cos(p)]);
  }
  for (let k = BOARD_ROLL; k >= 0; k--) {
    const p = ((k / BOARD_ROLL) * Math.PI) / 2;
    prof.push([E - E * Math.sin(p), h - E + E * Math.cos(p), Math.sin(p), Math.cos(p)]);
  }
  const pos = [];
  const nor = [];
  const uv = [];
  const groups = [[], [], []];
  const at = (o, inset) => [o.cx + o.dx * (o.r - inset), o.cy + o.dy * (o.r - inset)];
  const uvOuter = (x, y) => [(W / 2 - x) / W, (y + H / 2) / H];
  const uvInner = (x, y) => [(x + W / 2) / W, (y + H / 2) / H];
  // perimeter distance along the outline (the edges' cloth runs along it)
  const per = [0];
  for (let i = 1; i < N; i++) {
    const [ax, ay] = at(outline[i - 1], 0);
    const [bx, by] = at(outline[i], 0);
    per.push(per[i - 1] + Math.hypot(bx - ax, by - ay));
  }
  // rings: the outer roll carries the cover (its art wraps a little over the edge), the rest is cloth
  const ringStart = [];
  for (let m = 0; m < prof.length; m++) {
    ringStart.push(pos.length / 3);
    const [inset, z, nxy, nz] = prof[m];
    for (let i = 0; i < N; i++) {
      const o = outline[i];
      const [x, y] = at(o, inset);
      pos.push(x, y, z);
      nor.push(o.dx * nxy, o.dy * nxy, nz);
      if (m <= BOARD_ROLL) uv.push(...uvOuter(x, y));
      else uv.push(per[i] / 3, (z + h) / H);
    }
  }
  for (let m = 0; m < prof.length - 1; m++) {
    const g = m < BOARD_ROLL ? groups[2] : groups[0];
    const a0 = ringStart[m];
    const b0 = ringStart[m + 1];
    for (let i = 0; i < N - 1; i++) g.push(a0 + i, a0 + i + 1, b0 + i + 1, a0 + i, b0 + i + 1, b0 + i);
  }
  // the flat faces, as fans from the middle
  const fan = (inset, z, nz, uvf, list, flip) => {
    const c = pos.length / 3;
    pos.push(0, 0, z);
    nor.push(0, 0, nz);
    uv.push(...uvf(0, 0));
    const s0 = pos.length / 3;
    for (let i = 0; i < N; i++) {
      const [x, y] = at(outline[i], inset);
      pos.push(x, y, z);
      nor.push(0, 0, nz);
      uv.push(...uvf(x, y));
    }
    for (let i = 0; i < N - 1; i++) {
      if (flip) list.push(c, s0 + i + 1, s0 + i);
      else list.push(c, s0 + i, s0 + i + 1);
    }
  };
  fan(E, -h, -1, uvOuter, groups[2], true);
  fan(E, h, 1, uvInner, groups[1], false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const idx = [...groups[0], ...groups[1], ...groups[2]];
  g.setIndex(idx);
  g.addGroup(0, groups[0].length, 0);
  g.addGroup(groups[0].length, groups[1].length, 1);
  g.addGroup(groups[0].length + groups[1].length, groups[2].length, 2);
  return g;
}

// ------------------------------------------------------------------------------------------- book
export class BookModel {
  /**
   * @param d     dims from bookDims()
   * @param mats  { cover, back, cloth, endpaper, spine, paper, edge }
   */
  constructor(d, mats, { withLeftStack = true } = {}) {
    this.d = d;
    this.mats = mats;
    this.group = new THREE.Group();
    this.group.name = 'book';

    this.rightBoard = new THREE.Mesh(boardGeometry(d.Wc, d.Hc, d.bt, 1), [mats.cloth, mats.endpaper, mats.back]);
    this.rightBoard.position.set(d.jb + d.Wc / 2, 0, -d.bt / 2);
    this.rightBoard.castShadow = this.rightBoard.receiveShadow = true;
    this.group.add(this.rightBoard);

    this.leftPivot = new THREE.Group();
    this.leftPivot.position.set(0, 0, d.tp / 2);
    this.leftContent = new THREE.Group();
    this.leftContent.position.set(0, 0, -d.tp / 2);
    this.leftPivot.add(this.leftContent);
    this.group.add(this.leftPivot);

    this.leftBoard = new THREE.Mesh(boardGeometry(d.Wc, d.Hc, d.bt, -1), [mats.cloth, mats.endpaper, mats.cover]);
    this.leftBoard.position.set(-(d.jb + d.Wc / 2), 0, -d.bt / 2);
    this.leftBoard.castShadow = this.leftBoard.receiveShadow = true;
    this.leftContent.add(this.leftBoard);

    this.rightStack = new StackMesh(d, mats.paper, mats.edge, +1);
    this.group.add(this.rightStack.mesh);
    if (withLeftStack) {
      this.leftStack = new StackMesh(d, mats.paper, mats.edge, -1);
      this.leftContent.add(this.leftStack.mesh);
    }

    this.spine = new SpineMesh(d, mats.spine, mats.cloth, mats.headband);
    this.group.add(this.spine.mesh);
    if (this.spine.band) this.group.add(this.spine.band.mesh);

    this.coverAngle = Math.PI;
    this.hL = 0;
    this.openness = 0;
    this.apply();
  }

  /** angle: 0 open flat … π shut. hL: thickness of the left stack. */
  set(angle, hL, openness) {
    this.coverAngle = angle;
    this.hL = hL;
    this.openness = openness;
    this.apply();
  }

  get hR() {
    // (`air`: leaves lifted off it as a block, reader.js)
    return Math.max(0, this.d.tp - this.hL - (this.air || 0));
  }

  apply() {
    this.leftPivot.rotation.y = this.coverAngle;
    this.rightStack.update(this.hR, this.openness);
    if (this.leftStack) this.leftStack.update(this.hL, this.openness);
    this.spine.update(this.coverAngle, this.openness);
  }

  /** Meshes used for picking on the shelf. */
  pickables() {
    return [this.rightBoard, this.leftBoard, this.spine.mesh, this.rightStack.mesh];
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
}

// ------------------------------------------------------------------------------------------- materials
/**
 * The per-book material set. Boards, spine and the insides of the boards are all the binding (cloth or
 * leather, see binding.js) in the book's colour; `tex.spine` is the spine's artwork + stamp texture. The
 * front cover gets its artwork later (shelf.ensureCover) and shows the plain binding until then.
 */
export function makeBookMaterials(look, tex, shared, d, paper = null) {
  const kind = bindingKind(look);
  const cloth = new THREE.Color(look.cloth);
  const arc = d.arc;
  // (the hinge groove is in the spine's geometry now, not painted on the boards)
  const cover = makeBindingMaterial({ kind, color: cloth.clone(), faceW: d.Wc, faceH: d.Hc });
  // the back board's outer face runs from the fore-edge (u = 0) to the spine (u = 1)
  const back = makeBindingMaterial({ kind, color: cloth.clone(), faceW: d.Wc, faceH: d.Hc });
  const inner = makeBindingMaterial({ kind, color: cloth.clone(), faceW: d.Wc, faceH: d.Hc, wear: false });
  const edges = makeBindingMaterial({ kind, color: cloth.clone().multiplyScalar(0.9), faceW: 3, faceH: d.Hc, wear: false });
  // the boards' edges are often seen exactly edge-on (the spine-side edge under an open book's gutter): depth
  // on such a sliver is ill-conditioned and would poke a hairline through the pages — push it back
  edges.polygonOffset = true;
  edges.polygonOffsetFactor = 4;
  edges.polygonOffsetUnits = 4;
  const spine = makeBindingMaterial({ kind, faceW: arc, faceH: d.Hc });
  setBindingArt(spine, tex.spine);
  const block = paper ? makeBlockMaterials(shared, paper) : { paper: shared.paperMat, edge: shared.edgeMat };
  const headband = new THREE.MeshStandardMaterial({ map: headbandTexture(cloth), roughness: 0.55, metalness: 0 });
  return { cover, back, cloth: edges, endpaper: inner, spine, headband, ...block, ownBlock: !!paper };
}

/** A headband's two silks: ivory, and the binding's colour deepened nearly to black. */
function headbandTexture(cloth) {
  const deep = cloth.clone().multiplyScalar(0.22);
  return makeHeadbandTexture('#ebe3cd', '#' + deep.getHexString());
}

/**
 * The page block's own materials for a paper (paper.resolvePaper): its colour, and its edges toned with age,
 * soiled with use, or gilt.
 */
export function makeBlockMaterials(shared, r) {
  const paper = shared.paperMat.clone();
  paper.color.copy(r.block);
  let edge;
  if (r.edge === 'gilt') {
    // gilt: mostly its own gold (there is no room for a strong metal to reflect), with a soft sheen
    edge = reflectRoom(new THREE.MeshStandardMaterial({ map: shared.edgeMat.map, color: 0xe0b45a, metalness: 0.35, roughness: 0.42 }), 1, 'gilt');
  } else {
    edge = shared.edgeMat.clone();
    edge.color.copy(r.edgeColor);
  }
  return { paper, edge };
}

/** Recolour / change the binding of a material set in place. */
export function restyleBookMaterials(mats, look) {
  const kind = bindingKind(look);
  const cloth = new THREE.Color(look.cloth);
  for (const k of ['cover', 'back', 'endpaper', 'cloth', 'spine']) setBindingKind(mats[k], kind);
  mats.back.color.copy(cloth);
  mats.endpaper.color.copy(cloth);
  mats.cloth.color.copy(cloth).multiplyScalar(0.9);
  if (!mats.cover.map) mats.cover.color.copy(cloth);
  if (mats.headband) {
    mats.headband.map = headbandTexture(cloth);
    mats.headband.needsUpdate = true;
  }
}

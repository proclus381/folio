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
  // closed-book bounding box (book frame) → centre used as the rotation pivot on the shelf
  const minX = -0.42;
  const maxX = jb + Wc;
  return {
    pages,
    aspect,
    calRel,
    Hp,
    Wp,
    ov,
    bt,
    jb,
    tp,
    leaves,
    Hc,
    Wc,
    T,
    center: new THREE.Vector3((minX + maxX) / 2, 0, tp / 2),
    closedW: maxX - minX,
  };
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
    for (let l = 0; l <= NL; l++) {
      const f = l / NL;
      // lower leaves bend less at the gutter, so they reach a little further out
      layerPoints(prof, f, Wp + (1 - f) * Math.min(0.5 * h, 0.3));
      for (let i = 0; i <= NT; i++) {
        const v = f * lines;
        set(head + l * (NT + 1) + i, _lx[i], Hp / 2, _lz[i], i / NT, v);
        set(tail + l * (NT + 1) + i, _lx[i], -Hp / 2, _lz[i], i / NT, v);
      }
      set(this.nTop + l * 2, _lx[NT], -Hp / 2, _lz[NT], 0, f * lines);
      set(this.nTop + l * 2 + 1, _lx[NT], Hp / 2, _lz[NT], 1, f * lines);
      if (l === NL) {
        for (let i = 0; i <= NT; i++) {
          set(i, _lx[i], -Hp / 2, _lz[i], i / NT, 0);
          set(NT + 1 + i, _lx[i], Hp / 2, _lz[i], i / NT, 1);
        }
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

// ------------------------------------------------------------------------------------------- spine
const SPINE_NS = 22;

class SpineMesh {
  constructor(d, spineMat, clothMat) {
    this.d = d;
    const n = (SPINE_NS + 1) * 2;
    const total = n * 2 + n * 2; // outer, inner, head cap, tail cap
    this.pos = new Float32Array(total * 3);
    this.uv = new Float32Array(total * 2);
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    const idx = [];
    const R = SPINE_NS + 1;
    // outer: verts 0..n-1  (row 0 bottom y, row 1 top y)
    for (let i = 0; i < SPINE_NS; i++) idx.push(i, i + 1, R + i, i + 1, R + i + 1, R + i);
    const outerCount = idx.length;
    const o2 = n;
    for (let i = 0; i < SPINE_NS; i++) idx.push(o2 + i, o2 + R + i, o2 + i + 1, o2 + i + 1, o2 + R + i, o2 + R + i + 1);
    const c1 = n * 2; // head cap: row0 outer, row1 inner at y top
    for (let i = 0; i < SPINE_NS; i++) idx.push(c1 + i, c1 + R + i, c1 + i + 1, c1 + i + 1, c1 + R + i, c1 + R + i + 1);
    const c2 = n * 3;
    for (let i = 0; i < SPINE_NS; i++) idx.push(c2 + i, c2 + i + 1, c2 + R + i, c2 + i + 1, c2 + R + i + 1, c2 + R + i);
    g.setIndex(idx);
    g.addGroup(0, outerCount, 0);
    g.addGroup(outerCount, idx.length - outerCount, 1);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, [spineMat, clothMat]);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.key = '';
  }

  /** Outer arc length of the spine when shut — the spine texture is laid out for this. */
  static closedArcLength(d) {
    return d.T + 0.35;
  }

  update(angle, o) {
    const key = angle.toFixed(4) + '|' + o.toFixed(4);
    if (key === this.key) return;
    this.key = key;
    const { jb, bt, tp, Hc } = this.d;
    const zc = tp / 2;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const rot = (x, z) => [x * ca + (z - zc) * sa, -x * sa + (z - zc) * ca + zc];
    const A = [jb, -bt / 2];
    const dA = [-1, 0];
    const B = rot(-jb, -bt / 2);
    const dB = [-ca, sa];
    const dist = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const k = Math.min(0.9, dist * 0.36);
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
    const P = this.pos;
    const U = this.uv;
    let v = 0;
    const put = (x, y, z, u, w) => {
      P[v * 3] = x;
      P[v * 3 + 1] = y;
      P[v * 3 + 2] = z;
      U[v * 2] = u;
      U[v * 2 + 1] = w;
      v++;
    };
    const half = bt / 2;
    const outerPt = (i) => [pts[i][0] - tans[i][1] * half, pts[i][1] + tans[i][0] * half];
    const innerPt = (i) => [pts[i][0] + tans[i][1] * half, pts[i][1] - tans[i][0] * half];
    for (const y of [-Hc / 2, Hc / 2]) for (let i = 0; i <= SPINE_NS; i++) {
      const p = outerPt(i);
      put(p[0], y, p[1], arc[i] / L, (y + Hc / 2) / Hc);
    }
    for (const y of [-Hc / 2, Hc / 2]) for (let i = 0; i <= SPINE_NS; i++) {
      const p = innerPt(i);
      put(p[0], y, p[1], arc[i] / L, (y + Hc / 2) / Hc);
    }
    // caps: tail (−y) uses the first index block, head (+y) the second
    for (const y of [-Hc / 2, Hc / 2]) {
      for (let i = 0; i <= SPINE_NS; i++) {
        const p = outerPt(i);
        put(p[0], y, p[1], 0, 0);
      }
      for (let i = 0; i <= SPINE_NS; i++) {
        const p = innerPt(i);
        put(p[0], y, p[1], 0, 0);
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
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

    const boardGeo = new THREE.BoxGeometry(d.Wc, d.Hc, d.bt);
    this.rightBoard = new THREE.Mesh(boardGeo, [mats.cloth, mats.cloth, mats.cloth, mats.cloth, mats.endpaper, mats.back]);
    this.rightBoard.position.set(d.jb + d.Wc / 2, 0, -d.bt / 2);
    this.rightBoard.castShadow = this.rightBoard.receiveShadow = true;
    this.group.add(this.rightBoard);

    this.leftPivot = new THREE.Group();
    this.leftPivot.position.set(0, 0, d.tp / 2);
    this.leftContent = new THREE.Group();
    this.leftContent.position.set(0, 0, -d.tp / 2);
    this.leftPivot.add(this.leftContent);
    this.group.add(this.leftPivot);

    this.leftBoard = new THREE.Mesh(boardGeo, [mats.cloth, mats.cloth, mats.cloth, mats.cloth, mats.endpaper, mats.cover]);
    this.leftBoard.position.set(-(d.jb + d.Wc / 2), 0, -d.bt / 2);
    this.leftBoard.castShadow = this.leftBoard.receiveShadow = true;
    this.leftContent.add(this.leftBoard);

    this.rightStack = new StackMesh(d, mats.paper, mats.edge, +1);
    this.group.add(this.rightStack.mesh);
    if (withLeftStack) {
      this.leftStack = new StackMesh(d, mats.paper, mats.edge, -1);
      this.leftContent.add(this.leftStack.mesh);
    }

    this.spine = new SpineMesh(d, mats.spine, mats.cloth);
    this.group.add(this.spine.mesh);

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
    return Math.max(0, this.d.tp - this.hL);
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
  const arc = d.T + 0.35;
  const cover = makeBindingMaterial({ kind, color: cloth.clone(), faceW: d.Wc, faceH: d.Hc, groove: 0.045 });
  // the back board's outer face runs from the fore-edge (u = 0) to the spine (u = 1)
  const back = makeBindingMaterial({ kind, color: cloth.clone(), faceW: d.Wc, faceH: d.Hc, groove: 0.955 });
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
  return { cover, back, cloth: edges, endpaper: inner, spine, ...block, ownBlock: !!paper };
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
    edge = new THREE.MeshStandardMaterial({ map: shared.edgeMat.map, color: 0xe0b45a, metalness: 0.35, roughness: 0.42 });
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
}

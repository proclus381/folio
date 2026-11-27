// Turning leaves: the leaves in use and their states, a leaf taken by its edge (corner peel), turned by a tap,
// caught in the air, landing with its free edge whipping over (TIP: each paper's own physics), a jump turned as one
// block (CLUMP), and the top leaves settling as a book opens (DROP). Mixed into Reader (reader.js).
import { Leaf, NX, NY, makePageMaterial, surfaceTable } from './leaf.js';
import * as THREE from 'three';
import { clamp, easeInOutSine, easeOutCubic, lerp, smoothDamp, smoothstep } from './anim.js';
import { TURN_DUR, _N, _T, _U, _v, _w } from './reader-common.js';

// Corner peel: where you take hold of a leaf decides how it lifts.
//  - The fold tilts with the grab's height: square to the page at mid-height, 31.5° at a corner, and further with
//    the drag's own direction (pulled down from a top corner it tilts more, pulled up it straightens).
//  - Tilted, the leaf rolls into a cone: a tight tube at the corner you hold, a broad bend where the fold leaves by
//    the fore-edge.
//  - Pressed (or hovered with a mouse) near its fore-edge, the leaf lifts just beyond your finger, so a corner
//    peels and the middle of the edge lifts square. Dragged, the fold glides back to where a turning leaf bends.
//  - The point you hold stays under your finger. Held near the spine, the bend is softer (span up to ×2.2).
const PEEL = {
  tilt: 0.55, // rad, the fold's tilt at a corner
  tiltMax: 0.65, // with the drag's direction added
  turn: 0.45, // how much of the drag's direction goes into the tilt
  depth: 2.2, // cm from the finger back to the fold, pressed
  lift: 0.42, // rad: the farthest point of a pressed leaf lifts this far
  hover: 0.55, // a hover lifts this much of a press
  cone: 0.9,
  spine: 2.2, // the span's stretch, held at the spine
};
const _peel = {};

// A leaf in the air: the leaf's free edge is a damped spring riding
// on the turning leaf. β is the edge's angle against the rigid leaf (+ toward the left stack). While a hand holds the
// leaf (a drag, or the first 42 % of a tapped turn, where a hand lifts the corner) the edge keeps the held shape; let
// go, it answers to the air (it trails a fast leaf), to inertia (it lags a leaf that speeds up and runs on when the
// leaf slows: as a leaf lands its trailing edge whips over and slaps down), and to its own weight (it flops). Supple
// paper (paper.js: flex) flops further and slower. The stacks stop it, with a little bounce.
const TIP = {
  w0: 21, // rad/s, the edge's own spring at flex 1
  zeta: 0.28, // its damping ratio
  inertia: 0.012, // how far the edge lags per rad/s² of the leaf's angular acceleration
  drag: 0.045, // … per rad/s of its angular speed, in the air
  grav: 0.13, // its droop when the leaf lies level
  rest: 0.25, // restitution when it meets a stack
  most: 0.6, // rad: the air and inertia bend the edge at most about this far (they saturate smoothly)
  release: 0.42, // where a tapped turn's hand lets go
};

// Catch: a touch held on a leaf in the air brakes every leaf in the air to a stop (in
// about 0.2 s, starting 60 ms after the touch, so a quick tap or swipe doesn't stall them); hold still 0.2 s, or pull
// against its turn, and the touched leaf is in your hand. A swipe on with its turn queues the next page, as a swipe
// anywhere else does; a quick tap lets them fly on and does what a tap does.
const CATCH = { brake: 0.05, resume: 0.08, delay: 0.06, hold: 0.2, blend: 0.25 };

// Several leaves at once. A jump of more than three leaves turns as one
// block instead of a fan: the block as it is, its first and last leaf as far apart as the leaves between them are
// thick, its head, fore-edge and tail closed with page edges like the stacks', bending less the thicker it is. The
// stack it leaves is that much thinner from the moment it lifts, the one it lands on that much thicker when it's
// down. The turn takes 0.7 s + 45 ms · log2(leaves), at most 1.1 s (stripe.press's gather).
const CLUMP = { minThick: 0.06 };
const clumpDur = (n) => Math.min(1.1, 0.7 + 0.045 * Math.log2(Math.max(1, n)));

// Opening. As the book lands open at your place, the top leaves on each side
// spring up a little from the spine, then settle back onto their stacks one after another, the deepest first
// (50 ms apart, 0.4 s each, stripe.press's gravity drop), the fore-edge trailing on its cushion of air.
export const DROP = { n: 3, lift: [0.035, 0.025, 0.016], rise: 0.12, gap: 0.05, fall: 0.4 };

// Paper. The leaf moves as its paper is made (paper.js: phys): `sag` (weight over
// stiffness) sets how far its free edge droops and lags, `airy` (lightness) how much the air holds it (it floats
// down slower, trails further and, moving fast, flutters at 9–14 Hz), `ring` (stiffness over weight) how quickly
// its edge springs back. Bible paper floats and flutters; coated paper falls heavy; a card turns stiffly.
const PAPER_FLUTTER = 0.045; // rad of flutter per unit of lightness above 0.8, at full speed (on the edge itself)
const NEUTRAL_PHYS = { sag: 1, airy: 1, ring: 1 };

/** The fold's tilt for a grab at height gv (−½ bottom … ½ top). */
function grabTilt(gv) {
  return PEEL.tilt * Math.sign(gv) * smoothstep(0.12, 0.5, Math.abs(gv));
}

/** How much softer the bend, held at gu (0 at the gutter, 1 at the fore-edge). */
function spineSoft(gu) {
  return lerp(PEEL.spine, 1, smoothstep(0.2, 0.85, gu));
}

/**
 * The curl of a leaf pressed at (gu, gv), its fold tilted by `angle`: the fold sits PEEL.depth behind the finger,
 * and the leaf's farthest point beyond it lifts by `lift` (rad). Written into `out`.
 */
function peelCurl(out, d, gu, gv, angle, lift, spanMul) {
  const span = 32.4 * spanMul;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const px = Math.min(gu, 0.97) * d.Wp - PEEL.depth * dx;
  const py = clamp(gv, -0.5, 0.5) * d.Hp - PEEL.depth * dy;
  let far = 0.5;
  for (const cy of [-0.5, 0.5]) far = Math.max(far, (d.Wp - px) * dx + (cy * d.Hp - py) * dy);
  out.power = 0.86;
  out.span = span;
  out.angle = angle;
  out.pivotU = px / d.Wp;
  out.pivotV = py / d.Hp + 0.5;
  out.amount = lift * Math.pow(span / far, 0.86);
  out.cone = PEEL.cone * Math.min(1, Math.abs(angle) / PEEL.tilt);
  return out;
}

export class Turning {
  cachedTable(side, h, o) {
    const key = side + h.toFixed(5) + '|' + o.toFixed(4);
    if (!this._tables) this._tables = {};
    const c = this._tables[side];
    if (c && c.key === key) return c.tab;
    const tab = surfaceTable(h, o, this.d.Wp);
    this._tables[side] = { key, tab };
    return tab;
  }


  leftCount(time) {
    const N = this.d.leaves;
    if (this.fan) {
      const f = this.fan;
      // (a block carries its own leaves: the left stack keeps the smaller count until it's down)
      if (f.clump) return Math.min(f.s0, f.s1);
      const pr = smoothstep(0.15, 0.9, clamp((time - f.start) / f.total, 0, 1));
      return lerp(f.s0, f.s1, pr);
    }
    let c = this.s;
    for (const fl of this.flights) c += fl.dir > 0 ? fl.t : fl.t - 1;
    return clamp(c, 0, N);
  }


  // =============================================================== leaves
  acquireLeaf() {
    const leaf = this.pool.pop() || new Leaf(makePageMaterial(this.app.shared.paper));
    if (this.paperRes) leaf.material.roughness = this.paperRes.roughness;
    leaf.sig = '';
    leaf.curl.amount = 0;
    leaf.bend = 0;
    this.leafGroup.add(leaf.mesh);
    return leaf;
  }


  releaseLeaf(leaf) {
    if (leaf.mesh.parent) leaf.mesh.parent.remove(leaf.mesh);
    leaf.k = -1;
    leaf.setPages(null, null, null, null);
    this.pool.push(leaf);
  }


  /** Decide which leaves exist this frame and in what state. */
  syncLeaves(time) {
    const N = this.d.leaves;
    const need = new Map();
    if (this.fan) {
      const f = this.fan;
      if (f.dir > 0) {
        if (f.s1 < N) need.set(f.s1, { t: 0, eps: 0.012 });
        if (f.s0 - 1 >= 0) need.set(f.s0 - 1, { t: 1, eps: 0.012 });
      } else {
        if (f.s1 - 1 >= 0) need.set(f.s1 - 1, { t: 1, eps: 0.012 });
        if (f.s0 < N) need.set(f.s0, { t: 0, eps: 0.012 });
      }
      for (const fl of f.leaves) need.set(fl.k, fl);
    } else {
      const fwd = this.flights.filter((f) => f.dir > 0).length;
      const back = this.flights.filter((f) => f.dir < 0).length;
      const rk = this.s + fwd;
      const lk = this.s - 1 - back;
      if (rk < N) need.set(rk, { t: 0, eps: 0.012, rest: 'R' });
      if (lk >= 0) need.set(lk, { t: 1, eps: 0.012, rest: 'L' });
      if (this.drop && !this.flights.length) this.dropLeaves(need, time - this.drop.start);
      if (this.flights.length) {
        const ks = this.flights.map((f) => f.k);
        const kmin = Math.min(...ks);
        const kmax = Math.max(...ks);
        for (const fl of this.flights) {
          // forward: lower k on top while on the right, higher k on top once landed left
          const epsR = 0.02 + (fl.dir > 0 ? kmax - fl.k : fl.k - kmin) * 0.005;
          const epsL = 0.02 + (fl.dir > 0 ? fl.k - kmin : kmax - fl.k) * 0.005;
          fl.eps = lerp(epsR, epsL, fl.t);
          need.set(fl.k, fl);
        }
      }
    }
    // free leaves no longer needed
    for (const [k, leaf] of this.leafOf) {
      if (!need.has(k)) {
        this.releaseLeaf(leaf);
        this.leafOf.delete(k);
      }
    }
    for (const [k, st] of need) {
      let leaf = this.leafOf.get(k);
      if (!leaf) {
        leaf = this.acquireLeaf();
        leaf.k = k;
        leaf._fanTex = st.fanTex || null;
        this.leafOf.set(k, leaf);
        this.assignLeafTextures(leaf, leaf._fanTex);
      }
      if (this.phase !== 'closing' && leaf.mesh.parent !== this.leafGroup) this.leafGroup.add(leaf.mesh);
      leaf.t = st.t;
      leaf.eps = st.eps;
      leaf.off = st.off || 0;
      if (st.curl) {
        Object.assign(leaf.curl, st.curl);
        leaf.bend = st.bend || 0;
      } else if (st.rest) {
        const h = this.hover;
        const hoverSide = st.rest === 'R' ? 1 : -1;
        if (h.side === hoverSide && h.amount > 0) peelCurl(leaf.curl, this.d, h.su, h.sv, grabTilt(h.sv), PEEL.lift * PEEL.hover * h.amount, spineSoft(h.su));
        else leaf.curl.amount = 0;
        leaf.curl.cone = 0;
        leaf.bend = 0;
      } else {
        leaf.curl.amount = 0;
        leaf.curl.cone = 0;
        leaf.bend = 0;
      }
    }
  }


  // =============================================================== turning
  canTurn() {
    return this.active && this.phase === 'reading' && !this.fan;
  }


  flightCompletes(f) {
    return f.mode === 'auto' || (f.mode === 'settle' && (f.dir > 0 ? f.goal === 1 : f.goal === 0));
  }


  next() {
    if (!this.canTurn()) return false;
    if (this.flights.some((f) => f.dir < 0 || !this.flightCompletes(f))) return false;
    const fwd = this.flights.length;
    const k = this.s + fwd;
    if (k >= this.d.leaves || fwd >= 4) {
      if (k >= this.d.leaves) this.app.ui.nudge('end');
      return false;
    }
    this.flights.push(this.autoFlight(k, +1));
    this.app.ui.restChrome(); // reading on: the bars step aside
    this.app.lighting.gust(+1, 0.8);
    this.prefetchSpread(this.s + fwd + 1, 1);
    this.app.invalidate();
    return true;
  }


  prev() {
    if (!this.canTurn()) return false;
    if (this.flights.some((f) => f.dir > 0 || !this.flightCompletes(f))) return false;
    const back = this.flights.length;
    const k = this.s - 1 - back;
    if (k < 0 || back >= 4) {
      if (k < 0) this.app.ui.nudge('start');
      return false;
    }
    this.flights.push(this.autoFlight(k, -1));
    this.app.ui.restChrome();
    this.app.lighting.gust(-1, 0.8);
    this.prefetchSpread(this.s - back - 1, 1);
    this.app.invalidate();
    return true;
  }


  autoFlight(k, dir) {
    return {
      k,
      dir,
      mode: 'auto',
      t: dir > 0 ? 0 : 1,
      start: this.app.clock,
      // a supple leaf floats down a little longer (Paper: Own: a light one does, a heavy one falls sooner)
      dur: TURN_DUR * clamp(1 + 0.12 * (this.phys.airy - 1), 0.88, 1.2),
      curl: { amount: 0, power: 0.86, span: 32.4, angle: -0.3, pivotU: 0.6, pivotV: 0.5, cone: 0 },
      bend: 0,
      tv: { v: 0 },
    };
  }


  /** A block of leaves from here to s1, turned as one (CLUMP): a jump. */
  startClump(s1, time) {
    const angle = -0.25;
    const s0 = this.s;
    const count = Math.abs(s1 - s0);
    const dir = Math.sign(s1 - s0);
    if (!count) return;
    // the block as it is: its first and last leaf, as far apart as the leaves between them are thick
    const kMin = Math.min(s0, s1);
    const kMax = Math.max(s0, s1) - 1;
    const T = Math.max(CLUMP.minThick, (count * this.d.tp) / this.d.leaves);
    const curl = () => ({ amount: 0, power: 0.86, span: 32.4, angle, pivotU: 0.6, pivotV: 0.5, cone: 0 });
    // the face toward the leaf's front (its lower page number) is offset by the thickness; turning back, the block
    // lies the other way up
    const leaves = [{ k: kMin, dir, i: 0, t: dir > 0 ? 0 : 1, eps: 0.02, off: dir > 0 ? (count > 1 ? T : 0) : 0, curl: curl(), bend: 0, fanTex: null }];
    if (count > 1) leaves.push({ k: kMax, dir, i: 1, t: dir > 0 ? 0 : 1, eps: 0.02, off: dir > 0 ? 0 : -T, curl: curl(), bend: 0, fanTex: null });
    this.fan = {
      clump: true,
      s0,
      s1,
      dir,
      count,
      T,
      kMin,
      kMax,
      start: time,
      total: clumpDur(count),
      leaves,
      m: leaves.length,
      tc: 0,
      goal: 1,
    };
    this.app.lighting.gust(dir, 1.15);
    this.prefetchSpread(s1, 0);
    this.app.invalidate();
  }


  updateClump(f, dt, time) {
    const tau = clamp((time - f.start) / f.total, 0, 1);
    f.tc = easeInOutSine(tau);
    const done = tau >= 1;
    const flex = this.flex;
    const stiff = 1 / (1 + f.count / 24); // a thicker block bends less
    const swing = Math.pow(Math.sin(Math.PI * f.tc), 0.8);
    const bend = f.dir * 0.4 * stiff * Math.pow(flex, 0.8) * Math.sin(2 * Math.PI * f.tc);
    const curl = 2.2 * Math.pow(flex, 0.7) * stiff * swing;
    // it leaves one stack and lands on the other: its base moves up by its thickness as it passes upright
    const eps = 0.02 + f.T * smoothstep(0.35, 0.65, f.tc);
    for (const fl of f.leaves) {
      fl.t = f.dir > 0 ? f.tc : 1 - f.tc;
      fl.bend = bend;
      fl.curl.amount = curl;
      fl.eps = eps;
    }
    if (done) {
      const turned = f.goal === 1;
      this.s = turned ? f.s1 : f.s0;
      this.fan = null;
      if (turned) this.app.lighting.pagesRead += 2 * f.count;
      this.onSpreadChanged();
    }
  }


  /** The block's sides (head, fore-edge, tail): page edges between its two faces, drawn as the stacks' are. */
  updateClumpEdge() {
    const f = this.fan && this.fan.clump && this.fan.m > 1 ? this.fan : null;
    const a = f && this.leafOf.get(f.kMax);
    const b = f && this.leafOf.get(f.kMin);
    if (!a || !b) {
      if (this.clumpEdge) this.clumpEdge.visible = false;
      return;
    }
    if (!this.clumpEdge) {
      const n = NX + 1 + NY + NX; // tail (gutter → fore-edge), fore-edge (tail → head), head (fore-edge → gutter)
      this.clumpPath = [];
      for (let i = 0; i <= NX; i++) this.clumpPath.push([i, 0, i / NX]);
      for (let j = 1; j <= NY; j++) this.clumpPath.push([NX, j, j / NY]);
      for (let i = NX - 1; i >= 0; i--) this.clumpPath.push([i, NY, i / NX]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2 * 2), 2).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
      this.clumpEdge = new THREE.Mesh(g, this.model.rightStack.mesh.material[1]);
      this.clumpEdge.castShadow = true;
      this.clumpEdge.frustumCulled = false;
      this.clumpWind = 0;
    }
    const m = this.clumpEdge;
    if (m.parent !== this.leafGroup) this.leafGroup.add(m);
    m.material = this.model.rightStack.mesh.material[1];
    m.visible = true;
    const n = this.clumpPath.length;
    const P = m.geometry.attributes.position.array;
    const U = m.geometry.attributes.uv.array;
    const A = a.pos;
    const B = b.pos;
    const vTop = f.T / 1.15; // the stacks' edge texture: one repeat per 1.15 cm of thickness
    for (let q = 0; q < n; q++) {
      const [i, j, u] = this.clumpPath[q];
      const v = (j * (NX + 1) + i) * 3;
      P[q * 3] = A[v];
      P[q * 3 + 1] = A[v + 1];
      P[q * 3 + 2] = A[v + 2];
      P[(n + q) * 3] = B[v];
      P[(n + q) * 3 + 1] = B[v + 1];
      P[(n + q) * 3 + 2] = B[v + 2];
      U[q * 2] = u;
      U[q * 2 + 1] = 0;
      U[(n + q) * 2] = u;
      U[(n + q) * 2 + 1] = vTop;
    }
    // face outward: check a quad in the middle of the fore-edge against the way out of the block
    const q = NX + Math.floor(NY / 2);
    const p0 = _v.fromArray(P, q * 3);
    const e1 = _T.fromArray(P, (q + 1) * 3).sub(p0);
    const e2 = _U.fromArray(P, (n + q) * 3).sub(p0);
    const out = _N.fromArray(A, (Math.floor(NY / 2) * (NX + 1) + NX) * 3).sub(_w.fromArray(A, (Math.floor(NY / 2) * (NX + 1) + Math.floor(NX / 2)) * 3));
    const wind = e1.cross(e2).dot(out) > 0 ? 1 : -1;
    if (wind !== this.clumpWind) {
      this.clumpWind = wind;
      const idx = [];
      for (let k = 0; k < n - 1; k++) {
        const a0 = k;
        const a1 = k + 1;
        const b0 = n + k;
        const b1 = n + k + 1;
        if (wind > 0) idx.push(a0, a1, b0, a1, b1, b0);
        else idx.push(a0, b0, a1, a1, b0, b1);
      }
      m.geometry.setIndex(idx);
    }
    m.geometry.attributes.position.needsUpdate = true;
    m.geometry.attributes.uv.needsUpdate = true;
    m.geometry.computeVertexNormals();
  }


  startFan(s1, time, opening = false) {
    const s0 = this.s;
    if (s1 === s0) return;
    const count = Math.abs(s1 - s0);
    if (!opening && count > 3) {
      this.startClump(s1, time);
      return;
    }
    const dir = Math.sign(s1 - s0);
    const m0 = Math.min(count, opening ? 10 : 9);
    // the leaves that fly: spread evenly, plus the flagged leaves on the way, so their flags fly with them
    const ks = new Set();
    for (let i = 0; i < m0; i++) ks.add(dir > 0 ? s0 + (m0 > 1 ? Math.round((i * (count - 1)) / (m0 - 1)) : 0) : s0 - 1 - (m0 > 1 ? Math.round((i * (count - 1)) / (m0 - 1)) : 0));
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    let extra = 0;
    for (const f of this.flags || []) if (f.k >= lo && f.k < hi && !ks.has(f.k) && extra < 8 && ++extra) ks.add(f.k);
    const order = [...ks].sort((a, b) => (dir > 0 ? a - b : b - a));
    const m = order.length;
    const flightDur = m > 1 ? 0.52 : TURN_DUR;
    const total = m > 1 ? flightDur + 0.055 * (m - 1) + 0.12 : TURN_DUR;
    const leaves = [];
    this.prefetchSpread(s1, 0);
    for (let i = 0; i < m; i++) {
      const k = order[i];
      const edge = i === 0 || i === m - 1;
      leaves.push({
        k,
        dir,
        i,
        t: dir > 0 ? 0 : 1,
        start: time + (m > 1 ? (i * (total - flightDur - 0.06)) / (m - 1) : 0),
        dur: flightDur,
        eps: 0.02,
        curl: { amount: 0, power: 0.86, span: 32.4, angle: -0.25, pivotU: 0.6, pivotV: 0.5, cone: 0 },
        bend: 0,
        fanTex: edge ? null : this.fanPaper[i % this.fanPaper.length],
      });
    }
    this.fan = { s0, s1, dir, start: time, total, leaves, m };
    this.app.lighting.gust(dir, 1.15);
    this.app.invalidate();
  }


  updateFlights(dt, time) {
    let busy = false;
    const now = time;
    if (this.fan && this.fan.clump) {
      this.updateClump(this.fan, dt, time);
      return true;
    }
    if (this.fan) {
      busy = true;
      const f = this.fan;
      for (const fl of f.leaves) {
        const tau = clamp((time - fl.start) / fl.dur, 0, 1);
        const e = easeInOutSine(tau);
        fl.t = fl.dir > 0 ? e : 1 - e;
        fl.bend = fl.dir * 0.5 * Math.pow(this.flex, 0.8) * Math.sin(2 * Math.PI * tau) * (1 - tau * 0.3);
        fl.curl.amount = 2.0 * this.flex * Math.pow(Math.sin(Math.PI * Math.min(1, tau * 1.4)), 0.8) * (1 - tau);
        // order on the stacks: first-flying on top at the start, last-landed on top at the end
        const epsStart = 0.02 + (f.m - fl.i) * 0.004;
        const epsEnd = 0.02 + fl.i * 0.004;
        fl.eps = lerp(epsStart, epsEnd, fl.dir > 0 ? fl.t : 1 - fl.t);
      }
      if (time - f.start >= f.total) {
        this.s = f.s1;
        this.fan = null;
        this.onSpreadChanged();
      }
      return busy;
    }
    const g = this.gesture;
    if (g && g.mode === 'catch') {
      const held = this.app.clock - g.clock0;
      if (!g.braked && held >= CATCH.delay) {
        this.brakeAll(true);
        g.braked = true;
      }
      if (held >= CATCH.hold) this.grabCaught(g);
    }
    for (const fl of this.flights) {
      busy = true;
      // a caught leaf's brake (Catch): an auto turn's clock is held back, a settling leaf's time slowed
      const sp = fl.speed ?? 1;
      fl.speed = sp + ((fl.brake ? 0 : 1) - sp) * (1 - Math.exp(-dt / (fl.brake ? CATCH.brake : CATCH.resume)));
      if (fl.speed > 0.999 && !fl.brake) fl.speed = 1;
      const dts = dt * fl.speed;
      let held = null; // the edge's held shape (null: free)
      if (fl.mode === 'auto') {
        fl.start += dt - dts;
        const tau = clamp((now - fl.start) / fl.dur, 0, 1);
        const e = easeInOutSine(tau);
        fl.t = fl.dir > 0 ? e : 1 - e;
        // the hand lifts the corner first (tip leads), then the leaf falls and the tip trails
        // supple paper (paper.js: flex) lifts with more curl and a tip that trails further
        fl.bend = fl.dir * 0.6 * Math.pow(this.flex, 0.8) * Math.sin(2 * Math.PI * tau) * (1 - 0.4 * tau);
        fl.curl.amount = 2.4 * this.flex * Math.pow(Math.sin(Math.PI * Math.min(1, tau * 1.5)), 0.85) * Math.pow(1 - tau, 0.7);
        fl.done = tau >= 1;
        fl.goal = fl.dir > 0 ? 1 : 0;
        if (fl.from) this.peelHandoff(fl, tau);
        if (tau < TIP.release) held = fl.bend;
      } else if (fl.mode === 'drag') {
        fl.t = smoothDamp(fl.t, fl.target, fl.tv, 0.07, dt);
        if (fl.peel) this.peelFlight(fl, dt);
        else {
          const reach = Math.max(fl.reachMin || 0, smoothstep(0, this.d.Wp * 0.3, fl.dragDist || 0));
          fl.curl.amount = 6.2 * Math.pow(this.flex, 0.7) * reach * (0.35 + 0.65 * (1 - Math.abs(2 * fl.t - 1)));
        }
        fl.bend = fl.dir * 0.35 * Math.sin(Math.PI * fl.t);
        held = fl.bend;
        if (fl.caught) {
          // caught in the air: from its flying shape into the hand's over a quarter second
          const c = fl.caught;
          c.w = Math.min(1, c.w + dt / CATCH.blend);
          const w = smoothstep(0, 1, c.w);
          fl.curl.amount = lerp(c.amount, fl.curl.amount, w);
          fl.bend = lerp(c.bend, fl.bend, w);
          held = fl.bend;
        }
        fl.done = false;
      } else if (fl.mode === 'settle') {
        fl.t = smoothDamp(fl.t, fl.goal, fl.tv, 0.14 * clamp(Math.pow(this.phys.airy, 0.25), 0.8, 1.25), dts);
        fl.curl.amount *= Math.exp(-dts * 7);
        fl.bend = clamp(-fl.tv.v * 0.25, -0.9, 0.9) * Math.sin(Math.PI * fl.t);
        fl.done = Math.abs(fl.t - fl.goal) < 0.0015 && fl.curl.amount < 0.02;
        if (fl.done) fl.t = fl.goal;
      }
      this.tipStep(fl, dt, held);
      fl.bend = fl.tip.b + (fl.tip.fl || 0);
      if (fl.done) {
        // landed: wait (briefly) for the edge to come to rest on the stack
        fl.tip.over = (fl.tip.over || 0) + dt;
        fl.done = (Math.abs(fl.tip.b) < 0.01 && Math.abs(fl.tip.bv) < 0.3) || fl.tip.over > 0.35;
        if (!fl.done) busy = true;
      }
    }
    this.finishFlights(false);
    return busy;
  }


  /**
   * The free edge (TIP): follow the hand's shape while held (`held` not null), else integrate the spring driven by the
   * leaf's own swing, measured from its angle over the last frames.
   */
  tipStep(fl, dt, held) {
    const a = Math.PI * fl.t;
    let T = fl.tip;
    if (!T) T = fl.tip = { b: fl.bend || 0, bv: 0, a, w: 0, al: 0, over: 0 };
    if (dt <= 0) return;
    const w = (a - T.a) / dt;
    T.al += ((w - T.w) / dt - T.al) * 0.6;
    T.a = a;
    T.w = w;
    if (held != null) {
      // a hand holds it: the edge goes where the hand puts it (eased a touch, so a catch doesn't jump)
      const b = fl.mode === 'drag' ? T.b + (held - T.b) * (1 - Math.exp(-dt / 0.05)) : held;
      T.bv = (b - T.b) / dt;
      T.b = b;
      return;
    }
    // the paper's own: its stiffness against its weight springs it back; its weight against its stiffness droops and
    // lags it; its lightness gives the air a hold on it, and moving fast it flutters
    const ph = this.phys;
    const w0 = TIP.w0 * ph.ring;
    const most = TIP.most * clamp(Math.pow(ph.sag, 0.5), 0.6, 1.7);
    const push = most * Math.tanh((TIP.inertia * Math.pow(ph.sag, 0.5) * T.al + TIP.drag * Math.pow(ph.airy, 0.6) * w) / most);
    const droop = TIP.grav * ph.sag;
    if (T.ph == null) T.ph = Math.random() * 6.283;
    const tt = this.app.clock;
    // (a quiver far above the edge's own spring: it goes straight onto the edge, not through the spring)
    T.fl = PAPER_FLUTTER * Math.max(0, ph.airy - 0.8) * Math.min(1, Math.abs(w) / 6) * (Math.sin(58.4 * tt + T.ph) + 0.6 * Math.sin(88.6 * tt + 1.7 * T.ph));
    const K = w0 * w0;
    const C = 2 * TIP.zeta * w0;
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const acc = -K * T.b - C * T.bv - K * push - K * droop * Math.cos(a);
      T.bv += acc * h;
      T.b += T.bv * h;
      // the stacks stop it
      if (a + T.b < 0) {
        T.b = -a;
        if (T.bv < 0) T.bv = -TIP.rest * T.bv;
      } else if (a + T.b > Math.PI) {
        T.b = Math.PI - a;
        if (T.bv > 0) T.bv = -TIP.rest * T.bv;
      }
    }
  }


  /** Pointer → the leaf in the air under it (not one about to land), or null. */
  hitFlight(x, y) {
    const meshes = [];
    for (const fl of this.flights) {
      if (fl.mode === 'drag' || Math.abs(fl.t - (fl.goal ?? (fl.dir > 0 ? 1 : 0))) < 0.03) continue;
      const leaf = this.leafOf.get(fl.k);
      if (leaf) meshes.push(leaf.mesh);
    }
    if (!meshes.length) return null;
    this.raycaster.setFromCamera(this.ndc(x, y), this.app.camera);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const leaf = hit.object.userData.leaf;
    return this.flights.find((f) => f.k === leaf.k) || null;
  }


  brakeAll(on) {
    for (const fl of this.flights) fl.brake = on;
  }


  /** The caught leaf is in your hand: it becomes a drag from where it hangs, the others fly on. */
  grabCaught(g) {
    this.brakeAll(false);
    const fl = g.fl;
    const p = this.pointers.get(g.id);
    const bp = p && this.flights.includes(fl) && !this.flights.some((f) => f.mode === 'drag') ? this.bookPoint(p.x, p.y) : null;
    if (!bp) {
      g.mode = 'none';
      return;
    }
    const R = this.d.Wp * 0.98;
    fl.mode = 'drag';
    fl.speed = 1;
    fl.reachR = R;
    fl.offset = R * Math.cos(Math.PI * fl.t) - bp.x; // the finger holds it where it is
    fl.x0 = bp.x;
    fl.target = fl.t;
    fl.tv = { v: 0 };
    fl.dragDist = 0;
    fl.reachMin = 1; // it was already turning: the hand's full curl, not a fresh lift
    fl.caught = { amount: fl.curl.amount, bend: fl.bend, w: 0 };
    fl.done = false;
    delete fl.goal;
    delete fl.peel;
    delete fl.from;
    g.mode = 'turn';
    this.app.invalidate();
  }


  /** How the open book's paper moves (paper.js: phys). */
  get phys() {
    return this.paperPhys || NEUTRAL_PHYS;
  }


  /** How long the opening's leaves take to settle, by their paper's lightness. */
  dropFall() {
    return clamp(Math.pow(this.phys.airy, 0.4), 0.75, 1.4);
  }


  /** The top leaves of both stacks as they spring up and settle (DROP), `x` seconds after the book landed open. */
  dropLeaves(need, x) {
    const N = this.d.leaves;
    for (let j = 0; j < DROP.n; j++) {
      const rise = easeOutCubic(clamp(x / DROP.rise, 0, 1));
      const u = clamp((x - DROP.rise - (DROP.n - 1 - j) * DROP.gap) / (DROP.fall * this.dropFall()), 0, 1);
      const lift = DROP.lift[j] * Math.pow(this.flex, 0.3) * rise * (1 - smoothstep(0, 1, u));
      const trail = 0.14 * (DROP.lift[j] / DROP.lift[0]) * Math.sin(Math.PI * u) * Math.pow(this.flex, 0.8);
      const eps = 0.012 + (DROP.n - 1 - j) * 0.004; // the top leaf stays on top
      const curl = { amount: 0, power: 0.86, span: 32.4, angle: 0, pivotU: 0.74, pivotV: 0.5, cone: 0 };
      const r = this.s + j;
      const l = this.s - 1 - j;
      if (r < N) need.set(r, { t: lift, eps, bend: trail, curl: { ...curl } });
      if (l >= 0) need.set(l, { t: 1 - lift, eps, bend: -trail, curl: { ...curl } });
    }
  }


  /** A held leaf's curl (corner peel): pressed, it lifts beyond your finger; dragged, it bends as a turning leaf. */
  peelFlight(fl, dt) {
    const P = fl.peel;
    if (dt) P.press = smoothDamp(P.press, P.hold ? 1 : 0, P.pv, 0.07, dt);
    // the drag's own direction, in the leaf's frame (x out from the gutter): the fold turns toward it
    const L = Math.hypot(P.dx, P.dy);
    if (L > 0.3) {
      const goal = Math.atan2(-P.dy, Math.max(0.5 * L, -fl.dir * P.dx));
      P.ang += (goal - P.ang) * (1 - Math.exp(-dt * 9));
    }
    const angle = clamp(grabTilt(P.gv) + PEEL.turn * P.ang * smoothstep(0.5, 3, L), -PEEL.tiltMax, PEEL.tiltMax);
    const soft = spineSoft(P.gu);
    const reach = smoothstep(0, this.d.Wp * 0.3, fl.dragDist || 0);
    const c = peelCurl(_peel, this.d, P.gu, P.gv, angle, PEEL.lift * P.press, soft);
    const drag = 6.2 * Math.pow(this.flex, 0.7) * reach * (0.35 + 0.65 * (1 - Math.abs(2 * fl.t - 1)));
    Object.assign(fl.curl, c);
    fl.curl.amount = lerp(c.amount, drag, reach);
    fl.curl.pivotU = lerp(c.pivotU, 0.74, reach);
    fl.curl.pivotV = lerp(c.pivotV, 0.5, reach);
    // (a pressed corner just lifts; the cone comes with the turn, and eases as the leaf passes upright)
    const prog = fl.dir > 0 ? fl.t : 1 - fl.t;
    fl.curl.cone = c.cone * reach * (1 - 0.6 * smoothstep(0.35, 0.7, prog));
  }


  /** A tap on a pressed leaf turns it: the turn starts from the peel and keeps a corner's tilt. */
  peelHandoff(fl, tau) {
    const f = fl.from;
    const w = smoothstep(0, 0.35, tau);
    const angle = Math.abs(f.angle) > 0.2 ? f.angle : -0.3;
    const c = fl.curl;
    c.amount = lerp(f.amount, c.amount, w);
    c.angle = lerp(f.angle, angle, w);
    c.pivotU = lerp(f.pivotU, 0.6, w);
    c.pivotV = lerp(f.pivotV, 0.5, w);
    c.span = lerp(f.span, 32.4, w);
    c.cone = w * PEEL.cone * Math.min(1, Math.abs(c.angle) / PEEL.tilt);
  }


  /** Complete finished flights in order (so stacking stays consistent). */
  finishFlights(force) {
    let changed = false;
    let again = true;
    while (again) {
      again = false;
      for (let i = 0; i < this.flights.length; i++) {
        const fl = this.flights[i];
        if (!(fl.done || force)) continue;
        const goal = fl.goal ?? (fl.dir > 0 ? 1 : 0);
        const crossed = fl.dir > 0 ? goal >= 1 : goal <= 0;
        if (!crossed) {
          // cancelled drag: it simply returns to its side
          this.flights.splice(i, 1);
          again = true;
          break;
        }
        if (fl.dir > 0 && fl.k === this.s) {
          this.s++;
          this.app.lighting.pagesRead += 2; // a page turned by hand (for the candle's report)
          this.noteTurn(fl.k);
          this.flights.splice(i, 1);
          changed = true;
          again = true;
          break;
        }
        if (fl.dir < 0 && fl.k === this.s - 1) {
          this.s--;
          this.app.lighting.pagesRead += 2;
          this.noteTurn(fl.k);
          this.flights.splice(i, 1);
          changed = true;
          again = true;
          break;
        }
        if (force) {
          // out-of-order under force: drop it and fix s at the end
          this.flights.splice(i, 1);
          if (fl.dir > 0) this.s = Math.max(this.s, fl.k + 1);
          else this.s = Math.min(this.s, fl.k);
          changed = true;
          again = true;
          break;
        }
      }
    }
    if (changed) this.onSpreadChanged();
  }


  startDrag(dir, x, y, fromSwipe = false) {
    if (!this.canTurn()) return false;
    this.app.clearPeek();
    if (this.flights.length) return false;
    const k = dir > 0 ? this.s : this.s - 1;
    if (k < 0 || k >= this.d.leaves) {
      this.app.ui.nudge(dir > 0 ? 'end' : 'start');
      return false;
    }
    const bp = this.bookPoint(x, y);
    if (!bp) return false;
    const Wp = this.d.Wp;
    const grabY = clamp(bp.y, -this.d.Hp / 2, this.d.Hp / 2);
    const fl = {
      k,
      dir,
      mode: 'drag',
      t: dir > 0 ? 0 : 1,
      target: dir > 0 ? 0 : 1,
      tv: { v: 0 },
      x0: bp.x,
      // swipes start anywhere; act as if the edge were grabbed
      offset: fromSwipe ? (dir > 0 ? Wp * 0.95 - bp.x : -Wp * 0.95 - bp.x) : 0,
      dragDist: 0,
      curl: { amount: 0, power: 0.86, span: 32.4, angle: 0, pivotU: 0.74, pivotV: 0.5, cone: 0 },
      bend: 0,
    };
    // where it was taken: gu from the gutter out, gv up from the middle; pressed at the edge, it lifts at once
    const gu = clamp((dir > 0 ? bp.x : -bp.x) / Wp, 0, 1);
    // (a mouse's hover had already lifted it a little)
    const h = this.hover;
    const press = h.side === dir && !fromSwipe ? PEEL.hover * h.amount : 0;
    fl.peel = { gu, gv: grabY / this.d.Hp, gx: bp.x, gy: bp.y, dx: 0, dy: 0, ang: 0, press, pv: { v: 0 }, hold: !fromSwipe };
    // the point you hold stays under your finger (a swipe takes the edge, as before)
    fl.reachR = fromSwipe ? Wp * 0.98 : Math.max(0.6, gu) * Wp * 0.98;
    this.peelFlight(fl, 0);
    this.flights.push(fl);
    this.hover.target = 0;
    this.hover.amount = 0;
    this.prefetchSpread(dir > 0 ? this.s + 1 : this.s - 1, 1);
    this.app.invalidate();
    return true;
  }


  updateDrag(x, y) {
    const fl = this.flights.find((f) => f.mode === 'drag');
    if (!fl) return;
    const bp = this.bookPoint(x, y);
    if (!bp) return;
    const xp = bp.x + fl.offset;
    fl.target = Math.acos(clamp(xp / (fl.reachR || this.d.Wp * 0.98), -1, 1)) / Math.PI;
    fl.dragDist = Math.abs(bp.x - fl.x0);
    if (fl.peel) {
      fl.peel.dx = bp.x - fl.peel.gx;
      fl.peel.dy = bp.y - fl.peel.gy;
    }
    this.app.invalidate();
  }


  releaseDrag(cancel, vxPx = 0) {
    const fl = this.flights.find((f) => f.mode === 'drag');
    if (!fl) return;
    let complete;
    const flick = -vxPx; // px/s, positive = moving left
    if (cancel) complete = false;
    else if (fl.dir > 0) complete = (fl.t > 0.42 || flick > 450) && flick > -450;
    else complete = (fl.t < 0.58 || flick < -450) && flick < 450;
    fl.mode = 'settle';
    if (fl.peel) fl.peel.hold = false;
    fl.goal = complete ? (fl.dir > 0 ? 1 : 0) : fl.dir > 0 ? 0 : 1;
    if (complete) this.app.lighting.gust(fl.dir, 0.55 + Math.min(0.6, Math.abs(flick) / 2500));
    // carry some of the hand's speed into the settle
    fl.tv.v += clamp(flick / 2500, -1.5, 1.5);
    this.app.invalidate();
  }

}

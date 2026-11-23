// The open book: opening/closing choreography, leaf flights (drag / tap / fan), page stacks, page textures,
// annotation hit-testing, zoom & pan.

import * as THREE from 'three';
import { BookModel } from './book3d.js';
import { Leaf, makePageMaterial, surfaceTable, NX, NY } from './leaf.js';
import { FLAG, flagsOf, makeFlagMesh, flagMatrix, flagScreenBox, pickBox, layerAt } from './markers.js';
import { applyPaper } from './paper.js';
import { InkLayer, warmGraphite } from './ink.js';
import { openPdf, renderPageToCanvas, renderQueue, readOutline, marginTone, toneOf } from './pdfdoc.js';
import { canvasTexture, makePaperCanvas } from './textures.js';
import { SHELF_Z } from './shelf.js';
import * as store from './store.js';
import {
  clamp,
  lerp,
  seg,
  easeInOutCubic,
  easeOutCubic,
  easeInOutSine,
  smoothDamp,
  smoothstep,
} from './anim.js';

const DEG = Math.PI / 180;
const READ_PITCH = -22 * DEG;
const ZEN_MARGIN = 10; // px of room left at the closest screen edge in zen mode
const POOL = 18;
const OPEN = { lift: 0.42, travelAt: 0.3, travel: 1.15, coverAt: 0.5, cover: 1.0, gapAt: 0.15, gap: 1.0, fanAt: 1.42 };
const CLOSE = { swing: 0.55, travelAt: 0.22, travel: 0.8, settleAt: 0.95, settle: 0.45, gapAt: 0.35, gap: 0.9, done: 1.45 };
const TURN_DUR = 0.82;

// Corner peel (Settings ▸ Page corners ▸ Peel): where you take hold of a leaf decides how it lifts.
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

// A leaf in the air (Settings ▸ Turning ▸ Leaf in the air: Physical): the leaf's free edge is a damped spring riding
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

// Catch (Settings ▸ Turning ▸ Catch): a touch on a leaf in the air brakes every leaf in the air to a stop (in about
// 0.2 s); hold still 0.2 s, or move, and the touched leaf is in your hand. A quick tap lets them fly on and does what
// a tap does.
const CATCH = { brake: 0.05, resume: 0.08, hold: 0.2, blend: 0.25 };

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

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _P = new THREE.Vector3();
const _T = new THREE.Vector3();
const _U = new THREE.Vector3();
const _N = new THREE.Vector3();
const _w = new THREE.Vector3();

function pose() {
  return { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 };
}
function blendPose(out, a, b, t) {
  out.pos.copy(a.pos).lerp(b.pos, t);
  out.quat.copy(a.quat).slerp(b.quat, t);
  out.scale = lerp(a.scale, b.scale, t);
  return out;
}

export class Reader {
  constructor(app) {
    this.app = app;
    this.root = new THREE.Group();
    this.root.name = 'reader';
    this.root.visible = false;
    app.scene.add(this.root);
    this.penUpAt = -1e9;
    this.pool = [];
    for (let i = 0; i < POOL; i++) this.pool.push(new Leaf(makePageMaterial(app.shared.paper)));
    this.leafOf = new Map();
    this.flights = [];
    this.fan = null;
    this.active = false;
    this.phase = null;
    this.tool = null;
    this.zoom = 1;
    this.zoomTarget = 1;
    this.zoomV = { v: 0 };
    this.zen = false;
    this.localBox = null; // the book in reader-root coordinates, for the zen fit
    this.pan = new THREE.Vector2();
    this.panTarget = new THREE.Vector2();
    this.panVX = { v: 0 };
    this.panVY = { v: 0 };
    this.pointers = new Map();
    this.gesture = null;
    this.hover = { side: 0, amount: 0, v: { v: 0 }, angle: 0, target: 0, gu: 0.9, gv: 0, su: 0.9, sv: 0 };
    this.parallax = { x: 0, y: 0, tx: 0, ty: 0, vx: { v: 0 }, vy: { v: 0 } };
    this.raycaster = new THREE.Raycaster();
    this.flex = 1; // how supple the open book's paper is (1: book wove)
    this.lastTap = { t: 0, x: 0, y: 0 };
    this.poses = { a: pose(), b: pose(), c: pose(), out: pose(), from: pose() };
  }

  get isOpen() {
    return this.active;
  }

  get isZen() {
    return this.zen;
  }

  setZen(on) {
    on = !!on && this.active;
    if (on && (this.phase !== 'reading' || this.flights.length || this.fan)) on = false;
    if (this.zen === on) return;
    this.zen = on;
    if (on) {
      this.zoom = this.zoomTarget = 1;
      this.pan.set(0, 0);
      this.panTarget.set(0, 0);
      this.app.shelf.group.visible = false;
    } else {
      this.app.shelf.group.visible = true;
      this.app.shelf.openGapWidth = this.computeGapWidth();
    }
    this.app.ui.setZen(on);
    this.app.invalidate();
  }

  toggleZen() {
    this.setZen(!this.zen);
    return this.zen;
  }

  // =============================================================== open / close
  /** `at`: open at this spread instead of where you left off (a flag, the contents); your place is kept. */
  async open(entry, { at = null } = {}) {
    if (this.active) return;
    const app = this.app;
    this.entry = entry;
    this.meta = entry.meta;
    const d = (this.d = entry.d);
    this.active = true;
    this.phase = 'opening';
    this.tl = 0;
    this.fanStarted = false;
    this.s = 0;
    const saved = clamp(this.meta.spread || 0, 0, d.leaves);
    this.sTarget = at != null ? clamp(at, 0, d.leaves) : saved;
    this.finger = at != null && saved > 0 && saved !== this.sTarget ? { s: saved } : null;
    this.jumpLanded = at != null ? this.sTarget : null;
    this.flights = [];
    this.fan = null;
    this.zoom = this.zoomTarget = 1;
    this.pan.set(0, 0);
    this.panTarget.set(0, 0);
    this.tool = null;
    this.pages = new Map();
    this.doc = null;
    this.outline = null;

    // the shelf book's own materials (the insides of the boards are the binding too)
    const mats = entry.mats;
    app.shelf.ensureCover(entry);
    this.model = new BookModel(d, mats, { withLeftStack: true });
    this.model.group.position.copy(d.center).multiplyScalar(-1);
    this.root.add(this.model.group);
    this.localBox = null;
    this.leafGroup = new THREE.Group();
    this.model.group.add(this.leafGroup);
    this.model.set(Math.PI, 0, 0);
    this.initMarkers();

    // the paper's fibres at the same physical size whatever the page shape (one ≈9 cm map, 1.5 across a page)
    app.shared.paper.repeat.set(1.5, (1.5 * d.Hp) / d.Wp);
    this.scanSamples = [];
    this.applyPaper();
    this.placeholder = canvasTexture(makePaperCanvas(d.Wp / d.Hp, 0.3, true), { aniso: app.maxAniso });
    this.blankPaper = canvasTexture(makePaperCanvas(d.Wp / d.Hp, 0.3, false), { aniso: 1 });
    this.fanPaper = [0.11, 0.52, 0.83].map((s) => canvasTexture(makePaperCanvas(d.Wp / d.Hp, s, true), { aniso: 4 }));

    this.shelfPose(this.poses.out);
    this.applyPose(this.poses.out);
    this.root.visible = true;
    app.shelf.hiddenEntry = entry;
    app.shelf.openGapWidth = this.computeGapWidth();

    this.ink = new InkLayer(this.meta.id, d.Wp / d.Hp, (page) => this.onInkChanged(page), () => app.invalidate());
    this.ink.load().then(() => this.refreshAllLeafTextures());
    this.computeTexHeight();

    const myEntry = entry;
    store
      .getFile(this.meta.id)
      .then((blob) => {
        if (!blob) throw new Error('The PDF file for this book is missing.');
        return blob.arrayBuffer();
      })
      .then((buf) => openPdf(buf))
      .then((doc) => {
        if (!this.active || this.entry !== myEntry) {
          doc.destroy();
          return;
        }
        this.doc = doc;
        // first the pages seen while opening, then the saved spread
        this.requestPage(1, 0);
        this.requestPage(2, 1);
        this.prefetchSpread(this.sTarget, 0);
        readOutline(doc).then((o) => {
          this.outline = o;
          app.ui.onOutline && app.ui.onOutline(o);
        });
      })
      .catch((err) => {
        console.error(err);
        app.ui.toast(err.message || 'Could not open this PDF.');
      });

    this.meta.openedAt = Date.now();
    store.putBook(this.meta).catch(() => {});
    app.ui.setReading(true, this);
    this.updateBar();
    app.invalidate();
  }

  close() {
    if (!this.active || this.phase === 'closing') return;
    if (this.zen) this.setZen(false);
    if (this.phase === 'opening' && this.tl < 0.4) {
      // barely started: just go back
    }
    // settle anything in flight
    for (const fl of this.flights) {
      fl.t = fl.mode === 'drag' || fl.mode === 'settle' ? (fl.goal ?? (fl.dir > 0 ? 0 : 1)) : fl.dir > 0 ? 1 : 0;
    }
    this.finishFlights(true);
    if (this.fan) {
      this.s = this.fan.s1;
      this.fan = null;
    }
    this.ink && this.ink.cancel();
    this.tool = null;
    this.zoomTarget = 1;
    this.panTarget.set(0, 0);
    this.gesture = null;
    this.phase = 'closing';
    this.tl = 0;
    this.closeFromAngle = this.model.coverAngle;
    this.poses.from.pos.copy(this.root.position);
    this.poses.from.quat.copy(this.root.quaternion);
    this.poses.from.scale = this.root.scale.x;
    // the left half closes as one block: carry its resting leaf along
    const left = this.leafOf.get(this.s - 1);
    if (left) this.model.leftContent.add(left.mesh);
    clearTimeout(this._saveT);
    this.saveSpread();
    this.app.clearPeek();
    this.app.ui.setReading(false, this);
    this.app.invalidate();
  }

  finishClose() {
    const app = this.app;
    if (this.zen) this.setZen(false);
    for (const leaf of this.leafOf.values()) this.releaseLeaf(leaf);
    this.leafOf.clear();
    this.root.remove(this.model.group);
    this.model.dispose();
    this.placeholder.dispose();
    this.blankPaper.dispose();
    this.fanPaper.forEach((t) => t.dispose());
    for (const rec of this.pages.values()) rec.tex && rec.tex.dispose();
    this.pages.clear();
    renderQueue.cancelWhere((j) => j.key.startsWith(this.meta.id + ':'));
    if (this.doc) this.doc.destroy();
    this.doc = null;
    this.ink.dispose();
    this.disposeMarkers();
    this.root.visible = false;
    app.shelf.hiddenEntry = null;
    app.shelf.openGap = 0;
    this.active = false;
    this.phase = null;
    app.camera.zoom = 1;
    app.shelf.syncMarkers(this.entry); // its flags as you left them
    app.shelf.syncPaper(this.entry); // and its page block, a little more read
    app.onReaderClosed && app.onReaderClosed(this.entry);
    this.entry = null;
    app.invalidate();
  }

  // =============================================================== poses
  shelfPose(out) {
    const slot = this.entry.slot;
    out.pos.copy(slot.position);
    out.quat.setFromEuler(_e.set(0, slot.rotation.y, 0));
    out.scale = slot.scale.x;
    return out;
  }

  liftPose(out) {
    this.shelfPose(out);
    out.pos.y += 1.5;
    out.pos.z += 4;
    _q.setFromAxisAngle(_v.set(1, 0, 0), 7 * DEG);
    out.quat.premultiply(_q);
    out.scale *= 1.02;
    return out;
  }

  /** Where the open book sits for reading: fitted between the title row and the reader bar. */
  readFit() {
    const app = this.app;
    const d = this.d;
    const W = app.width;
    const H = app.height;
    const tanH = Math.tan((app.camera.fov * DEG) / 2);
    const zen = this.zen;
    const top = zen ? ZEN_MARGIN : app.ui.readTop();
    const bottom = zen ? H - ZEN_MARGIN : H - app.ui.readBottom();
    const availH = Math.max(100, bottom - top);
    const availW = zen ? Math.max(100, W - 2 * ZEN_MARGIN) : W * (W < 700 ? 0.97 : 0.94);
    const openW = 2 * (d.Wp + d.ov) + 0.3;
    const projH = d.Hc * Math.cos(READ_PITCH) + d.tp * 0.4 + 0.8;
    const need = Math.max(projH / ((2 * tanH * availH) / H), openW / ((2 * tanH * (W / H) * availW) / W));
    const base = app.cameraBase;
    const dMax = base.z - SHELF_Z + 3; // never behind the shelf's shadow wall
    const yPx = (top + bottom) / 2;
    const place = (n) => {
      const dist = Math.min(n, dMax);
      const scale = dist / n;
      const yOff = ((H / 2 - yPx) / H) * 2 * tanH * dist;
      return { pos: new THREE.Vector3(base.x, base.y + yOff, base.z - dist), scale, dist, openW: openW * scale, need: n };
    };
    let fit = place(need);
    if (zen) fit = this.fitZen(fit, place, availW, availH);
    return fit;
  }

  bookLocalBox() {
    if (this.localBox) return this.localBox;
    const box = new THREE.Box3();
    this.root.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const m = new THREE.Matrix4();
    this.model.group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      for (let p = o; p && p !== this.root; p = p.parent) if (!p.visible) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      m.multiplyMatrices(inv, o.matrixWorld);
      box.union(o.geometry.boundingBox.clone().applyMatrix4(m));
    });
    this.localBox = box;
    return box;
  }

  projectBook(fit) {
    const app = this.app;
    const d = this.d;
    const cam = new THREE.PerspectiveCamera(app.camera.fov, app.width / app.height, 1, 1200);
    cam.position.copy(app.cameraBase);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const q = new THREE.Quaternion().setFromEuler(_e.set(READ_PITCH, 0, 0, 'YXZ'));
    const s = fit.scale;
    const anchor = _v.set(0, 0, d.tp * 0.25).sub(d.center).multiplyScalar(s).applyQuaternion(q);
    const pos = _P.copy(fit.pos).sub(anchor);
    const box = this.bookLocalBox();
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < 8; i++) {
      _T.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      _T.multiplyScalar(s).applyQuaternion(q).add(pos).project(cam);
      const x = ((_T.x + 1) / 2) * app.width;
      const y = ((1 - _T.y) / 2) * app.height;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    return { left, right, top, bottom };
  }

  fitZen(fit, place, availW, availH) {
    const app = this.app;
    const tanH = Math.tan((app.camera.fov * DEG) / 2);
    for (let i = 0; i < 4; i++) {
      const b = this.projectBook(fit);
      const k = Math.max((b.right - b.left) / availW, (b.bottom - b.top) / availH);
      if (!Number.isFinite(k) || Math.abs(k - 1) < 0.001) break;
      fit = place(fit.need * k);
    }
    const wpp = (2 * tanH * fit.dist) / app.height;
    for (let i = 0; i < 2; i++) {
      const b = this.projectBook(fit);
      const dx = (app.width / 2 - (b.left + b.right) / 2) * wpp;
      const dy = ((b.top + b.bottom) / 2 - app.height / 2) * wpp;
      if (Math.abs(dx) < 0.002 && Math.abs(dy) < 0.002) break;
      fit.pos.x += dx;
      fit.pos.y += dy;
    }
    return fit;
  }

  computeGapWidth() {
    const fit = this.readFit();
    const app = this.app;
    const shelfDist = app.cameraBase.z - SHELF_Z;
    const apparent = (fit.openW * shelfDist) / fit.dist;
    return Math.max(0, apparent / 2 - (this.d.closedW * this.entry.slot.scale.x) / 2 + 1.2);
  }

  readPose(out) {
    const fit = this.readFit();
    const d = this.d;
    const z = this.zoom;
    // flatten the tilt when zoomed in so text is not foreshortened
    const pitch = lerp(READ_PITCH, -5 * DEG, smoothstep(1.02, 1.7, z)) + this.parallax.y * 5 * DEG;
    const yaw = this.parallax.x * 3 * DEG;
    out.quat.setFromEuler(_e.set(pitch, yaw, 0, 'YXZ'));
    out.scale = fit.scale;
    // anchor: the gutter, a little above the boards
    _v.set(0, 0, d.tp * 0.25).sub(d.center).multiplyScalar(fit.scale).applyQuaternion(out.quat);
    out.pos.copy(fit.pos).sub(_v);
    return out;
  }

  /**
   * Where things stand around the open book, for the reading lights: the table under it, its edges, room
   * beside it on screen, and the book's frame in the world (gutter, across, up the page, out of the page).
   */
  lightLayout() {
    const app = this.app;
    const d = this.d;
    const fit = this.readFit();
    const s = fit.scale;
    const lean = -READ_PITCH;
    const g = this.model.group;
    g.updateWorldMatrix(true, false);
    return {
      s,
      cx: fit.pos.x,
      edge: (d.Wp + d.ov) * s,
      span: (d.Wp + d.ov) * s,
      bottomY: fit.pos.y - (d.Hc / 2) * Math.cos(lean) * s,
      topY: fit.pos.y + (d.Hc / 2) * Math.cos(lean) * s,
      nearZ: fit.pos.z + (d.Hc / 2) * Math.sin(lean) * s, // the book's lower edge, nearest to us
      farZ: fit.pos.z - (d.Hc / 2) * Math.sin(lean) * s,
      camX: app.cameraBase.x,
      halfWAt: (z) => Math.tan((app.camera.fov * DEG) / 2) * (app.cameraBase.z - z) * (app.width / app.height),
      center: new THREE.Vector3(0, 0, d.tp * 0.5).applyMatrix4(g.matrixWorld),
      R: new THREE.Vector3(1, 0, 0).transformDirection(g.matrixWorld),
      U: new THREE.Vector3(0, 1, 0).transformDirection(g.matrixWorld),
      N: new THREE.Vector3(0, 0, 1).transformDirection(g.matrixWorld),
    };
  }

  applyPose(p) {
    this.root.position.copy(p.pos);
    this.root.quaternion.copy(p.quat);
    this.root.scale.setScalar(p.scale);
  }

  // =============================================================== frame
  update(dt, time) {
    if (!this.active) return false;
    this.tl += dt;
    let busy = false;
    const P = this.poses;
    const d = this.d;

    // parallax follows the mouse while reading
    const px = this.parallax;
    if (this.zen) {
      px.tx = 0;
      px.ty = 0;
    }
    px.x = smoothDamp(px.x, px.tx, px.vx, 0.35, dt);
    px.y = smoothDamp(px.y, px.ty, px.vy, 0.35, dt);

    let angle = 0;
    let openness = 1;
    if (this.phase === 'opening') {
      busy = true;
      const tl = this.tl;
      this.shelfPose(P.a);
      this.liftPose(P.b);
      this.readPose(P.c);
      blendPose(P.out, P.a, P.b, seg(tl, 0, OPEN.lift, easeOutCubic));
      blendPose(P.out, P.out, P.c, seg(tl, OPEN.travelAt, OPEN.travel, easeInOutCubic));
      this.applyPose(P.out);
      const c = seg(tl, OPEN.coverAt, OPEN.cover, easeInOutSine);
      angle = Math.PI * (1 - c);
      openness = c;
      this.app.shelf.openGap = seg(tl, OPEN.gapAt, OPEN.gap, easeInOutCubic);
      if (tl >= OPEN.fanAt && !this.fanStarted) {
        this.fanStarted = true;
        if (this.sTarget > 0) this.startFan(this.sTarget, time, true);
      }
      if (tl >= OPEN.fanAt + 0.1 && this.fanStarted && !this.fan) {
        this.phase = 'reading';
        this.app.ui.onOpened && this.app.ui.onOpened();
      }
    } else if (this.phase === 'closing') {
      busy = true;
      const tl = this.tl;
      const sw = seg(tl, 0, CLOSE.swing, easeInOutCubic);
      angle = lerp(this.closeFromAngle ?? 0, Math.PI, sw);
      openness = 1 - angle / Math.PI;
      this.liftPose(P.b);
      this.shelfPose(P.a);
      blendPose(P.out, P.from, P.b, seg(tl, CLOSE.travelAt, CLOSE.travel, easeInOutCubic));
      blendPose(P.out, P.out, P.a, seg(tl, CLOSE.settleAt, CLOSE.settle, easeOutCubic));
      this.applyPose(P.out);
      this.app.shelf.openGap = 1 - seg(tl, CLOSE.gapAt, CLOSE.gap, easeInOutCubic);
      if (tl >= CLOSE.done) {
        this.finishClose();
        return true;
      }
    } else {
      // reading
      this.readPose(P.c);
      const r = this.root;
      const k = 1 - Math.exp(-dt * 10);
      r.position.lerp(P.c.pos, k);
      r.quaternion.slerp(P.c.quat, k);
      r.scale.setScalar(lerp(r.scale.x, P.c.scale, k));
      if (r.position.distanceToSquared(P.c.pos) > 1e-6 || 1 - Math.abs(r.quaternion.dot(P.c.quat)) > 1e-7) busy = true;
    }

    // zoom & pan
    if (this.zen) {
      this.zoomTarget = 1;
      this.panTarget.set(0, 0);
    }
    const z0 = this.zoom;
    this.zoom = smoothDamp(this.zoom, this.zoomTarget, this.zoomV, 0.16, dt);
    this.pan.x = smoothDamp(this.pan.x, this.panTarget.x, this.panVX, 0.14, dt);
    this.pan.y = smoothDamp(this.pan.y, this.panTarget.y, this.panVY, 0.14, dt);
    if (Math.abs(this.zoom - z0) > 1e-5 || Math.abs(this.pan.x - this.panTarget.x) > 1e-4 || Math.abs(this.pan.y - this.panTarget.y) > 1e-4) {
      busy = true;
      this.zoomSettleAt = time + 0.3;
    }
    if (this.zoomSettleAt && time > this.zoomSettleAt) {
      this.zoomSettleAt = 0;
      this.onZoomSettled();
    }

    // leaves in flight
    if (this.updateFlights(dt, time)) busy = true;
    if (this.updateHover(dt)) busy = true;

    // stacks
    const leftCount = this.leftCount(time);
    const hL = (d.tp * leftCount) / d.leaves;
    if (this.phase === 'reading') {
      angle = 0;
      openness = 1;
    }
    this.model.set(angle, hL, openness);
    this.tabR = this.cachedTable('R', this.model.hR, openness);
    this.tabL = this.cachedTable('L', hL, openness);

    this.syncLeaves(time);
    const env = { Wp: d.Wp, Hp: d.Hp, tabR: this.tabR, tabL: this.tabL };
    for (const leaf of this.leafOf.values()) leaf.deform(env);
    if (this.updateMarkers(dt, leftCount)) busy = true;
    // ink drawn since the last frame: just the changed pixels, onto the GPU in place
    if (this.ink) this.ink.flush(this.uploadRect);
    return busy;
  }

  /**
   * Put one rectangle of an ink layer's canvas onto its texture on the GPU (texSubImage2D), instead of sending
   * the whole page again. Returns false when the texture isn't on the GPU yet (three then uploads all of it).
   */
  uploadRect = (tex, canvas, r) => {
    const renderer = this.app.renderer;
    const props = renderer.properties.get(tex);
    const glTex = props.__webglTexture;
    if (!glTex || props.__version !== tex.version) return false;
    try {
      const gl = renderer.getContext();
      const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.w, r.h);
      renderer.state.bindTexture(gl.TEXTURE_2D, glTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, tex.flipY);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, tex.premultiplyAlpha);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      // three flipped the canvas on its way up: count rows from the bottom
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, tex.flipY ? canvas.height - r.y - r.h : r.y, gl.RGBA, gl.UNSIGNED_BYTE, img);
      if (tex.generateMipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      return true;
    } catch {
      return false;
    }
  };


  // =============================================================== flags
  initMarkers() {
    this.flagMeshes = new Map();
    this.flags = [];
    this.syncFlags();
    this.syncFinger();
  }

  disposeMarkers() {
    for (const m of this.flagMeshes.values()) if (m.parent) m.parent.remove(m);
    this.flagMeshes.clear();
    this.flags = [];
    this.finger = null;
    this.app.ui.setFinger(null);
  }

  /** The flags follow the book's bookmarks. */
  syncFlags() {
    const flags = flagsOf(this.meta);
    const keep = new Set(flags.map((f) => f.key + f.tone));
    for (const [key, m] of this.flagMeshes)
      if (!keep.has(key + m.userData.flag.tone)) {
        if (m.parent) m.parent.remove(m);
        this.flagMeshes.delete(key);
      }
    for (const f of flags) {
      let m = this.flagMeshes.get(f.key);
      if (!m) {
        m = makeFlagMesh(f);
        m.visible = false;
        this.flagMeshes.set(f.key, m);
      }
      m.userData.flag = f;
    }
    this.flags = flags;
    this.app.invalidate();
  }

  /** Where a flag stands on a leaf that is a sheet of its own (resting on top of a stack, or turning). */
  leafFlagFrame(leaf, f) {
    const P = leaf.pos;
    const i = clamp(Math.round(f.u * NX), 1, NX - 1);
    const top = NY * (NX + 1);
    const below = (NY - 1) * (NX + 1);
    const at = (k, out) => out.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
    at(top + i, _P);
    at(top + i + 1, _T);
    at(top + i - 1, _w);
    _T.sub(_w).normalize();
    at(below + i, _w);
    _U.copy(_P).sub(_w).normalize();
    _N.crossVectors(_T, _U).normalize();
  }

  /**
   * Every frame: each flag rides its leaf — on a sheet that is turning, or at its depth in a stack. During a fan
   * the flagged leaves fly (see startFan); a flag on a leaf passed over without flying waits until it lands.
   */
  updateMarkers(dt, c) {
    let busy = false;
    const d = this.d;
    const N = d.leaves;
    const o = this.model.openness;
    const peek = this.app.peek && this.app.peek.where === 'reader' ? this.app.peek.flag.key : null;
    const fan = this.fan;
    const lo = fan ? Math.min(fan.s0, fan.s1) : 0;
    const hi = fan ? Math.max(fan.s0, fan.s1) : 0;
    const flying = fan ? new Set(fan.leaves.map((l) => l.k)) : null;
    for (const f of this.flags) {
      const mesh = this.flagMeshes.get(f.key);
      const ud = mesh.userData;
      const want = f.key === peek ? FLAG.LIFT : 0;
      if (Math.abs(ud.lift - want) > 0.002 && dt > 0) {
        ud.lift += (want - ud.lift) * (1 - Math.exp(-dt * 16));
        busy = true;
      } else ud.lift = want;
      const leaf = this.leafOf.get(f.k);
      let parent;
      if (leaf) {
        parent = leaf.mesh;
        this.leafFlagFrame(leaf, f);
      } else {
        if (fan && f.k >= lo && f.k < hi && !flying.has(f.k)) {
          mesh.visible = false;
          continue;
        }
        const x = f.u * d.Wp;
        // (kept a little under the stack's top, so the part stuck to its page never shows through the leaf above)
        if (f.k < c) {
          const L = layerAt(this.model.hL, o, d.Wp, clamp((f.k + 0.5) / Math.max(c, 0.5), 0, 1), x);
          const top = layerAt(this.model.hL, o, d.Wp, 1, x).z;
          _P.set(-x, d.Hp / 2, Math.min(L.z, top - 0.05));
          _T.set(-1, 0, L.dz).normalize();
          parent = this.model.leftContent;
        } else {
          const L = layerAt(this.model.hR, o, d.Wp, clamp((N - f.k - 0.5) / Math.max(N - c, 0.5), 0, 1), x);
          const top = layerAt(this.model.hR, o, d.Wp, 1, x).z;
          _P.set(x, d.Hp / 2, Math.min(L.z, top - 0.05));
          _T.set(1, 0, L.dz).normalize();
          parent = this.model.group;
        }
        _U.set(0, 1, 0);
        _N.crossVectors(_T, _U).normalize();
      }
      if (mesh.parent !== parent) parent.add(mesh);
      mesh.visible = true;
      flagMatrix(mesh.matrix, _P, _T, _U, _N, ud.lift, f.front ? 1 : -1);
      mesh.matrixWorldNeedsUpdate = true;
    }
    return busy;
  }

  /** A flag under a tap (never over a page: a tap on a page stays a tap on the page). */
  pickFlag(x, y) {
    if (!this.flags.length || this.phase !== 'reading' || this.fan) return null;
    if (this.hitPage(x, y)) return null;
    const hit = pickBox(this.flagItems(), x, y, this.app.isTouch ? 10 : 4);
    return hit ? hit.flag : null;
  }

  flagItems() {
    const items = [];
    for (const f of this.flags) {
      const m = this.flagMeshes.get(f.key);
      if (!m.visible || !m.parent) continue;
      m.updateWorldMatrix(true, false);
      items.push({ flag: f, box: flagScreenBox(m.matrixWorld, this.app.camera, this.app.width, this.app.height) });
    }
    return items;
  }

  /** A flag's place on screen (for its label). */
  flagBox(key) {
    const m = this.flagMeshes && this.flagMeshes.get(key);
    if (!m || !m.visible || !m.parent) return null;
    m.updateWorldMatrix(true, false);
    return flagScreenBox(m.matrixWorld, this.app.camera, this.app.width, this.app.height);
  }

  /** A leaf turned by hand: with "books wear as you read them", it is remembered (see App.noteTurn). */
  noteTurn(k) {
    if (!this.app.livingWear) return;
    this.app.noteTurn(this.meta, k);
    const leaf = this.leafOf.get(k);
    if (leaf) leaf.material.userData.u.soil.value = this.soilFor(k);
  }

  // =============================================================== keeping your place
  /** Go somewhere on purpose (a flag, the contents, a page number): where you were reading is kept, to go back to. */
  jumpTo(s) {
    if (!this.canTurn()) return;
    this.finishFlights(true);
    s = clamp(s, 0, this.d.leaves);
    if (s === this.s) return;
    if (this.finger && this.finger.s === s) return this.returnToFinger();
    if (!this.finger && this.s > 0) this.finger = { s: this.s };
    this.jumpLanded = s;
    this.syncFinger();
    this.goToSpread(s);
  }

  /** Back to where you were reading. */
  returnToFinger() {
    const f = this.finger;
    if (!f || !this.canTurn()) return;
    this.finger = null;
    this.jumpLanded = null;
    this.syncFinger();
    this.goToSpread(f.s);
  }

  syncFinger() {
    this.app.ui.setFinger(this.finger ? Math.max(1, 2 * this.finger.s) : null);
    this.app.invalidate();
  }

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
      if (st.curl) {
        Object.assign(leaf.curl, st.curl);
        leaf.bend = st.bend || 0;
      } else if (st.rest) {
        const h = this.hover;
        const hoverSide = st.rest === 'R' ? 1 : -1;
        if (this.app.cornerPeel && h.side === hoverSide && h.amount > 0) {
          peelCurl(leaf.curl, this.d, h.su, h.sv, grabTilt(h.sv), PEEL.lift * PEEL.hover * h.amount, spineSoft(h.su));
          leaf.curl.cone = 0;
        } else {
          leaf.curl.amount = h.side === hoverSide ? h.amount : 0;
          leaf.curl.angle = h.angle;
          leaf.curl.pivotU = 0.8;
          leaf.curl.pivotV = 0.5;
          leaf.curl.span = 32.4;
          leaf.curl.cone = 0;
        }
        leaf.bend = 0;
      } else {
        leaf.curl.amount = 0;
        leaf.curl.cone = 0;
        leaf.bend = 0;
      }
    }
  }

  assignLeafTextures(leaf, fanTex) {
    const k = leaf.k;
    const n = this.d.pages;
    const front = 2 * k + 1;
    const back = 2 * k + 2;
    const tf = front <= n ? this.pageTexture(front, fanTex) : this.blankPaper;
    const tb = back <= n ? this.pageTexture(back, fanTex) : this.blankPaper;
    leaf.setPages(tf, tb, front <= n ? this.ink.texture(front) : null, back <= n ? this.ink.texture(back) : null);
    leaf.material.userData.u.soil.value = this.soilFor(k);
  }

  // =============================================================== paper
  /** The book's paper (its own, or the library's) on the leaves; again whenever it changes. */
  applyPaper() {
    if (!this.meta) return;
    const r = this.app.paperFor(this.meta);
    this.paperRes = r;
    this.flex = r.flex;
    this.app.shared.paper.use(r.type); // the type's own fibres, formation and surface
    applyPaper(this.app.shared.paper.u, this.pool, r, this.d.Wp, this.d.Hp);
    if (this.entry) this.app.shelf.syncPaper(this.entry, r); // the page block's colour and edges too
    for (const leaf of this.leafOf.values()) {
      leaf.material.roughness = r.roughness;
      leaf.material.userData.u.soil.value = this.soilFor(leaf.k);
    }
    this.app.invalidate();
  }

  /** Finger soil on a leaf: the book's wear, or (when books wear as you read) more on the leaves you turned. */
  soilFor(k) {
    const r = this.paperRes;
    if (!r) return 0;
    const manual = r.settings.wear;
    if (!this.app.livingWear) return manual;
    return this.app.handled(this.meta, k) ? Math.max(manual, 0.25 + 0.75 * this.app.livedWear(this.meta)) : manual;
  }

  /**
   * A scan shows its own paper: measure it on the first few pages (the margins' colour, not the ink or a dark
   * scanner border) so the paper isn't tinted and toned twice. Stored with the book; white pages count too.
   */
  sampleScanTone(canvas, n) {
    if (this.meta.pageTone || n < 3 || !this.scanSamples || this.scanSamples.length >= 3) return;
    try {
      const t = marginTone(canvas);
      if (t) this.scanSamples.push(t);
    } catch {
      return;
    }
    if (this.scanSamples.length < 3) return;
    this.meta.pageTone = toneOf(this.scanSamples);
    store.putBook(this.meta).catch(() => {});
    this.applyPaper();
  }

  refreshLeafTexturesFor(page) {
    const k = Math.floor((page - 1) / 2);
    const leaf = this.leafOf.get(k);
    if (leaf) this.assignLeafTextures(leaf, leaf._fanTex);
  }

  refreshAllLeafTextures() {
    if (!this.active) return;
    for (const leaf of this.leafOf.values()) this.assignLeafTextures(leaf, leaf._fanTex);
    this.app.invalidate();
  }

  onInkChanged(page) {
    this.refreshLeafTexturesFor(page);
    this.app.invalidate();
  }

  // =============================================================== page textures
  computeTexHeight() {
    const app = this.app;
    const isTouch = app.isTouch;
    const max = Math.min(app.renderer.capabilities.maxTextureSize, isTouch ? 3072 : 4096);
    const base = app.height * app.renderer.getPixelRatio() * 0.84;
    this.texH = Math.round(clamp(base * 1.1, 900, max));
    this.texMax = max;
  }

  pageTexture(n, fanTex) {
    const rec = this.pages.get(n);
    if (rec && rec.tex) return rec.tex;
    if (fanTex) return fanTex;
    this.requestPage(n, 3);
    return this.placeholder;
  }

  requestPage(n, priority = 2, height = this.texH) {
    if (!this.doc || n < 1 || n > this.d.pages) return;
    let rec = this.pages.get(n);
    if (!rec) {
      rec = { tex: null, h: 0, pending: 0 };
      this.pages.set(n, rec);
    }
    if (rec.h >= height * 0.92 || rec.pending >= height * 0.92) return;
    rec.pending = height;
    const doc = this.doc;
    const aspect = this.d.Wp / this.d.Hp;
    const id = this.meta.id;
    renderQueue
      .push({
        key: `${id}:${n}:${height}`,
        priority,
        run: async () => {
          if (this.doc !== doc) throw new Error('stale');
          return renderPageToCanvas(doc, n, Math.round(height * aspect), height);
        },
      })
      .then((canvas) => {
        if (this.doc !== doc) return;
        this.sampleScanTone(canvas, n);
        const tex = canvasTexture(canvas, { aniso: this.app.maxAniso });
        tex.onUpdate = () => {
          // the pixels live on the GPU now — free the canvas memory (matters on iPad)
          canvas.width = 1;
          canvas.height = 1;
          tex.onUpdate = null;
        };
        if (rec.tex) rec.tex.dispose();
        rec.tex = tex;
        rec.h = height;
        rec.pending = 0;
        this.refreshLeafTexturesFor(n);
        this.evictPages();
        this.app.invalidate();
      })
      .catch(() => {
        rec.pending = 0;
      });
  }

  prefetchSpread(s, priority = 1) {
    const l = 2 * s;
    const r = 2 * s + 1;
    this.requestPage(r, priority);
    this.requestPage(l, priority);
    // neighbours (what the next turn reveals)
    this.requestPage(r + 2, priority + 2);
    this.requestPage(r + 1, priority + 2);
    this.requestPage(l - 1, priority + 3);
    this.requestPage(l - 2, priority + 3);
  }

  evictPages() {
    // ink layers (two page-sized canvases each) only for the pages on the leaves in use
    if (this.ink) {
      const keep = new Set();
      for (const k of this.leafOf.keys()) keep.add(2 * k + 1).add(2 * k + 2);
      this.ink.evict(keep);
    }
    if (this.pages.size <= 18) return;
    const lo = 2 * this.s - 6;
    const hi = 2 * this.s + 7;
    for (const [n, rec] of this.pages) {
      if ((n < lo || n > hi) && rec.tex) {
        let inUse = false;
        const k = Math.floor((n - 1) / 2);
        if (this.leafOf.has(k)) inUse = true;
        if (!inUse) {
          rec.tex.dispose();
          this.pages.delete(n);
        }
      }
    }
  }

  onZoomSettled() {
    if (!this.doc) return;
    const want = Math.round(clamp(this.texH * Math.max(1, this.zoom * 0.95), 0, this.texMax));
    if (want > this.texH * 1.1) {
      const l = 2 * this.s;
      this.requestPage(l, 0, want);
      this.requestPage(l + 1, 0, want);
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
      dur: TURN_DUR * (1 + 0.1 * (this.flex - 1)), // a supple leaf floats down a little longer
      curl: { amount: 0, power: 0.86, span: 32.4, angle: -0.3, pivotU: 0.6, pivotV: 0.5, cone: 0 },
      bend: 0,
      tv: { v: 0 },
    };
  }

  goToPage(page) {
    if (!this.active) return;
    this.jumpTo(clamp(Math.floor(page / 2), 0, this.d.leaves));
  }

  goToSpread(s) {
    if (!this.canTurn()) return;
    s = clamp(s, 0, this.d.leaves);
    if (s === this.s && !this.flights.length) return;
    this.finishFlights(true);
    if (Math.abs(s - this.s) === 1) {
      if (s > this.s) this.next();
      else this.prev();
      return;
    }
    this.startFan(s, this.app.clock);
  }

  startFan(s1, time, opening = false) {
    const s0 = this.s;
    if (s1 === s0) return;
    const count = Math.abs(s1 - s0);
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
    if (g && g.mode === 'catch' && this.app.clock - g.clock0 >= CATCH.hold) this.grabCaught(g);
    const physical = this.app.freeLeaf;
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
        fl.t = smoothDamp(fl.t, fl.goal, fl.tv, 0.14, dts);
        fl.curl.amount *= Math.exp(-dts * 7);
        fl.bend = clamp(-fl.tv.v * 0.25, -0.9, 0.9) * Math.sin(Math.PI * fl.t);
        fl.done = Math.abs(fl.t - fl.goal) < 0.0015 && fl.curl.amount < 0.02;
        if (fl.done) fl.t = fl.goal;
      }
      if (physical) {
        this.tipStep(fl, dt, held);
        fl.bend = fl.tip.b;
        if (fl.done) {
          // landed: wait (briefly) for the edge to come to rest on the stack
          fl.tip.over = (fl.tip.over || 0) + dt;
          fl.done = (Math.abs(fl.tip.b) < 0.01 && Math.abs(fl.tip.bv) < 0.3) || fl.tip.over > 0.35;
          if (!fl.done) busy = true;
        }
      } else if (fl.tip) fl.tip = null;
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
    const flex = this.flex;
    const w0 = TIP.w0 / Math.sqrt(flex);
    const K = w0 * w0;
    const C = 2 * TIP.zeta * w0;
    const fk = Math.pow(flex, 0.8);
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    // the air and inertia push it toward this (a sudden start doesn't fold it in two)
    const push = TIP.most * fk * Math.tanh((TIP.inertia * T.al + TIP.drag * w) / TIP.most);
    for (let i = 0; i < n; i++) {
      const acc = -K * T.b - C * T.bv - K * push - K * TIP.grav * flex * Math.cos(a);
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

  onSpreadChanged() {
    if (this.finger && !this.fan) {
      if (this.s === this.finger.s) {
        // back where you were (page by page)
        this.finger = null;
        this.jumpLanded = null;
        this.syncFinger();
      } else if (this.jumpLanded != null && Math.abs(this.s - this.jumpLanded) >= 3) {
        // reading on from where you went: this is your place now
        this.finger = null;
        this.jumpLanded = null;
        this.syncFinger();
        this.app.ui.toast('Reading on from here', 1800);
      }
    }
    this.prefetchSpread(this.s, 1);
    this.evictPages();
    this.updateBar();
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveSpread(), 600);
  }

  saveSpread() {
    if (!this.meta || !this.active) return;
    // your place is where you were reading: a look elsewhere doesn't move it
    this.meta.spread = this.finger ? this.finger.s : this.s;
    this.meta.openedAt = Date.now();
    store.putBook(this.meta).catch(() => {});
  }

  // =============================================================== hover curl (mouse)
  updateHover(dt) {
    const h = this.hover;
    const prev = h.amount;
    h.amount = smoothDamp(h.amount, h.target, h.v, 0.12, dt);
    // (the peel follows the pointer a little behind it)
    const k = 1 - Math.exp(-dt * 14);
    const du = (h.gu - h.su) * k;
    const dv = (h.gv - h.sv) * k;
    h.su += du;
    h.sv += dv;
    if (h.amount < 0.002 && h.target === 0) {
      h.amount = 0;
      h.side = 0;
    }
    return Math.abs(h.amount - prev) > 1e-4 || (this.app.cornerPeel && h.amount > 0 && Math.abs(du) + Math.abs(dv) > 1e-4);
  }

  // =============================================================== geometry queries
  ndc(x, y) {
    return new THREE.Vector2((x / this.app.width) * 2 - 1, -(y / this.app.height) * 2 + 1);
  }

  /** Pointer → point on the book's base plane (book frame). */
  bookPoint(x, y) {
    this.raycaster.setFromCamera(this.ndc(x, y), this.app.camera);
    const g = this.model.group;
    g.updateWorldMatrix(true, false);
    _m.copy(g.matrixWorld).invert();
    const o = this.raycaster.ray.origin.clone().applyMatrix4(_m);
    const dir = this.raycaster.ray.direction.clone().transformDirection(_m);
    const zPlane = this.d.tp * 0.3;
    if (Math.abs(dir.z) < 1e-6) return null;
    const t = (zPlane - o.z) / dir.z;
    return o.add(dir.multiplyScalar(t));
  }

  /** Pointer → page under it (only leaves at rest). */
  hitPage(x, y) {
    if (!this.active) return null;
    this.raycaster.setFromCamera(this.ndc(x, y), this.app.camera);
    const meshes = [];
    for (const leaf of this.leafOf.values()) if (leaf.t === 0 || leaf.t === 1) meshes.push(leaf.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const leaf = hit.object.userData.leaf;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const front = n.dot(this.raycaster.ray.direction) < 0;
    const page = front ? 2 * leaf.k + 1 : 2 * leaf.k + 2;
    if (page > this.d.pages) return null;
    return { leaf, page, front, u: front ? hit.uv.x : 1 - hit.uv.x, v: 1 - hit.uv.y, uvx: hit.uv.x, uvy: hit.uv.y };
  }

  hitBook(x, y) {
    if (!this.active) return false;
    const b = this.projectBook(this.readFit());
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  }

  // =============================================================== input
  pointerDown(e) {
    if (!this.active) return;
    const ts = e.timeStamp || performance.now();
    // palm rejection: while the Pencil writes (and a moment after), a resting hand is not a gesture
    if (e.pointerType === 'touch' && this.tool && this.app.penSeen && ((this.drawing && this.drawing.pen) || ts - this.penUpAt < 600)) return;
    if (e.pointerType === 'pen' && this.tool && this.phase === 'reading') {
      // the hand came down first: forget it rather than read hand + pencil as a pinch
      for (const [id, q] of this.pointers) if (q.type === 'touch') this.pointers.delete(id);
      if (this.gesture && this.gesture.mode === 'turn') this.releaseDrag(true);
      this.gesture = null;
    }
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: ts, type: e.pointerType, lx: e.clientX, ly: e.clientY, lt: ts, vx: 0, vy: 0 };
    this.pointers.set(e.pointerId, p);
    if (e.pointerType === 'pen') this.app.penSeen = true;
    if (this.phase !== 'reading') return;

    if (this.pointers.size === 2) {
      // pinch: abandon whatever the first finger started
      if (this.gesture && this.gesture.mode === 'catch') this.brakeAll(false);
      if (this.drawing) {
        this.ink.cancel();
        this.drawing = null;
      }
      this.releaseDrag(true);
      const [a, b] = [...this.pointers.values()];
      this.app.clearPeek();
      this.gesture = {
        mode: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        z0: this.zoomTarget,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        pan0: this.panTarget.clone(),
      };
      return;
    }
    if (this.pointers.size > 2) return;

    const drawing = this.tool && (e.pointerType !== 'touch' || !this.app.penSeen);
    if (drawing) {
      const hit = this.hitPage(e.clientX, e.clientY);
      if (hit) {
        const pen = e.pointerType === 'pen';
        if (this.tool === 'eraser') {
          this.ink.eraseAt(hit.page, hit.u, hit.v);
          this.drawing = { mode: 'erase', leaf: hit.leaf, front: hit.front, pen, id: e.pointerId };
        } else {
          this.ink.begin(hit.page, this.tool, hit.u, hit.v, penPressure(e), penTilt(e));
          this.drawing = { mode: 'ink', leaf: hit.leaf, front: hit.front, page: hit.page, pen, id: e.pointerId };
        }
        this.app.ui.closePopovers();
        this.app.invalidate();
        return;
      }
    }

    const zoomed = this.zoomTarget > 1.05;
    if (this.app.catchLeaf && this.flights.length && !zoomed && !this.fan) {
      const fl = this.hitFlight(e.clientX, e.clientY);
      if (fl) {
        // a leaf in the air under your finger: everything in the air brakes
        this.brakeAll(true);
        this.gesture = { mode: 'catch', fl, id: e.pointerId, clock0: this.app.clock };
        this.app.invalidate();
        return;
      }
    }
    const hit = this.hitPage(e.clientX, e.clientY);
    if (hit && hit.uvx > 0.78 && !zoomed && !this.fan) {
      // grabbed near the fore-edge: lift the leaf right away
      const dir = hit.front ? +1 : -1;
      if (this.startDrag(dir, e.clientX, e.clientY)) {
        this.gesture = { mode: 'turn' };
        return;
      }
    }
    this.gesture = { mode: 'pending', hit, zoomed };
  }

  pointerMove(e) {
    if (!this.active) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      // hover (mouse)
      if (e.pointerType === 'mouse' && this.phase === 'reading') this.mouseHover(e.clientX, e.clientY);
      return;
    }
    const now = e.timeStamp || performance.now();
    const dtm = Math.max(1, now - p.lt);
    p.vx = lerp(p.vx, ((e.clientX - p.lx) / dtm) * 1000, 0.5);
    p.vy = lerp(p.vy, ((e.clientY - p.ly) / dtm) * 1000, 0.5);
    p.lx = p.x = e.clientX;
    p.ly = p.y = e.clientY;
    p.lt = now;
    const g = this.gesture;

    if (g && g.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const z1 = clamp((g.z0 * dist) / g.d0, 0.85, 4);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.zoomAround(g.mx, g.my, g.z0, z1, g.pan0);
      // two-finger drag pans too
      const wpp = this.worldPerPx(z1);
      this.panTarget.x -= (mx - g.mx) * wpp;
      this.panTarget.y += (my - g.my) * wpp;
      this.clampPan();
      this.app.invalidate();
      return;
    }
    if (this.drawing) {
      if (e.pointerId !== this.drawing.id) return;
      // the Pencil reports at 240 Hz; take every sample the browser coalesced into this event
      const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      for (const ev of evs.length ? evs : [e]) {
        const hit = this.hitPage(ev.clientX, ev.clientY);
        if (!hit || hit.leaf !== this.drawing.leaf || hit.front !== this.drawing.front) continue;
        if (this.drawing.mode === 'erase') this.ink.eraseAt(hit.page, hit.u, hit.v);
        else if (hit.page === this.drawing.page) this.ink.extend(hit.u, hit.v, penPressure(ev), penTilt(ev));
      }
      // draw a little ahead, to where the Pencil is predicted to be next (where the browser says)
      if (this.drawing.mode === 'ink' && e.getPredictedEvents) {
        const pred = [];
        for (const ev of e.getPredictedEvents().slice(0, 3)) {
          const hit = this.hitPage(ev.clientX, ev.clientY);
          if (hit && hit.leaf === this.drawing.leaf && hit.front === this.drawing.front && hit.page === this.drawing.page) pred.push(hit.u, hit.v);
        }
        this.ink.predict(pred);
      }
      this.app.invalidate();
      return;
    }
    if (!g) return;
    if (g.mode === 'catch' && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 8) this.grabCaught(g);
    if (g.mode === 'turn') {
      this.updateDrag(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    if (g.mode === 'pending' && Math.hypot(dx, dy) > 8) {
      if (g.zoomed) {
        g.mode = 'pan';
        g.pan0 = this.panTarget.clone();
      } else if (Math.abs(dx) > Math.abs(dy) * 0.8 && !this.fan) {
        const dir = dx < 0 ? +1 : -1;
        if (this.startDrag(dir, p.x0, p.y0, true)) {
          g.mode = 'turn';
          this.updateDrag(e.clientX, e.clientY);
        } else if (this.flights.length) {
          g.mode = (dir > 0 ? this.next() : this.prev()) ? 'queued' : 'none';
        } else g.mode = 'none';
      } else g.mode = 'none';
    }
    if (g.mode === 'pan') {
      const wpp = this.worldPerPx(this.zoomTarget);
      this.panTarget.x = g.pan0.x - dx * wpp;
      this.panTarget.y = g.pan0.y + dy * wpp;
      this.clampPan();
      this.app.invalidate();
    }
  }

  pointerUp(e) {
    if (!this.active) return;
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!p) return;
    const g = this.gesture;
    if (this.drawing) {
      if (e.pointerId !== this.drawing.id) return;
      if (this.drawing.pen) this.penUpAt = e.timeStamp || performance.now();
      if (this.drawing.mode === 'ink') this.ink.end();
      this.drawing = null;
      this.updateBar();
      this.app.invalidate();
      if (!this.pointers.size) this.gesture = null;
      return;
    }
    if (g && g.mode === 'pinch') {
      if (this.pointers.size < 2) this.gesture = this.pointers.size ? { mode: 'none' } : null;
      return;
    }
    if (g && g.mode === 'catch') {
      // let go before it was taken: they fly on, and a quick tap still does what a tap does
      this.brakeAll(false);
      this.gesture = null;
      if (e.type !== 'pointercancel' && (e.timeStamp || performance.now()) - p.t0 < this.app.tapMs) this.tap(p.x0, p.y0, p.type);
      this.app.invalidate();
      return;
    }
    if (g && g.mode === 'turn') {
      const moved = Math.hypot(p.x - p.x0, p.y - p.y0);
      const fl = this.flights.find((f) => f.mode === 'drag');
      if (fl && !fl.caught && moved < 10 && (e.timeStamp || performance.now()) - p.t0 < this.app.tapMs && e.type !== 'pointercancel') {
        // a tap on the fore-edge: turn the page the ordinary way (from where the peel had lifted it)
        this.flights.splice(this.flights.indexOf(fl), 1);
        const turned = fl.dir > 0 ? this.next() : this.prev();
        if (turned && fl.peel) this.flights[this.flights.length - 1].from = { ...fl.curl };
      } else this.releaseDrag(false, p.vx);
      this.gesture = null;
      return;
    }
    if (g && g.mode === 'pending' && e.type !== 'pointercancel') {
      const quick = (e.timeStamp || performance.now()) - p.t0 < this.app.tapMs;
      if (quick) this.tap(p.x0, p.y0, p.type);
    }
    if (!this.pointers.size) this.gesture = null;
  }

  tap(x, y, type) {
    // a flag first (its first tap only raises it, see App.flagTap)
    const fl = this.pickFlag(x, y);
    if (fl) {
      this.app.flagTap({ entry: this.entry, flag: fl }, 'reader');
      return;
    }
    this.app.clearPeek();
    const W = this.app.width;
    const now = performance.now();
    const dbl = !this.flights.length && now - this.lastTap.t < this.app.tapMs * 0.75 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 40;
    this.lastTap = { t: now, x, y };
    const zone = x / W;
    const zoomed = this.zoomTarget > 1.05;
    if (dbl && (type === 'mouse' || (zone > 0.3 && zone < 0.7) || zoomed)) {
      this.lastTap.t = 0;
      this.toggleZoomAt(x, y);
      return;
    }
    if (type === 'mouse') {
      // click a page: right page → forward, left page → back
      const hit = this.hitPage(x, y);
      if (hit) {
        if (hit.front) this.next();
        else this.prev();
      }
      return;
    }
    const edge = zoomed ? 0.1 : 0.4;
    if (zone > 1 - edge) this.next();
    else if (zone < edge) this.prev();
  }

  mouseHover(x, y) {
    const W = this.app.width;
    const H = this.app.height;
    this.parallax.tx = clamp((x / W) * 2 - 1, -1, 1);
    this.parallax.ty = clamp((y / H) * 2 - 1, -1, 1);
    const h = this.hover;
    if (this.pickFlag(x, y)) {
      h.target = 0;
      this.app.canvas.style.cursor = 'pointer';
      this.app.invalidate();
      return;
    }
    if (this.tool || this.flights.length || this.fan || this.zoomTarget > 1.05) {
      h.target = 0;
    } else {
      const hit = this.hitPage(x, y);
      if (hit && hit.uvx > 0.84) {
        const side = hit.front ? 1 : -1;
        if (h.side !== side || h.amount === 0) {
          h.su = hit.uvx;
          h.sv = hit.uvy - 0.5;
        }
        h.side = side;
        h.target = this.app.cornerPeel ? 1 : 1.5;
        h.angle = clamp((hit.uvy - 0.5) * 1.1, -0.5, 0.5);
        h.gu = hit.uvx;
        h.gv = hit.uvy - 0.5;
      } else h.target = 0;
    }
    this.app.canvas.style.cursor = this.tool ? 'crosshair' : h.target > 0 ? 'grab' : 'default';
    this.app.invalidate();
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
    const pivotY = 0;
    const angle = clamp(Math.atan2(grabY - pivotY, Wp * 0.4) * 0.9, -0.55, 0.55);
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
      curl: { amount: 0, power: 0.86, span: 32.4, angle, pivotU: 0.74, pivotV: 0.5, cone: 0 },
      bend: 0,
    };
    if (this.app.cornerPeel) {
      // where it was taken: gu from the gutter out, gv up from the middle; pressed at the edge, it lifts at once
      const gu = clamp((dir > 0 ? bp.x : -bp.x) / Wp, 0, 1);
      // (a mouse's hover had already lifted it a little)
      const h = this.hover;
      const press = h.side === dir && !fromSwipe ? PEEL.hover * h.amount : 0;
      fl.peel = { gu, gv: grabY / this.d.Hp, gx: bp.x, gy: bp.y, dx: 0, dy: 0, ang: 0, press, pv: { v: 0 }, hold: !fromSwipe };
      // the point you hold stays under your finger (a swipe takes the edge, as before)
      fl.reachR = fromSwipe ? Wp * 0.98 : Math.max(0.6, gu) * Wp * 0.98;
      this.peelFlight(fl, 0);
    }
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

  wheel(e) {
    if (!this.active || this.phase !== 'reading') return;
    if (e.ctrlKey || e.metaKey) {
      const z1 = clamp(this.zoomTarget * Math.exp(-e.deltaY * 0.01), 0.85, 4);
      this.zoomAround(e.clientX, e.clientY, this.zoomTarget, z1, this.panTarget.clone());
      this.app.invalidate();
      return;
    }
    if (this.zoomTarget > 1.05) {
      const wpp = this.worldPerPx(this.zoomTarget);
      this.panTarget.x += e.deltaX * wpp;
      this.panTarget.y -= e.deltaY * wpp;
      this.clampPan();
      this.app.invalidate();
      return;
    }
    const now = performance.now();
    this.wheelAcc = (this.wheelAcc || 0) + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    clearTimeout(this.wheelReset);
    this.wheelReset = setTimeout(() => (this.wheelAcc = 0), 200);
    if (now - (this.wheelLast || 0) < 380) return;
    if (this.wheelAcc > 50) {
      this.wheelAcc = 0;
      this.wheelLast = now;
      this.next();
    } else if (this.wheelAcc < -50) {
      this.wheelAcc = 0;
      this.wheelLast = now;
      this.prev();
    }
  }

  // =============================================================== zoom helpers
  worldPerPx(zoom = this.zoom) {
    const app = this.app;
    const dist = app.cameraBase.z - this.root.position.z;
    return (2 * Math.tan((app.camera.fov * DEG) / 2) * dist) / (app.height * zoom);
  }

  zoomAround(sx, sy, z0, z1, pan0) {
    const ax = sx - this.app.width / 2;
    const ay = sy - this.app.height / 2;
    const w0 = this.worldPerPx(z0);
    const w1 = this.worldPerPx(z1);
    this.zoomTarget = z1;
    this.panTarget.set(pan0.x + ax * (w0 - w1), pan0.y - ay * (w0 - w1));
    if (z1 <= 1.001) this.panTarget.set(0, 0);
    this.clampPan();
  }

  clampPan() {
    const d = this.d;
    const s = this.root.scale.x;
    const z = this.zoomTarget;
    const limX = (d.Wp + d.ov) * s * Math.max(0, 1 - 0.6 / z) + 0.5;
    const limY = (d.Hc / 2) * s * Math.max(0, 1 - 0.75 / z) + 0.5;
    if (z <= 1.02) {
      this.panTarget.set(0, 0);
      return;
    }
    this.panTarget.x = clamp(this.panTarget.x, -limX, limX);
    this.panTarget.y = clamp(this.panTarget.y, -limY, limY);
  }

  setZoom(z) {
    z = clamp(z, 0.85, 4);
    this.zoomAround(this.app.width / 2, this.app.height / 2, this.zoomTarget, z, this.panTarget.clone());
    this.app.invalidate();
  }

  toggleZoomAt(x, y) {
    if (this.zoomTarget > 1.05) {
      this.zoomTarget = 1;
      this.panTarget.set(0, 0);
      this.app.invalidate();
      return;
    }
    // fit the page under the pointer
    const app = this.app;
    const hit = this.hitPage(x, y);
    const leftSide = hit ? !hit.front : x < app.width / 2;
    const d = this.d;
    const s = this.root.scale.x;
    const dist = app.cameraBase.z - this.root.position.z;
    const visH = 2 * Math.tan((app.camera.fov * DEG) / 2) * dist;
    const pagePxH = ((d.Hp * s) / visH) * app.height;
    const pagePxW = ((d.Wp * s) / visH) * app.height;
    const availH = app.height - app.ui.readBottom() - 12;
    const z = clamp(Math.min((0.96 * availH) / pagePxH, (0.96 * app.width) / pagePxW), 1.15, 4);
    this.zoomTarget = z;
    // centre that page (book frame → world offset relative to the book's anchor)
    const cx = (leftSide ? -1 : 1) * (d.Wp / 2 + 0.1) * s;
    const yAnchor = this.root.position.y - app.cameraBase.y;
    const yOffPx = (app.height / 2 - availH / 2 - 6) * 0; // keep centred
    this.panTarget.set(cx, yAnchor + yOffPx);
    this.clampPan();
    app.invalidate();
  }

  // =============================================================== tools & bar
  setTool(tool) {
    this.tool = this.tool === tool ? null : tool;
    if (!this.tool) this.app.ui.toggleInkPop(false);
    this.hover.target = 0;
    this.app.canvas.style.cursor = this.tool ? 'crosshair' : 'default';
    if (this.tool === 'pencil') setTimeout(warmGraphite, 0);
    this.updateBar();
  }

  undo() {
    if (!this.ink) return;
    const page = this.ink.undo();
    this.updateBar();
    if (page) {
      const s = Math.floor(page / 2);
      if (s !== this.s && this.phase === 'reading') this.jumpTo(s);
    }
    this.app.invalidate();
  }

  spreadPages(s = this.s) {
    const n = this.d.pages;
    const left = 2 * s >= 1 && 2 * s <= n ? 2 * s : null;
    const right = 2 * s + 1 <= n ? 2 * s + 1 : null;
    return { left, right };
  }

  toggleBookmark() {
    const b = new Set(this.meta.bookmarks || []);
    if (b.has(this.s)) b.delete(this.s);
    else b.add(this.s);
    this.meta.bookmarks = [...b].sort((a, c) => a - c);
    store.putBook(this.meta).catch(() => {});
    this.syncFlags();
    this.updateBar();
  }

  updateBar() {
    if (!this.active) return;
    const { left, right } = this.spreadPages();
    this.app.ui.updateReaderBar({
      left,
      right,
      pages: this.d.pages,
      tool: this.tool,
      bookmarked: (this.meta.bookmarks || []).includes(this.s),
      canPrev: this.s > 0,
      canNext: this.s < this.d.leaves,
      undo: this.ink ? this.ink.undoStack.length > 0 : false,
    });
  }

  resize() {
    if (!this.active) return;
    this.computeTexHeight();
    this.app.shelf.openGapWidth = this.computeGapWidth();
  }

  key(e) {
    if (!this.active) return false;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') {
      this.undo();
      return true;
    }
    switch (k) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        this.next();
        return true;
      case 'ArrowLeft':
      case 'PageUp':
        this.prev();
        return true;
      case 'Home':
        this.jumpTo(0);
        return true;
      case 'End':
        this.jumpTo(this.d.leaves);
        return true;
      case 'r':
        this.returnToFinger();
        return true;
      case '+':
      case '=':
        this.setZoom(this.zoomTarget * 1.25);
        return true;
      case '-':
        this.setZoom(this.zoomTarget / 1.25);
        return true;
      case '0':
        this.setZoom(1);
        return true;
      case 'h':
        this.setTool('yellow');
        return true;
      case 'p':
        this.setTool('pen');
        return true;
      case 'g':
        this.setTool('pencil');
        return true;
      case 'e':
        this.setTool('eraser');
        return true;
      case 'b':
        this.toggleBookmark();
        return true;
      case 'z':
        this.toggleZen();
        return true;
      case 'Escape':
        if (this.zen) this.setZen(false);
        else if (this.tool) this.setTool(this.tool);
        else if (this.zoomTarget > 1.05) this.setZoom(1);
        else this.close();
        return true;
    }
    return false;
  }
}

/** Apple Pencil pressure (0…1); fingers and mice have none and draw at an even weight. */
function penPressure(e) {
  return e.pointerType === 'pen' ? Math.max(0.02, e.pressure || 0) : null;
}

/** How high the Pencil stands over the page (radians, π/2 upright), or null when the device doesn't say. */
function penTilt(e) {
  if (e.pointerType !== 'pen') return null;
  if (typeof e.altitudeAngle === 'number' && (e.tiltX || e.tiltY || e.altitudeAngle !== Math.PI / 2)) return e.altitudeAngle;
  if (!e.tiltX && !e.tiltY) return null; // no tilt reported (or truly upright: nothing to shade either way)
  const tx = Math.tan((e.tiltX * Math.PI) / 180);
  const ty = Math.tan((e.tiltY * Math.PI) / 180);
  return Math.atan(1 / Math.hypot(tx, ty));
}

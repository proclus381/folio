// The open book: opening/closing choreography, leaf flights (drag / tap / fan), page stacks, page textures,
// annotation hit-testing, zoom & pan.
import * as THREE from 'three';
import { BookModel } from './book3d.js';
import { Leaf, makePageMaterial, NX, NY } from './leaf.js';
import { FLAG, flagsOf, makeFlagMesh, flagMatrix, flagScreenBox, pickBox, layerAt } from './markers.js';
import { applyPaper } from './paper.js';
import { InkLayer, warmGraphite } from './ink.js';
import { openPdf, renderQueue, readOutline } from './pdfdoc.js';
import { canvasTexture, makePaperCanvas } from './textures.js';
import * as store from './store.js';
import { DEG, _N, _P, _T, _U, _e, _q, _v, _w } from './reader-common.js';
import { ReaderFit } from './reader-fit.js';
import { Pages } from './pages.js';
import { Turning, DROP } from './turning.js';
import { Gestures } from './gestures.js';
import { clamp, lerp, seg, easeInOutCubic, easeOutCubic, easeInOutSine, smoothDamp } from './anim.js';

const POOL = 18;
const OPEN = { lift: 0.42, travelAt: 0.3, travel: 1.15, coverAt: 0.5, cover: 1.0, gapAt: 0.15, gap: 1.0, fanAt: 1.42 };
const CLOSE = { swing: 0.55, travelAt: 0.22, travel: 0.8, settleAt: 0.95, settle: 0.45, gapAt: 0.35, gap: 0.9, done: 1.45 };

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
    this.app.shelf.buildModel(entry);
    const mats = entry.mats;
    app.shelf.ensureCover(entry);
    this.model = new BookModel(d, mats, { withLeftStack: true });
    this.model.group.position.copy(d.center).multiplyScalar(-1);
    this.root.add(this.model.group);
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
    this.showShelf(true);
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
        this.drop = { start: time };
        this.showShelf(false); // read alone: nothing else to draw
        this.app.ui.pokeChrome();
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
    if (this.drop) {
      if (this.flights.length || this.fan || time - this.drop.start > DROP.rise + (DROP.n - 1) * DROP.gap + DROP.fall * this.dropFall()) this.drop = null;
      else busy = true;
    }

    // stacks
    const leftCount = this.leftCount(time);
    const hL = (d.tp * leftCount) / d.leaves;
    if (this.phase === 'reading') {
      angle = 0;
      openness = 1;
    }
    this.model.air = this.fan && this.fan.clump ? this.fan.T : 0; // a block of leaves in the air
    this.model.set(angle, hL, openness);
    this.tabR = this.cachedTable('R', this.model.hR, openness);
    this.tabL = this.cachedTable('L', hL, openness);

    this.syncLeaves(time);
    const env = { Wp: d.Wp, Hp: d.Hp, tabR: this.tabR, tabL: this.tabL };
    for (const leaf of this.leafOf.values()) leaf.deform(env);
    this.updateClumpEdge();
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


  // =============================================================== paper
  /** The book's paper (its own, or the library's) on the leaves; again whenever it changes. */
  applyPaper() {
    if (!this.meta) return;
    const r = this.app.paperFor(this.meta);
    this.paperRes = r;
    this.flex = r.flex;
    this.paperPhys = r.phys;
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
      case 'Escape':
        if (this.tool) this.setTool(this.tool);
        else if (this.zoomTarget > 1.05) this.setZoom(1);
        else this.close();
        return true;
    }
    return false;
  }
}

// The reader's parts, each in its own module, joined into one class: the fit (reader-fit.js), the pages' images
// (pages.js), turning leaves (turning.js) and gestures (gestures.js).
for (const part of [ReaderFit, Pages, Turning, Gestures]) {
  const props = Object.getOwnPropertyDescriptors(part.prototype);
  delete props.constructor;
  Object.defineProperties(Reader.prototype, props);
}

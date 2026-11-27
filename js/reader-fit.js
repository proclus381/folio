// The open book's place on screen: fitted to the whole screen as it projects (FULL), its pose while reading, where
// the reading lights stand around it, and the shelf hidden behind it. Mixed into Reader (reader.js).
import { FLAG } from './markers.js';
import { SHELF_Z } from './shelf.js';
import * as THREE from 'three';
import { lerp, smoothstep } from './anim.js';
import { DEG, READ_PITCH, _P, _T, _e, _q, _v } from './reader-common.js';

// The reading view. The open book is fitted to the whole screen, measured as it
// projects (its boards, stacks and spine, and room for its bookmark flags above the head), with a small margin; the
// shelf is hidden while you read (nothing else to draw: the frames come cheaper), and the bars float over the book
// and fade while you read (ui.js: chrome).
const FULL = { side: 12, top: 26, bottom: 14 };

export class ReaderFit {
  /** The shelf behind the open book: hidden while reading in the full view, back for closing. */
  showShelf(on) {
    if (this.app.shelf.group.visible !== on) {
      this.app.shelf.group.visible = on;
      this.app.invalidate();
    }
  }


  /** Where the open book sits for reading: fitted between the title row and the reader bar. */
  /** Where the open book sits for reading: fitted to the whole screen (FULL). */
  readFit() {
    return this.fullFit();
  }


  /** The book fitted to the whole screen (FULL), as it projects; kept until the screen, the book or its flags change. */
  fullFit() {
    const app = this.app;
    const d = this.d;
    const W = app.width;
    const H = app.height;
    const base = app.cameraBase;
    const key = `${W}x${H}|${base.x.toFixed(2)},${base.y.toFixed(2)},${base.z.toFixed(2)}|${(this.flags || []).length > 0}`;
    if (this.fitCache && this.fitCache.key === key && this.fitCache.d === d) return this.fitCache.fit;
    const tanH = Math.tan((app.camera.fov * DEG) / 2);
    const top = FULL.top;
    const bottom = H - FULL.bottom;
    const availH = Math.max(100, bottom - top);
    const availW = Math.max(100, W - 2 * FULL.side);
    const openW = 2 * (d.Wp + d.ov) + 0.3;
    const projH = d.Hc * Math.cos(READ_PITCH) + d.tp * 0.4 + 0.8;
    const need = Math.max(projH / ((2 * tanH * availH) / H), openW / ((2 * tanH * (W / H) * availW) / W));
    const dMax = base.z - SHELF_Z + 3; // never behind the shelf's shadow wall
    const yPx = (top + bottom) / 2;
    const place = (n) => {
      const dist = Math.min(n, dMax);
      const scale = dist / n;
      const yOff = ((H / 2 - yPx) / H) * 2 * tanH * dist;
      return { pos: new THREE.Vector3(base.x, base.y + yOff, base.z - dist), scale, dist, openW: openW * scale, need: n };
    };
    let fit = place(need);
    // scale to the room it really takes on screen, then centre it there
    for (let i = 0; i < 5; i++) {
      const b = this.projectBook(fit);
      const k = Math.max((b.right - b.left) / availW, (b.bottom - b.top) / availH);
      if (!Number.isFinite(k) || Math.abs(k - 1) < 0.002) break;
      fit = place(fit.need * k);
    }
    const wpp = (2 * tanH * fit.dist) / H;
    for (let i = 0; i < 3; i++) {
      const b = this.projectBook(fit);
      const dx = (W / 2 - (b.left + b.right) / 2) * wpp;
      const dy = ((b.top + b.bottom) / 2 - yPx) * wpp;
      if (Math.abs(dx) < 0.002 && Math.abs(dy) < 0.002) break;
      fit.pos.x += dx;
      fit.pos.y += dy;
    }
    this.fitCache = { key, d, fit };
    return fit;
  }


  /** The open book's extent in its own frame (measured once, with the book laid open), with room for its flags. */
  bookLocalBox() {
    if (this.localBox && this.localBox.d === this.d) return this.localBox.box;
    const M = this.model;
    const saved = [M.coverAngle, M.hL, M.openness];
    M.set(0, saved[1], 1);
    const box = new THREE.Box3();
    this.root.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const m = new THREE.Matrix4();
    const skip = new Set(this.flagMeshes ? this.flagMeshes.values() : []);
    if (this.clumpEdge) skip.add(this.clumpEdge);
    this.model.group.traverse((o) => {
      if (!o.isMesh || !o.geometry || skip.has(o)) return;
      for (let p = o; p && p !== this.root; p = p.parent) if (!p.visible) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      m.multiplyMatrices(inv, o.matrixWorld);
      box.union(o.geometry.boundingBox.clone().applyMatrix4(m));
    });
    M.set(...saved);
    this.root.updateWorldMatrix(true, true);
    const flagged = (this.flags || []).length > 0;
    this.localBox = { d: this.d, box, flagged };
    return box;
  }


  /** Where the open book falls on screen (px) when placed by `fit`. */
  projectBook(fit) {
    const app = this.app;
    const d = this.d;
    const cam = this._fitCam || (this._fitCam = new THREE.PerspectiveCamera());
    cam.fov = app.camera.fov;
    cam.aspect = app.width / app.height;
    cam.near = 1;
    cam.far = 1200;
    cam.position.copy(app.cameraBase);
    cam.quaternion.identity(); // (the reading camera looks straight in)
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const q = _q.setFromEuler(_e.set(READ_PITCH, 0, 0, 'YXZ'));
    const s = fit.scale;
    const anchor = _v.set(0, 0, d.tp * 0.25).sub(d.center).multiplyScalar(s).applyQuaternion(q);
    const pos = _P.copy(fit.pos).sub(anchor);
    const box = this.bookLocalBox();
    // bookmark flags stand up from the head
    const head = (this.flags || []).length ? (FLAG.H - FLAG.STUCK + 0.15) * (d.Hc / 22.6) : 0;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < 8; i++) {
      _T.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y + head : box.min.y, i & 4 ? box.max.z : box.min.z);
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

}

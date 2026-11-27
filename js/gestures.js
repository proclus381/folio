// Touch, Pencil, mouse and wheel on the open book: what each gesture does (turn, peel, catch, tap the bars,
// zoom and pan, draw), and finding the page under a finger. Mixed into Reader (reader.js).
import * as THREE from 'three';
import { clamp, lerp, smoothDamp } from './anim.js';
import { DEG, _m } from './reader-common.js';

// A finger on the page block's own edge, or up to this far beyond the page (cm), takes the page's outer edge.
const EDGE_BEYOND = 2.5;

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

export class Gestures {
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
    return Math.abs(h.amount - prev) > 1e-4 || (h.amount > 0 && Math.abs(du) + Math.abs(dv) > 1e-4);
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
    if (this.flights.length && !zoomed && !this.fan) {
      const fl = this.hitFlight(e.clientX, e.clientY);
      if (fl) {
        // a leaf in the air under your finger: held, everything in the air brakes (updateFlights)
        this.gesture = { mode: 'catch', fl, id: e.pointerId, clock0: this.app.clock, braked: false };
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
    if (!hit && !zoomed && !this.fan) {
      // on the page block's own edge, or just beyond the page: that is its outer edge too
      const bp = this.bookPoint(e.clientX, e.clientY);
      const ax = bp ? Math.abs(bp.x) : 0;
      if (bp && ax > this.d.Wp * 0.8 && ax < this.d.Wp + EDGE_BEYOND && Math.abs(bp.y) < this.d.Hp / 2 + 1) {
        if (this.startDrag(bp.x > 0 ? +1 : -1, e.clientX, e.clientY)) {
          this.gesture = { mode: 'turn' };
          return;
        }
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
    if (g.mode === 'catch' && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 8) {
      // a swipe on with the leaf's own turn queues the next one; pulled any other way, the leaf is caught
      const sx = e.clientX - p.x0;
      const sy = e.clientY - p.y0;
      const dir = sx < 0 ? +1 : -1;
      if (Math.abs(sx) > Math.abs(sy) * 0.8 && dir === g.fl.dir && this.flightCompletes(g.fl)) {
        this.brakeAll(false);
        g.mode = (dir > 0 ? this.next() : this.prev()) ? 'queued' : 'none';
        this.app.invalidate();
        return;
      }
      this.grabCaught(g);
    }
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
    else this.app.ui.toggleChrome(); // the middle of the page: the bars, on or off
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
        h.target = 1;
        h.gu = hit.uvx;
        h.gv = hit.uvy - 0.5;
      } else h.target = 0;
    }
    this.app.canvas.style.cursor = this.tool ? 'crosshair' : h.target > 0 ? 'grab' : 'default';
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
    const availH = app.height - 24; // (the bars float over the book and fade)
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

}

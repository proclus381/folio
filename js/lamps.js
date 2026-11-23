// Two lamps: one on the table beside the book, one just out of frame.
//
// OilLamp — a glass table lamp: brass foot and burner, a glass font with the oil inside, a tall chimney.
//   The flat wick burns brighter and steadier than a candle (≈2000 K); the chimney shields it, so a page
//   turn barely moves it. Turned down, the flame shrinks and a wisp rises from the chimney.
// DeskLamp — a banker's lamp standing just out of frame: a warm spot (≈2700 K) throws a soft-edged pool
//   across the spread and casts the shadow of a turning leaf; its green shade glows faintly on the wall.
//   Switched on it warms up in a blink; switched off the filament cools — redder, dimmer — and goes out.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './anim.js';
import { LightSource, kelvinColor, noise1 } from './lighting.js';
import { BILLBOARD_VERT, FLAME_FRAG, GLOW_FRAG, SMOKE_VERT, SMOKE_FRAG, OVER, ADDITIVE } from './candle.js';
import { reflectRoom } from './room.js';

const lathe = (pts, seg = 96) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg);

/**
 * Turned work with a pattern round it: each vertex's radius × (1 + amp · wave(n·angle) · band(height)), where band
 * fades the pattern in and out between y0 and y1. Flutes of pressed glass, the knurling of a brass collar.
 */
export function pattern(geo, n, amp, y0, y1, wave = Math.cos) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const b = smoothstep(y0, y0 + (y1 - y0) * 0.25, y) * (1 - smoothstep(y1 - (y1 - y0) * 0.25, y1, y));
    if (b <= 0) continue;
    const k = 1 + amp * b * wave(n * Math.atan2(z, x));
    p.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A thin thread of smoke (for a flame put out). */
class Smoke {
  constructor(parent, n = 48) {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(this.geo, new THREE.ShaderMaterial({ vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG, transparent: true, depthWrite: false }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 11;
    parent.add(this.points);
    this.p = Array.from({ length: n }, () => ({ alive: false }));
    this.emit = 0;
  }
  get busy() {
    return this.emit > 0 || this.p.some((q) => q.alive);
  }
  update(dt, from) {
    if (this.emit > 0) {
      this.emit -= dt;
      const q = this.p.find((x) => !x.alive);
      if (q) Object.assign(q, { alive: true, x: from.x + (Math.random() - 0.5) * 0.1, y: from.y, z: (Math.random() - 0.5) * 0.1, vx: (Math.random() - 0.5) * 0.15, vy: 1 + Math.random() * 0.5, age: 0, life: 2.4 + Math.random() * 1.4, seed: Math.random() * 100 });
    }
    const pos = this.geo.attributes.position.array;
    const al = this.geo.attributes.aAlpha.array;
    const sz = this.geo.attributes.aSize.array;
    this.p.forEach((q, i) => {
      if (q.alive && (q.age += dt) > q.life) q.alive = false;
      if (!q.alive) return void (al[i] = 0);
      const a = q.age / q.life;
      q.vy *= Math.exp(-dt * 0.35);
      q.vx += (noise1(q.seed + q.age * 1.7) - 0.5) * 1.4 * dt * (0.3 + a);
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      pos[i * 3] = q.x;
      pos[i * 3 + 1] = q.y;
      pos[i * 3 + 2] = q.z;
      al[i] = Math.pow(1 - a, 1.5) * smoothstep(0, 0.06, a) * 0.45;
      sz[i] = 0.5 + a * 3;
    });
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}

// polished brass: a metal, so what it shows is the room it reflects (room.js: the room of the light that's on)
export const brass = (opacity = 1, key = 'brass') =>
  reflectRoom(new THREE.MeshStandardMaterial({ color: 0xd2ab62, metalness: 1, roughness: 0.3, transparent: true, opacity }), 1, key);

/** Clear glass: nearly invisible face-on, showing at its edges (Fresnel) where it reflects the room. */
function glass(color, rim = 1) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.05, metalness: 0, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
  float fres = pow(1.0 - abs(dot(normal, geometryViewDir)), 3.0);
  outgoingLight += vec3(0.9, 0.92, 0.95) * fres * ${rim.toFixed(2)} * 0.35;
  diffuseColor.a = clamp(opacity * (0.3 + 2.6 * fres * ${rim.toFixed(2)}), 0.0, 0.85);
}
#include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => `folio-glass-${rim}`;
  // and it reflects the room (the dark room and the window or lamp in it), most at its edges
  return reflectRoom(m, 0.8, 'glass-' + rim);
}

// =============================================================== oil lamp
const OIL_I = 300;
const OIL_DIM = { ambient: 0.5, key: 0.36, fill: 0.4 };
// the font's outer profile (radius by height); the oil sits inside it
const FONT = [
  [0.95, 1.05],
  [2.0, 1.45],
  [2.7, 2.4],
  [2.62, 3.4],
  [1.85, 4.3],
  [1.05, 4.62],
];
/** A profile through its points, smooth (centripetal-ish Catmull-Rom, `n` steps a segment): turned glass has no corners. */
function smooth(pts, n = 8) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const FONT_S = smooth(FONT, 10);

function fontRadiusAt(y) {
  for (let i = 1; i < FONT_S.length; i++) {
    if (y <= FONT_S[i][1]) {
      const t = (y - FONT_S[i - 1][1]) / (FONT_S[i][1] - FONT_S[i - 1][1] || 1);
      return lerp(FONT_S[i - 1][0], FONT_S[i][0], clamp(t, 0, 1));
    }
  }
  return FONT_S[FONT_S.length - 1][0];
}

export class OilLamp extends LightSource {
  constructor(app) {
    super(app, 'oil');
    this.startTime = 1.6;
    this.endTime = 3.2;
    this.outTime = 4.5;
    this.room = OIL_DIM;
    this.css = { dimAmount: 0.85 };
    this.size = 0;
    this.flick = 1;
    this.lean = 0;
    this.gustAmp = 0;
    this.gustDir = 1;
    this.gustT = 0;
    this.appear = 0;
    this.build();
  }

  build() {
    const g = (this.inner = new THREE.Group());
    this.group.add(g);
    this.brassMat = brass(0);
    const foot = new THREE.Mesh(lathe([[0, 0], [2.45, 0], [2.55, 0.16], [2.25, 0.38], [1.1, 0.62], [0.95, 1.08], [0, 1.08]]), this.brassMat);
    foot.castShadow = true;
    g.add(foot);
    // glass font with the oil in it
    this.glassMat = glass(0xe8f0ec, 0.8);
    // pressed glass: sixteen soft flutes round the belly of the font
    const font = new THREE.Mesh(pattern(lathe([[0, FONT[0][1]], ...FONT_S, [0, FONT[FONT.length - 1][1]]], 128), 16, 0.035, 1.3, 4.35), this.glassMat);
    font.renderOrder = 6;
    g.add(font);
    // lamp oil: pale amber, lit from above through the glass
    this.oilMat = new THREE.MeshStandardMaterial({ color: 0xc99a48, roughness: 0.15, transparent: true, opacity: 0, emissive: new THREE.Color(0xffa040), emissiveIntensity: 0, depthWrite: false });
    this.oilClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    this.oilMat.clippingPlanes = [this.oilClip];
    const oil = new THREE.Mesh(lathe([[0, FONT[0][1] + 0.05], ...FONT_S.map(([r, y]) => [r * 0.93, y]), [0, 4.55]]), this.oilMat);
    oil.renderOrder = 5;
    g.add(oil);
    this.oilTop = new THREE.Mesh(new THREE.CircleGeometry(1, 40), this.oilMat);
    this.oilTop.rotation.x = -Math.PI / 2;
    this.oilTop.renderOrder = 5;
    g.add(this.oilTop);
    // collar, burner and its gallery
    // the collar, and the burner screwed into it with a knurled band to grip
    const collar = new THREE.Mesh(
      pattern(lathe([[1.05, 4.6], [1.1, 4.7], [1.1, 5.05], [1.35, 5.1], [1.4, 5.16], [1.4, 5.6], [1.42, 5.75], [1.2, 5.8], [0, 5.8]], 192), 72, 0.018, 5.14, 5.62),
      this.brassMat,
    );
    collar.castShadow = true;
    g.add(collar);
    // the wick-raiser: a spindle out of the burner's side with a knurled thumbwheel
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 16), this.brassMat);
    spindle.rotation.z = Math.PI / 2;
    spindle.position.set(1.75, 5.42, 0.6);
    g.add(spindle);
    const wheel = new THREE.Mesh(pattern(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 48), 24, 0.04, -1, 1), this.brassMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(2.22, 5.42, 0.6);
    wheel.castShadow = true;
    g.add(wheel);
    // chimney
    this.chimMat = glass(0xffffff, 1);
    const chim = new THREE.Mesh(lathe([...smooth([[1.18, 5.72], [1.22, 6.25], [1.72, 7.15], [1.86, 8.0], [1.55, 9.0], [1.02, 9.9], [0.97, 12.2]], 8), [0.97, 12.4], [1.04, 12.5]], 96), this.chimMat);
    chim.renderOrder = 7;
    g.add(chim);
    // flat wick + flame + the glow it puts in the glass
    this.flameU = { uTime: { value: 0 }, uFlick: { value: 1 }, uLean: { value: 0 }, uAlpha: { value: 0 } };
    const flameGeo = new THREE.PlaneGeometry(1, 1);
    flameGeo.translate(0, 0.5, 0);
    this.flame = new THREE.Mesh(flameGeo, new THREE.ShaderMaterial({ vertexShader: BILLBOARD_VERT, fragmentShader: FLAME_FRAG, uniforms: this.flameU, ...OVER }));
    this.flame.renderOrder = 10;
    this.flame.frustumCulled = false;
    g.add(this.flame);
    this.haloU = { uAlpha: { value: 0 }, uColor: { value: new THREE.Color(1, 0.66, 0.34) } };
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ vertexShader: BILLBOARD_VERT, fragmentShader: GLOW_FRAG, uniforms: this.haloU, ...ADDITIVE }));
    this.halo.renderOrder = 9;
    this.halo.frustumCulled = false;
    g.add(this.halo);
    this.light = new THREE.PointLight(0xffffff, 0, 0, 2);
    this.light.position.set(0, 7.2, 0.2);
    g.add(this.light);
    this.smoke = new Smoke(g);
    this.fade = [this.brassMat, this.glassMat, this.oilMat, this.chimMat];
    this.fadeTo = [1, 0.22, 0.72, 0.16];
  }

  applySettings(s) {
    this.s = { ...s };
    kelvinColor(s.warmth, this.light.color);
    this.haloU.uColor.value.copy(this.light.color);
  }

  place(L) {
    const side = this.s.side >= 0 ? 1 : -1;
    const s = L.s;
    let z = L.nearZ + 0.4 * s;
    let y = L.bottomY - 0.2 * s;
    let scale = s * 0.9;
    // beside the book, moving in toward it when the screen is narrow (its foot just clear of the boards)
    const room = L.halfWAt(z) - 2.9 * s;
    const off = Math.min(L.cx * side + L.edge + 3.6 * s, L.camX * side + room) - L.cx * side;
    let x = L.cx + side * off;
    if (off < L.edge + 2.5 * s) {
      // no room beside the book: nearer to us, below its lower edge, clear of the page
      scale = s * 0.5;
      z = L.nearZ + 1.2 * s;
      y = L.bottomY - 13.4 * scale - 0.5 * s;
      x = L.camX + side * (L.halfWAt(z) - 3.6 * scale);
    }
    this.group.position.set(x, y, z);
    this.group.scale.setScalar(scale);
    this.group.updateMatrixWorld();
  }

  gust(dir, strength) {
    // the chimney keeps the draught off: a quarter of what a candle feels
    this.gustAmp = Math.min(0.35, Math.max(this.gustAmp, strength * 0.25));
    this.gustDir = dir;
    this.gustT = this.time;
  }

  step(dt, camera) {
    const t = this.time;
    const st = this.state;
    let target = 0;
    if (st === 'starting') target = smoothstep(0, this.startTime, this.stateT) * (1 + 0.15 * Math.exp(-this.stateT * 3));
    else if (st === 'on') target = 1;
    else if (st === 'ending') {
      // the wick starves: smaller, sputtering
      const k = clamp(this.stateT / this.endTime, 0, 1);
      target = (1 - k) * (0.7 + 0.6 * (noise1(t * 7) - 0.5)) + 0.04;
    }
    this.size += (target - this.size) * (1 - Math.exp(-dt * 6));
    if (st === 'out') this.size *= Math.exp(-dt * 12);
    if (st === 'out' && this.stateT < dt * 1.5) this.smoke.emit = 1.1;
    const show = st === 'off' ? 0 : st === 'out' ? (this.stateT > this.outTime - 1.6 ? 0 : 1) : 1;
    this.appear += (show - this.appear) * (1 - Math.exp(-dt * (show ? 5 : 2.5)));
    if (show === 0 && this.appear < 0.01) this.appear = 0;
    this.level = Math.max(this.size, this.appear);
    for (let i = 0; i < this.fade.length; i++) this.fade[i].opacity = this.fadeTo[i] * this.appear;

    // a sheltered flame: slow breathing and a faint shiver
    const live = this.lively;
    this.gustAmp *= Math.exp(-dt / 0.8);
    const ring = this.gustAmp * Math.sin(2 * Math.PI * 4 * (t - this.gustT));
    const wander = noise1(t * 0.7) - 0.5;
    this.flick = 1 + live * (0.05 * wander + 0.018 * Math.sin(2 * Math.PI * 6.5 * t + wander * 3) + 0.02 * (noise1(t * 3.1 + 7) - 0.5)) - 0.15 * this.gustAmp + 0.06 * ring;
    this.lean = this.gustDir * this.gustAmp * 0.25 + 0.03 * live * wander;

    // oil: from near full to the last finger
    const oilY = 3.5; // the font about two-thirds full
    this.oilClip.constant = 0; // set in world space below
    const wp = new THREE.Vector3(0, oilY, 0);
    this.inner.localToWorld(wp);
    this.oilClip.normal.set(0, -1, 0);
    this.oilClip.constant = wp.y;
    this.oilTop.position.y = oilY;
    this.oilTop.scale.setScalar(fontRadiusAt(oilY) * 0.92);
    this.oilMat.emissiveIntensity = 0.18 * this.size;

    const fs = this.size;
    this.flame.position.set(0, 5.95, 0);
    this.flame.scale.set(1.25 * Math.max(0.001, fs), 2.05 * Math.max(0.001, fs) * (0.95 + 0.05 * this.flick), 1);
    this.flameU.uTime.value = t * 0.6;
    this.flameU.uFlick.value = this.flick;
    this.flameU.uLean.value = this.lean;
    this.flameU.uAlpha.value = clamp(fs, 0, 1.1);
    this.flame.visible = fs > 0.01;
    this.halo.position.set(0, 7.0, 0.1);
    this.halo.scale.set(7.5, 9, 1);
    this.haloU.uAlpha.value = clamp(fs, 0, 1) * 0.6 * this.flick;
    this.halo.visible = fs > 0.01;
    if (camera) {
      this.flame.quaternion.copy(camera.quaternion);
      this.halo.quaternion.copy(camera.quaternion);
    }
    this.light.intensity = OIL_I * clamp(fs, 0, 1.2) * this.flick * this.s.brightness;
    this.light.position.set(this.lean * 0.2, 7.0, 0.2);
    this.smoke.update(dt, new THREE.Vector3(0, 12.5, 0));
    if (this.state === 'off' && this.smoke.busy) this.level = 0.01;
  }

  hide() {
    this.light.intensity = 0;
  }

  glow(camera, w, h) {
    if (this.size <= 0.01) return null;
    const v = new THREE.Vector3(0, 7.2, 0);
    this.inner.localToWorld(v);
    v.project(camera);
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, opacity: clamp(this.size, 0, 1) * this.flick * 0.45 * this.s.brightness, c1: 'rgba(255,184,110,0.95)', c2: 'rgba(255,160,80,0.42)', r: 34 };
  }
}

// =============================================================== banker's lamp
const DESK_DIM = { ambient: 0.4, key: 0.22, fill: 0.26, rake: 0.3 };
const DESK_E = 3.0; // irradiance at the middle of the pool (scene units, like the key's 2.1)

/**
 * The lamp itself stands just beyond the frame — a banker's lamp is taller than the book and would crowd
 * the page — so what you see is what you would see with your eyes on the page: its pool of warm light,
 * brightest on the near page and falling off softly across the spread, a turning leaf's shadow, and a
 * faint green glow from the shade on the wall above.
 */
export class DeskLamp extends LightSource {
  constructor(app) {
    super(app, 'desk');
    this.startTime = 0.35;
    this.endTime = 2.6;
    this.outTime = 1.6;
    this.fps = 0; // a steady light: nothing to animate once on
    this.room = DESK_DIM;
    this.css = { dim1: 'rgba(20,16,10,0.4)', dim2: 'rgba(10,8,5,0.58)', dimAmount: 1 };
    this.k = 2700;
    this._c = new THREE.Color();
    this.spot = new THREE.SpotLight(0xffffff, 0, 0, 0.6, 0.85, 2);
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(1024, 1024);
    this.spot.shadow.radius = 5;
    this.spot.shadow.blurSamples = 10;
    this.spot.shadow.bias = -0.0006;
    this.group.add(this.spot);
    app.scene.add(this.spot.target);
    this.side = 1;
  }

  applySettings(s) {
    this.s = { ...s };
    this.k = s.warmth;
  }

  place(L) {
    const side = this.s.side >= 0 ? 1 : -1;
    this.side = side;
    // the bulb: above the page on the lamp's side, a little in front, as a lamp at your elbow
    const target = L.center.clone().addScaledVector(L.R, side * L.edge * 0.38).addScaledVector(L.U, -0.1 * L.edge);
    const dir = new THREE.Vector3().addScaledVector(L.R, side * 0.55).addScaledVector(L.N, 0.75).addScaledVector(L.U, 0.36).normalize();
    const D = 1.55 * L.edge;
    this.spot.position.copy(target).addScaledVector(dir, D);
    this.spot.target.position.copy(target);
    this.spot.target.updateMatrixWorld();
    this.dist = D;
    // a pool about a page and a half across, its edge very soft
    this.spot.angle = Math.atan((1.35 * L.edge) / D);
    this.spot.shadow.camera.near = D * 0.3;
    this.spot.shadow.camera.far = D * 3;
    this.poolAt = target;
  }

  step(dt) {
    const st = this.state;
    let target = 0;
    let warm = 0; // 0 hot filament … 1 cooling
    if (st === 'starting') {
      target = smoothstep(0, this.startTime, this.stateT);
      warm = 1 - target;
    } else if (st === 'on') target = 1;
    else if (st === 'ending') {
      // a timer switch winding down: the filament cools, redder and dimmer
      const k = clamp(this.stateT / this.endTime, 0, 1);
      target = 1 - smoothstep(0, 1, k);
      warm = k;
    } else if (st === 'out') {
      target = 0;
      warm = 1;
    }
    this.level += (target - this.level) * (1 - Math.exp(-dt * (st === 'out' ? 10 : 14)));
    if (target === 0 && this.level < 0.002) this.level = 0;
    kelvinColor(lerp(this.k, 1500, warm * 0.8), this._c);
    this.spot.color.copy(this._c);
    const d = this.dist || 20;
    this.spot.intensity = DESK_E * d * d * this.level * this.s.brightness;
    // animating only while switching
    this.fps = st === 'starting' || st === 'ending' || st === 'out' || Math.abs(target - this.level) > 0.01 ? 60 : 0;
  }

  hide() {
    this.spot.intensity = 0;
  }

  /** Light spilling past the book onto the wall around its pool. */
  glow(camera, w, h) {
    if (this.level <= 0.01 || !this.poolAt) return null;
    const v = this.poolAt.clone().project(camera);
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, opacity: this.level * 0.5 * this.s.brightness, c1: 'rgba(255,206,140,0.9)', c2: 'rgba(255,186,110,0.45)', r: 46 };
  }

  /** The shade's green glass, glowing faintly on the wall above the book on the lamp's side. */
  wall(camera, w, h) {
    if (this.level <= 0.01) return null;
    if (!this.shadeGlow) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d');
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgb(150,215,170)');
      g.addColorStop(0.5, 'rgb(136,170,146)');
      g.addColorStop(1, 'rgb(128,128,128)');
      x.fillStyle = g;
      x.fillRect(0, 0, 64, 64);
      this.shadeGlow = c;
    }
    const cx = w / 2 + this.side * w * 0.43;
    const r = Math.max(w, h) * 0.32;
    return { image: this.shadeGlow, quad: [cx - r, -r * 0.7, cx + r, -r * 0.7, cx - r, r * 1.3], opacity: this.level * 0.8 * this.s.brightness };
  }
}

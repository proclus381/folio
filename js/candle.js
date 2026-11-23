// A reading candle. Light it for a sitting (10–45 min); it stands beside the open book, burns down as the
// time passes, lights the pages with a flickering 1900 K glow while the room dims, and gutters out at the end.
//
// Flame: a procedural billboard — blue base, dark vapour zone above the wick, white-yellow core, orange tip —
// swaying with slow noise and pulsing at ≈11 Hz like a free flame; a page turn sends a gust that bends it
// and rings at ≈5 Hz before it settles. The point light follows the same signal, so the pages flicker in
// step with what you see. Wax glows from inside near the top; the wick ends in an ember.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './anim.js';
import { kelvinColor } from './lighting.js';
import { reflectRoom } from './room.js';

const R = 1.45; // pillar radius (world units, before scale)
const H_FULL = 7.4;
const H_END = 1.4;
const FLAME_W = 0.95;
const FLAME_H = 2.5;
const LIGHT_I = 205; // physically based units: bright on the near page, falling off by the square of distance
const LIGHT_COLOR = new THREE.Color(1.0, 0.62, 0.3); // ≈1900 K, a little desaturated for paper
const GLOW_COLOR = new THREE.Color(1.0, 0.46, 0.13); // wax lit from inside reads deep amber
// how far the room's own lights fall while the candle burns
const DIM = { ambient: 0.42, key: 0.32, fill: 0.35 };

// ---------------------------------------------------------------- noise
function hash(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

// ---------------------------------------------------------------- shaders
const BILLBOARD_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FLAME_FRAG = `
varying vec2 vUv;
uniform float uTime;
uniform float uFlick;
uniform float uLean;
uniform float uAlpha;
float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float n1(float x) { float i = floor(x); float f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  // t runs from the wick (0) to the tip (1); x across the flame
  float t = (vUv.y - 0.05) / 0.9;
  float sway = (uLean + 0.05 * sin(uTime * 6.3 + t * 2.4) + 0.05 * (n1(uTime * 8.0 + t * 3.0) - 0.5)) * t * t;
  float x = (vUv.x - 0.5) * 2.0 - sway * 2.0;
  float tt = clamp(t, 0.0, 1.0);
  // teardrop: round at the bottom, drawn to a point at the top; the top flutters a little
  float flutter = 1.0 + 0.08 * (n1(uTime * 13.0 + t * 6.0) - 0.5) * tt;
  float width = 1.5 * pow(tt, 0.45) * pow(1.0 - tt, 0.9) * flutter;
  float d = abs(x) / max(width, 1e-3);
  float inside = step(0.0, t) * step(t, 1.0);
  float body = smoothstep(1.0, 0.5, d) * inside;
  body *= smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.78, 1.0, t));
  vec3 tip = vec3(1.0, 0.36, 0.08);
  vec3 mid = vec3(1.0, 0.68, 0.28);
  vec3 core = vec3(1.0, 0.95, 0.84);
  vec3 col = mix(tip, mid, smoothstep(0.98, 0.45, t));
  float coreMask = smoothstep(0.66, 0.12, d) * smoothstep(0.1, 0.25, t) * (1.0 - smoothstep(0.5, 0.82, t));
  col = mix(col, core, coreMask);
  // unburnt vapour just above the wick is dark
  float vapour = smoothstep(0.38, 0.0, d) * smoothstep(0.26, 0.07, t) * smoothstep(0.0, 0.05, t);
  col *= 1.0 - 0.6 * vapour;
  // the blue foot of the flame
  float blue = smoothstep(0.22, 0.03, t) * smoothstep(1.0, 0.45, d);
  col = mix(col, vec3(0.28, 0.4, 1.0), blue * 0.8);
  float a = body * (0.95 - 0.45 * blue) * uAlpha * (0.88 + 0.12 * uFlick);
  gl_FragColor = vec4(col * a, a);
}`;

const GLOW_FRAG = `
varying vec2 vUv;
uniform float uAlpha;
uniform vec3 uColor;
void main() {
  vec2 p = vUv - 0.5;
  p.y *= 0.8;
  float r2 = dot(p, p) * 4.0;
  float a = (exp(-r2 * 9.0) * 0.55 + exp(-r2 * 2.2) * 0.25) * uAlpha;
  gl_FragColor = vec4(uColor * a, a);
}`;

const SMOKE_VERT = `
attribute float aAlpha;
attribute float aSize;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const SMOKE_FRAG = `
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(p)) * vAlpha;
  gl_FragColor = vec4(vec3(0.62, 0.6, 0.58) * a, a);
}`;

// the flame is drawn "over" (premultiplied) so it still reads as a flame in front of white paper;
// the halo adds light
const OVER = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};
const ADDITIVE = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
};

// ---------------------------------------------------------------- candle
export class Candle {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = 'candle';
    this.group.visible = false;
    app.scene.add(this.group);
    this.inner = new THREE.Group(); // rises in / sinks out
    this.group.add(this.inner);

    this.state = 'off'; // off · lighting · lit · guttering · smoke
    this.stateT = 0;
    this.duration = 0;
    this.elapsed = 0;
    this.appear = 0;
    this.dim = 0;
    this.size = 0;
    this.flick = 1;
    this.lean = 0;
    this.gustAmp = 0;
    this.gustDir = 1;
    this.gustT = 0;
    this.time = 0;
    this.height = H_FULL;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.onDone = null;
    this.id = 'candle';
    this.fps = 30;
    this.s = { warmth: 1900, brightness: 1, liveliness: 1, side: 1 };
    this.lightColor = LIGHT_COLOR.clone();
    this.room = { ambient: DIM.ambient, key: DIM.key, fill: DIM.fill };
    this.css = {};

    this.build();
  }

  /** warmth (K), brightness, liveliness, side (+1 right of the book, −1 left). */
  applySettings(s) {
    this.s = { ...this.s, ...s };
    kelvinColor(this.s.warmth, this.lightColor);
    this.light.color.copy(this.lightColor);
    this.haloU.uColor.value.copy(this.lightColor);
    // the wax glows a deeper amber than the flame's light
    kelvinColor(this.s.warmth - 450, this.glowU.uGlowColor.value);
    this.rimMat.emissive.copy(this.glowU.uGlowColor.value);
    this.poolMat.emissive.copy(this.glowU.uGlowColor.value);
  }

  build() {
    const fade = { transparent: true, opacity: 0 };
    // a brass chamberstick: a wide dish with a rolled rim, a socket the candle stands in, a ring to carry it by
    // (brass is a metal: what it shows is the room it reflects, room.js)
    const S = R + 0.12; // the socket's inner radius
    const dishPts = [
      [0, 0],
      [2.3, 0],
      [2.6, 0.05],
      [2.8, 0.2],
      [2.86, 0.36],
      [2.8, 0.47],
      [2.68, 0.44],
      [2.5, 0.27],
      [2.1, 0.19],
      [S + 0.1, 0.18],
      [S + 0.06, 0.26],
      [S + 0.04, 0.92],
      [S + 0.13, 1.0],
      [S + 0.1, 1.08],
      [S, 1.06],
      [S - 0.02, 0.25],
      [0, 0.17],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    this.dishMat = reflectRoom(new THREE.MeshStandardMaterial({ color: 0xd2ab62, metalness: 1, roughness: 0.32, ...fade }), 1, 'brass-candle');
    const dish = new THREE.Mesh(new THREE.LatheGeometry(dishPts, 96), this.dishMat);
    dish.castShadow = dish.receiveShadow = true;
    this.inner.add(dish);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.1, 12, 40), this.dishMat);
    ring.position.set(3.3, 0.3, 0);
    ring.castShadow = true;
    this.inner.add(ring);
    const tab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.07, 0.42), this.dishMat);
    tab.position.set(2.95, 0.42, 0);
    this.inner.add(tab);

    // wax pillar (unit height, scaled), glowing from inside near the top
    this.glowU = { uGlow: { value: 0 }, uGlowColor: { value: GLOW_COLOR.clone() }, uHeight: { value: H_FULL } };
    this.waxMat = new THREE.MeshStandardMaterial({ color: 0xe2d6c1, roughness: 0.46, ...fade });
    this.waxMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.glowU);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vWaxY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaxY = position.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vWaxY;\nuniform float uGlow;\nuniform vec3 uGlowColor;\nuniform float uHeight;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
// the flame lights the wax from inside the top; lower down the pillar sits in its own shade
float waxDepth = (1.0 - vWaxY) * uHeight;
diffuseColor.rgb *= mix(0.62, 1.0, exp(-waxDepth / 3.5));`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
// light from the flame scattering through the wax: strongest at the rim, gone a few cm down
totalEmissiveRadiance += uGlowColor * uGlow * (exp(-waxDepth / 0.55) * 1.2 + exp(-waxDepth / 1.9) * 0.3);`,
        );
    };
    this.waxMat.customProgramCacheKey = () => 'folio-wax-1';
    const bodyGeo = new THREE.CylinderGeometry(R, R * 1.015, 1, 56, 1, true);
    bodyGeo.translate(0, 0.5, 0);
    this.body = new THREE.Mesh(bodyGeo, this.waxMat);
    this.body.position.y = 0.17;
    this.body.castShadow = true;
    this.inner.add(this.body);

    // soft rim and the molten pool inside it
    this.rimMat = new THREE.MeshStandardMaterial({ color: 0xf3ead8, roughness: 0.45, emissive: GLOW_COLOR.clone(), emissiveIntensity: 0, ...fade });
    // (not quite round: wax melts back unevenly)
    const rimGeo = new THREE.TorusGeometry(R - 0.13, 0.13, 10, 96);
    const rp = rimGeo.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      const a = Math.atan2(rp.getY(i), rp.getX(i));
      const k = 1 + 0.025 * Math.sin(3 * a + 1.1) + 0.015 * Math.sin(7 * a + 0.4);
      rp.setXYZ(i, rp.getX(i) * k, rp.getY(i) * k, rp.getZ(i) * (1 + 0.6 * (k - 1) * 8));
    }
    rimGeo.computeVertexNormals();
    this.rim = new THREE.Mesh(rimGeo, this.rimMat);
    this.rim.rotation.x = Math.PI / 2;
    this.rim.castShadow = true;
    this.inner.add(this.rim);
    this.poolMat = new THREE.MeshStandardMaterial({ color: 0xf6ead0, roughness: 0.1, emissive: GLOW_COLOR.clone(), emissiveIntensity: 0, ...fade });
    this.pool = new THREE.Mesh(new THREE.CircleGeometry(R - 0.14, 48), this.poolMat);
    this.pool.rotation.x = -Math.PI / 2;
    this.inner.add(this.pool);

    // a few drips run down from the rim (they go down with it as the candle burns)
    // a run of wax: a thin trail from the rim swelling into a bead where it stopped, lying against the pillar
    this.dripMat = new THREE.MeshStandardMaterial({ color: 0xd8cbb3, roughness: 0.42, ...fade });
    const dripGeo = (r, len) => {
      const pts = [
        [0, 0.05],
        [0.55 * r, 0],
        [0.42 * r, -0.3 * len],
        [0.5 * r, -0.7 * len],
        [0.95 * r, -len + 0.9 * r],
        [0.8 * r, -len + 0.25 * r],
        [0, -len],
      ];
      return new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 14);
    };
    this.drips = [
      [1.15, 0.13, 1.1],
      [2.1, 0.1, 0.55],
      [4.3, 0.15, 1.6],
    ].map(([a, r, len]) => {
      const m = new THREE.Mesh(dripGeo(r, len), this.dripMat);
      m.position.set(Math.cos(a) * (R + r * 0.1), 0, Math.sin(a) * (R + r * 0.1));
      m.scale.set(1, 1, 0.55);
      m.lookAt(0, 0, 0);
      m.castShadow = true;
      this.inner.add(m);
      return { m, drop: 0 };
    });

    // wick and ember
    this.wickMat = new THREE.MeshStandardMaterial({ color: 0x2a231e, roughness: 0.9, ...fade });
    const wickGeo = new THREE.CylinderGeometry(0.04, 0.055, 0.6, 8);
    wickGeo.translate(0, 0.3, 0);
    this.wick = new THREE.Mesh(wickGeo, this.wickMat);
    this.wick.rotation.z = -0.18;
    this.inner.add(this.wick);
    this.emberMat = new THREE.MeshBasicMaterial({ color: 0xff5a14, transparent: true, opacity: 0 });
    this.ember = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), this.emberMat);
    this.inner.add(this.ember);

    // flame and halo
    const flameGeo = new THREE.PlaneGeometry(1, 1);
    flameGeo.translate(0, 0.5, 0);
    this.flameU = { uTime: { value: 0 }, uFlick: { value: 1 }, uLean: { value: 0 }, uAlpha: { value: 0 } };
    this.flame = new THREE.Mesh(flameGeo, new THREE.ShaderMaterial({ vertexShader: BILLBOARD_VERT, fragmentShader: FLAME_FRAG, uniforms: this.flameU, ...OVER }));
    this.flame.renderOrder = 10;
    this.flame.frustumCulled = false;
    this.inner.add(this.flame);
    this.haloU = { uAlpha: { value: 0 }, uColor: { value: new THREE.Color(1.0, 0.62, 0.3) } };
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ vertexShader: BILLBOARD_VERT, fragmentShader: GLOW_FRAG, uniforms: this.haloU, ...ADDITIVE }));
    this.halo.renderOrder = 9;
    this.halo.frustumCulled = false;
    this.inner.add(this.halo);

    // the light the pages see
    this.light = new THREE.PointLight(LIGHT_COLOR, 0, 0, 2);
    this.inner.add(this.light);

    // smoke for when it goes out
    const NS = 70;
    this.smokeN = NS;
    const sp = new Float32Array(NS * 3);
    this.smokeGeo = new THREE.BufferGeometry();
    this.smokeGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3).setUsage(THREE.DynamicDrawUsage));
    this.smokeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(NS), 1).setUsage(THREE.DynamicDrawUsage));
    this.smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(NS), 1).setUsage(THREE.DynamicDrawUsage));
    this.smoke = new THREE.Points(
      this.smokeGeo,
      new THREE.ShaderMaterial({ vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG, transparent: true, depthWrite: false }),
    );
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 11;
    this.inner.add(this.smoke);
    this.particles = Array.from({ length: NS }, () => ({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, age: 0, life: 1, seed: Math.random() }));
    this.smokeEmit = 0;

    this.fadeMats = [this.dishMat, this.waxMat, this.rimMat, this.poolMat, this.wickMat, this.dripMat];
  }

  // ---------------------------------------------------------------- the sitting
  get isBurning() {
    return this.state === 'lighting' || this.state === 'lit';
  }
  get active() {
    return this.state !== 'off';
  }
  get remaining() {
    return Math.max(0, this.duration - this.elapsed);
  }

  ignite(minutes) {
    this.start(minutes * 60);
  }

  start(seconds) {
    this.duration = seconds;
    this.elapsed = 0;
    this.state = 'lighting';
    this.stateT = 0;
    this.group.visible = true;
    this.particles.forEach((p) => (p.alive = false));
    this.app.invalidate();
  }

  addTime(seconds) {
    if (this.isBurning) this.duration += seconds;
  }

  /** Put it out now. reason: 'snuffed' | 'closed' | 'switch' (another light takes over: no report). */
  snuff(reason = 'snuffed') {
    if (!this.isBurning && this.state !== 'guttering') return;
    this.endReason = reason;
    this.toSmoke();
  }
  stop(reason) {
    this.snuff(reason);
  }

  toSmoke() {
    this.state = 'smoke';
    this.stateT = 0;
    this.smokeEmit = 0.9;
    this.done(this.endReason || 'done');
  }

  done(reason) {
    const cb = this.onDone;
    if (cb && reason !== 'switch') cb({ reason, minutes: Math.round(this.elapsed / 60) });
    this.endReason = null;
  }

  /** A page turn moves the air. dir: +1 forward (air pushed to the right), −1 back. */
  gust(dir = 1, strength = 1) {
    if (!this.active) return;
    this.gustAmp = Math.min(1.2, Math.max(this.gustAmp, strength));
    this.gustDir = dir;
    this.gustT = this.time;
  }

  /** Stand the candle on the table beside the book (see Reader.lightLayout). */
  place(L) {
    const side = this.s.side >= 0 ? 1 : -1;
    const s = L.s;
    let z = L.nearZ + 0.8 * s; // a little toward us, clear of the shelf so its light doesn't scorch a spine
    let y = L.bottomY - 0.2 * s;
    let scale = s;
    // beside the book, moving in toward it when the screen is narrow (its dish just clear of the boards)
    const room = L.halfWAt(z) - 2.7 * s; // furthest the candle's middle may be from the screen's middle
    const off = Math.min(L.cx * side + L.edge + 3.3 * s, L.camX * side + room) - L.cx * side;
    let x = L.cx + side * off;
    if (off < L.edge + 2.5 * s) {
      // no room beside the book (a tablet held upright): stand it on the table nearer to us, below the
      // book's lower edge, so it never covers the page
      scale = s * 0.6;
      z = L.nearZ + 1.2 * s;
      y = L.bottomY - (H_FULL + FLAME_H + 0.9) * scale - 0.5 * s;
      x = L.camX + side * (L.halfWAt(z) - 3.6 * scale);
    }
    this.group.position.set(x, y, z);
    this.group.scale.setScalar(scale);
  }

  /** The warm pool its light makes on the wall behind (CSS px). */
  glow(camera, w, h) {
    if (!this.group.visible || this.size <= 0.01) return null;
    const p = this.screenFlame(camera, w, h);
    return { x: p.x, y: p.y, opacity: clamp(this.size, 0, 1) * this.flick * 0.42 * this.s.brightness, c1: 'rgba(255,176,96,0.95)', c2: 'rgba(255,150,70,0.42)', r: 30 };
  }

  // ---------------------------------------------------------------- frame
  update(dt, camera) {
    if (this.state === 'off' && this.appear <= 0 && this.dim <= 0) return false;
    this.time += dt;
    this.stateT += dt;
    const t = this.time;

    // state machine
    let sizeTarget = 0;
    let alive = 0;
    if (this.state === 'lighting') {
      this.elapsed += dt;
      // the wick catches: a quick flare, then it settles
      const k = this.stateT;
      sizeTarget = k < 0.35 ? k / 0.35 * 1.25 : 1 + 0.25 * Math.exp(-(k - 0.35) * 5);
      alive = 1;
      if (k > 1.2) {
        this.state = 'lit';
        this.stateT = 0;
      }
    } else if (this.state === 'lit') {
      this.elapsed += dt;
      sizeTarget = 1;
      alive = 1;
      if (this.elapsed >= this.duration) {
        this.state = 'guttering';
        this.stateT = 0;
      }
    } else if (this.state === 'guttering') {
      // the pool drowns the wick: the flame shrinks, sputters, goes out
      const k = clamp(this.stateT / 1.8, 0, 1);
      sizeTarget = (1 - k) * (0.75 + 0.5 * (noise1(t * 9) - 0.5)) + 0.05;
      alive = 1 - k * 0.6;
      if (k >= 1) {
        this.endReason = 'done';
        this.toSmoke();
      }
    } else if (this.state === 'smoke') {
      sizeTarget = 0;
      alive = 0;
      if (this.stateT > 4.2) {
        this.state = 'off';
        this.stateT = 0;
      }
    }
    const appearTarget = this.state === 'off' ? 0 : 1;
    this.appear += (appearTarget - this.appear) * (1 - Math.exp(-dt * (appearTarget ? 5 : 2.2)));
    if (this.state === 'off' && this.appear < 0.01) this.appear = 0;
    const dimTarget = this.state === 'off' ? 0 : this.state === 'smoke' ? 0.55 * (1 - clamp(this.stateT / 3, 0, 1)) : 1;
    this.dim += (dimTarget - this.dim) * (1 - Math.exp(-dt * (dimTarget > this.dim ? 1.6 : 1.1)));
    if (this.state === 'off' && this.dim < 0.004) this.dim = 0;
    this.size += (sizeTarget - this.size) * (1 - Math.exp(-dt * 14));

    // flicker: a free flame's ≈11 Hz pulse, slow wandering, and gusts that ring at ≈5 Hz and die away
    const amp = (this.reduced ? 0.35 : 1) * Math.min(this.s.liveliness ?? 1, this.reduced ? 0.35 : 9);
    this.gustAmp *= Math.exp(-dt / 0.9);
    const ring = this.gustAmp * Math.sin(2 * Math.PI * 5 * (t - this.gustT));
    const wander = noise1(t * 1.3) - 0.5;
    this.flick =
      1 +
      amp * (0.035 * Math.sin(2 * Math.PI * 11.2 * t + 2 * wander) + 0.12 * wander + 0.06 * (noise1(t * 4.7 + 10) - 0.5) + 0.03 * (noise1(t * 9.1 + 20) - 0.5)) -
      0.22 * this.gustAmp +
      0.12 * ring;
    this.lean = this.gustDir * this.gustAmp * 0.55 + 0.07 * amp * wander + 0.05 * ring;

    // burn down
    const progress = this.duration ? clamp(this.elapsed / this.duration, 0, 1) : 0;
    this.height = lerp(H_FULL, H_END, progress);
    const top = 0.17 + this.height;
    this.body.scale.y = this.height;
    this.glowU.uHeight.value = this.height;
    this.rim.position.y = top - 0.06;
    for (const d of this.drips) d.m.position.y = top - 0.12 - d.drop;
    this.pool.position.y = top - 0.1;
    this.wick.position.set(0, top - 0.12, 0);
    const wickTip = new THREE.Vector3(Math.sin(0.18) * 0.6, top - 0.12 + Math.cos(0.18) * 0.6, 0);
    this.ember.position.copy(wickTip);
    this.inner.position.y = -(1 - this.appear) * 1.2;

    // flame + halo
    const fs = this.size * (0.92 + 0.1 * this.flick);
    this.flame.position.set(wickTip.x - 0.02, wickTip.y - 0.38, 0);
    this.flame.scale.set(FLAME_W * Math.max(0.001, this.size) * (1 - 0.15 * this.gustAmp), FLAME_H * Math.max(0.001, fs) * (1 + 0.12 * this.gustAmp), 1);
    this.flameU.uTime.value = t;
    this.flameU.uFlick.value = this.flick;
    this.flameU.uLean.value = this.lean;
    this.flameU.uAlpha.value = clamp(this.size, 0, 1.2);
    this.flame.visible = this.size > 0.01;
    this.halo.position.set(wickTip.x, wickTip.y + FLAME_H * 0.38 * this.size, 0.2);
    this.halo.scale.set(8, 8, 1);
    this.haloU.uAlpha.value = clamp(this.size, 0, 1) * (0.8 + 0.25 * (this.flick - 1)) * 0.75;
    this.halo.visible = this.size > 0.01;
    if (camera) {
      // billboards face the camera (about their own position)
      this.flame.quaternion.copy(camera.quaternion);
      this.halo.quaternion.copy(camera.quaternion);
    }

    // light: same signal, slight drift with the flame
    const glow = clamp(this.size, 0, 1.3) * this.flick;
    this.light.intensity = LIGHT_I * glow * this.s.brightness;
    this.light.position.set(wickTip.x + this.lean * 0.25, wickTip.y + 0.9 * this.size, 0.15);
    this.glowU.uGlow.value = 1.3 * glow;
    this.rimMat.emissiveIntensity = 0.55 * glow;
    this.poolMat.emissiveIntensity = 0.75 * glow;
    this.emberMat.opacity = clamp(alive * 1.2 + (this.state === 'smoke' ? Math.max(0, 1 - this.stateT / 1.5) : 0), 0, 1);
    for (const m of this.fadeMats) m.opacity = this.appear;

    this.updateSmoke(dt, wickTip);

    if (this.state === 'off' && this.appear === 0 && !this.particles.some((p) => p.alive)) {
      this.group.visible = false;
      this.light.intensity = 0;
    }
    return true;
  }

  updateSmoke(dt, from) {
    const P = this.particles;
    if (this.smokeEmit > 0) {
      this.smokeEmit -= dt;
      const n = Math.random() < dt * 60 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const p = P.find((q) => !q.alive);
        if (!p) break;
        p.alive = true;
        p.x = from.x + (Math.random() - 0.5) * 0.06;
        p.y = from.y + 0.05;
        p.z = (Math.random() - 0.5) * 0.06;
        p.vx = (Math.random() - 0.5) * 0.12;
        p.vy = 0.9 + Math.random() * 0.5;
        p.age = 0;
        p.life = 2.6 + Math.random() * 1.6;
        p.seed = Math.random() * 100;
      }
    }
    const pos = this.smokeGeo.attributes.position.array;
    const al = this.smokeGeo.attributes.aAlpha.array;
    const sz = this.smokeGeo.attributes.aSize.array;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p.alive) {
        p.age += dt;
        if (p.age > p.life) p.alive = false;
      }
      if (!p.alive) {
        al[i] = 0;
        continue;
      }
      const a = p.age / p.life;
      // a thin rising thread that starts to curl and spread as it slows
      p.vy *= Math.exp(-dt * 0.35);
      p.vx += (noise1(p.seed + p.age * 1.7) - 0.5) * 1.4 * dt * (0.3 + a);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      al[i] = Math.pow(1 - a, 1.5) * smoothstep(0, 0.06, a) * 0.5;
      sz[i] = 0.45 + a * 2.8;
    }
    this.smokeGeo.attributes.position.needsUpdate = true;
    this.smokeGeo.attributes.aAlpha.needsUpdate = true;
    this.smokeGeo.attributes.aSize.needsUpdate = true;
  }

  /** Where the flame is on screen (CSS pixels) — for the warm pool of light on the wall. */
  screenFlame(camera, width, height) {
    const v = new THREE.Vector3(0, FLAME_H * 0.35, 0).add(this.flame.position);
    this.inner.localToWorld(v);
    v.project(camera);
    return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height };
  }
}

export const CANDLE_DIM = DIM;
export { BILLBOARD_VERT, FLAME_FRAG, GLOW_FRAG, SMOKE_VERT, SMOKE_FRAG, OVER, ADDITIVE };

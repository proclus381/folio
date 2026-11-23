// A single leaf (two pages) as a deformable sheet.
//
// The sheet's cross-section is a chain hinged at the gutter. Its angle along the width blends between
// lying on the right stack (t = 0) and lying on the left stack (t = 1), plus a bend term (tip leading or
// trailing the turn). On top of that sits an analytic developable roll — the corner curl that follows a
// drag — rolled about a tilted fold line through a pivot, applied outward from the stack only.

import * as THREE from 'three';
import { stackProfile } from './book3d.js';
import { roomUniforms, ROOM_GLSL } from './room.js';

export const NX = 44;
export const NY = 22;
const NC = 72;

// ------------------------------------------------------------------ stack surface tables
/** Angle of a stack's top surface at regular arc-length steps (what a resting leaf follows). */
export function surfaceTable(h, o, Wp) {
  const prof = stackProfile(h, o, Wp);
  const ang = new Float32Array(NC);
  const ds = Wp / NC;
  const steps = 900;
  const dx = (Wp * 1.25) / steps;
  let s = 0;
  let x = 0;
  let z = prof(0);
  let seg = 0;
  let target = 0.5 * ds;
  for (let i = 0; i < steps && seg < NC; i++) {
    const x1 = x + dx;
    const z1 = prof(x1);
    const l = Math.hypot(dx, z1 - z);
    const a = Math.atan2(z1 - z, dx);
    while (seg < NC && s + l >= target) {
      ang[seg++] = a;
      target = (seg + 0.5) * ds;
    }
    s += l;
    x = x1;
    z = z1;
  }
  while (seg < NC) ang[seg++] = 0;
  return { prof, ang, h, o };
}

// ------------------------------------------------------------------ material
const blankWhite = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();
export const clearInk = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

// The paper's look, shared by every leaf so it can be tuned in one place (and dimmed by the candle).
const RAKE_BASE = 1.8;
function paperUniforms(paper) {
  if (!paper.u)
    paper.u = {
      paperFibre: { value: paper.fibre },
      paperCockle: { value: paper.cockle },
      paperRepeat: { value: paper.repeat }, // set per book so the fibres keep their physical size
      paperTint: { value: new THREE.Color(0xe9e8e4) },
      showThrough: { value: 0.24 }, // how much the far side's print darkens this side at rest
      toothK: { value: 0.3 }, // slope of the paper's fibre streaks, fine tooth and cloud: most of what you see
      grainK: { value: 0.06 }, // a little fine grain in the paper's colour; the visible texture is relief
      mottleK: { value: 0.03 }, // the surface's streaks and cloud, faintly in its colour too
      cockleK: { value: 0.04 }, // slope of the sheet's slow waviness
      transmit: { value: 0.34 }, // diffuse transmittance of the sheet
      // the paper's type and condition (paper.js): all zero for the paper Folio always had
      paperMarks: { value: paper.marks }, // foxing spots, soil blotches, a ragged line (textures.makeMarksTexture)
      pageSize: { value: new THREE.Vector2(15, 22.6) }, // cm, so marks keep their physical size
      ageTone: { value: 0 }, // toning in from the head, tail and fore-edge
      foxK: { value: 0 }, // foxing
      laidK: { value: 0 }, // laid and chain lines (laid paper)
      deckleK: { value: 0 }, // a deckled (rough-cut) fore-edge
      pagePaper: { value: new THREE.Color(1, 1, 1) }, // a scan's own paper colour: what shows through is its ink, not that
      glossMottle: { value: 0 }, // coated paper: glossier on the coating's peaks, duller in its hollows
      wearK: { value: 0 }, // the book's wear: outer corners rounded off, edges a little greyed by hands
      // a soft second light skimming the page from the upper left (in book space), so the paper's relief
      // reads even under the flat key light; only its variation is added, the page does not get brighter
      rakeDir: { value: new THREE.Vector3(-0.55, 0.75, 0.36).normalize() },
      rakeColor: { value: new THREE.Color(1, 0.985, 0.96).multiplyScalar(RAKE_BASE) },
      rakeBase: { value: RAKE_BASE }, // the skimming light's strength in a fully lit room (not a shader input)
    };
  return paper.u;
}

/** Room light level (1 = normal, lower when the candle dims the room) for the paper's skimming light. */
export function setPaperRoomLight(paper, k) {
  const u = paperUniforms(paper);
  u.rakeColor.value.setRGB(1, 0.985, 0.96).multiplyScalar(u.rakeBase.value * k);
}

/**
 * Paper. Physically based and rough, with what makes a page read as paper rather than a screen:
 *  - show-through: the other side's print, mirrored and only slightly softened, darkens this side by ≈20 %
 *    at rest (thin book stock), more while the leaf is in the air and lit from behind; denser flocs of pulp
 *    hide a little more of it;
 *  - transmission: light reaching the far face comes through the sheet, filtered by both prints and the
 *    formation, so a lifted page glows and shows its back mirrored;
 *  - the surface: smooth, with faint fibre streaks along the grain (patchy, stronger in places) over a gentle
 *    cloudiness, from one large map per page so nothing repeats in view, and a slow cockle — it shows where
 *    the light grazes the page, near the gutter and in a curl;
 *  - formation, fibres, a fine grain and specks in the albedo; ink a little smoother than paper; edges toned;
 *  - a gutter that dives into the spine (wide shade + narrow crease) with warm light bounced off the facing page;
 *  - all texture lives on the paper and moves with it; only an invisible dither is tied to the screen.
 */
export function makePageMaterial(paper) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0,
    side: THREE.DoubleSide,
    normalMap: paper.normal, // sampled by hand below; set so three builds the tangent frame
  });
  const u = {
    ...paperUniforms(paper),
    mapFront: { value: blankWhite },
    mapBack: { value: blankWhite },
    inkFront: { value: clearInk },
    inkBack: { value: clearInk },
    paperSeed: { value: new THREE.Vector2() }, // every sheet is cut from a different part of the roll
    turnLift: { value: 0 }, // sin(π·t): 0 lying on a stack, 1 standing up
    soil: { value: 0 }, // finger soil on this leaf's outer corners (wear; per leaf when books wear as you read)
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, roomUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPageUv;\nvarying vec3 vRake;\nuniform vec3 rakeDir;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPageUv = uv;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvRake = normalize(mat3(modelViewMatrix) * rakeDir);');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${ROOM_GLSL}
uniform sampler2D mapFront;
uniform sampler2D mapBack;
uniform sampler2D inkFront;
uniform sampler2D inkBack;
uniform sampler2D paperFibre;
uniform sampler2D paperCockle;
uniform vec2 paperRepeat;
uniform vec2 paperSeed;
uniform vec3 paperTint;
uniform float showThrough;
uniform float toothK;
uniform float grainK;
uniform float mottleK;
uniform float cockleK;
uniform float turnLift;
uniform float transmit;
uniform sampler2D paperMarks;
uniform vec2 pageSize;
uniform float ageTone;
uniform float foxK;
uniform float laidK;
uniform float deckleK;
uniform vec3 pagePaper;
uniform float glossMottle;
uniform float soil;
uniform float wearK;
uniform vec3 rakeColor;
varying vec2 vPageUv;
varying vec3 vRake;
// the other side of the sheet, in its own page coordinates
vec3 folioOther(vec2 uv, float bias) {
  return gl_FrontFacing ? texture2D(mapBack, uv, bias).rgb : texture2D(mapFront, uv, bias).rgb;
}
vec4 folioOtherInk(vec2 uv) {
  return gl_FrontFacing ? texture2D(inkBack, uv) : texture2D(inkFront, uv);
}
// white noise without sin(): the sin-based hash turns into visible patterns on some mobile GPUs
float folioHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 puv = gl_FrontFacing ? vPageUv : vec2(1.0 - vPageUv.x, vPageUv.y);
vec2 ouv = vec2(1.0 - puv.x, puv.y); // this spot, seen from the other side
vec2 pcm = vPageUv * pageSize; // this spot on the sheet, in cm from the gutter's foot (the same on both faces)
// a deckled fore-edge: the sheet ends raggedly, a few tenths of a millimetre to two and a half
if (deckleK > 0.0) {
  float rag = texture2D(paperMarks, vec2(0.5, pcm.y * 0.3 + paperSeed.x)).b;
  if (pageSize.x - pcm.x < deckleK * (0.04 + 0.22 * rag)) discard;
}
// worn: paper wears away where it is handled, and the outer corners round off (up to ≈ 3.5 mm)
float wornR = wearK * 0.35;
if (wornR > 0.001) {
  vec2 cq = vec2(pageSize.x - pcm.x, min(pcm.y, pageSize.y - pcm.y));
  if (cq.x < wornR && cq.y < wornR && length(vec2(wornR) - cq) > wornR) discard;
}
// the two sides are never printed in perfect register: the far side sits ≈1–2 mm off, a hair skewed, so its
// lines fall between this side's lines instead of hiding behind them
float regX = gl_FrontFacing ? ouv.x : puv.x; // across the far (even) page
float reg = 0.004 + 0.004 * paperSeed.x + (regX - 0.5) * (paperSeed.y - 0.5) * 0.006;
vec2 sUv = ouv + vec2(0.0, gl_FrontFacing ? reg : -reg);
vec3 pg = gl_FrontFacing ? texture2D(mapFront, puv).rgb : texture2D(mapBack, puv).rgb;
vec4 ink = gl_FrontFacing ? texture2D(inkFront, puv) : texture2D(inkBack, puv);
vec4 fb = texture2D(paperFibre, vPageUv * paperRepeat * 0.5 + paperSeed);
float dens = fb.g; // formation: where the pulp flocked thicker, less gets through
// show-through: mirrored, a hair soft (light spreads a little in the sheet), subtractive — ink behind
// absorbs, it never lightens this side
vec3 ghost = 0.5 * (folioOther(sUv + vec2(0.0005, 0.0003), 0.6) + folioOther(sUv - vec2(0.0004, 0.0005), 0.6));
ghost = min(vec3(1.0), ghost / pagePaper); // a scan's yellowed paper on the far side isn't ink
vec4 oInk = folioOtherInk(sUv);
ghost *= mix(vec3(1.0), oInk.rgb, oInk.a);
ghost = mix(ghost, vec3(dot(ghost, vec3(0.2126, 0.7152, 0.0722))), 0.35); // colour is muted by the fibres
float ghostK = showThrough * (1.0 + 0.6 * turnLift) * (1.3 - 0.6 * dens);
vec3 col = pg * mix(vec3(1.0), ghost, ghostK);
col *= mix(vec3(1.0), ink.rgb, ink.a);
// the surface map's place on this face (the far face is a different part of the sheet)
vec2 folioTuv = vPageUv * paperRepeat + paperSeed + (gl_FrontFacing ? vec2(0.0) : vec2(0.53, 0.29));
// texture you can see, all on the paper so it moves and turns with the page: formation and fibres,
// a fine grain, and the surface's streaks and cloud
float grainN = texture2D(paperFibre, folioTuv * 1.4 + paperSeed * 3.1).b;
float mottle = texture2D(normalMap, folioTuv).b;
vec3 paperCol = paperTint * (0.82 + 0.36 * fb.r) * (1.0 + (grainN - 0.5) * grainK + (mottle - 0.46) * mottleK);
col *= paperCol;
float folioLum = dot(pg, vec3(0.2126, 0.7152, 0.0722));
// the gutter: a wide shade and a narrow crease where the sheet dives into the spine
float sc = vPageUv.x;
float gBand = 1.0 - smoothstep(0.0, 0.14, sc);
float gCore = 1.0 - smoothstep(0.0, 0.045, sc);
float gShade = min(0.6, 0.2 * gBand * gBand + 0.36 * gCore * gCore * gCore);
col *= 1.0 - gShade;
// a faint shade along the fore-edge, where the sheet turns away from the light
col *= mix(0.92, 1.0, smoothstep(1.0, 0.965, sc));
// edges a touch toned, as paper ages from the outside in
float eD = min(1.0 - sc, min(vPageUv.y, 1.0 - vPageUv.y));
col *= mix(vec3(0.955, 0.94, 0.9), vec3(1.0), smoothstep(0.0, 0.035, eD));
// age and use (paper.js). Marks are this face's own (the far face is another part of the sheet).
vec4 mk = texture2D(paperMarks, pcm * 0.1 + paperSeed * 7.0 + (gl_FrontFacing ? vec2(0.0) : vec2(0.37, 0.61)));
float edgeCm = min(pageSize.x - pcm.x, min(pcm.y, pageSize.y - pcm.y)); // to the head, tail or fore-edge; never the gutter
// toning: light and air brown the exposed edges first, in an uneven band a centimetre or three deep
float band = 1.0 - smoothstep(0.0, 1.2 + 1.8 * mk.g, edgeCm);
col *= mix(vec3(1.0), vec3(0.86, 0.71, 0.5), ageTone * band * band);
// foxing: reddish-brown spots, thicker toward the edges
float fox = smoothstep(0.2, 0.85, mk.r) * foxK * mix(0.4, 1.0, 1.0 - smoothstep(0.0, 4.0, edgeCm));
col *= mix(vec3(1.0), vec3(0.74, 0.55, 0.38), min(1.0, fox));
// finger soil where pages are turned: the lower outer corner most, the upper a little
float cLo = length(vec2((pageSize.x - pcm.x) * 0.8, pcm.y));
float cHi = length(vec2((pageSize.x - pcm.x) * 0.9, pageSize.y - pcm.y));
// (stronger than before, when it hardly showed: a well-thumbed corner is plainly grey-brown) and along the
// fore-edge margin, low down, where fingers slide to turn
float foreM = 1.0 - smoothstep(0.0, 1.6, pageSize.x - pcm.x);
float lowMid = exp(-pow((pcm.y / pageSize.y - 0.3) / 0.25, 2.0));
float thumb = (1.0 - smoothstep(0.0, 6.0, cLo)) + 0.45 * (1.0 - smoothstep(0.0, 4.0, cHi)) + 0.35 * foreM * lowMid;
float soilK = clamp(soil * thumb * (0.35 + 1.3 * mk.g), 0.0, 1.0);
col *= mix(vec3(1.0), vec3(0.78, 0.74, 0.68), soilK * 0.75);
// handled edges go a little grey and soft
col *= 1.0 - 0.07 * wearK * (1.0 - smoothstep(0.0, 0.3, edgeCm));
// laid paper: laid lines ≈ 1 mm apart across the sheet, chain lines ≈ 2.5 cm apart along it. The pulp is
// thinner over the wires, so both show lighter in light through the sheet (and a breath darker on it). Lines
// finer than the screen can draw fade out rather than shimmer.
float laidT = 0.0;
float chainT = 0.0;
if (laidK > 0.0) {
  float lf = pcm.y * 9.0;
  laidT = (abs(fract(lf) - 0.5) * 2.0 - 0.5) * (1.0 - smoothstep(0.15, 0.35, fwidth(lf)));
  float cf = pcm.x / 2.5 + 0.31;
  float cd = abs(fract(cf) - 0.5);
  chainT = 1.0 - smoothstep(0.012, 0.012 + max(0.012, fwidth(cf)), cd);
  col *= 1.0 - laidK * (0.012 * laidT + 0.02 * chainT);
}
diffuseColor.rgb *= col;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness * mix(0.74, 1.0, smoothstep(0.12, 0.6, folioLum)); // ink is a touch smoother
roughnessFactor *= 1.0 - glossMottle * (texture2D(normalMap, folioTuv).b - 0.5) * 1.4;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 folioN0 = normal;
{
  // fibres (the far face is a different part of the sheet) + cockle (the same swell, seen from behind)
  float asp = paperRepeat.y / paperRepeat.x;
  vec2 tg = texture2D(normalMap, folioTuv).xy * 2.0 - 1.0;
  vec2 cg = texture2D(paperCockle, vPageUv * vec2(0.8, 0.8 * asp) + paperSeed.yx).xy * 2.0 - 1.0;
  if (!gl_FrontFacing) cg = -cg;
  vec2 g = tg * toothK + cg * cockleK;
  if (laidK > 0.0) {
    // laid paper's ribs: soft ridges ≈ 1 mm apart, faded where they'd be finer than the screen can draw
    float lf2 = pcm.y * 9.0;
    g.y += laidK * 0.14 * sin(6.2831853 * lf2) * (1.0 - smoothstep(0.15, 0.35, fwidth(lf2)));
    g.x += laidK * 0.1 * chainT * sign(fract(pcm.x / 2.5 + 0.31) - 0.5);
  }
  g *= vec2(max(1.0, 1.0 / asp), max(1.0, asp)); // three's tangent frame is scaled per uv unit; the maps are square in paper
  normal = normalize(tbn * vec3(g, 1.0));
}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  // light arriving on the far face comes through the sheet
  vec3 tN = folioN0;
  vec3 tLight = vec3(0.0);
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    tLight += directionalLights[ i ].color * max(0.0, -dot(tN, directionalLights[ i ].direction));
  }
  #pragma unroll_loop_end
  #endif
  #if NUM_POINT_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    vec3 tlv = pointLights[ i ].position - geometryPosition;
    float tld = length(tlv);
    tLight += pointLights[ i ].color * getDistanceAttenuation(tld, pointLights[ i ].distance, pointLights[ i ].decay) * max(0.0, -dot(tN, tlv / tld));
  }
  #pragma unroll_loop_end
  #endif
  vec3 back = 0.5 * (folioOther(sUv + vec2(0.0006, 0.0004), 0.8) + folioOther(sUv - vec2(0.0005, 0.0006), 0.8));
  back = min(vec3(1.0), back / pagePaper);
  vec3 thru = paperCol * pg * back * mix(vec3(1.0), oInk.rgb, oInk.a) * (1.0 - gShade) * (1.3 - 0.6 * dens);
  thru *= 1.0 + laidK * (0.1 * laidT + 0.3 * chainT);
  reflectedLight.directDiffuse += tLight * thru * (transmit * RECIPROCAL_PI);
  // the skimming light: only the relief it picks out
  vec3 R = normalize(vRake);
  float rFace = dot(tN, R);
  reflectedLight.directDiffuse += material.diffuseColor * rakeColor * ((dot(normal, R) - rFace) * smoothstep(-0.15, 0.2, rFace) * RECIPROCAL_PI);
  // warm light bounced off the facing page into the gutter, more where the sheet curls away from view
  float curlLift = pow(clamp(1.0 - abs(dot(tN, geometryViewDir)), 0.0, 1.0), 1.5);
  float gFall = pow(1.0 - smoothstep(0.0, 0.23, sc), 0.85);
  reflectedLight.indirectDiffuse += (reflectedLight.directDiffuse + reflectedLight.indirectDiffuse) * vec3(1.0, 0.96, 0.92) * gFall * (0.8 + 0.6 * curlLift) * 0.16;
  // a glossy (coated) paper mirrors the room a little; a matte one (roughness ≥ 0.7, book wove's 0.9) not at all
  float roomGloss = smoothstep(0.7, 0.3, material.roughness);
  if (roomGloss > 0.0) {
    vec3 rw = (vec4(reflect(-geometryViewDir, normal), 0.0) * viewMatrix).xyz;
    reflectedLight.indirectSpecular += roomGloss * (1.0 - gShade) * folioRoomEnv(rw, material.roughness)
      * EnvironmentBRDF(normal, geometryViewDir, material.specularColor, material.specularF90, material.roughness);
  }
}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  // Dither by half a step of the 8-bit output, so dim gradients (candlelight, the gutter) don't band.
  // It lives on the screen, not the paper, so it must stay below what the eye can see: anything
  // stronger reads as a film over the screen that the pages slide under.
  outgoingLight += (folioHash(gl_FragCoord.xy) - 0.5) / 255.0;
}
#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'folio-paper-14';
  return mat;
}

// ------------------------------------------------------------------ leaf
const chainX = new Float32Array(NC + 1);
const chainZ = new Float32Array(NC + 1);
const chainTX = new Float32Array(NC + 1);
const chainTZ = new Float32Array(NC + 1);
let rollAlong = new Float32Array(512);
let rollOut = new Float32Array(512);

export class Leaf {
  constructor(material) {
    const nv = (NX + 1) * (NY + 1);
    this.pos = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const idx = [];
    for (let j = 0; j <= NY; j++)
      for (let i = 0; i <= NX; i++) {
        const k = j * (NX + 1) + i;
        uv[k * 2] = i / NX;
        uv[k * 2 + 1] = j / NY;
      }
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const a = j * (NX + 1) + i;
        const b = a + 1;
        const c = a + NX + 1;
        const d = c + 1;
        idx.push(a, b, d, a, d, c);
      }
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setIndex(idx);
    this.geometry = g;
    this.material = material;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.leaf = this;

    this.k = -1; // leaf index in the book
    this.t = 0; // 0 resting right … 1 resting left
    this.bend = 0; // + tip leads the turn, − tip trails
    this.eps = 0.01; // layer lift above the stack
    this.curl = { amount: 0, power: 0.86, span: 32.4, angle: 0, pivotU: 0.74, pivotV: 0.5 };
    this.sig = '';
  }

  setPages(front, back, inkFront, inkBack) {
    const u = this.material.userData.u;
    u.mapFront.value = front || blankWhite;
    u.mapBack.value = back || blankWhite;
    u.inkFront.value = inkFront || clearInk;
    u.inkBack.value = inkBack || clearInk;
    const k = Math.max(0, this.k);
    u.paperSeed.value.set((k * 0.6180339) % 1, (k * 0.4142136 + 0.37) % 1);
  }

  /** Recompute the sheet. env: { Wp, Hp, tabR, tabL } */
  deform(env, force = false) {
    const c = this.curl;
    const sig = `${this.t.toFixed(5)}|${this.bend.toFixed(4)}|${this.eps}|${c.amount.toFixed(4)}|${c.angle.toFixed(4)}|${c.pivotU}|${c.pivotV}|${env.tabR.h.toFixed(5)}|${env.tabR.o.toFixed(4)}|${env.tabL.h.toFixed(5)}`;
    if (!force && sig === this.sig) return false;
    this.sig = sig;
    this.material.userData.u.turnLift.value = Math.sin(Math.PI * Math.min(1, Math.max(0, this.t)));
    const { Wp, Hp, tabR, tabL } = env;
    const t = this.t;
    const ds = Wp / NC;
    let x = 0;
    let z = (1 - t) * tabR.prof(0) + t * tabL.prof(0) + this.eps;
    chainX[0] = x;
    chainZ[0] = z;
    for (let i = 0; i < NC; i++) {
      const s = (i + 0.5) / NC;
      let a = (1 - t) * tabR.ang[i] + t * (Math.PI - tabL.ang[i]);
      a += this.bend * Math.pow(s, 1.6);
      x += ds * Math.cos(a);
      z += ds * Math.sin(a);
      const floor = (x >= 0 ? tabR.prof(x) : tabL.prof(-x)) + this.eps;
      if (z < floor) z = floor;
      chainX[i + 1] = x;
      chainZ[i + 1] = z;
    }
    for (let i = 0; i <= NC; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(NC, i + 1);
      let tx = chainX[b] - chainX[a];
      let tz = chainZ[b] - chainZ[a];
      const l = Math.hypot(tx, tz) || 1;
      chainTX[i] = tx / l;
      chainTZ[i] = tz / l;
    }
    const lift = t < 0.5 ? 1 : -1;

    // roll table
    const curling = c.amount > 0.002;
    let step = 1;
    let dxr = 1;
    let dyr = 0;
    let px = 0;
    let py = 0;
    if (curling) {
      step = c.span / 64;
      const maxXi = Math.hypot(Wp, Hp) + step * 2;
      const n = Math.ceil(maxXi / step) + 2;
      if (rollAlong.length < n + 1) {
        rollAlong = new Float32Array(n + 1);
        rollOut = new Float32Array(n + 1);
      }
      rollAlong[0] = 0;
      rollOut[0] = 0;
      for (let k = 1; k <= n; k++) {
        const sm = (k - 0.5) * step;
        const a = Math.min(c.amount * Math.pow(sm / c.span, c.power), Math.PI);
        rollAlong[k] = rollAlong[k - 1] + Math.cos(a) * step;
        rollOut[k] = rollOut[k - 1] + Math.sin(a) * step;
      }
      dxr = Math.cos(c.angle);
      dyr = Math.sin(c.angle);
      px = c.pivotU * Wp;
      py = (c.pivotV - 0.5) * Hp;
    }

    const P = this.pos;
    let v = 0;
    for (let j = 0; j <= NY; j++) {
      const y0 = (j / NY - 0.5) * Hp;
      for (let i = 0; i <= NX; i++) {
        const x0 = (i / NX) * Wp;
        let xl = x0;
        let yl = y0;
        let out = 0;
        if (curling) {
          const xi = (x0 - px) * dxr + (y0 - py) * dyr;
          if (xi > 0) {
            const f = xi / step;
            const k0 = Math.floor(f);
            const fr = f - k0;
            const along = rollAlong[k0] + (rollAlong[k0 + 1] - rollAlong[k0]) * fr;
            out = rollOut[k0] + (rollOut[k0 + 1] - rollOut[k0]) * fr;
            xl = x0 + dxr * (along - xi);
            yl = y0 + dyr * (along - xi);
          }
        }
        // base chain at xl
        let f = (xl / Wp) * NC;
        if (f < 0) f = 0;
        if (f > NC) f = NC;
        const i0 = Math.min(NC - 1, Math.floor(f));
        const fr = f - i0;
        const bx = chainX[i0] + (chainX[i0 + 1] - chainX[i0]) * fr;
        const bz = chainZ[i0] + (chainZ[i0 + 1] - chainZ[i0]) * fr;
        const tx = chainTX[i0] + (chainTX[i0 + 1] - chainTX[i0]) * fr;
        const tz = chainTZ[i0] + (chainTZ[i0 + 1] - chainTZ[i0]) * fr;
        const nx = -tz * lift;
        const nz = tx * lift;
        P[v++] = bx + nx * out;
        P[v++] = yl;
        P[v++] = bz + nz * out;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    return true;
  }
}

// Book bindings: cloth or leather over the boards and spine, with titles and decorations stamped into it.
//
// One material does it all. The surface (weave or pebble grain) comes from a tiled slope + detail map
// (textures.makeBindingTextures) sampled in book units, so a thread or a pebble has the same size on every
// face. The cover/spine artwork texture carries the stamp mask in its alpha: inside a stamp the grain is
// pressed nearly flat, the walls of the impression dip toward the letter, and the foil is metal when it is
// gold or copper (decided from its colour) or a semi-gloss pigment otherwise. A soft room is reflected in
// glossy spots, so foil reads as metal and leather has its sheen without an environment map, and a faint
// skimming light picks out the grain the way it shows on a real book held under a lamp.

import * as THREE from 'three';
import { makeBindingTextures } from './textures.js';
import { roomUniforms, ROOM_GLSL } from './room.js';

export const BINDINGS = {
  // normal strength, albedo variation, base roughness, roughness variation, edge wear
  cloth: { label: 'Cloth', normal: 0.62, albedo: 1, rough: 0.84, roughVar: 0.22, wear: 0.45 },
  leather: { label: 'Leather', normal: 0.55, albedo: 1, rough: 0.5, roughVar: 0.32, wear: 0.65 },
};
export const bindingKind = (look) => (look && BINDINGS[look.material] ? look.material : 'cloth');

/** What new books are bound in (the last "use for all books" choice). */
export function defaultBinding() {
  try {
    const k = localStorage.getItem('folio.binding');
    return BINDINGS[k] ? k : 'cloth';
  } catch {
    return 'cloth';
  }
}
export function setDefaultBinding(kind) {
  try {
    localStorage.setItem('folio.binding', kind);
  } catch {
    /* not remembered */
  }
}

const kinds = new Map();
function kindTextures(kind) {
  if (!kinds.has(kind)) {
    // drawn here at once, then replaced by the maps baked in Blender when they have loaded
    const kt = makeBindingTextures(kind);
    kinds.set(kind, kt);
    if (BAKED[kind]) loadBaked(kt, BAKED[kind]);
  }
  return kinds.get(kind);
}

// Bindings modelled thread by thread in Blender (tools/blender/weave.py) and rendered into the same two maps,
// in the same layout and tile, as makeBindingTextures draws them.
const BAKED = {
  cloth: { slope: 'assets/bindings/cloth-slope.png', detail: 'assets/bindings/cloth-detail.png' },
};
const bakedListeners = [];
/** Call `fn` when baked binding maps arrive (the scene should be drawn again). */
export function onBindingMapsLoaded(fn) {
  bakedListeners.push(fn);
}
async function loadBaked(kt, urls) {
  try {
    const load = async (url) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    };
    const [slope, detail] = await Promise.all([load(urls.slope), load(urls.detail)]);
    for (const [tex, img] of [
      [kt.slope, slope],
      [kt.detail, detail],
    ]) {
      tex.dispose(); // (a new image into an uploaded texture needs fresh storage)
      tex.image = img;
      tex.needsUpdate = true;
    }
    for (const fn of bakedListeners) fn();
  } catch {
    /* the drawn cloth stays */
  }
}

// shared by every binding: the room's light level (a burning candle dims it)
const shared = {
  roomLight: { value: 1 },
  bindRake: { value: 0.55 },
};
export function setBindingRoomLight(k) {
  shared.roomLight.value = k;
  shared.bindRake.value = 0.55 * k;
}

/**
 * @param kind   'cloth' | 'leather'
 * @param color  binding colour (multiplies the map, if any)
 * @param faceW, faceH  size of the face its UVs span, in book units (for the grain's scale)
 * @param groove u of the hinge groove on this face (−1: none)
 * @param wear   rub the edges of this face
 */
export function makeBindingMaterial({ kind = 'cloth', color = 0xffffff, faceW = 16, faceH = 24, groove = -1, wear = true } = {}) {
  const kt = kindTextures(kind);
  const P = BINDINGS[kind];
  const mat = new THREE.MeshStandardMaterial({ color, roughness: P.rough, metalness: 0, normalMap: kt.slope });
  const u = {
    ...shared,
    bindDetail: { value: kt.detail },
    bindRepeat: { value: new THREE.Vector2(faceW / kt.tile, faceH / kt.tile) },
    bindParams: { value: new THREE.Vector4(P.normal, P.albedo, P.rough, P.roughVar) },
    bindWear: { value: wear ? P.wear : 0 },
    bindGroove: { value: groove },
    mapTexel: { value: new THREE.Vector2(1 / 768, 1 / 1024) },
  };
  mat.userData.u = u;
  mat.userData.kind = kind;
  mat.userData.face = [faceW, faceH];
  mat.userData.wear = wear;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, roomUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBindUv;\nattribute float folioOcc;\nvarying float vBindOcc;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvBindUv = uv;\nvBindOcc = folioOcc;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D bindDetail;
uniform vec2 bindRepeat;
uniform vec4 bindParams;
uniform float bindWear;
uniform float bindGroove;
uniform vec2 mapTexel;
uniform float roomLight;
uniform float bindRake;
varying vec2 vBindUv;
// the spine's own folds (groove, caps, hollow), baked in Blender; 0 where a mesh doesn't say
varying float vBindOcc;
// the room it reflects (room.js: modelled in Blender)
${ROOM_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 buv = vBindUv * bindRepeat;
vec4 bd = texture2D(bindDetail, buv);
float stamp = 0.0;
float foilMetal = 0.0;
vec2 sg = vec2(0.0);
#ifdef USE_MAP
{
  vec4 mc = texture2D(map, vMapUv);
  diffuseColor.rgb *= mc.rgb;
  stamp = mc.a;
  vec2 e = mapTexel * 1.5;
  sg = vec2(texture2D(map, vMapUv + vec2(e.x, 0.0)).a - texture2D(map, vMapUv - vec2(e.x, 0.0)).a,
            texture2D(map, vMapUv + vec2(0.0, e.y)).a - texture2D(map, vMapUv - vec2(0.0, e.y)).a);
  // gold or copper foil is metal; anything else is a pigment foil
  vec3 lc = mc.rgb;
  foilMetal = smoothstep(0.18, 0.32, lc.r) * step(lc.g * 1.2, lc.r) * step(lc.b * 1.5, lc.g);
}
#endif
float metal = stamp * foilMetal;
// foil is brighter than any ink can show it: lift its reflectance toward real gold
diffuseColor.rgb = mix(diffuseColor.rgb, min(diffuseColor.rgb * 1.35, vec3(1.0)), metal);
// the binding's own colour variation; inside a stamp the grain is pressed out of it
diffuseColor.rgb *= mix(1.0, 0.55 + 0.9 * bd.r, bindParams.y * (1.0 - 0.8 * stamp));
// the walls of an impression catch less light
diffuseColor.rgb *= 1.0 - 0.3 * clamp(length(sg) * 1.4, 0.0, 1.0);
// the hinge groove a few millimetres in from the spine
float gT = bindGroove >= 0.0 ? (vBindUv.x - bindGroove) / 0.011 : 9.0;
diffuseColor.rgb *= 1.0 - 0.14 * exp(-gT * gT);
// edges and corners rubbed paler where the grain stands proud
float bEdge = min(min(vBindUv.x, 1.0 - vBindUv.x), min(vBindUv.y, 1.0 - vBindUv.y));
float bWear = bindWear * (1.0 - smoothstep(0.0, 0.016, bEdge)) * smoothstep(0.4, 0.8, bd.b) * (1.0 - stamp);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.3 + 0.035, bWear);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = clamp(bindParams.z + (bd.g - 0.5) * bindParams.w * 2.0 - bWear * 0.15, 0.18, 1.0);
roughnessFactor = mix(roughnessFactor, mix(0.46, 0.28, foilMetal), stamp);`,
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metal * 0.95;')
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 bindN0 = normal;
{
  vec2 g = (texture2D(normalMap, buv).xy * 2.0 - 1.0) * bindParams.x * (1.0 - 0.72 * stamp);
  g += sg * 1.5; // pressed in: the surface dips toward the inside of every letter
  g.x += -2.0 * gT * exp(-gT * gT) * 0.35;
  float ar = bindRepeat.y / bindRepeat.x; // three's tangent frame is scaled per uv unit
  g *= vec2(max(1.0, 1.0 / ar), max(1.0, ar));
  normal = normalize(tbn * vec3(g, 1.0));
}`,
      )
      .replace(
        '#include <lights_fragment_begin>',
        `// The key light is large and sits nearly behind the camera: a glossy binding would mirror it back as a
// grey veil over its colour. Lights see a broader, weaker lobe on cloth and leather (foil keeps its own);
// the binding's real gloss still shows in the room it reflects (below).
float bindRoughEnv = material.roughness;
material.roughness = max(material.roughness, mix(0.74, 0.0, metal));
material.specularColor *= mix(0.6, 1.0, metal);
#include <lights_fragment_begin>`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  // the room's light reaches into a fold only partly, the key light a little less too
  float bindAO = 1.0 - vBindOcc;
  reflectedLight.indirectDiffuse *= bindAO;
  reflectedLight.directDiffuse *= mix(1.0, bindAO, 0.45);
  reflectedLight.directSpecular *= bindAO;
}
{
  // the room in glossy spots (foil, leather), with the right Fresnel and roughness
  vec3 rv = reflect(-geometryViewDir, normal);
  vec3 rw = (vec4(rv, 0.0) * viewMatrix).xyz; // into the world, where the room is
  // (dielectrics only a little of it: the scene's ambient already stands for most of the room's light)
  vec3 env = folioRoomEnv(rw, bindRoughEnv) * mix(0.3, 1.3, metal) * (1.0 - vBindOcc);
  reflectedLight.indirectSpecular += env * EnvironmentBRDF(normal, geometryViewDir, material.specularColor, material.specularF90, bindRoughEnv);
  // a faint light skimming from the upper left: only the relief it picks out
  vec3 R = normalize(vec3(-0.62, 0.62, 0.48));
  reflectedLight.directDiffuse += material.diffuseColor * bindRake * (dot(normal, R) - dot(bindN0, R)) * RECIPROCAL_PI * 2.0;
  // …and the glints it puts on the grain's tops (how a dark leather shows its pebbles)
  vec3 Hr = normalize(R + geometryViewDir);
  float a2 = pow4(max(bindRoughEnv, 0.08));
  float shin = 2.0 / a2 - 2.0;
  float sp = (pow(max(dot(normal, Hr), 0.0), shin) - pow(max(dot(bindN0, Hr), 0.0), shin)) * (shin + 2.0) / 8.0;
  reflectedLight.directSpecular += material.specularColor * sp * bindRake * 5.0;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'folio-binding-3';
  return mat;
}

/** Put a material into cloth or leather. */
export function setBindingKind(mat, kind) {
  const u = mat.userData.u;
  if (!u || mat.userData.kind === kind) return;
  const kt = kindTextures(kind);
  const P = BINDINGS[kind];
  mat.userData.kind = kind;
  mat.normalMap = kt.slope;
  mat.roughness = P.rough;
  u.bindDetail.value = kt.detail;
  const [w, h] = mat.userData.face;
  u.bindRepeat.value.set(w / kt.tile, h / kt.tile);
  u.bindParams.value.set(P.normal, P.albedo, P.rough, P.roughVar);
  u.bindWear.value = mat.userData.wear ? P.wear : 0;
}

/** Set (or clear) the artwork + stamp texture of a binding material. */
export function setBindingArt(mat, tex) {
  const had = !!mat.map;
  mat.map = tex || null;
  if (tex && tex.image) mat.userData.u.mapTexel.value.set(1 / tex.image.width, 1 / tex.image.height);
  if (had !== !!tex) mat.needsUpdate = true;
}

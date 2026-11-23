// The room the books reflect: a reading room modelled and rendered in Blender (tools/blender/room.py), seen
// from where a book lies, blurred for five roughnesses and packed into one image (assets/room/room.png):
//   five equirectangular levels stacked top to bottom, roughness 0.2, 0.35, 0.5, 0.7, 0.9; each 256 × 128,
//   u round the horizon from behind the book (−z) through +x, v from straight up to straight down;
//   brightness stored as 1 − exp(−L / 2), so the window and the lamp keep their punch in 8 bits.
// Glossy surfaces look it up with `folioRoomEnv(direction in world space, roughness)`. Until it has loaded
// (or if it can't), a drawn stand-in answers: a bright ceiling, a darker floor, a window up to the left.

import * as THREE from 'three';

export const roomUniforms = {
  roomMap: { value: null },
  roomReady: { value: 0 },
  roomLevel: { value: 1 }, // the room's own light (a candle-lit evening dims it)
};

/** GLSL: put after <common>; needs the uniforms above. */
export const ROOM_GLSL = `
uniform sampler2D roomMap;
uniform float roomReady;
uniform float roomLevel;
vec3 folioRoomDrawn(vec3 r, float rough) {
  vec3 c = mix(vec3(0.2, 0.19, 0.18), vec3(1.1, 1.08, 1.05), smoothstep(-0.5, 0.6, r.y));
  c += vec3(0.55, 0.53, 0.5) * pow(max(0.0, dot(r, normalize(vec3(-0.45, 0.55, 0.7)))), 8.0) * (1.0 - rough);
  return mix(c, vec3(0.55), rough * 0.65);
}
vec3 folioRoomLevel(vec2 uv, float level) {
  // (texture rows run bottom-up: the sharpest level is the top fifth)
  float y = clamp(uv.y, 0.5 / 128.0, 1.0 - 0.5 / 128.0);
  vec3 c = texture2D(roomMap, vec2(uv.x, 1.0 - (level + y) / 5.0)).rgb;
  return -2.0 * log(max(vec3(1.0 / 255.0), 1.0 - c));
}
// r: a world-space direction; rough: the surface's roughness
vec3 folioRoomEnv(vec3 r, float rough) {
  if (roomReady < 0.5) return folioRoomDrawn(r, rough) * roomLevel;
  vec3 d = normalize(r);
  vec2 uv = vec2(atan(d.x, d.z) / 6.2831853 + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.14159265);
  float lv = clamp((rough - 0.2) / 0.7 * 4.0, 0.0, 4.0);
  float l0 = floor(lv);
  float l1 = min(4.0, l0 + 1.0);
  return mix(folioRoomLevel(uv, l0), folioRoomLevel(uv, l1), lv - l0) * roomLevel;
}
`;

const listeners = [];
/** Call `fn` when the room has loaded (the scene should be drawn again). */
export function onRoomLoaded(fn) {
  listeners.push(fn);
}

let started = false;
/** Load the room once. */
export function loadRoom(url = 'assets/room/room.png') {
  if (started) return;
  started = true;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  img
    .decode()
    .then(() => {
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.NoColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearFilter; // (the levels are its own mipmaps)
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      roomUniforms.roomMap.value = t;
      roomUniforms.roomReady.value = 1;
      for (const fn of listeners) fn();
    })
    .catch(() => {
      /* the drawn room stays */
    });
}

/**
 * Let a plain MeshStandardMaterial (gilt edges, glass) reflect the room: its glossy reflection, by its own
 * roughness and metalness, times `strength`. (Its diffuse light stays the scene's.)
 */
export function reflectRoom(mat, strength = 1, key = 'room') {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    Object.assign(shader.uniforms, roomUniforms, { roomStrength: { value: strength } });
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float roomStrength;\n' + ROOM_GLSL).replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
{
  vec3 rw = (vec4(reflect(-geometryViewDir, normal), 0.0) * viewMatrix).xyz;
  reflectedLight.indirectSpecular += roomStrength * folioRoomEnv(rw, material.roughness)
    * EnvironmentBRDF(normal, geometryViewDir, material.specularColor, material.specularF90, material.roughness);
}`,
    );
  };
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  mat.customProgramCacheKey = () => prevKey() + '|' + key;
  return mat;
}

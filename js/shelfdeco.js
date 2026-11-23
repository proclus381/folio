// The furniture of the shelf: the plank the books stand on (painted, oak or glass, or none), and the labels — little brass label holders on the plank's edge that name a section
// (like the strips on a library's shelves) or a whole shelf of the bookcase.

import * as THREE from 'three';
import { FONTS } from './textures.js';
import { reflectRoom } from './room.js';

export const PLANK_STYLES = [
  { key: 'none', label: 'None' },
  { key: 'painted', label: 'Painted' },
  { key: 'oak', label: 'Oak' },
  { key: 'glass', label: 'Glass' },
];
export const PLANK_T = 1.3; // thickness (world units)

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ------------------------------------------------------------------ oak
let oakCache = null;
/** Quarter-sawn oak along the plank: long grain lines, a few rays, warm and matte. Tileable along x. */
function oakTexture() {
  if (oakCache) return oakCache;
  const W = 1024;
  const H = 256;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lines = Array.from({ length: 34 }, () => ({ y: rnd() * H, a: 0.4 + rnd() * 0.6, f: 1 + Math.floor(rnd() * 3), p: rnd() * 6.28, w: 0.6 + rnd() * 1.6 }));
  const rays = Array.from({ length: 22 }, () => ({ x: rnd() * W, y: rnd() * H, l: 20 + rnd() * 70, h: 1 + rnd() * 2 }));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (const L of lines) {
        const yy = L.y + Math.sin((x / W) * Math.PI * 2 * L.f + L.p) * 6;
        const d = Math.abs(((y - yy + H * 1.5) % H) - H / 2) - H / 2;
        v += L.a * Math.exp(-(d * d) / (L.w * L.w * 2));
      }
      for (const R of rays) {
        const dx = (((x - R.x) % W) + W) % W;
        if (dx < R.l && Math.abs(y - R.y) < R.h) v -= 0.35 * Math.sin((dx / R.l) * Math.PI);
      }
      const t = Math.max(0, Math.min(1, 0.5 + v * 0.25 + (rnd() - 0.5) * 0.06));
      const i = (y * W + x) * 4;
      img.data[i] = 176 - 52 * t;
      img.data[i + 1] = 134 - 46 * t;
      img.data[i + 2] = 92 - 36 * t;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  oakCache = t;
  return t;
}

/** Materials [top/bottom, front/back, ends] for a plank style; null for 'none'. */
export function plankMaterial(style, dark) {
  if (style === 'oak') {
    const tex = oakTexture();
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0 });
    m.map.repeat.set(6, 1);
    return m;
  }
  if (style === 'glass')
    // (glass mirrors the room at grazing angles: room.js)
    return reflectRoom(new THREE.MeshStandardMaterial({ color: 0xd9ece4, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.42, depthWrite: false }), 1.6, 'glass');
  if (style === 'painted') return new THREE.MeshStandardMaterial({ color: dark ? 0x26241f : 0xdcd8cc, roughness: 0.74, metalness: 0 });
  return null;
}

/** A plank, very wide (it reaches past the screen's edges), its top at y = 0, spanning z0 (back) … z1 (front). */
export function makePlank(style, dark, z0, z1) {
  const mat = plankMaterial(style, dark);
  if (!mat) return null;
  const g = new THREE.Group();
  const depth = z1 - z0;
  const W = 600;
  const t = style === 'glass' ? 0.36 : PLANK_T;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(W, t, depth), mat);
  mesh.position.set(0, -t / 2, (z0 + z1) / 2);
  mesh.receiveShadow = true;
  mesh.castShadow = style !== 'glass';
  if (style === 'glass') mesh.renderOrder = 2;
  g.add(mesh);
  g.userData.mats = [mat];
  if (style === 'glass') {
    // a pale green edge, and brass brackets under it
    const edge = new THREE.MeshStandardMaterial({ color: 0x9fc4b4, roughness: 0.1, transparent: true, opacity: 0.85 });
    const lip = new THREE.Mesh(new THREE.BoxGeometry(W, t, 0.06), edge);
    lip.position.set(0, -t / 2, z1 - 0.03);
    g.add(lip);
    const brass = new THREE.MeshStandardMaterial({ color: 0xa47e3f, metalness: 0.75, roughness: 0.35 });
    for (const x of [-34, 34]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.2, depth * 0.8), brass);
      b.position.set(x, -t - 1.1, z0 + depth * 0.45);
      b.castShadow = true;
      g.add(b);
    }
    g.userData.mats.push(edge, brass);
  }
  g.userData.thickness = t;
  return g;
}

// ------------------------------------------------------------------ labels
/**
 * What a label says: for a folder's section only its own name ("3_Commentaries / Protagoras" → "Protagoras"),
 * without the number that orders it or underscores; the shelf behind it already says the rest.
 */
export function labelText(name) {
  const last = String(name || '').split(' / ').pop();
  return last.replace(/^\d+[\s._-]+/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || last;
}

/**
 * A brass label holder with a paper card: `text` in mono caps. Returns a mesh facing +z, its height `h`
 * world units, centred on its origin; userData.width is its width.
 */
export function makeLabel(text, h, { strong = false } = {}) {
  const t = text.toUpperCase();
  const px = 96; // canvas pixels per world unit of height
  const H = Math.round(h * px);
  const probe = canvas(8, 8).getContext('2d');
  const fs = Math.round(H * (strong ? 0.5 : 0.46));
  // the app's own mono, as its buttons set it: IBM Plex Mono 400, caps, 0.04em apart
  const font = `400 ${fs}px ${FONTS.mono}`;
  const spacing = fs * 0.04;
  probe.font = font;
  const tw = probe.measureText(t).width + spacing * t.length;
  const frame = Math.max(3, Math.round(H * 0.12));
  const W = Math.ceil(Math.max(tw + H * 0.9 + frame * 2, H * 2.2)); // a single letter still gets a proper tab
  const c = canvas(W * 2, H * 2);
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  // brass frame
  ctx.fillStyle = '#8f6f37';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#b38c4a';
  ctx.fillRect(1, 1, W - 2, H * 0.45);
  // card
  ctx.fillStyle = '#efe8d6';
  ctx.fillRect(frame, frame, W - 2 * frame, H - 2 * frame);
  ctx.fillStyle = 'rgba(60,40,10,0.2)';
  ctx.fillRect(frame, frame, W - 2 * frame, Math.max(1, frame * 0.35));
  ctx.fillStyle = '#2b2723';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing.toFixed(1)}px`;
  ctx.fillText(t, W / 2, H / 2 + fs * 0.04);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.15 });
  const w = (W / H) * h;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.userData.width = w;
  mesh.userData.dispose = () => {
    mesh.geometry.dispose();
    mat.dispose();
    tex.dispose();
  };
  return mesh;
}

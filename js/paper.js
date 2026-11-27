// Paper: what a book is printed on, and the state it is in.
//
// A paper is a type (book wove, bright offset, antique, laid, Bible, newsprint, coated): its own surface maps
// (simulated in Blender: assets/paper/, textures.makeDeferredPaperTextures) and its physical properties from mill data (docs/ANALYSIS.md §16–17). The settings then
// move it anywhere: weight (20–300 gsm), surface (glass … very rough), sheen (matte … gloss), shade (brilliant
// white … deep buff), and the book's condition: age (toning, foxing) and wear (finger soil, cockle, softer
// leaves). A type's own values sit inside those ranges, where the real paper is; the ends are for anything else.
// Every book follows the library's paper unless it has its own (meta.paper). "Book wove" at its own values is
// exactly the paper Folio always had.
//
// resolvePaper() turns that into what the renderer needs: shader values for the leaves, the colours of the page
// block and its edges, the thickness of a leaf, and how supple the leaves are when they turn.

import * as THREE from 'three';

// The paper Folio has always had: these are its exact values, and Book wove's defaults reproduce them.
const BASE = { tint: '#e9e8e4', block: '#edece7', showThrough: 0.24, transmit: 0.34, toothK: 0.3, grainK: 0.06, mottleK: 0.03, cockleK: 0.04, roughness: 0.86, caliper: 164 };

/**
 * The types, calibrated from measurements (docs/ANALYSIS.md §18). gsm: default weight; bulk: cm³/g (caliper µm =
 * gsm × bulk); opacity at the default weight; E: bending modulus relative to book wove; tint: the sheet's colour,
 * from CIELAB paper whites relative to book wove; tooth: its relief (from roughness: coated ≈ 1 µm PPS, newsprint
 * ≈ 3 µm, book wove at the rough uncoated end), and surface: where that falls on the Surface slider's log scale;
 * roughness: from 75° gloss (uncoated ≈ 6 GU, matte coated ≈ 38, gloss ≈ 65), and sheen: where that falls on
 * the Sheen slider; lignin: how fast it tones with age.
 */
export const PAPER_TYPES = {
  wove: { label: 'Book wove', note: 'Uncoated book paper, cream, with fine fibre streaks along the grain: the paper Folio has always had.', gsm: 80, range: [60, 120], bulk: 2.05, opacity: 0.95, E: 1, tint: '#e9e8e4', shade: 0.5, surface: 0.7233, tooth: 0.3, grain: 0.06, mottle: 0.03, cockle: 0.04, roughness: 0.86, sheen: 0.1446, lignin: 0.45 },
  bright: { label: 'Bright', note: 'Calendered offset paper of short hardwood fibres and filler: bright, smooth and even.', gsm: 90, range: [70, 120], bulk: 1.2, opacity: 0.96, E: 1.1, tint: '#eff2f6', shade: 0.12, surface: 0.5979, tooth: 0.16, grain: 0.04, mottle: 0.02, cockle: 0.035, roughness: 0.84, sheen: 0.1687, lignin: 0.3 },
  antique: { label: 'Antique', note: 'Uncalendered and high-bulk, with longer fibres and a felt’s hills and valleys: toothy and natural, a thick book light in the hand.', gsm: 60, range: [50, 90], bulk: 2.6, opacity: 0.92, E: 0.8, tint: '#ede4d3', shade: 0.7, surface: 0.7705, tooth: 0.38, grain: 0.09, mottle: 0.045, cockle: 0.045, roughness: 0.89, sheen: 0.1084, lignin: 0.55 },
  laid: { label: 'Laid', note: 'Mould-made cotton rag: long fibres lying every which way, cloudy formation, laid and chain lines (clearest in light through a lifted page) and a deckled fore-edge.', gsm: 90, range: [70, 120], bulk: 1.5, opacity: 0.955, E: 1.2, tint: '#f1e7d3', shade: 0.75, surface: 0.7233, tooth: 0.3, grain: 0.07, mottle: 0.035, cockle: 0.05, roughness: 0.88, sheen: 0.1205, lignin: 0.15, laid: 1, deckle: 1 },
  bible: { label: 'Bible', note: 'Very thin, filled and calendered: fine, smooth and supple, with a little sheen; the other side shows through more. Gilt edges.', gsm: 36, range: [28, 50], bulk: 1.15, opacity: 0.88, E: 1, tint: '#eff0f2', shade: 0.2, surface: 0.5564, tooth: 0.13, grain: 0.04, mottle: 0.02, cockle: 0.06, roughness: 0.79, sheen: 0.2289, lignin: 0.3, edge: 'gilt' },
  news: { label: 'Newsprint', note: 'Groundwood and recycled pulp: short fibre fragments and fines, dark shives and ink flecks, cloudy and grey; it browns fastest of all.', gsm: 45, range: [40, 60], bulk: 1.8, opacity: 0.94, E: 0.7, tint: '#d8d7d3', shade: 0.55, surface: 0.6788, tooth: 0.24, grain: 0.12, mottle: 0.06, cockle: 0.06, roughness: 0.88, sheen: 0.1205, lignin: 1 },
  coated: { label: 'Coated', note: 'A pigment coating hides the fibres: bright and smooth, a coating’s fine peel, silk sheen (Sheen goes from matte to gloss).', gsm: 115, range: [90, 170], bulk: 0.85, opacity: 0.975, E: 1.6, tint: '#f0f2f5', shade: 0.1, surface: 0.4595, tooth: 0.08, grain: 0.015, mottle: 0.01, cockle: 0.025, roughness: 0.57, sheen: 0.494, lignin: 0.25, glossMottle: 0.6 },
};
export const PAPER_ORDER = ['wove', 'bright', 'antique', 'laid', 'bible', 'news', 'coated'];

// the ends of the sliders
export const GSM_RANGE = [20, 300];
const WHITE = new THREE.Color('#f8f9fb'); // brilliant, a touch cool (optical brighteners)
const IVORY = new THREE.Color('#c8ab7e'); // deep buff
const AGED = new THREE.Color(0.97, 0.88, 0.7); // what toning multiplies the sheet by, at its strongest

// ------------------------------------------------------------------ the library's paper
const LS_KEY = 'folio.paper.v1';
const WEAR_KEY = 'folio.wearLiving';

/** The library's paper: { type, gsm?, surface?, shade?, age?, wear? } (missing values: the type's defaults). */
export function loadLibraryPaper() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (v && PAPER_TYPES[v.type]) return v;
  } catch {
    /* default */
  }
  return { type: 'wove' };
}
export function saveLibraryPaper(p) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* not remembered */
  }
}
/** "Books wear as you read them" (finger soil on the leaves you turned, a little more wear the more you read). */
export function loadLivingWear() {
  try {
    return localStorage.getItem(WEAR_KEY) === '1';
  } catch {
    return false;
  }
}
export function saveLivingWear(on) {
  try {
    localStorage.setItem(WEAR_KEY, on ? '1' : '0');
  } catch {
    /* not remembered */
  }
}

/** A paper's settings with every value filled in from its type. */
export function fullSettings(p) {
  const T = PAPER_TYPES[p && p.type] || PAPER_TYPES.wove;
  const type = PAPER_TYPES[p && p.type] ? p.type : 'wove';
  return {
    type,
    gsm: clamp(num(p && p.gsm, T.gsm), GSM_RANGE[0], GSM_RANGE[1]),
    surface: clamp(num(p && p.surface, T.surface), 0, 1),
    sheen: clamp(num(p && p.sheen, T.sheen), 0, 1),
    shade: clamp(num(p && p.shade, T.shade), 0, 1),
    age: clamp(num(p && p.age, 0), 0, 1),
    wear: clamp(num(p && p.wear, 0), 0, 1),
  };
}

/**
 * A slider's value, with three anchors: its two ends and the type's own setting (exactly the type's value there).
 * `log`: interpolate the value logarithmically (for strengths, which feel even in ratios).
 */
function anchored(v, preset, lo, mid, hi, log = false) {
  const f = (a, b, t) => (log ? a * Math.pow(b / a, t) : a + (b - a) * t);
  if (v === preset) return mid;
  if (v < preset) return f(lo, mid, preset > 0 ? v / preset : 1);
  return f(mid, hi, preset < 1 ? (v - preset) / (1 - preset) : 0);
}

// ------------------------------------------------------------------ physics → rendering
/**
 * Everything the renderer needs for a paper. `scanTone`: the measured colour of a scanned page's own paper
 * ('#rrggbb'), so a scan isn't tinted and toned on top of the paper it already shows. `lived`: wear from real
 * reading (0…1), when that option is on.
 */
export function resolvePaper(p, { scanTone = null, lived = 0 } = {}) {
  const s = fullSettings(p);
  const T = PAPER_TYPES[s.type];
  const isBase = s.type === 'wove' && s.gsm === T.gsm && s.surface === T.surface && s.sheen === T.sheen && s.shade === T.shade;

  // thickness, opacity, stiffness
  const caliper = s.gsm * T.bulk; // µm
  const opacity = clamp(1 - (1 - T.opacity) * Math.pow(T.gsm / s.gsm, 0.9), 0.5, 0.995);
  const thin = (1 - opacity) / 0.05; // 1 for book wove
  const stiff = T.E * Math.pow(caliper / BASE.caliper, 3);
  const wear = Math.max(s.wear, lived);
  const flex = clamp(Math.pow(stiff, -0.18), 0.5, 2.0) * (1 + 0.35 * wear); // supple leaves curl more; use softens them
  // How the leaf moves (reader.js, Settings ▸ Turning ▸ Paper: Own), from its bending stiffness (stiff, ∝ E·t³) and
  // its weight (gsm), both against book wove's:
  //   sag:  weight over stiffness, cube-rooted (the elastogravity length): how far a free edge droops;
  //   airy: lightness: how much the air holds it (floats down slower, trails further, flutters);
  //   ring: stiffness over weight: how quickly its edge springs back.
  // Bible: sag 2.9, airy 2.2, ring 0.54 (floats, flutters, droops); coated: 1.6, 0.7, 0.8 (heavy, falls fast);
  // a 300 gsm card: 0.4, 0.3, 1.6 (stiff).
  const mass = s.gsm / 80;
  const soft = stiff / (1 + 0.6 * wear);
  const phys = {
    sag: clamp(Math.pow(mass / soft, 1 / 3), 0.4, 3),
    airy: clamp(1 / mass, 0.3, 2.5),
    ring: clamp(Math.pow(soft / mass, 0.15), 0.5, 1.6),
  };

  // colour: the type's tint, moved toward white or ivory by the shade setting
  const tint = new THREE.Color(T.tint);
  const d = s.shade - T.shade;
  if (d < 0) tint.lerp(WHITE, -d / Math.max(0.01, T.shade));
  else if (d > 0) tint.lerp(IVORY, d / Math.max(0.01, 1 - T.shade));
  // a scan brings its own paper: tint it barely, and tone it only as far as it isn't toned already
  const scan = scanTone ? scanYellow(scanTone) : null;
  if (scan) tint.lerp(new THREE.Color('#f1f1ef'), 0.85);
  // age: groundwood tones early, rag late; every paper is fully browned at the slider's end
  const tone = Math.pow(s.age, 1 + 1.5 * (1 - T.lignin)) * (scan ? 1 - scan.k : 1);
  const toned = tint.clone().multiply(new THREE.Color(1, 1, 1).lerp(AGED, tone * 0.75));
  // the colour a page shows: the paper, times a scan's own paper (a born-digital page is white)
  const face = toned.clone();
  if (scan) face.multiply(new THREE.Color(scanTone));

  return {
    settings: s,
    type: s.type,
    isBase,
    caliper,
    calRel: caliper / BASE.caliper,
    opacity,
    flex,
    phys,
    // the leaves' shader
    tint: toned,
    showThrough: Math.min(0.85, BASE.showThrough * Math.pow(thin, 0.6)),
    transmit: Math.min(0.85, BASE.transmit * Math.pow(thin, 0.4)),
    // surface: from all but glass to four times Folio's own relief, through the type's own
    toothK: anchored(s.surface, T.surface, 0.008, T.tooth, 1.2, true),
    grainK: T.grain * anchored(s.surface, T.surface, 0.3, 1, 3, true), // flecks come with the tooth
    mottleK: T.mottle,
    cockleK: T.cockle * (1 + 2.0 * wear + 0.4 * s.age), // handled pages go wavy
    roughness: anchored(s.sheen, T.sheen, 0.98, T.roughness, 0.15), // sheen: bone-dry matte … gloss
    ageTone: tone, // the band of toning along the head, tail and fore-edge
    foxK: Math.pow(s.age, 1.4 + (1 - T.lignin)), // spots: humidity and impurities, sooner in cheap pulp
    soil: wear,
    wear,
    laidK: T.laid || 0,
    deckle: T.deckle || 0,
    // the page block (stacks, and its edges on the shelf): its own grey-beige, carried along with the colour the
    // pages show, a scan's yellowed paper included (it stood on a white block before)
    block: new THREE.Color(BASE.block).multiply(ratio(face, BASE.tint)),
    // the block's edges: the pages' colour, browned further with age (they get the most light and air) and
    // greyed a little by hands
    edgeColor: ratio(face, BASE.tint)
      .multiply(new THREE.Color(1, 1, 1).lerp(new THREE.Color(0.86, 0.71, 0.5), Math.min(1, tone * 1.1)))
      .multiplyScalar(1 - 0.14 * wear),
    edge: T.edge || 'plain',
    glossMottle: T.glossMottle || 0,
    // a scan's own paper (linear), divided out of what shows through from the other side
    pagePaper: scan ? new THREE.Color(scanTone) : new THREE.Color(1, 1, 1),
  };
}

/** How yellow a scan's own paper is: { k: 0 … 1 }. */
function scanYellow(hex) {
  const c = new THREE.Color(hex);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const warm = c.r - c.b; // toned paper is warm: blue goes first
  if (lum > 0.95 && warm < 0.03) return null; // a white page: not a scan (or a clean one)
  return { k: clamp(warm / 0.12, 0, 1) };
}

/** a / b per channel, as a colour (used to carry the pages' colour over to the page block). */
function ratio(a, bHex) {
  const b = new THREE.Color(bHex);
  return new THREE.Color(a.r / b.r, a.g / b.g, a.b / b.b);
}

/** Set the leaves' shader to a paper (shared uniforms, see leaf.js), and the leaves' gloss. */
export function applyPaper(u, pool, r, pageW, pageH) {
  u.paperTint.value.copy(r.tint);
  u.showThrough.value = r.showThrough;
  u.transmit.value = r.transmit;
  u.toothK.value = r.toothK;
  u.grainK.value = r.grainK;
  u.mottleK.value = r.mottleK;
  u.cockleK.value = r.cockleK;
  u.ageTone.value = r.ageTone;
  u.foxK.value = r.foxK;
  u.wearK.value = r.wear;
  u.laidK.value = r.laidK;
  u.deckleK.value = r.deckle;
  u.pageSize.value.set(pageW, pageH);
  u.pagePaper.value.copy(r.pagePaper);
  u.glossMottle.value = r.glossMottle;
  for (const leaf of pool) leaf.material.roughness = r.roughness;
}

/** Weight label: "80 gsm · 0.16 mm · 95 % opaque". */
export function describeWeight(r) {
  return `${Math.round(r.settings.gsm)} gsm · ${(r.caliper / 1000).toFixed(2)} mm · ${Math.round(r.opacity * 100)} % opaque`;
}

function num(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}

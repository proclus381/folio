// Folio — app bootstrap: renderer, scene, lights, camera framing, input routing, library state.

import * as THREE from 'three';
import { Shelf, SHELF_Z } from './shelf.js';
import { Reader } from './reader.js';
import { Candle } from './candle.js';
import { Lighting } from './lighting.js';
import { OilLamp, DeskLamp } from './lamps.js';
import { Fireside } from './fireside.js';
import { SunWindow, RainWindow } from './window.js';
import { setPaperRoomLight } from './leaf.js';
import { setBindingRoomLight, setDefaultBinding } from './binding.js';
import { restyleBookMaterials } from './book3d.js';
import { UI } from './ui.js';
import { Magnifier } from './magnifier.js';
import * as store from './store.js';
import { importFiles, exportAnnotated, folderShelves, filesFromDrop } from './library.js';
import { GROUPS, ORDERS, layout as arrangeLayout, sortBooks, loadShelves, saveShelves, reconcileShelves, newShelfId, seedManualOrder, orderBetween } from './arrange.js';
import {
  makeGrainTexture,
  makeDeferredPaperTextures,
  makePageEdgeTexture,
  luminance,
} from './textures.js';
import { clamp, lerp } from './anim.js';

const DEG = Math.PI / 180;
const FOV = 18;

const THEMES = ['light', 'dark', 'color'];

function pref(key, fallback) {
  try {
    const v = localStorage.getItem('folio.' + key);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem('folio.' + key, value);
  } catch {}
}

/**
 * A font face that failed to load (a hiccup while the offline cache was filling, say) stays failed for the
 * whole visit, and the browser quietly draws with Georgia or the system mono instead. Load any such face again
 * from its own @font-face rule before the first spine or title is drawn.
 */
async function retryFailedFonts() {
  const failed = [...document.fonts].filter((f) => f.status === 'error');
  if (!failed.length) return;
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of list) if (r.type === CSSRule.FONT_FACE_RULE) rules.push(r);
  }
  const norm = (v) => String(v || '').replace(/['"]/g, '').trim().toLowerCase();
  const jobs = [];
  for (const f of failed) {
    for (const r of rules) {
      const st = r.style;
      if (norm(st.getPropertyValue('font-family')) !== norm(f.family)) continue;
      if (norm(st.getPropertyValue('font-weight') || '400') !== norm(f.weight)) continue;
      if (norm(st.getPropertyValue('font-style') || 'normal') !== norm(f.style)) continue;
      const m = /url\((['"]?)(.*?)\1\)/.exec(st.getPropertyValue('src'));
      if (!m) continue;
      const url = new URL(m[2], r.parentStyleSheet.href || location.href).href;
      const range = st.getPropertyValue('unicode-range');
      const face = new FontFace(f.family, `url(${url})`, { weight: f.weight, style: f.style, ...(range ? { unicodeRange: range } : {}) });
      document.fonts.add(face);
      jobs.push(face.load().catch(() => {}));
    }
  }
  await Promise.all(jobs);
}

class App {
  constructor() {
    this.canvas = document.getElementById('stage');
    this.isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
    this.penSeen = false;
    this.metas = [];
    this.sort = ORDERS.some((o) => o.key === pref('sort', 'added')) ? pref('sort', 'added') : 'added';
    this.group = GROUPS.some((g) => g.key === pref('group', 'none')) ? pref('group', 'none') : 'none';
    this.reverse = pref('reverse', '0') === '1';
    this.plank = pref('plank', 'none');
    this.shelves = loadShelves();
    this.marks = new Map();
    this.theme = pref('theme', 'light');
    this.dirty = 3;
    this.lastT = performance.now() / 1000;
    this.pending = null;
    this.clock = 0; // app time in seconds (scaled), drives every animation
    this.timeScale = 1; // debugging: < 1 for slow motion
    this.tapMs = 450; // longest press that still counts as a tap
  }

  async init() {
    // canvas text needs the faces loaded before any spine / cover is drawn
    await Promise.all([
      document.fonts.load('400 40px "Instrument Serif"'),
      document.fonts.load('italic 400 40px "Instrument Serif"'),
      document.fonts.load('400 20px "IBM Plex Mono"'),
      document.fonts.load('500 20px "Inter"'),
    ]).catch(() => {});
    await retryFailedFonts();

    this.initRenderer();
    this.initScene();
    this.ui = new UI(this);
    this.shelf = new Shelf(this);
    this.reader = new Reader(this);
    this.lighting = new Lighting(this, {
      candle: (a) => new Candle(a),
      oil: (a) => new OilLamp(a),
      desk: (a) => new DeskLamp(a),
      fire: (a) => new Fireside(a),
      sun: (a) => new SunWindow(a),
      rain: (a) => new RainWindow(a),
    });
    this.ui.setLightIcon(this.lighting.choice);
    this.magnifier = new Magnifier();
    this.shelf.onSelect = (e) => this.onSelect(e);
    this.ui.setTheme(this.theme, null);
    this.ui.setSortLabel(this.arrangeLabel());
    this.shelf.onRowChange = (row) => this.onRowChange(row);
    this.shelf.setPlank(this.plank, this.theme === 'dark');
    this.shelf.alone = pref('readAlone', '1') === '1';
    this.ui.setReadAlone(this.shelf.alone);
    this.resize();
    this.bindInput();
    await this.loadLibrary();
    this.lighting.restore(); // the room light left on last time
    this.ui.syncLight(this.lighting);
    store.persist();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ================================================================= renderer & scene
  initRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.VSMShadowMap;
    r.localClippingEnabled = true; // the oil lamp's oil level
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    this.maxAniso = Math.min(8, r.capabilities.getMaxAnisotropy());
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ui && this.ui.toast('Graphics were reset — reload if the shelf looks empty');
    });
  }

  initScene() {
    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1200);
    this.cameraBase = new THREE.Vector3(0, 0, 54);

    this.ambient = new THREE.AmbientLight(0xf1f3f9, 1.15); // a touch cool, like daylight from the room
    scene.add(this.ambient);
    const key = new THREE.DirectionalLight(0xfffaf4, 2.1);
    key.castShadow = true;
    // VSM: soft blurred silhouettes like the reference; 1024² keeps the blur pass cheap on tablets
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 8;
    key.shadow.blurSamples = 12;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.key = key;
    this.keyDir = new THREE.Vector3(-0.09, 0.2, 1).normalize();
    scene.add(key);
    scene.add(key.target);
    const fill = new THREE.DirectionalLight(0xe9eefc, 0.55);
    this.fill = fill;
    // the room's own light levels; a reading light dims or tints them
    this.lightBase = { ambient: 1.15, key: 2.1, fill: 0.55 };
    fill.position.set(40, 8, 30);
    scene.add(fill);

    // the wall behind the books only shows shadows
    this.shadowMat = new THREE.ShadowMaterial({ color: 0x0a0a12, opacity: 0.3 });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(900, 600), this.shadowMat);
    wall.position.z = -54.5;
    wall.receiveShadow = true;
    scene.add(wall);
    this.wall = wall;

    // shared textures / materials
    const edge = makePageEdgeTexture();
    const grain = makeGrainTexture();
    const paper = makeDeferredPaperTextures();
    paper.onReady = () => this.invalidate();
    setTimeout(() => paper.fill(), 1500);
    paper.repeat = new THREE.Vector2(1.5, 2.25);
    this.shared = {
      grain,
      paper,
      edgeMat: new THREE.MeshLambertMaterial({ map: edge, color: 0xffffff }),
      paperMat: new THREE.MeshLambertMaterial({ color: 0xedece7 }),
    };
    // stack edges should never z-fight with the leaves resting on them
    this.shared.paperMat.polygonOffset = true;
    this.shared.paperMat.polygonOffsetFactor = 2;
    this.shared.paperMat.polygonOffsetUnits = 2;
  }

  get width() {
    return this.w || window.innerWidth;
  }
  get height() {
    return this.h || window.innerHeight;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // framing: books ≈ 64 % of the height, but always show a few volumes either side
    const tanH = Math.tan((FOV * DEG) / 2);
    const bookH = 24.3 * 0.8;
    const aspect = w / h;
    const dH = bookH / (0.64 * 2 * tanH);
    const minW = aspect < 0.8 ? 27 : 34;
    const dW = minW / (2 * tanH * aspect);
    const dist = Math.max(dH, dW);
    const centerPx = h * 0.515;
    const yOff = ((centerPx - h / 2) / h) * 2 * tanH * dist;
    this.cameraBase.set(0, yOff, SHELF_Z + dist);
    this.camera.position.copy(this.cameraBase);
    this.camera.updateProjectionMatrix();
    // shadow camera covers what is visible on the wall
    const wallDist = this.cameraBase.z + 54.5;
    const visH = 2 * tanH * wallDist;
    const visW = visH * aspect;
    const sc = this.key.shadow.camera;
    const half = Math.max(visW, visH) / 2 + 8;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 1;
    sc.far = 260;
    sc.updateProjectionMatrix();
    this.key.target.position.set(0, yOff, -45);
    this.key.position.copy(this.key.target.position).addScaledVector(this.keyDir, 120);
    this.magnifier && this.magnifier.setSize(w, h, this.renderer.getPixelRatio(), this.renderer.capabilities.maxTextureSize);
    if (this.ui) this.ui.measureTitles();
    if (this.reader) this.reader.resize();
    this.invalidate();
  }

  worldPerPx(z) {
    const dist = this.cameraBase.z - z;
    return (2 * Math.tan((FOV * DEG) / 2) * dist) / this.height;
  }

  invalidate() {
    this.dirty = Math.max(this.dirty, 2);
  }

  // ================================================================= library
  async loadLibrary(selectId, { animate = false } = {}) {
    this.metas = await store.listBooks();
    // books from before one type system for every spine were given a random style (serif, mono or sans): they
    // take the house style once; a style picked later in Details stays
    const retype = this.metas.filter((m) => m.look && (m.look.type || 0) < 2);
    for (const m of retype) {
      m.look = { ...m.look, spineStyle: 'serif', type: 2 };
      // and the foils that stood apart from the rest (coral, mint) become gold
      if (['#e58a6a', '#9fd0c0'].includes(m.look.accent)) m.look.accent = '#d9ab5f';
    }
    if (retype.length) store.putBooks(retype).catch((e) => console.warn('retype', e));
    this.marks = await store.countMarks().catch(() => new Map());
    if (reconcileShelves(this.shelves, this.metas)) saveShelves(this.shelves);
    if (!selectId) {
      const recent = [...this.metas].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0];
      selectId = recent ? recent.id : null;
    }
    this.arrange(selectId, { animate });
    this.ui.setCount(this.metas.length);
    if (!this.metas.length) this.ui.setNow(null);
    this.invalidate();
  }

  // ---------------------------------------------------------------- flags
  /**
   * A tap on a flag. The first only raises it and shows where it leads, so a stray tap never takes you away;
   * tapping it again (or its label) goes there, keeping your place to go back to.
   */
  flagTap(hit, where) {
    const pk = this.peek;
    if (pk && pk.where === where && pk.flag.key === hit.flag.key && pk.entry === hit.entry) {
      this.goToFlag();
      return;
    }
    this.clearPeek();
    this.peek = { ...hit, where };
    if (where === 'shelf') this.shelf.liftFlag(hit.entry, hit.flag.key);
    this.ui.showFlagTip(hit.flag, () => this.goToFlag());
    clearTimeout(this.peekT);
    this.peekT = setTimeout(() => this.clearPeek(), this.peekMs || 6000);
    this.invalidate();
  }

  clearPeek() {
    const pk = this.peek;
    if (!pk) return;
    this.peek = null;
    clearTimeout(this.peekT);
    if (pk.where === 'shelf') this.shelf.liftFlag(pk.entry, null);
    this.ui.hideFlagTip();
    this.invalidate();
  }

  goToFlag() {
    const pk = this.peek;
    if (!pk) return;
    this.clearPeek();
    if (pk.where === 'reader') this.reader.jumpTo(pk.flag.spread);
    else if (!this.reader.isOpen) {
      this.ui.closePanel();
      this.reader.open(pk.entry, { at: pk.flag.spread });
    }
  }

  /** Keep a raised flag's label beside it (or drop the flag when it has gone from view). */
  placePeek() {
    const pk = this.peek;
    if (!pk) return;
    let box = null;
    if (pk.where === 'reader') box = this.reader.isOpen ? this.reader.flagBox(pk.flag.key) : null;
    else if (!this.reader.isOpen) {
      const it = this.shelf.flagBoxes(pk.entry).find((x) => x.flag.key === pk.flag.key);
      box = it ? it.box : null;
    }
    if (!box) this.clearPeek();
    else this.ui.placeFlagTip(box);
  }

  /** Stand the books on the shelf as the current grouping and order say. */
  arrange(selectId = null, { animate = false } = {}) {
    const L = arrangeLayout(this.metas, { group: this.group, order: this.sort, reverse: this.reverse, shelves: this.shelves, marks: this.marks });
    this.shelf.setLayout(L, selectId, { animate });
    this.ui.setTitles(this.shelf.entries.map((e) => e.meta));
    this.ui.setSortLabel(this.arrangeLabel());
  }

  arrangeLabel() {
    const g = GROUPS.find((x) => x.key === this.group) || GROUPS[0];
    const o = ORDERS.find((x) => x.key === this.sort) || ORDERS[0];
    return `${g.title} · ${o.short}${this.reverse ? ' ↓' : ''}`;
  }

  /** Change how the books stand: { group, order, reverse, plank }. The books glide to their new places. */
  async setArrangement(patch) {
    if (patch.plank) {
      this.plank = patch.plank;
      setPref('plank', this.plank);
      this.shelf.setPlank(this.plank, this.theme === 'dark');
    }
    if (patch.group) {
      this.group = patch.group;
      setPref('group', this.group);
    }
    if (patch.order) {
      if (patch.order === 'manual' && this.sort !== 'manual' && !this.metas.some((m) => m.order != null)) {
        // "My order" starts from the order the shelf shows now
        store.putBooks(seedManualOrder(sortBooks(this.metas, this.sort, this.reverse, this.marks))).catch((e) => console.warn('save order', e));
      }
      this.sort = patch.order;
      setPref('sort', this.sort);
    }
    if (patch.reverse != null) {
      this.reverse = !!patch.reverse;
      setPref('reverse', this.reverse ? '1' : '0');
    }
    this.ui.setSortLabel(this.arrangeLabel());
    if (patch.group || patch.order || patch.reverse != null) {
      if (this.reader.isOpen) {
        this.libraryDirty = true;
        return;
      }
      if (patch.order === 'marked') this.marks = await store.countMarks().catch(() => this.marks);
      const cur = this.currentMeta();
      this.arrange(cur && cur.id, { animate: true });
    }
    this.invalidate();
  }

  // ---------------------------------------------------------------- your shelves
  createShelf(name) {
    const s = { id: newShelfId(), name: (name || '').trim().slice(0, 40) || 'New shelf' };
    this.shelves.push(s);
    saveShelves(this.shelves);
    this.relayout(null, true);
    return s;
  }

  renameShelf(id, name) {
    const s = this.shelves.find((x) => x.id === id);
    const n = (name || '').trim().slice(0, 40);
    if (!s || !n) return;
    s.name = n;
    saveShelves(this.shelves);
    const books = this.metas.filter((m) => m.shelf === id);
    for (const m of books) m.shelfName = n;
    store.putBooks(books).catch(() => {});
    this.relayout();
  }

  moveShelf(id, dir) {
    const i = this.shelves.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.shelves.length) return;
    [this.shelves[i], this.shelves[j]] = [this.shelves[j], this.shelves[i]];
    saveShelves(this.shelves);
    this.relayout();
  }

  async deleteShelf(id) {
    const changed = this.metas.filter((m) => m.shelf === id);
    for (const m of changed) {
      m.shelf = null;
      m.shelfName = null;
      m.section = null;
    }
    await store.putBooks(changed);
    this.shelves = this.shelves.filter((x) => x.id !== id);
    saveShelves(this.shelves);
    this.relayout();
  }

  /** Put a book on one of your shelves (null: on none). One shelf per book. */
  async setBookShelf(meta, shelfId, section = null) {
    const s = this.shelves.find((x) => x.id === shelfId);
    // sections belong to a shelf: a book changing shelves leaves its section behind
    if ((meta.shelf || null) !== (s ? s.id : null) || section != null) meta.section = s && section ? section : null;
    meta.shelf = s ? s.id : null;
    meta.shelfName = s ? s.name : null;
    await store.putBook(meta);
    this.relayout(meta.id);
  }

  /** A book's section on its shelf ('' or null: none). */
  async setBookSection(meta, name) {
    const v = (name || '').trim().slice(0, 60) || null;
    if ((meta.section || null) === v) return;
    meta.section = meta.shelf ? v : null;
    await store.putBook(meta);
    this.relayout(meta.id);
  }

  /** Rename a section of a shelf (every book in it); an empty name dissolves it. */
  async renameSection(shelfId, from, to) {
    const v = (to || '').trim().slice(0, 60) || null;
    const books = this.metas.filter((m) => m.shelf === shelfId && m.section === from);
    if (!books.length || v === from) return;
    for (const m of books) m.section = v;
    await store.putBooks(books);
    this.relayout();
  }

  /** Re-stand the books after a change, keeping the face-out book (or `selectId`). */
  relayout(selectId = null, toNewShelf = false) {
    if (this.reader.isOpen) {
      this.libraryDirty = true;
      return;
    }
    const cur = this.currentMeta();
    this.arrange(selectId || (cur && cur.id), { animate: true });
    if (toNewShelf && this.group === 'shelves') this.shelf.goToRow(this.shelves.length - 1);
    this.invalidate();
  }

  onRowChange(row) {
    this.ui.setTitles(row.entries.map((e) => e.meta));
    this.ui.setShelfName && this.ui.setShelfName(this.shelf.mode === 'case' ? row.label : null);
  }

  sortedMetas() {
    return sortBooks(this.metas, this.sort, this.reverse, this.marks);
  }

  currentMeta() {
    if (this.reader.isOpen) return this.reader.meta;
    const e = this.shelf.entries[this.shelf.selected];
    return e ? e.meta : null;
  }

  onSelect(entry) {
    if (this.peek && this.peek.where === 'shelf' && this.peek.entry !== entry) this.clearPeek();
    this.ui.setNow(entry.meta);
    if (this.theme === 'color') this.ui.setTheme('color', entry.look);
  }

  cycleTheme() {
    const i = THEMES.indexOf(this.theme);
    this.theme = THEMES[(i + 1) % THEMES.length];
    setPref('theme', this.theme);
    const e = this.shelf.entries[this.shelf.selected];
    this.ui.setTheme(this.theme, this.reader.isOpen ? this.reader.entry.look : e && e.look);
    this.shadowMat.opacity = this.theme === 'light' ? 0.3 : this.theme === 'dark' ? 0.7 : 0.5;
    this.shelf.setPlank(this.plank, this.theme === 'dark');
    this.lightBase.ambient = this.theme === 'dark' ? 1.0 : 1.15;
    this.invalidate();
  }

  selectBook(id) {
    if (this.reader.isOpen) return;
    this.shelf.selectById(id);
  }

  openSelected() {
    if (this.reader.isOpen || !this.shelf.entries.length) return;
    const e = this.shelf.entries[this.shelf.selected];
    if (!e) return;
    this.ui.closePanel();
    if (Math.abs(this.shelf.p - this.shelf.selected) > 0.02 || Math.abs(e.yaw) > 0.05) {
      // let the book finish turning face-out first
      this.pending = { id: e.meta.id };
      this.shelf.select(this.shelf.selected);
      return;
    }
    this.reader.open(e);
  }

  openBookById(id, page) {
    const meta = this.metas.find((m) => m.id === id);
    if (!meta) return;
    if (this.reader.isOpen) {
      if (this.reader.meta.id === id) {
        if (page) this.reader.goToPage(page);
        return;
      }
      this.pending = { id, page };
      this.reader.close();
      return;
    }
    // opened at a page: where you were reading is kept to go back to
    this.pending = { id, at: page ? clamp(Math.floor(page / 2), 0, Math.ceil(meta.pages / 2)) : null };
    this.selectBook(id);
  }

  async onReaderClosed(entry) {
    if (this.magnifier.enabled) this.toggleMagnifier();
    if (this.theme === 'color') this.ui.setTheme('color', this.shelf.entries[this.shelf.selected]?.look);
    if (this.pending && this.pending.remove) {
      const meta = this.pending.remove;
      this.pending = null;
      this.removeBook(meta);
      return;
    }
    if (this.libraryDirty) {
      // books were added or the order changed while reading
      this.libraryDirty = false;
      await this.loadLibrary(entry && entry.meta.id);
    }
    if (this.pending && this.pending.id) {
      const { id, page } = this.pending;
      this.pending = null;
      this.openBookById(id, page);
    }
  }

  async updateMeta(meta, { retexture = false } = {}) {
    await store.putBook(meta);
    if (retexture) {
      this.shelf.refreshEntry(meta);
      this.ui.setTitles(this.shelf.entries.map((e) => e.meta));
      this.ui.setNow(meta);
    }
    this.invalidate();
  }

  setLook(meta, patch) {
    const look = { ...meta.look, ...patch };
    if (patch.cloth) {
      const dark = luminance(look.cloth) < 0.3;
      look.ink = dark ? '#efebe2' : '#1f1d1a';
      if (dark && luminance(look.accent) < 0.3) look.accent = '#d9ab5f';
      if (!dark && luminance(look.accent) > 0.4) look.accent = '#1d1b19';
    }
    meta.look = look;
    const e = this.shelf.all.get(meta.id);
    if (e) e.look = look;
    this.updateMeta(meta, { retexture: true });
    if (this.theme === 'color') this.ui.setTheme('color', look);
  }

  /** Bind every book in cloth or leather, and new books too. */
  async setMaterialAll(kind) {
    setDefaultBinding(kind);
    for (const meta of this.metas) {
      if ((meta.look.material || 'cloth') === kind) continue;
      meta.look = { ...meta.look, material: kind };
      const e = this.shelf.entries.find((x) => x.meta.id === meta.id);
      if (e) {
        e.meta = meta;
        e.look = meta.look;
        restyleBookMaterials(e.mats, meta.look);
      }
      await store.putBook(meta);
    }
    this.invalidate();
  }

  async removeBook(meta) {
    if (this.reader.isOpen && this.reader.meta.id === meta.id) {
      this.pending = { remove: meta };
      this.reader.close();
      return;
    }
    await store.deleteBook(meta.id);
    const row = this.shelf.entries;
    const idx = this.shelf.selected;
    const next = row[idx + 1] || row[idx - 1];
    await this.loadLibrary(next && next.meta.id !== meta.id ? next.meta.id : null);
    this.ui.toast('Removed from the shelf');
  }

  async exportBook(meta) {
    try {
      this.ui.toast('Preparing the PDF…', 6000);
      const { blob, name, count } = await exportAnnotated(meta);
      const file = new File([blob], name, { type: 'application/pdf' });
      if (navigator.canShare && this.isTouch && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: meta.title }).catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 20000);
      }
      this.ui.toast(count ? `Exported with ${count} mark${count === 1 ? '' : 's'}` : 'Exported (no marks yet)');
    } catch (err) {
      console.error(err);
      this.ui.toast('Export failed: ' + (err.message || err));
    }
  }

  pickFiles() {
    const input = document.getElementById('file-input');
    input.value = '';
    input.click();
  }

  pickFolder() {
    const input = document.getElementById('folder-input');
    input.value = '';
    input.click();
  }

  /**
   * Add a whole folder as one of your shelves; its subfolders become sections on it. Several folders (dropped
   * together) give several shelves. A shelf of the same name gets the new books; books already in the library
   * that stand on no shelf join it. The bookcase shows the shelf while it fills.
   */
  async addFolder(files, pathOf) {
    if (this.importing) return;
    let groups = folderShelves(files, pathOf);
    if (!groups.length) {
      this.ui.toast('No PDFs in that folder', 2600);
      return;
    }
    // without folder paths (an older iPad) the files still make one new shelf; loose files dropped beside
    // folders are added the ordinary way
    const loose = groups.find((g) => !g.name);
    if (loose && groups.length === 1) loose.name = 'New shelf';
    else if (loose) groups = groups.filter((g) => g !== loose);
    this.importing = true;
    const total = groups.reduce((n, g) => n + g.files.length, 0);
    const reading = this.reader.isOpen;
    let done = 0;
    let lastId = null;
    const report = { added: 0, moved: 0, skipped: 0, failed: 0, shelves: [] };
    try {
      if (this.group !== 'shelves') {
        this.group = 'shelves';
        setPref('group', this.group);
        this.ui.setSortLabel(this.arrangeLabel());
      }
      for (const g of groups) {
        const name = g.name.trim().slice(0, 40) || 'New shelf';
        let s = this.shelves.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!s) {
          s = { id: newShelfId(), name };
          this.shelves.push(s);
          saveShelves(this.shelves);
        }
        report.shelves.push(s);
        // show the shelf straight away, and let it fill
        if (!reading) {
          this.arrange(null, { animate: true });
          const ri = this.shelf.rows.findIndex((r) => r.shelfId === s.id);
          if (ri >= 0) this.shelf.goToRow(ri);
        }
        const order = this.sort === 'manual' ? Math.max(0, ...this.metas.map((m) => m.order || 0)) + 1024 : null;
        const res = await importFiles(
          g.files,
          this.metas,
          (i, n, fname) => this.ui.toast(`${name} · adding ${done + i + 1} of ${total} — ${fname}`, 60000),
          {
            shelf: s.id,
            shelfName: s.name,
            order,
            sectionFor: (f) => g.sectionOf.get(f),
            onAdded: (m) => {
              this.metas.push(m);
              lastId = m.id;
              this.importTick(m.id);
            },
          },
        );
        done += g.files.length;
        const moved = [];
        for (const { meta, file } of res.known) {
          if (meta.shelf) continue;
          meta.shelf = s.id;
          meta.shelfName = s.name;
          meta.section = g.sectionOf.get(file) || null;
          moved.push(meta);
        }
        if (moved.length) await store.putBooks(moved);
        report.added += res.added.length;
        report.moved += moved.length;
        report.skipped += res.skipped.length - moved.length;
        report.failed += res.failed.length;
      }
      // the summary
      const parts = [];
      const shelfNames = report.shelves.map((x) => `“${x.name}”`).join(', ');
      if (report.added || report.moved) {
        const n = report.added + report.moved;
        const secs = new Set(this.metas.filter((m) => report.shelves.some((x) => x.id === m.shelf) && m.section).map((m) => m.shelf + '|' + m.section)).size;
        parts.push(`${shelfNames}: ${n} ${n === 1 ? 'book' : 'books'}${secs ? ` in ${secs} section${secs === 1 ? '' : 's'}` : ''}`);
      } else parts.push(`${shelfNames}: nothing new`);
      if (report.skipped) parts.push(`${report.skipped} already here`);
      if (report.failed) parts.push(`${report.failed} could not be read`);
      this.ui.toast(parts.join(' · '), 4200);
      clearTimeout(this.importT);
      this.importT = 0;
      if (reading) this.libraryDirty = true;
      else {
        await this.loadLibrary(lastId || (this.currentMeta() && this.currentMeta().id));
        const last = report.shelves[report.shelves.length - 1];
        const ri = this.shelf.rows.findIndex((r) => r.shelfId === last.id);
        if (ri >= 0 && ri !== this.shelf.r) this.shelf.goToRow(ri);
      }
    } finally {
      this.importing = false;
      clearTimeout(this.importT);
      this.importT = 0;
    }
    if (loose && loose.name === '') await this.addFiles(loose.files);
  }

  /** While a folder comes in: stand the new books on the shelf every couple of seconds. */
  importTick(id) {
    if (this.reader.isOpen || this.importT) return;
    this.importT = setTimeout(() => {
      this.importT = 0;
      if (this.reader.isOpen || this.shelf.lift) return;
      const cur = this.currentMeta();
      const r = this.shelf.r;
      this.arrange(this.shelf.entries.length ? cur && cur.id : id, { animate: true });
      if (this.shelf.r !== r && r < this.shelf.rows.length) this.shelf.goToRow(r);
      this.ui.setCount(this.metas.length);
    }, 1800);
  }

  async addFiles(files) {
    if (this.importing) return;
    this.importing = true;
    try {
      // in the bookcase, new books go onto the shelf you are looking at
      const shelfId = this.shelf.mode === 'case' ? this.shelf.row.shelfId : null;
      const s = this.shelves.find((x) => x.id === shelfId);
      const res = await importFiles(
        files,
        this.metas,
        (i, n, name) => this.ui.toast(n > 1 ? `Adding ${i + 1} of ${n} — ${name}` : `Adding ${name}`, 60000),
        { shelf: s ? s.id : null, shelfName: s ? s.name : null, order: this.sort === 'manual' ? Math.max(0, ...this.metas.map((m) => m.order || 0)) + 1024 : null },
      );
      const parts = [];
      if (res.added.length) parts.push(`Added ${res.added.length}`);
      if (res.skipped.length) parts.push(`${res.skipped.length} skipped`);
      if (res.failed.length) parts.push(`${res.failed.length} could not be read`);
      this.ui.toast(parts.join(' · ') || 'Nothing added');
      if (res.added.length && !this.reader.isOpen) {
        this.metas = await store.listBooks();
        await this.loadLibrary(res.added[res.added.length - 1].id);
      } else if (res.added.length) {
        this.metas = await store.listBooks();
        this.libraryDirty = true;
      }
    } finally {
      this.importing = false;
    }
  }

  toggleMagnifier() {
    this.magnifier.enabled = !this.magnifier.enabled;
    if (this.magnifier.enabled) this.magnifier.point(this.width / 2, this.height / 2, this.width, this.height);
    this.ui.setMagnifier(this.magnifier.enabled);
    this.invalidate();
  }

  /** Read with the shelf beside the open book, or with the book alone (its neighbours step off the screen). */
  toggleReadAlone() {
    this.shelf.alone = !this.shelf.alone;
    setPref('readAlone', this.shelf.alone ? '1' : '0');
    this.ui.setReadAlone(this.shelf.alone);
    this.invalidate();
  }

  // ================================================================= input
  bindInput() {
    const c = this.canvas;
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    const input = document.getElementById('file-input');
    input.addEventListener('change', () => {
      if (input.files && input.files.length) this.addFiles([...input.files]);
    });
    const folder = document.getElementById('folder-input');
    folder.addEventListener('change', () => {
      if (folder.files && folder.files.length) this.addFolder([...folder.files]);
    });

    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.lastT = performance.now() / 1000;
        this.invalidate();
      }
    });

    // drag & drop
    let dragDepth = 0;
    const drop = document.getElementById('drop');
    window.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      dragDepth++;
      drop.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) drop.hidden = true;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      drop.hidden = true;
      const files = [...(e.dataTransfer?.files || [])];
      const items = e.dataTransfer?.items;
      // a dropped folder becomes a shelf (the entries must be taken while the event lasts)
      const walk = items && items.length && items[0].webkitGetAsEntry ? filesFromDrop(items) : null;
      if (walk)
        walk
          .then(({ pairs, hasFolder }) => {
            if (!hasFolder) return files.length && this.addFiles(files);
            const paths = new Map(pairs);
            return this.addFolder(
              pairs.map((p) => p[0]),
              (f) => paths.get(f),
            );
          })
          .catch(() => files.length && this.addFiles(files));
      else if (files.length) this.addFiles(files);
    });
  }

  ndc(x, y) {
    return new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  onPointerDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (this.ui.panelMode && e.pointerType !== 'mouse') this.ui.closePanel();
    if (this.reader.isOpen) this.ui.closePopovers();
    else {
      this.ui.toggleLightPop(false);
      this.ui.toggleArrangePop(false);
      this.ui.toggleAddMenu(false);
    }
    if (this.magnifier.enabled && this.reader.isOpen && e.pointerType === 'touch' && !this.reader.tool) {
      this.lens = { id: e.pointerId };
      this.magnifier.point(e.clientX, e.clientY - 70, this.width, this.height);
      this.invalidate();
      return;
    }
    if (this.reader.isOpen) {
      this.reader.pointerDown(e);
      return;
    }
    const sp = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, lx: e.clientX, ly: e.clientY, lt: performance.now(), vx: 0, vy: 0, type: e.pointerType, axis: null, lift: false };
    this.shelfPointer = sp;
    // press and hold a book to lift it and carry it to a new place
    clearTimeout(this.liftTimer);
    this.liftTimer = setTimeout(() => {
      if (this.shelfPointer !== sp || sp.moved || this.reader.isOpen) return;
      const hit = this.shelf.pick(this.ndc(sp.x0, sp.y0));
      if (!hit || !hit.entry || hit.entry.row !== this.shelf.r) return;
      if (this.shelf.liftStart(hit.entry, sp.x0)) {
        sp.lift = true;
        navigator.vibrate && navigator.vibrate(8);
        if (this.sort !== 'manual') this.ui.toast('Carry it to its new place — the shelf switches to your own order', 2600);
      }
    }, this.liftMs || 430);
  }

  onPointerMove(e) {
    if (this.magnifier.enabled && this.reader.isOpen) {
      if (this.lens && this.lens.id === e.pointerId) {
        this.magnifier.point(e.clientX, e.clientY - 70, this.width, this.height);
        this.invalidate();
        return;
      }
      if (e.pointerType === 'mouse') {
        this.magnifier.point(e.clientX, e.clientY, this.width, this.height);
        this.invalidate();
      }
    }
    if (this.reader.isOpen) {
      this.reader.pointerMove(e);
      return;
    }
    const sp = this.shelfPointer;
    if (sp && sp.id === e.pointerId) {
      const dx = e.clientX - sp.x0;
      const dy = e.clientY - sp.y0;
      const now = performance.now();
      const dt = Math.max(1, now - sp.lt);
      sp.vx = sp.vx * 0.5 + (((e.clientX - sp.lx) / dt) * 1000) * 0.5;
      sp.vy = sp.vy * 0.5 + (((e.clientY - sp.ly) / dt) * 1000) * 0.5;
      sp.lx = e.clientX;
      sp.ly = e.clientY;
      sp.lt = now;
      if (sp.lift) {
        this.shelf.liftMove(e.clientX);
        return;
      }
      if (!sp.moved && Math.hypot(dx, dy) > 6) {
        sp.moved = true;
        clearTimeout(this.liftTimer);
        this.clearPeek();
        // up and down moves between the bookcase's shelves; sideways browses
        sp.axis = this.shelf.mode === 'case' && Math.abs(dy) > Math.abs(dx) * 1.2 ? 'y' : 'x';
        if (sp.axis === 'y') this.shelf.rowDragStart();
        else this.shelf.dragStart();
      }
      if (sp.moved) {
        if (sp.axis === 'y') this.shelf.rowDragMove(dy);
        else this.shelf.dragMove(dx);
      }
      return;
    }
    if (e.pointerType === 'mouse' && !e.buttons) this.shelfHover(e.clientX, e.clientY);
  }

  onPointerUp(e) {
    if (this.lens && this.lens.id === e.pointerId) {
      this.lens = null;
      return;
    }
    if (this.reader.isOpen) {
      this.reader.pointerUp(e);
      return;
    }
    const sp = this.shelfPointer;
    if (!sp || sp.id !== e.pointerId) return;
    this.shelfPointer = null;
    clearTimeout(this.liftTimer);
    if (sp.lift) {
      this.placeLifted(this.shelf.liftEnd());
      return;
    }
    if (sp.moved) {
      const still = performance.now() - sp.lt > 80;
      if (sp.axis === 'y') this.shelf.rowDragEnd(still ? 0 : sp.vy);
      else this.shelf.dragEnd(still ? 0 : sp.vx);
      return;
    }
    if (e.type === 'pointercancel') return;
    // tap / click on the shelf: the face-out book opens; a spine is brought forward first; a section's label
    // brings that section; a shelf's name plate opens the shelf's settings
    // a flag on the face-out book: the first tap raises it, a second opens the book there
    const fh = this.shelf.pickFlag(e.clientX, e.clientY);
    if (fh) return void this.flagTap(fh, 'shelf');
    this.clearPeek();
    const hit = this.shelf.pick(this.ndc(e.clientX, e.clientY));
    if (!hit) return;
    if (hit.tab) return void this.shelf.select(hit.tab.section.from);
    if (hit.plate) return void this.ui.openShelfPanel(hit.plate.row);
    if (hit.entry.row !== this.shelf.r) {
      // a book on another shelf of the bookcase: go there
      this.shelf.selectById(hit.entry.meta.id);
      return;
    }
    const i = this.shelf.entryIndex(hit.entry);
    if (i === this.shelf.selected && Math.abs(hit.entry.yaw) < 0.3) this.openSelected();
    else this.shelf.select(i);
  }

  /** A carried book was put down: give it its place in your own order. */
  placeLifted(res) {
    if (!res) return Promise.resolve();
    let changed;
    // on your own shelves a book can be carried into another section
    const meta = res.entry.meta;
    const newSection = res.section !== undefined && (meta.section || '') !== res.section;
    if (newSection) meta.section = res.section || null;
    if (this.sort !== 'manual') {
      // from now on the shelf keeps the order you make; start from what it shows (with the move)
      const shown = [];
      for (const r of this.shelf.rows) for (const e of r.entries) shown.push(e.meta);
      const rest = this.metas.filter((m) => !shown.includes(m));
      changed = seedManualOrder([...shown, ...rest]);
      this.sort = 'manual';
      this.reverse = false;
      setPref('sort', this.sort);
      setPref('reverse', '0');
      this.ui.setSortLabel(this.arrangeLabel());
    } else {
      res.entry.meta.order = orderBetween(res.prev && res.prev.meta, res.next && res.next.meta);
      changed = [res.entry.meta];
    }
    if (newSection && !changed.includes(meta)) changed.push(meta);
    this.ui.setTitles(this.shelf.entries.map((x) => x.meta));
    if (newSection) {
      this.ui.toast(meta.section ? `In the section “${meta.section}”` : 'Out of its section', 1800);
      // a section may have emptied: stand the shelf again from the books
      this.arrange(meta.id, { animate: true });
    }
    this.invalidate();
    return store.putBooks(changed).catch((e) => console.warn('save order', e));
  }

  shelfHover(x, y) {
    const hit = this.shelf.pickFlag(x, y) || this.shelf.pick(this.ndc(x, y));
    this.canvas.style.cursor = hit ? 'pointer' : 'default';
  }

  onWheel(e) {
    e.preventDefault();
    if (this.reader.isOpen) {
      this.reader.wheel(e);
      return;
    }
    // in the bookcase, a vertical wheel moves between shelves (one shelf per gesture)
    if (this.shelf.mode === 'case' && Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.5) {
      const now = performance.now();
      if (Math.abs(e.deltaY) > 4 && now - (this.rowWheelT || 0) > 380) this.shelf.stepRow(e.deltaY > 0 ? 1 : -1);
      if (Math.abs(e.deltaY) > 4) this.rowWheelT = now;
      return;
    }
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.shelf.wheel(e.deltaMode === 1 ? d * 30 : d);
  }

  onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape' && !document.getElementById('add-menu').hidden) {
      this.ui.toggleAddMenu(false);
      return;
    }
    if (e.key === 'Escape' && this.peek) {
      this.clearPeek();
      return;
    }
    if (e.key === 'Escape' && !document.getElementById('goto').hidden) {
      this.ui.toggleGoto(false);
      return;
    }
    if (e.key === 'Escape' && !document.getElementById('arrange-pop').hidden) {
      this.ui.toggleArrangePop(false);
      return;
    }
    if (e.key === 'Escape' && !document.getElementById('light-pop').hidden) {
      this.ui.toggleLightPop(false);
      return;
    }
    if (e.key === 'Escape' && !document.getElementById('ink-pop').hidden) {
      this.ui.toggleInkPop(false);
      return;
    }
    if (e.key === 'l' || (e.key === 'c' && this.reader.isOpen)) {
      this.ui.toggleLightPop();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && this.ui.panelMode) {
      this.ui.closePanel();
      return;
    }
    if (this.reader.isOpen) {
      if (e.key === 'm') {
        this.toggleMagnifier();
        e.preventDefault();
        return;
      }
      if (e.key === 's' && !e.metaKey && !e.ctrlKey) {
        this.toggleReadAlone();
        e.preventDefault();
        return;
      }
      if (this.reader.key(e)) e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowRight':
        this.shelf.step(1);
        e.preventDefault();
        break;
      case 'ArrowLeft':
        this.shelf.step(-1);
        e.preventDefault();
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        if (this.shelf.mode === 'case') {
          this.shelf.stepRow(e.key === 'ArrowDown' ? 1 : -1);
          e.preventDefault();
        }
        break;
      case 'Enter':
      case ' ':
        this.openSelected();
        e.preventDefault();
        break;
      case 'd':
        this.ui.openDetails(this.currentMeta());
        break;
      case 'i':
        this.ui.openIndex();
        break;
      case 'o':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          this.pickFiles();
        }
        break;
    }
  }

  /** The reading light's mix of the room, passed on to the paper's and the bindings' own lights. */
  onRoomLight(keyK, ambientK) {
    setPaperRoomLight(this.shared.paper, keyK);
    setBindingRoomLight(ambientK);
  }

  /** The candle (kept for scripts and old tests). */
  get candle() {
    return this.lighting.candle;
  }
  lightCandle(minutes) {
    this.lighting.lightCandle(minutes);
    this.ui.syncLight(this.lighting);
  }

  /** Debug/testing: step the simulation by `sec` seconds without waiting for frames. */
  advance(sec, step = 1 / 60) {
    const n = Math.max(1, Math.round(sec / step));
    for (let i = 0; i < n; i++) {
      const dt = sec / n;
      this.clock += dt;
      this.shelf.update(dt);
      this.reader.update(dt, this.clock);
      this.lighting.update(dt, this.camera);
    }
    this.invalidate();
  }

  // ================================================================= loop
  frame(tms) {
    requestAnimationFrame((t) => this.frame(t));
    if (document.hidden) return;
    const t = tms / 1000;
    const dt = Math.min(0.05, Math.max(0, t - this.lastT)) * this.timeScale;
    this.lastT = t;
    this.clock += dt;

    let busy = false;
    if (this.shelf.update(dt)) busy = true;
    if (this.reader.update(dt, this.clock)) busy = true;
    if (this.magnifier.enabled && this.magnifier.update(dt)) busy = true;
    const lightFps = this.lighting.update(dt, this.camera);
    if (this.lighting.candleLit && t - (this.lightUiT || 0) > 0.5) {
      this.lightUiT = t;
      this.ui.syncLight(this.lighting);
    }

    // pending open once the shelf has settled
    if (this.pending && this.pending.id && !this.pending.page && !this.reader.isOpen) {
      const e = this.shelf.entries[this.shelf.selected];
      if (e && e.meta.id === this.pending.id && Math.abs(this.shelf.p - this.shelf.selected) < 0.02 && Math.abs(e.yaw) < 0.04) {
        const at = this.pending.at ?? null;
        this.pending = null;
        this.reader.open(e, { at });
      }
    }

    // titles follow the shelf
    this.ui.updateTitles(this.shelf.p, this.shelf.selected);
    if (this.peek) this.placePeek();

    // camera: zoom/pan while reading
    const cam = this.camera;
    const z = this.reader.isOpen ? this.reader.zoom : 1;
    const px = this.reader.isOpen ? this.reader.pan.x : 0;
    const py = this.reader.isOpen ? this.reader.pan.y : 0;
    if (cam.zoom !== z || cam.position.x !== this.cameraBase.x + px || cam.position.y !== this.cameraBase.y + py) {
      cam.zoom = z;
      cam.position.set(this.cameraBase.x + px, this.cameraBase.y + py, this.cameraBase.z);
      cam.updateProjectionMatrix();
      busy = true;
    }
    // softer shadows on the shelf, crisper ones under a turning leaf
    const wantRadius = this.reader.isOpen && this.reader.phase === 'reading' ? 3 : 8;
    if (this.key.shadow.radius !== wantRadius) {
      this.key.shadow.radius += (wantRadius - this.key.shadow.radius) * Math.min(1, dt * 4);
      if (Math.abs(this.key.shadow.radius - wantRadius) < 0.05) this.key.shadow.radius = wantRadius;
      busy = true;
    }

    if (busy) this.dirty = Math.max(this.dirty, 2);
    // a light alone needs only the frames it asks for (a flame 30 a second, leaves 20, a lamp none):
    // kinder to the battery during a long sitting
    if (lightFps && !busy && this.dirty === 0 && t - (this.lastRenderT || 0) >= 1 / (lightFps + 1)) this.dirty = 1;
    if (this.dirty > 0) {
      this.lastRenderT = t;
      this.dirty--;
      if (this.magnifier.enabled && this.reader.isOpen) this.magnifier.render(this.renderer, this.scene, cam);
      else this.renderer.render(this.scene, cam);
    }
  }
}

const app = new App();
window.folio = app;
app.init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<p style="position:fixed;left:16px;bottom:60px;font:12px monospace">Could not start: ${String(err.message || err)}</p>`);
});

// Offline support. Service workers need a secure context (https:// or localhost); add ?dev to the URL
// while editing the app so a cached copy never shadows your changes.
if ('serviceWorker' in navigator && window.isSecureContext && !new URLSearchParams(location.search).has('dev')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

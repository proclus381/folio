// The shelf: books standing on a plank, spines to camera, the selected one turned face-out and pulled forward.
//
// What stands where comes from arrange.js: one row (optionally in sections, each named by a brass label on
// the plank's edge) or a bookcase of rows, one per shelf, stacked — swipe up and down between them. Books keep
// their 3D models when the arrangement changes and glide to their new places. A book can be lifted (press and
// hold) and carried along its row to a new place.

import * as THREE from 'three';
import { BookModel, bookDims, makeBookMaterials, restyleBookMaterials, SHELF_SCALE } from './book3d.js';
import { setBindingArt } from './binding.js';
import { makeClothCoverCanvas, makeImageCoverCanvas, makeSpineCanvas, stampedTexture } from './textures.js';
import { makeBookend, makeLabel, makePlank, labelText } from './shelfdeco.js';
import { flagsOf, shelfFlagMesh, flagScreenBox, pickBox } from './markers.js';

import { clamp, smoothDamp, smoothstep } from './anim.js';
import * as store from './store.js';

export const SHELF_Z = -36; // spine plane
const FACE_PULL = 5; // face-out book comes forward this much
const SPINE_GAP = 0.36;
const FACE_GAP = 0.7;
const SECTION_GAP = 2.6; // between sections of a row
const S = SHELF_SCALE;
export const BASE_Y = -9.35; // the plank's top: books stand on it
export const ROW_SPACING = 24.5; // shelf to shelf in the bookcase
const FRONT_Z = SHELF_Z + FACE_PULL + 0.55; // the plank's front edge, just in front of a face-out cover
const BACK_Z = SHELF_Z - 14.2;
const LABEL_H = 0.92;

function newRow(src = {}) {
  return { key: 'all', label: '', shelfId: null, entries: [], sections: null, editableSections: false, p: 0, pTarget: 0, pv: { v: 0 }, selected: -1, deco: null, ...src };
}

export class Shelf {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = 'shelf';
    app.scene.add(this.group);
    this.all = new Map(); // book id → entry, kept across arrangements
    this.rows = [newRow()];
    this.mode = 'row';
    this.r = 0; // the current row (bookcase)
    this.rowPos = 0; // where the bookcase stands (rows), eased
    this.rowV = { v: 0 };
    this.rowDragging = false;
    this.dragging = false;
    this.gliding = false;
    this.wheelTimer = 0;
    this.lastStep = 0;
    this.openGap = 0; // 0..1 how far the neighbours are pushed apart for an open book
    this.openGapWidth = 0; // world units each side
    // reading alone: the open book's neighbours walk off the screen (wanted 0/1, eased; it rides on openGap,
    // so they leave as the book comes out and come back as it goes home)
    this.alone = false;
    this.aloneK = 0;
    this.aloneV = { v: 0 };
    this.hiddenEntry = null;
    this.onSelect = null;
    this.onRowChange = null;
    this.ghosts = [];
    this.raycaster = new THREE.Raycaster();
    this.plankStyle = 'none';
    this.rowSpacing = ROW_SPACING;
    this.dark = false;
    this.lift = null;
  }

  // the current row's state, under the names the rest of the app has always used
  get row() {
    return this.rows[this.r] || this.rows[0];
  }
  get entries() {
    return this.row.entries;
  }
  get p() {
    return this.row.p;
  }
  set p(v) {
    this.row.p = v;
  }
  get pTarget() {
    return this.row.pTarget;
  }
  set pTarget(v) {
    this.row.pTarget = v;
  }
  get pv() {
    return this.row.pv;
  }
  get selected() {
    return this.row.selected;
  }
  set selected(v) {
    this.row.selected = v;
  }

  // ------------------------------------------------------------------ arranging
  /** Back-compat: one plain row of books. */
  setBooks(metas, selectId) {
    this.setLayout({ mode: 'row', rows: [{ key: 'all', label: '', metas, sections: null }] }, selectId);
  }

  /**
   * Stand the books as `layout` says (see arrange.layout). Books already on the shelf keep their models and,
   * with `animate`, glide from where they stood. `selectId`: the book to bring face-out.
   */
  setLayout(layout, selectId = null, { animate = false } = {}) {
    const before = new Map();
    if (animate) for (const [id, e] of this.all) if (e.slot.visible) before.set(id, e.slot.position.clone());
    const prevRows = new Map(this.rows.map((r) => [r.key, r]));
    const prevKey = this.row.key;
    const prevSel = this.entries[this.selected];
    const keep = new Set();
    const rows = layout.rows.map((lr) => {
      const entries = lr.metas.map((meta) => {
        let e = this.all.get(meta.id);
        if (e && (e.d.pages !== meta.pages || e.d.aspect !== bookDims(meta.pages, meta.aspect).aspect)) {
          this.disposeEntry(e);
          e = null;
        }
        if (!e) {
          e = this.buildEntry(meta);
          this.all.set(meta.id, e);
        }
        e.meta = meta;
        keep.add(meta.id);
        this.syncMarkers(e);
        return e;
      });
      const old = prevRows.get(lr.key);
      const row = newRow({
        key: lr.key,
        label: lr.label || '',
        shelfId: lr.shelfId ?? null,
        entries,
        sections: lr.sections ? lr.sections.map((x) => ({ ...x })) : null,
        editableSections: !!lr.editableSections,
      });
      // each shelf keeps its place; otherwise the selected book (or the start)
      let idx = old ? clamp(Math.round(old.pTarget), 0, Math.max(0, entries.length - 1)) : 0;
      const want = selectId || (prevSel && prevSel.meta.id);
      const wi = want ? entries.findIndex((x) => x.meta.id === want) : -1;
      if (wi >= 0 && (!old || selectId || prevKey === lr.key)) idx = wi;
      row.p = row.pTarget = idx;
      return row;
    });
    for (const [id, e] of this.all)
      if (!keep.has(id) && e !== this.hiddenEntry) {
        this.disposeEntry(e);
        this.all.delete(id);
      }
    for (const r of this.rows) this.disposeDeco(r);
    this.rows = rows.length ? rows : [newRow()];
    this.mode = layout.mode;
    // the current row: the one holding the book asked for, else the same shelf as before, else the first
    let r = selectId ? this.rows.findIndex((x) => x.entries.some((e) => e.meta.id === selectId)) : -1;
    if (r < 0) r = this.rows.findIndex((x) => x.key === prevKey);
    if (r < 0) r = 0;
    this.r = r;
    this.rowPos = r;
    this.rowV.v = 0;
    this.lift = null;
    // books not in the current row stand as spines from the start
    this.rows.forEach((row, ri) =>
      row.entries.forEach((e, i) => {
        e.row = ri;
        e.yaw = ri === r && i === Math.round(row.p) ? 0 : Math.PI / 2;
        e.yawV.v = 0;
        if (!animate) e.off = null;
      }),
    );
    this.clearGhosts();
    if (!this.all.size) this.buildGhosts();
    for (const row of this.rows) this.buildDeco(row);
    this.update(0, true);
    if (animate)
      for (const [id, old] of before) {
        const e = this.all.get(id);
        if (!e || !e.slot.visible) continue;
        const off = old.sub(e.slot.position);
        if (off.lengthSq() > 1e-4) e.off = off;
      }
    this.onRowChange && this.onRowChange(this.row);
    const sel = this.entries[this.selected];
    if (sel) this.onSelect && this.onSelect(sel, this.selected);
  }

  buildEntry(meta) {
    const app = this.app;
    const d = bookDims(meta.pages, meta.aspect);
    const look = meta.look;
    const arc = d.T + 0.35;
    const tex = { spine: spineTexture(meta, look, arc, d.Hc, app.maxAniso) };
    const mats = makeBookMaterials(look, tex, app.shared, d); // the cover shows plain binding until its art exists
    const model = new BookModel(d, mats, { withLeftStack: false });
    model.set(Math.PI, 0, 0);
    const slot = new THREE.Group();
    slot.scale.setScalar(S);
    model.group.position.copy(d.center).multiplyScalar(-1);
    slot.add(model.group);
    this.group.add(slot);
    const e = { meta, d, look, tex, mats, model, slot, yaw: Math.PI / 2, yawV: { v: 0 }, coverState: 'none', x: 0, z: SHELF_Z, row: 0, off: null, marks: null };
    for (const m of model.pickables()) m.userData.entry = e;
    this.syncMarkers(e);
    return e;
  }

  buildGhosts() {
    // A quiet row of blank volumes for an empty library.
    const metas = [];
    for (let i = 0; i < 9; i++) {
      metas.push({ pages: 160 + ((i * 97) % 300), aspect: 0.66 + (i % 3) * 0.03 });
    }
    for (let i = 0; i < metas.length; i++) {
      const d = bookDims(metas[i].pages, metas[i].aspect);
      const tone = [0xdcd9d1, 0xd5d1c8, 0xe0ddd5, 0xd2cec4][i % 4];
      const mat = new THREE.MeshStandardMaterial({ color: tone, roughness: 0.92 });
      const mats = { cover: mat, back: mat, cloth: mat, endpaper: mat, spine: mat, paper: mat, edge: mat };
      const model = new BookModel(d, mats, { withLeftStack: false });
      model.set(Math.PI, 0, 0);
      const slot = new THREE.Group();
      slot.scale.setScalar(S);
      model.group.position.copy(d.center).multiplyScalar(-1);
      slot.add(model.group);
      slot.rotation.y = Math.PI / 2;
      this.group.add(slot);
      this.ghosts.push({ slot, model, d, mat });
    }
    let x = 0;
    const widths = this.ghosts.map((g) => g.d.T * S + SPINE_GAP);
    const total = widths.reduce((a, b) => a + b, 0);
    x = -total / 2;
    this.ghosts.forEach((g, i) => {
      g.slot.position.set(x + widths[i] / 2, BASE_Y + (g.d.Hc * S) / 2, SHELF_Z - (g.d.closedW * S) / 2);
      x += widths[i];
    });
  }

  clearGhosts() {
    for (const g of this.ghosts) {
      this.group.remove(g.slot);
      g.model.dispose();
      g.mat.dispose();
    }
    this.ghosts = [];
  }

  disposeEntry(e) {
    this.clearMarkers(e);
    this.group.remove(e.slot);
    e.model.dispose();
    for (const k of ['cover', 'back', 'cloth', 'endpaper', 'spine']) e.mats[k].dispose();
    e.tex.spine.dispose();
    if (e.coverTex) e.coverTex.dispose();
  }

  /** Re-render the generated textures of one book (after title/look edits). */
  refreshEntry(meta) {
    const e = this.all.get(meta.id);
    if (!e) return;
    e.meta = meta;
    e.look = meta.look;
    e.tex.spine.dispose();
    e.tex.spine = spineTexture(meta, meta.look, e.d.T + 0.35, e.d.Hc, this.app.maxAniso);
    setBindingArt(e.mats.spine, e.tex.spine);
    restyleBookMaterials(e.mats, meta.look);
    this.releaseCover(e);
    this.ensureCover(e);
    this.syncMarkers(e);
  }

  // ------------------------------------------------------------------ flags
  /** A book's flags (the spreads you bookmarked, sticking out of the top). Rebuilt only when they change. */
  syncMarkers(e) {
    const flags = flagsOf(e.meta);
    const sig = `${e.liftedFlag || ''}|${flags.map((f) => f.key + f.u.toFixed(3)).join(',')}`;
    if (e.marks && e.marks.sig === sig) return;
    this.clearMarkers(e);
    const marks = { sig, flags, flagMesh: null, items: [] };
    const fm = shelfFlagMesh(e.d, flags, e.liftedFlag || null);
    if (fm) {
      marks.flagMesh = fm.mesh;
      marks.items = fm.items;
      e.model.group.add(fm.mesh);
    }
    e.marks = marks;
    this.app.invalidate();
  }

  clearMarkers(e) {
    const k = e.marks;
    if (!k) return;
    if (k.flagMesh) {
      e.model.group.remove(k.flagMesh);
      k.flagMesh.geometry.dispose();
    }
    e.marks = null;
  }

  /** Raise one flag of a book (a first tap on it), or lower it (key null). */
  liftFlag(e, key) {
    if (!e || (e.liftedFlag || null) === key) return;
    e.liftedFlag = key;
    this.syncMarkers(e);
  }

  /** The flags of the face-out book on screen: [{ flag, box }]. */
  flagBoxes(e = this.entries[this.selected]) {
    if (!e || !e.marks || !e.marks.items.length || !e.slot.visible || Math.abs(e.yaw) > 0.15) return [];
    const app = this.app;
    e.model.group.updateWorldMatrix(true, false);
    const mw = new THREE.Matrix4();
    // only what shows above the boards: a tap on the cover is a tap on the book
    const above = (e.d.Hc - e.d.Hp) / 2 + 0.05;
    return e.marks.items.map((it) => ({ flag: it.flag, box: flagScreenBox(mw.multiplyMatrices(e.model.group.matrixWorld, it.matrix), app.camera, app.width, app.height, above) }));
  }

  /** A flag of the face-out book under a tap: { entry, flag } or null. */
  pickFlag(x, y) {
    const e = this.entries[this.selected];
    if (!e || this.lift || this.dragging) return null;
    const hit = pickBox(this.flagBoxes(e), x, y, this.app.isTouch ? 10 : 4);
    return hit ? { entry: e, flag: hit.flag } : null;
  }

  // ------------------------------------------------------------------ the furniture
  /** Plank style ('none' | 'painted' | 'oak' | 'glass') and theme (the painted plank follows it). */
  setPlank(style, dark) {
    if (style === this.plankStyle && dark === this.dark) return;
    this.plankStyle = style;
    this.dark = dark;
    for (const r of this.rows) {
      this.disposeDeco(r);
      this.buildDeco(r);
    }
    this.update(0, true);
  }

  buildDeco(row) {
    const deco = { plank: makePlank(this.plankStyle, this.dark, BACK_Z, FRONT_Z), ends: [], labels: [] };
    if (deco.plank) this.group.add(deco.plank);
    if (row.entries.length) {
      for (const side of [-1, 1]) {
        const b = makeBookend(13);
        if (side > 0) b.rotation.y = Math.PI;
        this.group.add(b);
        deco.ends.push(b);
      }
    }
    // section labels (a row in sections, or the named sections of one of your shelves) and the shelf's name
    // plate (the bookcase)
    if (row.sections && (row.sections.length > 1 || row.editableSections)) {
      row.sections.forEach((s, i) => {
        if (!s.label) return; // a shelf's books outside any section stand first, unlabelled
        const m = makeLabel(labelText(s.label), LABEL_H);
        m.userData.tab = { section: i };
        this.group.add(m);
        deco.labels.push(m);
      });
    }
    if (this.mode === 'case') {
      const m = makeLabel(labelText(row.label) || 'Shelf', LABEL_H * 1.15, { strong: true });
      m.userData.plate = { row };
      this.group.add(m);
      deco.plate = m;
    }
    row.deco = deco;
  }

  disposeDeco(row) {
    const d = row.deco;
    if (!d) return;
    if (d.plank) {
      this.group.remove(d.plank);
      d.plank.traverse((o) => o.geometry && o.geometry.dispose());
      for (const m of d.plank.userData.mats) if (!m.map || !m.map.isCanvasTexture || m.map.image.width !== 1024) m.dispose();
    }
    for (const b of d.ends) this.group.remove(b);
    for (const l of d.labels) {
      this.group.remove(l);
      l.userData.dispose();
    }
    if (d.plate) {
      this.group.remove(d.plate);
      d.plate.userData.dispose();
    }
    row.deco = null;
  }

  // ------------------------------------------------------------------ covers (lazy)
  ensureCover(e) {
    if (e.coverState !== 'none') return;
    e.coverState = 'loading';
    const finish = (color, mask = null) => {
      if (e.coverState !== 'loading') return;
      e.coverTex = stampedTexture(color, mask, this.app.maxAniso);
      setBindingArt(e.mats.cover, e.coverTex);
      e.mats.cover.color.set(0xffffff);
      e.coverState = 'ready';
      this.app.invalidate();
    };
    const boardAspect = e.d.Wc / e.d.Hc;
    // a typeset cover is stamped into the binding; a PDF's own cover is printed on it
    const typeset = () => finish(makeClothCoverCanvas(e.meta, e.look, boardAspect), makeClothCoverCanvas(e.meta, e.look, boardAspect, true));
    if (e.look.coverMode === 'image') {
      store
        .getCover(e.meta.id)
        .then((blob) => (blob ? createImageBitmap(blob) : null))
        .then((img) => {
          if (img) {
            finish(makeImageCoverCanvas(img, boardAspect));
            img.close && img.close();
          } else typeset();
        })
        .catch(typeset);
    } else typeset();
  }

  releaseCover(e) {
    if (e.coverTex) e.coverTex.dispose();
    e.coverTex = null;
    setBindingArt(e.mats.cover, null);
    e.mats.cover.color.set(e.look.cloth);
    e.coverState = 'none';
  }

  /**
   * Where the reading lights stand while the shelf is showing (the same fields as Reader.lightLayout):
   * around the face-out book, on the plank in front of the shelf; windows and fire light the whole row.
   */
  lightLayout() {
    const app = this.app;
    const e = this.entries[this.selected];
    const d = e ? e.d : bookDims(300, 0.7);
    const front = SHELF_Z + FACE_PULL; // the face-out cover
    const rowY = (this.rowPos - this.r) * this.rowSpacing;
    const halfWAt = (z) => Math.tan(((app.camera.fov * Math.PI) / 180) / 2) * (app.cameraBase.z - z) * (app.width / app.height);
    return {
      s: S,
      cx: app.cameraBase.x,
      edge: (d.closedW * S) / 2,
      span: halfWAt(SHELF_Z) * 0.75,
      bottomY: rowY + BASE_Y + 0.2,
      topY: rowY + BASE_Y + d.Hc * S,
      nearZ: front,
      farZ: front - d.T * S,
      camX: app.cameraBase.x,
      halfWAt,
      center: new THREE.Vector3(app.cameraBase.x, rowY + BASE_Y + (d.Hc * S) / 2, front),
      R: new THREE.Vector3(1, 0, 0),
      U: new THREE.Vector3(0, 1, 0),
      N: new THREE.Vector3(0, 0, 1),
    };
  }

  // ------------------------------------------------------------------ navigation
  get count() {
    return this.entries.length;
  }

  select(i, { instant = false } = {}) {
    if (!this.entries.length) return;
    i = clamp(Math.round(i), 0, this.entries.length - 1);
    this.pTarget = i;
    this.gliding = true;
    if (instant) {
      this.p = i;
      this.pv.v = 0;
    }
    this.app.invalidate();
  }

  /** Bring a book face-out, moving to its shelf first if it stands on another. */
  selectById(id) {
    const ri = this.rows.findIndex((r) => r.entries.some((e) => e.meta.id === id));
    if (ri < 0) return false;
    if (ri !== this.r) this.goToRow(ri);
    this.select(this.entries.findIndex((e) => e.meta.id === id));
    return true;
  }

  step(dir) {
    const t = performance.now();
    if (t - this.lastStep < 150) return;
    this.lastStep = t;
    this.select(Math.round(this.pTarget) + dir);
  }

  wheel(delta) {
    if (!this.entries.length) return;
    this.gliding = false;
    this.pTarget = clamp(this.pTarget + delta * 0.0042, -0.35, this.entries.length - 1 + 0.35);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.select(Math.round(this.pTarget));
    }, 140);
    this.app.invalidate();
  }

  dragStart() {
    this.dragging = true;
    this.dragP0 = this.pTarget;
    this.gliding = false;
  }

  dragMove(dxPx) {
    if (!this.dragging) return;
    const worldPerPx = this.app.worldPerPx(SHELF_Z);
    const pitch = 3.06; // world units per spine
    this.pTarget = clamp(this.dragP0 - (dxPx * worldPerPx) / pitch, -0.45, this.entries.length - 1 + 0.45);
    this.app.invalidate();
  }

  dragEnd(vxPx) {
    if (!this.dragging) return;
    this.dragging = false;
    const worldPerPx = this.app.worldPerPx(SHELF_Z);
    const fling = (-vxPx * worldPerPx) / 3.06; // books per second
    this.select(Math.round(this.pTarget + fling * 0.22));
  }

  // the bookcase: up and down between shelves
  get rowCount() {
    return this.rows.length;
  }
  goToRow(ri) {
    ri = clamp(Math.round(ri), 0, this.rows.length - 1);
    if (ri === this.r) return;
    // the shelf we leave turns its face-out book back to its spine
    this.r = ri;
    this.gliding = true;
    this.onRowChange && this.onRowChange(this.row);
    const sel = clamp(Math.round(this.row.p), 0, Math.max(0, this.entries.length - 1));
    this.selected = -1; // re-announced by update
    this.row.pTarget = sel;
    this.app.invalidate();
  }
  stepRow(dir) {
    this.goToRow(this.r + dir);
  }
  rowDragStart() {
    this.rowDragging = true;
    this.rowPos0 = this.rowPos;
  }
  rowDragMove(dyPx) {
    if (!this.rowDragging) return;
    const wpp = this.app.worldPerPx(SHELF_Z);
    // the finger carries the bookcase: up shows the shelf below
    this.rowPos = clamp(this.rowPos0 - (dyPx * wpp) / this.rowSpacing, -0.35, this.rows.length - 1 + 0.35);
    this.app.invalidate();
  }
  rowDragEnd(vyPx) {
    if (!this.rowDragging) return;
    this.rowDragging = false;
    const wpp = this.app.worldPerPx(SHELF_Z);
    const fling = (-vyPx * wpp) / this.rowSpacing;
    // a fifth of a shelf, or a flick, is enough to go to the next one
    const moved = this.rowPos - this.r + clamp(fling * 0.25, -1, 1);
    const target = Math.abs(moved) > 0.2 ? this.r + Math.sign(moved) * Math.max(1, Math.round(Math.abs(moved))) : this.r;
    if (target !== this.r) this.goToRow(target);
    this.app.invalidate();
  }

  // ------------------------------------------------------------------ lifting a book to move it
  /** Press and hold: the book comes off the shelf and follows the finger along its row. */
  liftStart(entry, clientX) {
    const i = this.entries.indexOf(entry);
    if (i < 0) return false;
    this.lift = { entry, x: entry.x, edge: 0, start: i };
    this.gliding = false;
    this.app.invalidate();
    return true;
  }

  liftMove(clientX) {
    const L = this.lift;
    if (!L) return;
    const app = this.app;
    L.x = (clientX - app.width / 2) * app.worldPerPx(SHELF_Z);
    const f = clientX / app.width;
    L.edge = f < 0.12 ? -1 : f > 0.88 ? 1 : 0;
    this.reorderLifted();
    app.invalidate();
  }

  /**
   * Swap the lifted book past its neighbours as it is carried over them. It stays in its section, except on
   * your own shelves, where carrying it over a section's first (or last) book moves it into that section.
   */
  reorderLifted() {
    const L = this.lift;
    const list = this.entries;
    const secs = this.row.sections;
    const secOf = (i) => (secs ? secs.findIndex((s) => i >= s.from && i < s.to) : 0);
    const cross = this.row.editableSections && secs;
    const me = L.entry;
    for (let guard = 0; guard < 400; guard++) {
      const i = list.indexOf(me);
      const next = list[i + 1];
      const prev = list[i - 1];
      const a = secOf(i);
      if (next && secOf(i + 1) === a && L.x > next.x) [list[i], list[i + 1]] = [next, list[i]];
      else if (prev && secOf(i - 1) === a && L.x < prev.x) [list[i], list[i - 1]] = [prev, list[i]];
      else if (cross && next && secOf(i + 1) !== a && L.x > (me.x + me.footprint / 2 + next.x - next.footprint / 2) / 2) {
        // over the gap: it becomes the first book of the next section (skipping empty ones); one step a frame,
        // so the gap has moved before it can go further
        let b = a + 1;
        while (b < secs.length - 1 && secs[b].to <= secs[b].from) b++;
        secs[a].to--;
        for (let k = a + 1; k <= b; k++) secs[k].from = i;
        for (let k = a + 1; k < b; k++) secs[k].to = i;
        L.moved = true;
        break;
      } else if (cross && prev && secOf(i - 1) !== a && L.x < (me.x - me.footprint / 2 + prev.x + prev.footprint / 2) / 2) {
        let b = a - 1;
        while (b > 0 && secs[b].to <= secs[b].from) b--;
        secs[a].from++;
        for (let k = b; k < a; k++) secs[k].to = i + 1;
        for (let k = b + 1; k < a; k++) secs[k].from = i + 1;
        L.moved = true;
        break;
      } else break;
    }
  }

  /** The section (label) a book of the current row stands in. */
  sectionOf(entry) {
    const secs = this.row.sections;
    const i = this.entries.indexOf(entry);
    if (!secs || i < 0) return '';
    const s = secs.find((x) => i >= x.from && i < x.to);
    return s ? s.label : '';
  }

  /**
   * Put it down. Returns { entry, prev, next, section } (its neighbours in its section now, and the section's
   * name on your own shelves) if it moved.
   */
  liftEnd() {
    const L = this.lift;
    if (!L) return null;
    this.lift = null;
    const i = this.entries.indexOf(L.entry);
    this.select(i);
    this.app.invalidate();
    if (i === L.start && !L.moved) return null;
    const secs = this.row.sections;
    const sec = secs ? secs.find((x) => i >= x.from && i < x.to) : null;
    const inSec = (j) => !sec || (j >= sec.from && j < sec.to);
    return {
      entry: L.entry,
      prev: inSec(i - 1) ? this.entries[i - 1] || null : null,
      next: inSec(i + 1) ? this.entries[i + 1] || null : null,
      section: this.row.editableSections ? (sec ? sec.label : '') : undefined,
    };
  }

  // ------------------------------------------------------------------ frame
  update(dt, force = false) {
    let moving = force;
    // the bookcase eases to its shelf
    if (!this.rowDragging) {
      const before = this.rowPos;
      this.rowPos = dt > 0 ? smoothDamp(this.rowPos, this.r, this.rowV, 0.26, dt) : this.r;
      if (Math.abs(this.rowPos - this.r) < 0.0008 && Math.abs(this.rowV.v) < 0.002) this.rowPos = this.r;
      if (Math.abs(this.rowPos - before) > 1e-6) moving = true;
    } else moving = true;
    const aloneTo = this.alone ? 1 : 0;
    if (this.aloneK !== aloneTo) {
      this.aloneK = dt > 0 ? smoothDamp(this.aloneK, aloneTo, this.aloneV, 0.3, dt) : aloneTo;
      if (Math.abs(this.aloneK - aloneTo) < 0.001 && Math.abs(this.aloneV.v) < 0.005) this.aloneK = aloneTo;
      moving = true;
    }
    // carrying a book to an edge scrolls the row under it
    if (this.lift && this.lift.edge && dt > 0) {
      this.pTarget = clamp(this.pTarget + this.lift.edge * dt * 7, 0, Math.max(0, this.entries.length - 1));
      this.reorderLifted();
      moving = true;
    }
    for (let ri = 0; ri < this.rows.length; ri++) if (this.updateRow(this.rows[ri], ri, dt)) moving = true;
    // arranged books glide in from where they stood
    for (const e of this.all.values())
      if (e.off) {
        e.off.multiplyScalar(dt > 0 ? Math.exp(-dt * 5.5) : 1);
        if (e.off.lengthSq() < 1e-4) e.off = null;
        else {
          e.slot.position.add(e.off);
          moving = true;
        }
      }
    return moving || this.dragging;
  }

  updateRow(row, ri, dt) {
    const n = row.entries.length;
    const current = ri === this.r;
    const rowY = (this.rowPos - ri) * this.rowSpacing;
    // the shelf below peeks in at the bottom; the one above stays out of the header until you go to it. On a
    // tall screen the one below would run under the footer, so there it only shows while the bookcase moves;
    // while a book is open only its own shelf stands (the reader bar sits where the next would peek in)
    const rel = ri - this.rowPos;
    const app = this.app;
    const caseMoving = this.rowDragging || Math.abs(this.rowPos - this.r) > 0.02;
    const below = app.reader && app.reader.isOpen ? 0.55 : caseMoving || app.width > app.height ? 1.7 : 0.55;
    const visible = rel > -0.55 && rel < below;
    this.updateDeco(row, rowY, visible);
    if (!n) return false;
    let moving = false;
    if (current) {
      const before = row.p;
      if (dt > 0) row.p = smoothDamp(row.p, row.pTarget, row.pv, this.dragging ? 0.06 : this.gliding ? 0.22 : 0.12, dt);
      if (Math.abs(row.p - before) > 1e-5) moving = true;
      if (Math.abs(row.p - row.pTarget) < 0.0005 && Math.abs(row.pv.v) < 0.001) {
        row.p = row.pTarget;
        this.gliding = false;
      }
    }
    const pc = clamp(row.p, 0, n - 1);

    // selection follows the nearest book
    if (current) {
      const sel = clamp(Math.round(pc), 0, n - 1);
      if (sel !== row.selected) {
        row.selected = sel;
        this.onSelect && this.onSelect(row.entries[sel], sel);
      }
    }

    // yaws: face-out amount from distance to the continuous position (only on the current shelf, and not
    // while a book is being carried)
    const smoothT = this.gliding ? 0.36 : this.dragging ? 0.12 : 0.2;
    const faceAllowed = current && !this.lift;
    for (let i = 0; i < n; i++) {
      const e = row.entries[i];
      const f = faceAllowed ? smoothstep(0, 1, clamp(1 - Math.abs(i - pc), 0, 1)) : 0;
      const target = (Math.PI / 2) * (1 - f);
      const prev = e.yaw;
      e.yaw = dt > 0 ? smoothDamp(e.yaw, target, e.yawV, smoothT, dt) : target;
      if (Math.abs(e.yaw - prev) > 1e-5) moving = true;
      // lazily hold covers for books near the centre of the current shelf
      const dist = Math.abs(i - pc);
      if (current && dist < 4.5) this.ensureCover(e);
      else if ((dist > 8 || !current) && e.coverState === 'ready' && Math.abs(ri - this.rowPos) > 1.2) this.releaseCover(e);
    }

    // footprints, with a gap between sections
    const startsSection = new Set(row.sections ? row.sections.slice(1).map((s) => s.from) : []);
    let x = 0;
    const centers = new Array(n);
    for (let i = 0; i < n; i++) {
      const e = row.entries[i];
      if (startsSection.has(i)) x += SECTION_GAP;
      const c = Math.cos(e.yaw);
      const s = Math.sin(e.yaw);
      const face = c; // 1 when face-out
      const w = (Math.abs(c) * e.d.closedW + Math.abs(s) * e.d.T) * S + SPINE_GAP + (FACE_GAP - SPINE_GAP) * face;
      centers[i] = x + w / 2;
      x += w;
      e.footprint = w;
    }
    const i0 = Math.floor(pc);
    const i1 = Math.min(n - 1, i0 + 1);
    const fr = pc - i0;
    const cx = centers[i0] + (centers[i1] - centers[i0]) * fr;
    // reading alone, the neighbours go on past the screen's edges (half the view at the shelf, and a book more)
    const offK = current ? this.aloneK * this.openGap : 0;
    const offW = offK > 0 ? Math.tan(((app.camera.fov * Math.PI) / 180) / 2) * (app.cameraBase.z - SHELF_Z) * (app.width / app.height) + Math.abs(app.cameraBase.x) + 4 : 0;
    const gap = current ? this.openGapWidth * this.openGap + offW * offK : 0;
    const gone = offK > 0.995; // all off screen: stop drawing them
    const sel = row.selected;
    for (let i = 0; i < n; i++) {
      const e = row.entries[i];
      e.row = ri;
      let xi = centers[i] - cx;
      if (gap > 0 && i !== sel) xi += i < sel ? -gap : gap;
      const face = Math.cos(e.yaw);
      // the front-most face of every book sits on the shelf line (spines, or the cover when face-out);
      // the slot pivots at the book's centre, so step back by the rotated half-depth
      const halfDepth = (Math.abs(Math.sin(e.yaw)) * e.d.closedW + Math.abs(face) * e.d.T) * 0.5 * S;
      e.x = xi;
      e.z = SHELF_Z + FACE_PULL * Math.max(0, face) - halfDepth;
      let y = rowY + BASE_Y + (e.d.Hc * S) / 2;
      let px = xi;
      let pz = e.z;
      if (this.lift && this.lift.entry === e) {
        // carried: up off the plank, a little toward us, under the finger
        px = this.lift.x;
        y += 1.4;
        pz += 2.4;
        moving = true;
      }
      e.slot.position.set(px, y, pz);
      e.slot.rotation.y = e.yaw;
      e.slot.visible = visible && e !== this.hiddenEntry && !gone;
    }
    // bookends hug the row's ends; section labels sit on the plank's edge under their sections
    const d = row.deco;
    if (d && d.ends.length) {
      const first = row.entries[0];
      const last = row.entries[n - 1];
      const zMid = SHELF_Z - 6.4;
      d.ends[0].position.set(first.x - first.footprint / 2 - 0.05, rowY + BASE_Y, zMid);
      d.ends[1].position.set(last.x + last.footprint / 2 + 0.05, rowY + BASE_Y, zMid);
      for (const b of d.ends) b.visible = visible && !gone;
    }
    const reading = !!(this.app.reader && this.app.reader.isOpen);
    if (d && d.labels.length) {
      const yL = rowY + BASE_Y - (this.plankStyle === 'none' ? 0.7 : (d.plank ? d.plank.userData.thickness : 1.3) / 2);
      const placed = [];
      d.labels.forEach((m) => {
        const s = row.sections[m.userData.tab.section];
        if (!s || s.to <= s.from) return void (m.visible = false);
        const a = row.entries[s.from];
        const b = row.entries[s.to - 1];
        const x0 = a.x - a.footprint / 2;
        const x1 = b.x + b.footprint / 2;
        let mid = (x0 + x1) / 2;
        // the shelf's name plate (at the screen's left edge) keeps its place: a label reaching under it slides
        // right while it can stay under its own books, and steps aside when it can't
        const pl = d.plate && d.plate.visible ? d.plate : null;
        let hide = false;
        if (pl) {
          const half = m.userData.width / 2;
          const clear = pl.position.x + pl.userData.width / 2 + 0.3 + half;
          if (mid < clear && mid + half > pl.position.x - pl.userData.width / 2 - 0.3) {
            if (clear - half < x1 - 0.4) mid = clear;
            else hide = true;
          }
        }
        m.position.set(mid, yL, FRONT_Z + 0.03);
        // while a book is open the labels step away (they would hang in front of it)
        m.visible = visible && !hide && !reading;
        if (m.visible) placed.push({ m, l: mid - m.userData.width / 2, r: mid + m.userData.width / 2, own: current && row.selected >= s.from && row.selected < s.to });
      });
      // labels wider than their sections (one-book sections, long names) would run into each other: the face-out
      // book's label always shows, then the others from the middle out, each only if it touches none already shown
      placed.sort((p, q) => (q.own ? 1 : 0) - (p.own ? 1 : 0) || Math.abs(p.l + p.r) - Math.abs(q.l + q.r));
      const shown = [];
      for (const p of placed) {
        if (shown.some((q) => p.l < q.r + 0.35 && p.r > q.l - 0.35)) p.m.visible = false;
        else shown.push(p);
      }
    }
    return moving;
  }

  updateDeco(row, rowY, visible) {
    const d = row.deco;
    if (!d) return;
    if (d.plank) {
      d.plank.position.y = rowY + BASE_Y;
      d.plank.visible = visible;
    }
    if (d.plate) {
      const app = this.app;
      const halfW = Math.tan(((app.camera.fov * Math.PI) / 180) / 2) * (app.cameraBase.z - FRONT_Z) * (app.width / app.height);
      const t = d.plank ? d.plank.userData.thickness : 1.3;
      d.plate.position.set(app.cameraBase.x - halfW * 0.9 + d.plate.userData.width / 2, rowY + BASE_Y - (this.plankStyle === 'none' ? 0.8 : t / 2), FRONT_Z + 0.04);
      d.plate.visible = visible && Math.abs(this.rows.indexOf(row) - this.rowPos) < 0.6 && !(this.app.reader && this.app.reader.isOpen);
    }
    if (!row.entries.length) for (const b of d.ends) b.visible = false;
  }

  // ------------------------------------------------------------------ picking
  /** What is under the pointer: a book ({ entry }), a section label ({ tab }) or a shelf's plate ({ plate }). */
  pick(ndc) {
    this.raycaster.setFromCamera(ndc, this.app.camera);
    const objs = [];
    for (const row of this.rows) {
      for (const e of row.entries) if (e.slot.visible) objs.push(...e.model.pickables());
      if (row.deco) {
        for (const l of row.deco.labels) if (l.visible) objs.push(l);
        if (row.deco.plate && row.deco.plate.visible) objs.push(row.deco.plate);
      }
    }
    const hit = this.raycaster.intersectObjects(objs, false)[0];
    if (!hit) return null;
    const u = hit.object.userData;
    if (u.tab) {
      const row = this.rows.find((r) => r.deco && r.deco.labels.includes(hit.object));
      return { tab: { row, section: row.sections[u.tab.section] } };
    }
    if (u.plate) return { plate: u.plate };
    return { entry: u.entry, object: hit.object, point: hit.point };
  }

  /** Screen-space rectangle of the selected book's front cover. */
  coverRect(e) {
    if (!e) return null;
    const d = e.d;
    const pts = [];
    const v = new THREE.Vector3();
    for (const sx of [d.jb, d.jb + d.Wc])
      for (const sy of [-d.Hc / 2, d.Hc / 2]) {
        v.set(sx, sy, d.tp + d.bt);
        e.model.group.localToWorld(v);
        v.project(this.app.camera);
        pts.push(v.clone());
      }
    const W = this.app.width;
    const H = this.app.height;
    const xs = pts.map((p) => (p.x * 0.5 + 0.5) * W);
    const ys = pts.map((p) => (-p.y * 0.5 + 0.5) * H);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  }

  entryIndex(e) {
    return this.entries.indexOf(e);
  }
}

/** The spine's lettering, stamped into the binding. */
function spineTexture(meta, look, arc, Hc, aniso) {
  return stampedTexture(makeSpineCanvas(meta, look, arc, Hc), makeSpineCanvas(meta, look, arc, Hc, true), aniso);
}

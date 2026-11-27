// The pages' images: rendered by pdf.js at the screen's resolution (sharper when zoomed in), put on the leaves,
// a few spreads kept either side of your place. Mixed into Reader (reader.js).
import { canvasTexture } from './textures.js';
import { clamp } from './anim.js';
import { marginTone, renderPageToCanvas, renderQueue, toneOf } from './pdfdoc.js';
import * as store from './store.js';

export class Pages {
  assignLeafTextures(leaf, fanTex) {
    const k = leaf.k;
    const n = this.d.pages;
    const front = 2 * k + 1;
    const back = 2 * k + 2;
    const tf = front <= n ? this.pageTexture(front, fanTex) : this.blankPaper;
    const tb = back <= n ? this.pageTexture(back, fanTex) : this.blankPaper;
    leaf.setPages(tf, tb, front <= n ? this.ink.texture(front) : null, back <= n ? this.ink.texture(back) : null);
    leaf.material.userData.u.soil.value = this.soilFor(k);
  }


  /**
   * A scan shows its own paper: measure it on the first few pages (the margins' colour, not the ink or a dark
   * scanner border) so the paper isn't tinted and toned twice. Stored with the book; white pages count too.
   */
  sampleScanTone(canvas, n) {
    if (this.meta.pageTone || n < 3 || !this.scanSamples || this.scanSamples.length >= 3) return;
    try {
      const t = marginTone(canvas);
      if (t) this.scanSamples.push(t);
    } catch {
      return;
    }
    if (this.scanSamples.length < 3) return;
    this.meta.pageTone = toneOf(this.scanSamples);
    store.putBook(this.meta).catch(() => {});
    this.applyPaper();
  }


  refreshLeafTexturesFor(page) {
    const k = Math.floor((page - 1) / 2);
    const leaf = this.leafOf.get(k);
    if (leaf) this.assignLeafTextures(leaf, leaf._fanTex);
  }


  refreshAllLeafTextures() {
    if (!this.active) return;
    for (const leaf of this.leafOf.values()) this.assignLeafTextures(leaf, leaf._fanTex);
    this.app.invalidate();
  }


  onInkChanged(page) {
    this.refreshLeafTexturesFor(page);
    this.app.invalidate();
  }


  // =============================================================== page textures
  computeTexHeight() {
    const app = this.app;
    const isTouch = app.isTouch;
    const max = Math.min(app.renderer.capabilities.maxTextureSize, isTouch ? 3072 : 4096);
    const base = app.height * app.renderer.getPixelRatio() * 0.84;
    this.texH = Math.round(clamp(base * 1.1, 900, max));
    this.texMax = max;
  }


  pageTexture(n, fanTex) {
    const rec = this.pages.get(n);
    if (rec && rec.tex) return rec.tex;
    if (fanTex) return fanTex;
    this.requestPage(n, 3);
    return this.placeholder;
  }


  requestPage(n, priority = 2, height = this.texH) {
    if (!this.doc || n < 1 || n > this.d.pages) return;
    let rec = this.pages.get(n);
    if (!rec) {
      rec = { tex: null, h: 0, pending: 0 };
      this.pages.set(n, rec);
    }
    if (rec.h >= height * 0.92 || rec.pending >= height * 0.92) return;
    rec.pending = height;
    const doc = this.doc;
    const aspect = this.d.Wp / this.d.Hp;
    const id = this.meta.id;
    renderQueue
      .push({
        key: `${id}:${n}:${height}`,
        priority,
        run: async () => {
          if (this.doc !== doc) throw new Error('stale');
          return renderPageToCanvas(doc, n, Math.round(height * aspect), height);
        },
      })
      .then((canvas) => {
        if (this.doc !== doc) return;
        this.sampleScanTone(canvas, n);
        const tex = canvasTexture(canvas, { aniso: this.app.maxAniso });
        tex.onUpdate = () => {
          // the pixels live on the GPU now — free the canvas memory (matters on iPad)
          canvas.width = 1;
          canvas.height = 1;
          tex.onUpdate = null;
        };
        if (rec.tex) rec.tex.dispose();
        rec.tex = tex;
        rec.h = height;
        rec.pending = 0;
        this.refreshLeafTexturesFor(n);
        this.evictPages();
        this.app.invalidate();
      })
      .catch(() => {
        rec.pending = 0;
      });
  }


  prefetchSpread(s, priority = 1) {
    const l = 2 * s;
    const r = 2 * s + 1;
    this.requestPage(r, priority);
    this.requestPage(l, priority);
    // neighbours (what the next turn reveals)
    this.requestPage(r + 2, priority + 2);
    this.requestPage(r + 1, priority + 2);
    this.requestPage(l - 1, priority + 3);
    this.requestPage(l - 2, priority + 3);
  }


  evictPages() {
    // ink layers (two page-sized canvases each) only for the pages on the leaves in use
    if (this.ink) {
      const keep = new Set();
      for (const k of this.leafOf.keys()) keep.add(2 * k + 1).add(2 * k + 2);
      this.ink.evict(keep);
    }
    // page images kept: this spread and two either side (each ≈ 8 MB on the GPU at an iPad's resolution)
    if (this.pages.size <= 10) return;
    const lo = 2 * this.s - 4;
    const hi = 2 * this.s + 5;
    for (const [n, rec] of this.pages) {
      if ((n < lo || n > hi) && rec.tex) {
        let inUse = false;
        const k = Math.floor((n - 1) / 2);
        if (this.leafOf.has(k)) inUse = true;
        if (!inUse) {
          rec.tex.dispose();
          this.pages.delete(n);
        }
      }
    }
  }


  onZoomSettled() {
    if (!this.doc) return;
    const want = Math.round(clamp(this.texH * Math.max(1, this.zoom * 0.95), 0, this.texMax));
    if (want > this.texH * 1.1) {
      const l = 2 * this.s;
      this.requestPage(l, 0, want);
      this.requestPage(l + 1, 0, want);
    }
  }

}

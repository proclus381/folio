// IndexedDB persistence. Everything stays on the device: PDF bytes, covers, reading position, annotations.
//
// stores
//   books  { id, title, author, pages, aspect, size, fileName, addedAt, openedAt, spread, bookmarks[], look{}, outline?,
//            shelf?, shelfName? (one of your shelves), order? (your own order) }
//   files  { id, blob }                 — the original PDF
//   covers { id, blob }                 — JPEG of page 1, rendered once at import
//   marks  { key:"<id>|<page>", bookId, page, strokes[] }

const DB_NAME = 'folio-library';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('marks')) {
        const s = db.createObjectStore('marks', { keyPath: 'key' });
        s.createIndex('bookId', 'bookId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      // a newer version of the database (from a newer Folio) still opens, at its own version
      if (req.error && req.error.name === 'VersionError') {
        const again = indexedDB.open(DB_NAME);
        again.onsuccess = () => resolve(again.result);
        again.onerror = () => reject(again.error);
      } else reject(req.error);
    };
  });
  return dbp;
}

function tx(storeNames, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        let result;
        Promise.resolve(fn(t)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      }),
  );
}

const reqP = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}

export function listBooks() {
  return tx(['books'], 'readonly', (t) => reqP(t.objectStore('books').getAll()));
}

export function putBook(book) {
  return tx(['books'], 'readwrite', (t) => reqP(t.objectStore('books').put(book)));
}

/** Save several books in one transaction. */
export function putBooks(books) {
  if (!books.length) return Promise.resolve();
  return tx(['books'], 'readwrite', (t) => {
    const s = t.objectStore('books');
    for (const b of books) s.put(b);
  });
}

export async function addBook(book, fileBlob, coverBlob) {
  return tx(['books', 'files', 'covers'], 'readwrite', (t) => {
    t.objectStore('books').put(book);
    t.objectStore('files').put({ id: book.id, blob: fileBlob });
    if (coverBlob) t.objectStore('covers').put({ id: book.id, blob: coverBlob });
  });
}

export function getFile(id) {
  return tx(['files'], 'readonly', (t) => reqP(t.objectStore('files').get(id))).then((r) => r && r.blob);
}

export function getCover(id) {
  return tx(['covers'], 'readonly', (t) => reqP(t.objectStore('covers').get(id))).then((r) => r && r.blob);
}

export async function deleteBook(id) {
  const keys = await tx(['marks'], 'readonly', (t) =>
    reqP(t.objectStore('marks').index('bookId').getAllKeys(IDBKeyRange.only(id))),
  );
  return tx(['books', 'files', 'covers', 'marks'], 'readwrite', (t) => {
    t.objectStore('books').delete(id);
    t.objectStore('files').delete(id);
    t.objectStore('covers').delete(id);
    const m = t.objectStore('marks');
    for (const k of keys) m.delete(k);
  });
}

export async function getMarks(bookId) {
  const rows = await tx(['marks'], 'readonly', (t) =>
    reqP(t.objectStore('marks').index('bookId').getAll(IDBKeyRange.only(bookId))),
  );
  const map = new Map();
  for (const r of rows) if (r.strokes && r.strokes.length) map.set(r.page, r.strokes);
  return map;
}

export function putMarks(bookId, page, strokes) {
  const key = `${bookId}|${page}`;
  return tx(['marks'], 'readwrite', (t) => {
    const s = t.objectStore('marks');
    if (!strokes || !strokes.length) s.delete(key);
    else s.put({ key, bookId, page, strokes });
  });
}

/** How many pages of each book carry marks: Map(bookId → count). Keys only, so it stays cheap. */
export async function countMarks() {
  const keys = await tx(['marks'], 'readonly', (t) => reqP(t.objectStore('marks').getAllKeys()));
  const out = new Map();
  for (const k of keys) {
    const id = String(k).split('|')[0];
    out.set(id, (out.get(id) || 0) + 1);
  }
  return out;
}


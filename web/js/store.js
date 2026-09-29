// Tiny IndexedDB wrapper for the in-browser engine. Two stores:
//   projects — one record per video (title, range, captions, style, exports…)
//   files    — the big stuff as Blobs, keyed "<project id>/<name>"
//              (source, preview, thumb, clip, waveform, audio, export/<name>.gif|mp4)

const DB_NAME = 'movie-gif-maker';
let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('projects', { keyPath: 'id' });
        open.result.createObjectStore('files');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  const t = d.transaction(store, mode);
  const result = fn(t.objectStore(store));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  });
  return result instanceof IDBRequest ? result.result : result;
}

export const projects = {
  all: () => tx('projects', 'readonly', s => s.getAll()),
  get: id => tx('projects', 'readonly', s => s.get(id)),
  put: p => tx('projects', 'readwrite', s => s.put(p)),
  delete: id => tx('projects', 'readwrite', s => s.delete(id)),
  // Read-modify-write in one go.
  async update(id, fn) {
    const d = await db();
    const t = d.transaction('projects', 'readwrite');
    const s = t.objectStore('projects');
    const p = await req(s.get(id));
    if (!p) throw new Error('That video isn’t in this browser any more.');
    const next = fn(p) || p;
    s.put(next);
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
    });
    return next;
  },
};

export const files = {
  get: (id, name) => tx('files', 'readonly', s => s.get(`${id}/${name}`)),
  put: (id, name, blob) => tx('files', 'readwrite', s => s.put(blob, `${id}/${name}`)),
  delete: (id, name) => tx('files', 'readwrite', s => s.delete(`${id}/${name}`)),
  deleteAll: id => tx('files', 'readwrite', s => s.delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`))),
};

// Ask the browser not to clear our data under storage pressure.
export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (e) { /* not supported */ }
}

export async function usage() {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  } catch (e) {
    return null;
  }
}

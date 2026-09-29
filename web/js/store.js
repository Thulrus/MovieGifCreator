// Where the in-browser engine keeps things. Two stores:
//   projects — one record per video (title, range, captions, style, exports…)
//   files    — the big stuff as Blobs, keyed "<project id>/<name>"
//              (preview, thumb, clip, waveform, audio, export/<name>.gif|mp4)
// Normally that's IndexedDB. In "shared computer" mode it's plain memory
// instead, so nothing personal outlives the tab.

const DB_NAME = 'movie-gif-maker';
let dbPromise = null;
let memory = null;  // { projects: Map, files: Map } when not saving to disk

export function useMemoryOnly() {
  memory = { projects: new Map(), files: new Map() };
}
export function isMemoryOnly() { return !!memory; }

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

function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  });
}

async function tx(store, mode, fn) {
  const d = await db();
  const t = d.transaction(store, mode);
  const result = fn(t.objectStore(store));
  await done(t);
  return result instanceof IDBRequest ? result.result : result;
}

// Records are copied in and out of memory mode, like IndexedDB would.
const clone = v => (v === undefined ? v : structuredClone(v));

export const projects = {
  async all() {
    return memory ? [...memory.projects.values()].map(clone) : tx('projects', 'readonly', s => s.getAll());
  },
  async get(id) {
    return memory ? clone(memory.projects.get(id)) : tx('projects', 'readonly', s => s.get(id));
  },
  async put(p) {
    if (memory) { memory.projects.set(p.id, clone(p)); return; }
    return tx('projects', 'readwrite', s => s.put(p));
  },
  async delete(id) {
    if (memory) { memory.projects.delete(id); return; }
    return tx('projects', 'readwrite', s => s.delete(id));
  },
  // Read-modify-write in one go.
  async update(id, fn) {
    if (memory) {
      const p = clone(memory.projects.get(id));
      if (!p) throw new Error('That video isn’t here any more.');
      const next = fn(p) || p;
      memory.projects.set(id, clone(next));
      return next;
    }
    const d = await db();
    const t = d.transaction('projects', 'readwrite');
    const s = t.objectStore('projects');
    const p = await req(s.get(id));
    if (!p) throw new Error('That video isn’t in this browser any more.');
    const next = fn(p) || p;
    s.put(next);
    await done(t);
    return next;
  },
};

const range = id => IDBKeyRange.bound(`${id}/`, `${id}/￿`);

export const files = {
  async get(id, name) {
    return memory ? memory.files.get(`${id}/${name}`) : tx('files', 'readonly', s => s.get(`${id}/${name}`));
  },
  async put(id, name, blob) {
    if (memory) { memory.files.set(`${id}/${name}`, blob); return; }
    return tx('files', 'readwrite', s => s.put(blob, `${id}/${name}`));
  },
  async delete(id, name) {
    if (memory) { memory.files.delete(`${id}/${name}`); return; }
    return tx('files', 'readwrite', s => s.delete(`${id}/${name}`));
  },
  async deleteAll(id) {
    if (memory) {
      for (const key of [...memory.files.keys()]) if (key.startsWith(id + '/')) memory.files.delete(key);
      return;
    }
    return tx('files', 'readwrite', s => s.delete(range(id)));
  },
  // Bytes used per project id (Blob sizes are known without reading them).
  async sizes() {
    const out = new Map();
    const add = (key, blob) => {
      const id = String(key).split('/')[0];
      out.set(id, (out.get(id) || 0) + ((blob && blob.size) || 0));
    };
    if (memory) {
      for (const [key, blob] of memory.files) add(key, blob);
      return out;
    }
    const d = await db();
    const t = d.transaction('files', 'readonly');
    await new Promise((resolve, reject) => {
      const cur = t.objectStore('files').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(); return; }
        add(c.key, c.value);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    return out;
  },
};

// Everything, for "delete all videos".
export async function clearAll() {
  if (memory) { memory.projects.clear(); memory.files.clear(); return; }
  const d = await db();
  const t = d.transaction(['projects', 'files'], 'readwrite');
  t.objectStore('projects').clear();
  t.objectStore('files').clear();
  await done(t);
}

// Removes the database itself (for "clear everything").
export async function deleteDatabase() {
  if (dbPromise) { (await dbPromise).close(); dbPromise = null; }
  await new Promise(resolve => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

// Ask the browser not to clear our data under storage pressure.
export async function persist() {
  if (memory) return;
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (e) { /* not supported */ }
}

export async function persisted() {
  try { return await navigator.storage.persisted(); } catch (e) { return false; }
}

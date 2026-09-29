// Auto-captioning in the browser: Whisper runs in a web worker
// (whisper-worker.js). Used by the in-browser engine, and by the local server
// engine too when the server doesn't have Whisper installed.

import { wordsToCaptions } from './captions.js';

// (The "base" model was offered too, but its compressed build gets word
// timings badly wrong — every word at the same time, past the end of the
// clip — and drops sentences, so it's gone. It stays in RETIRED_MODELS so a
// copy someone already downloaded still shows up in the storage panel.)
export const MODELS = [
  { name: 'small', label: 'Small — most accurate', size: '250 MB' },
  { name: 'tiny', label: 'Tiny — quicker, less accurate', size: '41 MB' },
];
export const RETIRED_MODELS = [{ name: 'base', label: 'Base (no longer used)' }];
// Small is worth its download on a computer; on a phone the download and the
// slower processing hurt more, so start with Tiny there.
const onPhone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  && matchMedia('(max-width: 900px)').matches;
export const DEFAULT_MODEL = onPhone ? 'tiny' : 'small';
// What the clip's speech is in. The in-browser Whisper can't detect it by
// itself (it just assumes English), so it's picked in the caption options.
export const LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'],
  ['fi', 'Finnish'], ['pl', 'Polish'], ['cs', 'Czech'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
  ['el', 'Greek'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'],
  ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['zh', 'Chinese'], ['ja', 'Japanese'],
  ['ko', 'Korean'],
];
const modelRepo = name => `onnx-community/whisper-${name}_timestamped`;

let worker = null;
let seq = 0;
const calls = new Map();

function whisper(model, language, audio, onMessage) {
  if (!worker) {
    worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const call = calls.get(data.id);
      if (!call) return;
      if (data.type === 'progress') call.onMessage(data);
      else {
        calls.delete(data.id);
        if (data.type === 'error') call.reject(new Error(data.message));
        else call.resolve(data);
      }
    };
    worker.onerror = (e) => {
      for (const call of calls.values()) call.reject(new Error(e.message || 'The speech engine failed to start.'));
      calls.clear();
      worker = null;
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject, onMessage });
    worker.postMessage({ id, model, language, audio }, [audio.buffer]);
  });
}

// transformers.js keeps downloaded models in this Cache Storage bucket.
const MODEL_CACHE = 'transformers-cache';

// Bytes per saved model, plus `other` for anything else transformers.js
// cached there (tokenizer files and the like are tiny, but count them).
export async function modelCacheSizes() {
  const sizes = new Map();
  let other = 0;
  try {
    // caches.open() would create the cache just by looking, so check first.
    if (!(await caches.has(MODEL_CACHE))) return { sizes, other };
    const cache = await caches.open(MODEL_CACHE);
    for (const r of await cache.keys()) {
      const res = await cache.match(r);
      const bytes = Number(res.headers.get('Content-Length')) || (await res.blob()).size;
      const m = [...MODELS, ...RETIRED_MODELS].find(x => r.url.includes(modelRepo(x.name)));
      if (m) sizes.set(m.name, (sizes.get(m.name) || 0) + bytes);
      else other += bytes;
    }
  } catch (e) { /* no Cache Storage */ }
  return { sizes, other };
}

export async function clearModel(name) {
  try {
    if (!(await caches.has(MODEL_CACHE))) return;
    const cache = await caches.open(MODEL_CACHE);
    for (const r of await cache.keys()) if (r.url.includes(modelRepo(name))) await cache.delete(r);
  } catch (e) { /* no Cache Storage */ }
}

export async function clearAllModels() {
  try { await caches.delete(MODEL_CACHE); } catch (e) { /* no Cache Storage */ }
}

export async function downloadedModels() {
  const have = new Set();
  try {
    if (!(await caches.has(MODEL_CACHE))) return have;
    const cache = await caches.open(MODEL_CACHE);
    const keys = (await cache.keys()).map(r => r.url);
    for (const m of MODELS) {
      if (keys.some(u => u.includes(modelRepo(m.name)) && u.includes('decoder_model_merged_quantized'))) have.add(m.name);
    }
  } catch (e) { /* no Cache Storage (e.g. some private windows) */ }
  return have;
}

// samples: mono 16 kHz Float32Array of the clip. Returns {segments, words}
// in the same shape the server's /api/transcribe does.
export async function transcribe(samples, { model, language, maxChars, clipLen }, onProgress) {
  if (!samples.length) return { segments: [], words: [] };
  const m = MODELS.find(x => x.name === model) || MODELS.find(x => x.name === DEFAULT_MODEL);
  const lang = LANGUAGES.some(([code]) => code === language) ? language : 'en';
  const result = await whisper(modelRepo(m.name), lang, samples, (e) => {
    if (e.phase === 'download') {
      const mb = e.total ? ` (${Math.round(e.loaded / 1e6)} of ${Math.round(e.total / 1e6)} MB)` : '';
      onProgress({ progress: e.progress, message: `Downloading the ${m.name} speech model — one time only${mb}…` });
    } else if (e.phase === 'load') {
      onProgress({ progress: null, message: 'Loading the speech model…' });
    } else {
      onProgress({ progress: null, message: 'Listening to the clip… (this can take a little while)' });
    }
  });
  const len = clipLen || samples.length / 16000;
  let words = result.chunks
    .filter(c => c.text.trim())
    .map(c => ({ text: c.text, start: c.start, end: c.end }));
  const approximate = timingsLookWrong(words, len);
  words = approximate ? spreadEvenly(words, len) : words.map(w => {
    const start = Math.min(Math.max(0, w.start), Math.max(0, len - 0.1));
    return { text: w.text, start, end: Math.min(len, Math.max(start + 0.05, w.end ?? start + 0.3)) };
  });
  return {
    segments: wordsToCaptions(words, maxChars),
    // Word boundaries are only useful as snap points when they're real.
    words: approximate ? [] : words.map(w => ({ start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 })),
    approximate,
  };
}

// Whisper's word timings occasionally come out as nonsense: every word
// stamped with the same time, or times past the end of the clip.
function timingsLookWrong(words, len) {
  if (!words.length) return false;
  if (words.some(w => w.start == null || !isFinite(w.start) || w.start > len + 0.5)) return true;
  if (words.length < 4) return false;
  const distinct = new Set(words.map(w => w.start.toFixed(1))).size;
  return distinct < words.length * 0.35;
}

// Fallback timing: share the clip out between the words by their length, so
// the captions at least come out as sensible phrases in the right order.
function spreadEvenly(words, len) {
  const total = words.reduce((n, w) => n + w.text.trim().length + 1, 0) || 1;
  let t = 0;
  return words.map(w => {
    const d = ((w.text.trim().length + 1) / total) * len;
    const word = { text: w.text, start: t, end: t + d };
    t += d;
    return word;
  });
}

// In-browser video processing with ffmpeg.wasm (used when there's no local
// server to do it). One ffmpeg instance is shared and runs one command at a
// time; the ~30 MB engine is downloaded from a CDN the first time it's needed
// and then comes from the browser's cache.

import { FFmpeg } from '../vendor/ffmpeg/index.js';

const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const CORE_WASM_BYTES = 32_000_000;

let ff = null;
let loading = null;
let queue = Promise.resolve();
let logTail = [];
let fontsReady = null;

// The engine is kept in its own named cache (rather than left to the
// browser's ordinary HTTP cache) so the page can show how big it is and
// remove it when asked.
export const ENGINE_CACHE = 'gifmaker-video-engine';

async function openCache() {
  try { return await caches.open(ENGINE_CACHE); } catch (e) { return null; }  // e.g. some private windows
}

// Fetch a file into a blob: URL (from the cache when possible), reporting
// download progress.
async function fetchBlobURL(url, type, onProgress, expected) {
  const cache = await openCache();
  const hit = cache && await cache.match(url);
  if (hit) return URL.createObjectURL(new Blob([await hit.arrayBuffer()], { type }));

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${url} (${res.status})`);
  // Content-Length is the compressed size when the CDN compresses, so it
  // can't be trusted on its own; the known uncompressed size is a floor.
  const total = Math.max(Number(res.headers.get('Content-Length')) || 0, expected || 0);
  let blob;
  if (res.body && total && onProgress) {
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
    blob = new Blob(parts, { type });
  } else {
    blob = new Blob([await res.arrayBuffer()], { type });
  }
  if (cache) {
    await cache.put(url, new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(blob.size) } }))
      .catch(() => {});  // out of space: it just downloads again next time
  }
  return URL.createObjectURL(blob);
}

// Bytes the saved engine takes up (0 if it isn't saved).
export async function engineCacheSize() {
  // caches.open() would create the cache just by looking, so check first.
  if (!(await caches.has(ENGINE_CACHE).catch(() => false))) return 0;
  const cache = await openCache();
  if (!cache) return 0;
  let bytes = 0;
  for (const r of await cache.keys()) {
    const res = await cache.match(r);
    bytes += Number(res.headers.get('Content-Length')) || (await res.blob()).size;
  }
  return bytes;
}

export async function clearEngineCache() {
  try { await caches.delete(ENGINE_CACHE); } catch (e) { /* no Cache Storage */ }
}

export function engineLoaded() { return !!(ff && ff.loaded); }

export async function getFFmpeg(onProgress) {
  if (ff && ff.loaded) return ff;
  if (!loading) {
    loading = (async () => {
      const inst = new FFmpeg();
      inst.on('log', ({ message }) => {
        logTail.push(message);
        if (logTail.length > 400) logTail = logTail.slice(-200);
      });
      const report = f => onProgress && onProgress({
        progress: f, message: `Downloading the video engine (one-time, ~30 MB)… ${Math.round(f * 100)}%`,
      });
      report(0);
      const coreURL = await fetchBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await fetchBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm', report, CORE_WASM_BYTES);
      onProgress && onProgress({ progress: null, message: 'Starting the video engine…' });
      await inst.load({ coreURL, wasmURL });
      await inst.createDir('/work');
      ff = inst;
      return inst;
    })().catch(err => { loading = null; throw err; });
  }
  return loading;
}

// Run jobs one after another: the engine can only do one thing at a time.
function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function tail(lines, n = 6) {
  return lines.filter(l => l.trim() && !l.startsWith('frame=') && !l.startsWith('size=')).slice(-n).join('\n');
}

let mountSeq = 0;

// Runs one ffmpeg command. `inputs` maps a name to a Blob; each is mounted
// read-only at /in<N>/<name> without copying it into memory (so a whole movie
// is fine). `{in:name}` placeholders in args are replaced by those paths.
// Returns the requested output files as Blobs, plus the log.
export function run({ inputs = {}, args, outputs = [], duration, span = [0, 1], onProgress, message }) {
  return serial(async () => {
    const f = await getFFmpeg(onProgress);
    const dir = `/in${++mountSeq}`;
    const names = Object.keys(inputs);
    if (names.length) {
      await f.createDir(dir);
      await f.mount('WORKERFS', { blobs: names.map(name => ({ name, data: inputs[name] })) }, dir);
    }
    const realArgs = args.map(a => typeof a === 'string'
      ? a.replace(/\{in:([^}]+)\}/g, (_, n) => `${dir}/${n}`) : String(a));

    const onProg = ({ time }) => {
      if (!onProgress || !duration || !(time > 0)) return;
      const frac = Math.min(1, Math.max(0, time / 1e6 / duration));
      onProgress({ progress: span[0] + (span[1] - span[0]) * frac, message });
    };
    f.on('progress', onProg);
    if (onProgress) onProgress({ progress: duration ? span[0] : null, message });
    logTail = [];
    let code;
    try {
      code = await f.exec(['-hide_banner', '-y', ...realArgs]);
    } finally {
      f.off('progress', onProg);
      if (names.length) {
        await f.unmount(dir).catch(() => {});
        await f.deleteDir(dir).catch(() => {});
      }
    }
    const log = logTail.slice();
    const out = {};
    try {
      if (code !== 0) throw new Error('ffmpeg failed:\n' + tail(log));
      for (const [path, type] of outputs) {
        const data = await f.readFile(path);
        out[path] = new Blob([data.buffer], { type });
      }
    } finally {
      for (const [path] of outputs) await f.deleteFile(path).catch(() => {});
    }
    return { out, log, code };
  });
}

// ffmpeg with no output just prints what's in the file (and exits with an error, which is expected).
export async function probe(blob, onProgress) {
  const { log } = await serialProbe(blob, onProgress);
  return parseInfo(log);
}

// Pulls the basics out of ffmpeg's description of its first input.
export function parseInfo(log) {
  const text = log.join('\n');
  const info = { duration: null, fps: null, video: null, audio: null, width: null, height: null, sar: 1, pixFmt: null };
  const d = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const v = text.match(/Stream #\d+:\d+[^:]*: Video: (\w+)([^\n]*)/);
  if (v) {
    info.video = v[1];
    const size = v[2].match(/ (\d{2,5})x(\d{2,5})/);
    if (size) { info.width = Number(size[1]); info.height = Number(size[2]); }
    const sar = v[2].match(/\[SAR (\d+):(\d+)/);
    if (sar && Number(sar[1]) > 0 && Number(sar[2]) > 0) info.sar = Number(sar[1]) / Number(sar[2]);
    const fps = v[2].match(/([\d.]+) fps/);
    if (fps && Number(fps[1]) >= 1 && Number(fps[1]) <= 240) info.fps = Math.round(Number(fps[1]) * 1000) / 1000;
    const pf = v[2].match(/, (yuv\w+|rgb\w+|gray\w*|nv12)/);
    if (pf) info.pixFmt = pf[1];
  }
  const a = text.match(/Stream #\d+:\d+[^:]*: Audio: (\w+)/);
  if (a) info.audio = a[1];
  return info;
}

function serialProbe(blob, onProgress) {
  return serial(async () => {
    const f = await getFFmpeg(onProgress);
    const dir = `/in${++mountSeq}`;
    await f.createDir(dir);
    await f.mount('WORKERFS', { blobs: [{ name: 'src', data: blob }] }, dir);
    logTail = [];
    try {
      await f.exec(['-hide_banner', '-i', `${dir}/src`]);
    } finally {
      await f.unmount(dir).catch(() => {});
      await f.deleteDir(dir).catch(() => {});
    }
    return { log: logTail.slice() };
  });
}

// The caption fonts, copied into the engine's filesystem once for libass.
export function ensureFonts(fonts) {
  if (!fontsReady) {
    fontsReady = serial(async () => {
      const f = await getFFmpeg();
      await f.createDir('/fonts').catch(() => {});
      for (const font of fonts) {
        const res = await fetch(new URL(`../fonts/${font.file}`, import.meta.url));
        await f.writeFile(`/fonts/${font.file}`, new Uint8Array(await res.arrayBuffer()));
      }
    }).catch(err => { fontsReady = null; throw err; });
  }
  return fontsReady;
}

export function writeText(path, text) {
  return serial(async () => (await getFFmpeg()).writeFile(path, new TextEncoder().encode(text)));
}

// Mono 16 kHz float samples, what Whisper wants (also used to draw the waveform).
export async function extractAudio(blob, onProgress) {
  const { out } = await run({
    inputs: { clip: blob },
    args: ['-i', '{in:clip}', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '/work/audio.raw'],
    outputs: [['/work/audio.raw', 'application/octet-stream']],
    onProgress, message: 'Extracting the audio…',
  });
  return new Float32Array(await out['/work/audio.raw'].arrayBuffer());
}

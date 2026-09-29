// The "no server" engine: everything happens inside this browser tab.
// Videos are processed with ffmpeg.wasm, captions come from Whisper running
// in a web worker, and the library lives in IndexedDB. Nothing is uploaded
// anywhere. It answers the same calls as backend-server.js, so the page
// doesn't need to know which one it's talking to.

import * as media from './media.js';
import { projects, files, persist, usage } from './store.js';
import { buildAss } from './captions.js';
import * as speech from './speech.js';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

let fontsCfg = null;
// The original video files, used straight from wherever the user picked them
// (copying a whole movie into browser storage is slow, especially on phones).
// Only kept for this visit: coming back later, the page asks for the file
// again. Clips, captions and GIFs are small and are always saved.
const memSources = new Map();

// --- Small helpers -----------------------------------------------------------

const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const now = () => Date.now() / 1000;
const stem = name => name.replace(/\.[^.]+$/, '') || name;
const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };

// Every call returns {error} instead of throwing, like the server does.
function safe(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(err);
      let msg = (err && err.message) || String(err);
      if (err && err.name === 'QuotaExceededError') msg = 'This browser ran out of storage space. Delete some videos from your library and try again.';
      return { error: msg };
    }
  };
}

// blob: URLs for stored files, created on demand and reused.
const urlCache = new Map();
async function fileURL(id, name) {
  const key = `${id}/${name}`;
  if (urlCache.has(key)) return urlCache.get(key);
  const blob = name === 'source' && memSources.has(id) ? memSources.get(id) : await files.get(id, name);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}
function forgetURL(id, name) {
  const key = `${id}/${name}`;
  if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
}
function forgetAllURLs(id) {
  for (const key of [...urlCache.keys()]) if (key.startsWith(id + '/')) forgetURL(id, key.slice(id.length + 1));
}
async function putFile(id, name, blob) {
  await files.put(id, name, blob);
  forgetURL(id, name);
}

async function sourceBlob(p) {
  if (memSources.has(p.id)) return memSources.get(p.id);
  return p.hasSource ? files.get(p.id, 'source') : null;
}

// --- Looking at a video with the browser's own player -----------------------

function withVideo(blob, fn, timeoutMs = 20000) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  const url = URL.createObjectURL(blob);
  v.src = url;
  let timer;
  return Promise.race([
    fn(v),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
  ]).finally(() => {
    clearTimeout(timer);
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  });
}

function once(target, events) {
  return new Promise((resolve, reject) => {
    const handlers = {};
    const done = (ev) => {
      for (const [name, h] of Object.entries(handlers)) target.removeEventListener(name, h);
      if (ev.type === 'error') reject(new Error('media error'));
      else resolve(ev.type);
    };
    for (const name of [...events, 'error']) {
      handlers[name] = done;
      target.addEventListener(name, done);
    }
  });
}

// Can this browser play the file as-is? (If so there's no need to convert it.)
async function checkPlayable(blob) {
  try {
    return await withVideo(blob, async v => {
      await once(v, ['loadeddata']);
      return { playable: v.videoWidth > 0 && isFinite(v.duration), duration: v.duration, width: v.videoWidth, height: v.videoHeight };
    });
  } catch (e) {
    return { playable: false };
  }
}

// A small JPEG from about a second in, for the library.
async function grabThumb(blob, duration) {
  try {
    return await withVideo(blob, async v => {
      await once(v, ['loadeddata']);
      v.currentTime = Math.min(1, (duration || v.duration || 0) / 2);
      await once(v, ['seeked']);
      const w = 320, h = Math.round(w * v.videoHeight / v.videoWidth) || 180;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    });
  } catch (e) {
    return null;
  }
}

// The clip's audio drawn as a waveform strip for the caption timeline, like
// ffmpeg's showwavespic: boosted so quiet dialogue still shows, sqrt scaled.
function drawWaveform(samples) {
  if (!samples.length) return Promise.resolve(null);
  const W = 1600, H = 160;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < 1e-4) return Promise.resolve(null);
  const gain = Math.min(1 / peak, 100);
  const per = samples.length / W;
  ctx.fillStyle = '#7aa2ff';
  for (let x = 0; x < W; x++) {
    let m = 0;
    const end = Math.min(samples.length, Math.floor((x + 1) * per));
    for (let i = Math.floor(x * per); i < end; i++) m = Math.max(m, Math.abs(samples[i]));
    const h = Math.sqrt(Math.min(1, m * gain)) * (H / 2);
    ctx.fillRect(x, H / 2 - h, 1, Math.max(1, h * 2));
  }
  return new Promise(r => c.toBlob(r, 'image/png'));
}

// --- Library ---------------------------------------------------------------------

async function summary(p) {
  // A project whose original file is gone still opens (its clip, captions
  // and GIFs are kept); the page asks for the file again to pick a new range.
  const status = p.status === 'ready' ? 'ready' : 'incomplete';
  return {
    session: p.id,
    title: p.title,
    source_type: p.source_type,
    status,
    resume: status === 'incomplete' && (p.hasSource || memSources.has(p.id)) ? 'prepare' : null,
    duration: p.duration || null,
    fps: p.fps || null,
    created: p.created,
    thumb_url: p.hasThumb ? await fileURL(p.id, 'thumb') : null,
    export_count: (p.exports || []).length,
  };
}

async function videoURL(p) {
  if (p.previewMode === 'converted') return fileURL(p.id, 'preview');
  if (p.hasSource || memSources.has(p.id)) return fileURL(p.id, 'source');
  return null;
}

async function exportList(p) {
  const list = [];
  for (const x of [...(p.exports || [])].sort((a, b) => b.mtime - a.mtime)) {
    list.push({
      name: x.name,
      gif_url: await fileURL(p.id, `export/${x.name}.gif`),
      gif_size: x.gif_size,
      mp4_url: await fileURL(p.id, `export/${x.name}.mp4`),
      mp4_size: x.mp4_size,
      mtime: x.mtime,
    });
  }
  return list;
}

// Makes a browser-playable copy of a file the browser can't play itself
// (e.g. HEVC, AVI, some MKVs), and fills in the details ffmpeg can see.
async function prepare(id, onProgress) {
  const p = await projects.get(id);
  const src = await sourceBlob(p);
  if (!src) throw new Error('The original file for this video isn’t stored in this browser. Add it again.');
  const info = await media.probe(src, onProgress);
  if (!info.video) throw new Error('That file doesn’t seem to have a video track (or it’s a format this browser can’t open).');
  const duration = info.duration || p.duration || 0;
  const maps = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  const audio = !info.audio || info.audio === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
  let out = null;
  if (info.video === 'h264' && (!info.pixFmt || /^yuvj?420p$/.test(info.pixFmt))) {
    try {
      out = (await media.run({
        inputs: { src }, duration, onProgress, message: 'Preparing the video (no re-encode needed)…',
        args: ['-i', '{in:src}', ...maps, '-c:v', 'copy', ...audio, '-movflags', '+faststart', '/work/preview.mp4'],
        outputs: [['/work/preview.mp4', 'video/mp4']],
      })).out['/work/preview.mp4'];
    } catch (e) { out = null; /* odd stream that won't remux; convert instead */ }
  }
  if (!out) {
    out = (await media.run({
      inputs: { src }, duration, onProgress,
      message: 'Converting to a format your browser can play (this can take a while for long videos)…',
      args: ['-i', '{in:src}', ...maps, '-vf', "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', ...audio,
        '-movflags', '+faststart', '/work/preview.mp4'],
      outputs: [['/work/preview.mp4', 'video/mp4']],
    })).out['/work/preview.mp4'];
  }
  await putFile(id, 'preview', out);
  const thumb = p.hasThumb ? null : await grabThumb(out, duration);
  if (thumb) await putFile(id, 'thumb', thumb);
  await projects.update(id, q => {
    q.previewMode = 'converted';
    q.duration = duration;
    q.fps = info.fps || q.fps;
    q.hasThumb = q.hasThumb || !!thumb;
    q.status = 'ready';
  });
}

// Stores the file for a new (or relinked) project and gets it ready to play.
async function takeFile(id, file, onProgress) {
  onProgress({ progress: null, message: `Opening ${file.name}…` });
  const check = await checkPlayable(file);
  memSources.set(id, file);
  forgetURL(id, 'source');
  // Projects from before this change have a stored copy; a relinked file replaces it.
  await files.delete(id, 'source');
  await projects.update(id, p => {
    p.hasSource = false;
    p.sourceName = file.name;
    p.sourceSize = file.size;
    if (check.playable) {
      p.previewMode = 'native';
      p.duration = check.duration;
      p.status = 'ready';
    }
  });
  if (check.playable) {
    const p = await projects.get(id);
    if (!p.hasThumb) {
      const thumb = await grabThumb(file, check.duration);
      if (thumb) {
        await putFile(id, 'thumb', thumb);
        await projects.update(id, q => { q.hasThumb = true; });
      }
    }
  } else {
    await prepare(id, onProgress);
  }
}

// --- The backend -----------------------------------------------------------------

export const browserBackend = {
  mode: 'browser',

  config: safe(async () => {
    if (!fontsCfg) fontsCfg = await (await fetch(new URL('../fonts/fonts.json', import.meta.url))).json();
    const have = await speech.downloadedModels();
    persist();
    return {
      mode: 'browser',
      youtube: false,
      fonts: fontsCfg.fonts,
      default_font: fontsCfg.default,
      models: speech.MODELS.map(m => ({ ...m, downloaded: have.has(m.name) })),
      default_model: speech.DEFAULT_MODEL,
      languages: speech.LANGUAGES,
      default_language: 'en',
    };
  }),

  library: safe(async () => {
    const all = await projects.all();
    all.sort((a, b) => b.created - a.created);
    return { sessions: await Promise.all(all.map(summary)) };
  }),

  usage,

  open: safe(async (id) => {
    const p = await projects.get(id);
    if (!p) return { error: 'That video isn’t in this browser’s library any more.' };
    const info = await summary(p);
    info.video_url = await videoURL(p);
    info.needs_source = !info.video_url;
    info.source_name = p.sourceName;
    info.state = p.state || {};
    info.clip = p.clip || null;
    info.clip_url = p.clip ? await fileURL(id, 'clip') : null;
    info.waveform_url = p.clip ? await fileURL(id, 'waveform') : null;
    info.exports = await exportList(p);
    if (info.needs_source && info.clip) info.status = 'ready';
    return info;
  }),

  saveState: safe(async (id, state) => {
    await projects.update(id, p => { p.state = state; });
    return { ok: true };
  }),

  rename: safe(async (id, title) => {
    title = String(title || '').trim().slice(0, 200);
    if (!title) return { error: 'The name can’t be empty' };
    return summary(await projects.update(id, p => { p.title = title; }));
  }),

  remove: safe(async (id) => {
    forgetAllURLs(id);
    memSources.delete(id);
    await files.deleteAll(id);
    await projects.delete(id);
    return { ok: true };
  }),

  addFile: safe(async (file, onProgress) => {
    const id = newId();
    await projects.put({
      id, title: stem(file.name), source_type: 'upload', created: now(), status: 'incomplete',
      hasSource: false, hasThumb: false, previewMode: null, duration: null, fps: null,
      clip: null, state: {}, exports: [],
    });
    try {
      await takeFile(id, file, onProgress);
    } catch (err) {
      // A file that isn't a video at all shouldn't linger in the library.
      const p = await projects.get(id);
      if (p && !p.clip && !(p.exports || []).length && /video track|can’t open/.test(err.message)) {
        await browserBackend.remove(id);
      }
      throw err;
    }
    return { session: id };
  }),

  // Put the original file back for a project whose copy wasn't stored.
  relink: safe(async (id, file, onProgress) => {
    await takeFile(id, file, onProgress);
    forgetURL(id, 'preview');
    return { session: id };
  }),

  resume: safe(async (entry, _url, onProgress) => {
    await prepare(entry.session, onProgress);
    return { session: entry.session };
  }),

  cut: safe(async (id, start, end, onProgress) => {
    const p = await projects.get(id);
    let src = await sourceBlob(p);
    // Without the original, cut from the preview copy (slightly lower quality).
    if (!src && p.previewMode === 'converted') src = await files.get(id, 'preview');
    if (!src) return { error: 'The original video isn’t stored in this browser — add the file again to cut a new clip.' };
    const len = end - start;
    // Seeking before -i jumps straight there instead of decoding everything
    // up to it; since the clip is re-encoded, the cut is still frame-accurate.
    // Clips are capped at 1280px: exports are never bigger, and it's much faster.
    const { out, log } = await media.run({
      inputs: { src }, duration: len, span: [0, 0.8], onProgress, message: 'Cutting out your clip…',
      args: ['-ss', start.toFixed(3), '-i', '{in:src}', '-t', len.toFixed(3),
        '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
        '-vf', "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-avoid_negative_ts', 'make_zero', '/work/clip.mp4'],
      outputs: [['/work/clip.mp4', 'video/mp4']],
    });
    const clip = out['/work/clip.mp4'];
    const info = media.parseInfo(log);

    onProgress({ progress: 0.85, message: 'Drawing the waveform…' });
    let samples = new Float32Array(0);
    if (info.audio) {
      try { samples = await media.extractAudio(clip); } catch (e) { /* no usable audio */ }
    }
    const wave = await drawWaveform(samples);

    await putFile(id, 'clip', clip);
    await putFile(id, 'audio', new Blob([samples.buffer]));
    if (wave) await putFile(id, 'waveform', wave);
    else { await files.delete(id, 'waveform'); forgetURL(id, 'waveform'); }
    await projects.update(id, q => {
      q.clip = { start, end };
      q.fps = q.fps || info.fps;
    });
    return {
      clip: { start, end },
      clip_url: await fileURL(id, 'clip'),
      waveform_url: wave ? await fileURL(id, 'waveform') : null,
      fps: info.fps,
    };
  }),

  transcribe: safe(async (id, { max_chars, model, language }, onProgress) => {
    const p = await projects.get(id);
    if (!p.clip) return { error: 'Cut a clip first' };
    const raw = await files.get(id, 'audio');
    let samples = raw ? new Float32Array(await raw.arrayBuffer()) : null;
    if (!samples) samples = await media.extractAudio(await files.get(id, 'clip'), onProgress).catch(() => new Float32Array(0));
    return speech.transcribe(samples, {
      model, language, maxChars: clampInt(max_chars, 40, 15, 200), clipLen: p.clip.end - p.clip.start,
    }, onProgress);
  }),

  exportGif: safe(async (id, data, onProgress) => {
    const p = await projects.get(id);
    if (!p.clip) return { error: 'Cut a clip first' };
    const name = String(data.name || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'clip';
    if ((p.exports || []).some(x => x.name === name) && !data.overwrite) {
      return { error: `There's already a GIF called "${name}".`, conflict: true };
    }
    const fonts = fontsCfg.fonts.map(f => f.family);
    const style = {
      fontsize: clampInt(data.fontsize, 32, 8, 120),
      color: HEX_COLOR.test(String(data.color)) ? data.color : '#ffffff',
      font: fonts.includes(data.font) ? data.font : fontsCfg.default,
      outline: clampInt(data.outline, 3, 0, 8),
      position: data.position === 'top' ? 'top' : 'bottom',
      uppercase: !!data.uppercase,
    };
    let width = clampInt(data.width, 360, 120, 1280);
    width -= width % 2;
    const fps = clampInt(data.fps, 15, 5, 30);
    const captions = (data.captions || [])
      .map(c => ({ start: Number(c.start), end: Number(c.end), text: String(c.text || '') }))
      .filter(c => c.text.trim() && c.end > c.start);

    const clip = await files.get(id, 'clip');
    const duration = p.clip.end - p.clip.start;
    await media.ensureFonts(fontsCfg.fonts);
    await media.writeText('/work/captions.ass', buildAss(captions, style));

    // Scale down while burning in, so both the MP4 and the GIF made from it are smaller.
    const burned = (await media.run({
      inputs: { clip }, duration, span: [0, 0.6], onProgress, message: 'Burning in the captions…',
      args: ['-i', '{in:clip}', '-vf', `ass=/work/captions.ass:fontsdir=/fonts,scale=${width}:-2:flags=lanczos`,
        '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '/work/burned.mp4'],
      outputs: [['/work/burned.mp4', 'video/mp4']],
    })).out['/work/burned.mp4'];
    const palette = (await media.run({
      inputs: { burned }, duration, span: [0.6, 0.7], onProgress, message: 'Picking the GIF’s colours…',
      args: ['-i', '{in:burned}', '-vf', `fps=${fps},palettegen=stats_mode=diff`, '/work/palette.png'],
      outputs: [['/work/palette.png', 'image/png']],
    })).out['/work/palette.png'];
    const gif = (await media.run({
      inputs: { burned, palette }, duration, span: [0.7, 1], onProgress, message: 'Making the GIF…',
      args: ['-i', '{in:burned}', '-i', '{in:palette}', '-filter_complex',
        `fps=${fps}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, '/work/out.gif'],
      outputs: [['/work/out.gif', 'image/gif']],
    })).out['/work/out.gif'];

    await putFile(id, `export/${name}.gif`, gif);
    await putFile(id, `export/${name}.mp4`, burned);
    const entry = { name, gif_size: gif.size, mp4_size: burned.size, mtime: now() };
    await projects.update(id, q => {
      q.exports = [entry, ...(q.exports || []).filter(x => x.name !== name)];
    });
    return {
      name,
      gif_url: await fileURL(id, `export/${name}.gif`),
      mp4_url: await fileURL(id, `export/${name}.mp4`),
      gif_size: gif.size,
      mp4_size: burned.size,
    };
  }),

  exports: safe(async (id) => exportList(await projects.get(id))),

  deleteExport: safe(async (id, name) => {
    for (const ext of ['gif', 'mp4']) {
      await files.delete(id, `export/${name}.${ext}`);
      forgetURL(id, `export/${name}.${ext}`);
    }
    await projects.update(id, q => { q.exports = (q.exports || []).filter(x => x.name !== name); });
    return { ok: true };
  }),
};

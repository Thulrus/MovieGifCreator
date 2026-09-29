// The page. It works the same whichever engine is doing the work:
//   - backend-server.js when the page is served by app.py on your own
//     computer (native ffmpeg/Whisper, plus YouTube downloads via yt-dlp)
//   - backend-browser.js everywhere else, e.g. GitHub Pages (everything runs
//     in this tab; nothing is uploaded)
// Add ?engine=browser to the URL to use the in-browser engine even when a
// local server is available.

import { serverBackend } from './backend-server.js';
import { PLAY_RES_X as ASS_RES_X, PLAY_RES_Y as ASS_RES_Y, MARGIN as ASS_MARGIN } from './captions.js';

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let backend = null;
let cfg = { fonts: [], models: [], languages: [['en', 'English']], default_font: 'DejaVu Sans', default_model: 'base', default_language: 'en' };
let sessionId = null, session = null;
let duration = 0, fps = 30;
let startTime = 0, endTime = 0;
let clipRange = null;  // the {start, end} of the source video that the current clip covers
let restoring = false;
// "Don't save my videos" (for shared computers): everything stays in memory.
const PRIVATE_KEY = 'gifmaker.private';
let privateMode = false;

// --- Formatting ---
function fmt(t) { return t.toFixed(2) + 's'; }
// Long videos get m:ss.cc, short ones plain seconds.
function fmtTime(t, long = duration >= 60) {
  if (!isFinite(t)) t = 0;
  if (!long) return t.toFixed(2) + 's';
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = (t % 60).toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
function fmtDur(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(Math.floor(t % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
// Accepts "83.5", "83.5s", "1:23.5" or "1:01:23.5".
function parseTime(str) {
  str = str.trim().replace(/s$/i, '');
  if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some(p => isNaN(p) || p < 0)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function fmtSize(bytes) {
  if (bytes == null) return '?';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  return bytes < 1024 * 1024 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
}
function slugify(s) {
  return s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// --- Progress / status lines ---
function showProgress(elm, job) {
  if (!job) { elm.hidden = true; return; }
  elm.hidden = false;
  elm.classList.remove('error', 'ok');
  elm.querySelector('.msg').textContent = job.message || 'Working…';
  const bar = elm.querySelector('.bar');
  bar.classList.toggle('indeterminate', job.progress == null);
  bar.firstElementChild.style.width = job.progress == null ? '' : (job.progress * 100).toFixed(1) + '%';
}
function showStatus(elm, text, kind) {
  elm.hidden = false;
  elm.classList.toggle('error', kind === 'error');
  elm.classList.toggle('ok', kind === 'ok');
  elm.querySelector('.msg').textContent = text;
}
// Progress updates for a line, keeping the last message when an update only moves the bar.
function progressTo(elm) {
  let last = '';
  return job => {
    if (job.message) last = job.message;
    showProgress(elm, { ...job, message: job.message || last });
  };
}

// Stop the page being closed mid-job in browser mode, where closing the tab
// really does stop the work.
let busy = 0;
async function working(fn) {
  busy++;
  try { return await fn(); } finally { busy--; }
}
// In shared-computer mode, closing the tab also throws away everything made.
let leaving = false;
window.addEventListener('beforeunload', e => {
  if (leaving || !backend || backend.mode !== 'browser') return;
  if (busy || (privateMode && libEntries.length)) { e.preventDefault(); e.returnValue = ''; }
});

// --- Steps (accordion: one open, finished ones collapse to a summary) ---
let reached = 1, openN = 1;

function openStep(n) {
  openN = n;
  reached = Math.max(reached, n);
  stopPreview();
  $('player').pause();
  $('clipPlayer').pause();
  renderSteps();
  if (n === 3) requestAnimationFrame(() => { renderRuler(); renderOverlay(true); });
  if (n === 2) requestAnimationFrame(updateRangeUI);
}

function renderSteps() {
  [1, 2, 3].forEach(n => {
    const s = $('step' + n);
    s.classList.toggle('open', n === openN);
    s.classList.toggle('locked', n > reached);
    s.classList.toggle('collapsed', n !== openN && n <= reached);
  });
  // The results panel belongs to the open video; hide it while picking another.
  $('results').hidden = !exportList.length || openN === 1;
  // The how-it-works strip is for people who haven't started yet.
  $('howto').hidden = !!sessionId || libEntries.length > 0;
  $('sum1').textContent = session ? session.title : '';
  $('sum2').textContent = session
    ? `${fmtTime(startTime)} – ${fmtTime(endTime)}  (${(endTime - startTime).toFixed(1)}s)` : '';
  const n = captions.filter(c => c.text.trim()).length;
  $('sum3').textContent = clipRange ? `${n} caption${n === 1 ? '' : 's'}` : '';
  renderMiniSteps();
}

// The "1 add captions, 2 check, 3 make" guide at the top of step 3 ticks itself off.
function renderMiniSteps() {
  const hasCaps = captions.some(c => c.text.trim());
  const made = exportList.length > 0;
  const state = [hasCaps || made, hasCaps && made, made];
  const now = state.indexOf(false);
  ['ms1', 'ms2', 'ms3'].forEach((id, i) => {
    $(id).classList.toggle('done', state[i]);
    $(id).classList.toggle('now', i === now);
  });
  $('transcribeBtn').classList.toggle('pulse', !hasCaps && openN === 3 && !$('transcribeBtn').disabled);
}

document.querySelectorAll('.step-head').forEach(head => {
  head.addEventListener('click', () => {
    const n = Number(head.parentElement.dataset.step);
    if (!n || n > reached || n === openN) return;
    openStep(n);
    head.parentElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
});

// --- Autosave: range, captions and style are saved with the video so
// nothing is lost on refresh, and reopening it from the library picks up
// where you left off. ---
let saveTimer = null;

function collectState() {
  return {
    range: { start: startTime, end: endTime },
    clip: clipRange,
    captions: captions.map(({ start, end, text }) => ({ start, end, text })),
    words,
    style: getStyle(),
    output: getOutput(),
    name: $('clipName').value,
    maxChars: Number($('maxCaptionChars').value),
    model: $('modelSel').value,
    language: $('langSel').value,
  };
}
function scheduleSave() {
  if (!sessionId || restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
function saveNow() {
  if (!saveTimer || !sessionId) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  backend.saveState(sessionId, collectState());
}
window.addEventListener('pagehide', () => {
  if (!saveTimer || !sessionId) return;
  if (backend.flushState) backend.flushState(sessionId, collectState());
  else saveNow();
});

function remember(key, value) {
  if (privateMode) return;
  try { localStorage.setItem('gifmaker.' + key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
}
function recall(key) {
  try { return JSON.parse(localStorage.getItem('gifmaker.' + key)) || {}; } catch (e) { return {}; }
}

// --- Step 1: getting a video ---
const srcProgress = $('srcProgress');

// Opens whatever an upload/fetch/resume produced.
async function openResult(result) {
  loadLibrary();
  if (result.error) { showStatus(srcProgress, 'Error: ' + result.error, 'error'); return; }
  if (result.existing) {
    showStatus(srcProgress, '✓ You already had this video, so it was opened from your list instead of downloading it again.', 'ok');
  } else {
    showProgress(srcProgress, null);
  }
  await openSession(result.session);
}

async function fetchYoutube() {
  const url = $('youtubeUrl').value.trim();
  if (!url) { $('youtubeUrl').focus(); return; }
  $('fetchBtn').disabled = true;
  showProgress(srcProgress, { message: 'Looking up the video…', progress: null });
  setTimeout(loadLibrary, 1500);  // show the new download's card while it runs
  const result = await backend.fetchYoutube(url, progressTo(srcProgress));
  $('fetchBtn').disabled = false;
  if (!result.error) $('youtubeUrl').value = '';
  await openResult(result);
}
$('fetchBtn').addEventListener('click', fetchYoutube);
$('youtubeUrl').addEventListener('keydown', e => { if (e.key === 'Enter') fetchYoutube(); });

function looksLikeVideo(file) {
  return file.type.startsWith('video/') || /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|ts|m2ts|mts|vob|3gp|ogv)$/i.test(file.name);
}

async function addFile(file) {
  if (!file) return;
  if (!looksLikeVideo(file)
      && !confirm(`"${file.name}" doesn’t look like a video file. Try it anyway?`)) return;
  if (openN !== 1) openStep(1);
  const result = await working(() => backend.addFile(file, progressTo(srcProgress)));
  await openResult(result);
}
$('uploadBtn').addEventListener('click', e => { e.stopPropagation(); $('fileInput').click(); });
$('dropzone').addEventListener('click', () => $('fileInput').click());
$('dropzone').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
});
$('fileInput').addEventListener('change', e => { addFile(e.target.files[0]); e.target.value = ''; });

// Drop a video anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
window.addEventListener('dragover', e => {
  if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
window.addEventListener('drop', e => {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  // Dropped on step 2's "choose the file again" banner: relink instead.
  if (e.target.closest && e.target.closest('#relinkBanner')) relinkFile(file);
  else addFile(file);
});

// --- Library of videos you've used before ---
let libEntries = [];
let libTimer = null;

async function loadLibrary() {
  clearTimeout(libTimer);
  const data = await backend.library();
  if (data.error) return;
  libEntries = data.sessions || [];
  renderLibrary();
  renderSteps();
  // Keep in-progress downloads' cards updating.
  if (libEntries.some(e => e.status === 'working')) libTimer = setTimeout(loadLibrary, 1500);
  renderStorage();
}

function renderStorage() {
  $('storageNote').hidden = backend.mode !== 'browser';
  $('storageNote').innerHTML = privateMode
    ? 'Kept only until you close this tab. Download the GIFs you want to keep. '
    : 'Saved in this browser only. Download the GIFs you want to keep. ';
  const link = el('button', 'inline-link', 'See what’s saved');
  link.type = 'button';
  link.addEventListener('click', openStoragePanel);
  $('storageNote').appendChild(link);
  renderStoragePanel();
}

function renderLibrary() {
  $('library').hidden = !libEntries.length;
  $('libCount').textContent = libEntries.length;
  $('libFilter').hidden = libEntries.length < 7;
  const q = $('libFilter').value.trim().toLowerCase();
  const grid = $('libraryGrid');
  grid.innerHTML = '';
  const shown = libEntries.filter(e => !q || e.title.toLowerCase().includes(q));
  if (!shown.length) grid.appendChild(el('p', 'lib-empty', 'Nothing matches that filter.'));
  shown.forEach(e => grid.appendChild(libraryCard(e)));
}
$('libFilter').addEventListener('input', renderLibrary);

function libraryCard(e) {
  const card = el('div', 'lib-card ' + e.status);
  card.tabIndex = 0;
  if (e.session === sessionId) card.classList.add('current');

  const thumb = el('div', 'lib-thumb');
  if (e.thumb_url) {
    const img = el('img');
    img.src = e.thumb_url;
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);
  } else {
    thumb.appendChild(el('div', 'placeholder', '🎬'));
  }
  if (e.duration) thumb.appendChild(el('span', 'badge dur', fmtDur(e.duration)));
  if (e.export_count) thumb.appendChild(el('span', 'badge gifs', `${e.export_count} GIF${e.export_count === 1 ? '' : 's'}`));

  if (e.status === 'working') {
    const ov = el('div', 'lib-overlay');
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.width = ((e.job && e.job.progress || 0) * 100) + '%';
    bar.appendChild(fill);
    ov.append(bar, el('div', '', (e.job && e.job.message) || 'Working…'));
    thumb.appendChild(ov);
  } else if (e.status === 'incomplete') {
    const ov = el('div', 'lib-overlay');
    ov.appendChild(el('div', 'warn', e.source_type === 'youtube' ? '⚠ Download didn’t finish' : '⚠ Never finished processing'));
    // Usually a retry that worked the second time: say so, so it's clearly safe to delete.
    if (libEntries.some(x => x.status === 'ready' && x.title === e.title)) {
      ov.appendChild(el('div', '', 'You also have a finished copy of this one.'));
    }
    if (e.resume) {
      const btn = el('button', 'small', '↻ Finish it');
      btn.addEventListener('click', ev => { ev.stopPropagation(); resumeEntry(e); });
      ov.appendChild(btn);
    }
    thumb.appendChild(ov);
  }
  card.appendChild(thumb);
  const title = el('div', 'lib-title', e.title);
  title.title = e.title;
  card.appendChild(title);

  const actions = el('div', 'lib-actions');
  const rename = el('button', '', '✎');
  rename.title = 'Rename';
  rename.setAttribute('aria-label', 'Rename');
  rename.addEventListener('click', ev => { ev.stopPropagation(); renameEntry(e); });
  const del = el('button', 'del', '🗑');
  del.title = 'Delete';
  del.setAttribute('aria-label', 'Delete');
  del.addEventListener('click', ev => { ev.stopPropagation(); deleteEntry(e); });
  actions.append(rename, del);
  card.appendChild(actions);

  const activate = () => {
    if (e.status === 'ready') openSession(e.session);
    else if (e.status === 'working' && e.job && backend.follow) {
      working(() => backend.follow(e, progressTo(srcProgress))).then(openResult);
    }
    else resumeEntry(e);
  };
  card.addEventListener('click', activate);
  card.addEventListener('keydown', ev => { if (ev.key === 'Enter') activate(); });
  return card;
}

async function resumeEntry(e) {
  let url = null;
  if (e.resume === 'needs_url') {
    url = prompt(`"${e.title}" stopped downloading partway, and this older entry doesn't remember which link it came from.\n\nPaste the YouTube link to finish the download (it picks up where it left off):`);
    if (!url) return;
    url = url.trim();
  } else if (!e.resume) {
    alert(`"${e.title}" can't be finished: its original file is missing. You can delete it from your list.`);
    return;
  }
  showProgress(srcProgress, { message: 'Picking up where it left off…', progress: null });
  await openResult(await working(() => backend.resume(e, url, progressTo(srcProgress))));
}

async function renameEntry(e) {
  const title = prompt('Rename this video:', e.title);
  if (!title || !title.trim() || title.trim() === e.title) return;
  const res = await backend.rename(e.session, title.trim());
  if (res.error) { alert(res.error); return; }
  if (e.session === sessionId) { session.title = res.title; renderSteps(); }
  loadLibrary();
}

async function deleteEntry(e) {
  const gifs = e.export_count ? ` and the ${e.export_count} GIF${e.export_count === 1 ? '' : 's'} made from it` : '';
  const what = backend.mode === 'browser'
    ? 'This removes its clip, captions and GIFs from this browser for good. (Your original video file isn’t affected.)'
    : 'This removes the downloaded video from your list for good — you’d have to download it again to reuse it.';
  if (!confirm(`Delete "${e.title}"${gifs}?\n\n${what}`)) return;
  const res = await backend.remove(e.session);
  if (res.error) { alert(res.error); return; }
  if (e.session === sessionId) closeSession();
  loadLibrary();
}

// --- Opening a video (restores everything saved for it) ---
async function openSession(sid) {
  const info = await backend.open(sid);
  if (info.error) { showStatus(srcProgress, 'Error: ' + info.error, 'error'); return; }
  if (info.status !== 'ready') { showStatus(srcProgress, 'That video isn’t ready yet.', 'error'); return; }
  saveNow();  // flush pending edits to the previous video first
  restoring = true;

  sessionId = sid;
  session = info;
  const st = info.state || {};
  duration = info.duration || 0;
  fps = info.fps || 30;
  const range = st.range || info.clip || defaultRange();
  startTime = range.start;
  endTime = range.end;
  previewLooping = false;
  if (info.video_url) $('player').src = info.video_url;
  else { $('player').removeAttribute('src'); $('player').load(); }
  setNeedsSource(!!info.needs_source, info.source_name);
  $('downloadSourceLink').hidden = !info.download_url;
  if (info.download_url) $('downloadSourceLink').href = info.download_url;

  applyStyle({ ...defaultStyle(), ...recall('style'), ...(st.style || {}) });
  applyOutput({ ...recall('output'), ...(st.output || {}) });
  $('clipName').value = st.name || '';
  if (st.maxChars) { $('maxCaptionChars').value = st.maxChars; $('maxCaptionCharsVal').textContent = st.maxChars; }
  if (st.model && cfg.models.some(m => m.name === st.model)) $('modelSel').value = st.model;
  $('langSel').value = [st.language, recall('language').code, cfg.default_language]
    .find(code => code && cfg.languages.some(([c]) => c === code));

  // Captions are stored relative to the clip they were made on (st.clip);
  // loadClip shifts them if the current clip covers a different range.
  selectedCapId = null;
  setCaptions([]);
  words = [];
  clipRange = null;
  showProgress($('cutProgress'), null);
  showProgress($('transcribeProgress'), null);
  showProgress($('makeProgress'), null);
  showProgress($('relinkProgress'), null);
  if (info.clip) {
    clipRange = st.clip || info.clip;
    words = st.words || [];
    setCaptions(st.captions || []);
    loadClip(info.clip, info.clip_url, info.waveform_url);
  } else {
    $('clipPlayer').removeAttribute('src');
    $('clipPlayer').load();
    clipDur = 0;
    renderAll();
    renderWordTicks();
  }
  renderExports(info.exports);

  reached = info.clip ? 3 : 2;
  openStep(reached);
  updateRangeUI();
  // The id in the URL lets a refresh reopen this video (pointless, and a
  // trace left in the history, when nothing is being saved).
  if (!privateMode) history.replaceState(null, '', location.pathname + location.search + '#' + sid);
  document.body.classList.add('has-session');
  renderLibrary();
  restoring = false;
}

function closeSession() {
  sessionId = session = clipRange = null;
  $('player').removeAttribute('src');
  $('clipPlayer').removeAttribute('src');
  setCaptions([]);
  renderExports([]);
  reached = 1;
  openStep(1);
  history.replaceState(null, '', location.pathname + location.search);
  document.body.classList.remove('has-session');
}

// In browser mode the original file is only used for the visit it was picked
// in (it's never copied). Coming back later, the clip and GIFs are still
// there, but picking a new range needs the file again.
function setNeedsSource(needs, name) {
  $('relinkBanner').hidden = !needs;
  $('rangeTools').classList.toggle('disabled', needs);
  $('rangeBars').classList.toggle('disabled', needs);
  if (needs) {
    $('relinkText').textContent = name
      ? `The app doesn’t keep a copy of your video — it’s “${name}” on your device.`
      : 'The app doesn’t keep a copy of your video, so it needs the same file again.';
  }
}
async function relinkFile(file) {
  if (!file || !sessionId || !backend.relink) return;
  const sid = sessionId;
  $('relinkBtn').disabled = true;
  const r = await working(() => backend.relink(sid, file, progressTo($('relinkProgress'))));
  $('relinkBtn').disabled = false;
  if (r.error) { showStatus($('relinkProgress'), 'Error: ' + r.error, 'error'); return; }
  showProgress($('relinkProgress'), null);
  saveNow();
  await openSession(sid);
  openStep(2);
}
$('relinkBtn').addEventListener('click', () => $('relinkInput').click());
$('relinkInput').addEventListener('change', e => { relinkFile(e.target.files[0]); e.target.value = ''; });

// --- Step 2: picking the range ---
const MIN_GAP = 0.05;
const AUTO_PUSH_GAP = 2;
let previewLooping = false;

// A draggable start/end range bar over a window of the video. Two of these:
// the whole video, and a zoomed-in view around the selection (long movies
// make the whole-video bar far too coarse to fine-tune on).
function makeRangeBar(root, getWin) {
  root.classList.add('rbar');
  root.innerHTML = '<div class="rb-area"><div class="rb-track"></div><div class="rb-range"></div>'
    + '<div class="rb-handle" data-h="start" title="Drag to set the start"></div>'
    + '<div class="rb-handle" data-h="end" title="Drag to set the end"></div>'
    + '<div class="rb-playhead"></div></div><div class="rb-ruler"></div>';
  const area = root.querySelector('.rb-area');
  const range = root.querySelector('.rb-range');
  const [hs, he] = root.querySelectorAll('.rb-handle');
  const ph = root.querySelector('.rb-playhead');
  const ruler = root.querySelector('.rb-ruler');
  // While dragging in this bar its window is frozen, so the view doesn't
  // shift under the pointer.
  const bar = { frozen: null };
  const win = () => bar.frozen || getWin();
  const pct = (t, w) => ((t - w.t0) / Math.max(1e-6, w.t1 - w.t0)) * 100;
  const timeAt = (x, w) => {
    const r = area.getBoundingClientRect();
    return w.t0 + clamp((x - r.left) / r.width, 0, 1) * (w.t1 - w.t0);
  };
  let rulerKey = '';

  bar.render = () => {
    const w = win();
    const s = pct(startTime, w), e = pct(endTime, w);
    const cs = clamp(s, 0, 100), ce = clamp(e, 0, 100);
    range.style.left = cs + '%';
    range.style.width = Math.max(0, ce - cs) + '%';
    hs.style.left = s + '%';
    he.style.left = e + '%';
    hs.hidden = s < -0.5 || s > 100.5;
    he.hidden = e < -0.5 || e > 100.5;
    const key = `${w.t0.toFixed(3)}|${w.t1.toFixed(3)}|${area.clientWidth}`;
    if (key !== rulerKey) {
      rulerKey = key;
      renderTicks(ruler, w.t0, w.t1, area.clientWidth, duration >= 60);
    }
    bar.renderPlayhead();
  };
  bar.renderPlayhead = () => {
    const p = pct($('player').currentTime || 0, win());
    ph.style.left = p + '%';
    ph.hidden = p < 0 || p > 100;
  };

  function drag(target, e, onMove) {
    e.preventDefault();
    bar.frozen = win();
    target.setPointerCapture(e.pointerId);
    const move = ev => onMove(timeAt(ev.clientX, bar.frozen));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      bar.frozen = null;
      updateRangeUI();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  [hs, he].forEach(h => h.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !duration) return;
    e.stopPropagation();
    stopPreview();
    $('player').pause();
    drag(h, e, t => {
      if (h.dataset.h === 'start') startTime = clamp(t, 0, endTime - MIN_GAP);
      else endTime = clamp(t, startTime + MIN_GAP, duration);
      $('player').currentTime = h.dataset.h === 'start' ? startTime : endTime;
      updateRangeUI();
    });
  }));
  // Pressing elsewhere seeks; dragging there scrubs.
  area.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !duration || e.target.classList.contains('rb-handle')) return;
    const seek = t => { $('player').currentTime = t; updatePlayheads(); };
    drag(area, e, seek);
    seek(timeAt(e.clientX, bar.frozen));
  });
  return bar;
}

function zoomWindow() {
  const pad = Math.max(1, (endTime - startTime) * 0.5);
  return { t0: Math.max(0, startTime - pad), t1: Math.min(duration, endTime + pad) };
}
const mainBar = makeRangeBar($('rangeMain'), () => ({ t0: 0, t1: duration || 1 }));
const zoomBar = makeRangeBar($('rangeZoom'), zoomWindow);

const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function renderTicks(ruler, t0, t1, widthPx, long) {
  ruler.innerHTML = '';
  const span = t1 - t0;
  if (span <= 0) return;
  const maxLabels = Math.max(2, Math.floor((widthPx || 600) / 70));
  const step = TICK_STEPS.find(s => span / s <= maxLabels) || 3600;
  const dec = step < 0.5 ? 2 : step < 1 ? 1 : 0;
  const first = Math.ceil(t0 / step - 1e-9);
  for (let i = first; i * step <= t1 + 1e-6; i++) {
    const t = i * step;
    const p = ((t - t0) / span) * 100;
    const tick = el('div', 'tick');
    tick.style.left = p + '%';
    // Skip labels that would hang off either end of the track.
    if (p > 1.5 && p < 96) {
      let label;
      if (long) {
        const m = Math.floor(t / 60), s = t - m * 60;
        label = `${m}:${s.toFixed(dec).padStart(dec ? dec + 3 : 2, '0')}`;
      } else {
        label = t.toFixed(dec) + 's';
      }
      tick.appendChild(el('span', '', label));
    }
    ruler.appendChild(tick);
  }
}

function clipMatchesRange() {
  return clipRange && Math.abs(clipRange.start - startTime) < 0.005 && Math.abs(clipRange.end - endTime) < 0.005;
}

function updateRangeUI() {
  if (duration) {
    startTime = clamp(startTime, 0, Math.max(0, duration - MIN_GAP));
    endTime = clamp(endTime, startTime + MIN_GAP, duration);
  }
  mainBar.render();
  const zw = zoomWindow();
  $('zoomRow').hidden = !(duration && (zw.t1 - zw.t0) < duration * 0.6) && !zoomBar.frozen;
  if (!$('zoomRow').hidden) zoomBar.render();
  setIfIdle($('startInput'), fmtTime(startTime));
  setIfIdle($('endInput'), fmtTime(endTime));
  const len = endTime - startTime;
  $('selLen').textContent = len.toFixed(2) + 's';
  // GIFs of a whole scene get huge; nudge people toward a short moment.
  $('lenWarn').hidden = len <= 30;
  $('lenWarn').textContent = len > 120
    ? 'That’s long for a GIF — it will take a while and the file will be big. Try under 10 seconds.'
    : 'Tip: GIFs work best under about 10 seconds.';
  const valid = duration > 0 && endTime > startTime;
  $('cutBtn').disabled = !valid;
  $('previewSelBtn').disabled = !valid;
  if (!$('cutBtn').dataset.busy) {
    $('cutBtn').textContent = clipMatchesRange() ? 'Continue →' : 'Use this part →';
  }
  renderSteps();
  scheduleSave();
}

function updatePlayheads() {
  mainBar.renderPlayhead();
  if (!$('zoomRow').hidden) zoomBar.renderPlayhead();
}

$('player').addEventListener('loadedmetadata', () => {
  duration = $('player').duration || duration;
  if (!(endTime > startTime) || endTime > duration + 0.01) ({ start: startTime, end: endTime } = defaultRange());
  updateRangeUI();
});

// A short clip starts fully selected; for anything longer (a whole movie),
// start with a few seconds so there's something sensible to drag.
function defaultRange() {
  return { start: 0, end: duration <= 15 ? duration : Math.min(duration, 5) };
}
['timeupdate', 'seeked'].forEach(ev => $('player').addEventListener(ev, updatePlayheads));
// Per-frame loop while playing: smooth playheads, and a tight preview loop
// (timeupdate alone only fires ~4x a second, so the loop would overshoot).
let rangeRaf = null;
function rangeLoop() {
  const p = $('player');
  if (previewLooping && p.currentTime >= endTime) p.currentTime = startTime;
  updatePlayheads();
  rangeRaf = p.paused ? null : requestAnimationFrame(rangeLoop);
}
$('player').addEventListener('play', () => { if (!rangeRaf) rangeRaf = requestAnimationFrame(rangeLoop); });
$('player').addEventListener('pause', stopPreview);
new ResizeObserver(() => { if (openN === 2) updateRangeUI(); }).observe($('rangeMain'));

function setStartAt(t) {
  startTime = clamp(t, 0, duration);
  if (endTime <= startTime + MIN_GAP) endTime = Math.min(duration, startTime + AUTO_PUSH_GAP);
  startTime = Math.min(startTime, endTime - MIN_GAP);
  updateRangeUI();
}
function setEndAt(t) {
  endTime = clamp(t, 0, duration);
  if (startTime >= endTime - MIN_GAP) startTime = Math.max(0, endTime - AUTO_PUSH_GAP);
  endTime = Math.max(endTime, startTime + MIN_GAP);
  updateRangeUI();
}
$('markStartBtn').addEventListener('click', () => setStartAt($('player').currentTime));
$('markEndBtn').addEventListener('click', () => setEndAt($('player').currentTime));

[['startInput', setStartAt, () => startTime], ['endInput', setEndAt, () => endTime]].forEach(([id, set, get]) => {
  const input = $(id);
  input.addEventListener('change', () => {
    const t = parseTime(input.value);
    if (!isNaN(t)) {
      set(t);
      $('player').pause();
      $('player').currentTime = get();
    }
    input.value = fmtTime(get());
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
});

document.querySelectorAll('.nudge').forEach(btn => {
  btn.addEventListener('click', () => {
    const delta = parseFloat(btn.dataset.delta);
    if (btn.dataset.target === 'start') startTime = clamp(startTime + delta, 0, endTime - MIN_GAP);
    else endTime = clamp(endTime + delta, startTime + MIN_GAP, duration);
    stopPreview();
    $('player').pause();
    $('player').currentTime = btn.dataset.target === 'start' ? startTime : endTime;
    updateRangeUI();
  });
});

function stopPreview() {
  if (!previewLooping) return;
  previewLooping = false;
  $('previewSelBtn').textContent = '► Watch just this part';
}
function togglePreview() {
  if (previewLooping) { $('player').pause(); stopPreview(); return; }
  previewLooping = true;
  $('player').currentTime = startTime;
  $('player').play();
  $('previewSelBtn').textContent = '❚❚ Stop watching';
}
$('previewSelBtn').addEventListener('click', togglePreview);

async function cutAndContinue() {
  if ($('cutBtn').disabled) return;
  stopPreview();
  $('player').pause();
  if (clipMatchesRange()) { openStep(3); return; }
  $('cutBtn').disabled = true;
  $('cutBtn').dataset.busy = '1';
  $('cutBtn').textContent = 'Cutting…';
  const sid = sessionId;
  const r = await working(() => backend.cut(sid,
    Math.round(startTime * 1000) / 1000, Math.round(endTime * 1000) / 1000, progressTo($('cutProgress'))));
  delete $('cutBtn').dataset.busy;
  $('cutBtn').disabled = false;
  if (sid !== sessionId) return;  // switched videos meanwhile
  if (r.error) { showStatus($('cutProgress'), 'Error: ' + r.error, 'error'); updateRangeUI(); return; }
  showProgress($('cutProgress'), null);
  if (r.fps) fps = r.fps;
  loadClip(r.clip, r.clip_url, r.waveform_url);
  openStep(3);
  updateRangeUI();
  scheduleSave();
}
$('cutBtn').addEventListener('click', cutAndContinue);

// Recutting a different range shifts the captions so they stay on the same
// moment of the video.
function loadClip(clip, url, waveUrl) {
  const newDur = clip.end - clip.start;
  if (clipRange) {
    const off = clipRange.start - clip.start;
    if (Math.abs(off) > 1e-4 || Math.abs(clipRange.end - clip.end) > 1e-4) {
      captions = captions
        .map(c => ({ ...c, start: round2(c.start + off), end: round2(c.end + off) }))
        .filter(c => c.end > MIN_CAP && c.start < newDur - MIN_CAP)
        .map(c => ({ ...c, start: Math.max(0, c.start), end: Math.min(round2(newDur), c.end) }));
      words = words
        .map(w => ({ start: round2(w.start + off), end: round2(w.end + off) }))
        .filter(w => w.start >= 0 && w.end <= newDur);
    }
  }
  clipRange = { start: clip.start, end: clip.end };
  clipDur = newDur;
  $('clipPlayer').src = url;
  $('capWave').style.backgroundImage = waveUrl ? `url(${waveUrl})` : 'none';
  sortCaptions();
  renderRuler();
  renderWordTicks();
  renderAll();
}

// --- Step 3: Caption the clip ---
// `captions` is the single source of truth. The timeline blocks, the list
// rows and the preview overlay on the video are all drawn from it.
let captions = [];  // { id, start, end, text }, kept sorted by start
let words = [];     // Whisper word boundaries, used as snap points
let nextCapId = 1;
let selectedCapId = null;
let clipDur = 0;

const CAP_COLORS = ['#5b8cff', '#f59e0b', '#4ade80', '#f472b6', '#a78bfa', '#22d3ee'];
const LANE_H = 30;
const MIN_CAP = 0.1;
const SNAP_PX = 8;

const blockEls = new Map();
const rowEls = new Map();

function capById(id) { return captions.find(c => c.id === id); }
function capColor(i) { return CAP_COLORS[i % CAP_COLORS.length]; }
function sortCaptions() { captions.sort((a, b) => a.start - b.start || a.end - b.end); }
function round2(t) { return Math.round(t * 100) / 100; }
function clipPct(t) { return clipDur ? (t / clipDur) * 100 : 0; }

function setCaptions(segments) {
  captions = segments.map(seg => ({
    id: nextCapId++, start: Number(seg.start), end: Number(seg.end), text: seg.text || ''
  }));
  sortCaptions();
  selectedCapId = null;
  renderAll();
}

function renderAll() {
  renderList();
  renderTrack();
  renderOverlay(true);
}

// Overlapping captions go into extra lanes instead of drawing on top of each other.
function assignLanes() {
  const laneEnds = [];
  const lanes = {};
  [...captions].sort((a, b) => a.start - b.start).forEach(c => {
    let lane = laneEnds.findIndex(end => end <= c.start + 1e-6);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(c.end); }
    else laneEnds[lane] = c.end;
    lanes[c.id] = lane;
  });
  return { lanes, count: Math.max(1, laneEnds.length) };
}

// --- Timeline track ---
function renderTrack() {
  const lanesEl = $('capLanes');
  const { lanes, count } = assignLanes();
  lanesEl.style.height = (count * LANE_H + 8) + 'px';
  $('capEmpty').style.display = captions.length ? 'none' : '';

  const live = new Set();
  captions.forEach((c, i) => {
    live.add(c.id);
    let blk = blockEls.get(c.id);
    if (!blk) {
      blk = makeBlock(c.id);
      blockEls.set(c.id, blk);
      lanesEl.appendChild(blk);
    }
    blk.style.left = clipPct(c.start) + '%';
    blk.style.width = Math.max(0, clipPct(c.end) - clipPct(c.start)) + '%';
    blk.style.top = (4 + lanes[c.id] * LANE_H) + 'px';
    blk.style.setProperty('--c', capColor(i));
    blk.querySelector('.cap-badge').textContent = i + 1;
    blk.querySelector('.cap-label').textContent = c.text;
    blk.title = `${i + 1}. ${c.text || '(empty)'}\n${fmt(c.start)} – ${fmt(c.end)}`;
    blk.classList.toggle('selected', c.id === selectedCapId);
  });
  for (const [id, blk] of blockEls) {
    if (!live.has(id)) { blk.remove(); blockEls.delete(id); }
  }
  updateNamePlaceholder();
  renderSteps();
  scheduleSave();
}

function makeBlock(id) {
  const blk = document.createElement('div');
  blk.className = 'cap-block';
  blk.innerHTML = '<span class="cap-edge l"></span><span class="cap-badge"></span><span class="cap-label"></span><span class="cap-edge r"></span>';
  blk.addEventListener('pointerdown', (e) => startBlockDrag(e, id));
  blk.addEventListener('dblclick', (e) => { e.stopPropagation(); focusCaptionText(id); });
  blk.addEventListener('mouseenter', () => rowEls.get(id)?.classList.add('hover'));
  blk.addEventListener('mouseleave', () => rowEls.get(id)?.classList.remove('hover'));
  return blk;
}

function renderRuler() {
  renderTicks($('capRuler'), 0, clipDur, $('capTimeline').clientWidth, false);
}
new ResizeObserver(() => { if (openN === 3) renderRuler(); }).observe($('capTimeline'));

function renderWordTicks() {
  const wave = $('capWave');
  wave.querySelectorAll('.cap-word').forEach(w => w.remove());
  if (!clipDur) return;
  words.forEach(w => {
    const tick = el('div', 'cap-word');
    tick.style.left = clipPct(w.start) + '%';
    wave.appendChild(tick);
  });
}

function snapTargets(excludeId, playheadAt) {
  const targets = [0, clipDur, playheadAt];
  captions.forEach(c => { if (c.id !== excludeId) targets.push(c.start, c.end); });
  words.forEach(w => targets.push(w.start, w.end));
  return targets;
}

function nearestSnap(t, targets, tol) {
  let best = null;
  for (const x of targets) {
    const dist = Math.abs(t - x);
    if (dist <= tol && (!best || dist < best.dist)) best = { t: x, dist };
  }
  return best;
}

function showSnapGuide(t) {
  const guide = $('capSnap');
  if (t === null) { guide.style.display = 'none'; return; }
  guide.style.left = clipPct(t) + '%';
  guide.style.display = 'block';
}

// Dragging the middle of a block moves the whole caption, dragging an edge
// trims its start or end. A press without movement just selects + seeks.
function startBlockDrag(e, id) {
  if (e.button !== 0 || !clipDur) return;
  e.preventDefault();
  e.stopPropagation();
  const c = capById(id);
  const mode = e.target.classList.contains('l') ? 'start'
             : e.target.classList.contains('r') ? 'end' : 'move';
  const player = $('clipPlayer');
  player.pause();
  selectCaption(id);

  const rect = $('capTimeline').getBoundingClientRect();
  const secPerPx = clipDur / rect.width;
  const tol = SNAP_PX * secPerPx;
  const targets = snapTargets(id, player.currentTime);
  const x0 = e.clientX, s0 = c.start, e0 = c.end, len = e0 - s0;
  let moved = false;

  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    const dt = dx * secPerPx;
    const snap = !ev.altKey;
    let guide = null;

    if (mode === 'move') {
      let ns = s0 + dt;
      if (snap) {
        const a = nearestSnap(ns, targets, tol);
        const b = nearestSnap(ns + len, targets, tol);
        if (a && (!b || a.dist <= b.dist)) { ns = a.t; guide = a.t; }
        else if (b) { ns = b.t - len; guide = b.t; }
      }
      ns = Math.min(Math.max(0, ns), Math.max(0, clipDur - len));
      c.start = round2(ns);
      c.end = round2(ns + len);
      seekClip(c.start);
    } else if (mode === 'start') {
      let t = s0 + dt;
      if (snap) { const a = nearestSnap(t, targets, tol); if (a) { t = a.t; guide = a.t; } }
      c.start = round2(Math.min(Math.max(0, t), c.end - MIN_CAP));
      seekClip(c.start);
    } else {
      let t = e0 + dt;
      if (snap) { const a = nearestSnap(t, targets, tol); if (a) { t = a.t; guide = a.t; } }
      c.end = round2(Math.max(Math.min(clipDur, t), c.start + MIN_CAP));
      // Just before the end, so the frame shown still has this caption on it.
      seekClip(Math.max(c.start, c.end - 0.05));
    }
    showSnapGuide(guide);
    renderTrack();
    renderList();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    showSnapGuide(null);
    if (moved) {
      sortCaptions();
      renderAll();
    } else {
      seekClip(c.start);
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Pressing on empty track seeks, and dragging there scrubs.
$('capTimeline').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !clipDur || e.target.closest('.cap-block')) return;
  const rect = $('capTimeline').getBoundingClientRect();
  const seekAt = (ev) => seekClip(Math.min(clipDur, Math.max(0, ((ev.clientX - rect.left) / rect.width) * clipDur)));
  seekAt(e);
  const up = () => {
    document.removeEventListener('pointermove', seekAt);
    document.removeEventListener('pointerup', up);
  };
  document.addEventListener('pointermove', seekAt);
  document.addEventListener('pointerup', up);
});

$('capTimeline').addEventListener('dblclick', (e) => {
  if (!clipDur || e.target.closest('.cap-block')) return;
  const rect = $('capTimeline').getBoundingClientRect();
  addCaptionAt(((e.clientX - rect.left) / rect.width) * clipDur);
});

// --- Caption list ---
function renderList() {
  const list = $('captionList');
  const live = new Set();
  captions.forEach((c, i) => {
    live.add(c.id);
    let row = rowEls.get(c.id);
    if (!row) { row = makeRow(c.id); rowEls.set(c.id, row); }
    if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
    row.style.setProperty('--c', capColor(i));
    row.querySelector('.cap-num').textContent = i + 1;
    setIfIdle(row.querySelector('[data-field="start"]'), c.start.toFixed(2));
    setIfIdle(row.querySelector('[data-field="end"]'), c.end.toFixed(2));
    setIfIdle(row.querySelector('.cap-text'), c.text);
    row.classList.toggle('selected', c.id === selectedCapId);
  });
  for (const [id, row] of rowEls) {
    if (!live.has(id)) { row.remove(); rowEls.delete(id); }
  }
}

// Don't overwrite a field while the user is typing in it.
function setIfIdle(input, value) {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}

function makeRow(id) {
  const row = document.createElement('div');
  row.className = 'caption-row';
  row.innerHTML = `
    <button type="button" class="cap-num" title="Jump to this caption"></button>
    <input type="number" class="cap-time" data-field="start" step="0.1" min="0" aria-label="Starts at (seconds)">
    <span class="time-sep">–</span>
    <input type="number" class="cap-time" data-field="end" step="0.1" min="0" aria-label="Ends at (seconds)">
    <input type="text" class="cap-text" placeholder="Type the caption…" aria-label="Caption text">
    <button type="button" class="cap-del" title="Delete this caption" aria-label="Delete this caption">✕</button>
  `;
  row.querySelector('.cap-num').addEventListener('click', () => {
    selectCaption(id);
    seekClip(capById(id).start);
  });
  let lenBeforeEdit = 0;
  row.querySelectorAll('.cap-time').forEach(input => {
    input.addEventListener('focus', () => {
      const c = capById(id);
      lenBeforeEdit = c.end - c.start;
    });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (isNaN(v)) return;
      capById(id)[input.dataset.field] = v;
      renderTrack();
      renderOverlay(true);
    });
    input.addEventListener('change', () => {
      const c = capById(id);
      const max = clipDur || Infinity;
      c.start = round2(Math.min(Math.max(0, c.start), max - MIN_CAP));
      // Typing a start past the end moves the caption instead of squashing it.
      if (input.dataset.field === 'start' && c.end <= c.start) c.end = c.start + Math.max(lenBeforeEdit, MIN_CAP);
      c.end = round2(Math.min(Math.max(c.end, c.start + MIN_CAP), max));
      sortCaptions();
      renderAll();
      const field = input.dataset.field;
      seekClip(field === 'start' ? c.start : Math.max(c.start, c.end - 0.05));
    });
  });
  row.querySelector('.cap-text').addEventListener('input', (e) => {
    capById(id).text = e.target.value;
    renderTrack();
    renderOverlay(true);
  });
  row.querySelector('.cap-del').addEventListener('click', () => deleteCaption(id));
  row.addEventListener('focusin', () => {
    selectCaption(id);
    // Show the caption on the video while editing it, unless it's playing.
    const player = $('clipPlayer');
    const c = capById(id);
    if (player.paused && (player.currentTime < c.start || player.currentTime >= c.end)) seekClip(c.start);
  });
  row.addEventListener('mouseenter', () => blockEls.get(id)?.classList.add('hover'));
  row.addEventListener('mouseleave', () => blockEls.get(id)?.classList.remove('hover'));
  return row;
}

function selectCaption(id) {
  selectedCapId = id;
  for (const [cid, blk] of blockEls) blk.classList.toggle('selected', cid === id);
  for (const [cid, row] of rowEls) row.classList.toggle('selected', cid === id);
}

function focusCaptionText(id) {
  const input = rowEls.get(id)?.querySelector('.cap-text');
  if (!input) return;
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  input.select();
}

function addCaptionAt(t) {
  const max = clipDur || Infinity;
  const start = round2(Math.min(Math.max(0, t), Math.max(0, max - MIN_CAP)));
  // Fill up to 2s, stopping at the next caption; if there's no room at all,
  // overlap it (it'll get its own lane) rather than making a sliver.
  const next = captions.filter(c => c.start > start + 1e-6).reduce((m, c) => Math.min(m, c.start), max);
  let end = Math.min(start + 2, next);
  if (end - start < 0.5) end = Math.min(start + 2, max);
  end = round2(Math.max(end, start + MIN_CAP));

  const c = { id: nextCapId++, start, end, text: '' };
  captions.push(c);
  sortCaptions();
  selectedCapId = c.id;
  renderAll();
  focusCaptionText(c.id);
}

function deleteCaption(id) {
  captions = captions.filter(c => c.id !== id);
  if (selectedCapId === id) selectedCapId = null;
  renderAll();
}

function addCaptionAtPlayhead() {
  // If the playhead is sitting on a caption, add the new one right after it.
  let t = $('clipPlayer').currentTime || 0;
  captions.forEach(c => { if (t >= c.start && t < c.end) t = Math.max(t, c.end); });
  addCaptionAt(t);
}
$('addCaptionBtn').addEventListener('click', addCaptionAtPlayhead);

// --- Keyboard shortcuts (for whichever step is open) ---
function frameStep(player, dir) {
  player.pause();
  player.currentTime = clamp(player.currentTime + dir / fps, 0, player.duration || Infinity);
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('helpDialog').open) return;
  const t = e.target;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
      || (t.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(t.type))) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  let handled = true;

  if (openN === 2 && duration && $('relinkBanner').hidden) {
    const p = $('player');
    if (key === ' ') { if (p.paused) p.play(); else p.pause(); }
    else if (key === 'i') setStartAt(p.currentTime);
    else if (key === 'o') setEndAt(p.currentTime);
    else if (key === 'p') togglePreview();
    else if (key === ',' || key === '.') frameStep(p, key === ',' ? -1 : 1);
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      p.currentTime = clamp(p.currentTime + (e.shiftKey ? 5 : 1) * (key === 'ArrowLeft' ? -1 : 1), 0, duration);
    }
    else if (key === '[') { p.pause(); p.currentTime = startTime; }
    else if (key === ']') { p.pause(); p.currentTime = endTime; }
    // Enter on a focused button should press that button, not cut.
    else if (key === 'Enter' && t.tagName !== 'BUTTON' && t.tagName !== 'A' && t.tagName !== 'SUMMARY') cutAndContinue();
    else handled = false;
  } else if (openN === 3 && clipDur) {
    const p = $('clipPlayer');
    const c = selectedCapId !== null ? capById(selectedCapId) : null;
    if (key === ' ') { if (p.paused) p.play(); else p.pause(); }
    else if (key === ',' || key === '.') frameStep(p, key === ',' ? -1 : 1);
    else if (key === 'n') { e.preventDefault(); addCaptionAtPlayhead(); }
    else if (c && (key === 'Delete' || key === 'Backspace')) deleteCaption(c.id);
    else if (c && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const step = (e.shiftKey ? 0.01 : 0.1) * (key === 'ArrowLeft' ? -1 : 1);
      const len = c.end - c.start;
      const ns = Math.min(Math.max(0, c.start + step), Math.max(0, clipDur - len));
      c.start = round2(ns);
      c.end = round2(ns + len);
      sortCaptions();
      renderAll();
      seekClip(c.start);
    }
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      seekClip(clamp(p.currentTime + (e.shiftKey ? 1 : 0.25) * (key === 'ArrowLeft' ? -1 : 1), 0, clipDur));
    }
    else if (c && key === 'Escape') selectCaption(null);
    else handled = false;
  } else {
    handled = false;
  }
  if (handled) e.preventDefault();
}, true);

// --- Playhead + live caption preview on the video ---
function seekClip(t) {
  $('clipPlayer').currentTime = t;
  updatePlayhead();
  renderOverlay();
}

function updatePlayhead() {
  const t = $('clipPlayer').currentTime;
  $('capPlayhead').style.left = clipPct(t) + '%';
  $('clipTime').textContent = `${fmt(Math.min(t, clipDur))} / ${fmt(clipDur)}`;
}

function toggleClipPlay() {
  const player = $('clipPlayer');
  if (player.paused) player.play(); else player.pause();
}
$('clipPlayBtn').addEventListener('click', toggleClipPlay);
$('clipPlayer').addEventListener('click', toggleClipPlay);
$('clipPlayer').addEventListener('play', () => { $('clipPlayBtn').textContent = '❚❚ Pause'; });
['pause', 'ended'].forEach(ev => $('clipPlayer').addEventListener(ev, () => { $('clipPlayBtn').textContent = '► Play'; }));

let overlayKey = '';
function renderOverlay(force = false) {
  const player = $('clipPlayer');
  const t = player.currentTime;
  const style = getStyle();
  const active = captions.filter(c => c.text.trim() && t >= c.start && t < c.end);
  const key = active.map(c => c.id + ':' + c.text).join('|');
  if (!force && key === overlayKey) return;
  overlayKey = key;

  const overlay = $('capOverlay');
  const boxW = player.clientWidth, boxH = player.clientHeight;
  if (!boxH) return;
  // The video is letterboxed inside its element (max-height), so line the
  // overlay up with the actual picture rather than the element's box.
  const vw = player.videoWidth || 16, vh = player.videoHeight || 9;
  const scale = Math.min(boxW / vw, boxH / vh);
  const w = vw * scale, h = vh * scale;
  Object.assign(overlay.style, {
    left: (boxW - w) / 2 + 'px', top: (boxH - h) / 2 + 'px', width: w + 'px', height: h + 'px',
  });

  const sy = h / ASS_RES_Y, sx = w / ASS_RES_X;
  const font = cfg.fonts.find(f => f.family === style.font) || { family: style.font, em: 1.164 };
  // ScaledBorderAndShadow is on in the export, so the outline scales with the script like the text.
  const outline = style.outline * sy, shadow = (style.outline ? 1 : 0) * sy;
  const shadows = [];
  if (outline > 0) {
    for (let a = 0; a < 16; a++) {
      const rad = (a / 16) * Math.PI * 2;
      shadows.push(`${(Math.cos(rad) * outline).toFixed(2)}px ${(Math.sin(rad) * outline).toFixed(2)}px 0 #000`);
    }
    shadows.push(`${(outline + shadow).toFixed(2)}px ${(outline + shadow).toFixed(2)}px 0 #000`);
  }

  const top = style.position === 'top';
  overlay.style.fontFamily = `"${font.family}", sans-serif`;
  // libass sizes fonts by (winAscent + winDescent), browsers by the em square.
  overlay.style.fontSize = (style.fontsize * sy / font.em) + 'px';
  overlay.style.color = style.color;
  overlay.style.textShadow = shadows.join(', ') || 'none';
  overlay.style.textTransform = style.uppercase ? 'uppercase' : 'none';
  overlay.style.justifyContent = top ? 'flex-start' : 'flex-end';
  overlay.style.padding = top
    ? `${ASS_MARGIN * sy}px ${ASS_MARGIN * sx}px 0`
    : `0 ${ASS_MARGIN * sx}px ${ASS_MARGIN * sy}px`;
  overlay.innerHTML = '';
  // Earliest caption nearest the edge, later overlapping ones stack away
  // from it (the same way libass stacks them when burning in).
  (top ? active : [...active].reverse()).forEach(c => overlay.appendChild(el('div', '', c.text)));
}

let overlayRaf = null;
function overlayLoop() {
  updatePlayhead();
  renderOverlay();
  overlayRaf = $('clipPlayer').paused ? null : requestAnimationFrame(overlayLoop);
}
$('clipPlayer').addEventListener('play', () => { if (!overlayRaf) overlayRaf = requestAnimationFrame(overlayLoop); });
['seeked', 'timeupdate', 'pause'].forEach(ev => $('clipPlayer').addEventListener(ev, () => { updatePlayhead(); renderOverlay(); }));
$('clipPlayer').addEventListener('loadedmetadata', () => {
  clipDur = $('clipPlayer').duration || clipDur;
  renderRuler();
  renderWordTicks();
  renderTrack();
  updatePlayhead();
  renderOverlay(true);
});
new ResizeObserver(() => renderOverlay(true)).observe($('clipPlayer'));

// --- Caption style ---
const SWATCHES = ['#ffffff', '#ffe600', '#7dd3fc', '#86efac', '#f9a8d4'];
function defaultStyle() {
  return { font: cfg.default_font, fontsize: 32, color: '#ffffff', outline: 3, position: 'bottom', uppercase: false };
}
function getStyle() {
  return {
    font: $('fontSel').value || cfg.default_font,
    fontsize: Number($('fontSize').value),
    color: $('captionColor').value,
    outline: Number($('outline').value),
    position: $('posTop').classList.contains('active') ? 'top' : 'bottom',
    uppercase: $('uppercase').checked,
  };
}
function applyStyle(s) {
  $('fontSel').value = cfg.fonts.some(f => f.family === s.font) ? s.font : cfg.default_font;
  $('fontSize').value = s.fontsize;
  $('captionColor').value = s.color;
  $('outline').value = s.outline;
  $('uppercase').checked = !!s.uppercase;
  $('posTop').classList.toggle('active', s.position === 'top');
  $('posBottom').classList.toggle('active', s.position !== 'top');
  $('fontSizeVal').textContent = $('fontSize').value;
  $('outlineVal').textContent = $('outline').value;
  renderOverlay(true);
}
function styleChanged() {
  $('fontSizeVal').textContent = $('fontSize').value;
  $('outlineVal').textContent = $('outline').value;
  renderOverlay(true);
  remember('style', getStyle());  // new videos start with your last-used style
  scheduleSave();
}
['fontSel', 'fontSize', 'captionColor', 'outline', 'uppercase'].forEach(id => $(id).addEventListener('input', styleChanged));
['posTop', 'posBottom'].forEach(id => $(id).addEventListener('click', () => {
  $('posTop').classList.toggle('active', id === 'posTop');
  $('posBottom').classList.toggle('active', id === 'posBottom');
  styleChanged();
}));
SWATCHES.forEach(color => {
  const b = el('button');
  b.type = 'button';
  b.style.background = color;
  b.title = color;
  b.setAttribute('aria-label', `Use ${color}`);
  b.addEventListener('click', () => { $('captionColor').value = color; styleChanged(); });
  $('swatches').appendChild(b);
});

// The caption fonts ship with the app, so the preview uses exactly the
// font files the export burns in.
function loadFonts() {
  const css = cfg.fonts.filter(f => f.file).map(f => `@font-face { font-family: "${f.family}"; `
    + `src: url("fonts/${f.file}"); font-weight: ${f.weight || 700}; font-display: swap; }`).join('\n');
  const tag = el('style');
  tag.textContent = css;
  document.head.appendChild(tag);
  cfg.fonts.forEach(f => document.fonts.load(`bold 16px "${f.family}"`).then(() => renderOverlay(true), () => {}));
}

// --- Auto-caption ---
$('maxCaptionChars').addEventListener('input', () => {
  $('maxCaptionCharsVal').textContent = $('maxCaptionChars').value;
  scheduleSave();
});
$('modelSel').addEventListener('change', scheduleSave);
$('langSel').addEventListener('change', () => { remember('language', { code: $('langSel').value }); scheduleSave(); });

$('transcribeBtn').addEventListener('click', async () => {
  if (captions.length && !confirm('Replace your current captions with a fresh auto-caption?')) return;
  $('transcribeBtn').disabled = true;
  renderMiniSteps();
  const sid = sessionId;
  const r = await working(() => backend.transcribe(sid, {
    max_chars: $('maxCaptionChars').value, model: $('modelSel').value, language: $('langSel').value,
  }, progressTo($('transcribeProgress'))));
  $('transcribeBtn').disabled = false;
  if (sid !== sessionId) return;
  if (r.error) { showStatus($('transcribeProgress'), 'Error: ' + r.error, 'error'); renderMiniSteps(); return; }

  // A model that just got downloaded no longer needs the size warning.
  const m = cfg.models.find(x => x.name === $('modelSel').value);
  if (m && !m.downloaded) { m.downloaded = true; populateModels($('modelSel').value); }

  words = r.words || [];
  renderWordTicks();
  if (!r.segments.length) {
    showStatus($('transcribeProgress'), 'Couldn’t make out any speech — type your captions in by hand below.', 'error');
    setCaptions([]);
    addCaptionAt(0);
    return;
  }
  showStatus($('transcribeProgress'), r.approximate
    ? `✓ Found ${r.segments.length} caption${r.segments.length === 1 ? '' : 's'}, but the speech model couldn’t tell exactly when each one is said — play the clip and drag them into place on the timeline.`
    : `✓ Found ${r.segments.length} caption${r.segments.length === 1 ? '' : 's'}. Play the clip and fix any misheard words below.`, 'ok');
  setCaptions(r.segments);
});

function populateLanguages() {
  const sel = $('langSel');
  sel.innerHTML = '';
  cfg.languages.forEach(([code, name]) => {
    const opt = el('option', '', name);
    opt.value = code;
    sel.appendChild(opt);
  });
  const saved = recall('language').code;
  sel.value = cfg.languages.some(([c]) => c === saved) ? saved : cfg.default_language;
}

function populateModels(selected) {
  const sel = $('modelSel');
  sel.innerHTML = '';
  cfg.models.forEach(m => {
    const opt = el('option', '', m.label + (m.downloaded ? '' : ` (${m.size} download)`));
    opt.value = m.name;
    sel.appendChild(opt);
  });
  sel.value = selected || cfg.default_model;
}

// --- Export ---
function getOutput() { return { width: Number($('outputWidth').value), fps: Number($('outputFps').value) }; }
function applyOutput(o) {
  if (o.width && [...$('outputWidth').options].some(x => Number(x.value) === o.width)) $('outputWidth').value = o.width;
  if (o.fps && [...$('outputFps').options].some(x => Number(x.value) === o.fps)) $('outputFps').value = o.fps;
}
['outputWidth', 'outputFps'].forEach(id => $(id).addEventListener('change', () => { remember('output', getOutput()); scheduleSave(); }));
$('clipName').addEventListener('input', scheduleSave);

// With no name typed, the GIF is named after its captions.
function defaultName() {
  const text = captions.filter(c => c.text.trim()).map(c => c.text).join(' ');
  let slug = slugify(text || (session && session.title) || '');
  if (slug.length > 40) slug = slug.slice(0, 40).replace(/-[^-]*$/, '');
  return slug || 'movie-quote';
}
function updateNamePlaceholder() { $('clipName').placeholder = defaultName(); }

async function makeGif(overwrite = false) {
  const exportCaptions = captions
    .filter(c => c.text.trim() !== '' && !isNaN(c.start) && !isNaN(c.end) && c.end > c.start)
    .map(({ start, end, text }) => ({ start, end, text }));
  const name = slugify($('clipName').value.trim()) || defaultName();
  if (!exportCaptions.length && !overwrite && !confirm('There are no captions yet. Make the GIF without any?')) return;

  saveNow();
  const sid = sessionId;
  $('makeBtn').disabled = true;
  const r = await working(() => backend.exportGif(sid,
    { captions: exportCaptions, name, ...getStyle(), ...getOutput(), overwrite }, progressTo($('makeProgress'))));
  $('makeBtn').disabled = false;
  if (r.conflict) {
    showProgress($('makeProgress'), null);
    if (confirm(`You already made a GIF called "${name}" from this video. Replace it?\n\n(Cancel, then change the file name, to keep both.)`)) makeGif(true);
    return;
  }
  if (r.error) { showStatus($('makeProgress'), 'Error: ' + r.error, 'error'); return; }
  if (sid !== sessionId) return;

  showStatus($('makeProgress'), `✓ Made ${r.name}.gif (${fmtSize(r.gif_size)}) — it’s below, ready to download.`, 'ok');
  renderExports(await backend.exports(sid));
  loadLibrary();  // GIF count badge
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('makeBtn').addEventListener('click', () => makeGif());

let exportList = [];
function renderExports(list) {
  list = Array.isArray(list) ? list : [];
  exportList = list;
  $('results').hidden = !list.length || openN === 1;
  renderMiniSteps();
  if (!list.length) return;
  const [latest, ...older] = list;
  $('latestGif').src = latest.gif_url;
  $('latestName').textContent = latest.name + '.gif';
  $('latestSizes').textContent = `GIF ${fmtSize(latest.gif_size)}` + (latest.mp4_size ? ` · MP4 ${fmtSize(latest.mp4_size)}` : '');
  $('downloadGif').href = latest.gif_url;
  $('downloadGif').setAttribute('download', latest.name + '.gif');
  $('downloadMp4').hidden = !latest.mp4_url;
  if (latest.mp4_url) {
    $('downloadMp4').href = latest.mp4_url;
    $('downloadMp4').setAttribute('download', latest.name + '.mp4');
  }
  // Many messaging apps cap or recompress GIFs above ~8-10 MB.
  const big = latest.gif_size > 8 * 1024 * 1024;
  $('latestWarn').hidden = !big;
  if (big) $('latestWarn').textContent = '⚠ That’s a big GIF — some messaging apps may reject or shrink it. Try a smaller size, less smoothness, or a shorter clip (or send the MP4).';

  $('olderWrap').hidden = !older.length;
  const grid = $('olderGrid');
  grid.innerHTML = '';
  older.forEach(x => {
    const card = el('div', 'older-card');
    const img = el('img');
    img.src = x.gif_url;
    img.alt = x.name;
    img.loading = 'lazy';
    const meta = el('div', 'meta');
    meta.appendChild(el('b', '', x.name));
    const gifA = el('a', '', `GIF ${fmtSize(x.gif_size)}`);
    gifA.href = x.gif_url;
    gifA.setAttribute('download', x.name + '.gif');
    meta.appendChild(gifA);
    if (x.mp4_url) {
      const mp4A = el('a', '', `MP4 ${fmtSize(x.mp4_size)}`);
      mp4A.href = x.mp4_url;
      mp4A.setAttribute('download', x.name + '.mp4');
      meta.appendChild(mp4A);
    }
    const del = el('button', 'link', 'Delete');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete ${x.name}.gif (and its MP4)?`)) return;
      const res = await backend.deleteExport(sessionId, x.name);
      if (res.error) { alert(res.error); return; }
      renderExports(await backend.exports(sessionId));
      loadLibrary();
    });
    meta.appendChild(del);
    card.append(img, meta);
    grid.appendChild(card);
  });
}
$('anotherRangeBtn').addEventListener('click', () => { openStep(2); $('step2').scrollIntoView({ behavior: 'smooth' }); });
$('newVideoBtn').addEventListener('click', () => { openStep(1); $('step1').scrollIntoView({ behavior: 'smooth' }); });

// --- Deleting the open video ---
$('deleteCurrentBtn').addEventListener('click', e => {
  e.stopPropagation();  // it sits in step 1's header, which opens step 1 when clicked
  if (!sessionId) return;
  deleteEntry(libEntries.find(x => x.session === sessionId)
    || { session: sessionId, title: session.title, export_count: exportList.length });
});

// --- Shared-computer mode: save nothing personal ---
function privateWanted() {
  try { return localStorage.getItem(PRIVATE_KEY) === '1'; } catch (e) { return false; }
}
function clearSettings(keepPrivateFlag) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('gifmaker.') && !(keepPrivateFlag && key === PRIVATE_KEY)) localStorage.removeItem(key);
    }
  } catch (e) { /* storage blocked */ }
}
function settingsSaved() {
  try { return Object.keys(localStorage).some(k => k.startsWith('gifmaker.') && k !== PRIVATE_KEY); } catch (e) { return false; }
}
function syncPrivateUI() {
  const browser = backend.mode === 'browser';
  $('privateQuick').checked = $('privateToggle').checked = privateMode;
  $('privateCheckRow').hidden = !browser || privateMode;
  $('privateBanner').hidden = !privateMode;
  $('privateRow').hidden = !browser;
}
function reloadFresh() {
  leaving = true;
  location.replace(location.pathname + location.search);
}
async function setPrivate(on) {
  if (on === privateMode) return;
  if (on) {
    const inv = await backend.storage();
    const n = inv.videos ? inv.videos.count : 0;
    const msg = 'Stop saving anything on this device?\n\n'
      + (n ? `This also deletes the ${n} video${n === 1 ? '' : 's'} already saved in this browser, with their captions and GIFs. Download any GIFs you want to keep first.\n\n` : '')
      + 'From now on, whatever you make is forgotten when you close this tab. (The downloaded video engine and speech model aren’t personal, so they stay unless you remove them.)';
    if (!confirm(msg)) { syncPrivateUI(); return; }
    await backend.clearVideos();
    clearSettings(false);
    try { localStorage.setItem(PRIVATE_KEY, '1'); } catch (e) { /* storage blocked */ }
  } else {
    if (libEntries.length && !confirm('Start saving your videos on this device again?\n\nWhat you made during this visit wasn’t saved and will be cleared now — download any GIFs you want to keep first.')) {
      syncPrivateUI();
      return;
    }
    try { localStorage.removeItem(PRIVATE_KEY); } catch (e) { /* storage blocked */ }
  }
  reloadFresh();
}
['privateQuick', 'privateToggle'].forEach(id => $(id).addEventListener('change', e => setPrivate(e.target.checked)));

// --- What's saved on this device ---
function openStoragePanel() {
  $('storageDetails').open = true;
  $('storagePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('storageDetails').addEventListener('toggle', () => { if ($('storageDetails').open) renderStoragePanel(); });

function storageRow({ title, desc, size, button, onClick, list }) {
  const row = el('div', 'sp-row');
  const text = el('div');
  text.append(el('b', '', title), el('div', 'sp-desc', desc));
  row.append(text, el('span', 'sp-size', size || ''));
  if (button) {
    const b = el('button', 'secondary small', button);
    b.type = 'button';
    b.addEventListener('click', onClick);
    row.appendChild(b);
  } else {
    row.appendChild(el('span'));
  }
  if (list && list.length) {
    const ul = el('ul', 'sp-list');
    list.forEach(([name, value]) => {
      const li = el('li');
      li.append(el('span', '', name), el('span', '', value));
      ul.appendChild(li);
    });
    row.appendChild(ul);
  }
  return row;
}

let storageSeq = 0;
async function renderStoragePanel() {
  if (!backend.storage) return;
  const seq = ++storageSeq;
  const inv = await backend.storage();
  if (seq !== storageSeq || inv.error) return;
  $('storagePanel').hidden = false;
  const browser = backend.mode === 'browser';
  const rows = [];
  let total = inv.engine + inv.models.reduce((n, m) => n + m.bytes, 0) + (inv.modelOther || 0);

  if (inv.videos) {
    const v = inv.videos;
    total += v.bytes;
    rows.push(storageRow({
      title: 'Your videos',
      desc: (v.count
        ? `${v.count} video${v.count === 1 ? '' : 's'}: clips, captions, thumbnails and the GIFs you made. Your original video files are never copied.`
        : 'Nothing yet. Your original video files are never copied — only the clips, captions and GIFs you make.')
        + (inv.memoryOnly ? ' Forgotten when you close this tab.' : ''),
      size: v.count ? fmtSize(v.bytes) : '',
      button: v.count ? 'Delete all videos' : null,
      list: v.items.map(x => [x.title, fmtSize(x.bytes)]),
      onClick: async () => {
        if (!confirm(`Delete all ${v.count} video${v.count === 1 ? '' : 's'} saved here, with their captions and GIFs?\n\nDownload any GIFs you want to keep first. Your original video files aren’t affected.`)) return;
        const r = await backend.clearVideos();
        if (r.error) { alert(r.error); return; }
        if (sessionId) closeSession();
        loadLibrary();
      },
    }));
  } else {
    rows.push(storageRow({
      title: 'Your videos',
      desc: 'Kept in the app’s sessions/ folder on this computer, not in the browser. Delete them one at a time from “Your videos” in step 1.',
    }));
  }

  rows.push(storageRow({
    title: 'Video engine',
    desc: inv.engine
      ? 'Cuts your clips and makes the GIFs. If you remove it, it downloads again (about 31 MB) the next time it’s needed.'
      : browser ? 'Not downloaded yet — it downloads (about 31 MB) the first time you pick a part of a video.'
        : 'Not needed: the app’s server does this.',
    size: inv.engine ? fmtSize(inv.engine) : '',
    button: inv.engine ? 'Remove' : null,
    onClick: async () => {
      if (!confirm(`Remove the video engine (${fmtSize(inv.engine)})?\n\nYou’ll need to download it again (about 31 MB) the next time you cut a clip or make a GIF.`)) return;
      await backend.clearEngine();
      renderStoragePanel();
    },
  }));

  const usesBrowserSpeech = browser || backend.hasWhisper === false;
  if (inv.models.length) {
    inv.models.forEach(m => rows.push(storageRow({
      title: `Speech model: ${m.name[0].toUpperCase() + m.name.slice(1)}${m.retired ? ' (no longer used)' : ''}`,
      desc: m.retired
        ? 'An older model this page used to offer. It isn’t used any more, so it’s safe to remove.'
        : 'Writes the auto-captions. If you remove it, it downloads again the next time you use Auto-caption with it.',
      size: fmtSize(m.bytes),
      button: 'Remove',
      onClick: async () => {
        if (!confirm(`Remove the ${m.name} speech model (${fmtSize(m.bytes)})?\n\nIt will download again (${fmtSize(m.bytes)}) the next time you use Auto-caption with it.`)) return;
        await backend.clearModel(m.name);
        const cm = cfg.models.find(x => x.name === m.name);
        if (cm && usesBrowserSpeech) { cm.downloaded = false; populateModels($('modelSel').value); }
        renderStoragePanel();
      },
    })));
  } else {
    rows.push(storageRow({
      title: 'Speech models',
      desc: usesBrowserSpeech
        ? 'None downloaded yet — one downloads (41–250 MB, depending on which you pick) the first time you use Auto-caption.'
        : 'Not needed: the app’s server does the captions (its models are in ~/.cache/whisper).',
    }));
  }

  const hasSettings = settingsSaved();
  rows.push(storageRow({
    title: 'Your settings',
    desc: privateMode
      ? 'Not saved. The page only remembers that “Don’t save my videos” is on.'
      : hasSettings ? 'Your last caption style, GIF size and language, so new videos start the way you like.'
        : 'Nothing saved yet (your last caption style, GIF size and language will be).',
    button: hasSettings ? 'Reset' : null,
    onClick: () => { clearSettings(true); renderStoragePanel(); },
  }));

  $('storageRows').replaceChildren(...rows);
  $('storageTotal').textContent = total ? `· ${fmtSize(total)}` : '· nothing yet';
  $('storageIntro').textContent = browser
    ? 'This page only keeps things in this browser, on this device — nothing is uploaded. Here’s all of it, and how to remove it.'
    : 'Your videos are kept by the app on this computer. This is what the page itself keeps in this browser.';
  $('clearEverythingBtn').textContent = browser ? 'Clear everything this page has saved' : 'Clear everything saved in this browser';
  $('storageNote2').textContent = 'Your browser may also keep ordinary temporary copies of this page’s code; it clears those by itself.'
    + (browser && !inv.persisted && !inv.memoryOnly ? ' If this device runs low on space, the browser might clear the page’s saved data on its own.' : '');
}

$('clearEverythingBtn').addEventListener('click', async () => {
  const browser = backend.mode === 'browser';
  const msg = browser
    ? 'Clear everything this page has saved on this device?\n\n• all your videos, with their captions and GIFs\n• the video engine and speech models (they’ll download again when needed)\n• your settings\n\nDownload any GIFs you want to keep first. Your original video files aren’t affected.'
    : 'Clear everything saved in this browser?\n\n• the video engine and speech models, if it downloaded any\n• your settings\n\nYour videos in the sessions/ folder aren’t touched.';
  if (!confirm(msg)) return;
  const r = await backend.clearEverything();
  if (r && r.error) { alert(r.error); return; }
  clearSettings(false);
  reloadFresh();
});

// --- Help ---
function openHelp(section) {
  $('helpDialog').showModal();
  const target = section && $('help' + section[0].toUpperCase() + section.slice(1));
  if (target) {
    target.scrollIntoView({ block: 'start' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  } else {
    $('helpDialog').scrollTop = 0;
  }
}
$('helpBtn').addEventListener('click', () => openHelp());
document.querySelectorAll('[data-help]').forEach(b => b.addEventListener('click', () => openHelp(b.dataset.help)));
$('helpDialog').addEventListener('click', e => { if (e.target === $('helpDialog')) $('helpDialog').close(); });

// --- Startup ---
// Served by app.py? Then use it. Otherwise (GitHub Pages, any static host,
// or ?engine=browser) do everything in the browser.
async function pickBackend() {
  if (new URLSearchParams(location.search).get('engine') !== 'browser') {
    try {
      const res = await fetch('api/config', { cache: 'no-store' });
      if (res.ok && (res.headers.get('Content-Type') || '').includes('json')) {
        const c = await res.json();
        if (c.mode === 'server') return [serverBackend, c];
      }
    } catch (e) { /* no server here */ }
  }
  const { browserBackend } = await import('./backend-browser.js');
  if (privateWanted()) {
    browserBackend.usePrivateMode();
    privateMode = true;
  }
  return [browserBackend, await browserBackend.config()];
}

function browserSupportProblem() {
  if (!window.WebAssembly) return 'This browser can’t run WebAssembly, which this app needs to process video.';
  if (!window.indexedDB) return 'This browser has site storage turned off (it may be a private window), so the app can’t save your work.';
  if (!window.Worker) return 'This browser can’t run background workers, which the app needs for captions.';
  return null;
}

(async () => {
  const [b, c] = await pickBackend();
  backend = b;
  if (c.error) {
    $('supportBanner').hidden = false;
    $('supportBanner').textContent = 'Couldn’t start: ' + c.error;
    return;
  }
  cfg = c;
  const browser = backend.mode === 'browser';
  document.body.classList.add('mode-' + backend.mode);
  if (backend.mode === 'server') {
    backend.hasWhisper = c.whisper !== false;
    // Without Whisper on the server, captions are made in the browser instead.
    if (!backend.hasWhisper) {
      const speech = await import('./speech.js');
      const have = await speech.downloadedModels();
      cfg.models = speech.MODELS.map(m => ({ ...m, downloaded: have.has(m.name) }));
      cfg.default_model = speech.DEFAULT_MODEL;
      cfg.languages = speech.LANGUAGES;
      cfg.default_language = 'en';
    }
  }

  $('modeChip').hidden = false;
  $('modeChip').innerHTML = browser
    ? (privateMode ? '🕶 <b>Not saving anything:</b> runs entirely in your browser' : '🔒 <b>Private:</b> runs entirely in your browser')
    : '💻 <b>Running on your computer</b>' + (c.youtube ? ' · YouTube enabled' : '');
  $('modeChip').title = browser
    ? 'Your videos never leave this computer — all the processing happens in this tab.'
    : 'Served by app.py on this computer, using its ffmpeg' + (c.whisper === false ? '' : ' and Whisper') + '.';
  $('footMode').textContent = browser
    ? 'Everything happens in this browser tab — nothing is uploaded.'
    : 'Running on your computer via app.py.';
  $('youtubeRow').hidden = !c.youtube;
  $('orLine').hidden = !c.youtube;
  $('ytNote').hidden = !!c.youtube;
  $('dzNote').textContent = browser
    ? 'MP4, MOV, WebM, MKV and most other formats. Your video stays on this computer.'
    : 'MP4, MOV, WebM, MKV and most other formats.';
  if (!browser) $('keepHint').textContent = 'Tip: you can drag the GIF straight from here into a chat or email. Your GIFs are also saved in the app’s sessions/ folder.';
  if (browser) {
    const problem = browserSupportProblem();
    if (problem) {
      $('supportBanner').hidden = false;
      $('supportBanner').textContent = '⚠ ' + problem + ' Try a recent version of Chrome, Edge or Firefox.';
    }
  }

  syncPrivateUI();
  cfg.fonts.forEach(f => {
    const opt = el('option', '', f.label);
    opt.value = f.family;
    opt.style.fontFamily = `"${f.family}"`;
    $('fontSel').appendChild(opt);
  });
  loadFonts();
  populateModels();
  populateLanguages();
  applyStyle({ ...defaultStyle(), ...recall('style') });
  applyOutput(recall('output'));
  renderSteps();
  await loadLibrary();
  // The video's id lives in the URL, so a refresh reopens what you were working on.
  const sid = location.hash.slice(1);
  const entry = libEntries.find(e => e.session === sid);
  if (entry && entry.status === 'ready') openSession(sid);
  else if (entry && entry.status === 'working' && entry.job && backend.follow) {
    working(() => backend.follow(entry, progressTo(srcProgress))).then(openResult);
  }
})();

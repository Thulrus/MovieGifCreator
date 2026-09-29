// The "local server" engine: talks to app.py, which does the heavy lifting
// with the real ffmpeg, Whisper and yt-dlp installed on this computer (and so
// can also download from YouTube). Answers the same calls as backend-browser.js.

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wraps fetch so a dropped connection (e.g. the server restarting
// mid-request) shows up as a clear error instead of a stuck spinner.
async function safeFetch(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    return { error: 'Lost connection to the app’s server. Is it still running? Try again.' };
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { error: `Server error (${res.status})` };
  }
  if (!res.ok && !data.error) data.error = `Server error (${res.status})`;
  return data;
}

function api(url, { method, json } = {}) {
  const opts = { method: method || (json !== undefined ? 'POST' : 'GET') };
  if (json !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(json);
  }
  return safeFetch(url, opts);
}

// Slow work runs as a server-side job; poll it until it finishes. Brief
// connection blips are retried rather than treated as failure.
async function waitJob(id, onProgress) {
  let misses = 0;
  for (;;) {
    let res, job;
    try {
      res = await fetch(`api/jobs/${id}`);
      job = await res.json();
    } catch (err) {
      if (++misses > 30) return { error: 'Lost connection to the app’s server. Is it still running?' };
      await sleep(1000);
      continue;
    }
    misses = 0;
    if (!res.ok) return { error: job.error || `Server error (${res.status})` };
    if (onProgress) onProgress(job);
    if (job.status === 'done') return job.result || {};
    if (job.status === 'error') return { error: job.error };
    await sleep(400);
  }
}

// Start a job and follow it. Returns the job's result, or the start response
// itself if it didn't start a job (an error, or "you already have this").
async function runJob(url, body, onProgress) {
  onProgress({ message: 'Starting…', progress: null });
  const start = await api(url, { json: body });
  if (start.error || !start.job) return start;
  const result = await waitJob(start.job, onProgress);
  if (!result.error && start.session && !result.session) result.session = start.session;
  return result;
}

export const serverBackend = {
  mode: 'server',

  config: () => api('api/config'),
  library: () => api('api/library'),
  usage: async () => null,
  open: sid => api(`api/sessions/${sid}`),
  saveState: (sid, state) => api(`api/sessions/${sid}/state`, { method: 'PUT', json: state }),
  // Survives the page closing, so the last edits aren't lost.
  flushState: (sid, state) => navigator.sendBeacon(`api/sessions/${sid}/state`,
    new Blob([JSON.stringify(state)], { type: 'application/json' })),
  rename: (sid, title) => api(`api/sessions/${sid}`, { method: 'PATCH', json: { title } }),
  remove: sid => api(`api/sessions/${sid}`, { method: 'DELETE' }),

  addFile(file, onProgress) {
    return new Promise(resolve => {
      onProgress({ message: `Uploading ${file.name}…`, progress: 0 });
      const form = new FormData();
      form.append('video', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'api/upload');
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
          onProgress({ message: `Uploading ${file.name}… ${Math.round(100 * e.loaded / e.total)}%`, progress: e.loaded / e.total });
        }
      };
      xhr.onload = async () => {
        let data;
        try { data = JSON.parse(xhr.responseText); } catch (err) { data = { error: `Server error (${xhr.status})` }; }
        if (data.error || !data.job) { resolve(data); return; }
        const r = await waitJob(data.job, onProgress);
        resolve(r.error ? r : { session: data.session, ...r });
      };
      xhr.onerror = () => resolve({ error: 'Lost connection to the app’s server while uploading.' });
      xhr.send(form);
    });
  },

  fetchYoutube: (url, onProgress) => runJob('api/fetch-youtube', { url }, onProgress),
  resume: (entry, url, onProgress) => runJob(`api/sessions/${entry.session}/resume`, url ? { url } : {}, onProgress),
  follow: (entry, onProgress) => waitJob(entry.job.id, onProgress).then(r => r.error ? r : { session: entry.session, ...r }),

  cut: (sid, start, end, onProgress) => runJob('api/cut', { session: sid, start, end }, onProgress),
  // Whisper is an optional (big) install for the server. Without it, the
  // clip is captioned right here in the browser instead.
  hasWhisper: true,
  async transcribe(sid, opts, onProgress) {
    if (this.hasWhisper) return runJob('api/transcribe', { session: sid, ...opts }, onProgress);
    try {
      const [media, speech] = await Promise.all([import('./media.js'), import('./speech.js')]);
      const info = await api(`api/sessions/${sid}`);
      if (info.error) return info;
      if (!info.clip_url) return { error: 'Cut a clip first' };
      const clip = await (await fetch(info.clip_url)).blob();
      const samples = await media.extractAudio(clip, onProgress).catch(() => new Float32Array(0));
      return await speech.transcribe(samples, {
        model: opts.model, language: opts.language, maxChars: Number(opts.max_chars) || 40, clipLen: info.clip.end - info.clip.start,
      }, onProgress);
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  },
  exportGif: (sid, data, onProgress) => runJob('api/export', { session: sid, ...data }, onProgress),
  exports: async sid => (await api(`api/sessions/${sid}`)).exports || [],
  deleteExport: (sid, name) => api(`api/sessions/${sid}/exports/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

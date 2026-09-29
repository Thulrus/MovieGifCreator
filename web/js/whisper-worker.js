// Speech-to-text in a background thread with transformers.js (Whisper
// running on ONNX Runtime Web). Models download from Hugging Face the first
// time they're used and are cached by the browser after that.

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

env.allowLocalModels = false;

const pipelines = new Map();

async function getPipeline(model, report) {
  if (!pipelines.has(model)) {
    const files = new Map();
    const p = pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (e) => {
        if (e.status === 'progress' && e.total) {
          files.set(e.file, { loaded: e.loaded, total: e.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          report({ phase: 'download', progress: total ? loaded / total : null, loaded, total });
        }
      },
    });
    pipelines.set(model, p);
    p.catch(() => pipelines.delete(model));
  }
  return pipelines.get(model);
}

self.onmessage = async ({ data }) => {
  const { id, model, language, audio } = data;
  const report = (info) => self.postMessage({ id, type: 'progress', ...info });
  try {
    report({ phase: 'load', progress: null });
    const asr = await getPipeline(model, report);
    report({ phase: 'listen', progress: null });
    const out = await asr(audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      language: language || 'en',
    });
    const chunks = (out.chunks || []).map(c => ({
      text: c.text,
      start: c.timestamp[0],
      end: c.timestamp[1],
    }));
    self.postMessage({ id, type: 'result', text: out.text || '', chunks });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};

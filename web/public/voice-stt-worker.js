/**
 * On-device speech-to-text worker (voice mode) — Whisper via transformers.js,
 * loaded lazily from CDN (same pattern as lib/webllm.ts: nothing in the app
 * bundle; model weights cache in the browser). Lives in public/ so it loads
 * as a plain module worker with no bundler involvement.
 *
 * Protocol (from lib/voice/live.ts):
 *   → { type: 'init' }
 *   ← { type: 'progress', label, pct? }         (model download/compile)
 *   ← { type: 'ready', device }
 *   → { type: 'transcribe', id, audio: Float32Array, sampleRate }
 *   ← { type: 'result', id, text }
 *   ← { type: 'error', id?, message }
 */

const TRANSFORMERS_CDN = "https://esm.run/@huggingface/transformers@3.8.1";
// Multilingual base: solid accuracy in ~80MB (q8). Weights cache after the
// first load. whisper-tiny would halve that at a real accuracy cost.
const MODEL = "onnx-community/whisper-base";

let pipePromise = null;

async function getPipeline() {
  if (pipePromise) return pipePromise;
  pipePromise = (async () => {
    const { pipeline } = await import(TRANSFORMERS_CDN);
    let device = "wasm";
    try {
      if (self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())) device = "webgpu";
    } catch {}
    const seen = new Map();
    const pipe = await pipeline("automatic-speech-recognition", MODEL, {
      device,
      // WebGPU: fp32 encoder + q4 decoder is the known-good whisper combo
      // (fp16 artifacts); wasm takes the small q8 files.
      dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
      progress_callback: (p) => {
        if (p.status !== "progress" || !p.total) return;
        seen.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const v of seen.values()) { loaded += v.loaded; total += v.total; }
        self.postMessage({ type: "progress", label: "Downloading speech model…", pct: Math.round((loaded / total) * 100) });
      },
    });
    return { pipe, device };
  })().catch((e) => {
    pipePromise = null; // failed CDN/model load must not poison the singleton
    throw e;
  });
  return pipePromise;
}

/** Whisper wants 16kHz; resample linearly if the context ran at another rate */
function to16k(audio, sampleRate) {
  if (sampleRate === 16000) return audio;
  const ratio = sampleRate / 16000;
  const out = new Float32Array(Math.floor(audio.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, audio.length - 1);
    out[i] = audio[lo] + (audio[hi] - audio[lo]) * (pos - lo);
  }
  return out;
}

/** Whisper hallucinates annotations on near-silence — drop the obvious ones */
function cleanTranscript(text) {
  const t = (text || "").trim();
  if (!t) return "";
  if (/^[\[\(‹<*♪].*[\]\)›>*♪]$/.test(t)) return ""; // [BLANK_AUDIO], (applause), ♪♪
  return t;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === "init") {
    try {
      const { device } = await getPipeline();
      self.postMessage({ type: "ready", device });
    } catch (err) {
      self.postMessage({ type: "error", message: `Speech model failed to load: ${err?.message || err}` });
    }
    return;
  }
  if (msg.type === "transcribe") {
    try {
      const { pipe } = await getPipeline();
      const audio = to16k(msg.audio, msg.sampleRate || 16000);
      const out = await pipe(audio); // language auto-detected (multilingual model)
      self.postMessage({ type: "result", id: msg.id, text: cleanTranscript(out?.text) });
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: `Transcription failed: ${err?.message || err}` });
    }
  }
};

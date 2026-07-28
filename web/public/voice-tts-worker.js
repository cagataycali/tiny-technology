/**
 * On-device text-to-speech worker — Kokoro-82M via kokoro-js, loaded lazily
 * from CDN (webllm pattern: zero bundle weight, weights cache in the
 * browser). Speaks the agent's `speak` tool calls and read-aloud requests.
 *
 * Protocol (from lib/voice/tts.ts):
 *   → { type: 'init' }
 *   ← { type: 'progress', label, pct? }
 *   ← { type: 'ready', device, voices: string[] }
 *   → { type: 'speak', id, text, voice? }
 *   ← { type: 'audio', id, audio: Float32Array, sampleRate }
 *   ← { type: 'error', id?, message }
 */

const KOKORO_CDN = "https://esm.run/kokoro-js@1.2.1";
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = "af_heart";

let ttsPromise = null;

async function getTts() {
  if (ttsPromise) return ttsPromise;
  ttsPromise = (async () => {
    const { KokoroTTS } = await import(KOKORO_CDN);
    let device = "wasm";
    try {
      if (self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())) device = "webgpu";
    } catch {}
    const seen = new Map();
    const tts = await KokoroTTS.from_pretrained(MODEL, {
      dtype: device === "webgpu" ? "fp32" : "q8",
      device,
      progress_callback: (p) => {
        if (p.status !== "progress" || !p.total) return;
        seen.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const v of seen.values()) { loaded += v.loaded; total += v.total; }
        self.postMessage({ type: "progress", label: "Downloading voice model…", pct: Math.round((loaded / total) * 100) });
      },
    });
    return { tts, device };
  })().catch((e) => {
    ttsPromise = null; // failed CDN/model load must not poison the singleton
    throw e;
  });
  return ttsPromise;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === "init") {
    try {
      const { tts, device } = await getTts();
      const voices = Object.keys(tts.voices || {});
      self.postMessage({ type: "ready", device, voices });
    } catch (err) {
      self.postMessage({ type: "error", message: `Voice model failed to load: ${err?.message || err}` });
    }
    return;
  }
  if (msg.type === "speak") {
    try {
      const { tts } = await getTts();
      const voice = msg.voice && tts.voices && tts.voices[msg.voice] !== undefined ? msg.voice : DEFAULT_VOICE;
      const out = await tts.generate(msg.text, { voice });
      const audio = out.audio; // Float32Array
      self.postMessage(
        { type: "audio", id: msg.id, audio, sampleRate: out.sampling_rate || 24000 },
        [audio.buffer]
      );
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: `Speech synthesis failed: ${err?.message || err}` });
    }
  }
};

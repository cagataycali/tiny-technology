"use client";

/**
 * On-device neural TTS (Kokoro-82M) with speechSynthesis fallback — the
 * playback half of voice mode and the engine behind the agent's `speak`
 * tool. The worker (public/voice-tts-worker.js) loads kokoro-js from CDN
 * lazily, so nothing lands in the app bundle (webllm pattern).
 *
 * One utterance plays at a time. Playback state lives in a tiny external
 * store (subscribe/getState) so SpeechCard and the read-aloud buttons render
 * the same truth without prop-drilling through Chat.
 *
 * Long texts are split into sentence chunks: the first chunk reaches the
 * speaker while the rest still synthesize.
 */

import { speak as synthSpeak, stopSpeaking as synthStop, speechSupported } from "@/components/chat/voice";
import { isIOS } from "./platform";

export type SpeechStatus = "loading" | "playing";
export type SpeechState = { id: string | null; status: SpeechStatus | null };

let state: SpeechState = { id: null, status: null };
const listeners = new Set<() => void>();

function setState(next: SpeechState): void {
  state = next;
  listeners.forEach((fn) => fn());
}

export function getSpeechState(): SpeechState {
  return state;
}

export function subscribeSpeech(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Worker plumbing ────────────────────────────────────────────────────────

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
// iOS can never run the neural model — loading Kokoro OOM-kills the WebKit tab
// (see ./platform). Pre-set the "failed" latch so every path falls straight
// through to speechSynthesis (built into iOS Safari, zero download).
let neuralFailed = isIOS();
const audioHandlers = new Map<number, (audio: Float32Array | null, sampleRate: number, err?: string) => void>();
let nextId = 1;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker("/voice-tts-worker.js", { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data || {};
    if (msg.type === "audio") {
      audioHandlers.get(msg.id)?.(msg.audio, msg.sampleRate);
      audioHandlers.delete(msg.id);
    } else if (msg.type === "error" && msg.id) {
      audioHandlers.get(msg.id)?.(null, 0, msg.message);
      audioHandlers.delete(msg.id);
    }
  };
  return worker;
}

function initNeural(): Promise<void> {
  if (ready) return ready;
  const w = getWorker();
  ready = new Promise<void>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const msg = e.data || {};
      if (msg.type === "ready") {
        w.removeEventListener("message", onMsg);
        resolve();
      } else if (msg.type === "error" && !msg.id) {
        w.removeEventListener("message", onMsg);
        reject(new Error(msg.message));
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ type: "init" });
  }).catch((e) => {
    ready = null;
    neuralFailed = true; // remembered: read-aloud stops retrying the download
    worker?.terminate();
    worker = null;
    throw e;
  });
  return ready;
}

/** True once the neural model is loaded (or loading) and hasn't failed */
export function neuralStarted(): boolean {
  return ready !== null && !neuralFailed;
}

function synthesize(text: string, voice?: string): Promise<{ audio: Float32Array; sampleRate: number } | null> {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve) => {
    audioHandlers.set(id, (audio, sampleRate, err) => {
      if (err) console.warn("voice: synthesis failed:", err);
      resolve(audio ? { audio, sampleRate } : null);
    });
    w.postMessage({ type: "speak", id, text, voice });
  });
}

// ── Playback ───────────────────────────────────────────────────────────────

let playCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let playToken = 0;

/** Kokoro reads text, not markup — same scrub as voice.ts speak() */
function scrub(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentence chunks ≤ maxLen so the first audio arrives fast (no lookbehind —
 *  older Safari). Exported for tests. */
export function chunkSentences(text: string, maxLen = 300): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || (text ? [text] : []);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  for (let p of parts) {
    while (p.length > maxLen) {
      // A single monster sentence still gets hard-split
      flush();
      chunks.push(p.slice(0, maxLen).trim());
      p = p.slice(maxLen);
    }
    if (cur.length + p.length > maxLen) flush();
    cur += p;
  }
  flush();
  return chunks;
}

function playBuffer(audio: Float32Array, sampleRate: number, token: number): Promise<void> {
  return new Promise((resolve) => {
    if (token !== playToken) return resolve();
    if (!playCtx) playCtx = new AudioContext();
    void playCtx.resume().catch(() => {});
    const buf = playCtx.createBuffer(1, audio.length, sampleRate);
    buf.copyToChannel(audio as any, 0);
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playCtx.destination);
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      resolve();
    };
    currentSource = src;
    src.start();
  });
}

/** Stop whatever is speaking (neural or speechSynthesis) */
export function stopSpeech(): void {
  playToken++;
  try { currentSource?.stop(); } catch {}
  currentSource = null;
  synthStop();
  if (state.id) setState({ id: null, status: null });
}

/**
 * Speak text aloud, tracked under `id` (a message/tool-call id — cards and
 * buttons with that id show the playing state). Replaces whatever was
 * playing.
 *
 * mode 'neural' downloads the voice model on first use (agent speak tool,
 * voice mode); 'auto' uses neural only if it's already warm, otherwise the
 * instant speechSynthesis voice (read-aloud button shouldn't cost ~90MB).
 */
export async function playSpeech(
  id: string,
  text: string,
  opts: { voice?: string; mode?: "neural" | "auto" } = {}
): Promise<void> {
  stopSpeech();
  const token = ++playToken;
  const clean = scrub(text).slice(0, 3000);
  if (!clean) return;

  const wantNeural = !neuralFailed && (opts.mode === "neural" || neuralStarted());
  if (wantNeural) {
    setState({ id, status: "loading" });
    try {
      await initNeural();
      if (token !== playToken) return;
      const chunks = chunkSentences(clean);
      // Pipeline: synthesize chunk n+1 while n plays
      let next = synthesize(chunks[0], opts.voice);
      for (let i = 0; i < chunks.length; i++) {
        const out = await next;
        if (token !== playToken) return;
        if (i + 1 < chunks.length) next = synthesize(chunks[i + 1], opts.voice);
        if (!out) throw new Error("synthesis returned nothing");
        if (state.id !== id || state.status !== "playing") setState({ id, status: "playing" });
        await playBuffer(out.audio, out.sampleRate, token);
        if (token !== playToken) return;
      }
      setState({ id: null, status: null });
      return;
    } catch (e) {
      console.warn("voice: neural TTS unavailable, falling back:", e);
      if (token !== playToken) return;
      // fall through to speechSynthesis
    }
  }

  if (!speechSupported()) {
    setState({ id: null, status: null });
    return;
  }
  setState({ id, status: "playing" });
  const ok = synthSpeak(clean, () => {
    if (token === playToken) setState({ id: null, status: null });
  });
  if (!ok) setState({ id: null, status: null });
}

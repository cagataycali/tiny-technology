"use client";

/**
 * Live voice mode — always-open mic, on-device transcription (voice.ts stays
 * the old tap-to-dictate/speechSynthesis module; this is the "wishlist item"
 * it deferred). The mic keeps listening while the agent streams; each pause
 * ≥3s turns the accumulated transcript into a message (Chat sends it —
 * concurrent turns are already supported).
 *
 * Pipeline: getUserMedia → AudioContext(16k) → capture worklet →
 * VadSegmenter (lib/voice/vad.ts, pure) → Whisper worker
 * (public/voice-stt-worker.js, CDN transformers.js) → utterance callbacks.
 *
 * The worker is a module-level singleton: toggling voice mode off/on doesn't
 * reload the model — weights stay warm in worker memory (and cached on disk).
 */

import { VadSegmenter, type VadEvent } from "./vad";
import { isIOS } from "./platform";

export type LiveVoiceCallbacks = {
  /** Model download/compile progress — pct is 0-100 or undefined (indeterminate) */
  onProgress?: (label: string, pct?: number) => void;
  /** 'listening' idle · 'speech' user talking · 'transcribing' whisper busy */
  onStatus?: (status: "listening" | "speech" | "transcribing") => void;
  /** User started talking — barge-in hook (stop TTS so it doesn't self-listen) */
  onSpeechStart?: () => void;
  /** Accumulated transcript of the utterance in progress (updates per segment) */
  onPartial?: (text: string) => void;
  /** 3s of silence — the finished utterance, ready to send to the agent */
  onUtterance: (text: string) => void;
  /** Mic level 0..~0.3, throttled to ~10Hz — drive a meter */
  onLevel?: (rms: number) => void;
  onError?: (message: string) => void;
};

export type LiveVoiceHandle = { stop: () => void };

export function liveVoiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof Worker !== "undefined" &&
    !isIOS() // on-device Whisper OOM-kills the iOS Safari tab — see ./platform
  );
}

// ── Shared STT worker ──────────────────────────────────────────────────────

let sttWorker: Worker | null = null;
let sttReady: Promise<void> | null = null;
const resultHandlers = new Map<number, (text: string | null, err?: string) => void>();
let progressListener: ((label: string, pct?: number) => void) | null = null;
let nextId = 1;

function getSttWorker(): Worker {
  if (sttWorker) return sttWorker;
  sttWorker = new Worker("/voice-stt-worker.js", { type: "module" });
  sttWorker.onmessage = (e: MessageEvent) => {
    const msg = e.data || {};
    if (msg.type === "progress") progressListener?.(msg.label, msg.pct);
    else if (msg.type === "result") {
      resultHandlers.get(msg.id)?.(msg.text);
      resultHandlers.delete(msg.id);
    } else if (msg.type === "error" && msg.id) {
      resultHandlers.get(msg.id)?.(null, msg.message);
      resultHandlers.delete(msg.id);
    }
  };
  return sttWorker;
}

function initStt(onProgress?: (label: string, pct?: number) => void): Promise<void> {
  const w = getSttWorker();
  progressListener = onProgress || null;
  if (sttReady) return sttReady;
  sttReady = new Promise<void>((resolve, reject) => {
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
    // Failed load must not poison the singleton — a retry re-inits
    sttReady = null;
    sttWorker?.terminate();
    sttWorker = null;
    throw e;
  });
  return sttReady;
}

function transcribe(audio: Float32Array, sampleRate: number): Promise<string | null> {
  const w = getSttWorker();
  const id = nextId++;
  return new Promise((resolve) => {
    resultHandlers.set(id, (text, err) => {
      if (err) console.warn("voice: transcription failed:", err);
      resolve(text);
    });
    w.postMessage({ type: "transcribe", id, audio, sampleRate }, [audio.buffer]);
  });
}

// ── Live session ───────────────────────────────────────────────────────────

export async function startLiveVoice(cb: LiveVoiceCallbacks): Promise<LiveVoiceHandle> {
  if (!liveVoiceSupported()) throw new Error("Voice mode needs a browser with microphone access");

  // Model first: surface download progress before asking for the mic, so a
  // slow first load doesn't look like a hung permission prompt.
  await initStt(cb.onProgress);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true, // keeps agent TTS out of the transcript
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e: any) {
    throw new Error(
      e?.name === "NotAllowedError" ? "Microphone permission denied" : `Microphone unavailable: ${e?.message || e}`
    );
  }

  // 16kHz context = whisper's native rate; browsers that ignore the hint
  // still work — the worker resamples from the real rate.
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  const source = ctx.createMediaStreamSource(stream);
  const vad = new VadSegmenter({ sampleRate: ctx.sampleRate });

  let stopped = false;
  let inSpeech = false;
  let busy = false; // one transcription at a time — keeps segments ordered
  const segQueue: Float32Array[] = [];
  let utterance = "";
  let endPending = false;
  let lastLevelAt = 0;

  const status = () => {
    if (stopped) return;
    cb.onStatus?.(busy || segQueue.length ? "transcribing" : inSpeech ? "speech" : "listening");
  };

  const maybeFinish = () => {
    if (!endPending || busy || segQueue.length) return;
    endPending = false;
    const text = utterance.trim();
    utterance = "";
    cb.onPartial?.("");
    if (text) cb.onUtterance(text);
  };

  const pump = () => {
    if (stopped || busy) return;
    const seg = segQueue.shift();
    if (!seg) { maybeFinish(); return; }
    busy = true;
    status();
    transcribe(seg, ctx.sampleRate).then((text) => {
      busy = false;
      if (stopped) return;
      if (text) {
        utterance = utterance ? `${utterance} ${text}` : text;
        cb.onPartial?.(utterance);
      }
      status();
      pump();
    });
  };

  const onFrame = (frame: Float32Array) => {
    if (stopped) return;
    const events: VadEvent[] = vad.push(frame);
    const now = performance.now();
    if (cb.onLevel && now - lastLevelAt > 100) {
      lastLevelAt = now;
      cb.onLevel(vad.lastRms);
    }
    for (const ev of events) {
      if (ev.type === "speech-start") {
        inSpeech = true;
        endPending = false; // new speech cancels a pending send
        cb.onSpeechStart?.();
        status();
      } else if (ev.type === "segment") {
        inSpeech = false;
        segQueue.push(ev.audio);
        pump();
        status();
      } else if (ev.type === "utterance-end") {
        inSpeech = false;
        endPending = true;
        maybeFinish(); // if transcriptions still run, the pump finishes it
        status();
      }
    }
  };

  // Capture: AudioWorklet where available, ScriptProcessor as the fallback
  let worklet: AudioWorkletNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  if (ctx.audioWorklet) {
    await ctx.audioWorklet.addModule("/voice-capture-worklet.js");
    worklet = new AudioWorkletNode(ctx, "voice-capture");
    worklet.port.onmessage = (e) => onFrame(e.data as Float32Array);
    source.connect(worklet);
  } else {
    processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(processor);
    processor.connect(ctx.destination); // ScriptProcessor needs a sink to fire
  }

  status();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      segQueue.length = 0;
      try { worklet?.port.close(); worklet?.disconnect(); } catch {}
      try { processor?.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
      // The worker stays alive on purpose — the model is warm for next time.
    },
  };
}

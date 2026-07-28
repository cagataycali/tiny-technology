/**
 * Energy-based voice-activity segmenter (voice mode) — pure and unit-tested,
 * no browser APIs. lib/voice/live.ts feeds it mic PCM frames; it answers with
 * events:
 *
 *   speech-start   — the user began talking (barge-in hook: stop TTS)
 *   segment        — a chunk of speech ended (~short pause) → transcribe it
 *   utterance-end  — silence held long enough (default 3s) → send the
 *                    accumulated transcript to the agent
 *
 * The threshold adapts: an EMA of non-speech RMS tracks the noise floor, and
 * a frame counts as speech above max(minFloor, floor × floorMult). Segments
 * carry a pre-roll so the first syllable isn't clipped, and too-short blips
 * (door click, cough) are discarded rather than transcribed.
 */

export type VadConfig = {
  /** PCM sample rate of pushed frames (Hz) */
  sampleRate: number;
  /** Absolute RMS below which nothing ever counts as speech */
  minFloor: number;
  /** Speech threshold = noise floor × this multiplier */
  floorMult: number;
  /** Pause that closes a sub-segment and sends it to the transcriber (ms) */
  segmentSilenceMs: number;
  /** Silence that ends the whole utterance → transcript goes to the agent (ms) */
  utteranceSilenceMs: number;
  /** Force-close a segment mid-speech so long monologues transcribe incrementally (ms) */
  maxSegmentMs: number;
  /** Audio kept from before the detected start, so onsets aren't clipped (ms) */
  preRollMs: number;
  /** Segments with less speech than this are noise, not words — dropped (ms) */
  minSpeechMs: number;
};

export const DEFAULT_VAD_CONFIG: VadConfig = {
  sampleRate: 16000,
  minFloor: 0.01,
  floorMult: 2.5,
  segmentSilenceMs: 700,
  utteranceSilenceMs: 3000,
  maxSegmentMs: 12000,
  preRollMs: 250,
  minSpeechMs: 250,
};

export type VadEvent =
  | { type: "speech-start" }
  | { type: "segment"; audio: Float32Array }
  | { type: "utterance-end" };

export function frameRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
}

export class VadSegmenter {
  private cfg: VadConfig;
  private noiseFloor: number;
  /** Rolling pre-roll frames (audio before speech is detected) */
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  /** Current segment buffer while in speech */
  private segment: Float32Array[] = [];
  private segmentSamples = 0;
  private speechMsInSegment = 0;
  private inSpeech = false;
  private silenceMs = 0;
  private spokeSinceUtterance = false;
  /** Last frame's RMS — exposed for a UI level meter */
  lastRms = 0;

  constructor(cfg: Partial<VadConfig> = {}) {
    this.cfg = { ...DEFAULT_VAD_CONFIG, ...cfg };
    this.noiseFloor = this.cfg.minFloor;
  }

  private msOf(samples: number): number {
    return (samples / this.cfg.sampleRate) * 1000;
  }

  private closeSegment(events: VadEvent[]): void {
    if (this.speechMsInSegment >= this.cfg.minSpeechMs) {
      const audio = new Float32Array(this.segmentSamples);
      let off = 0;
      for (const f of this.segment) {
        audio.set(f, off);
        off += f.length;
      }
      events.push({ type: "segment", audio });
      this.spokeSinceUtterance = true;
    }
    this.segment = [];
    this.segmentSamples = 0;
    this.speechMsInSegment = 0;
    this.inSpeech = false;
  }

  /** Feed one PCM frame; returns any events it triggered (usually none). */
  push(frame: Float32Array): VadEvent[] {
    const events: VadEvent[] = [];
    const rms = frameRms(frame);
    this.lastRms = rms;
    const frameMs = this.msOf(frame.length);
    const threshold = Math.max(this.cfg.minFloor, this.noiseFloor * this.cfg.floorMult);
    const isSpeech = rms > threshold;

    if (!isSpeech) {
      // Adapt the floor on non-speech frames; drop fast, rise slowly so
      // one loud utterance can't ratchet the threshold above quiet speech.
      this.noiseFloor =
        rms < this.noiseFloor
          ? this.noiseFloor * 0.7 + rms * 0.3
          : this.noiseFloor * 0.98 + rms * 0.02;
    } else {
      // Creep upward even through "speech": a constant fan/hum above minFloor
      // would otherwise count as speech forever. Real speech varies and pauses
      // (floor recovers); steady noise slowly stops registering (~30s).
      this.noiseFloor = this.noiseFloor * 0.999 + rms * 0.001;
    }

    if (this.inSpeech) {
      this.segment.push(frame);
      this.segmentSamples += frame.length;
      if (isSpeech) {
        this.silenceMs = 0;
        this.speechMsInSegment += frameMs;
      } else {
        this.silenceMs += frameMs;
      }
      if (this.silenceMs >= this.cfg.segmentSilenceMs) {
        this.closeSegment(events);
      } else if (this.msOf(this.segmentSamples) >= this.cfg.maxSegmentMs) {
        // Long monologue: emit what we have and stay in speech
        this.closeSegment(events);
        this.inSpeech = true;
        this.silenceMs = 0;
      }
      return events;
    }

    // Idle: keep the pre-roll ring, watch for speech onset
    if (isSpeech) {
      events.push({ type: "speech-start" });
      this.inSpeech = true;
      this.silenceMs = 0;
      this.segment = [...this.preRoll, frame];
      this.segmentSamples = this.preRollSamples + frame.length;
      this.speechMsInSegment = frameMs;
      this.preRoll = [];
      this.preRollSamples = 0;
      return events;
    }

    this.preRoll.push(frame);
    this.preRollSamples += frame.length;
    while (this.msOf(this.preRollSamples) > this.cfg.preRollMs && this.preRoll.length > 1) {
      this.preRollSamples -= this.preRoll.shift()!.length;
    }

    this.silenceMs += frameMs;
    if (this.spokeSinceUtterance && this.silenceMs >= this.cfg.utteranceSilenceMs) {
      events.push({ type: "utterance-end" });
      this.spokeSinceUtterance = false;
    }
    return events;
  }
}

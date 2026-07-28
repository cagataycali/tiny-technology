/**
 * Mic capture worklet (voice mode) — runs on the audio rendering thread and
 * posts mono Float32 PCM to the main thread in ~32ms batches (512 samples at
 * 16kHz). Batching matters: raw 128-sample quanta would be ~125 postMessages
 * a second. Loaded by lib/voice/live.ts via audioWorklet.addModule().
 */
const BATCH = 512;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BATCH);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true; // keep alive through source hiccups
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, BATCH - this.len);
      this.buf.set(ch.subarray(i, i + n), this.len);
      this.len += n;
      i += n;
      if (this.len === BATCH) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(BATCH);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor("voice-capture", VoiceCaptureProcessor);

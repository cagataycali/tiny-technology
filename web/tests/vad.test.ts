// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { VadSegmenter, frameRms, DEFAULT_VAD_CONFIG, type VadEvent } from '../lib/voice/vad'

const RATE = 16000
const FRAME = 512 // 32ms at 16kHz
const FRAME_MS = (FRAME / RATE) * 1000

/** Sine "speech" frame at a given amplitude */
function speech(amp = 0.1): Float32Array {
  const f = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) f[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return f
}

/** Near-silent frame (tiny deterministic noise) */
function silence(amp = 0.001): Float32Array {
  const f = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) f[i] = amp * ((i % 7) / 7 - 0.5)
  return f
}

function pushMs(vad: VadSegmenter, ms: number, make: () => Float32Array): VadEvent[] {
  const out: VadEvent[] = []
  for (let t = 0; t < ms; t += FRAME_MS) out.push(...vad.push(make()))
  return out
}

describe('frameRms', () => {
  it('is ~amp/√2 for a sine and near zero for silence', () => {
    expect(frameRms(speech(0.1))).toBeGreaterThan(0.05)
    expect(frameRms(silence())).toBeLessThan(0.001)
  })
})

describe('VadSegmenter — speech segmentation', () => {
  it('emits speech-start, then a segment after a short pause, then utterance-end after 3s', () => {
    const vad = new VadSegmenter()
    const events: VadEvent[] = []
    events.push(...pushMs(vad, 500, silence)) // settle the noise floor
    events.push(...pushMs(vad, 1000, () => speech()))
    events.push(...pushMs(vad, DEFAULT_VAD_CONFIG.utteranceSilenceMs + 200, silence))

    const types = events.map((e) => e.type)
    expect(types).toContain('speech-start')
    expect(types).toContain('segment')
    expect(types).toContain('utterance-end')
    // Ordering: start before segment before utterance-end
    expect(types.indexOf('speech-start')).toBeLessThan(types.indexOf('segment'))
    expect(types.indexOf('segment')).toBeLessThan(types.indexOf('utterance-end'))
  })

  it('segment audio includes the pre-roll and the spoken samples', () => {
    const vad = new VadSegmenter()
    pushMs(vad, 500, silence)
    const events = [
      ...pushMs(vad, 1000, () => speech()),
      ...pushMs(vad, 800, silence), // > segmentSilenceMs closes the segment
    ]
    const seg = events.find((e) => e.type === 'segment') as { audio: Float32Array }
    expect(seg).toBeTruthy()
    // ~1000ms speech + ~250ms pre-roll + ~700ms of closing silence, in samples
    expect(seg.audio.length).toBeGreaterThan((1000 / 1000) * RATE)
    expect(seg.audio.length).toBeLessThan((2200 / 1000) * RATE)
  })

  it('no utterance-end without speech (silence alone never sends)', () => {
    const vad = new VadSegmenter()
    const events = pushMs(vad, 10000, silence)
    expect(events).toEqual([])
  })

  it('discards blips shorter than minSpeechMs (a click is not a word)', () => {
    const vad = new VadSegmenter()
    pushMs(vad, 500, silence)
    const events = [
      ...pushMs(vad, 100, () => speech()), // 100ms blip < 250ms minimum
      ...pushMs(vad, 5000, silence),
    ]
    expect(events.map((e) => e.type)).toEqual(['speech-start']) // no segment, no utterance-end
  })

  it('splits a long monologue at maxSegmentMs without ending the utterance', () => {
    const vad = new VadSegmenter()
    pushMs(vad, 500, silence)
    // Real speech isn't a constant tone — bursts with 200ms micro-pauses
    // (shorter than segmentSilenceMs, so the segment keeps running; the
    // pauses also keep the adaptive floor from swallowing the voice).
    const events: VadEvent[] = []
    for (let t = 0; t < 26000; t += 2200) {
      events.push(...pushMs(vad, 2000, () => speech()))
      events.push(...pushMs(vad, 200, silence))
    }
    const segments = events.filter((e) => e.type === 'segment')
    expect(segments.length).toBeGreaterThanOrEqual(2) // 26s speech / 12s cap
    expect(events.some((e) => e.type === 'utterance-end')).toBe(false)
  })

  it('two utterances produce two utterance-ends', () => {
    const vad = new VadSegmenter()
    pushMs(vad, 500, silence)
    const one = [
      ...pushMs(vad, 800, () => speech()),
      ...pushMs(vad, 3500, silence),
    ]
    const two = [
      ...pushMs(vad, 800, () => speech()),
      ...pushMs(vad, 3500, silence),
    ]
    expect(one.filter((e) => e.type === 'utterance-end')).toHaveLength(1)
    expect(two.filter((e) => e.type === 'utterance-end')).toHaveLength(1)
  })

  it('adapts to a louder noise floor instead of transcribing hum forever', () => {
    const vad = new VadSegmenter()
    // Constant 0.02 hum: above the default minFloor, but after adaptation the
    // floor rises so the hum stops counting as speech → no endless segments.
    const events = pushMs(vad, 20000, () => speech(0.028))
    const segments = events.filter((e) => e.type === 'segment')
    expect(segments.length).toBeLessThanOrEqual(2)
  })
})

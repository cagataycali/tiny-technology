// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

/**
 * 🎧 /voice/recording Range contract (worker voice.ts parseByteRange).
 *
 * The "iOS won't play call recordings" bug: AVPlayer opens every remote audio
 * asset with a `Range: bytes=0-1` probe and requires Accept-Ranges +
 * Content-Length + a correct 206/Content-Range to size and seek the file.
 * The recording route used to answer every request with a chunked 200 and NO
 * length (`new Response(cached.body)`), which web <audio> tolerates and
 * AVPlayer does not — the strictest client we serve defines the contract.
 * These pin the parser the 206 path is built on.
 */

let v: any
beforeAll(async () => {
  if (!present) return
  v = await import(workerFile('voice.ts') /* @vite-ignore */)
})

warnIfWorkerAbsent('voice-recording-range')

describe.skipIf(!present)('parseByteRange — RFC 7233 single-range forms', () => {
  const T = 1000 // total bytes

  it('no header → null (serve whole body as 200)', () => {
    expect(v.parseByteRange(null, T)).toBeNull()
    expect(v.parseByteRange('', T)).toBeNull()
  })

  it("AVPlayer's opening probe: bytes=0-1 → first two bytes", () => {
    expect(v.parseByteRange('bytes=0-1', T)).toEqual({ start: 0, end: 1 })
  })

  it('open-ended bytes=a- → a through EOF (the seek form)', () => {
    expect(v.parseByteRange('bytes=200-', T)).toEqual({ start: 200, end: T - 1 })
  })

  it('suffix bytes=-n → last n bytes', () => {
    expect(v.parseByteRange('bytes=-100', T)).toEqual({ start: 900, end: 999 })
  })

  it('suffix longer than the asset clamps to the whole body', () => {
    expect(v.parseByteRange('bytes=-5000', T)).toEqual({ start: 0, end: T - 1 })
  })

  it('end beyond EOF clamps to EOF (bytes=990-99999)', () => {
    expect(v.parseByteRange('bytes=990-99999', T)).toEqual({ start: 990, end: T - 1 })
  })

  it('start at/past EOF is unsatisfiable → caller 416s with bytes */total', () => {
    expect(v.parseByteRange(`bytes=${T}-`, T)).toEqual({ unsatisfiable: true })
    expect(v.parseByteRange('bytes=5000-6000', T)).toEqual({ unsatisfiable: true })
  })

  it('inverted window (end < start) is unsatisfiable, not a silent full body', () => {
    expect(v.parseByteRange('bytes=500-100', T)).toEqual({ unsatisfiable: true })
  })

  it('malformed / multipart / non-bytes units fall back to full body (200 is always legal)', () => {
    expect(v.parseByteRange('bytes=abc-def', T)).toBeNull()
    expect(v.parseByteRange('bytes=0-1,5-9', T)).toBeNull() // multipart → 200
    expect(v.parseByteRange('items=0-1', T)).toBeNull()
    expect(v.parseByteRange('bytes=-', T)).toBeNull()
  })

  it('zero-length asset: any range is a no-op null (route 404s before this anyway)', () => {
    expect(v.parseByteRange('bytes=0-1', 0)).toBeNull()
  })

  it('suffix of zero bytes (bytes=-0) is unsatisfiable per RFC', () => {
    expect(v.parseByteRange('bytes=-0', T)).toEqual({ unsatisfiable: true })
  })
})

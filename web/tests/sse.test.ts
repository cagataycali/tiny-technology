// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createSSEDecoder, createSeqTracker } from '../lib/sse'

// Deterministic PRNG so failures reproduce
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

describe('createSeqTracker — one user warning per stream', () => {
  it('stays silent on an in-order stream', () => {
    const t = createSeqTracker()
    expect(t.check(0)).toBeNull()
    expect(t.check(1)).toBeNull()
    expect(t.check(2)).toBeNull()
  })

  it('reports the FIRST gap with detail and first=true', () => {
    const t = createSeqTracker()
    t.check(0)
    expect(t.check(3)).toEqual({ expected: 1, got: 3, first: true })
  })

  it('later gaps still report (console detail) but first=false (no toast stack)', () => {
    const t = createSeqTracker()
    t.check(0)
    expect(t.check(3)!.first).toBe(true)
    t.check(4)
    expect(t.check(9)).toEqual({ expected: 5, got: 9, first: false })
    expect(t.check(20)!.first).toBe(false)
  })

  it('a stream that starts past 0 is itself a gap', () => {
    const t = createSeqTracker()
    expect(t.check(5)).toEqual({ expected: 0, got: 5, first: true })
  })

  it('ignores events without a numeric seq (keepalives, unstamped)', () => {
    const t = createSeqTracker()
    expect(t.check(undefined)).toBeNull()
    expect(t.check('3')).toBeNull()
    expect(t.check(0)).toBeNull() // the unstamped events didn't advance it
  })
})

describe('sawDone — the truncation detector', () => {
  it('is false until the terminal [DONE] marker arrives', () => {
    const d = createSSEDecoder()
    expect(d.sawDone()).toBe(false)
    d.feed('data: {"a":1}\n\n')
    expect(d.sawDone()).toBe(false) // ordinary events are not an ending
  })

  it('flips on [DONE] and still drops it from the payloads', () => {
    const d = createSSEDecoder()
    expect(d.feed('data: {"a":1}\n\ndata: [DONE]\n\n')).toEqual(['{"a":1}'])
    expect(d.sawDone()).toBe(true)
  })

  it('detects [DONE] split across chunk boundaries', () => {
    const d = createSSEDecoder()
    d.feed('data: [DO')
    expect(d.sawDone()).toBe(false)
    d.feed('NE]\n\n')
    expect(d.sawDone()).toBe(true)
  })

  it('detects a CRLF-terminated [DONE] (proxy line endings)', () => {
    const d = createSSEDecoder()
    d.feed('data: [DONE]\r\n\r\n')
    expect(d.sawDone()).toBe(true)
  })
})

describe('createSSEDecoder', () => {
  it('single complete frame', () => {
    const d = createSSEDecoder()
    expect(d.feed(frame({ a: 1 }))).toEqual(['{"a":1}'])
  })

  it('multiple frames in one chunk', () => {
    const d = createSSEDecoder()
    expect(d.feed(frame(1) + frame(2) + frame(3))).toEqual(['1', '2', '3'])
  })

  it('frame split across arbitrary chunk boundaries', () => {
    const d = createSSEDecoder()
    const whole = frame({ text: 'hello world' })
    const out: string[] = []
    for (const ch of whole) out.push(...d.feed(ch)) // one char at a time
    expect(out).toEqual([JSON.stringify({ text: 'hello world' })])
  })

  it('drops keepalive comments and [DONE]', () => {
    const d = createSSEDecoder()
    expect(d.feed(': ping\n\n' + frame('x') + 'data: [DONE]\n\n')).toEqual(['"x"'])
  })

  it('keepalive glued to a data frame in the same chunk', () => {
    const d = createSSEDecoder()
    expect(d.feed(`: ping\ndata: 7\n\n`)).toEqual(['7'])
  })

  it('CRLF-terminated frames flush (proxy \\r\\n\\r\\n boundaries)', () => {
    const d = createSSEDecoder()
    expect(d.feed('data: 1\r\n\r\ndata: 2\r\n\r\n')).toEqual(['1', '2'])
  })

  it('CRLF frame split so a \\r\\n straddles the chunk boundary', () => {
    const d = createSSEDecoder()
    // First chunk ends on a lone \r — must NOT be treated as a line end yet,
    // or the following \n would forge a premature \n\n boundary.
    const out: string[] = []
    out.push(...d.feed('data: hello\r'))
    out.push(...d.feed('\n\r\n')) // completes the frame terminator
    expect(out).toEqual(['hello'])
  })

  it('bare-CR-terminated frame flushes even as the final bytes of a stream', () => {
    // The docstring promises CR / LF / CRLF line terminators. A frame whose
    // blank-line boundary is a bare \r\r arriving last was being dropped: the
    // trailing lone \r got held back (as a possible split \r\n), leaving
    // "data: a\r" → "data: a\n" with no \n\n boundary, stalled forever once the
    // stream ended. The holdback now only fires when the CR is genuinely
    // ambiguous (prev char is ordinary text), so a \r\r boundary flushes now.
    const d = createSSEDecoder()
    expect(d.feed('data: a\r\r')).toEqual(['a'])
  })

  it('mid-stream bare-CR frames still flush', () => {
    const d = createSSEDecoder()
    expect(d.feed('data: a\r\rdata: b\r\r')).toEqual(['a', 'b'])
  })

  it('TORTURE: 500 events survive random chunking bit-exact', () => {
    const rand = mulberry32(1337)
    const events = Array.from({ length: 500 }, (_, i) => ({
      type: 'modelContentBlockDeltaEvent',
      // deltas with newline escapes, emoji, backticks — the report's casualties
      textDelta: `word${i} \`code\` 🌍 line\nbreak `,
    }))
    let wire = ''
    events.forEach((e, i) => {
      if (i % 50 === 0) wire += ': ping\n\n'
      wire += frame(e)
    })
    const d = createSSEDecoder()
    const out: string[] = []
    let pos = 0
    while (pos < wire.length) {
      const n = 1 + Math.floor(rand() * 37) // chunk sizes 1..37
      out.push(...d.feed(wire.slice(pos, pos + n)))
      pos += n
    }
    expect(out).toHaveLength(500)
    out.forEach((payload, i) => {
      expect(JSON.parse(payload)).toEqual(events[i])
    })
  })
})

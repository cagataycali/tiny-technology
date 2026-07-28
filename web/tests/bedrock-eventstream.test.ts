// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseHeaders, parseEventStream } from '../lib/bedrock-edge'

// --- frame builders (mirror the AWS eventstream wire format) --------------

const enc = new TextEncoder()

function strHeader(name: string, value: string): Uint8Array {
  const n = enc.encode(name), v = enc.encode(value)
  const out = new Uint8Array(1 + n.length + 1 + 2 + v.length)
  const dv = new DataView(out.buffer)
  let o = 0
  out[o++] = n.length; out.set(n, o); o += n.length
  out[o++] = 7 // string type
  dv.setUint16(o, v.length); o += 2
  out.set(v, o)
  return out
}

function buildFrame(headers: Uint8Array[], payload: object | null): Uint8Array {
  const headerBytes = concat(headers)
  const payloadBytes = payload ? enc.encode(JSON.stringify(payload)) : new Uint8Array(0)
  const totalLen = 12 + headerBytes.length + payloadBytes.length + 4
  const out = new Uint8Array(totalLen)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, totalLen)
  dv.setUint32(4, headerBytes.length)
  // prelude CRC (8..12) + message CRC (last 4) left zero — parser skips them
  out.set(headerBytes, 12)
  out.set(payloadBytes, 12 + headerBytes.length)
  return out
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>) {
  const frames = []
  for await (const f of parseEventStream(body)) frames.push(f)
  return frames
}

// --- tests ------------------------------------------------------------------

describe('parseHeaders', () => {
  it('parses string headers', () => {
    const buf = concat([strHeader(':event-type', 'contentBlockDelta'), strHeader(':message-type', 'event')])
    expect(parseHeaders(buf)).toEqual({ ':event-type': 'contentBlockDelta', ':message-type': 'event' })
  })

  it('skips non-string header types without desync', () => {
    // bool-true header (type 0, no value) followed by a string header
    const name = enc.encode('flag')
    const boolHeader = new Uint8Array(1 + name.length + 1)
    boolHeader[0] = name.length
    boolHeader.set(name, 1)
    boolHeader[1 + name.length] = 0 // type 0 = bool true
    const buf = concat([boolHeader, strHeader(':event-type', 'messageStop')])
    expect(parseHeaders(buf)[':event-type']).toBe('messageStop')
  })
})

describe('parseEventStream', () => {
  const deltaFrame = buildFrame(
    [strHeader(':message-type', 'event'), strHeader(':event-type', 'contentBlockDelta')],
    { contentBlockIndex: 0, delta: { text: 'hello' } }
  )
  const stopFrame = buildFrame(
    [strHeader(':message-type', 'event'), strHeader(':event-type', 'messageStop')],
    { stopReason: 'end_turn' }
  )

  it('parses complete frames', async () => {
    const frames = await collect(streamOf([deltaFrame, stopFrame]))
    expect(frames).toHaveLength(2)
    expect(frames[0].headers[':event-type']).toBe('contentBlockDelta')
    expect(frames[0].payload.delta.text).toBe('hello')
    expect(frames[1].payload.stopReason).toBe('end_turn')
  })

  it('reassembles frames split at arbitrary byte boundaries', async () => {
    const wire = concat([deltaFrame, stopFrame])
    // 1-byte chunks — the cruelest possible TCP fragmentation
    const chunks = Array.from(wire, (b) => Uint8Array.of(b))
    const frames = await collect(streamOf(chunks))
    expect(frames).toHaveLength(2)
    expect(frames[0].payload.delta.text).toBe('hello')
  })

  it('handles multiple frames in one chunk', async () => {
    const frames = await collect(streamOf([concat([deltaFrame, stopFrame])]))
    expect(frames).toHaveLength(2)
  })

  it('yields empty payload as null', async () => {
    const empty = buildFrame([strHeader(':event-type', 'ping')], null)
    const frames = await collect(streamOf([empty]))
    expect(frames[0].payload).toBeNull()
  })

  it('throws (not hangs) on a corrupt frame reporting totalLen=0', async () => {
    // totalLen=0 makes `buf.subarray(totalLen)` a no-op → infinite loop
    // unless the parser rejects it. 12+ bytes so the while-guard is entered.
    const bad = new Uint8Array(16) // all zeros → totalLen=0, headersLen=0
    await expect(collect(streamOf([bad]))).rejects.toThrow(/malformed frame/)
  })

  it('throws on a frame whose headersLen overflows the frame', async () => {
    const bad = new Uint8Array(20)
    const dv = new DataView(bad.buffer)
    dv.setUint32(0, 20)   // totalLen
    dv.setUint32(4, 999)  // headersLen far larger than the frame
    await expect(collect(streamOf([bad]))).rejects.toThrow(/malformed frame/)
  })
})

// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('device-ask')

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))

import { POST } from '../app/api/devices/ask/route'

/**
 * /api/devices/ask — the Sticky's question proxy (transcript-route.test.ts
 * pattern). Invariants pinned here:
 *   - device-credential auth, NO session: the caller is a wall display
 *   - a spoofed userId in the body never travels — the worker resolves the
 *     owner from the token
 *   - bad input is a 400 before the worker is touched; worker 401 (revoked)
 *     and 422 (bad audio) pass through; everything else collapses to 424
 *   - the card rides back UNtouched when the worker returns one, and is
 *     absent (not null/undefined-keyed) when it doesn't
 * Plus the worker-side extractCard battery: the card parser must degrade to
 * text-only on every malformed shape — the device renders whatever returns.
 */
const req = (body: string | object) =>
  new Request('https://tiny.technology/api/devices/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

afterEach(() => vi.restoreAllMocks())

describe('POST /api/devices/ask — device question passthrough', () => {
  it('forwards deviceId+token+text on device credentials alone; answer and card come back', async () => {
    let sentUrl = ''
    let sentBody: any
    global.fetch = vi.fn(async (url: any, init: any) => {
      sentUrl = String(url)
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({
        ok: true, text: 'Back at 19:30.', card: { type: 'kv', rows: { in: '19:30' } },
      }), { status: 200 })
    }) as any
    const res = await POST(req({ deviceId: 'd1', token: 'tind_x', text: 'when is he back?' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.text).toBe('Back at 19:30.')
    expect(data.card).toEqual({ type: 'kv', rows: { in: '19:30' } })
    expect(sentUrl).toContain('/device/ask')
    expect(sentBody).toMatchObject({ deviceId: 'd1', token: 'tind_x', text: 'when is he back?' })
  })

  it('a spoofed userId is NOT forwarded — the token resolves the owner', async () => {
    let sentBody: any
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, text: 'hi' }), { status: 200 })
    }) as any
    const res = await POST(req({ deviceId: 'd1', token: 't', text: 'hi', userId: 'HACKER' }))
    expect(res.status).toBe(200)
    expect(sentBody).not.toHaveProperty('userId')
  })

  it('audioUrl-only asks are valid (voice path) and the URL travels unsliced', async () => {
    let sentBody: any
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, text: 'heard you' }), { status: 200 })
    }) as any
    const long = 'https://media.tiny.technology/' + 'a'.repeat(400) + '.wav'
    const res = await POST(req({ deviceId: 'd1', token: 't', audioUrl: long }))
    expect(res.status).toBe(200)
    expect(sentBody.audioUrl).toBe(long) // worker refuses oversize with 400; truncation would sneak past
  })

  it('missing text AND audioUrl is a 400 before any fetch', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const res = await POST(req({ deviceId: 'd1', token: 't' }))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('malformed JSON body is a 400, not a crash', async () => {
    global.fetch = vi.fn() as any
    const res = await POST(req('{nope'))
    expect(res.status).toBe(400)
  })

  it('worker 401 passes through (revoked device → firmware reopens portal)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'unknown device' }), { status: 401 })) as any
    const res = await POST(req({ deviceId: 'd1', token: 'revoked', text: 'hi' }))
    expect(res.status).toBe(401)
  })

  it('worker 422 passes through (bad audio is retriable with a new take)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'nothing transcribed' }), { status: 422 })) as any
    const res = await POST(req({ deviceId: 'd1', token: 't', audioUrl: 'https://m/x.wav' }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('nothing transcribed')
  })

  it('worker down is a 424, and a 5xx never leaks through as-is', async () => {
    global.fetch = vi.fn(async () => { throw new Error('boom') }) as any
    const res1 = await POST(req({ deviceId: 'd1', token: 't', text: 'hi' }))
    expect(res1.status).toBe(424)
    global.fetch = vi.fn(async () =>
      new Response('internal error', { status: 500 })) as any
    const res2 = await POST(req({ deviceId: 'd1', token: 't', text: 'hi' }))
    expect(res2.status).toBe(424)
  })

  it('no card key at all when the worker answered text-only', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, text: 'just words' }), { status: 200 })) as any
    const res = await POST(req({ deviceId: 'd1', token: 't', text: 'hi' }))
    const data = await res.json()
    expect(data.text).toBe('just words')
    expect('card' in data).toBe(false)
  })
})

describe.skipIf(!present)('worker extractCard — card block parser degrades to text-only', () => {
  it('lifts a well-formed card out of the prose', async () => {
    const { extractCard } = await import(workerFile('ask.ts') /* @vite-ignore */)
    const raw = 'Back at 19:30 — pizza in the fridge.\n```card\n{"type":"kv","title":"Dinner","rows":{"in":"19:30"}}\n```'
    const { text, card } = extractCard(raw)
    expect(text).toBe('Back at 19:30 — pizza in the fridge.')
    expect(card).toEqual({ type: 'kv', title: 'Dinner', rows: { in: '19:30' } })
  })

  it('no block → text through untouched, card null', async () => {
    const { extractCard } = await import(workerFile('ask.ts') /* @vite-ignore */)
    expect(extractCard('plain answer')).toEqual({ text: 'plain answer', card: null })
  })

  it('malformed JSON in the block → prose survives, card null', async () => {
    const { extractCard } = await import(workerFile('ask.ts') /* @vite-ignore */)
    const { text, card } = extractCard('answer\n```card\n{nope\n```')
    expect(text).toBe('answer')
    expect(card).toBeNull()
  })

  it('unknown card type is refused (the device can only render the v1 set)', async () => {
    const { extractCard } = await import(workerFile('ask.ts') /* @vite-ignore */)
    const { card } = extractCard('x\n```card\n{"type":"iframe","src":"https://evil"}\n```')
    expect(card).toBeNull()
  })

  it('a JSON array or scalar is refused — a card is an object', async () => {
    const { extractCard } = await import(workerFile('ask.ts') /* @vite-ignore */)
    expect(extractCard('x\n```card\n[1,2]\n```').card).toBeNull()
    expect(extractCard('x\n```card\n"text"\n```').card).toBeNull()
  })

  it('an oversize block is dropped, not parsed', async () => {
    const mod = await import(workerFile('ask.ts') /* @vite-ignore */)
    const big = '{"type":"text","body":"' + 'a'.repeat(mod.ASK_CARD_MAX) + '"}'
    expect(mod.extractCard('x\n```card\n' + big + '\n```').card).toBeNull()
  })

  it('prose around the block is stitched back together', async () => {
    const { extractCard } = await import(workerFile('ask.ts') /* @vite-ignore */)
    const raw = 'before\n```card\n{"type":"text","body":"b"}\n```\nafter'
    const { text, card } = extractCard(raw)
    expect(card).toEqual({ type: 'text', body: 'b' })
    expect(text).toContain('before')
    expect(text).toContain('after')
  })
})

// ── STREAMING_UI.md M-S3: the SSE typer arm ────────────────────────────────

describe('sse typer helpers (worker ask.ts)', () => {
  it.runIf(present)('wordBatches reproduces the original on concat and paces ~4 words', async () => {
    const { wordBatches } = await import(workerFile('ask.ts') /* @vite-ignore */)
    const text = 'the quick brown fox jumps over the lazy dog near the bank'
    const batches = wordBatches(text)
    expect(batches.join('')).toBe(text)          // no byte invented or lost
    expect(batches.length).toBe(3)               // 12 words / 4
    expect(batches[0]).toBe('the quick brown fox ')
  })

  it.runIf(present)('wordBatches: empty and whitespace-only inputs make no frames', async () => {
    const { wordBatches } = await import(workerFile('ask.ts') /* @vite-ignore */)
    expect(wordBatches('')).toEqual([])
    // whitespace-only: \S+ requires a word — nothing to type is no frames,
    // not one frame of invisible spaces
    expect(wordBatches('   ')).toEqual([])
  })

  it.runIf(present)('sseData frames one JSON object per data: line', async () => {
    const { sseData } = await import(workerFile('ask.ts') /* @vite-ignore */)
    expect(sseData({ t: 'hi ' })).toBe('data: {"t":"hi "}\n\n')
    // a quote inside a delta must not break the frame
    const framed = sseData({ t: 'she said "no"' })
    expect(framed.startsWith('data: ')).toBe(true)
    expect(JSON.parse(framed.slice(6)).t).toBe('she said "no"')
  })
})

describe('proxy stream passthrough', () => {
  it('pipes the worker SSE body through untouched when stream:"1"', async () => {
    const sse = 'data: {"t":"hello "}\n\ndata: [DONE]\n\n'
    global.fetch = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as any
    const res = await POST(req({ deviceId: 'd1', token: 't1', text: 'hi', stream: '1' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toBe(sse)
    // and the flag traveled to the worker
    const sentBody = JSON.parse((global.fetch as any).mock.calls[0][1].body)
    expect(sentBody.stream).toBe('1')
  })

  it('degrades to classic JSON when the worker declines to stream', async () => {
    // an older worker ignores stream:"1" and answers plain JSON — the proxy
    // must fall through to the classic arm, not hand JSON bytes out as SSE
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, text: 'plain answer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as any
    const res = await POST(req({ deviceId: 'd1', token: 't1', text: 'hi', stream: '1' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.text).toBe('plain answer')
  })

  it('never sends the stream flag when the device did not ask', async () => {
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, text: 'x' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as any
    await POST(req({ deviceId: 'd1', token: 't1', text: 'hi' }))
    const sentBody = JSON.parse((global.fetch as any).mock.calls[0][1].body)
    expect('stream' in sentBody).toBe(false)   // old-firmware bodies stay byte-identical
  })
})

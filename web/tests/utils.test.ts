import { describe, it, expect, vi, afterEach } from 'vitest'
import { validatePublicUrl, readBoundedText, readClippedText, getWeatherData, parseOpenAPI, parseDecimalInput, pluralize } from '../lib/utils'

// SSRF guard shared by /api/worker, dynamic OpenAPI tools, and user-tool fetch
describe('validatePublicUrl', () => {
  it('accepts public https URLs', () => {
    const r = validatePublicUrl('https://api.github.com/repos/x/y')
    expect('url' in r).toBe(true)
  })

  it.each([
    ['http://example.com', 'https'],
    ['ftp://example.com', 'https'],
    ['https://localhost/x', 'public hostname'],
    ['https://127.0.0.1/x', 'public hostname'],
    ['https://10.0.0.1/x', 'public hostname'],
    ['https://169.254.169.254/latest/meta-data/', 'public hostname'],
    ['https://[::1]/x', 'public hostname'],
    ['https://foo.local/x', 'public hostname'],
    ['https://backend.internal/x', 'public hostname'],
    ['https://intranet/x', 'public hostname'],
    // Trailing-dot (FQDN-root) forms resolve identically to the dotless host
    ['https://127.0.0.1./x', 'public hostname'],
    ['https://localhost./x', 'public hostname'],
    ['https://169.254.169.254./latest/meta-data/', 'public hostname'],
    // Encoded IPv4 literals inet_aton still resolves to loopback/private space
    ['https://0177.0.0.1/x', 'public hostname'],       // octal
    ['https://0x7f.0.0.1/x', 'public hostname'],        // hex label
    ['https://2130706433/x', 'public hostname'],        // dotless decimal = 127.0.0.1
    ['not a url', 'invalid'],
    ['', 'required'],
  ])('rejects %s', (input, errFragment) => {
    const r = validatePublicUrl(input)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain(errFragment)
  })
})

// parseOpenAPI runs unguarded in the chat-route setup over a spec fetched from
// a user/owner-controlled worker URL — a malformed spec must degrade, never
// throw out of .forEach and fault the whole chat turn.
describe('parseOpenAPI — malformed-spec resilience', () => {
  it('returns [] for missing/pathless specs', () => {
    expect(parseOpenAPI(null)).toEqual([])
    expect(parseOpenAPI({})).toEqual([])
    expect(parseOpenAPI({ paths: {} })).toEqual([])
  })

  it('does not throw on a truthy-but-non-string $ref (JSON allows {"$ref":123})', () => {
    const spec = {
      paths: {
        '/x': {
          post: {
            operationId: 'doX',
            parameters: [{ name: 'p', in: 'query', schema: { $ref: 123 } }],
            requestBody: { content: { 'application/json': { schema: { $ref: {} } } } },
          },
        },
      },
    }
    // Before the guard, (123).split threw a TypeError here.
    expect(() => parseOpenAPI(spec)).not.toThrow()
    const [fn] = parseOpenAPI(spec)
    expect(fn.name).toBe('doX')
    // non-string $ref resolves to {} → the param survives with an undefined type
    expect(fn.parameters.properties.p).toBeDefined()
  })
})

describe('readBoundedText — all-or-nothing bounded read (worker specs)', () => {
  it('returns small bodies intact', async () => {
    const res = new Response('{"paths":{}}', { headers: { 'content-type': 'application/json' } })
    expect(await readBoundedText(res, 1000)).toBe('{"paths":{}}')
  })

  it('rejects an oversized Content-Length', async () => {
    const res = new Response('short body', { headers: { 'content-length': '999999' } })
    // Declared size exceeds the cap → null even though the actual body is small
    expect(await readBoundedText(res, 100)).toBeNull()
  })

  it('returns null when a chunked body (no Content-Length) exceeds the cap', async () => {
    const chunk = 'x'.repeat(60)
    let sent = 0
    const body = new ReadableStream({
      pull(c) { if (sent++ < 5) c.enqueue(new TextEncoder().encode(chunk)); else c.close() },
    })
    const res = new Response(body) // no content-length → must stream-check
    expect(await readBoundedText(res, 100)).toBeNull() // 300 bytes > 100 cap
  })

  it('reads a chunked body that stays under the cap', async () => {
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('hello ')); c.enqueue(new TextEncoder().encode('world')); c.close() },
    })
    const res = new Response(body)
    expect(await readBoundedText(res, 100)).toBe('hello world')
  })
})

describe('readClippedText — best-effort bounded clip (http tool)', () => {
  it('returns full text + truncated:false under the cap', async () => {
    const res = new Response('hello world')
    expect(await readClippedText(res, 100)).toEqual({ text: 'hello world', truncated: false })
  })

  it('clips to the cap + truncated:true when over', async () => {
    const res = new Response('z'.repeat(5000))
    const { text, truncated } = await readClippedText(res, 100)
    expect(text.length).toBe(100)
    expect(truncated).toBe(true)
  })

  it('exactly-cap body is not marked truncated', async () => {
    const res = new Response('a'.repeat(100))
    const { text, truncated } = await readClippedText(res, 100)
    expect(text.length).toBe(100)
    expect(truncated).toBe(false)
  })

  it('a chunk landing exactly on the cap with MORE to follow is truncated', async () => {
    // Regression: the loop must not stop the instant it hits the cap — a
    // second chunk still waiting means the body WAS clipped. Old code broke
    // on `out.length < limit` and reported truncated:false here.
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('a'.repeat(100))) // exactly the cap
        c.enqueue(new TextEncoder().encode('bcd'))            // dropped bytes
        c.close()
      },
    })
    const { text, truncated } = await readClippedText(new Response(body), 100)
    expect(text.length).toBe(100)
    expect(truncated).toBe(true)
  })
})

// getWeatherData feeds the not-found page's weather metadata, which is
// JSON-serialized into the x-tiny-metadata header and handed to the model as
// context. weatherapi returns a JSON *error* body on a bad status (e.g. 400
// {"error":{"code":1006}} for an unknown x-vercel-ip-city) — res.json()
// resolves that, so it must be gated on r.ok or the error object flows through
// as bogus "weather" context.
describe('getWeatherData — r.ok gate', () => {
  const realFetch = global.fetch
  const realKey = process.env.WEATHER_API_KEY
  afterEach(() => {
    global.fetch = realFetch
    if (realKey === undefined) delete process.env.WEATHER_API_KEY
    else process.env.WEATHER_API_KEY = realKey
    vi.restoreAllMocks()
  })

  it('returns null (not the JSON error body) on a non-2xx status', async () => {
    process.env.WEATHER_API_KEY = 'test-key'
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 1006, message: 'No matching location found.' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as any
    expect(await getWeatherData('Nowheresville')).toBeNull()
  })

  it('returns the parsed body on a 200', async () => {
    process.env.WEATHER_API_KEY = 'test-key'
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ current: { temp_c: 18 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as any
    expect(await getWeatherData('San Francisco')).toEqual({ current: { temp_c: 18 } })
  })

  it('returns null without fetching when no API key is set', async () => {
    delete process.env.WEATHER_API_KEY
    const spy = vi.fn()
    global.fetch = spy as any
    expect(await getWeatherData('San Francisco')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('parseDecimalInput — comma-locale money field parses without truncating', () => {
  it('parses a dot decimal (en/US keypad) unchanged', () => {
    expect(parseDecimalInput('10.50')).toBe(10.5)
    expect(parseDecimalInput('1')).toBe(1)
    expect(parseDecimalInput('0.000001')).toBeCloseTo(0.000001, 9)
  })

  it('parses a comma decimal (de/fr/tr keypad) — the bug plain parseFloat truncated', () => {
    // parseFloat("10,50") is 10 — the $0.50 silently vanished, and any fractional
    // withdrawal was impossible for a comma-locale user. Normalized, it's 10.5.
    expect(parseDecimalInput('10,50')).toBe(10.5)
    expect(parseDecimalInput('1,99')).toBe(1.99)
    // Sanity: plain parseFloat DID drop the cents — this is the bug we fixed.
    expect(parseFloat('10,50')).toBe(10)
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(parseDecimalInput('  12.34  ')).toBe(12.34)
    expect(parseDecimalInput('  12,34  ')).toBe(12.34)
  })

  it('rejects AMBIGUOUS multi-separator input instead of silently truncating (Android/iOS parity)', () => {
    // Plain parseFloat("1.234,56") stops at the 2nd separator → 1.234, so a
    // pasted "1,234,56" would silently withdraw $1.234 the user never meant.
    // Android (toDoubleOrNull) + iOS (Double()) both reject two separators →
    // Withdraw stays disabled. Web must fail closed the same way, not lie.
    expect(Number.isNaN(parseDecimalInput('1,234,56'))).toBe(true) // was silently 1.234
    expect(Number.isNaN(parseDecimalInput('1.234.56'))).toBe(true)
    expect(Number.isNaN(parseDecimalInput('1,234.56'))).toBe(true) // grouped thousands — no decimal keypad emits it
    expect(Number.isNaN(parseDecimalInput('1.234,56'))).toBe(true)
    // Sanity: the truncation this guards against is real in bare parseFloat.
    expect(parseFloat('1.234,56')).toBe(1.234)
  })

  it('returns NaN for empty / garbage / nullish (callers gate on isFinite + min)', () => {
    expect(Number.isNaN(parseDecimalInput(''))).toBe(true)
    expect(Number.isNaN(parseDecimalInput('   '))).toBe(true)
    expect(Number.isNaN(parseDecimalInput('abc'))).toBe(true)
    // @ts-expect-error — defensive: a nullish value must not throw
    expect(Number.isNaN(parseDecimalInput(null))).toBe(true)
    // @ts-expect-error
    expect(Number.isNaN(parseDecimalInput(undefined))).toBe(true)
  })
})

// Shared count-label grammar — replaces ~19 ad-hoc `n === 1 ? "" : "s"` / hardcoded-`s`
// sites (CommandPalette "1 msgs", MemoryGraph "1 facts · 1 links", constellation footers).
describe('pluralize — English count grammar', () => {
  it('singular ONLY at exactly 1', () => {
    expect(pluralize(1, 'msg')).toBe('1 msg')
    expect(pluralize(1, 'fact')).toBe('1 fact')
  })

  it('0 and 2+ are plural', () => {
    expect(pluralize(0, 'fact')).toBe('0 facts')
    expect(pluralize(2, 'msg')).toBe('2 msgs')
    expect(pluralize(17, 'link')).toBe('17 links')
  })

  it('takes an explicit irregular plural', () => {
    expect(pluralize(1, 'entry', 'entries')).toBe('1 entry')
    expect(pluralize(3, 'entry', 'entries')).toBe('3 entries')
    expect(pluralize(0, 'tiny', 'tinys')).toBe('0 tinys')
  })

  it('a lone -1 is singular (|n| === 1)', () => {
    expect(pluralize(-1, 'msg')).toBe('-1 msg')
  })

  it('degrades a non-finite count to a plural 0 rather than "NaN msgs undefined"', () => {
    expect(pluralize(NaN, 'msg')).toBe('0 msgs')
    // @ts-expect-error
    expect(pluralize(undefined, 'fact')).toBe('0 facts')
    // @ts-expect-error
    expect(pluralize(null, 'link')).toBe('0 links')
  })
})

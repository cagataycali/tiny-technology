// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { friendlyError, resultText, serializeToolContent, isOverflowError, buildMcpClients, usd } from '../lib/chat/helpers'
import { usdRate } from '../lib/utils'
import { normalizeProvider, preflightModelCheck } from '../lib/chat/model'

describe('usd (Rule B money formatter for agent-relayed payment prose)', () => {
  it('always pads to ≥2 fraction digits — $0.50 not $0.5', () => {
    expect(usd(500_000)).toBe('$0.50')
    expect(usd(1_000_000)).toBe('$1.00')
    expect(usd(1_500_000)).toBe('$1.50')
  })

  it('keeps sub-cent precision up to 6 digits', () => {
    expect(usd(1)).toBe('$0.000001')
    expect(usd(300_000)).toBe('$0.30')
    expect(usd(123_456)).toBe('$0.123456')
  })

  it('thousand-groups the integer part', () => {
    expect(usd(1_234_000_000)).toBe('$1,234.00')
  })

  it('never leaks a float artifact or scientific notation from bare division', () => {
    // 300000/1e6 = 0.30000000000000004 in raw JS; toFixed-free interpolation
    // would surface the tail. usd() must not.
    expect(usd(300_000)).toBe('$0.30')
    expect(usd(100_000)).toBe('$0.10')
    // 1 micro is 1e-7 dollars — bare `${n}` would render "1e-7", not "$0.000001".
    expect(usd(1)).not.toContain('e')
  })

  it('renders zero as $0.00', () => {
    expect(usd(0)).toBe('$0.00')
  })

  it('degrades a non-finite micro to $0.00, never "$NaN"', () => {
    // A malformed/absent worker field reaching usd(): Number(undefined) and
    // Number('abc') are NaN, and NaN.toLocaleString(currency) is "$NaN".
    expect(usd(NaN)).toBe('$0.00')
    expect(usd(undefined as unknown as number)).toBe('$0.00')
    expect(usd('abc' as unknown as number)).toBe('$0.00')
    expect(usd(Infinity)).toBe('$0.00')
  })
})

describe('usdRate (per-message price badge — a rate, not a charge)', () => {
  it('strips trailing zeros — $1 and $0.5, not $1.00 and $0.50', () => {
    expect(usdRate(1_000_000)).toBe('$1')
    expect(usdRate(500_000)).toBe('$0.5')
  })

  it('keeps sub-cent precision down to a single micro', () => {
    expect(usdRate(1)).toBe('$0.000001')
    expect(usdRate(1_230_000)).toBe('$1.23')
  })

  it('renders zero as $0', () => {
    expect(usdRate(0)).toBe('$0')
  })

  it('degrades a non-finite micro to $0, never "$NaN" (usd() parity)', () => {
    expect(usdRate(NaN)).toBe('$0')
    expect(usdRate(undefined as unknown as number)).toBe('$0')
    expect(usdRate(Infinity)).toBe('$0')
  })
})

describe('friendlyError', () => {
  it('passes through plain messages', () => {
    expect(friendlyError(new Error('connection refused'))).toBe('connection refused')
  })

  it('digs the message out of provider JSON bodies', () => {
    const raw = new Error('400 {"error":{"message":"Invalid API key provided","type":"auth"}}')
    expect(friendlyError(raw)).toBe('Invalid API key provided')
  })

  it('unwraps nested stringified errors (Google style)', () => {
    const inner = JSON.stringify({ error: { message: 'Quota exceeded for model' } })
    const raw = new Error(`got status: 429. {"error":{"message":${JSON.stringify(inner)}}}`)
    expect(friendlyError(raw)).toBe('Quota exceeded for model')
  })

  it('caps runaway messages at 500 chars', () => {
    expect(friendlyError(new Error('x'.repeat(2000))).length).toBe(500)
  })

  it('survives null/undefined', () => {
    expect(friendlyError(null)).toBe('Unknown error')
    expect(friendlyError(undefined)).toBe('Unknown error')
  })
})

describe('resultText', () => {
  it('joins text blocks from the last message', () => {
    const result = { lastMessage: { content: [{ text: 'part one' }, { text: 'part two' }] } }
    expect(resultText(result)).toBe('part one\npart two')
  })

  it('falls back to String() on shapeless input', () => {
    expect(resultText('raw string')).toBe('raw string')
    expect(resultText({ lastMessage: { content: [] } })).toContain('object')
  })
})

describe('serializeToolContent', () => {
  it('calls toJSON on blocks that have it', () => {
    const block = { toJSON: () => ({ text: 'serialized' }) }
    expect(serializeToolContent([block])).toEqual([{ text: 'serialized' }])
    expect(serializeToolContent(block)).toEqual({ text: 'serialized' })
  })

  it('passes plain data through', () => {
    expect(serializeToolContent([{ text: 'plain' }])).toEqual([{ text: 'plain' }])
    expect(serializeToolContent(null)).toBeNull()
  })
})

describe('normalizeProvider', () => {
  it('maps gemini → google, lowercases, defaults to openai', () => {
    expect(normalizeProvider('gemini')).toBe('google')
    expect(normalizeProvider('OpenRouter')).toBe('openrouter')
    expect(normalizeProvider(undefined)).toBe('openai')
  })
})

describe('preflightModelCheck', () => {
  it('accepts any provider when a BYOK key is present', () => {
    expect(preflightModelCheck({ provider: 'bedrock', apiKey: 'k' })).toBeNull()
    expect(preflightModelCheck({ provider: 'google', apiKey: 'k' })).toBeNull()
  })

  it('rejects keyless providers with a helpful message', () => {
    // vercel has no env fallback in the test environment
    const err = preflightModelCheck({ provider: 'vercel' })
    expect(err).toContain("provider 'vercel'")
  })
})

describe('isOverflowError — self-heal classifier (retry only what a retry fixes)', () => {
  it('true for context-overflow phrasings across providers', () => {
    for (const m of [
      "This model's maximum context length is 128000 tokens",
      'prompt is too long: 210000 tokens > 200000 maximum',
      'input is too long for requested model',
      'Request too large for gpt-4o',
      'context_length_exceeded',
      'The input exceeds the context window',
    ]) {
      expect(isOverflowError(new Error(m))).toBe(true)
    }
  })

  it('FALSE for rate/quota/billing — retrying those wastes a call', () => {
    for (const m of [
      'Rate limit reached for requests',
      'You exceeded your current quota',
      'billing hard limit has been reached',
      // even if it mentions tokens, a rate limit must not self-heal:
      'Rate limit: too many tokens per minute',
    ]) {
      expect(isOverflowError(new Error(m))).toBe(false)
    }
  })

  it('false for unrelated errors + null/undefined', () => {
    expect(isOverflowError(new Error('connection reset'))).toBe(false)
    expect(isOverflowError(null)).toBe(false)
    expect(isOverflowError(undefined)).toBe(false)
    expect(isOverflowError('some string')).toBe(false)
  })
})

describe('buildMcpClients — SSRF guard on MCP server urls', () => {
  // The config comes from the x-tiny-mcp-servers header (client) or the tiny
  // config (owner ≠ acting user); the server connects to the url AND injects
  // the owner's headers, so an unvalidated url is blind SSRF + secret exfil.
  it.each([
    'http://example.com/mcp',            // non-https
    'https://169.254.169.254/latest/',   // cloud metadata IP
    'https://localhost/mcp',
    'https://10.0.0.1/mcp',
    'https://backend.internal/mcp',
    'https://intranet/mcp',              // dotless host
  ])('drops the SSRF-y url %s', (url) => {
    const clients = buildMcpClients({ mcpServers: { evil: { url, headers: { 'X-Secret': 'k' } } } })
    expect(clients).toHaveLength(0)
  })

  it('accepts a public https url', () => {
    const clients = buildMcpClients({ mcpServers: { ok: { url: 'https://mcp.example.com/sse' } } })
    expect(clients).toHaveLength(1)
  })

  it('skips disabled and url-less entries', () => {
    const clients = buildMcpClients({ mcpServers: {
      off: { url: 'https://mcp.example.com/sse', disabled: true },
      bare: { headers: {} },
    } })
    expect(clients).toHaveLength(0)
  })

  it('non-object config → []', () => {
    expect(buildMcpClients(null)).toEqual([])
    expect(buildMcpClients('nope')).toEqual([])
  })
})

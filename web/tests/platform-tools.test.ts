// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

beforeAll(() => { process.env.INTERNAL_API_KEY = 'test-internal-key' })

import { makeForgedTools, buildDynamicTools, makeUseTelegramTool, makeScreenshotTool, makeWalletTool } from '../lib/chat/tools/platform'

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

// The round-trip tools poll the mailbox with setTimeout(2000) between tries.
// Drive them with fake timers so tests don't wait real seconds: invoke without
// awaiting, then flush timers until the promise settles.
async function runPolling(promise: Promise<any>) {
  // Flush up to the tool's 45-iteration budget; each iteration is one 2s tick.
  for (let i = 0; i < 46; i++) {
    await vi.advanceTimersByTimeAsync(2000)
  }
  return promise
}

describe('makeScreenshotTool — generate_image twin, round-trip w/ consent', () => {
  const CTX = { toolUse: { toolUseId: 'tu-1' } }

  it('declines without a userId (login required)', async () => {
    const out = await (makeScreenshotTool(null) as any).invoke({}, CTX)
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/login required/i)
  })

  it('errors without a toolUseId (no mailbox key to poll)', async () => {
    const out = await (makeScreenshotTool('u1') as any).invoke({}, { toolUse: {} })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/toolUseId/)
  })

  it('surfaces a user decline as denied (not a retryable error)', async () => {
    vi.useFakeTimers()
    try {
      global.fetch = vi.fn(async () => new Response(
        JSON.stringify({ result: { payload: JSON.stringify({ denied: true }) } }),
        { headers: { 'content-type': 'application/json' } },
      )) as any
      const out = await runPolling((makeScreenshotTool('u1') as any).invoke({}, CTX))
      expect(out.ok).toBe(false)
      expect(out.denied).toBe(true)
      expect(String(out.note)).toMatch(/declined/i)
    } finally { vi.useRealTimers() }
  })

  it('returns an ImageBlock + note when the device uploads a capture', async () => {
    vi.useFakeTimers()
    try {
      global.fetch = vi.fn(async (url: any) => {
        if (String(url).includes('/device/tool-result')) {
          return new Response(
            JSON.stringify({ result: { payload: JSON.stringify({ ok: true, url: 'https://plugin.tiny.technology/media/abc', format: 'jpeg' }) } }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        // R2 bytes fetch
        return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 })
      }) as any
      const out = await runPolling((makeScreenshotTool('u1') as any).invoke({}, CTX))
      expect(Array.isArray(out)).toBe(true)
      // First block is the real vision image the model sees
      expect(out[0]?.constructor?.name).toMatch(/ImageBlock/)
    } finally { vi.useRealTimers() }
  })

  it('errors when the device result omits the media url', async () => {
    vi.useFakeTimers()
    try {
      global.fetch = vi.fn(async () => new Response(
        JSON.stringify({ result: { payload: JSON.stringify({ ok: true }) } }),
        { headers: { 'content-type': 'application/json' } },
      )) as any
      const out = await runPolling((makeScreenshotTool('u1') as any).invoke({}, CTX))
      expect(out.ok).toBe(false)
      expect(String(out.error)).toMatch(/media url/)
    } finally { vi.useRealTimers() }
  })
})

describe('makeUseTelegramTool — userId-keyed (works for sessions AND scheduled jobs)', () => {
  it('declines without a userId (not logged in / job row missing owner)', async () => {
    const out = await (makeUseTelegramTool(null) as any).invoke({ method: 'sendMessage' })
    expect(out.ok).toBe(false)
    expect(String(out.note)).toMatch(/login required/i)
  })

  it('posts the given userId + method to the worker telegram proxy', async () => {
    const spy = vi.fn(async () => new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    }))
    global.fetch = spy as any
    const out = await (makeUseTelegramTool('user-123') as any).invoke({
      method: 'sendMessage',
      params: { chat_id: '42', text: 'hi' },
    })
    expect(out.ok).toBe(true)
    const [url, init] = spy.mock.calls[0] as any[]
    expect(String(url)).toBe('https://plugin.tiny.technology/telegram/api')
    const body = JSON.parse(init.body)
    expect(body.userId).toBe('user-123')
    expect(body.method).toBe('sendMessage')
    expect(JSON.parse(body.params)).toEqual({ chat_id: '42', text: 'hi' })
    // internal-key channel — the token never leaves the worker
    expect(init.headers['X-Internal-Key']).toBe('test-internal-key')
  })

  it('degrades to a model-readable error when the worker is unreachable', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down') }) as any
    const out = await (makeUseTelegramTool('user-123') as any).invoke({ method: 'getChat' })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/network down/)
  })
})

describe('makeWalletTool — READ-ONLY balance + ledger (chat AND scheduled jobs)', () => {
  it('declines without a userId (wallet belongs to the account)', async () => {
    const out = await (makeWalletTool(null) as any).invoke({})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/login required/i)
  })

  it('reads /pay/balance on the internal-key channel and formats the ledger', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      balance_micro: 1_230_000,
      history: [
        { delta_micro: -10_000, kind: 'invoke_debit', ref: 'r1', counterparty: 'owner-9', created: '2026-07-25 10:00:00' },
        { delta_micro: 1_000_000, kind: 'deposit', ref: 'faucet:2026-07-25', counterparty: 'trial:tiny', created: '2026-07-25 09:00:00' },
      ],
    }), { headers: { 'content-type': 'application/json' } }))
    global.fetch = spy as any
    const out = await (makeWalletTool('user-123') as any).invoke({})
    expect(out.ok).toBe(true)
    // Rule-B money strings, never raw floats, and direction as a word not a sign
    expect(out.balance).toBe('$1.23')
    expect(out.balance_micro).toBe(1_230_000)
    expect(out.recent[0]).toMatchObject({ amount: '$0.01', direction: 'out', kind: 'invoke_debit', counterparty: 'owner-9' })
    expect(out.recent[1]).toMatchObject({ amount: '$1.00', direction: 'in', kind: 'deposit' })
    const [url, init] = spy.mock.calls[0] as any[]
    expect(String(url)).toBe('https://plugin.tiny.technology/pay/balance?userId=user-123')
    expect(init.headers['X-Internal-Key']).toBe('test-internal-key')
  })

  it('trims to the requested limit and reports what was cut', async () => {
    const history = Array.from({ length: 7 }, (_, i) => ({
      delta_micro: -1_000, kind: 'invoke_debit', ref: `r${i}`, counterparty: 'x', created: '2026-07-25 10:00:00',
    }))
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, balance_micro: 0, history }),
      { headers: { 'content-type': 'application/json' } },
    )) as any
    const out = await (makeWalletTool('u1') as any).invoke({ limit: 3 })
    expect(out.recent).toHaveLength(3)
    expect(String(out.more)).toMatch(/4 more/)
  })

  it('degrades to a model-readable error when the worker is unreachable', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down') }) as any
    const out = await (makeWalletTool('u1') as any).invoke({})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/network down/)
    // The model still gets a safe next step for the user
    expect(String(out.response)).toMatch(/\/wallet/)
  })

  it('treats a malformed worker payload (no numeric balance) as an error, never $NaN', async () => {
    global.fetch = vi.fn(async () => new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    })) as any
    const out = await (makeWalletTool('u1') as any).invoke({})
    expect(out.ok).toBe(false)
  })
})

describe('makeForgedTools — my_* mounting from user_tools rows', () => {
  it('mounts rows as my_<name> with parsed params', () => {
    const tools = makeForgedTools([
      { name: 'reverse', description: 'reverses', params_json: '{"text":"input text"}', code: '(args)=>args.text' },
    ])
    expect(tools).toHaveLength(1)
    expect((tools[0] as any).name).toBe('my_reverse')
  })

  it('tolerates malformed params_json and non-array input', () => {
    expect(makeForgedTools([{ name: 'x', params_json: '{oops', code: '' }])).toHaveLength(1)
    expect(makeForgedTools(undefined as any)).toEqual([])
  })

  it('sanitizes a name with spaces/punctuation instead of throwing at mount', () => {
    // create_tool only *describes* snake_case; the stored name is model-
    // supplied. A raw `my_get weather!` would make the Strands ToolRegistry
    // throw in the Agent constructor (outside the stream try/catch) → a 500
    // on every chat turn. Coerce to the registry rule instead.
    const tools = makeForgedTools([
      { name: 'get weather!', params_json: '{}', code: '' },
    ])
    expect(tools).toHaveLength(1)
    expect((tools[0] as any).name).toBe('my_get_weather_')
    expect((tools[0] as any).name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('truncates an over-long name to the 64-char registry ceiling', () => {
    const tools = makeForgedTools([{ name: 'a'.repeat(80), params_json: '{}', code: '' }])
    expect(tools).toHaveLength(1)
    expect((tools[0] as any).name.length).toBe(64)
  })

  it('coerces a non-string name through the template + sanitizer (never throws)', () => {
    // The `my_` prefix guarantees a usable name (m/y/_ all valid), so the
    // sanitizer never returns null here — but a non-string name must still be
    // coerced to a registry-valid string rather than crash the turn.
    const tools = makeForgedTools([{ name: 123, params_json: '{}', code: '' }])
    expect(tools).toHaveLength(1)
    expect((tools[0] as any).name).toBe('my_123')
    expect((tools[0] as any).name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })
})

describe('buildDynamicTools — sanitize + dedupe (user-controlled operationIds)', () => {
  it('sanitizes unusable names and dedupes with first occurrence winning', () => {
    const tools = buildDynamicTools([
      { name: 'get weather/now', worker: 'https://api.example.com' }, // sanitized
      { name: 'get_weather_now', worker: 'https://other.example.com' }, // dupe after sanitize → dropped
      { name: '///', worker: 'https://x.example.com' }, // sanitizes to underscores, kept
      { name: null }, // dropped
    ])
    const names = tools.map((t: any) => t.name)
    expect(names).toContain('get_weather_now')
    expect(names.filter((n: string) => n === 'get_weather_now')).toHaveLength(1)
  })

  it('rejects non-public worker URLs at call time (SSRF guard)', async () => {
    const tools = buildDynamicTools([{ name: 'probe', worker: 'http://169.254.169.254/latest' }])
    const out = await (tools[0] as any).invoke({})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/worker URL rejected/)
  })

  it('returns a note instead of fetching when no worker is bound', async () => {
    const tools = buildDynamicTools([{ name: 'unbound' }])
    const out = await (tools[0] as any).invoke({})
    expect(out.ok).toBe(true)
    expect(String(out.note)).toMatch(/no worker bound/)
  })
})

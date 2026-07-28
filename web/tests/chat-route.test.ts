// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * Handler-level smoke tests for POST /api/chat — the request-validation
 * seam before any worker/provider I/O. The route module imports edge-ish
 * deps (@vercel/kv, strands) that load fine under node; the rate-limit
 * block self-skips without KV_REST_API_URL env.
 */
import { POST } from '../app/api/chat/route'

const call = (body: string | object, headers: Record<string, string> = {}) =>
  POST(new Request('https://tiny.technology/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

afterEach(() => vi.restoreAllMocks())

describe('POST /api/chat input validation', () => {
  it('malformed JSON → 400, not a 500', async () => {
    const res = await call('{not json')
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('messages')
  })

  it('missing messages[] → 400', async () => {
    expect((await call({})).status).toBe(400)
    expect((await call({ messages: 'not-an-array' })).status).toBe(400)
    expect((await call({ messages: [] })).status).toBe(400)
  })

  it('array of only garbage elements → 400, not a 500 (m.role on null)', async () => {
    // [null] passes Array.isArray + length>0 but m.role would throw when the
    // system/conversation split runs (before the stream try/catch).
    expect((await call({ messages: [null] })).status).toBe(400)
    expect((await call({ messages: [null, 'x', 42, { content: 'no role' }] })).status).toBe(400)
  })

  it('encodes client-controlled tinyName in worker URLs (query injection)', async () => {
    const seen: string[] = []
    global.fetch = vi.fn(async (url: any) => {
      seen.push(String(url))
      return new Response('{}', { status: 200 })
    }) as any
    await call(
      { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
      {
        'x-tiny-name': 'x&userId=victim-id',
        'x-tiny-model-provider': 'openai',
        'x-tiny-model-api-key': 'test-key-not-real',
      }
    )
    const getUrl = seen.find((u) => u.includes('/get?name='))
    expect(getUrl).toBeTruthy()
    // The & must be percent-encoded — a raw &userId= would ride the
    // internal-key channel as an authorized param
    expect(getUrl).toContain('name=x%26userId%3Dvictim-id')
    expect(getUrl!.split('userId=').length - 1).toBeLessThanOrEqual(1)
  })

  it('valid body proceeds past validation (reaches context fetches)', async () => {
    // Stub fetch so the parallel worker fetches don't hit the network.
    // BYOK headers keep the model layer env-independent (CI has no
    // OPENAI_API_KEY): createModel accepts the provided key, and the
    // stubbed provider response ends the turn quickly.
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as any
    const res = await call(
      { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
      {
        'x-tiny-name': 'tiny',
        'x-tiny-model-provider': 'openai',
        'x-tiny-model-api-key': 'test-key-not-real',
      }
    )
    expect(res.status).not.toBe(400)
  })

  it('no model key configured → streamed error event, not a 500', async () => {
    // Provider with no env fallback (vercel → AI_GATEWAY_API_KEY, unset in
    // CI/local) and no BYOK header: preflight must produce a friendly SSE
    // error, never a crash. Env-independent — unlike openai/google which
    // pick up .env.local keys Vitest auto-loads.
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as any
    const res = await call(
      { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
      { 'x-tiny-name': 'tiny', 'x-tiny-model-provider': 'vercel' }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"type":"error"')
    expect(text).toContain('No API key configured')
  })
})

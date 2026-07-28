// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { http } from '../tools/http'

// Drive the tool via the SDK's invoke(); stub global fetch so no network runs.
const run = (input: any) => (http as any).invoke(input)

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

function stubFetch(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  let i = 0
  global.fetch = vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)]
    return new Response(r.body ?? '{}', {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers || {}) },
    })
  }) as any
}

describe('http tool — SSRF guard', () => {
  it.each([
    'http://example.com/insecure',
    'https://localhost/admin',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://backend.internal/api',
    'not a url',
  ])('rejects %s without fetching', async (url) => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const out = await run({ method: 'GET', url })
    expect(out.ok).toBeFalsy()
    expect(String(out.error)).toMatch(/rejected|Invalid/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('allows public https and returns the parsed body', async () => {
    stubFetch([{ status: 200, body: '{"hello":"world"}' }])
    const out = await run({ method: 'GET', url: 'https://api.example.com/data' })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ hello: 'world' })
  })

  it('blocks redirects to internal hosts (the classic bypass)', async () => {
    stubFetch([
      { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } },
    ])
    const out = await run({ method: 'GET', url: 'https://public.example.com/redirect' })
    expect(out.ok).toBeFalsy()
    expect(String(out.error)).toMatch(/Redirect rejected/)
  })

  it('follows public→public redirects (bounded hops)', async () => {
    stubFetch([
      { status: 302, headers: { location: 'https://cdn.example.com/final' } },
      { status: 200, body: '{"moved":"ok"}' },
    ])
    const out = await run({ method: 'GET', url: 'https://public.example.com/start' })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ moved: 'ok' })
  })

  it('resolves relative redirect locations against the current URL', async () => {
    stubFetch([
      { status: 301, headers: { location: '/v2/resource' } },
      { status: 200, body: '{"v":"2"}' },
    ])
    const out = await run({ method: 'GET', url: 'https://api.example.com/v1/resource' })
    expect(out.status).toBe(200)
    expect((global.fetch as any).mock.calls[1][0]).toContain('https://api.example.com/v2/resource')
  })

  it('clips an oversized text body (memory guard)', async () => {
    const huge = 'y'.repeat(500_000)
    stubFetch([{ status: 200, body: huge, headers: { 'content-type': 'text/plain' } }])
    const out = await run({ method: 'GET', url: 'https://example.com/big.txt' })
    expect(typeof out.body).toBe('string')
    expect(out.body.length).toBeLessThanOrEqual(200_000 + 20)
    expect(out.body).toContain('…[truncated]')
  })

  it('small JSON still parses to an object', async () => {
    stubFetch([{ status: 200, body: '{"ok":true,"n":7}' }])
    const out = await run({ method: 'GET', url: 'https://example.com/api' })
    expect(out.body).toEqual({ ok: true, n: 7 })
  })

  it('binary content-type reports size without buffering a string', async () => {
    stubFetch([{ status: 200, body: 'binarystuff', headers: { 'content-type': 'application/octet-stream', 'content-length': '999999' } }])
    const out = await run({ method: 'GET', url: 'https://example.com/file.bin' })
    expect(String(out.body)).toContain('Binary data')
  })
})

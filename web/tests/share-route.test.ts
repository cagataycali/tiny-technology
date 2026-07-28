// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'

import { GET as getShare } from '../app/api/share/route'

afterEach(() => vi.restoreAllMocks())

describe('GET /api/share?id= — CDN cache is status-aware', () => {
  it('a 200 hit rides the 5-minute public cache', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'abc', messages: [] }), { status: 200 })
    ) as any
    const res = await getShare(new Request('https://tiny.technology/api/share?id=abc'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
  })

  it('a 404 (not found / just revoked) is never cached', async () => {
    // Without no-store the CDN would pin "gone" for 5 minutes — a revoked
    // share stays dead, and a share that goes live right after stays 404.
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    ) as any
    const res = await getShare(new Request('https://tiny.technology/api/share?id=missing'))
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('a worker 5xx is never cached', async () => {
    global.fetch = vi.fn(async () =>
      new Response('upstream error', { status: 502 })
    ) as any
    const res = await getShare(new Request('https://tiny.technology/api/share?id=boom'))
    expect(res.status).toBe(502)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

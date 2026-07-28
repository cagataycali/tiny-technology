// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'

beforeAll(() => { process.env.INTERNAL_API_KEY = 'test-internal-key' })
const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

import { POST } from '../app/api/job-run/route'

const post = (body: string | object | null, key?: string) =>
  POST(new Request('https://tiny.technology/api/job-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key !== undefined ? { 'x-internal-key': key } : {}) },
    body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/job-run — internal autonomous executor', () => {
  it('rejects requests without the internal key (before any body read)', async () => {
    expect((await post({ prompt: 'do a thing' })).status).toBe(401)
    expect((await post({ prompt: 'x' }, 'wrong-key')).status).toBe(401)
  })

  it('authorized + malformed body → 400, not an unhandled 500', async () => {
    const res = await post('{bad json', 'test-internal-key')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/prompt required/)
  })

  it('authorized + missing/non-string prompt → 400', async () => {
    expect((await post({}, 'test-internal-key')).status).toBe(400)
    expect((await post({ tiny: 't' }, 'test-internal-key')).status).toBe(400)
    expect((await post({ prompt: 42 }, 'test-internal-key')).status).toBe(400)
  })

  it('provider misconfigured (env selects a provider whose key is absent) → clean ok:false, no fan-out', async () => {
    // vercel provider has no key fallback in test env — preflight must trip
    // BEFORE any worker fetches (the fetch spy stays uncalled)
    process.env.TINY_MODEL_PROVIDER = 'vercel'
    delete process.env.AI_GATEWAY_API_KEY
    const spy = vi.fn()
    global.fetch = spy as any
    try {
      const res = await post({ prompt: 'do a thing', tiny: 't', userId: 'u1' }, 'test-internal-key')
      const data = await res.json()
      expect(data.ok).toBe(false)
      expect(data.error).toMatch(/misconfigured/)
      expect(data.error).toMatch(/No API key configured/)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      delete process.env.TINY_MODEL_PROVIDER
    }
  })
})

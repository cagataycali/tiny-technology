// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 🏅 /api/control — ORDER of the auth check and the rate limiter (loop item
 * c8-followup). The save path is the login wall the user actually reported, so
 * it now keys its window on the signed-in caller. That makes the ORDER
 * load-bearing in two directions:
 *
 *   1. the limiter must run AFTER the 401 — an unauthenticated client looping
 *      this endpoint has no session, so it would be IP-keyed, and every builder
 *      behind that same office/CGNAT egress would lose their allowance to it;
 *   2. it must still run BEFORE the worker fetch, or the window protects nothing.
 */
const limitMock = vi.fn()
const sessionMock = vi.fn()
vi.mock('@/lib/rate-limit', () => ({ enforceIpDailyLimit: (...a: any[]) => limitMock(...a) }))
vi.mock('@/lib/auth', () => ({ getSession: (...a: any[]) => sessionMock(...a) }))

import { POST as control } from '../app/api/control/route'

const post = (body: any) =>
  new Request('https://tiny.technology/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  limitMock.mockReset()
  sessionMock.mockReset()
  limitMock.mockResolvedValue(null)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ response: 'ok' }))))
})

describe('POST /api/control — the 401 comes first', () => {
  it('an unauthenticated save 401s WITHOUT consuming a limiter slot', async () => {
    sessionMock.mockResolvedValue(null)
    const res = await control(post({ name: 'my-tiny' }))
    expect(res.status).toBe(401)
    expect(limitMock).not.toHaveBeenCalled()
  })

  it('a missing name 400s without consuming a slot either', async () => {
    // Validation rejects before either the session read or the limiter.
    sessionMock.mockResolvedValue({ sub: 'u1' })
    const res = await control(post({}))
    expect(res.status).toBe(400)
    expect(limitMock).not.toHaveBeenCalled()
  })

  it('a signed-in save is limited on its OWN identity, not the shared IP', async () => {
    sessionMock.mockResolvedValue({ sub: 'u1', login: 'builder' })
    await control(post({ name: 'my-tiny' }))
    expect(limitMock).toHaveBeenCalledTimes(1)
    expect(limitMock.mock.calls[0][1]).toMatchObject({ userId: 'u1' })
    // 'platform' by default: the resource spent is our storage + re-index, and
    // the artifact is the caller's own, so standing may widen it.
    expect(limitMock.mock.calls[0][1].cost).toBeUndefined()
  })

  it('a legacy-key (sessionless) save still passes auth and IS limited', async () => {
    // Pre-migration tinys authorize by key; no session means no userId, so the
    // window falls back to the IP exactly as it did before c8.
    sessionMock.mockResolvedValue(null)
    await control(post({ name: 'my-tiny', key: 'legacy-secret' }))
    expect(limitMock).toHaveBeenCalledTimes(1)
    expect(limitMock.mock.calls[0][1].userId).toBeUndefined()
  })

  it('the limiter still runs BEFORE the upsert — a 429 never reaches the worker', async () => {
    sessionMock.mockResolvedValue({ sub: 'u1' })
    limitMock.mockResolvedValue(new Response('over', { status: 429 }))
    const res = await control(post({ name: 'my-tiny' }))
    expect(res.status).toBe(429)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

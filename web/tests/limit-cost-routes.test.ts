// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 💸 The routes whose limiter protects SOMEONE ELSE must declare cost: 'others'
 * (loop item c8-followup). These assertions exist because the tempting cleanup
 * — "c8 added userId to the limiter, let's do the rest for consistency" — is a
 * privilege escalation on these three: it would let anyone with standing (or
 * with N free accounts) aim more traffic at a stranger's notification ring or
 * at a stranger's server. Pinning the annotation at the call site keeps the
 * reasoning attached to the code rather than only to a comment.
 */
const limitMock = vi.fn()
vi.mock('@/lib/rate-limit', () => ({ enforceIpDailyLimit: (...a: any[]) => limitMock(...a) }))
vi.mock('@/lib/auth', () => ({ getSession: async () => ({ sub: 'famous', login: 'famous' }) }))

import { POST as visit } from '../app/api/visit/route'
import { POST as worker } from '../app/api/worker/route'

const post = (url: string, body: any) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  limitMock.mockReset()
  limitMock.mockResolvedValue(null)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})

describe("cost: 'others' at the call sites", () => {
  it("/api/visit protects the TARGET owner's event ring — never widened by the visitor's standing", async () => {
    await visit(post('https://tiny.technology/api/visit', { name: 'someone-else' }))
    expect(limitMock).toHaveBeenCalledTimes(1)
    const opts = limitMock.mock.calls[0][1]
    expect(opts.cost).toBe('others')
    // Even though this route DOES read the session (to name the visitor in the
    // notification), that identity must not reach the limiter.
    expect(opts.userId).toBeUndefined()
  })

  it('/api/worker aims OUR egress at a caller-supplied URL — IP-keyed, base allowance', async () => {
    await worker(post('https://tiny.technology/api/worker', {
      name: 'x', worker: 'https://example.com/openapi.json',
    }))
    expect(limitMock).toHaveBeenCalledTimes(1)
    const opts = limitMock.mock.calls[0][1]
    expect(opts.cost).toBe('others')
    expect(opts.userId).toBeUndefined()
  })

  it('/api/visit limits BEFORE forwarding — a 429 never touches the owner’s ring', async () => {
    limitMock.mockResolvedValue(new Response('{}', { status: 429 }))
    const res = await visit(post('https://tiny.technology/api/visit', { name: 'someone-else' }))
    expect(res.status).toBe(429)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

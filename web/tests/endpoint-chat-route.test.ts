// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/devices/endpoint/chat — the session door to one agent turn on an
 * endpoint device (robot arm, printer). Invariants:
 *   - session required; userId travels from the SESSION only
 *   - action is pinned to 'chat' — a body cannot pick another worker action
 *   - the worker's typed failures (unreachable / timeout / unauthorized) survive
 *   - {result:{reply}} / {result:"…"} both come back as a string result
 */
const sessionMock = vi.fn()
vi.mock('@/lib/auth', () => ({ getSession: (...a: any[]) => sessionMock(...a) }))

import { POST } from '../app/api/devices/endpoint/chat/route'

const req = (body: any) =>
  new Request('https://tiny.technology/api/devices/endpoint/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  sessionMock.mockReset()
  sessionMock.mockResolvedValue({ sub: 'owner-1', login: 'owner' })
})

describe('POST /api/devices/endpoint/chat', () => {
  it('401 without a session, 400 without deviceId+prompt', async () => {
    sessionMock.mockResolvedValueOnce(null)
    expect((await POST(req({ deviceId: 'd', prompt: 'hi' }))).status).toBe(401)
    expect((await POST(req({ deviceId: 'd' }))).status).toBe(400)
    expect((await POST(req({ prompt: 'hi' }))).status).toBe(400)
  })

  it('dials the worker with action=chat and the SESSION userId; unwraps {reply}', async () => {
    let sentBody: any
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ result: { reply: 'tilt is 95.4°' } }), { status: 200 })
    }))
    const res = await POST(req({ deviceId: 'arm-1', prompt: 'tilt?', userId: 'victim', action: 'snapshot' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: 'tilt is 95.4°' })
    expect(sentBody).toMatchObject({ userId: 'owner-1', deviceId: 'arm-1', action: 'chat', prompt: 'tilt?' })
  })

  it('a plain string result passes through unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: 'done' }), { status: 200 })))
    expect((await (await POST(req({ deviceId: 'd', prompt: 'p' }))).json()).result).toBe('done')
  })

  it('keeps the worker’s typed failure apart: timeout is not unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'still thinking', timeout: true }), { status: 504 })))
    const res = await POST(req({ deviceId: 'd', prompt: 'p' }))
    expect(res.status).toBe(504)
    expect(await res.json()).toMatchObject({ ok: false, timeout: true, error: 'still thinking' })
  })

  it('an aborted worker call is reported as timeout, a refused connection as retryable 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted due to timeout') }))
    expect((await POST(req({ deviceId: 'd', prompt: 'p' }))).status).toBe(504)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const res = await POST(req({ deviceId: 'd', prompt: 'p' }))
    expect(res.status).toBe(503)
    expect((await res.json()).retryable).toBe(true)
  })
})

// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'

import { POST } from '../app/api/devices/transcript/route'

/**
 * /api/devices/transcript — the proxy the paired phone POSTs its transcript to
 * (relay-route.test.ts pattern). The invariants worth pinning:
 *   - device-credential auth, NO session: the phone may have nobody logged in
 *   - a spoofed userId in the body is never forwarded — the worker resolves
 *     the owner from the device token, so the field must not even travel
 *   - bad input is a 400 before the worker is touched; a worker 401 passes
 *     through as 401 (revoked device), everything else fails as 424
 */
const req = (body: string | object) =>
  new Request('https://tiny.technology/api/devices/transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

afterEach(() => vi.restoreAllMocks())

describe('POST /api/devices/transcript — device transcript passthrough', () => {
  it('forwards deviceId+token+text on device credentials alone — no session, no cookie', async () => {
    let sentUrl = ''
    let sentBody: any
    global.fetch = vi.fn(async (url: any, init: any) => {
      sentUrl = String(url)
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, id: 'tr-1' }), { status: 200 })
    }) as any
    const res = await POST(req({
      deviceId: 'd1', token: 'tind_x', text: 'buy milk tomorrow',
      label: 'wake: alexa', audioUrl: 'https://media.example/a.m4a', durationS: 12,
    }))
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('tr-1') // the phone needs the id for its relay reply
    expect(sentUrl).toContain('/transcript')
    expect(sentBody).toMatchObject({
      deviceId: 'd1', token: 'tind_x', text: 'buy milk tomorrow',
      label: 'wake: alexa', audioUrl: 'https://media.example/a.m4a', durationS: 12,
    })
  })

  it('a spoofed userId is NOT forwarded — the token resolves the owner', async () => {
    let sentBody: any
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, id: 'tr-2' }), { status: 200 })
    }) as any
    const res = await POST(req({ deviceId: 'd1', token: 't', text: 'hi', userId: 'HACKER' }))
    expect(res.status).toBe(200)
    expect(sentBody).not.toHaveProperty('userId')
  })

  it('missing token → 400, worker untouched', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    expect((await POST(req({ deviceId: 'd1', text: 'hi' }))).status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('blank text → 400 — an empty transcript is a client bug, not a row', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    expect((await POST(req({ deviceId: 'd1', token: 't', text: '   ' }))).status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('malformed body → 400, not a 500', async () => {
    global.fetch = vi.fn() as any
    expect((await POST(req('{invalid json'))).status).toBe(400)
  })

  it('bad token → 401 passthrough (revoked phone must learn to stop posting)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'unknown device' }), { status: 401 })) as any
    expect((await POST(req({ deviceId: 'd1', token: 'bad', text: 'hi' }))).status).toBe(401)
  })

  it('registry unreachable → 424', async () => {
    global.fetch = vi.fn(async () => { throw new Error('boom') }) as any
    expect((await POST(req({ deviceId: 'd1', token: 't', text: 'hi' }))).status).toBe(424)
  })
})

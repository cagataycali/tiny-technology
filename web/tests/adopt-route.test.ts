// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * /api/devices/adopt — take over a device you already own from a new client.
 *
 * This route issues a CREDENTIAL, so the invariants below are the whole point
 * of it existing rather than incidental details:
 *   - session required, and the userId is taken from the SESSION only. A body
 *     userId must never travel, or a known device id would be enough to adopt
 *     someone else's hardware.
 *   - never report success without a token. The client stores whatever comes
 *     back in the Keychain and heartbeats with it, so {ok:true} carrying
 *     undefined installs a credential that authenticates nothing — and the
 *     failure would surface much later as an unexplained offline device.
 *   - a worker 404 stays a 404. "Not yours / revoked / endpoint" needs a
 *     different response from the caller (enroll it fresh) than an outage does
 *     (retry), so collapsing them would send the user down the destructive path.
 */
const sessionMock = vi.fn()
vi.mock('@/lib/auth', () => ({ getSession: (...a: any[]) => sessionMock(...a) }))

import { POST } from '../app/api/devices/adopt/route'

const req = (body: any) =>
  new Request('https://tiny.technology/api/devices/adopt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  sessionMock.mockReset()
  sessionMock.mockResolvedValue({ sub: 'owner-1', login: 'owner' })
})

describe('POST /api/devices/adopt — rotate a device token for a new client', () => {
  it('forwards the SESSION userId and returns the new token', async () => {
    let sentUrl = ''
    let sentBody: any
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      sentUrl = String(url)
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, device_id: 'd1', device_token: 'tind_new' }), { status: 200 })
    }))
    const res = await POST(req({ deviceId: 'd1' }))
    expect(res.status).toBe(200)
    expect((await res.json()).device_token).toBe('tind_new')
    expect(sentUrl).toContain('/device/rotate-token')
    expect(sentBody).toMatchObject({ userId: 'owner-1', deviceId: 'd1' })
  })

  it('ignores a userId in the body — ownership is never caller-supplied', async () => {
    let sentBody: any
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, device_id: 'd1', device_token: 'tind_new' }), { status: 200 })
    }))
    await POST(req({ deviceId: 'd1', userId: 'victim' }))
    // The attacker's value must not even travel — the worker scopes the UPDATE
    // on (id, user_id), so forwarding it would hand over the whole check.
    expect(sentBody.userId).toBe('owner-1')
  })

  it('requires a session', async () => {
    sessionMock.mockResolvedValue(null)
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const res = await POST(req({ deviceId: 'd1' }))
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled() // no worker call on an unauthenticated ask
  })

  it('requires a deviceId, before touching the worker', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('passes a worker 404 through as 404 (not yours / revoked / endpoint)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'device not found' }), { status: 404 })))
    const res = await POST(req({ deviceId: 'nope' }))
    expect(res.status).toBe(404)
    expect((await res.json()).ok).toBe(false)
  })

  it('refuses to report success when the worker returns no token', async () => {
    // A 200 with a missing token is the dangerous shape: it looks like success
    // to every gate that only checks res.ok.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, device_id: 'd1' }), { status: 200 })))
    const res = await POST(req({ deviceId: 'd1' }))
    expect(res.status).toBe(424)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.device_token).toBeUndefined()
  })

  it('a non-JSON worker error is still a failure, not a masked success', async () => {
    // An HTML 502 parses to {} via .json().catch(() => ({})) — no `error` key —
    // so a gate that only reads data.error would report a clean adoption.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })))
    const res = await POST(req({ deviceId: 'd1' }))
    expect(res.status).toBe(424)
    expect((await res.json()).ok).toBe(false)
  })

  it('an unreachable worker is retryable, not a permanent failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    const res = await POST(req({ deviceId: 'd1' }))
    expect(res.status).toBe(503)
    expect((await res.json()).retryable).toBe(true)
  })
})

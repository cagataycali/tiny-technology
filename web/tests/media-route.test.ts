// @vitest-environment node
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'

beforeAll(() => { process.env.AUTH_JWT_SECRET = 'test-secret' })

import { POST } from '../app/api/media/route'
import { issueSession } from '../lib/auth'

/**
 * /api/media — the two ways to be allowed to upload, and the one rule both obey:
 * the CALLER NEVER NAMES THE OWNER.
 *
 * A browser/phone uploads with a session and the proxy stamps session.sub. The
 * tiny necklace has no session — it's a camera on a chain with 16MB of flash
 * anyone who picks it up can read — so it sends {deviceId, token} and the
 * worker resolves the owner from the token's stored hash. Neither path lets a
 * request assert whose account a photo lands in.
 */
const body = (extra: object = {}) => ({
  data: Buffer.from('jpegbytes').toString('base64'),
  contentType: 'image/jpeg',
  ...extra,
})

const req = (b: object | string, cookie?: string) =>
  new Request('https://tiny.technology/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: typeof b === 'string' ? b : JSON.stringify(b),
  })

const auth = async () => `tiny_session=${await issueSession({ sub: 'u1', login: 'me' })}`

/** Capture what the proxy forwarded to the worker. */
function spyWorker(res: object = { ok: true, key: 'k.jpg', url: 'https://x/media/k.jpg', bytes: 8 }) {
  const seen: any = {}
  global.fetch = vi.fn(async (_url: any, init: any) => {
    seen.body = JSON.parse(init.body)
    seen.headers = init.headers
    return new Response(JSON.stringify(res), { status: 200 })
  }) as any
  return seen
}

afterEach(() => vi.restoreAllMocks())

describe('POST /api/media — session upload', () => {
  it('anonymous with no device credentials → 401, worker never touched', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    const res = await POST(req(body()))
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('stamps the SESSION userId, ignoring any the client sends', async () => {
    const seen = spyWorker()
    const res = await POST(req(body({ userId: 'someone-else' }), await auth()))
    expect(res.status).toBe(200)
    expect(seen.body.userId).toBe('u1')
    expect(seen.body.deviceId).toBeUndefined()
  })
})

describe('POST /api/media — device upload (no session)', () => {
  it('forwards deviceId+token and NO userId — the worker decides the owner', async () => {
    const seen = spyWorker()
    const res = await POST(req(body({ deviceId: 'neck-1', token: 'tind_abc' })))
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe('https://x/media/k.jpg')
    expect(seen.body.deviceId).toBe('neck-1')
    expect(seen.body.token).toBe('tind_abc')
    // The whole point: no userId travels with a device upload, so a device
    // cannot attribute a photo to an account it doesn't belong to.
    expect(seen.body.userId).toBeUndefined()
  })

  it('a device claiming a userId TOO still gets no userId forwarded', async () => {
    const seen = spyWorker()
    await POST(req(body({ deviceId: 'neck-1', token: 'tind_abc', userId: 'victim' })))
    expect(seen.body.userId).toBeUndefined()
    expect(seen.body.deviceId).toBe('neck-1')
  })

  it('half a device credential is not a device — falls back to the session gate', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    // deviceId alone (no token) must NOT open an unauthenticated path.
    expect((await POST(req(body({ deviceId: 'neck-1' })))).status).toBe(401)
    expect((await POST(req(body({ token: 'tind_abc' })))).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it("a revoked device's 'unknown device' surfaces as 401, not a retryable 424", async () => {
    // A necklace that keeps its token after revoke would loop forever on a
    // 424 ("registry unreachable, try again"). 401 tells it to stop.
    spyWorker({ error: 'unknown device' })
    const res = await POST(req(body({ deviceId: 'neck-lost', token: 'tind_old' })))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unknown device')
  })

  it('a genuine worker outage is still 424 for a device', async () => {
    spyWorker({ error: 'media store not provisioned' })
    const res = await POST(req(body({ deviceId: 'neck-1', token: 'tind_abc' })))
    expect(res.status).toBe(424)
  })
})

describe('POST /api/media — shared validation', () => {
  it('a device still must send data and contentType', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    const res = await POST(req({ deviceId: 'neck-1', token: 'tind_abc' }))
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('unparseable JSON → 401 (no credentials found), never a crash', async () => {
    global.fetch = vi.fn() as any
    const res = await POST(req('{not json'))
    expect(res.status).toBe(401)
  })
})

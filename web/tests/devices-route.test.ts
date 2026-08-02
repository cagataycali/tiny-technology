// @vitest-environment node
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'

beforeAll(() => { process.env.AUTH_JWT_SECRET = 'test-secret' })

import { GET, POST, DELETE } from '../app/api/devices/route'
import { POST as heartbeat } from '../app/api/devices/heartbeat/route'
import { issueSession } from '../lib/auth'

const req = (method: string, body: string | object | null, cookie?: string) =>
  new Request('https://tiny.technology/api/devices', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })

const auth = async () => `tiny_session=${await issueSession({ sub: 'u1', login: 'me' })}`

afterEach(() => vi.restoreAllMocks())

describe('GET /api/devices — session gate', () => {
  it('anonymous → 401, never touches the worker', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    const res = await GET(req('GET', null))
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('authenticated → lists devices scoped to the SESSION userId (not a client param)', async () => {
    let sentUrl = ''
    global.fetch = vi.fn(async (url: any) => {
      sentUrl = String(url)
      return new Response(JSON.stringify({ devices: [{ id: 'd1', online: true }] }), { status: 200 })
    }) as any
    const res = await GET(req('GET', null, await auth()))
    expect(res.status).toBe(200)
    expect((await res.json()).devices).toHaveLength(1)
    // userId is the session sub, appended by the proxy — client cannot spoof it
    expect(sentUrl).toContain('userId=u1')
  })

  it('worker error surfaces as 424, not a false-empty 200', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'no such table: devices' }), { status: 200 })
    ) as any
    const res = await GET(req('GET', null, await auth()))
    expect(res.status).toBe(424)
  })
})

describe('POST /api/devices — enroll', () => {
  it('anonymous → 401 before body parse', async () => {
    const res = await POST(req('POST', { name: 'laptop' }))
    expect(res.status).toBe(401)
  })

  it('missing/blank name → 400, never reaches the worker', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    const res = await POST(req('POST', { name: '   ' }, await auth()))
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('forwards the SESSION userId (not the client body) and returns the token once', async () => {
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ device_id: 'd1', device_token: 'tind_secret' }), { status: 200 })
    }) as any
    const res = await POST(req('POST', { name: 'laptop', kind: 'daemon', userId: 'attacker' }, await auth()))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.device_token).toBe('tind_secret')
    expect(sentBody.userId).toBe('u1') // from session, spoofed userId ignored
    // capabilities are sent as a JSON string (itty body rule)
    expect(typeof sentBody.capabilities).toBe('string')
  })
})

describe('DELETE /api/devices — revoke', () => {
  it('anonymous → 401', async () => {
    const res = await DELETE(req('DELETE', { deviceId: 'd1' }))
    expect(res.status).toBe(401)
  })

  it('missing deviceId → 400', async () => {
    const res = await DELETE(req('DELETE', {}, await auth()))
    expect(res.status).toBe(400)
  })

  it('forwards session userId + deviceId to the worker', async () => {
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ revoked: 1 }), { status: 200 })
    }) as any
    const res = await DELETE(req('DELETE', { deviceId: 'd1' }, await auth()))
    expect(res.status).toBe(200)
    expect(sentBody.userId).toBe('u1')
    expect(sentBody.deviceId).toBe('d1')
  })
})

describe('POST /api/devices/heartbeat — device token, no session', () => {
  it('missing deviceId/token → 400, never reaches the worker', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    const res = await heartbeat(req('POST', { deviceId: 'd1' }))
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('unknown/revoked device → 401 passthrough (worker is the gate)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'unknown device' }), { status: 401 })
    ) as any
    const res = await heartbeat(req('POST', { deviceId: 'd1', token: 'tind_wrong' }))
    expect(res.status).toBe(401)
  })

  it('valid heartbeat → 200 ok, forwards token + normalized capabilities', async () => {
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any
    const res = await heartbeat(req('POST', { deviceId: 'd1', token: 'tind_ok', capabilities: ['shell'] }))
    expect(res.status).toBe(200)
    expect(sentBody.deviceId).toBe('d1')
    expect(sentBody.token).toBe('tind_ok')
    expect(typeof sentBody.capabilities).toBe('string') // JSON string per itty rule
  })

  /**
   * 🏠 lanUrl — the same-WiFi fast path, which was dead in production because of
   * this hop alone.
   *
   * The firmware sends it on every beat and the worker validates and stores it;
   * both have tests. This route destructured `{deviceId, token, capabilities}`
   * and dropped it silently, so every device row held lan_url='' and the app had
   * no address to dial — "says connecting through the cloud but i'm at the same
   * wifi". Nothing errors: the heartbeat is a perfectly good 200 either way,
   * which is why the tests on both ENDS could pass while the feature never
   * worked. A proxy field is only real if the proxy is asked about it.
   */
  it('forwards lanUrl — without this the LAN fast path is dead in production', async () => {
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any
    const res = await heartbeat(req('POST', {
      deviceId: 'd1', token: 'tind_ok', lanUrl: 'http://192.168.1.207:8080',
    }))
    expect(res.status).toBe(200)
    expect(sentBody.lanUrl, 'the proxy dropped lanUrl, so lan_url stays empty forever')
      .toBe('http://192.168.1.207:8080')
  })

  it('an absent lanUrl is OMITTED, not sent as empty — COALESCE must keep the stored one', async () => {
    // The worker does `lan_url = COALESCE(?5, lan_url)`. Sending '' here would
    // satisfy COALESCE and overwrite a good address with a blank, 2880 times a
    // day — worse than never forwarding, because it erases what worked.
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any
    for (const beat of [{}, { lanUrl: '' }, { lanUrl: '   ' }, { lanUrl: null }]) {
      await heartbeat(req('POST', { deviceId: 'd1', token: 'tind_ok', ...beat }))
      expect(sentBody, JSON.stringify(beat)).not.toHaveProperty('lanUrl')
    }
  })

  it('a hostile lanUrl is forwarded UNVALIDATED — the worker is the single guard', async () => {
    // Deliberate: validateLanUrl lives in the worker and refuses public IPs,
    // hostnames and loopback. Re-implementing that check here would give the
    // feature two definitions of "private" that can drift apart, and the worker
    // drops a bad value without failing the beat. Pinned so a future "defensive"
    // filter here is a conscious choice rather than a silent second gate.
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any
    await heartbeat(req('POST', { deviceId: 'd1', token: 'tind_ok', lanUrl: 'http://8.8.8.8:8080' }))
    expect(sentBody.lanUrl).toBe('http://8.8.8.8:8080')
  })
})

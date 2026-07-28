// @vitest-environment node
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'

beforeAll(() => { process.env.AUTH_JWT_SECRET = 'test-secret' })

import { POST, GET, PUT, PATCH } from '../app/api/devices/relay/route'
import { issueSession } from '../lib/auth'

const req = (method: string, body: string | object | null, cookie?: string, qs = '') =>
  new Request(`https://tiny.technology/api/devices/relay${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })

const auth = async () => `tiny_session=${await issueSession({ sub: 'u1', login: 'me' })}`

afterEach(() => vi.restoreAllMocks())

describe('POST /api/devices/relay — session send', () => {
  it('anonymous → 401, worker untouched', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    expect((await POST(req('POST', { toDevice: 'd1', payload: {} }))).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('userId comes from the SESSION, payload stringified for itty', async () => {
    let sentBody: any
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, id: 'env-1' }), { status: 200 })
    }) as any
    const res = await POST(req('POST', { toDevice: 'd1', payload: { type: 'invoke', prompt: 'hi' }, userId: 'HACKER' }, await auth()))
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('env-1')
    expect(sentBody.userId).toBe('u1')                       // session wins, spoof ignored
    expect(typeof sentBody.payload).toBe('string')           // itty body rule
  })

  it('malformed body → 400, not a 500', async () => {
    global.fetch = vi.fn() as any
    const res = await POST(req('POST', '{invalid json', await auth()))
    expect(res.status).toBe(400)
  })

  it('unknown device → 404', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'device not found' }), { status: 200 })) as any
    expect((await POST(req('POST', { toDevice: 'nope', payload: {} }, await auth()))).status).toBe(404)
  })
})

describe('GET /api/devices/relay — session recv', () => {
  it('requires inReplyTo', async () => {
    global.fetch = vi.fn() as any
    expect((await GET(req('GET', null, await auth()))).status).toBe(400)
  })

  it('scopes to session userId and encodes params', async () => {
    let sentUrl = ''
    global.fetch = vi.fn(async (url: any) => {
      sentUrl = String(url)
      return new Response(JSON.stringify({ ok: true, reply: null }), { status: 200 })
    }) as any
    const res = await GET(req('GET', null, await auth(), '?inReplyTo=abc%26userId%3Dvictim'))
    expect(res.status).toBe(200)
    expect(sentUrl).toContain('userId=u1')
    // the decoded & from the crafted param must arrive ENCODED — no injection
    expect(sentUrl).toContain(encodeURIComponent('abc&userId=victim'))
  })
})

describe('PUT/PATCH — device verbs (token auth, no session)', () => {
  it('PUT without token → 400', async () => {
    global.fetch = vi.fn() as any
    expect((await PUT(req('PUT', { deviceId: 'd1' }))).status).toBe(400)
  })

  it('PUT with bad token → 401 passthrough', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 200 })) as any
    expect((await PUT(req('PUT', { deviceId: 'd1', token: 'bad' }))).status).toBe(401)
  })

  it('PATCH forwards reply with stringified payload', async () => {
    let sentBody: any
    global.fetch = vi.fn(async (_u: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any
    const res = await PATCH(req('PATCH', { deviceId: 'd1', token: 't', inReplyTo: 'env-1', payload: { result: '42' } }))
    expect(res.status).toBe(200)
    expect(typeof sentBody.payload).toBe('string')
  })
})

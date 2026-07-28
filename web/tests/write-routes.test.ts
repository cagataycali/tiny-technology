// @vitest-environment node
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'

beforeAll(() => { process.env.AUTH_JWT_SECRET = 'test-secret' })

import { DELETE as deleteTiny } from '../app/api/delete/route'
import { POST as control } from '../app/api/control/route'
import { POST as createJob } from '../app/api/jobs/route'
import { POST as trustOwner } from '../app/api/tools/trust/route'
import { POST as createShare } from '../app/api/share/route'
import { issueSession } from '../lib/auth'

const req = (method: string, body: string | object | null, cookie?: string) =>
  new Request('https://tiny.technology/x', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })

afterEach(() => vi.restoreAllMocks())

describe('DELETE /api/delete', () => {
  it('unauthenticated → 401 (before any body parse)', async () => {
    const res = await deleteTiny(req('DELETE', { name: 'victim' }))
    expect(res.status).toBe(401)
  })

  it('authenticated but malformed body → 400, not 500', async () => {
    const token = await issueSession({ sub: 'u1', login: 'me' })
    const res = await deleteTiny(req('DELETE', '{bad json', `tiny_session=${token}`))
    expect(res.status).toBe(400)
  })

  it('authenticated + missing name → 400', async () => {
    const token = await issueSession({ sub: 'u1', login: 'me' })
    const res = await deleteTiny(req('DELETE', {}, `tiny_session=${token}`))
    expect(res.status).toBe(400)
  })

  it('authenticated + valid name → forwards to worker with the session userId', async () => {
    const token = await issueSession({ sub: 'u1', login: 'me' })
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any
    const res = await deleteTiny(req('DELETE', { name: 'mine' }, `tiny_session=${token}`))
    expect(res.status).toBe(200)
    // userId comes from the SESSION, never the client body — no way to
    // delete another user's tiny by spoofing userId in the request
    expect(sentBody.userId).toBe('u1')
    expect(sentBody.name).toBe('mine')
  })
})

describe('POST /api/control', () => {
  it('malformed body → 400', async () => {
    const res = await control(req('POST', 'not json'))
    expect(res.status).toBe(400)
  })

  it('no session and no key → 401 login required', async () => {
    const res = await control(req('POST', { name: 'x', systemPrompt: 'hi' }))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/jobs — run_in_minutes validation', () => {
  const auth = async () => `tiny_session=${await issueSession({ sub: 'u1', login: 'me' })}`

  it('unauthenticated → 401', async () => {
    const res = await createJob(req('POST', { name: 'n', prompt: 'p', run_in_minutes: 5 }))
    expect(res.status).toBe(401)
  })

  it('rejects a truthy-but-non-numeric run_in_minutes (would store runAt=NaN)', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const res = await createJob(req('POST', { name: 'n', prompt: 'p', run_in_minutes: 'abc' }, await auth()))
    expect(res.status).toBe(400)
    // never reached the worker — rejected at the boundary
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a non-positive run_in_minutes', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const res = await createJob(req('POST', { name: 'n', prompt: 'p', run_in_minutes: 0 }, await auth()))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a valid run_in_minutes forwards a finite numeric runAt to the worker', async () => {
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, id: 'j1' }), { status: 200 })
    }) as any
    const res = await createJob(req('POST', { name: 'n', prompt: 'p', run_in_minutes: 10 }, await auth()))
    expect(res.status).toBe(200)
    expect(Number.isFinite(Number(sentBody.runAt))).toBe(true)
    expect(sentBody.userId).toBe('u1') // from session, not client
  })
})

describe('POST /api/tools/trust — owner validation + persist failure', () => {
  const auth = async () => `tiny_session=${await issueSession({ sub: 'u1', login: 'me' })}`

  it('unauthenticated → 401', async () => {
    const res = await trustOwner(req('POST', { owner: 'someone' }))
    expect(res.status).toBe(401)
  })

  it('rejects an invalid GitHub owner name → 400 (before any write)', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const res = await trustOwner(req('POST', { owner: 'bad name!!' }, await auth()))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports 502 (not a 200 false-success) when the prefs write fails', async () => {
    // readOwners GET succeeds (empty), the write POST returns non-ok.
    global.fetch = vi.fn(async (_url: any, init: any) => {
      if (init?.method === 'POST') return new Response('upstream boom', { status: 500 })
      return new Response(JSON.stringify({ value: '[]' }), { status: 200 })
    }) as any
    const res = await trustOwner(req('POST', { owner: 'octocat' }, await auth()))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.ok).toBeUndefined()
  })

  it('persists and echoes owners on success', async () => {
    global.fetch = vi.fn(async (_url: any, init: any) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response(JSON.stringify({ value: '[]' }), { status: 200 })
    }) as any
    const res = await trustOwner(req('POST', { owner: 'octocat' }, await auth()))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.owners).toContain('octocat')
  })
})

describe('POST /api/share — worker status passthrough (not blanket 502)', () => {
  it('surfaces a worker 400 (e.g. too large) AS 400, not 502', async () => {
    // Worker rejects with a 4xx + {error} and no id — the proxy must pass the
    // real status through, or a "too large" reads as a gateway failure.
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'messages must be JSON ≤ 256KB' }), { status: 400 })
    ) as any
    const res = await createShare(req('POST', { name: 't', messages: [{ id: '1', role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/256KB/)
  })

  it('a worker 5xx / non-id response still maps to 502', async () => {
    global.fetch = vi.fn(async () => new Response('<html>gateway</html>', { status: 503 })) as any
    const res = await createShare(req('POST', { name: 't', messages: [{ id: '1', role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(502) // no id + non-4xx → 502; bare .json() didn't throw
  })

  it('rejects an empty/garbage messages array before calling the worker', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    const res = await createShare(req('POST', { name: 't', messages: [null, 'x'] }))
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })
})

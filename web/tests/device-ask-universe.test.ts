// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('device-ask-universe')

/**
 * "THE UNIVERSE ON THE GLASS" — /device/ask's optional `tiny` field
 * (ANSWERS.md 2026-08-26). Invariants pinned here:
 *
 *   1. absent / "tiny" / the owner's own slug → OWNER mode: job-run receives
 *      {userId, tiny, prompt} exactly as before (byte-identical for absent).
 *   2. a PUBLIC universe slug → UNIVERSE mode: job-run receives {tiny, prompt}
 *      with NO userId — a foreign persona never wields the owner's tools.
 *   3. private and unknown slugs get THE SAME 404 sentence (no oracle).
 *   4. oversize raw input → 400; garbage that slugifies to nothing → 404.
 *   5. a priced tiny → 402 with a sentence (no unconfirmed device debits).
 *   6. universe attribution: visited edge person→tiny + both owners' events.
 */

// ── mock plumbing ──────────────────────────────────────────────────────────
/** D1 stub routed by SQL substring. Records every bind for assertions. */
function makeDB(routes: Array<{ match: string; row?: any }>) {
  const calls: Array<{ sql: string; binds: any[] }> = []
  return {
    calls,
    batch: async (stmts: any[]) => stmts.map(() => ({})),
    prepare(sql: string) {
      return {
        bind(...binds: any[]) {
          calls.push({ sql, binds })
          const hit = routes.find(r => sql.includes(r.match))
          return {
            first: async () => (hit ? hit.row ?? null : null),
            run: async () => ({}),
          }
        },
      }
    },
  }
}

const makeEnv = (opts: {
  kv?: Record<string, any>
  tinysOwner?: Record<string, string>
  priceMicro?: Record<string, number>
  ownerLogin?: string
}) => ({
  INTERNAL_API_KEY: 'ik',
  DB: makeDB([
    { match: 'FROM devices', row: { user_id: 'owner-1', name: 'sticky' } },
    ...Object.entries(opts.tinysOwner ?? {}).map(([slug, uid]) => ({
      match: `FROM tinys`, row: { user_id: uid },
    })),
    ...Object.entries(opts.priceMicro ?? {}).map(([resource, p]) => ({
      match: 'FROM prices', row: { price_micro: p },
    })),
    { match: 'FROM users WHERE id', row: opts.ownerLogin ? { github_login: opts.ownerLogin } : null },
  ]),
  tiny: {
    get: async (key: string) => (opts.kv ?? {})[key] ?? null,
  },
  stats: { get: async () => null, put: async () => { } },
})

afterEach(() => vi.restoreAllMocks())

// ── resolveAskTarget ───────────────────────────────────────────────────────
describe.skipIf(!present)('resolveAskTarget — universe slug resolution', () => {
  const load = () => import(workerFile('ask.ts') /* @vite-ignore */)

  it('absent → owner mode, slug "tiny" (the byte-identical default)', async () => {
    const { resolveAskTarget } = await load()
    expect(await resolveAskTarget(makeEnv({}), undefined, 'owner-1')).toEqual({ mode: 'owner', slug: 'tiny' })
    expect(await resolveAskTarget(makeEnv({}), '', 'owner-1')).toEqual({ mode: 'owner', slug: 'tiny' })
    expect(await resolveAskTarget(makeEnv({}), '  ', 'owner-1')).toEqual({ mode: 'owner', slug: 'tiny' })
  })

  it('"tiny" (any casing/decoration) → owner mode without touching KV', async () => {
    const { resolveAskTarget } = await load()
    const env = makeEnv({})
    env.tiny.get = async () => { throw new Error('KV must not be read for the default slug') }
    expect(await resolveAskTarget(env, 'Tiny', 'owner-1')).toEqual({ mode: 'owner', slug: 'tiny' })
  })

  it("the owner's OWN slug → owner mode with that persona", async () => {
    const { resolveAskTarget } = await load()
    const env = makeEnv({ kv: { mybot: { name: 'mybot', private: true } }, tinysOwner: { mybot: 'owner-1' } })
    expect(await resolveAskTarget(env, 'mybot', 'owner-1')).toEqual({ mode: 'owner', slug: 'mybot' })
  })

  it('a PUBLIC universe slug → universe mode carrying the target owner', async () => {
    const { resolveAskTarget } = await load()
    const env = makeEnv({ kv: { poet: { name: 'poet' } }, tinysOwner: { poet: 'owner-2' } })
    expect(await resolveAskTarget(env, 'poet', 'owner-1')).toEqual({ mode: 'universe', slug: 'poet', ownerId: 'owner-2' })
  })

  it('private (not owned) and unknown produce the SAME 404 sentence — no oracle', async () => {
    const { resolveAskTarget, ASK_TINY_NOT_FOUND } = await load()
    const priv = await resolveAskTarget(
      makeEnv({ kv: { secret: { name: 'secret', private: true } }, tinysOwner: { secret: 'owner-2' } }),
      'secret', 'owner-1')
    const unknown = await resolveAskTarget(makeEnv({}), 'nosuch', 'owner-1')
    expect(priv).toEqual({ mode: 'error', status: 404, error: ASK_TINY_NOT_FOUND })
    expect(unknown).toEqual({ mode: 'error', status: 404, error: ASK_TINY_NOT_FOUND })
  })

  it('oversize raw input → 400; emoji-garbage that slugifies to nothing → 404', async () => {
    const { resolveAskTarget, ASK_TINY_SLUG_RAW_MAX } = await load()
    const big = await resolveAskTarget(makeEnv({}), 'x'.repeat(ASK_TINY_SLUG_RAW_MAX + 1), 'owner-1')
    expect(big.mode).toBe('error')
    expect((big as any).status).toBe(400)
    const junk = await resolveAskTarget(makeEnv({}), '🦆🦆🦆', 'owner-1')
    expect(junk).toMatchObject({ mode: 'error', status: 404 })
  })

  it('a priced tiny → 402 with a sentence (no unconfirmed device-side debits)', async () => {
    const { resolveAskTarget } = await load()
    const env = makeEnv({ kv: { oracle: { name: 'oracle' } }, tinysOwner: { oracle: 'owner-2' }, priceMicro: { 'tiny:oracle': 50_000 } })
    const r = await resolveAskTarget(env, 'oracle', 'owner-1')
    expect(r).toMatchObject({ mode: 'error', status: 402 })
    expect((r as any).error).toContain('/oracle')
  })
})

// ── handler wiring: what job-run actually receives ─────────────────────────
describe.skipIf(!present)('DeviceAskCall — job-run payload per mode', () => {
  const call = async (env: any, body: Record<string, any>) => {
    const { DeviceAskCall } = await import(workerFile('ask.ts') /* @vite-ignore */)
    const handler = Object.create(DeviceAskCall.prototype)
    const req = new Request('https://plugin.tiny.technology/device/ask', {
      method: 'POST',
      headers: { 'x-internal-key': 'ik', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handler.handle(req, env, null, { body })
  }

  it('owner default (no tiny field): job-run body is byte-identical to the pre-universe shape', async () => {
    let jobBody: string | undefined
    global.fetch = vi.fn(async (_url: any, init: any) => {
      jobBody = init.body
      return new Response(JSON.stringify({ ok: true, result: 'hi' }), { status: 200 })
    }) as any
    const res = await call(makeEnv({}), { deviceId: 'd1', token: 't', text: 'hello' })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(jobBody!)
    expect(Object.keys(parsed)).toEqual(['userId', 'tiny', 'prompt'])
    expect(parsed.userId).toBe('owner-1')
    expect(parsed.tiny).toBe('tiny')
  })

  it('universe slug: job-run body carries the slug and NO userId; reply shape unchanged', async () => {
    let jobBody: string | undefined
    global.fetch = vi.fn(async (_url: any, init: any) => {
      jobBody = init.body
      return new Response(JSON.stringify({ ok: true, result: 'a verse\n```card\n{"type":"text","title":"Poem"}\n```' }), { status: 200 })
    }) as any
    const env = makeEnv({ kv: { poet: { name: 'poet' } }, tinysOwner: { poet: 'owner-2' }, ownerLogin: 'cagataycali' })
    const res = await call(env, { deviceId: 'd1', token: 't', text: 'a poem', tiny: 'poet' })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(jobBody!)
    expect(parsed.tiny).toBe('poet')
    expect(parsed).not.toHaveProperty('userId')
    const data = await res.json()
    expect(data).toEqual({ ok: true, text: 'a verse', card: { type: 'text', title: 'Poem' } })
  })

  it('private/unknown slug: 404 sentence BEFORE job-run is ever called — stream flag included', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const env = makeEnv({ kv: { secret: { name: 'secret', private: true } }, tinysOwner: { secret: 'owner-2' } })
    for (const extra of [{}, { stream: '1' }]) {
      const res = await call(env, { deviceId: 'd1', token: 't', text: 'hi', tiny: 'secret', ...extra })
      expect(res.status).toBe(404)
      expect(res.headers.get('Content-Type')).toContain('application/json')
      const data = await res.json()
      expect(data.error).toContain('No public tiny')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('oversize/garbage tiny field refused before any turn', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const res = await call(makeEnv({}), { deviceId: 'd1', token: 't', text: 'hi', tiny: 'x'.repeat(300) })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('universe attribution: visited edge person→tiny recorded, both owners get events', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: 'ok' }), { status: 200 })) as any
    const env = makeEnv({ kv: { poet: { name: 'poet' } }, tinysOwner: { poet: 'owner-2' }, ownerLogin: 'cagataycali' })
    const res = await call(env, { deviceId: 'd1', token: 't', text: 'a poem please', tiny: 'poet' })
    expect(res.status).toBe(200)
    const calls = (env.DB as any).calls as Array<{ sql: string; binds: any[] }>
    const events = calls.filter(c => c.sql.includes('INSERT INTO events'))
    expect(events.some(c => c.binds[0] === 'owner-1' && c.binds[1] === 'device_ask' && String(c.binds[2]).includes('/poet'))).toBe(true)
    expect(events.some(c => c.binds[0] === 'owner-2' && c.binds[1] === 'tiny_visit' && String(c.binds[2]).includes('@cagataycali'))).toBe(true)
    const edges = calls.filter(c => c.sql.includes('INSERT') && c.sql.includes('edge'))
    expect(edges.some(c => c.binds.includes('visited'))).toBe(true)
  })
})

// ── app proxy: /api/devices/ask forwards `tiny` and honest refusal statuses ─
describe('app proxy /api/devices/ask — universe field passthrough', () => {
  const proxyReq = (body: object) =>
    new Request('https://tiny.technology/api/devices/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('forwards tiny:<slug> to the worker; absent field does not travel', async () => {
    const { POST } = await import('../app/api/devices/ask/route')
    const bodies: any[] = []
    global.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ ok: true, text: 'aye' }), { status: 200 })
    }) as any
    await POST(proxyReq({ deviceId: 'd1', token: 't', text: 'hi', tiny: 'poet' }))
    await POST(proxyReq({ deviceId: 'd1', token: 't', text: 'hi' }))
    expect(bodies[0].tiny).toBe('poet')
    expect(bodies[1]).not.toHaveProperty('tiny')
  })

  it('worker 404 (unknown/private slug) and 402 (priced) pass through with their sentence', async () => {
    const { POST } = await import('../app/api/devices/ask/route')
    for (const [status, sentence] of [[404, 'No public tiny by that name — check the slug and try again.'], [402, '/oracle charges per consult — ask it from the tiny app, where payment can be confirmed.']] as const) {
      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: sentence }), { status })) as any
      const res = await POST(proxyReq({ deviceId: 'd1', token: 't', text: 'hi', tiny: 'x' }))
      expect(res.status).toBe(status)
      expect((await res.json()).error).toBe(sentence)
    }
  })
})

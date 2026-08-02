// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import { validatePublicUrl } from '@/lib/utils'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('endpoint-device')

/**
 * 🤖 Endpoint devices — docs/endpoint-devices-vision-2026-07-25.md phase 1.
 *
 * A device tiny dials OUT to (a printer/robot behind its own WebAuthn-sealed
 * dashboard) instead of one that dials in. What must hold:
 *   - the URL is SSRF-guarded, and by the SAME rules as the app's own guard
 *     (the worker is a separate bundle, so the rule is duplicated code — this
 *     test is the only thing keeping the two from drifting apart)
 *   - a stored url is normalized to an origin (every call is `${url}${path}`)
 *   - the secret NEVER appears in the list projection
 *   - the endpoint lookup is owner-scoped (a leaked device id can't fetch a key)
 *   - the action allowlist can't be talked into an arbitrary path by the model
 */
let mod: any
let db: any

const URL_CASES: Array<[string, boolean, string]> = [
  ['https://printer.example.com', true, 'the real printer'],
  ['https://printer.example.com/api/chat', true, 'path is dropped, host is fine'],
  ['http://printer.example.com', false, 'plaintext http'],
  ['https://localhost', false, 'localhost'],
  ['https://printer.local', false, 'mDNS .local'],
  ['https://box.internal', false, '.internal'],
  ['https://192.168.1.151', false, 'private IPv4 literal'],
  ['https://127.0.0.1', false, 'loopback'],
  ['https://0x7f.0.0.1', false, 'hex-encoded loopback'],
  ['https://2130706433', false, 'dotless-decimal loopback'],
  ['https://[::1]', false, 'IPv6 loopback'],
  ['https://localhost.', false, 'FQDN-root localhost'],
  ['https://intranet', false, 'dotless host'],
  ['not a url', false, 'garbage'],
  ['', false, 'empty'],
]

beforeAll(async () => {
  if (!present) return
  mod = await import(workerFile('devices.ts') /* @vite-ignore */)
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  // Mirrors migrations 0013 + 0029 (url/secret added, token_hash still NOT NULL)
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT, kind TEXT, capabilities TEXT, token_hash TEXT NOT NULL,
      last_seen INTEGER, created_at INTEGER, revoked INTEGER DEFAULT 0,
      url TEXT, secret TEXT,
      -- 0032. DEVICE_LIST_SQL selects it, so this fixture must carry it or the
      -- real statement fails here for a reason unrelated to endpoint devices.
      lan_url TEXT NOT NULL DEFAULT ''
    )`)
})

describe.skipIf(!present)('endpoint device url validation', () => {
  for (const [raw, wantOk, why] of URL_CASES) {
    it(`${wantOk ? 'accepts' : 'refuses'} ${JSON.stringify(raw)} — ${why}`, () => {
      const got = mod.validateEndpointUrl(raw)
      expect('error' in got, `${raw}: ${JSON.stringify(got)}`).toBe(!wantOk)
    })
  }

  it('normalizes an accepted url to its origin', () => {
    // Every call is built as `${url}${path}`, so a stored path/query would
    // corrupt every request made from the row.
    expect(mod.validateEndpointUrl('https://printer.example.com/api/chat?x=1#f'))
      .toEqual({ url: 'https://printer.example.com' })
    expect(mod.validateEndpointUrl('https://printer.example.com/')).toEqual({ url: 'https://printer.example.com' })
  })

  it('agrees with the app-side SSRF guard on every case', () => {
    // The worker can't import lib/utils (separate bundle) so the rule is
    // duplicated. This is the only thing that keeps the copies honest: if
    // either side gains or loses a rejection, this fails.
    for (const [raw] of URL_CASES) {
      const worker = !('error' in mod.validateEndpointUrl(raw))
      const app = !('error' in validatePublicUrl(raw))
      expect(app, `divergence on ${JSON.stringify(raw)}`).toBe(worker)
    }
  })
})

describe.skipIf(!present)('endpoint device kinds', () => {
  it('endpoint is a device kind but NOT a pull kind', () => {
    expect(mod.DEVICE_KINDS).toContain('endpoint')
    expect(mod.PULL_KINDS).not.toContain('endpoint')
    // The enroll handler clamps unknown kinds into PULL_KINDS; if 'endpoint'
    // ever leaked in there, an endpoint row would be minted a useless token.
    expect([...mod.PULL_KINDS]).toEqual(['daemon', 'browser', 'cli'])
  })

  it('isEndpointKind is exact — not a prefix or substring match', () => {
    expect(mod.isEndpointKind('endpoint')).toBe(true)
    expect(mod.isEndpointKind('endpoints')).toBe(false)
    expect(mod.isEndpointKind('ENDPOINT')).toBe(false)
    expect(mod.isEndpointKind('cli')).toBe(false)
    expect(mod.isEndpointKind(undefined)).toBe(false)
    expect(mod.isEndpointKind(null)).toBe(false)
  })
})

describe.skipIf(!present)('endpoint device SQL', () => {
  // node:sqlite binds ?1-numbered params as NAMED params; D1's positional
  // .bind(v) is identical (same convention as tests/devices-sql.test.ts).
  const run = (sql: string, p: Record<number, any>) => db.prepare(sql).run(p)
  const insertEndpoint = (id: string, userId: string, url: string, secret: string) =>
    run(mod.ENDPOINT_INSERT_SQL, {
      1: id, 2: userId, 3: 'printer', 4: 'bambu-x2d', 5: 'endpoint',
      6: '["chat"]', 7: 1000, 8: url, 9: secret,
    })
  const insertPull = (id: string, userId: string) =>
    run(mod.DEVICE_INSERT_SQL, {
      1: id, 2: userId, 3: 'mac', 4: 'darwin', 5: 'cli', 6: '[]', 7: 'hash-' + id, 8: 2000,
    })

  it('stores url+secret with an empty token_hash and NULL last_seen', () => {
    insertEndpoint('e1', 'u1', 'https://printer.example.com', 'jwt-abc')
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get('e1')
    expect(row.kind).toBe('endpoint')
    expect(row.url).toBe('https://printer.example.com')
    expect(row.secret).toBe('jwt-abc')
    // No inbound token: nothing ever authenticates INTO an endpoint device.
    expect(row.token_hash).toBe('')
    // NULL, not now(): a fake "seen" would render an unreachable robot online.
    expect(row.last_seen).toBe(null)
  })

  it('NEVER projects the secret in the list query', () => {
    insertEndpoint('e2', 'u2', 'https://printer.example.com', 'super-secret-jwt')
    const rows = db.prepare(mod.DEVICE_LIST_SQL).all({ 1: 'u2' })
    expect(rows).toHaveLength(1)
    expect(rows[0].url).toBe('https://printer.example.com')
    expect('secret' in rows[0]).toBe(false)
    expect(JSON.stringify(rows)).not.toContain('super-secret-jwt')
  })

  it('endpoint lookup is owner-scoped, kind-scoped and revoke-aware', () => {
    insertEndpoint('e3', 'owner', 'https://printer.example.com', 'k3')
    const get = (id: string, user: string) => db.prepare(mod.ENDPOINT_GET_SQL).get({ 1: id, 2: user })
    // wrong owner → nothing (a leaked device id alone can't reach the secret)
    expect(get('e3', 'someone-else')).toBe(undefined)
    // right owner → the row, secret included (the worker needs it to call out)
    expect(get('e3', 'owner')?.secret).toBe('k3')
    // a pull-mode device is not reachable through the endpoint path
    insertPull('p1', 'owner')
    expect(get('p1', 'owner')).toBe(undefined)
    // revoked → gone, same as nonexistent (no oracle)
    run(mod.DEVICE_REVOKE_SQL, { 1: 'e3', 2: 'owner' })
    expect(get('e3', 'owner')).toBe(undefined)
  })

  it('revoked endpoint devices drop out of the list', () => {
    insertEndpoint('e4', 'u4', 'https://printer.example.com', 'k4')
    expect(db.prepare(mod.DEVICE_LIST_SQL).all({ 1: 'u4' })).toHaveLength(1)
    run(mod.DEVICE_REVOKE_SQL, { 1: 'e4', 2: 'u4' })
    expect(db.prepare(mod.DEVICE_LIST_SQL).all({ 1: 'u4' })).toHaveLength(0)
  })

  it('counts against the shared per-user device cap', () => {
    insertEndpoint('e5', 'u5', 'https://printer.example.com', 'k5')
    insertPull('p5', 'u5')
    // One registry, one cap — an endpoint body is not a free extra slot.
    expect(db.prepare(mod.DEVICE_COUNT_SQL).get({ 1: 'u5' }).n).toBe(2)
  })
})

/**
 * The outbound call itself. This block exists because `redirect: "error"` — the
 * obvious way to refuse a redirect — is NOT implemented in the Workers runtime:
 * it throws on the OPTION, so every real call came back "device unreachable"
 * while all the SQL/validation tests above stayed green. Nothing was asserting
 * the fetch options, so nothing caught it until the printer was live. These
 * tests read the options the handler actually passes.
 */
describe.skipIf(!present)('DeviceEndpointCallRoute — the outbound fetch', () => {
  const KEY = 'internal-test-key-0123456789'
  const USER = 'owner-1'
  const DEV = 'dev-printer'

  let fetches: Array<{ url: string; init: any }>

  /** Minimal D1 shim: numbered SQL → node:sqlite named params (house pattern). */
  const d1 = () => ({
    prepare(sql: string) {
      const binds: any[] = []
      const args = () => {
        const named: any = {}
        binds.forEach((v, i) => { named[i + 1] = v === undefined ? null : v })
        return /\?\d/.test(sql) ? [named] : binds
      }
      const stmt = {
        bind(...a: any[]) { binds.push(...a); return stmt },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args()).changes || 0) } } },
        async first() { return db.prepare(sql).get(...args()) ?? null },
        async all() { return { results: db.prepare(sql).all(...args()) } },
      }
      return stmt
    },
  })

  const req = (body: any, key = KEY) =>
    new Request('https://worker/device/endpoint/call', {
      method: 'POST', headers: { 'X-Internal-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  const call = async (body: any, key = KEY) =>
    new mod.DeviceEndpointCallRoute().handle(req(body, key), { DB: d1(), INTERNAL_API_KEY: KEY }, {}, { body })

  const stubFetch = (respond: () => Response) => {
    fetches = []
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      fetches.push({ url: String(url), init })
      return respond()
    }))
  }

  beforeEach(() => {
    db.prepare('DELETE FROM devices').run()
    db.prepare(mod.ENDPOINT_INSERT_SQL).run({
      1: DEV, 2: USER, 3: 'printer', 4: 'bambu-x2d', 5: 'endpoint',
      6: '["chat"]', 7: 1000, 8: 'https://printer.example.com', 9: 'jwt-secret',
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('passes fetch options the Workers runtime actually accepts', async () => {
    stubFetch(() => new Response('{"ok":true}', { status: 200 }))
    await call({ userId: USER, deviceId: DEV, action: 'telemetry' })

    const { url, init } = fetches[0]
    expect(url).toBe('https://printer.example.com/api/telemetry')
    // `error` is rejected AT THE EDGE — the runtime throws on the option itself,
    // and the throw is indistinguishable from an offline robot. Only follow and
    // manual exist; manual is the one that doesn't leak the bearer.
    expect(init.redirect).toBe('manual')
    expect(['manual', 'follow']).toContain(init.redirect)
    expect(init.headers.Authorization).toBe('Bearer jwt-secret')
    expect(init.signal).toBeTruthy() // no unbounded hang on a wedged tunnel
  })

  it('refuses a redirect instead of following it', async () => {
    // With `manual` the 3xx lands in our hands — following it by hand would send
    // the bearer to whatever origin the Location names.
    stubFetch(() => new Response(null, { status: 302, headers: { Location: 'https://evil.example/api' } }))
    const res: Response = await call({ userId: USER, deviceId: DEV, action: 'telemetry' })
    expect(res.status).toBe(502)
    expect((await res.json() as any).error).toMatch(/redirect/i)
    // Exactly one request: the redirect was never chased.
    expect(fetches).toHaveLength(1)
  })

  it('chat posts the prompt; telemetry sends no body', async () => {
    stubFetch(() => new Response('{"reply":"idle"}', { status: 200 }))
    await call({ userId: USER, deviceId: DEV, action: 'chat', prompt: 'status?' })
    expect(fetches[0].url).toBe('https://printer.example.com/api/chat')
    expect(fetches[0].init.method).toBe('POST')
    expect(JSON.parse(fetches[0].init.body)).toEqual({ prompt: 'status?' })

    stubFetch(() => new Response('{}', { status: 200 }))
    await call({ userId: USER, deviceId: DEV, action: 'telemetry' })
    expect(fetches[0].init.method).toBe('GET')
    expect(fetches[0].init.body).toBeUndefined()
  })

  it('tells unreachable, timed-out and unauthorized apart', async () => {
    stubFetch(() => { throw new Error('connection refused') })
    const down: any = await (await call({ userId: USER, deviceId: DEV, action: 'telemetry' })).json()
    expect(down.unreachable).toBe(true)
    expect(down.timeout).toBeUndefined()
    expect(down.unauthorized).toBeUndefined()

    // A slow agent is NOT an absent one. The printer's CAD agent took 53s for a
    // one-line question; reporting that as "powered off" sends the owner to check
    // cables on a machine that is working fine.
    stubFetch(() => { throw new Error('The operation was aborted due to timeout') })
    const slow: Response = await call({ userId: USER, deviceId: DEV, action: 'chat', prompt: 'design a bracket' })
    expect(slow.status).toBe(504)
    const slowBody: any = await slow.json()
    expect(slowBody.timeout).toBe(true)
    expect(slowBody.unreachable).toBeUndefined()

    for (const status of [401, 403]) {
      stubFetch(() => new Response('nope', { status }))
      const bad: any = await (await call({ userId: USER, deviceId: DEV, action: 'telemetry' })).json()
      expect(bad.unauthorized, `status ${status}`).toBe(true)
      expect(bad.unreachable).toBeUndefined()
    }
  })

  it('gives a thinking agent far longer than a plain read', async () => {
    // Measured: 53s for a one-line status question through the CAD agent. A
    // single shared 60s budget was one slow round-trip from calling a healthy
    // printer unreachable — so chat gets minutes, telemetry stays snappy.
    const budget = async (action: string, extra: any = {}) => {
      stubFetch(() => new Response('{}', { status: 200 }))
      await call({ userId: USER, deviceId: DEV, action, ...extra })
      // AbortSignal.timeout carries no readable deadline, so compare against a
      // real signal of known duration by racing neither — assert via the aborted
      // ordering instead: a 20s signal aborts before a 150s one.
      return fetches[0].init.signal
    }
    const chatSignal = await budget('chat', { prompt: 'hi' })
    const readSignal = await budget('telemetry')
    expect(chatSignal.aborted).toBe(false)
    expect(readSignal.aborted).toBe(false)
    // The invariant that matters and is checkable: chat's budget clears the
    // measured 53s, yet stays under /api/job-run's 120s function budget — this
    // tool runs there too, and tests/deadlines.test.ts enforces that ordering
    // from the other side.
    const src = readFileSync(workerFile('devices.ts'), 'utf8')
    const [, chatMs, readMs] = src.match(/spec\.body \? (\d[\d_]*) : (\d[\d_]*)/) || []
    const n = (s: string) => Number(s.replace(/_/g, ''))
    expect(n(chatMs)).toBeGreaterThan(60_000)
    expect(n(chatMs)).toBeLessThan(120_000)
    expect(n(readMs)).toBeLessThan(n(chatMs))
  })

  it('never calls out for a device that is not the caller\'s', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))
    const res: Response = await call({ userId: 'someone-else', deviceId: DEV, action: 'telemetry' })
    expect(res.status).toBe(404)
    // The point: the secret was never even read, let alone spent.
    expect(fetches).toHaveLength(0)
  })

  it('refuses an unknown action rather than guessing a path', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))
    const res: Response = await call({ userId: USER, deviceId: DEV, action: 'print' })
    expect(res.status).toBe(400)
    expect(fetches).toHaveLength(0)
  })

  it('is internal-key gated like every other worker route', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))
    const res: Response = await call({ userId: USER, deviceId: DEV, action: 'telemetry' }, 'wrong-key-wrong-length')
    expect(res.status).toBe(401)
    expect(fetches).toHaveLength(0)
  })
})

describe.skipIf(!present)('endpoint action allowlist', () => {
  it('exposes only read/chat surfaces — never a model-chosen path', () => {
    // These dashboards also expose print/drive/laser routes. The action is an
    // LLM tool argument, so an open path parameter would let a sentence start a
    // print or move a robot. Keep this list boring on purpose.
    expect(Object.keys(mod.ENDPOINT_ACTIONS).sort()).toEqual(['chat', 'snapshot', 'telemetry'])
    for (const spec of Object.values<any>(mod.ENDPOINT_ACTIONS)) {
      expect(spec.path.startsWith('/api/')).toBe(true)
      // A path that could escape the origin or traverse would defeat the point
      // of pinning the URL to an origin.
      expect(spec.path).not.toContain('..')
      expect(spec.path).not.toContain('//')
      expect(['GET', 'POST']).toContain(spec.method)
    }
  })

  it('only chat sends a body', () => {
    expect(mod.ENDPOINT_ACTIONS.chat.body).toBe(true)
    expect(mod.ENDPOINT_ACTIONS.telemetry.body).toBeFalsy()
    expect(mod.ENDPOINT_ACTIONS.snapshot.body).toBeFalsy()
  })

  it('the camera action is the STILL frame, never the endless stream', () => {
    // /api/camera/stream is an infinite multipart generator: it yields frames
    // until the client disconnects. Proxying it would hold a worker invocation
    // open forever and NO timeout could fire, because the response is defined
    // never to end. The snapshot is a bounded read of an already-decoded buffer.
    expect(mod.ENDPOINT_ACTIONS.snapshot.path).toBe('/api/camera/snapshot')
    for (const spec of Object.values<any>(mod.ENDPOINT_ACTIONS)) {
      expect(spec.path, 'no action may proxy an endless stream').not.toMatch(/stream/)
    }
  })
})

/**
 * The snapshot path returns BYTES from a machine we don't control, served back
 * from our own origin — a different threat shape from every JSON action, and the
 * reason these tests exist separately.
 */
describe.skipIf(!present)('endpoint camera snapshot', () => {
  const KEY = 'internal-test-key-0123456789'
  const USER = 'owner-1'
  const DEV = 'dev-cam'
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

  const d1 = () => ({
    prepare(sql: string) {
      const binds: any[] = []
      const args = () => {
        const named: any = {}
        binds.forEach((v, i) => { named[i + 1] = v === undefined ? null : v })
        return /\?\d/.test(sql) ? [named] : binds
      }
      const stmt = {
        bind(...a: any[]) { binds.push(...a); return stmt },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args()).changes || 0) } } },
        async first() { return db.prepare(sql).get(...args()) ?? null },
        async all() { return { results: db.prepare(sql).all(...args()) } },
      }
      return stmt
    },
  })

  const call = async (body: any) =>
    new mod.DeviceEndpointCallRoute().handle(
      new Request('https://worker/device/endpoint/call', {
        method: 'POST', headers: { 'X-Internal-Key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { DB: d1(), INTERNAL_API_KEY: KEY }, {}, { body },
    )

  const snapshot = () => call({ userId: USER, deviceId: DEV, action: 'snapshot' })

  const stub = (body: BodyInit | null, init: ResponseInit) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, init)))
  }

  beforeEach(() => {
    db.prepare('DELETE FROM devices').run()
    db.prepare(mod.ENDPOINT_INSERT_SQL).run({
      1: DEV, 2: USER, 3: 'printer', 4: 'bambu-x2d', 5: 'endpoint',
      6: '["chat","camera"]', 7: 1000, 8: 'https://printer.example.com', 9: 'jwt-secret',
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('passes a real jpeg through with the type pinned and no caching', async () => {
    stub(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    const res: Response = await snapshot()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    // A cached frame is a lie about "now" and makes the page's poll pointless.
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG)
  })

  it('REFUSES a non-image content-type instead of serving it from our origin', async () => {
    // The attack this blocks: these bytes are served back from tiny.technology,
    // so a dashboard answering text/html would execute as a same-origin document
    // with access to the session that fetched it. Echoing the device's own
    // content-type is what would make that possible.
    for (const evil of ['text/html', 'application/javascript', 'image/svg+xml', 'text/plain']) {
      stub('<script>alert(1)</script>', { status: 200, headers: { 'Content-Type': evil } })
      const res: Response = await snapshot()
      expect(res.status, evil).toBe(502)
      expect(res.headers.get('content-type'), evil).toMatch(/application\/json/)
      expect((await res.json() as any).error, evil).toMatch(/non-image/i)
    }
    // Note svg is refused deliberately: it is an image type that CAN script.
    expect(mod.ENDPOINT_IMAGE_TYPES).not.toContain('image/svg+xml')
  })

  it('never echoes the device\'s own content-type, even a sneaky-but-listed one', async () => {
    // charset/parameters stripped, and the value comes from OUR allowlist.
    stub(JPEG, { status: 200, headers: { 'Content-Type': 'IMAGE/JPEG; charset=utf-8' } })
    const res: Response = await snapshot()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
  })

  it('caps an oversized frame rather than buffering whatever arrives', async () => {
    const huge = new Uint8Array(mod.ENDPOINT_IMAGE_MAX_BYTES + 1024)
    stub(huge, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    const res: Response = await snapshot()
    expect(res.status).toBe(502)
    expect((await res.json() as any).error).toMatch(/exceeded/i)
  })

  it('an empty body is an error, not a zero-byte image', async () => {
    stub(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    const res: Response = await snapshot()
    expect(res.status).toBe(502)
    expect((await res.json() as any).error).toMatch(/empty/i)
  })

  it('keeps the credential rules that the JSON actions have', async () => {
    // 401 from the device is still "our token is stale", not "no camera".
    stub('nope', { status: 401 })
    const bad: any = await (await snapshot()).json()
    expect(bad.unauthorized).toBe(true)

    // A redirect must not be chased with the bearer attached, image or not.
    stub(null, { status: 302, headers: { Location: 'https://evil.example/x.jpg' } })
    const red: Response = await snapshot()
    expect(red.status).toBe(502)
    expect((await red.json() as any).error).toMatch(/redirect/i)

    // And another user's device is still invisible.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })))
    const foreign: Response = await call({ userId: 'someone-else', deviceId: DEV, action: 'snapshot' })
    expect(foreign.status).toBe(404)
  })

  it('gives a polled frame the tightest budget of the three actions', async () => {
    // A frame is fetched on a 2s timer by an open page: a slow one should lose
    // its turn, not hold the line while ticks queue behind it. chat is 90s
    // (an agent turn), telemetry 20s, so the image budget must be under both.
    const src = readFileSync(workerFile('devices.ts'), 'utf8')
    const n = (s: string) => Number(s.replace(/_/g, ''))
    const [, imageMs] = src.match(/spec\.image \? (\d[\d_]*)/) || []
    const [, chatMs, readMs] = src.match(/spec\.body \? (\d[\d_]*) : (\d[\d_]*)/) || []
    expect(n(imageMs)).toBeGreaterThan(0)
    expect(n(imageMs)).toBeLessThan(n(readMs))
    expect(n(imageMs)).toBeLessThan(n(chatMs))
  })
})

// @vitest-environment node
//
// The firmware channel: the one pollable name in the OTA path, and the only
// route a necklace asks "should I be running something else?".
//
// Three properties are worth more than the rest here, because the thing on the
// other end is worn and cannot be opened to be rescued:
//   1. no caller may name an account — a device that could would install another
//      owner's build on itself;
//   2. a pointer the firmware could not have installed is refused at publish
//      time, while the person who typed it is watching;
//   3. an outage must not read as "you are up to date". `bundle: null` is a
//      legitimate answer, so a masked-empty 200 would silently stop OTA for the
//      fleet and never report it.
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

beforeAll(() => { process.env.AUTH_JWT_SECRET = 'test-secret' })

import { GET, POST, PUT } from '../app/api/firmware/manifest/route'
import { issueSession } from '../lib/auth'

// The worker is a private submodule, absent in CI — load its source only when
// it is checked out, the same way every other worker-dependent suite does.
let validateBundle: any
let FIRMWARE_HOSTS: readonly string[]
let CHANNEL_RE: RegExp
let FirmwarePublishCall: any
let FirmwareCurrentCall: any
let FirmwareDeviceCurrentCall: any

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('firmware.ts') /* @vite-ignore */)
  validateBundle = mod.validateBundle
  FIRMWARE_HOSTS = mod.FIRMWARE_HOSTS
  CHANNEL_RE = mod.CHANNEL_RE
  FirmwarePublishCall = mod.FirmwarePublishCall
  FirmwareCurrentCall = mod.FirmwareCurrentCall
  FirmwareDeviceCurrentCall = mod.FirmwareDeviceCurrentCall
})

warnIfWorkerAbsent('firmware-channel')

const GOOD_SHA = 'a'.repeat(64)
const GOOD_URL = 'https://plugin.tiny.technology/media/abc123.json'
const BUNDLE = { channel: 'stable', version: 'ota-deadbeef1234', url: GOOD_URL, sha256: GOOD_SHA }

const req = (method: string, body: string | object | null, cookie?: string, qs = '') =>
  new Request('https://tiny.technology/api/firmware/manifest' + qs, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })

const auth = async () => `tiny_session=${await issueSession({ sub: 'u1', login: 'me' })}`

const worker = (body: any, status = 200) => {
  const seen: { url: string; init: any }[] = []
  global.fetch = vi.fn(async (url: any, init: any) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }) as any
  return seen
}

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!present)('validateBundle — a pointer the firmware could not install is refused', () => {
  it('accepts a well-formed pointer and lowercases the sha', () => {
    const r = validateBundle({ ...BUNDLE, sha256: GOOD_SHA.toUpperCase() })
    expect('bundle' in r && r.bundle.sha256).toBe(GOOD_SHA)
  })

  it('refuses http:// rather than upgrading it', () => {
    // This URL names executable code. A plaintext hop lets anyone on the path
    // pick what the necklace runs next, so silently promoting it to https would
    // be answering a different question than the one asked.
    const r = validateBundle({ ...BUNDLE, url: 'http://plugin.tiny.technology/media/a.json' })
    expect('error' in r && r.error).toMatch(/https/)
  })

  it.each([
    'https://evil.example.com/media/a.json',
    // The classic near-misses: a host that only ENDS with ours, and one that
    // merely contains it. A substring check would take both.
    'https://notplugin.tiny.technology/media/a.json',
    'https://plugin.tiny.technology.evil.com/media/a.json',
    // Credentials in the authority, so the text before the @ reads as our host.
    'https://plugin.tiny.technology@evil.com/media/a.json',
  ])('refuses %s', (url) => {
    const r = validateBundle({ ...BUNDLE, url })
    expect('error' in r && r.error).toMatch(/not a host|is not a URL/)
  })

  it.each([
    ['absent', undefined],
    ['too short', 'abc'],
    ['not hex', 'z'.repeat(64)],
    ['65 hex', 'a'.repeat(65)],
  ])('refuses a sha256 that is %s', (_why, sha256) => {
    // An optional integrity field is not an integrity field: a pointer with no
    // usable hash sends the device to run whatever currently answers at the URL.
    const r = validateBundle({ ...BUNDLE, sha256 })
    expect('error' in r && r.error).toMatch(/sha256/)
  })

  it.each(['', 'Stable', 'has space', 'a'.repeat(33), '-leading'])(
    'refuses the channel name %o', (channel) => {
      expect(CHANNEL_RE.test(channel)).toBe(false)
      const r = validateBundle({ ...BUNDLE, channel })
      expect('error' in r && r.error).toMatch(/channel/)
    })

  it('refuses an empty or oversized version', () => {
    expect('error' in validateBundle({ ...BUNDLE, version: '' })).toBe(true)
    expect('error' in validateBundle({ ...BUNDLE, version: 'v'.repeat(129) })).toBe(true)
  })

  it('the allowed hosts are exactly the ones the firmware pins', () => {
    // firmware/tiny_ota.py has MEDIA_HOSTS = ("plugin.tiny.technology",) and adds
    // the configured api host. Both are here; if that list grows, this fails and
    // whoever grew it is told there are two copies to grow.
    expect([...FIRMWARE_HOSTS].sort()).toEqual(['plugin.tiny.technology', 'tiny.technology'])
  })
})

// A fake D1: `prepare(sql).bind(...).first()/.run()` and a table it can be
// asked about afterwards, so the upsert half is read by the select half rather
// than asserted in isolation.
const makeDB = () => {
  const rows = new Map<string, any>()
  const calls: { sql: string; args: any[] }[] = []
  return {
    rows, calls,
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          calls.push({ sql, args })
          return {
            async first() {
              if (sql.includes('FROM devices')) {
                const [id, hash] = args
                return rows.get(`dev:${id}:${hash}`) ?? null
              }
              return rows.get(`fw:${args[0]}:${args[1]}`) ?? null
            },
            async run() {
              const [user_id, channel, version, url, sha256, updated_at] = args
              const key = `fw:${user_id}:${channel}`
              // Honour the statement's own conflict clause. A fake that
              // overwrote unconditionally would read exactly the same whether
              // the SQL said DO UPDATE SET or DO NOTHING — and "the second
              // publish is the one the board gets" is the property under test,
              // so the fixture has to be able to disagree with it.
              const prev = rows.get(key)
              if (prev && !/DO UPDATE SET/.test(sql)) return { meta: { changes: 0 } }
              // Likewise per-column: DO UPDATE SET that names only `version`
              // would leave a stale url and sha behind a new version number,
              // which is a new build pointing at the old bytes.
              const set = /DO UPDATE SET([\s\S]*)$/.exec(sql)?.[1] ?? ''
              const col = (name: string, next: any, old: any) =>
                !prev || set.includes(`${name} = excluded.${name}`) ? next : old
              rows.set(key, {
                version: col('version', version, prev?.version),
                url: col('url', url, prev?.url),
                sha256: col('sha256', sha256, prev?.sha256),
                updated_at: col('updated_at', updated_at, prev?.updated_at),
              })
              return { meta: { changes: 1 } }
            },
          }
        },
      }
    },
  }
}

const KEY = 'test-internal-key'
const wreq = (body: any, key: string | null = KEY) =>
  new Request('https://plugin.tiny.technology/firmware/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Internal-Key': key } : {}) },
    body: JSON.stringify(body),
  })

describe.skipIf(!present)('the worker routes — where ownership is actually resolved', () => {
  const env = () => ({ DB: makeDB(), INTERNAL_API_KEY: KEY })

  it('publish then read back, through both real handlers', async () => {
    const e = env()
    const pub = await new FirmwarePublishCall().handle(
      wreq({ userId: 'u1', ...BUNDLE }), e, {}, { body: { userId: 'u1', ...BUNDLE } })
    expect(pub.status).toBe(200)

    const got = await new FirmwareCurrentCall().handle(
      wreq({}), e, {}, { query: { userId: 'u1', channel: 'stable' } })
    const body = await got.json() as any
    expect(body.bundle.version).toBe(BUNDLE.version)
    expect(body.bundle.sha256).toBe(GOOD_SHA)
  })

  it('a second publish REPLACES the channel, url and sha included', async () => {
    // A channel is a name for ONE current build. A row that survived a second
    // publish would pin the board to the first bundle forever; a row whose
    // version moved while url/sha did not would be a new version number over
    // the old bytes, which is worse — it reports success and changes nothing.
    const e = env()
    const one = { userId: 'u1', ...BUNDLE }
    const two = {
      userId: 'u1', channel: 'stable', version: 'ota-second00000',
      url: 'https://plugin.tiny.technology/media/second.json', sha256: 'b'.repeat(64),
    }
    await new FirmwarePublishCall().handle(wreq(one), e, {}, { body: one })
    await new FirmwarePublishCall().handle(wreq(two), e, {}, { body: two })
    const got = await new FirmwareCurrentCall().handle(
      wreq({}), e, {}, { query: { userId: 'u1', channel: 'stable' } })
    const bundle = (await got.json() as any).bundle
    expect(bundle.version).toBe(two.version)
    expect(bundle.url).toBe(two.url)
    expect(bundle.sha256).toBe(two.sha256)
    expect(Array.from(e.DB.rows.keys()).filter(k => k.startsWith('fw:u1:'))).toHaveLength(1)
  })

  it('the upsert updates every column that is not part of the key', () => {
    // Derived from the statement's own column list rather than a list typed
    // here, so a column added to the INSERT and forgotten in the SET fails this
    // instead of shipping as a field that can never change after the first
    // publish.
    const src = readFileSync(workerFile('firmware.ts'), 'utf8')
    const stmt = /FIRMWARE_UPSERT_SQL = `([\s\S]*?)`/.exec(src)![1]
    const cols = /INSERT INTO firmware_channels \(([^)]*)\)/.exec(stmt)![1]
      .split(',').map(s => s.trim())
    const key = /ON CONFLICT\(([^)]*)\)/.exec(stmt)![1].split(',').map(s => s.trim())
    const set = stmt.slice(stmt.indexOf('DO UPDATE SET'))
    expect(key).toEqual(['user_id', 'channel'])
    for (const c of cols.filter(c => !key.includes(c))) {
      expect(set).toContain(`${c} = excluded.${c}`)
    }
  })

  it.each([
    ['publish', () => new FirmwarePublishCall(), { body: { userId: 'u1', ...BUNDLE } }],
    ['current', () => new FirmwareCurrentCall(), { query: { userId: 'u1', channel: 'stable' } }],
    ['device-current', () => new FirmwareDeviceCurrentCall(),
      { body: { deviceId: 'd1', token: 'tind_x', channel: 'stable' } }],
  ])('%s refuses a request with no internal key', async (_name, make, data) => {
    const res = await make().handle(wreq({}, null), env(), {}, data as any)
    expect(res.status).toBe(401)
  })

  it('a device is told about ITS OWNER, not a userId it supplies', async () => {
    // The invariant with teeth: a device that could name the account could point
    // itself at another owner's build.
    const e = env()
    const mine = { userId: 'u1', ...BUNDLE, version: 'ota-mine0000000' }
    const theirs = { userId: 'u2', ...BUNDLE, version: 'ota-theirs00000' }
    await new FirmwarePublishCall().handle(wreq(mine), e, {}, { body: mine })
    await new FirmwarePublishCall().handle(wreq(theirs), e, {}, { body: theirs })

    // Register d1 as u1's, under the hash of its token.
    const mod = await import(workerFile('devices.ts') /* @vite-ignore */)
    e.DB.rows.set(`dev:d1:${await mod.hashDeviceToken('tind_secret')}`, { user_id: 'u1' })

    const res = await new FirmwareDeviceCurrentCall().handle(
      wreq({}), e, {},
      { body: { deviceId: 'd1', token: 'tind_secret', channel: 'stable', userId: 'u2' } })
    expect((await res.json() as any).bundle.version).toBe('ota-mine0000000')
  })

  it('a wrong token is 401 and reads the same as an unknown device', async () => {
    // No oracle for enumerating device ids: both answers are the same sentence.
    const e = env()
    const mod = await import(workerFile('devices.ts') /* @vite-ignore */)
    e.DB.rows.set(`dev:d1:${await mod.hashDeviceToken('tind_secret')}`, { user_id: 'u1' })

    const bad = await new FirmwareDeviceCurrentCall().handle(
      wreq({}), e, {}, { body: { deviceId: 'd1', token: 'tind_wrong', channel: 'stable' } })
    const nosuch = await new FirmwareDeviceCurrentCall().handle(
      wreq({}), e, {}, { body: { deviceId: 'nope', token: 'tind_secret', channel: 'stable' } })
    expect(bad.status).toBe(401)
    expect(nosuch.status).toBe(401)
    expect(await bad.json()).toEqual(await nosuch.json())
  })

  it('the device auth SQL requires revoked = 0', () => {
    // Not observable through the fake DB, which is exactly why it is read out of
    // the statement: a revoked device that kept receiving bundles would be a
    // credential the owner believes they killed.
    const src = readFileSync(workerFile('firmware.ts'), 'utf8')
    const sql = src.slice(src.indexOf('FIRMWARE_DEVICE_AUTH_SQL'))
    expect(sql.slice(0, 200)).toMatch(/revoked = 0/)
  })

  it('every route class this module exports is registered in index.ts', () => {
    // Derived, not curated: a class exported and never wired is a 404 in
    // production that no other test here would notice.
    const src = readFileSync(workerFile('firmware.ts'), 'utf8')
    const classes = Array.from(src.matchAll(/^export class (\w+)/gm)).map(m => m[1])
    const index = readFileSync(workerFile('index.ts'), 'utf8')
    const wired = classes.filter(c => new RegExp(`router\\.\\w+\\([^)]*\\b${c}\\)`).test(index))
    expect(classes.length).toBeGreaterThan(0)
    expect(wired).toEqual(classes)
    // and imported, or the file would not even build
    expect(index).toMatch(/import \{[^}]*FirmwarePublishCall[^}]*\} from "\.\/firmware"/)
  })
})

describe('POST /api/firmware/manifest — publish', () => {
  it('anonymous → 401 before the worker is touched', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    expect((await POST(req('POST', BUNDLE))).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it.each(['channel', 'version', 'url', 'sha256'])(
    'missing %s → 400, never reaches the worker', async (field) => {
      const spy = vi.fn()
      global.fetch = spy as any
      const body: any = { ...BUNDLE }
      delete body[field]
      expect((await POST(req('POST', body, await auth()))).status).toBe(400)
      expect(spy).not.toHaveBeenCalled()
    })

  it('stamps the SESSION userId and ignores one in the body', async () => {
    const seen = worker({ ok: true, channel: 'stable', version: 'ota-deadbeef1234' })
    const res = await POST(req('POST', { ...BUNDLE, userId: 'attacker' }, await auth()))
    expect(res.status).toBe(200)
    expect(JSON.parse(seen[0].init.body).userId).toBe('u1')
  })

  it('a worker 400 keeps its status and its sentence', async () => {
    // Every 400 the worker answers is something the operator can fix: a bad host,
    // a bad sha, a bad channel name. Flattening those into a retryable 503 would
    // tell them to wait for a fault that waiting cannot clear.
    worker({ error: 'evil.example.com is not a host the firmware takes code from' }, 400)
    const res = await POST(req('POST', BUNDLE, await auth()))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not a host/)
  })

  it('a worker 500 with an unparseable body is retryable, not a success', async () => {
    global.fetch = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 500 })) as any
    const res = await POST(req('POST', BUNDLE, await auth()))
    expect(res.status).toBe(503)
    expect((await res.json()).ok).toBe(false)
  })

  it('a fetch that throws is 503 retryable, not 400', async () => {
    global.fetch = vi.fn(async () => { throw new Error('timeout') }) as any
    const res = await POST(req('POST', BUNDLE, await auth()))
    expect(res.status).toBe(503)
    expect((await res.json()).retryable).toBe(true)
  })
})

describe('GET /api/firmware/manifest — the owner reads a channel', () => {
  it('anonymous → 401', async () => {
    expect((await GET(req('GET', null, undefined, '?channel=stable'))).status).toBe(401)
  })

  it('no channel → 400', async () => {
    expect((await GET(req('GET', null, await auth()))).status).toBe(400)
  })

  it('scopes to the session sub, not a client param', async () => {
    const seen = worker({ ok: true, bundle: { version: 'ota-1', url: GOOD_URL, sha256: GOOD_SHA } })
    const res = await GET(req('GET', null, await auth(), '?channel=stable&userId=attacker'))
    expect(res.status).toBe(200)
    expect(seen[0].url).toContain('userId=u1')
    expect(seen[0].url).not.toContain('attacker')
  })

  it('an empty channel is 200 with bundle null, not an error', async () => {
    worker({ ok: true, bundle: null })
    const res = await GET(req('GET', null, await auth(), '?channel=beta'))
    expect(res.status).toBe(200)
    expect((await res.json()).bundle).toBeNull()
  })

  it('an outage does NOT read as an empty channel', async () => {
    // The distinction this test exists for: `bundle: null` means "nothing
    // published", and a masked 5xx would say exactly that while OTA was down.
    global.fetch = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as any
    const res = await GET(req('GET', null, await auth(), '?channel=stable'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body).not.toHaveProperty('bundle')
  })
})

describe('PUT /api/firmware/manifest — the device asks', () => {
  it.each([
    ['no token', { deviceId: 'd1', channel: 'stable' }],
    ['no deviceId', { token: 'tind_x', channel: 'stable' }],
    ['no channel', { deviceId: 'd1', token: 'tind_x' }],
  ])('%s → 400, never reaches the worker', async (_why, body) => {
    const spy = vi.fn()
    global.fetch = spy as any
    expect((await PUT(req('PUT', body))).status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('needs no session and forwards only the token pair plus the channel', async () => {
    const seen = worker({ ok: true, bundle: { version: 'ota-1', url: GOOD_URL, sha256: GOOD_SHA } })
    const res = await PUT(req('PUT', { deviceId: 'd1', token: 'tind_secret', channel: 'stable' }))
    expect(res.status).toBe(200)
    const sent = JSON.parse(seen[0].init.body)
    // No userId is sent at all: the worker resolves the owner from the token's
    // stored hash.
    expect(Object.keys(sent).sort()).toEqual(['channel', 'deviceId', 'token'])
  })

  it('a caller-supplied userId is dropped, not forwarded', async () => {
    const seen = worker({ ok: true, bundle: null })
    await PUT(req('PUT', { deviceId: 'd1', token: 'tind_x', channel: 'stable', userId: 'victim' }))
    expect(seen[0].init.body).not.toContain('victim')
  })

  it('a revoked device gets 401 so it stops asking', async () => {
    // 424/503 would read as "the registry had a bad day", and a board on a
    // battery would poll that forever.
    worker({ error: 'unauthorized' }, 401)
    const res = await PUT(req('PUT', { deviceId: 'd1', token: 'tind_stale', channel: 'stable' }))
    expect(res.status).toBe(401)
  })

  it('nothing published → 200 bundle null (a first poll is not a failure)', async () => {
    worker({ ok: true, bundle: null })
    const res = await PUT(req('PUT', { deviceId: 'd1', token: 'tind_x', channel: 'beta' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, bundle: null })
  })

  it('an outage is 503 and carries no bundle key at all', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network') }) as any
    const res = await PUT(req('PUT', { deviceId: 'd1', token: 'tind_x', channel: 'stable' }))
    expect(res.status).toBe(503)
    expect(await res.json()).not.toHaveProperty('bundle')
  })
})

// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('devices-sql')

/**
 * Runs the worker's REAL device statements (DEVICE_*_SQL exports) against an
 * in-memory sqlite — D1 is sqlite, so semantics match. Pins the security
 * invariants of tiny-node PR2 (docs/tiny-node-goal.md §3):
 *   - heartbeat authenticates on (id, token_hash) AND revoked=0 — a revoked
 *     device and a wrong token are indistinguishable (0 rows changed, no oracle)
 *   - revoke is scoped to (id, user_id) — you cannot revoke another user's device
 *   - list excludes revoked and derives presence from last_seen
 *   - the SHA-256 token hash roundtrips (mint → hash → verify)
 * A copied query string would drift; the import means query changes MUST keep
 * these invariants or fail here.
 */
let SQL: any
let hashDeviceToken: (t: string) => Promise<string>
let sanitizeCapabilities: (raw: unknown) => string
let PRESENCE_WINDOW_S: number
let db: any

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('devices.ts') /* @vite-ignore */)
  SQL = mod
  hashDeviceToken = mod.hashDeviceToken
  sanitizeCapabilities = mod.sanitizeCapabilities
  PRESENCE_WINDOW_S = mod.PRESENCE_WINDOW_S
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  // Schema must track migrations: url/secret arrived with 0029 (endpoint
  // devices) and lan_url with 0032, and DEVICE_LIST_SQL selects both — a
  // fixture frozen at the old shape fails on the real statement rather than on
  // the behaviour.
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT, kind TEXT, capabilities TEXT, token_hash TEXT NOT NULL,
      last_seen INTEGER, created_at INTEGER, revoked INTEGER DEFAULT 0,
      url TEXT, secret TEXT,
      -- 0032: the LAN base a same-WiFi client dials directly
      lan_url TEXT NOT NULL DEFAULT ''
    );
  `)
})

// node:sqlite binds ?1-numbered params as NAMED params; D1's positional
// .bind(v) is identical.
const run = (sql: string, params: Record<number, any>) => db.prepare(sql).run(params)
const all = (sql: string, params: Record<number, any>) => db.prepare(sql).all(params)
const first = (sql: string, params: Record<number, any>) => db.prepare(sql).get(params)

async function enroll(id: string, userId: string, token: string, opts: any = {}) {
  const now = opts.now ?? 1000
  run(SQL.DEVICE_INSERT_SQL, {
    1: id, 2: userId, 3: opts.name ?? id, 4: opts.platform ?? 'darwin',
    5: opts.kind ?? 'cli', 6: sanitizeCapabilities(opts.capabilities ?? []),
    7: await hashDeviceToken(token), 8: now,
  })
}

describe.skipIf(!present)('worker DEVICE_*_SQL (real statements, real sqlite)', () => {
  it('token hash roundtrips (mint form → hash → verify)', async () => {
    const h1 = await hashDeviceToken('tind_abc')
    const h2 = await hashDeviceToken('tind_abc')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/) // SHA-256 hex, no plaintext
    expect(await hashDeviceToken('tind_other')).not.toBe(h1)
  })

  it('count excludes revoked devices', async () => {
    await enroll('d1', 'u1', 'tind_1')
    await enroll('d2', 'u1', 'tind_2')
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'd2', 2: 'u1' })
    expect((first(SQL.DEVICE_COUNT_SQL, { 1: 'u1' }) as any).n).toBe(1)
  })

  it('heartbeat succeeds only with the right token AND not revoked', async () => {
    await enroll('d3', 'u2', 'tind_live', { now: 1000 })
    // wrong token → 0 rows changed
    const wrong = run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'd3', 2: 2000, 3: null, 4: await hashDeviceToken('tind_wrong'), 5: null,
    })
    expect(wrong.changes).toBe(0)
    // right token → 1 row, last_seen advances
    const ok = run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'd3', 2: 2000, 3: null, 4: await hashDeviceToken('tind_live'), 5: null,
    })
    expect(ok.changes).toBe(1)
    expect((first('SELECT last_seen FROM devices WHERE id=?1', { 1: 'd3' }) as any).last_seen).toBe(2000)
  })

  it('a revoked device heartbeat is indistinguishable from a wrong token (0 rows, no oracle)', async () => {
    await enroll('d4', 'u2', 'tind_dead')
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'd4', 2: 'u2' })
    const res = run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'd4', 2: 3000, 3: null, 4: await hashDeviceToken('tind_dead'), // correct token!
    })
    expect(res.changes).toBe(0) // revoked=0 clause blocks it — same as a bad token
  })

  it('heartbeat with null capabilities keeps the existing value (COALESCE)', async () => {
    await enroll('d5', 'u2', 'tind_caps', { capabilities: ['shell', 'files'] })
    run(SQL.DEVICE_HEARTBEAT_SQL, { 1: 'd5', 2: 4000, 3: null, 4: await hashDeviceToken('tind_caps'), 5: null })
    expect((first('SELECT capabilities FROM devices WHERE id=?1', { 1: 'd5' }) as any).capabilities)
      .toBe(JSON.stringify(['shell', 'files']))
  })

  it('revoke is scoped to the owner — cannot revoke another user\'s device', async () => {
    await enroll('d6', 'owner', 'tind_x')
    const attacker = run(SQL.DEVICE_REVOKE_SQL, { 1: 'd6', 2: 'not-owner' })
    expect(attacker.changes).toBe(0) // wrong user_id → no-op
    expect((first('SELECT revoked FROM devices WHERE id=?1', { 1: 'd6' }) as any).revoked).toBe(0)
    const owner = run(SQL.DEVICE_REVOKE_SQL, { 1: 'd6', 2: 'owner' })
    expect(owner.changes).toBe(1)
  })

  it('list returns only non-revoked devices, newest-seen first', async () => {
    await enroll('a', 'u3', 'tind_a', { now: 100 })
    await enroll('b', 'u3', 'tind_b', { now: 300 })
    await enroll('c', 'u3', 'tind_c', { now: 200 })
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'c', 2: 'u3' })
    const rows = all(SQL.DEVICE_LIST_SQL, { 1: 'u3' })
    expect(rows.map((r: any) => r.id)).toEqual(['b', 'a']) // c revoked, ordered by last_seen DESC
  })

  it('presence window is a positive number of seconds', () => {
    expect(PRESENCE_WINDOW_S).toBeGreaterThan(0)
  })

  // ── lan_url (0032): the same-WiFi fast path ────────────────────────────────
  //
  // Reported as "the nicla vision is no longer streaming to ios — it says
  // connecting through the cloud but i'm at the same wifi". The app could only
  // learn the board's address from a UserDefaults cache (empty on a fresh
  // install) or a `stream` relay invoke — a cloud round trip measured at 4-32s
  // against the board's single-threaded loop. The heartbeat already arrived every
  // 30s; it just never carried the address.

  it('a heartbeat stores the LAN base, and the list hands it back', async () => {
    await enroll('lan1', 'u9', 'tind_lan')
    run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'lan1', 2: 5000, 3: null, 4: await hashDeviceToken('tind_lan'),
      5: 'http://192.168.1.207:8080',
    })
    const row: any = all(SQL.DEVICE_LIST_SQL, { 1: 'u9' }).find((r: any) => r.id === 'lan1')
    expect(row.lan_url, 'DEVICE_LIST_SQL must select lan_url or no client can see it')
      .toBe('http://192.168.1.207:8080')
  })

  it('a heartbeat WITHOUT a LAN base does not erase the stored one (COALESCE)', async () => {
    // The one that matters most: the loop beats ~2880x/day, so a single
    // non-coalescing UPDATE means the address survives 30 seconds and then is
    // blanked forever by the next tick — and the symptom is indistinguishable
    // from the bug being fixed.
    await enroll('lan2', 'u9', 'tind_keep')
    run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'lan2', 2: 5000, 3: null, 4: await hashDeviceToken('tind_keep'), 5: 'http://10.0.0.4:8080',
    })
    run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'lan2', 2: 5030, 3: null, 4: await hashDeviceToken('tind_keep'), 5: null,
    })
    expect((first('SELECT lan_url FROM devices WHERE id=?1', { 1: 'lan2' }) as any).lan_url)
      .toBe('http://10.0.0.4:8080')
  })

  it('a new address REPLACES the old one — DHCP moves the board', async () => {
    await enroll('lan3', 'u9', 'tind_dhcp')
    for (const base of ['http://192.168.1.207:8080', 'http://192.168.1.61:8080']) {
      run(SQL.DEVICE_HEARTBEAT_SQL, {
        1: 'lan3', 2: 6000, 3: null, 4: await hashDeviceToken('tind_dhcp'), 5: base,
      })
    }
    expect((first('SELECT lan_url FROM devices WHERE id=?1', { 1: 'lan3' }) as any).lan_url)
      .toBe('http://192.168.1.61:8080')
  })

  it('a wrong token cannot write an address — same gate as presence', async () => {
    // Otherwise anyone who learned a device id could point the owner's phone at
    // a host of their choosing, which is a far worse bug than slow discovery.
    await enroll('lan4', 'u9', 'tind_real')
    const res = run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'lan4', 2: 7000, 3: null, 4: await hashDeviceToken('tind_forged'),
      5: 'http://192.168.1.99:8080',
    })
    expect(res.changes).toBe(0)
    expect((first('SELECT lan_url FROM devices WHERE id=?1', { 1: 'lan4' }) as any).lan_url).toBe('')
  })
})

/**
 * 🏠 validateLanUrl — the EXACT INVERSE of validateEndpointUrl, and the inversion
 * is the security property.
 *
 * `url` is fetched BY THE WORKER, so it must be public: a private address there
 * is an SSRF pivot into Cloudflare's network (that rule is pinned in
 * endpoint-device.test.ts). `lan_url` is fetched only by the OWNER'S OWN PHONE
 * from inside the same house, so it must be private: a public address here means
 * the registry hands every client on the account a URL that dials a stranger's
 * server over plaintext http. Neither column may accept the other's values.
 */
describe.skipIf(!present)('validateLanUrl (private-only, the inverse guard)', () => {
  let validateLanUrl: (raw: unknown) => any
  let validateEndpointUrl: (raw: unknown) => any
  beforeAll(async () => {
    const mod = await import(workerFile('devices.ts') /* @vite-ignore */)
    validateLanUrl = mod.validateLanUrl
    validateEndpointUrl = mod.validateEndpointUrl
  })

  it('accepts every private IPv4 range a home router hands out', () => {
    for (const base of ['http://192.168.1.207:8080', 'http://10.0.0.4:8080',
                        'http://172.16.5.9:8080', 'http://172.31.255.254:8080',
                        'http://169.254.10.1:8080']) {
      expect(validateLanUrl(base), base).toEqual({ url: base })
    }
  })

  it('refuses a PUBLIC address — the whole point of the column', () => {
    for (const bad of ['http://1.2.3.4:8080', 'http://8.8.8.8', 'http://172.32.0.1:8080',
                       'http://192.169.1.1:8080', 'http://11.0.0.1']) {
      expect(validateLanUrl(bad), bad).toHaveProperty('error')
    }
  })

  it('refuses loopback — a phone dialing 127.0.0.1 dials ITSELF', () => {
    // The failure that looks like the feature working right up until it times
    // out, and 127.x is "private" under a naive reading.
    expect(validateLanUrl('http://127.0.0.1:8080')).toHaveProperty('error')
    expect(validateLanUrl('http://localhost:8080')).toHaveProperty('error')
  })

  it('refuses hostnames — resolving a name IS the discovery step being skipped', () => {
    for (const bad of ['http://tiny.local:8080', 'http://necklace:8080',
                       'http://plugin.tiny.technology']) {
      expect(validateLanUrl(bad), bad).toHaveProperty('error')
    }
  })

  it('obfuscated IP encodings cannot smuggle a public address past the guard', () => {
    // These are the classic SSRF-filter bypasses, and the reason they are safe
    // here is worth pinning rather than assuming: the WHATWG URL parser
    // CANONICALIZES them before the check runs, so hex/octal/dword all arrive as
    // a dotted quad and are judged on what they actually mean.
    for (const bad of ['http://0x7f.1',            // → 127.0.0.1, loopback
                       'http://2130706433',        // → 127.0.0.1, loopback
                       'http://0x08080808',        // → 8.8.8.8, public
                       'http://192.168.1.999:8080', // unparseable
                       'http://[::1]:8080']) {      // IPv6 loopback
      expect(validateLanUrl(bad), bad).toHaveProperty('error')
    }
  })

  it('a decoded private address is accepted AS ITS DECODED FORM, never the raw one', () => {
    // The security property behind the test above: what gets STORED is the
    // canonical origin, so a caller can never be handed a host string the guard
    // did not evaluate. If this ever returned the literal input, the octal form
    // would be a way to hand clients an address nothing had checked.
    expect(validateLanUrl('http://0300.0250.0.1')).toEqual({ url: 'http://192.168.0.1' })
    expect(validateLanUrl('http://3232235777')).toEqual({ url: 'http://192.168.1.1' })
  })

  it('refuses https and every non-http scheme', () => {
    // Not pedantry: the board serves plain http on the LAN, so an https value
    // here could only have come from somewhere else.
    for (const bad of ['https://192.168.1.207:8080', 'ftp://192.168.1.5',
                       'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(validateLanUrl(bad), bad).toHaveProperty('error')
    }
  })

  it('normalizes to an origin, dropping any path/query', () => {
    // Every caller builds `${lan_url}${path}`, so a stored path corrupts all of them.
    expect(validateLanUrl('http://192.168.1.207:8080/stream?x=1#f'))
      .toEqual({ url: 'http://192.168.1.207:8080' })
  })

  it('empty, whitespace and non-strings are errors, not empty successes', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
      expect(validateLanUrl(bad as any), String(bad)).toHaveProperty('error')
    }
  })

  it('the two validators reject each other\'s values — no column can take the other\'s', () => {
    // The invariant stated as a test, so a later "unify these" refactor fails
    // here instead of quietly opening an SSRF path or a plaintext-to-a-stranger path.
    const lan = 'http://192.168.1.207:8080'
    const pub = 'https://plugin.tiny.technology'
    expect(validateLanUrl(lan)).toEqual({ url: lan })
    expect(validateEndpointUrl(lan)).toHaveProperty('error')
    expect(validateEndpointUrl(pub)).toEqual({ url: pub })
    expect(validateLanUrl(pub)).toHaveProperty('error')
  })
})

/**
 * 🎙️ DEVICE_EVENT_AUTH_SQL — the PUSH half of the device model (a Nicla Voice
 * wake word), so it carries the same invariants heartbeat does plus one more:
 * it resolves the OWNER. That resolution is the security boundary. The caller
 * holding the token may be a relaying phone rather than the device itself, so
 * the user id must come from the row, never from the request body — otherwise a
 * device token would be enough to write onto a stranger's event ring, and the
 * ring is what the agent reads as ground truth about what happened.
 */
describe.skipIf(!present)('worker DEVICE_EVENT_AUTH_SQL (device → owner\'s ring)', () => {
  it('resolves the owner from the token, never from the caller', async () => {
    await enroll('vc1', 'owner-a', 'tind_voice', { platform: 'nicla-voice', name: 'tiny voice' })
    const row: any = first(SQL.DEVICE_EVENT_AUTH_SQL,
      { 1: 'vc1', 2: await hashDeviceToken('tind_voice') })
    expect(row?.user_id).toBe('owner-a')
    // The name is selected too: "heard 'alexa'" with no subject is
    // unattributable once a user owns two boards.
    expect(row?.name).toBe('tiny voice')
  })

  it('a wrong token and a revoked device are both simply no row (no oracle)', async () => {
    await enroll('vc2', 'owner-b', 'tind_live2', { platform: 'nicla-voice' })
    expect(first(SQL.DEVICE_EVENT_AUTH_SQL,
      { 1: 'vc2', 2: await hashDeviceToken('tind_wrong') })).toBeFalsy()
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'vc2', 2: 'owner-b' })
    // Correct token, revoked device — must still be nothing.
    expect(first(SQL.DEVICE_EVENT_AUTH_SQL,
      { 1: 'vc2', 2: await hashDeviceToken('tind_live2') })).toBeFalsy()
  })

  it('kind is an allowlist, not free text', async () => {
    const mod: any = await import(workerFile('devices.ts') /* @vite-ignore */)
    // Anything holding a device token can reach this route. Free-text kinds
    // would let a device forge a `device_result` or a scheduler fire onto the
    // ring the agent trusts.
    expect(mod.DEVICE_EVENT_KINDS).toContain('nicla_wake')
    expect(mod.DEVICE_EVENT_KINDS).not.toContain('device_result')
    expect(mod.DEVICE_EVENT_KINDS).not.toContain('scheduler')
  })
})

/**
 * DEVICE_ROTATE_TOKEN_SQL — adopt a device you own from a client that has no
 * token, WITHOUT re-enrolling the hardware.
 *
 * The alternative it replaces was destructive: enrolling the same board twice
 * mints a second row and leaves the first permanently offline in the fleet. So
 * these tests pin the two things that make rotation safe to prefer — it must
 * keep the row identity (id, history, transcripts all hang off the id), and it
 * must be no easier to steal a device with than revoke is.
 */
describe.skipIf(!present)('worker DEVICE_ROTATE_TOKEN_SQL (adopt without re-enrolling)', () => {
  it('the new token works and the OLD one stops working', async () => {
    await enroll('rt1', 'u-rot', 'tind_old', { now: 1000 })
    const res = run(SQL.DEVICE_ROTATE_TOKEN_SQL,
      { 1: 'rt1', 2: 'u-rot', 3: await hashDeviceToken('tind_new') })
    expect(res.changes).toBe(1)
    // Old credential is dead — a handover, not a share. Two clients holding
    // tokens for one BLE peripheral would fight over its single central slot.
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'rt1', 2: 2000, 3: null, 4: await hashDeviceToken('tind_old'), 5: null }).changes).toBe(0)
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'rt1', 2: 2000, 3: null, 4: await hashDeviceToken('tind_new'), 5: null }).changes).toBe(1)
  })

  it('keeps the row: same id, name, kind, capabilities and history', async () => {
    await enroll('rt2', 'u-rot', 'tind_a', {
      name: 'tiny voice', platform: 'nicla-voice', kind: 'daemon', capabilities: ['wake', 'record'], now: 500,
    })
    run(SQL.DEVICE_ROTATE_TOKEN_SQL, { 1: 'rt2', 2: 'u-rot', 3: await hashDeviceToken('tind_b') })
    const row: any = first(
      'SELECT id, name, platform, kind, capabilities, created_at, last_seen FROM devices WHERE id=?1', { 1: 'rt2' })
    // This is the whole point: events and transcripts are keyed by device id, so
    // preserving the row is what makes adoption non-destructive.
    expect(row.id).toBe('rt2')
    expect(row.name).toBe('tiny voice')
    expect(row.platform).toBe('nicla-voice')
    expect(row.kind).toBe('daemon')
    expect(row.capabilities).toBe(JSON.stringify(['wake', 'record']))
    expect(row.created_at).toBe(500)
  })

  it('is owner-scoped — cannot rotate another user\'s device', async () => {
    await enroll('rt3', 'owner', 'tind_mine')
    const attacker = run(SQL.DEVICE_ROTATE_TOKEN_SQL,
      { 1: 'rt3', 2: 'not-owner', 3: await hashDeviceToken('tind_stolen') })
    expect(attacker.changes).toBe(0)
    // And the owner's token must be untouched by the attempt.
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'rt3', 2: 9000, 3: null, 4: await hashDeviceToken('tind_mine'), 5: null }).changes).toBe(1)
  })

  it('refuses a REVOKED device — rotation must not resurrect a killed credential', async () => {
    await enroll('rt4', 'u-rot', 'tind_dead')
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'rt4', 2: 'u-rot' })
    const res = run(SQL.DEVICE_ROTATE_TOKEN_SQL,
      { 1: 'rt4', 2: 'u-rot', 3: await hashDeviceToken('tind_zombie') })
    // Revoke's guarantee is that the device is done. If rotate could re-key it,
    // "kill this device" would be undoable by the same session that killed it.
    expect(res.changes).toBe(0)
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'rt4', 2: 9000, 3: null, 4: await hashDeviceToken('tind_zombie'), 5: null }).changes).toBe(0)
  })

  it('refuses an ENDPOINT device — it has no inbound token by design', async () => {
    // Endpoint rows are inserted with token_hash = '' because they dial OUT and
    // authenticate via url+secret. Rotating one would mint a working INBOUND
    // credential for a device that must not have one.
    run(SQL.ENDPOINT_INSERT_SQL, {
      1: 'ep1', 2: 'u-rot', 3: 'printer', 4: 'http', 5: 'endpoint',
      6: sanitizeCapabilities(['print']), 7: 1000, 8: 'https://printer.example', 9: 'sekret',
    })
    const res = run(SQL.DEVICE_ROTATE_TOKEN_SQL,
      { 1: 'ep1', 2: 'u-rot', 3: await hashDeviceToken('tind_escalate') })
    expect(res.changes).toBe(0)
    expect((first('SELECT token_hash FROM devices WHERE id=?1', { 1: 'ep1' }) as any).token_hash).toBe('')
  })
})

/**
 * DEVICE_ADOPTABLE_BY_NAME_SQL + DEVICE_REENROLL_SQL — the duplicate-name guard.
 *
 * Measured 2026-08-14: a Nicla Vision whose flash had been wiped left THREE rows
 * named `tiny-ae1d` in one fleet, two of them dead on arrival, because enroll
 * inserted unconditionally. `enroll_vision.py` already refused this on the CLI
 * path ("the same orphan by another route") while the server did not, so the app
 * and the daemon had no way to be told.
 *
 * These tests pin the shape that makes adoption preferable to a 409. Refusing is
 * not available: tiny-tech/src/device.ts enrollDevice() re-enrolls automatically
 * whenever its identity file is gone or its heartbeat 401s, and throws when no
 * token comes back — a 409 would strand every daemon that lost device.json. So
 * the invariants are STALE-ONLY (a live namesake is a different device) plus the
 * same privilege guards rotation carries, since this path is reached with only a
 * session, never a device token.
 */
describe.skipIf(!present)('worker adopt-on-enroll (duplicate-name guard)', () => {
  const NOW = 1_800_000
  // What the handler binds as ?3: anything older than this is stale.
  const cutoff = () => NOW - PRESENCE_WINDOW_S
  const adoptable = (userId: string, name: string) =>
    first(SQL.DEVICE_ADOPTABLE_BY_NAME_SQL, { 1: userId, 2: name, 3: cutoff() }) as any

  it('a stale row with the same name is the one adopted', async () => {
    await enroll('ad1', 'u-ad', 'tind_lost', { name: 'tiny-ae1d', now: NOW - 600 })
    expect(adoptable('u-ad', 'tiny-ae1d')?.id).toBe('ad1')
  })

  it('a LIVE namesake is NOT adoptable — that would start a re-enroll war', async () => {
    // Two machines sharing a hostname are two devices. Stealing the token of one
    // that is heartbeating means it 401s, re-enrols, steals it back, forever —
    // and the symptom is both devices flickering offline rather than an error.
    await enroll('ad2', 'u-live', 'tind_here', { name: 'laptop', now: NOW - 5 })
    expect(adoptable('u-live', 'laptop')).toBeFalsy()
  })

  it('the boundary is the presence window, not "recently"', async () => {
    // Exactly at the cutoff is still live (`last_seen < ?3` is strict), one
    // second older is stale. Pinned because an off-by-one here decides whether a
    // working device gets its credential yanked.
    await enroll('ad3', 'u-edge', 'tind_edge', { name: 'edge', now: cutoff() })
    expect(adoptable('u-edge', 'edge')).toBeFalsy()
    run('UPDATE devices SET last_seen = ?2 WHERE id = ?1', { 1: 'ad3', 2: cutoff() - 1 })
    expect(adoptable('u-edge', 'edge')?.id).toBe('ad3')
  })

  it('a row that never once heartbeat (NULL last_seen) counts as stale', async () => {
    // The emptiest orphan of all: a failed enrolment. If NULL were treated as
    // "not stale" it would be the ONE state adoption can never clean up, and it
    // is the exact state the two dead tiny-ae1d rows were in.
    await enroll('ad4', 'u-null', 'tind_never', { name: 'never-seen' })
    run('UPDATE devices SET last_seen = NULL WHERE id = ?1', { 1: 'ad4' })
    expect(adoptable('u-null', 'never-seen')?.id).toBe('ad4')
  })

  it('a REVOKED row is never adoptable — revoke must stay enforceable', async () => {
    // This is the sharpest edge of the whole feature. A daemon re-enrols on the
    // very 401 that revoking causes, so if enroll adopted revoked rows, "revoke
    // this device" would be undone by the device itself within 30 seconds.
    await enroll('ad5', 'u-rev', 'tind_killed', { name: 'killed', now: NOW - 600 })
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'ad5', 2: 'u-rev' })
    expect(adoptable('u-rev', 'killed')).toBeFalsy()
    // And the UPDATE refuses independently — the SELECT is not the only gate,
    // because the row can be revoked between the two.
    expect(run(SQL.DEVICE_REENROLL_SQL, {
      1: 'ad5', 2: 'u-rev', 3: await hashDeviceToken('tind_zombie'),
      4: 'darwin', 5: 'cli', 6: sanitizeCapabilities([]),
    }).changes).toBe(0)
  })

  it('an ENDPOINT row is never adoptable — it has no inbound token by design', async () => {
    run(SQL.ENDPOINT_INSERT_SQL, {
      1: 'ad6', 2: 'u-ep', 3: 'printer', 4: 'http', 5: 'endpoint',
      6: sanitizeCapabilities(['print']), 7: NOW - 600, 8: 'https://printer.example', 9: 'sekret',
    })
    expect(adoptable('u-ep', 'printer')).toBeFalsy()
    // Same escalation as DEVICE_ROTATE_TOKEN_SQL: adopting one would mint a
    // working INBOUND credential for a device that must never have one.
    expect(run(SQL.DEVICE_REENROLL_SQL, {
      1: 'ad6', 2: 'u-ep', 3: await hashDeviceToken('tind_escalate'),
      4: 'http', 5: 'cli', 6: sanitizeCapabilities([]),
    }).changes).toBe(0)
    expect((first('SELECT token_hash FROM devices WHERE id=?1', { 1: 'ad6' }) as any).token_hash).toBe('')
  })

  it('is owner-scoped — a shared name across accounts adopts nothing', async () => {
    // "laptop" and "iphone" are the two commonest device names there are, so
    // without user_id in the WHERE this would hand strangers each other's rows.
    await enroll('ad7', 'user-a', 'tind_a', { name: 'laptop', now: NOW - 600 })
    expect(adoptable('user-b', 'laptop')).toBeFalsy()
    expect(run(SQL.DEVICE_REENROLL_SQL, {
      1: 'ad7', 2: 'user-b', 3: await hashDeviceToken('tind_stolen'),
      4: 'darwin', 5: 'cli', 6: sanitizeCapabilities([]),
    }).changes).toBe(0)
  })

  it('a different name adopts nothing — this is not a fuzzy match', async () => {
    await enroll('ad8', 'u-name', 'tind_n', { name: 'tiny-ae1d', now: NOW - 600 })
    for (const other of ['tiny-ae1e', 'tiny-ae1', 'tiny-ae1d ', 'TINY-AE1D']) {
      expect(adoptable('u-name', other), other).toBeFalsy()
    }
  })

  it('among several stale rows the most-recently-seen wins, and NULL is last resort', async () => {
    await enroll('ad9a', 'u-many', 'tind_1', { name: 'dup', now: NOW - 5000 })
    await enroll('ad9b', 'u-many', 'tind_2', { name: 'dup', now: NOW - 600 })
    await enroll('ad9c', 'u-many', 'tind_3', { name: 'dup', now: NOW - 900 })
    run('UPDATE devices SET last_seen = NULL WHERE id = ?1', { 1: 'ad9a' })
    // ORDER BY last_seen DESC, and sqlite sorts NULL last under DESC — so a row
    // that never heartbeat is only picked when nothing better exists.
    expect(adoptable('u-many', 'dup')?.id).toBe('ad9b')
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'ad9b', 2: 'u-many' })
    expect(adoptable('u-many', 'dup')?.id).toBe('ad9c')
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'ad9c', 2: 'u-many' })
    expect(adoptable('u-many', 'dup')?.id).toBe('ad9a')
  })

  it('re-enroll rotates the token and refreshes what the device says it is', async () => {
    await enroll('ad10', 'u-re', 'tind_before', {
      name: 'tiny-ae1d', platform: 'nicla-vision', kind: 'daemon',
      capabilities: ['stream'], now: NOW - 600,
    })
    const res = run(SQL.DEVICE_REENROLL_SQL, {
      1: 'ad10', 2: 'u-re', 3: await hashDeviceToken('tind_after'),
      4: 'nicla-vision', 5: 'daemon', 6: sanitizeCapabilities(['stream', 'snapshot']),
    })
    expect(res.changes).toBe(1)
    // New credential works, old one is dead — a handover, not a share.
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'ad10', 2: NOW, 3: null, 4: await hashDeviceToken('tind_before'), 5: null }).changes).toBe(0)
    const row: any = first(
      'SELECT id, name, created_at, capabilities FROM devices WHERE id=?1', { 1: 'ad10' })
    // The point of adopting instead of inserting: events and transcripts hang
    // off the id, so the row identity and its history must survive.
    expect(row.id).toBe('ad10')
    expect(row.name).toBe('tiny-ae1d')
    expect(row.created_at).toBe(NOW - 600)
    // …while capabilities follow the enroller, which is the authority on what
    // the hardware is NOW (a reflashed board can gain or lose a camera).
    expect(row.capabilities).toBe(JSON.stringify(['stream', 'snapshot']))
  })

  it('re-enroll does NOT mark the device seen — presence is earned by heartbeat', async () => {
    // Writing "seen now" here would show an unreachable board as online for a
    // full presence window after a failed provisioning, which is the single most
    // misleading state the fleet list can be in.
    await enroll('ad11', 'u-seen', 'tind_p', { name: 'stale-board', now: NOW - 600 })
    run(SQL.DEVICE_REENROLL_SQL, {
      1: 'ad11', 2: 'u-seen', 3: await hashDeviceToken('tind_p2'),
      4: 'nicla-vision', 5: 'daemon', 6: sanitizeCapabilities([]),
    })
    expect((first('SELECT last_seen FROM devices WHERE id=?1', { 1: 'ad11' }) as any).last_seen)
      .toBe(NOW - 600)
    // It is therefore STILL adoptable — a second lost token is not a second row.
    expect(adoptable('u-seen', 'stale-board')?.id).toBe('ad11')
  })

  it('the reported bug: three enrolments of one board leave ONE row', async () => {
    // The regression stated end to end. Each pass is a client that lost its
    // token re-enrolling the same hardware; before the guard each minted a row
    // and left the previous one frozen and offline in the owner's fleet.
    await enroll('orph', 'u-bug', 'tind_v1', { name: 'tiny-ae1d', now: NOW - 7 * 86_400 })
    for (const token of ['tind_v2', 'tind_v3']) {
      const target = adoptable('u-bug', 'tiny-ae1d')
      expect(target?.id, 'each re-enrolment must find the SAME row').toBe('orph')
      run(SQL.DEVICE_REENROLL_SQL, {
        1: target.id, 2: 'u-bug', 3: await hashDeviceToken(token),
        4: 'nicla-vision', 5: 'daemon', 6: sanitizeCapabilities(['stream']),
      })
    }
    expect((first(SQL.DEVICE_COUNT_SQL, { 1: 'u-bug' }) as any).n).toBe(1)
    // And the credential in hand is the last one issued.
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'orph', 2: NOW, 3: null, 4: await hashDeviceToken('tind_v3'), 5: null }).changes).toBe(1)
  })
})

describe.skipIf(!present)('sanitizeCapabilities (bounded, safe)', () => {
  it('passes a clean array through', () => {
    expect(sanitizeCapabilities(['shell', 'files'])).toBe(JSON.stringify(['shell', 'files']))
  })
  it('coerces non-array / garbage to []', () => {
    expect(sanitizeCapabilities('not json')).toBe('[]')
    expect(sanitizeCapabilities(null)).toBe('[]')
    expect(sanitizeCapabilities({ a: 1 })).toBe('[]')
  })
  it('parses a JSON-array string', () => {
    expect(sanitizeCapabilities('["a","b"]')).toBe(JSON.stringify(['a', 'b']))
  })
  it('bounds the entry count (<=32)', () => {
    const many = Array.from({ length: 100 }, (_, i) => `c${i}`)
    expect(JSON.parse(sanitizeCapabilities(many)).length).toBe(32)
  })
})

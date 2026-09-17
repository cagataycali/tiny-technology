// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('device-enroll-adopt')

/**
 * 🔁 POST /device/enroll ADOPTS a stale row instead of minting a duplicate.
 *
 * Runs the REAL DeviceEnrollCall.handle over a D1 shim on in-memory sqlite, so
 * these pin the HANDLER's decisions rather than the SQL — devices-sql.test.ts
 * already covers the statements. The decisions only visible here are the ones
 * that broke: the order of the adopt attempt against the device cap, that
 * endpoint enrolments never take this path at all, and that a row which stops
 * being adoptable between the SELECT and the UPDATE falls through to a fresh
 * insert instead of returning a token that authenticates nothing.
 *
 * Reported 2026-08-14: a Nicla Vision whose flash had been wiped left THREE rows
 * named `tiny-ae1d` in one fleet, two frozen and offline. `enroll_vision.py`
 * refused a second row on the CLI path; the server did not, so the iOS app and
 * the daemon had no way to be told. Refusing here is not an option either —
 * tiny-tech/src/device.ts enrollDevice() re-enrols automatically when its
 * identity file is gone and throws if no token comes back, so a 409 would strand
 * every daemon that lost device.json.
 */
const KEY = 'internal-test-key'
let mod: any
let db: any
let env: any

/** The slice of D1 this handler uses: prepare().bind().first()/run(). */
function d1(database: any) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          // node:sqlite binds ?1-numbered params as NAMED params; D1 takes them
          // positionally. Same values, same order.
          const params: Record<number, any> = {}
          args.forEach((v, i) => { params[i + 1] = v })
          const stmt = database.prepare(sql)
          return {
            first: async () => stmt.get(params) ?? null,
            all: async () => ({ results: stmt.all(params) }),
            run: async () => {
              const r = stmt.run(params)
              return { meta: { changes: Number(r.changes) } }
            },
          }
        },
      }
    },
  }
}

const req = (key = KEY) =>
  new Request('https://worker.test/device/enroll', {
    method: 'POST', headers: { 'x-internal-key': key },
  })

async function enrollCall(body: any, key = KEY) {
  const route = new mod.DeviceEnrollCall({})
  const res: Response = await route.handle(req(key), env, {}, { body })
  return { status: res.status, body: await res.json() as any }
}

const rows = (userId: string) =>
  db.prepare('SELECT * FROM devices WHERE user_id = ?1 ORDER BY created_at').all({ 1: userId }) as any[]

const NOW = () => Math.floor(Date.now() / 1000)

beforeAll(async () => {
  if (!present) return
  mod = await import(workerFile('devices.ts') /* @vite-ignore */)
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT, kind TEXT, capabilities TEXT, token_hash TEXT NOT NULL,
      last_seen INTEGER, created_at INTEGER, revoked INTEGER DEFAULT 0,
      url TEXT, secret TEXT, lan_url TEXT NOT NULL DEFAULT ''
    );
  `)
  env = { INTERNAL_API_KEY: KEY, DB: d1(db) }
})

beforeEach(() => {
  if (present) db.exec('DELETE FROM devices')
})

describe.skipIf(!present)('POST /device/enroll — adopt instead of duplicating', () => {
  it('the reported bug: enrolling the same board three times leaves ONE row', async () => {
    const body = { userId: 'u1', name: 'tiny-ae1d', platform: 'nicla-vision', kind: 'daemon' }
    const first = await enrollCall(body)
    expect(first.body.device_id).toBeTruthy()
    expect(first.body.adopted).toBeUndefined() // nothing to adopt yet

    // Age the row past the presence window: the board lost its token and the
    // client is re-enrolling, which is the whole scenario.
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })

    const second = await enrollCall(body)
    expect(second.body.adopted).toBe(true)
    expect(second.body.device_id).toBe(first.body.device_id)
    expect(second.body.device_token).not.toBe(first.body.device_token)

    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })
    const third = await enrollCall(body)
    expect(third.body.device_id).toBe(first.body.device_id)
    expect(rows('u1')).toHaveLength(1)
  })

  it('the adopted token works and the previous one is dead', async () => {
    const body = { userId: 'u2', name: 'board', kind: 'daemon' }
    const before = await enrollCall(body)
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })
    const after = await enrollCall(body)

    const beat = async (token: string) => {
      const hash = await mod.hashDeviceToken(token)
      return Number(db.prepare(mod.DEVICE_HEARTBEAT_SQL)
        .run({ 1: after.body.device_id, 2: NOW(), 3: null, 4: hash, 5: null }).changes)
    }
    expect(await beat(after.body.device_token)).toBe(1)
    expect(await beat(before.body.device_token)).toBe(0)
  })

  it('a LIVE namesake gets a NEW row — two machines can share a hostname', async () => {
    // The device that is still heartbeating keeps its credential. Handing its
    // token to the newcomer would start a re-enroll war (it 401s, re-enrols,
    // steals back) and both would flicker offline instead of erroring.
    const body = { userId: 'u3', name: 'laptop', kind: 'cli' }
    const live = await enrollCall(body)
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() }) // seen just now
    const other = await enrollCall(body)
    expect(other.body.adopted).toBeUndefined()
    expect(other.body.device_id).not.toBe(live.body.device_id)
    expect(rows('u3')).toHaveLength(2)
  })

  it('adoption is checked BEFORE the device cap — a full fleet can still re-key', async () => {
    // An adoption adds no row, so the cap has nothing to protect against here.
    // With the checks in the other order, a fleet at MAX turns a lost token into
    // permanently unreachable hardware: enroll 400s and there is no other way
    // back, because the plaintext is only ever returned once.
    const MAX = 20
    for (let i = 0; i < MAX; i++) {
      const r = await enrollCall({ userId: 'u4', name: `dev-${i}`, kind: 'cli' })
      expect(r.body.device_id, `enrol ${i} should fit under the cap`).toBeTruthy()
    }
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })
    // A 21st NEW device is refused…
    const overflow = await enrollCall({ userId: 'u4', name: 'one-too-many', kind: 'cli' })
    expect(overflow.status).toBe(400)
    expect(String(overflow.body.error)).toMatch(/device limit reached/)
    // …while re-keying one it already owns still works.
    const adopt = await enrollCall({ userId: 'u4', name: 'dev-7', kind: 'cli' })
    expect(adopt.body.adopted).toBe(true)
    expect(adopt.body.device_token).toBeTruthy()
    expect(rows('u4')).toHaveLength(MAX)
  })

  it('a revoked namesake is NOT adopted — a fresh row is minted instead', async () => {
    // Revoke's guarantee is that the credential is dead, and a daemon re-enrols
    // on the very 401 revoking causes. Adopting here would let the device undo
    // its own revocation within one heartbeat.
    const body = { userId: 'u5', name: 'killed', kind: 'daemon' }
    const original = await enrollCall(body)
    db.prepare('UPDATE devices SET last_seen = ?1, revoked = 1').run({ 1: NOW() - 600 })
    const again = await enrollCall(body)
    expect(again.body.adopted).toBeUndefined()
    expect(again.body.device_id).not.toBe(original.body.device_id)
    // The revoked row stays revoked — and stays out of the fleet list.
    expect(db.prepare('SELECT revoked FROM devices WHERE id=?1')
      .get({ 1: original.body.device_id }).revoked).toBe(1)
    expect(db.prepare(mod.DEVICE_LIST_SQL).all({ 1: 'u5' }).map((r: any) => r.id))
      .toEqual([again.body.device_id])
  })

  it('an ENDPOINT enrolment never adopts — its row has no inbound token', async () => {
    // Endpoint devices are authenticated by url+secret and stored with
    // token_hash = ''. Adopting one would mint a working inbound credential for
    // a device that must never have one, so this path is skipped by KIND rather
    // than by anything the caller controls per-request.
    const body = {
      userId: 'u6', name: 'printer', kind: 'endpoint',
      url: 'https://printer.example', secret: 'sekret',
    }
    const first = await enrollCall(body)
    expect(first.body.kind).toBe('endpoint')
    expect(first.body.device_token).toBeUndefined()
    const second = await enrollCall(body)
    expect(second.body.adopted).toBeUndefined()
    expect(second.body.device_token).toBeUndefined()
    expect(rows('u6')).toHaveLength(2)
    for (const r of rows('u6')) expect(r.token_hash).toBe('')
  })

  it('an endpoint enrolment never adopts a stale pull-kind namesake', async () => {
    // The mirror of the test above, and the one the SQL alone cannot enforce:
    // DEVICE_ADOPTABLE_BY_NAME_SQL only excludes endpoint ROWS, so without the
    // isEndpointKind gate in the handler, registering a printer named after a
    // stale daemon would adopt that daemon — returning an inbound token, and
    // returning it BEFORE url/secret are ever validated, so the printer itself
    // would never be stored.
    const daemon = await enrollCall({ userId: 'u15', name: 'printer', kind: 'daemon' })
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })
    const hashBefore = db.prepare('SELECT token_hash FROM devices WHERE id=?1')
      .get({ 1: daemon.body.device_id }).token_hash

    const ep = await enrollCall({
      userId: 'u15', name: 'printer', kind: 'endpoint',
      url: 'https://printer.example', secret: 'sekret',
    })
    expect(ep.body.adopted).toBeUndefined()
    expect(ep.body.device_token).toBeUndefined()
    expect(ep.body.kind).toBe('endpoint')
    expect(ep.body.device_id).not.toBe(daemon.body.device_id)
    // The endpoint row exists with its credentials, and the daemon is untouched.
    const stored: any = rows('u15').find((r: any) => r.id === ep.body.device_id)
    expect(stored.url).toBe('https://printer.example')
    expect(stored.secret).toBe('sekret')
    expect(db.prepare('SELECT token_hash, kind FROM devices WHERE id=?1')
      .get({ 1: daemon.body.device_id })).toEqual({ token_hash: hashBefore, kind: 'daemon' })
  })

  it('a pull-kind enrolment never adopts an endpoint row of the same name', async () => {
    // The same escalation from the other direction: a caller who knows the name
    // of the owner's printer must not be able to ask for a token for it.
    await enrollCall({
      userId: 'u7', name: 'printer', kind: 'endpoint',
      url: 'https://printer.example', secret: 'sekret',
    })
    const sneaky = await enrollCall({ userId: 'u7', name: 'printer', kind: 'daemon' })
    expect(sneaky.body.adopted).toBeUndefined()
    expect(sneaky.body.device_id).toBeTruthy()
    const printer: any = rows('u7').find((r: any) => r.kind === 'endpoint')
    expect(printer.token_hash).toBe('')
    expect(printer.secret).toBe('sekret')
  })

  it('adoption is owner-scoped — another account\'s stale namesake is untouched', async () => {
    const victim = await enrollCall({ userId: 'owner', name: 'laptop', kind: 'cli' })
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })
    const hashBefore = db.prepare('SELECT token_hash FROM devices WHERE id=?1')
      .get({ 1: victim.body.device_id }).token_hash

    const attacker = await enrollCall({ userId: 'attacker', name: 'laptop', kind: 'cli' })
    expect(attacker.body.adopted).toBeUndefined()
    expect(attacker.body.device_id).not.toBe(victim.body.device_id)
    expect(db.prepare('SELECT token_hash FROM devices WHERE id=?1')
      .get({ 1: victim.body.device_id }).token_hash).toBe(hashBefore)
  })

  it('an over-long name still matches its own stored row', async () => {
    // NAME_MAX-slicing happens on insert, so comparing the RAW name would never
    // match and every attempt would mint another duplicate — the exact bug, in
    // the exact place it was introduced. Both sides must use the stored form.
    const name = 'n'.repeat(200)
    const first = await enrollCall({ userId: 'u8', name, kind: 'cli' })
    expect(db.prepare('SELECT name FROM devices WHERE id=?1')
      .get({ 1: first.body.device_id }).name).toHaveLength(64)
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })
    const second = await enrollCall({ userId: 'u8', name, kind: 'cli' })
    expect(second.body.adopted).toBe(true)
    expect(rows('u8')).toHaveLength(1)
  })

  it('adoption refreshes platform/kind/capabilities but never last_seen', async () => {
    // The enroller is the authority on what the hardware is NOW (a reflashed
    // board gains or loses a camera), but presence is earned by a heartbeat: a
    // "seen now" written here would show an unreachable board as online for a
    // full window after a failed provisioning.
    await enrollCall({
      userId: 'u9', name: 'board', platform: 'nicla-voice', kind: 'cli',
      capabilities: ['wake'],
    })
    const stale = NOW() - 600
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: stale })
    const adopted = await enrollCall({
      userId: 'u9', name: 'board', platform: 'nicla-vision', kind: 'daemon',
      capabilities: ['stream', 'snapshot'],
    })
    expect(adopted.body.adopted).toBe(true)
    const row: any = rows('u9')[0]
    expect(row.platform).toBe('nicla-vision')
    expect(row.kind).toBe('daemon')
    expect(row.capabilities).toBe(JSON.stringify(['stream', 'snapshot']))
    expect(row.last_seen).toBe(stale)
  })

  it('an adopted token has the same shape as a freshly minted one', async () => {
    // Clients parse and store this; a differently-shaped token from the adopt
    // path would fail somewhere far from here. `tind_` + base64url(32 bytes).
    const body = { userId: 'u10', name: 'shape', kind: 'cli' }
    const fresh = await enrollCall(body)
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })
    const adopted = await enrollCall(body)
    for (const t of [fresh.body.device_token, adopted.body.device_token]) {
      expect(t).toMatch(/^tind_[A-Za-z0-9_-]{43}$/)
    }
  })

  it('an unknown kind is normalized on the adopt path too, not stored raw', async () => {
    // The insert path allowlists kind against PULL_KINDS; if adoption skipped
    // that, a caller could write free text into the column every other route
    // dispatches on.
    await enrollCall({ userId: 'u13', name: 'board', kind: 'cli' })
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })
    const adopted = await enrollCall({ userId: 'u13', name: 'board', kind: 'endpoint-ish' })
    expect(adopted.body.adopted).toBe(true)
    expect((rows('u13')[0] as any).kind).toBe('cli')
  })

  it('a row revoked between the SELECT and the UPDATE falls through to a fresh insert', async () => {
    // The race the `changes > 0` check exists for. Returning the token anyway
    // would install a credential that authenticates nothing, and the client
    // would surface it much later as an unexplained permanently-offline device
    // rather than as a failed enrolment.
    const original = await enrollCall({ userId: 'u14', name: 'racy', kind: 'cli' })
    db.prepare('UPDATE devices SET last_seen = ?1').run({ 1: NOW() - 600 })

    const inner = env.DB
    let armed = true
    env = {
      ...env,
      DB: {
        prepare(sql: string) {
          const stmt = inner.prepare(sql)
          if (!armed || sql !== mod.DEVICE_ADOPTABLE_BY_NAME_SQL) return stmt
          return {
            bind: (...a: any[]) => {
              const bound = stmt.bind(...a)
              return {
                ...bound,
                first: async () => {
                  const row = await bound.first()
                  armed = false
                  // …and the owner revokes it right here.
                  db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?1').run({ 1: row.id })
                  return row
                },
              }
            },
          }
        },
      },
    }
    try {
      const res = await enrollCall({ userId: 'u14', name: 'racy', kind: 'cli' })
      expect(res.body.device_token).toBeTruthy()
      expect(res.body.adopted).toBeUndefined()
      expect(res.body.device_id).not.toBe(original.body.device_id)
      // The returned credential must actually work on the row it names.
      expect(Number(db.prepare(mod.DEVICE_HEARTBEAT_SQL).run({
        1: res.body.device_id, 2: NOW(), 3: null,
        4: await mod.hashDeviceToken(res.body.device_token), 5: null,
      }).changes)).toBe(1)
    } finally {
      env = { ...env, DB: inner }
    }
  })

  it('still requires the internal key — adoption adds no unauthenticated path', async () => {
    const res = await enrollCall({ userId: 'u11', name: 'x', kind: 'cli' }, 'wrong-key')
    expect(res.status).toBe(401)
    expect(rows('u11')).toHaveLength(0)
  })

  it('a name that is only whitespace is still refused before anything is looked up', async () => {
    const res = await enrollCall({ userId: 'u12', name: '   ', kind: 'cli' })
    expect(res.status).toBe(400)
    expect(rows('u12')).toHaveLength(0)
  })
})

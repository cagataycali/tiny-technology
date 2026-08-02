// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('media-device-auth')

/**
 * Device-scoped media upload — MEDIA_DEVICE_AUTH_SQL against real sqlite.
 *
 * Why this exists: the tiny necklace is a camera and mic worn on a chain, and
 * it used to need an account-wide bearer JWT in its flash to reach /api/media.
 * Anyone who picked up the necklace held the whole account. Now it uploads on
 * its own enrolled device token and the WORKER resolves the owner from the
 * token's stored hash — so the credential on the board is narrow, revocable,
 * and cannot name a user.
 *
 * Same invariants as relay poll/reply (RELAY_DEVICE_AUTH_SQL), pinned here
 * because a media upload attributes a photo of someone's living room to an
 * account, and getting the owner wrong leaks it to the wrong one:
 *   - the token must hash-match THAT device id
 *   - a revoked device resolves to nobody
 *   - the caller never supplies the owner
 */
let MEDIA_DEVICE_AUTH_SQL: string
let hashDeviceToken: (t: string) => Promise<string>
let db: any

beforeAll(async () => {
  if (!present) return
  const media = await import(workerFile('media.ts') /* @vite-ignore */)
  const devices = await import(workerFile('devices.ts') /* @vite-ignore */)
  MEDIA_DEVICE_AUTH_SQL = media.MEDIA_DEVICE_AUTH_SQL
  hashDeviceToken = devices.hashDeviceToken
  // @ts-expect-error node:sqlite ships with Node 22+
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT, kind TEXT, capabilities TEXT, token_hash TEXT NOT NULL,
      last_seen INTEGER, created_at INTEGER, revoked INTEGER DEFAULT 0
    );
  `)
})

const first = (sql: string, params: Record<number, any>) => db.prepare(sql).get(params)
const skip = () => !present

async function enroll(id: string, userId: string, token: string, revoked = 0) {
  db.prepare(
    `INSERT INTO devices (id, user_id, name, platform, kind, capabilities,
                          token_hash, last_seen, created_at, revoked)
     VALUES (?1, ?2, ?3, 'nicla', 'daemon', '[]', ?4, 0, 0, ?5)`
  ).run({ 1: id, 2: userId, 3: `dev-${id}`, 4: await hashDeviceToken(token), 5: revoked })
}

describe('MEDIA_DEVICE_AUTH_SQL — a necklace uploads as itself', () => {
  it.skipIf(skip())('resolves the owner from a correct (id, token) pair', async () => {
    await enroll('neck-1', 'user-alice', 'tind_alicenecklace')
    const row: any = first(MEDIA_DEVICE_AUTH_SQL, {
      1: 'neck-1', 2: await hashDeviceToken('tind_alicenecklace'),
    })
    expect(row?.user_id).toBe('user-alice')
  })

  it.skipIf(skip())('rejects the right token presented for the wrong device', async () => {
    await enroll('neck-2', 'user-bob', 'tind_bobnecklace')
    // Bob's real token, Alice's device id: a valid credential is not a
    // universal one, or a stolen necklace could upload into any account.
    const row: any = first(MEDIA_DEVICE_AUTH_SQL, {
      1: 'neck-1', 2: await hashDeviceToken('tind_bobnecklace'),
    })
    expect(row).toBeFalsy()
  })

  it.skipIf(skip())('rejects a wrong token for a real device', async () => {
    const row: any = first(MEDIA_DEVICE_AUTH_SQL, {
      1: 'neck-1', 2: await hashDeviceToken('tind_guess'),
    })
    expect(row).toBeFalsy()
  })

  it.skipIf(skip())('stops resolving the moment the device is revoked', async () => {
    await enroll('neck-lost', 'user-alice', 'tind_lostnecklace')
    const before: any = first(MEDIA_DEVICE_AUTH_SQL, {
      1: 'neck-lost', 2: await hashDeviceToken('tind_lostnecklace'),
    })
    expect(before?.user_id).toBe('user-alice')

    // Losing the necklace is the threat model this whole change exists for:
    // revoke must cut uploads instantly, with the token still in its flash.
    db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?1').run({ 1: 'neck-lost' })
    const after: any = first(MEDIA_DEVICE_AUTH_SQL, {
      1: 'neck-lost', 2: await hashDeviceToken('tind_lostnecklace'),
    })
    expect(after).toBeFalsy()
  })

  it.skipIf(skip())('never stores the token itself, only its hash', async () => {
    const row: any = first('SELECT token_hash FROM devices WHERE id = ?1', { 1: 'neck-1' })
    expect(row.token_hash).not.toContain('tind_')
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it.skipIf(skip())('an unknown device id resolves to nobody', async () => {
    const row: any = first(MEDIA_DEVICE_AUTH_SQL, {
      1: 'no-such-device', 2: await hashDeviceToken('tind_whatever'),
    })
    expect(row).toBeFalsy()
  })
})

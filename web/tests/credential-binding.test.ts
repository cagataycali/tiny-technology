// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('credential-binding')

/**
 * 🔐 CredentialAddCall credential-binding integrity (users.ts) — a WebAuthn
 * credential id may NOT be re-bound to a different account.
 *
 * `credentials.id` is the PRIMARY KEY and originates from the AUTHENTICATOR's
 * attestation, not the server. The old `INSERT OR REPLACE` overwrote the whole
 * row on an id collision, so a crafted authenticator presenting a credentialId
 * already owned by another user would silently reassign that row's user_id +
 * public_key — stealing/destroying the victim's passkey (login resolves a
 * credential to its owner by id). WebAuthn ids are globally unique, so a
 * cross-user collision is never legitimate.
 *
 * This pins the REAL statement the handler runs against sqlite (mirroring
 * scheduler-ownership.test.ts): an atomic upsert whose DO UPDATE only fires for
 * the SAME user; a different-user conflict changes 0 rows and is rejected 409.
 */
let db: any

// The exact statement CredentialAddCall.handle runs (positional ?N → ordered args).
const UPSERT = `INSERT INTO credentials (id, user_id, public_key, sign_count, transports, label)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     public_key = excluded.public_key,
     sign_count = excluded.sign_count,
     transports = excluded.transports,
     label = excluded.label
   WHERE credentials.user_id = excluded.user_id`

// Mirrors the handler: run the upsert, return true iff a row changed (else 409).
const addCredential = (
  credentialId: string, userId: string, publicKey: string,
  signCount = 0, transports: string[] = [], label = 'passkey'
): boolean => {
  const info = db.prepare(UPSERT).run(
    credentialId, userId, publicKey, signCount, JSON.stringify(transports), label
  )
  return Number(info.changes) > 0
}

const ownerOf = (credId: string): string | undefined =>
  db.prepare('SELECT user_id FROM credentials WHERE id = ?').get(credId)?.user_id

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node@17 predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL,
      sign_count INTEGER DEFAULT 0, transports TEXT, label TEXT,
      created INTEGER DEFAULT (unixepoch())
    );
  `)
})

describe.skipIf(!present)('CredentialAddCall credential-binding (real sqlite)', () => {
  it('a fresh credential id inserts (changes=1 → ok)', () => {
    expect(addCredential('cred-A', 'alice', 'pk-alice')).toBe(true)
    expect(ownerOf('cred-A')).toBe('alice')
  })

  it("rejects re-binding an existing credential id to ANOTHER user (the hijack fix)", () => {
    addCredential('cred-A', 'alice', 'pk-alice')
    // Mallory's authenticator presents the same id → must NOT overwrite.
    expect(addCredential('cred-A', 'mallory', 'pk-mallory')).toBe(false)
    // The victim's binding is intact — still alice, still her public key.
    expect(ownerOf('cred-A')).toBe('alice')
    expect(db.prepare('SELECT public_key FROM credentials WHERE id = ?').get('cred-A').public_key)
      .toBe('pk-alice')
  })

  it('allows the SAME user to idempotently re-register (sign_count / label refresh)', () => {
    addCredential('cred-A', 'alice', 'pk-alice', 5, [], 'phone')
    expect(addCredential('cred-A', 'alice', 'pk-alice-rotated', 9, ['internal'], 'laptop')).toBe(true)
    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get('cred-A')
    expect(row.user_id).toBe('alice')
    expect(row.public_key).toBe('pk-alice-rotated')
    expect(row.sign_count).toBe(9)
    expect(row.label).toBe('laptop')
  })

  it('distinct ids per user coexist (normal multi-passkey case)', () => {
    expect(addCredential('cred-A', 'alice', 'pk1')).toBe(true)
    expect(addCredential('cred-B', 'alice', 'pk2')).toBe(true)
    expect(addCredential('cred-C', 'bob', 'pk3')).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS c FROM credentials').get().c).toBe(3)
  })
})

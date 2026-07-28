// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('account-voice-write')

/**
 * 🔇 AN UNKNOWN VOICE SILENTLY ERASED THE USER'S ACCOUNT DEFAULT.
 *
 * `normalizeAccountVoice` returned `''` for anything not on the allowlist, and
 * `AccountVoiceSetCall` wrote that straight into `users.voice` and answered
 * `{ ok: true, voice }`. `''` is an explicit CLEAR downstream, so a typo — or any
 * non-picker client (mobile, script, the MCP surface) sending a name this
 * worker's list doesn't have — destroyed a preference the user had set, while
 * reporting success. The user's next call fell back to 'marin' with nothing to
 * explain it.
 *
 * What makes it a class rather than a slip: the same-named, same-shaped
 * `normalizeVoice` in upsert.ts returns `undefined` for unknown, meaning
 * PRESERVE. Two functions, one look, opposite consequences — and the one that
 * destroys data is the one whose return type (`string`) cannot express "don't
 * write". So the fix is not just a branch: the write path returns a union, and
 * the read path keeps its own (correct, lenient) behaviour under a name that
 * says which direction it is for.
 *
 * Runs the REAL handler against real sqlite (D1 is sqlite), because the bug was
 * in the handler's use of the normalizer, not in the normalizer alone.
 */
let parseAccountVoiceWrite: (v: any) => { voice: string } | { error: string }
let readAccountVoice: (v: any) => string
let ACCOUNT_VOICE_NAMES: readonly string[]
let AccountVoiceSetCall: any
let AccountVoiceGetCall: any
let db: any

const KEY = 'internal-test-key'
const env = () => ({ INTERNAL_API_KEY: KEY, DB: fakeD1() })

/** D1's prepare/bind/run/first over node:sqlite — anonymous `?` binds POSITIONALLY. */
function fakeD1() {
  return {
    prepare(sql: string) {
      const params: any[] = []
      const api = {
        bind(...args: any[]) { params.push(...args); return api },
        async run() { return db.prepare(sql).run(...params) },
        async first() { return db.prepare(sql).get(...params) ?? null },
      }
      return api
    },
  }
}

const post = (body: any, key = KEY) =>
  new AccountVoiceSetCall().handle(
    new Request('https://w/account-voice', { method: 'POST', headers: { 'x-internal-key': key } }),
    env(), {}, { body },
  )

const get = (userId: string) =>
  new AccountVoiceGetCall().handle(
    new Request(`https://w/account-voice?userId=${encodeURIComponent(userId)}`, {
      headers: { 'x-internal-key': KEY },
    }),
    env(), {}, {},
  )

const stored = (id: string) => (db.prepare('SELECT voice FROM users WHERE id = ?').get(id) as any)?.voice

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('account-voice.ts') /* @vite-ignore */)
  parseAccountVoiceWrite = mod.parseAccountVoiceWrite
  readAccountVoice = mod.readAccountVoice
  ACCOUNT_VOICE_NAMES = mod.ACCOUNT_VOICE_NAMES
  AccountVoiceSetCall = mod.AccountVoiceSetCall
  AccountVoiceGetCall = mod.AccountVoiceGetCall
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, voice TEXT);`)
})

describe.skipIf(!present)('parseAccountVoiceWrite — the write decision', () => {
  it("🔴 an unknown voice is REFUSED, not turned into a clear", () => {
    const out = parseAccountVoiceWrite('marinn')
    expect('error' in out).toBe(true)
    // The whole bug in one assertion: the old function returned '' here, and ''
    // means "clear the user's default".
    expect((out as any).voice).toBeUndefined()
  })

  it('the refusal says what was rejected and what is accepted', () => {
    const out = parseAccountVoiceWrite('Scarlett')
    if (!('error' in out)) throw new Error('expected a refusal')
    expect(out.error).toContain('scarlett')      // echoes the value, lowercased as compared
    expect(out.error).toContain('marin')          // lists the real options
    expect(out.error).toMatch(/clear/i)           // and how to actually clear
  })

  it("'' is still an explicit clear — that intent is real", () => {
    expect(parseAccountVoiceWrite('')).toEqual({ voice: '' })
    expect(parseAccountVoiceWrite('   ')).toEqual({ voice: '' })
  })

  it('every allowlisted voice is accepted, case/space insensitively', () => {
    for (const v of ACCOUNT_VOICE_NAMES) {
      expect(parseAccountVoiceWrite(v), v).toEqual({ voice: v })
      expect(parseAccountVoiceWrite(` ${v.toUpperCase()} `), v).toEqual({ voice: v })
    }
  })

  it('🔴 absent/degraded input is refused too, since a clear must be asked for', () => {
    // Every one of these is a shape a truncated body, a JSON-parse fallback or a
    // mis-typed client produces — and every one of them STRINGIFIES TO '', which
    // is the destructive instruction. Measured while writing this test:
    // `String([])` is '', so an array body cleared the default under a
    // `String(v ?? '')` parse. So the guard is "is it a string", not "is it
    // nullish": refusing only null/undefined leaves the same hole open.
    for (const bad of [undefined, null, {}, [], 42, true]) {
      expect('error' in parseAccountVoiceWrite(bad as any), JSON.stringify(bad) ?? 'undefined').toBe(true)
    }
  })
})

describe.skipIf(!present)('readAccountVoice — the read decision is deliberately different', () => {
  it('a junk value already in the column reads as unset', () => {
    // Lenient on READ is correct: app/api/voice/session re-validates against its
    // own allowlist, so a stored junk voice produces a marin call. Reporting the
    // raw value would show a selected voice in Settings that no call ever uses.
    expect(readAccountVoice('nonesuch')).toBe('')
    expect(readAccountVoice(null)).toBe('')
    expect(readAccountVoice('CEDAR')).toBe('cedar')
  })

  it('the two directions really do disagree — that is the design, so pin it', () => {
    expect(readAccountVoice('nonesuch')).toBe('')
    expect('error' in parseAccountVoiceWrite('nonesuch')).toBe(true)
  })
})

describe.skipIf(!present)('AccountVoiceSetCall (real handler, real sqlite)', () => {
  it('🔴 a bad voice leaves a previously-set default UNTOUCHED', async () => {
    db.prepare('INSERT INTO users (id, voice) VALUES (?, ?)').run('u1', 'cedar')

    const res = await post({ userId: 'u1', voice: 'cedarr' })
    expect(res.status).toBe(400)
    expect((await res.json()).ok).toBeUndefined()

    // The assertion the old code failed: the column, not the response.
    expect(stored('u1')).toBe('cedar')
  })

  it('🔴 and it does NOT report success', async () => {
    db.prepare('INSERT INTO users (id, voice) VALUES (?, ?)').run('u2', 'sage')
    const body = await (await post({ userId: 'u2', voice: 'ballade' })).json()
    // `{ ok: true }` beside a destroyed preference is worse than either alone:
    // the client stops asking and the user has no error to report.
    expect(body.ok).not.toBe(true)
    expect(String(body.error)).toMatch(/ballade/)
    expect(stored('u2')).toBe('sage')
  })

  it('a good voice is stored and echoed in its canonical form', async () => {
    db.prepare('INSERT INTO users (id, voice) VALUES (?, ?)').run('u3', '')
    const res = await post({ userId: 'u3', voice: ' Verse ' })
    expect(res.status).toBe(200)
    expect((await res.json())).toEqual({ ok: true, voice: 'verse' })
    expect(stored('u3')).toBe('verse')
  })

  it("'' clears an existing default", async () => {
    db.prepare('INSERT INTO users (id, voice) VALUES (?, ?)').run('u4', 'echo')
    expect((await (await post({ userId: 'u4', voice: '' })).json())).toEqual({ ok: true, voice: '' })
    expect(stored('u4')).toBe('')
  })

  it('still requires the internal key and a userId', async () => {
    expect((await post({ userId: 'u1', voice: 'echo' }, 'wrong')).status).toBe(401)
    expect((await post({ voice: 'echo' })).status).toBe(400)
  })

  it('GET reports what a call would actually use', async () => {
    db.prepare('INSERT INTO users (id, voice) VALUES (?, ?)').run('u5', 'garbage-from-before-the-fix')
    expect((await (await get('u5')).json())).toEqual({ ok: true, voice: '' })
  })
})

describe('the bridge route refuses a body with no voice field', () => {
  // Not worker-gated: this file is in the parent repo.
  const src = readFileSync('app/api/account-voice/route.ts', 'utf8')

  it("🔴 doesn't coerce a missing voice into a clear", () => {
    // `String(voice ?? '')` on a truncated body is '' — an explicit clear. The
    // route must distinguish "clear it" from "you sent nothing".
    expect(src).not.toContain("String(voice ?? '')")
    expect(src).toMatch(/typeof \(body as any\)\.voice !== 'string'/)
    // …and the refusal has to be a refusal, not a logged concern.
    const guard = src.indexOf("typeof (body as any).voice !== 'string'")
    const fetchAt = src.indexOf('fetch(`${WORKER_URL}/account-voice`')
    expect(guard).toBeGreaterThan(-1)
    expect(fetchAt).toBeGreaterThan(guard)
    expect(src.slice(guard, fetchAt)).toContain('return json(')
  })

  it('passes a rejected voice back as 400, not as a dependency failure', () => {
    // 424 tells a client "upstream is sick, retry" — for a value that can never
    // work, that is an infinite retry of the user's typo.
    expect(src).toContain('400 : 424')
  })
})

describe('the collision that caused this is named, not just fixed', () => {
  it('the destructive `string`-returning normalizer is gone', () => {
    // Any remaining `normalizeAccountVoice` is either the old body or a new
    // caller of a name whose semantics were the defect.
    const src = readFileSync('worker/src/account-voice.ts', 'utf8')
    expect(src).not.toContain('normalizeAccountVoice')
  })

  it('upsert.ts keeps its OPPOSITE (preserve-on-unknown) semantics untouched', () => {
    // The per-tiny path is not broken — a partial upsert must not blank the
    // tiny's voice. Pinned so a future "make these consistent" pass has to
    // notice they are consistent about the DIRECTION, not the return value.
    const src = readFileSync('worker/src/upsert.ts', 'utf8')
    expect(src).toContain('export function normalizeVoice(v: any): string | undefined')
  })
})

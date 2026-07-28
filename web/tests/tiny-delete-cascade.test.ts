// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('tiny-delete-cascade')

/**
 * 🔒 A TINY SLUG IS A LEASE, NOT AN IDENTITY.
 *
 * `DELETE /tiny` frees the name and `upsert.ts`'s `ON CONFLICT(name) DO NOTHING`
 * lets anybody claim it next — names are free and first-come. Meanwhile private
 * turn memory (`notes`, migration 0019) is indexed into Vectorize with metadata
 * `{ name }` — the SLUG — and recalled by that same slug. Four individually
 * correct decisions therefore composed into a CROSS-TENANT PRIVATE-TRANSCRIPT
 * LEAK: user B claims A's deleted slug, marks it private, sends one message, and
 * A's transcripts come back as `Memory:` context in B's system prompt.
 *
 * Nothing about that chain is findable by grepping for a symbol, because the bug
 * is an ABSENCE — no `user_id` predicate on the read, no `notes` in the cascade.
 * So this suite asserts the two things that close it, plus the ordering rule that
 * makes the route's own "idempotent re-run works" promise true:
 *
 *   1. the recall read is OWNER-scoped, not just slug-scoped (the security half)
 *   2. delete removes `notes` + their vectors (the retention half)
 *   3. `tinys` — the row that AUTHORIZES this route — is deleted LAST
 *   4. a manifest test that fails when a migration adds a slug-keyed column
 *      nobody wired into the cascade
 *
 * There was no delete/cascade test anywhere in the repo before this one.
 */
let del: any
let retrieve: any
let db: any

const OWNER = 'user-alice'
const CLAIMER = 'user-bob'
const SLUG = 'diary'

// Every statement under test uses ANONYMOUS `?` placeholders (delete.ts and
// notesReadSql both build them), and node:sqlite binds those positionally —
// the `{1: v}` named form used by devices-sql/locations-sql is for `?1`-numbered
// SQL and throws "Unknown named parameter '1'" here.

/**
 * A minimal D1 shim over node:sqlite, matching the surface delete.ts uses:
 * prepare().bind().first() / .all() / .run(). Real statements, real sqlite.
 */
function d1(sqlite: any) {
  return {
    prepare(sql: string) {
      let bound: any[] = []
      const api: any = {
        bind(...vals: any[]) { bound = vals; return api },
        async first() { return sqlite.prepare(sql).get(...bound) ?? null },
        async all() { return { results: sqlite.prepare(sql).all(...bound) } },
        async run() { return sqlite.prepare(sql).run(...bound) },
      }
      return api
    },
  }
}

/** Records what each store was asked to delete, and in what order. */
function makeEnv(sqlite: any, opts: { failJobs?: boolean } = {}) {
  const order: string[] = []
  const memoryDeleted: string[] = []
  const kv = new Map<string, any>()
  kv.set(SLUG, { name: SLUG, private: true, key: 'legacy-key' })
  const inner = d1(sqlite)
  return {
    order,
    memoryDeleted,
    kv,
    env: {
      INTERNAL_API_KEY: 'test-key',
      tiny: {
        async get(name: string) { return kv.get(name) ?? null },
        async delete(name: string) { order.push('kv'); kv.delete(name) },
      },
      VECTOR_INDEX: { async deleteByIds() { order.push('vector_index') } },
      MEMORY: {
        async deleteByIds(ids: string[]) { order.push('memory'); memoryDeleted.push(...ids) },
      },
      DB: {
        prepare(sql: string) {
          const api = inner.prepare(sql)
          const tag = /DELETE FROM (\w+)/.exec(sql)?.[1] ?? /UPDATE (\w+)/.exec(sql)?.[1]
          const wrapped: any = {
            bind: (...v: any[]) => { api.bind(...v); return wrapped },
            first: () => api.first(),
            all: () => api.all(),
            run: async () => {
              if (tag) order.push(`d1:${tag}`)
              // Simulate a mid-cascade failure to prove the re-run promise.
              if (opts.failJobs && tag === 'jobs') throw new Error('simulated D1 failure')
              return api.run()
            },
          }
          return wrapped
        },
      },
    } as any,
  }
}

const req = () =>
  new Request('https://w/tiny', {
    method: 'DELETE',
    headers: { 'X-Internal-Key': 'test-key', 'Content-Type': 'application/json' },
  })

beforeAll(async () => {
  if (!present) return
  del = await import(workerFile('delete.ts') /* @vite-ignore */)
  retrieve = await import(workerFile('retrieve.ts') /* @vite-ignore */)
})

function freshDb(sqlite: any) {
  sqlite.exec(`DELETE FROM tinys; DELETE FROM notes; DELETE FROM jobs; DELETE FROM job_runs; DELETE FROM telegram_bots;`)
  sqlite.prepare(`INSERT INTO tinys (name, user_id) VALUES (?, ?)`).run(SLUG, OWNER)
  // Alice's private transcripts, keyed on the SLUG (turns.ts's write shape).
  sqlite.prepare(`INSERT INTO notes (id, name, user_id, text) VALUES (?, ?, ?, ?)`)
    .run(101, SLUG, OWNER, 'User: my therapist said\nAssistant: that sounds hard')
  sqlite.prepare(`INSERT INTO notes (id, name, user_id, text) VALUES (?, ?, ?, ?)`)
    .run(102, SLUG, OWNER, 'User: the password is hunter2\nAssistant: noted')
}

let sqlite: any
beforeAll(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  sqlite = new DatabaseSync(':memory:')
  // Real migration bytes for `notes`; the others mirror their own migrations.
  const notesSql = readFileSync(
    workerFile('../migrations/0019_notes.sql'), 'utf8',
  ).replace(/^--.*$/gm, '')
  sqlite.exec(notesSql)
  sqlite.exec(`
    CREATE TABLE tinys (name TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, user_id TEXT, tiny_slug TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE job_runs (id TEXT PRIMARY KEY, job_id TEXT);
    CREATE TABLE telegram_bots (user_id TEXT, tiny_slug TEXT, enabled INTEGER DEFAULT 1);
  `)
})

beforeEach(() => { if (present) freshDb(sqlite) })

describe.skipIf(!present)('the recall read is owner-scoped, not slug-scoped', () => {
  // The security half. retrieve.ts filters vectors by { name } and joins on the
  // vector id; the ONLY thing standing between a slug's new holder and the old
  // holder's transcripts is this predicate.
  it('🔴 a slug\'s NEW owner cannot read the PREVIOUS owner\'s notes', () => {
    const ids = [101, 102]
    const sql = retrieve.notesReadSql(ids.length)

    // Alice — the author — gets her own rows back.
    const mine = sqlite.prepare(sql).all(...ids, OWNER)
    expect(mine.map((r: any) => r.id)).toEqual([101, 102])

    // Bob, holding the same slug and therefore the same vector ids, gets NOTHING.
    // Without `AND user_id = ?` this returns both of Alice's transcripts.
    const theirs = sqlite.prepare(sql).all(...ids, CLAIMER)
    expect(theirs).toEqual([])
  })

  it('the predicate is on the STATEMENT, so no call site can forget it', () => {
    // Asserting the shape, not the behaviour: a future refactor that rebuilds
    // the query inline is exactly how the predicate got lost the first time.
    expect(retrieve.notesReadSql(2)).toBe(
      'SELECT * FROM notes WHERE id IN (?, ?) AND user_id = ?',
    )
    expect(retrieve.notesReadSql(1)).toContain('AND user_id = ?')
  })

  it('the real retrieve.ts source binds an owner id, never the ids alone', () => {
    const src = readFileSync(workerFile('retrieve.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    expect(src).toContain('notesReadSql(vecIds.length)')
    expect(src).toContain('.bind(...vecIds, ownerUserId)')
    // The pre-fix statement must be gone from the file entirely.
    expect(src).not.toMatch(/SELECT \* FROM notes WHERE id IN \(\$\{placeholders\}\)`/)
  })
})

describe.skipIf(!present)('delete cascades to private turn memory', () => {
  it('🔴 removes the notes AND their MEMORY vectors', async () => {
    const { env, memoryDeleted } = makeEnv(sqlite)
    const res: any = await new del.TinyDeleteCall().handle(req(), env, {}, {
      body: { name: SLUG, userId: OWNER },
    })
    expect(res.status).toBe(200)

    // The transcripts are gone from D1…
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM notes WHERE name = ?`).get(SLUG).n).toBe(0)
    // …and their vectors are gone from the shared index. An orphaned vector
    // still matches the { name } filter, which is how the leak stayed silent.
    expect(memoryDeleted.sort()).toEqual(['101', '102'])
  })

  it('reads the vector ids BEFORE deleting the rows', async () => {
    // Ordering matters for a reason a passing "rows are gone" test can't see:
    // after the DELETE there is nothing left to name the vectors. If the ids
    // were read after, memoryDeleted would be empty and D1 would look clean.
    const { env, memoryDeleted } = makeEnv(sqlite)
    await new del.TinyDeleteCall().handle(req(), env, {}, { body: { name: SLUG, userId: OWNER } })
    expect(memoryDeleted.length).toBe(2)
  })

  it('a tiny with no notes deletes cleanly and touches no vectors', async () => {
    sqlite.exec(`DELETE FROM notes`)
    const { env, memoryDeleted } = makeEnv(sqlite)
    const res: any = await new del.TinyDeleteCall().handle(req(), env, {}, {
      body: { name: SLUG, userId: OWNER },
    })
    expect(res.status).toBe(200)
    expect(memoryDeleted).toEqual([])
  })
})

describe.skipIf(!present)('the authorization row is deleted LAST', () => {
  it('🔴 tinys is the final write, after every dependent store', async () => {
    const { env, order } = makeEnv(sqlite)
    await new del.TinyDeleteCall().handle(req(), env, {}, { body: { name: SLUG, userId: OWNER } })
    expect(order.at(-1)).toBe('d1:tinys')
    // and it is written exactly once
    expect(order.filter((o) => o === 'd1:tinys').length).toBe(1)
    // every dependent store ran before it
    for (const store of ['d1:notes', 'd1:jobs', 'd1:job_runs', 'd1:telegram_bots']) {
      expect(order.indexOf(store), `${store} must precede tinys`).toBeLessThan(order.indexOf('d1:tinys'))
      expect(order.indexOf(store), `${store} must run`).toBeGreaterThanOrEqual(0)
    }
  })

  it('🔴 a mid-cascade failure leaves the re-run POSSIBLE, and SAYS so', async () => {
    // The file promises "idempotent re-run works". Reading authorization from
    // `tinys` and deleting `tinys` first made that impossible: the re-run hit
    // 404 and the orphaned jobs kept firing forever against an empty /get.
    //
    // Ordering alone does NOT deliver this — every store has its own try/catch,
    // so a swallowed failure still falls through to the final delete. The route
    // has to collect the failures and withhold it. Measured: with ordering but
    // no collection, tinys was deleted anyway and the retry got a 404.
    const first = makeEnv(sqlite, { failJobs: true })
    const failedRes: any = await new del.TinyDeleteCall().handle(req(), first.env, {}, {
      body: { name: SLUG, userId: OWNER },
    })

    // Told the truth rather than reporting ok over a half-deleted tiny.
    expect(failedRes.status).toBe(500)
    const failedBody = await failedRes.json()
    expect(failedBody.ok).toBeUndefined()
    expect(failedBody.stores).toContain('jobs')
    // The copy must not claim nothing changed — the KV config is already gone.
    expect(failedBody.error).not.toMatch(/untouched|nothing (was )?changed/i)

    // The jobs delete threw, so tinys must still be there to authorize a retry.
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM tinys WHERE name = ?`).get(SLUG).n).toBe(1)

    const retry = makeEnv(sqlite)
    const res: any = await new del.TinyDeleteCall().handle(req(), retry.env, {}, {
      body: { name: SLUG, userId: OWNER },
    })
    expect(res.status).toBe(200)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM tinys WHERE name = ?`).get(SLUG).n).toBe(0)
  })

  it('a MEMORY vector failure blocks the delete; a search-index one does not', async () => {
    // These two look alike and are not. An orphaned universe-search vector
    // degrades results; an orphaned MEMORY vector still matches the { name }
    // recall filter, so leaving one behind while freeing the slug IS the leak.
    const memFail = makeEnv(sqlite)
    memFail.env.MEMORY = { async deleteByIds() { throw new Error('vectorize down') } }
    const blocked: any = await new del.TinyDeleteCall().handle(req(), memFail.env, {}, {
      body: { name: SLUG, userId: OWNER },
    })
    expect(blocked.status).toBe(500)
    expect((await blocked.json()).stores).toContain('turn-memory-vectors')
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM tinys WHERE name = ?`).get(SLUG).n).toBe(1)

    freshDb(sqlite)
    const searchFail = makeEnv(sqlite)
    searchFail.env.VECTOR_INDEX = { async deleteByIds() { throw new Error('vectorize down') } }
    const ok: any = await new del.TinyDeleteCall().handle(req(), searchFail.env, {}, {
      body: { name: SLUG, userId: OWNER },
    })
    // A search-index outage must not make a tiny undeletable.
    expect(ok.status).toBe(200)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM tinys WHERE name = ?`).get(SLUG).n).toBe(0)
  })

  it('a non-owner is still refused, and nothing is deleted', async () => {
    const { env, order } = makeEnv(sqlite)
    const res: any = await new del.TinyDeleteCall().handle(req(), env, {}, {
      body: { name: SLUG, userId: CLAIMER },
    })
    expect(res.status).toBe(403)
    expect(order).toEqual([])
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM notes`).get().n).toBe(2)
  })
})

describe.skipIf(!present)('the cascade manifest stays honest', () => {
  it('every slug-keyed store in the migrations appears in TINY_OWNED_STORES', () => {
    // A cascade bug is defined by ABSENCE, so the check has to enumerate the
    // schema rather than search the code. When a migration adds a table with a
    // tiny_slug/tiny_name column, this fails until someone decides — in the
    // manifest, in writing — whether delete should reach it.
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const dir = workerFile('../migrations')
    const sql = readdirSync(dir)
      .filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => readFileSync(`${dir}/${f}`, 'utf8'))
      .join('\n')
      .replace(/^\s*--.*$/gm, '')

    // Arrays, not Sets: the repo's tsc target has no --downlevelIteration, so
    // spreading a Set or a matchAll iterator is a type error here.
    const found: string[] = []
    const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([^;]*?)\)\s*;/gs
    let m: RegExpExecArray | null
    while ((m = re.exec(sql)) !== null) {
      const [, table, cols] = m
      if (/\b(tiny_slug|tiny_name)\b/.test(cols) && found.indexOf(table) === -1) found.push(table)
    }
    // `notes` names its slug column `name`, and `tinys` IS the slug table.
    for (const t of ['notes', 'tinys']) if (found.indexOf(t) === -1) found.push(t)

    const declared = del.TINY_OWNED_STORES.map((s: any) => s.store)
    const missing = found.filter((t) => declared.indexOf(t) === -1)
    expect(missing, `slug-keyed store(s) absent from TINY_OWNED_STORES: ${missing.join(', ')}`).toEqual([])
  })

  it('every handled store is actually written by the route', () => {
    // The mirror check: a manifest entry claiming coverage the code doesn't
    // provide is worse than no manifest, because it reads as researched.
    const src = readFileSync(workerFile('delete.ts'), 'utf8')
    // Only the body, not the manifest itself — otherwise every entry matches
    // its own declaration and the assertion is vacuous.
    const body = src.slice(src.indexOf('async handle('))
    for (const s of del.TINY_OWNED_STORES.filter((x: any) => x.handled)) {
      expect(body, `${s.store} is declared handled but never written`).toMatch(
        new RegExp(`(DELETE FROM|UPDATE) ${s.store}\\b`),
      )
    }
  })

  it('every unhandled store states WHY, in prose', () => {
    for (const s of del.TINY_OWNED_STORES.filter((x: any) => !x.handled)) {
      expect(s.how.length, `${s.store} needs a reason, not a blank`).toBeGreaterThan(20)
    }
  })
})

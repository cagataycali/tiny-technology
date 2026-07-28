// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('memory-wipe')

/**
 * "Forget everything" did not forget.
 *
 * The memory graph is bitemporal on purpose: retiring a fact (unlearn one,
 * supersede) sets `valid_to` and KEEPS the row, so provenance, freshness
 * badges and the history view all keep working. That is the right rule for
 * retirement and the wrong rule for a wipe — and clear-all used the same
 * statement:
 *
 *     UPDATE entity SET valid_to = ?1 WHERE owner = ?2 AND valid_to IS NULL
 *
 * The row survives with the memory VERBATIM in two columns — `label` (first
 * 80 chars) and `attrs_json.$.source` (the whole thing) — and three read
 * paths select exactly those columns when `include_closed` is on:
 * RECENT_ALL_SQL, ALL_NODES_SQL(true) and BY_VEC_SQL(n, true). All three are
 * reachable by the user who asked to be forgotten: `include_closed=1` on
 * GET /learnings and GET /graph, the "History" toggle in the web MemoryPanel
 * and the iOS MemoryGraph, and tiny-tech's `include_history` flag.
 *
 * The promise on the other side is unambiguous. The `unlearn` tool's own
 * description says clear-all "purges the semantic index and is NOT
 * recoverable"; the note handed back to the agent says "Cleared ALL
 * server-side memories and purged the semantic index — this is not
 * recoverable"; the handler's own comment said "'wipe my memory' means gone
 * from every surface". The vectors really were purged. The text was not.
 *
 * So a wipe DELETEs — facts and the user's own edges (whose `scope` column is
 * caller-supplied text that ALL_EDGES_SQL returns, so it is content too).
 *
 * The organising rule, and the reason this is not a one-line SQL swap: a
 * graceful default inherited from a NEIGHBOURING operation is still a
 * decision. "Never hard-delete" was true of retirement and was applied to
 * erasure without re-asking what erasure means.
 *
 * Runs the REAL migrations and the REAL handler against node:sqlite.
 */

let L: any, g: any, db: any
let MIG_LEARNINGS: string, MIG_GRAPH: string

beforeAll(async () => {
  if (!present) return
  L = await import(workerFile('learnings.ts') /* @vite-ignore */)
  g = await import(workerFile('graph.ts') /* @vite-ignore */)
  const mig = (n: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', n), 'utf8')
  MIG_LEARNINGS = mig('0005_learnings.sql')
  MIG_GRAPH = mig('0012_memory_graph.sql')
})

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; the repo's @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(MIG_LEARNINGS)
  db.exec(MIG_GRAPH)
  deleted.length = 0
})

const all = (sql: string, ...binds: any[]) => db.prepare(sql).all(...binds)

/** D1 shim: node:sqlite binds `?N` as NAMED params, D1's .bind() is positional. */
const d1 = () => ({
  prepare(sql: string) {
    const binds: any[] = []
    const args = () => {
      const clean = binds.map(b => (b === undefined ? null : b))
      if (!/\?\d/.test(sql)) return clean
      const named: any = {}
      clean.forEach((v, i) => { named[String(i + 1)] = v })
      return [named]
    }
    const stmt: any = {
      bind(...a: any[]) { binds.push(...a); return stmt },
      async run() {
        const r = db.prepare(sql).run(...args())
        return { meta: { changes: Number(r.changes || 0) } }
      },
      async first() { return db.prepare(sql).get(...args()) ?? null },
      async all() { return { results: db.prepare(sql).all(...args()) } },
    }
    return stmt
  },
  // D1 batch: sequential, results in order — what the handler indexes into.
  async batch(stmts: any[]) {
    const out: any[] = []
    for (const s of stmts) out.push(await s.run())
    return out
  },
})

const deleted: string[] = []
const makeEnv = () => ({
  DB: d1(),
  INTERNAL_API_KEY: 'k',
  MEMORY: {
    async upsert() { /* not used here */ },
    async query() { return { matches: [] } },
    async deleteByIds(ids: string[]) { deleted.push(...ids) },
  },
})

const req = (body: any) => new Request('https://w/learnings', {
  method: 'DELETE',
  headers: { 'x-internal-key': 'k', 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Drive the real DELETE handler. */
const wipe = async (env: any, body: any): Promise<any> => {
  const res: Response = await new L.LearningsDeleteCall({ skipValidation: true })
    .handle(req(body), env, {}, { body })
  return { status: res.status, body: await res.json() }
}

/** Seed facts exactly the way LearningsAddCall writes them (dual-write). */
const seed = async (env: any, owner: string, contents: string[]) => {
  const ids: string[] = []
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i]
    const row = db.prepare('INSERT INTO learnings (user_id, content, created) VALUES (?, ?, ?) RETURNING id')
      .get(owner, c, 1000 + i)
    ids.push(await g.insertFactEntity(env, {
      owner, content: c, legacyId: Number(row.id), created: 1000 + i,
    }))
  }
  return ids
}

const SECRETS = [
  'I am in therapy for depression',
  'my HIV test came back positive',
  'my partner does not know',
]

describe.skipIf(!present)('wipe: "forget everything" leaves nothing readable', () => {
  it('THE REGRESSION: after a wipe, every history surface renders NOTHING', async () => {
    const env = makeEnv()
    await seed(env, 'u1', SECRETS)

    const { body } = await wipe(env, { userId: 'u1' })
    expect(body.ok).toBe(true)
    expect(body.deleted).toBe(3)

    // The three read paths that take `include_closed` — the ones the user
    // reaches through a History toggle. Each one used to return all three
    // secrets with freshness:'closed'.
    const recent = all(g.RECENT_ALL_SQL, { 1: 'u1', 2: 100 })
    const nodes = all(g.ALL_NODES_SQL(true), { 1: 'u1', 2: 500 })
    const byVec = all(g.BY_VEC_SQL(3, true), 'u1', 'learning:1', 'learning:2', 'learning:3')
    expect(recent).toEqual([])
    expect(nodes).toEqual([])
    expect(byVec).toEqual([])

    // Render everything those surfaces could possibly serialize and assert
    // the sensitive strings appear NOWHERE. Column-by-column assertions miss
    // a column; this does not.
    const rendered = JSON.stringify({
      recent, nodes, byVec,
      entity: all("SELECT * FROM entity WHERE owner = 'u1'"),
      edge: all("SELECT * FROM edge WHERE owner = 'u1'"),
      learnings: all("SELECT * FROM learnings WHERE user_id = 'u1'"),
      freshness: all(g.FRESHNESS_SQL(3), 'u1', 'mig12:1', 'mig12:2', 'mig12:3'),
      nodesById: all(g.NODES_SQL(3), 'u1', 'mig12:1', 'mig12:2', 'mig12:3'),
    })
    for (const s of SECRETS) expect(rendered).not.toContain(s)
    // …and not the truncated label copy either (80-char prefix).
    for (const s of SECRETS) expect(rendered).not.toContain(s.slice(0, 20))
  })

  it('the ROW is gone, not merely marked closed', async () => {
    const env = makeEnv()
    await seed(env, 'u1', SECRETS)
    await wipe(env, { userId: 'u1' })
    // The pre-fix state was: 3 rows, valid_to set, source intact. Assert on
    // the raw table so no read-path filter can hide a survivor.
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u1'").at(0).c).toBe(0)
    expect(all("SELECT COUNT(*) AS c FROM learnings WHERE user_id = 'u1'").at(0).c).toBe(0)
  })

  it('still purges the vectors — the half that already worked', async () => {
    const env = makeEnv()
    await seed(env, 'u1', SECRETS)
    await wipe(env, { userId: 'u1' })
    expect(deleted.sort()).toEqual(['learning:1', 'learning:2', 'learning:3'])
  })

  it('deletes the wiper\'s OWN edges, including the scope text they typed', async () => {
    const env = makeEnv()
    const [a, b] = await seed(env, 'u1', SECRETS)
    // A relates_to edge with a scope — scope is caller text, and
    // ALL_EDGES_SQL returns it, so it is content like any other.
    await g.insertEdges(env, {
      owner: 'u1', src: a,
      edges: [{ rel: 'relates_to', dst: b, scope: 'the clinic on Keizersgracht' }],
    })
    expect(all("SELECT COUNT(*) AS c FROM edge WHERE owner = 'u1'").at(0).c).toBe(1)

    await wipe(env, { userId: 'u1' })
    expect(all("SELECT COUNT(*) AS c FROM edge WHERE owner = 'u1'").at(0).c).toBe(0)
    expect(JSON.stringify(all(g.ALL_EDGES_SQL(true), { 1: 'u1', 2: 500 })))
      .not.toContain('Keizersgracht')
  })

  it('a supersedes edge does not block the delete (edges go FIRST)', async () => {
    // entity.id is referenced by edge.src/dst. Deleting parents before
    // children is how you get a FOREIGN KEY failure — and a thrown wipe
    // returns 500 with the memories still there.
    const env = makeEnv()
    db.exec('PRAGMA foreign_keys = ON')
    const ids = await seed(env, 'u1', SECRETS)
    await g.supersede(env, { owner: 'u1', newId: ids[2], closeIds: [ids[0], ids[1]], now: 900 })
    expect(all("SELECT COUNT(*) AS c FROM edge WHERE owner = 'u1'").at(0).c).toBe(2)

    const { status, body } = await wipe(env, { userId: 'u1' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u1'").at(0).c).toBe(0)
    expect(all("SELECT COUNT(*) AS c FROM edge WHERE owner = 'u1'").at(0).c).toBe(0)
  })

  it('counts FACTS, not edges — `deleted` is a number of memories', async () => {
    // A densely linked graph has MORE edges than facts, which is the only
    // arrangement that can catch this: reading the wrong batch result tells the
    // user 5 memories were erased when they had 3, and `deleted` is the only
    // number the agent gets to quote back to them.
    const env = makeEnv()
    const ids = await seed(env, 'u1', SECRETS)
    await g.insertEdges(env, {
      owner: 'u1', src: ids[0],
      edges: [{ rel: 'relates_to', dst: ids[1] }, { rel: 'about', dst: ids[2] }],
    })
    await g.insertEdges(env, {
      owner: 'u1', src: ids[1],
      edges: [{ rel: 'relates_to', dst: ids[2] }, { rel: 'about', dst: ids[0] }],
    })
    const edges = all("SELECT COUNT(*) AS c FROM edge WHERE owner = 'u1'").at(0).c
    expect(edges).toBeGreaterThan(3) // the premise: more edges than facts

    const { body } = await wipe(env, { userId: 'u1' })
    expect(body.deleted).toBe(3)
  })

  it('is owner-scoped: another user\'s memories, edges and mirror rows survive', async () => {
    const env = makeEnv()
    await seed(env, 'u1', SECRETS)
    const [x, y] = await seed(env, 'u2', ['u2 likes Rust', 'u2 lives in Lisbon'])
    await g.insertEdges(env, { owner: 'u2', src: x, edges: [{ rel: 'relates_to', dst: y }] })

    // ⚠️ Assert the wipe SUCCEEDED first. Without this, a wipe that throws and
    // returns 500 having erased nothing passes every assertion below — "the
    // other user is intact" is also true when NOTHING happened. A test for what
    // an operation must not touch has to state that the operation ran.
    const { status, body } = await wipe(env, { userId: 'u1' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u1'").at(0).c).toBe(0)

    expect(all(g.RECENT_SQL, { 1: 'u2', 2: 100 })).toHaveLength(2)
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u2'").at(0).c).toBe(2)
    expect(all("SELECT COUNT(*) AS c FROM edge WHERE owner = 'u2'").at(0).c).toBe(1)
    expect(all("SELECT COUNT(*) AS c FROM learnings WHERE user_id = 'u2'").at(0).c).toBe(2)
  })

  it('does NOT touch the shared social graph — a follow is not a memory', async () => {
    // Social nodes/edges live under the SOCIAL_OWNER pseudo-owner and are
    // SHARED between principals: one node per person. A wipe scoped by
    // `owner = userId` cannot reach them, and must not — deleting them would
    // silently unfollow other people's followers.
    const env = makeEnv()
    await seed(env, 'u1', SECRETS)
    await g.recordSocialEdge(env, {
      rel: 'follows',
      srcId: g.userNodeId('u1'), srcKind: 'person', srcLabel: '@u1',
      dstId: g.userNodeId('u2'), dstKind: 'person', dstLabel: '@u2',
      now: 900,
    })
    const socialBefore = all(`SELECT COUNT(*) AS c FROM edge WHERE owner = '${g.SOCIAL_OWNER}'`).at(0).c
    expect(socialBefore).toBe(1)

    // Same rule as the owner-scoping case: prove the wipe RAN, or "the social
    // graph is intact" is satisfied by a 500 that did nothing.
    const { status, body } = await wipe(env, { userId: 'u1' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u1'").at(0).c).toBe(0)

    expect(all(`SELECT COUNT(*) AS c FROM edge WHERE owner = '${g.SOCIAL_OWNER}'`).at(0).c).toBe(1)
    expect(all(`SELECT COUNT(*) AS c FROM entity WHERE owner = '${g.SOCIAL_OWNER}'`).at(0).c).toBe(2)
  })

  it('erases every entity the user OWNS, not only kind=\'fact\'', async () => {
    // 0012's schema documents 'person'|'tiny'|'project'|'concept' alongside
    // 'fact', and their `label` is the user's words too. A wipe scoped
    // `kind = 'fact'` passes every other test in this file and still leaves a
    // person node named after someone the user asked to be forgotten. Owner is
    // the whole scope.
    const env = makeEnv()
    await seed(env, 'u1', SECRETS)
    db.prepare(
      `INSERT INTO entity (id, owner, kind, label, attrs_json, valid_from, created)
       VALUES ('p:1', 'u1', 'person', ?, ?, 900, 900)`
    ).run('Dr Halberstam at the clinic', JSON.stringify({ source: 'my psychiatrist' }))

    await wipe(env, { userId: 'u1' })

    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u1'").at(0).c).toBe(0)
    expect(JSON.stringify(all("SELECT * FROM entity"))).not.toContain('Halberstam')
  })

  it('an empty store wipes to 0 without an error', async () => {
    const env = makeEnv()
    const { status, body } = await wipe(env, { userId: 'nobody' })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, deleted: 0 })
  })

  it('a wipe after a partial unlearn still erases the CLOSED rows', async () => {
    // The nastiest ordering: the user retires one fact (row kept, by design),
    // then asks for everything to be forgotten. CLOSE_ALL only matched
    // `valid_to IS NULL`, so the already-closed row was not even re-touched —
    // its text sat in history untouched by the wipe that was supposed to
    // remove it.
    const env = makeEnv()
    await seed(env, 'u1', SECRETS)
    await wipe(env, { userId: 'u1', id: '2' }) // retire one — stays as history
    expect(all("SELECT valid_to FROM entity WHERE id = 'mig12:2'").at(0).valid_to).not.toBeNull()

    await wipe(env, { userId: 'u1' })
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u1'").at(0).c).toBe(0)
    expect(JSON.stringify(all(g.RECENT_ALL_SQL, { 1: 'u1', 2: 100 })))
      .not.toContain('HIV')
  })
})

describe.skipIf(!present)('wipe: retirement semantics are UNCHANGED', () => {
  it('unlearn(id) still CLOSES and keeps the row — the bitemporal contract', async () => {
    // The fix must not turn every unlearn into a delete. Retiring one fact is
    // recoverable by design and the History view is its whole point.
    const env = makeEnv()
    await seed(env, 'u1', SECRETS)
    const { body } = await wipe(env, { userId: 'u1', id: '1' })
    expect(body.ok).toBe(true)

    const row = all("SELECT valid_to, attrs_json FROM entity WHERE id = 'mig12:1'").at(0)
    expect(row.valid_to).not.toBeNull()
    expect(JSON.parse(row.attrs_json).source).toBe(SECRETS[0])
    // dropped from live listings, present in history
    expect(all(g.RECENT_SQL, { 1: 'u1', 2: 100 })).toHaveLength(2)
    expect(all(g.RECENT_ALL_SQL, { 1: 'u1', 2: 100 })).toHaveLength(3)
    // and its vector is KEPT (only a wipe purges vectors)
    expect(deleted).toEqual([])
  })

  it('supersede still closes rather than deletes', async () => {
    const env = makeEnv()
    const ids = await seed(env, 'u1', SECRETS)
    await g.supersede(env, { owner: 'u1', newId: ids[2], closeIds: [ids[0]], now: 900 })
    expect(all("SELECT valid_to FROM entity WHERE id = 'mig12:1'").at(0).valid_to).toBe(900)
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u1'").at(0).c).toBe(3)
  })
})

describe.skipIf(!present)('wipe: the statement and the handler agree', () => {
  const src = (p: string) =>
    readFileSync(join(WORKER_SRC, p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('the wipe statements DELETE and are owner-scoped', () => {
    expect(g.PURGE_ALL_FACTS_SQL).toContain('DELETE FROM entity')
    expect(g.PURGE_ALL_FACTS_SQL).toContain('owner = ?1')
    expect(g.PURGE_ALL_FACT_EDGES_SQL).toContain('DELETE FROM edge')
    expect(g.PURGE_ALL_FACT_EDGES_SQL).toContain('owner = ?1')
    // Not an UPDATE in disguise.
    expect(g.PURGE_ALL_FACTS_SQL).not.toContain('valid_to')
    // And NOT narrowed by kind — see the behavioural case above. Owner is the
    // whole scope; a kind filter is how a wipe starts missing rows.
    expect(g.PURGE_ALL_FACTS_SQL).not.toContain('kind')
  })

  it('the clear-all branch no longer closes rows, and deletes edges first', () => {
    const body = src('learnings.ts')
    expect(body.length).toBeGreaterThan(500) // non-vacuity: comments stripped, code remains
    expect(body).toContain('PURGE_ALL_FACTS_SQL')
    expect(body).toContain('PURGE_ALL_FACT_EDGES_SQL')
    // The old statement is gone from the module entirely (import included).
    expect(body).not.toContain('CLOSE_ALL_SQL')
    // Ordering is load-bearing (FK: edge.src/dst → entity.id) — and it has to
    // be read from the BATCH, not the file, because the import line names both
    // in the other order.
    const batch = body.slice(body.indexOf('DB.batch(['))
    const inBatch = batch.slice(0, batch.indexOf(']'))
    expect(inBatch).toContain('PURGE_ALL_FACT_EDGES_SQL')
    expect(inBatch).toContain('PURGE_ALL_FACTS_SQL')
    expect(inBatch.indexOf('PURGE_ALL_FACT_EDGES_SQL'))
      .toBeLessThan(inBatch.indexOf('PURGE_ALL_FACTS_SQL'))
  })

  it('graph.ts no longer exports a clear-all CLOSE, so nothing can re-adopt it', () => {
    const body = src('graph.ts')
    expect(body.length).toBeGreaterThan(500)
    expect(body).not.toContain('CLOSE_ALL_SQL')
    // Single-row close survives — retirement still needs it.
    expect(body).toContain('CLOSE_SQL')
  })
})

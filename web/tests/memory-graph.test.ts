// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('memory-graph')

/**
 * Memory graph: runs the REAL migration file
 * (0012_memory_graph.sql) and the REAL exported statements against sqlite.
 * The load-bearing guarantee: after migration, the graph-backed read path
 * returns results IDENTICAL to the old flat-learnings queries — same ids,
 * same content, same order (regression demanded by the ship order).
 */
// `any`, NOT typeof import(...): the worker submodule is absent in CI, and
// a type-level import of it fails `tsc --noEmit` there even though the
// runtime import is properly gated behind `present`.
let g: any
let MIGRATION: string
let db: any

const OLD_RECENT = 'SELECT id, content, created FROM learnings WHERE user_id = ? ORDER BY created DESC, id DESC LIMIT ?'
const OLD_TOTALS = 'SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(content)), 0) AS b FROM learnings WHERE user_id = ?'

beforeAll(async () => {
  if (!present) return
  g = await import(workerFile('graph.ts') /* @vite-ignore */)
  MIGRATION = readFileSync(join(WORKER_SRC, '..', 'migrations', '0012_memory_graph.sql'), 'utf8')
})

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node@17
  // (the repo pin) predates it. Worker-gated, runs on the local Node.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL, content TEXT NOT NULL,
      created INTEGER DEFAULT (unixepoch())
    );
    INSERT INTO learnings (user_id, content, created) VALUES
      ('u1', 'prefers TypeScript for tooling', 100),
      ('u1', 'lives in Amsterdam', 200),
      ('u1', 'ships to Cloudflare Workers', 200),
      ('u2', 'other user memory', 150);
  `)
  db.exec(MIGRATION) // the real file: tables + backfill
})

const all = (sql: string, ...binds: any[]) => db.prepare(sql).all(...binds)

describe.skipIf(!present)('memory graph — migration + parity (real SQL, real sqlite)', () => {
  it('backfill: every learning becomes one isolated entity, verbatim source, reused vector id', () => {
    const ents = all("SELECT * FROM entity WHERE owner = 'u1' ORDER BY created")
    expect(ents).toHaveLength(3)
    const first = ents[0]
    expect(first.id).toBe('mig12:1')
    expect(first.kind).toBe('fact')
    expect(JSON.parse(first.attrs_json).source).toBe('prefers TypeScript for tooling')
    expect(first.vec_id).toBe('learning:1') // existing Vectorize vectors REUSED
    expect(first.valid_to).toBeNull()       // live
    expect(first.valid_from).toBe(100)      // history preserved
  })

  it('backfill is idempotent (INSERT OR IGNORE on deterministic ids)', () => {
    db.exec(MIGRATION)
    db.exec(MIGRATION)
    expect(all("SELECT COUNT(*) AS c FROM entity").at(0).c).toBe(4)
  })

  it('REGRESSION: recent list identical to the old flat query (ids, content, order)', () => {
    const oldRows = all(OLD_RECENT, 'u1', 100)
    const newRows = all(g.RECENT_SQL, { 1: 'u1', 2: 100 })
    expect(newRows).toEqual(oldRows)
  })

  it('REGRESSION: totals identical (count + bytes)', () => {
    expect(all(g.TOTALS_SQL, { 1: 'u1' })).toEqual(all(OLD_TOTALS, 'u1'))
    expect(all(g.TOTALS_SQL, { 1: 'u2' })).toEqual(all(OLD_TOTALS, 'u2'))
  })

  it('semantic hydration by vec_id returns legacy-shaped rows, owner-scoped', () => {
    const rows = all(g.BY_VEC_SQL(2, false), 'u1', 'learning:1', 'learning:4')
    expect(rows).toHaveLength(1) // learning:4 belongs to u2 — cross-tenant excluded
    expect(rows[0].id).toBe(1)   // legacy numeric id preserved on the wire
    expect(rows[0].content).toBe('prefers TypeScript for tooling')
  })

  it('unlearn = CLOSE: drops from listings/recall, row survives', () => {
    const now = 500
    db.prepare(g.CLOSE_SQL).run({ 1: now, 2: 'u1', 3: g.resolveEntityId(1) })
    // gone from the live read paths…
    expect(all(g.RECENT_SQL, { 1: 'u1', 2: 100 })).toHaveLength(2)
    expect(all(g.BY_VEC_SQL(1, false), 'u1', 'learning:1')).toHaveLength(0)
    // …but the fact is preserved, closed
    const row = all("SELECT valid_to, attrs_json FROM entity WHERE id = 'mig12:1'").at(0)
    expect(row.valid_to).toBe(500)
    expect(JSON.parse(row.attrs_json).source).toBe('prefers TypeScript for tooling')
    // and include_closed=true still reaches it (bitemporal history surface)
    expect(all(g.BY_VEC_SQL(1, true), 'u1', 'learning:1')).toHaveLength(1)
  })

  // ⚠️ This case USED to assert `entity` count === 3 after a clear-all — i.e.
  // "all rows survive", which is the RETIREMENT rule applied to a WIPE. The
  // rows that survived still carried the memory text verbatim in `label` and
  // `attrs_json.$.source`, and include_closed=1 renders both. See
  // tests/memory-wipe.test.ts for the full defect. Wipe = DELETE.
  it('clear-all DELETES the owner\'s facts and leaves other owners alone', () => {
    db.prepare(g.PURGE_ALL_FACTS_SQL).run({ 1: 'u1' })
    expect(all(g.RECENT_SQL, { 1: 'u1', 2: 100 })).toHaveLength(0)
    expect(all(g.RECENT_ALL_SQL, { 1: 'u1', 2: 100 })).toHaveLength(0) // history too
    expect(all(g.RECENT_SQL, { 1: 'u2', 2: 100 })).toHaveLength(1) // untouched
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u1'").at(0).c).toBe(0)
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = 'u2'").at(0).c).toBe(1)
  })

  it('capacity counts LIVE facts only — closing frees quota', () => {
    db.prepare(g.CLOSE_SQL).run({ 1: 500, 2: 'u1', 3: 'mig12:2' })
    expect(all(g.TOTALS_SQL, { 1: 'u1' }).at(0).c).toBe(2)
  })

  it('resolveEntityId maps legacy numeric ids and passes entity ids through', () => {
    expect(g.resolveEntityId(7)).toBe('mig12:7')
    expect(g.resolveEntityId('7')).toBe('mig12:7')
    expect(g.resolveEntityId('mig12:7')).toBe('mig12:7')
    expect(g.resolveEntityId('a1b2-uuid')).toBe('a1b2-uuid')
  })
})

describe.skipIf(!present)('memory graph — supersession + freshness', () => {
  // D1's env.DB shim over node:sqlite for the supersede() helper.
  // node:sqlite binds ?N-numbered params as NAMED ({1: v}) while bare ?
  // binds positionally — D1's .bind() is positional for both, so translate.
  const runArgs = (sql: string, binds: any[]) =>
    /\?\d/.test(sql) ? [Object.fromEntries(binds.map((v, i) => [String(i + 1), v]))] : binds
  const makeEnv = () => ({
    DB: {
      prepare(sql: string) {
        const binds: any[] = []
        const stmt: any = {
          sql,
          bind(...args: any[]) { binds.push(...args); return stmt },
          binds,
          async all() { return { results: db.prepare(sql).all(...runArgs(sql, binds)) } },
          async first() { return db.prepare(sql).get(...runArgs(sql, binds)) ?? null },
          async run() { const r = db.prepare(sql).run(...runArgs(sql, binds)); return { meta: { changes: r.changes } } },
        }
        return stmt
      },
      async batch(stmts: any[]) {
        return stmts.map((s: any) => {
          const r = db.prepare(s.sql).run(...runArgs(s.sql, s.binds))
          return { meta: { changes: r.changes } }
        })
      },
    },
  })

  it('supersede closes the old facts and records supersedes edges atomically', async () => {
    const closed = await g.supersede(makeEnv(), { owner: 'u1', newId: 'mig12:3', closeIds: [1, 'mig12:2'], now: 900 })
    expect(closed.sort()).toEqual(['mig12:1', 'mig12:2'])
    // both closed at 900
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner='u1' AND valid_to = 900").at(0).c).toBe(2)
    // supersedes edges: new fact → each closed one
    const edges = all("SELECT src, rel, dst FROM edge WHERE owner='u1' ORDER BY dst")
    expect(edges).toEqual([
      { src: 'mig12:3', rel: 'supersedes', dst: 'mig12:1' },
      { src: 'mig12:3', rel: 'supersedes', dst: 'mig12:2' },
    ])
    // recall/listing sees only the survivor
    expect(all(g.RECENT_SQL, { 1: 'u1', 2: 100 }).map((r: any) => r.id)).toEqual([3])
  })

  it('supersede skips foreign, already-closed, and self ids — no edges for non-closes', async () => {
    const closed = await g.supersede(makeEnv(), {
      owner: 'u1', newId: 'mig12:3',
      closeIds: ['mig12:4' /* u2's */, 'mig12:3' /* self */, 'ghost', 2, 2 /* dupe */],
      now: 901,
    })
    expect(closed).toEqual(['mig12:2'])
    expect(all("SELECT COUNT(*) AS c FROM edge").at(0).c).toBe(1) // only the real close got an edge
    expect(all("SELECT valid_to FROM entity WHERE id='mig12:4'").at(0).valid_to).toBeNull() // cross-tenant untouched
  })

  it('include_closed listing carries freshness fields; base shape unchanged', async () => {
    await g.supersede(makeEnv(), { owner: 'u1', newId: 'mig12:3', closeIds: [1], now: 902 })
    const withClosed = all(g.RECENT_ALL_SQL, { 1: 'u1', 2: 100 })
    expect(withClosed).toHaveLength(3)
    const closedRow = withClosed.find((r: any) => r.id === 1)
    expect(closedRow.freshness).toBe('closed')
    expect(closedRow.valid_to).toBe(902)
    expect(withClosed.find((r: any) => r.id === 2).freshness).toBe('live')
    // live-only list still excludes it and carries NO extra fields
    const live = all(g.RECENT_SQL, { 1: 'u1', 2: 100 })
    expect(live.map((r: any) => r.id).sort()).toEqual([2, 3])
    expect(Object.keys(live[0]).sort()).toEqual(['content', 'created', 'id'])
  })

  it('FRESHNESS_SQL badge data: live vs closed with provenance', async () => {
    await g.supersede(makeEnv(), { owner: 'u1', newId: 'mig12:3', closeIds: [1], now: 903 })
    const rows = all(g.FRESHNESS_SQL(2), 'u1', 'mig12:1', 'mig12:2')
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]))
    expect(byId['mig12:1'].freshness).toBe('closed')
    expect(byId['mig12:2'].freshness).toBe('live')
    expect(byId['mig12:1'].source).toBe('prefers TypeScript for tooling')
  })

  it('insertEdges validates rel + owner-scoped dst, clamps weights', async () => {
    const env = makeEnv()
    const created = await g.insertEdges(env, {
      owner: 'u1', src: 'mig12:1',
      edges: [
        { rel: 'relates_to', dst: 2, weight: 0.8, confidence: 5 /* clamped to 1 */ },
        { rel: 'part_of', dst: 'mig12:3', scope: 'tooling' },
        { rel: 'follows', dst: 2 },          // social rel — not yet supported, rejected
        { rel: 'relates_to', dst: 'mig12:4' }, // u2's node — cross-tenant, rejected
        { rel: 'relates_to', dst: 'mig12:1' }, // self — rejected
      ],
      now: 910,
    })
    expect(created.map((e: any) => e.rel).sort()).toEqual(['part_of', 'relates_to'])
    const rows = all("SELECT rel, dst, scope, weight, confidence FROM edge WHERE owner='u1' ORDER BY rel")
    expect(rows).toEqual([
      { rel: 'part_of', dst: 'mig12:3', scope: 'tooling', weight: 1, confidence: 1 },
      { rel: 'relates_to', dst: 'mig12:2', scope: null, weight: 0.8, confidence: 1 },
    ])
  })

  it('neighbors BFS walks hops with rel filter, owner-scoped', async () => {
    const env = makeEnv()
    await g.insertEdges(env, { owner: 'u1', src: 'mig12:1', edges: [{ rel: 'relates_to', dst: 2 }], now: 911 })
    await g.insertEdges(env, { owner: 'u1', src: 'mig12:2', edges: [{ rel: 'part_of', dst: 3 }], now: 912 })

    const oneHop = await g.neighbors(env, { owner: 'u1', nodeId: 1, hops: 1 })
    expect(oneHop.nodes.map((n: any) => n.id).sort()).toEqual(['mig12:1', 'mig12:2'])
    expect(oneHop.edges).toHaveLength(1)

    const twoHop = await g.neighbors(env, { owner: 'u1', nodeId: 1, hops: 2 })
    expect(twoHop.nodes.map((n: any) => n.id).sort()).toEqual(['mig12:1', 'mig12:2', 'mig12:3'])

    const filtered = await g.neighbors(env, { owner: 'u1', nodeId: 2, hops: 1, rels: ['part_of'] })
    expect(filtered.edges.map((e: any) => e.rel)).toEqual(['part_of'])

    const foreign = await g.neighbors(env, { owner: 'u2', nodeId: 1, hops: 1 })
    expect(foreign.edges).toHaveLength(0) // u1's edges invisible to u2
  })

  it('rankExpanded scores neighbors by cosine × weight × confidence × recency', () => {
    const now = 1000 * 86400 // fixed 'now' in seconds
    const nodes = new Map([
      ['a', { valid_from: now }],           // fresh seed
      ['b', { valid_from: now - 90 * 86400 }], // 90 days old → decay 0.5
    ])
    const scores = g.rankExpanded(
      [{ id: 'a', score: 0.9 }],
      [{ src: 'a', dst: 'b', weight: 0.5, confidence: 0.8 }],
      nodes, now,
    )
    expect(scores.get('a')).toBeCloseTo(0.9, 5)               // 0.9 × decay(0d)=1
    expect(scores.get('b')).toBeCloseTo(0.9 * 0.5 * 0.8 * 0.5, 5) // seed × w × c × decay(90d)
  })

  it('recencyDecay halves every 90 days', () => {
    const now = 1000
    expect(g.recencyDecay(now, now)).toBe(1)
    expect(g.recencyDecay(now - 90 * 86400, now)).toBeCloseTo(0.5, 5)
    expect(g.recencyDecay(now - 180 * 86400, now)).toBeCloseTo(0.25, 5)
  })

  // ── Conflicts ──
  const edge = (id: string, src: string, rel: string, dst: string, scope: string | null, validTo: number | null = null) =>
    db.prepare("INSERT INTO edge (id, owner, src, rel, dst, scope, valid_from, valid_to, created) VALUES (?, 'u1', ?, ?, ?, ?, 100, ?, 100)")
      .run(id, src, rel, dst, scope, validTo)

  it('SUBJECT shape: same (src, rel, NON-NULL scope) + different dst = conflict', () => {
    edge('e1', 'mig12:1', 'about', 'mig12:2', 'home-city')
    edge('e2', 'mig12:1', 'about', 'mig12:3', 'home-city')
    const conflicts = g.groupConflicts(all(g.CONFLICTS_SQL, { 1: 'u1' }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].shape).toBe('subject')
    expect(conflicts[0].candidates.map((c: any) => c.dst).sort()).toEqual(['mig12:2', 'mig12:3'])
  })

  it("SUBJECT shape requires NON-NULL scope (tiny-tech audit: null-scope relates_to fan-outs are links, not contradictions)", () => {
    // The exact live false-positive shape: tiny_learn's edges[] docs say
    // "link liberally" — one fresh fact relates_to several existing ones.
    // A 2026-07-23 production graph reported 5/5 "conflicts", all this.
    edge('f1', 'mig12:1', 'relates_to', 'mig12:2', null)
    edge('f2', 'mig12:1', 'relates_to', 'mig12:3', null)
    edge('f3', 'mig12:1', 'about', 'mig12:2', null) // null-scope about fan-out too
    edge('f4', 'mig12:1', 'about', 'mig12:3', null)
    expect(all(g.CONFLICTS_SQL, { 1: 'u1' })).toHaveLength(0)
  })

  it('SUBJECT shape is about/relates_to only — scoped part_of/authored fan-outs are not contradictions', () => {
    edge('p1', 'mig12:1', 'part_of', 'mig12:2', 'proj') // one fact in two clusters
    edge('p2', 'mig12:1', 'part_of', 'mig12:3', 'proj')
    edge('a1', 'mig12:1', 'authored', 'mig12:2', 'repo') // one author, two works
    edge('a2', 'mig12:1', 'authored', 'mig12:3', 'repo')
    expect(all(g.CONFLICTS_SQL, { 1: 'u1' })).toHaveLength(0)
  })

  it("TARGET shape (tiny's E2E finding): two facts ABOUT one target in the same scope = conflict", () => {
    // The shape learn(edges:[{rel:'about',dst:X}]) produces: each learn is a
    // NEW src (166/167) pointing about the SAME target (mig12:1). Before the
    // fix this returned 0 — the killer feature never fired for its own tool.
    db.prepare("INSERT INTO entity (id,owner,kind,label,attrs_json,valid_from,created) VALUES ('mig12:166','u1','fact','TS','{}',200,200),('mig12:167','u1','fact','PY','{}',201,201)").run()
    edge('t1', 'mig12:166', 'about', 'mig12:1', 'lang')
    edge('t2', 'mig12:167', 'about', 'mig12:1', 'lang')
    const conflicts = g.groupConflicts(all(g.CONFLICTS_SQL, { 1: 'u1' }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].shape).toBe('target')
    expect(conflicts[0].src).toBe('mig12:1') // the shared anchor
    // candidates are the COMPETING FACTS (166/167) — what the user picks between
    expect(conflicts[0].candidates.map((c: any) => c.dst).sort()).toEqual(['mig12:166', 'mig12:167'])
  })

  it('TARGET shape requires NON-NULL scope (null-scope "many facts about X" must not false-positive)', () => {
    db.prepare("INSERT INTO entity (id,owner,kind,label,attrs_json,valid_from,created) VALUES ('mig12:166','u1','fact','a','{}',200,200),('mig12:167','u1','fact','b','{}',201,201)").run()
    edge('t1', 'mig12:166', 'about', 'mig12:1', null)
    edge('t2', 'mig12:167', 'about', 'mig12:1', null)
    expect(all(g.CONFLICTS_SQL, { 1: 'u1' })).toHaveLength(0) // no scope → not competing
    // and a different-scope pair about the same target is also NOT a conflict
    edge('t3', 'mig12:166', 'about', 'mig12:1', 'axis-a')
    edge('t4', 'mig12:167', 'about', 'mig12:1', 'axis-b')
    expect(g.groupConflicts(all(g.CONFLICTS_SQL, { 1: 'u1' }))).toHaveLength(0)
  })

  it('TARGET shape is about/relates_to only — part_of multi-membership is not a contradiction', () => {
    db.prepare("INSERT INTO entity (id,owner,kind,label,attrs_json,valid_from,created) VALUES ('mig12:166','u1','fact','a','{}',200,200),('mig12:167','u1','fact','b','{}',201,201)").run()
    edge('t1', 'mig12:166', 'part_of', 'mig12:1', 'proj')
    edge('t2', 'mig12:167', 'part_of', 'mig12:1', 'proj') // two facts part_of one project — fine
    expect(all(g.CONFLICTS_SQL, { 1: 'u1' })).toHaveLength(0)
  })

  it('THE scope guard — different scopes are context-bound facts, NOT conflicts', () => {
    edge('e1', 'mig12:1', 'about', 'mig12:2', 'project-a')
    edge('e2', 'mig12:1', 'about', 'mig12:3', 'project-b')
    expect(all(g.CONFLICTS_SQL, { 1: 'u1' })).toHaveLength(0)
    // same scope string DOES conflict
    edge('e3', 'mig12:1', 'about', 'mig12:3', 'project-a')
    const conflicts = g.groupConflicts(all(g.CONFLICTS_SQL, { 1: 'u1' }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].scope).toBe('project-a')
  })

  it('closed edges and supersedes never conflict', () => {
    edge('e1', 'mig12:1', 'about', 'mig12:2', null)
    edge('e2', 'mig12:1', 'about', 'mig12:3', null, 900) // closed
    expect(all(g.CONFLICTS_SQL, { 1: 'u1' })).toHaveLength(0)
    edge('s1', 'mig12:3', 'supersedes', 'mig12:1', null)
    edge('s2', 'mig12:3', 'supersedes', 'mig12:2', null)
    expect(all(g.CONFLICTS_SQL, { 1: 'u1' })).toHaveLength(0) // consolidation ≠ conflict
  })

  it('three-way conflicts group into one set', () => {
    edge('e1', 'mig12:1', 'about', 'mig12:2', 'home-city')
    edge('e2', 'mig12:1', 'about', 'mig12:3', 'home-city')
    db.prepare("INSERT INTO entity (id, owner, kind, label, attrs_json, valid_from, created) VALUES ('x4', 'u1', 'fact', 'x', '{}', 100, 100)").run()
    edge('e3', 'mig12:1', 'about', 'x4', 'home-city')
    const conflicts = g.groupConflicts(all(g.CONFLICTS_SQL, { 1: 'u1' }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].candidates).toHaveLength(3)
  })

  it('resolveConflict keeps one, closes the rest (never deletes), skips keep/foreign', async () => {
    edge('e1', 'mig12:1', 'about', 'mig12:2', null)
    edge('e2', 'mig12:1', 'about', 'mig12:3', null)
    const closed = await g.resolveConflict(makeEnv(), {
      owner: 'u1', keepEdgeId: 'e1', closeEdgeIds: ['e2', 'e1' /* keep — skipped */, 'ghost'], now: 950,
    })
    expect(closed).toEqual(['e2'])
    expect(all("SELECT valid_to FROM edge WHERE id='e2'").at(0).valid_to).toBe(950) // closed, not deleted
    expect(all("SELECT valid_to FROM edge WHERE id='e1'").at(0).valid_to).toBeNull()
    expect(all(g.CONFLICTS_SQL, { 1: 'u1' })).toHaveLength(0) // resolved
  })

  // ── Social edges + trust ──
  it('social: recordSocialEdge upserts nodes idempotently and REINFORCES instead of duplicating', async () => {
    const env = makeEnv()
    const visit = () => g.recordSocialEdge(env, {
      rel: 'visited',
      srcId: 'user:u9', srcKind: 'person', srcLabel: '@visitor',
      dstId: 'tiny:strands', dstKind: 'tiny', dstLabel: '/strands',
      now: 920,
    })
    await visit(); await visit(); await visit()
    const edges = all("SELECT src, rel, dst, weight FROM edge WHERE owner = '_social'")
    expect(edges).toEqual([{ src: 'user:u9', rel: 'visited', dst: 'tiny:strands', weight: 3 }])
    expect(all("SELECT COUNT(*) AS c FROM entity WHERE owner = '_social'").at(0).c).toBe(2)
  })

  it('social: THE visibility guardrail — private edges and nodes never surface on the public read path', async () => {
    const env = makeEnv()
    await g.recordSocialEdge(env, {
      rel: 'messaged', visibility: 'private',
      srcId: 'user:a', srcKind: 'person', srcLabel: '@a',
      dstId: 'user:b', dstKind: 'person', dstLabel: '@b',
      now: 921,
    })
    await g.recordSocialEdge(env, {
      rel: 'visited',
      srcId: 'user:a', srcKind: 'person', srcLabel: '@a',
      dstId: 'tiny:pub', dstKind: 'tiny', dstLabel: '/pub',
      now: 922,
    })
    const around = all(g.SOCIAL_NEIGHBORS_SQL, { 1: 'user:a', 2: 50 })
    expect(around.map((e: any) => e.rel)).toEqual(['visited']) // messaged (private) invisible
    // node created private by the private edge stays out even if a public edge targets it later
    expect(around.some((e: any) => e.dst === 'user:b')).toBe(false)
  })

  it('social: trustRank — endorsement flows through consulted edges', () => {
    const trust = g.trustRank([
      { src: 'tiny:a', dst: 'tiny:hub', weight: 5 },
      { src: 'tiny:b', dst: 'tiny:hub', weight: 3 },
      { src: 'tiny:hub', dst: 'tiny:expert', weight: 4 },
    ])
    // expert receives ALL of the well-consulted hub's rank → top node
    // (PageRank: endorsement flows downstream; sources rank lowest)
    expect(trust.get('tiny:expert')).toBe(1)
    expect(trust.get('tiny:hub')!).toBeGreaterThan(trust.get('tiny:a')!)
    expect(trust.get('tiny:expert')!).toBeGreaterThan(trust.get('tiny:hub')!)
    expect(g.trustRank([]).size).toBe(0)
  })

  it('whole graph (ALL_NODES/ALL_EDGES): owner-scoped, live by default, closed on request', async () => {
    const env = makeEnv()
    await g.insertEdges(env, { owner: 'u1', src: 'mig12:1', edges: [{ rel: 'relates_to', dst: 2 }], now: 960 })
    await g.supersede(env, { owner: 'u1', newId: 'mig12:3', closeIds: [1], now: 961 })

    // Live view: closed node 1 gone; only edges between live nodes remain
    const liveNodes = all(g.ALL_NODES_SQL(false), { 1: 'u1', 2: 500 })
    expect(liveNodes.map((n: any) => n.id).sort()).toEqual(['mig12:2', 'mig12:3'])
    expect(liveNodes.every((n: any) => n.freshness === 'live')).toBe(true)
    // wire_id carries the legacy numeric id for the UI
    expect(liveNodes.find((n: any) => n.id === 'mig12:2').wire_id).toBe(2)

    // History view: the closed node reappears grey, with its edges
    const allNodes = all(g.ALL_NODES_SQL(true), { 1: 'u1', 2: 500 })
    expect(allNodes).toHaveLength(3)
    expect(allNodes.find((n: any) => n.id === 'mig12:1').freshness).toBe('closed')
    const allEdges = all(g.ALL_EDGES_SQL(true), { 1: 'u1', 2: 500 })
    expect(allEdges.map((e: any) => e.rel).sort()).toEqual(['relates_to', 'supersedes'])

    // Cross-tenant: u2 sees only their own single node, no edges
    expect(all(g.ALL_NODES_SQL(true), { 1: 'u2', 2: 500 })).toHaveLength(1)
    expect(all(g.ALL_EDGES_SQL(true), { 1: 'u2', 2: 500 })).toHaveLength(0)
  })

  it('feed: followers see ONLY live public facts of followed principals', async () => {
    const env = makeEnv()
    // u9 follows u1 (user node) — FEED_SQL resolves user:<id> by prefix-strip
    db.exec("CREATE TABLE tinys (name TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
    await g.recordSocialEdge(env, {
      rel: 'follows',
      srcId: 'user:u9', srcKind: 'person', srcLabel: '@u9',
      dstId: 'user:u1', dstKind: 'person', dstLabel: '@u1',
      now: 930,
    })
    // u1's facts: all private from the backfill → empty feed
    expect(all(g.FACT_FEED_SQL, { 1: 'user:u9', 2: 30 })).toHaveLength(0)
    // one goes public → it (and only it) surfaces
    db.prepare("UPDATE entity SET visibility = 'public' WHERE id = 'mig12:1'").run()
    let feed = all(g.FACT_FEED_SQL, { 1: 'user:u9', 2: 30 })
    expect(feed.map((r: any) => r.content)).toEqual(['prefers TypeScript for tooling'])
    expect(feed[0].author_id).toBe('u1')
    // closing the fact removes it from the feed (freshness applies)
    db.prepare(g.CLOSE_SQL).run({ 1: 940, 2: 'u1', 3: 'mig12:1' })
    expect(all(g.FACT_FEED_SQL, { 1: 'user:u9', 2: 30 })).toHaveLength(0)
    // unfollow (closed follow edge) silences the feed even for public facts
    db.prepare("UPDATE entity SET visibility = 'public' WHERE id = 'mig12:2'").run()
    expect(all(g.FACT_FEED_SQL, { 1: 'user:u9', 2: 30 })).toHaveLength(1)
    db.prepare("UPDATE edge SET valid_to = 950 WHERE owner = '_social' AND rel = 'follows'").run()
    expect(all(g.FACT_FEED_SQL, { 1: 'user:u9', 2: 30 })).toHaveLength(0)
  })

  it('feed: follows on a tiny resolve to its owner facts through the tinys table', async () => {
    const env = makeEnv()
    db.exec("CREATE TABLE tinys (name TEXT PRIMARY KEY, user_id TEXT NOT NULL); INSERT INTO tinys VALUES ('strands', 'u1')")
    await g.recordSocialEdge(env, {
      rel: 'follows',
      srcId: 'user:u9', srcKind: 'person', srcLabel: '@u9',
      dstId: 'tiny:strands', dstKind: 'tiny', dstLabel: '/strands',
      now: 931,
    })
    db.prepare("UPDATE entity SET visibility = 'public' WHERE id = 'mig12:3'").run()
    const feed = all(g.FACT_FEED_SQL, { 1: 'user:u9', 2: 30 })
    expect(feed.map((r: any) => r.content)).toEqual(['ships to Cloudflare Workers'])
    expect(feed[0].via).toBe('tiny:strands')
  })

  it('visibility on insertFactEntity: public opt-in only, never inferred', async () => {
    const env = makeEnv()
    db.prepare("INSERT INTO learnings (user_id, content, created) VALUES ('u1', 'a public fact', 300)").run()
    await g.insertFactEntity(env, { owner: 'u1', content: 'a public fact', legacyId: 5, visibility: 'public' })
    db.prepare("INSERT INTO learnings (user_id, content, created) VALUES ('u1', 'a normal fact', 301)").run()
    await g.insertFactEntity(env, { owner: 'u1', content: 'a normal fact', legacyId: 6 })
    // anything not exactly 'public' stays private (no 'PUBLIC', no truthy junk)
    db.prepare("INSERT INTO learnings (user_id, content, created) VALUES ('u1', 'junk vis', 302)").run()
    await g.insertFactEntity(env, { owner: 'u1', content: 'junk vis', legacyId: 7, visibility: 'PUBLIC' })
    const vis = Object.fromEntries(
      all("SELECT id, visibility FROM entity WHERE id IN ('mig12:5','mig12:6','mig12:7')").map((r: any) => [r.id, r.visibility])
    )
    expect(vis).toEqual({ 'mig12:5': 'public', 'mig12:6': 'private', 'mig12:7': 'private' })
  })

  it('social: fact-graph traversal never crosses into the social pseudo-owner', async () => {
    const env = makeEnv()
    await g.recordSocialEdge(env, {
      rel: 'visited',
      srcId: 'user:u1', srcKind: 'person', srcLabel: '@u1',
      dstId: 'tiny:x', dstKind: 'tiny', dstLabel: '/x',
      now: 923,
    })
    const sub = await g.neighbors(env, { owner: 'u1', nodeId: 1, hops: 2 })
    expect(sub.nodes.some((n: any) => String(n.id).startsWith('user:') || String(n.id).startsWith('tiny:'))).toBe(false)
  })
})

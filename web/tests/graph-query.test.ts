// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  planGraphQuery,
  graphQueryParams,
  graphEmptyNote,
  GRAPH_RELS,
  NODE_MAX,
} from '../lib/chat/graph-query'

/**
 * Backlog v9 A3 — `memory_graph` answered every malformed argument with a
 * healthy 200 and an EMPTY graph.
 *
 * The organising property: the worker matches node ids and rel names EXACTLY,
 * so an empty result is a CLAIM about the user's graph ("that memory has no
 * links"), not a signal that the query was wrong. Every test below is about
 * removing a way for that claim to be false.
 */

const repo = join(__dirname, '..')
const read = (p: string) =>
  readFileSync(join(repo, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const err = (p: ReturnType<typeof planGraphQuery>) => {
  if (p.kind !== 'refuse') throw new Error(`expected refuse, got ${p.kind}`)
  return p.error
}

describe('neighbors: a memory id that can actually match', () => {
  it('plans a plain id at the default depth', () => {
    expect(planGraphQuery({ node: 'mig12:42' })).toEqual({ kind: 'neighbors', node: 'mig12:42', hops: 1 })
    expect(graphQueryParams(planGraphQuery({ node: 'mig12:42' }))).toEqual({ node: 'mig12:42' })
  })

  it('accepts a NUMERIC id — legacy memory rows are integers', () => {
    expect(planGraphQuery({ node: 42 })).toEqual({ kind: 'neighbors', node: '42', hops: 1 })
    // resolveEntityId in the worker maps /^\d+$/ through migEntityId, so 0 is
    // a legitimate id shape and must not be read as "no node".
    expect(planGraphQuery({ node: 0 })).toEqual({ kind: 'neighbors', node: '0', hops: 1 })
  })

  it('clamps hops to 1..2 — a clamp the caller CAN see', () => {
    // The returned subgraph reveals its own depth, so this is v9's "clamp when
    // the caller can see the result" case, not a silent loss.
    expect(planGraphQuery({ node: 'a', hops: 2 })).toMatchObject({ hops: 2 })
    expect(planGraphQuery({ node: 'a', hops: 9 })).toMatchObject({ hops: 2 })
    expect(planGraphQuery({ node: 'a', hops: 0 })).toMatchObject({ hops: 1 })
    expect(planGraphQuery({ node: 'a', hops: -3 })).toMatchObject({ hops: 1 })
    expect(planGraphQuery({ node: 'a', hops: Number.NaN })).toMatchObject({ hops: 1 })
  })

  it('only sends hops when it is not the default', () => {
    expect(graphQueryParams(planGraphQuery({ node: 'a', hops: 2 }))).toEqual({ node: 'a', hops: '2' })
    expect(graphQueryParams(planGraphQuery({ node: 'a', hops: 1 }))).toEqual({ node: 'a' })
  })

  it('refuses an id longer than the worker accepts instead of truncating it', () => {
    // A3's original line: `String(input.node).slice(0, 120)`. Exact match means
    // a truncated id matches NOTHING, so the old code turned a too-long id into
    // a confident "that memory has no links".
    const long = 'mig12:' + 'x'.repeat(NODE_MAX)
    const e = err(planGraphQuery({ node: long }))
    expect(e).toContain(String(long.length))
    expect(e).toContain('truncated')
    expect(e).toContain('nothing was queried')
  })

  it('a legitimate id at exactly the limit still goes through', () => {
    const exact = 'x'.repeat(NODE_MAX)
    expect(planGraphQuery({ node: exact })).toMatchObject({ kind: 'neighbors', node: exact })
    expect(planGraphQuery({ node: 'x'.repeat(NODE_MAX + 1) }).kind).toBe('refuse')
  })

  it('refuses an empty or missing id with distinct messages', () => {
    // Supplied-but-empty and never-supplied are different mistakes: one is a
    // bug in the caller's id handling, the other is a call it shouldn't make.
    const empty = err(planGraphQuery({ node: '' }))
    const missing = err(planGraphQuery({}))
    expect(empty).toContain('empty')
    expect(missing).toContain('needs a memory id')
    expect(empty).not.toBe(missing)
    for (const v of ['', '   ', '\n\t']) expect(planGraphQuery({ node: v }).kind, JSON.stringify(v)).toBe('refuse')
  })
})

describe('rels: an unknown relation excludes every edge', () => {
  it('passes the worker vocabulary through, deduped in order', () => {
    expect(planGraphQuery({ node: 'a', rels: ['supersedes'] })).toMatchObject({ rels: ['supersedes'] })
    expect(planGraphQuery({ node: 'a', rels: ['about', 'part_of', 'about'] })).toMatchObject({
      rels: ['about', 'part_of'],
    })
  })

  it('mirrors the worker FACT_RELS list exactly', () => {
    // worker/src/graph.ts: FACT_RELS = supersedes|part_of|
    // authored|relates_to|about. If the worker's list grows, this test is the
    // thing that notices the client's copy didn't.
    expect(GRAPH_RELS).toEqual(['supersedes', 'part_of', 'authored', 'relates_to', 'about'])
    for (const rel of GRAPH_RELS) {
      expect(planGraphQuery({ node: 'a', rels: [rel] }), rel).toMatchObject({ rels: [rel] })
    }
  })

  it('refuses a MISSPELLED relation — the empty-graph trap in one hyphen', () => {
    // `rels:['part-of']` (hyphen, not underscore) matched no edge, so the tool
    // reported an unlinked memory. zod's z.enum catches this on the chat path;
    // the executor has to catch it too, since the schema is only advisory on
    // any bridge that forwards args raw (the c56 rule).
    const e = err(planGraphQuery({ node: 'a', rels: ['part-of'] }))
    expect(e).toContain("'part-of'")
    expect(e).toContain('excludes EVERY edge')
    expect(e).toContain('part_of') // the valid vocabulary is named
  })

  it('names EVERY unknown relation, not just the first', () => {
    const e = err(planGraphQuery({ node: 'a', rels: ['part-of', 'follows'] }))
    expect(e).toContain("'part-of'")
    expect(e).toContain("'follows'")
    expect(e).toContain('are not') // plural agreement, so the copy reads
  })

  it('refuses SOCIAL rels on a fact query — they exist, in another graph', () => {
    // visited/consulted/messaged/follows are real (SOCIAL_RELS) but live under
    // the _social pseudo-owner, so filtering a fact subgraph by them is a
    // guaranteed empty result.
    for (const rel of ['visited', 'consulted', 'messaged', 'follows']) {
      expect(planGraphQuery({ node: 'a', rels: [rel] }).kind, rel).toBe('refuse')
    }
  })

  it('treats an empty array as no filter, not as a filter matching nothing', () => {
    const p = planGraphQuery({ node: 'a', rels: [] })
    expect(p).toEqual({ kind: 'neighbors', node: 'a', hops: 1 })
    expect(graphQueryParams(p)).not.toHaveProperty('rels')
  })

  it('refuses a non-array rels rather than stringifying it', () => {
    expect(planGraphQuery({ node: 'a', rels: 'supersedes' }).kind).toBe('refuse')
  })

  it('never truncates the joined filter', () => {
    // The old line was `input.rels.join(',').slice(0, 200)`, which could cut a
    // relation in half and silently drop it. The whole vocabulary joined is
    // well under 200 chars, so a refusal-based design has nothing to cut.
    const all = planGraphQuery({ node: 'a', rels: [...GRAPH_RELS] })
    expect(graphQueryParams(all).rels).toBe(GRAPH_RELS.join(','))
    expect(graphQueryParams(all).rels!.split(',')).toHaveLength(GRAPH_RELS.length)
  })
})

describe('social: a falsy node used to select a DIFFERENT MODE', () => {
  it('omitting node deliberately still means the global trust ranking', () => {
    expect(planGraphQuery({ mode: 'social' })).toEqual({ kind: 'social' })
    expect(graphQueryParams({ kind: 'social' })).toEqual({})
  })

  it('refuses an EMPTY node instead of silently switching to the ranking', () => {
    // ⚠️ THE mode-flip: `if (input.node) qs.set('node', …)` dropped a falsy
    // node, and a dropped node is a documented MODE ("omit for trust ranking
    // only"). So `{mode:'social', node:''}` answered a question about everyone
    // when it was asked about someone — and {edges:[], trust:{…}} looks exactly
    // like "this person interacts with nobody".
    const e = err(planGraphQuery({ mode: 'social', node: '' }))
    expect(e).toContain('trust ranking')
    expect(e).toContain('leaderboard')
    expect(e).not.toBe(err(planGraphQuery({ node: '' }))) // ≠ the neighbors message
  })

  it('accepts the two id shapes the platform writes', () => {
    // userNodeId = `user:${id}`, tinyNodeId = `tiny:${slug.toLowerCase()}`.
    expect(planGraphQuery({ mode: 'social', node: 'tiny:mert' })).toEqual({ kind: 'social', node: 'tiny:mert' })
    expect(planGraphQuery({ mode: 'social', node: 'user:12345' })).toEqual({ kind: 'social', node: 'user:12345' })
  })

  it('lowercases a tiny slug because the WRITER already did', () => {
    // Information-preserving: tinyNodeId lowercases on write, so 'tiny:Mert'
    // can only ever have been meant as 'tiny:mert'.
    expect(planGraphQuery({ mode: 'social', node: 'tiny:MERT' })).toEqual({ kind: 'social', node: 'tiny:mert' })
    expect(planGraphQuery({ mode: 'social', node: 'TINY:Mert' })).toEqual({ kind: 'social', node: 'tiny:mert' })
  })

  it('does NOT lowercase a user id — that half is opaque', () => {
    expect(planGraphQuery({ mode: 'social', node: 'user:AbC' })).toEqual({ kind: 'social', node: 'user:AbC' })
  })

  it('refuses a bare login, which is what a model reaches for first', () => {
    // The most likely wrong call: the agent knows '@mert' and the tool wants
    // 'tiny:mert' or 'user:<numeric id>'. Unprefixed matches nothing.
    for (const v of ['mert', '@mert', 'user', 'https://tiny.technology/mert']) {
      const e = err(planGraphQuery({ mode: 'social', node: v }))
      expect(e, v).toContain('not a social node id')
      expect(e, v).toContain('empty graph')
    }
  })

  it("names that user: takes the numeric id, not the @login", () => {
    // Otherwise the fix for 'mert' is 'user:mert', which is ALSO empty.
    expect(err(planGraphQuery({ mode: 'social', node: 'mert' }))).toMatch(/numeric user ID|not their @login/i)
  })

  it('refuses a prefix with nothing after it', () => {
    // ⚠️ These are all refused by the SHAPE rule (the regex), not by the
    // `!rest` guard inside it — the trim happens before the match, so a body of
    // pure whitespace leaves a trailing ':' that `.+` can't match. That guard
    // is documented as unreachable in graph-query.ts; don't write a test for
    // it, write an input that reaches it or leave it documented.
    for (const v of ['tiny:', 'user:', 'tiny:   ', 'tiny:\t']) {
      expect(planGraphQuery({ mode: 'social', node: v }).kind, v).toBe('refuse')
    }
  })
})

describe('mode and feed', () => {
  it('defaults to neighbors when mode is absent', () => {
    expect(planGraphQuery({ node: 'a' }).kind).toBe('neighbors')
    expect(planGraphQuery({ node: 'a', mode: undefined }).kind).toBe('neighbors')
  })

  it('feed needs nothing else and sends nothing else', () => {
    expect(planGraphQuery({ mode: 'feed' })).toEqual({ kind: 'feed' })
    expect(planGraphQuery({ mode: 'feed', node: '' })).toEqual({ kind: 'feed' })
    expect(graphQueryParams({ kind: 'feed' })).toEqual({})
  })

  it('refuses an unknown mode rather than falling into neighbors', () => {
    // A mode typo must not become a memory-id query with no id.
    for (const v of ['Social', 'trust', 'graph', 1, true]) {
      expect(planGraphQuery({ mode: v, node: 'a' }).kind, JSON.stringify(v)).toBe('refuse')
    }
  })
})

describe('an empty result is narrated as what it actually proves', () => {
  it('an UNFILTERED empty neighbors result is a real answer', () => {
    const note = graphEmptyNote({ kind: 'neighbors', node: 'a', hops: 1 }, 0)
    expect(note).toContain('stands alone')
    expect(note).toContain('not a failed lookup')
  })

  it('a FILTERED empty result says the filter was applied', () => {
    // The remaining honest trap: a valid rels filter legitimately returns
    // nothing, and the agent would still say "this memory has no links".
    const note = graphEmptyNote({ kind: 'neighbors', node: 'a', hops: 1, rels: ['supersedes'] }, 0)
    expect(note).toContain('supersedes')
    expect(note).toContain('links of other kinds')
    // ⚠️ NOT `not.toContain('stands alone')` — the filtered note uses that
    // phrase deliberately, as the thing NOT to conclude ("Retry without rels
    // before telling the user it stands alone"). A substring ban would have
    // forced the copy to drop its own point. The property that matters is that
    // the two notes are different CONCLUSIONS, so assert that instead: a
    // negative on a phrase the other branch owns tests wording, not behaviour.
    expect(note).not.toBe(graphEmptyNote({ kind: 'neighbors', node: 'a', hops: 1 }, 0))
    expect(note).toMatch(/Retry without rels/)
  })

  it('an empty social result is "nothing PUBLIC", never "nothing"', () => {
    const note = graphEmptyNote({ kind: 'social', node: 'tiny:mert' }, 0)
    expect(note).toContain('tiny:mert')
    expect(note).toContain('Private')
  })

  it('labels the node-less social read as global even when it has data', () => {
    // trust:{…} with edges:[] is the ranking, and the agent must not present a
    // leaderboard as an answer about the person the user asked about.
    const note = graphEmptyNote({ kind: 'social' }, 0)
    expect(note).toContain('global')
    expect(graphEmptyNote({ kind: 'social' }, 7)).toContain('GLOBAL')
  })

  it('adds nothing to a healthy non-empty answer', () => {
    expect(graphEmptyNote({ kind: 'neighbors', node: 'a', hops: 1 }, 3)).toBeUndefined()
    expect(graphEmptyNote({ kind: 'social', node: 'tiny:mert' }, 3)).toBeUndefined()
    expect(graphEmptyNote({ kind: 'refuse', error: 'x' }, 0)).toBeUndefined()
  })
})

describe('the tool is wired to the rule', () => {
  const src = () => read('lib/chat/tools/memory.ts')

  it('no longer slices the node or the joined rels', () => {
    // The two defects expressed as scans.
    const s = src()
    expect(s).not.toMatch(/String\(input\.node\)\.slice\(0, 120\)/)
    expect(s).not.toMatch(/input\.rels\.join\(','\)\.slice\(/)
    expect(s).not.toMatch(/if \(input\.node\) qs\.set\('node'/)
  })

  it('builds BOTH worker query strings from graphQueryParams', () => {
    const s = src()
    expect(s).toMatch(/new URLSearchParams\(graphQueryParams\(plan\)\)/) // social
    expect(s).toMatch(/userId: session\.sub, \.\.\.graphQueryParams\(plan\)/) // neighbors
  })

  it('refuses BEFORE either fetch, or the plan is decoration', () => {
    const s = src()
    const planned = s.indexOf('const plan = planGraphQuery(input)')
    const bail = s.indexOf("if (plan.kind === 'refuse')", planned)
    expect(planned).toBeGreaterThan(-1)
    expect(bail).toBeGreaterThan(planned)
    for (const path of ['/graph/social', '/graph/feed', '/graph/neighbors']) {
      expect(s.indexOf(path, planned), path).toBeGreaterThan(bail)
    }
  })

  it('attaches the empty-result note on both graph reads', () => {
    // A refusal fixes the query; the note fixes the INTERPRETATION. Both reads
    // can legitimately come back empty, so both need it.
    const s = src()
    expect((s.match(/graphEmptyNote\(plan, d\.edges\?\.length \|\| 0\)/g) || []).length).toBe(2)
  })

  it('never overwrites an error response with a note, on EITHER read', () => {
    // The route relays worker failures verbatim and callers guard on d.error
    // (app/api/graph's contract) — spreading a note onto a 500 body would
    // dress an outage up as an answer.
    //
    // ⚠️ A file-wide `toMatch` here was VACUOUS and mutation proved it: the
    // guard appears twice (social, neighbors) and a mutation that broke the
    // first one still passed, because the second one's text satisfied the
    // regex. Anchor each occurrence to the fetch it protects — that's the whole
    // point, since the two branches were gated in the same edit and a future
    // one might only touch one of them.
    const s = src()
    const social = s.indexOf('/graph/social')
    const neighbors = s.indexOf('/graph/neighbors')
    expect(social).toBeGreaterThan(-1)
    expect(neighbors).toBeGreaterThan(social)
    expect(s.slice(social, neighbors)).toMatch(/d\.ok === false \|\| d\.error/)
    expect(s.slice(neighbors)).toMatch(/d\.ok === false \|\| d\.error/)
  })

  it('types rels as the shared vocabulary, not a free-form string', () => {
    // The lone-outlier smell from c59, again: learn.edges.rel is a z.enum while
    // this sibling was z.array(z.string()).
    const s = src()
    expect(s).toMatch(/rels: z\.array\(z\.enum\(GRAPH_RELS\)\)/)
    expect(s).not.toMatch(/rels: z\.array\(z\.string\(\)\)/)
  })

  it('advertises the rules it enforces', () => {
    // The c56/c58 rule: the advertised rule and the enforced rule must be one
    // rule, or the tool refuses calls its own docs invited.
    const s = src()
    expect(s).toMatch(/matched EXACTLY/)
    expect(s).toMatch(/an empty string is refused, not treated as omitted/)
    expect(s).toMatch(/numeric id/)
  })
})

describe('the empty-result census', () => {
  it('the HTTP route pre-trims node to 120 — the same shape, one layer out', () => {
    // app/api/graph does `node.slice(0, 120)` for both social and neighbors.
    // Recorded, NOT fixed: its callers are MemoryPanel chips (ids that came
    // from the graph itself, so never over-long) plus iOS/Android MemoryGraph,
    // so changing the route's contract is a cross-client change like v9 A2.
    // Pinned so the count can't grow unnoticed.
    const route = read('app/api/graph/route.ts')
    expect((route.match(/\.slice\(0, 120\)/g) || []).length).toBe(2)
  })

  it('memory_graph is NOT on the voice bridge, so refusals are read, not spoken', () => {
    // Justifies plain-text refusals here rather than the model-legible-audio
    // phrasing c53/c55 needed. If it ever joins the roster, revisit the copy.
    const voice = read('app/api/voice/tool/route.ts')
    expect(voice).not.toMatch(/makeGraphNeighborsTool/)
  })
})

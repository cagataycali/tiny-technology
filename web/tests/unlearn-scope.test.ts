// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planUnlearn, unlearnBody, unlearnNote } from '../lib/chat/unlearn-scope'

/**
 * Backlog v9 A4 — `unlearn` treated EVERY falsy id as "clear all memories".
 *
 * The tests are organised around the one property that ranks this above the
 * sibling truncations: clear-all purges the semantic index, so unlike a single
 * close (bitemporal, kept as history) it cannot be undone.
 */

const repo = join(__dirname, '..')
const read = (p: string) =>
  readFileSync(join(repo, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('closing ONE memory', () => {
  it('plans a single close for a real id', () => {
    expect(planUnlearn({ id: '42' })).toEqual({ kind: 'one', id: '42' })
  })

  it('accepts a NUMERIC id, matching every sibling memory-id field', () => {
    // MemoryPanel renders ids as `#42` and learn's `supersedes`/`edges.dst` and
    // memory_graph's `node` are all z.union([string, number]) — `unlearn` was
    // the lone z.string(), so a model following the house convention got a zod
    // rejection on the one destructive tool.
    expect(planUnlearn({ id: 42 })).toEqual({ kind: 'one', id: '42' })
    expect(planUnlearn({ id: 0 })).toEqual({ kind: 'one', id: '0' })
  })

  it('trims surrounding whitespace off an otherwise-real id', () => {
    expect(planUnlearn({ id: '  42  ' })).toEqual({ kind: 'one', id: '42' })
  })

  it('sends the id to the worker and never a bare userId', () => {
    const plan = planUnlearn({ id: '42' })
    expect(unlearnBody('u1', plan)).toEqual({ userId: 'u1', id: '42' })
  })
})

describe('an empty or missing id is REFUSED, never read as clear-all', () => {
  it('refuses an empty-string id — the headline defect', () => {
    // ⚠️ THE bug: `...(input.id ? { id } : {})` dropped a falsy id, so `{id:''}`
    // reached the worker as `{userId}` = delete everything. An empty string is
    // exactly what a model emits when it means "this one" but has no id.
    for (const v of ['', '   ', '\n\t']) {
      const p = planUnlearn({ id: v })
      expect(p.kind, JSON.stringify(v)).toBe('refuse')
      if (p.kind !== 'refuse') throw new Error('unreachable')
      expect(p.error).toContain('empty')
      expect(p.error).toContain('nothing was closed')
    }
  })

  it('refuses a bare call with no arguments at all', () => {
    // This USED to be the documented way to erase everything. Now clear-all
    // must be asked for, because an under-specified destructive call should
    // resolve toward the recoverable outcome — here, toward doing nothing.
    const p = planUnlearn({})
    expect(p.kind).toBe('refuse')
    if (p.kind !== 'refuse') throw new Error('unreachable')
    expect(p.error).toContain("scope:'all'")
    expect(p.error).toContain('not recoverable')
  })

  it('the two refusals differ, so the agent knows which mistake it made', () => {
    const empty = planUnlearn({ id: '' })
    const bare = planUnlearn({})
    if (empty.kind !== 'refuse' || bare.kind !== 'refuse') throw new Error('unreachable')
    expect(empty.error).not.toBe(bare.error)
  })

  it('a refusal carries no id, so no caller can proceed on it anyway', () => {
    expect(planUnlearn({ id: '' })).not.toHaveProperty('id')
  })
})

describe("clear-all requires scope:'all' explicitly", () => {
  it('plans clear-all only for the literal opt-in', () => {
    expect(planUnlearn({ scope: 'all' })).toEqual({ kind: 'all' })
    expect(unlearnBody('u1', { kind: 'all' })).toEqual({ userId: 'u1' })
  })

  it('does not accept near-misses as the opt-in', () => {
    // Anything that isn't exactly 'all' must NOT erase everything. (zod's
    // z.literal('all') rejects these upstream too; this is the second layer,
    // because the executor is what actually reaches the worker.)
    for (const v of ['ALL', 'all ', 'everything', true, 1, ['all'], { scope: 'all' }]) {
      const p = planUnlearn({ scope: v })
      expect(p.kind, JSON.stringify(v)).toBe('refuse')
    }
  })

  it('refuses a contradictory call rather than guessing', () => {
    // Guessing `all` destroys everything; guessing `one` silently ignores an
    // explicit erase request. Neither is ours to choose.
    const p = planUnlearn({ id: '42', scope: 'all' })
    expect(p.kind).toBe('refuse')
    if (p.kind !== 'refuse') throw new Error('unreachable')
    expect(p.error).toContain('both')
    expect(p.error).toContain('nothing was closed')
  })
})

describe('what the agent is told afterwards', () => {
  it('never lets a clear-all be narrated as a recoverable close', () => {
    expect(unlearnNote({ kind: 'all' })).toContain('not recoverable')
    expect(unlearnNote({ kind: 'one', id: '42' })).toContain('history')
    expect(unlearnNote({ kind: 'all' })).not.toBe(unlearnNote({ kind: 'one', id: '42' }))
  })
})

describe('the tool is wired to the rule', () => {
  const src = () => read('lib/chat/tools/memory.ts')

  it('no longer spreads a truthiness test into the worker body', () => {
    // The defect expressed as a scan.
    expect(src()).not.toMatch(/\.\.\.\(input\.id \? \{ id: input\.id \} : \{\}\)/)
    expect(src()).toMatch(/body: JSON\.stringify\(unlearnBody\(session\.sub, plan\)\)/)
  })

  it('refuses BEFORE the fetch, or the plan is decoration', () => {
    const s = src()
    const planned = s.indexOf('const plan = planUnlearn(input)')
    // ⚠️ Anchor the bail search TO this tool's plan. Searching from 0 found the
    // first `plan.kind === 'refuse'` in the file, and c60 gave memory_graph the
    // same shape earlier in the same file — so this test failed on a SIBLING
    // adopting the pattern, i.e. on the success case. A source scan for a
    // shared idiom has to be scoped to the call site it is about.
    const bail = s.indexOf("if (plan.kind === 'refuse')", planned)
    const fetchAt = s.indexOf('fetch(`${WORKER}/learnings`', planned)
    expect(planned).toBeGreaterThan(-1)
    expect(bail).toBeGreaterThan(planned)
    expect(fetchAt).toBeGreaterThan(bail)
  })

  it("advertises scope:'all' and that an empty id is refused", () => {
    // The description is what the MODEL reads. If it still said "omit to clear
    // all" the tool would refuse calls its own docs invited (the c56/c58 lesson:
    // the advertised rule and the enforced rule must be the same rule).
    const s = src()
    expect(s).toMatch(/scope:'all' EXPLICITLY/)
    expect(s).toMatch(/refused, never treated as clear-all/)
    expect(s).not.toMatch(/or nothing to clear ALL memories/)
    expect(s).toMatch(/scope: z\.literal\('all'\)\.optional\(\)/)
  })

  it('the id field accepts the same shapes as its sibling memory-id fields', () => {
    const s = src()
    // learn.supersedes / learn.edges.dst / memory_graph.node all take either.
    const unions = s.match(/z\.union\(\[z\.string\(\), z\.number\(\)\]\)/g) || []
    expect(unions.length).toBeGreaterThanOrEqual(4)
    expect(s).toMatch(/id: z\.union\(\[z\.string\(\), z\.number\(\)\]\)\.optional\(\)/)
  })
})

describe('the destructive-memory census', () => {
  it('the HTTP route refuses a blank id too — it only LOOKED like it already did', () => {
    // ⚠️⚠️ This test used to assert the OPPOSITE and pass: "the HTTP route
    // already guarded the empty id — the tool was the outlier", pinning
    // `id !== undefined && id !== ''` as proof the human path was safe. That
    // line is not a guard. It DROPS the blank id, and an omitted id is the wire
    // form of clear-all, so the route escalated a single-row swipe into "erase
    // every memory and purge the vector index". The census was wrong in the one
    // direction that matters, and a green test kept it that way.
    //
    // The lesson, since this file's whole job is auditing sibling call sites: a
    // pin on ANOTHER file must assert the safe BEHAVIOUR, not the presence of a
    // line that reads reassuringly. Behaviour now lives in
    // tests/learnings-delete-scope.test.ts.
    const route = read('app/api/learnings/route.ts')
    expect(route).not.toMatch(/id !== undefined && id !== ''/)
    expect(route).toMatch(/const plan = planLearningsDelete\(await req\.text\(\)/)
  })

  it('the human path still confirms before closing even ONE memory', () => {
    // The asymmetry that ranks this item: a person gets a danger confirm to
    // close one RECOVERABLE memory; the agent needed nothing to erase them all.
    const panel = read('components/chat/MemoryPanel.tsx')
    expect(panel).toMatch(/confirm\(\{[\s\S]{0,200}danger: true/)
  })

  it('unlearn is on the VOICE bridge, where there is no screen to notice', () => {
    // Not a bug by itself — it justifies why the refusal has to live in the
    // tool rather than in a UI confirm.
    const voice = read('app/api/voice/tool/route.ts')
    expect(voice).toMatch(/makeUnlearnTool\(session\)/)
  })
})

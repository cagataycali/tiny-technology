// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planLearningsDelete, deleteRefusalForHumans } from '../lib/chat/learnings-delete-scope'
import { unlearnBody, type UnlearnRefusal } from '../lib/chat/unlearn-scope'

/**
 * `DELETE /api/learnings` read a blank id as "erase every memory".
 *
 * The rule that forbids this already existed for the agent tool
 * (lib/chat/unlearn-scope, backlog v9 A4). The HTTP boundary that iOS, Android
 * and the web panel all cross did not use it — it had
 * `...(id !== undefined && id !== '' ? { id } : {})`, which does not refuse a
 * blank id, it OMITS it. Omission is the wire form of clear-all.
 *
 * These tests are organised around blast radius: closing one memory is
 * bitemporal and recoverable, clear-all purges the semantic index and is not.
 * So the load-bearing assertions are the ones proving which bodies can NEVER
 * reach `kind: 'all'`.
 */

const repo = join(__dirname, '..')
const read = (p: string) =>
  readFileSync(join(repo, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('closing ONE memory still works', () => {
  it('plans a single close for a real id', () => {
    expect(planLearningsDelete('{"id":"42"}')).toEqual({ kind: 'one', id: '42' })
  })

  it('accepts a numeric id — MemoryPanel types its own as `number | string`', () => {
    expect(planLearningsDelete('{"id":42}')).toEqual({ kind: 'one', id: '42' })
    // 0 is a real id and a falsy one: the whole defect class started with a
    // truthiness test, so the boundary must not reintroduce it.
    expect(planLearningsDelete('{"id":0}')).toEqual({ kind: 'one', id: '0' })
  })

  it('trims an otherwise-real id', () => {
    expect(planLearningsDelete('{"id":"  42  "}')).toEqual({ kind: 'one', id: '42' })
  })

  it('sends the id to the worker, never a bare userId', () => {
    // `{ userId }` with no id is precisely the clear-all request, so this is the
    // assertion that the close-one path cannot degrade into a wipe. Ids go over
    // as strings (unlearnBody is Record<string,string>) — the shipped agent path
    // has always done that and the worker stringifies via resolveEntityId.
    expect(unlearnBody('u1', planLearningsDelete('{"id":42}'))).toEqual({ userId: 'u1', id: '42' })
  })
})

describe('⚠️ the bodies that used to erase everything', () => {
  // Each of these reached `{ userId }` — CLOSE_ALL_SQL, DELETE FROM learnings,
  // MEMORY.deleteByIds — through the route's own normalisation.
  const wasFatal: [string, string, UnlearnRefusal][] = [
    ['a blank id from a single-row swipe', '{"id":""}', 'blank-id'],
    ['a whitespace id', '{"id":"   "}', 'blank-id'],
    ['an explicit null id', '{"id":null}', 'blank-id'],
    ['a non-scalar id', '{"id":[]}', 'blank-id'],
    ['a boolean id', '{"id":false}', 'blank-id'],
    // iOS builds the body with `try? JSONSerialization.data(...)`, so an encode
    // failure sends NO body — and `req.json().catch(() => ({}))` turned that
    // into the clear-all shape. "We could not say what to delete" meant
    // "delete all of it".
    ['no body at all', '', 'unreadable-body'],
    ['a whitespace body', '  \n ', 'unreadable-body'],
    ['a truncated body', '{"id":', 'unreadable-body'],
    ['a non-JSON body', 'not json', 'unreadable-body'],
    ['the JSON literal null', 'null', 'unreadable-body'],
    ['a JSON array', '[]', 'unreadable-body'],
    ['a bare JSON string', '"42"', 'unreadable-body'],
    ['a bare JSON number', '42', 'unreadable-body'],
  ]

  it.each(wasFatal)('refuses %s', (_what, body, reason) => {
    const p = planLearningsDelete(body)
    expect(p.kind).toBe('refuse')
    if (p.kind !== 'refuse') throw new Error('unreachable')
    expect(p.reason).toBe(reason)
  })

  it('a refusal carries no id and no scope, so nothing can proceed on it', () => {
    const p = planLearningsDelete('{"id":""}')
    expect(p).not.toHaveProperty('id')
    // And encoding one is a throw, not a `{ userId }` wipe — the failure mode of
    // a forgotten bail must not be annihilation.
    expect(() => unlearnBody('u1', p)).toThrow(/refused plan/)
  })

  it('refuses a contradictory request rather than guessing which half was meant', () => {
    const p = planLearningsDelete('{"id":"42","scope":"all"}')
    expect(p.kind).toBe('refuse')
    if (p.kind !== 'refuse') throw new Error('unreachable')
    expect(p.reason).toBe('contradictory')
  })
})

describe('the wipe is only ever REQUESTED', () => {
  it("plans clear-all for the explicit opt-in", () => {
    expect(planLearningsDelete('{"scope":"all"}')).toEqual({ kind: 'all' })
  })

  it('still honours a bare {} — the one documented omission', () => {
    // tiny-tech's published `tiny_unlearn` advertises "omit to close ALL
    // memories" and sends `id ? { id } : {}`. It is a separate repo behind a
    // user-gated npm publish, so refusing `{}` would break a shipped capability
    // while refusing a blank id breaks nothing. Documented seam, not an
    // oversight: see lib/chat/learnings-delete-scope.
    expect(planLearningsDelete('{}')).toEqual({ kind: 'all' })
    // A body with unrelated keys is the same "no id, no scope" statement.
    expect(planLearningsDelete('{"note":"hi"}')).toEqual({ kind: 'all' })
  })

  it('does not accept near-misses of the opt-in', () => {
    for (const body of [
      '{"scope":"ALL"}',
      '{"scope":"all "}',
      '{"scope":"everything"}',
      '{"scope":true}',
      '{"scope":null}',
      '{"scope":["all"]}',
    ]) {
      const p = planLearningsDelete(body)
      expect(p.kind, body).toBe('refuse')
    }
  })

  it('NOTHING else in the whole sweep reaches clear-all', () => {
    // The one assertion that would have caught the original defect: whatever
    // else changes, only a deliberate omission or the literal opt-in may erase
    // a user's memory.
    const everythingElse = [
      ...['', '   ', 'not json', '{', 'null', '[]', '"x"', '7'],
      ...['{"id":""}', '{"id":"  "}', '{"id":null}', '{"id":[]}', '{"id":{}}', '{"id":false}', '{"id":true}'],
      ...['{"scope":"ALL"}', '{"scope":true}', '{"scope":null}', '{"id":"42","scope":"all"}'],
    ]
    for (const body of everythingElse) {
      expect(planLearningsDelete(body).kind, body).not.toBe('all')
    }
  })
})

describe('what the PERSON is told', () => {
  const reasons: UnlearnRefusal[] = ['blank-id', 'unreadable-body', 'unscoped', 'contradictory']

  it('every cause has words, and they never read as a result', () => {
    // MemoryPanel toasts the route's `error` verbatim, so a refusal that sounds
    // like a confirmation is the same lie in a different place.
    for (const r of reasons) {
      const copy = deleteRefusalForHumans(r)
      expect(copy, r).toContain('nothing was deleted')
      expect(copy, r).not.toMatch(/forgotten|closed|erased it|deleted it/i)
    }
  })

  it('the causes are distinguishable, so the copy is worth having', () => {
    expect(new Set(reasons.map(deleteRefusalForHumans)).size).toBe(reasons.length)
  })

  it('is human copy, not the agent copy — those tell a model to retry with an id', () => {
    // planUnlearn's own strings ("Pass a real id from your context or a recall
    // result", "refused:") are nonsense on a phone screen.
    for (const r of reasons) {
      expect(deleteRefusalForHumans(r)).not.toMatch(/refused:|recall result|scope:'all'/)
    }
  })

  it("asks for a reload where retrying the same id cannot help", () => {
    expect(deleteRefusalForHumans('blank-id')).toMatch(/reload/i)
    expect(deleteRefusalForHumans('unreadable-body')).toMatch(/reload/i)
  })

  it('reaches a screen: web and iOS show the route\'s `error`, android reads the status', () => {
    // Without this the copy would be unreachable decoration. The web panel
    // prints it as-is.
    expect(read('components/chat/MemoryPanel.tsx'))
      .toMatch(/toast\.error\(d\.error \|\| "Couldn't close — try again"\)/)
    // ⚠️ This assertion USED to read `ok = code < 400` with a comment claiming
    // iOS "only reads the status code". That premise expired: the memory sheet's
    // swipe now goes through `Api.deleteJson`, which throws `ApiError.http(code,
    // serverError(in: data))`, so the human refusal copy above reaches the
    // sheet's caption verbatim. Asserting the old SPELLING made an improvement
    // look like a regression — assert the behaviour instead.
    const panels = read('ios/Tiny/Sources/Panels.swift')
    expect(panels).toMatch(/Api\.deleteJson\("\/api\/learnings"/)
    expect(panels).toMatch(/serverSaid = error\.localizedDescription/)
    // Android still shows a fixed string and reads only the status, which is why
    // a 400 (not a masked 200) is the load-bearing half of the refusal there.
    expect(read('android/app/src/main/java/technology/tiny/app/ui/MemoryUniverse.kt'))
      .toMatch(/optInt\("_status", 200\) < 400/)
  })
})

describe('the route is wired to the rule', () => {
  const src = () => read('app/api/learnings/route.ts')
  /**
   * Just the DELETE handler. ⚠️ Scoped because the sibling POST legitimately
   * spells `req.json().catch(() => ({}))` — there an unreadable body falls
   * through to "content required", so the idiom is only fatal on DELETE. Same
   * trap tests/unlearn-scope.test.ts hit at c60: a scan for a shared idiom must
   * be anchored to the call site it is about, or it fails on an innocent sibling.
   */
  const del = () => src().slice(src().indexOf('export async function DELETE'))

  it('no longer normalises a blank id into the clear-all shape', () => {
    // The defect expressed as a scan.
    expect(del()).not.toMatch(/id !== undefined && id !== ''/)
    expect(del()).not.toMatch(/req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/)
    expect(del()).not.toBe('')
  })

  it('reads the body as TEXT, because an unparseable body was one of the wipes', () => {
    expect(src()).toMatch(/planLearningsDelete\(await req\.text\(\)\.catch\(\(\) => ''\)\)/)
    expect(src()).toMatch(/body: JSON\.stringify\(unlearnBody\(session\.sub, plan\)\)/)
  })

  it('refuses BEFORE the fetch, or the plan is decoration', () => {
    const s = src()
    const planned = s.indexOf('const plan = planLearningsDelete')
    const bail = s.indexOf("if (plan.kind === 'refuse')", planned)
    const fetchAt = s.indexOf('fetch(`${WORKER}/learnings`', planned)
    expect(planned).toBeGreaterThan(-1)
    expect(bail).toBeGreaterThan(planned)
    expect(fetchAt).toBeGreaterThan(bail)
  })

  it('answers a refusal with a 400 and the human copy', () => {
    const s = src()
    expect(s).toMatch(/deleteRefusalForHumans\(plan\.reason\)/)
    expect(s).toMatch(/status: 400/)
  })

  it('documents the contract it actually enforces', () => {
    // The c56/c58 lesson: the advertised rule and the enforced rule must be the
    // same rule. The header used to read "delete one (or all when id absent)",
    // which is exactly the inference that erased memories.
    const raw = readFileSync(join(repo, 'app/api/learnings/route.ts'), 'utf8')
    expect(raw).not.toMatch(/delete one \(or all when id absent\)/)
    expect(raw).toMatch(/close ONE memory/)
    expect(raw).toMatch(/scope:'all'/)
  })
})

describe('why an omitted id is annihilation, and who can send one', () => {
  it('the worker treats a missing id as close-all + drop rows + purge vectors', () => {
    // The measurement behind the whole increment: without this branch an
    // omitted id would be harmless and none of the above would matter.
    const worker = read('worker/src/learnings.ts')
    expect(worker).toMatch(/if \(id !== undefined && id !== ''\)/)
    expect(worker).toMatch(/CLOSE_ALL_SQL/)
    expect(worker).toMatch(/DELETE FROM learnings WHERE user_id = \?/)
    expect(worker).toMatch(/MEMORY\.deleteByIds/)
  })

  it('all three clients delete through this one route, so one fix covers them', () => {
    // iOS spells it through the shared verb now (inc 31) rather than hand-rolling
    // the URL — same route, so the refusal above still covers it. The assertion
    // is on the PATH for that reason; `Api.base` was never the claim.
    expect(read('ios/Tiny/Sources/Panels.swift')).toMatch(/deleteJson\("\/api\/learnings"/)
    expect(read('android/app/src/main/java/technology/tiny/app/ui/MemoryUniverse.kt'))
      .toMatch(/deleteJson\("\/api\/learnings"/)
    expect(read('components/chat/MemoryPanel.tsx')).toMatch(/fetch\("\/api\/learnings"/)
  })

  it('iOS can still PRODUCE a blank id, which is what made this reachable', () => {
    // decodeLearnings falls back to a random UUID only when `id` is MISSING —
    // a wire `"id": ""` is a perfectly good String, so it survives the `??`
    // chain and lands in the DELETE body. Kept as a pin because it is the
    // reachability evidence; the client-side half is a later increment.
    expect(read('ios/Tiny/Sources/Panels.swift'))
      .toMatch(/\(l\["id"\] as\? String\) \?\? UUID\(\)\.uuidString/)
  })

  it('the one caller that MEANS erase-everything now says so', () => {
    const slash = read('lib/chat/slash-commands.ts')
    expect(slash).toMatch(/body: JSON\.stringify\(\{ scope: 'all' \}\)/)
    // …and it is still gated behind the danger confirm.
    expect(slash).toMatch(/Clear ALL server-side learnings about you\?/)
  })
})

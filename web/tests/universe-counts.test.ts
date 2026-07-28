/**
 * lib/chat/universe-counts — the page, the census, and the sample.
 *
 * Backlog v10 A4 asked whether `{users.length} builders`, fed by `?limit=100`,
 * should be paired with `totalPublicTinys` (a real total) on the same line, and
 * "worth checking whether the worker returns a builder total". It does —
 * `totalUsers`, a COUNT(*) independent of `?limit`, verified live and already
 * relied on by Chat.tsx's hero stat — and no Universe surface rendered it.
 *
 * The second half wasn't in the item: `tinyCount` is a builder's real total
 * while the embedded `tinys[]` is capped at 8 by the worker, so both card grids
 * computed their "+N more" overflow from the TRUNCATED array
 * (`tinys.length > 8`), which can never be true. A builder with 20 tinys showed
 * 8 chips and no link to the other 12.
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  universeCounts,
  hiddenTinyCount,
  constellationFooter,
  COMMUNITY_TINYS_PER_USER,
  COMMUNITY_PAGE,
} from '../lib/chat/universe-counts'
import { normalizeCommunity } from '../lib/community'

/** Strip comments so a census pattern can't pass on a docblock that DISCUSSES
 *  the rule (the c55/c60 vacuous-assertion trap, 7th application). */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

describe('the caps are the worker’s real numbers, not ours', () => {
  it('mirrors the per-user tinys cap and the page size we request', () => {
    // Verified live: /community?limit=100 returns cagataycali with
    // tinyCount: 20 and exactly 8 entries in tinys[]; /profile?login= returns
    // all 20 with those 8 as the leading slice. No query param widens it.
    expect(COMMUNITY_TINYS_PER_USER).toBe(8)
    expect(COMMUNITY_PAGE).toBe(100)
  })
})

describe('universeCounts — a page next to a total', () => {
  it('names the real census when the page is short of it', () => {
    const out = universeCounts({ shown: 100, totalUsers: 340, totalPublicTinys: 900, limit: 100 })
    expect(out.builders).toBe('100 of 340 builders')
    expect(out.truncated).toBe(true)
    // The tinys total needs no qualifier — it already counts everything.
    expect(out.tinys).toBe('900 public tinys')
    expect(out.title).toContain('340')
  })

  it('states a bare count when the page IS the whole set — even at the limit', () => {
    // THE case a naive "full page ⇒ truncated" rule gets wrong: exactly 100
    // builders, all fetched. A hedge here is its own false claim.
    const out = universeCounts({ shown: 100, totalUsers: 100, totalPublicTinys: 250, limit: 100 })
    expect(out.builders).toBe('100 builders')
    expect(out.truncated).toBe(false)
    expect(out.title).toBeUndefined()
  })

  it('today’s live numbers render with no qualifier', () => {
    const out = universeCounts({ shown: 5, totalUsers: 5, totalPublicTinys: 25, limit: 100 })
    expect(out.builders).toBe('5 builders')
    expect(out.tinys).toBe('25 public tinys')
    expect(out.truncated).toBe(false)
  })

  it('falls back to a full-page proof when the worker sent no total', () => {
    // An older payload has no totalUsers. A full page is then the only
    // available evidence that anyone is missing.
    const full = universeCounts({ shown: 100, totalPublicTinys: 900, limit: 100 })
    expect(full.truncated).toBe(true)
    expect(full.builders).toBe('100 builders')
    expect(full.title).toContain('there may be more')

    const short = universeCounts({ shown: 7, totalPublicTinys: 12, limit: 100 })
    expect(short.truncated).toBe(false)
    expect(short.title).toBeUndefined()
  })

  it('a total BELOW the page length is a broken payload — trust the rows', () => {
    // Otherwise the header reads "12 of 3 builders", which is worse than the
    // bug it replaced.
    const out = universeCounts({ shown: 12, totalUsers: 3, totalPublicTinys: 40, limit: 100 })
    expect(out.builders).toBe('12 builders')
    expect(out.truncated).toBe(false)
  })

  it('a broken total is DISCARDED, not merely ignored for the label', () => {
    // The case that distinguishes "clamp the label" from "distrust the number":
    // a FULL page whose total claims fewer builders than arrived. Keeping the
    // bad total would answer "not truncated" with certainty; discarding it
    // falls back to the full-page proof, which is the honest "we don't know".
    const out = universeCounts({ shown: 100, totalUsers: 3, totalPublicTinys: 900, limit: 100 })
    expect(out.builders).toBe('100 builders')
    expect(out.truncated).toBe(true)
    expect(out.title).toContain('there may be more')
  })

  it('singulars: one builder, one tiny', () => {
    const out = universeCounts({ shown: 1, totalUsers: 1, totalPublicTinys: 1, limit: 100 })
    expect(out.builders).toBe('1 builder')
    expect(out.tinys).toBe('1 public tiny')
  })

  it('zero is plural (English) and never NaN', () => {
    expect(universeCounts({ shown: 0, totalUsers: 0, totalPublicTinys: 0 }).builders).toBe('0 builders')
    expect(universeCounts({ shown: 0, totalUsers: 0, totalPublicTinys: 0 }).tinys).toBe('0 public tinys')
    const junk = universeCounts({
      shown: NaN,
      totalUsers: Number('x'),
      totalPublicTinys: Infinity,
      limit: NaN,
    })
    expect(junk.builders).toBe('0 builders')
    expect(junk.tinys).toBe('0 public tinys')
    expect(junk.truncated).toBe(false)
  })

  it('a missing limit means no full-page claim (nothing to compare against)', () => {
    const out = universeCounts({ shown: 100, totalPublicTinys: 400 })
    expect(out.truncated).toBe(false)
  })
})

describe('hiddenTinyCount — overflow from the count, not the cut array', () => {
  it('derives the hidden tinys from tinyCount', () => {
    // The live shape: tinyCount 20, 8 embedded, 8 chips drawn → 12 hidden.
    expect(hiddenTinyCount(20, 8)).toBe(12)
    // The drawer draws 6 of the same 8 → 14 hidden.
    expect(hiddenTinyCount(20, 6)).toBe(14)
  })

  it('the OLD rule could never fire — that is the finding', () => {
    // `tinys.length > 8` on an array the worker caps AT 8.
    const embedded = COMMUNITY_TINYS_PER_USER
    expect(embedded - 8).toBe(0)
    expect(embedded > 8).toBe(false)
    // The new rule sees the same builder's 12 missing tinys.
    expect(hiddenTinyCount(20, Math.min(embedded, 8))).toBe(12)
  })

  it('nothing hidden → 0, so the link does not render', () => {
    expect(hiddenTinyCount(3, 3)).toBe(0)
    expect(hiddenTinyCount(0, 0)).toBe(0)
  })

  it('an incoherent count never produces a negative "+-3 more"', () => {
    expect(hiddenTinyCount(2, 8)).toBe(0)
    expect(hiddenTinyCount(undefined, 8)).toBe(0)
    expect(hiddenTinyCount('nope', 6)).toBe(0)
    expect(hiddenTinyCount(-5, 0)).toBe(0)
    expect(hiddenTinyCount(NaN, 4)).toBe(0)
  })
})

describe('constellationFooter — the picture is a sample', () => {
  it('qualifies the star count when tinys exist that were not drawn', () => {
    const out = constellationFooter({ builders: 5, starsShown: 13, totalPublicTinys: 25 })
    expect(out.label).toBe('5 builders · 13 of 25 tinys')
    expect(out.title).toContain('12')      // 25 - 13
    expect(out.title).toContain('8')       // the per-builder cap
  })

  it('says nothing extra when the drawing IS the universe', () => {
    const out = constellationFooter({ builders: 3, starsShown: 9, totalPublicTinys: 9 })
    expect(out.label).toBe('3 builders · 9 tinys')
    expect(out.title).toBeUndefined()
  })

  it('a caller with no census claims no omission', () => {
    // The component passes starsShown as the total when the prop is absent, so
    // an unqualified footer is what "we were told nothing" renders as.
    const out = constellationFooter({ builders: 2, starsShown: 4, totalPublicTinys: 4 })
    expect(out.title).toBeUndefined()
  })

  it('singulars and junk', () => {
    expect(constellationFooter({ builders: 1, starsShown: 1, totalPublicTinys: 1 }).label)
      .toBe('1 builder · 1 tiny')
    expect(constellationFooter({ builders: NaN, starsShown: NaN, totalPublicTinys: NaN }).label)
      .toBe('0 builders · 0 tinys')
  })
})

describe('normalizeCommunity carries totalUsers, and absent ≠ 0', () => {
  it('passes a finite total through, floored', () => {
    expect(normalizeCommunity({ users: [], totalUsers: 340 }).totalUsers).toBe(340)
    expect(normalizeCommunity({ users: [], totalUsers: '340' }).totalUsers).toBe(340)
    expect(normalizeCommunity({ users: [], totalUsers: 12.9 }).totalUsers).toBe(12)
    expect(normalizeCommunity({ users: [], totalUsers: 0 }).totalUsers).toBe(0)
  })

  it('an older payload without the field stays UNDEFINED, not 0', () => {
    // The distinction is load-bearing: undefined means "the page is all we
    // know" (universeCounts falls back to the full-page proof), while 0 would
    // be a census claiming an empty platform — and `0 >= shown` is false for
    // any non-empty page anyway, so a `|| 0` here would silently disable the
    // comparison instead of admitting ignorance.
    expect(normalizeCommunity({ users: [] }).totalUsers).toBeUndefined()
    expect('totalUsers' in normalizeCommunity({ users: [] })).toBe(false)
    expect(normalizeCommunity({ users: [], totalUsers: 'lots' }).totalUsers).toBeUndefined()
    // Number(null) === 0 and Number('') === 0 — a bare Number() would coerce an
    // explicit null into "zero builders", the exact claim this field prevents.
    expect(normalizeCommunity({ users: [], totalUsers: null }).totalUsers).toBeUndefined()
    expect(normalizeCommunity({ users: [], totalUsers: '' }).totalUsers).toBeUndefined()
    expect(normalizeCommunity({ users: [], totalUsers: '  ' }).totalUsers).toBeUndefined()
    expect(normalizeCommunity({ users: [], totalUsers: true }).totalUsers).toBeUndefined()
    expect(normalizeCommunity({ users: [], totalUsers: [] }).totalUsers).toBeUndefined()
    expect(normalizeCommunity({ users: [], totalUsers: -3 }).totalUsers).toBeUndefined()
  })

  it('end to end on the live payload shape', () => {
    const d = normalizeCommunity({
      users: [{ login: 'cagataycali', tinyCount: 20, tinys: Array.from({ length: 8 }, (_, i) => ({ name: `t${i}` })) }],
      totalUsers: 5,
      totalPublicTinys: 25,
      totalMessages: 6590,
    })
    // The page holds ONE builder of five and EIGHT tinys of twenty-five.
    expect(universeCounts({ shown: d.users.length, totalUsers: d.totalUsers, totalPublicTinys: d.totalPublicTinys, limit: COMMUNITY_PAGE }).builders)
      .toBe('1 of 5 builders')
    expect(hiddenTinyCount(d.users[0].tinyCount, d.users[0].tinys.length)).toBe(12)
  })
})

describe('census — every Universe surface uses the module, none counts a page', () => {
  const sites = [
    { file: 'components/Community.tsx', call: 'universeCounts(' },
    { file: 'components/chat/UniverseDrawer.tsx', call: 'universeCounts(' },
    { file: 'components/UniverseConstellation.tsx', call: 'constellationFooter(' },
  ]

  it('the three headers/footers call the module', () => {
    for (const s of sites) {
      expect(code(s.file), s.file).toContain(s.call)
    }
  })

  it('no surface renders a bare page length as "builders"', () => {
    // The exact shape of the old bug, in JSX and in a template literal.
    for (const f of ['components/Community.tsx', 'components/chat/UniverseDrawer.tsx', 'app/universe/opengraph-image.tsx']) {
      const src = code(f)
      expect(src, f).not.toMatch(/\{users\.length\}\s*builder/)
      expect(src, f).not.toMatch(/\$\{users\.length\}\s*builder/)
    }
  })

  it('neither card grid computes overflow from the truncated tinys array', () => {
    for (const f of ['components/UniverseDirectory.tsx', 'components/chat/UniverseDrawer.tsx']) {
      const src = code(f)
      // `u.tinys.length - 6` / `- 8` was the unreachable arithmetic. Ban the
      // SUBTRACTION, whatever the right-hand side: a mutant spelling it
      // `tinys.length - CHIPS` is the same bug and a `-\d` pattern misses it
      // (it survived exactly that way). tinys.length may still appear — the
      // chip row genuinely renders from the array.
      expect(src, f).not.toMatch(/tinys\.length\s*-/)
      // And the overflow GATE must be the helper, not just present somewhere in
      // the file: a `> 0` condition on anything else would re-introduce it.
      // (`[^)]*` would not span the nested `Math.min(...)` in the argument.)
      expect(src, f).toMatch(/hiddenTinyCount\((?:[^()]|\([^()]*\))*\)\s*>\s*0/)
    }
  })

  it('the OG card uses the census, not the page', () => {
    const src = code('app/universe/opengraph-image.tsx')
    expect(src).toContain('totalUsers')
    expect(src).toContain('builderCount')
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  learningsLimit,
  memoryHeader,
  LEARNINGS_LIST_MAX,
  LEARNINGS_RECALL_MAX,
  MEMORY_PANEL_LIMIT,
} from '../lib/chat/memory-list'

/**
 * Backlog v10 A1 — the Memory Panel header stated numbers about data it did
 * not fully receive.
 *
 * The organising property: `total` is a COUNT(*) of LIVE facts in every mode,
 * and the list is a capped page that becomes live+closed in history mode. Two
 * queries, two populations, one label — so the label was wrong twice, in
 * opposite directions.
 */

const repo = join(__dirname, '..')
const read = (p: string) =>
  readFileSync(join(repo, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('learningsLimit mirrors the WORKER cap instead of inventing one', () => {
  it("forwards the panel's 500 intact — the headline defect", () => {
    // The old relay clamped to 100, so a user with 250 memories got 100 rows
    // under a header that said 250. The worker's own cap is 500
    // (LearningsListCall: "0-500, default 100"), so 500 was always legal.
    expect(learningsLimit('500', false)).toBe('500')
    expect(MEMORY_PANEL_LIMIT).toBe(LEARNINGS_LIST_MAX)
  })

  it("forwards the mobile clients' 200 too", () => {
    // iOS Panels.swift:1465 and Android MemoryUniverse.kt:72 both ask 200 and
    // both silently got 100. Same route, same defect, three clients.
    expect(learningsLimit('200', false)).toBe('200')
  })

  it('still caps above the worker limit', () => {
    expect(learningsLimit('999999', false)).toBe(String(LEARNINGS_LIST_MAX))
    expect(learningsLimit(String(LEARNINGS_LIST_MAX + 1), false)).toBe(String(LEARNINGS_LIST_MAX))
    expect(learningsLimit(String(LEARNINGS_LIST_MAX), false)).toBe(String(LEARNINGS_LIST_MAX))
  })

  it('keeps the TIGHTER cap when q is present, because recall is the expensive path', () => {
    // Vectorize only runs `if (q)` — embed + MEMORY.query + a D1 join. That is
    // the cost the route's 10s bound exists for, and the one place a narrower
    // cap than the worker's is actually paying for something.
    expect(learningsLimit('500', true)).toBe(String(LEARNINGS_RECALL_MAX))
    expect(LEARNINGS_RECALL_MAX).toBeLessThan(LEARNINGS_LIST_MAX)
    expect(learningsLimit(String(LEARNINGS_RECALL_MAX), true)).toBe(String(LEARNINGS_RECALL_MAX))
  })

  it('preserves limit=0, which is a MODE and not a small number', () => {
    // ⚠️ The floor was worse than the cap. `Math.max(…, 1)` turned 0 into 1,
    // then `|| 30` made a bare 0 into 30 — and "0 = none" is documented in the
    // worker's own schema. Our `recall` tool fetches `&limit=0&q=…` precisely
    // to get semantic matches with NO recent list, so the same call routed
    // through this relay came back with 30 rows of unranked noise attached.
    expect(learningsLimit('0', false)).toBe('0')
    expect(learningsLimit('0', true)).toBe('0')
    expect(learningsLimit('-5', false)).toBe('0')
  })

  it('forwards NOTHING when there is nothing to forward', () => {
    // A relay's honest translation of "absent" is absence — the worker's
    // documented default (100) then applies. The old code's 30 was a number
    // this repo invented and no client could read anywhere.
    for (const v of [null, undefined, '', '   ']) {
      expect(learningsLimit(v as string | null, false), JSON.stringify(v)).toBeNull()
    }
  })

  it('forwards nothing for garbage rather than substituting a number', () => {
    // Number('abc') is NaN. The old `|| 30` silently answered a malformed
    // request with a made-up page size; forwarding nothing lets the worker's
    // default apply, which is at least a documented value.
    for (const v of ['abc', 'NaN', 'Infinity', '-Infinity', '1e']) {
      expect(learningsLimit(v, false), v).toBeNull()
    }
  })

  it('floors a fractional limit instead of passing it to SQL', () => {
    // D1 binds this straight into `LIMIT ?2`.
    expect(learningsLimit('10.9', false)).toBe('10')
    expect(learningsLimit('0.4', false)).toBe('0')
  })
})

describe('the header in LIVE-ONLY mode', () => {
  it('says the plain count when every live memory is on screen', () => {
    const h = memoryHeader({ total: 12, liveShown: 12, closedShown: 0, showHistory: false, limit: 500 })
    expect(h.label).toBe('12 live')
    expect(h.truncated).toBe(false)
    expect(h.title).toBeUndefined() // no explanation needed when nothing is hidden
  })

  it('names the omission when the page is capped — the defect a user cannot see', () => {
    // 250 memories, 100 rows: the old header said "250 live" over a list of
    // 100, and the missing 150 have no controls (close/expand live on rows).
    const h = memoryHeader({ total: 250, liveShown: 100, closedShown: 0, showHistory: false, limit: 100 })
    expect(h.label).toBe('100 of 250 live')
    expect(h.truncated).toBe(true)
    expect(h.title).toContain('100')
    expect(h.title).toContain('250')
    expect(h.title).toMatch(/recall/) // tells them how to reach the rest
  })

  it('a count mismatch is enough — no limit needed', () => {
    // `total` and the live list are the same population in this mode, so
    // liveShown < total is proof of omission by itself.
    const h = memoryHeader({ total: 9, liveShown: 4, closedShown: 0, showHistory: false })
    expect(h.truncated).toBe(true)
    expect(h.label).toBe('4 of 9 live')
  })

  it('a FULL page is treated as possibly-more even when the counts agree', () => {
    // total is a COUNT of live facts, so it can equal the page size exactly
    // while more exist; a full page is the only other evidence available.
    const h = memoryHeader({ total: 100, liveShown: 100, closedShown: 0, showHistory: false, limit: 100 })
    expect(h.truncated).toBe(true)
  })

  it('does not cry truncation on a page that is one row short of full', () => {
    const h = memoryHeader({ total: 99, liveShown: 99, closedShown: 0, showHistory: false, limit: 100 })
    expect(h.truncated).toBe(false)
    expect(h.label).toBe('99 live')
  })

  it('ignores closed rows that are not being rendered', () => {
    // rows can hold closed facts from a previous history toggle; only what is
    // painted may be counted.
    const h = memoryHeader({ total: 5, liveShown: 5, closedShown: 0, showHistory: false, limit: 500 })
    expect(h.label).toBe('5 live')
  })
})

describe('the header in HISTORY mode', () => {
  it('never claims a total SMALLER than the rows on screen', () => {
    // ⚠️ THE second defect, and the only one a user can catch by counting:
    // TOTALS_SQL is `WHERE owner = ?1 AND valid_to IS NULL`, so `total` counts
    // LIVE facts in every mode — there is no closed-inclusive total anywhere in
    // the worker. include_closed=1 makes the LIST live+closed, and the header
    // called that live-only number "total": 40 live + 30 closed rendered as
    // "40 total" above 70 visible rows.
    const h = memoryHeader({ total: 40, liveShown: 40, closedShown: 30, showHistory: true, limit: 500 })
    expect(h.label).toBe('70 shown · 40 live')
    expect(h.label).not.toMatch(/\b40 total\b/)
    expect(h.title).toContain('40 live')
    expect(h.title).toContain('30 closed')
  })

  it('says explicitly that closed history is uncounted', () => {
    // Otherwise "70 shown · 40 live" reads like a second truncation claim
    // rather than two different populations.
    const h = memoryHeader({ total: 40, liveShown: 40, closedShown: 30, showHistory: true, limit: 500 })
    expect(h.title).toMatch(/closed history isn't counted/i)
  })

  it('explains it even when nothing is missing, because the two numbers still differ', () => {
    const h = memoryHeader({ total: 3, liveShown: 3, closedShown: 1, showHistory: true, limit: 500 })
    expect(h.truncated).toBe(false)
    expect(h.title).toBeDefined() // 4 shown vs 3 live needs a sentence either way
    expect(h.label).toBe('4 shown · 3 live')
  })

  it('detects a truncated LIVE page even when closed rows outnumber the gap', () => {
    // ⚠️ Mutation M13 found this hole: comparing `shown` (live+closed) against
    // `total` (live only) is comparing populations, and the closed rows can
    // paper over a real omission — 30 of 40 live memories on screen looks fine
    // the moment 20 closed ones push the visible count to 50. The evidence for
    // a missing LIVE fact has to be a LIVE count. Not a full page either, so
    // the count comparison is the only thing that can catch it.
    const h = memoryHeader({ total: 40, liveShown: 30, closedShown: 20, showHistory: true, limit: 500 })
    expect(h.truncated).toBe(true)
    expect(h.title).toMatch(/more exist/)
  })

  it('flags a full page in history mode too', () => {
    const h = memoryHeader({ total: 300, liveShown: 300, closedShown: 200, showHistory: true, limit: 500 })
    expect(h.truncated).toBe(true)
    expect(h.title).toMatch(/more exist/)
  })
})

describe('a malformed worker body cannot produce a nonsense header', () => {
  it('coerces a missing or garbage total to 0 rather than rendering NaN', () => {
    // The panel does `Number(d.total || 0)` but a route/worker change could
    // hand this anything; a header is not the place to find out.
    expect(memoryHeader({ total: Number.NaN, liveShown: 2, closedShown: 0, showHistory: false }).label).not.toMatch(/NaN/)
    expect(memoryHeader({ total: -7, liveShown: 0, closedShown: 0, showHistory: false }).label).toBe('0 live')
  })

  it('an empty store reads as empty, in both modes', () => {
    expect(memoryHeader({ total: 0, liveShown: 0, closedShown: 0, showHistory: false, limit: 500 }).label).toBe('0 live')
    expect(memoryHeader({ total: 0, liveShown: 0, closedShown: 0, showHistory: false, limit: 500 }).truncated).toBe(false)
    expect(memoryHeader({ total: 0, liveShown: 0, closedShown: 0, showHistory: true, limit: 500 }).label).toBe('0 shown · 0 live')
  })

  it('a fractional row count never reaches the label', () => {
    expect(memoryHeader({ total: 4.7, liveShown: 2.2, closedShown: 0, showHistory: false }).label).toBe('2 of 4 live')
  })
})

describe('the route is wired to the rule', () => {
  const src = () => read('app/api/learnings/route.ts')

  it('no longer clamps with the invented floor-1/cap-100 expression', () => {
    const s = src()
    expect(s).not.toMatch(/Math\.min\(Math\.max\(Number\(limit\) \|\| 30, 1\), 100\)/)
    expect(s).toMatch(/learningsLimit\(limit, !!q\)/)
  })

  it('distinguishes "forward nothing" from "forward 0"', () => {
    // ⚠️ Anchored to the assignment, not the file: a truthiness test here would
    // drop `limit=0` again and re-break the recall mode, which is exactly the
    // shape of the bug (`if (clamped)` vs `if (clamped !== null)`).
    const s = src()
    expect(s).toMatch(/if \(clamped !== null\) qs\.set\('limit', clamped\)/)
    expect(s).not.toMatch(/if \(clamped\) qs\.set/)
  })

  it('passes the q flag, since the cap depends on it', () => {
    // `learningsLimit(limit, false)` would hand the expensive recall path the
    // 500-row list cap — a silent perf regression with no visible symptom.
    const s = src()
    const call = s.indexOf('learningsLimit(')
    expect(call).toBeGreaterThan(-1)
    expect(s.slice(call, call + 40)).toContain('!!q')
  })
})

describe('the panel is wired to the rule', () => {
  const src = () => read('components/chat/MemoryPanel.tsx')

  it('renders the computed header, not a hand-built label', () => {
    const s = src()
    expect(s).toMatch(/🧬 Memory · \{header\.label\}/)
    // The exact old expression, which is the bug in one line.
    expect(s).not.toMatch(/\{total\} \{showHistory \? "total" : "live"\}/)
    expect(s).toMatch(/title=\{header\.title\}/)
  })

  it('counts closed rows ONLY in history mode, matching what is painted', () => {
    // The list renders `[...live, ...(showHistory ? closed : [])]`, so a header
    // counting `closed.length` unconditionally would over-report in live mode.
    const s = src()
    expect(s).toMatch(/closedShown: showHistory \? closed\.length : 0/)
    expect(s).toMatch(/\[\.\.\.live, \.\.\.\(showHistory \? closed : \[\]\)\]/)
  })

  it('asks for the shared limit so the fetch and the truncation test agree', () => {
    // A hardcoded 500 in the URL with MEMORY_PANEL_LIMIT in the header would
    // make `fullPage` silently wrong the moment one of them moved.
    const s = src()
    expect(s).toMatch(/\/api\/learnings\?limit=\$\{MEMORY_PANEL_LIMIT\}/)
    expect(s).toMatch(/limit: MEMORY_PANEL_LIMIT/)
    expect(s).not.toMatch(/api\/learnings\?limit=500/)
  })
})

describe('the truncated-list census', () => {
  it('the mobile clients ask for 200 and are FIXED by the route change, not by this file', () => {
    // Recorded so nobody "fixes" them here: iOS/Android call the same relay, so
    // widening it widened them. Their own 200 stays their choice — pinned to
    // catch the day one of them asks for more than the worker allows.
    for (const p of [
      'ios/Tiny/Sources/Panels.swift',
      'android/app/src/main/java/technology/tiny/app/ui/MemoryUniverse.kt',
    ]) {
      const s = readFileSync(join(repo, p), 'utf8')
      const m = /\/api\/learnings\?limit=(\d+)/.exec(s)
      expect(m, p).not.toBeNull()
      expect(Number(m![1]), p).toBeLessThanOrEqual(LEARNINGS_LIST_MAX)
    }
  })

  it('recall still asks the worker for limit=0, which now survives the relay', () => {
    // The tool fetches the worker DIRECTLY today, so it never hit the relay's
    // floor. Pinned because the mode it depends on is the one this cycle
    // restored: if a future cycle routes it through /api/learnings, 0 has to
    // still mean 0.
    const s = read('lib/chat/tools/memory.ts')
    expect(s).toMatch(/limit=0&q=/)
  })

  it('the sibling relays clamp their OWN limits, and are left alone deliberately', () => {
    // /api/graph's feed and /api/messages both cap at 100/200 — those match
    // their worker endpoints' documented caps (feed "default 30, max 100";
    // social "default 50" cap 200), so they are mirrors already, not inventions.
    // This cycle's finding was specific to learnings; recorded so the next
    // reader doesn't assume every Math.min in an api route is the same bug.
    expect(read('app/api/graph/route.ts')).toMatch(/Math\.min\(Math\.max\(Number\(limit\) \|\| 30, 1\), 100\)/)
    expect(read('app/api/messages/route.ts')).toMatch(/Math\.min\(Math\.max\(Number\(limit\) \|\| 50, 1\), 200\)/)
  })
})

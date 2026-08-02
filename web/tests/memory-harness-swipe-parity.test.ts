// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The memory sheet's two destructive controls, under the asset harness.
 *
 * `--memory-list-harness` substitutes what the list SHOWS and nothing else, so
 * both swipe actions kept operating on the real account and the real phone while
 * every row on screen was fabricated:
 *
 *  - the server row sends `DELETE /api/learnings` with a demo id. `serverWire()`
 *    uses 100…108 / 200…202 — ordinary D1 autoincrement values a real account
 *    plausibly owns — so a swipe taken to DEMONSTRATE the swipe could close one
 *    of the user's own memories.
 *  - the local row calls `Continuity.forgetMemory` and then re-reads
 *    `Continuity.memories(tiny)`, replacing the demo list with the user's REAL
 *    on-device memories mid-capture. That is precisely the leak the harness
 *    exists to prevent, arriving through the harness's own UI.
 *
 * Android guards both and pins it (`MemoryHarnessTest.kt`, "neither delete
 * reaches the device store or the account under the harness"). iOS had neither
 * the guard nor the pin, so the standing capture rule — seed content, never
 * mutate the account for an asset — held on one phone only.
 *
 * ⚠️ Every guard assertion here is bounded to its OWN row closure. Android's
 * test records why: its first draft searched the whole enclosing function, and a
 * mutant that deleted the local guard outright still PASSED, because the sibling
 * guard earlier in the same function satisfied the search. A guard-exists scan
 * over an enclosing function proves the FILE has a guard, not that this call site
 * consults one.
 */

const repo = join(__dirname, '..')
const panels = () => readFileSync(join(repo, 'ios/Tiny/Sources/Panels.swift'), 'utf8')
const universe = () =>
  readFileSync(join(repo, 'android/app/src/main/java/technology/tiny/app/ui/MemoryUniverse.kt'), 'utf8')

/** The MemoryView body, so a same-named symbol elsewhere in the file can't answer for it. */
const memoryView = () => {
  const src = panels()
  const start = src.indexOf('struct MemoryView: View {')
  const end = src.indexOf('\n// ── 📱 Devices', start)
  expect(start, 'MemoryView is gone from Panels.swift — re-anchor').toBeGreaterThan(-1)
  expect(end, 'the Devices marker after MemoryView is gone — re-anchor').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('iOS: neither swipe reaches the account or the device store under the harness', () => {
  it('the LOCAL row consults the guard before re-reading the real store', () => {
    const v = memoryView()
    const rows = v.indexOf('ForEach(local) { m in')
    expect(rows, 'the local rows are gone — re-anchor').toBeGreaterThan(-1)
    const forget = v.indexOf('Continuity.forgetMemory(', rows)
    const reread = v.indexOf('Continuity.memories(tiny)', forget)
    expect(forget, 'the local swipe no longer calls forgetMemory — re-anchor').toBeGreaterThan(rows)
    expect(reread, 'the local swipe no longer re-reads Continuity — re-anchor').toBeGreaterThan(forget)

    const guard = v.indexOf('if isDemo', rows)
    expect(
      guard > rows && guard < forget,
      'nothing guards the LOCAL delete inside its own closure: one tap on a demo row ' +
        "calls forgetMemory and then swaps the user's REAL on-device memories into the shot",
    ).toBe(true)
    // …and it must RETURN, not merely branch, or the real calls still run after it.
    expect(v.slice(guard, forget)).toMatch(/return/)
  })

  it('the SERVER row consults the guard before the DELETE', () => {
    const v = memoryView()
    const rows = v.indexOf('ForEach(server, id: \\.id) { m in')
    expect(rows, 'the server rows are gone — re-anchor').toBeGreaterThan(-1)
    const del = v.indexOf('await forget(m.id)', rows)
    expect(del, 'the server swipe no longer calls forget — re-anchor').toBeGreaterThan(rows)

    // Bounded at the server ForEach, which already sits AFTER the local closure —
    // so the local guard cannot answer for this one.
    const guard = v.indexOf('if isDemo', rows)
    expect(
      guard > rows && guard < del,
      'nothing guards the SERVER delete inside its own closure: a tap on a demo row sends ' +
        "a real DELETE to the signed-in account with a fabricated id",
    ).toBe(true)
    expect(v.slice(guard, del)).toMatch(/return/)
  })

  it('the two guards are SEPARATE — one cannot answer for the other', () => {
    // The exact mutant Android's first draft missed. Two closures, two guards.
    //
    // A FLOOR, not an exact count: an exact 2 reds the day someone consults
    // `isDemo` for something harmless elsewhere in this view — legal work, and a
    // census that punishes a correct addition is a hand-kept list wearing a
    // matcher. What must never happen is FEWER than two, and the two tests above
    // are what prove each one sits inside its own closure; this is the count they
    // cannot state.
    const v = memoryView()
    expect((v.match(/if isDemo/g) || []).length).toBeGreaterThanOrEqual(2)
    // …and the two the tests above found are genuinely different occurrences.
    const localAt = v.indexOf('if isDemo', v.indexOf('ForEach(local) { m in'))
    const serverAt = v.indexOf('if isDemo', v.indexOf('ForEach(server, id: \\.id) { m in'))
    expect(localAt).toBeGreaterThan(-1)
    expect(serverAt).toBeGreaterThan(localAt)
  })

  it('the guard is DEBUG-only, so a release build cannot be argv-tricked', () => {
    // Matches Android's `BuildConfig.DEBUG &&` conjunct. Without it, shipping an
    // app that goes inert on a command-line flag is a strictly worse bug than the
    // one being fixed.
    const v = memoryView()
    const decl = v.indexOf('private var isDemo: Bool {')
    expect(decl, 'isDemo is gone — re-anchor').toBeGreaterThan(-1)
    const body = v.slice(decl, decl + 320)
    expect(body).toMatch(/#if DEBUG/)
    expect(body).toMatch(/MemoryHarness\.usesDemoDataset\(arguments: ProcessInfo\.processInfo\.arguments\)/)
    expect(body).toMatch(/#else\s*\n\s*false/)
  })

  it('the inert path still updates the list, or the swipe looks broken on camera', () => {
    // The point of the harness is a capture that demonstrates the gesture. A
    // guard that only refused would show a row that will not go away.
    const v = memoryView()
    expect(v).toMatch(/if isDemo \{ local\.removeAll \{ \$0\.id == m\.id \}; return \}/)
    expect(v).toMatch(/if isDemo \{ server\.removeAll \{ \$0\.id == m\.id \}; return \}/)
  })
})

describe('cross-platform: the rule now holds on BOTH phones', () => {
  it('Android still guards both of its rows', () => {
    // Pinned so the parity statement above cannot quietly become false in the
    // other direction — this is the client that had it right.
    const k = universe()
    const sheet = k.indexOf('fun MemorySheet(')
    const localRows = k.indexOf('items(local', sheet)
    const forget = k.indexOf('continuity.forgetMemory(', localRows)
    const serverRows = k.indexOf('items(server!!', sheet)
    const del = k.indexOf('deleteJson("/api/learnings"', serverRows)
    const localGuard = k.indexOf('if (demo)', localRows)
    const serverGuard = k.indexOf('if (demo)', serverRows)
    expect(localGuard > localRows && localGuard < forget).toBe(true)
    expect(serverGuard > serverRows && serverGuard < del).toBe(true)

    // ⚠️ Placement is only half of it, and this half was missing on THIS side while
    // the iOS tests above pinned it: a guard that filters the displayed list and
    // then falls through still reaches the real store one line later. Measured — a
    // mutant that dropped `return@MemoryRow` from the server row left the whole
    // suite green. So each guard must also SEPARATE itself from the real call,
    // either by returning out of the row or by putting the real work in an `else`.
    for (const [what, from, to] of [
      ['local', localGuard, forget],
      ['server', serverGuard, del],
    ] as const) {
      expect(
        k.slice(from, to),
        `Android's ${what} guard branches and falls through — the real delete still runs`,
      ).toMatch(/return@|\}\s*else\s*\{/)
    }
  })

  it('the demo ids really are values a real account could own', () => {
    // The reason the server-side swipe was dangerous rather than merely untidy.
    // If the harness used something unmatchable, this would be a tidiness fix.
    const v = memoryView()
    expect(panels()).toMatch(/"id": NSNumber\(value: 100 \+ i\)/)
    expect(panels()).toMatch(/"id": NSNumber\(value: 200 \+ i\)/)
    // …and the delete goes to the real base URL, not a harness stub.
    expect(v).toMatch(/Api\.base \+ "\/api\/learnings"/)
  })
})

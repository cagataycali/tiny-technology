// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `MemoryView.forget` — the wiring half of the forget verdict.
 *
 * The DECISION is tested for real in Swift (`TinyTests.swift`,
 * `MemoryForgetVerdictTests`, 11 tests through `ForgetVerdict.message`). What
 * Swift cannot reach is the call site: `forget` is `private` on a `@MainActor`
 * view, so nothing but a source scan can assert that the reload actually feeds
 * the verdict. Deleting the wiring leaves all 11 Swift tests green, which is
 * exactly the gap these pins close.
 *
 * The defect: `forget` reloaded server truth on purpose — never optimistic-drop
 * — and then overwrote the conclusion with a transport-derived guess,
 * `forgetError = ok ? nil : "Couldn't forget that — try again."` A memory
 * already closed on another device answers 404, the reload shows it GONE, and
 * the user got a red "try again" pointing at a row that had already left the
 * list. It also hand-rolled `URLSession` instead of `Api.deleteJson`, whose own
 * doc says non-2xx "throws ApiError.http like every other verb, so callers can
 * tell a 404 (already gone) apart" — the very distinction being discarded.
 *
 * ⚠️ Every scan is scoped to the `forget` body. `load()` legitimately spells
 * `Api.get`, and `URLSession` appears elsewhere in Panels.swift — an unscoped
 * scan for a shared idiom fails on an innocent sibling
 * (tests/unlearn-scope.test.ts:129, the c60 lesson, which recurred at inc 29).
 */

const repo = join(__dirname, '..')
const panels = () => readFileSync(join(repo, 'ios/Tiny/Sources/Panels.swift'), 'utf8')

/**
 * Panels.swift with whole-line comments removed.
 *
 * ⚠️ Load-bearing: `ForgetVerdict`'s doc QUOTES the defect it replaced
 * (`forgetError = ok ? nil : "Couldn't forget that — try again."`) because that
 * sentence is why the type exists. A scan over the raw file therefore finds the
 * old code in a comment and counts a write that isn't one — the first draft of
 * this file asserted 2 assignments and measured 3. Keeping the quote and reading
 * past it is better than deleting the explanation to satisfy a regex.
 */
const code = () => panels().replace(/^\s*\/\/.*$/gm, '')

/**
 * Just `forget` — the last method of MemoryView, before the Devices section.
 *
 * Sliced from the RAW file (the `// ── 📱 Devices` anchor is itself a comment,
 * so it cannot survive stripping) and stripped afterwards. Both are needed:
 * `forget`'s own doc quotes `code < 400` as the thing it replaced, so a scan of
 * the raw slice for the old idiom finds the explanation and reports the defect.
 * Twice in one increment now — the rule is scan CODE, never prose, whenever the
 * prose deliberately quotes the code.
 */
const forget = () => {
  const src = panels()
  const start = src.indexOf('private func forget(_ id: String) async {')
  const end = src.indexOf('\n// ── 📱 Devices', start)
  expect(start, 'MemoryView.forget is gone — re-anchor').toBeGreaterThan(-1)
  expect(end, 'the Devices marker after MemoryView is gone — re-anchor').toBeGreaterThan(start)
  return src.slice(start, end).replace(/^\s*\/\/.*$/gm, '')
}

describe('the reload decides the verdict, not the status code', () => {
  it('the transport guess is gone', () => {
    const f = forget()
    // The defect, expressed as its own fingerprint. Read past the comments, or
    // ForgetVerdict's own doc — which quotes the old line — answers for the code.
    expect(f).not.toMatch(/ok \? nil :/)
    expect(code()).not.toMatch(/Couldn't forget that/)
    // …including the status comparison it was derived from.
    expect(f).not.toMatch(/code < 400/)
  })

  it('the verdict is computed from the RELOADED list', () => {
    const f = forget()
    expect(f).toMatch(/forgetError = ForgetVerdict\.message\(/)
    expect(f).toMatch(/listed: server\.map\(\\\.id\)/)
    expect(f).toMatch(/reloaded: state/)
  })

  it('the reload happens BEFORE the verdict, or the list it reads is the old one', () => {
    // Ordering is the whole point: `server` and `state` are only truth after
    // load() returns. Computing the verdict first would read the pre-delete list
    // and report "still there" for every successful forget.
    const f = forget()
    const reload = f.indexOf('await load()')
    const verdict = f.indexOf('ForgetVerdict.message(')
    expect(reload, 'forget no longer reloads — that is the optimistic-drop bug android hit').toBeGreaterThan(-1)
    expect(verdict).toBeGreaterThan(reload)
  })

  it('the DELETE goes through the shared verb, which carries the body', () => {
    const f = forget()
    expect(f).toMatch(/Api\.deleteJson\("\/api\/learnings", token: token, body: \["id": id\]\)/)
    // The hand-rolled request is gone: no URLSession, and no `try?` body encode.
    // `Api.request` encodes with `try`, so an unencodable body throws instead of
    // being sent as NO body — which on this route meant "erase every memory"
    // until inc 29 refused it (lib/chat/learnings-delete-scope).
    expect(f).not.toMatch(/URLSession\.shared/)
    expect(f).not.toMatch(/try\? JSONSerialization\.data/)
    // The failure's own sentence is what reaches the verdict, not a bare code.
    expect(f).toMatch(/catch \{ serverSaid = error\.localizedDescription \}/)
  })

  it('the caption is still rendered, or the verdict is invisible', () => {
    // Without this the whole increment could be decoration: `forgetError` is
    // only ever seen through the Server section's red caption.
    //
    // ⚠️ Scoped to MemoryView. `Text(e).font(.caption).foregroundStyle(.red)` is
    // a house idiom that appears again ~2300 lines below in another panel, so a
    // whole-file scan would be satisfied by THAT caption while this one was
    // deleted. The mutation dry-check caught it ("needle appears 2x") — the same
    // over-broad-scan trap this file's header warns about, in a pin of my own.
    const src = panels()
    const start = src.indexOf('struct MemoryView: View {')
    const view = src.slice(start, src.indexOf('\n// ── 📱 Devices', start))
    expect(view).toMatch(
      /if let e = forgetError \{\n\s+Text\(e\)\.font\(\.caption\)\.foregroundStyle\(\.red\)/,
    )
  })

  it('nothing else writes a verdict behind the rule', () => {
    // ⚠️ This counted EVERY `forgetError = ` and demanded exactly 2 (the
    // pull-to-refresh clear, and the verdict). Measured: a mutant that clears the
    // caption as a new swipe begins — `forgetError = nil` before the DELETE, plain
    // correct UI work that cannot lie, because nil makes no claim — was RED. An
    // exact census over a whole class of writes punishes legal additions; it is a
    // hand-kept list wearing a matcher.
    //
    // The rule is about OPINIONS, so count only those: a write whose right-hand
    // side is neither `nil` nor the verdict itself is a second opinion competing
    // with the observation, and there must be none.
    const opinions = (code().match(/forgetError = (?!nil\b|ForgetVerdict\.message\()[^\n]*/g) || [])
    expect(opinions, `a verdict is written behind the rule: ${opinions.join(' / ')}`).toEqual([])
    // …and the verdict is written exactly once, or two of them race.
    expect((code().match(/forgetError = ForgetVerdict\.message\(/g) || []).length).toBe(1)
    // Clears stay legal, and the pull-to-refresh one must still be there: it is
    // what stops a stale caption outliving the list it was written about.
    expect(code()).toMatch(/forgetError = nil\n\s+local = Continuity\.memories\(tiny\)/)
  })
})

describe('the decision itself is tested where it can be RUN', () => {
  it('the Swift suite exists and drives ForgetVerdict, not a source scan', () => {
    // A pin on the pin: if MemoryForgetVerdictTests is deleted, these scans are
    // all that remain, and scans cannot tell whether the logic is right.
    const swift = readFileSync(join(repo, 'ios/Tests/TinyTests.swift'), 'utf8')
    // ⚠️ `indexOf` checked BEFORE slicing: `slice(-1)` returns the last
    // character, which is not '' — so the obvious `.not.toBe('')` would have
    // passed with the suite deleted. Found by asking what mutant would kill it.
    // ⚠️ The needle carries its BRACE. Without it, `indexOf` matched a prefix, and
    // the commonest way a suite is turned off is a rename — measured: renaming it
    // to `MemoryForgetVerdictTestsDISABLED` left this pin green while the eleven
    // tests it vouches for stopped existing under that name.
    const at = swift.indexOf('@Suite struct MemoryForgetVerdictTests {')
    expect(at, 'MemoryForgetVerdictTests is gone or renamed — the decision would be untested').toBeGreaterThan(-1)
    // ⚠️ …and the slice STOPS at the next suite. `slice(at)` ran to end-of-file, so
    // every needle below could be answered by a later suite — measured: gutting the
    // headline case and writing the three needles into DmLengthTests as COMMENTS
    // passed. That is the over-broad-scan trap this file's own header warns about,
    // in the pin that guards all the others.
    const nextSuite = swift.indexOf('\n@Suite', at + 1)
    const slice = nextSuite > at ? swift.slice(at, nextSuite) : swift.slice(at)
    // ⚠️ …and prose is not evidence, block comments included. Measured: commenting
    // FOUR cases out with a `/* … */` that spans them left every needle and the
    // count below unchanged, because a disabled test still spells `@Test`. A
    // commented-out suite is a suite that does not run — read the code.
    const suite = slice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(suite).toMatch(/ForgetVerdict\.message\(/)
    // The load-bearing case: gone is gone, even when the DELETE reported 404.
    expect(suite).toMatch(/Api\.httpMessage\(404, "no memory with id 100"\)/)
    // …and the increment's rule, as its own test.
    expect(suite).toMatch(/with the list readable, the status code gets no vote/)
    // Eleven cases drive the decision. A FLOOR, not a census — new cases are the
    // point — but an empty or gutted suite must not read as a pass.
    expect((suite.match(/@Test/g) || []).length).toBeGreaterThanOrEqual(11)
  })

  it('ForgetVerdict lives outside MemoryView so a plain test can read it', () => {
    // The lesson MemoryHarness already recorded in this file: a helper on a
    // @MainActor view is a helper nothing pins.
    const src = panels()
    const verdictAt = src.indexOf('enum ForgetVerdict {')
    const viewAt = src.indexOf('struct MemoryView: View {')
    // Both anchors asserted present first: a missing ForgetVerdict yields -1,
    // and -1 IS less than any real offset, so the bare comparison would pass on
    // a deleted type. Same weakness as the suite pin above.
    expect(verdictAt, 'ForgetVerdict is gone — re-anchor').toBeGreaterThan(-1)
    expect(viewAt, 'MemoryView is gone — re-anchor').toBeGreaterThan(-1)
    expect(verdictAt).toBeLessThan(viewAt)
    // ⚠️ Order is not the claim — NESTING is, and the two are different. Measured:
    // wrapping the enum in `extension MemoryView { … }` above the struct keeps this
    // comparison true while making the type a member of the view again. At file
    // scope the declaration starts at column 0, so require that.
    expect(src).toMatch(/^enum ForgetVerdict \{$/m)
  })
})

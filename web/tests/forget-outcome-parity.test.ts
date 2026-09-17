// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The `forget` / `remember` outcome contract, across all three surfaces.
 *
 * The DECISION is tested for real on each platform: web through
 * `forgetMemoryOutcome` (tests/continuity.test.ts), Kotlin through
 * `Continuity.decide` (ForgetOutcomeTest, 13 tests), Swift through
 * `Continuity.forgetOutcome` against the real store (TinyTests.swift,
 * `ForgetOutcomeTests`). What none of them can see is the OTHER TWO — and this
 * bug was that the phones each carried a defect web had already fixed and
 * documented. A per-platform suite is green while the surfaces disagree, which
 * is exactly the gap these pins close.
 *
 * The defect, measured on both phones: `forgetMemory` answered from the FILTER
 * (the in-memory list shrank) while the store write swallowed every failure.
 * Kotlin's voice executor then discarded even that and returned a bare
 * `{ ok: true }`. A refused write was reported to the MODEL as a removal — the
 * tiny SPEAKS that — and `buildContext` kept injecting the "forgotten" fact into
 * every later request. Web's own doc names the harm: "I forgot your address"
 * followed by the address, forever.
 *
 * ⚠️ Every scan below reads CODE, not prose. Both `Continuity` files
 * deliberately QUOTE the old bug in their doc comments (that quote is why the
 * type exists), so an unstripped scan finds the defect in the explanation and
 * reports a regression that isn't one — the recurring lesson from
 * tests/memory-forget-verdict.test.ts.
 */

const repo = join(__dirname, '..')

const read = (p: string) => {
  const text = readFileSync(join(repo, p), 'utf8')
  // A slicer that silently returns "" passes every assertion below forever.
  expect(text.length, `could not read ${p} — re-anchor`).toBeGreaterThan(500)
  return text
}

/** Strip whole-line `//` comments (Kotlin/Swift) so prose can't satisfy a scan. */
const stripLineComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, '')
// Strip block comments too (Swift triple-slash docs are already gone above) —
// the quoted defects live in those, and a scan must never read prose.
const stripDocs = (s: string) =>
  stripLineComments(s).replace(/\/\*[\s\S]*?\*\//g, '')

const kotlinContinuity = () => stripDocs(read('android/app/src/main/java/technology/tiny/app/chat/Continuity.kt'))
const swiftContinuity = () => stripDocs(read('ios/Tiny/Sources/Continuity.swift'))
const webContinuity = () => stripDocs(read('components/chat/continuity.ts'))

describe('forget: three outcomes on every surface', () => {
  it('all three platforms name the same three cases', () => {
    // Web is the reference — it fixed this first (v13 G2) and its type is the
    // shape the phones were ported to.
    const web = webContinuity()
    expect(web).toMatch(/ForgetOutcome\s*=\s*"forgotten"\s*\|\s*"no-match"\s*\|\s*"blocked"/)

    // Kotlin: an enum, so the compiler enforces exhaustiveness at the call site.
    expect(kotlinContinuity()).toMatch(
      /enum class ForgetOutcome\s*\{\s*FORGOTTEN\s*,\s*NO_MATCH\s*,\s*BLOCKED\s*\}/
    )

    // Swift: same three, spelled in Swift's idiom.
    expect(swiftContinuity()).toMatch(/enum ForgetOutcome\b[\s\S]{0,120}?case forgotten, noMatch, blocked/)
  })

  it('the shrink is never sufficient — every surface consults the WRITE', () => {
    // THE defect. On all three, the answer must come from the write's verdict,
    // not from the filtered array's length.
    expect(webContinuity()).toMatch(/return write\(memKey\(name\), filtered\) \? "forgotten" : "blocked"/)
    // Line-anchored for the same reason as `remember` below: a trailing `|| true`
    // or `?: .forgotten` contains the honest form while discarding its verdict.
    expect(kotlinContinuity()).toMatch(
      /^ {8}return decide\(mems\.size - keep\.size, saveMemories\(tiny, keep\)\)$/m
    )
    expect(swiftContinuity()).toMatch(
      /^ {8}return write\("memories", name, filtered\) \? \.forgotten : \.blocked$/m
    )
  })

  it('a no-match short-circuits BEFORE the write on every surface', () => {
    // Otherwise a store that never needed changing gets reported as having
    // refused — "couldn't forget, storage is full" over a typo'd match string.
    expect(webContinuity()).toMatch(/if \(filtered\.length === mems\.length\) return "no-match"/)
    // The phones route it through `survivors`, whose nil/null IS the short-circuit.
    expect(kotlinContinuity()).toMatch(
      /^ {8}val keep = survivors\(mems, match\) \?: return ForgetOutcome\.NO_MATCH to 0$/m
    )
    expect(swiftContinuity()).toMatch(
      /^ {8}guard let filtered = survivors\(mems, idOrText\) else \{ return \.noMatch \}$/m
    )
  })

  it('🔴 a blank needle cannot reach the store on ANY surface', () => {
    // The highest-severity line in this file. `match` comes straight from the
    // model's forget tool call, and the empty-substring semantics DIFFER:
    //   JS      "abc".includes("")  === true   → blank matches EVERY memory
    //   JVM     "abc".contains("")  === true   → blank matches EVERY memory
    //   Swift   "abc".contains("")  === false  → blank matches nothing
    // (all three measured, not assumed). So deleting this guard on web or Android
    // WIPES the store and reports "forgotten" with a proud count, while on iOS it
    // is a no-op the next check absorbs — an equivalent mutant. That asymmetry is
    // exactly why a per-platform suite can't own this: iOS's test is green for a
    // reason that does not transfer, and Android's guard was reachable only
    // through a Context (device-only) until `survivors` was extracted.
    expect(webContinuity()).toMatch(/if \(typeof idOrText !== "string" \|\| !idOrText\.trim\(\)\) return "no-match"/)
    expect(kotlinContinuity()).toMatch(/^ {12}if \(match\.isBlank\(\)\) return null$/m)
    expect(swiftContinuity()).toMatch(/^ {8}guard !needle\.isEmpty else \{ return nil \}$/m)

    // And it must be the FIRST thing each one does — a guard placed after the
    // filter has already matched everything.
    for (const [label, src, guard, filter] of [
      ['kotlin', kotlinContinuity(), 'if (match.isBlank()) return null', 'filterNot {'],
      ['swift', swiftContinuity(), 'guard !needle.isEmpty else { return nil }', 'mems.filter {'],
    ] as const) {
      const g = src.indexOf(guard)
      const f = src.indexOf(filter, g)
      expect(g, `${label}: guard missing`).toBeGreaterThan(-1)
      expect(f, `${label}: filter missing after guard`).toBeGreaterThan(g)
    }
  })

  it('the match predicate lives in ONE pure function per phone', () => {
    // Pure = testable without a Context/container. The Android guard above was
    // ONLY reachable on a device, so no gate could fail if it were deleted; that
    // is how a store-wiping defense went unpinned. Both are now `survivors`.
    expect(kotlinContinuity()).toMatch(
      /^ {8}fun survivors\(mems: List<MemoryEntry>, match: String\): List<MemoryEntry>\? \{$/m
    )
    expect(swiftContinuity()).toMatch(
      /^ {4}static func survivors\(_ mems: \[MemoryEntry\], _ idOrText: String\) -> \[MemoryEntry\]\? \{$/m
    )
    // nil/null means "don't touch the store"; an empty list is a legitimate
    // full clear. Collapsing the two reports an untouched store as blocked.
    expect(kotlinContinuity()).toMatch(/^ {12}return if \(keep\.size == mems\.size\) null else keep$/m)
    expect(swiftContinuity()).toMatch(/^ {8}return filtered\.count < mems\.count \? filtered : nil$/m)
  })

  it('the phone store writes report failure instead of swallowing it', () => {
    // Both used to discard the result: Kotlin a runCatching with no failure
    // branch, Swift a bare try-question-mark. Nothing downstream COULD have
    // caught the lie.
    const k = kotlinContinuity()
    expect(k).toContain('private fun atomicWrite(file: File, text: String): Boolean')
    expect(k).toContain('private fun saveMemories(tiny: String, mems: List<MemoryEntry>): Boolean')
    // The regression shape: the catch arm must exist and return false.
    expect(k).toMatch(/\}\.getOrElse \{ t ->[\s\S]{0,200}?false/)

    const s = swiftContinuity()
    expect(s).toContain('private static func write<T: Encodable>(_ kind: String, _ name: String, _ items: [T]) -> Bool')
    // A bare try-question-mark on the memory write is the exact defect — it
    // cannot report.
    expect(s).not.toMatch(/try\? data\.write\(to: url\(kind, name\)/)
    expect(s).toMatch(/try data\.write\(to: url\(kind, name\), options: \.atomic\)/)
  })

  it('remember reports durability on every surface', () => {
    expect(webContinuity()).toMatch(/export function addMemory\([^)]*\): boolean/)
    expect(kotlinContinuity()).toContain(
      'fun addMemory(tiny: String, content: String, tags: List<String>): Boolean'
    )
    expect(swiftContinuity()).toContain(
      'static func addMemory(_ name: String, content: String, tags: [String]? = nil) -> Bool'
    )
  })

  it('remember RETURNS the write, and does not hardcode success', () => {
    // A signature alone is vacuous: `addMemory(): Boolean` that ends in
    // `saveMemories(...); return true` type-checks, satisfies the pin above, and
    // reinstates the exact bug. Measured — that mutant survived every suite on
    // both platforms until this assertion existed.
    // ⚠️ Line-ANCHORED, not substring: `return saveMemories(...) || true` contains
    // the honest form verbatim while hardcoding success, and a toContain pin voted
    // for it (measured — that mutant survived until these anchors).
    expect(webContinuity()).toMatch(/^ {2}return write\(memKey\(name\), mems\.slice\(-MEMORY_MAX\)\);?$/m)
    expect(kotlinContinuity()).toMatch(/^ {8}return saveMemories\(tiny, mems\)$/m)
    expect(swiftContinuity()).toMatch(/^ {8}return write\("memories", name, Array\(mems\.suffix\(memoryMax\)\)\)$/m)

    // And the guards return the same falsity, rather than dropping out as Unit.
    expect(kotlinContinuity()).toMatch(/^ {8}if \(content\.isBlank\(\)\) return false$/m)
    expect(swiftContinuity()).toMatch(/^ {8}guard !c\.isEmpty else \{ return false \}$/m)
  })

  it('the predicate has exactly one implementation per surface', () => {
    // Two copies of "did this match AND land?" is how the two answers drift.
    expect(webContinuity()).toMatch(/return forgetMemoryOutcome\(name, idOrText\) === "forgotten"/)
    expect(kotlinContinuity()).toContain('forgetOutcome(tiny, match).let')
    expect(swiftContinuity()).toMatch(/forgetOutcome\(name, idOrText\) == \.forgotten/)

    // And the filter must appear ONCE in each file — a second copy is the drift,
    // and a second copy is also how the blank-needle guard gets honoured on one
    // path and bypassed on another.
    //
    // ⚠️ These two counts used to spell out each phone's predicate in full
    // (`filterNot { it.content.contains(match` / `mems.filter { $0.id != idOrText`).
    // Between them they recorded, in green, that Android matched only content
    // while iOS also matched an id — see the next test. Count the filter; let the
    // next test own what is IN it.
    expect(kotlinContinuity().match(/mems\.filterNot \{/g)?.length).toBe(1)
    expect(swiftContinuity().match(/mems\.filter \{/g)?.length).toBe(1)
    expect(webContinuity().match(/filter\(\(m\) =>|filter\(m =>/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('every surface forgets by ID **or** by content — both arms, all three', () => {
    // ⚠️⚠️ THE DEFECT THIS CLOSES WAS PINNED GREEN BY THE TEST ABOVE. Android's
    // `survivors` had the content arm only, so the memory sheet's delete could
    // not name one row and passed `m.content.take(40)` — a substring, into a
    // substring match. A memory whose whole text was under 40 chars took out
    // every longer memory containing it ("likes coffee" → also "likes coffee in
    // the morning"), silently. iOS passed `m.id` and deleted exactly one.
    //
    // Rule 21, again: a parity suite pins that two implementations MATCH, never
    // that either is CORRECT — and here it did not even pin a match. So this
    // derives the invariant per surface and names the surface that lacks an arm,
    // rather than transcribing three predicates that can drift independently.
    //
    // The id arm is NOT for the model: `forget`'s schema takes text
    // (lib/chat/tools/client-side.ts) and no surface ever renders an id into the
    // context. It exists so a UI row can name exactly one memory, which is why
    // the caller is pinned too (iOS `Panels.swift`, Android `MemoryUniverse.kt`).
    const surfaces: Array<{ name: string; body: string; needle: RegExp }> = [
      { name: 'web', body: webContinuity(), needle: /mems\.filter\(([\s\S]*?)\)\s*;/ },
      { name: 'Android', body: kotlinContinuity(), needle: /mems\.filterNot \{(.*)\}/ },
      { name: 'iOS', body: swiftContinuity(), needle: /mems\.filter \{(.*)\}/ },
    ]

    for (const { name, body, needle } of surfaces) {
      const pred = body.match(needle)?.[1]
      // Floor AND ceiling: a moved anchor yields undefined (caught here), and a
      // terminator that stops matching would otherwise swallow unrelated code and
      // satisfy both arms off it.
      //
      // ⚠️ The ceiling only has teeth on WEB. The phone needles use `.`, which
      // excludes newlines, so their read cannot grow past one line however the
      // terminator moves — only web's `[\s\S]*?` crosses lines, and deleting its
      // `);` makes the window run ~15 lines into `clearMemories` and swell past
      // 200. (Measured: a mutant that appended junk to the Kotlin line SURVIVED,
      // because it never made the read bigger. The survivor was the mutant's
      // fault, not the pin's.) Kept for all three anyway — it costs nothing and a
      // future multi-line reformat on a phone would land inside its reach.
      expect(pred, `${name}: could not read the forget predicate — re-anchor`).toBeTruthy()
      expect(pred!.length, `${name}: predicate read is implausibly long — re-anchor`)
        .toBeLessThan(200)

      expect(pred, `${name} does not match a memory by its ID — a UI row cannot name itself`)
        // `\b` cannot precede Swift's `$0` — `$` is not a word character, so the
        // boundary is asserted per alternative rather than over the group.
        .toMatch(/(?:\bit|\bm|\$0)\.id\s*(?:===|!==|==|!=)/)
      expect(pred, `${name} does not match a memory by its CONTENT — the model forgets by text`)
        .toMatch(/content[\s\S]*?(?:includes|contains)/)
    }
  })

  it("the memory row on both phones deletes by identity, never by a content prefix", () => {
    // The arm above is inert if the one caller that needs it still hands over a
    // content prefix — both halves have to be true at once, and that is why this
    // survived: each side looked complete on its own terms.
    const panels = stripDocs(read('ios/Tiny/Sources/Panels.swift'))
    expect(panels).toContain('Continuity.forgetMemory(tiny, m.id)')

    const universe = stripDocs(read('android/app/src/main/java/technology/tiny/app/ui/MemoryUniverse.kt'))
    expect(universe).toContain('forgetMemory(tiny, m.id)')
    // The shipped defect, verbatim — `take(40)` of the row's own text.
    expect(universe).not.toMatch(/forgetMemory\(tiny, m\.content/)
  })
})

describe('the store truncates on a code-point boundary on every surface', () => {
  // This store's one promise is that all three surfaces send the server an
  // IDENTICAL context section (iOS Continuity.swift:8, Android Continuity.kt:30,
  // and buildContext's output is `extraSystem` on every request —
  // Session.swift:520, MainActivity.kt:979). Truncation broke it three ways at
  // once, all measured:
  //
  //   web    `slice(0, n)`   counts UTF-16 code units
  //   Kotlin `take(n)`       counts UTF-16 chars   (agrees with web)
  //   Swift  `prefix(n)`     counts GRAPHEME CLUSTERS
  //
  // So one string was 502 long to web/Android and 499 to iOS — three surfaces
  // cutting a 500-cap in three places. Worse, a web/Android cut can land INSIDE
  // one emoji and leave a LONE SURROGATE, which cannot be encoded to UTF-8: the
  // browser substitutes U+FFFD, the JVM substitutes '?'. Same memory, different
  // bytes, per platform. And it is not fixable by matching the browser — Swift's
  // String cannot represent a lone surrogate at all (measured).
  //
  // Code points are the one unit all three can agree on. Same rule and rationale
  // as the DM rail's `clipToCodePoints`, which fixed this class for message
  // previews; the continuity store never got it.
  it('all three define the clip in their own idiom for code points', () => {
    expect(webContinuity()).toMatch(
      /export function clipToCodePoints\(text: string, max: number\): string/
    )
    // `Array.from` is the code-point iteration on web.
    expect(webContinuity()).toMatch(/^ {2}const cps = Array\.from\(text\);$/m)
    // `codePointCount`/`offsetByCodePoints` are the JVM's.
    expect(kotlinContinuity()).toMatch(
      /^ {8}fun clipToCodePoints\(text: String, max: Int\): String \{$/m
    )
    expect(kotlinContinuity()).toMatch(/^ {12}return text\.substring\(0, text\.offsetByCodePoints\(0, max\)\)$/m)
    // `unicodeScalars` is Swift's — NOT `prefix`, which counts clusters.
    expect(swiftContinuity()).toMatch(
      /^ {4}static func clipToCodePoints\(_ text: String, _ max: Int\) -> String \{$/m
    )
    expect(swiftContinuity()).toMatch(/^ {8}let scalars = text\.unicodeScalars$/m)
  })

  it('🔴 no surface still truncates by UTF-16 units or clusters', () => {
    // The regression shape, per surface. These are the exact three call sites:
    // the turn log's two halves (500/800) and a memory's content (1000).
    const web = webContinuity()
    expect(web).not.toMatch(/q\.slice\(0, 500\)/)
    expect(web).not.toMatch(/a\.slice\(0, 800\)/)
    expect(web).not.toMatch(/content\.slice\(0, 1000\)/)

    const k = kotlinContinuity()
    expect(k).not.toMatch(/q\.take\(500\)/)
    expect(k).not.toMatch(/a\.take\(800\)/)
    expect(k).not.toMatch(/content\.take\(1000\)/)

    const s = swiftContinuity()
    expect(s).not.toMatch(/qt\.prefix\(500\)/)
    expect(s).not.toMatch(/at\.prefix\(800\)/)
    expect(s).not.toMatch(/c\.prefix\(1000\)/)
  })

  it('the same three budgets are clipped on all three surfaces', () => {
    // A budget that drifts is the same divergence by another route.
    expect(webContinuity()).toContain('q: clipToCodePoints(q, 500), a: clipToCodePoints(a, 800)')
    expect(webContinuity()).toContain('clipToCodePoints(content, 1000)')

    expect(kotlinContinuity()).toContain('clipToCodePoints(q, 500), clipToCodePoints(a, 800)')
    expect(kotlinContinuity()).toContain('clipToCodePoints(content, 1000)')

    expect(swiftContinuity()).toContain('clipToCodePoints(qt, 500), a: clipToCodePoints(at, 800)')
    expect(swiftContinuity()).toContain('clipToCodePoints(c, 1000)')
  })

  it('and each returns the input untouched when it fits', () => {
    // Not an optimisation — an off-by-one here silently drops a character from
    // every memory already short enough to keep whole, on one surface only.
    expect(webContinuity()).toMatch(/return cps\.length <= max \? text : /)
    expect(kotlinContinuity()).toMatch(/^ {12}if \(points <= max\) return text$/m)
    expect(swiftContinuity()).toMatch(/^ {8}guard scalars\.count > max else \{ return text \}$/m)
  })

  it('🔴 the three implementations agree byte-for-byte (measured, not asserted)', () => {
    // The web implementation is executable here, so this runs it for real on the
    // inputs where the three units disagree. The expected UTF-8 byte counts were
    // measured against the Swift (`unicodeScalars`) and JVM (`codePointCount`)
    // implementations on the SAME inputs and compared by SHA-256 — all three
    // matched. The native suites assert these identical numbers
    // (ForgetOutcomeTest `the clip agrees with web and iOS BYTE FOR BYTE`,
    // TinyTests `theClipAgreesWithWebAndAndroidByteForByte`), so a divergence on
    // any one surface fails there while this pins the shared table.
    const clip = (text: string, max: number) => {
      const cps = Array.from(text)
      return cps.length <= max ? text : cps.slice(0, max).join('')
    }
    const cases: [string, number, number][] = [
      ['a'.repeat(498) + '👍🏽x', 500, 506],    // skin-tone modifier: 2 code points
      ['a'.repeat(495) + '👨‍👩‍👧‍👦x', 500, 513],  // ZWJ family: 7 code points, 1 cluster
      ['a'.repeat(498) + '🇹🇷x', 500, 506],    // regional-indicator pair
      ['a'.repeat(498) + 'éx', 500, 501],      // precomposed accent
      ['a'.repeat(498) + '日本x', 500, 504],    // CJK, 3 bytes each
      ['a'.repeat(499) + '👍 tail', 500, 503], // 🔴 the cut lands ON the emoji
    ]
    for (const [input, max, expectedBytes] of cases) {
      const out = clip(input, max)
      expect(Array.from(out).length, `code points for ${input.slice(-8)}`).toBe(max)
      expect(Buffer.byteLength(out, 'utf8'), `UTF-8 bytes for ${input.slice(-8)}`).toBe(expectedBytes)
      // The property that makes this the right rule: re-encoding is lossless.
      expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out)
    }
  })
})

describe('forget: the voice executors answer the model honestly', () => {
  const kotlinVoice = () => {
    const src = stripLineComments(read('android/app/src/main/java/technology/tiny/app/MainActivity.kt'))
    const start = src.indexOf('"forget" -> {')
    expect(start, 'the Kotlin voice forget case moved — re-anchor').toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('else -> org.json.JSONObject()', start))
  }

  const swiftVoice = () => {
    const src = stripLineComments(read('ios/Tiny/Sources/Views.swift'))
    const start = src.indexOf('case "forget":')
    expect(start, 'the Swift voice forget case moved — re-anchor').toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('default:', start))
  }

  it('the tiny SPEAKS these, so a blocked forget must come back ok:false', () => {
    // This is the surface with no downstream channel at all: whatever it returns
    // is read aloud to a person who has already been told the fact is gone.
    const k = kotlinVoice()
    expect(k).toContain('forgetOutcome(')
    for (const c of ['FORGOTTEN', 'NO_MATCH', 'BLOCKED']) expect(k).toContain(c)
    expect(k).toContain('the memory is still there; tell the user')

    const s = swiftVoice()
    expect(s).toContain('Continuity.forgetOutcome(')
    for (const c of ['.forgotten', '.noMatch', '.blocked']) expect(s).toContain(c)
    expect(s).toContain('the memory is still there; tell the user')
  })

  it('a no-match is reported as ok-but-nothing-removed, not an error', () => {
    // Calling it a failure makes the tiny apologise for a typo'd match string.
    expect(kotlinVoice()).toContain('no memory matched')
    expect(swiftVoice()).toContain('no memory matched')
  })

  it('the Swift removed flag is the OUTCOME, never the filter verdict', () => {
    // The shipped defect, verbatim: `"removed": Continuity.forgetMemory(...)`
    // put the filter's Bool straight into the model's result.
    const src = stripLineComments(read('ios/Tiny/Sources/Views.swift'))
    expect(src).not.toContain('"removed": Continuity.forgetMemory(')
  })

  it('the Kotlin voice executor no longer throws the result away', () => {
    // The shipped defect: `forgetMemory(...)` on its own line, then `ok:true`.
    const k = kotlinVoice()
    expect(k).not.toMatch(/app\.continuity\.forgetMemory\(vm\.tiny, match\)\s*\n\s*org\.json\.JSONObject\(\)\.put\("ok", true\)\s*$/m)
  })

  it('remember is gated on the write in both voice executors', () => {
    const k = stripLineComments(read('android/app/src/main/java/technology/tiny/app/MainActivity.kt'))
    expect(k).toContain('if (app.continuity.addMemory(vm.tiny, content, tags))')
    expect(k).toContain('it was NOT remembered')
    const s = stripLineComments(read('ios/Tiny/Sources/Views.swift'))
    expect(s).toContain('} else if Continuity.addMemory(chat.tiny, content: content, tags: args["tags"] as? [String]) {')
    expect(s).toContain('it was NOT remembered')
  })
})

describe('forget: the chat-stream paths surface a blocked write', () => {
  it('Android toasts only on BLOCKED, matching web', () => {
    const src = stripLineComments(
      read('android/app/src/main/java/technology/tiny/app/chat/ChatViewModel.kt')
    )
    const start = src.indexOf('"forget" -> {')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 900)
    expect(body).toContain('forgetOutcome(')
    expect(body).toContain('ForgetOutcome.BLOCKED')
    expect(body).toContain('Toast.makeText')
    // A success toast per forget would be noise the other surfaces don't make.
    expect(body).not.toContain('ForgetOutcome.FORGOTTEN')
  })

  it('iOS appends a notice only on blocked, and only once per reply', () => {
    const src = stripLineComments(read('ios/Tiny/Sources/Views.swift'))
    const start = src.indexOf('case .forget(let match):')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 500)
    expect(body).toContain('Continuity.forgetOutcome(tiny, match)')
    expect(body).toContain('outcome == .blocked')
    expect(body).toContain('appendNotice(')
    // iOS has no toast; the notice rides the reply text, and a reply can fire
    // the same tool repeatedly — N forgets must not stack N identical warnings.
    expect(src).toMatch(/private func appendNotice\([\s\S]{0,300}?guard !reply\.text\.contains\(line\) else \{ return \}/)
  })

  it('web keeps its three-outcome toast split (the reference behaviour)', () => {
    const chat = stripLineComments(read('components/chat/Chat.tsx'))
    expect(chat).toContain("const outcome = forgetMemoryOutcome(name, ef.match)")
    expect(chat).toContain("if (outcome === 'forgotten') toast(\"🧠 Memory forgotten\")")
    expect(chat).toContain("else if (outcome === 'blocked') toast.error(")
  })
})

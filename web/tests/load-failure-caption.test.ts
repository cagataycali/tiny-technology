// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 Five sheets told the reader both causes and committed to neither.
 *
 * My Devices, Jobs, Memory, the memory graph and Activity all put the same
 * caption under their retry button:
 *
 *     "Login required or network error"
 *
 * Two mutually exclusive causes, and the remedies are opposite ones. An expired
 * session needs a sign-out and back in, and no amount of retrying fixes it. A
 * dropped connection needs signal, and signing out there throws away a token
 * that still works. Whichever it was, half of that sentence sent the reader at
 * the wrong thing — and "Login required" is the worker's own wire phrase,
 * printed onto a human surface.
 *
 * The app was never guessing; `try?` was. Every one of those five loads
 * discarded a thrown `ApiError` whose `errorDescription` already IS
 * `Api.httpMessage` — the one status table `HTTPErrorTests` exists to keep from
 * drifting. `LoadFailure` catches it instead.
 *
 * `LoadFailureTests` (Swift) owns the rule. This suite owns the wiring: that no
 * surface still guesses, that every one of the five asks the shared helper, and
 * that the statuses those routes can actually answer are all ones the table has
 * real words for.
 */

const ROOT = process.cwd()
const SRC = (f: string) => join(ROOT, 'ios/Tiny/Sources', f)
const API = SRC('Api.swift')

/** Comments stripped: a rule explained in prose must not satisfy an assertion. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\/\/\/).*$/gm, '')

/** The `{ … }` block opening at or after `at`, brace-matched. */
function braced(source: string, at: number): string {
  const open = source.indexOf('{', at)
  let depth = 1
  let i = open + 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(open, i)
}

/** A block, with its anchor ASSERTED — an unfound anchor makes `slice` return
 *  one character, on which every `.not.toMatch()` passes forever. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

/** The five sheets, and the load function in each that showed the caption. */
const SHEETS = [
  { file: 'Panels.swift', sheet: 'My Devices', fn: 'private func load(silent: Bool = false) async {' },
  { file: 'Panels.swift', sheet: 'Jobs', fn: 'let d: [String: Any]\n        do { d = try await Api.get("/api/jobs"' },
  { file: 'Panels.swift', sheet: 'Memory', fn: 'do { d = try await Api.get("/api/learnings' },
  { file: 'Activity.swift', sheet: 'Activity', fn: 'private func load() async {' },
  { file: 'MemoryGraph.swift', sheet: 'Memory graph', fn: 'let path = "/api/graph?all=1"' },
]

describe('a sheet that failed to load names one cause', () => {
  it('no surface offers the reader two causes at once', () => {
    // The exact string, across every Swift source — including the watch and
    // widget targets, which share this directory.
    for (const f of ['Panels.swift', 'Activity.swift', 'MemoryGraph.swift', 'Api.swift']) {
      expect(code(readFileSync(SRC(f), 'utf8')), `${f} still guesses`)
        .not.toContain('Login required or network error')
    }
  })

  it('all five sheets ask the shared helper', () => {
    // One helper, five callers: the point is that none of them re-decides what
    // a 401 means. A sixth copy of the status wording is how the app got here.
    let callers = 0
    for (const f of ['Panels.swift', 'Activity.swift', 'MemoryGraph.swift']) {
      const src = code(readFileSync(SRC(f), 'utf8'))
      callers += (src.match(/LoadFailure\.message\(error\)/g) ?? []).length
    }
    expect(callers, 'a sheet stopped asking the shared helper').toBe(SHEETS.length)
  })

  it('no sheet swallows the error with `try?` on the load it reports', () => {
    // ⚠️ `try?` is the whole defect: it turns a typed failure into nil, and a
    // caption written against nil can only list possibilities. Scoped to the
    // five load functions — `try?` is legitimate elsewhere in these files.
    for (const { file, sheet, fn } of SHEETS) {
      const src = code(readFileSync(SRC(file), 'utf8'))
      const at = src.indexOf(fn)
      expect(at, `${sheet}: anchor "${fn.slice(0, 40)}" moved — re-anchor`).toBeGreaterThan(-1)
      // The load body, or for the two anchored mid-function, the ~25 lines after.
      const region = fn.endsWith('{') ? braced(src, at) : src.slice(at, at + 1200)
      expect(region, `${sheet} discards the error again`).not.toMatch(/try\?\s+await\s+Api\.get/)
      expect(region, `${sheet} stopped reporting the reason`).toContain('LoadFailure.message(error)')
    }
  })

  it('the helper delegates and hard-codes no status wording of its own', () => {
    const enumBody = body(code(readFileSync(API, 'utf8')), 'enum LoadFailure {')
    // Anchored on `message` itself, not the enum: the enum has since grown
    // `contentMessage`, whose whole job is to say ONE thing the table can't
    // (below). The no-copy rule is about `message`, so it is pinned there.
    const helper = body(enumBody, 'static func message(_ error: Error)')
    // It reads the ApiError's own line (which is Api.httpMessage) and the house
    // table for the two non-HTTP paths — and writes no sentence itself.
    expect(helper).toMatch(/api\.localizedDescription/)
    expect(helper).toMatch(/Api\.friendlyHTTPError\(0\)/)
    expect(helper).toMatch(/ApiError\.badResponse\.localizedDescription/)
    // A quoted sentence here would be a copy that can drift from the table.
    // `[^"\n]` not `[^"]`: an empty literal like `serverMsg ?? ""` lets a
    // multi-line span between two literals pose as one. Strictly narrower than
    // the original, so it cannot weaken this rule.
    expect(helper.match(/"[^"\n]{12,}"/g), 'the helper is writing its own copy').toBeNull()
    // And enum-wide, an ALLOWLIST of exactly one. The chat table words 404 as
    // "That tiny doesn't exist" and 402 as "This tiny charges per message";
    // on a community list or a builder profile those are confident answers
    // about a thing that is not a tiny, so `contentMessage` needs a line of its
    // own. Exactly one, and this is it. Any OTHER sentence appearing here is the
    // sixth copy of the status wording that this whole rule exists to stop.
    expect(enumBody.match(/"[^"\n]{12,}"/g) ?? [],
           'a new hard-coded sentence joined LoadFailure — delegate to the table instead')
      .toEqual(['"Couldn\'t load it — try again (HTTP \\(status))"'])
  })

  it('a body that arrived but was not JSON is not called a connection problem', () => {
    // `Api.get` parses with JSONSerialization, which throws an NSCocoaError, not
    // an ApiError — so the URLError check must be by TYPE, not a catch-all else.
    const helper = body(code(readFileSync(API, 'utf8')), 'enum LoadFailure {')
    // By TYPE — `error is NSError` would be true of the parse error too (every
    // Swift Error bridges), which is how "check your connection" would come
    // back for a body that arrived just fine.
    expect(helper).toMatch(/if\s+error\s+is\s+URLError/)
    expect(helper).toMatch(/as\?\s+ApiError/)
    // (No assertion on the ORDER of the three branches: they test mutually
    // exclusive types, so order cannot change an answer. A pin on it would fail
    // a refactor that breaks nothing — and the Swift suite is what proves the
    // three cases actually map where this comment says they do.)
  })

  it('a background repoll still never downgrades a list that loaded', () => {
    // The devices sheet repolls silently while it is open. The rows on screen
    // were true 30 seconds ago, and a subway tunnel is not a reason to throw the
    // user's devices away — so `silent` gates the ERROR SCREEN, not the fetch.
    // Nothing pinned this before and this increment rewrote the exact function,
    // which is the moment an unpinned invariant gets quietly dropped.
    const fn = body(code(readFileSync(SRC('Panels.swift'), 'utf8')),
                    'private func load(silent: Bool = false) async {')
    const at = fn.indexOf('catch {')
    expect(at, 'the catch went away — re-anchor').toBeGreaterThan(-1)
    const handler = braced(fn, at)
    expect(handler).toMatch(/if\s+!silent\s*\{\s*state\s*=\s*\.failed/)
    // Brace-matched, not compared by index: "after `if !silent`" is also true of
    // a line that sits AFTER the guard's closing brace (inc 13's lesson).
    const guarded = braced(handler, handler.indexOf('if !silent'))
    expect(guarded, 'a silent repoll can wipe a good list to the error screen')
      .toContain('state = .failed')
  })

  it('the two body-level checks raise the house error instead of a new sentence', () => {
    // Activity gates on `ok`, the graph on `error` — both on a 2xx. Those two
    // used to fall into the same guessed caption; now they throw the one house
    // error for "bytes I could not use", so there is a single failure path.
    for (const f of ['Activity.swift', 'MemoryGraph.swift']) {
      const src = code(readFileSync(SRC(f), 'utf8'))
      expect(src, `${f} invents a body-level message`).toContain('throw ApiError.badResponse')
    }
    // And WHICH checks — the masked-empty rule these two inherited: an outage
    // must reach the retry screen, never a confident "Nothing yet" over an
    // empty list. Also unpinned until now, in code this increment rewrote.
    const activity = code(readFileSync(SRC('Activity.swift'), 'utf8'))
    expect(activity, 'the ok gate went away: an outage would read as no activity')
      .toMatch(/guard\s*\(d\["ok"\] as\? Bool\) == true/)
    const graph = code(readFileSync(SRC('MemoryGraph.swift'), 'utf8'))
    expect(graph, 'the error gate went away: an outage would read as an empty graph')
      .toMatch(/guard\s+d\["error"\] == nil/)
  })

  // ── the third surface ─────────────────────────────────────────────────────

  /**
   * Android reached the same six sheets by a DIFFERENT road, and the gap is worse
   * than the caption iOS fixed.
   *
   * `executeJson` parses with `runCatching { JSONObject(text) }.getOrElse
   * { JSONObject() }` and stamps `_status` only on a non-2xx — so a 200 whose body
   * is not JSON becomes an empty object with NO status, every `status >= 400`
   * guard waves it through, the array is absent, and the sheet paints a confident
   * "No devices yet" over a fleet that exists. iOS cannot have this bug (its
   * `JSONSerialization` throws, which is the case `LoadFailure`'s third branch
   * catches); Android's parse was already defused, so the check must be positive.
   *
   * Kotlin `LoadFailureTest` owns the rule. These pins own the wiring.
   */
  const KT_UI = (f: string) =>
    join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui', f)
  const KT_API = join(ROOT, 'android/app/src/main/java/technology/tiny/app/net/TinyApi.kt')

  /** Kotlin comments stripped — a rule explained in prose must not satisfy a pin. */
  const kt = (f: string) =>
    readFileSync(KT_UI(f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  /**
   * One row per LOAD, not per file: the array it reads and the state holding its
   * caption.
   *
   * ⚠️ Messages has two — the inbox and one thread — and listing the file once was
   * a hole a mutant walked through. The caller COUNT said seven while only six
   * regions were pinned, so swapping the thread's caption for a direct
   * `friendlyHttpError` call stayed green. A count and a set of pins are not the
   * same coverage; the pins have to enumerate what the count counts.
   */
  const KT_SHEETS = [
    { file: 'Panels.kt', sheet: 'My Devices', key: 'devices', state: 'loadError' },
    { file: 'Jobs.kt', sheet: 'Jobs', key: 'jobs', state: 'jobsFailed' },
    { file: 'MemoryUniverse.kt', sheet: 'Memory', key: 'learnings', state: 'serverFailed' },
    { file: 'MemoryGraph.kt', sheet: 'Memory graph', key: 'nodes', state: 'failed' },
    { file: 'Activity.kt', sheet: 'Activity', key: 'events', state: 'failed' },
    { file: 'Messages.kt', sheet: 'Messages inbox', key: 'threads', state: 'threadsFailed' },
    // ⚠️ The one sheet that does NOT assign the caption at its load site: a DM
    // thread first asks `classifyThreadLoad` whether this person is gone for good,
    // and only the retryable arm carries a caption. `via` says so, and moves the
    // caption pins one hop — to the verdict — rather than dropping them, which is
    // what "the sheet stopped showing the rule's caption" would otherwise mean.
    { file: 'Messages.kt', sheet: 'Messages thread', key: 'messages', state: 'loadFailed',
      via: 'internal fun classifyThreadLoad(' },
  ]

  /**
   * The load REGION of one sheet: from its fetch to the caption assignment.
   *
   * ⚠️ Whole-file pins were wrong here, in a way worth recording. `Panels.kt` holds
   * BOTH the devices sheet and `LoadFailure` itself, so a file-wide
   * `not.toMatch(/status >= 400/)` fails on the rule's own delegation line, and a
   * file-wide `not.toMatch(/friendlyHttpError/)` fails on the rule ASKING the table
   * — which is the design, not the defect. Scoped to the caller, both pins say what
   * they mean: no SHEET decides by status, and no SHEET asks the table directly.
   */
  function loadRegion(file: string, key: string): string {
    const src = kt(file)
    const at = src.indexOf(`LoadFailure.loaded(res, "${key}"`)
    expect(at, `${file}: the ${key} load moved — re-anchor`).toBeGreaterThan(-1)
    // Back up to the fetch that feeds it, forward past the caption assignment.
    const from = src.lastIndexOf('runCatching', at)
    expect(from, `${file}: no fetch before the ${key} guard`).toBeGreaterThan(-1)
    return src.slice(from, at + 600)
  }

  it('all six Android sheets ask the shared rule', () => {
    // One rule, six callers: the point is that none of them re-decides what a
    // failed load means. Messages has TWO loads (inbox + one thread), so seven
    // call sites across six files.
    let callers = 0
    for (const file of Array.from(new Set(KT_SHEETS.map((s) => s.file)))) {
      callers += (kt(file).match(/LoadFailure\.loaded\(res,/g) ?? []).length
    }
    // …and the count must equal the number of loads PINNED below, or a load exists
    // that nothing checks — which is exactly how the thread caption went unpinned.
    expect(callers, 'a sheet stopped asking the shared rule').toBe(KT_SHEETS.length)
    expect(KT_SHEETS.length, 'a load was added without a row to pin it').toBe(7)
  })

  it('no Android sheet still decides a failed load by status alone', () => {
    // ⚠️ THE DEFECT, in one regex. `status >= 400` is exactly the guard that let a
    // non-JSON 200 through: it carries no `_status` at all, so it reads as a
    // success and the sheet renders its empty state over real data.
    for (const { file, sheet, key } of KT_SHEETS) {
      const region = loadRegion(file, key)
      expect(region, `${sheet} guards on the status alone again — a non-JSON 200 reads as empty`)
        .not.toMatch(/status\s*>=\s*400/)
      expect(region, `${sheet} re-derives the status itself`)
        .not.toMatch(/optInt\("_status",\s*0\)/)
    }
  })

  it('every sheet reads the VALIDATED body, never the raw response', () => {
    // The two halves cannot disagree only if the array comes out of the object the
    // rule approved. `res.optJSONArray(...)` after the guard is the collapse coming
    // back — it reads a response that may never have been checked.
    for (const { file, sheet, key } of KT_SHEETS) {
      const src = kt(file)
      expect(src, `${sheet} pulls its list out of the unchecked response`)
        .not.toMatch(/res\.optJSONArray\(/)
      expect(src, `${sheet} stopped reading ${key} from the validated body`)
        .toMatch(new RegExp(`body\\.optJSONArray\\("${key}"`))
    }
  })

  it('the caption is the rule\'s, and no sheet writes its own fallback', () => {
    // A seventh wording is how the app got "Login required or network error". The
    // `?: "couldn't reach the server"` fallbacks are the Android equivalent and
    // they are what made a 200 with no status say "couldn't reach" a server that
    // had plainly answered.
    for (const { file, sheet, key, state, via } of KT_SHEETS) {
      // A sheet that routes its failure through a verdict first shows the caption
      // one hop away — so the pins move to that function, and the load site is
      // separately required to CALL it (below). What must never happen is a caption
      // pin that quietly matches nothing because the assignment moved.
      const region = via
        ? body(kt(file), via)
        : loadRegion(file, key)
      expect(region, `${sheet} invents its own caption again`)
        .not.toMatch(/\?:\s*"couldn't (reach the server|load)/)
      // ⚠️ `contentMessage`, and anchored so `message(` cannot satisfy it as a
      // SUBSTRING. Reverting a sheet to the plain rule is the `d71b1ff3` defect
      // coming back — the chat table over a list — and a pin on `LoadFailure\.message\(`
      // matched both spellings, so it could not have caught it.
      const assign = via ? '' : `${state} = `
      expect(region, `${sheet} stopped showing the rule's caption`)
        .toMatch(new RegExp(`${assign}LoadFailure\\.contentMessage\\(`))
      expect(region, `${sheet} fell back to the plain rule — that is the chat table over a list`)
        .not.toMatch(new RegExp(`${assign}LoadFailure\\.message\\(`))
      if (via) {
        // The hop is real: the load site must reach the verdict, or the function
        // above is dead code holding a green pin over a sheet that ignores it.
        expect(loadRegion(file, key), `${sheet} stopped asking for the verdict`)
          .toMatch(/classifyThreadLoad\(res\)/)
      }
      // And the chat table is not consulted directly: it is asked BY the rule, for
      // real HTTP statuses only, so 402/404's chat wording can't reach a sheet.
      expect(region, `${sheet} asks the chat table directly again`)
        .not.toMatch(/friendlyHttpError/)
    }
  })

  it('the DM verdict keys on the BODY, not on the bare status', () => {
    // ⚠️ Two different things answer 404 on this path. `{error:"peer not found"}`
    // (worker messages.ts:300) is about the PERSON; the router's plain-text
    // `404 Not Found.` (index.ts:228) is about a PATH a stale build asked for — and
    // a stale Next deploy for /api/messages answers the same way. Keying `.gone` on
    // the status would render our own staleness as someone's absence.
    const fn = body(kt('Messages.kt'), 'internal fun classifyThreadLoad(')
    expect(fn, 'the verdict went back to trusting the bare status')
      .toMatch(/optString\("error"\)/)
    expect(fn, 'a blank server body can be called a missing peer again')
      .toMatch(/\.trim\(\)\?\.isNotEmpty\(\)/)
    // Only 404. A 500 with a body is an outage, and burying a working person for
    // the day is the worse error of the two.
    expect(fn, 'the verdict widened past 404')
      .toMatch(/status\(res\) == 404/)
    expect(fn, 'the verdict decides by a status RANGE now — it must be exactly 404')
      .not.toMatch(/in 4\d\d\.\.|>= 400/)
  })

  it('the verdict has no retry, and the outage keeps one', () => {
    const src = kt('Messages.kt')
    const goneAt = src.indexOf('msgs == null && peerGone')
    expect(goneAt, 'the peer-gone branch is missing — re-anchor').toBeGreaterThan(-1)
    const goneBlock = braced(src, goneAt)
    // Retrying a resolved-and-absent peer ends the same way every time; the button
    // is an invitation to a loop the app already knows cannot finish.
    expect(goneBlock, 'the permanent verdict grew a retry button')
      .not.toMatch(/TextButton|onClick/)
    expect(goneBlock, "the verdict stopped naming who it's about")
      .toMatch(/peerGoneLine\(login\)/)
    // And the retryable arm keeps its button, or every outage becomes permanent.
    const failAt = src.indexOf('msgs == null && loadFailed != null')
    expect(failAt, 'the retryable branch is missing — re-anchor').toBeGreaterThan(-1)
    expect(braced(src, failAt), 'the retryable failure lost its retry')
      .toMatch(/TextButton\(onClick = \{ reload\(\) \}/)
    // The verdict is tested FIRST: with the order flipped, a gone peer whose
    // classify left `loadFailed` null would fall through to the spinner forever.
    expect(goneAt, 'the retryable arm now shadows the verdict').toBeLessThan(failAt)
  })

  it("the verdict's sentence never speaks the wire's word for a person", () => {
    // "peer" is a router's vocabulary. `contentMessage` prefers the server's own
    // words — right for a list, and on THIS path it would put "peer not found
    // (HTTP 404)" on a human surface, which is what the verdict exists to intercept.
    const src = kt('Messages.kt')
    // ⚠️ NOT `body()`: this is an expression-bodied Kotlin function, so brace
    // matching walks past it into the next declaration's `{}` — which is exactly
    // what it did, and every `.not` pin on that block would have been vacuous.
    // The declaration's own text, anchored to its line.
    const line = src.split('\n').find((l) => l.includes('fun peerGoneLine('))
    expect(line, 'peerGoneLine moved — the pins below would be vacuous').toBeTruthy()
    expect(line!, 'the verdict stopped naming the person').toMatch(/\$login/)
    expect(line!, 'the verdict stopped reading as a sentence about a person')
      .toMatch(/isn't reachable any more/)
    expect(src.toLowerCase(), "the wire's word for a person is hardcoded on this screen")
      .not.toContain('peer not found')
  })

  it('a thread switch cannot show the previous person’s failure', () => {
    // ⚠️ A DM notification tapped while a thread is open re-seeds `openWith`
    // (MessagesSheet keys it on `initialWith`), so DmThreadView survives a
    // login→login jump. Unkeyed `remember` would open B holding A's messages and A's
    // verdict — someone declared unreachable because a DIFFERENT person was. iOS
    // clears all four states on thread open (Messages.swift:306); the key is the
    // Compose spelling, and it also covers the deep-link path with no tap to hang
    // the clearing off.
    const view = body(kt('Messages.kt'), 'private fun DmThreadView(')
    for (const state of ['msgs', 'loadFailed', 'peerGone']) {
      expect(view, `${state} survives a thread switch — it must be keyed by login`)
        .toMatch(new RegExp(`var ${state} by remember\\(login\\)`))
    }
    // And a successful load clears BOTH failure states, or a peer who came back
    // keeps their epitaph until the sheet is closed.
    const reload = body(view, 'fun reload()')
    expect(reload, 'a good load stopped clearing the verdict')
      .toMatch(/loadFailed = null\s*\n\s*peerGone = false/)
    // ⚠️ The two states are MUTUALLY EXCLUSIVE, and each arm says so itself.
    // A mutation survived here: dropping `loadFailed = null` from the Gone arm
    // changed nothing on screen, because the verdict is rendered first. That makes
    // the whole invariant rest on the branch ORDER above — one reordering away from
    // showing a retry button under a permanent verdict. Cheap to state outright.
    expect(reload, 'the verdict no longer clears the caption it replaces')
      .toMatch(/Gone -> \{ peerGone = true; loadFailed = null \}/)
    expect(reload, 'the retryable arm no longer clears the verdict it replaces')
      .toMatch(/Retryable -> \{ loadFailed = why\.message; peerGone = false \}/)
  })

  it('⚠️ FAILS WHEN FIXED: the answer set the DM split is built on', () => {
    // The split holds only while the worker answers 404 with a BODY for an
    // unresolvable login, and while its catch-all answers 404 with plain TEXT. If
    // either moves, this fails rather than letting the app mis-word someone's
    // absence — or accuse a healthy person because of our own staleness.
    const w = join(ROOT, 'worker/src/messages.ts')
    if (!existsSync(w)) return // submodule not checked out
    expect(readFileSync(w, 'utf8'),
      '🎉 /messages no longer 404s an unresolvable peer — recheck classifyThreadLoad()')
      .toMatch(/json\(\{\s*error:\s*"peer not found"\s*\}\s*,\s*404\)/)
    // ⚠️ The OTHER 404, and the whole reason the verdict keys on the body: the
    // router's catch-all answers plain text, which `executeJson`'s
    // `runCatching { JSONObject(text) }.getOrElse { JSONObject() }` turns into an
    // EMPTY object — so `error` is blank and a stale build lands on the retryable
    // arm. If this ever becomes a JSON `{error}`, the split stops holding.
    expect(readFileSync(join(ROOT, 'worker/src/index.ts'), 'utf8'),
      "🎉 the router's catch-all moved — recheck the bare-404 arm")
      .toMatch(/router\.all\('\*',\s*\(\)\s*=>\s*new Response\('Not Found\.',\s*\{\s*status:\s*404/)
    // And the forward that lets the worker's 404 reach the sheet at all. Without
    // it there is no `.gone` case to distinguish, and the pins above go vacuous.
    expect(readFileSync(join(ROOT, 'app/api/messages/route.ts'), 'utf8'),
      '🎉 /api/messages stopped forwarding the status — the verdict may be unreachable')
      .toMatch(/new Response\(await res\.text\(\),\s*\{\s*status:\s*res\.status/)
  })

  it('the two body-level gates survive, and stay separate from the shape check', () => {
    // Activity's 502 answers `ok:false` and the graph's outage answers a 2xx with
    // an `error` string — the server declining inside a well-formed body, which a
    // shape check cannot see. iOS raises its house error at these same two gates.
    // Both were unpinned, in the exact code this increment rewrote.
    const activity = kt('Activity.kt')
    expect(activity, 'the ok gate went away: an outage would read as no activity')
      .toMatch(/\?\.takeIf \{ it\.optBoolean\("ok"\) \}/)
    const graph = kt('MemoryGraph.kt')
    expect(graph, 'the error gate went away: an outage would read as an empty graph')
      .toMatch(/\?\.takeIf \{ it\.optString\("error"\)\.isEmpty\(\) \}/)
    // Their fallback is the unusable-body line, NOT "no response": the server
    // answered, so blaming the connection would point at the wrong thing.
    for (const f of ['Activity.kt', 'MemoryGraph.kt']) {
      expect(kt(f), `${f} blames the connection for a body that arrived`)
        .toMatch(/\?: LoadFailure\.unusableBody\(/)
    }
  })

  it('Android speaks for status 0 itself, because its table has no arm for it', () => {
    // ⚠️ Asked about 0, `friendlyHttpError`'s else arm answers "request failed
    // (HTTP 0)" — a bare code naming a status that never existed. So the house line
    // is used, and byte-shared with the revoke sheet's 0 case.
    const api = readFileSync(KT_API, 'utf8')
    expect(api, 'the table grew a 0 arm — the house line may now be redundant')
      .not.toMatch(/code == 0 ->/)
    const panels = kt('Panels.kt')
    expect(panels).toMatch(/const val noResponse = "no response — check your connection"/)
    // The same sentence RevokeFailure returns for 0, in the same file.
    expect(panels).toMatch(/if \(status == 0\) return "no response — check your connection"/)
  })

  it('the premise holds: `_status` is stamped only on a non-2xx', () => {
    // Everything above rests on this. If `_status` ever lands on a success, the
    // rule's `optInt("_status", 200)` still reads right — but `status(res) != 200`
    // would start rejecting good loads, so this must be re-read, not silently kept.
    const api = readFileSync(KT_API, 'utf8')
    expect(api, 'the premise moved: _status may now be stamped on success too')
      .toMatch(/if \(!response\.isSuccessful\) \{\s*json\.put\("_status", response\.code\)/)
    // And the parse that cannot throw — the whole reason the check is positive.
    expect(api, 'the parse throws again: a non-JSON 200 would surface as an exception')
      .toMatch(/runCatching \{ JSONObject\(text\) \}\.getOrElse \{ JSONObject\(\) \}/)
  })

  it('⚠️ FAILS WHEN FIXED: these routes answer only statuses the table curates', () => {
    // The caption is only as good as the table's coverage, and the table's
    // default arm is `"HTTP \(status)"` — a bare code on a human surface.
    // Reachable today: 401, 424, 503 (+ a client-side 0 and a non-JSON body).
    // 402 and 404 would be worse than bare: the table words those for CHAT
    // ("This tiny charges per message", "That tiny doesn't exist"), which on My
    // Devices would be a confident lie. Every 400 in these files is on a
    // POST/DELETE, and graph's `?all=1` returns before its 400.
    //
    // ⚠️ Deliberately a coarse tripwire — every mention of 402/404 in these
    // files, with the one benign occurrence enumerated. Parsing the status out
    // of a response construction looked tidier and was wrong in both
    // directions: `{ status: 401 }` (digits followed by `}`) never matched, so
    // jobs' 401 was invisible, while `q.slice(0, 500)` and `slice(0, 120)`
    // matched as "statuses". It passed by finding nothing it was looking for.
    const ROUTES = ['devices', 'jobs', 'learnings', 'events', 'graph', 'messages']
    // devices/route.ts maps a worker 404 → 424 rather than passing it on, which
    // is the GOOD case and the reason 404 is unreachable from the sheet.
    const KNOWN: Record<string, number> = { devices: 2 }
    for (const r of ROUTES) {
      const src = readFileSync(join(ROOT, `app/api/${r}/route.ts`), 'utf8')
      const hits = (src.match(/\b40[24]\b/g) ?? []).length
      expect(hits, `🎉 /api/${r} gained a 402/404 — the table words those for CHAT, ` +
        `so "That tiny doesn't exist" would land on My Devices. Check it can't reach a sheet.`)
        .toBe(KNOWN[r] ?? 0)
    }
  })

  /**
   * ⚠️⚠️ WHY THE TRIPWIRE ABOVE PASSED WHILE THE DEFECT WAS LIVE — the lesson of
   * `d71b1ff3`'s Android port, and the more useful half of this increment.
   *
   * It scans route files for a LITERAL 402/404. Three of these routes don't write
   * one: they forward the worker's status verbatim —
   *   `new Response(await res.text(), { status: res.status })`
   * — so `/api/messages/route.ts` contains **zero** occurrences of "404" while
   * happily returning one. The worker answers `404 {error:"peer not found"}` for a
   * peer it can't resolve (`messages.ts:300`), and it lands on the Messages thread
   * sheet. A literal scan is structurally blind to a forwarded status.
   *
   * (It was also blind for a dumber reason: `messages` wasn't in the list at all,
   * though Messages owns two of the seven loads. Fixed above.)
   *
   * So the pin cannot be "no sheet can ever see a 402/404" — it can. It has to be
   * "when one arrives, the caption is not the chat table's". That is what
   * `contentMessage` guarantees and `ContentMessageTest` proves per-status; here we
   * pin only that the sheets route through it and that a forward is DECLARED.
   */
  it('a forwarded status is declared, so the tripwire above knows its own blind spot', () => {
    // FOUR of the six hand the worker's status to a sheet unchanged — `learnings`
    // does too, which I had wrong until this assertion said so. That is the point of
    // pinning it: the set is not guessable from the sheet code, and if a fifth joins
    // them the literal scan above silently stops covering it.
    //
    // ⚠️ The shape that forwards is a RESPONSE built from the worker's status:
    // `new Response(await res.text(), { status: res.status })`. Matching bare
    // `status: res.status` is not the same question — `devices/route.ts:44` has that
    // string inside an internal helper's return OBJECT, which the route then maps
    // (a worker 404 becomes a 424). Same characters, opposite meaning.
    const FORWARDS = ['jobs', 'messages', 'graph', 'learnings']
    // ⚠️ Not `[^)]*` for the body argument: it is `await res.text()`, whose own `)`
    // ends the class before the status is ever reached, so the pin matched nothing
    // and reported all four routes as non-forwarding. A negated class is the wrong
    // tool for an argument that contains a call.
    const forwards = (src: string) =>
      /new Response\(await res\.text\(\),\s*\{\s*status:\s*res\.status/.test(src)
    for (const r of FORWARDS) {
      const src = readFileSync(join(ROOT, `app/api/${r}/route.ts`), 'utf8')
      expect(forwards(src), `/api/${r} no longer forwards verbatim — re-read which statuses reach the sheet`)
        .toBe(true)
    }
    // And the ones that do NOT: a status the app itself chose is a status the literal
    // scan can see. `devices` deliberately maps a worker 404 → 424 rather than
    // passing it on, which is why 404 is unreachable from My Devices.
    for (const r of ['devices', 'events']) {
      const src = readFileSync(join(ROOT, `app/api/${r}/route.ts`), 'utf8')
      expect(forwards(src), `🎉 /api/${r} started forwarding the worker's status — add it to FORWARDS`)
        .toBe(false)
    }
  })

  it('the chat table is asked only where it describes the transport', () => {
    // ⚠️ THE DEFECT (`d71b1ff3`), and it was in MY OWN rule: c49 wired all eight
    // content loads into `friendlyHttpError`, the CHAT table — 404 "that tiny
    // doesn't exist", 402 "this tiny charges per message". `RevokeFailure`, landed
    // the cycle BEFORE, refuses that same table in so many words.
    const panels = kt('Panels.kt')
    // The owning set, iOS `Api.statusOwnsTheMessage` parity.
    expect(panels, 'the owning set went away — every status would yield to a body')
      .toMatch(/status == 401 \|\| status == 0 \|\| status in 500\.\.599/)
    // 424 keeps the table beside the owning set: "backend unavailable" describes the
    // TRANSPORT, not a tiny. It is not IN the set — it is not a status whose meaning
    // the client knows better.
    expect(panels, '424 stopped keeping the table, or joined the owning set')
      .toMatch(/statusOwnsTheMessage\(status\) \|\| status == 424/)
    // The rung Android never had: the server's own words beat anything we invent.
    expect(panels, 'the server\'s explanation is being discarded again')
      .toMatch(/if \(server\.isNotEmpty\(\)\) return "\$server \(HTTP \$status\)"/)
    // And the fallback names the subject and the code — never a cause.
    expect(panels, 'the fallback asserts a cause again')
      .toMatch(/return "couldn't load \$what — try again \(HTTP \$status\)"/)
    // ⚠️ It DELEGATES: one rung overridden, so the two rules cannot drift on status
    // 0, an unusable 2xx, or an owning status. A re-derived copy is how five sheets
    // drifted apart before there was a rule at all.
    expect(panels, 'contentMessage re-derives the whole rule instead of delegating')
      .toMatch(/val base = message\(res, key, what, alt\) \?: return null/)
  })
})

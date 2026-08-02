// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 "No calls yet" was the answer to a question the screen never got to ask.
 *
 * GET /api/voice/sessions replies exactly three ways:
 *
 *     200  {ok:true,  sessions:[…]}
 *     401  {ok:false, error:"login required"}
 *     502  {ok:false, error:<the worker's error, or the EDGE's exception text>}
 *
 * Call recordings reached past `Api` to a bare `URLSession`, threw the response
 * away (`let (data, _)`), and decoded into `{ sessions: [CallSession]? }`. An
 * absent key satisfies an optional property, so **both refusal bodies decoded
 * successfully** with `sessions == nil`. The list read `[]` and the screen said,
 * about the user's own recordings, "No calls yet — finished voice calls appear
 * here." Someone whose session had merely expired was told their archive was
 * empty. A worker outage said the same.
 *
 * And on the one path that did report a failure — a true transport error — the
 * caption asserted the connection, in grey body text, with no control to act on.
 *
 * `CallRecordingsLoadTests` (Swift) runs every one of those three answers
 * through the real path with a stubbed transport. This suite owns the wiring:
 * that the status is no longer discarded, that `ok` is not optional, and that
 * the failure state is the house one.
 */

const ROOT = process.cwd()
const VOICE = join(ROOT, 'ios/Tiny/Sources/VoiceCall.swift')
const API = join(ROOT, 'ios/Tiny/Sources/Api.swift')
const ROUTE = join(ROOT, 'app/api/voice/sessions/route.ts')

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

/** Every capture-group-1 match. `[...src.matchAll(re)]` is the obvious spelling
 *  and it typechecks only with `--downlevelIteration`; this tsconfig's target is
 *  below ES2015, so the spread would add two `error TS2802` to a gate that other
 *  suites already carry 30 of. An `exec` loop costs six lines and no noise. */
function caps(source: string, re: RegExp): string[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = g.exec(source)) !== null) out.push(m[1])
  return out
}

/** A block, with its anchor ASSERTED — an unfound anchor makes `slice` return
 *  one character, on which every `.not.toMatch()` passes forever. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

describe('call recordings: no answer is not an empty archive', () => {
  it('the load rides the house client, so the status cannot be dropped', () => {
    const load = body(code(readFileSync(VOICE, 'utf8')), 'private func load() async {')
    expect(load, 'the load reaches past Api again — a bare URLSession has no failure contract')
      .not.toMatch(/URLSession\.shared/)
    // `let (data, _)` — the response, discarded. That single underscore is where
    // a 401 and a 502 stopped existing.
    expect(load, 'the response is being discarded again').not.toMatch(/\(\s*data\s*,\s*_\s*\)/)
    expect(load).toMatch(/Api\.getData\("\/api\/voice\/sessions", token: token\)/)
    expect(load, 'the reason is not coming from the shared helper')
      .toMatch(/LoadFailure\.message\(error\)/)
  })

  it('`getData` carries the same failure contract as `get`', () => {
    // It must ride the private `request` core — that is what applies the 30s
    // bound, the Bearer header, and the throw-with-the-server's-words on a
    // non-2xx. A convenience wrapper that called URLSession itself would look
    // identical at the call site and reintroduce the whole defect.
    const fn = body(code(readFileSync(API, 'utf8')), 'static func getData(')
    expect(fn).toMatch(/try await request\(path, token: token\)/)
    expect(fn, 'getData grew its own transport').not.toMatch(/URLSession/)
  })

  it('nothing swallows this decode with `try?` any more', () => {
    // The other half of the defect: even with a status in hand, `try?` on the
    // decode turns a maintenance page into an empty list.
    const src = code(readFileSync(VOICE, 'utf8'))
    const rows = body(src, 'static func rows(from data: Data) throws -> [CallSession] {')
    expect(rows, 'the decode is optional again').not.toMatch(/try\?\s*JSONDecoder/)
    expect(rows).toMatch(/try JSONDecoder\(\)\.decode\(CallSessionsBody\.self/)
    // And the old caption is gone from the file entirely.
    expect(src, 'the screen guesses at the connection again')
      .not.toContain("check your connection.")
  })

  it('`ok` is REQUIRED — an absent key was the whole masked-empty bug', () => {
    // ⚠️ The mechanism, stated once: in Swift an ABSENT key satisfies an
    // OPTIONAL property, so `{ let sessions: [CallSession]? }` decoded the 401
    // body without complaint. A non-optional `ok` cannot be satisfied by a body
    // that isn't the documented success shape.
    const struct = body(code(readFileSync(VOICE, 'utf8')), 'struct CallSessionsBody: Decodable {')
    expect(struct, 'ok went optional — every refusal body decodes again')
      .toMatch(/let ok: Bool\s*$/m)
    expect(struct).not.toMatch(/let ok: Bool\?/)
  })

  it('the rows gate on `ok` and raise the ONE house error', () => {
    const rows = body(code(readFileSync(VOICE, 'utf8')),
                      'static func rows(from data: Data) throws -> [CallSession] {')
    expect(rows).toMatch(/guard body\.ok, let list = body\.sessions else \{ throw ApiError\.badResponse \}/)
    // No sentence of its own: the caption is `LoadFailure`'s job, and a second
    // copy of the status wording is how five sheets drifted apart. Enumerated
    // rather than "no literal over N chars" — that form matched the GAP between
    // `"ended"` and `"error"` (a closing quote can open a match), so it flagged
    // two field values as prose while a real sentence could hide between them.
    const literals = caps(rows, /"([^"]*)"/).sort()
    expect(literals, 'the loader gained a string — a caption belongs in LoadFailure')
      .toEqual(['ended', 'error'])
  })

  it('a live call, a pocket dial and a silent row still stay hidden', () => {
    // Pinned because this increment rewrote the function that holds it, which is
    // the moment an unpinned invariant gets quietly dropped.
    const rows = body(code(readFileSync(VOICE, 'utf8')),
                      'static func rows(from data: Data) throws -> [CallSession] {')
    expect(rows).toMatch(/status == "ended" \|\| \$0\.status == "error"/)
    expect(rows).toMatch(/duration_ms \?\? 0\) > 2000/)
    expect(rows).toMatch(/segment_count \?\? 0\) > 0/)
  })

  it('the failure state offers the remedy it names', () => {
    // It was `Text(errorText).foregroundStyle(.secondary)` — a grey dead end,
    // while the caption it now shows ends in "try again" or "sign out and back
    // in". Every other list sheet in the app uses ContentUnavailableView with a
    // Retry; this one is the house shape now too.
    const src = code(readFileSync(VOICE, 'utf8'))
    const at = src.indexOf('} else if let errorText {')
    expect(at, 'the failure branch moved — re-anchor').toBeGreaterThan(-1)
    const branch = src.slice(at, src.indexOf('} else if sessions.isEmpty {', at))
    expect(branch.length, 'read the wrong region').toBeGreaterThan(80)
    expect(branch).toMatch(/ContentUnavailableView/)
    expect(branch).toMatch(/Text\(errorText\)/)
    expect(branch).toMatch(/Button\("Retry"\)/)
    expect(branch, 'a grey sentence with nothing to do about it')
      .not.toMatch(/Text\(errorText\)\.foregroundStyle\(\.secondary\)/)
  })

  it('the failure glyph does not name a cause the app never checked', () => {
    // ⚠️ A crossed-out wifi symbol over "Session expired — sign out and back in"
    // blames the wrong thing, and the picture is what gets read first. The house
    // pattern that IS honest is the screen's own subject, crossed out
    // (bolt.slash on Activity, iphone.slash on My Devices) — it says "this
    // content isn't here", which is all the app knows.
    const src = code(readFileSync(VOICE, 'utf8'))
    const at = src.indexOf('} else if let errorText {')
    const branch = src.slice(at, src.indexOf('} else if sessions.isEmpty {', at))
    expect(branch).toMatch(/Label\("Couldn't load calls", systemImage: "waveform\.slash"\)/)
    for (const cause of ['wifi.slash', 'antenna.radiowaves.left.and.right.slash', 'network.slash']) {
      expect(branch, `the glyph asserts ${cause} for a failure that is usually a 401`)
        .not.toContain(cause)
    }
  })

  it('the empty state is still allowed to say empty', () => {
    // The fix is not "never say empty" — a real 200 with no rows must still
    // reach the empty state, or the screen just moves the lie.
    const src = code(readFileSync(VOICE, 'utf8'))
    expect(src).toMatch(/ContentUnavailableView\("No calls yet"/)
    // And it sits AFTER the error branch, so a failure can never fall into it.
    expect(src.indexOf('"No calls yet"')).toBeGreaterThan(src.indexOf('} else if let errorText {'))
  })

  // ── the third surface ─────────────────────────────────────────────────────

  /**
   * Android told the same lie, and got there by a worse road.
   *
   * Its sheet also reached past the house client — to a bare `HttpURLConnection` —
   * but `conn.inputStream` THROWS on a 401 or a 502 (that is `getErrorStream`'s
   * job). So `runCatching { … }.getOrNull()` flattened BOTH refusals into one
   * sentence, "Couldn't load calls — check your connection", which on an expired
   * session blames the network for the app's own state and points at a remedy that
   * cannot work. Worse than iOS's: iOS at least distinguished nothing, quietly;
   * Android asserted a wrong cause.
   *
   * It also set `calls = emptyList()` on failure while ordering the spinner arm
   * before the error arm — so the empty state was reachable on a refusal, which is
   * the "No calls yet" claim itself.
   *
   * Kotlin `CallRecordingsLoadTest` owns the rule (all three answers, no network).
   * These pins own the wiring.
   */
  const KT = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/CallRecordingsSheet.kt')
  /** Kotlin comments stripped — a rule explained in prose must not satisfy a pin. */
  const kt = () =>
    readFileSync(KT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('the Android load rides the house client too', () => {
    const src = kt()
    // ⚠️ THE DEFECT, in one regex. The bypass is what threw the status away, and a
    // screen with no status can only guess at a cause.
    expect(src, 'the sheet reaches past app.api again — a raw connection has no failure contract')
      .not.toMatch(/HttpURLConnection/)
    expect(src, 'a raw URL fetch is back').not.toMatch(/URL\(\s*"\$\{app\.config\.serverBase\}/)
    expect(src).toMatch(/app\.api\.getJson\("\/api\/voice\/sessions"\)/)
    // And the old single caption, which asserted a cause for two answers that
    // weren't it.
    expect(src, 'the connection is being blamed for every refusal again')
      .not.toMatch(/Couldn't load calls — check your connection/)
  })

  it('the Android sheet asks the shared rule for both halves', () => {
    const src = kt()
    expect(src, 'the rows are no longer coming from the checked rule')
      .toMatch(/CallRecordingsLoad\.rows\(res\)/)
    expect(src, 'the caption is no longer the shared rule\'s')
      .toMatch(/error = CallRecordingsLoad\.message\(res\)/)
    // The rule delegates to the same LoadFailure the other six sheets use, rather
    // than growing a seventh copy of the status wording.
    expect(src).toMatch(/LoadFailure\.loaded\(res, "sessions"\)/)
    expect(src, 'the rule writes its own status sentence')
      .not.toMatch(/friendlyHttpError/)
  })

  it('a failed Android load cannot reach the empty state', () => {
    // ⚠️ The ordering IS the bug. `calls` stays null on failure, so if the spinner
    // arm came first a refusal would spin forever — and if `calls` were set to an
    // empty list, the empty state would say "No calls yet" about an answer that
    // never came. Both were true before.
    const src = kt()
    const errAt = src.indexOf('error != null ->')
    const loadingAt = src.indexOf('calls == null ->')
    const emptyAt = src.indexOf('calls!!.isEmpty() ->')
    expect(errAt, 'the failure arm went away — re-anchor').toBeGreaterThan(-1)
    expect(loadingAt, 'the loading arm went away — re-anchor').toBeGreaterThan(-1)
    expect(emptyAt, 'the empty arm went away — re-anchor').toBeGreaterThan(-1)
    expect(errAt, 'the failure arm no longer precedes the spinner — a refusal spins forever')
      .toBeLessThan(loadingAt)
    expect(loadingAt, 'the spinner no longer precedes the empty state').toBeLessThan(emptyAt)
    // And no failure path hands the empty state a list to be confident about.
    const eff = body(src, 'LaunchedEffect(reloadKey) {')
    expect(eff, 'a failed load sets an empty list again — that IS the "No calls yet" lie')
      .not.toMatch(/calls = emptyList\(\)/)
  })

  it('the Android failure state offers the remedy it names', () => {
    // Grey body text with no control was a dead end, and the caption now often ends
    // in "try again". The house shape (Jobs, My Devices): reason + retry.
    const src = kt()
    const at = src.indexOf('error != null ->')
    expect(at).toBeGreaterThan(-1)
    const arm = src.slice(at, loadingArmStart(src, at))
    expect(arm, 'the failure arm stopped showing the reason').toMatch(/Text\(error!!/)
    expect(arm, 'the failure arm offers no way out').toMatch(/TextButton\(/)
    expect(arm, 'the retry does not re-run the load').toMatch(/reloadKey\+\+/)
    // The load must actually be keyed on it, or the button is decoration.
    expect(src, 'the retry key does not drive the load').toMatch(/LaunchedEffect\(reloadKey\)/)
  })

  /** The failure arm ends where the loading arm begins — scoped, so a pin on the
   *  failure arm cannot be satisfied by a control in a later branch. */
  function loadingArmStart(src: string, from: number): number {
    const next = src.indexOf('calls == null ->', from)
    expect(next, 'the loading arm no longer follows the failure arm').toBeGreaterThan(from)
    return next
  }

  it('the Android empty state is still allowed to say empty', () => {
    // The fix is not "never say empty" — a real 200 with no rows must still reach
    // it, or the screen just moves the lie.
    expect(kt()).toMatch(/No calls yet/)
  })

  it('⚠️ FAILS WHEN FIXED: the route answers only 401 and 502', () => {
    // The caption is only as good as the table's coverage. 401 and 5xx are both
    // statuses the table OWNS (`statusOwnsTheMessage`), which is what keeps the
    // edge's raw "The operation was aborted due to timeout" off the screen. A
    // 402 or 404 here would be worse than a bare code: the table words those for
    // CHAT ("That tiny doesn't exist"), which on a recordings list is a lie.
    const src = readFileSync(ROUTE, 'utf8')
    const statuses = caps(src, /,\s*(\d{3})\s*\)/).map(Number)
    expect(statuses.sort(), '🎉 the route gained a status — check the table has words for it')
      .toEqual([401, 502])
    // And the premise the optional `sessions` rests on: a 200 ALWAYS carries the
    // key, so an absent one really is a broken body rather than "none".
    expect(src).toMatch(/json\(\{\s*ok:\s*true,\s*sessions:\s*res\?\.sessions \|\| \[\]\s*\}\)/)
  })
})

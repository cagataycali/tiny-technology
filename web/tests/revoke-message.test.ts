// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REVOKE_FAILED_LEAD,
  revokeMessage,
  revokeStatusLine,
} from '../lib/devices/revoke-message'

/**
 * 🔴 A revoke that failed left the token working — and neither surface said so.
 *
 * Revoke is the destructive action on the devices sheet. It was also the request
 * that told the user the least:
 *
 *  · iOS took `ok = code < 400`, discarded the body, and printed one sentence —
 *    "Couldn't revoke — try again." — for a rejected session, a malformed request,
 *    a worker that refused and a transport blip alike. A 401 cannot be fixed by
 *    trying again, and the app already had the table that knows so
 *    (`Api.httpMessage`, which `HTTPErrorTests` exists to keep from drifting).
 *  · Web printed the server's raw `error`, and for a transport failure that string
 *    is `String(e?.message)` from the edge — "The operation was aborted due to
 *    timeout", on a person's screen.
 *
 * Neither said the fact that matters: the device's token is STILL WORKING. That is
 * what someone revoking a phone they just lost needs to know, and "try again"
 * implies the opposite — that nothing has been decided yet.
 *
 * This suite owns the web rule (real unit tests) and the cross-surface agreement:
 * the same lead clause, the same status words, and neither client dropping a row
 * whose token might still be live.
 */

const ROOT = process.cwd()
const PAGE = join(ROOT, 'app/devices/page.tsx')
const SWIFT = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const API = join(ROOT, 'ios/Tiny/Sources/Api.swift')
const WORKER = join(ROOT, 'worker/src/devices.ts')
const KT = join(
  ROOT,
  'android/app/src/main/java/technology/tiny/app/ui/Panels.kt',
)
const KT_API = join(
  ROOT,
  'android/app/src/main/java/technology/tiny/app/net/TinyApi.kt',
)

/** Comments stripped: a rule explained in prose must not satisfy an assertion. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')

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

/** A block, with the anchor ASSERTED — `slice(-1)` is one character, on which
 *  every `.not.toMatch()` passes forever. Two suites here went vacuous that way. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`)
    .toBeGreaterThan(-1)
  return braced(source, at)
}

describe('a failed revoke says what it left behind', () => {
  // ── the web rule ──────────────────────────────────────────────────────────

  it('a real revoke says nothing at all', () => {
    // The row disappearing IS the message; a green "revoked!" toast over a list
    // that already lost the row is noise.
    expect(revokeMessage(200, { ok: true, revoked: 1 })).toBeNull()
    expect(revokeMessage(204, { ok: true })).toBeNull()
  })

  it('a 200 whose body disagrees is not a revoke', () => {
    // A proxy or a mid-redeploy page can answer 200 with anything. The route's own
    // comment says a false success "would hide a still-live device token".
    expect(revokeMessage(200, { ok: false, error: 'revoke failed' })).not.toBeNull()
    expect(revokeMessage(200, null)).not.toBeNull()
    expect(revokeMessage(200, {})).not.toBeNull()
    // Including the shape a non-JSON error page leaves behind.
    expect(revokeMessage(502, null)).toContain('HTTP 502')
    // ⚠️ And the mirror of it: success needs BOTH halves. Pinning only the `ok`
    // half let a mutant widen the accepted range to 4xx with nothing failing,
    // while the docstring above kept claiming a conjunction.
    expect(revokeMessage(424, { ok: true })).not.toBeNull()
    expect(revokeMessage(401, { ok: true })).not.toBeNull()
  })

  it('every failure leads with the token, not with the request', () => {
    for (const [status, body] of [
      [401, { ok: false, error: 'login required' }],
      [400, { ok: false, error: 'deviceId required' }],
      [424, { ok: false, error: 'revoke failed' }],
      [503, { ok: false, error: 'aborted', retryable: true }],
      [0, null],
    ] as const) {
      const msg = revokeMessage(status, body)!
      expect(msg.startsWith(REVOKE_FAILED_LEAD), `status ${status} buried the outcome`).toBe(true)
      expect(msg.toLowerCase()).toContain('still works')
    }
  })

  it('a raw transport exception never reaches the screen', () => {
    // ⚠️ The actual string the route sends on a timeout: `String(e?.message)` from
    // AbortSignal.timeout. It is a JS diagnostic, not a sentence for a person.
    const raw = 'The operation was aborted due to timeout'
    const msg = revokeMessage(503, { ok: false, error: raw, retryable: true })!
    expect(msg).not.toContain(raw)
    expect(msg).toContain('Server hiccup (HTTP 503)')
    // A fetch that threw client-side has no status at all.
    expect(revokeMessage(0, null)).toContain('No response')
  })

  it('the server keeps its words where it is describing THIS request', () => {
    // A 400 naming the missing field and a 424 naming the refusal both beat
    // anything a status table could say — this is `statusOwnsTheMessage` inverted,
    // and it is why the code is kept alongside.
    expect(revokeStatusLine(400, 'deviceId required')).toBe('deviceId required (HTTP 400)')
    expect(revokeStatusLine(424, 'revoke failed')).toBe('revoke failed (HTTP 424)')
    // …and loses them where it cannot: a stored-token app has nowhere to "log in".
    expect(revokeStatusLine(401, 'login required')).not.toContain('login required')
    expect(revokeStatusLine(401, 'login required')).toContain('sign out')
    // An empty or whitespace-only message is not a message.
    expect(revokeStatusLine(400, '   ')).toBe('HTTP 400')
    expect(revokeStatusLine(400, null)).toBe('HTTP 400')
  })

  it('the lead is one terminated sentence and never says try again', () => {
    // It gets a reason appended, so it must end cleanly — the `· tap to retry` bug
    // was a fragment with no terminator joined to someone else's words.
    expect(REVOKE_FAILED_LEAD.endsWith('.')).toBe(true)
    expect(REVOKE_FAILED_LEAD.toLowerCase()).not.toContain('try again')
    expect(revokeMessage(424, { ok: false, error: 'revoke failed' })).not.toContain('  ')
  })

  // ── the two surfaces agree ────────────────────────────────────────────────

  it('both surfaces lead with the SAME sentence', () => {
    // The device being revoked is very often the OTHER one, so a user reads this
    // outcome on whichever surface is in their hand.
    const swift = code(readFileSync(SWIFT, 'utf8'))
    expect(swift).toContain(`static let lead = "${REVOKE_FAILED_LEAD}"`)
  })

  it('web mirrors the app table for the statuses this route answers', () => {
    // iOS delegates to `Api.httpMessage`; the web has no such table, so this
    // function is a deliberate mirror. Pin the shared strings BYTE-for-byte —
    // a paraphrase is exactly how two copies drift.
    const api = code(readFileSync(API, 'utf8'))
    const table = body(api, 'static func friendlyHTTPError(')
    expect(table).toContain(`"${revokeStatusLine(401, 'login required')}"`)
    expect(table).toContain(`"${revokeStatusLine(0, null)}"`)
    // 5xx is interpolated on both sides, so compare the shape around the code.
    expect(table).toContain('Server hiccup (HTTP \\(status)) — usually passes, try again')
    expect(revokeStatusLine(503, null)).toBe('Server hiccup (HTTP 503) — usually passes, try again')
    // The house rule for WHICH statuses the client speaks for: 401, 0, 5xx.
    expect(code(api)).toMatch(/status == 401 \|\| status == 0 \|\| \(500\.\.\.599\)\.contains\(status\)/)
  })

  // ── the wiring ────────────────────────────────────────────────────────────

  it('iOS reads the BODY, not just the status code', () => {
    const revoke = body(code(readFileSync(SWIFT, 'utf8')), 'private func revoke(_ dev: DeviceRow) async {')
    expect(revoke).toContain('RevokeFailure.message(status: status, body: body)')
    expect(revoke).toMatch(/body = \(try\? JSONSerialization\.jsonObject\(with: data\)\) as\? \[String: Any\]/)
    // The sentence that treated every failure alike.
    expect(revoke, 'the one-size sentence is back').not.toMatch(/Couldn't revoke/)
    // …and the status-only verdict that made the body unnecessary.
    expect(revoke, 'iOS is deciding success from the status code alone again')
      .not.toMatch(/code < 400/)
  })

  it('iOS lets the SERVER decide whether the row is gone', () => {
    // No optimistic drop: a row that vanished while its token still worked is the
    // worst outcome available here. `load()` is unconditional, before the message.
    const revoke = code(readFileSync(SWIFT, 'utf8'))
    const fn = body(revoke, 'private func revoke(_ dev: DeviceRow) async {')
    const load = fn.indexOf('await load()')
    const say = fn.indexOf('revokeError = RevokeFailure.message')
    expect(load, 'the reload vanished — the row now outlives its own revoke')
      .toBeGreaterThan(-1)
    expect(say).toBeGreaterThan(load)
    expect(fn, 'iOS started dropping rows locally').not.toMatch(/devices\.removeAll|devices\.remove\(at/)
  })

  it('web drops the row only after the failure check', () => {
    const page = code(readFileSync(PAGE, 'utf8'))
    const fn = page.slice(page.indexOf('const revoke = async (d: Device)'))
    expect(fn.indexOf('const revoke'), 'revoke moved — re-anchor').toBe(0)
    const check = fn.indexOf('const failure = revokeMessage(res.status, data)')
    const drop = fn.indexOf('prev.filter((x) => x.id !== d.id)')
    expect(check, 'the page stopped asking the rule').toBeGreaterThan(-1)
    expect(drop, 'the optimistic drop moved ahead of the check').toBeGreaterThan(check)
    // The raw-error path and the second sentence are both gone.
    expect(fn, 'the page prints the server string again').not.toMatch(/setError\(data\.error/)
    expect(fn, 'a second failure sentence came back').not.toMatch(/Revoke failed/)
    // A non-JSON body must not throw into the catch and lose its status.
    expect(fn).toMatch(/res\.json\(\)\.catch\(\(\) => null\)/)
    expect(fn).toMatch(/setError\(revokeMessage\(0, null\)\)/)
  })

  // ── the third surface ─────────────────────────────────────────────────────

  it('all THREE surfaces lead with the same sentence, byte for byte', () => {
    // Kotlin's own rule is unit-tested (`RevokeFailureTest`); this is the one
    // assertion no per-app suite can make. A paraphrase on one surface is exactly
    // how three copies drift, and the device being revoked is usually the other one.
    const kt = code(readFileSync(KT, 'utf8'))
    expect(kt).toContain(`const val lead = "${REVOKE_FAILED_LEAD}"`)
  })

  it('Android asks the rule, and the rule alone decides the row is gone', () => {
    const kt = code(readFileSync(KT, 'utf8'))
    const at = kt.indexOf('pendingRevoke?.let { d ->')
    expect(at, 'the revoke confirm moved — re-anchor').toBeGreaterThan(-1)
    const fn = braced(kt, at)
    expect(fn.length, 'read the wrong Kotlin').toBeGreaterThan(400)
    // ONE decision drives both halves, so the sheet cannot drop a row while telling
    // the user the token still works.
    expect(fn).toMatch(/val failure = RevokeFailure\.message\(res\)/)
    const check = fn.indexOf('val failure = RevokeFailure.message(res)')
    const drop = fn.indexOf('devices?.filterNot { it.id == d.id }')
    expect(drop, 'the optimistic drop moved ahead of the check').toBeGreaterThan(check)
    // ⚠️ Ordering alone cannot see which ARM each half is in: swapping the two
    // bodies keeps `drop > check` and drops the row on exactly the failures. So pin
    // the drop INSIDE the null arm, and the sentence as the other one.
    expect(fn, 'the row is dropped on FAILURE — the one outcome that must never happen')
      .toMatch(/if \(failure == null\) \{[^}]*devices = devices\?\.filterNot/)
    expect(fn, 'the failure is computed and then not said').toMatch(/revokeError = failure/)
    // The status-only verdict, the defaulted `ok`, and the one-size sentence.
    expect(fn, 'Android decides success from the status code alone again')
      .not.toMatch(/status < 400/)
    expect(fn, 'a 2xx body that says ok:false counts as a revoke again')
      .not.toMatch(/optBoolean\("ok", /)
    expect(fn, 'the one-size sentence is back').not.toMatch(/couldn't revoke device/)
  })

  it('the CHAT status table cannot reach the revoke sheet', () => {
    // The actual Android defect: the reason came from `friendlyHttpError`, which is
    // the chat table — asked about a revoke it answers "that tiny doesn't exist"
    // (404) and "this tiny charges per message" (402). Both are confident answers to
    // a question nobody asked, about a thing that is not a tiny.
    const kt = code(readFileSync(KT, 'utf8'))
    const at = kt.indexOf('pendingRevoke?.let { d ->')
    expect(at, 'the revoke confirm moved — re-anchor').toBeGreaterThan(-1)
    expect(braced(kt, at), 'the chat table is wired to the revoke sheet again')
      .not.toMatch(/friendlyHttpError/)
    const rule = body(kt, 'internal object RevokeFailure {')
    expect(rule, 'the revoke rule delegates to the chat table')
      .not.toMatch(/friendlyHttpError/)
    // And the chat table still says the thing that made it wrong here — if that
    // ever changes, this pin should be re-read rather than silently still passing.
    const api = code(readFileSync(KT_API, 'utf8'))
    expect(api).toMatch(/code == 404 -> "that tiny doesn't exist"/)
  })

  it('Android speaks for the same three statuses, and yields on the rest', () => {
    // The house `statusOwnsTheMessage` set — 401, 0, 5xx — spelled the same way on
    // all three surfaces. Everything else prefers the server's own words, which are
    // describing THIS request.
    const rule = body(code(readFileSync(KT, 'utf8')), 'internal object RevokeFailure {')
    expect(rule).toMatch(/if \(status == 0\) return/)
    expect(rule).toMatch(/if \(status == 401\) return/)
    expect(rule).toMatch(/if \(status in 500\.\.599\) return/)
    expect(rule, 'the server message stopped being preferred').toMatch(/serverMessage\?\.trim\(\)/)
    // A 5xx carries `String(e.message)` from the edge — the route's transport arm —
    // so the status owning the message is what keeps "The operation was aborted due
    // to timeout" off a person's screen. Asserted as an ordering: the 5xx return
    // must come BEFORE the server-message branch, not merely exist.
    const fiveXX = rule.indexOf('if (status in 500..599) return')
    const prefer = rule.indexOf('serverMessage?.trim()')
    expect(prefer, 'the server-message branch vanished').toBeGreaterThan(-1)
    expect(prefer, 'a 5xx now prints the edge\'s raw exception text')
      .toBeGreaterThan(fiveXX)
  })

  it('Android does not read a SUCCESS as a lost connection', () => {
    // ⚠️ Android-only trap, and the reason the rule derives the status itself:
    // `executeJson` stamps `_status` ONLY on a non-2xx, so a successful revoke
    // carries none and `optInt("_status", 0)` reads 0 — the code for "nothing
    // answered". The previous call site got away with it by testing `status < 400`.
    const api = code(readFileSync(KT_API, 'utf8'))
    const exec = body(api, 'private suspend fun executeJson(')
    expect(exec, 'the premise moved: _status may now be stamped on success too')
      .toMatch(/if \(!response\.isSuccessful\) \{\s*json\.put\("_status", response\.code\)/)
    const rule = body(code(readFileSync(KT, 'utf8')), 'internal object RevokeFailure {')
    expect(rule, 'a 2xx with no _status would read as 0 — every success would claim no response')
      .toMatch(/optInt\("_status", 200\)/)
  })

  // ── the premise this rule rests on ────────────────────────────────────────

  it('⚠️ FAILS WHEN FIXED: nothing hard-deletes a device row', () => {
    // Neither client reads the `revoked` count the worker returns, and that is a
    // decision, not an oversight: `UPDATE devices SET revoked = 1 WHERE id = ?1
    // AND user_id = ?2` matches an ALREADY-revoked row too (SQLite counts matched
    // rows), and no code path removes a row outright — so `revoked: 0` needs a
    // deviceId that was never on this account, which the sheet's own list cannot
    // produce. Copy for an unreachable state is copy nobody can verify.
    //
    // If a hard delete ever lands (account erasure is an open gap), `revoked: 0`
    // becomes reachable and BOTH clients must read the count: a 200 that changed
    // no rows would otherwise report a successful revoke of a live token.
    const worker = readFileSync(WORKER, 'utf8')
    expect(worker, '🎉 a device row can now be deleted outright — read `revoked` in both clients')
      .not.toMatch(/DELETE\s+FROM\s+devices/i)
    // And the count is still there to be read when that day comes.
    expect(worker).toMatch(/revoked: Number\(res\?\.meta\?\.changes \|\| 0\)/)
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The one irreversible step in setting up a necklace, and what the sheet may say
 * about it.
 *
 * `POST /api/devices` mints the board's token and returns it EXACTLY ONCE
 * (TinySetup.swift's header: an orphaned row "can never be provisioned, only
 * revoked"). The sheet used to answer every ending of that request with one
 * composite `guard` and one sentence — "Could not enroll the device — check your
 * connection and login" — which is inc 15's two-mutually-exclusive-causes defect
 * on the highest-stakes action in the panel, plus a claim the app cannot make:
 *
 *   `app/api/devices/route.ts` turns a worker that overran its 10s budget into a
 *   **503** (`relay()`'s `transient` branch), and that worker may have inserted
 *   the row already. "Could not enroll" sends the user to press Set up again, so
 *   one necklace becomes two rows and the first one's token is gone for good.
 *
 * `EnrollOutcome` owns the answer now: **a 4xx is a decision, a 5xx or a dead
 * connection is the absence of one.** The words are tested in Swift
 * (`EnrollOutcomeTests`); these pins hold the wiring — the parts that live inside
 * a `@MainActor` view and can only be checked in the source — and the two claims
 * about OTHER files that the design rests on.
 *
 * ⚠️ Comments are stripped before every scan: the new doc quotes `try?` and the
 * removed sentence verbatim while explaining their removal.
 */

const repo = join(__dirname, '..')
const raw = (p: string) => readFileSync(join(repo, p), 'utf8')
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\/\/.*$/gm, '')

const between = (src: string, from: string, to: string, what: string) => {
  const a = src.indexOf(from)
  expect(a, `${what}: "${from}" is gone — re-anchor`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a)
  expect(b, `${what}: "${to}" is gone — re-anchor`).toBeGreaterThan(a)
  return strip(src.slice(a, b))
}

const setup = () => raw('ios/Tiny/Sources/TinySetup.swift')
const setUpFn = () => between(setup(), 'private func setUp() async {', '\n}', 'setUp()')

describe('enrolling a board says only what the app can know', () => {
  it('the enrol reply is read, not guessed at with try?', () => {
    const body = setUpFn()
    // The thrown ApiError is the only thing that knows WHICH ending this was.
    expect(body, 'the enrol swallows its failure again')
      .not.toMatch(/try\?\s+await\s+Api\.post\("\/api\/devices"/)
    expect(body, 'the enrol is no longer a do/catch')
      .toMatch(/do \{\s*\n\s*outcome = EnrollOutcome\.read\(try await Api\.post\("\/api\/devices"/)
    expect(body, 'the throw is no longer classified').toContain('EnrollOutcome.read(error: thrown)')
  })

  it('the removed sentence is not anywhere in the app', () => {
    // Two mutually exclusive causes with opposite remedies, on the one action
    // that spends something irreversible.
    for (const f of ['ios/Tiny/Sources/TinySetup.swift', 'ios/Tiny/Sources/Panels.swift']) {
      expect(strip(raw(f)), `${f} still names both causes at once`)
        .not.toMatch(/check your connection and login/)
    }
  })

  it('only the enrolled case continues into the config write', () => {
    const body = setUpFn()
    // A `guard case` rather than a switch with a shared failure arm: the token is
    // bound by the same statement that proves it exists.
    expect(body, 'setUp no longer requires the enrolled case to proceed')
      .toMatch(/guard case \.enrolled\(let deviceId, let deviceToken\) = outcome else \{/)
    // Two facts, one regex: the reason is SHOWN, and the link is dropped — a
    // board cannot be configured without the token, and a failure nobody is told
    // about is the silence this whole increment exists to end.
    expect(body, 'a failed enrol goes silent, or leaves the BLE link open')
      .toMatch(/error = outcome\.message\s*\n\s*prov\.cancel\(\)/)
  })

  it('the classifier splits on the 4xx boundary and nothing else', () => {
    const cls = between(setup(), 'nonisolated static func read(error: Error)', '\n}', 'read(error:)')
    // 400...499 is the whole rule: a decision was made, so nothing was created.
    expect(cls, 'the decision boundary moved').toMatch(/\(400\.\.\.499\)\.contains\(status\)/)
    expect(cls, 'the fallthrough stopped being doubt').toMatch(/else \{ return \.unknown\(why\) \}/)
    expect(cls, 'the reason stopped coming from the house table').toContain('LoadFailure.message(error)')
  })

  it('both fields are required and trimmed before a board is called enrolled', () => {
    const rd = between(setup(), 'nonisolated static func read(_ body:', '\n}', 'read(_:)')
    for (const field of ['device_id', 'device_token']) {
      expect(rd, `${field} is no longer trimmed — a blank one would be written to flash`)
        .toMatch(new RegExp(`body\\["${field}"\\] as\\? String\\)\\?\\s*\\n?\\s*\\.trimmingCharacters`))
    }
    expect(rd, 'an empty field would now pass as enrolled')
      .toMatch(/guard !id\.isEmpty, !token\.isEmpty else \{ return \.unknown\(unreadable\) \}/)
  })

  it('the revoke errand belongs to the doubtful case alone', () => {
    const msg = between(setup(), 'var message: String? {', '\n    }', 'message')
    // After a real refusal there is nothing to revoke, so the errand would be
    // wasted; after doubt it is the difference between one row and two.
    expect(msg, 'the refusal arm started sending the user to My devices')
      .toMatch(/case \.refused\(let why\): return "\\\(Self\.refusedLead\) \\\(why\)"/)
    expect(msg, 'the doubtful arm stopped naming the remedy')
      .toMatch(/case \.unknown\(let why\): return "\\\(Self\.unknownLead\) \\\(why\) \\\(Self\.checkFleet\)"/)
    // `.enrolled` must stay silent — the config-write phase reports itself.
    expect(msg, 'the enrolled case grew a sentence').toMatch(/case \.enrolled: return nil/)
  })

  it('the classifier stays where a test can call it', () => {
    // Dropping `nonisolated` is a WARNING, not an error: EnrollOutcomeTests would
    // keep compiling while every call hopped the main actor.
    const src = strip(setup())
    expect(src.match(/nonisolated static func read\(/g)?.length,
      'a read() left the nonisolated island — EnrollOutcomeTests can no longer call it').toBe(2)
  })

  /**
   * The two claims about OTHER files that this design rests on. Both are
   * read-only here: if either moves, the Swift copy is wrong and this says which.
   */
  it('the 503 the design is built around is really what our own route answers', () => {
    const route = strip(raw('app/api/devices/route.ts'))
    // The fetch-threw branch: the worker may have inserted the row and the
    // response never came back. This is why 5xx cannot mean "nothing happened".
    expect(route, 'relay() stopped marking the fetch-threw case').toMatch(/transient: true/)
    const post = between(route, 'export async function POST', '\n}', 'POST')
    expect(post, 'the enrol route no longer turns a transient reach failure into a 503')
      .toMatch(/if \(transient\) return json\(\{ ok: false, error: data\.error, retryable: true \}, 503\)/)
  })

  it('the cap really is a 4xx carrying the server’s own sentence', () => {
    // `Api.httpMessage` prefers the server's words for 424, so the footer's
    // sentence reaches the setup sheet verbatim instead of being replaced.
    const worker = strip(raw('worker/src/devices.ts'))
    expect(worker, 'the worker stopped refusing an over-cap enrol with that sentence')
      .toMatch(/device limit reached \(\$\{MAX_DEVICES_PER_USER\}\) — revoke one first/)
    const api = strip(raw('ios/Tiny/Sources/Api.swift'))
    expect(api, '424 joined the statuses where the app overrides the server')
      .toMatch(/status == 401 \|\| status == 0 \|\| \(500\.\.\.599\)\.contains\(status\)/)
  })
})

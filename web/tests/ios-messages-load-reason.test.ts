// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 "Couldn't load messages — check your connection and pull to retry."
 *
 * The DM inbox said that for every failure it could have. Two claims the app
 * never checked — and on the route's commonest failure, an expired session,
 * *pulling to retry* is the one remedy guaranteed not to work. `loadInbox` used
 * `try? await Api.get` and collapsed the typed failure into `failed: Bool`, so
 * by the time the caption ran there was nothing left to say. A Bool can only
 * produce a guess. The thread's `"Couldn't load this conversation."` was the
 * other half: honest, and useless.
 *
 * `MessagesLoadFailureTests` (Swift) owns the rule — which statuses are verdicts
 * and what each one says. This suite owns the WIRING: that neither load
 * swallows its error, that the reason is shown everywhere it is set (a caption
 * only reachable on an empty inbox would just move the lie), that the verdict
 * carries no Retry button, and that the stale-request guards survived the
 * rewrite.
 */

const ROOT = process.cwd()
const SRC = join(ROOT, 'ios/Tiny/Sources/Messages.swift')

/** Comments stripped — this file's own prose names the strings it forbids, and
 *  so do the source comments explaining the rule. */
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

/** A block with its anchor ASSERTED — an unfound anchor makes `slice` return one
 *  character, on which every `.not.toMatch()` passes forever. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

describe('iOS DM loads: the reason survives the load', () => {
  it('neither load swallows its error with `try?`', () => {
    // ⚠️ The whole defect in one operator: `try?` turns a typed ApiError into
    // nil, and a caption written against nil can only list possibilities.
    const src = code(readFileSync(SRC, 'utf8'))
    for (const fn of ['func loadInbox(', 'func loadThread(']) {
      const region = body(src, fn)
      expect(region, `${fn} discards the error again`).not.toMatch(/try\?\s+await\s+Api\.get/)
      expect(region, `${fn} stopped reporting a reason`).toMatch(/LoadFailure\.contentMessage|classify/)
    }
  })

  it('the guessed and the empty captions are both gone', () => {
    const src = readFileSync(SRC, 'utf8')
    // The old inbox line, and the thread's contentless one. Checked against the
    // RAW source: if either comes back even inside a comment, someone is
    // reintroducing it.
    expect(src, 'the inbox is guessing at the cause again')
      .not.toMatch(/Text\([^)]*check your connection and pull to retry/)
    expect(src, "the thread's caption stopped carrying a reason")
      .not.toMatch(/Text\("Couldn't load this conversation\."\)/)
    // And the flags that made a reason impossible.
    expect(code(src), 'a Bool failure flag is back — it cannot carry a reason')
      .not.toMatch(/@Published var (failed|threadFailed)\b/)
  })

  it('the inbox shows its reason when the list is NOT empty too', () => {
    // ⚠️ The caption lives inside `if model.threads.isEmpty`. An inbox WITH
    // threads is the commoner case, and there a failed pull-to-refresh said
    // nothing at all — the surface implied the list was current. A fix only
    // reachable on an empty inbox would move the lie, not remove it.
    const src = code(readFileSync(SRC, 'utf8'))
    const inbox = body(src, 'private var inbox: some View')
    const emptyAt = inbox.indexOf('if model.threads.isEmpty')
    expect(emptyAt, 'the empty-inbox branch moved — re-anchor').toBeGreaterThan(-1)
    // A `model.failure` read must exist OUTSIDE that branch: after the block it
    // opens, not inside it.
    const emptyBlock = braced(inbox, emptyAt)
    const after = inbox.slice(emptyAt + emptyBlock.length)
    expect(after, 'a failed refresh with threads on screen says nothing')
      .toMatch(/else if let \w+ = model\.failure/)
    // Both branches, so the reason is unmissable either way.
    expect(emptyBlock, 'the empty-inbox branch stopped showing the reason')
      .toMatch(/model\.failure/)
  })

  it('the permanent verdict requires a 404 that explained itself', () => {
    // ⚠️ Two different things answer 404 here: the worker's
    // `{error:"peer not found"}`, which is about the person, and its router's
    // plain-text `404 Not Found.` for a path that no longer exists — which a
    // stale build of THIS app reaches, as does a stale Next deploy for
    // /api/messages itself. Keying `.gone` on the bare status would render our
    // own staleness as someone's absence.
    const src = code(readFileSync(SRC, 'utf8'))
    const fn = body(src, 'static func classify(')
    expect(fn, 'classify() went back to trusting the bare status')
      .toMatch(/case \.http\(404,\s*let \w+\)\?/)
    expect(fn, 'a blank server body can be called a missing peer again')
      .toMatch(/trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty/)
    // The retryable arm must go through `contentMessage`. On a bare 404 — the
    // one status where the two diverge — `message` would ship the chat table's
    // "That tiny doesn't exist" to a list of PEOPLE.
    expect(fn, 'the retryable arm reaches for the chat table')
      .toMatch(/LoadFailure\.contentMessage\(/)
    expect(fn, 'the retryable arm reaches for the chat table')
      .not.toMatch(/LoadFailure\.message\(/)
  })

  it('the verdict has no Retry and the outage does', () => {
    const src = code(readFileSync(SRC, 'utf8'))
    const thread = body(src, 'private func thread(')
    const goneAt = thread.indexOf('model.peerGone')
    expect(goneAt, 'the peer-gone branch is missing — re-anchor').toBeGreaterThan(-1)
    const goneBlock = braced(thread, goneAt)
    // Retrying a 404 ends the same way every time; offering the button is an
    // invitation to a loop the app knows cannot finish.
    expect(goneBlock, 'the permanent verdict grew a Retry button')
      .not.toMatch(/Button\("Retry"|Button\("Try again"/)
    expect(goneBlock, "the verdict stopped naming who it's about").toMatch(/peer\.login/)
    // And it must not speak the wire's word for a person.
    expect(goneBlock.toLowerCase(), "the wire's word for a person reached the screen")
      .not.toContain('peer not found')

    const failAt = thread.indexOf('model.threadFailure')
    expect(failAt, 'the retryable branch is missing — re-anchor').toBeGreaterThan(-1)
    expect(braced(thread, failAt), 'the retryable failure lost its Retry')
      .toMatch(/Button\("Retry"\)/)
  })

  it('the stale-request guards survived the rewrite', () => {
    // ⚠️ These were UNPINNED before this increment, and the rewrite moved the
    // code around them. A stale A-load resolving after the user opened B must
    // not write A's failure, A's messages, or clear B's spinner.
    const src = code(readFileSync(SRC, 'utf8'))
    const fn = body(src, 'func loadThread(')
    expect((fn.match(/req == threadRequest/g) ?? []).length,
           'a stale-request guard was dropped').toBeGreaterThanOrEqual(3)
    // In the catch, the guard must come BEFORE any state is written, or a stale
    // failure lands on the thread the user is actually looking at.
    const catchAt = fn.indexOf('} catch {')
    expect(catchAt, 'the catch moved — re-anchor').toBeGreaterThan(-1)
    const catchBlock = fn.slice(catchAt)
    const guardAt = catchBlock.indexOf('guard req == threadRequest')
    const writeAt = catchBlock.search(/(peerGone|threadFailure)\s*=/)
    expect(guardAt, 'the catch lost its stale-request guard').toBeGreaterThan(-1)
    expect(writeAt, 'the catch stopped recording the failure').toBeGreaterThan(-1)
    expect(guardAt, 'a stale failure can now land on the thread being viewed')
      .toBeLessThan(writeAt)
  })

  it('a successful load clears BOTH failure states', () => {
    // Otherwise a peer that came back stays "not reachable any more" forever,
    // and the messages render underneath the verdict that denies them.
    const src = code(readFileSync(SRC, 'utf8'))
    const fn = body(src, 'func loadThread(')
    const commitAt = fn.lastIndexOf('guard req == threadRequest')
    const commit = fn.slice(commitAt)
    expect(commit, 'a recovered thread keeps its stale failure').toMatch(/threadFailure = nil/)
    expect(commit, 'a returning peer stays gone forever').toMatch(/peerGone = false/)
    expect(body(src, 'func loadInbox('), 'a recovered inbox keeps its stale failure')
      .toMatch(/failure = nil/)
  })

  it('opening a thread clears the previous one’s failure', () => {
    // Tapping B while A's verdict is on screen must not show B as gone.
    const src = code(readFileSync(SRC, 'utf8'))
    const inbox = body(src, 'private var inbox: some View')
    expect(inbox, "a tapped thread inherits the last one's failure")
      .toMatch(/model\.threadFailure = nil/)
    expect(inbox, "a tapped thread inherits the last one's verdict")
      .toMatch(/model\.peerGone = false/)
  })

  it("⚠️ FAILS WHEN FIXED: the answer set the split is built on", () => {
    // The 404→verdict routing is only right while the worker answers 404 for a
    // login it can't resolve, and the "internal detail stays internal" rule only
    // holds while its D1 failure is a 5xx. If either moves, this fails rather
    // than letting the app quietly mis-word someone's absence.
    const w = join(ROOT, 'worker/src/messages.ts')
    if (!existsSync(w)) return // submodule not checked out
    const src = readFileSync(w, 'utf8')
    expect(src, '🎉 /messages no longer 404s an unresolvable peer — recheck classify()')
      .toMatch(/json\(\{\s*error:\s*"peer not found"\s*\}\s*,\s*404\)/)
    expect(src, '🎉 the D1 failure is no longer a 5xx — its body would now reach the screen')
      .toMatch(/json\(\{\s*error:\s*"messages unavailable"\s*\}\s*,\s*500\)/)
    // ⚠️ The OTHER 404 on this path, and the whole reason `.gone` keys on the
    // BODY: the router's catch-all answers plain text, so `Api.serverError(in:)`
    // yields nil and a stale build lands on the retryable arm instead of
    // accusing a healthy person. If this ever becomes a JSON `{error}`, the
    // split stops holding and the bare-404 arm needs a different key.
    const index = readFileSync(join(ROOT, 'worker/src/index.ts'), 'utf8')
    expect(index, "🎉 the router's catch-all moved — recheck classify()'s bare-404 arm")
      .toMatch(/router\.all\('\*',\s*\(\)\s*=>\s*new Response\('Not Found\.',\s*\{\s*status:\s*404/)
    // And the route's own two, which are what the caption words most often.
    const route = readFileSync(join(ROOT, 'app/api/messages/route.ts'), 'utf8')
    expect(route, '🎉 the route stopped 401ing a missing session')
      .toMatch(/'login required'[\s\S]{0,60}status:\s*401/)
    expect(route, '🎉 the route no longer degrades to 503 — recheck the caption set')
      .toMatch(/status = 503/)
    // ⚠️ The premise that makes 400 unreachable: the route always supplies
    // userId, so the worker's `400 {error:"userId required"}` cannot be produced
    // by this client. If that ever stops being true, classify() needs a 400 arm.
    expect(route, '🎉 the route no longer always sends userId — classify() needs a 400 arm')
      .toMatch(/new URLSearchParams\(\{\s*userId:\s*session\.sub\s*\}\)/)
  })
})

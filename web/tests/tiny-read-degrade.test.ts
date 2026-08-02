// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 "Only acme's owner can edit it. Set the Tiny field to one of your own tinys."
 *
 * Shown to the owner of `acme`, on the editor they opened from their own list,
 * because `plugin.tiny.technology` was slow. `app/api/tiny/route.ts` bounds the
 * worker at 10s and degrades a timeout / 5xx / non-JSON body into **HTTP 200
 * carrying its blank shape**. That shape has no `isOwner`; iOS read
 * `d["isOwner"] as? Bool ?? false`, and false has exactly one branch — the
 * sentence above. A confident claim about ownership derived from an answer that
 * never came, plus a remedy that fixes nothing.
 *
 * The status stays 200 on purpose (see the `res.ok` pin at the bottom), so the
 * fix is additive: the catch marks itself `unavailable: true`, and "the read
 * failed" becomes something the client is TOLD instead of something it infers
 * from a missing key. `TinyEditorLoadTests` (Swift) owns the rule — which
 * bodies are failures and which are answers. This suite owns the WIRING and the
 * route contract the rule depends on.
 *
 * The chat surface reads the same route, and the same 200 hit it harder: not a
 * false sentence but a WIPE. `ChatModel.loadTheme` applied the blank shape as
 * configuration — accent to brand green, hero/logo/intro-vibe/chips/tagline
 * cleared, and `cfg_accent_hex` overwritten, which WatchBridge and the widget
 * snapshot both read. One failure, two deliveries, two behaviours: arriving as
 * an error it returned early and kept everything.
 */

const ROOT = process.cwd()
const IOS = join(ROOT, 'ios/Tiny/Sources/Settings.swift')
const CHAT = join(ROOT, 'ios/Tiny/Sources/Views.swift')
const ROUTE = join(ROOT, 'app/api/tiny/route.ts')

/** Comments stripped — the prose in both files names the very strings pinned
 *  below, so an unstripped read would match its own explanation. */
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

describe('the tiny editor: ownership is a verdict the server gave', () => {
  it('load() no longer swallows the error that explains itself', () => {
    const load = body(code(readFileSync(IOS, 'utf8')), 'private func load() async {')
    expect(load, 'load() went back to `try?` — a nil error can only produce a guess')
      .not.toMatch(/try\?\s*await\s*Api\.post\("\/api\/tiny"/)
    expect(load, 'the throwing path lost its reason')
      .toMatch(/catch\s*\{[\s\S]*?loadFailure = LoadFailure\.contentMessage\(error\)/)
    // `message` is the CHAT table: its 404 line is "That tiny doesn't exist",
    // which on an editor opened from the user's own list is the same class of
    // wrong answer this increment removes.
    expect(load, 'the editor reaches for the chat table')
      .not.toMatch(/LoadFailure\.message\(/)
  })

  it('a marked body stops before ownership is ever read', () => {
    const load = body(code(readFileSync(IOS, 'utf8')), 'private func load() async {')
    const guardAt = load.indexOf('TinyEditorLoad.readFailed(d)')
    const ownerAt = load.indexOf('isOwner = d["isOwner"]')
    expect(guardAt, 'the degrade check is gone — a blank 200 is an ownership verdict again')
      .toBeGreaterThan(-1)
    expect(ownerAt, 'the isOwner write moved or vanished; this pin cannot see it')
      .toBeGreaterThan(-1)
    expect(guardAt, 'the check runs AFTER isOwner is written — the lie lands first')
      .toBeLessThan(ownerAt)
    // And it must actually leave the screen: `loadError = true` inside the guard.
    expect(braced(load, guardAt), 'the marked body no longer routes to the failed screen')
      .toMatch(/loadError = true/)
  })

  it('the failure screen says what happened, not what to do about it', () => {
    // Stripped: the branch's own comment quotes the sentence it replaced, and an
    // unstripped read would fail on the explanation instead of the code.
    const src = code(readFileSync(IOS, 'utf8'))
    const failed = braced(src, src.indexOf('} else if screen == .failed {'))
    expect(failed.length, 'the .failed branch is gone').toBeGreaterThan(40)
    expect(failed, 'the unchecked remedy is back')
      .not.toMatch(/check (the|your) connection/i)
    expect(failed, 'the reason no longer reaches the screen')
      .toMatch(/Text\(loadFailure \?\?/)
    // TRUE, and the thing a reader of a settings screen most needs: a failed
    // read returns before touching a single field.
    expect(failed, 'the one reassurance this screen can actually back up was dropped')
      .toMatch(/Nothing has been changed\./)
    expect(failed, 'no way back').toMatch(/Button\("Retry"\)/)
  })
})

describe('the chat surface: a non-answer is not a theme', () => {
  const loadTheme = () => body(code(readFileSync(CHAT, 'utf8')), 'func loadTheme() async {')

  it('the degrade is refused before a single field is written', () => {
    const fn = loadTheme()
    const guardAt = fn.indexOf('TinyEditorLoad.readFailed(d)')
    expect(guardAt, 'loadTheme applies the route degrade as configuration again')
      .toBeGreaterThan(-1)
    expect(fn.slice(guardAt), 'the marker check no longer returns — it just falls through')
      .toMatch(/readFailed\(d\)\s*\{\s*return\s*\}/)
    // Every write it used to clobber, each one AFTER the guard. `cfg_accent_hex`
    // and the WatchBridge push are the two that leave the app: persistence read
    // by the watch and the widget snapshot.
    for (const write of [
      'isPrivate =', 'isAuthorized =', 'isOwner =', 'voice =',
      'ownerSystemPrompt =', 'ownerSystemKnowledge =', 'accent =',
      'heroURL =', 'logoURL =', 'introVibe =', 'customChips =', 'customTagline =',
      'cfg_accent_hex', 'WatchBridge.shared.sync', 'playIntroVibeIfNeeded()',
    ]) {
      const at = fn.indexOf(write)
      expect(at, `${write} vanished from loadTheme — this pin no longer watches it`)
        .toBeGreaterThan(-1)
      expect(at, `${write} runs before the degrade is refused`).toBeGreaterThan(guardAt)
    }
  })

  it('an error delivery still returns early too', () => {
    // ⚠️ `try?` is CORRECT here, unlike in the editor's load(): there is no
    // failure affordance on a theme, so both deliveries do the same honest
    // thing — keep what is already on screen. The editor SHOWS a reason; this
    // surface has nothing to say, and saying nothing is not the same as
    // repainting the tiny's identity in brand green.
    const fn = loadTheme()
    expect(fn, 'the fetch guard lost its early return; a thrown error now falls through')
      .toMatch(/guard let d: \[String: Any\] = try\? await Api\.post\("\/api\/tiny"[\s\S]*?else \{ return \}/)
    // The stale-response guard the theme has always had, still ahead of the writes.
    expect(fn, 'the tiny-switch guard is gone — a slow load repaints the tiny you left')
      .toMatch(/name == tiny else \{ return \}/)
  })
})

describe('/api/tiny: the three shapes a client has to tell apart', () => {
  const route = () => readFileSync(ROUTE, 'utf8')

  it('only the degrade is marked, and it is marked', () => {
    const src = code(route())
    const catchBlock = braced(src, src.indexOf('} catch (err) {'))
    expect(catchBlock, "the catch stopped saying it couldn't read")
      .toMatch(/unavailable:\s*true/)
    // Exactly once in the file: a marker on a real answer is worse than none.
    expect((src.match(/unavailable:\s*true/g) || []).length,
      'a second shape claims to be unavailable — then the marker means nothing')
      .toBe(1)
  })

  it('a tiny that does not exist is an ANSWER — unmarked', () => {
    const src = code(route())
    const notExists = braced(src, src.indexOf('if (isTinyNotExists(tiny)) {'))
    expect(notExists.length, 'the not-exists branch moved').toBeGreaterThan(40)
    expect(notExists, 'a mistyped name now offers a Retry that can never succeed')
      .not.toMatch(/unavailable/)
  })

  it('the success shape always carries isOwner — the premise of the whole read', () => {
    const src = code(route())
    // The final return, i.e. the one after the not-exists sentinel.
    const at = src.lastIndexOf('return new Response(JSON.stringify({', src.indexOf('} catch (err) {'))
    const ok = braced(src, at)
    expect(ok, 'the success shape stopped stating ownership; absence would read as false again')
      .toMatch(/isOwner,/)
    expect(ok, 'success must never be marked unavailable').not.toMatch(/unavailable/)
  })

  it('the degrade stays HTTP 200 — deliberately', () => {
    const src = route()
    const catchBlock = braced(src, src.indexOf('} catch (err) {'))
    // ⚠️ FAILS WHEN FIXED. The 200 is not laziness: components/chat/Control.tsx
    // reads `.then((res) => res.json())` with no `res.ok` check, so any non-2xx
    // body here is applied to the web form as config — blanking a live editor.
    // If Control.tsx learns to check, this pin fails, and the honest status
    // becomes available. That is the whole reason a flag exists instead.
    expect(catchBlock, 'the degrade grew a status — check Control.tsx first')
      .not.toMatch(/status:/)
    const control = readFileSync(join(ROOT, 'components/chat/Control.tsx'), 'utf8')
    const load = braced(control, control.indexOf(".then((res) => res.json())") - 400)
    expect(control, "🎉 Control.tsx may check res.ok now — /api/tiny's catch can stop lying with a 200")
      .not.toMatch(/res\.ok/)
    expect(load.length, 'the Control.tsx fetch moved; this pin no longer watches it')
      .toBeGreaterThan(40)
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 The phone read back 0% of its own recordings.
 *
 * `PhoneRecorder` files every take to `POST /api/devices/transcript` — the Record
 * button on the Voice panel, a wake word, the agent's `nicla_voice_record` envelope.
 * Nothing in the Android app ever asked for one back. Every other link in the chain
 * was whole: the worker stores up to 16KB, `/transcript/list` returns previews with
 * `chars`/`truncated`, `/transcript?id=` returns the full text, the app proxy
 * session-auths both halves, and the agent's `nicla_voice_transcript` tool reads
 * them. **The agent could quote a memo back that the phone which recorded it could
 * not show you**, and `Panels.kt` said so out loud for as long as the Record button
 * has existed.
 *
 * iOS's version of the bug (`73e11eb4`) is the subtler one this suite is mostly
 * about: it DID fetch the list, then stored the 200-char `preview` as the row's text.
 * A 120s memo is ~1700 characters, so a refreshed row showed ~12% of it and **looked
 * exactly like a complete short transcript — a cut preview and a short take are the
 * same pixels.**
 *
 * `TranscriptsLoadTest` (Kotlin) owns the pure rules — which answers are a list,
 * when a row is only a preview, the size line. This suite owns what a JVM test
 * cannot see: that the sheet is REACHABLE, that the ellipsis exists, that a row
 * hydrates itself, that a failed hydrate keeps its retry, that sharing sends only
 * what is on screen, and that the server contract the whole screen is built on
 * hasn't moved out from under it.
 */

const ROOT = process.cwd()
const SHEET = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/TranscriptsSheet.kt')
const MAIN = join(ROOT, 'android/app/src/main/java/technology/tiny/app/MainActivity.kt')
const WORKER = join(ROOT, 'worker/src/transcripts.ts')
const ROUTE = join(ROOT, 'app/api/devices/transcript/route.ts')

/** Comments stripped: a rule explained in prose must not satisfy a pin. */
const stripped = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
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

/** A block, with its anchor ASSERTED — an unfound anchor makes every `.not` pin vacuous. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

describe('Android reads its own transcripts back', () => {
  it('the sheet exists and is reachable from the menu', () => {
    // ⚠️ The whole gap in two pins. A sheet nothing mounts is the 0% state with extra
    // code in the tree, and this is exactly what `Panels.kt` was apologising for.
    const main = stripped(MAIN)
    expect(main, 'the Transcripts menu row is gone — takes are write-only again')
      .toMatch(/item\(Icons\.Outlined\.GraphicEq, "Transcripts"\) \{ vm\.openPanel = "transcripts" \}/)
    expect(main, 'nothing mounts the transcripts sheet, so the menu row opens nothing')
      .toMatch(/vm\.openPanel == "transcripts"/)
    expect(body(main, 'vm.openPanel == "transcripts"'), 'the mount stopped naming the sheet')
      .toMatch(/TranscriptsSheet\(app\)/)
  })

  it('it asks the server for the list, because there is no local index', () => {
    // The one deliberate divergence from iOS: iOS keeps index.json because it owns an
    // audio FILE per take, Android has none (SpeechRecognizer captures inside Google's
    // process). The server IS the list here — so the GET is the only source.
    const src = stripped(SHEET)
    expect(src, 'the list load is gone')
      .toMatch(/getJson\("\/api\/devices\/transcript\?limit=50"\)/)
    // 50 is the route's own clamp; asking for more silently gets 50 anyway.
    const route = readFileSync(ROUTE, 'utf8')
    expect(route, '🎉 the route clamp moved — recheck the limit this sheet asks for')
      .toMatch(/50/)
  })

  it('a refusal is never rendered as an empty archive', () => {
    // ⚠️ The failure arm must come FIRST in the `when`: a failed load leaves `rows`
    // null, so a spinner arm ahead of it spins forever on every 401/424/404.
    const src = stripped(SHEET)
    const chain = body(src, 'when {')
    const err = chain.indexOf('error != null')
    const spinner = chain.indexOf('rows == null')
    const empty = chain.indexOf('rows!!.isEmpty()')
    expect(err, 'the failure arm is gone').toBeGreaterThan(-1)
    expect(spinner, 're-anchor: the spinner arm moved').toBeGreaterThan(-1)
    expect(empty, 're-anchor: the empty arm moved').toBeGreaterThan(-1)
    expect(err, 'a refusal now falls through to the spinner — it never stops')
      .toBeLessThan(spinner)
    expect(spinner, 'a load in flight reads as an empty archive').toBeLessThan(empty)
    // And the failure arm carries a way out.
    expect(braced(chain, err), 'the failure arm lost its retry').toMatch(/reloadKey\+\+/)
  })

  it('a signed-out reader is told to sign in, not shown an empty archive', () => {
    // `rows` must stay NULL on this path, or the empty state claims the archive is
    // empty when nobody has even asked for it.
    const load = body(stripped(SHEET), 'LaunchedEffect(reloadKey)')
    expect(load, 'the signed-out arm is gone').toMatch(/app\.auth\.token == null/)
    const guard = load.indexOf('app.auth.token == null')
    const arm = braced(load, guard)
    expect(arm, 'the signed-out arm says nothing').toMatch(/error = "Sign in/)
    expect(arm, 'the signed-out arm sets rows, so the empty state becomes reachable')
      .not.toMatch(/rows =/)
  })

  it('a preview row shows an ellipsis — the only tell that words are missing', () => {
    // ⚠️ THE iOS BUG, and it is a rendering bug as much as a parsing one: 200 cut
    // characters and a genuinely short memo are the same pixels without this.
    const src = stripped(SHEET)
    expect(src, 'the ellipsis is gone — a cut preview reads as the whole take')
      .toMatch(/if \(partial\) \(full \?: t\.text\) \+ "…" else \(full \?: t\.text\)/)
    // `partial` must mean "still only a preview" — a row whose full text arrived has
    // nothing missing and must lose both the ellipsis and the button.
    expect(src, 'partial no longer accounts for a hydrated row')
      .toMatch(/val partial = t\.isPreview && full == null/)
  })

  it('a row pulls its own remaining words as it appears', () => {
    // One GET per transcript the reader actually looks at, rather than 50 on open —
    // and it is what makes the button below only ever a RETRY.
    const src = stripped(SHEET)
    expect(src, 'rows no longer hydrate themselves')
      .toMatch(/LaunchedEffect\(t\.id, reloadKey\) \{ if \(partial\) hydrate\(t\) \}/)
    const fn = body(src, 'fun hydrate(t: TranscriptRow)')
    expect(fn, 'hydrate stopped asking for the full text by id')
      .toMatch(/getJson\("\/api\/devices\/transcript\?id=\$\{t\.id\}"\)/)
    // ⚠️ At most one flight per id, and never a second for text already held: a row
    // scrolling off and back on must not re-fetch.
    expect(fn, 'hydrate can now run twice for the same row')
      .toMatch(/hydrating\.contains\(t\.id\) \|\| hydrated\.containsKey\(t\.id\)/)
    expect(fn, 'hydrate no longer refuses rows that are already whole')
      .toMatch(/!t\.isPreview/)
  })

  it('a hydrate that failed leaves the words that were already there', () => {
    // ⚠️ Two ways to make this worse than not hydrating at all: overwrite the visible
    // 200 characters with an empty string, or leave a spinner where the retry was.
    const fn = body(stripped(SHEET), 'fun hydrate(t: TranscriptRow)')
    expect(fn, 'a failed hydrate writes its result anyway and can blank the row')
      .toMatch(/TranscriptsLoad\.fullText\(res\)\?\.let \{ hydrated = hydrated \+ \(t\.id to it\) \}/)
    const clear = fn.indexOf('hydrating = hydrating - t.id')
    expect(clear, 'hydrating is never cleared — the spinner replaces the retry forever')
      .toBeGreaterThan(-1)
    // Cleared unconditionally, not inside the success branch.
    expect(fn.slice(clear - 40, clear), 'the clear moved inside the success arm')
      .not.toMatch(/\?\.let \{$/)
  })

  it('sharing sends what is on screen, and says when that is not all of it', () => {
    // ⚠️ Sharing `t.text` on a preview row hands someone 200 characters under the
    // take's own label, silently — a quote that is wrong about where it ends.
    const src = stripped(SHEET)
    // Anchored on the button, not on ACTION_SEND: brace-matching forward from the
    // intent lands inside `.apply { … }` and would pin a block that holds neither
    // line — a green-looking test of the wrong scope.
    expect((src.match(/IconButton\(/g) ?? []).length,
      're-anchor: the share button is no longer the only IconButton here').toBe(1)
    const share = body(src, 'IconButton(')
    expect(share, 're-anchor: the share block no longer builds the intent')
      .toMatch(/Intent\.ACTION_SEND/)
    expect(share, 'the share body no longer prefers the hydrated text')
      .toMatch(/val body = full \?: t\.text/)
    expect(share, 'a partial share no longer says it is partial')
      .toMatch(/if \(partial\) "…" else ""/)
  })

  it('a finished take reloads the list, since there is nothing local to append to', () => {
    // The divergence again, in the one place it changes behaviour: iOS can append the
    // take it just wrote to its own index. Android's take exists only on the server,
    // so without a reload the words someone just spoke are not on screen.
    const src = stripped(SHEET)
    // The `onClick`, not the record CALL: brace-matching from the call itself walks
    // forward into the button's content lambda, which holds the icon and neither of
    // the two lines below.
    expect((src.match(/OutlinedButton\(/g) ?? []).length,
      're-anchor: the record button is no longer the only OutlinedButton here').toBe(1)
    // From the button, whose first brace IS its `onClick` — rather than the bare
    // `onClick = {` that three other buttons on this screen also open with.
    const btn = body(src, 'OutlinedButton(')
    expect(btn, 're-anchor: the record onClick no longer takes a take')
      .toMatch(/PhoneRecorder\.record\(app/)
    expect(btn, 'a successful take no longer refreshes the list')
      .toMatch(/if \(take\.ok\) reloadKey\+\+/)
    // A failure must SAY so: a Record button that silently does nothing is the worst
    // version of a refusal (the mic can be held by a call, or the permission denied).
    // Pinned to the assignment AND to the sentence being rendered — setting a state
    // nothing draws is the silent button with extra steps.
    expect(btn, 'a failed take says nothing')
      .toMatch(/recordError = if \(take\.ok\) null else \(take\.error \?\: "Recording failed\."\)/)
    expect(src, 'the recording error is stored but never shown')
      .toMatch(/recordError\?\.let \{/)
  })

  it('the level meter is present, because a muted mic looks like a working one', () => {
    const src = stripped(SHEET)
    expect(src, 'the recording meter is gone').toMatch(/val lit = level \* 10 > i/)
    expect(src, 'the meter no longer reads the recorder')
      .toMatch(/PhoneRecorder\.level\.collectAsState\(\)/)
    expect(src, 'the button no longer reflects whether a take is running')
      .toMatch(/PhoneRecorder\.isRecording\.collectAsState\(\)/)
  })

  it('⚠️ FAILS WHEN FIXED: the server still sends a CUT preview plus a flag', () => {
    // Everything above rests on the list endpoint returning `substr(text, 1, 200)`
    // with `chars`/`truncated` beside it. If `/transcript/list` ever returns full
    // text, `isPreview` is dead weight and the ellipsis/hydrate/retry rail should go
    // — this fails rather than sitting here unexplained.
    const worker = readFileSync(WORKER, 'utf8')
    expect(worker, '🎉 the list endpoint stopped cutting the preview — drop the hydrate rail')
      .toMatch(/substr\(text, 1, \$\{TRANSCRIPT_PREVIEW_CHARS\}\) AS preview/)
    expect(worker, '🎉 the preview length changed — recheck TranscriptsLoad.previewChars')
      .toMatch(/TRANSCRIPT_PREVIEW_CHARS = 200/)
    expect(worker, '🎉 `truncated` is gone — the flag this screen trusts')
      .toMatch(/length\(text\) > \$\{TRANSCRIPT_PREVIEW_CHARS\} AS truncated/)
    // Kotlin's copy of the constant must agree with the server's.
    expect(stripped(SHEET), 'the client and server disagree about where the cut is')
      .toMatch(/const val previewChars = 200/)
    // ⚠️ And the SQLite tolerance: the worker normalizes 0/1 with `!!r.truncated`
    // today. `TranscriptsLoad.truncated` deliberately does not depend on that, because
    // `JSONObject.optBoolean` would answer `false` for the number 1.
    expect(worker, '🎉 the worker stopped normalizing truncated — the client still copes')
      .toMatch(/truncated: !!r\.truncated/)
    expect(stripped(SHEET), 'the client trusts optBoolean again — a raw 0/1 marks every row complete')
      .not.toMatch(/optBoolean\("truncated"/)
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ✒️ Every speech request in the app asks for punctuation.
 *
 * `SFSpeechRecognitionRequest.addsPunctuation` defaults to FALSE, so a
 * recognizer built without it returns one unbroken run-on. That is a formatting
 * detail on a screen and something worse everywhere text leaves the phone: every
 * one of these transcripts is read by the agent — as a chat message, a tool
 * result, or a transcript row in its context — and NiclaRecorder already says why
 * at the one site that had thought about it:
 *
 *   "A take here is up to 10s of unprompted speech that a model reads later …
 *    it needs sentence boundaries to stay legible. Without this a wake-triggered
 *    transcript arrives as one unpunctuated run-on."
 *
 * HALF the rails were missing it, and the shape of the miss is what makes this a
 * derived roster rather than a spot-check:
 *
 *   - `GlassesListener.listen(seconds:)` has TWO rails. If the live card is
 *     already transcribing it rides that transcriber and returns the delta;
 *     otherwise it stands up its own in `listenOnce`. Same agent tool, same
 *     `postResult`, and the punctuation depended on whether the user happened
 *     to have a card open.
 *   - `VoiceMode.beginSession()` is the fallback rail behind the iOS 26
 *     SpeechAnalyzer path, and every caller of `toggle(onUtterance:)` does
 *     `chat.send(text, token:)` — the utterance IS a message to the agent.
 *
 * So the sites are found by grepping for the constructor, not listed here:
 * a new recognition path must not be able to join the app unregistered. That is
 * the same reason the SF Symbol roster and the event-glyph roster are derived —
 * a hand-kept list is exactly what missed these three.
 *
 * Not covered, deliberately: `VoiceAnalyzer`'s `SpeechTranscriber` (iOS 26+)
 * has no equivalent switch — it is the system dictation engine and punctuates
 * on its own. The pin below is on the SFSpeech rails, which are what the
 * analyzer degrades to.
 */

const ROOT = process.cwd()
/** App source roots. `ios/build` is derived output and must not be scanned. */
const SRC_DIRS = [
  'ios/Tiny/Sources', 'ios/Shared', 'ios/TinyWatch/Sources',
  'ios/TinyWidgets/Sources', 'ios/TinyWatchWidgets/Sources',
]

function swiftFiles(): string[] {
  const out: string[] = []
  for (const d of SRC_DIRS) {
    let names: string[]
    try { names = readdirSync(join(ROOT, d)) } catch { continue }
    for (const n of names) if (n.endsWith('.swift')) out.push(join(d, n))
  }
  return out.sort()
}

interface Site { file: string; line: number; variable: string; region: string }

/**
 * Every `SFSpeech*RecognitionRequest(...)` construction, with the text from it
 * to the NEXT construction in the same file (or EOF).
 *
 * The region is bounded by the next site rather than by a byte count on purpose
 * — a fixed window is a guess about how long the code will stay, and four
 * assertions in ios-live-transcribe.test.ts once broke at once because a
 * comment grew past one. A request is configured immediately after it is built,
 * so "up to the next request" is the honest boundary.
 */
function requestSites(): Site[] {
  const sites: Site[] = []
  for (const file of swiftFiles()) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const re = /let (\w+) = SFSpeech\w*RecognitionRequest\(/g
    const found: { at: number; variable: string }[] = []
    for (let m = re.exec(src); m; m = re.exec(src)) {
      found.push({ at: m.index, variable: m[1] })
    }
    found.forEach(({ at, variable }, i) => {
      const end = i + 1 < found.length ? found[i + 1].at : src.length
      sites.push({
        file, variable, region: src.slice(at, end),
        line: src.slice(0, at).split('\n').length,
      })
    })
  }
  return sites
}

const SITES = requestSites()

describe('iOS speech requests — punctuation and on-device, on every rail', () => {
  it('finds the recognition sites at all (a zero-length roster proves nothing)', () => {
    // Without this the suite passes vacuously the day the constructor is renamed
    // or the source moves — green, and pinning nothing. Both numbers are MEASURED
    // in this tree (six requests across four files) rather than copied from a
    // sibling client, and they are floors with exactly one job: refuse a scrape
    // that found nothing. A seventh rail must RAISE this, never be excused by it.
    expect(SITES.length).toBeGreaterThanOrEqual(6)
    expect(new Set(SITES.map(s => s.file)).size).toBeGreaterThanOrEqual(4)
  })

  it.each(SITES.map(s => [`${s.file}:${s.line}`, s] as const))(
    '%s asks for punctuation', (_where, site) => {
      expect(
        site.region,
        `${site.file}:${site.line} builds a speech request without ` +
        `${site.variable}.addsPunctuation = true — this text is read by the agent`,
      ).toMatch(new RegExp(`${site.variable}\\.addsPunctuation = true`))
    })

  it.each(SITES.map(s => [`${s.file}:${s.line}`, s] as const))(
    '%s keeps recognition on the phone', (_where, site) => {
      // The privacy property that travels with these requests: an open mic in
      // someone's home must not become a stream of household audio to a server.
      // Spelled differently per site (unconditional vs. gated on
      // supportsOnDeviceRecognition), so only the property is pinned.
      expect(
        site.region,
        `${site.file}:${site.line} never sets ${site.variable}.requiresOnDeviceRecognition`,
      ).toMatch(new RegExp(`${site.variable}\\.requiresOnDeviceRecognition`))
    })
})

describe("the two rails that made this a bug, not a typo", () => {
  const live = readFileSync(join(ROOT, 'ios/Tiny/Sources/WearablesLive.swift'), 'utf8')
  const voice = readFileSync(join(ROOT, 'ios/Tiny/Sources/Voice.swift'), 'utf8')
  const views = readFileSync(join(ROOT, 'ios/Tiny/Sources/Views.swift'), 'utf8')

  it('the glasses listener still has two rails, so they still have to agree', () => {
    // If this stops being true the reasoning above is stale — but the roster
    // check keeps holding either way, which is the point of deriving it.
    const listen = live.slice(live.indexOf('func listen(seconds: Int) async'))
    const body = listen.slice(0, listen.indexOf('\n    }\n'))
    expect(body).toMatch(/GlassesLive\.shared\.transcribing/)   // ride-along rail
    expect(body).toMatch(/GlassesLive\.shared\.transcript/)     // …returns its delta
    expect(body).toMatch(/return await listenOnce\(seconds: clamped\)/) // own rail
    // Both answers are shaped as the same tool result and go back to the agent.
    expect(body).toMatch(/"transcript":/)
    expect(live).toMatch(/func listenOnce\(seconds: Int\) async/)
    expect(live.slice(live.indexOf('func listenOnce(seconds: Int) async')))
      .toMatch(/"transcript": heard/)
  })

  it("a dictated utterance is a message to the agent, not a preview", () => {
    // This is why partial-results does not excuse skipping punctuation: what the
    // silence watcher emits is final, and it is sent.
    expect(voice).toMatch(/self\.onUtterance\?\(text\)/)
    expect(views).toMatch(/voice\.toggle \{ text in chat\.send\(text, token: session\.token\) \}/)
  })

  it('the SFSpeech rail is what the analyzer degrades to', () => {
    // beginAnalyzerSession's catch hands the session to beginSession, so these
    // two engines alternate for one user on one phone. Formatting that differs
    // between them shows up as the agent reading the same person two ways.
    const analyzer = voice.slice(voice.indexOf('private func beginAnalyzerSession()'))
    expect(analyzer.slice(0, analyzer.indexOf('\n    private func endAnalyzerSession')))
      .toMatch(/self\.beginSession\(\)/)
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The discovery whose failure costs the fast path, not a sentence.
 *
 * `discoverViaRelay` asks the necklace `stream` and reads a LAN base out of the
 * reply. It is the ONLY thing that can upgrade a session from ~2fps cloud polling
 * to the board's ~16fps MJPEG when the cached base is empty — a fresh install,
 * or any time a probe dropped it. So every way it silently returns nil is a
 * session that streamed at 2fps with the necklace one hop away: the
 * "connecting through the cloud but i'm at the same wifi" report.
 *
 * It was the last hand-rolled relay round trip in the file and it repeated every
 * defect the other two had already been fixed for:
 *
 *   - `try? await Api.post` on the send, then 32s of polling for a reply to a
 *     message nobody accepted;
 *   - `else { continue }` on the poll, so a TERMINAL 401 burned the whole budget;
 *   - no cache policy on a GET whose URL is constant and whose body is
 *     `{reply: null}` until the board answers — eight reads of one cached "not
 *     yet";
 *   - `obj["result"] as? String` after a plain `jsonObject`, so a payload that
 *     is not a JSON object was dropped WITH THE ADDRESS IN IT. The server's own
 *     reader (`lib/chat/tools/nicla.ts`) proves that shape is real.
 *
 * The address extraction itself is tested in Swift (`StreamAddressTests`, 6 tests
 * through `TinyLive.lanBase`). These pins cover the `async` loop around it, which
 * lives on a `@MainActor` view and so is reachable only in the source.
 *
 * ⚠️ Comments stripped before every scan — the new doc quotes `try?`,
 * `else { continue }` and `obj["result"]` verbatim while explaining their removal.
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

const live = () => raw('ios/Tiny/Sources/TinyLive.swift')
const discover = () =>
  between(live(), 'private func discoverViaRelay(deviceId:',
          '// ---- streams', 'discoverViaRelay')

describe('LAN discovery loses the fast path for no silent reason', () => {
  it('a refused send is not waited out', () => {
    const body = discover()
    // do/catch, not `try?`: the SEND either happened or it did not, and 32s of
    // polling cannot make a message nobody accepted come back answered.
    expect(body, 'the send swallows its failure again').not.toMatch(/try\?\s+await\s+Api\.post/)
    expect(body, 'the send is no longer a do/catch').toMatch(/do \{\s*\n\s*sent = try await Api\.post/)
    // An id-less 200 is the same dead end and must not enter the loop either.
    expect(body, 'an empty message id would still be polled for')
      .toMatch(/guard let msgId = sent\["id"\] as\? String, !msgId\.isEmpty else \{ return nil \}/)
  })

  it('the poll is the shared one, so it inherits the cache rule and the refusal', () => {
    const body = discover()
    expect(body, 'the poll went back to a hand-rolled read').toContain('await RelayPoll.read(inReplyTo: query, token: token)')
    // The three shapes the old `guard let … else { continue }` chain was built
    // from. Any of them here means a second reader that can drift from RelayPoll.
    for (const gone of [/r\["reply"\]/, /JSONSerialization/, /obj\["result"\]/, /cachePolicy/]) {
      expect(body, `discoverViaRelay re-derives the poll (${gone})`).not.toMatch(gone)
    }
  })

  it('a terminal refusal ends the wait instead of spending it', () => {
    // 401 does not stop being a 401 four seconds later. `isTerminal` is the same
    // helper both other round trips ask.
    expect(discover(), 'a lapsed session is polled for the full budget again')
      .toMatch(/case \.unreadable\(_, let status\):\s*\n\s*if RelayPoll\.isTerminal\(status: status\) \{ return nil \}/)
  })

  it('the payload is read by the one reader for this wire', () => {
    // `RelayReply.text` handles the bare-string payload the old reader dropped —
    // and the address was IN it.
    expect(discover(), 'the payload reader narrowed again')
      .toContain('return Self.lanBase(in: RelayReply.text(payload))')
  })

  it('a closed view stops polling', () => {
    // Eight more relay GETs answering a question nobody is asking — and `mode`
    // because remoteLoop may already have upgraded us.
    expect(discover(), 'the loop no longer checks whether anyone is still watching')
      .toMatch(/guard running, mode == \.remote else \{ return nil \}/)
  })

  it('the budget is named, and the loop spends the named one', () => {
    const src = strip(live())
    expect(src, 'the stream poll budget went back to bare literals')
      .toMatch(/private static let streamPollTries = \d+\n\s*private static let streamPollEvery = [\d.]+/)
    const body = discover()
    expect(body, 'the loop stopped using the named tries').toContain('for _ in 0 ..< Self.streamPollTries')
    expect(body, 'the loop stopped using the named interval').toContain('.seconds(Self.streamPollEvery)')
  })

  it('the extractor stays where a test can call it', () => {
    // Dropping `nonisolated` is a WARNING, not an error, so `StreamAddressTests`
    // would keep compiling while every call hopped the main actor — six tests
    // proving a different function.
    expect(strip(live()), 'lanBase left the nonisolated island — StreamAddressTests can no longer call it')
      .toMatch(/nonisolated static func lanBase\(/)
  })

  /**
   * Cross-surface: the SAME board answers BOTH clients, so the two extractors
   * must agree character for character. Android's `discoverBase` is read-only
   * here — a divergence is reported, not fixed, because that file belongs to the
   * Android loop.
   */
  it('iOS and Android lift the address out with the identical pattern', () => {
    const swift = strip(live()).match(/#"(http:\/\/\[0-9\.\]\+:\\d\+)"#/)
    expect(swift?.[1], 'the Swift LAN-base regex moved or changed — re-check the Kotlin twin').toBeTruthy()
    const kt = strip(raw('android/app/src/main/java/technology/tiny/app/fleet/TinyLive.kt'))
      .match(/Regex\("(http:\/\/\[0-9\.\]\+:\\\\d\+)"\)/)
    expect(kt?.[1], 'Android stopped matching a LAN base this way — re-check both').toBeTruthy()
    // Kotlin doubles the backslash for the string literal; the PATTERN is the
    // thing that has to match.
    expect(swift![1], 'the two clients read the board’s address differently now')
      .toBe(kt![1].replace(/\\\\/g, '\\'))
  })
})

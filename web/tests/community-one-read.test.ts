// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 The iPad sidebar's universe section said "Couldn't load".
 *
 * Two words, for four different situations, next to a Retry that fixes some of
 * them and not others. It had nothing better to say because it never asked:
 * `let (data, _) = try await URLSession.shared.data(for: req)` discarded the
 * HTTP response, so a worker 500, a stale build's plain-text 404, an offline
 * radio and a 200 whose body simply lacked `users` all arrived
 * indistinguishable — and two separate `state = .failed("Couldn't load")` lines
 * collapsed them into one string.
 *
 * `UniverseView` reads the SAME url, decodes the SAME `users` into the SAME
 * `UniverseUser`, and has said something true since `d71b1ff3`. The sidebar was
 * a hand copy that never got the lesson — and that is the finding, not the two
 * words: `d71b1ff3`'s subject line says "three panels", counted by hand, so it
 * reached exactly the sites someone remembered. A fourth existed one file over.
 *
 * So the fix is not a better string. There is now ONE read (`CommunityFeed`),
 * and this suite's first test is the one that matters: the url may appear only
 * once in the whole app. A future copy has to retype the request, the status
 * gate and both filters before it can go wrong again — and it would fail here
 * first.
 *
 * `CommunityFeedTests` (Swift) owns the decode rules; this owns the wiring.
 */

const ROOT = process.cwd()
const SRC = join(ROOT, 'ios/Tiny/Sources')
const PANELS = join(SRC, 'Panels.swift')
const SPLIT = join(SRC, 'Split.swift')

/** Comments stripped — the prose in BOTH files quotes the very strings pinned
 *  as absent below ("Couldn't load", `let (data, _)`), so an unstripped read
 *  would fail on the explanation instead of the code. */
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

/** A block with its anchor ASSERTED — an unfound anchor makes `slice` return
 *  one character, on which every `.not.toMatch()` passes forever. */
function body(source: string, signature: string, from = 0): string {
  const at = source.indexOf(signature, from)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

const swiftFiles = () =>
  readdirSync(SRC).filter((f) => f.endsWith('.swift')).map((f) => join(SRC, f))

describe('one endpoint, one read', () => {
  it('the community url exists exactly once in the app', () => {
    const hits = swiftFiles().filter((f) =>
      code(readFileSync(f, 'utf8')).includes('plugin.tiny.technology/community'))
    // ⚠️ THE pin of this increment. Two callers of one endpoint is how a fix to
    // one of them silently misses the other; `d71b1ff3` fixed three panels by
    // hand and this was the fourth. If this fails, a copy came back — give it
    // `CommunityFeed.load()` instead of its own URLRequest.
    expect(hits.map((f) => f.split('/').pop()),
      'the community read was copied again — the sidebar defect is back in a new file')
      .toEqual(['Panels.swift'])
    const panels = code(readFileSync(PANELS, 'utf8'))
    expect((panels.match(/plugin\.tiny\.technology\/community/g) || []).length,
      'two literals in Panels.swift too')
      .toBe(1)
    expect(body(panels, 'enum CommunityFeed {'),
      'the url moved out of CommunityFeed — then `static let url` is not the one read')
      .toMatch(/static let url = "https:\/\/plugin\.tiny\.technology\/community\?limit=50"/)
  })

  it('the shared read asks for the status it used to discard', () => {
    const load = body(code(readFileSync(PANELS, 'utf8')), 'static func load() async throws -> Feed {')
    expect(load, 'the response is discarded again — nothing downstream can name a cause')
      .not.toMatch(/\(\s*data\s*,\s*_\s*\)\s*=\s*try await/)
    // `?? 0`, not `?? 200`: 0 is the house code for "nothing arrived"
    // (`friendlyHTTPError(0)` → "No response — check your connection"), so a
    // response that isn't an HTTPURLResponse fails closed instead of being
    // waved through the gate below as a success.
    expect(load, 'the status is not read, or a non-HTTP response defaults to success')
      .toMatch(/\(resp as\? HTTPURLResponse\)\?\.statusCode \?\? 0/)
    expect(load, 'the non-2xx gate is gone — a 500 body reads as an empty universe')
      .toMatch(/guard \(200\.\.\.299\)\.contains\(code\) else \{[\s\S]*?throw ApiError\.http\(code, Api\.serverError\(in: data\)\)/)
    // Api.serverError trims and bounds to 300 chars; the hand-rolled
    // `obj["error"]` read this replaced would paste a stack trace into a label.
    expect(load, 'back to a hand-rolled error read — unbounded text into a label')
      .not.toMatch(/\$0\["error"\]|obj\["error"\]/)
    expect(load, 'a body that is not JSON must not become an empty universe')
      .toMatch(/throw ApiError\.badResponse/)
    expect(load, 'the 20s bound is gone — a half-open connection spins forever')
      .toMatch(/timeoutInterval = 20/)
  })

  it('a missing users key is unreadable, not empty', () => {
    const decode = body(code(readFileSync(PANELS, 'utf8')), 'static func decode(')
    expect(decode, 'no users key now decodes to zero builders — "No tinys yet" on a body nobody read')
      .toMatch(/guard let rawUsers = obj\["users"\] as\? \[\[String: Any\]\] else \{ throw ApiError\.badResponse \}/)
    // Both silent filters live here and are unit-pinned in CommunityFeedTests.
    for (const rule of ['guard !tinys.isEmpty else { return nil }', 'n.isFinite, n > 0, n <= 1']) {
      expect(decode, `${rule} left decode — CommunityFeedTests no longer covers the real code`)
        .toContain(rule)
    }
  })
})

describe('the sidebar: the fourth panel finally names a cause', () => {
  const sidebarLoad = () => {
    const src = code(readFileSync(SPLIT, 'utf8'))
    return body(src, 'private func load() async {', src.indexOf('struct SidebarView'))
  }

  it('it stops saying two words for four causes', () => {
    const load = sidebarLoad()
    expect(load, 'the contentless string is back on the sidebar')
      .not.toMatch(/Couldn't load"/)
    expect(load, 'the sidebar reads the wire itself again')
      .not.toMatch(/URLSession|JSONSerialization|URLRequest/)
    expect(load, 'it no longer uses the shared read')
      .toMatch(/CommunityFeed\.load\(\)\.users/)
    expect(load, 'the failure lost its reason — this is the whole increment')
      .toMatch(/state = \.failed\(LoadFailure\.contentMessage\(error\)\)/)
    // ⚠️ `message` is the CHAT table: it words 404 as "That tiny doesn't exist",
    // which for a list of BUILDERS is a confident answer about a thing that is
    // not a tiny. That distinction is the only reason contentMessage exists.
    expect(load, 'the sidebar reaches for the chat table')
      .not.toMatch(/LoadFailure\.message\(/)
  })

  it('the sentence it now has room to say is allowed to wrap', () => {
    const src = code(readFileSync(SPLIT, 'utf8'))
    const failed = src.slice(src.indexOf('case .failed(let e):', src.indexOf('struct SidebarView')))
    const row = failed.slice(0, failed.indexOf('case .loaded:'))
    expect(row.length, 'the .failed row moved; this pin no longer watches it').toBeGreaterThan(40)
    // A caption is only an improvement over "Couldn't load" if it survives a
    // narrow sidebar. One line of a truncated sentence is worse than two words.
    expect(row, 'the caption can truncate in a narrow sidebar')
      .toMatch(/Text\(e\)[\s\S]*?\.fixedSize\(horizontal: false, vertical: true\)/)
    expect(row, 'no way back').toMatch(/Button\("Retry"\)/)
    // Retry must re-enter .loading, or a second failure looks like a no-op.
    expect(row, 'Retry no longer shows it is doing anything')
      .toMatch(/state = \.loading/)
  })
})

describe('the drawer keeps every sentence it already had', () => {
  // The unification must be invisible on the surface d71b1ff3 fixed: same four
  // outcomes, same strings. What changed is only that a second view can no
  // longer answer differently — and that the server's words are now bounded.
  it('UniverseView binds all four fields through the shared read', () => {
    const src = code(readFileSync(PANELS, 'utf8'))
    const load = body(src, 'private func load() async {', src.indexOf('struct UniverseView'))
    expect(load, 'the drawer stopped using the shared read')
      .toMatch(/let feed = try await CommunityFeed\.load\(\)/)
    for (const bind of ['users = feed.users', 'trust = feed.trust',
      'totalMessages = feed.totalMessages', 'totalPublicTinys = feed.totalPublicTinys']) {
      expect(load, `${bind} was dropped — the drawer silently lost a field in the refactor`)
        .toContain(bind)
    }
    expect(load, 'the drawer must reach .loaded').toMatch(/state = \.loaded/)
    expect(load, 'the drawer lost its reason').toMatch(/LoadFailure\.contentMessage\(error\)/)
  })
})

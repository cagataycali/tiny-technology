/**
 * The fan-out tree, across all three clients.
 *
 * 🏷️ THE DEFECT: iOS's `spawn_agents` result branch read `content[].text`. The
 * tool returns an OBJECT, so the SDK wraps it as `[{json:{…}}]` and
 * `serializeToolContent` keeps the block shape — it only calls toJSON(), it
 * never converts json to text. So the branch matched NOTHING: `.spawnResults`
 * was never emitted, and every parallel batch showed a "running" spinner
 * forever with the results already decoded and in hand.
 *
 * Android's decoder had the bug written down in a comment the whole time
 * ("iOS reads `text`, but this server emits `json`"). A note about another
 * client's bug is not a report of it, and this suite is the thing that would
 * have failed instead.
 *
 * Layered on top: `ok: Bool?` alone cannot say what a silent node means. `nil`
 * means four different things depending on how the BATCH ended, and three of
 * them are not failure — so the old code's blanket "unreported ⇒ ok = false"
 * sweep drew a background batch that had launched successfully as N failures.
 *
 * A Swift test can prove the truth table. It CANNOT prove the decoder asks the
 * right key, or that the three clients still agree — those are source-level
 * properties, and this is where they live.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/** Source with comments stripped — mandatory here, because both fixed files
 *  quote the old buggy read in their own prose to explain it. A naive grep for
 *  `["text"]` finds the explanation and calls the bug present. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

/** The body of `name`'s brace-balanced block, from its declaration line. */
function braced(src: string, name: string): string {
  const at = src.indexOf(name)
  if (at < 0) throw new Error(`not found: ${name}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced: ${name}`)
}

const DECODER = 'ios/Tiny/Sources/ChatStreamDecoder.swift'
const TREE = 'ios/Tiny/Sources/TaskTree.swift'
const ROUTE = 'app/api/chat/route.ts'
const HELPERS = 'lib/chat/helpers.ts'
const KOTLIN = 'android/app/src/main/java/technology/tiny/app/net/TinyApi.kt'
const WEB = 'components/chat/TaskTree.tsx'

// ── the premises this whole fix rests on ──────────────────────────────────
// If any of these change server-side, the clients are wrong again and it is
// this block that must say so first.

describe('what the server actually sends', () => {
  const route = read(ROUTE)

  it('the sync path returns an object with results — never a bare array', () => {
    // `[{json:…}]` wrapping happens because the RETURN is an object. A bare
            // array return would arrive differently and `apply` could not read it.
    expect(route).toMatch(/return \{\s*\n\s*ok: results\.some/)
    expect(route).toMatch(/elapsed_ms: elapsedMs/)
    expect(route).toMatch(/\n\s*results,\n/)
  })

  it('wait:false returns pending:true and NO results, ever, on this stream', () => {
    const bg = route.slice(route.indexOf('input.wait === false'))
    expect(bg).toMatch(/ok: true, pending: true, batch_id: ticket, tasks: input\.tasks\.length/)
    // The absence is the point: the old client read it as a total wipeout.
    // Keys, not the raw text — the `note` prose legitimately says "results are
    // redeemable with use_device", and a word-boundary grep calls that a field.
    const ret = braced(bg, 'return')
    expect(ret).not.toMatch(/^\s*results[,:]/m)
    expect(ret).not.toMatch(/elapsed_ms\s*:/)
    // …and the field it DOES carry instead, which is how the results are got.
    expect(ret).toMatch(/batch_id: ticket/)
  })

  it('serializeToolContent keeps the block shape — json never becomes text', () => {
    const fn = braced(read(HELPERS), 'export function serializeToolContent')
    expect(fn).toMatch(/toJSON\(\)/)
    // No stringify, no text coercion. This is why asking for `text` found
    // nothing, and why no server-side change can rescue a client that does.
    expect(fn).not.toMatch(/JSON\.stringify/)
    expect(fn).not.toMatch(/text/)
  })
})

// ── iOS: the decoder asks the right key ───────────────────────────────────

describe('the iOS decoder reads the block the server sends', () => {
  const src = code(DECODER)
  const branch = src.slice(src.indexOf('case "spawn_agents":'))
    .slice(0, src.slice(src.indexOf('case "spawn_agents":')).indexOf('case "pay_x402"'))

  it('delegates to firstToolJson, which handles json AND a JSON text string', () => {
    expect(branch).toContain('firstToolJson(tr["content"])')
    // 🏷️ THE BUG, byte for byte. It cannot come back without failing here.
    expect(branch).not.toMatch(/compactMap.*\["text"\]/)
    expect(branch).not.toMatch(/\$0\["text"\] as\? String/)
  })

  it('firstToolJson prefers json, then parses a text block as JSON', () => {
    const fn = braced(code('ios/Tiny/Sources/Api.swift'), 'func firstToolJson')
    expect(fn.indexOf('b["json"]')).toBeLessThan(fn.indexOf('b["text"]'))
    expect(fn).toContain('jsonObject(with: d) as? [String: Any]')
  })

  it('emits the event even when nothing is readable — silence was the defect', () => {
    // The empty string is a terminal answer the tree can act on. No event at
    // all is what left the spinner running.
    expect(branch).toContain('resultsJson: payload.map { Self.jsonString($0) } ?? ""')
    // No early exit of any shape — every one of them restores the silence.
    expect(branch).not.toMatch(/guard let payload[\s\S]*?else \{ break \}/)
    expect(branch).not.toMatch(/payload == nil/)
  })

  it('is still keyed by toolUseId, so an unnamed result finds its tree', () => {
    expect(branch).toContain('tr["toolUseId"] as? String')
    expect(code(DECODER)).toContain('toolNames.resolve(name: tr["name"], id: tr["toolUseId"])')
  })
})

// ── iOS: what a silent node means ─────────────────────────────────────────

describe('a silent node reads by how the batch ended', () => {
  const src = code(TREE)

  it('the four outcomes exist and are persisted as strings', () => {
    const e = braced(src, 'enum Outcome')
    for (const c of ['case live', 'case background', 'case settled', 'case aborted']) {
      expect(e).toContain(c)
    }
    expect(src).toContain('enum Outcome: String, Equatable, Codable')
  })

  it('the truth table is pure, so it is testable without a screenshot', () => {
    const fn = braced(src, 'static func state(ok: Bool?, outcome: Outcome)')
    expect(fn).toMatch(/if let ok \{ return ok \? \.succeeded : \.failed \}/)
    expect(fn).toMatch(/case \.live: return \.running/)
    expect(fn).toMatch(/case \.background: return \.queued/)
    expect(fn).toMatch(/case \.settled, \.aborted: return \.didNotRun/)
    // The one collapse that puts the bug back: a batch that simply didn't
    // report a task is not a task that failed.
    expect(fn).not.toMatch(/case \.settled[^\n]*return \.failed/)
  })

  it('apply no longer sweeps unreported nodes into failure', () => {
    const fn = braced(src, 'mutating func apply(resultsJson: String)')
    // 🏷️ The deleted line, verbatim. "3 agents failed" about 3 agents that
    // were all still working.
    expect(fn).not.toMatch(/for i in nodes\.indices where nodes\[i\]\.ok == nil/)
    expect(fn).not.toMatch(/nodes\[i\]\.ok = false/)
  })

  it('a malformed payload ends the batch instead of doing nothing', () => {
    const fn = braced(src, 'mutating func apply(resultsJson: String)')
    const guardBody = fn.slice(fn.indexOf('guard let data'), fn.indexOf('pending'))
    expect(guardBody).toContain('outcome = .aborted')
    // It used to be a bare `return`: the tree stayed `.live` with every node
    // nil, which is a spinner with nothing behind it. A test named
    // `malformedJsonIsNoop` asserted exactly that and passed.
    expect(guardBody).not.toMatch(/\{\s*return\s*\}/)
  })

  it('pending is read before results, and returns without timing anything', () => {
    const fn = braced(src, 'mutating func apply(resultsJson: String)')
    expect(fn).toMatch(/if \(obj\["pending"\] as\? Bool\) == true \{\s*outcome = \.background\s*return/)
    expect(fn.indexOf('obj["pending"]')).toBeLessThan(fn.indexOf('elapsed_ms'))
  })

  it('a results array settles the batch', () => {
    const fn = braced(src, 'mutating func apply(resultsJson: String)')
    expect(fn.trimEnd()).toMatch(/outcome = \.settled\s*\}$/)
  })

  it('old persisted history decodes as settled, NOT live', () => {
    // A restored tree's stream is gone: `.live` there is a spinner that spins
    // until the app is killed, in a chat the user only scrolled back to.
    const init = braced(src, 'init(from decoder: Decoder)')
    expect(init).toContain('decodeIfPresent(Outcome.self, forKey: .outcome) ?? .settled')
    expect(init).not.toMatch(/\?\? \.live/)
  })
})

// ── iOS: what the card says ───────────────────────────────────────────────

describe('the card stops claiming to work', () => {
  const src = code(TREE)

  it('running requires the batch to be live', () => {
    expect(src).toMatch(/private var running: Bool \{ item\.outcome == \.live && item\.nodes\.contains \{ \$0\.ok == nil \} \}/)
  })

  it('the summary does not score a batch that has not been played', () => {
    const s = braced(src, 'private var summary: String?')
    expect(s).toMatch(/case \.live: return nil/)
    expect(s).toMatch(/case \.background: return "running in the background"/)
    expect(s).toMatch(/case \.aborted: return "ended without reporting"/)
    // okCount is only reachable under .settled.
    expect(s.indexOf('case .settled')).toBeLessThan(s.indexOf('okCount'))
  })

  it('the five states each get their own glyph', () => {
    const icon = braced(src, 'private var statusIcon: some View')
    for (const c of ['case .running', 'case .queued', 'case .succeeded', 'case .failed', 'case .didNotRun']) {
      expect(icon).toContain(c)
    }
    // queued is a dot, not a spinner: nothing is happening on this screen and
    // the update arrives by push.
    expect(icon).toMatch(/case \.queued:[\s\S]*?Text\("·"\)/)
    // didNotRun is the dimmed ✗ — the app is not claiming this one ran and broke.
    expect(icon).toMatch(/case \.didNotRun:[\s\S]*?Color\.red\.opacity\(0\.55\)/)
  })

  it('the machine glyph is gone from a human surface', () => {
    // 🤖 read aloud as "robot face" mid-status-line, and the house rule is SF
    // Symbols (web renders IconCpu).
    expect(src).not.toContain('🤖')
    expect(src).toContain('Image(systemName: "cpu")')
  })
})

// ── iOS: VoiceOver ────────────────────────────────────────────────────────

describe('VoiceOver hears the outcome, not just the prompt', () => {
  const src = code(TREE)

  it('every state has distinct spoken words, and they live on the state', () => {
    const s = braced(src, 'var spoken: String')
    for (const w of ['"running"', '"queued"', '"succeeded"', '"failed"', '"didn\'t run"']) {
      expect(s).toContain(w)
    }
    // didNotRun and failed SHARE a glyph, so the words are the only thing
    // separating them for a screen-reader user.
    expect(src).toContain('enum SpawnState: Equatable, CaseIterable')
  })

  it('the row speaks its state and hides the decorative rail', () => {
    const row = code(TREE).slice(code(TREE).indexOf('private struct SpawnNodeRow'))
    expect(row).toContain('.accessibilityLabel("#\\(node.id) \\(node.prompt), \\(state.spoken)")')
    // The box-drawing character was announced before every prompt.
    expect(row).toMatch(/Text\(isLast \? "└" : "├"\)[\s\S]*?\.accessibilityHidden\(true\)/)
  })
})

// ── the other two clients ─────────────────────────────────────────────────

describe('the three clients agree', () => {
  it('Android reads json first, then text — the shape iOS now matches', () => {
    const k = read(KOTLIN)
    const region = k.slice(k.indexOf('"afterToolCallEvent"'), k.indexOf('"modelMetadataEvent"'))
    expect(region.indexOf('optJSONObject("json")')).toBeLessThan(region.indexOf('optString("text")'))
  })

  /**
   * ⚠️ NOT a grep for the stale comment. There was one here, and it failed
   * within a minute of being written — because the rewritten comment QUOTES the
   * old sentence to explain the history, so a prose-grep finds the explanation
   * and calls the claim live. Any such test punishes whoever documents the fix.
   * The comment correction rides this commit; the durable pin is behavioural.
   */
  it('Android treats an empty text block as no payload, same as iOS', () => {
    const k = read(KOTLIN)
    const region = k.slice(k.indexOf('"afterToolCallEvent"'), k.indexOf('"modelMetadataEvent"'))
    // Without the emptiness check, optString returns "" and the batch looks
    // like it reported nothing-shaped results rather than nothing at all.
    expect(region).toMatch(/optString\("text"\)\.takeIf \{ it\.isNotEmpty\(\) \}/)
  })

  /**
   * Its own pin, and it bans the PROPERTY rather than a spelling. The first
   * version of this claim lived inside the test above as
   * `expect(region).toContain('firstNotNullOfOrNull')` and a mutant walked
   * straight past it: narrowing the range to `0 until minOf(1, arr.length())`
   * shadows every block after the first while the searcher's NAME stays put.
   * So assert the BOUND is the array's own length, unclamped.
   */
  it('Android searches every content block, not just the first', () => {
    const k = read(KOTLIN)
    const region = k.slice(k.indexOf('"afterToolCallEvent"'), k.indexOf('"modelMetadataEvent"'))
    const m = region.match(/\(\s*0 until ([^\n]*?)\s*\)\s*\.firstNotNullOfOrNull/)
    expect(m, 'the payload search over content blocks is gone or reshaped').toBeTruthy()
    // A leading image or text block must not shadow the json block behind it —
    // iOS's firstToolJson loop walks the whole array for the same reason.
    expect(m![1]).toBe('arr.length()')
  })

  it('web renders the same five states', () => {
    const w = read(WEB)
    for (const label of ['aria-label="running"', 'aria-label="succeeded"', 'aria-label="failed"',
                         'aria-label="did not run"', 'aria-label="queued"']) {
      expect(w).toContain(label)
    }
  })

  /**
   * FLAGGED, not fixed — a WEB defect found while building the iOS table, and
   * out of scope for an iOS increment.
   *
   * Web computes `didNotRun = status === "error" && !node`. So a batch that
   * SETTLED and simply didn't report a task falls through to "queued" — a grey
   * dot promising an update that will never arrive. That is the identical
   * reasoning web's own comment already uses to reject a grey dot for the error
   * case ("a failed batch has nothing pending"), one case over.
   *
   * `it.fails` on purpose: this passes while web is still wrong, and turns RED
   * the moment web is fixed — at which point delete the marker.
   */
  it.fails('web treats a settled-but-unreported node as didNotRun (it does not yet)', () => {
    const w = read(WEB)
    const line = w.split('\n').find(l => l.includes('const didNotRun ='))!
    expect(line).toMatch(/status === "error" \|\| status === "settled"|!pending/)
  })
})

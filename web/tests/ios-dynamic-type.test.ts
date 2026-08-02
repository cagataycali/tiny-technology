// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔤 Text in the devices panel has to grow when the user's text does.
 *
 * `.font(.system(size: 10))` is an ABSOLUTE size — it ignores Dynamic Type
 * completely. That is not a subtle failure mode but it is an invisible one to
 * anyone testing at the default text size, and it shipped: the capability strip
 * (`bluetooth_scan`, `image_gen`, `open_app` …) rendered byte-for-byte identical
 * at `extra-small` and at `accessibility-extra-extra-extra-large`, while every
 * other word in the row tripled. The strip carries more words than the rest of
 * the row combined, so the one element immune to the setting was the one holding
 * most of the text.
 *
 * A text STYLE (`.caption2`, `.footnote`, …) scales; a `size:` does not. So the
 * rule for these views is: no absolute font sizes, at all. Checked by reading
 * the source because there is nothing at runtime to assert against — the bug is
 * the absence of scaling, and a unit test at one text size cannot see it.
 *
 * Fixed FRAMES are a different question and deliberately not checked here: the
 * camera window's `.frame(height: 130)` is a picture, not text, and the identity
 * tile stays 38pt on purpose (a scaling tile ate the width the device NAME needs
 * — see DeviceRowView).
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')

/** The `{ … }` block starting at or after `at`, brace-matched. */
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

/** Source of `struct <name>: View { … }`, brace-matched. */
function structBody(source: string, name: string): string {
  const at = source.search(new RegExp(`struct\\s+${name}\\s*:\\s*View\\s*\\{`))
  expect(at, `struct ${name} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

/** Same, for a stateless-rule `enum <name>` — where this file's copy now lives. */
function enumBody(source: string, name: string): string {
  const at = source.search(new RegExp(`enum\\s+${name}\\b[^{]*\\{`))
  expect(at, `enum ${name} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

/** `.font(.system(size: 9))` → ['9']. Ignores `.font(.caption2)` and friends. */
function absoluteFontSizes(body: string): string[] {
  return Array.from(body.matchAll(/\.font\(\s*\.system\(size:\s*([^),]+)/g)).map((m) => m[1].trim())
}

/**
 * Swift with its comments removed. Needed for the NEGATIVE needles below: every
 * fix in this file is documented at its own site, quoting the string it
 * replaced, so a whole-body scan would flag the fix's own explanation. (It also
 * eats a `//` inside a string literal — no URL lives in these views.)
 */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '')

describe('the devices panel scales with Dynamic Type', () => {
  const panels = readFileSync(PANELS, 'utf8')

  it('reads the file it means to read', () => {
    // A brace-matcher that silently returned "" would make every other
    // expectation below pass forever.
    expect(structBody(panels, 'CapabilityChip').length).toBeGreaterThan(100)
    expect(structBody(panels, 'DeviceRowView').length).toBeGreaterThan(400)
  })

  it('a capability chip has no absolute font size', () => {
    // Was `size: 10` for the word and `size: 8` for the glyph.
    expect(absoluteFontSizes(structBody(panels, 'CapabilityChip'))).toEqual([])
  })

  it("the camera panel's own text has no absolute font size", () => {
    // Was `size: 9` in four places — the error reason, the retry hint, the
    // "asking the camera…" line and the timestamp footer.
    expect(absoluteFontSizes(structBody(panels, 'RelayCameraPanel'))).toEqual([])
  })

  it('the device row keeps exactly one absolute size: the identity tile glyph', () => {
    // 38pt square tile, 16pt glyph — the one deliberate exception in the row,
    // documented at the property that used to scale it. Pinned so that a `size:`
    // added to the row's TEXT shows up here as a second entry.
    expect(absoluteFontSizes(structBody(panels, 'DeviceRowView'))).toEqual(['16'])
  })

  it('neither sibling panel on the sheet is frozen either', () => {
    // These two are the reason this is a file-wide rule and not a one-view fix.
    // Both mixed the two kinds of font in one panel — the Voice panel's
    // "listening" label was `.caption2` while the line of stats directly under
    // it was `size: 9`, and the Flipper panel's header was `.caption.bold()`
    // over four `size: 10` body lines. At AX-XXXL each of those panels tripled
    // its heading and left its content at its default, which looks less like a
    // text-size setting and more like a broken stylesheet.
    expect(absoluteFontSizes(structBody(panels, 'VoiceDevicePanel'))).toEqual([])
    expect(absoluteFontSizes(structBody(panels, 'FlipperDevicePanel'))).toEqual([])
  })

  it('an absolute size is only ever applied to an ICON, never to text', () => {
    // The whole-file version of the rule, so a NEW view can't reintroduce it
    // somewhere this file doesn't name. Three sites survive and all three are a
    // glyph sized to a fixed square tile (38pt device tile, 38pt beacon tile, an
    // inline bolt) — a picture scaled by Dynamic Type would break its frame, so
    // those are correct. Text has no such excuse.
    const lines = panels.split('\n')
    const onText: string[] = []
    lines.forEach((line, i) => {
      if (!/\.font\(\s*\.system\(size:/.test(line)) return
      // The glyph is either on this line or immediately above it.
      const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
      if (!/Image\(systemName:/.test(window)) onText.push(`${i + 1}: ${line.trim()}`)
    })
    expect(onText, `absolute font size on text:\n${onText.join('\n')}`).toEqual([])
  })

  it('a failure reason wraps instead of racing the control for the width', () => {
    // Two Texts in one HStack with no `fixedSize` don't fail at the default text
    // size and can't fail in a unit test — at AX sizes SwiftUI shrinks whichever
    // one it likes and truncates it. The camera panel had `Text(error)` beside
    // `Text("· tap to retry")` exactly like that, so the accessibility text size
    // that made the reason matter most was the one that clipped it. FrameFailure
    // messages are full sentences, several of them the server's own words, so
    // every place one is rendered must let it grow downward.
    const cam = code(structBody(panels, 'RelayCameraPanel'))
    // Named, not counted. This asserted `toBe(2)` and went stale the moment the
    // panel grew a THIRD wrapping string — the asleep-board line, added so a
    // necklace in a drawer stopped being drawn as a broken camera. A test that
    // fails because the fix it asked for spread is a test that has to be reread
    // to be believed, so each site is pinned to the string it wraps: adding a
    // fourth reason is free, and un-wrapping any of these three names itself.
    for (const [what, needle] of [
      ['the alarm-card reason', 'Text(why)'],
      ['the quiet-line reason', 'Text(peek.quietReason ?? "tap to peek")'],
      ['the asleep-board line', 'Label(unreachable, systemImage: "moon.zzz")'],
      ['the stale-frame reason', 'Text("· \\(error)")'],
    ]) {
      const at = cam.indexOf(needle)
      expect(at, `${what} is gone — looked for ${needle}`).toBeGreaterThan(-1)
      expect(cam.slice(at, at + 300), `${what} can be clipped instead of wrapping`)
        .toContain('.fixedSize(horizontal: false, vertical: true)')
    }
    // A cap would re-introduce the clipping this replaced.
    expect(cam, 'a truncated reason is the swallowed failure again').not.toMatch(/\.lineLimit\(/)
  })

  it('the camera panel offers a Retry control, not a sentence with "·" glued on', () => {
    // "·" joins terminator-free fragments in this app ("online · daemon ·
    // ios-arm64"). Chaining it onto a FrameFailure message printed "Couldn't
    // reach the relay. · tap to retry" — a separator after a full stop — and
    // left the app's only retry that VoiceOver couldn't announce as an action.
    // Seven other failures use a Button; the sibling panel one row down on this
    // same sheet (FlipperDevicePanel) already had the shape this now copies.
    const cam = code(structBody(panels, 'RelayCameraPanel'))
    expect(cam, 'the retry hint is prose again').not.toContain('tap to retry')
    expect(cam).toMatch(/Button\("Retry"\) \{ refresh\(asked: true\) \}/)
    expect(cam).toMatch(/\.buttonStyle\(\.bordered\)/)
    // The idle state stays a tappable rectangle (tapping the panel is the whole
    // gesture), so it has to say so to the accessibility layer itself.
    expect(cam).toMatch(/\.accessibilityAddTraits\(\.isButton\)/)
    // The words moved OUT of the struct into `PeekShape`, which decides them per
    // shape — an unasked failure now reads its reason aloud instead of this
    // invitation, since `.combine` makes the label replace the text it merges.
    // So the pin follows: the panel wires the rule, and the rule keeps the words.
    expect(cam).toMatch(/\.accessibilityLabel\(peek\.spoken\)/)
    expect(enumBody(panels, 'PeekShape')).toContain('Peek at the camera')
    // Including the frame itself: an Image(uiImage:) carries no label, so the
    // one thing on screen a VoiceOver user could act on announced nothing.
    expect(cam).toContain('Latest camera frame')
  })

  it('the presence dot and the row it sits in scale together', () => {
    // A 7pt dot next to 30pt text reads as dirt on the screen, not as a status
    // light. @ScaledMetric ties it to the same style as the line it labels.
    const row = structBody(panels, 'DeviceRowView')
    expect(row).toMatch(/@ScaledMetric\(relativeTo:\s*\.caption2\)[^\n]*dotSize/)
    expect(row).toMatch(/\.frame\(width:\s*dotSize,\s*height:\s*dotSize\)/)
  })
})

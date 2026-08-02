// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔤 The devices sheet must not show people the wire's vocabulary.
 *
 * Every capability chip printed its token verbatim, so a real row read
 * `bluetooth_scan` `image_gen` `open_app` `tof` `imu` `ble` — identifiers a
 * daemon posts to a server, three with an underscore in them, four acronyms with
 * no expansion anywhere on screen, and `windows` reading as Microsoft's product.
 * A laptop declares a dozen, so the widest element of the row was a wrapping grey
 * ribbon of them: the panel looked like a debug dump of itself. VoiceOver had it
 * worst — "can bluetooth underscore scan".
 *
 * CAPABILITY_LABELS fixes the WORDS and the Swift suite tests those. What no
 * Swift test can see is whether the views actually CALL it: a mapping table that
 * nothing reads is dead code, and the sheet would go on printing tokens with a
 * green suite either side of it. So this pins the call sites — which is also the
 * only way to catch the second one, the row's combined accessibility label, whose
 * output no sighted test and no screenshot ever shows.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')

describe('capability chips read as words, at every call site', () => {
  const panels = readFileSync(PANELS, 'utf8')

  /** Source of `struct <name>: View { … }`, brace-matched. */
  function structBody(name: string): string {
    const at = panels.search(new RegExp(`struct\\s+${name}\\s*:\\s*View\\s*\\{`))
    expect(at, `struct ${name} not found — renamed?`).toBeGreaterThan(-1)
    const open = panels.indexOf('{', at)
    let depth = 1
    let i = open + 1
    while (i < panels.length && depth > 0) {
      if (panels[i] === '{') depth++
      else if (panels[i] === '}') depth--
      i++
    }
    return panels.slice(open, i)
  }

  it('reads the file it means to read', () => {
    // A brace-matcher that silently returned "" would make the rest pass forever.
    expect(structBody('CapabilityChip').length).toBeGreaterThan(200)
    expect(structBody('DeviceRowView').length).toBeGreaterThan(400)
  })

  it('the chip renders the LABEL, never the raw token', () => {
    const chip = structBody('CapabilityChip')
    expect(chip).toContain('Text(capabilityLabel(cap))')
    // `Text(cap)` is the exact line that shipped. Pinned as its own assertion so
    // a revert names itself instead of failing the vaguer one above.
    expect(chip, 'the chip is printing the wire token again').not.toMatch(/Text\(cap\)/)
  })

  it("the chip's own VoiceOver label is mapped too", () => {
    expect(structBody('CapabilityChip')).toContain('"can \\(capabilityLabel(cap))"')
  })

  it('the row\'s combined accessibility label is mapped — the one nothing shows you', () => {
    // `.accessibilityElement(children: .combine)` makes this string REPLACE every
    // chip's own label, so fixing the chips alone leaves VoiceOver as the last
    // surface still speaking identifiers — on the surface where an unexplained
    // token is least recoverable, because you cannot go back and squint at it.
    const row = structBody('DeviceRowView')
    expect(row).toContain('.accessibilityElement(children: .combine)')
    // The string is assembled in `DeviceOrder.spokenLabel` now — the spoken row
    // had to start naming the hardware too, and it belongs beside `rowLine`,
    // whose omissions only read straight against the spoken row's. Same rule,
    // same words; the pin reads whichever of the two holds the mapping.
    const at = panels.indexOf('static func spokenLabel(')
    expect(at, 'spokenLabel not found — renamed?').toBeGreaterThan(-1)
    const spoken = panels.slice(at, panels.indexOf('\n    }', at))
    expect(row + spoken).toMatch(/d\.capabilities\.map\(capabilityLabel\)\.joined/)
    expect(row + spoken, 'the row is speaking wire tokens again')
      .not.toMatch(/d\.capabilities\.joined/)
  })

  it('no label smuggles a separator back in', () => {
    // An underscore in a VALUE is the original bug wearing a lookup table: the
    // fallback opens separators up, so a mapped word that keeps one is strictly
    // worse than not mapping it at all.
    //
    // Hyphens are not the same thing, which this test learned the hard way by
    // failing on "Wi-Fi" — Apple's own spelling, and English, not a wire token.
    // So they are allowed BY NAME rather than by pattern: a hyphen that belongs
    // to a word is fine and a hyphen inherited from an identifier is not, and no
    // regex tells those apart. Adding one has to be a decision.
    const HYPHENATED_ON_PURPOSE = ['Wi-Fi']
    const table = panels.slice(panels.indexOf('let CAPABILITY_LABELS'))
    const body = table.slice(table.indexOf('['), table.indexOf(']\n') + 1)
    const values = Array.from(body.matchAll(/"[^"]+":\s*"([^"]+)"/g)).map((m) => m[1])
    expect(values.length, 'the table did not parse — did it stop being a literal?')
      .toBeGreaterThan(25)
    expect(values.filter((v) => v.includes('_')), 'a label kept its underscore')
      .toEqual([])
    expect(values.filter((v) => v.includes('-') && !HYPHENATED_ON_PURPOSE.includes(v)))
      .toEqual([])
  })

  it('and the fallback opens them up rather than passing them through', () => {
    // Swift-side behaviour is tested in TinyTests; this pins that the fallback
    // still EXISTS, because deleting it is how an unmapped `some_new_thing`
    // silently starts rendering with an underscore again.
    const fn = panels.slice(panels.indexOf('func capabilityLabel('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toMatch(/replacingOccurrences\(of: "_", with: " "\)/)
    expect(body).toMatch(/replacingOccurrences\(of: "-", with: " "\)/)
  })

  /** Needles out of a `[(needle: String, x: String)]` literal, in source order. */
  function needles(tableName: string): string[] {
    const at = panels.indexOf(`let ${tableName}: [(needle: String`)
    expect(at, `${tableName} not found — renamed, or no longer a needle list?`).toBeGreaterThan(-1)
    const body = panels.slice(at, panels.indexOf('\n]', at))
    return Array.from(body.matchAll(/^\s{4}\("([^"]+)",/gm)).map((m) => m[1])
  }

  it('the row says what the hardware is, instead of printing the wire', () => {
    // `descriptor` joined both wire fields: "daemon · darwin-arm64", "endpoint ·
    // bambu". Identifiers a daemon posts to a server, sitting one line above
    // chips this file had already turned into English — and false read as
    // English, since a necklace is not a daemon and a printer is not an
    // endpoint. `kind` is redundant wherever a platform exists, so the honest
    // line is one word.
    const row = panels.slice(panels.indexOf('struct DeviceRow: Identifiable'))
    const decl = row.slice(0, row.indexOf('\n}\n'))
    // Either spelling of the platform passes here: this test's subject is that
    // the word is MAPPED rather than a wire field. Which of the two goes in —
    // `shownPlatform`, so an iPad's own row stops saying "iOS" — is pinned by
    // tests/ios-local-hardware.test.ts, so one fact keeps one owner.
    expect(decl).toMatch(/deviceLabel\(platform: (shownPlatform|platform), kind: kind\)/)
    expect(decl, 'the descriptor is joining wire fields again')
      .not.toMatch(/\[kind, platform\]/)
  })

  it("a robot's row says where its body is, like the web row does", () => {
    // A robot is the one device class with no platform on the wire — nothing
    // self-reports for it — so this line could otherwise only say its `kind` in
    // a nicer word ("robot"), which is the category its glyph has already drawn.
    // The worker lists an endpoint's `url` for exactly this reason ("the owner
    // needs to see where a body lives"); iOS decoded everything except that.
    const row = panels.slice(panels.indexOf('struct DeviceRow: Identifiable'))
    const decl = row.slice(0, row.indexOf('\n}\n'))
    expect(decl, 'the row dropped the url field again').toMatch(/var url: String = ""/)
    expect(decl, 'descriptor stopped preferring the address').toMatch(/if isEndpoint \{/)

    // A field nothing decodes is the bug this fixes, not the fix: `url` sat
    // absent from the wire parse, so a correct row would still have read "robot"
    // against a real response. Pinned at the decoder, which no Swift test of the
    // struct alone can reach.
    const dec = panels.slice(panels.indexOf('static func decodeDevices('))
    // To the end of the function, not a fixed byte count — the capabilities
    // comment alone is long enough that a 2000-char window stopped mid-token.
    expect(dec.slice(0, dec.indexOf('\n    }\n'))).toMatch(/url: dev\["url"\] as\? String \?\? ""/)

    // Same slice on both surfaces, or the two rows disagree about one device.
    const web = readFileSync(join(ROOT, 'app/devices/page.tsx'), 'utf8')
    expect(web, 'web stopped stripping the scheme — iOS still does')
      .toMatch(/replace\(\/\^https:\\\/\\\/\/, ""\)/)
    expect(decl, 'iOS stopped stripping the scheme — web still does')
      .toMatch(/hasPrefix\("https:\/\/"\) \? String\(host\.dropFirst\(8\)\)/)
  })

  it('the word and the glyph cannot disagree about the same device', () => {
    // Two tables describe one fact — DEVICE_PLATFORM_GLYPH draws it,
    // DEVICE_PLATFORM_NAME says it — and nothing in Swift makes them agree. A
    // needle in one and not the other is a row whose picture and caption are
    // about different machines, which is worse than the untranslated line this
    // replaced. It has already happened once: NAME shipped a tenth needle
    // (`bambu`) against nine glyphs, so a printer would have read "Bambu Lab"
    // beside the generic robot cube — and `bambu` is unreachable anyway, since
    // only a self-reporting daemon sends a platform at all.
    //
    // Order is part of the contract, not incidental: both tables are scanned
    // with `contains`, so "ipados" matches the `ios` needle too and only the
    // position of `ipad` before it keeps an iPad off the iPhone entry. Equal
    // sets in a different order would silently diverge.
    expect(needles('DEVICE_PLATFORM_NAME')).toEqual(needles('DEVICE_PLATFORM_GLYPH'))
    expect(needles('DEVICE_PLATFORM_GLYPH').length).toBeGreaterThan(5)
  })

  it('every kind that has a glyph has a word, and vice versa', () => {
    // Same invariant one table down, where the fallback lives: a `kind` with a
    // picture and no word falls through to nil and the row's second line loses
    // its whole hardware half.
    const keys = (name: string) => {
      const at = panels.indexOf(`let ${name}: [String: String]`)
      expect(at, `${name} not found`).toBeGreaterThan(-1)
      const body = panels.slice(at, panels.indexOf('\n]', at))
      return Array.from(body.matchAll(/^\s{4}"([a-z]+)":/gm)).map((m) => m[1]).sort()
    }
    expect(keys('DEVICE_KIND_NAME')).toEqual(keys('DEVICE_KIND_GLYPH'))
  })

  it('the hardware word never ships wire punctuation either', () => {
    // Same rule as the capability labels, and the same fallback: an unmapped
    // platform must still SHOW (a newer daemon must not vanish from the sheet)
    // but never in underscores.
    const fn = panels.slice(panels.indexOf('func deviceLabel('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toMatch(/replacingOccurrences\(of: "_", with: " "\)/)
    expect(body).toMatch(/replacingOccurrences\(of: "-", with: " "\)/)
    const words = Array.from(
      panels.slice(panels.indexOf('let DEVICE_PLATFORM_NAME')).slice(0, 900)
        .matchAll(/^\s{4}\("[^"]+",\s*"([^"]+)"\)/gm),
    ).map((m) => m[1])
    expect(words.length, 'the name table did not parse').toBeGreaterThan(5)
    expect(words.filter((w) => /[_]/.test(w)), 'a hardware name kept its underscore')
      .toEqual([])
  })

  it('the table stays a dictionary, or it drags the Android parity test in with it', () => {
    // tests/nicla-android-parity.test.ts scrapes `case "…": return "…"` arms out
    // of this file to enumerate the capability set, then demands an Android icon
    // for every name it finds. Written as a switch, this table would make it
    // demand icons for `telegram` and `integrations` — real daemon labels that
    // neither phone has drawn yet. Same reason DEVICE_PLATFORM_GLYPH is data.
    expect(panels).toMatch(/let CAPABILITY_LABELS: \[String: String\] = \[/)
    const scraped = Array.from(panels.matchAll(/case "(\w+)": return "/g)).map((m) => m[1])
    for (const smuggled of ['telegram', 'integrations']) {
      expect(scraped, `${smuggled} entered the scrape — Android now needs an icon`)
        .not.toContain(smuggled)
    }
  })
})

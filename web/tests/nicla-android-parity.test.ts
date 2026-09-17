// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 💎🎙️ Nicla Vision + Nicla Voice — Android ↔ iOS parity pins.
 *
 * The two phones gateway the SAME hardware speaking the SAME firmware
 * protocol; every constant here (GATT UUIDs, capability claims, event kind,
 * the wake detail line) exists on both sides and in the firmware. A drift on
 * any one of them silently splits the fleet: a necklace set up on iOS stops
 * making sense on Android or vice versa.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Source with its comments removed.
 *
 * Several fixes here document the string they replaced by quoting it verbatim —
 * which is exactly what makes them reviewable, and exactly what makes a
 * whole-file scan flag a fix as its own regression. (It also eats a `//` inside
 * a string literal, i.e. a URL, which costs nothing in these pins.)
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/**
 * The body of `<opener><name>…{ … }`, brace-matched from its opening brace.
 *
 * Every scrape in this file wants BOTH ends bounded. A measured lesson: an
 * unbounded `slice(indexOf(needle))` over a 1750-line file matches almost
 * anything downstream, so a mutant that recoloured a control survived a pin that
 * read strict. Counts and `.not.toMatch` are only as scoped as their slice.
 */
const braceBody = (src: string, at: number) => {
  const open = src.indexOf('{', at)
  let depth = 1
  let i = open + 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(open, i)
}

/**
 * The index just past a `fun name(` declaration's closing paren, paren-matched.
 *
 * Needed because a signature can legally contain both `=` (a default parameter)
 * and `{` (a lambda default, a trailing-comma block) — so neither character means
 * anything about the BODY until the parameter list is behind you.
 */
const afterParams = (src: string, at: number) => {
  const open = src.indexOf('(', at)
  let depth = 1
  let i = open + 1
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') depth--
    i++
  }
  return i
}

/**
 * A brace-matched `fun <name>(…)` body — `@Composable` included.
 *
 * ⚠️ REFUSES an expression-bodied function (`fun f(x) = …`). `braceBody` would
 * happily find the next `{` somewhere BELOW it and return a completely different
 * function's body — a wrong slice, not an empty one, so a `.not.toMatch` pin
 * built on it passes forever while guarding nothing. Measured: four c45 pins
 * silently read `normalizedWords`'s lambda while claiming to read `gainFor`.
 * Use [ktExprFun] for those.
 *
 * ⚠️ AND REFUSES AN AMBIGUOUS NAME, for the same reason one level up. This took
 * `indexOf`, i.e. the FIRST match, and a name is only unique until someone adds a
 * nested class: `LiveScribe` grew a `SegmentAudio.finish()` above its own
 * `finish()`, and three pins that had guarded segment-filing for cycles silently
 * moved to a 12-line file-closer and reported the guarantees missing. A red is the
 * lucky outcome — the same shift into a *longer* neighbour passes while reading the
 * wrong function. So a duplicate name is an error here, and the caller must scope
 * the source (e.g. [ktObject]) rather than hope.
 */
const ktFun = (src: string, name: string) => {
  const at = src.indexOf(`fun ${name}(`)
  expect(at, `${name} not found in the Kotlin — renamed?`).toBeGreaterThan(-1)
  expect(
    src.indexOf(`fun ${name}(`, at + 1),
    `two functions are named ${name} — scope the source or this pin reads the wrong one`,
  ).toBe(-1)
  // ⚠️ Search for the body AFTER the parameter list, not after the name. A DEFAULT
  // PARAMETER puts an `=` inside the signature (`extendWhileSpeaking: Boolean =
  // false`), and on a multi-line signature that `=` precedes the opening brace with
  // a newline between them — the exact shape of the expression-body test below. It
  // read as "bare expression body" and failed six pins on a function that has a
  // perfectly ordinary block, which is the WRONG diagnosis rather than a caught bug.
  const sigEnd = afterParams(src, at)
  const brace = src.indexOf('{', sigEnd)
  const eq = src.indexOf('=', sigEnd)
  // An `=` before the brace is only a problem when NO brace follows on the same
  // statement: `fun f() = withContext(x) { … }` is expression-bodied and its
  // block IS the body, while `fun f(x) = expr` has no block of its own and would
  // silently borrow the next function's.
  const eqOnly = eq > -1 && eq < brace && src.slice(eq, brace).includes('\n')
  expect(
    brace > -1 && !eqOnly,
    `${name} has a bare expression body — use ktExprFun, or this slice is another function`,
  ).toBe(true)
  return braceBody(src, at)
}

/**
 * The right-hand side of an expression-bodied `fun <name>(…) = …`, up to the
 * blank line that ends it. Kotlin's other half of [ktFun].
 */
const ktExprFun = (src: string, name: string) => {
  const at = src.indexOf(`fun ${name}(`)
  expect(at, `${name} not found in the Kotlin — renamed?`).toBeGreaterThan(-1)
  const eq = src.indexOf('=', at)
  expect(eq, `${name} is not expression-bodied — use ktFun`).toBeGreaterThan(-1)
  const end = src.indexOf('\n\n', eq)
  return src.slice(eq, end === -1 ? src.length : end)
}

/** Same, for `struct <name>: View`. */
const swiftStruct = (src: string, name: string) => {
  const at = src.search(new RegExp(`struct\\s+${name}\\s*:\\s*View\\s*\\{`))
  expect(at, `struct ${name} not found — renamed?`).toBeGreaterThan(-1)
  return braceBody(src, at)
}

/** Same, for a namespacing `enum <name> {` — Swift's stateless-rule idiom here. */
const swiftEnum = (src: string, name: string) => {
  const at = src.search(new RegExp(`enum\\s+${name}\\s*\\{`))
  expect(at, `enum ${name} not found — renamed?`).toBeGreaterThan(-1)
  return braceBody(src, at)
}

/** Same, for `internal object <name> {` — the Kotlin spelling of that idiom. */
const ktObject = (src: string, name: string) => {
  const at = src.search(new RegExp(`object\\s+${name}\\s*\\{`))
  expect(at, `object ${name} not found — renamed?`).toBeGreaterThan(-1)
  return braceBody(src, at)
}

const androidGateway = read('android/app/src/main/java/technology/tiny/app/fleet/NiclaVoiceGateway.kt')
const iosGateway = read('ios/Tiny/Sources/NiclaVoiceGateway.swift')
const androidBt = read('android/app/src/main/java/technology/tiny/app/fleet/Bluetooth.kt')
const iosBt = read('ios/Tiny/Sources/Bluetooth.swift')
const androidPanels = read('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')
const iosPanels = read('ios/Tiny/Sources/Panels.swift')
const androidNearby = read('android/app/src/main/java/technology/tiny/app/ui/Nearby.kt')
const androidSetup = read('android/app/src/main/java/technology/tiny/app/fleet/TinySetup.kt')
const iosSetup = read('ios/Tiny/Sources/TinySetup.swift')

describe('the voice gateway speaks the same GATT contract on both phones', () => {
  it('service + wake + status UUIDs are identical', () => {
    for (const uuid of [
      '74696e79-5f62-6c65-5f70-726f76697331', // service (shared with provisioning)
      '74696e79-5f77-616b-655f-65766e743031', // wake notify
      '74696e79-5f73-7461-745f-72643031ffff', // status notify+read
    ]) {
      expect(androidGateway).toContain(uuid)
      expect(iosGateway).toContain(uuid)
    }
  })

  it('both heartbeat and forward through the same endpoints, as the DEVICE', () => {
    for (const src of [androidGateway, iosGateway]) {
      expect(src).toContain('/api/devices/heartbeat')
      expect(src).toContain('/api/devices/event')
      expect(src).toContain('nicla_wake')
    }
  })

  it('the wake detail line is verbatim-identical (one event ring, two writers)', () => {
    // iOS: "heard “\(wake.label)” (#\(wake.count))"
    expect(iosGateway).toContain('heard “\\(wake.label)” (#\\(wake.count))')
    expect(androidGateway).toContain('heard “${wake.label}” (#${wake.count})')
  })

  it('the Voice claims the same four capabilities everywhere', () => {
    // iOS gateway + iOS setup + Android gateway; the Android setup dialog
    // reads the gateway constant, pinned by the mounting test below.
    expect(iosGateway).toMatch(/capabilities = \["mic", "wake", "imu", "ble"\]/)
    expect(androidGateway).toMatch(/CAPABILITIES = listOf\("mic", "wake", "imu", "ble"\)/)
    expect(read('ios/Tiny/Sources/TinySetup.swift')).toContain('["mic", "wake", "imu", "ble"]')
    expect(androidNearby).toContain('NiclaVoiceGateway.CAPABILITIES')
  })

  it('the wake kind matches what the server tools read', () => {
    // lib/chat/tools/nicla-voice.ts filters events on this exact kind.
    const tools = read('lib/chat/tools/nicla-voice.ts')
    expect(tools).toMatch(/WAKE_KIND = 'nicla_wake'/)
  })
})

describe('beacon kind: the version byte tells a Vision from a Voice', () => {
  it('both parsers map version 1→vision, 2→voice, unknown→vision platform', () => {
    expect(iosBt).toMatch(/case 1: return \.vision/)
    expect(iosBt).toMatch(/case 2: return \.voice/)
    expect(androidBt).toMatch(/1 -> Kind\.VISION/)
    expect(androidBt).toMatch(/2 -> Kind\.VOICE/)
    for (const src of [iosBt, androidBt]) {
      expect(src).toContain('"nicla-vision"')
      expect(src).toContain('"nicla-voice"')
    }
  })
})

describe('the devices tab mounts the same per-platform panels', () => {
  it('Android rows gained the capability strip with iOS’s exact capability set', () => {
    // iOS capabilityIcon switches on these seven; Android's map must know
    // the same names (icons differ per platform, the SET must not).
    const iosCaps = [...iosPanels.matchAll(/case "(\w+)": return "/g)].map((m) => m[1])
    expect(iosCaps.length).toBeGreaterThanOrEqual(7)
    for (const c of iosCaps) {
      expect(androidPanels).toMatch(new RegExp(`"${c}" -> Icons\\.`))
    }
    expect(androidPanels).toContain('capabilityIcon(c)')
  })

  it('nicla-vision rows get the tap-to-refresh camera; nicla-voice rows the BLE panel', () => {
    // Same mount conditions as iOS Panels.swift:1878/1885.
    expect(androidPanels).toMatch(
      /platform == "nicla-vision" && d\.capabilities\.contains\("camera"\)/,
    )
    expect(androidPanels).toMatch(/platform == "nicla-voice"/)
    expect(androidPanels).toContain('RelayCameraPanel(')
    expect(androidPanels).toContain('VoiceDevicePanel(')
    expect(iosPanels).toContain('d.platform == "nicla-vision", d.capabilities.contains("camera")')
    expect(iosPanels).toContain('d.platform == "nicla-voice"')
  })

  it('the Android wire parse now carries platform (the panel gate)', () => {
    expect(androidPanels).toMatch(/platform = d\.optString\("platform"\)/)
  })

  it('the status line is built, not interpolated — same segments on both phones', () => {
    // It shipped as one hard-coded string on each side:
    //   "${s.labels} wake word(s) · ${s.wakes} heard · up ${s.uptimeS}s"
    // Raw seconds ("up 41293s"), and two zeroes that read as alarms the board
    // never raised — handleStatus decodes a 64-byte BLE notify with `?? 0` /
    // `optInt`, so a missing key is expected: "up 0s" is a reset loop on
    // something you wear, and "0 wake words" claims a net that can never hear
    // you, printed under a green "listening" badge. Behaviour is pinned by
    // VoiceFmtTests (iOS) and VoiceStatusLineTest (Android); what only a
    // cross-file test can see is that neither side went back to interpolating.
    // Against CODE, not the file: both formatters document the string they
    // replaced, quoting it verbatim, so a whole-file scan flags its own fix.
    // (The stripper also eats a "//" inside a string literal — a URL — which
    // costs nothing here: a regression would be a Text(…) with no "//" in it.)
    expect(code(iosPanels), 'iOS is printing raw uptime seconds again')
      .not.toMatch(/up \\\(s\.uptimeS\)s/)
    expect(code(androidPanels), 'Android is printing raw uptime seconds again')
      .not.toMatch(/up \$\{s\.uptimeS\}s/)
    expect(iosPanels).toContain('VoiceFmt.statusLine(s)')
    expect(androidPanels).toContain('voiceStatusLine)')

    // The rendered segments have to match word for word — one necklace, two
    // phones, and a user who may well hold them side by side. Each side's
    // interpolation syntax differs, so the needles are per-language; what they
    // assert is that the same three segments, the same pluralisation rule and
    // the same separator survive on both.
    const segments = [
      { src: iosPanels, needles: [
        'wake word\\(s.labels == 1 ? "" : "s")',
        '\\(s.wakes) heard',
        'up \\(up)',
        'joined(separator: " · ")',
      ] },
      { src: androidPanels, needles: [
        'wake word${if (s.labels == 1) "" else "s"}',
        '${s.wakes} heard',
        'up $it',
        'joinToString(" · ")',
      ] },
    ]
    for (const { src, needles } of segments) {
      for (const n of needles) expect(src).toContain(n)
    }
  })
})

describe('setup: a Voice never gets asked for WiFi', () => {
  it('Android hides the SSID form and provisions identity-only for a Voice', () => {
    expect(androidNearby).toContain('Kind.VOICE')
    // Identity config gains ssid/key ONLY on the non-voice branch.
    expect(androidNearby).toMatch(/if \(!isVoice\) config\.put\("ssid", ssid\)\.put\("key", password\)/)
    // The set-up button must not demand an SSID the board cannot use.
    expect(androidNearby).toMatch(/isVoice \|\| ssid\.isNotBlank\(\)/)
    // And a successful voice setup registers the gateway.
    expect(androidNearby).toMatch(/NiclaVoiceGateway\.register\(/)
  })
})

describe('the devices strip speaks words, not wire, on both phones', () => {
  // iOS e39e5f69: every chip printed the daemon's token verbatim, and VoiceOver
  // read "bluetooth underscore scan". Android had the identical bug plus a
  // second one — it never sorted the strip at all, so chips reshuffled on every
  // refresh. Both tables are scraped live, so a token that gains a word on one
  // phone and not the other fails here.
  // Scoped to each table's body: both files hold OTHER 4-space "key": "value"
  // dictionaries (iOS DEVICE_PLATFORM_GLYPH, whose keys overlap — `browse` is a
  // capability, `browser` a platform), and a whole-file scrape silently mixes
  // them, which reads as a parity failure that isn't one.
  // The literals close differently — Swift `]`, Kotlin `mapOf(` `)` — and using
  // one terminator for both lets a scrape run past the table into unrelated JSON
  // keys further down the file.
  const table = (src: string, open: RegExp, close: string, pair: RegExp) => {
    const start = src.search(open)
    expect(start, 'the CAPABILITY_LABELS table moved — this scrape is stale').toBeGreaterThan(-1)
    const end = src.indexOf(close, start)
    expect(end, 'the table never closes — this scrape is stale').toBeGreaterThan(start)
    const body = src.slice(start, end)
    return new Map([...body.matchAll(pair)].map((m) => [m[1], m[2]] as [string, string]))
  }
  const iosLabels = table(iosPanels, /let CAPABILITY_LABELS/, '\n]', /"([a-z_]+)":\s*"([^"]+)",/g)
  const androidLabels = table(androidPanels, /val CAPABILITY_LABELS/, '\n)', /"([a-z_]+)" to "([^"]+)",/g)

  it('both phones map the same tokens to the same words', () => {
    // Sanity: the scrapes found real tables, not zero matches passing vacuously.
    expect(iosLabels.size).toBeGreaterThan(25)
    expect(androidLabels).toEqual(iosLabels)
  })

  it('no label ships wire punctuation', () => {
    for (const [token, label] of androidLabels) {
      // Underscores are always the wire's. Hyphens are not: "Wi-Fi" is Apple's
      // spelling of a real word, so the rule that catches it is narrower — a
      // separator survives only when the label is not just the token again.
      expect(label, `${token} still reads as wire`).not.toContain('_')
      if (/[_-]/.test(token)) {
        expect(label, `${token} was never given a word`).not.toBe(token)
      }
    }
  })

  it('every capability with an icon has a word (neither table outgrows the other)', () => {
    // capabilityIcon returns null for unknowns by design, but a glyph beside a
    // raw token is exactly the defect — so an icon implies a label.
    const iconed = [...androidPanels.matchAll(/^\s{4}"([a-z_]+)" -> Icons\./gm)].map((m) => m[1])
    expect(iconed.length).toBeGreaterThan(20)
    for (const token of iconed) {
      expect(androidLabels.has(token), `${token} has an icon but no word`).toBe(true)
    }
  })

  /**
   * ⚠️⚠️ COMPARING THE TWO PHONES CANNOT SEE WHAT NEITHER PHONE HAS.
   *
   * Every pin above holds iOS and Android against EACH OTHER, so a token both
   * miss is invisible: measured, all four tables held 37 labels / 35 icons, the
   * two phones byte-equal, every "one-phone-only" set empty — and all four were
   * missing `cad`, which the live printer really declares
   * (["chat","telemetry","print","cad"]). Its chip drew a bare acronym with no
   * glyph on both phones, and no pin could fail, because the leader was never in
   * the comparison.
   *
   * So this one compares each table to what a device SENDS. The census is derived
   * from the declaring sources — the same technique as tests/prompt.test.ts's
   * roster pin, which is the web-side sibling of this defect — with a floor per
   * source, because a regex that reads nothing would otherwise pass forever.
   *
   * Endpoint robots are the one kind no source in this repo declares (the
   * machine's own API sends what it likes), so the nearest thing to a declaration
   * is the live printer's asserted list. Deliberately the ASSERTION and not the
   * identical sentence in EndpointPanel.kt's doc comment: a token named in prose
   * declares nothing.
   */
  it('every capability a device DECLARES has a word and a glyph on both phones', () => {
    const DECLARERS: [string, RegExp, number][] = [
      ['ios/Tiny/Sources/Session.swift', /static let capabilities = \[([^\]]+)\]/, 8],
      ['android/app/src/main/java/technology/tiny/app/fleet/FleetManager.kt',
        /private val capabilities = listOf\(([\s\S]*?)\n {4}\)/, 7],
      ['ios/Tiny/Sources/TinySetup.swift', /let caps = isVoice\s*\n\s*\?([\s\S]*?)\n\n/, 8],
      // ⚠️ Anchored on the NEXT statement, not a closing brace: `} else {` is
      // itself 12 spaces + `}`, so a non-greedy run to `\n {12}\}` stops at the
      // first arm and reads a REFERENCE to the Voice list — zero literals.
      ['android/app/src/main/java/technology/tiny/app/ui/Nearby.kt',
        /val caps = if \(isVoice\) \{([\s\S]*?)\n {12}val enrolled/, 6],
      ['android/app/src/main/java/technology/tiny/app/fleet/NiclaVoiceGateway.kt',
        /internal val CAPABILITIES = listOf\(([^)]*)\)/, 4],
      ['android/app/src/test/java/technology/tiny/app/ui/EndpointPanelTest.kt',
        /assertEquals\(\s*\n\s*listOf\(("chat"[^)]*)\),\s*\n\s*parseCapabilities/, 4],
    ]

    const declared = new Set<string>()
    for (const [file, re, floor] of DECLARERS) {
      const m = read(file).match(re)
      expect(m, `${file}'s capability declaration moved — re-anchor this pin rather ` +
        `than leaving it to pass on an empty read`).not.toBeNull()
      const lits = (m![1].match(/"[a-z_0-9]+"/g) ?? []).map((s) => s.slice(1, -1))
      expect(lits.length, `parsed no capabilities out of ${file} — the extractor is reading nothing`)
        .toBeGreaterThanOrEqual(floor)
      for (const c of lits) declared.add(c)
    }
    // flipper_ble is conditional (only while a board is linked), so it is not in
    // any static array above.
    declared.add('flipper_ble')
    expect(declared.size, 'the declarer census collapsed').toBeGreaterThanOrEqual(20)

    // iOS icons: the case labels of capabilityIcon, stopping at its default arm so
    // the sweep cannot run on into the rest of the file.
    // ⚠️⚠️ BOTH ENDS ARE ASSERTED, and the terminator is a PATTERN, not a literal.
    // `indexOf` returns -1 when its literal moves, and `slice(start, -1)` then
    // takes everything to the end of the file — a slice that GREW, sweeping every
    // unrelated `case "…"` in the file while sailing past a length floor. A mutant
    // that merely wrapped `default: return nil` onto two lines proved it: the pin
    // stayed green while reading the wrong region. Reformatting is not a defect, so
    // the repair is to tolerate it (`/\n\s*default:/`) AND to make an absent
    // terminator fail loudly instead of widening the read.
    const swIconAt = iosPanels.indexOf('func capabilityIcon')
    expect(swIconAt, 'capabilityIcon moved — re-anchor this sweep').toBeGreaterThan(-1)
    const swIconRel = iosPanels.slice(swIconAt).search(/\n\s*default:/)
    expect(swIconRel, 'capabilityIcon lost its `default:` arm — without a terminator this ' +
      'sweep would slice to the END OF THE FILE and read unrelated case labels')
      .toBeGreaterThan(0)
    const swIconBody = iosPanels.slice(swIconAt, swIconAt + swIconRel)
    expect(swIconBody.length, 'capabilityIcon body is implausibly short').toBeGreaterThan(200)
    // The ceiling is structural, not a character count: a char budget drifts every
    // time a capability gains a comment, and would eventually fail with the wrong
    // message. If the terminator ever resolves to a LATER function's default arm,
    // the slice swallows whole functions — that is what this catches.
    expect(swIconBody.split('func ').length - 1,
      'the sweep ran past capabilityIcon into another function — it is reading case ' +
      'labels that are not capabilities').toBe(1)
    // ⚠️ ON THE THREE GUARDS ABOVE (terminator, one-function, and the >20 floors
    // below): mutation testing says all three are SUBSUMED — weaken any of them and
    // the declared-token loop at the bottom still fails. That is by construction,
    // and it is the point: `slice(start, start + rel)` FAILS CLOSED (a negative rel
    // yields ""), where the original `slice(start, indexOf(…))` failed OPEN, reading
    // to end-of-file. An empty or wrong sweep therefore cannot satisfy a loop that
    // demands 20 NAMED tokens. They are kept deliberately, as DIAGNOSTICS: without
    // them a moved anchor reports "a device declares chat and iOS draws no glyph"
    // twenty times over, which sends the next reader to add twenty glyphs instead of
    // re-anchoring one regex. Do not delete them as dead weight — but do not trust
    // them as the guard either. The guard is the loop.
    const swIcons = new Set(
      swIconBody.split('\n').filter((l) => l.trim().startsWith('case '))
        .flatMap((l) => (l.split(':')[0].match(/"[a-z_0-9]+"/g) ?? []).map((s) => s.slice(1, -1))),
    )
    // `Array.from`, not a spread: this file targets es5, where spreading an iterator
    // is TS2802. The older pins above predate that and still spread; new ones should
    // not add to the count.
    const ktIcons = new Set(
      Array.from(androidPanels.matchAll(/^\s{4}"([a-z_0-9]+)" -> Icons\./gm), (m) => m[1]),
    )
    for (const s of [swIcons, ktIcons]) expect(s.size).toBeGreaterThan(20)

    for (const cap of Array.from(declared).sort()) {
      for (const [where, table] of [['iOS label', iosLabels], ['Android label', androidLabels]] as const) {
        expect(table.has(cap), `a device declares "${cap}" on the wire and ${where} has no word ` +
          `for it, so its chip renders the RAW TOKEN — and comparing the phones to each ` +
          `other cannot catch this, because both are missing it`).toBe(true)
      }
      for (const [where, table] of [['iOS', swIcons], ['Android', ktIcons]] as const) {
        expect(table.has(cap), `a device declares "${cap}" on the wire and ${where} draws no glyph ` +
          `for it — the chip is a bare word in a strip where every neighbour has an icon`).toBe(true)
      }
    }
  })

  it('the label reaches the screen AND the accessibility layer', () => {
    // Three call sites on iOS; on Android the chip's text and the icon's
    // contentDescription. Mapping only the visible text would leave TalkBack as
    // the last surface still reading identifiers aloud.
    expect(androidPanels).toMatch(/contentDescription = label/)
    expect(androidPanels).toMatch(/Text\(label, style = MaterialTheme\.typography\.labelSmall/)
    // And the raw token must no longer be rendered as the chip's text.
    expect(androidPanels).not.toMatch(/Text\(c, style = MaterialTheme\.typography\.labelSmall/)
  })

  it('both phones sort by the label, with the token as the tiebreak', () => {
    expect(iosPanels).toMatch(/capabilityLabel\(\$0\), capabilityLabel\(\$1\)/)
    expect(androidPanels).toMatch(/compareBy\(\{ capabilityLabel\(it\)\.lowercase\(\) \}, \{ it \}\)/)
    // Android used to not sort at all — the decode site must apply it.
    expect(androidPanels).toMatch(/sortCapabilities\(parseCapabilities\(/)
  })
})

describe('neither strip outweighs the name it sits under', () => {
  // iOS 3ff9d32a capped its ribbon at four and flagged Android as carrying the
  // identical defect: a laptop declaring twelve capabilities (`npx tiny-tech mesh`
  // sends one per resolved device tool) wrapped to several lines of grey words
  // under a one-line name, so the reference half of the row outweighed both
  // answers the row exists to give.
  //
  // The RULE is unit-tested in each language (Swift CapabilityRibbon tests,
  // CapabilityRibbonTest.kt). What neither suite can see is whether the VIEW asks
  // — a cap nothing calls leaves the wall on screen with a green suite either side
  // — and whether the cap silently shortened the SPOKEN row too. Both phones
  // reach the same answer there by opposite means, which is the one place this
  // parity is deliberately NOT byte-identical.

  it('both phones cap at the same number, by the same rule', () => {
    expect(iosPanels).toMatch(/static let cap = 4/)
    expect(androidPanels).toMatch(/const val cap = 4/)
    // `> cap + 1`, not `> cap`: "+1 more" is a chip that hides a chip, so the cap
    // may only fire where it buys back at least two. Drifting this on one phone
    // makes the same fleet read as two different lengths.
    expect(iosPanels).toMatch(/caps\.count > cap \+ 1/)
    expect(androidPanels).toMatch(/caps\.size > cap \+ 1/)
  })

  it('the words drawn are the ones the rule returned, on both phones', () => {
    // The defect shape is a rule that computes and a view that ignores it, so
    // both halves are asserted: adding the call without changing the loop leaves
    // the wall exactly where it was.
    expect(code(androidPanels)).toMatch(/CapabilityRibbon\.split\(d\.capabilities, showAll\)/)
    expect(code(androidPanels)).toMatch(/ribbon\.shown\.forEach \{ c ->/)
    expect(code(androidPanels), 'the Android strip is drawing the whole list again')
      .not.toMatch(/d\.capabilities\.forEach \{ c ->/)
    expect(code(iosPanels)).toMatch(/ForEach\(ribbon\.shown, id: \\\.self\)/)
  })

  it('a capped row says so, counting from the cut that did the hiding', () => {
    // A strip silently cut to four is worse than a long one: nothing on screen
    // would say the device can do anything else. Counting the VISIBLE words
    // instead would make the control vanish on exactly the rows that need it.
    expect(code(androidPanels)).toMatch(/CapabilityRibbon\.toggleLabel\(d\.capabilities, showAll\)/)
    expect(code(androidPanels), 'the Android control is counting the visible words')
      .not.toMatch(/toggleLabel\(ribbon\.shown/)
    expect(code(iosPanels)).toMatch(/CapabilityRibbon\.toggleLabel\(d\.capabilities,/)
    expect(code(iosPanels)).not.toMatch(/toggleLabel\(ribbon\.shown/)
  })

  it('the toggle is per-device state, so a poll cannot collapse it under the user', () => {
    // iOS gets this from `@State` on a row keyed by device id in its ForEach.
    // Compose has no per-row identity to lean on: `items()` REUSES composition
    // slots, so an unkeyed `remember` would hand a ribbon opened on one row to
    // whatever device lands in that slot after the next refresh. `remember(d.id)`
    // is the Android spelling of the same guarantee, and dropping the key is a
    // silent bug — the flag still works, just for the wrong device.
    expect(iosPanels).toMatch(/@State private var showAllCapabilities = false/)
    expect(androidPanels).toMatch(/remember\(d\.id\) \{ mutableStateOf\(false\) \}/)
    expect(androidPanels, 'the Android ribbon flag is not keyed to its device')
      .not.toMatch(/var showAll by remember \{ mutableStateOf\(false\) \}/)
  })

  it('the control looks unlike the words around it, on both phones', () => {
    // Every other word in the strip is grey and SAYS something; this one DOES
    // something. An identical grey word that happens to be tappable is a control
    // nobody finds. And it carries a Button role, or TalkBack announces no
    // affordance at all.
    // Bounded to the control's own `let` block: an unbounded slice runs to the end
    // of a 1750-line file, where `colorScheme.primary` appears dozens of times, so
    // recolouring the chip grey still passed. Measured — that mutant survived the
    // first version of this assertion.
    const strip = code(androidPanels)
    const at = strip.indexOf('CapabilityRibbon.toggleLabel')
    expect(at, 'the Android ribbon control moved — this scrape is stale').toBeGreaterThan(-1)
    const chip = strip.slice(at, strip.indexOf('showAll = !showAll', at))
    expect(chip.length, 'the control block never closes — this scrape is stale').toBeGreaterThan(80)
    expect(chip).toMatch(/color = MaterialTheme\.colorScheme\.primary/)
    expect(chip, 'the Android control is grey like the words it is not')
      .not.toMatch(/color = TinyGray/)
    expect(chip).toMatch(/role = androidx\.compose\.ui\.semantics\.Role\.Button/)
    expect(code(iosPanels).slice(code(iosPanels).indexOf('CapabilityRibbon.toggleLabel')))
      .toMatch(/foregroundStyle\(accent\)/)
  })

  it('⚠️ capping the strip does not shorten the SPOKEN row — by opposite means', () => {
    // The cap is a WIDTH problem and a spoken row has no width, so both phones
    // must still convey every capability. This is where they legitimately DIVERGE:
    //
    //   · iOS merges the row (`.accessibilityElement(children: .combine)`), so one
    //     label speaks for the whole row and it enumerates `d.capabilities` — the
    //     full list — regardless of what is drawn. The cap is free.
    //   · Compose does no such merge here: every capability is its own semantics
    //     node, so hiding a word DOES remove it from TalkBack. Android therefore
    //     has to say the hidden ones itself, which is what toggleDescription is
    //     for — the control reads "can also …" rather than "+8 more".
    //
    // A shared regex would have to be loose enough to match either phone shipping
    // the other's mechanism, which is the failure this pins.
    // Anchored on the STRING and on the merged row, not on where the label is
    // assembled. That distinction is load-bearing: iOS built this string inline at
    // `.accessibilityLabel(` and is moving it into `DeviceOrder.spokenLabel` (the
    // spoken row also has to name the hardware now), so a pin on either spelling
    // is red on one side of that refactor and green on the other — for a guarantee
    // that never changed. What must hold is that iOS enumerates the WHOLE list
    // somewhere, and that the label the merged row actually speaks is not built
    // from the ribbon's visible prefix.
    expect(iosPanels, 'the iOS spoken label no longer enumerates the capabilities')
      .toContain('d.capabilities.map(capabilityLabel).joined(separator: ", ")')
    const iosRow = swiftStruct(iosPanels, 'DeviceRowView')
    const mergeAt = iosRow.indexOf('.accessibilityElement(children: .combine)')
    expect(mergeAt, 'the row no longer merges — every chip speaks for itself now')
      .toBeGreaterThan(-1)
    // Bounded at BOTH ends by construction: the merge modifier is the row's last
    // stanza, and `swiftStruct` already stops at DeviceRowView's closing brace.
    expect(iosRow.slice(mergeAt), 'VoiceOver got the truncated ribbon instead of the fleet')
      .not.toMatch(/ribbon\.shown/)

    expect(code(androidPanels)).toMatch(/CapabilityRibbon\.toggleDescription\(d\.capabilities, showAll\)/)
    expect(code(androidPanels), 'the hidden words never reach TalkBack')
      .toMatch(/contentDescription = it/)
    // The hidden LABELS, not the count and not the tokens.
    const ribbon = androidPanels.slice(androidPanels.indexOf('internal object CapabilityRibbon'))
    expect(ribbon).toMatch(/hidden\.joinToString\(", "\) \{ capabilityLabel\(it\) \}/)
  })

  it('the action and the content are different sentences on Android', () => {
    // TalkBack speaks onClickLabel as "double tap to <label>" and
    // contentDescription as the element's own text. Putting the capability list in
    // the action slot announces "double tap to can also speaks, shell" — so the
    // two strings are separate functions, and the pin is that the view uses each
    // in its own slot.
    // Bounded like the pin above, and for the same measured reason.
    const strip = code(androidPanels)
    const at = strip.indexOf('CapabilityRibbon.toggleLabel')
    const chip = strip.slice(at, strip.indexOf('showAll = !showAll', at))
    expect(chip).toMatch(/onClickLabel = CapabilityRibbon\.toggleAction\(showAll\)/)
    expect(chip, 'the capability list is announced as an action')
      .not.toMatch(/onClickLabel = CapabilityRibbon\.toggleDescription/)
  })

  it('the rule stays pure on both phones, so neither needs a device to test it', () => {
    const ribbon = androidPanels.slice(
      androidPanels.indexOf('internal object CapabilityRibbon'),
      androidPanels.indexOf('\n}\n', androidPanels.indexOf('internal object CapabilityRibbon')),
    )
    expect(ribbon.length).toBeGreaterThan(400)
    expect(ribbon).not.toMatch(/@Composable|remember|mutableStateOf|DeviceRow/)
  })
})

describe('neither phone speaks for a necklace it cannot hear', () => {
  // iOS f6ed86f7. `VoiceStatus` is a LAST-KNOWN reading on both phones: each
  // gateway clears it in `forget()` only — never on disconnect, deliberately,
  // because a wake delivered over a link that dropped a second later still has to
  // reach the row. So each panel drew "out of range" and, on the same line, a
  // green "listening": the one element written in the present tense was the one
  // element that outlived the link. A necklace in a drawer looked like a necklace
  // on a collar.
  //
  // The tell was in both files — the detail line beside the badge
  // ("3 wake words · 12 heard · up 11h") HAD the connected check and correctly
  // went away. One object, two readings, and only the live claim was ungated.

  it('the premise still holds: neither gateway clears status on disconnect', () => {
    // The whole fix rests on this. If a gateway ever DID clear the reading when
    // the link dropped, the gate would be dead code — and if only one of them
    // did, the two panels would need different fixes. Both clear in forget()
    // only; both set connected = false on disconnect and leave the reading.
    const ktForget = ktFun(androidGateway, 'forget')
    expect(ktForget, 'Android forget() stopped clearing the reading').toMatch(/_status\.value = null/)
    expect(code(androidGateway)).toMatch(/STATE_DISCONNECTED ->[\s\S]{0,400}?_connected\.value = false/)
    expect(
      code(androidGateway).slice(code(androidGateway).indexOf('STATE_DISCONNECTED ->')),
      'Android now clears status on disconnect — the gate may be dead code',
    ).not.toMatch(/^[\s\S]{0,400}?_status\.value = null/)
    expect(iosGateway).toMatch(/func forget\(\)[\s\S]{0,600}?status = nil/)
  })

  it('both gates are the same one-line decision, and both are pure', () => {
    // Pure on purpose: a gate that reached for the gateway singleton could not be
    // unit-tested on either phone, and this decision is the whole fix.
    expect(iosPanels).toMatch(/static func live\(_ s: VoiceStatus\?, connected: Bool\) -> VoiceStatus\?/)
    expect(androidPanels).toMatch(
      /internal fun liveVoiceStatus\(s: VoiceStatus\?, connected: Boolean\): VoiceStatus\? =\s*\n\s*if \(connected\) s else null/,
    )
    const ktGate = androidPanels.slice(androidPanels.indexOf('internal fun liveVoiceStatus'))
    expect(ktGate.slice(0, ktGate.indexOf('\n\n')))
      .not.toMatch(/NiclaVoiceGateway|collectAsState|@Composable/)
  })

  it('EVERY status read in each panel goes through the gate', () => {
    // COUNTED, not spot-checked: the bug was one ungated read among two, so "a
    // call to the gate exists somewhere in the panel" is exactly the assertion
    // that would have passed on the broken panel.
    const ktPanel = code(ktFun(androidPanels, 'VoiceDevicePanel'))
    // ⚠️ TOTAL, not a fixed count: this was `toBe(2)` and went red the moment a third
    // gated read landed (the reading's age line), which is a pin that fails on
    // correct work and says nothing about an incorrect one. Every `status` the panel
    // reads is either the collect line that produces it or a read through the gate —
    // so the two counts move together and a new ungated read still breaks it. `\b`
    // keeps `statusAt` out: that flow is a TIMESTAMP, gated by the reading it dates
    // rather than by the link.
    const ktReads = ktPanel.match(/\bstatus\b/g)?.length ?? 0
    const ktCollect = ktPanel.match(/val status by gw\.status\.collectAsState\(\)/g)?.length ?? 0
    const ktGated = ktPanel.match(/liveVoiceStatus\(status, connected\)/g)?.length ?? 0
    expect(ktCollect, 'the Android panel stopped collecting status — did the badge go?').toBe(1)
    expect(ktGated, 'the Android panel stopped gating status at all').toBeGreaterThan(1)
    // The collect line mentions it twice (`val status by gw.status`); every other
    // mention must be a gate call.
    expect(ktReads - 2 * ktCollect, 'the Android panel reads status without the gate').toBe(ktGated)
    expect(ktPanel, 'the Android badge is reading last-known status again')
      .not.toMatch(/[^e]status\?\.let \{ s ->/)
    expect(ktPanel, 'the old hand-rolled gate is back beside the new one')
      .not.toMatch(/status\?\.takeIf \{ connected \}/)

    const iosPanel = code(swiftStruct(iosPanels, 'VoiceDevicePanel'))
    const reads = iosPanel.match(/gw\.status/g)?.length ?? 0
    const gated = iosPanel.match(/VoiceFmt\.live\(gw\.status, connected: gw\.connected\)/g)?.length ?? 0
    expect(reads, 'the iOS panel stopped reading status at all — did the badge go?').toBeGreaterThan(1)
    expect(gated, 'an ungated status read is back in the iOS panel').toBe(reads)
  })

  it('the badge still tells deaf apart from listening, on both phones', () => {
    // The fix must not swallow the badge whenever it is inconvenient: a loaded
    // board with a dead mic advertises, looks online, and never hears anything,
    // and this badge is the only surface that catches it. Only the LINK gates the
    // reading — never the reading's own content.
    expect(androidPanels).toMatch(/if \(s\.listening\) "listening" else "not listening"/)
    expect(iosPanels).toMatch(/Label\(s\.listening \? "listening" : "not listening",/)
  })

  it('history is not gated — a wake that happened, happened', () => {
    // Timestamped events stay true after the link drops, and gating them would
    // erase the wake list every time the necklace left the room. Only the
    // present-tense reading is withheld.
    const ktPanel = code(ktFun(androidPanels, 'VoiceDevicePanel'))
    expect(ktPanel).toMatch(/if \(wakes\.isNotEmpty\(\)\)/)
    expect(ktPanel, 'the Android wake history got gated on the live link')
      .not.toMatch(/liveVoiceStatus\(wakes|wakes\.takeIf \{ connected \}/)
    const iosPanel = code(swiftStruct(iosPanels, 'VoiceDevicePanel'))
    expect(iosPanel).toMatch(/if !gw\.wakes\.isEmpty \{/)
    expect(iosPanel, 'the iOS wake history got gated on the live link')
      .not.toMatch(/VoiceFmt\.live\(gw\.wakes/)
  })

  it('each panel still says WHY it has nothing to report', () => {
    // A withheld badge is only honest next to a line that explains the silence —
    // the same rule the camera panel's asleep state follows. Without this the fix
    // reads as a panel that lost an element.
    expect(androidPanels).toMatch(/if \(connected\) "relayed by this phone" else "out of range"/)
    expect(iosPanels).toMatch(/Text\(gw\.connected \? "relayed by this phone" : "out of range"\)/)
  })
})

describe('a camera that failed says why, on both phones', () => {
  // iOS 0c924248 named this gap in its own commit message: Android's
  // RelayCameraPanel was a WHOLE VERSION behind, because fetchFrame returned a
  // bare nullable — so all five failures rendered as the untouched "tap to peek"
  // placeholder, indistinguishable from a row nobody had tapped.
  const androidLive = read('android/app/src/main/java/technology/tiny/app/fleet/TinyLive.kt')
  const iosLive = read('ios/Tiny/Sources/TinyLive.swift')

  it('both phones carry the same five reasons', () => {
    // Scraped, not listed, so a sixth failure on one phone fails here.
    const ios = new Set(
      [...iosLive.matchAll(/^\s{8}case (relayRefused|noReply|deviceSaid|undecodable|cancelled)/gm)]
        .map((m) => m[1].toLowerCase()),
    )
    expect(ios.size).toBe(5)
    // Scoped to the DECLARATION, not the whole file: a deleted case that is
    // still referenced from frameResult would otherwise read as present.
    const start = androidLive.indexOf('sealed class FrameFailure')
    const body = androidLive.slice(start, androidLive.indexOf('\n}', start))
    const kt = new Set(
      [...body.matchAll(/^\s{4}(?:data class|object) (\w+)/gm)].map((m) => m[1].toLowerCase()),
    )
    // Both directions: a sixth reason on either phone is drift too.
    expect(kt).toEqual(ios)
  })

  it('the fetch returns a REASON, and the streaming loop still gets its nullable', () => {
    // Two callers, two shapes: the panel needs the sentence, the ~20fps loop has
    // nowhere to put one and retries on its own schedule.
    expect(androidLive).toMatch(/suspend fun frameResult\(/)
    expect(androidLive).toMatch(/suspend fun fetchFrame\([^)]*\): Bitmap\? =/)
    expect(iosLive).toMatch(/-> Result<UIImage, FrameFailure>/)
    expect(iosLive).toMatch(/-> UIImage\? \{/)
  })

  it('an answer without an image never falls through to the timeout', () => {
    // The bug worth the most: a board replying "no camera on this device" was
    // reported as no frame having arrived, after burning the full poll budget.
    expect(androidLive).toMatch(/is FrameAnswer\.Words -> return FrameResult\.Failure\(FrameFailure\.DeviceSaid/)
    expect(iosLive).toMatch(/case \.words\(let said\):[\s\S]{0,80}\.deviceSaid\(said\)/)
  })

  it('a bare JSON string payload is parsed as an answer on both phones', () => {
    // Legal on this wire (the worker validates with JS JSON.parse). iOS needs
    // .fragmentsAllowed; Kotlin needs JSONTokener, because JSONObject() throws.
    expect(iosLive).toMatch(/options: \[\.fragmentsAllowed\]/)
    expect(androidLive).toMatch(/JSONTokener\(payload\)\.nextValue\(\)/)
    // Both unwrap the same keys, in the same order.
    expect(iosLive).toMatch(/\["result", "text", "output", "error"\]/)
    expect(androidLive).toMatch(/listOf\("result", "text", "output", "error"\)/)
  })

  it('the poll budget matches, so "No frame in Ns" means the same thing', () => {
    const iTries = Number(/framePollTries = (\d+)/.exec(iosLive)?.[1])
    const iEvery = Number(/framePollEvery = ([\d.]+)/.exec(iosLive)?.[1])
    const aTries = Number(/FRAME_POLL_TRIES = (\d+)/.exec(androidLive)?.[1])
    const aEvery = Number(/FRAME_POLL_EVERY_MS = ([\d_]+)L/.exec(androidLive)?.[1].replace(/_/g, ''))
    expect(aTries).toBe(iTries)
    expect(aEvery / 1000).toBe(iEvery)
  })

  it('a failure does not wear the footprint of a success', () => {
    // 130dp of black is what a FRAME looks like. When every state wore it, the
    // largest, loudest element on the devices sheet was a camera that had
    // FAILED — bigger than the device's own name, once per necklace.
    // On Android the black window is now inside the `bmp != null` arm only.
    const panel = androidPanels.slice(
      androidPanels.indexOf('internal fun RelayCameraPanel'),
      androidPanels.indexOf('internal fun voiceUptime'),
    )
    expect(panel.indexOf('val bmp = frame')).toBeGreaterThan(-1)
    const height = panel.indexOf('height(130.dp)')
    const elseArm = panel.indexOf('} else {')
    expect(height, 'the 130dp window escaped the frame arm').toBeLessThan(elseArm)
  })

  it('the retry is a control, not prose glued on with a separator', () => {
    // `·` is this app's separator for TERMINATOR-FREE fragments ("online ·
    // daemon · ios-arm64"), and three of the five messages are whole sentences.
    // "Couldn't reach the relay. · tap to retry" put a separator after a full
    // stop — and deviceSaid("camera busy") has no punctuation to strip, so no
    // client-side fix could have been right either.
    const panel = androidPanels.slice(
      androidPanels.indexOf('internal fun RelayCameraPanel'),
      androidPanels.indexOf('internal fun voiceUptime'),
    )
    expect(panel).toMatch(/TextButton\(\s*onClick = \{ refresh\(asked = true\) \}/)
    // Against CODE, not comments: the fix documents the string it replaced by
    // quoting it, so a whole-file scan would flag its own explanation — the same
    // reason the uptime pin above strips comments before scanning.
    expect(code(panel)).not.toMatch(/tap to retry/)
    expect(iosPanels).toMatch(/Button\("Retry"\) \{ refresh\(asked: true\) \}/)
    expect(code(iosPanels)).not.toMatch(/· tap to retry/)
  })

  it('the reason wraps instead of being clipped, on both phones', () => {
    // At a large text size the reason and the hint competed for one line and
    // whichever lost got an ellipsis — of the one string the panel exists to
    // show. iOS: fixedSize(vertical:); Compose wraps by default, so what has to
    // hold is that neither render site caps its lines.
    const panel = androidPanels.slice(
      androidPanels.indexOf('internal fun RelayCameraPanel'),
      androidPanels.indexOf('internal fun voiceUptime'),
    )
    expect(panel).not.toMatch(/maxLines/)
    expect(panel).not.toMatch(/TextOverflow\.Ellipsis/)
    // `why`, not `error`: the card now binds the reason out of PeekShape, which
    // decides whether a failure gets the card at all (iOS-only so far — see
    // ios-peek-provenance).
    expect(iosPanels).toMatch(/Text\(why\)\.fixedSize\(horizontal: false, vertical: true\)/)
  })

  it('a failed refresh keeps the last good frame and still reports why', () => {
    // The placeholder can only speak when it's on screen; a refresh that fails
    // over a live frame would otherwise swallow the reason all over again.
    const panel = androidPanels.slice(
      androidPanels.indexOf('internal fun RelayCameraPanel'),
      androidPanels.indexOf('internal fun voiceUptime'),
    )
    expect(panel).toMatch(/if \(error != null && frame != null\)/)
    expect(iosPanels).toMatch(/if let error, frame != nil/)
    // And neither clears the bitmap on failure.
    expect(panel).not.toMatch(/frame = null/)
    // The failure arm must actually STORE the reason. Rendering it in two places
    // is worth nothing if the handler drops it on the floor — which is the exact
    // shape of the bug being fixed, one layer up.
    expect(panel).toMatch(/FrameResult\.Failure ->\s*\n?\s*error = r\.why\.message/)
    // Empty means Cancelled (the panel left the screen), which is not a fault to
    // report — so it becomes no error rather than a blank orange line.
    expect(panel).toMatch(/takeIf \{ it\.isNotEmpty\(\) \}/)
    expect(iosPanels).toMatch(/error = why\.message\.isEmpty \? nil : why\.message/)
  })

  it('the frame itself announces that it can be tapped', () => {
    // An Image carries no affordance of its own, so the one element on screen a
    // screen-reader user could act on announced nothing at all.
    const panel = androidPanels.slice(
      androidPanels.indexOf('internal fun RelayCameraPanel'),
      androidPanels.indexOf('internal fun voiceUptime'),
    )
    expect(panel).toMatch(/role = androidx\.compose\.ui\.semantics\.Role\.Button/)
    expect(panel).toMatch(/onClickLabel = "fetch a new frame"/)
    // The placeholder's own affordance moved INTO the rule, because it is the one
    // string that has to vary with the shape: "peek at the camera" is already the
    // label for an idle row, so repeating it as a hint made TalkBack read it
    // twice, while a row showing the board's own words has no affordance in them
    // at all. `PeekShapeTest` pins both words; this pins that the panel asks.
    expect(panel).toMatch(/onClickLabel = peek\.spokenHint/)
    expect(code(read('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')))
      .toMatch(/Idle -> "peek at the camera"/)
    expect(iosPanels).toMatch(/accessibilityLabel\("Latest camera frame"\)/)
  })

  it('the amber for "not an error, but do not trust it" is one hex, not two', () => {
    // It lived in Chain.kt as a private val marked "local to this screen on
    // purpose" until a second screen needed it. Two copies is how two ambers
    // drift apart.
    const theme = read('android/app/src/main/java/technology/tiny/app/ui/theme/Theme.kt')
    expect(theme).toMatch(/val TinyWarn = Color\(0xFFFFB020\)/)
    const chain = read('android/app/src/main/java/technology/tiny/app/ui/Chain.kt')
    expect(chain).not.toMatch(/val ChainWarn/)
    expect(chain).toMatch(/import technology\.tiny\.app\.ui\.theme\.TinyWarn/)
  })
})

describe('the live view aims at the necklace that will actually answer', () => {
  // iOS 6e513e24. Taking the FIRST nicla-vision row leaned on /api/devices
  // ordering, which the contract does not promise — and a re-enrolled board
  // (wiped flash; the API mints a device token exactly once) leaves an orphan
  // row behind forever: permanently offline, never reprovisionable, only
  // revocable. Aiming at it costs the whole session on BOTH phones: the remote
  // loop burns every retry on a device that will never answer, and the relay
  // `stream` discovery never returns a LAN base, so the 20fps fast path is
  // never even tried while a healthy necklace serves MJPEG one hop away.
  const androidLive = read('android/app/src/main/java/technology/tiny/app/fleet/TinyLive.kt')
  const iosLive = read('ios/Tiny/Sources/TinyLive.swift')

  it('neither phone takes whichever row the registry happened to list first', () => {
    // The shape of the bug, in the words each language used for it.
    expect(code(iosLive)).not.toMatch(/list\.first\(where: \{ \(\$0\["platform"\] as\? String\) == "nicla-vision" \}\)/)
    expect(code(androidLive)).not.toMatch(/if \(dev\.optString\("platform"\) == "nicla-vision"\) return/)
  })

  it('both order online-first, then freshest heartbeat', () => {
    // Two keys, in this precedence: an offline row can carry a NEWER last_seen
    // than an online one (seen seconds before it dropped off), and online must
    // still win — the question is who answers the NEXT invoke.
    expect(androidLive).toMatch(
      /compareByDescending<Row> \{ it\.online \}\s*\.thenByDescending \{ it\.seen \}/,
    )
    expect(iosLive).toMatch(/if aOn != bOn \{ return aOn \}/)
    expect(iosLive).toMatch(/return seen\(a\) > seen\(b\)/)
  })

  it("last_seen is read wide enough for a daemon that writes milliseconds", () => {
    // Measured with org.json 20240303: optInt(1754100000000) = 1753343232 and
    // optInt(1754494200000) = -2147424064 — epoch ms wrap NEGATIVE through an
    // Int, which inverts the ordering and picks the staler board. Android reads
    // a Double; iOS reads Double-or-Int for the same reason.
    expect(androidLive).toMatch(/optDouble\("last_seen", 0\.0\)/)
    expect(androidLive).not.toMatch(/opt(Int|Long)\("last_seen"/)
    expect(iosLive).toMatch(/\(d\["last_seen"\] as\? Double\) \?\? Double\(d\["last_seen"\] as\? Int \?\? 0\)/)
  })

  it('the ordering is pure on Android, so it is pinnable without a registry', () => {
    // Which row wins should not need a network to test. iOS keeps it inside the
    // async findDeviceId (its pins live in the Swift suite), so this asymmetry
    // is deliberate rather than drift.
    expect(androidLive).toMatch(/internal fun pickNicla\(devices: JSONArray\): String\?/)
    expect(androidLive).toMatch(/pickNicla\(d\.optJSONArray\("devices"\)/)
  })

  it('a row with no id never wins, on either phone', () => {
    // Returning "" is worse than returning nothing: the caller reads a non-null
    // id as "found it" and relays into the void for the rest of the session.
    expect(androidLive).toMatch(/if \(id\.isEmpty\(\)\) continue/)
    // iOS returns a FoundDevice now (it also carries the board's LAN address), so
    // the id is bound in the same guard that picks the row: no id, no device, and
    // the optional return is what the caller checks. The old shape returned the
    // subscript directly, which was the same property expressed as a String?.
    expect(iosLive).toMatch(/\.first, let id = best\["id"\] as\? String\s*\n\s*else \{ return nil \}/)
    expect(iosLive).toMatch(/return FoundDevice\(id: id,/)
  })

  it('a base that stopped answering is forgotten, not re-probed forever', () => {
    // DHCP hands the board a new address across reboots. iOS ALSO had to drop
    // it because toggleAudio() dialed the cached key without probing; Android's
    // every read is probe-guarded, so there the cost is wasted seconds rather
    // than a wrong dial — a smaller fix, deliberately.
    expect(androidLive).toMatch(/cachedBase = null/)
    expect(iosLive).toMatch(/UserDefaults\.standard\.removeObject\(forKey: Self\.cachedURLKey\)/)
  })

  it('a failed probe leaves a trace instead of a silent fallback to the cloud', () => {
    // Every cause — asleep board, wrong subnet, moved address, a platform
    // refusing the dial — collapsed into one silent false, and the only symptom
    // was the live view quietly preferring the cloud. iOS read that as a
    // firmware fault for a long time.
    expect(androidLive).toMatch(/Log\.w\("TinyLive", "LAN probe of \$base failed/)
  })
})

describe('the necklace keeps working with the phone in a pocket', () => {
  // iOS 3c969817: bluetooth-central was undeclared, so iOS suspended the
  // gateway's central on backgrounding and a necklace under a coat went silent.
  // Android's version of the bug was self-inflicted — onStop dropped the link
  // unconditionally, citing iOS's scenePhase parity, which was iOS's CONSTRAINT
  // rather than a rule worth copying.
  const androidRelay = read('android/app/src/main/java/technology/tiny/app/fleet/RelayService.kt')
  const androidMain = read('android/app/src/main/java/technology/tiny/app/MainActivity.kt')
  const androidManifest = read('android/app/src/main/AndroidManifest.xml')
  const iosPlist = read('ios/Tiny/Info.plist')

  it('iOS declares bluetooth-central, not just peripheral', () => {
    // The glasses act as peripheral; the Nicla gateway is a CENTRAL. Different
    // mode, not covered by the other line.
    expect(iosPlist).toContain('bluetooth-central')
    expect(iosPlist).toContain('bluetooth-peripheral')
  })

  it('the always-on service holds the necklace link, so the OS cannot suspend it', () => {
    expect(androidRelay).toMatch(/NiclaVoiceGateway\.start\(this\)/)
  })

  it('backgrounding no longer drops the link when a gateway can outlive the Activity', () => {
    expect(androidMain).toMatch(/if \(!app\.config\.alwaysOn\) technology\.tiny\.app\.fleet\.NiclaVoiceGateway\.stop\(\)/)
    // The unconditional stop is the regression to guard against.
    expect(androidMain).not.toMatch(/^\s+technology\.tiny\.app\.fleet\.NiclaVoiceGateway\.stop\(\)$/m)
  })

  it('neither owner drops a link the other still needs', () => {
    // Service teardown while the app is on screen must hand back, not kill.
    expect(androidRelay).toMatch(/if \(!app\.fleet\.foreground\) NiclaVoiceGateway\.stop\(\)/)
  })

  it('holding a GATT link is declared as connectedDevice, not just dataSync', () => {
    // API 34+ throws if startForeground passes a type the manifest omits, and
    // dataSync does not cover owning a device connection.
    expect(androidManifest).toContain('FOREGROUND_SERVICE_CONNECTED_DEVICE')
    expect(androidManifest).toMatch(/foregroundServiceType="dataSync\|connectedDevice"/)
    expect(androidRelay).toMatch(/FOREGROUND_SERVICE_TYPE_DATA_SYNC or\s*\n\s*ServiceInfo\.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE/)
  })
})

describe('setup: the board echoes our own writes, and neither phone acts on them', () => {
  // ArduinoBLE notifies subscribers on a CENTRAL write too, so a 4-chunk config
  // write arrives back as four truncated notifies BEFORE the verdict. Android
  // was worse off than iOS here: its parser failed on the fragment and reported
  // "device rejected the configuration" on a perfectly healthy board.
  it('a verdict must carry "ok" — arrival order is never trusted', () => {
    // iOS: guard on obj["ok"] != nil before finish().
    expect(iosSetup).toMatch(/obj\["ok"\] != nil/)
    // Android: same gate, expressed as JSONObject.has("ok").
    expect(androidSetup).toMatch(/reply\.has\("ok"\)/)
    // Both drop a non-verdict notify instead of failing the attempt.
    expect(androidSetup).toMatch(/if \(reply == null \|\| !reply\.has\("ok"\)\) return/)
  })

  it('notifies outside the write window are ignored on both phones', () => {
    expect(iosSetup).toMatch(/case \.writing, \.waiting: break/)
    expect(androidSetup).toMatch(/_phase\.value != "writing" && _phase\.value != "waiting"\) return/)
  })

  it('a verdict that never comes is a watchdog, not a hang', () => {
    // The echo guard can only be safe because a deadline owns the wait.
    expect(androidSetup).toMatch(/arm\(20_000,/)
    expect(iosSetup).toMatch(/arm\(20,/)
  })
})

describe('setup: link before enroll, so a failed attempt orphans nothing', () => {
  // POST /api/devices returns the device token exactly ONCE. Enrolling before
  // the board answers minted a registry row per failed attempt whose token was
  // lost the moment it was issued — unprovisionable, only revocable.
  it('both phones link first and abandon before touching the registry', () => {
    expect(iosSetup).toMatch(/guard await prov\.link\(beaconId: beacon\.id\) else \{ return \}/)
    expect(androidSetup).toMatch(/suspend fun link\(/)
    expect(androidNearby).toMatch(/if \(!TinyProvisioner\.link\(context, beacon\.address\)\) \{[^}]*return@launch \}/)
  })

  it('the link call precedes the enrollment POST in source order', () => {
    const link = androidNearby.indexOf('TinyProvisioner.link(')
    const enroll = androidNearby.indexOf('"/api/devices"')
    const send = androidNearby.indexOf('TinyProvisioner.send(')
    expect(link).toBeGreaterThan(-1)
    expect(enroll).toBeGreaterThan(link)
    expect(send).toBeGreaterThan(enroll)
  })

  it('an enrollment that fails after linking releases the link', () => {
    // Otherwise the GATT connection (and its watchdog) outlives the attempt.
    expect(androidNearby).toMatch(/Could not enroll the device[\s\S]{0,120}TinyProvisioner\.reset\(\)/)
  })
})

describe('setup: the account bearer stays off the wearable', () => {
  // The firmware retired it — tiny_upload authenticates with the device token,
  // which is scoped to one board and revocable from the Devices panel. An
  // account-wide JWT in a wearable's flash was authority it never needed.
  it('neither phone puts a bearer in the BLE config', () => {
    expect(androidNearby).not.toMatch(/put\("bearer"/)
    expect(iosSetup).not.toMatch(/config\["bearer"\]/)
    // Config keys are identity + name (+ wifi on a Vision), nothing more.
    const keys = [...androidNearby.matchAll(/\.put\("(device_id|token|name|bearer)"/g)].map((m) => m[1])
    expect(new Set(keys)).toEqual(new Set(['device_id', 'token', 'name']))
  })
})

describe('setup: a config too big for the board is refused before it flies', () => {
  // The two boards do NOT share a buffer: Vision 1024 bytes (tiny_ble.py),
  // Voice 256 (TV_CFG_MAX in tiny_voice.ino) — one sheet provisions both.
  it('both phones carry per-board ceilings, and the Voice’s is the smaller', () => {
    const aVision = Number(/CONFIG_LIMIT_VISION = (\d+)/.exec(androidSetup)?.[1])
    const aVoice = Number(/CONFIG_LIMIT_VOICE = (\d+)/.exec(androidSetup)?.[1])
    const iVision = Number(/tinyConfigLimitVision = (\d+)/.exec(iosSetup)?.[1])
    const iVoice = Number(/tinyConfigLimitVoice = (\d+)/.exec(iosSetup)?.[1])
    expect(aVision).toBe(iVision)
    expect(aVoice).toBe(iVoice)
    expect(aVoice).toBeLessThan(aVision)
  })

  it('the size check happens before the first write, on both phones', () => {
    expect(androidSetup).toMatch(/if \(json\.size > limit\)/)
    expect(iosSetup).toMatch(/guard json\.count <= limit/)
    // And the caller picks the ceiling by board, not by default.
    expect(androidNearby).toMatch(/if \(isVoice\) TinyProvisioner\.CONFIG_LIMIT_VOICE else TinyProvisioner\.CONFIG_LIMIT_VISION/)
    expect(iosSetup).toMatch(/limit: isVoice \? tinyConfigLimitVoice : tinyConfigLimitVision/)
  })
})

describe('a device row says what the hardware IS, on both phones', () => {
  // iOS 97960ddb + 2595ebc0. The second line was the last wire text on the sheet:
  // "online · daemon · ios-arm64", "reachable when called · endpoint · bambu".
  // Android had the same line MINUS the platform — "daemon · online" — so every
  // phone, Mac and laptop it enrols read "daemon", plus three bugs iOS also had:
  // presence collapsed to a boolean, `url` decoded nowhere, and presence second.
  const platformTable = (src: string, open: RegExp, close: string, pair: RegExp) => {
    const start = src.search(open)
    expect(start, 'the platform-name table moved — this scrape is stale').toBeGreaterThan(-1)
    const end = src.indexOf(close, start)
    expect(end, 'the table never closes — this scrape is stale').toBeGreaterThan(start)
    return [...src.slice(start, end).matchAll(pair)].map((m) => [m[1], m[2]] as [string, string])
  }
  // Ordered ARRAYS, not Maps: the order is the algorithm (see below), so a Map
  // here would discard the very property most worth pinning.
  const iosNames = platformTable(
    iosPanels, /let DEVICE_PLATFORM_NAME/, '\n]', /\("([a-z0-9-]+)", "([^"]+)"\),/g,
  )
  const androidNames = platformTable(
    androidPanels, /val DEVICE_PLATFORM_NAME/, '\n)', /"([a-z0-9-]+)" to "([^"]+)",/g,
  )
  const iosKinds = platformTable(
    iosPanels, /let DEVICE_KIND_NAME/, '\n]', /"([a-z]+)": "([^"]+)",/g,
  )
  const androidKinds = platformTable(
    androidPanels, /val DEVICE_KIND_NAME/, '\n)', /"([a-z]+)" to "([^"]+)",/g,
  )

  it('both phones map the same platform tokens to the same words', () => {
    // Sanity first: a zero-match scrape would pass the equality vacuously.
    expect(iosNames.length).toBeGreaterThan(7)
    expect(androidNames).toEqual(iosNames)
  })

  it('both phones translate the same kinds the same way', () => {
    expect(iosKinds.length).toBeGreaterThan(3)
    expect(new Map(androidKinds)).toEqual(new Map(iosKinds))
  })

  it('the ipad needle precedes ios on BOTH phones, or an iPad reads as iOS', () => {
    // "ipados" CONTAINS "ios", and both implementations match by substring in
    // table order — so this ordering is load-bearing on each phone independently.
    //
    // Swift's Dictionary iterates in UNSPECIFIED order, which is why iOS's table
    // is an array of tuples: as a dictionary the iPad label becomes a coin flip
    // per launch. Kotlin is the asymmetric case — `mapOf` returns a
    // LinkedHashMap, so an Android Map would preserve insertion order and behave
    // identically (measured: converting the table to `mapOf` + `entries` left
    // both suites green). The List<Pair> there is for parity with iOS and to
    // keep one shape scrapeable by this test, not for correctness.
    for (const [phone, names] of [['ios', iosNames], ['android', androidNames]] as const) {
      const needles = names.map(([needle]) => needle)
      expect(needles, `${phone} lost the ipad needle`).toContain('ipad')
      expect(
        needles.indexOf('ipad'),
        `${phone}: ipad no longer precedes ios — an iPad now reads "iOS"`,
      ).toBeLessThan(needles.indexOf('ios'))
    }
  })

  it('presence is three states on both phones, not a boolean', () => {
    // The bug that made a working printer look broken: the worker sends
    // `online: null` for endpoint kinds (devices.ts:294), and both phones used
    // to flatten it to false, so a healthy robot read "seen never" under a grey
    // dot. Neither phone may go back to a non-optional presence field.
    expect(iosPanels).toMatch(/enum DevicePresence \{\n\s+case online, offline, unknown/)
    expect(androidPanels).toMatch(/enum class DevicePresence \{ ONLINE, OFFLINE, UNKNOWN \}/)
    expect(iosPanels).toMatch(/let online: Bool\?/)
    expect(androidPanels).toMatch(/val online: Boolean\?/)
  })

  it('each phone reads null with the API that can actually SEE null', () => {
    // Both languages have a trap here, and they are different traps. Swift's
    // `as? Bool` on NSNull yields nil, which is right by accident — so iOS tests
    // `is NSNull` explicitly. Kotlin's optBoolean CANNOT distinguish
    // JSONObject.NULL (a sentinel OBJECT) from a real false, so `isNull` is the
    // only correct read and a lone optBoolean here re-lands the bug silently.
    expect(iosPanels).toMatch(/if raw is NSNull \{ return nil \}/)
    expect(androidPanels).toMatch(/if \(d\.isNull\("online"\)\) null else d\.optBoolean\("online"\)/)
  })

  it("the endpoint's presence word never claims a heartbeat", () => {
    // "reachable when called" is the only honest thing to say about a device
    // that answers when dialled and is silent otherwise. Same words on both
    // phones — this string is read aloud by VoiceOver and TalkBack.
    expect(iosPanels).toContain('"reachable when called"')
    expect(androidPanels).toContain('"reachable when called"')
  })

  it('a robot names its host, scheme stripped, on both phones', () => {
    // A robot is the one device class with NO platform on the wire — the enroll
    // form posts {name, kind} only — so without `url` its row could only restate
    // its own icon. Android was not decoding url at all.
    expect(androidPanels).toMatch(/url = d\.optString\("url"\)/)
    expect(androidPanels).toMatch(/host\.removePrefix\("https:\/\/"\)/)
    expect(iosPanels).toMatch(/host\.hasPrefix\("https:\/\/"\) \? String\(host\.dropFirst\(8\)\) : host/)
  })

  it('presence leads the line and the descriptor follows, on both phones', () => {
    // Order matters: the descriptor is a constant for the life of the device and
    // presence is the thing that changes, so presence first is what makes a list
    // of rows scannable. Both assemble ONE string, joined by " · ", and both drop
    // the separator when the descriptor is empty rather than trailing a bullet.
    expect(iosPanels).toMatch(/\[presence\.label\(lastSeen: lastSeen\), descriptor\]/)
    expect(androidPanels).toMatch(/listOf\(presence, deviceDescriptor\(d\)\)/)
    // Each language's own spelling of "drop the empties, then join" — a shared
    // regex here would have to be loose enough to match either half-written.
    expect(iosPanels).toMatch(/\.filter \{ !\$0\.isEmpty \}\s*\n\s*\.joined\(separator: " · "\)/)
    expect(androidPanels).toMatch(/\.filter \{ it\.isNotEmpty\(\) \}\.joinToString\(" · "\)/)
  })

  it('the wire words are gone from both rows', () => {
    // The old Android line, and the old iOS one. If either expression comes
    // back, the row is printing identifiers at its owner again.
    expect(code(androidPanels)).not.toMatch(/deviceSubtitle/)
    expect(code(iosPanels)).not.toMatch(/\bkind\b\s*\+\s*" · "/)
  })

  it('an unrecognised platform still speaks, without underscores', () => {
    // Same rule capabilityLabel follows: a newer daemon must not be silenced,
    // but it never speaks in wire punctuation. And a literal "?" — what the CLI
    // posts when it cannot identify itself — must not reach the row as hardware.
    expect(androidPanels).toMatch(/replace\('_', ' '\)\.replace\('-', ' '\)/)
    expect(iosPanels).toMatch(/replacingOccurrences\(of: "_", with: " "\)/)
    expect(androidPanels).toMatch(/p != "\?"/)
    expect(iosPanels).toMatch(/p != "\?"/)
  })

  it('the dot is decoration, because the words beside it say the same thing', () => {
    // Both phones hide the glyph from the accessibility layer: a screen reader
    // announcing "offline" from the dot and "reachable when called" from the
    // line would contradict itself out loud on every robot's row.
    expect(iosPanels).toMatch(/presenceDot[\s\S]{0,600}?accessibilityHidden\(true\)/)
    expect(androidPanels).toMatch(/fun PresenceDot\(presence: DevicePresence\)[\s\S]{0,600}?contentDescription = null/)
  })
})

describe('neither sheet reports a sleeping board as a broken camera', () => {
  // iOS 8ed4a338. `RelayCameraPanel` fetched a frame on every appearance and never
  // read presence, so opening My devices with a Vision necklace asleep in a drawer
  // spent a POST plus sixteen polls on it and then painted the silence orange —
  // above a row that already read "seen 3 days ago". The camera was awake. The
  // board was gone, and the largest element on the sheet blamed the hardware that
  // was working.
  //
  // The worker's own definition settles it: PULL_KINDS is documented as the kinds
  // that "hold a `tind_` token, heartbeat, poll the relay" — one loop, both jobs —
  // so a device outside the 60s PRESENCE_WINDOW_S is not reading the relay either.

  it('the premise still holds: the worker gives one loop both jobs', () => {
    // Everything here rests on this. If PULL_KINDS ever stopped meaning "polls the
    // relay", presence would no longer predict reachability and the gate would be
    // refusing calls that could actually land.
    const devicesTs = read('worker/src/devices.ts')
    // The declaration's OWN doc line, not a window around it. A measured lesson
    // from this cycle: a 700-char window back from `PULL_KINDS` also contains
    // PRESENCE_WINDOW_S's "heartbeat within this", so a mutant that gutted the
    // real sentence still matched via the neighbour and survived.
    expect(devicesTs, 'PULL_KINDS no longer documents ONE loop doing BOTH jobs')
      .toMatch(
        /\/\*\* Device kinds that dial IN \(hold a `tind_` token, heartbeat, poll the relay\)\. \*\/\s*\nexport const PULL_KINDS = /,
      )
    // And presence really is measured over that same heartbeat, on a window short
    // enough that "online" means "polling right now" rather than "today".
    expect(devicesTs).toMatch(/export const PRESENCE_WINDOW_S = 60;/)
    expect(devicesTs).toMatch(/a device is "online" when it heartbeat within this/)
  })

  it('both phones ask ONE rule, and it is the same rule', () => {
    expect(iosPanels).toMatch(
      /static func canReach\(_ presence: DevicePresence\) -> Bool \{ presence == \.online \}/,
    )
    expect(androidPanels).toMatch(
      /fun canReach\(presence: DevicePresence\): Boolean = presence == DevicePresence\.ONLINE/,
    )
    // UNKNOWN is refused on both, and that is the interesting half: it means
    // "nothing here can tell you", not "go spend a round-trip finding out".
    // A `!= .offline` spelling would pass a naive regex and reverse this.
    expect(iosPanels, 'iOS would now call an UNKNOWN device').not.toMatch(/presence != \.offline/)
    expect(androidPanels, 'Android would now call an UNKNOWN device')
      .not.toMatch(/presence != DevicePresence\.OFFLINE/)
  })

  it('the sentence blames the board and names it, in one voice', () => {
    // Byte-identical on purpose: this is a whole sentence shown on the same sheet
    // of the same product, and the two phones drifting apart here is how one of
    // them ends up sounding like a different app.
    const line = "isn't online — its camera answers once it's back."
    expect(iosPanels).toContain(line)
    expect(androidPanels).toContain(line)
    // The name is interpolated, not a generic noun: two necklaces on one sheet
    // each need their own line.
    expect(iosPanels).toMatch(/\\\(deviceName\) isn't online/)
    expect(androidPanels).toMatch(/\$deviceName isn't online/)
  })

  it('the note and the call are ONE decision on both phones', () => {
    // The defect class this fix is really about: a panel showing "asleep" while a
    // request is in flight, or making the call with nothing to say about the
    // silence. Both phones derive the note from canReach rather than re-testing
    // presence, so the two answers cannot drift.
    const ios = swiftEnum(iosPanels, 'RelayReach')
    expect(ios).toMatch(/canReach\(presence\)/)
    const kt = ktObject(androidPanels, 'RelayReach')
    expect(kt).toMatch(/if \(canReach\(presence\)\) null/)
  })

  it('the AUTOMATIC fetch is gated on both phones — and only the automatic one', () => {
    // A tap is the user overriding our guess about their own hardware, and this
    // app answers that with a retry, never a silent no-op. So the gate belongs at
    // the appearance-triggered call, NOT inside the refresh function both share.
    const iosPanel = code(swiftStruct(iosPanels, 'RelayCameraPanel'))
    expect(iosPanel, 'the iOS panel fetches on appearance again, ungated')
      .toMatch(/\.task \{ if unreachable == nil \{ refresh\(asked: false\) \} \}/)
    // Any argument list: an ungated `.task { refresh(asked: false) }` is the same
    // bug `.task { refresh() }` was, and the old needle would have missed it.
    expect(iosPanel).not.toMatch(/\.task \{ refresh\(/)

    const ktPanel = code(ktFun(androidPanels, 'RelayCameraPanel'))
    expect(ktPanel, 'the Android panel fetches on appearance again, ungated')
      .toMatch(/LaunchedEffect\([^)]*\) \{ if \(unreachable == null\) refresh\(asked = false\) \}/)
    // Any argument list, for the reason the iOS needle above gives: an ungated
    // `LaunchedEffect(deviceId) { refresh(asked = false) }` is the same bug the
    // no-argument spelling was, and a needle naming `refresh()` would miss it now.
    expect(ktPanel).not.toMatch(/LaunchedEffect\(deviceId\) \{ refresh\(/)

    // And refresh() itself stays unconditional on both, so a tap always calls.
    //
    // Anchored WITHOUT the argument list, and the anchor is now asserted. This
    // read `'private func refresh()'` until the iOS function grew an `asked:`
    // parameter, and then `indexOf` returned -1, `slice(-1)` handed the
    // assertion one character, and `.not.toMatch` passed on it forever — a pin
    // that stops pinning the moment a signature moves, silently, green.
    const iosAt = iosPanels.indexOf('private func refresh(', iosPanels.indexOf('struct RelayCameraPanel'))
    expect(iosAt, 'iOS refresh() is gone or renamed — the pin below would be vacuous')
      .toBeGreaterThan(-1)
    const iosRefresh = code(iosPanels.slice(iosAt))
    expect(iosRefresh.slice(0, iosRefresh.indexOf('\n    }')), 'a tap became a silent no-op on iOS')
      .not.toMatch(/canReach|unreachable/)
    // Anchored without the argument list, and the anchor asserted, for the reason
    // the iOS half above spells out — this pin read `'fun refresh()'` until the
    // Kotlin function grew its own `asked` parameter.
    const ktAt = ktPanel.indexOf('fun refresh(')
    expect(ktAt, 'Android refresh() is gone or renamed — the pin below would be vacuous')
      .toBeGreaterThan(-1)
    const ktRefresh = ktPanel.slice(ktAt)
    expect(ktRefresh.slice(0, ktRefresh.indexOf('\n    }')), 'a tap became a silent no-op on Android')
      .not.toMatch(/canReach|unreachable/)
  })

  it('asleep is not a failure, on either phone', () => {
    // Nothing failed, so the line must not wear the failure shape — the ⚠/orange
    // triangle with a retry beside it, which is precisely what used to appear for
    // a board that was simply asleep. Both draw a moon and secondary grey.
    const iosPanel = code(swiftStruct(iosPanels, 'RelayCameraPanel'))
    const iosAt = iosPanel.indexOf('} else if let unreachable {')
    expect(iosAt, 'the iOS asleep branch is gone').toBeGreaterThan(-1)
    const iosBranch = iosPanel.slice(iosAt, iosPanel.indexOf('} else {', iosAt))
    expect(iosBranch).toMatch(/systemImage: "moon\.zzz"/)
    expect(iosBranch).toMatch(/foregroundStyle\(\.secondary\)/)
    expect(iosBranch, 'the asleep line wears the failure triangle')
      .not.toMatch(/exclamationmark|\.orange|Retry/)

    const ktPanel = code(ktFun(androidPanels, 'RelayCameraPanel'))
    const ktAt = ktPanel.indexOf('if (unreachable != null) {')
    expect(ktAt, 'the Android asleep branch is gone').toBeGreaterThan(-1)
    const ktFailAt = ktPanel.indexOf('} else if (peek is PeekShape.Alarm)', ktAt)
    expect(ktFailAt, 'the Android failure branch is gone — this slice would run past it')
      .toBeGreaterThan(ktAt)
    const ktBranch = ktPanel.slice(ktAt, ktFailAt)
    expect(ktBranch).toMatch(/Icons\.Outlined\.Bedtime/)
    expect(ktBranch).toMatch(/color = TinyGray/)
    expect(ktBranch, 'the asleep line wears the failure triangle')
      .not.toMatch(/TinyWarn|⚠|retry/)
  })

  it('asleep OUTRANKS a stale reason — that ordering IS the bug', () => {
    // Android-only surface, and the one place the defect could survive the fix. A
    // reason measured while the board was awake ("no frame in 19s") outlives the
    // link it describes, so if `error` were tested first the sheet would still be
    // showing an orange timeout for a necklace that is merely asleep — the whole
    // complaint, one branch further down.
    //
    // Pinned as ORDER, not as the presence of a branch: `unreachable != null &&
    // why == null` still draws a moon somewhere and still passes a shape check.
    const ktPanel = code(ktFun(androidPanels, 'RelayCameraPanel'))
    const asleep = ktPanel.indexOf('if (unreachable != null) {')
    const failure = ktPanel.indexOf('} else if (peek is PeekShape.Alarm)')
    expect(asleep, 'the asleep branch is gone or now conditional on the error')
      .toBeGreaterThan(-1)
    expect(failure, 'the failure branch stopped being the asleep branch\'s else')
      .toBeGreaterThan(asleep)

    // Same for the trailing line under a KEPT frame: the necklace answered, then
    // slept, and that slot is where an orange reason would sit on forever.
    const tail = ktPanel.slice(ktPanel.indexOf('Row(Modifier.fillMaxWidth()) {', failure))
    const tailAsleep = tail.indexOf('if (unreachable != null && frame != null) {')
    const tailError = tail.indexOf('} else if (error != null && frame != null) {')
    expect(tailAsleep, 'the kept-frame caption can still show a stale reason')
      .toBeGreaterThan(-1)
    expect(tailError).toBeGreaterThan(tailAsleep)
  })

  it('⚠️ an ENDPOINT robot is never gated by this — its presence is UNKNOWN by design', () => {
    // The worker sends `online: null` for endpoint kinds, because tiny dials OUT to
    // a robot's own HTTPS API rather than waiting for it to poll. Gate the endpoint
    // panel on relay reachability and every healthy printer on the sheet goes dark
    // — the exact regression c38 fixed in the row above it.
    // iOS keeps it in its own file; the whole file, since the gate must not reach
    // the robot through a helper either.
    const iosEndpoint = code(read('ios/Tiny/Sources/EndpointPanel.swift'))
    expect(iosEndpoint).toContain('struct EndpointPanel: View')
    expect(iosEndpoint, 'a healthy robot just went dark on iOS').not.toMatch(/RelayReach/)
    const ktEndpoint = code(read('android/app/src/main/java/technology/tiny/app/ui/EndpointPanel.kt'))
    expect(ktEndpoint).toContain('fun EndpointPanel(')
    expect(ktEndpoint, 'a healthy robot just went dark on Android').not.toMatch(/RelayReach/)
    // And the call sites keep it that way: only the nicla-vision panel is handed a
    // presence to gate on.
    expect(androidPanels).toMatch(/RelayCameraPanel\(app, d\.id, d\.name, d\.presence\)/)
    expect(androidPanels).toMatch(/EndpointPanel\(app, d\.id, d\.name, d\.capabilities\)/)
  })

  it('a rule nothing calls is not a fix: each panel is handed the presence', () => {
    // The c39/c40 lesson in its own suite. A pure rule with perfect unit tests
    // cannot tell whether any view asks it, so pin the wiring: the panel takes a
    // presence, and the sheet passes the row's own.
    expect(iosPanels).toMatch(/RelayCameraPanel\(deviceId: d\.id, deviceName: d\.name,\s*\n?\s*presence: d\.presence, token: token\)/)
    const ktSig = androidPanels.slice(androidPanels.indexOf('internal fun RelayCameraPanel('))
    expect(ktSig.slice(0, ktSig.indexOf(') {'))).toMatch(/presence: DevicePresence/)
  })
})

describe('a record envelope is answered on both phones, not destroyed', () => {
  const iosSession = read('ios/Tiny/Sources/Session.swift')
  const androidFleet = read('android/app/src/main/java/technology/tiny/app/fleet/FleetManager.kt')
  const recorder = read('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')

  it('reads the files it means to read', () => {
    expect(iosSession).toContain('"record"')
    expect(androidFleet).toContain('private suspend fun handleEnvelope(')
    expect(recorder).toContain('object PhoneRecorder')
  })

  it('the relay poll CLAIMS envelopes — so an unhandled type is DESTROYED', () => {
    // The premise, in the iOS source that states it. This is why a missing
    // handler is data loss rather than a retry: the worker's nicla_voice_record
    // waited out its whole window and then told the user the phone "may still be
    // recording". It never started. Pinned so a future reader cannot conclude
    // that adding a type is optional.
    expect(iosSession).toMatch(/the poll claims\s*\n?\s*\/\/\s*envelopes \(CAS delivered=0→1\), so an unhandled type is/)
    expect(androidFleet, 'Android no longer records WHY it must handle this type')
      .toMatch(/CAS\s*\n?\s*\/\/\s*delivered=0→1\)/)
  })

  it('BOTH phones branch on the record type before the invoke guard', () => {
    // Ordering is the whole fix on Android: `record` must be recognised ahead of
    // the `type != "invoke"` early return that used to swallow it. A handler
    // placed after that guard is unreachable and would look correct in review.
    const kt = code(ktFun(androidFleet, 'handleEnvelope'))
    const recordAt = kt.indexOf('"record"')
    const invokeGuard = kt.search(/if \(payload\.optString\("type"\) != "invoke"\) return/)
    expect(recordAt, 'Android dropped the record branch').toBeGreaterThan(-1)
    expect(invokeGuard, 'the invoke guard is gone — re-anchor this pin').toBeGreaterThan(-1)
    expect(invokeGuard, 'the record branch sits BEHIND the invoke guard: unreachable')
      .toBeGreaterThan(recordAt)
    // iOS the same, in its foreground poller.
    const iosRecordAt = iosSession.indexOf('payload["type"] as? String == "record"')
    const iosInvoke = iosSession.indexOf('guard payload["type"] as? String == "invoke"')
    expect(iosRecordAt).toBeGreaterThan(-1)
    expect(iosInvoke).toBeGreaterThan(iosRecordAt)
  })

  it('a rule nothing calls is not a fix: the handler is REACHED and REPLIES', () => {
    // The third cycle of this lesson. PhoneRecorderTest can prove the reply shape
    // and never notice that no envelope reaches it, so pin the call and the PATCH
    // that answers the caller's exact envelope id.
    const kt = code(ktFun(androidFleet, 'handleRecordEnvelope'))
    expect(kt).toMatch(/PhoneRecorder\.record\(app, secs, label\)/)
    expect(kt).toMatch(/PhoneRecorder\.clampSeconds\(/)
    expect(kt).toMatch(/PhoneRecorder\.label\(/)
    expect(kt).toContain('"/api/devices/relay"')
    expect(kt).toMatch(/\.put\("inReplyTo", envelopeId\)/)
    expect(kt).toMatch(/\.put\("payload", PhoneRecorder\.reply\(take\)\)/)
  })

  it('a REFUSAL is still a reply — the caller is blocked on this envelope', () => {
    // A phone that will not record (mic busy, permission never granted) must say
    // so immediately. Staying silent spends the tool's entire wait window before
    // it can report anything, and it then blames the network. So the PATCH may
    // not sit inside a success branch: exactly one reply, unconditional.
    const kt = code(ktFun(androidFleet, 'handleRecordEnvelope'))
    const patches = kt.match(/api\.patchJson\(/g) || []
    expect(patches.length, 'more than one reply path — or none').toBe(1)
    // …and the take is a value on every path, never an early return.
    expect(kt, 'a refusal now returns before replying').not.toMatch(/return@|\breturn\b(?!\s*\})/)
    // The unavailable-recorder case answers too, rather than dropping the envelope.
    expect(kt).toMatch(/PhoneRecorder\.Take\(false, "", "", 0, "recorder unavailable/)
  })

  it('the phone ADVERTISES record, or the agent never asks', () => {
    // The capability list is what the model reasons from ("only advertises
    // chat+location, so it can't record"). A handler nothing knows about is
    // still an unusable phone.
    const at = androidFleet.indexOf('private val capabilities = listOf(')
    expect(at).toBeGreaterThan(-1)
    const list = androidFleet.slice(at, androidFleet.indexOf(')', at))
    expect(list, 'Android handles record but does not claim it').toContain('"record"')
    // iOS claims it too — one fleet, one vocabulary.
    expect(iosSession).toMatch(/"record"/)
  })

  it('Android replies with a TRANSCRIPT and NO audio url — stated, not silent', () => {
    // The one deliberate divergence, and the reason it is not a bug: iOS taps a
    // single AVAudioEngine that feeds SFSpeechRecognizer AND an AVAudioFile, so it
    // can host the clip. Android's SpeechRecognizer captures inside Google's
    // process — this app never sees the samples, and the mic is exclusive, so a
    // MediaRecorder alongside it would starve recognition. The reply therefore
    // omits `audioUrl` entirely (the tool reads a missing key as null); an empty
    // or invented one would render a player over nothing.
    const reply = code(ktFun(recorder, 'reply'))
    expect(reply, 'Android started claiming hosted audio it does not have')
      .not.toMatch(/audioUrl/)
    expect(reply).toMatch(/\.put\("transcriptId", take\.transcriptId\)/)
    // iOS does host one — the asymmetry is real and this proves it is not drift.
    expect(iosSession).toMatch(/reply\["audioUrl"\] = u/)
    // And the divergence is DOCUMENTED where a porter will read it, so nobody
    // "fixes" Android by fabricating a URL.
    //
    // ⚠️ "FOR A TAKE" is load-bearing in that heading and was added late. Unscoped,
    // it read as "Android has no audio" — a blanket claim that made the missing
    // necklace-live player look like a platform limit for as long as it existed,
    // while every word of the paragraph stayed true about takes. A comment can be
    // accurate and still guarantee the wrong thing; the pin has to hold the SCOPE.
    expect(recorder).toMatch(/NO AUDIO FILE FOR A \*\*TAKE\*\*, BY PLATFORM CONSTRAINT/)
    expect(recorder).toMatch(/SpeechRecognizer captures inside\s*\n?\s*\*\s*Google's recognition-service process/)
  })

  it('silence is a success on both phones, in the same words', () => {
    // "recording failed" for a quiet room sends the user to check a microphone
    // that worked. Both phones say the same thing instead.
    expect(iosSession).toContain('heard nothing (silence)')
    expect(recorder).toContain('heard nothing (silence)')
    // On Android that string may not live in the failure branch. Pinned by COUNT,
    // not by order: a mutant that ADDED a silence-is-an-error branch ahead of the
    // success one left the original string in place and sailed through an
    // ordering check. There is exactly ONE way to fail, and silence is not it.
    const reply = code(ktFun(recorder, 'reply'))
    expect((reply.match(/o\.put\("error"/g) || []).length,
      'a second error path appeared — silence is the usual culprit').toBe(1)
    // …and that one path is the !ok branch, reached before any transcript exists.
    const fail = reply.indexOf('o.put("error"')
    expect(reply.slice(0, fail), 'the error path is no longer guarded by !ok')
      .toMatch(/if \(!take\.ok\)/)
    // The silence sentence itself never says the recording failed. Bounded at the
    // `val heard` line, NOT a fixed-width lookback: a 200-char window reaches up
    // into the legitimate failure branch above and matched its wording — the same
    // neighbouring-context trap that let c41's M11 survive.
    const heardAt = reply.indexOf('val heard = take.text.trim()')
    expect(heardAt, 'the success branch was restructured — re-anchor this pin').toBeGreaterThan(-1)
    expect(reply.slice(heardAt), 'silence got folded into the failure branch')
      .not.toMatch(/recording failed/)
  })

  it('ONE microphone: a remote take cannot barge in on voice chat', () => {
    // iOS refuses via the shared AVAudioSession (`VoiceMode.shared.active`).
    // Android has three independent mic owners that could not see each other, so
    // the claim is what makes the guarantee enforceable — and the remotely
    // triggered one is the owner that must ask.
    expect(read('ios/Tiny/Sources/NiclaRecorder.swift')).toMatch(/VoiceMode\.shared\.active/)
    const rec = code(ktFun(recorder, 'record'))
    expect(rec).toMatch(/MicClaim\.claim\(OWNER\)/)
    expect(rec, 'the claim is taken but never released — the mic stays busy forever')
      .toMatch(/MicClaim\.release\(OWNER\)/)
    // Released in a finally: a thrown take that kept the claim would leave the
    // phone convinced its mic was busy until the process died.
    expect(rec).toMatch(/finally \{[\s\S]*MicClaim\.release\(OWNER\)[\s\S]*?\}/)
  })

  it('the take stops the mic when it ends — two flags, not one', () => {
    // The tail of a take needs `live` (still absorbing words) and `rolling`
    // (still allowed to open a session) to DIFFER: after stopListening the
    // in-flight session may still deliver its final, but must not roll a fresh
    // one, or the microphone reopens after the take is over.
    //
    // ⚠️ Honest limit: this is a SOURCE pin, not a behavioural one. `listen()`
    // needs a real mic and Google's recognition service, so no unit test here can
    // observe the reopen — a mutant that deleted the `rolling = false` before the
    // settle wait survived every suite in this repo. What that costs is recorded
    // in the ledger; what this pin buys is that the distinction cannot be
    // collapsed silently.
    const listen = code(ktFun(recorder, 'listen'))
    expect(listen, 'the rolling/live distinction was collapsed').toMatch(/var live = true/)
    expect(listen).toMatch(/var rolling = true/)
    // Cleared BEFORE the settle wait, so the tail cannot start a new session.
    // The window is the TEARDOWN only — from the end of the take's own sleep to
    // stopListening. Slicing from the top of the function instead matched the
    // `rolling = false` inside the error callback and let this mutant live.
    // Anchored on the sliced wait's own delay since the take became stoppable —
    // it marks the same point in the sequence the single long sleep used to.
    const wakeAt = listen.indexOf('delay(STOP_TICK_MS)')
    const stopAt = listen.indexOf('stopListening()')
    expect(wakeAt, 'the take no longer sleeps for its duration — re-anchor').toBeGreaterThan(-1)
    expect(stopAt, 'the take no longer stops the recognizer — re-anchor').toBeGreaterThan(wakeAt)
    expect(listen.slice(wakeAt, stopAt), 'rolling is not cleared before the mic settles')
      .toMatch(/rolling = false/)
    // …and `live` is cleared only AFTER it, so the final still counts.
    const liveOff = listen.indexOf('live = false')
    expect(liveOff, 'live is cleared before the tail lands — last words lost')
      .toBeGreaterThan(stopAt)
    // A new session is gated on `rolling`, never on `live`.
    expect(listen).toMatch(/if \(!rolling\) return/)
    expect(listen).toMatch(/if \(rolling\) start\(\)/)
  })

  it('the take is bounded on arrival, not only at the sender', () => {
    // A relay payload reaches this phone from anything holding the internal key.
    // The worker tool clamps 5..120 before sending; this clamps again on receipt,
    // so `seconds: 86400` cannot hold the microphone for a day.
    const kt = code(ktFun(androidFleet, 'handleRecordEnvelope'))
    expect(kt, 'the envelope seconds go through unclamped').toMatch(/PhoneRecorder\.clampSeconds\(/)
    expect(kt, 'a raw optInt reached the recorder').not.toMatch(/record\(app, payload\.optInt/)
    // Expression-bodied, so there is no brace for ktFun to match: read the
    // declaration's own line. Bounded at both ends by the `fun`/newline anchors.
    expect(recorder).toMatch(
      /fun clampSeconds\(asked: Int\?\): Int =\s*\n?\s*\(asked \?: 10\)\.coerceIn\(MIN_SECONDS, MAX_SECONDS\)/,
    )
  })

  it('a remote mic switch-on is VISIBLE after the fact', () => {
    // Something turned this user's microphone on without them touching the phone.
    // It lands in the relay log like an invoke does, and in the shade when nobody
    // was watching — the same rule iOS applies to a background relay wake.
    const kt = code(ktFun(androidFleet, 'handleRecordEnvelope'))
    expect(kt).toMatch(/_relayLog\.value = \(_relayLog\.value \+ RelayEntry\(/)
    expect(kt).toMatch(/if \(!foreground\) \{/)
    expect(kt).toMatch(/notifyFleetTrace\(/)
  })

  it('the transcript is FILED, and attributed the way iOS attributes it', () => {
    // The words belong in two places: the durable store the user browses and the
    // agent's context. Attribution is the necklace when one is paired, the phone
    // otherwise — the moment belongs to the board that asked for it.
    // …and the take CALLS it. A measured gap in this very pin: a mutant that
    // deleted the fileTranscript call from record() left every assertion below
    // green — the function was perfect and nothing invoked it, so the reply still
    // carried a transcriptId that resolved to nothing in the store.
    expect(code(ktFun(recorder, 'record')), 'the take no longer files its transcript')
      .toMatch(/fileTranscript\(app, take, label\)/)
    const file = code(ktFun(recorder, 'fileTranscript'))
    expect(file).toContain('"/api/devices/transcript"')
    expect(file).toMatch(/NiclaVoiceGateway\.credentials\(app\)/)
    expect(file, 'the phone fallback is gone — a take with no necklace files nowhere')
      .toMatch(/voice \?: phone/)
    // The event-ring fallback, iOS's rail, so words still reach the next turn's
    // context on a worker without the transcript route deployed.
    expect(file).toContain('"device_note"')
    expect(read('ios/Tiny/Sources/NiclaRecorder.swift')).toContain('"device_note"')
    // A silent take is still filed — "(silence)" is a fact about a moment.
    expect(file).toMatch(/ifEmpty \{ "\(silence\)" \}/)
  })

  /**
   * 🎙️ The fallback rail is BUDGETED on both phones — iOS `068335b6` ported, with
   * a different number, because the two phones face different caps.
   *
   * ⚠️ THIS IS THE ONE RAIL WHOSE TRUNCATION IS UNRECOVERABLE. The preferred
   * route (`/api/devices/transcript`) files a durable row and returns an id, so a
   * cut there is still fetchable by that id. This one files NO row: what the
   * worker slices off is gone, with nothing to fetch the rest with. So it must be
   * budgeted rather than sliced at a hopeful number.
   *
   * ⚠️⚠️ AND THE CAP THAT BINDS IS NOT THE ONE ADVERTISED. A client's detail
   * crosses three slices, and the MIDDLE one is the smallest:
   *
   *   1. `app/api/devices/event/route.ts`  detail.slice(0, 300)
   *   2. worker `devices.ts` DeviceEventCall  `${name}: ${detail.slice(0, 240)}`
   *   3. worker `events.ts` emitEvent  detail.slice(0, 300)
   *
   * Step 2 slices the CLIENT's text to 240 before prepending the device name, so
   * step 3's 300 is unreachable (40 + 2 + 240 = 282). Reading `emitEvent` alone —
   * which is the natural place to look, and what iOS's own doc-comment cites —
   * yields a budget 60 chars too generous. Pinned as arithmetic against the
   * worker source so neither phone can be "corrected" back to 300.
   */
  describe('the device_note rail is budgeted against the cap that BINDS', () => {
    const routeTs = read('app/api/devices/event/route.ts')
    const devicesTs = read('worker/src/devices.ts')
    const eventsTs = read('worker/src/events.ts')

    it('the worker really does slice a client detail to 240 BEFORE emitEvent', () => {
      // The whole finding rests on this line, so it is read from the worker rather
      // than asserted from memory. If it moves, every budget below is wrong.
      expect(
        code(devicesTs),
        'DeviceEventCall no longer slices the client detail at 240 — re-measure both phones',
      ).toMatch(/emitEvent\(\s*env,\s*String\(row\.user_id\),\s*String\(kind\),\s*`\$\{name\}: \$\{String\(detail \|\| ""\)\.slice\(0, 240\)\}`/)
      // The name it prepends, bounded — the other half of why 300 is unreachable.
      expect(code(devicesTs)).toMatch(/String\(row\.name \|\| "device"\)\.slice\(0, 40\)/)
      expect(code(eventsTs), "emitEvent's own cap moved").toMatch(/String\(detail \|\| ''\)\.slice\(0, 300\)/)
      expect(code(routeTs), "the Next route's cap moved").toMatch(/String\(detail \?\? ''\)\.slice\(0, 300\)/)
    })

    it('Android budgets the line instead of slicing the speech at a fixed 180', () => {
      // ⚠️ The defect: the label was UNBOUNDED while PhoneRecorder.label allows 200
      // chars of agent free text, so the line reached 388 and the worker cut 148 —
      // off the TAIL, which on this line is the speech.
      const nd = ktFun(recorder, 'noteDetail')
      expect(nd, 'the words are sliced at a hardcoded number again').not.toMatch(/text\.take\(180\)/)
      expect(nd, 'the label is unbounded again — an agent `reason` pushes the speech out')
        .toMatch(/label\.take\(NOTE_LABEL_MAX\)/)
      expect(nd, 'the room left for speech is no longer computed from the real shell')
        .toMatch(/val shell = "🎙️ \$bounded: “”"/)
      expect(nd, 'the words are no longer given the room that was budgeted for them')
        .toMatch(/text\.take\(NOTE_DETAIL_MAX - shell\.length\)/)
      // …and the rail USES it. The measured lesson from the pin above this one: a
      // perfect function nothing calls leaves every assertion green.
      expect(code(ktFun(recorder, 'fileTranscript')), 'the note rail builds its own line again')
        .toMatch(/\.put\("detail", noteDetail\(label, text\)\)/)
    })

    it('⚠️ Android budgets against 240, NOT the 300 iOS uses — and that is correct', () => {
      // The numbers differ because the phones differ, and a "sync" in either
      // direction is a regression. Android's is the cap that actually binds this
      // rail; iOS's is emitEvent's, which its own line never reaches.
      const kt = read('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
      expect(code(kt)).toMatch(/const val NOTE_DETAIL_MAX = 240\b/)
      expect(code(kt)).toMatch(/const val NOTE_LABEL_MAX = 40\b/)
      // ⚠️ NO `maxOf(floor, …)` on this side, and that is the deliberate divergence:
      // iOS reserves an unbounded audio URL and needs a real floor; this line has no
      // URL, so bounding the label fixes the room arithmetically. Two mutants proved
      // a floor written here was DEAD CODE — deleting it and zeroing it both left
      // every test green. What replaced it is a stated consequence a test can hold.
      expect(code(kt), 'a floor is back — nothing can reach it, so it guarantees nothing')
        .not.toMatch(/NOTE_PREVIEW_FLOOR/)
      expect(code(kt)).toMatch(/const val MIN_NOTE_PREVIEW = NOTE_DETAIL_MAX - \(8 \+ NOTE_LABEL_MAX\)/)
      // The comment must keep NAMING where the binding slice lives, because the
      // number alone reads as a typo against the 300 the route advertises.
      expect(kt, "the 240's provenance is gone — it now reads as a mistake")
        .toMatch(/devices\.ts/)
      expect(kt, 'the chain that makes 300 unreachable is no longer stated').toMatch(/40 \+ 2 \+ 240|282/)
    })

    it('both phones bound the label, and neither lets it push the speech out', () => {
      // The shared property, stated once: the label is the cheap part (the agent
      // wrote it, and this app's own are short by construction), the speech is the
      // part nothing else has a copy of. Both phones bound it at 40.
      expect(code(read('ios/Tiny/Sources/NiclaRecorder.swift')))
        .toMatch(/notePreviewLabelMax = 40\b/)
      expect(code(read('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')))
        .toMatch(/NOTE_LABEL_MAX = 40\b/)
    })

    it('⚠️ the Android budget is proven by ARITHMETIC in a JVM test, not by greps', () => {
      // c62's lesson, applied deliberately: a grep can see that `text.take(room)`
      // appears; only a test can see how many characters the worker would keep. The
      // pins above are wiring; these are the behaviours PhoneRecorderTest owns, and
      // reverting to `text.take(180)` turns two of them red — one reporting the
      // exact overshoot (148 chars), which is how the number in the comment above
      // was obtained rather than reasoned.
      const t = read('android/app/src/test/java/technology/tiny/app/fleet/PhoneRecorderTest.kt')
      for (const behaviour of [
        'the note line survives the ring at the worst label the agent can send',
        'a long take SPENDS the room the budget found, not a fixed 180',
        'the speech is what the budget is spent on, not the label',
        'no label, however long, can take the speech below its floor',
        'the emoji is counted in the units the worker slices in',
        'the budget defends the cap that BINDS, not the one advertised',
      ]) {
        expect(t, `PhoneRecorderTest no longer covers: ${behaviour}`).toContain(behaviour)
      }
      // The rail's cap is transcribed there from the worker, not imported — so the
      // test states WHERE it came from too.
      expect(t).toMatch(/fun railKeeps\(detail: String\) = detail\.take\(PhoneRecorder\.NOTE_DETAIL_MAX\)/)
    })

    it('⚠️ the units are the WORKER\'s units, which is where iOS\'s figure drifts', () => {
      // 🎙️ is U+1F399 U+FE0F: one grapheme, THREE utf-16 units. The worker slices
      // in utf-16 (String.slice); Kotlin's take/length are utf-16 too, so Android's
      // budget agrees with the cut by construction. Swift's String.count counts
      // GRAPHEMES, so iOS's 300-char line measures 302 to the worker — measured, and
      // recorded here rather than silently inherited by this side.
      expect('🎙️'.length, 'the emoji is no longer 3 utf-16 units — re-measure both shells').toBe(3)
      const kt = read('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
      // ⚠️ A bare /UTF-16/ SURVIVED a mutant that reworded this heading to "counted
      // carefully, to agree with the worker" — the phrase stayed, the claim did not.
      // The property is that the units are named as the WORKER'S and that the
      // grapheme/utf-16 divergence iOS sits on is recorded, so pin both.
      expect(kt, 'the units are no longer identified as the ones the WORKER slices in')
        .toMatch(/UTF-16 UNITS, WHICH IS WHAT THE WORKER COUNTS/)
      expect(kt, "the reason iOS's own figure drifts is no longer recorded here")
        .toMatch(/GRAPHEMES/)
      expect(kt, 'the measured overshoot of iOS-style grapheme counting is gone').toMatch(/302/)
    })
  })
})

/**
 * 🎙️ Adopting an enrolled Voice, rather than orphaning it — iOS `783143b9`
 * ported to Android.
 *
 * The defect was identical on both phones and is worth stating precisely,
 * because the symptom looks like a Bluetooth fault and is not one: a Voice
 * board cannot heartbeat for itself, and the gateway only dials a unit it has
 * REGISTERED. Registration's one caller was BLE provisioning. So a necklace
 * enrolled from a laptop — or from a phone since reinstalled — was visible in
 * the fleet, scannable over BLE, and permanently ungatewayable: the row sat
 * offline while the healthy board lay on the desk advertising.
 *
 * The old advice made it worse. "Set it up here to relay it" points at
 * provisioning, which MINTS A SECOND ROW and leaves the first frozen forever
 * with its wake history and transcripts stranded under the old id.
 */
describe('an enrolled necklace can be adopted by a second phone, not just re-enrolled', () => {
  const ktPanels = read('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')
  const swPanels = read('ios/Tiny/Sources/Panels.swift')

  it('the premise still holds: only register() opens the gateway, and adopt is now its second caller', () => {
    const ktGw = read('android/app/src/main/java/technology/tiny/app/fleet/NiclaVoiceGateway.kt')
    // The gate that made this unreachable. If `start()` stops bailing on a
    // missing unit, this whole feature is answering a question nobody asks.
    expect(code(ktFun(ktGw, 'start')), 'start() no longer bails on a missing unit — re-read the premise')
      .toMatch(/_unit\.value \?: return/)
    // Exactly TWO callers of register() on each phone: provisioning, and adopt.
    // Pinned as a COUNT because the fix IS the second caller — a shape check
    // for "adopt calls register" passes just as well with three, and a third
    // would mean some other flow is minting units behind this rule.
    const ktCalls = (ktPanels + read('android/app/src/main/java/technology/tiny/app/ui/Nearby.kt'))
      .match(/NiclaVoiceGateway\.register\(|gw\.register\(/g) || []
    expect(ktCalls.length, 'register() gained or lost a caller on Android').toBe(2)
    const swCalls = (swPanels + read('ios/Tiny/Sources/TinySetup.swift'))
      .match(/\bgw\.register\(|NiclaVoiceGateway\.shared\.register\(|voiceGateway\.register\(/g) || []
    expect(swCalls.length, 'register() gained or lost a caller on iOS').toBe(2)
  })

  it('neither phone still advises the flow that orphans the row', () => {
    // The exact old string, on both phones. Provisioning is the WRONG answer
    // here and the sentence that recommended it must not come back.
    expect(ktPanels, 'Android still tells the user to re-provision an owned board')
      .not.toContain('set it up here to relay it')
    expect(swPanels, 'iOS still tells the user to re-provision an owned board')
      .not.toContain('set it up here to relay it')
    // And both name the real situation, which includes a computer — the case
    // that produced the bug.
    expect(ktPanels).toContain('Paired to another phone or a computer.')
    expect(swPanels).toContain('Paired to another phone or a computer.')
  })

  it('both phones promise the history survives, because that is the whole point', () => {
    // Adoption vs re-provisioning is invisible from outside: both end with the
    // necklace working. The difference is the id, its events and its
    // recordings, so the button that costs nothing has to say so — otherwise a
    // cautious user picks the destructive path.
    for (const [src, phone] of [[ktPanels, 'Android'], [swPanels, 'iOS']] as const) {
      expect(src, `${phone} does not promise the history survives`)
        .toContain('keeping its history')
      // And warns about the cost, which is real: rotation kills the other
      // client's token immediately.
      expect(src, `${phone} hides that the other client loses the link`)
        .toMatch(/other client stops relaying it/)
    }
  })

  it('the scan comes BEFORE the rotation, on both phones', () => {
    // The ordering IS the correctness argument. Rotating first kills the other
    // client's credential immediately, so a rotation that then fails to find
    // the board leaves the necklace relayed by NOBODY. Failing on "can't see
    // it" costs nothing; failing after the rotation costs the working link.
    const ktAdopt = code(ktFun(ktPanels, 'adopt'))
    const ktScan = ktAdopt.indexOf('startScan')
    const ktRotate = ktAdopt.indexOf('/api/devices/adopt')
    expect(ktScan, 'Android adopt() no longer scans').toBeGreaterThan(-1)
    expect(ktRotate, 'Android adopt() no longer rotates').toBeGreaterThan(-1)
    expect(ktRotate, 'Android rotates the token BEFORE confirming the board is in range')
      .toBeGreaterThan(ktScan)

    const swAdopt = code(braceBody(swPanels, swPanels.indexOf('private func adopt() async')))
    const swScan = swAdopt.indexOf('startScan')
    const swRotate = swAdopt.indexOf('/api/devices/adopt')
    expect(swScan, 'iOS adopt() no longer scans').toBeGreaterThan(-1)
    expect(swRotate, 'iOS adopt() no longer rotates').toBeGreaterThan(-1)
    expect(swRotate, 'iOS rotates the token BEFORE confirming the board is in range')
      .toBeGreaterThan(swScan)
  })

  it('a missed scan says WHICH failure it was, on both phones', () => {
    // "Couldn't find it" sends the user hunting the room when the real problem
    // is a radio switch. Android's rule is pure and unit-tested
    // (VoiceAdoptTest); iOS inlines the same three-way branch.
    const rules = code(ktObject(ktPanels, 'VoiceAdopt'))
    const scanFail = rules.slice(
      rules.indexOf('fun scanFailure'),
      rules.indexOf('fun claimFailure'),
    )
    expect(scanFail.indexOf('fun scanFailure'), 'scanFailure not found — renamed?').toBe(0)
    for (const state of ['"unauthorized"', '"poweredOff"', '"unsupported"']) {
      expect(scanFail, `Android stopped naming the ${state} cause`).toContain(state)
    }
    // ⚠️ This used to pin iOS's INLINE three-way branch and claimed iOS "has no
    // 'unsupported' state" — untrue (Bluetooth.state has always set one), and
    // that belief is exactly why the inline copy reported a radioless phone as an
    // empty room. iOS now asks the shared rule, so check the parity claim where
    // it is decided: `BleEmptyState.obstacle` names all three causes, and `adopt`
    // may not say the necklace is absent until that rule returns nil.
    const swAdopt = code(braceBody(swPanels, swPanels.indexOf('private func adopt() async')))
    expect(swAdopt, 'iOS adopt decides the radio state itself again')
      .toMatch(/BleEmptyState\.obstacle\([\s\S]*?\)\s*\n\s*\?\?/)
    // ⚠️ The MAPPING, not the token. `case "unsupported"` still reads as present
    // when its arm has been changed to `break` — which is how a mutant that made
    // a radioless phone fall through to "nothing nearby" survived a first draft of
    // this very pin. Each radio state must reach a situation, and each situation
    // must reach a sentence in BOTH registers: the caption a person reads and the
    // line handed to the agent.
    const swRule = code(swiftEnum(iosBt, 'BleEmptyState'))
    const CAUSES: [string, string, [string, string]][] = [
      ['"unauthorized"', 'noPermission', ['permission denied', 'permission is denied']],
      ['"poweredOff"', 'radioOff', ['Bluetooth is off', 'turned off']],
      // The one Android names and iOS's inline copy used to drop entirely.
      ['"unsupported"', 'noRadio', ['no Bluetooth radio', 'no Bluetooth radio']],
    ]
    for (const [state, situation, [caption, told]] of CAUSES) {
      expect(swRule, `iOS stopped mapping ${state} to a situation`)
        .toContain(`case ${state}: return .${situation}`)
      for (const cause of [caption, told]) {
        expect(swRule, `iOS stopped naming the ${state} cause ("${cause}")`)
          .toMatch(new RegExp(`case \\.${situation}:\\s*\\n\\s*return "[^"]*${cause}`))
      }
    }
    // Both point at the single likeliest cause of an invisible owned board.
    expect(scanFail, 'Android drops the other-phone hint').toMatch(/tap Release there first/)
    expect(swAdopt, 'iOS drops the other-phone hint').toMatch(/tap Release there first/)
  })

  it('neither phone stores a token it did not get', () => {
    // {ok:true} with no token installs a credential that authenticates
    // nothing, and the break surfaces LATER as an unexplained offline necklace
    // instead of here, where the user is looking at the button they pressed.
    const rules = code(ktObject(ktPanels, 'VoiceAdopt'))
    const claim = rules.slice(rules.indexOf('fun claimFailure'), rules.indexOf('fun token'))
    expect(claim.indexOf('fun claimFailure'), 'claimFailure not found — renamed?').toBe(0)
    expect(claim, 'Android no longer rejects an empty token')
      .toMatch(/optString\("device_token"\)\.isEmpty\(\)/)
    // A 404 is a real answer, not an outage — and it must be checked BEFORE
    // the empty-token branch, because a 404 body carries no token and would
    // otherwise be reported as a retryable server fault forever.
    const at404 = claim.indexOf('404')
    const atEmpty = claim.indexOf('optString("device_token").isEmpty()')
    expect(at404, 'Android stopped distinguishing a 404').toBeGreaterThan(-1)
    expect(at404, 'the 404 check sank below the empty-token check: "not yours" now reads as an outage')
      .toBeLessThan(atEmpty)
    // iOS's inline equivalent: a non-empty token is required to proceed.
    const swAdopt = code(braceBody(swPanels, swPanels.indexOf('private func adopt() async')))
    expect(swAdopt, 'iOS no longer requires a non-empty token').toMatch(/!token\.isEmpty/)
  })

  it('the Android button cannot be double-tapped into two rotations', () => {
    // Two rotations in flight means the second invalidates the token the first
    // just stored — this phone would adopt the board and then lock ITSELF out.
    // `finally` matters as much as the flag: an early `return` on a failed scan
    // leaves the button dead forever without it.
    const ktAdopt = ktFun(ktPanels, 'adopt')
    expect(code(ktAdopt)).toMatch(/adopting = true/)
    expect(code(ktAdopt), 'the busy flag is not released on every path — a failed scan disables the button forever')
      .toMatch(/finally \{[\s\S]*adopting = false/)
    const branch = ktPanels.slice(
      ktPanels.indexOf('if (!isMine) {'),
      ktPanels.indexOf('} else {', ktPanels.indexOf('if (!isMine) {')),
    )
    expect(branch, 'the Adopt button is no longer disabled while adopting').toMatch(/enabled = !adopting/)
    // 44dp — the tap target this project holds everything else to.
    expect(branch, 'the Adopt button is below the 44dp tap target').toMatch(/heightIn\(min = 44\.dp\)/)
  })

  it('the server half exists and never trusts a caller-supplied owner', () => {
    // Adoption rotates a credential, so the ownership check is the only thing
    // standing between a known device id and someone else's hardware.
    const route = read('app/api/devices/adopt/route.ts')
    expect(route).toMatch(/session\.sub/)
    expect(route, 'the route forwards a caller-supplied userId')
      .not.toMatch(/userId: (body|req)\./)
    // A 404 is passed through rather than collapsed into a retry, which is what
    // makes the client's distinct message possible at all.
    expect(route).toMatch(/status === 404/)
    expect(route, 'the route can report success without a token')
      .toMatch(/!data\.device_token/)
  })
})

/**
 * 🎙️⏹️ A take you can stop, that reports how long it really was — iOS
 * `0a0ff3b1` ported to Android.
 *
 * "The Nicla Voice can be a really good voice recorder" was the ask, and a take
 * that slept straight to its deadline is not that: the duration was a promise
 * the user could not take back, so dictating anything longer than a sentence
 * meant tapping again and stitching takes together.
 *
 * Android arrived at the same place from further back — c42 gave it a recorder
 * with NO user-facing entry point at all, only the relay envelope. So this port
 * carries the model rules (sliced sleep, measured duration, a published level)
 * AND the phone's first Record button.
 */
describe('a take can be stopped, and reports its real length, on both phones', () => {
  const recorder = read('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
  const iosRec = read('ios/Tiny/Sources/NiclaRecorder.swift')
  const ktPanels = read('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')

  it('the take sleeps in SLICES on both phones — one long sleep has no stop path', () => {
    // The whole feature rests on this: an uninterruptible sleep to the deadline
    // cannot be ended, so Stop would be a button that does nothing until the
    // take expires on its own.
    const listen = code(ktFun(recorder, 'listen'))
    expect(listen, 'Android sleeps straight to the deadline again — Stop cannot work')
      .not.toMatch(/delay\(seconds \* 1000L\)/)
    expect(listen, 'the sliced wait is gone').toMatch(/while \([\s\S]*?\) \{[\s\S]*?delay\(STOP_TICK_MS\)/)
    // ⚠️ Stop is no longer a `break` inside the loop on EITHER phone: it is the
    // first clause of the stop rule that now decides every tick (`shouldExtend`,
    // iOS `fda07e7a` / Android c57), which is what let `seconds` become a floor. So
    // the pin follows it there rather than asserting a shape both phones left —
    // the requirement was never "a break statement", it is that a stop request
    // reaches the loop's own condition.
    expect(listen, 'Android\'s loop stopped consulting the stop rule')
      .toMatch(/while \(\s*shouldExtend\(/)
    expect(listen, 'the stop request is no longer passed to the rule that reads it')
      .toMatch(/stopRequested/)
    expect(code(ktFun(recorder, 'shouldExtend')), 'Android\'s rule ignores the user\'s Stop')
      .toMatch(/if \(stopRequested\) return false/)
    // iOS's twin loop, through the same rule.
    expect(iosRec).toMatch(/while Self\.shouldExtend\(now: Date\(\)/)
    expect(iosRec).toMatch(/if stopRequested \{ return false \}/)
  })

  it('the stop flag is cleared where the mic is CLAIMED, not when a take ends', () => {
    // The trap both phones document: a stopEarly() landing just after a take
    // finished would otherwise sit set and kill the NEXT take on its first
    // tick. Pinned INSIDE record()'s claim region, bounded at both ends, since
    // a `stopRequested = false` in the teardown reads identical to a grep.
    const rec = code(ktFun(recorder, 'record'))
    const claimAt = rec.indexOf('_isRecording.value = true')
    const takeAt = rec.indexOf('val startedAt')
    expect(claimAt, 'the mic-claim marker moved — re-anchor this pin').toBeGreaterThan(-1)
    expect(takeAt, 'the take start marker moved — re-anchor this pin').toBeGreaterThan(claimAt)
    expect(rec.slice(claimAt, takeAt), 'the stale stop is no longer cleared at claim time')
      .toMatch(/stopRequested = false/)
    // iOS clears it in the same place, right after isRecording = true.
    // Newline-bounded: iOS's own comment about this race quotes
    // `isRecording = true`, so a bare indexOf lands in the prose above the code.
    const iosClaim = iosRec.indexOf('\n        isRecording = true\n')
    expect(iosClaim, 'the iOS claim line moved — re-anchor this pin').toBeGreaterThan(-1)
    const iosTake = iosRec.indexOf('let startedAt')
    expect(iosTake).toBeGreaterThan(iosClaim)
    expect(iosRec.slice(iosClaim, iosTake)).toMatch(/stopRequested = false/)
  })

  it('stopEarly is a REQUEST, not a teardown — the words survive being stopped', () => {
    // What makes a take stopped mid-sentence still keep its transcript:
    // everything after the loop still runs. A stopEarly that released the mic or
    // destroyed the recognizer itself would throw away what it captured.
    const stop = code(ktFun(recorder, 'stopEarly'))
    expect(stop).toMatch(/stopRequested = true/)
    for (const teardown of ['MicClaim.release', 'destroy()', '_isRecording.value = false']) {
      expect(stop, `stopEarly tears the take down (${teardown}) instead of asking it to end`)
        .not.toContain(teardown)
    }
    // And it does nothing when no take is running — see the flag rule above.
    expect(stop, 'a stop with no take running arms the flag for the next one')
      .toMatch(/if \(!_isRecording\.value\) return/)
    // The take still files its transcript on the stopped path.
    expect(code(ktFun(recorder, 'record'))).toMatch(/fileTranscript\(app, take, label\)/)
  })

  it('the duration is MEASURED, not requested, on both phones', () => {
    // Storing the window would label a 4-second stopped take as 120s — in the
    // reply the agent reads, in the transcript store, and in the server row.
    const rec = code(ktFun(recorder, 'record'))
    expect(rec, 'Android stores the requested window as the take length again')
      .not.toMatch(/Take\(true, heard, id, secs\)/)
    expect(rec).toMatch(/actualSeconds\(/)
    expect(rec, 'the elapsed clock is gone').toMatch(/SystemClock\.elapsedRealtime\(\)/)
    // A monotonic clock, not wall time: a take spanning an NTP correction or a
    // DST jump would otherwise measure negative or absurd.
    expect(rec, 'wall-clock time can jump backwards mid-take')
      .not.toMatch(/System\.currentTimeMillis\(\)/)
    // Bounded by the take's CEILING rather than by what it asked for, on both
    // phones — because a take can now legitimately run past its request
    // (`shouldExtend`). Clamping to the request would file every 40-second wake
    // take as 10s, which is the truncation lie moved one step downstream.
    expect(rec, 'the measured length is clamped back to the request')
      .toMatch(/actualSeconds\(android\.os\.SystemClock\.elapsedRealtime\(\) - startedAt, cap\)/)
    // ⚠️ iOS's ceiling is `maxSeconds` unconditionally while Android's is the
    // per-take `cap`, and the difference is deliberate rather than drift: Android's
    // is the TIGHTER of the two (a non-extending 10s take cannot report 11s from the
    // recognizer's settle delay), and `PhoneRecorderTest` pins that bound directly.
    expect(iosRec).toMatch(/max\(1, min\(Self\.maxSeconds, Int\(Date\(\)\.timeIntervalSince\(startedAt\)\.rounded\(\)\)\)\)/)
  })

  it('both phones publish an input level, and Android now shows it', () => {
    // "Recording…" with no meter is a claim the user cannot check: a muted mic
    // or a pocketed phone looks identical to a working take. Android discarded
    // onRmsChanged entirely before this.
    expect(recorder, 'Android throws the mic level away again')
      .not.toMatch(/override fun onRmsChanged\(rmsdB: Float\) \{\}/)
    expect(code(recorder)).toMatch(/_level\.value = meterLevel\(rmsdB\)/)
    expect(iosRec, 'iOS stopped publishing level').toMatch(/level/)
    // …and the panel reads it. A published flow nothing renders is the same bug
    // iOS had: the recorder already had `level` and no screen showed it.
    const panel = ktFun(ktPanels, 'VoiceDevicePanel')
    expect(code(panel), 'the panel no longer reads the level')
      .toMatch(/PhoneRecorder\.level\.collectAsState\(\)/)
    expect(code(panel), 'the meter is gone — nothing renders the level')
      .toMatch(/level \* 10 > i/)
  })

  it('the level resets when a take ends, so a dead meter never reads hot', () => {
    // The last RMS callback of a take leaves the bar wherever the user's voice
    // left it. Without a reset the NEXT take opens showing the previous take's
    // level before its first callback lands — proof of a mic that isn't on yet.
    const rec = code(ktFun(recorder, 'record'))
    const fin = rec.slice(rec.indexOf('} finally {'))
    expect(fin.length, 'the finally block moved — re-anchor this pin').toBeGreaterThan(20)
    expect(fin, 'the meter keeps the last reading after the take ends')
      .toMatch(/_level\.value = 0f/)
  })

  it('the meter maps a dB range Android does not document', () => {
    // Fed raw dB a bar sits pinned at one end. Pure and unit-tested
    // (PhoneRecorderTest) precisely because the range is undocumented.
    const meter = code(recorder).slice(
      code(recorder).indexOf('internal fun meterLevel'),
      code(recorder).indexOf('private val _isRecording'),
    )
    expect(meter.indexOf('internal fun meterLevel'), 'meterLevel not found — renamed?').toBe(0)
    expect(meter, 'the meter no longer clamps — a bar drawn outside its own frame')
      .toMatch(/coerceIn\(0f, 1f\)/)
  })

  it('the phone finally has a Record button of its own', () => {
    // The gap that was WIDER than iOS's: before this, a take could only be
    // started by the relay envelope or a wake word. Android has no Transcripts
    // screen, so the Voice panel is the one place this can live.
    const panel = ktFun(ktPanels, 'VoiceDevicePanel')
    expect(code(panel), 'nothing starts a take by hand').toMatch(/PhoneRecorder\.record\(app, PhoneRecorder\.MAX_SECONDS, "manual"\)/)
    // ONE button, two jobs — a take startable from a screen with no Stop on it
    // is the same bug in a new place.
    expect(code(panel), 'the button cannot end the take it started')
      .toMatch(/PhoneRecorder\.stopEarly\(\)/)
    expect(panel).toMatch(/"Stop and save"/)
    expect(iosRec.includes('stopEarly') || read('ios/Tiny/Sources/Panels.swift').includes('stopEarly'))
      .toBe(true)
    // The full window, not a fixed short take: with a Stop the ceiling is free.
    expect(code(panel), 'the manual take is capped below the recorder ceiling')
      .not.toMatch(/PhoneRecorder\.record\(app, 10,/)
    // A refusal is SURFACED. record() explains every one in words, and a button
    // that silently does nothing is the worst version of that.
    expect(code(panel), 'a refused take says nothing to the user').toMatch(/recordError = /)
    // Bounded on the Record control's OWN region: c43's adopt button is in this
    // same function and carries its own heightIn, so a bare match on the whole
    // panel passed with the Record button shrunk to 180dp wide (measured — this
    // mutant survived until the window was tightened).
    const btnAt = code(panel).indexOf('PhoneRecorder.stopEarly()')
    const labelAt = code(panel).indexOf('"Stop and save"')
    expect(btnAt, 'the Record control moved — re-anchor this pin').toBeGreaterThan(-1)
    expect(labelAt).toBeGreaterThan(btnAt)
    expect(code(panel).slice(btnAt, labelAt), 'the Record control is below the 44dp tap target')
      .toMatch(/heightIn\(min = 44\.dp\)/)
  })
})

/**
 * 🗣️💎 The necklace is understood, not just heard — iOS `7d81ac87` (transcribe
 * the Vision's /audio) plus `f0c524dd` (the four causes that made a plausible
 * implementation transcribe NOTHING) ported to Android.
 *
 * The board served its microphone as GET /audio all along and both phones
 * decoded it, played it, and threw the words away.
 *
 * These rules are pinned because every one of them fails SILENTLY: the stream
 * plays, the card says "live", and the transcript is empty or quietly doubled.
 * iOS found them by measuring real captures (8s and 125s of the board's /audio),
 * so the pins guard MEASUREMENTS — a plausible refactor that drops one of them
 * looks completely fine on screen.
 */
describe('the necklace is transcribed, not just played, on both phones', () => {
  // ⚠️ `SegmentAudio` USED to be nested in here, carrying its own `finish()`, and
  // reading the first match silently moved three of the pins below onto a 12-line
  // file-closer ([ktFun]'s ambiguity guard is what caught it). It now has its own
  // file — because nothing in a nested class inside a SpeechRecognizer driver can be
  // reached by a test, and four mutants proved that — so `finish()` here is once
  // again unambiguously the one that FILES A SEGMENT. If it ever moves back, ktFun
  // fails loudly rather than reading the wrong function.
  const scribe = read('android/app/src/main/java/technology/tiny/app/fleet/LiveScribe.kt')
  const rules = read('android/app/src/main/java/technology/tiny/app/fleet/LiveTranscribe.kt')
  const ktLive = read('android/app/src/main/java/technology/tiny/app/fleet/TinyLive.kt')
  const iosLive = read('ios/Tiny/Sources/TinyLive.swift')
  const card = read('android/app/src/main/java/technology/tiny/app/ui/TinyLiveCard.kt')

  it('the audio loop no longer decodes and discards the words on either phone', () => {
    // The premise. Android's lanAudio read the stream straight into an AudioTrack
    // and nothing else; iOS's feedAudio scheduled the buffer on a player node.
    const lan = code(ktFun(ktLive, 'lanAudio'))
    expect(lan, 'the necklace is played but never read again').toMatch(/scribe\?\.feed\(/)
    expect(code(iosLive), 'iOS stopped feeding its recognizer').toMatch(/speechRequest\?\.append\(buf\)/)
  })

  it('conditioning happens ONCE, before the speaker AND the recognizer', () => {
    // Two consumers of one chunk. Conditioning per-consumer would mean the level
    // the user hears and the level the recognizer reads drift apart, and the
    // measured failure is one-sided: the speaker sounds fine at the board's
    // native level, the recognizer returns nothing at all.
    const lan = code(ktFun(ktLive, 'lanAudio'))
    const decodeAt = lan.indexOf('LiveTranscribe.decode(')
    const gainAt = lan.indexOf('LiveTranscribe.safeGain(')
    const playAt = lan.indexOf('track.write(')
    const feedAt = lan.indexOf('scribe?.feed(')
    expect(decodeAt, 'the decode call moved — re-anchor this pin').toBeGreaterThan(-1)
    expect(gainAt, 'gain is no longer applied in the audio loop').toBeGreaterThan(decodeAt)
    expect(playAt, 'the speaker write moved — re-anchor').toBeGreaterThan(gainAt)
    expect(feedAt, 'the recognizer is fed BEFORE conditioning — it reads raw audio')
      .toBeGreaterThan(gainAt)
    // …and it is fed the CONDITIONED buffer, not the raw chunk. Ordering alone
    // passed with `scribe?.feed(chunk, n)` moved above the speaker write while
    // safeGain stayed put (measured — that mutant survived), which is precisely
    // the failure this whole port exists to fix: the board's native level
    // transcribes to nothing at all.
    expect(lan, 'the recognizer is handed the RAW chunk, not the conditioned buffer')
      .toMatch(/scribe\?\.feed\(out, samples \* 2\)/)
    expect(lan, 'the raw stream chunk is passed to the recognizer')
      .not.toMatch(/scribe\?\.feed\(chunk/)
  })

  it('the board\'s DC offset is removed, and that is what makes level measurable', () => {
    // ~8500 counts of drifting offset (measured 8479 on 9.2s of the board's own
    // /audio, moving 8303→8663; the ~500-800 written here originally was the
    // offset at gain_db=24, which the firmware no longer ships). Left in, a
    // chunk's RMS is dominated by the constant — 0.259 against 0.071 of real
    // signal — so every chunk measures nearly the same level whether anyone is
    // speaking, which is how an energy gate built on top of it looks sensible
    // and is completely inert.
    const dec = code(ktFun(rules, 'decode'))
    expect(dec, 'the running mean is gone — a fixed correction is wrong in seconds')
      .toMatch(/mean = sum \/ n/)
    expect(dec, 'the offset is no longer subtracted').toMatch(/out\[i\] -= mean/)
    expect(code(iosLive), 'iOS stopped removing the offset').toMatch(/out\[i\] -= mean/)
    // Neither phone may hardcode the offset it measured. The whole point of the
    // running mean is that the figure is a firmware knob, so a literal counts
    // value in the arithmetic is the bug this documents, on either side.
    expect(dec, 'Android subtracts a hardcoded offset instead of the running mean')
      .not.toMatch(/8[_,]?479|8500|886/)
  })

  it('BOTH phones document the offset the board actually has, not a retired gain', () => {
    // The figure went stale WITHOUT ANY CODE CHANGING. `f25bb5b3`: the firmware's
    // GAIN_DB digitally multiplies the decimated sample, so when it moved from 24
    // to 48 the offset went 812 → 11,496 and every comment saying "~500-800" or
    // "~886" became ~10x low while remaining perfectly plausible. A comment that
    // is quietly wrong about hardware is how the next person sizes a correction
    // for an offset the board does not have.
    //
    // Pinned on the PROSE, deliberately — a stale measurement is invisible to
    // every behavioural pin in this file, which is exactly why it survived a
    // month. The old figures must be GONE, not merely joined by the new ones.
    for (const [name, src] of [['Android', rules], ['iOS', iosLive]] as const) {
      expect(src, `${name} still claims ~8500 counts nowhere — re-measure or re-anchor`)
        .toMatch(/~8500 counts/)
      expect(src, `${name} documents the retired gain_db=24 offset as if current`)
        .not.toMatch(/sits ~(500-800|886)[ -]count/)
    }
    // And the provenance, on the side that has to re-measure when the knob moves:
    // "8479" alone is a number, "8479 because GAIN_DB=48" is something the next
    // person can check against the firmware.
    expect(rules, 'the GAIN_DB provenance is gone — the figure reads as a mic property')
      .toMatch(/GAIN_DB/)
    expect(rules, 'the firmware sweep that explains the 10x is no longer cited')
      .toMatch(/tiny_audio\.py/)
  })

  it('the two phones\' RMS spans are allowed to differ, and say why', () => {
    // ⚠️ Android measures 0.254-0.279 / 0.050-0.092 where iOS measures
    // 0.249-0.286 / 0.045-0.105 on the SAME capture, because the span is
    // per-chunk and Android always reads 2048 samples while iOS conditions
    // whatever URLSession hands it. A longer window averages more.
    //
    // This pin exists because the OBVIOUS next edit is to "fix the drift" by
    // copying one phone's figures to the other — which would document a number
    // Android's own arithmetic does not produce. The Kotlin has to keep saying
    // that the difference is expected.
    // ⚠️ Matched across the KDoc's own line wrapping (`\n     * `), not as one
    // flat phrase: this pin failed on its first run purely because the sentence
    // wrapped between "not" and "sync" — a false red that says nothing about the
    // caveat being present, which is the sort of pin that gets deleted in
    // annoyance rather than fixed.
    expect(rules.replace(/\n\s*\*\s?/g, ' '), 'the chunk-size caveat is gone — the next sync will copy iOS\'s spans')
      .toMatch(/Do not "sync" these two figures/)
    expect(rules, 'the measured span Android actually produces is no longer stated')
      .toMatch(/0\.254-0\.279/)
  })

  it('the Kotlin tests measure the board too, not a figure they inherited', () => {
    // ⚠️ THIS CYCLE'S DEFECT, in the place it did the most damage. `886` was not a
    // comment in LiveTranscribeTest — it was live test DATA in two tests and in a
    // test's own TITLE, so the suite went on proving decode() silences an offset
    // the board had stopped having, greenly, for a month.
    //
    // Three mutants survived c60's first harness run for ONE reason: nothing read
    // this file. A stale number in a comment is invisible; a stale number in an
    // assertion is invisible AND authoritative. So the test file is a parity
    // surface here, exactly like the sources.
    const ktTest = read('android/app/src/test/java/technology/tiny/app/fleet/LiveTranscribeTest.kt')
    expect(ktTest, 'the DC test data is no longer the measured offset')
      .toMatch(/MEASURED_DC = 8_479/)
    expect(ktTest, 'a bare retired offset is back in the test arithmetic')
      .not.toMatch(/= 886\b|\b886 \+|\b886 and 0xFF/)
    // The threshold is the CLAIM: at 886 the offset is 2.7% of full scale and
    // "removal is not cosmetic" is simply false. Loosened, the assertion accepts
    // the very figure this cycle removed — and no Kotlin test can catch that,
    // because it is a constant compared against a constant.
    expect(ktTest, 'the quarter-of-full-scale threshold was loosened — 886 would pass again')
      .toMatch(/MEASURED_DC \/ 32768f > 0\.2f/)
    // And decode() is proven gain-AGNOSTIC across the firmware's whole sweep, not
    // at one setting: one value passes with a correction hardcoded for it.
    expect(ktTest, 'the gain sweep collapsed to one setting — the knob is untested')
      .toMatch(/intArrayOf\(812, 8_479, 11_496\)/)
  })

  it('makeup gain is a decaying PEAK-HOLD, not an RMS-chasing AGC', () => {
    // Both were built and measured on iOS. A per-chunk RMS normalizer hands a
    // quiet room a huge gain and loud speech a small one, flattening the very
    // speech/silence contrast recognition relies on: on audio already at
    // -25.7 dBFS it wound to 26x, overshot by 12 dB and clipped 86% of a chunk.
    expect(code(rules), 'the peak-hold decay is gone — a stuck estimate pins gain at 1x')
      .toMatch(/previous \* PEAK_DECAY/)
    expect(LiveTranscribeDecay(rules), 'the decay must be < 1 or the hold never releases')
      .toBeLessThan(1)
    // Below the gate the PREVIOUS gain is kept: a pause between sentences is not
    // a reason to re-learn the room, and resetting makes the level pump audibly.
    expect(code(ktExprFun(rules, 'gainFor')), 'a quiet chunk resets the gain again')
      .toMatch(/if \(peakHold <= NOISE_GATE\) current/)
    expect(code(iosLive), 'iOS stopped holding its peak').toMatch(/speechPeak \* 0\.98/)
  })

  it('this chunk is clamped against its own peak BEFORE it is written', () => {
    // Reacting after clipping is observed is too late — the damaged samples have
    // already reached the recognizer, and distorted speech makes it emit sliding
    // two-word guesses instead of sentences.
    expect(code(ktExprFun(rules, 'safeGain'))).toMatch(/PEAK_CEILING \/ chunkPeak/)
    expect(code(iosLive), 'iOS stopped clamping per chunk').toMatch(/Self\.gainPeakCeiling \/ peak/)
  })

  it('a restart is driven by the RECOGNIZER, never by audio energy', () => {
    // ONE session reports ONE utterance and then accepts audio forever doing
    // nothing — 125s of speech through a single session transcribed to nothing.
    // But rebuilding per chunk of silence measured 316 restarts in 125s and
    // destroyed recognition, so urgency comes from HOW it ended.
    const should = code(ktFun(rules, 'shouldRestart'))
    expect(should, 'a live session is restarted — mid-utterance').toMatch(/if \(!ended\) return false/)
    expect(should, 'the two endings are no longer distinguished')
      .toMatch(/deliveredUtterance \|\| sinceStartMs >= MIN_RESTART_MS/)
    // An energy gate here was tried and REMOVED on iOS. Its return would be a
    // silent regression, since on this stream it measures the same every chunk.
    expect(should, 'an energy gate is back in the restart decision')
      .not.toMatch(/rms|energy|level|peak/i)
    expect(code(iosLive), 'iOS stopped distinguishing its two endings')
      .toMatch(/box\.deliveredUtterance \|\| now\.timeIntervalSince\(lastTaskStart\) >= Self\.minRestartSeconds/)
  })

  it('only a session that heard NOTHING is owed the preroll replay', () => {
    // Replaying audio a session already reported manufactures a duplicate; not
    // replaying audio it never reported loses those syllables permanently,
    // because they exist nowhere but the ring.
    expect(code(ktExprFun(rules, 'owedReplay'))).toMatch(/!deliveredUtterance/)
    const restart = code(ktFun(scribe, 'restart'))
    expect(restart, 'the replay decision is gone from restart()').toMatch(/LiveTranscribe\.owedReplay\(/)
    // Ordering is load-bearing: the verdict must be read BEFORE the session is
    // torn down, and both orders type-check.
    const owedAt = restart.indexOf('owedReplay(')
    const tearAt = restart.indexOf('tearDownSession()')
    expect(owedAt, 'owedReplay moved — re-anchor this pin').toBeGreaterThan(-1)
    expect(tearAt, 'the teardown moved — re-anchor').toBeGreaterThan(owedAt)
    expect(code(iosLive), 'iOS stopped asking how its task ended')
      .toMatch(/let owedReplay = !\(speechBox\?\.deliveredUtterance \?\? false\)/)
  })

  it('the preroll is held BEFORE the restart decision that consumes it', () => {
    // A chunk that triggers a restart must already be in the ring, or the replay
    // is missing the very audio that proved the session was dead.
    const feed = code(ktFun(scribe, 'feedInner'))
    const holdAt = feed.indexOf('preroll.addLast(')
    const restartAt = feed.indexOf('shouldRestart(')
    expect(holdAt, 'the preroll append moved — re-anchor this pin').toBeGreaterThan(-1)
    expect(restartAt, 'the restart check moved — re-anchor').toBeGreaterThan(holdAt)
  })

  it('the overlap the replay creates is trimmed word-wise, tolerating junk', () => {
    // THE bug behind 450 characters of sliding fragments: a dying session's last
    // words are a partial GUESS ("…and the"), and requiring an exact suffix match
    // let that one wrong word score a real four-word overlap as zero.
    const seam = code(ktFun(rules, 'bestSeam'))
    expect(seam, 'the junk-word tolerance is gone').toMatch(/for \(junk in 0\.\.3\)/)
    expect(seam, 'a one-word overlap counts again — common words coincide constantly')
      .toMatch(/while \(n >= 2\)/)
    expect(code(iosLive), 'iOS stopped tolerating junk').toMatch(/for junk in 0 \.\.\. 3/)
    // Normalized comparison, because the recognizer re-punctuates the same audio
    // differently between sessions and an exact match finds no overlap at all.
    expect(code(ktFun(rules, 'bank')), 'banking compares raw text again')
      .toMatch(/normalizedWords\(/)
  })

  it('a duplicate is sought across the WHOLE segment, not just the last utterance', () => {
    // A burst of restarts replays overlapping windows of one sentence, so the
    // duplicate is often two or three utterances back.
    const bank = code(ktFun(rules, 'bank'))
    expect(bank).toMatch(/banked\.joinToString\(" "\)/)
    expect(bank, 'the whole-segment containment check is gone').toMatch(/segment\.contains\(incoming\)/)
  })

  it('recognition is ON-DEVICE where the phone supports it', () => {
    // A necklace's microphone is open continuously in someone's home. It must not
    // become a stream of household audio to a server, even though the server-side
    // recognizer is better.
    expect(code(scribe), 'the on-device recognizer is no longer preferred')
      .toMatch(/createOnDeviceSpeechRecognizer/)
    expect(code(iosLive), 'iOS stopped requiring on-device recognition')
      .toMatch(/requiresOnDeviceRecognition = recog\.supportsOnDeviceRecognition/)
  })

  it('the phone\'s own microphone is never opened to transcribe the NECKLACE', () => {
    // This reads the board's stream. Opening the phone mic would file the wrong
    // room's audio under the necklace's name — and would collide with VoiceMode
    // and a PhoneRecorder take over MicClaim, which is why the absence of a claim
    // here is correct rather than forgotten.
    expect(code(scribe), 'LiveScribe opens the phone mic').not.toMatch(/MicClaim|AudioRecord|MediaRecorder/)
    // It feeds a pipe instead — the one real platform difference from iOS.
    expect(code(scribe)).toMatch(/EXTRA_AUDIO_SOURCE/)
    expect(code(scribe), 'the board\'s exact format must be declared or it transcribes nonsense')
      .toMatch(/EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16_000/)
  })

  it('a refusal is REPORTED and latched, not retried thirty times a second', () => {
    // Both halves matter. Unlatched, every chunk re-enters open() and re-fails at
    // stream rate; unreported, the card shows a playing stream with an empty
    // caption bar, which reads exactly like a quiet room.
    const open = code(ktFun(scribe, 'open'))
    expect(open, 'a refusal no longer latches — it will re-fail per chunk').toMatch(/fail\(/)
    expect(code(ktFun(scribe, 'fail')), 'the refusal is not latched').toMatch(/dead = true/)
    expect(code(ktFun(scribe, 'fail')), 'the reason never reaches the user').toMatch(/note\(why\)/)
    expect(code(scribe), 'a dead scribe keeps doing work per chunk').toMatch(/if \(dead \|\| length <= 0\) return/)
    // And the card renders it.
    expect(code(card), 'nothing displays why there are no words').toMatch(/scribeNote/)
    // iOS turns its flag OFF for the same reason, stated in the same words.
    expect(code(iosLive), 'iOS stopped disabling transcription on an unavailable recognizer')
      .toMatch(/transcribeSpeech = false/)
  })

  it('the API floor is stated in words rather than transcribing to nothing', () => {
    // EXTRA_AUDIO_SOURCE is API 33. Below it there is no door at all — and the
    // alternative (opening the phone mic) would be the wrong room's audio.
    expect(code(scribe)).toMatch(/SDK_INT < 33/)
    // minSdk is 29, so this branch is REACHABLE on supported phones — the check
    // is load-bearing, not defensive.
    expect(read('android/app/build.gradle.kts')).toMatch(/minSdk = 29/)
  })

  it('a segment is filed only if someone actually spoke, with a MEASURED duration', () => {
    // An open necklace in a quiet room would otherwise file an empty transcript
    // row every minute forever.
    const finish = code(ktFun(scribe, 'finish'))
    expect(finish, 'a silent segment is filed again').toMatch(/worthStoring\(text\)/)
    expect(finish, 'the duration is not measured').toMatch(/segmentSeconds\(/)
    expect(code(ktExprFun(rules, 'segmentSeconds')), 'a sub-second segment reports 0s')
      .toMatch(/maxOf\(1,/)
    expect(code(iosLive), 'iOS stopped gating on segment length').toMatch(/Self\.minSegmentChars/)
  })

  it('a segment survives its last session dying quiet — the common ending', () => {
    // The last thing a stream does is fall silent, so the final session almost
    // always ends having heard nothing. Reading only the live session would throw
    // away everything banked before it.
    const finish = code(ktFun(scribe, 'finish'))
    const bankAt = finish.indexOf('LiveTranscribe.bank(')
    const textAt = finish.indexOf('segmentText(')
    expect(bankAt, 'finish() no longer banks the live utterance — re-anchor').toBeGreaterThan(-1)
    expect(textAt, 'the segment text is composed before banking — last words lost')
      .toBeGreaterThan(bankAt)
    // And the stream's end closes the segment at all.
    expect(code(ktFun(ktLive, 'lanAudio')), 'the stream ends without closing the segment')
      .toMatch(/scribe\?\.close\(\)/)
    expect(code(iosLive), 'iOS stopped checking its bank').toMatch(/speechRequest != nil \|\| !bankedUtterances\.isEmpty/)
  })

  it('a live segment is attributed to the PHONE and labelled by its source', () => {
    // Filing Vision-heard words under the Voice necklace would put them in the
    // mouth of hardware that was not in the room; the label is how the agent
    // tells the necklace's own microphone from a take the phone recorded.
    // ⚠️ NOW A CONSTANT ON BOTH PHONES, and the pin had to move with it. Android's
    // literal was correct while nothing else read the string; the label is now also
    // what the transcripts row, the tool description and the server all key on, so a
    // literal here is a drift waiting to happen. The `"necklace-live"` this used to
    // match is at the constant's definition — the pin therefore reads the call site
    // for the CONSTANT, and the string itself one line down.
    expect(code(ktFun(scribe, 'finish')), 'the live label is a literal at the call site again')
      .toMatch(/LiveTranscribe\.LIVE_LABEL/)
    expect(rules, 'the Android live label constant is gone')
      .toMatch(/LIVE_LABEL = "necklace-live"/)
    expect(code(scribe), 'the segment no longer shares the take rail')
      .toMatch(/PhoneRecorder\.storeHeard\(/)
    // iOS routes it through a shared constant for the same reason.
    expect(code(iosLive), 'iOS stopped labelling its live segments')
      .toMatch(/label: NiclaRecorder\.liveLabel/)
    expect(read('ios/Tiny/Sources/NiclaRecorder.swift'), 'the iOS live label constant is gone')
      .toMatch(/liveLabel = "necklace-live"/)
  })

  it('the words are shown over the picture, and can be switched off', () => {
    // A continuously-read microphone in someone's home must be switchable without
    // ending the video. LAN only, because remote mode has no PCM stream to read.
    expect(code(card), 'nothing renders the live text').toMatch(/liveText/)
    expect(code(card), 'the caption has no scrim — unreadable on a bright room')
      .toMatch(/Color\.Black\.copy\(alpha = 0\.55f\)/)
    expect(code(card), 'the user cannot stop the necklace being read')
      .toMatch(/TinyLive\.toggleTranscribe\(\)/)
    const toggleAt = code(card).indexOf('toggleTranscribe()')
    const lanAt = code(card).lastIndexOf('Mode.LAN', toggleAt)
    expect(lanAt, 'the caption toggle is offered outside LAN mode, where it does nothing')
      .toBeGreaterThan(-1)
    expect(code(iosLive), 'iOS lost its transcribe toggle').toMatch(/func toggleTranscribe/)
  })

  it('turning the caption off keeps what was already said', () => {
    // Same rule as stopping a take: the words heard so far are the user's, and a
    // toggle is not a delete.
    expect(code(ktFun(ktLive, 'toggleTranscribe')), 'the note is not cleared when re-enabling')
      .toMatch(/_scribeNote\.value = null/)
    expect(code(iosLive), 'iOS discards its segment on toggle-off').toMatch(/finishSegment\(\)/)
    // ⚠️ THIS TEST'S TITLE WAS TRUE OF iOS AND UNASSERTED FOR ANDROID. The two
    // pins above check iOS's finishSegment() and Android's *note* handling — so
    // the Android half of the claim ("keeps what was already said") rested on the
    // word `_scribeNote`, and the loop was free to drop the segment. It did worse
    // than drop it; see the switch block below. Android's keeper is STOP, whose
    // arm files the segment via close() before it clears the recognizer.
    const lanAudio = code(ktFun(ktLive, 'lanAudio'))
    const stopArm = lanAudio.slice(lanAudio.indexOf('Scribe.STOP'))
    expect(lanAudio.indexOf('Scribe.STOP'), 'the stop transition is gone — re-anchor')
      .toBeGreaterThan(-1)
    expect(stopArm.slice(0, 120), 'switching captions off discards the segment instead of filing it')
      .toMatch(/scribe\?\.close\(\)/)
  })

  /**
   * 🔴 The caption switch, honoured mid-stream.
   *
   * `_transcribe` was read in exactly ONE place — the moment `lanAudio` built its
   * `LiveScribe` — and never again. Both directions were broken, and the
   * off-direction is the one that matters: the recognizer kept reading the
   * necklace's microphone after the user switched captions off, and `close()`
   * filed everything it heard. The only visible change was the overlay going
   * blank, which reads exactly like "stopped".
   *
   * The card's icon carries the promise this pins: contentDescription "stop
   * reading the necklace's audio", above a comment arguing that a continuously
   * read microphone in someone's home must be switchable off without ending the
   * video. A control that says that and doesn't do it is worse than no control.
   */
  it('the caption switch is re-read every chunk, not once per stream', () => {
    const lan = code(ktFun(ktLive, 'lanAudio'))
    // The bug's exact shape: the switch decided the scribe's existence at
    // construction, so a `val` could never change.
    expect(lan, 'the switch is read once at stream start again — it cannot take effect')
      .not.toMatch(/val scribe = if \([^)]*_transcribe\.value/)
    expect(lan, 'the audio loop never consults the switch')
      .toMatch(/LiveTranscribe\.scribeAction\(/)
    // ⚠️ …and consults it with the SWITCH, not with a constant. Measured: a mutant
    // passing `scribeAction(true && app != null, …)` left the whole four-state
    // machine intact and every rule test green while the switch was dead again —
    // the original defect, wearing the new code's shape. Asserting that the call
    // exists is not asserting that it is asked the right question.
    expect(lan, 'the switch is not what the loop asks about — captions are always on')
      .toMatch(/scribeAction\(_transcribe\.value && app != null, scribe != null\)/)
    // Inside the loop, after conditioning — where the chunks are.
    const feedAt = lan.indexOf('scribeAction(')
    const loopAt = lan.indexOf('while (')
    expect(loopAt, 'the read loop moved — re-anchor').toBeGreaterThan(-1)
    expect(feedAt, 'the switch is consulted outside the chunk loop, so it is read once')
      .toBeGreaterThan(loopAt)
  })

  it('all four transitions are acted on, and only the transitions rebuild', () => {
    // ⚠️ A rule that returned START whenever captions were on would rebuild the
    // recognizer every chunk — ~30×/second, each rebuild losing the utterance in
    // progress. That failure looks IDENTICAL on screen to the one this whole port
    // exists to fix (no words at all), so the steady states are pinned too.
    const lan = code(ktFun(ktLive, 'lanAudio'))
    for (const arm of ['FEED', 'START', 'STOP', 'IDLE']) {
      expect(lan, `the ${arm} transition is unhandled — the switch is half-wired`)
        .toMatch(new RegExp(`LiveTranscribe\\.Scribe\\.${arm} ->`))
    }
    // START must actually build one; a branch that only logs is the inert half.
    const startArm = lan.slice(lan.indexOf('Scribe.START'))
    expect(startArm.slice(0, 200), 'turning captions on mid-stream builds no recognizer')
      .toMatch(/LiveScribe\(/)
    // ⚠️ And STOP must clear the handle, or the loop-exit close() files the same
    // segment a second time.
    expect(lan.slice(lan.indexOf('Scribe.STOP')).slice(0, 120), 'the stopped scribe is not cleared')
      .toMatch(/scribe = null/)
    // …which only means anything because that loop-exit close() exists. Both
    // halves of "a segment is filed exactly once" live here, and NOTHING pinned
    // the second half until a mutant removed it and the suite stayed green: a
    // stream's final act is usually falling quiet, so dropping the last segment
    // is the COMMON path. It must sit after the read loop's runCatching, where a
    // thrown stream still reaches it.
    // Anchored past `conn.disconnect()` — the last statement INSIDE the loop's
    // runCatching — so the STOP arm's own close() cannot stand in for it. (It
    // would: the arm's call is also a `scribe?.close()`, just an earlier one.)
    const exitAt = lan.lastIndexOf('scribe?.close()')
    const insideEnd = lan.lastIndexOf('conn.disconnect()')
    expect(insideEnd, 'the read loop no longer disconnects — re-anchor').toBeGreaterThan(-1)
    expect(exitAt, "the stream's last segment is dropped — nothing files it at teardown")
      .toBeGreaterThan(insideEnd)
    expect(lan.slice(exitAt, exitAt + 80), 'the recognizer is torn down without being closed')
      .toMatch(/scribe\?\.close\(\)[\s\S]*track\.release\(\)/)
  })

  it('the rule is pure and stated once, so both phones can be checked against it', () => {
    // The decision lives in LiveTranscribe (unit-tested, no recognizer) rather
    // than as three conditions inline in the loop — c57's rule: a decision
    // unreachable from a test is unprotected.
    expect(code(rules), 'the switch rule is inline in the loop again — unreachable from a test')
      .toMatch(/fun scribeAction\(wanted: Boolean, open: Boolean\): Scribe/)
    expect(code(rules), 'the four states collapsed — STOP and IDLE do different work')
      .toMatch(/enum class Scribe \{[\s\S]*?IDLE[\s\S]*?FEED[\s\S]*?START[\s\S]*?STOP[\s\S]*?\}/)
    // iOS's equivalent: its toggle acts immediately because the recognizer lives
    // on the object, not in a local — so it needs no per-chunk rule, and pinning
    // one here would be pinning Android's shape onto iOS.
    // ⚠️ NOT ktFun: that matches Kotlin's `fun name(`, and Swift writes `func`.
    // It returned -1 and failed loudly rather than slicing some other function —
    // which is the anchor assertion earning its keep.
    const iosToggle = code(iosLive).slice(code(iosLive).indexOf('func toggleTranscribe'))
    expect(code(iosLive).indexOf('func toggleTranscribe'), 'iOS lost its toggle — re-anchor')
      .toBeGreaterThan(-1)
    expect(iosToggle.slice(0, 400), 'iOS stopped acting on its own toggle')
      .toMatch(/finishSegment\(\)/)
  })

  it('switching captions off does not end the video', () => {
    // The reason it is a separate control at all. Playing continues on every arm:
    // the AudioTrack write sits above the switch block, not inside an arm of it.
    const lan = code(ktFun(ktLive, 'lanAudio'))
    const playAt = lan.indexOf('track.write(')
    const switchAt = lan.indexOf('scribeAction(')
    expect(playAt, 'the speaker write moved — re-anchor').toBeGreaterThan(-1)
    expect(playAt, 'the necklace is only played while captions are on')
      .toBeLessThan(switchAt)
    expect(code(card), 'the card no longer promises the switch stops the reading')
      .toMatch(/stop reading the necklace's audio/)
  })
})

/** The peak-hold decay constant, read out of the source so the pin can compare it. */
function LiveTranscribeDecay(src: string): number {
  const m = src.match(/PEAK_DECAY = ([\d.]+)f/)
  expect(m, 'PEAK_DECAY is gone or renamed — re-anchor this pin').toBeTruthy()
  return Number(m![1])
}

/**
 * 🗣️🎙️👁️📝 The event ring's WEARABLE glyphs, pinned across all three clients.
 *
 * The ring is one stream with four renderers (web event-icons.ts, iOS
 * Activity.swift, Android Activity.kt, and the agent's own table in prompt.ts),
 * and three of them keep a hand-written copy of the map. That is fine while a
 * test compares the copies — and nothing did for this family, so iOS had glyphs
 * for the nicla kinds that neither other phone nor the web had, and every
 * client's own roster omitted all four. Each roster test passed by iterating a
 * list the kinds were missing from.
 *
 * Parsed out of the tables rather than restated here: a pin that hardcodes the
 * expected glyph is a fourth copy to drift.
 */
describe('a wearable event draws the same glyph on every client', () => {
  const KINDS = ['nicla_wake', 'nicla_transcript', 'nicla_sentry', 'device_note']

  /**
   * kind → glyph, from a `"k" to "g"` (Kotlin) or `("k", "g")` (Swift) table.
   *
   * Bounded to the icons table on purpose. Unbounded, this ate the ROSTER too —
   * `"nicla_wake", "nicla_transcript", …` is a list of bare strings that matches
   * the same shape as a pair, so the later declaration overwrote the table and
   * every kind's "glyph" became the next kind's name. Exactly the unbounded-slice
   * lesson braceBody above was written for.
   */
  const mobileGlyphs = (src: string) => {
    const stripped = code(src)
    // Anchored on the `= [`/`= listOf(` that OPENS the literal, not on the name:
    // Swift's type annotation is `static let icons: [(key: String, ...)] = [`,
    // whose own `]` closed the slice before a single pair was read.
    const m = stripped.match(/(?:KIND_ICONS|icons)[^=]*=\s*(?:listOf\()?\[?/)
    expect(m, 'the icons table is gone or renamed — re-anchor this pin').toBeTruthy()
    const from = m!.index! + m![0].length
    // The closing bracket is INDENTED (`    ]` / `)`), so an unanchored /\n\]/
    // found nothing, `end` came back -1, and the fallback window ran straight
    // into the roster below — the same overwrite, one layer down.
    const rest = stripped.slice(from)
    const close = rest.search(/\n\s*[)\]]/)
    expect(close, 'the icons literal never closes — re-anchor this pin').toBeGreaterThan(-1)
    const table = rest.slice(0, close)
    const out: Record<string, string> = {}
    for (const m of table.matchAll(/\(?"([a-z_]+)"(?:,| to) "([^"]+)"\)?/g)) out[m[1]] = m[2]
    return out
  }

  const web = read('lib/chat/event-icons.ts')
  const ios = read('ios/Tiny/Sources/Activity.swift')
  const kt = read('android/app/src/main/java/technology/tiny/app/ui/Activity.kt')

  it('every client keys all four kinds IN FULL, not behind a `nicla`/`device` prefix', () => {
    // Keyed in full is the requirement, not a detail: `device` is a real prefix
    // of device_note on all three, and the prefix matcher would hand it 💻 — the
    // glyph of a finished laptop task — for a row carrying transcribed speech.
    for (const [name, src] of [['web', web], ['iOS', ios], ['Android', kt]] as const) {
      for (const kind of KINDS) {
        expect(src, `${name} has no full key for ${kind}`).toContain(`"${kind}"`)
      }
    }
  })

  it('the glyphs agree, phone to phone to web', () => {
    const a = mobileGlyphs(ios)
    const b = mobileGlyphs(kt)
    for (const kind of KINDS) {
      expect(a[kind], `iOS has no glyph parsed for ${kind}`).toBeTruthy()
      expect(b[kind], `Android has no glyph parsed for ${kind}`).toBeTruthy()
      expect(b[kind], `${kind}: iOS draws ${a[kind]}, Android draws ${b[kind]}`).toBe(a[kind])
      // The web table is `k: "g"`, so match the glyph against its own key there.
      expect(web, `web disagrees on ${kind} (phones draw ${a[kind]})`)
        .toContain(`${kind}: "${a[kind]}"`)
    }
  })

  it('all four are on every client\'s roster, which is what makes a gap fail', () => {
    // The rosters are the guard; these kinds were absent from all three, so the
    // "every emitted kind has a glyph" test in each language iterated a list
    // that could not see them. Absent from the roster = the guard is off.
    for (const [name, src] of [['web', web], ['iOS', ios], ['Android', kt]] as const) {
      const roster = src.slice(src.indexOf('EMITTED_KINDS') >= 0
        ? src.indexOf('EMITTED_KINDS')
        : src.indexOf('emittedKinds'))
      for (const kind of KINDS) {
        expect(roster, `${name}'s roster omits ${kind}`).toContain(`"${kind}"`)
      }
    }
  })

  it('the wake, the words, and the camera stay three different rows', () => {
    const g = mobileGlyphs(ios)
    const distinct = new Set(KINDS.map((k) => g[k]))
    expect(distinct.size, `two wearable kinds share a glyph: ${JSON.stringify(g)}`).toBe(4)
  })
})

/**
 * ▶️ THE TOOL'S CLAIM ABOUT THE PHONE, HELD AGAINST BOTH PHONES.
 *
 * `c13b87ac` shipped a `nicla_voice_transcripts` description instructing every
 * agent to say "open the tiny app to listen" for a necklace-live row and NEVER
 * "there is no audio". That is a server-side sentence making a factual claim about
 * client software, and it was true of exactly one of the two clients: iOS wrote a
 * per-segment file and played it; Android's `LiveScribe.finish()` filed text only.
 * So an Android user was sent to a screen with nothing to press, by a sentence
 * neither phone's tests could see.
 *
 * ⚠️ THIS IS THE CLASS OF DEFECT NO BEHAVIOURAL PIN CAN CATCH, on either side: the
 * tool suite proves the sentence is in the prompt, and each phone's suite proves
 * what that phone does. Only something reading BOTH can notice they disagree. So
 * each pin below starts from the description's own words and requires the machinery
 * on BOTH phones — and every one of them fails on the Android tree as it stood.
 */
describe('a tool that promises playable audio promises it on both phones', () => {
  const tool = read('lib/chat/tools/nicla-voice.ts')
  const desc = (() => {
    // ⚠️ Anchored on the tool's own DEFINITION (`name: '…'`), not on the first
    // mention of the string: two other tools name this one in their prose, and the
    // earliest hit is a doc comment at the top of the file — which would slice a
    // sibling tool's description and pass or fail for reasons unrelated to this one.
    const at = tool.indexOf("name: 'nicla_voice_transcripts'")
    expect(at, 'the transcripts tool is gone or renamed — re-anchor this pin').toBeGreaterThan(-1)
    const d = tool.indexOf('description:', at)
    expect(d, 'the tool lost its description').toBeGreaterThan(-1)
    const end = tool.indexOf('\n', d)
    const slice = tool.slice(d, end)
    // A description is one long line here; anything short means the shape moved.
    expect(slice.length, 'the description scrape came back too short to be one')
      .toBeGreaterThan(400)
    return slice
  })()
  const scribeKt = read('android/app/src/main/java/technology/tiny/app/fleet/LiveScribe.kt')
  const segmentKt = read('android/app/src/main/java/technology/tiny/app/fleet/SegmentAudio.kt')
  const rulesKt = read('android/app/src/main/java/technology/tiny/app/fleet/LiveTranscribe.kt')
  const recorderKt = read('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
  const sheetKt = read('android/app/src/main/java/technology/tiny/app/ui/TranscriptsSheet.kt')
  const iosRecorder = read('ios/Tiny/Sources/NiclaRecorder.swift')

  it('the premise still holds: the tool still tells agents the phone kept it', () => {
    // If this ever fails, the sentence was reworded or dropped — and then the pins
    // below are guarding a promise nobody makes any more. Fix THIS first, or every
    // assertion under it is about a claim that no longer exists.
    expect(desc, 'the tool no longer promises local audio — re-read this whole block')
      .toContain('the phone keeps the segment\'s audio locally')
    expect(desc).toContain('playable on the row in the tiny app')
    expect(desc).toContain('open the tiny app to listen')
  })

  it('BOTH phones write a per-segment audio file while the necklace talks', () => {
    // iOS: SegmentAudio, fed off the same buffers as the recognizer.
    expect(iosRecorder, 'iOS lost SegmentAudio').toContain('SegmentAudio')
    // 🔴 Android's whole gap. `finish()` stored words and nothing else, so the
    // sentence above was false here for as long as it has been shipped.
    expect(segmentKt, 'Android keeps no segment audio — the tool\'s claim is false here')
      .toMatch(/class SegmentAudio\(/)
    // Written from feed(), where the board's PCM already is. Anywhere else means
    // it is re-opening the microphone, which on this phone is impossible.
    const feed = ktFun(code(scribeKt), 'feedInner')
    expect(feed, 'Android opens no audio on the feed path')
      .toMatch(/audio\s*=\s*PhoneRecorder\.audioDir\(app\)/)
    // ⚠️ AND THE SAMPLES ARE ACTUALLY HANDED OVER, unconditionally. A mutant that
    // wired the writer and then guarded the write on `chunk.isEmpty()` survived a
    // whole battery: every name and every rule still read right, and the file was 44
    // bytes of header with no audio in it. Behaviour is pinned in SegmentAudioTest;
    // what only this pin can see is that the feed path calls it on every chunk.
    expect(feed, 'the segment writer is wired but never fed on the normal path')
      .toMatch(/^\s*audio\?\.write\(chunk, chunk\.size\)\s*$/m)
  })

  it('BOTH phones hand the file to the row, so the audio has an owner', () => {
    expect(iosRecorder).toMatch(/func storeHeard\([^)]*audioFile:/s)
    expect(recorderKt, 'Android storeHeard takes no audioFile')
      .toMatch(/suspend fun storeHeard\([\s\S]{0,300}?audioFile: String\? = null/)
    // ⚠️ AND THE VALUE IS THE FILE, not merely the parameter's presence. This pin
    // used to read `/audioFile\s*=/`, which `audioFile = null` satisfies — so THE
    // DEFECT THIS WHOLE BLOCK EXISTS TO FIX survived a mutation battery under a
    // green pin. The close-and-name is now ONE call (SegmentAudio.finishAndName) so
    // that "closed the file, then filed no pointer" cannot be written as two lines
    // that each look correct.
    const fin = ktFun(code(scribeKt), 'finish')
    expect(fin, 'the segment is closed without being named — a row with no audio')
      .toMatch(/keptAudio\s*=\s*seg\?\.finishAndName\(\)/)
    expect(fin, 'Android files a segment with no audio')
      .toMatch(/audioFile\s*=\s*keptAudio\b/)
    expect(fin, 'the row is filed a literal null again')
      .not.toMatch(/audioFile\s*=\s*null/)
    // ⚠️ AND THE OTHER BRANCH DISCARDS. A segment whose words aren't worth storing
    // must not be FINISHED: finishing keeps the file under its pending name, which no
    // row can address, so it sits on someone's disk until the ten-minute orphan gate
    // notices — for a minute of an empty room, every minute the card is open. Pinned
    // at the call site because `finish()` lives inside the recognizer driver and no
    // JVM test can construct it; SegmentAudioTest owns discard()'s own behaviour.
    const bail = fin.slice(0, fin.indexOf('finishAndName'))
    expect(bail, 'the discard branch moved — re-anchor this pin').toContain('worthStoring')
    expect(bail, 'a segment not worth storing is not discarded — its file leaks')
      .toMatch(/seg\?\.discard\(\)/)
    expect(bail, 'the discarded segment is finished instead — the file survives')
      .not.toMatch(/seg\?\.finish/)
  })

  it('BOTH phones can RESOLVE a row\'s audio, by whatever join each uses', () => {
    // ⚠️ Deliberately different mechanisms, and the pin has to allow that: iOS
    // resolves a row's own `audioFile` against its store dir; Android has no local
    // index at all (TranscriptsSheet's header says why) and puts the pointer in the
    // FILE NAME instead. Requiring iOS's shape on Android would demand the index
    // Android deliberately refuses.
    expect(iosRecorder).toContain('static func audioURL(for t: NiclaTranscript)')
    expect(recorderKt, 'Android cannot find a row\'s audio')
      .toMatch(/fun audioFor\(app: TinyApp, rowId: String\)/)
    // ⚠️ ONE function owns the join, and both ends read it. Two mutants walked
    // through the old `"$rowId.wav"` grep untouched — renaming a file to its own
    // name (so the join silently never happens) and discarding the server's id (so
    // every recording is deleted as its row lands) — because both halves lived in
    // private suspend funs taking a TinyApp, where nothing could test them. The rule
    // is pure now and LiveTranscribeTest drives it; these pins only check that the
    // two call sites go through it instead of spelling the name themselves.
    expect(rulesKt, 'the join is no longer a stated rule')
      .toMatch(/fun claimedAudioName\(serverId: String\?\)/)
    expect(ktFun(code(recorderKt), 'claimAudio'), 'the writer does not use the shared join')
      .toMatch(/LiveTranscribe\.claimedAudioName\(serverId\)/)
    expect(ktExprFun(code(recorderKt), 'audioFor'), 'the reader does not use the shared join')
      .toMatch(/LiveTranscribe\.claimedAudioName\(rowId\)/)
    // And the id it joins on is the SERVER's, not the local UUID nothing server-side
    // has ever seen. A mutant returning null here deleted every recording ever kept.
    expect(ktFun(code(recorderKt), 'fileTranscript'), 'the server id is discarded again')
      .toMatch(/return res\.optString\("id"\)\.trim\(\)\.takeIf \{ it\.isNotEmpty\(\) \}/)
  })

  it('BOTH phones put a PLAY control on the row the tool points at', () => {
    // The end of the sentence: "playable on the row in the tiny app". A file on
    // disk with no button is the same user-visible lie.
    expect(iosRecorder, 'iOS lost the row player').toMatch(/audioURL\(for: t\)/)
    expect(sheetKt, 'the Android transcripts row has no player').toContain('MediaPlayer')
    expect(sheetKt, 'the Android row draws no play control')
      .toContain('Icons.Outlined.PlayCircle')
    // ⚠️ Gated on a file that was FOUND, never on the label. A Play button over
    // nothing reads as broken audio rather than as audio never kept — and a take
    // owns none by platform constraint, so a label-gated button would be wrong on
    // every row it drew.
    expect(sheetKt, 'the Android play control is not gated on a file it found')
      .toMatch(/localAudio\[t\.id\]\?\.let/)
    expect(sheetKt).toMatch(/PhoneRecorder\.audioFor\(app, r\.id\)/)
  })

  it('the tool bounds its own promise, because the budget can make it false', () => {
    // ⚠️ THE SENTENCE ABOVE HAS AN EXPIRY, and for a long time it did not say so.
    // Both phones bound automatic audio (the next pin), so eviction is a NORMAL
    // outcome for an old necklace-live row — not an error path. "Open the tiny app
    // to listen, never 'there is no audio'" then sends the user to a row whose
    // recording the phone itself deleted, and the agent has stated a fact about
    // that phone's disk that it never had any way to check.
    //
    // The fix is not to weaken the sentence — it is right for the recent rows that
    // are almost always what is being asked about. It is to make the promise say
    // which rows it covers, and to say the words are the durable half.
    expect(desc, 'the promise is unconditional again — the budget can falsify it')
      .toContain("if it's still there")
    expect(desc, 'the description does not say what makes the audio go away')
      .toMatch(/frees the oldest/)
    expect(desc, 'the agent is not told the text survives eviction')
      .toMatch(/keeping every word|WORDS are never evicted/)

    // And the iOS row can actually TELL the difference, which is what makes the
    // hedge honest rather than a shrug. Eviction cleared `audioFile` — the value a
    // text-only row already had — so a freed recording and one that never existed
    // were the same pixels and the same absent button.
    expect(iosRecorder, 'iOS cannot distinguish freed audio from audio never kept')
      .toMatch(/var audioFreed: Bool/)
    expect(iosRecorder, 'the eviction no longer records that it happened')
      .toMatch(/static func applyEvictions\(/)
    expect(iosRecorder, 'pruneAndSave clears audioFile without recording why')
      .toMatch(/kept = Self\.applyEvictions\(rows: kept, evict: evict\)/)
    // ⚠️ The flag must SURVIVE, and this is the field that has wiped this store
    // before: a plain `decode` of a key no stored row has throws, loadIndex() turns
    // any throw into [], and every transcript on the phone is gone.
    expect(iosRecorder, 'audioFreed is decoded in a way that wipes the transcript store')
      .toMatch(/audioFreed = try c\.decodeIfPresent\(Bool\.self, forKey: \.audioFreed\) \?\? false/)
    // The user-visible half. The tool description now names this label out loud, so
    // the two would otherwise be free to drift into disagreeing.
    expect(iosRecorder, 'the freed row shows no tell — an absent button says nothing')
      .toContain('audio freed for space')
    expect(desc, 'the tool names a label the app does not show')
      .toContain('audio freed for space')

    // 🔴 ANDROID DELIBERATELY CANNOT DO THIS, and the hedge is what covers it. The
    // sheet has no local index (TranscriptsSheet's header says why) and probes the
    // audio dir per row, so "no file" is all it can ever know — a freed segment, a
    // take that never had samples, and another phone's row are one state there. A
    // flag would need the index Android refuses to keep, so the honest fix on that
    // side is the tool no longer claiming more than a disk probe can support.
    //
    // Anchored on the MACHINERY, not on the word "index.json" — the header mentions
    // it by name to explain why Android has none, so a prose match here would have
    // failed on the very comment that documents the choice.
    expect(sheetKt, 'the Android row no longer probes the disk — re-read this pin')
      .toMatch(/PhoneRecorder\.audioFor\(app, r\.id\)/)
    expect(sheetKt, 'Android grew a per-row audio flag — then the tool can stop hedging')
      .not.toMatch(/audioFreed/)
  })

  it('BOTH phones BOUND the kept audio, and neither bounds it by deleting words', () => {
    // A necklace files one segment a minute for as long as its card is open, so
    // "keep it all" is unbounded growth on someone's phone — the reason iOS has a
    // budget at all. The text is never the thing evicted: it is what the agent
    // reads, and it is small.
    expect(iosRecorder).toContain('static func audioEvictions')
    expect(iosRecorder).toContain('static func orphanAudio')
    expect(rulesKt, 'Android bounds nothing — live audio would grow forever')
      .toMatch(/fun audioEvictions\(/)
    expect(rulesKt, 'Android collects no orphaned segments').toMatch(/fun orphanAudio\(/)
    // ⚠️ AND SOMETHING CALLS THEM. Two pure functions nothing invokes are a budget
    // in name only — the exact shape of a shipped-inert fix this loop has hit before.
    expect(recorderKt, 'nothing sweeps the Android audio dir')
      .toMatch(/fun sweepAudio\(app: TinyApp\)/)
    // ⚠️ BOTH DOORS THROUGH ONE PURE CALL. This used to grep the sweep for the two
    // function names, and a mutant that computed the byte budget and threw the result
    // away (`.let { emptyList() }`) satisfied it perfectly — the symbols were still
    // referenced and nothing was ever evicted. The composition is a rule now, so
    // LiveTranscribeTest can assert by OUTCOME that no file escapes both doors.
    expect(rulesKt, 'the two sweeps are no longer composed where a test can see it')
      .toMatch(/fun audioSweep\(files: List<Triple<String, Long, Int>>, budget: Int\)/)
    const composed = ktExprFun(code(rulesKt), 'audioSweep')
    expect(composed).toContain('orphanAudio')
    expect(composed).toContain('audioEvictions')
    expect(ktFun(code(recorderKt), 'sweepAudio'), 'the sweep does not use the composed rule')
      .toMatch(/LiveTranscribe\.audioSweep\(seen, LiveTranscribe\.LIVE_AUDIO_BUDGET\)/)
    const app = read('android/app/src/main/java/technology/tiny/app/TinyApp.kt')
    expect(app, 'the sweep is never reached at launch')
      .toMatch(/PhoneRecorder\.sweepAudio\(this@TinyApp\)/)
  })

  it('⚠️ the budgets are per-phone MEASUREMENTS and must not be "synced"', () => {
    // iOS stores 45s AAC segments (~197KB measured) and budgets 96MB ≈ 6.2h.
    // Android has no AAC encoder on this path and writes PCM16LE, so a 60s segment
    // costs 1.92MB — ~10× as much. The same 96MB would therefore mean 51 minutes,
    // not 6.2 hours: identical constants here would be a silent lie about how much
    // audio a phone keeps. So this pin asserts they DIFFER, and that each states
    // its own arithmetic.
    const iosBudget = iosRecorder.match(/liveAudioBudget\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)
    const ktBudget = rulesKt.match(/LIVE_AUDIO_BUDGET\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)
    expect(iosBudget, 'iOS budget constant moved — re-measure both').toBeTruthy()
    expect(ktBudget, 'the Android budget constant is gone').toBeTruthy()
    expect(Number(ktBudget![1]), 'Android copied iOS\'s figure for different bytes')
      .not.toBe(Number(iosBudget![1]))
    // Each side shows its work, since a figure whose derivation is missing is the
    // one that gets "synced" by the next reader.
    expect(iosRecorder, 'iOS stopped stating its measurement').toContain('197KB')
    expect(rulesKt, 'the Android budget states no derivation').toContain('1.92MB')
    // And Android's is derived, not typed twice.
    expect(rulesKt).toMatch(/fun segmentAudioBytes\(\)[^\n]*SEGMENT_MS/)
  })

  it('the label the tool names is the same constant both phones file under', () => {
    // The tool description quotes "necklace-live" and the eviction/lookup rules key
    // off it. Three copies of a string, one of which is in a prompt.
    expect(desc).toContain('necklace-live')
    expect(rulesKt).toContain('const val LIVE_LABEL = "necklace-live"')
    expect(iosRecorder).toMatch(/liveLabel\s*=\s*"necklace-live"/)
  })

  it('⚠️ the Android writer\'s SILENT rules are covered by a test, not by greps', () => {
    // ⚠️ THE LESSON OF THIS CYCLE, pinned so it cannot quietly reverse. Four defects
    // in the segment writer survived a full mutation battery — the finished header
    // declaring ZERO samples (the missing-moov defect), a failed write rethrowing and
    // taking the segment's TRANSCRIPT with it, a 44-byte empty file kept as a
    // playable row, and a discarded segment leaking its file. All four were "pinned"
    // by source greps, and a grep cannot see what the bytes on disk say.
    //
    // They were unreachable because the writer was a private class nested inside a
    // driver built out of SpeechRecognizer/Handler/ParcelFileDescriptor. It is its
    // own file now, touching nothing but java.io, and these are the behaviours a JVM
    // test must keep driving. A pin naming a test file is weaker than a pin on
    // behaviour — but this suite runs on node and cannot execute Kotlin, and the
    // alternative (deleting the greps and trusting the move) is how a class slides
    // back inside its driver and takes its coverage with it.
    const segTest = read('android/app/src/test/java/technology/tiny/app/fleet/SegmentAudioTest.kt')
    expect(segTest, 'the segment writer has no behavioural test again')
      .toMatch(/class SegmentAudioTest/)
    for (const [what, needle] of [
      ['the finished header describes the samples on disk', /assertEquals\(\s*"the data chunk declares the samples on disk"/],
      ['samples land after the header, not over it', /the samples land AFTER the header/],
      ['a failed write costs the audio, never the words', /a write that throws costs the audio and never the caller/],
      ['an empty segment is deleted, not kept', /a segment nobody spoke into is deleted/],
      ['a discarded segment leaves no file', /discard removes the file a segment not worth storing wrote/],
    ] as const) {
      expect(segTest, `no longer tested: ${what}`).toMatch(needle)
    }
    // And it stays REACHABLE: back inside LiveScribe and none of the above can run.
    expect(segmentKt, 'SegmentAudio moved back into a driver a test cannot construct')
      .toMatch(/^internal class SegmentAudio\(/m)
    expect(scribeKt, 'the writer is nested in the recognizer driver again')
      .not.toMatch(/class SegmentAudio\(/)
  })

  it('the "no audio for a take" constraint is scoped to the phone\'s OWN mic', () => {
    // ⚠️ WHY A COMMENT IS PINNED HERE. PhoneRecorder's header said Android "never
    // sees the samples" — accurate about a TAKE (SpeechRecognizer captures inside
    // Google's process) and read as a blanket "Android has no audio", which is what
    // made this gap look like a platform limit rather than a missing feature for as
    // long as it existed. A necklace-live segment arrives over the network and
    // passes through this app's memory. No behavioural pin can see a true comment
    // that guarantees the wrong thing.
    expect(recorderKt, 'the platform constraint is unscoped again')
      .toContain('THE CONSTRAINT IS ABOUT THIS PHONE\'S OWN MICROPHONE')
    expect(recorderKt).toMatch(/those rows DO own a local\s*\n?\s*\*?\s*file/)
    // And the sheet, which used to repeat it as "Android has none to own".
    expect(sheetKt, 'the transcripts sheet still claims Android owns no audio')
      .not.toMatch(/Android has none to own/)
  })
})

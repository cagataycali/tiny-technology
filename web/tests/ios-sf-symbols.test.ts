// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * 🔠 Every SF Symbol the iOS app names must actually exist.
 *
 * `Image(systemName:)` does not fail loudly on a typo — it silently draws a
 * generic placeholder glyph. That is how `flipper.fill` (never an Apple symbol)
 * shipped into the devices panel and read, to the user, as "a file icon is
 * there". Nothing in the compiler, the linker or a code review catches it;
 * only looking at the screen does, and only if you happen to own a Flipper.
 *
 * So this checks the names against the system's own symbol database:
 *   /System/Library/CoreServices/CoreGlyphs.bundle/…/name_availability.plist
 * which also carries each symbol's introduction year — enough to catch the
 * second, sneakier version of the same bug: a name that IS real but is newer
 * than the deployment target, so it renders on the dev's phone and blanks on
 * everyone else's.
 *
 * macOS-only by nature (the plist and `plutil` are Apple's). CI runs on
 * ubuntu-latest, so the suite skips rather than fails there — a check that
 * can't run must not masquerade as a check that passed.
 */

const ROOT = process.cwd()
const PLIST =
  '/System/Library/CoreServices/CoreGlyphs.bundle/Contents/Resources/name_availability.plist'

/** Lowercase dot-separated tokens — the shape every SF Symbol name has. */
const SYMBOL_SHAPE = /^[a-z0-9]+(?:\.[a-z0-9]+)*$/

function swiftFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.swift')) out.push(p)
    }
  }
  for (const r of ['ios/Tiny/Sources', 'ios/Shared', 'ios/TinyWatch/Sources',
                   'ios/TinyWidgets', 'ios/TinyWatchWidgets']) {
    walk(join(ROOT, r))
  }
  return out
}

/** Literals inside a `name(…)` call are ARGUMENTS, not symbol names. */
const isComputed = (segment: string) => /\w\s*\(/.test(segment)

/**
 * Where a symbol name can come from, in order of how the app writes them:
 *   A. `Image(systemName: …)` / `Label(…, systemImage: …)`, including ternaries
 *      (`systemName: on ? "a" : "b"` names TWO symbols).
 *   B. functions and tables whose name says they produce a glyph —
 *      `capabilityIcon`, `deviceGlyph`, `DEVICE_KIND_GLYPH` …
 *   C. the design system's `TinyDesign.icon*` constants.
 */
export function symbolLiterals(source: string): Map<string, number[]> {
  const found = new Map<string, number[]>()
  const add = (name: string, line: number) => {
    if (!SYMBOL_SHAPE.test(name)) return
    const at = found.get(name) ?? []
    at.push(line)
    found.set(name, at)
  }

  const lines = source.split('\n')
  lines.forEach((line, i) => {
    // A — call sites
    for (const key of ['systemName:', 'systemImage:']) {
      let idx = line.indexOf(key)
      while (idx !== -1) {
        const rest = line.slice(idx + key.length)
        const close = rest.indexOf(')')
        const seg = close === -1 ? rest : rest.slice(0, close)
        if (!isComputed(seg)) {
          // Array.from around every iterator in this file: tsconfig targets es5
          // without downlevelIteration, so `for…of` over a matchAll/Map is a
          // compile error and ci-typecheck-gate.test.ts is a real gate here.
          Array.from(seg.matchAll(/"([^"\\]*)"/g)).forEach((m) => add(m[1], i + 1))
        }
        idx = line.indexOf(key, idx + key.length)
      }
    }
    // C — design-system constants
    const konst = line.match(/static let icon\w+\s*=\s*"([^"]+)"/)
    if (konst) add(konst[1], i + 1)
  })

  // B — glyph producers. Scoped to functions/tables NAMED as glyph producers so
  // that ordinary `case "x": return "y"` label maps elsewhere aren't mistaken
  // for symbols (MemoryGraph's edge kinds, ModelConfig's provider ids …).
  // `String?` counts: a producer that returns nil for words it doesn't know is
  // the honest signature (capabilityIcon does), and a `\?`-less pattern would
  // have quietly stopped covering it the moment it gained one — a silent loss of
  // coverage on the exact function whose typo started this file.
  const producer = /(?:func\s+\w*(?:Icon|Glyph|Symbol)\w*\s*\([^)]*\)\s*->\s*String\??\s*\{|(?:let|var)\s+\w*(?:ICON|GLYPH|SYMBOL)\w*[^=]*=\s*\[)/g
  for (const m of Array.from(source.matchAll(producer))) {
    const start = m.index! + m[0].length
    const opener = m[0].endsWith('[') ? '[' : '{'
    const closer = opener === '[' ? ']' : '}'
    let depth = 1
    let j = start
    while (j < source.length && depth > 0) {
      if (source[j] === opener) depth++
      else if (source[j] === closer) depth--
      j++
    }
    const body = source.slice(start, j)
    const lineOf = (offset: number) =>
      source.slice(0, start + offset).split('\n').length
    Array.from(body.matchAll(/return\s+"([^"]+)"/g))
      .forEach((r) => add(r[1], lineOf(r.index!)))
    // Table entries: ("needle", "symbol") or "key": "symbol"
    Array.from(body.matchAll(/(?:,|:)\s*"([^"]+)"\s*\)?\s*,?\s*(?:\/\/.*)?$/gm))
      .forEach((r) => add(r[1], lineOf(r.index!)))
  }
  return found
}

function loadSymbolDatabase(): { symbols: Record<string, string>; iosOf: Record<string, string> } | null {
  if (process.platform !== 'darwin' || !existsSync(PLIST)) return null
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', PLIST], {
      maxBuffer: 1 << 26,
    }).toString()
    const db = JSON.parse(json)
    const iosOf: Record<string, string> = {}
    for (const [year, rel] of Object.entries<any>(db.year_to_release ?? {})) {
      if (rel?.iOS) iosOf[year] = String(rel.iOS)
    }
    return { symbols: db.symbols ?? {}, iosOf }
  } catch {
    return null
  }
}

/** ios/project.yml is the source of truth for the deployment target. */
function deploymentTarget(): number {
  const yml = readFileSync(join(ROOT, 'ios/project.yml'), 'utf8')
  const m = yml.match(/iOS:\s*"?([0-9.]+)"?/)
  return m ? parseFloat(m[1]) : 18
}

const db = loadSymbolDatabase()

describe.skipIf(db === null)('every SF Symbol the app names is real', () => {
  const files = swiftFiles()

  it('finds the sources at all (a silent empty sweep is not a pass)', () => {
    expect(files.length).toBeGreaterThan(40)
    const all = files.flatMap((f) => Array.from(symbolLiterals(readFileSync(f, 'utf8')).keys()))
    expect(new Set(all).size).toBeGreaterThan(80)
  })

  it('no name is a typo — the whole reason the devices panel drew a file icon', () => {
    const bad: string[] = []
    for (const f of files) {
      for (const [name, lines] of Array.from(symbolLiterals(readFileSync(f, 'utf8')))) {
        if (db!.symbols[name] === undefined) {
          bad.push(`${f.slice(ROOT.length + 1)}:${lines.join(',')} → "${name}"`)
        }
      }
    }
    expect(bad, `not SF Symbols (Image(systemName:) draws a placeholder):\n${bad.join('\n')}`)
      .toEqual([])
  })

  it('no name is newer than the deployment target', () => {
    const target = deploymentTarget()
    const tooNew: string[] = []
    for (const f of files) {
      for (const [name, lines] of Array.from(symbolLiterals(readFileSync(f, 'utf8')))) {
        const year = db!.symbols[name]
        const needs = year === undefined ? undefined : db!.iosOf[String(year)]
        if (needs && parseFloat(needs) > target) {
          tooNew.push(`${f.slice(ROOT.length + 1)}:${lines.join(',')} → "${name}" needs iOS ${needs}`)
        }
      }
    }
    expect(tooNew, `blank on any device below iOS ${target}:\n${tooNew.join('\n')}`).toEqual([])
  })

  it('the Flipper capability wears a real symbol now', () => {
    // The reported bug, pinned by name so a revert can't sneak back in.
    const panels = readFileSync(join(ROOT, 'ios/Tiny/Sources/Panels.swift'), 'utf8')
    expect(db!.symbols['flipper.fill']).toBeUndefined()
    const flipper = panels.match(/case "flipper": return "([^"]+)"/)
    expect(flipper?.[1]).toBeTruthy()
    expect(db!.symbols[flipper![1]]).toBeDefined()
  })
})

describe('the extractor itself', () => {
  // The sweep above is only worth its green if it can actually see the sites it
  // claims to cover — a regex that quietly matches nothing is the failure mode.
  it('reads plain call sites, ternaries, and glyph tables', () => {
    const got = symbolLiterals(`
      Image(systemName: "wave.3.right")
      Label("Revoke", systemImage: "xmark.circle")
      Image(systemName: on ? "waveform" : "waveform.slash")
      static let iconRelay = "antenna.radiowaves.left.and.right"
      func capabilityIcon(_ c: String) -> String {
        switch c {
        case "flipper": return "wave.3.right"
        default: return "circle.dashed"
        }
      }
      private let DEVICE_KIND_GLYPH: [String: String] = [
        "endpoint": "cube.transparent",
      ]
    `)
    for (const n of ['wave.3.right', 'xmark.circle', 'waveform', 'waveform.slash',
                     'antenna.radiowaves.left.and.right', 'circle.dashed',
                     'cube.transparent']) {
      expect(Array.from(got.keys()), `missed ${n}`).toContain(n)
    }
  })

  it('still reads a producer that returns an optional', () => {
    // capabilityIcon returns nil for words it has no icon for. The `?` must not
    // hide the arms above it: this is the shape shipping today.
    const got = Array.from(symbolLiterals(`
      func capabilityIcon(_ c: String) -> String? {
        switch c {
        case "glasses": return "eyeglasses"
        default: return nil
        }
      }
    `).keys())
    expect(got).toContain('eyeglasses')
  })

  it('does not mistake a call argument or a label map for a symbol', () => {
    const got = Array.from(symbolLiterals(`
      Image(systemName: capabilityIcon("flipper"))
      Image(systemName: "gear").accessibilityLabel("settings")
      func edgeLabel(_ k: String) -> String {
        switch k {
        case "supersedes": return "supersedes"
        }
      }
      let headers = ["role": "system"]
    `).keys())
    expect(got).toContain('gear')
    for (const n of ['flipper', 'settings', 'supersedes', 'system']) {
      expect(got, `false positive: ${n}`).not.toContain(n)
    }
  })
})

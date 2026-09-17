// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ⌨️ What the KEYBOARD is told about a field, on Android as on iOS.
 *
 * iOS says this on ~30 text fields across 6 files: `.textInputAutocapitalization(.never)`
 * + `.autocorrectionDisabled()` for anything machine-shaped, and `SecureField` for
 * anything secret. Android said it at TWO call sites out of 24 fields, and both set only
 * `capitalization` — the knob that was already correct.
 *
 * ⚠️ THE DEFAULT IS THE DEFECT, and not the one the names suggest. Measured out of the
 * shipped Compose 1.9.0 classes (`javap` on `foundation-release.aar` / `ui-release.aar`),
 * not assumed:
 *
 *   - `KeyboardOptions.autoCorrectEnabled` is a NULLABLE Boolean and
 *     `getAutoCorrectOrDefault()` returns **true** (`iconst_1`) when unset. Every field
 *     that says nothing is asking the keyboard to rewrite it.
 *   - `getCapitalizationOrDefault()` resolves unspecified → **None**. Which is why a grep
 *     for `KeyboardCapitalization` read as "present": the two existing call sites were
 *     setting the harmless knob.
 *   - `TextInputServiceAndroid_androidKt.update` builds `EditorInfo.inputType` from
 *     **`KeyboardType`**, never from `visualTransformation`. A field with
 *     `PasswordVisualTransformation` and no `KeyboardType.Password` is an ordinary text
 *     field to the IME — masked on screen, eligible for the learned-words dictionary.
 *     **Masking is a drawing decision; secrecy is an inputType.**
 *   - And `TYPE_TEXT_FLAG_AUTO_CORRECT` (32768) is OR'd in AFTER that switch, gated only
 *     on `hasFlag(inputType, TYPE_CLASS_TEXT)`. `KeyboardType.Password` is inputType
 *     **129**, which HAS that bit — so the password type alone still autocorrects. Both
 *     knobs are required; neither implies the other. (`KeyboardType.Number` is 2, no text
 *     class, exempt from both — numeric fields are correct as-is.)
 *
 * So the unit of this suite is not "does a knob have the right value" — `FieldOptionsTest`
 * executes that on the JVM, where a nullable default can actually be observed. The unit
 * here is the one a Kotlin test cannot see: **which SCREENS ask**, and whether iOS still
 * agrees.
 *
 * ⚠️ THE ROSTER IS DERIVED FROM iOS, not listed here, and that direction is deliberate.
 * A roster of "every Android field" would go slack the day a screen is added; a roster
 * derived from iOS's own guards turns this suite red when iOS gains a guarded field with
 * no Android counterpart — which is exactly the drift that produced 22 unguarded fields.
 */

const ROOT = process.cwd()
const ANDROID = 'android/app/src/main/java/technology/tiny/app'
const IOS = 'ios/Tiny/Sources'
const OPTIONS = `${ANDROID}/ui/FieldOptions.kt`

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/**
 * Comments BLANKED to spaces, keeping every byte offset (and so every line number) intact.
 *
 * Load-bearing twice over, and both cases were found by this suite failing on itself:
 *
 *  - `FieldOptions.kt`'s docblock explains the bug by NAMING the wrong value ("a grep
 *    cannot tell `= false` from `= true`"), so asserting the file never *says*
 *    `autoCorrectEnabled = true` failed on the sentence describing why. A prose mention is
 *    not a call.
 *  - ⚠️ And it must be STRING-AWARE. A naive `//[^\n]*` blanks the `//` inside
 *    `"https://api.example.com/v1"` (Panels.kt's base-URL placeholder), erasing the rest
 *    of that line — including, three lines later, the very `keyboardOptions` the test was
 *    looking for. It reported a guarded field as unguarded: a FALSE POSITIVE from the
 *    scanner, which is the failure mode that gets a real fix reverted.
 */
function code(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"') {
      // Raw string (""" … """) or ordinary; either way copy it through verbatim.
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3)
        const stop = end === -1 ? src.length : end + 3
        out += src.slice(i, stop); i = stop; continue
      }
      out += c; i++
      while (i < src.length && src[i] !== '"' && src[i] !== '\n') {
        if (src[i] === '\\') { out += src[i]; i++ }
        if (i < src.length) { out += src[i]; i++ }
      }
      if (i < src.length) { out += src[i]; i++ }
      continue
    }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue
    }
    out += c; i++
  }
  return out
}

/** Every `.kt` under the app's source root, recursively. */
function kotlinFiles(dir = ANDROID): string[] {
  const out: string[] = []
  let names: string[]
  try { names = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const n of names.sort()) {
    const rel = join(dir, n)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...kotlinFiles(rel))
    else if (n.endsWith('.kt')) out.push(rel)
  }
  return out
}

/**
 * The body of a balanced `(...)` call starting at `from` (the index of the `(`).
 *
 * Needed because a Compose call site spans 5-15 lines and the question — "does THIS field
 * state its options" — is per-call, not per-line. Returns '' if the parens never balance,
 * and the callers assert on a non-empty slice so a broken slicer cannot read as "clean".
 */
function callBody(src: string, from: number): string {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(from, i + 1)
    }
  }
  return ''
}

type Field = { file: string; line: number; body: string }

/** Every Compose text-input call site in the app, sliced whole. */
function androidFields(): Field[] {
  const out: Field[] = []
  for (const f of kotlinFiles()) {
    const src = read(f)
    // ⚠️ Comments are BLANKED, not deleted, so byte offsets and therefore reported line
    // numbers still point at the real file. `MainActivity.kt` explains its BasicTextField
    // choice in a comment that names `TextField` twice — matched on the raw text, those
    // are two phantom call sites with unbalanced bodies.
    const bare = code(src)
    const re = /\b(?:OutlinedTextField|BasicTextField|TextField)\s*\(/g
    for (let m = re.exec(bare); m; m = re.exec(bare)) {
      const open = m.index + m[0].length - 1
      // Body read off `bare` too, for two reasons: a `)` inside a comment would break
      // the paren balance, and a comment mentioning `FieldOptions.secret` must not
      // satisfy a check that the field USES it. (Several call sites here carry exactly
      // such comments.)
      out.push({ file: f, line: src.slice(0, m.index).split('\n').length, body: callBody(bare, open) })
    }
  }
  return out
}

/**
 * iOS's guarded fields, by FILE — the set of screens iOS decided are machine-shaped or
 * secret.
 *
 * Read as whole-file matches, because the question is which SCREEN guards its input, and
 * because the two modifiers routinely wrap onto a second line
 * (`Settings.swift:117-118`) while others chain on one (`TinySetup.swift:476`).
 */
function iosGuardedFiles(): string[] {
  return readdirSync(join(ROOT, IOS))
    .filter(n => n.endsWith('.swift'))
    .filter(n => {
      const s = read(`${IOS}/${n}`)
      return s.includes('.autocorrectionDisabled()') || s.includes('SecureField(')
    })
    .sort()
}

/**
 * iOS screen → the Android file that is its counterpart.
 *
 * ⚠️ `Panels.swift` is deliberately absent: its only keyboard statement is
 * `.textInputAutocapitalization(.sentences)` on a job NAME (Panels.swift:1999) — prose,
 * not an identifier — and its search field is `.searchable`, a system field. It carries no
 * `.autocorrectionDisabled()` / `SecureField`, so it never enters the roster; if it gains
 * one, the unmapped test below says so.
 */
const COUNTERPART: Record<string, string> = {
  'TinySetup.swift': `${ANDROID}/ui/Nearby.kt`,        // SSID + WiFi password
  // Both iOS WiFi screens map to Nearby.kt because Android keeps the SSID and
  // password fields in the one pairing sheet, while iOS split the saved-list
  // editor out into TinyWifi.swift. The FIELDS check below is about the keyboard
  // guards on those fields, which Nearby.kt does state — the saved LIST itself
  // is still unported (Nearby.kt:239 sends a single pair), and that gap is
  // pinned by nicla-android-parity.test.ts, not by this suite.
  'TinyWifi.swift': `${ANDROID}/ui/Nearby.kt`,         // saved-network editor: SSID + password
  'Settings.swift': `${ANDROID}/ui/Panels.kt`,         // default tiny, server, model config, voice key
  'Onboarding.swift': `${ANDROID}/ui/Onboarding.kt`,   // the tiny's handle
  'Views.swift': `${ANDROID}/ui/PrivateLockPanel.kt`,  // private-tiny access key
  'Wallet.swift': `${ANDROID}/ui/Wallet.kt`,           // payout address + tx hash
}

const IOS_GUARDED = iosGuardedFiles()
const FIELDS = androidFields()

describe('the comment stripper (it produced a false positive once)', () => {
  it('blanks comments and preserves line numbers', () => {
    const out = code('a = 1 // note\nb = 2\n/* x\n y */\nc = 3\n')
    expect(out.split('\n').length).toBe(6)
    expect(out).not.toContain('note')
    expect(out.split('\n')[1]).toBe('b = 2')
    expect(out.split('\n')[4]).toBe('c = 3')
  })

  it('does NOT treat // inside a string as a comment', () => {
    // ⚠️ The exact bug: Panels.kt's base-URL placeholder is
    // `"https://api.example.com/v1"`, and blanking from that `//` swallowed the
    // `keyboardOptions` three lines below it — reporting a guarded field as bare.
    const out = code('p = "https://api.example.com/v1",\nkeyboardOptions = X,\n')
    expect(out).toContain('https://api.example.com/v1')
    expect(out).toContain('keyboardOptions = X')
  })

  it('keeps an escaped quote from ending the string early', () => {
    const out = code('s = "a \\" // b"\nkeyboardOptions = X\n')
    expect(out).toContain('keyboardOptions = X')
  })

  it('leaves raw strings intact', () => {
    const out = code('s = """http://x // y"""\nkeyboardOptions = X\n')
    expect(out).toContain('keyboardOptions = X')
  })
})

describe('Android keyboard options — parity with iOS field guards', () => {
  it('finds the iOS guarded screens at all (an empty roster proves nothing)', () => {
    // Without this the suite passes vacuously the day the modifier is spelled
    // differently or `ios/Tiny/Sources` moves: green, pinning nothing.
    expect(IOS_GUARDED.length).toBeGreaterThanOrEqual(5)
  })

  it('finds the Android fields at all (a broken slicer must not read as clean)', () => {
    expect(FIELDS.length).toBeGreaterThanOrEqual(20)
    // Every slice balanced. A `callBody` that returned '' would make every
    // "does it state options" check below pass by inspecting nothing.
    const empty = FIELDS.filter(f => f.body === '')
    expect(empty.map(f => `${f.file}:${f.line}`)).toEqual([])
  })

  it('every iOS guarded screen has a named Android counterpart', () => {
    // A NEW `.autocorrectionDisabled()` or `SecureField` on iOS lands here rather than
    // silently on the floor — the derived direction is the whole point.
    const unmapped = IOS_GUARDED.filter(f => !COUNTERPART[f])
    expect(
      unmapped,
      `iOS guards text input in ${unmapped.join(', ')} and this suite records no ` +
      `Android counterpart. Either point the counterpart's fields at FieldOptions or ` +
      `add it here with a comment saying why that screen deliberately differs.`,
    ).toEqual([])
  })

  it.each(IOS_GUARDED.filter(f => COUNTERPART[f]).map(f => [f, COUNTERPART[f]] as const))(
    '%s → its Android counterpart states its keyboard options', (swift, file) => {
      const src = read(file)
      expect(
        src,
        `${file} is the Android counterpart of iOS ${swift}, which disables ` +
        `autocorrect / uses SecureField, but it never references FieldOptions — its ` +
        `fields are taking Compose's default, where autoCorrectEnabled resolves to TRUE.`,
      ).toMatch(/FieldOptions\.(identifier|secret|prose)\b/)
    },
  )

  it('every iOS SecureField screen has an Android field declaring the password type', () => {
    // The sharp half. `PasswordVisualTransformation` is what these screens HAD — it
    // draws dots and tells the IME nothing, so the key stayed eligible for the
    // learned-words dictionary. iOS's SecureField implies the inputType; on Android it
    // must be said out loud.
    const secretScreens = IOS_GUARDED
      .filter(f => read(`${IOS}/${f}`).includes('SecureField(') && COUNTERPART[f])
    expect(secretScreens.length).toBeGreaterThanOrEqual(3)
    for (const swift of secretScreens) {
      const file = COUNTERPART[swift]
      expect(
        read(file),
        `iOS ${swift} uses SecureField; ${file} must use FieldOptions.secret so the ` +
        `IME gets KeyboardType.Password — masking alone does not keep a key out of the ` +
        `keyboard's dictionary.`,
      ).toMatch(/FieldOptions\.secret\b/)
    }
  })

  it('every masked Android field also declares the password keyboard type', () => {
    // The invariant stated over the ANDROID tree, not derived: a field that draws dots
    // and does not say KeyboardType.Password is the exact defect, wherever it appears.
    const masked = FIELDS.filter(f => f.body.includes('PasswordVisualTransformation'))
    expect(masked.length).toBeGreaterThanOrEqual(4)
    const unsafe = masked.filter(f => !/FieldOptions\.secret\b/.test(f.body))
    expect(
      unsafe.map(f => `${f.file}:${f.line}`),
      `these fields mask their value on screen but tell the keyboard it is ordinary ` +
      `text — the IME may keep it in its learned words and offer it in another app. ` +
      `Use FieldOptions.secret.`,
    ).toEqual([])
  })

  it('no field states capitalization alone (the shape that fixed nothing)', () => {
    // ⚠️ The trap this whole increment came out of. `KeyboardOptions(capitalization =
    // None)` sets the value an unset field ALREADY resolves to, so it reads as a
    // considered decision while leaving autocorrect on. If it comes back, it must come
    // back through FieldOptions, where the other knob travels with it.
    const bare = FIELDS.filter(f =>
      /KeyboardOptions\s*\(\s*(?:capitalization|\s)*[^)]*capitalization\s*=/.test(f.body) &&
      !/autoCorrectEnabled/.test(f.body) &&
      !/FieldOptions\./.test(f.body))
    expect(
      bare.map(f => `${f.file}:${f.line}`),
      `capitalization-only options leave autoCorrectEnabled unset, which Compose ` +
      `resolves to TRUE. Use FieldOptions.identifier / .secret / .prose.`,
    ).toEqual([])
  })

  it('every field says something, or is a read-only dropdown anchor', () => {
    // The count that found this bug: 22 of 24 fields said nothing. A numeric keyboard
    // counts as saying something — inputType 2 has no TYPE_CLASS_TEXT bit, so Compose
    // skips both the autocorrect and the capitalization flags for it.
    const silent = FIELDS.filter(f =>
      !/keyboardOptions/.test(f.body) &&
      !/readOnly\s*=\s*true/.test(f.body))
    expect(
      silent.map(f => `${f.file}:${f.line}`),
      `these fields state no keyboardOptions, so they inherit Compose's default where ` +
      `autoCorrectEnabled resolves to TRUE. Pick a FieldOptions shape — including ` +
      `.prose, which says "a sentence belongs here" rather than saying nothing.`,
    ).toEqual([])
  })

  it('the rule is one object, and its predicates are executed not grepped', () => {
    const src = code(read(OPTIONS))
    expect(src.length, 'the comment-stripper ate the file').toBeGreaterThan(400)
    for (const name of ['identifier', 'secret', 'prose', 'keepsVerbatim', 'keepsSecret']) {
      expect(src, `FieldOptions must define ${name}`).toContain(name)
    }
    // The polarity, at the one place it is written. A nullable Boolean whose unset value
    // is `true` cannot be pinned by source text alone — hence the JVM suite — but the
    // literal must at least not be inverted here.
    expect(src).toMatch(/autoCorrectEnabled\s*=\s*false/)
    expect(src).not.toMatch(/autoCorrectEnabled\s*=\s*true/)
    // ⚠️ `keepsVerbatim` must ask `== false`, not `!= true`: null means true, and
    // `!= true` accepts the unset default — the defect, restated as its own test.
    expect(
      src,
      `keepsVerbatim must compare against false explicitly — autoCorrectEnabled is ` +
      `nullable and null means TRUE, so "!= true" would accept an unguarded field.`,
    ).toMatch(/autoCorrectEnabled\s*==\s*false/)
    // And the JVM suite that executes it exists.
    const jvm = read('android/app/src/test/java/technology/tiny/app/ui/FieldOptionsTest.kt')
    expect(jvm).toMatch(/keepsVerbatim\(KeyboardOptions\.Default\)/)
    expect(jvm).toMatch(/keepsSecret\(KeyboardOptions\(keyboardType\s*=\s*KeyboardType\.Password\)\)/)
  })

  it('prose is not KeyboardOptions.Default (or "chose" and "said nothing" merge)', () => {
    // If `prose` were the bare default object, the previous test's "every field says
    // something" would be satisfiable by an object indistinguishable from silence.
    const src = code(read(OPTIONS))
    expect(src).toContain('val prose')
    const decl = src.slice(src.indexOf('val prose'))
    expect(decl.slice(0, 200)).toMatch(/KeyboardCapitalization\.Sentences/)
    expect(decl.slice(0, 200)).not.toMatch(/KeyboardOptions\.Default/)
  })
})

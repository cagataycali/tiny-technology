// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { qrSvgProblem, sanitizeQrSvg, QR_SVG_MAX } from '../lib/qr-svg'

/**
 * Backlog v8 A3 — the install banner injects its QR with
 * `dangerouslySetInnerHTML`, and the only thing making that safe was a comment
 * about the single caller ("our own qrcode-lib SVG, no user input").
 *
 * The rule is an ALLOWLIST of the QR vocabulary, so the tests below are written
 * as "does the real generator's output pass, and does everything else fail" —
 * NOT as a list of known attacks, which is the losing side of that game.
 */

/** Byte-for-byte shape of `QRCode.toString({type:'svg', margin:2, width:256})`,
 *  captured from the real library (trimmed in the middle — the path data is
 *  long and its content is irrelevant to the parse). */
const REAL_QR =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 29 29" ' +
  'shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h29v29H0z"/>' +
  '<path stroke="#0a0a0a" d="M2 2.5h7m1 0h2m2 0h1m1 0h1m3 0h7M2 3.5h1m5 0h1m2 0h1"/></svg>\n'

describe('the real generator output is accepted', () => {
  it('accepts the qrcode lib SVG exactly as produced, trailing newline and all', () => {
    expect(qrSvgProblem(REAL_QR)).toBeNull()
    expect(sanitizeQrSvg(REAL_QR)).toBe(REAL_QR)
  })

  it('accepts the shapes a different QR library would plausibly emit', () => {
    expect(qrSvgProblem('<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="1" height="1" fill="#000"/></svg>')).toBeNull()
    expect(qrSvgProblem('<svg viewBox="0 0 4 4"><g transform="scale(1)"><path d="M0 0h1v1H0z"/></g></svg>')).toBeNull()
    // fill-rule + class are on the list because they are inert and common.
    expect(qrSvgProblem('<svg viewBox="0 0 1 1"><path class="qr" fill-rule="evenodd" d="M0 0h1v1H0z"/></svg>')).toBeNull()
  })

  it('returns the ORIGINAL string, never a rewritten one', () => {
    // This is an allowlist, not a sanitizer: it must not silently alter the
    // markup, or the QR could be corrupted into an unscannable one.
    expect(sanitizeQrSvg(REAL_QR)).toBe(REAL_QR)
  })
})

describe('anything that is not a QR is refused wholesale', () => {
  it('refuses script execution vectors by them not being on the list', () => {
    const bad = [
      '<svg><script>fetch("//x/"+localStorage.length)</script></svg>',
      '<svg onload="alert(1)"><path d="M0 0"/></svg>',
      '<svg><path d="M0 0" onclick="alert(1)"/></svg>',
      '<svg><path d="M0 0" onmouseover=alert(1) /></svg>',
      '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject></svg>',
      '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
      '<svg><set attributeName="onload" to="alert(1)"/></svg>',
    ]
    for (const s of bad) expect(qrSvgProblem(s), s).not.toBeNull()
  })

  it('refuses anything that can reach off-origin', () => {
    // No allowed attribute holds a URL, so `href`/`src`/`xlink:href` are all
    // rejected by absence — including on tags that ARE allowed.
    for (const s of [
      '<svg><image href="https://evil.com/x.png"/></svg>',
      '<svg><use href="#x"/></svg>',
      '<svg><path d="M0 0" href="https://evil.com"/></svg>',
      '<svg><path d="M0 0" xlink:href="https://evil.com"/></svg>',
      '<svg><path d="M0 0" fill="url(https://evil.com/x)"/></svg>',
    ]) {
      expect(qrSvgProblem(s), s).not.toBeNull()
    }
  })

  it('refuses markup APPENDED to an otherwise-valid QR', () => {
    const s = REAL_QR.trimEnd() + '<img src=x onerror=alert(1)>'
    expect(qrSvgProblem(s)).not.toBeNull()
  })

  it('refuses a second root even when the appended markup is itself ALLOWED', () => {
    // ⚠️ This case is what actually isolates the end-anchor. The test above it
    // passes on the ATTRIBUTE rule (`src`/`onerror`), so deleting the anchor
    // left it green — a mutation survivor. Appending `<path>`, which every
    // other rule accepts, leaves the anchor as the only thing that can refuse.
    const s = '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg><path d="M0 0"/>'
    expect(qrSvgProblem(s)).toBe('does not end with </svg>')
  })

  it('refuses a disallowed TAG on the tag rule alone', () => {
    // ⚠️ Same isolation problem: `<script>alert(1)</script>` is refused by the
    // TEXT-CONTENT rule ("unexpected content before <script>"), and `<image
    // href=…>`/`<use href=…>` by the ATTRIBUTE rule — so none of them proves
    // the tag allowlist works. These have no text and no attributes.
    expect(qrSvgProblem('<svg><foreignObject/></svg>')).toBe('<foreignobject> is not allowed')
    expect(qrSvgProblem('<svg><iframe/></svg>')).toBe('<iframe> is not allowed')
    expect(qrSvgProblem('<svg><style/></svg>')).toBe('<style> is not allowed')
    expect(qrSvgProblem('<svg><script/></svg>')).toBe('<script> is not allowed')
  })

  it('refuses markup PREPENDED to a valid QR', () => {
    expect(qrSvgProblem('<img src=x onerror=alert(1)>' + REAL_QR)).not.toBeNull()
    expect(qrSvgProblem('<!--c-->' + REAL_QR)).not.toBeNull()
    expect(qrSvgProblem('<?xml version="1.0"?>' + REAL_QR)).not.toBeNull()
  })

  it('refuses text content between the tags', () => {
    // A QR has no text nodes at all, so this rule is free — and it's what stops
    // anything the tag scanner didn't recognise from being skipped unexamined.
    expect(qrSvgProblem('<svg viewBox="0 0 1 1">hello</svg>')).not.toBeNull()
    expect(qrSvgProblem('<svg viewBox="0 0 1 1"><![CDATA[x]]></svg>')).not.toBeNull()
    // ...but whitespace and newlines between tags are fine.
    expect(qrSvgProblem('<svg viewBox="0 0 1 1">\n  <path d="M0 0"/>\n</svg>')).toBeNull()
  })

  it('a `>` inside an attribute VALUE does not end the tag', () => {
    // If the scanner were not quote-aware, everything after the first `>` in a
    // value would be treated as text/markup and the parse would go wrong.
    //
    // ⚠️ This asserts the VERDICT, which is all a caller can observe — it does
    // not isolate the quote-awareness, and mutating it away leaves this green
    // (the `[<>]` value check refuses the same input for a different reason).
    // Two rules in lib/qr-svg are unreachable-by-construction this way and are
    // documented as such there rather than covered by a test that only appears
    // to: the quote-aware TAG blob, and the final trailing-content check behind
    // the `</svg>` anchor. Don't write a test for either — write an input that
    // reaches it, or leave them documented.
    expect(qrSvgProblem('<svg viewBox="0 0 1 1"><path d="M0 0" class="a>b"/></svg>')).not.toBeNull()
  })

  it('refuses a non-string, an empty string, and an oversized payload', () => {
    for (const v of [undefined, null, 42, {}, ['<svg></svg>']]) {
      expect(qrSvgProblem(v as unknown), String(v)).not.toBeNull()
    }
    expect(qrSvgProblem('')).toBe('empty')
    expect(qrSvgProblem('   ')).toBe('empty')
    const huge = `<svg viewBox="0 0 1 1"><path d="${'M0 0'.repeat(QR_SVG_MAX)}"/></svg>`
    expect(qrSvgProblem(huge)).toMatch(/too long/)
  })

  it('names WHY it refused, so a vanished banner is explainable', () => {
    expect(qrSvgProblem('<div>x</div>')).toMatch(/<svg/)
    expect(qrSvgProblem('<svg><script>x</script></svg>')).toMatch(/script/)
    expect(qrSvgProblem('<svg onload="x"><path d="M0 0"/></svg>')).toMatch(/onload/)
  })
})

describe('a refusal degrades exactly like a generation failure', () => {
  it("returns '' — the same value app/page.tsx yields when QR building throws", () => {
    // Chosen deliberately: the banner already self-hides on a falsy qrSvg, so
    // an unsafe QR needs no new UI state and no error copy the user can't act on.
    expect(sanitizeQrSvg('<svg onload="alert(1)"></svg>')).toBe('')
    expect(sanitizeQrSvg(undefined)).toBe('')
  })

  it("app/page.tsx still degrades to '' on failure, which the banner still treats as hide", () => {
    const page = readFileSync(join(__dirname, '..', 'app/page.tsx'), 'utf8')
    expect(page).toMatch(/catch\s*\{\s*return ''/)
    const banner = readFileSync(join(__dirname, '..', 'components/chat/IosInstallBanner.tsx'), 'utf8')
    expect(banner).toMatch(/!safeQrSvg\) return/)
  })
})

describe('the sink is wired to the gate', () => {
  const banner = () =>
    readFileSync(join(__dirname, '..', 'components/chat/IosInstallBanner.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('the innerHTML payload is the SANITIZED value, never the raw prop', () => {
    const src = banner()
    expect(src).toMatch(/dangerouslySetInnerHTML=\{\{\s*__html:\s*safeQrSvg\s*\}\}/)
    expect(src).not.toMatch(/__html:\s*qrSvg/)
  })

  it('gating happens at the COMPONENT, so a second caller inherits it', () => {
    // Not at app/page.tsx: `qrSvg` is a public string prop, and the whole
    // finding was that the safety claim lived one file away from the sink.
    const src = banner()
    expect(src).toMatch(/sanitizeQrSvg\(qrSvg\)/)
  })

  it('nothing but the gate reads the raw prop', () => {
    // If a future edit reads `qrSvg` in a second place (a length check, another
    // render path), that read bypasses the allowlist. Asserted as "every
    // occurrence is one of the three legitimate ones" rather than as a COUNT:
    // a count is brittle (a prose mention of the name breaks it — the c55 trap
    // in reverse) and it can't say WHICH read is the offending one.
    const src = banner()
    const lines = src.split('\n').filter((l) => /\bqrSvg\b/.test(l))
    const legit = [
      /\{ url, qrSvg \}: \{ url: string; qrSvg: string \}/,   // the prop + its type
      /sanitizeQrSvg\(qrSvg\)/,                                // the gate
    ]
    for (const l of lines) {
      expect(legit.some((r) => r.test(l)), `this line reads qrSvg outside the gate: ${l.trim()}`).toBe(true)
    }
    // ...and the gate itself must be one of them, or the loop passes vacuously
    // on zero lines.
    expect(lines.some((l) => /sanitizeQrSvg\(qrSvg\)/.test(l))).toBe(true)
  })

  it('no dangerouslySetInnerHTML in web takes an ungated value', () => {
    // The v8 census, extended to this sink class. Each of the three was made
    // safe in a different place and a different way; this is the one list.
    const repo = join(__dirname, '..')
    const SINKS: { file: string; gate: RegExp; what: string }[] = [
      { file: 'components/chat/IosInstallBanner.tsx', gate: /__html:\s*safeQrSvg/, what: 'the install QR' },
      // The JSON-LD blob \u-escapes < > & and the JSON-legal line separators.
      { file: 'app/[slug]/page.tsx', gate: /\.replace\(HTML_UNSAFE_IN_JSON,/, what: "a tiny's structured data" },
      // The pre-paint theme script is a literal with no interpolation: assert
      // that, since "no ${} inside it" is precisely what keeps it safe.
      { file: 'app/layout.tsx', gate: /__html:\s*`\(function\(\)\{[^`]*`/, what: 'the pre-paint theme script' },
    ]
    for (const s of SINKS) {
      const src = readFileSync(join(repo, s.file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(src, `${s.file} injects ${s.what} — that value must be gated`).toMatch(s.gate)
    }
  })
})

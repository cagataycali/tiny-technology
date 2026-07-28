/**
 * The install banner's QR is injected with `dangerouslySetInnerHTML`. This is
 * what makes that safe by RULE rather than by provenance.
 *
 * Backlog v8 A3 (lens = "a third-party string reaching a navigation/execution
 * sink"). The site is `IosInstallBanner.tsx:131`, and its comment says "our own
 * qrcode-lib SVG, no user input". That is TRUE today — `app/page.tsx` builds it
 * server-side from the hardcoded `A2HS_URL` — but the value arrives as a
 * `qrSvg: string` prop, and a string prop is a promise nobody is keeping:
 * a second caller passing a per-tiny URL, a QR of a user-supplied deep link, or
 * a swapped QR library are all one small edit away, and none of them would
 * touch the line that assumes otherwise. The sibling sinks are gated by rule
 * (`app/[slug]` \u-escapes `< > &` before its JSON-LD; `app/layout.tsx` inlines
 * a literal with no interpolation) — this was the one relying on a comment.
 *
 * ALLOWLIST, not sanitization: a QR is a fixed, tiny vocabulary — verified
 * against the real output of `QRCode.toString({type:'svg'})`, which is
 * `<svg …><path fill …/><path stroke … d="…"/></svg>` and 1.3 KB. So instead of
 * trying to strip dangerous things (the losing side of that game), anything not
 * recognisably a QR is refused wholesale. `on*=` handlers, `<script>`,
 * `<foreignObject>`, `<use href>` and `<image>` are all rejected by not being
 * on the list, rather than by being enumerated as threats.
 *
 * The failure mode is the banner's OWN existing degrade path: `app/page.tsx`
 * already returns `''` when QR generation throws, and the banner already
 * self-hides on a falsy `qrSvg` (`IosInstallBanner:59`). A refused SVG becomes
 * `''`, so "unsafe" and "unavailable" take the identical, already-tested route
 * — no new UI state, no error copy for a case a user can't act on.
 *
 * Pure — no DOM, no parser — so every rule here is a node test.
 */

/** A real QR is ~1.3 KB. Anything this large is not the thing we asked for. */
export const QR_SVG_MAX = 20_000

/** Elements a QR needs. `g`/`rect` are not emitted today but are inert and are
 *  what a different QR library would plausibly use. */
const ALLOWED_TAGS = new Set(['svg', 'g', 'path', 'rect'])

/**
 * Attributes a QR needs (compared lowercase). This set is what does the
 * security work: every event handler is rejected simply by being absent, as is
 * every URL-bearing attribute (`href`, `xlink:href`, `src`), so no element can
 * reach out of the document.
 */
const ALLOWED_ATTRS = new Set([
  'xmlns',
  'width',
  'height',
  'viewbox',
  'shape-rendering',
  'fill',
  'fill-rule',
  'stroke',
  'stroke-width',
  'd',
  'x',
  'y',
  'transform',
  'class',
])

/**
 * A tag, with quote-aware attribute scanning so `>` inside a value can't end it.
 *
 * ⚠️ The quote-awareness cannot change any VERDICT while the value check below
 * rejects `[<>]`: a `>` inside a value is refused either way, just with a
 * different reason (an unquoted scan desyncs and reports unparsable attributes
 * or stray text instead). It is kept because a scanner that mis-frames tags is
 * the wrong foundation to hang an allowlist on — but no test can isolate it, so
 * none claims to.
 */
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g
/** One attribute: `name`, `name=value`, `name="value"`, `name='value'`. */
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/**
 * Why this string is not a QR SVG, or `null` if it is one.
 *
 * Returns a REASON rather than a boolean so a caller can log what arrived —
 * a silently vanishing banner is hard to explain otherwise.
 */
export function qrSvgProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'not a string'
  if (!raw.trim()) return 'empty'
  if (raw.length > QR_SVG_MAX) return `too long (${raw.length} > ${QR_SVG_MAX})`

  const s = raw.trim()
  // Anchoring both ends is what rejects a comment, a `<?xml?>` prologue, a
  // CDATA section, or anything appended AFTER a well-formed QR.
  if (!s.startsWith('<svg')) return 'does not start with <svg'
  if (!s.endsWith('</svg>')) return 'does not end with </svg>'

  let cursor = 0
  let m: RegExpExecArray | null
  TAG.lastIndex = 0
  while ((m = TAG.exec(s))) {
    // Everything BETWEEN tags must be whitespace. A QR has no text content, so
    // this is what stops `<svg>anything<\/svg>` and any stray markup the tag
    // pattern didn't match from being skipped over unexamined.
    if (s.slice(cursor, m.index).trim()) {
      return `unexpected content before <${m[1]}>`
    }
    cursor = m.index + m[0].length

    const tag = m[1].toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return `<${tag}> is not allowed`

    // Trailing `/` of a self-closing tag is part of the attribute blob.
    const attrs = m[2].replace(/\/\s*$/, '')
    let pos = 0
    let a: RegExpExecArray | null
    ATTR.lastIndex = 0
    while ((a = ATTR.exec(attrs))) {
      // Same reasoning as the text check: refuse what the pattern skipped
      // instead of ignoring it.
      if (attrs.slice(pos, a.index).trim()) return `unparsable attributes on <${tag}>`
      pos = a.index + a[0].length
      const name = a[1].toLowerCase()
      if (!ALLOWED_ATTRS.has(name)) return `attribute "${name}" is not allowed on <${tag}>`
      const value = a[2] ?? a[3] ?? a[4] ?? ''
      // Belt to the allowlist's braces: no allowed attribute has any business
      // holding a URL or markup. `url(…)` earns its own mention because it is
      // how a URL reaches an attribute that ISN'T url-shaped — `fill` and
      // `stroke` take a paint server, so `fill="url(https://…)"` slips past a
      // check that only looks for `href`. A QR's fill is a flat colour, always.
      if (/javascript:|url\s*\(|[<>]/i.test(value)) {
        return `attribute "${name}" has a suspicious value`
      }
    }
    if (attrs.slice(pos).trim()) return `unparsable attributes on <${tag}>`
  }
  // Defence in depth, and deliberately NOT claimed as tested: the
  // `endsWith('</svg>')` anchor above already makes this unreachable. For
  // trailing content to survive the loop, the final `</svg>` would have to be
  // swallowed by an earlier tag's attribute blob — but that blob only matches
  // BALANCED quotes, so an unbalanced one fails the tag match entirely and the
  // inter-tag text rule fires first. A 400k-case fuzz over strings ending in
  // `</svg>` produced zero hits here. Kept so the loop can't silently ignore a
  // tail if either anchor is ever relaxed; deleting it would make that future
  // edit a hole instead of a caught error.
  if (s.slice(cursor).trim()) return 'unexpected trailing content'

  return null
}

/**
 * The QR markup if it is safe to inject, otherwise `''`.
 *
 * `''` is deliberately the same value `app/page.tsx` produces when QR
 * generation fails, so the banner's existing self-hide covers this case with no
 * new branch.
 */
export function sanitizeQrSvg(raw: unknown): string {
  return qrSvgProblem(raw) === null ? (raw as string) : ''
}

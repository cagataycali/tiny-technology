/**
 * 🎨 Marquee markup — inline color spans the keystroke planner never sees.
 *
 * The contract that keeps v3 honest: parseMarkup(raw) splits an entry into
 * `plain` (exactly what humanPlan receives — the typer knows NOTHING about
 * markup) and `spans` that index into plain. Styling is a render-time overlay
 * on the buffer, so typo chars simply inherit the style of the index they
 * momentarily occupy, and every v1/v2 entry keeps working because an entry
 * with no markup parses to {plain: text, spans: []}.
 *
 * The syntax is deliberately tiny and forgiving:
 *   {cyan}word{/}      — opens a style, {/} closes it
 *   {green}to the end  — an unclosed tag runs to the end of the text
 *   {{ and }}          — literal braces
 *   {bogus}            — an unknown tag is not an error, it stays literal text
 *   {/} with nothing open is ignored
 * One style at a time: opening a tag while another is open closes the first
 * at that point. Nesting, hex colors and backgrounds are out of scope.
 *
 * When an entry has NO explicit markup, autoSpans colors the semantic tokens
 * a status ticker actually carries — loop/commit ids cyan, pass/✓ green,
 * fail/✗ red, numbers and percentages yellow. Explicit markup DISABLES the
 * auto pass entirely (one author intent or the other, never a merge).
 *
 * Indices are UTF-16 code units, matching human-type.ts's text[i] iteration,
 * so buffer position i and styleAt(spans, i) always talk about the same char.
 */

/** One styled run over plain text. `end` is exclusive. Never overlapping. */
export interface StyleSpan {
  start: number
  end: number
  style: string
}

/** The styles the renderer knows how to draw. Anything else stays literal. */
export const MARKUP_STYLES = new Set([
  'cyan', 'green', 'yellow', 'magenta', 'red', 'blue', 'gray', 'bold', 'dim',
])

export interface ParsedMarkup {
  /** The text with markup stripped — EXACTLY what the keystroke planner types. */
  plain: string
  /** Style overlays, indexed into plain, sorted, non-overlapping. */
  spans: StyleSpan[]
}

/**
 * Strip markup out of raw text, recording where each style applied. Single
 * forward scan, no regex: every branch either emits plain chars or moves a
 * span boundary, so `plain` is always raw minus recognised tags and escapes —
 * and a string with no braces comes back untouched.
 */
export function parseMarkup(raw: string): ParsedMarkup {
  const src = String(raw ?? '')
  let plain = ''
  const spans: StyleSpan[] = []
  let open: { start: number; style: string } | null = null

  const close = (at: number) => {
    if (open && at > open.start) spans.push({ start: open.start, end: at, style: open.style })
    open = null
  }

  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') {
      if (src[i + 1] === '{') { plain += '{'; i += 2; continue }
      const j = src.indexOf('}', i + 1)
      if (j === -1) { plain += ch; i += 1; continue } // lone { — literal
      const tag = src.slice(i + 1, j)
      if (tag === '/') { close(plain.length); i = j + 1; continue }
      if (MARKUP_STYLES.has(tag)) {
        close(plain.length) // one style at a time — a new tag ends the old one
        open = { start: plain.length, style: tag }
        i = j + 1
        continue
      }
      // Unknown tag: not an error, just text that happens to have braces.
      plain += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '}') {
      if (src[i + 1] === '}') { plain += '}'; i += 2; continue }
      plain += '}'
      i += 1
      continue
    }
    plain += ch
    i += 1
  }
  close(plain.length) // unclosed tag runs to the end
  return { plain, spans }
}

/** The style covering plain[index], or undefined. Spans are few — linear is fine. */
export function styleAt(spans: StyleSpan[], index: number): string | undefined {
  for (const s of spans) if (index >= s.start && index < s.end) return s.style
  return undefined
}

/**
 * The auto-highlight pass for entries with no explicit markup: color the
 * tokens a status line actually carries. Matched in priority order — an id
 * that is all hex wins over the number pass — and any candidate overlapping
 * an accepted span is skipped, so the non-overlap invariant holds by
 * construction.
 */
export function autoSpans(plain: string): StyleSpan[] {
  const out: StyleSpan[] = []
  const overlaps = (start: number, end: number) =>
    out.some((s) => start < s.end && end > s.start)
  const add = (re: RegExp, style: string) => {
    for (const m of plain.matchAll(re)) {
      const start = m.index ?? 0
      const end = start + m[0].length
      if (end > start && !overlaps(start, end)) out.push({ start, end, style })
    }
  }
  // Loop ids (l + long digit run) and commit shas (7-40 hex WITH a letter —
  // a bare number that long is a number, not a sha).
  add(/\bl\d{12,}\b/g, 'cyan')
  add(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, 'cyan')
  add(/✅|✓|\bpass(?:ed|es|ing)?\b|\bgreen\b/gi, 'green')
  add(/❌|✗|\bfail(?:ed|s|ing|ure)?\b/gi, 'red')
  add(/\d+(?:[.,]\d+)*%?/g, 'yellow')
  out.sort((a, b) => a.start - b.start)
  return out
}

/**
 * What the renderer actually wants: explicit spans when the author marked
 * the text up, the auto pass when they didn't. Exactly one of the two.
 */
export function spansFor(parsed: ParsedMarkup): StyleSpan[] {
  return parsed.spans.length ? parsed.spans : autoSpans(parsed.plain)
}

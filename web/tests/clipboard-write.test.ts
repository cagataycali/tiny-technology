// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideClipboardWrite,
  clipboardPreview,
  clipboardConfirmToast,
  clipboardNote,
  CLIPBOARD_MAX,
  CLIPBOARD_DENIED_TOAST,
  CLIPBOARD_DENIED_NOTE,
} from '../lib/chat/clipboard-write'

/**
 * Backlog v8 A2 — `copy_to_clipboard` coerced any agent value onto the user's
 * clipboard, silently, with an unenforced cap.
 *
 * The load-bearing test in this file is the blank-input one: an empty write is
 * DESTRUCTIVE (it replaces what the user had), and the old code produced it
 * from a missing argument while reporting success.
 */

describe('decideClipboardWrite — what may reach the clipboard', () => {
  it('passes ordinary text through UNCHANGED', () => {
    for (const t of ['0xAb3F', 'hello world', '  indented\n\tcode\n', '🎉']) {
      expect(decideClipboardWrite(t), t).toEqual({ ok: true, text: t, truncated: false })
    }
  })

  it('does not trim the accepted text — whitespace is meaningful in copied things', () => {
    // A trailing newline before a paste into a terminal, an indented block.
    const d = decideClipboardWrite('  npm test\n')
    expect(d).toEqual({ ok: true, text: '  npm test\n', truncated: false })
  })

  it('REFUSES a blank write, because writing it erases the user clipboard', () => {
    // The defect, stated as a test: `String(undefined ?? '')` is `''`, and
    // writeText('') is a write. Whatever the user had copied is gone.
    for (const t of ['', '   ', '\n\t ']) {
      const d = decideClipboardWrite(t)
      expect(d.ok, JSON.stringify(t)).toBe(false)
      if (!d.ok) expect(d.error).toMatch(/erased|blank/i)
    }
  })

  it('refuses non-strings instead of coercing them', () => {
    // Verified coercions of the old code, not guesses:
    expect(String({} ?? '')).toBe('[object Object]')
    expect(String(['a', 'b'] ?? '')).toBe('a,b')
    expect(String(undefined ?? '')).toBe('')
    for (const v of [undefined, null, 42, {}, ['a', 'b'], true]) {
      const d = decideClipboardWrite(v as unknown)
      expect(d.ok, String(v)).toBe(false)
      if (!d.ok) expect(d.error).toMatch(/string/)
    }
  })

  it('tells the model the clipboard is UNCHANGED when it refuses', () => {
    // Otherwise the agent apologizes for having wrecked something it didn't
    // touch, or worse, re-copies to "restore" a value it never had.
    for (const v of [undefined, '', '  ']) {
      const d = decideClipboardWrite(v as unknown)
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.error).toMatch(/nothing was copied|still holds|call this again/)
    }
  })

  it('enforces the cap the zod schema only DESCRIBES', () => {
    const long = 'x'.repeat(CLIPBOARD_MAX + 500)
    const d = decideClipboardWrite(long)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.text).toHaveLength(CLIPBOARD_MAX)
      expect(d.truncated).toBe(true)
    }
  })

  it('does not mark an exactly-at-limit write as truncated', () => {
    const exact = 'x'.repeat(CLIPBOARD_MAX)
    expect(decideClipboardWrite(exact)).toEqual({ ok: true, text: exact, truncated: false })
  })

  it('the cap matches the tool schema it claims to enforce', () => {
    // If someone raises the schema's .max, this fails rather than letting the
    // executor quietly keep the old, smaller limit.
    const src = readFileSync(join(__dirname, '..', 'lib/chat/tools/client-side.ts'), 'utf8')
    const block = src.slice(src.indexOf("name: 'copy_to_clipboard'"))
    const m = block.match(/\.max\((\d[\d_]*)\)/)
    expect(m, 'copy_to_clipboard should still declare a max on its text field').toBeTruthy()
    expect(Number(String(m?.[1]).replace(/_/g, ''))).toBe(CLIPBOARD_MAX)
  })
})

describe('what the user is told', () => {
  it('the confirmation QUOTES the value, so a substitution is visible', () => {
    // "Copied!" cannot reveal that the tiny copied its OWN address over the
    // one the user asked for. The value can.
    const t = clipboardConfirmToast('0xAb3F00', false)
    expect(t).toContain('0xAb3F00')
  })

  it('the preview is one line and bounded', () => {
    expect(clipboardPreview('a\n\nb\tc')).toBe('a b c')
    const long = clipboardPreview('y'.repeat(200))
    expect(long.length).toBeLessThanOrEqual(49)
    expect(long.endsWith('…')).toBe(true)
    // A short string must NOT gain an ellipsis, or "…" stops meaning "there's more".
    expect(clipboardPreview('short').endsWith('…')).toBe(false)
  })

  it('a truncated write says so in BOTH the toast and the model note', () => {
    expect(clipboardConfirmToast('z'.repeat(20), true)).toMatch(/trimmed/)
    expect(clipboardNote(true)).toMatch(/truncat/)
    // ...and the note must tell the model the rest is NOT on the clipboard,
    // else it goes on describing the whole thing as copied.
    expect(clipboardNote(true)).toMatch(/not copied|rest/)
    expect(clipboardNote(false)).not.toMatch(/truncat/)
  })

  it('the denied strings are distinct: one is UI copy, one is model copy', () => {
    expect(CLIPBOARD_DENIED_TOAST).toMatch(/^Couldn't copy/)
    expect(CLIPBOARD_DENIED_NOTE).toMatch(/unchanged/)
    expect(CLIPBOARD_DENIED_TOAST).not.toBe(CLIPBOARD_DENIED_NOTE)
  })
})

describe('the sink is wired to the decision', () => {
  const chat = () =>
    readFileSync(join(__dirname, '..', 'components/chat/Chat.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('the branch writes the DECIDED text, never a coerced arg', () => {
    const src = chat()
    expect(src).toContain('decideClipboardWrite(args?.text)')
    expect(src).toContain('navigator.clipboard.writeText(c.text)')
    // The bug expressed as a scan.
    expect(src).not.toMatch(/writeText\(\s*String\(\s*args/)
  })

  it('a rejected write is not reported as a copy', () => {
    // ⚠️ Anchored to the try/catch, not file-wide: a `toContain` on either
    // identifier passes on the IMPORT line alone (the c52/c54/c55 trap — five
    // occurrences now). Comments are stripped above for the same reason.
    const src = chat()
    expect(src).toMatch(
      /catch\s*\{[\s\S]{0,400}?CLIPBOARD_DENIED_TOAST[\s\S]{0,400}?return\s*\{\s*ok:\s*false,\s*error:\s*CLIPBOARD_DENIED_NOTE\s*\}/
    )
  })

  it('a successful write always tells the user AND the model', () => {
    const src = chat()
    expect(src).toMatch(
      /toast\(clipboardConfirmToast\(c\.text,\s*c\.truncated\)\)[\s\S]{0,200}?return\s*\{\s*ok:\s*true,\s*note:\s*clipboardNote\(c\.truncated\)\s*\}/
    )
  })

  /**
   * The A1 census, extended. Every sink that hands a third-party string to a
   * browser capability must pass it through a gate first — the point of the
   * v8 lens is that these were each fixed in a DIFFERENT cycle, so nothing
   * stopped the next one from being added bare.
   */
  it('no agent-driven capability takes its argument ungated', () => {
    const repo = join(__dirname, '..')
    const SINKS: { file: string; gate: RegExp; what: string }[] = [
      { file: 'components/chat/Chat.tsx', gate: /decideOpenUrl\(\s*args/, what: "the agent's open_url" },
      { file: 'components/chat/Chat.tsx', gate: /decideClipboardWrite\(\s*args/, what: "the agent's copy_to_clipboard" },
      { file: 'app/wallet/page.tsx', gate: /explorerHref\(\s*url\s*\)/, what: "the withdrawal's explorer link" },
      { file: 'components/chat/PayReceipt.tsx', gate: /explorerHref\(\s*settled\.explorer\s*\)/, what: "the receipt's explorer link" },
      { file: 'components/chat/MarkdownContent.tsx', gate: /test\(\s*raw\s*\)\s*\?/, what: 'an agent-embedded image src' },
    ]
    for (const s of SINKS) {
      const src = readFileSync(join(repo, s.file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(src, `${s.file} acts on ${s.what} — that value must pass a gate`).toMatch(s.gate)
    }
  })
})

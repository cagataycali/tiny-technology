// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideDmSend, dmLength, dmRecipientLabel, DM_MAX_CHARS } from '../lib/chat/dm-send'

/**
 * Backlog v9 A1 — `send_message` truncated an agent's message to 2000 chars and
 * then reported "Delivered … stored in their inbox".
 *
 * The tests are organised around the property that makes this different from
 * c56's clipboard truncation: a DM is IRREVERSIBLE, so the correct answer is a
 * refusal the agent can act on, never a silent partial success.
 */

const repo = join(__dirname, '..')
const read = (p: string) =>
  readFileSync(join(repo, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('a message that fits is sent unchanged', () => {
  it('passes the body through byte-for-byte, including formatting whitespace', () => {
    // NOT trimmed: leading/trailing newlines are the sender's formatting, and a
    // DM is quoted verbatim in the recipient's inbox.
    const body = '\n  hey — look at this:\n\n    indented\n\n'
    const d = decideDmSend(body)
    expect(d).toEqual({ ok: true, body })
  })

  it('accepts a message exactly at the limit', () => {
    const at = 'a'.repeat(DM_MAX_CHARS)
    expect(decideDmSend(at)).toEqual({ ok: true, body: at })
  })

  it('accepts one code point OVER the old UTF-16 boundary', () => {
    // 1200 emoji = 2400 UTF-16 code units but only 1200 characters, so the old
    // `.slice(0, 2000)` mangled a message that was never too long in the first
    // place. This is the case where counting units instead of points is not
    // merely pedantic — it silently destroyed a legal message.
    const emoji = '👋'.repeat(1200)
    expect(emoji.length).toBe(2400)
    expect(dmLength(emoji)).toBe(1200)
    expect(decideDmSend(emoji)).toEqual({ ok: true, body: emoji })
  })
})

describe('an over-long message is REFUSED, never truncated', () => {
  it('refuses rather than delivering a partial message', () => {
    const d = decideDmSend('a'.repeat(2500))
    expect(d.ok).toBe(false)
    // The whole point: no `body` to send exists on a refusal, so there is no
    // way for a caller to "helpfully" send the first 2000 anyway.
    expect(d).not.toHaveProperty('body')
  })

  it('names the overrun and a split count so the agent can act', () => {
    const d = decideDmSend('a'.repeat(2500))
    if (d.ok) throw new Error('expected a refusal')
    expect(d.error).toContain('2500 characters')
    expect(d.error).toContain('500 over')
    expect(d.error).toContain(String(DM_MAX_CHARS))
    expect(d.error).toContain('2 shorter messages')
    // "nothing was sent" is the load-bearing half: without it the agent may
    // apologise for a partial delivery that never happened, or re-send and
    // double-deliver.
    expect(d.error).toContain('nothing was sent')
  })

  it('counts code POINTS, so the refusal boundary is where a human sees it', () => {
    // 2001 emoji is over the limit; 2001 code units of emoji is not.
    expect(decideDmSend('👋'.repeat(DM_MAX_CHARS)).ok).toBe(true)
    expect(decideDmSend('👋'.repeat(DM_MAX_CHARS + 1)).ok).toBe(false)
  })

  it('can never emit a lone surrogate, because it never cuts', () => {
    // ⚠️ The second real defect in the old line: `.slice()` splits UTF-16, so
    // an odd-length prefix put a broken half-emoji in the recipient's inbox AND
    // in the Telegram push. Verified here as a fact about the old approach...
    const old = ('x' + '👋'.repeat(1200)).slice(0, 2000)
    expect(/[\uD800-\uDBFF]$/.test(old)).toBe(true)
    // ...and as a property of the new one: every accepted body is whole.
    for (const s of ['x' + '👋'.repeat(999), '👋'.repeat(1999), 'plain']) {
      const d = decideDmSend(s)
      if (!d.ok) throw new Error('expected acceptance')
      expect(/[\uD800-\uDBFF]$/.test(d.body)).toBe(false)
      expect(d.body).toBe(s)
    }
  })
})

describe('a blank or non-string message is refused', () => {
  it('refuses a missing message instead of sending an empty DM', () => {
    // `String(input.message || '')` made this `''`, and this tool path calls the
    // worker DIRECTLY — app/api/messages' own `!message.trim()` 400 is not in
    // the way — so a blank DM was really delivered. Same shape as c56.
    // `undefined`/`null` are the MISSING-argument case and take the type branch
    // (they were the ones `|| ''` converted into a blank send); a whitespace
    // string is genuinely blank. Both are refused — asserted separately because
    // the messages differ, and a shared assertion here would have passed on
    // whichever branch happened to fire.
    for (const v of [undefined, null]) {
      const d = decideDmSend(v as unknown)
      expect(d.ok, String(v)).toBe(false)
      if (d.ok) throw new Error('unreachable')
      expect(d.error).toContain('must be a string')
    }
    for (const v of ['', '   ', '\n\t ']) {
      const d = decideDmSend(v)
      expect(d.ok, JSON.stringify(v)).toBe(false)
      if (d.ok) throw new Error('unreachable')
      expect(d.error).toContain('cannot be unsent')
    }
  })

  it('refuses a non-string rather than stringifying it into a DM', () => {
    // `String({})` is "[object Object]" — a real message someone would receive.
    for (const v of [42, {}, ['a', 'b'], true]) {
      const d = decideDmSend(v as unknown)
      expect(d.ok, String(v)).toBe(false)
      if (d.ok) throw new Error('unreachable')
      expect(d.error).toContain('must be a string')
    }
  })

  it('the two refusals read differently, so the agent knows which to fix', () => {
    const blank = decideDmSend('')
    const long = decideDmSend('a'.repeat(2500))
    if (blank.ok || long.ok) throw new Error('expected refusals')
    expect(blank.error).not.toBe(long.error)
  })
})

describe('the recipient label', () => {
  it('prefers the worker-resolved name and falls back to the target', () => {
    expect(dmRecipientLabel('Mert', 'mert-slug')).toBe('Mert')
    expect(dmRecipientLabel(undefined, 'mert-slug')).toBe('mert-slug')
    expect(dmRecipientLabel('', 'mert-slug')).toBe('mert-slug')
    expect(dmRecipientLabel('   ', 'mert-slug')).toBe('mert-slug')
    // A non-string from the worker must not become "[object Object]" in copy
    // the agent reads aloud.
    expect(dmRecipientLabel({ name: 'x' }, 'mert-slug')).toBe('mert-slug')
  })
})

describe('the send path is wired to the rule', () => {
  it('the tool sends the DECIDED body and no longer slices', () => {
    const src = read('lib/chat/tools/messages.ts')
    expect(src).toMatch(/body:\s*decided\.body/)
    // The defect expressed as a scan: a 2000-slice of the agent's message.
    expect(src).not.toMatch(/input\.message[^\n]*\.slice\(/)
    expect(src).toMatch(/const decided = decideDmSend\(input\.message\)/)
    // ...and it must bail BEFORE the fetch, or the refusal is decoration.
    const idx = src.indexOf('decideDmSend(input.message)')
    const bail = src.indexOf('if (!decided.ok) return decided')
    const fetchAt = src.indexOf('fetch(`${WORKER}/message`', idx)
    expect(idx).toBeGreaterThan(-1)
    expect(bail).toBeGreaterThan(idx)
    expect(fetchAt).toBeGreaterThan(bail)
  })

  it('the advertised limit comes from the constant, not a second hardcoded 2000', () => {
    // The description is what the MODEL reads; if it says a number the executor
    // does not enforce it is a prompt, not a rule (the c56 lesson). Pinning it
    // to DM_MAX_CHARS means the two can never drift.
    const src = read('lib/chat/tools/messages.ts')
    expect(src).toMatch(/Limits: \$\{DM_MAX_CHARS\} chars/)
    expect(src).toMatch(/REFUSED, not truncated/)
    expect(src).toMatch(/≤\$\{DM_MAX_CHARS\} chars/)
  })

  it('the human composer pins the SAME limit as the rule', () => {
    // MessagesHUD's maxLength is the only thing stopping a person from typing
    // past the cap; if the two numbers drift, one surface starts refusing what
    // the other happily accepts.
    const hud = read('components/chat/MessagesHUD.tsx')
    const m = hud.match(/maxLength=\{(\d+)\}/)
    expect(m, 'MessagesHUD should still cap the DM composer').toBeTruthy()
    expect(Number(m![1])).toBe(DM_MAX_CHARS)
  })

  it('read_messages still clamps its numeric limit (untouched by this change)', () => {
    // A clamp is right HERE: `limit` is a fetch size, so silently narrowing it
    // loses nothing the caller can't see in the result. Pinned so a future
    // cycle applying "refuse, do not clamp" everywhere reconsiders this one.
    const src = read('lib/chat/tools/messages.ts')
    expect(src).toMatch(/Math\.min\(Math\.max\(Number\(input\.limit\) \|\| 50, 1\), 200\)/)
  })
})

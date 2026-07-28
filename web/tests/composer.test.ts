// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldSendOnEnter } from '../lib/chat/composer'

describe('composer markup (source scan)', () => {
  it('every send-on-Enter input tells the mobile keyboard so (enterKeyHint)', () => {
    // Enter sends in both composers (shouldSendOnEnter) — the keyboard's
    // return key must say "send", not a generic newline arrow.
    for (const file of ['../components/chat/Chat.tsx', '../components/chat/MessagesHUD.tsx']) {
      const src = readFileSync(join(__dirname, file), 'utf8')
      const sends = src.match(/shouldSendOnEnter/g) || []
      // ="send" on <input>; : "send" via the textarea's spread-cast (the
      // repo's @types/react predates enterKeyHint on textarea)
      const hints = src.match(/enterKeyHint(="send"|: "send")/g) || []
      expect(sends.length, `${file} uses shouldSendOnEnter`).toBeGreaterThan(0)
      expect(hints.length, `${file} labels the key`).toBeGreaterThan(0)
    }
  })
})

describe('shouldSendOnEnter', () => {
  it('sends on a plain Enter', () => {
    expect(shouldSendOnEnter({ key: 'Enter' })).toBe(true)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false } })).toBe(true)
  })

  it('never sends on Shift+Enter (newline)', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true })).toBe(false)
  })

  it('never sends while an IME composition is active', () => {
    // A CJK user pressing Enter to confirm a candidate must not send the
    // half-composed draft — this was guarded in MessagesHUD but NOT in the
    // main composer before the extraction.
    expect(shouldSendOnEnter({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false)
  })

  it('treats the keyCode 229 composition quirk as composing', () => {
    // Some browsers report composition keydowns as keyCode 229 without
    // setting isComposing on the event they hand React.
    expect(shouldSendOnEnter({ key: 'Enter', keyCode: 229 })).toBe(false)
  })

  it('ignores every non-Enter key', () => {
    expect(shouldSendOnEnter({ key: 'a' })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Escape' })).toBe(false)
    expect(shouldSendOnEnter({ key: ' ' })).toBe(false)
  })

  it('tolerates a missing nativeEvent (plain object callers, tests)', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false })).toBe(true)
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { draftWrite, draftRestore, draftKey, DRAFT_MAX } from '../lib/chat/draft'

/**
 * c43 — web was the only client that lost a typed-but-unsent message. These
 * pin the two rules that make a restored draft feel right rather than
 * haunted: whitespace REMOVES (so a cleared composer stays cleared) and a
 * fresher intent always wins over the saved text.
 */

describe('draftKey', () => {
  it('is per-tiny, like the transcript', () => {
    expect(draftKey('scout')).toBe('chat_draft_scout')
    expect(draftKey('scout')).not.toBe(draftKey('other'))
  })
})

describe('draftWrite', () => {
  it('stores what was typed, exactly', () => {
    expect(draftWrite('hey, about that trip —\n\nsecond thought')).toEqual({
      action: 'write',
      value: 'hey, about that trip —\n\nsecond thought',
    })
  })

  it('empty or whitespace-only REMOVES', () => {
    // The load-bearing case: after send() clears the composer, a write would
    // resurrect the sent text on the next visit.
    for (const t of ['', '   ', '\n\n', '\t ']) {
      expect(draftWrite(t)).toEqual({ action: 'remove' })
    }
  })

  it('caps long drafts but keeps the user\'s exact leading whitespace', () => {
    const long = draftWrite('x'.repeat(DRAFT_MAX + 500))
    expect(long).toEqual({ action: 'write', value: 'x'.repeat(DRAFT_MAX) })
    // trimmed only for the emptiness TEST — never for the stored value
    expect(draftWrite('\n  indented poem')).toEqual({ action: 'write', value: '\n  indented poem' })
  })
})

describe('draftRestore', () => {
  const base = { saved: 'half-written question', hasDeepLink: false, viewingShare: false, currentInput: '' }

  it('restores a saved draft into an empty composer', () => {
    expect(draftRestore(base)).toBe('half-written question')
  })

  it('yields to a ?q= deep link — a shared "ask my AI" link is fresher intent', () => {
    expect(draftRestore({ ...base, hasDeepLink: true })).toBeNull()
  })

  it('never touches a read-only share view\'s composer', () => {
    expect(draftRestore({ ...base, viewingShare: true })).toBeNull()
  })

  it('never overwrites text the user has already started typing', () => {
    // The restore effect can run after a fast typist's first keystroke
    // (autoFocus composer); clobbering it would be worse than losing the draft.
    expect(draftRestore({ ...base, currentInput: 'n' })).toBeNull()
  })

  it('nothing saved, or only whitespace saved → leave the composer alone', () => {
    expect(draftRestore({ ...base, saved: null })).toBeNull()
    expect(draftRestore({ ...base, saved: '   \n' })).toBeNull()
  })

  it('caps an oversized stored value on the way back in', () => {
    // A hand-edited or legacy oversized key must not blow up the textarea.
    expect(draftRestore({ ...base, saved: 'y'.repeat(DRAFT_MAX * 2) })).toBe('y'.repeat(DRAFT_MAX))
  })

  it('round-trips: what draftWrite stores is what draftRestore hands back', () => {
    const typed = 'can you compare the two quotes side by side?'
    const w = draftWrite(typed)
    expect(w.action).toBe('write')
    expect(draftRestore({ ...base, saved: (w as any).value })).toBe(typed)
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { restoreAttachments, keptSummary } from '../lib/chat/composer-restore'
import { gateSend } from '../lib/chat/connectivity'

/**
 * c71 / backlog v13 item G3 — "what was CONSUMED on the first attempt?"
 *
 * The offline gate told the user "your message is still in the composer" while
 * `onSubmit` had already run `setAttachments([])` and only the TEXT was ever put
 * back. A pasted image has no source file to re-pick, so those bytes were gone
 * for good — and the toast said everything was kept.
 */

type A = { id: string }
const a = (id: string): A => ({ id })

describe('restoreAttachments', () => {
  it('hands a declined send its files back when the composer is empty', () => {
    const r = restoreAttachments([a('1'), a('2')], [])
    expect(r).toEqual({ restore: true, next: [a('1'), a('2')] })
  })

  it('never clobbers files the user added while the send was in flight', () => {
    // Same rule as the draft restore and c70's /auto restore: what they did
    // SINCE is newer than what we are handing back.
    expect(restoreAttachments([a('old')], [a('new')])).toEqual({ restore: false })
  })

  it('a text-only send has nothing to restore', () => {
    expect(restoreAttachments(undefined, [])).toEqual({ restore: false })
    expect(restoreAttachments([], [])).toEqual({ restore: false })
  })

  it('returns a COPY — the restored list must not alias the dispatched payload', () => {
    // The payload array is also handed to send(); if the composer held the same
    // reference, a later mutation of one would silently edit the other.
    const declined = [a('1')]
    const r = restoreAttachments(declined, [])
    expect(r.restore).toBe(true)
    if (r.restore) {
      expect(r.next).not.toBe(declined)
      expect(r.next).toEqual(declined)
    }
  })
})

describe('keptSummary — the copy is DERIVED from what was kept, never assumed', () => {
  it('names files only when there were files', () => {
    expect(keptSummary(true, true)).toBe('message and files')
    expect(keptSummary(true, false)).toBe('message')
  })

  it('a files-only submit does not claim a message the user never typed', () => {
    // onSubmit accepts attachments with no text (`!text.trim() && !pending.length`
    // is the only rejection), so this combination is reachable.
    expect(keptSummary(false, true)).toBe('files')
  })
})

describe('gateSend — the promise matches what is actually restored', () => {
  it('a declined send with files says so', () => {
    const g = gateSend(false, true, { hasText: true, hasAttachments: true })
    expect(g.send).toBe(false)
    expect((g as any).message).toBe(
      "You're offline — your message and files are still in the composer. Send it when you're back."
    )
  })

  it('a files-only decline names the files, not a message', () => {
    const m = (gateSend(false, true, { hasText: false, hasAttachments: true }) as any).message
    expect(m).toContain('your files are still in the composer')
  })

  it('the text-only copy is unchanged — c43/v5 D3 contract', () => {
    const m = (gateSend(false, true, { hasText: true, hasAttachments: false }) as any).message
    expect(m).toBe("You're offline — your message is still in the composer. Send it when you're back.")
    // …and the payload argument is optional, so every existing caller is safe.
    expect((gateSend(false, true) as any).message).toBe(m)
  })

  it('a programmatic send still promises nothing, whatever the payload', () => {
    for (const payload of [{}, { hasText: true }, { hasAttachments: true }]) {
      const m = (gateSend(false, false, payload) as any).message
      expect(m).toBe("You're offline — reconnect and try again.")
      expect(m).not.toContain('composer')
    }
  })

  it('online is still let through regardless of payload', () => {
    expect(gateSend(true, true, { hasAttachments: true })).toEqual({ send: true })
    expect(gateSend(undefined, true, { hasAttachments: true })).toEqual({ send: true })
  })

  // The invariant across the whole input space: mentioning files and having
  // files are the same fact, so future copy cannot drift from the behaviour.
  it.each([
    [true, true], [true, false], [false, true], [false, false],
  ])('claims "files" iff there were files (text=%s, files=%s)', (hasText, hasAttachments) => {
    const g = gateSend(false, true, { hasText, hasAttachments })
    expect((g as any).message.includes('files')).toBe(hasAttachments)
  })
})

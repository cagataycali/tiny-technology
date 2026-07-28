// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  pendingAttachmentsKey,
  receiptFor,
  parseReceipt,
  describeLostAttachments,
  MAX_REMEMBERED,
} from '../lib/chat/pending-attachments'

/**
 * v5 D2 — c43 taught the composer to remember your unsent words, but the
 * files staged beside them still vanished on reload with nothing said. The
 * payloads deliberately are NOT persisted (base64 is what every transcript
 * write strips for quota); the receipt is, so the composer can say so.
 */

describe('pendingAttachmentsKey', () => {
  it('is per-tiny, like the draft and transcript keys', () => {
    expect(pendingAttachmentsKey('scout')).toBe('chat_pending_files_scout')
    expect(pendingAttachmentsKey('scout')).not.toBe(pendingAttachmentsKey('other'))
  })
})

describe('receiptFor', () => {
  it('keeps names only — never the payload fields', () => {
    const w = receiptFor([
      { name: 'roof.jpg', base64: 'AAAA', dataUrl: 'data:...', thumb: 'data:...' } as any,
    ])
    expect(w).toEqual({ action: 'write', value: { names: ['roof.jpg'], count: 1 } })
    // the whole point: nothing heavy reaches storage
    expect(JSON.stringify(w)).not.toContain('AAAA')
    expect(JSON.stringify(w)).not.toContain('data:')
  })

  it('no staged files REMOVES (a cleared or just-sent composer has no receipt)', () => {
    expect(receiptFor([])).toEqual({ action: 'remove' })
    expect(receiptFor(undefined)).toEqual({ action: 'remove' })
  })

  it('caps the names but keeps the TRUE total, so "N more" stays honest', () => {
    const many = Array.from({ length: MAX_REMEMBERED + 4 }, (_, i) => ({ name: `f${i}.png` }))
    const w = receiptFor(many) as any
    expect(w.value.names).toHaveLength(MAX_REMEMBERED)
    expect(w.value.count).toBe(MAX_REMEMBERED + 4) // NOT the truncated length
  })

  it('a nameless pick still counts', () => {
    expect(receiptFor([{}, {}]) as any).toEqual({ action: 'write', value: { names: ['file', 'file'], count: 2 } })
  })
})

describe('parseReceipt', () => {
  it('round-trips a written receipt', () => {
    const w = receiptFor([{ name: 'a.pdf' }, { name: 'b.csv' }]) as any
    expect(parseReceipt(JSON.stringify(w.value))).toEqual({ names: ['a.pdf', 'b.csv'], count: 2 })
  })

  it('absent / corrupt / wrong-shape / empty → null', () => {
    for (const bad of [null, '{not json', '42', '{"count":3}', '{"names":[]}', 'null']) {
      expect(parseReceipt(bad)).toBeNull()
    }
  })

  it('an incoherent hand-edited count never under-reports the names shown', () => {
    expect(parseReceipt('{"names":["a","b","c"],"count":1}')).toEqual({ names: ['a', 'b', 'c'], count: 3 })
    // missing count falls back to the names we hold
    expect(parseReceipt('{"names":["a","b"]}')).toEqual({ names: ['a', 'b'], count: 2 })
  })

  it('drops non-string names rather than rendering "undefined"', () => {
    expect(parseReceipt('{"names":["ok.png",7,null,""],"count":4}')).toEqual({ names: ['ok.png'], count: 4 })
  })
})

describe('describeLostAttachments', () => {
  it('names what to re-attach, and pluralizes', () => {
    expect(describeLostAttachments({ names: ['roof.jpg'], count: 1 }, 0))
      .toBe("📎 1 file didn't survive the reload — re-attach roof.jpg before sending.")
    expect(describeLostAttachments({ names: ['a.png', 'b.png'], count: 2 }, 0))
      .toContain('2 files')
  })

  it('lists three and counts the rest', () => {
    const note = describeLostAttachments({ names: ['a', 'b', 'c', 'd', 'e'], count: 9 }, 0)!
    expect(note).toContain('a, b, c and 6 more')
    expect(note).toContain('9 files')
  })

  it('stays silent when files are ALREADY staged', () => {
    // Telling someone their files are gone while the paperclip row shows them
    // is worse than saying nothing.
    expect(describeLostAttachments({ names: ['a'], count: 1 }, 2)).toBeNull()
  })

  it('stays silent with no receipt', () => {
    expect(describeLostAttachments(null, 0)).toBeNull()
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dmDraftKey,
  getDmDraft,
  setDmDraft,
  clearDmDraft,
  DM_DRAFT_MAX,
  DM_DRAFT_KEEP,
  type DmDrafts,
} from '@/lib/chat/dm-drafts'

/**
 * 🔴 The defect these tests exist for delivered a private message to the wrong
 * person: MessagesHUD held ONE `draft` string across every conversation, and
 * every peer transition reset `msgs` while leaving the draft alone.
 *
 * So the load-bearing tests below are the ones where the SAME map is read under
 * two different keys and the answers must not be the same string.
 */

const ALICE = { userId: '412', login: 'alice' }
const BOB = { userId: '907', login: 'bob' }

describe('dmDraftKey — the identity a draft is filed under', () => {
  it('prefers login over userId, matching loadThread and markThreadRead', () => {
    // Not cosmetic: the ?dm=<login> deep-link peer carries userId = login while
    // the inbox row for the same person carries a numeric id. Keying on userId
    // would file two drafts for one conversation.
    expect(dmDraftKey(ALICE)).toBe('alice')
    expect(dmDraftKey({ userId: 'alice', login: 'alice' })).toBe('alice')
    // Same person, two shapes, ONE key — the whole point.
    expect(dmDraftKey({ userId: '412', login: 'alice' }))
      .toBe(dmDraftKey({ userId: 'alice', login: 'alice' }))
  })

  it('falls back to userId when login is missing or empty', () => {
    expect(dmDraftKey({ userId: '412' })).toBe('412')
    expect(dmDraftKey({ userId: '412', login: '' })).toBe('412')
  })

  it('is null for no peer — the inbox view has no composer', () => {
    expect(dmDraftKey(null)).toBe(null)
    expect(dmDraftKey(undefined)).toBe(null)
    expect(dmDraftKey({ userId: '' })).toBe(null)
  })
})

describe('🔴 drafts do not cross conversations', () => {
  it('a draft written for one peer is NOT visible under another', () => {
    // THE regression. Before this module both reads returned the same string,
    // the composer relabelled it "Message bob…", and send() posted it to bob.
    const d = setDmDraft({}, 'alice', 'meet me at 6, alone')
    expect(getDmDraft(d, 'alice')).toBe('meet me at 6, alone')
    expect(getDmDraft(d, 'bob')).toBe('')
    // Stated as the invariant, not just the two values:
    expect(getDmDraft(d, 'alice')).not.toBe(getDmDraft(d, 'bob'))
  })

  it('both drafts survive hopping A → inbox → B → A', () => {
    let d: DmDrafts = {}
    d = setDmDraft(d, 'alice', 'draft for alice')
    d = setDmDraft(d, null, 'typed with nothing open')  // inbox: no composer
    d = setDmDraft(d, 'bob', 'draft for bob')
    expect(getDmDraft(d, 'alice')).toBe('draft for alice')
    expect(getDmDraft(d, 'bob')).toBe('draft for bob')
    // The inbox write went nowhere rather than into whichever key was last.
    expect(Object.keys(d).sort()).toEqual(['alice', 'bob'])
  })

  it('the deep-link shape and the inbox-row shape share one draft', () => {
    // A user deep-linked from a push notification, typed, then hit ← to the
    // inbox and clicked the same person's row. Two different Thread objects,
    // one conversation — the draft has to follow.
    const fromPush = { userId: 'alice', login: 'alice' }
    const fromInbox = { userId: '412', login: 'alice' }
    const d = setDmDraft({}, dmDraftKey(fromPush), 'half a reply')
    expect(getDmDraft(d, dmDraftKey(fromInbox))).toBe('half a reply')
  })

  it('getDmDraft always returns a string, so it can feed value= directly', () => {
    // A React controlled input flips to uncontrolled on undefined and warns.
    expect(getDmDraft({}, 'nobody')).toBe('')
    expect(getDmDraft({}, null)).toBe('')
    expect(typeof getDmDraft({ alice: 'x' }, 'bob')).toBe('string')
  })
})

describe('setDmDraft — emptiness removes, and inputs are bounded', () => {
  it('whitespace-only REMOVES rather than writing', () => {
    // Otherwise clearing the field and switching away restores the old text on
    // the way back — the same surprise in slow motion (the draft.ts rule).
    let d = setDmDraft({}, 'alice', 'something')
    d = setDmDraft(d, 'alice', '   \n\t ')
    expect(getDmDraft(d, 'alice')).toBe('')
    expect('alice' in d).toBe(false)
  })

  it('keeps the user`s exact text — only the emptiness TEST is trimmed', () => {
    const d = setDmDraft({}, 'alice', '  leading and trailing  ')
    expect(getDmDraft(d, 'alice')).toBe('  leading and trailing  ')
  })

  it('caps at the composer`s own maxLength', () => {
    expect(DM_DRAFT_MAX).toBe(2000)
    const d = setDmDraft({}, 'alice', 'x'.repeat(DM_DRAFT_MAX + 500))
    expect(getDmDraft(d, 'alice').length).toBe(DM_DRAFT_MAX)
  })

  it('is pure — the caller`s map is never mutated', () => {
    // MessagesHUD passes React state in; mutating it would skip the re-render
    // and the composer would appear frozen while typing.
    const before: DmDrafts = { alice: 'one' }
    const after = setDmDraft(before, 'bob', 'two')
    expect(before).toEqual({ alice: 'one' })
    expect(after).not.toBe(before)
  })

  it('a null key writes nothing and returns the same object', () => {
    const before: DmDrafts = { alice: 'one' }
    expect(setDmDraft(before, null, 'stray')).toBe(before)
  })
})

describe('the retained set is bounded, and evicts the least-recently-typed', () => {
  it('keeps at most DM_DRAFT_KEEP peers', () => {
    let d: DmDrafts = {}
    for (let i = 0; i < DM_DRAFT_KEEP + 5; i++) d = setDmDraft(d, `peer${i}`, `text ${i}`)
    expect(Object.keys(d).length).toBe(DM_DRAFT_KEEP)
    expect(getDmDraft(d, 'peer0')).toBe('')                        // evicted
    expect(getDmDraft(d, `peer${DM_DRAFT_KEEP + 4}`)).toBe('text ' + (DM_DRAFT_KEEP + 4))
  })

  it('🔴 re-typing in an old thread protects it from eviction', () => {
    // An in-place overwrite keeps the ORIGINAL insertion position, so the draft
    // being actively typed would be the next one evicted in a long session.
    let d: DmDrafts = {}
    d = setDmDraft(d, 'oldest', 'first thing typed')
    for (let i = 0; i < DM_DRAFT_KEEP - 1; i++) d = setDmDraft(d, `filler${i}`, 'x')
    d = setDmDraft(d, 'oldest', 'still working on this')   // refresh recency
    d = setDmDraft(d, 'newcomer', 'y')                     // forces one eviction
    expect(getDmDraft(d, 'oldest')).toBe('still working on this')
    expect(getDmDraft(d, 'filler0')).toBe('')              // the true oldest went
    expect(Object.keys(d).length).toBe(DM_DRAFT_KEEP)
  })
})

describe('clearDmDraft — clears the thread that was SENT to', () => {
  it('forgets one peer and leaves the rest', () => {
    let d = setDmDraft({}, 'alice', 'a')
    d = setDmDraft(d, 'bob', 'b')
    d = clearDmDraft(d, 'alice')
    expect(getDmDraft(d, 'alice')).toBe('')
    expect(getDmDraft(d, 'bob')).toBe('b')
  })

  it('🔴 a send that resolves after a thread switch clears the RIGHT draft', () => {
    // The scenario MessagesHUD's own send guard was written for: POST to alice
    // is in flight, the user hops to bob and starts typing. Clearing "whatever
    // is open now" would wipe bob's reply and leave alice's delivered text
    // behind to reappear later.
    let d = setDmDraft({}, 'alice', 'delivered to alice')
    d = setDmDraft(d, 'bob', 'a reply bob has not sent')
    d = clearDmDraft(d, 'alice')            // keyed on sentTo, not on the view
    expect(getDmDraft(d, 'bob')).toBe('a reply bob has not sent')
    expect(getDmDraft(d, 'alice')).toBe('')
  })

  it('is a no-op (same reference) for unknown or null keys', () => {
    const before: DmDrafts = { alice: 'a' }
    expect(clearDmDraft(before, 'nobody')).toBe(before)
    expect(clearDmDraft(before, null)).toBe(before)
    expect(before).toEqual({ alice: 'a' })
  })
})

describe('the component is the spec — MessagesHUD holds no shared draft', () => {
  const src = readFileSync(
    join(__dirname, '..', 'components/chat/MessagesHUD.tsx'), 'utf8')
  // Comments in this file describe the OLD bug by name, so every assertion below
  // reads the code with comments stripped or it would pass on the prose.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')

  it('there is no single shared draft state left', () => {
    expect(code).not.toMatch(/useState<?[^>]*>?\(\s*["']{2}\s*\)\s*;?\s*\/\/?\s*draft/)
    expect(code).not.toContain('setDraft(')
    expect(code).toContain('useState<DmDrafts>({})')
  })

  it('the composer reads and writes through the keyed helpers', () => {
    expect(code).toContain('getDmDraft(drafts, draftKeyNow)')
    expect(code).toContain('setDmDraft(prev, draftKeyNow, e.target.value)')
  })

  it('the send path clears by the peer it SENT to, not by the open one', () => {
    // `sentTo` is captured before the POST; `activePeerRef.current` is whoever
    // is on screen when it resolves. Clearing by the latter is the bug.
    expect(code).toContain('clearDmDraft(prev, sentTo)')
    expect(code).not.toMatch(/clearDmDraft\([^)]*activePeerRef/)
    expect(code).not.toMatch(/clearDmDraft\([^)]*draftKeyNow/)
  })
})

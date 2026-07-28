// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { mergeThreadPoll, markThreadRead, optimisticId, type DmMessage, type DmThread } from '../lib/chat/dm'

const msg = (id: number, body = `m${id}`): DmMessage => ({ id, direction: 'sent', body, created: 1000 + id })
const thread = (userId: string, unread: number): DmThread => ({
  userId, login: userId, name: userId, avatar: '', unread, lastBody: '', lastAt: 0,
})

describe('mergeThreadPoll — the poll/send race', () => {
  it('accepts a fresher response and flags new messages', () => {
    const out = mergeThreadPoll([msg(1)], [msg(1), msg(2)])
    expect(out.messages.map(m => m.id)).toEqual([1, 2])
    expect(out.hasNew).toBe(true)
  })

  it('KEEPS current state when the response tail is older (stale poll after optimistic send)', () => {
    const current = [msg(1), msg(2), msg(3)] // 3 = just sent, server ack'd
    const stale = [msg(1), msg(2)]           // poll left before the send committed
    const out = mergeThreadPoll(current, stale)
    expect(out.messages).toBe(current)
    expect(out.hasNew).toBe(false)
  })

  it('a NEGATIVE optimistic tail never blocks reconciliation', () => {
    const current = [msg(1), msg(-1700000000000, 'optimistic')] // server id was missing
    const fresh = [msg(1), msg(2, 'optimistic')]                // poll returns the real row
    const out = mergeThreadPoll(current, fresh)
    expect(out.messages).toBe(fresh)
    expect(out.hasNew).toBe(true)
  })

  it('steady state (identical tails) — no scroll chase', () => {
    const a = [msg(1), msg(2)]
    const out = mergeThreadPoll(a, [msg(1), msg(2)])
    expect(out.hasNew).toBe(false)
  })

  it('empty prev accepts anything; empty next only when prev is empty too', () => {
    expect(mergeThreadPoll([], [msg(1)]).hasNew).toBe(true)
    expect(mergeThreadPoll([msg(1)], []).messages.map(m => m.id)).toEqual([1]) // stale empty
    expect(mergeThreadPoll([], []).hasNew).toBe(false)
  })
})

describe('markThreadRead — idempotent badge derivation', () => {
  it('zeros the open thread and derives the badge from the rest', () => {
    const out = markThreadRead([thread('a', 3), thread('b', 2)], 'a')
    expect(out.threads.find(t => t.userId === 'a')!.unread).toBe(0)
    expect(out.unread).toBe(2)
  })

  it('repeated calls are idempotent (the badge-drain bug)', () => {
    let state = { threads: [thread('a', 3), thread('b', 2)], unread: 5 }
    for (let i = 0; i < 10; i++) state = markThreadRead(state.threads, 'a')
    expect(state.unread).toBe(2) // b's count survives any number of polls
  })

  it('unknown peer changes nothing', () => {
    const out = markThreadRead([thread('a', 3)], 'ghost')
    expect(out.unread).toBe(3)
  })

  it('clears by login too — the ?dm=<login> deep-link path', () => {
    // Inbox thread keyed on an opaque id, but its login differs; the deep
    // link identifies the peer by login. Matching on login clears the badge
    // immediately instead of waiting for the next inbox poll.
    const t: DmThread = { userId: '4242', login: 'octocat', name: 'octocat', avatar: '', unread: 2, lastBody: '', lastAt: 0 }
    const out = markThreadRead([t, thread('b', 3)], 'octocat')
    expect(out.threads.find(x => x.userId === '4242')!.unread).toBe(0)
    expect(out.unread).toBe(3)
  })
})

describe('optimisticId', () => {
  it('uses the server id when present', () => {
    expect(optimisticId(42)).toBe(42)
    expect(optimisticId('42')).toBe(42)
  })

  it('falls back to a NEGATIVE unique id (sorts below every real D1 id)', () => {
    expect(optimisticId(undefined, 1700000000000)).toBe(-1700000000000)
    expect(optimisticId(null, 123)).toBe(-123)
    expect(optimisticId('not-a-number', 123)).toBe(-123)
  })
})

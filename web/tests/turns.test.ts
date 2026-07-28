// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { dropTurnPair, dropTurnPairAt } from '../lib/chat/turns'

const u = (id: string, attachments?: unknown) => ({ id, role: 'user', attachments })
const a = (id: string) => ({ id, role: 'assistant' })

describe('dropTurnPair', () => {
  it('drops the assistant bubble AND the user prompt above it, carrying attachments', () => {
    const files = [{ name: 'a.png' }]
    const msgs = [u('u1'), a('a1'), u('u2', files), a('a2')]
    const { messages, attachments } = dropTurnPair(msgs, 'a2')
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(attachments).toBe(files)
  })

  it('drops only the assistant when the message above is not a user prompt', () => {
    const msgs = [u('u1'), a('a1'), a('a2')]
    const { messages, attachments } = dropTurnPair(msgs, 'a2')
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(attachments).toBeUndefined()
  })

  it('drops only the assistant at index 0 (nothing above it)', () => {
    const msgs = [a('a1'), u('u1')]
    const { messages, attachments } = dropTurnPair(msgs, 'a1')
    expect(messages.map((m) => m.id)).toEqual(['u1'])
    expect(attachments).toBeUndefined()
  })

  it('is a no-op returning the SAME array when the id is not found', () => {
    const msgs = [u('u1'), a('a1')]
    const { messages, attachments } = dropTurnPair(msgs, 'missing')
    expect(messages).toBe(msgs)
    expect(attachments).toBeUndefined()
  })

  it('returns undefined attachments when the user prompt had none', () => {
    const msgs = [u('u1'), a('a1')]
    expect(dropTurnPair(msgs, 'a1').attachments).toBeUndefined()
  })

  it('does not mutate the input array', () => {
    const msgs = [u('u1'), a('a1')]
    const before = [...msgs]
    dropTurnPair(msgs, 'a1')
    expect(msgs).toEqual(before)
  })
})

describe('dropTurnPairAt', () => {
  it('accepts a raw index (restore-time signed-out paywall path)', () => {
    const msgs = [u('u1'), a('a1'), u('u2'), a('a2')]
    expect(dropTurnPairAt(msgs, 1).messages.map((m) => m.id)).toEqual(['u2', 'a2'])
  })

  it('is a no-op for -1 and out-of-range indexes', () => {
    const msgs = [u('u1'), a('a1')]
    expect(dropTurnPairAt(msgs, -1).messages).toBe(msgs)
    expect(dropTurnPairAt(msgs, 2).messages).toBe(msgs)
  })
})

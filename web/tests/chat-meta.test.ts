// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { deriveChatMeta, chatMetaKey } from '../lib/chat/persist'
import { getLocalConversations } from '../components/chat/CommandPalette'

/**
 * ⌘K conversation list (v4 C12): reads chat_meta_* blobs, never the
 * multi-MB transcripts — except ONCE per legacy tiny to backfill its meta.
 */
const store = new Map<string, string>()
const getItem = vi.fn((k: string) => (store.has(k) ? store.get(k)! : null))
beforeEach(() => {
  store.clear()
  getItem.mockClear()
  vi.stubGlobal('localStorage', {
    getItem,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  })
})
afterEach(() => vi.unstubAllGlobals())

const transcript = [
  { role: 'system', content: 'seed' },
  { role: 'user', content: 'plan my trip to Lisbon please, window seat' },
  { role: 'assistant', content: 'sure' },
]

describe('deriveChatMeta', () => {
  it('counts all messages and snips the LAST user message to 80 chars', () => {
    const meta = deriveChatMeta([...transcript, { role: 'user', content: 'x'.repeat(200) }])
    expect(meta.count).toBe(4)
    expect(meta.snippet).toBe('x'.repeat(80))
  })

  it('empty/system-only history → count with empty snippet', () => {
    expect(deriveChatMeta([])).toEqual({ count: 0, snippet: '' })
    expect(deriveChatMeta([{ role: 'system', content: 's' }])).toEqual({ count: 1, snippet: '' })
  })
})

describe('getLocalConversations', () => {
  it('answers from meta WITHOUT reading the transcript', () => {
    store.set('chat_messages_scout', JSON.stringify(transcript))
    store.set(chatMetaKey('scout'), JSON.stringify({ count: 3, snippet: 'plan my trip' }))
    const out = getLocalConversations('other')
    expect(out).toEqual([{ tiny: 'scout', count: 3, snippet: 'plan my trip' }])
    expect(getItem.mock.calls.map((c) => c[0])).not.toContain('chat_messages_scout')
  })

  it('parses a legacy transcript ONCE and backfills its meta', () => {
    store.set('chat_messages_legacy', JSON.stringify(transcript))
    const first = getLocalConversations('other')
    expect(first).toEqual([{ tiny: 'legacy', count: 3, snippet: 'plan my trip to Lisbon please, window seat' }])
    expect(store.has(chatMetaKey('legacy'))).toBe(true) // backfilled
    getItem.mockClear()
    getLocalConversations('other') // second open
    expect(getItem.mock.calls.map((c) => c[0])).not.toContain('chat_messages_legacy')
  })

  it('excludes the current tiny and cleared (count 0) conversations', () => {
    store.set('chat_messages_me', JSON.stringify(transcript))
    store.set(chatMetaKey('me'), JSON.stringify({ count: 3, snippet: 's' }))
    store.set('chat_messages_ghost', JSON.stringify([]))
    store.set(chatMetaKey('ghost'), JSON.stringify({ count: 0, snippet: '' }))
    expect(getLocalConversations('me')).toEqual([])
  })

  it('corrupt meta falls back to the one-time reparse', () => {
    store.set('chat_messages_scout', JSON.stringify(transcript))
    store.set(chatMetaKey('scout'), '{not json')
    const out = getLocalConversations('other')
    expect(out[0]?.count).toBe(3)
  })
})

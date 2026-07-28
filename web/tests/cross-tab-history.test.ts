// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { shouldAdoptPersisted, shouldWriteTranscript, parseChatMeta, deriveChatMeta, chatMetaKey } from '../lib/chat/persist'

/**
 * v4 C5 — two tabs on the same tiny used to clobber each other's history:
 * both debounce-write the whole transcript to chat_messages_<name>, so the
 * tab you WEREN'T using overwrote the turns you just had. The decision half
 * is pure (lib/chat/persist); the transport half is a `persisted` beat on
 * TabMesh, exercised end-to-end at the bottom with two real meshes.
 */

const base = { localCount: 5, remoteCount: 9, authored: false, streaming: false, viewingShare: false }

describe('shouldAdoptPersisted', () => {
  it('an untouched tab adopts a peer\'s newer snapshot', () => {
    expect(shouldAdoptPersisted(base)).toEqual({ adopt: true, remoteCount: 9 })
  })

  it('a tab that authored turns keeps its own history', () => {
    // The whole point: your live tab must never be reverted to a peer's copy.
    expect(shouldAdoptPersisted({ ...base, authored: true })).toEqual({ adopt: false, reason: 'authored' })
  })

  it('a streaming tab never adopts — the reply in flight has ids storage lacks', () => {
    expect(shouldAdoptPersisted({ ...base, streaming: true })).toEqual({ adopt: false, reason: 'streaming' })
  })

  it('a share view is left alone in both directions', () => {
    expect(shouldAdoptPersisted({ ...base, viewingShare: true })).toEqual({ adopt: false, reason: 'viewing-share' })
    expect(shouldWriteTranscript({ ...base, viewingShare: true, mirroring: false })).toBe(false)
  })

  it('equal or smaller remote counts are not newer (termination)', () => {
    // Adoption re-persists and beats back; the peer then sees equal counts and
    // stops. Without strict `>` the two tabs would adopt each other forever.
    expect(shouldAdoptPersisted({ ...base, remoteCount: 5 }).adopt).toBe(false)
    expect(shouldAdoptPersisted({ ...base, remoteCount: 4 })).toEqual({ adopt: false, reason: 'not-newer' })
  })

  it('a missing or unusable meta count is not adopted (a cleared peer reads as absence)', () => {
    for (const remoteCount of [null, NaN, Infinity]) {
      expect(shouldAdoptPersisted({ ...base, remoteCount })).toEqual({ adopt: false, reason: 'no-meta' })
    }
  })
})

describe('shouldWriteTranscript', () => {
  it('a mirror tab declines to write back what it adopted', () => {
    expect(shouldWriteTranscript({ ...base, localCount: 9, remoteCount: 9, mirroring: true })).toBe(false)
  })

  it('but a mirror that authors again resumes writing', () => {
    expect(shouldWriteTranscript({ ...base, localCount: 10, remoteCount: 9, mirroring: true, authored: true })).toBe(true)
  })

  it('a streaming mirror still writes — its deltas exist nowhere else', () => {
    expect(shouldWriteTranscript({ ...base, mirroring: true, streaming: true })).toBe(true)
  })

  it('storage moved ahead with no beat received → decline rather than clobber', () => {
    // No BroadcastChannel (or the beat raced the listener): the count gap is
    // the only evidence, and it says our copy is stale.
    expect(shouldWriteTranscript({ ...base, mirroring: false })).toBe(false)
  })

  it('the ordinary single-tab case writes', () => {
    expect(shouldWriteTranscript({ ...base, localCount: 9, remoteCount: 9, mirroring: false })).toBe(true)
    expect(shouldWriteTranscript({ ...base, remoteCount: null, mirroring: false })).toBe(true)
  })
})

describe('parseChatMeta', () => {
  it('reads a written meta and rejects absent/corrupt/wrong-shape blobs', () => {
    expect(parseChatMeta(JSON.stringify(deriveChatMeta([{ role: 'user', content: 'hi' }])))).toEqual({ count: 1, snippet: 'hi' })
    expect(parseChatMeta(null)).toBeNull()
    expect(parseChatMeta('{not json')).toBeNull()
    expect(parseChatMeta('{"snippet":"x"}')).toBeNull() // no count
    expect(parseChatMeta('42')).toBeNull()
    // a non-string snippet must not reach the palette's String() blind
    expect(parseChatMeta('{"count":2,"snippet":7}')).toEqual({ count: 2, snippet: '' })
  })
})

// ── Transport: two real TabMesh instances over a fake BroadcastChannel ──────
const lstore = new Map<string, string>()
const sstore = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (lstore.has(k) ? lstore.get(k)! : null),
  setItem: (k: string, v: string) => { lstore.set(k, String(v)) },
  removeItem: (k: string) => { lstore.delete(k) },
}
;(globalThis as any).sessionStorage = {
  getItem: (k: string) => (sstore.has(k) ? sstore.get(k)! : null),
  setItem: (k: string, v: string) => { sstore.set(k, String(v)) },
  removeItem: (k: string) => { sstore.delete(k) },
}
const buses = new Map<string, Set<any>>()
class FakeBroadcastChannel {
  onmessage: ((e: { data: any }) => void) | null = null
  constructor(public name: string) {
    if (!buses.has(name)) buses.set(name, new Set())
    buses.get(name)!.add(this)
  }
  postMessage(data: any) {
    buses.get(this.name)!.forEach((ch) => { if (ch !== this) ch.onmessage?.({ data }) })
  }
  close() { buses.get(this.name)!.delete(this) }
}
;(globalThis as any).BroadcastChannel = FakeBroadcastChannel
;(globalThis as any).window = globalThis

// Static import (like tests/tab-mesh.test.ts): platform.ts touches storage
// only inside calls, so the hoisted import is safe with the stubs above.
import { TabMesh } from '../components/chat/platform'

/** Two meshes with distinct tab ids (TabMesh reads sessionStorage at construction). */
function pair(tinyA: string, tinyB: string) {
  sstore.set('tiny-mesh-tab-id', 'tab-a')
  const a = new TabMesh(tinyA)
  sstore.set('tiny-mesh-tab-id', 'tab-b')
  const b = new TabMesh(tinyB)
  vi.useFakeTimers()
  a.start(); b.start()
  return { a, b }
}

describe('persisted beat', () => {
  beforeEach(() => { lstore.clear(); sstore.clear(); buses.clear() })
  afterEach(() => { vi.useRealTimers() })

  it('reaches a peer on the same tiny, carrying no transcript', () => {
    const { a, b } = pair('scout', 'scout')
    const seen: string[] = []
    b.onPersisted = (tiny) => seen.push(tiny)
    a.announcePersisted()
    expect(seen).toEqual(['scout'])
    a.stop(); b.stop()
  })

  it('never reaches a tab on a DIFFERENT tiny (different storage key)', () => {
    const { a, b } = pair('alpha', 'beta')
    const seen: string[] = []
    b.onPersisted = () => seen.push('x')
    a.announcePersisted()
    expect(seen).toEqual([])
    a.stop(); b.stop()
  })

  it('does not echo to the announcing tab itself', () => {
    const { a, b } = pair('scout', 'scout')
    const seen: string[] = []
    a.onPersisted = () => seen.push('self')
    a.announcePersisted()
    expect(seen).toEqual([])
    a.stop(); b.stop()
  })

  it('end to end: the idle tab adopts, the busy tab does not', () => {
    const { a, b } = pair('scout', 'scout')
    // Tab A is the one being used: it saves a 7-message transcript + meta.
    const written = Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i}` }))
    lstore.set('chat_messages_scout', JSON.stringify(written))
    lstore.set(chatMetaKey('scout'), JSON.stringify(deriveChatMeta(written)))

    // Tab B is idle with a 3-message copy from before — it adopts.
    let adopted = 0
    b.onPersisted = () => {
      const d = shouldAdoptPersisted({
        localCount: 3,
        remoteCount: parseChatMeta(lstore.get(chatMetaKey('scout')) ?? null)?.count ?? null,
        authored: false, streaming: false, viewingShare: false,
      })
      if (d.adopt) adopted = d.remoteCount
    }
    a.announcePersisted()
    expect(adopted).toBe(7)

    // Had B been typing too, it would keep its own history instead.
    let adoptedBusy = 0
    b.onPersisted = () => {
      const d = shouldAdoptPersisted({
        localCount: 3,
        remoteCount: parseChatMeta(lstore.get(chatMetaKey('scout')) ?? null)?.count ?? null,
        authored: true, streaming: false, viewingShare: false,
      })
      if (d.adopt) adoptedBusy = d.remoteCount
    }
    a.announcePersisted()
    expect(adoptedBusy).toBe(0)
    a.stop(); b.stop()
  })
})

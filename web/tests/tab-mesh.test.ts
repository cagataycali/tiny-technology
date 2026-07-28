// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// ── Browser stubs (before import) ───────────────────────────────────────────
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

// Minimal in-process BroadcastChannel: all instances of a name share a bus.
const buses = new Map<string, Set<any>>()
class FakeBroadcastChannel {
  onmessage: ((e: { data: any }) => void) | null = null
  constructor(public name: string) {
    if (!buses.has(name)) buses.set(name, new Set())
    buses.get(name)!.add(this)
  }
  postMessage(data: any) {
    buses.get(this.name)!.forEach((ch) => {
      if (ch !== this) ch.onmessage?.({ data })
    })
  }
  close() { buses.get(this.name)!.delete(this) }
}
;(globalThis as any).BroadcastChannel = FakeBroadcastChannel
;(globalThis as any).window = globalThis

import { TabMesh, getRing, ringContextForPrompt } from '../components/chat/platform'

beforeEach(() => { lstore.clear(); sstore.clear(); buses.clear() })
afterEach(() => { vi.useRealTimers() })

describe('ring storage', () => {
  it('addToRing caps at 50 entries and clamps text', () => {
    const mesh = new TabMesh('mytiny')
    for (let i = 0; i < 55; i++) mesh.addToRing(`beat ${i} ` + 'x'.repeat(600))
    const ring = getRing()
    expect(ring).toHaveLength(50)
    expect(ring[ring.length - 1].text).toContain('beat 54')
    expect(ring[0].text).toContain('beat 5')
    expect(ring[0].text.length).toBeLessThanOrEqual(500)
  })

  it('ignores empty beats', () => {
    const mesh = new TabMesh('t')
    mesh.addToRing('   ')
    expect(getRing()).toHaveLength(0)
  })

  it('a corrupt non-array ring value coerces to [] (no .filter/.push crash)', () => {
    // A localStorage value that is valid JSON but not an array must not reach
    // ringContextForPrompt's .filter or addToRing's .push and throw.
    for (const bad of ['{}', '"5"', '42', 'null', '{"tabId":"x"}']) {
      lstore.set('tiny_mesh_ring', bad)
      expect(getRing()).toEqual([])
      expect(() => ringContextForPrompt('me')).not.toThrow()
      expect(() => new TabMesh('t').addToRing('beat')).not.toThrow()
    }
  })
})

describe('ringContextForPrompt', () => {
  it('excludes own tab and formats other tabs', () => {
    lstore.set('tiny_mesh_ring', JSON.stringify([
      { tinyName: 'alpha', tabId: 'me', text: 'my own beat', timestamp: Date.now() },
      { tinyName: 'beta', tabId: 'other', text: 'their beat', timestamp: Date.now() },
    ]))
    const ctx = ringContextForPrompt('me')
    expect(ctx).toContain('[/beta] their beat')
    expect(ctx).not.toContain('my own beat')
  })

  it('empty ring (or only own entries) → empty string', () => {
    expect(ringContextForPrompt('me')).toBe('')
    lstore.set('tiny_mesh_ring', JSON.stringify([
      { tinyName: 'a', tabId: 'me', text: 'mine', timestamp: Date.now() },
    ]))
    expect(ringContextForPrompt('me')).toBe('')
  })

  it('takes only the newest maxEntries', () => {
    const now = Date.now()
    lstore.set('tiny_mesh_ring', JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ tinyName: 't', tabId: 'other', text: `b${i}`, timestamp: now - (10 - i) * 1000 }))
    ))
    const ctx = ringContextForPrompt('me', 3)
    expect(ctx).toContain('b9')
    expect(ctx).not.toContain('b6\n')
  })

  it('stale beats (>30min, e.g. last week) are NOT presented as recent activity', () => {
    lstore.set('tiny_mesh_ring', JSON.stringify([
      { tinyName: 'old', tabId: 'other', text: 'ancient beat', timestamp: Date.now() - 31 * 60 * 1000 },
      { tinyName: 'new', tabId: 'other', text: 'fresh beat', timestamp: Date.now() - 60 * 1000 },
    ]))
    const ctx = ringContextForPrompt('me')
    expect(ctx).toContain('fresh beat')
    expect(ctx).not.toContain('ancient beat')
    // an all-stale ring reads as no cross-tab activity at all
    lstore.set('tiny_mesh_ring', JSON.stringify([
      { tinyName: 'old', tabId: 'other', text: 'ancient beat', timestamp: Date.now() - 24 * 3600 * 1000 },
    ]))
    expect(ringContextForPrompt('me')).toBe('')
  })
})

describe('TabMesh presence', () => {
  it('two meshes discover each other via ping/pong', () => {
    // distinct tab ids: TabMesh reads sessionStorage at construction —
    // seed one id, construct, clear, construct the second
    sstore.set('tiny-mesh-tab-id', 'tab-a')
    const a = new TabMesh('alpha')
    sstore.set('tiny-mesh-tab-id', 'tab-b')
    const b = new TabMesh('beta')

    vi.useFakeTimers() // keep heartbeats deterministic
    a.start()
    b.start() // b's initial ping → a replies pong → both see each other
    expect(a.peerCount()).toBe(1)
    expect(b.peerCount()).toBe(1)
    a.stop(); b.stop()
  })

  it('ignores its own messages (no self-peer)', () => {
    sstore.set('tiny-mesh-tab-id', 'solo')
    const solo = new TabMesh('gamma')
    vi.useFakeTimers()
    solo.start()
    expect(solo.peerCount()).toBe(0)
    solo.stop()
  })

  it('evicts stale peers after the heartbeat window', () => {
    sstore.set('tiny-mesh-tab-id', 'tab-a')
    const a = new TabMesh('alpha')
    sstore.set('tiny-mesh-tab-id', 'tab-b')
    const b = new TabMesh('beta')

    vi.useFakeTimers()
    a.start(); b.start()
    expect(a.peerCount()).toBe(1)

    b.stop() // b goes silent
    // Eviction runs on 5s heartbeat ticks; staleness must EXCEED 15s —
    // the 15s tick sees exactly 15000 (not >), so the 20s tick evicts
    vi.advanceTimersByTime(21_000)
    expect(a.peerCount()).toBe(0)
    a.stop()
  })
})

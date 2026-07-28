// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createStreamRegistry, annotateLivePartial, buildTurnHistory, MAX_CONCURRENT_STREAMS } from '../lib/chat/stream-registry'

describe('createStreamRegistry — bounded synchronous claims', () => {
  it('claims up to the cap, then refuses', () => {
    const r = createStreamRegistry(2)
    expect(r.claim('a')).toBe(true)
    expect(r.claim('b')).toBe(true)
    expect(r.claim('c')).toBe(false) // over cap
    expect(r.size()).toBe(2)
  })

  it('same-tick claims are individually accounted (the old double-submit race becomes bounded concurrency)', () => {
    const r = createStreamRegistry(3)
    // simulating two synchronous send() calls in one tick
    const first = r.claim('turn-1')
    const second = r.claim('turn-2')
    expect(first && second).toBe(true)
    expect(r.ids().sort()).toEqual(['turn-1', 'turn-2'])
  })

  it('release frees a slot for the next claim', () => {
    const r = createStreamRegistry(1)
    expect(r.claim('a')).toBe(true)
    expect(r.claim('b')).toBe(false)
    r.release('a')
    expect(r.claim('b')).toBe(true)
  })

  it('release of an unknown id is a no-op (idempotent finally paths)', () => {
    const changes: Set<string>[] = []
    const r = createStreamRegistry(2, (ids) => changes.push(ids))
    r.claim('a')
    r.release('a')
    r.release('a') // second release: finally + stop button both firing
    expect(changes.length).toBe(2) // claim + one real release, no spurious emit
    expect(r.size()).toBe(0)
  })

  it('notifies onChange with a fresh Set per mutation (safe for React state)', () => {
    const seen: Set<string>[] = []
    const r = createStreamRegistry(2, (ids) => seen.push(ids))
    r.claim('a')
    r.claim('b')
    expect(seen[0]).not.toBe(seen[1]) // new identity each emit
    expect(Array.from(seen[1]).sort()).toEqual(['a', 'b'])
  })

  it('tracks startedAt per stream for the partial annotation', () => {
    const r = createStreamRegistry(2)
    r.claim('a', 1000)
    expect(r.startedAt('a')).toBe(1000)
    expect(r.startedAt('ghost')).toBeUndefined()
  })

  it('cap=1 reproduces the old single-flight gate exactly', () => {
    const r = createStreamRegistry(1)
    expect(r.claim('only')).toBe(true)
    expect(r.claim('second')).toBe(false)
    r.release('only')
    expect(r.claim('second')).toBe(true)
  })

  it('default is unbounded — every claim succeeds', () => {
    expect(MAX_CONCURRENT_STREAMS).toBe(Infinity)
    const r = createStreamRegistry()
    for (let i = 0; i < 50; i++) expect(r.claim(`s${i}`)).toBe(true)
    expect(r.size()).toBe(50)
  })
})

describe('annotateLivePartial — sibling in-flight replies in a concurrent turn\'s history', () => {
  it('wraps partial text with an in-progress marker and elapsed seconds', () => {
    const out = annotateLivePartial('The answer is being', 10_000, 25_000)
    expect(out).toContain('STILL WRITING')
    expect(out).toContain('15s ago')
    expect(out).toContain('The answer is being')
    expect(out).toContain('do not repeat it')
  })

  it('empty partial (stream just started) gets the nothing-written variant', () => {
    const out = annotateLivePartial('', 10_000, 12_000)
    expect(out).toContain('nothing written yet')
    expect(out).not.toContain('STILL WRITING this reply')
  })

  it('never reports 0s (avoids "started 0s ago" nonsense)', () => {
    const out = annotateLivePartial('x', 10_000, 10_100)
    expect(out).toContain('1s ago')
  })
})

describe('buildTurnHistory — the concurrent-turn history snapshot', () => {
  const blocks = (text: string) => [{ text: `[attach] ${text}` }]
  const msg = (id: string, role: string, content: string, attachments?: unknown[]) =>
    ({ id, role, content, ...(attachments ? { attachments } : {}) })

  it('excludes own placeholder, keeps the linear transcript', () => {
    const r = createStreamRegistry()
    const out = buildTurnHistory(
      [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello!'), msg('u2', 'user', 'next'), msg('a2', 'assistant', '')],
      'a2', r, blocks,
    )
    expect(out).toEqual([
      { role: 'user', content: [{ text: 'hi' }] },
      { role: 'assistant', content: [{ text: 'hello!' }] },
      { role: 'user', content: [{ text: 'next' }] },
    ])
  })

  it('drops empty and deleted messages (strict providers reject empty blocks)', () => {
    const r = createStreamRegistry()
    const out = buildTurnHistory(
      [msg('u1', 'user', 'hi'), msg('x', 'assistant', ''), msg('d', 'user', '_deleted..._'), msg('a', 'assistant', '')],
      'a', r, blocks,
    )
    expect(out).toEqual([{ role: 'user', content: [{ text: 'hi' }] }])
  })

  it("the cross-visibility rule: sibling LIVE placeholder passes even empty, annotated in-progress", () => {
    const r = createStreamRegistry()
    r.claim('a1', 5_000)
    const out = buildTurnHistory(
      [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'partial answer so f'), msg('u2', 'user', 'hello'), msg('a2', 'assistant', '')],
      'a2', r, blocks, 12_000,
    )
    expect(out[1].content[0].text).toContain('STILL WRITING')
    expect(out[1].content[0].text).toContain('7s ago')
    expect(out[1].content[0].text).toContain('partial answer so f')
    // and the empty-sibling variant survives the empty-content filter
    const r2 = createStreamRegistry()
    r2.claim('b1', 5_000)
    const out2 = buildTurnHistory(
      [msg('u1', 'user', 'hi'), msg('b1', 'assistant', ''), msg('u2', 'user', 'hello'), msg('b2', 'assistant', '')],
      'b2', r2, blocks, 6_000,
    )
    expect(out2.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out2[1].content[0].text).toContain('nothing written yet')
  })

  it('attachment messages go through the injected block builder', () => {
    const r = createStreamRegistry()
    const out = buildTurnHistory(
      [msg('u1', 'user', 'see photo', [{}]), msg('a', 'assistant', '')],
      'a', r, blocks,
    )
    expect(out[0].content).toEqual([{ text: '[attach] see photo' }])
  })
})

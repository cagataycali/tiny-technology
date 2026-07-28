// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { persistTranscript } from '../lib/chat/persist'

const sys = { role: 'system', content: 'seed' }
const turn = (i: number) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i}` })
const msgs = (n: number) => [sys, ...Array.from({ length: n }, (_, i) => turn(i))]

/** setItem that throws until the payload fits under `limit` chars. */
const quota = (limit: number) => vi.fn((_k: string, v: string) => {
  if (v.length > limit) throw new DOMException('quota', 'QuotaExceededError')
})

describe('persistTranscript', () => {
  it('writes once when the store has room', () => {
    const setItem = vi.fn()
    expect(persistTranscript(setItem, 'k', msgs(6))).toEqual({ ok: true, dropped: 0 })
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('drops the OLDEST half on quota and keeps the system seed', () => {
    const store = quota(JSON.stringify(msgs(8)).length - 1) // one turn too big
    const r = persistTranscript(store, 'k', msgs(8))
    expect(r).toEqual({ ok: true, dropped: 4 })
    const written = JSON.parse(store.mock.calls.at(-1)![1])
    expect(written[0]).toEqual(sys) // seed survives
    expect(written.map((m: any) => m.content)).toEqual(['seed', 't4', 't5', 't6', 't7']) // newest kept
  })

  it('halves repeatedly under a tight quota, accumulating the drop count', () => {
    const tiny = JSON.stringify([sys, turn(6), turn(7)]).length
    const r = persistTranscript(quota(tiny), 'k', msgs(8))
    expect(r.ok).toBe(true)
    expect((r as any).dropped).toBe(6)
  })

  it('reports failure when even one turn cannot fit — never throws', () => {
    expect(persistTranscript(quota(0), 'k', msgs(8))).toEqual({ ok: false })
    expect(persistTranscript(quota(0), 'k', [sys])).toEqual({ ok: false }) // seed-only, nothing droppable
  })
})

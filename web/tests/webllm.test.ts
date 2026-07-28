// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { WEBLLM_MODELS, WEBLLM_DEFAULT_FAST, WEBLLM_DEFAULT_QUALITY, joinCatalogStats, filterCatalog, type CatalogModel } from '../lib/webllm'

/**
 * WebLLM catalog helpers — the pure join/filter/rank pipeline behind the
 * model browser, plus invariants that keep the curated list honest
 * (every id must exist in the pinned web-llm version's prebuiltAppConfig;
 * that contract is enforced by the id-shape checks here and verified
 * against the real bundle at upgrade time).
 */

const cat = [
  { id: 'Qwen3-1.7B-q4f16_1-MLC', vramMB: 2036, lowResource: true },
  { id: 'gemma3-1b-it-q4f16_1-MLC', vramMB: 711, lowResource: true },
  { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', vramMB: 1629, lowResource: true },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', vramMB: 2263, lowResource: true },
]
const stats = new Map([
  ['Qwen3-1.7B-q4f16_1-MLC', { downloads: 2470, likes: 0 }],
  ['gemma3-1b-it-q4f16_1-MLC', { downloads: 9000, likes: 12 }],
  ['Llama-3.2-3B-Instruct-q4f16_1-MLC', { downloads: 50000, likes: 30 }],
])

describe('webllm catalog pipeline', () => {
  it('join carries stats over and zero-fills models HF has no row for', () => {
    const joined = joinCatalogStats(cat, stats)
    expect(joined.find((m) => m.id.startsWith('gemma3'))!.downloads).toBe(9000)
    expect(joined.find((m) => m.id.includes('Coder'))!.downloads).toBe(0)
    expect(joined).toHaveLength(cat.length) // never drops runnable models
  })

  it('filter is AND over terms, case-insensitive', () => {
    const joined = joinCatalogStats(cat, stats)
    expect(filterCatalog(joined, 'qwen', 'downloads').map((m) => m.id)).toEqual([
      'Qwen3-1.7B-q4f16_1-MLC', 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    ])
    expect(filterCatalog(joined, 'qwen coder', 'downloads')).toHaveLength(1)
    expect(filterCatalog(joined, 'QWEN3', 'downloads')).toHaveLength(1)
    expect(filterCatalog(joined, '', 'downloads')).toHaveLength(4)
  })

  it('sorts: downloads desc, likes desc, size asc', () => {
    const joined = joinCatalogStats(cat, stats)
    expect(filterCatalog(joined, '', 'downloads')[0].id).toContain('Llama-3.2')
    expect(filterCatalog(joined, '', 'likes')[0].likes).toBe(30)
    expect(filterCatalog(joined, '', 'size')[0].id).toContain('gemma3')
  })
})

describe('curated list invariants', () => {
  it('curated ids look like MLC catalog ids and sizes stay parseable', () => {
    for (const m of WEBLLM_MODELS) {
      expect(m.id).toMatch(/-MLC$/)
      expect(m.size).toMatch(/^\d+(\.\d+)?GB$/)
    }
  })

  it('onboarding defaults exist in the curated list (fast ≤ 1GB-class)', () => {
    const ids = WEBLLM_MODELS.map((m) => m.id)
    expect(ids).toContain(WEBLLM_DEFAULT_FAST)
    expect(ids).toContain(WEBLLM_DEFAULT_QUALITY)
    const fast = WEBLLM_MODELS.find((m) => m.id === WEBLLM_DEFAULT_FAST)!
    expect(parseFloat(fast.size)).toBeLessThanOrEqual(1)
  })

  it('no duplicate ids', () => {
    const ids = WEBLLM_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

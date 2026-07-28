// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// localStorage stub (model-registry caches there) — before import
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}
// readCache() early-returns {} when window is undefined — the cache path
// only runs in a browser, so define window to exercise it here
;(globalThis as any).window = globalThis

import { listModels, FALLBACKS } from '../lib/model-registry'

const realFetch = global.fetch
beforeEach(() => { store.clear() })
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

function stubModels(ids: string[]) {
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })
  ) as any
}

describe('listModels', () => {
  it('no API key → fallback list, no network', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const out = await listModels('openai', undefined)
    expect(out.source).toBe('fallback')
    expect(out.models).toEqual(FALLBACKS.openai)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('unknown provider with a key but no compat base → fallback', async () => {
    const out = await listModels('nonexistent-provider', 'sk-key')
    expect(out.source).toBe('fallback')
    expect(out.models).toEqual([]) // no FALLBACKS entry
  })

  it('successful fetch → api source, deduped', async () => {
    stubModels(['gpt-5', 'gpt-5', 'gpt-4o']) // dup
    const out = await listModels('openai', 'sk-key')
    expect(out.source).toBe('api')
    expect(out.models).toEqual(['gpt-5', 'gpt-4o'])
  })

  it('second call hits the cache (no second fetch)', async () => {
    stubModels(['gpt-5'])
    await listModels('openai', 'sk-key')
    const callsAfterFirst = (global.fetch as any).mock.calls.length
    const out = await listModels('openai', 'sk-key')
    expect(out.source).toBe('cache')
    expect((global.fetch as any).mock.calls.length).toBe(callsAfterFirst) // no new fetch
  })

  it('force:true bypasses a fresh cache', async () => {
    stubModels(['gpt-5'])
    await listModels('openai', 'sk-key')
    const before = (global.fetch as any).mock.calls.length
    const out = await listModels('openai', 'sk-key', { force: true })
    expect(out.source).toBe('api')
    expect((global.fetch as any).mock.calls.length).toBe(before + 1)
  })

  it('fetch failure with no cache → fallback', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as any
    const out = await listModels('openai', 'sk-key')
    expect(out.source).toBe('fallback')
    expect(out.models).toEqual(FALLBACKS.openai)
  })

  it('fetch failure WITH a stale cache → serves the cache, not fallback', async () => {
    stubModels(['cached-model'])
    await listModels('openai', 'sk-key') // populate cache
    global.fetch = vi.fn(async () => { throw new Error('network down') }) as any
    const out = await listModels('openai', 'sk-key', { force: true })
    expect(out.source).toBe('cache')
    expect(out.models).toEqual(['cached-model'])
  })

  it('empty model list from the API is treated as a failure → fallback', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as any
    const out = await listModels('openai', 'sk-key')
    expect(out.source).toBe('fallback')
  })

  it('cache key is keyed by API key — a different key re-fetches', async () => {
    stubModels(['model-A'])
    await listModels('openai', 'key-1')
    stubModels(['model-B'])
    const out = await listModels('openai', 'key-2')
    expect(out.source).toBe('api')
    expect(out.models).toEqual(['model-B'])
  })

  it('a corrupt cache entry (models not an array) is dropped, never returned', async () => {
    // Valid JSON, wrong shape — a hand-corrupted / older-format localStorage
    // blob. Without the readCache shape guard this `models: "x"` would pass the
    // freshness check and be returned as entry.models, crashing list.map() in
    // the settings dropdown. It must be dropped → fall through to a real fetch.
    store.set('tiny_model_cache', JSON.stringify({
      'openai:deadbeef': { models: 'not-an-array', fetchedAt: Date.now() },
    }))
    stubModels(['gpt-5'])
    const out = await listModels('openai', 'sk-key')
    expect(Array.isArray(out.models)).toBe(true)
    expect(out.source).toBe('api') // corrupt entry ignored → fetched fresh
    expect(out.models).toEqual(['gpt-5'])
  })

  it('a cache blob that is valid JSON but not an object is ignored', async () => {
    store.set('tiny_model_cache', JSON.stringify(['unexpected', 'array']))
    stubModels(['gpt-5'])
    const out = await listModels('openai', 'sk-key')
    expect(Array.isArray(out.models)).toBe(true)
    expect(out.models).toEqual(['gpt-5'])
  })

  it('custom provider: changing baseUrl (same key) re-fetches, not stale cache', async () => {
    stubModels(['a-model'])
    const a = await listModels('custom', 'sk-key', { baseUrl: 'https://a.example/v1' })
    expect(a.models).toEqual(['a-model'])
    stubModels(['b-model'])
    // Same provider + key, different base URL → must query B, not serve A
    const b = await listModels('custom', 'sk-key', { baseUrl: 'https://b.example/v1' })
    expect(b.source).toBe('api')
    expect(b.models).toEqual(['b-model'])
    // And the original base URL still resolves from its own cache entry
    const aAgain = await listModels('custom', 'sk-key', { baseUrl: 'https://a.example/v1' })
    expect(aAgain.source).toBe('cache')
    expect(aAgain.models).toEqual(['a-model'])
  })
})

// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { classifyTinyPayload, getTiny, isTinyNotExists, TINY_NOT_EXISTS } from '../lib/tiny-record'

describe('classifyTinyPayload', () => {
  it('accepts a named record', () => {
    const tiny = { name: 'scout', systemPrompt: 'hi' }
    expect(classifyTinyPayload(tiny)).toEqual({ status: 'ok', tiny })
  })

  it('detects the sentinel under BOTH worker fields (response and message)', () => {
    expect(classifyTinyPayload({ response: TINY_NOT_EXISTS })).toEqual({ status: 'not-found' })
    expect(classifyTinyPayload({ message: TINY_NOT_EXISTS })).toEqual({ status: 'not-found' })
  })

  it('treats an unnamed 200 payload as not-found — it renders nothing anywhere', () => {
    expect(classifyTinyPayload({})).toEqual({ status: 'not-found' })
    expect(classifyTinyPayload({ systemPrompt: 'x' })).toEqual({ status: 'not-found' })
  })

  it('treats non-object junk as a failed lookup', () => {
    expect(classifyTinyPayload(null)).toEqual({ status: 'failed' })
    expect(classifyTinyPayload('oops')).toEqual({ status: 'failed' })
    expect(classifyTinyPayload(undefined)).toEqual({ status: 'failed' })
  })
})

describe('isTinyNotExists', () => {
  it('is null-safe and exact', () => {
    expect(isTinyNotExists(null)).toBe(false)
    expect(isTinyNotExists({ response: 'something else' })).toBe(false)
    expect(isTinyNotExists({ message: TINY_NOT_EXISTS })).toBe(true)
  })
})

describe('getTiny', () => {
  afterEach(() => vi.unstubAllGlobals())

  const okResponse = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body }) as Response

  it('returns ok with the record on a 200 named payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ name: 'scout' })))
    expect(await getTiny('scout')).toEqual({ status: 'ok', tiny: { name: 'scout' } })
  })

  it('URL-encodes the slug', async () => {
    const spy = vi.fn(async (..._args: unknown[]) => okResponse({ name: 'a b' }))
    vi.stubGlobal('fetch', spy)
    await getTiny('a b')
    expect(String(spy.mock.calls[0]?.[0])).toContain('name=a%20b')
  })

  it('fails on non-2xx even when the body is valid JSON (503 with error body)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ error: 'down' }, false, 503)))
    expect(await getTiny('scout')).toEqual({ status: 'failed' })
  })

  it('fails on a network error or timeout instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    expect(await getTiny('scout')).toEqual({ status: 'failed' })
  })

  it('maps a 200 sentinel to not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ response: TINY_NOT_EXISTS })))
    expect(await getTiny('ghost')).toEqual({ status: 'not-found' })
  })
})

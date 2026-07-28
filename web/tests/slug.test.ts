// @vitest-environment node
import { describe, it, expect } from 'vitest'
import slugify from 'slugify'

/**
 * Tiny-name slugging invariant. Both the app (create_ai tool) and the
 * worker (upsert, source of truth) must use { lower: true, strict: true }
 * and reject an empty result — otherwise a name like '日本語' creates a
 * tiny with name='' reachable at tiny.technology/, and '!!!' creates a
 * URL-hostile slug. This test documents the exact contract both sides
 * depend on; if slugify's behavior ever shifts, it fails here first.
 */
const toSlug = (name: string) => slugify(String(name || ''), { lower: true, strict: true })

describe('tiny-name slug contract', () => {
  it('normal names slug cleanly', () => {
    expect(toSlug('My Support Bot')).toBe('my-support-bot')
    expect(toSlug('café')).toBe('cafe')
    expect(toSlug('Bot123')).toBe('bot123')
  })

  it('strict drops URL-hostile punctuation (not passed through like non-strict)', () => {
    expect(toSlug('!!!')).toBe('')
    expect(toSlug('a/b/c')).toBe('abc')
    expect(toSlug('hi!@#there')).toBe('hithere')
  })

  it('names that reduce to empty are detectable (the reject condition)', () => {
    expect(toSlug('日本語')).toBe('')
    expect(toSlug('   ')).toBe('')
    expect(toSlug('')).toBe('')
    // the guard both sides apply:
    for (const bad of ['日本語', '!!!', '   ', '']) expect(!toSlug(bad)).toBe(true)
  })

  it('result is always a valid URL slug when non-empty', () => {
    for (const n of ['My Bot', 'café', 'A_B-c', 'Ünïcode123']) {
      const s = toSlug(n)
      if (s) expect(s).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('loose slugging diverges from stored slug — the control-route echo must be strict', () => {
    // /api/control echoes the slug the caller uses to open/display the new
    // tiny's URL. A non-strict slug leaves URL-hostile chars in place, so the
    // caller addresses a slug the worker never stored (get.ts re-slugs and
    // still resolves, but the shown URL is wrong). These must be identical.
    const loose = (name: string) => slugify(String(name || ''), { lower: true })
    for (const n of ['my!tiny', 'C++ bot', 'foo@bar', 'a.b.c']) {
      expect(loose(n)).not.toBe(toSlug(n))
    }
    expect(toSlug('my!tiny')).toBe('mytiny')
  })
})

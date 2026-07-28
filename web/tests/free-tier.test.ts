// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  freeTierRequestsPerDay, freeTierRequestsPhrase,
  DEFAULT_REQUESTS_PER_DAY, MAX_REQUESTS_PER_DAY, FREE_TIER_ENV,
} from '../lib/free-tier'

/**
 * ⚡ THE FREE-TIER ALLOWANCE (lib/free-tier.ts) — report §2.2's one unimplemented
 * lever, "raise/scope the 50/day default (env-tunable)".
 *
 * The entire free tier was one number living as a DEFAULT PARAMETER of
 * `enforceIpDailyLimit`. Nothing read env, so the operator of a self-hosted
 * instance — whose model key, KV window and bill these requests spend — could
 * not move their own wall without patching our source.
 *
 * Two claims are worth pinning, and neither is "it reads an env var":
 *
 *  1. **Misconfiguration falls back to the shipped wall, never to "off" and
 *     never to zero.** `0` is the dangerous one: a sliding window of 0 rejects
 *     every free-tier request forever, so a stray `=0` would take the whole free
 *     tier down while looking like a limit that was merely set low.
 *  2. **The copy is derived from the same number.** Three UI strings quoted "50
 *     requests a day"; an env-tunable limit under hardcoded copy is exactly the
 *     c30 explorer bug, except the wrong label is the thing a user reads BEFORE
 *     they hit the wall.
 */

beforeEach(() => vi.stubEnv(FREE_TIER_ENV, ''))
afterEach(() => vi.unstubAllEnvs())

describe('freeTierRequestsPerDay — the deployment owns its wall', () => {
  it('unset → the wall this codebase shipped with', () => {
    // Not merely "some default": the value live KV windows were sized with, so
    // adding the knob changes nothing on tiny.technology.
    expect(DEFAULT_REQUESTS_PER_DAY).toBe(50)
    expect(freeTierRequestsPerDay()).toBe(50)
  })

  it('a plain integer is honoured — raised OR lowered', () => {
    vi.stubEnv(FREE_TIER_ENV, '500')
    expect(freeTierRequestsPerDay()).toBe(500)
    // Lowering matters as much: a hobby instance on someone's own OpenAI key may
    // want a wall far tighter than ours, and "env-tunable" that only goes up is
    // a knob for us, not for them.
    vi.stubEnv(FREE_TIER_ENV, '5')
    expect(freeTierRequestsPerDay()).toBe(5)
    vi.stubEnv(FREE_TIER_ENV, '1')
    expect(freeTierRequestsPerDay()).toBe(1)
  })

  it('surrounding whitespace is tolerated — env files collect it', () => {
    vi.stubEnv(FREE_TIER_ENV, '  200  ')
    expect(freeTierRequestsPerDay()).toBe(200)
  })

  it('fractions floor — Upstash needs an integer window', () => {
    vi.stubEnv(FREE_TIER_ENV, '99.9')
    expect(freeTierRequestsPerDay()).toBe(99)
  })

  it('ZERO falls back, because a 0 window rejects every request forever', () => {
    // The failure this test exists for: `=0` reads like "a very low limit" and
    // would actually be a total free-tier outage that fails CLOSED on a limiter
    // whose whole contract is to fail open.
    vi.stubEnv(FREE_TIER_ENV, '0')
    expect(freeTierRequestsPerDay()).toBe(DEFAULT_REQUESTS_PER_DAY)
    vi.stubEnv(FREE_TIER_ENV, '0.4')
    expect(freeTierRequestsPerDay()).toBe(DEFAULT_REQUESTS_PER_DAY)
  })

  it('junk and negatives fall back to the shipped wall, never remove it', () => {
    for (const junk of ['', '   ', 'lots', 'fifty', '-1', '-999', 'NaN', '5o', '1,000', '1e', 'true']) {
      vi.stubEnv(FREE_TIER_ENV, junk)
      expect(freeTierRequestsPerDay()).toBe(DEFAULT_REQUESTS_PER_DAY)
    }
  })

  it('Infinity is a typo, not an unlimited tier', () => {
    // `Number('Infinity')` is finite-looking enough to slip through a naive
    // check, and it would hand slidingWindow a non-integral argument and print
    // "Infinity requests a day" in the onboarding card.
    for (const v of ['Infinity', '-Infinity', '1e999']) {
      vi.stubEnv(FREE_TIER_ENV, v)
      expect(freeTierRequestsPerDay()).toBe(DEFAULT_REQUESTS_PER_DAY)
    }
  })

  it('an absurd value is clamped to MAX, not passed through', () => {
    vi.stubEnv(FREE_TIER_ENV, '99999999999999')
    expect(freeTierRequestsPerDay()).toBe(MAX_REQUESTS_PER_DAY)
  })

  it('always returns a positive safe integer — the only shape the callers accept', () => {
    for (const v of ['', '50', '0', '-3', 'x', '7.7', 'Infinity', '9e99']) {
      vi.stubEnv(FREE_TIER_ENV, v)
      const n = freeTierRequestsPerDay()
      expect(Number.isSafeInteger(n)).toBe(true)
      expect(n).toBeGreaterThan(0)
    }
  })
})

describe('freeTierRequestsPhrase — the copy quotes the configured number', () => {
  it('reproduces the shipped string byte-for-byte at the default', () => {
    // Three UI sites embed this phrase; anything else here is a copy regression
    // dressed as a refactor.
    expect(freeTierRequestsPhrase()).toBe('50 requests a day')
  })

  it('follows the env — the whole point of deriving it', () => {
    vi.stubEnv(FREE_TIER_ENV, '500')
    expect(freeTierRequestsPhrase()).toBe('500 requests a day')
  })

  it('says "1 request a day", not "1 requests a day"', () => {
    // An operator CAN set 1 (see the lowering test), and the count grammar is
    // exactly what pluralize exists to stop drifting.
    vi.stubEnv(FREE_TIER_ENV, '1')
    expect(freeTierRequestsPhrase()).toBe('1 request a day')
  })

  it('never renders NaN, Infinity or an empty count', () => {
    for (const junk of ['', 'lots', '0', '-5', 'Infinity']) {
      vi.stubEnv(FREE_TIER_ENV, junk)
      const phrase = freeTierRequestsPhrase()
      expect(phrase).toBe('50 requests a day')
      expect(phrase).not.toMatch(/NaN|Infinity|undefined/)
    }
  })

  it('carries no punctuation — each site owns its own sentence', () => {
    // ModelSettings ends "…limited to <phrase>." and the onboarding card ends
    // "Free tier — <phrase>, zero setup." A baked-in period would double up.
    vi.stubEnv(FREE_TIER_ENV, '120')
    expect(freeTierRequestsPhrase()).not.toMatch(/[.,;]/)
  })
})

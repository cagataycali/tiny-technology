// @vitest-environment node
/**
 * A payment quote's TTL, as a rule rather than a one-shot render read
 * (backlog v11 A1). PayReceipt computed `expired` once in its render body; a
 * chat card has no reason to re-render, so a quote that lapsed on screen kept
 * offering "✓ Approve $0.01" until the tap failed it into a red "Payment not
 * sent" for a payment never attempted.
 *
 * The two failure modes worth more than the happy path:
 *  - a bad `expires_at` must NOT be read as expired (the server enforces exp
 *    anyway, and guessing takes a working button away), and
 *  - a bad `expires_at` must not be able to schedule a timer that overflows
 *    setTimeout's 2^31−1 ms delay and therefore fires IMMEDIATELY.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  msUntilExpiry, isQuoteExpired, expiryTimeoutMs, EXPIRY_TICK_MAX_MS,
} from '@/lib/chat/quote-expiry'

const NOW = 1_800_000_000_000 // fixed wall clock, ms
const secs = (s: number) => NOW / 1000 + s // an expires_at `s` seconds from NOW

describe('msUntilExpiry', () => {
  it('counts down in milliseconds from a seconds-based expires_at', () => {
    expect(msUntilExpiry(secs(300), NOW)).toBe(300_000)
    expect(msUntilExpiry(secs(1), NOW)).toBe(1_000)
  })

  it('goes negative once the deadline is past', () => {
    expect(msUntilExpiry(secs(-1), NOW)).toBe(-1_000)
  })

  it('answers null — not 0 — when there is no deadline at all', () => {
    // The distinction is load-bearing: 0 means "just expired" and arms nothing,
    // null means "never scheduled". A caller that conflated them would set a
    // timer on a quote that has no expiry.
    for (const bad of [undefined, null, '', 'soon', NaN, Infinity, -Infinity, 0, -5, {}, []]) {
      expect(msUntilExpiry(bad, NOW), String(bad)).toBeNull()
    }
    expect(msUntilExpiry(secs(0), NOW)).toBe(0) // a real deadline of exactly now
  })
})

describe('isQuoteExpired', () => {
  it('a live quote is not expired', () => {
    expect(isQuoteExpired(secs(300), NOW)).toBe(false)
    expect(isQuoteExpired(secs(0.001), NOW)).toBe(false)
  })

  it('a lapsed quote is expired', () => {
    expect(isQuoteExpired(secs(-0.001), NOW)).toBe(true)
    expect(isQuoteExpired(secs(-3600), NOW)).toBe(true)
  })

  it('AT the expiry instant the quote is still good — matching the server', () => {
    // The route refuses on `nowSec > q.exp`, i.e. it is still valid at exp.
    // Both mobile clients use the same strict `<`. A `<=` here would refuse a
    // quote the server would have honoured.
    expect(isQuoteExpired(secs(0), NOW)).toBe(false)
  })

  it('an UNKNOWABLE deadline is never reported as expired', () => {
    // A missing/garbled expires_at is not evidence of expiry. Erring the other
    // way replaces a working Approve button with a re-quote nobody asked for —
    // and the server still enforces exp, so nothing unsafe gets through.
    for (const bad of [undefined, null, NaN, 'nope', 0, -1]) {
      expect(isQuoteExpired(bad, NOW), String(bad)).toBe(false)
    }
  })

  it('does not care WHICH clock — a later now expires the same quote', () => {
    const q = secs(60)
    expect(isQuoteExpired(q, NOW)).toBe(false)
    expect(isQuoteExpired(q, NOW + 59_999)).toBe(false)
    expect(isQuoteExpired(q, NOW + 60_001)).toBe(true)
  })
})

describe('expiryTimeoutMs', () => {
  it('waits exactly the remaining time when it fits in one tick', () => {
    expect(expiryTimeoutMs(secs(5), NOW)).toBe(5_000)
    expect(expiryTimeoutMs(secs(EXPIRY_TICK_MAX_MS / 1000), NOW)).toBe(EXPIRY_TICK_MAX_MS)
  })

  it('CAPS a long wait instead of scheduling it in one go', () => {
    // The whole reason the cap exists: a 5-minute TTL becomes ~10 short ticks,
    // each recomputed from a fresh clock, so a sleeping laptop or a wall-clock
    // jump lands on "recompute" rather than on a stale decision.
    expect(expiryTimeoutMs(secs(300), NOW)).toBe(EXPIRY_TICK_MAX_MS)
  })

  it('a milliseconds-shaped expires_at can NEVER produce an overflowing delay', () => {
    // THE bug this cap prevents. `expires_at` is seconds; hand it milliseconds
    // (the unit confusion relative-time.ts already guards) and the naive delay
    // is ~50,000 years — above setTimeout's 2^31−1 ms, where the browser
    // wraps it and fires IMMEDIATELY. So the "safe" reading of a malformed
    // deadline would expire a quote with four minutes left, instantly.
    const naive = msUntilExpiry(NOW /* ms in a seconds field */, NOW)!
    expect(naive).toBeGreaterThan(2 ** 31 - 1)
    expect(expiryTimeoutMs(NOW, NOW)).toBe(EXPIRY_TICK_MAX_MS)
  })

  it('never returns 0 — a zero-delay timer would spin without progressing', () => {
    expect(expiryTimeoutMs(secs(0.0001), NOW)).toBe(1)
    expect(expiryTimeoutMs(secs(0), NOW)).toBe(1)
  })

  it('arms nothing once expired, or when there is no deadline', () => {
    expect(expiryTimeoutMs(secs(-0.001), NOW)).toBeNull()
    expect(expiryTimeoutMs(secs(-600), NOW)).toBeNull()
    for (const bad of [undefined, null, NaN, 'x', 0, -1]) {
      expect(expiryTimeoutMs(bad, NOW), String(bad)).toBeNull()
    }
  })

  it('successive ticks converge on the deadline and then stop', () => {
    // Simulate the hook's re-arm loop: it must terminate, and it must not stop
    // BEFORE the quote is actually expired (which would leave a live Approve
    // button on a lapsed quote — the bug, one layer down).
    const q = secs(70)
    let now = NOW
    let ticks = 0
    for (;;) {
      const d = expiryTimeoutMs(q, now)
      if (d === null) break
      now += d
      if (++ticks > 100) throw new Error('re-arm loop did not converge')
    }
    expect(isQuoteExpired(q, now)).toBe(true)
    expect(ticks).toBe(4) // 30s + 30s + 10s + 1ms
  })
})

/**
 * The wiring. A perfect rule nobody calls fixes nothing, and the specific
 * regression is easy to reintroduce by writing the comparison inline again —
 * so this bans the inline form in the card rather than merely requiring the
 * hook, and anchors on the CALL SITES, not on the import line.
 */
describe('PayReceipt consumes the live expiry', () => {
  const src = readFileSync(join(__dirname, '..', 'components', 'chat', 'PayReceipt.tsx'), 'utf8')

  it('derives `expired` from the hook, not from a render-time clock read', () => {
    expect(src).toMatch(/const \{ expired \} = useQuoteExpiry\(active\?\.expires_at\)/)
  })

  it('has NO hand-rolled `expires_at * 1000 < Date.now()` left anywhere', () => {
    // The exact shape of the bug, in all three places it used to live: two
    // render-body reads (the approval gate + the failed branch's Retry gate)
    // and the tap-time guard.
    expect(src).not.toMatch(/expires_at\s*\*\s*1000/)
  })

  it('re-checks against a FRESH clock at the moment of the tap', () => {
    // The hook's state can be up to one capped tick stale, so approve() must
    // not authorise from it — a timer that hasn't fired yet would let a lapsed
    // quote through to a PUT the server 410s.
    expect(src).toMatch(/isQuoteExpired\(active\.expires_at,\s*Date\.now\(\)\)/)
  })

  it("the failed branch's Retry gate follows the same live value", () => {
    // `stillValid` decides whether a payment_required failure offers Add
    // funds + Retry; past exp the server refuses the retry, so this gate has to
    // move with the clock too.
    expect(src).toMatch(/const nowExpired = expired/)
  })
})

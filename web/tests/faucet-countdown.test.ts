/**
 * 💧 v11 A2 — the faucet countdown that never counted down.
 *
 * The bug this pins: `deposit_info.faucet.next_drip_in_seconds` is a SERVER
 * DELTA (seconds to UTC midnight, measured at request time). Both consumers
 * load it once and never poll, so the label froze — and because the Claim
 * button's `disabled` comes off the same field, a wallet left open across UTC
 * midnight stayed permanently unable to claim a drip the server would have
 * granted.
 *
 * The rules here are pure: a delta is pinned to an absolute deadline once, then
 * everything is derived from an injected clock. Nothing reads Date.now(), which
 * is the whole reason these can be asserted at all.
 */
import { describe, it, expect } from 'vitest'
import {
  DRIP_TICK_MS,
  dripDeadlineMs,
  dripRemainingSeconds,
  dripTimeoutMs,
} from '../lib/x402/faucet-countdown'
import { faucetCta, untilNextDrip, type FaucetInfo } from '../lib/x402/top-up'

const NOW = 1_800_000_000_000

const FAUCET = (over: Partial<FaucetInfo> = {}): FaucetInfo => ({
  available: true,
  network: 'tiny',
  drip_micro: 1_000_000,
  cap_micro: 5_000_000,
  granted_micro: 1_000_000,
  remaining_micro: 4_000_000,
  claimed_today: true,
  next_drip_in_seconds: 7500,
  ...over,
})

describe('dripDeadlineMs — a delta becomes a deadline, once', () => {
  it('pins the server delta to the clock at the moment it arrived', () => {
    expect(dripDeadlineMs(7500, NOW)).toBe(NOW + 7_500_000)
  })

  it('refuses anything that is not a usable FUTURE delta', () => {
    // Every one of these must be null, not 0: "no known deadline" and "the wait
    // is over" lead to opposite UI, and a coerced 0 silently means the latter.
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, 0, -60, 'soon', '', false, {}, []]) {
      expect(dripDeadlineMs(bad, NOW), String(bad)).toBeNull()
    }
  })

  it('a numeric STRING is accepted — JSON from a worker is not always typed', () => {
    expect(dripDeadlineMs('7500', NOW)).toBe(NOW + 7_500_000)
  })

  it('refuses to pin against a broken clock', () => {
    expect(dripDeadlineMs(7500, NaN)).toBeNull()
  })
})

describe('dripRemainingSeconds — derived from the clock, not from the payload', () => {
  it('counts DOWN as the clock advances, with the deadline unchanged', () => {
    // THE regression assertion. The old code re-read the same frozen number
    // forever; here the only thing that changes is `now`.
    const deadline = dripDeadlineMs(7500, NOW)!
    expect(dripRemainingSeconds(deadline, NOW)).toBe(7500)
    expect(dripRemainingSeconds(deadline, NOW + 60_000)).toBe(7440)
    expect(dripRemainingSeconds(deadline, NOW + 7_499_000)).toBe(1)
  })

  it('floors at zero instead of going negative', () => {
    const deadline = dripDeadlineMs(60, NOW)!
    expect(dripRemainingSeconds(deadline, NOW + 3_600_000)).toBe(0)
  })

  it('rounds UP, so a partial second never reads as elapsed early', () => {
    // Ceil, not floor: 500ms left must show as 1s remaining, or the button
    // flips to claimable a tick before the server's day actually rolls over.
    const deadline = NOW + 500
    expect(dripRemainingSeconds(deadline, NOW)).toBe(1)
  })

  it('null deadline stays null — it must not collapse into "elapsed"', () => {
    expect(dripRemainingSeconds(null, NOW)).toBeNull()
    expect(dripRemainingSeconds(NaN, NOW)).toBeNull()
    expect(dripRemainingSeconds(NOW, NaN)).toBeNull()
  })
})

describe('dripTimeoutMs — bounded ticks, landing exactly on the deadline', () => {
  it('ticks at the cap while there is more than a tick left', () => {
    const deadline = dripDeadlineMs(7500, NOW)!
    expect(dripTimeoutMs(deadline, NOW)).toBe(DRIP_TICK_MS)
  })

  it('lands ON the deadline rather than overshooting by a whole tick', () => {
    // Otherwise the button re-enables up to 30s after the drip is claimable —
    // small, but it is the exact symptom this cycle exists to remove.
    const deadline = NOW + 4_000
    expect(dripTimeoutMs(deadline, NOW)).toBe(4_000)
  })

  it('stops once the deadline has passed — no timer outlives the wait', () => {
    const deadline = dripDeadlineMs(60, NOW)!
    expect(dripTimeoutMs(deadline, NOW + 60_000)).toBeNull()
    expect(dripTimeoutMs(deadline, NOW + 3_600_000)).toBeNull()
  })

  it('arms nothing when there is no deadline', () => {
    expect(dripTimeoutMs(null, NOW)).toBeNull()
  })

  it('NO server value can produce a delay setTimeout would wrap', () => {
    // A >2^31−1ms delay wraps to a signed int and fires IMMEDIATELY — the trap
    // that bit the quote-expiry timer, where the delay was the full TTL. Here it
    // cannot happen for a structural reason rather than a clamp: the tick cap
    // bounds every return. So that is what gets asserted, across absurd inputs —
    // an explicit 2^31 clamp would be unreachable code (see the docblock).
    for (const s of [60 * 60 * 24 * 365 * 100, Number.MAX_SAFE_INTEGER, 1e15, 86_400]) {
      const d = dripTimeoutMs(dripDeadlineMs(s, NOW)!, NOW)!
      expect(d, String(s)).toBe(DRIP_TICK_MS)
      expect(d, String(s)).toBeLessThan(2 ** 31 - 1)
    }
  })
})

describe('faucetCta with a LIVE clock', () => {
  it('re-enables the claim once the wait has elapsed', () => {
    // The whole point of the cycle: same server payload (claimed_today: true),
    // and the ONLY thing that differs is the clock-derived remainder.
    const f = FAUCET()
    const waiting = faucetCta(f, { remainingSeconds: 7500 })
    expect(waiting.enabled).toBe(false)
    expect(waiting.label).toBe('Claimed today')

    const lapsed = faucetCta(f, { remainingSeconds: 0 })
    expect(lapsed.enabled).toBe(true)
    expect(lapsed.label).toBe('Claim $1 free credit')
    expect(lapsed.reason).toBe('')
  })

  it('prefers the LIVE remainder over the frozen server delta in the label', () => {
    // Server said 2h 5m at fetch; two hours later the clock says 5m. The label
    // must be the clock's answer, or it contradicts its own countdown.
    const cta = faucetCta(FAUCET({ next_drip_in_seconds: 7500 }), { remainingSeconds: 300 })
    expect(cta.reason).toContain('5m')
    expect(cta.reason).not.toContain('2h')
  })

  it('a lapsed wait NEVER overrides the lifetime ceiling', () => {
    // The ceiling is permanent; the daily wait is not. A clock rolling over must
    // not offer a claim the server refuses with 400 ceiling_reached.
    const cta = faucetCta(
      FAUCET({ remaining_micro: 0, granted_micro: 5_000_000 }),
      { remainingSeconds: 0 },
    )
    expect(cta.enabled).toBe(false)
    expect(cta.label).toBe('Lifetime credit used')
  })

  it('omitting the option preserves the old behaviour exactly', () => {
    // Callers with no clock (server render, tests, any not-yet-updated client)
    // must be byte-identical to before, or this becomes a silent behaviour
    // change for every one of them.
    for (const f of [
      FAUCET(),
      FAUCET({ claimed_today: false }),
      FAUCET({ remaining_micro: 0 }),
      FAUCET({ next_drip_in_seconds: undefined }),
      { available: false },
    ]) {
      expect(faucetCta(f)).toEqual(faucetCta(f, {}))
      expect(faucetCta(f)).toEqual(faucetCta(f, { remainingSeconds: undefined }))
    }
  })

  it('null (a clock with no deadline) still WAITS — it is not a lapse', () => {
    // The server sent no delta, so nothing is known about when the day rolls
    // over. That is "wait, duration unknown", not "claim now": guessing the
    // latter offers a button the server 429s.
    const cta = faucetCta(FAUCET({ next_drip_in_seconds: undefined }), { remainingSeconds: null })
    expect(cta.enabled).toBe(false)
    expect(cta.label).toBe('Claimed today')
    expect(cta.reason).toContain('midnight UTC')
  })

  it('a NaN remainder is not treated as a lapse', () => {
    const cta = faucetCta(FAUCET(), { remainingSeconds: NaN })
    expect(cta.enabled).toBe(false)
  })

  it('never claims to be waiting for less than a minute', () => {
    // untilNextDrip floors to whole minutes, so 30s left would render "0m".
    // It clamps to "1m" instead — a countdown that hits zero and stays there
    // reads as broken, and the flip is only ever a tick away.
    expect(untilNextDrip(30)).toBe('1m')
    const cta = faucetCta(FAUCET(), { remainingSeconds: 30 })
    expect(cta.reason).toContain('in 1m')
    expect(cta.reason).not.toContain('0m')
  })
})

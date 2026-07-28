'use client'

/**
 * The clock half of quote-expiry.ts: keep a payment card's notion of "expired"
 * true over time, without a permanent per-card interval.
 *
 * The state IS the answer (a boolean), not the clock it was derived from. That
 * matters for two reasons: React bails out of a re-render when setState is
 * handed the same value, so the every-30s tick on a live quote costs nothing
 * until the moment it flips; and a card that never ticks can't hold a stale
 * `now` that some later render would reinterpret.
 *
 * ⚠️ Every write happens in a TIMER CALLBACK, never synchronously in the effect
 * body — a sync setState there cascades a second render pass on every mount of
 * every payment card in a transcript (react-hooks/set-state-in-effect). The
 * cost is that a re-mint (`Get fresh quote` swapping `expires_at`) shows the
 * previous quote's verdict for one frame. Harmless here: the button that frame
 * paints is either Approve or Get-fresh-quote, and `approve()` re-checks
 * against a fresh clock at the tap, so a stale frame can never authorise a
 * lapsed quote — only briefly mislabel a button.
 *
 * The timer chain stops as soon as there is nothing left to wait for, so a
 * settled card in a long transcript holds no timers at all.
 */
import { useEffect, useState } from 'react'
import { expiryTimeoutMs, isQuoteExpired } from './quote-expiry'

export function useQuoteExpiry(expiresAt: unknown): { expired: boolean } {
  // Seeded from the clock at MOUNT, so a card restored into an old transcript
  // paints as expired on its very first frame rather than flashing a live
  // Approve button.
  const [expired, setExpired] = useState(() => isQuoteExpired(expiresAt, Date.now()))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    const settle = () => {
      if (cancelled) return
      // Always re-read the real clock rather than counting elapsed ticks: a
      // laptop asleep through the TTL, or a wall-clock jump, then lands on
      // "recompute" instead of on a stale decision.
      const now = Date.now()
      setExpired(isQuoteExpired(expiresAt, now))
      const delay = expiryTimeoutMs(expiresAt, now)
      // null = expired already, or no deadline to reach. Either way, stop.
      if (delay !== null) timer = setTimeout(settle, delay)
    }
    // Bootstrap in a task, not inline (see the docblock). This also covers the
    // case a mount-time seed cannot: `expiresAt` CHANGING on a card whose
    // previous quote armed no timer, where the held verdict is about a quote
    // that no longer exists.
    timer = setTimeout(settle, 0)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [expiresAt])

  return { expired }
}

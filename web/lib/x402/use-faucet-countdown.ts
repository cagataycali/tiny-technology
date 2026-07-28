'use client'

/**
 * The clock half of faucet-countdown.ts: keep "Next top-up in 2h 5m" counting
 * down, and re-enable the Claim button when the wait is actually over.
 *
 * Same shape as lib/chat/use-quote-expiry.ts, for the same two reasons: the
 * STATE is the answer (seconds remaining), not the clock it came from, so React
 * bails out of a re-render whenever a tick lands on the same value; and every
 * write happens in a TIMER CALLBACK, never synchronously in the effect body,
 * because a sync setState there cascades a second render pass on mount
 * (react-hooks/set-state-in-effect).
 *
 * The one difference from quote-expiry is which input rots. A quote carries an
 * absolute `expires_at`, so the clock is the only moving part. The faucet
 * carries a server-computed DELTA, which is only true at the instant it was
 * measured — so the delta is pinned to an absolute deadline on arrival, and the
 * pin is redone whenever a fresh deposit_info replaces it (a claim refetches).
 *
 * The timer chain stops the moment the deadline passes, so an idle wallet tab
 * holds no timers.
 */
import { useEffect, useRef, useState } from 'react'
import { dripDeadlineMs, dripRemainingSeconds, dripTimeoutMs } from './faucet-countdown'

export function useFaucetCountdown(nextDripInSeconds: unknown): { remainingSeconds: number | null } {
  // The pinned deadline. A ref, not state: pinning it must not itself cause a
  // render, and the value that renders is the seconds below.
  //
  // ⚠️ Written ONLY from the effect, never from the initializer below. A ref
  //    assignment inside a useState initializer is a write during render
  //    (react-hooks/refs, an error not a warning), and it is also redundant —
  //    the effect re-pins on mount before any timer fires. The seed exists for
  //    the FIRST PAINT only, so it computes its own deadline and discards it.
  const deadlineRef = useRef<number | null>(null)
  const [remainingSeconds, setRemaining] = useState<number | null>(() =>
    dripRemainingSeconds(dripDeadlineMs(nextDripInSeconds, Date.now()), Date.now()),
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    // Re-pin on every change of the server delta. A fresh deposit_info after a
    // claim carries a NEW delta measured at a new instant; reusing the old
    // deadline would count down to yesterday's midnight.
    const deadline = dripDeadlineMs(nextDripInSeconds, Date.now())
    deadlineRef.current = deadline
    const settle = () => {
      if (cancelled) return
      // Always re-read the real clock instead of counting ticks, so a laptop
      // asleep across the boundary lands on "claimable" rather than on a stale
      // decision.
      const now = Date.now()
      setRemaining(dripRemainingSeconds(deadlineRef.current, now))
      const delay = dripTimeoutMs(deadlineRef.current, now)
      if (delay !== null) timer = setTimeout(settle, delay)
    }
    // Bootstrap in a task rather than inline — see the docblock. This also
    // covers what a mount-time seed cannot: the delta CHANGING on a mounted
    // card, where the held seconds describe a deadline that no longer exists.
    timer = setTimeout(settle, 0)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [nextDripInSeconds])

  return { remainingSeconds }
}

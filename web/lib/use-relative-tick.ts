'use client'

/**
 * The clock half of relative-tick.ts: make a list of "5m ago" labels keep up.
 *
 * Same shape as use-quote-expiry / use-faucet-countdown, with one difference that
 * follows from the subject. Those hooks own ONE deadline, so their state is the
 * answer (a boolean, a seconds-remaining) and a tick that lands on the same value
 * costs nothing because React bails out. A ledger has N labels, so there is no
 * single answer to hold — the state here is just a counter whose only purpose is
 * to say "re-read the clock", and the caller formats during render as it already
 * did. That is why this returns nothing: adopting it is one line, and every
 * existing `relative(e.created)` call site stays exactly as it was.
 *
 * ⚠️ The state must therefore CHANGE on every tick (a counter, not a timestamp
 *    rounded to something): a value React bails out on would skip the re-render
 *    that is the entire point.
 *
 * Writes happen in the timer callback, never synchronously in the effect body —
 * a sync setState there cascades a second render pass on mount
 * (react-hooks/set-state-in-effect).
 */
import { useEffect, useState } from 'react'
import { nextRelativeTickMs, parseRelativeTickKey } from './relative-tick'

/**
 * Re-render the caller whenever any of `key`'s timestamps would change its
 * relative label. `key` comes from relativeTickKey() — a string, so a fresh
 * array of the same stamps does not re-arm the chain.
 */
export function useRelativeTick(key: string): void {
  const [, bump] = useState(0)

  useEffect(() => {
    // No early `if (!stamps.length) return` here on purpose: nextRelativeTickMs
    // already answers null for an empty list, so a length check would be a second
    // decision point that can only agree with the first — and a guard that cannot
    // change any outcome is exactly the code that makes a mutation test lie
    // (deleting it kept every test green, which is how it was found).
    const stamps = parseRelativeTickKey(key)
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    const arm = () => {
      if (cancelled) return
      // Always recompute from the real clock instead of assuming the last delay
      // elapsed exactly: a suspended laptop or a wall-clock change then lands on
      // the correct next boundary rather than drifting by however long it slept.
      const delay = nextRelativeTickMs(stamps, Date.now())
      if (delay === null) return
      timer = setTimeout(() => {
        if (cancelled) return
        bump((n) => n + 1)
        arm()
      }, delay)
    }
    arm()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [key])
}

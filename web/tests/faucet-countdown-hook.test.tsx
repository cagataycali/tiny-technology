// @vitest-environment jsdom
/**
 * The clock half of v11 A2: does the faucet card actually NOTICE UTC midnight?
 *
 * The pure rules live in faucet-countdown.test.ts. What only a DOM + fake timers
 * can prove is the behaviour that was broken: a mounted wallet whose drip
 * becomes claimable while nothing else re-renders it. A test that only checked
 * the seed value would have passed on the old code — which is exactly why the
 * bug survived — so the load-bearing assertion is a transition with ZERO prop
 * changes in between.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { useFaucetCountdown } from '../lib/x402/use-faucet-countdown'
import { DRIP_TICK_MS } from '../lib/x402/faucet-countdown'
import { faucetCta } from '../lib/x402/top-up'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = 1_800_000_000_000

let renders = 0
function Card({ seconds }: { seconds: unknown }) {
  const { remainingSeconds } = useFaucetCountdown(seconds)
  // The real consumers pass this straight into faucetCta, so the test asserts
  // the BUTTON, not an intermediate number — the button is what was stuck.
  const cta = faucetCta(
    { available: true, drip_micro: 1_000_000, cap_micro: 5_000_000, remaining_micro: 4_000_000, claimed_today: true },
    { remainingSeconds },
  )
  renders++
  return (
    <div>
      <span data-testid="left">{remainingSeconds == null ? 'none' : String(remainingSeconds)}</span>
      <button data-testid="claim" disabled={!cta.enabled}>{cta.label}</button>
    </div>
  )
}

const left = () => screen.getByTestId('left').textContent
const claim = () => screen.getByTestId('claim') as HTMLButtonElement

// The hook bootstraps in a 0ms task rather than synchronously in the effect body
// (a sync setState there cascades an extra render pass — set-state-in-effect).
function flush() {
  act(() => { vi.advanceTimersByTime(0) })
}

function mount(seconds: unknown) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  renders = 0
  const r = render(<Card seconds={seconds} />)
  flush()
  return r
}

describe('useFaucetCountdown', () => {
  it('the Claim button UN-DISABLES itself when the wait elapses, with no prop change', () => {
    // THE regression test. Old code held a frozen server delta, so this button
    // stayed disabled forever — past UTC midnight, on a drip the server would
    // have granted, with no visible reason and no cure but a reload.
    mount(120)
    expect(claim().disabled).toBe(true)
    expect(claim().textContent).toBe('Claimed today')

    act(() => { vi.advanceTimersByTime(90_000) })
    expect(claim().disabled).toBe(true) // still inside the wait

    act(() => { vi.advanceTimersByTime(31_000) })
    expect(claim().disabled).toBe(false)
    expect(claim().textContent).toBe('Claim $1 free credit')
  })

  it('counts DOWN rather than holding the fetch-time number', () => {
    mount(7500)
    expect(left()).toBe('7500')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(left()).toBe('7440')
    act(() => { vi.advanceTimersByTime(600_000) })
    expect(left()).toBe('6840')
  })

  it('seeds correctly on the FIRST paint, before any timer runs', () => {
    // A card mounted mid-wait must not flash a claimable button, and one mounted
    // after the wait must not flash a disabled one. Asserted before flush().
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    renders = 0
    render(<Card seconds={7500} />)
    expect(left()).toBe('7500')
    expect(claim().disabled).toBe(true)
    expect(renders).toBe(1)
    flush()
    expect(renders).toBe(1) // same value → React bails out, no cascade
  })

  it('stops ticking once the wait is over', () => {
    mount(10)
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(claim().disabled).toBe(false)
    const after = renders
    act(() => { vi.advanceTimersByTime(60 * 60 * 1000) })
    // An idle wallet tab must not tick forever after the drip is claimable.
    expect(renders).toBe(after)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a missing delta arms no timer and never reads as claimable', () => {
    for (const bad of [undefined, null, NaN, 0, -5, 'soon']) {
      mount(bad)
      expect(left(), String(bad)).toBe('none')
      // Unknown is NOT elapsed: the button must stay disabled.
      expect(claim().disabled, String(bad)).toBe(true)
      expect(vi.getTimerCount(), String(bad)).toBe(0)
      act(() => { vi.advanceTimersByTime(4 * 60 * 60 * 1000) })
      expect(claim().disabled, String(bad)).toBe(true)
      cleanup()
      vi.useRealTimers()
    }
  })

  it('re-pins to the NEW delta when deposit_info is refetched', () => {
    // A claim refetches deposit_info, which carries a delta measured at a NEW
    // instant. Reusing the old deadline would count down to yesterday.
    const { rerender } = mount(30)
    act(() => { vi.advanceTimersByTime(31_000) })
    expect(claim().disabled).toBe(false)
    // 24h from the new "now" — a full day's wait after the fresh claim.
    act(() => { rerender(<Card seconds={86_400} />) })
    flush()
    expect(left()).toBe('86400')
    expect(claim().disabled).toBe(true)
  })

  it('re-reads the clock on re-pin, not only on mount', () => {
    // A card that mounted with NO delta arms no timer, so nothing revisits it.
    // When a refetch later hands it a delta, the held null must not survive.
    const { rerender } = mount(undefined)
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(NOW + 10 * 60 * 1000)
    act(() => { rerender(<Card seconds={60} />) })
    flush()
    expect(left()).toBe('60')
    expect(claim().disabled).toBe(true)
  })

  it('a long wait costs bounded ticks, not one per second', () => {
    // ⚠️ Advanced in one-second STEPS on purpose. A single
    // advanceTimersByTime(600_000) batches every resulting setState into ONE
    // React render, so `renders` would be 2 whether the hook ticked 20 times or
    // 600 — the assertion would pass on a per-second timer and prove nothing.
    // Stepping forces each tick into its own act, which is what a real browser
    // does over ten minutes.
    mount(600)
    for (let i = 0; i < 600; i++) act(() => { vi.advanceTimersByTime(1_000) })
    expect(claim().disabled).toBe(false)
    // 600s / 30s = 20 ticks, + the mount render and the settling one.
    expect(renders).toBeLessThan(30)
    // And it DID tick — a hook that armed nothing would sit at the mount render
    // and still satisfy the bound above.
    expect(renders).toBeGreaterThan(10)
  })

  it('clears its timer on unmount', () => {
    const { unmount } = mount(7500)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('survives a laptop asleep across UTC midnight', () => {
    // The real-world case: the tab was open, the machine slept, the day rolled
    // over. Recomputing from the real clock (rather than counting elapsed ticks)
    // is what makes this land on "claimable".
    mount(7500)
    vi.setSystemTime(NOW + 24 * 60 * 60 * 1000)
    act(() => { vi.advanceTimersByTime(DRIP_TICK_MS) })
    expect(claim().disabled).toBe(false)
  })
})

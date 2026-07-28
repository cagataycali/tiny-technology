// @vitest-environment jsdom
/**
 * The clock half of v11 A1: does the card actually NOTICE its quote expiring?
 *
 * The pure rules live in quote-expiry.test.ts. What can only be proven with a
 * DOM + fake timers is the behaviour that was broken: a mounted card whose
 * quote lapses while nothing else re-renders it. A test that only checked
 * "expired at mount" would have passed on the old code, which is exactly why
 * the bug survived — so the load-bearing assertion here is a transition from
 * false to true with ZERO prop changes in between.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { useQuoteExpiry } from '../lib/chat/use-quote-expiry'
import { EXPIRY_TICK_MAX_MS } from '../lib/chat/quote-expiry'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = 1_800_000_000_000

let renders = 0
function Card({ expiresAt }: { expiresAt: unknown }) {
  const { expired } = useQuoteExpiry(expiresAt)
  renders++
  return (
    <div>
      <span data-testid="state">{expired ? 'expired' : 'live'}</span>
    </div>
  )
}

const state = () => screen.getByTestId('state').textContent
const secs = (s: number) => NOW / 1000 + s

// The hook bootstraps in a 0ms task rather than synchronously in the effect
// body (a sync setState there cascades a render on every payment card in a
// transcript — react-hooks/set-state-in-effect). So every mount here flushes
// that task, which is what a real browser does before the next paint.
function flush() {
  act(() => { vi.advanceTimersByTime(0) })
}

function mount(expiresAt: unknown) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  renders = 0
  const r = render(<Card expiresAt={expiresAt} />)
  flush()
  return r
}

describe('useQuoteExpiry', () => {
  it('flips to expired ON ITS OWN, with no prop or state change from outside', () => {
    // THE regression test. Old code read Date.now() in the render body, so this
    // card stayed "live" forever — and its Approve button stayed tappable on a
    // quote the server would 410.
    mount(secs(120))
    expect(state()).toBe('live')

    act(() => { vi.advanceTimersByTime(119_000) })
    expect(state()).toBe('live') // still inside the TTL

    act(() => { vi.advanceTimersByTime(2_000) })
    expect(state()).toBe('expired')
  })

  it('a card MOUNTED after its quote lapsed is expired on the first paint', () => {
    // The only case the old render-time read caught; it must keep working, and
    // it must not flicker through a "live" frame first. Asserted BEFORE the
    // bootstrap task runs — the useState seed has to be right on its own, or a
    // restored transcript paints a live Approve button for a frame.
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    renders = 0
    render(<Card expiresAt={secs(-30)} />)
    expect(state()).toBe('expired')
    expect(renders).toBe(1)
    flush()
    expect(state()).toBe('expired')
    expect(renders).toBe(1) // same value → React bails out, no cascade
  })

  it('stops re-arming once expired — no timer outlives the deadline', () => {
    mount(secs(10))
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(state()).toBe('expired')
    const after = renders
    act(() => { vi.advanceTimersByTime(10 * 60 * 1000) })
    // A card in a long transcript must not tick forever after it's settled.
    expect(renders).toBe(after)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a quote with NO deadline arms no timer and never reads as expired', () => {
    for (const bad of [undefined, null, NaN, 0, 'soon']) {
      mount(bad)
      expect(state(), String(bad)).toBe('live')
      expect(vi.getTimerCount(), String(bad)).toBe(0)
      act(() => { vi.advanceTimersByTime(60 * 60 * 1000) })
      expect(state(), String(bad)).toBe('live')
      cleanup()
      vi.useRealTimers()
    }
  })

  it('a milliseconds-shaped expires_at does not expire instantly', () => {
    // setTimeout wraps a >2^31−1 delay and fires immediately, so without the
    // tick cap this card would flip to expired on the very next tick — with
    // ~50,000 years nominally left. jsdom/vitest fake timers reproduce the
    // overflow, which is why the assertion is behavioural, not arithmetic.
    mount(NOW) // ms in a seconds field
    expect(state()).toBe('live')
    act(() => { vi.advanceTimersByTime(5 * EXPIRY_TICK_MAX_MS) })
    expect(state()).toBe('live')
  })

  it('re-arms against the NEW quote when the card is re-minted', () => {
    // "Get fresh quote" swaps expires_at in place. If the effect didn't
    // re-arm on that change, the fresh 5-minute quote would inherit the dead
    // one's (already elapsed) timer and read expired forever.
    const { rerender } = mount(secs(-5))
    expect(state()).toBe('expired')
    act(() => { rerender(<Card expiresAt={secs(300)} />) })
    flush()
    expect(state()).toBe('live')
    act(() => { vi.advanceTimersByTime(299_000) })
    expect(state()).toBe('live')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(state()).toBe('expired')
  })

  it('re-reads the clock on re-arm, not just on mount', () => {
    // A card that mounted with NO deadline arms no timer, so nothing would ever
    // revisit its verdict. When a re-mint later hands it a quote that is already
    // past its deadline (a quote slower to arrive than its own 5-min TTL, or a
    // server clock ahead of this browser), the held "live" must not survive the
    // prop change — the effect has to re-evaluate on `expiresAt`, not only on
    // its own tick.
    const { rerender } = mount(undefined)
    expect(state()).toBe('live')
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(NOW + 10 * 60 * 1000) // 10 min pass with no timer running
    act(() => { rerender(<Card expiresAt={secs(60)} />) }) // expired 9 min ago
    flush()
    expect(state()).toBe('expired')
  })

  it('a long TTL costs bounded ticks, not one timer per second', () => {
    mount(secs(300))
    act(() => { vi.advanceTimersByTime(301_000) })
    expect(state()).toBe('expired')
    // ~10 capped ticks + the mount render; a per-second interval would be 300+.
    expect(renders).toBeLessThan(20)
  })

  it('clears its timer on unmount', () => {
    const { unmount } = mount(secs(300))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('survives a laptop asleep through the whole TTL', () => {
    // A single long setTimeout would fire late but correctly; the point here is
    // that the capped tick recomputes from the real clock rather than counting
    // its own elapsed ticks, so a jumped clock still lands on "expired".
    mount(secs(300))
    vi.setSystemTime(NOW + 60 * 60 * 1000)
    act(() => { vi.advanceTimersByTime(EXPIRY_TICK_MAX_MS) })
    expect(state()).toBe('expired')
  })
})

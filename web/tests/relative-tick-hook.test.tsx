// @vitest-environment jsdom
/**
 * The clock half of v11 A3. The pure schedule is proven in relative-tick.test.ts;
 * what only a DOM + fake timers can show is the defect itself — a wallet page
 * that loads once, never polls, and so kept rendering "just now" for an hour.
 *
 * Every assertion here is a transition with ZERO prop changes in between: a test
 * that only checked the first paint would have passed on the old code, which is
 * exactly how the bug survived a mount-time-correct formatter.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { useRelativeTick } from '../lib/use-relative-tick'
import { relativeTickKey, RELATIVE_TICK_MAX_MS } from '../lib/relative-tick'
import { relativeAgo } from '../lib/relative-time'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = 1_800_000_000_000
const secAgo = (n: number) => NOW / 1000 - n

let renders = 0

/** The wallet's Activity list, reduced to the part that rots. */
function Ledger({ stamps }: { stamps: (number | undefined)[] }) {
  useRelativeTick(relativeTickKey(stamps))
  renders++
  return (
    <ul>
      {stamps.map((s, i) => (
        <li key={i} data-testid={`row-${i}`}>{relativeAgo(s, '')}</li>
      ))}
    </ul>
  )
}

const row = (i: number) => screen.getByTestId(`row-${i}`).textContent

function mount(stamps: (number | undefined)[]) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  renders = 0
  return render(<Ledger stamps={stamps} />)
}

describe('useRelativeTick', () => {
  it('a row ages on screen with no prop change at all', () => {
    // THE regression test. Old code: this row read "just now" until a reload.
    mount([secAgo(10)])
    expect(row(0)).toBe('just now')
    act(() => { vi.advanceTimersByTime(50_000) })
    expect(row(0)).toBe('1m ago')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(row(0)).toBe('2m ago')
    act(() => { vi.advanceTimersByTime(60 * 60 * 1000) })
    expect(row(0)).toBe('1h ago')
  })

  it('updates on the sooner row while the older ones sit still', () => {
    mount([secAgo(10), secAgo(90 * 60), secAgo(30 * 3600)])
    expect([row(0), row(1), row(2)]).toEqual(['just now', '1h ago', '1d ago'])
    act(() => { vi.advanceTimersByTime(50_000) })
    expect([row(0), row(1), row(2)]).toEqual(['1m ago', '1h ago', '1d ago'])
  })

  it('does not fire before the boundary — the render would change nothing', () => {
    mount([secAgo(10)])
    const at = renders
    act(() => { vi.advanceTimersByTime(49_999) })
    expect(renders).toBe(at)
    act(() => { vi.advanceTimersByTime(1) })
    expect(renders).toBe(at + 1)
  })

  it('an old ledger costs about one render a minute, not one every second', () => {
    // ⚠️ Advanced in 1s STEPS deliberately. A single advanceTimersByTime(3600_000)
    //    batches every setState into ONE React render, so the count would be 2
    //    whether the hook ticked twice or 3,600 times — the bound would prove
    //    nothing. Stepping is what a real browser does.
    mount([secAgo(30 * 3600)])
    for (let i = 0; i < 3600; i++) act(() => { vi.advanceTimersByTime(1_000) })
    // One hour at the clamp = ~60 wake-ups, none of which change a label.
    expect(renders).toBeLessThan(70)
    // And it DID wake — a hook that armed nothing would sit at 1 and satisfy the
    // upper bound too. This is the lower bound that catches a dead timer.
    expect(renders).toBeGreaterThan(50)
    expect(3600_000 / RELATIVE_TICK_MAX_MS).toBe(60)
  })

  it('arms nothing for an empty ledger, or one whose rows have no time', () => {
    mount([])
    expect(vi.getTimerCount()).toBe(0)
    cleanup()
    mount([undefined, 0, NaN])
    expect(vi.getTimerCount()).toBe(0)
    // Rows render the fallback and keep rendering it, forever, for free.
    expect(row(0)).toBe('')
    act(() => { vi.advanceTimersByTime(24 * 3600 * 1000) })
    expect(renders).toBe(1)
  })

  it('re-arms when a refetch adds a row, and does NOT when it adds nothing', () => {
    const { rerender } = mount([secAgo(90 * 60)])
    // A fresh array with the same contents: the effect must not re-run, because
    // an effect that re-arms every render never reaches its own timeout.
    const armed = vi.getTimerCount()
    act(() => { rerender(<Ledger stamps={[secAgo(90 * 60)]} />) })
    expect(vi.getTimerCount()).toBe(armed)

    // A genuinely new row's first boundary is 1s away — reachable only if the
    // long-armed timer was replaced.
    act(() => { rerender(<Ledger stamps={[secAgo(90 * 60), secAgo(59)]} />) })
    expect(row(1)).toBe('just now')
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(row(1)).toBe('1m ago')
  })

  it('survives a suspended laptop by recomputing from the real clock', () => {
    // Counting elapsed ticks would land on "1m ago" after a 3-hour sleep. Reading
    // Date.now() at each wake lands on the truth.
    mount([secAgo(10)])
    vi.setSystemTime(NOW + 3 * 3600 * 1000)
    act(() => { vi.advanceTimersByTime(RELATIVE_TICK_MAX_MS) })
    expect(row(0)).toBe('3h ago')
  })

  it('clears its timer on unmount', () => {
    const { unmount } = mount([secAgo(10)])
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a future timestamp (clock skew) neither busy-loops nor renders NaN', () => {
    // Worker and browser clocks disagree by seconds routinely. relativeAgo floors
    // at 0, so this reads "just now"; the schedule must still be bounded.
    mount([NOW / 1000 + 120])
    expect(row(0)).toBe('just now')
    const at = renders
    // Still in the future after a minute of real time, so still "just now" — and
    // the wake-ups over that minute must be countable, not a spin.
    act(() => { vi.advanceTimersByTime(RELATIVE_TICK_MAX_MS) })
    expect(renders - at).toBeLessThan(5)
    expect(row(0)).toBe('just now')
    // Once it is genuinely in the past it ages normally, from the clock rather
    // than from whatever the skew was.
    act(() => { vi.advanceTimersByTime(RELATIVE_TICK_MAX_MS * 2) })
    expect(row(0)).toBe('1m ago')
  })
})

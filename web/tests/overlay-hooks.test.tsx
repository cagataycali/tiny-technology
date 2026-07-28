// @vitest-environment jsdom
/**
 * jsdom-lane fill-in (post-survey item 16): the two hooks EVERY overlay
 * shares — exit choreography (useOverlayExit) and the WCAG 2.4.3 Tab trap
 * (useFocusTrap). Their pure halves were already node-tested; this is the
 * DOM half that had no lane to run in before c13.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { useRef, type RefObject } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useOverlayExit } from '../lib/chat/use-overlay-exit'
import { useFocusTrap } from '../lib/chat/use-focus-trap'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ── useOverlayExit ──────────────────────────────────────────────────────────

type HookResult = ReturnType<typeof useOverlayExit>

// ⚠️ React 18 feature-detects `AnimationEvent` on window at listener setup —
// jsdom doesn't define it, so React registers webkit-prefixed names and a
// dispatched 'animationend' NEVER reaches onAnimationEnd here. Tests
// therefore call the hook's returned handler DIRECTLY with a synthetic-shaped
// event (the guard only reads target/currentTarget), and use fake timers for
// the failsafe path.
function Overlay({
  onClose,
  openerRef,
  classes,
  capture,
}: {
  onClose: () => void
  openerRef?: RefObject<HTMLElement | null>
  classes?: { enter: string; exit: string }
  capture?: (hook: HookResult) => void
}) {
  const hook = useOverlayExit(onClose, openerRef, classes)
  capture?.(hook)
  return (
    <div data-testid="panel" className={hook.exitClass}>
      <button data-testid="child">child</button>
      <button data-testid="dismiss" onClick={hook.requestClose}>x</button>
    </div>
  )
}

function renderOverlay(onClose: () => void, openerRef?: RefObject<HTMLElement | null>) {
  let hook: HookResult | undefined
  const utils = render(<Overlay onClose={onClose} openerRef={openerRef} capture={(h) => { hook = h }} />)
  const panel = screen.getByTestId('panel')
  const child = screen.getByTestId('child')
  const animEnd = (target: HTMLElement) =>
    act(() => { hook!.onAnimationEnd({ target, currentTarget: panel } as any) })
  return { ...utils, panel, child, animEnd, hook: () => hook! }
}

describe('useOverlayExit', () => {
  it('swaps enter → exit class when a close is requested', () => {
    render(<Overlay onClose={() => {}} />)
    const panel = screen.getByTestId('panel')
    expect(panel.className).toBe('animate-riseIn')
    fireEvent.click(screen.getByTestId('dismiss'))
    expect(panel.className).toBe('animate-riseOut')
  })

  it('supports the centered-overlay class pair', () => {
    render(<Overlay onClose={() => {}} classes={{ enter: 'animate-slideInUp', exit: 'animate-slideOutDown' }} />)
    fireEvent.click(screen.getByTestId('dismiss'))
    expect(screen.getByTestId('panel').className).toBe('animate-slideOutDown')
  })

  it("unmount-closes on the PANEL's own animationend and returns focus to the opener", () => {
    const onClose = vi.fn()
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    const o = renderOverlay(onClose, { current: opener })
    fireEvent.click(screen.getByTestId('dismiss'))
    o.animEnd(o.panel) // target === currentTarget: the panel's own exit
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it("ignores a CHILD's bubbled animationend — only the panel's exit unmounts", () => {
    const onClose = vi.fn()
    const o = renderOverlay(onClose)
    fireEvent.click(screen.getByTestId('dismiss'))
    o.animEnd(o.child) // bubbled: target !== currentTarget
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores the ENTER animation ending (not closing yet)', () => {
    const onClose = vi.fn()
    const o = renderOverlay(onClose)
    o.animEnd(o.panel) // closing is still false
    expect(onClose).not.toHaveBeenCalled()
  })

  it('the 350ms failsafe closes even when animationend never fires (display-toggled node)', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<Overlay onClose={onClose} />)
    fireEvent.click(screen.getByTestId('dismiss'))
    act(() => { vi.advanceTimersByTime(349) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('requestClose keeps a stable identity across renders (callers list it in effect deps)', () => {
    const seen: Array<() => void> = []
    const { rerender } = render(<Overlay onClose={() => {}} capture={(h) => seen.push(h.requestClose)} />)
    rerender(<Overlay onClose={() => {}} capture={(h) => seen.push(h.requestClose)} />)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen[0]).toBe(seen[seen.length - 1])
  })
})

// ── useFocusTrap ────────────────────────────────────────────────────────────

// jsdom has no layout: offsetParent is null for EVERYTHING, which would
// filter every focusable out of the trap. Shim it to "attached to a parent"
// for this suite — the visibility semantics it stands in for are a browser
// concern the node lane can't see anyway.
let offsetParentSpy: PropertyDescriptor | undefined
beforeAll(() => {
  offsetParentSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return (this as HTMLElement).parentElement },
  })
})
afterAll(() => {
  if (offsetParentSpy) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentSpy)
  else delete (HTMLElement.prototype as any).offsetParent
})

function Trapped({ count = 3, active = true }: { count?: number; active?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useFocusTrap(ref, active)
  return (
    <div ref={ref} data-testid="trap" tabIndex={-1}>
      {Array.from({ length: count }, (_, i) => (
        <button key={i} data-testid={`b${i}`}>b{i}</button>
      ))}
    </div>
  )
}

describe('useFocusTrap', () => {
  it('Tab on the LAST focusable wraps to the first', () => {
    render(<Trapped />)
    const last = screen.getByTestId('b2')
    last.focus()
    fireEvent.keyDown(screen.getByTestId('trap'), { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('b0'))
  })

  it('Shift+Tab on the FIRST focusable wraps to the last', () => {
    render(<Trapped />)
    screen.getByTestId('b0').focus()
    fireEvent.keyDown(screen.getByTestId('trap'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('b2'))
  })

  it('interior Tab moves are left to the browser (no forced jump)', () => {
    render(<Trapped />)
    const middleOrigin = screen.getByTestId('b0')
    middleOrigin.focus()
    fireEvent.keyDown(screen.getByTestId('trap'), { key: 'Tab' })
    // trapTarget returns null for an interior move; the hook must not have
    // moved focus itself (jsdom performs no native Tab navigation).
    expect(document.activeElement).toBe(middleOrigin)
  })

  it('non-Tab keys pass through untouched (Escape keeps closing overlays)', () => {
    render(<Trapped />)
    screen.getByTestId('b2').focus()
    fireEvent.keyDown(screen.getByTestId('trap'), { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByTestId('b2'))
  })

  it('zero focusables is a no-op, not a crash', () => {
    render(<Trapped count={0} />)
    const trap = screen.getByTestId('trap')
    trap.focus()
    expect(() => fireEvent.keyDown(trap, { key: 'Tab' })).not.toThrow()
  })

  it('inactive trap does nothing', () => {
    render(<Trapped active={false} />)
    const last = screen.getByTestId('b2')
    last.focus()
    fireEvent.keyDown(screen.getByTestId('trap'), { key: 'Tab' })
    expect(document.activeElement).toBe(last)
  })
})

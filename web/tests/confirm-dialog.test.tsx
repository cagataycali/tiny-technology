// @vitest-environment jsdom
/**
 * First suite of the jsdom component lane (backlog item 14) — ConfirmDialog,
 * the gate in front of EVERY destructive flow in the app. The exit
 * choreography (useOverlayExit) settles on the panel's animationend — jsdom
 * runs no animations, so tests fire it explicitly; the 350ms failsafe stays
 * untested real-time.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

// RTL auto-cleanup hooks into a global afterEach only when vitest runs with
// globals:true — this repo doesn't, so unmount explicitly between tests.
afterEach(() => { cleanup(); vi.useRealTimers() })
beforeEach(() => vi.useFakeTimers())
import { useConfirm, type ConfirmOptions } from '../components/chat/ConfirmDialog'

function Harness({ opts }: { opts: ConfirmOptions }) {
  const { confirm, dialog } = useConfirm()
  const [result, setResult] = useState('pending')
  return (
    <div>
      <button onClick={async () => setResult(String(await confirm(opts)))}>open</button>
      <output data-testid="result">{result}</output>
      {dialog}
    </div>
  )
}

function open(opts: ConfirmOptions) {
  render(<Harness opts={opts} />)
  const opener = screen.getByText('open')
  opener.focus() // the dialog captures document.activeElement as its opener
  fireEvent.click(opener)
  return { opener, panel: screen.getByRole('alertdialog') }
}

// The exit settles through useOverlayExit's 350ms FAILSAFE under fake timers.
// Not animationend: React 18 feature-detects AnimationEvent on window, jsdom
// lacks it, so React registers webkit-prefixed listeners and a dispatched
// animationend never reaches the handler (c16 finding — this suite originally
// "fired" the event and passed only because waitFor outlasted the failsafe).
async function settle(_panel: HTMLElement, expected: string) {
  await act(async () => { vi.advanceTimersByTime(350) })
  expect(screen.getByTestId('result').textContent).toBe(expected)
}

describe('ConfirmDialog', () => {
  it('renders an aria-modal alertdialog and resolves true on confirm', async () => {
    const { panel } = open({ message: 'Delete this job?', confirmLabel: 'Delete', danger: true })
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText('Delete this job?')).toBeTruthy()
    fireEvent.click(screen.getByText('Delete'))
    await settle(panel, 'true')
  })

  it('resolves false on Cancel', async () => {
    const { panel } = open({ message: 'Sure?' })
    fireEvent.click(screen.getByText('Cancel'))
    await settle(panel, 'false')
  })

  it('resolves false on Escape (capture phase — topmost surface consumes it)', async () => {
    const { panel } = open({ message: 'Sure?' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle(panel, 'false')
  })

  it('resolves false on a backdrop click', async () => {
    const { panel } = open({ message: 'Sure?' })
    fireEvent.click(document.querySelector('[class*="z-[110]"]')!)
    await settle(panel, 'false')
  })

  it('moves focus INTO the dialog on open and RETURNS it to the opener on close', async () => {
    const { opener, panel } = open({ message: 'Sure?' })
    expect(document.activeElement).toBe(panel) // aria-modal: focus enters
    fireEvent.click(screen.getByText('Confirm'))
    await settle(panel, 'true')
    // The docblock regression: confirm used to unmount without focus-return,
    // stranding keyboard/SR users at <body> on every destructive confirm.
    expect(document.activeElement).toBe(opener)
  })

  it('type-to-confirm: the confirm button stays disabled until the EXACT text matches', async () => {
    const { panel } = open({ message: 'Type the name to delete.', requireText: 'scout', confirmLabel: 'Delete forever' })
    const input = screen.getByLabelText('Type to confirm')
    expect(document.activeElement).toBe(input) // requireText focuses the input
    const button = screen.getByText('Delete forever') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'scou' } })
    expect(button.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'scout' } })
    expect(button.disabled).toBe(false)
    // Enter in the matched input accepts — same path as the button
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle(panel, 'true')
  })

  it('Enter in a NON-matching input does not accept', async () => {
    open({ message: 'Type it.', requireText: 'scout' })
    const input = screen.getByLabelText('Type to confirm')
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('alertdialog')).toBeTruthy() // still open
    expect(screen.getByTestId('result').textContent).toBe('pending')
  })
})

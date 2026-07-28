// @vitest-environment jsdom
/**
 * usePrintDetails (backlog v4 C6): printing must not drop tool payloads
 * and reasoning hidden in closed <details> — CSS can unclamp heights but
 * cannot open a disclosure. beforeprint opens all closed ones; afterprint
 * restores ONLY those, leaving user-opened disclosures alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { usePrintDetails } from '../lib/chat/use-print-details'

afterEach(cleanup)

function Page() {
  usePrintDetails()
  return (
    <div>
      <details data-testid="closed"><summary>tool input</summary>payload</details>
      <details data-testid="user-opened" open><summary>reasoning</summary>thoughts</details>
    </div>
  )
}

const fire = (type: string) => window.dispatchEvent(new Event(type))

describe('usePrintDetails', () => {
  it('opens closed details for print and restores exactly the prior state', () => {
    const { getByTestId } = render(<Page />)
    const closed = getByTestId('closed') as HTMLDetailsElement
    const userOpened = getByTestId('user-opened') as HTMLDetailsElement

    fire('beforeprint')
    expect(closed.open).toBe(true)      // payload reaches the paper
    expect(userOpened.open).toBe(true)

    fire('afterprint')
    expect(closed.open).toBe(false)     // back to closed
    expect(userOpened.open).toBe(true)  // the user's own state survives
  })

  it('a second print cycle works after the first restored', () => {
    const { getByTestId } = render(<Page />)
    const closed = getByTestId('closed') as HTMLDetailsElement
    fire('beforeprint'); fire('afterprint')
    fire('beforeprint')
    expect(closed.open).toBe(true)
    fire('afterprint')
    expect(closed.open).toBe(false)
  })

  it('unmount removes the listeners (no zombie print handlers)', () => {
    const { getByTestId, unmount } = render(<Page />)
    const closed = getByTestId('closed') as HTMLDetailsElement
    unmount()
    fire('beforeprint')
    expect(closed.open).toBe(false)
  })
})

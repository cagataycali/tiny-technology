// @vitest-environment jsdom
/**
 * Onboarding BYOK key field — masked by default with a reveal toggle
 * (ModelSettings pattern). It was the ONE key input in the app rendering
 * the secret as plain text, on the first-run surface most likely to be
 * shared or projected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import Onboarding from '../components/chat/Onboarding'

beforeEach(() => {
  localStorage.clear() // first visit: no onboarded flag, no config, no chats
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function openByok() {
  render(<Onboarding name="tiny" />)
  act(() => { vi.advanceTimersByTime(800) }) // the hero-paint delay
  fireEvent.click(screen.getByRole('button', { name: /Bring your own key/ }))
  return screen.getByLabelText('API key') as HTMLInputElement
}

describe('Onboarding API-key field', () => {
  it('masks the key by default', async () => {
    const input = await openByok()
    expect(input.type).toBe('password')
  })

  it('shows no reveal toggle until something is typed', async () => {
    await openByok()
    expect(screen.queryByLabelText('Show API key')).toBeNull()
  })

  it('reveals on demand — pasting blind makes typos undiscoverable', async () => {
    const input = await openByok()
    fireEvent.change(input, { target: { value: 'sk-test-123' } })
    const toggle = screen.getByLabelText('Show API key')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(input.type).toBe('text')
    expect(screen.getByLabelText('Hide API key').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByLabelText('Hide API key'))
    expect(input.type).toBe('password')
  })
})

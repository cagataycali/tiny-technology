// @vitest-environment jsdom
/**
 * /calls share button — it used to claim "✓ copied" unconditionally
 * (fire-and-forget writeText), lying on insecure contexts / denied
 * permission / older Safari. These pin: success announces, failure shows
 * AND announces, and no clipboard at all is a failure, not a lie.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import CallsPage from '../app/calls/page'

const SESSION = {
  ok: true,
  sessions: [{ id: 'c1', tiny_name: 'scout', status: 'ended', started_at: 1_753_000_000, duration_ms: 65_000, segment_count: 3 }],
}

// SiteHeader → TinyLogo reads matchMedia (reduced-motion); jsdom lacks it.
const fakeMatchMedia = () => ({
  matches: false,
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  addListener: vi.fn(), removeListener: vi.fn(),
}) as unknown as MediaQueryList

// Swap ONLY navigator.clipboard — replacing the whole navigator global would
// strip userAgent/language from jsdom for every other child component.
const setClipboard = (impl: { writeText: (t: string) => Promise<void> } | undefined) =>
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: impl })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => SESSION })))
  window.matchMedia = vi.fn(fakeMatchMedia) as unknown as typeof window.matchMedia
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderAndShare() {
  render(<CallsPage />)
  const button = await screen.findByLabelText('Copy share link for the call with scout')
  fireEvent.click(button)
  return button
}

describe('/calls loading skeleton', () => {
  it('shows content-shaped bones + an sr-only status while the list loads', async () => {
    // Never-resolving fetch = the loading state, frozen.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(<CallsPage />)
    expect(screen.getByText('Loading your call recordings…').className).toContain('sr-only')
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('Loading…')).toBeNull() // the bare text line is gone
  })

  it('swaps the skeleton out for the real rows', async () => {
    setClipboard({ writeText: vi.fn(async () => {}) })
    const { container } = render(<CallsPage />)
    await screen.findByLabelText('Copy share link for the call with scout')
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0)
    expect(screen.queryByText('Loading your call recordings…')).toBeNull()
  })
})

describe('/calls share', () => {
  it('confirms AND announces when the clipboard write succeeds', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText })
    const button = await renderAndShare()
    await waitFor(() => expect(button.textContent).toBe('✓ copied'))
    expect(writeText).toHaveBeenCalledWith('https://plugin.tiny.technology/voice/recording/c1')
    expect(screen.getByRole('status').textContent).toBe('Share link for the call with scout copied')
  })

  it('does NOT claim copied when the write rejects — shows and announces the failure', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error('denied') }) })
    const button = await renderAndShare()
    await waitFor(() => expect(button.textContent).toBe("⚠️ couldn't copy"))
    expect(button.textContent).not.toContain('copied')
    expect(screen.getByRole('status').textContent).toMatch(/Copy failed/)
  })

  it('treats a missing clipboard API (insecure context) as a failure, not a silent lie', async () => {
    setClipboard(undefined)
    const button = await renderAndShare()
    await waitFor(() => expect(button.textContent).toBe("⚠️ couldn't copy"))
  })

  it('keeps the sr-only live region mounted for AT', async () => {
    setClipboard({ writeText: vi.fn(async () => {}) })
    render(<CallsPage />)
    // Let the list settle first — while loading, the skeleton's own sr-only
    // status is also role="status" (c22), so query after the swap.
    await screen.findByLabelText('Copy share link for the call with scout')
    const region = screen.getByRole('status')
    expect(region.className).toContain('sr-only')
    expect(region.getAttribute('aria-live')).toBe('polite')
  })
})

// @vitest-environment jsdom
/**
 * FollowButton — the unfollow path's touch problem: the destructive
 * "Unfollow" label reveals on HOVER only, so a tap on "Following ✓"
 * unfollows with no pre-warning. The mitigation is an Undo action on the
 * unfollow toast (one-tap recovery, no confirm friction). sonner is mocked;
 * the captured action drives the re-follow assertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

// vi.mock factories hoist above imports — the spy must hoist with them.
const { toastSpy } = vi.hoisted(() => ({ toastSpy: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: toastSpy }))

import FollowButton from '../components/FollowButton'

function fetchStub(routes: { probeFollowing: boolean }) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    // Discriminate on the BODY, not on `init` being absent: every call carries
    // an init now that all three /api/follow fetches are deadlined (v7 F5), so
    // `if (!init)` would send the mount probe down the POST branch and throw on
    // JSON.parse(undefined).
    if (!init?.body) return { status: 200, json: async () => ({ ok: true, following: routes.probeFollowing }) }
    const body = JSON.parse(String(init.body))
    return { status: 200, json: async () => ({ ok: true, action: body.action }) }
  })
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FollowButton unfollow undo', () => {
  it('offers Undo on the unfollow toast, and Undo re-follows', async () => {
    const spy = fetchStub({ probeFollowing: true })
    vi.stubGlobal('fetch', spy)
    render(<FollowButton login="ada" />)
    const button = await screen.findByRole('button')
    expect(button.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('false'))
    const call = toastSpy.mock.calls.find((c) => c[0] === 'Unfollowed @ada')
    expect(call?.[1]?.action?.label).toBe('Undo')

    // The user taps Undo → a follow POST fires and state returns
    call![1].action.onClick()
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'))
    const followBodies = spy.mock.calls
      .filter((c) => (c[1] as RequestInit | undefined)?.body)
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).action)
    expect(followBodies).toEqual(['unfollow', 'follow'])
    expect(toastSpy).toHaveBeenCalledWith('Following @ada')
  })

  it('plain follow keeps the simple toast (no Undo)', async () => {
    vi.stubGlobal('fetch', fetchStub({ probeFollowing: false }))
    render(<FollowButton login="ada" />)
    const button = await screen.findByRole('button')
    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'))
    const call = toastSpy.mock.calls.find((c) => c[0] === 'Following @ada')
    expect(call?.[1]).toBeUndefined()
  })
})

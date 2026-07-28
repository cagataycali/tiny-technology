// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUTH_EVENT, authChangeOf, shouldRelock, authEvent } from '../lib/chat/auth-events'

/**
 * v6 E1 — login dispatched `tiny:auth` (with a comment explaining exactly why
 * a client-side session change must be announced); logout dispatched nothing.
 * So the shared whoami cache kept answering "authenticated" after sign-out,
 * and on a private tiny the revealed systemPrompt stayed on screen for someone
 * who had just signed out.
 */

describe('authChangeOf', () => {
  it('reads the direction off a CustomEvent', () => {
    expect(authChangeOf(authEvent('signed-in'))).toBe('signed-in')
    expect(authChangeOf(authEvent('signed-out'))).toBe('signed-out')
  })

  it('a BARE event still means signed-in — the historical meaning', () => {
    // Every listener that predates this module was written for a login-only
    // signal. A plain Event (or a hand-fired one, or a stray dispatch from
    // some future site) must not be read as a sign-out and revoke a vouch.
    expect(authChangeOf(new Event(AUTH_EVENT))).toBe('signed-in')
    expect(authChangeOf({})).toBe('signed-in')
    expect(authChangeOf(null)).toBe('signed-in')
    expect(authChangeOf(undefined)).toBe('signed-in')
  })

  it('a wrong-shaped detail is not a sign-out', () => {
    for (const detail of ['signed-out', 42, [], { change: 'nope' }, { changed: 'signed-out' }, null]) {
      expect(authChangeOf({ detail })).toBe('signed-in')
    }
  })
})

describe('shouldRelock', () => {
  it('only a sign-out closes a lock this tab already opened', () => {
    // The asymmetry IS the bug: signed-in asks "may I unlock?", signed-out
    // must revoke. Unlock is idempotent-safe; re-locking is not.
    expect(shouldRelock(authEvent('signed-out'))).toBe(true)
    expect(shouldRelock(authEvent('signed-in'))).toBe(false)
    expect(shouldRelock(new Event(AUTH_EVENT))).toBe(false)
    expect(shouldRelock(undefined)).toBe(false)
  })
})

describe('authEvent', () => {
  it('uses the one event name every existing consumer listens for', () => {
    expect(AUTH_EVENT).toBe('tiny:auth')
    expect(authEvent('signed-out').type).toBe('tiny:auth')
  })

  it('round-trips through a real dispatch', () => {
    // A plain EventTarget, not `window`: node-env vitest has CustomEvent but no
    // global event target, and the listener contract is identical.
    const bus = new EventTarget()
    const seen: string[] = []
    const onAuth = (e: Event) => seen.push(authChangeOf(e as CustomEvent))
    bus.addEventListener(AUTH_EVENT, onAuth)
    bus.dispatchEvent(authEvent('signed-in'))
    bus.dispatchEvent(authEvent('signed-out'))
    bus.removeEventListener(AUTH_EVENT, onAuth)
    expect(seen).toEqual(['signed-in', 'signed-out'])
  })
})

/**
 * The wiring is the fix; these pin it at the three sites so the asymmetry
 * can't silently return.
 */
describe('both directions are announced', () => {
  const repo = join(__dirname, '..')
  const authButton = readFileSync(join(repo, 'components/chat/AuthButton.tsx'), 'utf8')
  const chat = readFileSync(join(repo, 'components/chat/Chat.tsx'), 'utf8')

  it('logout dispatches, not just login', () => {
    // Bound the slice by the NEXT declaration, not a byte count: the original
    // `.slice(0, 900)` broke in c52 when logout grew a try/catch around its
    // fetch, even though the dispatch it checks for was still right there. The
    // intent (the sign-out path announces itself) is unchanged.
    const start = authButton.indexOf('const logout =')
    const logoutBody = authButton.slice(start, authButton.indexOf('const btnStyle', start))
    expect(logoutBody).toContain('authEvent("signed-out")')
    // ...and it must not be skippable by a throw from the network call above it.
    expect(logoutBody).toMatch(/catch/)
  })

  it('login still announces itself, via the same helper', () => {
    expect(authButton).toContain('authEvent("signed-in")')
    // The raw constructor is what made the two paths drift-prone.
    expect(authButton).not.toContain('new Event("tiny:auth")')
  })

  it("the private tiny's auth listener handles the sign-out branch", () => {
    expect(chat).toContain('shouldRelock')
    // A re-lock that left the stashed key behind would auto-unlock on the very
    // next probe — signing out means this browser stops vouching.
    const relock = chat.slice(chat.indexOf('shouldRelock(e as CustomEvent)'))
    expect(relock.slice(0, 800)).toContain('setIsAuthorized(false)')
    expect(relock.slice(0, 800)).toMatch(/removeItem\(`\$\{name\}:key`\)/)
  })

  it('the shared whoami cache already invalidates on this event', () => {
    // Pinned rather than changed: whoami listens to `tiny:auth` regardless of
    // direction, so emitting on logout is what makes its cache correct. If
    // that listener is ever narrowed to signed-in, this cycle's fix silently
    // stops working for every isAuthed() consumer.
    const whoami = readFileSync(join(repo, 'lib/chat/whoami.ts'), 'utf8')
    expect(whoami).toContain('addEventListener("tiny:auth"')
    expect(whoami).toMatch(/cached = null/)
  })
})

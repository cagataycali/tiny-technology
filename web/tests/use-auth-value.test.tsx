// @vitest-environment jsdom
/**
 * v6 E3 + E4 — the last two one-shot `whoami()` reads.
 *
 * c47 gave `tiny:auth` a direction and c48 made a dying session announce
 * itself, but these two consumers never listened: Chat's free-name claim
 * banner probed once per mount behind a ref latch, and ModelSettings' standing
 * line read the allowance once when the panel opened. So the banner that says
 * "sign in to claim it" kept saying it AFTER you signed in from that very link
 * (passkey login is client-side — no reload clears it), and an open Settings
 * panel kept quoting the anonymous free-tier number to a signed-in builder.
 *
 * The load-bearing property beyond "it re-reads": N hooks re-reading after ONE
 * event must still cost ONE /api/me. That's c12's invariant and the reason
 * whoami's cache exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Each test wants its own module registry (whoami's cache and its own
// `tiny:auth` listener are module-scope), so the hook is imported dynamically
// after resetModules.
type Hook = typeof import('../lib/chat/use-auth-value')['useAuthValue']

let probes: number
let meBody: unknown

function setup() {
  probes = 0
  meBody = { authenticated: false }
  vi.stubGlobal('fetch', vi.fn(async () => {
    probes++
    // Capture the body at RESOLVE time so a test can flip the server's answer
    // between the sign-in event and the re-read.
    const body = meBody
    return { ok: true, status: 200, json: async () => body } as any
  }))
}

async function load(): Promise<{ useAuthValue: Hook; authEvent: (c: 'signed-in' | 'signed-out') => Event }> {
  vi.resetModules()
  const { useAuthValue } = await import('../lib/chat/use-auth-value')
  // Import whoami through the SAME fresh registry so its module-eval
  // `tiny:auth` listener (the thing that clears the cache) is installed.
  await import('../lib/chat/whoami')
  const { authEvent } = await import('../lib/chat/auth-events')
  return { useAuthValue, authEvent: authEvent as any }
}

/** Flush the probe promise chain and React's resulting state update. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(setup)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('useAuthValue', () => {
  it('reads the shared probe on mount', async () => {
    const { useAuthValue } = await load()
    meBody = { authenticated: true, user: { login: 'me' } }
    function Probe() {
      const authed = useAuthValue((me) => !!me?.user)
      return <span data-testid="v">{String(authed)}</span>
    }
    render(<Probe />)
    // Before the probe resolves the answer is honestly unknown, not "signed out".
    expect(screen.getByTestId('v').textContent).toBe('null')
    await settle()
    expect(screen.getByTestId('v').textContent).toBe('true')
    expect(probes).toBe(1)
  })

  it('E3: a sign-in event re-reads — the claim banner stops offering sign-in', async () => {
    const { useAuthValue, authEvent } = await load()
    function Banner() {
      const authed = useAuthValue((me) => !!me?.user)
      return <span data-testid="v">{authed === false ? 'sign in to claim it' : 'send to claim it'}</span>
    }
    render(<Banner />)
    await settle()
    expect(screen.getByTestId('v').textContent).toBe('sign in to claim it')
    // The user takes the offer. Login is client-side, so this event is the only
    // signal the page gets.
    meBody = { authenticated: true, user: { login: 'me' } }
    await act(async () => { window.dispatchEvent(authEvent('signed-in')) })
    await settle()
    expect(screen.getByTestId('v').textContent).toBe('send to claim it')
  })

  it('E4: a sign-OUT event re-reads too, so a stale allowance cannot linger', async () => {
    const { useAuthValue, authEvent } = await load()
    meBody = { authenticated: true, user: { login: 'me' }, standing: { requests: 250 } }
    function Standing() {
      const s = useAuthValue((me) => (me as any)?.standing?.requests ?? null)
      return <span data-testid="v">{String(s)}</span>
    }
    render(<Standing />)
    await settle()
    expect(screen.getByTestId('v').textContent).toBe('250')
    // Sign-out (or c48's confirmed expiry, which dispatches the same event).
    meBody = { authenticated: false }
    await act(async () => { window.dispatchEvent(authEvent('signed-out')) })
    await settle()
    expect(screen.getByTestId('v').textContent).toBe('null')
  })

  it('c12 invariant: three consumers re-reading on ONE event cost ONE request', async () => {
    const { useAuthValue, authEvent } = await load()
    function Consumer() {
      const authed = useAuthValue((me) => !!me?.user)
      return <span>{String(authed)}</span>
    }
    render(<><Consumer /><Consumer /><Consumer /></>)
    await settle()
    expect(probes).toBe(1) // mount: the shared cache collapses all three
    await act(async () => { window.dispatchEvent(authEvent('signed-in')) })
    await settle()
    // If the hook forced {fresh:true}, this would be 4 — one round-trip per
    // consumer per auth change, exactly the waste whoami was written to kill.
    expect(probes).toBe(2)
  })

  it('`when: false` defers the read but NOT the subscription', async () => {
    const { useAuthValue, authEvent } = await load()
    function Gated({ on }: { on: boolean }) {
      const authed = useAuthValue((me) => !!me?.user, { when: on })
      return <span data-testid="v">{String(authed)}</span>
    }
    const { rerender } = render(<Gated on={false} />)
    await settle()
    expect(probes).toBe(0) // no free name previewed yet — nothing to ask about
    expect(screen.getByTestId('v').textContent).toBe('null')
    // Now a free name appears (E3's gate opens) and the probe fires.
    meBody = { authenticated: true, user: { login: 'me' } }
    rerender(<Gated on />)
    await settle()
    expect(probes).toBe(1)
    expect(screen.getByTestId('v').textContent).toBe('true')
  })

  it('unmounting removes the listener — a later event does not probe', async () => {
    const { useAuthValue, authEvent } = await load()
    function Consumer() {
      const authed = useAuthValue((me) => !!me?.user)
      return <span>{String(authed)}</span>
    }
    const { unmount } = render(<Consumer />)
    await settle()
    expect(probes).toBe(1)
    unmount()
    await act(async () => { window.dispatchEvent(authEvent('signed-in')) })
    await settle()
    expect(probes).toBe(1)
  })

  it('a failed probe reads as unknown, not as signed out', async () => {
    const { useAuthValue } = await load()
    // whoami's own catch turns a network failure into {authenticated:false};
    // this covers the layer above — a select() that throws must not paint a
    // confident wrong answer.
    function Consumer() {
      const v = useAuthValue(() => { throw new Error('bad shape') })
      return <span data-testid="v">{String(v)}</span>
    }
    render(<Consumer />)
    await settle()
    expect(screen.getByTestId('v').textContent).toBe('null')
  })

  it('re-renders do not tear down the subscription (select is an inline lambda)', async () => {
    const { useAuthValue, authEvent } = await load()
    const added: unknown[] = []
    const removed: unknown[] = []
    const origAdd = window.addEventListener.bind(window)
    const origRemove = window.removeEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((t: any, fn: any, o?: any) => {
      if (t === 'tiny:auth') added.push(fn)
      return origAdd(t, fn, o)
    })
    vi.spyOn(window, 'removeEventListener').mockImplementation((t: any, fn: any, o?: any) => {
      if (t === 'tiny:auth') removed.push(fn)
      return origRemove(t, fn, o)
    })
    function Consumer({ n }: { n: number }) {
      // A new closure every render — the ref is what keeps the effect stable.
      const authed = useAuthValue((me) => `${n}:${!!me?.user}`)
      return <span data-testid="v">{String(authed)}</span>
    }
    const { rerender } = render(<Consumer n={1} />)
    await settle()
    const afterMount = added.length
    rerender(<Consumer n={2} />)
    rerender(<Consumer n={3} />)
    await settle()
    expect(added.length).toBe(afterMount)
    expect(removed.length).toBe(0)
    // And the latest select is the one that runs on the next event.
    await act(async () => { window.dispatchEvent(authEvent('signed-in')) })
    await settle()
    expect(screen.getByTestId('v').textContent).toBe('3:false')
  })
})

describe('the two call sites', () => {
  const repo = join(__dirname, '..')
  const read = (f: string) => readFileSync(join(repo, f), 'utf8')

  it('Chat claimAuthed and ModelSettings standing both go through the hook', async () => {
    const chat = read('components/chat/Chat.tsx')
    expect(chat).toContain('useAuthValue')
    // The ref latch is the bug: it made the probe once-per-mount.
    expect(chat, 'claimProbeRef latched the probe forever — it must be gone').not.toContain('claimProbeRef')

    const settings = read('components/chat/ModelSettings.tsx')
    expect(settings).toContain('useAuthValue')
    // A bare whoami() read here is the E4 shape returning.
    expect(settings, 'standing must not go back to a one-shot whoami() read').not.toMatch(/whoami\(/)
  })
})

// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isAuthFailure, confirmsExpiry, shouldConfirmExpiry } from '../lib/chat/session-expiry'

/**
 * v6 E2 — c47 covered the user ENDING a session; a session can also just die
 * (cookie expires, revoked elsewhere). The HUDs' `401 → setLoggedIn(false)`
 * flipped only their own state, so `whoami`'s cache kept answering
 * authenticated and the page went half signed-in: the inbox says "sign in"
 * while the wallet badge and theme sync still act like an owner.
 */

describe('isAuthFailure', () => {
  it('is 401 and nothing else', () => {
    expect(isAuthFailure(401)).toBe(true)
    // 403 = authenticated but not allowed (someone else's tiny, revoked scope).
    // Treating it as expiry would sign a good session out for visiting a page.
    expect(isAuthFailure(403)).toBe(false)
    for (const s of [200, 204, 400, 404, 424, 429, 500, 502, 503, undefined]) {
      expect(isAuthFailure(s)).toBe(false)
    }
  })
})

describe('confirmsExpiry', () => {
  it('a live session is not expiry', () => {
    expect(confirmsExpiry({ authenticated: true })).toBe(false)
    expect(confirmsExpiry({ user: { login: 'me' } })).toBe(false)
    // Same predicate isAuthed applies, so the two can never disagree.
    expect(confirmsExpiry({ authenticated: false, user: { login: 'me' } })).toBe(false)
  })

  it('no user and not authenticated is expiry', () => {
    expect(confirmsExpiry({ authenticated: false })).toBe(true)
    expect(confirmsExpiry({})).toBe(true)
    expect(confirmsExpiry(null)).toBe(true)
  })

  it('an UNREACHABLE probe confirms nothing — it is not evidence about the session', () => {
    // v7: `probe()` degrades a timeout/offline to `{authenticated:false}`, which
    // is right for GATES (don't fetch the optional extras) and catastrophic for
    // CONFIRMATION — it would announce a sign-out because the confirmation's own
    // network failed, which is the exact bug "confirm, don't trust" prevents.
    expect(confirmsExpiry({ authenticated: false, unreachable: true })).toBe(false)
    // Only the flag exempts it; the plain signed-out answer still confirms.
    expect(confirmsExpiry({ authenticated: false, unreachable: false })).toBe(true)
  })
})

describe('shouldConfirmExpiry', () => {
  const fresh = { inFlight: false, settled: false }

  it('only a 401 asks a question', () => {
    expect(shouldConfirmExpiry(401, fresh)).toBe(true)
    expect(shouldConfirmExpiry(503, fresh)).toBe(false)
    expect(shouldConfirmExpiry(undefined, fresh)).toBe(false)
  })

  it('collapses the stampede — both HUDs poll, so one expiry fires several 401s', () => {
    expect(shouldConfirmExpiry(401, { inFlight: true, settled: false })).toBe(false)
  })

  it('asks nothing once expiry is already confirmed', () => {
    expect(shouldConfirmExpiry(401, { inFlight: false, settled: true })).toBe(false)
  })
})

/**
 * The plumbing: confirm-don't-trust, and the announcement that makes every
 * other consumer converge.
 */
describe('reportAuthFailure', () => {
  let dispatched: string[]
  let meBody: unknown
  let probes: number

  beforeEach(async () => {
    vi.resetModules()
    dispatched = []
    probes = 0
    meBody = { authenticated: false }
    const listeners: ((e: any) => void)[] = []
    vi.stubGlobal('window', {
      addEventListener: (_t: string, fn: (e: any) => void) => { listeners.push(fn) },
      removeEventListener: () => { },
      dispatchEvent: (e: any) => {
        dispatched.push(e?.detail?.change ?? 'bare')
        listeners.forEach((fn) => fn(e))
        return true
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      probes++
      return { ok: true, status: 200, json: async () => meBody } as any
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('confirms with a fresh probe, then announces the sign-out', async () => {
    const { reportAuthFailure, isSessionExpired } = await import('../lib/chat/whoami')
    reportAuthFailure(401)
    await new Promise((r) => setTimeout(r, 0))
    expect(probes).toBe(1)
    expect(dispatched).toEqual(['signed-out'])
    expect(isSessionExpired()).toBe(true)
  })

  it('a FALSE ALARM 401 does not sign a working user out', async () => {
    // The load-bearing case: these routes proxy a worker, so a hiccup (or a
    // route that 401s for its own reasons) must not be able to end a session
    // the server still considers live.
    meBody = { authenticated: true, user: { login: 'me' } }
    const { reportAuthFailure, isSessionExpired, isAuthed } = await import('../lib/chat/whoami')
    reportAuthFailure(401)
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatched).toEqual([])
    expect(isSessionExpired()).toBe(false)
    // And the cache was refreshed, so consumers read the true answer.
    await expect(isAuthed()).resolves.toBe(true)
  })

  it('several 401s in one expiry cost ONE probe', async () => {
    const { reportAuthFailure } = await import('../lib/chat/whoami')
    reportAuthFailure(401) // ActivityHUD
    reportAuthFailure(401) // MessagesHUD, milliseconds later
    reportAuthFailure(401) // next poll tick
    await new Promise((r) => setTimeout(r, 0))
    expect(probes).toBe(1)
    expect(dispatched).toEqual(['signed-out'])
  })

  it('ignores non-401 statuses entirely — no probe, no announcement', async () => {
    const { reportAuthFailure } = await import('../lib/chat/whoami')
    for (const s of [403, 429, 500, 503, undefined]) reportAuthFailure(s)
    await new Promise((r) => setTimeout(r, 0))
    expect(probes).toBe(0)
    expect(dispatched).toEqual([])
  })

  it('the announcement clears the shared cache, so isAuthed stops saying yes', async () => {
    const { reportAuthFailure, isAuthed } = await import('../lib/chat/whoami')
    // Warm the cache while the session is still believed live.
    meBody = { authenticated: true }
    await expect(isAuthed()).resolves.toBe(true)
    // Session dies server-side; a poll 401s.
    meBody = { authenticated: false }
    reportAuthFailure(401)
    await new Promise((r) => setTimeout(r, 0))
    await expect(isAuthed()).resolves.toBe(false)
  })

  it('signing back IN re-arms the latch for the next expiry', async () => {
    const { reportAuthFailure, isSessionExpired } = await import('../lib/chat/whoami')
    const { authEvent } = await import('../lib/chat/auth-events')
    reportAuthFailure(401)
    await new Promise((r) => setTimeout(r, 0))
    expect(isSessionExpired()).toBe(true)
    // A latch that never resets would ignore the SECOND expiry of a session.
    ;(globalThis as any).window.dispatchEvent(authEvent('signed-in'))
    expect(isSessionExpired()).toBe(false)
    meBody = { authenticated: false }
    reportAuthFailure(401)
    await new Promise((r) => setTimeout(r, 0))
    expect(probes).toBe(2)
  })
})

/**
 * v7 F5 — the probe itself had no deadline, and it is the CACHED one.
 *
 * Every `isAuthed()` gate in the app awaits this single memoised promise (Chat's
 * price badge, MapView, both HUDs, theme sync ×2, ModelSettings). An unanswered
 * /api/me therefore didn't fail those gates, it left them all pending forever —
 * and every later caller awaited the same dead promise. One hung request, the
 * whole authenticated surface dark, no error anywhere, unrecoverable without a
 * reload. Fixing the hang exposed two things the hang had been masking.
 */
describe('an unreachable probe', () => {
  let fetches: number
  let mode: 'reject' | 'ok'
  let meBody: unknown
  let dispatched: string[]

  beforeEach(() => {
    vi.resetModules()
    fetches = 0
    mode = 'reject'
    meBody = { authenticated: true, user: { login: 'me' } }
    dispatched = []
    const listeners: ((e: any) => void)[] = []
    vi.stubGlobal('window', {
      addEventListener: (_t: string, fn: (e: any) => void) => { listeners.push(fn) },
      removeEventListener: () => { },
      dispatchEvent: (e: any) => {
        dispatched.push(e?.detail?.change ?? 'bare')
        listeners.forEach((fn) => fn(e))
        return true
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      fetches++
      // The signal is what this whole cycle is about: a probe with none can
      // never reach the failure path at all.
      if (!init?.signal) throw new Error('probe fetched with no deadline')
      if (mode === 'reject') {
        throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })
      }
      return { ok: true, status: 200, json: async () => meBody } as any
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('resolves signed-out instead of hanging every gate forever', async () => {
    const { isAuthed } = await import('../lib/chat/whoami')
    // The assertion is that this SETTLES. Before the deadline it never did.
    await expect(isAuthed()).resolves.toBe(false)
  })

  it('is NOT memoised — the next poll gets a real retry', async () => {
    // The HUDs call isAuthed() on every poll tick, so caching one blip would
    // make it permanent: the same dead answer forever, which is the bug this
    // cycle fixes moved one layer up.
    const { isAuthed } = await import('../lib/chat/whoami')
    await expect(isAuthed()).resolves.toBe(false)
    expect(fetches).toBe(1)
    mode = 'ok'
    await expect(isAuthed()).resolves.toBe(true)
    expect(fetches).toBe(2)
  })

  it('a slow FAILURE does not discard the fresh probe that replaced it', async () => {
    // The cache-drop is identity-checked for this: AuthButton's post-action
    // refresh (or a `tiny:auth` clear) can start a second probe while the first
    // is still out. If the loser cleared the cache unconditionally on arrival,
    // it would throw away the winner's good answer and the next gate would
    // re-fetch — quietly undoing c12's one-probe bargain.
    const { whoami } = await import('../lib/chat/whoami')
    const slowFailure = whoami()          // probe #1: will reject (mode='reject')
    mode = 'ok'
    const fresh = whoami({ fresh: true }) // probe #2: replaces the cache, succeeds
    await expect(fresh).resolves.toMatchObject({ authenticated: true })
    await slowFailure                     // loser lands last
    expect(fetches).toBe(2)
    // The cache must still hold the WINNER, so this costs no third round-trip.
    await expect(whoami()).resolves.toMatchObject({ authenticated: true })
    expect(fetches, 'the late failure clobbered a good cached answer').toBe(2)
  })

  it('still caches a REAL answer — c12s one-probe-per-page bargain holds', async () => {
    mode = 'ok'
    const { isAuthed, whoami } = await import('../lib/chat/whoami')
    await expect(isAuthed()).resolves.toBe(true)
    await whoami()
    await whoami()
    expect(fetches, 'a successful probe must be spent once').toBe(1)
  })

  it('never signs a working user out because the CONFIRMATION timed out', async () => {
    // The second thing the hang was masking. reportAuthFailure forces a fresh
    // probe and announces on `confirmsExpiry`; a failed probe degrades to
    // `authenticated:false`, so without the unreachable flag a 401 arriving
    // during a network blip would tear down a live session — and `expirySettled`
    // would close the question, so the real answer never gets asked.
    const { reportAuthFailure, isSessionExpired } = await import('../lib/chat/whoami')
    reportAuthFailure(401)
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatched, 'a timed-out confirmation is not a sign-out').toEqual([])
    expect(isSessionExpired()).toBe(false)
    // ...and because nothing settled, the next 401 still gets a real attempt.
    mode = 'ok'
    meBody = { authenticated: false }
    reportAuthFailure(401)
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatched).toEqual(['signed-out'])
  })
})

describe('the 401 sites report', () => {
  it('both HUDs and the Telegram panel call reportAuthFailure', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const repo = join(__dirname, '..')
    for (const f of [
      'components/chat/ActivityHUD.tsx',
      'components/chat/MessagesHUD.tsx',
      'components/chat/TelegramSettings.tsx',
    ]) {
      const src = readFileSync(join(repo, f), 'utf8')
      expect(src, `${f} sees a 401 and must report it`).toContain('reportAuthFailure')
    }
  })
})

/**
 * Android's PROACTIVE half of the same idea: a stored 90-day token past its
 * expiry can only 401, so MainActivity routes to sign-in at launch instead of
 * letting every surface fail with network-looking errors.
 *
 * That gate is one comparison, and it used to live inline in a SharedPreferences
 * getter no unit test can construct — so inverting it (lock out every valid
 * session, wave through every expired one) left all four AuthManagerTest cases
 * green, because they only ever tested the PARSER. Proven: with the pre-fix
 * shape and the comparison inverted, gradle exits 0 with 9/9 passing.
 *
 * The decision is now a pure `isSessionExpired(expires, nowMs)` with its own
 * cases (AuthManagerTest). What no Kotlin test can assert is that the getter
 * still DELEGATES — re-inlining the comparison would restore the untestable
 * hole while every test stayed green. That's what this pins.
 */
describe('the Android launch gate stays testable (review c4)', () => {
  it('isSessionExpired is a pure function the getter delegates to', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    // Resolves through the web/android symlink.
    const src = readFileSync(
      join(process.cwd(), 'android/app/src/main/java/technology/tiny/app/auth/AuthManager.kt'),
      'utf8',
    )
    // The clock is a PARAMETER — that is the whole reason the branch is reachable.
    expect(src).toContain('fun isSessionExpired(expiresUnixSeconds: String?, nowMs: Long): Boolean')
    // The property delegates rather than re-deriving.
    expect(src).toContain(
      'get() = isSessionExpired(prefs.getString("expires", null), System.currentTimeMillis())',
    )
    // And no comparison against the wall clock survives outside that function:
    // `System.currentTimeMillis()` may only appear as the ARGUMENT.
    const clockUses = src.match(/System\.currentTimeMillis\(\)/g) ?? []
    expect(clockUses).toHaveLength(1)
    expect(src).not.toMatch(/[<>]=?\s*System\.currentTimeMillis\(\)/)
  })

  it('MainActivity still consults the gate', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(
      join(process.cwd(), 'android/app/src/main/java/technology/tiny/app/MainActivity.kt'),
      'utf8',
    )
    // A tested predicate nothing calls is decoration.
    expect(src).toContain('app.auth.isSessionExpired')
    expect(src).toContain('sessionExpired -> LoginScreen')
  })
})

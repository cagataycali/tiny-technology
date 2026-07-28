// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  QUICK_MS, EXTERNAL_MS, ROUTE_DEADLINE_MS, ROUTE_PREFIX_DEADLINE_MS,
  deadlineFor, exceedsServerBudget, isDeadlineError,
  classifyFetchFailure, failureMessage,
  DEADLINE_FLAG, isTaggedDeadline, fetchWithDeadline,
} from '../lib/deadlines'

/**
 * v7 F1 — a `fetch()` with no signal can stay pending forever, and every button
 * on this app guards itself with `if (busy) return` + a `.finally` that clears
 * the flag. So a hung worker doesn't just fail: it permanently disables the only
 * control that could recover. TelegramSettings learned this once; the MONEY
 * surfaces (withdraw, x402 approve, faucet, claim) never got the treatment, and
 * they're the ones whose stuck state reads "Signing and broadcasting…".
 *
 * The subtlety this file mostly exists to pin: our money routes run LONG on
 * purpose (withdraw maxDuration=60, x402/pay=180). A blanket 10s client cap
 * wouldn't fail fast — it would abort settlements mid-flight and report an
 * unknown outcome for payments that were about to succeed.
 */

const repo = join(__dirname, '..')
const read = (f: string) => readFileSync(join(repo, f), 'utf8')

describe('deadlineFor', () => {
  it('defaults to the house budget', () => {
    expect(deadlineFor('/api/prefs')).toBe(QUICK_MS)
    expect(deadlineFor('/api/anything-unlisted')).toBe(QUICK_MS)
  })

  it('keeps the default ABOVE the proxy cap the routes actually use', () => {
    // c51's headline finding: 66 internal worker fetches across 33 route files
    // are `AbortSignal.timeout(10_000)`. A 10s default would EQUAL them, which
    // exceedsServerBudget rejects — and the failure is a lie, not a fast fail.
    expect(QUICK_MS).toBeGreaterThan(10_000)
    expect(exceedsServerBudget(QUICK_MS, 10_000)).toBe(false)
  })

  it('gives the long-running money routes their own budget', () => {
    expect(deadlineFor('/api/wallet/withdraw')).toBe(75_000)
    expect(deadlineFor('/api/x402/pay')).toBe(195_000)
    expect(deadlineFor('/api/wallet/faucet')).toBe(45_000)
    expect(deadlineFor('/api/wallet')).toBe(35_000)
  })

  it('ignores a query string / hash when matching', () => {
    // Callers pass real URLs: `/api/graph?conflicts=1`, `/api/learnings?limit=500`.
    // Without stripping, every one of them would silently fall to the default —
    // which for /api/wallet would be a 15s cap on a 20s verification.
    expect(deadlineFor('/api/wallet?x=1')).toBe(35_000)
    expect(deadlineFor('/api/graph?conflicts=1')).toBe(QUICK_MS)
    expect(deadlineFor('/api/wallet#frag')).toBe(35_000)
  })

  it('resolves dynamic routes by prefix', () => {
    expect(deadlineFor('/api/x402/chat/some-slug')).toBe(330_000)
    expect(deadlineFor('/api/x402/chat/other?stream=1')).toBe(330_000)
  })

  it('prefers an exact match over a prefix', () => {
    // /api/x402/pay must not be captured by a broader x402 prefix.
    expect(deadlineFor('/api/x402/pay')).toBe(ROUTE_DEADLINE_MS['/api/x402/pay'])
  })
})

describe('exceedsServerBudget', () => {
  it('flags a client cap that would abort a working server', () => {
    expect(exceedsServerBudget(10_000, 60_000)).toBe(true)
  })

  it('treats EQUAL budgets as unsafe — a race the client can only lose badly', () => {
    // Losing that race is indistinguishable from a real timeout, so the user is
    // told "couldn't confirm" about a request the server answered.
    expect(exceedsServerBudget(60_000, 60_000)).toBe(true)
  })

  it('accepts a cap with real headroom', () => {
    expect(exceedsServerBudget(75_000, 60_000)).toBe(false)
  })
})

describe('isDeadlineError', () => {
  it('recognizes both spellings a timed-out fetch can reject with', () => {
    // AbortSignal.timeout rejects TimeoutError (undici); manual aborts and
    // older paths surface AbortError. Missing either makes a timeout fall into
    // a generic "network error" branch.
    expect(isDeadlineError({ name: 'TimeoutError' })).toBe(true)
    expect(isDeadlineError({ name: 'AbortError' })).toBe(true)
  })

  it('is not fooled by other failures or junk', () => {
    expect(isDeadlineError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isDeadlineError({ name: 'SyntaxError' })).toBe(false)
    expect(isDeadlineError(null)).toBe(false)
    expect(isDeadlineError(undefined)).toBe(false)
    expect(isDeadlineError('AbortError')).toBe(false)
  })
})

/**
 * v7 F3 — the auth/device/tool mutations. What makes these different from F1/F2
 * is that two of them bracket a step that ISN'T a fetch: the WebAuthn biometric
 * sheet. A user may stare at that prompt for a minute and that is not a failure,
 * so the deadline goes on the fetches either side of it and never around it.
 */
describe('classifyFetchFailure', () => {
  it('reads a dismissed biometric prompt as a cancel, not a failure', () => {
    // AuthButton had this as `if (e.name !== "NotAllowedError")` twice. Getting
    // it wrong means "Passkey login failed" toasted at someone who tapped
    // Cancel on purpose.
    expect(classifyFetchFailure({ name: 'NotAllowedError' })).toBe('cancelled')
  })

  it('never lets a cancel fall through to the error branch', () => {
    // The load-bearing property (verified by mutation: dropping the cancel
    // branch fails this and 2 more). An 'other' verdict is what produces a
    // "Passkey login failed" toast for a deliberate dismissal. The abort-ish
    // message is there because WebAuthn rejections carry one.
    for (const e of [
      { name: 'NotAllowedError' },
      Object.assign(new Error('The operation either timed out or was not allowed'), { name: 'NotAllowedError' }),
    ]) {
      expect(classifyFetchFailure(e)).not.toBe('other')
      expect(classifyFetchFailure(e)).toBe('cancelled')
    }
  })

  it('recognizes a real deadline and a real failure', () => {
    expect(classifyFetchFailure({ name: 'TimeoutError' })).toBe('timeout')
    expect(classifyFetchFailure({ name: 'AbortError' })).toBe('timeout')
    expect(classifyFetchFailure(new TypeError('Failed to fetch'))).toBe('other')
    expect(classifyFetchFailure(null)).toBe('other')
  })
})

describe('failureMessage', () => {
  it('says nothing about a cancel', () => {
    expect(failureMessage({ name: 'NotAllowedError' }, 'Login failed')).toBeNull()
  })

  it('never leaks the raw timeout text to the user', () => {
    // AbortSignal.timeout rejects with "signal timed out" / "The operation was
    // aborted" — so every `toast.error(e.message)` in the app becomes machine
    // noise the moment a deadline is added. That regression is the point here.
    const msg = failureMessage(
      Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }),
      'Login failed',
    )
    expect(msg).toBe('Timed out — check your connection and try again')
    expect(msg).not.toMatch(/signal|abort/i)
  })

  it('keeps a genuine error message, falling back when there is none', () => {
    expect(failureMessage(new Error('passkey unknown'), 'Login failed')).toBe('passkey unknown')
    expect(failureMessage({}, 'Login failed')).toBe('Login failed')
    expect(failureMessage(null, 'Login failed')).toBe('Login failed')
  })
})

describe('the auth / device / tool mutations are deadlined', () => {
  const SITES: [string, number][] = [
    ['components/chat/AuthButton.tsx', 5],
    // 4th = EndpointPanel's telemetry poll. The camera is deliberately NOT a
    // fetch (an <img src> the browser refetches), so it can't be counted here —
    // its bound is the worker's own image budget instead.
    ['app/devices/page.tsx', 4],
    ['components/ProfileToolCard.tsx', 2],
  ]

  for (const [file, count] of SITES) {
    it(`${file} deadlines all ${count} of its fetches`, () => {
      const lines = read(file).split('\n')
      const bare: string[] = []
      let seen = 0
      lines.forEach((l, i) => {
        if (!/\bfetch\(/.test(l)) return
        seen++
        if (!/signal:/.test(lines.slice(i, i + 14).join('\n'))) {
          bare.push(`${file}:${i + 1} ${l.trim().slice(0, 70)}`)
        }
      })
      expect(seen, `expected ${count} fetches in ${file} — the site list moved`).toBe(count)
      expect(bare, `deadline-less fetch behind a busy latch:\n${bare.join('\n')}`).toEqual([])
    })
  }

  it('never wraps the WebAuthn prompt itself in a deadline', () => {
    // The one thing this item must not do. startAuthentication/startRegistration
    // open the OS biometric sheet; a timeout there cancels a prompt the user is
    // actively looking at. Assert no signal/timeout on those lines.
    const lines = read('components/chat/AuthButton.tsx').split('\n')
    lines.forEach((l, i) => {
      if (/start(Authentication|Registration)\(/.test(l)) {
        expect(
          /AbortSignal|signal:/.test(l),
          `AuthButton.tsx:${i + 1} must not deadline the biometric prompt: ${l.trim()}`,
        ).toBe(false)
      }
    })
  })

  it('logout survives a server that never answers', () => {
    // It was a bare `await fetch` with no catch: a hang meant the lines below
    // never ran, so the menu kept showing the avatar of someone who had just
    // signed out. The local sign-out must happen regardless.
    const src = read('components/chat/AuthButton.tsx')
    const logout = src.slice(src.indexOf('const logout ='), src.indexOf('const btnStyle'))
    expect(logout).toMatch(/signal:\s*AbortSignal\.timeout\(/)
    expect(logout, 'a throw must not skip setMe/authEvent').toMatch(/catch/)
    expect(logout).toMatch(/setMe\(\{\s*authenticated:\s*false\s*\}\)/)
    expect(logout).toMatch(/authEvent\("signed-out"\)/)
  })

  it('no F3 surface renders a raw exception message any more', () => {
    // `toast.error(e.message)` / `String(err?.message)` would print "signal
    // timed out" verbatim once a deadline exists. Two of these files DID; the
    // third (devices) catches parameterlessly and writes its own copy, which is
    // equally correct — so assert the PROPERTY, not the import. Forcing
    // failureMessage into devices/page.tsx would be dead code.
    for (const [file] of SITES) {
      const src = read(file)
      expect(src, `${file} pipes a raw exception message to the UI`)
        .not.toMatch(/String\(err\?\.message|toast\.error\(e\.message/)
    }
    for (const f of ['components/chat/AuthButton.tsx', 'components/ProfileToolCard.tsx']) {
      expect(read(f), `${f} classifies its failures`).toContain('failureMessage(')
    }
  })
})

/**
 * v7 F4 — Chat's own fetches, plus the push pair in platform.ts and the
 * marketplace browse in slash-commands.
 *
 * What made this item different from F1–F3: two of these sites already had an
 * `AbortError` guard, and it was there for a reason that has nothing to do with
 * fetch. `navigator.share()` rejects with `AbortError` when the user dismisses
 * the OS sheet. So the naive fix — add a signal, keep the guard — converts a
 * real timeout into TOTAL silence, which is strictly worse than the raw message
 * c52 removed. Hence the tag: ask "was this MY deadline?", never "was this an
 * abort?".
 */
describe('a deadline is distinguishable from the user cancelling', () => {
  it('tags the rejection its own signal caused', async () => {
    // Stand in for a server that accepts and never answers: honour the signal
    // the helper passed and nothing else. If the helper ever stopped attaching
    // one, this hangs — which is exactly the bug, expressed as a test.
    const orig = globalThis.fetch
    let sawSignal = false
    let reason: unknown
    globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
      sawSignal = !!init?.signal
      init?.signal?.addEventListener('abort', () => {
        reason = (init.signal as AbortSignal).reason
        rej(reason)
      })
    })) as typeof fetch
    try {
      const err = await fetchWithDeadline('/api/prefs', { deadlineMs: 5 }).then(
        () => null,
        (e) => e,
      )
      expect(sawSignal, 'the helper must attach its own deadline signal').toBe(true)
      expect(isDeadlineError(err)).toBe(true)
      expect(isTaggedDeadline(err), 'the caller has no other way to know it was us').toBe(true)
      // Tagged in place, not replaced: `console.error("Share failed:", err)`
      // should still log the real abort reason with its real stack. Dropping the
      // in-place tag and always fabricating a substitute passes every other
      // assertion here, which is why this one is spelled out.
      expect(err, 'the original rejection must survive tagging').toBe(reason)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('leaves a non-deadline failure completely untouched', async () => {
    const boom = Object.assign(new Error('offline'), { name: 'TypeError' })
    const orig = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(boom)) as typeof fetch
    try {
      await expect(fetchWithDeadline('/api/prefs')).rejects.toBe(boom)
      expect(isTaggedDeadline(boom), 'a network error must not read as a timeout').toBe(false)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('a bare AbortError — the share-sheet dismissal — is NOT a tagged deadline', () => {
    // THE regression this whole mechanism exists to prevent. Chat's share catch
    // asks isTaggedDeadline first; if that returned true for any AbortError,
    // dismissing the OS share sheet would toast "couldn't share" at someone who
    // deliberately closed it.
    const dismissed = Object.assign(new Error('Share canceled'), { name: 'AbortError' })
    expect(isDeadlineError(dismissed), 'name-based checks cannot tell these apart').toBe(true)
    expect(isTaggedDeadline(dismissed)).toBe(false)
    expect(isTaggedDeadline({ [DEADLINE_FLAG]: true })).toBe(true)
    for (const junk of [null, undefined, 0, '', 'AbortError', { name: 'AbortError' }]) {
      expect(isTaggedDeadline(junk)).toBe(false)
    }
  })

  it('the share handler branches on the tag BEFORE the abort name', () => {
    const src = read('components/chat/Chat.tsx')
    const share = src.slice(src.indexOf('const handleShare ='))
    const body = share.slice(0, share.indexOf('\n  };'))
    expect(body, 'share create must carry a deadline').toContain('fetchWithDeadline("/api/share"')
    const tag = body.indexOf('isTaggedDeadline(')
    const abortName = body.indexOf("err.name !== 'AbortError'")
    expect(tag, 'the share catch must ask whose abort it was').toBeGreaterThan(-1)
    expect(abortName, 'the navigator.share cancel must still be silenced').toBeGreaterThan(-1)
    expect(tag, 'a timeout checked AFTER the AbortError guard is silently swallowed')
      .toBeLessThan(abortName)
  })
})

describe('the external-host budget', () => {
  it('names the number three surfaces had already chosen by hand', () => {
    expect(EXTERNAL_MS).toBe(10_000)
    // No maxDuration, no proxy cap: the client deadline IS the only budget, so
    // the equal-budget rule that forces QUICK_MS to 15s does not apply here.
    expect(EXTERNAL_MS).toBeLessThan(QUICK_MS)
  })

  it('no browser→plugin.tiny.technology call is left unbounded', () => {
    // These bypass our routes entirely, so nothing else can ever time them out.
    const files = ['components/chat/Chat.tsx', 'components/chat/CommandPalette.tsx',
      'components/chat/UniverseDrawer.tsx', 'components/Community.tsx',
      'lib/chat/slash-commands.ts']
    const bare: string[] = []
    for (const f of files) {
      const lines = read(f).split('\n')
      lines.forEach((l, i) => {
        if (!/fetch\(\s*[`'"]?https:\/\/plugin\.tiny\.technology/.test(l)) return
        if (!/signal:/.test(lines.slice(i, i + 10).join('\n'))) bare.push(`${f}:${i + 1}`)
      })
    }
    expect(bare, `cross-origin fetch with no deadline:\n${bare.join('\n')}`).toEqual([])
  })
})

describe("Chat's own fetches are deadlined", () => {
  it('every fetch in Chat.tsx carries a signal', () => {
    // Chat.tsx is the concurrent-session hotspot, so pin the PROPERTY rather
    // than a count — another session adding a fetch should fail here loudly
    // instead of quietly slipping past a stale number.
    const lines = read('components/chat/Chat.tsx').split('\n')
    const bare: string[] = []
    lines.forEach((l, i) => {
      if (!/\bfetch(WithDeadline)?\(/.test(l)) return
      if (/fetchWithDeadline\(/.test(l)) return   // deadline is inside the helper
      if (!/signal:/.test(lines.slice(i, i + 16).join('\n'))) bare.push(`Chat.tsx:${i + 1} ${l.trim().slice(0, 64)}`)
    })
    expect(bare, `deadline-less fetch in Chat.tsx:\n${bare.join('\n')}`).toEqual([])
  })

  it('the streaming turn keeps its OWN controller, not a deadline', () => {
    // /api/chat streams for up to 300s and the stop button aborts it manually.
    // A timeout here would kill a live reply mid-sentence; c32's streamOutcome
    // owns that surface.
    const src = read('components/chat/Chat.tsx')
    const at = src.indexOf('fetch("/api/chat"')
    expect(at).toBeGreaterThan(-1)
    const call = src.slice(at, at + 700)
    expect(call).toContain('signal: controller.signal')
    expect(call, 'a deadline must never race a stream').not.toContain('AbortSignal.timeout')
  })

  it('the budgets come from lib/deadlines, not literals', () => {
    const src = read('components/chat/Chat.tsx')
    for (const path of ['/api/prefs', '/api/visit', '/api/share', '/api/login', '/api/voice/tool']) {
      expect(src, `${path} should ask deadlineFor()`).toContain(`deadlineFor("${path}")`)
    }
  })

  it('the push pair cannot leave the enable toast spinning', () => {
    // platform.ts's whole contract is "never reject, always resolve {ok,reason}"
    // so AuthButton's loading toast clears — a fetch that never SETTLES breaks
    // that as thoroughly as a throw would.
    const lines = read('components/chat/platform.ts').split('\n')
    let seen = 0
    const bare: string[] = []
    lines.forEach((l, i) => {
      if (!/\bfetch\(/.test(l)) return
      seen++
      if (!/signal:/.test(lines.slice(i, i + 10).join('\n'))) bare.push(`platform.ts:${i + 1}`)
    })
    expect(seen, 'platform.ts fetch count moved').toBe(2)
    expect(bare, `deadline-less push fetch:\n${bare.join('\n')}`).toEqual([])
    // ...and the POST's failure copy must not become "signal timed out".
    expect(read('components/chat/platform.ts')).toContain('failureMessage(')
  })

  it('the voice tool reports a timeout in words the model can act on', () => {
    // This result string goes to the VOICE agent, not a user: String(e) would
    // hand it "TimeoutError: signal timed out" to read aloud.
    const src = read('components/chat/Chat.tsx')
    const at = src.indexOf('fetch("/api/voice/tool"')
    const call = src.slice(at, at + 600)
    expect(call).toContain('AbortSignal.timeout(')
    expect(call).toMatch(/timed out/)
  })
})

/**
 * v7 F5 — the last bare client fetches, and the one that mattered most was not
 * on the backlog line at all: `lib/chat/whoami.ts`'s probe. The survey recipe
 * filters on `"use client"`, and a shared lib module carries no directive, so
 * the scan that seeded this backlog was structurally blind to it.
 */
describe('no client fetch is left without a deadline', () => {
  /** Every client-reachable fetch call site, with whether it carries a signal. */
  const clientFetches = (): { at: string; deadlined: boolean }[] => {
    const found: { at: string; deadlined: boolean }[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(repo, d))) {
        if (e === 'node_modules' || e.startsWith('.')) continue
        const p = `${d}/${e}`
        if (statSync(join(repo, p)).isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(e)) continue
        const src = read(p)
        // ⚠️ NOT gated on "use client": that filter is exactly what hid the
        // whoami probe for three cycles. A module imported BY a client
        // component runs in the browser whether it says so or not.
        if (/^app\/api\//.test(p)) continue          // server routes have their own budgets
        const lines = src.split('\n')
        lines.forEach((l, i) => {
          if (!/\bfetch\(/.test(l)) return
          if (/fetchWithDeadline\(/.test(l)) return   // the deadline is inside the helper
          // Comment lines, not call sites — lib/deadlines.ts's own docblock
          // explains the rule using the words `fetch()` and matched itself.
          // (Same trap as c49/c52: a scan can't be narrated in prose.)
          if (/^\s*(\*|\/\/)/.test(l)) return
          // ⚠️ Window to the END of the fetch(...) call, found by BALANCING
          // parens — not a fixed line count and not the first `})`.
          // Control's /api/control POST has a 25-line body and IS deadlined:
          // a 16-line window called it bare, and a naive first-`})` scan
          // stopped inside the body before reaching `signal:`. Either way the
          // guard's verdict would depend on how the request body happens to be
          // shaped rather than on whether a deadline is there.
          const rest = lines.slice(i).join('\n')
          const open = rest.indexOf('fetch(') + 'fetch('.length - 1
          let depth = 0
          let end = rest.length
          for (let k = open; k < rest.length; k++) {
            if (rest[k] === '(') depth++
            else if (rest[k] === ')') { depth--; if (depth === 0) { end = k; break } }
          }
          found.push({ at: `${p}:${i + 1}`, deadlined: /signal:/.test(rest.slice(0, end)) })
        })
      }
    }
    for (const d of ['app', 'components', 'lib']) walk(d)
    return found
  }

  /**
   * The only fetches allowed to run unbounded, each with the reason. Anything
   * new fails here and has to be argued for.
   *
   * ⚠️ Most of this list is the SERVER side: `lib/chat/tools/*`, `model.ts`,
   * `user-tools.ts`, `bedrock-edge.ts` and `lib/auth.ts` run inside a route
   * (verified by their importers all being under `app/api/`), where the route's
   * own budget is the ceiling — a client deadline there would be meaningless.
   * Their real gap is a SERVER one and belongs to a different lens: c53 already
   * recorded that `/api/voice/tool` is unbounded precisely because
   * `lib/chat/tools/*` passes no signal. Noted, out of scope for a web-UI cycle.
   */
  const EXEMPT = [
    // maps-loop-owned: coordinate before touching (loop scope rule).
    'components/GlobalMapBackdrop.tsx', 'components/MapView.tsx',
    // Background enrichment with a null fallback; nothing waits on it.
    'lib/webllm.ts',
    // Server-side: run inside a route, under that route's budget.
    'lib/auth.ts', 'lib/reputation.ts', 'lib/standing.ts', 'lib/tiny-record.ts',
    'lib/bedrock-edge.ts', 'lib/user-tools.ts', 'lib/chat/model.ts', 'lib/chat/tools/',
  ]

  /**
   * Known-bare browser modules, found by THIS guard once it stopped filtering on
   * `"use client"`. Both run only in the browser (imported by Chat /
   * ModelSettings / Onboarding), so these are real instances of the v7 lens —
   * they are simply more than one cycle's work, and shipping a half-fixed file
   * is worse than shipping a counted one.
   *
   * The assertion is that this list may only SHRINK. A new bare fetch in either
   * file fails the count, so the debt is bounded while it's paid down.
   */
  const KNOWN_BARE: Record<string, number> = {
    'lib/chat/model-config.ts': 4,    // account-voice ×2, model-config ×2
    'lib/chat/slash-commands.ts': 14, // the command dispatch's worker calls
  }

  it('every client fetch outside the documented exemptions is deadlined', () => {
    const bare = clientFetches()
      .filter((f) => !f.deadlined)
      .filter((f) => !EXEMPT.some((x) => f.at.startsWith(x)))
      .filter((f) => !Object.keys(KNOWN_BARE).some((k) => f.at.startsWith(k)))
      .map((f) => f.at)
    expect(bare, `client fetch with no deadline:\n${bare.join('\n')}`).toEqual([])
  })

  it('the known-bare backlog only ever shrinks', () => {
    const counts: Record<string, number> = {}
    for (const f of clientFetches()) {
      if (f.deadlined) continue
      for (const k of Object.keys(KNOWN_BARE)) {
        if (f.at.startsWith(k)) counts[k] = (counts[k] || 0) + 1
      }
    }
    for (const [file, allowed] of Object.entries(KNOWN_BARE)) {
      const actual = counts[file] || 0
      expect(actual, `${file}: ${actual} bare fetches, budget ${allowed} — a NEW one was added`)
        .toBeLessThanOrEqual(allowed)
      // And when a cycle pays some down, the budget must come with it, or the
      // list stops meaning anything.
      expect(actual, `${file}: down to ${actual} — lower KNOWN_BARE to match`).toBe(allowed)
    }
  })

  it('the SHARED auth probe is deadlined — the worst possible site to miss', () => {
    // It's cached: every isAuthed() gate in the app awaits ONE memoised promise,
    // so an unanswered probe leaves them all pending forever and every later
    // caller inherits the same dead promise. A per-surface hang costs one
    // surface; this one costs the whole authenticated page, unrecoverably.
    const src = read('lib/chat/whoami.ts')
    expect(src).toMatch(/fetch\("\/api\/me",\s*\{\s*signal:/)
    expect(src, 'the budget comes from the table, not a literal').toContain('deadlineFor("/api/me")')
  })

  it('a failed probe is not cached, but a real answer is', () => {
    // Both HUDs call isAuthed() per poll tick, so memoising a timeout would make
    // one blip permanent — while memoising a real answer is c12's whole point.
    const src = read('lib/chat/whoami.ts')
    expect(src, 'an unreachable probe must drop the cache').toMatch(/unreachable\s*&&\s*cached === result/)
  })

  it('an unreachable probe cannot be read as proof the session died', () => {
    // `probe()` degrades a failure to authenticated:false, which is correct for
    // gates and would be a false sign-out for confirmation.
    expect(read('lib/chat/session-expiry.ts')).toMatch(/me\.unreachable/)
  })

  it('the page-level loads that own a skeleton or a status are deadlined', () => {
    for (const [file, path] of [
      ['app/calls/page.tsx', '/api/voice/sessions'],
      ['app/auth/cli/page.tsx', '/api/me'],
      ['app/auth/cli/page.tsx', '/api/auth/cli'],
    ] as const) {
      expect(read(file), `${file} → ${path}`).toContain(`deadlineFor("${path}")`)
    }
  })
})

/**
 * The load-bearing guard: read each route's OWN declared budget out of its
 * source and prove the client deadline sits above it. A future cycle that
 * lowers a client cap (or a route that raises maxDuration) fails here instead of
 * silently aborting live payments.
 */
describe('every client deadline outlives its route', () => {
  /** Every route file under app/api, with the budget it declares for itself. */
  const routeBudgets = (): { path: string; ms: number; how: string }[] => {
    const found: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(repo, d))) {
        const rel = `${d}/${e}`
        if (statSync(join(repo, rel)).isDirectory()) walk(rel)
        else if (/^route\.tsx?$/.test(e)) found.push(rel)
      }
    }
    walk('app/api')
    expect(found.length, 'no routes discovered — the walk is broken').toBeGreaterThan(20)

    return found.map((file) => {
      const src = read(file)
      const md = src.match(/export const maxDuration\s*=\s*(\d+)/)
      const internal = Array.from(src.matchAll(/AbortSignal\.timeout\((\d+)_?(\d*)\)/g))
        .map((mm) => Number(`${mm[1]}${mm[2]}`))
      const mdMs = md ? Number(md[1]) * 1000 : 0
      const inMs = internal.length ? Math.max(...internal) : 0
      return {
        // app/api/wallet/withdraw/route.ts → /api/wallet/withdraw
        path: '/' + file.replace(/^app\//, '').replace(/\/route\.tsx?$/, ''),
        ms: Math.max(mdMs, inMs),
        how: mdMs >= inMs && md ? `maxDuration=${md[1]}` : `internal ${inMs}ms`,
      }
    })
  }

  it('no route can outlast its client deadline', () => {
    // The exhaustive version of c50's hand-written table check. A route that
    // raises maxDuration, or a new long-running route, fails HERE instead of
    // silently aborting live work — and the fix is a ROUTE_DEADLINE_MS entry.
    const offenders: string[] = []
    for (const r of routeBudgets()) {
      if (r.ms === 0) continue // no declared budget to outlive
      const clientMs = deadlineFor(r.path)
      if (exceedsServerBudget(clientMs, r.ms)) {
        offenders.push(`${r.path} (${r.how}): client ${clientMs}ms <= server ${r.ms}ms`)
      }
    }
    expect(
      offenders,
      `these routes can outlast the client deadline, so the client reports a ` +
      `timeout for work the server finished. Add a ROUTE_DEADLINE_MS entry:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('every table entry still corresponds to a real route', () => {
    // A renamed/deleted route leaves a stale budget that silently applies to
    // nothing — and hides that its replacement fell back to the default.
    const paths = new Set(routeBudgets().map((r) => r.path))
    const stale = Object.keys(ROUTE_DEADLINE_MS).filter((p) => !paths.has(p))
    expect(stale, `stale deadline entries for routes that no longer exist: ${stale.join(', ')}`).toEqual([])
  })

  it('counts a budget INHERITED from a shared server helper', () => {
    // c51's walk only read route files, so a route that declares no timeout of
    // its own looked budget-free — when its real ceiling comes from the helper
    // it proxies through. /api/logout and the webauthn routes are exactly this:
    // no timeout in the route, 10s inside lib/auth.ts's internalInit.
    //
    // Derive the helper's budget from ITS source (not a literal here), then
    // prove every route importing it still has client headroom.
    const HELPERS: [string, string, RegExp][] = [
      ['lib/auth.ts', 'internalInit', /lib\/auth['"]/],
      ['lib/chat/tools/platform.ts', 'worker calls', /lib\/chat\/tools\/platform['"]/],
    ]

    const offenders: string[] = []
    for (const [helperFile, what, importRe] of HELPERS) {
      const budgets = Array.from(read(helperFile).matchAll(/AbortSignal\.timeout\((\d+)_?(\d*)\)/g))
        .map((mm) => Number(`${mm[1]}${mm[2]}`))
      expect(budgets.length, `${helperFile} declares no timeout — this guard is vacuous`).toBeGreaterThan(0)
      const helperMs = Math.max(...budgets)

      for (const r of routeBudgets()) {
        const src = read('app' + r.path + '/route.ts')
        if (!importRe.test(src)) continue
        const serverMs = Math.max(r.ms, helperMs)
        const clientMs = deadlineFor(r.path)
        if (exceedsServerBudget(clientMs, serverMs)) {
          offenders.push(`${r.path}: client ${clientMs}ms <= ${serverMs}ms (${what} in ${helperFile})`)
        }
      }
    }
    expect(
      offenders,
      `a route's real ceiling comes from the helper it proxies through, not just ` +
      `its own source:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('every prefix entry matches at least one dynamic route', () => {
    const paths = routeBudgets().map((r) => r.path)
    for (const prefix of Object.keys(ROUTE_PREFIX_DEADLINE_MS)) {
      expect(
        paths.some((p) => p.startsWith(prefix)),
        `prefix ${prefix} matches no route`,
      ).toBe(true)
    }
  })
})

/**
 * Tripwire: the money surfaces must keep their deadlines. These are exactly the
 * fetches whose absence strands a busy latch on an irreversible action.
 */
describe('the money fetches are deadlined', () => {
  const SITES: [string, string][] = [
    ['lib/x402/wallet-client.ts', 'walletAction / faucetClaim / getWallet'],
    ['app/wallet/page.tsx', 'withdraw'],
    ['components/chat/PayReceipt.tsx', 'approve + reQuote'],
  ]

  for (const [file, what] of SITES) {
    it(`${file} (${what}) passes a signal`, () => {
      const src = read(file)
      expect(src, `${what} must deadline its fetch`).toMatch(/signal:\s*AbortSignal\.timeout\(/)
    })
  }

  it('the long-budget sites take the number from lib/deadlines, not a literal', () => {
    // A hand-written 10_000 next to a 180s route is the bug; make the budget
    // come from the table the guard above checks.
    for (const f of ['app/wallet/page.tsx', 'components/chat/PayReceipt.tsx', 'lib/x402/wallet-client.ts']) {
      expect(read(f), `${f} should use deadlineFor()`).toContain('deadlineFor(')
    }
  })

  it('no money fetch hardcodes a cap below its route budget', () => {
    // The specific regression: `AbortSignal.timeout(10_000)` on a pay/withdraw
    // call. Catch the literal, since deadlineFor() is checked above.
    for (const f of ['app/wallet/page.tsx', 'components/chat/PayReceipt.tsx']) {
      const src = read(f)
      const lines = src.split('\n')
      lines.forEach((l, i) => {
        if (/AbortSignal\.timeout\(\s*\d/.test(l)) {
          throw new Error(`${f}:${i + 1} hardcodes a deadline literal on a money path: ${l.trim()}`)
        }
      })
    }
  })
})

/**
 * v7 F2 — the panels that own their own loading state. Each of these sets
 * `loading`/`sending`/`graph:"loading"` and clears it in a `.finally` or behind
 * a request token, so a fetch that never settles leaves a permanent spinner and
 * never reaches the retry branch that already exists below it.
 */
describe('the panel fetches are deadlined', () => {
  const PANELS: [string, number][] = [
    ['components/chat/MemoryPanel.tsx', 6],
    ['components/chat/JobsPanel.tsx', 2],
    ['components/chat/MessagesHUD.tsx', 4],
    ['components/chat/ActivityHUD.tsx', 1],
  ]

  for (const [file, count] of PANELS) {
    it(`${file} deadlines all ${count} of its fetches`, () => {
      const lines = read(file).split('\n')
      const bare: string[] = []
      let seen = 0
      lines.forEach((l, i) => {
        if (!/\bfetch\(/.test(l)) return
        seen++
        // The signal may sit a few lines down inside the init object.
        if (!/signal:/.test(lines.slice(i, i + 14).join('\n'))) {
          bare.push(`${file}:${i + 1} ${l.trim().slice(0, 70)}`)
        }
      })
      expect(seen, `expected ${count} fetches in ${file} — the site list moved`).toBe(count)
      expect(bare, `deadline-less fetch (permanent spinner on a hang):\n${bare.join('\n')}`).toEqual([])
    })
  }

  it('the panels take their budget from lib/deadlines, not a literal', () => {
    for (const [file] of PANELS) {
      expect(read(file), `${file} should use deadlineFor()`).toContain('deadlineFor(')
    }
  })
})

/**
 * Coverage census. Not "every fetch must be deadlined" — a fire-and-forget
 * beacon or an SSE stream legitimately has none — but the count must not GROW
 * silently, so a new deadline-less client fetch has to be looked at once.
 */
describe('client fetch deadline census', () => {
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(join(repo, d))) {
      if (e === 'node_modules' || e === '.next') continue
      const rel = `${d}/${e}`
      if (statSync(join(repo, rel)).isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(e)) files.push(rel)
    }
  }
  walk('components')
  walk('lib/x402')

  it('the money modules have no deadline-less fetch left', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (!/PayReceipt|WalletSheet|wallet-client|top-up/.test(f)) continue
      const lines = read(f).split('\n')
      lines.forEach((l, i) => {
        if (!/\bfetch\(/.test(l)) return
        const window = lines.slice(i, i + 14).join('\n')
        if (!/signal:/.test(window)) offenders.push(`${f}:${i + 1} ${l.trim().slice(0, 60)}`)
      })
    }
    expect(offenders, `deadline-less fetch on a money surface:\n${offenders.join('\n')}`).toEqual([])
  })
})

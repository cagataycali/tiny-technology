// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * lib/rate-limit — the shared per-IP daily guard (extracted from the
 * block once copy-pasted into chat/tiny/worker/control/login/share).
 * The contract that must not drift: skip without KV env, fail OPEN on
 * limiter errors, 429 with X-RateLimit-* headers when over.
 */
const limitMock = vi.fn()
vi.mock('@vercel/kv', () => ({ kv: {} }))
vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    limit = limitMock
    static slidingWindow = vi.fn(() => 'sliding-window')
  }
  return { Ratelimit }
})

import {
  enforceIpDailyLimit, reputationAllowance, reputationFor,
  REQUESTS_PER_POINT, MAX_REPUTATION_BONUS,
} from '../lib/rate-limit'
import { DEFAULT_REQUESTS_PER_DAY, FREE_TIER_ENV } from '../lib/free-tier'

const req = (ip = '1.2.3.4') =>
  new Request('https://tiny.technology/api/x', {
    headers: { 'x-forwarded-for': ip },
  })

/** The worker's internal /reputation, mocked at the fetch boundary. */
const stubScore = (score: number | null, opts: { ok?: boolean } = {}) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: opts.ok ?? true,
    json: async () => (score === null ? {} : { score }),
  })))

beforeEach(() => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'token')
  vi.stubEnv('INTERNAL_API_KEY', 'internal')
  // Pin the free-tier knob: almost every assertion below names 50 as the base
  // allowance, and that number is now env-tunable. An operator (or one of this
  // repo's own deployment shells) exporting it would turn a dozen tests red for
  // their env rather than for the code — the precedence trap tests/_deployment.ts
  // documents, one env var further down.
  vi.stubEnv(FREE_TIER_ENV, '')
  limitMock.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('enforceIpDailyLimit', () => {
  it('skips entirely without KV env (dev/CI parity)', async () => {
    vi.stubEnv('KV_REST_API_URL', '')
    expect(await enforceIpDailyLimit(req())).toBeNull()
    expect(limitMock).not.toHaveBeenCalled()
  })

  it('under the limit → null; key = prefix + client IP', async () => {
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    expect(await enforceIpDailyLimit(req('9.9.9.9'))).toBeNull()
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_9.9.9.9')
  })

  it('keys on the LEFTMOST XFF hop — not the whole spoofable chain', async () => {
    // x-forwarded-for is "client, proxy1, proxy2"; the real client is first.
    // Keying on the raw header would let a caller append/rotate downstream
    // hops to mint a fresh bucket per request.
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    await enforceIpDailyLimit(req('9.9.9.9, 10.0.0.1, 172.16.0.1'))
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_9.9.9.9')
  })

  it('missing XFF → "unknown", never the literal "null"', async () => {
    // A header-less request used to stringify to "null" and collapse every
    // such caller into one shared window; it now falls back to a stable label.
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    const noHeader = new Request('https://tiny.technology/api/x')
    await enforceIpDailyLimit(noHeader)
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_unknown')
  })

  it('over the limit → 429 text with X-RateLimit-* headers', async () => {
    limitMock.mockResolvedValue({ success: false, limit: 50, reset: 1234, remaining: 0 })
    const res = await enforceIpDailyLimit(req())
    expect(res?.status).toBe(429)
    expect(res?.headers.get('X-RateLimit-Limit')).toBe('50')
    expect(res?.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(res?.headers.get('X-RateLimit-Reset')).toBe('1234')
    expect(await res?.text()).toContain('request limit')
  })

  it('json variant (share) → JSON error body + custom prefix/limit', async () => {
    limitMock.mockResolvedValue({ success: false, limit: 20, reset: 1, remaining: 0 })
    const res = await enforceIpDailyLimit(req('8.8.8.8'), {
      requests: 20,
      keyPrefix: 'share_ratelimit_',
      message: 'Share limit reached for today.',
      json: true,
    })
    expect(res?.status).toBe(429)
    expect(res?.headers.get('Content-Type')).toBe('application/json')
    // The route's own sentence leads; the limiter appends what the caller can do
    // about it (share is cost:'platform', so signing in really does give this
    // anonymous caller their own 20/day window). See lib/limit-message.ts.
    const body = (await res?.json()).error as string
    expect(body.startsWith('Share limit reached for today.')).toBe(true)
    expect(body).toMatch(/signing in/i)
    expect(limitMock).toHaveBeenCalledWith('share_ratelimit_8.8.8.8')
  })

  it('limiter outage FAILS OPEN — a KV hiccup never takes the platform down', async () => {
    limitMock.mockRejectedValue(new Error('kv down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
    expect(await enforceIpDailyLimit(req())).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

/**
 * 🏅 REPUTATION → ALLOWANCE (loop item p-d). The login wall the user reported is
 * this window: a signed-in builder the network vouched for used to hit the same
 * 50/day ceiling as an anonymous scraper sharing their NAT.
 */
describe('reputationAllowance — the curve', () => {
  it('no standing changes nothing (the anonymous baseline is untouched)', () => {
    expect(reputationAllowance(50, 0)).toBe(50)
  })

  it('each point buys REQUESTS_PER_POINT extra requests', () => {
    expect(reputationAllowance(50, 10)).toBe(50 + 10 * REQUESTS_PER_POINT)
    expect(reputationAllowance(50, 1)).toBe(50 + REQUESTS_PER_POINT)
  })

  it('the bonus is CAPPED — a popular account is not an unbounded allowance', () => {
    // Reputation is earned from other people's gestures, but an uncapped curve
    // would make the most-followed account the cheapest DoS vector.
    expect(reputationAllowance(50, 1_000_000)).toBe(50 + MAX_REPUTATION_BONUS)
    const atCap = MAX_REPUTATION_BONUS / REQUESTS_PER_POINT
    expect(reputationAllowance(50, atCap)).toBe(50 + MAX_REPUTATION_BONUS)
    expect(reputationAllowance(50, atCap - 1)).toBeLessThan(50 + MAX_REPUTATION_BONUS)
  })

  it('is monotonic — more standing never means LESS room', () => {
    let prev = 0
    for (const score of [0, 1, 5, 10, 25, 50, 100, 500]) {
      const a = reputationAllowance(50, score)
      expect(a).toBeGreaterThanOrEqual(prev)
      prev = a
    }
  })

  it('junk scores degrade to the base allowance, never NaN or a shrink', () => {
    for (const junk of [NaN, undefined, null, -5, 'lots', Infinity] as any[]) {
      const a = reputationAllowance(50, junk)
      expect(Number.isFinite(a)).toBe(true)
      expect(a).toBeGreaterThanOrEqual(50)
    }
    // Infinity is junk, not a very high score: it falls to the BASE allowance
    // rather than the cap, so a corrupt read can't hand out the maximum.
    expect(reputationAllowance(50, Infinity)).toBe(50)
  })

  it('fractional points floor — no half-request allowances', () => {
    expect(reputationAllowance(50, 10.9)).toBe(50 + 10 * REQUESTS_PER_POINT)
  })
})

describe('reputationFor — reading standing can only ever HELP', () => {
  it('anon (no user id) never even calls the worker', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await reputationFor(null)).toBe(0)
    expect(await reputationFor(undefined)).toBe(0)
    expect(await reputationFor('')).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })

  it('reads the score over the internal-key channel', async () => {
    stubScore(35)
    expect(await reputationFor('u1')).toBe(35)
    const [url, init] = (globalThis.fetch as any).mock.calls[0]
    expect(url).toContain('/reputation?userId=u1')
    expect(init.headers['X-Internal-Key']).toBe('internal')
  })

  it('a worker error / non-ok / junk body → 0, i.e. the base limit', async () => {
    stubScore(50, { ok: false })
    expect(await reputationFor('u1')).toBe(0)
    stubScore(null)
    expect(await reputationFor('u1')).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('worker down') }))
    expect(await reputationFor('u1')).toBe(0)
  })

  it('a negative score cannot SHRINK anyone below the base', async () => {
    stubScore(-999)
    expect(await reputationFor('u1')).toBe(0)
  })
})

describe('enforceIpDailyLimit with a signed-in user', () => {
  it('keys the window to the USER, not the shared IP', async () => {
    // The NAT problem: every logged-in caller behind one office IP used to
    // share a single 50/day bucket.
    stubScore(0)
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    await enforceIpDailyLimit(req('9.9.9.9'), { userId: 'user-abc' })
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_u_user-abc')
  })

  it('the sliding window is BUILT with the reputation-widened allowance', async () => {
    const { Ratelimit } = await import('@upstash/ratelimit')
    stubScore(10)
    limitMock.mockResolvedValue({ success: true, limit: 100, reset: 0, remaining: 99 })
    await enforceIpDailyLimit(req(), { userId: 'u1' })
    // 50 base + 10 points × 5 = 100/day for one follower's worth of standing.
    expect(Ratelimit.slidingWindow).toHaveBeenLastCalledWith(50 + 10 * REQUESTS_PER_POINT, '1 d')
  })

  it('anonymous callers keep the IP key and the base allowance exactly', async () => {
    const { Ratelimit } = await import('@upstash/ratelimit')
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    await enforceIpDailyLimit(req('9.9.9.9'))
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_9.9.9.9')
    expect(Ratelimit.slidingWindow).toHaveBeenLastCalledWith(50, '1 d')
  })

  it('a 429 tells the builder their score, so earning room is discoverable', async () => {
    stubScore(20)
    limitMock.mockResolvedValue({ success: false, limit: 150, reset: 9, remaining: 0 })
    const res = await enforceIpDailyLimit(req(), { userId: 'u1' })
    expect(res?.status).toBe(429)
    expect(res?.headers.get('X-Reputation-Score')).toBe('20')
    expect(res?.headers.get('X-RateLimit-Limit')).toBe('150')
  })

  it('…and says it in WORDS too, because no client reads the header', async () => {
    // c37: the header was the only place we said this, and a grep across web,
    // iOS, Android and tiny-tech found it read by nothing — two of them can't
    // cheaply (ApiError.http carries a status alone; friendlyHttpError is a
    // status→string table). Branch-by-branch copy rules: tests/limit-message.
    stubScore(20)
    limitMock.mockResolvedValue({ success: false, limit: 150, reset: 9, remaining: 0 })
    const body = await (await enforceIpDailyLimit(req(), { userId: 'u1' }))!.text()
    expect(body).toContain('request limit')
    expect(body).toContain('150 requests a day')
    expect(body).toContain('20 points of reputation')
  })

  it("a cost:'others' 429 body stays exactly the route's sentence", async () => {
    // Mirrors the header's silence there: reputation buys nothing on a limit
    // that shields a third party, so the body must not advertise it either.
    stubScore(40)
    limitMock.mockResolvedValue({ success: false, limit: 50, reset: 9, remaining: 0 })
    const res = await enforceIpDailyLimit(req(), {
      userId: 'famous', cost: 'others', message: 'Too many visits today.',
    })
    expect(await res!.text()).toBe('Too many visits today.')
  })

  it('anon 429s carry NO reputation header (nothing to disclose)', async () => {
    limitMock.mockResolvedValue({ success: false, limit: 50, reset: 9, remaining: 0 })
    const res = await enforceIpDailyLimit(req())
    expect(res?.headers.get('X-Reputation-Score')).toBeNull()
  })

  it('a down worker still limits — at the base allowance, on the user key', async () => {
    const { Ratelimit } = await import('@upstash/ratelimit')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('worker down') }))
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    expect(await enforceIpDailyLimit(req(), { userId: 'u1' })).toBeNull()
    expect(Ratelimit.slidingWindow).toHaveBeenLastCalledWith(50, '1 d')
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_u_u1')
  })
})

/**
 * 💸 WHO PAYS decides whether identity may buy more of a limit (loop item
 * c8-followup). c8 widened the window for signed-in callers and wired it into
 * ONE route; the remaining six were never audited, and they are not all the same
 * kind of limit. Two of them shield a THIRD PARTY (another owner's private-tiny
 * key, another owner's notification ring) and one aims OUR egress at a stranger's
 * server. On those, a per-user key would be strictly WEAKER than the IP key it
 * replaced — accounts are free, so one attacker mints N windows — and reputation
 * is standing with the platform, not consent from the person being flooded.
 */
describe('cost — who pays decides whether identity buys room', () => {
  it("cost 'others' ignores userId entirely: IP key, base allowance, no worker call", async () => {
    const { Ratelimit } = await import('@upstash/ratelimit')
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    await enforceIpDailyLimit(req('9.9.9.9'), { userId: 'user-abc', cost: 'others' })
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_9.9.9.9')
    expect(Ratelimit.slidingWindow).toHaveBeenLastCalledWith(50, '1 d')
    // Not even READ: standing is irrelevant here, so the request must not pay
    // 2s of worst-case latency to fetch a number it will discard.
    expect(f).not.toHaveBeenCalled()
  })

  it("cost 'others' + a real score still gets the base allowance", async () => {
    // The regression this pins: someone adds `userId: session?.sub` to a
    // third-party-protecting route "for consistency" and silently hands a
    // popular account 250/day of reach over a stranger's notification ring.
    const { Ratelimit } = await import('@upstash/ratelimit')
    stubScore(40)
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    await enforceIpDailyLimit(req(), { userId: 'famous', cost: 'others' })
    expect(Ratelimit.slidingWindow).toHaveBeenLastCalledWith(50, '1 d')
  })

  it("cost 'others' 429s disclose no score (there is none to earn)", async () => {
    stubScore(40)
    limitMock.mockResolvedValue({ success: false, limit: 50, reset: 9, remaining: 0 })
    const res = await enforceIpDailyLimit(req(), { userId: 'famous', cost: 'others' })
    expect(res?.status).toBe(429)
    // Telling them their score here would advertise a lever that does nothing.
    expect(res?.headers.get('X-Reputation-Score')).toBeNull()
  })

  it("'platform' is the DEFAULT — an unmarked call keeps c8's behaviour", async () => {
    // The safe direction for a forgotten annotation is the one that only ever
    // spends our own resources.
    const { Ratelimit } = await import('@upstash/ratelimit')
    stubScore(10)
    limitMock.mockResolvedValue({ success: true, limit: 100, reset: 0, remaining: 99 })
    await enforceIpDailyLimit(req(), { userId: 'u1' })
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_u_u1')
    expect(Ratelimit.slidingWindow).toHaveBeenLastCalledWith(50 + 10 * REQUESTS_PER_POINT, '1 d')
  })

  it("cost 'others' with no session behaves exactly as before the flag existed", async () => {
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    await enforceIpDailyLimit(req('7.7.7.7'), { cost: 'others' })
    expect(limitMock).toHaveBeenCalledWith('novel_ratelimit_7.7.7.7')
  })
})

/**
 * ⚡ THE FREE-TIER KNOB (report §2.2, "raise/scope the 50/day default"). The wall
 * was a default parameter of this function, so the operator of a self-hosted
 * instance — whose model key and bill these requests spend — had no way to move
 * it. lib/free-tier.ts resolves the number; what's pinned here is the SCOPING,
 * which is the part that can go wrong quietly.
 */
describe('free-tier allowance — env-tunable, and only where we pay', () => {
  const window = async () => (await import('@upstash/ratelimit')).Ratelimit.slidingWindow

  it('a platform limit with no explicit `requests` follows the deployment', async () => {
    const slidingWindow = await window()
    vi.stubEnv(FREE_TIER_ENV, '500')
    limitMock.mockResolvedValue({ success: true, limit: 500, reset: 0, remaining: 499 })
    await enforceIpDailyLimit(req())
    expect(slidingWindow).toHaveBeenLastCalledWith(500, '1 d')
  })

  it('reputation still stacks ON TOP of the configured base', async () => {
    // The curve is a bonus, not a replacement: an operator who raises the wall to
    // 500 hasn't erased what standing earns, and a builder must never end up with
    // LESS room than the anonymous baseline they'd get by signing out.
    const slidingWindow = await window()
    vi.stubEnv(FREE_TIER_ENV, '500')
    stubScore(10)
    limitMock.mockResolvedValue({ success: true, limit: 550, reset: 0, remaining: 549 })
    await enforceIpDailyLimit(req(), { userId: 'u1' })
    expect(slidingWindow).toHaveBeenLastCalledWith(500 + 10 * REQUESTS_PER_POINT, '1 d')
  })

  it("does NOT widen a cost:'others' window — that is a brute-force budget", async () => {
    // The finding this pins. /api/tiny and /api/login are the private-tiny KEY
    // CHECK and /api/worker aims our egress at a stranger's server; all three
    // omit `requests` and would have inherited the knob. "Give my users more
    // chat" must not silently mean "give every guesser 10× the attempts at
    // another owner's private tiny" — same reasoning as LimitCost's refusal to
    // let reputation widen these.
    const slidingWindow = await window()
    vi.stubEnv(FREE_TIER_ENV, '5000')
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    await enforceIpDailyLimit(req(), { cost: 'others' })
    expect(slidingWindow).toHaveBeenLastCalledWith(DEFAULT_REQUESTS_PER_DAY, '1 d')
  })

  it("nor does it TIGHTEN one — a low free tier is not a stricter key-guess budget", async () => {
    // The mirror image, and the one that would have been a real regression on a
    // hobby instance: setting 5 to protect a personal OpenAI key would also have
    // cut the login/private-tiny window to 5/day/IP for every visitor.
    const slidingWindow = await window()
    vi.stubEnv(FREE_TIER_ENV, '5')
    limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
    await enforceIpDailyLimit(req(), { cost: 'others' })
    expect(slidingWindow).toHaveBeenLastCalledWith(DEFAULT_REQUESTS_PER_DAY, '1 d')
  })

  it('an explicit per-route `requests` beats the knob entirely', async () => {
    // share 20/day, visit 300/day, faucet 20/day are product decisions about
    // THOSE features, not statements about the free tier. A knob that silently
    // overrode them would turn "raise my chat limit" into "raise my share limit".
    const slidingWindow = await window()
    vi.stubEnv(FREE_TIER_ENV, '5000')
    limitMock.mockResolvedValue({ success: true, limit: 20, reset: 0, remaining: 19 })
    await enforceIpDailyLimit(req(), { requests: 20, keyPrefix: 'share_ratelimit_', json: true })
    expect(slidingWindow).toHaveBeenLastCalledWith(20, '1 d')
  })

  it('a broken env value keeps the wall at 50 rather than removing it', async () => {
    const slidingWindow = await window()
    for (const junk of ['lots', '0', '-10', 'Infinity']) {
      vi.stubEnv(FREE_TIER_ENV, junk)
      limitMock.mockResolvedValue({ success: true, limit: 50, reset: 0, remaining: 49 })
      await enforceIpDailyLimit(req())
      expect(slidingWindow).toHaveBeenLastCalledWith(DEFAULT_REQUESTS_PER_DAY, '1 d')
    }
  })

  it('the 429 reports the CONFIGURED limit, not a hardcoded 50', async () => {
    // X-RateLimit-Limit comes from the limiter's own reply, so this is really a
    // guard that the value we BUILD the window with is the value we enforce —
    // the invariant that "the key and the allowance change together" protects.
    vi.stubEnv(FREE_TIER_ENV, '500')
    limitMock.mockResolvedValue({ success: false, limit: 500, reset: 7, remaining: 0 })
    const res = await enforceIpDailyLimit(req())
    expect(res?.status).toBe(429)
    expect(res?.headers.get('X-RateLimit-Limit')).toBe('500')
  })
})

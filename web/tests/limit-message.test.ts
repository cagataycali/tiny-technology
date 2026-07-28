// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { limitMessage, CLIENT_MESSAGE_BUDGET } from '../lib/limit-message'
import { REQUESTS_PER_POINT, MAX_REPUTATION_BONUS } from '../lib/rate-limit-curve'

/**
 * 🏅 THE WALL'S OWN WORDS — the user-visible half of reputation→allowance.
 *
 * c8 shipped the curve and put the caller's score on the 429 as
 * `X-Reputation-Score`, with the stated goal that "get followed, get more room"
 * be "discoverable instead of folklore". A grep 29 cycles later found that
 * header read by **nothing**: not web, not iOS, not Android, not tiny-tech. Two
 * of them couldn't cheaply — `ApiError.http(Int)` carried a status code and
 * nothing else, and Android's `friendlyHttpError(code)` is a status→string table
 * — so all three showed some flavour of "daily limit reached, try again
 * tomorrow". The lever the entire curve exists to advertise was invisible at the
 * exact moment it mattered.
 *
 * iOS half now closed (review c16): `ApiError.http(Int, String?)` carries the
 * body's `error` string, and `Api.httpMessage` prefers it on every status the
 * app can't phrase better itself — 429 included. So the sentence composed here
 * is what an iPhone shows, not the static table line. Asserted below.
 *
 * What's pinned here is the copy rule set, because each branch is a claim that
 * can become false:
 *  - a `cost: 'others'` 429 must say NOTHING about reputation (it buys nothing
 *    there, by design — see LimitCost), mirroring the header's own silence;
 *  - at the cap, "earn more reputation" is a lie and must not be said;
 *  - the route's own sentence must survive web's 300-char truncation, so an
 *    explanation that wouldn't fit is dropped rather than allowed to push the
 *    refusal itself out of view.
 */

// `ios/` resolves through the web/ios symlink, so the path reads the same here
// as it did when web was the repo root.
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const base = {
  message: 'You have reached your request limit for the day.',
  base: 50,
  allowance: 50,
  score: 0,
  identified: false,
  lever: 'reputation' as const,
}

describe('limitMessage — the sentence a rate-limited caller actually reads', () => {
  it('always keeps the route’s own refusal first', () => {
    for (const opts of [
      base,
      { ...base, identified: true },
      { ...base, identified: true, score: 10, allowance: 100 },
      { ...base, identified: true, score: 999, allowance: 50 + MAX_REPUTATION_BONUS },
      { ...base, lever: 'none' as const },
    ]) {
      expect(limitMessage(opts).startsWith(base.message)).toBe(true)
    }
  })

  it('anonymous on a limit WE pay for → sign in, because the window is SHARED', () => {
    // The wall the user reported: an IP-keyed window is shared with everyone
    // behind the same office/campus/CGNAT egress. Signing in is an immediate
    // fix (a per-user key is a fresh window), and it's the door to the curve.
    const msg = limitMessage(base)
    expect(msg).toMatch(/signing in/i)
    expect(msg).toMatch(/shared|network/i)
    expect(msg).toMatch(/reputation/i)
  })

  it('signed in with no standing → names the curve and how it is earned', () => {
    const msg = limitMessage({ ...base, identified: true })
    expect(msg).toContain('50 requests a day')
    expect(msg).toContain(String(REQUESTS_PER_POINT))
    expect(msg).toContain(String(MAX_REPUTATION_BONUS))
    // "being followed is what pays" — following pays nothing (worker
    // reputation.ts), so the instruction has to be the one that works.
    expect(msg).toMatch(/followed/i)
    // Don't tell someone who IS signed in to sign in.
    expect(msg).not.toMatch(/signing in/i)
  })

  it('mid-curve → shows the split, so the earned part is visible', () => {
    const msg = limitMessage({ ...base, identified: true, score: 10, allowance: 100 })
    expect(msg).toContain('100 requests a day')
    expect(msg).toContain('50 free')
    expect(msg).toContain(`${10 * REQUESTS_PER_POINT} earned`)
    expect(msg).toContain('10 points of reputation')
    expect(msg).toMatch(/further point adds 5/)
  })

  it('AT THE CAP it stops asking for standing — the lever is spent', () => {
    // The branch that matters most: "earn more reputation" is something a user
    // could spend weeks acting on for zero effect.
    const msg = limitMessage({
      ...base, identified: true, score: 999, allowance: 50 + MAX_REPUTATION_BONUS,
    })
    expect(msg).toContain(`${50 + MAX_REPUTATION_BONUS} requests a day`)
    expect(msg).toMatch(/won't widen|will not widen/i)
    expect(msg).not.toMatch(/each further point/i)
  })

  it("a cost:'others' limit says NOTHING about reputation or signing in", () => {
    // Those limits shield a THIRD PARTY (another owner's private-tiny key, their
    // notification ring, a stranger's server on the far end of our fetch), so
    // they ignore userId and reputation on purpose. Advertising a lever that
    // does nothing there sends the user to earn followers for no effect — and
    // it's why the header stays absent on those 429s too.
    const msg = limitMessage({
      ...base, message: 'Too many visits today.', identified: true, score: 40, lever: 'none',
    })
    expect(msg).toBe('Too many visits today.')
    expect(msg).not.toMatch(/reputation|sign|follow/i)
  })

  it('follows the DEPLOYMENT’s free tier, not a hardcoded 50', () => {
    // lib/free-tier's knob resolves the base; the copy must quote what was
    // actually enforced (the c31/c30 bug: a correct number under stale words).
    const msg = limitMessage({ ...base, base: 500, allowance: 550, score: 10, identified: true })
    expect(msg).toContain('550 requests a day')
    expect(msg).toContain('500 free')
    expect(msg).not.toContain('50 free')
  })

  it('honours a per-route allowance (share 20/day) rather than the free tier', () => {
    const msg = limitMessage({
      ...base, message: 'Share limit reached for today.', base: 20, allowance: 20, identified: true,
    })
    expect(msg).toContain('20 requests a day')
  })

  it('count grammar is right at 1 — pluralize, never "1 requests"', () => {
    const one = limitMessage({ ...base, base: 1, allowance: 1, identified: true })
    expect(one).toContain('1 request a day')
    expect(one).not.toContain('1 requests')
    const onePoint = limitMessage({ ...base, base: 50, allowance: 55, score: 1, identified: true })
    expect(onePoint).toContain('1 point of reputation')
    expect(onePoint).not.toContain('1 points')
  })

  it('DROPS the explanation rather than let it truncate the refusal', () => {
    // Web wraps the body in `new Error(String(msg).slice(0, 300))`
    // (Chat.tsx:1316) — a longer message loses its TAIL, but a route whose own
    // sentence is already long would lose the part the user needs. So the
    // suffix is all-or-nothing.
    const long = 'x'.repeat(CLIENT_MESSAGE_BUDGET - 10)
    expect(limitMessage({ ...base, message: long, identified: true })).toBe(long)
  })

  it('every branch fits the client budget for realistic copy', () => {
    for (const opts of [
      base,
      { ...base, identified: true },
      { ...base, identified: true, score: 7, allowance: 85 },
      { ...base, identified: true, score: 500, allowance: 50 + MAX_REPUTATION_BONUS },
      { ...base, base: 1_000_000, allowance: 1_000_000 + MAX_REPUTATION_BONUS, score: 99, identified: true },
    ]) {
      expect(limitMessage(opts).length).toBeLessThanOrEqual(CLIENT_MESSAGE_BUDGET)
    }
  })

  it('junk numbers never produce NaN copy', () => {
    for (const junk of [NaN, Infinity, undefined, null, 'lots'] as any[]) {
      const msg = limitMessage({ ...base, identified: true, allowance: junk, base: junk, score: junk })
      expect(msg).not.toMatch(/NaN|Infinity|undefined|null/)
    }
  })

  it('an empty route message still yields a usable sentence', () => {
    const msg = limitMessage({ ...base, message: '', identified: true })
    expect(msg.trim().length).toBeGreaterThan(0)
    expect(msg).toMatch(/reputation/i)
  })
})

/**
 * The plumbing that makes the sentence REACH a user. The copy is only as good as
 * the field the clients render, and two of the three routes that quote this wall
 * were answering plain text into JSON-parsing callers.
 */
describe('the delivery path — wired where the clients actually look', () => {
  it('the limiter composes the body through limitMessage, not the raw message', () => {
    const rl = src('lib/rate-limit.ts')
    expect(rl).toContain('import { limitMessage }')
    expect(rl).toMatch(/limitMessage\(\{/)
    // Both variants must carry it — the JSON one is what native clients read.
    expect(rl).toMatch(/JSON\.stringify\(\{ error: body \}\)/)
    expect(rl).toMatch(/new Response\(body, \{ status: 429/)
  })

  it("the lever is derived from cost, so 'others' can't be talked into the curve", () => {
    expect(src('lib/rate-limit.ts')).toMatch(/lever: cost === 'platform' \? 'reputation' : 'none'/)
  })

  it('/api/chat asks for JSON — the shape iOS and Android prefer', () => {
    // Api.swift and TinyApi.kt both use a JSON `error` field when present and
    // fall back to their static status table otherwise. Plain text meant the
    // fallback, i.e. "daily limit reached — try again tomorrow".
    expect(src('app/api/chat/route.ts')).toMatch(/enforceIpDailyLimit\(req, \{ userId: session\?\.sub, json: true \}\)/)
  })

  it('iOS carries the 429 body all the way to the label (review c16)', () => {
    // JSON on the wire is only half of it: the client has to keep the body.
    // Api.request threw the status and DROPPED the response data, so this whole
    // suite's copy died one line inside the client.
    const api = src('ios/Tiny/Sources/Api.swift')
    expect(api).toContain('case http(Int, String?)')
    expect(api).toContain('throw ApiError.http(code, serverError(in: data))')
    // 429 must NOT be a status the app claims to phrase better than the server —
    // the whole point of the curve copy is that the server knows the numbers.
    const owns = api.slice(api.indexOf('func statusOwnsTheMessage'))
    const ownsBody = owns.slice(0, owns.indexOf('\n    }'))
    expect(ownsBody).not.toContain('429')
    // …and the SSE stream must not fork its own precedence rule (it used to be
    // a second copy of this decision, which is how the two tables diverged).
    expect(api).toContain('Self.httpMessage(status, serverMsg)')
  })

  it('/api/control asks for JSON — its caller parses unconditionally', () => {
    expect(src('app/api/control/route.ts')).toMatch(/enforceIpDailyLimit\(req, \{ userId: session\?\.sub, json: true \}\)/)
    // …and the caller reads the limiter's `error` field, not only its own `message`.
    expect(src('components/chat/Control.tsx')).toMatch(/data\.message \|\| data\.error/)
  })

  it('the curve constants live KV-free, so copy can import them', () => {
    // lib/rate-limit.ts imports @vercel/kv at module load; limit-message must
    // not drag a Redis client into anything that only needs two numbers.
    const curve = src('lib/rate-limit-curve.ts')
    expect(curve).not.toMatch(/^\s*import .*(@vercel\/kv|@upstash)/m)
    expect(src('lib/limit-message.ts')).not.toMatch(/^\s*import .*(@vercel\/kv|@upstash)/m)
    expect(src('lib/limit-message.ts')).toContain("from './rate-limit-curve'")
    // Re-exported so every existing `from './rate-limit'` import still resolves.
    expect(src('lib/rate-limit.ts')).toMatch(/export \{ REQUESTS_PER_POINT, MAX_REPUTATION_BONUS, reputationAllowance \}/)
  })
})

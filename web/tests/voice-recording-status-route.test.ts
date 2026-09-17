// @vitest-environment node
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'

beforeAll(() => {
  process.env.AUTH_JWT_SECRET = 'test-secret'
  process.env.INTERNAL_API_KEY = 'test-internal'
})

import { GET } from '../app/api/voice/recording-status/[id]/route'
import { issueSession } from '../lib/auth'

/**
 * /api/voice/recording-status/[id] — the route that exists FOR THE BODY, not the
 * bytes.
 *
 * `<audio src={WORKER}/voice/recording/:id>` streams cross-origin, which is
 * right — media elements need no CORS and get play/pause/seek for free. But the
 * worker's `json()` helper sets only Content-Type, so when that route DECLINES
 * (409 still live, 413 over the stitch cap, 404 nothing journaled, 424 no R2) the
 * browser can see that something failed and never what. This same-origin proxy
 * reads the refusal and hands it back.
 *
 * ⚠️ THIS SUITE EXISTS BECAUSE A MUTANT SURVIVED. `voice-playback-refusal.test.ts`
 * pinned the owner gate with a grep for `ownsVoiceSession(`, and a mutant that
 * disabled the check while leaving the call in place (`if (false && !owns…)`)
 * passed every pin — a grep cannot tell a live gate from a decorative one. The
 * route reports on a private voice record, so the gate is the whole posture:
 * without it, any signed-in caller learns whether a stranger's call exists, how
 * long it ran, and why it won't play.
 */

const auth = async (sub = 'owner') => `tiny_session=${await issueSession({ sub, login: sub })}`

const req = (id = 's1', cookie?: string) =>
  new Request(`https://tiny.technology/api/voice/recording-status/${id}`, {
    headers: cookie ? { cookie } : {},
  })

const params = (id = 's1') => ({ params: Promise.resolve({ id }) })

/**
 * Stand in for the worker. `session` is the metadata lookup's answer, `recording`
 * the ranged probe's. Returns the URLs actually requested, so a test can assert
 * the recording was never touched — "it 404'd" and "it never asked" are different
 * guarantees, and only the second one is not an oracle.
 */
function spyWorker(opts: { session?: any; recording?: Response } = {}) {
  const urls: string[] = []
  global.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url)
    urls.push(u)
    if (u.includes('/voice/session')) {
      return new Response(JSON.stringify(opts.session ?? { session: { user_id: 'owner' } }), { status: 200 })
    }
    expect(init?.headers?.Range, 'the probe fetched the recording without a Range header')
      .toBe('bytes=0-1')
    return opts.recording ?? new Response('ab', { status: 206 })
  }) as any
  return urls
}

const probed = (urls: string[]) => urls.some((u) => u.includes('/voice/recording/'))

afterEach(() => vi.restoreAllMocks())

describe('the owner gate', () => {
  it('an anonymous caller gets 401 and the worker is never touched', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    const res = await GET(req(), params())
    expect(res.status).toBe(401)
    expect(spy, 'an unauthenticated request reached the worker').not.toHaveBeenCalled()
  })

  it("⚠️ another account's call is not reported on, and is never probed", async () => {
    // The mutant that survived the grep: the gate present and inert. A stranger
    // must not learn that this recording exists, let alone why it won't play.
    const urls = spyWorker({
      session: { session: { user_id: 'someone-else' } },
      recording: new Response(JSON.stringify({ error: 'call too long to stitch' }), { status: 413 }),
    })
    const res = await GET(req('s1', await auth('intruder')), params())
    expect(res.status, "a stranger was told about another account's call").toBe(404)
    const body: any = await res.json()
    expect(body.error, 'the refusal leaked to a non-owner').not.toMatch(/stitch/)
    expect(probed(urls), 'the recording was probed for a caller who does not own it').toBe(false)
  })

  it('⚠️ a row with no stored owner belongs to nobody (fail closed)', async () => {
    // `ownsVoiceSession` refuses falsy owners — the exact bug /api/voice/replay
    // already paid for. A legacy row must not become everyone's.
    for (const user_id of [null, '', undefined, 0]) {
      const urls = spyWorker({ session: { session: { user_id } } })
      const res = await GET(req('s1', await auth('anyone')), params())
      expect(res.status, `a row owned by ${JSON.stringify(user_id)} was reported on`).toBe(404)
      expect(probed(urls), 'an ownerless row was probed').toBe(false)
    }
  })

  it('the owner does get an answer — the gate is not a wall', async () => {
    const urls = spyWorker()
    const res = await GET(req('s1', await auth('owner')), params())
    expect(res.status).toBe(200)
    expect(probed(urls), 'the owner was refused their own recording').toBe(true)
  })
})

describe('what it reports', () => {
  it('⚠️ a 206 from the ranged probe is SUCCESS, not a refusal', async () => {
    // The probe sends `Range: bytes=0-1`, so a recording that stitches fine
    // answers 206 — never 200. Treating only `ok` as success would report every
    // working recording as broken.
    spyWorker({ recording: new Response('ab', { status: 206 }) })
    const res = await GET(req('s1', await auth('owner')), params())
    const body: any = await res.json()
    expect(body.ok, 'a working recording (206) was reported as a refusal').toBe(true)
    expect(body.error, 'a working recording was given a cause').toBe(null)
  })

  it('the refusal comes back verbatim, with its status', async () => {
    // Untranslated on purpose: `playbackRefusal` translates at the surface, and
    // the raw reason stays available to a log.
    spyWorker({
      recording: new Response(JSON.stringify({ error: 'no audio journaled' }), { status: 404 }),
    })
    const res = await GET(req('s1', await auth('owner')), params())
    expect(res.status, 'the proxy turned the worker\'s refusal into its own').toBe(200)
    const body: any = await res.json()
    expect(body).toMatchObject({ ok: false, status: 404, error: 'no audio journaled' })
  })

  it('a refusal with no readable body still reports the status', async () => {
    // A 413 from an edge that answers HTML, say. The status alone is more than
    // the row had before, and 409 is translatable from it.
    spyWorker({ recording: new Response('<html>too big</html>', { status: 409 }) })
    const res = await GET(req('s1', await auth('owner')), params())
    const body: any = await res.json()
    expect(body).toMatchObject({ ok: false, status: 409, error: null })
  })

  it('⚠️ a probe that never answers is reported as unknown, not as a refusal', async () => {
    global.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('/voice/session')) {
        return new Response(JSON.stringify({ session: { user_id: 'owner' } }), { status: 200 })
      }
      throw new Error('network down')
    }) as any
    const res = await GET(req('s1', await auth('owner')), params())
    expect(res.status).toBe(200)
    const body: any = await res.json()
    // status 0 = we never heard back. `playbackRefusal(null, 0)` lands on the
    // generic sentence, which is the honest one.
    expect(body).toMatchObject({ ok: false, status: 0, error: null })
  })

  it('a missing session row is a 404, not a 200 saying nothing', async () => {
    spyWorker({ session: {} })
    const res = await GET(req('s1', await auth('owner')), params())
    expect(res.status).toBe(404)
  })
})

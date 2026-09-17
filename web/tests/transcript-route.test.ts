// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

const sessionMock = vi.fn()
vi.mock('@/lib/auth', () => ({ getSession: (...a: any[]) => sessionMock(...a) }))

import { POST, GET } from '../app/api/devices/transcript/route'

/**
 * /api/devices/transcript — the proxy the paired phone POSTs its transcript to
 * (relay-route.test.ts pattern). The invariants worth pinning:
 *   - device-credential auth, NO session: the phone may have nobody logged in
 *   - a spoofed userId in the body is never forwarded — the worker resolves
 *     the owner from the device token, so the field must not even travel
 *   - bad input is a 400 before the worker is touched; a worker 401 passes
 *     through as 401 (revoked device), everything else fails as 424
 */
const req = (body: string | object) =>
  new Request('https://tiny.technology/api/devices/transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

afterEach(() => vi.restoreAllMocks())

describe('POST /api/devices/transcript — device transcript passthrough', () => {
  it('forwards deviceId+token+text on device credentials alone — no session, no cookie', async () => {
    let sentUrl = ''
    let sentBody: any
    global.fetch = vi.fn(async (url: any, init: any) => {
      sentUrl = String(url)
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, id: 'tr-1' }), { status: 200 })
    }) as any
    const res = await POST(req({
      deviceId: 'd1', token: 'tind_x', text: 'buy milk tomorrow',
      label: 'wake: alexa', audioUrl: 'https://media.example/a.m4a', durationS: 12,
    }))
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('tr-1') // the phone needs the id for its relay reply
    expect(sentUrl).toContain('/transcript')
    expect(sentBody).toMatchObject({
      deviceId: 'd1', token: 'tind_x', text: 'buy milk tomorrow',
      label: 'wake: alexa', audioUrl: 'https://media.example/a.m4a', durationS: 12,
    })
  })

  it('a spoofed userId is NOT forwarded — the token resolves the owner', async () => {
    let sentBody: any
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, id: 'tr-2' }), { status: 200 })
    }) as any
    const res = await POST(req({ deviceId: 'd1', token: 't', text: 'hi', userId: 'HACKER' }))
    expect(res.status).toBe(200)
    expect(sentBody).not.toHaveProperty('userId')
  })

  it('missing token → 400, worker untouched', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    expect((await POST(req({ deviceId: 'd1', text: 'hi' }))).status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('blank text → 400 — an empty transcript is a client bug, not a row', async () => {
    const spy = vi.fn()
    global.fetch = spy as any
    expect((await POST(req({ deviceId: 'd1', token: 't', text: '   ' }))).status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('malformed body → 400, not a 500', async () => {
    global.fetch = vi.fn() as any
    expect((await POST(req('{invalid json'))).status).toBe(400)
  })

  it('bad token → 401 passthrough (revoked phone must learn to stop posting)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'unknown device' }), { status: 401 })) as any
    expect((await POST(req({ deviceId: 'd1', token: 'bad', text: 'hi' }))).status).toBe(401)
  })

  it('registry unreachable → 424', async () => {
    global.fetch = vi.fn(async () => { throw new Error('boom') }) as any
    expect((await POST(req({ deviceId: 'd1', token: 't', text: 'hi' }))).status).toBe(424)
  })
})

/**
 * 🎙️ GET /api/devices/transcript — the READ half, which had no test at all.
 *
 * Opposite auth to the POST above and worth pinning for it: the POST is a phone
 * writing as a DEVICE (token in body, no session), the GET is a signed-in human
 * asking for their own recordings. The userId MUST come from the session — taking
 * it from the query would make this an open read of anyone's transcripts, and
 * that mistake is invisible in the happy path because it returns exactly the same
 * shape.
 *
 * The `?id=` branch is the one with a consumer problem, see the iOS pins below:
 * the list route returns `substr(text, 1, 200) AS preview`, so full text is
 * reachable ONLY through this branch.
 */
const getReq = (qs = '') =>
  new Request(`https://tiny.technology/api/devices/transcript${qs}`)

describe('GET /api/devices/transcript — the read half', () => {
  afterEach(() => { sessionMock.mockReset(); vi.restoreAllMocks() })

  it('no session → 401, worker untouched (recordings are not public)', async () => {
    sessionMock.mockResolvedValue(null)
    const spy = vi.fn()
    global.fetch = spy as any
    expect((await GET(getReq())).status).toBe(401)
    expect(spy, 'unauthenticated read reached the worker').not.toHaveBeenCalled()
  })

  it('the userId is the SESSION\'s, never the query\'s', async () => {
    // The attack this blocks: ?userId=<someone else> on a valid session of mine.
    sessionMock.mockResolvedValue({ sub: 'me' })
    let sentUrl = ''
    global.fetch = vi.fn(async (url: any) => {
      sentUrl = String(url)
      return new Response(JSON.stringify({ ok: true, transcripts: [] }))
    }) as any
    await GET(getReq('?userId=victim&limit=5'))
    expect(sentUrl).toContain('userId=me')
    expect(sentUrl, 'a query userId reached the worker').not.toContain('victim')
  })

  it('?id= reads ONE in full; no id lists previews', async () => {
    sessionMock.mockResolvedValue({ sub: 'me' })
    const urls: string[] = []
    global.fetch = vi.fn(async (url: any) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ ok: true, transcript: { text: 'full' }, transcripts: [] }))
    }) as any
    await GET(getReq('?id=abc'))
    expect(urls[0]).toMatch(/\/transcript\?userId=me&id=abc/)
    await GET(getReq())
    expect(urls[1]).toMatch(/\/transcript\/list\?userId=me/)
  })

  it('a float/negative/Infinity limit cannot reach the worker\'s SQL LIMIT', async () => {
    sessionMock.mockResolvedValue({ sub: 'me' })
    const urls: string[] = []
    global.fetch = vi.fn(async (url: any) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ ok: true, transcripts: [] }))
    }) as any
    for (const bad of ['1.5', '-3', 'Infinity', 'abc', '9999']) {
      await GET(getReq(`?limit=${bad}`))
    }
    for (const u of urls) {
      const n = Number(new URL(u).searchParams.get('limit'))
      expect(Number.isInteger(n), `limit=${n} is not an integer`).toBe(true)
      expect(n).toBeGreaterThan(0)
      expect(n).toBeLessThanOrEqual(50)
    }
  })

  it('an outage is 424, NOT an empty list', async () => {
    // Collapsing a 5xx into [] tells the user they have never recorded anything.
    sessionMock.mockResolvedValue({ sub: 'me' })
    global.fetch = vi.fn(async () => { throw new Error('boom') }) as any
    const r = await GET(getReq())
    expect(r.status).toBe(424)
    expect((await r.json()).transcripts, 'an outage rendered as "no recordings"').toBeUndefined()
  })

  it('a missing id is 404, distinct from an outage', async () => {
    sessionMock.mockResolvedValue({ sub: 'me' })
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as any
    expect((await GET(getReq('?id=nope'))).status).toBe(404)
  })
})

/**
 * ⚠️ THE CONSUMER GAP. The `?id=` branch above works and nothing called it.
 *
 * `refreshFromServer()` stores the list route's `preview` as the row's `text` —
 * and `substr(text, 1, 200)` is 200 characters, while the server keeps up to
 * TRANSCRIPT_TEXT_MAX (16KB) and the memo button records 120 SECONDS. At a normal
 * speaking rate that take is ~1700 characters, so a refreshed row shows ~12% of
 * what was said, with no indication that the rest exists.
 *
 * This is yesterday's recorder bug on the READ path. That one captured 120s and
 * stored only the opening sentence; this one stores all of it and reads back only
 * the opening sentence. Same user-visible outcome — "my memo is missing" — and
 * the same reason it hid: the row looks like a complete short transcript, because
 * a truncated string and a short one are indistinguishable on screen.
 *
 * The code even documents the fix as already-planned ("a tap can fetch the full
 * text by id later"), which is the most convincing kind of evidence that nobody
 * did it: an intention in a comment reads as a feature when you skim.
 */
describe('the app can actually read back what the server kept', () => {
  const rec = readFileSync(new URL('../ios/Tiny/Sources/NiclaRecorder.swift', import.meta.url), 'utf8')

  it('something fetches ?id= — the full-text branch has a client', () => {
    expect(rec, 'no iOS caller passes ?id=, so full text is unreachable from the app')
      .toMatch(/devices\/transcript\?id=/)
  })

  it('a preview row is MARKED as partial, so the UI can tell', () => {
    // Without a flag the row cannot know whether to offer "read in full": text
    // that merely happens to be 200 chars is indistinguishable from truncation.
    expect(rec, 'NiclaTranscript has no truncation flag').toMatch(/var (isPreview|truncated)/)
  })

  it('the fetched full text REPLACES the preview and is persisted', () => {
    // A fetch that only updates a @State copy loses the text again on the next
    // launch, and re-fetches on every tap — the local index is the app's cache.
    const fn = rec.slice(rec.indexOf('func fetchFullText'))
    expect(fn.length, 'no fetchFullText — nothing upgrades a preview row').toBeGreaterThan(1)
    expect(fn.slice(0, 1400)).toMatch(/pruneAndSave\(\)/)
  })
})

/**
 * 🪞 ONE TAKE HAS TWO IDS, and only one of them names anything on the server.
 *
 * The phone mints a UUID per take and POSTs the take without it; the worker's
 * insert does its own `crypto.randomUUID()` and returns it as `{ok, id, created}`.
 * That split is correct server-side — a client-chosen primary key would let one
 * device overwrite another's row — but it makes the id the phone holds a purely
 * local name, and the phone was discarding the real one (`r["ok"] as? Bool == true`
 * and nothing more).
 *
 * Two failures, one cause, and the same three ids to blame:
 *   - `refreshFromServer` deduped on `Set(transcripts.map(\.id))`, so a row this
 *     phone recorded could never match its own server copy. Every synced take came
 *     back as a second row — and since server rows carry `audioFile: nil` and the
 *     200-char preview, the duplicate was the shorter, unplayable one. `.task` runs
 *     that refresh on every open of the list.
 *   - `?id=` (the branch above) and the relay reply's `transcriptId` both address
 *     the server by `t.id`. Under a local UUID they matched no row, so the "consumer
 *     gap" fix landed on an id that could not resolve, and the agent was handed a
 *     fetchable-looking id for a transcript it could never read.
 *
 * Pinned across all three layers, because the contract only holds end to end.
 */
describe('the id the worker files a transcript under is the id the phone keeps', () => {
  const rec = readFileSync(new URL('../ios/Tiny/Sources/NiclaRecorder.swift', import.meta.url), 'utf8')
  const wk = readFileSync(new URL('../worker/src/transcripts.ts', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../app/api/devices/transcript/route.ts', import.meta.url), 'utf8')

  it('the premise: the worker mints its own id and returns it', () => {
    // If the worker ever started honouring a client id, the phone's adoption
    // becomes a no-op rather than a bug — but the reply must still carry one.
    expect(wk).toMatch(/const id = crypto\.randomUUID\(\)/)
    expect(wk).toMatch(/ok: true, id/)
  })

  it('the proxy passes the id through instead of flattening the reply to {ok}', () => {
    // This route is the phone's only view of the worker. An `{ok: true}` here
    // would strand the id one hop short of the client that needs it.
    expect(route, 'the proxy drops the worker id, so the phone cannot adopt it')
      .toMatch(/ok: true, id: data\.id/)
  })

  it('the phone ADOPTS the returned id rather than checking ok and moving on', () => {
    const post = rec.slice(rec.indexOf('private func postToServer'))
    // Persisted, not just held in memory: index.json is what the next launch reads,
    // so an unsaved rewrite means the duplicate returns tomorrow. One regex, so the
    // save has to be on THIS path and not merely somewhere in the method.
    expect(post.slice(0, 2000), 'the POST reply id is discarded — every synced take will double')
      .toMatch(/transcripts = Self\.adoptFiling\(rows: transcripts, local: t\.id, server: sid\)\s*\n\s*pruneAndSave\(\)/)
  })

  it('adopting the id and recording that the row is FILED stay one call', () => {
    // These were two statements here, and the `filed` half sat where no test could
    // reach it: deleting it left all 19 tests green. The cost of losing it is not
    // cosmetic — an unfiled row is re-POSTed by syncUnfiled on the next refresh, and
    // the worker mints a fresh id per POST (pinned above), so every take doubles
    // server-side. So the pin is on the fold, not just on the rename: whatever
    // postToServer calls has to do BOTH, or a future split fails here.
    const fn = rec.slice(rec.indexOf('static func adoptFiling'))
    const body = fn.slice(0, fn.indexOf('\n    }\n'))
    expect(body, 'adoptFiling stopped taking the server id')
      .toMatch(/adoptServerId\(rows: rows, local: local, server: server\)/)
    expect(body, 'adoptFiling stopped recording that the row is filed')
      .toMatch(/\.filed = true/)
    // `local` first: after a successful rename no row carries it, so lookup falls
    // through to the renamed row — but when adoptServerId REFUSED, the local row is
    // the one whose POST landed. Reversed, that row stays unfiled forever and is
    // re-posted on every refresh. Swift's `??` is left-to-right, so the order in
    // the source IS the behaviour.
    expect(body.indexOf('$0.id == local'), 'the refused-rename path marks the wrong row')
      .toBeLessThan(body.indexOf('$0.id == server'))
  })

  it('the relay hands the agent the FILED id, not the local UUID', () => {
    // nicla_voice_record replies with {transcriptId} and the agent fetches by it.
    // The local UUID resolves to nothing, which reads as "the recording vanished".
    expect(rec).toMatch(/let filed = await postToServer\(entry\)/)
    expect(rec, 'the reply still carries the local UUID')
      .toMatch(/transcriptId: filed \?\? id/)
  })

  it('the refresh dedupes by CONTENT too, for the rows already on the phone', () => {
    // Adoption fixes takes from here on. Every transcript recorded before it sits
    // in index.json under a local UUID, so an id-only dedupe still doubles all of
    // them on the next open — the fix has to cover the history it inherits.
    const refresh = rec.slice(rec.indexOf('func refreshFromServer'))
    expect(refresh.slice(0, 2500), 'the merge is still a Set of ids')
      .toMatch(/mergeFetched\(local: transcripts, fetched: fetched\)/)
    expect(refresh.slice(0, 2500)).not.toMatch(/let known = Set\(transcripts\.map/)
    // And the content match cannot be text-only: two identical memos on different
    // days are two takes. See NiclaTranscriptMergeTests for the behaviour.
    const same = rec.slice(rec.indexOf('static func sameTake'))
    expect(same.slice(0, 900)).toMatch(/local\.label == server\.label/)
    expect(same.slice(0, 900)).toMatch(/local\.seconds == server\.seconds/)
    expect(same.slice(0, 900)).toMatch(/!server\.text\.isEmpty/)
  })
})

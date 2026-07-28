// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deadlineFor } from '../lib/deadlines'

/**
 * 📷 The printer's camera + telemetry on /devices.
 *
 * Two things make this different from every other panel on the page:
 *
 *  1. It serves BYTES FROM A MACHINE WE DON'T CONTROL back from our own origin.
 *     If the content-type were taken from the device, a dashboard answering
 *     text/html would execute as a same-origin document on tiny.technology with
 *     the session cookie that fetched it. Both layers pin the type independently.
 *
 *  2. It POLLS. The printer's own camera route is an endless multipart stream, so
 *     the only safe shape is repeated bounded requests — which means the polling
 *     must stop when nobody is looking, or an open background tab keeps calling
 *     someone's printer forever.
 */
const page = () => readFileSync(join(__dirname, '..', 'app', 'devices', 'page.tsx'), 'utf8')
const proxy = () => readFileSync(join(__dirname, '..', 'app', 'api', 'devices', 'endpoint', 'route.ts'), 'utf8')

/** Strip comments so a rule explained in prose can't satisfy a source assertion. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')

/** Just the panel component, comments stripped — never the whole page. */
const panelSrc = () => {
  const src = code(page())
  const start = src.indexOf('function EndpointPanel')
  expect(start, 'EndpointPanel was renamed or removed').toBeGreaterThan(-1)
  return src.slice(start, src.indexOf('\nexport default'))
}

/** The panel's two polling effects, split apart so each is asserted on its own. */
const effects = () => {
  const parts = panelSrc().split(/useEffect\(\(\) => \{/).slice(1)
  expect(parts.length, 'expected a telemetry poll and a camera poll').toBe(2)
  return parts
}

describe('/api/devices/endpoint — the read proxy', () => {
  const KEY = 'test-internal-key'
  let calls: Array<{ url: string; init: any }>
  let route: any

  const load = async () => {
    process.env.INTERNAL_API_KEY = KEY
    vi.doMock('@/lib/auth', () => ({ getSession: async () => ({ sub: 'user_1' }) }))
    return await import('../app/api/devices/endpoint/route')
  }

  const stub = (respond: () => Response) => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      calls.push({ url: String(url), init })
      return respond()
    }))
  }

  const get = (qs: string) => route.GET(new Request(`https://tiny.technology/api/devices/endpoint?${qs}`))

  beforeEach(async () => {
    vi.resetModules()
    route = await load()
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('@/lib/auth') })

  it('passes a camera frame through, pinned and uncacheable', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    stub(() => new Response(jpeg, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }))
    const res: Response = await get('deviceId=dev_1&action=snapshot')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('refuses to hand a non-image type to an <img> on our origin', async () => {
    // Second lock on the same door as the worker's: a future worker change must
    // not silently turn this route into an HTML sink.
    for (const evil of ['text/html', 'image/svg+xml', 'application/javascript']) {
      stub(() => new Response('<script>alert(1)</script>', { status: 200, headers: { 'Content-Type': evil } }))
      const res: Response = await get('deviceId=dev_1&action=snapshot')
      expect(res.status, evil).toBe(502)
      expect(res.headers.get('content-type'), evil).toMatch(/application\/json/)
    }
  })

  it('takes userId from the SESSION, never the query string', async () => {
    // The worker scopes the device lookup by owner, so this is the whole reason
    // one user can't read another's camera by guessing a device id.
    stub(() => new Response('{"ok":true,"result":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await get('deviceId=dev_1&action=telemetry&userId=someone-else')
    const body = JSON.parse(calls[0].init.body)
    expect(body.userId).toBe('user_1')
  })

  it('will not forward chat — a 90s agent turn is not a read', async () => {
    // A GET that could trigger it would let any page hold a worker for a minute.
    stub(() => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const res: Response = await get('deviceId=dev_1&action=chat&prompt=hi')
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
    const body: any = await res.json()
    expect(body.error).toMatch(/unsupported action/i)
  })

  it('refuses an unknown action without spending a worker call', async () => {
    stub(() => new Response('{}', { status: 200 }))
    for (const action of ['print', 'drive', '../admin', 'camera/stream']) {
      const res: Response = await get(`deviceId=dev_1&action=${encodeURIComponent(action)}`)
      expect(res.status, action).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it('preserves the worker\'s typed failure distinctions', async () => {
    // Collapsing these to one error is exactly how a busy printer gets reported
    // as unplugged, or an expired token sends the owner to check cables.
    const cases: Array<[string, string]> = [
      ['{"error":"x","unreachable":true}', 'unreachable'],
      ['{"error":"x","timeout":true}', 'timeout'],
      ['{"error":"x","unauthorized":true}', 'unauthorized'],
    ]
    for (const [payload, flag] of cases) {
      stub(() => new Response(payload, { status: 502, headers: { 'Content-Type': 'application/json' } }))
      const body: any = await (await get('deviceId=dev_1&action=telemetry')).json()
      expect(body[flag], flag).toBe(true)
      expect(body.ok).toBe(false)
    }
  })

  it('requires a session and a deviceId', async () => {
    stub(() => new Response('{}', { status: 200 }))
    const res: Response = await get('action=telemetry')
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)

    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ getSession: async () => null }))
    const anon = await import('../app/api/devices/endpoint/route')
    const out: Response = await anon.GET(new Request('https://tiny.technology/api/devices/endpoint?deviceId=d&action=telemetry'))
    expect(out.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('reports an unreachable worker as retryable, not as a device fault', async () => {
    stub(() => { throw new Error('connect ETIMEDOUT') })
    const res: Response = await get('deviceId=dev_1&action=telemetry')
    expect(res.status).toBe(503)
    expect((await res.json() as any).retryable).toBe(true)
  })

  it('sits above the worker so the worker\'s typed answer wins the race', () => {
    // Same ordering rule the use_device tool follows: if this side gave up first
    // we'd turn a typed unreachable/timeout into an untyped abort.
    const src = proxy()
    const n = (s: string) => Number(s.replace(/_/g, ''))
    const snapMs = n((src.match(/snapshot:\s*\{[^}]*ms:\s*(\d[\d_]*)/) || [])[1] || '0')
    const teleMs = n((src.match(/telemetry:\s*\{[^}]*ms:\s*(\d[\d_]*)/) || [])[1] || '0')
    expect(snapMs).toBeGreaterThan(10_000)  // worker's image budget
    expect(teleMs).toBeGreaterThan(20_000)  // worker's plain-read budget
    // And the page's client deadline must clear the widest of them.
    expect(deadlineFor('/api/devices/endpoint')).toBeGreaterThan(Math.max(snapMs, teleMs))
  })
})

describe('the /devices live panel', () => {
  it('polls only while the tab is visible', () => {
    // A backgrounded page must not keep calling someone's printer. Both timers
    // gate on document.hidden and refresh on return, matching the presence poll
    // already on this page.
    // ⚠️ Counting `document.hidden` across the whole panel does NOT test this:
    // the string appears 4× (two ticks + two visibilitychange handlers), so
    // deleting a tick's gate still clears any threshold. Anchor PER EFFECT, and
    // require the gate to come BEFORE that effect's side effect.
    effects().forEach((eff, i) => {
      const gate = eff.indexOf('document.hidden')
      expect(gate, `effect ${i} has no visibility gate`).toBeGreaterThan(-1)
      const work = Math.min(
        ...['fetch(', 'setFrameSrc('].map((s) => (eff.indexOf(s) < 0 ? Infinity : eff.indexOf(s))),
      )
      expect(work, `effect ${i} does no polling?`).toBeLessThan(Infinity)
      expect(gate, `effect ${i} polls before checking visibility`).toBeLessThan(work)
      // A gate with no re-arm means the panel stays frozen after tabbing back.
      expect(eff, `effect ${i} never refreshes on return`).toContain('visibilitychange')
      // And every interval must be torn down, or an unmounted row keeps polling.
      expect(eff, `effect ${i} leaks its interval`).toContain('clearInterval')
      expect(eff, `effect ${i} leaks its listener`).toContain('removeEventListener')
    })
  })

  it('only endpoint devices poll anything at all', () => {
    // The page is used by people with no robots; their rows must make no extra
    // requests. The panel is rendered behind a kind check, not for every row.
    const src = code(page())
    expect(src).toMatch(/d\.kind === "endpoint" && <EndpointPanel/)
  })

  it('busts the cache per frame — otherwise the image never changes', () => {
    // no-store alone doesn't help: an identical URL means the browser has no
    // reason to refetch, so the "live" view would freeze on frame one.
    const panel = code(page())
    expect(panel).toMatch(/action=snapshot&t=\$\{Date\.now\(\)\}/)
  })

  it('keeps the last good reading when a tick fails', () => {
    // Blanking the panel on one failed poll makes a working machine look broken.
    const panel = panelSrc()
    // The failure branch sets a note; it must NOT null the telemetry state.
    expect(panel).not.toMatch(/setTelemetry\(null\)/)
    // And the three failures are told apart, same as the tool path.
    for (const w of ['unauthorized', 'timeout', 'unreachable']) {
      expect(panel, `failure ${w} must have its own copy`).toContain(w)
    }
  })

  it('does not claim a camera for a device that has none', () => {
    // A device with no camera capability should render telemetry only, rather
    // than a permanently-failing image box.
    const panel = panelSrc()
    expect(panel).toMatch(/hasCamera/)
    expect(panel).toMatch(/if \(!hasCamera\) return/)
  })

  it('guards the async gap so an unmounted row never writes state', () => {
    // Per-effect again: one effect declaring `alive` says nothing about the other.
    effects().forEach((eff, i) => {
      expect(eff, `effect ${i} has no alive flag`).toMatch(/let alive = true/)
      expect(eff, `effect ${i} never clears it on cleanup`).toMatch(/alive = false/)
      expect(eff, `effect ${i} never reads it`).toMatch(/!alive/)
    })
  })

  it('reads a robot\'s payload defensively', () => {
    // The telemetry shape is whatever the machine answered. One malformed field
    // must not blank the panel or render "undefined°".
    const src = code(page())
    const rows = src.slice(src.indexOf('const TELEMETRY_ROWS'), src.indexOf('function EndpointPanel'))
    // Every numeric field is finite-checked before it's formatted, so a robot
    // answering `null` or `"--"` drops that row instead of printing NaN°.
    expect((rows.match(/Number\.isFinite/g) || []).length).toBeGreaterThanOrEqual(4)
    // And the capability list is parsed inside a try — it's a JSON *string* from
    // the DB, so a malformed one must mean "no capabilities", not a crashed page.
    const caps = src.slice(src.indexOf('const hasCap'), src.indexOf('const TELEMETRY_ROWS'))
    expect(caps).toMatch(/try \{/)
    expect(caps).toMatch(/catch \{/)
  })
})

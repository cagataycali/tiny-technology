// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('device-transcribe')

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))

import { POST } from '../app/api/devices/transcribe/route'

/**
 * /api/devices/transcribe — speech-to-text for every device input point
 * (device-ask-route.test.ts pattern). Invariants pinned here:
 *   - device-credential auth, NO session; a spoofed userId never travels
 *   - bad input is a 400 before the worker is touched
 *   - worker 400/401/404/422 pass through with their sentence; the rest 424
 * And on the worker handler:
 *   - only this worker's own /media/<uuid>.<ext> URLs are accepted
 *   - the audio must be the device OWNER'S upload: someone else's key reads
 *     exactly like a missing one (404, same sentence), and no audio is read
 *   - no agent turn runs: the only outbound call is the STT request
 */
const req = (body: string | object) =>
  new Request('https://tiny.technology/api/devices/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const realFetch = global.fetch
afterEach(() => {
  vi.restoreAllMocks()
  global.fetch = realFetch
})

describe('POST /api/devices/transcribe — device STT passthrough', () => {
  it('forwards deviceId+token+audioUrl on device credentials alone; text comes back', async () => {
    let sentUrl = ''
    let sentBody: any
    global.fetch = vi.fn(async (url: any, init: any) => {
      sentUrl = String(url)
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, text: 'on my way' }), { status: 200 })
    }) as any
    const res = await POST(req({ deviceId: 'd1', token: 'tind_x', audioUrl: 'https://m/a.wav', userId: 'HACKER' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, text: 'on my way' })
    expect(sentUrl).toContain('/device/transcribe')
    expect(sentBody).toEqual({ deviceId: 'd1', token: 'tind_x', audioUrl: 'https://m/a.wav' })
  })

  it('missing audioUrl, or malformed JSON, is a 400 before any fetch', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    expect((await POST(req({ deviceId: 'd1', token: 't' }))).status).toBe(400)
    expect((await POST(req('{nope'))).status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([400, 401, 404, 422])('worker %i passes through with its sentence', async (st) => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: `said ${st}` }), { status: st })) as any
    const res = await POST(req({ deviceId: 'd1', token: 't', audioUrl: 'https://m/a.wav' }))
    expect(res.status).toBe(st)
    expect((await res.json()).error).toBe(`said ${st}`)
  })

  it('worker down or 5xx collapses to 424', async () => {
    global.fetch = vi.fn(async () => { throw new Error('boom') }) as any
    expect((await POST(req({ deviceId: 'd1', token: 't', audioUrl: 'https://m/a.wav' }))).status).toBe(424)
    global.fetch = vi.fn(async () => new Response('internal error', { status: 500 })) as any
    expect((await POST(req({ deviceId: 'd1', token: 't', audioUrl: 'https://m/a.wav' }))).status).toBe(424)
  })
})

// ---- worker handler ---------------------------------------------------------
const ORIGIN = 'https://plugin.tiny.technology'
const KEY = '0f8b6e0c-1111-4222-8333-944455556666.wav'
const OWN = `${ORIGIN}/media/${KEY}`

function fakeEnv(opts: { owner?: string | null; objOwner?: string; contentType?: string } = {}) {
  const owner = opts.owner === undefined ? 'user-alice' : opts.owner
  const reads: string[] = []
  const env: any = {
    INTERNAL_API_KEY: 'ik',
    OPENAI_API_KEY: 'sk-test',
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => (owner ? { user_id: owner, name: 'sticky' } : null) }) }),
    },
    MEDIA: {
      head: async (k: string) => (k === KEY
        ? { customMetadata: { user_id: opts.objOwner ?? 'user-alice' }, httpMetadata: { contentType: opts.contentType ?? 'audio/wav' } }
        : null),
      get: async (k: string) => {
        reads.push(k)
        return { arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer, httpMetadata: { contentType: 'audio/wav' } }
      },
    },
  }
  return { env, reads }
}

async function callWorker(env: any, body: object, internalKey = 'ik') {
  const { DeviceTranscribeCall } = await import(workerFile('transcribe.ts') /* @vite-ignore */)
  const request = new Request(`${ORIGIN}/device/transcribe`, {
    method: 'POST', headers: { 'x-internal-key': internalKey },
  })
  return new DeviceTranscribeCall({} as any).handle(request, env, {}, { body })
}

function sttFetch(text: string) {
  const calls: string[] = []
  global.fetch = vi.fn(async (url: any) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ text }), { status: 200 })
  }) as any
  return calls
}

describe.skipIf(!present)('worker DeviceTranscribeCall — owner-scoped STT, no agent turn', () => {
  it("transcribes the owner's own upload and makes no other outbound call", async () => {
    const { env, reads } = fakeEnv()
    const calls = sttFetch('  see you at six  ')
    const res = await callWorker(env, { deviceId: 'd1', token: 't', audioUrl: OWN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, text: 'see you at six' })
    expect(reads).toEqual([KEY])
    expect(calls).toEqual(['https://api.openai.com/v1/audio/transcriptions'])
  })

  it("another owner's audio reads exactly like a missing key, and is never read", async () => {
    const { env, reads } = fakeEnv({ objOwner: 'user-bob' })
    const calls = sttFetch('secret')
    const foreign = await callWorker(env, { deviceId: 'd1', token: 't', audioUrl: OWN })
    const missing = await callWorker(env, {
      deviceId: 'd1', token: 't', audioUrl: `${ORIGIN}/media/00000000-0000-4000-8000-000000000000.wav`,
    })
    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    expect(reads).toEqual([])
    expect(calls).toEqual([])
  })

  it.each([
    ['another host', `https://evil.example/media/${KEY}`],
    ['http', `http://plugin.tiny.technology/media/${KEY}`],
    ['a non-media path', `${ORIGIN}/share/${KEY}`],
    ['a query string', `${OWN}?x=1`],
    ['not a URL', 'nope'],
  ])('refuses %s with a 400 before auth or storage', async (_name, audioUrl) => {
    const { env, reads } = fakeEnv()
    const calls = sttFetch('x')
    const res = await callWorker(env, { deviceId: 'd1', token: 't', audioUrl })
    expect(res.status).toBe(400)
    expect(reads).toEqual([])
    expect(calls).toEqual([])
  })

  it('a non-audio upload of the owner is refused', async () => {
    const { env } = fakeEnv({ contentType: 'image/png' })
    sttFetch('x')
    const res = await callWorker(env, { deviceId: 'd1', token: 't', audioUrl: OWN })
    expect(res.status).toBe(400)
  })

  it('unknown/revoked device is a 401; a bad internal key is a 401', async () => {
    sttFetch('x')
    const { env } = fakeEnv({ owner: null })
    expect((await callWorker(env, { deviceId: 'd1', token: 'bad', audioUrl: OWN })).status).toBe(401)
    const ok = fakeEnv()
    expect((await callWorker(ok.env, { deviceId: 'd1', token: 't', audioUrl: OWN }, 'wrong')).status).toBe(401)
  })

  it('silence is a 422 "nothing transcribed" — retriable with a new take', async () => {
    const { env } = fakeEnv()
    sttFetch('   ')
    const res = await callWorker(env, { deviceId: 'd1', token: 't', audioUrl: OWN })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('nothing transcribed')
  })
})

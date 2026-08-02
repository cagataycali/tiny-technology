// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

/**
 * 🏠 The heartbeat/list HANDLERS around lan_url — the same-WiFi fast path.
 *
 * devices-sql.test.ts pins the statements and the validator. These are the two
 * decisions that live only in the handler code, and each one is a way for the
 * feature to fail in a shape that LOOKS like it working:
 *
 *   1. A malformed or hostile lanUrl must be DROPPED, never a 400. The
 *      heartbeat's job is presence; failing it over an optional field would take
 *      a healthy board offline in the fleet list — which is a worse version of
 *      the exact bug this change fixes ("says connecting through the cloud").
 *   2. A stale address must NOT be reported. DHCP reassigns it, so handing a
 *      client an address the board no longer holds means dialing whatever
 *      machine has it now and waiting out a timeout before falling back to the
 *      cloud — SLOWER than never having tried. Presence is the gate.
 */
let DeviceHeartbeatCall: any
let DevicesListCall: any
let PRESENCE_WINDOW_S: number
let hashDeviceToken: (t: string) => Promise<string>

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('devices.ts') /* @vite-ignore */)
  DeviceHeartbeatCall = mod.DeviceHeartbeatCall
  DevicesListCall = mod.DevicesListCall
  PRESENCE_WINDOW_S = mod.PRESENCE_WINDOW_S
  hashDeviceToken = mod.hashDeviceToken
})

warnIfWorkerAbsent('device-lan-handler')

const KEY = 'internal-test-key'

/** Minimal D1 stand-in that records what the handler bound, so a bind-order
 *  mistake surfaces as a wrong value rather than as a passing test. */
function makeEnv(rows: any[] = [], changes = 1) {
  const binds: any[][] = []
  return {
    binds,
    // The name checkInternalKey actually reads. A wrong key here fails every
    // handler closed and the whole suite would pass vacuously on 401s.
    INTERNAL_API_KEY: KEY,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            binds.push([sql, ...args])
            return {
              async run() { return { meta: { changes } } },
              async all() { return { results: rows } },
              async first() { return rows[0] ?? null },
            }
          },
        }
      },
    },
  }
}

const hbReq = () =>
  new Request('https://plugin.tiny.technology/device/heartbeat', {
    method: 'POST',
    headers: { 'X-Internal-Key': KEY, 'Content-Type': 'application/json' },
  })

const beat = async (env: any, body: any) =>
  new DeviceHeartbeatCall().handle(hbReq(), env, {}, { body })

const list = async (env: any) =>
  new DevicesListCall().handle(
    new Request('https://plugin.tiny.technology/device/list?userId=u1',
      { headers: { 'X-Internal-Key': KEY } }), env)

describe.skipIf(!present)('heartbeat + lanUrl', () => {
  it('a valid private base is bound to the statement', async () => {
    const env = makeEnv()
    const res = await beat(env, {
      deviceId: 'd1', token: 'tind_x', lanUrl: 'http://192.168.1.207:8080',
    })
    expect(res.status).toBe(200)
    // 5th bound param (after sql, id, ts, caps, hash)
    expect(env.binds[0][5]).toBe('http://192.168.1.207:8080')
  })

  it('a PUBLIC lanUrl is dropped, and the heartbeat still succeeds', async () => {
    // Dropped as null → COALESCE keeps whatever was stored. Returning 400 here
    // would mark a live board offline over a field nobody asked for.
    const env = makeEnv()
    const res = await beat(env, {
      deviceId: 'd1', token: 'tind_x', lanUrl: 'http://8.8.8.8:8080',
    })
    expect(res.status, 'presence must not fail over an optional field').toBe(200)
    expect(env.binds[0][5], 'a public address reached the database').toBe(null)
  })

  it('garbage, loopback and a hostname are all dropped the same way', async () => {
    for (const lanUrl of ['not a url', 'http://127.0.0.1:8080', 'http://tiny.local:8080',
                          'https://192.168.1.5:8080', '', '   ']) {
      const env = makeEnv()
      const res = await beat(env, { deviceId: 'd1', token: 'tind_x', lanUrl })
      expect(res.status, JSON.stringify(lanUrl)).toBe(200)
      expect(env.binds[0][5], JSON.stringify(lanUrl)).toBe(null)
    }
  })

  it('an omitted lanUrl binds null — an older firmware must keep working', async () => {
    const env = makeEnv()
    const res = await beat(env, { deviceId: 'd1', token: 'tind_x' })
    expect(res.status).toBe(200)
    expect(env.binds[0][5]).toBe(null)
  })

  it('the path is normalized off before it is stored', async () => {
    const env = makeEnv()
    await beat(env, { deviceId: 'd1', token: 'tind_x', lanUrl: 'http://10.0.0.4:8080/stream' })
    expect(env.binds[0][5]).toBe('http://10.0.0.4:8080')
  })

  it('an unknown device is still 401 — lanUrl changes nothing about auth', async () => {
    const env = makeEnv([], 0) // 0 rows changed
    const res = await beat(env, {
      deviceId: 'd1', token: 'tind_wrong', lanUrl: 'http://192.168.1.207:8080',
    })
    expect(res.status).toBe(401)
  })
})

describe.skipIf(!present)('device list + lan_url staleness', () => {
  const now = () => Math.floor(Date.now() / 1000)
  const row = (over: any = {}) => ({
    id: 'v1', name: 'tiny vision', platform: 'nicla-vision', kind: 'daemon',
    capabilities: '["camera"]', last_seen: now(), created_at: 1, url: null,
    lan_url: 'http://192.168.1.207:8080', ...over,
  })

  it('a PRESENT board reports its LAN base', async () => {
    const res = await list(makeEnv([row()]))
    const body: any = await res.json()
    expect(body.devices[0].online).toBe(true)
    expect(body.devices[0].lan_url).toBe('http://192.168.1.207:8080')
  })

  it('a board that stopped beating does NOT report one', async () => {
    // The important half. Dialing a reassigned address costs a timeout BEFORE
    // the cloud fallback, so a stale value is slower than no value at all.
    const res = await list(makeEnv([row({ last_seen: now() - (PRESENCE_WINDOW_S + 60) })]))
    const body: any = await res.json()
    expect(body.devices[0].online).toBe(false)
    expect('lan_url' in body.devices[0],
      'an offline board handed out an address DHCP may have reassigned').toBe(false)
  })

  it('the key is OMITTED rather than empty, so `if let` is the whole check', async () => {
    const res = await list(makeEnv([row({ lan_url: '' })]))
    const body: any = await res.json()
    expect('lan_url' in body.devices[0]).toBe(false)
  })

  it('an endpoint device never reports a LAN base', async () => {
    // Its `url` is a public origin the WORKER dials; the two must not blur, and
    // an endpoint's online is null (unknown) rather than a timestamp verdict.
    const res = await list(makeEnv([row({ kind: 'endpoint', url: 'https://printer.example.com' })]))
    const body: any = await res.json()
    expect(body.devices[0].url).toBe('https://printer.example.com')
    expect('lan_url' in body.devices[0]).toBe(false)
  })

  it('the secret is never in the payload, lan_url or not', async () => {
    const res = await list(makeEnv([row({ secret: 'tind_super_secret' })]))
    const text = await res.text()
    expect(text).not.toContain('tind_super_secret')
  })
})

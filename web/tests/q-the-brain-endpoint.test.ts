// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, workerPresent, warnIfWorkerAbsent } from './_worker'
import { validatePublicUrl } from '@/lib/utils'
import { makeUseDeviceTool } from '../lib/chat/tools/platform'

warnIfWorkerAbsent('q-the-brain-endpoint')

/**
 * 🧠 q-the-brain — the Arduino UNO Q as an ENDPOINT device.
 *
 * The board runs its own FastAPI dashboard (https://q.example.com) and tiny dials
 * OUT to it with the owner token stored at enrolment, exactly like
 * `fomo [endpoint/fomo-the-arm]` and `3D printer [endpoint/bambu-x2d]`. Nothing
 * in lib/ is per-platform, so this file is the contract: the row shape the
 * fleet registers, what the worker will actually call on the board, and what
 * `use_device list` shows the agent. If the board's API drifts from this, the
 * dashboard (q-the-brain/dashboard) is what has to move — not tinyai-id.
 */
export const Q_BRAIN_DEVICE = {
  name: 'q-the-brain',
  kind: 'endpoint',
  platform: 'q-the-brain',
  url: 'https://q.example.com',
  capabilities: ['telemetry', 'chat', 'led', 'mcu', 'shell'],
} as const

/** The row `/api/devices` hands back once the device is enrolled. */
const Q_ROW = {
  id: 'dev_q', name: Q_BRAIN_DEVICE.name, kind: Q_BRAIN_DEVICE.kind, platform: Q_BRAIN_DEVICE.platform,
  online: null, url: Q_BRAIN_DEVICE.url, last_seen: null,
  capabilities: JSON.stringify(Q_BRAIN_DEVICE.capabilities),
}
const LAPTOP = { id: 'dev_mac', name: 'mac', kind: 'cli', platform: 'darwin', online: true, last_seen: 1000 }

describe('q-the-brain endpoint contract', () => {
  it('the dashboard origin passes the app-side SSRF guard (a private IP would not)', () => {
    expect('error' in validatePublicUrl(Q_BRAIN_DEVICE.url), 'q.example.com must be a public https origin').toBe(false)
    // The board's LAN address is how we reach it over ssh, never how tiny dials it.
    expect('error' in validatePublicUrl('http://192.168.1.210:8095')).toBe(true)
  })

  it('declares the capabilities the iOS panel and the agent match on', () => {
    // `led` is what QBrainLive keys the LED-matrix composer on; `telemetry` is
    // what makes the Devices sheet draw vitals; `chat` is what use_device invokes.
    expect(Q_BRAIN_DEVICE.capabilities).toEqual(expect.arrayContaining(['telemetry', 'chat', 'led']))
    // No hardware we do not have: the UNO Q has no camera or servos attached today.
    expect(Q_BRAIN_DEVICE.capabilities).not.toContain('camera')
    expect(Q_BRAIN_DEVICE.capabilities).not.toContain('arm')
  })
})

describe.skipIf(!workerPresent)('q-the-brain enrolment row (worker rules)', () => {
  let mod: any
  beforeAll(async () => { mod = await import(workerFile('devices.ts') /* @vite-ignore */) })

  it('the url is stored as its origin, unchanged', () => {
    expect(mod.validateEndpointUrl(Q_BRAIN_DEVICE.url)).toEqual({ url: 'https://q.example.com' })
  })

  it('the worker calls the board on the fomo-shaped paths, not /api/state', () => {
    // PLAN.md names /api/state for the panel; the WORKER's telemetry action is
    // fixed at /api/telemetry (same as fomo). The board must serve both, or
    // `use_device` telemetry answers 404 while the phone panel works.
    expect(mod.ENDPOINT_ACTIONS.telemetry).toEqual({ method: 'GET', path: '/api/telemetry' })
    expect(mod.ENDPOINT_ACTIONS.chat).toMatchObject({ method: 'POST', path: '/api/chat', body: true })
  })
})

describe('use_device sees q-the-brain like every other endpoint', () => {
  let calls: Array<{ url: string; body: any }> = []
  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ url, body })
      const payload = url.includes('/device/list')
        ? { ok: true, devices: [Q_ROW, LAPTOP] }
        : url.includes('/device/endpoint/call')
          ? { ok: true, result: { reply: 'cpu 48.2°C, load 0.31, up 2h' } }
          : (() => { throw new Error(`unexpected ${url}`) })()
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const invoke = (input: any): Promise<any> => (makeUseDeviceTool('user_1') as any).invoke(input, { toolUse: {} })

  it('lists as "q-the-brain [endpoint/q-the-brain]" with unknown (null) presence', async () => {
    const out = await invoke({ action: 'list' })
    const q = out.devices.find((d: any) => d.id === 'dev_q')
    expect(q).toBeTruthy()
    expect(`${q.name} [${q.kind}/${q.platform}]`).toBe('q-the-brain [endpoint/q-the-brain]')
    expect(q.online).toBe(null)
    expect(q.url).toBe('https://q.example.com')
    expect(q.note).toContain('unknown until invoked')
  })

  it('invoke reaches the board through the worker with action=chat only', async () => {
    const out = await invoke({ action: 'invoke', device_id: 'dev_q', prompt: 'how hot is the SoC?' })
    expect(out).toEqual({ ok: true, device_id: 'dev_q', result: 'cpu 48.2°C, load 0.31, up 2h' })
    const call = calls.find(c => c.url.includes('/device/endpoint/call'))!
    expect(call.body).toEqual({ userId: 'user_1', deviceId: 'dev_q', action: 'chat', prompt: 'how hot is the SoC?' })
    // The token never leaves the worker; nothing here talks to q.example.com directly.
    expect(calls.some(c => c.url.includes('q.example.com'))).toBe(false)
  })
})

describe('the iOS + Android panels know the platform (parity)', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
  it('ios/Tiny/Sources/QBrainLive.swift matches the row by platform "q-the-brain"', () => {
    const src = read('ios/Tiny/Sources/QBrainLive.swift')
    expect(src).toContain('platform == "q-the-brain"')
    // And both phones name the platform the same way (the parity suite pins the
    // tables against each other; this pins the word itself).
    expect(read('ios/Tiny/Sources/Panels.swift')).toContain('("q-the-brain", "UNO Q")')
    expect(read('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')).toContain('"q-the-brain" to "UNO Q"')
  })
})

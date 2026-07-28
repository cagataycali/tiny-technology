// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeUseDeviceTool } from '../lib/chat/tools/platform'
import { workerPresent } from './_worker'

/**
 * 🤖 use_device ↔ ENDPOINT devices (docs/endpoint-devices-vision-2026-07-25.md).
 *
 * A pull-mode device dials in and gets a mailbox envelope. A robot/printer
 * running its own WebAuthn-sealed dashboard can't: it's a server, so tiny dials
 * OUT. Same tool, same `action:'invoke'`, completely different transport — and
 * the ways that can go wrong are what this pins down:
 *   - the kind is resolved from the registry, so a stale device_id can never
 *     take the wrong transport
 *   - the secret is NEVER fetched to the edge; the worker makes the call
 *   - unreachable (asleep/tunnel down) and unauthorized (our token expired)
 *     are told apart, because they need different things said to the user
 *   - `online:null` survives to the model as null, not false
 *
 * No fake timers here: the endpoint path is synchronous by design — no poll
 * loop, no claim ticket.
 */
type Call = { url: string; body?: any; headers?: any }
let calls: Call[]
let responder: (url: string, init?: RequestInit) => any

const okJson = (obj: any) => ({ json: async () => obj }) as Response

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers,
    })
    return okJson(responder(String(url), init))
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const invoke = (input: any): Promise<any> => (makeUseDeviceTool('user_1') as any).invoke(input, { toolUse: {} })

const PRINTER = { id: 'dev_printer', name: '3D printer', kind: 'endpoint', platform: 'bambu-x2d', online: null, url: 'https://printer.example.com', last_seen: null }
const LAPTOP = { id: 'dev_mac', name: 'mac', kind: 'cli', platform: 'darwin', online: true, last_seen: 1000 }

/** Registry answers with both a robot and a laptop; endpoint calls answer `reply`. */
const baseResponder = (endpointResult: any) => (url: string) => {
  if (url.includes('/device/list')) return { ok: true, devices: [PRINTER, LAPTOP] }
  if (url.includes('/device/endpoint/call')) return endpointResult
  throw new Error(`unexpected ${url}`)
}

describe('use_device — endpoint devices', () => {
  it('list keeps online:null (unknown), never coerced to offline', async () => {
    responder = baseResponder({})
    const out = await invoke({ action: 'list' })
    const printer = out.devices.find((d: any) => d.id === 'dev_printer')
    // false would make the agent report a healthy robot as offline and refuse
    // to use it; null means "call it and find out".
    expect(printer.online).toBe(null)
    expect(printer.note).toContain('unknown until invoked')
    expect(printer.url).toBe('https://printer.example.com')
    // The pull-mode device is unaffected — no note, real boolean presence.
    const mac = out.devices.find((d: any) => d.id === 'dev_mac')
    expect(mac.online).toBe(true)
    expect(mac.note).toBeUndefined()
  })

  it('invoke on an endpoint device goes out through the worker, not the relay', async () => {
    responder = baseResponder({ ok: true, result: { reply: 'Printer is idle, nozzle at 32°C.' } })
    const out = await invoke({ action: 'invoke', device_id: 'dev_printer', prompt: 'status?' })
    expect(out).toEqual({ ok: true, device_id: 'dev_printer', result: 'Printer is idle, nozzle at 32°C.' })

    // The relay is never touched: no envelope, no mailbox, no claim ticket.
    expect(calls.some(c => c.url.includes('/device/relay/'))).toBe(false)
    const call = calls.find(c => c.url.includes('/device/endpoint/call'))!
    expect(call.body).toEqual({ userId: 'user_1', deviceId: 'dev_printer', action: 'chat', prompt: 'status?' })
    // The action is fixed here, not taken from tool input: `chat` is the only
    // surface an LLM-driven invoke may reach on a machine that can also print.
    expect(call.body.action).toBe('chat')
  })

  it('never asks the worker for the credential — the secret stays server-side', async () => {
    responder = baseResponder({ ok: true, result: 'ok' })
    await invoke({ action: 'invoke', device_id: 'dev_printer', prompt: 'hi' })
    // No fetch goes straight at the device, and nothing bearer-ish is sent
    // anywhere: the worker holds the token and makes the outbound call, so an
    // edge-side bug can leak at most the robot's ANSWER.
    expect(calls.every(c => c.url.startsWith('http'))).toBe(true)
    expect(calls.some(c => c.url.includes('printer.example.com'))).toBe(false)
    expect(JSON.stringify(calls.map(c => c.body))).not.toMatch(/secret|bearer/i)
  })

  it('a pull-mode device still takes the relay path (no regression)', async () => {
    vi.useFakeTimers()
    try {
      responder = (url) => {
        if (url.includes('/device/list')) return { ok: true, devices: [PRINTER, LAPTOP] }
        if (url.includes('/device/relay/send')) return { id: 'env_1' }
        if (url.includes('/device/relay/recv')) return { reply: { payload: JSON.stringify({ result: 'df says 42%' }) } }
        throw new Error(`unexpected ${url}`)
      }
      const p = invoke({ action: 'invoke', device_id: 'dev_mac', prompt: 'disk?' })
      await vi.advanceTimersByTimeAsync(45_500)
      const out = await p
      expect(out).toEqual({ ok: true, device_id: 'dev_mac', envelope_id: 'env_1', result: 'df says 42%' })
      expect(calls.some(c => c.url.includes('/device/endpoint/call'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a still-thinking robot is not reported as offline', async () => {
    responder = baseResponder({ error: 'device did not finish within 150s — its agent may still be working', timeout: true })
    const slow = await invoke({ action: 'invoke', device_id: 'dev_printer', prompt: 'design a bracket' })
    expect(slow.ok).toBe(false)
    expect(slow.note).toMatch(/still working|thinking/i)
    // The whole point: don't tell the user the machine is off when it's busy.
    expect(slow.note).not.toMatch(/powered off/i)
    expect(slow.note).not.toMatch(/unreachable/i)
  })

  // Reads the worker source, so it can only run where the submodule is checked
  // out (absent in CI) — every other test in this file is app-only.
  it.skipIf(!workerPresent)("waits longer than the worker does, so the worker's typed answer wins", () => {
    // If this side gave up first we'd turn every slow-but-successful robot call
    // into an untyped abort and lose the timeout/unreachable distinction the
    // notes above depend on.
    const tool = readFileSync(join(__dirname, '..', 'lib', 'chat', 'tools', 'platform.ts'), 'utf8')
    const worker = readFileSync(join(__dirname, '..', 'worker', 'src', 'devices.ts'), 'utf8')
    const n = (s: string) => Number(s.replace(/_/g, ''))
    const toolMs = n((tool.match(/AbortSignal\.timeout\((\d[\d_]*)\)[\s\S]{0,120}?device\/endpoint\/call/) ||
      tool.match(/device\/endpoint\/call[\s\S]{0,400}?AbortSignal\.timeout\((\d[\d_]*)\)/) || [])[1] || '0')
    const workerMs = n((worker.match(/spec\.body \? (\d[\d_]*)/) || [])[1] || '0')
    expect(workerMs).toBeGreaterThan(0)
    expect(toolMs).toBeGreaterThan(workerMs)
  })

  it('unreachable and unauthorized are told apart', async () => {
    responder = baseResponder({ error: 'device unreachable: fetch failed', unreachable: true })
    const down = await invoke({ action: 'invoke', device_id: 'dev_printer', prompt: 'status?' })
    expect(down.ok).toBe(false)
    expect(down.note).toMatch(/powered off|tunnel/i)
    // Don't send the agent into a retry loop against a machine that's asleep.
    expect(down.note).toMatch(/rather than retrying/i)

    calls = []
    responder = baseResponder({ error: 'device rejected our credential', unauthorized: true })
    const stale = await invoke({ action: 'invoke', device_id: 'dev_printer', prompt: 'status?' })
    expect(stale.ok).toBe(false)
    // "Offline" here would send the owner debugging a network problem that is
    // really an expired token — the note must name re-enrolling.
    expect(stale.note).toMatch(/re-enroll/i)
    expect(stale.note).not.toMatch(/powered off/i)
  })

  it('unwraps whatever shape the dashboard answered with', async () => {
    for (const [result, want] of [
      [{ reply: 'r' }, 'r'],
      [{ result: 'r' }, 'r'],
      [{ text: 'r' }, 'r'],
      ['r', 'r'],
    ] as const) {
      responder = baseResponder({ ok: true, result })
      const out = await invoke({ action: 'invoke', device_id: 'dev_printer', prompt: 'x' })
      expect(out.result, JSON.stringify(result)).toBe(want)
    }
  })

  it('an unrecognized device_id falls back to the relay, not to a robot call', async () => {
    // A device revoked mid-conversation resolves to no kind. Guessing
    // "endpoint" would send a prompt out to a URL we no longer own; the relay
    // path fails closed instead.
    responder = (url) => {
      if (url.includes('/device/list')) return { ok: true, devices: [PRINTER] }
      if (url.includes('/device/relay/send')) return { error: 'unknown device' }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'invoke', device_id: 'dev_gone', prompt: 'x' })
    expect(out.ok).toBe(false)
    expect(calls.some(c => c.url.includes('/device/endpoint/call'))).toBe(false)
  })

  it('the devices page renders unknown presence as its own state, not offline', () => {
    // The agent read the printer as "⚫ offline" in the UI while the API was
    // correctly saying online:null — because `d.online ? … : "offline"` collapses
    // the third state into the false branch. Every presence read on that page
    // must go through presenceOf, which is the only place the null is honoured.
    const page = readFileSync(join(__dirname, '..', 'app', 'devices', 'page.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(page).toContain('presenceOf')
    // No bare truthiness test on `online` survives OUTSIDE presenceOf's own body
    // — that one collapse is the intended one. Cut the helper out, then look.
    const body = page.replace(/const presenceOf[\s\S]*?"offline";/, '')
    expect(body).toContain('presenceOf(d)') // the guard isn't vacuous
    const bare = body.match(/d\.online\s*[?&|=]/g) || []
    expect(bare, `presence read without presenceOf — collapses null to offline: ${bare.join(', ')}`).toEqual([])
    // And the null branch has to actually mean something to the reader.
    expect(page).toMatch(/reachable when called/)
  })

  it('the tool description tells the model endpoint devices exist and how they differ', async () => {
    const desc = String((makeUseDeviceTool('user_1') as any).toolSpec?.description ?? (makeUseDeviceTool('user_1') as any).description ?? '')
    expect(desc).toContain('endpoint')
    // Without this the model reads online:null as offline and refuses the call.
    expect(desc).toMatch(/online:null|not offline/)
  })
})

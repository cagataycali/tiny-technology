// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeUseDeviceTool } from '../lib/chat/tools/platform'

/**
 * 💻 use_device ASYNC CONTRACT (e2e report §3.1, loop cycle d-a).
 *
 * The worker mailbox keeps a device's reply ~1h, but the tool used to poll
 * 15×3s and then return a DEAD-END error — the envelope id was dropped, so a
 * 46-second task's reply rotted unread and the caller (the user, via iOS) saw
 * a hard failure. The contract now: timeout → { ok, pending:true,
 * envelope_id } claim ticket; action:'result' redeems it any time later.
 *
 * The callback talks to the worker via global fetch — mocked here; the 45s
 * wait-loop runs on fake timers so the suite stays fast.
 */

type Call = { url: string; body?: any }
let calls: Call[]
let responder: (url: string, init?: RequestInit) => any

const okJson = (obj: any) => ({ json: async () => obj }) as Response

beforeEach(() => {
  calls = []
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return okJson(responder(String(url), init))
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// SDK tool objects run their callback via .invoke(input, ctx) — same pattern
// as tests/platform-tools.test.ts.
const invoke = (input: any): Promise<any> => (makeUseDeviceTool('user_1') as any).invoke(input, { toolUse: {} })

/** Drive the invoke wait-loop to completion under fake timers. */
const settled = async <T>(p: Promise<T>): Promise<T> => {
  await vi.advanceTimersByTimeAsync(45_500)
  return p
}

describe('use_device async contract', () => {
  it('invoke that replies in time returns the result AND the envelope_id', async () => {
    let polls = 0
    responder = (url) => {
      if (url.includes('/device/relay/send')) return { id: 'env_42' }
      if (url.includes('/device/relay/recv')) {
        polls++
        return polls < 3 ? { reply: null } : { reply: { payload: JSON.stringify({ result: 'df -h says 42% full' }) } }
      }
      throw new Error(`unexpected ${url}`)
    }
    const out = await settled(invoke({ action: 'invoke', device_id: 'dev_1', prompt: 'disk usage?' }))
    expect(out).toEqual({ ok: true, device_id: 'dev_1', envelope_id: 'env_42', result: 'df -h says 42% full' })
  })

  it('invoke timeout is PENDING, not failure: ok:true + envelope_id claim ticket', async () => {
    responder = (url) => {
      if (url.includes('/device/relay/send')) return { id: 'env_slow' }
      if (url.includes('/device/relay/recv')) return { reply: null }
      throw new Error(`unexpected ${url}`)
    }
    const out = await settled(invoke({ action: 'invoke', device_id: 'dev_1', prompt: 'long task' }))
    expect(out.ok).toBe(true)
    expect(out.pending).toBe(true)
    expect(out.envelope_id).toBe('env_slow')
    // The note must teach the agent the redeem move verbatim.
    expect(out.note).toContain("action:'result'")
    expect(out.note).toContain('env_slow')
    // Exactly 15 recv polls were made (the 45s budget), then we stopped.
    expect(calls.filter(c => c.url.includes('/device/relay/recv'))).toHaveLength(15)
  })

  it("action:'result' redeems a finished envelope", async () => {
    responder = (url) => {
      if (url.includes('/device/relay/recv')) {
        expect(url).toContain('inReplyTo=env_slow')
        return { reply: { payload: JSON.stringify({ result: 'build finished: 0 errors' }) } }
      }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'result', envelope_id: 'env_slow' })
    expect(out).toEqual({ ok: true, envelope_id: 'env_slow', result: 'build finished: 0 errors' })
  })

  it("action:'result' on a still-running task stays pending (notification promised, 24h window)", async () => {
    responder = (url) => {
      if (url.includes('/device/relay/recv')) return { reply: null }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'result', envelope_id: 'env_slow' })
    expect(out.ok).toBe(true)
    expect(out.pending).toBe(true)
    expect(out.envelope_id).toBe('env_slow')
    // The retention window matches the worker's SWEEP_SETTLED_AGE_S (24h) and
    // the P1 push closes the loop — the old "delivered once, kept ~1h" wording
    // was doubly wrong post-591293a (recv is a repeatable read).
    expect(out.note).toMatch(/kept ~24h/)
    expect(out.note).toContain('notification')
    expect(out.note).not.toMatch(/~1h|delivered once/)
  })

  it('wait:false is fire-and-forget: the ticket returns immediately, zero polls, zero timers', async () => {
    responder = (url) => {
      if (url.includes('/device/relay/send')) return { id: 'env_bg' }
      // kind resolution may probe /device/list; anything else is a bug
      if (url.includes('/device/list')) return { devices: [] }
      throw new Error(`unexpected ${url}`)
    }
    // NO settled(): the promise must resolve without any timer advancement —
    // that IS the feature (the 45s poll never starts).
    const out = await invoke({ action: 'invoke', device_id: 'dev_1', prompt: 'nightly build', wait: false })
    expect(out.ok).toBe(true)
    expect(out.pending).toBe(true)
    expect(out.background).toBe(true)
    expect(out.envelope_id).toBe('env_bg')
    // The note must promise the notification AND teach the redeem move.
    expect(out.note).toContain('notification')
    expect(out.note).toContain("action:'result'")
    expect(out.note).toContain('env_bg')
    expect(calls.filter(c => c.url.includes('/device/relay/recv'))).toHaveLength(0)
  })

  it('wait:false still hard-errors when the send itself failed — no false pending', async () => {
    responder = (url) => {
      if (url.includes('/device/relay/send')) return { error: 'device not found' }
      if (url.includes('/device/list')) return { devices: [] }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'invoke', device_id: 'nope', prompt: 'x', wait: false })
    expect(out).toEqual({ ok: false, error: 'device not found' })
  })

  it('wait:false on an ENDPOINT device is ignored — robots answer synchronously, no ticket exists', async () => {
    responder = (url) => {
      if (url.includes('/device/list')) return { devices: [{ id: 'bot_1', kind: 'endpoint' }] }
      if (url.includes('/device/endpoint/call')) return { result: { reply: 'printer says hi' } }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'invoke', device_id: 'bot_1', prompt: 'status?', wait: false })
    expect(out).toEqual({ ok: true, device_id: 'bot_1', result: 'printer says hi' })
    expect(calls.some(c => c.url.includes('/device/relay/send'))).toBe(false)
  })

  it("action:'result' without envelope_id is a usage error", async () => {
    responder = () => { throw new Error('no fetch expected') }
    const out = await invoke({ action: 'result' })
    expect(out).toEqual({ ok: false, error: "envelope_id required for action:'result'" })
  })

  it('non-JSON reply payloads pass through as raw text (same as the sync path always did)', async () => {
    responder = (url) => {
      if (url.includes('/device/relay/recv')) return { reply: { payload: 'plain text output' } }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'result', envelope_id: 'env_1' })
    expect(out.result).toBe('plain text output')
  })

  it('send failure is still a hard error (nothing was delivered — no false pending)', async () => {
    responder = (url) => {
      if (url.includes('/device/relay/send')) return { error: 'device not found' }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'invoke', device_id: 'nope', prompt: 'x' })
    expect(out).toEqual({ ok: false, error: 'device not found' })
  })

  it('logged-out callers are refused for every action', async () => {
    responder = () => { throw new Error('no fetch expected') }
    const anon = makeUseDeviceTool(null) as any
    for (const action of ['list', 'invoke', 'result']) {
      expect((await anon.invoke({ action }, { toolUse: {} })).ok).toBe(false)
    }
  })
})

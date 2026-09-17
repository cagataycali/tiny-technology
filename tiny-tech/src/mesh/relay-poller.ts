/**
 * Relay poller — the device side of tiny-node PR6 (cloud relay).
 *
 * While the mesh node / daemon runs, poll /api/devices/relay (PUT) for
 * envelopes addressed to this device; execute {type:'invoke'} prompts on
 * a FRESH local agent; PATCH the reply back. This is what makes
 * "ask my laptop from my phone's browser" work across networks.
 *
 * Device-token auth (no user JWT on disk needed beyond enroll) — a
 * revoked device gets 401 and the poller stops itself.
 */
import { loadDevice, type DeviceIdentity } from '../device.js'
import { apiUrlFor } from '../config.js'
import { buildRelayReply, type HostedImage } from '../agent/media.js'

const POLL_INTERVAL_MS = 5_000
const PAYLOAD_MAX = 8000

/**
 * An agent that can answer an envelope. invokeWithMedia is optional so the
 * mesh/TUI agents (and test doubles) that only speak text keep working — a
 * device whose agent has it can return pictures too (loop item d-d).
 */
export interface RelayAgent {
  invoke: (q: string) => Promise<string>
  invokeWithMedia?: (q: string) => Promise<{ text: string; images: HostedImage[] }>
}

export interface RelayPollerOptions {
  agentFactory: () => Promise<RelayAgent>
  apiUrl?: string
  onStop?: (reason: string) => void
  /**
   * Tick length, for tests. The backoff ladder is defined in multiples of the
   * poll interval, so proving it engages at all requires a tick shorter than the
   * 5s production one — same reason handleEnvelope is exported.
   */
  pollIntervalMs?: number
}

export function startRelayPoller(opts: RelayPollerOptions): { stop: () => void } | null {
  const device = loadDevice()
  if (!device) return null // not enrolled — nothing to poll

  const apiUrl = opts.apiUrl || apiUrlFor(device.apiUrl)
  const tick = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  let running = true
  let consecutiveFailures = 0

  const loop = async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, tick))
      if (!running) break
      try {
        const res = await fetch(`${apiUrl}/api/devices/relay`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: device.deviceId, token: device.token, max: 5 }),
        })
        if (res.status === 401) {
          running = false
          opts.onStop?.('device revoked — relay poller stopped')
          return
        }
        // fetch REJECTS on a network failure but RESOLVES on 500/502/429 — so an
        // error status used to take the success path: failures reset to 0, no
        // backoff, another request in 5s, forever, from every enrolled device at
        // once. The ladder that exists for network blips never engaged for the
        // outage most likely to need it, and a struggling relay got a thundering
        // herd from its own fleet. 429 was the sharpest case: the one response
        // whose entire meaning is "slow down" was the one being ignored.
        if (!res.ok) throw new Error(`relay responded ${res.status}`)
        const data: any = await res.json().catch(() => ({}))
        consecutiveFailures = 0
        for (const msg of data.messages || []) {
          handleEnvelope(device, apiUrl, msg, opts).catch(() => {})
        }
      } catch {
        // Network blip or error status — back off up to 60s, keep trying. A
        // recovered relay resets the ladder on its first good response.
        consecutiveFailures++
        const backoff = Math.min(consecutiveFailures * tick, 60_000)
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
  }
  loop()

  return { stop: () => { running = false } }
}

/**
 * Execute one envelope and PATCH the reply. Exported so the reply CONTRACT
 * (what a device sends back, and whether it fits) is testable without a 5s
 * poll tick or a real agent — same reason desktop.ts exports runDesktop.
 */
export async function handleEnvelope(
  device: DeviceIdentity,
  apiUrl: string,
  msg: { id: string; payload: string },
  opts: RelayPollerOptions,
): Promise<void> {
  let result: string
  let images: HostedImage[] = []
  try {
    const payload = JSON.parse(msg.payload)
    if (payload?.type !== 'invoke' || !payload.prompt) {
      result = `unsupported envelope type: ${payload?.type ?? 'unknown'}`
    } else {
      // Fresh agent per envelope — same concurrency rule as mesh commands
      const agent = await opts.agentFactory()
      const prompt = String(payload.prompt)
      if (typeof agent.invokeWithMedia === 'function') {
        // Pictures this turn made ride back as hosted URLs (the bytes went to
        // the media store); the envelope itself could never carry them.
        const out = await agent.invokeWithMedia(prompt)
        result = out.text
        images = out.images || []
      } else {
        result = await agent.invoke(prompt)
      }
    }
  } catch (e: any) {
    result = `Error: ${String(e?.message || e)}`
  }

  await fetch(`${apiUrl}/api/devices/relay`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: device.deviceId,
      token: device.token,
      inReplyTo: msg.id,
      // buildRelayReply measures the SERIALIZED size: slicing the text to
      // PAYLOAD_MAX and then stringifying could still exceed the worker's 8KB
      // envelope limit (escaping grows the string), and a rejected PATCH means
      // the asker never learns the work finished at all.
      payload: buildRelayReply(result, images, PAYLOAD_MAX),
    }),
  }).catch(() => { /* reply lost — sender times out gracefully */ })
}

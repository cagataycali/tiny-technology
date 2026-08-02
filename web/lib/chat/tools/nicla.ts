/**
 * 💎 nicla_* — named tools for the tiny necklace (Arduino Nicla Vision).
 *
 * The necklace is a PULL device: it heartbeats and polls the relay mailbox
 * (strands-nicla firmware/tiny_node.py), so unlike the meta_* glasses tools
 * there is no phone executor in the loop — these wrap the same relay
 * send→poll path as use_device, with the device resolved automatically
 * (platform 'nicla-vision', online preferred). Firmware command vocabulary:
 *   photo → HVGA JPEG,  video → 6-frame 160x120 GIF (~1 fps, encoder-bound),
 *   record → 3s 16kHz WAV,  detect/faces → on-device ML,
 *   status → battery + identity in one envelope.
 *
 * Mounted for BOTH the chat route and voice sessions — no client capability
 * gating needed: the necklace answers from anywhere on the internet.
 *
 * Each factory takes an optional `budgetS`: the CALLER's own deadline, which
 * caps how long the tool will poll. Scheduled jobs are killed at 50s
 * (app/api/job-run), so a tool that polls the default 90s there can only ever
 * report "job timeout" — while the necklace finishes the capture and uploads
 * the clip that nobody reads. Clamping makes the tool return a real
 * explanation before the caller's axe falls.
 */
import { z } from 'zod'
import { tool } from '@strands-agents/sdk'
import { deviceReplyBlocks } from './platform'

const WORKER = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
const ikey = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

/** The user's necklace, online one first. Null when none is enrolled. */
async function resolveNicla(userId: string): Promise<{ id: string; name: string; online: boolean } | null> {
  const d = await fetch(`${WORKER}/device/list?userId=${encodeURIComponent(userId)}`, {
    headers: ikey(), cache: 'no-store',
  }).then(r => r.json()).catch(() => null)
  const niclas = (d?.devices || []).filter((x: any) => x.platform === 'nicla-vision')
  if (!niclas.length) return null
  const best = niclas.find((x: any) => x.online) || niclas[0]
  return { id: best.id, name: best.name, online: !!best.online }
}

/**
 * Clamp a tool's poll budget to the caller's deadline, leaving room to actually
 * return an answer. Never below 15s: measured on hardware, a video round-trip
 * (6 frames of on-device GIF encoding at ~1.13s each, plus a streamed upload)
 * is 11-16s, so a tighter cap would guarantee failure rather than prevent it.
 */
export const MIN_WAIT_S = 15
export function clampWait(waitS: number, budgetS?: number): number {
  if (!budgetS) return waitS
  return Math.max(MIN_WAIT_S, Math.min(waitS, budgetS - 8))
}

/** relay send → poll ≤`waitS`. Returns the parsed reply or a typed miss. */
async function niclaInvoke(userId: string, prompt: string, waitS = 45):
    Promise<{ result?: string; images?: unknown; error?: string; offline?: boolean }> {
  const dev = await resolveNicla(userId)
  if (!dev) return { error: 'No Nicla Vision necklace is enrolled on this account.' }
  if (!dev.online) return { error: `"${dev.name}" is offline (not heartbeating) — it may be unpowered or off WiFi.`, offline: true }

  const sent = await fetch(`${WORKER}/device/relay/send`, {
    method: 'POST', headers: ikey(),
    body: JSON.stringify({
      userId, toDevice: dev.id,
      payload: JSON.stringify({ type: 'invoke', prompt }),
    }),
  }).then(r => r.json()).catch(e => ({ error: String(e) }))
  if (sent.error || !sent.id) return { error: sent.error || 'relay send failed' }

  for (let i = 0; i < Math.ceil(waitS / 3); i++) {
    await new Promise(r => setTimeout(r, 3000))
    const d = await fetch(
      `${WORKER}/device/relay/recv?userId=${encodeURIComponent(userId)}&inReplyTo=${encodeURIComponent(sent.id)}`,
      { headers: ikey(), cache: 'no-store' },
    ).then(r => r.json()).catch(() => null)
    if (!d?.reply?.payload) continue
    try {
      const p = JSON.parse(d.reply.payload)
      return { result: String(p.result ?? ''), images: p.images }
    } catch {
      return { result: String(d.reply.payload) }
    }
  }
  return { error: `The necklace did not answer within ${waitS}s — it polls every few seconds, so it may be mid-task or just lost WiFi.` }
}

export const makeNiclaTakePhotoTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'nicla_take_photo',
  description: "Take a photo through the user's tiny necklace (Nicla Vision worn on their chest) and receive it as an image you can SEE — what is physically in front of the user right now. Works from anywhere over the internet; takes ~5-15 seconds. One still per call.",
  inputSchema: z.object({
    reason: z.string().max(200).optional().describe('Optional short reason for the capture'),
  }),
  callback: async () => {
    if (!userId) return { ok: false, error: 'Login required — the necklace belongs to the user account.' }
    const r = await niclaInvoke(userId, 'photo', clampWait(45, budgetS))
    if (r.error) return { ok: false, error: r.error }
    const blocks = await deviceReplyBlocks(r.result || 'photo', r.images)
    return blocks ?? { ok: false, error: r.result || 'The necklace answered without an image (upload may have failed).' }
  },
})

export const makeNiclaTakeVideoTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'nicla_take_video',
  description: "Record a short clip (6 frames over ~7 seconds at ~1 fps, 160x120 animated GIF) through the user's tiny necklace camera. You receive the hosted clip URL — embed it with ![clip](url) so the user sees it animate. Takes ~10-20 seconds end to end. The frame rate is a hardware limit (on-device GIF encoding), so this shows how a scene CHANGED, not smooth motion — use nicla_take_photo when a single still is enough, and prefer it for reading detail since a still is higher resolution.",
  inputSchema: z.object({
    reason: z.string().max(200).optional().describe('Optional short reason for the recording'),
  }),
  callback: async () => {
    if (!userId) return { ok: false, error: 'Login required — the necklace belongs to the user account.' }
    const r = await niclaInvoke(userId, 'video', clampWait(90, budgetS))
    if (r.error) return { ok: false, error: r.error }
    const url = /https:\/\/\S+\.gif/.exec(r.result || '')?.[0]
    if (!url) return { ok: false, error: r.result || 'The necklace answered without a clip URL.' }
    return { ok: true, clip_url: url, note: `Short clip from the necklace: ${url} — embed with ![clip](${url}) to show the user.` }
  },
})

export const makeNiclaListenTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'nicla_listen',
  description: "Listen through the user's tiny necklace microphone: records ~3 seconds of the sound around them and returns a hosted WAV clip URL (share it as a link — audio isn't transcribed on-device). For a yes/no answer spoken AT the necklace, pass mode:'yes_no' — the necklace runs on-device keyword spotting for 8s and answers with the word it heard.",
  inputSchema: z.object({
    mode: z.enum(['clip', 'yes_no']).optional().describe("'clip' (default): 3s WAV recording. 'yes_no': on-device keyword spotting."),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, error: 'Login required — the necklace belongs to the user account.' }
    if (input.mode === 'yes_no') {
      const r = await niclaInvoke(userId, 'listen', clampWait(45, budgetS))
      if (r.error) return { ok: false, error: r.error }
      return { ok: true, heard: r.result }
    }
    const r = await niclaInvoke(userId, 'record', clampWait(45, budgetS))
    if (r.error) return { ok: false, error: r.error }
    const url = /https:\/\/\S+\.wav/.exec(r.result || '')?.[0]
    if (!url) return { ok: false, error: r.result || 'The necklace answered without an audio URL.' }
    return { ok: true, audio_url: url, note: `3s audio from around the user: ${url} — share as a plain link so they can play it.` }
  },
})

export const makeNiclaStatusTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'nicla_status',
  description: "Check the user's tiny necklace: battery level/charging state and device info (IP, memory, capabilities). Also reports whether it is online at all. Cheap and fast — use before capture tools when unsure the necklace is reachable.",
  inputSchema: z.object({}),
  callback: async () => {
    if (!userId) return { ok: false, error: 'Login required — the necklace belongs to the user account.' }
    const dev = await resolveNicla(userId)
    if (!dev) return { ok: false, error: 'No Nicla Vision necklace is enrolled on this account.' }
    if (!dev.online) return { ok: true, online: false, note: `"${dev.name}" is offline — unpowered or off WiFi.` }
    // ONE envelope. This used to fire 'battery' and 'info' concurrently, which
    // doubled the latency and gave the cheapest call two chances to miss the
    // device's poll window — on the very tool whose job is to answer "is the
    // necklace reachable" quickly. The firmware answers 'status' with both
    // halves ("battery: … | name=… ip=… mem_free=…").
    const r = await niclaInvoke(userId, 'status', clampWait(30, budgetS))
    if (r.error) return { ok: false, online: true, error: r.error }
    const [battery, info] = String(r.result || '').split(' | ')
    return { ok: true, online: true, battery: battery || r.result, info: info || '' }
  },
})

/**
 * use_device — reach the user's OTHER enrolled devices via the
 * tiny.technology relay, from the local agent.
 *
 * Port of the web agent's makeUseDeviceTool (lib/chat/tools/platform.ts),
 * with one structural difference: the web tool talks to the worker with the
 * INTERNAL key; this one holds only the user's Bearer token, so every call
 * goes through the session-verb Next.js proxies instead —
 *
 *   list    GET  /api/devices                      → { ok, devices }
 *   invoke  POST /api/devices/relay { toDevice, payload } → { ok, id }
 *   poll    GET  /api/devices/relay?inReplyTo=<id> → { ok, reply? }
 *
 * ASYNC CONTRACT (same as the web tool): a slow device is NOT a failure.
 * invoke waits ≤45s (15 × 3s), then returns { pending: true, envelope_id };
 * the worker mailbox keeps the reply ~24h and action:'result' redeems it in
 * this turn, a later turn, or a later conversation. wait:false skips the
 * wait entirely.
 *
 * MEDIA CONTRACT: a device turn that produced images uploads them to the
 * media store and lists hosted URLs in its reply as { result, images:
 * [{url, format}] }. Those come back here as REAL image blocks (the model
 * sees the screen it asked for), gated by isDeviceMediaUrl — anything not
 * `https://<worker>/media/<name>` is a device asking this agent to fetch an
 * arbitrary URL and feed the bytes to the model as trusted content. Refuse.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { loadDevice } from '../device.js'
import { workerUrl } from '../config.js'

/** The slice of TinyApi this tool needs — an interface, so tests can hand in
 *  a plain object without impersonating the class's private fields. */
export interface DeviceApi {
  get(path: string): Promise<any>
  postStatus(path: string, body: any): Promise<{ status: number; body: any }>
}

/** Media-store origins a device reply may point at (see header). */
const MEDIA_ORIGINS = () => [workerUrl(), process.env.TINY_WORKER_URL || ''].filter(Boolean) as string[]

export function isDeviceMediaUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    if (!MEDIA_ORIGINS().some((o) => { try { return new URL(o).origin === u.origin } catch { return false } })) return false
    return /^\/media\/[A-Za-z0-9._-]+$/.test(u.pathname)
  } catch {
    return false
  }
}

/** The worker's capabilities column is a JSON array STRING (null on old
 *  rows) — normalize rather than asking the model to parse a tool result. */
export function parseCapabilities(raw: unknown): string[] {
  let arr: unknown = raw
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  return arr.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean)
}

/**
 * Same name, two rows: a reinstall/restore mints a NEW device row under the
 * same name and orphans the old one with its capability list frozen. Newest
 * last_seen wins per name; rows in a duplicated group get 'current' or
 * 'superseded', unique names get nothing (an ordinary fleet carries no extra
 * field to reason about).
 */
export function duplicateRoles(devices: unknown): Map<string, 'current' | 'superseded'> {
  const out = new Map<string, 'current' | 'superseded'>()
  if (!Array.isArray(devices)) return out
  const nameKey = (d: any) => String(d?.name ?? '').trim().toLowerCase()
  const seenAt = (d: any) => (Number.isFinite(Number(d?.last_seen)) && d?.last_seen != null ? Number(d.last_seen) : null)

  const rows = new Map<string, number>()
  const freshest = new Map<string, number>()
  for (const d of devices as any[]) {
    const key = nameKey(d)
    rows.set(key, (rows.get(key) || 0) + 1)
    const seen = seenAt(d)
    if (seen === null) continue
    const cur = freshest.get(key)
    if (cur === undefined || seen > cur) freshest.set(key, seen)
  }
  for (const d of devices as any[]) {
    const key = nameKey(d)
    if ((rows.get(key) || 0) < 2) continue
    const top = freshest.get(key)
    if (top === undefined) continue
    const seen = seenAt(d)
    out.set(String(d?.id), seen !== null && seen === top ? 'current' : 'superseded')
  }
  return out
}

/** The list projection — pure, so a test can pin every field. */
export function projectDevices(devices: unknown, nowSeconds = Math.floor(Date.now() / 1000)): any[] {
  const rows = Array.isArray(devices) ? devices : []
  const roles = duplicateRoles(rows)
  return rows.map((x: any) => ({
    id: x.id, name: x.name, kind: x.kind, platform: x.platform,
    capabilities: parseCapabilities(x.capabilities),
    // `online` is null for endpoint devices (they never heartbeat — liveness
    // is only known by calling them). Keep the null: coercing to false makes
    // the model report a healthy robot as offline and refuse to use it.
    online: x.online === null ? null : !!x.online,
    ...(x.online === null ? { note: 'reachability unknown until invoked (endpoint device)' } : {}),
    ...(x.url ? { url: x.url } : {}),
    last_seen_seconds_ago: x.last_seen ? nowSeconds - x.last_seen : null,
    ...(roles.get(String(x.id)) === 'superseded'
      ? { superseded: true, note_superseded: 'an OLDER enrollment of this same name — its capability list is frozen at its last heartbeat and is NOT what the device has today; the row of this name without this flag is the device. Never tell the user a device lacks something read off this row.' }
      : roles.get(String(x.id)) === 'current'
        ? { current_for_name: true }
        : {}),
  }))
}

/**
 * Turn a device reply's hosted image URLs into content blocks the model can
 * SEE — image blocks first (computer.ts imageBlock shape), then the text with
 * the hosted URLs. A URL that won't fetch degrades to text-only: the answer
 * the device worked for must not be lost because one GET failed.
 */
export async function deviceReplyBlocks(
  text: string,
  images: unknown,
  fetchImpl: typeof fetch = fetch,
  max = 2,
): Promise<any[] | null> {
  const urls = (Array.isArray(images) ? images : [])
    .map((i: any) => ({ url: String(i?.url || ''), format: (i?.format === 'png' ? 'png' : 'jpeg') as 'png' | 'jpeg' }))
    .filter((i) => isDeviceMediaUrl(i.url))
    .slice(0, max)
  if (!urls.length) return null

  const blocks: any[] = []
  for (const i of urls) {
    const bytes = await fetchImpl(i.url, { signal: AbortSignal.timeout(10_000) } as any)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
    if (bytes) blocks.push({ image: { format: i.format, source: { bytes: Buffer.from(bytes).toString('base64') } } })
  }
  if (!blocks.length) return null
  blocks.push({
    text: `${text}\n\n(The image${blocks.length === 1 ? '' : 's'} above came from the device and ${blocks.length === 1 ? 'is' : 'are'} hosted at: ${urls.map((u) => u.url).join(', ')} — embed with ![…](url) to show the user.)`,
  })
  return blocks
}

export interface UseDeviceOptions {
  /** Poll cadence seams — the 45s contract is 15 × 3000ms; tests shrink it. */
  pollTries?: number
  pollMs?: number
  fetchImpl?: typeof fetch
  /** This machine's own device id (self-invoke guard). Default: loadDevice(). */
  selfDeviceId?: () => string | null
}

export const makeUseDeviceTool = (api: DeviceApi, opts: UseDeviceOptions = {}) => {
  const pollTries = opts.pollTries ?? 15
  const pollMs = opts.pollMs ?? 3000
  const fetchImpl = opts.fetchImpl ?? fetch
  const selfId = opts.selfDeviceId ?? (() => loadDevice()?.deviceId ?? null)

  return tool({
    name: 'use_device',
    description: "Reach the user's OTHER enrolled devices — laptops/daemons from `npx tiny-tech`, phones, and `endpoint` devices (a 3D printer, a robot at its own API). action:'list' shows each device with online presence AND the `capabilities` it declares — match the task to a device that declares the power it needs, and never tell the user a device lacks something without checking that list first. Endpoint devices show online:null (reachability unknown until invoked), not offline. action:'invoke' sends a prompt to a device — its LOCAL agent executes (real shell, real files, its own tools) and the answer comes back here; it waits up to ~45s, and a slower task returns pending:true with an envelope_id instead of failing (the device keeps working and the user gets a push when it finishes). For a clearly long task or an explicit 'in the background', pass wait:false — the envelope_id comes back immediately. action:'result' with that envelope_id fetches the finished result — kept ~24 hours and re-readable. If the device made images during the turn (e.g. a Mac screenshotting its own screen), they come back as images you can SEE plus hosted URLs. Only the owner's devices are reachable; prefer online devices. This machine is itself enrolled — asking it to invoke itself is refused (just do the task locally).",
    inputSchema: z.object({
      action: z.enum(['list', 'invoke', 'result']),
      device_id: z.string().optional().describe('Target device id (from list). Required for invoke.'),
      prompt: z.string().optional().describe('What the device agent should do. Required for invoke.'),
      envelope_id: z.string().optional().describe("Envelope id from a pending invoke (or a batch_*/task_* ticket — every kind redeems identically). Required for action:'result'."),
      wait: z.boolean().optional().describe('invoke only (default true): wait up to ~45s for the answer. false = fire-and-forget — return the pending ticket immediately.'),
    }),
    callback: async (input: any) => {
      // One recv poll + reply parsing — shared by the invoke wait-loop and
      // action:'result' so the two paths can never drift.
      const recvReply = async (envelopeId: string) => {
        const d = await api.get(`/api/devices/relay?inReplyTo=${encodeURIComponent(envelopeId)}`).catch(() => null)
        if (!d?.reply?.payload) return null
        try {
          const parsed = JSON.parse(d.reply.payload)
          return { result: parsed.result ?? parsed, images: parsed?.images }
        } catch {
          return { result: d.reply.payload, images: undefined as unknown }
        }
      }

      // A reply carrying images returns content BLOCKS (pixels the model
      // sees); otherwise the plain object result.
      const shape = async (reply: { result: any; images?: unknown }, extra: Record<string, any>) => {
        const blocks = typeof reply.result === 'string'
          ? await deviceReplyBlocks(reply.result, reply.images, fetchImpl)
          : null
        return blocks ?? { ok: true, ...extra, result: reply.result }
      }

      try {
        if (input.action === 'list') {
          const d = await api.get('/api/devices')
          if (!d?.ok) return { ok: false, error: d?.error || 'device list failed' }
          return { ok: true, devices: projectDevices(d.devices || []) }
        }

        if (input.action === 'result') {
          if (!input.envelope_id) return { ok: false, error: "envelope_id required for action:'result'" }
          const reply = await recvReply(input.envelope_id)
          if (reply) return await shape(reply, { envelope_id: input.envelope_id })
          // Missing reply = still-running OR swept (>24h) — say both, so the
          // agent neither retries forever nor mislabels a delivered task as lost.
          return {
            ok: true, pending: true, envelope_id: input.envelope_id,
            note: 'No result yet — the task may still be running (the user gets a notification when it finishes). Replies are kept ~24h and can be re-read within that window; a result older than a day has been swept.',
          }
        }

        if (!input.device_id || !input.prompt) return { ok: false, error: 'device_id and prompt required for invoke' }

        // Self-guard: an envelope to THIS machine would sit in the mailbox
        // this same process polls — a deadlock dressed as a feature.
        if (input.device_id === selfId()) {
          return { ok: false, note: "that's this machine — just do the task locally with your own tools instead of relaying to yourself." }
        }

        // 🤖 ENDPOINT devices (a robot arm, a printer at its own HTTPS API) are
        // dialed OUT to by the platform — they never poll the relay mailbox, so
        // an envelope to one sits unclaimed for an hour while this tool reports
        // "still working". Resolve the kind first and take the endpoint door:
        // one synchronous agent turn on the device, answer in the same call.
        // A failed lookup falls through to the relay (the pull-device default).
        const row = await api.get('/api/devices')
          .then((d: any) => (d?.devices || []).find((x: any) => String(x.id) === input.device_id))
          .catch(() => undefined)
        if (row?.kind === 'endpoint') {
          const { status, body } = await api.postStatus('/api/devices/endpoint/chat', {
            deviceId: input.device_id, prompt: input.prompt,
          })
          if (!body?.ok) {
            return {
              ok: false, device_id: input.device_id, device: row.name, error: body?.error || `endpoint HTTP ${status}`,
              ...(body?.unreachable ? { note: `${row.name} did not answer — powered off or its tunnel is down. Say it is unreachable rather than retrying.` } : {}),
              ...(body?.timeout ? { note: `${row.name} is up but its agent is still working — robots can take a couple of minutes. Say it is thinking and offer to ask again; do not call it offline.` } : {}),
              ...(body?.unauthorized ? { note: `${row.name} rejected the stored credential — the owner needs to re-enroll it with a fresh token.` } : {}),
            }
          }
          return { ok: true, device_id: input.device_id, device: row.name, result: body.result }
        }

        // Send the envelope. postStatus keeps the HTTP status so the route's
        // typed refusals (404 no such device, 413 too big, 424 relay fault)
        // pass their own error sentence through instead of a generic failure.
        const { status, body } = await api.postStatus('/api/devices/relay', {
          toDevice: input.device_id,
          payload: JSON.stringify({ type: 'invoke', prompt: input.prompt }),
        })
        if (!body?.ok || !body?.id) {
          return { ok: false, device_id: input.device_id, error: body?.error || `relay HTTP ${status}` }
        }

        // 🔥 Fire-and-forget: hand back the claim ticket without burning 45s.
        if (input.wait === false) {
          return {
            ok: true, pending: true, background: true, device_id: input.device_id, envelope_id: body.id,
            note: `Task delivered — running in the background. The user will get a notification when the device finishes; you can also fetch it with use_device action:'result' envelope_id:'${body.id}' (kept ~24h). Tell the user it's off and running.`,
          }
        }

        // Poll for the reply (default ≤45s: 15 × 3s).
        for (let i = 0; i < pollTries; i++) {
          await new Promise((r) => setTimeout(r, pollMs))
          const reply = await recvReply(body.id)
          if (reply) return await shape(reply, { device_id: input.device_id, envelope_id: body.id })
        }
        // NOT a failure — the device is still working; its reply keeps ~24h.
        return {
          ok: true, pending: true, device_id: input.device_id, envelope_id: body.id,
          note: `No reply within ${Math.round((pollTries * pollMs) / 1000)}s — the device is likely still working (or offline: check use_device action:'list'). The task was delivered and the user will get a notification when it finishes; fetch the outcome with use_device action:'result' envelope_id:'${body.id}' anytime in the next ~24h, or tell the user the result will be ready shortly.`,
        }
      } catch (e: any) {
        // AuthRequiredError and friends — devices belong to the user account.
        return { ok: false, error: String(e?.message || e) }
      }
    },
  })
}

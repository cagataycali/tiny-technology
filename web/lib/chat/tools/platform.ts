/**
 * Platform tool factories shared by the interactive chat route AND the
 * scheduled-job runner (/api/job-run) — extracted from the chat route so
 * background jobs run with the owner's real capability set (forged my_*
 * tools, tiny OpenAPI skills, use_telegram) instead of http-only.
 *
 * Everything here is keyed off a userId (not a browser session): the chat
 * route passes session.sub, the job runner passes the job's owner id that
 * the worker cron forwards on the internal-key channel.
 */
import { tool, ImageBlock, TextBlock } from '@strands-agents/sdk'
import { z } from 'zod'
import { validatePublicUrl, usd } from '@/lib/utils'
import { sanitizeToolName } from '@/lib/chat/tool-filter'

const WORKER = 'https://plugin.tiny.technology'
const ikey = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

/**
 * User-tool sandbox proxy — forged tools execute ONLY in the Node runtime
 * (/api/run-tool, internal-key guarded); Vercel's Edge runtime forbids
 * new Function ("code generation from strings").
 */
export const runToolApi = async (
  action: 'validate' | 'run',
  code: string,
  args?: Record<string, any>
) => {
  try {
    const base = process.env.NEXT_PUBLIC_APP_URL || 'https://tiny.technology'
    const res = await fetch(`${base}/api/run-tool`, {
      method: 'POST',
      headers: ikey(),
      body: JSON.stringify({ action, code, args }),
      signal: AbortSignal.timeout(25_000),
    })
    return await res.json()
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * 🔧 Forged tools (issue #8) — rows from the worker's user_tools store,
 * mounted as real my_<name> agent tools. Execution rides the Node sandbox.
 */
export const makeForgedTools = (userToolRows: any[]) =>
  (Array.isArray(userToolRows) ? userToolRows : []).flatMap((row: any) => {
    // Coerce the mounted name to Strands' registry rule, same as
    // buildDynamicTools. create_tool's `name` is model-supplied and only
    // *described* as snake_case — a stored row with a space/punctuation/
    // unicode name (or one long enough that `my_` + name > 64) makes the
    // ToolRegistry THROW inside the Agent constructor, which runs BEFORE the
    // stream's try/catch → an opaque 500 on EVERY chat turn for that user,
    // with no way to remove_tool their way out. Sanitize (or drop) instead.
    const name = sanitizeToolName(`my_${row.name}`)
    if (!name) return []
    let params: Record<string, string> = {}
    try { params = JSON.parse(row.params_json || '{}') } catch { }
    return [tool({
      name,
      description: `[user-forged tool] ${row.description || row.name}`,
      inputSchema: z.object(
        Object.entries(params).reduce((acc, [k, desc]) => {
          acc[k] = z.string().describe(String(desc || k))
          return acc
        }, {} as Record<string, z.ZodString>)
      ),
      callback: async (input: Record<string, any>) => {
        return runToolApi('run', row.code, input)
      },
    })]
  })

/**
 * Dynamic tools from OpenAPI skill descriptors (a tiny's own `worker`
 * spec and/or retrieved universe tinys). Sanitizes names to the Strands
 * registry rule and dedupes (first occurrence wins) — operationIds are
 * user-controlled and a bad/duplicate name THROWS at mount time.
 */
export const buildDynamicTools = (fns: any[]) => {
  const named = (Array.isArray(fns) ? fns : [])
    .map((fn: any) => {
      const name = sanitizeToolName(fn?.name)
      return name ? { ...fn, name } : null
    })
    .filter(Boolean) as any[]
  const unique = Array.from(new Map(named.map(fn => [fn.name, fn])).values())

  return unique.map((fn: any) =>
    tool({
      name: fn.name,
      description: fn.description || `Execute ${fn.name}`,
      inputSchema: z.object(
        Object.entries(fn.parameters?.properties || {}).reduce((acc, [key, prop]: [string, any]) => {
          acc[key] = z.string().describe(prop.description || key)
          return acc
        }, {} as Record<string, z.ZodString>)
      ),
      callback: async (input: Record<string, any>) => {
        if (!fn.worker) return { ok: true, note: "no worker bound for this tool" }

        // Worker URLs come from user-controlled tiny configs — same SSRF
        // rules as /api/worker (https, public hostnames only)
        const checked = validatePublicUrl(fn.worker)
        if ('error' in checked) return { ok: false, error: `worker URL rejected: ${checked.error}` }

        const url = checked.url
        if (fn.path) url.pathname = fn.path
        const method = (fn.method ?? 'GET').toUpperCase()
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }

        // redirect:'error' matches user-tool fetch + /api/worker — a
        // validated public URL must not bounce to an internal address.
        // Parse defensively: a worker returning HTML/empty must not throw
        // an unhandled rejection inside the tool callback.
        const readBody = async (r: Response) => {
          const text = await r.text()
          try { return JSON.parse(text) } catch { return { ok: r.ok, status: r.status, body: text.slice(0, 2000) } }
        }
        if (method === 'GET') {
          Object.entries(input).forEach(([k, v]) => url.searchParams.append(k, String(v)))
          return fetch(url.toString(), { method, headers, redirect: 'error' })
            .then(readBody).catch(e => ({ ok: false, error: String(e?.message || e) }))
        } else {
          return fetch(url.toString(), { method, headers, body: JSON.stringify(input), redirect: 'error' })
            .then(readBody).catch(e => ({ ok: false, error: String(e?.message || e) }))
        }
      },
    })
  )
}

/**
 * 📱 use_telegram (use_aws pattern) — the FULL Bot API as one generic
 * tool. The worker injects the stored token and enforces the chat
 * allowlist; getUpdates/webhook methods are blocked server-side so the
 * agent can't break the polling loop. Works headless: scheduled jobs pass
 * the owner's userId, so a job can proactively message authorized chats.
 */
/**
 * use_device — the web agent's hand into the user's enrolled devices
 * (tiny-node PR6). list → pick a device → invoke: relay envelope goes to
 * the worker, the device daemon polls, executes on ITS local agent
 * (shell/files/mesh), replies; we poll for the reply up to ~45s (nested
 * under the route's agent timeout — AGENTS.md §14).
 *
 * ASYNC CONTRACT (e2e report §3.1): a slow device is NOT a failure. The
 * worker mailbox keeps the device's reply for ~1h (relay.ts SWEEP_AGE_S)
 * whether or not anyone is still waiting — before this contract the 45s
 * timeout returned a dead-end error and the late reply rotted unread. Now
 * invoke times out into { pending: true, envelope_id } and action:'result'
 * re-polls that envelope — same turn, a later turn, or a later conversation.
 *
 * MEDIA CONTRACT (loop item d-d): a device turn that produced images (its
 * use_computer screenshot, an image it generated) uploads them to the media
 * store and lists the hosted URLs in its reply as { result, images:[{url,
 * format}] }. Those come back here as REAL image blocks, so "look at my
 * laptop's screen" returns the screen — not the daemon's prose about it.
 */

/** Media-store origins a device reply may point at. The daemon uploads through
 *  /api/media (session-authed) → the worker's R2 store, so a legitimate image
 *  URL is always `<worker>/media/<uuid>.<ext>`. Anything else is a device (or a
 *  compromised device token) asking this server to fetch an arbitrary URL and
 *  feed the bytes to the model as trusted content — refuse instead. */
const MEDIA_ORIGINS = [WORKER, process.env.TINY_WORKER_URL || ''].filter(Boolean)

export function isDeviceMediaUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    if (!MEDIA_ORIGINS.some(o => { try { return new URL(o).origin === u.origin } catch { return false } })) return false
    return /^\/media\/[A-Za-z0-9._-]+$/.test(u.pathname)
  } catch { return false }
}

/**
 * Turn a device reply's hosted image URLs into content blocks the model can
 * SEE. Same shape as generate_image/screenshot: image blocks first, then the
 * text. A URL that won't fetch degrades to text-only — the answer the device
 * worked for must not be lost because one GET failed.
 */
export async function deviceReplyBlocks(
  text: string,
  images: unknown,
  max = 2,
): Promise<any[] | null> {
  const urls = (Array.isArray(images) ? images : [])
    .map((i: any) => ({ url: String(i?.url || ''), format: i?.format === 'png' ? 'png' : 'jpeg' }))
    .filter(i => isDeviceMediaUrl(i.url))
    .slice(0, max)
  if (!urls.length) return null

  const blocks: any[] = []
  for (const i of urls) {
    const bytes = await fetch(i.url, { cache: 'no-store' })
      .then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
    if (bytes) blocks.push(new ImageBlock({ format: i.format as 'png' | 'jpeg', source: { bytes: new Uint8Array(bytes) } }))
  }
  if (!blocks.length) return null
  blocks.push(new TextBlock(
    `${text}\n\n(The image${blocks.length === 1 ? '' : 's'} above came from the device and ${blocks.length === 1 ? 'is' : 'are'} hosted at: ${urls.map(u => u.url).join(', ')} — embed with ![…](url) to show the user.)`
  ))
  return blocks
}

export const makeUseDeviceTool = (userId: string | null | undefined) => tool({
  name: 'use_device',
  description: "Reach the user's enrolled devices — laptops/daemons from `npx tiny-tech`, and `endpoint` devices, which are machines running their own always-on authenticated API (a 3D printer, a robot). Endpoint devices are invoked exactly the same way, but their reachability is unknown until you call them (online:null, not offline), and they answer synchronously with no pending ticket. action:'list' shows devices with online/offline presence. action:'invoke' sends a prompt to a device — its LOCAL agent executes (real shell, real files, its zenoh mesh) and the answer comes back here; it waits up to ~45s, and a slower task returns pending:true with an envelope_id instead of failing (the device keeps working). action:'result' with that envelope_id fetches the finished result — available for ~1 hour, so you can check later in the conversation or tell the user it will be ready shortly. If the device made images during the turn (e.g. a Mac with the `computer` capability screenshotting its own screen), they come back here as images you can SEE plus hosted URLs — so ask a device to look at its screen when the question is about what's on it. Only the owner's devices are reachable; prefer online devices.",
  inputSchema: z.object({
    action: z.enum(['list', 'invoke', 'result']),
    device_id: z.string().optional().describe('Target device id (from list). Required for invoke.'),
    prompt: z.string().optional().describe('What the device agent should do. Required for invoke.'),
    envelope_id: z.string().optional().describe("Envelope id from a pending invoke. Required for action:'result'."),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, note: 'Login required — devices belong to the user account.' }

    // One recv poll + reply parsing — shared by the invoke wait-loop and the
    // action:'result' re-poll so the two paths can never drift.
    const recvReply = async (envelopeId: string) => {
      const d = await fetch(
        `${WORKER}/device/relay/recv?userId=${encodeURIComponent(userId)}&inReplyTo=${encodeURIComponent(envelopeId)}`,
        { headers: ikey(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => null)
      if (!d?.reply?.payload) return null
      try {
        const parsed = JSON.parse(d.reply.payload)
        return { result: parsed.result ?? parsed, images: parsed?.images }
      } catch {
        return { result: d.reply.payload, images: undefined }
      }
    }

    // A reply carrying images returns content BLOCKS (pixels the model sees);
    // otherwise the plain object result, exactly as before.
    const shape = async (reply: { result: any; images?: unknown }, extra: Record<string, any>) => {
      const blocks = typeof reply.result === 'string'
        ? await deviceReplyBlocks(reply.result, reply.images)
        : null
      return blocks ?? { ok: true, ...extra, result: reply.result }
    }

    if (input.action === 'list') {
      const d = await fetch(`${WORKER}/device/list?userId=${encodeURIComponent(userId)}`, {
        headers: ikey(), cache: 'no-store',
      }).then(r => r.json()).catch(e => ({ error: String(e) }))
      if (d.error) return { ok: false, error: d.error }
      const now = Math.floor(Date.now() / 1000)
      return {
        ok: true,
        devices: (d.devices || []).map((x: any) => ({
          id: x.id, name: x.name, kind: x.kind, platform: x.platform,
          // `online` is null for endpoint devices (they never heartbeat — their
          // liveness is only known by calling them). Keep the null rather than
          // coercing to false, so the model doesn't report a healthy robot as
          // offline and refuse to use it.
          online: x.online === null ? null : !!x.online,
          ...(x.online === null ? { note: 'reachability unknown until invoked (endpoint device)' } : {}),
          ...(x.url ? { url: x.url } : {}),
          last_seen_seconds_ago: x.last_seen ? now - x.last_seen : null,
        })),
      }
    }

    if (input.action === 'result') {
      if (!input.envelope_id) return { ok: false, error: "envelope_id required for action:'result'" }
      const reply = await recvReply(input.envelope_id)
      if (reply) return await shape(reply, { envelope_id: input.envelope_id })
      // At-most-once delivery: an envelope that was already read (or swept
      // after ~1h) polls the same as still-running — say both, so the agent
      // neither retries forever nor mislabels a delivered task as lost.
      return {
        ok: true, pending: true, envelope_id: input.envelope_id,
        note: 'No result yet — the task may still be running. Replies are delivered once and kept ~1h; if this result was already fetched earlier in the conversation, it will not appear again.',
      }
    }

    if (!input.device_id || !input.prompt) return { ok: false, error: 'device_id and prompt required for invoke' }

    // 🤖 Endpoint devices (robots/printers at their own authenticated HTTPS API)
    // are reached by dialing OUT — no mailbox, no poll, no claim ticket. Ask the
    // worker to make the call: it holds the bearer credential, so it never
    // reaches this edge runtime. Resolve the kind first; a stale device_id from
    // earlier in the conversation must not silently take the relay path.
    const kind = await fetch(`${WORKER}/device/list?userId=${encodeURIComponent(userId)}`, {
      headers: ikey(), cache: 'no-store',
    })
      .then(r => r.json())
      .then((d: any) => (d?.devices || []).find((x: any) => x.id === input.device_id)?.kind)
      .catch(() => undefined)

    if (kind === 'endpoint') {
      // 100s: strictly ABOVE the worker's own 90s budget, so the worker is the
      // one that times out and we get its typed {timeout:true} answer. If this
      // side gave up first we'd lose the "still thinking" vs "unreachable"
      // distinction, and an unbounded wait would pin the route. Both numbers are
      // bounded above by /api/job-run's 120s function budget — this tool runs
      // there too, and a wait the caller can't survive is not a wait.
      const d = await fetch(`${WORKER}/device/endpoint/call`, {
        method: 'POST', headers: ikey(),
        body: JSON.stringify({ userId, deviceId: input.device_id, action: 'chat', prompt: input.prompt }),
        signal: AbortSignal.timeout(100_000),
      }).then(r => r.json()).catch(e => ({ error: String(e), timeout: /abort|timeout/i.test(String(e?.message || e)) }))
      if (d?.error) {
        return {
          ok: false, device_id: input.device_id, error: d.error,
          // Name the three failures apart for the model: "asleep", "still
          // thinking" and "our key stopped working" need different things said to
          // the user, and only one of them is worth trying again.
          ...(d.unreachable ? { note: "The device did not answer — it may be powered off or its tunnel is down. Tell the user it's unreachable rather than retrying." } : {}),
          ...(d.timeout ? { note: 'The device is up but its agent is still working — these machines can take a couple of minutes. Tell the user it is thinking and offer to check again, rather than calling it offline.' } : {}),
          ...(d.unauthorized ? { note: 'The device is up but rejected our credential — the owner needs to re-enroll it with a fresh token.' } : {}),
        }
      }
      // Dashboards answer {reply|result|text}; hand back whatever it said.
      const r = d?.result
      const said = typeof r === 'string' ? r : (r?.reply ?? r?.result ?? r?.text ?? r)
      return { ok: true, device_id: input.device_id, result: said }
    }

    // 1. send the envelope
    const sent = await fetch(`${WORKER}/device/relay/send`, {
      method: 'POST', headers: ikey(),
      body: JSON.stringify({
        userId, toDevice: input.device_id,
        payload: JSON.stringify({ type: 'invoke', prompt: input.prompt }),
      }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    if (sent.error || !sent.id) return { ok: false, error: sent.error || 'send failed' }

    // 2. poll for the reply (≤45s: 15 × 3s — inside the route's 300s budget,
    //    and inside job-run's 50s when a scheduled job uses this tool)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const reply = await recvReply(sent.id)
      if (reply) return await shape(reply, { device_id: input.device_id, envelope_id: sent.id })
    }
    // 3. NOT a failure — hand back the claim ticket. The device is still
    //    working and its reply will sit in the worker mailbox for ~1h.
    return {
      ok: true, pending: true, device_id: input.device_id, envelope_id: sent.id,
      note: `No reply within 45s — the device is likely still working (or offline: check use_device action:'list'). The task was delivered; fetch the outcome with use_device action:'result' envelope_id:'${sent.id}' later in this conversation, or tell the user the result will be ready shortly.`,
    }
  },
})

/**
 * 🖼️ generate_image — on-device image generation (docs/on-device-genai-
 * research-2026-07.md). Unlike the fire-and-forget client tools, this one
 * ROUND-TRIPS: the phone sees the beforeToolCallEvent, generates with the
 * platform's on-device model (iOS Image Playground ImageCreator today),
 * uploads the JPEG once via /api/media (R2), and posts {toolUseId, key, url}
 * to the worker mailbox — which this callback is polling. The result returns
 * to the model as a REAL image block (the model sees the picture it made)
 * plus the hosted URL for embedding/sharing.
 *
 * Mounted only for sessions whose surface can execute it (x-tiny-session
 * gates it in the chat route) — mounting it for a client with no executor
 * would strand the callback until timeout on every call.
 */
export const makeGenerateImageTool = (userId: string | null | undefined) => tool({
  name: 'generate_image',
  description: "Generate an image ON the user's device (on-device model — private, free, a few seconds). The finished image comes back into this conversation as an image you can SEE, plus a hosted URL. Use it when the user asks to create, draw, imagine, or illustrate something. Styles: animation (3D-render look, default), illustration (flat artwork), sketch (hand-drawn). Keep prompts to concrete visual concepts (subjects, attributes, mood, setting); on-device generation is stylized — it does not do photorealism or text rendering.",
  inputSchema: z.object({
    prompt: z.string().max(600).describe('What to picture — concrete visual concepts work best (subject, attributes, setting, mood)'),
    style: z.enum(['animation', 'illustration', 'sketch']).optional().describe('Visual style (default animation)'),
  }),
  callback: async (_input, context) => {
    if (!userId) return { ok: false, error: 'Login required — on-device generation needs the user account.' }
    const toolUseId = context?.toolUse?.toolUseId
    if (!toolUseId) return { ok: false, error: 'internal: missing toolUseId' }

    // The executing device is the one holding THIS stream — it saw the
    // beforeToolCallEvent the moment we entered this callback and is now
    // generating + uploading. Poll the mailbox (2s × 45 = 90s; ImageCreator
    // takes single-digit seconds, upload a couple more — 90s covers a cold
    // Apple-Intelligence model load without pinning the route forever).
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const d = await fetch(
        `${WORKER}/device/tool-result?userId=${encodeURIComponent(userId)}&toolUseId=${encodeURIComponent(toolUseId)}`,
        { headers: ikey(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => null)
      const raw = d?.result?.payload
      if (!raw) continue

      let p: any
      try { p = JSON.parse(raw) } catch { return { ok: false, error: 'device posted an unreadable result' } }
      if (!p?.ok) return { ok: false, error: String(p?.error || 'generation failed on the device') }
      if (!p.url) return { ok: false, error: 'device result missing media url' }

      // Return the actual pixels to the model (base64 image block) + the
      // hosted URL as text. Bytes come from R2, not the mailbox — the
      // mailbox row stays tiny and the image was uploaded exactly once.
      const bytes = await fetch(String(p.url), { cache: 'no-store' })
        .then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
      const note = new TextBlock(
        `Image generated on the user's device and shown to them. Hosted at: ${p.url} — embed with ![…](${p.url}) or share the link if useful.`
      )
      if (!bytes) return { ok: true, url: p.url, note: note.text }
      return [
        new ImageBlock({ format: p.format === 'png' ? 'png' : 'jpeg', source: { bytes: new Uint8Array(bytes) } }),
        note,
      ]
    }
    return { ok: false, error: 'The device did not return an image within 90s — generation may be unsupported on this hardware (needs Apple Intelligence), still downloading its model, or the app went to background mid-generation.' }
  },
})

/**
 * 📸 screenshot — capture THIS device's screen and return it as a real image
 * block the model can SEE. generate_image's twin: the identical round-trip
 * (device sees beforeToolCallEvent → captures → uploads once to /api/media →
 * posts {toolUseId, key, url} to /api/chat/tool-result → this callback polls
 * /device/tool-result → returns an ImageBlock from the R2 bytes). Only the
 * device-side "make pixels" step differs (screen capture vs generation), so
 * NO new worker endpoints — R2 + the tool-result mailbox + the ImageBlock
 * return are all shared with generate_image.
 *
 * Product decisions (2026-07-23): iOS captures the WHOLE screen via ReplayKit
 * (self-window fallback when denied), and consent is asked EVERY capture — a
 * screen can hold anything sensitive, so this is never silent. The system
 * recording indicator stays visible. Mounted only for native sessions whose
 * client can execute it (the chat route gates it, like generate_image);
 * mounting it for a browser (which can't usefully screenshot itself in an
 * agent turn — getDisplayMedia needs a user gesture) would strand the
 * callback until timeout on every call.
 */
export const makeScreenshotTool = (userId: string | null | undefined) => tool({
  name: 'screenshot',
  description: "Capture what's currently on the user's device screen and receive it back as an image you can SEE (native apps only). The user is asked to allow the capture first, and the system shows a recording indicator — so use it when the user asks you to look at their screen, help with what they're seeing, read something on it, or troubleshoot a visible problem. Captures the whole screen (whatever app is in front); it can't see DRM-protected/secure content. Nothing leaves the user's account except one hosted still.",
  inputSchema: z.object({
    reason: z.string().max(200).optional().describe("Optional short human-readable reason shown to the user with the consent prompt, e.g. \"to read the error on your screen\""),
  }),
  callback: async (_input, context) => {
    if (!userId) return { ok: false, error: 'Login required — screen capture needs the user account.' }
    const toolUseId = context?.toolUse?.toolUseId
    if (!toolUseId) return { ok: false, error: 'internal: missing toolUseId' }

    // The executing device is the one holding THIS stream — it saw the
    // beforeToolCallEvent the moment we entered this callback and is now
    // prompting for consent, capturing, and uploading. Poll the mailbox
    // (2s × 45 = 90s: covers the consent tap + ReplayKit frame + upload; a
    // user who ignores the prompt simply times out below).
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const d = await fetch(
        `${WORKER}/device/tool-result?userId=${encodeURIComponent(userId)}&toolUseId=${encodeURIComponent(toolUseId)}`,
        { headers: ikey(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => null)
      const raw = d?.result?.payload
      if (!raw) continue

      let p: any
      try { p = JSON.parse(raw) } catch { return { ok: false, error: 'device posted an unreadable result' } }
      // The user declining the consent prompt is a first-class outcome, not an
      // error the model should retry — surface it plainly.
      if (p?.denied) return { ok: false, denied: true, note: 'The user declined the screen capture.' }
      if (!p?.ok) return { ok: false, error: String(p?.error || 'screen capture failed on the device') }
      if (!p.url) return { ok: false, error: 'device result missing media url' }

      // Return the actual pixels to the model (base64 image block). Bytes come
      // from R2, not the mailbox — the mailbox row stays tiny and the image
      // was uploaded exactly once.
      const bytes = await fetch(String(p.url), { cache: 'no-store' })
        .then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
      const note = new TextBlock(
        `Screenshot captured from the user's device (they approved it). This is what's on their screen right now.`
      )
      if (!bytes) return { ok: true, url: p.url, note: note.text }
      return [
        new ImageBlock({ format: p.format === 'png' ? 'png' : 'jpeg', source: { bytes: new Uint8Array(bytes) } }),
        note,
      ]
    }
    return { ok: false, error: 'The device did not return a screenshot within 90s — the user may not have responded to the capture prompt, screen capture may be unavailable, or the app went to background.' }
  },
})

/**
 * 🕶️ meta_take_photo — one photo through the user's Meta AI glasses.
 * screenshot's twin at one more remove: identical round-trip (the phone sees
 * the beforeToolCallEvent → runs a DAT camera session against the linked
 * glasses → uploads the JPEG once to /api/media → posts {toolUseId, url} to
 * the mailbox this callback polls), only the "make pixels" step differs —
 * the glasses camera, i.e. what the USER is looking at, not the screen.
 *
 * Mounted only for sessions whose client carries the DAT executor (the chat
 * route gates it like generate_image); a client with no glasses posts a
 * fast, honest {ok:false} (not linked / permission missing), so the poll
 * never strands on the common failure.
 */
export const makeMetaTakePhotoTool = (userId: string | null | undefined) => tool({
  name: 'meta_take_photo',
  description: "Take a photo through the user's Meta AI glasses camera and receive it back as an image you can SEE — this is what the USER is physically looking at right now. Use it when they ask what they're looking at, to read/identify/remember something in front of them, or to capture the moment. Requires their glasses to be linked (Settings → Meta glasses) and worn; capture takes a few seconds. One still per call.",
  inputSchema: z.object({
    reason: z.string().max(200).optional().describe('Optional short reason, e.g. "to read the menu you\'re looking at"'),
  }),
  callback: async (_input, context) => {
    if (!userId) return { ok: false, error: 'Login required — the glasses belong to the user account.' }
    const toolUseId = context?.toolUse?.toolUseId
    if (!toolUseId) return { ok: false, error: 'internal: missing toolUseId' }

    // The executing phone saw the beforeToolCallEvent and is running the
    // glasses session now. Poll the mailbox (2s × 45 = 90s: session start +
    // stream up + capture + upload over BT/Wi-Fi; not-linked posts instantly).
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const d = await fetch(
        `${WORKER}/device/tool-result?userId=${encodeURIComponent(userId)}&toolUseId=${encodeURIComponent(toolUseId)}`,
        { headers: ikey(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => null)
      const raw = d?.result?.payload
      if (!raw) continue

      let p: any
      try { p = JSON.parse(raw) } catch { return { ok: false, error: 'device posted an unreadable result' } }
      if (!p?.ok) return { ok: false, error: String(p?.error || 'the glasses photo failed on the device') }
      if (!p.url) return { ok: false, error: 'device result missing media url' }

      // Real pixels to the model (bytes from R2, uploaded exactly once).
      const bytes = await fetch(String(p.url), { cache: 'no-store' })
        .then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
      const note = new TextBlock(
        `Photo taken through the user's Meta glasses — this is what they are looking at. Hosted at: ${p.url} — embed with ![…](${p.url}) if useful.`
      )
      if (!bytes) return { ok: true, url: p.url, note: note.text }
      return [
        new ImageBlock({ format: p.format === 'png' ? 'png' : 'jpeg', source: { bytes: new Uint8Array(bytes) } }),
        note,
      ]
    }
    return { ok: false, error: 'The glasses did not return a photo within 90s — they may be off, out of Bluetooth range, mid-firmware-update, or the app went to background during capture.' }
  },
})

/**
 * 🎥 meta_record_video — TOGGLE-semantics recording through the glasses.
 * First call starts the clip (the device answers fast with recording:true);
 * second call stops it: the phone finalizes the MP4, uploads it once to
 * /api/media, uploads up to 4 sampled frames, and posts URLs to the mailbox.
 * Models can't watch MP4s, so the frames come back as REAL image blocks —
 * the agent sees what the clip contains — beside the hosted video URL.
 * Clips auto-stop at ~30s (the media store caps uploads at 6MB); if the
 * auto-stop fired first, the second call simply collects the finished clip.
 */
export const makeMetaRecordVideoTool = (userId: string | null | undefined) => tool({
  name: 'meta_record_video',
  description: "Record a video through the user's Meta AI glasses camera. TOGGLE: call once to START recording (you'll get confirmation), continue the conversation, then call again to STOP — you'll receive a few frames from the clip as images you can SEE plus the hosted video URL to share (embed with a plain link). Clips auto-stop at ~30 seconds. Requires linked, worn glasses (the capture LED is on while recording).",
  inputSchema: z.object({
    reason: z.string().max(200).optional().describe('Optional short reason for the recording'),
  }),
  callback: async (_input, context) => {
    if (!userId) return { ok: false, error: 'Login required — the glasses belong to the user account.' }
    const toolUseId = context?.toolUse?.toolUseId
    if (!toolUseId) return { ok: false, error: 'internal: missing toolUseId' }

    // Start answers in a few seconds; stop needs finalize+upload (~15s worst).
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const d = await fetch(
        `${WORKER}/device/tool-result?userId=${encodeURIComponent(userId)}&toolUseId=${encodeURIComponent(toolUseId)}`,
        { headers: ikey(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => null)
      const raw = d?.result?.payload
      if (!raw) continue

      let p: any
      try { p = JSON.parse(raw) } catch { return { ok: false, error: 'device posted an unreadable result' } }
      if (!p?.ok) return { ok: false, error: String(p?.error || 'recording failed on the device') }

      // START leg: nothing to fetch, just tell the model it's rolling.
      if (p.recording) {
        return { ok: true, recording: true, note: '🔴 Recording started on the glasses (LED on). Call meta_record_video again to stop — it auto-stops at ~30s.' }
      }

      // STOP leg: video URL + sampled frames the model can SEE.
      if (!p.url) return { ok: false, error: 'device result missing the clip url' }
      const frameUrls: string[] = Array.isArray(p.frames) ? p.frames.slice(0, 4) : []
      const blocks: any[] = []
      for (const u of frameUrls) {
        const bytes = await fetch(String(u), { cache: 'no-store' })
          .then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
        if (bytes) blocks.push(new ImageBlock({ format: 'jpeg', source: { bytes: new Uint8Array(bytes) } }))
      }
      blocks.push(new TextBlock(
        `Recording stopped — ${p.seconds ? `${p.seconds}s clip` : 'clip'} from the user's glasses hosted at: ${p.url} (share as a plain link). The image${blocks.length === 1 ? '' : 's'} above ${blocks.length === 1 ? 'is a frame' : 'are frames'} sampled from it.`
      ))
      return blocks
    }
    return { ok: false, error: 'The glasses did not answer within 90s — recording may be unavailable (glasses off/out of range) or the app went to background.' }
  },
})

/**
 * 👂 meta_listen — a few seconds of the glasses microphone, returned as an
 * ON-DEVICE transcript. The audio never leaves the phone (Apple local STT,
 * requiresOnDeviceRecognition) — only the text rides the mailbox. If the
 * live HUD's transcriber is already running, the phone rides it instead of
 * fighting over the mic tap.
 */
export const makeMetaListenTool = (userId: string | null | undefined) => tool({
  name: 'meta_listen',
  description: "Listen through the user's Meta AI glasses microphone for a few seconds and receive a transcript of what was said around them. Transcription happens ON their phone — audio never uploads, you only get text. Use when the user asks you to listen, catch what someone is saying, take a voice note, or transcribe their surroundings. Requires linked, worn glasses.",
  inputSchema: z.object({
    seconds: z.number().int().min(3).max(30).optional().describe('How long to listen (default 10)'),
  }),
  callback: async (_input, context) => {
    if (!userId) return { ok: false, error: 'Login required — the glasses belong to the user account.' }
    const toolUseId = context?.toolUse?.toolUseId
    if (!toolUseId) return { ok: false, error: 'internal: missing toolUseId' }

    // Up to 30s of listening + route setup — the 90s poll covers it.
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const d = await fetch(
        `${WORKER}/device/tool-result?userId=${encodeURIComponent(userId)}&toolUseId=${encodeURIComponent(toolUseId)}`,
        { headers: ikey(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => null)
      const raw = d?.result?.payload
      if (!raw) continue

      let p: any
      try { p = JSON.parse(raw) } catch { return { ok: false, error: 'device posted an unreadable result' } }
      if (!p?.ok) return { ok: false, error: String(p?.error || 'listening failed on the device') }
      const transcript = String(p.transcript || '').trim()
      if (!transcript) {
        return { ok: true, transcript: '', note: String(p.note || 'Heard nothing — silence, or the glasses mic was not the active audio route.') }
      }
      return { ok: true, transcript, note: 'On-device transcript of what the glasses heard — the audio itself never left the phone.' }
    }
    return { ok: false, error: 'The glasses did not answer within 90s — they may be off, out of range, or the app went to background.' }
  },
})

/**
 * 🕶️ meta_glasses_status — an on-demand hardware poll (the per-message
 * context carries the same facts, but a tool lets the agent CHECK before a
 * capture mid-conversation, or answer "are my glasses connected?" exactly).
 * The phone answers instantly from state it already holds — short poll.
 */
export const makeMetaGlassesStatusTool = (userId: string | null | undefined) => tool({
  name: 'meta_glasses_status',
  description: "Check the user's Meta AI glasses right now: linked? connected and ready for capture? device names/types, thermal level, whether the live feed is open or a recording is running. Instant — use it before captures or when the user asks about their glasses.",
  inputSchema: z.object({}),
  callback: async (_input, context) => {
    if (!userId) return { ok: false, error: 'Login required.' }
    const toolUseId = context?.toolUse?.toolUseId
    if (!toolUseId) return { ok: false, error: 'internal: missing toolUseId' }

    // The device answers from memory — 30s poll is generous.
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const d = await fetch(
        `${WORKER}/device/tool-result?userId=${encodeURIComponent(userId)}&toolUseId=${encodeURIComponent(toolUseId)}`,
        { headers: ikey(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => null)
      const raw = d?.result?.payload
      if (!raw) continue
      try { return JSON.parse(raw) } catch { return { ok: false, error: 'device posted an unreadable result' } }
    }
    return { ok: false, error: 'The device did not answer within 30s — the app may be backgrounded.' }
  },
})

/**
 * 💰 wallet — the READ side of the money surface, mounted for the agent.
 *
 * Until now the agent could PRICE (set_price) and QUOTE (pay_x402) but could
 * not answer "what's my balance?" or "what did I spend yesterday?" — the only
 * balance it ever saw was the one embedded in a 402 failure string, so it
 * either guessed or bounced the user to /wallet for a number it could fetch.
 * This tool reads the same worker endpoint the /api/wallet proxy uses
 * (GET /pay/balance → balance + newest-50 ledger rows).
 *
 * Deliberately READ-ONLY, matching the tiny-tech delegated-agent precedent
 * (agent/tiny-tools.ts: no faucet/claim/confirm): every money-MOVING action
 * stays behind an explicit user step — pay_x402's confirm card, the /wallet
 * page's faucet/claim/withdraw buttons. A prompt-injected message can make
 * the model call this and learn a number the user could already see; it can
 * never make it spend.
 */
export const makeWalletTool = (userId: string | null | undefined) => tool({
  name: 'wallet',
  description: `Read the signed-in user's tiny wallet: live balance plus their recent ledger (payments made and received, deposits and faucet credits, refunds, withdrawals, platform fees). READ-ONLY — this cannot move money: pricing is set_price, paying another agent is pay_x402 (the user confirms), top-ups and withdrawals live on /wallet. Use it whenever the user asks about their balance, spending, earnings, or whether a payment went through — read the ledger instead of guessing or pointing them at a page for a number you can fetch.`,
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe('Recent ledger entries to return (default 10, max 50 — the worker keeps the newest 50)'),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, error: 'Login required — the wallet belongs to the user account.' }
    const d: any = await fetch(`${WORKER}/pay/balance?userId=${encodeURIComponent(userId)}`, {
      headers: ikey(), cache: 'no-store', signal: AbortSignal.timeout(10_000),
    }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))
    if (!d || d.error || typeof d.balance_micro !== 'number') {
      return { ok: false, error: String(d?.error || 'wallet service unreachable'), response: 'Could not read the wallet right now — the balance is always visible at /wallet.' }
    }
    const limit = input.limit ?? 10
    const rows: any[] = Array.isArray(d.history) ? d.history : []
    // Model-readable entries: a signed micro int invites arithmetic slips in
    // relayed prose, so pre-format with the shared usd() (Rule B — the same
    // formatter every wallet surface and payment string uses) and make the
    // direction a word instead of a sign.
    const recent = rows.slice(0, limit).map((h: any) => ({
      amount: usd(Math.abs(Number(h.delta_micro) || 0)),
      direction: (Number(h.delta_micro) || 0) < 0 ? 'out' : 'in',
      kind: h.kind,
      ...(h.counterparty ? { counterparty: h.counterparty } : {}),
      ...(h.ref ? { ref: h.ref } : {}),
      created: h.created,
    }))
    return {
      ok: true,
      balance: usd(d.balance_micro),
      balance_micro: d.balance_micro,
      recent,
      ...(rows.length > recent.length ? { more: `${rows.length - recent.length} more entries fetched — call again with a higher limit to see them` } : {}),
      note: 'kinds: invoke_debit = paid a tiny per message · invoke_credit = earned from a tiny the user owns · deposit = top-up (on-chain claim or faucet) · spend_debit = x402 payment to another agent · refund/spend_refund/spend_reimburse = money returned · platform_fee = the flat $0.001 fee · withdrawal = payout. Times are UTC. The full page (top-up, deposit, withdraw) is /wallet.',
    }
  },
})

export const makeUseTelegramTool = (userId: string | null | undefined) => tool({
  name: 'use_telegram',
  description: `Call ANY Telegram Bot API method with the user's connected bot (like use_aws for AWS). Proactively send rich content to their authorized chats: sendMessage (parse_mode MarkdownV2/HTML), sendPhoto/sendVideo/sendAudio/sendVoice/sendDocument/sendAnimation (pass a public https URL or Telegram file_id as the media param — Telegram fetches it), sendLocation, sendPoll, sendDice, sendChatAction (typing…), editMessageText, deleteMessage, pinChatMessage, forwardMessage, getChat, getFile, answerCallbackQuery, setMessageReaction… Confirmation menus: pass reply_markup with inline_keyboard buttons (their presses arrive as messages on the event bus). Method names and params exactly as in the Bot API docs (params as a JSON object; chat_id must be an authorized chat — check the telegram tool's status for the allowlist). Blocked: getUpdates, set/deleteWebhook, logOut, close (they'd break the bot's polling loop).`,
  inputSchema: z.object({
    method: z.string().describe('Bot API method name, e.g. sendPhoto, sendPoll, editMessageText'),
    params: z.record(z.string(), z.any()).optional().describe('Method parameters per Bot API docs, e.g. {chat_id: "123", photo: "https://…", caption: "…"}'),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, note: 'Login required — the bot attaches to the user account.' }
    return fetch(`${WORKER}/telegram/api`, {
      method: 'POST',
      headers: ikey(),
      body: JSON.stringify({
        userId,
        method: input.method,
        params: JSON.stringify(input.params || {}),
      }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
  },
})

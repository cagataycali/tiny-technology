/**
 * 🐬 flipper_* — named tools for a Flipper Zero, from anywhere.
 *
 * A THIRD roster, and the reason is that the Flipper reaches tiny.technology by
 * a different route than either necklace. The Nicla Vision is its own node: WiFi,
 * its own device token, it polls the relay, so it is `platform === 'nicla-vision'`
 * and resolving it means finding that row. The Nicla Voice has no WiFi, so a
 * paired phone relays it. The Flipper has neither WiFi nor a tiny.technology
 * client — what it has is a USB cable into a laptop that is ALREADY an enrolled
 * node running `use_flipper` (tiny-tech/src/agent/flipper.ts).
 *
 * So there is no `platform === 'flipper-zero'` row to look for, and inventing one
 * would be a lie about the topology: nothing would ever heartbeat as it. The
 * Flipper is a CAPABILITY OF ITS HOST, which is exactly how the host declares it
 * — `hasFlipper()` pushes the label `flipper` into the heartbeat capability list
 * (tiny-tech/src/agent/device-tools.ts), live, so unplugging the cable removes it
 * within 30s. These tools therefore resolve a host BY CAPABILITY and send it an
 * envelope naming the use_flipper action to run.
 *
 * What that buys, and it is the whole point of the request: the Flipper stops
 * being a thing you can only drive while sitting at the laptop. From a phone, the
 * web chat, or a scheduled job, the agent can listen for an IR code or read a
 * 125kHz card on hardware in another room — the same reach the necklace has.
 *
 * Honesty constraints, each one measured on the device (firmware unlshd-075):
 *   • NO NFC TOOL. `nfc` appears in the firmware's `help` but its subcommand list
 *     is empty; `nfc detect`, `nfc read` and `nfc field` all return the same bare
 *     usage block. A flipper_scan_nfc would be a tool that can only ever fail,
 *     and its failure would read like "no tag present". Reading 13.56MHz needs
 *     the on-screen app. flipper_files finds already-saved .nfc captures instead.
 *   • NO APP-LAUNCH TOOL. `loader open` works and cannot be undone: this
 *     firmware's loader has list/open/info and no close, and once an app holds
 *     the hardware every other command answers "Other application is running".
 *     Synthetic back-presses do not dismiss it — recovery measured to need
 *     `power reboot`. An agent that launches an app disables its own toolset.
 *   • RECEIVE IS A TOOL, TRANSMIT IS NOT. flipper_listen captures IR/Sub-GHz/RFID
 *     /iButton. Replaying a signal is physical action on someone's property —
 *     a gate, a car, a lock — so it stays behind use_device, where the prompt the
 *     user wrote is visible in the transcript, rather than behind a convenient
 *     named tool the agent can reach for on its own initiative.
 */
import { z } from 'zod'
import { tool } from '@strands-agents/sdk'

const WORKER = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
const ikey = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

/** The capability label a host node declares while a Flipper is plugged in. */
export const FLIPPER_CAP = 'flipper'

/**
 * Longest listen window a tool will ask for. The host holds its serial lock (and
 * the Flipper's radio) for the whole capture, so this is also how long the node
 * cannot answer anything else.
 */
export const MAX_LISTEN_S = 30

/** Parse the worker's capabilities column: JSON array string, array, or null. */
export function parseCaps(raw: unknown): string[] {
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(p) ? p.map((c: any) => String(c).toLowerCase()) : []
  } catch {
    // A malformed blob must not fail a status read — the device is still there.
    return []
  }
}

/**
 * The host node with a Flipper attached, online one first.
 *
 * Note what "online" means here, because it differs from both necklaces: it is
 * the LAPTOP heartbeating. A 🟢 means the host is reachable and had a Flipper on
 * a serial port at its last beat (≤30s ago). The Flipper itself has no presence
 * of its own and never will — it cannot report anything without the cable.
 */
export async function resolveFlipperHost(userId: string):
    Promise<{ id: string; name: string; online: boolean; platform: string } | null> {
  const d = await fetch(`${WORKER}/device/list?userId=${encodeURIComponent(userId)}`, {
    headers: ikey(), cache: 'no-store',
  }).then(r => r.json()).catch(() => null)
  const hosts = (d?.devices || []).filter((x: any) => parseCaps(x.capabilities).includes(FLIPPER_CAP))
  if (!hosts.length) return null
  const best = hosts.find((x: any) => x.online) || hosts[0]
  return {
    id: best.id,
    name: String(best.name ?? 'host'),
    online: !!best.online,
    platform: String(best.platform ?? ''),
  }
}

/**
 * Send the host an instruction to run one use_flipper action, then poll.
 *
 * The envelope carries a natural-language prompt because that is the only shape
 * the relay defines ({type:'invoke', prompt}) and the host answers it with a full
 * agent turn. Being explicit about the action and its arguments keeps the host
 * from improvising a different one — and keeps the transcript readable about what
 * was actually asked of the hardware.
 */
async function flipperInvoke(userId: string, instruction: string, waitS: number):
    Promise<{ result?: string; error?: string; offline?: boolean }> {
  const host = await resolveFlipperHost(userId)
  if (!host) {
    return {
      error: 'No Flipper Zero is reachable. It appears on the account when it is plugged into a machine running the tiny CLI (`npx tiny-tech mesh`) — the host declares it within 30s of the cable going in.',
    }
  }
  if (!host.online) {
    return {
      offline: true,
      error: `"${host.name}" — the machine the Flipper is plugged into — is not heartbeating, so nothing can reach the Flipper right now. It is asleep, offline, or the tiny CLI is not running. The Flipper has no network of its own.`,
    }
  }

  const sent = await fetch(`${WORKER}/device/relay/send`, {
    method: 'POST', headers: ikey(),
    body: JSON.stringify({
      userId, toDevice: host.id,
      payload: JSON.stringify({ type: 'invoke', prompt: instruction }),
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
      return { result: String(p.result ?? '') }
    } catch {
      return { result: String(d.reply.payload) }
    }
  }
  return {
    error: `No answer within ${waitS}s. A capture holds the device for its whole window, so the host may still be listening — ask again, or read the outcome with use_device.`,
  }
}

/**
 * Poll budget. A listen action cannot answer before its own window elapses, so
 * the wait must exceed it — plus the host's agent turn and the ≤5s relay poll.
 * A scheduled job's deadline clamps it (jobs die at JOB_DEADLINE_S), and if the
 * listen alone would outlive the budget the tool says so instead of timing out.
 */
export function listenBudget(listenS: number, budgetS?: number): number {
  const need = listenS + 20
  if (!budgetS) return need
  return Math.min(need, Math.max(15, budgetS - 8))
}

export const makeFlipperStatusTool = (userId: string | null | undefined) => tool({
  name: 'flipper_status',
  description: "Check whether the user's Flipper Zero is reachable: which machine it is plugged into, whether that machine is online right now, and the Flipper's firmware and battery. Use this before any other flipper_* tool, and to answer 'is my Flipper connected?'. Cheap and fast.",
  inputSchema: z.object({}),
  callback: async () => {
    if (!userId) return { ok: false, error: 'Login required — devices belong to the user account.' }
    const host = await resolveFlipperHost(userId)
    if (!host) {
      return {
        ok: false,
        error: 'No Flipper Zero is reachable on this account. Plug it into a machine running the tiny CLI (`npx tiny-tech mesh`); it is declared automatically within 30s.',
      }
    }
    if (!host.online) {
      return {
        ok: true, reachable: false, host: host.name,
        note: `The Flipper was last seen plugged into "${host.name}", but that machine is not heartbeating — so the Flipper is unreachable. It has no network of its own: whatever it is doing now, nobody can ask it.`,
      }
    }
    const r = await flipperInvoke(userId, 'Run use_flipper with action "info", then use_flipper with action "power_info". Report the firmware version, hardware model, battery charge level and charge state. Do not run any other action.', 45)
    if (r.error) return { ok: false, host: host.name, error: r.error }
    return { ok: true, reachable: true, host: host.name, host_platform: host.platform, details: r.result }
  },
})

export const makeFlipperListenTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'flipper_listen',
  description: `Capture a signal on the user's Flipper Zero and report what it received — the Flipper LISTENS, it does not transmit here. Radios:
- "ir" — an infrared remote: decodes protocol + address + command (point the remote at the Flipper's top edge)
- "subghz" — 433/868MHz radio traffic at a given frequency (key fobs, sensors, doorbells)
- "rfid" — a 125kHz proximity card held against the Flipper's back
- "ibutton" — a Dallas/Cyfral/Metakom key touched to its contacts
This BLOCKS for the whole listen window and needs a human to present the card or press the remote during it, so say what you are about to do before calling it. 13.56MHz NFC is NOT available (this firmware has no NFC CLI) — use flipper_files to find tags already saved on the SD card.`,
  inputSchema: z.object({
    radio: z.enum(['ir', 'subghz', 'rfid', 'ibutton']).describe('Which radio to listen on.'),
    seconds: z.number().int().min(1).max(MAX_LISTEN_S).optional()
      .describe(`Listen window, 1-${MAX_LISTEN_S}s (default 8). The Flipper is fully occupied for this long.`),
    frequency: z.number().optional()
      .describe('subghz only: Hz, e.g. 433920000 (default) or 868350000.'),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, error: 'Login required — devices belong to the user account.' }
    const secs = Math.max(1, Math.min(input.seconds ?? 8, MAX_LISTEN_S))
    const wait = listenBudget(secs, budgetS)
    // A job with 20s left cannot host a 30s capture. Say that, rather than
    // starting a listen the caller is guaranteed to abandon — the host would go
    // on holding the radio after the answer stopped being wanted.
    if (wait < secs + 5) {
      return {
        ok: false,
        error: `A ${secs}s capture needs longer than this turn has left. Ask for a shorter window (or run it from an interactive chat).`,
      }
    }
    const action =
      input.radio === 'ir' ? `action "ir_rx" with duration ${secs}`
      : input.radio === 'subghz' ? `action "subghz_rx" with duration ${secs} and frequency ${Math.round(input.frequency ?? 433_920_000)}`
      : input.radio === 'rfid' ? `action "rfid_read" with duration ${secs}`
      : `action "ikey_read" with duration ${secs}`
    const r = await flipperInvoke(
      userId,
      `Run use_flipper with ${action}. Report its output verbatim, including the case where nothing was received. Do not run any other action and do not transmit anything.`,
      wait,
    )
    if (r.error) return { ok: false, error: r.error, offline: r.offline }
    return { ok: true, radio: input.radio, listened_s: secs, captured: r.result }
  },
})

export const makeFlipperFilesTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'flipper_files',
  description: "Browse what is saved on the user's Flipper Zero SD card — their captured signals and scanned tags, by folder: /ext/infrared (.ir remotes), /ext/subghz (.sub captures), /ext/nfc (.nfc tags), /ext/lfrfid (125kHz cards), /ext/ibutton. Use this to answer 'what have I saved?' or to find a file before doing anything with it. LISTS names and sizes only — it does not read a file's contents, because those folders hold the user's real IDs, bank cards and door keys.",
  inputSchema: z.object({
    folder: z.string().optional()
      .describe('Flipper path to list, default /ext. e.g. /ext/subghz'),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, error: 'Login required — devices belong to the user account.' }
    const folder = (input.folder || '/ext').trim()
    const r = await flipperInvoke(
      userId,
      `Run use_flipper with action "ls" and path "${folder}". Report the listing verbatim. Do not read, send, receive or delete any file, and do not run any other action.`,
      Math.min(45, listenBudget(0, budgetS)),
    )
    if (r.error) return { ok: false, error: r.error, offline: r.offline }
    return { ok: true, folder, listing: r.result }
  },
})

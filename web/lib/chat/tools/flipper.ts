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
 * The capability a PHONE declares while it holds the Flipper over Bluetooth.
 *
 * A second label rather than a second host wearing the first one, and the reason
 * is not tidiness — it is that the two transports are not the same device:
 *
 *   • over USB the Flipper speaks a text CLI. Everything the firmware exposes is
 *     there, including the receive commands (`ir rx`, `subghz rx`, `rfid read`).
 *   • over BLE it speaks protobuf RPC. Storage, device info, power, alerts and
 *     the GPIO are all there — richer, even, since sizes and md5s arrive as
 *     fields instead of text to parse — but there is **no receive RPC at all**.
 *
 * Neither is a superset. So a phone that declared plain `flipper` would be
 * offered an IR capture it can never perform, and the honest failure ("nothing
 * received") is indistinguishable from a capture of a quiet room. Splitting the
 * label lets `pickFlipperHost` refuse at the routing layer instead.
 *
 * The second reason is cheaper to describe and worse to hit: the relay's only
 * generic envelope is {type:'invoke', prompt}, and a phone answers one by
 * proxying the prompt through /api/chat — where the agent has flipper_status,
 * which would resolve the same phone again, forever. The BLE rail therefore gets
 * a STRUCTURED {type:'flipper', action, args} envelope the phone executes
 * directly (ios/Tiny/Sources/Session.swift handleFlipperEnvelope).
 */
export const FLIPPER_BLE_CAP = 'flipper_ble'

export type FlipperHost = {
  id: string
  name: string
  online: boolean
  platform: string
  transport: 'cable' | 'ble'
}

/**
 * Longest listen window a tool will ask for. The host holds its serial lock (and
 * the Flipper's radio) for the whole capture, so this is also how long the node
 * cannot answer anything else.
 */
export const MAX_LISTEN_S = 30

/**
 * How long flipper_status waits for the host's answer.
 *
 * Named because the other side has to fit inside it. A phone answering over BLE
 * reads firmware, battery and free space, and those three requests' own ceilings
 * add up to more than this — so `FlipperGateway.relayStatusBudgetS` caps the
 * whole read well under this number. Left unbounded, a slow board produced an
 * answer nobody was still waiting for: this tool reported "no answer within 45s"
 * while the phone was mid-request, which reads as a dead Flipper.
 */
export const STATUS_WAIT_S = 45

/**
 * How long flipper_files waits for a listing.
 *
 * The same 45s as a status read, because it is the same round trip with the same
 * two lags in it, and a listing is the slowest thing the BLE side does: hundreds
 * of `/ext/subghz` entries all crossing behind flow control.
 *
 * ⚠️ This used to be `Math.min(45, listenBudget(0, budgetS))`, which was a **20s
 * wait wearing a 45**. `listenBudget` is a LISTEN budget — `need = listenS + 20`
 * — so with no listen it collapses to a flat 20 for every input on earth
 * (`listenBudget(0, undefined)` and `listenBudget(0, 300)` are both 20), and the
 * `Math.min(45, …)` could never win. Meanwhile the phone allowed its listing 25s
 * (`FlipperGateway.listS`) and its relay loop sleeps up to 15s before it even sees
 * the envelope, so the answer could not physically arrive before the caller quit —
 * and the sentence the user then read blamed Bluetooth range for a working board.
 */
export const FILES_WAIT_S = 45

/**
 * Longest a phone can take to answer one relay action: its poll loop's sleep
 * (5s, 15s in Low Power Mode) before it sees the envelope, plus the ceiling the
 * gateway puts on the action itself (`relayStatusBudgetS`/`relayFilesBudgetS`,
 * both 20s). A wait shorter than this cannot hear a BLE answer, so it must not
 * claim to know WHY nothing came back.
 */
export const BLE_ROUND_TRIP_S = 35

/**
 * The wait a listing actually gets, clamped by a scheduled job's remaining time.
 *
 * Jobs die at JOB_DEADLINE_S, so a job with 25s left must not sit for 45. But the
 * clamp is now visible to the caller: `flipperInvoke` compares the wait it was
 * given against `BLE_ROUND_TRIP_S` and says which of the two things happened,
 * instead of asserting a cause it cannot see from here.
 */
export function filesWait(budgetS?: number): number {
  if (!budgetS) return FILES_WAIT_S
  return Math.min(FILES_WAIT_S, Math.max(15, budgetS - 8))
}

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
export async function resolveFlipperHosts(userId: string):
    Promise<{ cable: FlipperHost | null; ble: FlipperHost | null }> {
  const d = await fetch(`${WORKER}/device/list?userId=${encodeURIComponent(userId)}`, {
    headers: ikey(), cache: 'no-store',
  }).then(r => r.json()).catch(() => null)
  const pick = (cap: string, transport: 'cable' | 'ble'): FlipperHost | null => {
    const hosts = (d?.devices || []).filter((x: any) => parseCaps(x.capabilities).includes(cap))
    if (!hosts.length) return null
    const best = hosts.find((x: any) => x.online) || hosts[0]
    return {
      id: best.id,
      name: String(best.name ?? (transport === 'ble' ? 'phone' : 'host')),
      online: !!best.online,
      platform: String(best.platform ?? ''),
      transport,
    }
  }
  return { cable: pick(FLIPPER_CAP, 'cable'), ble: pick(FLIPPER_BLE_CAP, 'ble') }
}

/**
 * Which of the two routes actually gets the work.
 *
 * The cable wins when it is awake, because it is the strict superset of what the
 * phone can do and it does not spend the phone's battery. The phone is the
 * fallback that makes this feature exist at all: the user carries the Flipper,
 * and the laptop it was last plugged into is usually asleep.
 *
 * The last two branches deliberately return an OFFLINE host instead of null —
 * "the machine your Flipper is plugged into is asleep" is a far more useful
 * sentence than "no Flipper found", and it is the difference between the user
 * waking a laptop and the user hunting for a lost board.
 */
export function pickFlipperHost(
  hosts: { cable: FlipperHost | null; ble: FlipperHost | null },
  opts: { overBle: boolean },
): FlipperHost | null {
  if (hosts.cable?.online) return hosts.cable
  if (opts.overBle && hosts.ble?.online) return hosts.ble
  return hosts.cable || (opts.overBle ? hosts.ble : null)
}

/**
 * Send the chosen host one Flipper action, then poll for its answer.
 *
 * TWO envelope shapes, because the two hosts are two different programs:
 *
 *   • cable → {type:'invoke', prompt}. That is the only generic shape the relay
 *     defines, and the laptop answers it with a full agent turn that has
 *     use_flipper in its toolset. Being explicit about the action and its
 *     arguments keeps the host from improvising a different one — and keeps the
 *     transcript readable about what was actually asked of the hardware.
 *   • BLE → {type:'flipper', action, args}. Structured, executed directly by the
 *     phone's relay loop. See FLIPPER_BLE_CAP for why sending a phone a prompt
 *     here would be a loop rather than a slower answer.
 *
 * Pass `ble: null` for an action the BLE transport genuinely cannot perform; the
 * routing then refuses in words instead of asking a phone to fake it.
 */
async function flipperInvoke(
  userId: string,
  instruction: string,
  waitS: number,
  ble: { action: string; args?: Record<string, unknown> } | null,
): Promise<{ result?: string; error?: string; offline?: boolean; transport?: 'cable' | 'ble'; host?: string }> {
  const hosts = await resolveFlipperHosts(userId)
  const host = pickFlipperHost(hosts, { overBle: !!ble })
  if (!host) {
    // Distinguish "you own no route to a Flipper" from "the only route you have
    // can't do THIS" — the second is a real capability the user has, and telling
    // them to buy a cable they already own would be nonsense.
    if (hosts.ble && !ble) {
      return {
        error: `This needs the Flipper's serial CLI, and the only link on this account is Bluetooth from "${hosts.ble.name}". Capturing IR, Sub-GHz, RFID or iButton has no Bluetooth equivalent — the firmware exposes no receive command over BLE. Plug the Flipper into a machine running the tiny CLI (\`npx tiny-tech mesh\`) for this one. Over Bluetooth the phone can still do status, browse and read the SD card, and make it beep.`,
      }
    }
    return {
      error: 'No Flipper Zero is reachable. It appears on the account either plugged into a machine running the tiny CLI (`npx tiny-tech mesh`), or linked over Bluetooth to the tiny app on a phone (Devices → your phone → Find my Flipper).',
    }
  }
  if (!host.online) {
    return {
      offline: true,
      transport: host.transport,
      host: host.name,
      error: host.transport === 'ble'
        ? `"${host.name}" — the phone holding the Flipper over Bluetooth — is not heartbeating, so nothing can reach the Flipper right now. The Flipper has no network of its own.`
        : `"${host.name}" — the machine the Flipper is plugged into — is not heartbeating, so nothing can reach the Flipper right now. It is asleep, offline, or the tiny CLI is not running.${hosts.ble ? ` The Bluetooth link on "${hosts.ble.name}" is not answering either.` : ' The Flipper has no network of its own.'}`,
    }
  }

  const sent = await fetch(`${WORKER}/device/relay/send`, {
    method: 'POST', headers: ikey(),
    body: JSON.stringify({
      userId, toDevice: host.id,
      payload: JSON.stringify(
        host.transport === 'ble'
          ? { type: 'flipper', action: ble!.action, args: ble!.args ?? {} }
          : { type: 'invoke', prompt: instruction },
      ),
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
      return { result: String(p.result ?? ''), transport: host.transport, host: host.name }
    } catch {
      return { result: String(d.reply.payload), transport: host.transport, host: host.name }
    }
  }
  // A timeout is TWO facts: nobody answered, and how long we actually waited.
  // Only the first was ever reported, so a wait too short to hear a BLE round
  // trip came back as a confident story about Bluetooth range — a hardware
  // diagnosis for a board that answers fine, made by the one party that knew it
  // had left early.
  return {
    transport: host.transport,
    host: host.name,
    error: host.transport === 'ble'
      ? (waitS < BLE_ROUND_TRIP_S
        ? `Stopped waiting after ${waitS}s, which is not long enough to conclude anything: an answer over Bluetooth needs up to ${BLE_ROUND_TRIP_S}s, because "${host.name}" polls for work every 5s (15s in Low Power Mode) and only then starts asking the Flipper. This turn didn't have the time. Ask again from an interactive chat, where the full ${FILES_WAIT_S}s is available.`
        : `No answer within ${waitS}s from "${host.name}". The phone is heartbeating and had time to reply, so the Flipper itself is the quiet one — it may have moved out of Bluetooth range of the phone, its Bluetooth may be switched off in its own settings, or an app open on its screen may be holding the hardware.`)
      : `No answer within ${waitS}s. A capture holds the device for its whole window, so the host may still be listening — ask again, or read the outcome with use_device.`,
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
  description: "Check whether the user's Flipper Zero is reachable: which machine it is plugged into (or which phone holds it over Bluetooth), whether that host is online right now, and the Flipper's firmware and battery. Use this before any other flipper_* tool, and to answer 'is my Flipper connected?'. Cheap and fast.",
  inputSchema: z.object({}),
  callback: async () => {
    if (!userId) return { ok: false, error: 'Login required — devices belong to the user account.' }
    const hosts = await resolveFlipperHosts(userId)
    const host = pickFlipperHost(hosts, { overBle: true })
    if (!host) {
      return {
        ok: false,
        error: 'No Flipper Zero is reachable on this account. Either plug it into a machine running the tiny CLI (`npx tiny-tech mesh`), or link it over Bluetooth to the tiny app on a phone (Devices → your phone → Find my Flipper). Either route is declared automatically within 30s.',
      }
    }
    if (!host.online) {
      const where = host.transport === 'ble'
        ? `linked over Bluetooth to "${host.name}"`
        : `plugged into "${host.name}"`
      return {
        ok: true, reachable: false, host: host.name, transport: host.transport,
        note: `The Flipper was last seen ${where}, but that host is not heartbeating — so the Flipper is unreachable. It has no network of its own: whatever it is doing now, nobody can ask it.`,
      }
    }
    const r = await flipperInvoke(
      userId,
      'Run use_flipper with action "info", then use_flipper with action "power_info". Report the firmware version, hardware model, battery charge level and charge state. Do not run any other action.',
      STATUS_WAIT_S,
      { action: 'status' },
    )
    if (r.error) return { ok: false, host: host.name, transport: host.transport, error: r.error }
    return {
      ok: true, reachable: true, host: host.name, host_platform: host.platform,
      // Name the transport in the result, not just in the routing: "over
      // Bluetooth from your phone" is the difference between a board on a desk
      // in another city and one in the user's pocket, and only the tool knows.
      transport: r.transport,
      via: r.transport === 'ble'
        ? `Bluetooth from "${host.name}" — no cable involved`
        : `USB cable into "${host.name}"`,
      details: r.result,
      ...(r.transport === 'ble' ? {
        note: 'Over Bluetooth the Flipper can report status, browse and read its SD card, and beep. Capturing IR / Sub-GHz / RFID / iButton needs the USB cable — the firmware has no receive command over BLE.',
      } : {}),
    }
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
      // 🚫 CABLE ONLY, forever. Not an unimplemented feature — the Flipper's BLE
      // RPC has no receive command of any kind, so a phone asked to capture
      // could only ever answer "nothing received", which is exactly what a
      // working capture of a silent room says. `null` makes the router refuse
      // in words instead.
      null,
    )
    if (r.error) return { ok: false, error: r.error, offline: r.offline }
    return { ok: true, radio: input.radio, listened_s: secs, captured: r.result, transport: r.transport }
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
      filesWait(budgetS),
      // Storage.List is the one place BLE is genuinely nicer than the CLI: sizes
      // and md5s arrive as protobuf fields, so nothing has to be parsed out of a
      // text table.
      { action: 'files', args: { path: folder } },
    )
    if (r.error) return { ok: false, error: r.error, offline: r.offline }
    return { ok: true, folder, listing: r.result, transport: r.transport, host: r.host }
  },
})

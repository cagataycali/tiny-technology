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
import { relaySend } from '@/lib/chat/relay-send'

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
 * How long flipper_status waits for the host's answer, with all the time it can get.
 *
 * Named because the other side has to fit inside it. A phone answering over BLE
 * reads firmware, battery and free space, and those three requests' own ceilings
 * add up to more than this — so `FlipperGateway.relayStatusBudgetS` caps the
 * whole read well under this number. Left unbounded, a slow board produced an
 * answer nobody was still waiting for: this tool reported "no answer within 45s"
 * while the phone was mid-request, which reads as a dead Flipper.
 *
 * ⚠️ A CEILING, not the wait — see `statusWait`. This is the interactive number;
 * a scheduled job gets less, because a job that spends 45 of its 50 seconds here
 * is killed before it can report what it learned.
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
 * How long flipper_find waits for the board to acknowledge the alert. Not to
 * confirm a beep: nothing on either route reports what was heard (see
 * `makeFlipperFindTool`).
 *
 * The work itself is ONE RPC — `FlipperGateway.alert()` allows it 10s — so 25
 * (a 15s Low Power poll sleep plus that 10s) looks generous and would be a trap:
 * every wait BELOW `BLE_ROUND_TRIP_S` takes `flipperInvoke`'s honest short-wait
 * branch, which refuses to diagnose anything and sends the caller to "an
 * interactive chat, where the full ceiling is available" — a sentence that makes
 * no sense when the caller IS one. Any tool that polls this relay needs a ceiling
 * at or above that round trip or it can never conclude anything, so a find gets
 * the same 45 as a status read and `clampToJob` still shortens it for a job or a
 * live call.
 */
export const ALERT_WAIT_S = 45

/**
 * The remedy for a phone that reads 🟢 and answers nothing — the one cause this
 * rail never named, and the only one the user can act on.
 *
 * A 🟢 on a phone is a HEARTBEAT, not a listener, and for up to a minute at a
 * time those are different facts:
 *
 *   • `startDeviceLoops()` starts TWO tasks — the 30s heartbeat (45s in Low Power
 *     Mode) and the 5s relay poll — and `stopDeviceLoops()` cancels BOTH.
 *     TinyApp.swift calls the first on `.active` and the second on `.background`.
 *   • presence is `last_seen` inside PRESENCE_WINDOW_S = 60 (the worker's
 *     src/devices.ts), and the heartbeat is its ONLY writer: /device/relay/recv
 *     never touches it.
 *
 * 60s window, 30s beat ⇒ a phone the user has just put in their pocket keeps
 * reading ONLINE for the rest of that window with provably nothing polling for
 * envelopes. There is no silent push (Background.swift records it as unbuilt) and
 * BGAppRefresh is opportunistic at ≥15min, so a suspended app cannot be woken
 * inside any wait a tool has. The envelope is not lost — it sits in the relay and
 * is claimed at the next foreground — but nobody is waiting by then.
 *
 * P5's own choreography walks straight into that window: pair the board, unplug
 * the cable, then go to the laptop and ask. That walk is 20-60s.
 *
 * Both necklace rails already say this out loud — nicla-voice.ts: "out of
 * Bluetooth range, or the tiny app is closed"; platform.ts: "or the app went to
 * background during capture". The Flipper rail is the one that asserted the
 * opposite and then accused the hardware.
 *
 * ONE sentence, three call sites (both `!host.online` BLE arms and the long BLE
 * timeout), because a fact spread across three hand-written sentences drifts in
 * three directions. What is shared is the FACT — each arm keeps its own frame,
 * since one is an `error` string and one is an `ok:true` status `note`.
 */
export function bleAppRemedy(name: string): string {
  return `The tiny app heartbeats and polls for work only while it is OPEN on "${name}": iOS stops both when it goes to the background and cannot be woken on demand, so a phone in a pocket still shows online for up to a minute after it stopped listening. Open the tiny app on that phone and ask again.`
}

/**
 * What the Bluetooth route can actually be ASKED for — one list, five readers.
 *
 * This sentence was written out FIVE times by hand (the cable-only refusal, the
 * "that phone is up but cannot capture" arm, flipper_status's BLE note,
 * CAPABILITY_HINTS.flipper_ble in the system prompt, and job-run's capability
 * note), and four of the five promised a beep **no tool could send**. The phone
 * has implemented it since P1 — `Session.handleFlipperEnvelope`'s
 * `case "alert", "beep", "find"` → `FlipperGateway.alert()`, one
 * `Gui.PlayAudiovisualAlert` — and the cabled CLI has `alert` too, so the missing
 * half was always this one: three named tools, none of which could ask for it.
 * An agent told "it can beep" with nothing to call either contradicts its own
 * prompt or says "done" and leaves someone hunting a silent board.
 *
 * Every copy also said the phone can "read the SD card", which this rail offers
 * NO caller: flipper_files lists names and sizes and says so in its own
 * description, because /ext/nfc holds the user's passports and bank cards. A
 * single named file over BLE is designed (§4.4 of the design doc, behind the
 * credential guard) and unbuilt — so it is not on this list either.
 *
 * The list NAMES ITS TOOLS, which is what makes it checkable: a capability
 * claimed on this rail with no tool beside it is this defect coming back.
 */
export function bleCanDo(): string {
  return 'report status (flipper_status), list what is saved on its SD card (flipper_files), and set off its find-me alert — sound, buzz and LED, as far as that board\'s own settings allow (flipper_find)'
}

/**
 * What became of an ask nobody waited long enough for — the fact the short-wait
 * timeout left out, and the only one that could still help.
 *
 * `relaySend` has already returned `queued` by the time that branch runs, so
 * leaving early cancels NOTHING: the envelope sits in the relay, the phone claims
 * it at its next poll, and the board does the thing. Nor does anything carry the
 * answer back afterwards — the worker's late-reply rails are gated to
 * `{type:'invoke'}` envelopes (`worker/src/relay.ts`,
 * `parseLateInvoke`: `request.type !== "invoke"` ⇒ no ring event, no push), so a
 * `{type:'flipper'}` reply that lands after its waiter left is swept without ever
 * reaching the event ring `use_device` uses for exactly this state. The caller is
 * the last party in a position to be told, which is why this is a sentence rather
 * than a TODO.
 *
 * It matters most for the ALERT, which is why this exists at all. A find's answer
 * is not text, it is a noise in a room, and whoever asked is usually standing in
 * that room with their hands empty — `/api/voice/tool` calls it "the most
 * spoken-word tool on this rail". "Ask again from a chat" throws away the beep
 * the board is about to make and asks for a second one.
 *
 * Per-action frames over one shared fact (hazard: share the FACT, keep the
 * frame). A status read and a listing have nothing to listen for and must not be
 * told to listen; between them and `alert` that is every action a tool on this
 * rail sends.
 */
export function bleStillQueued(action: string, name: string): string {
  const queued = `Leaving early did not cancel it: the request is queued on the relay and "${name}" runs it within seconds of its next poll.`
  return action === 'alert'
    ? `${queued} The Flipper is about to sound its alert, so listen for it now rather than asking again — a second ask is a second alert, not a second answer.`
    : `${queued} Nothing carries a late answer back to a turn that has ended, so it will be done and unreported.`
}

/**
 * A tool's ceiling, clamped by a scheduled job's remaining time.
 *
 * Jobs die at JOB_DEADLINE_S, so a job with 25s left must not sit for 45. But the
 * clamp is now visible to the caller: `flipperInvoke` compares the wait it was
 * given against `BLE_ROUND_TRIP_S` and says which of the two things happened,
 * instead of asserting a cause it cannot see from here.
 *
 * ONE clamp, parameterised by the ceiling, rather than a copy per tool: two
 * copies of `Math.max(15, budgetS - 8)` are two things to keep in step, and the
 * one that gets forgotten is the one nobody is looking at.
 */
function clampToJob(ceilingS: number, budgetS?: number): number {
  if (!budgetS) return ceilingS
  return Math.min(ceilingS, Math.max(15, budgetS - 8))
}

/** The wait a listing actually gets. */
export function filesWait(budgetS?: number): number {
  return clampToJob(FILES_WAIT_S, budgetS)
}

/** The wait a find actually gets. */
export function alertWait(budgetS?: number): number {
  return clampToJob(ALERT_WAIT_S, budgetS)
}

/**
 * The wait a status read actually gets.
 *
 * This tool had NO budget parameter at all, alone among the flipper and nicla
 * tools that wait on hardware — `makeNiclaStatusTool` takes one, and the two
 * nicla_voice reads skip it for the stated reason that they "hit the registry
 * and the event ring, never the board". flipper_status is not that: it posts a
 * relay envelope and polls for an answer, so it was the exception to a rule the
 * job roster writes down one line above it.
 *
 * What that cost: its own description says "use this before any other flipper_*
 * tool", so a scheduled job does exactly that, and a status read against a phone
 * that is not answering sat for a flat 45s out of the job's 50 — past the point
 * where `agent.cancel()` fires. The job then reported NOTHING, not even the
 * unreachable it had established, and the clamped flipper_files call that would
 * have worked never ran.
 */
export function statusWait(budgetS?: number): number {
  return clampToJob(STATUS_WAIT_S, budgetS)
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
 * the HOST heartbeating — the laptop over the cable, the phone over BLE. A 🟢
 * means that host beat within PRESENCE_WINDOW_S (60s, the worker's devices.ts)
 * and had a Flipper attached at that beat. The Flipper itself has no presence of
 * its own and never will.
 *
 * Two things that window does NOT prove, both of them once written here as if it
 * did (it said "the LAPTOP", and "≤30s ago"):
 *   • 60s is twice the 30s beat, so 🟢 outlives the last beat by a beat. On a
 *     phone that gap is the difference between heartbeating and listening — see
 *     `bleAppRemedy`.
 *   • the capability is re-declared per beat and the heartbeat OVERWRITES the
 *     column, so a link that dropped is self-reporting: within one beat the phone
 *     stops claiming `flipper_ble` and this resolves no BLE host at all.
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
 *
 * `fullS` is the caller's UNCLAMPED ceiling, and it exists so the short-timeout
 * message can name the wait the user would get elsewhere. It used to name
 * `FILES_WAIT_S` — a listing's ceiling, in a sentence three tools print. Both
 * ceilings are 45 today, so the number was right by coincidence rather than by
 * construction, which is the same bug as a wrong number with better luck.
 */
async function flipperInvoke(
  userId: string,
  instruction: string,
  waitS: number,
  fullS: number,
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
        error: `This needs the Flipper's serial CLI, and the only link on this account is Bluetooth from "${hosts.ble.name}". Capturing IR, Sub-GHz, RFID or iButton has no Bluetooth equivalent — the firmware exposes no receive command over BLE. Plug the Flipper into a machine running the tiny CLI (\`npx tiny-tech mesh\`) for this one. Over Bluetooth the phone can still ${bleCanDo()}.`,
      }
    }
    return {
      error: 'No Flipper Zero is reachable. It appears on the account either plugged into a machine running the tiny CLI (`npx tiny-tech mesh`), or linked over Bluetooth to the tiny app on a phone (Devices → your phone → Find my Flipper).',
    }
  }
  if (!host.online) {
    // What to say about the OTHER route takes two facts, and this sentence used
    // to check only one: `hosts.ble` merely EXISTING was reported as "and the
    // phone is dead too". So a capture asked with the mac mini asleep and the
    // board happily linked to the phone in the user's pocket answered "the
    // Bluetooth link on owner-phone is not answering either" — a hardware verdict
    // on the one route that was up, from the one party that knew it had never
    // asked. The phone IS answering; it just cannot receive a signal over BLE,
    // ever. Different fact, different remedy: wake the machine, rather than go
    // hunting a Bluetooth fault that isn't there.
    //
    // An ONLINE ble host can only be seen here when the caller passed ble:null,
    // because with a BLE action available pickFlipperHost would have routed to
    // it instead of returning this offline cable host. That is why the last arm
    // needs no condition of its own — and why there is no unreachable fourth.
    const aboutTheOtherRoute =
      !hosts.ble ? ' The Flipper has no network of its own.'
      : !hosts.ble.online ? ` The Bluetooth link on "${hosts.ble.name}" is not answering either.`
      : ` "${hosts.ble.name}" does hold the Flipper over Bluetooth and is answering — but capturing IR, Sub-GHz, RFID or iButton has no Bluetooth equivalent (the firmware exposes no receive command over BLE), so waking this machine is the only way to get one. Over Bluetooth that phone can still ${bleCanDo()}, right now.`
    return {
      offline: true,
      transport: host.transport,
      host: host.name,
      // The ble arm needs no such clause: a cable host, even an offline one,
      // outranks an offline phone in pickFlipperHost, so reaching here with the
      // phone chosen means there is no cable route on the account to report on.
      //
      // It DOES need a remedy, which it had none of — every other refusal in this
      // file names an action (`npx tiny-tech mesh`, "Devices → your phone → Find
      // my Flipper", "waking this machine") and this one left the user holding a
      // verdict. The action is almost always the same one: open the app.
      error: host.transport === 'ble'
        ? `"${host.name}" — the phone holding the Flipper over Bluetooth — is not heartbeating, so nothing can reach the Flipper right now. The Flipper has no network of its own. ${bleAppRemedy(host.name)}`
        : `"${host.name}" — the machine the Flipper is plugged into — is not heartbeating, so nothing can reach the Flipper right now. It is asleep, offline, or the tiny CLI is not running.${aboutTheOtherRoute}`,
    }
  }

  const sent = await relaySend({
    worker: WORKER, headers: ikey(), userId, toDevice: host.id,
    payload: JSON.stringify(
      host.transport === 'ble'
        ? { type: 'flipper', action: ble!.action, args: ble!.args ?? {} }
        : { type: 'invoke', prompt: instruction },
    ),
    // Not the Flipper — the machine or phone holding it. Every other refusal in
    // this file names that host, because "the Flipper" is never what failed here.
    deviceName: host.name,
  })
  if (!sent.queued) return { error: sent.error }

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
  //
  // The LONG branch then made the same mistake one layer up. "The phone is
  // heartbeating and had time to reply, so the Flipper itself is the quiet one"
  // reads the 🟢 as proof that something was listening; it is not (see
  // `bleAppRemedy`), and the difference lasts up to a minute — the exact minute
  // it takes to walk from the board to a laptop and type. So the sentence
  // accused the hardware of a silence the app's own lifecycle explains, and its
  // first two suggestions sent the user to the Flipper's Settings → Bluetooth
  // screen, which is where "Forget all paired devices" lives: a wrong diagnosis
  // whose remedy un-pairs the link.
  //
  // Order now follows what is both likeliest and fixable, and the demoted causes
  // keep a TELL rather than a settings instruction: a dropped link takes the
  // `flipper_ble` capability with it at the next beat, so asking again is what
  // distinguishes "the board went away" from "the board is busy".
  //
  // ⚠️ The SHORT branch then had a third problem, and it is a problem about its
  // reader. Which callers can reach it? A wait under BLE_ROUND_TRIP_S, i.e. a
  // clamped one: chat gets 45 and a job 42, both above it — only a live voice
  // call, clamped to 15 by VOICE_TOOL_BUDGET_S, lands here, and it lands here on
  // EVERY Bluetooth call it ever makes. So the one sentence this branch prints was
  // read exclusively by a caller it was not written for: it said "This turn didn't
  // have the time" (bad luck, on a rail where it is arithmetic) and sent them to
  // "an interactive chat" — which ALERT_WAIT_S's own doc had already called "a
  // sentence that makes no sense when the caller IS one", while assuming no
  // interactive caller could get here. A spoken turn is interactive and typed
  // is what it isn't. Worse, it reported a silence while saying nothing about the
  // request it had already handed to the relay: see `bleStillQueued`.
  return {
    transport: host.transport,
    host: host.name,
    error: host.transport === 'ble'
      ? (waitS < BLE_ROUND_TRIP_S
        ? `Stopped waiting after ${waitS}s, which is not long enough to conclude anything: an answer over Bluetooth needs up to ${BLE_ROUND_TRIP_S}s, because "${host.name}" polls for work every 5s (15s in Low Power Mode) and only then starts asking the Flipper. ${bleStillQueued(ble!.action, host.name)} Every turn clamped this short lands here, so asking the same way again spends another ${waitS}s for this same sentence — ask from a TYPED chat, where the full ${fullS}s is available.`
        : `No answer within ${waitS}s from "${host.name}", which was long enough. A phone shows online for a minute after its last heartbeat, and that is not the same as something listening: ${bleAppRemedy(host.name)} If the app was already open there, the Flipper is the quiet one — most likely an app on its screen is holding the hardware (every other command answers "Other application is running" until it is closed), or it has moved out of Bluetooth range. Those two are worth telling apart by asking again: if the link really dropped, the phone stops declaring the Flipper within a beat or two and you will get a clear "no route" instead of another timeout.`)
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
  return clampToJob(listenS + 20, budgetS)
}

export const makeFlipperStatusTool = (userId: string | null | undefined, budgetS?: number) => tool({
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
      // "Nobody can ask it" is true of both routes and useless on its own — this
      // tool's own description is "use this before any other flipper_* tool", so
      // it is the first thing the user hears, and the sentence it heard back
      // stopped at the verdict. The cable arm has always had its remedy in the
      // caller's hands (wake the machine); the phone arm gets one now.
      return {
        ok: true, reachable: false, host: host.name, transport: host.transport,
        note: `The Flipper was last seen ${where}, but that host is not heartbeating — so the Flipper is unreachable. It has no network of its own: whatever it is doing now, nobody can ask it.${host.transport === 'ble' ? ` ${bleAppRemedy(host.name)}` : ''}`,
      }
    }
    const r = await flipperInvoke(
      userId,
      'Run use_flipper with action "info", then use_flipper with action "power_info". Report the firmware version, hardware model, battery charge level and charge state. Do not run any other action.',
      statusWait(budgetS),
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
        note: `Over Bluetooth the Flipper can ${bleCanDo()}. Capturing IR / Sub-GHz / RFID / iButton needs the USB cable — the firmware has no receive command over BLE.`,
      } : {}),
    }
  },
})

/**
 * The one tool the Bluetooth route can never serve — and the last one anybody
 * told about Bluetooth.
 *
 * "Capture needs the cable" is stated at every site that answers AFTER the call:
 * both `!host.online` arms, the cable-only refusal, flipper_status's note, the
 * phone's own refusal in Session.swift. It is also in both system prompts that
 * exist — `CAPABILITY_HINTS.flipper_ble` ("no radio capture") and job-run's
 * capability note ("only capturing … needs the cable"). It was in neither of the
 * two texts a model reads BEFORE deciding to call this: not here, and not in a
 * voice call, where `buildVoiceInstructions` carries a persona and a memory and
 * no device roster at all — so on the one surface with no prompt to fix, this
 * description was the only thing that could have said it, and didn't.
 *
 * That gap is not a wasted turn, it is a wasted PERSON. This tool needs a human
 * at the board, and the paragraph below tells the model to announce the capture
 * first — so with the board on Bluetooth the guaranteed order was: promise a
 * capture, send someone to press their remote at it, then refuse. Hence the
 * precondition sits with the announcement instruction it qualifies, and names
 * flipper_status as the way to know before promising anything.
 */
export const makeFlipperListenTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'flipper_listen',
  description: `Capture a signal on the user's Flipper Zero and report what it received — the Flipper LISTENS, it does not transmit here. Radios:
- "ir" — an infrared remote: decodes protocol + address + command (point the remote at the Flipper's top edge)
- "subghz" — 433/868MHz radio traffic at a given frequency (key fobs, sensors, doorbells)
- "rfid" — a 125kHz proximity card held against the Flipper's back
- "ibutton" — a Dallas/Cyfral/Metakom key touched to its contacts
This BLOCKS for the whole listen window and needs a human to present the card or press the remote during it, so say what you are about to do before calling it — but check the route BEFORE that announcement. Capture is USB-CABLE ONLY: capturing IR, Sub-GHz, RFID or iButton has no Bluetooth equivalent (the firmware exposes no receive command over BLE), so a phone holding the Flipper over Bluetooth refuses this, and that refusal lands after someone is already standing at the board. Ask flipper_status first unless you already know the cable is the live route; over Bluetooth the Flipper can still ${bleCanDo()}. 13.56MHz NFC is NOT available (this firmware has no NFC CLI) — use flipper_files to find tags already saved on the SD card.`,
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
    //
    // TWO callers reach this, and the remedy used to be written for one of them.
    // A job lands here on a long window (its clamp is 42s); a live voice call
    // lands here on anything over 10s, because VOICE_TOOL_BUDGET_S clamps every
    // wait on that rail to 15. "Run it from an interactive chat" is a fair thing
    // to tell a scheduled job and a strange thing to tell somebody who is talking
    // to you — TYPED is the property that distinguishes the two, and it is true
    // for both readers.
    if (wait < secs + 5) {
      return {
        ok: false,
        error: `A ${secs}s capture needs longer than this turn has left. Ask for a shorter window (or run it from a TYPED chat, which gets the full ${listenBudget(secs)}s).`,
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
      listenBudget(secs),
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
      FILES_WAIT_S,
      // Storage.List is the one place BLE is genuinely nicer than the CLI: sizes
      // and md5s arrive as protobuf fields, so nothing has to be parsed out of a
      // text table.
      { action: 'files', args: { path: folder } },
    )
    if (r.error) return { ok: false, error: r.error, offline: r.offline }
    return { ok: true, folder, listing: r.result, transport: r.transport, host: r.host }
  },
})

/**
 * 🔔 Find-my-Flipper — the one thing this rail advertised and could not do.
 *
 * NOT a transmit, and that distinction is the whole reason this tool may exist
 * while `flipper_tx` and a remote button press may not: `Gui.PlayAudiovisualAlert`
 * over BLE, `alert` over the cable, both aimed at the board ITSELF. Nothing is
 * broadcast, no saved signal is replayed, no gate opens, the SD card is not
 * touched. The worst case is a noise in the room the Flipper is in — which is also
 * the entire point, so the description says so out loud for the caller with nobody
 * in that room.
 *
 * ⚠️ The two routes drive DIFFERENT hardware, and this comment used to claim both
 * "beep/blink/buzz". Measured, not assumed:
 *   * BLE hands the board a notification and the BOARD decides — on the user's own
 *     C2, `/int/.notification.settings` reads speaker 1.0, LED 1.0, **vibro 0**.
 *   * the cable sends `led r 255` + `vibro 1/0` and NO speaker command at all
 *     (tiny-tech/src/agent/flipper.ts), which its own reply, `🚨 alert (led +
 *     vibro)`, has always said honestly. The cable is also the PREFERRED route in
 *     `pickFlipperHost`, so "the sound is what finds it" was most wrong exactly
 *     when it was most likely to be read.
 * Neither route reports what was heard — there is no acoustic feedback in either
 * protocol — so every sentence about this tool describes an ACKNOWLEDGEMENT, and
 * `FlipperGateway.alertSent(for:)` is the phone-side half of the same rule.
 *
 * Both transports, unlike every other tool here: `flipper_listen` is cable-only
 * because the firmware has no receive RPC over BLE, and this is the mirror case
 * where both routes can do it — so it takes the ordinary `pickFlipperHost` routing
 * and needs no refusal of its own.
 */
export const makeFlipperFindTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'flipper_find',
  description: "Set off the find-me alert on the user's Flipper Zero for about a second — the tool for \"where is my Flipper?\", \"make it beep\", or proving a fresh Bluetooth link is real. Works over EITHER route (the USB cable, or Bluetooth from the phone holding it), but they drive different hardware: over Bluetooth the board plays its own audiovisual alert, and over the cable it flashes the LED and vibrates with no sound at all. Either way the answer is the board ACCEPTING the alert, never proof that anybody heard it — volume, vibration and LED are separate switches on the board, so a Flipper nobody hears is not a broken link. It does not transmit anything, replay a saved signal, launch an app or touch the SD card, and it reports no location — the alert itself is what finds it. Assume it can be loud wherever the board physically is, so use it when someone asked to find it, not to test a link in an unattended job.",
  inputSchema: z.object({}),
  callback: async () => {
    if (!userId) return { ok: false, error: 'Login required — devices belong to the user account.' }
    const r = await flipperInvoke(
      userId,
      'Run use_flipper with action "alert". Report whether the Flipper acknowledged it. Do not run any other action, do not transmit anything, and do not read, write or delete any file.',
      alertWait(budgetS),
      ALERT_WAIT_S,
      { action: 'alert' },
    )
    if (r.error) return { ok: false, error: r.error, offline: r.offline }
    return { ok: true, alerted: r.result, transport: r.transport, host: r.host }
  },
})

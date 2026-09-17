// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeUseDeviceTool } from '../lib/chat/tools/platform'
// capabilitySummary is what buildDeviceBlock renders each device with, so it is
// the honest comparison point — no need to export the private hint table.
import { buildDeviceBlock, capabilitySummary } from '../lib/chat/prompt'
import { workerFile, workerPresent, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('use-device-async')

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
    expect(out.ok).toBe(false)
    expect(out.pending).toBeUndefined()
    // The wire string `device not found` used to be handed to the model verbatim.
    // What it must now say is the same verdict in a sentence, and — the part this
    // test is really about — that NOTHING was delivered, so there is no ticket to
    // redeem later. See tests/relay-send.test.ts for the full verdict table.
    expect(out.error).toContain('not on this account')
    expect(out.error).toContain('Nothing was sent')
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
    expect(out.ok).toBe(false)
    expect(out.pending).toBeUndefined()          // no claim ticket for an unsent envelope
    expect(out.error).toContain('Nothing was sent')
  })

  it('logged-out callers are refused for every action', async () => {
    responder = () => { throw new Error('no fetch expected') }
    const anon = makeUseDeviceTool(null) as any
    for (const action of ['list', 'invoke', 'result']) {
      expect((await anon.invoke({ action }, { toolUse: {} })).ok).toBe(false)
    }
  })
})

/**
 * 🧭 action:'list' MUST CARRY CAPABILITIES — the second half of this loop's ask.
 *
 * The user's evidence was a transcript where the agent opened Mail on the iPhone
 * and then told them "your iPhone daemon only advertises chat + bluetooth_scan +
 * location" — the first THREE of the nine `Session.capabilities` actually
 * declares. Not a hallucination from nowhere: `use_device action:'list'`
 * projected the worker's device rows onto seven fields and DROPPED
 * `capabilities` entirely, so a model that discovers devices by calling the tool
 * (a fresh conversation, another surface, any turn where it re-checks) had no
 * capability data at all and guessed from the name.
 *
 * Both halves of the disagreement are pinned, because pinning one proves nothing
 * (rule 21 — two followers can agree and both be wrong):
 *   1. the worker SELECTs and RETURNS the column (source-pinned, since the wire
 *      shape is the thing the projection has to preserve), and
 *   2. the tool result and the SYSTEM PROMPT's device block agree about what a
 *      given device declares — one parser, `parseCapabilities`, feeding both.
 */
describe("use_device action:'list' — the capability field the model matches tasks against", () => {
  const IPHONE = {
    id: 'dev_iphone', name: "cagatay's iPhone", kind: 'mobile', platform: 'ios',
    last_seen: Math.floor(Date.now() / 1000),
    // The wire shape: a JSON array STRING, exactly as the D1 column holds it.
    capabilities: JSON.stringify(['chat', 'bluetooth_scan', 'location', 'record',
      'speak', 'open_app', 'image_gen', 'glasses', 'screenshot']),
  }

  it('hands the model every capability the device declares, parsed', async () => {
    responder = (url) => {
      if (url.includes('/device/list')) return { devices: [{ ...IPHONE, online: true }] }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'list' })
    const dev = out.devices[0]
    expect(dev.capabilities, 'action:\'list\' dropped `capabilities`, so the model has nothing ' +
      'to match a task against — it either refuses a device that can do the job or invents a ' +
      'capability list from the device NAME, which is exactly what shipped')
      .toEqual(['chat', 'bluetooth_scan', 'location', 'record', 'speak', 'open_app',
        'image_gen', 'glasses', 'screenshot'])
    // The specific regression from the transcript: open_app present, and the
    // list not truncated to the leading three.
    expect(dev.capabilities).toContain('open_app')
    expect(dev.capabilities.length).toBeGreaterThan(3)
  })

  it('normalizes the three wire shapes the column really holds — and never throws', async () => {
    for (const [raw, want] of [
      [JSON.stringify(['chat', 'OPEN_APP']), ['chat', 'open_app']],   // case-folded
      [['chat', 'speak'], ['chat', 'speak']],                          // already an array
      [null, []],                                                      // enrolled pre-field
      ['not json at all', []],                                         // must not throw
    ] as const) {
      responder = (url) => {
        if (url.includes('/device/list')) return { devices: [{ ...IPHONE, capabilities: raw, online: true }] }
        throw new Error(`unexpected ${url}`)
      }
      const out = await invoke({ action: 'list' })
      expect(out.ok, `capabilities=${JSON.stringify(raw)} broke action:'list' — this runs inside ` +
        `a chat turn, so a throw here costs the whole answer`).toBe(true)
      expect(out.devices[0].capabilities).toEqual(want)
    }
  })

  it('agrees with the system prompt about what the device declares (one parser, two readers)', async () => {
    responder = (url) => {
      if (url.includes('/device/list')) return { devices: [{ ...IPHONE, online: true }] }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'list' })
    // buildDeviceBlock renders the SAME raw column into the sentences the model
    // reads in its system prompt. If the two ever disagree, the model is told one
    // thing by the prompt and another by the tool — and cannot tell which is real.
    const block = buildDeviceBlock([IPHONE])
    expect(block).toContain(capabilitySummary(IPHONE.capabilities))
    const summary = capabilitySummary(IPHONE.capabilities)
    expect(summary.length, 'the prompt renders no capability sentence at all while ' +
      "action:'list' reports capabilities — the model's two sources disagree").toBeGreaterThan(0)
    // Every capability the tool reports must be ACCOUNTED FOR in that sentence.
    // Rendering each one ALONE gives its exact contribution (hint prose, or the
    // bare token for a label this deploy has never heard of) without needing the
    // private hint table — and asserting that fragment is present is a real
    // check, unlike `hinted || includes(cap)`, which is true by construction.
    for (const cap of out.devices[0].capabilities) {
      const fragment = capabilitySummary(JSON.stringify([cap])).replace(' — can: ', '')
      expect(summary, `the prompt's device block says nothing about "${cap}" while ` +
        `action:'list' reports it — the model's two sources of truth disagree`)
        .toContain(fragment)
    }
    // The load-bearing half: the tool's list and the prompt's list are the SAME
    // set, derived from the same column by the same parser.
    expect(out.devices[0].capabilities).toEqual(
      JSON.parse(IPHONE.capabilities).map((c: string) => c.toLowerCase()))
  })

  it.skipIf(!workerPresent)('the worker really sends the column this projection now forwards', () => {
    // ⚠️ Pinned at the SOURCE, not mocked: my own responder above could keep
    // returning `capabilities` forever after the worker stopped sending it, and
    // this test would stay green over a tool result that is empty in production.
    const dev = readFileSync(workerFile('devices.ts'), 'utf8')
    const sqlAt = dev.indexOf('DEVICE_LIST_SQL')
    expect(sqlAt, 'DEVICE_LIST_SQL moved — re-anchor this pin').toBeGreaterThan(-1)
    const rel = dev.slice(sqlAt).search(/ORDER BY last_seen DESC`/)
    expect(rel, 'DEVICE_LIST_SQL lost its terminator — refusing to read to EOF').toBeGreaterThan(0)
    expect(dev.slice(sqlAt, sqlAt + rel), 'the list SQL stopped selecting `capabilities`, so the ' +
      'field this tool forwards is always undefined').toContain('capabilities')
    // and the handler must put it on the wire, not just select it
    const handler = dev.slice(dev.indexOf('DEVICE_LIST_SQL).bind(userId)'))
    const mapEnd = handler.search(/\n\s*\}\)\);/)
    expect(mapEnd, 'the DeviceListCall row map lost its terminator').toBeGreaterThan(0)
    expect(handler.slice(0, mapEnd), 'the worker selects `capabilities` but no longer returns it')
      .toContain('capabilities: d.capabilities')
  })
})

/**
 * 🔇 THE AUDIT'S OWN CLASS OF BUG: THREE FATES READ AS ONE SUCCESS.
 *
 * `DeviceActionAudit` exists for exactly one reason — to stop the proxied model
 * claiming "Mail app opened 📬" over a no-op. But its INPUT lied. iOS passed
 * `ran: DeviceTools.names.contains(name)`, a membership test, and Android's
 * `handle` returned `runCatching{…}.getOrElse{ true }` — a catch branch that
 * literally answered success. So three different things all printed "ran on the
 * phone":
 *
 *   1. it ran;
 *   2. it THREW (no torch on this device, a revoked vibrate permission, a
 *      clipboard denied to a background app) — logged as a warning nobody reads;
 *   3. `play_sound` under QUIET HOURS, which returns early by design.
 *
 * (3) is the one with a person on the end of it: they hear nothing and cannot
 * tell a deliberate mute from a broken speaker, while the agent assures them the
 * sound played. And `speakLine` has always reported the identical quiet-hours
 * gate honestly, one function away in the same file — so this is an omission,
 * not a design.
 *
 * The behaviour is pinned natively (Android DeviceToolsOutcomeTest +
 * DeviceActionAuditTest, 22 tests). What NO native test can see is the CALL
 * SITES: `Outcome` is a perfectly good enum that nothing has to consult, and on
 * iOS there is no unit-testable path at all (DeviceTools is @MainActor over
 * UIKit). A green suite either side of a reverted call site is the failure mode
 * this describe exists for — the tactic tests/ios-remote-screenshot-consent.ts
 * uses for the same reason.
 */
describe('a device tool reports what it DID, not that its name was known', () => {
  const repo = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  /** Comments quote the bug verbatim, so every structural check runs on code. */
  const code = (src: string) =>
    src.split('\n').filter(l => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    }).join('\n')

  const AND = 'android/app/src/main/java/technology/tiny/app/'
  const iosTools = code(repo('ios/Tiny/Sources/DeviceTools.swift'))
  const iosSession = code(repo('ios/Tiny/Sources/Session.swift'))
  const iosViews = code(repo('ios/Tiny/Sources/Views.swift'))
  const kTools = code(repo(`${AND}tools/DeviceTools.kt`))
  const kFleet = code(repo(`${AND}fleet/FleetManager.kt`))
  const kMain = code(repo(`${AND}MainActivity.kt`))

  it('reads the files it means to read', () => {
    // A moved/renamed file must FAIL here, not vacuously pass every check below.
    for (const [name, src] of Object.entries({ iosTools, iosSession, iosViews, kTools, kFleet, kMain })) {
      expect(src.length, `${name} looks empty — re-anchor these pins`).toBeGreaterThan(2_000)
    }
  })

  it('the quiet-hours mute is a DISTINCT outcome on both phones, not silence', () => {
    // The fix is worth nothing if the enum lacks the case that carries the fact.
    expect(iosTools, 'iOS lost the silencedQuiet case').toContain('case silencedQuiet')
    expect(kTools, 'Android lost SILENCED_QUIET').toContain('SILENCED_QUIET')
    // …and each must be REACHED from the quiet-hours gate itself, not just declared.
    expect(iosTools).toMatch(/Config\.isQuietNow\s*\{\s*return \.silencedQuiet/)
    expect(kTools).toMatch(/"play_sound" && quiet -> Outcome\.SILENCED_QUIET/)
  })

  it('a THROW is FAILED on Android — the catch branch no longer answers success', () => {
    // The shipped defect, verbatim: `.getOrElse { true }`. Anchored on the catch
    // body rather than on the string, since the whole point is what it RETURNS.
    const at = kTools.indexOf('fun handle(name: String, input: JSONObject)')
    expect(at, 'DeviceTools.handle is gone — renamed?').toBeGreaterThan(-1)
    const sig = kTools.slice(at, kTools.indexOf('\n', at))
    // ⚠️ The return TYPE is the fix. A `Boolean` here is the defect restored:
    // four outcomes cannot survive two values, and every audit line downstream
    // is derived from this one.
    expect(sig, 'handle() reports a Boolean again — three fates collapse onto one')
      .toContain('Outcome')
    const body = kTools.slice(at, kTools.indexOf('private fun handleUnsafe(', at))
    expect(body, 'the catch branch reports success again — a tool that threw reads as "ran"')
      .toContain('Outcome.FAILED')
    expect(body).not.toMatch(/getOrElse\s*\{[^}]*\btrue\b/)
  })

  it('no Boolean summary of the outcome survives anywhere', () => {
    // ⚠️ The mutation harness caught this as a SURVIVING mutant: a
    // `handle(): Boolean = handleOutcome(…) == RAN` convenience sat beside the
    // enum with only a spinner label reading it, so flipping which pair of
    // outcomes it blurred broke no test. Any two-valued summary of a four-case
    // fact has to pick something to hide — that IS this cycle's bug, smaller.
    expect(kTools).not.toMatch(/fun handle\w*\([^)]*\)\s*:\s*Boolean/)
    // and the one reader must branch on the enum, not on a truthy shorthand
    const vm = code(repo(`${AND}chat/ChatViewModel.kt`))
    expect(vm).toContain('Outcome.UNKNOWN_TOOL')
  })

  it('the iOS relay audits the EXECUTION, never `names.contains`', () => {
    const at = iosSession.indexOf('case .deviceAction(')
    expect(at, 'the relay .deviceAction branch is gone — renamed?').toBeGreaterThan(-1)
    const branch = iosSession.slice(at, iosSession.indexOf('case .speak(', at))
    expect(branch, 'the relay went back to auditing a membership test')
      .not.toContain('names.contains(name)')
    expect(branch).toContain('DeviceActionAudit.outcomeLine(name, outcome)')
    // The verdict must come from the call that DID the work, not be re-derived.
    expect(branch).toMatch(/let outcome = DeviceTools\.shared\.handle\(/)
  })

  it('the Android relay audits the outcome, not the collapsing Boolean', () => {
    expect(kFleet).toContain('DeviceActionAudit.outcomeLine(name, deviceTools.handle(name, input))')
    // and never the old collapsing form, whose `true` covered a throw as well
    expect(kFleet).not.toMatch(/toolLine\(name, deviceTools\.handle\(/)
  })

  it('the LIVE VOICE result carries it too — the surface a person HEARS', () => {
    // The second half of the same defect, and the worse one: the voice executor
    // answered a bare ok:true, so a muted play_sound was reported as played to
    // someone sitting in silence. There was no audit line here to be wrong —
    // there was no channel for the fact at all.
    expect(iosViews, 'the iOS voice executor answers a bare ok:true again')
      .toContain('DeviceActionAudit.voiceResult(')
    expect(kMain, 'the Android voice executor answers a bare ok:true again')
      .toContain('DeviceActionAudit.voiceResult(')
    // and both must hand it the EXECUTION's verdict.
    //
    // ⚠️ Pinned as the PROPERTY, not the expression's shape. This used to require
    // the call nested inline (`voiceResult(name, DeviceTools.shared.handle(…))`),
    // which made the pin a vote for one line of syntax: the clipboard port
    // (c72) had to bind the outcome to a local so `copy_to_clipboard` could take
    // its own rail — a refused write returns `.ran` like everything else, so
    // `voiceResult` would have spoken it as a copy — and this reddened on a
    // change that STRENGTHENED the thing it guards. What matters is that the
    // value handed to `voiceResult` came from `handle`, whether directly or
    // through a local named for it.
    expect(iosViews, 'the iOS voice result is no longer derived from handle()')
      .toMatch(/voiceResult\(\s*name, (?:DeviceTools\.shared\.handle\(|outcome\b)/)
    expect(iosViews, 'the iOS voice outcome is not the execution\'s own verdict')
      .toMatch(/let outcome = DeviceTools\.shared\.handle\(|voiceResult\(\s*name, DeviceTools\.shared\.handle\(/)
    expect(kMain).toMatch(/voiceResult\(\s*\n?\s*name, app\.deviceTools\.handle\(/)
  })

  it('the two phones use the same words for the same outcome', () => {
    // Rule 21: two followers can agree and both be wrong, so the SENTENCES are
    // pinned against the user-visible fact rather than against each other only.
    for (const src of [iosTools, code(repo(`${AND}fleet/DeviceActionAudit.kt`))]) {
      expect(src).toContain('NOT played — quiet hours on the phone')
    }
    // and quiet hours must not be reported through the "cannot run via the
    // device relay" wording, which would teach the user to stop asking.
    const iosLine = iosTools.slice(iosTools.indexOf('static func outcomeLine'))
    expect(iosLine.slice(0, iosLine.indexOf('\n    }'))).not.toContain('cannot run')
  })
})

/**
 * 🔀 THE SAME PHONE, TWICE — and the agent believed the corpse.
 *
 * The capability field landing in action:'list' (above) fixed the tool's SHAPE.
 * It did not fix the transcript, because the data was ambiguous in a way no
 * field could resolve: the live account held TWO rows named
 * `studio-iphone` — `b2b7179d…` seen minutes earlier declaring ten
 * capabilities including `open_app`, and `156e3c11…` six days dead declaring
 * three. The agent invoked the live one, Mail really opened, and it then quoted
 * the dead one's three as the phone's limits. Every surface was telling the
 * truth about some row; nothing said which row was the phone.
 *
 * Duplicates are normal and must NOT be swept: the device id lives in the
 * Keychain, so a reinstall, a restore, or iOS's own `reEnroll()` after two
 * "unknown device" strikes mints a new row under the same "<login>-<model>"
 * name and orphans the old one, capability list frozen at that moment.
 *
 * 🔑 So the verdict — which row owns the name — is computed ONCE
 * (`duplicateRoles`) and rendered on BOTH surfaces, for the same reason
 * `parseCapabilities` is shared: these two describe the same rows to the same
 * model, and a model cannot arbitrate between two surfaces that disagree.
 */
describe("use_device action:'list' — which row is actually the device", () => {
  const NOW = Math.floor(Date.now() / 1000)
  const LIVE = {
    id: 'b2b7179d', name: 'studio-iphone', kind: 'mobile', platform: 'ios',
    online: false, last_seen: NOW - 240,
    capabilities: JSON.stringify(['chat', 'bluetooth_scan', 'location', 'record',
      'speak', 'open_app', 'image_gen', 'glasses', 'screenshot', 'flipper_ble']),
  }
  const DEAD = {
    id: '156e3c11', name: 'studio-iphone', kind: 'mobile', platform: 'ios',
    online: false, last_seen: NOW - 6 * 86_400,
    capabilities: JSON.stringify(['chat', 'bluetooth_scan', 'location']),
  }
  const listOf = async (devices: any[]) => {
    responder = (url) => {
      if (url.includes('/device/list')) return { devices }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'list' })
    expect(out.ok).toBe(true)
    return Object.fromEntries(out.devices.map((d: any) => [d.id, d]))
  }

  it('flags the older row as superseded and the newer one as the device', async () => {
    const by = await listOf([LIVE, DEAD])
    expect(by['156e3c11'].superseded).toBe(true)
    expect(by['b2b7179d'].superseded).toBeUndefined()
    expect(by['b2b7179d'].current_for_name).toBe(true)
    // The flag has to SAY what to do with it: the harm was a confident negative
    // claim about the user's phone, not merely a mis-ranked row.
    expect(by['156e3c11'].note_superseded).toContain('Never tell the user a device lacks something')
  })

  it('ranks by last_seen, not by the order the worker happened to return', async () => {
    // The worker's ORDER BY last_seen DESC lives in another repo. Feeding the
    // dead row FIRST is the only way to tell a real ranking from "row 0 wins".
    const by = await listOf([DEAD, LIVE])
    expect(by['156e3c11'].superseded).toBe(true)
    expect(by['b2b7179d'].superseded).toBeUndefined()
  })

  it('a fleet with no name collision carries neither flag', async () => {
    const by = await listOf([LIVE, { ...DEAD, id: 'other', name: 'studio-ipad' }])
    for (const d of Object.values(by) as any[]) {
      expect(d.superseded).toBeUndefined()
      expect(d.current_for_name).toBeUndefined()
    }
  })

  it('the tool and the system prompt name the SAME row as superseded', async () => {
    // One verdict, two readers. If these ever diverge the model is told
    // different things by its prompt and its tool, and cannot tell which is real
    // — the same class of failure as the capability disagreement above.
    const by = await listOf([LIVE, DEAD])
    const block = buildDeviceBlock([LIVE, DEAD], NOW)
    const lineFor = (id: string) =>
      block.split('\n').find(l => l.includes(`[id: ${id}]`)) || ''
    for (const id of ['b2b7179d', '156e3c11']) {
      expect(lineFor(id), `no prompt line for ${id}`).not.toBe('')
      expect(
        lineFor(id).includes('⚠️ SUPERSEDED'),
        `prompt and use_device disagree about whether ${id} is the live device`,
      ).toBe(by[id].superseded === true)
    }
  })
})

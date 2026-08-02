// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  makeFlipperStatusTool, makeFlipperListenTool, makeFlipperFilesTool,
  resolveFlipperHost, parseCaps, listenBudget, FLIPPER_CAP, MAX_LISTEN_S,
} from '../lib/chat/tools/flipper'

/**
 * flipper_* — the tools for a Flipper Zero, which reaches tiny.technology by a
 * third route again: not its own node (Nicla Vision), not a phone BLE gateway
 * (Nicla Voice), but a USB cable into an enrolled laptop.
 *
 * Four bug classes, each one something that either did happen or would read as
 * success:
 *
 * 1. RESOLVING BY A PLATFORM THAT DOESN'T EXIST. There is no device row with
 *    `platform === 'flipper-zero'` and there never will be — the Flipper has no
 *    network stack and cannot enroll. It is a CAPABILITY of its host, declared
 *    live in the host's heartbeat. A copy-paste of the nicla resolver would
 *    match nothing, forever, and report "no Flipper enrolled" with one plugged in.
 *
 * 2. TOOLS FOR HARDWARE PATHS THAT CANNOT WORK. Measured on firmware unlshd-075:
 *    `nfc` has an EMPTY subcommand list (every form returns a usage blob, never a
 *    scan), and `loader open` cannot be undone because this loader has no `close`
 *    — after it, every command answers "Other application is running" until
 *    `power reboot`. So there must be no flipper NFC-scan tool and no app-launch
 *    tool. Both would be confident failures.
 *
 * 3. ROSTER DRIFT. No central registry — four inline lists. nicla_take_video was
 *    absent from job-run for its whole life with nothing failing to reveal it.
 *
 * 4. UNREACHABLE MISREPORTED AS BROKEN. "Offline" here means the LAPTOP is not
 *    heartbeating, not that the Flipper is dead. Saying "your Flipper is offline"
 *    sends the user to charge a device whose battery is fine; the fix is to wake
 *    the laptop or start the CLI.
 */
const NAMES = ['flipper_status', 'flipper_listen', 'flipper_files']
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })

/** Stub the worker's device list (+ relay send/recv when a tool goes through). */
function stubWorker(devices: any[], reply?: string) {
  global.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('/device/list')) return new Response(JSON.stringify({ ok: true, devices }))
    if (u.includes('/device/relay/send')) return new Response(JSON.stringify({ ok: true, id: 'env1' }))
    if (u.includes('/device/relay/recv')) {
      return new Response(JSON.stringify(
        reply === undefined ? {} : { reply: { payload: JSON.stringify({ result: reply }) } },
      ))
    }
    return new Response(JSON.stringify({}), { status: 404 })
  }) as any
}

/** A laptop node with a Flipper on a serial port right now. */
const host = (over: any = {}) => ({
  id: 'h1', name: "studio mac", platform: 'darwin-arm64', online: true,
  capabilities: JSON.stringify(['mcp', 'files', 'computer', 'flipper']), ...over,
})

describe('flipper tool identity', () => {
  it('the three factories produce exactly the three expected names', () => {
    const tools = [makeFlipperStatusTool('u1'), makeFlipperListenTool('u1'), makeFlipperFilesTool('u1')]
    expect(tools.map((t: any) => t.toolSpec.name)).toEqual(NAMES)
  })

  it('all three refuse without a user — devices belong to an account', async () => {
    for (const make of [makeFlipperStatusTool, makeFlipperListenTool, makeFlipperFilesTool]) {
      const t: any = make(null)
      const out = await t._callback({ radio: 'ir' })
      expect(out.ok).toBe(false)
      expect(String(out.error)).toMatch(/login/i)
    }
  })

  it('offers NO nfc-scan tool and NO app-launch tool', () => {
    const text = src('lib/chat/tools/flipper.ts')
    // A tool named for a capability this firmware lacks would be called, would
    // fail, and would fail in a way that looks like "no tag was present".
    expect(text).not.toMatch(/name:\s*'flipper_(scan_)?nfc\w*'/)
    expect(text).not.toMatch(/name:\s*'flipper_(app|launch|open|run_app)\w*'/)
    // Transmit stays behind use_device, where the user's own words are on record.
    expect(text).not.toMatch(/name:\s*'flipper_(tx|transmit|send_ir|replay|emulate)\w*'/)
  })
})

describe('resolving the host', () => {
  it('finds the host by CAPABILITY, never by a flipper platform string', async () => {
    stubWorker([host()])
    const found = await resolveFlipperHost('u1')
    expect(found?.id).toBe('h1')
    // The Flipper cannot enroll itself, so no roster may filter for one. Checked
    // against code with the comments stripped — the header explains this rule by
    // quoting the very pattern it forbids, and matching that is a false alarm.
    const text = src('lib/chat/tools/flipper.ts')
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/platform === 'flipper/)
    expect(text).toMatch(/parseCaps\(x\.capabilities\)\.includes\(FLIPPER_CAP\)/)
    expect(FLIPPER_CAP).toBe('flipper')
  })

  it('ignores nodes with no Flipper attached, and the necklaces', async () => {
    stubWorker([
      host({ id: 'bare', capabilities: JSON.stringify(['mcp', 'files']) }),
      { id: 'n1', name: 'tiny', platform: 'nicla-vision', online: true, capabilities: JSON.stringify(['camera', 'mic']) },
      { id: 'v1', name: 'voice', platform: 'nicla-voice', online: true, capabilities: JSON.stringify(['mic', 'wake']) },
    ])
    expect(await resolveFlipperHost('u1')).toBeNull()
  })

  it('prefers an online host over a stale one', async () => {
    stubWorker([host({ id: 'asleep', online: false }), host({ id: 'awake', online: true })])
    expect((await resolveFlipperHost('u1'))?.id).toBe('awake')
  })

  it('parseCaps survives every shape the capabilities column takes', () => {
    expect(parseCaps(JSON.stringify(['flipper']))).toEqual(['flipper'])
    expect(parseCaps(['Flipper'])).toEqual(['flipper'])   // lowercased for matching
    expect(parseCaps(null)).toEqual([])                   // pre-column device
    expect(parseCaps('{not json')).toEqual([])            // must not throw
    expect(parseCaps(42)).toEqual([])
  })
})

describe('unreachable is not broken', () => {
  it('a sleeping laptop is reported as the laptop, not a dead Flipper', async () => {
    stubWorker([host({ online: false })])
    const t: any = makeFlipperStatusTool('u1')
    const out = await t._callback({})
    expect(out.reachable).toBe(false)
    // The remedy is to wake the machine — saying "your Flipper is offline" would
    // send the user to charge a device whose battery is irrelevant.
    expect(String(out.note)).toMatch(/studio mac/)
    expect(String(out.note)).toMatch(/no network of its own/i)
  })

  it('no host at all explains how a Flipper becomes reachable', async () => {
    stubWorker([])
    const t: any = makeFlipperStatusTool('u1')
    const out = await t._callback({})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/tiny-tech/)
  })

  it('a reachable Flipper reports its firmware and battery', async () => {
    stubWorker([host()], 'firmware unlshd-075, Flipper Zero, battery 91% charging')
    const t: any = makeFlipperStatusTool('u1')
    const out = await t._callback({})
    expect(out.ok).toBe(true)
    expect(out.reachable).toBe(true)
    expect(String(out.details)).toMatch(/unlshd-075/)
  })
})

describe('flipper_listen', () => {
  it('covers the four radios that actually work over the CLI', () => {
    const t: any = makeFlipperListenTool('u1')
    const radios = t.toolSpec.inputSchema.properties.radio.enum
    expect(radios).toEqual(['ir', 'subghz', 'rfid', 'ibutton'])
    // 13.56MHz is absent on purpose and the description must say why, or the
    // agent will keep proposing it to the user as though it were coming.
    expect(t.toolSpec.description).toMatch(/NFC is NOT available/i)
  })

  it('sends the radio-specific action and never a transmit', async () => {
    let prompt = ''
    global.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (u.includes('/device/list')) return new Response(JSON.stringify({ devices: [host()] }))
      if (u.includes('/device/relay/send')) {
        prompt = JSON.parse(JSON.parse(init.body).payload).prompt
        return new Response(JSON.stringify({ ok: true, id: 'e1' }))
      }
      return new Response(JSON.stringify({ reply: { payload: JSON.stringify({ result: 'NEC, A:00, C:15' }) } }))
    }) as any
    const t: any = makeFlipperListenTool('u1')
    const out = await t._callback({ radio: 'ir', seconds: 4 })
    expect(out.ok).toBe(true)
    expect(out.captured).toMatch(/NEC/)
    expect(prompt).toMatch(/ir_rx/)
    expect(prompt).toMatch(/duration 4/)
    expect(prompt).toMatch(/do not transmit/i)
  })

  it('passes the frequency through for subghz', async () => {
    let prompt = ''
    global.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (u.includes('/device/list')) return new Response(JSON.stringify({ devices: [host()] }))
      if (u.includes('/device/relay/send')) {
        prompt = JSON.parse(JSON.parse(init.body).payload).prompt
        return new Response(JSON.stringify({ ok: true, id: 'e1' }))
      }
      return new Response(JSON.stringify({ reply: { payload: JSON.stringify({ result: 'Packets received 0' }) } }))
    }) as any
    const t: any = makeFlipperListenTool('u1')
    await t._callback({ radio: 'subghz', seconds: 3, frequency: 868350000 })
    expect(prompt).toMatch(/subghz_rx/)
    expect(prompt).toMatch(/868350000/)
  })

  it('clamps the listen window — the host holds the radio for all of it', async () => {
    stubWorker([host()], 'ok')
    const t: any = makeFlipperListenTool('u1')
    const out = await t._callback({ radio: 'rfid', seconds: 999 })
    expect(out.listened_s).toBe(MAX_LISTEN_S)
  })

  it('refuses a capture longer than the turn, instead of abandoning it mid-listen', async () => {
    stubWorker([host()], 'ok')
    // A 50s job cannot host a 30s capture plus the round trip. Starting one would
    // leave the host holding the radio after nobody is waiting for the answer.
    const t: any = makeFlipperListenTool('u1', 20)
    const out = await t._callback({ radio: 'ir', seconds: 30 })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/shorter window/i)
  })

  it('listenBudget always outlasts the capture it is waiting on', () => {
    // The tool cannot answer before its own window elapses; a budget shorter
    // than the listen would time out every single time.
    expect(listenBudget(8)).toBeGreaterThan(8)
    expect(listenBudget(30)).toBeGreaterThan(30)
    expect(listenBudget(8, 50)).toBeGreaterThanOrEqual(15)
    expect(listenBudget(8, 50)).toBeLessThanOrEqual(42)
  })
})

describe('flipper_files', () => {
  it('lists names only and tells the host not to read file contents', async () => {
    let prompt = ''
    global.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (u.includes('/device/list')) return new Response(JSON.stringify({ devices: [host()] }))
      if (u.includes('/device/relay/send')) {
        prompt = JSON.parse(JSON.parse(init.body).payload).prompt
        return new Response(JSON.stringify({ ok: true, id: 'e1' }))
      }
      return new Response(JSON.stringify({ reply: { payload: JSON.stringify({ result: '📄 gate.sub' }) } }))
    }) as any
    const t: any = makeFlipperFilesTool('u1')
    const out = await t._callback({ folder: '/ext/subghz' })
    expect(out.ok).toBe(true)
    expect(prompt).toMatch(/action "ls"/)
    // /ext/nfc holds this user's passports, IDs and bank cards. A listing is a
    // reasonable answer to "what have I saved"; the contents are not.
    expect(prompt).toMatch(/do not read/i)
    const t2: any = makeFlipperFilesTool('u1')
    expect(t2.toolSpec.description).toMatch(/does not read/i)
  })
})

describe('roster wiring', () => {
  const ROSTERS = [
    'app/api/chat/route.ts',
    'app/api/job-run/route.ts',
    'lib/voice/tools.ts',
    'app/api/voice/tool/route.ts',
  ]
  const FACTORIES = ['makeFlipperStatusTool', 'makeFlipperListenTool', 'makeFlipperFilesTool']

  it.each(ROSTERS)('%s imports AND calls every flipper factory', (file) => {
    const text = src(file)
    for (const f of FACTORIES) {
      expect(text, `${file} must import ${f}`).toContain(f)
      // Imported-but-never-called is exactly how nicla_take_video went missing.
      expect(text, `${file} must CALL ${f}`).toMatch(new RegExp(`${f}\\s*\\(`))
    }
  })

  it('job-run tells the model the flipper tools exist, and their catch', () => {
    const text = src('app/api/job-run/route.ts')
    const note = text.slice(text.indexOf('const capabilityNote'), text.indexOf('const agent = new Agent'))
    expect(note).toMatch(/flipper_status/)
    // An unattended job cannot present a card to a reader. If the note doesn't
    // say so, a "check my Flipper hourly" job burns its deadline on empty captures.
    expect(note).toMatch(/flipper_listen/)
    expect(note).toMatch(/unattended/i)
  })

  it('each device roster still filters on its OWN identity', () => {
    // The standing rule: a new device class gets its own roster, never a widened
    // filter on someone else's.
    expect(src('lib/chat/tools/nicla.ts')).toMatch(/platform === 'nicla-vision'/)
    expect(src('lib/chat/tools/nicla-voice.ts')).toMatch(/platform === 'nicla-voice'/)
    expect(src('lib/chat/tools/flipper.ts')).toMatch(/FLIPPER_CAP/)
  })
})

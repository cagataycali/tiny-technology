// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FLIPPER_CAP, FLIPPER_BLE_CAP, pickFlipperHost, parseCaps, type FlipperHost,
  listenBudget, filesWait, FILES_WAIT_S, STATUS_WAIT_S, BLE_ROUND_TRIP_S,
} from '../lib/chat/tools/flipper'
import { DEVICE_LABELS, capabilitySummary } from '../lib/chat/prompt'

/**
 * 🐬📶 The Flipper over Bluetooth: the phone holds the link when no cable does.
 *
 * Everything here is a guard, not a demo, and each one pins a failure that is
 * SILENT — which is why they are worth the file. The BLE path has no test
 * hardware in CI and never will, so what can be checked is the contract:
 *
 *   1. the wire constants (UUIDs, protobuf field numbers) are the ones that were
 *      measured on a live board. A wrong field number does not error — protobuf
 *      skips unknown tags, so the app just goes quiet.
 *   2. the credential guard exists on the BLE path too. It lived only in Node on
 *      the cable path; a BLE path without its own copy is a new route around a
 *      guard that protects the user's real passports and bank cards.
 *   3. the {type:'flipper'} envelope is handled in BOTH iOS relay loops. The poll
 *      CLAIMS envelopes, so one an unhandled loop sees is destroyed, not retried.
 *   4. flipper_listen can never route to a phone. There is no receive RPC over
 *      BLE, and "nothing received" is exactly what a working capture of a silent
 *      room says — the one failure the user cannot tell from success.
 *   5. the phone declares flipper_ble, never bare flipper. Sharing the label
 *      would make the backend send a phone a prompt-shaped invoke, which the
 *      phone answers by proxying through /api/chat, where the agent resolves the
 *      same phone again — an unbounded loop, not a slow answer.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * ⚠️ Upstream, every wire constant below is cross-checked against a second
 * record — `docs/flipper-ble-ios-design.md`, the engineering log of what was
 * measured off a live board — so a disagreement fails without the test having to
 * decide which side is the guess. That file is a working note, not part of this
 * repo's published docs site, so the cross-check is not available here and the
 * gateway is the single source. The consequence is worth stating plainly: a UUID
 * or field number changed in the gateway ALONE still passes here. What survives
 * is the pinning — nobody can change one of these numbers without editing this
 * file too, which is where the reader learns the number was measured, not chosen.
 */
const gateway = read('ios/Tiny/Sources/FlipperGateway.swift')
const session = read('ios/Tiny/Sources/Session.swift')
const panel = read('ios/Tiny/Sources/FlipperBlePanel.swift')
const iosPanels = read('ios/Tiny/Sources/Panels.swift')
const tinyApp = read('ios/Tiny/Sources/TinyApp.swift')
const androidPanels = read('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')
const backend = read('lib/chat/tools/flipper.ts')

const FLOW_UUID = '19ED82AE-ED21-4C9D-4145-228E63FE0000'

/**
 * Cut one Swift function body out of a source file by matching braces.
 *
 * The assertions guard the slicer itself: a scraper that silently returns "" is
 * a test that passes forever, which is worse than no test at all.
 */
const swiftBody = (src: string, signature: string): string => {
  const at = src.indexOf(signature)
  expect(at, `${signature} not found — the test is reading the wrong file`).toBeGreaterThan(-1)
  const open = src.indexOf('{', at)
  expect(open, `${signature} has no body`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) {
      const body = src.slice(open + 1, i)
      expect(body.trim().length, `${signature} sliced empty`).toBeGreaterThan(0)
      return body
    }
  }
  throw new Error(`${signature} body never closed`)
}

/**
 * The same source with its comments removed, for the assertions that require an
 * expression to be ABSENT.
 *
 * Prose is not behaviour. A comment that explains why a broken expression was
 * removed has to quote it, and a `not.toMatch` reading the raw file then fails on
 * the explanation of the very fix it is checking for — which teaches you to
 * delete the explanation, the wrong lesson. Only block comments and whole-line
 * `//` are cut: an inline `//` cannot be told apart from the one in `https://`.
 */
const codeOnly = (src: string, mustKeep?: RegExp): string => {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  if (mustKeep) {
    // A few lines of code under a paragraph of comment is NORMAL in this file, and
    // the ratio below is a whole-file heuristic: it failed on a correct 5-line
    // error branch whose comment explains why the branch exists. Same purpose at
    // the right scale — name a token that has to survive the strip.
    expect(stripped, `codeOnly dropped ${mustKeep} — check the regexes`).toMatch(mustKeep)
    return stripped
  }
  expect(stripped.length, 'codeOnly stripped everything — check the regexes')
    .toBeGreaterThan(src.length / 3)
  return stripped
}

/**
 * One `case X:` block out of a Swift switch, up to the next `case`/`default`.
 *
 * Structural on purpose. The byte-window version of this (`slice(at, at + 1600)`
 * plus a `{0,320}` gap between the label and the statement) went red the moment a
 * comment was added inside a case — the third time a fixed window has cost this
 * file a false failure. A window that can red for nothing can also go green
 * covering nothing.
 */
const swiftCase = (body: string, label: string): string => {
  const needle = `case ${label}:`
  const at = body.indexOf(needle)
  expect(at, `${needle} not found — the switch was restructured`).toBeGreaterThan(-1)
  const rest = body.slice(at + needle.length)
  const next = rest.search(/\n\s*(?:case |default:)/)
  const block = next === -1 ? rest : rest.slice(0, next)
  expect(block.trim().length, `${needle} sliced empty`).toBeGreaterThan(0)
  return block
}

/**
 * The one `addObserver(...)` registration that mentions `notification`.
 *
 * Split on the registration boundary, NOT a byte window. The window form
 * (`/didEnterBackgroundNotification[\s\S]{0,400}suspend/`) is the same time bomb
 * this file has now been bitten by four times in its other shape: it holds until
 * someone writes five lines of comment between the name and the call, then goes
 * red on correct code — and had the call sat at 401 it would have gone green
 * covering nothing.
 */
/**
 * A teardown body, following the ONE hop it is allowed to delegate through.
 *
 * The facts that stop being true when a link dies are shared by three callers now
 * (a disconnect, Bluetooth going away, and a deliberate `stop()`), so they live in
 * `linkLost()`. A pin demanding the assignment inside the caller's own braces
 * would go red on exactly the change that removed the duplication — this file's
 * most repeated self-inflicted wound. So: the caller's body plus the shared
 * teardown's, when the caller really does call it.
 */
const teardownFor = (signature: string): string => {
  const body = swiftBody(gateway, signature)
  // ⚠️ The delegation has to be read out of CODE, not out of the body's text. Both
  // callers explain in a comment why the list is shared, and those comments name
  // `linkLost()` — so a raw `includes` follows a hop that a mutant had already
  // deleted, and the shared body's assignments answered for a caller that no longer
  // calls it. Measured: two mutations survived on that, one per caller.
  if (!codeOnly(body, /\S/).includes('linkLost()')) return body
  return `${body}\n${swiftBody(gateway, 'private func linkLost()')}`
}

/** The arms of the `centralManagerDidUpdateState` switch, label and body. */
const stateArms = (): { label: string, body: string }[] => {
  const body = swiftBody(gateway, 'func centralManagerDidUpdateState(')
  const parts = body.split(/\n\s*(?=case |default:)/).slice(1)
  expect(parts.length, 'no switch arms found in centralManagerDidUpdateState')
    .toBeGreaterThan(1)
  return parts.map(p => ({ label: p.slice(0, p.indexOf(':')).trim(), body: p }))
}

const observerFor = (init: string, notification: string): string => {
  const blocks = init.split('NotificationCenter.default.addObserver').slice(1)
  expect(blocks.length, 'no addObserver registrations found at all').toBeGreaterThan(0)
  const block = blocks.find(b => b.includes(notification))
  expect(block, `nothing registers ${notification}`).toBeDefined()
  return block as string
}

const host = (over: Partial<FlipperHost> & Pick<FlipperHost, 'transport'>): FlipperHost => ({
  id: `dev-${over.transport}`, name: over.transport === 'ble' ? 'pocket-phone' : 'workshop-mac',
  online: true, platform: over.transport === 'ble' ? 'ios' : 'darwin', ...over,
})

describe('the BLE wire constants match what was measured on the device', () => {
  // Byte-reversed out of the firmware's serial_service_uuid.inc, then confirmed
  // against a live board. A typo here is a gateway that scans forever.
  const uuids: [string, string][] = [
    ['flipperServiceUUID', '8FE5B3D5-2E7F-4A98-2A48-7ACC60FE0000'],
    ['flipperTxUUID', '19ED82AE-ED21-4C9D-4145-228E61FE0000'],
    ['flipperRxUUID', '19ED82AE-ED21-4C9D-4145-228E62FE0000'],
    ['flipperFlowUUID', '19ED82AE-ED21-4C9D-4145-228E63FE0000'],
  ]

  it.each(uuids)('%s is %s in the gateway', (name, uuid) => {
    expect(gateway).toContain(uuid)
    expect(gateway).toMatch(new RegExp(`${name}\\b`))
  })

  it('TX is subscribed and RX is written — swapping them is a silent dead link', () => {
    // Two characteristics on one service, and nothing in CoreBluetooth complains
    // if you take the wrong one: subscribing to RX just never delivers a frame,
    // and writing to TX fails silently. So the direction is pinned by hand.
    const disc = swiftBody(gateway, 'func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor')
    // TX → notify, RX → stashed for writing.
    expect(swiftCase(disc, 'flipperTxUUID')).toMatch(/setNotifyValue\(true/)
    const rxCase = swiftCase(disc, 'flipperRxUUID')
    expect(rxCase).toMatch(/rxChar = ch/)
    // Stronger than the old byte-window form could be: RX is never subscribed.
    // Subscribing to it delivers nothing, forever, with no error anywhere.
    expect(rxCase, 'RX is the write handle, not a notify source').not.toMatch(/setNotifyValue/)
    // …and the only writer uses that stashed handle, never the notify one.
    const writer = swiftBody(gateway, 'private func writeFrame(')
    expect(writer).toContain('rxChar')
    expect(writer).toContain('writeValue(')
    expect(Array.from(gateway.matchAll(/writeValue\(/g)).length, 'one write path only').toBe(1)
    // Inbound frames are deframed from TX only.
    const inbound = swiftBody(gateway, 'func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor')
    expect(swiftCase(inbound, 'flipperTxUUID')).toMatch(/consume\(value\)/)
  })

  it('the protobuf field numbers are the ones the firmware answers on', () => {
    // PB.Main's oneof field number IS the command. A wrong one is not an error:
    // nanopb skips the unknown tag and answers ERROR_DECODE or nothing at all.
    const pins: [string, number][] = [
      ['commandId', 1], ['status', 2], ['hasNext', 3],
      ['pingReq', 5], ['storageListReq', 7], ['storageListResp', 8],
      ['storageReadReq', 9], ['storageReadResp', 10], ['storageMd5Req', 14],
      ['storageStatReq', 24], ['storageInfoReq', 28], ['deviceInfoReq', 32],
      ['alertReq', 38], ['powerInfoReq', 44], ['stopSession', 19],
    ]
    for (const [name, num] of pins) {
      expect(gateway, `${name} must be field ${num}`)
        .toMatch(new RegExp(`${name}\\s*[:=][^\\n]*\\b${num}\\b`))
    }
  })

  it('the two nested-message traps that cost a spike run are written down', () => {
    // Storage.ListResponse nests twice (Main.8 → ListResponse.1 → File.*).
    // Reading File's fields straight off ListResponse decodes into plausible
    // garbage: every entry a file, every name empty, and nothing throws.
    expect(gateway).toMatch(/msgs\(1\)/)
    expect(gateway).toMatch(/nests? TWICE|ListResponse\.1/i)
    // has_next streaming: DeviceInfo arrives as ~60 one-key frames, and a
    // 701-byte file came back in two. Reading only the first frame looks like a
    // board that answered with one field.
    expect(gateway).toMatch(/hasNext/)
  })
})

describe('the credential guard is on the BLE path, not just the cable one', () => {
  const dirs = ['/ext/nfc', '/ext/lfrfid', '/ext/ibutton', '/ext/u2f', '/ext/subghz']

  it.each(dirs)('%s is refused as a bulk read by the Swift gateway', (dir) => {
    expect(gateway).toContain(dir)
  })

  it('read() consults the guard BEFORE it touches the board', () => {
    const at = gateway.indexOf('func read(')
    expect(at).toBeGreaterThan(0)
    const body = gateway.slice(at, at + 900)
    expect(body).toContain('refuseSweep')
    // Before the request, not after: a guard that fires once the bytes are
    // already in memory has already lost.
    expect(body.indexOf('refuseSweep')).toBeLessThan(body.indexOf('request('))
  })

  it('a single named capture is still readable — the guard is on sweeps only', () => {
    // Faithful to tiny-tech's isSensitiveSweep: a person asking for one card is
    // not an agent walking the whole wallet into a transcript. A stricter rule
    // here would be a different feature, silently.
    expect(gateway).toMatch(/sensitiveDirs\.contains\(p\)/)
    expect(gateway).not.toMatch(/hasPrefix\("\/ext\/nfc"\)/)
  })

  it('an oversized file is refused by its stat, not after being read', () => {
    const at = gateway.indexOf('func read(')
    const body = gateway.slice(at, at + 1200)
    expect(body).toContain('storageStatReq')
    expect(body.indexOf('storageStatReq')).toBeLessThan(body.indexOf('storageReadReq'))
    // The relay caps a reply at 7000 chars; the gateway must refuse under it.
    const cap = gateway.match(/maxReadBytes\s*=\s*(\d+)/)
    expect(cap).toBeTruthy()
    expect(Number(cap![1])).toBeLessThan(7000)
  })
})

describe('{type:"flipper"} is handled in BOTH iOS relay loops', () => {
  // The relay poll claims each envelope it returns (compare-and-swap on
  // delivered 0→1), so an envelope a loop does not handle is CONSUMED and gone,
  // not deferred to the other loop. {type:"record"} is duplicated for exactly
  // this reason and this must be too.
  it('the foreground poll and backgroundBeat both dispatch it', () => {
    const hits = Array.from(session.matchAll(/payload\["type"\] as\? String == "flipper"/g))
    expect(hits.length, 'one branch per relay loop').toBe(2)

    const bg = session.indexOf('func backgroundBeat()')
    expect(bg).toBeGreaterThan(0)
    // One branch before backgroundBeat (the foreground poll), one inside it.
    expect(hits.filter(h => h.index! < bg).length).toBe(1)
    expect(hits.filter(h => h.index! > bg).length).toBe(1)
  })

  it('both branches sit ABOVE the invoke fall-through', () => {
    // Below it, a Flipper ask would be proxied into /api/chat, where the agent
    // has flipper_status, which resolves this phone again — the loop.
    const flips = Array.from(session.matchAll(/== "flipper"/g)).map(m => m.index!)
    const invokes = Array.from(session.matchAll(/== "invoke"/g)).map(m => m.index!)
    expect(invokes.length).toBe(2)
    invokes.forEach((inv, i) => expect(flips[i]).toBeLessThan(inv))
  })

  it('one shared handler, so the two loops cannot drift apart', () => {
    expect(session).toContain('static func handleFlipperEnvelope')
    expect(Array.from(session.matchAll(/handleFlipperEnvelope\(payload\)/g)).length).toBe(2)
  })

  it('the handler answers a capture ask with a refusal, never with silence', () => {
    // Braces, not a byte count. This used to slice `at + 4500`, which is a window
    // that SHRINKS as the function grows: adding five lines of comment above the
    // listen case moved the refusal outside it and the test went red for a reason
    // that had nothing to do with the guard. A fixed window that had happened to
    // land at 4499 would instead have gone quietly green while covering nothing.
    const body = swiftBody(session, 'static func handleFlipperEnvelope(')
    for (const a of ['ir_rx', 'subghz_rx', 'rfid_read', 'ikey_read']) {
      expect(body, `${a} must be refused explicitly`).toContain(a)
    }
    expect(body).toMatch(/not possible over Bluetooth/i)
  })
})

/**
 * A reply that got cut says it got cut.
 *
 * Everything this handler returns is relayed to the agent as the answer, and the
 * relay itself truncates at 7000 characters (`relay.ts`:
 * `String(result).slice(0, 7000)`). So a cut reply is not a partial answer, it is
 * a WRONG one delivered confidently:
 *   • a folder listing missing its tail reads as "that card isn't on the SD" —
 *     `list()` is uncapped, so a heavy /ext/nfc reaches the limit for real;
 *   • an entry cut mid-name is a filename that does not exist, which the agent
 *     will then try to read;
 *   • a hex preview whose header states the FULL byte count reads as the whole
 *     file. `maxReadBytes` allows 6000 bytes and the preview window is 1024, so
 *     an allowed file could arrive 83% missing and look complete.
 *
 * The cable path has always appended `…` here (tiny-tech/src/agent/flipper.ts —
 * gitignored local checkout, so it can't be asserted from CI, but that is where
 * the shared rule lives). The BLE port dropped it while claiming parity in a
 * comment, which is why these are pinned by test now instead.
 */
describe('no relay reply is ever silently truncated', () => {
  const handler = swiftBody(session, 'static func handleFlipperEnvelope(')

  it('nothing in the handler calls prefix() as its own truncation', () => {
    // `.prefix(n)` is the exact shape of the bug: it cuts and says nothing.
    // Truncation goes through fitReply, which appends the reason.
    expect(handler).not.toMatch(/\.prefix\(\d+\)/)
    expect(gateway).toMatch(/static func fitReply/)
  })

  it('fitReply states the cut inside the reply the agent reads', () => {
    const fit = swiftBody(gateway, 'static func fitReply(')
    expect(fit).toMatch(/replyBudget/)
    expect(fit).toMatch(/cut here/)
    // The note has to fit INSIDE the budget, or appending it re-overruns the cap
    // and the relay cuts the explanation off — leaving the silent truncation back.
    expect(fit).toMatch(/replyBudget - note\.count/)
  })

  it('the budget stays under the relay cap it is protecting against', () => {
    const budget = gateway.match(/replyBudget = (\d+)/)
    expect(budget).toBeTruthy()
    expect(Number(budget![1])).toBeLessThan(7000)
  })

  it('a long listing is cut on ENTRY boundaries and says how many it showed', () => {
    const listing = handler.slice(handler.indexOf('case "files"'), handler.indexOf('case "read"'))
    expect(listing).toContain('replyBudget')
    // Built up entry by entry, stopping before the line that would overrun —
    // not joined and then sliced through the middle of a filename.
    expect(listing).toMatch(/\bbreak\b/)
    expect(listing).toMatch(/of \\\(entries\.count\) shown/)
    expect(listing).not.toMatch(/\.prefix\(/)
    // ⚠️ And the sentence has to be REACHABLE. The line above only proves the
    // words are in the file; a mutation that left them behind a dead condition
    // passed it, which is the exact bug this whole suite exists to catch — a
    // reply that got cut saying nothing. So the comparison is pinned too.
    expect(listing, 'the count is unreachable — a cut listing goes back to silence')
      .toMatch(/if shown < entries\.count \{/)
  })

  it('a hex preview admits it is a preview, with both numbers', () => {
    const read = handler.slice(handler.indexOf('case "read"'))
    // The window is the cable's, so one .sub reads the same either way…
    expect(gateway).toMatch(/hexPreviewBytes = 1024/)
    expect(read).toContain('hexPreviewBytes')
    // …including the marker, which is the half the port lost.
    //
    // ⚠️ Pinned as part of the emitted STRING, not as "an ellipsis appears
    // somewhere in this slice". The comment two lines above the code quotes the
    // very character it is explaining, so the loose form passes with the marker
    // deleted — verified by mutation, which is how this tightening was found.
    expect(read).toMatch(/\?\s*"…/)
    expect(read).toMatch(/first \\\(window\) of \\\(data\.count\) bytes/)
  })

  it('the size gate and the preview window are not confused for each other', () => {
    // Two different questions: maxReadBytes asks "can this come back at all",
    // hexPreviewBytes asks "how much hex is useful in a transcript". They are
    // allowed to differ — but only because the reply now says which one bit.
    const cap = Number(gateway.match(/maxReadBytes = (\d+)/)![1])
    const window = Number(gateway.match(/hexPreviewBytes = (\d+)/)![1])
    expect(cap).toBeGreaterThan(window)
    expect(window * 2).toBeLessThan(Number(gateway.match(/replyBudget = (\d+)/)![1]))
  })
})

describe('routing: the cable wins, the phone is the fallback, capture is cable-only', () => {
  it('an awake cable host beats an awake phone', () => {
    // Not a preference — the CLI is the strict superset, and it spends a
    // laptop's power instead of the phone's.
    const picked = pickFlipperHost(
      { cable: host({ transport: 'cable' }), ble: host({ transport: 'ble' }) },
      { overBle: true },
    )
    expect(picked?.transport).toBe('cable')
  })

  it('a sleeping laptop hands the work to the phone — the whole point', () => {
    const picked = pickFlipperHost(
      { cable: host({ transport: 'cable', online: false }), ble: host({ transport: 'ble' }) },
      { overBle: true },
    )
    expect(picked?.transport).toBe('ble')
    expect(picked?.name).toBe('pocket-phone')
  })

  it('a capture never routes to the phone, even when the phone is the only link', () => {
    const picked = pickFlipperHost(
      { cable: null, ble: host({ transport: 'ble' }) },
      { overBle: false },
    )
    expect(picked).toBeNull()   // → the caller explains why, in words
  })

  it('a capture with a sleeping laptop names the laptop, not the phone', () => {
    // The useful sentence is "wake the cabled mac", and it is only reachable if an
    // OFFLINE cable host is returned rather than nulled.
    const picked = pickFlipperHost(
      { cable: host({ transport: 'cable', online: false }), ble: host({ transport: 'ble' }) },
      { overBle: false },
    )
    expect(picked?.transport).toBe('cable')
    expect(picked?.online).toBe(false)
  })

  it('no route at all is null on both transports', () => {
    expect(pickFlipperHost({ cable: null, ble: null }, { overBle: true })).toBeNull()
  })

  it('flipper_listen passes null for the BLE alternative; the others pass an action', () => {
    const at = backend.indexOf('makeFlipperListenTool')
    const listen = backend.slice(at, backend.indexOf('makeFlipperFilesTool'))
    expect(listen).toMatch(/flipperInvoke\(/)
    expect(listen, 'a listen must offer no BLE action').toMatch(/\n\s*null,\n\s*\)/)
    expect(listen).not.toMatch(/action: '(status|files)'/)

    const files = backend.slice(backend.indexOf('makeFlipperFilesTool'))
    expect(files).toMatch(/action: 'files'/)
    const status = backend.slice(backend.indexOf('makeFlipperStatusTool'), at)
    expect(status).toMatch(/action: 'status'/)
  })

  it('the BLE host gets a STRUCTURED envelope, never a prompt', () => {
    // The loop-avoidance rule, at the one line that could reintroduce it.
    expect(backend).toMatch(/type: 'flipper', action:/)
    const at = backend.indexOf("type: 'flipper', action:")
    const around = backend.slice(at - 400, at + 300)
    expect(around).toMatch(/transport === 'ble'/)
    expect(around).toMatch(/type: 'invoke', prompt: instruction/)
  })

  it('every answer names its transport, so the agent can say which route it took', () => {
    expect(backend).toMatch(/transport: r\.transport/)
    expect(backend).toMatch(/via:/)
  })
})

describe('the phone declares flipper_ble, and only when the link is real', () => {
  it('the capability is the distinct label, not bare flipper', () => {
    expect(FLIPPER_CAP).toBe('flipper')
    expect(FLIPPER_BLE_CAP).toBe('flipper_ble')
    expect(FLIPPER_BLE_CAP).not.toBe(FLIPPER_CAP)
    expect(parseCaps('["flipper_ble"]')).toContain(FLIPPER_BLE_CAP)
  })

  it('iOS adds it to the heartbeat only while linked', () => {
    expect(session).toMatch(/beatCapabilities/)
    expect(session).toMatch(/FlipperGateway\.shared\.linked \? capabilities \+ \["flipper_ble"\]/)
  })

  it('a link that comes or goes re-asserts capabilities mid-run', () => {
    // capabilities are sent on the FIRST beat only (assertCaps), so a
    // come-and-go capability that never re-asserts is stuck at whatever it was
    // when the app launched — the tool then routes to a phone holding nothing.
    expect(session).toMatch(/hadFlipper/)
    expect(session).toMatch(/hasFlipper != hadFlipper\s*\{\s*assertCaps = true/)
  })

  it('the label carries a real sentence into the system prompt', () => {
    expect(DEVICE_LABELS as readonly string[]).toContain('flipper_ble')
    const line = capabilitySummary(['flipper_ble'])
    expect(line).not.toBe(' — can: flipper_ble')
    expect(line).toMatch(/bluetooth/i)
    // It must also say what it CANNOT do, or the agent will offer a capture.
    expect(line).toMatch(/no radio capture/i)
  })

  it('both phones know the token — the parity suite scrapes iOS for it', () => {
    expect(iosPanels).toMatch(/case "flipper_ble": return "/)
    expect(androidPanels).toMatch(/"flipper_ble" -> Icons\./)
    expect(iosPanels).toContain('"flipper_ble": "Flipper (Bluetooth)"')
    expect(androidPanels).toContain('"flipper_ble" to "Flipper (Bluetooth)"')
  })
})

describe('the gateway respects the one-central and flow-control rules', () => {
  it('reconnects on a backoff, like the Nicla gateway', () => {
    // The Flipper accepts a single BLE central. Re-dialling from the disconnect
    // handler is a tight loop against a board that is out of range.
    expect(gateway).toMatch(/scheduleReconnect/)
    expect(gateway).toMatch(/\b32\b/)   // the ceiling, in seconds
  })

  it('honours the flow-control credits when writing', () => {
    // The characteristic notifies a big-endian uint32 of free RX buffer;
    // ignoring it makes the firmware warn about overflow and drop frames.
    expect(gateway).toMatch(/credits/)
    expect(gateway).toContain(FLOW_UUID)
    // Big-endian, and byte-reversed relative to how the phone reads integers:
    // read it the native way and a 512-byte budget becomes 33 554 432.
    expect(gateway).toMatch(/bigEndian|reversed/)
  })

  it('the panel never claims a link it does not have', () => {
    // `linked` is set after a ping round-trips, not on didConnect: a connected
    // peripheral whose RPC session never opened would otherwise read as ready.
    expect(gateway).toMatch(/func finishLink/)
    const at = gateway.indexOf('func finishLink')
    const body = gateway.slice(at, at + 800)
    expect(body).toMatch(/ping\(\)/)
    expect(body.indexOf('ping()')).toBeLessThan(body.indexOf('linked = true'))
  })

  it('the pairing sheet tells the user where the 6-digit code appears', () => {
    // Bonding is mandatory (ATTR_PERMISSION_AUTHEN_* on every characteristic).
    // The prompt comes from iOS and the code from the board — neither is
    // something the app can show, so it must at least say so.
    expect(panel).toMatch(/6-digit/)
    expect(panel).toMatch(/Bluetooth/)
  })
})

/**
 * A frame reaches the board whole, or it does not go at all.
 *
 * The board's RPC parser reads a varint length and then waits for exactly that
 * many bytes. So a frame cut off halfway is not a lost command, it is a POISONED
 * SESSION: the next request's bytes are consumed as the abandoned frame's tail,
 * every command after that decodes as garbage, and nothing resyncs it short of
 * dropping the link. The only symptom is a timeout — which reads as "the Flipper
 * isn't answering", so the transport gets blamed for what the phone did.
 *
 * The first version of `write()` shipped exactly that bug: it checked the credit
 * budget per chunk and `break`-ed when it ran short, which is fine on chunk 0 and
 * fatal on chunk 1. These guards pin the two halves of the fix — reserve for the
 * whole frame before writing any of it, and serialise whole frames so two
 * writers can't interleave their chunks into the same corruption by another
 * route — plus the recovery that limits the damage when a desync happens anyway.
 */
describe('a partial protobuf frame can never reach the board', () => {
  const writeFrame = swiftBody(gateway, 'private func writeFrame(')

  it('reserves room for the WHOLE frame before the first chunk goes out', () => {
    // The reservation is the invariant: once the loop starts, it cannot run out.
    expect(writeFrame).toMatch(/waitForRoom\(data\.count\)/)
    expect(writeFrame.indexOf('waitForRoom')).toBeLessThan(writeFrame.indexOf('while offset'))
  })

  it('the chunk loop has no early exit — nothing can stop it mid-frame', () => {
    const loop = writeFrame.slice(writeFrame.indexOf('while offset'))
    expect(loop).toContain('writeValue')
    expect(loop).not.toMatch(/\bbreak\b/)
    expect(loop).not.toMatch(/\breturn\b/)
    // And no suspension point either: an await inside the loop would let a
    // second writer's chunks interleave with this frame's.
    expect(loop).not.toMatch(/\bawait\b/)
  })

  it('runs out of buffer as its own error, with nothing written', () => {
    // Distinct from .timeout on purpose: the cause is the board's buffer, the
    // cure is retrying in a moment, and the command provably never left.
    expect(gateway).toMatch(/case noRoom/)
    expect(writeFrame).toMatch(/fail\(id, FlipperError\.noRoom\)/)
    expect(writeFrame.indexOf('noRoom')).toBeLessThan(writeFrame.indexOf('writeValue'))
    const waitForRoom = swiftBody(gateway, 'private func waitForRoom(')
    // nil credits means the characteristic has never notified: there is no
    // budget to honour, and waiting for one would deadlock on a number that is
    // never coming.
    expect(waitForRoom).toMatch(/credits/)
    expect(waitForRoom).toMatch(/return true/)
  })

  it('serialises whole frames, so two requests cannot interleave chunks', () => {
    const enqueue = swiftBody(gateway, 'private func enqueueWrite(')
    expect(enqueue).toMatch(/writeChain/)
    expect(enqueue).toMatch(/await previous/)          // chained, not concurrent
    expect(enqueue.indexOf('await previous')).toBeLessThan(enqueue.indexOf('writeFrame'))
    // request() must go through the queue, never straight at the characteristic.
    const request = swiftBody(gateway, 'private func request(')
    expect(request).toMatch(/enqueueWrite\(framed, id: id\)/)
    expect(request).not.toMatch(/writeValue/)
  })

  it('recovers from a desync instead of stalling on it forever', () => {
    const consume = swiftBody(gateway, 'private func consume(')
    // A bogus length is the one input the deframer cannot wait out: it would
    // hold every later notify in the buffer and deliver nothing, silently.
    expect(consume).toMatch(/maxFrameBytes/)
    expect(consume).toMatch(/maxVarintBytes/)
    expect(consume).toMatch(/desync\(/)
    const desync = swiftBody(gateway, 'private func desync(')
    expect(desync).toMatch(/inbox = \[\]/)             // start the next frame clean
    expect(desync).toMatch(/failAllPending/)           // don't leave callers hanging
    expect(desync).toMatch(/lastError/)                // and say so where it shows
  })

  it('the frame ceiling is above anything the firmware actually sends', () => {
    // A screen frame is 1024 bytes plus wrapper and a Storage.Read chunk about
    // the same, so the ceiling must clear those by a wide margin — a limit set
    // too tight would reject real traffic as corruption.
    const ceiling = gateway.match(/maxFrameBytes: UInt64 = (\d+)/)
    expect(ceiling).toBeTruthy()
    expect(Number(ceiling![1])).toBeGreaterThan(4096)
    // Ten bytes is the most a varint can be, so more than that without one
    // parsing proves those bytes are not a length prefix.
    expect(gateway).toMatch(/maxVarintBytes = 10\b/)
  })
})

/**
 * P6 — the screen mirror and the six buttons: the only part of this feature the
 * cable has no answer for. The USB CLI has no screenshot command and no way to
 * inject input, so this is not BLE catching up, it is BLE's own half of the
 * asymmetry that makes flipper_listen cable-only.
 *
 * Two of these guards protect the user rather than the code:
 *   • a remote button press is a TRANSMIT by another name — navigate to a saved
 *     .sub, tap OK, and someone's gate opens — so the relay path must never be
 *     able to reach the input API, no matter what a prompt asks for.
 *   • the framebuffer layout is page-major with bits running down the screen. A
 *     row-major read of the same 1024 bytes renders a plausible-looking smear,
 *     which is the kind of wrong that survives a code review and a glance.
 */
describe('the screen stream and buttons are wired to the numbers the firmware answers on', () => {
  it('the Gui field numbers match the proto, in the gateway and in the doc', () => {
    const pins: [string, number][] = [
      ['guiStartStreamReq', 20], ['guiStopStreamReq', 21],
      ['guiScreenFrame', 22], ['guiInputReq', 23],
    ]
    for (const [name, num] of pins) {
      expect(gateway, `${name} must be field ${num}`)
        .toMatch(new RegExp(`${name}\\s*[:=][^\\n]*\\b${num}\\b`))
    }
    // The framebuffer layout is the other measured fact these four numbers are
    // useless without, and it has to be written down where the decoder is.
    expect(gateway + panel).toMatch(/page-major|u8g2/i)
  })

  it('the key and input-type enums carry the firmware numbering', () => {
    // PB_Gui.InputKey and InputType. UP and PRESS are both 0, which is also why
    // the encoder writes explicit zeros — an omitted default would put an empty
    // body on the wire, indistinguishable from a message nobody filled in.
    expect(gateway).toMatch(/case up = 0, down = 1, right = 2, left = 3, ok = 4, back = 5/)
    expect(gateway).toMatch(/case press = 0, release = 1, short = 2, long = 3/)
    const at = gateway.indexOf('private func input(')
    const body = gateway.slice(at, at + 800)
    expect(body).toMatch(/PB\.int\(1, UInt64\(key\.rawValue\)\)/)
    expect(body).toMatch(/PB\.int\(2, UInt64\(type\.rawValue\)\)/)
  })

  it('a screen frame is routed by CONTENT, ahead of the command_id lookup', () => {
    // The board pushes frames unsolicited, so nothing may depend on which id the
    // firmware stamps on them. And if it echoes the start request's id, an
    // id-first match would resolve that request with a picture instead of its
    // acknowledgement, then pile frames onto an entry nobody is holding.
    const at = gateway.indexOf('private func deliver(')
    expect(at).toBeGreaterThan(0)
    const body = gateway.slice(at, at + 1600)
    expect(body).toContain('guiScreenFrame')
    expect(body.indexOf('guiScreenFrame')).toBeLessThan(body.indexOf('pending['))
  })

  it('streaming goes up BEFORE the request, or the first frame is lost', () => {
    // The firmware sends a frame when the screen REDRAWS. A Flipper resting on a
    // static menu may not redraw for minutes, so a frame dropped because the
    // flag wasn't set yet is a mirror that stays blank on a board that works.
    // Brace-matched, not `slice(at, at + 1400)`: a fixed window has gone red for
    // nothing three times in this file, and had `request(` ever landed past the
    // end it would have gone green covering nothing.
    const body = swiftBody(gateway, 'func startScreenStream() async throws {')
    expect(body).toContain('streaming = true')
    expect(body.indexOf('streaming = true')).toBeLessThan(body.indexOf('request('))
    // …and it comes back down if the board refuses, so the panel doesn't wait
    // forever for frames from a stream that never started.
    expect(body).toMatch(/catch[\s\S]{0,120}streaming = false/)
  })

  it('the stream is stopped by every exit — the sheet, a drop, and stop()', () => {
    // A stream nobody stops keeps the board sending a kilobyte per redraw, on
    // its own battery, to a view that closed.
    expect(panel).toMatch(/onDisappear[\s\S]{0,120}stopScreenStream/)
    // Non-throwing on purpose: the only thing a caller could do with a failure
    // here is leave it running.
    expect(gateway).toMatch(/func stopScreenStream\(\) async \{/)

    // Signatures, not bare names: prose mentioning `didDisconnectPeripheral` in
    // a comment elsewhere in the file would otherwise be sliced as the body and
    // the test would report on the wrong code.
    for (const [where, sig] of [
      ['stop()', 'func stop() {'],
      ['a disconnect', 'didDisconnectPeripheral peripheral:'],
    ] as const) {
      const body = teardownFor(sig)
      // Both the flag and the last picture: a mirror still showing its final
      // frame is claiming to be live.
      expect(body, `${where} must clear streaming`).toMatch(/streaming = false/)
      expect(body, `${where} must clear the frame`).toMatch(/screenFrame = nil/)
    }
  })

  it('a tap sends PRESS, SHORT and RELEASE — a hold sends LONG in the middle', () => {
    // Not SHORT alone: a view that tracks the key being down (a game, or the IR
    // app transmitting while OK is held) would see a key go short without ever
    // being pressed or released, and stay stuck in whatever that left.
    //
    // Sliced by braces, not by `slice(at, at + 900)`: that window form has cost
    // this file four false reds in its other shapes, and this cycle grew the
    // function past 900 bytes.
    const body = swiftBody(gateway, 'func send(')
    expect(body).toMatch(/input\(key, \.press\)/)
    expect(body).toMatch(/input\(key, hold \? \.long : \.short\)/)
    expect(body).toMatch(/input\(key, \.release\)/)
    expect(body.indexOf('.press')).toBeLessThan(body.indexOf('.long'))
    expect(body.indexOf('.long')).toBeLessThan(body.indexOf('.release'))
    // Chained, not concurrent: two overlapping taps would interleave as
    // PRESS(up), PRESS(ok), SHORT(up)… which is a chord nobody pressed.
    expect(body).toContain('inputChain')
    expect(body).toMatch(/await previous\?\.value/)
  })

  it('the framebuffer is decoded page-major, bits running down the screen', () => {
    // 1024 bytes = 8 pages × 128 columns, bit (y % 8), LSB topmost. Read
    // row-major instead and it renders a recognisable-looking smear.
    const at = panel.indexOf('static func image(')
    expect(at).toBeGreaterThan(0)
    const body = panel.slice(at, at + 1600)
    expect(body).toMatch(/let w = 128, h = 64/)
    expect(body).toMatch(/1 << \(y % 8\)/)
    expect(body).toMatch(/bytes\[page \* w \+ x\]/)
    // A short frame draws nothing rather than half a screen of garbage.
    expect(body).toMatch(/bytes\.count >= w \* h \/ 8/)
    // Crisp pixels: interpolating a 128×64 grid up to phone size turns the
    // Flipper's screen into a photo of a screen.
    expect(body).toMatch(/shouldInterpolate: false/)
    expect(panel).toMatch(/\.interpolation\(\.none\)/)
  })

  it('a blank mirror says why, instead of reading as a broken link', () => {
    expect(panel).toMatch(/[Ww]aiting for the Flipper to redraw/)
  })

  it('⚠️ the relay can never press a button — that is a transmit by another name', () => {
    // The whole reason transmit stays out of the tool surface: navigating to a
    // saved .sub and tapping OK sends it. A phone that would press buttons for a
    // prompt is physical action on someone's gate from words the user never said.
    const at = session.indexOf('static func handleFlipperEnvelope')
    expect(at).toBeGreaterThan(0)
    const body = session.slice(at, at + 5000)
    for (const verb of ['press', 'button', 'input', 'screen', 'tap', 'key']) {
      expect(body, `no case "${verb}" may reach the board`).not.toContain(`case "${verb}"`)
    }
    // Stronger than the action list: the relay file must not reference the input
    // or streaming API at all, so a future action cannot quietly call it.
    expect(session).not.toMatch(/FlipperKey/)
    expect(session).not.toMatch(
      /FlipperGateway\.shared\.(send|startScreenStream|stopScreenStream|suspendScreenStream|resumeScreenStreamIfWanted)/)
    // …and no tool names one either.
    expect(backend).not.toMatch(/name:\s*'flipper_(press|button|input|key|screen|screenshot)\w*'/)
  })

  it('the buttons are reachable only from the panel, under the user\'s own thumb', () => {
    expect(panel).toMatch(/struct FlipperScreenSheet/)
    expect(panel).toMatch(/FlipperKeyButton/)
    // Six keys, all of them, so a d-pad missing a direction fails here.
    for (const k of ['.up', '.down', '.left', '.right', '.ok', '.back']) {
      expect(panel, `${k} must be on the pad`).toContain(`key: ${k}`)
    }
  })
})

/**
 * A reading is two facts — the values and WHEN they were read — and the second
 * one was missing everywhere.
 *
 * `refresh()` wraps all three reads in `try?` and keeps the previous `info` when
 * they fail, deliberately: a board that answers two of three is worth showing,
 * and a blank panel is worse than a stale line. But total failure then looked
 * identical to success, and both consumers presented the kept reading as current
 * — the panel by stamping `Date()` after the call regardless of its outcome, the
 * relay reply by carrying no age at all. The failure that matters is not a dead
 * link (that one is obvious) but a live link to a board that has stopped
 * answering RPC, which is what an app opening on its screen does: every read
 * times out and a flat Flipper reports "🔋 100% charged".
 */
describe('a status reading never claims to be newer than it is', () => {
  const refresh = swiftBody(gateway, 'func refresh(within budget:')
  const statusLine = swiftBody(gateway, 'func statusLine(')

  it('refresh reports whether it learned anything, and dates only what it learned', () => {
    // The return value IS the fix: without it every caller had to assume success.
    expect(gateway).toMatch(/@discardableResult\s*\n\s*func refresh\(within budget: TimeInterval = \.infinity\) async -> Bool/)
    expect(refresh).toMatch(/return learned/)
    // info and infoAt move together or not at all. Two separate `if`s would let a
    // future edit re-date a reading it did not replace, which is the whole bug.
    expect(refresh).toMatch(/if learned \{[^}]*self\.info = reading[^}]*self\.infoAt = Date\(\)[^}]*\}/s)
    expect(gateway).toMatch(/@Published private\(set\) var infoAt: Date\?/)
  })

  it('the panel dates the reading by when the BOARD answered, not when asked', () => {
    // The regression this replaces, exactly as it was: `stamp = Date()` on the
    // line after the await, unconditional.
    expect(panel).not.toMatch(/stamp = Date\(\)/)
    expect(panel).not.toMatch(/@State private var stamp/)
    expect(panel).toContain('ReadingAge.asOf(flipper.infoAt)')
    // And a failed refresh has to say so — the figures stay on screen, so
    // silence would read as "these are current".
    const panelRefresh = swiftBody(panel, 'private func refresh() async')
    expect(panelRefresh).toMatch(/let learned = await flipper\.refresh\(\)/)
    expect(panelRefresh).toMatch(/if !learned \{/)
    expect(panelRefresh).toMatch(/note = "Couldn't read the Flipper/)
  })

  it('the relay reply carries the age when the reading is a memory', () => {
    // Three branches, and the middle one is the new one: linked, refresh failed,
    // an old reading in hand.
    expect(statusLine).toMatch(/let fresh = await refresh\(within: Self\.relayStatusBudgetS\)/)
    expect(statusLine).toMatch(/if fresh, let i = info/)
    expect(statusLine).toMatch(/read just now/)
    expect(statusLine).toMatch(/if let i = info, let at = infoAt/)
    expect(statusLine).toMatch(/Self\.age\(of: at\)/)
    expect(statusLine).toMatch(/last reading that worked/)
    // A summary must never be emitted without one qualifier or the other. Every
    // interpolation of `.summary` here is inside a branch that dates it.
    const summaries = statusLine.match(/\\\(i\.summary\)/g) ?? []
    expect(summaries.length).toBe(2)
  })

  it('age is elapsed time, not a clock reading in an unstated timezone', () => {
    const age = swiftBody(gateway, 'static func age(of when: Date')
    expect(age).toMatch(/ago/)
    // Injectable `now`, or the function is untestable and unpinnable.
    expect(gateway).toMatch(/static func age\(of when: Date, now: Date = Date\(\)\)/)
    // Ascending thresholds, so no window can fall through to a wrong unit.
    const bounds = Array.from(age.matchAll(/s < (\d+)/g)).map(m => Number(m[1]))
    expect(bounds.length).toBeGreaterThanOrEqual(3)
    expect(bounds.slice()).toEqual(bounds.slice().sort((a, b) => a - b))
  })

  it('the status read fits inside the wait the backend actually gives it', () => {
    const budget = Number(gateway.match(/relayStatusBudgetS: TimeInterval = (\d+)/)![1])
    const wait = Number(backend.match(/export const STATUS_WAIT_S = (\d+)/)![1])
    // The backend names its own number now, and the tool uses that name — a 45
    // edited to 20 there must not leave this pin passing against a literal.
    expect(backend).toMatch(/^\s+STATUS_WAIT_S,$/m)
    expect(backend).not.toMatch(/flipperInvoke\([\s\S]{0,400}?\n\s+45,/)
    // Two relay hops of up to ~5s each, plus the phone's own poll interval:
    // finishing at the buzzer is finishing too late.
    expect(budget).toBeLessThan(wait / 2)
    // …and inside a BGAppRefresh window, which is the loop most likely to serve
    // this envelope (phone in a pocket, board in the other one).
    expect(budget).toBeLessThan(30)
  })

  it('the budget is load-bearing: the three reads outlast it on their own', () => {
    const each = ['deviceInfoS', 'powerInfoS', 'storageInfoS'].map(
      k => Number(gateway.match(new RegExp(`${k}: TimeInterval = (\\d+)`))![1]))
    const budget = Number(gateway.match(/relayStatusBudgetS: TimeInterval = (\d+)/)![1])
    // If the sum fitted, the budget would be decoration and deleting it would
    // change nothing — this is the assertion that keeps it honest.
    expect(each.reduce((a, b) => a + b, 0)).toBeGreaterThan(budget)
    // Each read asks for min(its own ceiling, what's left) and is SKIPPED when
    // too little remains, rather than being issued with a doomed deadline.
    for (const k of ['deviceInfoS', 'powerInfoS', 'storageInfoS']) {
      expect(refresh, `${k} must be budget-checked`).toContain(`allow(Self.${k})`)
    }
    expect(refresh).toMatch(/left >= Self\.minRequestS \? min\(want, left\) : nil/)
    // No read may bypass the budget by keeping its default timeout.
    expect(refresh).not.toMatch(/await (deviceInfo|powerInfo|storageInfo)\(\)/)
  })
})

describe('a listing answers inside the wait, and a timeout admits how long it waited', () => {
  const filesCase = session.slice(
    session.indexOf('case "files", "ls", "list":'),
    session.indexOf('case "read":'))

  it('the wait a listing gets is a real number, not one Math.min can never reach', () => {
    // listenBudget is a LISTEN budget: need = listenS + 20, so with no listen it
    // returns a flat 20 whatever the job budget is. `Math.min(45, listenBudget(0,
    // …))` therefore always evaluated to 20 — a 45 that could not win, which is
    // the worst kind of constant: one that documents an intention the code does
    // not have.
    expect(listenBudget(0)).toBe(20)
    expect(listenBudget(0, 300)).toBe(20)
    expect(Math.min(45, listenBudget(0, 300))).toBe(20)
    // codeOnly, because flipper.ts's doc block has to quote the expression it
    // removed in order to explain why it was wrong.
    expect(codeOnly(backend), 'the dead Math.min must be gone')
      .not.toMatch(/Math\.min\(45, listenBudget/)
    // The listing now names its own wait, and gets all of it interactively.
    expect(FILES_WAIT_S).toBe(45)
    expect(filesWait()).toBe(FILES_WAIT_S)
    expect(filesWait(300)).toBe(FILES_WAIT_S)
    expect(backend).toMatch(/filesWait\(budgetS\)/)
  })

  it('the phone finishes a relay listing before the backend stops looking', () => {
    const lag = 15                                    // Low Power Mode poll sleep
    const budget = Number(gateway.match(/relayFilesBudgetS: TimeInterval = (\d+)/)![1])
    // The whole point: poll lag + the listing must land inside the wait, with
    // room for the reply to be posted and picked up. This is the inequality that
    // was false before — 15 + 25 = 40 against a 20s wait.
    expect(lag + budget).toBeLessThan(FILES_WAIT_S)
    // And the relay budget must actually be tighter than the panel's ceiling,
    // else it is the same number under a second name.
    const panelCeiling = Number(gateway.match(/listS: TimeInterval = (\d+)/)![1])
    expect(budget).toBeLessThan(panelCeiling)
    expect(lag + panelCeiling).toBeGreaterThan(FILES_WAIT_S - 15)
  })

  it('the relay path passes the budget; the panel keeps its patient default', () => {
    // The envelope handler must not call the bare list() — its default is the
    // human-facing 25s, which is exactly the overrun this fixes.
    expect(filesCase).toContain('timeout: FlipperGateway.relayFilesBudgetS')
    expect(filesCase, 'a bare fg.list(path) would take the panel default')
      .not.toMatch(/fg\.list\(path\)/)
    // list() must still HAVE a patient default, so the SD browser is unchanged.
    expect(gateway).toMatch(/timeout: TimeInterval = FlipperGateway\.listS\)/)
    expect(gateway, 'the literal 25 must be named, not repeated')
      .not.toMatch(/timeout: 25, label: "a folder listing"/)
    expect(swiftBody(gateway, 'func list(')).toContain('timeout: timeout')
  })

  it('a BLE timeout too short to conclude anything says so instead of blaming range', () => {
    // The whole defect in one assertion: a wait under a BLE round trip must not
    // produce a hardware diagnosis. Before, every timeout claimed range or a
    // Bluetooth switch — including the ones where the caller simply left first.
    expect(BLE_ROUND_TRIP_S).toBe(35)
    const short = backend.slice(backend.indexOf('waitS < BLE_ROUND_TRIP_S'))
    expect(short.indexOf('out of Bluetooth range'), 'the short branch must come FIRST')
      .toBeGreaterThan(short.indexOf('not long enough to conclude anything'))
    // Both branches state the wait, because a timeout is two facts.
    const timeoutTail = backend.slice(backend.lastIndexOf('A timeout is TWO facts'))
    expect(timeoutTail.match(/\$\{waitS\}s/g)!.length).toBeGreaterThanOrEqual(3)
    // The long branch may still name range — by then it IS the likely cause —
    // but only after saying the phone had time.
    expect(timeoutTail).toMatch(/had time to reply/)
  })

  it('the round-trip floor is derived from the two lags it is made of', () => {
    const budget = Number(gateway.match(/relayFilesBudgetS: TimeInterval = (\d+)/)![1])
    const statusBudget = Number(gateway.match(/relayStatusBudgetS: TimeInterval = (\d+)/)![1])
    // 35 = 15s Low Power Mode poll sleep + the 20s the gateway allows one action.
    // Both rails share the ceiling, so one floor covers both.
    expect(budget).toBe(statusBudget)
    expect(BLE_ROUND_TRIP_S).toBe(15 + budget)
    // Every wait the BLE rail is given must clear it, or the floor is decoration.
    expect(STATUS_WAIT_S).toBeGreaterThanOrEqual(BLE_ROUND_TRIP_S)
    expect(FILES_WAIT_S).toBeGreaterThanOrEqual(BLE_ROUND_TRIP_S)
    // A clamped job budget can still fall under it — that is the case the honest
    // message exists for, so prove it is reachable rather than theoretical.
    expect(filesWait(25)).toBeLessThan(BLE_ROUND_TRIP_S)
  })
})

/**
 * 🐬📶 The phone must not withdraw a board it is still holding.
 *
 * `backgroundBeat()` used to send the STATIC capability list, which omits
 * `flipper_ble`. The worker REPLACES the stored list whenever a heartbeat carries
 * one, so every BGAppRefresh unlinked a live board server-side — and the
 * foreground loop re-asserts only on a transition, so from its side nothing had
 * changed and nothing put it back. It stayed withdrawn until the link genuinely
 * dropped or the app relaunched.
 *
 * The timing is the point: P5 is "unplug the cable, ask from web chat", and a user
 * in a web browser has the app in the BACKGROUND. The beat that runs during the
 * acceptance test was the one telling the backend there was no Flipper.
 */
describe('a background beat announces the board, it does not withdraw it', () => {
  const bgBeat = swiftBody(session, 'nonisolated static func backgroundBeat(')
  const fgLoop = swiftBody(session, 'func startDeviceLoops(')
  const workerDevices = read('worker/src/devices.ts')

  it('the background beat sends the LIVE capability list, not the static one', () => {
    // codeOnly: the fix's own comment has to name `capabilities` to explain what
    // was wrong, and a raw read would match the explanation instead of the code.
    const code = codeOnly(bgBeat)
    expect(code, 'the background beat must carry a capability list at all')
      .toMatch(/"capabilities": beatCapabilities/)
    expect(code, 'the static list omits flipper_ble, so sending it is a WITHDRAWAL')
      .not.toMatch(/"capabilities": capabilities/)
  })

  it('the background beat asserts unconditionally — it has no state to gate on', () => {
    // Each BGAppRefresh is a fresh call of a `static func`; there is no surviving
    // `hadFlipper` to compare against, so a transition gate here could only be
    // wrong. It is also the ONLY announcer while backgrounded, because the gateway
    // never posts a heartbeat of its own — so a board that links behind a locked
    // screen is invisible to the backend until this line runs.
    const code = codeOnly(bgBeat)
    expect(code).not.toMatch(/hadFlipper|assertCaps/)
    expect(gateway, 'if the gateway ever announces its own link, revisit this')
      .not.toMatch(/devices\/heartbeat/)
  })

  it('both beats carry the computed list; only enrollment may use the static one', () => {
    const code = codeOnly(session)
    // Foreground: transition-GATED, but the value it sends is still the live one.
    expect(code).toMatch(/body\["capabilities"\] = Self\.beatCapabilities/)
    // Background: same value, no gate.
    expect(code).toMatch(/"capabilities": beatCapabilities/)
    // The static list survives in exactly one place — first-launch enrollment,
    // which posts to /api/devices and runs before any gateway exists, so there is
    // no board to declare. Counting them is what makes this pin catch the NEXT
    // beat somebody adds, not just the one that was wrong.
    const staticSends = code.match(/"capabilities": (?:Self\.)?capabilities\b/g) ?? []
    expect(staticSends.length, `static sends found: ${JSON.stringify(staticSends)}`).toBe(1)
    expect(swiftBody(session, 'private func enrollDeviceIfNeeded('))
      .toMatch(/"capabilities": Self\.capabilities/)
  })

  it('a heartbeat list REPLACES rather than merges — why this was destructive', () => {
    // The premise the whole bug rests on. If this ever became a union, sending the
    // wrong list would be harmless and this suite would be over-strict — so pin
    // the real behaviour rather than assume it.
    expect(workerDevices).toMatch(/capabilities = COALESCE\(\?3, capabilities\)/)
    // COALESCE takes the first NON-NULL: omitting caps preserves the stored list,
    // sending caps overwrites it. Null only when the beat truly omitted them.
    expect(workerDevices)
      .toMatch(/capabilities != null \? sanitizeCapabilities\(capabilities\) : null/)
  })

  it('the foreground loop could not have repaired it, which is why it stuck', () => {
    // Kept as a pin because it is the reason the failure was permanent instead of
    // a 30-second blip: the re-assert fires on the PHONE's view changing, and the
    // phone's view had not changed — the server's had.
    expect(fgLoop).toMatch(/if hasFlipper != hadFlipper \{ assertCaps = true/)
    expect(fgLoop).toMatch(/var hadFlipper = FlipperGateway\.shared\.linked/)
  })

  it('flipper_ble lives only in the computed list, because it comes and goes', () => {
    const statics = session.match(/nonisolated static let capabilities = \[([^\]]*)\]/)
    expect(statics, 'the static capability list moved — this test is reading nothing')
      .not.toBeNull()
    expect(statics![1]).not.toContain('flipper_ble')
    expect(session).toMatch(/linked \? capabilities \+ \["flipper_ble"\] : capabilities/)
  })
})

/**
 * The link is not proved until it CAN answer, and a failed bond has to say so.
 *
 * Bonding is the one step of this whole feature a person performs by hand: every
 * characteristic on the serial service is ATTR_PERMISSION_AUTHEN_*, so iOS defers
 * the TX subscription until the user has read a 6-digit code off a 1.4-inch screen
 * and typed it into a prompt. Two failures hid in that gap:
 *
 *   - the proving ping was fired when the subscription was REQUESTED, not
 *     confirmed, and its budget is 8 seconds. A human is routinely slower, so a
 *     correct first pair timed out, nothing retried, and the board finished bonding
 *     into a panel that had already given up.
 *   - a declined prompt or a mistyped code arrives as an ATT authentication error
 *     on `didUpdateNotificationStateFor` and nowhere else — the connection stays
 *     up, discovery already succeeded, and RPC frames are written without waiting
 *     on `didWriteValueFor`. With that callback unimplemented the only symptom was
 *     the same ping timeout, whose message sends the user to the Flipper's screen
 *     to close an app that is not the problem.
 */
describe('a link is proved only once it can answer, and a failed bond says so', () => {
  // Sliced lazily, inside the tests. A slice taken in the describe body runs at
  // COLLECTION time, so deleting the function under test crashes the whole file
  // instead of reding the one pin that covers it — measured: removing
  // `didUpdateNotificationStateFor` reported "no tests" rather than a failure with
  // a name. A mutant that takes the suite down teaches nothing about which guard
  // held.
  const discover = () => swiftBody(gateway, 'func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor')
  const notifyState = () => swiftBody(gateway, 'func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor')
  const finish = () => swiftBody(gateway, 'private func finishLink()')
  /// The `if let error { … }` block itself, brace-matched.
  ///
  /// ⚠️ Everything here is asserted against THIS, never against "the text before
  /// `finishLink()`". That looser region swallowed the `guard characteristic.isNotifying
  /// else { … return }` that follows, so a pin demanding a `return` in the error
  /// path passed with the error path's own `return` deleted — the mutation ran and
  /// nothing went red.
  const errBlock = () => codeOnly(swiftBody(notifyState(), 'if let error'), /lastError = /)

  it('discovery does not ping: subscribing is requested there, never confirmed', () => {
    // The heart of it. `setNotifyValue` is a request; the CCCD write happens after
    // bonding, which is a human typing. A finishLink() reachable from discovery
    // without the already-notifying condition is the original race back again.
    const code = codeOnly(discover())
    expect(code, 'discovery must still ask for the subscription').toMatch(/setNotifyValue\(true, for: ch\)/)
    const calls = code.match(/finishLink\(\)/g) ?? []
    expect(calls.length, 'exactly one guarded finishLink() belongs in discovery').toBe(1)
    expect(code, 'the only finishLink() in discovery is the already-notifying shortcut')
      .toMatch(/if txAlreadyNotifying \{ finishLink\(\) \}/)
  })

  it('a confirmed TX subscription is what starts the ping', () => {
    const body = notifyState()
    expect(body, 'the state callback must prove the link').toMatch(/finishLink\(\)/)
    // Only TX carries answers; flow control failing is survivable, and refusing a
    // link over it would trade a working board for decoration.
    expect(body).toMatch(/guard characteristic\.uuid == flipperTxUUID else \{ return \}/)
  })

  it('an error on the TX subscription never reaches the ping', () => {
    const err = errBlock()
    expect(err, 'a failed subscription is not a link').toMatch(/linked = false/)
    // The early return IS the fix. Without it the error path falls through to the
    // confirmation path and pings a characteristic that will never answer.
    expect(err, 'the error path must leave before the link is proved').toMatch(/\breturn\b/)
    expect(err, 'nothing in the error path may prove a link').not.toMatch(/finishLink\(\)/)
    // And it must come first, so a future edit cannot reorder the two.
    const body = notifyState()
    expect(body.indexOf('if let error'), 'the error branch must precede the ping')
      .toBeLessThan(body.indexOf('finishLink()'))
  })

  it('a declined prompt or mistyped code is named as pairing, not as an operation', () => {
    const text = swiftBody(gateway, 'static func subscribeFailureText(')
    for (const code of ['insufficientAuthentication', 'insufficientEncryption', 'insufficientAuthorization']) {
      expect(text, `${code} is a pairing failure and must be treated as one`).toContain(code)
    }
    expect(text, 'the user needs the actual next action').toMatch(/6-digit code/)
    expect(text).toMatch(/Pairing didn't complete/)
    // A bond the board dropped is the other half: same symptom, different cause,
    // and "pair again" is still the fix.
    expect(text).toContain('peerRemovedPairingInformation')
  })

  it('a failed bond releases the board, and does not re-prompt in a loop', () => {
    // The Flipper takes ONE central. Holding a connection that can never carry a
    // frame is how it looks broken to the user's laptop. But re-dialling raises
    // the pairing prompt again, so the release must be the kind that stops
    // wanting: stop() clears `wanted`, which is what scheduleReconnect() guards on.
    // codeOnly, because the comment right above it has to name `stop()` in order
    // to explain why the release is the kind that stops wanting — and a raw
    // `toMatch` then passes on the explanation with the call itself deleted.
    // Measured: that mutation survived until this line read code only.
    expect(errBlock(), 'the single central slot has to go back').toMatch(/stop\(\)/)
    // mustKeep, not the bare ratio check: `stop()` handed its shared facts to
    // `linkLost()` and what stayed behind is mostly the comment explaining why.
    // The ratio is a whole-FILE heuristic and it tips on a correctly shrunk body.
    expect(codeOnly(swiftBody(gateway, 'func stop()'), /wanted = false/))
      .toMatch(/wanted = false/)
    expect(codeOnly(swiftBody(gateway, 'private func scheduleReconnect()')))
      .toMatch(/guard wanted else \{ return \}/)
  })

  it('a missing TX characteristic is reported, not waited on forever', () => {
    // Now that nothing pings from discovery, a service without TX issues no
    // subscription, so no state callback is ever coming. Silence would be
    // permanent.
    expect(discover()).toMatch(/guard sawTx else \{/)
    expect(discover()).toMatch(/missing the characteristic it answers on/)
  })

  it('a restored central that is already subscribed still links', () => {
    // iOS can hand back a characteristic with notifications already on, and
    // re-requesting that is not guaranteed to produce another state callback.
    // Without this branch a restored session could never prove itself.
    expect(discover()).toMatch(/if ch\.isNotifying \{/)
    expect(codeOnly(read('ios/Tiny/Sources/FlipperGateway.swift')))
      .toMatch(/willRestoreState/)
  })

  it('a second confirmation does not start a second ping', () => {
    expect(finish()).toMatch(/guard !linking else \{ return \}/)
    expect(finish()).toMatch(/linking = true/)
    // And the flag has to clear on both teardown paths, or a stale `linking`
    // makes the next confirmed subscription a no-op — a link that cannot be
    // proved at all, which is worse than the bug being fixed.
    for (const fn of ['func stop()', 'func centralManager(_ central: CBCentralManager, didDisconnectPeripheral']) {
      expect(codeOnly(teardownFor(fn), /linking/), `${fn} must clear linking`)
        .toMatch(/linking = false/)
    }
  })

  it('the ping budget is what made the race bite, and it is still small', () => {
    // 8 seconds. Pinned because the fix is only interesting relative to it: if
    // someone "fixes" a slow first pair by growing this instead, the ping starts
    // racing the human again with a longer stopwatch.
    expect(codeOnly(swiftBody(gateway, 'func ping()')))
      .toMatch(/timeout: 8/)
  })
})

/**
 * 🔋 A screen stream must not outlive the foreground.
 *
 * `.onDisappear` is not the event "the user left the app". A sheet still on screen
 * when the phone locks — or when the user swipes to a browser to ask tiny
 * something, which is this whole feature's reason to exist — never disappears. So
 * the mirror kept running: the board renders and pushes a kilobyte per redraw, on
 * its own battery, at a picture nobody can see, and iOS wakes this app for every
 * frame of it.
 *
 * What makes that more than waste is the rail it lands on. Backgrounded is exactly
 * when the relay poll IS the feature — a web agent reaches the board only through
 * it — so a redraw flood competes for this link and for the app's scraps of
 * background execution with the `flipper_status` the user is sitting there waiting
 * for.
 *
 * The fix is a stop on the way out and a resume on the way in, which only works if
 * the two facts stay apart: `streaming` is whether the BOARD is pushing frames,
 * `streamWanted` is whether a view still wants them. Collapse them and you get
 * either a stream nobody stops or a mirror that never comes back.
 */
describe('a screen stream does not outlive the foreground', () => {
  // Lazily, inside the its: a slice taken in the describe body runs at collection
  // time, so deleting the code under test reports "no tests" instead of a named
  // red — and a mutant that takes the suite down teaches nothing about which
  // guard held.
  const gwInit = () => swiftBody(gateway, 'override private init() {')
  const suspend = () => swiftBody(gateway, 'func suspendScreenStream() async {')
  // Name plus the minimum that disambiguates, so a new parameter does not read as
  // a deleted function.
  const resume = () => swiftBody(gateway, 'func resumeScreenStreamIfWanted(')

  it('leaving the foreground stops the stream', () => {
    // The call, not just the registration: an observer that fires nothing is the
    // same silence as no observer.
    expect(observerFor(gwInit(), 'UIApplication.didEnterBackgroundNotification'))
      .toMatch(/suspendScreenStream\(\)/)
  })

  it('coming back starts it again — the stop is not a one-way trip', () => {
    // Without this the change is a trade, not a fix: the user returns to a mirror
    // that is dark and stays dark until they close and reopen the sheet.
    expect(observerFor(gwInit(), 'UIApplication.willEnterForegroundNotification'))
      .toMatch(/resumeScreenStreamIfWanted\(/)
  })

  it('a suspend keeps the debt: the view still wants its frames', () => {
    // The single thing that separates a suspend from a stop. Clear the flag here
    // and the mirror never comes back, so the guard is that it is not touched.
    expect(codeOnly(suspend(), /endStream/)).not.toMatch(/streamWanted/)
    expect(suspend()).toMatch(/endStream\(\)/)
  })

  it('a view saying it is done clears the debt, through the same wire call', () => {
    const stop = swiftBody(gateway, 'func stopScreenStream() async {')
    expect(stop).toMatch(/streamWanted = false/)
    expect(stop).toMatch(/endStream\(\)/)
    // Both paths stop the board the same way, so they cannot drift apart on what
    // they leave behind — a mirror still showing its final frame claims to be live.
    const end = swiftBody(gateway, 'private func endStream() async {')
    expect(end).toMatch(/streaming = false/)
    expect(end).toMatch(/screenFrame = nil/)
    expect(end).toMatch(/guiStopStreamReq/)
  })

  it('starting a mirror takes the debt on', () => {
    expect(swiftBody(gateway, 'func startScreenStream() async throws {'))
      .toMatch(/streamWanted = true/)
  })

  it('a resume needs a want, a visible app, a link, and no stream running', () => {
    // Four arms in ONE guard: `linked` because a stream needs an RPC session,
    // `!streaming` because these notifications are not guaranteed to alternate (a
    // second start under a live mirror would reset its frame counter), and
    // `foreground` because a view wanting frames says nothing about whether anyone
    // can see them. Asserted arm by arm, order-independent — the order carries no
    // meaning and a verbatim string would red on a correct reshuffle.
    const guard = codeOnly(resume(), /guard/).match(/guard ([^\n]*?) else \{ return \}/)
    expect(guard, 'the resume no longer opens with a single early-return guard').toBeTruthy()
    for (const arm of ['streamWanted', 'foreground', 'linked', '!streaming']) {
      expect(guard![1], `the guard lost its ${arm} arm`).toContain(arm)
    }
  })

  it('a suspend with nothing streaming sends nothing', () => {
    // Otherwise every backgrounding spends an RPC round trip telling the board to
    // stop a stream that was never started.
    expect(codeOnly(suspend(), /guard streaming/)).toMatch(/guard streaming else \{ return \}/)
  })

  it('the stop is held open long enough to actually leave the phone', () => {
    // A stop dropped in the background transition is the original bug with extra
    // steps: the flag is down here and the board is still pushing there, and now
    // nothing is even watching the frames. The write can also sit waiting on
    // flow-control credits first, so the window is not theoretical.
    const body = suspend()
    expect(body).toMatch(/beginBackgroundTask/)
    expect(body).toMatch(/endBackgroundTask/)
    expect(body.indexOf('beginBackgroundTask')).toBeLessThan(body.indexOf('endStream'))
    expect(body.indexOf('endStream')).toBeLessThan(body.indexOf('endBackgroundTask'))
  })

  it('a deliberate unlink owes nothing; a dropped link still does', () => {
    // stop() is the user unlinking the board. Left standing, the next
    // background/foreground pair after a re-link would start a stream for a mirror
    // that closed long ago. A DISCONNECT is the opposite case — it re-dials by
    // itself, and a sheet that is still open still wants its frames.
    expect(codeOnly(swiftBody(gateway, 'func stop() {'), /streamWanted/))
      .toMatch(/streamWanted = false/)
    // Through the shared teardown, because that is where `streaming` went — and it
    // is the half that must NOT mention `streamWanted`: a drop routes through it,
    // so a debt cancelled there is cancelled for the drop too.
    const drop = codeOnly(
      teardownFor('didDisconnectPeripheral peripheral:'), /streaming = false/)
    expect(drop, 'a transient drop must not cancel the resume').not.toMatch(/streamWanted/)
  })

  it('a resume that fails says why, instead of leaving a dark mirror', () => {
    // The panel would otherwise just read "Not streaming." about a mirror the user
    // left running, and the stop this app sent would look like the board's fault.
    expect(resume()).toMatch(/lastError = /)
  })
})

/**
 * c10 — a mirror survives the link dropping, and does NOT come back in a pocket.
 *
 * c9 stopped the stream when the app left the foreground and gave it back on the
 * way in. It left the other half open, and flagged it: the link itself can drop
 * and return under a sheet that is still on screen. The firmware closes the RPC
 * session on disconnect, taking the stream with it; the panel's `.task` has
 * already run once; `finishLink()` proved the new link and refreshed the status
 * card. Nothing put the mirror back. So a board that reconnected perfectly well —
 * a few steps out of range and back, which is the normal life of a Flipper in a
 * pocket — showed an empty view forever, with no text suggesting the one recovery
 * that works: close the sheet and reopen it.
 *
 * The trap in fixing it is that the obvious fix reopens c9's hole through a
 * different door. A phone can be backgrounded AND lose the link (that is what a
 * pocket is), so a resume hung on the link alone restarts the kilobyte-per-redraw
 * flood into an app nobody is looking at. Hence two independent facts: does a view
 * want frames, and can anyone see them.
 */
describe('a mirror comes back when the link does — but not into a pocket', () => {
  const resume = () => swiftBody(gateway, 'func resumeScreenStreamIfWanted(')
  const link = () => swiftBody(gateway, 'private func finishLink() {')
  const gwInit = () => swiftBody(gateway, 'override private init() {')

  it('a proved link puts a wanted mirror back', () => {
    // The whole defect in one line: before this, `finishLink` refreshed the status
    // card and stopped, and the view that wanted frames was never told.
    expect(codeOnly(link(), /resumeScreenStreamIfWanted/))
      .toMatch(/resumeScreenStreamIfWanted\(\.relinked\)/)
  })

  it('the resume happens after the link is claimed, or its own guard blocks it', () => {
    // `resumeScreenStreamIfWanted` guards on `linked`. Called before the
    // MainActor.run that sets it, it would return silently every time — a wire that
    // reads as connected and does nothing at all.
    const body = codeOnly(link(), /linked = true/)
    expect(body.indexOf('linked = true'))
      .toBeLessThan(body.indexOf('resumeScreenStreamIfWanted'))
  })

  it('the picture comes back before the status card, not after it', () => {
    // A status read is three RPCs and can spend the better part of a minute on a
    // slow board. The mirror is the thing being looked at, so it goes first; and
    // when no sheet is open the guard makes this free.
    const body = codeOnly(link(), /refresh\(\)/)
    expect(body.indexOf('resumeScreenStreamIfWanted')).toBeLessThan(body.indexOf('refresh()'))
  })

  it('a re-link into a backgrounded app does NOT restart the stream', () => {
    // The regression this fix could have been. A pocketed phone drops and regains
    // the link constantly; without the `foreground` arm each cycle would restart a
    // mirror nobody can see, on the board's own battery, sharing the link with the
    // relay poll that IS the feature while backgrounded.
    const guard = codeOnly(resume(), /guard/)
    expect(guard).toMatch(/guard[^\n]*\bforeground\b/)
  })

  it('both phase observers maintain the flag the guard reads', () => {
    // A flag only one side sets is worse than no flag: leave out the foreground
    // half and the mirror never comes back at all.
    expect(observerFor(gwInit(), 'UIApplication.didEnterBackgroundNotification'))
      .toMatch(/foreground = false/)
    expect(observerFor(gwInit(), 'UIApplication.willEnterForegroundNotification'))
      .toMatch(/foreground = true/)
  })

  it('the flag is set synchronously, ahead of the hop that does the async work', () => {
    // `queue: nil` means the observer block runs on the thread UIKit posts from,
    // while the Task inside it is a hop later. Setting the flag inside that Task
    // leaves a window where a re-link can start a stream into a phone that has
    // already gone dark — the precise thing being prevented.
    const block = codeOnly(observerFor(gwInit(), 'UIApplication.didEnterBackgroundNotification'),
                           /foreground = false/)
    expect(block.indexOf('foreground = false')).toBeLessThan(block.indexOf('Task {'))
  })

  it('the app counts as visible until told otherwise', () => {
    // A `false` default would be a mirror that refuses to start until the app has
    // been backgrounded once. Safe because `streamWanted` is not persisted: a
    // process launched straight into the background is owed nothing.
    expect(codeOnly(gateway, /var foreground/)).toMatch(/var foreground = true/)
  })

  it('the flag is not read back off UIApplication during the transition', () => {
    // Every read here happens *during* a phase change, which is the one moment
    // `applicationState` is ambiguous: at willEnterForeground the app has not become
    // active yet, so a guard written against `.active` would block the very resume
    // that notification exists to trigger.
    expect(codeOnly(resume())).not.toMatch(/applicationState/)
  })

  it('a failed resume names the cause it actually had', () => {
    // Two callers, two different true sentences. Telling someone the app was in the
    // background when their Flipper walked out of range sends them to fix the wrong
    // thing — the failure mode c5, c6 and c8 each landed on from a different angle.
    const cause = swiftBody(gateway, 'enum ResumeCause {')
    expect(cause).toMatch(/case returnedToForeground/)
    expect(cause).toMatch(/case relinked/)
    expect(cause).toMatch(/background/)
    expect(cause).toMatch(/reconnected/)
    // And the sentence is taken FROM the cause, not hardcoded beside it: a resume
    // that always says "background" is the wrong-cause bug with extra ceremony.
    expect(codeOnly(resume(), /lastError/)).toMatch(/lastError = "\\\(cause\.failureText\)/)
  })

  it('the two causes do not say the same thing', () => {
    // A parameter threaded through to two identical strings is decoration.
    const texts = Array.from(
      swiftBody(gateway, 'enum ResumeCause {').matchAll(/return "([^"]+)"/g), m => m[1])
    expect(texts.length, 'the cause no longer resolves to per-case text').toBe(2)
    expect(texts[0]).not.toBe(texts[1])
  })
})

/**
 * c11 — a key that goes down comes back up, even when the tap fails halfway.
 *
 * `send(_:hold:)` was a loop over [PRESS, SHORT, RELEASE] that returned on the
 * first failure. So a tap whose MIDDLE event failed abandoned the RELEASE, and the
 * board's input service went on holding that key down — with the user's thumb
 * already off it and nothing on screen saying so.
 *
 * What makes that worse than a stuck menu is where the buttons are pointed. Hazard
 * 16 is the reason input never became a relay action: on a board sitting in the
 * Sub-GHz or IR app, a held OK is a **transmitter still keyed**, not a UI glitch.
 * And the window is the normal case rather than an edge: the likeliest moment for
 * someone to tap is while the screen mirror is running, which is exactly when a
 * kilobyte per redraw has the flow-control credits and the 8-second request
 * timeouts under pressure — `.noRoom` after a 3-second wait, or a plain timeout.
 *
 * So RELEASE stops being the third element of a sequence and becomes the undo of
 * the first, which is a different control-flow shape: it runs whether or not
 * anything before it worked.
 */
describe('a tap always lets go of the key, even when it fails halfway', () => {
  const send = () => swiftBody(gateway, 'func send(')
  const middle = () => swiftBody(send(), 'if failure == nil {')

  it('the release is not inside the success path that could skip it', () => {
    // The defect, stated as the thing that must not be true. A release nested under
    // "did the press work" is a release a failed tap never sends.
    //
    // EVERY such block, not just the first one `middle()` finds: putting the release
    // back under a SECOND `if failure == nil` is this exact bug wearing the fix's
    // clothes, and a check that stops at the first block reads it as correct. That
    // is not hypothetical — the single-block form of this assertion was written
    // first, and a mutant shaped like the paragraph above walked straight past it.
    const body = send()
    let from = 0
    let blocks = 0
    while (true) {
      const at = body.indexOf('if failure == nil {', from)
      if (at === -1) break
      blocks++
      expect(codeOnly(swiftBody(body.slice(at), 'if failure == nil {'), /input\(key/),
        'a press-succeeded block holds the release — a failed tap never sends it')
        .not.toMatch(/\.release/)
      from = at + 1
    }
    expect(blocks, 'no press-succeeded block found at all').toBeGreaterThan(0)
    expect(codeOnly(send(), /\.release/)).toMatch(/input\(key, \.release\)/)
  })

  it('the middle event IS skipped when the press failed', () => {
    // The other half, and it is not symmetric: a SHORT with no PRESS behind it is
    // the "key went short without ever being pressed" state the board's own views
    // get stuck in, so this one must stay conditional.
    expect(codeOnly(middle(), /input\(key/)).toMatch(/input\(key, hold \? \.long : \.short\)/)
    expect(codeOnly(send(), /if failure == nil/)).toMatch(/if failure == nil \{/)
  })

  it('a failed press still gets a release — a timeout is not a non-delivery', () => {
    // `.timeout` means the REPLY never came back. The frame may have been delivered
    // and acted on, so the press that "failed" can be the one holding the key down.
    // Ordering carries the proof: the release call sits after the guarded block.
    const body = codeOnly(send(), /input\(key, \.release\)/)
    const guardAt = body.indexOf('if failure == nil')
    const releaseAt = body.indexOf('input(key, .release)')
    const middleAt = body.indexOf('hold ? .long : .short')
    expect(guardAt, 'no press-succeeded guard found').toBeGreaterThan(-1)
    expect(middleAt).toBeGreaterThan(guardAt)
    expect(releaseAt, 'the release runs before the guard, or not at all')
      .toBeGreaterThan(middleAt)
  })

  it('nothing swallows the failure: a broken tap still throws', () => {
    // The panel puts this in front of the user. Made silent, a tap that did nothing
    // looks exactly like a tap the board ignored.
    expect(codeOnly(send(), /throw/)).toMatch(/throw failure/)
  })

  it('a press that fails is recorded, not shrugged off', () => {
    // `try?` here compiles and reads as tolerant, but it leaves `failure` nil: the
    // middle event then fires behind a press that never landed, and the tap reports
    // success to the panel. Both properties above are downstream of this one line,
    // which is why it gets its own pin rather than being assumed.
    const body = codeOnly(send(), /input\(key, \.press\)/)
    expect(body).toMatch(/input\(key, \.press\) \} catch \{ failure = error \}/)
    expect(body, 'a swallowed error leaves `failure` nil and the tap silent')
      .not.toMatch(/try\?/)
  })

  it('the error reported is the CAUSE, not the release that failed after it', () => {
    // A release failing too is a symptom of the same dead link, and reporting it
    // instead would name the cleanup as the problem.
    expect(codeOnly(send(), /failure = failure/)).toMatch(/failure = failure \?\? error/)
  })

  it('the three events still go out in one order, one tap at a time', () => {
    // c2's property, re-pinned here because the rewrite touched the same lines:
    // two overlapping taps interleaving on the wire is a chord nobody pressed.
    const body = send()
    expect(body).toMatch(/await previous\?\.value/)
    expect(body).toMatch(/inputChain = mine/)
  })

  it('⚠️ and none of this gives the relay a way to press anything', () => {
    // The fix makes a tap safer, not more reachable. A remote press is a transmit
    // by another name, so the envelope handler still has no path to it.
    const handler = codeOnly(swiftBody(session, 'static func handleFlipperEnvelope('))
    expect(handler).not.toMatch(/\bsend\(/)
    expect(handler).not.toMatch(/press|release|SendInput/i)
  })
})

/**
 * c12 — losing Bluetooth is losing the link, and it used to be a lesser event.
 *
 * There are three ways to lose a Flipper and only one is a disconnect. The board
 * going quiet calls `didDisconnectPeripheral`, which held a careful nine-fact
 * teardown. But Bluetooth ITSELF going away — Control Center, Airplane mode, or
 * `bluetoothd` restarting under `.resetting` — invalidates every peripheral
 * through `centralManagerDidUpdateState`, a different callback, which cleared
 * exactly one of those facts (`linked`). Nothing promises the disconnect event
 * fires as well, and for `.resetting` there is none to wait for.
 *
 * So eight facts survived a Bluetooth toggle, and the worst of them did not
 * recover on its own: `streaming` stuck true over the last `screenFrame` renders
 * as a live mirror, and `resumeScreenStreamIfWanted` is guarded on `!streaming` —
 * so the resume written in c10 to put a mirror back after a link returns was
 * silently blocked forever. Bluetooth back, board relinked, mirror frozen, and the
 * one recovery (close the sheet, reopen) never suggested. c10's defect, reopened
 * through a door c10 did not enumerate.
 */
describe('losing Bluetooth is losing the link, not a lesser event', () => {
  const lost = () => swiftBody(gateway, 'private func linkLost()')
  const resume = () => swiftBody(gateway, 'func resumeScreenStreamIfWanted(')
  // `linkLost()` is nine assignments under the paragraph explaining what each one
  // did when it survived a Bluetooth toggle, so the ratio check in `codeOnly` — a
  // whole-FILE heuristic — trips on it. Name a token that must survive instead.
  const lostCode = (mustKeep: RegExp) => codeOnly(lost(), mustKeep)
  // `/\S/` rather than the default ratio check: these arms are two lines under a
  // comment, and `codeOnly`'s length heuristic is a whole-FILE ratio that fails on
  // correct code at this scale. "Something survived the strip" is the real question.
  const armCode = (body: string) => codeOnly(body, /\S/)

  it('every state below poweredOn tears the link down', () => {
    // Structural, not a list of three: add `case .resetting:` tomorrow and forget
    // the teardown, and this reds. That is the mistake being fixed, one state over.
    const arms = stateArms()
    expect(arms.length, 'the switch lost its arms').toBeGreaterThan(2)
    for (const arm of arms) {
      if (arm.label.includes('.poweredOn')) continue
      expect(armCode(arm.body), `${arm.label} must tear the link down`)
        .toMatch(/linkLost\(\)/)
    }
  })

  it('poweredOn is the wake-up, and it does NOT tear anything down', () => {
    const on = stateArms().find(a => a.label.includes('.poweredOn'))
    expect(on, 'no .poweredOn arm at all').toBeDefined()
    const code = armCode(on!.body)
    expect(code).toMatch(/connectIfPossible\(\)/)
    // A teardown here would run on the way IN, against a link about to be rebuilt.
    expect(code, 'poweredOn is a recovery, not a loss').not.toMatch(/linkLost/)
  })

  it('the frozen mirror is the reason: the flag and the picture both go', () => {
    // The two together are the bug. `streaming` alone leaves the sheet rendering a
    // stale frame; `screenFrame` alone leaves the empty state claiming to be live.
    const body = lostCode(/streaming/)
    expect(body).toMatch(/streaming = false/)
    expect(body).toMatch(/screenFrame = nil/)
  })

  it('and so the c10 resume is reachable again after Bluetooth returns', () => {
    // The link between the two cycles, asserted rather than assumed: the resume is
    // guarded on `!streaming`, so a `streaming` left standing by a Bluetooth toggle
    // disables it permanently. Both halves have to hold for the fix to mean
    // anything — the guard arm, and the teardown that lets it become false.
    expect(codeOnly(resume(), /!streaming/)).toMatch(/!streaming/)
    expect(lostCode(/streaming = false/)).toMatch(/streaming = false/)
  })

  it('requests in flight fail now, instead of waiting out their own timers', () => {
    // A status read waits 25s. With the link already gone, that wait can only end
    // in a timeout — and a timeout is the sentence that blames Bluetooth range for
    // a radio the user switched off deliberately.
    expect(lostCode(/failAllPending/)).toMatch(/failAllPending\(FlipperError\.notLinked\)/)
  })

  it('the write characteristic is dropped, so the NEXT request refuses too', () => {
    // `request()` has no `guard linked` by design and says so: `write()` is the gate.
    // Left standing, `rxChar` hands frames to a peripheral iOS has invalidated,
    // where a failed ATT write is invisible — nothing implements didWriteValueFor.
    expect(lostCode(/rxChar/)).toMatch(/rxChar = nil/)
    expect(codeOnly(swiftBody(gateway, 'private func request('), /enqueueWrite/))
      .not.toMatch(/guard linked/)
  })

  it('a Bluetooth toggle is not the user unlinking the board', () => {
    // `stop()` would clear `wanted` (no reconnect when the radio comes back) and
    // `streamWanted` (no resume for a sheet still on screen). The teardown is the
    // shared part; deciding the user is done is not.
    for (const arm of stateArms()) {
      expect(armCode(arm.body), `${arm.label} must not unlink the board`)
        .not.toMatch(/\bstop\(\)/)
    }
    expect(lostCode(/linked = false/), 'the shared teardown must not cancel a wanted stream')
      .not.toMatch(/streamWanted|wanted = false/)
  })

  it('nothing re-dials at a radio that is off', () => {
    // `connectIfPossible()` is guarded on `.poweredOn`, so a timer would fire into a
    // guard that returns — and every `scheduleReconnect()` DOUBLES the delay on its
    // way past, inflating the backoff for the reconnect that will actually matter.
    for (const arm of stateArms()) {
      if (arm.label.includes('.poweredOn')) continue
      expect(armCode(arm.body), `${arm.label} must not schedule a reconnect`)
        .not.toMatch(/scheduleReconnect/)
    }
    // The shared teardown must not smuggle it in either — a disconnect re-dials, and
    // that one line is deliberately the caller's.
    expect(lostCode(/linked = false/)).not.toMatch(/scheduleReconnect/)
    expect(codeOnly(teardownFor('didDisconnectPeripheral peripheral:'), /scheduleReconnect/))
      .toMatch(/scheduleReconnect\(\)/)
  })

  it('the backoff reset is EARNED by a link that lasted, and the clock is reset with it', () => {
    // Not part of the port — found by mutating it. Deleting the `goodLinkS`
    // condition, and separately deleting `linkedAt = nil`, both survived every pin
    // in this file, and both are the same silent failure: `scheduleReconnect()`
    // doubles 1s → 32s precisely so a board that refuses us on sight is not
    // re-dialled in a hot loop, on two batteries, forever. An unconditional reset
    // spends the ceiling; a `linkedAt` left standing lets the NEXT failure measure
    // its "good link" from a session that ended minutes ago and reach the same
    // place. Neither shows up as an error anywhere.
    const body = lostCode(/reconnectDelay/)
    const reset = swiftBody(body, 'if let since = linkedAt')
    expect(reset, 'the reset must be inside the did-it-last check')
      .toMatch(/reconnectDelay = Self\.reconnectBaseS/)
    expect(body, 'the reset must not also happen unconditionally')
      .toMatch(/Date\(\)\.timeIntervalSince\(since\) >= Self\.goodLinkS/)
    expect(body, 'a stale link clock makes the next quick failure look like a good link')
      .toMatch(/linkedAt = nil/)
    // And the doubling it protects, so the pair above cannot be read as arbitrary.
    expect(codeOnly(swiftBody(gateway, 'private func scheduleReconnect()'), /reconnectDelay/))
      .toMatch(/reconnectDelay = min\(delay \* 2, Self\.reconnectMaxS\)/)
  })

  it('the honest sentence survives the teardown', () => {
    // "Bluetooth is off" is the one thing the user can act on, and the teardown must
    // not overwrite it: `linkLost()` sets no `lastError`, so the arm's own line wins.
    const off = stateArms().find(a => a.label.includes('.poweredOff'))
    expect(off, 'no .poweredOff arm').toBeDefined()
    expect(armCode(off!.body)).toMatch(/lastError = "Bluetooth is off/)
    expect(lostCode(/linked = false/), 'a shared teardown cannot know why the link went')
      .not.toMatch(/lastError = /)
  })
})

/**
 * c13 — the pairing scan outlived every view that wanted it.
 *
 * `.onDisappear` is not "the app left the foreground". c9 established that for the
 * screen stream and gave it two phase observers; the pairing sheet had the same
 * hole and no cover at all, so `stopScan()` — reachable only from Cancel and
 * `.onDisappear` — was simply never called. Lock the phone with the sheet open and
 * the radio stayed armed for as long as the app was backgrounded, which with
 * `bluetooth-central` in Info.plist is bounded by nothing: iOS keeps scanning on a
 * suspended app's behalf, because that is what the mode is for.
 *
 * Two facts make it worse than a leak. A nil-service scan discovers NOTHING while
 * backgrounded — iOS requires a background scan to name its services — so the cost
 * bought nothing, and it was spent next to the BLE link and the relay poll that ARE
 * the feature there (P5's exact flow). And it is the normal case, not an edge: the
 * sheet's own footer sends the user to the Flipper's Settings → Bluetooth, and
 * `subscribeFailureText` sends them there again when a bond fails. Leaving the app
 * with this sheet open is the instruction; auto-lock is thirty seconds.
 *
 * The fix is c9's shape: `scanWanted` (a sheet is asking) split from `scanning`
 * (the radio is on), a suspend that keeps the debt and a stop that settles it.
 */
describe('a pairing scan does not outlive the view that wanted it', () => {
  const initBody = () => swiftBody(gateway, 'override private init()')
  const begin = () => codeOnly(swiftBody(gateway, 'private func beginScanIfPossible()'), /guard/)
  const suspend = () => codeOnly(swiftBody(gateway, 'private func suspendScan()'), /scanning/)
  const armCode = (body: string) => codeOnly(body, /\S/)

  it('backgrounding stops the scan', () => {
    // The hole: the only stop was a view callback, and a sheet on screen when the
    // phone locks never disappears. Asserted on the observer that actually fires.
    const bg = observerFor(initBody(), 'didEnterBackgroundNotification')
    expect(codeOnly(bg, /suspend/), 'nothing stops the scan when the app backgrounds')
      .toMatch(/suspendScan\(\)/)
  })

  it('and it is stopped synchronously, not behind a hop iOS can suspend', () => {
    // Unlike the stream's stop — a frame that has to cross BLE behind flow control,
    // which is why that one holds a background-task assertion — this needs nothing
    // from the board. Left inside the `Task`, a suspension before the hop leaves the
    // radio scanning with nobody able to stop it.
    const bg = codeOnly(observerFor(initBody(), 'didEnterBackgroundNotification'), /suspendScan/)
    const call = bg.indexOf('suspendScan()')
    const task = bg.indexOf('Task {')
    expect(task, 'the background observer no longer has a Task').toBeGreaterThan(-1)
    expect(call, 'suspendScan() must run before the Task hop, not inside it')
      .toBeLessThan(task)
  })

  it('returning to the foreground puts it back', () => {
    const fg = observerFor(initBody(), 'willEnterForegroundNotification')
    expect(codeOnly(fg, /resume/)).toMatch(/resumeScanIfWanted\(\)/)
  })

  it('the debt is a separate fact from the radio, or the resume has nothing to read', () => {
    // `scanning` is set by the radio and cleared by the suspend, so it cannot also
    // mean "a sheet is asking" — that conflation is what left c9's stream unable to
    // come back, one flag over.
    expect(gateway).toMatch(/private var scanWanted = false/)
    expect(codeOnly(swiftBody(gateway, 'func startScan()'), /scanWanted/))
      .toMatch(/scanWanted = true/)
    expect(codeOnly(swiftBody(gateway, 'private func resumeScanIfWanted()'), /guard/))
      .toMatch(/guard scanWanted/)
  })

  it('a suspend keeps the debt; the deliberate stop settles it', () => {
    // The whole difference between the two stops. A suspend that cleared the want
    // would never resume (c9's bug); a Cancel that kept it would restart a scan for
    // a sheet the user closed, on the next foreground.
    expect(suspend(), 'suspending must not decide the user is finished')
      .not.toMatch(/scanWanted/)
    expect(suspend()).toMatch(/scanning = false/)
    expect(codeOnly(swiftBody(gateway, 'func stopScan()'), /scanWanted/))
      .toMatch(/scanWanted = false/)
  })

  it('the radio is asked to stop, not just the flag', () => {
    // A flag flipped without `central.stopScan()` is the same leak with a tidier
    // variable: iOS keeps scanning for a backgrounded app that declared
    // bluetooth-central, so only the call ends it.
    expect(suspend()).toMatch(/central\?\.stopScan\(\)/)
  })

  it('no scan is ever ARMED in the background either', () => {
    // The choke point, so a future caller cannot reintroduce one. Without service
    // UUIDs iOS discovers nothing while backgrounded, so such a scan cannot succeed
    // — it can only spend the radio beside the link and the relay poll.
    expect(begin(), 'beginScanIfPossible must refuse while backgrounded')
      .toMatch(/guard foreground/)
    // And the nil-service scan is the reason the guard is required, not optional.
    expect(codeOnly(swiftBody(gateway, 'private func beginScanIfPossible()'), /scanForPeripherals/))
      .toMatch(/scanForPeripherals\(withServices: nil/)
  })

  it('a Bluetooth toggle can still recover a scan', () => {
    // The hole the split would have opened if the wake-up kept reading `scanning`:
    // Bluetooth off in the foreground, background, foreground, Bluetooth on. The
    // suspend has cleared `scanning`, so the arm would find nothing to resume while
    // the sheet is still on screen asking.
    const on = stateArms().find(a => a.label.includes('.poweredOn'))
    expect(on, 'no .poweredOn arm').toBeDefined()
    const code = armCode(on!.body)
    expect(code, 'the wake-up must read the want, not the radio flag')
      .toMatch(/if scanWanted/)
    expect(code).toMatch(/beginScanIfPossible\(\)/)
  })

  it('and the sheet still has its own stop, for the case that DOES disappear', () => {
    // The phase observers are the cover, not the replacement: a dismissed sheet
    // should stop the radio there and then rather than at the next backgrounding.
    expect(codeOnly(panel, /onDisappear/)).toMatch(/onDisappear \{ flipper\.stopScan\(\) \}/)
  })
})

/**
 * 🐬📶 A link the user made once is there the next time they ask.
 *
 * This feature's whole point is a question asked from somewhere else — a web chat,
 * the board in a pocket, the phone face-down on a table. So the interesting process
 * is one the user did not start: iOS relaunching a suspended app for a BGAppRefresh
 * wake, a swipe-away, a reboot. Nothing on any of those paths dialled the board.
 * `start()` was reachable from exactly two gestures — `pair()` and the panel's
 * Reconnect button — so the link lasted as long as the process the user had tapped
 * in, and no longer.
 *
 * After that the phone stopped declaring `flipper_ble`, honestly (it really had no
 * link), and the agent answered "no Flipper Zero is reachable on this account …
 * link it over Bluetooth to the tiny app on a phone" — about a bond iOS and the
 * board both still held. Opening the app did not fix it either: the cure was three
 * levels into a panel, beside copy that blamed the board's range for a dial the
 * phone had never attempted.
 *
 * It also left `willRestoreState` unreachable. State restoration is a THREE-part
 * contract: the restore identifier, the delegate method, and a manager re-created
 * early in the launch CoreBluetooth is restoring INTO. Written without the third,
 * the first two read as finished work and never run once.
 */
describe('a paired board is dialled by the launch, not by a tap', () => {
  const initBody = () => swiftBody(tinyApp, '    init() {')
  const startBody = () => codeOnly(swiftBody(gateway, 'func start()'), /wanted = true/)

  it('the launch path dials a board this phone already owns', () => {
    expect(codeOnly(initBody(), /FlipperGateway/), 'nothing on the launch path starts the gateway')
      .toMatch(/FlipperGateway\.shared\.start\(\)/)
  })

  it('from init(), because the launch that matters most never activates a scene', () => {
    // A BGAppRefresh cold wake runs `init()` and the task handler, and no view ever
    // appears — which is why `Background.register()` lives there too. In the
    // `.active` arm beside the necklace's start this would cover every launch EXCEPT
    // the one where the user is in a browser waiting for the board to answer.
    const call = tinyApp.indexOf('FlipperGateway.shared.start()')
    const scene = tinyApp.indexOf('var body: some Scene')
    expect(call, 'FlipperGateway.shared.start() is not called at all').toBeGreaterThan(-1)
    expect(scene, 'TinyApp has no scene body any more — re-read this test').toBeGreaterThan(-1)
    expect(call, 'the dial must run before the scene exists, not from a scenePhase arm')
      .toBeLessThan(scene)
  })

  it('and not from inside #if DEBUG, where a shipped build would never reach it', () => {
    // The end of `init()` is one line below a debug-only harness block. Inside it,
    // every simulator run would restore the link and no user ever would.
    const body = initBody()
    const call = body.indexOf('FlipperGateway.shared.start()')
    const dbg = body.indexOf('#if DEBUG')
    expect(dbg, 'the DEBUG harness block moved — re-read this test').toBeGreaterThan(-1)
    const end = body.indexOf('#endif', dbg)
    expect(end, '#if DEBUG never closes').toBeGreaterThan(dbg)
    expect(call > end || call < dbg, 'the launch dial is compiled out of Release').toBe(true)
  })

  it('the dial is what creates the manager iOS hands the restored board back to', () => {
    // The third term of the restoration contract. Both other terms were already
    // written; this is the one that makes them run.
    expect(startBody(), 'start() no longer creates the central manager')
      .toMatch(/CBCentralManager\(/)
    expect(startBody(), 'the manager is created without a restore identifier')
      .toMatch(/CBCentralManagerOptionRestoreIdentifierKey/)
    expect(codeOnly(gateway, /willRestoreState/), 'nothing receives what the identifier preserves')
      .toMatch(/func centralManager\(_ central: CBCentralManager, willRestoreState/)
  })

  it('a phone with no Flipper is still never asked for Bluetooth', () => {
    // What makes a launch-time call safe, and it is a fact in a DIFFERENT file from
    // the caller: constructing CBCentralManager is what raises the permission
    // prompt, so the refusal has to come first. Reversed, every user of this app
    // gets a Bluetooth prompt on launch because of a board they do not own.
    const s = startBody()
    expect(s, 'start() must refuse before it can ask for Bluetooth')
      .toMatch(/guard unit != nil else \{ return \}/)
    expect(s.indexOf('guard unit != nil'), 'the refusal must precede the manager')
      .toBeLessThan(s.indexOf('CBCentralManager('))
  })

  it('and the dial does not wait out a delay an earlier session grew', () => {
    // The comment above these lines is what this port widened: a start is now EITHER
    // a tap or a relaunch, and the claim is that both jump the backoff queue. It is
    // worth pinning because the relaunch case is the one that cannot be seen — a
    // BGAppRefresh wake gets a bounded window, and a launch that inherited the
    // doubled delay of the session iOS had killed would spend the whole of it
    // sleeping, which reads from the web chat exactly like the bug this port fixes.
    const s = startBody()
    expect(s, 'a backoff timer from the last session is left sleeping behind the dial')
      .toMatch(/reconnectTask\?\.cancel\(\)/)
    expect(s, 'the cancelled task is still held by the field that names it')
      .toMatch(/reconnectTask = nil/)
    expect(s, 'the start inherits the penalty an earlier session grew')
      .toMatch(/reconnectDelay = Self\.reconnectBaseS/)
    expect(s.indexOf('reconnectDelay = Self.reconnectBaseS'), 'the reset has to land before the dial it applies to')
      .toBeLessThan(s.indexOf('CBCentralManager('))
    // And the doubling it is resetting really is a doubling, in the other file's
    // other function — a base-delay reset means nothing if nothing ever grows.
    expect(codeOnly(swiftBody(gateway, 'private func scheduleReconnect()'), /reconnectDelay/))
      .toMatch(/reconnectDelay = min\(delay \* 2, Self\.reconnectMaxS\)/)
  })

  it('the panel keeps its own Reconnect, for the link that drops mid-session', () => {
    // The launch dial is the cover, not the replacement: a drop while the app is
    // open is handled by the backoff, and the button is how a user overrides a
    // delay that has grown to 32s rather than waiting it out.
    // Matched on the call, not the copy — the label is a product decision and this
    // file has been red for a wording change before.
    expect(codeOnly(panel, /Reconnect/))
      .toMatch(/Button\("[^"]+"\) \{ flipper\.start\(\) \}/)
  })
})

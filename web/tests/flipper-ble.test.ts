// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FLIPPER_CAP, FLIPPER_BLE_CAP, pickFlipperHost, parseCaps, type FlipperHost,
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
    const at = gateway.indexOf('didDiscoverCharacteristicsFor')
    expect(at).toBeGreaterThan(0)
    const disc = gateway.slice(at, at + 1600)
    // TX → notify, RX → stashed for writing.
    expect(disc).toMatch(/case flipperTxUUID:[\s\S]{0,320}?setNotifyValue\(true/)
    expect(disc).toMatch(/case flipperRxUUID:[\s\S]{0,120}?rxChar = ch/)
    // …and the only writer uses that stashed handle, never the notify one.
    const writer = swiftBody(gateway, 'private func writeFrame(')
    expect(writer).toContain('rxChar')
    expect(writer).toContain('writeValue(')
    expect(Array.from(gateway.matchAll(/writeValue\(/g)).length, 'one write path only').toBe(1)
    // Inbound frames are deframed from TX only.
    expect(gateway).toMatch(/case flipperTxUUID:[\s\S]{0,80}?consume\(value\)/)
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
    const at = session.indexOf('static func handleFlipperEnvelope')
    const body = session.slice(at, at + 4500)
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
    const at = gateway.indexOf('func startScreenStream')
    expect(at).toBeGreaterThan(0)
    const body = gateway.slice(at, at + 1400)
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
      const body = swiftBody(gateway, sig)
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
    const at = gateway.indexOf('func send(')
    expect(at).toBeGreaterThan(0)
    const body = gateway.slice(at, at + 900)
    expect(body).toMatch(/\[\.press, \.long, \.release\]/)
    expect(body).toMatch(/\[\.press, \.short, \.release\]/)
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
    expect(session).not.toMatch(/FlipperGateway\.shared\.(send|startScreenStream|stopScreenStream)/)
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

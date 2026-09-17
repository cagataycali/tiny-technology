// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as flipperTools from '../lib/chat/tools/flipper'
import {
  FLIPPER_CAP, FLIPPER_BLE_CAP, pickFlipperHost, parseCaps, type FlipperHost,
  listenBudget, filesWait, statusWait, alertWait, makeFlipperStatusTool,
  FILES_WAIT_S, STATUS_WAIT_S, ALERT_WAIT_S, BLE_ROUND_TRIP_S, MAX_LISTEN_S, bleCanDo,
} from '../lib/chat/tools/flipper'
import { DEVICE_LABELS, capabilitySummary } from '../lib/chat/prompt'
import { deadlineFor, exceedsServerBudget } from '../lib/deadlines'
import { buildVoiceTools } from '../lib/voice/tools'

/**
 * 🐬📶 The Flipper over Bluetooth: the phone holds the link when no cable does.
 *
 * Everything here is a guard, not a demo, and each one pins a failure that is
 * SILENT — which is why they are worth the file. The BLE path has no test
 * hardware in CI and never will, so what can be checked is the contract:
 *
 *   1. the wire constants (UUIDs, protobuf field numbers) match the measured
 *      values in docs/flipper-ble-ios-design.md. A wrong field number does not
 *      error — protobuf skips unknown tags, so the app just goes quiet.
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

// ⚠️ `docs/flipper-ble-ios-design.md` is an upstream working note (the log of
// what was measured off a live board), not part of this repo's published docs —
// root-level docs/*.md are never mirrored here. When it is absent the gateway
// is the single record and the cross-checks below are skipped, which is worth
// stating plainly: a UUID or field number changed in the gateway ALONE still
// passes here. Drop the note in at that path and every cross-check re-arms.
const HAS_DESIGN = existsSync(join(ROOT, 'docs/flipper-ble-ios-design.md'))
const design = HAS_DESIGN ? read('docs/flipper-ble-ios-design.md') : ''
const gateway = read('ios/Tiny/Sources/FlipperGateway.swift')
const session = read('ios/Tiny/Sources/Session.swift')
const panel = read('ios/Tiny/Sources/FlipperBlePanel.swift')
const iosPanels = read('ios/Tiny/Sources/Panels.swift')
const tinyApp = read('ios/Tiny/Sources/TinyApp.swift')
const androidPanels = read('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')
const backend = read('lib/chat/tools/flipper.ts')

/**
 * ⚠️ THE REGISTRY, derived — never a list of names typed into a test.
 *
 * Two guards below (the voice bridge's budget, and declared-implies-mounted) each
 * held a hand-written `['makeFlipperStatusTool', …]`, and c22 is what those cost:
 * `flipper_find` was written, exported, and wired into all four rosters while both
 * lists still said three tools and both tests still passed. The module is the only
 * thing that knows what exists, so ask it — then a flipper tool added tomorrow is
 * required on every rail today, with no edit here.
 */
const FLIPPER_FACTORIES = Object.keys(flipperTools).filter((k) => /^makeFlipper\w+Tool$/.test(k))
const FLIPPER_TOOLS = FLIPPER_FACTORIES.map((f) => (flipperTools as any)[f](null).toolSpec.name as string)

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
 * Every function signature in the gateway, sliced from `func` to its own brace.
 *
 * For the guards that have to hold for EVERY function taking some parameter — the
 * alternative is a list of names typed into this file, and a list typed into a
 * guard is the thing that drifts (measured twice in this suite: c23's hand-written
 * file roster, then c24's hand-written roster of three functions).
 */
const gatewaySignatures = (): string[] => {
  const src = codeOnly(gateway, /func outage\(/)
  const out: string[] = []
  // `Array.from`, not a bare `for…of` over the iterator: `npm test` strips types, so
  // a TS2802 this file adds is a red only ever seen in someone else's build.
  for (const m of Array.from(src.matchAll(/\bfunc\s+\w+/g))) {
    const brace = src.indexOf('{', m.index as number)
    if (brace > -1) out.push(src.slice(m.index as number, brace))
  }
  expect(out.length, 'no function signatures found — this slicer is stale').toBeGreaterThan(20)
  return out
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
  id: `dev-${over.transport}`, name: over.transport === 'ble' ? 'owner-phone' : 'mac-mini',
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

  it.each(uuids)('%s is %s in both the gateway and the design doc', (name, uuid) => {
    expect(gateway).toContain(uuid)
    expect(gateway).toMatch(new RegExp(`${name}\\b`))
    // The doc is the record of the measurement. If they disagree, one of them is
    // a guess, and the test cannot tell which — so it fails.
    if (HAS_DESIGN) expect(design).toContain(uuid)
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
    expect([...gateway.matchAll(/writeValue\(/g)].length, 'one write path only').toBe(1)
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
    // Braces, not `slice(at, at + 900)`: that window shrank as the function grew
    // and this cycle's doc comment alone would have pushed `request(` out of it —
    // the same bomb c6 defused twice, which reds for nothing in one direction and
    // goes green covering nothing in the other.
    const body = swiftBody(gateway, 'func read(')
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
    const body = swiftBody(gateway, 'func read(')
    expect(body).toContain('storageStatReq')
    expect(body.indexOf('storageStatReq')).toBeLessThan(body.indexOf('storageReadReq'))
    // The relay caps a reply at 7000 chars; the gateway must refuse under it.
    const cap = gateway.match(/maxReadBytes\s*=\s*(\d+)/)
    expect(cap).toBeTruthy()
    expect(Number(cap![1])).toBeLessThan(7000)
  })
})

/**
 * A refusal is addressed to somebody, and only one of the two readers is a relay.
 *
 * `maxReadBytes` is one number for both callers ON PURPOSE — a private copy per
 * surface is the drift that made one file read two ways (trap 21). The sentence
 * is the opposite: the agent can be told to ask for a smaller file, and the person
 * holding the phone cannot ask anyone anything. Measured on the user's own board
 * over the cable: 6 of the 26 files in the non-sensitive folders are over the
 * ceiling — /ext/Manifest is 78745 bytes in the first folder the browser opens,
 * and 5 of 6 files in /ext/apps/Infrared are 4.6–90 KB. The panel is the ordinary
 * case for this refusal, not the corner, and it is the ONLY live caller of read():
 * no backend tool emits an action of 'read'.
 */
describe('an oversized file is refused in the words of whoever asked', () => {
  const tooBig = swiftBody(gateway, 'static func tooBig(')

  it('the person holding the phone is told about neither a relay nor an agent', () => {
    // Comments stripped first: the arm explains IN A COMMENT that it deliberately
    // names no relay, and a raw match reads that confession as the crime — the
    // same trap c16 hit one helper over.
    const arm = codeOnly(tooBig.slice(tooBig.indexOf('case .panelSheet')), /Bluetooth/)
    expect(arm, 'the panel arm must exist').toContain('Bluetooth')
    expect(arm).not.toMatch(/relay/i)
    // "Ask for a smaller file" is an instruction to a caller that can re-ask. A
    // person who just tapped a row is not that caller.
    expect(arm).not.toMatch(/Ask for a smaller/)
    expect(arm).toMatch(/Open it on the Flipper/)
  })

  it('the agent still gets the sentence that was written for it', () => {
    const arm = tooBig.slice(tooBig.indexOf('case .relayReply'),
                             tooBig.indexOf('case .panelSheet'))
    expect(arm).toMatch(/carry back over the relay/)
    expect(arm).toMatch(/Ask for a smaller file/)
  })

  it('both sentences name the size AND the limit', () => {
    // Trap 21's rule: a limit disclosed without its numbers is a limit the reader
    // cannot act on. Two occurrences — one per arm.
    expect((tooBig.match(/\\\(size\) bytes/g) ?? []).length).toBe(2)
    expect((tooBig.match(/limit \\\(limit\)/g) ?? []).length).toBe(2)
  })

  it('read() takes its audience with no default, so nobody inherits the wrong one', () => {
    const sig = gateway.slice(gateway.indexOf('func read('), gateway.indexOf('func read(') + 200)
    expect(sig).toMatch(/for audience: ReadAudience\)/)
    expect(sig, 'a default is how the wrong reader got the sentence').not.toMatch(/audience: ReadAudience =/)
  })

  it('read() asks the one helper for the sentence instead of writing it inline', () => {
    // Its own pin, not an extra assertion on the one above: a mutant that
    // reinstates inline prose has nothing to do with defaults, and a kill named
    // for the wrong property is a verdict on neither.
    const body = swiftBody(gateway, 'func read(')
    expect(body).toMatch(/Self\.tooBig\(/)
    expect(body, 'the prose belongs to tooBig, which knows who is reading')
      .not.toMatch(/carry back over the relay|pull over Bluetooth/)
  })

  it('both live callers state which reader they are', () => {
    expect(codeOnly(session, /fg\.read\(/)).toMatch(/fg\.read\(path, for: \.relayReply\)/)
    expect(codeOnly(panel, /flipper\.read\(/)).toMatch(/flipper\.read\(full, for: \.panelSheet\)/)
  })

  it('the sheet refuses from the size already on screen, before it uses the link', () => {
    const open = swiftBody(panel, 'private func open(')
    const guardAt = open.indexOf('FlipperGateway.maxReadBytes')
    expect(guardAt, 'the sheet must check the size it already rendered').toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(open.indexOf('flipper.read('))
    // It compares the LISTING's size (e.size) — the number in the row that was
    // tapped — so the answer costs no round trip on a slow link.
    //
    // ⚠️ Anchored to the WHOLE condition, not just "the comparison appears
    // somewhere": `if false, e.size > …` contains every token this used to look
    // for and disables the guard completely. A mutant survived on exactly that,
    // which is this loop's recurring shape — a pin named for a guarantee that
    // asserts a fraction of it.
    expect(open).toMatch(/^\s*if e\.size > UInt64\(FlipperGateway\.maxReadBytes\) \{$/m)
    expect(open).toMatch(/for: \.panelSheet/)
  })

  it('the sheet keeps no private ceiling of its own', () => {
    // One number, two sentences. A literal here is how the surfaces drift — and
    // it must be checked by reading what every `limit:` IS, not by banning the
    // two spellings a private copy happened to take: `limit: 6000` matched
    // neither `= 6000` nor `UInt64(6000)` and survived.
    const limits = Array.from(codeOnly(panel, /limit:/).matchAll(/limit:\s*([^,)\n]+)/g))
    expect(limits.length, 'no ceiling is passed anywhere — is this reading the file?').toBe(1)
    for (const m of limits) expect(m[1].trim()).toBe('FlipperGateway.maxReadBytes')
  })
})

describe('{type:"flipper"} is handled in BOTH iOS relay loops', () => {
  // The relay poll claims each envelope it returns (compare-and-swap on
  // delivered 0→1), so an envelope a loop does not handle is CONSUMED and gone,
  // not deferred to the other loop. {type:"record"} is duplicated for exactly
  // this reason and this must be too.
  it('the foreground poll and backgroundBeat both dispatch it', () => {
    const hits = [...session.matchAll(/payload\["type"\] as\? String == "flipper"/g)]
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
    const flips = [...session.matchAll(/== "flipper"/g)].map(m => m.index!)
    const invokes = [...session.matchAll(/== "invoke"/g)].map(m => m.index!)
    expect(invokes.length).toBe(2)
    for (const [i, inv] of invokes.entries()) expect(flips[i]).toBeLessThan(inv)
  })

  it('one shared handler, so the two loops cannot drift apart', () => {
    expect(session).toContain('static func handleFlipperEnvelope')
    expect([...session.matchAll(/handleFlipperEnvelope\(payload\)/g)].length).toBe(2)
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
  })

  it('a hex preview admits it is a preview, with both numbers', () => {
    // The window is the cable's, so one .sub reads the same either way…
    expect(gateway).toMatch(/hexPreviewBytes = 1024/)
    const hp = swiftBody(gateway, 'static func hexPreview(')
    expect(hp).toContain('hexPreviewBytes')
    // …including the marker, which is the half the port lost.
    expect(hp).toContain('…')
    expect(hp).toMatch(/first \\\(window\) of \\\(data\.count\) bytes/)
    // Empty when the whole file fits: then the hex IS the file, and a preview
    // note about a complete read would be its own small lie.
    expect(hp).toMatch(/window < data\.count/)
  })

  it('BOTH surfaces that render a file route through that one helper', () => {
    // The bug this replaced: the relay reply named both numbers and the panel's
    // Files sheet cut a bare prefix(512) and said nothing, so the same .fap read
    // as "the first 1024 of 2048 bytes" through the agent and as a
    // complete-looking file in the user's own hand. Neither surface is allowed
    // its own window or its own silence.
    for (const [name, src] of [['the relay reply', session], ['the Files sheet', panel]] as const) {
      expect(src, `${name} must not hex a file itself`).not.toMatch(/String\(format: "%02x"/)
      expect(src, `${name} must ask for the shared preview`).toMatch(/FlipperGateway\.hexPreview\(data\)/)
    }
    // Both render the admission, not just the hex: keeping the call and dropping
    // `.cut` restores the old silence with the helper still in the picture.
    expect(codeOnly(panel, /hexPreview/)).toMatch(/\.hex \+ [a-z]+\.cut/)
    expect(codeOnly(session, /hexPreview/)).toMatch(/\\\([a-z]+\.hex\)\\\([a-z]+\.cut\)/)
  })

  it('the sheet stops cutting its own window', () => {
    // 512 was never a constant anywhere — it was this view's private opinion
    // about how much of a file is enough, half of what every other surface uses.
    // Comments stripped first: the line explaining the old prefix(512) is still
    // in the file, and a raw match would read the confession as the crime.
    expect(codeOnly(panel, /hexPreview/)).not.toMatch(/\.prefix\(\d+\)/)
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
    expect(picked?.name).toBe('owner-phone')
  })

  it('a capture never routes to the phone, even when the phone is the only link', () => {
    const picked = pickFlipperHost(
      { cable: null, ble: host({ transport: 'ble' }) },
      { overBle: false },
    )
    expect(picked).toBeNull()   // → the caller explains why, in words
  })

  it('a capture with a sleeping laptop names the laptop, not the phone', () => {
    // The useful sentence is "wake the mac mini", and it is only reachable if an
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

    // ⚠️ BOUNDED at the next factory. This slice ran to EOF, which was harmless
    // only while flipper_files was the last tool in the file — the day one was
    // appended after it (flipper_find, c22) the slice quietly covered two tools,
    // and `action: 'files'` would have passed on a flipper_files that sent nothing.
    const filesAt = backend.indexOf('makeFlipperFilesTool')
    const findAt = backend.indexOf('makeFlipperFindTool', filesAt)
    expect(findAt, 'makeFlipperFindTool is gone — the slice would run to EOF').toBeGreaterThan(filesAt)
    const files = backend.slice(filesAt, findAt)
    expect(files).toMatch(/action: 'files'/)
    const find = backend.slice(findAt)
    expect(find, 'a beep is one action and it is not a listing').toMatch(/action: 'alert'/)
    expect(find).not.toMatch(/action: '(status|files)'/)
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
      // The doc is the record of the measurement; a disagreement means one of
      // them is a guess and the test cannot tell which.
      if (HAS_DESIGN) expect(design, `the design doc must record field ${num}`)
        .toMatch(new RegExp(`\\b${num}\\b`))
    }
    if (HAS_DESIGN) expect(design).toMatch(/page-major|u8g2/i)
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
 * `refresh()` attempts all three reads independently and keeps the previous `info`
 * when they fail, deliberately: a board that answers two of three is worth
 * showing, and a blank panel is worse than a stale line. But total failure then
 * looked identical to success, and both consumers presented the kept reading as
 * current — the panel by stamping `Date()` after the call regardless of its
 * outcome, the relay reply by carrying no age at all. The failure that matters is
 * not a dead link (that one is obvious) but a live link to a board that has
 * stopped answering RPC, which is what an app opening on its screen does: every
 * read times out and a flat Flipper reports "🔋 100% charged".
 */
describe('a status reading never claims to be newer than it is', () => {
  const refresh = swiftBody(gateway, 'func refresh(within budget:')
  const statusLine = swiftBody(gateway, 'func statusLine(')

  it('refresh reports whether it learned anything, and dates only what it learned', () => {
    // The return value IS the fix: without it every caller had to assume success.
    expect(gateway).toMatch(/@discardableResult\s*\n\s*func refresh\(within budget: TimeInterval = \.infinity\) async -> Reading/)
    // `\w+` for the locals, on purpose: a pin bound to this cycle's choice of
    // variable name is a pin on nothing (hazard 37(g)). The payload is open here
    // and pinned where it belongs — c33 gave `.learned` what is missing and why, c34
    // gave both arms how each read ended, and this assertion is only about which
    // outcome a learned reading gets.
    expect(refresh).toMatch(/return \w+ \? \.learned\([^)]*\) : \.silent\([^)]*\)/)
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
    const bound = panelRefresh.match(/let (\w+) = await flipper\.refresh\(\)/)
    expect(bound, 'the panel throws the outcome away again').not.toBeNull()
    expect(panelRefresh).toContain(`if !${bound![1]}.didLearn {`)
    expect(panelRefresh).toMatch(/note = flipper\.info == nil/)
    expect(panelRefresh).toMatch(/Couldn't read the Flipper/)
  })

  it('the relay reply carries the age when the reading is a memory', () => {
    // Three branches, and the middle one is the new one: linked, refresh failed,
    // an old reading in hand.
    const bound = statusLine.match(/let (\w+) = await refresh\(within: Self\.relayStatusBudgetS\)/)
    expect(bound, 'the budgeted read no longer keeps its outcome').not.toBeNull()
    expect(statusLine).toContain(`if ${bound![1]}.didLearn, let i = info`)
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
    const bounds = [...age.matchAll(/s < (\d+)/g)].map(m => Number(m[1]))
    expect(bounds.length).toBeGreaterThanOrEqual(3)
    expect([...bounds]).toEqual([...bounds].sort((a, b) => a - b))
  })

  it('the status read fits inside the wait the backend actually gives it', () => {
    const budget = Number(gateway.match(/relayStatusBudgetS: TimeInterval = (\d+)/)![1])
    const wait = Number(backend.match(/export const STATUS_WAIT_S = (\d+)/)![1])
    // The backend names its own number now, and the tool uses that name — a 45
    // edited to 20 there must not leave this pin passing against a literal. The
    // call site reaches it through `statusWait`, which clamps it to a scheduled
    // job's deadline; the ceiling itself is still what the wait is derived from.
    expect(backend).toMatch(/^\s+statusWait\(budgetS\),$/m)
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

/**
 * ⚠️ A cause a surface INVENTED reads exactly like one the board reported.
 *
 * c30 gave `refresh` a `Bool` so its callers could stop presenting a memory as
 * current, and stopped there — the three reads stayed wrapped in `try?`, so the
 * board's own account of itself was discarded at the instant it arrived. Both
 * surfaces then filled the gap with the same guess, and the guess names the FLIPPER:
 * "something may be open on its screen", "If an app is open on its screen, close it
 * and ask again", "the link is up but it didn't answer".
 *
 * It is right for one cause out of six. `.status(17)` is what an open app actually
 * looks like, and the board says so in those words itself. The other five are a
 * timeout, a link that dropped mid-request, a stream that lost its place, this
 * phone's radio going away, and a reader who walked out of range — and for the last
 * three the board is the one thing they cannot reach, so the remedy the sentence
 * suggested was the Flipper's own Bluetooth screen, one row above "Forget all paired
 * devices" (hazard 4).
 *
 * That is not a hypothetical rail: it is P5's acceptance run word for word — pair
 * it, unplug the cable, walk away, ask from web chat — and walking away during a
 * 20-second read is the disconnect. `statusLine` also re-stated `linked` from a check
 * made before that read, in the one branch whose cause can BE the link dropping.
 *
 * ⚠️ A silent reading with nothing asked at all cannot be reached at today's
 * constants (the first `allow` runs before any time has passed). It is pinned because
 * those are CONSTANTS: the moment `relayStatusBudgetS` drops near `minRequestS`, a
 * phone that asked nothing would otherwise report the board's silence. The SENTENCE it
 * guards is reachable today, though, by the shorter road c33 opened: a reading that
 * landed partly, with the rest never asked. See the describe below.
 *
 * ⚠️ The cause moved off the READING and onto each READ in c34 — `.silent(Error?)` and
 * `.learned(…, because:)` are gone, because one cause cannot answer for three
 * independent reads and was being handed to reads it had never touched. Everything
 * here now derives from `FlipperReadOutcome`; the third describe below owns that.
 */
describe('the reason a status read came back empty is the board\'s, not the surface\'s', () => {
  const refresh = swiftBody(gateway, 'func refresh(within budget:')
  const statusLine = swiftBody(gateway, 'func statusLine(')
  const why = swiftBody(gateway, 'static func whyNoReading(')
  const whyGap = swiftBody(gateway, 'static func whyGap(')
  const reading = swiftBody(gateway, 'enum Reading {')
  const outcomeEnum = swiftBody(gateway, 'enum FlipperReadOutcome {')
  const panelRefresh = swiftBody(panel, 'private func refresh() async')
  /** Reading's own arms, read off the enum — never a list typed in here. */
  const arms = Array.from(reading.matchAll(/\n\s*case (\w+)/g), (m) => m[1])
  /** What one arm carries, read off the arm. */
  const payload = (arm: string) => reading.match(new RegExp(`case ${arm}\\(([^)]*)\\)`))?.[1] ?? ''
  /** The reads themselves, off `FlipperRead`'s own case list. */
  const reads = swiftBody(gateway, 'enum FlipperRead: String, CaseIterable {')
    .match(/\n\s*case ([\w, ]+)\n/)![1].split(',').map((s) => s.trim())
  /**
   * The ROADS a read can end by, and the one that carries the cause — both read off
   * `FlipperReadOutcome` rather than typed in here. Every semantic below hangs on
   * this rather than on the names I happened to choose: an outcome that carries
   * nothing but a cause is by definition the one that failed, and the other two are
   * the ones a single `Error?` could not tell apart — a read never issued, and a
   * read the board ANSWERED without the field.
   */
  const roads = Array.from(outcomeEnum.matchAll(/\n\s*case (\w+)/g), (m) => m[1])
  const carrier = outcomeEnum.match(/case (\w+)\(Error\)/)?.[1]

  it('refresh hands back the cause, not just a verdict', () => {
    expect(gateway, 'refresh went back to answering yes/no')
      .toMatch(/func refresh\(within budget: TimeInterval = \.infinity\) async -> Reading/)
    // Two arms, and BOTH carry how each read ended. A payload-free `.silent` is the
    // Bool again with extra steps; a `.silent` carrying one `Error?` is c33's shape,
    // which could not say which of three independent reads that cause belonged to.
    expect(arms).toEqual(['learned', 'silent'])
    for (const arm of arms) {
      expect(payload(arm), `${arm} no longer says how each read ended`)
        .toContain('outcomes: [FlipperRead: FlipperReadOutcome]')
      expect(payload(arm), `${arm} carries one cause for three independent reads again`)
        .not.toMatch(/Error/)
    }
    // Everything below this describe hangs on the carrying ROAD being findable, so
    // this is the test that owns the failure message for it.
    expect(carrier, 'no road to a gap carries what went wrong — the type is a Bool again')
      .toBeTruthy()
  })

  it('every read records how it ended, and the count comes from the reads themselves', () => {
    // Derived both ways: a fourth read added with a budget check but no record fails
    // here, and so does one added with neither.
    const budgeted = Array.from(refresh.matchAll(/allow\(Self\.\w+\)/g)).length
    const blocks = refresh.split(/if let t = allow\(Self\.\w+\) \{/).slice(1)
    expect(budgeted, 'the reads are no longer budget-checked individually').toBe(3)
    expect(blocks.length, 'a read is issued outside the budget check').toBe(budgeted)
    // Each block records BOTH roads it can take, and records them for ITS OWN read:
    // `outcomes[.power] = .failed(error)` inside the DeviceInfo block type-checks,
    // and explains a missing battery with a firmware failure — c33's defect with the
    // new type still on. The MAP is read out of the source rather than typed in — it is
    // a local, and a pin on my choice of name is a pin on nothing (37(g)) — but all
    // three blocks must record into the SAME one, and it must be the one the reading
    // then carries, or an outcome is recorded where no reader will ever ask for it.
    const maps = new Set<string>()
    const owners = blocks.map((b, i) => {
      const answered = b.match(/(\w+)\[\.(\w+)\] = \.answered/)
      const failed = b.match(/catch \{ (\w+)\[\.(\w+)\] = \.failed\(error\) \}/)
      expect(answered, `read ${i} never records that the board answered`).not.toBeNull()
      expect(failed, `read ${i} swallows its own failure`).not.toBeNull()
      expect(failed![2], `read ${i} records its failure against another read`).toBe(answered![2])
      maps.add(answered![1]).add(failed![1])
      return answered![2]
    })
    expect(maps.size, 'a read records how it ended into a map of its own').toBe(1)
    expect(refresh, 'the reading carries outcomes the reads never recorded into')
      .toMatch(new RegExp(`outcomes: ${[...maps][0]}\\b`))
    expect(new Set(owners).size, 'two reads record their outcome against the same read')
      .toBe(budgeted)
    // …and the reads that record are the reads the TYPE names, so a read cannot be
    // added with no outcome of its own — nor an outcome recorded for a read nobody makes.
    expect(owners.slice().sort(), 'a read records its outcome under another name')
      .toEqual([...reads].sort())
    // `try?` is the mechanism that threw every cause away. Not one may come back.
    expect(codeOnly(refresh, /catch \{ \w+\[\.\w+\] = \.failed\(error\) \}/),
      'a read is back to discarding its error').not.toMatch(/try\?/)
  })

  it('reads that ended the same way are one fact, not the same words twice', () => {
    // c33 kept ONE cause for a whole reading and called that collapsing: the second
    // and third failures were dropped, which is right when they say the same thing
    // and a misattribution when they do not. Grouping by the SENTENCE keeps both
    // halves — a link that never came up is said once, and two reads that failed
    // differently each keep their own words.
    const grouped = codeOnly(swiftBody(gateway, 'static func gapReasons('), /whyGap/)
    // The labels are part of the TYPE, which is why the assertions below may read
    // through them: one group of reads, one sentence, declared.
    expect(gateway, 'gapReasons no longer hands back one labelled reason per group')
      .toMatch(/static func gapReasons\([\s\S]{0,240}?-> \[\(reads: \[FlipperRead\], why: String\)\]/)
    const sentence = grouped.match(/let (\w+) = whyGap\(\w+\[\w+\][^)]*\)/)
    expect(sentence, 'gapReasons no longer asks whyGap about one read at a time').not.toBeNull()
    expect(grouped, 'two reads that failed the same way are reported as two problems')
      .toMatch(new RegExp(`firstIndex\\(where: \\{ \\$0\\.why == ${sentence![1]} \\}\\)`))
    // In the order the reads are made, never a dictionary's: which read is blamed
    // first must not vary from run to run. The parameter's name is read off the
    // signature, so renaming it is not a way to make this pass — or to fail it.
    const asked = gateway.match(/static func gapReasons\(_ (\w+): \[FlipperRead\]/)
    expect(asked, 'gapReasons no longer takes the reads to explain').not.toBeNull()
    expect(grouped, 'the reasons come out in whatever order a dictionary hands them over')
      .toMatch(new RegExp(`for \\w+ in ${asked![1]}\\b`))
    expect(grouped, 'the reasons are taken from an unordered dictionary')
      .not.toMatch(/\.values|\.keys/)
  })

  it('the outcome answers for itself, exhaustively', () => {
    expect(carrier, 'no road carries the error — see "refresh hands back the cause"')
      .toBeTruthy()
    // The accessor list is READ OFF the enum, never typed in here: c33 added a third
    // (`missing`) and c34 a fourth (`outcomes`), and a hand-written pair is precisely
    // how the newest one would have been exempt from the exhaustiveness rule below —
    // the pin would have kept passing while the newest accessor was the only one free
    // to grow a `default:`. The TYPE pattern has to admit `[FlipperRead:
    // FlipperReadOutcome]` for the same reason: a census that cannot see the accessor
    // carrying the whole of c34 exempts exactly it.
    const accessors = Array.from(reading.matchAll(/var (\w+): ([\w?[\]:, ]+) \{/g),
      (m) => [m[1], `var ${m[1]}: ${m[2]}`] as [string, string])
    expect(accessors.length, 'Reading stopped answering for itself').toBeGreaterThanOrEqual(3)
    const bodies = new Map(accessors.map(([name, accessor]) => {
      const body = codeOnly(swiftBody(reading, accessor), /switch self/)
      expect(body, `${accessor} grew a default:, so a third arm inherits an answer nobody chose`)
        .not.toMatch(/default:/)
      const answersFor = Array.from(body.matchAll(/case \.(\w+)/g), (m) => m[1]).sort()
      expect(answersFor, `${accessor} does not answer for every arm`)
        .toEqual([...arms].sort())
      return [name, body] as [string, string]
    }))
    // ⚠️ Arm COUNT is not an answer. Both accessors kept every case while returning
    // the wrong thing from one of them, and an exhaustiveness check cannot see that:
    // `didLearn` answering true for a silent read re-dates a memory as current, and
    // an `outcomes` that hands back the same map for both arms explains one reading's
    // gaps with another's reads.
    const didLearn = bodies.get('didLearn')
    const outcomesAcc = bodies.get('outcomes')
    expect(didLearn, 'Reading no longer says whether it learned anything').toBeTruthy()
    expect(outcomesAcc, 'Reading no longer hands back how each read ended').toBeTruthy()
    const answers = new Map(Array.from(didLearn!.matchAll(/case \.(\w+)[^:]*: return (\w+)/g),
      (m) => [m[1], m[2]] as [string, string]))
    expect(answers.size, 'didLearn no longer answers for every arm').toBe(arms.length)
    expect(new Set(answers.values()).size,
      'both arms get the same answer, so didLearn decides nothing').toBe(2)
    // Which arm is the empty one is derived from its PAYLOAD, not from its name: the
    // arm that says nothing about what is missing is the one that came back with
    // nothing.
    const empty = arms.filter((a) => !/missing:/.test(payload(a)))
    expect(empty.length, 'either both arms say what is missing or neither does').toBe(1)
    expect(answers.get(empty[0]), `${empty[0]} reports a reading it does not have`).toBe('false')
    // Each arm hands back the outcomes IT carries. A constant here — or the same
    // local from both arms — is c33's one-cause-for-a-whole-reading a layer down.
    for (const arm of arms) {
      expect(outcomesAcc, `${arm} answers with a constant instead of the outcomes it carries`)
        .toMatch(new RegExp(`case \\.${arm}\\([^)]*let (\\w+)\\): return \\1`))
    }
    // And the empty arm is missing EVERYTHING, which needs no special case anywhere
    // else (c33's pin, re-derived off the payload rather than off the name).
    expect(bodies.get('missing'), `${empty[0]} claims to be missing only some of it`)
      .toMatch(new RegExp(`case \\.${empty[0]}: return FlipperRead\\.allCases`))
    // ⚠️ And no accessor answers "the reason" for a whole reading. That is what handed
    // a failed read's words to the two reads that were never issued; an accessor which
    // offers it again is an invitation to ask, and it type-checks at every call site
    // c34 fixed.
    expect(accessors.map(([n]) => n), 'Reading answers for the reading again, not per read')
      .not.toContain('failure')
    expect(codeOnly(`${gateway}${panel}`, /gapReasons/),
      'something asks a whole reading for one cause again').not.toMatch(/\w+\.failure\b/)
  })

  it('the link is re-checked AFTER the read, because the read is when it drops', () => {
    const guards = Array.from(
      statusLine.matchAll(/guard linked else \{ return outageLine\(for: \.relayReply\) \}/g))
    expect(guards.length, 'the link is checked once, so the answer can re-state a 20s-old fact')
      .toBe(2)
    const readAt = statusLine.indexOf('await refresh(within: Self.relayStatusBudgetS)')
    expect(readAt, 'the budgeted read moved — this ordering check is stale').toBeGreaterThan(-1)
    expect(guards[0].index as number, 'nothing guards the read itself').toBeLessThan(readAt)
    expect(guards[1].index as number, 'the link is never re-checked after the read')
      .toBeGreaterThan(readAt)
    // …and the arm that says the link is up must come after that second check, or
    // the check is decoration.
    const staleArm = statusLine.indexOf('last reading that worked')
    expect(staleArm, 'the stale-reading arm moved').toBeGreaterThan(-1)
    expect(guards[1].index as number, 'the "still up" sentence is emitted before the re-check')
      .toBeLessThan(staleArm)
  })

  it('neither surface invents an open app on the board any more', () => {
    const gwCode = codeOnly(gateway, /whyNoReading/)
    for (const guess of ['something may be open on its screen',
                         'If an app is open on its screen, close it and ask again']) {
      expect(gwCode, `the relay reply still guesses: "${guess}"`).not.toContain(guess)
    }
    // The panel guessed in its own words, and picked the one claim it is least able
    // to make: `linked` may have gone false during the read it just did.
    expect(codeOnly(panel, /whyNoReading/), 'the panel still asserts a link it did not check')
      .not.toContain("the link is up but it didn't answer")
    // Both arms that had a guess carry the reason instead — and only those two, so a
    // third arm cannot appear without one. The local's name is read out of the call,
    // not typed in here, and what is PASSED is the whole READING: c34's defect was one
    // error made to answer for three reads, two of which it had never touched.
    const took = statusLine.match(/let (\w+) = await refresh\(within: Self\.relayStatusBudgetS\)/)
    expect(took, 'the relay reply no longer reads the board inside a budget').not.toBeNull()
    const reason = statusLine.match(/let (\w+) = Self\.whyNoReading\((\w+), for: \.relayReply\)/)
    expect(reason, 'the relay reply no longer asks for a reason at all').not.toBeNull()
    expect(reason![2], 'the relay reply explains an empty read from something other than the reading')
      .toBe(took![1])
    expect(Array.from(statusLine.matchAll(new RegExp(`\\\\\\(${reason![1]}\\)`, 'g'))).length,
      'a status arm reports an empty read with no reason').toBe(2)
    const panelReason = panelRefresh.match(/FlipperGateway\.whyNoReading\((\w+), for: \.panelSheet\)/)
    expect(panelReason, 'the panel no longer routes its note through the shared reason').not.toBeNull()
    expect(panelRefresh, `${panelReason?.[1]} is not the reading the panel just took`)
      .toMatch(new RegExp(`let ${panelReason![1]} = await flipper\\.refresh\\(\\)`))
    // "The figures above" is a claim about the sheet, which renders them under
    // `if let info` — so the clause has to be conditional on the same thing.
    expect(panel).toMatch(/if let info = flipper\.info \{/)
    expect(panelRefresh, 'the panel promises figures it may not be showing')
      .toMatch(/flipper\.info == nil/)
  })

  it('one sentence-maker, and the action it names is one the classifier covers', () => {
    // Delegates rather than writing its own sentence: a status read that MAY have
    // landed then gets the clause every other action gets (hazard 21). The error it
    // hands over is the one the ROAD bound, so an arm cannot delegate with a cause
    // that belongs to a different read.
    expect(whyGap, 'the failed road writes its own sentence instead of delegating')
      .toMatch(/case \.\w+\(let (\w+)\): return actionFailed\(\1, action: "\w+", for: audience\)/)
    const action = whyGap.match(/action: "(\w+)"/)![1]
    const literal = /static let readOnlyActions: Set<String> = \[([^\]]*)\]/.exec(gateway)
    expect(literal, 'readOnlyActions is no longer a Set literal — this derivation is stale')
      .not.toBeNull()
    const classified = Array.from(literal![1].matchAll(/"(\w+)"/g), (m) => m[1])
    // The entry that had no reader until now. Classified as a read, a failed status
    // says "asking again costs nothing but the wait"; classified as anything else it
    // would warn about a board this action never touched.
    expect(classified, `whyGap sends "${action}", which is not classified as a read`)
      .toContain(action)
    // No second `switch audience` in this body: two of them make every by-label
    // slice in this file ambiguous (`abandoned` exists for that reason).
    expect(codeOnly(whyGap, /actionFailed/), 'a second audience switch entered the status path')
      .not.toMatch(/switch audience/)
    // And the no-reading arms write nothing of their own — they are the per-read
    // sentences, joined, or one reading ends up described in two vocabularies (39(c)).
    expect(codeOnly(why), 'the no-reading arms grew a sentence of their own')
      .not.toMatch(/return "|= "/)
    expect(why, 'the no-reading arms no longer explain the reads that came back empty')
      .toMatch(/gapReasons\(\w+\.missing, \w+\.outcomes, for: audience\)/)
  })

  it('a budget that ran out is this phone\'s clock, not the board\'s silence', () => {
    const skipped = swiftCase(codeOnly(whyGap, /This phone/), '.unasked')
    expect(skipped, 'the never-asked road no longer names whose time ran out').toMatch(/This phone/)
    // The failure mode it exists to prevent is c31's, mirrored: describing a request
    // that was never made as an answer the board withheld.
    for (const blame of [/didn't answer/, /no Flipper is linked/i, /Flipper (didn't|hasn't|stopped)/]) {
      expect(skipped, `the never-asked road blames the board: ${blame}`).not.toMatch(blame)
    }
    // Reachable only if the budget can be spent before the first read is issued —
    // pinned as arithmetic so a future ceiling change cannot make it silently a lie.
    const budget = Number(gateway.match(/relayStatusBudgetS: TimeInterval = (\d+)/)![1])
    const floor = Number(gateway.match(/minRequestS: TimeInterval = (\d+)/)![1])
    expect(budget, 'the relay budget no longer affords even one read').toBeGreaterThan(floor)
  })
})

/**
 * ⚠️ A READING THAT CAME BACK SHORT LOOKS EXACTLY LIKE A COMPLETE ONE.
 *
 * `refresh` makes three independent reads and returned `.learned` when ANY of them
 * left a value behind — which is right, a board that answers two of three is worth
 * showing. What it did not do is say which one is missing, and `FlipperInfo.summary`
 * tests every field it prints (`if !firmware.isEmpty`, `if let pct = batteryPct`,
 * `if let free = freeBytes`), so a read that never landed leaves NO trace: the line
 * just gets shorter. "unlshd-075 · Flipper C2" is what DeviceInfo-and-nothing-else
 * looks like, and it is indistinguishable from a Flipper with no battery and no SD
 * card — stamped, on both surfaces, "read just now".
 *
 * The two facts anybody asks a Flipper for are the ones that go missing that way.
 * And `.learned` carried no cause at all, so the collected error was thrown away in
 * exactly the case that needed it: the read that failed is the read whose value is
 * absent.
 *
 * ⚠️ It needs no broken board. `deviceInfoS` (25s) exceeds `relayStatusBudgetS`
 * (20s) on its own, so a slow DeviceInfo can spend the whole budget; `allow` then
 * returns nil for Power and Storage, nothing throws, `failure` is nil, and the answer
 * is a short line with a fresh timestamp. That is also the first REACHABLE reader for
 * c32's nil arm — "this phone ran out of its own time" — which until now guarded a
 * case today's constants cannot produce.
 *
 * So: `FlipperRead`, the three reads as a type; `FlipperInfo.gaps`, asked of the
 * VALUES rather than of which requests threw, because a skipped read, a refused one
 * and a board that answered without the field take the same words out of `summary`;
 * `.learned(missing:because:)`; and ONE frame, `missingLine`, rendered live by the
 * panel row off the stored reading and appended by `gapClause` to whatever a caller
 * just asked. The row matters most: `finishLink` refreshes on its own, so the first
 * line that row ever shows is one nobody tapped for, and no note covers it.
 */
describe('a reading that came back short does not pass for a whole one', () => {
  const refresh = swiftBody(gateway, 'func refresh(within budget:')
  const statusLine = swiftBody(gateway, 'func statusLine(')
  const reading = swiftBody(gateway, 'enum Reading {')
  const readEnum = swiftBody(gateway, 'enum FlipperRead: String, CaseIterable {')
  const summary = swiftBody(gateway, 'var summary: String')
  const gaps = swiftBody(gateway, 'var gaps: [FlipperRead]')
  const missingLine = swiftBody(gateway, 'static func missingLine(')
  const gapClause = swiftBody(gateway, 'static func gapClause(')
  const whyGap = swiftBody(gateway, 'static func whyGap(')
  const panelRefresh = swiftBody(panel, 'private func refresh() async')
  /** The reads, off the enum's own case list — three names on one line. */
  const reads = readEnum.match(/\n\s*case ([\w, ]+)\n/)![1].split(',').map((s) => s.trim())

  it('the reads a refresh makes are a type, and there are as many as it makes', () => {
    // Derived both ways: a fourth read added to `refresh` with no case here fails,
    // and a fourth case with no read fails too. A hand-typed 3 would catch neither.
    const budgeted = Array.from(refresh.matchAll(/allow\(Self\.\w+\)/g)).length
    expect(reads.length, 'FlipperRead no longer names one read per read').toBe(budgeted)
    const subject = codeOnly(swiftBody(readEnum, 'var subject: String'), /switch self/)
    expect(subject, 'subject grew a default:, so a new read gets a name nobody chose')
      .not.toMatch(/default:/)
    const named = Array.from(subject.matchAll(/case \.(\w+): return "([^"]+)"/g),
      (m) => [m[1], m[2]] as [string, string])
    expect(named.map((n) => n[0]).sort(), 'a read has no subject').toEqual([...reads].sort())
    for (const [read, phrase] of named) {
      // No verb. "its firmware and model" is ONE read that reads plural, so any
      // is/are agreement in the frame would be wrong for one of the three — a label
      // cannot be conjugated wrongly. Same reason there is no leading "its": the
      // frame supplies one, so three gaps read as one list, not three claims.
      expect(phrase, `${read}'s subject conjugates a verb the frame cannot honour`)
        .not.toMatch(/\b(is|are|was|were|has|have)\b/)
      expect(phrase, `${read}'s subject repeats the frame's "its"`).not.toMatch(/^its /)
    }
  })

  it('a learned reading carries what is missing and how each read ended', () => {
    expect(reading, 'the learned outcome no longer says what it is missing')
      .toMatch(/case learned\(missing: \[FlipperRead\], outcomes: \[FlipperRead: FlipperReadOutcome\]\)/)
    // The outcome's payloads, and where each comes from: the gaps off the VALUES, the
    // outcomes off what each read actually did. `.learned(missing: [], outcomes: [:])`
    // type-checks and says nothing, which is the bug this describe exists for.
    const built = refresh.match(
      /return \w+ \? \.learned\(missing: (\w+), outcomes: (\w+)\) : \.silent\(outcomes: (\w+)\)/)
    expect(built, 'refresh no longer builds a learned reading out of both').not.toBeNull()
    const [, gapsVar, endedVar, silentVar] = built!
    expect(silentVar, 'the two arms are handed different records of the same three reads')
      .toBe(endedVar)
    expect(refresh, `${gapsVar} is not the reading's own gaps`)
      .toMatch(new RegExp(`let ${gapsVar} = (\\w+)\\.gaps`))
    // The SAME local that decides `learned` must be the one asked for gaps —
    // otherwise the answer describes a different snapshot than the one stored.
    const snapshot = refresh.match(new RegExp(`let ${gapsVar} = (\\w+)\\.gaps`))![1]
    expect(refresh, 'the gaps are measured on a different value than the one stored')
      .toMatch(new RegExp(`let \\w+ = ${snapshot} != FlipperInfo\\(\\)`))
    // Seeded from the reads THEMSELVES, so a read that recorded nothing is "never
    // asked" because nothing overwrote it — not because it is absent from a map that
    // grew keys as it went, where a missing key and a skipped read are the same thing.
    expect(codeOnly(refresh, /uniqueKeysWithValues/).replace(/\s+/g, ' '),
      `${endedVar} is not seeded from the reads themselves`)
      .toContain(`var ${endedVar} = Dictionary(uniqueKeysWithValues: `
        + 'FlipperRead.allCases.map { ($0, FlipperReadOutcome.unasked) })')
    // Nothing came back at all: everything is missing, and saying so needs no
    // special case anywhere else.
    const missing = codeOnly(swiftBody(reading, 'var missing: [FlipperRead]'), /switch self/)
    expect(missing, 'a silent reading claims to be missing only some of it')
      .toMatch(/case \.silent: return FlipperRead\.allCases/)
  })

  it('what is missing is measured against what the line actually prints', () => {
    // The fields `summary` shows conditionally, read out of `summary` itself. Add a
    // fifth conditional bit to the line and this goes red until `gaps` accounts for
    // it — which is the whole mechanism: the sentence explaining a short line cannot
    // drift from the line (hazard 21).
    const conditional = new Set([
      ...Array.from(summary.matchAll(/if !(\w+)\.isEmpty/g), (m) => m[1]),
      ...Array.from(summary.matchAll(/if let \w+ = (\w+)/g), (m) => m[1]),
    ])
    expect(conditional.size, 'summary stopped printing its fields conditionally — re-derive this')
      .toBeGreaterThanOrEqual(4)
    for (const field of conditional) {
      expect(gaps, `${field} can vanish from the line with nothing said about it`)
        .toContain(field)
    }
    // Asked of the values, never of which requests threw. The three reads all still
    // run and all still note their own error (the pins above), so a gaps derived
    // from failures would report nothing for the commonest partial there is: a read
    // that was never issued because the budget ran out.
    expect(codeOnly(gaps, /FlipperRead/), 'gaps is derived from failures instead of values')
      .not.toMatch(/error|failure|throw/)
    // One read fills firmware and model both, so either one present means DeviceInfo
    // answered — `&&`, not two separate gaps.
    expect(gaps).toMatch(/if firmware\.isEmpty && model\.isEmpty \{/)
  })

  it('a complete reading is left exactly as it was', () => {
    // Both gates, because the clause is appended unconditionally at the call sites:
    // an empty string is what keeps a whole reading's line unchanged.
    expect(missingLine, 'a complete reading gets a sentence about nothing')
      .toMatch(/guard !gaps\.isEmpty else \{ return nil \}/)
    expect(gapClause, 'a complete reading gets a leading space and a cause')
      .toMatch(/guard let \w+ = missingLine\(\w+\.missing\) else \{ return "" \}/)
  })

  it('one frame, and no audience — the same reading cannot be described two ways', () => {
    expect(gateway).toMatch(/static func missingLine\(_ gaps: \[FlipperRead\]\) -> String\?/)
    // No `for audience:` on it and no switch inside: what a reading is missing is the
    // same fact for the person holding the phone and for a web chat. Only the CAUSE
    // is audience-shaped, and `whyNoReading` already owns that decision (hazard 31(c)
    // — a second `switch audience` in this path makes every by-label slice in this
    // file ambiguous).
    expect(missingLine, 'missingLine grew an audience').not.toMatch(/audience/)
    const frames = Array.from(`${gateway}${panel}`.matchAll(/Missing from this reading/g))
    expect(frames.length, 'the frame is written twice, or has gone').toBe(1)
    // ⚠️ Counting MY frame's words cannot see a surface that writes a DIFFERENT one:
    // the panel row rendering `info.gaps.map(\.subject).joined()` inline, in its own
    // wording, left the count at 1 and this test green (found by /tmp/mut-c33.py).
    // So pin the ROAD, not the words — reads become words in exactly one place, and
    // c34's per-reason labels ("Its battery level: …") go through the same one.
    const subjects = Array.from(
      `${codeOnly(gateway, /\.subject\b/)}${codeOnly(panel)}`.matchAll(/\.subject\b/g))
    expect(subjects.length, 'a second place turns reads into words of its own').toBe(1)
    expect(gateway, 'the one place is no longer a shared function two callers can use')
      .toMatch(/static func subjectList\(_ reads: \[FlipperRead\]\) -> String/)
    expect(codeOnly(panel, /missingLine/), 'the panel words a gap list itself')
      .not.toMatch(/gaps\.map|gaps\.joined|gaps\.count/)
    // The clause is the frame plus the cause, in that order: what is missing, then
    // why. Reversed, the reader gets a reason before knowing what it is a reason for.
    const frameVar = gapClause.match(/guard let (\w+) = missingLine\(\w+\.missing\)/)![1]
    const causeVar = gapClause.match(/let (\w+) = (\w+)\s*\.map \{/)
    expect(causeVar, 'the clause no longer builds one reason per read').not.toBeNull()
    expect(gapClause, 'the cause comes before the thing it is a cause for')
      .toMatch(new RegExp(`return " \\\\\\(${frameVar}\\) \\\\\\(${causeVar![1]}\\)"`))
  })

  it('the relay reply appends it to the arm that stamps "read just now"', () => {
    // `gapClause` belongs to the arm that just took a reading, and to that arm only:
    // it is the FRESH attempt's gaps plus the FRESH attempt's causes, and on a
    // no-reading arm `reading.missing` is all three reads — everything, twice over.
    // ⚠️ What that does NOT license is a remembered summary going out with nothing
    // beside it. The stale arm quotes a STORED reading, which has gaps of its own and
    // needs `missingLine(i.gaps)` — see 'a remembered reading is not a whole one'
    // below. This comment used to argue the no-reading arms "already say everything is
    // missing in their own words", which is true of the arm that has no reading at all
    // and false of the one that hands over an older line.
    expect(statusLine, 'the fresh arm no longer discloses what it is missing')
      .toMatch(/read just now\)\\\(Self\.gapClause\(\w+, for: \.relayReply\)\)/)
    expect(Array.from(statusLine.matchAll(/gapClause/g)).length,
      'a no-reading arm also lists gaps, which is everything, twice over').toBe(1)
    // And the age it stamps is still the reading's, not the question's — the clause
    // qualifies that stamp rather than replacing it.
    expect(statusLine).toContain('reading.didLearn, let i = info')
  })

  it('the panel row keeps saying it for as long as the short reading stands', () => {
    const paired = swiftBody(panel, '@ViewBuilder private var paired: some View')
    const sliced = paired.slice(paired.indexOf('if let info = flipper.info {'),
                                paired.indexOf('if !flipper.activity.isEmpty {'))
    expect(sliced.length, 'the info branch moved — this slice is stale').toBeGreaterThan(0)
    // Comments stripped: the paragraph above the new line explains why `note` cannot
    // cover this case, and the last assertion here is that `note` is not in the code.
    const branch = codeOnly(sliced, /missingLine/)
    const at = (needle: string) => {
      const i = branch.indexOf(needle)
      expect(i, `${needle} is not in the reading's own branch`).toBeGreaterThan(-1)
      return i
    }
    // All three under ONE `if let info`, in this order: the line, how old it is, what
    // it is missing. Outside that branch, any of them can be drawn with no reading
    // behind it (c30's rule, applied to the third line).
    expect(at('Text(info.summary)')).toBeLessThan(at('ReadingAge.asOf(flipper.infoAt)'))
    expect(at('ReadingAge.asOf(flipper.infoAt)'))
      .toBeLessThan(at('FlipperGateway.missingLine(info.gaps)'))
    // LIVE off the stored reading, not off the last tap: `finishLink` runs a refresh
    // of its own, so the first line this row ever shows is one nobody pressed a
    // button for — and `note` only ever describes a press.
    expect(branch, 'the row reports gaps from a note instead of from the reading')
      .not.toMatch(/note/)
  })

  it('the panel says a partial read is partial, not failed', () => {
    const [failed, partial] = panelRefresh.split(/\n\s*\} else \{/)
    expect(partial, 'the partial-reading branch is gone').toBeTruthy()
    expect(partial, 'the panel no longer explains a reading that came back short')
      .toMatch(/FlipperGateway\.gapClause\(\w+, for: \.panelSheet\)/)
    // Guarded on the clause being non-empty, or every complete reading gets a note
    // saying nothing is wrong — noise that trains the reader to ignore the line.
    expect(partial, 'a complete reading gets a note anyway').toMatch(/if !\w+\.isEmpty \{ note = /)
    // A reading that landed is not a failure, and must not borrow the failure's
    // words. Nor may the failure arm borrow the partial's.
    expect(partial, 'a partial reading is reported as a failed one')
      .not.toContain("Couldn't read the Flipper")
    expect(failed, 'a failed read claims to have read part of it').not.toContain('not all of it')
    // The failure arm is still the one that mentions the figures already on screen —
    // c32's pin, re-checked here because this split is what could quietly move it.
    expect(failed).toMatch(/flipper\.info == nil/)
  })

  it('"this phone ran out of time" is true in both places it can now appear', () => {
    const skipped = swiftCase(codeOnly(whyGap, /This phone/), '.unasked')
    // It is appended after "Missing from this reading: …" as well as after the
    // no-reading sentences, so it must not name the reading itself: "before it could
    // read anything" is false of a reading that came back with the firmware.
    expect(skipped, 'the never-asked road talks about the reading, and that is now sometimes wrong')
      .not.toMatch(/reading/i)
    expect(skipped, 'the never-asked road no longer names whose time ran out').toMatch(/This phone/)
    // Reachable TODAY, pinned as arithmetic: the first read may be allowed more time
    // than the budget can spare, and then the second is skipped rather than issued.
    // Without this, the sentence above guards a case the constants cannot produce.
    const n = (k: string) => Number(gateway.match(new RegExp(`${k}: TimeInterval = (\\d+)`))![1])
    const budget = n('relayStatusBudgetS')
    expect(Math.min(n('deviceInfoS'), budget), 'no single read can exhaust the budget any more')
      .toBeGreaterThan(budget - n('minRequestS'))
    // …and the gaps that partial produces have no failure behind them, which is the
    // only reason this arm gets a reader at all.
    expect(refresh).toMatch(/return left >= Self\.minRequestS \? min\(want, left\) : nil/)
  })
})

/**
 * ⚠️ A GAP EXPLAINED BY WHAT HAPPENED TO A DIFFERENT READ.
 *
 * c33 disclosed what a short reading was missing and gave `.learned` a cause to
 * explain it: ONE `because: Error?`, the first failure in read order. Three
 * independent reads, one cause — so it was handed to every gap, including the gaps of
 * reads it had never touched. And when nothing threw at all it was nil, which
 * `whyNoReading` reported as *"This phone ran out of its own time before it could
 * ask."*
 *
 * That sentence is true of ONE road to a gap out of three:
 *   (a) never issued — `allow()` returned nil, and this phone's clock IS the reason;
 *   (b) issued, and it FAILED — the board's or the link's own words, `.status(17)`
 *       being an app open on its screen, said by the board;
 *   (c) issued, and the board ANSWERED WITHOUT THE FIELD — `keyValues` hands back an
 *       empty dictionary rather than throwing when no frame carries a key, and
 *       `p["charge_level"].flatMap { Int($0) }` is nil for a key that is absent OR
 *       that does not parse (`Int("94.5")` is nil). Nothing threw, nothing was
 *       skipped, and there is nothing on this side for the reader to fix.
 *
 * ⚠️ And on two of the three rails it was true of NONE of them. `refresh`'s budget
 * defaults to `.infinity`, `allow` returns `want` outright when the budget is
 * infinite, and neither the panel's Refresh button nor `finishLink` passes one — so no
 * read there can be skipped, (a) is unreachable, and the clock sentence was printed
 * only ever when it was false. (Hazard 35(a): work out who can reach a branch PER
 * RAIL, through the clamp, not from the constant.)
 *
 * So: a third STATE, not a fourth sentence. `FlipperReadOutcome` is recorded per read
 * while it is still knowable — no value can carry it afterwards — `gapReasons` groups
 * the gaps by the SENTENCE their own read earns, and `gapClause` names subjects when
 * the reasons disagree ("Its battery level: …"), because a cause that names nothing is
 * read as the cause of everything. `Reading.failure` is gone with it: an accessor that
 * answers "the reason" for three independent reads is the same defect with a nicer
 * type, and it type-checked at every call site this cycle had to fix.
 */
describe('a gap is explained by what happened to ITS read', () => {
  const refresh = swiftBody(gateway, 'func refresh(within budget:')
  const whyGap = swiftBody(gateway, 'static func whyGap(')
  const why = swiftBody(gateway, 'static func whyNoReading(')
  const gapClause = swiftBody(gateway, 'static func gapClause(')
  const gaps = swiftBody(gateway, 'var gaps: [FlipperRead]')
  const outcomeEnum = swiftBody(gateway, 'enum FlipperReadOutcome {')
  /** The roads, off the enum's own case list. */
  const roads = Array.from(outcomeEnum.matchAll(/\n\s*case (\w+)/g), (m) => m[1])
  /** whyGap with its prose stripped, so a sentence can be checked for what it says. */
  const spoken = codeOnly(whyGap, /switch \w+/)
  /**
   * One arm of whyGap's switch, whether or not that road carries a payload. The
   * binding is read out of the source rather than typed in: `case .failed(let error):`
   * and `case .unasked:` are the same question asked of different roads, and a slicer
   * that only knows one shape silently stops covering the other.
   */
  const armFor = (road: string): string => {
    const declared = spoken.match(new RegExp(`case \\.${road}(\\([^)]*\\))?:`))
    expect(declared, `whyGap no longer answers for ${road}`).not.toBeNull()
    return swiftCase(spoken, `.${road}${declared![1] ?? ''}`)
  }
  /**
   * What an arm SAYS, with the tail that is no part of the answer taken off.
   *
   * ⚠️ The LAST arm's slice runs to the end of the body, so it carries the switch's
   * closing braces, while every earlier arm stops at the next `case `. Two roads
   * returning ONE sentence therefore differ AS SLICES — and the road that got the
   * duplicate sentence is the last one. /tmp/mut-c34.py found `case .answered: return
   * "This phone ran out of its own time…"` — c33 restored — surviving the single check
   * that exists to catch it, on a tail nobody wrote. Compare the words, never the
   * whitespace they came wrapped in.
   */
  const saidBy = (road: string): string => {
    const said = armFor(road).replace(/[\s}]+$/, '').trim()
    expect(said, `the ${road} road answers with nothing at all`).not.toBe('')
    return said
  }

  it('the roads to a gap are a type, and no two of them get the same words', () => {
    // Named here because every semantic below names them, and a rename that slipped
    // through would make those checks pass vacuously. Three roads, three parties: this
    // phone's clock, the board's own words, and a board that answered.
    // Sorted: which order the cases sit in decides nothing, and a pin that reds on a
    // reorder is a pin on my typing (hazard 37(g)).
    expect([...roads].sort(), 'a road to a gap was added, removed or renamed — the pins below name them')
      .toEqual(['answered', 'failed', 'unasked'])
    expect(spoken, 'whyGap grew a default:, so a fourth road inherits words nobody chose')
      .not.toMatch(/default:/)
    const said = roads.map(saidBy)
    for (const [i, arm] of said.entries()) {
      expect(Array.from(arm.matchAll(/return /g)).length,
        `${roads[i]} answers with more or less than one sentence`).toBe(1)
    }
    // ⚠️ The defect was three roads sharing two sentences. Distinctness is the whole
    // fix, and an exhaustive switch cannot see it: `case .answered: return "This phone
    // ran out of its own time before it could ask."` compiles, covers every case, and
    // is c33 restored. Compared as SENTENCES, not as arms — the arms carry their own
    // labels and so differ even when the words after them do not.
    expect(new Set(said).size, 'two roads to a gap are explained in the same words')
      .toBe(roads.length)
  })

  it('a board that answered without the field is not this phone being slow', () => {
    // The words, not the slice: this is the last arm, so its raw slice ends in the
    // switch's own braces (see `saidBy`).
    const arm = saidBy('answered')
    expect(arm, 'the answered road no longer says the board answered').toMatch(/answered/i)
    // Not the clock: this read was issued and it came back. Not a remedy either — what
    // a reader can do about a board that answers without a field is not knowable from
    // here, and the only sentence this file has ever offered instead pointed at the
    // board's own Bluetooth screen, one row above "Forget all paired devices"
    // (hazard 4, 38(b)).
    for (const wrong of [/ran out/i, /this phone/i, /clock/i, /in time/i,
                         /close it/i, /screen/i, /settings/i, /nearby/i, /Bluetooth/i]) {
      expect(arm, `the answered road says something it cannot know: ${wrong}`).not.toMatch(wrong)
    }
    // …and it is REACHABLE, which is why it needs words of its own: the two reads that
    // go through `keyValues` come back with no keys rather than throwing, and the
    // battery is parsed with a flatMap that is nil for absent AND unparseable.
    const kv = codeOnly(swiftBody(gateway, 'private func keyValues('), /return out/)
    expect(kv, 'keyValues throws on an answer with no keys, so this road is now unreachable')
      .not.toMatch(/throw/)
    expect(refresh, 'the battery can no longer come back unparseable without throwing')
      .toMatch(/batteryPct = \w+\["charge_level"\]\.flatMap \{ Int\(\$0\) \}/)
  })

  it('the clock sentence cannot be printed on a rail that has no clock', () => {
    // ⚠️ The arithmetic that makes (a) unreachable on two of three rails — and it is
    // the RAIL, not the constant, that decides. `allow` never skips a read when the
    // budget is infinite, and only one caller passes a budget at all.
    expect(refresh, 'a clockless rail can now skip a read')
      .toMatch(/guard budget\.isFinite else \{ return want \}/)
    expect(gateway, 'refresh no longer defaults to an unbounded read')
      .toMatch(/func refresh\(within budget: TimeInterval = \.infinity\)/)
    const code = codeOnly(`${gateway}${panel}`, /refresh\(within: Self\.relayStatusBudgetS\)/)
    expect(Array.from(code.matchAll(/refresh\(within: [^)]+\)/g), (m) => m[0]),
      'a second rail passes a budget — "this phone ran out of time" is reachable on it now')
      .toEqual(['refresh(within: Self.relayStatusBudgetS)'])
    // The two that pass none, counted where each one lives: `finishLink`, which
    // refreshes on its own so the panel row has something to show the moment a link
    // comes up, and the panel's Refresh button. Both were being told this phone's clock
    // ran out, for gaps that had answers behind them.
    expect(Array.from(codeOnly(gateway, /await refresh\(\)/).matchAll(/await refresh\(\)/g)).length,
      'finishLink stopped refreshing on its own, or a second unbudgeted rail appeared')
      .toBe(1)
    expect(Array.from(codeOnly(panel, /flipper\.refresh\(\)/).matchAll(/await flipper\.refresh\(\)/g))
      .length, 'the panel no longer reads the board without a budget').toBe(1)
  })

  it('one read\'s failure never explains another read\'s gap', () => {
    // Both sentence-makers ask about a READ, and both ask the SAME reading for the
    // gaps and for the outcomes: two readings crossed here is the c33 defect with more
    // moving parts.
    for (const [what, body] of [['the clause', gapClause], ['the no-reading arms', why]] as const) {
      const call = body.match(/gapReasons\((\w+)\.missing, (\w+)\.outcomes, for: audience\)/)
      expect(call, `${what} no longer explain each read that came back empty`).not.toBeNull()
      expect(call![2], `${what} take the gaps and the outcomes from different readings`)
        .toBe(call![1])
    }
    // And nothing reconstitutes one cause for the whole reading on the way past.
    expect(codeOnly(gapClause, /gapReasons/), 'the clause is back to one cause for every gap')
      .not.toMatch(/\.failure\b|firstError|lastError/)
  })

  it('a cause that names no subject is read as the cause of all of them', () => {
    const reasonsVar = gapClause.match(/let (\w+) = gapReasons\(/)
    expect(reasonsVar, 'the clause no longer groups the gaps by their reason').not.toBeNull()
    // One reason: it stands alone, because the frame has just named every gap it
    // covers. Two or more: each names the gaps it accounts for, through the ONE place
    // reads become words. Without the labels, "This phone ran out of its own time"
    // sitting after a two-gap frame is read as the reason for both — which is the
    // sentence this cycle exists to stop printing.
    expect(gapClause, 'a reason no longer says which gaps it accounts for')
      .toMatch(new RegExp(`${reasonsVar![1]}\\.count == 1 \\? \\$0\\.why`
        + ` : "Its \\\\\\(subjectList\\(\\$0\\.reads\\)\\): \\\\\\(\\$0\\.why\\)"`))
    // The no-reading arms do NOT label: that arm has already said no reading came back
    // at all, so naming all three subjects after it is noise (39(c) — one reading, one
    // vocabulary, and the frame decides which).
    expect(codeOnly(why, /gapReasons/).replace(/\s+/g, ' '),
      'the no-reading arms label subjects the arm itself has already covered')
      .toMatch(/gapReasons\(\w+\.missing, \w+\.outcomes, for: audience\) \.map\(\\\.why\)\.joined\(separator: " "\)/)
  })

  it('what is missing still comes off the VALUES, now that there is something else to ask', () => {
    // ⚠️ 39(b), and the temptation this cycle creates: `outcomes` is right there, and
    // deriving the gaps from it would be wrong in both directions. A read that
    // ANSWERED can still be a gap (that is road (c), the whole point), and a read that
    // failed after filling one of its two fields is not a whole gap either. The values
    // are what the reader sees; the outcomes are only why.
    expect(codeOnly(gaps, /FlipperRead/), 'the gaps are derived from what happened, not from what shows')
      .not.toMatch(/outcome|unasked|answered|failed|error|throw/i)
    expect(refresh, 'the gaps are no longer measured on the reading itself')
      .toMatch(/let \w+ = \w+\.gaps/)
  })
})

/**
 * ⚠️ A REMEMBERED READING WENT OUT AS A WHOLE ONE.
 *
 * c33 disclosed what a short reading was missing and c34 explained each gap by what
 * happened to ITS read — both on the reading a caller had *just taken*. `statusLine`
 * has a third arm, and it renders a reading from BEFORE: the link is still up, this
 * attempt learned nothing, so it hands over the last one that did, dated. That line is
 * `FlipperInfo.summary` — every bit of it conditional — and it went out with the words
 * *"This is the last reading that worked"* and nothing else.
 *
 * A stored reading is partial exactly as often as a fresh one, and on this rail more
 * often: `deviceInfoS` (25s) outlasts `relayStatusBudgetS` (20s), so the read that
 * stored it may never have asked for the battery or the SD card. Then the board goes
 * quiet — an app opens on its screen, `.status(17)` on all three reads — and the reply
 * quotes a two-of-three line under a completeness claim. *"unlshd-075 · Flipper C2, 3
 * minutes ago"* is indistinguishable from a Flipper with a flat battery and no SD card,
 * which is 39's defect on the one arm 39 did not cover.
 *
 * ⚠️ The panel row has been getting this right since c33, off these same stored values
 * (`missingLine(info.gaps)`, live under the age line). So the fact had one correct
 * surface and one silent one — hazard 21, and the silent one is the one with no second
 * line to put it on. The tell was in this file: the pin above argued that a no-reading
 * arm "already says everything is missing in its own words", which is true of the arm
 * that has NO reading and false of the arm that hands over an older one.
 *
 * The lesson, and the census below: **count the renderers of the VALUE, not the callers
 * of the disclosure.** `gapClause` had one call site and looked complete; `.summary` had
 * three renderers and one of them was bare.
 */
describe('a remembered reading is not a whole one', () => {
  const statusLine = swiftBody(gateway, 'func statusLine(')
  // ⚠️ `/summary/`, and NOT `/missingLine/`: the needle a slicer proves itself with
  // cannot be the feature under test. With the disclosure as the needle, deleting it
  // makes `codeOnly` throw while this describe's body is being evaluated — the whole
  // FILE then fails to collect, which is a red nobody can attribute to a pin. What
  // has to survive stripping is the thing the census counts.
  const spoken = codeOnly(statusLine, /summary/)
  /**
   * The block a given offset sits inside: back to the unmatched `{`, then forward to
   * its partner. Derived rather than sliced by branch condition — an arm named in this
   * file is an arm this file stops covering when it is reworded (28(a)), and the point
   * of the census is that it must see an arm nobody has told it about. Works on a
   * SwiftUI `if let` branch as readily as on a function's, which is what lets the
   * cross-surface census below ask the same question of the panel row.
   */
  const blockAt = (body: string, index: number): string => {
    let depth = 0
    let start = -1
    for (let i = index; i >= 0; i--) {
      if (body[i] === '}') depth++
      else if (body[i] === '{') {
        if (depth === 0) { start = i; break }
        depth--
      }
    }
    expect(start, 'a summary is rendered outside any branch of statusLine').toBeGreaterThan(-1)
    let d = 0
    for (let i = start; i < body.length; i++) {
      if (body[i] === '{') d++
      else if (body[i] === '}' && --d === 0) return body.slice(start + 1, i)
    }
    throw new Error('an arm of statusLine never closed')
  }
  /** Every arm of statusLine that renders a stored summary, with its binding. */
  const arms = Array.from(spoken.matchAll(/\\\((\w+)\.summary\)/g),
    (m) => ({ bound: m[1], arm: blockAt(spoken, m.index!) }))

  it('every arm that quotes a summary says what is not in it', () => {
    // ⚠️ THE PIN THIS DEFECT NEEDED, and it is a census over the renderers of the
    // VALUE. `summary` prints four fields conditionally, so an arm that quotes it and
    // says nothing else is claiming a complete reading whatever came back — and there
    // is no count of `gapClause`'s call sites that can notice a second renderer.
    // Floored, so a slicer that finds no arms is red rather than vacuously green.
    expect(arms.length, 'statusLine stopped rendering the reading — re-derive this')
      .toBeGreaterThanOrEqual(2)
    for (const { bound, arm } of arms) {
      expect(arm, `an arm quotes ${bound}.summary with no account of what is missing`)
        .toMatch(/Self\.(gapClause|missingLine)\(/)
    }
  })

  it('the remembered arm asks the STORED values, not the attempt that just failed', () => {
    // Which arm is which comes out of the code: the one that calls `missingLine`
    // directly is the one holding a reading it did not take. `gapClause` is the other
    // one's, and it carries this attempt's causes with it.
    const remembered = arms.filter(({ arm }) => /Self\.missingLine\(/.test(arm))
    expect(remembered.length, 'no arm discloses a remembered reading any more').toBe(1)
    const { bound, arm } = remembered[0]
    // The gaps come off the SAME binding the line came off — the stored reading's own
    // values (39(b)). `reading.missing` would be this attempt's story, which for a
    // silent reading is all three reads: it would report the battery missing from a
    // line that prints it.
    expect(arm, `the remembered gaps are not ${bound}'s own`)
      .toMatch(new RegExp(`Self\\.missingLine\\(${bound}\\.gaps\\)`))
    const fresh = statusLine.match(/let (\w+) = await refresh\(within: Self\.relayStatusBudgetS\)/)
    expect(fresh, 'the budgeted read no longer keeps its outcome').not.toBeNull()
    const call = arm.match(/Self\.missingLine\(([^)]*)\)/)![1]
    expect(call, 'the remembered line is explained by the attempt that failed instead')
      .not.toContain(fresh![1])
    // And it does not word its own list — reads become words in exactly one place, and
    // a surface that maps over `gaps` is the mutant c33's frame count could not see.
    expect(arm, 'the remembered arm builds a gap list of its own')
      .not.toMatch(/gaps\.map|gaps\.joined|gaps\.count|gaps\.isEmpty/)
  })

  it('the cause is this attempt\'s, the gap is the old line\'s, and each is said once', () => {
    const remembered = arms.filter(({ arm }) => /Self\.missingLine\(/.test(arm))[0]
    const { bound, arm } = remembered
    // Order inside the sentence: why nothing came back JUST NOW, then the older line,
    // then what was never in it. A frame reading "Missing from this reading" cannot
    // come before the reading it frames (39(c), and the reason `gapClause` puts the
    // frame first is that there the reading is already on the line above).
    const reason = statusLine.match(/let (\w+) = Self\.whyNoReading\((\w+), for: \.relayReply\)/)
    expect(reason, 'the no-reading arms stopped taking their cause from the reading').not.toBeNull()
    const held = arm.match(/let (\w+) = Self\.missingLine\(/)
    expect(held, 'the remembered arm no longer holds its disclosure in a local').not.toBeNull()
    const line = arm.slice(arm.indexOf('return "'))
    const at = (needle: string) => {
      const i = line.indexOf(`\\(${needle})`)
      expect(i, `${needle} is not interpolated into the remembered line`).toBeGreaterThan(-1)
      return i
    }
    expect(at(reason![1]), 'the cause of THIS attempt comes after the older reading')
      .toBeLessThan(at(`${bound}.summary`))
    expect(at(`${bound}.summary`), 'what is missing is named before the line it is missing from')
      .toBeLessThan(at(held![1]))
    // The cause is NOT repeated as the gap's: `whyNoReading` already accounts for all
    // three reads of the attempt that failed, and the stored line's own gaps were
    // explained when it was taken, by a refresh that is over. Two causes in one
    // sentence is c34's defect with the reads swapped — one explanation standing in
    // for something it never touched.
    expect(arm, 'the remembered gaps borrow the failed attempt\'s reasons')
      .not.toMatch(/Self\.gapClause\(/)
  })

  it('a remembered reading that was whole is left exactly as it was', () => {
    const { arm } = arms.filter(({ arm }) => /Self\.missingLine\(/.test(arm))[0]
    // `missingLine` answers nil for a complete reading, and the arm appends nothing —
    // the same contract `gapClause`'s empty string keeps for the fresh line. Without
    // the fallback every complete remembered reading ends in "nil".
    expect(arm, 'a complete remembered reading gets a sentence about nothing')
      .toMatch(/Self\.missingLine\(\w+\.gaps\)\.map \{ " \\\(\$0\)" \} \?\? ""/)
  })

  it('every surface that renders a stored reading discloses it, and none twice', () => {
    // ⚠️ The cross-surface census, and the shape of the find: one fact, two surfaces
    // (hazard 21). The panel row has rendered `missingLine(info.gaps)` live under the
    // age line since c33; the relay reply is the surface with no second line to put it
    // on, and it was the one that kept quiet.
    //
    // Per RENDERER, and the disclosure must name the binding the line came off —
    // counting calls per FILE is not this claim: the panel makes a second, unrelated
    // `gapClause` call in `refresh()`'s note, so a file-level total stays satisfied
    // with the row itself gone silent. (Found by mutating the row: the count survived.)
    for (const [name, src] of [['the gateway', gateway], ['the panel', panel]] as const) {
      const code = codeOnly(src, /summary/)
      const rendered = Array.from(code.matchAll(/\\\((\w+)\.summary\)|Text\((\w+)\.summary\)/g))
      expect(rendered.length, `${name} stopped rendering a reading — re-derive this`)
        .toBeGreaterThan(0)
      for (const m of rendered) {
        const bound = m[1] ?? m[2]
        expect(blockAt(code, m.index!),
          `${name} draws ${bound}.summary with no account of what is missing from it`)
          .toMatch(new RegExp(
            `(?:Self|FlipperGateway)\\.(?:missingLine\\(${bound}\\.gaps\\)|gapClause\\()`))
      }
    }
    // One wording, still: the frame lives in `missingLine` and nowhere else, so the arm
    // added this cycle cannot have written its own (the same count c33 pinned, re-run
    // here because a new caller is exactly when a second frame gets typed).
    expect(Array.from(`${gateway}${panel}`.matchAll(/Missing from this reading/g)).length,
      'the frame is written twice, or has gone').toBe(1)
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
    // The long branch says the wait was long enough — that much was always true.
    expect(timeoutTail).toMatch(/which was long enough/)
    // What it must NOT do is read the 🟢 as proof that something was listening.
    // This assertion used to demand exactly that sentence — see the next test for
    // why it was pinning the defect. Comments are stripped because the fix has to
    // quote the sentence it removed in order to explain itself.
    expect(codeOnly(backend, /which was long enough/), 'a heartbeat is not a listener')
      .not.toMatch(/had time to reply/)
  })

  it('a long BLE timeout blames the app lifecycle before it blames the hardware', () => {
    // 🟢 ON A PHONE IS A HEARTBEAT, NOT A LISTENER. Both loops live and die
    // together (startDeviceLoops/stopDeviceLoops), the app stops them when it
    // backgrounds, and presence lasts 60s — so there is a minute-wide window where
    // the phone reads online with nothing polling. The long branch used to read
    // that 🟢 as "the phone had time to reply, so the Flipper itself is the quiet
    // one" and send the user hunting a Bluetooth fault on a board nobody asked.
    const long = backend.slice(backend.indexOf('which was long enough'))
    const tail = long.slice(0, long.indexOf('`)'))
    expect(tail.length, 'the long BLE branch sliced empty').toBeGreaterThan(200)
    // The fixable cause comes first, by name and with an instruction.
    expect(tail).toMatch(/bleAppRemedy\(host\.name\)/)
    expect(tail.indexOf('If the app was already open'), 'app first, board second')
      .toBeLessThan(tail.indexOf('out of Bluetooth range'))
    // Range survives as a demoted possibility…
    expect(tail).toMatch(/out of Bluetooth range/)
    // …but the board's own Bluetooth setting does NOT. That is the one suggestion
    // whose screen also holds "Forget all paired devices", and it is unreachable
    // anyway: a radio switched off disconnects, `linked` goes false, and the next
    // beat drops flipper_ble — so this branch is not even the one that would run.
    // Losing the pairing to fix a busy app is a bad trade.
    expect(codeOnly(backend, /out of Bluetooth range/),
      'never send the user to Settings → Bluetooth on the board')
      .not.toMatch(/switched off in its own settings/)
    // And the demoted causes come with the tell that separates them.
    expect(tail).toMatch(/stops declaring the Flipper within a beat/)
  })

  it('the remedy is one shared sentence, not three that drift', () => {
    // Three sites state a silent phone: the long timeout, flipperInvoke's offline
    // arm, and flipper_status's offline note. Sharing the SENTENCE (not the whole
    // paragraph — each arm has its own frame, an `error` string vs an ok:true
    // `note`) is what keeps a fix in one of them from being a fix in only one.
    expect(backend).toMatch(/export function bleAppRemedy\(name: string\)/)
    expect(backend.match(/bleAppRemedy\(host\.name\)/g)!.length).toBe(3)
    const at = backend.indexOf('export function bleAppRemedy')
    const body = backend.slice(at, backend.indexOf('\n}', at))
    expect(body.length, 'bleAppRemedy sliced empty').toBeGreaterThan(80)
    // The three things the sentence has to carry: the condition (app open), the
    // reason it cannot be waited out, and what to do about it.
    expect(body).toMatch(/only while it is OPEN/)
    expect(body).toMatch(/cannot be woken on demand/)
    expect(body).toMatch(/Open the tiny app/)
    expect(body, 'name the phone — an account can hold several').toMatch(/\$\{name\}/)
  })

  it('the presence window is still wider than the beat that feeds it', () => {
    // The premise under all of the above, measured rather than assumed: if the
    // worker narrowed its window to the beat interval, or iOS beat twice per
    // window, the stale-🟢 gap would close and the sentence above would lead with
    // a cause that can no longer happen.
    const worker = read('worker/src/devices.ts')
    const windowS = Number(worker.match(/PRESENCE_WINDOW_S = (\d+)/)![1])
    expect(windowS).toBe(60)
    // Both places the backend WRITES that number down, checked against the number
    // itself — a doc figure copied by hand is the one that rots silently, and this
    // file already carried a "≤30s ago" that had been wrong since the window moved.
    expect(backend, "the helper's premise must track the worker")
      .toContain(`PRESENCE_WINDOW_S = ${windowS}`)
    expect(backend, "resolveFlipperHosts' doc must track the worker")
      .toContain(`PRESENCE_WINDOW_S (${windowS}s`)
    // Both loops cadence off Low Power Mode: the beat (45/30) and the poll (15/5).
    const beat = session.match(/isLowPowerModeEnabled \? 45 : 30/g) || []
    const poll = session.match(/isLowPowerModeEnabled \? 15 : 5/g) || []
    expect(beat.length, 'the 30s heartbeat cadence moved').toBe(1)
    expect(poll.length, 'the 5s relay poll cadence moved').toBe(1)
    // 🟢 outlives the last beat by a whole beat, in either power mode. Session.swift
    // says so itself — "stretch the beat but stay inside the 60s presence window".
    expect(windowS).toBeGreaterThan(45)
    expect(windowS - 30, 'the stale-🟢 gap the message now accounts for').toBe(30)
    // And the poll loop is stopped by the same call that stops the beat, on
    // .background — which is why the gap exists at all rather than being a
    // rounding artefact. Two facts, two files.
    const stop = swiftBody(session, 'func stopDeviceLoops()')
    expect(stop).toMatch(/heartbeatTask\?\.cancel\(\)/)
    expect(stop).toMatch(/relayTask\?\.cancel\(\)/)
    expect(tinyApp).toMatch(/stopDeviceLoops\(\)/)
    // No silent push and no on-demand wake, so a backgrounded app cannot be
    // reached inside any wait a flipper tool has.
    const bg = read('ios/Tiny/Sources/Background.swift')
    expect(bg).toMatch(/15 \* 60/)
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
 * 🐬🌙 The rail this feature was built for: 3am, nobody watching.
 *
 * A scheduled job is the one caller that CANNOT have a cable — the whole reason
 * the BLE rail exists is that the machine the Flipper was last plugged into is
 * asleep while the board sits in a bag next to the phone that is bonded to it.
 * Two things were wrong about that caller, and neither failed a test:
 *
 *   1. flipper_status took no job budget. It reads like a cheap lookup and is
 *      not — it posts a relay envelope and polls — so it sat for a flat 45s of
 *      the job's 50 and `agent.cancel()` fired before the job could report the
 *      unreachable it had just established. Every other hardware-waiting tool in
 *      that roster takes JOB_DEADLINE_S, including `makeNiclaStatusTool`, the
 *      same role on the other board; the roster even writes the rule down two
 *      lines above ("read-only, so no budget to clamp — both tools hit the
 *      registry and the event ring, never the board"). This was the exception.
 *   2. the job's system prompt said the Flipper is "reachable only while plugged
 *      into a machine running the tiny CLI". Chat learns the truth from data —
 *      the live device roster turns a `flipper_ble` heartbeat into a prompt line
 *      — but a job builds no roster, so that sentence is ALL it is told about the
 *      topology, and it outranks flipper_status's own schema, which has said "or
 *      which phone holds it over Bluetooth" since the day the rail shipped.
 */
describe('a scheduled job can reach the Flipper it was built to reach, and survive asking', () => {
  const jobRun = read('app/api/job-run/route.ts')
  // Scraped, not imported: importing the route drags in the whole Agent SDK. The
  // `!` is the point — a renamed constant throws here rather than reading as 0.
  const JOB_DEADLINE_S = Number(jobRun.match(/JOB_DEADLINE_S = (\d+)/)![1])

  it('every flipper tool that waits on hardware takes the job deadline', () => {
    for (const f of ['makeFlipperStatusTool', 'makeFlipperListenTool', 'makeFlipperFilesTool']) {
      expect(jobRun, `${f} polls a relay and must be clamped to the job`)
        .toMatch(new RegExp(`${f}\\(userId \\|\\| null, JOB_DEADLINE_S\\)`))
    }
    // And the un-budgeted form must be gone, not merely joined: a second call
    // without the deadline is how this drifts back.
    expect(codeOnly(jobRun, /makeFlipperStatusTool/), 'a flipper factory with no budget')
      .not.toMatch(/makeFlipper\w+Tool\(userId \|\| null\)/)
    // The deadline is real: it cancels the agent, so overrunning it loses the
    // answer entirely rather than returning it late.
    expect(jobRun).toMatch(/JOB_DEADLINE_S \* 1000/)
    expect(jobRun).toMatch(/agent\.cancel\(\)/)
  })

  it('the clamp is one function, and it bites on a real job', () => {
    // Interactively, nothing is taken away.
    expect(statusWait()).toBe(STATUS_WAIT_S)
    expect(statusWait(300)).toBe(STATUS_WAIT_S)
    // In a job it must actually shorten the wait, or passing the budget is theatre.
    expect(statusWait(JOB_DEADLINE_S)).toBeLessThan(STATUS_WAIT_S)
    // Same clamp for both rails — one expression, parameterised by the ceiling.
    // Two copies are two things to keep in step, and the forgotten one is the one
    // nobody is looking at.
    const clamps = codeOnly(backend, /clampToJob/).match(/Math\.max\(15, budgetS - 8\)/g) ?? []
    expect(clamps.length, 'the clamp arithmetic is written more than once').toBe(1)
    expect(statusWait(25)).toBe(filesWait(25))
    // …and a clamped status read CAN fall under the round trip, which is the case
    // the honest "I left early" message exists for.
    expect(statusWait(25)).toBeLessThan(BLE_ROUND_TRIP_S)
  })

  it('the short-timeout message names the caller\'s own ceiling, not a listing\'s', () => {
    // `flipperInvoke` is shared by three tools and used to end this sentence with
    // FILES_WAIT_S — a listing's number, printed to whoever timed out. Both
    // ceilings are 45 today, so it was right by coincidence; a coincidence is not
    // a construction, and the next edit to either constant is the bug report.
    const short = backend.slice(backend.indexOf('not long enough to conclude anything'))
    expect(short.slice(0, 500)).toMatch(/\$\{fullS\}s is available/)
    expect(codeOnly(backend, /fullS/), 'a shared sentence naming one tool\'s constant')
      .not.toMatch(/\$\{FILES_WAIT_S\}s is available/)
    // Each call site hands over its clamped wait and its OWN unclamped ceiling,
    // adjacent, so a swap is visible at the one place it could happen.
    const at = backend.indexOf('makeFlipperListenTool')
    const status = backend.slice(backend.indexOf('makeFlipperStatusTool'), at)
    const files = backend.slice(backend.indexOf('makeFlipperFilesTool'))
    expect(status).toMatch(/statusWait\(budgetS\),\n\s+STATUS_WAIT_S,/)
    expect(files).toMatch(/filesWait\(budgetS\),\n\s+FILES_WAIT_S,/)
    expect(status, 'the status tool must not name a listing ceiling').not.toMatch(/FILES_WAIT_S/)
    expect(files, 'the listing must not name a status ceiling').not.toMatch(/STATUS_WAIT_S/)
  })

  it('the job prompt names BOTH routes to the board, and what Bluetooth cannot do', () => {
    const note = jobRun.slice(
      jobRun.indexOf('const capabilityNote'), jobRun.indexOf('const agent = new Agent'))
    expect(note.length, 'the capability note was restructured').toBeGreaterThan(200)
    // codeOnly first: the comment above the line QUOTES the old wording to explain
    // why it was wrong, and both a `find` and a `not.toMatch` on the raw note
    // would read that confession as the crime.
    const lines = codeOnly(note, /flipper_status/).split('\n').filter(l => l.includes('flipper_status'))
    expect(lines.length, 'the flipper sentence must be one line to assert about').toBe(1)
    const line = lines[0]
    expect(line, 'the cable is not the only route, and a job runs when it is asleep')
      .not.toMatch(/reachable only while plugged/)
    expect(line).toMatch(/Bluetooth/)
    expect(line).toMatch(/phone/)
    // It must also say what BLE cannot do, or an unattended job will schedule a
    // capture the phone can never perform and read the refusal as a dead board.
    expect(line).toMatch(/needs the cable/)
    // "Unreachable" must still be licensed as an outcome — a job that treats it
    // as a failure retries a sleeping mac forever.
    expect(line).toMatch(/not a failure/)
  })

  it('the prompt and the tool schema agree, in the one context window that holds both', () => {
    // A system prompt outranks a tool description. When they disagree the model
    // believes the prompt, so a schema that has always been right is no defence.
    const desc = (makeFlipperStatusTool('u1') as any).toolSpec.description
    expect(desc).toMatch(/which phone holds it over Bluetooth/)
    const note = jobRun.slice(
      jobRun.indexOf('const capabilityNote'), jobRun.indexOf('const agent = new Agent'))
    expect(codeOnly(note, /flipper_status/)).toMatch(/Bluetooth/)
  })
})

/**
 * 🐬🗣️ The other caller nobody demos: a live voice call.
 *
 * The same shape as the job above — a surface that reaches this rail without a
 * cable, wrong in two ways at once, and neither failed a test:
 *
 *   1. UNREACHABLE. `lib/voice/tools.ts` declares flipper_status/files/listen to
 *      EVERY voice session including the browser, and `/api/voice/tool` mounts
 *      all three for execution — but the web bridge (`Chat.tsx runVoiceTool`)
 *      listed the SERVER tools by name and answered everything else "not
 *      available on this device". So a spoken "is my Flipper reachable?" got a
 *      sentence about the BROWSER, for a board that is not on any device a
 *      browser could have, while the same words typed into the same box worked.
 *      Both phones already enumerate what they run LOCALLY and forward the rest,
 *      and both wrote down why: "server-roster additions then work on STALE
 *      builds". Only the surface with no build to go stale got it wrong.
 *   2. UNTIMED. `/api/voice/tool` was absent from `ROUTE_DEADLINE_MS`, so
 *      `deadlineFor` returned `QUICK_MS` — 15s, below every hardware tool the
 *      bridge mounts, and below `BLE_ROUND_TRIP_S`. That is the exact trap
 *      lib/deadlines.ts exists to prevent ("a deadline SHORTER than the server's
 *      own budget doesn't fail fast, it LIES"): the client aborted with "the tool
 *      timed out" while the server was still legitimately waiting, replacing the
 *      one sentence that names the cause and the remedy. The route also handed
 *      its flipper tools no budget at all, alone among this rail's callers —
 *      job-run passes JOB_DEADLINE_S for the stated reason that a tool waiting
 *      longer than the turn "can only ever produce a timeout, never a usable
 *      answer or a real explanation", and voice is the tightest turn in the app.
 *
 * The pin at the scene was `tests/flipper-tools.test.ts`'s `roster wiring`: it
 * names lib/voice/tools.ts AND app/api/voice/tool/route.ts — declaration and
 * execution — so it read as a complete census while the third leg, the CLIENT
 * that has to forward the tool_call, went unchecked on all three surfaces.
 */
describe('a spoken question reaches the board, and is told what it waited', () => {
  const voiceRoute = read('app/api/voice/tool/route.ts')
  const chat = read('components/chat/Chat.tsx')
  const views = read('ios/Tiny/Sources/Views.swift')
  const mainActivity = read('android/app/src/main/java/technology/tiny/app/MainActivity.kt')
  // Scraped, not imported: the route drags in the whole tool stack. The `!` is
  // the point — a renamed constant throws here rather than reading as 0.
  const VOICE_TOOL_BUDGET_S = Number(voiceRoute.match(/VOICE_TOOL_BUDGET_S = (\d+)/)![1])

  /** The web bridge's dispatcher, brace-matched from its own declaration. */
  const webBridge = (() => {
    const at = chat.indexOf('const runVoiceTool')
    expect(at, 'runVoiceTool is gone — the web bridge was restructured').toBeGreaterThan(-1)
    const end = chat.indexOf('const startLiveCall', at)
    expect(end, 'the slicer has no end marker').toBeGreaterThan(at)
    const body = chat.slice(at, end)
    // A scraper that silently returns a fragment is a test that passes forever.
    expect(body, 'the web bridge sliced empty').toMatch(/case "remember"/)
    return body
  })()

  it('every flipper tool on the voice bridge takes the bridge budget', () => {
    for (const f of FLIPPER_FACTORIES) {
      expect(voiceRoute, `${f} polls a relay and must be clamped to the call`)
        .toMatch(new RegExp(`${f}\\(session\\.sub, VOICE_TOOL_BUDGET_S\\)`))
    }
    // The un-budgeted form must be GONE, not merely joined — a second call
    // without the budget is how this drifts back.
    expect(codeOnly(voiceRoute, /makeFlipperStatusTool/), 'a flipper factory with no budget')
      .not.toMatch(/makeFlipper\w+Tool\(session\.sub\)/)
    // Named, not a literal at the call site: the number has to be greppable from
    // the deadline that must sit above it.
    expect(voiceRoute).toMatch(/export const VOICE_TOOL_BUDGET_S/)
    expect(VOICE_TOOL_BUDGET_S).toBeGreaterThan(0)
  })

  it('the fall-through FORWARDS on all three clients — it never refuses locally', () => {
    // THE property, stated once for every surface: a tool this client does not
    // run locally is the SERVER's, not a missing feature. Enumerating the server
    // tools by name is what made the browser lie, so the assertion is about the
    // fall-through, not about any list of names.
    const webDefault = webBridge.slice(webBridge.lastIndexOf('default:'))
    expect(webDefault, 'the web bridge has no default arm').toMatch(/default:/)
    expect(webDefault, 'the fall-through must reach the bridge, not dead-end')
      .toMatch(/fetch\("\/api\/voice\/tool"/)
    // ...and the sentence that made a board's absence a fact about the browser
    // must not come back, in any arm.
    expect(codeOnly(webBridge, /voice\/tool/), 'a device-shaped refusal for a server tool')
      .not.toMatch(/not available on this device/)

    // iOS: the local device tools are cased, the default forwards.
    const iosBridge = swiftBody(views, 'private func runVoiceTool(')
    const iosDefault = iosBridge.slice(iosBridge.lastIndexOf('default:'))
    expect(iosDefault).toMatch(/\/api\/voice\/tool/)
    // Android: the local set is NAMED, and everything outside it forwards.
    expect(mainActivity).toMatch(/LOCAL_VOICE_TOOLS = setOf\(/)
    expect(mainActivity).toMatch(/name !in LOCAL_VOICE_TOOLS/)
    const localSet = mainActivity.slice(
      mainActivity.indexOf('LOCAL_VOICE_TOOLS = setOf('),
      mainActivity.indexOf(')', mainActivity.indexOf('LOCAL_VOICE_TOOLS = setOf(')))
    // A server tool inside the LOCAL set is the same defect wearing Android's
    // spelling: it would stop forwarding and answer from a stale build.
    for (const t of buildVoiceTools('tiny-android').map((x) => x.name)) {
      if (!/^(flipper|nicla)_/.test(t)) continue
      expect(localSet, `${t} runs on the SERVER — Android must forward it`).not.toContain(`"${t}"`)
    }
    expect(localSet, 'the Android set sliced empty').toMatch(/vibrate/)
  })

  it('the roster declares these tools to a browser, so the browser must reach them', () => {
    // The declaration is what makes the bridge load-bearing: the model plans
    // against this list, on a surface that cannot hold the board.
    const web = buildVoiceTools('web').map((t) => t.name)
    for (const t of FLIPPER_TOOLS) {
      expect(web, `${t} must be declared to a web voice session`).toContain(t)
      // Declared AND executable: the 404 arm of /api/voice/tool is for names
      // nobody declared, not for the roster's own.
      expect(voiceRoute, `${t} must be mounted where the bridge forwards it`)
        .toMatch(new RegExp(`make${t.split('_').map((s) => s[0].toUpperCase() + s.slice(1)).join('')}Tool`))
    }
  })

  it('no client on this rail aborts a wait the server is still allowed to be in', () => {
    const clientMs = deadlineFor('/api/voice/tool')
    const serverMs = VOICE_TOOL_BUDGET_S * 1000
    // The web number must come from the table, not the QUICK_MS default — that
    // fallback (15s) was the whole bug, and it is a silent one: an absent key
    // reads as a deliberate choice.
    expect(clientMs, 'the route fell back to QUICK_MS again').toBeGreaterThan(15_000)
    expect(exceedsServerBudget(clientMs, serverMs), `web ${clientMs}ms vs server ${serverMs}ms`)
      .toBe(false)

    // The phones' ceilings are MEASURED out of their own sources, not copied from
    // a sibling client — the tightest JSON ceiling each app applies, so whichever
    // helper the bridge uses is covered.
    const iosCaps = Array.from(read('ios/Tiny/Sources/Api.swift')
      .matchAll(/timeoutInterval = (\d+)/g)).map((m) => Number(m[1]))
    expect(iosCaps.length, 'Api.swift declares no timeoutInterval — this guard is vacuous')
      .toBeGreaterThan(0)
    const androidCaps = Array.from(read('android/app/src/main/java/technology/tiny/app/net/TinyApi.kt')
      .matchAll(/callTimeout\((\d+),/g)).map((m) => Number(m[1]))
    expect(androidCaps.length, 'TinyApi.kt declares no callTimeout — this guard is vacuous')
      .toBeGreaterThan(0)
    for (const [what, s] of [['iOS', Math.min(...iosCaps)], ['Android', Math.min(...androidCaps)]] as const) {
      expect(exceedsServerBudget(s * 1000, serverMs), `${what}'s tightest ceiling is ${s}s`)
        .toBe(false)
    }
  })

  it('a voice turn hears the honest short-wait sentence, not a client abort', () => {
    // The point of clamping at all. At this budget the wait falls UNDER the
    // Bluetooth round trip, which is the case flipperInvoke's honest branch
    // exists for: it refuses to diagnose the board, says how long it actually
    // waited, and names where the full ceiling is available. Written in c6,
    // unreachable from voice until the budget arrived.
    const wait = statusWait(VOICE_TOOL_BUDGET_S)
    expect(wait).toBeLessThan(STATUS_WAIT_S)
    expect(wait).toBeLessThan(BLE_ROUND_TRIP_S)
    expect(filesWait(VOICE_TOOL_BUDGET_S)).toBeLessThan(BLE_ROUND_TRIP_S)
    // And it must still fit inside the turn, or the clamp only moved the abort.
    expect(wait * 1000).toBeLessThan(deadlineFor('/api/voice/tool'))
    // A capture longer than the turn can host is declined in words rather than
    // started and abandoned — the host would go on holding the radio.
    expect(listenBudget(MAX_LISTEN_S, VOICE_TOOL_BUDGET_S)).toBeLessThan(MAX_LISTEN_S + 5)
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
    // FlipperScreenSheet would otherwise just read "Not streaming." about a mirror
    // the user left running, and the stop this app sent would look like the board's
    // fault. (Named exactly: for two cycles this comment said "the panel", and c18
    // found that the panel row was the only reader `lastError` had — behind that
    // very sheet. Writing the sentence is half the guarantee; see the c18 block.)
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
    //
    // Named token rather than the whole-file ratio: this body is four lines of code
    // under a paragraph explaining each of them, and c18 added another paragraph. The
    // ratio guard exists so an over-aggressive strip cannot make the `not.toMatch`
    // below vacuous, and `startScreenStream` surviving proves the same thing.
    expect(codeOnly(resume(), /startScreenStream/)).not.toMatch(/applicationState/)
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
    const texts = [...swiftBody(gateway, 'enum ResumeCause {').matchAll(/return "([^"]+)"/g)]
      .map(m => m[1])
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
    expect(codeOnly(middle(), /input\(key/)).not.toMatch(/\.release/)
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
    const fail = lostCode(/failAllPending/)
    expect(fail).toMatch(/failAllPending \{ FlipperError\.linkDropped\(sent: \$0\) \}/)
    // ⚠️ This line pinned `.notLinked` from c12 until c31, which is a large part of
    // why c31's defect lived that long: the suite certified the wrong error as the
    // intended one. `.notLinked` means "there was no link to write to, so nothing
    // was sent" — true for every OTHER raise of it, and false for exactly this one,
    // where the request had already gone out. See the c31 block at the end.
    expect(fail, 'a link that dropped mid-request reports itself as never having existed')
      .not.toMatch(/notLinked/)
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

/**
 * 🐬📶 c18 — the reason reaches whoever is actually looking.
 *
 * `FlipperGateway.lastError` had thirteen writers and exactly ONE reader: the row in
 * `FlipperBlePanel`. Every other Flipper surface is a SHEET, and a sheet covers that
 * row — so for three cycles the app wrote diagnoses to a place the person reading
 * them could not be.
 *
 * `resumeScreenStreamIfWanted` is the proof rather than the edge case. Its guard is
 * `streamWanted, foreground`, which is precisely "a screen sheet is open on this
 * phone right now" — so c10's sentence, written specifically so nobody would be left
 * with a bare "Not streaming." about a mirror they left running, was the one line in
 * the file that could never be read. Its own comment is how it hid: it said "the
 * panel just says 'Not streaming.'" while that string lives in FlipperScreenSheet,
 * one surface over. A comment naming the wrong surface, again (c15, c16, c17).
 *
 * Two more paths, both reachable rather than theoretical: c12's Bluetooth-off from
 * Control Centre with the mirror open, and the pairing sheet — which had no error
 * channel at all, so a phone with its radio off sat spinning "Looking…" for as long
 * as the user was willing to watch it, while the sentence explaining why sat behind
 * the sheet. c13's footer then sent them to the FLIPPER's Bluetooth setting, which is
 * the wrong device.
 *
 * So: one view renders the link's problem, every surface mounts it, and a claim about
 * the radio is gated on the flag the radio sets. Same person, same phone, same words
 * — the inverse of c17, where the two readers were genuinely different people and had
 * to be told different things.
 */
describe('a link problem is rendered where the user is looking, not where it was written', () => {
  const surface = (name: string) => swiftBody(panel, `struct ${name}: View {`)
  const resume = () => swiftBody(gateway, 'func resumeScreenStreamIfWanted(')
  const pairing = () => surface('FlipperPairingSheet')

  /**
   * Every `Flipper*: View` in the panel file, so a surface added later cannot
   * quietly skip the shared line.
   *
   * The two exemptions are named, not pattern-matched, and that is the point: a
   * fifth struct reds this list and forces a decision about it.
   */
  const SURFACES = () => {
    const all = Array.from(panel.matchAll(/^(?:private )?struct (Flipper\w+): View \{/gm), m => m[1])
    expect(all.length, 'no Flipper views found — the test is reading the wrong file')
      .toBeGreaterThan(3)
    // FlipperLinkProblem IS the shared line; FlipperKeyButton is one key, and a key
    // is not somewhere a link failure can be reported.
    const exempt = ['FlipperLinkProblem', 'FlipperKeyButton']
    expect(all.filter(n => exempt.includes(n)).sort(), 'an exempt view was renamed or removed')
      .toEqual([...exempt].sort())
    return all.filter(n => !exempt.includes(n))
  }

  it('the link problem has exactly one reader in the whole app, and it is a view', () => {
    // Counted, not spelled: the defect was not a missing `if let` somewhere, it was
    // thirteen writers pointed at one row. A second private read would be the same
    // bug growing back — a surface with its own opinion about when to show it.
    const reads = codeOnly(panel, /lastError/).match(/lastError/g) ?? []
    expect(reads.length, 'lastError is read in more than one place in this file').toBe(1)
    // The location, not the binding's name: this pin bans a second reader, and a
    // rename inside the shared view is not one.
    expect(codeOnly(surface('FlipperLinkProblem'), /lastError/), 'the reader is not the shared view')
      .toMatch(/flipper\.lastError/)
  })

  it('every surface that can be the one on screen mounts it', () => {
    for (const name of SURFACES()) {
      expect(codeOnly(surface(name), /FlipperLinkProblem/),
             `${name} can be open with the link broken and says nothing about it`)
        .toMatch(/FlipperLinkProblem\(\)/)
    }
  })

  it("the resume's diagnosis is read by the only surface that can be open when it runs", () => {
    // The two halves of one guarantee, in two files. c10 pinned the write; a write
    // whose reader is behind a modal is not a diagnosis, it is a log line.
    const guard = codeOnly(resume(), /guard/)
    expect(guard).toMatch(/guard[^\n]*\bstreamWanted\b/)
    expect(guard).toMatch(/guard[^\n]*\bforeground\b/)
    expect(codeOnly(resume(), /lastError/)).toMatch(/lastError = /)
    expect(codeOnly(surface('FlipperScreenSheet'), /FlipperLinkProblem/))
      .toMatch(/FlipperLinkProblem\(\)/)
  })

  it('the write site names the surface that reads it, not the row behind it', () => {
    // A prose pin, because a stale comment is exactly the class no behavioural test
    // can see — and this one was load-bearing: it is why three cycles of eyes read
    // past a sentence with no reader. Deliberately NOT codeOnly: the comment is the
    // subject here.
    const body = resume()
    expect(body, 'the resume no longer names the surface its sentence has to reach')
      .toMatch(/FlipperScreenSheet/)
    expect(body, 'the comment is back to naming the panel for a string in the sheet')
      .not.toMatch(/the panel just says/)
  })

  it('a spinner and the word "Looking" are claims about the radio, so they read its flag', () => {
    // With Bluetooth off, `startScan()` builds the central and `beginScanIfPossible()`
    // returns at its `.poweredOn` guard: nothing is scanning, and this row used to
    // insist otherwise. Every line that makes the claim is checked, not the one
    // spelling that was there when this was written.
    const body = codeOnly(pairing(), /Looking/)
    const claims = body.split('\n').filter(l => /Looking|ProgressView/.test(l))
    expect(claims.length, 'the pairing sheet no longer claims a scan — re-read this test')
      .toBeGreaterThan(1)
    for (const line of claims) {
      expect(line, `"${line.trim()}" claims the radio is scanning without asking it`)
        .toMatch(/flipper\.scanning/)
    }
  })

  it('and that flag is the radio\'s own, set past the power and foreground guards', () => {
    // What makes the UI claim mean anything, and it is a fact in a different file
    // from the view that leans on it. Set before the guard, `scanning` would be a
    // synonym for "a sheet is open" — which is what "Looking…" already was.
    const begin = codeOnly(swiftBody(gateway, 'private func beginScanIfPossible() {'), /scanning = true/)
    expect(begin).toMatch(/guard foreground[^\n]*poweredOn[^\n]*else \{ return \}/)
    expect(begin.indexOf('else { return }'), 'scanning is set before the guard that justifies it')
      .toBeLessThan(begin.indexOf('scanning = true'))
  })

  it('no surface keeps its own copy of a sentence the gateway owns', () => {
    // Hazard 21/22, one rail over: share the STORE, never the words. A copy in a
    // view drifts from the gateway's silently, and the drift shows up as two
    // different explanations of one radio.
    const sentences = Array.from(gateway.matchAll(/lastError = "([^"\\]{16,})"/g), m => m[1])
    expect(sentences.length, 'no gateway sentences found — the extraction is broken')
      .toBeGreaterThan(2)
    for (const s of sentences) {
      expect(panel, `a view hardcodes the gateway's "${s.slice(0, 32)}…"`).not.toContain(s)
    }
  })
})

/**
 * 🐬🔔 A capability implemented, advertised, and reachable by nobody.
 *
 * c22. `action:'alert'` has worked on the phone since P1 — `handleFlipperEnvelope`
 * has `case "alert", "beep", "find"`, `FlipperGateway.alert()` sends
 * `Gui.PlayAudiovisualAlert`, and the pairing sheet's own "Beep" button proves the
 * bond with it. The cabled CLI has an `alert` action. The design doc's envelope
 * contract lists it. And FIVE hand-written sentences promised the model a beep,
 * one of them inside the system prompt itself (`CAPABILITY_HINTS.flipper_ble`).
 * The tool roster held three tools, none of which could send it.
 *
 * So the user-visible failure had two shapes, and neither is a missing feature:
 * "make my Flipper beep" was refused by an agent whose own prompt says it can, or
 * answered "done" while the room stayed silent — and the person hunting a board
 * under the cushions is listening for a noise that was never requested.
 *
 * The same five copies each also offered to "read the SD card", which NO caller on
 * this rail can do and which is deliberate: `/ext/nfc` holds the user's real
 * passports, IDs and bank cards, so `flipper_files` lists names and sizes only.
 * Five copies of a claim is four opportunities to promise something.
 *
 * The guards here are therefore about the CLAIM, not the tool: one sentence,
 * shared, in which every capability names the tool that performs it.
 */
describe('what Bluetooth can do is claimed once, and every claim names its tool', () => {
  it('every capability the shared sentence promises names a real tool', () => {
    const claim = bleCanDo()
    const named = Array.from(claim.matchAll(/\((flipper_\w+)\)/g), (m) => m[1])
    expect(named.length, 'the shared claim names no tools at all').toBeGreaterThan(2)
    for (const n of named) {
      expect(FLIPPER_TOOLS, `the claim promises ${n}, which no factory produces`).toContain(n)
    }
    // The whole c22 shape in one assertion: a capability appended to this sentence
    // with no `(tool)` behind it is a promise nothing can keep.
    expect(claim.trim().endsWith(')'), 'a capability was appended with no tool behind it').toBe(true)
    // And the beep specifically, since it is what four of the five copies promised
    // while the roster had no way to send one.
    expect(named).toContain('flipper_find')
  })

  it('the list is SHARED, never re-typed at a claim site', () => {
    // Hazard 21/22: share the FACT, keep each frame. Derived from the function, so
    // rewording bleCanDo cannot leave a stale literal passing — the fragment being
    // searched for changes with it.
    const fragment = bleCanDo().split(', ')[1]
    expect(fragment.length, 'the shared claim lost its middle clause').toBeGreaterThan(20)
    // ONE literal copy in the whole rail: the function body. Counted rather than
    // forbidden, because the file that defines the sentence necessarily contains
    // it — and a count is what catches a claim site typing it out again.
    for (const [f, allowed] of [['lib/chat/tools/flipper.ts', 1], ['app/api/job-run/route.ts', 0]] as const) {
      const text = read(f)
      expect(text, `${f} must interpolate bleCanDo()`).toMatch(/\$\{bleCanDo\(\)\}/)
      expect(text.split(fragment).length - 1, `${f} keeps its own copy of the shared claim`)
        .toBe(allowed)
    }
    // Three sites inside flipper.ts alone (the cable-only refusal, the sleeping
    // machine's third arm, flipper_status's BLE note) — each a different frame
    // around the same list.
    const uses = (codeOnly(backend, /bleCanDo/).match(/\$\{bleCanDo\(\)\}/g) || []).length
    expect(uses, 'a claim site stopped sharing the list').toBeGreaterThanOrEqual(3)
  })

  it('nobody on this rail offers to read what is on the SD card', () => {
    // ⚠️ /ext/nfc, /ext/lfrfid, /ext/ibutton, /ext/u2f are the user's passports,
    // IDs and bank cards. A listing is a fair answer to "what have I saved"; the
    // contents are not, and no tool here returns them — so no sentence may offer.
    //
    // ⚠️ c23: the PHONE was missing from this list, and it is the surface whose
    // word the agent trusts most — its sentences arrive as the tool RESULT. Both
    // of its capability lists offered exactly what the three files below had just
    // stopped offering. A hand-written list of FILES in the guard is the same
    // defect as a hand-written list of NAMES (hazard 28a): the copy that drifts
    // is the one nobody added.
    for (const f of ['lib/chat/tools/flipper.ts', 'app/api/job-run/route.ts', 'lib/chat/prompt.ts',
      'ios/Tiny/Sources/Session.swift']) {
      const code = codeOnly(read(f), /flipper/)
      expect(code, `${f} offers to read the SD card, which no tool on this rail can do`)
        .not.toMatch(/read (the|its) SD card/i)
    }
  })

  it('the system prompt names a tool for every capability it promises', () => {
    // ⚠️ prompt.ts deliberately does NOT import bleCanDo — buildSoulPrompt and its
    // tests import that module directly and it must stay clear of the tool stack.
    // So the hint keeps its own words, and this is the pin that keeps them true.
    const hint = capabilitySummary(['flipper_ble'])
    expect(hint).toMatch(/Bluetooth/)
    expect(hint, 'the prompt promises a beep with no tool behind it').toMatch(/flipper_find/)
    for (const n of Array.from(hint.matchAll(/flipper_\w+/g), (m) => m[0])) {
      expect(FLIPPER_TOOLS, `the prompt names ${n}, which no factory produces`).toContain(n)
    }
    // ⚠️ tests/prompt.test.ts splits capabilitySummary on '; ' and counts the
    // segments against DEVICE_LABELS — a separator inside ONE hint breaks it.
    expect(hint.split('; ').length, "a '; ' inside one hint would split the summary").toBe(1)
  })

  it('every action the backend sends has a case in the phone\'s switch', () => {
    // The relay poll CLAIMS an envelope: an action the phone has no case for is
    // destroyed, not retried, and the tool waits out its full ceiling for a reply
    // that will never come. The type signature carries no quotes, so it is not
    // mistaken for a sent action here.
    // Array.from over the Set, not a for-of: this tsconfig's target makes a bare
    // Set iteration a TS2802, and `npm test` strips types — a red tsc that only
    // shows up in someone else's build is not a cost this file gets to add.
    const actions = Array.from(new Set(Array.from(
      codeOnly(backend, /action: 'status'/).matchAll(/\{ action: '(\w+)'/g), (m) => m[1])))
    expect(actions.length, 'no ble actions found — the extraction is broken').toBeGreaterThan(2)
    const sw = swiftBody(session, 'nonisolated static func handleFlipperEnvelope(')
    for (const a of actions) {
      expect(sw, `the backend sends action "${a}" and the phone has no case for it`)
        .toMatch(new RegExp(`case "${a}"`))
    }
  })

  it('every ceiling on this rail outlasts a Bluetooth round trip', () => {
    // The floor for anything that polls this relay. Below BLE_ROUND_TRIP_S,
    // flipperInvoke's honest short-wait branch fires on EVERY call and sends the
    // caller to a typed chat for an answer it could have had here — a tool that
    // can never answer over the route it was written for. ALERT_WAIT_S looked like
    // it could be small (the RPC itself allows 10s); the poll interval is what
    // binds. ⚠️ This is the CEILING. The wait is `clampToJob(ceiling, budget)`, and
    // a rail can still clamp under the round trip — see the reachability census in
    // 'only a spoken turn can reach the branch that tells you to go elsewhere'.
    for (const [name, s] of [
      ['STATUS_WAIT_S', STATUS_WAIT_S], ['FILES_WAIT_S', FILES_WAIT_S], ['ALERT_WAIT_S', ALERT_WAIT_S],
    ] as const) {
      expect(s, `${name} cannot conclude anything over Bluetooth`).toBeGreaterThanOrEqual(BLE_ROUND_TRIP_S)
    }
  })
})

/**
 * 🐬🗣️ Copies six and seven — the ones the DEVICE says about itself.
 *
 * c22 collapsed five hand-written "what Bluetooth can do" sentences into one
 * `bleCanDo()` whose every capability names its tool, and pinned that nobody on
 * the rail offers to read the SD card. It counted the rail as three TypeScript
 * files. The phone had two more, and they are the ones that matter most: they are
 * not prompt text the agent might weigh against a tool schema, they are the tool
 * RESULT, quoted into the transcript as what the device itself just said.
 *
 *   • the capture refusal ended "What this phone CAN do over Bluetooth: status,
 *     browse and read the SD card, checksums, and make it beep";
 *   • the unknown-action arm ended "this phone can do: status, files, read, md5,
 *     alert".
 *
 * Nothing in the backend has ever sent `read` or `md5` — c22 measured zero senders
 * and that is deliberate, because `/ext/nfc` holds the user's real passports, IDs
 * and bank cards, so `flipper_files` returns names and sizes only. So the device
 * was offering the agent two things it has no tool for, one of them the contents
 * of the credential folders, in the two sentences that only ever print when
 * something upstream has ALREADY failed and nothing is left to correct them.
 *
 * The fix is c21's pattern across a language boundary: share the FACT (one
 * `flipperAgentTools` constant), keep each frame, and pin the phone's list to the
 * backend's by set equality — Swift cannot import `bleCanDo()`, so the test is the
 * only thing that can hold the two together.
 */
describe('the phone claims exactly what the backend can ask it for', () => {
  /** Every reply the envelope handler returns as a literal string. */
  const replies = (): string[] => {
    const body = swiftBody(session, 'static func handleFlipperEnvelope(')
    // Raw source, interpolations included: `\(Self.flipperAgentTools)` has to
    // survive into the match, because sharing the constant is the thing under test.
    const all = Array.from(body.matchAll(/\["result": "((?:[^"\\]|\\.)*)"\]/g), (m) => m[1])
    expect(all.length, 'no reply strings found — the extraction is broken').toBeGreaterThan(4)
    return all
  }

  /** The replies that tell the agent what it can ask for. */
  const claims = (): string[] => {
    const found = replies().filter((r) => /can (ask|do)/i.test(r))
    expect(found.length, 'no capability sentence found on the phone — the filter is stale')
      .toBeGreaterThanOrEqual(2)
    return found
  }

  it("the phone's list and the backend's name the same tools, in both directions", () => {
    const decl = /flipperAgentTools = "([^"]+)"/.exec(session)
    expect(decl, 'the phone has no shared capability list').not.toBeNull()
    const onPhone = Array.from(decl![1].matchAll(/flipper_\w+/g), (m) => m[0]).sort()
    const inBackend = Array.from(bleCanDo().matchAll(/\((flipper_\w+)\)/g), (m) => m[1]).sort()
    expect(onPhone.length, 'the phone names no tools at all').toBeGreaterThan(2)
    // Set equality, so it fails from EITHER side: a tool added to bleCanDo() and
    // not to the phone is a promise the device will deny, and one added to the
    // phone and not to the backend is a promise no tool can keep.
    expect(onPhone, "the phone and the backend disagree about what Bluetooth can do").toEqual(inBackend)
    for (const n of onPhone) {
      expect(FLIPPER_TOOLS, `the phone names ${n}, which no factory produces`).toContain(n)
    }
  })

  it('every capability sentence on the phone shares that list instead of retyping it', () => {
    for (const c of claims()) {
      expect(c, `a capability sentence types its own list: "${c.slice(-72)}"`)
        .toContain('\\(Self.flipperAgentTools)')
      // A literal `flipper_x` in one of these sentences is a sixth copy being
      // born. The interpolation itself contains no underscore, so this is the
      // difference between naming the fact and naming a tool.
      expect(c, `a capability sentence names a tool literally: "${c.slice(-72)}"`)
        .not.toMatch(/flipper_\w+/)
    }
  })

  it('no capability sentence offers the SD card contents, or a checksum of them', () => {
    // ⚠️ The point of the whole guard: `read` and `md5` exist as cases on this
    // phone and NO tool sends either, by design. An offer the agent cannot take up
    // is bad; this particular one points at the folder holding the user's cards.
    for (const c of claims()) {
      expect(c, `a capability sentence offers file contents: "${c.slice(-72)}"`)
        .not.toMatch(/read (the|its) SD card|checksums?|\bmd5\b/i)
    }
  })

  it('an action this build does not know blames the BUILD, and names the fix', () => {
    // Only the backend composes these envelopes, and it sends only actions it has
    // a tool for — so an unknown action is version skew, every time. Hazard 25(a):
    // the list on the side that ages is the one that lies, and here the phone is
    // that side. Hazard 26(d): a refusal has to name something the reader can do.
    // ⚠️ codeOnly, not the raw body: the comment ABOVE this arm explains the skew
    // in the same words the reply uses, so a raw slice passes on the explanation
    // alone. The c23 battery caught exactly that — deleting the diagnosis from the
    // sentence left this test green, because it was reading the paragraph about it.
    const body = codeOnly(swiftBody(session, 'static func handleFlipperEnvelope('), /default:/)
    const at = body.indexOf('default:')
    expect(at, 'the envelope handler has no default arm').toBeGreaterThan(0)
    const arm = body.slice(at)
    expect(arm, 'the unknown-action reply must name the version skew, not just relist')
      .toMatch(/older than the server/i)
    expect(arm, 'a refusal must name an action its reader can take').toMatch(/updat\w+ the tiny app/i)
  })
})

/**
 * c24 — three sentences for one fact, and the one on screen un-pairs your Flipper.
 *
 * "Why can nothing reach the board right now" had three answers on this phone,
 * worded three different ways: the panel row (`FlipperBlePanel.paired`'s unlinked
 * branch), the relay guard in `handleFlipperEnvelope`, and `statusLine()`. The one
 * the user actually reads said *"bring the Flipper nearby and make sure Bluetooth
 * is on in its settings"* — the BOARD's Settings → Bluetooth, the screen that holds
 * "Forget all paired devices" — and `paired` renders ONLY when `unit != nil`, so
 * that advice was given exactly and only in the state where there was a pairing to
 * lose. The pairing SHEET gives the same advice legitimately, because there no bond
 * exists yet: it is right before a bond and harmful after one. `lib/chat/tools/
 * flipper.ts` had this exact remedy scrubbed out of it in c21 for this exact
 * reason, and a test pins it dead there — while the phone, whose wording outranks
 * the backend's (it arrives as the tool RESULT, and on the panel it is under a
 * thumb), went on giving it.
 *
 * The second half is what none of the three could say. `centralManagerDidUpdateState`
 * already diagnoses `.poweredOff` and `.unauthorized` — into `lastError`, whose only
 * readers are this phone's own panel and sheets. A phone in a pocket and a browser
 * somewhere else is the entire point of this rail, so the reader who most needed to
 * hear "it's your PHONE's Bluetooth" was the one reader who could never be told: a
 * switch flipped on the phone came back as a story about the board. Now one
 * function answers all three in the words of whoever asked — off the LIVE radio,
 * never the stored `lastError`, which proves only that its writer once ran.
 */
describe('c24 — one sentence for an unreachable board, and it stops sending people to un-pair it', () => {
  const outageBody = () => swiftBody(gateway, 'static func outage(')
  const radioBody = () => swiftBody(gateway, 'private static func radioProblem(')
  const abandonedBody = () => swiftBody(gateway, 'private static func abandoned(')
  const pairedRow = () => swiftBody(panel, '@ViewBuilder private var paired')
  const armOf = (label: string) => codeOnly(swiftCase(radioBody(), label), /return "/)
  const strings = (src: string) => Array.from(src.matchAll(/return "((?:[^"\\]|\\.)*)"/g), (m) => m[1])

  /** The reader kinds, out of the enum — never a list typed into this test. */
  const AUDIENCES = Array.from(
    swiftBody(gateway, 'enum ReadAudience {').matchAll(/^\s*case (\w+)$/gm), (m) => `.${m[1]}`)

  /** The radio states `radioProblem` is willing to blame, out of its own arms. */
  const faults = () => Array.from(new Set(
    Array.from(radioBody().matchAll(/case \((\.\w+), \.\w+\):/g), (m) => m[1])))

  /** The states the phone diagnoses on its OWN screen, out of the observer. */
  const diagnosed = () => {
    const arms = stateArms().filter((a) => /lastError = "/.test(codeOnly(a.body, /\S/)))
    expect(arms.length, 'no state arm writes a diagnosis any more — this filter is stale')
      .toBeGreaterThan(1)
    return arms.map((a) => a.label.replace(/^case\s+/, ''))
  }

  it('every surface that explains an unreachable board says it through one function', () => {
    // Three copies of one fact is how they drifted; two of them were wrong in
    // different directions. The panel row, the relay guard, and `statusLine()`.
    expect(codeOnly(pairedRow(), /outageLine/), 'the panel row writes its own sentence')
      .toMatch(/Text\(flipper\.outageLine\(for: \.panelSheet\)\)/)

    const handler = codeOnly(swiftBody(session, 'static func handleFlipperEnvelope('), /outageLine/)
    expect(handler, 'the relay guard writes its own sentence')
      .toMatch(/fg\.outageLine\(for: \.relayReply\)/)
    expect(handler, 'the relay guard still holds a hand-written copy')
      .not.toMatch(/paired with this phone but not connected/)

    // Unreachable today — `handleFlipperEnvelope` guards `fg.linked` before it
    // dispatches and is this method's only caller — and kept anyway. An arm that
    // answers the same question in its own words is how this divergence began.
    const status = codeOnly(swiftBody(gateway, 'func statusLine() async'), /outageLine/)
    expect(status, "statusLine's unlinked arm writes its own sentence")
      .toMatch(/outageLine\(for: \.relayReply\)/)
    expect(status, 'statusLine still holds a hand-written copy')
      .not.toMatch(/No Flipper is paired|paired but not connected/)
  })

  it('the row that appears only when a bond EXISTS no longer sends the user to un-pair it', () => {
    // `paired` is reached only when `flipper.unit != nil`. Every sentence it can
    // render — its own, and the shared ones it delegates to — is therefore read
    // with a pairing on the line, and the board's Settings → Bluetooth screen is
    // one row above "Forget all paired devices".
    const surfaces = [
      codeOnly(pairedRow(), /outageLine/),
      ...AUDIENCES.filter((a) => a === '.panelSheet').flatMap(() => [
        codeOnly(swiftCase(outageBody(), '.panelSheet'), /return "/),
        ...faults().map((f) => armOf(`(${f}, .panelSheet)`)),
      ]),
    ]
    for (const s of surfaces) {
      for (const banned of [/in its settings/i, /on the Flipper itself/i, /Settings → Bluetooth/]) {
        expect(s, `a sentence read with a bond on the line points at the screen that destroys it: ${banned}`)
          .not.toMatch(banned)
      }
    }
  })

  it('and the pairing sheet, where there is no bond to lose, still says exactly that', () => {
    // The control that keeps the fix a fix and not a word ban: the same advice is
    // correct here, and this is the one place it belongs. The sheet is reachable
    // only from the `unit == nil` branch, which is precisely why it is safe there.
    expect(swiftBody(panel, 'struct FlipperPairingSheet: View'),
      'the legitimate copy went with the harmful one — the fix must be scoped to the state')
      .toMatch(/Bluetooth has to be enabled on the Flipper itself \(Settings → Bluetooth\)/)
    expect(codeOnly(swiftBody(panel, 'var body: some View'), /showPairing/))
      .toMatch(/Button\("Find my Flipper"\) \{ showPairing = true \}/)
  })

  it('every radio fault the phone diagnoses can also be said to whoever asked remotely', () => {
    // ⚠️ The find, as a derivation rather than a list: the observer already writes a
    // diagnosis for these states, into `lastError`, whose only readers are on this
    // phone's screen. The relay asker is by definition not looking at it. Add a
    // third diagnosed state tomorrow and this reds until it can be said out loud.
    const sayable = faults()
    for (const state of diagnosed()) {
      expect(sayable, `${state} is diagnosed on the phone's screen and nowhere else`)
        .toContain(state)
    }
    // And in BOTH sets of words — a fault worded for one reader only is the same
    // defect one audience over, which is why the audience has no default.
    expect(AUDIENCES.length, 'the audience enum lost its cases').toBeGreaterThan(1)
    for (const state of sayable) {
      for (const aud of AUDIENCES) expect(armOf(`(${state}, ${aud})`)).toMatch(/return "/)
    }
  })

  it('a radio fault names the PHONE, and never asks anyone to move the board', () => {
    for (const state of faults()) {
      for (const aud of AUDIENCES) {
        const arm = armOf(`(${state}, ${aud})`)
        expect(arm, `${state}/${aud} does not say whose radio this is`).toMatch(/phone/i)
        // Advice that cannot work: with this phone's radio down, carrying the board
        // across the room changes nothing, and it hides the one-tap fix.
        expect(arm, `${state}/${aud} blames distance for a radio that is off`)
          .not.toMatch(/nearby|out of range|in range/i)
      }
    }
  })

  it('each relay refusal names something its reader can actually do about it', () => {
    // A refusal that names no action reads as a dead end (hazard 26(d)). Turn the
    // radio on, grant the permission, or fall back to the cable — one of the three.
    for (const state of faults()) {
      expect(armOf(`(${state}, .relayReply)`), `${state} refuses without a remedy`)
        .toMatch(/ask again|Settings →|Control Centre|cable/i)
    }
  })

  it('no two of these sentences are the same sentence', () => {
    // A parameter threaded through to identical strings is decoration — the same
    // check the ResumeCause pin makes, at the scale of six arms plus three.
    const all = [...strings(outageBody()), ...strings(radioBody()), ...strings(abandonedBody())]
    expect(all.length, 'the shared sentence no longer resolves to per-reader text')
      .toBeGreaterThanOrEqual(10)
    expect(new Set(all).size, 'two arms say the same thing').toBe(all.length)
  })

  it('the live radio is observable, and every arm publishes it', () => {
    // A sentence on a screen that depends on a value needs that value observable —
    // `central?.state` behind a plain `private var` cannot move the row. And the
    // assignment sits BEFORE the switch on purpose: `.poweredOn` reports no error,
    // so an arm-by-arm write leaves the panel accusing a radio the user just
    // switched back on, with `connectIfPossible()` sitting in a connect that may
    // never call back.
    expect(gateway, 'the radio is not observable, so no sentence about it can update')
      .toMatch(/@Published private\(set\) var radio: CBManagerState/)
    const observer = swiftBody(gateway, 'func centralManagerDidUpdateState(')
    expect(codeOnly(observer.split(/\n\s*(?=case |default:)/)[0], /radio = /),
      'the radio is not published before the switch')
      .toMatch(/radio = central\.state/)
    for (const arm of stateArms()) {
      expect(codeOnly(arm.body, /\S/), `${arm.label} publishes the radio itself — .poweredOn would not`)
        .not.toMatch(/radio = /)
    }
  })

  it('the sentence is built from the live radio, never from the stored diagnosis', () => {
    // `lastError` survives until `didConnect` clears it: Bluetooth back on but not
    // yet reconnected still reads "Bluetooth is off". It describes the past.
    // ⚠️ The wrapper is in this list, not just the pure pair. A `lastError ??`
    // in FRONT of the call leaves the exact-body match below still matching —
    // measured, as a surviving mutant — so the absence has to be asserted over
    // every hop the sentence travels, the wrapper included.
    const wrapper = codeOnly(swiftBody(gateway, 'func outageLine(for audience:'), /outage/)
    const both = [codeOnly(outageBody(), /radioProblem/), codeOnly(radioBody(), /return "/),
                  wrapper].join('\n')
    expect(both, 'the shared sentence reads a stored diagnosis').not.toMatch(/lastError/)
    expect(wrapper)
      .toMatch(/^\s*Self\.outage\(radio: radio, unit: unit\?\.name, dialling: wanted, for: audience\)\s*$/)
    // The transients are not verdicts: bluetoothd restarts for half a second, and
    // `.unknown` is simply the state before the first callback. Blaming the user's
    // radio over either is a false diagnosis where one costs a pairing.
    for (const t of ['.resetting', '.unknown']) {
      expect(faults(), `${t} is a transient, not a verdict`).not.toContain(t)
    }
  })

  it('the audience has no default, so no reader can inherit the wrong words', () => {
    // Same reason as `tooBig(_:size:limit:for:)`, whose own fix established it.
    //
    // ⚠️ This enumerated THREE FUNCTIONS BY HAND, and `abandoned(_:for:)` would have
    // passed it by not being in the list — the c22→c23 shape a third time (a guard
    // whose hand-written roster is exactly what drifts). Derived now: every signature
    // in the file that takes a `ReadAudience` at all, with the known names kept as
    // the expected contract so a rename reds it from the other side too.
    const audienceSigs = gatewaySignatures().filter((s) => s.includes('ReadAudience'))
    const names = audienceSigs.map((s) => /func (\w+)/.exec(s)![1])
    for (const known of ['outage', 'radioProblem', 'outageLine', 'abandoned', 'tooBig', 'alertSent',
                         'afterUnconfirmed', 'actionFailed']) {
      expect(names, `${known} no longer takes a reader — the derivation is reading the wrong file`)
        .toContain(known)
    }
    for (const s of audienceSigs) {
      expect(s, `${/func (\w+)/.exec(s)![1]} defaults its audience`).not.toMatch(/ReadAudience\s*=/)
    }
  })

  it('with the radio fine, the board is still the story — and the remedy is a real button', () => {
    const boardRelay = codeOnly(swiftCase(outageBody(), '.relayReply'), /return "/)
    // The old wording's actual error: "its Bluetooth is off" blamed the board for a
    // switch on the phone. Out of range or powered off is the honest pair.
    expect(boardRelay, "the board arm blames the board's radio again").not.toMatch(/its Bluetooth/i)
    expect(boardRelay).toMatch(/out of range/i)
    const boardPanel = codeOnly(swiftCase(outageBody(), '.panelSheet'), /return "/)
    expect(boardPanel, 'the normal case is a board in a bag — say what to do about it')
      .toMatch(/nearby/i)
    // It names a button, so the button has to be on that row.
    const named = /tap (\w+)/.exec(boardPanel)
    expect(named, 'the panel arm names no action').not.toBeNull()
    expect(codeOnly(pairedRow(), /Button/), `the row names a "${named?.[1]}" button it does not have`)
      .toMatch(new RegExp(`Button\\("${named![1]}"\\)`))
  })
})

describe('c25 — a board nobody is dialling is not a board that comes back', () => {
  const outageBody = () => swiftBody(gateway, 'static func outage(')
  const abandonedBody = () => swiftBody(gateway, 'private static func abandoned(')
  const pairedRow = () => swiftBody(panel, '@ViewBuilder private var paired')
  const arm = (body: string, label: string) => codeOnly(swiftCase(body, label), /return "/)

  /** The reader kinds, out of the enum — never a list typed into this test. */
  const AUDIENCES = Array.from(
    swiftBody(gateway, 'enum ReadAudience {').matchAll(/^\s*case (\w+)$/gm), (m) => `.${m[1]}`)

  /** Every string literal in the gateway's CODE, comments stripped. */
  const literals = () => Array.from(
    codeOnly(gateway, /tap Reconnect/).matchAll(/"((?:[^"\\]|\\.)*)"/g), (m) => m[1])

  it('only a pairing that failed can produce one, and nothing re-dials it', () => {
    // The premise the new sentence rests on, read out of the code rather than
    // assumed — every clause of it, because the sentence says "deliberately", and a
    // third `stop()` caller for some unrelated reason would make that a lie.
    const code = codeOnly(gateway, /func stop\(\)/)
    const clears = code.split('\n')
      .filter((l) => /wanted = false/.test(l) && !/var wanted/.test(l))
    expect(clears.length, 'more than one thing clears `wanted` — or nothing does').toBe(1)
    expect(codeOnly(swiftBody(gateway, 'func stop()'), /wanted/),
      '`wanted` is cleared somewhere other than the deliberate stop').toMatch(/wanted = false/)

    // "nothing re-dials" is the whole claim. It is this guard.
    expect(codeOnly(swiftBody(gateway, 'private func scheduleReconnect()'), /guard/),
      'the backoff no longer stops at `wanted`, so the sentence is wrong')
      .toMatch(/guard wanted else \{ return \}/)

    const calls = code.split('\n')
      .filter((l) => /(?:^|[^\w.])stop\(\)/.test(l) && !/func stop\(\)/.test(l))
    expect(calls.length, 'a new `stop()` caller can strand a board for a reason this sentence '
      + 'does not name — say what it is, then widen the sentence').toBe(2)
    // Caller one: the user unlinking. It clears `unit` too, so `outage` takes its
    // no-board arm and this sentence is unreachable from here.
    const forget = codeOnly(swiftBody(gateway, 'func forget()'), /stop\(\)/)
    expect(forget).toMatch(/stop\(\)/)
    expect(forget, 'forget() leaves the board remembered — it would read as a failed pairing')
      .toMatch(/unit = nil/)
    // Caller two: the TX subscription failing, which IS a pairing that did not hold.
    const subscribe = codeOnly(
      swiftBody(gateway, 'func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor'),
      /stop\(\)/)
    expect(subscribe).toMatch(/stop\(\)/)
    expect(subscribe, 'the subscribe failure no longer diagnoses itself')
      .toMatch(/lastError = Self\.subscribeFailureText\(error\)/)
  })

  it('the one state where waiting cannot work says so, to both readers', () => {
    // ⚠️ The find. `lastError` explains a failed bond to this phone's own screen; the
    // relay reader — a browser somewhere else, which is the entire point of this rail
    // — was handed the ordinary out-of-range sentence, promising a backoff that
    // `stop()` had switched off. Told to wait, for something no wait can fix.
    expect(AUDIENCES.length, 'the audience enum lost its cases').toBeGreaterThan(1)
    // The dispatch itself, and its polarity: a `abandoned(…)` nothing calls is a
    // sentence written where it cannot be read, which is the class this fixes.
    const body = codeOnly(outageBody(), /abandoned/)
    expect(body, 'nothing routes the not-dialling state to its own words')
      .toMatch(/^\s*if !dialling \{ return abandoned\(board, for: audience\) \}\s*$/m)
    // AFTER the radio check, deliberately: with this phone's Bluetooth off nobody can
    // re-pair anything either, and that fault has the one-tap fix.
    expect(body.indexOf('radioProblem('), 'the pairing story now hides the radio story')
      .toBeLessThan(body.indexOf('if !dialling'))
    for (const aud of AUDIENCES) {
      const a = arm(abandonedBody(), aud)
      expect(a, `${aud} has no sentence for a board that is no longer being dialled`)
        .toMatch(/return "/)
      // The promise, in the state where it cannot come true.
      expect(a, `${aud} still promises the board returns by itself`).not.toMatch(/by itself/)
      // And not the ordinary cause either: the board is in range and switched on.
      expect(a, `${aud} blames range for a pairing that failed`)
        .not.toMatch(/out of range|nearby|in range/i)
      // A remedy that is a person, because that is the only remedy there is.
      expect(a, `${aud} names no way out`).toMatch(/6-digit/)
    }
  })

  it('and the ordinary case KEEPS the promise it can keep', () => {
    // The positive control that makes the fix a fix rather than a word ban — c24's
    // own lesson, one state over. A board in a bag really does come back by itself,
    // and saying so is why nobody has to touch anything.
    for (const aud of AUDIENCES) {
      expect(arm(outageBody(), aud), `${aud} lost the promise that is true when it is dialling`)
        .toMatch(/by itself/)
    }
  })

  it('the sentence is built from the live flag, and no caller can inherit the promise', () => {
    // Same rule as `radio`, for the same reason: a row that depends on a value needs
    // that value to publish, or the panel goes on saying "no longer retrying" after
    // Reconnect has started retrying.
    expect(gateway, '`wanted` is not observable, so no sentence about it can update')
      .toMatch(/@Published private var wanted = false/)
    const wrapper = codeOnly(swiftBody(gateway, 'func outageLine(for audience:'), /outage/)
    expect(wrapper, 'the wrapper does not pass the live flag').toMatch(/dialling: wanted/)
    // No default and no literal: a caller that forgot it, or hard-coded `true`, is
    // exactly the bug being fixed — silently, and only in the failure state.
    const sig = gatewaySignatures().find((s) => s.startsWith('func outage('))
    expect(sig, 'outage() is gone').toBeDefined()
    expect(sig, 'outage defaults `dialling`, so a caller can inherit the promise')
      .not.toMatch(/dialling: Bool\s*=/)
    expect(codeOnly(gateway, /dialling: wanted/), 'a caller hard-codes the flag')
      .not.toMatch(/dialling: (?:true|false)/)
  })

  it('every action any of these sentences names is a button that exists', () => {
    // ⚠️ `subscribeFailureText` said "Tap Pair again" and there is no Pair button —
    // not on the row this renders under (Reconnect / Unlink), not in the pairing
    // sheet, where the control is the board's own name in a list. c24 checked this
    // for ONE sentence by hand; every sentence on this rail owes it, because
    // `FlipperLinkProblem` mounts them on all four Flipper surfaces.
    // ⚠️ c27: this captured ONE word after "tap", so the only MULTI-WORD label on the
    // rail — `Find my Flipper`, the button the whole feature is discovered through —
    // could never be checked by it, and any sentence naming it demanded a
    // `Button("Find")` instead. The pin's blind spot was the primary control. Capture
    // the whole clause and require a real label to START it: that covers both shapes
    // and still reds on "Tap Pair again", because no button here begins with "Pair".
    const buttons = Array.from(panel.matchAll(/Button\("([^"]+)"\)/g), (m) => m[1])
    expect(buttons.length, 'no Button labels found — this pin is reading the wrong file')
      .toBeGreaterThan(3)
    const named = literals().flatMap((s) =>
      Array.from(s.matchAll(/\b[Tt]ap ([A-Z][^.,;—]*)/g), (m) => m[1].trim()))
    expect(named.length, 'no sentence names a control any more — the extraction is stale')
      .toBeGreaterThanOrEqual(3)
    for (const phrase of Array.from(new Set(named))) {
      expect(buttons.find((b) => phrase === b || phrase.startsWith(b)),
        `a sentence tells the user to tap "${phrase}", which is on no surface`).toBeDefined()
    }
    // And the row that resumes the link really is the one they are sent to.
    expect(codeOnly(pairedRow(), /Button/)).toMatch(/Button\("Reconnect"\) \{ flipper\.start\(\) \}/)
  })
})

/**
 * 🔔 c26 — the find rail reported an ACKNOWLEDGEMENT as a PERCEPTION.
 *
 * `flipper_find` is step ONE of the P5 acceptance run (design doc §5) precisely
 * because a noise from the board is the one answer nothing can fake. Two separate
 * things were wrong with what it claimed.
 *
 * 1. The phone answered "🔔 The Flipper beeped, blinked **and buzzed** — over
 *    Bluetooth from this phone." But `Gui.PlayAudiovisualAlert` hands the board a
 *    notification and the BOARD decides what that becomes. Read off the user's own
 *    C2 over the cable — `/int/.notification.settings`, 24 bytes, version 2:
 *    `02 00 00 00 | 1.0 | 1.0 | 1.0 | 1800000 | 0` = display 1.0, LED 1.0, speaker
 *    1.0, display-off 30 min, **vibro_on 0**. The third of those three claims was
 *    false on the very board this feature was built for, and the RPC answers OK
 *    either way: the protocol carries no acoustic feedback, so nothing on this side
 *    can ever know what was heard.
 *
 * 2. The two routes drive DIFFERENT hardware. The cable's `alert` is `led r 255`
 *    plus `vibro 1/0` and no speaker command at all — its own reply, `🚨 alert (led
 *    + vibro)`, always said so honestly — while the shared tool description promised
 *    "beep, blink and buzz … the sound is what finds it". The cable is the PREFERRED
 *    route in `pickFlipperHost`, so that sentence was most wrong exactly where it
 *    was most likely to be read.
 *
 * The user-visible failure is not a missing feature: a board with its speaker or
 * vibro switched off is reported as having made a noise, so the person who heard
 * nothing concludes the Bluetooth link is dead — and no surface anywhere on this
 * rail had ever mentioned that the board holds its own switches for this.
 */
describe('c26 — a beep nobody can hear is not a beep, and the two routes are not the same alert', () => {
  const alertBody = () => swiftBody(gateway, 'static func alertSent(')
  const arm = (label: string) => codeOnly(swiftCase(alertBody(), label), /return "/)
  const findTool = () => String((flipperTools as any).makeFlipperFindTool('u1').toolSpec.description)

  /** The reader kinds, out of the enum — never a list typed into this test. */
  const AUDIENCES = Array.from(
    swiftBody(gateway, 'enum ReadAudience {').matchAll(/^\s*case (\w+)$/gm), (m) => `.${m[1]}`)

  /** The board's own name for the screen, from the board's own `loader list`. */
  const SCREEN = 'Settings → LCD and Notifications'

  it('no reader is told the board beeped — only that it accepted the alert', () => {
    expect(AUDIENCES.length, 'the audience enum lost its cases').toBeGreaterThan(1)
    for (const aud of AUDIENCES) {
      const a = arm(aud)
      // THE DEFECT: a past-tense noise is a claim about a room this code cannot hear.
      expect(a, `${aud} states a sound it has no way to observe`)
        .not.toMatch(/beeped|buzzed|blinked|you (?:will|should) hear/i)
      // And what the OK actually is, since something has to fill that space.
      expect(a, `${aud} never says what the answer really proves`).toMatch(/accepted|acknowledg/i)
    }
  })

  it('and every reader is told why a silent board is not a dead link', () => {
    // The point of the fix rather than its shape. The failure mode of P5 step one is
    // "I heard nothing"; with the board's own switches missing from the sentence, the
    // only remaining explanation is a broken link — and somebody re-pairs, or
    // "Forget all paired devices", a Flipper that was working the whole time.
    for (const aud of AUDIENCES) {
      const a = arm(aud)
      expect(a, `${aud} leaves a muted board reading as a broken link`).toMatch(/separate switches/)
      expect(a, `${aud} does not name the screen those switches are on`).toContain(SCREEN)
    }
  })

  it('the screen it names is the board\'s own label, not the one that un-pairs it', () => {
    // ⚠️ Hazard 4, and c24 deleted a whole sentence over it. "LCD and Notifications"
    // is the board's own menu label (`loader list` on this board), and that row sits
    // directly BELOW "Bluetooth" — the screen holding "Forget all paired devices".
    // An alert needs a live link, so this function is ONLY ever read with a pairing
    // on the line: the name has to be exact rather than "check its settings".
    for (const aud of AUDIENCES) {
      expect(arm(aud), `${aud} sends a paired reader to the screen that destroys the bond`)
        .not.toMatch(/Settings → Bluetooth|in its settings|on the Flipper itself/i)
    }
    // And the measurement stays written down, so the next reader does not have to
    // re-read a 24-byte blob to find out why the wording is careful.
    expect(gateway, 'the measurement behind this wording is no longer recorded')
      .toMatch(/notification\.settings/)
  })

  it('both surfaces say it through that one function, and neither keeps a copy', () => {
    // Hazard 21/22: share the FACT, keep each frame. Two hand-written copies is how
    // this rail's sentences drifted before — and here they had drifted from the
    // HARDWARE, in the same direction, because nobody had measured it.
    const handler = swiftBody(session, 'static func handleFlipperEnvelope(')
    const relay = codeOnly(swiftCase(handler, '"alert", "beep", "find"'), /fg\.alert\(\)/)
    expect(relay, 'the relay reply writes its own sentence about a sound it cannot hear')
      .toMatch(/FlipperGateway\.alertSent\(for: \.relayReply\)/)
    const note = codeOnly(swiftBody(panel, 'private func beep() async'), /flipper\.alert\(\)/)
    expect(note, "the panel's note writes its own sentence")
      .toMatch(/note = FlipperGateway\.alertSent\(for: \.panelSheet\)/)
    // Shared fact, per-reader frame: a parameter threaded to identical strings is
    // decoration, the same check c24's arms owe.
    //
    // ⚠️ Compare the LITERALS, never the sliced arms. The LAST arm's block carries
    // the switch's closing braces, so two byte-identical sentences still differ as
    // blocks — measured here as a surviving mutant, with both readers handed the
    // relay's words and this assertion passing anyway.
    const said = Array.from(alertBody().matchAll(/return "((?:[^"\\]|\\.)*)"/g), (m) => m[1])
    expect(said.length, 'the sentences are no longer one return per reader')
      .toBe(AUDIENCES.length)
    expect(new Set(said).size, 'both readers are handed one sentence').toBe(said.length)
  })

  it('no surface on the rail states, as a fact, that the board made a noise', () => {
    // Hazard 23: grep the CLAIM across every surface, not the feature across its own
    // file. The four files the SD-card guard sweeps, plus the two Flipper-only ones —
    // and the phone's copy matters most, because its sentences reach the agent as the
    // tool RESULT and outrank every prompt copy of the same claim.
    for (const f of ['lib/chat/tools/flipper.ts', 'app/api/job-run/route.ts', 'lib/chat/prompt.ts',
      'ios/Tiny/Sources/Session.swift', 'ios/Tiny/Sources/FlipperGateway.swift',
      'ios/Tiny/Sources/FlipperBlePanel.swift']) {
      expect(codeOnly(read(f), /flipper/i), `${f} reports a sound it has no way to observe`)
        .not.toMatch(/\b(?:beeped|buzzed|blinked)\b/i)
    }
  })

  it('the tool description gives each route its own hardware', () => {
    const d = findTool()
    // ⚠️ The cable's alert is `led` + `vibro` and NO speaker command (tiny-tech
    // src/agent/flipper.ts), and the cable is what `pickFlipperHost` PREFERS — so
    // "the sound is what finds it" was worst on the likelier of the two routes.
    expect(d, 'the description promises a sound the preferred route never makes')
      .toMatch(/cable[^.]*no sound/i)
    expect(d, 'the description says the answer proves someone heard it')
      .not.toMatch(/the sound is what finds it/)
    expect(d, 'the description never says what the answer actually is').toMatch(/accept/i)
    // And it KEEPS the caution that is true on both routes: the board can be loud in
    // whatever room it is in, which is why an unattended job must not reach for it
    // (`/unattended/` is pinned in tests/flipper-tools.test.ts).
    expect(d, 'the 3am caution went with the false promise').toMatch(/loud/i)
  })

  it('the two model-facing claims stop promising an unconditional beep', () => {
    // Both are read by the MODEL, which repeats them to the user — the c22/c23 shape:
    // several copies of one claim, and the stale one is the copy nobody re-reads.
    // Each must qualify the alert by the BOARD's state; the structural pins above
    // still hold their shape (bleCanDo ends in `(flipper_find)`, the hint has no ';').
    const qualified = /own settings|if that board|switched on/i
    expect(bleCanDo(), 'the shared claim promises a beep the board may not make')
      .toMatch(qualified)
    expect(bleCanDo(), 'the shared claim lost the tool that performs it')
      .toMatch(/\(flipper_find\)$/)
    expect(capabilitySummary(['flipper_ble']), 'the prompt promises a beep the board may not make')
      .toMatch(qualified)
  })

  it.skipIf(!HAS_DESIGN)('the capability matrix gives the two transports different cells', () => {
    // The doc is what the next cycle plans from, and its row read `✅ alert | ✅
    // PlayAudiovisualAlert` as though they were one alert. The row directly below it
    // — "LED / vibro / speaker individually: ✅ cable, ❌ BLE" — is why they cannot be.
    const row = design.split('\n').find((l) => /^\| find-my-Flipper/.test(l))
    expect(row, 'the find row is gone from the capability matrix').toBeDefined()
    const cells = (row as string).split('|').map((c) => c.trim())
    expect(cells.length, 'the find row is not three columns any more').toBe(5)
    const [cable, ble] = [cells[2], cells[3]]
    expect(cable, 'the cable cell still implies a sound it never sends').toMatch(/no sound/i)
    expect(ble, 'the BLE cell still implies the phone decides what the board does')
      .toMatch(/settings|allow/i)
    expect(cable === ble, 'the two transports are described as one alert again').toBe(false)
  })
})

/**
 * c27 — the panel that says "wake that machine" is the one surface that can SEE the
 * other route.
 *
 * `FlipperDevicePanel` is the Flipper's card on its HOST's row, and its asleep branch
 * is reachable for exactly the reason the backend's `!host.online` arm is: a device
 * row keeps the capabilities it last declared while its presence goes stale, so a
 * laptop that went to sleep with the cable in still shows a Flipper panel. What that
 * panel said was *"<host> isn't online — wake that machine to reach the Flipper."*,
 * and nothing else — on the one surface that is running on the phone that may be
 * holding the very same board over Bluetooth, one row down, where `flipper_status`
 * answers. The app sent the user to go and wake a laptop for a board in their pocket,
 * and the agent (which has had `aboutTheOtherRoute` since c21) and the panel gave two
 * different answers about the same hardware. Hazard 24(a) — grep the CLAIM across
 * every surface — with the twist that this surface is not merely stale: it is the
 * surface the whole feature exists to obsolete.
 */
describe('c27 — the cable panel knows about the phone in its own hand', () => {
  const cablePanel = () => codeOnly(swiftBody(iosPanels, 'struct FlipperDevicePanel: View {'),
                                    /RelayReach/)
  const routeBody = () => swiftBody(gateway, 'static func otherRoute(')
  const arm = (label: string) => codeOnly(swiftCase(routeBody(), label), /return "/)

  /** The route kinds, out of the enum — never a list typed into this test (28a). */
  const ROUTES = Array.from(
    swiftBody(gateway, 'enum LocalRoute {').matchAll(/^\s*case (\w+)$/gm), (m) => `.${m[1]}`)

  /**
   * The clauses themselves. Extracted as LITERALS, because a by-label slice carries
   * the switch's closing braces on its last arm and two identical sentences then
   * measure as different strings — hazard 32(d), a surviving mutant in c26.
   */
  const said = () => Array.from(routeBody().matchAll(/return "((?:[^"\\]|\\.)*)"/g), (m) => m[1])

  it('the asleep line stops being a one-remedy sentence', () => {
    // Anchored to the sentence it finishes: a clause somewhere else in the file is a
    // sentence nobody reads (c24c — a substring match cannot see what is put in front
    // of it, or in this case what it is put behind).
    expect(cablePanel(), 'the asleep remedy is a cable again')
      .toMatch(/isn't online — wake that machine to reach the Flipper\."\s*\+ flipper\.otherRouteClause\(\),/)
    // Observed, not sampled once: the link comes and goes while this row is on screen,
    // and a plain `FlipperGateway.shared` read cannot move the row (hazard 30b).
    expect(cablePanel(), 'the panel reads the gateway without observing it')
      .toMatch(/@ObservedObject private var flipper = FlipperGateway\.shared/)
    // One clause, from the shared function — not a second private copy of the fact,
    // which is how this panel and the backend diverged in the first place.
    expect(cablePanel().match(/otherRouteClause\(\)/g)?.length ?? 0,
      'the panel grew its own copy of the clause').toBe(1)
  })

  it('every route the enum declares has a clause, and every clause appends', () => {
    expect(ROUTES.length, 'the route enum lost its cases').toBeGreaterThan(3)
    for (const r of ROUTES) {
      const a = arm(r)
      expect(a, `${r} has no sentence`).toMatch(/return "/)
      // It finishes somebody else's sentence. Without the leading space it reads
      // "…reach the Flipper.This phone is holding…".
      expect(a, `${r} does not append — it would be glued to the sentence before it`)
        .toMatch(/return " [A-Z]/)
    }
    const clauses = said()
    expect(clauses.length, 'the clauses are no longer one return per route')
      .toBe(ROUTES.length)
    expect(new Set(clauses).size, 'two routes are handed the same clause')
      .toBe(clauses.length)
  })

  it('the state that made this a bug says so, and names a button that exists', () => {
    const holding = arm('.holding')
    expect(holding, 'the one state where "wake that machine" was false no longer corrects it')
      .toMatch(/right now/)
    // A remedy is a claim about a control (31d), and this one is on the row it names.
    expect(holding, 'the reader is told the cable is optional but not what to do instead')
      .toMatch(/tap Refresh on this phone's own row/)
    // What the cable is STILL for, in the BACKEND's own words: one asymmetry, one
    // vocabulary (26c). A second phrasing here is how two rails start disagreeing.
    const capture = /capturing (IR, Sub-GHz, RFID or iButton)/.exec(backend)
    expect(capture, 'the backend no longer lists what the cable is for — check both rails')
      .not.toBeNull()
    expect(holding, 'the two rails describe the cable-only half in different words now')
      .toContain(capture![1])
  })

  it('a link that is not reaching the board promises nothing, and points at the row that knows why', () => {
    const idle = arm('.notReaching')
    expect(idle, 'a board nobody is holding is reported as held')
      .not.toMatch(/right now|holding/)
    expect(idle, 'the second route is not admitted to be down too')
      .toMatch(/isn't reaching it either/)
    // Admitting it is down is only half a sentence: this is the one arm with no
    // remedy of its own, so it MUST hand the reader off. Without this the arm can
    // shrink to "not reaching it either." and every assert above still passes —
    // the test's own name would be the only thing claiming the pointer exists.
    expect(idle, 'the arm with no remedy of its own stops handing the reader anywhere')
      .toMatch(/own Flipper row says why/)
    // The row it sends them to really does diagnose it — all six reasons, one
    // sentence, already shared with the relay.
    expect(codeOnly(swiftBody(panel, '@ViewBuilder private var paired'), /outageLine/),
      'the row this points at no longer explains itself')
      .toMatch(/outageLine\(for: \.panelSheet\)/)
    // …and that row is on this phone unconditionally, so the pointer cannot dangle.
    expect(codeOnly(iosPanels, /FlipperBlePanel\(\)/),
      'the row this points at is now conditional — the clause may point at nothing')
      .toMatch(/if d\.id == thisPhone \{\s*FlipperBlePanel\(\)\s*\}/)
  })

  it('the offer is made only where it can be taken', () => {
    expect(arm('.offerable'), 'the discovery path is no longer offered to a phone that could take it')
      .toMatch(/tap Find my Flipper/)
    const noRadio = arm('.noRadio')
    // 26(e)/31: naming a remedy that cannot work is worse than naming none. With no
    // usable radio, "tap Find my Flipper" starts a scan that cannot begin.
    expect(noRadio, 'a tap that cannot work is offered to a phone with no radio for it')
      .not.toMatch(/\b[Tt]ap /)
    expect(noRadio, 'the reader is left with no route at all')
      .toMatch(/way in|only route/)
  })

  it('no clause sends anyone to the screen that holds "Forget all paired devices"', () => {
    // Hazard 4 + c24: this reader has a bond to lose, every time. The radio these
    // sentences may talk about is THIS PHONE's, and they say so in those words.
    for (const r of ROUTES) {
      expect(arm(r), `${r} points at the board's own Bluetooth screen`)
        .not.toMatch(/Settings → Bluetooth|on the Flipper itself|in its own settings/i)
    }
    expect(arm('.noRadio'), 'whose Bluetooth is unavailable is left to the reader to guess')
      .toMatch(/This phone/)
  })

  it('the clause is built from live facts, and no caller can pick its own', () => {
    const map = codeOnly(swiftBody(gateway, 'var localRoute: LocalRoute {'), /linked/)
    expect(map, 'a live link no longer outranks everything else')
      .toMatch(/if linked \{ return \.holding \}/)
    expect(map.indexOf('linked'), 'the pairing check now hides the live link')
      .toBeLessThan(map.indexOf('unit != nil'))
    expect(map, 'the radio no longer decides whether pairing can be offered')
      .toMatch(/radio == \.poweredOn \? \.offerable : \.noRadio/)
    for (const fact of ['linked', 'unit', 'radio']) {
      expect(gateway, `${fact} is not observable, so no clause built from it can update`)
        .toMatch(new RegExp(`@Published private\\(set\\) var ${fact}`))
    }
    const sig = gatewaySignatures().find((s) => s.startsWith('func otherRoute('))
    expect(sig, 'otherRoute() is gone').toBeDefined()
    expect(sig, 'otherRoute defaults its route, so a caller can inherit the wrong clause')
      .not.toMatch(/LocalRoute\s*=/)
    expect(codeOnly(gateway, /otherRoute\(localRoute\)/), 'a caller hard-codes the route')
      .not.toMatch(/otherRoute\(\.\w+\)/)
    // The rail this mirrors. If the backend loses its own clause the phone is alone
    // again, and the two answers about one board start drifting from the other end.
    expect(codeOnly(backend, /aboutTheOtherRoute/),
      'the backend stopped telling the agent about the Bluetooth route')
      .toMatch(/does hold the Flipper over Bluetooth and is answering/)
  })
})

/**
 * 🐬🎙️ c28 — the one tool Bluetooth can never serve was the last one told about
 * Bluetooth, and the cost of that is a PERSON, not a turn.
 *
 * "Capture needs the cable" is said everywhere that answers AFTER the call: both
 * `!host.online` arms, the cable-only refusal, flipper_status's note, and the
 * phone's own refusal in Session.swift. It is also in both system prompts that
 * exist — `CAPABILITY_HINTS.flipper_ble` ("no radio capture") and job-run's
 * capability note ("only capturing … needs the cable"), the latter added for the
 * exact stated reason that "an unattended job will schedule a capture the phone
 * can never perform and read the refusal as a dead board" (line 1333).
 *
 * It was in neither text a model reads BEFORE deciding to call. Not the tool
 * description — and there is a third surface, which has no prompt to have fixed:
 * a live voice call. `buildVoiceInstructions` in app/api/voice/session/route.ts
 * assembles a persona, a knowledge blob and a memory continuity block, and no
 * device roster of any kind, while `buildVoiceTools` declares all four flipper
 * tools to every session including the browser. So for a spoken capture the
 * description IS the whole prompt.
 *
 * And this is the one tool on the rail whose precondition is checkable but whose
 * failure is not free: its own paragraph orders the model to announce the capture
 * first, because a capture needs a human to press a remote or hold up a card. On
 * a Bluetooth-only account the guaranteed sequence was therefore: promise the
 * capture out loud, send someone to the board, refuse once they are standing
 * there. Every refusal in this rail is honest and none of them can give that back.
 *
 * The same test at line 1339 already knew the shape — "a system prompt outranks a
 * tool description … a schema that has always been right is no defence" — and
 * asserted the pair for flipper_status. Nobody asked it of the tool where the
 * schema is sometimes the only text there is.
 */
describe('c28 — a capture is never promised before the route that can make it is known', () => {
  const listenDesc = () =>
    String((flipperTools as any).makeFlipperListenTool('u1').toolSpec.description)
  const jobRun = read('app/api/job-run/route.ts')
  const voiceSession = read('app/api/voice/session/route.ts')

  /**
   * The rail's own name for the four radios that live only on the cable, taken
   * OUT of the rail rather than typed here (hazard 26c/33c): one asymmetry, one
   * vocabulary. Reword the refusal and this pin moves with it.
   */
  const RADIOS = (() => {
    const m = /capturing (IR, Sub-GHz, RFID or iButton)/.exec(backend)
    expect(m, 'the backend no longer lists what the cable is for — check both texts')
      .not.toBeNull()
    return m![1]
  })()

  it('the tool no phone can run says so in the text read before it is called', () => {
    const d = listenDesc()
    expect(d.length, 'the description was restructured — re-read these pins')
      .toBeGreaterThan(400)
    // THE DEFECT. The router's refusals were never the problem; this is the text
    // the model PLANS from, and the word "Bluetooth" had never appeared in it.
    expect(d, 'the one tool Bluetooth cannot serve still never mentions Bluetooth')
      .toMatch(/Bluetooth/)
    // Deliberately NOT pinned to my own phrasing: the FACT is that the cable is
    // named and that the radios are the rail's four. A reword that keeps both is
    // an improvement, and a pin that reds on it teaches the wrong lesson.
    expect(d, 'the description does not say the capture needs the cable')
      .toMatch(/cable/i)
    expect(d, 'the description describes the cable-only half in its own new words')
      .toContain(RADIOS)
    // A limit with no reason reads as an unimplemented feature, and the next
    // reader tries to implement it. It is the firmware's, and permanent.
    expect(d, 'the limit is asserted with no reason, so it reads as a gap to fill')
      .toMatch(/no receive command over BLE/)
    // Never a fake capture, and never a fake absence of one: the refusal is the
    // honest answer, so the description must license it rather than hide it.
    expect(d, 'the description does not admit that the call will be refused')
      .toMatch(/refuse/)
  })

  it('and says it where the announcement is decided, not after the topic has changed', () => {
    const d = listenDesc()
    // The harm is the ORDER. This paragraph is what sends a person to the board;
    // a precondition parked after the NFC aside is read once the promise is made.
    const announce = d.indexOf('say what you are about to do')
    expect(announce, 'the announcement instruction is gone — this pin is stale')
      .toBeGreaterThan(-1)
    const nfc = d.indexOf('13.56MHz NFC')
    expect(nfc, 'the NFC aside is gone — this pin is stale').toBeGreaterThan(announce)
    const limit = d.indexOf(RADIOS)
    expect(limit, 'the precondition does not qualify the announcement it belongs to')
      .toBeGreaterThan(announce)
    expect(limit, 'the precondition was appended after an unrelated aside')
      .toBeLessThan(nfc)
    // A precondition with no way to check it in advance is still a guess. One tool
    // answers "which route is up", and it is the cheap one — its own description
    // says "Use this before any other flipper_* tool". It has to be named IN this
    // paragraph, and as something to do first: naming it in the NFC aside below
    // would be a different instruction about a different question.
    const paragraph = d.slice(announce, nfc)
    expect(paragraph, 'nothing in the precondition says HOW to know the route')
      .toMatch(/flipper_status/)
    // Tied to the tool, not loose in the paragraph: the announcement sentence
    // itself already contains "before", so a bare /first|before/ here would pass
    // on a description that never ordered the check at all.
    expect(paragraph, 'the route check is named but not ordered ahead of the promise')
      .toMatch(/flipper_status[^.;]*first|(?:first|before)[^.;]*flipper_status/)
    expect(String((makeFlipperStatusTool('u1') as any).toolSpec.description),
      'flipper_status stopped reporting which route holds the board')
      .toMatch(/which phone holds it over Bluetooth/)
  })

  it('what Bluetooth CAN do comes from the shared list, not a fifth copy of it', () => {
    // The bleCanDo doc comment is the receipt: five hand-written copies, four of
    // which promised a beep no tool could send. A sixth reader is fine; a sixth
    // TYPING is the same defect returning.
    expect(listenDesc(), 'the description re-types the shared capability list')
      .toContain(bleCanDo())
    // Offering an alternative is only honest if it is the alternative to a
    // capture: a listing of what is already saved. Not its contents — /ext/nfc is
    // the user's passports and bank cards, and no tool on this rail reads a file.
    expect(listenDesc(), 'the alternative offered is not one this rail can perform')
      .toMatch(/flipper_files/)
    expect(codeOnly(backend, /flipper_listen/),
      'the listen rail offers to read the SD card, which nothing here can do')
      .not.toMatch(/read (the|its) SD card/i)
  })

  it('every text a model plans from carries the limit, including the rail with no prompt', () => {
    // Hazard 30/33: grep the CLAIM across every surface, not the feature across
    // its own file. Two surfaces have a prompt and both were fixed IN the prompt;
    // the third has none at all, which is why the shared schema had to carry it.
    expect(capabilitySummary(['flipper_ble']), 'the chat prompt stopped ruling capture out')
      .toMatch(/no radio capture/)
    expect(jobRun, 'job-run stopped telling an unattended run that capture needs the cable')
      .toMatch(/needs the cable/)
    // The voice rail: declares the tool, and builds instructions out of a persona
    // rather than a device roster — so this description is the entire brief.
    expect(buildVoiceTools('web').map((t) => t.name),
      'the voice roster stopped declaring flipper_listen — re-read this block')
      .toContain('flipper_listen')
    const instructions = (() => {
      const at = voiceSession.indexOf('function buildVoiceInstructions(')
      expect(at, 'buildVoiceInstructions is gone — the voice brief was restructured')
        .toBeGreaterThan(-1)
      const end = voiceSession.indexOf('export async function POST', at)
      expect(end, 'the slicer has no end marker').toBeGreaterThan(at)
      const body = voiceSession.slice(at, end)
      // A scraper that silently returns a fragment is a test that passes forever.
      expect(body, 'the voice brief sliced empty — it no longer assembles a persona')
        .toMatch(/systemPrompt/)
      return body
    })()
    for (const t of FLIPPER_TOOLS) {
      expect(instructions, `the voice brief now names ${t} — fold this pin into that roster`)
        .not.toContain(t)
    }
    expect(listenDesc(), 'the only text a voice call has about capture lost the limit')
      .toContain(RADIOS)
  })
})

/**
 * 🐬🗣️ The branch only a spoken turn can reach, addressed to a caller who cannot
 * reach it — while the board was already doing the thing.
 *
 * `flipperInvoke`'s short-wait timeout fires when the wait it was given is under
 * `BLE_ROUND_TRIP_S`, and c22 put a floor under every CEILING on this rail so no
 * interactive caller could land there. The ceilings hold (45, 45, 45 ≥ 35). The
 * WAIT is `clampToJob(ceiling, budget)`, and that is a different number: chat 45,
 * a job 42, **a live voice call 15** — so the one branch whose text says "go be
 * somewhere else" is reached by exactly one caller, on every Bluetooth call it
 * ever makes, and that caller is the one it was not written for. The guard that
 * looked like it covered this compared the constants; nothing compared the
 * clamped waits. A GUARD CANNOT REPORT WHAT ITS INPUT OMITS.
 *
 * What it said, to somebody talking out loud: *"This turn didn't have the time.
 * Ask again from an interactive chat"* — a sentence `ALERT_WAIT_S`'s own doc had
 * already called out as one "that makes no sense when the caller IS one", while
 * assuming no interactive caller could get here. A spoken turn is interactive;
 * TYPED is the property that distinguishes it.
 *
 * And the fact it omitted is the one that could have saved the turn. `relaySend`
 * returned `queued` BEFORE the wait, so leaving early cancels nothing: the phone
 * claims the envelope at its next poll and the board does the thing. For
 * `flipper_find` — "the most spoken-word tool on this rail", hands empty, room to
 * listen in — the answer is a NOISE that is about to happen, and the tool said "I
 * couldn't tell, ask again from a chat", which asks for a second alert. Nothing
 * else will ever mention it either: the worker's late-reply event and push are
 * gated to `{type:'invoke'}` envelopes, so a `{type:'flipper'}` reply that lands
 * after its waiter left is swept in silence.
 */
describe('the turn that leaves early says what it set in motion, and where to go', () => {
  const voiceRoute = read('app/api/voice/tool/route.ts')
  const jobRoute = read('app/api/job-run/route.ts')
  const workerRelay = read('worker/src/relay.ts')
  // Scraped, not typed: the `!` is the point — a renamed constant throws here
  // rather than quietly reading as 0 and making every comparison pass.
  const budgetOf = (src: string, name: string) =>
    Number(src.match(new RegExp(`${name} = (\\d+)`))![1])
  const VOICE_BUDGET_S = budgetOf(voiceRoute, 'VOICE_TOOL_BUDGET_S')
  const JOB_BUDGET_S = budgetOf(jobRoute, 'JOB_DEADLINE_S')

  /** The short-wait arm's own text, end-markered off the long arm below it. */
  const shortArm = (() => {
    const at = backend.indexOf('waitS < BLE_ROUND_TRIP_S')
    expect(at, 'the short-wait branch is gone — re-read this whole block').toBeGreaterThan(-1)
    const end = backend.indexOf('which was long enough', at)
    expect(end, 'the slicer has no end marker').toBeGreaterThan(at)
    const arm = backend.slice(at, end)
    // A slicer that returns a fragment is a test that passes forever.
    expect(arm, 'the short arm sliced empty').toMatch(/not long enough to conclude anything/)
    return arm
  })()

  it('only a spoken turn can reach the branch that tells you to go elsewhere', () => {
    // The reachability is DERIVED, per rail and per waiting tool, because the
    // whole defect was a guard that checked the ceilings and never the clamp.
    const waits = { chat: undefined, job: JOB_BUDGET_S, voice: VOICE_BUDGET_S } as const
    const lands: string[] = []
    for (const [rail, budget] of Object.entries(waits)) {
      for (const [tool, wait] of [
        ['flipper_status', statusWait(budget)],
        ['flipper_files', filesWait(budget)],
        ['flipper_find', alertWait(budget)],
      ] as const) {
        if (wait < BLE_ROUND_TRIP_S) lands.push(`${rail}/${tool}`)
      }
    }
    // Exactly one rail, and all of its tools: if this list ever shrinks to empty
    // the branch is dead code and its sentence can go; if it grows, the sentence
    // has a second reader and hazard 22 applies (a refusal is a fact plus an
    // addressee).
    expect(lands.sort(), 'which rails land in the short-wait branch changed')
      .toEqual(['voice/flipper_files', 'voice/flipper_find', 'voice/flipper_status'])
    // …and it is not bad luck for that rail, it is every call: the clamp is fixed.
    expect(statusWait(VOICE_BUDGET_S)).toBeLessThan(BLE_ROUND_TRIP_S)
    expect(JOB_BUDGET_S, 'a job now lands here too — the sentence needs its frame')
      .toBeGreaterThan(VOICE_BUDGET_S)
  })

  it('it does not send a spoken caller to the interactive chat they are already in', () => {
    // The fact, not the phrasing: the addressee that cannot read this is gone, and
    // what replaces it names the property that distinguishes the two rails.
    expect(shortArm, 'the branch only voice reaches still sends voice to "an interactive chat"')
      .not.toMatch(/interactive chat/)
    expect(shortArm, 'the remedy no longer says which kind of chat has the time')
      .toMatch(/TYPED chat/)
    expect(shortArm, "the caller's own unclamped ceiling must still be the number offered")
      .toMatch(/\$\{fullS\}s is available/)
    // "This turn didn't have the time" read as bad luck on a rail where it is
    // arithmetic, so the text has to say that asking the same way repeats it.
    expect(shortArm, 'nothing says that asking again the same way lands here again')
      .toMatch(/again/)
    // The same wrong addressee had a second site in CODE — the capture window a
    // turn cannot host. Two readers there (a job on a long window, voice on
    // anything over 10s), so it takes the same word, not the same sentence.
    const listenRefusal = backend.slice(backend.indexOf('A ${secs}s capture needs longer'))
    expect(listenRefusal.slice(0, 300), 'the capture refusal still names an interactive chat')
      .not.toMatch(/interactive chat/)
    expect(listenRefusal.slice(0, 300)).toMatch(/TYPED chat/)
    expect(codeOnly(backend, /TYPED chat/), 'a third site still has the old addressee')
      .not.toMatch(/interactive chat/)
  })

  it('a timeout reports the request it already handed to the relay', () => {
    // relaySend returned `queued` before the wait began, so the give-up is not a
    // cancel. The shared fact is one function; the arms are per action.
    expect(shortArm, 'the short arm does not use the shared in-flight sentence')
      .toContain('${bleStillQueued(ble!.action, host.name)}')
    // The REAL action, not a literal: a hard-coded 'alert' here would promise a
    // beep for a status read, and a hard-coded 'status' would drop the beep.
    expect(codeOnly(backend, /bleStillQueued/), 'the in-flight sentence is given a fixed action')
      .not.toMatch(/bleStillQueued\('/)
    for (const a of ['status', 'files', 'alert']) {
      const s = flipperTools.bleStillQueued(a, 'owner-phone')
      expect(s, `${a} has no in-flight frame`).toMatch(/did not cancel it/)
      expect(s, `${a}'s frame does not name the host that will run it`).toContain('owner-phone')
    }
    // Per-action frames, and the difference is the point: only the alert produces
    // something to perceive, so only the alert may ask anyone to listen. A status
    // read told to "listen for it" is c26's defect (an ack is not a perception).
    expect(flipperTools.bleStillQueued('alert', 'x'), 'the beep that is coming is not announced')
      .toMatch(/listen/i)
    expect(flipperTools.bleStillQueued('alert', 'x'), 'nothing warns that asking again re-alerts')
      .toMatch(/second alert/)
    for (const a of ['status', 'files']) {
      expect(flipperTools.bleStillQueued(a, 'x'), `${a} has nothing to listen for`)
        .not.toMatch(/listen/i)
    }
    // Every action this rail actually sends must have a decided frame — derived
    // from the module, so a fourth action cannot arrive without one.
    const actions = Array.from(new Set(Array.from(
      codeOnly(backend, /action: 'status'/).matchAll(/\{ action: '(\w+)'/g), (m) => m[1])))
    expect(actions.length, 'no ble actions found — the extraction is broken').toBeGreaterThan(2)
    for (const a of actions) {
      const s = flipperTools.bleStillQueued(a, 'x')
      expect(s.length, `action "${a}" gets no in-flight sentence`).toBeGreaterThan(80)
    }
  })

  it('nothing else will report the late answer, which is why this turn must', () => {
    // The claim in `bleStillQueued`'s doc, extracted from the worker rather than
    // asserted here: the late-reply event AND push share one gate, and it drops
    // every envelope that is not `{type:'invoke'}` — which is every envelope this
    // rail sends a phone.
    const gate = workerRelay.slice(
      workerRelay.indexOf('function parseLateInvoke'),
      workerRelay.indexOf('export function buildLateReplyEvent'))
    expect(gate, 'the late-reply gate was restructured — re-read both files')
      .toMatch(/ageSeconds/)
    expect(gate, 'the gate no longer excludes non-invoke envelopes; the sentence can change')
      .toMatch(/request\.type !== "invoke"/)
    // The envelope this rail sends a phone is the excluded shape.
    expect(codeOnly(backend, /type: 'flipper'/), 'the BLE envelope type changed')
      .toMatch(/type: 'flipper'/)
    // Both rails read that one gate, so neither can be the exception.
    expect(workerRelay.slice(workerRelay.indexOf('export function buildLateReplyEvent')))
      .toMatch(/parseLateInvoke/)
    expect(workerRelay.slice(workerRelay.indexOf('export function buildDeviceResultPush')))
      .toMatch(/parseLateInvoke/)
    // Even if that gate opened, the age gate would drop a voice-length wait: the
    // reply is not "late" until LATE_REPLY_S, which is three voice waits away.
    const lateS = Number(workerRelay.match(/LATE_REPLY_S = (\d+)/)![1])
    expect(statusWait(VOICE_BUDGET_S), 'a voice wait now outlasts the lateness gate')
      .toBeLessThan(lateS)
  })
})

/**
 * 🐬⏱️ "The Flipper didn't answer" was two different facts, and the one it left
 * out is the one that decides what to do next.
 *
 * `request()`'s timeout timer runs independently of the write queue, so it fires
 * in two completely different worlds: the frame was still queued behind another
 * command — the board never saw it, and `writeFrame`'s `pending[id]` guard then
 * drops it unsent — or the bytes went out and only the reply is missing. For a
 * read those are one story. For anything that CHANGES the board they are opposite
 * ones, and "didn't answer" reads as "didn't happen".
 *
 * Which is how this loop's own acceptance step reports a success as a dead link.
 * `flipper_find` is step one of P5 *because* a noise from the board is the answer
 * nothing can fake; a beep that sounded while its reply was late came back as
 * "The Flipper didn't answer an alert in time", and the obvious response to that
 * is to ask again — which on this rail is a SECOND alert, not a second answer.
 * c29 fixed this omission one layer up, where the give-up was the waiter's and
 * the envelope was still queued. This is the layer that actually knows whether
 * the bytes left, and it was the layer keeping quiet.
 *
 * The panel had the fact written down already, addressed to nobody:
 * `send(_:hold:)`'s doc says *"a FAILED press is not a press that didn't land …
 * the frame may well have been delivered and acted on"* — which is why it always
 * sends the RELEASE — while the person watching the screen mirror was shown
 * "didn't answer" and pressed OK a second time.
 */
describe('a timeout that reached the board is not a command that never happened', () => {
  const descBody = () => codeOnly(swiftBody(gateway, 'var errorDescription: String?'), /notLinked/)
  const timerBody = () => codeOnly(swiftBody(gateway, 'let timer = Task {'), /Task\.isCancelled/)
  const writeBody = () => codeOnly(swiftBody(gateway, 'private func writeFrame('), /waitForRoom/)
  const timedOut = () => codeOnly(swiftBody(gateway, 'private func failTimedOut('), /fail\(/)
  const after = () => swiftBody(gateway, 'static func afterUnconfirmed(')
  const arm = (label: string) => codeOnly(swiftCase(after(), label), /reads/)
  const handler = () => swiftBody(session, 'static func handleFlipperEnvelope(')

  /** A `Set<String>` literal in the gateway, read out of the source. */
  const setOf = (name: string): string[] => {
    const m = new RegExp(`static let ${name}: Set<String> = \\[([^\\]]*)\\]`).exec(gateway)
    expect(m, `${name} is no longer a Set literal — this derivation is stale`).not.toBeNull()
    const out = Array.from(m![1].matchAll(/"(\w+)"/g), (x) => x[1])
    expect(out.length, `${name} sliced empty`).toBeGreaterThan(0)
    return out
  }

  /**
   * Every `case "a", "b":` of the envelope switch with the block it answers with.
   *
   * Derived, because the question this block asks is "which actions can reach the
   * catch" and the answer is a property of the SWITCH. A list typed in here is the
   * c22→c23 failure a fourth time: the census would keep passing while the action
   * it forgot inherited a sentence nobody chose for it.
   */
  const envelopeCases = () => {
    const body = codeOnly(handler(), /statusLine/)
    const out: { labels: string[]; block: string }[] = []
    for (const m of Array.from(body.matchAll(/\n\s*case ((?:"\w+"(?:, )?)+):/g))) {
      const rest = body.slice((m.index as number) + m[0].length)
      const next = rest.search(/\n\s*(?:case |default:)/)
      out.push({
        labels: Array.from(m[1].matchAll(/"(\w+)"/g), (x) => x[1]),
        block: next === -1 ? rest : rest.slice(0, next),
      })
    }
    expect(out.length, 'no envelope cases found — this derivation is broken').toBeGreaterThan(4)
    return out
  }

  it('the error carries whether the question arrived, in two sentences that disagree', () => {
    expect(codeOnly(gateway, /case timeout/), 'the timeout case dropped the fact its reader needs')
      .toMatch(/case timeout\(String, sent: Bool\)/)
    const timeoutArm = swiftCase(descBody(), '.timeout(let what, let sent)')
    // Order fixed by the ternary, so the two sentences below cannot be read the
    // wrong way round by this test.
    expect(timeoutArm, 'the description no longer branches on whether it was sent')
      .toMatch(/return sent\s*\?/)
    const said = Array.from(timeoutArm.matchAll(/"([^"]*)"/g), (m) => m[1])
    expect(said.length, 'the timeout description no longer has exactly two sentences').toBe(2)
    const [sent, unsent] = said
    expect(sent, 'the sent arm no longer says the request reached the board').toMatch(/did reach it/)
    expect(unsent, 'the unsent arm no longer says the board never got it').toMatch(/never received/)
    // The whole point: an unsent request must not be described as one the board
    // failed to answer. It was never asked.
    expect(unsent, 'the unsent arm blames the board for not answering a question it never had')
      .not.toMatch(/didn't answer/)
    expect(unsent, 'the unsent arm does not say what held the frame back').toMatch(/queued/)
    // ⚠️ One constructor, and it is the one that reads the flag. A second site
    // would have to guess, and the only guess available is `false` — which is the
    // old sentence back, printed over a command the board already ran.
    expect(Array.from(codeOnly(gateway, /FlipperError\.timeout/)
      .matchAll(/fail\([^)]*FlipperError\.timeout\(/g)).length,
      'FlipperError.timeout is raised somewhere that cannot know whether it was sent').toBe(1)
    expect(timerBody(), 'the timer builds the error itself again — it cannot see the write queue')
      .not.toMatch(/FlipperError\.timeout/)
    expect(timerBody(), 'the timer no longer goes through the one place that reads the flag')
      .toMatch(/failTimedOut\(id, label\)/)
  })

  it('the flag is set where the send stops being cancellable, and read before the entry dies', () => {
    // Default false, and it lives WITH the request: `fail` clears the id, so a flag
    // kept in a set beside `pending` would answer for an id nobody is holding.
    expect(codeOnly(swiftBody(gateway, 'private struct Pending {'), /var frames/))
      .toMatch(/var sent = false/)
    const w = writeBody()
    const iAbandon = w.indexOf('pending[id] != nil')
    const iLink = w.indexOf('FlipperError.notLinked')
    const iSent = w.indexOf('pending[id]?.sent = true')
    const iChunks = w.indexOf('while offset <')
    // ⚠️ ORDER IS THE WHOLE PIN. Above the abandon guard, a request dropped during
    // `waitForRoom` (60 × 50ms) would be reported as sent — the board never saw
    // it. Above the link guard, so would one whose peripheral went away. Below the
    // chunk loop it would be a lie in the other direction only in theory, but the
    // fact is true from the first `writeValue`, so that is where it is recorded.
    expect(iAbandon, 'the abandon guard is gone — re-read writeFrame before trusting this')
      .toBeGreaterThan(-1)
    expect(iLink, 'the link re-check is gone').toBeGreaterThan(iAbandon)
    expect(iSent, 'the sent flag is set before the guards that can still drop the frame')
      .toBeGreaterThan(iLink)
    expect(iChunks, 'the chunk loop moved above the flag').toBeGreaterThan(iSent)
    // Nothing else may set it, and nothing at all may clear it: a reset would put
    // the old sentence back for whichever request ran second.
    expect(Array.from(codeOnly(gateway, /sent = true/).matchAll(/\.sent = true/g)).length,
      'a second site now claims a frame was sent').toBe(1)
    expect(codeOnly(gateway, /sent = true/), 'something clears the sent flag')
      .not.toMatch(/\.sent = false/)
    const t = timedOut()
    expect(t.indexOf('pending[id]?.sent'), 'failTimedOut no longer reads the flag').toBeGreaterThan(-1)
    expect(t, 'failTimedOut no longer hands the flag to the error it raises')
      .toMatch(/FlipperError\.timeout\(label, sent: /)
    // The entry still has to exist when the flag is read, and `fail` removes it —
    // so `fail` must be the LAST thing this does. Stated as "nothing runs after
    // it" rather than as an index comparison on purpose: reading the flag inline,
    // inside the call, is correct Swift (arguments evaluate first) and a
    // positional pin would red on it. What is never correct is a statement AFTER
    // the fail, where `pending[id]` is already gone and answers `false` for a
    // command the board ran.
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines[lines.length - 1], 'something runs after fail(), where the entry is already gone')
      .toMatch(/^fail\(id, FlipperError\.timeout\(label, sent: /)
    expect(codeOnly(swiftBody(gateway, 'private func fail(_ id: UInt32, _ error: Error)'), /cont/),
      'fail no longer clears the entry — then this ordering pin is measuring nothing')
      .toMatch(/pending\[id\] = nil/)
    // A missing entry means NOT sent. `?? true` reads the same in the happy path
    // and lies in exactly the state this cycle exists to describe.
    expect(t, 'a request with no entry left is now reported as sent').toMatch(/\?\? false/)
  })

  it('every envelope action that can fail is classified, by the switch and not by hand', () => {
    const reads = setOf('readOnlyActions')
    const alerts = setOf('alertActions')
    const known = new Set([...reads, ...alerts])
    expect(reads.some((r) => alerts.includes(r)), 'an action is both a read and an alert').toBe(false)
    // The cases that can reach the catch are the ones that `try`. Each of their
    // labels has to be classified deliberately; an unlisted one still gets the
    // careful sentence, but by accident rather than by decision.
    const throwing = envelopeCases().filter((c) => /\btry\b/.test(c.block))
    const labels = throwing.flatMap((c) => c.labels)
    expect(labels.length, 'no throwing envelope cases found — the slicer is stale')
      .toBeGreaterThan(5)
    for (const l of labels) {
      expect(known.has(l), `envelope action "${l}" can throw and is in neither list`).toBe(true)
    }
    // …and the actions that cannot throw are not silently promoted: `status`/`info`
    // are reads because being a read is a property of the action, and the listen
    // family answers without touching the board at all.
    const listenCase = envelopeCases().find((c) => c.labels.includes('listen'))
    expect(listenCase, 'the capture refusal case is gone').toBeTruthy()
    expect(/\btry\b/.test(listenCase!.block), 'the capture refusal can throw now — classify it')
      .toBe(false)
    // ⚠️ Two followers can agree with each other and both be wrong, so the static
    // list is pinned to the SWITCH — the thing that decides what actually beeps.
    const alertCase = envelopeCases().find((c) => /fg\.alert\(\)/.test(c.block))
    expect(alertCase, 'no envelope case calls fg.alert() — re-read both files').toBeTruthy()
    expect(alertCase!.labels.slice().sort(),
      'alertActions and the envelope disagree about which actions a person can hear')
      .toEqual(alerts.slice().sort())
    // No aspirational entries either. A verb no surface sends is a classification
    // nobody chose — and the one that would hurt is a `delete` typed into the READS
    // by somebody tidying, where it would answer "this only looks at the board".
    const surfaces = new Set([
      ...envelopeCases().flatMap((c) => c.labels),
      ...Array.from(codeOnly(panel, /actionFailed/).matchAll(/action: "(\w+)"/g), (m) => m[1]),
      ...Array.from(codeOnly(backend, /action: 'status'/).matchAll(/\{ action: '(\w+)'/g), (m) => m[1]),
    ])
    for (const a of Array.from(known)) {
      expect(surfaces.has(a), `"${a}" is classified but nothing sends it — who is it for?`).toBe(true)
    }
  })

  it('the phone and the backend agree about which actions a person can perceive', () => {
    // The third party both follow: what the backend actually SENDS. c29 decided
    // perceivability once in `bleStillQueued`; this cycle decided it again on the
    // phone. Two layers, one fact — so if they ever disagree, one of them promises
    // a beep the other calls silence, and the reader gets whichever arrives.
    const alerts = setOf('alertActions')
    const known = new Set([...setOf('readOnlyActions'), ...alerts])
    const sends = Array.from(new Set(Array.from(
      codeOnly(backend, /action: 'status'/).matchAll(/\{ action: '(\w+)'/g), (m) => m[1])))
    expect(sends.length, 'no ble actions found in the backend — the extraction is broken')
      .toBeGreaterThan(2)
    for (const a of sends) {
      expect(known.has(a), `the backend sends "${a}" and the phone has no class for it`).toBe(true)
      const backendListens = /listen/i.test(flipperTools.bleStillQueued(a, 'x'))
      expect(alerts.includes(a),
        `"${a}": the backend says listen=${backendListens}, the phone says ${alerts.includes(a)}`)
        .toBe(backendListens)
    }
  })

  it('one sentence-maker, so the room and the agent hear the same story about one beep', () => {
    // Derived over the file rather than a roster of call sites: a new sheet with a
    // new `catch` inherits this pin instead of an exemption. Five catches route
    // through it today (alert, list, read, screen, press).
    const code = codeOnly(panel, /actionFailed/)
    expect(code, 'a panel catch shows a bare localizedDescription again')
      .not.toMatch(/localizedDescription/)
    const actions = Array.from(code.matchAll(/actionFailed\(\w+, action: "(\w+)"/g), (m) => m[1])
    expect(actions.length, 'the panel stopped routing its failures through actionFailed')
      .toBeGreaterThan(4)
    // The panel's own buttons include two actions in NEITHER list, and that is the
    // polarity earning its keep: they take the careful arm today, so the choice is
    // exercised by shipped code and not only by a future `delete`.
    const known = new Set([...setOf('readOnlyActions'), ...setOf('alertActions')])
    expect(actions.filter((a) => !known.has(a)).sort(),
      'the unclassified panel actions changed — check they still want the careful sentence')
      .toEqual(['press', 'screen'])
    // The relay reply passes the LIVE action: a fixed 'alert' would promise a beep
    // for a listing, and a fixed 'read' would drop the beep's "listen first".
    const relay = codeOnly(handler(), /actionFailed/)
    expect(relay).toMatch(/actionFailed\(error, action: action, for: \.relayReply\)/)
    expect(relay, 'the relay reply hard-codes the action it reports on')
      .not.toMatch(/actionFailed\([^)]*action: "/)
    expect(relay, 'the relay catch shows a bare description again').not.toMatch(/localizedDescription/)
    const body = codeOnly(swiftBody(gateway, 'static func actionFailed('), /afterUnconfirmed/)
    // ⚠️ The flag gates the clause. Dropping it makes the clause unconditional, and
    // "the board has the command" is then printed over a command that was never
    // sent — the old defect inverted, which is worse: it invents an effect.
    //
    // ⚠️⚠️ c30 wrote this as `if case FlipperError.timeout(_, let sent) = error, sent`,
    // and THAT LINE is what c31 had to undo: naming one case answers the question
    // for that case and silently answers "no" for every other terminator. The
    // decision now belongs to the error (`mayHaveRun`, exhaustive), so a case added
    // later cannot reach this line without having decided. See the c31 block below.
    expect(body).toMatch(/if let \w+ = error as\? FlipperError, \w+\.mayHaveRun \{/)
    expect(body, 'actionFailed decides from one case again instead of asking the error')
      .not.toMatch(/if case FlipperError\./)
    // Every other error keeps its own words: `.noRoom` already says the command was
    // NOT sent, and `.refused` is the credential guard turning down a folder of
    // passports — a sentence, not a failure code.
    expect(body, 'actionFailed started deciding per error kind — it has exactly one exception')
      .not.toMatch(/noRoom|refused|malformed/)
    expect(body.trim().endsWith('return text'),
      'the fall-through no longer returns the error verbatim').toBe(true)
  })

  it('only the action somebody can hear asks anybody to listen', () => {
    // The class comes out of the READS, positively. `let reads = !alertActions…`
    // is the same body with the polarity flipped, and it reads identically today
    // while turning every future verb into "nothing changed, ask again for free".
    const head = codeOnly(after(), /let reads/)
    expect(head, 'the read class is no longer read out of readOnlyActions')
      .toMatch(/let reads = readOnlyActions\.contains\(a\)/)
    expect(head, 'the classification was inverted into an effects allow-list')
      .not.toMatch(/let reads = !/)
    const relay = arm('.relayReply')
    const sheet = arm('.panelSheet')
    const all: string[] = []
    for (const [who, a] of [['relay', relay], ['sheet', sheet]] as const) {
      // ⚠️ Ordered: the read is the EARLY return, so an unclassified action falls
      // PAST it into the careful arm. Inverted — an allow-list of effects — the new
      // verb would inherit "nothing changed, asking again is free", which is the
      // sentence you least want in front of a `delete`. Hazard 25(a).
      const iReads = a.indexOf('if reads')
      const iEffects = a.indexOf('return perceivable')
      expect(iReads, `${who}: the read branch is gone`).toBeGreaterThan(-1)
      expect(iEffects, `${who}: the effects branch is gone`).toBeGreaterThan(iReads)
      expect(a, `${who}: the classification was inverted into an effects allow-list`)
        .not.toMatch(/!reads|!readOnlyActions/)
      const said = Array.from(a.matchAll(/"([^"]*)"/g), (m) => m[1])
      expect(said.length, `${who} no longer has three sentences`).toBe(3)
      const [read, heard, effect] = said
      all.push(...said)
      expect(read, `${who}: a listing asks somebody to listen`).not.toMatch(/listen/i)
      expect(read, `${who}: the read arm no longer says the board is unchanged`).toMatch(/Nothing on/)
      expect(heard, `${who}: the beep that may already have sounded is not announced`)
        .toMatch(/listen/i)
      expect(effect, `${who}: an unclassified action is told to listen for nothing`)
        .not.toMatch(/listen/i)
      expect(effect, `${who}: an unclassified action reads as harmless`).toMatch(/may/)
      for (const s of [heard, effect]) {
        expect(s, `${who}: an action that changes the board claims nothing changed`)
          .not.toMatch(/Nothing on|costs nothing/)
      }
    }
    // Six sentences, no two the same: one that fits both audiences is one written
    // for neither — this file's oldest lesson, and `tooBig`'s whole reason.
    expect(new Set(all).size, 'an arm is reusing another audience’s sentence').toBe(6)
    // The agent has no thumb. The person holding the phone has no relay, and is
    // standing next to the board.
    expect(relay, 'the relay reply tells the agent to tap something').not.toMatch(/tap/i)
    expect(relay, 'nothing warns the agent that asking again re-alerts').toMatch(/SECOND alert/)
    expect(sheet, 'the panel does not say a second tap is a second alert').toMatch(/second alert/i)
    expect(sheet, 'the panel sheet mentions a relay its reader is not using')
      .not.toMatch(/relay|agent/i)
  })
})

/**
 * 🐬🔌 c31 — the OTHER two ways a request ends with no answer.
 *
 * c30 taught `FlipperError.timeout` to say which of two worlds it fired in: the
 * frame was still queued (the board never saw it) or the bytes went out and only
 * the reply is missing. It left the decision in an `if case FlipperError.timeout`
 * at the call site — and that shape answers the question for the case it names
 * while silently answering "no" for every other terminator.
 *
 * There are three. The timer is the one nobody's acceptance run reaches. The other
 * two are `linkLost()` (a disconnect: the phone left the room, Bluetooth went off,
 * the board powered down) and `desync()` (the inbound stream lost its place), and
 * both fail everything in flight through `failAllPending`, which took a single
 * error VALUE — so `Pending.sent` sat in the dictionary being emptied, one line
 * away, unread. A constant standing in for a variable: c7's shape at the error
 * layer, invisible for the same reason, because the call site reads perfectly.
 *
 * What it cost is the sentence on P5's own acceptance run. That run is "pair it,
 * unplug the cable, WALK AWAY, ask from web chat" — and walking away with a beep in
 * flight is precisely a disconnect. The board sounds; the phone answers "No Flipper
 * is linked to this phone over Bluetooth", whose only reading is "so nothing
 * happened". The obvious response is to ask again (a SECOND alert), and the remedy
 * the sentence suggests is the pairing screen — one row above "Forget all paired
 * devices", the one button in this whole feature that cannot be undone from the
 * phone. `.notLinked` is a promise that the board is untouched, and every other
 * raise of it keeps that promise; this one broke it.
 *
 * So the fix is not another `if case`. The error answers for itself — `mayHaveRun`,
 * a switch with no `default:`, so a case added later cannot compile until somebody
 * decides which side of it that case is on. That is a guarantee no test in this
 * file can make, which is the point: c30 is proof that a per-case decision written
 * at a call site does not generalise, and proof that the suite will certify it.
 * This block's own job is the part the compiler can't see — that each terminator
 * hands over the fact it alone knows, and that the definite noes stay definite.
 */
describe('a link that dropped is not a link that was never there', () => {
  const enumBody = () => codeOnly(swiftBody(gateway, 'enum FlipperError: LocalizedError'),
                                  /case notLinked/)
  const descBody = () => codeOnly(swiftBody(gateway, 'var errorDescription: String?'), /notLinked/)
  const mayBody = () => codeOnly(swiftBody(gateway, 'var mayHaveRun: Bool'), /switch self/)
  const writeBody = () => codeOnly(swiftBody(gateway, 'private func writeFrame('), /waitForRoom/)
  const allBody = () => codeOnly(swiftBody(gateway, 'private func failAllPending('),
                                 /pending = \[:\]/)

  /** Every case of `enum FlipperError`, out of the enum itself. */
  const cases = (): string[] => {
    // `case .foo:` inside the two switches starts with a dot, so `(\w+)` right after
    // `case ` picks up declarations only.
    const out = Array.from(enumBody().matchAll(/^\s*case (\w+)/gm), (m) => m[1])
    expect(out.length, 'no FlipperError cases found — this derivation is stale')
      .toBeGreaterThan(5)
    return out
  }

  /**
   * Every arm of `mayHaveRun`: the cases it names, and what it answers.
   *
   * Derived, because the question is "does EVERY case have an answer" and a list
   * typed in here is the c22→c23 wound again — the census would keep passing while
   * the case it forgot inherited whatever a `default:` said.
   */
  const mayArms = (): { names: string[], answer: string }[] => {
    const out = Array.from(mayBody().matchAll(/\n\s*case ([^\n:]+): return ([^\n]+)/g),
                           (m) => ({
                             names: Array.from(m[1].matchAll(/\.(\w+)/g), (x) => x[1]),
                             answer: m[2].trim(),
                           }))
    expect(out.length, 'no mayHaveRun arms found — this slicer is stale').toBeGreaterThan(2)
    return out
  }

  /** The one arm that answers for a case, or a failure naming the case. */
  const armFor = (c: string) => {
    const hit = mayArms().filter((a) => a.names.includes(c))
    expect(hit.length, `${c} has ${hit.length} arms in mayHaveRun — it needs exactly one`).toBe(1)
    return hit[0]
  }

  it('every way a request can end without an answer carries whether it was sent', () => {
    // ⚠️ THE CENSUS, derived from the raise sites rather than named here. c30's whole
    // omission was that the timer looked like the only way a request ends unanswered,
    // and nothing anywhere enumerated the others. Two of the three are `failAllPending`
    // — which is why they were easy to miss: they are not per-request code.
    const src = codeOnly(gateway, /failAllPending/)
    const raised = Array.from(
      src.matchAll(/(?:fail\(id, |failAllPending \{ )FlipperError\.(\w+)/g), (m) => m[1])
    expect(Array.from(new Set(raised)).sort(),
      'a new way to end a request appeared — does its reader learn whether the board acted?')
      .toEqual(['desynced', 'linkDropped', 'noRoom', 'notLinked', 'timeout'])
    // Of those, the two that end a request BEFORE anything is written are allowed to
    // be constants; every other one has to carry the flag.
    for (const c of raised) {
      if (c === 'noRoom' || c === 'notLinked') continue
      expect(new RegExp(`case ${c}\\([^)]*sent: Bool`).test(enumBody()),
        `${c} ends a request in flight without carrying whether it was sent`).toBe(true)
    }
    // And the clause is no longer named after the timer. The name is not cosmetic:
    // `afterTimeout` is what made two of these three terminators look out of scope.
    // Comments stripped, or this reds on the doc line that explains the rename.
    expect(codeOnly(gateway, /afterUnconfirmed/),
      'the clause is named for the timer again, which is what hid the other two')
      .not.toMatch(/afterTimeout/)
  })

  it('the error answers for itself, exhaustively, so a new case cannot stay silent', () => {
    const body = mayBody()
    // ⚠️ The load-bearing assertion of this cycle, and the reason it is a `switch`
    // and not a lookup: with no `default:`, Swift refuses to build until a new case
    // has an answer. A `default: return false` would compile forever and quietly
    // hand every future terminator the harmless world — which is exactly what the
    // `if case` at the call site was doing.
    expect(body, 'mayHaveRun grew a default: — a case added later inherits an answer nobody chose')
      .not.toMatch(/\bdefault\s*:/)
    for (const c of cases()) armFor(c)
    // A case that carries the fact must ANSWER FROM IT. A constant here is this
    // cycle's own defect, one level down, and it would read just as well.
    const carries = cases().filter((c) => new RegExp(`case ${c}\\([^)]*sent: Bool`).test(enumBody()))
    expect(carries.sort(), 'the set of errors carrying `sent` changed')
      .toEqual(['desynced', 'linkDropped', 'timeout'])
    for (const c of carries) {
      expect(armFor(c).answer, `${c} carries sent and then ignores it`).toBe('sent')
    }
    // The definite noes, each from a different party: the board said it did not do it,
    // its buffer never took the frame, there was no link, the credential guard
    // refused. "It may have run" over any of those invents an effect.
    for (const c of ['status', 'noRoom', 'notLinked', 'refused']) {
      expect(armFor(c).answer, `${c} started admitting the board may have run the command`)
        .toBe('false')
    }
    // And the one that is not a terminator at all: a malformed answer is an ANSWER.
    expect(armFor('malformed').answer, 'a parsed-and-failed answer is a frame that arrived')
      .toBe('true')
  })

  it('"no Flipper is linked" is only said where nothing left the phone', () => {
    // ⚠️ Hazard 30: the case is STATE, not wording, so its legitimate raise is pinned
    // POSITIVELY — the fix is not "stop saying this", it is "say it only where it is
    // true". One site, and it is the link re-check inside `writeFrame`.
    const sites = Array.from(codeOnly(gateway, /notLinked/).matchAll(/FlipperError\.notLinked/g))
    expect(sites.length, '.notLinked is raised somewhere new — was anything sent there?').toBe(1)
    const w = writeBody()
    expect(w, 'the one .notLinked no longer sits in writeFrame').toMatch(/FlipperError\.notLinked/)
    // Before the commit point, so the promise it makes is one the code can keep.
    const flag = w.indexOf('pending[id]?.sent = true')
    expect(flag, 'writeFrame no longer records where the send stops being cancellable')
      .toBeGreaterThan(-1)
    expect(w.indexOf('FlipperError.notLinked'),
      '.notLinked is raised after the frame was committed to the board').toBeLessThan(flag)
    // The sentence keeps its promise, and the sentence is the reason this matters.
    expect(codeOnly(swiftCase(descBody(), '.notLinked'), /return "/))
      .toMatch(/No Flipper is linked to this phone/)
  })

  it('a dropped link says whether the board already had the command', () => {
    const arm = codeOnly(swiftCase(descBody(), '.linkDropped(let sent)'), /return sent/)
    const said = Array.from(arm.matchAll(/"([^"]*)"/g), (m) => m[1])
    expect(said.length, 'the two worlds collapsed back into one sentence').toBe(2)
    const [sent, queued] = said
    // The sent arm's whole job: a beep in the next room is not a beep that never
    // happened, however the link died.
    expect(sent, 'the sent arm stops saying the request reached the board')
      .toMatch(/did reach the board/)
    expect(queued, 'the queued arm stops saying the board never saw it')
      .toMatch(/never saw it/)
    expect(sent, 'the sent arm claims the board never saw it').not.toMatch(/never saw it/)
    // ⚠️ And neither arm may fall back to the sentence this cycle took away from it.
    expect(arm, 'a dropped link reports itself as a link that never existed')
      .not.toMatch(/No Flipper is linked/)
    // The teardown reaches it per-request, not with one shared value. `stop()` and a
    // Bluetooth toggle route through `linkLost()` too, so all three read the same.
    expect(codeOnly(swiftBody(gateway, 'private func linkLost()'), /failAllPending/))
      .toMatch(/failAllPending \{ FlipperError\.linkDropped\(sent: \$0\) \}/)
  })

  it('a stream that lost its place is not an answer that failed to parse', () => {
    const d = codeOnly(swiftBody(gateway, 'private func desync('), /failAllPending/)
    expect(d).toMatch(/failAllPending \{ FlipperError\.desynced\(sent: \$0\) \}/)
    // `.malformed` says an answer ARRIVED and would not parse, which is a statement
    // that the board acted. A desync is the opposite claim: the answer may not exist
    // yet, so borrowing that case asserted the effect for free.
    expect(d, 'desync reports a malformed ANSWER for a request that may have none')
      .not.toMatch(/malformed/)
    // Its own two worlds, for the same reason the dropped link has two: the buffer
    // being thrown away may hold the answer to a command the board already ran.
    const arm = codeOnly(swiftCase(descBody(), '.desynced(let sent)'), /return sent/)
    const said = Array.from(arm.matchAll(/"([^"]*)"/g), (m) => m[1])
    expect(said.length, 'the desync arms collapsed into one sentence').toBe(2)
    expect(said[0], 'the sent arm stops saying the request reached the board')
      .toMatch(/did reach the board/)
    expect(said[1], 'the queued arm stops saying the board never saw it').toMatch(/never saw it/)
    // …and the case it stopped borrowing still means what it says. Both raises are a
    // frame in hand that failed to parse.
    const parsed = Array.from(codeOnly(gateway, /malformed/)
      .matchAll(/FlipperError\.malformed\("([^"]*)"\)/g), (m) => m[1])
    expect(parsed.sort(), '.malformed is raised somewhere new — did a frame really arrive?')
      .toEqual(['a checksum', 'free space'])
  })

  it('one error value cannot carry a per-request fact', () => {
    // The signature is the fix. With `_ error: Error`, every waiter is handed the
    // same sentence by construction — no amount of care at the call site can make a
    // beep that went out and a beep still queued read differently.
    const sig = gatewaySignatures().find((s) => s.includes('failAllPending'))
    expect(sig, 'failAllPending is gone — who fails the requests in flight now?').toBeDefined()
    expect(sig, 'failAllPending takes one error value again, so every waiter hears the same thing')
      .toMatch(/\(Bool\) -> Error/)
    const body = allBody()
    // Read inside the lock, with the entry that is about to be deleted: afterwards
    // there is nothing left to ask. Same reason `failTimedOut` reads the flag in the
    // call that ends the request.
    const flag = body.indexOf('p.sent')
    expect(flag, 'the flag is no longer read out of the pending entry').toBeGreaterThan(-1)
    expect(flag, 'sent is read after the entries were cleared — every request reads unsent')
      .toBeLessThan(body.indexOf('pending = [:]'))
    // And each waiter gets the error built from ITS OWN flag, outside the lock.
    expect(body, 'the per-request flag is collected and then not used')
      .toMatch(/resume\(throwing: \w+\(sent\)\)/)
  })
})

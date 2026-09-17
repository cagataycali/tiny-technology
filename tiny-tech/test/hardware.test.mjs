/**
 * flipper.ts + computer.ts — the pure, hardware-free parts.
 *
 * Serial I/O and CGEvent posting need a plugged-in Flipper and a logged-in Mac
 * session, so they're exercised by hand rather than here. What IS testable is
 * everything that decides what gets sent and where a click lands: CLI output
 * parsing, port filtering, and the screenshot→screen coordinate transform that
 * makes clicks land on what the model actually saw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  parseStorageList, parseKeyValues, findFlipperPorts,
  clampSecs, isSensitiveSweep, appBusyHelp, GPIO_PINS, IR_PROTOCOLS,
  makeFlipperTool,
} = await import('../dist/agent/flipper.js')
const { imageToScreen, __setLastShotForTest } = await import('../dist/agent/computer.js')

// ── flipper: storage list parsing ───────────────────────────────────────────

test('parseStorageList splits dirs from files, keeping the size as printed', () => {
  const out = parseStorageList(`\t[D] subghz
\t[D] nfc
\t[F] settings.txt 128b
\t[F] dump.bin 8192b
`)
  // Size stays the device's own string ('128b') — it's only ever displayed.
  assert.deepEqual(out, [
    { type: 'dir', name: 'subghz' },
    { type: 'dir', name: 'nfc' },
    { type: 'file', name: 'settings.txt', size: '128b' },
    { type: 'file', name: 'dump.bin', size: '8192b' },
  ])
})

test('parseStorageList marks a file with no size as unknown', () => {
  assert.deepEqual(parseStorageList('\t[F] weird.bin\n'), [
    { type: 'file', name: 'weird.bin', size: '?' },
  ])
})

test('parseStorageList treats Empty and errors as no entries', () => {
  assert.deepEqual(parseStorageList('\tEmpty\n'), [])
  assert.deepEqual(parseStorageList('Storage error: file/dir not exist\n'), [])
})

test('parseStorageList tolerates names containing spaces', () => {
  const out = parseStorageList('\t[F] my key file.nfc 44b\n')
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'my key file.nfc')
  assert.equal(out[0].size, '44b')
})

// ── flipper: key/value parsing ──────────────────────────────────────────────

test('parseKeyValues reads colon-delimited device info', () => {
  const kv = parseKeyValues(`hardware_model: Flipper Zero
hardware_name: cagatay
radio_ble_mac: 43320026E180
protobuf_version_minor: 23
`)
  assert.equal(kv.hardware_model, 'Flipper Zero')
  assert.equal(kv.hardware_name, 'cagatay')
  assert.equal(kv.radio_ble_mac, '43320026E180')
  assert.equal(kv.protobuf_version_minor, '23')
})

test('parseKeyValues keeps values that contain colons', () => {
  const kv = parseKeyValues('time: 12:34:56\n')
  assert.equal(kv.time, '12:34:56')
})

test('parseKeyValues ignores lines with no separator', () => {
  const kv = parseKeyValues('banner line with no colon\nfoo: bar\n')
  assert.deepEqual(Object.keys(kv), ['foo'])
})

test('parseKeyValues keeps a bare heading as an empty value, not a crash', () => {
  // 'Device info:' is a real header in device_info output; it parses to an
  // empty string rather than being dropped, which display code tolerates.
  const kv = parseKeyValues('Device info:\nfoo: bar\n')
  assert.equal(kv['Device info'], '')
  assert.equal(kv.foo, 'bar')
})

// ── flipper: port discovery ─────────────────────────────────────────────────

test('findFlipperPorts prefers cu.* and ignores unrelated devices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-dev-'))
  try {
    for (const n of [
      'cu.usbmodemflip_Cagatay1',
      'tty.usbmodemflip_Cagatay1', // same device, blocking variant
      'cu.Bluetooth-Incoming-Port',
      'cu.usbserial-1420',
      'random',
    ]) writeFileSync(join(dir, n), '')

    const ports = findFlipperPorts(dir)
    assert.deepEqual(ports, [join(dir, 'cu.usbmodemflip_Cagatay1')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findFlipperPorts returns nothing when no flipper is attached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-dev-'))
  try {
    writeFileSync(join(dir, 'cu.usbserial-1420'), '')
    assert.deepEqual(findFlipperPorts(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findFlipperPorts survives an unreadable directory', () => {
  assert.deepEqual(findFlipperPorts('/nonexistent-dev-dir-xyz'), [])
})

// ── flipper: listen-window clamp ────────────────────────────────────────────
//
// The receive actions hold the serial lock (and the radio) for their whole
// window, so an unbounded `duration` would block every other tool on the node.

test('clampSecs bounds the listen window and falls back to the default', () => {
  assert.equal(clampSecs(undefined, 5, 30), 5)
  assert.equal(clampSecs(3, 5, 30), 3)
  assert.equal(clampSecs(999, 5, 30), 30, 'must not hold the radio for 999s')
  assert.equal(clampSecs(0, 5, 30), 1, 'a zero-second listen never sees anything')
  assert.equal(clampSecs(-4, 5, 30), 1)
  assert.equal(clampSecs(NaN, 5, 30), 5)
  assert.equal(clampSecs(2.6, 5, 30), 3, 'rounded, not truncated')
})

// ── flipper: the credential-folder guard ────────────────────────────────────
//
// This user's /ext/nfc holds passports, national IDs and bank cards. Reading one
// by name is a normal request; walking the folder into a chat transcript copies
// all of it to the model provider and the conversation store.

test('isSensitiveSweep blocks credential DIRECTORIES, not files inside them', () => {
  for (const d of ['/ext/nfc', '/ext/nfc/', '/EXT/NFC', '/ext/lfrfid', '/ext/ibutton', '/ext/u2f', '/ext/subghz']) {
    assert.equal(isSensitiveSweep(d), true, `${d} should be guarded`)
  }
  // A specific card the user asked for is still readable — the guard is about
  // blind enumeration, not about making saved tags unreachable.
  for (const f of ['/ext/nfc/Tr_passport.nfc', '/ext/subghz/gate.sub', '/ext/infrared', '/ext', '']) {
    assert.equal(isSensitiveSweep(f), false, `${f} should not be guarded`)
  }
})

// ── flipper: the busy-app dead end ──────────────────────────────────────────
//
// Measured on unlshd-075: `loader open NFC` starts an app, this firmware's
// loader has NO close, and `input send back {short,long,press,release}` (even a
// 12-event burst) does not dismiss it. Every app-claiming command then answers
// "Other application is running" until `power reboot`.

test('appBusyHelp names the stuck-app state and the only remedy', () => {
  const help = appBusyHelp('rfid_read')
  assert.match(help, /rfid_read/, 'says which command was refused')
  assert.match(help, /Back/, 'tells the human the physical way out')
  assert.match(help, /power reboot/, 'gives the unattended remedy')
  assert.match(help, /no `loader close`/, 'explains why a software close is not offered')
})

// ── flipper: actions that must NOT reach the hardware ───────────────────────

test('nfc scanning is refused with an explanation, not a fake empty result', async () => {
  const t = makeFlipperTool()
  for (const action of ['nfc_detect', 'nfc_read']) {
    const out = await t._callback({ action })
    // The old nfc_detect ran `nfc detect` and returned the firmware's usage
    // blob verbatim, so "no tag present" and "this firmware cannot scan" were
    // the same answer. It must never look like a completed scan.
    assert.match(out, /not available/i, `${action} must say it cannot scan`)
    assert.match(out, /\/ext\/nfc/, 'points at where saved tags actually live')
    assert.doesNotMatch(out, /Cmd list/, 'must not echo the raw usage blob')
  }
})

test('app_start refuses instead of stranding the CLI', async () => {
  const t = makeFlipperTool()
  const out = await t._callback({ action: 'app_start', command: 'NFC' })
  assert.match(out, /disabled on purpose/i)
  assert.match(out, /power reboot/, 'says how to recover an already-stuck device')
})

test('ir_tx will not pretend a file path is transmittable', async () => {
  const t = makeFlipperTool()
  // `ir tx "/ext/infrared/Remote.ir"` answers "Wrong arguments." on this
  // firmware — it never transmits. The old tool reported that as a success line.
  const out = await t._callback({ action: 'ir_tx', path: '/ext/infrared/Remote.ir' })
  assert.match(out, /protocol/i, 'states what ir_tx actually needs')
  assert.match(out, /NOT accepted/, 'is explicit that a path does not work')
  assert.match(out, /ir_universal/, 'points at the action that does replay saved remotes')
})

test('an unknown IR protocol is rejected locally, before transmitting', async () => {
  const t = makeFlipperTool()
  const out = await t._callback({ action: 'ir_tx', protocol: 'NOPE', address: '00', command: '15' })
  assert.match(out, /unknown IR protocol/i)
  assert.ok(IR_PROTOCOLS.includes('NEC') && IR_PROTOCOLS.includes('Samsung32'))
})

test('gpio actions reject pins the firmware does not have', async () => {
  const t = makeFlipperTool()
  for (const action of ['gpio_read', 'gpio_set']) {
    const out = await t._callback({ action, path: 'PZ9', data: '1' })
    assert.match(out, /need a pin/, `${action} must not send a bogus pin`)
  }
  // Verbatim from the firmware's own error text.
  assert.deepEqual([...GPIO_PINS], ['PA7', 'PA6', 'PA4', 'PB3', 'PB2', 'PC3', 'PC1', 'PC0'])
})

test('the tool describes the receive actions and the transmit constraint', () => {
  const d = makeFlipperTool().toolSpec.description
  for (const a of ['ir_rx', 'subghz_rx', 'rfid_read', 'ikey_read', 'onewire_search', 'gpio_read', 'i2c_scan', 'js', 'input_dump', 'input_send', 'subghz_chat']) {
    assert.match(d, new RegExp(a), `description must advertise ${a}`)
  }
  assert.match(d, /only transmit what the user owns/i, 'transmission is physical action on the world')
  assert.match(d, /never enumerate/i, 'saved credentials are not for bulk reading')
})

// ── computer: screenshot → screen coordinates ───────────────────────────────

test('imageToScreen is identity before any screenshot', () => {
  __setLastShotForTest(null)
  assert.deepEqual(imageToScreen(400, 300), { x: 400, y: 300 })
})

test('imageToScreen scales a downsampled full-screen shot', () => {
  // 3008-point screen delivered at 1600px → 1.88x
  __setLastShotForTest({ originX: 0, originY: 0, scale: 3008 / 1600 })
  assert.deepEqual(imageToScreen(800, 450), { x: 1504, y: 846 })
  assert.deepEqual(imageToScreen(0, 0), { x: 0, y: 0 })
})

test('imageToScreen offsets a region shot by its origin', () => {
  __setLastShotForTest({ originX: 500, originY: 400, scale: 1 })
  assert.deepEqual(imageToScreen(0, 0), { x: 500, y: 400 })
  assert.deepEqual(imageToScreen(120, 60), { x: 620, y: 460 })
})

test('imageToScreen combines region origin and scaling', () => {
  __setLastShotForTest({ originX: 740, originY: 220, scale: 2 })
  assert.deepEqual(imageToScreen(100, 50), { x: 940, y: 320 })
})

test('imageToScreen rounds to whole points', () => {
  __setLastShotForTest({ originX: 0, originY: 0, scale: 1.88 })
  const p = imageToScreen(333, 111)
  assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y))
  assert.deepEqual(p, { x: 626, y: 209 })
})

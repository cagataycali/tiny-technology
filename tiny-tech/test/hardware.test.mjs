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

const { parseStorageList, parseKeyValues, findFlipperPorts } = await import('../dist/agent/flipper.js')
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

/**
 * use_image — the pure decisions: format from bytes, size from header, the
 * attach/convert/shrink policy, and the one rule that costs money when broken
 * (never hand sips an edge larger than the image's own — it upscales).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { sniffFormat, measureHeader, plan, sipsArgs, prepareFile, listImages, MAX_EDGE, MAX_BYTES, makeImageTool } =
  await import('../dist/agent/image.js')

const hex = (s) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'))

test('format is sniffed from bytes, never the extension', () => {
  assert.equal(sniffFormat(hex('89504e470d0a1a0a')), 'png')
  assert.equal(sniffFormat(hex('ffd8ffe000104a46')), 'jpeg')
  assert.equal(sniffFormat(hex('474946383961')), 'gif')
  assert.equal(sniffFormat(hex('52494646 00000000 57454250')), 'webp')
  assert.equal(sniffFormat(hex('00000018 66747970 68656963')), 'heic')
  assert.equal(sniffFormat(hex('4d4d002a')), 'tiff')
  assert.equal(sniffFormat(hex('424d')), 'bmp')
  assert.equal(sniffFormat(hex('00000018 66747970 69736f6d')), null) // mp4 brand
  assert.equal(sniffFormat(hex('255044462d312e')), null) // %PDF
})

test('dimensions from headers: png, gif, jpeg (height before width)', () => {
  assert.deepEqual(measureHeader(hex('89504e470d0a1a0a 0000000d 49484452 000000ae 000000bc'), 'png'), { width: 174, height: 188 })
  assert.deepEqual(measureHeader(hex('474946383761 6000 4000'), 'gif'), { width: 96, height: 64 })
  // SOF0 behind an APP0: ffd8 | ffe0 len=16 ... | ffc0 0011 08 012c 01f4
  const jpg = hex('ffd8 ffe0 0010 4a46494600010100000100010000 ffc0 0011 08 012c 01f4 03')
  assert.deepEqual(measureHeader(jpg, 'jpeg'), { width: 500, height: 300 })
  // SOS before any SOF → cannot be measured, not a guess
  assert.equal(measureHeader(hex('ffd8 ffda 0002'), 'jpeg'), null)
})

test('policy: format disqualifier first, then edge, then bytes; never upscale', () => {
  assert.deepEqual(plan('png', { width: 174, height: 188 }, 6000), { kind: 'attach', format: 'png' })
  assert.deepEqual(plan('jpg', { width: 200, height: 100 }, 6000), { kind: 'attach', format: 'jpeg' })
  assert.deepEqual(plan('heic', { width: 4032, height: 3024 }, 2e6), { kind: 'convert', to: 'jpeg', edge: MAX_EDGE })
  assert.deepEqual(plan('heic', null, 2e6), { kind: 'convert', to: 'jpeg', edge: null })
  assert.deepEqual(plan('jpeg', { width: 6016, height: 3384 }, 1e6), { kind: 'shrink', format: 'jpeg', edge: MAX_EDGE })
  // over the byte cap at a small size: re-encode at its OWN edge, not MAX_EDGE
  assert.deepEqual(plan('png', { width: 800, height: 600 }, MAX_BYTES + 1), { kind: 'shrink', format: 'png', edge: 800 })
  // caller's smaller max_edge applies
  assert.deepEqual(plan('jpeg', { width: 1024, height: 576 }, 5e4, 600), { kind: 'shrink', format: 'jpeg', edge: 600 })
})

test('sips argv: -Z only when shrinking, format flag only when converting', () => {
  assert.deepEqual(sipsArgs({ kind: 'attach', format: 'png' }, 'a', 'b'), ['a', '--out', 'b'])
  assert.deepEqual(sipsArgs({ kind: 'shrink', format: 'jpeg', edge: 1568 }, 'a', 'b'), ['-Z', '1568', 'a', '--out', 'b'])
  assert.deepEqual(sipsArgs({ kind: 'convert', to: 'jpeg', edge: null }, 'a', 'b'), ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', 'a', '--out', 'b'])
})

test('directory listing keeps only image extensions, sorted, no dotfiles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-img-'))
  for (const f of ['b.PNG', 'a.jpeg', 'notes.md', '.DS_Store', 'c.heic', 'clip.mp4']) fs.writeFileSync(path.join(dir, f), '')
  assert.deepEqual(listImages(dir).map((p) => path.basename(p)), ['a.jpeg', 'b.PNG', 'c.heic'])
  fs.rmSync(dir, { recursive: true })
})

test('a tiny png is attached byte-for-byte (no spawn, no upscale)', () => {
  // 1×1 png, 67 bytes
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const f = path.join(os.tmpdir(), `tiny-img-${process.pid}.png`)
  fs.writeFileSync(f, png)
  const shown = prepareFile(f)
  assert.equal(shown.format, 'png')
  assert.equal(Buffer.from(shown.base64, 'base64').length, png.length)
  assert.match(shown.note, /1×1px/)
  fs.unlinkSync(f)
})

test('the tool refuses non-images with the fix named, and returns blocks for images', async () => {
  const t = makeImageTool()
  const f = path.join(os.tmpdir(), `tiny-img-${process.pid}.txt`)
  fs.writeFileSync(f, 'hello')
  assert.match(await t._callback({ action: 'view', path: f }), /not an image I can show/)
  assert.match(await t._callback({ action: 'view', path: '/definitely/missing.png' }), /no such file/)
  const png = path.join(os.tmpdir(), `tiny-img-${process.pid}.png`)
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  const r = await t._callback({ action: 'view', paths: [png, f] })
  assert.ok(Array.isArray(r))
  assert.equal(r.length, 2)
  assert.equal(r[1].image.format, 'png')
  assert.match(r[0].text, /✗ .*not an image/)
  const info = await t._callback({ action: 'info', path: png })
  assert.match(info, /png\s+1×1/)
  fs.unlinkSync(f); fs.unlinkSync(png)
})

test('on a Mac with sips, a big jpeg comes back at the edge cap', { skip: os.platform() !== 'darwin' }, () => {
  const f = path.join(os.tmpdir(), `tiny-img-big-${process.pid}.jpg`)
  const png = path.join(os.tmpdir(), `tiny-img-seed-${process.pid}.png`)
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  execFileSync('sips', ['-z', '2000', '3000', '-s', 'format', 'jpeg', png, '--out', f], { stdio: 'ignore' })
  const shown = prepareFile(f, 600)
  const head = Buffer.from(shown.base64, 'base64').subarray(0, 65536)
  assert.deepEqual(measureHeader(head, 'jpeg'), { width: 600, height: 400 })
  assert.match(shown.note, /Resampled to 600px/)
  fs.unlinkSync(f); fs.unlinkSync(png)
})

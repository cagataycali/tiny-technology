/**
 * files.ts — attachment classification, caps, binary sniff.
 * Pure unit tests, no network, no creds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { fileToContentBlock, filesToContentBlocks } from '../dist/files.js'

const dir = mkdtempSync(join(tmpdir(), 'tiny-files-'))
const write = (name, data) => {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}

// Minimal valid 8x8 red PNG (same generator verified against PIL)
function crc32(buf) {
  let c, t = []
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  let r = 0xFFFFFFFF
  for (const b of buf) r = t[(r ^ b) & 0xFF] ^ (r >>> 8)
  return (r ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function redPng() {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(24)])
  for (let x = 0; x < 8; x++) row[1 + x * 3] = 255
  const raw = Buffer.concat(Array(8).fill(row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

test('png → image block with base64 bytes', () => {
  const b = fileToContentBlock(write('a.png', redPng()))
  assert.equal(b.image.format, 'png')
  assert.ok(b.image.source.bytes.length > 0)
  assert.doesNotThrow(() => Buffer.from(b.image.source.bytes, 'base64'))
})

test('jpg extension normalizes to jpeg format', () => {
  const b = fileToContentBlock(write('b.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])))
  assert.equal(b.image.format, 'jpeg')
})

test('pdf → document block with sanitized name', () => {
  const b = fileToContentBlock(write('my report (v2)!!.pdf', Buffer.from('%PDF-1.4 fake')))
  assert.equal(b.document.format, 'pdf')
  assert.ok(!/[!]/.test(b.document.name), 'name sanitized')
})

test('text file → inline text block', () => {
  const b = fileToContentBlock(write('notes.md', 'hello *world*'))
  assert.match(b.text, /hello \*world\*/)
  assert.match(b.text, /Attached file: notes.md/)
})

test('long text truncated at 50k chars', () => {
  const b = fileToContentBlock(write('big.txt', 'x'.repeat(60_000)))
  assert.match(b.text, /\[truncated\]/)
  assert.ok(b.text.length < 51_000)
})

test('extensionless binary rejected (null-byte sniff)', () => {
  const p = write('binfile', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]))
  assert.throws(() => fileToContentBlock(p), /binary file/)
})

test('extensionless text accepted', () => {
  const b = fileToContentBlock(write('LICENSE', 'MIT License\n'))
  assert.match(b.text, /MIT License/)
})

test('unsupported extension rejected with guidance', () => {
  assert.throws(() => fileToContentBlock(write('a.exe', Buffer.alloc(4))), /unsupported file type/)
})

test('oversized image rejected with size message', () => {
  const p = write('huge.png', Buffer.alloc(3_500_000))
  assert.throws(() => fileToContentBlock(p), /must be under/)
})

test('missing file throws ENOENT with path', () => {
  assert.throws(() => fileToContentBlock(join(dir, 'nope.png')), /ENOENT/)
})

test('total budget enforced across files', () => {
  const a = write('a1.pdf', Buffer.alloc(2_000_000))
  const b = write('a2.pdf', Buffer.alloc(2_000_000))
  assert.throws(() => filesToContentBlocks([a, b]), /combined/)
})

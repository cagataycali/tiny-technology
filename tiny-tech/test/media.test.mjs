/**
 * 🖼️ Images out of the local agent loop (loop item d-d).
 *
 * The daemon could already SEE a screen it captured — use_computer returns a
 * real image block. What it couldn't do was hand that picture to whoever asked
 * from somewhere else: invoke() flattened the turn to a string and relay-poller
 * replied with { result: "<text>" }, so "read the error on my laptop's screen",
 * asked through use_device, came back as the daemon's PROSE about an image the
 * cloud agent never saw.
 *
 * No screen, no network: harvesting runs over hand-built message shapes and the
 * uploader takes its poster as an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  harvestImages, uploadImages, buildRelayReply, imageBase64, base64Bytes,
  undeliveredNote, MAX_IMAGES_PER_REPLY, MAX_IMAGE_BYTES, IMAGE_CONTENT_TYPES,
} = await import('../dist/agent/media.js')

const b64 = (s) => Buffer.from(s).toString('base64')

/** A tool result the way computer.ts returns it (raw wrapped blocks). */
const shotMessage = (payload = 'PNGDATA', format = 'png') => ({
  role: 'user',
  content: [{
    toolResult: {
      toolUseId: 'tu1', status: 'success',
      content: [{ text: '🖥️ full screen' }, { image: { format, source: { bytes: b64(payload) } } }],
    },
  }],
})

// ── harvest: WHICH images belong in a reply ──────────────────────────────────

test('a screenshot in a tool result is harvested with its format and size', () => {
  const [img] = harvestImages([shotMessage('PNGDATA')])
  assert.equal(img.format, 'png')
  assert.equal(img.base64, b64('PNGDATA'))
  assert.equal(img.bytes, base64Bytes(b64('PNGDATA')))
})

test('SDK class instances harvest too — Uint8Array bytes, discriminated types', () => {
  // Live agent.messages hold ImageBlock/ToolResultBlock instances (bytes already
  // decoded); serialized history holds wrapped data. Both must work — which one
  // we get depends on how the turn was built.
  const msgs = [{
    content: [{
      type: 'toolResultBlock',
      content: [{ type: 'imageBlock', format: 'jpeg', source: { type: 'imageSourceBytes', bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) } }],
    }],
  }]
  const [img] = harvestImages(msgs)
  assert.equal(img.format, 'jpeg')
  assert.equal(Buffer.from(img.base64, 'base64').length, 6)
})

test('images the USER attached are NOT harvested — only what the turn produced', () => {
  // Echoing the asker's own picture back spends vision tokens to describe what
  // they just sent. Only tool results are new information.
  const msgs = [
    { role: 'user', content: [{ image: { format: 'png', source: { bytes: b64('ATTACHED') } } }, { text: 'what is this?' }] },
    { role: 'assistant', content: [{ text: 'a cat' }] },
  ]
  assert.deepEqual(harvestImages(msgs), [])
})

test('the NEWEST images win when a turn made more than the cap', () => {
  // An agent iterating on a screen shoots repeatedly; the last frame is the
  // answer, the earlier ones are the search.
  const msgs = ['one', 'two', 'three', 'four'].map((p) => shotMessage(p))
  const got = harvestImages(msgs)
  assert.equal(got.length, MAX_IMAGES_PER_REPLY)
  assert.deepEqual(got.map((i) => Buffer.from(i.base64, 'base64').toString()), ['three', 'four'])
})

test('a turn with no images harvests nothing (the common case stays free)', () => {
  assert.deepEqual(harvestImages([{ role: 'assistant', content: [{ text: 'disk is 42% full' }] }]), [])
  assert.deepEqual(harvestImages([]), [])
  assert.deepEqual(harvestImages(null), [])
  assert.deepEqual(harvestImages('nonsense'), [])
})

test('malformed and oversized blocks are skipped, never thrown on', () => {
  const junk = [
    { content: [{ toolResult: { content: null } }] },
    { content: [{ toolResult: { content: [{ image: null }, { image: { format: 'png' } }] } }] },
    { content: [{ toolResult: { content: [{ image: { format: 'tiff', source: { bytes: b64('x') } } }] } }] },
    { content: null },
    null,
  ]
  assert.deepEqual(harvestImages(junk), [])
  // Over the worker's own 6MB decode cap: dropped here, where we can say why,
  // instead of failing the upload remotely.
  const huge = { content: [{ toolResult: { content: [{ image: { format: 'png', source: { bytes: 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 100) } } }] } }] }
  assert.deepEqual(harvestImages([huge]), [])
})

test('an empty image source is not an image', () => {
  assert.equal(imageBase64({ bytes: '' }), null)
  assert.equal(imageBase64({ bytes: new Uint8Array(0) }), null)
  assert.equal(imageBase64({}), null)
  assert.equal(imageBase64(null), null)
})

// ── upload: bytes go to the media store ONCE, URLs travel ───────────────────

test('each image is POSTed to /api/media with the right contentType', async () => {
  const calls = []
  const out = await uploadImages(harvestImages([shotMessage('A'), shotMessage('B')]), async (path, body) => {
    calls.push({ path, body })
    return { ok: true, url: `https://plugin.tiny.technology/media/${calls.length}.png` }
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.path), ['/api/media', '/api/media'])
  assert.equal(calls[0].body.contentType, IMAGE_CONTENT_TYPES.png)
  assert.deepEqual(out, [
    { url: 'https://plugin.tiny.technology/media/1.png', format: 'png' },
    { url: 'https://plugin.tiny.technology/media/2.png', format: 'png' },
  ])
})

test('a failed upload costs THAT image, never the whole reply', async () => {
  // Text is the answer; a picture is a bonus. One 500 must not throw away both.
  let n = 0
  const out = await uploadImages(harvestImages([shotMessage('A'), shotMessage('B')]), async () => {
    if (++n === 1) throw new Error('R2 unavailable')
    return { url: 'https://plugin.tiny.technology/media/ok.png' }
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].url, 'https://plugin.tiny.technology/media/ok.png')
})

test('a store answering without a usable url yields no image (not a bad one)', async () => {
  for (const reply of [{}, { url: '' }, { url: 'not-a-url' }, { error: 'nope' }, null]) {
    assert.deepEqual(await uploadImages(harvestImages([shotMessage('A')]), async () => reply), [])
  }
})

test('jpg normalizes to jpeg — the block format the readers accept', async () => {
  const msgs = [shotMessage('J', 'jpg')]
  const out = await uploadImages(harvestImages(msgs), async () => ({ url: 'https://plugin.tiny.technology/media/x.jpg' }))
  assert.equal(out[0].format, 'jpeg')
})

test('undeliveredNote speaks only when a picture was actually lost', () => {
  assert.equal(undeliveredNote(0, 0), '')
  assert.equal(undeliveredNote(2, 2), '')
  assert.match(undeliveredNote(1, 0), /1 image from this run could not be uploaded/)
  assert.match(undeliveredNote(3, 1), /2 images/)
  assert.match(undeliveredNote(1, 0), /tiny-tech login/)
})

// ── the reply envelope: it has to FIT ───────────────────────────────────────

test('a small text reply is unchanged in shape (no images key when none)', () => {
  assert.deepEqual(JSON.parse(buildRelayReply('42% full')), { result: '42% full' })
})

test('hosted image urls ride alongside the text', () => {
  const p = JSON.parse(buildRelayReply('here is your screen', [{ url: 'https://x/media/a.png', format: 'png' }]))
  assert.equal(p.result, 'here is your screen')
  assert.deepEqual(p.images, [{ url: 'https://x/media/a.png', format: 'png' }])
})

test('the SERIALIZED payload fits the worker envelope — escaping grows text', () => {
  // The old code sliced to 8000 chars and THEN stringified: 8000 newlines
  // serialize to 16000 characters, over the worker's 8192-byte limit, so the
  // PATCH was rejected and the entire reply vanished — the asker just timed out.
  const payload = buildRelayReply('\n'.repeat(9000), [], 8000)
  assert.ok(payload.length <= 8000, `payload was ${payload.length}`)
  assert.equal(typeof JSON.parse(payload).result, 'string')
  assert.match(JSON.parse(payload).result, /…$/)
  // Same for quote-dense output (JSON escapes every one).
  const quotes = buildRelayReply('"'.repeat(9000), [], 8000)
  assert.ok(quotes.length <= 8000)
  // And for a 6-chars-per-character worst case (control chars → \u00XX).
  const ctrl = buildRelayReply(''.repeat(9000), [], 8000)
  assert.ok(ctrl.length <= 8000, `control-char payload was ${ctrl.length}`)
})

test('truncation keeps as much text as fits — it does not over-shear', () => {
  const payload = buildRelayReply('x'.repeat(20_000), [], 8000)
  const kept = JSON.parse(payload).result
  assert.ok(payload.length <= 8000)
  // Plain ASCII costs 1 char each, so we should be within a hair of the cap.
  assert.ok(kept.length > 7900, `only kept ${kept.length}`)
})

test('images survive the clamp — pixels cannot be re-derived from prose', () => {
  const imgs = [{ url: 'https://plugin.tiny.technology/media/a.png', format: 'png' }]
  const p = JSON.parse(buildRelayReply('y'.repeat(20_000), imgs, 8000))
  assert.deepEqual(p.images, imgs)
  assert.ok(p.result.length < 20_000)
})

test('more images than the cap are dropped at the envelope too', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ url: `https://x/media/${i}.png`, format: 'png' }))
  assert.equal(JSON.parse(buildRelayReply('t', many)).images.length, MAX_IMAGES_PER_REPLY)
})

test('unusable image entries are filtered out of the envelope', () => {
  const p = JSON.parse(buildRelayReply('t', [{ url: '' }, null, { format: 'png' }]))
  assert.equal(p.images, undefined)
})

test('absurd image urls lose the images rather than emit a refused envelope', () => {
  // Better a text-only reply than a payload the worker rejects wholesale.
  const p = JSON.parse(buildRelayReply('short', [{ url: `https://x/media/${'u'.repeat(9000)}.png`, format: 'png' }], 8000))
  assert.equal(p.images, undefined)
  assert.ok(typeof p.result === 'string')
})

test('an empty/nullish text still serializes to a valid envelope', () => {
  assert.deepEqual(JSON.parse(buildRelayReply('')), { result: '' })
  assert.deepEqual(JSON.parse(buildRelayReply(undefined)), { result: '' })
})

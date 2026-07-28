/**
 * 👀 see.ts — putting a FILE in front of the model, and the resampler flag that
 * quietly does the opposite of what its name says.
 *
 * What this suite pins is the policy, which is where the mistakes are invisible:
 * a wrong format declaration produces a request the provider rejects with an
 * error the model never reads, and a wrong resample makes a 6KB icon into a
 * 100KB one that looks identical.
 *
 * The measured ground truth encoded here, all taken from real files built in
 * /tmp/seeprobe with sips rather than from a spec:
 *   - `sips -Z 1600` and `--resampleHeightWidthMax 1600` UPSCALE: a 174×188 png
 *     came back **1481×1600**, 6,016 bytes → 100,478. The flag means "resample
 *     to this max dimension", not "cap at it".
 *   - a JPEG copied to `liar.png` reports `format: jpeg` to sips — the extension
 *     on a user's disk is a hint, not a fact
 *   - magic bytes as they actually appear: png 89504e470d0a1a0a, jpeg ffd8ffe0,
 *     gif 47494638 ("GIF8"), webp 52494646…57454250, heic 00000024 ftypheic,
 *     tiff 4d4d002a, bmp 424d
 *   - sips READS webp and converts it; it cannot WRITE webp
 *   - a 4000×3000 png is 302,586 bytes and shrinks to 86,609 at 1600 wide
 *
 * The SDK facts that made this increment small, measured against
 * @strands-agents/sdk 1.10 with a recording stub model (probe scripts, not
 * guesses) — and they contradict the report's "blocked at 3 layers":
 *   - a tool callback returning [{text},{image:{format,source:{bytes}}}] arrives
 *     at the model as a toolResult carrying that image verbatim
 *   - InvokeArgs already accepts ContentBlock[], so invoke() is not string-only
 *   - only the 8KB relay cap was ever real, and d-d already solved it
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  sniffFormat, SNIFF_BYTES, planSee, sipsArgs, plannedFormat, refusalMessage,
  seeNote, prepareImage, SHOWABLE, SEE_MAX_BYTES, SEE_MAX_EDGE, hasSips, realSeeIo,
  measureHeader, MEASURE_BYTES,
} = await import('../dist/agent/see.js')

const { runDesktop, DESKTOP_DESCRIPTION, desktopSenses, desktopSenseBlock, hasDesktopSenses } =
  await import('../dist/agent/desktop.js')

/** Binary probe stubs, same shape desktop.test.mjs uses. */
const only = (...bins) => (b) => bins.includes(b)

const bytes = (hex) => {
  const clean = hex.replace(/\s+/g, '')
  // An odd-length literal is silently truncated by Buffer.from, which is how a
  // "16 bytes of header" fixture quietly becomes 15 and stops matching.
  assert.equal(clean.length % 2, 0, `hex fixture must be whole bytes: ${hex}`)
  return Uint8Array.from(Buffer.from(clean, 'hex'))
}

// ── sniffing: content, never the extension ──────────────────────────────────

test('sniffFormat reads the real magic bytes of every format on this machine', () => {
  // Copied from `xxd -p -l 16` on files sips itself produced.
  assert.equal(sniffFormat(bytes('89504e470d0a1a0a0000000d49484452')), 'png')
  assert.equal(sniffFormat(bytes('ffd8ffe000104a464946000101000090')), 'jpeg')
  assert.equal(sniffFormat(bytes('474946383761ae00bc00c40000000000')), 'gif')
  assert.equal(sniffFormat(bytes('52494646400200005745425056503820')), 'webp')
  assert.equal(sniffFormat(bytes('00000024667479706865696300000000')), 'heic')
  assert.equal(sniffFormat(bytes('4d4d002a0001ff640003928600070000')), 'tiff')
  assert.equal(sniffFormat(bytes('424daaff0100000000008a0000007c00')), 'bmp')
})

test('a JPEG named .png is sniffed as jpeg — the extension is not evidence', () => {
  // MEASURED: `cp real.jpg liar.png` still reports `format: jpeg` to sips and
  // opens fine in Preview. Declaring `png` on those bytes is what breaks a
  // provider request, so the sniff is the authority, not the name.
  assert.equal(sniffFormat(bytes('ffd8ffe000104a4649460001')), 'jpeg')
})

test('sniffFormat refuses what it does not recognise, rather than guessing', () => {
  assert.equal(sniffFormat(bytes('7b0a2020226e616d6522')), null)       // JSON text
  assert.equal(sniffFormat(bytes('255044462d312e34')), null)           // %PDF-1.4
  assert.equal(sniffFormat(bytes('')), null)
  assert.equal(sniffFormat(bytes('89')), null)                         // truncated png
})

test('an ISO-BMFF container that is NOT an image is refused, not called heic', () => {
  // ftypmp42 / ftypqt — same box structure, a video inside. Claiming heic here
  // would send a movie to sips and produce a confusing conversion failure
  // instead of "that isn't an image".
  assert.equal(sniffFormat(bytes('00000018667479706d70343200000000')), null)
  assert.equal(sniffFormat(bytes('000000146674797071742020' + '00000000')), null)
  assert.equal(sniffFormat(bytes('00000024667479706d69663100000000')), 'heic')
})

test('SNIFF_BYTES covers the furthest byte the sniff actually reads', () => {
  // The brand check reaches offset 11; a smaller read would make every heic
  // report as "not an image" — a bug that only shows on iPhone photos.
  assert.ok(SNIFF_BYTES >= 12)
  const heic = bytes('00000024667479706865696300000000')
  assert.equal(sniffFormat(heic.subarray(0, SNIFF_BYTES)), 'heic')
  assert.equal(sniffFormat(heic.subarray(0, 11)), null)
})

// ── the plan: order is the design ───────────────────────────────────────────

test('a showable image within the caps is attached untouched', () => {
  assert.deepEqual(planSee({ format: 'png', width: 174, height: 188 }, 6016), {
    kind: 'attach', format: 'png',
  })
})

test('every showable format is attachable, and jpg/jpeg both declare jpeg', () => {
  for (const f of Object.keys(SHOWABLE)) {
    assert.equal(planSee({ format: f, width: 10, height: 10 }, 100).kind, 'attach', f)
  }
  assert.equal(plannedFormat({ kind: 'attach', format: 'jpg' }), 'jpeg')
  assert.equal(plannedFormat({ kind: 'attach', format: 'jpeg' }), 'jpeg')
  assert.equal(plannedFormat({ kind: 'attach', format: 'png' }), 'png')
})

test('an unshowable format CONVERTS even when it is tiny — format outranks size', () => {
  // THE ordering assertion. A 4,691-byte heic is well inside every cap, but a
  // shrink of a heic is still a heic: no provider accepts it. Checking size
  // first would attach it and get the whole request rejected.
  for (const f of ['heic', 'tiff', 'bmp']) {
    const plan = planSee({ format: f, width: 174, height: 188 }, 4691)
    assert.equal(plan.kind, 'convert', f)
    assert.equal(plan.to, 'jpeg', f)
    assert.match(plan.why, new RegExp(f))
  }
})

test('an oversized image shrinks to the edge cap', () => {
  const plan = planSee({ format: 'png', width: 4000, height: 3000 }, 302_586)
  assert.equal(plan.kind, 'shrink')
  assert.equal(plan.edge, SEE_MAX_EDGE)
  assert.match(plan.why, /4000×3000/)
})

test('the edge cap is measured on the LONG edge, whichever way round it is', () => {
  // A portrait 3000×4000 is exactly as expensive as its landscape twin.
  assert.equal(planSee({ format: 'png', width: 3000, height: 4000 }, 300_000).kind, 'shrink')
  assert.equal(planSee({ format: 'png', width: SEE_MAX_EDGE, height: 100 }, 1000).kind, 'attach')
  assert.equal(planSee({ format: 'png', width: SEE_MAX_EDGE + 1, height: 100 }, 1000).kind, 'shrink')
})

test('a SMALL image over the byte cap is re-encoded at its OWN size, never upscaled', () => {
  // ⚠️ THE TRAP THIS SUITE EXISTS FOR. `sips -Z 1600` on a 174×188 png returns
  //    1481×1600 and 100,478 bytes — measured. So a byte-overflow plan must
  //    carry the image's own edge, not the cap, or "make this smaller" makes it
  //    16× bigger. This assertion is the difference.
  const plan = planSee({ format: 'png', width: 800, height: 600 }, SEE_MAX_BYTES + 1)
  assert.equal(plan.kind, 'shrink')
  assert.equal(plan.edge, 800)
  assert.notEqual(plan.edge, SEE_MAX_EDGE)
  assert.match(plan.why, /attach cap/)
})

test('the shrink edge is NEVER larger than the image it is applied to', () => {
  // The general form of the same rule, swept: whatever the input, sips must not
  // be asked to resample upward.
  for (const [w, h, b] of [
    [174, 188, 6016], [800, 600, SEE_MAX_BYTES + 1], [4000, 3000, 302_586],
    [1, 1, SEE_MAX_BYTES * 2], [SEE_MAX_EDGE, SEE_MAX_EDGE, SEE_MAX_BYTES + 1],
    [5000, 10, 10], [10, 5000, SEE_MAX_BYTES + 1],
  ]) {
    const plan = planSee({ format: 'png', width: w, height: h }, b)
    if (plan.kind === 'shrink') {
      assert.ok(plan.edge <= Math.max(w, h), `${w}×${h} @${b} → edge ${plan.edge}`)
    }
  }
})

test('no pixels, unmeasured and not-an-image are THREE refusals, not one', () => {
  // A PDF and a multi-page tiff both decode while having no single bitmap. The
  // fixes differ (use the file editor vs convert), so the words differ.
  assert.deepEqual(planSee({ format: 'pdf', width: 0, height: 0 }, 1000), {
    kind: 'refuse', reason: 'no-pixels',
  })
  // ⚠️ NOT 'not-an-image'. planSee is only reached after sniffFormat said these
  //    ARE image bytes, so claiming otherwise is a diagnosis the caller has
  //    already disproved — it sends the user hunting a corrupt file when the
  //    real cause is a machine with no sips. Unmeasured is the honest answer.
  assert.deepEqual(planSee(null, 1000), { kind: 'refuse', reason: 'unmeasured' })
  assert.deepEqual(planSee({ format: '', width: 10, height: 10 }, 100), {
    kind: 'refuse', reason: 'unmeasured',
  })
  // All three send the reader somewhere different, so no two may share wording.
  const msgs = ['no-pixels', 'unmeasured', 'not-an-image'].map((r) => refusalMessage('/x.pdf', r))
  assert.equal(new Set(msgs).size, 3, 'three causes, three messages')
  // And the unmeasured one must name the missing binary — that IS the fix.
  assert.match(refusalMessage('/x.png', 'unmeasured'), /no sips/)
})

test('an UNMEASURED file in an unshowable format is told to convert, not "unmeasured"', () => {
  // Ordering, and the same rule the format-before-size branch below encodes: a
  // heic must be converted whatever its dimensions, so "couldn't measure it" is
  // a true sentence that names the wrong fix. Reachable on a machine with no
  // sips, where nothing can measure a heic and measureHeader doesn't parse one.
  for (const fmt of ['heic', 'tiff', 'bmp']) {
    assert.deepEqual(
      planSee(null, 1000, { sniffed: fmt }),
      { kind: 'convert', to: 'jpeg', why: `${fmt} is not a format a model can be shown` },
      fmt,
    )
  }
  // A showable format with no measurement is still unmeasured — the sniff alone
  // cannot prove it fits the caps, and a size nobody measured is never assumed.
  for (const fmt of ['png', 'jpeg', 'gif', 'webp']) {
    assert.equal(planSee(null, 1000, { sniffed: fmt }).reason, 'unmeasured', fmt)
  }
})

test('a negative or absurd size is a refusal, never a default', () => {
  for (const [w, h] of [[-1, 10], [10, -1], [0, 10], [NaN, 10], [10, NaN]]) {
    assert.equal(planSee({ format: 'png', width: w, height: h }, 100).reason, 'no-pixels', `${w}×${h}`)
  }
})

// ── measureHeader: size without a spawn ─────────────────────────────────────

/**
 * ⚠️ EVERY expectation below is what `sips -g pixelWidth -g pixelHeight` SAID
 *    about a real file built in /tmp/c25m, with the header read by `xxd -p -l 40`
 *    and pasted in verbatim. The whole point of this function is to agree with
 *    sips where sips isn't there, so agreeing with a spec would prove nothing.
 */
const REAL_HEADERS = [
  // a.png — 174×188, the same icon the -Z upscale was measured on
  ['png', '89504e470d0a1a0a0000000d49484452000000ae000000bc08020000006e70022900000001735247', 174, 188],
  // d.png — 33×33
  ['png', '89504e470d0a1a0a0000000d4948445200000021000000210802000000d886553800000001735247', 33, 33],
  // c.gif — 96×64, LITTLE-endian (6000 4000), the one format here that is
  ['gif', '47494638376160004000f7000000000010161b151b1e131d24191e201420251d232319242a202725', 96, 64],
  // e.webp — 120×90, lossy VP8: 14-bit fields after the 9d012a start code
  ['webp', '524946466e060000574542505650382062060000b01e009d012a78005a003e91409b49a5a3a2af28', 120, 90],
  // f_lossless.webp — 120×90, VP8L: 14 bits each, packed, stored minus-one
  ['webp', '5249464614330000574542505650384c073300002f774016004d308e24354e0da8d8c742', 120, 90],
  // g_x.webp — 120×90, VP8X: 24-bit canvas size, also minus-one
  ['webp', '52494646f208000057454250565038580a0000000c0000007700005900005650382062060000b01e', 120, 90],
]

test('measureHeader agrees with sips on real files, from the header alone', () => {
  for (const [fmt, hex, w, h] of REAL_HEADERS) {
    assert.deepEqual(measureHeader(bytes(hex), fmt), { width: w, height: h }, `${fmt} ${w}×${h}`)
  }
})

test('a lossy WebP masks off the SCALE bits — they are a hint, not size', () => {
  // ⚠️ The top 2 bits of each 16-bit VP8 dimension field are an upscaling hint,
  //    not part of the number. e.webp above has them clear, so it cannot tell a
  //    masked read from an unmasked one. This one sets them: 0x8078 masks to 120
  //    and reads as 32888 unmasked — a 274× error that would drive every
  //    downstream shrink decision, and no real file in the fixtures catches it.
  const scaled = bytes(
    '524946466e060000574542505650382062060000b01e009d012a' + '7880' + '5a40' + '3e91409b',
  )
  assert.deepEqual(measureHeader(scaled, 'webp'), { width: 120, height: 90 })
})

test('a JPEG is measured by WALKING to the SOF, not at a fixed offset', () => {
  // ⚠️ MEASURED: in the 500×300 jpeg sips wrote, SOF0 sits at offset **204** —
  //    behind a JFIF APP0 and a 124-byte EXIF APP1. A fixed offset would work on
  //    one encoder's output and silently misreport every other's.
  const jpeg = Buffer.alloc(220, 0)
  Buffer.from('ffd8', 'hex').copy(jpeg, 0)
  // APP0, length 16
  Buffer.from('ffe00010', 'hex').copy(jpeg, 2)
  // APP1, length 0x7c = 124 — the segment that pushes SOF past any small budget
  Buffer.from('ffe1007c', 'hex').copy(jpeg, 20)
  // SOF0 at 204, exactly as measured: len 0011, precision 08, then H then W
  Buffer.from('ffc0001108012c01f40301', 'hex').copy(jpeg, 204)
  assert.deepEqual(measureHeader(jpeg, 'jpeg'), { width: 500, height: 300 })
})

test('a JPEG SOF is read height-BEFORE-width — a swap makes portrait landscape', () => {
  // The one place in this file where the obvious order is wrong. A tall photo
  // reported as wide would send every downstream shrink the wrong way.
  const tall = Buffer.concat([
    Buffer.from('ffd8', 'hex'),
    Buffer.from('ffc00011080400026800030122000201', 'hex'), // H=0x0400=1024, W=0x0268=616
  ])
  assert.deepEqual(measureHeader(tall, 'jpeg'), { width: 616, height: 1024 })
})

test('measureHeader refuses rather than guessing — every unreadable case', () => {
  // A truncated header is the case that matters: a partial download must not
  // become a confidently wrong size that every downstream number inherits.
  assert.equal(measureHeader(bytes('89504e470d0a1a0a0000000d49484452000000ae'), 'png'), null, 'png cut mid-height')
  assert.equal(measureHeader(bytes('89504e470d0a1a0a'), 'png'), null, 'signature only')
  // A png whose first chunk is not IHDR is not a png this can measure — the spec
  // says IHDR is first, so anything else means the bytes are not what they claim.
  assert.equal(measureHeader(bytes('89504e470d0a1a0a0000000d504c5445000000ae000000bc'), 'png'), null, 'PLTE first')
  assert.equal(measureHeader(bytes('4749463837'), 'gif'), null, 'gif cut')
  assert.equal(measureHeader(bytes('52494646' + '6e060000' + '57454250' + '58585858'), 'webp'), null, 'unknown webp chunk')
  // ⚠️ The bytes AFTER the missing start code are deliberately a valid-looking
  //    size. A fixture that simply ran out of bytes would return null whether or
  //    not the start code was checked, so it would pin nothing: dropping the
  //    check has to produce a WRONG SIZE here, not a shorter refusal.
  assert.equal(
    measureHeader(bytes('524946466e0600005745425056503820' + '62060000' + 'b01e00' + 'ffffff' + '7800' + '5a00'), 'webp'),
    null,
    'VP8 without the 9d012a start code',
  )
  // A jpeg that reaches its scan with no SOF, and one whose length field lies.
  assert.equal(measureHeader(bytes('ffd8ffda0004000000'), 'jpeg'), null, 'SOS before any SOF')
  assert.equal(measureHeader(bytes('ffd8ffe00001'), 'jpeg'), null, 'length below the minimum')
  // Formats it deliberately does not do: they need CONVERTING whatever the size.
  for (const fmt of ['heic', 'tiff', 'bmp', 'pdf', '']) {
    assert.equal(measureHeader(bytes('89504e470d0a1a0a0000000d49484452000000ae000000bc'), fmt), null, fmt || '(empty)')
  }
  // A zero dimension is a refusal, not a returned zero — planSee's no-pixels
  // branch is for files that DECODED, and a 0-width png header never did.
  assert.equal(measureHeader(bytes('89504e470d0a1a0a0000000d494844520000000000000021080200'), 'png'), null, '0 width')
})

test('MEASURE_BYTES is bigger than the sniff, because a JPEG SOF is far in', () => {
  // Not a tidy constant: SNIFF_BYTES (16) would miss every real jpeg's SOF,
  // measured at offset 204 in the smallest one to hand.
  assert.ok(MEASURE_BYTES > SNIFF_BYTES * 100, `${MEASURE_BYTES} vs ${SNIFF_BYTES}`)
})

// ── the sips argv ───────────────────────────────────────────────────────────

test('sipsArgs converts with -s format and shrinks with -Z, and nothing else', () => {
  assert.deepEqual(
    sipsArgs({ kind: 'convert', to: 'jpeg', why: 'x' }, '/a.heic', '/tmp/o.jpg'),
    ['-s', 'format', 'jpeg', '/a.heic', '--out', '/tmp/o.jpg'],
  )
  assert.deepEqual(
    sipsArgs({ kind: 'shrink', format: 'png', edge: 1600, why: 'x' }, '/a.png', '/tmp/o.png'),
    ['-Z', '1600', '/a.png', '--out', '/tmp/o.png'],
  )
  // An attach or a refusal has no command at all — an argv built for either
  // would rewrite a file that was already fine.
  assert.equal(sipsArgs({ kind: 'attach', format: 'png' }, '/a.png', '/tmp/o.png'), null)
  assert.equal(sipsArgs({ kind: 'refuse', reason: 'not-an-image' }, '/a', '/tmp/o'), null)
})

test('sips is passed argv, never a shell string — a path with a space is safe', () => {
  const args = sipsArgs({ kind: 'shrink', format: 'png', edge: 800, why: '' }, '/My Photos/a b.png', '/tmp/o.png')
  assert.ok(args.includes('/My Photos/a b.png'))
  assert.ok(!args.some((a) => /['"\\]/.test(a)))
})

test('a converted file is declared as what it BECAME, not what it was', () => {
  assert.equal(plannedFormat({ kind: 'convert', to: 'jpeg', why: '' }), 'jpeg')
  assert.equal(plannedFormat({ kind: 'shrink', format: 'jpg', edge: 100, why: '' }), 'jpeg')
  assert.equal(plannedFormat({ kind: 'refuse', reason: 'x' }), '')
})

// ── the note that rides with the picture ────────────────────────────────────

test('the note states the size, and points at the FREE tool for text questions', () => {
  const note = seeNote('/a.png', { format: 'png', width: 174, height: 188 }, { kind: 'attach', format: 'png' }, 6016)
  assert.match(note, /174×188/)
  assert.match(note, /read_image/)
  assert.match(note, /free|no tokens|vision tokens/i)
})

test("a resampled picture SAYS its coordinates are no longer the file's", () => {
  // Invisible in the pixels, and exactly the mistake read_image's own formatter
  // was written to prevent: a model measuring a button at 400,300 in a shrunk
  // image and reporting that as the file's coordinates.
  const note = seeNote('/a.png', { format: 'png', width: 4000, height: 3000 },
    { kind: 'shrink', format: 'png', edge: 1600, why: 'too big' }, 86_609)
  assert.match(note, /Resampled/)
  assert.match(note, /NOT the file's own pixel coordinates/)
  assert.match(note, /unchanged/)
})

test('a converted picture says the conversion happened and the disk did not change', () => {
  const note = seeNote('/p.heic', { format: 'heic', width: 174, height: 188 },
    { kind: 'convert', to: 'jpeg', why: 'heic is not showable' }, 5000)
  assert.match(note, /heic → jpeg/)
  assert.match(note, /file on disk is unchanged/)
  // An untouched attach must NOT claim either — a note that always says
  // "converted" teaches the model to distrust the one time it matters.
  const plain = seeNote('/a.png', { format: 'png', width: 10, height: 10 }, { kind: 'attach', format: 'png' }, 100)
  assert.ok(!/Converted|Resampled/.test(plain))
})

// ── prepareImage: the whole path, with fake IO ──────────────────────────────

/** A recording SeeIo over a fake file, so no sips runs and no image exists. */
function fakeIo(over = {}) {
  const calls = []
  return {
    calls,
    io: {
      probe: over.probe ?? (() => ({ format: 'png', width: 174, height: 188 })),
      readHead: over.readHead ?? (() => bytes('89504e470d0a1a0a0000000d49484452')),
      readAll: over.readAll ?? (() => Buffer.from('PNGBYTES')),
      run: over.run ?? ((bin, args) => { calls.push([bin, ...args]) }),
      tmp: over.tmp ?? ((_src, ext) => `/tmp/tiny-see-fake.${ext}`),
      canConvert: over.canConvert ?? (() => true),
    },
  }
}

// prepareImage checks the real filesystem for existence, so it needs a real
// path. This file is not an image, which is precisely useful below.
const SELF = new URL(import.meta.url).pathname

test('a missing file and a directory are told apart', () => {
  const { io } = fakeIo()
  const missing = prepareImage('/nope/does-not-exist.png', io)
  assert.equal(missing.ok, false)
  assert.match(missing.message, /no such file/)
  const dir = prepareImage(new URL('.', import.meta.url).pathname, io)
  assert.equal(dir.ok, false)
  assert.match(dir.message, /is a directory/)
})

test('a real non-image file is refused on its BYTES before sips is ever spawned', () => {
  // The sniff runs first on purpose: a JS file handed to sips produces a
  // conversion error, and "could not convert" is the wrong sentence for "that
  // is not an image".
  const { io, calls } = fakeIo({ readHead: () => bytes('2f2a2a0a202a20f09f') })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, false)
  assert.match(r.message, /not an image I can show/)
  assert.equal(calls.length, 0)
})

test('a showable in-cap image is attached with no sips call at all', () => {
  const { io, calls } = fakeIo()
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, true)
  assert.equal(r.value.format, 'png')
  assert.equal(r.value.base64, Buffer.from('PNGBYTES').toString('base64'))
  assert.equal(calls.length, 0, 'an already-fine image must not be rewritten')
})

test('a heic is converted, and the block is declared jpeg', () => {
  const { io, calls } = fakeIo({
    readHead: () => bytes('00000024667479706865696300000000'),
    probe: () => ({ format: 'heic', width: 174, height: 188 }),
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, true)
  assert.equal(r.value.format, 'jpeg')
  // The scratch file gets a .jpg extension because that is what it now IS.
  assert.deepEqual(calls[0], ['sips', '-s', 'format', 'jpeg', SELF, '--out', '/tmp/tiny-see-fake.jpg'])
})

test('a failed conversion refuses instead of attaching the original', () => {
  // Attaching the heic bytes while declaring jpeg would be a request the
  // provider rejects — an error the model cannot see or act on.
  const { io } = fakeIo({
    readHead: () => bytes('00000024667479706865696300000000'),
    probe: () => ({ format: 'heic', width: 174, height: 188 }),
    run: () => { throw new Error('sips: cannot decode') },
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, false)
  assert.match(r.message, /could not convert/)
  assert.match(r.message, /cannot decode/)
})

test('no resampler on this machine refuses, and names what is missing', () => {
  const { io, calls } = fakeIo({
    readHead: () => bytes('00000024667479706865696300000000'),
    probe: () => ({ format: 'heic', width: 174, height: 188 }),
    canConvert: () => false,
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, false)
  assert.match(r.message, /no sips/)
  assert.match(r.message, /read_image/)
  assert.equal(calls.length, 0)
})

// ── no sips at all: the promise this module makes three times ───────────────

test('a machine with NO sips still shows a small png — the promise, now kept', () => {
  // ⚠️ THIS IS THE REGRESSION. canConvert's docblock, hasSips' docblock and
  //    desktopSenses' comment all say only the CONVERT branch needs the binary.
  //    It was false: probe() IS sips, a null probe refused, so on Linux (and on
  //    a Mac with sips removed) an already-showable 3KB png came back "not an
  //    image I can show" — a sentence contradicting the sniff this module had
  //    just done on those very bytes. Measured before the fix; it refused.
  const png = bytes(
    // Real header off a real file (sips -z 33 33): IHDR width 0x21, height 0x21.
    '89504e470d0a1a0a0000000d4948445200000021000000210802000000d886553800000001735247',
  )
  const { io, calls } = fakeIo({
    probe: () => null,          // no sips to measure with
    canConvert: () => false,    // and none to resample with
    readHead: (_p, n) => png.subarray(0, n),
    readAll: () => Buffer.from('PNGBYTES'),
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, true, r.ok ? '' : r.message)
  assert.equal(r.value.format, 'png')
  // The size in the note is MEASURED from the header, not guessed or defaulted.
  assert.match(r.value.note, /33×33px/)
  assert.equal(calls.length, 0, 'nothing was spawned')
})

test('with no sips, an OVERSIZED png is still refused — measuring is not resampling', () => {
  // The other half, and the reason the fix is a measurer and not a bypass: a
  // 4000×3000 png measured perfectly well still cannot be shrunk here, and
  // attaching it whole is a request the provider rejects with an error the model
  // never reads. The refusal must name sips, because that IS the fix.
  const big = bytes('89504e470d0a1a0a0000000d49484452' + '00000fa0' + '00000bb8' + '0802000000')
  const { io, calls } = fakeIo({
    probe: () => null,
    canConvert: () => false,
    readHead: (_p, n) => big.subarray(0, n),
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, false)
  assert.match(r.message, /no sips/)
  assert.match(r.message, /4000×3000/, 'the measured size is stated, so the refusal is checkable')
  assert.equal(calls.length, 0)
})

test('an unmeasured heic converts and then measures its OUTPUT', () => {
  // No sips to measure the input (and measureHeader deliberately does not parse
  // heic — its dimensions change nothing, since it must convert either way), but
  // a sips that CAN convert. The note's size must then come from the jpeg that
  // was written, because that is the picture the model is about to see.
  let converted = false
  const { io, calls } = fakeIo({
    readHead: (_p, n) => bytes('00000024667479706865696300000000').subarray(0, n),
    // null until the conversion has run, then the output's real size.
    probe: () => (converted ? { format: 'jpeg', width: 800, height: 600 } : null),
    run: (bin, args) => { converted = true; calls.push([bin, ...args]) },
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, true, r.ok ? '' : r.message)
  assert.equal(r.value.format, 'jpeg')
  assert.match(r.value.note, /800×600px/)
  assert.match(r.value.note, /Converted heic → jpeg/)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 3), ['sips', '-s', 'format'])
})

test('a converted file that STILL cannot be measured is refused, not sent blind', () => {
  // sips exited 0 and wrote something nothing can size. The picture would still
  // attach — and seeNote would have to state a size it never measured, which is
  // the one thing this module refuses to do anywhere. The refusal must say
  // "couldn't measure", not "no bitmap": the file converted, so it had one.
  const { io } = fakeIo({
    readHead: (_p, n) => bytes('00000024667479706865696300000000').subarray(0, n),
    probe: () => null,                     // before AND after the conversion
    run: () => {},                          // which "succeeded"
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, false)
  assert.match(r.message, /dimensions could not be measured/)
  assert.ok(!/no bitmap/.test(r.message), 'it converted, so it had a bitmap')
})

test('an image still over the cap AFTER resampling is refused, not sent', () => {
  const big = Buffer.alloc(SEE_MAX_BYTES + 10, 1)
  const { io } = fakeIo({
    probe: () => ({ format: 'png', width: 4000, height: 3000 }),
    readAll: () => big,
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, false)
  assert.match(r.message, /still \d+KB/)
  assert.match(r.message, /Crop/)
})

test('a prepared file that came back EMPTY is refused', () => {
  // sips can exit 0 having written nothing; a zero-byte attachment reads to the
  // model as a successful look at a blank picture.
  const { io } = fakeIo({ readAll: () => Buffer.alloc(0) })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, false)
  assert.match(r.message, /empty/)
})

test('an unmeasurable size is a refusal — never a guessed one', () => {
  // The same rule vision.ts learned: a size we did not measure would make every
  // downstream number plausible and wrong.
  // The fake readHead answers 16 bytes whatever n is, so the png header stops
  // one field short of its width — measureHeader cannot finish, and refusing is
  // right. What it must NOT say is "not an image": the sniff just proved it is.
  const { io } = fakeIo({ probe: () => null })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, false)
  assert.match(r.message, /dimensions could not be measured/)
  assert.ok(!/not an image I can show/.test(r.message), 'must not deny bytes the sniff accepted')
})

test('sips is trusted over the sniff for the FORMAT, and the sniff is the gate', () => {
  // liar.png: png-ish name, jpeg bytes. The sniff lets it through (it IS an
  // image) and sips names it jpeg, so the attached block declares jpeg.
  const { io, calls } = fakeIo({
    readHead: () => bytes('ffd8ffe000104a464946'),
    probe: () => ({ format: 'jpeg', width: 174, height: 188 }),
  })
  const r = prepareImage(SELF, io)
  assert.equal(r.ok, true)
  assert.equal(r.value.format, 'jpeg')
  assert.equal(calls.length, 0)
})

test('the temp path is derived from the source, with no clock in it', () => {
  // A clock in a scratch name breaks nothing visibly and makes the whole path
  // untestable; two calls about one file may share scratch space anyway.
  const a = realSeeIo.tmp('/Users/x/a.heic', 'jpg')
  const b = realSeeIo.tmp('/Users/x/a.heic', 'jpg')
  const c = realSeeIo.tmp('/Users/x/b.heic', 'jpg')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /\.jpg$/)
})

// ── the tool surface ────────────────────────────────────────────────────────

test('see_image without a target asks for one instead of guessing', async () => {
  const r = await runDesktop({ action: 'see_image' })
  assert.equal(typeof r, 'string')
  assert.match(r, /need target/)
})

test('a refusal comes back as a STRING, never as an empty block list', async () => {
  // A tool result with no content reads to the model as a successful look at
  // nothing — the one failure mode that produces confident invention.
  const r = await runDesktop({ action: 'see_image', target: '/nope/missing-xyz.png' })
  assert.equal(typeof r, 'string')
  assert.match(r, /no such file/)
})

test('every OTHER action still returns a plain string', async () => {
  // agent.ts calls runDesktop directly for task notifications, and two other
  // suites assert on strings. Widening the return type must not widen them.
  for (const a of [
    { action: 'speak' }, { action: 'transcribe' }, { action: 'copy' },
    { action: 'notify' }, { action: 'open' }, { action: 'read_image' },
    { action: 'nonsense' },
  ]) {
    assert.equal(typeof await runDesktop(a), 'string', a.action)
  }
})

test('the description teaches WHICH of the two image tools to reach for', () => {
  assert.match(DESKTOP_DESCRIPTION, /see_image/)
  assert.match(DESKTOP_DESCRIPTION, /not interchangeable/)
  // The cheap tool has to be named as the default, or a model with a vision
  // budget will attach a screenshot to ask what a button says.
  assert.match(DESKTOP_DESCRIPTION, /read_image first|use read_image/)
  assert.match(DESKTOP_DESCRIPTION, /vision tokens/)
})

test('the sense block advertises sight only when it resolved', () => {
  assert.match(desktopSenseBlock(['notify', 'see']), /see_image/)
  assert.match(desktopSenseBlock(['notify', 'see']), /read_image first/)
  assert.ok(!/see_image/.test(desktopSenseBlock(['notify', 'copy'])))
})

test('`see` is unconditional and `convert` is the sips-shaped half', () => {
  // ⚠️ `see` USED to be gated on the resampler, which under-reported exactly the
  //    way the ocr label once did: showing a small png needs no binary, so a
  //    Linux node announced no sight while offering working sight. Two words now,
  //    because they are two capabilities — see_image works, converting doesn't.
  // A clipboard is posited throughout: `see` rides on use_desktop having
  // registered at all, which is the coupling the next test pins.
  const withSips = desktopSenses('linux', {}, only('xclip'), (p) => p === '/usr/bin/sips')
  assert.ok(withSips.includes('see'))
  assert.ok(withSips.includes('convert'))
  assert.ok(!withSips.includes('speak'))
  // Sight does not depend on the converter — a machine with a clipboard and no
  // sips still reports it.
  const noSips = desktopSenses('linux', {}, only('xclip'), () => false)
  assert.ok(noSips.includes('see'), 'sight does not depend on the converter')
  assert.ok(!noSips.includes('convert'), 'but converting does')
})

test('a sense is never claimed where the TOOL never registers', () => {
  // The mirror of the label error this fix corrects, and the reason `see` is not
  // simply unconditional: on a machine where no other sense resolves,
  // hasDesktopSenses returns false and use_desktop is never registered — so a
  // reported `see` would put a sense in the tray and a promise in the prompt
  // with no action behind either. These two functions must agree, always.
  const none = () => false
  for (const plat of ['linux', 'freebsd']) {
    assert.equal(hasDesktopSenses(plat, {}, none, none), false, plat)
    assert.deepEqual(desktopSenses(plat, {}, none, none), [], plat)
  }
  // And where the tool DOES register, sight is always in the list.
  assert.equal(hasDesktopSenses('linux', {}, only('xclip'), none), true)
  assert.ok(desktopSenses('linux', {}, only('xclip'), none).includes('see'))
})

test('the prompt states the no-converter limit instead of letting it be discovered', () => {
  // A machine that can show a png but not a heic has to SAY which, or the agent
  // learns it one refused file at a time — and "convert it first" is advice the
  // user can act on, unlike a per-file failure.
  const noConv = desktopSenseBlock(desktopSenses('linux', {}, only('xclip'), () => false))
  assert.match(noConv, /see_image/)
  assert.match(noConv, /no image converter/)
  assert.match(noConv, /png\/jpeg\/gif\/webp/)
  const conv = desktopSenseBlock(desktopSenses('darwin', {}, only('xclip'), () => true))
  assert.match(conv, /see_image/)
  assert.ok(!/no image converter/.test(conv), 'must not warn where sips exists')
})

test('hasSips answers about this machine without throwing', () => {
  assert.equal(typeof hasSips(), 'boolean')
  if (process.platform === 'darwin') assert.equal(hasSips(), true)
})

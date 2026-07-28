/**
 * 👁️ vision.ts — on-device OCR, and the one geometry fact that silently ruins it.
 *
 * Vision itself needs a Mac and an image, so what's tested here is everything
 * that decides WHERE a click lands and WHICH line wins a search: the normalized
 * bottom-left → image-space top-left transform, the tolerant payload reader, and
 * the match ranking. Those are pure, and they're where a mistake is invisible —
 * a sign error in the y flip produces perfectly plausible coordinates that are
 * mirrored about the horizontal centre line.
 *
 * The measured ground truth this suite encodes (taken from a synthetic 400×400
 * image with known text at top and bottom, and from a real screenshot):
 *   - boundingBox is NORMALIZED 0..1 — immune to Retina physical-vs-logical
 *   - its origin is BOTTOM-LEFT — text at the TOP reports y ≈ 0.885
 *
 * The FILE path (read_image) adds a second measured set, all from real files in
 * /tmp/visprobe built for the purpose:
 *   - NSImage.size is POINTS: a 144-dpi png reports 800×400 for a 1600×800
 *     bitmap, so a points-based read halves every coordinate
 *   - a .icns carries 256/128/32/16px reps — the pick must be by AREA
 *   - EXIF Orientation=6 is applied by BOTH layers consistently (reported dims
 *     and Vision's boxes agree), so there is nothing to correct
 *   - `fast` finds 0 lines in that rotated jpeg where accurate finds 2
 *   - a text file gives not-an-image; a real PDF DECODES but has no bitmap rep
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const {
  boxToImageRect, parseOcrPayload, linesToText, matchLines, hasVisionOcr,
  parseImageOcrPayload, recognizeTextInFile, expandTilde, formatFileOcr, FILE_OCR_LINE_LIMIT,
} = await import('../dist/agent/vision.js')

const {
  readScreenText, formatTextLines, OCR_LINE_LIMIT,
} = await import('../dist/agent/computer.js')

const { labelOnlyCapabilities } = await import('../dist/agent/device-tools.js')

/** A Vision-shaped payload line. Boxes are normalized, bottom-left origin. */
const line = (text, box, confidence = 1) => ({ text, confidence, box })

// ── the y flip: the whole reason this file is pure ───────────────────────────

test('a box at the TOP of the image becomes a SMALL y — the flip out of bottom-left', () => {
  // Measured: text drawn at the top of a 400×400 image reports origin.y 0.885,
  // height 0.06. Top edge = 1 - (0.885 + 0.06) = 0.055 → y = 22 of 400.
  const r = boxToImageRect({ x: 0.045, y: 0.885, width: 0.2, height: 0.06 }, 400, 400)
  assert.equal(r.y, 22)
  // The mirrored (unflipped) answer would be 354 — plausible, and wrong by the
  // full height of the image. This assertion is the guard against that.
  assert.notEqual(r.y, Math.round(0.885 * 400))
})

test('a box at the BOTTOM of the image becomes a LARGE y', () => {
  // Same synthetic image, the word drawn near the bottom: origin.y 0.06.
  const r = boxToImageRect({ x: 0.05, y: 0.06, width: 0.3, height: 0.06 }, 400, 400)
  assert.equal(r.y, 352)
  assert.ok(r.y > 300, 'bottom text must land in the bottom half of image space')
})

test('top and bottom stay ORDERED after the flip (top has the smaller y)', () => {
  const top = boxToImageRect({ x: 0.045, y: 0.885, width: 0.2, height: 0.06 }, 400, 400)
  const bottom = boxToImageRect({ x: 0.05, y: 0.06, width: 0.3, height: 0.06 }, 400, 400)
  assert.ok(top.y < bottom.y)
})

test('x is NOT flipped — both axes flipped is as wrong as neither', () => {
  const r = boxToImageRect({ x: 0.25, y: 0.5, width: 0.1, height: 0.1 }, 1000, 1000)
  assert.equal(r.x, 250)
})

test('the centre is the middle of the box, in flipped space', () => {
  const r = boxToImageRect({ x: 0.1, y: 0.4, width: 0.2, height: 0.2 }, 1000, 500)
  assert.equal(r.x, 100)
  assert.equal(r.width, 200)
  assert.equal(r.centerX, 200)
  // top edge = 1 - (0.4 + 0.2) = 0.4 → y = 200 of 500; height 100 → centre 250.
  assert.equal(r.y, 200)
  assert.equal(r.height, 100)
  assert.equal(r.centerY, 250)
})

test('a full-bleed box covers the whole image and centres on it', () => {
  const r = boxToImageRect({ x: 0, y: 0, width: 1, height: 1 }, 800, 600)
  assert.deepEqual(
    { x: r.x, y: r.y, width: r.width, height: r.height, centerX: r.centerX, centerY: r.centerY },
    { x: 0, y: 0, width: 800, height: 600, centerX: 400, centerY: 300 },
  )
})

test('a NON-SQUARE image scales each axis by its own dimension', () => {
  // The bug this catches: scaling both axes by the width (or by the larger
  // dimension) on a 3008×1692 screen puts every click ~800px too low.
  const r = boxToImageRect({ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, 3008, 1692)
  assert.equal(r.x, 1504)
  assert.equal(r.width, 301)
  assert.equal(r.height, 169)
  assert.equal(r.y, Math.round((1 - 0.6) * 1692))
})

test('coordinates are whole pixels — a click coordinate is an integer', () => {
  const r = boxToImageRect({ x: 0.3333, y: 0.3333, width: 0.3333, height: 0.3333 }, 777, 333)
  for (const v of [r.x, r.y, r.width, r.height, r.centerX, r.centerY]) {
    assert.equal(v, Math.round(v))
  }
})

// ── the payload reader: a Vision change must degrade, not throw ──────────────

test('a well-formed payload becomes clickable lines', () => {
  const raw = JSON.stringify({
    ok: true,
    lines: [line('Sign In', { x: 0.4, y: 0.5, width: 0.1, height: 0.03 }, 0.97)],
  })
  const res = parseOcrPayload(raw, 1000, 1000)
  assert.equal(res.ok, true)
  assert.equal(res.lines.length, 1)
  assert.equal(res.lines[0].text, 'Sign In')
  assert.equal(res.lines[0].confidence, 0.97)
  assert.equal(res.lines[0].centerX, 450)
  // top edge = 1 - 0.53 = 0.47 → y 470, height 30 → centre 485
  assert.equal(res.lines[0].centerY, 485)
})

test('non-JSON output is a failure, not a crash', () => {
  const res = parseOcrPayload('osascript: some error text', 100, 100)
  assert.equal(res.ok, false)
  assert.deepEqual(res.lines, [])
})

test('ok:false is preserved — Vision refusing an image is not an empty screen', () => {
  // The distinction that matters: recognizeText throws on ok:false but returns
  // [] happily for a blank screen. Collapsing them would report a corrupt file
  // as "no text on screen".
  const res = parseOcrPayload(JSON.stringify({ ok: false, lines: [] }), 100, 100)
  assert.equal(res.ok, false)
  const empty = parseOcrPayload(JSON.stringify({ ok: true, lines: [] }), 100, 100)
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.lines, [])
})

test('a line missing its box is SKIPPED, not turned into a 0,0 click', () => {
  const raw = JSON.stringify({
    ok: true,
    lines: [{ text: 'boxless', confidence: 1 }, line('good', { x: 0.1, y: 0.1, width: 0.1, height: 0.1 })],
  })
  const res = parseOcrPayload(raw, 500, 500)
  assert.deepEqual(res.lines.map(l => l.text), ['good'])
})

test('a box with a non-numeric field is skipped rather than yielding NaN coordinates', () => {
  const raw = JSON.stringify({
    ok: true,
    lines: [
      line('bad', { x: 0.1, y: 'nope', width: 0.1, height: 0.1 }),
      line('alsobad', { x: 0.1, y: 0.1, width: null, height: 0.1 }),
      line('fine', { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }),
    ],
  })
  const res = parseOcrPayload(raw, 100, 100)
  assert.deepEqual(res.lines.map(l => l.text), ['fine'])
  for (const l of res.lines) assert.ok(Number.isFinite(l.centerY))
})

test('whitespace-only text is dropped — it is never a click target', () => {
  const raw = JSON.stringify({
    ok: true,
    lines: [line('   ', { x: 0, y: 0, width: 1, height: 0.1 }), line('real', { x: 0, y: 0.5, width: 1, height: 0.1 })],
  })
  assert.deepEqual(parseOcrPayload(raw, 10, 10).lines.map(l => l.text), ['real'])
})

test('a missing confidence becomes 0, not NaN in the rendered output', () => {
  const raw = JSON.stringify({ ok: true, lines: [{ text: 'x', box: { x: 0, y: 0, width: 1, height: 1 } }] })
  const res = parseOcrPayload(raw, 10, 10)
  assert.equal(res.lines[0].confidence, 0)
  assert.ok(!formatTextLines(res.lines).includes('NaN'))
})

test('a payload with no lines array at all yields no lines', () => {
  assert.deepEqual(parseOcrPayload(JSON.stringify({ ok: true }), 10, 10).lines, [])
  assert.deepEqual(parseOcrPayload(JSON.stringify({ ok: true, lines: 'nope' }), 10, 10).lines, [])
})

// ── reading order ───────────────────────────────────────────────────────────

test('linesToText keeps Vision order — it does NOT sort by position', () => {
  // Deliberate: Vision returns reading order. Sorting by y interleaves columns,
  // so a two-pane window would come back as alternating fragments of both.
  const raw = JSON.stringify({
    ok: true,
    lines: [
      line('left column top', { x: 0.05, y: 0.9, width: 0.3, height: 0.02 }),
      line('left column bottom', { x: 0.05, y: 0.1, width: 0.3, height: 0.02 }),
      line('right column top', { x: 0.6, y: 0.9, width: 0.3, height: 0.02 }),
    ],
  })
  const { lines } = parseOcrPayload(raw, 1000, 1000)
  assert.equal(linesToText(lines), 'left column top\nleft column bottom\nright column top')
})

// ── matching: which line the model actually meant ────────────────────────────

const HAYSTACK = parseOcrPayload(JSON.stringify({
  ok: true,
  lines: [
    line('Save As…', { x: 0.1, y: 0.9, width: 0.1, height: 0.02 }),
    line('Save', { x: 0.5, y: 0.2, width: 0.06, height: 0.03 }),
    line('Saved 3 minutes ago', { x: 0.1, y: 0.05, width: 0.3, height: 0.02 }),
    line('Sign  In', { x: 0.4, y: 0.5, width: 0.1, height: 0.03 }),
  ],
}), 1000, 1000).lines

test('an EXACT match outranks a longer line that merely contains the query', () => {
  const hits = matchLines(HAYSTACK, 'save')
  assert.equal(hits[0].text, 'Save')
  assert.equal(hits.length, 3)
})

test('a PREFIX match outranks a mid-string match', () => {
  // Note the query is NOT 'Save ' — whitespace collapsing normalizes that back
  // to 'save', which is an EXACT match on the Save button. Prefix ranking is
  // about a query that is a genuine leading fragment of a longer label.
  // 'Sav' is a prefix of all three, so RANK ties and position decides — and the
  // order is top-of-screen first ('Save As…' sits highest). What the ranking is
  // for is beating a mid-string match, tested next.
  assert.deepEqual(matchLines(HAYSTACK, 'Sav').map(h => h.text),
    ['Save As…', 'Save', 'Saved 3 minutes ago'])
  // 'ave' is mid-string in all three — same set, same positional order, which is
  // the point: rank only reorders when the query is anchored differently.
  const anchored = matchLines(HAYSTACK, 'aved 3')
  assert.deepEqual(anchored.map(h => h.text), ['Saved 3 minutes ago'])
})

test('a PREFIX match beats a mid-string match even when the mid-string one is higher up', () => {
  // The rank must dominate position, or the ordering degenerates to "whatever is
  // nearest the top of the screen" and a menu title outranks the button.
  const lines = parseOcrPayload(JSON.stringify({
    ok: true,
    lines: [
      // Highest on screen (largest normalized y), but 'Open' is mid-string.
      line('Recently Opened', { x: 0.1, y: 0.95, width: 0.2, height: 0.02 }),
      // Lower down, but a true prefix.
      line('Open File…', { x: 0.1, y: 0.2, width: 0.2, height: 0.02 }),
    ],
  }), 1000, 1000).lines
  assert.deepEqual(matchLines(lines, 'open').map(h => h.text), ['Open File…', 'Recently Opened'])
})

test('a trailing-space query still finds the exact label — collapsing runs first', () => {
  assert.equal(matchLines(HAYSTACK, 'Save ')[0].text, 'Save')
})

test('matching is case-insensitive — the model types what it reads', () => {
  assert.equal(matchLines(HAYSTACK, 'SIGN IN')[0].text, 'Sign  In')
})

test('whitespace is collapsed on BOTH sides — a wide button label still matches', () => {
  // Vision splits wide labels with multiple spaces; a query typed with one space
  // must still find it, or find_text misses exactly the buttons it exists for.
  assert.equal(matchLines(HAYSTACK, 'sign in').length, 1)
  assert.equal(matchLines(HAYSTACK, '  sign   in  ')[0].text, 'Sign  In')
})

test('ties break top-left first', () => {
  const lines = parseOcrPayload(JSON.stringify({
    ok: true,
    lines: [
      line('OK', { x: 0.8, y: 0.5, width: 0.05, height: 0.02 }),   // same row, right
      line('OK', { x: 0.2, y: 0.5, width: 0.05, height: 0.02 }),   // same row, left
      line('OK', { x: 0.5, y: 0.9, width: 0.05, height: 0.02 }),   // higher up
    ],
  }), 1000, 1000).lines
  const hits = matchLines(lines, 'ok')
  assert.equal(hits[0].centerY < hits[1].centerY, true, 'the topmost wins first')
  assert.ok(hits[1].centerX < hits[2].centerX, 'then left before right')
})

test('an empty or whitespace query matches NOTHING rather than everything', () => {
  // ''.includes() is true for every string — a blank query would otherwise
  // return the first line on screen and be clicked as "the best match".
  assert.deepEqual(matchLines(HAYSTACK, ''), [])
  assert.deepEqual(matchLines(HAYSTACK, '   '), [])
})

test('regex mode matches patterns', () => {
  const hits = matchLines(HAYSTACK, '^Save$', { regex: true })
  assert.deepEqual(hits.map(h => h.text), ['Save'])
})

test('an INVALID regex falls back to a literal search instead of throwing', () => {
  // A model writing a pattern with an unbalanced group must not take out the
  // turn; the literal is what it typed anyway.
  const hits = matchLines(HAYSTACK, 'Save(', { regex: true })
  assert.deepEqual(hits, [])
  const lines = parseOcrPayload(JSON.stringify({
    ok: true, lines: [line('Save(', { x: 0.1, y: 0.5, width: 0.1, height: 0.02 })],
  }), 100, 100).lines
  assert.equal(matchLines(lines, 'Save(', { regex: true })[0].text, 'Save(')
})

test('matching never mutates the input order', () => {
  const before = HAYSTACK.map(l => l.text)
  matchLines(HAYSTACK, 'save')
  assert.deepEqual(HAYSTACK.map(l => l.text), before)
})

// ── rendering: a truncated list must SAY it is truncated ─────────────────────

test('formatTextLines reports every line with a clickable centre', () => {
  const out = formatTextLines(HAYSTACK)
  assert.match(out, /^4 lines:/)
  assert.ok(out.includes('"Save" @ 530,785'))
  assert.match(out, /conf 1\.00/)
})

test('one line is singular', () => {
  assert.match(formatTextLines(HAYSTACK.slice(0, 1)), /^1 line:/)
})

test('no text found is stated, not returned as an empty string', () => {
  assert.equal(formatTextLines([]), 'no text found')
})

test('TRUNCATION IS REPORTED — a model told "40 lines" must not see 3 silently', () => {
  const many = parseOcrPayload(JSON.stringify({
    ok: true,
    lines: Array.from({ length: 40 }, (_, i) =>
      line(`line ${i}`, { x: 0.1, y: 0.02 * i, width: 0.1, height: 0.01 })),
  }), 1000, 1000).lines
  const out = formatTextLines(many, 3)
  assert.match(out, /^40 lines:/)
  assert.match(out, /… 37 more not shown/)
  assert.equal(out.split('\n').filter(l => l.startsWith('- ')).length, 3)
})

test('the default cap exists and is not unbounded', () => {
  assert.ok(Number.isInteger(OCR_LINE_LIMIT) && OCR_LINE_LIMIT > 0 && OCR_LINE_LIMIT < 1000)
})

// ── availability + wiring ───────────────────────────────────────────────────

test('hasVisionOcr answers for this machine without throwing', () => {
  assert.equal(typeof hasVisionOcr(), 'boolean')
  if (process.platform === 'darwin') assert.equal(hasVisionOcr(), true)
  else assert.equal(hasVisionOcr(), false)
})

test('readScreenText REGISTERS the shot, so OCR coordinates are click-ready', () => {
  // The join that makes the tool usable: capture() records origin+scale in
  // computer.ts's lastShot, and the OCR coordinates are measured in that same
  // delivered-image space, so imageToScreen converts them for free. Asserted at
  // the source rather than by driving a real screen.
  const src = readFileSync(new URL('../src/agent/computer.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export function readScreenText'))
  const fn = body.slice(0, body.indexOf('\n}\n') + 2)
  assert.match(fn, /lastShot = \{/, 'readScreenText must register the shot it captured')
  assert.match(fn, /recognizeText\(shot\.path, shot\.width, shot\.height/,
    'OCR must be scaled by the DELIVERED size, not the file on disk')
})

test('the ocr LABEL is announced when EITHER route exists, not just the screen one', () => {
  // CHANGED with read_image, and the old assertion was the bug's hiding place:
  // it required 'ocr' to sit INSIDE the hasComputerControl() gate, which was
  // right while the screen was the only thing Vision read. read_image rides
  // use_desktop, gated on hasDesktopSenses(), so a Mac with Vision but no
  // /usr/sbin/screencapture now REGISTERS a working OCR action while announcing
  // no ocr capability at all — a remote agent would never plan for it.
  // ⚠️ This used to assert the SOURCE TEXT of device-tools.ts, because the
  //    decision was inlined in makeDeviceTools() and there was no other way to
  //    reach it. It is a pure function now (labelOnlyCapabilities), so this asks
  //    about behaviour instead — a source-shape assertion breaks on a refactor
  //    that preserves the rule and passes on one that breaks it.
  //    device-tools.test.mjs owns the full 32-case matrix.
  const f = (over) => ({
    computer: false, desktop: false, windowControl: false, visionOcr: false, localSpeech: false, ...over,
  })
  // The screen route, and the FILE route that used to be denied.
  assert.ok(labelOnlyCapabilities(f({ visionOcr: true, computer: true })).includes('ocr'))
  assert.ok(labelOnlyCapabilities(f({ visionOcr: true, desktop: true })).includes('ocr'),
    'read_image rides use_desktop — a Mac with no screencapture still OCRs files')
  // Still Vision-gated: the label must not become unconditional.
  assert.ok(!labelOnlyCapabilities(f({ computer: true, desktop: true })).includes('ocr'))
  // And never announced with no tool to carry it.
  assert.ok(!labelOnlyCapabilities(f({ visionOcr: true })).includes('ocr'))
})

// ── a FILE, not the screen: the size nobody passed in ───────────────────────

test('parseImageOcrPayload scales by the MEASURED pixel size', () => {
  // The header fact: a 144-dpi image reports 800×400 in POINTS while its bitmap
  // is 1600×800. Vision's boxes are normalized, so the point size would place
  // every rect at exactly half scale — plausible numbers, silently wrong.
  // The box is Vision's ACTUAL output for /tmp/visprobe/wide.png, read back out
  // of osascript rather than invented — an invented one proves only arithmetic.
  const raw = JSON.stringify({
    ok: true, width: 1600, height: 800,
    lines: [line('HELLO TOP', {
      x: 0.027616276392200875, y: 0.8662500018937971,
      width: 0.2761627960205078, height: 0.08142441749572749,
    })],
  })
  const res = parseImageOcrPayload(raw)
  assert.equal(res.ok, true)
  assert.equal(res.value.width, 1600)
  assert.equal(res.value.height, 800)
  // MEASURED on this Mac against /tmp/visprobe/wide.png: x 44, y 42.
  assert.equal(res.value.lines[0].x, 44)
  assert.equal(res.value.lines[0].y, 42)
  // The half-scale answer a points-based read would give. This is the guard.
  assert.notEqual(res.value.lines[0].x, 22)
})

test('an UNMEASURABLE image is a refusal, never a defaulted size', () => {
  // A guessed size scales every rect by an invisible ratio, so there is no safe
  // fallback — the only honest output is no output.
  for (const p of [
    { ok: true, lines: [] },
    { ok: true, width: 0, height: 100, lines: [] },
    { ok: true, width: 100, height: -1, lines: [] },
    { ok: true, width: '1600', height: '800', lines: [] },
    { ok: true, width: null, height: null, lines: [] },
  ]) {
    const res = parseImageOcrPayload(JSON.stringify(p))
    assert.equal(res.ok, false, JSON.stringify(p))
    assert.match(res.error, /could not measure/)
  }
})

test('the two REFUSALS keep their own words — they send the caller to different fixes', () => {
  // MEASURED: a .txt gives not-an-image (NSImage won't decode it); a real
  // single-page PDF from cupsfilter DOES decode but has no bitmap rep at all.
  // Collapsing both into "OCR failed" tells the caller nothing to act on.
  const notImage = parseImageOcrPayload(JSON.stringify({ ok: false, err: 'not-an-image' }))
  assert.equal(notImage.ok, false)
  assert.match(notImage.error, /not an image/)
  const noPixels = parseImageOcrPayload(JSON.stringify({ ok: false, err: 'no-pixels' }))
  assert.equal(noPixels.ok, false)
  assert.match(noPixels.error, /no pixels/)
  assert.notEqual(notImage.error, noPixels.error)
  // Vision refusing an image it DID decode is a third answer again.
  const refused = parseImageOcrPayload(JSON.stringify({ ok: false, width: 10, height: 10, lines: [] }))
  assert.equal(refused.ok, false)
  assert.match(refused.error, /could not read/)
  // And garbage on stdout must not throw out of a tool call.
  assert.equal(parseImageOcrPayload('not json').ok, false)
})

test('zero lines in a DECODABLE image is a success, not an error', () => {
  // MEASURED: /tmp/visprobe/AppIcon.icns reads 256×256 with 0 lines. "No text
  // in this picture" is a real answer; treating it as failure makes a model
  // retry a photo of a sunset forever.
  const res = parseImageOcrPayload(JSON.stringify({ ok: true, width: 256, height: 256, lines: [] }))
  assert.equal(res.ok, true)
  assert.deepEqual(res.value, { width: 256, height: 256, lines: [] })
})

test('the largest representation wins by AREA, not by iteration order', () => {
  // MEASURED: a .icns holds 256/128/32/16px reps, and Vision reads the biggest.
  // A loop that took the FIRST rep, or compared only width, would scale every
  // coordinate by up to 16x. Asserted at the source — the pick happens in JXA.
  const src = readFileSync(new URL('../src/agent/vision.ts', import.meta.url), 'utf8')
  const prog = src.slice(src.indexOf('function imageOcrScript'), src.indexOf('parseImageOcrPayload'))
  assert.match(prog, /w \* h > W \* H/, 'the rep pick must compare AREA')
  assert.match(prog, /pixelsWide/, 'must read PIXELS, not NSImage.size (points)')
  assert.doesNotMatch(prog, /img\.size/, 'NSImage.size is points — it must not be the source of truth')
})

test('the nil-image guard uses isNil(), because a nil NSImage is TRUTHY in JXA', () => {
  // An ObjC nil wrapper is an object, so `if (!img)` never fires and the next
  // line throws on .representations — a text file then reads as a Vision bug.
  const src = readFileSync(new URL('../src/agent/vision.ts', import.meta.url), 'utf8')
  const prog = src.slice(src.indexOf('function imageOcrScript'), src.indexOf('parseImageOcrPayload'))
  assert.match(prog, /img\.isNil\(\)/)
  // And the helper must not be named `run`: that is JXA's own entry point, so
  // osascript calls it with an NSArray of argv and the program dies with
  // `-[__NSArrayM length]: unrecognized selector`, naming nothing in this file.
  assert.doesNotMatch(prog, /function run\s*\(/)
})

test('measure and read happen in ONE osascript', () => {
  // Two spawns would decode the file twice and could disagree if it changed in
  // between — and would double the ~270ms cost of the accurate pass.
  const src = readFileSync(new URL('../src/agent/vision.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function recognizeTextInFile'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2)
  assert.equal((body.match(/execFileSync\(/g) || []).length, 1)
})

test('~ is expanded in Node, because NSImage does not expand it', () => {
  assert.equal(expandTilde('~'), homedir())
  assert.equal(expandTilde('~/Downloads/a.png'), `${homedir()}/Downloads/a.png`)
  // Not a prefix match: a file legitimately named a~b.png must survive, and
  // `~other` is another user's home, which is not ours to rewrite.
  assert.equal(expandTilde('/tmp/a~b.png'), '/tmp/a~b.png')
  assert.equal(expandTilde('~other/a.png'), '~other/a.png')
  assert.equal(expandTilde(''), '')
})

test('a missing file and a directory say so, instead of arriving as a decode failure', () => {
  if (process.platform !== 'darwin') return
  assert.throws(() => recognizeTextInFile('/tmp/visprobe-definitely-absent.png'), /no such file/)
  assert.throws(() => recognizeTextInFile('/tmp'), /is a directory/)
  // The tilde is expanded BEFORE the existence check, or every ~ path would be
  // reported missing under its literal name.
  assert.throws(() => recognizeTextInFile('~/definitely-absent-9f2a.png'), new RegExp(homedir()))
})

test('formatFileOcr does NOT present file positions as click targets', () => {
  // computer.ts's formatTextLines labels each centre as somewhere to click,
  // because screen coordinates are click-ready by construction. These are
  // positions inside someone's holiday photo. A model that just learned "OCR
  // centres are clickable" must not carry that across.
  const res = {
    width: 1600, height: 800,
    lines: [{ text: 'HELLO TOP', confidence: 1, x: 44, y: 42, width: 442, height: 65, centerX: 265, centerY: 74 }],
  }
  const out = formatFileOcr('/tmp/wide.png', res)
  assert.match(out, /1600×800px/)
  assert.match(out, /do not click them/)
  // The difference is in the NUMBERS, not only the wording: the screen
  // formatter emits the CENTRE (what you click), this one emits the top-left
  // position (where the text is). Same line, deliberately different output.
  assert.match(formatTextLines([res.lines[0]]), /@ 265,74/)
  assert.match(out, /@ 44,42/)
  assert.doesNotMatch(out, /265,74/)
  // And the screen path's own click affordance must not appear on this one.
  const comp = readFileSync(new URL('../src/agent/computer.ts', import.meta.url), 'utf8')
  assert.match(comp, /ready to pass to click\/move_mouse/)
  assert.doesNotMatch(out, /ready to pass|clickable/i)
  assert.match(out, /"HELLO TOP"/)
})

test('an empty FAST read names its own retry; an empty accurate read does not', () => {
  // MEASURED, and the reason this flag is threaded through at all: the same
  // 1600×800 jpeg tagged Orientation=6 OCRs to 2 lines accurate and 0 lines
  // fast (98ms vs 276ms). So "fast found nothing" is ambiguous between "no text
  // here" and "text this mode cannot see" — and the model that chose fast is
  // the one party with no way to tell.
  const empty = { width: 800, height: 1600, lines: [] }
  const fast = formatFileOcr('/tmp/exif6.jpg', empty, { fast: true })
  assert.match(fast, /FAST read/)
  assert.match(fast, /Retry without fast/)
  const accurate = formatFileOcr('/tmp/exif6.jpg', empty)
  assert.match(accurate, /No text found in this image/)
  // No dead-end advice: there is nothing better to try after an accurate pass.
  assert.doesNotMatch(accurate, /Retry/)
  // A NON-empty fast result needs no caveat — it found what it found.
  const hit = { width: 10, height: 10, lines: [{ text: 'x', confidence: 1, x: 1, y: 1, width: 2, height: 2, centerX: 2, centerY: 2 }] }
  assert.doesNotMatch(formatFileOcr('/tmp/a.png', hit, { fast: true }), /Retry/)
})

test('a dense page is truncated and SAYS it was', () => {
  const lines = Array.from({ length: FILE_OCR_LINE_LIMIT + 7 }, (_, i) => ({
    text: `line ${i}`, confidence: 1, x: 0, y: i, width: 5, height: 5, centerX: 2, centerY: i,
  }))
  const out = formatFileOcr('/tmp/page.png', { width: 100, height: 900, lines })
  assert.match(out, /7 more not shown/)
  // The TRUE total, not the shown count — a silent cap reads as a complete read.
  assert.match(out, new RegExp(`${FILE_OCR_LINE_LIMIT + 7} lines`))
  assert.ok(!out.includes(`"line ${FILE_OCR_LINE_LIMIT + 1}"`))
  assert.equal(typeof FILE_OCR_LINE_LIMIT, 'number')
})

test('read_image is a real action on use_desktop, and its errors are RETURNED', () => {
  const src = readFileSync(new URL('../src/agent/desktop.ts', import.meta.url), 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const block = stripped.slice(stripped.indexOf("case 'read_image'"))
  const body = block.slice(0, block.indexOf('\n      }') + 8)
  assert.match(body, /need target/, 'no target must ask for one, not OCR nothing')
  assert.match(body, /if \(!hasVisionOcr\(\)\) return/, 'must gate on Vision')
  // Returned, not thrown: the outer catch would flatten "no such file" and
  // "that PDF is not a bitmap" into one `desktop error:`.
  assert.match(body, /catch \(e: any\) \{\s*return/)
  // fast threaded through to the formatter, or an empty fast read can't advise.
  assert.match(body, /formatFileOcr\(a\.target, res, \{ fast: a\.fast \}\)/)
  // Declared in the action union and the zod enum, or the model can't call it.
  assert.ok(stripped.includes("| 'read_image'"), 'missing from the DesktopArgs union')
  assert.match(stripped, /z\.enum\(\[[^\]]*'read_image'/s)
})

test('the tool description sends screen questions to use_computer, not here', () => {
  // The two OCR routes have DIFFERENT coordinate contracts, so the choice
  // between them is not a matter of taste — it decides whether the numbers the
  // model gets back are clickable.
  const src = readFileSync(new URL('../src/agent/desktop.ts', import.meta.url), 'utf8')
  const desc = src.slice(src.indexOf('DESKTOP_DESCRIPTION'))
  assert.match(desc, /read_image/)
  assert.match(desc, /use_computer read_screen/)
  assert.match(desc, /no tokens and no network/)
})

test("read_screen and find_text are real actions on use_computer, and both gate on Vision", () => {
  const src = readFileSync(new URL('../src/agent/computer.ts', import.meta.url), 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const a of ["case 'read_screen'", "case 'find_text'", "case 'ocr'"]) {
    assert.ok(stripped.includes(a), `missing ${a}`)
  }
  // Two call sites, both preceded by the availability check.
  assert.equal((stripped.match(/if \(!hasVisionOcr\(\)\) return/g) || []).length, 2)
})

test('find_text with no needle asks for one instead of OCRing the screen for nothing', () => {
  const src = readFileSync(new URL('../src/agent/computer.ts', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf("case 'find_text'"), src.indexOf("case 'screen_size'"))
  const guardIdx = block.indexOf('need text to find')
  const readIdx = block.indexOf('readScreenText(')
  assert.ok(guardIdx > 0 && readIdx > guardIdx, 'the guard must come before the capture')
})

test('a find_text MISS reports the size of the haystack, not just "not found"', () => {
  // Otherwise "no match" reads as "that text is not on screen", when the real
  // answer is often "OCR read it differently" — and the recovery differs.
  const src = readFileSync(new URL('../src/agent/computer.ts', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf("case 'find_text'"), src.indexOf("case 'screen_size'"))
  assert.match(block, /recognized line/)
  assert.match(block, /read_screen/)
})

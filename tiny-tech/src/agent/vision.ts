/**
 * On-device OCR — reads the text in an image with Apple's Vision framework.
 *
 * The port note in docs/e2e-gaps-report-2026-07-25.md §3.2 said this needed "a
 * 30-line Swift Vision helper CLI (macOS has no OCR CLI)". It doesn't: Vision
 * binds through the SAME JXA bridge computer.ts already uses for CGEvent, so
 * `npx tiny-tech` stays install-free and there is no helper binary to build,
 * sign, or keep in step with the daemon. Nothing leaves the machine — VNRecognize
 * TextRequest runs on the Neural Engine, so this is the one "vision" path that
 * costs no tokens and no network.
 *
 * WHY IT EARNS ITS PLACE NEXT TO A SCREENSHOT: c12/c13 gave the daemon eyes —
 * a screenshot arrives as a real ImageBlock, so the model SEES the screen. What
 * it still had to do by eye was *measure*: read a pixel coordinate off that
 * image and hope the click lands on the button. OCR turns a label into a rect,
 * so "click Sign In" becomes arithmetic instead of estimation.
 *
 * TWO GEOMETRY FACTS, BOTH MEASURED RATHER THAN ASSUMED (they are the whole
 * reason this file has pure functions and tests):
 *
 *  1. Vision's `boundingBox` is NORMALIZED (0..1 of the image) — which is the
 *     good news, because it makes OCR immune to the Retina physical-vs-logical
 *     pixel trap that computer.ts has to correct for. Multiply by whatever size
 *     the image was actually delivered at and the numbers are right.
 *  2. Its origin is BOTTOM-LEFT, unlike screenshots, clicks and CGEvent, which
 *     are all top-left. Text drawn at the top of a synthetic 400×400 image
 *     reports y ≈ 0.885. So the y axis MUST be flipped: `1 - (y + height)`.
 *     Skipping that flip does not fail — it mirrors every coordinate about the
 *     horizontal centre line, which reads as "OCR works but clicks land on the
 *     wrong row", the most expensive kind of wrong.
 *
 * TWO CALLERS, TWO SIZE CONTRACTS. `recognizeText` reads THE SCREEN, where
 * capture() already measured the delivered image, so the size is passed in.
 * `recognizeTextInFile` reads a file the model NAMED, where nobody knows the
 * size — so it measures the bitmap itself, in the same osascript. See that
 * function's docblock for the three measured traps (points vs pixels,
 * multi-representation images, EXIF orientation).
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'

const isMac = os.platform() === 'darwin'

/** One recognized line, in the image's own pixel space, top-left origin. */
export interface TextLine {
  text: string
  /** Vision's own confidence for the winning candidate, 0..1. */
  confidence: number
  /** Left edge, in image pixels. */
  x: number
  /** Top edge, in image pixels (already flipped out of Vision's bottom-left). */
  y: number
  width: number
  height: number
  /** Centre of the line — what you click. */
  centerX: number
  centerY: number
}

export interface NormalizedBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Vision's normalized bottom-left box → an image-space top-left rect.
 *
 * Pure because it is the one step where a sign error is invisible: every output
 * is plausible, just reflected. Rounded to whole pixels — a click coordinate is
 * an integer and a fractional rect only invites the caller to round differently.
 */
export function boxToImageRect(
  box: NormalizedBox,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number; centerX: number; centerY: number } {
  const w = box.width * imageWidth
  const h = box.height * imageHeight
  const x = box.x * imageWidth
  // The flip. Vision measures y from the BOTTOM; everything else here measures
  // from the top, so the top edge is the distance from the image top down to the
  // box's UPPER edge, i.e. 1 - (origin.y + height).
  const y = (1 - (box.y + box.height)) * imageHeight
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: Math.round(h),
    centerX: Math.round(x + w / 2),
    centerY: Math.round(y + h / 2),
  }
}

/**
 * The JXA program. `path` is embedded with JSON.stringify so a filename with a
 * quote or a backslash can't break out of the literal.
 *
 * `recognitionLevel = 0` is ACCURATE (1 is fast). Accurate is the right default
 * for UI text: a fast pass mangles the small labels that are exactly what a
 * `find` is looking for, and the cost is tens of milliseconds on the ANE.
 */
function ocrScript(path: string, fast: boolean): string {
  return `
ObjC.import('Vision'); ObjC.import('Foundation');
var url = $.NSURL.fileURLWithPath(${JSON.stringify(path)});
var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary);
var req = $.VNRecognizeTextRequest.alloc.init;
req.recognitionLevel = ${fast ? 1 : 0};
req.usesLanguageCorrection = ${fast ? 'false' : 'true'};
var err = Ref();
var ok = handler.performRequestsError($.NSArray.arrayWithObject(req), err);
var lines = [];
var res = ok ? req.results : null;
if (res) {
  for (var i = 0; i < res.count; i++) {
    var obs = res.objectAtIndex(i);
    var cands = obs.topCandidates(1);
    if (!cands || !cands.count) continue;
    var c = cands.objectAtIndex(0);
    var b = obs.boundingBox;
    lines.push({
      text: ObjC.unwrap(c.string),
      confidence: c.confidence,
      box: { x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height },
    });
  }
}
JSON.stringify({ ok: !!ok, lines: lines })
`
}

/**
 * Tolerant reader for the JXA payload. Separate from the spawn so the shape
 * contract is testable without a Mac in the loop, and so a Vision revision that
 * starts omitting a field degrades to a skipped line rather than a thrown turn.
 */
export function parseOcrPayload(
  raw: string,
  imageWidth: number,
  imageHeight: number,
): { ok: boolean; lines: TextLine[] } {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, lines: [] }
  }
  const src = Array.isArray(parsed?.lines) ? parsed.lines : []
  const lines: TextLine[] = []
  for (const l of src) {
    const text = String(l?.text ?? '')
    const b = l?.box
    if (!text.trim() || !b) continue
    // `typeof === 'number'` and NOT Number(): `Number(null)` is 0 and
    // `Number(true)` is 1, so a coercing check turns a MISSING width into a
    // zero-width box whose centre is its left edge — a plausible click target
    // pointing at the wrong place. A dropped line is honest; a 0×0 box is not.
    const nums = [b.x, b.y, b.width, b.height]
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) continue
    const rect = boxToImageRect({ x: nums[0], y: nums[1], width: nums[2], height: nums[3] }, imageWidth, imageHeight)
    const conf = Number(l?.confidence)
    lines.push({ text, confidence: Number.isFinite(conf) ? conf : 0, ...rect })
  }
  return { ok: !!parsed?.ok, lines }
}

/**
 * Run Vision over an image file. Coordinates come back in that image's own pixel
 * space — the caller supplies the delivered size, because a screenshot resampled
 * to logical points (computer.ts capture()) is smaller than the file on disk was.
 */
export function recognizeText(
  path: string,
  imageWidth: number,
  imageHeight: number,
  opts?: { fast?: boolean; timeoutMs?: number },
): TextLine[] {
  if (!isMac) throw new Error('OCR needs macOS (Vision framework)')
  if (!fs.existsSync(path)) throw new Error(`no such image: ${path}`)
  let out: string
  try {
    out = execFileSync('osascript', ['-l', 'JavaScript', '-e', ocrScript(path, !!opts?.fast)], {
      encoding: 'utf-8',
      timeout: opts?.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (e: any) {
    throw new Error(`OCR failed: ${String(e?.stderr || e?.message || e).slice(0, 300)}`)
  }
  const res = parseOcrPayload(out, imageWidth, imageHeight)
  // ok:false is Vision refusing the image (unreadable/undecodable file), NOT an
  // image with no text in it — those are different answers and only the first is
  // an error. A blank screen legitimately OCRs to zero lines.
  if (!res.ok) throw new Error('Vision could not read that image (unsupported or corrupt file)')
  return res.lines
}

// ── an arbitrary image file, not the screen ─────────────────────────────────

/**
 * The general case. `recognizeText` above needs the caller to KNOW the delivered
 * pixel size, which only the screenshot path does (capture() measured it). For a
 * file the model names — a photo, a design mock, a receipt someone dropped in
 * ~/Downloads — nobody knows the size, and guessing it is not a small error:
 * every coordinate scales by the ratio, so the OCR "works" and every rect is
 * wrong. So the size is MEASURED in the same JXA program that runs the request.
 *
 * Which pixel size, precisely, is the whole reason this is separate code:
 *
 * ⚠️ `NSImage.size` is in POINTS, not pixels. An image authored at 144 dpi
 *    reports 800×400 while its bitmap is 1600×800 (measured on this Mac with an
 *    NSImage-drawn PNG). Vision's boxes are normalized, so scaling them by the
 *    POINT size yields coordinates exactly half as large as the file — plausible
 *    numbers, silently half-scale. The rep's `pixelsWide/pixelsHigh` is the only
 *    honest answer, so that is what `imageDimensions` reads.
 *
 * ⚠️ An image can carry SEVERAL representations at different sizes (a .icns
 *    measured here holds 256/128/32/16 px). The largest is the one to OCR
 *    against — it is the one Vision reads — so the pick is by AREA, not by
 *    iteration order.
 *
 * ⚠️ EXIF orientation is applied by both layers, consistently. A jpeg tagged
 *    Orientation=6 reports its rotated dimensions (800×1600 for a 1600×800
 *    bitmap) AND Vision returns boxes in that same rotated frame — verified
 *    against a hand-tagged file. Because both sides agree, there is nothing to
 *    correct; the danger would be "helpfully" un-rotating one of them.
 */
export interface ImageOcr {
  /** Pixel size Vision actually read — what the coordinates below are in. */
  width: number
  height: number
  lines: TextLine[]
}

/**
 * The JXA program: measure, then read, in ONE osascript. Two spawns would be two
 * decodes of the same file and, worse, could disagree if the file changed
 * between them.
 *
 * ⚠️ The helper must NOT be called `run`. `run` is JXA's own entry point, so
 *    osascript invokes it with an NSArray of argv — the function's first act is
 *    to treat that array as a path and the whole program dies with
 *    `-[__NSArrayM length]: unrecognized selector`, an error that names nothing
 *    in this file. Cost an hour once; the name is load-bearing.
 */
function imageOcrScript(path: string, fast: boolean): string {
  return `
ObjC.import('AppKit'); ObjC.import('Vision'); ObjC.import('Foundation');
function ocrFile(p, fast) {
  var img = $.NSImage.alloc.initWithContentsOfFile(p);
  // A nil NSImage is TRUTHY in JXA (an ObjC nil wrapper is an object), so
  // \`if (!img)\` never fires — isNil() is the only honest check. Without it the
  // next line throws on .representations and a text file reads as a Vision bug.
  if (img.isNil()) return { ok: false, err: 'not-an-image' };
  var reps = img.representations;
  var W = 0, H = 0;
  for (var i = 0; i < Number(reps.count); i++) {
    var r = reps.objectAtIndex(i);
    var w = Number(r.pixelsWide), h = Number(r.pixelsHigh);
    if (w * h > W * H) { W = w; H = h; }
  }
  if (!(W > 0 && H > 0)) return { ok: false, err: 'no-pixels' };
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(p), $.NSDictionary.dictionary);
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = fast ? 1 : 0;
  req.usesLanguageCorrection = fast ? false : true;
  var err = Ref();
  var ok = handler.performRequestsError($.NSArray.arrayWithObject(req), err);
  var lines = [];
  var res = ok ? req.results : null;
  if (res) {
    for (var j = 0; j < Number(res.count); j++) {
      var obs = res.objectAtIndex(j);
      var cands = obs.topCandidates(1);
      if (!cands || !Number(cands.count)) continue;
      var c = cands.objectAtIndex(0);
      var b = obs.boundingBox;
      lines.push({
        text: ObjC.unwrap(c.string),
        confidence: c.confidence,
        box: { x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height },
      });
    }
  }
  return { ok: !!ok, width: W, height: H, lines: lines };
}
JSON.stringify(ocrFile(${JSON.stringify(path)}, ${fast ? 'true' : 'false'}))
`
}

/**
 * Reader for the measure+read payload. Separate from the spawn so the size
 * contract is testable without a Mac, and so the two REFUSALS keep their own
 * words: "that file isn't an image" and "that image has no pixels" send the
 * caller to different fixes, and neither is "OCR failed".
 *
 * A payload whose size is missing or non-positive is a refusal, NOT a default:
 * falling back to some nominal size would return coordinates scaled by an
 * arbitrary ratio, which is the one failure mode this whole path exists to
 * prevent.
 */
export function parseImageOcrPayload(raw: string): { ok: true; value: ImageOcr } | { ok: false; error: string } {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'OCR returned no readable result' }
  }
  if (parsed?.err === 'not-an-image') {
    return { ok: false, error: 'not an image this Mac can decode (images: png/jpeg/heic/gif/tiff/bmp — not PDFs or text files)' }
  }
  if (parsed?.err === 'no-pixels') {
    return { ok: false, error: 'that file decoded to no pixels (a vector or PDF wrapper, not a bitmap)' }
  }
  if (!parsed?.ok) {
    return { ok: false, error: 'Vision could not read that image (unsupported or corrupt file)' }
  }
  const width = typeof parsed.width === 'number' && Number.isFinite(parsed.width) ? parsed.width : 0
  const height = typeof parsed.height === 'number' && Number.isFinite(parsed.height) ? parsed.height : 0
  if (width <= 0 || height <= 0) {
    // Coordinates without a size are unusable and a guessed size is worse than
    // no answer — every rect would be off by the same invisible ratio.
    return { ok: false, error: 'could not measure that image (no pixel dimensions)' }
  }
  const { lines } = parseOcrPayload(raw, width, height)
  return { ok: true, value: { width, height, lines } }
}

/**
 * OCR an arbitrary image file on this Mac.
 *
 * `~` is expanded here, in Node: NSImage does NOT expand it (a `~/x.png` path
 * comes back as "not an image", which reads as a corrupt file rather than a
 * path the caller has to fix), and a model asked for "the screenshot in my
 * Downloads" writes `~` roughly every time.
 */
export function recognizeTextInFile(
  path: string,
  opts?: { fast?: boolean; timeoutMs?: number },
): ImageOcr {
  if (!isMac) throw new Error('OCR needs macOS (Vision framework)')
  const full = expandTilde(path)
  // Checked in Node so "no such file" says so, instead of arriving as the
  // decode failure a wrong-format file also produces.
  if (!fs.existsSync(full)) throw new Error(`no such file: ${full}`)
  if (fs.statSync(full).isDirectory()) throw new Error(`${full} is a directory, not an image`)
  let out: string
  try {
    out = execFileSync('osascript', ['-l', 'JavaScript', '-e', imageOcrScript(full, !!opts?.fast)], {
      encoding: 'utf-8',
      timeout: opts?.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (e: any) {
    throw new Error(`OCR failed: ${String(e?.stderr || e?.message || e).slice(0, 300)}`)
  }
  const res = parseImageOcrPayload(out)
  if (!res.ok) throw new Error(res.error)
  return res.value
}

/** `~` → the home directory. Only a leading `~/` (or a bare `~`) — a file
 *  legitimately named `a~b.png` must not be rewritten. */
export function expandTilde(path: string): string {
  if (path === '~') return os.homedir()
  if (path.startsWith('~/')) return os.homedir() + path.slice(1)
  return path
}

/**
 * Text-dump of the recognized lines, in Vision's own order.
 *
 * Deliberately NOT re-sorted by position: Vision already returns reading order,
 * and a naive sort-by-y interleaves columns — a two-pane window would come out
 * as alternating fragments of both panes, which reads as garbled OCR rather than
 * as a layout bug.
 */
export function linesToText(lines: TextLine[]): string {
  return lines.map((l) => l.text).join('\n')
}

/**
 * Find the lines matching a query, best first.
 *
 * Matching is case-insensitive substring by default, because that is how a model
 * asks ("sign in" for a button rendered "Sign In"). Ranking prefers an exact
 * match, then a prefix, then position in the image (top-left first) — so a
 * screen with a "Save" button and a "Save As…" menu item resolves to the button.
 *
 * Whitespace is collapsed on BOTH sides: Vision splits a wide button label into
 * runs separated by wide gaps, and a query typed with a single space would
 * otherwise miss a label the model can plainly read in the screenshot.
 */
export function matchLines(lines: TextLine[], query: string, opts?: { regex?: boolean }): TextLine[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const q = norm(query)
  if (!q) return []
  let pred: (l: TextLine) => boolean
  if (opts?.regex) {
    let re: RegExp
    try {
      re = new RegExp(query, 'i')
    } catch {
      // An invalid pattern must not throw out of a tool call — fall back to the
      // literal, which is what the caller typed anyway.
      return matchLines(lines, query)
    }
    pred = (l) => re.test(l.text)
  } else {
    pred = (l) => norm(l.text).includes(q)
  }
  const hits = lines.filter(pred)
  const score = (l: TextLine): number => {
    const t = norm(l.text)
    if (t === q) return 0
    if (t.startsWith(q)) return 1
    return 2
  }
  return hits.sort((a, b) => {
    const d = score(a) - score(b)
    if (d) return d
    if (a.y !== b.y) return a.y - b.y
    return a.x - b.x
  })
}

/** Cap on lines rendered out of a FILE — a dense page OCRs to hundreds. */
export const FILE_OCR_LINE_LIMIT = 200

/**
 * Render a file's OCR result.
 *
 * ⚠️ Deliberately NOT computer.ts's `formatTextLines`, and the difference is the
 *    point: that one labels each centre as somewhere to CLICK, because screen
 *    coordinates are click-ready by construction (readScreenText registers the
 *    shot). These coordinates are positions inside a FILE — a photo, a mock, a
 *    downloaded screenshot — and have no relationship to what is on the screen
 *    right now. A model that had just learned "OCR centres are clickable" would
 *    otherwise click a point measured in someone's holiday photo. So the header
 *    says which frame the numbers are in, and the lines carry a plain position
 *    rather than a click target.
 *
 * ⚠️ `fast` is not just slower-vs-quicker, and the result has to say so. MEASURED
 *    on this Mac: the same 1600×800 jpeg tagged Orientation=6 (so its text runs
 *    sideways in the bitmap) OCRs to 2 lines accurate / **0 lines fast**, while
 *    the un-rotated twin gives 2 either way — 98ms vs 276ms. So a fast pass that
 *    finds nothing is ambiguous between "no text here" and "text this mode
 *    can't see", and the model that chose `fast` is the one party who can't tell.
 *    An empty fast result therefore names the retry; an empty accurate one
 *    doesn't, because there is nothing better to try.
 */
export function formatFileOcr(
  path: string,
  res: ImageOcr,
  opts?: { limit?: number; fast?: boolean },
): string {
  const limit = opts?.limit ?? FILE_OCR_LINE_LIMIT
  const head = `👁️ ${path} — ${res.width}×${res.height}px, read on-device (no image spent)`
  if (!res.lines.length) {
    // Zero lines is a real answer about a real image, not a failure — say which,
    // or the model retries a photo of a sunset forever.
    if (opts?.fast) {
      return `${head}\n\nNo text found — but this was a FAST read, which misses rotated and very small text. Retry without fast to be sure.`
    }
    return `${head}\n\nNo text found in this image.`
  }
  const shown = res.lines.slice(0, limit)
  const body = shown
    .map((l) => `- "${l.text}"  @ ${l.x},${l.y} (${l.width}×${l.height}, conf ${l.confidence.toFixed(2)})`)
    .join('\n')
  const more = res.lines.length > shown.length ? `\n… ${res.lines.length - shown.length} more not shown` : ''
  return (
    `${head}\nPositions are pixels INSIDE THIS IMAGE — not screen coordinates, so do not click them.\n\n` +
    `${res.lines.length} line${res.lines.length === 1 ? '' : 's'}:\n${body}${more}`
  )
}

/** Is on-device OCR available here? */
export function hasVisionOcr(): boolean {
  return isMac && fs.existsSync('/usr/bin/osascript')
}

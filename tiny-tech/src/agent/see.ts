/**
 * 👀 see_image — the daemon SHOWS the model a picture, instead of describing it.
 *
 * This closes the half of the report's "Vision → model" row that c57 left open.
 * `read_image` (vision.ts) answers "what does that text say" on-device, for free,
 * and that is the right tool most of the time. But it can only ever return TEXT,
 * so every question that isn't about lettering — "is this mock aligned?", "which
 * of these two screenshots is the newer build?", "what breed is that?" — had no
 * path at all. The daemon would answer from prose it invented about a file only
 * it could open.
 *
 * ⚠️ THE REPORT'S DIAGNOSIS WAS TWO-THIRDS WRONG, and probing beat planning here
 *    for the fifth time in this loop. It claimed this was "blocked at 3 layers:
 *    local loop is string-in/string-out (agent.ts:156), tools return strings,
 *    relay caps 8KB". MEASURED against @strands-agents/sdk 1.10 with a recording
 *    stub model:
 *      · Tools returning image blocks: **already works.** A callback returning
 *        `[{text}, {image:{format,source:{bytes}}}]` arrives at the model as a
 *        `toolResult` whose content carries the image verbatim — no conversion,
 *        no flattening. `computer.ts` has been doing this since d-c.
 *      · `invoke()` string-only: **not a blocker.** `InvokeArgs` is
 *        `string | ContentBlock[] | Message[] | …`, and a wrapped
 *        `[{text},{image:{…}}]` passes straight through. Nothing needed changing.
 *      · The 8KB relay cap: **real, and unchanged.** d-d already solved it the
 *        only way it can be solved — bytes to /api/media, a URL in the envelope.
 *    So the actual gap was never plumbing. It was that no tool ever put a FILE
 *    into the conversation as pixels. That is all this module does.
 *
 * Everything here is a pure decision over measured facts, with the one spawn
 * (`sips`) behind an injected runner — so the whole matrix is testable without
 * touching a real image or paying a vision token.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import { expandTilde } from './vision.js'

/** Formats a model can actually be shown (SDK mime.ts IMAGE_FORMATS ∩ the
 *  media store's allowlist). Anything else has to be converted first. */
export const SHOWABLE: Record<string, string> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
}

/**
 * Byte cap on what gets attached, decoded.
 *
 * Deliberately smaller than media.ts's MAX_IMAGE_BYTES (6MB, the media store's
 * own limit): that one bounds an UPLOAD, this one bounds a thing that becomes
 * base64 inside a model request, where it costs tokens and request size. A 4000×
 * 3000 photo is ~300KB of PNG and ~400KB of base64 — fine. A 40MP panorama is
 * not, and the fix (downscale) is free.
 */
export const SEE_MAX_BYTES = 1_500_000

/**
 * Longest edge a shown image is resampled to.
 *
 * Not a quality choice — a token choice. Every provider tiles an image before it
 * reaches the model, so pixels past ~1600 on the long edge buy detail nobody
 * reads and are charged for anyway.
 */
export const SEE_MAX_EDGE = 1600

/** What a file turned out to be, measured rather than assumed. */
export interface Probed {
  /** sips' own idea of the format — from the BYTES, not the extension. */
  format: string
  width: number
  height: number
}

/**
 * 🔎 Sniff the format from CONTENT, never from the extension.
 *
 * ⚠️ MEASURED: a JPEG copied to `liar.png` reports `format: jpeg` to sips and
 *    decodes fine, and Preview opens it happily — extensions on a user's disk are
 *    a hint, not a fact (screenshots renamed by hand, files saved out of a
 *    browser, anything that came off a phone). Trusting the extension would tag
 *    the attached block `png` while the bytes are JPEG, and a provider that
 *    believes the declared mime type either refuses the request or, worse,
 *    decodes garbage. So the format that gets DECLARED is the one sips read.
 *
 * These are the magic numbers as they actually appear on this machine (`xxd -p
 * -l 16`), not from a table:
 *   png  89504e470d0a1a0a…      jpeg ffd8ff…
 *   gif  474946383761… ("GIF87a")  webp 52494646…"WEBP"
 *   heic 00000024 66747970 68656963  ("....ftypheic")
 *   tiff 4d4d002a (MM) / 49492a00 (II)   bmp 424d ("BM")
 */
export function sniffFormat(head: Uint8Array): string | null {
  const at = (i: number) => head[i] ?? -1
  const eq = (i: number, ...bytes: number[]) => bytes.every((b, k) => at(i + k) === b)
  if (eq(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (eq(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (eq(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  // RIFF….WEBP — the size field sits between the two tags, so both are checked.
  if (eq(0, 0x52, 0x49, 0x46, 0x46) && eq(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  // ISO-BMFF: the brand is at offset 8, and heic/heif/heix/hevc/mif1 are all
  // the same container. Only the brands Apple actually writes are claimed.
  if (eq(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11))
    if (/^(heic|heix|hevc|heim|heis|hevm|mif1|msf1)$/.test(brand)) return 'heic'
    return null
  }
  if (eq(0, 0x4d, 0x4d, 0x00, 0x2a) || eq(0, 0x49, 0x49, 0x2a, 0x00)) return 'tiff'
  if (eq(0, 0x42, 0x4d)) return 'bmp'
  return null
}

/** How many bytes sniffFormat needs. The brand check reaches offset 11. */
export const SNIFF_BYTES = 16

/**
 * How many bytes measureHeader needs.
 *
 * ⚠️ MEASURED, and the reason this is not SNIFF_BYTES: png/gif/webp carry their
 *    dimensions inside the first 32 bytes, but JPEG carries them in a SOF
 *    segment that sits AFTER every APPn block — in the 500×300 jpeg sips wrote
 *    here, SOF0 is at offset **204**, behind a JFIF header and a 124-byte EXIF
 *    block. A camera's jpeg with a full EXIF thumbnail pushes it further still,
 *    so this is a budget rather than a bound: past it, measuring honestly fails
 *    and prepareImage says so instead of guessing.
 */
export const MEASURE_BYTES = 65_536

/**
 * 📐 Measure width/height from the header bytes alone — no sips, no spawn.
 *
 * THE POINT: sips is BOTH the measurer and the resampler here, and that coupling
 * quietly broke a promise this file makes three times ("only the CONVERT branch
 * needs the binary", "a machine without sips can still be shown a small png").
 * It could not: realSeeIo.probe IS sips, its failure returns null, and planSee
 * refuses on a null probe. So on Linux, or on a Mac with sips missing, an
 * already-showable 3KB png was refused with `not an image I can show` — a
 * sentence contradicting the sniff this very module had just done on those
 * bytes. Measuring is a pure function over a header; only RESAMPLING needs a
 * binary, and now only resampling asks for one.
 *
 * Formats are limited to the four SHOWABLE ones on purpose. heic/tiff/bmp need
 * converting whatever their size, so their dimensions change nothing — planSee
 * checks the format disqualifier first, and a measured heic would still convert.
 *
 * Every offset below is read off a real file (`xxd -p -l 40`), never a spec:
 *   png  89504e470d0a1a0a 0000000d 49484452 | ae000000bc → 174×188 at 16..24
 *   gif  474946383761 6000 4000                → 96×64 little-endian at 6..10
 *   webp RIFF….WEBP then VP8 / VP8L / VP8X, three different geometry encodings
 *   jpeg SOF0 ffc0 0011 08 012c 01f4          → 500×300, height BEFORE width
 */
export function measureHeader(head: Uint8Array, fmt: string): { width: number; height: number } | null {
  const u8 = (i: number): number | null => (i < head.length ? head[i] : null)
  const be = (i: number, n: number): number | null => {
    let v = 0
    for (let k = 0; k < n; k++) {
      const b = u8(i + k)
      if (b === null) return null
      v = v * 256 + b
    }
    return v
  }
  const le = (i: number, n: number): number | null => {
    let v = 0
    for (let k = n - 1; k >= 0; k--) {
      const b = u8(i + k)
      if (b === null) return null
      v = v * 256 + b
    }
    return v
  }
  const ok = (w: number | null, h: number | null) =>
    w !== null && h !== null && w > 0 && h > 0 ? { width: w, height: h } : null

  if (fmt === 'png') {
    // The IHDR chunk is mandatory and must be FIRST, so its position is fixed:
    // 8-byte signature, 4-byte length, "IHDR", then width and height.
    if (String.fromCharCode(u8(12) ?? 0, u8(13) ?? 0, u8(14) ?? 0, u8(15) ?? 0) !== 'IHDR') return null
    return ok(be(16, 4), be(20, 4))
  }
  if (fmt === 'gif') {
    // Logical screen descriptor, little-endian — the one format here that is.
    return ok(le(6, 2), le(8, 2))
  }
  if (fmt === 'webp') {
    const chunk = String.fromCharCode(u8(12) ?? 0, u8(13) ?? 0, u8(14) ?? 0, u8(15) ?? 0)
    if (chunk === 'VP8 ') {
      // Lossy: a 3-byte frame tag, the 3-byte start code 9d 01 2a, then two
      // 16-bit fields whose top 2 bits are a scaling hint, not size.
      if (!(u8(23) === 0x9d && u8(24) === 0x01 && u8(25) === 0x2a)) return null
      const w = le(26, 2)
      const h = le(28, 2)
      return ok(w === null ? null : w & 0x3fff, h === null ? null : h & 0x3fff)
    }
    if (chunk === 'VP8L') {
      // Lossless: 14 bits each, packed across bytes after the 0x2f signature.
      if (u8(20) !== 0x2f) return null
      const b = le(21, 4)
      if (b === null) return null
      return ok((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') {
      // Extended (alpha/animation/metadata): canvas size as 24-bit minus-one.
      const w = le(24, 3)
      const h = le(27, 3)
      return ok(w === null ? null : w + 1, h === null ? null : h + 1)
    }
    return null
  }
  if (fmt === 'jpeg') {
    // Walk the segment chain to the first SOF. Not a fixed offset: the SOF sits
    // behind however many APPn blocks the encoder wrote (204 bytes in, here).
    let i = 2
    while (i + 1 < head.length) {
      if (u8(i) !== 0xff) {
        // Fill bytes (ff ff …) are legal between segments; anything else means
        // this is not a segment boundary and the walk cannot be trusted.
        i++
        continue
      }
      const marker = u8(i + 1)
      if (marker === null) return null
      // Standalone markers carry no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      // SOS/EOI: the entropy-coded scan starts here, so no SOF is coming.
      if (marker === 0xda || marker === 0xd9) return null
      const len = be(i + 2, 2)
      if (len === null || len < 2) return null
      // SOF0..SOF15, excluding the three that are not frame headers (DHT c4,
      // JPG c8, DAC cc). Progressive and lossless SOFs carry size identically.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        // Height precedes width in a SOF — the one place in this file where the
        // obvious order is wrong, and a swap makes a portrait photo landscape.
        return ok(be(i + 7, 2), be(i + 5, 2))
      }
      i += 2 + len
    }
    return null
  }
  return null
}

/** What has to happen to a file before a model can be shown it. */
export type SeePlan =
  | { kind: 'refuse'; reason: string }
  | { kind: 'attach'; format: string }
  | { kind: 'convert'; to: 'jpeg' | 'png'; why: string }
  | { kind: 'shrink'; format: string; edge: number; why: string }

/**
 * Decide what to do with a measured file — the whole policy, as one pure
 * function over facts somebody else gathered.
 *
 * ORDER IS THE DESIGN, and it is the same ordering rule the wallet's faucet
 * needed: the PERMANENT disqualifier is checked before the fixable one. An
 * unshowable format (heic, tiff, bmp) must be converted whatever its size,
 * because a shrink of a heic is still a heic no provider accepts. Only once the
 * format is showable does size matter.
 */
export function planSee(
  probed: Probed | null,
  bytes: number,
  opts?: { maxBytes?: number; maxEdge?: number; sniffed?: string },
): SeePlan {
  const maxBytes = opts?.maxBytes ?? SEE_MAX_BYTES
  const maxEdge = opts?.maxEdge ?? SEE_MAX_EDGE
  // The permanent disqualifier outranks the missing measurement, for the same
  // reason it outranks size below: a heic must be converted whatever its
  // dimensions, so "I couldn't measure it" would be a true sentence that sends
  // the reader to the wrong fix. Only reachable when nothing measured, since a
  // measured file has its own format — this is the unmeasured file's format.
  if (!probed && opts?.sniffed && !SHOWABLE[opts.sniffed.toLowerCase()]) {
    return { kind: 'convert', to: 'jpeg', why: `${opts.sniffed} is not a format a model can be shown` }
  }
  // NOT 'not-an-image'. Every caller reaches this only after the bytes sniffed
  // AS an image, so "these are not image bytes" would be a diagnosis this code
  // has already disproved — and a confidently wrong one sends the user to the
  // wrong fix (they go looking for a corrupt file instead of a missing sips).
  // Unmeasured is its own honest answer: it IS an image, nobody could size it.
  if (!probed) return { kind: 'refuse', reason: 'unmeasured' }
  const fmt = String(probed.format || '').toLowerCase()
  if (!fmt) return { kind: 'refuse', reason: 'unmeasured' }
  if (!(probed.width > 0 && probed.height > 0)) {
    // A PDF and a multi-page tiff both "decode" while having no single bitmap to
    // show. Same refusal vision.ts uses, same reason: it is a different fix.
    return { kind: 'refuse', reason: 'no-pixels' }
  }
  if (!SHOWABLE[fmt]) {
    // JPEG rather than PNG on purpose: everything in this branch is a PHOTO
    // container (heic off an iPhone, a scanner's tiff), where PNG would be
    // lossless-encoding continuous tone — several times the bytes for detail a
    // tiled vision model never resolves.
    return { kind: 'convert', to: 'jpeg', why: `${fmt} is not a format a model can be shown` }
  }
  const edge = Math.max(probed.width, probed.height)
  if (edge > maxEdge) {
    return {
      kind: 'shrink',
      format: fmt,
      edge: maxEdge,
      why: `${probed.width}×${probed.height} is larger than needed — pixels past ${maxEdge} cost tokens and add no detail`,
    }
  }
  if (bytes > maxBytes) {
    // Small dimensions, big file: a PNG screenshot of a photo, or 16-bit depth.
    // Re-encoding at the SAME size is what fixes this, so the edge cap passed to
    // sips is the image's own longest edge, never maxEdge.
    return {
      kind: 'shrink',
      format: fmt,
      edge,
      why: `${Math.round(bytes / 1024)}KB is over the ${Math.round(maxBytes / 1024)}KB attach cap`,
    }
  }
  return { kind: 'attach', format: fmt }
}

/**
 * The sips argv for a plan.
 *
 * ⚠️ MEASURED, AND THE WHOLE REASON THIS IS A SEPARATE FUNCTION: `sips -Z 1600`
 *    and `sips --resampleHeightWidthMax 1600` **UPSCALE**. A 174×188 icon came
 *    back 1481×1600 and grew from 6,016 to 100,478 bytes — 16× the size, zero
 *    extra information, and every one of those bytes billed as vision tokens.
 *    The flag is "resample to this max dimension", not "cap at". So the caller
 *    must never hand sips an edge larger than the image already has, which is
 *    exactly why planSee returns the image's OWN edge for the byte-overflow case
 *    and only returns maxEdge when it has proven the image is bigger than it.
 */
export function sipsArgs(plan: SeePlan, src: string, out: string): string[] | null {
  if (plan.kind === 'convert') {
    return ['-s', 'format', plan.to, src, '--out', out]
  }
  if (plan.kind === 'shrink') {
    return ['-Z', String(plan.edge), src, '--out', out]
  }
  return null
}

/** Format actually declared on the attached block, after a plan ran. */
export function plannedFormat(plan: SeePlan): string {
  if (plan.kind === 'convert') return plan.to
  if (plan.kind === 'shrink') return SHOWABLE[plan.format] || plan.format
  if (plan.kind === 'attach') return SHOWABLE[plan.format] || plan.format
  return ''
}

/** A refusal in the words that name the fix, not the symptom. */
export function refusalMessage(path: string, reason: string): string {
  if (reason === 'not-an-image') {
    return `👀 ${path} is not an image I can show — the bytes are not png, jpeg, gif, webp, heic, tiff or bmp. If it is a PDF or a document, read it with the file editor instead.`
  }
  if (reason === 'no-pixels') {
    return `👀 ${path} decodes but has no bitmap to show (a PDF or a container with no image in it). read_image cannot help either — use the file editor.`
  }
  if (reason === 'unmeasured') {
    // The bytes ARE an image and the size could not be read — the two facts have
    // to appear together, or this reads as a corrupt-file problem when the usual
    // cause is a machine with no sips and a header this file cannot parse
    // (a truncated download, or a heic/tiff/bmp that needs converting anyway).
    return `👀 ${path} looks like an image but its dimensions could not be measured — no sips on this machine, and its header is not one I can read directly. Convert it to png or jpeg yourself, or read its text with read_image.`
  }
  return `👀 cannot show ${path}: ${reason}`
}

/**
 * The line that rides WITH the picture.
 *
 * A bare image is worse than it looks: the model cannot tell whether it is
 * seeing the whole file, and it cannot tell that the coordinates it might read
 * off the image no longer match the file on disk after a shrink. Both facts have
 * to be stated, because both are invisible in the pixels.
 *
 * It also names the cheaper tool. A model that learns it can attach any file
 * will attach a screenshot to ask what a button says — a question read_image
 * answers on-device for no tokens at all.
 */
export function seeNote(
  path: string,
  probed: Probed,
  plan: SeePlan,
  shownBytes: number,
): string {
  const size = `${probed.width}×${probed.height}`
  const kb = Math.max(1, Math.round(shownBytes / 1024))
  let head = `👀 ${path} — ${size}px, ${kb}KB`
  if (plan.kind === 'convert') {
    head += `\nConverted ${probed.format} → ${plan.to} to show it; the file on disk is unchanged.`
  } else if (plan.kind === 'shrink') {
    head += `\nResampled to fit (${plan.why}); the file on disk is unchanged. Positions you read off this picture are NOT the file's own pixel coordinates.`
  }
  return `${head}\nIf you only need the TEXT in this image, use_desktop read_image reads it on-device for free — this attachment costs vision tokens.`
}

/**
 * Read + prepare a file for attachment. The one impure function; `runner` and
 * `readFile` are seams so tests never spawn sips.
 *
 * Temp output goes beside the real temp dir with a unique-per-call name derived
 * from the source path and size, never from a clock — this file has no access to
 * one it can trust, and two concurrent calls on the same file want the same
 * scratch name anyway.
 */
export interface SeeIo {
  probe: (path: string) => Probed | null
  readHead: (path: string, n: number) => Uint8Array
  readAll: (path: string) => Buffer
  run: (bin: string, args: string[]) => void
  tmp: (src: string, ext: string) => string
  /** Whether the resampler exists. Only the convert/shrink branches need it, so
   *  a machine without sips can still be shown a small png — the size then comes
   *  from measureHeader rather than from `probe`, which IS sips. See hasSips. */
  canConvert: () => boolean
}

export interface Shown {
  base64: string
  format: string
  note: string
  bytes: number
}

export function prepareImage(
  path: string,
  io: SeeIo,
  opts?: { maxBytes?: number; maxEdge?: number },
): { ok: true; value: Shown } | { ok: false; message: string } {
  const full = expandTilde(path)
  if (!fs.existsSync(full)) return { ok: false, message: `👀 no such file: ${full}` }
  if (fs.statSync(full).isDirectory()) return { ok: false, message: `👀 ${full} is a directory, not an image` }

  // Content first, extension never. See sniffFormat.
  const sniffed = sniffFormat(io.readHead(full, SNIFF_BYTES))
  if (!sniffed) return { ok: false, message: refusalMessage(full, 'not-an-image') }

  const measured = io.probe(full)
  // sips stays the size authority WHERE IT ANSWERS: it decodes the file, so it
  // sees through a truncated header and reports the format it really is.
  //
  // When it doesn't answer, the header is measured here instead. That is not a
  // guess — it is the same class of fact, read from the bytes rather than from a
  // decoder, and it is what makes the promise in SeeIo.canConvert's docblock
  // true: on a machine with no sips at all, an already-showable png within the
  // caps is now shown, where before it was refused as "not an image" by a module
  // that had just sniffed it AS an image. Only heic/tiff/bmp still need the
  // binary, because those need CONVERTING and no amount of measuring helps.
  const fallback = measured ? null : measureHeader(io.readHead(full, MEASURE_BYTES), sniffed)
  let probed: Probed | null = measured
    ? { format: measured.format || sniffed, width: measured.width, height: measured.height }
    // The sniffed format, not a decoded one: without sips this is the only
    // format fact available, and it came from the magic bytes.
    : fallback
      ? { format: sniffed, width: fallback.width, height: fallback.height }
      : null
  const bytesOnDisk = fs.statSync(full).size
  // `sniffed` goes in so an UNMEASURED heic is told to convert rather than told
  // it couldn't be measured — true, but the wrong fix. See planSee.
  const plan = planSee(probed, bytesOnDisk, { ...opts, sniffed })
  if (plan.kind === 'refuse') return { ok: false, message: refusalMessage(full, plan.reason) }

  let source = full
  if (plan.kind === 'convert' || plan.kind === 'shrink') {
    if (!io.canConvert()) {
      // No resampler here. Refusing is right for BOTH branches and for opposite
      // reasons: an unshowable format cannot be attached at all, and an oversized
      // one attached as-is would be a request the provider rejects with an error
      // the model never sees. Naming the missing binary is what makes it fixable.
      return {
        ok: false,
        message: `👀 ${full} needs resampling before it can be shown (${plan.kind === 'convert' ? plan.why : plan.why}), and this machine has no sips. Convert it yourself, or read its text with read_image.`,
      }
    }
    const ext = plannedFormat(plan) === 'jpeg' ? 'jpg' : plannedFormat(plan)
    const out = io.tmp(full, ext)
    const args = sipsArgs(plan, full, out)
    if (!args) return { ok: false, message: `👀 cannot prepare ${full}` }
    try {
      io.run('sips', args)
    } catch (e: any) {
      // A conversion that fails is not a reason to attach the original: an
      // un-showable format would be declared as something it isn't.
      return { ok: false, message: `👀 could not convert ${full}: ${String(e?.message || e).slice(0, 200)}` }
    }
    source = out
    if (!probed) {
      // The unmeasured-heic branch: sips has now WRITTEN a jpeg, so the size is
      // measurable at last — from the output, which is the picture the model is
      // actually about to see. Measured or nothing; seeNote never invents a size.
      const after = io.probe(source) ?? (() => {
        const h = measureHeader(io.readHead(source, MEASURE_BYTES), plannedFormat(plan))
        return h ? { format: plannedFormat(plan), width: h.width, height: h.height } : null
      })()
      if (!after) return { ok: false, message: refusalMessage(full, 'unmeasured') }
      probed = { format: sniffed, width: after.width, height: after.height }
    }
  }

  const buf = io.readAll(source)
  const maxBytes = opts?.maxBytes ?? SEE_MAX_BYTES
  if (!buf.length) return { ok: false, message: `👀 ${full} prepared to an empty file — nothing to show` }
  if (buf.length > maxBytes) {
    // The shrink ran and it still doesn't fit. Refusing beats attaching
    // something the provider will reject with an error the model can't read.
    return {
      ok: false,
      message: `👀 ${full} is still ${Math.round(buf.length / 1024)}KB after resampling, over the ${Math.round(maxBytes / 1024)}KB cap. Crop the part you care about, or read its text with read_image.`,
    }
  }
  return {
    ok: true,
    value: {
      base64: buf.toString('base64'),
      format: plannedFormat(plan),
      note: seeNote(full, probed as Probed, plan, buf.length),
      bytes: buf.length,
    },
  }
}

/** Real IO. Separated so prepareImage's policy is testable with none of it. */
export const realSeeIo: SeeIo = {
  probe: (path) => {
    try {
      const out = execFileSync(
        'sips',
        ['-g', 'format', '-g', 'pixelWidth', '-g', 'pixelHeight', path],
        { encoding: 'utf-8', timeout: 20_000 },
      )
      const grab = (k: string) => new RegExp(`${k}:\\s*(\\S+)`).exec(out)?.[1] ?? ''
      const w = Number(grab('pixelWidth'))
      const h = Number(grab('pixelHeight'))
      const format = grab('format').toLowerCase()
      if (!Number.isFinite(w) || !Number.isFinite(h)) return null
      return { format, width: w, height: h }
    } catch {
      return null
    }
  },
  readHead: (path, n) => {
    const fd = fs.openSync(path, 'r')
    try {
      const buf = Buffer.alloc(n)
      const read = fs.readSync(fd, buf, 0, n, 0)
      return buf.subarray(0, read)
    } finally {
      fs.closeSync(fd)
    }
  },
  readAll: (path) => fs.readFileSync(path),
  run: (bin, args) => {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 60_000 })
  },
  tmp: (src, ext) => {
    // Derived from the path, not a clock: this module has no trustworthy clock,
    // and two calls about the same file may safely share scratch space.
    const key = Buffer.from(src).toString('base64url').slice(-40)
    return `${os.tmpdir()}/tiny-see-${key}.${ext}`
  },
  canConvert: () => hasSips(),
}

/**
 * Is CONVERTING a file possible here? sips ships with macOS; elsewhere, only
 * already-showable formats within the caps can be attached — so the tool is
 * offered anywhere, and only the CONVERT branch needs the binary.
 *
 * ⚠️ That last sentence was false for as long as sips was also the MEASURER:
 *    probe() is sips, a null probe refused, so "offered anywhere" meant a
 *    refusal everywhere. measureHeader is what makes it true. Do not reintroduce
 *    a sips call on the measuring path — the promise lives or dies on that.
 */
export function hasSips(): boolean {
  return fs.existsSync('/usr/bin/sips')
}

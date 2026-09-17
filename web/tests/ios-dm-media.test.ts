// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DM_ATTACHMENT_TYPES,
  DM_MAX_ATTACHMENTS,
  dmDuration,
} from '../lib/chat/dm-attachments'
import {
  DM_IMAGE_MAX_DIM,
  DM_UPLOAD_MAX_BYTES,
  DM_VOICE_MAX_MS,
  dmAttachmentRoom,
  dmSizeRefusal,
} from '../lib/chat/dm-media-upload'

/**
 * 📷🎥🎤 The iOS half of DM attachments, pinned from node.
 *
 * Two jobs, and the first one is the reason this file is in `tests/` and not in
 * `ios/Tests/`:
 *
 *  1. PARITY. Every number and every refusal sentence in `DmMedia.swift` has a
 *     twin in `lib/chat/dm-media-upload.ts`, and a divergence is invisible in
 *     either language alone: bump `DM_UPLOAD_MAX_BYTES` on the web and the phone
 *     goes on happily preparing a 2.6MB file for a 2.0MB route, producing a
 *     failed upload with no explanation. Only a test that can read BOTH files at
 *     once can see that, so it lives where the TypeScript is importable.
 *
 *  2. WIRING. The rules that keep a DM from being half-delivered are ORDERING
 *     properties — the blocking check before the POST, the recorder's clock read
 *     before `stop()`, the duration refusal before the transcode. Each is one
 *     expression in one place, and a Swift unit test can't reach most of them
 *     (they're inside SwiftUI views and an @MainActor ObservableObject).
 *
 * ⚠️ These are source assertions, so every anchor is asserted before it's used:
 * an unfound anchor makes `slice` return a stub on which every `.not.toMatch()`
 * passes forever. `body()` below does that.
 */

const ROOT = process.cwd()
const MEDIA = join(ROOT, 'ios/Tiny/Sources/DmMedia.swift')
const MESSAGES = join(ROOT, 'ios/Tiny/Sources/Messages.swift')

/** Comments stripped — this file's rules are spelled out in the Swift comments
 *  too, so an assertion could otherwise pass on the prose that describes it. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/\/?).*$/gm, '')

const media = () => code(readFileSync(MEDIA, 'utf8'))
const messages = () => code(readFileSync(MESSAGES, 'utf8'))

/** The `{ … }` block opening at or after `at`, brace-matched. */
function braced(source: string, at: number): string {
  const open = source.indexOf('{', at)
  let depth = 1
  let i = open + 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(open, i)
}

/** A block with its anchor ASSERTED. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

/** `let kFoo = 2_600_000` → 2600000. Asserted, for the same reason. */
function swiftNumber(source: string, name: string): number {
  const m = source.match(new RegExp(`let ${name}\\b[^=]*=\\s*([0-9_.]+)`))
  expect(m, `${name} is gone from DmMedia.swift — the parity pin can't read it`).toBeTruthy()
  return Number(m![1].replace(/_/g, ''))
}

describe('the numbers are the SAME numbers as the web composer’s', () => {
  it('the upload cap, the image dimension and the attachment count all match', () => {
    const src = media()
    // ⚠️ The cap is arithmetic, not taste: /api/media is an edge route (~4.5MB
    // body) and base64 inflates 4/3×. If the web number moves because that
    // ceiling moved, the phone's has to move with it or it prepares files the
    // route will reject.
    expect(swiftNumber(src, 'kDmUploadMaxBytes'), 'iOS and web disagree on the upload cap')
      .toBe(DM_UPLOAD_MAX_BYTES)
    expect(swiftNumber(src, 'kDmImageMaxDim'), 'iOS and web downscale photos differently')
      .toBe(DM_IMAGE_MAX_DIM)
    expect(swiftNumber(src, 'kDmMaxAttachments'), 'iOS offers a slot count the worker refuses')
      .toBe(DM_MAX_ATTACHMENTS)
    // Seconds on the phone (AVAudioRecorder counts in seconds), ms on the web.
    expect(swiftNumber(src, 'kDmVoiceMaxSeconds') * 1000, 'the voice-note ceilings drifted')
      .toBe(DM_VOICE_MAX_MS)
  })

  it('the allowlist is the store’s allowlist, entry for entry', () => {
    // A type on one side only is the worst kind of drift: the sender's client
    // says fine, `decideDmAttachments` says no, and the refusal arrives as a
    // bare HTTP 400 after the bytes are already in R2.
    const src = media()
    // A Swift dictionary LITERAL is bracketed, not braced, so `body()` (which
    // brace-matches) would silently return an empty region here — and an empty
    // region compares equal to nothing, which is exactly the vacuous pass this
    // file's header warns about. Slice to the literal's own closing bracket.
    const at = src.indexOf('let kDmAttachmentTypes')
    expect(at, 'kDmAttachmentTypes is gone — the allowlist pin would be vacuous').toBeGreaterThan(-1)
    const table = src.slice(at, src.indexOf('\n]', at))
    // `Array.from`, not a spread: this tsconfig's target predates iterator
    // spread and `[...matchAll()]` is a tsc error even though vitest runs it.
    const pairs = Array.from(table.matchAll(/"([^"]+)":\s*"([^"]+)"/g))
    expect(pairs.length, 'the allowlist literal parsed to nothing — re-anchor').toBeGreaterThan(0)
    const swift = Object.fromEntries(pairs.map(([, k, v]) => [k, v]))
    expect(swift, 'the iOS allowlist no longer mirrors DM_ATTACHMENT_TYPES').toEqual(DM_ATTACHMENT_TYPES)
  })

  it('the refusal sentences are word for word the web’s', () => {
    // Not vanity: these are the same product promise in two places, and a
    // rewritten one is how "nothing was sent" quietly stops being said on one
    // platform. Rendered from the TS and compared against the Swift template.
    const src = media()
    const size = body(src, 'func dmSizeRefusal(')
    // "is X, over the Y limit — nothing was sent."
    expect(size, 'the iOS size refusal stopped naming both numbers')
      .toContain('is \\(dmMB(bytes)), over the \\(dmMB(kDmUploadMaxBytes)) limit — nothing was sent.')
    const web = dmSizeRefusal(DM_UPLOAD_MAX_BYTES + 1, 'That file')!
    expect(web).toMatch(/^That file is [\d.]+MB, over the [\d.]+MB limit — nothing was sent\.$/)

    const room = body(src, 'func dmAttachmentRoom(')
    expect(room, 'the iOS batch refusal changed shape')
      .toContain('A message can carry \\(max) attachments — you have \\(staged) and picked \\(incoming). ')
    expect(dmAttachmentRoom(3, 2, DM_MAX_ATTACHMENTS))
      .toBe('A message can carry 4 attachments — you have 3 and picked 2. Send these first, then the rest.')
  })

  it('a duration renders the same on both ends', () => {
    // The bubble says "0:07" on the phone and in the browser, and BOTH must
    // render nothing at all for a missing duration — "0:00" reads like a broken
    // file, which is the one thing a voice note must never look like.
    expect(dmDuration(7_400)).toBe('0:07')
    expect(dmDuration(102_000)).toBe('1:42')
    expect(dmDuration(0)).toBe('')
    const fn = body(media(), 'func dmDuration(')
    expect(fn, 'iOS renders a missing duration as a length').toMatch(/return ""/)
    expect(fn, 'the iOS formatter dropped its zero padding').toContain('%02d')
  })
})

describe('🔴 kind is DERIVED, never read off the wire', () => {
  it('the decoder ignores the server’s `kind`', () => {
    // A mislabelled attachment ("kind":"image" on a video/mp4) would otherwise
    // reach an image view — and, on the read side, be handed to the model as a
    // picture. contentType is the only field that can say what a file IS, and
    // the worker derives it independently for the same reason.
    const init = body(media(), 'init?(json: [String: Any], slot: Int)')
    expect(init, 'the iOS decoder trusts the wire’s kind again')
      .not.toMatch(/json\["kind"\]/)
    expect(init, 'the iOS decoder stopped deriving the kind').toMatch(/dmAttachmentKind\(type\)/)
    // An unknown type must NOT vanish: a read path that silently drops what it
    // can't render tells the reader the message was empty.
    expect(init, 'an unrenderable attachment disappears from the thread again')
      .toMatch(/\?\?\s*"other"/)
    expect(body(media(), 'struct DmMediaBubble'), 'the "other" arm lost its fallback view')
      .toMatch(/default: other\(item\)/)
  })

  it('one unparseable attachment does not cost the reader the text beside it', () => {
    const fn = body(media(), 'func dmAttachments(from json: Any?)')
    expect(fn, 'a bad attachment row now aborts the whole message').toMatch(/compactMap/)
    // Slot-indexed so two identical photos in one message get distinct ids —
    // duplicate ids in a ForEach is a rendering bug, and the same photo twice is
    // a legitimate message.
    expect(fn, 'attachment ids stopped being unique within a message').toMatch(/enumerated\(\)/)
    expect(body(media(), 'var id: String'), 'the attachment id is no longer slot-qualified')
      .toContain('\\(slot):\\(url)')
  })
})

describe('🔴 a DM is never half-delivered', () => {
  it('the send bails on an in-flight or failed upload BEFORE the POST', () => {
    // A DM cannot be unsent. A send that leaves while an upload is in flight
    // arrives permanently missing the photo the sender watched themselves
    // attach — so the guard has to precede the network call, not follow it.
    const fn = body(messages(), 'private func sendDraft(to peer: DmThread)')
    const guardAt = fn.indexOf('composer.blockingReason(peer.login)')
    const sendAt = fn.indexOf('model.send(')
    expect(guardAt, 'sendDraft stopped checking whether the media is ready').toBeGreaterThan(-1)
    expect(sendAt, 'sendDraft no longer sends — re-anchor').toBeGreaterThan(-1)
    expect(guardAt, 'a DM can now leave while its photo is still uploading').toBeLessThan(sendAt)
    // A computed verdict that doesn't leave the function decides nothing.
    expect(fn.slice(guardAt, sendAt), 'the blocking reason is computed and then ignored')
      .toMatch(/return\b/)

    const why = body(media(), 'func blockingReason(')
    expect(why, 'an in-flight upload no longer blocks the send').toContain('.uploading')
    expect(why, 'a FAILED upload is silently dropped from the send again').toContain('.failed')
  })

  it('🔴 a caption-less photo is sendable', () => {
    // `decideDmPayload` allows an empty body when media is present, and a photo
    // with no caption is the commonest message a phone sends. Requiring text
    // here would make it unsendable from iOS only.
    const fn = body(messages(), 'private func sendDraft(to peer: DmThread)')
    expect(fn, 'iOS requires a caption on a photo again')
      .toMatch(/guard !text\.isEmpty \|\| !staged\.isEmpty/)
    // ...and the button has to agree with the guard, or the guard is unreachable.
    const view = messages()
    expect(view, 'the send button stayed text-only')
      .toMatch(/draft\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty && staged\.isEmpty/)
  })

  it('the send passes the READY attachments and clears the peer it SENT to', () => {
    const fn = body(messages(), 'private func sendDraft(to peer: DmThread)')
    // `ready()` is `compactMap(\.attachment)`: staged bytes never go in the JSON
    // body — they are megabytes, and the store already has them.
    expect(fn, 'the send stopped filtering for uploaded attachments')
      .toMatch(/composer\.ready\(peer\.login\)/)
    expect(fn, 'the send clears whoever is on screen instead of the recipient')
      .toMatch(/composer\.clear\(peer\.login\)/)
    const ready = body(media(), 'func ready(')
    expect(ready, 'ready() now returns un-uploaded items').toMatch(/compactMap\(\\\.attachment\)/)
  })

  it('a batch that does not fit is refused WHOLE, not trimmed', () => {
    const fn = body(media(), 'func addPicks(')
    const roomAt = fn.indexOf('dmAttachmentRoom(')
    expect(roomAt, 'addPicks stopped checking for room').toBeGreaterThan(-1)
    // The refusal must return, not just set a message and carry on staging the
    // first four — a photo that vanishes between the picker and the send is the
    // defect this whole rule exists to prevent.
    expect(fn.slice(roomAt, roomAt + 200), 'an over-cap batch is silently trimmed again')
      .toMatch(/return\b/)
    // And per-file refusals stay separate: each names a different file.
    expect(fn, 'per-file refusals were collapsed into one line')
      .toMatch(/refusals\.joined\(separator: "\\n"\)/)
  })

  it('staged media is keyed by peer, like the drafts it sits beside', () => {
    // The composer survives a peer switch, so one shared list would carry a
    // photo meant for A into a send to B — the same defect the web composer's
    // per-peer draft map exists to prevent.
    const src = media()
    expect(src, 'the staging area went back to one shared list')
      .toMatch(/var pending: \[String: \[StagedDmMedia\]\] = \[:\]/)
    // The login is a PARAMETER of every staging call, so it is captured before
    // the await rather than read from the open thread afterwards.
    for (const fn of ['func addPicks(', 'func addCamera(', 'func retry(', 'func startRecording(']) {
      expect(body(src, fn), `${fn} stopped taking the peer it is staging for`).toMatch(/login/)
    }
  })
})

describe('🎤 the recorder', () => {
  it('🔴 reads its length BEFORE stop()', () => {
    // `AVAudioRecorder.currentTime` is 0 on a stopped recorder. Reading it after
    // `stop()` gives every voice note ever sent a duration of "0:00" — and the
    // duration is the only thing the bubble can say without fetching the audio.
    const fn = body(media(), 'func stopRecording(discard: Bool)')
    const read = fn.indexOf('rec.currentTime')
    const stop = fn.indexOf('rec.stop()')
    expect(read, 'stopRecording stopped capturing the length').toBeGreaterThan(-1)
    expect(stop, 'stopRecording no longer stops the recorder — re-anchor').toBeGreaterThan(-1)
    expect(read, 'the length is read after stop() — every voice note is now 0:00')
      .toBeLessThan(stop)
    // And the captured value is what reaches the codec, which cannot re-read it.
    expect(fn, 'the captured length is no longer passed on').toMatch(/seconds: seconds/)
  })

  it('is capped by STOPPING, not by refusing afterwards', () => {
    // Nobody should talk for two minutes and only then be told it can't be sent.
    const start = body(media(), 'func startRecording(')
    expect(start, 'the voice-note cap no longer stops the recorder')
      .toMatch(/currentTime >= kDmVoiceMaxSeconds[\s\S]{0,200}stopRecording\(discard: false\)/)
    // The RECORDER's clock, not wall time since the tap: a cold mic takes a
    // moment, and counting that cuts the audio off short of the cap.
    expect(start, 'the ticker went back to wall-clock time').toMatch(/rec\.currentTime/)
  })

  it('🔴 is stopped when the thread is left, and hands the mic back', () => {
    // An AVAudioRecorder holds the mic and the session; walking out of the
    // thread mid-recording must not leave either running.
    const src = messages()
    expect((src.match(/composer\.stopRecording\(discard: true\)/g) ?? []).length,
           'leaving the thread can now leave the microphone open').toBeGreaterThanOrEqual(2)
    expect(src, 'the recorder is no longer stopped on disappear').toMatch(/onDisappear[\s\S]{0,200}stopRecording/)
    const stop = body(media(), 'func stopRecording(discard: Bool)')
    expect(stop, 'the audio session is never handed back').toMatch(/releaseSession\(\)/)
    // A discarded take must not become an attachment.
    expect(stop, 'a discarded recording is attached anyway')
      .toMatch(/guard !discard else \{[\s\S]{0,160}removeItem/)
  })

  it('records what the other clients can play', () => {
    // `audio/mp4` (AAC in m4a) is in the store's allowlist and plays in Chrome,
    // on Android and here. The web recorder re-encodes to WAV for the
    // mirror-image reason: iOS cannot play Chrome's audio/webm.
    const src = media()
    expect(src, 'the recorder switched to a format the store refuses').toMatch(/kAudioFormatMPEG4AAC/)
    expect(DM_ATTACHMENT_TYPES['audio/mp4'], 'audio/mp4 left the allowlist under iOS').toBe('audio')
    const note = body(src, 'static func prepareVoiceNote(')
    expect(note, 'the voice note no longer declares audio/mp4').toMatch(/contentType: "audio\/mp4"/)
    // 60s at 32kbps ≈ 240KB — the duration cap is what keeps it inside the byte
    // cap, so the bitrate is load-bearing, not a quality preference.
    expect(src, 'the recorder’s bitrate moved — recheck the duration/byte arithmetic')
      .toMatch(/AVEncoderBitRateKey: 32_000/)
    expect(src, 'the recorder’s sample rate moved').toMatch(/AVSampleRateKey: 16_000/)
  })

  it('🗣️ transcribes ON DEVICE, and a missing transcript is a real answer', () => {
    // A DM is between two people; shipping its audio to Apple's servers for a
    // nicer transcript is not a trade this app makes quietly.
    const src = media()
    expect(src, 'DM audio is now sent off-device to be transcribed')
      .toMatch(/requiresOnDeviceRecognition = true/)
    expect(body(src, 'static func transcribe('), 'the recogniser can hang the chip forever')
      .toMatch(/Task\.sleep\(for: \.seconds\(20\)\)/)
    // The audio sends either way: nil is reported as "no transcript available"
    // by dmAttachmentSummary, never as an empty utterance.
    expect(body(src, 'static func transcribe('), 'an empty transcript is now sent as text')
      .toMatch(/guard let heard, !heard\.isEmpty else \{ return nil \}/)
    // Resuming a continuation twice is a crash, and recognitionTask's handler
    // can fire with a result AND an error.
    expect(src, 'the recogniser continuation lost its resume-once guard').toMatch(/DmResumeOnce/)
  })
})

describe('🎥 clips are refused before the battery is spent, and measured after', () => {
  it('refuses on the SOURCE duration before transcoding', () => {
    const fn = body(media(), 'static func prepareClip(')
    const refuse = fn.indexOf('dmClipRefusal(')
    const exportAt = fn.indexOf('session.export(')
    expect(refuse, 'prepareClip stopped checking the duration').toBeGreaterThan(-1)
    expect(exportAt, 'prepareClip no longer exports — re-anchor').toBeGreaterThan(-1)
    expect(refuse, 'a 3-minute clip is now transcoded before being refused')
      .toBeLessThan(exportAt)
    expect(body(media(), 'func dmClipRefusal('), 'the clip refusal stopped naming the fix')
      .toMatch(/Trim it in Photos/)
  })

  it('steps the preset down instead of predicting a size', () => {
    // Presets are the only bitrate control AVAssetExportSession offers, so the
    // size is MEASURED and the ladder walked — never estimated.
    const fn = body(media(), 'static func prepareClip(')
    expect(fn, 'the preset ladder collapsed to a single export')
      .toMatch(/for preset in \[AVAssetExportPreset960x540, AVAssetExportPresetLowQuality\]/)
    expect(fn, 'the export result is no longer measured against the cap')
      .toMatch(/data\.count > kDmUploadMaxBytes/)
    // ⚠️ Both presets are H.264. The HEVC ones are named `…HEVC…`, and HEVC in
    // mp4 is what a Chrome recipient cannot play — the same class of mistake as
    // shipping Chrome's audio/webm to an iPhone.
    expect(fn, 'an HEVC preset was added — Chrome recipients cannot play it')
      .not.toMatch(/AVAssetExportPreset\w*HEVC/)
    // And when the smaller export still doesn't fit, the refusal says so in
    // bytes rather than blaming the file.
    expect(fn, 'the oversize refusal stopped naming the real size')
      .toMatch(/Even compressed, that clip is \\\(dmMB\(oversize\)\)/)
  })
})

describe('the photo path fits the cap it claims to', () => {
  it('🔴 downscales in PIXELS, not screen points', () => {
    // ⚠️ The reason this doesn't call AttachmentCodec.downscale: that renders
    // through UIGraphicsImageRenderer with the default format, whose `scale` is
    // the SCREEN's (3.0), so a "1568pt" render is 4704px and a 4032px photo
    // comes out BIGGER than it went in. On the chat rail that only inflates the
    // payload; here the byte cap decides whether the DM can be sent at all.
    const fn = body(media(), 'static func pixelPerfectDownscale(')
    expect(fn, 'the downscale went back to the screen’s scale factor')
      .toMatch(/format\.scale = 1/)
    expect(fn, 'the downscale stopped converting points to pixels')
      .toMatch(/image\.size\.width \* image\.scale/)
    expect(body(media(), 'static func prepareImage('), 'prepareImage delegates to the inflating downscaler')
      .not.toMatch(/AttachmentCodec\.downscale/)
  })

  it('checks the cap AFTER the shrink', () => {
    // A 12MP camera shot is over the cap as picked and comfortably under it once
    // re-encoded. Refusing on the original size would reject the single
    // commonest attachment there is.
    const fn = body(media(), 'static func prepareImage(')
    const shrink = fn.indexOf('pixelPerfectDownscale(')
    const check = fn.indexOf('dmSizeRefusal(')
    expect(shrink, 'prepareImage stopped downscaling').toBeGreaterThan(-1)
    expect(check, 'prepareImage stopped checking the cap').toBeGreaterThan(-1)
    expect(shrink, 'a 12MP photo is refused before it is shrunk').toBeLessThan(check)
    // HEIC — what an iPhone picker actually hands over — has no place in the
    // store's allowlist, so it must be CONVERTED, not refused.
    expect(DM_ATTACHMENT_TYPES['image/heic'], 'image/heic joined the allowlist — recheck the conversion')
      .toBeUndefined()
    expect(fn, 'the JPEG conversion left the photo path').toMatch(/contentType: "image\/jpeg"/)
    // width/height ride the wire so the recipient reserves the right box and the
    // thread doesn't reflow mid-scroll.
    expect(fn, 'the stored pixel size stopped being recorded').toMatch(/width: Int\(scaled\.size\.width/)
  })
})

describe('the upload is honest about failing', () => {
  it('does not auto-retry, and keeps the bytes for a manual one', () => {
    // An auto-retried multi-megabyte body on a bad connection is how you get
    // four copies in R2 and a composer that looks stuck.
    const fn = body(media(), 'private func upload(')
    expect(fn, 'the upload grew an automatic retry loop').not.toMatch(/for attempt in|while attempt/)
    expect(fn, 'a failed upload no longer records why').toMatch(/item\.status = \.failed/)
    expect(body(media(), 'struct StagedDmMedia'), 'a failed chip can no longer be retried')
      .toMatch(/let bytes: Data/)
    expect(body(media(), 'func retry('), 'Retry stopped re-uploading').toMatch(/await upload\(/)
  })

  it('🔴 a 200 that carried no url is a failure, not an upload', () => {
    // The empty-success trap this codebase keeps re-learning: a 200 whose body
    // is missing the field is an outage, and treating it as success stages a
    // ready chip with nothing behind it — then sends a DM with no photo.
    const fn = body(media(), 'private func upload(')
    expect(fn, 'a url-less 200 is treated as a successful upload')
      .toMatch(/guard let url = res\["url"\] as\? String, !url\.isEmpty else \{[\s\S]{0,200}throw/)
  })
})

describe('the file is actually in the build', () => {
  it('DmMedia.swift is compiled into the Tiny target', () => {
    // ⚠️ A Swift file that isn't in project.pbxproj compiles nowhere and fails
    // nothing — the app builds green and the composer's buttons don't exist. The
    // sources/build-files pair is what registers it.
    const pbx = readFileSync(join(ROOT, 'ios/Tiny.xcodeproj/project.pbxproj'), 'utf8')
    const refs = (pbx.match(/DmMedia\.swift/g) ?? []).length
    expect(refs, 'DmMedia.swift is not registered in the Xcode project').toBeGreaterThanOrEqual(4)
    expect(pbx, 'DmMedia.swift has no PBXBuildFile entry').toMatch(/\/\* DmMedia\.swift in Sources \*\//)
  })

  it('Messages.swift decodes and renders what the route now sends', () => {
    const src = messages()
    expect(src, 'the DM decoder dropped the attachments column')
      .toMatch(/attachments: dmAttachments\(from: \$0\["attachments"\]\)/)
    expect(src, 'the thread stopped rendering attachments').toMatch(/DmMediaBubble\(attachments: m\.attachments/)
    // A media-only message has no text, and `Text("")` in a bubble renders an
    // empty grey slab under the photo.
    expect(src, 'a caption-less message renders an empty text bubble')
      .toMatch(/if m\.hasText \{/)
    expect(src, 'the composer lost its attach controls').toMatch(/DmAttachControls\(composer: composer/)
    expect(src, 'the composer lost its staged strip').toMatch(/DmStagedStrip\(/)
    // The refusal text is shown verbatim — each one names the cause and the fix,
    // and a generic "couldn't attach that" throws the actionable half away.
    expect(src, 'the composer stopped showing the refusal').toMatch(/if let why = composer\.error/)
  })
})

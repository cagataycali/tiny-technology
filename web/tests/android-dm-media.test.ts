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
  DM_VOICE_SAMPLE_RATE,
  dmAttachmentRoom,
  dmSizeRefusal,
} from '../lib/chat/dm-media-upload'

/**
 * 📷🎥🎤 The Android half of DM attachments, pinned from node.
 *
 * Twin of tests/ios-dm-media.test.ts, and here for the same two reasons:
 *
 *  1. PARITY. Every number and every refusal sentence in `DmMedia.kt` has a twin
 *     in `lib/chat/dm-media-upload.ts` and in `DmMedia.swift`. A divergence is
 *     invisible in any one language: bump the upload cap on the web and the phone
 *     goes on preparing a 2.6MB file for a 2.0MB route, producing a failed upload
 *     with no explanation. Only a test that can read the TypeScript AND the Kotlin
 *     can see that.
 *
 *  2. WIRING. The rules that keep a DM from being half-delivered are ORDERING
 *     properties — the blocking check before the POST, the duration refusal before
 *     the transcode, the writer thread joined before the file is read. Each is one
 *     expression in one place. `DmMediaTest.kt` covers the pure rules on the JVM
 *     (38 assertions); these cover the parts a JVM test can't reach, because they
 *     live inside Compose or need a microphone.
 *
 * ⚠️ Source assertions, so every anchor is asserted before use: an unfound anchor
 * makes `slice` return a stub on which every `.not.toMatch()` passes forever.
 * `body()` does that.
 */

const ROOT = process.cwd()
const KT = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/DmMedia.kt')
const UI = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/DmMediaUi.kt')
const MESSAGES = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/Messages.kt')

/**
 * Comments stripped — the Kotlin spells these rules out in prose too, so an
 * unscoped search finds the docstring that EXPLAINS a defect and reports it as
 * the defect. (Measured in dm-length-parity.test.ts, which had to strip Swift
 * comments for exactly this.) The `[^:]` guard keeps `https://` intact.
 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const kt = () => code(readFileSync(KT, 'utf8'))
const ui = () => code(readFileSync(UI, 'utf8'))
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

/**
 * A window from an ASSERTED anchor, for the declarations `braced()` cannot see:
 * Kotlin's `=` expression bodies (`fun dmMB(…): String = …`) have no block at all,
 * so brace-matching from the signature silently returns the NEXT declaration's body
 * — which is how a pin ends up asserting something true about the wrong function.
 */
function decl(source: string, signature: string, chars = 400): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return source.slice(at, at + chars)
}

/** `const val DM_FOO = 2_600_000L` → 2600000. Asserted, for the same reason. */
function ktNumber(source: string, name: string): number {
  const m = source.match(new RegExp(`val ${name}\\b[^=]*=\\s*([0-9_]+)L?`))
  expect(m, `${name} is gone from DmMedia.kt — the parity pin can't read it`).toBeTruthy()
  return Number(m![1].replace(/_/g, ''))
}

/** The web copy of a number that isn't exported — read from its source, not imported. */
function tsNumber(file: string, name: string): number {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const m = src.match(new RegExp(`const ${name}\\b[^=]*=\\s*([0-9_.]+)`))
  expect(m, `${name} is gone from ${file} — the parity pin can't read it`).toBeTruthy()
  return Number(m![1].replace(/_/g, ''))
}

describe('the numbers are the SAME numbers as the web composer’s', () => {
  it('the upload cap, the image rules and the attachment count all match', () => {
    const src = kt()
    // ⚠️ The cap is arithmetic, not taste: /api/media is an edge route (~4.5MB
    // body) and base64 inflates 4/3×. If the web number moves because that
    // ceiling moved, the phone's has to move with it or it prepares files the
    // route will reject.
    expect(ktNumber(src, 'DM_UPLOAD_MAX_BYTES'), 'Android and web disagree on the upload cap')
      .toBe(DM_UPLOAD_MAX_BYTES)
    expect(ktNumber(src, 'DM_IMAGE_MAX_DIM'), 'Android and web downscale photos differently')
      .toBe(DM_IMAGE_MAX_DIM)
    expect(ktNumber(src, 'DM_MAX_ATTACHMENTS'), 'Android offers a slot count the worker refuses')
      .toBe(DM_MAX_ATTACHMENTS)
    // 0–100 here because Bitmap.compress takes an int; 0–1 on the web.
    expect(ktNumber(src, 'DM_IMAGE_QUALITY') / 100, 'the JPEG quality drifted')
      .toBeCloseTo(tsNumber('lib/chat/dm-media-upload.ts', 'DM_IMAGE_QUALITY'), 5)
    expect(ktNumber(src, 'DM_VOICE_MAX_MS'), 'the voice-note ceilings drifted').toBe(DM_VOICE_MAX_MS)
    expect(ktNumber(src, 'DM_VOICE_SAMPLE_RATE'), 'the recorders disagree on sample rate')
      .toBe(DM_VOICE_SAMPLE_RATE)
  })

  it('the allowlist is the store’s allowlist, entry for entry', () => {
    // A type on one side only is the worst kind of drift: the sender's client says
    // fine, `decideDmAttachments` says no, and the refusal arrives as a bare HTTP
    // 400 after the bytes are already in R2.
    const src = kt()
    const at = src.indexOf('val DM_ATTACHMENT_TYPES')
    expect(at, 'DM_ATTACHMENT_TYPES is gone — the allowlist pin would be vacuous').toBeGreaterThan(-1)
    const table = src.slice(at, src.indexOf('\n)', at))
    // `Array.from`, not a spread: this tsconfig's target predates iterator spread
    // and `[...matchAll()]` is a tsc error even though vitest runs it.
    const pairs = Array.from(table.matchAll(/"([^"]+)"\s+to\s+"([^"]+)"/g))
    expect(pairs.length, 'the allowlist literal parsed to nothing — re-anchor').toBeGreaterThan(0)
    const android = Object.fromEntries(pairs.map(([, k, v]) => [k, v]))
    expect(android, 'the Android allowlist no longer mirrors DM_ATTACHMENT_TYPES')
      .toEqual(DM_ATTACHMENT_TYPES)
  })

  it('the refusal sentences are word for word the web’s', () => {
    // Not vanity: the same product promise in three places, and a rewritten one is
    // how "nothing was sent" quietly stops being said on one platform.
    const src = kt()
    const size = body(src, 'fun dmSizeRefusal(')
    expect(size, 'the Android size refusal stopped naming both numbers')
      .toContain('is ${dmMB(bytes)}, over the ${dmMB(DM_UPLOAD_MAX_BYTES)} limit — nothing was sent.')
    const web = dmSizeRefusal(DM_UPLOAD_MAX_BYTES + 1, 'That file')!
    expect(web).toMatch(/^That file is [\d.]+MB, over the [\d.]+MB limit — nothing was sent\.$/)

    const room = body(src, 'fun dmAttachmentRoom(')
    expect(room, 'the Android batch refusal changed shape')
      .toContain('A message can carry $max attachments — you have $staged and picked $incoming. ')
    expect(dmAttachmentRoom(3, 2, DM_MAX_ATTACHMENTS))
      .toBe('A message can carry 4 attachments — you have 3 and picked 2. Send these first, then the rest.')
  })

  it('🔴 sizes are formatted with a dot on every locale', () => {
    // A phone set to de-DE renders 2.5 as "2,5" — in the same sentence as a server
    // limit reported as 2.5MB. `Locale.US` is what stops the refusal contradicting
    // itself. (Also asserted at runtime in DmMediaTest.kt.)
    expect(decl(kt(), 'fun dmMB(', 200), 'dmMB went back to the default locale')
      .toContain('Locale.US')
  })

  it('a duration renders the same on both ends', () => {
    // The bubble says "0:07" on both phones and in the browser, and ALL of them
    // must render nothing at all for a missing duration — "0:00" reads like a
    // broken file, which is the one thing a voice note must never look like.
    expect(dmDuration(7_400)).toBe('0:07')
    expect(dmDuration(102_000)).toBe('1:42')
    expect(dmDuration(0)).toBe('')
    const fn = body(kt(), 'fun dmDuration(')
    expect(fn, 'Android renders a missing duration as a length').toMatch(/return ""/)
    expect(fn, 'the Android formatter dropped its zero padding').toContain('%02d')
  })
})

describe('🔴 kind is DERIVED, never read off the wire', () => {
  it('the decoder ignores the server’s `kind`', () => {
    // A mislabelled attachment ("kind":"image" on a video/mp4) would otherwise
    // reach an image view — and, on the read side, be handed to the model as a
    // picture. contentType is the only field that can say what a file IS, and the
    // worker derives it independently for the same reason.
    const fn = body(kt(), 'fun dmAttachment(json: JSONObject, slot: Int)')
    expect(fn, 'the Android decoder trusts the wire’s kind again')
      .not.toMatch(/optString\("kind"\)/)
    expect(fn, 'the Android decoder stopped deriving the kind').toMatch(/dmAttachmentKind\(type\)/)
    // An unknown type must NOT vanish: a read path that silently drops what it
    // can't render tells the reader the message was empty.
    expect(fn, 'an unrenderable attachment disappears from the thread again')
      .toMatch(/\?:\s*"other"/)
    expect(body(ui(), 'private fun DmAttachmentView('), 'the "other" arm lost its fallback view')
      .toMatch(/else ->/)
  })

  it('one unparseable attachment does not cost the reader the text beside it', () => {
    const fn = decl(kt(), 'fun dmAttachments(arr: JSONArray?)', 260)
    expect(fn, 'a bad attachment row now aborts the whole message').toMatch(/mapNotNull/)
    // Slot-indexed so two identical photos in one message get distinct ids —
    // duplicate keys in a LazyColumn is a rendering bug, and the same photo twice
    // is a legitimate message.
    expect(kt(), 'attachment ids stopped being slot-qualified').toContain('"$slot:$url"')
  })
})

describe('🔴 a DM is never half-delivered', () => {
  it('the send bails on an in-flight or failed upload BEFORE the POST', () => {
    // A DM cannot be unsent. A send that leaves while an upload is in flight
    // arrives permanently missing the photo the sender watched themselves attach —
    // so the guard has to precede the network call, not follow it.
    const fn = body(messages(), 'fun send() {')
    const guardAt = fn.indexOf('composer.blockingReason()')
    const postAt = fn.indexOf('app.api.postJson("/api/messages"')
    expect(guardAt, 'send() stopped checking whether the media is ready').toBeGreaterThan(-1)
    expect(postAt, 'send() no longer posts — re-anchor').toBeGreaterThan(-1)
    expect(guardAt, 'a DM can now leave while its photo is still uploading').toBeLessThan(postAt)
    // A computed verdict that doesn't leave the function decides nothing.
    expect(fn.slice(guardAt, postAt), 'the blocking reason is computed and then ignored')
      .toMatch(/sendError = it; return/)

    const why = body(kt(), 'fun dmBlockingReason(')
    expect(why, 'an in-flight upload no longer blocks the send').toContain('DmUploadState.UPLOADING')
    expect(why, 'a FAILED upload is silently dropped from the send again').toContain('DmUploadState.FAILED')
  })

  it('🔴 a caption-less photo is sendable, and the button agrees', () => {
    // `decideDmPayload` allows an empty body when media is present, and a photo
    // with no caption is the commonest message a phone sends. Requiring text here
    // would make it unsendable from Android only.
    const fn = body(messages(), 'fun send() {')
    expect(fn, 'Android requires a caption on a photo again')
      .toMatch(/body\.isEmpty\(\) && composer\.staged\.isEmpty\(\)/)
    // ...and the button has to agree with the guard, or one of them is unreachable:
    // an enabled button whose only outcome is a refusal, or a guard nothing reaches.
    const src = messages()
    expect(src, 'the send button stayed text-only')
      .toMatch(/draft\.isNotBlank\(\) \|\| composer\.staged\.isNotEmpty\(\)/)
    expect(src, 'the button now invites a tap that can only refuse')
      .toMatch(/composer\.blockingReason\(\) == null/)
  })

  it('the send passes the READY attachments and clears them on success only', () => {
    const fn = body(messages(), 'fun send() {')
    // `ready()` is `mapNotNull { it.attachment }`: staged bytes never go in the
    // JSON body — they are megabytes, and the store already has them.
    expect(fn, 'the send stopped filtering for uploaded attachments').toMatch(/composer\.ready\(\)/)
    expect(fn, 'the send stopped using the shared body builder')
      .toMatch(/dmSendBody\(login, body, attachments\)/)
    const ready = decl(kt(), 'fun ready(', 120)
    expect(ready, 'ready() now returns un-uploaded items').toMatch(/mapNotNull \{ it\.attachment \}/)
    // The clear must sit in the success branch beside the draft's, or a failed
    // send loses the attachments it refused to send.
    const okAt = fn.indexOf('res.optInt("_status", 200) < 400')
    expect(okAt, 'the success branch is gone — re-anchor').toBeGreaterThan(-1)
    const ok = braced(fn, okAt)
    expect(ok, 'the attachments are no longer cleared on a successful send')
      .toContain('composer.clear()')
    expect(fn.slice(0, okAt), 'a refused send now wipes the attachments it refused')
      .not.toContain('composer.clear()')
  })

  it('a batch that does not fit is refused WHOLE, not trimmed', () => {
    // A photo that vanishes between the picker and the send is one the sender
    // believes they sent — the defect this whole rule exists to prevent.
    const src = ui()
    const at = src.indexOf('composer.roomRefusal(uris.size)')
    expect(at, 'the picker stopped checking for room').toBeGreaterThan(-1)
    expect(src.slice(at, at + 220), 'an over-cap batch is silently trimmed again')
      .toMatch(/composer\.error = it; return@rememberLauncherForActivityResult/)
    // And the staging loop must come AFTER the check, not race it.
    expect(src.indexOf('dmStagePick(app, context, composer, it)'), 'the pick is staged before the room check')
      .toBeGreaterThan(at)
  })

  it('staged media is keyed by peer, like the draft it sits beside', () => {
    // State restores by slot position, so an unkeyed composer would carry a photo
    // picked for A into a send to B — the same reason `draft` is keyed.
    const src = messages()
    expect(src, 'the composer is no longer per-peer')
      .toMatch(/val composer = remember\(login\) \{ DmComposerState\(\) \}/)
    // ⚠️ NOT rememberSaveable: a Bundle cannot hold two megabytes of JPEG, and the
    // failure mode is a TransactionTooLarge crash on rotation.
    expect(src, 'the composer went into saveable state — a Bundle can’t hold a JPEG')
      .not.toMatch(/rememberSaveable\(login\) \{ DmComposerState/)
  })
})

describe('🎤 the recorder', () => {
  it('🔴 records raw PCM, because the recogniser cannot read a container', () => {
    // MediaRecorder only ever writes containers, and `EXTRA_AUDIO_SOURCE` wants
    // headerless PCM — so the WAV the recipient gets and the samples the
    // recogniser reads are literally the same bytes. A transcript can therefore
    // never describe different audio than the one attached.
    const src = kt()
    expect(src, 'the recorder switched to MediaRecorder — the transcript path breaks')
      .not.toMatch(/MediaRecorder\(\)/)
    expect(src, 'the recorder is no longer AudioRecord').toMatch(/AudioRecord\(/)
    // VOICE_RECOGNITION: the source with speech-tuned AGC/NS and no post-processing
    // that fights a recogniser.
    expect(src, 'the audio source moved off VOICE_RECOGNITION')
      .toMatch(/MediaRecorder\.AudioSource\.VOICE_RECOGNITION/)
    expect(src, 'the recorder stopped capturing 16-bit mono').toMatch(/ENCODING_PCM_16BIT/)
    expect(src, 'the recorder stopped capturing mono').toMatch(/CHANNEL_IN_MONO/)
  })

  it('🔴 the writer thread is JOINED before the file is read', () => {
    // The writer holds the buffered output stream. Reading the file while it is
    // still flushing is how a voice note loses its last half-second — silently,
    // and only sometimes.
    const fn = body(kt(), 'fun stop(): File?')
    const join = fn.indexOf('thread?.join(')
    const ret = fn.indexOf('return out')
    expect(join, 'the writer thread is no longer joined').toBeGreaterThan(-1)
    expect(ret, 'stop() no longer returns the file — re-anchor').toBeGreaterThan(-1)
    expect(join, 'the PCM file is read while it is still being written').toBeLessThan(ret)
    expect(fn, 'the mic is no longer released').toMatch(/record\?\.release\(\)/)
  })

  it('is capped by STOPPING, not by refusing afterwards — twice over', () => {
    // Nobody should talk for two minutes and only then be told it can't be sent.
    expect(body(ui(), 'LaunchedEffect(composer.recording)'), 'the UI cap no longer stops the recorder')
      .toMatch(/composer\.recordMs >= DM_VOICE_MAX_MS[\s\S]{0,300}finishRecording\(discard = false\)/)
    // ⚠️ And again inside the reader thread: a thread that outlived its ticker must
    // not be able to produce a file whose only possible outcome is a refusal.
    const start = body(kt(), 'fun start(id: Long): String?')
    expect(start, 'the reader thread lost its own byte cap')
      .toMatch(/val room = \(cap - written\)/)
    // The RECORDER's own byte clock, not wall time since the tap: a cold mic takes
    // a moment, and counting that cuts the audio off short of the cap.
    expect(kt(), 'the elapsed clock went back to wall time')
      .toMatch(/val elapsedMs: Long get\(\) = dmPcmMs\(written\)/)
  })

  it('🔴 is stopped when the thread is left, and hands the mic back', () => {
    // `remember(login)` hands out a FRESH composer on a peer jump, so without this
    // the old one's AudioRecord keeps the hardware — a recording nobody can see,
    // still holding the mic.
    const src = messages()
    expect(src, 'leaving the thread can now leave the microphone open')
      .toMatch(/DisposableEffect\(composer\)[\s\S]{0,200}stopRecording\(discard = true\)/)
    // A discarded take must not become an attachment.
    const stop = body(kt(), 'fun stopRecording(discard: Boolean)')
    expect(stop, 'a discarded recording is attached anyway')
      .toMatch(/if \(discard\) \{[\s\S]{0,120}rec\.discard\(\)[\s\S]{0,60}return null/)
  })

  it('records what the other clients can play', () => {
    // WAV is in the store's allowlist, plays in Chrome, on iOS and here — and it
    // is byte-for-byte the shape the web recorder produces. It is also the only
    // container reachable from raw PCM without a second encoder.
    expect(DM_ATTACHMENT_TYPES['audio/wav'], 'audio/wav left the allowlist under Android').toBe('audio')
    const note = body(kt(), 'suspend fun dmPrepareVoiceNote(')
    expect(note, 'the voice note no longer declares audio/wav').toMatch(/contentType = "audio\/wav"/)
    expect(note, 'the WAV header is no longer prepended').toMatch(/dmWavHeader\(samples\.size\)/)
    // 🔴 The duration cap is what keeps a full note inside the byte cap, so the
    // sample rate is load-bearing, not a quality preference. (The arithmetic itself
    // is asserted in DmMediaTest.kt: 44 + dmVoicePcmCap() <= DM_UPLOAD_MAX_BYTES.)
    expect(44 + (DM_VOICE_MAX_MS * DM_VOICE_SAMPLE_RATE * 2) / 1000,
           'a full-length voice note no longer fits the upload cap')
      .toBeLessThanOrEqual(DM_UPLOAD_MAX_BYTES)
    // The FILE's length decides the duration, not the ticker: the tick is a UI
    // clock and the samples are the message.
    expect(note, 'the duration went back to the UI clock').toMatch(/dmPcmMs\(samples\.size\.toLong\(\)\)/)
  })

  it('🗣️ transcribes ON DEVICE, and a missing transcript is a real answer', () => {
    // A DM is between two people; shipping its audio to Google's servers for a
    // nicer transcript is not a trade this app makes quietly.
    const src = kt()
    const fn = body(src, 'private suspend fun dmTranscribePcm(')
    expect(fn, 'DM audio is now sent off-device to be transcribed')
      .toMatch(/createOnDeviceSpeechRecognizer/)
    expect(fn, 'the recogniser can hang the chip forever').toMatch(/withTimeoutOrNull\(20_000L\)/)
    // ⚠️ EXTRA_AUDIO_SOURCE — the only way to transcribe a FILE — is API 33. Below
    // that the note is honestly transcript-less: `dmAttachmentSummary` reports "no
    // transcript available", and the audio sends either way.
    expect(fn, 'the API-33 gate is gone — startListening would open the MIC instead')
      .toMatch(/Build\.VERSION\.SDK_INT < 33/)
    expect(fn, 'the recorded samples are no longer handed to the recogniser')
      .toMatch(/RecognizerIntent\.EXTRA_AUDIO_SOURCE/)
    // Resuming a continuation twice is a crash, and onResults + onError can BOTH
    // fire.
    expect(fn, 'the recogniser continuation lost its resume-once guard')
      .toMatch(/if \(done\) return/)
    // An empty utterance is not a transcript.
    expect(fn, 'an empty transcript is now sent as text').toMatch(/takeIf \{ it\.isNotEmpty\(\) \}/)
    // And it is clipped on a code-point boundary, not with String.take.
    expect(fn, 'the transcript clip stopped being code-point safe').toMatch(/dmClipTranscript/)
  })
})

describe('🎥 clips are refused before the battery is spent, and measured after', () => {
  it('refuses on the SOURCE duration before transcoding', () => {
    const fn = body(kt(), 'internal suspend fun dmPrepareClip(')
    const refuse = fn.indexOf('dmClipRefusal(')
    const transform = fn.indexOf('dmTransform(')
    expect(refuse, 'dmPrepareClip stopped checking the duration').toBeGreaterThan(-1)
    expect(transform, 'dmPrepareClip no longer transcodes — re-anchor').toBeGreaterThan(-1)
    expect(refuse, 'a 3-minute clip is now transcoded before being refused').toBeLessThan(transform)
    expect(body(kt(), 'fun dmClipRefusal('), 'the clip refusal stopped naming the fix')
      .toMatch(/Trim it/)
    // An unreadable file gets its own sentence rather than "That clip is NaNs".
    expect(fn, 'an unreadable clip now falls through to the duration refusal')
      .toMatch(/That clip couldn't be read/)
  })

  it('🔴 COMPUTES the bitrate, then MEASURES the result', () => {
    // The piece iOS can't do: AVAssetExportSession only takes presets, so it walks
    // a ladder. Transformer takes a real bitrate, so the size is arithmetic — but
    // an encoder is free to overshoot what it was asked for, so the number that
    // decides whether this DM can be sent is read off the finished file.
    const fn = body(kt(), 'internal suspend fun dmPrepareClip(')
    expect(fn, 'the requested bitrate is no longer computed from the budget')
      .toMatch(/dmClipVideoBitrate\(durationMs, tighten = tighten\)/)
    expect(fn, 'the transcoded size is no longer measured against the cap')
      .toMatch(/bytes\.size > DM_UPLOAD_MAX_BYTES/)
    // Two passes, then an honest refusal in real bytes rather than blaming the file.
    expect(fn, 'the second, stricter pass is gone').toMatch(/listOf\(540 to 1\.0, 360 to 0\.6\)/)
    expect(fn, 'the oversize refusal stopped naming the real size')
      .toMatch(/Even compressed, that clip is \$\{dmMB\(it\)\}/)
  })

  it('encodes what a Chrome recipient can play', () => {
    // HEVC-in-mp4 is what a browser cannot play, and the recipient's browser is not
    // ours to pick — the same class of mistake as shipping Chrome's audio/webm to
    // an iPhone.
    const fn = body(kt(), 'private suspend fun dmTransform(')
    expect(fn, 'the clip encoder left H.264').toMatch(/MimeTypes\.VIDEO_H264/)
    expect(fn, 'the clip audio left AAC').toMatch(/MimeTypes\.AUDIO_AAC/)
    expect(fn, 'an HEVC mime type was added — Chrome recipients cannot play it')
      .not.toMatch(/VIDEO_H265|VIDEO_HEVC/)
    expect(DM_ATTACHMENT_TYPES['video/mp4'], 'video/mp4 left the allowlist').toBe('video')
    // A stuck encoder must not leave the composer spinning with no way out.
    expect(fn, 'the transcode lost its timeout').toMatch(/withTimeoutOrNull\(180_000L\)/)
    // ⚠️ Transformer posts its callbacks to the Looper of the thread that BUILT it;
    // built on an IO dispatcher thread it throws at construction.
    expect(decl(kt(), 'private suspend fun dmTransform(', 320),
           'the transformer moved off the main thread — it has no Looper there')
      .toMatch(/withContext\(Dispatchers\.Main\)/)
  })
})

describe('the photo path fits the cap it claims to', () => {
  it('samples the decode before it scales', () => {
    // Decoding a 50MP shot at full resolution allocates ~200MB of ARGB_8888 just
    // to shrink it — the reason Attachments.encode does the same thing.
    const fn = body(kt(), 'private fun encodeDmImage(')
    expect(fn, 'the decode stopped being sampled').toMatch(/inSampleSize = sample/)
    expect(fn, 'the bounds pass is gone').toMatch(/inJustDecodeBounds = true/)
    // BitmapFactory ignores EXIF, so a portrait phone photo would arrive in the
    // recipient's thread lying on its side.
    expect(fn, 'EXIF orientation is no longer baked in').toMatch(/dmOrientationMatrix\(orientation\)/)
  })

  it('checks the cap AFTER the shrink', () => {
    // A 12MP camera shot is over the cap as picked and comfortably under it once
    // re-encoded. Refusing on the original size would reject the single commonest
    // attachment there is.
    const fn = body(kt(), 'internal suspend fun dmPrepareImage(')
    const shrink = fn.indexOf('encodeDmImage(')
    const check = fn.indexOf('dmSizeRefusal(')
    expect(shrink, 'dmPrepareImage stopped downscaling').toBeGreaterThan(-1)
    expect(check, 'dmPrepareImage stopped checking the cap').toBeGreaterThan(-1)
    expect(shrink, 'a 12MP photo is refused before it is shrunk').toBeLessThan(check)
    // HEIC/AVIF — what a modern Android picker actually hands over — have no place
    // in the store's allowlist, so they must be CONVERTED, not refused.
    expect(DM_ATTACHMENT_TYPES['image/heic'], 'image/heic joined the allowlist — recheck the conversion')
      .toBeUndefined()
    expect(fn, 'the JPEG conversion left the photo path').toMatch(/contentType = "image\/jpeg"/)
    // width/height ride the wire so the recipient reserves the right box and the
    // thread doesn't reflow mid-scroll.
    expect(fn, 'the stored pixel size stopped being recorded').toMatch(/width = encoded\.width/)
    // And the refusal names the file, since a pick can be several at once.
    expect(fn, 'the per-file refusal stopped naming the file').toMatch(/“\$name”/)
  })
})

describe('the upload is honest about failing', () => {
  it('does not auto-retry, and keeps the bytes for a manual one', () => {
    // An auto-retried multi-megabyte body on a bad connection is how you get four
    // copies in R2 and a composer that looks stuck.
    const fn = body(kt(), 'internal suspend fun dmUploadMedia(')
    expect(fn, 'the upload grew an automatic retry loop').not.toMatch(/for \(attempt|while \(attempt/)
    expect(decl(kt(), 'internal data class StagedDmMedia(', 700), 'a failed chip can no longer be retried')
      .toMatch(/val bytes: ByteArray/)
    const staged = body(ui(), 'private suspend fun dmUploadStaged(')
    expect(staged, 'a failed upload no longer records why').toMatch(/DmUploadState\.FAILED/)
    expect(ui(), 'Retry stopped re-uploading').toMatch(/scope\.launch \{ dmUploadStaged\(app, composer, m\) \}/)
  })

  it('🔴 a 200 that carried no url is a failure, not an upload', () => {
    // The empty-success trap this codebase keeps re-learning: a 200 whose body is
    // missing the field is an outage, and treating it as success stages a ready
    // chip with nothing behind it — then sends a DM with no photo.
    const fn = body(kt(), 'internal suspend fun dmUploadMedia(')
    expect(fn, 'a url-less 200 is treated as a successful upload')
      .toMatch(/res\.optString\("url"\)\.takeIf \{ it\.isNotEmpty\(\) \}[\s\S]{0,200}throw/)
  })
})

describe('the pieces the runtime needs are actually declared', () => {
  it('🔴 RECORD_AUDIO and the FileProvider are in the manifest', () => {
    // ⚠️ The Android analogue of a Swift file missing from project.pbxproj: both of
    // these fail at RUNTIME, silently-ish, in a build that compiles perfectly. A
    // missing RECORD_AUDIO makes AudioRecord return an uninitialised recorder, and
    // a missing/renamed FileProvider authority throws when the camera is handed a
    // uri it cannot write.
    const manifest = readFileSync(join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8')
    expect(manifest, 'RECORD_AUDIO is gone — voice notes cannot record')
      .toMatch(/android\.permission\.RECORD_AUDIO/)
    expect(manifest, 'the FileProvider authority moved — the camera path breaks')
      .toMatch(/\$\{applicationId\}\.files/)
    expect(ui(), 'the camera target stopped using that authority')
      .toMatch(/\$\{BuildConfig\.APPLICATION_ID\}\.files/)
    // The camera writes into cache/camera, which file_paths.xml has to expose.
    const paths = readFileSync(join(ROOT, 'android/app/src/main/res/xml/file_paths.xml'), 'utf8')
    expect(paths, 'the camera cache path left file_paths.xml').toMatch(/camera/)
  })

  it('🔴 Media3 Transformer is on the compile classpath', () => {
    // Android has no public transcoder (`MediaTranscodingManager` never shipped),
    // so without this a camera clip could only ever be refused.
    const gradle = readFileSync(join(ROOT, 'android/app/build.gradle.kts'), 'utf8')
    for (const artifact of ['media3-transformer', 'media3-effect', 'media3-common']) {
      expect(gradle, `${artifact} left the build — the clip path cannot compile`).toContain(artifact)
    }
  })

  it('Messages.kt decodes and renders what the route now sends', () => {
    const src = messages()
    expect(src, 'the DM decoder dropped the attachments column')
      .toMatch(/attachments = dmAttachments\(m\.optJSONArray\("attachments"\)\)/)
    expect(src, 'the thread stopped rendering attachments')
      .toMatch(/DmAttachmentColumn\(m\.attachments\)/)
    // Above the words: with no caption the attachment IS the message, and with one
    // the words read as a caption only when they follow what they caption.
    const bubble = messages()
    expect(bubble.indexOf('DmAttachmentColumn(m.attachments)'), 'attachments moved below the caption')
      .toBeLessThan(bubble.indexOf('Text(m.body, style = MaterialTheme.typography.bodyLarge.bidi())'))
    // A media-only message has no text, and Text("") renders an empty padded line.
    expect(src, 'a caption-less message renders an empty text line')
      .toMatch(/if \(m\.body\.isNotEmpty\(\)\) \{/)
    expect(src, 'the composer lost its attach controls').toMatch(/DmAttachControls\(composer, media\)/)
    expect(src, 'the composer lost its staged strip').toMatch(/DmStagedStrip\(composer, onRetry = media\.retry\)/)
    expect(src, 'the composer lost its recording bar').toMatch(/DmRecordingBar\(composer,/)
    // The refusal text is shown verbatim — each one names the cause and the fix,
    // and a generic "couldn't attach that" throws the actionable half away.
    expect(src, 'the composer stopped showing the refusal').toMatch(/composer\.error\?\.let/)
  })
})

/**
 * Turning a file the user picked (or a recording they just made) into a DM
 * attachment — the BROWSER half of migration 0031.
 *
 * The rail is: bytes → /api/media (base64) → R2 → `<worker>/media/<uuid>.<ext>`
 * → `attachments[]` on POST /api/messages. `decideDmAttachments` then validates
 * that URL, so everything here is about getting acceptable bytes to the store
 * in the first place.
 *
 * Three constraints shape every decision below, and all three are real numbers
 * measured against this stack, not guesses:
 *
 *  1. THE REQUEST CAP. /api/media is a Vercel EDGE route (~4.5MB request body)
 *     and the payload is base64, which inflates 4/3×. So the decoded file has
 *     to fit in ~3.3MB, and DM_UPLOAD_MAX_BYTES leaves margin for the JSON
 *     around it. The worker's own R2 cap (6MB, src/media.ts) is looser — the
 *     proxy is the real ceiling.
 *
 *  2. THE STORE'S ALLOWLIST. `DM_ATTACHMENT_TYPES` (which mirrors the store's
 *     `EXT`) is the whole set. A browser hands out plenty of types that are NOT
 *     in it — `image/heic` from an iPhone picker, `video/quicktime` from a .mov,
 *     `audio/webm` from Chrome's MediaRecorder. Each of those is either
 *     CONVERTED here or REFUSED with the reason; none is uploaded hopefully and
 *     none is dropped silently.
 *
 *  3. WHAT THE OTHER CLIENTS CAN PLAY. This is why a voice note is re-encoded
 *     to WAV rather than shipped as the `audio/webm` Chrome produces: adding
 *     webm to the allowlist would have been two lines, and iOS's AVPlayer
 *     cannot play it — a note recorded in Chrome would have been a silent
 *     unplayable bubble on the recipient's iPhone. 16kHz mono PCM plays
 *     everywhere, and at 32KB/s the duration cap below keeps it inside (1).
 *
 * The pure parts (planDmUpload, encodeWav, dmSizeRefusal, dmVoiceRefusal) hold
 * the rules and are node-testable; only the prepare/upload pair touches the DOM.
 */
import { DM_ATTACHMENT_TYPES, type DmAttachment, type DmAttachmentKind } from './dm-attachments'

/**
 * Decoded-bytes cap for one attachment.
 *
 * base64 is 4/3× the bytes, so this sits at 2.6MB → ~3.47MB of payload, which
 * is what `lib/file-attachments.ts` independently settled on for the same edge
 * route (MAX_PAYLOAD_BYTES = 3_500_000) after the same 12MP-camera-shot
 * problem. Images are recompressed to fit; a video or gif that doesn't fit is
 * refused, because there is no in-browser transcoder here to make it fit.
 */
export const DM_UPLOAD_MAX_BYTES = 2_600_000

/** Longest edge for an uploaded photo. Same 1568 as the chat rail: it's where
 *  the vision models downscale anyway, so more pixels buy nothing and cost
 *  request budget — and the agent reads DM photos through the same models. */
export const DM_IMAGE_MAX_DIM = 1568
const DM_IMAGE_QUALITY = 0.85

/** 🎤 Voice-note ceiling. Not an arbitrary product limit — 60s of 16kHz mono
 *  PCM is 1.92MB, which is the largest recording that still fits
 *  DM_UPLOAD_MAX_BYTES. Enforced by STOPPING the recorder at the cap rather
 *  than refusing afterwards: nobody should talk for two minutes and then be
 *  told the recording is unsendable. */
export const DM_VOICE_MAX_MS = 60_000
/** Speech is intelligible well below telephony bandwidth; 16kHz is also what
 *  every on-device recogniser wants, and it is what makes the byte arithmetic
 *  above work out. */
export const DM_VOICE_SAMPLE_RATE = 16_000

/** Types a file picker may hand us that we can CONVERT to something the store
 *  takes. Canvas decodes whatever the browser can display, so the conversion is
 *  "re-encode as JPEG" and the input type barely matters — but the extension
 *  fallback matters a lot, because Safari reports an empty `type` for some
 *  HEIC/HEIF picks. */
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|avi|mkv)$/i
const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|opus|aac|webm)$/i

/**
 * `accept` for the composer's file input — the picker-side mirror of
 * `planDmUpload`. Wide on images (the picker should offer the camera roll, and
 * HEIC/AVIF are converted here anyway), narrow on video, because .mov cannot be
 * transcoded in a browser and offering it would produce a refusal after the pick
 * instead of before it.
 *
 * ⚠️ Lives in this .ts and not inline in the .tsx on purpose: an `image/​*`
 * literal in a component is read as the START of a block comment by the
 * comment-stripping source pins in tests/ (measured — one silently swallowed
 * MessagesHUD's `maxLength={2000}` assertion, which is the DM cap's only client
 * -side guard). Import it; don't inline it back.
 */
export const DM_FILE_ACCEPT = 'image/*,video/mp4,audio/mp4,audio/mpeg,audio/wav,audio/ogg'

export type DmUploadPlan =
  | {
    ok: true
    kind: DmAttachmentKind
    /** The contentType we will UPLOAD as — not necessarily the file's own */
    contentType: string
    /** true → re-encode through canvas (also what converts HEIC → JPEG) */
    recompress: boolean
  }
  | { ok: false; error: string }

/**
 * Can this file become a DM attachment, and how?
 *
 * Refuses with a reason a person can act on ("Safari saves .mov"), never with
 * "unsupported file". Takes a plain `{type,name,size}` rather than a `File` so
 * every branch is a node test.
 */
export function planDmUpload(file: { type?: string; name?: string; size?: number }): DmUploadPlan {
  const type = String(file?.type || '').toLowerCase().split(';')[0].trim()
  const name = String(file?.name || '')

  // ── images ───────────────────────────────────────────────────────────────
  if (type.startsWith('image/') || (!type && IMAGE_EXT.test(name))) {
    // GIF goes up untouched: canvas would flatten an animation to its first
    // frame, which is a silent content change, and the store takes image/gif.
    if (type === 'image/gif') return { ok: true, kind: 'image', contentType: 'image/gif', recompress: false }
    // Everything else — including HEIC, AVIF and a 12MP JPEG — is re-encoded
    // to JPEG at DM_IMAGE_MAX_DIM. That both shrinks it under the request cap
    // and normalises a format the store (and iOS/Android renderers) may not
    // take into one they all do.
    return { ok: true, kind: 'image', contentType: 'image/jpeg', recompress: true }
  }

  // ── video ────────────────────────────────────────────────────────────────
  if (type.startsWith('video/') || (!type && VIDEO_EXT.test(name))) {
    if (type === 'video/mp4' || (!type && /\.(mp4|m4v)$/i.test(name))) {
      return { ok: true, kind: 'video', contentType: 'video/mp4', recompress: false }
    }
    // Honest about the gap: there is no transcoder in the browser here, and
    // pretending .mov is mp4 would store bytes iOS can play and Android often
    // cannot. Name the fix instead.
    return {
      ok: false,
      error: `Only .mp4 video can be sent from the web${/\.mov$/i.test(name) ? ' — Safari and iPhone save .mov' : ''}. Send it from the tiny app, or convert it to mp4 first.`,
    }
  }

  // ── audio the user picked as a FILE (recordings take the WAV path) ────────
  if (type.startsWith('audio/') || (!type && AUDIO_EXT.test(name))) {
    if (DM_ATTACHMENT_TYPES[type] === 'audio') {
      return { ok: true, kind: 'audio', contentType: type, recompress: false }
    }
    return {
      ok: false,
      error: `That audio format (${type || name.split('.').pop() || 'unknown'}) can't be sent. Supported: m4a, mp3, wav, ogg — or hold the mic button to record one.`,
    }
  }

  return {
    ok: false,
    error: 'Messages can carry photos, .mp4 video clips and voice notes — that file is none of those.',
  }
}

/** Over-cap refusal text, or null when it fits. Names both numbers: "which
 *  file, how far over" is the only version of this message anyone can act on. */
export function dmSizeRefusal(bytes: number, label = 'That file'): string | null {
  if (!Number.isFinite(bytes) || bytes <= DM_UPLOAD_MAX_BYTES) return null
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`
  // "is X, over the Y limit" rather than "is X — the limit is Y": at one byte
  // over, both numbers round to the same string, and "is 2.5MB, the limit is
  // 2.5MB" reads like a bug report about our own message.
  return `${label} is ${mb(bytes)}, over the ${mb(DM_UPLOAD_MAX_BYTES)} limit — nothing was sent.`
}

/** How many attachments a compose can still take, given what's already staged.
 *  Returns a refusal instead of quietly keeping the first N — a photo the user
 *  watched themselves attach must not vanish between the picker and the send. */
export function dmAttachmentRoom(staged: number, incoming: number, max: number): string | null {
  if (staged + incoming <= max) return null
  return `A message can carry ${max} attachments — you have ${staged} and picked ${incoming}. Send these first, then the rest.`
}

/**
 * 16-bit mono PCM in a RIFF/WAVE container.
 *
 * Hand-rolled because it is 20 lines and the alternative was a dependency (or
 * shipping Chrome's `audio/webm`, which the iPhone cannot play — see the header).
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(out.buffer)
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)   // file size - 8
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)                        // fmt chunk size
  view.setUint16(20, 1, true)                         // PCM, uncompressed
  view.setUint16(22, 1, true)                         // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)            // byte rate (mono, 2B/sample)
  view.setUint16(32, 2, true)                         // block align
  view.setUint16(34, 16, true)                        // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample slightly over ±1 (resampling ringing) would
    // wrap to the opposite extreme and click audibly.
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
  }
  return out
}

/** Duration of a WAV this module produced, from its own header. */
export function wavDurationMs(bytes: Uint8Array): number {
  if (bytes.length < 44) return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rate = view.getUint32(24, true)
  const dataBytes = view.getUint32(40, true)
  if (!rate) return 0
  return Math.round((dataBytes / 2 / rate) * 1000)
}

/** base64 in chunks — `String.fromCharCode(...bytes)` on a 2MB array overflows
 *  the argument stack and takes the whole send down with it. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as any)
  }
  return btoa(s)
}

/** A file staged in the composer but not yet (or not successfully) uploaded. */
export interface PreparedDmMedia {
  kind: DmAttachmentKind
  contentType: string
  /** decoded bytes ready for /api/media */
  bytes: Uint8Array
  /** blob: URL for the composer thumbnail (revoked when the chip is removed) */
  previewUrl: string
  name: string
  width?: number
  height?: number
  durationMs?: number
  transcript?: string
}

// ── browser-only from here down ──────────────────────────────────────────────

function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer))
    r.onerror = () => reject(new Error('could not read the file'))
    r.readAsArrayBuffer(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('could not decode the image'))
    img.src = src
  })
}

/** Re-encode through canvas at DM_IMAGE_MAX_DIM. Also the HEIC→JPEG converter:
 *  if the browser can DISPLAY the file, canvas can re-encode it. */
async function recompressImage(file: Blob): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const src = URL.createObjectURL(file)
  try {
    const img = await loadImage(src)
    const scale = Math.min(1, DM_IMAGE_MAX_DIM / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.drawImage(img, 0, 0, w, h)
    const dataUrl = canvas.toDataURL('image/jpeg', DM_IMAGE_QUALITY)
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const raw = atob(b64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return { bytes, width: w, height: h }
  } finally {
    URL.revokeObjectURL(src)
  }
}

/**
 * File picked → staged attachment, or a thrown Error whose message is shown to
 * the user verbatim (every one of them names the problem and the fix).
 */
export async function prepareDmFile(file: File): Promise<PreparedDmMedia> {
  const plan = planDmUpload(file)
  if (!plan.ok) throw new Error(plan.error)

  if (plan.recompress) {
    const { bytes, width, height } = await recompressImage(file)
    // Checked AFTER the shrink: a 12MP photo is over the cap as picked and
    // comfortably under it once re-encoded, so refusing on the original size
    // would reject the single commonest attachment there is.
    const tooBig = dmSizeRefusal(bytes.length, `“${file.name}”`)
    if (tooBig) throw new Error(tooBig)
    return {
      kind: plan.kind, contentType: plan.contentType, bytes, width, height,
      name: file.name || 'photo.jpg',
      previewUrl: URL.createObjectURL(new Blob([bytes as any], { type: plan.contentType })),
    }
  }

  // Not recompressible (gif, mp4, an audio file): the size it is, is the size
  // it stays, so check before spending time reading it.
  const tooBig = dmSizeRefusal(file.size, `“${file.name}”`)
  if (tooBig) throw new Error(tooBig)
  const bytes = await readFileBytes(file)
  return {
    kind: plan.kind, contentType: plan.contentType, bytes,
    name: file.name || `file.${plan.contentType.split('/')[1]}`,
    previewUrl: URL.createObjectURL(file),
  }
}

/**
 * 🎤 A MediaRecorder blob → a WAV voice note (+ whatever the browser's
 * recogniser heard).
 *
 * The re-encode is the point: see the header note on why Chrome's `audio/webm`
 * is not simply allowlisted. Decoding also gives us the true duration, so the
 * bubble can say "0:14" without anyone fetching the audio.
 */
export async function prepareDmRecording(blob: Blob, transcript?: string): Promise<PreparedDmMedia> {
  const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!AC) throw new Error('This browser can’t process audio recordings.')
  const raw = await blob.arrayBuffer()
  const ctx = new AC()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(raw)
  } finally {
    // Every open AudioContext holds an audio device; Safari caps how many exist.
    ctx.close().catch(() => {})
  }

  // Resample + downmix to mono in one pass. OfflineAudioContext does both
  // correctly (a naive stride-drop resampler aliases badly on speech).
  const frames = Math.max(1, Math.ceil(decoded.duration * DM_VOICE_SAMPLE_RATE))
  const off = new (window as any).OfflineAudioContext(1, frames, DM_VOICE_SAMPLE_RATE) as OfflineAudioContext
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const mono = await off.startRendering()

  const bytes = encodeWav(mono.getChannelData(0), DM_VOICE_SAMPLE_RATE)
  const tooBig = dmSizeRefusal(bytes.length, 'That recording')
  if (tooBig) throw new Error(tooBig)
  return {
    kind: 'audio',
    contentType: 'audio/wav',
    bytes,
    durationMs: wavDurationMs(bytes),
    ...(transcript && transcript.trim() ? { transcript: transcript.trim() } : {}),
    name: 'voice-note.wav',
    previewUrl: URL.createObjectURL(new Blob([bytes as any], { type: 'audio/wav' })),
  }
}

/**
 * 🗣️ Best-effort transcript for a voice note, from the browser's own recogniser.
 *
 * The phones transcribe on-device (there is no Workers AI binding in this
 * stack), and web was specced as audio-only — but Chrome/Edge/Safari expose
 * SpeechRecognition, so where it exists a web voice note can be readable by the
 * AGENT too instead of arriving as bytes nobody can search.
 *
 * Returns null when unsupported, and the caller then sends the audio with NO
 * transcript field — which `dmAttachmentSummary` reports as "no transcript
 * available" rather than as an empty utterance.
 */
export function startDmTranscript(): { stop: () => string } | null {
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) return null
  let text = ''
  let rec: any
  try {
    rec = new SR()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = navigator.language || 'en-US'
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += (text ? ' ' : '') + String(e.results[i][0]?.transcript || '').trim()
      }
    }
    // A recogniser error must never fail the RECORDING — the audio is the
    // message; the transcript is a bonus. Swallow and return what we have.
    rec.onerror = () => {}
    rec.start()
  } catch {
    return null
  }
  return {
    stop: () => {
      try { rec.stop() } catch {}
      return text.trim()
    },
  }
}

/**
 * Upload staged bytes and return the attachment to send.
 *
 * Throws with the server's own reason on failure. Deliberately does NOT retry:
 * the caller keeps the chip in a failed state with a retry button, so the user
 * decides — an automatic retry of a multi-megabyte body on a bad connection is
 * how you get four copies in R2 and a composer that looks stuck.
 */
export async function uploadDmMedia(m: PreparedDmMedia): Promise<DmAttachment> {
  const res = await fetch('/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: bytesToBase64(m.bytes), contentType: m.contentType }),
    signal: AbortSignal.timeout(45_000),
  }).then(r => r.json()).catch((e) => ({ ok: false, error: String(e?.message || e) }))

  if (!res?.ok || !res.url) throw new Error(res?.error || 'upload failed')
  return {
    kind: m.kind,
    url: String(res.url),
    contentType: m.contentType,
    bytes: m.bytes.length,
    ...(m.durationMs ? { durationMs: m.durationMs } : {}),
    ...(m.transcript ? { transcript: m.transcript } : {}),
    ...(m.width ? { width: m.width } : {}),
    ...(m.height ? { height: m.height } : {}),
  }
}

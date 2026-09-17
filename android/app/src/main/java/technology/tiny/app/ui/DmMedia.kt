package technology.tiny.app.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaMetadataRetriever
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.exifinterface.media.ExifInterface
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.TinyApp
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Locale

/**
 * DmMedia — what a DM can carry besides text, on the device that has the camera
 * and the microphone (migration 0031). The Android half of
 * `ios/Tiny/Sources/DmMedia.swift`; the numbers and the refusal sentences are
 * the SAME ones, pinned across all three languages by
 * tests/android-dm-media.test.ts.
 *
 * The rail: bytes → POST /api/media (base64 → R2) → `<worker>/media/<uuid>.<ext>`
 * → `attachments[]` on POST /api/messages. The server validates that URL again
 * (`decideDmAttachments`, lib/chat/dm-attachments.ts) and nothing here trusts
 * the server's `kind` either — it is DERIVED from `contentType` on both ends, so
 * a mislabelled mp4 can never be handed to an image view (or, on the read side,
 * to the model as a picture).
 *
 * Three rules, which are one rule wearing three hats:
 *
 *  1. REFUSE, NEVER PARTIALLY DELIVER. A DM cannot be unsent. Every refusal
 *     below names the file, the number it broke and what to do instead; none
 *     drops an attachment the sender watched themselves attach. Same reason
 *     `dmSendRefusal` exists for the text half (Messages.kt).
 *
 *  2. THE CAP IS ARITHMETIC, NOT TASTE. /api/media is a Vercel EDGE route
 *     (~4.5MB request body) and the payload is base64, +4/3×.
 *     [DM_UPLOAD_MAX_BYTES] is the decoded-byte ceiling that leaves room for the
 *     JSON around it — the same 2.6MB the web composer and iOS use.
 *
 *  3. WHAT THE OTHER CLIENTS CAN PLAY DECIDES THE FORMAT. A voice note is 16kHz
 *     mono PCM in a RIFF/WAVE container (`audio/wav`, byte-for-byte the shape the
 *     web recorder produces) and a clip is H.264 in mp4, because those are what
 *     Chrome, iOS and this app all play.
 *
 * ⚠️ TWO PLATFORM GAPS THAT SHAPE THIS FILE, both measured rather than assumed:
 *
 *  · ANDROID HAS NO PUBLIC TRANSCODER. `MediaTranscodingManager` never shipped
 *    as public API, so a 4K/50Mbit camera clip could only ever be REFUSED. The
 *    clip path therefore runs Media3's `Transformer` (see the build.gradle.kts
 *    note) — and unlike iOS's `AVAssetExportSession`, it exposes a real target
 *    bitrate, so the size is COMPUTED from the budget instead of guessed at with
 *    a preset ladder. It is still MEASURED afterwards, because an encoder is free
 *    to ignore the request.
 *
 *  · ANDROID'S RECOGNISER CANNOT READ AN ARBITRARY FILE BEFORE API 33.
 *    `SpeechRecognizer` is a live-microphone API; `RecognizerIntent
 *    .EXTRA_AUDIO_SOURCE` (API 33) is the only way to hand it recorded samples,
 *    and it wants HEADERLESS PCM. Below 33 a voice note therefore carries NO
 *    transcript — which is a real answer, not a silent failure:
 *    `dmAttachmentSummary` reports "no transcript available" to the agent, and
 *    the audio sends either way. Recording with `MediaRecorder` and transcribing
 *    live is not an alternative — the mic is exclusive to one capture at a time.
 */

// ── the wire contract (mirrors lib/chat/dm-attachments.ts) ────────────────────

/** A photo or three, a clip, a voice note — that's a message. Twenty files is an
 *  upload session. `DM_MAX_ATTACHMENTS`: the worker refuses a fifth, so the
 *  composer must not offer one. */
internal const val DM_MAX_ATTACHMENTS = 4

/** Decoded-bytes cap for ONE attachment. `DM_UPLOAD_MAX_BYTES` — see rule 2 in
 *  the header: base64 is 4/3×, and /api/media is an edge route. */
internal const val DM_UPLOAD_MAX_BYTES = 2_600_000

/** Longest edge for an uploaded photo (`DM_IMAGE_MAX_DIM`). It is also where the
 *  vision models downscale anyway, and the agent reads DM photos through those
 *  models (`read_messages`), so more pixels buy nothing and cost request budget. */
internal const val DM_IMAGE_MAX_DIM = 1568

/** Web/iOS parity (`DM_IMAGE_QUALITY` 0.85, `kDmImageQuality`). Expressed 0–100
 *  because that is what `Bitmap.compress` takes. */
internal const val DM_IMAGE_QUALITY = 85

/** 🎤 Voice-note ceiling, enforced by STOPPING the recorder — nobody should talk
 *  for two minutes and only then be told it can't be sent. 60s of 16kHz mono PCM
 *  is 1.92MB, which is the longest recording that still fits
 *  [DM_UPLOAD_MAX_BYTES]; that is where the number comes from, not taste. */
internal const val DM_VOICE_MAX_MS = 60_000L

/** Under this, the "recording" is a mis-tap on the mic button (iOS
 *  `kDmVoiceMinSeconds` 0.7s). */
internal const val DM_VOICE_MIN_MS = 700L

/** Speech is intelligible well below telephony bandwidth; 16kHz is also what
 *  every on-device recogniser wants, and it is what makes the byte arithmetic
 *  above work out (`DM_VOICE_SAMPLE_RATE`). */
internal const val DM_VOICE_SAMPLE_RATE = 16_000

/** 🎥 Clip ceiling. A phone camera makes 4K/60 at ~50Mbit; nothing gets a
 *  3-minute clip of that under 2.6MB, and pretending otherwise means a long
 *  transcode that ends in a refusal. Refuse on DURATION first, before spending a
 *  minute of someone's battery, and say how to fix it. */
internal const val DM_CLIP_MAX_SECONDS = 30

/** A voice note's transcript cap — the same 2000 the body uses
 *  (`DM_MAX_TRANSCRIPT_CHARS`); the worker clips to it independently. */
internal const val DM_MAX_TRANSCRIPT_CHARS = DM_MAX_CHARS

/**
 * contentType → kind. THIS IS THE ALLOWLIST, and it is the media store's own
 * (`EXT` in worker/src/media.ts) via `DM_ATTACHMENT_TYPES` — a
 * type absent here is refused end to end. Note `video/mp4` only, and no
 * `image/heic`: the picker hands out plenty this does not list, and each of those
 * is CONVERTED before upload or refused with the reason.
 */
internal val DM_ATTACHMENT_TYPES: Map<String, String> = mapOf(
    "image/jpeg" to "image",
    "image/png" to "image",
    "image/webp" to "image",
    "image/gif" to "image",
    "video/mp4" to "video",
    "audio/mp4" to "audio",
    "audio/mpeg" to "audio",
    "audio/wav" to "audio",
    "audio/ogg" to "audio",
)

/** The kind an attachment IS, from the only field that can say so. */
internal fun dmAttachmentKind(contentType: String): String? =
    DM_ATTACHMENT_TYPES[contentType.lowercase().trim()]

/** "0:07", "1:42" — `dmDuration` (dm-attachments.ts), so a bubble can show the
 *  length without fetching the bytes. Empty for a missing/zero duration rather
 *  than "0:00", which reads like a broken file. */
internal fun dmDuration(durationMs: Int?): String {
    val ms = durationMs ?: 0
    if (ms <= 0) return ""
    val total = Math.round(ms / 1000.0).toInt()
    return "${total / 60}:${String.format(Locale.US, "%02d", total % 60)}"
}

/** Bytes as a person reads them — MiB with one decimal, like the web's `mb()`,
 *  iOS's `dmMB` and `Attachments`' own size labels. Locale.US so a comma decimal
 *  separator can't make "2,6MB" out of a number the server reported as 2.6MB. */
internal fun dmMB(bytes: Int): String =
    String.format(Locale.US, "%.1fMB", bytes / 1_048_576.0)

/**
 * Over-cap refusal, or null when it fits. Word-for-word the web's
 * `dmSizeRefusal` and iOS's — "is X, over the Y limit", never "is X — the limit
 * is Y", because at one byte over both numbers round to the same string and the
 * message then reads like a bug report about itself.
 */
internal fun dmSizeRefusal(bytes: Int, label: String = "That file"): String? {
    if (bytes <= DM_UPLOAD_MAX_BYTES) return null
    return "$label is ${dmMB(bytes)}, over the ${dmMB(DM_UPLOAD_MAX_BYTES)} limit — nothing was sent."
}

/** Room left in this message. Refuses the whole pick instead of quietly keeping
 *  the first four — web/iOS parity (`dmAttachmentRoom`), and the same promise the
 *  text rule makes. */
internal fun dmAttachmentRoom(staged: Int, incoming: Int, max: Int = DM_MAX_ATTACHMENTS): String? {
    if (staged + incoming <= max) return null
    return "A message can carry $max attachments — you have $staged and picked $incoming. " +
        "Send these first, then the rest."
}

/** Too-long-clip refusal, decided from the SOURCE duration so it lands before
 *  the transcode instead of after it. */
internal fun dmClipRefusal(seconds: Double): String? {
    if (!seconds.isFinite() || seconds <= DM_CLIP_MAX_SECONDS) return null
    return "That clip is ${Math.round(seconds)}s — messages carry clips up to " +
        "${DM_CLIP_MAX_SECONDS}s. Trim it in Photos and pick it again."
}

/**
 * Clip a transcript on a CODE-POINT boundary.
 *
 * ⚠️ Not `text.take(n)`: Kotlin's `String.take` counts UTF-16 units, so it can cut
 * between the two halves of a surrogate pair and produce a lone high surrogate —
 * exactly the mojibake `clipToCodePoints` exists to prevent on the server
 * (tests/dm-length-parity.test.ts documents the DM body version of this bug,
 * which shipped). Clipping a transcript at all is fine — it is a lossy
 * convenience beside the audio — but clipping it into garbage is not.
 */
internal fun dmClipTranscript(text: String): String {
    val points = text.codePointCount(0, text.length)
    if (points <= DM_MAX_TRANSCRIPT_CHARS) return text
    return text.substring(0, text.offsetByCodePoints(0, DM_MAX_TRANSCRIPT_CHARS))
}

/**
 * One stored attachment on a DM.
 *
 * `kind` is derived from `contentType` at decode; an unknown type becomes
 * `"other"` and renders as a plain link rather than disappearing — a read path
 * that silently drops what it can't display tells the reader a message had
 * nothing in it.
 */
data class DmAttachment(
    /** Stable across polls (so the bubble list doesn't churn the scroll) AND
     *  unique within a message — the same photo can legitimately be attached
     *  twice, and two identical keys in a `LazyColumn` is a rendering bug. */
    val slot: Int = 0,
    val kind: String,
    val url: String,
    val contentType: String,
    val bytes: Int? = null,
    val transcript: String? = null,
    val durationMs: Int? = null,
    val width: Int? = null,
    val height: Int? = null,
) {
    val id: String get() = "$slot:$url"

    /** What POST /api/messages carries. Only the fields the server names —
     *  anything else it would drop anyway (`decideDmAttachments`). */
    fun wire(): JSONObject {
        val out = JSONObject()
            .put("kind", kind)
            .put("url", url)
            .put("contentType", contentType)
        bytes?.let { out.put("bytes", it) }
        transcript?.takeIf { it.isNotEmpty() }?.let { out.put("transcript", it) }
        durationMs?.let { out.put("durationMs", it) }
        width?.let { out.put("width", it) }
        height?.let { out.put("height", it) }
        return out
    }
}

/** One decoded attachment, or null when it carries no url to point at. */
internal fun dmAttachment(json: JSONObject, slot: Int): DmAttachment? {
    val url = json.optString("url").takeIf { it.isNotEmpty() } ?: return null
    val type = json.optString("contentType").lowercase()
    return DmAttachment(
        slot = slot,
        // Not `json.optString("kind")`: see the type note in the header.
        kind = dmAttachmentKind(type) ?: "other",
        url = url,
        contentType = type,
        bytes = json.optInt("bytes").takeIf { it > 0 },
        transcript = json.optString("transcript").trim().takeIf { it.isNotEmpty() },
        durationMs = json.optInt("durationMs").takeIf { it > 0 },
        width = json.optInt("width").takeIf { it > 0 },
        height = json.optInt("height").takeIf { it > 0 },
    )
}

/** Decode a message's attachments. Order is preserved (it is the order they were
 *  attached in) and an unparseable entry is skipped rather than aborting the
 *  message — a bad row must not cost the reader the text beside it. */
internal fun dmAttachments(arr: JSONArray?): List<DmAttachment> =
    (0 until (arr?.length() ?: 0)).mapNotNull { i ->
        arr?.optJSONObject(i)?.let { dmAttachment(it, i) }
    }

/** The POST /api/messages body for a DM, media or not. */
internal fun dmSendBody(login: String, text: String, attachments: List<DmAttachment>): JSONObject {
    val body = JSONObject().put("to", login).put("message", text)
    // Omitted rather than sent empty: `decideDmAttachments` treats a missing key
    // and an empty array identically, but the absent key is what every text-only
    // client has always sent, so it is the shape with the mileage.
    if (attachments.isNotEmpty()) {
        body.put("attachments", JSONArray().also { arr -> attachments.forEach { arr.put(it.wire()) } })
    }
    return body
}

/** The box a thumbnail occupies BEFORE its bytes arrive, in dp. Reserved from the
 *  stored pixel size so the thread doesn't reflow mid-scroll as photos load —
 *  the reason `width`/`height` are on the wire at all (iOS `previewBox`). */
internal fun dmPreviewHeight(width: Int?, height: Int?, maxWidth: Int = 220): Int {
    if (width == null || height == null || width <= 0 || height <= 0) {
        return (maxWidth * 0.75).toInt()
    }
    val tall = maxWidth.toDouble() * height / width
    return minOf(maxWidth * 1.4, maxOf(80.0, tall)).toInt()
}

// ── staging: prepared bytes waiting for their upload ─────────────────────────

internal enum class DmUploadState { UPLOADING, READY, FAILED }

/**
 * An attachment the user has picked, on its way to the store.
 *
 * ⚠️ [id] is the identity used everywhere — the strip's `key`, remove, retry and
 * patch all match on it. The generated `equals` compares [bytes] by reference,
 * which is deliberately never relied on.
 */
internal data class StagedDmMedia(
    val id: Long,
    val kind: String,
    val contentType: String,
    /** The exact bytes /api/media will get. Kept after a failure so Retry
     *  re-posts the same file instead of asking the user to find it again. */
    val bytes: ByteArray,
    val name: String,
    /** Small bitmap for the composer chip (a voice note has none — it has no
     *  picture — and falls back to a glyph). */
    val thumb: Bitmap? = null,
    val durationMs: Int? = null,
    val transcript: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val state: DmUploadState = DmUploadState.UPLOADING,
    val error: String? = null,
    val attachment: DmAttachment? = null,
)

/** Prepared, or refused with a line to show the user verbatim. Mirrors
 *  `Attachments.DocResult`: returning null is how a rejected pick becomes a file
 *  that silently vanished from the composer. */
internal sealed interface DmMediaResult {
    data class Ok(val media: StagedDmMedia) : DmMediaResult
    data class Refused(val message: String) : DmMediaResult
}

/** Why this send must NOT go yet, or null. A DM that leaves while an upload is in
 *  flight arrives without the photo, and it cannot be unsent. Pure so both the
 *  gate and its test can call it (iOS `DmComposer.blockingReason`). */
internal fun dmBlockingReason(states: List<DmUploadState>): String? {
    if (states.any { it == DmUploadState.UPLOADING }) return "Still uploading — one moment."
    if (states.any { it == DmUploadState.FAILED }) {
        return "An attachment didn't upload. Retry it or remove it — nothing was sent."
    }
    return null
}

// ── 🔊 WAV, hand-rolled (parity with encodeWav in dm-media-upload.ts) ─────────

/**
 * 16-bit mono PCM in a RIFF/WAVE container — 44 bytes of header in front of the
 * samples `AudioRecord` already gave us.
 *
 * Hand-rolled for the same reason the web one is: it is twenty lines, and the
 * alternative was shipping a container the other clients can't play. The store's
 * allowlist has `audio/wav`, every browser plays it, and iOS's AVPlayer does too.
 */
internal fun dmWavHeader(pcmBytes: Int, sampleRate: Int = DM_VOICE_SAMPLE_RATE): ByteArray {
    val out = ByteArray(44)
    fun ascii(off: Int, s: String) { for (i in s.indices) out[off + i] = s[i].code.toByte() }
    fun le32(off: Int, v: Int) {
        out[off] = (v and 0xff).toByte()
        out[off + 1] = ((v shr 8) and 0xff).toByte()
        out[off + 2] = ((v shr 16) and 0xff).toByte()
        out[off + 3] = ((v shr 24) and 0xff).toByte()
    }
    fun le16(off: Int, v: Int) {
        out[off] = (v and 0xff).toByte()
        out[off + 1] = ((v shr 8) and 0xff).toByte()
    }
    ascii(0, "RIFF")
    le32(4, 36 + pcmBytes)          // file size - 8
    ascii(8, "WAVE")
    ascii(12, "fmt ")
    le32(16, 16)                    // fmt chunk size
    le16(20, 1)                     // PCM, uncompressed
    le16(22, 1)                     // mono
    le32(24, sampleRate)
    le32(28, sampleRate * 2)        // byte rate (mono, 2B/sample)
    le16(32, 2)                     // block align
    le16(34, 16)                    // bits per sample
    ascii(36, "data")
    le32(40, pcmBytes)
    return out
}

/** Duration of a WAV this module produced, from its own header (`wavDurationMs`). */
internal fun dmWavDurationMs(wav: ByteArray): Int {
    if (wav.size < 44) return 0
    fun le32(off: Int): Int =
        (wav[off].toInt() and 0xff) or ((wav[off + 1].toInt() and 0xff) shl 8) or
            ((wav[off + 2].toInt() and 0xff) shl 16) or ((wav[off + 3].toInt() and 0xff) shl 24)
    val rate = le32(24)
    val dataBytes = le32(40)
    if (rate <= 0) return 0
    return Math.round(dataBytes / 2.0 / rate * 1000).toInt()
}

/** How many PCM bytes fit in [DM_VOICE_MAX_MS] — the recorder's own hard stop, so
 *  a runaway reader thread cannot produce a file that could only be refused. */
internal fun dmVoicePcmCap(maxMs: Long = DM_VOICE_MAX_MS, sampleRate: Int = DM_VOICE_SAMPLE_RATE): Int =
    (maxMs * sampleRate * 2 / 1000).toInt()

/** Elapsed ms from bytes captured — the recorder's OWN clock, not wall time
 *  since the tap. A cold mic takes a moment to open, and counting that would
 *  report (and cut off at) a length the audio doesn't have. */
internal fun dmPcmMs(pcmBytes: Long, sampleRate: Int = DM_VOICE_SAMPLE_RATE): Long =
    if (sampleRate <= 0) 0 else pcmBytes * 1000 / (sampleRate.toLong() * 2)

// ── 🎥 clip bitrate budget ────────────────────────────────────────────────────

/**
 * The video bitrate to ASK the encoder for, so the result lands under the cap.
 *
 * This is the piece iOS cannot do: `AVAssetExportSession` only takes presets, so
 * it exports, measures, and steps down a preset ladder. `Transformer` takes a
 * real bitrate, so the size is arithmetic — budget bytes → bits, minus the audio
 * track, divided by the duration.
 *
 * [headroom] under 1 because a muxer's container overhead and an encoder's
 * rate-control overshoot are both real; [tighten] is the second pass, used only
 * after a measured over-cap result.
 *
 * Clamped at both ends: below ~120kbps 540p H.264 is unwatchable mush (better to
 * refuse and say so), and above 2.5Mbps there is nothing to gain for a 30s clip.
 */
internal fun dmClipVideoBitrate(
    durationMs: Long,
    capBytes: Int = DM_UPLOAD_MAX_BYTES,
    audioBps: Int = 64_000,
    headroom: Double = 0.85,
    tighten: Double = 1.0,
): Int {
    val seconds = (durationMs / 1000.0).coerceAtLeast(0.5)
    val budgetBits = capBytes * 8.0 * headroom * tighten
    val videoBits = budgetBits - audioBps * seconds
    return (videoBits / seconds).toInt().coerceIn(120_000, 2_500_000)
}

// ── picked file → uploadable bytes ───────────────────────────────────────────

/** Prepared bytes plus the pixel size they came out at. */
private class EncodedImage(val bytes: ByteArray, val width: Int, val height: Int, val thumb: Bitmap?)

/**
 * Downscale to [DM_IMAGE_MAX_DIM] and re-encode as JPEG.
 *
 * Also the HEIC/AVIF→JPEG converter: the store's allowlist has neither, and both
 * are what a modern Android picker hands over, so refusing them would make the
 * commonest photo on this phone unsendable.
 *
 * The decode is sampled (`inSampleSize`) before it is scaled, for the reason
 * `Attachments.encode` documents: decoding a 50MP shot at full res allocates
 * ~200MB of ARGB_8888 just to shrink it.
 */
private fun encodeDmImage(context: Context, uri: Uri): EncodedImage? = runCatching {
    val raw = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
    var sample = 1
    var longEdge = maxOf(bounds.outWidth, bounds.outHeight)
    while (longEdge / 2 >= DM_IMAGE_MAX_DIM) { longEdge /= 2; sample *= 2 }
    val decoded = BitmapFactory.decodeByteArray(
        raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample },
    ) ?: return null

    // Fine scale to the exact long-edge cap (inSampleSize only halves), then bake
    // in EXIF orientation — BitmapFactory ignores the flag, so a portrait phone
    // photo would otherwise arrive in the recipient's thread lying on its side.
    val scale = minOf(1f, DM_IMAGE_MAX_DIM.toFloat() / maxOf(decoded.width, decoded.height, 1))
    val orientation = runCatching {
        ExifInterface(ByteArrayInputStream(raw)).getAttributeInt(
            ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL,
        )
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    val matrix = dmOrientationMatrix(orientation).apply { if (scale < 1f) preScale(scale, scale) }
    val bitmap = if (matrix.isIdentity) decoded
        else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)

    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, DM_IMAGE_QUALITY, out)
    EncodedImage(out.toByteArray(), bitmap.width, bitmap.height, dmThumb(bitmap))
}.getOrNull()

/** EXIF orientation → transform matrix (rotation + mirror); identity for NORMAL.
 *  Same table as `Attachments.orientationMatrix`, which is private to that file. */
private fun dmOrientationMatrix(orientation: Int): Matrix = Matrix().apply {
    when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
        ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
        ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(270f)
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { postRotate(90f); postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_TRANSVERSE -> { postRotate(270f); postScale(-1f, 1f) }
    }
}

/** A ~96px composer chip. Held as a Bitmap rather than re-encoded base64: the
 *  chip lives for the length of one compose, so nothing needs to persist it. */
private fun dmThumb(src: Bitmap, dim: Int = 96): Bitmap? = runCatching {
    val scale = minOf(1f, dim.toFloat() / maxOf(src.width, src.height, 1))
    if (scale >= 1f) src
    else Bitmap.createScaledBitmap(
        src, maxOf(1, (src.width * scale).toInt()), maxOf(1, (src.height * scale).toInt()), true,
    )
}.getOrNull()

/** A picked photo → an uploadable JPEG, or a refusal naming the file. */
internal suspend fun dmPrepareImage(context: Context, uri: Uri, id: Long, name: String): DmMediaResult =
    withContext(Dispatchers.IO) {
        val encoded = encodeDmImage(context, uri)
            ?: return@withContext DmMediaResult.Refused(
                "“$name” couldn't be prepared for sending — nothing was sent.",
            )
        // Checked AFTER the shrink: a 12MP camera shot is over the cap as picked
        // and comfortably under it once re-encoded, so refusing on the original
        // size would reject the single commonest attachment there is.
        dmSizeRefusal(encoded.bytes.size, "“$name”")?.let { return@withContext DmMediaResult.Refused(it) }
        DmMediaResult.Ok(
            StagedDmMedia(
                id = id, kind = "image", contentType = "image/jpeg", bytes = encoded.bytes,
                name = name, thumb = encoded.thumb, width = encoded.width, height = encoded.height,
            ),
        )
    }

/** Source duration in ms, or 0 when the file won't say. */
private fun dmMediaDurationMs(context: Context, uri: Uri): Long = runCatching {
    val mmr = MediaMetadataRetriever()
    try {
        mmr.setDataSource(context, uri)
        mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
    } finally {
        runCatching { mmr.release() }
    }
}.getOrDefault(0L)

/** First-frame poster for a clip chip. */
private fun dmVideoThumb(file: File): Bitmap? = runCatching {
    val mmr = MediaMetadataRetriever()
    try {
        mmr.setDataSource(file.absolutePath)
        // getFrameAtTime applies the display rotation, so a portrait clip's chip
        // isn't sideways.
        mmr.getFrameAtTime(100_000)?.let { dmThumb(it, 192) }
    } finally {
        runCatching { mmr.release() }
    }
}.getOrNull()

/**
 * 🎥 Transcode a picked clip to H.264/mp4 small enough to send.
 *
 * COMPUTE, then MEASURE, then one stricter pass — see [dmClipVideoBitrate]. An
 * encoder is free to overshoot the bitrate it was handed, so the file size that
 * decides whether this DM can be sent is read off the finished file, never
 * predicted. If the second pass is still over, the refusal says so in real bytes
 * rather than blaming the file.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal suspend fun dmPrepareClip(context: Context, uri: Uri, id: Long): DmMediaResult {
    val durationMs = withContext(Dispatchers.IO) { dmMediaDurationMs(context, uri) }
    if (durationMs <= 0) {
        return DmMediaResult.Refused("That clip couldn't be read — nothing was sent.")
    }
    dmClipRefusal(durationMs / 1000.0)?.let { return DmMediaResult.Refused(it) }

    var lastFailure = ""
    var oversize: Int? = null
    // Pass 1: 540p at the computed budget (legible on any phone). Pass 2: 360p at
    // 60% of it — the Android twin of iOS's two-preset ladder, and capped at two
    // passes for the same reason: a third costs more battery than it buys pixels.
    val passes = listOf(540 to 1.0, 360 to 0.6)
    for ((height, tighten) in passes) {
        val out = File(context.cacheDir, "dm-clip-$id-$height.mp4")
        runCatching { out.delete() }
        val failure = dmTransform(
            context = context,
            uri = uri,
            out = out,
            height = height,
            bitrate = dmClipVideoBitrate(durationMs, tighten = tighten),
        )
        if (failure != null) {
            lastFailure = failure
            runCatching { out.delete() }
            continue
        }
        val bytes = withContext(Dispatchers.IO) { runCatching { out.readBytes() }.getOrNull() }
        if (bytes == null || bytes.isEmpty()) {
            lastFailure = "the compressed clip came back empty"
            runCatching { out.delete() }
            continue
        }
        if (bytes.size > DM_UPLOAD_MAX_BYTES) {
            oversize = bytes.size
            runCatching { out.delete() }
            continue // ← the whole point of the second pass
        }
        val thumb = withContext(Dispatchers.IO) { dmVideoThumb(out) }
        val size = withContext(Dispatchers.IO) { dmVideoPixelSize(out) }
        runCatching { out.delete() }
        return DmMediaResult.Ok(
            StagedDmMedia(
                id = id, kind = "video", contentType = "video/mp4", bytes = bytes,
                name = "clip.mp4", thumb = thumb, durationMs = durationMs.toInt(),
                width = size?.first, height = size?.second,
            ),
        )
    }
    oversize?.let {
        // Honest about which limit was hit, and the only remedy that works.
        return DmMediaResult.Refused(
            "Even compressed, that clip is ${dmMB(it)} — over the " +
                "${dmMB(DM_UPLOAD_MAX_BYTES)} limit, so nothing was sent. Send a shorter piece of it.",
        )
    }
    return DmMediaResult.Refused(
        "That clip couldn't be compressed for sending ($lastFailure) — nothing was sent.",
    )
}

/** Pixel size of the TRANSCODED clip, rotation applied — the box a recipient
 *  reserves for it. */
private fun dmVideoPixelSize(file: File): Pair<Int, Int>? = runCatching {
    val mmr = MediaMetadataRetriever()
    try {
        mmr.setDataSource(file.absolutePath)
        val w = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: return null
        val h = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: return null
        val rotation = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
        if (rotation == 90 || rotation == 270) h to w else w to h
    } finally {
        runCatching { mmr.release() }
    }
}.getOrNull()

/**
 * One Media3 export. Returns null on success, or the failure line to report.
 *
 * `Transformer` is built and started on the MAIN thread deliberately: it posts
 * its callbacks to the Looper of the thread that built it, and a Transformer
 * built on an IO dispatcher thread has no Looper at all (`IllegalStateException`
 * at construction). The work itself happens on the encoder's own threads.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
private suspend fun dmTransform(
    context: Context,
    uri: Uri,
    out: File,
    height: Int,
    bitrate: Int,
): String? = withContext(Dispatchers.Main) {
    // Bounded: a stuck encoder would otherwise leave the composer spinning with
    // no way out. 3 minutes is far longer than a 30s clip ever needs and short
    // enough that "still working" never means "wedged forever".
    withTimeoutOrNull(180_000L) {
        suspendCancellableCoroutine { cont: CancellableContinuation<String?> ->
            val transformer = Transformer.Builder(context)
                // H.264 + AAC, not HEVC: HEVC-in-mp4 is what a Chrome recipient
                // cannot play, and the recipient's browser is not ours to pick.
                .setVideoMimeType(MimeTypes.VIDEO_H264)
                .setAudioMimeType(MimeTypes.AUDIO_AAC)
                .setEncoderFactory(
                    DefaultEncoderFactory.Builder(context)
                        .setRequestedVideoEncoderSettings(
                            VideoEncoderSettings.Builder().setBitrate(bitrate).build(),
                        )
                        // An encoder that can't honour the request should still
                        // produce a file — we measure the result anyway.
                        .setEnableFallback(true)
                        .build(),
                )
                .addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        if (cont.isActive) cont.resume(null)
                    }

                    override fun onError(
                        composition: Composition,
                        exportResult: ExportResult,
                        exportException: ExportException,
                    ) {
                        if (cont.isActive) {
                            cont.resume(exportException.message ?: "the encoder gave up")
                        }
                    }
                })
                .build()
            val edited = EditedMediaItem.Builder(MediaItem.fromUri(uri))
                .setEffects(
                    Effects(
                        emptyList<AudioProcessor>(),
                        listOf<Effect>(Presentation.createForHeight(height)),
                    ),
                )
                .build()
            cont.invokeOnCancellation { runCatching { transformer.cancel() } }
            runCatching { transformer.start(edited, out.absolutePath) }.onFailure {
                if (cont.isActive) cont.resume(it.message ?: "this phone can't compress that clip")
            }
        }
    } ?: "compressing it took too long"
}

/**
 * 🎤 A finished recording → an uploadable voice note (+ what the phone heard).
 *
 * [pcm] is HEADERLESS 16-bit mono PCM straight off `AudioRecord`, because that is
 * what the API-33 recogniser wants; the WAV the recipient gets is the same
 * samples with 44 bytes in front (see [dmWavHeader]).
 */
internal suspend fun dmPrepareVoiceNote(context: Context, pcm: File, id: Long): DmMediaResult {
    val samples = withContext(Dispatchers.IO) { runCatching { pcm.readBytes() }.getOrNull() }
    if (samples == null || samples.isEmpty()) {
        return DmMediaResult.Refused("The recording couldn't be read back — nothing was sent.")
    }
    // The FILE's own length, not the ticker's — the tick is a UI clock and the
    // samples are the message.
    val ms = dmPcmMs(samples.size.toLong())
    if (ms < DM_VOICE_MIN_MS) {
        return DmMediaResult.Refused("That was too short to send — tap the mic and talk, then tap Stop.")
    }
    val wav = ByteArray(44 + samples.size)
    dmWavHeader(samples.size).copyInto(wav)
    samples.copyInto(wav, 44)
    dmSizeRefusal(wav.size, "That voice note")?.let { return DmMediaResult.Refused(it) }
    val heard = dmTranscribePcm(context, pcm)
    return DmMediaResult.Ok(
        StagedDmMedia(
            id = id, kind = "audio", contentType = "audio/wav", bytes = wav,
            name = "voice-note.wav", durationMs = dmWavDurationMs(wav).takeIf { it > 0 } ?: ms.toInt(),
            transcript = heard,
        ),
    )
}

/**
 * 🗣️ On-device transcript for recorded PCM, or null.
 *
 * Null is a real answer: `dmAttachmentSummary` reports "no transcript available"
 * rather than an empty utterance, and the audio sends either way. The transcript
 * is what lets the AGENT read a voice note (`read_messages`) instead of only
 * knowing one exists — but it is a bonus, and a bonus must never fail the message.
 *
 * ⚠️ Two hard platform limits, both load-bearing:
 *
 *  · `EXTRA_AUDIO_SOURCE` — the only way to transcribe a FILE — is API 33. Below
 *    that this returns null and the note is honestly transcript-less.
 *  · `createOnDeviceSpeechRecognizer` is not negotiable in place of the default
 *    one: a DM is between two people, and shipping its audio to Google's servers
 *    for a nicer transcript is not a trade this app gets to make quietly (iOS
 *    sets `requiresOnDeviceRecognition` for the same reason).
 */
private suspend fun dmTranscribePcm(context: Context, pcm: File): String? {
    if (Build.VERSION.SDK_INT < 33) return null
    if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) return null
    // Bounded for the same reason iOS races a 20s sleep: a recogniser that never
    // calls back would leave the chip spinning with the audio already sendable.
    val heard = withTimeoutOrNull(20_000L) {
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine { cont: CancellableContinuation<String?> ->
                val fd = runCatching {
                    ParcelFileDescriptor.open(pcm, ParcelFileDescriptor.MODE_READ_ONLY)
                }.getOrNull()
                if (fd == null) {
                    cont.resume(null)
                    return@suspendCancellableCoroutine
                }
                val recognizer = runCatching {
                    SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                }.getOrNull()
                if (recognizer == null) {
                    runCatching { fd.close() }
                    cont.resume(null)
                    return@suspendCancellableCoroutine
                }
                // One finish, whatever arrives: onResults and onError can BOTH
                // fire, and resuming a continuation twice is a crash.
                var done = false
                fun finish(value: String?) {
                    if (done) return
                    done = true
                    runCatching { recognizer.destroy() }
                    runCatching { fd.close() }
                    if (cont.isActive) cont.resume(value)
                }
                recognizer.setRecognitionListener(object : RecognitionListener {
                    override fun onResults(results: android.os.Bundle?) {
                        val text = results
                            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull()
                            ?.trim()
                        finish(text?.takeIf { it.isNotEmpty() })
                    }
                    override fun onError(error: Int) = finish(null)
                    override fun onReadyForSpeech(params: android.os.Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onPartialResults(partialResults: android.os.Bundle?) {}
                    override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
                })
                cont.invokeOnCancellation { finish(null) }
                val intent = android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(
                        RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                    )
                    // A voice note is a sentence someone said, read as text by
                    // the recipient AND the agent — without punctuation it
                    // arrives as one unreadable run-on.
                    putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, "quality")
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, fd)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, DM_VOICE_SAMPLE_RATE)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                }
                runCatching { recognizer.startListening(intent) }.onFailure { finish(null) }
            }
        }
    }
    return heard?.takeIf { it.isNotEmpty() }?.let { dmClipTranscript(it) }
}

// ── 🎤 the recorder ──────────────────────────────────────────────────────────

/**
 * `AudioRecord` → a headerless PCM file.
 *
 * Not `MediaRecorder`: the samples have to reach the recogniser as raw PCM
 * (`EXTRA_AUDIO_SOURCE`), and MediaRecorder only ever writes containers. Doing
 * it this way also means the WAV the recipient gets and the PCM the recogniser
 * reads are literally the same bytes, so a transcript can never describe
 * different audio than the one attached.
 */
internal class DmVoiceRecorder(private val context: Context) {
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private var file: File? = null

    @Volatile private var running = false
    @Volatile private var written: Long = 0L

    /** Elapsed ms from the samples actually captured (see [dmPcmMs]). */
    val elapsedMs: Long get() = dmPcmMs(written)

    /** null on success, or the refusal to show. */
    fun start(id: Long): String? {
        if (running) return null
        val minBuf = AudioRecord.getMinBufferSize(
            DM_VOICE_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) return "This phone can't record at the quality a voice note needs."
        val target = File(context.cacheDir, "dm-note-$id.pcm")
        runCatching { target.delete() }
        val rec = runCatching {
            AudioRecord(
                // VOICE_RECOGNITION, not MIC: it is the source with AGC/NS tuned
                // for speech and no post-processing that fights a recogniser.
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                DM_VOICE_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 4,
            )
        }.getOrNull()
        if (rec == null || rec.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { rec?.release() }
            return "The microphone isn't available right now — nothing was recorded."
        }
        if (runCatching { rec.startRecording() }.isFailure) {
            runCatching { rec.release() }
            return "Couldn't start recording — nothing was sent."
        }
        record = rec
        file = target
        written = 0L
        running = true
        val cap = dmVoicePcmCap()
        thread = Thread {
            val buf = ByteArray(minBuf)
            target.outputStream().buffered().use { out ->
                while (running) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n <= 0) break
                    // The cap is enforced HERE as well as by the UI ticker: a
                    // reader thread that outlived its ticker must not be able to
                    // produce a file whose only possible outcome is a refusal.
                    val room = (cap - written).toInt()
                    if (room <= 0) break
                    val take = minOf(n, room)
                    out.write(buf, 0, take)
                    written += take
                }
                runCatching { out.flush() }
            }
        }.also { it.start() }
        return null
    }

    /** Stops the mic and returns the PCM file, or null when there is nothing. */
    fun stop(): File? {
        if (!running && record == null) return null
        running = false
        runCatching { record?.stop() }
        runCatching { record?.release() }
        record = null
        // Joined, not abandoned: the writer thread holds the output stream, and
        // reading the file while it is still buffering is how a voice note loses
        // its last half-second.
        runCatching { thread?.join(2_000) }
        thread = null
        val out = file
        file = null
        return out?.takeIf { it.length() > 0 }
    }

    fun discard() {
        stop()?.let { f -> runCatching { f.delete() } }
    }
}

// ── uploading ────────────────────────────────────────────────────────────────

/**
 * Upload staged bytes and return the attachment to send. Throws with the
 * server's own reason on failure.
 *
 * Deliberately does NOT retry: the caller keeps the chip in a failed state with a
 * Retry button, so the user decides — an automatic retry of a multi-megabyte body
 * on a bad connection is how you get four copies in R2 and a composer that looks
 * stuck (same rule as `uploadDmMedia` on web and `DmComposer.upload` on iOS).
 */
internal suspend fun dmUploadMedia(app: TinyApp, m: StagedDmMedia): DmAttachment {
    val b64 = withContext(Dispatchers.Default) { Base64.encodeToString(m.bytes, Base64.NO_WRAP) }
    val res = app.api.postJson(
        "/api/media",
        JSONObject().put("data", b64).put("contentType", m.contentType),
    )
    val url = res.optString("url").takeIf { it.isNotEmpty() }
        // A 200 that carried no url is a failure, not an upload.
        ?: throw IllegalStateException(
            res.optString("error").takeIf { it.isNotEmpty() } ?: "the upload returned no url",
        )
    return DmAttachment(
        kind = m.kind, url = url, contentType = m.contentType, bytes = m.bytes.size,
        transcript = m.transcript, durationMs = m.durationMs, width = m.width, height = m.height,
    )
}

// ── the composer's staging area ──────────────────────────────────────────────

/**
 * Attachments staged for ONE peer's DM, and the recorder that makes one of them.
 *
 * Held by `DmThreadView` as `remember(login)` — the same key, for the same
 * reason, as the draft: state restores by slot position, so an unkeyed composer
 * would carry a photo meant for A into a send to B. A peer switch therefore
 * hands out a FRESH composer and the old one is simply dropped, which is also
 * what keeps a slow upload from landing in the wrong thread (iOS keys a single
 * long-lived composer by login to get the same guarantee).
 */
@Stable
internal class DmComposerState {
    val staged = mutableStateListOf<StagedDmMedia>()

    /** The last refusal, shown verbatim in the composer. Every one of them names
     *  the cause and the fix; replacing them with "couldn't attach that" throws
     *  away the actionable half. */
    var error by mutableStateOf<String?>(null)

    var recording by mutableStateOf(false)
        private set

    /** Drives the recording bar's counter. */
    var recordMs by mutableStateOf(0L)
        private set

    private var recorder: DmVoiceRecorder? = null
    private var seq = 0L

    fun nextId(): Long = ++seq

    val isFull: Boolean get() = staged.size >= DM_MAX_ATTACHMENTS

    /** The attachments a send may carry — only the uploaded ones. */
    fun ready(): List<DmAttachment> = staged.mapNotNull { it.attachment }

    fun blockingReason(): String? = dmBlockingReason(staged.map { it.state })

    fun clear() {
        staged.clear()
        error = null
    }

    fun remove(id: Long) {
        staged.removeAll { it.id == id }
        error = null
    }

    fun add(media: StagedDmMedia) {
        staged.add(media)
    }

    fun patch(id: Long, change: (StagedDmMedia) -> StagedDmMedia) {
        val at = staged.indexOfFirst { it.id == id }
        if (at >= 0) staged[at] = change(staged[at])
    }

    /** Room for [incoming] more, or the refusal that names both numbers. */
    fun roomRefusal(incoming: Int): String? = dmAttachmentRoom(staged.size, incoming)

    // ── recording ────────────────────────────────────────────────────────────

    /** Opens the mic. Returns the id the eventual voice note will carry, or null
     *  when it could not start (with [error] set). */
    fun startRecording(context: Context): Long? {
        if (recording) return null
        error = null
        roomRefusal(1)?.let { error = it; return null }
        val id = nextId()
        val rec = DmVoiceRecorder(context)
        rec.start(id)?.let { error = it; return null }
        recorder = rec
        recording = true
        recordMs = 0L
        return id
    }

    /** Called by the ticker; also how the cap is applied in the UI. */
    fun tick() {
        recordMs = recorder?.elapsedMs ?: 0L
    }

    /** Stops the mic. Returns the PCM file to turn into a note, or null when the
     *  take was discarded (or there was nothing). */
    fun stopRecording(discard: Boolean): File? {
        val rec = recorder ?: run {
            recording = false
            return null
        }
        recorder = null
        recording = false
        recordMs = 0L
        if (discard) {
            rec.discard()
            return null
        }
        return rec.stop()
    }
}

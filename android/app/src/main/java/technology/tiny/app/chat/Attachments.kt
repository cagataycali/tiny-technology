package technology.tiny.app.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/** A picked document awaiting send (Converse document block). */
data class PendingDoc(val name: String, val format: String, val base64: String)

/**
 * Attachments → Converse content blocks (server lib/file-attachments.ts parity):
 *  - images: ≤4, downscaled 1568px JPEG q0.85 → {"image":{"format":"jpeg","source":{"bytes":…}}}
 *  - documents: ≤3MB raw bytes → {"document":{"name":safe,"format":…,"source":{"bytes":…}}}
 * Names are sanitized (Anthropic rejects odd chars): drop extension, non
 * [A-Za-z0-9 \-()[\]] → '_', cap 200.
 */
object Attachments {
    const val MAX = 4
    const val MAX_DOC_BYTES = 3_000_000

    /**
     * Human-readable per-document cap for the "documents must be under …"
     * reject message — DERIVED from MAX_DOC_BYTES, the same fix 13bd170 made for
     * the batch cap. Web renders it MiB (÷1024², one decimal): 3_000_000 B →
     * "2.9MB", NOT the decimal-MB "3MB" this message used to hardcode. That was
     * an internal self-contradiction: the same string reports the file's size in
     * MiB (÷1_048_576), so a 3_000_001 B file was rejected with "is 2.9MB —
     * documents must be under 3MB" — a stated limit READING HIGHER than the file
     * it just refused, and 0.1MB above web's "2.9MB". Compute it so the copy
     * stays honest and self-updates if the cap moves. (web lib/file-attachments.ts:130
     * `(MAX_DOCUMENT_BYTES/1024/1024).toFixed(1)`.)
     */
    val MAX_DOC_LABEL: String =
        String.format(java.util.Locale.US, "%.1fMB", MAX_DOC_BYTES / 1_048_576.0)

    /**
     * Total decoded-payload cap across all staged attachments (server
     * MAX_PAYLOAD_BYTES, lib/file-attachments.ts; iOS MAX_ATTACHMENTS_PAYLOAD_BYTES).
     * base64 inflates 4/3× and history + system context ride the same request,
     * so the body must stay under the worker's ~4.5MB cap. Per-item caps
     * (3MB/doc, downscaled images) don't stop FOUR heavy picks from summing past
     * it — this is the batch guard the mobile clients were missing (only web had
     * it), so an over-budget set was caught server-side as a send failure instead
     * of up front in the composer.
     */
    const val MAX_PAYLOAD_BYTES = 3_500_000

    /**
     * Human-readable payload cap for the "exceeds … total" composer message —
     * DERIVED from MAX_PAYLOAD_BYTES, not hardcoded. Web and iOS both format it
     * as MiB (÷1024², one decimal): 3_500_000 B → "3.3MB", NOT "3.5MB". The
     * message here used to hardcode "3.5MB" (a decimal-MB reading of the same
     * constant), so Android told the user a limit 0.2MB higher than the other
     * two clients and than the real byte cap — someone trimming to "just under
     * 3.5MB" would still be rejected. Compute it so the copy stays correct and
     * self-updates if the cap ever moves. (web Chat.tsx:715
     * `(MAX_PAYLOAD_BYTES/1024/1024).toFixed(1)`; iOS Views.swift:2625.)
     *
     * Pin Locale.US on the format like MAX_DOC_LABEL (:43) and the doc-size
     * messages (:215/:223): the reference is web's `.toFixed(1)`, which ALWAYS
     * emits a dot decimal. Without a locale, String.format uses the device
     * default, so a comma-decimal locale (tr/de/fr) rendered "3,3MB" here while
     * the same cap read "3.3MB" on web and in this file's other size labels —
     * one client silently disagreeing with the others on the very number a user
     * trims their attachment set toward.
     */
    val MAX_PAYLOAD_LABEL: String =
        String.format(java.util.Locale.US, "%.1fMB", MAX_PAYLOAD_BYTES / 1_048_576.0)

    /** Longest edge for the MODEL-bound image — the canonical cross-client value
     *  (web MAX_IMAGE_DIM, lib/file-attachments.ts:33; iOS MAX_IMAGE_DIM,
     *  Attachments.swift). Anthropic's vision pipeline downscales past ~1568px
     *  anyway, so this is the sweet spot: larger just inflates the payload without
     *  buying the model detail. Android sat at 1280px, so a chart/receipt/screenshot
     *  reached the agent SOFTER + smaller from Android than from web — the natives
     *  had drifted to match each other, not the reference (iOS realigned cycle 68). */
    private const val MAX_DIM = 1568
    /** JPEG quality for the model-bound image (web JPEG_QUALITY 0.85,
     *  lib/file-attachments.ts:34; iOS MODEL_IMAGE_QUALITY 0.85). Android sat at 70
     *  — visibly softer than web's 85 on the same photo; screenshot text lost
     *  crispness the model then had to guess at. */
    private const val QUALITY = 85

    // Server DOC_EXT_TO_FORMAT (mime path first, then extension fallback).
    private val EXT_TO_FORMAT = mapOf(
        "pdf" to "pdf", "csv" to "csv", "doc" to "doc", "docx" to "docx",
        "xls" to "xls", "xlsx" to "xlsx", "html" to "html", "htm" to "html",
        "txt" to "txt", "md" to "md", "markdown" to "md", "json" to "json", "xml" to "xml",
    )
    private val MIME_TO_FORMAT = mapOf(
        "application/pdf" to "pdf",
        "text/csv" to "csv",
        "application/msword" to "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to "docx",
        "application/vnd.ms-excel" to "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to "xlsx",
        "text/html" to "html",
        "text/xml" to "xml", "application/xml" to "xml",
        "text/plain" to "txt", "text/markdown" to "md", "application/json" to "json",
    )

    /** SAF MIME filter for the document picker (superset of the format map). */
    val DOC_MIME_TYPES = arrayOf(
        "application/pdf", "text/csv", "text/plain", "text/markdown", "text/html",
        "application/json", "text/xml", "application/xml",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

    fun encode(context: Context, uri: Uri): String? = runCatching {
        // Buffer the source bytes once: we decode twice (bounds, then pixels) and
        // read EXIF, and a content:// stream isn't guaranteed re-openable/seekable.
        // A camera JPEG on disk is a few MB — trivial next to the decoded bitmap.
        val raw = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null

        // Pass 1: bounds only (no pixel allocation) → pick inSampleSize so the DECODED
        // bitmap lands near MAX_DIM. Decoding a Pixel 50MP shot full-res first would
        // allocate ~200MB of ARGB_8888 just to downscale it — an OOM waiting to happen
        // (iOS's UIImage pipeline is lazy about this; BitmapFactory is not). inSampleSize
        // downsamples AT decode time, so peak memory is bounded to the sampled size.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, MAX_DIM)
        }
        val decoded = BitmapFactory.decodeByteArray(raw, 0, raw.size, opts) ?: return null

        // Fine scale to the exact long-edge cap (inSampleSize only halves), then bake in
        // EXIF orientation — BitmapFactory ignores the flag, so a portrait phone photo
        // would otherwise reach the model rotated (iOS jpegData applies orientation for us).
        val scale = minOf(1f, MAX_DIM.toFloat() / maxOf(decoded.width, decoded.height, 1))
        val orientation = runCatching {
            ExifInterface(ByteArrayInputStream(raw)).getAttributeInt(
                ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL,
            )
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        val matrix = orientationMatrix(orientation).apply { if (scale < 1f) preScale(scale, scale) }
        val bitmap = if (matrix.isIdentity) decoded
            else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)

        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
        Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrNull()

    /** Long-edge cap + JPEG quality for the persisted bubble/history thumbnail (iOS 96px q0.6). */
    private const val THUMB_DIM = 96
    private const val THUMB_QUALITY = 60

    /**
     * A tiny 96px JPEG thumbnail (base64) from an already-encoded full-res image
     * base64 — the durable preview the user bubble + history render (iOS PendingAttachment
     * .thumb). Full payloads never persist (they'd bloat chat-history-<tiny>.json); only
     * these ~few-KB thumbs do. Returns null if the input can't be decoded (the bubble then
     * just shows text — never a broken tile), so it's safe on any stored string.
     */
    fun thumbnail(fullBase64: String): String? = runCatching {
        val bytes = Base64.decode(fullBase64, Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, THUMB_DIM)
        }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
        // The full-res base64 already baked in EXIF orientation (see encode), so the thumb
        // just needs the fine downscale to the exact long-edge cap.
        val scale = minOf(1f, THUMB_DIM.toFloat() / maxOf(decoded.width, decoded.height, 1))
        val bitmap = if (scale < 1f) {
            val m = Matrix().apply { preScale(scale, scale) }
            Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, m, true)
        } else decoded
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, THUMB_QUALITY, out)
        Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrNull()

    /** Largest power-of-two sample size keeping the sampled long edge ≥ [target]. */
    private fun sampleSizeFor(w: Int, h: Int, target: Int): Int {
        if (w <= 0 || h <= 0) return 1
        var sample = 1
        var longEdge = maxOf(w, h)
        while (longEdge / 2 >= target) { longEdge /= 2; sample *= 2 }
        return sample
    }

    /** EXIF orientation → transform matrix (rotation + mirror); identity for NORMAL. */
    private fun orientationMatrix(orientation: Int): Matrix = Matrix().apply {
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

    sealed class DocResult {
        data class Ok(val doc: PendingDoc) : DocResult()
        data class Err(val message: String) : DocResult()
    }

    /** Read a picked document, resolve its format, size-check, base64-encode. */
    fun encodeDocument(context: Context, uri: Uri): DocResult {
        val (displayName, size) = queryNameAndSize(context, uri)
        val mime = context.contentResolver.getType(uri)
        val format = formatFor(mime, displayName)
            ?: return DocResult.Err("${displayName ?: "file"} — unsupported document type")
        if (size != null && size > MAX_DOC_BYTES) {
            return DocResult.Err(
                "${displayName ?: "file"} is ${String.format(java.util.Locale.US, "%.1f", size / 1_048_576.0)}MB — documents must be under $MAX_DOC_LABEL",
            )
        }
        val bytes = runCatching {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        }.getOrNull() ?: return DocResult.Err("Couldn't read ${displayName ?: "file"} — unsupported or corrupted")
        if (bytes.size > MAX_DOC_BYTES) {
            return DocResult.Err(
                "${displayName ?: "file"} is ${String.format(java.util.Locale.US, "%.1f", bytes.size / 1_048_576.0)}MB — documents must be under $MAX_DOC_LABEL",
            )
        }
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        return DocResult.Ok(PendingDoc(sanitizeName(displayName), format, b64))
    }

    /** Server getDocumentFormat: MIME map first, extension fallback. internal so the
     *  resolution order (a mislabeled .pdf served as octet-stream still resolves by
     *  extension) is JVM-unit-testable. */
    internal fun formatFor(mime: String?, name: String?): String? {
        MIME_TO_FORMAT[mime]?.let { return it }
        val ext = name?.substringAfterLast('.', "")?.lowercase().orEmpty()
        return EXT_TO_FORMAT[ext]
    }

    /** Server buildContentBlocks name rule: strip ext, non-safe→_, cap 200, fallback.
     *  Uses the SAME regex as web (`\.[^.]+$`) — the prior substringBeforeLast diverged
     *  on a trailing-dot name ("archive." → web "archive_" but old Android "archive"),
     *  and this string is sent to Anthropic verbatim so it must match byte-for-byte.
     *  internal for parity tests. */
    internal fun sanitizeName(raw: String?): String {
        val base = (raw ?: "document").replace(Regex("""\.[^.]+$"""), "")
        val cleaned = base.replace(Regex("[^a-zA-Z0-9\\s\\-()\\[\\]]"), "_").take(200)
        return cleaned.ifBlank { "document" }
    }

    private fun queryNameAndSize(context: Context, uri: Uri): Pair<String?, Long?> {
        var name: String? = null
        var size: Long? = null
        runCatching {
            context.contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
        }
        return name to size
    }

    /**
     * The multi-select cap decision: how many of a picker's [pickedCount] items fit
     * given [pendingCount] already staged, and whether any overflowed. The photo picker's
     * maxItems is the TOTAL cap (blind to what's already pending), so a pick can overshoot
     * the free slots — [ClampResult.accept] is the count to keep and [ClampResult.overflowed]
     * drives the "up to MAX attachments" message. Pure so the arithmetic (free = MAX −
     * pending, take(free)) is unit-tested once instead of living only inline in the picker
     * callback. iOS parity: AttachmentCodec.routeDrop's `capacity` walk + PhotosPicker
     * maxSelectionCount = free slots. [max] injectable for tests; defaults to [MAX].
     */
    data class ClampResult(val accept: Int, val overflowed: Boolean) {
        /** No slots left at all — the caller shows the cap message and ingests nothing. */
        val full: Boolean get() = accept == 0
    }

    fun clampPicks(pendingCount: Int, pickedCount: Int, max: Int = MAX): ClampResult {
        val free = (max - pendingCount).coerceAtLeast(0)
        val accept = pickedCount.coerceIn(0, free)
        // Overflow only counts when something was actually dropped — an empty pick,
        // or a pick that fits exactly, never reads as "you hit the cap".
        return ClampResult(accept = accept, overflowed = pickedCount > free)
    }

    /**
     * Decoded byte size of a base64 model payload (server `base64Bytes`, iOS
     * `payloadBytes`): base64 inflates 4/3×, so the raw bytes are length × 0.75.
     * The 96px history thumb is never sent, so it doesn't count here.
     */
    fun payloadBytes(base64: String): Int = (base64.length * 0.75).toInt()

    /** Sum of the model-bound payloads for a staged image/doc set (server `attachmentsPayloadBytes`). */
    fun payloadBytesOf(imagesBase64: List<String>, docs: List<PendingDoc>): Int =
        imagesBase64.sumOf { payloadBytes(it) } + docs.sumOf { payloadBytes(it.base64) }

    /**
     * Whether adding `addBase64` to the already-staged set stays within
     * MAX_PAYLOAD_BYTES — the batch total guard mirroring iOS `appendAttachment`.
     * Pure so the composer can gate an add up front with a "remove some first"
     * message instead of letting the worker reject the whole send.
     */
    fun fitsPayload(
        imagesBase64: List<String>,
        docs: List<PendingDoc>,
        addBase64: String,
        max: Int = MAX_PAYLOAD_BYTES,
    ): Boolean = payloadBytesOf(imagesBase64, docs) + payloadBytes(addBase64) <= max

    fun blocks(text: String, imagesBase64: List<String>, docs: List<PendingDoc> = emptyList()): JSONArray {
        val arr = JSONArray()
        arr.put(JSONObject().put("text", text.ifBlank { "Have a look." }))
        imagesBase64.take(MAX).forEach { b64 ->
            arr.put(
                JSONObject().put(
                    "image",
                    JSONObject()
                        .put("format", "jpeg")
                        .put("source", JSONObject().put("bytes", b64)),
                )
            )
        }
        docs.forEach { doc ->
            arr.put(
                JSONObject().put(
                    "document",
                    JSONObject()
                        .put("name", doc.name)
                        .put("format", doc.format)
                        .put("source", JSONObject().put("bytes", doc.base64)),
                )
            )
        }
        return arr
    }
}

package technology.tiny.app.tools

import android.graphics.Bitmap
import android.util.Base64
import android.util.Log
import technology.tiny.app.TinyApp
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Screenshot — network plumbing for the agent's `screenshot` tool (iOS
 * Screenshot.swift parity, docs/use-device-screenshot-scoping-2026-07-23.md).
 * generate_image's twin: a ROUND-TRIP device tool. The frame is grabbed by
 * [ScreenshotService] (MediaProjection), then this object encodes it to JPEG,
 * uploads ONCE to /api/media (R2 → stable URL), and posts the outcome to
 * /api/chat/tool-result — where the chat route's callback is polling to hand
 * the pixels back to the MODEL. The agent literally sees the user's screen.
 *
 * Product decisions mirror iOS: the WHOLE screen, and consent is asked EVERY
 * capture. On Android the system MediaProjection dialog IS that per-capture
 * consent (a full "Start recording with tiny?" prompt showing the recording
 * indicator) — cancelling it posts {denied:true} without ever entering the
 * capture path (see [ScreenshotConsentActivity]).
 *
 * Every path posts SOMETHING (success or a friendly error): a silent failure
 * would strand the server callback until its 90s timeout.
 */
object Screenshot {
    private const val TAG = "TinyScreenshot"

    /**
     * Encode the captured frame, upload it, and post the result. `bitmap` is
     * null when the projection produced no usable frame — surfaced as a
     * friendly error so the model can explain instead of the turn timing out.
     */
    suspend fun deliver(app: TinyApp, toolUseId: String, bitmap: Bitmap?) {
        try {
            if (bitmap == null) {
                postResult(app, toolUseId, JSONObject().put("ok", false).put(
                    "error",
                    "Screen capture started but no frame arrived — try again.",
                ))
                app.emitScreenshot(toolUseId, "")
                return
            }
            val jpeg = encode(bitmap, maxSide = 1600, quality = 80)
            if (jpeg == null) {
                postResult(app, toolUseId, JSONObject().put("ok", false).put(
                    "error", "Captured the screen but couldn't encode the image.",
                ))
                app.emitScreenshot(toolUseId, "")
                return
            }
            val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
            val up = runCatching {
                app.api.postJson(
                    "/api/media",
                    JSONObject().put("data", b64).put("contentType", "image/jpeg"),
                )
            }.getOrElse { e ->
                postResult(app, toolUseId, JSONObject().put("ok", false).put(
                    "error", "Screen was captured but the upload failed: ${e.message}",
                ))
                app.emitScreenshot(toolUseId, "")
                return
            }
            val url = up.optString("url").takeIf { it.isNotEmpty() }
            if (url == null) {
                val why = up.optString("error").takeIf { it.isNotEmpty() } ?: "no url in response"
                postResult(app, toolUseId, JSONObject().put("ok", false).put(
                    "error", "Screen was captured but the upload failed: $why",
                ))
                app.emitScreenshot(toolUseId, "")
                return
            }
            postResult(app, toolUseId, JSONObject().put("ok", true).put("url", url).put("format", "jpeg"))
            // Surface the same still to the USER in-chat (the model gets the
            // bytes over SSE; the user should see what they approved too).
            app.emitScreenshot(toolUseId, url)
        } catch (t: Throwable) {
            Log.w(TAG, "deliver failed", t)
            postResult(app, toolUseId, JSONObject().put("ok", false).put(
                "error", t.message ?: "screen capture failed on the device",
            ))
            app.emitScreenshot(toolUseId, "")
        }
    }

    /**
     * Post a user decline as a first-class {denied:true} outcome so the model
     * treats it as "the user said no", not a retryable error (iOS postDenied /
     * web `p.denied` parity). Called when the system consent dialog is cancelled.
     */
    suspend fun postDenied(app: TinyApp, toolUseId: String) {
        postResult(app, toolUseId, JSONObject().put("denied", true))
        // Signal in-process waiters too (voice bridge): "" = denied/failed —
        // without this a declined capture left the call's tool turn hanging.
        app.emitScreenshot(toolUseId, "")
    }

    /**
     * The user granted the projection, but after the asking request died
     * (ScreenshotConsentActivity.CONSENT_WINDOW_MS). Nothing was captured.
     *
     * Reported as its own outcome rather than `{denied:true}` — they said yes,
     * and recording a decline they never made would be a lie the model repeats
     * back to them. iOS parity: Screenshot.postExpired.
     */
    suspend fun postExpired(app: TinyApp, toolUseId: String) {
        postResult(
            app, toolUseId,
            JSONObject()
                .put("ok", false)
                .put("error", "the capture request expired before the user answered — nothing was captured"),
        )
        // Same in-process release as a decline, or a voice call's tool turn hangs
        // for the full timeout on a capture that is never coming.
        app.emitScreenshot(toolUseId, "")
    }

    private suspend fun postResult(app: TinyApp, toolUseId: String, payload: JSONObject) {
        // Best-effort: a failed post degrades to the server's 90s timeout — worse
        // UX, still honest. The mailbox row stays tiny (the image is already in R2).
        runCatching {
            app.api.postJson(
                "/api/chat/tool-result",
                JSONObject().put("toolUseId", toolUseId).put("payload", payload.toString()),
            )
        }.onFailure { Log.w(TAG, "tool-result post failed", it) }
    }

    /**
     * Downscale (cap the long side, a screenshot is already screen-sized) + JPEG
     * — a private copy of the iOS helper so uploads stay small.
     */
    private fun encode(bitmap: Bitmap, maxSide: Int, quality: Int): ByteArray? = runCatching {
        val side = maxOf(bitmap.width, bitmap.height)
        val scaled = if (side > maxSide) {
            val scale = maxSide.toFloat() / side
            Bitmap.createScaledBitmap(
                bitmap,
                (bitmap.width * scale).toInt().coerceAtLeast(1),
                (bitmap.height * scale).toInt().coerceAtLeast(1),
                true,
            )
        } else bitmap
        ByteArrayOutputStream().use { out ->
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
            out.toByteArray()
        }
    }.getOrNull()
}

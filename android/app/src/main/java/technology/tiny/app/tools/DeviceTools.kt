package technology.tiny.app.tools

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The vibrate waveform for a named pattern (iOS Haptic.events parity), as the
 * (timings, amplitudes) pair VibrationEffect.createWaveform consumes — repeated
 * [times] and sliced to a 15s ceiling. Pure arithmetic (no android.* deps) so
 * the wait/pulse phase alignment and the escalate/wave intensity curves can be
 * tested off-device; the impure vibrator.vibrate() call stays in [DeviceTools].
 *
 * Even indices are WAITS (amplitude 0), odd indices are PULSES — a lockstep the
 * two documented regressions hinge on: (1) heartbeat's block is odd-length (5),
 * so amplitude keyed off the GLOBAL flattened index inverted the second rep's
 * phase (gap buzzed, pulses silent) — it must key off the LOCAL block index;
 * (2) escalate/wave carry a per-pulse intensity CURVE (iOS s*(0.25+0.5t) ramp /
 * s*|sin(t/2·π)| swell), not a flat amplitude, or the whole motif is lost.
 */
internal fun vibrateWaveform(pattern: String, times: Int, intensity: Double): Pair<LongArray, IntArray> {
    val amp = (intensity * 255).toInt().coerceIn(1, 255)
    // A pulse amplitude scaled by a per-pulse multiplier, floored at 1 so a curve
    // pulse never collapses to 0 (which the waveform would read as a silent wait).
    fun ampAt(mult: Double) = (intensity * mult * 255).toInt().coerceIn(1, 255)
    // A pulse train carrying a per-pulse amplitude CURVE (one rep): count pulses of
    // pulseMs each, gapMs apart, with mult(i) shaping the strength. Leads with a
    // 0ms wait so the wait/pulse phase matches the fixed patterns below.
    fun curve(count: Int, pulseMs: Long, gapMs: Long, mult: (Int) -> Double): Pair<LongArray, IntArray> {
        val t = ArrayList<Long>(); val a = ArrayList<Int>()
        t.add(0L); a.add(0)
        repeat(count) { i -> t.add(pulseMs); a.add(ampAt(mult(i))); t.add(gapMs); a.add(0) }
        return t.toLongArray() to a.toIntArray()
    }
    // One rep as (timings, amplitudes) in lockstep. escalate & wave carry an
    // intensity CURVE (iOS Haptic parity — escalate ramps 0.25→~0.93, wave swells
    // on a sine); Android used to hold amplitude FLAT across their pulses and vary
    // only the timing, so on a device with amplitude control the ramp/swell — the
    // whole point of those two motifs — was lost. The rest pulse at a constant amp.
    val (baseT, baseA) = when (pattern) {
        // iOS: stride(0.0, to 1.5, by 0.15) → 10 buzzes ~0.14s, intensity s*(0.25+0.5t).
        "escalate" -> curve(10, 140, 10) { 0.25 + 0.5 * (0.15 * it) }
        // iOS: stride(0.0, to 2.0, by 0.2) → 10 buzzes ~0.19s, intensity max(0.15, s*|sin(t/2·π)|).
        "wave" -> curve(10, 190, 10) {
            maxOf(0.15, kotlin.math.abs(kotlin.math.sin((0.2 * it) / 2.0 * Math.PI)))
        }
        else -> {
            val one: LongArray = when (pattern) {
                "double" -> longArrayOf(0, 60, 80, 60)
                "success" -> longArrayOf(0, 40, 60, 90)
                "warning" -> longArrayOf(0, 120, 80, 120)
                "error" -> longArrayOf(0, 200, 100, 200, 100, 200)
                "heartbeat" -> longArrayOf(0, 60, 120, 90, 500)
                "sos" -> longArrayOf(0, 80, 80, 80, 80, 80, 200, 250, 80, 250, 80, 250, 200, 80, 80, 80, 80, 80)
                "long" -> longArrayOf(0, 600)
                else -> longArrayOf(0, 50) // tap
            }
            // Amplitude tracks the LOCAL index within the block (even = wait/0, odd =
            // pulse/amp), NOT the global flattened index: that only stays aligned when
            // every block is EVEN-length, but `heartbeat` is length 5 (odd), so with
            // times≥2 the second block's phase inverted (gap buzzed, pulses silent).
            one to IntArray(one.size) { if (it % 2 == 0) 0 else amp }
        }
    }
    val timings = ArrayList<Long>()
    val amps = ArrayList<Int>()
    repeat(times) { i ->
        baseT.forEachIndexed { j, t ->
            if (i > 0 && j == 0) {
                timings.add(240); amps.add(0) // inter-rep gap is a wait → silent
            } else {
                timings.add(t)
                amps.add(baseA[j])
            }
        }
    }
    // 15s ceiling (iOS Haptic parity) — slice timings + amps to the same length.
    var total = 0L
    val over = timings.indexOfFirst { total += it; total > 15_000 }
    val size = if (over < 0) timings.size else over
    return timings.subList(0, size).toLongArray() to amps.subList(0, size).toIntArray()
}

// The open_url scheme allowlist (iOS DeviceTools.swift:50 parity) — the agent can
// NOT deep-link this phone into arbitrary apps. https/http/spotify/music pass
// through; iOS also lists `maps` + `shortcuts`. `geo:` is Android's native map
// scheme, so a `maps:` URL is TRANSLATED to `geo:` rather than dropped; `shortcuts:`
// is an iOS-only scheme with no Android analog, so it's (correctly) not allowlisted.
// `mailto:` (use_device P4): "open the mail app on my phone" was the canonical
// confabulated success — the scheme was dropped here while the model claimed 📬.
// ACTION_VIEW on mailto: opens the default mail app's compose, which IS the ask.
private val OPEN_URL_SCHEMES = setOf("https", "http", "geo", "spotify", "music", "mailto")

/**
 * Resolve an agent-supplied open_url into the URL string to actually launch, or
 * null when the scheme isn't allowlisted (the security boundary — extracted from
 * the impure openUrl so the allowlist + maps→geo translation are testable off the
 * Uri parser). [scheme] is the parsed scheme of [raw] (null if unparseable).
 */
internal fun resolveOpenUrl(scheme: String?, raw: String): String? = when {
    scheme == null -> null
    scheme == "maps" -> "geo:" + raw.substringAfter(':') // Android's native map scheme
    scheme in OPEN_URL_SCHEMES -> raw
    else -> null
}

/**
 * The cap the model is TOLD about, so it is the cap enforced here.
 *
 * `copyToClipboardTool`'s zod schema says `.max(10_000)` — but a zod schema on a
 * tool spec is only DESCRIBED to the model, never applied to the args a client
 * receives. Web learned this (`lib/chat/clipboard-write.ts`: "the limit was a
 * claim, never a check") and iOS enforces it as `text.prefix(10_000)`. This is
 * the third copy of one number, which is why it is a named constant with a pin
 * on it rather than a literal in the `when`.
 */
const val CLIPBOARD_MAX = 10_000

/**
 * What may reach the system clipboard, and what to tell the model afterwards.
 *
 * ⚠️ The clipboard is the widest sink this app hands the agent: it is the only
 * one whose value the user then pastes into ANOTHER program, so a wrong value
 * here is spent somewhere this code will never see. Web states that in
 * `lib/chat/clipboard-write.ts` and enforces four rules; Android enforced none
 * of them, and `optString` makes two of the four WORSE here than they were on
 * the web:
 *
 *  1. **A blank `text` ERASED the user's clipboard and was audited as success.**
 *     `input.optString("text")` returns `""` for an absent key, and the old
 *     `if (text.isNotEmpty())` skipped the write — but `handleUnsafe` then fell
 *     through to `Outcome.RAN`, so `DeviceActionAudit` told the proxied model
 *     the copy happened. That is this file's own documented defect class ("a
 *     tool that did nothing must not be audited as having run"), on the one arm
 *     where the no-op is indistinguishable from the destructive case.
 *  2. **Non-strings were COERCED, not refused** — and measured in the shipping
 *     `org.json` bytecode, not assumed: `optString` calls `Object.toString()` on
 *     whatever it finds. So `{"text": {"a": 1}}` puts the literal `{"a":1}` on
 *     the clipboard and `{"text": 42}` puts `42`. iOS's `as? String` refuses
 *     both; JS coerced them to `"[object Object]"`. Every client had a different
 *     wrong answer, so the fix has to be a shared RULE, not three guards.
 *  3. **The cap was never enforced** (see [CLIPBOARD_MAX]).
 *
 * Rule 4 — the visible confirmation naming what landed — is web-only by design:
 * it has a toast layer and this rail is fired from a relay/tool callback with no
 * UI. What crosses instead is [ClipboardWrite.note], which the model reads.
 *
 * ⚠️ Accepted text is NOT trimmed. Leading/trailing whitespace is meaningful in
 * the things people copy (an indented code block, the trailing newline before a
 * paste into a terminal); trimming is only how blankness is DETECTED.
 */
sealed interface ClipboardWrite {
    /** Safe to write. [text] is what to place — never the raw arg. */
    data class Allowed(val text: String, val truncated: Boolean) : ClipboardWrite {
        /**
         * What the model is told. A truncated write MUST say so, or the agent
         * goes on to describe the whole string as copied.
         */
        val note: String get() =
            if (truncated) {
                "copied, but truncated to the first $CLIPBOARD_MAX characters — " +
                    "tell the user the rest was not copied"
            } else {
                "copied to the user's clipboard"
            }
    }

    /** Nothing was written. [error] is FOR THE MODEL — it becomes the tool result. */
    data class Refused(val error: String) : ClipboardWrite
}

/**
 * A one-line, bounded rendering of what landed on the clipboard.
 *
 * Newlines collapse to spaces: a toast is one line, and a multi-line preview
 * would either clip mid-height or shove the rest of the UI around. Truncation is
 * marked with an ellipsis so a "…" is distinguishable from the real end of a
 * short string.
 */
internal fun clipboardPreview(text: String, max: Int = 48): String {
    val flat = text.replace(Regex("\\s+"), " ").trim()
    return if (flat.length > max) flat.take(max) + "…" else flat
}

/**
 * The user-facing confirmation, and web's fourth rule arriving here.
 *
 * ⚠️ It QUOTES the preview rather than saying "Copied!", because the risk this
 * toast exists for is a SUBSTITUTION — the tiny copying its own wallet address
 * over the one the user meant — and only the value can surface that. A silent
 * replacement is exactly what makes a substituted address dangerous, so this is
 * the user's one chance to notice before they paste it somewhere this code will
 * never see.
 */
internal fun clipboardConfirmToast(text: String, truncated: Boolean): String {
    val shown = "📋 Copied “${clipboardPreview(text)}”"
    // Grouped thousands, matching web's toLocaleString('en-US') — "10000
    // characters" reads as a machine's number in a sentence meant for a person.
    return if (truncated) "$shown — trimmed to ${"%,d".format(CLIPBOARD_MAX)} characters" else shown
}

/**
 * Decide whether the agent's `text` argument may be placed on the clipboard.
 *
 * Takes the raw `Any?` off `JSONObject.opt` rather than a `String`, because the
 * type confusion IS one of the defects: reading it as a String first is what
 * `optString` does, and that is where the coercion happens.
 *
 * ⚠️ Blank input is REFUSED rather than written, because an empty write is
 * DESTRUCTIVE — it replaces whatever the user had (a wallet address they were
 * mid-paste with, a password out of a manager) with nothing. There is no "clear
 * the clipboard" capability in this tool's contract, so a blank `text` is always
 * a mistake, and the refusal says so because the model reads it.
 */
internal fun decideClipboardWrite(raw: Any?): ClipboardWrite = when {
    // JSONObject.NULL is a real object whose toString() is "null" — the exact
    // shape that would otherwise put the four characters `null` on the clipboard.
    raw == null || raw == JSONObject.NULL -> ClipboardWrite.Refused(
        "refused: no text was given — nothing was copied, the clipboard still holds what the user had",
    )
    raw !is String -> ClipboardWrite.Refused(
        "refused: text must be a string — nothing was copied, the clipboard still holds what the user had",
    )
    raw.isBlank() -> ClipboardWrite.Refused(
        "refused: text was blank, and writing it would have ERASED whatever the user had on their " +
            "clipboard — call this again with the actual text",
    )
    raw.length > CLIPBOARD_MAX -> ClipboardWrite.Allowed(raw.take(CLIPBOARD_MAX), truncated = true)
    else -> ClipboardWrite.Allowed(raw, truncated = false)
}

/**
 * Client-executed device tools off beforeToolCallEvent (iOS DeviceTools/Haptic/
 * Torch parity). The agent REALLY buzzes/flashes/etc. this phone.
 */
class DeviceTools(
    private val context: Context,
    // Agent sounds stay silent during quiet hours, matching iOS
    // (DeviceTools.swift gates play_sound on Config.isQuietNow).
    private val quietProvider: () -> Boolean = { false },
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // The single in-flight torch control job (iOS Torch.task parity). A new
    // flashlight command cancels the previous one so a stale blink loop's
    // torch-OFF can't land AFTER a newer "on" command's torch-ON and kill the
    // light it just lit. Null once nothing is scheduled.
    @Volatile
    private var torchJob: kotlinx.coroutines.Job? = null

    // Screen brightness is a per-WINDOW attribute on Android (unlike iOS's global
    // UIScreen.brightness), so the foreground Activity registers a setter here in
    // onStart and clears it in onStop. Null when no window is visible → the tool
    // no-ops (brightness only has meaning for a foreground window anyway).
    @Volatile
    var brightnessController: ((Float) -> Unit)? = null

    /**
     * What actually became of one device-tool attempt.
     *
     * A single Boolean could not carry this, and that is precisely how the relay
     * audit came to vouch for things that never happened: `handle` answered "do
     * I own this name?" while `DeviceActionAudit.toolLine` asked "did it run?".
     * Three distinct facts were collapsed onto `true`, and the web agent — whose
     * only ground truth is that audit line — read every one of them as success.
     */
    enum class Outcome {
        /** It ran. */
        RAN,
        /** Not a tool this class owns (the relay then says so honestly). */
        UNKNOWN_TOOL,
        /** Owned, attempted, and it THREW — the case that used to read as RAN. */
        FAILED,
        /** Owned and deliberately suppressed by quiet hours, not broken. */
        SILENCED_QUIET,
    }

    companion object {
        /** Every tool name this class owns (iOS `DeviceTools.names` parity). */
        val NAMES = setOf(
            "vibrate", "flashlight", "copy_to_clipboard", "set_brightness",
            "play_sound", "open_url", "schedule_alert", "cancel_alerts",
        )

        /**
         * The outcome decidable WITHOUT touching hardware — extracted pure so it
         * is testable off a `Context`, the pattern `resolveOpenUrl` and
         * `vibrateWaveform` already set in this file.
         *
         * Returns null when the answer depends on execution (the caller must
         * actually run it and report RAN or FAILED). The two it does decide are
         * exactly the two that regressed: an unowned name, and `play_sound`
         * muted by quiet hours — where the room stays silent and reporting "ran"
         * tells a user a sound played that they could not hear.
         */
        fun earlyOutcome(name: String, quiet: Boolean): Outcome? = when {
            name !in NAMES -> Outcome.UNKNOWN_TOOL
            name == "play_sound" && quiet -> Outcome.SILENCED_QUIET
            else -> null
        }
    }

    /**
     * Run one device tool and say what became of it (iOS `handle` parity — it
     * returns the same enum, `@discardableResult`, so callers that only fire
     * the tool can ignore this exactly as they always have).
     *
     * ⚠️ This used to return a Boolean, and the relay path fed that straight
     * into `DeviceActionAudit`, whose whole job is to stop the proxied model
     * claiming "Mail app opened 📬" over a no-op. The catch branch answered
     * `true` — so a tool that THREW (no torch on this device, a revoked vibrate
     * permission, a clipboard denied to a background app) was logged as a
     * warning nobody reads and audited as "ran on the phone". The reply stream
     * still must not abort, which is why the catch exists at all; what changes
     * is that it no longer lies about it.
     *
     * There is deliberately NO Boolean convenience beside this: `Outcome` has
     * four cases and any two-valued summary has to pick which pair of them to
     * blur, which is the exact bug above wearing a smaller hat.
     */
    fun handle(name: String, input: JSONObject): Outcome = runCatching {
        // A failing device tool must NEVER abort the reply stream.
        handleUnsafe(name, input)
    }.getOrElse { t ->
        Log.w("TinyTools", "$name failed: ${t.message}")
        Outcome.FAILED
    }

    private fun handleUnsafe(name: String, input: JSONObject): Outcome {
        // ⚠️ The SAME decision the pure helper makes, not a second copy of it —
        // an unowned name and a quiet-hours mute are settled here, before any
        // system service is touched, so what is TESTED is what RUNS.
        earlyOutcome(name, quietProvider())?.let { return it }
        when (name) {
            "vibrate" -> vibrate(
                input.optString("pattern", "tap"),
                input.optInt("times", 1).coerceIn(1, 20),
                input.optDouble("intensity", 1.0).coerceIn(0.1, 1.0),
            )
            "flashlight" -> flashlight(
                input.optString("mode", "blink"),
                input.optInt("times", 5).coerceIn(1, 30),
                input.optDouble("seconds", 10.0).coerceIn(0.5, 60.0),
            )
            // ⚠️ `input.opt`, NOT `optString`: reading it as a String is what
            // COERCES a number or an object into one (see decideClipboardWrite).
            // A refusal writes nothing at all — the user keeps what they had.
            "copy_to_clipboard" -> {
                val write = decideClipboardWrite(input.opt("text"))
                if (write is ClipboardWrite.Allowed) {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("tiny", write.text))
                }
            }
            "set_brightness" -> {
                // Server schema: { level: 0..1 } (iOS sets UIScreen.brightness).
                val level = input.optDouble("level", -1.0)
                if (level >= 0) brightnessController?.invoke(level.coerceIn(0.0, 1.0).toFloat())
            }
            "play_sound" -> {
                // Quiet hours already returned SILENCED_QUIET above (iOS parity).
                playSound(
                    // Schema default is "alert", NOT chime (client-side.ts:132, iOS DeviceTools.swift:33).
                    input.optString("sound").takeIf { it.isNotEmpty() } ?: "alert",
                    // seconds: keep repeating for N seconds (default: play once). iOS reps = min(s,30)/1.5.
                    input.optDouble("seconds", 0.0),
                )
            }
            "open_url" -> openUrl(input.optString("url"))
            "schedule_alert" -> scheduleAlert(
                // Server schema (client-side.ts): title (required) + optional body,
                // NOT a `message` field. iOS reads the same title/body pair.
                input.optString("title").takeIf { it.isNotEmpty() } ?: "⏰ tiny alert",
                input.optString("body"),
                // Fractional minutes are legal (min 0.2 = 12s); optInt would floor 0.5→0.
                input.optDouble("in_minutes", 1.0).coerceIn(0.2, 1440.0),
            )
            "cancel_alerts" -> AlertStore.scrubAll(context) // cancel the jobs + drop the sidecar records
            else -> return Outcome.UNKNOWN_TOOL
        }
        Log.i("TinyTools", "ran $name")
        return Outcome.RAN
    }

    // -- vibrate: named patterns as (timings, amplitudes) --

    private fun vibrate(pattern: String, times: Int, intensity: Double) {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        val (timings, amps) = vibrateWaveform(pattern, times, intensity)
        vibrator.vibrate(VibrationEffect.createWaveform(timings, amps, -1))
    }

    // -- flashlight --

    private fun flashlight(mode: String, times: Int, seconds: Double) {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val camId = cm.cameraIdList.firstOrNull {
            cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: return
        fun set(on: Boolean) = runCatching { cm.setTorchMode(camId, on) }
        // Cancel the prior control job FIRST (iOS Torch.run's task?.cancel()) — a
        // stale blink loop must not toggle the torch under a newer command.
        torchJob?.cancel()
        when (mode) {
            "off" -> { set(false); torchJob = null }
            "on" -> {
                set(true)
                val cap = (seconds.coerceIn(0.5, 60.0) * 1000).toLong()
                torchJob = scope.launch {
                    delay(cap) // auto-off ≤60s so a forgotten torch can't cook the battery
                    if (isActive) set(false)
                }
            }
            else -> { // "blink"
                torchJob = scope.launch {
                    // Check cancellation BEFORE every set(): a cancelled delay resumes
                    // immediately, and this loop's set(false) landing after a newer "on"
                    // would kill the torch that command just lit (iOS Torch blink guard).
                    repeat(times) {
                        if (!isActive) return@launch
                        set(true); delay(250)
                        if (!isActive) return@launch
                        set(false); delay(250)
                    }
                    if (isActive) set(false)
                }
            }
        }
    }

    private fun playSound(sound: String, seconds: Double) {
        val tone = when (sound) {
            "alert" -> ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD
            "alarm" -> ToneGenerator.TONE_CDMA_EMERGENCY_RINGBACK
            "tick" -> ToneGenerator.TONE_PROP_BEEP
            else -> ToneGenerator.TONE_PROP_ACK // chime
        }
        runCatching {
            val gen = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80)
            gen.startTone(tone, 400)
            // seconds > 1 → repeat every 1.5s for min(seconds,30)/1.5 reps (iOS DeviceTools.swift:93-101),
            // then release. Otherwise a single tone (release after it finishes).
            if (seconds > 1) {
                val reps = (minOf(seconds, 30.0) / 1.5).toInt()
                scope.launch {
                    repeat(reps) {
                        delay(1500)
                        runCatching { gen.startTone(tone, 400) }
                    }
                    delay(600); gen.release()
                }
            } else {
                scope.launch { delay(600); gen.release() }
            }
        }
    }

    private fun openUrl(url: String) {
        val target = resolveOpenUrl(runCatching { Uri.parse(url) }.getOrNull()?.scheme, url) ?: return
        val uri = runCatching { Uri.parse(target) }.getOrNull() ?: return
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun scheduleAlert(title: String, body: String, inMinutes: Double) {
        val delaySec = (inMinutes * 60).toLong()
        val work = OneTimeWorkRequestBuilder<AlertWorker>()
            // Sub-minute precision: schedule in seconds (0.5 min → 30s), not whole minutes.
            .setInitialDelay(delaySec, TimeUnit.SECONDS)
            .setInputData(workDataOf("title" to title, "body" to body))
            .addTag(AlertWorker.TAG)
            .build()
        WorkManager.getInstance(context).enqueue(work)
        // Sidecar record so the Jobs panel can list + individually cancel this
        // device-local alert (WorkInfo exposes neither the title/body nor fireAt).
        AlertStore.add(
            context,
            AlertRecord(work.id.toString(), title, body, System.currentTimeMillis() + delaySec * 1000),
        )
    }
}

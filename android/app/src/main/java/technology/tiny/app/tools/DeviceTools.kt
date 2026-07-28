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
private val OPEN_URL_SCHEMES = setOf("https", "http", "geo", "spotify", "music")

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

    /** Returns true when the tool name was handled here. */
    fun handle(name: String, input: JSONObject): Boolean = runCatching {
        // A failing device tool must NEVER abort the reply stream.
        handleUnsafe(name, input)
    }.getOrElse { t ->
        Log.w("TinyTools", "$name failed: ${t.message}")
        true
    }

    private fun handleUnsafe(name: String, input: JSONObject): Boolean {
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
            "copy_to_clipboard" -> {
                val text = input.optString("text")
                if (text.isNotEmpty()) {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("tiny", text))
                }
            }
            "set_brightness" -> {
                // Server schema: { level: 0..1 } (iOS sets UIScreen.brightness).
                val level = input.optDouble("level", -1.0)
                if (level >= 0) brightnessController?.invoke(level.coerceIn(0.0, 1.0).toFloat())
            }
            "play_sound" -> {
                if (quietProvider()) return true // quiet hours: no agent sounds (iOS parity)
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
            else -> return false
        }
        Log.i("TinyTools", "ran $name")
        return true
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

/**
 * 👂 WearablesListenerBridge — Android's meta_listen executor (iOS
 * GlassesListener parity). N seconds of the active microphone — the glasses,
 * when they're connected as the phone's Bluetooth mic — transcribed
 * ON-DEVICE (prefer-offline / on-device recognizer), text-only to the
 * mailbox. Audio never uploads.
 *
 * Android's SpeechRecognizer ends a session at each silence, so short
 * sessions RESTART until the deadline (the iOS ~1min-cap roll, inverted).
 * Everything runs on the main thread — SpeechRecognizer demands it.
 */
package technology.tiny.app.fleet

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.content.Context
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import technology.tiny.app.TinyApp

object WearablesListenerBridge {

    suspend fun runTool(app: TinyApp, toolUseId: String, seconds: Int) {
        val payload = try {
            listen(app, seconds.coerceIn(3, 30))
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "listening failed on the device")
        }
        runCatching {
            app.api.postJson(
                "/api/chat/tool-result",
                JSONObject().put("toolUseId", toolUseId).put("payload", payload.toString()),
            )
        }
    }

    private suspend fun listen(app: TinyApp, seconds: Int): JSONObject {
        // The HUD's transcriber already owns the mic? Ride it — two
        // recognizers on one input is a fight nobody wins (iOS
        // GlassesListener's rule, same reason).
        if (GlassesLive.running.value && GlassesLive.transcribing.value) {
            val before = GlassesLive.transcript.value
            delay(seconds * 1000L)
            val after = GlassesLive.transcript.value
            val heard = if (after.startsWith(before)) after.substring(before.length) else after
            // The HUD's transcriber acquired (or skipped) the BT link when it
            // started — report the route IT is actually hearing through
            // (iOS's riding branch does the same).
            return JSONObject().put("ok", true).put("transcript", heard.trim())
                .put("micRoute", if (BtMic.active) "bluetooth" else "phone")
        }
        if (ContextCompat.checkSelfPermission(app, android.Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return JSONObject().put("ok", false)
                .put("error", "microphone permission not granted on the phone")
        }
        if (!SpeechRecognizer.isRecognitionAvailable(app)) {
            return JSONObject().put("ok", false)
                .put("error", "speech recognition unavailable on this phone")
        }

        // With the glasses (or any BT headset) connected, raise the SCO link
        // so recognition hears THEIR mic — otherwise "what the glasses heard"
        // would really be the phone's mic (iOS `.allowBluetooth` parity;
        // BtMic.kt explains why Android needs the device-wide knob).
        val viaBt = BtMic.acquire(app)
        if (viaBt) delay(800) // SCO takes a beat to come up

        // SpeechRecognizer is main-thread-only, start to finish.
        return withContext(Dispatchers.Main) {
            val (recognizer, onDevice) = newRecognizer(app)
            val intent = freeFormIntent()

            val heard = StringBuilder()
            val deadline = android.os.SystemClock.elapsedRealtime() + seconds * 1000L
            try {
                // Sessions end at silence — restart until the deadline so a
                // 20s listen isn't cut by the first pause.
                while (android.os.SystemClock.elapsedRealtime() < deadline) {
                    val remaining = deadline - android.os.SystemClock.elapsedRealtime()
                    val segment = withTimeoutOrNull(remaining + 2_000) { once(recognizer, intent) } ?: break
                    if (segment.isNotBlank()) {
                        if (heard.isNotEmpty()) heard.append(' ')
                        heard.append(segment.trim())
                    }
                }
            } finally {
                runCatching { recognizer.destroy() }
                BtMic.release(app)
            }

            // micRoute keeps the agent honest about WHICH microphone heard
            // this — "bluetooth" = the glasses (or a paired headset),
            // "phone" = the phone's own mic was the best available.
            val route = if (viaBt) "bluetooth" else "phone"
            val text = heard.toString().trim()
            if (text.isEmpty()) {
                JSONObject().put("ok", true).put("transcript", "").put("micRoute", route)
                    .put("note", "heard nothing — silence, or the glasses weren't the active mic route")
            } else {
                JSONObject().put("ok", true).put("transcript", text)
                    .put("onDevice", onDevice).put("micRoute", route)
            }
        }
    }

    /**
     * The recognizer recipe, single-sourced (GlassesLive's HUD transcript
     * shares it): prefer the strictly on-device recognizer (API 31+); the
     * intent fallback still sets EXTRA_PREFER_OFFLINE for older paths.
     */
    internal fun newRecognizer(context: Context): Pair<SpeechRecognizer, Boolean> {
        val onDevice = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        val recognizer = if (onDevice) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        } else {
            SpeechRecognizer.createSpeechRecognizer(context)
        }
        return recognizer to onDevice
    }

    internal fun freeFormIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }

    /** One recognizer session: resolves at final results or a terminal error. */
    internal suspend fun once(recognizer: SpeechRecognizer, intent: Intent): String {
        val done = CompletableDeferred<String>()
        recognizer.setRecognitionListener(object : RecognitionListener {
            var partial = ""
            override fun onPartialResults(b: Bundle?) {
                b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { partial = it }
            }
            override fun onResults(b: Bundle?) {
                val text = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: partial
                if (!done.isCompleted) done.complete(text)
            }
            override fun onError(code: Int) {
                // NO_MATCH / timeout = a silent stretch, not a failure; hand
                // back whatever partials arrived and let the loop continue.
                if (!done.isCompleted) done.complete(partial)
            }
            override fun onReadyForSpeech(b: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rms: Float) {}
            override fun onBufferReceived(bytes: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(i: Int, b: Bundle?) {}
        })
        recognizer.startListening(intent)
        return try {
            done.await()
        } finally {
            runCatching { recognizer.stopListening() }
        }
    }
}

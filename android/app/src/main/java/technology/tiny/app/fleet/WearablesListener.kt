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
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
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

        // SpeechRecognizer is main-thread-only, start to finish.
        return withContext(Dispatchers.Main) {
            // Prefer the strictly on-device recognizer (API 31+) — the intent
            // fallback still sets EXTRA_PREFER_OFFLINE for older paths.
            val onDevice = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(app)
            val recognizer = if (onDevice) {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(app)
            } else {
                SpeechRecognizer.createSpeechRecognizer(app)
            }
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            }

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
            }

            val text = heard.toString().trim()
            if (text.isEmpty()) {
                JSONObject().put("ok", true).put("transcript", "")
                    .put("note", "heard nothing — silence, or the glasses weren't the active mic route")
            } else {
                JSONObject().put("ok", true).put("transcript", text)
                    .put("onDevice", onDevice)
            }
        }
    }

    /** One recognizer session: resolves at final results or a terminal error. */
    private suspend fun once(recognizer: SpeechRecognizer, intent: Intent): String {
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

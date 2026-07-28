package technology.tiny.app.chat

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Continuous voice mode (iOS Voice.swift / web VAD parity):
 * mic stays open, partial transcripts stream into a strip (never the composer),
 * 3.0s of transcript silence auto-sends, new speech barges in over TTS.
 * Android SpeechRecognizer ends sessions on its own — we roll a new session
 * on every final/error, carrying pending text (iOS rolls at Apple's ~1min cap).
 */
class VoiceMode(
    private val context: Context,
    private val speech: Speech,
    private val onSend: (String) -> Unit,
) {
    enum class Status { IDLE, LISTENING, HEARING, DENIED }

    private val _status = MutableStateFlow(Status.IDLE)
    val status: StateFlow<Status> = _status
    private val _partial = MutableStateFlow("")
    val partial: StateFlow<String> = _partial
    // Live mic amplitude 0..1 for the voice-strip level meter (web Chat.tsx:2337
    // voiceLevelRef). Fed by SpeechRecognizer.onRmsChanged; 0 when not listening.
    private val _level = MutableStateFlow(0f)
    val level: StateFlow<Float> = _level

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val audioManager = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var recognizer: SpeechRecognizer? = null
    private var watcher: Job? = null
    private var pending = "" // finalized text from rolled sessions
    private var lastHeardAt = 0L

    // The device locale as a BCP-47 tag ("en-US", "de-DE") for the recognizer —
    // read once per session start so a mid-run system language change is picked up
    // on the next roll (iOS re-reads Locale.current when it recreates the recognizer).
    private val deviceLanguageTag: String get() = java.util.Locale.getDefault().toLanguageTag()

    val active: Boolean get() = _status.value != Status.IDLE && _status.value != Status.DENIED

    /**
     * A phone/VoIP call (or the ringtone before you answer) owns the mic. iOS
     * halts here because AVAudioSession.setActive throws during an interruption
     * (Voice.swift beginSession, :173) and never auto-resumes. Android's mic
     * session doesn't throw — it just errors and our onError re-rolls it every
     * 500ms, fighting the dialer for the microphone for the whole call. Reading
     * the audio mode needs no permission and, unlike requesting audio focus,
     * won't collide with the TTS duck/barge-in coordination VoiceMode and Speech
     * already share. MODE_IN_CALL = cellular, MODE_IN_COMMUNICATION = VoIP,
     * MODE_RINGTONE = an incoming call still ringing.
     */
    private fun inCall(): Boolean = when (audioManager.mode) {
        AudioManager.MODE_IN_CALL, AudioManager.MODE_IN_COMMUNICATION, AudioManager.MODE_RINGTONE -> true
        else -> false
    }

    fun start() {
        if (active) return
        // Reset to IDLE first: status stays DENIED after a prior denial, so a
        // SECOND tap re-assigning DENIED below wouldn't be a value change and the
        // UI's LaunchedEffect(status) banner wouldn't re-fire (iOS Voice.swift
        // parity — it resets to "listening" for the same reason). Safe: the
        // `active` guard above already returned for a live session.
        _status.value = Status.IDLE
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            _status.value = Status.DENIED
            return
        }
        if (inCall()) return // a call owns the mic — don't open a session over it
        pending = ""
        _partial.value = ""
        _status.value = Status.LISTENING
        startSession()
        watcher = scope.launch { silenceLoop() }
    }

    fun stop() {
        watcher?.cancel(); watcher = null
        recognizer?.destroy(); recognizer = null
        _status.value = Status.IDLE
        _partial.value = ""
        _level.value = 0f
        pending = ""
    }

    private fun startSession() {
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(listener)
            startListening(
                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true) // on-device when possible (iOS parity)
                    // Pin the recognizer to the DEVICE locale (iOS SFSpeechRecognizer(
                    // locale: Locale.current), Voice.swift:82). Without EXTRA_LANGUAGE the
                    // ASR service uses ITS OWN default language, which can differ from the
                    // phone's — a German-locale user whose Google recognizer defaults to
                    // English would get English transcription. BCP-47 tag ("de-DE") is the
                    // form EXTRA_LANGUAGE wants; EXTRA_LANGUAGE_PREFERENCE nudges engines
                    // that read the older key. The TTS side already honors this locale
                    // (Speech.applyVoice → Locale.getDefault); this closes the mic side.
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, deviceLanguageTag)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, deviceLanguageTag)
            )
        }
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull().orEmpty()
            if (text.isNotBlank()) heard(text)
        }

        override fun onResults(results: Bundle?) {
            val text = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull().orEmpty()
            if (text.isNotBlank()) {
                pending = listOf(pending, text).filter { it.isNotBlank() }.joinToString(" ")
                _partial.value = pending
                lastHeardAt = System.currentTimeMillis()
            }
            if (!active) return
            if (inCall()) { stop(); return } // a call arrived — yield the mic
            startSession() // session roll — keep the mic open
        }

        override fun onError(error: Int) {
            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                _status.value = Status.DENIED
                stop()
                return
            }
            // A session can end with an error (NO_MATCH / SPEECH_TIMEOUT — Android's
            // common outcome) AFTER delivering partials but no final onResults. Only
            // onResults promotes text into `pending`; without that, the recognized
            // words live only in `_partial`, and the NEXT session's first partial
            // recomputes `_partial = pending + newText` — clobbering them. Absorb the
            // visible transcript into `pending` before rolling so it survives (no-op
            // when nothing was heard or after an auto-send already cleared it).
            pending = _partial.value
            // A call can be what ended the session — yield instead of re-rolling
            // into a mic the dialer now owns (this error would otherwise repeat
            // every 500ms for the whole call).
            if (active && inCall()) { stop(); return }
            // NO_MATCH / SPEECH_TIMEOUT etc. → debounced roll (iOS 0.5s parity)
            if (active) scope.launch { delay(500); if (active && !inCall()) startSession() }
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {
            // Android's RMS runs roughly -2 dB (silence) .. 10 dB (loud); map to
            // 0..1 for the meter, clamped. Only while listening — a stray late
            // callback shouldn't twitch the bar after the session ends.
            if (!active) { _level.value = 0f; return }
            _level.value = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
        }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun heard(text: String) {
        speech.stop() // barge-in: any recognized speech silences TTS immediately
        _status.value = Status.HEARING
        _partial.value = listOf(pending, text).filter { it.isNotBlank() }.joinToString(" ")
        lastHeardAt = System.currentTimeMillis()
    }

    /** 400ms poll; 3.0s of silence with text pending → auto-send (web DEFAULT_VAD parity). */
    private suspend fun silenceLoop() {
        while (true) {
            delay(400)
            val text = _partial.value
            if (text.isNotBlank() && System.currentTimeMillis() - lastHeardAt > 3_000) {
                Log.i("TinyVoice", "auto-send: ${text.take(60)}")
                _partial.value = ""
                pending = ""
                _status.value = Status.LISTENING
                onSend(text.trim())
            }
        }
    }
}

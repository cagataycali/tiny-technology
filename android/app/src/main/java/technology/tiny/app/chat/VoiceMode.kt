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

    /**
     * Which rolled session the callbacks currently belong to — iOS `TakeBox`'s
     * generation counter (`NiclaRecorder.swift:97`, `6a5eb026`) ported.
     *
     * ⚠️ ONE `listener` object is set on EVERY recognizer this class builds, and
     * `destroy()` is asynchronous — so a callback from the session we just tore
     * down arrives at the same listener that now serves its replacement, with
     * nothing in the callback saying which session it came from. Two consequences,
     * both silent:
     *
     *  · a late `onResults` appends its text to `pending` a SECOND time (the roll
     *    in `onError` already absorbed `_partial` into `pending`), so the sent
     *    message says a sentence twice — worse than dropping it, because a model
     *    reads a repetition as two things being said;
     *  · a late `onResults`/`onError` calls `startSession()` on a session that has
     *    only just begun, tearing down a live recognizer mid-utterance and tripping
     *    an immediate extra roll.
     *
     * `stop()` bumps this too, so a callback in flight when the user closes voice
     * mode cannot re-arm the mic after `_status` went IDLE.
     */
    private var generation = 0

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
        // Bump FIRST: a callback already in flight must not re-arm the mic after the
        // user closed voice mode. `active` alone doesn't cover it — `onError`'s
        // debounced roll re-checks `active`, but `onResults` calls startSession()
        // straight through, and a destroy-triggered error is exactly what arrives here.
        generation += 1
        watcher?.cancel(); watcher = null
        recognizer?.destroy(); recognizer = null
        _status.value = Status.IDLE
        _partial.value = ""
        _level.value = 0f
        pending = ""
    }

    private fun startSession() {
        generation += 1 // anything the outgoing session says from here is stale
        val gen = generation
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(listenerFor(gen))
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

    /**
     * A listener bound to the session that created it.
     *
     * ⚠️ A FUNCTION, not the single shared `val` this used to be: the binding IS
     * the fix. Every callback below returns early unless it is still the live
     * session, which is the only thing that distinguishes a real result from a
     * teardown echo — `SpeechRecognizer` tells us nothing about which recognizer
     * a callback came from.
     */
    private fun listenerFor(gen: Int) = object : RecognitionListener {
        /** Still the session the mic belongs to. */
        private val live: Boolean get() = gen == generation

        override fun onPartialResults(partialResults: Bundle?) {
            if (!live) return
            val text = partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull().orEmpty()
            if (text.isNotBlank()) heard(text)
        }

        override fun onResults(results: Bundle?) {
            // A superseded session reporting its final words: they are already in
            // `pending` (the roll absorbed `_partial` before starting us), so
            // appending them here says the same sentence twice — and rolling again
            // would tear down a recognizer that has only just opened.
            if (!live) return
            val text = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull().orEmpty()
            if (text.isNotBlank()) {
                pending = appendHeard(pending, text)
                _partial.value = pending
                lastHeardAt = System.currentTimeMillis()
            }
            if (!active) return
            if (inCall()) { stop(); return } // a call arrived — yield the mic
            startSession() // session roll — keep the mic open
        }

        override fun onError(error: Int) {
            // ⚠️ Checked BEFORE the permission arm: a dying session's error must not
            // flip the UI to DENIED or stop() a mic that is working. Android reports
            // the teardown of a destroyed recognizer as an error like any other.
            if (!live) return
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
            //
            // A plain assignment is right here and dedupe is NOT needed: `_partial` is
            // always `pending` plus the live text (both `heard` and `onResults` build
            // it that way), so it already contains `pending` and re-joining would be
            // the doubling this absorb exists to prevent.
            pending = _partial.value.trim()
            // A call can be what ended the session — yield instead of re-rolling
            // into a mic the dialer now owns (this error would otherwise repeat
            // every 500ms for the whole call).
            if (active && inCall()) { stop(); return }
            // NO_MATCH / SPEECH_TIMEOUT etc. → debounced roll (iOS 0.5s parity)
            //
            // ⚠️ Re-checks `live` after the wait, not just `active`. The generation can
            // move DURING the 500ms — a stop() then start(), or a roll from another
            // callback — and `active` is true again in exactly that case, so this
            // lambda would destroy a recognizer that had only just opened. The check
            // has to be re-read after the delay; capturing it before is no check.
            if (active) scope.launch {
                delay(500)
                if (live && active && !inCall()) startSession()
            }
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {
            // Android's RMS runs roughly -2 dB (silence) .. 10 dB (loud); map to
            // 0..1 for the meter, clamped. Only while listening — a stray late
            // callback shouldn't twitch the bar after the session ends.
            //
            // ⚠️ A dead session returns WITHOUT writing: zeroing here would blank the
            // live session's meter mid-utterance, which is the bug this class exists
            // to avoid, in miniature. Only the live session may drive the bar, and
            // only it may zero it.
            if (!live) return
            if (!active) { _level.value = 0f; return }
            _level.value = levelFor(rmsdB)
        }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun heard(text: String) {
        speech.stop() // barge-in: any recognized speech silences TTS immediately
        _status.value = Status.HEARING
        _partial.value = appendHeard(pending, text)
        lastHeardAt = System.currentTimeMillis()
    }

    companion object {
        /**
         * Join a rolled session's banked words to what was just heard.
         *
         * ⚠️ Dedupes, which the bare `joinToString(" ")` did not. iOS `TakeBox.bank`
         * (`NiclaRecorder.swift:151`) carries the same rule and the same reason: a
         * roll can hand the next session audio it has already transcribed, and **a
         * transcript that reads a sentence twice is worse than one that clips it** —
         * a model treats a repetition as two things being said. Compared
         * case-insensitively because the recognizer re-capitalises freely between
         * sessions ("okay" / "Okay" are one utterance, not two).
         *
         * Kept pure and in the companion so it is testable on the local JVM, like
         * `Speech.scrub` — no `android.*` in here.
         */
        fun appendHeard(pending: String, heard: String): String {
            val p = pending.trim()
            val h = heard.trim()
            if (h.isEmpty()) return p
            if (p.isEmpty()) return h
            val lowP = p.lowercase()
            val lowH = h.lowercase()
            // Already said: a late or replayed utterance the bank has in full.
            if (lowP.contains(lowH)) return p
            // A longer re-reading of the tail REPLACES it rather than doubling it —
            // "so I said" then "so I said hello" is one sentence, heard twice.
            if (lowH.contains(lowP)) return h
            return "$p $h"
        }

        /**
         * Android's RMS (~-2 dB silence .. 10 dB loud) mapped to the meter's 0..1.
         *
         * Extracted only so the clamp is testable: an unclamped value drives the
         * level bar past its track, and a shouted syllable reports well over 10 dB.
         */
        fun levelFor(rmsdB: Float): Float = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
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

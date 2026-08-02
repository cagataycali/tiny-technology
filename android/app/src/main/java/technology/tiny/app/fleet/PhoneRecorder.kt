package technology.tiny.app.fleet

import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import technology.tiny.app.TinyApp

/**
 * 🎙️ PhoneRecorder — Android's answer to the relay's {type:"record"} envelope
 * (iOS NiclaRecorder.swift parity, with one deliberate and visible amputation).
 *
 * The Nicla Voice necklace can never carry audio over BLE (64KB of RAM), so a
 * "record what the user says next" request is served by the PHONE's microphone.
 * The worker's nicla_voice_record tool sends the envelope; until this existed,
 * FleetManager.handleEnvelope dropped it at `type != "invoke"` — and because the
 * relay poll CLAIMS envelopes (CAS delivered=0→1), the request was consumed and
 * destroyed rather than retried. The caller waited out its full window and then
 * told the user the phone might still be recording. Nothing was.
 *
 * ⚠️ NO AUDIO FILE, BY PLATFORM CONSTRAINT — not by omission.
 *
 * iOS records and transcribes in ONE pass: an AVAudioEngine tap feeds
 * SFSpeechRecognizer and an AVAudioFile off the same buffers, which is why its
 * reply carries an `audioUrl`. Android cannot: SpeechRecognizer captures inside
 * Google's recognition-service process, so this app never sees the samples, and
 * the mic is exclusive — a MediaRecorder opened alongside it would either fail
 * or starve recognition of the audio. Recognition is the payload the agent
 * actually reads, so this keeps the transcript and omits the recording.
 *
 * The consequence is contractual and must stay honest: the reply carries
 * `result` and `transcriptId` and NO `audioUrl` key at all. The tool treats a
 * missing one as null (audio_url: null), so an absent key degrades to "no audio"
 * — while a present-but-empty or fabricated URL would render a broken player.
 * [Reply] is where that shape is decided, and it is unit-tested.
 */
object PhoneRecorder {

    /** Longest take, matching the worker tool's own clamp. */
    const val MAX_SECONDS = 120

    /** Shortest take — below this the recognizer barely gets a session up. */
    const val MIN_SECONDS = 5

    /** How this owner identifies itself in [MicClaim] — shown in a refusal. */
    private const val OWNER = "recorder"

    /** Slice length of the take's sleep — how soon [stopEarly] is noticed. */
    internal const val STOP_TICK_MS = 200L

    /**
     * `onRmsChanged` dB → 0…1 for a meter.
     *
     * Android documents no range for this value; in practice it runs about
     * -2 (silence) to 10 (loud speech), so a bar fed the raw dB sits pinned at
     * one end and tells the user nothing. Pure, so the mapping is testable
     * without a microphone.
     */
    internal fun meterLevel(rmsdB: Float): Float =
        ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)

    private val _isRecording = MutableStateFlow(false)

    /** True while a take owns the mic — the UI shows it, and VoiceMode must not collide. */
    val isRecording: StateFlow<Boolean> = _isRecording

    private val _level = MutableStateFlow(0f)

    /**
     * Live input level, 0…1 — the only proof a take is really hearing anything.
     *
     * "Recording…" with no meter is a claim the user cannot check: a muted mic or
     * a phone face-down in a pocket looks identical to a working take. Fed from
     * `onRmsChanged`, which this file previously discarded (iOS NiclaRecorder
     * publishes `level` off its audio tap for the same reason).
     */
    val level: StateFlow<Float> = _level

    /**
     * Set by [stopEarly] to end the take in progress before its deadline.
     *
     * Cleared where the mic is CLAIMED, not when a take ends: a stop landing
     * just after a take finished would otherwise sit here set and kill the NEXT
     * take on its first tick.
     */
    @Volatile private var stopRequested = false

    /**
     * End the current take now, keeping everything it captured.
     *
     * [record] used to be a promise the user could not take back — the take slept
     * out its full duration no matter what. That is right for the agent's fixed
     * "record 10s" envelope and wrong for a recorder a person operates: you stop
     * talking, so the recording should stop, and the take should still transcribe,
     * file and answer with what it got. This is a REQUEST, not a teardown — the
     * take itself still rolls its recognizer down and files the transcript, which
     * is why the words survive being stopped mid-sentence.
     */
    fun stopEarly() {
        if (!_isRecording.value) return
        stopRequested = true
    }

    // ── The pure half: what a take yields, and what the relay hears about it ──

    /**
     * A finished take. `text` is what the recognizer heard (empty = silence,
     * which is a SUCCESS: the mic worked and the room was quiet).
     */
    data class Take(
        val ok: Boolean,
        val text: String,
        val transcriptId: String,
        val seconds: Int,
        val error: String? = null,
    )

    /**
     * The relay reply for a take — the exact JSON the worker's nicla_voice_record
     * parses (`p.result`, `p.transcriptId`, `p.audioUrl`, `p.error`).
     *
     * Pure so the shape is testable without a microphone. Three rules it encodes:
     *
     *  1. A silent take is not a failure. iOS says "heard nothing (silence)"
     *     rather than reporting an error, because "recording failed" sends the
     *     user to check a microphone that worked perfectly.
     *  2. 600-char preview, iOS's number. The full text lives in the transcript
     *     store; the tool's own note tells the agent to fetch it by id.
     *  3. No `audioUrl` key. See the class header — Android has no file to host,
     *     and inventing a URL would render a player over nothing.
     */
    fun reply(take: Take): JSONObject {
        val o = JSONObject()
        if (!take.ok) {
            // `result` too, not only `error`: the tool returns early on a present
            // `error`, but a reply with neither field would make it fall through
            // to its "did not answer" timeout — blaming the network for a refusal
            // this phone already explained.
            val why = take.error ?: "unknown"
            o.put("error", "recording failed: $why")
            o.put("result", "recording failed: $why")
            return o
        }
        val heard = take.text.trim()
        o.put(
            "result",
            if (heard.isEmpty()) "🎙️ recorded ${take.seconds}s — heard nothing (silence)"
            else "🎙️ recorded ${take.seconds}s — “${heard.take(600)}”",
        )
        o.put("transcriptId", take.transcriptId)
        return o
    }

    /**
     * The seconds a take will actually run, from whatever the envelope asked for.
     *
     * Clamped HERE as well as in the worker tool because the envelope is not a
     * trusted input path: a relay payload reaches this phone from anything
     * holding the internal key, and `seconds: 86400` would otherwise hold the
     * microphone for a day. Absent/garbage → iOS's default of 10.
     */
    fun clampSeconds(asked: Int?): Int =
        (asked ?: 10).coerceIn(MIN_SECONDS, MAX_SECONDS)

    /**
     * How long the take REALLY ran, from the elapsed milliseconds and the window
     * it was allowed.
     *
     * Reporting the REQUESTED length would label a 4-second stopped-early take as
     * 120 seconds — in the reply the agent reads, in the transcript store, and in
     * the duration the server keeps. Now that a take can be stopped, `secs` is a
     * ceiling rather than a fact.
     *
     * Floor of 1 so a stop inside the first tick is not recorded as a 0-second
     * take, and capped at the window because the recognizer's own settle delay
     * runs past the deadline (iOS: `max(1, min(clamped, elapsed))`).
     */
    fun actualSeconds(elapsedMs: Long, window: Int): Int =
        ((elapsedMs + 500) / 1000).toInt().coerceIn(1, window.coerceAtLeast(1))

    /**
     * The label a take is filed under — the envelope's `reason` when it gave one.
     *
     * iOS falls back to "web agent" and so does this: the label is what the user
     * later reads in their transcript list, and an empty one there is a recording
     * with no explanation of why their phone turned its microphone on.
     */
    fun label(reason: String?): String =
        reason?.trim()?.takeIf { it.isNotEmpty() }?.take(200) ?: "web agent"

    // ── The impure half: the take itself ─────────────────────────────────────

    /**
     * Record `seconds` of phone mic while transcribing on-device, then file the
     * transcript. Never throws — every failure comes back as a [Take] the relay
     * can answer with, because a thrown exception here becomes the caller's
     * 35-second timeout instead of a sentence naming what went wrong.
     */
    suspend fun record(app: TinyApp, seconds: Int, label: String): Take {
        val secs = clampSeconds(seconds)
        val id = java.util.UUID.randomUUID().toString()

        if (!SpeechRecognizer.isRecognitionAvailable(app)) {
            return Take(false, "", id, 0, "no speech recognition on this phone")
        }
        if (!MicClaim.granted(app)) {
            // Named precisely: a permission the USER must grant. "Recording
            // failed" would send them to Settings looking for a broken mic.
            return Take(false, "", id, 0, "microphone permission is not granted on this phone")
        }
        // ONE mic — checked LAST, so a phone that could never record says why
        // (no recognizer, no permission) instead of blaming a busy microphone.
        // The claim is what makes this safe against voice chat and a second take.
        if (!MicClaim.claim(OWNER)) {
            return Take(false, "", id, 0, "the phone's mic is already in use (${MicClaim.heldBy})")
        }

        _isRecording.value = true
        // Clear any stale early-stop HERE, where the mic is claimed — see
        // [stopRequested]. A stop that lands between takes must not kill the next.
        stopRequested = false
        val startedAt = android.os.SystemClock.elapsedRealtime()
        try {
            val heard = listen(app, secs)
            // The window is a CEILING now, not a fact: a stopped take reports what
            // it really ran, or the list, the store and the agent all read 120s.
            val ran = actualSeconds(android.os.SystemClock.elapsedRealtime() - startedAt, secs)
            val take = Take(true, heard, id, ran)
            fileTranscript(app, take, label)
            return take
        } catch (t: Throwable) {
            Log.w("TinyRec", "take failed: ${t.message}")
            return Take(false, "", id, 0, t.message ?: "recording failed")
        } finally {
            _isRecording.value = false
            _level.value = 0f
            stopRequested = false
            MicClaim.release(OWNER)
        }
    }

    /**
     * Drive SpeechRecognizer for `seconds`, accumulating finals and keeping the
     * last partial. Returns whatever was heard — silence included.
     *
     * Sessions are ROLLED, as VoiceMode does: Android ends a recognition session
     * on its own (NO_MATCH, SPEECH_TIMEOUT) long before a 120s take is up, so a
     * single startListening would silently stop hearing partway through and
     * report the first few seconds as the whole take.
     */
    private suspend fun listen(app: TinyApp, seconds: Int): String = withContext(Dispatchers.Main) {
        val finals = StringBuilder()
        var partial = ""
        var recognizer: SpeechRecognizer? = null
        // TWO flags, because the tail of a take needs them to differ. `live` means
        // "still absorbing words"; `rolling` means "still allowed to open a new
        // session". During the settle wait after stopListening the first is true
        // and the second false — one flag would either drop the final callback's
        // words or let it reopen the microphone after the take was over.
        var live = true
        var rolling = true
        val lang = java.util.Locale.getDefault().toLanguageTag()

        fun snapshot(): String =
            listOf(finals.toString().trim(), partial.trim())
                .filter { it.isNotEmpty() }
                .joinToString(" ")
                .trim()

        val scope = CoroutineScope(Dispatchers.Main)

        fun start() {
            recognizer?.destroy()
            if (!rolling) return
            recognizer = SpeechRecognizer.createSpeechRecognizer(app).apply {
                setRecognitionListener(object : RecognitionListener {
                    override fun onPartialResults(results: Bundle?) {
                        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull()?.takeIf { it.isNotBlank() }
                            ?.let { partial = it }
                    }

                    override fun onResults(results: Bundle?) {
                        if (!live) return
                        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull()?.takeIf { it.isNotBlank() }
                            ?.let { if (finals.isNotEmpty()) finals.append(' '); finals.append(it) }
                        partial = ""
                        if (rolling) start() // roll — keep the mic open for the rest of the take
                    }

                    override fun onError(error: Int) {
                        if (!live) return
                        // A session can die AFTER delivering partials but with no
                        // final. Absorb the visible text before rolling or the next
                        // session's first partial overwrites words we already heard
                        // (the same trap VoiceMode.onError documents).
                        if (partial.isNotBlank()) {
                            if (finals.isNotEmpty()) finals.append(' ')
                            finals.append(partial)
                            partial = ""
                        }
                        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                            rolling = false
                            return
                        }
                        if (rolling) scope.launch { delay(400); if (rolling) start() }
                    }

                    override fun onReadyForSpeech(params: Bundle?) {}
                    override fun onBeginningOfSpeech() {}

                    /**
                     * The meter. Android reports roughly -2…10 dB here (the docs
                     * give no fixed range), so it is normalised rather than used
                     * raw — a bar driven by dB directly sits pinned at one end.
                     */
                    override fun onRmsChanged(rmsdB: Float) {
                        _level.value = meterLevel(rmsdB)
                    }
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
                startListening(
                    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                        .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
                )
            }
        }

        start()
        // Sleep in SLICES so stopEarly() can end the take, instead of one
        // uninterruptible sleep to the deadline. 200ms is the granularity at
        // which Stop feels instant, and is nothing next to the recognition
        // session already running (iOS uses the same slice).
        val until = android.os.SystemClock.elapsedRealtime() + seconds * 1000L
        while (android.os.SystemClock.elapsedRealtime() < until) {
            if (stopRequested) break
            delay(STOP_TICK_MS)
        }
        // stopListening (not destroy) so the session delivers the tail it already
        // captured, then a beat for that final callback to land — otherwise the
        // last words spoken are cut off the transcript. `live` stays true across
        // the wait so an arriving final is still absorbed; it is cleared before
        // teardown so that callback cannot roll a fresh session behind us.
        rolling = false      // no new sessions from here on…
        recognizer?.stopListening()
        delay(700)           // …but the one in flight may still deliver its tail
        live = false
        recognizer?.destroy()
        recognizer = null
        snapshot()
    }

    /**
     * File the transcript where BOTH readers can see it: the durable store the
     * user browses, and the agent's context.
     *
     * Attribution is the necklace when one is paired, the phone otherwise —
     * iOS's rule (NiclaRecorder.postToServer). The words came from the phone's
     * mic, but the moment belongs to the necklace that asked for it, and the
     * device token is what resolves the owner server-side.
     *
     * Falls back to a `device_note` event, exactly as iOS does, so a phone
     * running against a worker without /api/devices/transcript deployed still
     * gets the words into the next turn's context instead of dropping them.
     */
    /**
     * File words this phone heard from somewhere OTHER than a take — the
     * necklace's own live audio ([LiveScribe]), iOS `storeHeard` parity.
     *
     * Shares [fileTranscript]'s rail rather than posting its own body, so a
     * live segment lands in exactly the same two places a take does (the
     * durable transcripts list and the agent's next turn) and falls back the
     * same way when the transcript route isn't deployed.
     */
    suspend fun storeHeard(app: TinyApp, text: String, label: String, seconds: Int) {
        val id = java.util.UUID.randomUUID().toString()
        fileTranscript(app, Take(true, text, id, seconds), label)
    }

    private suspend fun fileTranscript(app: TinyApp, take: Take, label: String) {
        val text = take.text.trim().ifEmpty { "(silence)" }
        val voice = NiclaVoiceGateway.credentials(app)
        val phone = app.auth.deviceId?.let { id -> app.auth.deviceToken?.let { id to it } }
        val creds = voice ?: phone ?: return

        val body = JSONObject()
            .put("deviceId", creds.first)
            .put("token", creds.second)
            .put("text", text)
            .put("label", label)
            .put("durationS", take.seconds)
        val ok = runCatching { app.api.postJson("/api/devices/transcript", body) }
            .getOrNull()?.optBoolean("ok", false) == true
        if (ok) return

        runCatching {
            app.api.postJson(
                "/api/devices/event",
                JSONObject()
                    .put("deviceId", creds.first)
                    .put("token", creds.second)
                    .put("kind", "device_note")
                    .put("detail", "🎙️ $label: “${text.take(180)}”"),
            )
        }
    }
}

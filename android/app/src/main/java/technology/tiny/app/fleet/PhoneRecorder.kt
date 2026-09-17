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
 * ⚠️ NO AUDIO FILE FOR A **TAKE**, BY PLATFORM CONSTRAINT — not by omission.
 *
 * iOS records and transcribes in ONE pass: an AVAudioEngine tap feeds
 * SFSpeechRecognizer and an AVAudioFile off the same buffers, which is why its
 * reply carries an `audioUrl`. Android cannot: SpeechRecognizer captures inside
 * Google's recognition-service process, so this app never sees the samples, and
 * the mic is exclusive — a MediaRecorder opened alongside it would either fail
 * or starve recognition of the audio. Recognition is the payload the agent
 * actually reads, so this keeps the transcript and omits the recording.
 *
 * ⚠️ THE CONSTRAINT IS ABOUT THIS PHONE'S OWN MICROPHONE, AND ONLY THAT. It does
 * NOT cover a necklace-live segment: that audio arrives over the network and passes
 * through [LiveScribe.feed] in this app's own memory, so those rows DO own a local
 * file (see [audioDir]/[audioFor]). Read as a blanket "Android has no audio", this
 * paragraph is what made the gap look like a platform limit for as long as it
 * existed — a comment that documents the code accurately can still guarantee the
 * wrong thing once the code around it is right.
 *
 * The consequence is contractual and must stay honest: the reply carries
 * `result` and `transcriptId` and NO `audioUrl` key at all. The tool treats a
 * missing one as null (audio_url: null), so an absent key degrades to "no audio"
 * — while a present-but-empty or fabricated URL would render a broken player.
 * [Reply] is where that shape is decided, and it is unit-tested.
 */
object PhoneRecorder {

    /**
     * Longest take, extensions included — matching the worker tool's own clamp.
     *
     * Also the ABSOLUTE ceiling now that a take can outrun what was asked for
     * (see [shouldExtend]): an extended take must never be able to outlast a
     * take that requested the maximum outright.
     */
    const val MAX_SECONDS = 120

    /** Shortest take — below this the recognizer barely gets a session up. */
    const val MIN_SECONDS = 5

    /**
     * How long a take waits for more words before it accepts the speaker is done.
     *
     * Long enough to cross the pause between two sentences (around a second in
     * normal speech), short enough that the take doesn't sit on the microphone
     * after the room goes quiet. iOS `NiclaRecorder.silenceGrace`.
     */
    internal const val SILENCE_GRACE_MS = 3_000L

    /** How this owner identifies itself in [MicClaim] — shown in a refusal. */
    private const val OWNER = "recorder"

    /** This rail's name in [BtMic]'s holder set — see `BtMic.acquire`'s warning. */
    private const val BT_OWNER = "recorder"

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

    private val _partial = MutableStateFlow("")

    /**
     * What the take has heard SO FAR — the words, not just the level.
     *
     * [level] proves the mic hears SOMETHING; only words prove it hears YOU, which
     * is what a person actually wants to know before trusting a screen with two
     * minutes of speech. Until now the recognizer's partials lived in a local
     * variable inside [listen] and died there, so both Record buttons on this phone
     * showed ten bars and no text (iOS carried the identical gap, and its own
     * comment admitted it: "partial recognition text is not shown anywhere else in
     * this view" — fixed there in `e99e3c53`, which this ports).
     *
     * Empty until the first partial arrives, and it is the WHOLE take's text, not
     * the live session's: [listen] rolls a fresh `SpeechRecognizer` every time
     * Android ends a session on its own, so publishing only the current session
     * would make the screen appear to forget the sentence the user just watched it
     * type. Published from the take loop's existing 200ms tick rather than from
     * `onPartialResults` — see [listen].
     */
    val partial: StateFlow<String> = _partial

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
        /**
         * Which microphone actually heard this take — `"bluetooth"` (the glasses
         * or a paired headset) or `"phone"` (the built-in mic).
         *
         * ⚠️ CARRIED ON THE TAKE, NOT READ AT REPLY TIME, and that is the whole
         * reason this field exists rather than a `BtMic.active` call inside
         * [reply]. The SCO link comes DOWN in the take's `finally` — so by the
         * time the reply is built the honest answer to "is the headset the mic"
         * is always no, and a route read there would report `"phone"` for every
         * take including the ones the glasses heard. [meta_listen] reads it
         * live because it answers while its own session is still up; a take
         * cannot, so it remembers.
         *
         * Defaulted for the failure constructors: a take that never opened a
         * microphone has no route to report, and `null` says that rather than
         * naming one it never used.
         */
        val micRoute: String? = null,
    )

    /** What [listen] hands back: the words, and the mic that heard them. */
    internal data class Heard(val text: String, val micRoute: String)

    /**
     * `BtMic.active` → the route name the agent reads.
     *
     * A two-word function so the SPELLING is provable without a microphone. The
     * agent compares this field across rails (`meta_listen` posts the same one),
     * and "bt"/"BLUETOOTH"/"headset" would each be a different fact to a reader
     * that only does string equality. iOS's `WearablesLive.micRoute()` returns
     * these exact two words from `AVAudioSession.currentRoute`.
     */
    internal fun route(viaBluetooth: Boolean): String = if (viaBluetooth) "bluetooth" else "phone"

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
     *  4. `micRoute` when the take knows it, and `meta_listen`'s exact spelling
     *     ("bluetooth" / "phone"), because the agent reads both fields and two
     *     vocabularies for one fact is a fact nobody can act on. Omitted, never
     *     guessed: a take that failed before opening a mic has no route, and a
     *     defaulted "phone" would claim the built-in mic heard the silence.
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
        take.micRoute?.let { o.put("micRoute", it) }
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
     * The ceiling a take is actually allowed to reach.
     *
     * Its own function rather than an expression inside [record] because it is the
     * WHOLE opt-in gate, and the gate is what has to be protected: iOS learned
     * this from its own harness — with the decision inline, a mutation that let
     * EVERY take extend passed the entire suite, and that regression is exactly
     * what would break `nicla_voice_record` (it polls the relay for `seconds + 25`
     * and would be answered by a take that had run to two minutes).
     */
    fun hardCapSeconds(requested: Int, extendWhileSpeaking: Boolean): Int =
        if (extendWhileSpeaking) MAX_SECONDS else requested

    /**
     * Should a take that reached its deadline keep going?
     *
     * The wake word is the record button and the wake path asks for 10 seconds. A
     * person who says the wake word and then talks for thirty gets the first ten
     * and silently loses the rest — the transcript ends, and nothing in the stored
     * row says it was cut. That is the wrong shape for a recorder: a take should
     * end when the SPEAKER stops, not when a number a caller guessed runs out.
     *
     * So `seconds` becomes a FLOOR rather than a promise, and the take keeps
     * running while words are still arriving. Two bounds, because "extend while
     * speaking" on its own is an open microphone:
     *
     *  - `hardCapMs` is absolute. A noisy room produces words forever, and a take
     *    that never ends never uploads, never transcribes and never gives the mic
     *    back — a worse failure than a truncated one.
     *  - [SILENCE_GRACE_MS] since the last NEW WORDS. Not since the last audio:
     *    [level] can't tell speech from a fan, and the question this asks is
     *    whether the RECOGNIZER is still producing text.
     *
     * Pure, and taking its clock as a parameter, for the same reason iOS made it
     * `nonisolated` — this is the entire stop rule and it has to be testable
     * without a microphone. All times are `SystemClock.elapsedRealtime` millis,
     * which is why they are monotonic and a wall-clock change cannot end a take.
     */
    fun shouldExtend(
        nowMs: Long,
        deadlineMs: Long,
        hardCapMs: Long,
        lastGrowthMs: Long,
        stopRequested: Boolean,
    ): Boolean {
        if (stopRequested) return false          // the user's Stop always wins
        if (nowMs >= hardCapMs) return false
        if (nowMs < deadlineMs) return true      // still inside what was asked for
        return nowMs - lastGrowthMs < SILENCE_GRACE_MS
    }

    /**
     * The label a take is filed under — the envelope's `reason` when it gave one.
     *
     * iOS falls back to "web agent" and so does this: the label is what the user
     * later reads in their transcript list, and an empty one there is a recording
     * with no explanation of why their phone turned its microphone on.
     */
    fun label(reason: String?): String =
        reason?.trim()?.takeIf { it.isNotEmpty() }?.take(200) ?: "web agent"

    // ── The fallback rail's budget (iOS noteDetail parity, different number) ──

    /**
     * The cap a CLIENT's `detail` actually has on the device-event rail — **240**,
     * and NOT the 300 the route and the OpenAPI blurb both advertise.
     *
     * ⚠️ MEASURED ALONG THE WHOLE CHAIN, because two of its three slices are
     * invisible from either end of it. A detail posted here passes through:
     *
     *   1. `app/api/devices/event/route.ts` — `String(detail).slice(0, 300)`
     *   2. worker `devices.ts` DeviceEventCall — `` `${name}: ${detail.slice(0, 240)}` ``
     *   3. worker `events.ts` emitEvent — `String(detail).slice(0, 300)`
     *
     * Step 2 is the binding one, and it is easy to read past: it slices the
     * client's text to 240 **before** prepending the device name, so step 3's 300
     * can never be reached (40 + 2 + 240 = 282) and reading `emitEvent` alone
     * gives a budget 60 chars too generous. iOS budgets against 300 for exactly
     * that reason (`NiclaRecorder.noteDetailMax`) and still overshoots this rail.
     *
     * The lower cap is why the budget is spent deliberately here rather than
     * hoped for — see [noteDetail].
     */
    const val NOTE_DETAIL_MAX = 240

    /**
     * How much of the label the fallback line will spend. Bounded well under the
     * worker's own TRANSCRIPT_LABEL_MAX (80) and far under what [label] permits
     * (200), because a label is the CHEAPEST part of this line to lose: the ones
     * this app generates are short by construction ("memo", "manual",
     * "wake: hey tiny", "necklace-live"), and the only one that runs long is an
     * agent-supplied `reason` — which the agent already knows, having written it.
     * The speech is the part nothing else in the system has a copy of.
     */
    const val NOTE_LABEL_MAX = 40

    /**
     * The `device_note` line for the fallback rail, budgeted to survive the ring.
     *
     * ⚠️ THIS RAIL'S LOSS IS UNRECOVERABLE, WHICH IS THE WHOLE REASON IT IS
     * BUDGETED. [fileTranscript] prefers `/api/devices/transcript`, which files a
     * durable row and hands back an id — anything truncated there is still fetchable
     * by that id. This rail is what runs when that one fails, and it files NO row:
     * whatever the worker cuts is simply gone, with nothing to fetch the rest with.
     * So the cost of being 60 chars optimistic is a sentence of somebody's speech
     * that no longer exists anywhere.
     *
     * The line was `"🎙️ $label: “${text.take(180)}”"` with the label unbounded.
     * Measured against the real 240 ([NOTE_DETAIL_MAX]):
     *
     *   - label "memo"                 → 192 chars, fits
     *   - label "web agent"            → 197 chars, fits
     *   - a 53-char agent `reason`     → 241, the first char goes over
     *   - a 200-char `reason` ([label]'s own ceiling, and free text from the
     *     agent) → **388 chars: the worker cuts 148 of them off the TAIL**, which
     *     on this line is the speech
     *
     * So: bound the label, then give the words everything that is left.
     *
     * ⚠️ NO `maxOf(floor, …)` HERE, AND THAT IS DELIBERATE — iOS HAS ONE AND THIS
     * MUST NOT COPY IT. iOS's line ends with an audio URL it reserves first, and a
     * URL is unbounded free text from the media host (its own cap is 300), so there
     * its `room` really can collapse and a floor really is load-bearing. This line
     * has no URL at all (see the class header: no take owns audio on this phone),
     * so once the label is bounded the room is arithmetically fixed at
     * `NOTE_DETAIL_MAX - (8 + NOTE_LABEL_MAX)` = **192 at worst, 232 at best** — it
     * cannot reach a floor of 40 from any input, including a 5000-char label.
     *
     * A floor was written here first and two mutants proved it dead: deleting it
     * and zeroing it BOTH left every test green, because nothing can reach it. That
     * is the same vacuous-guard shape [LiveTranscribe.LIVE_LABEL]'s eviction rule
     * already refused — a guard that reads as load-bearing while no input can
     * exercise it is worse than none, because the next reader trusts it. The
     * property is guaranteed STRUCTURALLY instead, by the label bound, and
     * [MIN_NOTE_PREVIEW] states the consequence so a test can hold it.
     *
     * ⚠️ COUNTED IN UTF-16 UNITS, WHICH IS WHAT THE WORKER COUNTS. Kotlin's
     * `length`/`take` and JS's `.length`/`.slice` are both UTF-16, so they agree
     * by construction — but this line opens with 🎙️ (U+1F399 U+FE0F: **3** units,
     * 1 grapheme) and wraps the speech in curly quotes. iOS budgets in GRAPHEMES
     * (`String.count`), so its own 300-char line measures 302 to the worker. This
     * one must not inherit that: the arithmetic here is deliberately in the same
     * units as the slice it is defending against.
     */
    fun noteDetail(label: String, text: String): String {
        val bounded = label.take(NOTE_LABEL_MAX)
        // Built from the real shell rather than counted by hand, so the emoji and
        // the curly quotes are measured as the worker measures them.
        val shell = "🎙️ $bounded: “”"
        return "🎙️ $bounded: “${text.take(NOTE_DETAIL_MAX - shell.length)}”"
    }

    /**
     * The least speech this line can ever carry — what the label bound BUYS, stated
     * as a number so a test can hold the guarantee that replaced the dead floor.
     *
     * `NOTE_DETAIL_MAX - shell.length` at the worst possible label: 🎙️ (**3** UTF-16
     * units, not 2 — the emoji is a surrogate pair plus U+FE0F) + a space + ": " +
     * two curly quotes = **8**, plus [NOTE_LABEL_MAX]. Raising [NOTE_LABEL_MAX]
     * spends the speech's floor, which is the trade this constant names.
     *
     * ⚠️ Written as 7 the first time, and the JVM test caught it — counting that
     * emoji in code points rather than UTF-16 units is the exact mistake this whole
     * budget exists to avoid, so the arithmetic is spelled out rather than trusted.
     */
    const val MIN_NOTE_PREVIEW = NOTE_DETAIL_MAX - (8 + NOTE_LABEL_MAX)

    // ── The impure half: the take itself ─────────────────────────────────────

    /**
     * Record `seconds` of phone mic while transcribing on-device, then file the
     * transcript. Never throws — every failure comes back as a [Take] the relay
     * can answer with, because a thrown exception here becomes the caller's
     * 35-second timeout instead of a sentence naming what went wrong.
     *
     * @param extendWhileSpeaking treat `seconds` as a FLOOR and keep recording
     * while words are still arriving (see [shouldExtend]). OFF by default, and
     * that default is the contract: `nicla_voice_record` polls the relay for only
     * `seconds + 25`, so a take that extended to two minutes would answer an agent
     * that had already given up — the transcript stored, the caller told it timed
     * out. Only the wake path opts in, because it is the one with nobody waiting
     * on a budget.
     */
    suspend fun record(
        app: TinyApp,
        seconds: Int,
        label: String,
        extendWhileSpeaking: Boolean = false,
    ): Take {
        val secs = clampSeconds(seconds)
        val cap = hardCapSeconds(secs, extendWhileSpeaking)
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
        // The words too, and for the same reason the flag is cleared here: a take
        // must never open showing the PREVIOUS take's sentence, which would read as
        // words this microphone is hearing right now.
        _partial.value = ""
        val startedAt = android.os.SystemClock.elapsedRealtime()
        try {
            val heard = listen(app, secs, cap)
            // The window is a CEILING now, not a fact: a stopped take reports what
            // it really ran, or the list, the store and the agent all read 120s.
            // Bounded by the HARD CAP rather than by `secs`, because an extended
            // take legitimately runs past what it asked for — clamping to `secs`
            // there would report every 40-second wake take as 10.
            val ran = actualSeconds(android.os.SystemClock.elapsedRealtime() - startedAt, cap)
            val take = Take(true, heard.text, id, ran, micRoute = heard.micRoute)
            fileTranscript(app, take, label)
            return take
        } catch (t: Throwable) {
            Log.w("TinyRec", "take failed: ${t.message}")
            return Take(false, "", id, 0, t.message ?: "recording failed")
        } finally {
            _isRecording.value = false
            _level.value = 0f
            // Cleared with the claim: a failed take must leave nothing behind that
            // looks like a recording in progress, and the finished take's words
            // belong to the transcript store from here on, not to a live card.
            _partial.value = ""
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
     *
     * `seconds` is a floor and `capSeconds` the ceiling; when they are equal the
     * take runs exactly its window, which is every caller but the wake path.
     *
     * Returns the WORDS AND THE ROUTE, because only this function is ever inside
     * the window where the route is a fact: it raises the SCO link and drops it in
     * its own `finally`, and `record()` builds the [Take] after that. See
     * [Take.micRoute].
     */
    private suspend fun listen(app: TinyApp, seconds: Int, capSeconds: Int): Heard = withContext(Dispatchers.Main) {
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
                        // ⚠️ ON THIS RAIL THE TRANSCRIPT *IS* THE RECORDING. This phone
                        // cannot hand the agent an audio file (see the header), so
                        // nicla_voice_record's answer is text and nothing else — there is
                        // no recording to fall back to when the words run together.
                        .askForPunctuation()
                )
            }
        }

        // Hear through the GLASSES when they're worn (BtMic.kt — iOS's
        // `.allowBluetooth` on NiclaRecorder's own session, NiclaRecorder.swift:533);
        // the phone's own mic otherwise, exactly as before.
        //
        // ⚠️ A TAKE IS THE RAIL WITH NOBODY WATCHING. `nicla_voice_record` is
        // triggered from the relay, so the user is not looking at a screen that could
        // show them which microphone is live — they are wearing the glasses and being
        // asked a question. Without this the take transcribed the phone in their
        // pocket while the tool's own reply said the phone "records through its own
        // mic": true of the hardware, wrong about the room. Nothing fails; the words
        // are just the wrong ones, muffled through a jacket.
        //
        // Acquired here rather than in `record()` so it pairs with the recognizer's
        // own lifetime, and inside the try/finally below so a throw cannot leave the
        // SCO link up — a headset stuck in call mode for the life of the process.
        val viaBt = BtMic.acquire(app, BT_OWNER)
        if (viaBt) delay(800) // SCO takes a beat to come up
        try {
        start()
        // Sleep in SLICES so stopEarly() can end the take, instead of one
        // uninterruptible sleep to the deadline. 200ms is the granularity at
        // which Stop feels instant, and is nothing next to the recognition
        // session already running (iOS uses the same slice). It is also what
        // makes extension possible at all: the deadline is now re-decided every
        // tick by [shouldExtend] rather than fixed before the first one.
        val startedAt = android.os.SystemClock.elapsedRealtime()
        val until = startedAt + seconds * 1000L
        val hardCap = startedAt + capSeconds * 1000L
        var lastGrowth = startedAt
        var seenChars = 0
        while (shouldExtend(
                android.os.SystemClock.elapsedRealtime(), until, hardCap, lastGrowth, stopRequested,
            )
        ) {
            // Republish on the tick this loop already runs, rather than from
            // `onPartialResults`: that callback fires as fast as the recognition
            // service produces hypotheses — many per second, each one a
            // recomposition of every screen collecting this flow, for text no eye
            // can follow at that rate. `snapshot()`, not `partial`, so a rolled
            // session shows the whole take instead of only its latest utterance.
            val text = snapshot()
            _partial.value = text
            // Growth by LENGTH, not by inequality. A rolled session can replace the
            // live utterance with a SHORTER re-reading of the same words (a fresh
            // recognizer starts from its first hypothesis again), and counting that
            // as new speech would hold the microphone open through silence.
            if (text.length > seenChars) {
                seenChars = text.length
                lastGrowth = android.os.SystemClock.elapsedRealtime()
            }
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
        // The route is read HERE, one line before the `finally` lowers the link —
        // the last moment it is still a fact. `viaBt` alone would not do: it is
        // this rail's answer to "did I raise it", and a take that rode a link the
        // HUD had already raised gets `true` from `joinIfUp` — but so would a rail
        // reading a stale local flag after another holder dropped it. Ask BtMic,
        // which is the thing that knows.
        Heard(snapshot(), route(BtMic.active))
        } finally {
            // ⚠️ The UNDO of the acquire above, not the next step in a list. A
            // cancelled take (the caller's window elapsed, the app was killed) runs
            // this and nothing else — and a take that threw must not leave a headset
            // holding the phone's audio in call mode. No-op when no glasses were worn,
            // which is most takes, and BtMic keeps the link up if the HUD is still
            // transcribing through it.
            BtMic.release(app, BT_OWNER)
        }
    }

    /**
     * File words this phone heard from somewhere OTHER than a take — the
     * necklace's own live audio ([LiveScribe]), iOS `storeHeard` parity.
     *
     * Shares [fileTranscript]'s rail rather than posting its own body, so a
     * live segment lands in exactly the same two places a take does (the
     * durable transcripts list and the agent's next turn) and falls back the
     * same way when the transcript route isn't deployed.
     *
     * @param audioFile a file ALREADY written into [audioDir]. Optional because a
     *   segment whose audio failed to write must still store its words: losing the
     *   recording is bad, losing the transcript with it is worse. It is RENAMED to
     *   the server's row id on success — see [claimAudio] for why that, and not a
     *   local index, is how the join is made on this phone.
     */
    suspend fun storeHeard(
        app: TinyApp,
        text: String,
        label: String,
        seconds: Int,
        audioFile: String? = null,
    ) {
        val id = java.util.UUID.randomUUID().toString()
        val serverId = fileTranscript(app, Take(true, text, id, seconds), label)
        claimAudio(app, audioFile, serverId)
    }

    /**
     * The directory live-segment audio lives in, or null if it can't be made.
     *
     * `filesDir`, not the cache: the cache is the OS's to reclaim whenever it likes,
     * and a row whose Play button works until Android is short on space is worse than
     * one that never had audio. The budget in [LiveTranscribe.audioEvictions] is what
     * bounds it instead — deliberately ours to enforce, not the system's to guess.
     */
    fun audioDir(app: TinyApp): java.io.File? =
        java.io.File(app.filesDir, "live-audio").takeIf { it.isDirectory || it.mkdirs() }

    /**
     * Rename a just-written segment file to the id the SERVER filed its row under.
     *
     * ⚠️ THE JOIN, and why it is a filename rather than an index. iOS keeps
     * `index.json` because it owns the row; this app deliberately does not (see
     * [technology.tiny.app.ui.TranscriptsSheet]'s header — the server IS the list, and
     * a local index here would only be a second copy of text plus the stale-row bug
     * iOS hit twice). So the row can't carry a local pointer, which leaves the file
     * NAME as the only place to put one: `<serverId>.wav` is a lookup the sheet can do
     * with the id it already has, and it needs no schema and can never disagree with
     * the row.
     *
     * A segment whose POST never landed (no route, no credentials, offline) keeps no
     * audio: nothing will ever be able to address it, so it would be an orphan by
     * construction. Deleting it here is cheaper than waiting for the sweep, and says
     * out loud that an unaddressable recording is not kept.
     */
    private fun claimAudio(app: TinyApp, audioFile: String?, serverId: String?) {
        val dir = audioDir(app) ?: return
        val src = audioFile?.let { java.io.File(dir, it) }?.takeIf { it.isFile } ?: return
        // The NAME is the rule, and it lives in LiveTranscribe.claimedAudioName where a
        // test can read it — null means no row can address this file, so keeping it
        // would only leave an orphan for the sweep to find ten minutes later.
        val claimed = LiveTranscribe.claimedAudioName(serverId)
            ?: run { runCatching { src.delete() }; return }
        runCatching { src.renameTo(java.io.File(dir, claimed)) }
            .onFailure { runCatching { src.delete() } }
    }

    /**
     * The kept audio for a transcript row, or null when it owns none.
     *
     * Reads the join through the same [LiveTranscribe.claimedAudioName] that WROTE it:
     * two call sites spelling `"$id.wav"` independently is a join that can drift into
     * a Play button pointing at nothing.
     */
    fun audioFor(app: TinyApp, rowId: String): java.io.File? =
        LiveTranscribe.claimedAudioName(rowId)
            ?.let { name -> audioDir(app)?.let { java.io.File(it, name) } }
            ?.takeIf { it.isFile }

    /**
     * Bound the kept audio: drop the oldest past the budget, and collect the pending
     * files nothing will ever claim. Both rules live in [LiveTranscribe].
     *
     * ⚠️ CALLED AT LAUNCH, and that is the point — not on a timer and not after each
     * segment. A necklace files one segment a minute for as long as its card is open,
     * and the process that wrote them may be killed at any moment, so the only moment
     * guaranteed to arrive is the next start. Skipping it is how a feature that keeps
     * audio becomes a feature that fills someone's phone: nothing else in this app
     * deletes from `live-audio/`, and the words survive either sweep regardless (they
     * are the server's).
     *
     * Never throws and never blocks a caller: a directory it can't read leaves the
     * disk exactly as it was, which is the mild direction to fail in.
     */
    fun sweepAudio(app: TinyApp) {
        val dir = audioDir(app) ?: return
        val files = dir.listFiles()?.filter { it.isFile } ?: return
        val now = System.currentTimeMillis()
        // Stat ONCE into a plain list: `lastModified()`/`length()` are syscalls, and
        // the two rules below would otherwise disagree about a file the necklace is
        // writing between them.
        val seen = files.map { Triple(it.name, now - it.lastModified(), it.length().toInt()) }
        // BOTH doors in one pure call (LiveTranscribe.audioSweep), so that the property
        // neither rule can state alone — that no file escapes both — is provable.
        for (name in LiveTranscribe.audioSweep(seen, LiveTranscribe.LIVE_AUDIO_BUDGET)) {
            runCatching { java.io.File(dir, name).delete() }
        }
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
     *
     * @return the id the SERVER filed this transcript under, or null if it never
     *   landed there (no credentials, or the request fell through to the event ring).
     *   [storeHeard] uses it to name the row's audio file; a take has nothing to join.
     */
    private suspend fun fileTranscript(app: TinyApp, take: Take, label: String): String? {
        val text = take.text.trim().ifEmpty { "(silence)" }
        val voice = NiclaVoiceGateway.credentials(app)
        val phone = app.auth.deviceId?.let { id -> app.auth.deviceToken?.let { id to it } }
        val creds = voice ?: phone ?: return null

        val body = JSONObject()
            .put("deviceId", creds.first)
            .put("token", creds.second)
            .put("text", text)
            .put("label", label)
            .put("durationS", take.seconds)
        val res = runCatching { app.api.postJson("/api/devices/transcript", body) }.getOrNull()
        if (res?.optBoolean("ok", false) == true) {
            // Take the server's id, don't just check `ok` (iOS's own lesson). Every
            // id-addressed use — the full-text fetch, and the audio filename this
            // return value names — needs the id the WORKER filed the row under, not
            // the local UUID nothing server-side has ever seen.
            return res.optString("id").trim().takeIf { it.isNotEmpty() }
        }

        runCatching {
            app.api.postJson(
                "/api/devices/event",
                JSONObject()
                    .put("deviceId", creds.first)
                    .put("token", creds.second)
                    .put("kind", "device_note")
                    // Budgeted, not sliced at a hopeful number: this rail files no
                    // row, so what the worker cuts here is gone. See [noteDetail].
                    .put("detail", noteDetail(label, text)),
            )
        }
        // The event ring has no row to address, so a caller holding audio must not
        // keep it: see claimAudio.
        return null
    }
}

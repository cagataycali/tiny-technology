package technology.tiny.app.fleet

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import technology.tiny.app.TinyApp

/**
 * 🗣️ Drives SpeechRecognizer over the necklace's audio stream — the impure half
 * of iOS `7d81ac87`/`f0c524dd`, whose rules live in [LiveTranscribe].
 *
 * ⚠️ THE ONE REAL PLATFORM DIFFERENCE, and it is not a shortcut. iOS appends
 * `AVAudioPCMBuffer`s straight into an `SFSpeechAudioBufferRecognitionRequest`.
 * Android's `SpeechRecognizer` has no such door: it opens audio itself. Since
 * API 33 it will instead READ A CALLER'S STREAM, given
 * `EXTRA_AUDIO_SOURCE` + a `ParcelFileDescriptor` — so the board's conditioned
 * PCM is written down a pipe whose read end the recognizer owns. Below API 33
 * there is no such door at all and this reports that in words rather than
 * transcribing silently to nothing.
 *
 * The phone's own microphone is NEVER opened here, which is why this cannot
 * collide with VoiceMode or a [PhoneRecorder] take over [MicClaim] — there is
 * nothing to contend for. It is also why the [MicClaim] dance is deliberately
 * absent, rather than forgotten.
 *
 * Recognition is on-device wherever the phone supports it. This is a
 * continuously open microphone in someone's home and it must not become a
 * stream of household audio to a server.
 *
 * ONE session reports ONE utterance and then goes quiet while still accepting
 * audio, so a segment is necessarily several sessions stitched together — see
 * [LiveTranscribe.shouldRestart] and [LiveTranscribe.bank] for why that
 * stitching is the difference between a transcript and 450 characters of sliding
 * fragments.
 */
internal class LiveScribe(private val app: TinyApp) {

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(Dispatchers.IO)

    private var recognizer: SpeechRecognizer? = null
    private var sink: ParcelFileDescriptor.AutoCloseOutputStream? = null

    /** Utterances already finished in this segment, stitched. */
    private var banked: List<String> = emptyList()

    /** What the live session has said so far. */
    @Volatile private var live = ""

    /** The live session ended — it will accept audio forever and do nothing. */
    @Volatile private var ended = false

    /** It ended by REPORTING an utterance, not by hearing nothing. See owedReplay. */
    @Volatile private var deliveredUtterance = false

    private var sessionStartedAt = 0L
    private var segmentStartedAt = 0L
    private var lastPublish = 0L

    /**
     * The recent past, replayed to a session that died mid-utterance.
     *
     * Those syllables exist NOWHERE else: the dying session never reported them.
     */
    private val preroll = ArrayDeque<ByteArray>()
    private var prerollBytes = 0

    /** Once this is set, every later chunk is dropped without re-failing. */
    private var dead = false

    /**
     * Feed one conditioned chunk. Never throws — a stream that plays must not be
     * killed by a recognizer that won't start.
     */
    fun feed(pcm: ByteArray, length: Int) {
        if (dead || length <= 0) return
        runCatching { feedInner(pcm, length) }.onFailure {
            Log.w("TinyScribe", "feed failed: ${it.message}")
        }
    }

    private fun feedInner(pcm: ByteArray, length: Int) {
        val now = android.os.SystemClock.elapsedRealtime()
        val chunk = pcm.copyOf(length)

        // Hold the recent past BEFORE anything else, so a restart triggered by
        // this very chunk still has the audio that preceded it.
        preroll.addLast(chunk)
        prerollBytes += chunk.size
        while (prerollBytes > LiveTranscribe.PREROLL_SAMPLES * 2 && preroll.size > 1) {
            prerollBytes -= preroll.removeFirst().size
        }

        if (recognizer == null) {
            if (!open()) return
        } else if (LiveTranscribe.shouldRestart(ended, deliveredUtterance, now - sessionStartedAt)) {
            restart()
        }

        runCatching { sink?.write(chunk) }.onFailure {
            // A broken pipe means the recognizer closed its read end — the session
            // is over whether or not a callback said so. Treat it as an ending
            // that heard nothing, which is the rate-limited path.
            ended = true
            deliveredUtterance = false
        }

        // 4/second reads as live and costs nothing; a chunk-rate publish would
        // recompose the overlay ~30×/second for text that changes far slower.
        if (now - lastPublish >= 250) {
            lastPublish = now
            val t = LiveTranscribe.segmentText(banked, live)
            if (t != TinyLiveScribeBridge.text()) TinyLiveScribeBridge.publish(t)
        }

        if (segmentStartedAt > 0 && now - segmentStartedAt >= LiveTranscribe.SEGMENT_MS) {
            rotate()
        }
    }

    /**
     * Build a session reading from a fresh pipe. False if this phone can't.
     *
     * Every refusal is REPORTED and sets [dead]: leaving it unset means the next
     * chunk re-enters here and re-fails, 30 times a second, and leaving it
     * unreported means the panel shows a playing stream with no words and no
     * reason — indistinguishable from a quiet room.
     */
    private fun open(): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 33) {
            // Below API 33 SpeechRecognizer cannot read a caller's stream at all.
            // Said plainly, because the alternative — opening the phone's mic to
            // transcribe the NECKLACE — would file the wrong room's audio under
            // the necklace's name.
            fail("Reading the necklace's audio needs Android 13 or newer.")
            return false
        }
        if (!SpeechRecognizer.isRecognitionAvailable(app)) {
            fail("Speech recognition isn't available on this phone.")
            return false
        }
        val pipe = runCatching { ParcelFileDescriptor.createPipe() }.getOrNull() ?: run {
            fail("Couldn't open an audio pipe for speech recognition.")
            return false
        }
        val read = pipe[0]
        val write = pipe[1]

        val onDevice = runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(app) }
            .getOrDefault(false)
        val rec = runCatching {
            // On-device where the phone supports it: a necklace's microphone is
            // open continuously in someone's home, so the default of shipping it
            // to a server is the wrong one here even though it recognizes better.
            if (onDevice) SpeechRecognizer.createOnDeviceSpeechRecognizer(app)
            else SpeechRecognizer.createSpeechRecognizer(app)
        }.getOrNull() ?: run {
            runCatching { read.close(); write.close() }
            fail("Couldn't start speech recognition on this phone.")
            return false
        }

        live = ""
        ended = false
        deliveredUtterance = false
        sessionStartedAt = android.os.SystemClock.elapsedRealtime()
        if (segmentStartedAt == 0L) segmentStartedAt = sessionStartedAt

        val lang = java.util.Locale.getDefault().toLanguageTag()
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            // The board's format, stated exactly: tiny_stream.py serves PCM16LE
            // 16kHz mono, and a wrong sampling rate here transcribes to plausible
            // nonsense rather than failing.
            .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, read)
            .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, android.media.AudioFormat.ENCODING_PCM_16BIT)
            .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16_000)
            .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)

        // The recognizer must be built and driven from the main looper.
        main.post {
            rec.setRecognitionListener(object : RecognitionListener {
                override fun onPartialResults(results: Bundle?) {
                    results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.takeIf { it.isNotBlank() }?.let { live = it }
                }

                override fun onResults(results: Bundle?) {
                    results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.takeIf { it.isNotBlank() }?.let { live = it }
                    // A final result means an utterance WAS reported, so the
                    // speaker is probably still going and the replacement session
                    // is needed now — and this session is owed no replay.
                    deliveredUtterance = true
                    ended = true
                }

                override fun onError(error: Int) {
                    // A quiet room ends a session with NO_MATCH / SPEECH_TIMEOUT
                    // having reported nothing. Treating those as urgent is what
                    // produced 316 restarts in 125s on iOS and destroyed
                    // recognition outright, so they take the rate-limited path.
                    deliveredUtterance = false
                    ended = true
                }

                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            runCatching { rec.startListening(intent) }.onFailure {
                Log.w("TinyScribe", "startListening failed: ${it.message}")
                ended = true
            }
        }

        recognizer = rec
        sink = ParcelFileDescriptor.AutoCloseOutputStream(write)
        TinyLiveScribeBridge.note(null)
        return true
    }

    /**
     * One session ended — keep its words and open the next, WITHOUT ending the
     * segment. The user is mid-conversation; only the recognizer restarted.
     */
    private fun restart() {
        val owed = LiveTranscribe.owedReplay(deliveredUtterance)
        banked = LiveTranscribe.bank(banked, live)
        tearDownSession()
        if (!open()) return
        if (owed) {
            // Replay the ring: the syllables spoken while the last session was
            // dying were never reported anywhere else. The overlap this creates
            // is trimmed word-wise by bank(), or a segment stores one sentence
            // twice and the agent reads it as two things being said.
            for (b in preroll) runCatching { sink?.write(b) }
        }
    }

    /** Close the current segment, file it, and open the next. */
    private fun rotate() {
        finish()
        open()
    }

    private fun tearDownSession() {
        val rec = recognizer
        recognizer = null
        runCatching { sink?.close() }
        sink = null
        // stopListening (not destroy) so the session delivers the tail it already
        // captured; destroy on the main looper, where it was built.
        main.post { runCatching { rec?.stopListening() }; runCatching { rec?.destroy() } }
    }

    /**
     * End the segment and store it if anyone actually spoke.
     *
     * Checks the BANK as well as the live session: a segment whose last session
     * died quiet still holds everything banked before it, and the last thing a
     * stream does is fall quiet — so this is the common case, not an edge one.
     */
    private fun finish() {
        val startedAt = segmentStartedAt
        banked = LiveTranscribe.bank(banked, live)
        val text = LiveTranscribe.segmentText(banked, "")
        val seconds = LiveTranscribe.segmentSeconds(
            android.os.SystemClock.elapsedRealtime() - startedAt)
        tearDownSession()
        banked = emptyList()
        live = ""
        preroll.clear(); prerollBytes = 0
        segmentStartedAt = 0L
        TinyLiveScribeBridge.publish("")
        if (startedAt == 0L || !LiveTranscribe.worthStoring(text)) return
        // Same rail as a phone-mic take: the transcripts list AND the agent's
        // context. Labelled by SOURCE so the model can tell the necklace's own
        // microphone from a take the phone recorded — and filed by the PHONE's
        // token, because attributing Vision-heard words to the Voice would put
        // them in the mouth of hardware that was not in the room.
        scope.launch {
            runCatching { PhoneRecorder.storeHeard(app, text, "necklace-live", seconds) }
                .onFailure { Log.w("TinyScribe", "store failed: ${it.message}") }
        }
    }

    /** Stream over: close the segment so the last thing said isn't dropped. */
    fun close() {
        if (dead && banked.isEmpty() && live.isBlank()) { tearDownSession(); return }
        finish()
    }

    private fun fail(why: String) {
        dead = true
        TinyLiveScribeBridge.note(why)
    }
}

/**
 * The one-way door from [LiveScribe] back to [TinyLive]'s published flows.
 *
 * A tiny indirection on purpose: it keeps [LiveScribe] free of the object it is
 * owned by, so the whole session driver can be reasoned about (and its callbacks
 * read) without the streaming state machine in view.
 */
internal object TinyLiveScribeBridge {
    private var last = ""
    fun text(): String = last
    fun publish(t: String) { last = t; TinyLive.publishLiveText(t) }
    fun note(why: String?) { TinyLive.publishScribeNote(why) }
}

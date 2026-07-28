package technology.tiny.app.chat

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * TTS engine, one utterance at a time (iOS Speech.swift parity):
 * markdown scrubbed, 3000-char cap, speakingId drives play/stop card UI.
 *
 * Ducks the user's background audio (music/podcast) while speaking — the same
 * intent iOS states with AVAudioSession .duckOthers (Speech.swift:34, unduck
 * fixed in 645928e). Android does it via AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK:
 * hold focus for the duration, abandon on natural end/stop so the music swells
 * back. VoiceMode owns its own mic session and never routes through here.
 *
 * Also YIELDS to a focus LOSS the other way: a phone call, navigation prompt, or
 * another assistant seizing exclusive focus halts our speech (iOS gets this free
 * from AVAudioSession interruptions — Android must register a change listener or
 * TTS talks straight over the call). AUDIOFOCUS_LOSS/LOSS_TRANSIENT → stop; the
 * MAY_DUCK loss (a nav blip) is left alone since we're the one being ducked.
 */
class Speech(context: Context) {

    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    // Deliver focus-change callbacks on the main thread — stop() touches the TTS
    // engine + a StateFlow the UI observes, and the listener can fire from any thread.
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            // Lost focus to a phone call / another assistant (permanent or transient,
            // e.g. a call) — halt so we're not talking over it. iOS interruption-began.
            AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> stop()
            // AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: something short wants to duck US
            // (a nav prompt). We keep speaking, quieter — matches how we duck others.
        }
    }
    private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setOnAudioFocusChangeListener(focusListener, Handler(Looper.getMainLooper()))
        .build()
    @Volatile private var haveFocus = false

    private val _speakingId = MutableStateFlow<String?>(null)
    val speakingId: StateFlow<String?> = _speakingId

    private var ready = false
    private val tts = TextToSpeech(appContext) { status ->
        ready = status == TextToSpeech.SUCCESS
    }.apply {
        setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) { _speakingId.value = utteranceId }
            override fun onDone(utteranceId: String?) { endedNaturally(utteranceId) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { endedNaturally(utteranceId) }
        })
    }

    // A finished/failed utterance clears the card + unducks ONLY if it's still the
    // current one. A superseded utterance (QUEUE_FLUSH replaced A with B) fires its
    // late onDone/onError with A's id while _speakingId is already B — matching
    // iOS's utterance-identity guard, it must NOT unduck mid-speech (the audible
    // duck→undock→reduck blip iOS's halt()/deactivateSession() split avoids).
    private fun endedNaturally(utteranceId: String?) {
        if (_speakingId.value == utteranceId) {
            _speakingId.value = null
            abandonFocus()
        }
    }

    fun speak(text: String, id: String) {
        if (!ready) return
        val clean = scrub(text)
        if (clean.isBlank()) return
        applyVoice(voiceIdPref())
        requestFocus() // duck background audio for the utterance's duration
        tts.speak(clean, TextToSpeech.QUEUE_FLUSH, null, id)
        _speakingId.value = id
    }

    /**
     * Settings preview (iOS Speech.preview parity) — speak a sample with an
     * explicit voice (null = system default) without going through the auto-speak
     * gate. Same duck-and-play path as speak(); the picker passes the row's voice
     * so the user hears a choice BEFORE committing it.
     */
    fun preview(text: String, voiceId: String?) {
        if (!ready) return
        applyVoice(voiceId)
        requestFocus()
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, PREVIEW_ID)
        _speakingId.value = PREVIEW_ID
    }

    /**
     * Voices whose locale matches the user's language or English, deduped by
     * name+locale, name-sorted (iOS Settings.voices parity). Empty until the
     * engine is ready or if the engine reports none. Network-only voices and
     * ones flagged not-installed are dropped — they'd fail silently at speak time.
     */
    fun voices(): List<Voice> {
        if (!ready) return emptyList()
        val langPrefix = java.util.Locale.getDefault().language
        val all = runCatching { tts.voices }.getOrNull()?.filterNotNull().orEmpty()
        return all
            .filter { it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true }
            .filter {
                val lang = it.locale.language
                lang == langPrefix || lang == "en"
            }
            .distinctBy { it.name }
            .sortedWith(compareBy({ it.locale.toLanguageTag() }, { it.name }))
    }

    /** Human label for a voice row: quality + locale (name is an opaque engine id). */
    fun voiceLabel(v: Voice): String {
        val q = when {
            v.quality >= Voice.QUALITY_VERY_HIGH -> "very high"
            v.quality >= Voice.QUALITY_HIGH -> "high"
            v.quality >= Voice.QUALITY_NORMAL -> "normal"
            else -> "low"
        }
        val net = if (v.isNetworkConnectionRequired) " · network" else ""
        return "${v.locale.displayName} · $q$net"
    }

    /** Apply a saved voice by name; null/blank/unknown → engine default for the locale. */
    private fun applyVoice(voiceId: String?) {
        if (voiceId.isNullOrBlank()) {
            tts.language = java.util.Locale.getDefault()
            return
        }
        val match = runCatching { tts.voices }.getOrNull()?.firstOrNull { it.name == voiceId }
        if (match != null) tts.voice = match else tts.language = java.util.Locale.getDefault()
    }

    private fun voiceIdPref(): String? =
        appContext.getSharedPreferences("tiny_config", Context.MODE_PRIVATE)
            .getString("cfg_voice_id", null)

    fun stop() {
        tts.stop()
        _speakingId.value = null
        abandonFocus()
    }

    private fun requestFocus() {
        // Idempotent: re-requesting while already held keeps the same duck (no blip)
        // — the back-to-back speak() case iOS handles by keeping the session in halt().
        if (haveFocus) return
        haveFocus = audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonFocus() {
        if (!haveFocus) return
        audioManager.abandonAudioFocusRequest(focusRequest)
        haveFocus = false
    }

    fun shutdown() {
        abandonFocus()
        tts.shutdown()
    }

    companion object {
        const val PREVIEW_ID = "settings-preview"

        /** Markdown scrub, mirrors iOS/web: fences replaced, inline noise stripped, 3000 cap. */
        fun scrub(text: String): String = text
            .replace(Regex("```[\\s\\S]*?```"), " code block omitted ")
            .replace(Regex("`([^`]*)`"), "$1")
            .replace(Regex("!?\\[([^\\]]*)]\\([^)]*\\)"), "$1")
            // Replace markdown-noise chars with a SPACE, not "" — web (voice.ts:37,
            // tts.ts:118) and iOS (Speech.swift:104) both use a space. Stripping to
            // "" jams word boundaries the mark separated: a table row "cell1|cell2"
            // or "word*emphasis" would speak as "cell1cell2"/"wordemphasis" here but
            // "cell1 cell2"/"word emphasis" everywhere else. The \s+ collapse below
            // absorbs any doubled space, so this can't introduce gaps.
            .replace(Regex("[*_#>|]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(3000)
    }
}

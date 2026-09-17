package technology.tiny.app.chat

import android.content.Context
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
 * fixed in 645928e) — and YIELDS to a focus LOSS the other way, so a phone call
 * or another assistant halts our speech instead of being talked over (iOS gets
 * that free from AVAudioSession interruptions; Android must ask).
 *
 * ⚠️ Both now go through [AudioDuck], which owns the app's ONE focus request, and
 * this class must NOT build its own again. It used to, and that was correct only
 * while it was the app's sole requester. iOS asks for `.duckOthers` on three
 * rails; the moment the mic rails ask too, a second request object in this same
 * process STEALS focus from the first and fires its listener with
 * LOSS_TRANSIENT — the arm right below that halts speech. Voice mode opening its
 * mic would have cut off the tiny's own reply mid-sentence. One holder, joined by
 * name, is what makes three rails safe.
 */
class Speech(context: Context) {

    private val appContext = context.applicationContext

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

    // Idempotent, as it has to be: re-requesting while this rail already holds the
    // duck keeps the same duck (no blip) — the back-to-back speak() case iOS handles
    // by keeping the session in halt(). AudioDuck's holder map gives that for free,
    // since a name already in it is simply re-put.
    private fun requestFocus() =
        AudioDuck.acquire(appContext, DUCK_OWNER) { stop() }

    private fun abandonFocus() = AudioDuck.release(appContext, DUCK_OWNER)

    fun shutdown() {
        abandonFocus()
        tts.shutdown()
    }

    companion object {
        const val PREVIEW_ID = "settings-preview"

        /**
         * This rail's name in [AudioDuck]'s holder set.
         *
         * ⚠️ Distinct from voice mode's mic owner, and the two overlap on purpose —
         * see `VoiceMode.DUCK_OWNER`. `stop()` here runs on every barge-in.
         */
        private const val DUCK_OWNER = "tts"

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

/**
 * 🔉 AudioDuck — the app's ONE audio-focus holder, shared by every rail that
 * speaks as the tiny or listens for the user.
 *
 * iOS declares this intent on the audio session, and it declares it THREE times:
 * `.duckOthers` on `Speech.swift` (TTS), `Voice.swift` (dictation, :119/:185) and
 * `VoiceCall.swift` (:208, the live call). Android has no session to describe —
 * the counterpart is `requestAudioFocus`, and it had exactly ONE caller here
 * (`Speech`). So the user's music kept playing at full volume into both rails that
 * open the MICROPHONE: dictating a message and holding a live voice call both
 * competed with a podcast the phone was still playing, and the recognizer heard it.
 *
 * ⚠️ SHARED AND OWNED, because the obvious fix is the harmful one. Focus is
 * per-request-object, and the OS hands it to the newest requester: a second
 * `AudioFocusRequest` inside this same app would have STOLEN focus from the first
 * and called its listener with `AUDIOFOCUS_LOSS_TRANSIENT` — which is exactly what
 * `Speech` halts on. Voice mode requesting its own focus would therefore have cut
 * off the tiny's own reply mid-sentence, and each rail would keep stealing back
 * from the other. `VoiceMode`'s own comment feared this collision and skipped
 * focus entirely because of it; the fear was correct, the conclusion was not. ONE
 * request object for the whole app means a second rail joining is not an OS call at
 * all — no steal, no listener, no duck→unduck blip — and a real EXTERNAL loss (a
 * phone call, a navigation prompt, another assistant) reaches every rail at once.
 *
 * The holder set is [BtMic]'s arithmetic for [BtMic]'s reason: rails genuinely
 * overlap (voice mode speaks a reply while its recognizer rolls), and under a bare
 * boolean the first rail to FINISH would abandon focus while another was still
 * speaking — the music swells back over a sentence still being read.
 *
 * One gain type and one set of attributes for all three, faithfully: iOS asks for
 * `.duckOthers` on all three rails, so `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` (duck
 * them, don't stop them) is the matching request everywhere, and
 * USAGE_ASSISTANT/CONTENT_TYPE_SPEECH is true of every rail that holds it. Focus
 * attributes set ducking POLICY, not routing — `VoiceCall`'s own `AudioTrack`
 * still declares USAGE_VOICE_COMMUNICATION for its playback, and that is what
 * routes.
 */
package technology.tiny.app.chat

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

object AudioDuck {

    /** What a focus change means for a rail that is holding the duck. */
    enum class OnLoss {
        /** Something took exclusive focus (a phone call) — the rail must stop. */
        HALT,

        /** We are merely being ducked, or we GAINED — keep going, quieter. */
        KEEP,
    }

    /**
     * The polarity, as a pure function so it is RUN rather than source-read.
     *
     * `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK` is the one that must NOT halt: a
     * navigation blip wants to talk over us for a second, and we are the ones being
     * ducked — halting there would end a call because the phone said "turn left".
     * Everything that is not a real loss (including the GAIN callbacks) keeps going.
     */
    internal fun classify(change: Int): OnLoss = when (change) {
        AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> OnLoss.HALT
        else -> OnLoss.KEEP
    }

    /**
     * Every rail currently holding the duck, in join order, with what to call when
     * focus is genuinely lost.
     *
     * A MAP keyed by name, not a counter: a rail whose teardown runs twice (a
     * `finally` after a cancellation that already released is ordinary here) would
     * decrement a counter twice and unduck while another rail still speaks.
     */
    private val holders = linkedMapOf<String, () -> Unit>()

    /** The duck is currently ours — i.e. the user's music is quieted. */
    val active: Boolean get() = synchronized(this) { holders.isNotEmpty() }

    /** Who is holding it, for a diagnostic line. Empty when we hold no focus. */
    val heldBy: Set<String> get() = synchronized(this) { holders.keys.toSet() }

    /** What [dropHolder] found — the three cases a release has to tell apart. */
    internal enum class Drop {
        /** This rail never acquired. Touch nothing. */
        NOT_A_HOLDER,

        /** Removed, but another rail is still speaking or listening. */
        STILL_HELD,

        /** The last holder left — focus may be abandoned and the music swell back. */
        LAST,
    }

    /**
     * Join a duck this app ALREADY holds: record the rail and answer immediately,
     * with no OS call at all. False — and nothing recorded — when we hold nothing.
     *
     * ⚠️ RECORDS NOTHING ON FALSE, [BtMic]'s rule for [BtMic]'s reason: a rail
     * recorded as a holder of focus nobody ever requested would report a duck that
     * is not happening, and would abandon focus it never had.
     */
    internal fun joinIfHeld(owner: String, onLoss: () -> Unit): Boolean = synchronized(this) {
        if (holders.isEmpty()) return false
        holders[owner] = onLoss
        true
    }

    /** Record [owner] — the rail whose own request was just GRANTED. */
    internal fun noteHolder(owner: String, onLoss: () -> Unit) =
        synchronized(this) { holders[owner] = onLoss }

    /** [owner] is finished; which of the three [Drop] cases that turns out to be. */
    internal fun dropHolder(owner: String): Drop = synchronized(this) {
        if (owner !in holders) return Drop.NOT_A_HOLDER
        holders -= owner
        if (holders.isEmpty()) Drop.LAST else Drop.STILL_HELD
    }

    /**
     * A snapshot of every holder's halt action.
     *
     * ⚠️ A COPY, taken under the lock and invoked OUTSIDE it. Each callback is a
     * rail's `stop()`, and a rail's `stop()` calls [release] — invoking them while
     * holding this monitor would deadlock the app on the very event it exists to
     * handle (a phone call arriving mid-sentence).
     */
    internal fun lossTargets(): List<() -> Unit> = synchronized(this) { holders.values.toList() }

    /** Test-only: forget every holder (the object outlives a single test). */
    internal fun clearHolders() = synchronized(this) { holders.clear() }

    // Delivered on the MAIN thread: these callbacks stop TTS engines, destroy
    // recognizers and touch StateFlows the UI collects, and the system may call the
    // listener from any thread.
    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        if (classify(change) == OnLoss.HALT) lossTargets().forEach { it() }
    }

    /**
     * ⚠️ `by lazy`, not an eager `val`. This is an `object`, so an eager initializer
     * runs the first time ANY member is touched — including [classify] and the
     * holder arithmetic, which are pure and belong in a local JVM test. Under the
     * unit-test `android.jar` every one of these builders is an unmocked stub that
     * throws, so an eager field would make the pure functions untestable off-device
     * and there would be no executed proof of the polarity at all.
     */
    private val request: AudioFocusRequest by lazy {
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener(listener, Handler(Looper.getMainLooper()))
            .build()
    }

    /**
     * Duck the user's background audio for [owner], and register what to do if the
     * duck is taken away from us. Returns false only when the OS refuses.
     *
     * ⚠️ [owner] must be the SAME string the matching [release] passes, or that
     * rail's name is never removed and the user's music stays quiet for the life of
     * the process. Owners are `const val`s at their call sites, not literals typed
     * twice.
     */
    fun acquire(context: Context, owner: String, onLoss: () -> Unit): Boolean {
        // Already ducked: record the second holder and answer yes — the caller's
        // question is "is background audio quieted", and it is.
        if (joinIfHeld(owner, onLoss)) return true
        val am = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            ?: return false
        val granted = runCatching {
            am.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }.getOrDefault(false)
        if (granted) noteHolder(owner, onLoss) // only now: the duck is genuinely ours
        return granted
    }

    /**
     * [owner] is done; let the music swell back when nobody else is holding.
     *
     * Safe to call unconditionally — a rail that never acquired removes a name that
     * was never added and changes nothing.
     */
    fun release(context: Context, owner: String) {
        // ⚠️ NOT_A_HOLDER and STILL_HELD both mean "touch nothing", for DIFFERENT
        // reasons — the first never had the duck, the second is not the last to
        // leave. Collapsing either into "abandon it" unducks over a live sentence.
        if (dropHolder(owner) != Drop.LAST) return
        val am = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            ?: return
        runCatching { am.abandonAudioFocusRequest(request) }
    }
}

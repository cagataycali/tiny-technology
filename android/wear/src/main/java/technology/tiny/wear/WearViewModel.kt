package technology.tiny.wear

import android.app.Application
import android.speech.tts.TextToSpeech
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import technology.tiny.app.wear.WatchCore
import technology.tiny.app.wear.WatchTurn
import java.util.Locale
import java.util.UUID

/**
 * The wrist brain, wired for Compose (iOS WatchLink analog). Holds the token +
 * transcript, streams a turn through WearChat, and drives TTS. Transcript
 * survives relaunch via WearStore; a turn killed mid-stream is sanitized on
 * load so it never spins forever. Pure history/hygiene comes from the SHARED
 * WatchCore (unit-tested on the JVM in :app).
 */
class WearViewModel(app: Application) : AndroidViewModel(app) {

    private val store = WearStore(app)
    private val chat = WearChat(tokenProvider = { store.token })

    var token by mutableStateOf(store.token)
        private set
    val turns = mutableStateListOf<WatchTurn>().apply { addAll(store.loadTurns()) }
    val followups = mutableStateListOf<String>()
    var busy by mutableStateOf(false)
        private set
    var activeTool by mutableStateOf<String?>(null)
        private set
    var accentHex by mutableStateOf(store.accentHex)
        private set
    // Autoplay spoken replies on the wrist (iOS WatchSettings autoSpeak). Wrist-
    // local; a false value silences the speak tool's TTS.
    var autoSpeak by mutableStateOf(store.autoSpeak)
        private set
    // The chosen briefing prompt (iOS WatchSettings). null/blank → the default
    // (WearBriefing.resolve); Settings ticks the selected preset via isSelected.
    var briefingPrompt by mutableStateOf(store.briefingPrompt)
        private set
    // Fleet presence + unread mirrored from the phone (iOS absorbSnapshot parity).
    // Seeded from the cached snapshot so a relaunch shows presence COLD, before
    // the next phone push arrives.
    var snapshot by mutableStateOf(store.snapshot)
        private set

    private var tts: TextToSpeech? = null
    private var ttsReady = false

    init {
        tts = TextToSpeech(app) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.getDefault()
                ttsReady = true
            }
        }
        // Drain any phone→watch session push (token/accent/logout) and stay live.
        PhoneLinkService.Inbox.observe { loggedOut, tok, accent ->
            viewModelScope.launch(Dispatchers.Main) {
                if (loggedOut) onLoggedOut() else onLinked(tok, accent)
            }
        }
        // …and the fleet snapshot (presence + unread) shown at the top of chat.
        PhoneLinkService.SnapshotInbox.observe { snap ->
            viewModelScope.launch(Dispatchers.Main) {
                snapshot = snap
                // PhoneLinkService already persisted this to the store before
                // delivering (so the tile sees it even when the VM is dead); no
                // write-through needed here — just adopt the accent if we lack one.
                snap.accent?.let { if (accentHex == null) { store.accentHex = it; accentHex = it } }
            }
        }
    }

    /** Phone pushed a fresh session token / accent over the Data Layer. */
    fun onLinked(newToken: String?, accent: String?) {
        if (newToken != null) {
            store.token = newToken
            token = newToken
            // This wrist now holds a REAL session, so it is no longer harness state
            // the screenshot seeder may overwrite (WearHarness.mayOverwrite). The flag
            // tracks the provenance of what is stored now, not "a harness ran here".
            store.harnessSeeded = false
        }
        if (accent != null) {
            store.accentHex = accent
            accentHex = accent
        }
    }

    /** Phone signed out — scrub the wrist identity (iOS apply(loggedOut:)). */
    fun onLoggedOut() {
        store.logout()
        token = null
        turns.clear()
        followups.clear()
        accentHex = null
        snapshot = null // scrub fleet presence too — nothing lingers past sign-out
    }

    /** Ask tiny's briefing — the canned prompt from Settings (or the default),
     *  routed through the same pipe as a dictation but with the briefing steer so
     *  the server can tell it apart (iOS BriefingIntent parity). */
    fun askBriefing() = ask(WearBriefing.resolve(briefingPrompt), steer = WearBriefing.BRIEFING_STEER)

    /** Ask tiny's stored top follow-up (iOS FollowupIntent / W7) — but ONLY if one
     *  is still fresh (WearFollowup.resolve gates the 30-min window); a stale/absent
     *  one no-ops so a decayed face button does nothing. Consumed on ask so it can't
     *  be re-asked until the next turn suggests a new one (iOS nulls snap.followup). */
    fun askFollowup() {
        val stored = store.topFollowup ?: return
        val q = WearFollowup.resolve(stored.first, stored.second, System.currentTimeMillis()) ?: return
        store.topFollowup = null
        followups.clear() // the in-app chip row decays too, matching the face button
        ask(q, steer = WearFollowup.FOLLOWUP_STEER)
    }

    fun ask(prompt: String, steer: String = WRIST_STEER) {
        val q = prompt.trim()
        if (q.isEmpty() || busy) return
        val turnId = UUID.randomUUID().toString()
        turns.add(WatchTurn(id = turnId, q = q, a = "", done = false))
        busy = true
        followups.clear()
        activeTool = null

        // History = prior COMPLETED turns, Converse-shaped, capped (shared WatchCore).
        val history = WatchCore.history(turns.dropLast(1))
        var spoken: String? = null

        viewModelScope.launch {
            try {
                chat.stream(q, tiny = "tiny", history = history, steer = steer).collect { ev ->
                    when (ev) {
                        is WearEvent.Text -> mutate(turnId) { it.copy(a = it.a + ev.text) }
                        is WearEvent.Tool -> activeTool = ev.name
                        is WearEvent.Speak -> spoken = ev.text
                        is WearEvent.Followups -> {
                            followups.clear(); followups.addAll(ev.chips)
                        }
                        is WearEvent.Error -> mutate(turnId) { if (it.a.isEmpty()) it.copy(a = "⚠ ${ev.message}") else it }
                        WearEvent.Done -> Unit
                    }
                }
            } catch (_: Throwable) {
                mutate(turnId) { if (it.a.isEmpty()) it.copy(a = "⚠ couldn't reach tiny") else it }
            }
            // Finish the turn (unless a logout cleared it mid-stream).
            if (turns.any { it.id == turnId }) {
                mutate(turnId) { it.copy(a = WatchCore.finalizeAnswer(it.a), done = true) }
                while (turns.size > WatchCore.TURN_CAP) turns.removeAt(0)
                val answer = turns.firstOrNull { it.id == turnId }?.a
                // Persist tiny's top suggested follow-up + a completion timestamp so a
                // headless face tap can ask it later (iOS FollowupIntent's snap.followup/
                // followupAt). Stamped at turn end — WearFollowup.resolve gates freshness
                // at read time. Read on-main (followups is Compose state) before the IO hop.
                val topFollowup = followups.firstOrNull()?.takeIf { it.isNotBlank() }
                launch(Dispatchers.IO) {
                    store.saveTurns(turns.toList())
                    store.topFollowup = topFollowup?.let { it to System.currentTimeMillis() }
                    // Record THIS wrist exchange as the snapshot's last exchange (iOS
                    // parity — the tile then shows what tiny just said here). The
                    // timestamp lets a later phone push know the wrist chatted more
                    // recently, so its stale mirror won't clobber this one.
                    if (!answer.isNullOrEmpty()) rememberExchange(q, answer)
                }
            }
            busy = false
            activeTool = null
            spoken?.let { speak(it) }
        }
    }

    /** Read an answer aloud through the watch speaker / paired buds. Markdown scrub
     *  is the shared WatchCore.speakable (phone Speech.scrub twin — keeps inline
     *  code/link TEXT rather than dropping it, collapses whitespace, caps length). */
    fun speak(text: String) {
        if (!ttsReady || !autoSpeak) return
        tts?.speak(WatchCore.speakable(text), TextToSpeech.QUEUE_FLUSH, null, "wear-tts")
    }

    /** Toggle wrist TTS autoplay (Settings). Persisted so it survives relaunch. */
    fun toggleAutoSpeak(on: Boolean) {
        store.autoSpeak = on
        autoSpeak = on
    }

    /** Pick a briefing prompt (Settings presets). Persisted; null/blank clears back
     *  to the default. Named to avoid the JVM setter clash with the `var`. */
    fun chooseBriefing(prompt: String?) {
        store.briefingPrompt = prompt
        briefingPrompt = prompt
    }

    /** Fold a just-completed WRIST exchange into the cached snapshot (iOS
     *  TinyWatchApp writes lastQ/lastA/lastAt after a watch-side turn). Keeps the
     *  current presence/unread/accent; stamps lastAt = now so a later, older phone
     *  push won't overwrite it (WatchCore.incomingExchangeWins). Runs off-main. */
    private fun rememberExchange(q: String, a: String) {
        // RMW under the store's process-wide monitor: a phone push can merge the same
        // snapshot on another thread, so read→copy→write must be atomic or this fresh
        // wrist exchange (or the push's presence) is silently dropped.
        val updated = store.updateSnapshot { current ->
            (current ?: WatchSnapshot(0, 0, 0, accentHex, null, null)).copy(
                lastQ = q.take(60),
                lastA = a.take(120),
                lastAt = System.currentTimeMillis(),
            )
        }
        viewModelScope.launch(Dispatchers.Main) { snapshot = updated }
        // Re-render BOTH the tile and the last-exchange complication (shared with
        // the phone-push path) so a watch-side answer shows on the face too.
        WristSurfaces.refresh(getApplication())
    }

    private inline fun mutate(id: String, block: (WatchTurn) -> WatchTurn) {
        val i = turns.indexOfFirst { it.id == id }
        if (i >= 0) turns[i] = block(turns[i])
    }

    override fun onCleared() {
        tts?.shutdown()
        PhoneLinkService.Inbox.clear()
        PhoneLinkService.SnapshotInbox.clear()
        super.onCleared()
    }
}

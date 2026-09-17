package technology.tiny.app.ui

import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Podcasts
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.ui.theme.TinyAccent
import technology.tiny.app.ui.theme.TinyGray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Call recordings — past voice calls, replayable like podcast episodes
 * (iOS CallRecordingsView twin). Every finished call streams as ONE stitched
 * WAV from the worker (/voice/recording/:id — built on first listen, then
 * R2-cached). The list is session-authed (/api/voice/sessions); playback URLs
 * are the public-but-unguessable posture the replay assets already use.
 */
internal data class CallRecording(
    val id: String,
    val tiny: String,
    val startedAt: Long,
    val durationMs: Long,
    /** How many PCM segments the call journaled (`voice_sessions.segment_count`).
     *  Carried as a NUMBER, not the `> 0` boolean the filter uses it as: past
     *  ~30 segments the stitch cannot fit its 40MB cap, so this is the one field
     *  that predicts a refusal before the person taps play. See
     *  [CallRecordingRefusal.tooLong]. */
    val segmentCount: Long,
    /** ⚠️ Why the call ended, already translated by [CallOutcome] — null on a
     *  clean hangup. Carried because [CallRecordingsLoad.rows] ADMITS
     *  `status == "error"` rows and without this a call the voice service
     *  dropped drew exactly like one the person ended themselves. The reason
     *  reaches the app already (VOICE_LIST_SQL selects `error`,
     *  /api/voice/sessions passes rows through verbatim); it was dropped at
     *  this type. Translated at construction, so the raw worker-tail
     *  diagnostic (`upstream closed: 1011 …`) never reaches a Composable. */
    val outcome: String?,
)

/**
 * 🔴 Why a call ended, in the language of the person who asks — the Kotlin twin
 * of `lib/voice/outcome.ts` (iOS `CallOutcome` is the third).
 *
 * The recorded reason is a worker-tail diagnostic, and it stays that way in the
 * column on purpose: the close code and the exception text are what you want
 * when debugging. Showing one to the owner of the call would be the same
 * wrong-surface mistake pointing the other way, so the translation happens
 * here, where the reader is known.
 *
 * ⚠️ AN UNRECOGNISED REASON IS NOT SILENCE. A reason this map hasn't seen — a
 * new teardown arm in the worker, or a row from before the reason was wired —
 * must still say the call did not end normally, without inventing a cause.
 * Saying nothing is how the reason lost its reader in the first place.
 */
/**
 * 🔇 Why a recording won't play — the Kotlin twin of `lib/voice/playback.ts`.
 *
 * `/voice/recording/:id` is a route that STITCHES segments on first listen, and
 * it can decline: 409 still live, 413 over the 40MB stitch cap, 404 nothing
 * journaled, 424 no R2. This sheet handed that URL to `MediaPlayer` with
 * `setOnPreparedListener` and `setOnCompletionListener` and NO
 * `setOnErrorListener` — and `prepareAsync` reports failure asynchronously, so
 * the enclosing `runCatching` cannot see it (nothing throws). The row was left
 * mid-play forever, with the reason discarded unread.
 *
 * ⚠️ This sheet's LOAD path already learned exactly this, and says so: "`app.api`,
 * not a bare HttpURLConnection. Reaching past the house client is what threw the
 * status away." The play path then had no error channel at all.
 */
internal object CallRecordingRefusal {
    /** The generic answer for a refusal we can't read — and for a `MediaPlayer`
     *  error, which carries integer codes and never a body. All three clients
     *  share this sentence; the pins assert they agree. */
    const val UNKNOWN = "couldn't play this recording"

    /** ⚠️ KEYED ON THE WORKER'S OWN LITERALS — `voice-playback-refusal.test.ts`
     *  extracts every `json({ error: … }, 4xx)` that `voiceRecording` can return
     *  from `src/voice.ts` and proves this list covers them, so a sixth refusal
     *  added upstream fails a suite instead of quietly falling to the generic
     *  sentence. */
    private val REFUSALS = listOf(
        "call still in progress" to "this call is still going — reload in a moment",
        "call too long to stitch" to "this call is too long to replay in one piece",
        "no replay journaled for this session" to "this call wasn't recorded",
        "no audio journaled" to "this call's audio wasn't saved",
        "media store not provisioned" to "recordings are unavailable right now",
        // ⚠️ Needs a client bug to reach (the URL is built from a row id), but the
        // map's claim is that it covers EVERY refusal — an exception "because that
        // one can't happen" is how the next arm gets skipped too. Shares the
        // generic sentence deliberately: there is nothing useful to tell someone
        // about a malformed URL they never typed.
        "session id required" to UNKNOWN,
    )

    /** Worker `SEGMENT_BYTES`, and the stitch's 40MB worker-memory guard. */
    private const val SEGMENT_BYTES = 1_440_000L
    private const val STITCH_BYTE_CAP = 40_000_000L

    /**
     * Will this call's stitch CERTAINLY be refused for size?
     *
     * ⚠️ One-sided on purpose: "certainly refused", never "certainly fine".
     * `segment_count` sums both directions and only the final segment per
     * direction may be short, so `(n - 2) * SEGMENT_BYTES` is the guaranteed
     * floor on the stitched bytes. At 30 that floor exceeds the cap; at 29 it
     * does not. A row under the line is NOT promised a recording — every other
     * refusal is invisible from here — so this only ever adds a note.
     */
    fun tooLong(segmentCount: Long): Boolean {
        if (segmentCount < 3) return false
        return (segmentCount - 2) * SEGMENT_BYTES > STITCH_BYTE_CAP
    }

    /**
     * What to say when a recording won't play. ALWAYS a sentence.
     *
     * ⚠️ Never null, and that is the difference from [CallOutcome.text]: that one
     * describes a call, where "nothing to say" is the common and correct answer.
     * This is called only when a play attempt FAILED, and a failed play that says
     * nothing is the entire defect.
     */
    fun text(reason: String?): String {
        val r = (reason ?: "").trim()
        if (r.isEmpty()) return UNKNOWN
        // `contains`, not equality: a reason that reaches a client at all arrives
        // wrapped in the platform's own description of the failure.
        for ((needle, sentence) in REFUSALS) if (r.contains(needle)) return sentence
        return UNKNOWN
    }
}

internal object CallOutcome {
    /** The generic answer for an abnormal end whose reason we can't read. All
     *  three clients share this sentence; the pins assert they agree. */
    const val UNKNOWN = "ended unexpectedly"

    /** ⚠️ KEYED ON THE WORKER'S OWN LITERALS — `voice-call-outcome.test.ts`
     *  extracts every string `VoiceSession.teardown` can receive from
     *  `src/voice.ts` and proves this list covers them, so a sixth arm added
     *  upstream fails a suite instead of quietly falling to the generic
     *  sentence. The two prefix entries drop the diagnostic tail on purpose. */
    private val REASONS = listOf(
        Triple("upstream closed:", "the voice service closed the connection", true),
        Triple("upstream error:", "the voice service dropped", true),
        Triple("the client socket errored", "this device's connection dropped", false),
        Triple("the client went silent", "we stopped hearing this device", false),
        Triple("the call hit the maximum length", "the call hit the maximum length", false),
    )

    /**
     * What to say about a finished call, or null when there is nothing to say.
     *
     * Null means "this ended the way calls end" — a clean row with no recorded
     * reason. A badge on every row would say nothing; this one appears exactly
     * when the call did something the person didn't ask for.
     *
     * ⚠️ `status == "error"` with no reason is NOT null: every error row written
     * before the reason was wired looks like that, and the status alone is more
     * than the row said yesterday.
     */
    fun text(status: String?, error: String?): String? {
        val reason = (error ?: "").trim()
        if (reason.isNotEmpty()) {
            for ((needle, text, isPrefix) in REASONS) {
                if (if (isPrefix) reason.startsWith(needle) else reason == needle) return text
            }
            return UNKNOWN
        }
        return if (status == "error") UNKNOWN else null
    }
}

/**
 * 🔴 The rows GET /api/voice/sessions yields, or null with a reason — the split
 * iOS made at `rows(from:)` (`3eca0cfe`), for the same defect reached by a worse
 * road.
 *
 * The route answers exactly three ways: `200 {ok:true, sessions:[…]}`,
 * `401 {ok:false, error:"login required"}`, and `502 {ok:false, error:…}` when the
 * worker is unreachable. iOS decoded all three into a struct of optionals, so two
 * of them came back as an empty list and the screen said "No calls yet" about
 * someone's own archive.
 *
 * ⚠️ Android was worse in two ways at once. It reached past `app.api` to a bare
 * `HttpURLConnection`, and `conn.inputStream` THROWS on a 401 or a 502 (that is
 * `getErrorStream`'s job) — so `runCatching { … }.getOrNull()` collapsed every
 * refusal into one sentence, "Couldn't load calls — check your connection", which
 * on an expired session blames the network for the app's own state and sends the
 * reader at the wrong remedy. And because the bypass never saw a status, no
 * caption could ever name a cause. The other half of the collapse is [LoadFailure]'s
 * (`e24f07bf`): a 200 that isn't JSON. `JSONObject(text)` throws there too, so it
 * also became "check your connection" — the one place Android's raw-connection
 * bypass accidentally did the right thing, for the wrong reason.
 *
 * Split out of the load so all three answers are checkable without a network,
 * which is exactly what the old shape made impossible.
 */
internal object CallRecordingsLoad {
    /** A 2xx body must SAY it succeeded and carry the array; anything else is a
     *  failure, not an empty archive. `optJSONArray` returning null on a refusal
     *  body is the collapse — an absent key is not an empty list. */
    fun rows(res: JSONObject?): List<CallRecording>? {
        val body = LoadFailure.loaded(res, "sessions") ?: return null
        if (!body.optBoolean("ok")) return null
        val arr = body.optJSONArray("sessions") ?: return null
        val out = mutableListOf<CallRecording>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val status = o.optString("status")
            val dur = o.optLong("duration_ms")
            // Only finished calls stitch (live ones 409); hide sub-2s pocket dials
            // and zero-segment rows.
            // ⚠️ A zero count is "nothing we can offer", NOT "no audio exists".
            // Teardown's counters live only in the Durable Object's memory, so a
            // teardown on a fresh instance used to overwrite a real count with 0
            // while the PCM segments sat in R2 intact (fixed worker-side: the row
            // update is monotonic now). The filter is still right — a 0 row has no
            // mix markers, so its stitch really does 404 — but do not read it as
            // proof the call was lost.
            if ((status == "ended" || status == "error") && dur > 2_000 && o.optLong("segment_count") > 0) {
                out.add(
                    CallRecording(
                        id = o.optString("id"),
                        tiny = o.optString("tiny_name").ifBlank { "tiny" },
                        startedAt = o.optLong("started_at"),
                        durationMs = dur,
                        // ⚠️ `optString` returns "" for a JSON null AND for an
                        // absent key, which is exactly what `CallOutcome.text`
                        // treats as "no reason recorded" — so a legacy row and
                        // a clean hangup both fall to the status check, which
                        // is the intent. Do not "fix" this into a null.
                        outcome = CallOutcome.text(status, o.optString("error")),
                        segmentCount = o.optLong("segment_count"),
                    ),
                )
            }
        }
        return out.toList()
    }

    /** The reason, from the same rule the other six sheets use — so a 401 reads as
     *  an expired session and a 502 keeps the table's words, instead of both
     *  claiming the connection dropped.
     *
     *  ⚠️ The `?:` is not decoration. [rows] refuses two things the shape check
     *  cannot see — a 2xx saying `ok:false`, and a 2xx whose `sessions` isn't an
     *  array — and for those `LoadFailure.message` correctly reports no failure.
     *  Without the fallback the sheet would have neither rows nor a reason, which
     *  with `calls` left null is a spinner that never stops. Caught by
     *  `rows and caption never both exist, and never both miss`. Same fix Activity
     *  and the memory graph carry for their own body-level gates. */
    fun message(res: JSONObject?): String? =
        if (rows(res) != null) null
        else LoadFailure.contentMessage(res, "sessions", "your call recordings")
            ?: LoadFailure.unusableBody("your call recordings")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallRecordingsSheet(app: TinyApp, onDismiss: () -> Unit) {
    var calls by remember { mutableStateOf<List<CallRecording>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    // Bumped by the failure arm's retry — the devices sheet's idiom, so a reload is
    // one state change rather than a second copy of the load.
    var reloadKey by remember { mutableStateOf(0) }
    var playingId by remember { mutableStateOf<String?>(null) }
    // Transport for the playing episode (iOS seek-bar parity): elapsed/total
    // in ms; `scrubbing` parks the poll so the thumb doesn't fight the finger.
    var elapsedMs by remember { mutableStateOf(0f) }
    var totalMs by remember { mutableStateOf(0f) }
    var scrubbing by remember { mutableStateOf(false) }
    // Why a play failed, per call id. `prepareAsync` reports failure into
    // `setOnErrorListener` — which this sheet did not register, so a refusal
    // (413 over the stitch cap, 409 still live) left the row mid-play forever.
    var playError by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val player = remember { MediaPlayer() }
    DisposableEffect(Unit) { onDispose { player.release() } }

    // Half-second transport ticks while an episode plays.
    LaunchedEffect(playingId) {
        while (playingId != null) {
            if (!scrubbing) {
                runCatching {
                    if (player.isPlaying) {
                        elapsedMs = player.currentPosition.toFloat()
                        totalMs = player.duration.toFloat().coerceAtLeast(1f)
                    }
                }
            }
            kotlinx.coroutines.delay(500)
        }
    }

    LaunchedEffect(reloadKey) {
        val token = app.auth.token
        if (token == null) {
            // `calls` stays NULL like every other failure: it used to be set to an
            // empty list, which with the error arm now first is merely dead — but it
            // was the same lie in miniature, a signed-out reader's archive reported as
            // empty. One shape for "we have nothing to show", everywhere.
            error = "Sign in to see your call recordings."
            return@LaunchedEffect
        }
        // ⚠️ `app.api`, not a bare HttpURLConnection. Reaching past the house client
        // is what threw the status away: `conn.inputStream` THROWS on a 401/502, so
        // every refusal arrived as null and the screen guessed at the connection.
        // `getJson` keeps the code (as `_status`) and the server's own body.
        val res = withContext(Dispatchers.IO) {
            runCatching { app.api.getJson("/api/voice/sessions") }.getOrNull()
        }
        val fetched = CallRecordingsLoad.rows(res)
        if (fetched == null) {
            // One reason, from the shared rule — never "no calls yet" for an answer
            // that never came. `calls` stays null so the empty state can't be reached.
            error = CallRecordingsLoad.message(res)
            return@LaunchedEffect
        }
        error = null
        calls = fetched
    }

    fun toggle(call: CallRecording) {
        if (playingId == call.id) {
            runCatching { player.pause() }
            playingId = null
            return
        }
        runCatching {
            player.reset()
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            player.setDataSource("https://plugin.tiny.technology/voice/recording/${call.id}")
            player.setOnPreparedListener { it.start() }
            player.setOnCompletionListener { playingId = null }
            // ⚠️ THE ERROR CHANNEL, and it must be registered BEFORE
            // `prepareAsync`. `prepareAsync` reports a refusal asynchronously —
            // nothing throws — so the `runCatching` around this block never saw
            // it and the row stayed mid-play with a pause glyph over a transport
            // at 0:00. MediaPlayer yields integer codes and no body, so the
            // sentence here is the generic one; the diagnosis a person can act on
            // (too long to stitch) comes from `segmentCount` on the row instead.
            player.setOnErrorListener { _, _, _ ->
                playError = playError + (call.id to CallRecordingRefusal.text(null))
                playingId = null
                // true = handled; false would ALSO invoke the completion
                // listener, which would report a failed play as a finished one.
                true
            }
            // Cleared BEFORE the prepare, never after: the listener above can
            // fire during `prepareAsync`, and clearing afterwards would erase the
            // very sentence it just recorded.
            playError = playError - call.id
            player.prepareAsync()
            elapsedMs = 0f
            totalMs = call.durationMs.toFloat().coerceAtLeast(1f)
            playingId = call.id
        }.onFailure { playingId = null }
    }

    fun clockOf(ms: Float): String {
        val s = (ms / 1000).toInt()
        return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item {
                SheetTitle(Icons.Outlined.Podcasts, "call recordings")
                Spacer(Modifier.height(4.dp))
                Text(
                    "Finished voice calls, replayable like podcast episodes.",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
                Spacer(Modifier.height(12.dp))
            }
            when {
                // ⚠️ The failure arm goes FIRST, and it is the house shape (Jobs, My
                // Devices): the reason, plus something to do about it. A failed load
                // leaves `calls` null so the empty state is unreachable — which means
                // ordering the spinner first would have spun forever on every refusal.
                error != null -> item {
                    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Text(error!!, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { error = null; reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                calls == null -> item {
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                calls!!.isEmpty() -> item { Text("No calls yet — 📞 a tiny and it'll land here.", color = TinyGray) }
                else -> items(calls!!, key = { it.id }) { call ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            IconButton(onClick = { toggle(call) }) {
                                Icon(
                                    if (playingId == call.id) Icons.Outlined.PauseCircle else Icons.Outlined.PlayCircle,
                                    contentDescription = if (playingId == call.id) "Pause call with ${call.tiny}" else "Play call with ${call.tiny}",
                                    tint = TinyAccent,
                                    modifier = Modifier.size(34.dp),
                                )
                            }
                            Spacer(Modifier.width(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text("📞 ${call.tiny}", style = MaterialTheme.typography.bodyMedium)
                                val stamp = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())
                                    .format(Date(call.startedAt * 1000))
                                val mins = call.durationMs / 60_000
                                val secs = (call.durationMs / 1000) % 60
                                Text(
                                    "$stamp · $mins:${secs.toString().padStart(2, '0')}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TinyGray,
                                )
                                // Why the call ended, when it didn't end the way
                                // calls end. Absent on a clean hangup — a badge on
                                // every row says nothing. The duration just above
                                // is why this matters: a 0:20 row reads as a short
                                // call, so "the service dropped 20 seconds in" has
                                // to be ON the row. Already translated; the raw
                                // worker-tail text never reaches here.
                                call.outcome?.let { why ->
                                    Text(
                                        "⚠️ $why",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                                // ⚠️ Why the play failed — because MediaPlayer
                                // cannot say. Its refusal arrived in a listener
                                // this sheet never registered, so the row sat
                                // mid-play with nothing explaining it.
                                val why = playError[call.id]
                                if (why != null) {
                                    Text(
                                        "⚠️ $why",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                } else if (CallRecordingRefusal.tooLong(call.segmentCount)) {
                                    // Knowable before the tap: the count is
                                    // already on the row and ~30 segments cannot
                                    // fit the 40MB stitch cap.
                                    Text(
                                        "⚠️ this call is too long to replay in one piece",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = TinyGray,
                                    )
                                }
                            }
                            // Share the episode — the same public-but-unguessable
                            // WAV URL the player streams (iOS ShareLink parity).
                            val shareContext = androidx.compose.ui.platform.LocalContext.current
                            IconButton(onClick = {
                                val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(android.content.Intent.EXTRA_TEXT, "https://plugin.tiny.technology/voice/recording/${call.id}")
                                }
                                shareContext.startActivity(android.content.Intent.createChooser(send, "Share call recording"))
                            }) {
                                Icon(
                                    Icons.Outlined.Share,
                                    contentDescription = "Share call with ${call.tiny}",
                                    tint = TinyGray,
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        }
                        // Scrubber for the playing episode (iOS transport parity).
                        if (playingId == call.id && totalMs > 1f) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(clockOf(elapsedMs), style = MaterialTheme.typography.labelSmall, color = TinyGray)
                                Slider(
                                    value = elapsedMs.coerceIn(0f, totalMs),
                                    onValueChange = { scrubbing = true; elapsedMs = it },
                                    onValueChangeFinished = {
                                        runCatching { player.seekTo(elapsedMs.toInt()) }
                                        scrubbing = false
                                    },
                                    valueRange = 0f..totalMs,
                                    colors = SliderDefaults.colors(
                                        thumbColor = TinyAccent,
                                        activeTrackColor = TinyAccent,
                                    ),
                                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                                )
                                Text(clockOf(totalMs), style = MaterialTheme.typography.labelSmall, color = TinyGray)
                            }
                        }
                    }
                }
            }
        }
    }
}

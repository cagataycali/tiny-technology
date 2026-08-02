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
)

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
            // and zero-segment rows (no audio journaled — outage casualties; their
            // stitch 404s, the row is dead).
            if ((status == "ended" || status == "error") && dur > 2_000 && o.optLong("segment_count") > 0) {
                out.add(
                    CallRecording(
                        id = o.optString("id"),
                        tiny = o.optString("tiny_name").ifBlank { "tiny" },
                        startedAt = o.optLong("started_at"),
                        durationMs = dur,
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

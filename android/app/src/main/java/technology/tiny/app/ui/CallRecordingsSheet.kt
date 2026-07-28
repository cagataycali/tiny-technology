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
import java.net.HttpURLConnection
import java.net.URL
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
private data class CallRecording(
    val id: String,
    val tiny: String,
    val startedAt: Long,
    val durationMs: Long,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallRecordingsSheet(app: TinyApp, onDismiss: () -> Unit) {
    var calls by remember { mutableStateOf<List<CallRecording>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
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

    LaunchedEffect(Unit) {
        val token = app.auth.token
        if (token == null) {
            error = "Sign in to see your call recordings."
            calls = emptyList()
            return@LaunchedEffect
        }
        val fetched = withContext(Dispatchers.IO) {
            runCatching {
                val conn = URL("${app.config.serverBase}/api/voice/sessions").openConnection() as HttpURLConnection
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = 15_000
                conn.readTimeout = 15_000
                val body = conn.inputStream.bufferedReader().readText()
                val out = mutableListOf<CallRecording>()
                val arr = JSONObject(body).optJSONArray("sessions")
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val o = arr.getJSONObject(i)
                        val status = o.optString("status")
                        val dur = o.optLong("duration_ms")
                        // Only finished calls stitch (live ones 409); hide sub-2s
                        // pocket dials and zero-segment rows (no audio journaled —
                        // outage casualties; their stitch 404s, the row is dead).
                        if ((status == "ended" || status == "error") && dur > 2_000 && o.optLong("segment_count") > 0) {
                            out.add(
                                CallRecording(
                                    id = o.getString("id"),
                                    tiny = o.optString("tiny_name").ifBlank { "tiny" },
                                    startedAt = o.optLong("started_at"),
                                    durationMs = dur,
                                ),
                            )
                        }
                    }
                }
                out.toList()
            }.getOrNull()
        }
        if (fetched == null) error = "Couldn't load calls — check your connection."
        calls = fetched ?: emptyList()
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
                calls == null -> item {
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                error != null -> item { Text(error!!, color = TinyGray) }
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

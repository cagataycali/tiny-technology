package technology.tiny.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Notes
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.fleet.PhoneRecorder
import technology.tiny.app.ui.theme.TinyAccent
import technology.tiny.app.ui.theme.TinyGray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 🎙️ Transcripts — the recordings this phone made, read back.
 *
 * iOS `NiclaTranscriptsView` (`NiclaRecorder.swift:782`) ported. iOS's own bug at
 * `73e11eb4` was that a refreshed row held a 200-char `preview` and looked like the
 * whole take — it read back ~12% of a 120-second memo. **Android read back 0%.**
 *
 * [PhoneRecorder] files every take — the Record button on the Voice device panel,
 * a wake word, the agent's `nicla_voice_record` envelope — to
 * `POST /api/devices/transcript`, and then nothing in this app ever asked for one
 * back. Every other link was already whole: the worker stores up to 16KB
 * (`transcripts.ts` `TRANSCRIPT_TEXT_MAX`), `GET /transcript/list` returns previews
 * WITH `chars`/`truncated`, `GET /transcript?id=` returns the full text, the app
 * proxy session-auths both halves, and the agent's `nicla_voice_transcript` tool
 * reads them. **So the agent could quote back a memo that the phone which recorded
 * it could not show you** — and `Panels.kt` said so out loud ("Android has no
 * Transcripts screen to put one on either") for as long as the Record button has
 * existed.
 *
 * There is no local index here, deliberately, and that is the one real divergence
 * from iOS. iOS keeps `index.json` in Documents because it owns an audio FILE per
 * take; Android has none to own — `SpeechRecognizer` captures inside Google's
 * recognition-service process, so this app never sees the samples ([PhoneRecorder]'s
 * header states that amputation). With no audio to cache, a local index would only
 * be a second copy of text the server already holds, and the failure it invites is
 * the one iOS hit twice (a stale row that shadows the server's, and a schema change
 * that silently wipes the store). The server IS the list; a load failure says so
 * rather than showing an empty archive.
 */
internal data class TranscriptRow(
    val id: String,
    val label: String,
    /** What we can show today — the list `preview`, or the full text once fetched. */
    val text: String,
    /** True while [text] is only the server's `substr(text, 1, 200)`. */
    val isPreview: Boolean,
    /** Full length in characters, from the row's own `chars` — 0 when absent. */
    val chars: Int,
    val seconds: Int,
    /** `created` is unixepoch SECONDS (worker `transcripts.ts`), not millis. */
    val createdAt: Long,
    val audioUrl: String?,
)

/**
 * 🔴 The rows `GET /api/devices/transcript` yields, or null with a reason — the
 * split [CallRecordingsLoad] makes for the same reason, kept pure so all of it is
 * checkable without a network or a microphone.
 *
 * The route answers four ways and only one is a list: `200 {ok:true,transcripts:[…]}`,
 * `401 {ok:false,error:"login required"}`, `424 {ok:false,error:"registry unreachable"}`
 * when the worker is unreachable, and `404` when it has no such route deployed —
 * which is the state production has been in for the POST side's whole life (see
 * `PhoneRecorder.fileTranscript`'s `device_note` fallback, and `Activity.kt`'s note
 * that `device_note` "is the kind real takes land under today"). A refusal must
 * never render as an empty archive.
 */
internal object TranscriptsLoad {
    /**
     * Server-side `TRANSCRIPT_PREVIEW_CHARS` (`transcripts.ts:44`).
     *
     * Only a fallback: the row carries its own `truncated`, and trusting the flag is
     * both cheaper and right when the text happens to be exactly 200 characters.
     */
    const val previewChars = 200

    /**
     * ⚠️ `truncated` arrives as a JSON **boolean**, and that is not free.
     *
     * SQLite has no boolean type: `length(text) > 200` selects as 0/1, and the worker
     * normalizes it with `!!r.truncated` precisely so clients don't have to guess
     * (`transcripts.ts:171` — its comment names Swift's `as? Bool` returning nil for
     * the number 0). **The same trap is here in a different shape, and it is not the
     * one it looks like: `JSONObject.optBoolean` does NOT coerce numbers.** It reads
     * `true`/`false` and the STRINGS "true"/"false", and answers its default for the
     * number 1 — so the obvious `optBoolean("truncated", false)` would mark every row
     * of a rolled-back worker's response COMPLETE, which is this whole screen's bug
     * restored. Caught by `truncated survives SQLite's missing boolean type`.
     *
     * So each shape is read on purpose. The worker normalizes today; this is what
     * makes the client independent of that promise.
     *
     * The fallback direction matters more than the flag: when nothing says, a
     * preview at exactly the cut is assumed CUT. Being wrong costs one redundant GET
     * that rewrites the same text; the other direction silently presents a fragment
     * as a whole memo, which is the bug itself.
     */
    fun truncated(row: JSONObject): Boolean {
        when (val flag = row.opt("truncated")) {
            is Boolean -> return flag
            // 0/1 straight off `length(text) > 200`.
            is Number -> return flag.toInt() != 0
            // "true"/"false" — and anything else a stringly-typed layer might send,
            // where an unparseable value falls through to the length guess below.
            is String -> flag.trim().lowercase().let {
                if (it == "true" || it == "1") return true
                if (it == "false" || it == "0") return false
            }
        }
        return row.optString("preview").length >= previewChars
    }

    /** One list row → a [TranscriptRow], or null when it carries no id to fetch by. */
    fun row(o: JSONObject): TranscriptRow? {
        val id = o.optString("id").trim()
        if (id.isEmpty()) return null
        // A row can arrive with the FULL text (the `?id=` shape reuses this parser),
        // in which case there is nothing left to hydrate.
        val full = o.optString("text").takeIf { it.isNotEmpty() }
        val preview = o.optString("preview")
        return TranscriptRow(
            id = id,
            // The worker's own default when a take had no wake label.
            label = o.optString("label").trim().ifEmpty { "recording" },
            text = full ?: preview,
            isPreview = full == null && truncated(o),
            chars = o.optInt("chars"),
            seconds = o.optInt("duration_s"),
            createdAt = o.optLong("created"),
            audioUrl = o.optString("audio_url").trim().takeIf { it.isNotEmpty() },
        )
    }

    /**
     * The list, or null — never an empty list for an answer that never came.
     *
     * `ok:false` is checked even on a 2xx: this proxy words its refusals that way
     * ([CallRecordingsLoad] found the same shape), and `optJSONArray` returning null
     * on a refusal body is exactly the collapse that turns a 401 into "no recordings".
     */
    fun rows(res: JSONObject?): List<TranscriptRow>? {
        val body = LoadFailure.loaded(res, "transcripts") ?: return null
        if (!body.optBoolean("ok")) return null
        val arr = body.optJSONArray("transcripts") ?: return null
        return (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let { row(it) } }
    }

    /**
     * The reason, from the shared content rule — so a 401 reads as a session and a
     * 424 keeps "backend unavailable", instead of both blaming the connection.
     *
     * ⚠️ The `?:` is load-bearing, same as [CallRecordingsLoad.message]: [rows]
     * refuses two things the shape check cannot see (a 2xx saying `ok:false`, and a
     * 2xx whose `transcripts` isn't an array), and for those `contentMessage`
     * correctly reports no failure — leaving a sheet with neither rows nor a reason,
     * which is a spinner that never stops.
     */
    fun message(res: JSONObject?): String? =
        if (rows(res) != null) null
        else LoadFailure.contentMessage(res, "transcripts", "your transcripts")
            ?: LoadFailure.unusableBody("your transcripts")

    /** The full text of a `?id=` response, or null — the hydrate rail's one rule. */
    fun fullText(res: JSONObject?): String? {
        val body = LoadFailure.loaded(res, "transcript") ?: return null
        if (!body.optBoolean("ok")) return null
        return body.optJSONObject("transcript")?.optString("text")?.takeIf { it.isNotEmpty() }
    }

    /**
     * "1:58 · 1,712 chars" — the line under a take.
     *
     * `chars` is here because it is the only thing on screen that can contradict a
     * short-looking row: a 200-character preview of a 1,712-character memo says the
     * rest exists even before the ellipsis is noticed. Omitted when the server didn't
     * send it (a rolled-back worker) rather than shown as "0 chars".
     */
    fun sizeLine(seconds: Int, chars: Int): String {
        val clock = "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
        if (chars <= 0) return clock
        return "$clock · ${"%,d".format(Locale.US, chars)} chars"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TranscriptsSheet(app: TinyApp, onDismiss: () -> Unit) {
    var rows by remember { mutableStateOf<List<TranscriptRow>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    // Bumped by the retry arm — the devices/calls sheet idiom, so a reload is one
    // state change rather than a second copy of the load.
    var reloadKey by remember { mutableStateOf(0) }
    // Full texts fetched this session, by id: applied over `rows` at render so a
    // reload keeps them and a hydrate never has to rewrite the list.
    var hydrated by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // Ids with a GET in flight — a spinner instead of a second "Read in full", and
    // the reason a row scrolling off and back on cannot start the same fetch twice.
    var hydrating by remember { mutableStateOf<Set<String>>(emptySet()) }
    var recordError by remember { mutableStateOf<String?>(null) }
    val recording by PhoneRecorder.isRecording.collectAsState()
    val level by PhoneRecorder.level.collectAsState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(reloadKey) {
        if (app.auth.token == null) {
            // `rows` stays NULL like every other failure, so the empty state is
            // unreachable: a signed-out reader's archive is not an empty one.
            error = "Sign in to see your transcripts."
            return@LaunchedEffect
        }
        val res = withContext(Dispatchers.IO) {
            runCatching { app.api.getJson("/api/devices/transcript?limit=50") }.getOrNull()
        }
        val fetched = TranscriptsLoad.rows(res)
        if (fetched == null) {
            error = TranscriptsLoad.message(res)
            return@LaunchedEffect
        }
        error = null
        rows = fetched
    }

    /**
     * Pull one row's remaining words, at most one flight per id.
     *
     * `hydrating` is cleared on FAILURE too: a stuck spinner leaves the row with no
     * way to try again, which is worse than showing the button a second time.
     */
    fun hydrate(t: TranscriptRow) {
        if (!t.isPreview || hydrating.contains(t.id) || hydrated.containsKey(t.id)) return
        hydrating = hydrating + t.id
        scope.launch {
            val res = withContext(Dispatchers.IO) {
                runCatching { app.api.getJson("/api/devices/transcript?id=${t.id}") }.getOrNull()
            }
            TranscriptsLoad.fullText(res)?.let { hydrated = hydrated + (t.id to it) }
            hydrating = hydrating - t.id
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item {
                SheetTitle(Icons.Outlined.GraphicEq, "transcripts")
                Spacer(Modifier.height(4.dp))
                Text(
                    "Recordings this phone made. The audio is transcribed on-device; " +
                        "the words land here and in your tiny's context.",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
                Spacer(Modifier.height(12.dp))
            }

            // 🎙️ Record from the screen where the recordings live. Until now the only
            // hand-start was the Voice device panel — a different screen, and one that
            // shows nothing unless a necklace is paired to this phone, though the take
            // is the PHONE's mic and needs no board present (iOS made the same move).
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(
                        onClick = {
                            if (recording) {
                                PhoneRecorder.stopEarly()
                                return@OutlinedButton
                            }
                            scope.launch {
                                // Every refusal is a sentence ("the phone's mic is
                                // already in use…"); a Record button that silently
                                // does nothing is the worst version of that.
                                val take = PhoneRecorder.record(app, PhoneRecorder.MAX_SECONDS, "memo")
                                recordError = if (take.ok) null else (take.error ?: "Recording failed.")
                                // A finished take is on the server, not in this list —
                                // there is no local index to append to. Reload so the
                                // words the user just spoke are actually on screen.
                                if (take.ok) reloadKey++
                            }
                        },
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                        modifier = Modifier.heightIn(min = 44.dp),
                    ) {
                        Icon(
                            if (recording) Icons.Outlined.StopCircle else Icons.Outlined.Mic,
                            contentDescription = null,
                            tint = if (recording) MaterialTheme.colorScheme.tertiary else LocalContentColor.current,
                            modifier = Modifier.size(14.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            if (recording) "Stop and save" else "Record",
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                    if (recording) {
                        // The meter is the only proof the mic is really hearing you:
                        // muted, or face-down in a pocket, looks identical to a working
                        // take (the Voice panel carries the same bars for this reason).
                        Spacer(Modifier.width(8.dp))
                        Row(verticalAlignment = Alignment.Bottom) {
                            repeat(10) { i ->
                                val lit = level * 10 > i
                                Box(
                                    Modifier.padding(end = 2.dp)
                                        .size(width = 3.dp, height = (6 + (i % 4) * 3).dp)
                                        .background(
                                            if (lit) MaterialTheme.colorScheme.tertiary
                                            else TinyGray.copy(alpha = 0.3f),
                                            RoundedCornerShape(1.dp),
                                        ),
                                )
                            }
                        }
                    }
                }
                recordError?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
                }
                Spacer(Modifier.height(8.dp))
            }

            when {
                // ⚠️ The failure arm FIRST, and with something to do about it — the
                // house shape (Jobs, My Devices, call recordings). A failed load leaves
                // `rows` null, so ordering the spinner first would spin forever on
                // every refusal.
                error != null -> item {
                    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Text(error!!, color = MaterialTheme.colorScheme.error)
                        TextButton(
                            onClick = { error = null; reloadKey++ },
                            contentPadding = PaddingValues(0.dp),
                        ) {
                            Text(
                                "retry",
                                color = MaterialTheme.colorScheme.primary,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
                rows == null -> item {
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                rows!!.isEmpty() -> item {
                    Text(
                        "No transcripts yet — tap Record, or say the necklace's wake word.",
                        color = TinyGray,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                else -> items(rows!!, key = { it.id }) { t ->
                    val full = hydrated[t.id]
                    val partial = t.isPreview && full == null
                    // Hydrate as the row scrolls in rather than pre-fetching all 50 on
                    // open: one GET per transcript the reader actually looks at, which
                    // also makes the button below only ever a retry.
                    LaunchedEffect(t.id, reloadKey) { if (partial) hydrate(t) }
                    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Outlined.GraphicEq,
                                contentDescription = null,
                                tint = TinyAccent,
                                modifier = Modifier.size(15.dp),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(t.label, style = MaterialTheme.typography.labelMedium)
                            Spacer(Modifier.weight(1f))
                            if (t.createdAt > 0) {
                                Text(
                                    SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())
                                        .format(Date(t.createdAt * 1000)),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TinyGray,
                                )
                            }
                        }
                        // ⚠️ The ellipsis is the whole tell: a 200-char cut and a
                        // genuinely short memo are otherwise the same pixels, and the
                        // row reads as the complete take.
                        Text(
                            if (partial) (full ?: t.text) + "…" else (full ?: t.text),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                TranscriptsLoad.sizeLine(t.seconds, t.chars),
                                style = MaterialTheme.typography.labelSmall,
                                color = TinyGray,
                            )
                            if (partial) {
                                Spacer(Modifier.width(10.dp))
                                if (hydrating.contains(t.id)) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(12.dp),
                                        strokeWidth = 1.5.dp,
                                        color = TinyGray,
                                    )
                                } else {
                                    // Retry rail: the row hydrates itself on appear, so
                                    // this is what's left when that GET failed. Tapping
                                    // is the only way back to the rest of the words.
                                    TextButton(
                                        onClick = { hydrate(t) },
                                        contentPadding = PaddingValues(0.dp),
                                    ) {
                                        Icon(
                                            Icons.Outlined.Notes,
                                            contentDescription = null,
                                            tint = MaterialTheme.colorScheme.primary,
                                            modifier = Modifier.size(13.dp),
                                        )
                                        Spacer(Modifier.width(4.dp))
                                        Text(
                                            "Read in full",
                                            color = MaterialTheme.colorScheme.primary,
                                            style = MaterialTheme.typography.labelSmall,
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.weight(1f))
                            // ⚠️ Shares whatever is on screen, and only that: sharing
                            // `t.text` while a row is still a preview would hand someone
                            // 200 characters under the take's own label, silently.
                            val shareContext = androidx.compose.ui.platform.LocalContext.current
                            IconButton(
                                onClick = {
                                    val body = full ?: t.text
                                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                                        type = "text/plain"
                                        putExtra(
                                            android.content.Intent.EXTRA_TEXT,
                                            "${t.label} — $body" + if (partial) "…" else "",
                                        )
                                    }
                                    shareContext.startActivity(
                                        android.content.Intent.createChooser(send, "Share transcript"),
                                    )
                                },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    Icons.Outlined.Share,
                                    contentDescription = "Share ${t.label}",
                                    tint = TinyGray,
                                    modifier = Modifier.size(15.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

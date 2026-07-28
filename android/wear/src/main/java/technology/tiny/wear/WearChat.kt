package technology.tiny.wear

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Wrist chat client — a trimmed twin of the phone's TinyApi.chat SSE stream,
 * speaking the SAME /api/chat wire (flat `type` discriminator, [DONE] sentinel)
 * so the watch and phone can't drift. Only the events a wrist can act on are
 * surfaced: text (the answer), tool-start (the "running…" line), speak (read
 * aloud), and followups (tap-to-ask chips). Everything phone-only no-ops.
 */

const val WEAR_BASE_URL = "https://tiny.technology"
private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/** Wrist steering prefix prepended to every asked question — keeps the answer
 *  short and markdown-free for the small screen (iOS WatchLink.ask parity). */
const val WRIST_STEER = "[Asked from Wear OS watch — answer in 1-2 short sentences, no markdown]"

/** HTTP status → wrist-short human copy (phone friendlyHttpError, condensed). */
fun wearHttpError(code: Int): String = when {
    code == 401 -> "session expired — re-link on phone"
    code == 402 -> "this tiny charges per message"
    code == 403 -> "not allowed"
    code == 404 -> "tiny not found"
    code == 429 -> "daily limit reached"
    code in 500..599 -> "server hiccup — try again"
    else -> "request failed ($code)"
}

sealed interface WearEvent {
    data class Text(val text: String) : WearEvent
    data class Tool(val name: String) : WearEvent
    data class Speak(val text: String) : WearEvent
    data class Followups(val chips: List<String>) : WearEvent
    data class Error(val message: String) : WearEvent
    data object Done : WearEvent
}

class WearChat(private val tokenProvider: () -> String?) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // Idle read timeout (resets per event) — a healthy stream never trips it,
        // a dead half-open socket is torn down instead of hanging (phone parity).
        .readTimeout(300, TimeUnit.SECONDS)
        .build()

    /**
     * Stream a wrist turn. [history] is WatchCore.history output (byte-identical
     * to the phone's history array). The answer is steered wrist-short via the
     * message prefix — the same steering iOS uses.
     */
    fun stream(
        message: String,
        tiny: String,
        history: JSONArray,
        steer: String = WRIST_STEER,
    ): Flow<WearEvent> = callbackFlow {
        val body = JSONObject().put("messages", buildRequestMessages(history, message, steer))
        val builder = Request.Builder()
            .url("$WEAR_BASE_URL/api/chat")
            .header("Accept", "text/event-stream")
            .header("x-tiny-session", "tiny-wear")
            .header("x-tiny-name", tiny)
            .post(body.toString().toRequestBody(JSON_MEDIA))
        tokenProvider()?.let { builder.header("Authorization", "Bearer $it") }

        val source: EventSource = EventSources.createFactory(client).newEventSource(
            builder.build(),
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    if (data == "[DONE]") {
                        trySend(WearEvent.Done); close(); return
                    }
                    parse(data)?.let { trySend(it) }
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    val msg = response?.code?.let { wearHttpError(it) } ?: t?.message ?: "connection lost"
                    trySend(WearEvent.Error(msg)); close()
                }

                override fun onClosed(eventSource: EventSource) {
                    trySend(WearEvent.Done); close()
                }
            },
        )
        awaitClose { source.cancel() }
    }

    /**
     * Build the `messages` array for the /api/chat POST: the prior history
     * (WatchCore.history output) followed by the new user turn, whose text is
     * prefixed with [steer] (default [WRIST_STEER]) so the answer comes back 1-2
     * sentences, no markdown (the same steering iOS's WatchLink.ask uses). A
     * briefing passes WearBriefing.BRIEFING_STEER instead. Pure + internal so the
     * send-side wire contract is unit-tested, not just the parse side — the watch
     * and phone must not drift on the shape they POST.
     */
    internal fun buildRequestMessages(
        history: JSONArray,
        message: String,
        steer: String = WRIST_STEER,
    ): JSONArray {
        val messages = JSONArray()
        for (i in 0 until history.length()) messages.put(history.get(i))
        messages.put(
            JSONObject().put("role", "user").put(
                "content",
                JSONArray().put(JSONObject().put("text", "$steer $message")),
            ),
        )
        return messages
    }

    /** Parse one SSE frame into a wrist event (phone TinyApi.parseChatEvent
     *  subset). Internal + stateless so it can be unit-tested directly. */
    internal fun parse(data: String): WearEvent? {
        val o = runCatching { JSONObject(data) }.getOrNull() ?: return null
        return when (o.optString("type")) {
            "modelContentBlockDeltaEvent" ->
                o.optString("textDelta").takeIf { it.isNotEmpty() }?.let { WearEvent.Text(it) }
            "modelContentBlockStartEvent" ->
                o.optJSONObject("toolStart")?.optString("name")?.takeIf { it.isNotEmpty() }
                    ?.let { WearEvent.Tool(it) }
            "beforeToolCallEvent" -> {
                val call = o.optJSONObject("toolCall") ?: return null
                when (call.optString("name")) {
                    "speak" -> call.optJSONObject("input")?.optString("text")
                        ?.takeIf { it.isNotEmpty() }?.let { WearEvent.Speak(it) }
                    "suggest_followups" -> {
                        // Chips ride the `chips` key (phone ChatViewModel parity), capped at 4.
                        val chips = call.optJSONObject("input")?.optJSONArray("chips")
                        if (chips != null) {
                            WearEvent.Followups(
                                (0 until minOf(chips.length(), 4))
                                    .mapNotNull { chips.optString(it).takeIf(String::isNotEmpty) },
                            )
                        } else null
                    }
                    else -> null
                }
            }
            "error" -> WearEvent.Error(o.opt("error")?.toString() ?: "unknown error")
            else -> null
        }
    }
}

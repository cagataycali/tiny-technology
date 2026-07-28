package technology.tiny.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
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
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

const val BASE_URL = "https://tiny.technology"
// Public plugin worker — hosts the community tool marketplace (GET /tools/browse,
// no auth). Distinct host from BASE_URL; the Next app hits it directly too.
const val WORKER_URL = "https://plugin.tiny.technology"
private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/**
 * One HTTP-status → human-actionable message table (iOS Api.friendlyHTTPError,
 * 59b212a), shared by the SSE chat stream and the JSON verbs so the two can't
 * drift into disagreeing copies.
 *
 * NOTE 403 is an OWNERSHIP error (a tiny/share owned by another account) — NOT
 * an expired session, so it must NOT tell the user to sign in again (a cycle-46
 * bug grouped it with 401). 424 is the transient backend-degrade code that
 * /api/tools, /api/prefs and /api/wallet return — say "try again", not "failed".
 */
fun friendlyHttpError(code: Int): String = when {
    code == 401 -> "session expired — sign out and back in from the menu"
    code == 402 -> "this tiny charges per message — check /wallet or top up at tiny.technology/wallet"
    code == 403 -> "not allowed — this belongs to another account"
    code == 404 -> "that tiny doesn't exist"
    code == 413 -> "message or attachments too large"
    code == 424 -> "backend unavailable — take a breath, try again soon"
    code == 429 -> "daily limit reached — try again tomorrow"
    code in 500..599 -> "server hiccup (HTTP $code) — usually passes, try again"
    else -> "request failed (HTTP $code)"
}

/**
 * Warning shown when the monotonic stream `seq` jumps — frames were lost on the
 * wire. Both iOS (Api.swift:476) and web (Chat.tsx:1363) tell the user the REPLY
 * ITSELF may be incomplete, not just a raw count; Android reported only the count
 * and always said "events" (so a single dropped frame read the ungrammatical
 * "1 stream events dropped"). Pluralize + state the consequence for parity. The
 * ⚠ glyph is added by the note renderer (ChatViewModel), so it's omitted here.
 */
fun droppedNote(dropped: Int): String =
    "$dropped stream event${if (dropped == 1) "" else "s"} dropped — this reply may be incomplete"

sealed interface ChatEvent {
    data class TextDelta(val text: String) : ChatEvent
    data class ReasoningDelta(val text: String) : ChatEvent
    /** Out-of-band notice surfaced in the transcript (e.g. dropped SSE frames). */
    data class Note(val text: String) : ChatEvent
    data class ToolStart(val name: String, val toolUseId: String) : ChatEvent
    data class BeforeToolCall(val name: String, val toolUseId: String, val input: JSONObject) : ChatEvent
    /** [resultText] = first text block of the tool result body (spawn_agents batch JSON rides here). */
    data class AfterToolCall(
        val name: String,
        val toolUseId: String,
        val status: String?,
        val error: String?,
        val resultText: String? = null,
    ) : ChatEvent
    data class Metadata(
        val modelId: String?,
        val inputTokens: Int = 0,
        val outputTokens: Int = 0,
        // Cached input reads (bill at ~10% of the input rate) — carried so the $
        // cost estimate isn't inflated for long, cache-heavy conversations (web parity).
        val cacheReadInputTokens: Int = 0,
    ) : ChatEvent
    data class Result(val stopReason: String?) : ChatEvent
    // [paymentBody] carries the raw 402 JSON ({payment_required, price_micro,
    // balance_micro}) so the ViewModel can render an actionable paywall card
    // (WalletCore.parsePaywall) instead of a bare error line (web err.payment).
    data class Error(
        val message: String,
        val paymentRequired: Boolean = false,
        val paymentBody: String? = null,
    ) : ChatEvent
    data object Done : ChatEvent
}

// Steers render_ui toward props the native renderer can draw (componentCode
// never executes here) — same contract as the iOS platform note.
private val PLATFORM_NOTE = """
    📱 Native Android app: replies render in the tiny Android app. render_ui: componentCode does NOT run here — put the displayable data in `props` (e.g. {"data": [{"label": "Mon", "value": 12}, …]} plus a `title`); charts/key-values render natively from props. speak: plays through the phone speaker. vibrate: REALLY buzzes this phone — patterns (heartbeat/sos/wave/escalate/long…), repeats, intensity all work. flashlight: controls the real torch (on/off/blink). copy_to_clipboard / set_brightness / play_sound also act on THIS physical phone. screenshot: captures what's on THIS phone's screen and returns it to you as an image you can SEE — the user approves each capture via the system recording prompt (whole screen, can't see DRM-protected content). Keep replies mobile-width friendly.
""".trimIndent()

class TinyApi(
    private val tokenProvider: () -> String?,
    private val defaultTinyProvider: () -> String = { "tiny" },
    private val baseProvider: () -> String = { BASE_URL },
    // BYO-model headers (x-tiny-model-*) applied to every /api/chat request; empty
    // on the free default tier. Web ModelSettings.modelConfigHeaders() parity.
    private val modelHeadersProvider: () -> Map<String, String> = { emptyMap() },
) {
    private val base: String get() = baseProvider()

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // IDLE timeout on the SSE read, NOT a total cap: OkHttp readTimeout fails only
        // when NO bytes arrive for this long, and it resets on every event — so a healthy
        // stream (deltas + tool events flow continuously, and the worker caps the whole
        // turn at maxDuration 300s anyway) never trips it, while a half-open/dead TCP
        // connection that stalls with no FIN is torn down instead of hanging forever.
        // 300s mirrors iOS's URLRequest.timeoutInterval (Api.swift:201), which is the
        // same idle-timeout semantics. readTimeout(0) (infinite) previously wedged the
        // background relayLoop permanently on a stalled answer() — no user present to stop it.
        .readTimeout(300, TimeUnit.SECONDS)
        .build()

    // Every JSON verb needs a HARD ceiling — the SSE client's readTimeout(0) would
    // otherwise let a stalled half-open connection hang getJson/postJson forever,
    // leaving the panels that await them (Universe/Jobs/Devices/Memory/Messages,
    // which escape only when the call returns null) spinning with no route to their
    // empty/failed state. 30s = the web's AbortSignal.timeout house rule / iOS
    // Api.request timeoutInterval. callTimeout bounds the WHOLE call (connect+read).
    private val jsonClient = client.newBuilder()
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    // On-chain money-movers (withdraw payout) run FAR longer than a normal JSON
    // verb: the server route is maxDuration 60s + a 45s on-chain receipt wait
    // (~105s). A 30s client cap would abort mid-broadcast, return null, and the
    // caller would mislabel a possibly-broadcast transfer as "failed" — inviting
    // the double-pay retry the server's 202 pending_confirmation path exists to
    // prevent (iOS Wallet.swift dd133c1 raised its withdraw to 120s for exactly
    // this; web's fetch has no client cap so it never raced). 120s sits above the
    // server ceiling so the client stops racing the server's own deadline.
    private val settleClient = client.newBuilder()
        .callTimeout(120, TimeUnit.SECONDS)
        .build()

    private fun authed(builder: Request.Builder): Request.Builder {
        tokenProvider()?.let { builder.header("Authorization", "Bearer $it") }
        return builder
    }

    suspend fun exchangeCliCode(code: String, state: String): JSONObject =
        postJson("/api/auth/cli/token", JSONObject().put("code", code).put("state", state))

    suspend fun me(): JSONObject = getJson("/api/me")

    suspend fun getJson(path: String): JSONObject {
        val req = authed(Request.Builder().url(base + path).get()).build()
        return executeJson(req)
    }

    /** Public GET against an absolute URL (no auth header) — e.g. the tool marketplace. */
    suspend fun getPublic(url: String): JSONObject =
        executeJson(Request.Builder().url(url).get().build())

    suspend fun postJson(path: String, body: JSONObject): JSONObject {
        val req = authed(
            Request.Builder().url(base + path).post(body.toString().toRequestBody(JSON_MEDIA))
        ).build()
        return executeJson(req)
    }

    /**
     * POST an on-chain money-mover (withdraw) on the long-timeout [settleClient]
     * so a slow broadcast/receipt doesn't abort mid-flight and get mislabeled a
     * failure. The server's 202 pending_confirmation body still comes back through
     * the normal `_status`-tagged path — the caller distinguishes pending / paid /
     * failed from the body; only a TRUE transport failure throws (→ null → "unknown
     * outcome", never a retry prompt).
     */
    suspend fun postJsonSettle(path: String, body: JSONObject): JSONObject {
        val req = authed(
            Request.Builder().url(base + path).post(body.toString().toRequestBody(JSON_MEDIA))
        ).build()
        return executeJson(req, settleClient)
    }

    suspend fun putJson(path: String, body: JSONObject): JSONObject {
        val req = authed(
            Request.Builder().url(base + path).put(body.toString().toRequestBody(JSON_MEDIA))
        ).build()
        return executeJson(req)
    }

    suspend fun patchJson(path: String, body: JSONObject): JSONObject {
        val req = authed(
            Request.Builder().url(base + path).patch(body.toString().toRequestBody(JSON_MEDIA))
        ).build()
        return executeJson(req)
    }

    suspend fun deleteJson(path: String, body: JSONObject? = null): JSONObject {
        val builder = Request.Builder().url(base + path)
        if (body != null) builder.delete(body.toString().toRequestBody(JSON_MEDIA)) else builder.delete()
        return executeJson(authed(builder).build())
    }

    /**
     * POST /api/chat SSE stream. Events per lib/chat/events.ts; every event carries
     * a monotonic `seq` (a jump = frames lost in transit → Note); terminator is
     * `data: [DONE]`. Message array mirrors iOS chatStream: platform-note system
     * message, optional continuity system message, history, current user message.
     */
    fun chat(
        message: String,
        tiny: String,
        history: JSONArray,
        extraSystem: String? = null,
        userBlocks: JSONArray? = null,
        includePlatformNote: Boolean = true,
        sessionTag: String = "tiny-android",
    ): Flow<ChatEvent> = callbackFlow {
        val messages = JSONArray()
        // Ambient/autonomous turns send a bare single message (web ambient.ts explore) —
        // no device-tool steering note, no history — so background work stays silent.
        if (includePlatformNote) messages.put(systemMessage(PLATFORM_NOTE))
        if (!extraSystem.isNullOrEmpty()) messages.put(systemMessage(extraSystem))
        for (i in 0 until history.length()) messages.put(history.get(i))
        messages.put(
            JSONObject().put("role", "user")
                .put("content", userBlocks ?: JSONArray().put(JSONObject().put("text", message)))
        )

        val body = JSONObject().put("messages", messages)
        val reqBuilder = Request.Builder()
            .url("$base/api/chat")
            .header("Accept", "text/event-stream")
            .header("x-tiny-session", sessionTag)
            // Explicit call-site tiny WINS when it names a specific tiny; only the
            // "tiny" default falls back to the user's configured tiny (iOS parity —
            // prior iOS logic had this inverted and misrouted switched tinys).
            .header("x-tiny-name", if (tiny != "tiny") tiny else defaultTinyProvider())
            .post(body.toString().toRequestBody(JSON_MEDIA))
        // BYO-model headers (bypass the free tier / pick any provider); empty on default.
        modelHeadersProvider().forEach { (k, v) -> reqBuilder.header(k, v) }
        val request = authed(reqBuilder).build()

        var lastSeq = -1
        var dropped = 0

        val source: EventSource = EventSources.createFactory(client).newEventSource(
            request,
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    if (data == "[DONE]") {
                        if (dropped > 0) trySend(ChatEvent.Note(droppedNote(dropped)))
                        trySend(ChatEvent.Done)
                        close()
                        return
                    }
                    val seq = runCatching { JSONObject(data).optInt("seq", -1) }.getOrDefault(-1)
                    if (seq >= 0) {
                        if (lastSeq >= 0 && seq > lastSeq + 1) dropped += seq - lastSeq - 1
                        lastSeq = seq
                    }
                    parseChatEvent(data)?.let { trySend(it) }
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    val code = response?.code
                    // The paywall returns a rich, actionable JSON body on 402
                    // ("Insufficient balance: … your wallet has $X. Top up at
                    // /wallet.") carrying the live price/balance — prefer it over
                    // the static status string (iOS Api.chatStream parity). A
                    // non-200 fails before any SSE frame, so the body is intact;
                    // guarded because OkHttp may have already closed it.
                    // The body is one-shot (OkHttp drains it), so read it ONCE and reuse:
                    // the "error" field for the message + the whole JSON for the paywall card.
                    val bodyStr = runCatching { response?.body?.string() }.getOrNull()
                    val serverMsg = bodyStr
                        ?.let { runCatching { JSONObject(it).optString("error") }.getOrNull() }
                        ?.takeIf { it.isNotEmpty() }
                    // One status→copy table (friendlyHttpError) shared with the JSON verbs,
                    // so the two paths can't drift (iOS 59b212a). Fall back to the transport
                    // message when there's no HTTP response at all (dropped connection).
                    val msg = serverMsg ?: code?.let { friendlyHttpError(it) } ?: t?.message ?: "connection lost"
                    trySend(
                        ChatEvent.Error(
                            msg,
                            paymentRequired = code == 402,
                            paymentBody = if (code == 402) bodyStr else null,
                        )
                    )
                    close()
                }

                override fun onClosed(eventSource: EventSource) {
                    trySend(ChatEvent.Done)
                    close()
                }
            },
        )
        awaitClose { source.cancel() }
    }

    /** Buffer the SSE stream to one string (relay proxy path — iOS chatOnce parity). */
    suspend fun chatOnce(
        message: String,
        tiny: String,
        extraSystem: String? = null,
        onTool: ((name: String, input: JSONObject) -> Unit)? = null,
    ): String {
        val sb = StringBuilder()
        var err: String? = null
        chat(message, tiny, JSONArray(), extraSystem).collect { ev ->
            when (ev) {
                is ChatEvent.TextDelta -> sb.append(ev.text)
                is ChatEvent.BeforeToolCall -> onTool?.invoke(ev.name, ev.input)
                is ChatEvent.Error -> err = ev.message
                else -> Unit
            }
        }
        val out = sb.toString().trim()
        return if (out.isNotEmpty()) out else "⚠ ${err ?: "no reply"}"
    }

    /**
     * One silent background turn for autonomous/ambient mode (web ambient.ts explore
     * parity): a single bare user message [prompt], no platform note, no history,
     * a distinct session tag so the server doesn't fold it into the visible thread.
     * Accumulates only text deltas; returns "" on any error/abort (background work
     * must never disturb the transcript).
     */
    suspend fun exploreOnce(prompt: String, tiny: String, sessionTag: String): String {
        val sb = StringBuilder()
        runCatching {
            chat(prompt, tiny, JSONArray(), includePlatformNote = false, sessionTag = sessionTag)
                .collect { ev -> if (ev is ChatEvent.TextDelta) sb.append(ev.text) }
        }
        return sb.toString().trim()
    }

    private fun systemMessage(text: String): JSONObject =
        JSONObject().put("role", "system")
            .put("content", JSONArray().put(JSONObject().put("text", text)))

    /**
     * Wire shape is FLAT (verified against iOS Api.swift, which parses the live
     * server): `{"type": "modelContentBlockDeltaEvent", "textDelta": "…", "seq": N}` —
     * a `type` discriminator with the payload at the top level, not nested.
     */
    // internal (not private) so the SSE-frame parser can be unit-tested directly;
    // it uses no instance state, so a bare TinyApi({ null }) exercises it.
    internal fun parseChatEvent(data: String): ChatEvent? {
        val o = runCatching { JSONObject(data) }.getOrNull() ?: return null
        return when (o.optString("type")) {
            "modelContentBlockDeltaEvent" -> {
                o.optString("textDelta").takeIf { it.isNotEmpty() }?.let { ChatEvent.TextDelta(it) }
                    ?: o.optString("reasoningDelta").takeIf { it.isNotEmpty() }?.let { ChatEvent.ReasoningDelta(it) }
            }
            "modelContentBlockStartEvent" ->
                o.optJSONObject("toolStart")?.let { t ->
                    ChatEvent.ToolStart(t.optString("name"), t.optString("toolUseId"))
                }
            "beforeToolCallEvent" ->
                o.optJSONObject("toolCall")?.let { t ->
                    ChatEvent.BeforeToolCall(
                        t.optString("name"), t.optString("toolUseId"),
                        t.optJSONObject("input") ?: JSONObject(),
                    )
                }
            "afterToolCallEvent" ->
                o.optJSONObject("toolResult")?.let { t ->
                    // The batch result rides the tool result's first content block as JSON
                    // (spawn_agents result payload). The block may be a structured `json`
                    // object or a `text` string — take whichever is present (iOS reads
                    // `text`, but this server emits `json`).
                    val resultText = t.optJSONArray("content")?.let { arr ->
                        (0 until arr.length()).firstNotNullOfOrNull { i ->
                            arr.optJSONObject(i)?.let { block ->
                                block.optJSONObject("json")?.toString()
                                    ?: block.optString("text").takeIf { it.isNotEmpty() }
                            }
                        }
                    }
                    ChatEvent.AfterToolCall(
                        t.optString("name"), t.optString("toolUseId"),
                        t.optString("status").takeIf { it.isNotEmpty() },
                        t.optString("error").takeIf { it.isNotEmpty() },
                        resultText,
                    )
                }
            "modelMetadataEvent" -> {
                // usage: {inputTokens, outputTokens, cacheReadInputTokens?} + modelId
                // (events.ts forwards inner.usage verbatim + resolvedModelId). modelId
                // drives the $ estimate; cacheReadInputTokens keeps it from inflating.
                val usage = o.optJSONObject("usage")
                ChatEvent.Metadata(
                    modelId = o.optString("modelId").takeIf { it.isNotEmpty() },
                    inputTokens = usage?.optInt("inputTokens", 0) ?: 0,
                    outputTokens = usage?.optInt("outputTokens", 0) ?: 0,
                    cacheReadInputTokens = usage?.optInt("cacheReadInputTokens", 0) ?: 0,
                )
            }
            "agentResultEvent" -> ChatEvent.Result(o.optString("stopReason").takeIf { it.isNotEmpty() })
            "error" -> ChatEvent.Error(o.opt("error")?.toString() ?: "unknown error")
            else -> null
        }
    }

    private suspend fun executeJson(request: Request, httpClient: OkHttpClient = jsonClient): JSONObject =
        suspendCancellableCoroutine { cont ->
            val call = httpClient.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        val text = it.body?.string().orEmpty()
                        val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                        if (!response.isSuccessful) {
                            json.put("_status", response.code)
                        }
                        if (cont.isActive) cont.resume(json)
                    }
                }
            })
        }
}

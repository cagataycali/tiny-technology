package technology.tiny.app.chat

import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.ui.SpawnNode
import technology.tiny.app.ui.SpawnTree
import java.util.UUID

/**
 * The transcript (de)serialization codec — a ChatMessage list ⇄ a JSON array — pulled
 * out of ChatViewModel so it's a pure, unit-testable object with no Application/filesDir
 * coupling. ChatViewModel's writeHistory/loadHistory delegate here (chat-history-<tiny>.json
 * round-trip), and SessionStore reuses the SAME string form as its opaque messagesJson blob,
 * so a saved session and the live history file are byte-identical shapes (one codec, no drift).
 *
 * Only the DURABLE fields are persisted (iOS ChatMessage Codable parity): id/role/text plus
 * reasoning, uiCards, spawns, token counts, modelId, failedPrompt, paywall, speechText. Transient
 * live-stream fields (streaming, toolLabel, toolCalls) are NOT persisted — they only have
 * meaning during an active stream. Decode fills every rich field with a default so histories
 * from older builds that predate a key still load cleanly (iOS decodeIfPresent).
 */
object MessageCodec {

    fun encode(messages: List<ChatMessage>): JSONArray {
        val arr = JSONArray()
        messages.forEach { m ->
            val o = JSONObject().put("id", m.id).put("role", m.role).put("text", m.text)
            if (m.reasoning.isNotEmpty()) o.put("reasoning", m.reasoning)
            if (m.uiCards.isNotEmpty()) o.put("uiCards", uiCardsToJson(m.uiCards))
            if (m.spawns.isNotEmpty()) o.put("spawns", spawnsToJson(m.spawns))
            if (m.inTok != 0) o.put("inTok", m.inTok)
            if (m.outTok != 0) o.put("outTok", m.outTok)
            if (m.cacheReadTok != 0) o.put("cacheReadTok", m.cacheReadTok)
            m.modelId?.let { o.put("modelId", it) }
            // A failed turn reloads as failed (retryable), not as a complete answer.
            if (m.failedPrompt != null) o.put("failedPrompt", m.failedPrompt)
            // A 402 paywall turn reloads as the actionable card (💳 Add funds + ↻ Retry),
            // NOT a blank assistant bubble — its text is empty by design, so without this
            // it'd persist as an empty ghost. Stored in the SAME wire shape parsePaywall
            // reads (payment_required + price/balance) so decode reuses that one parser.
            m.paywall?.let { pw ->
                o.put("paywall", JSONObject()
                    .put("payment_required", true)
                    .put("price_micro", pw.priceMicro)
                    .put("balance_micro", pw.balanceMicro)
                    .put("signed_out", pw.signedOut))
                m.paywallPrompt?.let { o.put("paywallPrompt", it) }
            }
            // Sent-attachment previews on a user turn (iOS thumbs/docs) — tiny thumbs persist.
            if (m.thumbs.isNotEmpty()) o.put("thumbs", JSONArray(m.thumbs))
            if (m.docNames.isNotEmpty()) o.put("docNames", JSONArray(m.docNames))
            // Settled pay_x402 outcomes (C3): toolCalls are transient, so without this
            // an approved payment's receipt VANISHES on reload. Keyed by toolUseId.
            if (m.paySettled.isNotEmpty()) o.put("paySettled", paySettledToJson(m.paySettled))
            // A speak-tool card (tap-to-play TTS) reloads as a silent, replayable card —
            // like paySettled it rides on a transient tool event, so without this the
            // 🔊 card VANISHES on reload while iOS (Views.swift msg.speech) and web
            // (Chat.tsx m.speech) both persist and re-render it. SpeechCard render is
            // autoplay-free, so a restored value never surprises with audio.
            m.speechText?.let { o.put("speechText", it) }
            arr.put(o)
        }
        return arr
    }

    /** The JSON-array STRING form — the shape written to chat-history-<tiny>.json and stored
     *  as SessionArchive.messagesJson. */
    fun encodeToString(messages: List<ChatMessage>): String = encode(messages).toString()

    fun decode(arr: JSONArray?): List<ChatMessage> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { o ->
                ChatMessage(
                    id = o.optString("id", UUID.randomUUID().toString()),
                    role = o.optString("role"),
                    text = o.optString("text"),
                    reasoning = o.optString("reasoning"),
                    uiCards = uiCardsFromJson(o.optJSONArray("uiCards")),
                    spawns = spawnsFromJson(o.optJSONArray("spawns")),
                    inTok = o.optInt("inTok"),
                    outTok = o.optInt("outTok"),
                    cacheReadTok = o.optInt("cacheReadTok"),
                    modelId = o.optString("modelId").takeIf { it.isNotEmpty() },
                    failedPrompt = o.optString("failedPrompt").takeIf { it.isNotEmpty() },
                    thumbs = stringList(o.optJSONArray("thumbs")),
                    docNames = stringList(o.optJSONArray("docNames")),
                    // Rebuild the paywall card straight from stored fields (signed_out is
                    // stored explicitly — parsePaywall recomputes it from body shape, which
                    // this durable form doesn't preserve, so decode reads it directly).
                    paywall = o.optJSONObject("paywall")?.let { p ->
                        technology.tiny.app.wallet.WalletCore.Paywall(
                            priceMicro = p.optLong("price_micro", 0L),
                            balanceMicro = p.optLong("balance_micro", 0L),
                            signedOut = p.optBoolean("signed_out", false),
                        )
                    },
                    paywallPrompt = o.optString("paywallPrompt").takeIf { it.isNotEmpty() },
                    paySettled = paySettledFromJson(o.optJSONObject("paySettled")),
                    speechText = o.optString("speechText").takeIf { it.isNotEmpty() },
                )
            }
        }
    }

    /** Parse a JSON-array string (from a history file or a session blob) → messages. Malformed
     *  input decodes to an empty list, never throws — a corrupt file must not crash load. */
    fun decodeString(json: String): List<ChatMessage> =
        decode(runCatching { JSONArray(json) }.getOrNull())

    // -- rich-field (de)serialization --

    /** A JSON string array → List<String>, tolerating null/blank entries. */
    private fun stringList(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
    }

    /** The settled-pay map (toolUseId → outcome) → a JSON object. Only paid/pending/declined
     *  ever reach here (failed is dropped upstream in WalletCore.toPersisted). */
    private fun paySettledToJson(
        map: Map<String, technology.tiny.app.wallet.WalletCore.PaySettled>,
    ): JSONObject {
        val o = JSONObject()
        map.forEach { (id, s) ->
            o.put(id, JSONObject().apply {
                put("phase", s.phase)
                if (s.paidMicro != 0L) put("paidMicro", s.paidMicro)
                s.network?.let { put("network", it) }
                s.payee?.let { put("payee", it) }
                s.message?.let { put("message", it) }
                // explorer is the paid outcome's BaseScan link; PaySettled documents
                // it "survives cold reload" and the in-memory Saver keeps it (index 5),
                // but this DURABLE codec dropped it — so a force-stop/session restore
                // reloaded the receipt without its on-chain proof link. iOS persists it
                // (PayQuote.swift:193 settledExplorer = s.explorer) and web too
                // (PayReceipt.tsx:246 const explorer = settled.explorer).
                s.explorer?.let { put("explorer", it) }
                // transfer keeps a P2P send's "Sent … from your wallet" wording
                // across cold reloads (only written when true — old records stay
                // byte-identical, and absent reads back as false).
                if (s.transfer) put("transfer", true)
            })
        }
        return o
    }

    private fun paySettledFromJson(
        o: JSONObject?,
    ): Map<String, technology.tiny.app.wallet.WalletCore.PaySettled> {
        if (o == null) return emptyMap()
        val out = LinkedHashMap<String, technology.tiny.app.wallet.WalletCore.PaySettled>()
        o.keys().forEach { id ->
            o.optJSONObject(id)?.let { s ->
                out[id] = technology.tiny.app.wallet.WalletCore.PaySettled(
                    phase = s.optString("phase"),
                    paidMicro = s.optLong("paidMicro", 0L),
                    network = s.optString("network").takeIf { it.isNotEmpty() },
                    payee = s.optString("payee").takeIf { it.isNotEmpty() },
                    message = s.optString("message").takeIf { it.isNotEmpty() },
                    explorer = s.optString("explorer").takeIf { it.isNotEmpty() },
                    transfer = s.optBoolean("transfer", false),
                )
            }
        }
        return out
    }

    private fun uiCardsToJson(cards: List<UiCard>): JSONArray {
        val arr = JSONArray()
        cards.forEach { c ->
            arr.put(JSONObject().apply { c.title?.let { put("title", it) }; put("props", c.propsJson) })
        }
        return arr
    }

    private fun uiCardsFromJson(arr: JSONArray?): List<UiCard> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { UiCard(it.optString("title").ifEmpty { null }, it.optString("props")) }
        }
    }

    private fun spawnsToJson(trees: List<SpawnTree>): JSONArray {
        val arr = JSONArray()
        trees.forEach { tree ->
            val nodes = JSONArray()
            tree.nodes.forEach { n ->
                nodes.put(JSONObject().apply {
                    put("id", n.id); put("prompt", n.prompt)
                    n.ok?.let { put("ok", it) }         // omitted = still running
                    n.result?.let { put("result", it) }
                })
            }
            arr.put(JSONObject().apply {
                put("id", tree.id); put("nodes", nodes)
                tree.elapsedMs?.let { put("elapsedMs", it) }
            })
        }
        return arr
    }

    private fun spawnsFromJson(arr: JSONArray?): List<SpawnTree> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val nodesArr = o.optJSONArray("nodes") ?: JSONArray()
            val nodes = (0 until nodesArr.length()).mapNotNull { j ->
                nodesArr.optJSONObject(j)?.let { n ->
                    SpawnNode(
                        id = n.optInt("id", j + 1),
                        prompt = n.optString("prompt"),
                        ok = if (n.has("ok")) n.optBoolean("ok") else null,
                        result = n.optString("result").ifEmpty { null },
                    )
                }
            }
            SpawnTree(
                id = o.optString("id"),
                nodes = nodes,
                elapsedMs = if (o.has("elapsedMs")) o.optDouble("elapsedMs") else null,
            )
        }
    }
}

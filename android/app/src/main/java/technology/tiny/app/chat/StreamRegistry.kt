package technology.tiny.app.chat

/**
 * Concurrent-stream history helpers (web lib/chat/stream-registry.ts parity).
 *
 * Semantics: "parallel exploration with cross-visibility". Every send fires
 * immediately — no gate on a live stream. Each turn snapshots history at ITS
 * send time; a sibling turn that is still streaming is INCLUDED in that
 * snapshot as an annotated partial (annotateLivePartial), so back-to-back
 * questions see each other's in-progress answers. Because every stream
 * accumulates into its own message bubble by id, the finished transcript
 * needs no merge step — it is already userA, asstA, userB, asstB in launch
 * order, and the next turn ships the complete history.
 *
 * Pure top-level functions (no Compose/Android state) so the annotation and
 * history-text rules stay testable — ChatViewModel owns the live-id registry
 * itself (a Compose state list + claimedAt map).
 */

/**
 * How a still-streaming sibling reply appears in a concurrent turn's history:
 * the partial text so far, clearly marked as in-progress so the model neither
 * treats it as final nor re-answers it (web annotateLivePartial — exact strings).
 */
fun annotateLivePartial(
    content: String,
    startedAtMs: Long,
    nowMs: Long = System.currentTimeMillis(),
): String {
    val secs = maxOf(1L, Math.round((nowMs - startedAtMs) / 1000.0))
    val body = content.trim()
    return if (body.isNotEmpty()) {
        "[⏳ You are STILL WRITING this reply in a parallel turn (started ${secs}s ago). " +
            "Partial text so far — do not repeat it, but you may build on it:]\n$body"
    } else {
        "[⏳ You are still working on a reply to the previous message in a parallel turn " +
            "(started ${secs}s ago) — nothing written yet. Answer the new message on its own.]"
    }
}

/**
 * The text one snapshot message contributes to the outgoing history (web
 * buildTurnHistory's per-message rule): a LIVE sibling placeholder passes even
 * when empty and is wrapped as an in-progress partial; anything else keeps the
 * existing Android rule — blank text becomes the "…" placeholder (strict
 * providers reject empty text blocks).
 */
fun historyText(
    text: String,
    isLive: Boolean,
    startedAtMs: Long,
    nowMs: Long = System.currentTimeMillis(),
): String =
    if (isLive) annotateLivePartial(text, startedAtMs, nowMs)
    else text.ifBlank { "…" }

/** What a turn killed by process death mid-stream reloads as (retryable, honest). */
const val INTERRUPTED_MARKER = "⚠️ interrupted — the app was closed mid-reply"

/**
 * Load-time reconcile (web Chat.tsx reconcileInterruptedTools parity): send()
 * persists the user message + empty assistant placeholder BEFORE the stream
 * launches, so a process death mid-stream leaves that placeholder in the
 * history file. An assistant message that persisted EMPTY — blank text and
 * none of the durable rich content MessageCodec keeps (reasoning, uiCards, spawns,
 * and NOT a 402 paywall bubble, which is intentionally empty-text) — can ONLY be such an
 * orphan: a surviving stream's finally always fills a blank
 * bubble with "⚠️ no reply — try again" before its save. When the orphan
 * directly follows a user message (send() appends the pair back-to-back, so it
 * always does — concurrent turns interleave as user,a,user,a), mark it
 * interrupted and retryable with that prompt; otherwise leave it untouched.
 * Pure (no Compose/Android deps) so the decision rule unit-tests on the JVM.
 */
fun reconcileInterrupted(messages: List<ChatMessage>): List<ChatMessage> =
    messages.mapIndexed { i, m ->
        val orphan = m.role == "assistant" &&
            m.failedPrompt == null &&
            m.paywall == null && // a 402 paywall bubble is empty-text BY DESIGN — not an orphan
            m.text.isBlank() &&
            m.reasoning.isEmpty() && // a completed reasoning-only reply is an answer, not an orphan (iOS Views.swift:634; MessageCodec persists reasoning)
            m.uiCards.isEmpty() &&
            m.spawns.isEmpty() &&
            i > 0 && messages[i - 1].role == "user"
        if (orphan) m.copy(text = INTERRUPTED_MARKER, failedPrompt = messages[i - 1].text) else m
    }

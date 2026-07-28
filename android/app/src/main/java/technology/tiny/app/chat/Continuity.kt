package technology.tiny.app.chat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

data class TurnEntry(val q: String, val a: String, val ts: Long)
data class MemoryEntry(val id: String, val content: String, val tags: List<String>, val ts: Long)

/**
 * Per-tiny turn log + memories, byte-compatible with web/iOS Continuity so the
 * server-side agent sees an identical context section regardless of platform.
 * Files: tiny_turnlog_<tiny>.json (max 200, last 20 injected),
 *        tiny_memories_<tiny>.json (max 100).
 */
class Continuity(private val context: Context) {

    private val MAX_TURNS = 200
    private val INJECT_TURNS = 20
    private val MAX_MEMORIES = 100

    private fun turnFile(tiny: String) = File(context.filesDir, "tiny_turnlog_${sanitize(tiny)}.json")
    private fun memFile(tiny: String) = File(context.filesDir, "tiny_memories_${sanitize(tiny)}.json")
    private fun sanitize(tiny: String) = tiny.lowercase().replace(Regex("[^a-z0-9_-]"), "_")

    /** Temp-then-rename, same rationale as ChatViewModel.writeHistory: writeText
     *  truncates in place, and both loaders map a half-written file to emptyList —
     *  process death mid-write silently destroyed every memory / the whole turn
     *  log for that tiny. rename() is atomic here; in-place is the exotic-mount
     *  fallback. */
    private fun atomicWrite(file: File, text: String) {
        runCatching {
            val tmp = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(file)) {
                file.writeText(text)
                tmp.delete()
            }
        }
    }

    // -- turn log --

    fun appendTurn(tiny: String, q: String, a: String) {
        // Drop a turn with a blank prompt OR a blank answer — either half empty
        // would render into the byte-parity turn log as a line web/iOS never emit
        // (e.g. "[time] user: \n→ you: …"), breaking the one-format-across-surfaces
        // invariant renderContext promises. Both other clients guard BOTH sides
        // inside the function: web continuity.ts:42 (`if (!q?.trim()||!a?.trim()) return`),
        // iOS Continuity.swift (`guard !qt.isEmpty, !at.isEmpty`). Android's caller
        // (ChatViewModel.kt:635) only guards the answer, so the prompt side needs this.
        if (q.isBlank() || a.isBlank()) return
        val turns = loadTurns(tiny).toMutableList()
        turns.add(TurnEntry(q.take(500), a.take(800), System.currentTimeMillis()))
        while (turns.size > MAX_TURNS) turns.removeAt(0)
        val arr = JSONArray()
        turns.forEach { arr.put(JSONObject().put("q", it.q).put("a", it.a).put("ts", it.ts)) }
        atomicWrite(turnFile(tiny), arr.toString())
    }

    fun loadTurns(tiny: String): List<TurnEntry> {
        val f = turnFile(tiny)
        if (!f.exists()) return emptyList()
        return runCatching {
            val arr = JSONArray(f.readText())
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let {
                    TurnEntry(it.optString("q"), it.optString("a"), it.optLong("ts"))
                }
            }
        }.getOrElse { emptyList() }
    }

    fun clearTurns(tiny: String) { turnFile(tiny).delete() }

    // -- memories (remember/forget tools) --

    fun addMemory(tiny: String, content: String, tags: List<String>) {
        val mems = loadMemories(tiny).toMutableList()
        mems.add(
            MemoryEntry(
                id = UUID.randomUUID().toString().replace("-", "").take(12),
                content = content.take(1000),
                tags = tags,
                ts = System.currentTimeMillis(),
            )
        )
        while (mems.size > MAX_MEMORIES) mems.removeAt(0)
        saveMemories(tiny, mems)
    }

    fun forgetMemory(tiny: String, match: String): Int {
        // `match` arrives straight from the model's forget tool call. A blank one
        // substring-matches EVERY memory (Kotlin's `contains("")` is always true),
        // so an empty forget would silently WIPE the store. Guard inside the method
        // — not just at the callers — mirroring web (continuity.ts:79 `!idOrText.trim()`)
        // and iOS (Continuity.swift:108 `guard !needle.isEmpty`), which both document
        // this exact hazard because the input is model-derived.
        if (match.isBlank()) return 0
        val mems = loadMemories(tiny)
        val keep = mems.filterNot { it.content.contains(match, ignoreCase = true) }
        saveMemories(tiny, keep)
        return mems.size - keep.size
    }

    fun clearMemories(tiny: String) { memFile(tiny).delete() }

    /**
     * Wipe EVERY local per-tiny store (all tiny names). Called only when a
     * *different* account signs in on this device — these stores are keyed by the
     * device-level tiny name (not per-user) and never re-sync from the server, so
     * without this the prior user's private data leaks into the new user's session:
     *   - tiny_turnlog_* / tiny_memories_* → injected as buildContext into requests
     *   - chat-history-*  → the readable transcript, reloaded verbatim by loadHistory
     *     when that tiny name is next opened (the highest-severity leak — visible
     *     message content, up to 200 msgs)
     *   - sessions/       → named-session archives (SessionStore), same content class
     * Same cross-user identity-leak class the widget-snapshot scrub closed
     * (WidgetStore.scrubIdentity). (iOS Continuity.scrubAllLocal, bb0ed15.)
     */
    fun scrubAllLocal() {
        context.filesDir.listFiles()?.forEach { f ->
            if (isScrubbableLocalFile(f.name)) f.deleteRecursively()
        }
    }

    fun loadMemories(tiny: String): List<MemoryEntry> {
        val f = memFile(tiny)
        if (!f.exists()) return emptyList()
        return runCatching {
            val arr = JSONArray(f.readText())
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { o ->
                    MemoryEntry(
                        o.optString("id"),
                        o.optString("content"),
                        o.optJSONArray("tags")?.let { t -> (0 until t.length()).map { t.optString(it) } } ?: emptyList(),
                        o.optLong("ts"),
                    )
                }
            }
        }.getOrElse { emptyList() }
    }

    private fun saveMemories(tiny: String, mems: List<MemoryEntry>) {
        val arr = JSONArray()
        mems.forEach {
            arr.put(
                JSONObject().put("id", it.id).put("content", it.content)
                    .put("tags", JSONArray(it.tags)).put("ts", it.ts)
            )
        }
        atomicWrite(memFile(tiny), arr.toString())
    }

    // -- context builder (byte-compatible with web/iOS) --

    fun buildContext(tiny: String): String? =
        renderContext(loadMemories(tiny), loadTurns(tiny).takeLast(INJECT_TURNS))

    companion object {
        /**
         * Pure: does a filesDir entry hold per-tiny user data that must be wiped on
         * an account switch? Extracted so the scrub SCOPE is unit-testable without
         * filesDir — the actual defect this closed was a too-narrow scope (only
         * turnlog + memories), so the exact name set is the correctness-sensitive
         * part. Matches by prefix (the per-tiny files are "<store>_<sanitized-tiny>"
         * or, for sessions, a directory). Deliberately does NOT match
         * tiny_my_shares.json: anonymous-share revoke tokens are returned once at
         * creation and aren't tied to the logged-in identity — wiping them would be
         * unrecoverable data loss, not a privacy fix.
         */
        fun isScrubbableLocalFile(name: String): Boolean =
            name.startsWith("tiny_turnlog_") ||
                name.startsWith("tiny_memories_") ||
                name.startsWith("chat-history-") ||
                name == "sessions"

        /**
         * Assemble the injected context section from already-loaded memories +
         * turns — the pure half of buildContext, extracted so the byte-compatible
         * format (web continuity.ts + iOS Continuity.swift) can be unit-tested
         * without filesDir. Null when there's nothing to inject.
         *
         * The tag suffix ("- content [tag1, tag2]") and the "M/d H:mm" turn
         * timestamps must match web/iOS exactly — a drift here makes Android send
         * the server a DIFFERENT context string than the other surfaces, breaking
         * the one-format-across-platforms invariant this file promises.
         */
        fun renderContext(mems: List<MemoryEntry>, turns: List<TurnEntry>): String? {
            if (mems.isEmpty() && turns.isEmpty()) return null

            // Mirror web continuity.ts EXACTLY: each block is header + "\n" + lines
            // joined by "\n" (NO trailing newline), and the blocks are joined by
            // "\n\n". The prior StringBuilder appended a '\n' after every memory AND
            // every turn, so the assembled string ended with an extra trailing
            // newline web/iOS never emit — a byte-divergence that broke the
            // one-format-across-platforms invariant this file promises. joinToString
            // makes the parity structural, not incidental.
            val parts = mutableListOf<String>()
            if (mems.isNotEmpty()) {
                val lines = mems.joinToString("\n") { m ->
                    "- " + m.content + if (m.tags.isNotEmpty()) " [" + m.tags.joinToString(", ") + "]" else ""
                }
                parts.add("## Persistent Memories (stored via remember tool, survives resets):\n" + lines)
            }
            if (turns.isNotEmpty()) {
                // Locale.US pins 24-hour H + ASCII digits regardless of the device's
                // 12/24-hour setting — the Android equivalent of iOS's en_US_POSIX pin
                // (Apple QA1480). Timezone stays device-local to match web's getHours().
                val fmt = SimpleDateFormat("M/d H:mm", Locale.US)
                val lines = turns.joinToString("\n") { t ->
                    "[" + fmt.format(Date(t.ts)) + "] user: " + t.q + "\n→ you: " + t.a
                }
                parts.add("## Continuous Turn Log (last ${turns.size} turns, survives history clears):\n" + lines)
            }
            return parts.joinToString("\n\n")
        }
    }
}

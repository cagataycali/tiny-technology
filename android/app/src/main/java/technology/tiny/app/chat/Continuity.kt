package technology.tiny.app.chat

import android.content.Context
import android.util.Log
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
 * Why three states and not a Boolean or a count: "nothing matched" and "the disk
 * refused the write" are different facts, and a caller that reports the wrong one
 * has diagnosed the user confidently and wrongly. Port of web's `ForgetOutcome`
 * (components/chat/continuity.ts) so all three surfaces answer the model in the
 * same three cases.
 *
 * ⚠️ Only FORGOTTEN means the fact stopped reaching the model. A count of "3
 * removed" is the same lie in a more confident wrapper when the write never
 * landed — the number describes an in-memory list, not the store.
 */
enum class ForgetOutcome { FORGOTTEN, NO_MATCH, BLOCKED }

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
     *  fallback.
     *
     *  ⚠️ Returns WHETHER the bytes landed. It used to swallow into Unit, and the
     *  callers above state outcomes as fact — the `forget` tool answers the MODEL
     *  `{ ok: true }`. A full disk or a revoked filesDir made every one of those
     *  claims false, which is web's v13 G2 bug verbatim (continuity.ts:32-47):
     *  the list shrank in memory, the user was told the fact was forgotten, and
     *  `buildContext` kept injecting it into every later request. "I forgot your
     *  address" followed by the address, forever. */
    private fun atomicWrite(file: File, text: String): Boolean = runCatching {
        val tmp = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            file.writeText(text)
            tmp.delete()
        }
        true
    }.getOrElse { t ->
        Log.w("TinyContinuity", "continuity write to ${file.name} failed: ${t.message}")
        false
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
        turns.add(TurnEntry(clipToCodePoints(q, 500), clipToCodePoints(a, 800), System.currentTimeMillis()))
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

    /** True only when the memory is actually durable — the caller's "stored"
     *  claim is exactly as true as this write. A blank content is `false` too:
     *  nothing was stored (web continuity.ts `addMemory`). */
    fun addMemory(tiny: String, content: String, tags: List<String>): Boolean {
        if (content.isBlank()) return false
        val mems = loadMemories(tiny).toMutableList()
        mems.add(
            MemoryEntry(
                id = UUID.randomUUID().toString().replace("-", "").take(12),
                content = clipToCodePoints(content, 1000),
                tags = tags,
                ts = System.currentTimeMillis(),
            )
        )
        while (mems.size > MAX_MEMORIES) mems.removeAt(0)
        return saveMemories(tiny, mems)
    }

    /**
     * The count form, kept because callers report "how many" — it delegates so the
     * "did this match AND land?" predicate has exactly ONE implementation. Two
     * copies of that question is how the two answers drift apart.
     *
     * ⚠️ 0 is now ambiguous BY DESIGN at this signature: no match and a refused
     * write both mean "nothing was forgotten", and only `forgetOutcome` can say
     * which. Anything that TELLS THE USER must call that instead.
     */
    fun forgetMemory(tiny: String, match: String): Int =
        forgetOutcome(tiny, match).let { (outcome, count) ->
            if (outcome == ForgetOutcome.FORGOTTEN) count else 0
        }

    /** The honest three-valued form, with the count that goes with it. */
    fun forgetOutcome(tiny: String, match: String): Pair<ForgetOutcome, Int> {
        val mems = loadMemories(tiny)
        // null = nothing to do, so nothing is written and nothing can be BLOCKED:
        // a store that never needed changing cannot have refused.
        val keep = survivors(mems, match) ?: return ForgetOutcome.NO_MATCH to 0
        // The shrink is NECESSARY but not sufficient — the write has to land too.
        return decide(mems.size - keep.size, saveMemories(tiny, keep))
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

    private fun saveMemories(tiny: String, mems: List<MemoryEntry>): Boolean {
        val arr = JSONArray()
        mems.forEach {
            arr.put(
                JSONObject().put("id", it.id).put("content", it.content)
                    .put("tags", JSONArray(it.tags)).put("ts", it.ts)
            )
        }
        return atomicWrite(memFile(tiny), arr.toString())
    }

    // -- context builder (byte-compatible with web/iOS) --

    fun buildContext(tiny: String): String? =
        renderContext(loadMemories(tiny), loadTurns(tiny).takeLast(INJECT_TURNS))

    companion object {
        /**
         * Pure: given how many memories the filter dropped and whether the store
         * write LANDED, which of the three facts is true? Extracted because a JVM
         * unit test cannot build a `Context` — leaving the mapping only reachable
         * on-device is how it went unnoticed that the write's verdict was never
         * consulted at all.
         *
         * `removed == 0` is NO_MATCH regardless of `wrote`: a store that never
         * needed changing cannot have refused. There is deliberately no Boolean
         * or bare-count convenience beside this — either one has to blur two of
         * the three cases together, which is the exact bug it replaces.
         */
        /**
         * Truncate on a CODE-POINT boundary — the only unit web, Android and iOS
         * can agree on.
         *
         * ⚠️ `take(n)` is WRONG here and looks right: it counts UTF-16 CHARS, so
         * a cut can land between the halves of one emoji and leave a LONE
         * SURROGATE (0xd83d). Unpaired, it cannot be encoded to UTF-8, and the
         * platforms disagree on the damage: the JVM writes `?` (0x3f), a browser
         * writes U+FFFD (0xef 0xbf 0xbd) — measured. So the SAME memory reaches
         * the model as different bytes depending on which phone stored it, and
         * this file's promise is the opposite (line 30: "byte-compatible with
         * web/iOS ... an identical context section regardless of platform").
         *
         * Swift diverges a third way — `prefix` counts GRAPHEME CLUSTERS, so one
         * string is 496 characters there and 506 here — and its String cannot
         * hold a lone surrogate at all. "Never split a character" is the only
         * rule all three can keep. Same rule as the DM rail's `clipToCodePoints`
         * and `Messages.kt`'s `codePointCount` budget.
         */
        fun clipToCodePoints(text: String, max: Int): String {
            val points = text.codePointCount(0, text.length)
            if (points <= max) return text
            return text.substring(0, text.offsetByCodePoints(0, max))
        }

        /**
         * Pure: which memories SURVIVE a forget for `match`, or null when the
         * store must not be touched at all.
         *
         * `match` is an ID **or** a content substring, which is web's union
         * (`m.id !== idOrText && !m.content…includes(…)`, continuity.ts) and
         * iOS's (`$0.id != idOrText && !$0.content…contains(…)`). The id arm is
         * not decoration and it is not for the model — the model's `forget` tool
         * takes text and never sees an id (buildContext renders "- content", no
         * ids). It exists so a UI ROW can name exactly one memory.
         *
         * ⚠️⚠️ Android had only the content arm, so the memory sheet's delete
         * could not name a row and passed `m.content.take(40)` instead
         * (MemoryUniverse.kt) — a SUBSTRING, aimed at a store this function
         * matches by substring. Measured harm: a memory whose whole content is
         * ≤40 chars and is a substring of another ("likes coffee" vs "likes
         * coffee in the morning") took BOTH rows out on one tap, as did any two
         * sharing a 40-char prefix. Silent and unrecoverable — the list just
         * re-read and showed fewer. iOS passed `m.id` and deleted exactly one.
         * A row is deletable by identity now, so this arm is load-bearing.
         *
         * ⚠️ The blank check is not a nicety, it is the whole store's safety
         * catch. `match` arrives straight from the model's forget tool call, and
         * on the JVM `"anything".contains("")` is TRUE — so a blank needle
         * matches EVERY memory and an empty forget silently WIPES everything,
         * then reports FORGOTTEN with a proud count. Web has the same hazard
         * (`includes("")` is true) and tests it directly; iOS does NOT, because
         * Swift's `contains("")` returns FALSE, so there the guard is free and
         * its test passes for a reason that does not transfer. That asymmetry is
         * why this lives here as a pure function: on Android the guard was only
         * reachable through a `Context`, i.e. only on a device, so nothing could
         * fail if it were deleted. It guards the id arm too: `it.id == ""` would
         * otherwise match every row loaded from a file with no `"id"` field.
         *
         * Returns null for "no memory matched" too, so the one caller cannot
         * confuse an untouched store with a refused write.
         */
        fun survivors(mems: List<MemoryEntry>, match: String): List<MemoryEntry>? {
            if (match.isBlank()) return null
            // The id compares RAW, like both other surfaces: an id is generated
            // lowercase hex, so case-folding it would only widen the arm that is
            // supposed to be exact.
            val keep = mems.filterNot { it.id == match || it.content.contains(match, ignoreCase = true) }
            return if (keep.size == mems.size) null else keep
        }

        fun decide(removed: Int, wrote: Boolean): Pair<ForgetOutcome, Int> = when {
            removed <= 0 -> ForgetOutcome.NO_MATCH to 0
            wrote -> ForgetOutcome.FORGOTTEN to removed
            else -> ForgetOutcome.BLOCKED to 0
        }

        /** The user-facing sentence for each outcome. A no-match is NOT an error:
         *  calling it a storage problem sends someone to clear app data over a
         *  typo'd match string (web Chat.tsx:1290 "Three outcomes, three
         *  messages"). Only BLOCKED warns, and it must say the memory SURVIVED. */
        fun forgetLine(outcome: ForgetOutcome): String = when (outcome) {
            ForgetOutcome.FORGOTTEN -> "🧠 Memory forgotten"
            ForgetOutcome.NO_MATCH -> "no memory matched"
            ForgetOutcome.BLOCKED -> "couldn't forget that — the memory is still there"
        }

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

package technology.tiny.app.wear

import org.json.JSONArray
import org.json.JSONObject

/**
 * WatchCore — pure logic for the (upcoming) Wear OS companion, the Android analog of
 * iOS TinyWatch/Sources/WatchCore.swift. History building + turn hygiene + snapshot
 * scrub, testable without a Data Layer client, WatchConnectivity, or any UI.
 *
 * This is the "shared, UIKit-free plumbing" half of the watch app (iOS reuses the same
 * file in its watchOS target). It lives here — in the phone app module — so it's
 * unit-tested on the JVM NOW; the eventual :wear Compose module depends on this pure
 * brain rather than reimplementing it, keeping the wrist and phone speaking the same
 * API dialect. No androidx.wear / hardware needed to verify any of it.
 */

/** One wrist-side turn: a question, its (streaming) answer, and completion flag. */
data class WatchTurn(
    val id: String,
    val q: String,
    val a: String = "",
    val done: Boolean = false,
)

object WatchCore {

    /** Error-answer sentinel — a turn whose answer starts with this is excluded from
     *  the Converse history sent back up (a failed turn must not poison context). */
    const val ERROR_PREFIX = "⚠"

    /** Followup-chip freshness window: 30 minutes (iOS WatchCore.isFresh / W7). */
    const val FOLLOWUP_FRESH_MS = 30L * 60L * 1000L

    /** Wrist transcript cap — the most-recent N turns kept in memory AND persisted
     *  (iOS saveTurns cap). One constant so the live trim and the store agree. */
    const val TURN_CAP = 20

    /**
     * Finalize a just-streamed turn's answer: trim trailing stream whitespace, and
     * if that leaves nothing (stream ended with no text and no error already set),
     * label it "(no answer)" so the turn never renders as a blank assistant bubble.
     * Pure — the wrist VM applies it as the last step of a turn.
     */
    fun finalizeAnswer(raw: String): String =
        raw.trim().ifEmpty { "(no answer)" }

    /** Trim a transcript to the most-recent [TURN_CAP] turns (drops from the front),
     *  the pure form of the VM's `while (size > cap) removeAt(0)` and the store's
     *  takeLast — same cap, one rule. */
    fun capTurns(turns: List<WatchTurn>): List<WatchTurn> =
        if (turns.size <= TURN_CAP) turns else turns.takeLast(TURN_CAP)

    /**
     * Does an incoming phone snapshot's last-exchange replace what the wrist has
     * stored? Only when the phone's exchange is STRICTLY NEWER — the user may have
     * chatted on the watch since the phone's push, and that fresher wrist exchange
     * must not be clobbered by a stale mirror (iOS absorbSnapshot: phoneAt >
     * old.lastAt). A null incoming timestamp never wins (the push carries no
     * exchange to show); a null stored timestamp means anything real wins.
     * Presence/unread/accent aren't arbitrated here — only the lastQ/lastA/lastAt
     * triple — so the caller always takes the incoming counts and consults this
     * for the exchange alone. Pure so it's JVM-tested; the timestamps are epoch ms.
     */
    fun incomingExchangeWins(incomingLastAt: Long?, storedLastAt: Long?): Boolean {
        if (incomingLastAt == null) return false
        return incomingLastAt > (storedLastAt ?: Long.MIN_VALUE)
    }

    /**
     * Converse-shaped history from prior turns for the /api/chat call: completed,
     * non-empty, non-error turns only, capped to the most recent [cap], as alternating
     * user/assistant text blocks ({"role","content":[{"text"}]}) — byte-identical to
     * the shape TinyApi.chat() threads through its `history` array. Mirrors iOS
     * WatchCore.history(from:cap:).
     */
    fun history(turns: List<WatchTurn>, cap: Int = 10): JSONArray {
        val arr = JSONArray()
        turns.takeLast(cap).forEach { t ->
            if (t.done && t.a.isNotEmpty() && !t.a.startsWith(ERROR_PREFIX)) {
                arr.put(msg("user", t.q))
                arr.put(msg("assistant", t.a))
            }
        }
        return arr
    }

    private fun msg(role: String, text: String): JSONObject =
        JSONObject().put("role", role)
            .put("content", JSONArray().put(JSONObject().put("text", text)))

    /**
     * Restore hygiene: a turn persisted mid-stream (app killed while streaming) must
     * not reload as forever-spinning. Force every unfinished turn to done, labelling a
     * still-empty one "(interrupted)" (iOS WatchCore.sanitize).
     */
    fun sanitize(turns: List<WatchTurn>): List<WatchTurn> =
        turns.map { t ->
            if (t.done) t
            else t.copy(a = t.a.ifEmpty { "(interrupted)" }, done = true)
        }

    /**
     * Is a followup chip still fresh (worth showing/tapping)? True only within
     * [FOLLOWUP_FRESH_MS] of [followupAt] (iOS W7 — a stale chip could otherwise stay
     * tappable past 30 min). Null timestamp → not fresh.
     */
    fun isFresh(followupAt: Long?, now: Long): Boolean {
        if (followupAt == null) return false
        return followupAt > now - FOLLOWUP_FRESH_MS
    }

    /**
     * Truncate to [max] chars with a trailing ellipsis — wrist sub-lines and
     * complications have almost no room. Collapses internal whitespace/newlines to
     * single spaces first so a multi-line streamed answer reads as one clean line.
     */
    fun ellipsize(text: String, max: Int): String {
        val flat = text.trim().replace(Regex("\\s+"), " ")
        if (flat.length <= max) return flat
        if (max <= 1) return flat.take(max)
        return flat.take(max - 1).trimEnd() + "…"
    }

    /**
     * The fleet tile's second line. Priority: a missing snapshot reads as "waiting";
     * unread beats everything (there's a message to see); otherwise surface tiny's
     * last answer (ellipsized) so the wrist shows the last thing it said; falling
     * back to a quiet-fleet note. Pure so the tile and its tests agree.
     */
    fun tileSubline(hasSnapshot: Boolean, unread: Int, lastA: String?, max: Int = 42): String {
        if (!hasSnapshot) return "Waiting for your phone"
        if (unread > 0) return "💬 $unread unread"
        if (!lastA.isNullOrBlank()) return "🌱 " + ellipsize(lastA, max)
        return "Fleet is quiet"
    }

    /**
     * LONG_TEXT complication body: the last exchange as "Q → A", each side
     * ellipsized to fit, or a plain presence fallback when there's no exchange yet.
     */
    fun lastExchangeText(lastQ: String?, lastA: String?, online: Int, total: Int): String {
        if (lastQ.isNullOrBlank() || lastA.isNullOrBlank()) return "$online/$total online"
        return ellipsize(lastQ, 40) + " → " + ellipsize(lastA, 60)
    }

    /**
     * The fleet presence line — "🟢 2/5 online" — shared by the chat header and the
     * tile so the dot rule + wording can't drift between them. A green dot means
     * someone's online, a hollow one means the fleet's dark. An optional unread
     * count rides as a "  ·  💬 N" suffix (the chat header shows it; the tile keeps
     * unread on its own sub-line, so it passes 0).
     */
    fun presenceLine(online: Int, total: Int, unread: Int = 0): String {
        val dot = if (online > 0) "🟢" else "⚪️"
        val suffix = if (unread > 0) "  ·  💬 $unread" else ""
        return "$dot $online/$total online$suffix"
    }

    /** iOS default accent (green) as an opaque ARGB Int — the fallback when a tiny
     *  has no theme or an unparseable one. Matches web THEME_PRESETS.tiny #00FF88's
     *  spirit but uses the iOS/system green the watch surfaces already shipped. */
    const val DEFAULT_ACCENT_ARGB: Int = 0xFF34C759.toInt()

    /**
     * Parse a tiny's accent hex into an opaque ARGB Int, the ONE place the wrist
     * surfaces agree on the color (the tile's tileAccent and the app's accentColor
     * both delegate here). The server contract is a strict `#RRGGBB` (lib/theme.ts
     * HEX_RE) but we tolerate a missing `#` and any case; anything else →
     * [DEFAULT_ACCENT_ARGB]. Force full alpha so a 6-digit hex is never transparent.
     */
    fun accentArgb(hex: String?): Int {
        val h = hex?.trim()?.removePrefix("#")?.takeIf { it.length == 6 } ?: return DEFAULT_ACCENT_ARGB
        val rgb = runCatching { h.toLong(16) }.getOrNull() ?: return DEFAULT_ACCENT_ARGB
        return (0xFF000000L or rgb).toInt()
    }

    /** Wrist TTS cap — a spoken wrist answer is 1-2 short sentences (see WearChat's
     *  steering); the phone caps at 3000, the watch stays terser. */
    const val SPEAK_CAP = 1000

    /**
     * Strip markdown the ear doesn't want before TTS — the wrist twin of the phone
     * Speech.scrub (which mirrors iOS Speech.swift / web voice.ts). CRITICAL: this
     * must KEEP the content of inline code and links, not drop it — an earlier wrist
     * scrub replaced `` `code` `` with a space, so "run `ls` now" spoke as "run now".
     * Fences → a spoken placeholder; inline code / links → their text; markdown-noise
     * chars → a SPACE (never "", which would jam "a|b" into "ab"); collapse whitespace;
     * cap at [SPEAK_CAP]. Pure so it's JVM-tested alongside the phone's scrub.
     */
    fun speakable(text: String): String = text
        .replace(Regex("```[\\s\\S]*?```"), " code block omitted ")
        .replace(Regex("`([^`]*)`"), "$1")
        .replace(Regex("!?\\[([^\\]]*)]\\([^)]*\\)"), "$1")
        .replace(Regex("[*_#>|]"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()
        .take(SPEAK_CAP)
}

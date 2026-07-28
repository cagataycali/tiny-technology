package technology.tiny.app.chat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.DateFormat
import java.util.Date
import java.util.UUID

/**
 * A named, saved snapshot of one conversation — the Android analog of iOS
 * SessionArchive (ios/Tiny/Sources/Sessions.swift). Lets a user park the current
 * transcript under a name and reload it later, entirely offline (the server keeps
 * no per-session history — this is the only "save this conversation" surface).
 *
 * [messagesJson] is the transcript held OPAQUELY: it's the exact JSON array string
 * ChatViewModel already writes to chat-history-<tiny>.json (same rich-field shape),
 * so this store never needs to know how a ChatMessage (de)serializes — it just
 * persists and returns the blob, and ChatViewModel round-trips it through its own
 * loadHistory/writeHistory codec. [messageCount] is denormalized for the list
 * subtitle so the picker needn't parse every archive to show "N messages".
 *
 * [autoBackup] marks the safety-net snapshot taken automatically right before a
 * load replaces the live transcript (so a mis-tapped load is recoverable); these
 * are pruned to the newest one so they don't accumulate (iOS pruneAutoBackups).
 */
data class SessionArchive(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val tiny: String,
    val savedAt: Long,
    val messagesJson: String,
    val messageCount: Int,
    val autoBackup: Boolean = false,
)

/**
 * Per-tiny named-session store: filesDir/sessions/<tiny>/<uuid>.json, one archive
 * per file (atomic single-file writes, mirrors the iOS SessionStore layout so the
 * two surfaces reason about sessions identically). The pure sort/prune/subtitle
 * decisions live in the companion so they're unit-testable without filesDir.
 */
class SessionStore(private val context: Context) {

    private fun dir(tiny: String): File =
        File(File(context.filesDir, "sessions"), sanitize(tiny)).apply { mkdirs() }

    private fun file(tiny: String, id: String): File = File(dir(tiny), "$id.json")

    fun save(archive: SessionArchive) {
        runCatching { file(archive.tiny, archive.id).writeText(archive.toJson().toString()) }
    }

    /** All archives for [tiny], newest-saved first (the order the picker shows). */
    fun list(tiny: String): List<SessionArchive> {
        val files = dir(tiny).listFiles { f -> f.name.endsWith(".json") } ?: return emptyList()
        val loaded = files.mapNotNull { f ->
            runCatching { fromJson(JSONObject(f.readText())) }.getOrNull()
        }
        return sortNewestFirst(loaded)
    }

    fun delete(archive: SessionArchive) {
        runCatching { file(archive.tiny, archive.id).delete() }
    }

    /**
     * Keep only the [keepingNewest] most-recent auto-backups for [tiny]; delete the
     * rest. Named saves are never touched. Called after a load auto-archives the
     * outgoing transcript, so these one-shot safety nets don't pile up (iOS parity).
     */
    fun pruneAutoBackups(tiny: String, keepingNewest: Int = 1) {
        prunable(list(tiny), keepingNewest).forEach { delete(it) }
    }

    private fun SessionArchive.toJson(): JSONObject =
        JSONObject()
            .put("id", id)
            .put("name", name)
            .put("tiny", tiny)
            .put("savedAt", savedAt)
            .put("messageCount", messageCount)
            .put("autoBackup", autoBackup)
            // Stored as a nested array so the file is one well-formed JSON object;
            // messagesJson is that array's string form (ChatViewModel's own codec).
            .put("messages", runCatching { JSONArray(messagesJson) }.getOrElse { JSONArray() })

    companion object {
        fun sanitize(tiny: String): String = tiny.lowercase().replace(Regex("[^a-z0-9_-]"), "_")

        fun fromJson(o: JSONObject): SessionArchive =
            SessionArchive(
                id = o.optString("id", UUID.randomUUID().toString()),
                name = o.optString("name"),
                tiny = o.optString("tiny"),
                savedAt = o.optLong("savedAt"),
                messagesJson = o.optJSONArray("messages")?.toString() ?: "[]",
                messageCount = o.optInt("messageCount"),
                autoBackup = o.optBoolean("autoBackup", false),
            )

        /**
         * Order archives newest-saved first. Stable on ties (equal savedAt keeps
         * input order) so a batch saved in the same millisecond stays deterministic.
         */
        fun sortNewestFirst(archives: List<SessionArchive>): List<SessionArchive> =
            archives.sortedByDescending { it.savedAt }

        /**
         * From [archives] (any order — sorted internally), the auto-backups to delete
         * so at most [keepingNewest] survive. Named saves are never returned. Guards
         * a negative/zero keep count (returns every auto-backup). Pure so the retention
         * rule is unit-testable without touching the filesystem.
         */
        fun prunable(archives: List<SessionArchive>, keepingNewest: Int): List<SessionArchive> {
            val autos = sortNewestFirst(archives.filter { it.autoBackup })
            return autos.drop(maxOf(0, keepingNewest))
        }

        /**
         * The one-line subtitle under a session name: "N messages · <localized date>"
         * ("1 message" singular). [format] is injected so tests pin the count/plural
         * and separator without depending on the device locale's date rendering.
         */
        fun subtitle(messageCount: Int, savedAt: Long, format: (Date) -> String): String {
            val noun = if (messageCount == 1) "message" else "messages"
            return "$messageCount $noun · ${format(Date(savedAt))}"
        }

        /** Default subtitle formatter — medium-style localized date+time. */
        fun subtitle(messageCount: Int, savedAt: Long): String =
            subtitle(messageCount, savedAt) { d ->
                DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(d)
            }

        /**
         * The save-area footer explaining what "save" captures — iOS parity
         * (Sessions.swift:100): "Snapshots the current N-message conversation.
         * The live chat stays put." ("1-message" singular, "0-message" plural).
         */
        fun saveFooter(messageCount: Int): String {
            val noun = if (messageCount == 1) "message" else "messages"
            return "Snapshots the current $messageCount-$noun conversation. The live chat stays put."
        }

        /**
         * The saved-sessions section header naming the current tiny — iOS parity
         * (Sessions.swift:129 "Saved sessions · <tiny>"). Blank tiny falls back to
         * the generic label so the header never reads a dangling separator.
         */
        fun savedHeader(tiny: String): String =
            if (tiny.isBlank()) "Saved sessions" else "Saved sessions · $tiny"
    }
}

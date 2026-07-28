package technology.tiny.app.chat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Local record of share links this device created (web parity for
 * localStorage["tiny_my_shares"]). The server's `?mine=1` list only covers
 * shares created while logged in and is auth-gated; anonymous shares live only
 * here, and their `revokeToken` is returned exactly once at creation — without
 * it an anonymous share can never be revoked. Capped to the most recent 50.
 */
class MyShares(context: Context) {
    private val file = File(context.filesDir, "tiny_my_shares.json")
    private val cap = 50

    data class Entry(val id: String, val name: String, val revokeToken: String?, val created: Long)

    fun load(): List<Entry> {
        if (!file.exists()) return emptyList()
        return runCatching {
            val arr = JSONArray(file.readText())
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { o ->
                    val id = o.optString("id")
                    if (id.isEmpty()) null
                    else Entry(
                        id = id,
                        name = o.optString("name", "tiny"),
                        revokeToken = o.optString("revokeToken").takeIf { it.isNotEmpty() },
                        created = o.optLong("created"),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    /** Prepend a freshly created share, dedupe by id, keep the newest [cap]. */
    fun add(id: String, name: String, revokeToken: String?, created: Long) {
        val kept = (listOf(Entry(id, name, revokeToken, created)) +
            load().filter { it.id != id }).take(cap)
        write(kept)
    }

    fun remove(id: String) = write(load().filter { it.id != id })

    fun revokeTokenFor(id: String): String? = load().firstOrNull { it.id == id }?.revokeToken

    private fun write(entries: List<Entry>) {
        val arr = JSONArray()
        entries.forEach {
            arr.put(
                JSONObject()
                    .put("id", it.id)
                    .put("name", it.name)
                    .apply { it.revokeToken?.let { t -> put("revokeToken", t) } }
                    .put("created", it.created),
            )
        }
        runCatching { file.writeText(arr.toString()) }
    }
}

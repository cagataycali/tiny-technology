package technology.tiny.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

/**
 * Recently-used tinys → dynamic launcher shortcuts. The Android analog of the
 * *relevant* half of iOS App Shortcuts: the static shortcuts.xml gives the
 * fixed quick-actions (ask/voice/memory/messages), and this surfaces the tinys
 * you actually switch between as long-press launcher shortcuts that jump
 * straight back into that tiny (tinyapp://tiny?name=<slug>).
 *
 * Persisted as an MRU list in prefs so the shortcuts survive a cold start; on
 * every switch we promote the tiny to the front and re-push the top N. iOS's
 * AppShortcutsProvider is static-per-install; dynamic per-tiny shortcuts
 * actually EXCEED that (iOS can't parameterize the install-time shortcut list).
 */
object RecentTinys {
    private const val PREF = "tiny_recents"
    private const val KEY = "recent_tinys"
    private const val MAX = 4 // launchers cap dynamic+static; keep headroom for the 4 static
    private const val SEP = ""

    fun record(context: Context, name: String) {
        val next = promote(name, load(context.getSharedPreferences(PREF, Context.MODE_PRIVATE)))
            ?: return
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY, next.joinToString(SEP)).apply()
        push(context, next)
    }

    /**
     * Pure MRU update: fold [name] into [current] and return the new top-[MAX]
     * list, or null when nothing should change (so callers skip the write + the
     * shortcut re-push). Rules: the name is slug-normalized (trim+lowercase); the
     * default landing tiny "tiny" and blanks earn no shortcut slot; an existing
     * entry is promoted to the front (deduped) rather than duplicated; the list is
     * capped at MAX. Extracted from record() to be unit-testable without prefs.
     */
    fun promote(name: String, current: List<String>): List<String>? {
        val slug = name.trim().lowercase()
        if (slug.isEmpty() || slug == "tiny") return null
        val next = (listOf(slug) + current.filterNot { it == slug }).take(MAX)
        return if (next == current) null else next
    }

    private fun load(prefs: android.content.SharedPreferences): List<String> =
        prefs.getString(KEY, "")?.split(SEP)?.filter { it.isNotEmpty() } ?: emptyList()

    /** Rebuild the dynamic shortcut set from the MRU list (call on boot too). */
    fun refresh(context: Context) {
        val prefs = context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        push(context, load(prefs))
    }

    /**
     * Forget the MRU list and remove the dynamic launcher shortcuts — the recents
     * name the tinys the PRIOR user switched between (a leak of who they talk to),
     * and the shortcuts deep-link straight into those personas. Called on an account
     * switch so a new user on the device inherits an empty, un-fingerprinting
     * launcher. Static shortcuts.xml (ask/voice/memory/messages) are untouched.
     */
    fun clear(context: Context) {
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().remove(KEY).apply()
        push(context, emptyList())
    }

    private fun push(context: Context, tinys: List<String>) {
        val shortcuts = tinys.mapIndexed { i, slug ->
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("tinyapp://tiny?name=$slug")).apply {
                setClassName(context, "technology.tiny.app.MainActivity")
            }
            ShortcutInfoCompat.Builder(context, "tiny_$slug")
                .setShortLabel(slug)
                .setLongLabel("Chat with $slug")
                .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_ask))
                .setIntent(intent)
                .setRank(i)
                .build()
        }
        // setDynamicShortcuts replaces the whole dynamic set (static shortcuts.xml
        // entries are unaffected — they're a separate bucket). Guarded: a launcher
        // that doesn't support shortcuts just no-ops.
        runCatching { ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts) }
    }
}

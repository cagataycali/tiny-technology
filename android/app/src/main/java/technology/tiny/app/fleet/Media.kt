package technology.tiny.app.fleet

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Spotify / media deep-links (iOS Media.swift parity). A "play … on spotify"
 * relay prompt is a REAL device action, not a chat proxy: the phone opens the
 * Spotify search deep-link so the track/playlist is one tap from playing.
 *
 * [spotifyLinks] extracts open.spotify.com URLs the agent puts in a reply so the
 * chat can render them as tappable chips (mirrors iOS Media.spotifyLinks(in:)).
 * [musicQuery] strips the "play"/"on spotify" scaffolding to the bare query.
 * [searchUrl] builds the search deep-link. [open] launches it, but only when
 * the app is foreground — Android forbids background activity launches (10+),
 * the same constraint iOS enforces via applicationState == .active.
 */
object Media {
    private val LINK = Regex("""https://open\.spotify\.com/[A-Za-z0-9/_?=&.-]+""")

    /** All open.spotify.com URLs in a block of text, in order, de-duplicated. */
    fun spotifyLinks(text: String): List<String> =
        LINK.findAll(text).map { it.value }.distinct().toList()

    // Trailing/leading noise trimmed off a resolved query — whitespace plus the
    // punctuation iOS strips via .punctuationCharacters (so "play X!" → "X"). Only
    // the ENDS are trimmed, so an interior "AC/DC" or "Sgt. Pepper" is untouched.
    private const val EDGE_NOISE = "!?.,;:…\"'`()[]{}-–—"

    /**
     * Strip the play-verb and spotify/phone suffixes so what's left is the bare
     * thing to search for. "play daft punk on spotify" → "daft punk".
     *
     * iOS Media.musicQuery matches `\bplay\s` — the verb WHEREVER it leads, not just
     * at the string start — so a conversational relay prompt ("can you play daft punk
     * on spotify") resolves to "daft punk", not "can you play daft punk". The word
     * boundary keeps "display the charts" from being mistaken for the command.
     */
    fun musicQuery(prompt: String): String {
        var q = prompt
        // Take everything after the first real "play " verb (word-boundary anchored).
        Regex("""\bplay\s""", RegexOption.IGNORE_CASE).find(q)?.let { q = q.substring(it.range.last + 1) }
        // Repeatedly drop trailing scaffolding (`while`, iOS parity — "… on spotify spotify").
        for (suffix in listOf(" on spotify", " in spotify", " on the phone", " spotify")) {
            while (q.endsWith(suffix, ignoreCase = true)) q = q.dropLast(suffix.length)
        }
        return q.trim { it.isWhitespace() || it in EDGE_NOISE }
    }

    /** Spotify search deep-link for a query (null/blank → the plain search page). */
    fun searchUrl(query: String): String {
        val q = query.trim()
        if (q.isEmpty()) return "https://open.spotify.com/search"
        return "https://open.spotify.com/search/" + Uri.encode(q)
    }

    /**
     * Open a Spotify URL on the phone — ONLY when the app is foreground. Returns
     * true if launched, false if backgrounded (caller hands back the link instead).
     * Android blocks background activity launches; iOS blocks the same via
     * applicationState. FLAG_ACTIVITY_NEW_TASK because the launch originates from
     * the relay service context, not an Activity.
     */
    fun open(context: Context, url: String): Boolean {
        if (!isForeground(context)) return false
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        return runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        }.getOrDefault(false)
    }

    private fun isForeground(context: Context): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        return am.runningAppProcesses?.any {
            it.processName == context.packageName &&
                it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        } ?: false
    }
}

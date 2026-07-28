package technology.tiny.app.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * /share + /export helpers (web Chat.tsx parity).
 *
 *  - export: purely client-side markdown, web format verbatim
 *    (`# Conversation with <name>` / `> tiny.technology/<name> · exported <date>` /
 *    `**you**:`/`**<name>**:` inline, joined by `\n\n---\n\n`). Written to a .md
 *    file and handed to the system share sheet (iOS shares via ShareLink; web
 *    downloads a Blob — a shared file is the Android equivalent of both).
 *  - share: POST /api/share (no auth needed) done by the caller; this file only
 *    presents the returned URL (clipboard + share sheet, iOS shareConversation parity).
 */
object Sharing {
    /** UTC date, matching web's `new Date().toISOString().slice(0, 10)` — the export
     *  header + filename are a cross-platform contract, and a device-LOCAL date would
     *  hand a non-UTC user a different day (and filename) than web/their other devices
     *  export near midnight. Pinning UTC makes the two files byte-identical. */
    private fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        .format(Date())

    /** Web /export format VERBATIM (the documented cross-platform contract, Chat.tsx):
     *  every non-system message (blank bubbles included — web applies no text filter),
     *  "**you**"/"**<tiny>**" speaker labels, joined by "\n\n---\n\n", under a titled +
     *  UTC-dated header, trailing "\n". */
    fun exportMarkdown(tiny: String, messages: List<ChatMessage>): String {
        val header = "# Conversation with $tiny\n\n" +
            "> tiny.technology/$tiny · exported ${today()}\n\n"
        val body = messages
            .filter { it.role != "system" }
            .joinToString("\n\n---\n\n") { m ->
                val who = if (m.role == "user") "you" else tiny
                "**$who**: ${m.text}"
            }
        return header + body + "\n"
    }

    /** Filename mirrors web: `<tiny>-conversation-<YYYY-MM-DD>.md`. */
    fun exportFilename(tiny: String): String = "$tiny-conversation-${today()}.md"

    /** Write markdown to cache and open the system share sheet on it. */
    fun shareMarkdownFile(context: Context, filename: String, markdown: String) {
        val dir = File(context.cacheDir, "exports").apply { mkdirs() }
        val file = File(dir, filename)
        file.writeText(markdown)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/markdown"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        launchChooser(context, intent, "Export conversation")
    }

    /** Share a plain URL/text via the system sheet (iOS shareConversation parity). */
    fun shareText(context: Context, subject: String, text: String) {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, subject)
            putExtra(Intent.EXTRA_TEXT, text)
        }
        launchChooser(context, intent, subject)
    }

    fun copyToClipboard(context: Context, label: String, text: String) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
    }

    private fun launchChooser(context: Context, intent: Intent, title: String) {
        val chooser = Intent.createChooser(intent, title).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(chooser)
    }
}

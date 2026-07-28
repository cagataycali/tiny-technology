package technology.tiny.app.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.ui.theme.TinyGray

/**
 * Per-tool-call detail card (web Chat.tsx:2583-2642 parity — iOS is label-only).
 *
 * The full lifecycle rides three SSE events: modelContentBlockStartEvent seeds the
 * call "calling"; beforeToolCallEvent carries the input; afterToolCallEvent flips
 * it to ✓/✗ with a result/error. Collapsed = spinner/✓/✗ + monospace name; two
 * independent expandable sections (Input / Result) show pretty-printed JSON, plus a
 * red "Error: …" line. Suppressed for the tools that already have a custom render
 * (render_ui → card, suggest_followups → chips, spawn_agents → TaskTree).
 */
data class ToolCall(
    val id: String,                    // toolUseId
    val name: String,
    val inputJson: String? = null,     // raw JSON string of the tool input
    val status: String = "calling",    // "calling" | "success" | "error"
    val resultText: String? = null,    // first result content block (json/text)
    val error: String? = null,
    // Hosted image produced by a round-trip capture (screenshot tool): the model
    // gets the pixels as an ImageBlock over SSE, but the USER should see what they
    // just approved too. The device posts the R2 URL back through TinyApp's
    // screenshot bus; the VM attaches it here so the card renders the still inline
    // (iOS shows a GeneratedImageCard — this is the Android parity).
    val imageUrl: String? = null,
) {
    companion object {
        /** Tools that render as something richer elsewhere — no generic card. */
        val SUPPRESSED = setOf("render_ui", "suggest_followups", "spawn_agents")
    }
}

/**
 * Pretty-print a JSON string with 2-space indent (web tool-card parity:
 * `JSON.stringify(tool.input/result, null, 2)`, Chat.tsx:3131/3139). UNLIKE web,
 * which always holds a parsed object, this receives the raw tool string, so it
 * only reformats when the text actually parses as an object/array and otherwise
 * passes the raw text through unchanged — a plain-string or malformed result must
 * still render, never blank or throw.
 */
internal fun prettyJson(s: String): String = runCatching {
    val t = s.trim()
    when {
        t.startsWith("{") -> JSONObject(t).toString(2)
        t.startsWith("[") -> JSONArray(t).toString(2)
        else -> s
    }
}.getOrDefault(s)

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@androidx.compose.runtime.Composable
fun ToolCallCard(call: ToolCall) {
    var inputOpen by remember(call.id) { mutableStateOf(false) }
    var resultOpen by remember(call.id) { mutableStateOf(false) }

    val accent = MaterialTheme.colorScheme.primary // per-tiny via MaterialTheme.colorScheme.primaryTheme
    val borderish = when (call.status) {
        "error" -> MaterialTheme.colorScheme.error.copy(alpha = 0.5f)
        "success" -> accent.copy(alpha = 0.3f)
        else -> accent.copy(alpha = 0.5f)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(borderish)
            .padding(1.dp) // thin status-tinted frame (web encodes status in the border)
            .clip(RoundedCornerShape(11.dp))
            .background(Color.Black.copy(alpha = 0.5f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Collapsed header: status indicator + monospace tool name.
        Row(verticalAlignment = Alignment.CenterVertically) {
            when (call.status) {
                "calling" -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = accent)
                "success" -> Text("✓", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium, color = accent)
                else -> Text("✗", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.width(8.dp))
            Text(
                call.name,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.labelSmall,
                color = accent,
            )
        }

        // Round-trip capture preview (screenshot): the user sees what they
        // approved, not just a ✓. Tap opens the hosted still; long-press offers
        // Share/Copy link — parity with iOS's image contextMenu.
        call.imageUrl?.takeIf { it.isNotBlank() }?.let { url ->
            val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
            val context = androidx.compose.ui.platform.LocalContext.current
            var menuOpen by remember { mutableStateOf(false) }
            Box {
                coil.compose.AsyncImage(
                    model = url,
                    contentDescription = "Captured screen",
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 320.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .combinedClickable(
                            onClick = { runCatching { uriHandler.openUri(url) } },
                            onLongClick = { menuOpen = true },
                            onLongClickLabel = "Image options",
                        ),
                )
                androidx.compose.material3.DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = { menuOpen = false },
                ) {
                    androidx.compose.material3.DropdownMenuItem(
                        text = { Text("Share image link") },
                        onClick = {
                            menuOpen = false
                            technology.tiny.app.chat.Sharing.shareText(context, "Captured screen", url)
                        },
                    )
                    androidx.compose.material3.DropdownMenuItem(
                        text = { Text("Copy link") },
                        onClick = {
                            menuOpen = false
                            technology.tiny.app.chat.Sharing.copyToClipboard(context, "image link", url)
                        },
                    )
                }
            }
        }

        call.inputJson?.takeIf { it.isNotBlank() && it != "{}" }?.let { input ->
            DetailSection("Input", prettyJson(input), inputOpen) { inputOpen = !inputOpen }
        }
        call.resultText?.takeIf { it.isNotBlank() }?.let { result ->
            DetailSection("Result", prettyJson(result), resultOpen) { resultOpen = !resultOpen }
        }
        call.error?.takeIf { it.isNotBlank() }?.let { err ->
            Text(
                "Error: $err",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

@androidx.compose.runtime.Composable
private fun DetailSection(label: String, body: String, isOpen: Boolean, onToggle: () -> Unit) {
    // Eased open/close (iOS 0.15s easeInOut disclosure parity).
    Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { onToggle() },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (isOpen) "▾" else "▸",
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelSmall,
                color = TinyGray,
            )
            Spacer(Modifier.width(4.dp))
            Text(label, style = MaterialTheme.typography.labelSmall, color = TinyGray)
        }
        if (isOpen) {
            // Scrollable, capped-height code block (web: <pre> max-h-56 overflow-auto).
            Text(
                body,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 220.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color.Black.copy(alpha = 0.5f))
                    .verticalScroll(rememberScrollState())
                    .horizontalScroll(rememberScrollState())
                    .padding(8.dp),
            )
        }
    }
}

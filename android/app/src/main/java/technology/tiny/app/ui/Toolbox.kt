package technology.tiny.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Handyman
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.chat.ChatViewModel
import technology.tiny.app.chat.Sharing
import technology.tiny.app.ui.theme.TinyGray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** One of MY forged tools (GET /api/tools row) — stored name omits the my_ prefix. */
data class MyTool(
    val name: String,
    val description: String,
    val params: List<Pair<String, String>> = emptyList(),
    val code: String = "",
    val created: Long = 0L,
)

/** Typed outcome of the shared GET /api/tools fetch (slash command + panel). */
sealed interface ToolboxLoad {
    data class Ok(val tools: List<MyTool>) : ToolboxLoad
    /** Transport/HTTP/424 failure — NEVER rendered as an empty toolbox (web masked-empty class). */
    data class Failed(val message: String) : ToolboxLoad
}

// -- pure helpers (top-level, JVM unit-tested in ToolboxTest) ------------------

/**
 * Worker timestamps are unix SECONDS; some proxies hand back milliseconds. Same
 * guard as web Profile.tsx:79 (`joined < 1e12 ? joined * 1000 : joined`).
 */
fun epochMs(v: Long): Long = if (v in 1..999_999_999_999L) v * 1000 else v

/** "building since July 2026" date half (web Profile.tsx:78 en-US long month + year). 0/absent → null. */
fun formatJoinedDate(joined: Long): String? {
    if (joined <= 0) return null
    val fmt = SimpleDateFormat("MMMM yyyy", Locale.US)
    fmt.timeZone = TimeZone.getTimeZone("UTC")
    return fmt.format(Date(epochMs(joined)))
}

/** Toolbox-row created stamp — "Jul 7, 2026". 0/absent → null (row line omitted). */
fun formatToolCreated(created: Long): String? {
    if (created <= 0) return null
    val fmt = SimpleDateFormat("MMM d, yyyy", Locale.US)
    fmt.timeZone = TimeZone.getTimeZone("UTC")
    return fmt.format(Date(epochMs(created)))
}

/** "alive since Jul 2026" — a tiny card's age (web Profile.tsx:162 short month + year). 0/absent → null. */
fun formatAliveSince(created: Long): String? {
    if (created <= 0) return null
    val fmt = SimpleDateFormat("MMM yyyy", Locale.US)
    fmt.timeZone = TimeZone.getTimeZone("UTC")
    return fmt.format(Date(epochMs(created)))
}

/**
 * Tool params → alphabetized (key, description) display rows. The worker stores
 * params stringified, the Next proxy re-parses to an object — accept BOTH a
 * JSONObject and a JSON string (same tolerance as ProfileSheet's parser).
 */
fun toolParamRows(raw: Any?): List<Pair<String, String>> {
    val o = when (raw) {
        is JSONObject -> raw
        is String -> runCatching { JSONObject(raw) }.getOrNull()
        else -> null
    } ?: return emptyList()
    return o.keys().asSequence().map { k -> k to o.optString(k) }.sortedBy { it.first }.toList()
}

/** GET /api/tools `tools` array → typed rows; nameless entries dropped. */
fun parseMyTools(arr: JSONArray?): List<MyTool> =
    (0 until (arr?.length() ?: 0)).mapNotNull { i ->
        arr?.optJSONObject(i)?.takeIf { it.optString("name").isNotEmpty() }?.let { o ->
            MyTool(
                name = o.optString("name").removePrefix("my_"),
                description = o.optString("description"),
                params = toolParamRows(o.optJSONObject("params") ?: o.optString("params").takeIf { it.isNotEmpty() }),
                code = o.optString("code"),
                created = o.optLong("created"),
            )
        }
    }

// -- the sheet -----------------------------------------------------------------

/**
 * My forged toolbox — visual port of web Control.tsx "My Forged Tools" panel.
 * Lists the signed-in account's my_* tools (N/20 badge + refresh), each row
 * expandable to params + source (copy), with a confirmed delete that removes
 * optimistically and restores on failure. Load/delete go through the SAME
 * ChatViewModel calls the /tools mine and /tools rm slash commands use, so the
 * two surfaces can't drift.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ToolboxSheet(vm: ChatViewModel, onDismiss: () -> Unit) {
    val app = LocalContext.current.applicationContext as TinyApp
    var tools by remember { mutableStateOf<List<MyTool>?>(null) } // null = loading
    var failed by remember { mutableStateOf<String?>(null) }      // non-null = load failed (retry, NOT empty)
    var actionError by remember { mutableStateOf<String?>(null) } // delete failed (list already restored)
    var pendingDelete by remember { mutableStateOf<MyTool?>(null) }
    val scope = rememberCoroutineScope()

    fun reload() {
        tools = null
        failed = null
        scope.launch {
            when (val load = vm.fetchMyTools()) {
                is ToolboxLoad.Ok -> tools = load.tools
                is ToolboxLoad.Failed -> failed = load.message
            }
        }
    }
    LaunchedEffect(Unit) { if (app.auth.isLoggedIn) reload() }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SheetTitle(Icons.Outlined.Handyman, "my forged tools")
                    tools?.let {
                        Spacer(Modifier.width(8.dp))
                        Text("${it.size}/20", style = MaterialTheme.typography.labelSmall, color = TinyGray)
                    }
                    Spacer(Modifier.weight(1f))
                    if (app.auth.isLoggedIn) {
                        val loading = tools == null && failed == null
                        TextButton(onClick = { reload() }, enabled = !loading) {
                            Text(
                                if (loading) "refreshing…" else "refresh",
                                color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
            }

            actionError?.let { err ->
                item {
                    Text("⚠ $err", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                    Spacer(Modifier.height(8.dp))
                }
            }

            when {
                !app.auth.isLoggedIn -> item {
                    Text(
                        "🔑 sign in first — your toolbox lives on your account",
                        color = TinyGray, style = MaterialTheme.typography.bodyMedium,
                    )
                }
                failed != null -> item {
                    // Load failed (outage/401/424) — don't paint the calm "no tools yet",
                    // which reads as "your tools were deleted" (web Control.tsx myToolsFailed).
                    Column(Modifier.padding(vertical = 6.dp)) {
                        Text(failed!!, color = TinyGray, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { reload() }, contentPadding = PaddingValues(0.dp)) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                tools == null -> item { Text("loading tools…", color = TinyGray) }
                tools!!.isEmpty() -> item {
                    Text(
                        "no forged tools yet — ask any tiny to create one (\"forge a tool that…\"), or install one from a builder profile",
                        color = TinyGray, style = MaterialTheme.typography.bodyMedium,
                    )
                }
                else -> {
                    items(tools!!, key = { it.name }) { t ->
                        MyToolCard(app, t, onDelete = { pendingDelete = t })
                    }
                    item {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "tools follow your account across all your tinys as my_<name>",
                            style = MaterialTheme.typography.labelSmall, color = TinyGray,
                        )
                    }
                }
            }
        }
    }

    // Danger confirm before the irreversible delete (web ConfirmDialog parity).
    pendingDelete?.let { tool ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete my_${tool.name}?") },
            text = { Text("Your tinys lose this tool immediately. Anyone who already installed a copy keeps theirs.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    // Optimistic remove; restore + surface the error if the DELETE fails.
                    val before = tools
                    tools = before?.filterNot { it.name == tool.name }
                    actionError = null
                    scope.launch {
                        val err = vm.deleteMyToolNow(tool.name)
                        if (err != null) {
                            tools = before
                            actionError = err
                        }
                    }
                }) { Text("delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("cancel", color = TinyGray) }
            },
        )
    }
}

/** Expandable my-tool row: header (name/desc/created + delete), open = params + source + copy. */
@Composable
private fun MyToolCard(app: TinyApp, tool: MyTool, onDelete: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            kotlinx.coroutines.delay(1500)
            copied = false
        }
    }

    Column(
        Modifier.fillMaxWidth().padding(vertical = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable { open = !open }
            .padding(vertical = 8.dp, horizontal = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    "my_${tool.name}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary, fontFamily = FontFamily.Monospace,
                )
                if (tool.description.isNotEmpty()) {
                    Text(
                        tool.description,
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray, maxLines = if (open) 6 else 2,
                    )
                }
                formatToolCreated(tool.created)?.let {
                    Text("forged $it", style = MaterialTheme.typography.labelSmall, color = TinyGray)
                }
            }
            // Delete lives on the collapsed row (web Control.tsx row layout).
            TextButton(onClick = onDelete, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                Text("delete", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
            }
            Text(if (open) "▾" else "▸", color = TinyGray, style = MaterialTheme.typography.labelLarge)
        }
        if (open) {
            if (tool.params.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("params", style = MaterialTheme.typography.labelSmall, color = TinyGray)
                tool.params.forEach { (k, v) ->
                    Text(
                        "· $k — $v",
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray, fontFamily = FontFamily.Monospace,
                    )
                }
            }
            if (tool.code.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "source",
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray, modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        onClick = {
                            Sharing.copyToClipboard(app, "my_${tool.name}", tool.code)
                            copied = true
                        },
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                    ) {
                        Text(
                            if (copied) "copied ✓" else "copy",
                            color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
                Text(
                    tool.code,
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray, fontFamily = FontFamily.Monospace,
                    modifier = Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(technology.tiny.app.ui.theme.TinyCodeBg)
                        .padding(8.dp),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "runs in your own sandbox — public https fetch only, 10s timeout, no secrets",
                    style = MaterialTheme.typography.labelSmall, color = TinyGray,
                )
            }
        }
    }
}

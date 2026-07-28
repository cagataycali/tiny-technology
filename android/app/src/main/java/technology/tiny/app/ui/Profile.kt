package technology.tiny.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import kotlinx.coroutines.launch
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.net.WORKER_URL
import technology.tiny.app.ui.theme.TinyGray

/** "N noun" / "N nouns" — English count label (web Profile.tsx + iOS Panels.swift
 *  parity: "1 public tiny" / "3 forged tools" / "0 followers"). Pure/testable. */
internal fun pluralCount(n: Int, singular: String): String =
    "$n $singular${if (n == 1) "" else "s"}"

data class ProfileTiny(val name: String, val created: Long)
data class ProfileTool(
    val name: String,
    val description: String,
    val params: List<Pair<String, String>> = emptyList(),
    val code: String = "",
    // >0 → one-time purchase to install (set via set_price, tool:<login>/<name>).
    // The worker /profile LEFT JOINs the active price; 0/absent for free tools.
    val priceMicro: Long = 0L,
)

/** Min-2-fraction-digit USD label ("$0.50"), or "" when free — for the one-time
 *  tool-INSTALL charge chip. A one-time install charge is a CHARGE, not a
 *  per-message rate, so it must format through the canonical usd() (Rule B:
 *  min-2 up to 6 fraction digits → "$0.50"/"$1.00") — the SAME formatter the
 *  server-side install paywall (app/api/tools/install → usd()) and the wallet
 *  ledger use, so the chip's "$X to install" matches the 402 exactly. The old
 *  local `%.4f` + strip-trailing-zeros form rendered "$0.5"/"$1" (and a bare "$"
 *  for a ≤$0.00005 price), so the card said "$0.5 to install" while the paywall
 *  said "$0.50" — the display-vs-charge drift web (ProfileToolCard.tsx) and iOS
 *  (Panels.swift priceLabel) both closed by routing through usd(). This was the
 *  last client still on the buggy strip-zeros form. Pure/testable.
 *  (WalletCore.usd pins Locale.US, so a comma-decimal device still shows "$0.50".) */
internal fun priceLabel(priceMicro: Long): String {
    if (priceMicro <= 0L) return ""
    return technology.tiny.app.wallet.WalletCore.usd(priceMicro)
}
data class Profile(
    val login: String,
    val name: String,
    val avatar: String,
    val followers: Int,
    val joined: Long, // unix (worker user.created) → "building since <Month Year>"
    val tinys: List<ProfileTiny>,
    val tools: List<ProfileTool>,
)

/**
 * Builder profile — native port of web components/Profile.tsx (the @<login>
 * page). Public data from the worker's `/profile?login=` endpoint (private
 * tinys never leave the worker; tool code is public by design). Shows the
 * builder's GitHub identity, follower count, their public tinys (tap to
 * switch), and their forged tools. Distinguishes not-found (genuine "no such
 * builder") from a transient fetch failure — web's ProfileResult lesson: a
 * worker blip must NOT render as "unknown builder".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileSheet(app: TinyApp, login: String, onPickTiny: (String) -> Unit, onDismiss: () -> Unit) {
    // "loading" | "ok" | "not-found" | "failed"
    var state by remember(login) { mutableStateOf("loading") }
    var profile by remember(login) { mutableStateOf<Profile?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    // Owner check (web Profile.tsx isOwner): GET /api/me once per sheet open;
    // login match (case-insensitive) unlocks delete on the tool cards. A failed
    // /api/me just means no delete buttons — never blocks the public profile.
    var meLogin by remember { mutableStateOf<String?>(null) }
    // Tools deleted from THIS sheet — filtered out locally (web setProfile filter).
    var removedTools by remember(login) { mutableStateOf(setOf<String>()) }

    LaunchedEffect(Unit) {
        if (app.auth.isLoggedIn) {
            meLogin = runCatching { app.api.me() }.getOrNull()
                ?.optJSONObject("user")?.optString("login")?.takeIf { it.isNotEmpty() }
        }
    }

    LaunchedEffect(login, reloadKey) {
        state = "loading"
        profile = null
        val res = runCatching {
            app.api.getPublic("$WORKER_URL/profile?login=" + java.net.URLEncoder.encode(login, "UTF-8"))
        }.getOrNull()
        val status = res?.optInt("_status", 0) ?: 0
        // 404 = genuine no-such-builder; null/timeout/5xx = worker failing (retry,
        // NOT "unknown builder"); a login-less body = not-found (web normalizeProfile).
        when {
            res == null || (status in 500..599) -> state = "failed"
            status == 404 -> state = "not-found"
            res.optString("login").isEmpty() -> state = "not-found"
            else -> {
                val tArr = res.optJSONArray("tinys")
                val tinys = (0 until (tArr?.length() ?: 0)).mapNotNull { i ->
                    tArr?.optJSONObject(i)?.takeIf { it.optString("name").isNotEmpty() }
                        ?.let { ProfileTiny(it.optString("name"), it.optLong("created")) }
                }
                val oArr = res.optJSONArray("tools")
                val tools = (0 until (oArr?.length() ?: 0)).mapNotNull { i ->
                    oArr?.optJSONObject(i)?.takeIf { it.optString("name").isNotEmpty() }?.let { o ->
                        // params may arrive as a JSON object OR a JSON string (the worker
                        // stores it stringified) — accept both.
                        val paramsObj = o.optJSONObject("params")
                            ?: runCatching { JSONObject(o.optString("params")) }.getOrNull()
                        val params = paramsObj?.let { p ->
                            p.keys().asSequence().map { k -> k to p.optString(k) }.toList()
                        } ?: emptyList()
                        ProfileTool(o.optString("name"), o.optString("description"), params, o.optString("code"), o.optLong("price_micro", 0L))
                    }
                }
                profile = Profile(
                    login = res.optString("login"),
                    name = res.optString("name"),
                    avatar = res.optString("avatar"),
                    followers = res.optInt("followers", 0).coerceAtLeast(0),
                    joined = res.optLong("joined", 0L),
                    tinys = tinys,
                    tools = tools,
                )
                state = "ok"
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().heightIn(min = 200.dp).padding(horizontal = 20.dp)) {
            when (state) {
                "loading" -> Text("loading @$login…", color = TinyGray, modifier = Modifier.padding(vertical = 24.dp))
                "failed" -> Column(Modifier.padding(vertical = 16.dp)) {
                    Text("@$login", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                    Text(
                        "couldn't load this profile just now — usually momentary",
                        color = TinyGray, style = MaterialTheme.typography.bodyMedium,
                    )
                    TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                        Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                    }
                }
                "not-found" -> Column(Modifier.padding(vertical = 16.dp)) {
                    Text("@$login", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                    Text("no builder by that name", color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                }
                else -> profile?.let { p ->
                    LazyColumn(contentPadding = PaddingValues(bottom = 32.dp)) {
                        item {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (p.avatar.isNotEmpty()) {
                                    AsyncImage(
                                        model = p.avatar,
                                        contentDescription = "@${p.login} avatar",
                                        contentScale = ContentScale.Crop,
                                        modifier = Modifier.size(52.dp).clip(CircleShape),
                                    )
                                    Spacer(Modifier.width(12.dp))
                                }
                                Column(Modifier.weight(1f)) {
                                    if (p.name.isNotEmpty()) {
                                        Text(p.name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                                    }
                                    Text(
                                        "@${p.login}",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = TinyGray, fontFamily = FontFamily.Monospace,
                                    )
                                    // "building since <Month Year> · N followers" on ONE line
                                    // (web Profile.tsx:124-128 / iOS Panels.swift:479-484):
                                    // building-since first, followers folded in with "·" and
                                    // HIDDEN at 0 (a brand-new builder shouldn't read "0 followers").
                                    val meta = listOfNotNull(
                                        formatJoinedDate(p.joined)?.let { "building since $it" },
                                        pluralCount(p.followers, "follower").takeIf { p.followers > 0 },
                                    ).joinToString(" · ")
                                    if (meta.isNotEmpty()) {
                                        Text(meta, style = MaterialTheme.typography.labelSmall, color = TinyGray)
                                    }
                                }
                                FollowButton(app, p.login)
                            }
                            Spacer(Modifier.height(16.dp))
                        }
                        item {
                            Text(
                                pluralCount(p.tinys.size, "public tiny"),
                                style = MaterialTheme.typography.labelSmall, color = TinyGray,
                            )
                        }
                        if (p.tinys.isEmpty()) item {
                            Text("no public tinys", style = MaterialTheme.typography.bodyMedium, color = TinyGray)
                        }
                        items(p.tinys, key = { "tiny:" + it.name }) { t ->
                            Column(
                                Modifier.fillMaxWidth()
                                    .clickable { onPickTiny(t.name); onDismiss() }
                                    .padding(vertical = 8.dp),
                            ) {
                                Text(
                                    t.name,
                                    style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary,
                                )
                                // "alive since <Mon Year>" — a tiny's age is signal; web
                                // Profile.tsx:161 falls back to the URL when created is absent.
                                Text(
                                    formatAliveSince(t.created)?.let { "alive since $it" }
                                        ?: "tiny.technology/${t.name}",
                                    style = MaterialTheme.typography.labelSmall, color = TinyGray,
                                )
                            }
                        }
                        val visibleTools = p.tools.filterNot { it.name in removedTools }
                        if (visibleTools.isNotEmpty()) {
                            item {
                                Spacer(Modifier.height(16.dp))
                                Text(
                                    pluralCount(visibleTools.size, "forged tool"),
                                    style = MaterialTheme.typography.labelSmall, color = TinyGray,
                                )
                            }
                            items(visibleTools, key = { "tool:" + it.name }) { tool ->
                                ProfileToolCard(
                                    app, p.login, tool,
                                    canDelete = meLogin?.equals(p.login, ignoreCase = true) == true,
                                    onDeleted = { removedTools = removedTools + tool.name },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Expandable tool card — native port of web components/ProfileToolCard.tsx.
 * Tap to reveal the tool's params + source; "use this tool" copies it into the
 * signed-in user's own account via POST /api/tools/install {login, name} → it
 * runs in their sandbox as my_<name>. The server re-fetches the author's public
 * code (never client-supplied) and re-validates, so we only send login+name.
 * 401 → login required (the app is already gated behind auth, so this is rare).
 */
@Composable
private fun ProfileToolCard(
    app: TinyApp,
    ownerLogin: String,
    tool: ProfileTool,
    canDelete: Boolean = false, // visitor owns this profile (session-checked via /api/me)
    onDeleted: () -> Unit = {}, // parent removes the card from its list
) {
    var open by remember { mutableStateOf(false) }
    var installing by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<Pair<Boolean, String>?>(null) } // ok? to msg
    var copied by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
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
        val label = priceLabel(tool.priceMicro)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(tool.name, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                    // Priced tool → one-time purchase to install (web card's chip).
                    if (label.isNotEmpty()) {
                        Text(
                            "$label to install",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier
                                .clip(RoundedCornerShape(50))
                                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }
                if (tool.description.isNotEmpty()) {
                    Text(
                        tool.description,
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray, maxLines = if (open) 6 else 2,
                    )
                }
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
                    // web ProfileToolCard copy button — clipboard, transient "copied ✓"
                    TextButton(
                        onClick = {
                            technology.tiny.app.chat.Sharing.copyToClipboard(app, "my_${tool.name}", tool.code)
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
                    maxLines = 12,
                    modifier = Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(technology.tiny.app.ui.theme.TinyCodeBg)
                        .padding(8.dp),
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = {
                        if (installing) return@Button
                        installing = true
                        status = null
                        scope.launch {
                            val res = runCatching {
                                app.api.postJson(
                                    "/api/tools/install",
                                    JSONObject().put("login", ownerLogin).put("name", tool.name),
                                )
                            }.getOrNull()
                            val code = res?.optInt("_status", 200) ?: 0
                            status = when {
                                res == null -> false to "couldn't reach the server — try again"
                                code == 401 -> false to "sign in to install tools"
                                res.optBoolean("ok", false) -> {
                                    val nm = res.optString("name", tool.name)
                                    true to (
                                        if (res.optBoolean("updated", false)) "updated my_$nm — already in your toolbox"
                                        else "added! ask any tiny to use my_$nm"
                                        )
                                }
                                // Priced tool + wallet short (or settle failed): the API
                                // message already names the price + balance; point at /wallet.
                                res.optBoolean("payment_required", false) ->
                                    false to (res.optString("error").ifEmpty { "payment required to install" } + " → /wallet")
                                else -> false to res.optString("error").ifEmpty { "install failed (HTTP $code)" }
                            }
                            installing = false
                        }
                    },
                    enabled = !installing,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = androidx.compose.ui.graphics.Color.Black,
                    ),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                ) {
                    Text(
                        if (installing) "installing…"
                        else if (label.isNotEmpty()) "buy · $label"
                        else "use this tool",
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
                // Owner-only delete (web ProfileToolCard canDelete): confirm →
                // DELETE /api/tools {name} → parent drops the card from its list.
                if (canDelete) {
                    Spacer(Modifier.width(12.dp))
                    TextButton(onClick = { confirmDelete = true }, enabled = !deleting) {
                        Text(
                            if (deleting) "deleting…" else "delete",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
            }
            status?.let { (ok, msg) ->
                Spacer(Modifier.height(4.dp))
                Text(
                    msg,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
            }
            // One-time-charge disclosure (web card footer) — only when priced.
            if (label.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "One-time $label charge from your wallet on install.",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
            }
        }
    }

    // Danger confirm before the irreversible owner delete (web ConfirmDialog parity).
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete tool?") },
            text = { Text("my_${tool.name} — anyone who already installed a copy keeps theirs. This removes it from your toolbox.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    deleting = true
                    status = null
                    scope.launch {
                        val res = runCatching {
                            app.api.deleteJson("/api/tools", JSONObject().put("name", tool.name))
                        }.getOrNull()
                        deleting = false
                        if (res?.optBoolean("ok") == true) onDeleted()
                        else status = false to (res?.optString("error")?.takeIf { it.isNotEmpty() }
                            ?: "couldn't delete — try again")
                    }
                }) { Text("delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("cancel", color = TinyGray) }
            },
        )
    }
}

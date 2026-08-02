package technology.tiny.app.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.chat.MemoryEntry
import technology.tiny.app.ui.theme.TinyGray

/** A server learning row. [live] ← the bitemporal `freshness` field: "closed"
 *  facts are archived (superseded), everything else is live — same rule the
 *  memory graph uses (MemoryGraph.kt:105). iOS shows a live/archived StatusDot
 *  per row (Panels.swift:1372); web splits live vs closed (MemoryPanel.tsx:282). */
data class Learning(val id: String, val content: String, val live: Boolean = true)

/** Bitemporal freshness → live? A learning is archived ONLY when explicitly
 *  "closed" (superseded); any other/absent value reads live (web/iOS parity). */
internal fun learningIsLive(freshness: String): Boolean = freshness != "closed"

data class UniverseTiny(val name: String, val prompt: String, val login: String = "")

/** Per-builder card model (web CommunityUser). */
data class CommunityBuilder(
    val login: String,
    val name: String,
    val avatar: String,
    val tinyCount: Int,
    val tinys: List<String>,
)

/** Full /community payload (web CommunityData): builders + PageRank trust + headline stats. */
data class CommunityData(
    val builders: List<CommunityBuilder>,
    val trust: Map<String, Double>,
    val totalMessages: Int,
    val totalPublicTinys: Int,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemorySheet(app: TinyApp, tiny: String, onOpenGraph: (() -> Unit)? = null, onDismiss: () -> Unit) {
    // 🧠 Screenshot harness (debug builds only) — see MemoryHarness for why this sheet
    // needs one at all, and why BOTH halves are substituted: this sheet renders TWO
    // ungated sources, and a harness for the network fetch alone would leave the
    // on-device memories live while still being called "the memory harness".
    val demo = MemoryHarness.enabled(technology.tiny.app.BuildConfig.DEBUG, app.memoryHarness)
    var local by remember {
        mutableStateOf(if (demo) MemoryHarness.localEntries() else app.continuity.loadMemories(tiny))
    }
    var server by remember { mutableStateOf<List<Learning>?>(null) }
    var serverFailed by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(reloadKey) {
        serverFailed = null
        server = null
        // Return BEFORE the fetch, so a capture sends no request for the real learnings
        // (same ordering argument as GraphSheet's, and it also means the harness can
        // never mask a real load failure — there is no load to fail).
        if (demo) {
            server = MemoryHarness.learnings()
            return@LaunchedEffect
        }
        val res = runCatching { app.api.getJson("/api/learnings?limit=200") }.getOrNull()
        // One rule for all six list sheets ([LoadFailure]) — kept DISTINCT from a clean
        // empty list so we don't render "nothing yet" (indistinguishable from genuinely
        // empty) on an outage (iOS 3c37c2d parity). The rule asks whether the array
        // ARRIVED, which a 200 that wasn't JSON fails while satisfying `status < 400`.
        //
        // Both key names, because this route has answered under each and the reader
        // below accepts either — a rule that knew only one would call a good load a
        // failure the day the other came back.
        val body = LoadFailure.loaded(res, "learnings", alt = "memories")
        if (body == null) {
            serverFailed = LoadFailure.contentMessage(res, "learnings", "your memories", alt = "memories")
            return@LaunchedEffect
        }
        val arr = body.optJSONArray("learnings") ?: body.optJSONArray("memories")
        server = (0 until (arr?.length() ?: 0)).mapNotNull { i ->
            arr?.optJSONObject(i)?.let {
                Learning(it.optString("id"), it.optString("content"), learningIsLive(it.optString("freshness", "live")))
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    SheetTitle(Icons.Outlined.Psychology, "memory")
                    if (onOpenGraph != null) {
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = onOpenGraph, contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Text("🕸 graph", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text("on this phone (remember tool)", style = MaterialTheme.typography.labelSmall, color = TinyGray)
            }
            if (local.isEmpty()) item { Text("nothing yet", style = MaterialTheme.typography.bodyMedium, color = TinyGray) }
            items(local, key = { it.id }) { m: MemoryEntry ->
                MemoryRow(m.content) {
                    // ⚠️ Under the harness, drop the row from the LIST ONLY. The real
                    // handler re-reads Continuity afterwards, so one tap on a demo row
                    // would swap the user's real on-device memories into the frame —
                    // the very leak the harness exists to prevent, fired by its own UI.
                    // The row still animates out, so the control stays honest.
                    if (demo) {
                        local = local.filterNot { it.id == m.id }
                    } else {
                        app.continuity.forgetMemory(tiny, m.content.take(40))
                        local = app.continuity.loadMemories(tiny)
                    }
                }
            }
            item {
                Spacer(Modifier.height(16.dp))
                Text("server learnings", style = MaterialTheme.typography.labelSmall, color = TinyGray)
            }
            when {
                serverFailed != null -> item {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        Text(serverFailed!!, style = MaterialTheme.typography.bodySmall, color = TinyGray)
                        TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                server == null -> item { SheetLoading() }
                server!!.isEmpty() -> item { Text("nothing yet", style = MaterialTheme.typography.bodyMedium, color = TinyGray) }
                else -> items(server!!, key = { it.id }) { l ->
                    MemoryRow(l.content, live = l.live) {
                        // ⚠️ Under the harness this must not reach the network. The id is
                        // fabricated so nothing would match it, but a DELETE is still a
                        // real write aimed at the user's real account, and the standing
                        // capture rule is to seed content and never mutate the account
                        // for an asset.
                        if (demo) {
                            server = server?.filterNot { it.id == l.id }
                            return@MemoryRow
                        }
                        scope.launch {
                            // Only drop the row on a CONFIRMED delete. The old code
                            // filtered it out regardless of the result, so a failed
                            // delete (500/timeout/non-2xx) left the memory ALIVE on the
                            // server but vanished from the list — a false "forgotten"
                            // (privacy-relevant; mirrors web df73551's DELETE-on-unconfirmed
                            // -write fix). On failure surface it so the user can retry.
                            val res = runCatching {
                                app.api.deleteJson("/api/learnings", JSONObject().put("id", l.id))
                            }.getOrNull()
                            if (res != null && res.optInt("_status", 200) < 400) {
                                server = server?.filterNot { it.id == l.id }
                            } else {
                                serverFailed = "couldn't forget that — try again"
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MemoryRow(content: String, live: Boolean? = null, onDelete: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.Top) {
        // Server learnings carry bitemporal freshness → 🟢 live / ⚪ archived
        // (iOS StatusDot / web live-vs-closed parity, MemoryGraph glyphs). Local
        // memories have no freshness, so they keep the plain accent bullet.
        Text(
            when (live) { true -> "🟢"; false -> "⚪"; null -> "·" },
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.width(8.dp))
        Text(
            content,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
            // Archived facts read dimmer, like the graph's closed nodes / iOS's archived dot.
            color = if (live == false) TinyGray else MaterialTheme.colorScheme.onSurface,
        )
        TextButton(onClick = onDelete, contentPadding = PaddingValues(0.dp)) {
            Text("forget", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
    }
}

/** Fetch the public community. Throws on transport/HTTP/parse failure so the caller
 *  can distinguish a real FAILURE from a genuinely empty universe (a collapsed empty
 *  list makes a worker outage render as "be the first builder" — web getCommunity
 *  `failed` flag / iOS 3c37c2d parity). Returns builders + trust map + headline stats. */
internal suspend fun fetchCommunity(): CommunityData = withContext(Dispatchers.IO) {
    // Public universe endpoint — the ONE allowed direct worker call (iOS parity).
    OkHttpClient().newCall(
        Request.Builder().url("https://plugin.tiny.technology/community?limit=50").get().build()
    ).execute().use { resp ->
        if (!resp.isSuccessful) error("HTTP ${resp.code}")
        // Shape: {users:[{login, name, avatar, tinyCount, tinys:[{name,created}]}],
        // trust:{slug:0..1}, totalPublicTinys, totalMessages}.
        val o = JSONObject(resp.body?.string().orEmpty())
        val users = o.optJSONArray("users")
        val builders = buildList {
            for (i in 0 until (users?.length() ?: 0)) {
                val u = users?.optJSONObject(i) ?: continue
                val login = u.optString("login")
                if (login.isEmpty()) continue
                val tArr = u.optJSONArray("tinys")
                val names = (0 until (tArr?.length() ?: 0)).mapNotNull { j ->
                    tArr?.optJSONObject(j)?.optString("name")?.takeIf { it.isNotEmpty() }
                }
                add(
                    CommunityBuilder(
                        login = login,
                        name = u.optString("name"),
                        avatar = u.optString("avatar"),
                        tinyCount = u.optInt("tinyCount", names.size),
                        tinys = names,
                    )
                )
            }
        }
        // Trust map: only well-shaped {slug: finite 0<n<=1} entries survive (web guard).
        val trust = HashMap<String, Double>()
        o.optJSONObject("trust")?.let { t ->
            val keys = t.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val n = t.optDouble(k, Double.NaN)
                if (k.isNotEmpty() && n.isFinite() && n > 0 && n <= 1) trust[k] = n
            }
        }
        CommunityData(
            builders = builders,
            trust = trust,
            totalMessages = o.optInt("totalMessages", 0).coerceAtLeast(0),
            totalPublicTinys = o.optInt("totalPublicTinys", 0).coerceAtLeast(0),
        )
    }
}

/** Size a GitHub avatar at the source (web githubAvatar): request a 2×-DPR square
 *  thumbnail so a grid of ~50 avatars fetches ~80px images, not full-res. Only
 *  rewrites githubusercontent URLs; anything else (or empty) passes through. */
internal fun githubAvatar(url: String, size: Int): String {
    if (url.isEmpty() || !url.contains("githubusercontent.com")) return url
    val px = (size * 2).coerceAtLeast(1)
    return url + (if (url.contains("?")) "&" else "?") + "s=$px"
}

/** 1_880_100 → "1.9M", 45_300 → "45K" — headline-sized, not precise. Byte-for-byte
 *  twin of web lib/community.ts compact() + iOS CommunityFmt.compact (Panels.swift):
 *  tier thresholds sit where the tier BELOW would round up past its own ceiling
 *  (999_500 → "1.0M", not "1000K"; 999_950_000 → "1.0B"), K-tier ROUNDS (Math.round,
 *  not truncation, so 45_800 → "46K"), and ≤0 → "0" (never "-5"/"NaN" on a card).
 *  Locale.US → dot decimal (toFixed parity); a bare .format() would print "1,9M" on
 *  a comma-decimal device. */
internal fun compact(n: Int): String = when {
    n <= 0 -> "0"
    n >= 999_950_000 -> String.format(java.util.Locale.US, "%.1fB", n / 1_000_000_000.0)
    n >= 999_500 -> String.format(java.util.Locale.US, "%.1fM", n / 1_000_000.0)
    n >= 1_000 -> "${Math.round(n / 1_000.0)}K"
    else -> n.toString()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UniverseSheet(app: TinyApp, onPick: (String) -> Unit, onOpenProfile: (String) -> Unit = {}, onDismiss: () -> Unit) {
    var data by remember { mutableStateOf<CommunityData?>(null) }
    var failed by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }

    // reloadKey flips to re-trigger the LaunchedEffect on Retry.
    var reloadKey by remember { mutableStateOf(0) }
    LaunchedEffect(reloadKey) {
        failed = false
        data = null
        runCatching { fetchCommunity() }
            .onSuccess { data = it }
            .onFailure { failed = true } // distinct from a loaded-but-empty universe
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
            SheetTitle(Icons.Outlined.Hub, "universe")
            data?.let { d ->
                // Headline stats (web: "N messages · N builders · N public tinys").
                val bits = buildList {
                    if (d.totalMessages > 0) add("${compact(d.totalMessages)} messages")
                    add("${d.builders.size} builder${if (d.builders.size == 1) "" else "s"}")
                    add("${d.totalPublicTinys} public tiny${if (d.totalPublicTinys == 1) "" else "s"}")
                }
                Text(bits.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = TinyGray)
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("search builders & tinys…") },
                singleLine = true,
                // A non-empty query is clearable in one tap without dismissing the
                // sheet — the touch-native twin of iOS .searchable's built-in clear X
                // (Panels.swift:113) and web's ✕ / Escape-clears-first (UniverseDrawer
                // .tsx:229, UniverseDirectory.tsx:51). Without it, Android could only
                // clear by backspacing or by dropping the whole sheet (losing the
                // scroll position + the loaded universe) — a 2-vs-1 gap.
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        TextButton(onClick = { query = "" }) {
                            Text("✕", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            LazyColumn(contentPadding = PaddingValues(bottom = 32.dp)) {
                val builders = data?.builders.orEmpty().filter {
                    query.isBlank() || it.login.contains(query, true) ||
                        it.name.contains(query, true) || it.tinys.any { n -> n.contains(query, true) }
                }
                when {
                    failed -> item {
                        Column(Modifier.padding(vertical = 6.dp)) {
                            Text("couldn't load the universe just now — usually momentary", color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = { reloadKey++ }) {
                                Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    data == null -> item { SheetLoading() }
                    data!!.builders.isEmpty() -> item { SheetEmpty(Icons.Outlined.Hub, "no builders yet", "be the first — publish a tiny") }
                    // Echo the query back so an empty result reads as "your search
                    // found nothing" not "the universe is empty" — iOS (Panels.swift:103
                    // `No tinys match "query"`) and web (UniverseDirectory.tsx:63
                    // `No builders or tinys match "query"`) both quote it. Android
                    // filters on login/name/tiny-name (the same fields web does), so
                    // web's "builders or tinys" wording describes this filter exactly.
                    builders.isEmpty() -> item {
                        Text("no builders or tinys match “$query”", color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                items(builders, key = { it.login }) { b ->
                    BuilderCard(app, b, data?.trust.orEmpty(), onPick = { onPick(it); onDismiss() }, onOpenProfile = onOpenProfile)
                }
            }
        }
    }
}

/** One builder card (web Community grid cell): avatar + @login → profile + name +
 *  tiny-count badge + tiny chips (⚡ = PageRank-trusted, consulted by other tinys). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BuilderCard(
    app: TinyApp,
    b: CommunityBuilder,
    trust: Map<String, Double>,
    onPick: (String) -> Unit,
    onOpenProfile: (String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.25f), RoundedCornerShape(12.dp))
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (b.avatar.isNotEmpty()) {
                AsyncImage(
                    model = githubAvatar(b.avatar, 40),
                    contentDescription = "@${b.login}",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(40.dp).clip(CircleShape),
                )
            } else {
                Box(
                    Modifier.size(40.dp).clip(CircleShape)
                        .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.4f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        (b.login.firstOrNull()?.uppercase() ?: "?"),
                        color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleMedium,
                    )
                }
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f).clickable { onOpenProfile(b.login) }) {
                Text("@${b.login}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary, maxLines = 1)
                if (b.name.isNotEmpty()) {
                    Text(b.name, style = MaterialTheme.typography.labelSmall, color = TinyGray, maxLines = 1)
                }
            }
            AssistChip(
                onClick = { onOpenProfile(b.login) },
                label = { Text("${b.tinyCount} tiny${if (b.tinyCount == 1) "" else "s"}", style = MaterialTheme.typography.labelSmall) },
            )
        }
        if (b.tinys.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // Cap at 8 chips (web slice(0,8)); a "+N more" chip opens the profile.
                b.tinys.take(8).forEach { name ->
                    val trusted = trust.containsKey(name)
                    SuggestionChip(
                        onClick = { onPick(name) },
                        label = {
                            Text(
                                (if (trusted) "⚡ " else "") + name,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        },
                    )
                }
                if (b.tinys.size > 8) {
                    SuggestionChip(
                        onClick = { onOpenProfile(b.login) },
                        label = { Text("+${b.tinys.size - 8} more", style = MaterialTheme.typography.labelSmall, color = TinyGray) },
                    )
                }
            }
        }
    }
}

/**
 * Follow / unfollow a builder — native port of web components/FollowButton.tsx.
 * The follow edge is the user-gesture social edge; the follower is ALWAYS the
 * session identity server-side (/api/follow uses session.sub, never trusts a
 * client-supplied follower). States mirror web:
 *   probing (GET in flight) → nothing rendered (no layout flash)
 *   logged out (401) / self / unknown builder → hidden
 *   following=false → "follow"; following=true → "following ✓" (tap to unfollow)
 * Unfollow closes bitemporally server-side (history survives), same as web.
 */
@Composable
fun FollowButton(app: TinyApp, login: String) {
    // null = probing/hidden; false = not following; true = following.
    var following by remember(login) { mutableStateOf<Boolean?>(null) }
    var visible by remember(login) { mutableStateOf(false) }
    var busy by remember(login) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(login) {
        val res = runCatching {
            app.api.getJson("/api/follow?login=" + java.net.URLEncoder.encode(login, "UTF-8"))
        }.getOrNull()
        // 401 logged-out, self, or unknown builder → stay hidden (web parity: no
        // button on a public profile you can't act on). Only a clean 2xx with a
        // following flag reveals the control.
        val status = res?.optInt("_status", 0) ?: 0
        if (res == null || status >= 400) return@LaunchedEffect
        if (res.optString("error").isNotEmpty()) return@LaunchedEffect
        following = res.optBoolean("following", false)
        visible = true
    }

    if (!visible || following == null) return

    val isFollowing = following == true
    OutlinedButton(
        onClick = {
            if (busy) return@OutlinedButton
            busy = true
            val next = !isFollowing
            scope.launch {
                val res = runCatching {
                    app.api.postJson(
                        "/api/follow",
                        JSONObject().put("login", login).put("action", if (next) "follow" else "unfollow"),
                    )
                }.getOrNull()
                // Flip state only on a CONFIRMED ok — a failed toggle must not
                // lie about the edge (same discipline as the memory-forget path).
                if (res != null && res.optInt("_status", 200) < 400 && res.optBoolean("ok", false)) {
                    following = next
                }
                busy = false
            }
        },
        enabled = !busy,
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
        colors = if (isFollowing) ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.primary)
        else ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary, contentColor = androidx.compose.ui.graphics.Color.Black),
    ) {
        Text(
            if (isFollowing) "following ✓" else "follow",
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

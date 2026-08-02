package technology.tiny.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Handyman
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Schema
import androidx.compose.material.icons.outlined.Sensors
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import technology.tiny.app.ChatScreen
import technology.tiny.app.chat.ChatViewModel
import technology.tiny.app.ui.theme.TinyGray
import technology.tiny.app.ui.theme.TinySurface

/**
 * Adaptive root (iOS Split.swift parity). On a wide canvas — tablet, unfolded
 * foldable, big-phone landscape — a persistent sidebar sits beside the chat:
 * every surface (memory/jobs/devices/messages/universe/settings) one tap away
 * and the community's tinys resident, instead of hidden behind sheets. On a
 * compact width (phone portrait) it's the plain ChatScreen, untouched.
 *
 * The sidebar and ChatScreen share ONE ChatViewModel, so a sidebar tap just
 * sets vm.openPanel / calls vm.switchTiny and the EXISTING sheet machinery in
 * ChatScreen renders it — no panel logic is duplicated. iOS routes this through
 * a Router mailbox because its ChatView is monolithic; here the shared VM IS
 * the mailbox.
 *
 * Breakpoint: 600dp (Material's compact→medium cut) via LocalConfiguration —
 * no window-size-class dependency needed. The Pixel 10 Pro Fold opens to
 * ~700dp+, landscape big phones cross 600dp, portrait phones stay under.
 */
@Composable
fun AdaptiveChat(
    login: String?,
    openDmWith: String? = null,
    onDmConsumed: () -> Unit = {},
    widgetRoute: String? = null,
    onRouteConsumed: () -> Unit = {},
    askSend: String? = null,
    onAskSendConsumed: () -> Unit = {},
    tinyRoute: String? = null,
    onTinyConsumed: () -> Unit = {},
    sharedText: String? = null,
    onSharedTextConsumed: () -> Unit = {},
    sharedImageUris: List<String> = emptyList(),
    onSharedImagesConsumed: () -> Unit = {},
    sharedDocUris: List<String> = emptyList(),
    onSharedDocsConsumed: () -> Unit = {},
    onReplayTour: () -> Unit = {},
    onSignIn: (() -> Unit)? = null,
) {
    val vm: ChatViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    // Profile opened from the wide-layout sidebar (a builder's @handle). Lives here,
    // not in ChatScreen's own profileLogin, because the sidebar is ChatScreen's
    // sibling and can't reach that private state.
    var sidebarProfile by remember { mutableStateOf<String?>(null) }

    if (!wide) {
        ChatScreen(
            login = login,
            openDmWith = openDmWith,
            onDmConsumed = onDmConsumed,
            widgetRoute = widgetRoute,
            onRouteConsumed = onRouteConsumed,
            askSend = askSend,
            onAskSendConsumed = onAskSendConsumed,
            tinyRoute = tinyRoute,
            onTinyConsumed = onTinyConsumed,
            sharedText = sharedText,
            onSharedTextConsumed = onSharedTextConsumed,
            sharedImageUris = sharedImageUris,
            onSharedImagesConsumed = onSharedImagesConsumed,
            sharedDocUris = sharedDocUris,
            onSharedDocsConsumed = onSharedDocsConsumed,
            onReplayTour = onReplayTour,
            onSignIn = onSignIn,
            vm = vm,
        )
        return
    }

    Row(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Sidebar(
            currentTiny = vm.tiny,
            onOpenPanel = { vm.openPanel = it },
            onPickTiny = { vm.switchTiny(it) },
            // Tapping a builder's @handle opens their profile (tinys + tools) — the
            // same ProfileSheet the phone universe uses. Rendered here in the wide
            // layout because the sidebar is a sibling of ChatScreen (whose own
            // profileLogin state it can't reach); no ChatViewModel coupling needed.
            onOpenProfile = { sidebarProfile = it },
            modifier = Modifier.width(280.dp).fillMaxHeight(),
        )
        Divider(
            Modifier.fillMaxHeight().width(1.dp),
            color = TinyGray.copy(alpha = 0.15f),
        )
        Column(Modifier.weight(1f).fillMaxHeight()) {
            ChatScreen(
                login = login,
                openDmWith = openDmWith,
                onDmConsumed = onDmConsumed,
                widgetRoute = widgetRoute,
                onRouteConsumed = onRouteConsumed,
                askSend = askSend,
                onAskSendConsumed = onAskSendConsumed,
                tinyRoute = tinyRoute,
                onTinyConsumed = onTinyConsumed,
                sharedText = sharedText,
                onSharedTextConsumed = onSharedTextConsumed,
                sharedImageUris = sharedImageUris,
                onSharedImagesConsumed = onSharedImagesConsumed,
                sharedDocUris = sharedDocUris,
                onSharedDocsConsumed = onSharedDocsConsumed,
                onReplayTour = onReplayTour,
                onSignIn = onSignIn,
                vm = vm,
            )
        }
    }
    sidebarProfile?.let { login ->
        val app = androidx.compose.ui.platform.LocalContext.current.applicationContext as technology.tiny.app.TinyApp
        ProfileSheet(
            app, login,
            // Picking a tiny from the profile switches the shared VM and closes the sheet.
            onPickTiny = { vm.switchTiny(it); sidebarProfile = null },
        ) { sidebarProfile = null }
    }
}

/** Resident sidebar: surface shortcuts + the live community tree (iOS SidebarView). */
@Composable
private fun Sidebar(
    currentTiny: String,
    onOpenPanel: (String) -> Unit,
    onPickTiny: (String) -> Unit,
    onOpenProfile: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    // 3-state load, same discipline as UniverseSheet: an outage → Retry, NOT a
    // false-empty "no tinys yet".
    var data by remember { mutableStateOf<CommunityData?>(null) }
    var failed by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var reloadKey by remember { mutableStateOf(0) }
    var expanded by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reloadKey) {
        loading = true; failed = false
        runCatching { fetchCommunity() }
            .onSuccess { data = it; loading = false }
            .onFailure { data = null; failed = true; loading = false }
    }

    Column(modifier.background(TinySurface).statusBarsPadding().padding(vertical = 12.dp)) {
        Text(
            // Plain wordmark, matching the phone header (accent "tiny", no emoji) —
            // the sidebar's seedling prefix was the one place the brand still carried
            // an emoji glyph.
            "tiny",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )

        LazyColumn(Modifier.fillMaxSize()) {
            item {
                SectionLabel("Surfaces")
                SidebarRow(Icons.Outlined.Psychology, "Memory") { onOpenPanel("memory") }
                SidebarRow(Icons.Outlined.Schema, "Memory graph") { onOpenPanel("graph") }
                SidebarRow(Icons.Outlined.Hub, "Universe") { onOpenPanel("universe") }
                SidebarRow(Icons.Outlined.Schedule, "Scheduled jobs") { onOpenPanel("jobs") }
                SidebarRow(Icons.Outlined.Handyman, "Toolbox") { onOpenPanel("toolbox") }
                SidebarRow(Icons.Outlined.Devices, "Devices") { onOpenPanel("devices") }
                SidebarRow(Icons.Outlined.Sensors, "Nearby") { onOpenPanel("nearby") }
                SidebarRow(Icons.Outlined.Forum, "Messages") { onOpenPanel("messages") }
                SidebarRow(Icons.Outlined.Bolt, "Activity") { onOpenPanel("activity") }
                SidebarRow(Icons.Outlined.Settings, "Settings") { onOpenPanel("settings") }
                Spacer(Modifier.height(8.dp))
                SectionLabel("Universe")
            }

            when {
                loading -> item {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(10.dp))
                        Text("Loading…", style = MaterialTheme.typography.labelMedium, color = TinyGray)
                    }
                }
                failed -> item {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text("Couldn't load the universe.", style = MaterialTheme.typography.labelMedium, color = TinyGray)
                        TextButton(onClick = { reloadKey++ }) { Text("Retry", color = MaterialTheme.colorScheme.primary) }
                    }
                }
                else -> {
                    val builders = data?.builders.orEmpty()
                    val trust = data?.trust.orEmpty()
                    if (builders.isEmpty()) {
                        item {
                            Text(
                                "No tinys yet",
                                style = MaterialTheme.typography.labelMedium,
                                color = TinyGray,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                        }
                    }
                    items(builders, key = { it.login }) { b ->
                        BuilderNode(
                            builder = b,
                            trust = trust,
                            currentTiny = currentTiny,
                            open = expanded == b.login,
                            onToggle = { expanded = if (expanded == b.login) null else b.login },
                            onPickTiny = onPickTiny,
                            onOpenProfile = onOpenProfile,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = TinyGray,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
    )
}

@Composable
private fun SidebarRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Native Material glyph, not an emoji (user request + iOS drawer parity:
        // Views.swift renders these same rows as SF Symbols). Tinted TinyGray so
        // the accent-colored labels stay the row's focal point.
        Icon(icon, contentDescription = null, tint = TinyGray, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** A builder disclosure row → its tinys; the active tiny gets an accent ✓. */
@Composable
private fun BuilderNode(
    builder: CommunityBuilder,
    trust: Map<String, Double>,
    currentTiny: String,
    open: Boolean,
    onToggle: () -> Unit,
    onPickTiny: (String) -> Unit,
    onOpenProfile: (String) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (builder.avatar.isNotBlank()) {
            AsyncImage(
                model = githubAvatar(builder.avatar, 22),
                contentDescription = null,
                modifier = Modifier.size(22.dp).clip(CircleShape),
            )
        } else {
            Box(Modifier.size(22.dp).clip(CircleShape).background(TinyGray.copy(alpha = 0.3f)), Alignment.Center) {
                Text(
                    builder.login.take(1).uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White,
                )
            }
        }
        Spacer(Modifier.width(10.dp))
        // The @handle is its own tap target → the builder's profile (tinys + tools),
        // accent-colored to read as a link. The rest of the row still toggles the
        // inline tiny disclosure, so both affordances live in one row (web makes the
        // handle a /@login link beside its expandable tiny chips).
        Text(
            "@${builder.login}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).clickable { onOpenProfile(builder.login) },
        )
        Text(
            "${builder.tinyCount}",
            style = MaterialTheme.typography.labelSmall,
            color = TinyGray,
        )
        Spacer(Modifier.width(6.dp))
        Text(if (open) "▾" else "▸", style = MaterialTheme.typography.labelSmall, color = TinyGray)
    }
    if (open) {
        for (t in builder.tinys) {
            val active = t == currentTiny
            val trusted = (trust[t] ?: 0.0) > 0.0
            Row(
                Modifier.fillMaxWidth().clickable { onPickTiny(t) }
                    .padding(start = 44.dp, end = 16.dp).padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (trusted) {
                    Icon(
                        Icons.Outlined.Bolt,
                        contentDescription = "trusted",
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                }
                Text(
                    t,
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                    color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (active) Text("✓", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

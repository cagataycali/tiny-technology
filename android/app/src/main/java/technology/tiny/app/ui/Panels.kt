package technology.tiny.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Podcasts
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.VolumeUp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.*
import androidx.compose.runtime.*
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import technology.tiny.app.fleet.WearablesBridge
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import technology.tiny.app.geo.Geo
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.net.ModelConfigStore
import technology.tiny.app.net.Standing
import technology.tiny.app.ui.theme.TinyGray

data class DeviceRow(
    val id: String,
    val name: String,
    val kind: String,
    val online: Boolean,
    val lastSeen: Long, // unix seconds (worker /api/devices), 0 when never heard from
    /// Parsed from the wire's JSON *string* — decides whether a camera is drawn.
    val capabilities: List<String> = emptyList(),
) {
    /**
     * An endpoint device is a robot at its own authenticated API (printer, rover),
     * not something that heartbeats to us. Only these get a live camera/telemetry
     * panel — every other row must cost nothing extra.
     */
    val isEndpoint: Boolean get() = kind == "endpoint"
}

/**
 * Relative "last heard from" for a fleet device — byte-for-byte the web devices
 * page's buckets (app/devices/page.tsx:42-50). [nowSec] is injected so the result
 * is deterministic in tests. 0/absent → "never" (a device that never checked in).
 */
internal fun relativeSeen(lastSeenSec: Long, nowSec: Long): String {
    if (lastSeenSec <= 0L) return "never"
    val d = maxOf(0L, nowSec - lastSeenSec)
    return when {
        d < 60 -> "just now"
        d < 3600 -> "${d / 60}m ago"
        d < 86400 -> "${d / 3600}h ago"
        else -> "${d / 86400}d ago"
    }
}

/**
 * The device row's under-name line: "<kind> · online" for a live device, else
 * "<kind> · seen <relative>". iOS appends "· seen <relative>" (Panels.swift:1496-1500)
 * and web swaps in "online"/relativeSeen (devices/page.tsx:403); this merges both so
 * offline devices finally show their recency (last_seen was parsed but never drawn).
 */
internal fun deviceSubtitle(kind: String, online: Boolean, lastSeenSec: Long, nowSec: Long): String {
    val k = kind.ifBlank { "device" }
    return if (online) "$k · online" else "$k · seen ${relativeSeen(lastSeenSec, nowSec)}"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesSheet(app: TinyApp, onDismiss: () -> Unit) {
    var devices by remember { mutableStateOf<List<DeviceRow>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    val relayLog by app.fleet.relayLog.collectAsState()
    // Device pending a revoke-confirm. Revoking kills that device's token instantly
    // (web app/devices:155 gates it behind a danger confirm). THIS phone is never
    // offered a revoke button — revoking self would kill the app's own auth.
    var pendingRevoke by remember { mutableStateOf<DeviceRow?>(null) }
    var revokeError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(reloadKey) {
        loadError = null
        devices = null
        // 🛰 Screenshot harness (debug builds only) — see FleetHarness for why the fleet
        // can't be seeded like the chat shots, and for the two things a fixed dataset
        // gets wrong here that GraphHarness doesn't have to worry about.
        //
        // ⚠️ Returns BEFORE the fetch, unlike what a "substitute after the error branch"
        // reading of GraphHarness would suggest — and that IS the cautious order here.
        // The fleet request is authenticated with the user's own session, so letting it
        // fly during a capture would heartbeat/enumerate the real fleet for a screenshot
        // that discards the answer. GraphHarness returns early for the same reason
        // ("Returns BEFORE the fetch so no request is made", MemoryGraph.kt:89).
        //
        // The property that actually matters — a harness must never mask a real load
        // failure — is preserved by the DEBUG gate, not by the ordering: there is no
        // release build in which this line can run at all.
        if (FleetHarness.enabled(technology.tiny.app.BuildConfig.DEBUG, app.fleetHarness)) {
            devices = FleetHarness.rows(app.auth.deviceId, System.currentTimeMillis() / 1000)
            return@LaunchedEffect
        }
        val res = runCatching { app.api.getJson("/api/devices") }.getOrNull()
        // null = transport failure; _status ≥ 400 = HTTP error (previously the HTTP
        // case silently parsed to an empty fleet — failed-vs-empty collapse).
        val status = res?.optInt("_status", 0) ?: 0
        if (res == null || status >= 400) {
            loadError = status.takeIf { it >= 400 }
                ?.let { technology.tiny.app.net.friendlyHttpError(it) } ?: "couldn't load devices"
            return@LaunchedEffect
        }
        val arr = res.optJSONArray("devices")
        devices = (0 until (arr?.length() ?: 0)).mapNotNull { i ->
            arr?.optJSONObject(i)?.let { d ->
                DeviceRow(
                    id = d.optString("id"),
                    name = d.optString("name"),
                    kind = d.optString("kind"),
                    // ⚠️ `online` is a THREE-state field: an endpoint device never
                    // heartbeats, so the worker sends null (unknown from here)
                    // rather than a false "offline". optBoolean(null) → false, the
                    // honest render for a dot we can't verify; the panel below is
                    // what actually proves the robot is alive.
                    online = d.optBoolean("online"),
                    lastSeen = d.optLong("last_seen"),
                    capabilities = parseCapabilities(d.optString("capabilities")),
                )
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        // One clock (unix seconds) for every row's "seen <relative>" line, taken at
        // composition — the sheet lives seconds and web/iOS recompute per render too.
        val nowSec = remember { System.currentTimeMillis() / 1000 }
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
            item {
                SheetTitle(Icons.Outlined.Devices, "fleet")
                Spacer(Modifier.height(12.dp))
            }
            loadError?.let {
                item {
                    Column {
                        Text(it, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
            if (devices == null && loadError == null) item { SheetLoading() }
            if (devices?.isEmpty() == true) item {
                SheetEmpty(Icons.Outlined.Devices, "no devices yet", "sign in on a laptop or phone and it joins your fleet")
            }
            revokeError?.let {
                item { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall) }
            }
            items(devices.orEmpty()) { d ->
                val isSelf = d.id == app.auth.deviceId
                Column(Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(d.online)
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                d.name + if (isSelf) "  (this phone)" else "",
                                style = MaterialTheme.typography.bodyMedium,
                                color = if (isSelf) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            )
                            Text(deviceSubtitle(d.kind, d.online, d.lastSeen, nowSec), style = MaterialTheme.typography.labelSmall, color = TinyGray)
                        }
                        // No revoke for this phone — killing our own token would sign the app
                        // out from under itself (web hides the button on the current device too).
                        if (!isSelf) {
                            TextButton(onClick = { revokeError = null; pendingRevoke = d }) {
                                Text("revoke", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    // 🤖 A robot's chamber camera + telemetry, always visible (web
                    // parity). Gated on the kind so a fleet of phones polls nothing.
                    if (d.isEndpoint) {
                        EndpointPanel(app, d.id, d.name, d.capabilities)
                    }
                }
            }
            if (relayLog.isNotEmpty()) {
                item {
                    Spacer(Modifier.height(16.dp))
                    Text("relay activity", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(8.dp))
                }
                items(relayLog.reversed()) { e ->
                    Column(Modifier.padding(vertical = 4.dp)) {
                        Text("→ ${e.prompt}", style = MaterialTheme.typography.labelSmall, color = TinyGray)
                        Text("← ${e.result.take(200)}", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }

    pendingRevoke?.let { d ->
        AlertDialog(
            onDismissRequest = { pendingRevoke = null },
            title = { Text("Revoke device?") },
            text = { Text("“${d.name}” — its token stops working immediately.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingRevoke = null
                    scope.launch {
                        val res = runCatching {
                            app.api.deleteJson("/api/devices", JSONObject().put("deviceId", d.id))
                        }.getOrNull()
                        val status = res?.optInt("_status", 0) ?: 0
                        if (res != null && status < 400 && res.optBoolean("ok", status in 200..399)) {
                            // Drop it locally so the row disappears without a full reload race.
                            devices = devices?.filterNot { it.id == d.id }
                        } else {
                            revokeError = status.takeIf { it >= 400 }
                                ?.let { technology.tiny.app.net.friendlyHttpError(it) } ?: "couldn't revoke device"
                        }
                    }
                }) { Text("revoke", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { pendingRevoke = null }) { Text("cancel", color = TinyGray) } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(app: TinyApp, onReplayTour: () -> Unit = {}, onDismiss: () -> Unit) {
    var tinyName by remember { mutableStateOf(app.config.tinyName) }
    var autoSpeak by remember { mutableStateOf(app.config.autoSpeak) }
    var quietHours by remember { mutableStateOf(app.config.quietHours) }
    var turnActivity by remember { mutableStateOf(app.config.turnActivity) }
    var alwaysOn by remember { mutableStateOf(app.config.alwaysOn) }
    var server by remember { mutableStateOf(app.config.serverOverride ?: "") }
    val online by app.fleet.online.collectAsState()
    val user by app.auth.user.collectAsState()
    val scope = rememberCoroutineScope()

    // skipPartiallyExpanded: settings is taller than half a screen, so the partial
    // detent both hides most controls and makes the first back press collapse
    // expanded→partial instead of dismissing — which left the sheet open under a
    // user who thought it was gone and typed into "default tiny" (audit #5).
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp).verticalScroll(rememberScrollState())) {
            SheetTitle(Icons.Outlined.Settings, "settings")
            Spacer(Modifier.height(16.dp))

            OutlinedTextField(
                value = tinyName,
                onValueChange = { tinyName = it },
                label = { Text("default tiny") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))

            SettingSwitch(Icons.Outlined.VolumeUp, "speak replies aloud", autoSpeak) {
                autoSpeak = it; app.config.autoSpeak = it
            }
            VoicePicker(app)
            SettingSwitch(Icons.Outlined.Bedtime, "quiet hours (22:00–08:00)", quietHours) {
                quietHours = it; app.config.quietHours = it
            }
            SettingSwitch(Icons.Outlined.Bolt, "live turn status", turnActivity) {
                turnActivity = it; app.config.turnActivity = it
                if (!it) technology.tiny.app.fleet.AgentLive.cancel(app)
            }
            // 📍 Location context (web composer 📍 toggle parity). Flipping on
            // runs the runtime ask; the config flag follows the GRANT, not the
            // tap — deny leaves the switch (and every send) unchanged.
            var shareLocation by remember { mutableStateOf(app.config.locationContext) }
            val locationAsk = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestMultiplePermissions()
            ) { grants ->
                val granted = grants.values.any { it }
                shareLocation = granted
                app.config.locationContext = granted
            }
            SettingSwitch(Icons.Outlined.LocationOn, "share location with your tiny", shareLocation) { on ->
                if (on && !Geo.hasPermission(app)) {
                    locationAsk.launch(arrayOf(
                        android.Manifest.permission.ACCESS_FINE_LOCATION,
                        android.Manifest.permission.ACCESS_COARSE_LOCATION,
                    ))
                } else {
                    shareLocation = on
                    app.config.locationContext = on
                }
            }
            SettingSwitch(Icons.Outlined.Podcasts, "keep me reachable (always-on node)", alwaysOn) {
                alwaysOn = it; app.config.alwaysOn = it
                technology.tiny.app.fleet.RelayService.sync(app)
            }
            Text(
                // Helper prose is bodySmall SANS — labelSmall is the mono metadata
                // voice, and full sentences set in it read like terminal output.
                "Runs a background service so your agent can reach this phone while it's locked. Shows a persistent notification.",
                style = MaterialTheme.typography.bodySmall,
                color = TinyGray,
            )
            Spacer(Modifier.height(16.dp))

            GlassesSection(app)
            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("server override (blank = tiny.technology)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(16.dp))

            ModelConfigSection(app)
            Spacer(Modifier.height(16.dp))

            VoiceKeySection(app)
            Spacer(Modifier.height(16.dp))

            AccountVoiceSection(app)
            Spacer(Modifier.height(16.dp))

            TextButton(
                onClick = { onReplayTour() },
                contentPadding = PaddingValues(0.dp),
            ) {
                Icon(Icons.Outlined.PlayCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("replay the tour", color = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.height(8.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "signed in as @${user?.login ?: "?"} · fleet ",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
                StatusDot(online)
                Spacer(Modifier.width(4.dp))
                Text(
                    if (online) "online" else "offline",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
            }
            Spacer(Modifier.height(16.dp))

            Row {
                Button(onClick = {
                    app.config.tinyName = tinyName.ifBlank { "tiny" }
                    app.config.serverOverride = server.trim().ifBlank { null }
                    onDismiss()
                }) { Text("save") }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = {
                    scope.launch {
                        app.config.alwaysOn = false
                        technology.tiny.app.fleet.RelayService.stop(app)
                        app.fleet.stop()
                        technology.tiny.app.fleet.DmPollWorker.cancel(app)
                        technology.tiny.app.fleet.DmNotifier.reset(app)
                        // Wipe the prior user's answer/memories/unread from the home-screen
                        // widgets — the loops that refresh them just stopped (iOS logout scrub).
                        technology.tiny.app.widget.WidgetBridge.scrubIdentity(app)
                        // The BYO-model config (api_key / voice_openai_key) is a paid
                        // secret in its OWN encrypted prefs file (tiny_model); logout()
                        // clears only tiny_auth, so without this the key survives sign-out
                        // and is prefilled/revealed to whoever signs in next on this
                        // device. Reset to the free default — same boundary as the
                        // switch-scrub in MainActivity.
                        app.modelConfig.reset()
                        // User-scoped tiny_config channels (offline send queue, composer
                        // draft, activity high-water mark) — same boundary as the switch.
                        app.config.scrubIdentity()
                        app.auth.logout()
                        onDismiss()
                    }
                }) { Text("sign out", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

/**
 * 🎙 TTS voice picker (iOS Settings.swift "Voice" section parity). The engine's
 * installed voices for the user's locale (+ English), a "System default" row,
 * and a Preview button that speaks a sample in the currently-selected voice —
 * so the user hears a choice before it sticks. Voice ids are opaque engine
 * strings persisted to cfg_voice_id; Speech.applyVoice honors them at speak time.
 *
 * Voices are read lazily on expand (TextToSpeech.voices needs the engine ready;
 * the app-scoped Speech instance is initialized by the time Settings opens). If
 * the engine reports none (rare — no offline voice pack), the row collapses to a
 * hint pointing at the system voice-data download, mirroring iOS's footer.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VoicePicker(app: TinyApp) {
    var expanded by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(app.config.voiceId) }
    // The engine's voice list is stable per session — load once.
    val voices = remember { app.speech.voices() }
    val currentLabel = selected
        ?.let { id -> voices.firstOrNull { it.name == id }?.let { app.speech.voiceLabel(it) } }
        ?: "System default"

    Spacer(Modifier.height(4.dp))
    if (voices.isEmpty()) {
        Text(
            "No offline voices installed. Add them in Android Settings → System → Languages → Text-to-speech output.",
            style = MaterialTheme.typography.bodySmall,
            color = TinyGray,
        )
        return
    }

    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = currentLabel,
            onValueChange = {},
            readOnly = true,
            label = { Text("spoken-reply voice (TTS)") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text("System default") },
                onClick = {
                    selected = null; app.config.voiceId = null; expanded = false
                },
            )
            voices.forEach { v ->
                DropdownMenuItem(
                    text = { Text(app.speech.voiceLabel(v), style = MaterialTheme.typography.bodyMedium) },
                    onClick = {
                        selected = v.name; app.config.voiceId = v.name; expanded = false
                    },
                )
            }
        }
    }
    TextButton(
        onClick = { app.speech.preview("Hi, I'm tiny — this is how I sound.", selected) },
        contentPadding = PaddingValues(vertical = 4.dp),
    ) {
        Icon(Icons.Outlined.PlayCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text("preview voice", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
    }
}

/** An accent section header with a leading native glyph (was a leading emoji). */
@Composable
private fun SectionLabel(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
    }
}

/** A filled/hollow status dot — the native replacement for the 🟢/⚫ online glyph. */
/**
 * 🕶️ Meta glasses (iOS Settings 🕶 section parity): status + link/unlink +
 * the two permission launchers the DAT flow needs — BLUETOOTH_CONNECT (the
 * one Android runtime permission the SDK requires before initialize()) and
 * the glasses-camera grant, which happens INSIDE the Meta AI app via
 * Wearables.RequestPermissionContract (an Activity contract — this section
 * owns the launcher; WearablesBridge only checks).
 */
@Composable
private fun GlassesSection(app: TinyApp) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    var btGranted by remember { mutableStateOf(WearablesBridge.hasBtPermission(app)) }
    var initialized by remember { mutableStateOf(WearablesBridge.ensureInitialized(app)) }
    var cameraNote by remember { mutableStateOf<String?>(null) }

    // Registration state only exists once the SDK is initialized — produceState
    // re-runs when the BT grant flips `initialized` true.
    val regState by produceState<RegistrationState?>(null, initialized) {
        if (initialized) Wearables.registrationState.collect { value = it }
    }

    val btAsk = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        btGranted = granted
        if (granted) initialized = WearablesBridge.ensureInitialized(app)
    }
    val cameraAsk = rememberLauncherForActivityResult(Wearables.RequestPermissionContract()) { result ->
        val status = result.getOrDefault(PermissionStatus.Denied)
        cameraNote = if (status == PermissionStatus.Granted) "camera access granted — your tiny can see through the glasses"
        else "camera access denied in the Meta AI app"
    }

    Text("🕶 meta glasses", style = MaterialTheme.typography.titleSmall)
    Spacer(Modifier.height(8.dp))
    when {
        !btGranted -> {
            Button(onClick = { btAsk.launch(android.Manifest.permission.BLUETOOTH_CONNECT) }, modifier = Modifier.fillMaxWidth()) {
                Text("allow bluetooth to find your glasses")
            }
        }
        regState == RegistrationState.REGISTERED -> {
            Text("linked", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { cameraAsk.launch(Permission.CAMERA) }) { Text("grant camera") }
                TextButton(onClick = { activity?.let { WearablesBridge.startUnregistration(it) } }) { Text("unlink") }
            }
        }
        regState == RegistrationState.REGISTERING -> {
            Text("linking via Meta AI…", style = MaterialTheme.typography.bodySmall, color = TinyGray)
        }
        else -> {
            Button(
                onClick = { activity?.let { WearablesBridge.startRegistration(it) } },
                enabled = activity != null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("link glasses via Meta AI") }
        }
    }
    cameraNote?.let {
        Spacer(Modifier.height(6.dp))
        Text(it, style = MaterialTheme.typography.bodySmall, color = TinyGray)
    }
    Text(
        "Link your Meta AI glasses to give your tiny eyes — it can capture what you're looking at when you ask. Unlink here or in the Meta AI app any time.",
        style = MaterialTheme.typography.bodySmall,
        color = TinyGray,
    )
}

private tailrec fun android.content.Context.findActivity(): android.app.Activity? = when (this) {
    is android.app.Activity -> this
    is android.content.ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
private fun StatusDot(online: Boolean) {
    Icon(
        if (online) Icons.Filled.Circle else Icons.Outlined.RadioButtonUnchecked,
        contentDescription = if (online) "online" else "offline",
        tint = if (online) MaterialTheme.colorScheme.primary else TinyGray,
        modifier = Modifier.size(10.dp),
    )
}

@Composable
private fun SettingSwitch(icon: ImageVector, label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = TinyGray, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = MaterialTheme.colorScheme.primary, checkedThumbColor = Color.Black),
        )
    }
}

/**
 * 🤖 BYO-model config — native port of web components/chat/ModelSettings.tsx (the
 * BYOK half; WebLLM/WebGPU on-device inference is browser-only, not ported). Pick a
 * provider + paste an API key to bypass the free tier's rate limits and use any
 * model; the config rides /api/chat as x-tiny-model-* headers. Persists to the
 * encrypted ModelConfigStore on Save, with web's guards (byok needs a key; custom
 * needs a base URL or the key would leak to OpenAI's default endpoint).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelConfigSection(app: TinyApp) {
    val store = app.modelConfig
    val scope = rememberCoroutineScope()
    var provider by remember { mutableStateOf(store.provider) }
    var apiKey by remember { mutableStateOf(store.apiKey) }
    var modelId by remember { mutableStateOf(store.modelId) }
    var baseUrl by remember { mutableStateOf(store.baseUrl) }
    var maxTokens by remember { mutableStateOf(store.maxTokens) }
    var region by remember { mutableStateOf(store.region) }
    var additionalFields by remember { mutableStateOf(store.additionalFields) }
    var showKey by remember { mutableStateOf(false) }
    var providerMenu by remember { mutableStateOf(false) }
    var regionMenu by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    // 🏅 This account's own daily allowance, off /api/me (c40). null until it
    // lands, and null forever when signed out or against a pre-c38 server — the
    // footer then quotes no number, exactly as it did before this existed.
    var standing by remember { mutableStateOf<Standing?>(null) }

    // Fresh-device hydration: a device still on the free default inherits the
    // account's synced BYOK selection (key stays server-side). Never clobbers a
    // local BYOK config. Reflect the pulled fields into the editing state.
    LaunchedEffect(Unit) {
        if (store.hydrateFromRemote(app.api)) {
            provider = store.provider; apiKey = store.apiKey; modelId = store.modelId
            baseUrl = store.baseUrl; maxTokens = store.maxTokens; region = store.region
            additionalFields = store.additionalFields
        }
        // Unlike iOS (Session.loadMe runs every launch) Android has no
        // launch-time /api/me, so the allowance has to be fetched here. Skipped
        // entirely without a token: /api/me 401s and the 401 body carries no
        // standing, so an anonymous round-trip could only ever produce the null
        // we already hold. runCatching because a footer sentence must never be
        // able to take down the settings panel.
        if (app.auth.token != null) {
            val me = runCatching { app.api.me() }.getOrNull()
            standing = Standing.parse(me?.optJSONObject("standing"))
        }
    }

    val preset = ModelConfigStore.PROVIDER_PRESETS[provider] ?: ModelConfigStore.PROVIDER_PRESETS["custom"]!!
    val byok = provider != "default"

    SectionLabel(Icons.Outlined.SmartToy, "model & API key")
    Spacer(Modifier.height(4.dp))
    Text(
        // Voice-call discoverability: the live call (📞) reads the same OpenAI
        // key set here, so surface that up front — mirrors the iOS footer.
        if (byok)
            "Bring your own provider + key — you pay them directly. Live voice calls (📞) also use this key; set an OpenAI provider + key here to enable calls."
        else
            // 🏅 …and on the free branch, the caller's OWN window rather than a
            // bare "(rate-limited)": the number is enforced in the limiter and
            // was, until c40, quoted nowhere this app can show.
            Standing.freeTierFooter(standing) +
                " Live voice calls (📞) need an OpenAI key — pick OpenAI here and paste your key to enable calls.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    Spacer(Modifier.height(8.dp))

    // Provider dropdown
    ExposedDropdownMenuBox(expanded = providerMenu, onExpandedChange = { providerMenu = it }) {
        OutlinedTextField(
            value = ModelConfigStore.PROVIDER_PRESETS[provider]?.label ?: provider,
            onValueChange = {},
            readOnly = true,
            label = { Text("provider") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = providerMenu) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = providerMenu, onDismissRequest = { providerMenu = false }) {
            ModelConfigStore.PROVIDER_PRESETS.forEach { (key, p) ->
                DropdownMenuItem(
                    text = { Text(p.label) },
                    onClick = {
                        provider = key
                        // Adopt the preset base URL on switch (web onChange), so the
                        // custom-only free-form field starts from the right default.
                        baseUrl = p.baseUrl
                        providerMenu = false
                    },
                )
            }
        }
    }

    if (byok) {
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = apiKey,
            onValueChange = { apiKey = it },
            label = { Text("API key") },
            placeholder = { Text(preset.keyPlaceholder, style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                if (apiKey.isNotEmpty()) {
                    TextButton(onClick = { showKey = !showKey }) {
                        Text(if (showKey) "hide" else "show", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "Stored encrypted on this device only. Sent per-request, never persisted server-side.",
            style = MaterialTheme.typography.bodySmall, color = TinyGray,
        )

        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = modelId,
            onValueChange = { modelId = it },
            label = { Text("model") },
            placeholder = { Text(preset.modelPlaceholder, style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        if (provider == "bedrock") {
            Spacer(Modifier.height(10.dp))
            ExposedDropdownMenuBox(expanded = regionMenu, onExpandedChange = { regionMenu = it }) {
                OutlinedTextField(
                    value = region,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("region") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = regionMenu) },
                    modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
                )
                ExposedDropdownMenu(expanded = regionMenu, onDismissRequest = { regionMenu = false }) {
                    ModelConfigStore.BEDROCK_REGIONS.forEach { r ->
                        DropdownMenuItem(text = { Text(r) }, onClick = { region = r; regionMenu = false })
                    }
                }
            }
        }

        // Base URL: shown for custom, or whenever a preset carries one (web condition).
        if (provider == "custom" || baseUrl.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                label = { Text("base URL") },
                placeholder = { Text("https://api.example.com/v1", style = MaterialTheme.typography.bodySmall) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = maxTokens,
            onValueChange = { maxTokens = it },
            label = { Text("max tokens (optional)") },
            placeholder = { Text("8192", style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = additionalFields,
            onValueChange = { additionalFields = it },
            label = { Text("additional request fields (JSON, optional)") },
            placeholder = { Text("{\"anthropic_beta\": [\"context-1m-2025-08-07\"]}", style = MaterialTheme.typography.bodySmall) },
            modifier = Modifier.fillMaxWidth(),
        )
    } else {
        Spacer(Modifier.height(6.dp))
        Text(
            "Using tiny's free model (rate-limited). Bring your own API key to bypass limits and pick any model.",
            style = MaterialTheme.typography.bodySmall, color = TinyGray,
        )
    }

    status?.let {
        Spacer(Modifier.height(6.dp))
        Text(it, style = MaterialTheme.typography.labelSmall, color = if (it.startsWith("⚠")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
    }

    Spacer(Modifier.height(10.dp))
    Row {
        Button(onClick = {
            // Web save() guards, ported: a byok provider needs a key; custom needs a
            // base URL (else the key leaks to OpenAI's default endpoint); additional
            // fields must parse to a JSON object.
            if (byok && apiKey.isBlank()) { status = "⚠ API key required for this provider"; return@Button }
            if (provider == "custom" && baseUrl.isBlank()) {
                status = "⚠ base URL required for a custom provider"; return@Button
            }
            if (additionalFields.isNotBlank() &&
                runCatching { JSONObject(additionalFields) }.getOrNull() == null
            ) {
                status = "⚠ additional fields must be a JSON object"; return@Button
            }
            store.provider = provider
            store.apiKey = apiKey
            store.modelId = modelId
            store.baseUrl = baseUrl
            store.maxTokens = maxTokens
            store.region = region
            store.additionalFields = additionalFields
            // Carry the selection to the account so other devices inherit it (key
            // encrypted server-side, never returned; empty key preserves the stored one).
            scope.launch { store.saveRemote(app.api) }
            status = if (byok) "✅ using your API key" else "using tiny's free model"
        }) { Text("save model") }
        Spacer(Modifier.weight(1f))
        TextButton(onClick = {
            store.reset()
            provider = "default"; apiKey = ""; modelId = ""; baseUrl = ""
            maxTokens = ""; region = "us-west-2"; additionalFields = ""
            // Reverting to the free tier clears the synced row on the account too.
            scope.launch { store.saveRemote(app.api) }
            status = "reset to tiny's free model"
        }) { Text("reset", color = TinyGray) }
    }
}

/**
 * 📞 Voice-call OpenAI key — an ALWAYS-VISIBLE key field, deliberately separate from
 * the chat "model & API key" section above. Live voice calls are OpenAI-ONLY (the
 * realtime speech-to-speech API), so a user running chat on Bedrock/Anthropic/etc.
 * previously had NO way to enable voice — the key field only appeared after switching
 * the whole chat provider to OpenAI. This dedicated field lets voice work without
 * touching the chat provider. Stored device-local in the encrypted ModelConfigStore.
 *
 * User-feedback fix (overrides the iOS/web parity rule): "I don't see the openai
 * voice keys in the settings in android so i can't use the voice."
 */
@Composable
private fun VoiceKeySection(app: TinyApp) {
    val store = app.modelConfig
    var key by remember { mutableStateOf(store.voiceOpenAiKey) }
    var showKey by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    // Chat already on OpenAI → voice reuses that key, so this field is optional.
    val chatIsOpenAi = store.provider.equals("openai", ignoreCase = true) && store.apiKey.isNotEmpty()

    SectionLabel(Icons.Outlined.Call, "voice-call OpenAI key")
    Spacer(Modifier.height(4.dp))
    Text(
        if (chatIsOpenAi)
            "Live voice calls use your OpenAI chat key above. Set a different key here only if you want voice on a separate OpenAI account."
        else
            "Live voice calls (📞) need an OpenAI key — paste one here to enable calls. Voice is OpenAI-only and works no matter which provider your chat uses.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    Spacer(Modifier.height(8.dp))

    OutlinedTextField(
        value = key,
        onValueChange = { key = it },
        label = { Text("OpenAI API key (for voice)") },
        placeholder = { Text("sk-...", style = MaterialTheme.typography.bodySmall) },
        singleLine = true,
        visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(),
        trailingIcon = {
            if (key.isNotEmpty()) {
                TextButton(onClick = { showKey = !showKey }) {
                    Text(if (showKey) "hide" else "show", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
    Text(
        "Stored encrypted on this device only. Sent per-call to start the session, never persisted server-side.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )

    status?.let {
        Spacer(Modifier.height(6.dp))
        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
    }

    Spacer(Modifier.height(10.dp))
    Row {
        Button(onClick = {
            store.voiceOpenAiKey = key.trim()
            status = if (key.isBlank()) "voice key cleared" else "✅ voice key saved"
        }) { Text("save voice key") }
        if (key.isNotEmpty()) {
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { key = ""; store.voiceOpenAiKey = ""; status = "voice key cleared" }) {
                Text("clear", color = TinyGray)
            }
        }
    }
}

/**
 * 🎙 Account-default live-call voice (iOS Settings "Live-call voice" parity).
 *
 * The OpenAI Realtime voice used on 📞 calls to any tiny that hasn't set its own.
 * Synced across the user's devices via /api/account-voice; the fallback in the
 * per-call resolution (per-tiny voice → this account voice → marin). Separate
 * from the on-device TTS "spoken-reply voice" and the per-tiny call voice a
 * tiny's owner can set. "" = unset (each tiny's own, else marin).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountVoiceSection(app: TinyApp) {
    val store = app.modelConfig
    val scope = rememberCoroutineScope()
    var voice by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }
    // Reflect the account-synced value on open.
    LaunchedEffect(Unit) { voice = store.loadAccountVoice(app.api) }
    val label = if (voice.isEmpty()) "Default (each tiny's own, else marin)"
                else voice.replaceFirstChar { it.uppercase() }

    SectionLabel(Icons.Outlined.RecordVoiceOver, "live-call voice")
    Spacer(Modifier.height(4.dp))
    Text(
        "Your default voice for live calls (📞), synced across your devices. A tiny whose owner set its own voice still wins. The spoken-reply voice (TTS) above is separate.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    Spacer(Modifier.height(8.dp))

    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = label,
            onValueChange = {},
            readOnly = true,
            label = { Text("live-call voice") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text("Default (each tiny's own, else marin)") },
                onClick = {
                    voice = ""; expanded = false
                    scope.launch { store.saveAccountVoice(app.api, "") }
                },
            )
            ACCOUNT_REALTIME_VOICES.forEach { v ->
                DropdownMenuItem(
                    text = { Text(v.replaceFirstChar { it.uppercase() }) },
                    onClick = {
                        voice = v; expanded = false
                        scope.launch { store.saveAccountVoice(app.api, v) }
                    },
                )
            }
        }
    }
}

/** OpenAI Realtime voices for the account picker (mirrors the worker allowlist). */
private val ACCOUNT_REALTIME_VOICES = listOf(
    "alloy", "ash", "ballad", "coral", "echo",
    "sage", "shimmer", "verse", "marin", "cedar",
)

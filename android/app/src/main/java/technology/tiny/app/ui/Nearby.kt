package technology.tiny.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NetworkWifi1Bar
import androidx.compose.material.icons.outlined.NetworkWifi3Bar
import androidx.compose.material.icons.outlined.Sensors
import androidx.compose.material.icons.outlined.SignalWifi4Bar
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.vector.ImageVector
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.PaddingValues
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.fleet.Bluetooth
import technology.tiny.app.fleet.TinyProvisioner
import technology.tiny.app.ui.theme.TinyGray

/**
 * Nearby devices — the phone's live BLE scan (iOS NearbyView parity). The same
 * [Bluetooth] scanner the relay uses for "what's around me?"; here the user
 * sees it directly with signal strength. First scan requests the runtime
 * BLUETOOTH_SCAN (API 31+) / FINE_LOCATION (≤30) permission.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NearbySheet(app: TinyApp, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val devices by Bluetooth.devices.collectAsState()
    val scanning by Bluetooth.scanning.collectAsState()
    val state by Bluetooth.state.collectAsState()
    var setupTarget by remember { mutableStateOf<Bluetooth.BleDevice?>(null) }

    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) Bluetooth.startScan(context) }

    fun scan() {
        if (Bluetooth.hasPermission(context)) Bluetooth.startScan(context)
        else permLauncher.launch(Bluetooth.requiredPermission)
    }

    ModalBottomSheet(onDismissRequest = { Bluetooth.stopScan(); onDismiss() }) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    SheetTitle(Icons.Outlined.Sensors, "nearby")
                    Spacer(Modifier.weight(1f))
                    if (scanning) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
                    } else {
                        Button(onClick = { scan() }) { Text("scan") }
                    }
                }
                Text(
                    "Live Bluetooth scan from this phone. Your agent can ask what's around you.",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
                Spacer(Modifier.height(12.dp))
            }

            if (!scanning && devices.isEmpty()) {
                item {
                    val msg = when (state) {
                        "unauthorized" -> "Bluetooth scan permission is needed."
                        "poweredOff" -> "Bluetooth is turned off."
                        "unsupported" -> "This phone has no Bluetooth adapter."
                        "idle" -> "Tap scan to look for nearby devices."
                        else -> "No BLE devices discovered nearby."
                    }
                    Text(msg, color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                }
            }

            items(devices, key = { it.address }) { d ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(signalIcon(d.rssi), contentDescription = null, tint = TinyGray, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (d.tiny != null) "${d.name} 💎" else d.name,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            when {
                                d.tiny == null -> d.address
                                // Name the board (iOS niclaKindLabel parity) — a Vision
                                // and a Voice need different setup, so the row says
                                // which one is advertising before the user commits.
                                d.tiny.provisioned -> "${d.tiny.kindLabel} · configured"
                                else -> "${d.tiny.kindLabel} · ready to set up"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = TinyGray,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    if (d.tiny != null) {
                        TextButton(onClick = { setupTarget = d }) {
                            Text(if (d.tiny.provisioned) "reconfigure" else "set up")
                        }
                    } else {
                        Text("${d.rssi} dBm", style = MaterialTheme.typography.labelSmall, color = TinyGray)
                    }
                }
            }
        }
    }

    setupTarget?.let { target ->
        TinySetupDialog(app, target) { setupTarget = null }
    }
}

/**
 * Set up a tiny hardware beacon (iOS TinySetupView parity): LINK to the board
 * first, then enroll a device record with the user's session (POST /api/devices
 * mints the tind_ token once), then write WiFi + identity over BLE via
 * [TinyProvisioner].
 *
 * That order is load-bearing: enrolling first minted a registry row on every
 * failed attempt, and the token comes back exactly once, so those orphans could
 * never be provisioned — only revoked. The account bearer is deliberately NOT in
 * the config; the device token authenticates the board's own uploads and is
 * revocable on its own.
 */
@Composable
private fun TinySetupDialog(app: TinyApp, beacon: Bluetooth.BleDevice, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val phase by TinyProvisioner.phase.collectAsState()
    val detail by TinyProvisioner.detail.collectAsState()
    var ssid by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // A Nicla Voice is an nRF52832: BLE only, no WiFi radio at all. Showing it
    // a WiFi form would collect credentials it can never use and imply a
    // connection it can never make — a phone is its gateway instead.
    val isVoice = beacon.tiny?.kind == Bluetooth.TinyBeaconInfo.Kind.VOICE

    val connectLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* user retries the button after granting */ }

    fun begin() {
        if (Build.VERSION.SDK_INT >= 31 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            connectLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
            return
        }
        busy = true
        error = null
        scope.launch {
            // Link before the registry is touched — a board that never answers
            // must leave no device row behind (phase carries the reason why).
            if (!TinyProvisioner.link(context, beacon.address)) { busy = false; return@launch }
            // Capabilities claim ONLY what the board has. An agent that sees
            // `camera` on a Voice will call a photo tool that can never
            // succeed, and a confident failure is worse than an absent
            // capability (iOS TinySetup.swift:228 parity).
            val caps = if (isVoice) {
                technology.tiny.app.fleet.NiclaVoiceGateway.CAPABILITIES
            } else {
                listOf("camera", "mic", "tof", "imu", "ble", "wifi")
            }
            val enrolled = runCatching {
                app.api.postJson(
                    "/api/devices",
                    JSONObject()
                        .put("name", beacon.name)
                        .put("platform", beacon.tiny?.platform ?: "nicla-vision")
                        .put("kind", "daemon")
                        .put("capabilities", org.json.JSONArray(caps)),
                )
            }.getOrNull()
            val deviceId = enrolled?.optString("device_id").orEmpty()
            val deviceToken = enrolled?.optString("device_token").orEmpty()
            if (deviceId.isEmpty() || deviceToken.isEmpty()) {
                error = "Could not enroll the device — are you logged in?"
                TinyProvisioner.reset()
                busy = false
                return@launch
            }
            // Identity only for the Voice: it has no radio that could use
            // ssid/key, and the firmware ignores those keys. Same chunked-JSON
            // contract either way, which is why one provisioner serves both.
            val config = JSONObject()
                .put("device_id", deviceId)
                .put("token", deviceToken)
                .put("name", beacon.name)
            if (!isVoice) config.put("ssid", ssid).put("key", password)
            TinyProvisioner.send(
                config,
                if (isVoice) TinyProvisioner.CONFIG_LIMIT_VOICE else TinyProvisioner.CONFIG_LIMIT_VISION,
            )
            // Remember which unit is a Voice so the gateway knows to keep a
            // BLE link to it after setup — the device cannot heartbeat for
            // itself (iOS registers NiclaVoiceGateway here too).
            if (isVoice) {
                technology.tiny.app.fleet.NiclaVoiceGateway.register(
                    context, deviceId, deviceToken, beacon.address, beacon.name,
                )
            }
            busy = false
        }
    }

    AlertDialog(
        onDismissRequest = { TinyProvisioner.reset(); onDismiss() },
        title = { Text("set up ${beacon.name}") },
        text = {
            Column {
                if (isVoice) {
                    Text(
                        "Nicla Voice listens on its own neural chip and has no WiFi. It stays paired to this phone over Bluetooth, and your phone relays what it hears to your tiny.",
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray,
                    )
                } else {
                    Text(
                        "Sent over Bluetooth — the device joins your WiFi and comes online as a device of your tiny.",
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(ssid, { ssid = it }, label = { Text("WiFi network") }, singleLine = true)
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        password, { password = it },
                        label = { Text("WiFi password") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                    )
                }
                Spacer(Modifier.height(10.dp))
                val status = when {
                    error != null -> error!!
                    phase == "connecting" -> "Connecting…"
                    phase == "handshaking" -> "Handshaking…"
                    phase == "linked" -> "Linked — enrolling…"
                    phase == "writing" || phase == "waiting" -> "Sending configuration…"
                    phase == "done" ->
                        if (isVoice) "Done — the necklace is paired; this phone relays it. 🎉"
                        else "Done — device is rebooting onto your WiFi. 🎉"
                    phase == "incomplete" -> "Saved, but the configuration is incomplete."
                    phase.startsWith("failed:") -> phase.removePrefix("failed:")
                    else -> ""
                }
                if (status.isNotEmpty()) {
                    Text(status, style = MaterialTheme.typography.labelSmall,
                        color = if (error != null || phase.startsWith("failed")) MaterialTheme.colorScheme.error else TinyGray)
                }
                // "Still missing: ssid, key." — the board's own verdict about
                // what it's short of, which "incomplete" alone doesn't say.
                detail?.let {
                    Spacer(Modifier.height(4.dp))
                    Text(it, style = MaterialTheme.typography.labelSmall, color = TinyGray)
                }
            }
        },
        confirmButton = {
            if (phase == "done") {
                Button(onClick = { TinyProvisioner.reset(); onDismiss() }) { Text("close") }
            } else {
                Button(onClick = { begin() }, enabled = (isVoice || ssid.isNotBlank()) && !busy && phase !in listOf("connecting", "handshaking", "linked", "writing", "waiting")) {
                    if (busy) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    else Text("set up")
                }
            }
        },
        dismissButton = {
            TextButton(onClick = { TinyProvisioner.reset(); onDismiss() }) { Text("cancel") }
        },
    )
}

/** RSSI → a native signal-strength icon (stronger = closer; dBm is negative). */
private fun signalIcon(rssi: Int): ImageVector = when {
    rssi >= -60 -> Icons.Outlined.SignalWifi4Bar
    rssi >= -80 -> Icons.Outlined.NetworkWifi3Bar
    else -> Icons.Outlined.NetworkWifi1Bar
}

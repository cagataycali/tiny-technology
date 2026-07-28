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
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.PaddingValues
import technology.tiny.app.TinyApp
import technology.tiny.app.fleet.Bluetooth
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
                        Text(d.name, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
                        Text(
                            d.address,
                            style = MaterialTheme.typography.labelSmall,
                            color = TinyGray,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    Text("${d.rssi} dBm", style = MaterialTheme.typography.labelSmall, color = TinyGray)
                }
            }
        }
    }
}

/** RSSI → a native signal-strength icon (stronger = closer; dBm is negative). */
private fun signalIcon(rssi: Int): ImageVector = when {
    rssi >= -60 -> Icons.Outlined.SignalWifi4Bar
    rssi >= -80 -> Icons.Outlined.NetworkWifi3Bar
    else -> Icons.Outlined.NetworkWifi1Bar
}

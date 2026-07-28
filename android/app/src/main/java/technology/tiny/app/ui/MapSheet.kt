package technology.tiny.app.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.MyLocation
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.maps.android.compose.Circle
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapProperties
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.rememberCameraPositionState
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import technology.tiny.app.TinyApp
import technology.tiny.app.geo.Geo
import technology.tiny.app.tools.AgentMap

/**
 * 🗺️ Full-screen live map (agi-diy port; web /map parity). A Dialog, not a
 * ModalBottomSheet — map pan/zoom gestures and sheet drag-to-dismiss fight
 * over the same touches.
 *
 * Same grammar as the web: locate-me runs the runtime ask on TAP (never on
 * open), the accent circle is you, taps drop pins, the HUD shows the exact
 * `### Location` block the tiny reads, and opted-in users arrive as pins
 * from tiny.technology/api/location (empty until the presence deploy gate
 * clears — the poll just 404/502s silently).
 */

// agi-diy dark style lives in MapStyle.kt (TINY_MAP_DARK_STYLE) — shared
// with the ambient MapBackdrop so the two surfaces can't drift in tone.

private data class RemotePin(val userId: String, val label: String, val pos: LatLng)

@Composable
fun MapSheet(app: TinyApp, onDismiss: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val youPulse = rememberYouPulse()

    var fix by remember { mutableStateOf<Geo.Fix?>(null) }
    var tracking by remember { mutableStateOf(false) }
    var beSeen by remember { mutableStateOf(false) }
    val agentPins by AgentMap.pins.collectAsState()
    val pinHaptics = androidx.compose.ui.platform.LocalHapticFeedback.current

    // Check in with the agent bridge (MapBackdrop parity): while the sheet
    // is up, map tool calls are visible — no "tap 📍" hint needed.
    DisposableEffect(Unit) {
        AgentMap.mapShown()
        onDispose { AgentMap.mapHidden() }
    }
    val droppedPins = remember { mutableStateListOf<LatLng>() }
    val remotePins = remember { mutableStateListOf<RemotePin>() }
    val scope = rememberCoroutineScope()
    // beat throttle (web MapView parity): ~60s cadence OR ~50m of movement
    var lastBeat by remember { mutableStateOf<Triple<Long, Double, Double>?>(null) }

    val cameraState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(LatLng(37.7749, -122.4194), 12f)
    }

    val askContext = androidx.compose.ui.platform.LocalContext.current
    val locationAsk = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        tracking = grants.values.any { it }
        // Denied ≠ nothing happened — especially "don't ask again", where the
        // tap otherwise does nothing at all (iOS HUD denied-branch parity).
        if (!tracking) {
            android.widget.Toast.makeText(
                askContext,
                "location is off for tiny — allow it in system settings",
                android.widget.Toast.LENGTH_LONG,
            ).show()
        }
    }

    // Agent camera gestures (fly_to_location / fly_to_marker / tour_markers)
    // steer the open sheet too; drop(1) skips the stale latest on open.
    LaunchedEffect(Unit) {
        AgentMap.camera.drop(1).collect { cam ->
            if (cam != null) {
                val to = LatLng(cam.lat, cam.lng)
                cameraState.animate(
                    if (cam.zoom != null) CameraUpdateFactory.newLatLngZoom(to, cam.zoom)
                    else CameraUpdateFactory.newLatLng(to),
                )
            }
        }
    }

    // Follow loop: fused snapshots while tracking (Geo caches 30s — a pocket
    // cadence, not a nav app's). First fix flies the camera; later ones only
    // move the accent circle so panning isn't fought by the GPS (web parity).
    LaunchedEffect(tracking) {
        var first = true
        while (tracking) {
            Geo.current(app)?.let { f ->
                fix = f
                if (first) {
                    cameraState.animate(CameraUpdateFactory.newLatLngZoom(LatLng(f.lat, f.lng), 15f))
                    first = false
                }
            }
            delay(5_000)
        }
        if (!tracking) fix = null
    }

    // 🌍 Presence heartbeat — beating IS the opt-in (worker contract). Runs
    // only while "be seen" is on; throttled to a cadence or a real move,
    // never the follow loop's tick rate. POST fails silently until the
    // deploy gate clears — the toggle is honest either way because the pin
    // only exists server-side once the beat lands.
    LaunchedEffect(beSeen) {
        while (beSeen) {
            fix?.let { f ->
                val last = lastBeat
                val moved = last == null ||
                    kotlin.math.abs(f.lat - last.second) > 0.0005 ||
                    kotlin.math.abs(f.lng - last.third) > 0.0005
                val due = last == null || System.currentTimeMillis() - last.first > 60_000
                if (moved || due) {
                    lastBeat = Triple(System.currentTimeMillis(), f.lat, f.lng)
                    runCatching {
                        app.api.postJson("/api/location", org.json.JSONObject().apply {
                            put("lat", Math.round(f.lat * 1e4) / 1e4)
                            put("lng", Math.round(f.lng * 1e4) / 1e4)
                            Geo.kmh(f.speedMs)?.takeIf { it > 0 }?.let { put("speedKmh", it) }
                            Geo.cardinal(f.headingDeg)?.let { put("heading", it) }
                            f.accuracyM?.let { put("accuracyM", it) }
                        })
                    }
                }
            }
            delay(15_000)
        }
    }

    // Presence pins — opted-in tiny users, polled each minute (web /map
    // parity). Silently empty until the worker's deploy gate clears.
    LaunchedEffect(Unit) {
        while (true) {
            runCatching {
                val res = app.api.getJson("/api/location")
                val me = res.optString("me")
                val pins = res.optJSONArray("pins")
                if (pins != null) {
                    val fresh = (0 until pins.length()).mapNotNull { i ->
                        val p = pins.optJSONObject(i) ?: return@mapNotNull null
                        val id = p.optString("userId")
                        if (id.isBlank() || id == me) return@mapNotNull null
                        RemotePin(
                            userId = id,
                            label = p.optString("login").ifBlank { p.optString("name").ifBlank { "tiny user" } },
                            pos = LatLng(p.optDouble("lat"), p.optDouble("lng")),
                        )
                    }
                    remotePins.clear()
                    remotePins.addAll(fresh)
                }
            }
            delay(60_000)
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize()) {
            GoogleMap(
                modifier = Modifier.fillMaxSize(),
                cameraPositionState = cameraState,
                properties = MapProperties(mapStyleOptions = MapStyleOptions(TINY_MAP_DARK_STYLE)),
                uiSettings = MapUiSettings(
                    zoomControlsEnabled = false,
                    myLocationButtonEnabled = false,
                    mapToolbarEnabled = false,
                ),
                onMapClick = {
                    droppedPins.add(it)
                    // the pin lands under a fingertip — let the fingertip know
                    // (iOS Haptic "tap" parity; overflow-menu idiom MainActivity:1124)
                    pinHaptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                },
            ) {
                // You: accent pulse-dot (agi-diy user marker, theme-tinted)
                fix?.let { f ->
                    val here = LatLng(f.lat, f.lng)
                    // the agi-diy .pulse-ring (MapBackdrop twin)
                    Circle(
                        center = here,
                        radius = 60.0 + 130.0 * youPulse,
                        fillColor = Color.Transparent,
                        strokeColor = accent.copy(alpha = 0.45f * (1f - youPulse)),
                        strokeWidth = 2f,
                    )
                    Circle(
                        center = here,
                        radius = 60.0,
                        fillColor = accent.copy(alpha = 0.25f),
                        strokeColor = accent.copy(alpha = 0.6f),
                        strokeWidth = 2f,
                    )
                    Circle(
                        center = here,
                        radius = 14.0,
                        fillColor = accent,
                        strokeColor = Color.White,
                        strokeWidth = 3f,
                    )
                }
                droppedPins.forEachIndexed { i, pos ->
                    Marker(state = MarkerState(position = pos), title = "pin ${i + 1}")
                }
                // Agent pins (add_map_marker — web bridge parity); untitled
                // pins still get a tap/TalkBack name
                agentPins.values.forEach { pin ->
                    Marker(
                        state = MarkerState(position = LatLng(pin.lat, pin.lng)),
                        title = pin.label ?: "your tiny's pin",
                        icon = AgentMap.markerHue(pin.color)?.let { BitmapDescriptorFactory.defaultMarker(it) },
                    )
                }
                remotePins.forEach { pin ->
                    Marker(state = MarkerState(position = pin.pos), title = pin.label, snippet = "on tiny")
                }
            }

            // top-right rail: close + locate (web /map control grammar)
            Column(
                Modifier.align(Alignment.TopEnd).padding(top = 48.dp, end = 12.dp),
                horizontalAlignment = Alignment.End,
            ) {
                FilledTonalIconButton(
                    onClick = onDismiss,
                    colors = IconButtonDefaults.filledTonalIconButtonColors(
                        containerColor = Color.Black.copy(alpha = 0.8f), contentColor = Color.White,
                    ),
                ) { Icon(Icons.Outlined.Close, contentDescription = "close map") }
                Spacer(Modifier.height(8.dp))
                FilledTonalButton(
                    onClick = {
                        if (tracking) tracking = false
                        else if (Geo.hasPermission(app)) tracking = true
                        else locationAsk.launch(arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION,
                        ))
                    },
                    colors = androidx.compose.material3.ButtonDefaults.filledTonalButtonColors(
                        containerColor = Color.Black.copy(alpha = 0.8f),
                        contentColor = if (tracking) accent else Color.White,
                    ),
                ) {
                    Icon(Icons.Outlined.MyLocation, contentDescription = null)
                    Spacer(Modifier.height(0.dp))
                    Text(if (tracking) "  tracking" else "  locate me")
                }
                // 🗺️ agent pins are process-lifetime (they survive the sheet)
                // — so the USER gets the eraser, not just the agent
                if (agentPins.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    FilledTonalButton(
                        onClick = { AgentMap.clearPins() },
                        colors = androidx.compose.material3.ButtonDefaults.filledTonalButtonColors(
                            containerColor = Color.Black.copy(alpha = 0.8f),
                            contentColor = Color.White,
                        ),
                    ) {
                        Text(if (agentPins.size == 1) "clear 1 pin" else "clear ${agentPins.size} pins")
                    }
                }
                // 🌍 presence opt-in (web /map parity) — signed-in only;
                // being seen requires a position to be seen at, so enabling
                // also starts tracking. Off = immediate opt-out DELETE.
                if (app.auth.isLoggedIn) {
                    Spacer(Modifier.height(8.dp))
                    FilledTonalButton(
                        onClick = {
                            if (beSeen) {
                                beSeen = false
                                lastBeat = null
                                scope.launch { runCatching { app.api.deleteJson("/api/location") } }
                            } else {
                                if (!tracking) {
                                    if (Geo.hasPermission(app)) tracking = true
                                    else locationAsk.launch(arrayOf(
                                        Manifest.permission.ACCESS_FINE_LOCATION,
                                        Manifest.permission.ACCESS_COARSE_LOCATION,
                                    ))
                                }
                                beSeen = true
                            }
                        },
                        colors = androidx.compose.material3.ButtonDefaults.filledTonalButtonColors(
                            containerColor = Color.Black.copy(alpha = 0.8f),
                            contentColor = if (beSeen) accent else Color.White,
                        ),
                    ) {
                        Text(if (beSeen) "🌍 visible to tinys" else "🌍 be seen")
                    }
                }
            }

            // HUD — the literal context block the tiny reads (web /map parity)
            if (tracking) {
                Surface(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(12.dp),
                    color = Color.Black.copy(alpha = 0.8f),
                    contentColor = Color.White,
                    shape = RoundedCornerShape(16.dp),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        val block = Geo.contextBlock(fix)
                        Text(
                            if (block.isBlank()) "waiting for position…" else block,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            lineHeight = 16.sp,
                            color = Color(0xFFD1D5DB),
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            if (beSeen) "this is what your tiny sees — and your pin is live for others (~11m coarse)"
                            else "this is what your tiny sees — location stays on this phone",
                            fontSize = 11.sp,
                            color = Color(0xFF6B7280),
                        )
                    }
                }
            }
        }
    }
}

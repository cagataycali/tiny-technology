package technology.tiny.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.animation.core.animateFloat
import androidx.compose.runtime.collectAsState
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
import technology.tiny.app.TinyApp
import technology.tiny.app.geo.Geo
import technology.tiny.app.tools.AgentMap

/**
 * 🗺️ Ambient map behind the chat (phase 2 — web GlobalMapBackdrop parity,
 * agi-diy map-mode). Non-interactive by contract: every gesture and control
 * is off — "the map is just ambiance" — and the chat's Scaffold goes
 * translucent over it (MainActivity washes containerColor to alpha 0.55,
 * web's rgba(0,0,0,0.55) map-mode value). The camera follows the same
 * fused snapshots the agent context reads, so what the user sees drift by
 * and what the tiny is told are one thing.
 */

/** Live view of the "share location with your tiny" pref — the ONE opt-in
 *  (web parity: map-on and context-injection are the same choice). Reacts
 *  to the Settings toggle via a pref listener, no restart needed. */
@Composable
fun rememberLocationContextOn(app: TinyApp): State<Boolean> {
    val on = remember { mutableStateOf(app.config.locationContext) }
    DisposableEffect(Unit) {
        val prefs = app.getSharedPreferences("tiny_config", android.content.Context.MODE_PRIVATE)
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == "cfg_location_context") on.value = app.config.locationContext
        }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        onDispose { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    return on
}

@Composable
fun MapBackdrop(app: TinyApp, modifier: Modifier = Modifier) {
    val accent = MaterialTheme.colorScheme.primary
    val youPulse = rememberYouPulse()
    var fix by remember { mutableStateOf<Geo.Fix?>(null) }
    // Opted-in tiny users (be-seen heartbeats) — quiet dots UNDER the chat:
    // people see people using tinys, right on the background.
    var presence by remember { mutableStateOf(listOf<LatLng>()) }

    // Check in with the agent bridge: while a map is composed, map tool
    // calls are visible — no "tap 📍" hint needed.
    DisposableEffect(Unit) {
        AgentMap.mapShown()
        onDispose { AgentMap.mapHidden() }
    }
    val cameraState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(LatLng(37.7749, -122.4194), 13f)
    }

    // Presence poll — public read, each minute while the backdrop is composed
    // (MapSheet's loop, unlabeled: dots are ambiance, the sheet is for looking)
    LaunchedEffect(Unit) {
        while (true) {
            runCatching {
                val res = app.api.getJson("/api/location")
                val me = res.optString("me")
                val pins = res.optJSONArray("pins")
                if (pins != null) {
                    presence = (0 until pins.length()).mapNotNull { i ->
                        val p = pins.optJSONObject(i) ?: return@mapNotNull null
                        val id = p.optString("userId")
                        if (id.isBlank() || id == me) return@mapNotNull null
                        val lat = p.optDouble("lat")
                        val lng = p.optDouble("lng")
                        if (lat.isFinite() && lng.isFinite()) LatLng(lat, lng) else null
                    }
                }
            }
            delay(60_000)
        }
    }

    // Agent camera gestures (fly_to_location / fly_to_marker / tour_markers).
    // drop(1) skips the flow's stale latest on (re)mount — only gestures made
    // while this map is up move it. The follow loop below resumes on its next
    // 15s tick, same push-pull the web ambient map has.
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

    // Follow loop: fused snapshots (Geo caches 30s — pocket cadence). The
    // backdrop has no gestures to fight, so unlike the interactive sheet it
    // keeps FOLLOWING (agi-diy panTo-on-update): first fix jumps, later
    // ones glide.
    LaunchedEffect(Unit) {
        var first = true
        while (true) {
            Geo.current(app)?.let { f ->
                fix = f
                val here = LatLng(f.lat, f.lng)
                if (first) {
                    cameraState.move(CameraUpdateFactory.newLatLngZoom(here, 15f))
                    first = false
                } else if (!AgentMap.followSuspended) {
                    // an agent fly/tour owns the camera for 30s — panning
                    // home mid-gesture made the tools look broken
                    cameraState.animate(CameraUpdateFactory.newLatLng(here))
                }
            }
            delay(15_000)
        }
    }

    // Ambient grade (web/iOS parity): the multiply is baked into the style
    // JSON (SurfaceView — no compositor blend available), leaned toward this
    // tiny's accent. The interactive MapSheet keeps the neutral style.
    val graded = remember(accent) {
        val argb = accent.toArgb()
        gradedMapStyle((argb shr 16) and 0xFF, (argb shr 8) and 0xFF, argb and 0xFF)
    }
    GoogleMap(
        modifier = modifier,
        cameraPositionState = cameraState,
        properties = MapProperties(mapStyleOptions = MapStyleOptions(graded)),
        uiSettings = MapUiSettings(
            compassEnabled = false,
            indoorLevelPickerEnabled = false,
            mapToolbarEnabled = false,
            myLocationButtonEnabled = false,
            rotationGesturesEnabled = false,
            scrollGesturesEnabled = false,
            scrollGesturesEnabledDuringRotateOrZoom = false,
            tiltGesturesEnabled = false,
            zoomControlsEnabled = false,
            zoomGesturesEnabled = false,
        ),
    ) {
        // Agent pins (add_map_marker) — drawn even behind the chat wash so a
        // "look at this spot" gesture lands without opening the sheet.
        val agentPins by AgentMap.pins.collectAsState()
        for (pin in agentPins.values) {
            Marker(
                state = MarkerState(position = LatLng(pin.lat, pin.lng)),
                title = pin.label ?: "your tiny's pin",
                icon = AgentMap.markerHue(pin.color)?.let { BitmapDescriptorFactory.defaultMarker(it) },
            )
        }
        // Presence: small dots, not Markers — ambiance (the graded style
        // keeps them quiet; the sheet is where you really look at them)
        presence.forEach { pos ->
            Circle(
                center = pos,
                radius = 22.0,
                fillColor = accent.copy(alpha = 0.7f),
                strokeColor = Color.White.copy(alpha = 0.5f),
                strokeWidth = 2f,
            )
        }
        fix?.let { f ->
            val here = LatLng(f.lat, f.lng)
            // the agi-diy .pulse-ring, reborn: a ring breathes out of the
            // "you" dot every 2s (the old design's signature living detail)
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
    }
}

/** 0→1 sawtooth over 2s — drives the breathing ring on both map surfaces. */
@Composable
internal fun rememberYouPulse(): Float {
    val transition = androidx.compose.animation.core.rememberInfiniteTransition(label = "you-pulse")
    val frac by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = androidx.compose.animation.core.infiniteRepeatable(
            animation = androidx.compose.animation.core.tween(2000, easing = androidx.compose.animation.core.LinearOutSlowInEasing),
            repeatMode = androidx.compose.animation.core.RepeatMode.Restart,
        ),
        label = "you-pulse-frac",
    )
    return frac
}

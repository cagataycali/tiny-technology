package technology.tiny.app.tools

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 🗺️ Agent map bridge — the Android half of the web `__tinyMapBridge`
 * (agi-diy index.html:2607 port). ChatViewModel feeds beforeToolCallEvent
 * map tools here; MapBackdrop/MapSheet observe the flows and draw. Pins are
 * keyed by the id the AGENT chose (re-using an id moves that pin), so
 * remove/fly-to/tour need no round-trip: the model references ids it
 * assigned. State outlives any one map composable on purpose — pins placed
 * while the map is off greet the user when they enable 📍.
 */
object AgentMap {
    data class Pin(
        val id: String,
        val lat: Double,
        val lng: Double,
        val label: String? = null,
        /** raw CSS-ish hex from the tool call; hue-mapped at render time */
        val color: String? = null,
    )

    /** One camera gesture; `seq` makes each command distinct so collectors
     *  can skip the stale latest value on (re)mount. */
    data class Camera(val seq: Long, val lat: Double, val lng: Double, val zoom: Float? = null)

    private val _pins = MutableStateFlow<Map<String, Pin>>(emptyMap())
    val pins: StateFlow<Map<String, Pin>> get() = _pins

    private val _camera = MutableStateFlow<Camera?>(null)
    val camera: StateFlow<Camera?> get() = _camera

    private var autoId = 0L
    private var seq = 0L
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var tourJob: Job? = null

    // Composed map surfaces (backdrop/sheet) check in so the chat can tell
    // when a map gesture would be INVISIBLE and hint instead (web parity:
    // the "tap 📍 to see it" toast).
    private val _visibleMaps = MutableStateFlow(0)
    val mapVisible: Boolean get() = _visibleMaps.value > 0
    fun mapShown() { _visibleMaps.value += 1 }
    fun mapHidden() { _visibleMaps.value = (_visibleMaps.value - 1).coerceAtLeast(0) }

    /** Returns true when the tool name was a map tool (handled here). */
    fun handle(name: String, input: JSONObject): Boolean {
        when (name) {
            "add_map_marker" -> {
                val lat = input.optDouble("lat", Double.NaN)
                val lng = input.optDouble("lng", Double.NaN)
                if (!validCoords(lat, lng)) return true
                val id = input.optString("id").ifBlank { "pin-${++autoId}" }.take(32)
                _pins.value = _pins.value + (id to Pin(
                    id = id,
                    lat = lat,
                    lng = lng,
                    label = input.optString("label").ifBlank { null }?.take(40),
                    color = input.optString("color").ifBlank { null },
                ))
            }
            "remove_map_marker" -> {
                resolvePin(input.optString("id"))?.let { _pins.value = _pins.value - it.id }
            }
            "clear_map_markers" -> clearPins()
            "fly_to_location" -> {
                val lat = input.optDouble("lat", Double.NaN)
                val lng = input.optDouble("lng", Double.NaN)
                if (validCoords(lat, lng)) fly(lat, lng, zoomOrNull(input))
            }
            "fly_to_marker" -> {
                resolvePin(input.optString("id"))?.let { fly(it.lat, it.lng, zoomOrNull(input)) }
            }
            "tour_markers" -> {
                val stops = tourStops(input)
                if (stops.isEmpty()) return true
                val pause = tourPauseMs(input)
                tourJob?.cancel()
                tourJob = scope.launch {
                    for (p in stops) {
                        fly(p.lat, p.lng, null)
                        delay(pause)
                    }
                }
            }
            else -> return false
        }
        return true
    }

    /** Drop every agent pin and stop a running tour — the agent's
     *  clear_map_markers and the map screens' "clear pins" button. */
    fun clearPins() {
        tourJob?.cancel()
        tourJob = null
        _pins.value = emptyMap()
    }

    /** id → pin, with a LABEL fallback (iOS resolvePin parity): the model
     *  often skips the optional id on add (the auto "pin-N" is never echoed
     *  back), then references the pin by its label — "fly to the coffee
     *  pin" must fly. Exact id wins; else first case-insensitive label. */
    internal fun resolvePin(ref: String): Pin? {
        _pins.value[ref]?.let { return it }
        val needle = ref.trim().lowercase()
        if (needle.isEmpty()) return null
        return _pins.value.values.firstOrNull { (it.label ?: "").lowercase() == needle }
    }

    /** Known pins in tour order — unknown refs skipped, capped at 12 (web bridge parity). */
    internal fun tourStops(input: JSONObject): List<Pin> {
        val ids = input.optJSONArray("ids") ?: return emptyList()
        return (0 until ids.length()).mapNotNull { resolvePin(ids.optString(it)) }.take(12)
    }

    internal fun tourPauseMs(input: JSONObject): Long =
        input.optLong("pause_ms", 2000L).coerceIn(500L, 10_000L)

    private fun validCoords(lat: Double, lng: Double): Boolean =
        lat.isFinite() && lng.isFinite() && lat in -90.0..90.0 && lng in -180.0..180.0

    private fun zoomOrNull(input: JSONObject): Float? {
        val z = input.optDouble("zoom", Double.NaN)
        return if (z.isFinite()) z.toFloat().coerceIn(1f, 20f) else null
    }

    /** When the agent last steered the camera (epoch ms — System.currentTimeMillis
     *  is JVM-test-safe, SystemClock isn't). The ambient follow loop yields for
     *  30s after a gesture instead of stomping it on its next 15s tick
     *  (fly_to_marker looked broken: the map snapped home). */
    @Volatile
    var lastGestureAtMs = 0L
        private set
    val followSuspended: Boolean
        get() = System.currentTimeMillis() - lastGestureAtMs < 30_000

    /** Spotlight: while the agent is presenting (fly/tour), the chat wash
     *  thins so the map comes FORWARD, then fades back. Duration settable
     *  for tests. */
    private val _spotlight = MutableStateFlow(false)
    val spotlight: StateFlow<Boolean> get() = _spotlight
    internal var spotlightMs = 8_000L
    private var spotlightJob: Job? = null

    @Synchronized
    private fun fly(lat: Double, lng: Double, zoom: Float?) {
        lastGestureAtMs = System.currentTimeMillis()
        _camera.value = Camera(++seq, lat, lng, zoom)
        _spotlight.value = true
        spotlightJob?.cancel()
        spotlightJob = scope.launch {
            delay(spotlightMs)
            _spotlight.value = false
        }
    }

    /**
     * Marker hue (0..360) for a #rgb/#rrggbb color, null → default red pin.
     * Pure rgb→hue math — android.graphics.Color is unavailable on the JVM.
     */
    fun markerHue(color: String?): Float? {
        val hex = color?.trim()?.removePrefix("#") ?: return null
        val rgb = when (hex.length) {
            3 -> hex.map { "$it$it".toIntOrNull(16) ?: return null }
            6 -> hex.chunked(2).map { it.toIntOrNull(16) ?: return null }
            else -> return null
        }
        val (r, g, b) = rgb.map { it / 255f }
        val max = maxOf(r, g, b)
        val min = minOf(r, g, b)
        val d = max - min
        if (d == 0f) return null // greys have no hue — keep the default pin
        val h = when (max) {
            r -> ((g - b) / d) % 6f
            g -> (b - r) / d + 2f
            else -> (r - g) / d + 4f
        } * 60f
        return if (h < 0f) h + 360f else h
    }

    /** Tests only — the singleton outlives JUnit classes. */
    internal fun resetForTest() {
        tourJob?.cancel()
        tourJob = null
        spotlightJob?.cancel()
        spotlightJob = null
        _spotlight.value = false
        spotlightMs = 8_000L
        _pins.value = emptyMap()
        _camera.value = null
        _visibleMaps.value = 0
        autoId = 0L
        seq = 0L
        lastGestureAtMs = 0L
    }
}

package technology.tiny.app.tools

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The agent map bridge's contract mirrors web tests/map-tools.test.ts +
 * MapBackground's bridge: id'd pins (re-use moves), coordinate/zoom/pause
 * clamps, tour stops filter to KNOWN pins capped at 12.
 */
class AgentMapTest {

    @After
    fun tearDown() = AgentMap.resetForTest()

    private fun j(vararg pairs: Pair<String, Any?>) =
        JSONObject().apply { pairs.forEach { (k, v) -> put(k, v) } }

    @Test
    fun addStoresPinUnderAgentChosenId() {
        assertTrue(AgentMap.handle("add_map_marker", j("lat" to 37.7749, "lng" to -122.4194, "id" to "stop-1", "label" to "coffee")))
        val pin = AgentMap.pins.value["stop-1"]!!
        assertEquals(37.7749, pin.lat, 1e-9)
        assertEquals("coffee", pin.label)
    }

    @Test
    fun addWithoutIdAutoAssignsAndReusedIdMovesThePin() {
        AgentMap.handle("add_map_marker", j("lat" to 1.0, "lng" to 2.0))
        assertTrue(AgentMap.pins.value.containsKey("pin-1"))
        AgentMap.handle("add_map_marker", j("lat" to 3.0, "lng" to 4.0, "id" to "a"))
        AgentMap.handle("add_map_marker", j("lat" to 5.0, "lng" to 6.0, "id" to "a"))
        assertEquals(2, AgentMap.pins.value.size)
        assertEquals(5.0, AgentMap.pins.value["a"]!!.lat, 1e-9)
    }

    @Test
    fun addRejectsOutOfRangeCoordsButStillClaimsTheTool() {
        assertTrue(AgentMap.handle("add_map_marker", j("lat" to 91.0, "lng" to 0.0)))
        assertTrue(AgentMap.handle("add_map_marker", j("lat" to 0.0, "lng" to -181.0)))
        assertTrue(AgentMap.handle("add_map_marker", j("lng" to -122.4)))
        assertTrue(AgentMap.pins.value.isEmpty())
    }

    @Test
    fun clearPinsIsTheUserFacingEraser() {
        AgentMap.handle("add_map_marker", j("lat" to 1.0, "lng" to 2.0, "id" to "a"))
        AgentMap.handle("add_map_marker", j("lat" to 3.0, "lng" to 4.0, "id" to "b"))
        AgentMap.clearPins()
        assertTrue(AgentMap.pins.value.isEmpty())
    }

    @Test
    fun removeAndClearDropPins() {
        AgentMap.handle("add_map_marker", j("lat" to 1.0, "lng" to 2.0, "id" to "a"))
        AgentMap.handle("add_map_marker", j("lat" to 3.0, "lng" to 4.0, "id" to "b"))
        AgentMap.handle("remove_map_marker", j("id" to "a"))
        assertEquals(setOf("b"), AgentMap.pins.value.keys)
        AgentMap.handle("clear_map_markers", j("confirm" to true))
        assertTrue(AgentMap.pins.value.isEmpty())
    }

    @Test
    fun flyToLocationEmitsCameraWithClampedZoom() {
        AgentMap.handle("fly_to_location", j("lat" to 41.0082, "lng" to 28.9784, "zoom" to 12))
        val cam = AgentMap.camera.value!!
        assertEquals(41.0082, cam.lat, 1e-9)
        assertEquals(12f, cam.zoom)
        AgentMap.handle("fly_to_location", j("lat" to 1.0, "lng" to 2.0, "zoom" to 99))
        assertEquals(20f, AgentMap.camera.value!!.zoom)
    }

    @Test
    fun pinRefsResolveByLabelWhenTheIdMisses() {
        // The model skipped the optional id (auto pin-1), then referenced
        // the LABEL — the exact field failure behind "fly doesn't work".
        AgentMap.handle("add_map_marker", j("lat" to 37.8, "lng" to -122.27, "label" to "Coffee"))
        AgentMap.handle("fly_to_marker", j("id" to "coffee"))
        assertEquals(37.8, AgentMap.camera.value!!.lat, 1e-9)
        AgentMap.handle("remove_map_marker", j("id" to "COFFEE"))
        assertTrue(AgentMap.pins.value.isEmpty())
    }

    @Test
    fun exactIdStillWinsOverALabelCollision() {
        AgentMap.handle("add_map_marker", j("lat" to 1.0, "lng" to 2.0, "id" to "a", "label" to "b"))
        AgentMap.handle("add_map_marker", j("lat" to 3.0, "lng" to 4.0, "id" to "b", "label" to "a"))
        AgentMap.handle("fly_to_marker", j("id" to "b")) // the id "b", not label "b"
        assertEquals(3.0, AgentMap.camera.value!!.lat, 1e-9)
    }

    @Test
    fun flyToMarkerUsesTheStoredPinAndIgnoresUnknownIds() {
        AgentMap.handle("add_map_marker", j("lat" to 7.0, "lng" to 8.0, "id" to "a"))
        AgentMap.handle("fly_to_marker", j("id" to "a"))
        assertEquals(7.0, AgentMap.camera.value!!.lat, 1e-9)
        val seq = AgentMap.camera.value!!.seq
        AgentMap.handle("fly_to_marker", j("id" to "ghost"))
        assertEquals(seq, AgentMap.camera.value!!.seq)
    }

    @Test
    fun cameraSeqIsMonotonicSoCollectorsSeeEveryGesture() {
        AgentMap.handle("fly_to_location", j("lat" to 1.0, "lng" to 2.0))
        AgentMap.handle("fly_to_location", j("lat" to 1.0, "lng" to 2.0))
        assertEquals(2L, AgentMap.camera.value!!.seq)
    }

    @Test
    fun tourStopsFilterUnknownIdsKeepOrderAndCapAtTwelve() {
        for (i in 1..15) AgentMap.handle("add_map_marker", j("lat" to i.toDouble(), "lng" to 0.0, "id" to "p$i"))
        val ids = JSONArray().apply { (15 downTo 1).forEach { put("p$it") }; put("ghost") }
        val stops = AgentMap.tourStops(j("ids" to ids))
        assertEquals(12, stops.size)
        assertEquals("p15", stops.first().id)
        assertNull(stops.find { it.id == "ghost" })
    }

    @Test
    fun tourPauseClampsToWebBridgeBounds() {
        assertEquals(2000L, AgentMap.tourPauseMs(j()))
        assertEquals(500L, AgentMap.tourPauseMs(j("pause_ms" to 100)))
        assertEquals(10_000L, AgentMap.tourPauseMs(j("pause_ms" to 60_000)))
    }

    @Test
    fun nonMapToolsAreNotClaimed() {
        assertFalse(AgentMap.handle("vibrate", j("pattern" to "tap")))
    }

    @Test
    fun spotlightRisesOnGestureAndDecays() {
        AgentMap.spotlightMs = 60
        assertFalse(AgentMap.spotlight.value)
        AgentMap.handle("fly_to_location", j("lat" to 1.0, "lng" to 2.0))
        assertTrue(AgentMap.spotlight.value)
        Thread.sleep(400)
        assertFalse(AgentMap.spotlight.value)
    }

    @Test
    fun agentGestureSuspendsTheFollowLoop() {
        assertFalse(AgentMap.followSuspended)
        AgentMap.handle("fly_to_location", j("lat" to 1.0, "lng" to 2.0))
        assertTrue(AgentMap.followSuspended)
        AgentMap.resetForTest()
        assertFalse(AgentMap.followSuspended)
    }

    @Test
    fun visibilityCounterTracksComposedSurfacesAndFloorsAtZero() {
        assertFalse(AgentMap.mapVisible)
        AgentMap.mapShown()
        AgentMap.mapShown() // backdrop + sheet at once
        AgentMap.mapHidden()
        assertTrue(AgentMap.mapVisible)
        AgentMap.mapHidden()
        AgentMap.mapHidden() // over-release must not go negative
        assertFalse(AgentMap.mapVisible)
        AgentMap.mapShown()
        assertTrue(AgentMap.mapVisible)
    }

    @Test
    fun markerHueMapsHexToHueAndRejectsJunk() {
        assertEquals(0f, AgentMap.markerHue("#ff0000")!!, 0.5f)
        assertEquals(120f, AgentMap.markerHue("#00ff00")!!, 0.5f)
        assertEquals(240f, AgentMap.markerHue("#00f")!!, 0.5f)
        assertNull(AgentMap.markerHue(null))
        assertNull(AgentMap.markerHue("#ffffff")) // grey → default pin
        assertNull(AgentMap.markerHue("tomato"))
    }
}

package technology.tiny.app.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject

/**
 * Pure app→widget snapshot serialization (WidgetStore's FleetSnapshot). The APP
 * writes this JSON; the Glance home-screen widgets read it back, so the round-trip
 * must be lossless and the omit-when-empty rules exact — a stray empty "memories"/
 * "accentHex" key or a dropped field renders wrong data on the home screen. Pure
 * Kotlin (the SharedPreferences read/write is exercised on-device).
 */
class FleetSnapshotTest {

    @Test fun `a fully-populated snapshot round-trips losslessly`() {
        val snap = FleetSnapshot(
            online = 2, total = 3, unread = 5, login = "cagatay", accentHex = "#00FF88",
            lastQ = "how's the fleet", lastA = "all green", lastAt = 111L,
            memories = listOf("likes tea", "PST timezone"), updated = 222L,
        )
        val back = FleetSnapshot.fromJson(snap.toJson())
        assertEquals(snap, back)
    }

    @Test fun `optional string fields are OMITTED from json when null`() {
        val json = JSONObject(FleetSnapshot(online = 1, total = 1).toJson())
        assertFalse("accentHex omitted", json.has("accentHex"))
        assertFalse("lastQ omitted", json.has("lastQ"))
        assertFalse("lastA omitted", json.has("lastA"))
        assertFalse("empty memories omitted", json.has("memories"))
        // Required numeric/string fields are always present.
        assertTrue(json.has("online") && json.has("total") && json.has("login") && json.has("updated"))
    }

    @Test fun `omitted optionals decode back to null and empty, not empty-string`() {
        val back = FleetSnapshot.fromJson(FleetSnapshot(online = 1, total = 1).toJson())
        assertNull(back.accentHex)
        assertNull(back.lastQ)
        assertNull(back.lastA)
        assertEquals(emptyList<String>(), back.memories)
    }

    @Test fun `non-empty memories serialize as a json array and round-trip`() {
        val json = JSONObject(FleetSnapshot(memories = listOf("a", "b")).toJson())
        assertTrue(json.has("memories"))
        assertEquals(2, json.getJSONArray("memories").length())
        assertEquals(listOf("a", "b"), FleetSnapshot.fromJson(json.toString()).memories)
    }

    @Test fun `blank memory entries are dropped on decode`() {
        // A snapshot whose memories array carries an empty string (defensive): decode
        // filters it so the widget never renders a blank bullet.
        val raw = """{"online":1,"total":1,"login":"x","memories":["real","",""],"updated":1}"""
        assertEquals(listOf("real"), FleetSnapshot.fromJson(raw).memories)
    }

    @Test fun `malformed json decodes to the empty default, never throws`() {
        assertEquals(FleetSnapshot(), FleetSnapshot.fromJson("not json{"))
        assertEquals(FleetSnapshot(), FleetSnapshot.fromJson(""))
    }

    @Test fun `missing fields fall back to their defaults`() {
        // A partial snapshot (older writer / hand-rolled) fills absent fields with defaults.
        val back = FleetSnapshot.fromJson("""{"online":4}""")
        assertEquals(4, back.online)
        assertEquals(0, back.total)
        assertEquals("", back.login)
        assertEquals(0L, back.updated)
    }
}

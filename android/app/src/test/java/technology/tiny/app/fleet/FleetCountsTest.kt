package technology.tiny.app.fleet

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * FleetCounts holds the two off-by-one-prone counts behind the ⚡ activity badge and
 * the fleet-status widget — extracted from FleetManager so the arithmetic is testable
 * without a Context/network. unreadEvents mirrors web ActivityHUD (id > seenId, STRICT);
 * onlineCount/totalCount mirror iOS refreshFleetWidget. org.json is on the test classpath.
 */
class FleetCountsTest {

    private fun events(vararg ids: Long): JSONArray {
        val arr = JSONArray()
        ids.forEach { arr.put(org.json.JSONObject().put("id", it)) }
        return arr
    }

    private fun devices(vararg online: Boolean): JSONArray {
        val arr = JSONArray()
        online.forEach { arr.put(org.json.JSONObject().put("online", it)) }
        return arr
    }

    // -- unreadEvents --

    @Test fun `only ids strictly greater than the seen mark count`() {
        // seen=5 → ids 6,7 are unread; 5 (equal) and 3 (older) are not.
        assertEquals(2, FleetCounts.unreadEvents(events(3, 5, 6, 7), seenId = 5))
    }

    @Test fun `an id equal to the mark is already seen, not unread`() {
        assertEquals(0, FleetCounts.unreadEvents(events(5), seenId = 5))
    }

    @Test fun `a fresh mark of zero counts every positive id`() {
        assertEquals(3, FleetCounts.unreadEvents(events(1, 2, 3), seenId = 0))
    }

    @Test fun `an entry missing an id is treated as id zero`() {
        val arr = JSONArray()
        arr.put(org.json.JSONObject()) // no id → 0
        arr.put(org.json.JSONObject().put("id", 9L))
        // seen=0: the id-less (0) is NOT > 0, only id 9 counts.
        assertEquals(1, FleetCounts.unreadEvents(arr, seenId = 0))
    }

    @Test fun `null or empty events yield zero unread`() {
        assertEquals(0, FleetCounts.unreadEvents(null, seenId = 0))
        assertEquals(0, FleetCounts.unreadEvents(JSONArray(), seenId = 3))
    }

    @Test fun `a non-object element is skipped, not a crash`() {
        val arr = JSONArray("""["oops", {"id": 8}]""")
        assertEquals(1, FleetCounts.unreadEvents(arr, seenId = 0))
    }

    // -- onlineCount / totalCount --

    @Test fun `online count tallies only online devices`() {
        assertEquals(2, FleetCounts.onlineCount(devices(true, false, true)))
    }

    @Test fun `a device missing the online flag defaults to offline`() {
        val arr = JSONArray()
        arr.put(org.json.JSONObject()) // no "online" key → false
        arr.put(org.json.JSONObject().put("online", true))
        assertEquals(1, FleetCounts.onlineCount(arr))
    }

    @Test fun `total counts every well-formed device object`() {
        assertEquals(3, FleetCounts.totalCount(devices(true, false, false)))
    }

    @Test fun `total skips non-object elements`() {
        val arr = JSONArray("""[{"online":true}, "junk", {"online":false}]""")
        assertEquals(2, FleetCounts.totalCount(arr))
        assertEquals(1, FleetCounts.onlineCount(arr))
    }

    @Test fun `null devices yield zero online and zero total`() {
        assertEquals(0, FleetCounts.onlineCount(null))
        assertEquals(0, FleetCounts.totalCount(null))
    }

    @Test fun `all offline is zero online but full total`() {
        val arr = devices(false, false)
        assertEquals(0, FleetCounts.onlineCount(arr))
        assertEquals(2, FleetCounts.totalCount(arr))
    }
}

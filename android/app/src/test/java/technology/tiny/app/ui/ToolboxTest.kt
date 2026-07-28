package technology.tiny.app.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure helpers behind the ToolboxSheet / profile "building since" line —
 * params JSON → sorted display rows, GET /api/tools parsing, and the
 * seconds-vs-milliseconds date formatting (web Profile.tsx:79 guard).
 * Pure Kotlin + org.json — runs on the local JVM.
 */
class ToolboxTest {

    @Test fun `toolParamRows sorts keys and accepts object or stringified JSON`() {
        val obj = JSONObject().put("zip", "postal code").put("city", "city name")
        assertEquals(
            listOf("city" to "city name", "zip" to "postal code"),
            toolParamRows(obj),
        )
        // The worker stores params stringified — the string form must parse too.
        assertEquals(
            listOf("city" to "city name", "zip" to "postal code"),
            toolParamRows("""{"zip":"postal code","city":"city name"}"""),
        )
        // Garbage / absent → no rows, never a crash.
        assertEquals(emptyList<Pair<String, String>>(), toolParamRows("not json"))
        assertEquals(emptyList<Pair<String, String>>(), toolParamRows(null))
    }

    @Test fun `parseMyTools maps rows strips my_ prefix and drops nameless entries`() {
        val arr = JSONArray()
            .put(
                JSONObject()
                    .put("name", "my_weather")
                    .put("description", "current conditions")
                    .put("params", JSONObject().put("city", "city name"))
                    .put("code", "async function run() {}")
                    .put("created", 1_752_800_000L),
            )
            .put(JSONObject().put("description", "nameless — dropped"))
        val tools = parseMyTools(arr)
        assertEquals(1, tools.size)
        assertEquals("weather", tools[0].name) // my_ prefix stripped for display re-prefixing
        assertEquals("current conditions", tools[0].description)
        assertEquals(listOf("city" to "city name"), tools[0].params)
        assertEquals("async function run() {}", tools[0].code)
        assertEquals(1_752_800_000L, tools[0].created)
        // null / empty array → empty list
        assertEquals(emptyList<MyTool>(), parseMyTools(null))
        assertEquals(emptyList<MyTool>(), parseMyTools(JSONArray()))
    }

    @Test fun `date formatting handles unix seconds AND milliseconds, zero means absent`() {
        // 2026-07-15T12:00:00Z — mid-month/mid-day so no timezone edge ambiguity.
        val seconds = 1_784_116_800L
        val millis = seconds * 1000
        assertEquals(millis, epochMs(seconds))
        assertEquals(millis, epochMs(millis)) // already ms — passed through
        assertEquals("July 2026", formatJoinedDate(seconds))
        assertEquals("July 2026", formatJoinedDate(millis))
        assertEquals("Jul 15, 2026", formatToolCreated(seconds))
        // 0/negative (JSON optLong default for a missing field) → no line at all.
        assertNull(formatJoinedDate(0))
        assertNull(formatToolCreated(0))
        assertNull(formatJoinedDate(-5))
    }

    @Test fun `formatAliveSince is short month plus year, seconds or millis, absent to null`() {
        // web Profile.tsx:162 renders a tiny card's age with {month:"short", year:"numeric"}
        // → "Jul 2026" (distinct from formatJoinedDate's long "July 2026").
        val seconds = 1_784_116_800L // 2026-07-15T12:00:00Z
        assertEquals("Jul 2026", formatAliveSince(seconds))
        assertEquals("Jul 2026", formatAliveSince(seconds * 1000)) // already ms
        assertNull(formatAliveSince(0)) // absent created → card falls back to the URL
        assertNull(formatAliveSince(-1))
    }
}

package technology.tiny.app.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The printer panel's pure logic (web app/devices/page.tsx + iOS
 * EndpointPanelTests.swift parity).
 *
 * Everything here reads a MACHINE'S OWN payload: optional fields, numbers that
 * arrive as strings, nulls where a sensor should be. The panel's job is to be
 * boringly honest about that — skip what it can't read rather than print "NaN°",
 * and never collapse three different failures into one message.
 */
class EndpointPanelTest {

    /** The live printer's real payload, trimmed. `fan.cooling` really is a String. */
    private fun printerPayload() = JSONObject(
        """
        {"gcode_state":"RUNNING","progress":62,"layer":7,"total_layers":10,
         "remaining_min":18,"subtask_name":"plate_colored.3mf",
         "temps":{"nozzle":218,"nozzle_target":220,"bed":60,"bed_target":60,"chamber":null},
         "fan":{"cooling":"0"}}
        """.trimIndent(),
    )

    // ── telemetryNumber: the tolerant read ───────────────────────────────────

    @Test fun `a number arrives as a number, a string, or not at all`() {
        assertEquals(41.0, telemetryNumber(41)!!, 0.001)
        assertEquals(41.5, telemetryNumber(41.5)!!, 0.001)
        // Bambu sends fan speeds as strings; number-only parsing drops real data.
        assertEquals(30.7, telemetryNumber("30.7")!!, 0.001)
        assertNull(telemetryNumber(null))
        assertNull(telemetryNumber("--"))
        assertNull(telemetryNumber(""))
        assertNull(telemetryNumber(JSONObject.NULL))
    }

    @Test fun `a non-finite number is not a reading`() {
        // The bug this prevents: NaN passes a null check and formats as "NaN°".
        assertNull(telemetryNumber(Double.NaN))
        assertNull(telemetryNumber(Double.POSITIVE_INFINITY))
    }

    @Test fun `a JSON null temperature is absent, not zero`() {
        // The printer really does answer chamber:null. Reading it as 0 would draw
        // a chamber at freezing.
        val t = JSONObject("""{"temps":{"chamber":null,"nozzle":41,"nozzle_target":0}}""")
        assertNull(telemetryNumber(t.getJSONObject("temps").opt("chamber")))
    }

    // ── telemetryReadings: the projection ────────────────────────────────────

    @Test fun `a running print reads out in the web's order`() {
        val r = telemetryReadings(printerPayload())
        assertEquals(listOf("state", "job", "nozzle", "bed", "layer", "remaining"), r.map { it.label })
        assertEquals("running", r.first { it.label == "state" }.value)
        assertEquals("plate_colored.3mf · 62%", r.first { it.label == "job" }.value)
        assertEquals("218° → 220°", r.first { it.label == "nozzle" }.value)
        assertEquals("7 / 10", r.first { it.label == "layer" }.value)
        assertEquals("18 min", r.first { it.label == "remaining" }.value)
    }

    @Test fun `an idle machine shows a SHORT list, not a grid of dashes`() {
        val idle = JSONObject(
            """
            {"gcode_state":"FINISH","progress":100,"layer":10,"total_layers":10,
             "remaining_min":0,"subtask_name":"plate_colored.3mf",
             "temps":{"nozzle":41,"nozzle_target":0,"bed":37,"bed_target":0,"chamber":null}}
            """.trimIndent(),
        )
        val r = telemetryReadings(idle)
        // A 0 target is "not heating" — "41° → 0°" implies a cooldown command that
        // was never issued.
        assertEquals("41°", r.first { it.label == "nozzle" }.value)
        assertEquals("37°", r.first { it.label == "bed" }.value)
        // remaining_min = 0 is not a reading, it's the absence of one.
        assertTrue(r.none { it.label == "remaining" })
    }

    @Test fun `an empty or garbage payload renders nothing rather than crashing`() {
        assertTrue(telemetryReadings(JSONObject()).isEmpty())
        // A machine mid-boot: keys present, values junk.
        val junk = JSONObject(
            """{"gcode_state":"","subtask_name":"   ","progress":"n/a","layer":null,
                "total_layers":0,"remaining_min":"?","temps":"not-a-dict"}""",
        )
        assertTrue(telemetryReadings(junk).isEmpty())
    }

    @Test fun `no field ever renders a NaN, a null, or an empty value`() {
        // The whole point of the projection: whatever comes in, what goes out is
        // something a person can read.
        val payloads = listOf(
            printerPayload(),
            JSONObject(),
            JSONObject("""{"temps":{"nozzle":"NaN"},"layer":"x","progress":null}"""),
        )
        for (p in payloads) {
            for (r in telemetryReadings(p)) {
                assertTrue("empty value for ${r.label}", r.value.isNotEmpty())
                assertFalse("NaN leaked into ${r.label}", r.value.lowercase().contains("nan"))
                assertFalse("null leaked into ${r.label}", r.value.contains("null"))
            }
        }
    }

    @Test fun `a job with no progress yet shows its name alone`() {
        val queued = JSONObject("""{"subtask_name":"bracket.3mf","progress":0}""")
        assertEquals("bracket.3mf", telemetryReadings(queued).first { it.label == "job" }.value)
    }

    @Test fun `layer needs a total - 7 of unknown is not a reading`() {
        assertTrue(telemetryReadings(JSONObject("""{"layer":7}""")).isEmpty())
        assertTrue(telemetryReadings(JSONObject("""{"layer":7,"total_layers":0}""")).isEmpty())
    }

    // ── running ──────────────────────────────────────────────────────────────

    @Test fun `running is a state, not a guess`() {
        assertTrue(telemetryIsRunning(JSONObject("""{"gcode_state":"RUNNING"}""")))
        assertTrue(telemetryIsRunning(JSONObject("""{"gcode_state":"running"}""")))
        assertFalse(telemetryIsRunning(JSONObject("""{"gcode_state":"FINISH"}""")))
        assertFalse(telemetryIsRunning(JSONObject()))
        assertFalse(telemetryIsRunning(null))
    }

    // ── the three failures stay three ────────────────────────────────────────

    @Test fun `each failure gets its OWN words`() {
        // ⚠️ Collapsing these is how a busy printer gets reported as unplugged,
        // and how an expired credential sends someone out to check cables.
        val unauthorized = telemetryNote(unauthorized = true, timeout = false, unreachable = false)
        val timeout = telemetryNote(unauthorized = false, timeout = true, unreachable = false)
        val unreachable = telemetryNote(unauthorized = false, timeout = false, unreachable = true)
        val unknown = telemetryNote(unauthorized = false, timeout = false, unreachable = false)

        assertEquals(4, setOf(unauthorized, timeout, unreachable, unknown).size)
        assertTrue(unauthorized.lowercase().contains("re-enroll"))
        assertTrue(timeout.lowercase().contains("still working"))
        assertTrue(unreachable.lowercase().contains("not answering"))
    }

    @Test fun `a rejected credential outranks a timeout`() {
        // If the device both timed out and rejected us, the credential is the
        // actionable fact — waiting won't fix an expired token.
        assertEquals(
            telemetryNote(unauthorized = true, timeout = false, unreachable = false),
            telemetryNote(unauthorized = true, timeout = true, unreachable = true),
        )
    }

    @Test fun `the three clients say the same thing`() {
        // Exact web copy (app/devices/page.tsx) and iOS copy (EndpointPanel.swift).
        // A user moving between surfaces must not see three different diagnoses of
        // one printer.
        assertEquals("Credential rejected — re-enroll this device.", telemetryNote(true, false, false))
        assertEquals("Still working — no answer yet.", telemetryNote(false, true, false))
        assertEquals("Not answering right now.", telemetryNote(false, false, true))
        assertEquals("Telemetry unavailable.", telemetryNote(false, false, false))
    }

    // ── capabilities ─────────────────────────────────────────────────────────

    @Test fun `capabilities parse from the wire's JSON string`() {
        assertEquals(
            listOf("chat", "telemetry", "print", "cad"),
            parseCapabilities("""["chat","telemetry","print","cad"]"""),
        )
    }

    @Test fun `malformed capabilities mean none, never a crash`() {
        assertTrue(parseCapabilities(null).isEmpty())
        assertTrue(parseCapabilities("").isEmpty())
        assertTrue(parseCapabilities("not json").isEmpty())
        assertTrue(parseCapabilities("""{"a":1}""").isEmpty())
        // Mixed junk keeps the strings and drops the rest.
        assertEquals(listOf("print"), parseCapabilities("""["print",5,null]"""))
    }

    @Test fun `the LIVE printer gets a camera even though it never claims one`() {
        // ⚠️ This is the real device's capability list. Keying only on "camera"
        // would hide a chamber view that demonstrably works.
        assertTrue(endpointHasCamera(listOf("chat", "telemetry", "print", "cad")))
        assertTrue(endpointHasCamera(listOf("camera")))
        // A device claiming neither shows telemetry only, rather than a
        // permanently-failing image box.
        assertFalse(endpointHasCamera(listOf("chat", "telemetry")))
        assertFalse(endpointHasCamera(emptyList()))
    }

    // ── the camera's allowlist ───────────────────────────────────────────────

    @Test fun `only inert image types decode - svg is refused on purpose`() {
        // These bytes come from a machine nobody here controls, and this app HAS
        // coil-svg — so an SVG would actually render. SVG is the one image type
        // that can script, so it stays out even though the proxy refuses it too.
        assertEquals(listOf("image/jpeg", "image/png", "image/webp"), ENDPOINT_IMAGE_TYPES)
        assertFalse(ENDPOINT_IMAGE_TYPES.contains("image/svg+xml"))
        assertFalse(ENDPOINT_IMAGE_TYPES.contains("text/html"))
    }

    @Test fun `the frame cap matches the worker's`() {
        // A robot is not a trusted size; both layers stop at 8MB.
        assertEquals(8 * 1024 * 1024, ENDPOINT_IMAGE_MAX_BYTES)
    }

    // ── the row ──────────────────────────────────────────────────────────────

    @Test fun `only an endpoint device gets a live panel`() {
        // Every other row must cost nothing extra — most people have no robots.
        // `online = null` is what the wire really sends for an endpoint: it never
        // heartbeats, so the worker declines to guess (devices.ts:294).
        val printer = DeviceRow("d1", "3D printer", "endpoint", null, 0L, listOf("print"))
        val phone = DeviceRow("d2", "Pixel", "android", true, 1_784_808_000L)
        assertTrue(printer.isEndpoint)
        assertFalse(phone.isEndpoint)
        // The row that mounts this panel is also the only one whose presence is
        // unknowable, and it must not read as dead on the way in.
        assertEquals(DevicePresence.UNKNOWN, printer.presence)
        assertEquals(DevicePresence.ONLINE, phone.presence)
        // And a plain row defaults to no capabilities rather than null.
        assertTrue(phone.capabilities.isEmpty())
    }
}

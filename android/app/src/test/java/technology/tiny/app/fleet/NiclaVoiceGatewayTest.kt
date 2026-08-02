package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure halves of the Nicla Voice gateway (iOS NiclaVoiceGateway.swift
 * parity): the firmware's wake/status JSON contracts and the event line the
 * agent later reads. The BLE plumbing is exercised on-device; these pin the
 * parsing so a firmware or iOS change that shifts a key shows up on the JVM.
 */
class NiclaVoiceGatewayTest {

    // ---- beacon kind: the version byte doubles as a device-type marker ------

    @Test fun `version 1 is a Vision, version 2 is a Voice`() {
        assertEquals(Bluetooth.TinyBeaconInfo.Kind.VISION, Bluetooth.TinyBeaconInfo(1, true).kind)
        assertEquals(Bluetooth.TinyBeaconInfo.Kind.VOICE, Bluetooth.TinyBeaconInfo(2, false).kind)
        assertEquals(Bluetooth.TinyBeaconInfo.Kind.UNKNOWN, Bluetooth.TinyBeaconInfo(9, true).kind)
    }

    @Test fun `platform strings match what the boards enroll as`() {
        assertEquals("nicla-vision", Bluetooth.TinyBeaconInfo(1, true).platform)
        assertEquals("nicla-voice", Bluetooth.TinyBeaconInfo(2, true).platform)
        // Unknown defaults to vision (iOS Bluetooth.swift:48 does the same).
        assertEquals("nicla-vision", Bluetooth.TinyBeaconInfo(0, true).platform)
    }

    @Test fun `kind labels name the board for the Nearby row`() {
        assertEquals("Nicla Vision", Bluetooth.TinyBeaconInfo(1, true).kindLabel)
        assertEquals("Nicla Voice", Bluetooth.TinyBeaconInfo(2, true).kindLabel)
        assertEquals("tiny hardware", Bluetooth.TinyBeaconInfo(7, true).kindLabel)
    }

    // ---- wake notify {"wake":n,"label":...} ---------------------------------

    @Test fun `a wake notify parses label and count`() {
        val w = NiclaVoiceGateway.parseWake("""{"wake":3,"label":"alexa"}""".toByteArray(), 1000L)!!
        assertEquals("alexa", w.label)
        assertEquals(3, w.count)
        assertEquals(1000L, w.atMs)
    }

    @Test fun `a label-less wake stays legible as "wake"`() {
        val w = NiclaVoiceGateway.parseWake("""{"wake":1}""".toByteArray(), 0L)!!
        assertEquals("wake", w.label)
        val blank = NiclaVoiceGateway.parseWake("""{"wake":2,"label":"  "}""".toByteArray(), 0L)!!
        assertEquals("wake", blank.label)
    }

    @Test fun `garbage bytes never crash the notify path`() {
        assertNull(NiclaVoiceGateway.parseWake(byteArrayOf(0x00, 0x01), 0L))
        assertNull(NiclaVoiceGateway.parseWake("not json".toByteArray(), 0L))
    }

    @Test fun `the event detail matches iOS forward() verbatim`() {
        // iOS: "heard “\(wake.label)” (#\(wake.count))" — the agent-facing
        // string must be identical from both phones or the event ring reads
        // like two different devices.
        val w = VoiceWake("alexa", 7, 0L)
        assertEquals("heard “alexa” (#7)", NiclaVoiceGateway.wakeDetail(w))
    }

    // ---- status notify (short keys, 64-byte budget) --------------------------

    @Test fun `status parses the five short keys`() {
        val s = NiclaVoiceGateway.parseStatus("""{"ndp":1,"mic":1,"w":12,"l":2,"up":345}""".toByteArray())!!
        assertTrue(s.ndpUp)
        assertTrue(s.micOn)
        assertEquals(12, s.wakes)
        assertEquals(2, s.labels)
        assertEquals(345, s.uptimeS)
        assertTrue(s.listening)
    }

    @Test fun `listening demands BOTH the model loaded and the mic on`() {
        // A necklace whose model failed to load still advertises and still
        // looks online — it just never hears anything. That deafness must
        // be visible.
        assertFalse(NiclaVoiceGateway.parseStatus("""{"ndp":0,"mic":1}""".toByteArray())!!.listening)
        assertFalse(NiclaVoiceGateway.parseStatus("""{"ndp":1,"mic":0}""".toByteArray())!!.listening)
    }

    @Test fun `the proxy heartbeat claims only what the board has`() {
        // No camera, no tof, no wifi — an agent that sees `camera` on a Voice
        // calls a photo tool that can never succeed.
        assertEquals(listOf("mic", "wake", "imu", "ble"), NiclaVoiceGateway.CAPABILITIES)
    }
}

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

    // ---- the wake take: the phone records what the board cannot -------------

    @Test fun `a wake take is filed under the word that started it`() {
        // This is the line the user later reads in Transcripts explaining why
        // their phone turned its microphone on. iOS: "wake: \(wake.label)".
        assertEquals("wake: alexa", NiclaVoiceGateway.wakeTakeLabel(VoiceWake("alexa", 1, 0L)))
        // A label-less match is already defaulted by parseWake, so the take's
        // label degrades to something legible rather than "wake: ".
        val w = NiclaVoiceGateway.parseWake("""{"wake":1}""".toByteArray(), 0L)!!
        assertEquals("wake: wake", NiclaVoiceGateway.wakeTakeLabel(w))
    }

    @Test fun `the wake take label survives PhoneRecorder's own bounds`() {
        // handleWake passes this straight to record(), which trims and caps at 200
        // — so a hostile 400-char label from the board must not be able to make the
        // recorder's fallback ("web agent") kick in and lose the wake attribution.
        val long = NiclaVoiceGateway.wakeTakeLabel(VoiceWake("z".repeat(400), 1, 0L))
        assertEquals(long.take(200), PhoneRecorder.label(long))
        assertTrue(PhoneRecorder.label(long).startsWith("wake: "))
    }

    @Test fun `a wake asks for a floor short enough to be an accident`() {
        // 10s, iOS's number, and it is a FLOOR: the take extends while words keep
        // arriving (PhoneRecorder.shouldExtend). Long enough to be worth filing,
        // short enough that a wake word said by accident isn't a long recording of
        // a room — which is the whole reason it isn't simply MAX_SECONDS.
        assertEquals(10, NiclaVoiceGateway.WAKE_TAKE_SECONDS)
        assertTrue(
            "a wake take asking below the recorder's own minimum would be clamped up silently",
            NiclaVoiceGateway.WAKE_TAKE_SECONDS >= PhoneRecorder.MIN_SECONDS,
        )
        assertTrue(
            "a wake take that asks for the ceiling has nothing left to extend into",
            NiclaVoiceGateway.WAKE_TAKE_SECONDS < PhoneRecorder.MAX_SECONDS,
        )
        // The clamp must be a no-op on it: a floor that got rewritten on the way in
        // would make the panel's "at least Ns" label wrong.
        assertEquals(
            NiclaVoiceGateway.WAKE_TAKE_SECONDS,
            PhoneRecorder.clampSeconds(NiclaVoiceGateway.WAKE_TAKE_SECONDS),
        )
    }

    @Test fun `a wake take is the one path allowed to outrun its request`() {
        // Nobody is waiting on a budget for it — no relay poll, no agent counting
        // seconds — which is exactly why it may extend while the budgeted callers
        // (relay, manual, memo) may not.
        assertEquals(
            PhoneRecorder.MAX_SECONDS,
            PhoneRecorder.hardCapSeconds(NiclaVoiceGateway.WAKE_TAKE_SECONDS, true),
        )
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

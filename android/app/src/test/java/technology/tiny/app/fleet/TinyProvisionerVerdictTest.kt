package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The echo bug, replayed. ArduinoBLE notifies subscribers on a CENTRAL write as
 * well as a local one, so the board sends every chunk we wrote back at us BEFORE
 * it answers. This suite feeds [TinyProvisioner.verdictOf] the exact sequence
 * measured on wire (iOS commit f7b91c01) and asserts only the last frame counts.
 *
 * Regression shape: acting on the FIRST notify parsed our own truncated payload,
 * and this port made it worse than iOS's — a fragment that fails to parse hit the
 * `reply == null` branch and reported "device rejected the configuration" with a
 * perfectly healthy board on the desk.
 */
class TinyProvisionerVerdictTest {

    /** A 20-byte-chunked write of the config, exactly as the board echoes it. */
    private fun echoes(config: String): List<ByteArray> =
        (config + "\n").toByteArray().toList().chunked(20).map { it.toByteArray() }

    @Test
    fun `every echoed chunk of a real config is dropped`() {
        val config = """{"device_id":"echoguard-02","token":"tind_abc123","name":"tiny necklace"}"""
        val chunks = echoes(config)
        // Sanity: this really is a multi-chunk write, like the measured one.
        assert(chunks.size >= 4) { "expected a multi-chunk write, got ${chunks.size}" }
        chunks.forEachIndexed { i, chunk ->
            assertNull("chunk $i (${String(chunk)}) was treated as a verdict", TinyProvisioner.verdictOf(chunk))
        }
    }

    @Test
    fun `the verdict after the echoes is the one acted on`() {
        val chunks = echoes("""{"device_id":"echoguard-02","token":"tind_abc123"}""")
        chunks.forEach { assertNull(TinyProvisioner.verdictOf(it)) }
        val v = TinyProvisioner.verdictOf("""{"ok":true,"complete":true}""".toByteArray())
        assertEquals("done", v?.phase)
    }

    @Test
    fun `a chunk that happens to parse as JSON without ok is still not a verdict`() {
        // The trailing chunk of a small config can be valid JSON on its own only
        // by accident, but a board that ever notifies anything else must not be
        // mistaken for a rejection either.
        assertNull(TinyProvisioner.verdictOf("""{"name":"tiny necklace"}""".toByteArray()))
        assertNull(TinyProvisioner.verdictOf("""{"complete":true}""".toByteArray()))
        assertNull(TinyProvisioner.verdictOf(ByteArray(0)))
    }

    @Test
    fun `ok false is a rejection, and carries the board's reason`() {
        val v = TinyProvisioner.verdictOf("""{"ok":false,"error":"bad json"}""".toByteArray())
        assertEquals("failed:The device rejected the configuration (bad json).", v?.phase)
    }

    @Test
    fun `ok true without complete is incomplete, and names what's missing`() {
        val v = TinyProvisioner.verdictOf(
            """{"ok":true,"complete":false,"missing":["ssid","key"]}""".toByteArray(),
        )
        assertEquals("incomplete", v?.phase)
        assertEquals("Still missing: ssid, key.", v?.detail)
    }

    @Test
    fun `a complete verdict with nothing missing leaves the detail line empty`() {
        val v = TinyProvisioner.verdictOf("""{"ok":true,"complete":true,"missing":[]}""".toByteArray())
        assertEquals("done", v?.phase)
        assertNull(v?.detail)
    }
}

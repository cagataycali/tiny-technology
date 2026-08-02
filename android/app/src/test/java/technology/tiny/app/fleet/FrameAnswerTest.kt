package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The camera panel used to render every failure as the untouched "tap to peek"
 * placeholder — the same thing a user who had never tapped saw. Five distinct
 * failures wearing one blank face.
 *
 * These pin the two decisions that were unreachable while they lived inside the
 * polling loop (iOS 0c924248 / readFrameAnswer parity), plus the messages the
 * panel's UI rule depends on.
 */
class FrameAnswerTest {

    // ---- readFrameAnswer: an answer without an image is STILL an answer ----

    @Test
    fun `a payload with an image url is a frame`() {
        val a = TinyLive.readFrameAnswer("""{"images":[{"url":"https://r2.example/f.jpg"}]}""")
        assertEquals(FrameAnswer.ImageUrl("https://r2.example/f.jpg"), a)
    }

    @Test
    fun `a board saying it has no camera is reported, not swallowed`() {
        // The most useful failure of the five, and the one the old code
        // discarded most thoroughly: no `images` key meant a bare null, which
        // the panel showed as "no frame arrived".
        val a = TinyLive.readFrameAnswer("""{"result":"no camera on this device"}""")
        assertEquals(FrameAnswer.Words("no camera on this device"), a)
    }

    @Test
    fun `a bare JSON string payload is an answer, not a timeout`() {
        // Legal on this wire: the worker validates with JS JSON.parse, which
        // accepts a top-level string. JSONObject(payload) throws on it, so the
        // old code returned null and burned the whole 19s budget before
        // reporting a timeout for an answer that had already arrived.
        assertEquals(FrameAnswer.Words("camera busy"), TinyLive.readFrameAnswer("\"camera busy\""))
    }

    @Test
    fun `a payload that is not JSON at all still says what it said`() {
        assertEquals(FrameAnswer.Words("camera busy"), TinyLive.readFrameAnswer("camera busy"))
    }

    @Test
    fun `an images array we cannot open is prose, not a frame`() {
        // fetchBitmap can only open an http(s) href. A relative path or a
        // scheme-less string would otherwise be reported as a decode failure of
        // a frame that was never fetchable — iOS guards the same case with
        // `url.scheme != nil`, because URL(string:) accepts a bare path.
        for (bad in listOf("""{"images":[{"url":"/tmp/f.jpg"}]}""", """{"images":[{"url":""}]}""",
                           """{"images":[]}""", """{"images":[{}]}""")) {
            assertTrue("$bad should not be a frame", TinyLive.readFrameAnswer(bad) is FrameAnswer.Words)
        }
    }

    // ---- RelayReply.text: the sentence a person reads ----

    @Test
    fun `the reply text is unwrapped from whichever key carries it`() {
        assertEquals("done", RelayReply.text("""{"result":"done"}"""))
        assertEquals("hi", RelayReply.text("""{"text":"hi"}"""))
        assertEquals("out", RelayReply.text("""{"output":"out"}"""))
        assertEquals("boom", RelayReply.text("""{"error":"boom"}"""))
    }

    @Test
    fun `a bare string reply keeps its quotes off the screen`() {
        // Without JSONTokener the user reads `"done"` — quotes included.
        assertEquals("done", RelayReply.text("\"done\""))
    }

    @Test
    fun `an empty or blank value falls through to the next key`() {
        // `result` present but empty must not win over a real `error`.
        assertEquals("boom", RelayReply.text("""{"result":"","error":"boom"}"""))
        assertEquals("boom", RelayReply.text("""{"result":"   ","error":"boom"}"""))
    }

    @Test
    fun `a payload with no useful key is returned as-is rather than blanked`() {
        val odd = """{"nothing":"useful"}"""
        assertEquals(odd, RelayReply.text(odd))
    }

    // ---- FrameFailure messages: the panel's UI rule rests on these ----

    @Test
    fun `every failure but cancelled has something to say`() {
        val cases = listOf(
            FrameFailure.RelayRefused("Couldn't reach the relay."),
            FrameFailure.NoReply(19),
            FrameFailure.DeviceSaid("camera busy"),
            FrameFailure.Undecodable,
        )
        cases.forEach { assertTrue("${it::class.simpleName} says nothing", it.message.isNotEmpty()) }
        // Cancelled is the view going away, not a fault — it must render nothing
        // at all, which is why the panel treats an empty message as no error.
        assertEquals("", FrameFailure.Cancelled.message)
    }

    @Test
    fun `the messages the board and server write are whole sentences`() {
        // This is the PREMISE of the panel's layout fix: the reason cannot be
        // chained onto "· tap to retry", because `·` is this app's separator for
        // terminator-free fragments and these end in a full stop. If a message
        // ever loses its period the separator becomes defensible again — so the
        // premise is pinned, not assumed.
        assertTrue(FrameFailure.Undecodable.message.endsWith("."))
        assertTrue(FrameFailure.RelayRefused("Couldn't reach the relay.").message.endsWith("."))
        // And deviceSaid has NO punctuation to strip — the board's own words —
        // which is why no client-side "strip the terminator" fix could be right.
        assertEquals("camera busy", FrameFailure.DeviceSaid("camera busy").message)
    }

    @Test
    fun `the timeout says how long it waited, in seconds`() {
        assertEquals("No frame in 19s — is the camera awake?", FrameFailure.NoReply(19).message)
    }
}

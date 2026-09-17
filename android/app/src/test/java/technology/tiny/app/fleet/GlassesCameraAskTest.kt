package technology.tiny.app.fleet

import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🕶️🔐 The glasses-camera ASK — the deadline, the race, and the wording.
 *
 * Android's DAT 0.8.0 has no `requestPermission` on the core object at all
 * (measured with javap): the grant is an ActivityResultContract, so before this
 * the three capture rails could only CHECK and every ungranted ask died on
 * "grant it in settings → meta glasses" — a button on a phone the user wasn't
 * holding, for a photo they'd just asked for out loud.
 *
 * The Activity can't start in a JVM test, so the launch is handed to
 * `GlassesCameraAsk.await` — leaving exactly the parts worth pinning.
 */
class GlassesCameraAskTest {

    @Test fun `an answer inside the window is the answer`() = runBlocking<Unit> {
        val scope = this
        val outcome = GlassesCameraAsk.await(5_000) {
            scope.launch {
                delay(40)
                GlassesCameraAsk.deliver(CameraAsk.Granted)
            }
        }
        assertEquals(CameraAsk.Granted, outcome)
    }

    @Test fun `an unanswered prompt times out instead of reading as a refusal`() = runBlocking<Unit> {
        // ⚠️ The distinction the whole file exists for: the prompt lives in the
        // Meta AI app, so "not answered yet" is the COMMON ending — a phone in a
        // pocket. Calling that a denial tells the user they said no.
        assertEquals(CameraAsk.TimedOut, GlassesCameraAsk.await(120) { })
    }

    @Test fun `a late answer is not handed to the next ask`() = runBlocking<Unit> {
        assertEquals(CameraAsk.TimedOut, GlassesCameraAsk.await(120) { })
        // The timed-out prompt is still standing in the Meta AI app; the user
        // answers it a minute later, long after this rail gave up.
        GlassesCameraAsk.deliver(CameraAsk.Granted)
        // That answer belonged to the ask that expired. If a standing slot were
        // ever reused, this ask would report a grant for a prompt it never
        // raised — and then open a session the user never consented to now.
        // Pinned as the PROPERTY, not the mechanism: two lines enforce it
        // together (each ask installs its own slot; the asker clears it), and
        // mutating either one alone leaves the behaviour correct.
        assertEquals(CameraAsk.TimedOut, GlassesCameraAsk.await(120) { })
    }

    @Test fun `a launch that fails says so instead of inventing a refusal`() = runBlocking<Unit> {
        val outcome = GlassesCameraAsk.await(5_000) { throw IllegalStateException("no activity") }
        assertTrue(outcome.toString(), outcome is CameraAsk.Unavailable)
        assertEquals("no activity", (outcome as CameraAsk.Unavailable).reason)
    }

    @Test fun `only a grant clears the rail`() {
        assertNull(GlassesCameraAsk.refusal(CameraAsk.Granted))
        for (blocked in listOf(
            CameraAsk.NotGranted,
            CameraAsk.TimedOut,
            CameraAsk.Unavailable("Meta AI app not installed"),
        )) {
            assertNotNull(blocked.toString(), GlassesCameraAsk.refusal(blocked))
        }
    }

    @Test fun `a refusal never claims the user said no`() {
        // ⚠️⚠️ MEASURED: RequestPermissionContract.parseResult answers
        // success(Denied) for EVERYTHING that isn't a grant — a null intent, a
        // RESULT_CANCELED, a missing extra. Declined, backed out and dismissed
        // are one value, so no wording may pick one. Same invariant
        // lib/chat/tools/platform.ts holds for `screenshot`: "Do NOT tell the
        // user they ignored a prompt."
        val forbidden = listOf("declined", "denied", "refused", "ignored", "dismissed", "said no")
        for (outcome in listOf(
            CameraAsk.NotGranted,
            CameraAsk.TimedOut,
            CameraAsk.Unavailable("Meta AI app not installed"),
        )) {
            val text = GlassesCameraAsk.refusal(outcome)!!.lowercase()
            for (word in forbidden) {
                // "may have been declined" is the one allowed shape — it hedges.
                val asserted = text.contains(word) && !text.contains("may have been $word")
                assertTrue("$outcome asserts '$word': $text", !asserted)
            }
        }
        // …and each ending still says which one it was, or the user can't act.
        assertTrue(GlassesCameraAsk.refusal(CameraAsk.TimedOut)!!.contains("unanswered"))
        assertTrue(GlassesCameraAsk.refusal(CameraAsk.Unavailable("boom"))!!.contains("boom"))
    }

    @Test fun `the window leaves room for the capture that follows it`() {
        // meta_take_photo polls 45 × 2s = 90s server-side, and the capture —
        // session walk (up to ACTIVE_DEVICE_WAIT + retry), stream up, shutter,
        // JPEG, upload — has to fit AFTER the grant. An unbounded wait (iOS's
        // shape) would spend the whole poll on a finger and time out with
        // nothing to tell the user.
        val serverPollMs = 45 * 2_000L
        val sessionWalkMs = WearablesBridge.ACTIVE_DEVICE_WAIT_MS +
            WearablesBridge.SESSION_RETRY_DELAY_MS +
            WearablesBridge.SESSION_START_TIMEOUT_MS
        assertTrue(
            "the ask window plus the session walk overruns the server's poll",
            GlassesCameraAsk.ASK_WINDOW_MS + sessionWalkMs < serverPollMs,
        )
    }
}

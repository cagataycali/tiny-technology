package technology.tiny.app.fleet

import com.meta.wearable.dat.core.types.DeviceSessionError
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🕶️ The walk up to a glasses session — the two decisions inside
 * `WearablesBridge.openSession` that have a deadline or a branch in them.
 *
 * The bug this covers: all three capture rails (photo, video, live HUD) handed
 * `Wearables.createSession` a freshly constructed `AutoDeviceSelector()`. DAT
 * 0.8.0 builds a selector's state with `stateIn(…, Eagerly, null)` — initial
 * value null, filled in later off an IO dispatcher — and `createSession`
 * answers NO_ELIGIBLE_DEVICE the instant `activeDevice()` is null. So every
 * capture failed by construction, while the status payload beside it read the
 * long-lived selector and said "ready".
 *
 * The selector itself cannot be built without `Wearables.initialize`, so the
 * wait takes its two readings as arguments and is pinned here on those.
 */
class WearablesSessionTest {

    @Test fun `a device already known is not waited for`() = runBlocking<Unit> {
        val never = MutableStateFlow<Any?>(null)
        val startedAt = System.nanoTime()
        assertTrue(WearablesBridge.awaitActive({ "device" }, never, 5_000))
        // The whole point of the long-lived selector: it usually already knows.
        // Spending the budget anyway would put 15s in front of every photo.
        assertTrue(
            "the budget was spent on a device we already had",
            System.nanoTime() - startedAt < 1_000_000_000L,
        )
    }

    @Test fun `a device that arrives late still opens the door`() = runBlocking<Unit> {
        // The observer's first value comes in off an IO dispatcher; a selector
        // read the microsecond after initialize() is null and means nothing.
        val active = MutableStateFlow<Any?>(null)
        launch {
            delay(80)
            active.value = "device"
        }
        assertTrue(WearablesBridge.awaitActive({ active.value }, active, 5_000))
    }

    @Test fun `a selector that never resolves fails inside its budget, not forever`() = runBlocking<Unit> {
        val never = MutableStateFlow<Any?>(null)
        assertFalse(WearablesBridge.awaitActive({ null }, never, 150))
    }

    @Test fun `only NO_ELIGIBLE_DEVICE is worth a second attempt`() {
        // Retrying is for the link still settling. The rest are answers: a
        // second attempt two seconds later returns the same thermal shutdown,
        // and swallowing its description leaves the user with "not reachable"
        // when the truth was "the glasses are too hot".
        assertTrue(WearablesBridge.retryableSessionError(DeviceSessionError.NO_ELIGIBLE_DEVICE))
        for (other in listOf(
            DeviceSessionError.THERMAL_CRITICAL,
            DeviceSessionError.CAPABILITY_DENIED,
            DeviceSessionError.DEVICE_POWERED_OFF,
            DeviceSessionError.SESSION_ALREADY_EXISTS,
            DeviceSessionError.NOT_INITIALIZED,
        )) {
            assertFalse(other.name, WearablesBridge.retryableSessionError(other))
        }
    }

    // ── SESSION_ALREADY_EXISTS: name the holder ─────────────────────────────
    //
    // The glasses have ONE camera session (measured in DAT 0.8.0's
    // WearablesImpl.createSession: a per-device `sessions` map, any state but
    // STOPPED answers SESSION_ALREADY_EXISTS), and no public way to take over
    // the one that is open. So the ask is genuinely dead until the holder lets
    // go — and letting go is something the USER does. The SDK's sentence, "A
    // session already exists for this device", names neither the holder nor
    // the remedy, and the app knew both all along.

    @Test fun `the live feed holding the camera says so, and says how to get it back`() {
        val msg = WearablesBridge.cameraBusyMessage(liveOpen = true, recording = false)
        assertTrue("does not name the live feed: $msg", msg.contains("live"))
        assertTrue("does not say what to do: $msg", msg.contains("close the live card"))
        // The failure mode this replaces: an ask for a photo of what the user is
        // looking at, made while they watch the feed, answered with SDK vocabulary.
        assertFalse(msg.lowercase().contains("session already exists"))
    }

    @Test fun `a recording in progress is not blamed on the live feed`() {
        val msg = WearablesBridge.cameraBusyMessage(liveOpen = false, recording = true)
        assertTrue("does not name the recording: $msg", msg.contains("recording"))
        assertTrue("does not say to wait it out: $msg", msg.contains("finish"))
        // Telling someone to close a live card that isn't open is a dead end
        // with extra steps.
        assertFalse("blamed the live card: $msg", msg.contains("live card"))
    }

    @Test fun `a holder we do not own still gets an honest, ending answer`() {
        // A photo asked for twice in quick succession (use_device is
        // fire-and-forget now, so this is ordinary): the first ask holds the
        // session while it walks up to STARTED — up to 25s — and neither of our
        // own flags is set. It clears itself, so "ask again" is the truth.
        val msg = WearablesBridge.cameraBusyMessage(liveOpen = false, recording = false)
        assertTrue("does not say it will pass: $msg", msg.contains("few seconds"))
        assertTrue("does not say to retry: $msg", msg.contains("ask again"))
    }

    @Test fun `every holder gets a remedy, and none leaks SDK vocabulary`() {
        // Stated as a property over all four combinations, so a fourth branch
        // added later cannot answer with a bare description or a shrug.
        for (liveOpen in listOf(true, false)) {
            for (recording in listOf(true, false)) {
                val msg = WearablesBridge.cameraBusyMessage(liveOpen, recording)
                val where = "liveOpen=$liveOpen recording=$recording: $msg"
                assertTrue("no remedy in $where", msg.contains("ask again"))
                assertTrue("does not mention the glasses in $where", msg.contains("glasses"))
                assertFalse("SDK vocabulary in $where", msg.contains("session"))
                assertTrue("too terse to act on in $where", msg.length > 60)
            }
        }
    }
}

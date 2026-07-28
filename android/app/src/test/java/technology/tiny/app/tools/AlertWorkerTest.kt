package technology.tiny.app.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AlertWorker.notificationId — the stable, UUID-derived id for a scheduled-alert
 * banner. The old id was `System.currentTimeMillis() % Int.MAX_VALUE`, which
 * collided for two alerts firing the same millisecond (one banner silently
 * replaced the other) and was unrecoverable. Pinning the derivation locks: same
 * input → same id (reproducible from AlertRecord.id, so a per-alert cancel can
 * target it), distinct inputs → distinct ids, always non-negative (Int.MIN_VALUE
 * hashCode must not survive as a negative id), and a blank id → the 0 fallback.
 * The WorkManager request UUID string stored as AlertRecord.id feeds this. Pure.
 */
class AlertWorkerTest {

    @Test fun `same work id always maps to the same notification id`() {
        val uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        assertEquals(AlertWorker.notificationId(uuid), AlertWorker.notificationId(uuid))
    }

    @Test fun `distinct work ids map to distinct notification ids`() {
        val a = AlertWorker.notificationId("3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        val b = AlertWorker.notificationId("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
        assertNotEquals(a, b)
    }

    @Test fun `the id is always non-negative, even for a hashCode of Int MIN_VALUE`() {
        // "polygenelubricants" is the canonical String whose hashCode is exactly
        // Int.MIN_VALUE — abs() of it overflows back to negative, so a naive abs()
        // would yield a negative notification id. The AND-mask must keep it positive.
        assertEquals(Int.MIN_VALUE, "polygenelubricants".hashCode())
        assertTrue(AlertWorker.notificationId("polygenelubricants") >= 0)
    }

    @Test fun `a blank id degrades to the zero fallback bucket`() {
        assertEquals(0, AlertWorker.notificationId(""))
    }
}

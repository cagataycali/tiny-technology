package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Attachments.clampPicks — the multi-select cap decision behind the photo picker
 * callback (MainActivity). The system PickMultipleVisualMedia cap is the TOTAL, blind
 * to what's already pending, so a pick can overshoot the free slots; clampPicks folds
 * `free = MAX − pending; take(free)` + the overflow flag into one tested unit instead
 * of leaving the arithmetic inline. iOS pins the equivalent capacity walk in
 * AttachmentCodec.routeDrop (TinyTests routeDrop cases); this is the Android twin so
 * the two clients agree on how many photos a picker trip accepts and when the "up to
 * MAX attachments" message fires. MAX = 4.
 */
class ClampPicksTest {

    @Test fun `an empty composer takes the whole pick up to the cap`() {
        val r = Attachments.clampPicks(pendingCount = 0, pickedCount = 3)
        assertEquals(3, r.accept)
        assertFalse(r.overflowed)
        assertFalse(r.full)
    }

    @Test fun `exactly filling the cap is not an overflow`() {
        // 0 pending + 4 picked = the cap exactly — every pick fits, no message.
        val r = Attachments.clampPicks(pendingCount = 0, pickedCount = 4)
        assertEquals(4, r.accept)
        assertFalse("filling to the cap must not read as overflow", r.overflowed)
    }

    @Test fun `an overshooting pick is trimmed to the free slots and flags overflow`() {
        // 2 already pending, 4 picked → only 2 fit, 2 dropped → show the cap message.
        val r = Attachments.clampPicks(pendingCount = 2, pickedCount = 4)
        assertEquals(2, r.accept)
        assertTrue(r.overflowed)
        assertFalse(r.full)
    }

    @Test fun `a full composer accepts nothing and is flagged full plus overflowed`() {
        // Already at MAX → no free slots; the caller shows the message and ingests none.
        val r = Attachments.clampPicks(pendingCount = 4, pickedCount = 2)
        assertEquals(0, r.accept)
        assertTrue(r.full)
        assertTrue(r.overflowed)
    }

    @Test fun `an over-full composer never yields a negative accept`() {
        // pending somehow exceeds MAX (docs + images racing) → free floors at 0, not -1.
        val r = Attachments.clampPicks(pendingCount = 6, pickedCount = 1)
        assertEquals(0, r.accept)
        assertTrue(r.full)
        assertTrue(r.overflowed)
    }

    @Test fun `an empty pick against a full composer is not an overflow`() {
        // Nothing was dropped, so there's nothing to warn about even at the cap.
        val r = Attachments.clampPicks(pendingCount = 4, pickedCount = 0)
        assertEquals(0, r.accept)
        assertTrue(r.full)
        assertFalse("an empty pick can't overflow", r.overflowed)
    }

    @Test fun `pending counts docs and images together against the shared cap`() {
        // The cap is TOTAL attachments (images + docs), so 3 mixed pending leaves 1 slot.
        val r = Attachments.clampPicks(pendingCount = 3, pickedCount = 2)
        assertEquals(1, r.accept)
        assertTrue(r.overflowed)
    }

    @Test fun `an injected max lets the rule scale without touching MAX`() {
        val r = Attachments.clampPicks(pendingCount = 1, pickedCount = 5, max = 2)
        assertEquals(1, r.accept)
        assertTrue(r.overflowed)
    }
}

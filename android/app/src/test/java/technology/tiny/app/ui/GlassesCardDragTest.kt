package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.roundToInt

/**
 * 🖐️ The glasses live card's DRAG limits — iOS `GlassesLiveOverlay` has the
 * gesture (`DragGesture` onto a persisted `restingOffset`); Android's card was
 * pinned in the top-end corner.
 *
 * Why it is not cosmetic: the card is 236dp wide on a ~411dp phone, parked over
 * the chat, and its presence IS the stream's lifetime (`DisposableEffect` →
 * `GlassesLive.start`/`stop`). Immovable, "let me read what's under it" cost the
 * user the live view, and re-opening walks the whole session budget again. So
 * uncovering the chat and keeping the stream were mutually exclusive.
 *
 * Compose layout can't be driven from a plain JVM test, so the seam is the
 * clamp — the part with the arithmetic and the crash in it.
 */
class GlassesCardDragTest {

    // A Pixel-ish box in px, and the card at 236x211dp on a 2.75x screen.
    private val boxW = 1080f
    private val boxH = 2000f
    private val cardW = 650f
    private val cardH = 580f

    private fun clamp(x: Float, y: Float) = clampToBox(x, y, cardW, cardH, boxW, boxH)

    @Test fun `dragging left uncovers the chat, which is the whole point`() {
        assertEquals(-300f to 0f, clamp(-300f, 0f))
        assertEquals(-120f to 400f, clamp(-120f, 400f))
    }

    @Test fun `it cannot be dragged out past the corner it starts in`() {
        // x is 0 at the top-END corner, so positive x and negative y both leave.
        assertEquals(0f to 0f, clamp(600f, -600f))
    }

    @Test fun `no edge may cross the box it roams`() {
        val (x, y) = clamp(-99_999f, 99_999f)
        assertEquals(-(boxW - cardW), x)
        assertEquals(boxH - cardH, y)
        // Stated as the property too: every corner still inside the box.
        assertTrue("left edge left the box", boxW + x - cardW >= 0f)
        assertTrue("bottom edge left the box", y + cardH <= boxH)
    }

    @Test fun `a card too big for its box does not crash, it just does not travel`() {
        // ⚠️ THE REASON THE RANGES ARE BUILT WITH maxOf: coerceIn(min, max) THROWS
        // when min > max, so `x.coerceIn(boxW - cardW, 0f)` would take down the
        // whole chat screen on the first drag of a card that doesn't fit — a
        // landscape phone, a freeform window, a foldable's cover display.
        // Compared with a delta, and at the rounded px the `offset` modifier
        // actually consumes: a zero-width travel is NEGATED into `-0.0f`, which is
        // == 0f but not `equals` 0f. It parks the card in the corner either way —
        // `(-0.0f).roundToInt()` is 0 — so the property is "does not travel",
        // never the sign bit that carries it.
        for (case in listOf(
            Triple("wider and taller than its box", 1200f to 2400f, 1080f to 2000f),
            Triple("exactly its box", 1080f to 2000f, 1080f to 2000f),
            // A zero-size box: the first frame, before layout has measured anything.
            Triple("a box not measured yet", 236f to 211f, 0f to 0f),
        )) {
            val (what, cardSize, boxSize) = case
            val (x, y) = clampToBox(-50f, 50f, cardSize.first, cardSize.second, boxSize.first, boxSize.second)
            assertEquals("x travelled with a card $what", 0f, x, 0f)
            assertEquals("y travelled with a card $what", 0f, y, 0f)
            assertEquals("the rendered x is not the corner with a card $what", 0, x.roundToInt())
            assertEquals("the rendered y is not the corner with a card $what", 0, y.roundToInt())
        }
    }

    @Test fun `accumulated deltas land where a finger would leave it`() {
        // detectDragGestures reports increments; the card adds them up, so a
        // drag that overshoots then comes back must not stick at the wall.
        var x = 0f
        var y = 0f
        for (delta in listOf(-200f, -200f, -200f, -200f, 150f)) {
            val next = clampToBox(x + delta, y + delta, cardW, cardH, boxW, boxH)
            x = next.first
            y = next.second
        }
        // 5 x deltas sum to -650, past the -430 wall, then +150 off the wall.
        assertEquals(-(boxW - cardW) + 150f, x)
        assertTrue("y should have travelled down and back up: $y", y > 0f && y < boxH - cardH)
    }
}

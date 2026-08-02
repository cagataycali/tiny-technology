package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🎗️ The capability strip stops outweighing the device's name.
 *
 * A laptop daemon declares twelve capabilities — `npx tiny-tech mesh` sends one per
 * resolved device tool — and the row drew all twelve, wrapping to several lines of
 * grey words under a one-line name. The row exists to answer "which device is this"
 * and "can I reach it", and the answer to neither was the biggest thing in it.
 *
 * [CapabilityRibbon] is the rule. It is a pure object on purpose: the strip lives
 * inside a `@Composable` LazyColumn item that no JVM unit test can run, so the whole
 * decision — how many survive, how many are claimed hidden, what TalkBack hears
 * instead — is pulled out where it can be tested without a device. What this file
 * CANNOT see is whether the view asks; tests/nicla-android-parity.test.ts pins that
 * (a cap nothing calls leaves the wall on screen with a green suite either side).
 */
class CapabilityRibbonTest {

    /** A laptop daemon's real strip — the row that wrapped to five lines. */
    private val laptop = sortCapabilities(
        listOf(
            "chat", "location", "ble", "screenshot", "clipboard", "open_app",
            "image_gen", "speak", "record_audio", "shell", "windows", "mouse",
        ),
    )

    // ── the cut ──────────────────────────────────────────────────────────────

    @Test fun `a laptop shows four words, not twelve`() {
        val r = CapabilityRibbon.split(laptop, expanded = false)
        assertEquals(4, r.shown.size)
        assertEquals(8, r.hidden.size)
        // And the two halves are the WHOLE list, in order — a cut that dropped or
        // duplicated one would still satisfy the counts above.
        assertEquals(laptop, r.shown + r.hidden)
    }

    @Test fun `the cap does not fire where it would buy nothing`() {
        // "+1 more" is a word that hides a word: it occupies the line space it
        // saves. So at cap+1 the cap costs a tap and buys nothing, and the row is
        // the same height either way. `> cap` instead of `> cap + 1` is the whole
        // defect this pins.
        val five = listOf("a", "b", "c", "d", "e")
        assertEquals(five, CapabilityRibbon.split(five, expanded = false).shown)
        assertTrue(CapabilityRibbon.split(five, expanded = false).hidden.isEmpty())
        assertNull("a five-word strip offered a control", CapabilityRibbon.toggleLabel(five, false))

        // Six is the first size where hiding two beats drawing one control.
        val six = five + "f"
        assertEquals(4, CapabilityRibbon.split(six, expanded = false).shown.size)
        assertEquals("+2 more", CapabilityRibbon.toggleLabel(six, false))
    }

    @Test fun `a short strip is never cut at all`() {
        for (n in 0..CapabilityRibbon.cap + 1) {
            val caps = (1..n).map { "cap$it" }
            val r = CapabilityRibbon.split(caps, expanded = false)
            assertEquals("$n words were cut", caps, r.shown)
            assertTrue("$n words claimed something hidden", r.hidden.isEmpty())
            assertNull("$n words offered a control", CapabilityRibbon.toggleLabel(caps, false))
        }
    }

    @Test fun `expanding shows every word`() {
        val r = CapabilityRibbon.split(laptop, expanded = true)
        assertEquals(laptop, r.shown)
        // Nothing is hidden while open — a control that read "+8 more" on an open
        // ribbon would be claiming words that are on screen.
        assertTrue(r.hidden.isEmpty())
    }

    // ── the control ──────────────────────────────────────────────────────────

    @Test fun `the number claimed is the number actually hidden`() {
        // A silently truncated strip is worse than a long one: nothing on screen
        // would say the device can do anything else. So the count comes from the
        // same cut, and cannot disagree with it.
        for (n in 0..20) {
            val caps = (1..n).map { "cap$it" }
            val hidden = CapabilityRibbon.split(caps, expanded = false).hidden.size
            val label = CapabilityRibbon.toggleLabel(caps, expanded = false)
            if (hidden == 0) assertNull("$n words offered a control", label)
            else assertEquals("+$hidden more", label)
        }
    }

    @Test fun `an open ribbon still offers a way back`() {
        // The subtle half: toggleLabel asks split with expanded = false ALWAYS,
        // because an open ribbon hides nothing and would otherwise return null —
        // the control vanishing on exactly the rows that need closing.
        assertEquals("show fewer", CapabilityRibbon.toggleLabel(laptop, expanded = true))
        // But a row with nothing to collapse gets no control in either state.
        assertNull(CapabilityRibbon.toggleLabel(listOf("chat"), expanded = true))
    }

    @Test fun `the two states are not the same string`() {
        assertFalse(
            "collapsed and expanded read alike",
            CapabilityRibbon.toggleLabel(laptop, false) == CapabilityRibbon.toggleLabel(laptop, true),
        )
    }

    // ── the spoken row ───────────────────────────────────────────────────────

    @Test fun `TalkBack hears the words the strip stopped drawing`() {
        // The cap is a WIDTH problem and a spoken row has no width. Compose gives
        // each capability its own semantics node — there is no `.combine` merge
        // like iOS's — so if this said "+8 more" out loud, capping the strip would
        // have deleted eight capabilities from the accessible row.
        val spoken = CapabilityRibbon.toggleDescription(laptop, expanded = false)!!
        val hidden = CapabilityRibbon.split(laptop, expanded = false).hidden
        assertTrue("the control speaks a count: $spoken", spoken.startsWith("can also "))
        for (c in hidden) {
            assertTrue(
                "'${capabilityLabel(c)}' is neither drawn nor spoken: $spoken",
                spoken.contains(capabilityLabel(c)),
            )
        }
        // Every capability of the device is now either drawn or spoken.
        val drawn = CapabilityRibbon.split(laptop, expanded = false).shown.map { capabilityLabel(it) }
        for (c in laptop) {
            val label = capabilityLabel(c)
            assertTrue("'$label' vanished entirely", label in drawn || spoken.contains(label))
        }
    }

    @Test fun `the spoken words are LABELS, not wire tokens`() {
        // The same rule the strip itself follows: TalkBack read "bluetooth
        // underscore scan" here once already, on the surface where a spoken
        // identifier is least recoverable.
        val spoken = CapabilityRibbon.toggleDescription(laptop, expanded = false)!!
        assertFalse("a wire token is spoken: $spoken", spoken.contains("_"))
        assertFalse("a wire token is spoken: $spoken", spoken.contains("image_gen"))
    }

    @Test fun `it never speaks a capability the strip is still showing`() {
        // Sourced from the same cut, so this holds by construction — pinned because
        // recomputing it from the full list is the natural mistake, and it would
        // make TalkBack read four capabilities twice.
        val spoken = CapabilityRibbon.toggleDescription(laptop, expanded = false)!!
        for (c in CapabilityRibbon.split(laptop, expanded = false).shown) {
            assertFalse(
                "'${capabilityLabel(c)}' is both drawn and re-spoken: $spoken",
                spoken.contains(capabilityLabel(c)),
            )
        }
    }

    @Test fun `a row with nothing hidden says nothing extra`() {
        assertNull(CapabilityRibbon.toggleDescription(listOf("chat", "ble"), expanded = false))
        assertEquals("show fewer", CapabilityRibbon.toggleDescription(laptop, expanded = true))
    }

    @Test fun `the action is a different sentence from the content`() {
        // TalkBack speaks onClickLabel as "double tap to <label>" and
        // contentDescription as the element's text. Putting the capability list in
        // the action slot would announce "double tap to can also speaks, shell".
        assertEquals("show all capabilities", CapabilityRibbon.toggleAction(expanded = false))
        assertEquals("show fewer capabilities", CapabilityRibbon.toggleAction(expanded = true))
        for (e in listOf(true, false)) {
            assertFalse(
                "the action slot enumerates capabilities",
                CapabilityRibbon.toggleAction(e).contains("can also"),
            )
        }
    }

    // ── the rule itself ──────────────────────────────────────────────────────

    @Test fun `the cap is one number, so the strip and the count cannot drift`() {
        assertEquals(4, CapabilityRibbon.cap)
        // Read through the constant rather than hardcoded: the point is that the
        // shown size tracks it, not that it happens to be four today.
        val many = (1..30).map { "cap$it" }
        assertEquals(CapabilityRibbon.cap, CapabilityRibbon.split(many, false).shown.size)
        assertEquals(30 - CapabilityRibbon.cap, CapabilityRibbon.split(many, false).hidden.size)
    }

    @Test fun `what survives is the strip's own order, not a reshuffle`() {
        // ⚠️ Admitted bias, pinned so it stays admitted: the survivors are the
        // ALPHABETICAL prefix of sortCapabilities, not a ranking. A cap that sorted
        // differently would order the row by a field nobody is shown.
        val phone = sortCapabilities(listOf("speak", "chat", "glasses", "ble", "location", "image_gen"))
        val shown = CapabilityRibbon.split(phone, expanded = false).shown
        assertEquals(phone.take(4), shown)
        assertEquals(listOf("bluetooth", "chat", "glasses", "location"), shown.map { capabilityLabel(it) })
    }
}

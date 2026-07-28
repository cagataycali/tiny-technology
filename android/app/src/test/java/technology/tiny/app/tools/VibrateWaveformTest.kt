package technology.tiny.app.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * vibrateWaveform — the pure (pattern, times, intensity) → (timings, amplitudes)
 * builder behind the agent's `vibrate` device tool (iOS Haptic.events parity).
 * The impure vibrator.vibrate() stays in DeviceTools; this pins the arithmetic
 * that shipped untested despite carrying THREE cycle-hardened regressions:
 *   1. heartbeat's block is ODD-length (5), so amplitude keyed off the GLOBAL
 *      flattened index inverted the second rep's phase — it must key off the
 *      LOCAL block index (even = wait/0, odd = pulse/amp).
 *   2. escalate/wave carry a per-pulse intensity CURVE (iOS s*(0.25+0.5t) ramp /
 *      s*|sin(t/2·π)| swell), NOT a flat amplitude — the whole motif was lost.
 *   3. a curve pulse's amplitude is floored at 1 so it never collapses to 0
 *      (which the waveform would read as a silent wait).
 * Even indices are WAITS (amp 0); odd indices are PULSES.
 */
class VibrateWaveformTest {

    @Test fun `a single tap is a lead wait then one pulse at full amplitude`() {
        // "tap" (the default) = [0ms wait, 50ms pulse]; intensity 1.0 → amp 255.
        val (t, a) = vibrateWaveform("tap", times = 1, intensity = 1.0)
        assertTrue(t.toList() == listOf(0L, 50L))
        assertTrue(a.toList() == listOf(0, 255))
    }

    @Test fun `even indices are always waits — amplitude zero`() {
        // The wait/pulse lockstep: every even index must be silent regardless of pattern.
        for (pattern in listOf("double", "success", "warning", "error", "heartbeat", "sos", "long", "escalate", "wave")) {
            val (_, a) = vibrateWaveform(pattern, times = 1, intensity = 1.0)
            a.forEachIndexed { i, amp ->
                if (i % 2 == 0) assertEquals("$pattern index $i must be a wait", 0, amp)
            }
        }
    }

    @Test fun `intensity scales the constant-pattern amplitude and floors at 1`() {
        // amp = (intensity*255).coerceIn(1,255). Half strength → 127; a near-zero
        // intensity floors to 1 (never 0, which would read as a silent wait).
        assertEquals(127, vibrateWaveform("tap", 1, 0.5).second[1])
        assertEquals(1, vibrateWaveform("tap", 1, 0.001).second[1])
        assertEquals(255, vibrateWaveform("tap", 1, 1.0).second[1])
    }

    // ── regression 1: heartbeat odd-length block phase alignment across reps ──

    @Test fun `heartbeat keeps wait-pulse phase on the SECOND rep despite an odd-length block`() {
        // heartbeat = [0,60,120,90,500] (length 5, ODD). With times=2, a global-index
        // amplitude would invert the second block (buzz the gaps, silence the pulses).
        // Correct: each rep's LOCAL even index is a wait, odd index a pulse.
        val (t, a) = vibrateWaveform("heartbeat", times = 2, intensity = 1.0)
        // First rep: [0(wait), 60(pulse), 120(wait), 90(pulse), 500(wait)].
        assertEquals(listOf(0L, 60L, 120L, 90L, 500L), t.toList().subList(0, 5))
        assertEquals(listOf(0, 255, 0, 255, 0), a.toList().subList(0, 5))
        // Second rep leads with the 240ms inter-rep gap (a wait, amp 0) in place of
        // the block's own 0ms lead wait, then the block's amplitudes REPEAT identically
        // — [0,255,0,255,0] again, phase NOT inverted. (The buggy global-index version
        // produced [255,0,255,0,255] here: gaps buzzing, pulses silent.)
        assertEquals(240L, t[5])
        assertEquals(listOf(240L, 60L, 120L, 90L, 500L), t.toList().subList(5, 10))
        assertEquals(listOf(0, 255, 0, 255, 0), a.toList().subList(5, 10))
    }

    @Test fun `the inter-rep gap replaces each subsequent rep's own lead wait`() {
        // rep 0 leads with its block's own 0ms wait; every later rep swaps that lead
        // for a 240ms silent gap. So a 2-element block over 2 reps = 2 + (1 gap + 1) = 4.
        val (t, a) = vibrateWaveform("tap", times = 2, intensity = 1.0)
        assertEquals(listOf(0L, 50L, 240L, 50L), t.toList())
        assertEquals(listOf(0, 255, 0, 255), a.toList())
    }

    // ── regression 2: escalate/wave carry an intensity CURVE, not flat amplitude ──

    @Test fun `escalate ramps its pulse amplitude upward (iOS s times 0dot25 plus 0dot5t)`() {
        // curve(10, 140, 10): 10 pulses, each = [140ms pulse, 10ms gap], after a lead wait.
        // Odd indices (1,3,5,…) are the pulses; their amplitude must strictly increase.
        val (t, a) = vibrateWaveform("escalate", times = 1, intensity = 1.0)
        assertEquals(0L, t[0]) // lead wait
        val pulseAmps = a.toList().filterIndexed { i, _ -> i % 2 == 1 }
        assertEquals(10, pulseAmps.size)
        // First pulse ≈ 0.25*255 ≈ 63; last ≈ (0.25+0.5*1.35)*255 ≈ 235. Monotonic up.
        assertTrue("escalate must ramp up", pulseAmps == pulseAmps.sorted())
        assertTrue("first pulse is gentle", pulseAmps.first() in 60..66)
        assertTrue("last pulse is strong", pulseAmps.last() > pulseAmps.first())
        // Pulse/gap timing: 140ms buzz, 10ms gap.
        assertEquals(140L, t[1]); assertEquals(10L, t[2])
    }

    @Test fun `wave swells and never drops its pulse below the 0dot15 floor`() {
        // wave = max(0.15, |sin|) curve. sin(0)=0 → the first pulse floors to 0.15*255≈38,
        // NOT 0 or 1 — the max(0.15,…) floor. All pulses ride at/above that floor.
        val (_, a) = vibrateWaveform("wave", times = 1, intensity = 1.0)
        val pulseAmps = a.toList().filterIndexed { i, _ -> i % 2 == 1 }
        assertEquals(10, pulseAmps.size)
        assertEquals("i=0 sin is 0 → 0.15 floor", 38, pulseAmps.first())
        assertTrue("every wave pulse is at least the 0.15 floor", pulseAmps.all { it >= 38 })
        assertTrue("the swell peaks above the floor", pulseAmps.max() > 200)
    }

    // ── regression 3 / 15s ceiling ──

    @Test fun `timings and amplitudes are always the same length`() {
        for (pattern in listOf("tap", "double", "heartbeat", "sos", "escalate", "wave", "long")) {
            val (t, a) = vibrateWaveform(pattern, times = 3, intensity = 0.8)
            assertEquals("$pattern arrays must stay in lockstep", t.size, a.size)
        }
    }

    @Test fun `a long pattern repeated many times is clamped to the 15s ceiling`() {
        // "long" = [0,600] per rep + a 240ms inter-rep gap. 20 reps ≈ 20*840 = 16.8s of
        // total timing — the slice must stop the cumulative sum before it passes 15000ms.
        val (t, _) = vibrateWaveform("long", times = 20, intensity = 1.0)
        assertTrue("must be clamped below the full 20-rep length", t.sum() <= 15_000)
    }

    @Test fun `an unknown pattern falls back to tap`() {
        // Parity with iOS default: any unrecognized pattern behaves like "tap".
        assertEquals(vibrateWaveform("tap", 1, 1.0).first.toList(), vibrateWaveform("bogus", 1, 1.0).first.toList())
        assertEquals(vibrateWaveform("tap", 1, 1.0).second.toList(), vibrateWaveform("bogus", 1, 1.0).second.toList())
    }
}

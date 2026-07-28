package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure motion-snapshot classification (iOS Motion.swift parity) — the moving/still
 * threshold, the lying-facing decision from the gravity vector, and radian→degree
 * truncation that feed a relay motion answer. Pure Kotlin, runs on the local JVM
 * (the SensorManager sampling in snapshot() is exercised on-device).
 */
class MotionTest {

    // ---- motionState (0.05g threshold, iOS parity) -------------------------

    @Test fun `below the threshold reads still`() {
        assertEquals("still", Motion.motionState(0.05f)) // strict >, so exactly 0.05 is still
        assertEquals("still", Motion.motionState(0.0f))
    }

    @Test fun `above the threshold reads moving with 2dp g, POSIX decimal`() {
        assertEquals("moving (user accel 0.30g)", Motion.motionState(0.3f))
        // Locale.US decimal even if the device locale uses a comma (agent-read string).
        assertEquals("moving (user accel 1.25g)", Motion.motionState(1.25f))
    }

    // ---- facing (gravity vector in g; Android +z = face up) ----------------

    @Test fun `face up and face down from the z axis`() {
        assertEquals("face up", Motion.facing(gzG = 0.98f, gyG = 0.0f))
        assertEquals("face down", Motion.facing(gzG = -0.98f, gyG = 0.0f))
    }

    @Test fun `upright when held vertically`() {
        assertEquals("upright", Motion.facing(gzG = 0.1f, gyG = 0.98f))
        assertEquals("upright", Motion.facing(gzG = 0.1f, gyG = -0.98f)) // abs(gy)
    }

    @Test fun `on its side when neither flat nor upright`() {
        assertEquals("on its side", Motion.facing(gzG = 0.2f, gyG = 0.2f))
    }

    @Test fun `z dominance is checked before upright`() {
        // A phone flat-ish (gz just over 0.75) reads face up even with some gy.
        assertEquals("face up", Motion.facing(gzG = 0.76f, gyG = 0.7f))
    }

    // ---- deg (truncates toward zero, iOS Int(rad*180/pi)) ------------------

    @Test fun `degrees truncate toward zero like iOS Int()`() {
        assertEquals(0, Motion.deg(0.0f))
        assertEquals(90, Motion.deg((Math.PI / 2).toFloat())) // 90.0 → 90
        // 0.999 rad = 57.24° → truncated 57 (roundToInt would have given 57 here,
        // but a value like 44.7° must truncate to 44, not round to 45):
        assertEquals(44, Motion.deg((44.7 * Math.PI / 180).toFloat()))
        assertEquals(-44, Motion.deg((-44.7 * Math.PI / 180).toFloat())) // toward zero
    }
}

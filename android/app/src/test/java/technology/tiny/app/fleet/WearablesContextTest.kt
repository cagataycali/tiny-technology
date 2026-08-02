package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The per-device context fragment (iOS Wearables.swift contextIfLinked's
 * per-device parts) — pure assembly, pinned on the JVM so the agent-facing
 * grammar can't drift between phones.
 */
class WearablesContextTest {

    private fun facts(
        name: String = "Cagatay's Glasses",
        link: String = "connected",
        type: String = "rayban_meta",
        hasDisplay: Boolean = false,
        thermal: String? = null,
    ) = WearablesBridge.DeviceFacts(name, link, type, hasDisplay, thermal)

    @Test fun `a plain device reads name, link and type`() {
        assertEquals(
            "Cagatay's Glasses (connected, rayban_meta)",
            WearablesBridge.deviceBits(facts()),
        )
    }

    @Test fun `display and thermal join the bits when present`() {
        assertEquals(
            "Cagatay's Glasses (connected, rayban_meta, has a display, thermal light)",
            WearablesBridge.deviceBits(facts(hasDisplay = true, thermal = "light")),
        )
    }

    @Test fun `a freshly-linked EMPTY name stays legible`() {
        // iOS user QA 2026-07-28: new glasses can report an empty name, which
        // rendered as NOTHING — an unnamed device still counts as present.
        assertEquals(
            "Glasses connected (connecting, unknown)",
            WearablesBridge.deviceBits(facts(name = "", link = "connecting", type = "unknown")),
        )
    }
}

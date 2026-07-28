package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Test
import technology.tiny.app.fleet.Bluetooth.BleDevice

/**
 * Pure BLE scan-summary formatting (iOS Bluetooth.swift scanSummary parity) — the
 * text block a nearby/bluetooth relay answer carries: strongest signal first, a
 * 25-device cap, and the reason WHY the list is empty (permission / powered-off /
 * no adapter) so the agent never reports a false "nothing near". Pure Kotlin, runs
 * on the local JVM (the BluetoothLeScanner sampling is exercised on-device).
 */
class BluetoothTest {

    private fun dev(name: String, rssi: Int) = BleDevice(address = "$name-addr", name = name, rssi = rssi)

    // ---- empty-state reasons (iOS parity + Android's extra unsupported branch) --

    @Test fun `no devices reports the plain nothing-near line`() {
        assertEquals("No BLE devices discovered nearby.", Bluetooth.summaryText(emptyList(), "idle"))
        assertEquals("No BLE devices discovered nearby.", Bluetooth.summaryText(emptyList(), "scanning"))
    }

    @Test fun `unauthorized empty reports the permission reason, not nothing-near`() {
        assertEquals(
            "Bluetooth scan permission not granted on the phone.",
            Bluetooth.summaryText(emptyList(), "unauthorized"),
        )
    }

    @Test fun `powered-off empty reports the radio is off`() {
        assertEquals("Bluetooth is turned off on the phone.", Bluetooth.summaryText(emptyList(), "poweredOff"))
    }

    @Test fun `unsupported empty reports no adapter (Android-only branch)`() {
        assertEquals("This phone has no Bluetooth adapter.", Bluetooth.summaryText(emptyList(), "unsupported"))
    }

    // ---- device list formatting -----------------------------------------------

    @Test fun `single device formats as a dashed RSSI line`() {
        assertEquals("- Pixel Buds · RSSI -42 dBm", Bluetooth.summaryText(listOf(dev("Pixel Buds", -42)), "scanning"))
    }

    @Test fun `strongest signal first regardless of input order`() {
        // -30 is stronger than -80 (closer to zero); the helper must re-sort.
        val out = Bluetooth.summaryText(listOf(dev("Far", -80), dev("Near", -30), dev("Mid", -55)), "scanning")
        assertEquals("- Near · RSSI -30 dBm\n- Mid · RSSI -55 dBm\n- Far · RSSI -80 dBm", out)
    }

    @Test fun `a non-empty list wins even if the state still reads unauthorized`() {
        // If devices came in, we show them — the empty-state reason is only for an EMPTY list.
        assertEquals("- Watch · RSSI -50 dBm", Bluetooth.summaryText(listOf(dev("Watch", -50)), "unauthorized"))
    }

    @Test fun `caps at 25 devices, keeping the 25 strongest`() {
        // 30 devices with rssi -1..-30; strongest (-1) first, weakest 5 (-26..-30) dropped.
        val many = (1..30).map { dev("D$it", -it) }
        val out = Bluetooth.summaryText(many, "scanning")
        val lines = out.split("\n")
        assertEquals(25, lines.size)
        assertEquals("- D1 · RSSI -1 dBm", lines.first())
        assertEquals("- D25 · RSSI -25 dBm", lines.last()) // -26..-30 dropped by the cap
    }
}

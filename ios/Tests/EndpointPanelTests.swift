/**
 * EndpointPanelTests — the printer panel's pure logic.
 *
 * Everything here reads a MACHINE'S OWN payload: optional fields, numbers that
 * arrive as strings, nulls where a sensor should be. The panel's job is to be
 * boringly honest about that — skip what it can't read rather than print "NaN°",
 * and never collapse three different failures into one message.
 *
 * Web parity target: app/devices/page.tsx (TELEMETRY_ROWS + EndpointPanel) and
 * tests/devices-camera-panel.test.ts.
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct EndpointTelemetryTests {

    /// The live printer's real payload, trimmed — the shape this must survive.
    /// Note `chamber: null` and `fan.cooling` as a STRING: both are genuine.
    private func printerPayload() -> [String: Any] {
        [
            "gcode_state": "RUNNING",
            "progress": 62,
            "layer": 7,
            "total_layers": 10,
            "remaining_min": 18,
            "subtask_name": "plate_colored.3mf",
            "temps": ["nozzle": 218, "nozzle_target": 220, "bed": 60, "bed_target": 60, "chamber": NSNull()],
            "fan": ["cooling": "0"],
        ]
    }

    // ── number(): the tolerant read ──────────────────────────────────────────

    @Test("a number arrives as a number, a string, or not at all")
    func numberIsTolerant() {
        #expect(EndpointTelemetry.number(41) == 41)
        #expect(EndpointTelemetry.number(41.5) == 41.5)
        // Bambu sends fan speeds as strings; a projection that only accepted
        // numbers would silently drop real readings.
        #expect(EndpointTelemetry.number("30.7") == 30.7)
        #expect(EndpointTelemetry.number(nil) == nil)
        #expect(EndpointTelemetry.number(NSNull()) == nil)
        #expect(EndpointTelemetry.number("--") == nil)
        #expect(EndpointTelemetry.number("") == nil)
    }

    @Test("a non-finite number is not a reading")
    func rejectsNonFinite() {
        // The bug this prevents: Double.nan passes `!= nil` and formats as "nan°".
        #expect(EndpointTelemetry.number(Double.nan) == nil)
        #expect(EndpointTelemetry.number(Double.infinity) == nil)
    }

    // ── readings(): the projection ───────────────────────────────────────────

    @Test("a running print reads out in the web's order")
    func projectsARunningPrint() {
        let r = EndpointTelemetry.readings(printerPayload())
        #expect(r.map(\.label) == ["state", "job", "nozzle", "bed", "layer", "remaining"])
        #expect(r.first { $0.label == "state" }?.value == "running")
        #expect(r.first { $0.label == "job" }?.value == "plate_colored.3mf · 62%")
        #expect(r.first { $0.label == "nozzle" }?.value == "218° → 220°")
        #expect(r.first { $0.label == "layer" }?.value == "7 / 10")
        #expect(r.first { $0.label == "remaining" }?.value == "18 min")
    }

    @Test("an idle machine shows a SHORT list, not a grid of dashes")
    func skipsAbsentFields() {
        // The real idle payload: finished, nothing heating, no time left.
        let idle: [String: Any] = [
            "gcode_state": "FINISH",
            "progress": 100,
            "layer": 10, "total_layers": 10,
            "remaining_min": 0,
            "subtask_name": "plate_colored.3mf",
            "temps": ["nozzle": 41, "nozzle_target": 0, "bed": 37, "bed_target": 0, "chamber": NSNull()],
        ]
        let r = EndpointTelemetry.readings(idle)
        // A 0 target is "not heating" — rendering "41° → 0°" implies a cooldown
        // command that was never issued.
        #expect(r.first { $0.label == "nozzle" }?.value == "41°")
        #expect(r.first { $0.label == "bed" }?.value == "37°")
        // remaining_min = 0 is not a reading, it's the absence of one.
        #expect(r.first { $0.label == "remaining" } == nil)
    }

    @Test("an empty payload renders nothing rather than crashing")
    func toleratesEmpty() {
        #expect(EndpointTelemetry.readings([:]).isEmpty)
        // A machine mid-boot: keys present, values garbage.
        let junk: [String: Any] = [
            "gcode_state": "", "subtask_name": "   ", "progress": "n/a",
            "layer": NSNull(), "total_layers": 0, "remaining_min": "?",
            "temps": "not-a-dict",
        ]
        #expect(EndpointTelemetry.readings(junk).isEmpty)
    }

    @Test("no field ever renders a NaN, a nil, or an empty value")
    func neverRendersGarbage() {
        // The whole point of the projection: whatever comes in, what goes out is
        // something a person can read.
        for payload in [printerPayload(), [:], ["temps": ["nozzle": Double.nan]] as [String: Any]] {
            for r in EndpointTelemetry.readings(payload) {
                #expect(!r.value.isEmpty)
                #expect(!r.value.lowercased().contains("nan"))
                #expect(!r.value.contains("nil"))
                #expect(!r.value.contains("Optional"))
            }
        }
    }

    @Test("a job with no progress yet shows its name alone")
    func jobWithoutProgress() {
        let queued: [String: Any] = ["subtask_name": "bracket.3mf", "progress": 0]
        #expect(EndpointTelemetry.readings(queued).first { $0.label == "job" }?.value == "bracket.3mf")
    }

    @Test("layer needs a total — 7 of unknown is not a reading")
    func layerNeedsATotal() {
        #expect(EndpointTelemetry.readings(["layer": 7]).isEmpty)
        #expect(EndpointTelemetry.readings(["layer": 7, "total_layers": 0]).isEmpty)
    }

    // ── isRunning ────────────────────────────────────────────────────────────

    @Test("running is a state, not a guess")
    func detectsRunning() {
        #expect(EndpointTelemetry.isRunning(["gcode_state": "RUNNING"]))
        #expect(EndpointTelemetry.isRunning(["gcode_state": "running"]))
        #expect(!EndpointTelemetry.isRunning(["gcode_state": "FINISH"]))
        #expect(!EndpointTelemetry.isRunning([:]))
        #expect(!EndpointTelemetry.isRunning(nil))
    }

    // ── note(): the three failures stay three ────────────────────────────────

    @Test("each failure gets its OWN words")
    func failuresStayDistinct() {
        // ⚠️ The bug this guards: collapsing these is how a busy printer gets
        // reported as unplugged, and how an expired credential sends someone out
        // to check cables.
        let unauthorized = EndpointTelemetry.note(unauthorized: true, timeout: false, unreachable: false)
        let timeout = EndpointTelemetry.note(unauthorized: false, timeout: true, unreachable: false)
        let unreachable = EndpointTelemetry.note(unauthorized: false, timeout: false, unreachable: true)
        let unknown = EndpointTelemetry.note(unauthorized: false, timeout: false, unreachable: false)

        #expect(Set([unauthorized, timeout, unreachable, unknown]).count == 4)
        // And each says the actionable thing: re-enroll / still working / silent.
        #expect(unauthorized.lowercased().contains("re-enroll"))
        #expect(timeout.lowercased().contains("still working"))
        #expect(unreachable.lowercased().contains("not answering"))
    }

    @Test("a rejected credential outranks a timeout")
    func unauthorizedWins() {
        // If the device both timed out and rejected us, the credential is the
        // actionable fact — waiting won't fix an expired token.
        #expect(EndpointTelemetry.note(unauthorized: true, timeout: true, unreachable: true)
                == EndpointTelemetry.note(unauthorized: true, timeout: false, unreachable: false))
    }

    // ── capabilities ─────────────────────────────────────────────────────────

    @Test("capabilities parse from the wire's JSON string")
    func parsesCapabilities() {
        // This is how it actually arrives — a string, not an array.
        #expect(EndpointTelemetry.parseCapabilities("[\"chat\",\"telemetry\",\"print\",\"cad\"]")
                == ["chat", "telemetry", "print", "cad"])
        // Already-decoded arrays pass through (a future worker could send one).
        #expect(EndpointTelemetry.parseCapabilities(["camera"]) == ["camera"])
    }

    @Test("malformed capabilities mean none, never a crash")
    func toleratesBadCapabilities() {
        #expect(EndpointTelemetry.parseCapabilities(nil).isEmpty)
        #expect(EndpointTelemetry.parseCapabilities("not json").isEmpty)
        #expect(EndpointTelemetry.parseCapabilities("{\"a\":1}").isEmpty)
        #expect(EndpointTelemetry.parseCapabilities(42).isEmpty)
        // Mixed junk keeps the strings and drops the rest.
        #expect(EndpointTelemetry.parseCapabilities("[\"print\",5,null]") == ["print"])
    }

    @Test("the LIVE printer gets a camera even though it never claims one")
    func printImpliesACamera() {
        // ⚠️ This is the real device's capability list. Keying only on "camera"
        // would hide a chamber view that demonstrably works.
        #expect(EndpointTelemetry.hasCamera(["chat", "telemetry", "print", "cad"]))
        #expect(EndpointTelemetry.hasCamera(["camera"]))
        // And a device that claims neither shows telemetry only, rather than a
        // permanently-failing image box.
        #expect(!EndpointTelemetry.hasCamera(["chat", "telemetry"]))
        #expect(!EndpointTelemetry.hasCamera([]))
    }

    // ── the camera's content-type allowlist ──────────────────────────────────

    @Test("only inert image types are decodable — svg is refused on purpose")
    func imageAllowlistIsInert() {
        // These bytes come from a machine nobody here controls. SVG is the one
        // image type that can script, so it stays out even though the proxy
        // already refuses it — two locks on the same door.
        #expect(EndpointCamera.types == ["image/jpeg", "image/png", "image/webp"])
        #expect(!EndpointCamera.types.contains("image/svg+xml"))
        #expect(!EndpointCamera.types.contains("text/html"))
    }

    @Test("the frame cap matches the worker's")
    func frameCapAgrees() {
        // A robot is not a trusted size; both layers stop at 8MB.
        #expect(EndpointCamera.maxBytes == 8 * 1024 * 1024)
    }
}

@Suite struct EndpointDeviceRowTests {
    @Test("only an endpoint device gets a live panel")
    func onlyEndpointsPoll() {
        // Every other row must cost nothing extra — most people have no robots.
        let printer = DeviceRow(id: "d1", name: "3D printer", kind: "endpoint",
                                online: false, lastSeen: nil, capabilities: ["print"])
        let phone = DeviceRow(id: "d2", name: "iPhone", kind: "ios",
                              online: true, lastSeen: Date(), capabilities: [])
        #expect(printer.isEndpoint)
        #expect(!phone.isEndpoint)
    }
}

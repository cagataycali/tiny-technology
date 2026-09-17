/**
 * FomoTwinUITests — the twin and the per-servo rows exist and carry live numbers. NO motion is ever sent: no slider,
 * stepper, torque toggle or pad is touched (a swipe over the pad is a real look command). Signed in through the
 * DEBUG --session-harness token like FomoPiPUITests; proof = identifiers + values, never pictures.
 */
import XCTest

final class FomoTwinUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func makeApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-ui-testing"]
        if let t = ProcessInfo.processInfo.environment["TINY_HARNESS_TOKEN"], !t.isEmpty {
            app.launchArguments.append("--session-harness")
            app.launchEnvironment["TINY_HARNESS_TOKEN"] = t
        }
        return app
    }
    private func log(_ s: String) {
        NSLog("[FomoTwinUITests] %@", s)
        let a = XCTAttachment(string: s); a.name = "note"; a.lifetime = .keepAlways; add(a)
    }
    private func el(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func wait(_ timeout: TimeInterval, _ cond: @escaping () -> Bool) -> Bool {
        XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in cond() }, object: nil)], timeout: timeout) == .completed
    }
    private func segment(_ app: XCUIApplication, _ title: String) {
        let b = app.buttons[title].firstMatch
        XCTAssertTrue(b.waitForExistence(timeout: 3), "segment '\(title)' not found")
        var tries = 0
        repeat { b.tap(); tries += 1; _ = wait(1.5) { b.isSelected } } while !b.isSelected && tries < 4
        log("segment '\(title)' selected=\(b.isSelected) after \(tries) tap(s)")
    }

    private func openScreen() -> XCUIApplication {
        let app = makeApp()
        app.launch()
        XCTAssertTrue(el(app, "account-menu").waitForExistence(timeout: 20), "signed out — no account menu")
        let overlay = el(app, "arm-live-overlay")
        if !overlay.exists {
            let armButton = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Arm live view'")).firstMatch
            XCTAssertTrue(armButton.waitForExistence(timeout: 20), "no 'Arm live view' toolbar button — the fleet has no arm row")
            armButton.press(forDuration: 0.12)
        }
        XCTAssertTrue(overlay.waitForExistence(timeout: 8), "arm card not on screen")
        el(app, "fomo-pip-expand").tap()
        XCTAssertTrue(el(app, "fomo-screen").waitForExistence(timeout: 8), "FomoScreen did not open")
        return app
    }

    /// Camera|Twin switch → the native twin reports loaded=true within 15 s, the HUD has six joint rows with numbers.
    func testTwinLoadsAndShowsJointHUD() {
        let app = openScreen()
        segment(app, "Twin")
        let twin = el(app, "fomo-twin")
        XCTAssertTrue(twin.waitForExistence(timeout: 8), "fomo-twin missing")
        let loaded = wait(15) { (twin.value as? String)?.contains("loaded=true") ?? false }
        log("fomo-twin value=\(twin.value ?? "-") loaded=\(loaded)")
        if !loaded {
            let fb = el(app, "fomo-twin-fallback-why")
            log("fallback present=\(fb.exists) why=\(fb.label)")
        }
        XCTAssertTrue(loaded, "twin did not report loaded=true in 15 s: \(twin.value ?? "-")")
        XCTAssertFalse(el(app, "fomo-twin-fallback").exists, "web fallback shown although the native twin loaded")
        for name in ["base", "shoulder_lift", "elbow", "wrist_flex", "pan", "tilt"] {
            let row = el(app, "fomo-twin-joint-\(name)")
            XCTAssertTrue(row.waitForExistence(timeout: 5), "HUD row \(name) missing")
            let v = (row.value as? String) ?? ""
            log("hud \(name): \(v)")
            XCTAssertTrue(v.range(of: #"^\d+(\.\d+)? ->"#, options: .regularExpression) != nil || v.hasPrefix("- ->"), "row \(name) value odd: \(v)")
        }
        XCTAssertTrue(el(app, "fomo-twin-legend").exists)
        XCTAssertTrue(el(app, "fomo-twin-status").exists)
        // back to the camera so the persisted view is what the owner had
        segment(app, "Camera")
    }

    /// Servos section → six rows with a live reading, a slider bound to the guard window, ±1/±5 and torque. Nothing tapped.
    func testServosRowsAreLiveAndUntouched() {
        let app = openScreen()
        segment(app, "Servos")
        XCTAssertTrue(el(app, "fomo-servos").waitForExistence(timeout: 8), "fomo-servos missing")
        XCTAssertTrue(el(app, "fomo-servos-stop").exists, "STOP not visible in Servos")
        var live = 0
        for name in ["base", "shoulder_lift", "elbow", "wrist_flex", "pan", "tilt"] {
            let row = el(app, "fomo-servo-\(name)")
            XCTAssertTrue(row.waitForExistence(timeout: 5), "servo row \(name) missing")
            let gotReading = wait(10) { !((row.value as? String) ?? "-").hasPrefix("-") }
            let v = (row.value as? String) ?? ""
            log("servo \(name): \(v) reading=\(el(app, "fomo-servo-\(name)-reading").label)")
            if gotReading { live += 1 }
            XCTAssertTrue(v.contains("window "), "row \(name) has no window: \(v)")
            for suffix in ["slider", "minus5", "minus1", "plus1", "plus5", "torque"] {
                XCTAssertTrue(el(app, "fomo-servo-\(name)-\(suffix)").exists, "\(name) lacks \(suffix)")
            }
        }
        log("live readings: \(live)/6")
        XCTAssertTrue(live == 6 || el(app, "fomo-servos-busy").label.contains("waiting"), "rows have no reading and the tab does not say so")
        XCTAssertFalse(el(app, "fomo-servos-refusal").exists, "a refusal is shown although nothing was sent")
    }

    /// PiP strip: the camera↔twin flip button exists and toggles its value; flipped back afterwards.
    func testPiPFlipsBetweenCameraAndTwin() {
        let app = makeApp()
        app.launch()
        XCTAssertTrue(el(app, "account-menu").waitForExistence(timeout: 20))
        let overlay = el(app, "arm-live-overlay")
        if !overlay.exists {
            let armButton = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Arm live view'")).firstMatch
            XCTAssertTrue(armButton.waitForExistence(timeout: 20))
            armButton.press(forDuration: 0.12)
        }
        XCTAssertTrue(overlay.waitForExistence(timeout: 8))
        let flip = el(app, "fomo-pip-view")
        XCTAssertTrue(flip.waitForExistence(timeout: 5), "fomo-pip-view missing from the strip")
        let before = (flip.value as? String) ?? "?"
        flip.tap()
        let after = wait(3) { ((flip.value as? String) ?? "?") != before }
        log("pip view \(before) -> \(flip.value ?? "-") changed=\(after)")
        XCTAssertTrue(after)
        if (flip.value as? String) == "twin" {
            XCTAssertTrue(el(app, "fomo-twin").waitForExistence(timeout: 5), "twin not in the card after the flip")
        }
        flip.tap()
        _ = wait(3) { ((flip.value as? String) ?? "?") == before }
        XCTAssertEqual(flip.value as? String, before)
    }
}

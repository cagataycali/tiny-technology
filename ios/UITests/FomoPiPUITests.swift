/**
 * FomoPiPUITests — the arm PiP as a control surface (2026-09-09 owner report:
 * "picture-in-picture features are limited", "method not allowed when I move
 * the arm"). Signed in through the DEBUG --session-harness token so the toolbar
 * carries the real fleet's arm button; nothing here moves the arm (no motion is
 * tapped, no pad drag) — it proves the surface: open on one tap → the card is on
 * screen → drag it to another corner and it snaps there (accessibilityValue
 * carries the corner) → size toggle → expand → FomoScreen with STOP, the
 * motions gallery from GET /api/motions, telemetry rows, the RL stage badge,
 * the Ask Fomo field. Proof is identifiers + debugDescription, never pixels.
 */
import XCTest

final class FomoPiPUITests: XCTestCase {

    override func setUpWithError() throws { continueAfterFailure = false }

    private static func makeApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-ui-testing"]
        if let t = ProcessInfo.processInfo.environment["TINY_HARNESS_TOKEN"], !t.isEmpty {
            app.launchArguments.append("--session-harness")
            app.launchEnvironment["TINY_HARNESS_TOKEN"] = t
        }
        return app
    }

    private func log(_ s: String) {
        NSLog("[FomoPiPUITests] %@", s)
        let a = XCTAttachment(string: s); a.name = "note"; a.lifetime = .keepAlways; add(a)
    }

    private func dumpTree(_ app: XCUIApplication, tag: String) {
        let text = app.debugDescription
        for l in text.split(separator: "\n") {
            let line = String(l)
            if line.contains("identifier:") || line.contains("label:") {
                NSLog("[FomoPiPUITests] TREE[%@] %@", tag, String(line.trimmingCharacters(in: .whitespaces).prefix(220)))
            }
        }
        let a = XCTAttachment(string: text); a.name = "tree-\(tag)"; a.lifetime = .keepAlways; add(a)
    }

    private func el(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func onScreen(_ e: XCUIElement, in app: XCUIApplication) -> Bool {
        guard e.exists else { return false }
        let f = e.frame, w = app.windows.firstMatch.frame
        return f.width > 50 && f.height > 50 && w.intersects(f)
    }

    /// Pick a section of the segmented control and wait until content whose
    /// identifier begins with `prefix` (or an honest `fallbackText`) is present.
    /// No swipes: a swipe over the pad would be a look command to the real arm.
    @discardableResult
    private func tab(_ app: XCUIApplication, _ title: String, contentPrefix prefix: String, fallbackText: String? = nil) -> Bool {
        let b = app.buttons[title].firstMatch
        XCTAssertTrue(b.waitForExistence(timeout: 3), "segment '\(title)' not found")
        // Segmented pickers under a live-updating picture miss a tap now and then
        // (the row re-lays out at stream rate); tap until the segment reports selected.
        var tries = 0
        repeat {
            b.tap()
            tries += 1
            _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in b.isSelected }, object: nil)], timeout: 1.5)
        } while !b.isSelected && tries < 4
        log("tab '\(title)': selected=\(b.isSelected) after \(tries) tap(s)")
        let content = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
        let r = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            if content.exists { return true }
            if let f = fallbackText { return app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", f)).count > 0 }
            return false
        }, object: nil)], timeout: 8)
        let ids = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).allElementsBoundByIndex.prefix(12).map { "\($0.identifier)=\($0.label)" }
        log("tab '\(title)': content(\(prefix)*) \(r == .completed ? "present" : "MISSING") \(ids)")
        if r != .completed {
            log("after '\(title)': motions still=\(app.descendants(matching: .any)["fomo-motion-approve"].firstMatch.exists) tabsSelected=\(app.segmentedControls.firstMatch.buttons.allElementsBoundByIndex.map { "\($0.label):\($0.isSelected)" })")
            let screen = el(app, "fomo-screen")
            let text = screen.exists ? screen.debugDescription : app.windows.allElementsBoundByIndex.map { $0.debugDescription }.joined(separator: "\n")
            for l in text.split(separator: "\n") where l.contains("identifier:") || l.contains("label:") {
                NSLog("[FomoPiPUITests] COVER[%@] %@", prefix, String(l.trimmingCharacters(in: .whitespaces).prefix(200)))
            }
        }
        return r == .completed
    }

    private func openCard() -> (XCUIApplication, XCUIElement) {
        let app = Self.makeApp()
        app.launch()
        XCTAssertTrue(el(app, "account-menu").waitForExistence(timeout: 20), "signed out — no account menu")
        let overlay = el(app, "arm-live-overlay")
        if !overlay.exists {
            let armButton = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Arm live view'")).firstMatch
            let have = armButton.waitForExistence(timeout: 20)
            if !have { dumpTree(app, tag: "no-arm-button") }
            XCTAssertTrue(have, "no 'Arm live view' toolbar button — the fleet has no arm row")
            armButton.press(forDuration: 0.12)
        }
        let shown = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { [weak self] _, _ in
            self?.onScreen(overlay, in: app) ?? false
        }, object: nil)], timeout: 8)
        if shown != .completed { dumpTree(app, tag: "no-card") }
        XCTAssertEqual(shown, .completed, "arm card not on screen after one tap")
        log("card frame \(overlay.frame) value=\(overlay.value ?? "-")")
        return (app, overlay)
    }

    /// Open → STOP in the strip → drag to the bottom-left → snapped (value says so,
    /// frame moved left/down) → size toggle → close writes the pref.
    func testCardDragsSnapsAndResizes() throws {
        let (app, overlay) = openCard()
        let stop = el(app, "fomo-pip-stop")
        XCTAssertTrue(stop.waitForExistence(timeout: 3), "STOP missing from the PiP strip")
        XCTAssertTrue(el(app, "arm-live-device").exists, "device name line missing")
        XCTAssertTrue(el(app, "fomo-pip-badge").exists, "camera badge missing (live/snapshot/no camera)")
        // Start from a known corner (the pref persists across runs): top-right.
        if (overlay.value as? String)?.hasPrefix("topTrailing") != true {
            let tr = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.25))
            overlay.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.15, thenDragTo: tr)
            let r0 = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                (overlay.value as? String)?.hasPrefix("topTrailing") == true
            }, object: nil)], timeout: 4)
            XCTAssertEqual(r0, .completed, "could not bring the card to the top-right first: \(overlay.value ?? "-")")
            sleep(1)
        }
        if (overlay.value as? String)?.hasSuffix("thumb") != true { el(app, "fomo-pip-size").tap(); sleep(1) }
        let before = overlay.frame
        let win = app.windows.firstMatch.frame

        // Drag from the picture (not the strip's buttons) to the bottom-left.
        let start = overlay.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let target = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.75))
        start.press(forDuration: 0.15, thenDragTo: target)
        let snapped = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (overlay.value as? String)?.hasPrefix("bottomLeading") == true
        }, object: nil)], timeout: 4)
        let after = overlay.frame
        log("drag: before=\(before) after=\(after) value=\(overlay.value ?? "-") window=\(win)")
        if snapped != .completed { dumpTree(app, tag: "not-snapped") }
        XCTAssertEqual(snapped, .completed, "card did not snap to the bottom-left corner")
        XCTAssertLessThan(after.minX, before.minX, "card did not move left")
        XCTAssertGreaterThan(after.minY, before.minY, "card did not move down")
        XCTAssertTrue(onScreen(overlay, in: app), "card left the screen after the snap")
        XCTAssertTrue(stop.exists && stop.isHittable, "STOP not hittable after the snap")

        // Larger card: the HUD line appears.
        el(app, "fomo-pip-size").tap()
        let hud = el(app, "fomo-pip-hud")
        XCTAssertTrue(hud.waitForExistence(timeout: 3), "half-size HUD line missing")
        XCTAssertTrue((overlay.value as? String)?.hasSuffix("half") == true, "size pref did not flip to half: \(overlay.value ?? "-")")
        XCTAssertGreaterThan(overlay.frame.width, before.width + 40, "half card is not wider than the thumbnail")
        log("half: frame=\(overlay.frame) hud='\(hud.label)'")
        XCTAssertTrue(stop.exists, "STOP missing at half size")

        // Back to the thumbnail and the top-right so the next run starts clean.
        el(app, "fomo-pip-size").tap()
        let back = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.2))
        overlay.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.15, thenDragTo: back)
        _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (overlay.value as? String)?.hasPrefix("topTrailing") == true
        }, object: nil)], timeout: 4)
        log("reset: value=\(overlay.value ?? "-")")
    }

    /// Expand → FomoScreen: STOP, HOME, Fold, Torque, Photo; motions gallery
    /// from Fomo's GET /api/motions (approve/deny/happy…); telemetry rows; RL
    /// stage badge; Ask Fomo field. Nothing is tapped that moves the arm.
    func testExpandedScreenIsAControlSurface() throws {
        let (app, _) = openCard()
        el(app, "fomo-pip-expand").tap()
        let screen = el(app, "fomo-screen")
        let stop = el(app, "fomo-stop")
        let up = stop.waitForExistence(timeout: 6)
        if !up { dumpTree(app, tag: "no-screen") }
        XCTAssertTrue(up, "FomoScreen STOP did not appear")
        log("screen exists=\(screen.exists)")
        for id in ["fomo-home", "fomo-fold", "fomo-torque", "fomo-photo", "fomo-pad"] {
            XCTAssertTrue(el(app, id).exists, "\(id) missing")
        }

        // Motions from the live API (or the honest empty line if Fomo is unreachable).
        let motions = el(app, "fomo-motions")
        let anyMotion = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'fomo-motion-'")).firstMatch
        let empty = el(app, "fomo-motions-empty")
        let listed = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            anyMotion.exists || (empty.exists && !empty.label.hasPrefix("loading"))
        }, object: nil)], timeout: 12)
        let names = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'fomo-motion-'")).allElementsBoundByIndex.map { $0.identifier }
        log("motions: grid=\(motions.exists) count=\(names.count) names=\(names) empty=\(empty.exists ? empty.label : "-")")
        if listed != .completed { dumpTree(app, tag: "no-motions") }
        XCTAssertEqual(listed, .completed, "motions gallery neither listed nor explained itself within 12 s")
        if anyMotion.exists {
            XCTAssertTrue(names.contains("fomo-motion-approve") || names.contains("fomo-motion-wave"), "Fomo's built-in motions not in the gallery: \(names)")
        }

        // Telemetry tab: joints in degrees + rail (or the honest "reaching…" line).
        XCTAssertTrue(tab(app, "Telemetry", contentPrefix: "fomo-joint-", fallbackText: "reaching"), "telemetry shows neither joint rows nor 'reaching…'")
        let rail = el(app, "fomo-kv-rail")
        log("telemetry: rail=\(rail.exists ? rail.label : "-") pan=\(el(app, "fomo-joint-pan").exists ? el(app, "fomo-joint-pan").label : "-")")

        // RL tab: the stage badge and the gate's reason, verbatim.
        XCTAssertTrue(tab(app, "RL", contentPrefix: "fomo-rl"), "RL section missing")
        log("rl: stage=\(el(app, "fomo-rl-stage").exists ? el(app, "fomo-rl-stage").label : "-") reason=\(el(app, "fomo-rl-reason").exists ? el(app, "fomo-rl-reason").label : "-")")

        // Ask Fomo: the field and the send button exist (nothing is sent).
        XCTAssertTrue(tab(app, "Ask", contentPrefix: "fomo-ask-"), "Ask Fomo field missing")
        XCTAssertTrue(el(app, "fomo-ask-send").exists, "Ask Fomo send button missing")
        log("agent link: \(el(app, "fomo-agent-link").exists ? el(app, "fomo-agent-link").label : "-")")

        XCTAssertTrue(stop.exists, "STOP left the screen while switching sections")
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(el(app, "arm-live-overlay").waitForExistence(timeout: 4), "card gone after closing the full screen")
    }
}

extension FomoPiPUITests {
    /// Diagnostic: does the full screen survive 20 s untouched? Logs one line per second.
    func testDiagExpandedScreenSurvives() throws {
        let (app, _) = openCard()
        el(app, "fomo-pip-expand").tap()
        let stop = el(app, "fomo-stop")
        XCTAssertTrue(stop.waitForExistence(timeout: 6))
        let t0 = Date()
        var lastSeen = 0.0
        for _ in 0..<20 {
            let alive = stop.exists
            let t = Date().timeIntervalSince(t0)
            if alive { lastSeen = t }
            let word = el(app, "fomo-state-word")
            log(String(format: "t=%.1f screen=%@ stateWord=%@ card=%@", t, alive ? "up" : "GONE", word.exists ? word.label : "-", el(app, "arm-live-overlay").exists ? "yes" : "no"))
            if !alive { dumpTree(app, tag: "diag-gone"); break }
            sleep(1)
        }
        log("screen last seen at \(lastSeen)s")
        XCTAssertGreaterThan(lastSeen, 18, "full screen dismissed itself")
    }
}


/// No auth/real endpoint: the actual offline screen, not a hardware test.
@MainActor final class FomoOfflineUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<10 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "Offline control is not reachable: \(element.identifier)")
    }

    func testOfflineSectionsAndControlsRemainReachableWithoutHardware() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-ui-testing-no-device-polls", "--fomo-offline-harness"]
        app.launch()
        XCTAssertTrue(element(app, "fomo-screen").waitForExistence(timeout: 15))
        // Only inspect motion controls; NEVER tap them or drag a servo/pad.
        let stop = element(app, "fomo-stop")
        reveal(stop, in: app)
        for id in ["fomo-stop", "fomo-home", "fomo-fold", "fomo-torque", "fomo-photo"] {
            let control = element(app, id)
            XCTAssertTrue(control.exists)
            let f = control.frame, w = app.windows.firstMatch.frame
            XCTAssertGreaterThan(f.width, 0)
            XCTAssertGreaterThanOrEqual(f.minX, w.minX - 1)
            XCTAssertLessThanOrEqual(f.maxX, w.maxX + 1)
        }
        for section in ["servos", "motions", "poses", "telemetry", "rl", "ask"] {
            let tab = element(app, "fomo-tab-" + section)
            reveal(tab, in: app); tab.tap()
            let body = element(app, "fomo-" + section)
            XCTAssertTrue(body.waitForExistence(timeout: 5), "Missing offline section \(section)")
        }
        XCTAssertTrue(app.staticTexts["no arm known yet"].exists)
        XCTAssertFalse(element(app, "fomo-ask-send").isEnabled)
        print("FOMO_OFFLINE_LAYOUT window=\(app.windows.firstMatch.frame)")
        app.terminate()
    }
}

import XCTest

/// Arm + necklace PiP overlays: ONE tap on the toolbar button must put the card
/// on screen (`arm-live-overlay` / `tiny-live-overlay`) with the device's name
/// or an explicit error line.
///
/// Owner report (2026-09-09, build 78 on owner-phone): "I tap the arm thumbnail
/// and the necklace icon and I don't see Fomo the arm or the Nicla Vision."
/// Runs signed in (installed Keychain session on the phone, or the runner's
/// `TINY_HARNESS_TOKEN` through TinyApp's DEBUG `--session-harness` on a
/// simulator) so the toolbar shows the REAL device rows. No pixels: every
/// assertion is on accessibility identifiers/labels, and the whole element tree
/// is written to the log when something is missing.
final class LiveOverlayUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private static func makeApp(extraArgs: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-ui-testing"] + extraArgs
        if let t = ProcessInfo.processInfo.environment["TINY_HARNESS_TOKEN"], !t.isEmpty {
            app.launchArguments.append("--session-harness")
            app.launchEnvironment["TINY_HARNESS_TOKEN"] = t
        }
        return app
    }

    private func dumpTree(_ app: XCUIApplication, tag: String) {
        let text = app.debugDescription
        for l in text.split(separator: "\n") {
            let line = String(l)
            // Keep the lines that carry identifiers/labels, skip the boilerplate.
            if line.contains("identifier:") || line.contains("label:") || line.contains("Overlay") {
                NSLog("[LiveOverlayUITests] TREE[%@] %@", tag, String(line.trimmingCharacters(in: .whitespaces).prefix(220)))
            }
        }
        let a = XCTAttachment(string: text); a.name = "tree-\(tag)"; a.lifetime = .keepAlways; add(a)
    }

    private func log(_ s: String) {
        NSLog("[LiveOverlayUITests] %@", s)
        let a = XCTAttachment(string: s); a.name = "note"; a.lifetime = .keepAlways; add(a)
    }

    private func launchSignedIn(extraArgs: [String] = []) -> XCUIApplication {
        let app = Self.makeApp(extraArgs: extraArgs)
        app.launch()
        let menu = app.descendants(matching: .any)["account-menu"].firstMatch
        let present = menu.waitForExistence(timeout: 20)
        if !present { dumpTree(app, tag: "no-account-menu") }
        XCTAssertTrue(present, "toolbar account menu never appeared — signed out?")
        return app
    }

    /// A card is "on screen" when its element exists AND its frame lies inside
    /// the window — a card tucked under the navigation bar or rendered at zero
    /// size is the owner's "I don't see it" just as much as a missing one.
    private func onScreen(_ el: XCUIElement, in app: XCUIApplication) -> Bool {
        guard el.exists else { return false }
        let f = el.frame, w = app.windows.firstMatch.frame
        return f.width > 50 && f.height > 50 && w.intersects(f)
    }

    // MARK: arm

    /// Tap "Arm live view…" once → `arm-live-overlay` within 5 s, showing the
    /// arm's name (`arm-live-device`). The card's onAppear also opens the full
    /// ArmLiveScreen (HOME / STOP), which counts as seeing the arm too.
    func testArmLiveOverlayOpensOnOneTap() throws {
        try armOpens(extraArgs: [])
    }

    /// The owner's bar: linked Meta glasses make a FIFTH item share the device
    /// HStack. Simulators never link glasses, so render it via the DEBUG flag.
    func testArmLiveOverlayOpensOnOneTap_FiveTrailingItems() throws {
        try armOpens(extraArgs: ["-ui-testing-fake-glasses-linked"])
    }

    private func armOpens(extraArgs: [String]) throws {
        let app = launchSignedIn(extraArgs: extraArgs)
        // The Fomo card remembers being open (FomoPiPPrefs.open); close a restored
        // card first so the assertion below still measures ONE tap opening it.
        let restored = app.descendants(matching: .any)["fomo-pip-close"].firstMatch
        if restored.waitForExistence(timeout: 3) {
            log("card restored from prefs at launch — closing it before the one-tap check")
            restored.tap()
            sleep(1)
        }
        let armButton = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Arm live view'")).firstMatch
        let haveArm = armButton.waitForExistence(timeout: 20)
        if !haveArm { dumpTree(app, tag: "no-arm-button") }
        XCTAssertTrue(haveArm, "no 'Arm live view' toolbar button — the fleet has no arm row, or discovery never ran")
        log("arm button label before tap: \(armButton.label)")
        sleep(2)
        armButton.press(forDuration: 0.12)

        let overlay = app.descendants(matching: .any)["arm-live-overlay"].firstMatch
        let full = app.buttons["HOME"].firstMatch
        let appeared = NSPredicate { [weak self] _, _ in
            guard let self else { return false }
            return self.onScreen(overlay, in: app) || full.exists
        }
        let r = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: appeared, object: nil)], timeout: 5)
        let closeLabel = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Close arm live view'")).firstMatch
        log("after tap: overlay.exists=\(overlay.exists) frame=\(overlay.exists ? "\(overlay.frame)" : "-") fullscreen=\(full.exists) buttonNowSaysClose=\(closeLabel.exists)")
        if r != .completed { dumpTree(app, tag: "arm-after-tap") }
        XCTAssertEqual(r, .completed, "arm live overlay did not appear on screen within 5 s of ONE tap")

        if full.exists {
            // Full screen opened over the card: the arm's surface is up. Close it
            // to check the card underneath carries the name.
            let done = app.buttons["Done"].firstMatch
            if done.exists { done.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
            sleep(1)
        }
        let name = app.descendants(matching: .any)["arm-live-device"].firstMatch
        let named = name.waitForExistence(timeout: 5)
        log("arm-live-device: exists=\(named) text=\(named ? name.label : "-")")
        if !named { dumpTree(app, tag: "arm-no-name") }
        XCTAssertTrue(named, "arm card has no device name line")
        XCTAssertFalse(name.label.isEmpty, "arm card device name is empty")

        // Picture or an honest line — never a blank card. 12 s covers the
        // relay snapshot fallback when the head's MJPEG is down.
        let frame = app.descendants(matching: .any)["arm-live-frame"].firstMatch
        let pictureOrWord = NSPredicate { _, _ in
            frame.exists || app.staticTexts.matching(NSPredicate(
                format: "label CONTAINS 'camera' OR label CONTAINS 'frame' OR label CONTAINS 'reaching' OR label CONTAINS 'token'")).count > 0
        }
        let r3 = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: pictureOrWord, object: nil)], timeout: 12)
        log("arm picture: frame=\(frame.exists) label='\(frame.exists ? frame.label : "-")'")
        if r3 != .completed { dumpTree(app, tag: "arm-blank-card") }
        XCTAssertEqual(r3, .completed, "arm card shows neither a picture nor its empty-state line")
    }

    // MARK: necklace

    /// Tap "Necklace live view" once → `tiny-live-overlay` within 5 s, showing
    /// the necklace row's name (`tiny-live-device`, e.g. tiny-99c9) or an
    /// explicit state/error line (`tiny-live-state`).
    func testNecklaceLiveOverlayOpensOnOneTap() throws {
        try necklaceOpens(extraArgs: [])
    }

    func testNecklaceLiveOverlayOpensOnOneTap_FiveTrailingItems() throws {
        try necklaceOpens(extraArgs: ["-ui-testing-fake-glasses-linked"])
    }

    private func necklaceOpens(extraArgs: [String]) throws {
        let app = launchSignedIn(extraArgs: extraArgs)
        let button = app.buttons["Necklace live view"].firstMatch
        let have = button.waitForExistence(timeout: 20)
        if !have { dumpTree(app, tag: "no-necklace-button") }
        XCTAssertTrue(have, "no 'Necklace live view' toolbar button")
        sleep(2)
        button.press(forDuration: 0.12)

        let overlay = app.descendants(matching: .any)["tiny-live-overlay"].firstMatch
        let appeared = NSPredicate { [weak self] _, _ in self?.onScreen(overlay, in: app) ?? false }
        let r = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: appeared, object: nil)], timeout: 5)
        log("after tap: overlay.exists=\(overlay.exists) frame=\(overlay.exists ? "\(overlay.frame)" : "-")")
        if r != .completed { dumpTree(app, tag: "necklace-after-tap") }
        XCTAssertEqual(r, .completed, "necklace live overlay did not appear on screen within 5 s of ONE tap")

        // Within 15 s the card must name the device it aimed at, or say why not.
        let device = app.descendants(matching: .any)["tiny-live-device"].firstMatch
        let state = app.descendants(matching: .any)["tiny-live-state"].firstMatch
        let informative = NSPredicate { _, _ in
            (device.exists && device.label != "tiny necklace" && !device.label.isEmpty)
                || (state.exists && !state.label.isEmpty && !state.label.hasPrefix("connecting"))
        }
        let r2 = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: informative, object: nil)], timeout: 15)
        log("necklace card: device='\(device.exists ? device.label : "-")' state='\(state.exists ? state.label : "-")'")
        if r2 != .completed { dumpTree(app, tag: "necklace-uninformative") }
        XCTAssertEqual(r2, .completed, "necklace card never named its device nor reported an error")
        if device.exists {
            XCTAssertFalse(device.label.contains("tiny-b3d3"), "necklace view aimed at the offline orphan tiny-b3d3")
        }
        // Evidence only (the necklace may be off): did a frame arrive in 12 s?
        let frame = app.descendants(matching: .any)["tiny-live-frame"].firstMatch
        let got = frame.waitForExistence(timeout: 12)
        log("necklace picture: frame=\(got) label='\(got ? frame.label : "-")' state='\(state.exists ? state.label : "-")'")
    }
}

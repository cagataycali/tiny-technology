import XCTest

/// Account menu: one tap on the toolbar person icon must open the menu.
///
/// Owner report (2026-09-09, build 78 on owner-phone): "I have to tap the user
/// icon twice to open the menu." This test is the reproduction and the
/// regression guard. It runs against the SIGNED-IN app on the phone (the
/// keychain session survives the test reinstall), so the toolbar shows the
/// real trailing items (arm thumbnail, UNO Q button) whose live ticks are the
/// prime suspect.
final class AccountMenuUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// On the phone the installed app's Keychain session is used as-is. On a
    /// simulator (or a fresh device) pass the owner's session through the
    /// runner's environment — `TEST_RUNNER_TINY_HARNESS_TOKEN=… xcodebuild test`
    /// — and TinyApp's DEBUG-only `--session-harness` seeds it before the first
    /// Keychain read, so the toolbar shows the REAL device rows (arm, UNO Q).
    /// The token rides the environment only; it is never written anywhere.
    private static func makeApp(extraArgs: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-ui-testing"] + extraArgs
        if let t = ProcessInfo.processInfo.environment["TINY_HARNESS_TOKEN"], !t.isEmpty {
            app.launchArguments.append("--session-harness")
            app.launchEnvironment["TINY_HARNESS_TOKEN"] = t
        }
        return app
    }

    /// Menu content that exists in every account state ("My devices" is
    /// unconditional in ChatView's account Menu; "Sign out" too).
    private func menuIsOpen(_ app: XCUIApplication) -> Bool {
        app.buttons["My devices"].exists
            || app.staticTexts["My devices"].exists
            || app.buttons["Sign out"].exists
            || app.staticTexts["Sign out"].exists
    }

    /// Launch, wait for the toolbar, settle, tap the account menu ONCE and
    /// return whether a menu item appeared within 2 s.
    @discardableResult
    private func oneTapOpens(extraArgs: [String] = [], keyboardUp: Bool = false,
                             file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let app = Self.makeApp(extraArgs: extraArgs)
        app.launch()

        let menu = app.descendants(matching: .any)["account-menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 20),
                      "toolbar account menu (account-menu) never appeared — signed out?", file: file, line: line)

        if keyboardUp {
            let field = app.descendants(matching: .any)["composer-input"].firstMatch
            XCTAssertTrue(field.waitForExistence(timeout: 5), "composer field missing", file: file, line: line)
            field.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "keyboard did not come up", file: file, line: line)
        }

        // Let the device managers reach steady state (arm MJPEG frames + 500 ms
        // state poll, board 2 s poll) so the tap lands where the owner's does.
        sleep(6)
        logToolbar(app)

        return fingerTap(menu, in: app)
    }

    /// A human tap holds ~80–150 ms between touch-down and touch-up; XCUITest's
    /// `tap()` is a few ms and can slip between two toolbar re-renders. Press
    /// for a finger's duration so the touch spans at least one 100 ms frame.
    private func fingerTap(_ menu: XCUIElement, in app: XCUIApplication) -> Bool {
        menu.press(forDuration: 0.12)
        let opened = NSPredicate { [weak self] _, _ in self?.menuIsOpen(app) ?? false }
        let result = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: opened, object: nil)], timeout: 2)
        return result == .completed
    }

    /// Evidence, no pixels: which trailing items are present when we tap.
    private func logToolbar(_ app: XCUIApplication) {
        let arm = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Arm live view'")).count
        let q = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'UNO Q board'")).count
        let live = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Necklace live view'")).count
        let glasses = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Glasses live view'")).count
        let armLabel = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Arm live view'")).firstMatch
        let armState = armLabel.exists ? armLabel.label : "-"
        let line = "toolbar: glasses=\(glasses) arm=\(arm) (\(armState)) unoq=\(q) necklace=\(live)"
        NSLog("[AccountMenuUITests] %@", line)
        let a = XCTAttachment(string: line)
        a.name = "toolbar"
        a.lifetime = .keepAlways
        add(a)
    }

    /// Dismiss by tapping OUTSIDE the menu. The menu hangs from the trailing
    /// edge and spans x≈144–394 pt on a 402 pt phone, so a screen-centre tap
    /// lands INSIDE it (on "More ▸", opening the submenu — which then eats
    /// the next tap and looks exactly like the bug; lesson from 2026-09-09).
    /// The leading edge of the transcript is safely outside.
    /// Every accessibility element in the navigation-bar band (y < 120 pt),
    /// as text: type, frame, identifier, label. The toolbar's true layout
    /// without a screenshot — how we see an overflow "…" or a clipped item.
    private func logNavBar(_ app: XCUIApplication, tag: String) {
        var out: [String] = []
        for l in app.debugDescription.split(separator: "\n") {
            let line = String(l)
            guard let r = line.range(of: #"\{\{[-0-9.]+, ([-0-9.]+)\}, \{[-0-9.]+, ([-0-9.]+)\}\}"#, options: .regularExpression) else { continue }
            let nums = String(line[r]).split(whereSeparator: { !"-0123456789.".contains($0) }).compactMap { Double($0) }
            guard nums.count == 4, nums[1] < 120, nums[3] < 200 else { continue }
            out.append(String(line.trimmingCharacters(in: .whitespaces).prefix(180)))
        }
        let text = "navbar[\(tag)]:\n" + out.joined(separator: "\n")
        for l in out { NSLog("[AccountMenuUITests] NAV[%@] %@", tag, l) }
        let a = XCTAttachment(string: text); a.name = "navbar-\(tag)"; a.lifetime = .keepAlways; add(a)
    }

    private func dismissMenu(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5)).tap()
        sleep(1)
    }

    /// Rate, not a single sample: 8 finger-taps in one signed-in session with
    /// the live toolbar ticking. Anything under 8/8 is the owner's bug.
    func testAccountMenuOpensOnOneTap_8of8() throws {
        try rate8(extraArgs: [])
    }

    /// H1 twin of the rate test: polls off. 8/8 here with a miss above pins
    /// the cause on the device buttons' ticks.
    func testH1_OneTap_8of8_WithoutDevicePolls() throws {
        try rate8(extraArgs: ["-ui-testing-no-device-polls"])
    }

    /// H1 mechanism, camera-independent: the arm publishes a synthetic frame
    /// every 100 ms (UITestFlags.fakeArmFrames) exactly like a live MJPEG
    /// stream. On the pre-fix tree this is the owner's toolbar at full tick.
    func testH1_OneTap_8of8_WithFakeArmFrames() throws {
        try rate8(extraArgs: ["-ui-testing-fake-arm-frames"])
    }

    /// H6: the owner's phone has linked Meta glasses → FIVE trailing items
    /// (glasses, necklace, arm, UNO Q, account) on a 402 pt bar. Simulators
    /// never link glasses, so render that button via a DEBUG flag.
    func testH6_OneTap_8of8_FiveTrailingItems() throws {
        try rate8(extraArgs: ["-ui-testing-fake-glasses-linked"])
    }

    /// H6 + live camera frames together — the phone as it was when reported.
    func testH6_OneTap_8of8_FiveTrailingItemsAndFakeFrames() throws {
        try rate8(extraArgs: ["-ui-testing-fake-glasses-linked", "-ui-testing-fake-arm-frames"])
    }

    private func rate8(extraArgs: [String]) throws {
        let app = Self.makeApp(extraArgs: extraArgs)
        app.launch()
        let menu = app.descendants(matching: .any)["account-menu"].firstMatch
        let present = menu.waitForExistence(timeout: 20)
        if !present { logNavBar(app, tag: "no-account-menu") }
        XCTAssertTrue(present, "toolbar account menu never appeared — signed out, or collapsed into an overflow?")
        sleep(6)
        logToolbar(app)
        logNavBar(app, tag: "steady")
        var opened = 0
        var misses: [Int] = []
        for i in 1...8 {
            if fingerTap(menu, in: app) { opened += 1 } else { misses.append(i) }
            dismissMenu(app)
        }
        let line = "one-tap opened \(opened)/8, misses at \(misses)"
        NSLog("[AccountMenuUITests] %@", line)
        let a = XCTAttachment(string: line); a.name = "rate"; a.lifetime = .keepAlways; add(a)
        XCTAssertEqual(opened, 8, line)
    }

    /// The owner's report, verbatim: default launch, no keyboard, one tap.
    func testAccountMenuOpensOnOneTap() throws {
        XCTAssertTrue(oneTapOpens(), "account menu did not open after ONE tap (owner's double-tap symptom)")
    }

    /// H1 — same tap with the arm/UNO Q live polls disabled (UITestFlags).
    /// Passing here while the default test fails pins the cause on the
    /// device buttons' published ticks re-laying-out the trailing toolbar.
    func testH1_OneTapWithoutDevicePolls() throws {
        XCTAssertTrue(oneTapOpens(extraArgs: ["-ui-testing-no-device-polls"]),
                      "H1: even with device polls off, one tap did not open the menu")
    }

    /// H2 — composer focused (keyboard up) before the tap. Failing here while
    /// the default test passes means the first tap only resigns the keyboard.
    func testH2_OneTapWithKeyboardUp() throws {
        XCTAssertTrue(oneTapOpens(keyboardUp: true),
                      "H2: with the keyboard up, one tap did not open the menu")
    }

    /// Diagnostic twin of the test above: proves the SECOND tap works, so a
    /// failure above is a first-tap-swallowed bug and not a missing menu.
    func testAccountMenuOpensWithinTwoTaps() throws {
        let app = Self.makeApp()
        app.launch()
        let menu = app.descendants(matching: .any)["account-menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 20))
        sleep(3)
        menu.tap()
        if !menuIsOpen(app) {
            sleep(1)
            if !menuIsOpen(app) { menu.tap() }
        }
        let opened = NSPredicate { [weak self] _, _ in self?.menuIsOpen(app) ?? false }
        let result = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: opened, object: nil)], timeout: 3)
        XCTAssertEqual(result, .completed, "account menu never opened, even after two taps")
    }
}

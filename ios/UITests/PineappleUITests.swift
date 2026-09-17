import XCTest
import UIKit

@MainActor final class PineappleUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    private func open(offline: Bool = false, files: Bool = false, flags: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "--devices-sheet-harness", "--pineapple-harness"]
        if offline { app.launchArguments.append("--pineapple-offline") }
        if files { app.launchArguments.append("--pineapple-files") }
        app.launchArguments += flags
        app.launch()
        let link = app.buttons["pineapple-open"]
        let anyLink = app.descendants(matching: .any)["pineapple-open"].firstMatch
        XCTAssertTrue(anyLink.waitForExistence(timeout: 20))
        if link.exists { link.tap() } else { anyLink.tap() }
        XCTAssertTrue(app.navigationBars["Pineapple"].waitForExistence(timeout: 8))
        return app
    }

    private func reveal(_ element: XCUIElement, app: XCUIApplication) {
        for _ in 0..<10 { if element.isHittable { return }; app.swipeUp() }
        XCTAssertTrue(element.isHittable, "Element not reachable: \(element)")
    }
    private func find(_ app: XCUIApplication) {
        let button = app.buttons["pineapple-find-networks"]
        for _ in 0..<6 { if button.exists && button.isHittable { break }; app.swipeDown() }
        reveal(button, app: app); button.tap()
    }
    func testPickerSelectionPopulatesScopeAndRequiresConfirmation() {
        let app = open()
        find(app)
        let first = app.buttons["pineapple-ap-02:00:00:00:00:01"]
        reveal(first, app: app); first.tap()
        let target = app.staticTexts["pineapple-target"]
        reveal(target, app: app)
        XCTAssertTrue(target.label.contains("02:00:00:00:00:01"))
        XCTAssertTrue(target.label.contains("153") && target.label.contains("5765"))
        let start = app.buttons["pineapple-start"]
        reveal(start, app: app); XCTAssertFalse(start.isEnabled)
        let consent = app.switches["pineapple-authorized"]
        reveal(consent, app: app); consent.switches.firstMatch.tap()
        XCTAssertEqual(consent.value as? String, "1")
        XCTAssertTrue(start.isEnabled); start.tap()
        let confirm = app.buttons["Start authorized capture"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["pineapple-stop"].exists, "Selection and opening confirmation never start capture")
        screenshot(app, "pineapple-picker-confirmation")
        app.terminate() // Close the preview confirmation without accepting it.
    }
    func testOffChannelTargetShowsTuningDisclosureAndConfirmation() {
        let app = open(flags: ["--pineapple-offchannel"]); find(app)
        let first = app.buttons["pineapple-ap-02:00:00:00:00:01"]
        reveal(first, app: app); first.tap()
        let plan = app.staticTexts["pineapple-radio-plan"]
        reveal(plan, app: app)
        XCTAssertTrue(plan.label.contains("2437") && plan.label.contains("restore"))
        let start = app.buttons["pineapple-start"]
        reveal(start, app: app); XCTAssertFalse(start.isEnabled)
        let consent = app.switches["pineapple-authorized"]
        reveal(consent, app: app); consent.switches.firstMatch.tap()
        XCTAssertTrue(start.isEnabled); start.tap()
        XCTAssertTrue(app.buttons["Start authorized capture"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Temporarily pause Hak5")).firstMatch.exists)
        app.terminate() // Never accept a wireless Start in preview tests.
    }
    func testMissingPlanCannotStartEvenWithConsent() {
        let app = open(flags: ["--pineapple-no-plan"]); find(app)
        let first = app.buttons["pineapple-ap-02:00:00:00:00:01"]
        reveal(first, app: app); first.tap()
        let consent = app.switches["pineapple-authorized"]
        reveal(consent, app: app); consent.switches.firstMatch.tap()
        let start = app.buttons["pineapple-start"]
        reveal(start, app: app); XCTAssertFalse(start.isEnabled)
    }
    func testAdvancedManualFallbackKeepsExplicitConsentGate() {
        let app = open()
        let manual = app.switches["pineapple-manual"]
        reveal(manual, app: app); manual.switches.firstMatch.tap()
        let field = app.textFields["pineapple-bssid"]
        reveal(field, app: app); XCTAssertTrue(field.exists)
        let start = app.buttons["pineapple-start"]
        reveal(start, app: app); XCTAssertFalse(start.isEnabled)
    }
    func testDuplicateHiddenHostileRowsAndStableSelectionOnRefresh() {
        let app = open()
        find(app)
        let second = app.buttons["pineapple-ap-02:00:00:00:00:02"]
        reveal(second, app: app); second.tap()
        let hostile = app.buttons["pineapple-ap-02:00:00:00:00:03"]
        reveal(hostile, app: app); XCTAssertTrue(hostile.label.contains("$(reboot)"))
        let hidden = app.buttons["pineapple-ap-02:00:00:00:00:04"]
        reveal(hidden, app: app); XCTAssertTrue(hidden.label.contains("Hidden network"))
        for _ in 0..<7 { app.swipeDown() }
        find(app)
        let target = app.staticTexts["pineapple-target"]
        reveal(target, app: app); XCTAssertTrue(target.label.contains("02:00:00:00:00:02"))
        reveal(app.buttons["pineapple-start"], app: app)
        XCTAssertFalse(app.buttons["pineapple-start"].isEnabled)
    }
    func testStaleAndWrongBandTargetsCannotStart() {
        for flag in ["--pineapple-scan-stale", "--pineapple-scan-wrong-band"] {
            let app = open(flags: [flag]); find(app)
            let first = app.buttons["pineapple-ap-02:00:00:00:00:01"]
            reveal(first, app: app); first.tap()
            let reason = app.staticTexts["pineapple-target-reason"]
            reveal(reason, app: app)
            XCTAssertTrue(reason.label.contains("stale") || reason.label.contains("frequency"))
            let consent = app.switches["pineapple-authorized"]
            reveal(consent, app: app); consent.switches.firstMatch.tap()
            XCTAssertEqual(consent.value as? String, "1")
            reveal(app.buttons["pineapple-start"], app: app)
            XCTAssertFalse(app.buttons["pineapple-start"].isEnabled)
            app.terminate()
        }
    }
    func testEmptyUnsupportedAndMissingSelectionStates() {
        for flag in ["--pineapple-scan-empty", "--pineapple-scan-unsupported"] {
            let app = open(flags: [flag]); find(app)
            let id = flag.contains("empty") ? "pineapple-networks-empty" : "pineapple-scan-error"
            reveal(app.staticTexts[id], app: app); XCTAssertTrue(app.staticTexts[id].exists); app.terminate()
        }
        let app = open(flags: ["--pineapple-scan-missing"]); find(app)
        let first = app.buttons["pineapple-ap-02:00:00:00:00:01"]
        reveal(first, app: app); first.tap()
        find(app)
        let reason = app.staticTexts["pineapple-target-reason"]
        reveal(reason, app: app); XCTAssertTrue(reason.label.contains("no longer"))
        let target = app.staticTexts["pineapple-target"]
        XCTAssertTrue(target.label.contains("02:00:00:00:00:01"), "Do not silently switch APs")
    }

    /// Geometry/hit-testing evidence, not a claim of visual screenshot review.
    private func assertContained(_ element: XCUIElement, in app: XCUIApplication) {
        let window = app.windows.firstMatch.frame
        let frame = element.frame
        XCTAssertTrue(element.isHittable, "Control must be reachable")
        XCTAssertGreaterThan(frame.width, 0)
        XCTAssertGreaterThan(frame.height, 0)
        XCTAssertGreaterThanOrEqual(frame.minX, window.minX - 1)
        XCTAssertLessThanOrEqual(frame.maxX, window.maxX + 1)
        XCTAssertGreaterThanOrEqual(frame.minY, window.minY - 1)
        XCTAssertLessThanOrEqual(frame.maxY, window.maxY + 1)
    }

    func testCriticalControlsFitPortraitAndLandscape() {
        defer { XCUIDevice.shared.orientation = .portrait }
        for orientation: UIDeviceOrientation in [.portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            let app = open()
            let find = app.buttons["pineapple-find-networks"]
            reveal(find, app: app); assertContained(find, in: app)
            let start = app.buttons["pineapple-start"]
            reveal(start, app: app); assertContained(start, in: app)
            XCTAssertFalse(start.isEnabled, "Rotation never grants capture permission")
            let consent = app.switches["pineapple-authorized"]
            reveal(consent, app: app); assertContained(consent, in: app)
            print("PINEAPPLE_LAYOUT orientation=\(orientation.rawValue) window=\(app.windows.firstMatch.frame) start=\(start.frame)")
            app.terminate()
        }
    }

    func testAccessibilityTextSizeKeepsCaptureGateReachable() {
        let app = open(flags: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let start = app.buttons["pineapple-start"]
        reveal(start, app: app); assertContained(start, in: app)
        XCTAssertFalse(start.isEnabled)
        let consent = app.switches["pineapple-authorized"]
        reveal(consent, app: app); assertContained(consent, in: app)
        app.terminate()
    }

    private func screenshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testDedicatedScreenFromDeviceRowAndConsentGate() {
        let app = open()
        print("PINEAPPLE_ACCESSIBILITY_TREE\n" + app.debugDescription)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "55%")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["wlan1mon"].exists)
        screenshot(app, "pineapple-overview")
        let start = app.buttons["pineapple-start"]
        reveal(start, app: app)
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        XCTAssertFalse(start.isEnabled, "No capture without a target and explicit permission")
        screenshot(app, "pineapple-capture-empty")
    }
    func testOfflineDoesNotQueueStartOrGuessReason() {
        let app = open(offline: true)
        let reason = app.staticTexts["pineapple-offline-reason"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5))
        XCTAssertTrue(reason.label.contains("unknown"))
        reveal(app.buttons["pineapple-start"], app: app)
        reveal(app.buttons["pineapple-start"], app: app)
        XCTAssertFalse(app.buttons["pineapple-start"].isEnabled)
        screenshot(app, "pineapple-offline")
    }
    func testDownloadConfirmationAndSystemShareSheet() {
        let app = open(files: true)
        let download = app.buttons["Download"]
        for _ in 0..<4 { if download.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(download.waitForExistence(timeout: 5)); download.tap()
        let transfer = app.buttons["Transfer to this device"]
        XCTAssertTrue(transfer.waitForExistence(timeout: 5)); transfer.tap()
        let share = app.buttons["pineapple-share"]
        for _ in 0..<3 { if share.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(share.waitForExistence(timeout: 5)); share.tap()
        print("PINEAPPLE_SHARE_TREE\n" + app.debugDescription)
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS[cd] %@", "Save to Files")).firstMatch.waitForExistence(timeout: 5))
        screenshot(app, "pineapple-system-share")
        // Do not select a person/app or send anything. Fixture UI proof only.
    }

}

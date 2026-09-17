/**
 * StickyTouchTests — the remote-touch math and the receipt reader.
 *
 * Wire truth (tiny_node.cpp:1157): `tap <x> <y>` is PANEL coordinates, the
 * screenshot's own system, 800×480 landscape. The mirror renders aspect-fit
 * with no letterbox (view hugs the image), so the mapping is one scale
 * factor per axis — and the tests pin the edges, where off-by-one puts a
 * finger out of bounds.
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct StickyTouchTests {

    // ── Coordinate mapping ───────────────────────────────────────────────────

    @Test func centerOfViewIsCenterOfPanel() {
        let p = StickyTouch.panelPoint(view: .init(x: 200, y: 120),
                                       viewSize: .init(width: 400, height: 240))
        #expect(p?.x == 400 && p?.y == 240)
    }

    @Test func originMapsToOrigin() {
        let p = StickyTouch.panelPoint(view: .zero,
                                       viewSize: .init(width: 400, height: 240))
        #expect(p?.x == 0 && p?.y == 0)
    }

    /// The view's far corner is the panel's last PIXEL — 799,479, never
    /// 800,480 (which the resolver would refuse as out of range).
    @Test func farCornerClampsToLastPixel() {
        let p = StickyTouch.panelPoint(view: .init(x: 400, y: 240),
                                       viewSize: .init(width: 400, height: 240))
        #expect(p?.x == 799 && p?.y == 479)
    }

    @Test func fullSizeViewIsIdentityMapping() {
        let p = StickyTouch.panelPoint(view: .init(x: 123, y: 45),
                                       viewSize: .init(width: 800, height: 480))
        #expect(p?.x == 123 && p?.y == 45)
    }

    /// A pixel of slop outside the view (finger rolls off the edge mid-tap)
    /// clamps in; a genuinely stray touch far outside is refused.
    @Test func slopClampsButStraysRefuse() {
        let size = CGSize(width: 800, height: 480)
        #expect(StickyTouch.panelPoint(view: .init(x: -0.5, y: 10),
                                       viewSize: size)?.x == 0)
        #expect(StickyTouch.panelPoint(view: .init(x: -50, y: 10),
                                       viewSize: size) == nil)
    }

    /// First layout pass: no size yet → no guess, the tap is dropped.
    @Test func zeroSizedViewRefusesToMap() {
        #expect(StickyTouch.panelPoint(view: .init(x: 10, y: 10),
                                       viewSize: .zero) == nil)
    }

    // ── Gesture classification (the firmware's 24px slop, client-side) ──────

    /// Travel is measured in PANEL space: on a half-size mirror, 20 view
    /// points is 40 panel px — past slop, a swipe. The same 20 points on a
    /// full-size mirror is within slop — a tap.
    @Test func travelIsClassifiedInPanelSpaceNotViewSpace() {
        let half = CGSize(width: 400, height: 240)
        let full = CGSize(width: 800, height: 480)
        #expect(StickyTouch.gestureCommand(from: .init(x: 100, y: 100),
                                           to: .init(x: 120, y: 100),
                                           viewSize: half)
                == "swipe 200 200 240 200")
        #expect(StickyTouch.gestureCommand(from: .init(x: 100, y: 100),
                                           to: .init(x: 120, y: 100),
                                           viewSize: full)
                == "tap 100 100")
    }

    /// Exactly at slop is still a tap (the firmware refuses swipes at
    /// sub-slop travel; 24 is the last tap, 25 the first swipe).
    @Test func slopBoundaryIsTheLastTap() {
        let full = CGSize(width: 800, height: 480)
        #expect(StickyTouch.gestureCommand(from: .init(x: 100, y: 100),
                                           to: .init(x: 124, y: 100),
                                           viewSize: full)
                == "tap 100 100")
        #expect(StickyTouch.gestureCommand(from: .init(x: 100, y: 100),
                                           to: .init(x: 125, y: 100),
                                           viewSize: full)
                == "swipe 100 100 125 100")
    }

    @Test func subSlopTapLandsAtTheStartPoint() {
        // The finger drifted 10px — the INTENT was the down-point.
        #expect(StickyTouch.gestureCommand(from: .init(x: 50, y: 50),
                                           to: .init(x: 60, y: 50),
                                           viewSize: .init(width: 800, height: 480))
                == "tap 50 50")
    }

    /// A swipe that exits the view clamps its END to the panel edge — a
    /// real edge-swipe does exactly that — while a stray START still refuses.
    @Test func swipeEndClampsButStartMustMap() {
        let full = CGSize(width: 800, height: 480)
        #expect(StickyTouch.gestureCommand(from: .init(x: 700, y: 240),
                                           to: .init(x: 900, y: 240),
                                           viewSize: full)
                == "swipe 700 240 799 240")
        #expect(StickyTouch.gestureCommand(from: .init(x: -50, y: 240),
                                           to: .init(x: 100, y: 240),
                                           viewSize: full) == nil)
    }

    @Test func zeroSizedViewRefusesGesturesToo() {
        #expect(StickyTouch.gestureCommand(from: .init(x: 1, y: 1),
                                           to: .init(x: 99, y: 99),
                                           viewSize: .zero) == nil)
    }

    // ── Receipt reading ──────────────────────────────────────────────────────

    @Test func fullReceiptBecomesOneLine() {
        let payload = """
        {"tap":[400,240],"rotation":0,"accepted":"ESP_OK","routed":true,\
        "card_id":"home","summary":"tapped 400,240 at 0 deg -> ESP_OK, route completed"}
        """
        let line = StickyTouch.receiptLine(payload)
        #expect(line == "tapped 400,240 → home")
    }

    /// The firmware's own semantics, preserved: routed:false is "still
    /// running", never "lost" — a BLE-scan tap blocks ~8s.
    @Test func unroutedReceiptSaysNotLost() {
        let payload = #"{"tap":[10,20],"routed":false,"card_id":"wifi"}"#
        let line = StickyTouch.receiptLine(payload)
        #expect(line.contains("not lost"))
        #expect(line.contains("10,20") && line.contains("wifi"))
    }

    @Test func emptyCardIdIsOmittedNotShownBlank() {
        let payload = #"{"tap":[1,2],"routed":true,"card_id":""}"#
        let line = StickyTouch.receiptLine(payload)
        #expect(!line.contains("→"))
    }

    @Test func swipeReceiptBecomesOneLine() {
        let payload = #"{"swipe":[100,240,700,240],"routed":true,"card_id":"gallery"}"#
        #expect(StickyTouch.receiptLine(payload)
                == "swiped (100,240)→(700,240) → gallery")
    }

    /// Not the tap shape → fall through to the generic reply reader, so an
    /// older firmware's plain-text answer still shows as itself.
    @Test func nonReceiptPayloadFallsBackToGenericText() {
        #expect(StickyTouch.receiptLine(#"{"error":"usage: tap <x> <y>"}"#)
                == "usage: tap <x> <y>")
        #expect(StickyTouch.receiptLine(#""ok""#) == "ok")
    }
}

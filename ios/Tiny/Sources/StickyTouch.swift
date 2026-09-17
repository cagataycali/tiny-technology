/**
 * 👆 StickyTouch — the mirror as a remote touchscreen.
 *
 * The firmware's `tap <x> <y>` verb (tiny_node.cpp:1157, read 2026-08-26)
 * takes PANEL coordinates — "the screenshot's own coordinate system" — and
 * pushes the point through the same resolver a real finger uses, replying
 * with a route-time receipt: {"tap":[x,y], "routed":bool, "card_id":"…",
 * "summary":"…"}. So a tap on the phone's mirror image IS a tap on the
 * glass, if the phone maps its view point back to panel pixels correctly.
 *
 * That mapping is the whole trick, and it is pure: the mirror renders
 * aspect-FIT (never cropped — the panel must not lie), so the displayed
 * image and the view rect share a corner and a single scale factor.
 * `panelPoint` divides by that scale, rounds, and clamps edge touches
 * (a finger on the last pixel row lands AT 479, not out of bounds at 480).
 *
 * The receipt matters as much as the send: "routed":false means the route
 * was still running at reply time — NOT that the tap was lost (a BLE-scan
 * tap blocks ~8s) — and the firmware says card_id is display-time. The
 * reader turns that into one honest line instead of raw JSON in a footer.
 */
import Foundation
import CoreGraphics

enum StickyTouch {
    /// The Sticky's panel, landscape native (SSD1677).
    static let panel = CGSize(width: 800, height: 480)

    /// The firmware's own tap slop (tiny_touch.cpp kTapSlop): a finger may
    /// drift this many PANEL pixels and still mean a tap. The classifier on
    /// the device REFUSES a sub-slop `swipe` (INVALID_SIZE) rather than
    /// downgrading it — so the client makes the same call a finger's release
    /// classifier would, BEFORE choosing which verb to send.
    static let tapSlop = 24.0

    /// View point → panel point, for an aspect-FIT rendering where the view
    /// rect IS the fitted image (SwiftUI `.fit` + width-hugging frame — the
    /// view's height follows the image, so there is no letterbox offset).
    /// Nil when the view has no size yet (first layout pass) — a tap that
    /// early has nothing to map against and must be dropped, not guessed.
    static func panelPoint(view: CGPoint, viewSize: CGSize,
                           panel: CGSize = panel) -> (x: Int, y: Int)? {
        guard viewSize.width > 0, viewSize.height > 0 else { return nil }
        let scaleX = panel.width / viewSize.width
        let scaleY = panel.height / viewSize.height
        let x = Int((view.x * scaleX).rounded())
        let y = Int((view.y * scaleY).rounded())
        // Clamp the edges: a finger on the view's last point maps to the
        // panel's last PIXEL (479/799), not one past it. Anything further
        // out than a pixel of slop is a stray touch and refused.
        guard x >= -1, x <= Int(panel.width), y >= -1, y <= Int(panel.height)
        else { return nil }
        return (min(max(x, 0), Int(panel.width) - 1),
                min(max(y, 0), Int(panel.height) - 1))
    }

    /// A finished drag on the mirror → the verb a finger would have meant.
    /// Sub-slop travel (in PANEL space — a short flick on a small mirror can
    /// still clear 24 panel px) is a tap at the START point; anything longer
    /// is a swipe. The start must map (a stray touch refuses); the END merely
    /// clamps, because a real swipe legitimately exits the view mid-gesture.
    static func gestureCommand(from: CGPoint, to: CGPoint, viewSize: CGSize,
                               panel: CGSize = panel) -> String? {
        guard let a = panelPoint(view: from, viewSize: viewSize, panel: panel)
        else { return nil }
        let scaleX = panel.width / viewSize.width
        let scaleY = panel.height / viewSize.height
        let bx = min(max(Int((to.x * scaleX).rounded()), 0), Int(panel.width) - 1)
        let by = min(max(Int((to.y * scaleY).rounded()), 0), Int(panel.height) - 1)
        let travel = ((Double(bx - a.x) * Double(bx - a.x)) +
                      (Double(by - a.y) * Double(by - a.y))).squareRoot()
        return travel <= tapSlop ? "tap \(a.x) \(a.y)"
                                 : "swipe \(a.x) \(a.y) \(bx) \(by)"
    }

    /// The receipt, as one line for the footer. Falls back to RelayReply's
    /// generic extraction when the payload isn't the tap shape (an older
    /// firmware, or an error sentence).
    static func receiptLine(_ payload: String) -> String {
        guard let obj = try? JSONSerialization.jsonObject(
                  with: Data(payload.utf8), options: [.fragmentsAllowed]),
              let d = obj as? [String: Any]
        else { return RelayReply.text(payload) }

        let card = (d["card_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let routed = d["routed"] as? Bool ?? false
        var line: String
        if let tap = d["tap"] as? [Any], tap.count == 2 {
            line = "tapped \(tap[0]),\(tap[1])"
        } else if let sw = d["swipe"] as? [Any], sw.count == 4 {
            line = "swiped (\(sw[0]),\(sw[1]))→(\(sw[2]),\(sw[3]))"
        } else {
            return RelayReply.text(payload)
        }
        if let card { line += " → \(card)" }
        // The firmware's own semantics: false = still running, not lost.
        line += routed ? "" : " (still routing — not lost)"
        return line
    }
}

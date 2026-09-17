/**
 * TopBarPlanTests + BodyPresenceTests — the presence-driven top bar's pure parts.
 *
 * Widths are the real ones: 402 pt (iPhone 16 Pro / owner's phone), 393 pt
 * (iPhone 15/16), 375 pt (SE / mini). The invariant that matters: the planner
 * NEVER asks for more width than the bar has, so iOS 26 never evicts the capsule.
 */
import Testing
import Foundation
import UIKit
@testable import Tiny

@Suite struct TopBarPlanTests {

    private let cams: [BodyId] = [.reachy, .scout, .fomo, .necklace, .glasses]

    @Test func budgetsAreSane() {
        #expect(TopBarPlan.available(screenWidth: 402) == 166)
        #expect(TopBarPlan.available(screenWidth: 393) == 157)
        #expect(TopBarPlan.available(screenWidth: 375) == 139)
        #expect(TopBarPlan.available(screenWidth: 100) == 0)
    }

    @Test func nothingOnlineNothingInline() {
        let p = TopBarPlan.make(online: [], screenWidth: 402)
        #expect(p == TopBarPlan.Plan())
    }

    @Test func oneBodyAlwaysInlineOnEveryPhone() {
        for w in [402.0, 393.0, 375.0] {
            for id in BodyId.allCases {
                let p = TopBarPlan.make(online: [id], screenWidth: w)
                #expect(p.inline == [id], "\(id) at \(w)")
                #expect(p.overflow.isEmpty)
            }
        }
    }

    @Test func threeCameraBodiesFitInlineOnOwnersPhone() {
        // The owner's showcase: Fomo + Reachy + Scout online at once, all in the bar.
        let p = TopBarPlan.make(online: [.reachy, .scout, .fomo], screenWidth: 402)
        #expect(p.inline == [.reachy, .scout, .fomo])
        #expect(p.overflow.isEmpty)
        // …and on a 393 pt phone too.
        let q = TopBarPlan.make(online: [.reachy, .scout, .fomo], screenWidth: 393)
        #expect(q.inline.count == 3)
    }

    @Test func smallPhoneSpillsTheThird() {
        let p = TopBarPlan.make(online: [.reachy, .scout, .fomo], screenWidth: 375)
        #expect(p.inline == [.reachy, .scout])
        #expect(p.overflow == [.fomo])
    }

    @Test func fourthBodyOverflowsAndOrderIsPreserved() {
        let p = TopBarPlan.make(online: [.reachy, .scout, .fomo, .qBrain], screenWidth: 402)
        #expect(p.inline == [.reachy, .scout, .fomo])
        #expect(p.overflow == [.qBrain])
        #expect(p.overflowCount == 1)
    }

    @Test func glyphTileDoesNotJumpAheadOfCameraTile() {
        // qBrain (30 pt) would fit after 3 cameras spilled fomo at 375 — it must
        // NOT be pulled forward past fomo: positions stay stable.
        let p = TopBarPlan.make(online: [.reachy, .scout, .fomo, .qBrain], screenWidth: 375)
        #expect(p.inline == [.reachy, .scout])
        #expect(p.overflow == [.fomo, .qBrain])
    }

    @Test func allSixOnlineNeverExceedsBudget() {
        let all: [BodyId] = [.reachy, .scout, .fomo, .necklace, .glasses, .qBrain]
        for w in [402.0, 393.0, 375.0] {
            let p = TopBarPlan.make(online: all, screenWidth: w)
            #expect(TopBarPlan.inlineWidth(p.inline) <= TopBarPlan.available(screenWidth: w), "\(w)")
            #expect(p.inline.count + p.overflow.count == 6)
            #expect(Set(p.inline).isDisjoint(with: p.overflow))
            // compact phones: at most 3 tiles + the menu = 4 items
            #expect(p.inline.count <= 3, "\(w)")
            #expect(p.overflowCount >= 3)
        }
    }

    @Test func everyCountZeroToSixStaysWithinBudget() {
        let all: [BodyId] = [.reachy, .scout, .fomo, .necklace, .glasses, .qBrain]
        for w in [402.0, 393.0, 375.0] {
            for n in 0...6 {
                let online = Array(all.prefix(n))
                let p = TopBarPlan.make(online: online, screenWidth: w)
                #expect(TopBarPlan.inlineWidth(p.inline) <= TopBarPlan.available(screenWidth: w), "n=\(n) w=\(w)")
                #expect(p.inline + p.overflow == online, "order preserved n=\(n) w=\(w)")
            }
        }
    }

    @Test func iPadRegularWidthShowsEverythingInline() {
        let all: [BodyId] = [.reachy, .scout, .fomo, .necklace, .glasses, .qBrain]
        let p = TopBarPlan.make(online: all, screenWidth: 1024)
        #expect(p.inline == all)
        #expect(p.overflow.isEmpty)
    }
}

@Suite struct BodyPresenceCoreTests {
    typealias Core = BodyPresenceCore

    private func solid(_ w: Int, _ h: Int) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: {
            let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        }
    }

    @Test func goingOnlineStampsOnceAndStaysStable() {
        let t0 = Date(timeIntervalSince1970: 1000), t1 = t0.addingTimeInterval(5)
        var r = Core.Row(id: .reachy)
        #expect(!r.isOnline && r.onlineSince == nil)
        r = Core.transition(r, online: true, now: t0)
        #expect(r.isOnline && r.onlineSince == t0)
        r = Core.transition(r, online: true, now: t1)
        #expect(r.onlineSince == t0, "staying online must not re-stamp (tiles would reshuffle)")
    }

    @Test func goingOfflineClearsThumbAndFps() {
        var r = Core.Row(id: .scout)
        r = Core.transition(r, online: true, now: Date())
        r.thumb = solid(92, 60); r.thumbAt = Date(); r.fpsText = "2 fps"
        r = Core.transition(r, online: false, now: Date())
        #expect(!r.isOnline && r.onlineSince == nil && r.thumb == nil && r.thumbAt == nil && r.fpsText == "")
    }

    @Test func onlineOrderIsPictureFirstThenNewestThenDeclaration() {
        let t0 = Date(timeIntervalSince1970: 1000)
        var rows: [BodyId: Core.Row] = Dictionary(uniqueKeysWithValues: BodyId.allCases.map { ($0, Core.Row(id: $0)) })
        rows[.fomo] = Core.transition(rows[.fomo]!, online: true, now: t0)
        rows[.reachy] = Core.transition(rows[.reachy]!, online: true, now: t0.addingTimeInterval(10))
        rows[.scout] = Core.transition(rows[.scout]!, online: true, now: t0.addingTimeInterval(10))
        rows[.qBrain] = Core.transition(rows[.qBrain]!, online: true, now: t0.addingTimeInterval(30))
        rows[.glasses] = Core.transition(rows[.glasses]!, online: true, now: t0.addingTimeInterval(40))
        // no thumbnails yet: camera bodies first (newest glasses, then scout/reachy
        // tie → declaration order, then fomo), the glyph-only Q last even though newest
        #expect(Core.online(rows) == [.glasses, .scout, .reachy, .fomo, .qBrain])
        // a live picture promotes fomo to the front
        rows[.fomo]!.thumb = solid(92, 60)
        #expect(Core.online(rows) == [.fomo, .glasses, .scout, .reachy, .qBrain])
        rows[.reachy] = Core.transition(rows[.reachy]!, online: false, now: t0.addingTimeInterval(50))
        #expect(Core.online(rows) == [.fomo, .glasses, .scout, .qBrain])
    }

    @Test func rankPrefersPicturesOverGlyphs() {
        var cam = Core.Row(id: .scout), glyph = Core.Row(id: .qBrain)
        #expect(Core.rank(cam) == 2 && Core.rank(glyph) == 0)
        cam.thumb = solid(92, 60); glyph.thumb = solid(92, 60)
        #expect(Core.rank(cam) == 3 && Core.rank(glyph) == 1)
    }

    @Test func thumbThrottleIsTwoFps() {
        let t0 = Date()
        #expect(Core.wantsThumb(lastAt: nil, now: t0))
        #expect(!Core.wantsThumb(lastAt: t0, now: t0.addingTimeInterval(0.2)))
        #expect(Core.wantsThumb(lastAt: t0, now: t0.addingTimeInterval(0.5)))
    }

    @Test func fpsWords() {
        #expect(Core.fpsText(nil) == "")
        #expect(Core.fpsText(0) == "")
        #expect(Core.fpsText(12.3) == "12 fps")
        #expect(Core.fpsText(0.5) == "0.5 fps")
    }

    @Test func thumbSizeCapsWidthKeepsAspectNeverUpscales() {
        #expect(Core.thumbSize(for: CGSize(width: 1280, height: 720)) == CGSize(width: 92, height: 52))
        #expect(Core.thumbSize(for: CGSize(width: 640, height: 480)) == CGSize(width: 92, height: 69))
        #expect(Core.thumbSize(for: CGSize(width: 40, height: 30)) == CGSize(width: 40, height: 30))
        #expect(Core.thumbSize(for: .zero) == .zero)
    }

    @Test func downsampleImageIsAtMost92Wide() {
        let out = Core.downsample(image: solid(640, 480))
        #expect(out != nil)
        #expect(out!.cgImage!.width == 92)
        #expect(out!.cgImage!.height == 69)
    }

    @Test func downsampleJPEGIsAtMost92OnTheLongEdge() {
        let jpeg = solid(1280, 720).jpegData(compressionQuality: 0.6)!
        let out = Core.downsample(jpeg: jpeg)
        #expect(out != nil)
        #expect(out!.cgImage!.width <= 92)
        #expect(out!.cgImage!.height <= 92)
        #expect(out!.cgImage!.width == 92)
        #expect(Core.downsample(jpeg: Data("not a jpeg".utf8)) == nil)
    }

    @Test @MainActor func registryObserveAndOfferTransitions() async throws {
        let p = BodyPresence.shared
        p.resetForTesting()
        #expect(p.online.isEmpty)
        let t0 = Date(timeIntervalSince1970: 5000)
        p.observe(.reachy, online: true, fps: 12, now: t0)
        p.observe(.scout, online: true, fps: 2, now: t0.addingTimeInterval(1))
        #expect(p.online == [.scout, .reachy])
        #expect(p.row(.reachy).fpsText == "12 fps")
        // offline body: offer is ignored
        p.offer(.fomo, jpeg: solid(320, 240).jpegData(compressionQuality: 0.5)!)
        // online body: thumbnail lands, downsampled, off-main
        p.offer(.reachy, jpeg: solid(1280, 720).jpegData(compressionQuality: 0.5)!, now: t0)
        var tries = 0
        while p.row(.reachy).thumb == nil, tries < 100 { try await Task.sleep(for: .milliseconds(20)); tries += 1 }
        #expect(p.row(.reachy).thumb?.cgImage?.width == 92)
        #expect(p.row(.fomo).thumb == nil)
        // going offline clears the thumbnail
        p.observe(.reachy, online: false, now: t0.addingTimeInterval(30))
        #expect(p.online == [.scout])
        #expect(p.row(.reachy).thumb == nil)
        p.resetForTesting()
    }

}

@Suite struct BodyPresenceGlassesTests {
    /// Glasses POV: the thumbnail exists only while the stream runs; stopping
    /// clears it (tile → glyph) while the body stays online, unlike going
    /// offline which also clears onlineSince.
    @Test @MainActor func clearThumbKeepsOnlineButDropsPicture() async throws {
        let p = BodyPresence.shared
        p.resetForTesting()
        let t0 = Date(timeIntervalSince1970: 5000)
        p.observe(.glasses, online: true, now: t0)
        let img = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { ctx in
            UIColor.systemPink.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
        p.offer(.glasses, image: img, now: t0.addingTimeInterval(1))
        for _ in 0..<50 where p.row(.glasses).thumb == nil { try await Task.sleep(for: .milliseconds(20)) }
        #expect(p.row(.glasses).thumb != nil)
        p.clearThumb(.glasses)
        let r = p.row(.glasses)
        #expect(r.thumb == nil && r.thumbAt == nil && r.isOnline && r.onlineSince == t0)
        p.resetForTesting()
    }
}

@Suite struct TopBarColumnWidthTests {
    /// iPad split view: the plan must budget the DETAIL column, not the screen.
    /// 524 pt column (13" iPad, sidebar open) with six bodies online → five
    /// camera tiles inline, the Q glyph overflows, title keeps its 88 pt.
    @Test @MainActor func ipadDetailColumnWinsOverScreen() {
        #expect(TopBarStrip.barWidth(column: 524, regular: true) == 524)
        #expect(TopBarStrip.barWidth(column: 0, regular: false) >= 320, "unknown column → screen fallback")
        let online: [BodyId] = [.reachy, .scout, .fomo, .glasses, .necklace, .qBrain]
        let plan = TopBarPlan.make(online: online, screenWidth: 524)
        #expect(plan.inline.count == 5 && plan.overflow == [.qBrain])
        #expect(TopBarPlan.inlineWidth(plan.inline) <= TopBarPlan.available(screenWidth: 524))
        // Full 1032 pt iPad width: everything inline.
        #expect(TopBarPlan.make(online: online, screenWidth: 1032).overflow.isEmpty)
    }
}

@Suite struct IdleRateTests {
    /// Step 6: viewers refcount — cards/screens retain, tile-only = 0, never negative.
    @Test @MainActor func viewersRefcountClampsAtZero() {
        let m = BodyManager.reachy
        let base = m.viewers
        m.retainViewer(); m.retainViewer()
        #expect(m.viewers == base + 2)
        m.releaseViewer(); m.releaseViewer(); m.releaseViewer()
        #expect(m.viewers == 0)
        let a = ArmManager.shared
        a.retainViewer(); a.releaseViewer(); a.releaseViewer()
        #expect(a.viewers == 0)
        #expect(BodyManager.scoutIdleFrameEveryMs > BodyManager.scoutFrameEveryMs)
        #expect(ArmManager.idleSnapshotEvery == BodyManager.idleSnapshotEvery)
    }
}

// ── BodyPiPOverlay geometry ─────────────────────────────────────────────────

@Suite struct BodyPiPTests {
    @Test func twoBodyThumbsFitAbreastOnAPhone() {
        let a = BodyPiPOverlay.picture(size: .thumb, in: 402)
        #expect(a.width == 189 && a.height == 142)
        #expect(a.width * 2 + 24 <= 402)
        // iPad: capped at the arm's 236 pt
        #expect(BodyPiPOverlay.picture(size: .thumb, in: 1024).width == 236)
        // half = the arm's own half-size geometry
        #expect(BodyPiPOverlay.picture(size: .half, in: 402) == FomoPiPSize.half.picture(in: 402))
    }

    @Test func bodyPiPDefaultCornersDiffer() {
        #expect(BodyPiPPrefs.defaultCorner(.scout) != BodyPiPPrefs.defaultCorner(.reachy))
        #expect(!BodyPiPPrefs.defaultCorner(.scout).isTop && !BodyPiPPrefs.defaultCorner(.reachy).isTop)
        #expect(BodyPiPPrefs.key(.scout, "corner") == "body.scout.pip.corner")
    }
}

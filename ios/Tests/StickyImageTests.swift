/**
 * StickyImageTests — the dither pipeline's pure half, and the gate.
 *
 * The wire contract under test (StickyImage.swift, commitment 2): the bytes
 * that leave the phone contain ONLY values the e-ink panel can paint —
 * {0,255} in 1-bit mode, {0,85,170,255} in 4-gray — because the firmware's
 * `image` blit maps levels, it does not dither. And the gate (commitment 3):
 * absent or old grammar_version keeps the send button honest-closed.
 */
import Testing
import Foundation
import UIKit
@testable import Tiny

@Suite struct StickyDitherTests {

    // ── Floyd–Steinberg output domain ────────────────────────────────────────

    @Test func oneBitOutputIsOnlyBlackAndWhite() {
        let w = 16, h = 16
        // A gray ramp — the hardest input: every value is between the levels.
        let gray = (0 ..< w * h).map { UInt8(($0 * 255) / (w * h - 1)) }
        let out = StickyDither.floydSteinberg(gray, w: w, h: h, levels: 2)
        #expect(Set(out).isSubset(of: [0, 255]))
        #expect(out.count == w * h)
    }

    @Test func fourGrayOutputIsOnlyTheFourLevels() {
        let w = 16, h = 16
        let gray = (0 ..< w * h).map { UInt8(($0 * 255) / (w * h - 1)) }
        let out = StickyDither.floydSteinberg(gray, w: w, h: h, levels: 4)
        #expect(Set(out).isSubset(of: [0, 85, 170, 255]))
    }

    /// Error diffusion must PRESERVE the mean, not just quantize — that is
    /// the whole point of dithering. A mid-gray field should come out about
    /// half black, half white, not all one or the other.
    @Test func ditheringPreservesMidGrayCoverage() {
        let w = 64, h = 64
        let gray = [UInt8](repeating: 128, count: w * h)
        let out = StickyDither.floydSteinberg(gray, w: w, h: h, levels: 2)
        let whites = out.filter { $0 == 255 }.count
        let ratio = Double(whites) / Double(out.count)
        #expect(ratio > 0.4 && ratio < 0.6, "mid-gray dithered to \(ratio) white")
    }

    @Test func pureBlackAndWhiteSurviveUntouched() {
        let w = 8, h = 8
        let black = [UInt8](repeating: 0, count: w * h)
        let white = [UInt8](repeating: 255, count: w * h)
        #expect(StickyDither.floydSteinberg(black, w: w, h: h, levels: 2).allSatisfy { $0 == 0 })
        #expect(StickyDither.floydSteinberg(white, w: w, h: h, levels: 2).allSatisfy { $0 == 255 })
    }

    /// A mismatched buffer is returned as-is rather than crashing or padding —
    /// the caller built it wrong, and garbage-in must not become a blit.
    @Test func sizeMismatchIsRefused() {
        let out = StickyDither.floydSteinberg([1, 2, 3], w: 800, h: 480, levels: 2)
        #expect(out == [1, 2, 3])
    }

    // ── Letterbox raster ─────────────────────────────────────────────────────

    @Test func letterboxIsPanelSizedAndPadsWithWhite() {
        // A 100×100 black square into 800×480: aspect-fit → 480×480 centered,
        // with white bars left and right. Corners must be WHITE (the padding),
        // center must be BLACK (the photo).
        let r = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 100))
        let img = r.image { ctx in
            UIColor.black.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        }
        let gray = StickyDither.grayLetterbox(img)
        #expect(gray != nil)
        guard let gray else { return }
        #expect(gray.count == StickyDither.panelW * StickyDither.panelH)
        #expect(gray[0] > 200, "top-left corner should be white padding")
        let center = (StickyDither.panelH / 2) * StickyDither.panelW + StickyDither.panelW / 2
        #expect(gray[center] < 50, "center should be the black photo")
    }

    @Test func prepareProducesContractExactFrames() {
        let r = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 200))
        let img = r.image { ctx in
            UIColor.gray.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 300, height: 200))
        }
        let one = StickyDither.prepare(img, mode: .oneBit)
        let four = StickyDither.prepare(img, mode: .fourGray)
        #expect(one != nil && four != nil)
        guard let one, let four else { return }
        #expect(Int(one.preview.size.width * one.preview.scale) == StickyDither.panelW)
        #expect(Int(one.preview.size.height * one.preview.scale) == StickyDither.panelH)
        // LENGTH IS THE FORMAT on device: 48000 = 1-bit, 96000 = gray4.
        // Anything else is refused by tiny_display_fetch_raw before the blit.
        #expect(one.raw.count == 48000)
        #expect(four.raw.count == 96000)
    }

    // ── Raw wire packing (the bytes the DEVICE reads) ────────────────────────

    /// 1-bit contract (tiny_display.cpp render_image_card): MSB-first, bit
    /// SET = WHITE — `black = !(buf[bit/8] & (0x80 >> bit%8))`.
    @Test func pack1bitMatchesTheFirmwaresBitOrder() {
        let w = 800, h = 480
        var px = [UInt8](repeating: 0, count: w * h)   // all black
        px[0] = 255        // pixel (0,0) white → bit 7 of byte 0
        px[9] = 255        // pixel (9,0) white → bit 6 of byte 1
        let out = StickyDither.pack1bit(px, w: w, h: h)
        #expect(out?.count == 48000)
        guard let out else { return }
        #expect(out[0] == 0b1000_0000)
        #expect(out[1] == 0b0100_0000)
        #expect(out[2] == 0)
    }

    /// gray4 contract (canvas.cpp draw_pixel, memcpy'd on device): 2bpp,
    /// pixel x at bits (3-(x&3))*2, values 0=Black 1=Dark 2=Light 3=White.
    @Test func packGray4MatchesTheCanvasLayout() {
        let w = 800, h = 480
        var px = [UInt8](repeating: 0, count: w * h)
        px[0] = 255   // White → 3 at bits 7-6
        px[1] = 170   // LightGray → 2 at bits 5-4
        px[2] = 85    // DarkGray → 1 at bits 3-2
        px[3] = 0     // Black → 0 at bits 1-0
        let out = StickyDither.packGray4(px, w: w, h: h)
        #expect(out?.count == 96000)
        guard let out else { return }
        #expect(out[0] == 0b11_10_01_00)
        #expect(out[1] == 0)
    }

    @Test func packersRefuseMismatchedBuffers() {
        #expect(StickyDither.pack1bit([0, 255, 0], w: 800, h: 480) == nil)
        #expect(StickyDither.packGray4([0, 255, 0], w: 800, h: 480) == nil)
    }

    // ── The wire prompt ──────────────────────────────────────────────────────

    @Test func galleryPromptCarriesOrderedUrlsAndClampedIndex() {
        let urls = ["https://m/a.bin", "https://m/b.bin", "https://m/c.bin"]
        let p = StickyImageCard.galleryPrompt(urls: urls, index: 1)
        #expect(p.hasPrefix("render_ui {"))
        let obj = try? JSONSerialization.jsonObject(
            with: Data(p.dropFirst("render_ui ".count).utf8)) as? [String: Any]
        #expect(obj?["type"] as? String == "gallery")
        #expect(obj?["urls"] as? [String] == urls)
        #expect(obj?["index"] as? Int == 1)
        // Out-of-range index clamps instead of shipping a lie to the device.
        let over = StickyImageCard.galleryPrompt(urls: urls, index: 99)
        let o2 = try? JSONSerialization.jsonObject(
            with: Data(over.dropFirst("render_ui ".count).utf8)) as? [String: Any]
        #expect(o2?["index"] as? Int == 2)
    }

    /// Ten media URLs must stay under the 8000B relay envelope cap with a
    /// wide margin — this is the arithmetic the ANSWERS.md contract claims.
    @Test func galleryPromptOfTenFitsTheRelayCap() {
        let urls = (0 ..< 10).map {
            "https://plugin.tiny.technology/media/00000000-0000-0000-0000-0000000000\($0)\($0).bin"
        }
        let p = StickyImageCard.galleryPrompt(urls: urls)
        #expect(p.utf8.count < 2000, "prompt was \(p.utf8.count)B")
    }

    @Test func renderPromptIsValidRenderUiJson() {
        let p = StickyImageCard.renderPrompt(url: "https://plugin.tiny.technology/media/abc.bin")
        #expect(p.hasPrefix("render_ui {"))
        let json = String(p.dropFirst("render_ui ".count))
        let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        #expect(obj?["type"] as? String == "image")
        #expect(obj?["url"] as? String == "https://plugin.tiny.technology/media/abc.bin")
    }

    // ── Glass e2e export harness ─────────────────────────────────────────────

    /// Not an assertion suite — an EXPORT RAIL. When STICKY_FRAME_EXPORT names
    /// a path (TEST_RUNNER_ env via xcodebuild), this writes the exact bytes
    /// StickyDither.prepare produces for a recognizable scene, so the owner's
    /// Mac can push the REAL Swift-pipeline output through /api/media → relay
    /// → the physical glass. Simulator tests run on the host filesystem, which
    /// makes this the shortest honest path from the app's code to the panel
    /// without a finger on a phone. No env → no-op (CI stays hermetic).
    @Test func exportFrameForGlassE2E() throws {
        guard let path = ProcessInfo.processInfo.environment["STICKY_FRAME_EXPORT"],
              !path.isEmpty else { return }
        let r = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 480))
        let img = r.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 800, height: 480))
            ("tiny iOS → glass" as NSString).draw(
                at: CGPoint(x: 60, y: 70),
                withAttributes: [.font: UIFont.boldSystemFont(ofSize: 64),
                                 .foregroundColor: UIColor.black])
            ("multi-image rail e2e — StickyDither.prepare()" as NSString).draw(
                at: CGPoint(x: 60, y: 160),
                withAttributes: [.font: UIFont.systemFont(ofSize: 30),
                                 .foregroundColor: UIColor.darkGray])
            // A gray ramp: the dither's signature — solid at the ends,
            // visibly stippled in the middle. Proof it went through F-S.
            for i in 0 ..< 8 {
                UIColor(white: CGFloat(i) / 7.0, alpha: 1).setFill()
                ctx.fill(CGRect(x: i * 100, y: 280, width: 100, height: 160))
            }
        }
        let frame = try #require(StickyDither.prepare(img, mode: .oneBit))
        #expect(frame.raw.count == 48000)
        try frame.raw.write(to: URL(fileURLWithPath: path))
    }

    // ── The grammar gate ─────────────────────────────────────────────────────

    @Test func grammarVersionReadsTheFirmwaresClaim() {
        #expect(StickyStatus.grammarVersion(#"{"fw":"0.16.4-m14","grammar_version":4}"#) == 4)
        // Absent field = old firmware = nil = gate stays closed.
        #expect(StickyStatus.grammarVersion(#"{"fw":"0.11.0"}"#) == nil)
        #expect(StickyStatus.grammarVersion("not json") == nil)
    }

    /// The firmware's ACTUAL reply contract (tiny_commands.h): the payload is
    /// an envelope — `{"result": "<serialized status JSON>"}` — with the
    /// status one stringification deeper. Reading the top level only, the
    /// probe parsed the envelope, found no `grammar_version`, and told the
    /// owner "the device didn't answer the grammar probe in 20s" about a
    /// device that had answered in four (fw 0.27.0-u2, 2026-08-29). This
    /// payload is verbatim (trimmed) from that wire.
    @Test func grammarVersionUnwrapsTheResultEnvelope() {
        let wire = #"{"result":"{\"fw\":\"0.27.0-u2\",\"grammar_version\":11,\"battery_pct\":9,\"charging\":true,\"rssi_dbm\":-46}"}"#
        #expect(StickyStatus.grammarVersion(wire) == 11)
        // The telemetry rows read the same object — battery/wifi survive the
        // envelope AND the battery_pct/rssi_dbm key drift.
        let rows = StickyStatus.readings(wire)
        #expect(rows.contains { $0.label == "battery" && $0.value == "9% ⚡︎" })
        #expect(rows.contains { $0.label == "wifi" && $0.value == "-46 dBm" })
        // An envelope whose result is prose (an `ask` answer, an error
        // sentence) is not a status — nil, gate stays closed.
        #expect(StickyStatus.grammarVersion(#"{"result":"I'm busy on the glass"}"#) == nil)
    }
}

/**
 * 🖼️ StickyImage — send a photo to the Sticky's e-ink glass.
 *
 * The pipeline runs ENTIRELY on the phone, because the phone is the only
 * device in the pair with the compute to spare and the screen to preview on:
 *
 *   PhotosPicker → letterbox onto 800×480 white → Floyd–Steinberg dither
 *   (1-bit, or the panel's native 4-gray) → preview EXACTLY as the glass
 *   will show it → RAW canvas-space frame (48000 B 1-bit / 96000 B gray4)
 *   → POST /api/media (octet-stream) → relay `render_ui {"type":"image",…}`.
 *
 * Three commitments, each earned the hard way elsewhere in this codebase:
 *
 *  1. THE PREVIEW IS THE PRODUCT. The e-ink panel shows 2 or 4 levels of
 *     gray, period — a full-color thumbnail followed by a surprise on the
 *     fridge is a lie with extra steps. What this view renders is the same
 *     byte buffer the PNG is made from, so phone and glass cannot disagree.
 *
 *  2. THE DEVICE NEVER DITHERS. The uploaded PNG's pixels are already
 *     quantized to the exact levels the panel can paint ({0,255} or
 *     {0,85,170,255}), so firmware-side `image` only fetches, maps and
 *     blits. 384,000 error-diffused pixels are a rounding error for an A18
 *     and a real budget item for an ESP32-S3.
 *
 *  3. GATE ON THE FIRMWARE'S OWN CLAIM. The image card shipped with M-A4 at
 *     grammar 7 (fw 0.19.0, verified pixel-perfect on glass 2026-08-26).
 *     When `status` reports an older grammar the send button says so instead
 *     of letting an envelope die as "unknown command" — dither, preview and
 *     upload still work, so it degrades to "upload + copy URL", not nothing.
 *
 * StickyRelay at the bottom is the one-envelope round trip StickyPanel
 * taught itself (send → poll → verdict); it lives here so this sender and
 * the panel share one copy instead of growing a third.
 */
import PhotosUI
import SwiftUI

// ── Dither engine (pure — unit-testable) ────────────────────────────────────

enum StickyDither {
    /// The panel's native raster. Landscape — the firmware rotates.
    static let panelW = 800
    static let panelH = 480

    /// What the glass can actually paint.
    enum Mode: String, CaseIterable, Identifiable {
        case oneBit = "1-bit"
        case fourGray = "4-gray"
        var id: String { rawValue }
        var levels: Int { self == .oneBit ? 2 : 4 }
    }

    /// UIImage → 800×480 grayscale bytes, aspect-fit on white (letterboxed —
    /// never cropped: a photo sent to the fridge should be the whole photo).
    /// Orientation is normalized FIRST: a portrait iPhone photo carries its
    /// rotation in EXIF, and `cgImage` alone would blit it sideways.
    static func grayLetterbox(_ image: UIImage,
                              w: Int = panelW, h: Int = panelH) -> [UInt8]? {
        let upright: UIImage
        if image.imageOrientation == .up {
            upright = image
        } else {
            let r = UIGraphicsImageRenderer(size: image.size)
            upright = r.image { _ in
                image.draw(in: CGRect(origin: .zero, size: image.size))
            }
        }
        guard let cg = upright.cgImage, cg.width > 0, cg.height > 0 else { return nil }
        var pixels = [UInt8](repeating: 0, count: w * h)
        let ok = pixels.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(
                data: buf.baseAddress, width: w, height: h,
                bitsPerComponent: 8, bytesPerRow: w,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.setFillColor(gray: 1, alpha: 1)
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            let scale = min(CGFloat(w) / CGFloat(cg.width),
                            CGFloat(h) / CGFloat(cg.height))
            let dw = CGFloat(cg.width) * scale
            let dh = CGFloat(cg.height) * scale
            ctx.interpolationQuality = .high
            ctx.draw(cg, in: CGRect(x: (CGFloat(w) - dw) / 2,
                                    y: (CGFloat(h) - dh) / 2,
                                    width: dw, height: dh))
            return true
        }
        return ok ? pixels : nil
    }

    /// Floyd–Steinberg error diffusion to `levels` evenly spaced grays.
    /// Output bytes take ONLY the quantized values — that is the wire
    /// contract with the firmware's blit (commitment 2 in the header).
    static func floydSteinberg(_ gray: [UInt8], w: Int, h: Int,
                               levels: Int) -> [UInt8] {
        guard gray.count == w * h, levels >= 2 else { return gray }
        var err = gray.map { Float($0) }
        var out = [UInt8](repeating: 0, count: w * h)
        let step = 255.0 / Float(levels - 1)
        for y in 0 ..< h {
            let row = y * w
            for x in 0 ..< w {
                let i = row + x
                let old = err[i]
                let q = max(0, min(255, (old / step).rounded() * step))
                out[i] = UInt8(q)
                let e = old - q
                if x + 1 < w { err[i + 1] += e * 7 / 16 }
                if y + 1 < h {
                    if x > 0 { err[i + w - 1] += e * 3 / 16 }
                    err[i + w] += e * 5 / 16
                    if x + 1 < w { err[i + w + 1] += e * 1 / 16 }
                }
            }
        }
        return out
    }

    /// Quantized bytes → the firmware's 1-bit wire frame (48000 B). MSB-first,
    /// bit SET = WHITE: render_image_card reads
    /// `black = !(buf[bit/8] & (0x80 >> bit%8))` (tiny_display.cpp, M-A4).
    static func pack1bit(_ pixels: [UInt8], w: Int = panelW, h: Int = panelH) -> Data? {
        guard pixels.count == w * h, w % 8 == 0 else { return nil }
        var out = Data(count: w * h / 8)
        out.withUnsafeMutableBytes { buf in
            let b = buf.bindMemory(to: UInt8.self).baseAddress!
            for i in 0 ..< pixels.count where pixels[i] >= 128 {
                b[i >> 3] |= 0x80 >> (i & 7)
            }
        }
        return out
    }

    /// Quantized bytes → the firmware's gray4 wire frame (96000 B) — the
    /// canvas's own 2bpp layout, memcpy'd on device: pixel x sits at bits
    /// `(3-(x&3))*2` of byte `y*stride + x/4`, value 0=Black … 3=White
    /// (canvas.cpp draw_pixel, stride = w/4).
    static func packGray4(_ pixels: [UInt8], w: Int = panelW, h: Int = panelH) -> Data? {
        guard pixels.count == w * h, w % 4 == 0 else { return nil }
        var out = Data(count: w * h / 4)
        out.withUnsafeMutableBytes { buf in
            let b = buf.bindMemory(to: UInt8.self).baseAddress!
            for i in 0 ..< pixels.count {
                let level = UInt8((Int(pixels[i]) + 42) / 85)   // 0,85,170,255 → 0..3
                let shift = UInt8((3 - (i & 3)) * 2)
                b[i >> 2] |= min(level, 3) << shift
            }
        }
        return out
    }

    /// Quantized bytes → UIImage — the preview AND the upload come from this
    /// one buffer, so they cannot drift apart.
    static func image(from pixels: [UInt8], w: Int = panelW, h: Int = panelH) -> UIImage? {
        var px = pixels
        guard px.count == w * h else { return nil }
        let cg: CGImage? = px.withUnsafeMutableBytes { buf in
            CGContext(data: buf.baseAddress, width: w, height: h,
                      bitsPerComponent: 8, bytesPerRow: w,
                      space: CGColorSpaceCreateDeviceGray(),
                      bitmapInfo: CGImageAlphaInfo.none.rawValue)?.makeImage()
        }
        guard let cg else { return nil }
        return UIImage(cgImage: cg)
    }

    /// One prepared photo: the preview UIImage and the RAW wire frame the
    /// glass fetches (48000 B 1-bit / 96000 B gray4 — length picks the format
    /// on device, so the bytes ARE the contract).
    struct Frame {
        let preview: UIImage
        let raw: Data
    }

    /// The whole pipeline, off the main actor (384k px of error diffusion).
    static func prepare(_ source: UIImage, mode: Mode) -> Frame? {
        guard let gray = grayLetterbox(source) else { return nil }
        let dithered = floydSteinberg(gray, w: panelW, h: panelH, levels: mode.levels)
        guard let img = image(from: dithered),
              let raw = mode == .oneBit ? pack1bit(dithered) : packGray4(dithered)
        else { return nil }
        return Frame(preview: img, raw: raw)
    }
}

/// The grammar version whose renderer has the image card —
/// `render_ui {"type":"image","url":…}` landed with M-A4 in fw 0.19.0
/// (grammar 7, commit 739e044). The earlier plan here waited for an
/// `image <url>` VERB at grammar 5 — that verb never shipped; grammars 5 and 6
/// would have eaten the envelope as "unknown command", which is exactly what
/// commitment 3 exists to prevent. Gate on what dispatch actually implements.
let kStickyImageGrammar = 7

/// The grammar that ships the on-device gallery card
/// (`render_ui {"type":"gallery","urls":[…],"index":n}` — contract proposed to
/// the firmware lane in sticky-the-reterminal docs/ANSWERS.md, 2026-08-26).
/// ANSWERED: grammar 10 (tiny_version.h "v10: gallery card + g: touch
/// namespace + page gallery", built to this exact wire contract — same
/// 48000|96000B raw frames as the image card, ≤10 urls, index clamp).
/// The device has been claiming grammar 10 on `status` since fw 0.25.x;
/// this constant was the last unflipped switch (owner hit the dead gallery
/// send 2026-08-29).
let kStickyGalleryGrammar: Int? = 10

/// Builds the relay prompts that put hosted frames on the glass — pure so the
/// wire strings are unit-testable (a hand-rolled JSON with an unescaped URL is
/// the kind of bug that only shows up on the fridge).
enum StickyImageCard {
    /// `render_ui {"type":"image","url":"…"}` — the M-A4 card.
    static func renderPrompt(url: String) -> String {
        var spec = "{\"type\":\"image\",\"url\":"
        spec += jsonString(url)
        spec += "}"
        return "render_ui " + spec
    }

    /// `render_ui {"type":"gallery","urls":[…],"index":n}` — the proposed
    /// multi-photo card (docs/ANSWERS.md [ios-lane] 2026-08-26). Only sent
    /// when kStickyGalleryGrammar is set AND the device claims it; kept pure
    /// and tested NOW so the day the firmware answers, flipping the constant
    /// is the whole change.
    static func galleryPrompt(urls: [String], index: Int = 0) -> String {
        var spec = "{\"type\":\"gallery\",\"urls\":["
        spec += urls.map(jsonString).joined(separator: ",")
        spec += "],\"index\":\(max(0, min(index, urls.count - 1)))}"
        return "render_ui " + spec
    }

    private static func jsonString(_ s: String) -> String {
        // JSONEncoder on a bare String yields exactly the quoted JSON string.
        guard let d = try? JSONEncoder().encode(s),
              let q = String(data: d, encoding: .utf8) else { return "\"\"" }
        return q
    }
}

// ── The sender view ──────────────────────────────────────────────────────────

struct StickyImageSender: View {
    let deviceId: String
    let deviceName: String
    let token: String?
    /// The device's own `grammar_version` claim from `status` — nil until the
    /// panel has fetched one. The gate reads the claim, never the calendar.
    let grammar: Int?
    /// Re-mirror after a successful send — a glass that changed and a mirror
    /// that didn't is the panel lying.
    var onGlassChanged: (() async -> Void)?

    /// How many photos one send can carry. Ten 48KB frames ≈ 480KB uploaded
    /// and a ~700B relay prompt — both far under their rails' caps.
    static let maxPhotos = 10

    /// One staged photo: the source, its dithered frame (preview + wire
    /// bytes from ONE buffer), and the hosted URL once uploaded. The URL is
    /// cached PER PHOTO and dropped whenever the bytes change (mode toggle),
    /// mirroring DmMedia's stage-then-send discipline.
    struct Staged: Identifiable {
        let id = UUID()
        let source: UIImage
        var frame: StickyDither.Frame?
        var uploadedURL: String?
    }

    @State private var picks: [PhotosPickerItem] = []
    @State private var photos: [Staged] = []
    @State private var page = 0
    @State private var mode: StickyDither.Mode = .oneBit
    @State private var working = false
    @State private var note: String?
    /// The sender's OWN status probe — when the panel hasn't fetched one yet
    /// (fresh session), ask the device instead of asking the human to refresh.
    /// The gate still reads the firmware's claim, never the calendar; this
    /// just fetches the claim itself.
    @State private var probedGrammar: Int?
    @State private var probing = false

    private var knownGrammar: Int? { grammar ?? probedGrammar }
    private var firmwareReady: Bool { (knownGrammar ?? 0) >= kStickyImageGrammar }
    private var galleryReady: Bool {
        guard let need = kStickyGalleryGrammar else { return false }
        return (knownGrammar ?? 0) >= need
    }
    private var currentPhoto: Staged? {
        photos.indices.contains(page) ? photos[page] : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                PhotosPicker(selection: $picks,
                             maxSelectionCount: Self.maxPhotos,
                             matching: .images) {
                    Label(photos.isEmpty
                          ? "Pick photos"
                          : "Change photos (\(photos.count))",
                          systemImage: "photo.on.rectangle.angled")
                        .font(.caption2)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                if !photos.isEmpty {
                    Picker("", selection: $mode) {
                        ForEach(StickyDither.Mode.allCases) { m in
                            Text(m.rawValue).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)
                    .controlSize(.mini)
                }
                Spacer(minLength: 0)
            }
            if !photos.isEmpty {
                pagedPreview
                sendRow
            }
            if let note {
                Text(note)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .onChange(of: picks) { _, items in Task { await load(items) } }
        .onChange(of: mode) { _, _ in Task { await reditherAll() } }
        .task { await probeGrammarIfUnknown() }
    }

    // ── Preview: a page per photo, exactly the glass's pixels ───────────────

    @ViewBuilder private var pagedPreview: some View {
        TabView(selection: $page) {
            ForEach(Array(photos.enumerated()), id: \.element.id) { i, staged in
                Group {
                    if let preview = staged.frame?.preview {
                        Image(uiImage: preview)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .aspectRatio(CGFloat(StickyDither.panelW) /
                                         CGFloat(StickyDither.panelH),
                                         contentMode: .fit)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8)
                    .stroke(.secondary.opacity(0.3), lineWidth: 0.5))
                .overlay(alignment: .topTrailing) {
                    Button {
                        remove(at: i)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.body)
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, .black.opacity(0.55))
                    }
                    .padding(6)
                    .accessibilityLabel("Remove photo \(i + 1)")
                }
                .padding(.bottom, 24)   // clear the page dots
                .tag(i)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .always : .never))
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .aspectRatio(CGFloat(StickyDither.panelW) /
                     CGFloat(StickyDither.panelH + 40), contentMode: .fit)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("E-ink preview — exactly what the glass will show")
        Text(photos.count == 1
             ? "shown as the glass will paint it — \(mode.rawValue), 800×480"
             : "photo \(min(page + 1, photos.count))/\(photos.count) — as the glass will paint it, \(mode.rawValue)")
            .font(.caption2).foregroundStyle(.secondary)
    }

    // ── Send row: gallery when the firmware claims it, honest otherwise ─────

    @ViewBuilder private var sendRow: some View {
        HStack(spacing: 6) {
            if galleryReady && photos.count > 1 {
                Button("Send gallery (\(photos.count))") { Task { await sendGallery() } }
                    .font(.caption2)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                    .disabled(working || photos.contains { $0.frame == nil })
            } else if firmwareReady {
                Button(photos.count > 1 ? "Show photo \(page + 1) on glass"
                                        : "Send to glass") {
                    Task { await sendCurrentToGlass() }
                }
                .font(.caption2)
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .disabled(working || currentPhoto?.frame == nil)
            } else {
                Button(photos.count > 1 ? "Upload all (copy URLs)"
                                        : "Upload (copy URL)") {
                    Task { await uploadOnly() }
                }
                .font(.caption2)
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(working || photos.contains { $0.frame == nil })
            }
            if working { ProgressView().controlSize(.mini) }
            Spacer(minLength: 0)
        }
        if !firmwareReady {
            // The honest gate (commitment 3): name the claim that's missing,
            // not a vague "unavailable" — and when the probe missed its
            // window, hand over the retry instead of describing one that
            // doesn't exist (the first build said "pull to refresh" in a
            // DisclosureGroup row, which has no pull; cagatay hit exactly
            // that dead end on 2026-08-26).
            HStack(spacing: 6) {
                Text(knownGrammar == nil
                     ? (probing
                        ? "Asking the device which grammar it speaks…"
                        : "The device didn't answer the grammar probe in 20s — it may have been busy on the glass (OTA, review window). It keeps your photos; just ask again.")
                     : "This firmware (grammar v\(knownGrammar!)) predates the image card (grammar 7, fw 0.19.0) — OTA the Sticky to send. Dither + upload work now.")
                    .font(.caption2).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                if knownGrammar == nil && !probing {
                    Button("Ask again") { Task { await probeGrammarIfUnknown() } }
                        .font(.caption2)
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                }
            }
        } else if photos.count > 1 && !galleryReady {
            Text("On-device gallery isn't in this firmware yet — flip pages here and show one at a time; the glass follows. One send does all \(photos.count) the day it ships.")
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Fetch the firmware's grammar claim ourselves when nobody has yet —
    /// one `status` envelope, same relay the send uses. Failure is fine:
    /// the gate stays honest and the upload path still works.
    private func probeGrammarIfUnknown() async {
        guard grammar == nil, probedGrammar == nil, !probing else { return }
        probing = true
        defer { probing = false }
        // Two attempts, not one: the device answers in ~2s when idle, but a
        // glass window (OTA, screenshot session) can eat a whole 20s poll
        // budget. One retry covers that without turning the gate into a
        // spinner-forever.
        for attempt in 0 ..< 2 {
            if case .answered(let payload) = await StickyRelay.invoke(
                "status", deviceId: deviceId, deviceName: deviceName, token: token) {
                if let g = StickyStatus.grammarVersion(payload) {
                    probedGrammar = g
                    return
                }
            }
            if attempt == 0 { try? await Task.sleep(for: .seconds(2)) }
        }
    }

    // ── Steps ────────────────────────────────────────────────────────────────

    private func load(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        note = nil
        working = true
        defer { working = false }
        var staged: [Staged] = []
        var skipped = 0
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
               let img = UIImage(data: data) {
                staged.append(Staged(source: img))
            } else {
                skipped += 1
            }
        }
        photos = staged
        page = 0
        if skipped > 0 {
            note = "\(skipped) photo\(skipped == 1 ? "" : "s") wouldn't load — showing the other \(staged.count)."
        }
        await reditherAll()
    }

    private func remove(at i: Int) {
        guard photos.indices.contains(i) else { return }
        photos.remove(at: i)
        if page >= photos.count { page = max(0, photos.count - 1) }
        if photos.isEmpty { picks = []; note = nil }
    }

    /// Dither every photo that needs it, off the main actor — one detached
    /// task for the batch (384k px each; ten photos ≈ a short blink on an
    /// A-series core, but never on the UI thread).
    private func reditherAll() async {
        guard !photos.isEmpty else { return }
        working = true
        defer { working = false }
        let m = mode
        let sources = photos.map(\.source)
        let frames = await Task.detached(priority: .userInitiated) {
            sources.map { StickyDither.prepare($0, mode: m) }
        }.value
        var failed = 0
        for i in photos.indices {
            photos[i].frame = frames[i]
            // Bytes changed (or first dither) — any cached upload is stale.
            photos[i].uploadedURL = nil
            if frames[i] == nil { failed += 1 }
        }
        if failed > 0 {
            note = "\(failed) photo\(failed == 1 ? "" : "s") couldn't be rasterized for the panel."
        } else if note?.contains("rasterized") == true {
            note = nil
        }
    }

    /// Upload one staged photo's frame; per-photo URL cache — four copies in
    /// R2 for one fridge photo is DmMedia's documented anti-pattern.
    private func upload(_ i: Int) async -> String? {
        guard photos.indices.contains(i) else { return nil }
        if let url = photos[i].uploadedURL { return url }
        guard let raw = photos[i].frame?.raw else { return nil }
        do {
            // Raw canvas-space frame, application/octet-stream — the media
            // host serves it byte-exact and plugin.tiny.technology/media is
            // on the device's fetch allowlist (the "media bridge",
            // docs/ANSWERS.md 2026-08-26). A PNG here would be refused on
            // device: the fetcher accepts ONLY 48000/96000-byte bodies.
            let res: [String: Any] = try await Api.post("/api/media", token: token, body: [
                "data": raw.base64EncodedString(),
                "contentType": "application/octet-stream",
            ], timeoutSeconds: 120)
            guard let url = res["url"] as? String, !url.isEmpty else {
                note = (res["error"] as? String) ?? "The upload returned no URL."
                return nil
            }
            photos[i].uploadedURL = url
            return url
        } catch {
            note = LoadFailure.message(error)
            return nil
        }
    }

    /// Upload every staged frame sequentially with honest progress. Returns
    /// the URLs in photo order, or nil if any failed (note already says why).
    private func uploadAll() async -> [String]? {
        var urls: [String] = []
        for i in photos.indices {
            if photos[i].uploadedURL == nil {
                note = "uploading \(i + 1)/\(photos.count)…"
            }
            guard let url = await upload(i) else {
                note = (note ?? "") + " — failed at photo \(i + 1)/\(photos.count)."
                return nil
            }
            urls.append(url)
        }
        return urls
    }

    private func uploadOnly() async {
        working = true
        defer { working = false }
        guard let urls = await uploadAll() else { return }
        UIPasteboard.general.string = urls.joined(separator: "\n")
        note = urls.count == 1
            ? "Uploaded + copied: \(urls[0])"
            : "Uploaded \(urls.count) frames + copied all URLs."
    }

    /// The fallback that works TODAY: put the page you're looking at on the
    /// glass via the shipped image card. Flip → send → the glass follows.
    private func sendCurrentToGlass() async {
        working = true
        defer { working = false }
        let i = page
        guard let url = await upload(i) else { return }
        switch await StickyRelay.invoke(StickyImageCard.renderPrompt(url: url),
                                        deviceId: deviceId,
                                        deviceName: deviceName, token: token) {
        case .refused(let why):
            note = why
        case .answered(let payload):
            note = photos.count > 1
                ? "photo \(i + 1)/\(photos.count) → glass: \(RelayReply.text(payload))"
                : RelayReply.text(payload)
            // E-ink needs its 1-2s full refresh before a mirror shows the
            // photo rather than the wipe.
            try? await Task.sleep(for: .seconds(2))
            await onGlassChanged?()
        }
    }

    /// One send, whole set — only reachable when the firmware's own claim
    /// says the gallery card exists (kStickyGalleryGrammar).
    private func sendGallery() async {
        working = true
        defer { working = false }
        guard let urls = await uploadAll() else { return }
        switch await StickyRelay.invoke(
            StickyImageCard.galleryPrompt(urls: urls, index: page),
            deviceId: deviceId, deviceName: deviceName, token: token) {
        case .refused(let why):
            note = why
        case .answered(let payload):
            note = "gallery (\(urls.count) photos) → glass: \(RelayReply.text(payload))"
            try? await Task.sleep(for: .seconds(2))
            await onGlassChanged?()
        }
    }
}

// ── StickyRelay — one envelope, shared ───────────────────────────────────────

/// Send one `invoke` envelope to a Sticky and wait for its reply. Extracted
/// verbatim from StickyPanel so the image sender (and the composers behind
/// it) don't each grow a private copy of the send→poll→verdict dance.
enum StickyRelay {
    /// The payload, or the REASON it didn't arrive — never a shrug. A plain
    /// enum rather than Result: the refusal is a sentence for a panel, not an
    /// Error (and String-as-Error already bit this codebase once).
    enum Outcome {
        case answered(String)
        case refused(String)
    }

    static let pollTries = 10
    static let pollEverySeconds = 2.0

    static func invoke(_ prompt: String, deviceId: String,
                       deviceName: String, token: String?) async -> Outcome {
        let sent: [String: Any]
        do {
            sent = try await Api.post("/api/devices/relay", token: token, body: [
                "toDevice": deviceId,
                "payload": ["type": "invoke", "prompt": prompt],
            ])
        } catch {
            return .refused(LoadFailure.message(error))
        }
        guard let envId = sent["id"] as? String, !envId.isEmpty else {
            return .refused((sent["error"] as? String) ?? "Couldn't reach the relay.")
        }
        let query = envId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? envId
        var refusal: String?
        for _ in 0 ..< pollTries {
            try? await Task.sleep(for: .seconds(pollEverySeconds))
            switch await RelayPoll.read(inReplyTo: query, token: token) {
            case .empty:
                refusal = nil
            case .unreadable(let why, let status):
                refusal = why
                if RelayPoll.isTerminal(status: status) { return .refused(why) }
            case .answered(let payload):
                return .answered(payload)
            }
        }
        switch RelayPoll.verdict(refusal: refusal) {
        case .deviceSilent:
            return .refused("\(deviceName) didn't answer in "
                          + "\(Int(Double(pollTries) * pollEverySeconds))s — "
                          + "its relay poll runs every 5s when powered.")
        case .couldNotAsk(let why):
            return .refused(why)
        }
    }
}

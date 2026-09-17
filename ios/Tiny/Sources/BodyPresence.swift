/**
 * 🫀 BodyPresence — ONE registry of "which of the owner's bodies is here right now".
 *
 * The top bar is presence-driven (owner, 2026-09-17: "when I put the glasses on,
 * that shows up; when Fomo is online, that shows up; when Reachy is online, that
 * shows up… I want to see ALL of them at the top bar, with PiP"). Every body —
 * glasses, necklace (TinyLive), Fomo the arm, the UNO Q, Scout, Reachy — has one
 * row here: online or not, the newest camera frame shrunk to a thumbnail, an fps
 * word. The strip (TopBarStrip.swift) renders ONLY the online rows.
 *
 * No networking of its own. It READS the managers that already stream
 * (ArmManager, BodyManager.scout/.reachy, QBrainManager, TinyLive,
 * WearablesManager) on a 1 s tick — health is age-based (QBrainCore.health), so
 * a body that stops answering must go offline without any new publish — and it
 * subscribes to their frame publishers, throttled to ≤2 fps, to build the
 * ≤92 px thumbnail OFF the main thread (ImageIO thumbnail decode for JPEG
 * bytes, a CGContext redraw for UIImages). The bar therefore costs a few
 * small decodes a second, never a 12 fps re-render.
 *
 * BodyPresenceCore is the pure part (row transitions, ordering, downsample) —
 * TinyTests/BodyPresenceTests drives it with fakes.
 */
import SwiftUI
import Combine
import ImageIO
import UniformTypeIdentifiers

/// Every body the phone knows how to show. Raw value doubles as the
/// accessibility identifier suffix (`topbar-tile-<raw>`).
enum BodyId: String, CaseIterable, Identifiable, Hashable, Codable {
    case glasses, necklace, fomo, qBrain, scout, reachy

    var id: String { rawValue }

    var title: String {
        switch self {
        case .glasses: return "Glasses"
        case .necklace: return "Necklace"
        case .fomo: return "Fomo"
        case .qBrain: return "Q"
        case .scout: return "Scout"
        case .reachy: return "Reachy"
        }
    }

    var symbol: String {
        switch self {
        case .glasses: return "eyeglasses"
        case .necklace: return "sparkles.tv"
        case .fomo: return "hand.raised"
        case .qBrain: return "cpu"
        case .scout: return BodyKind.scout.symbol
        case .reachy: return BodyKind.reachy.symbol
        }
    }

    /// Bodies with a camera get the 46×30 video tile; the rest a 30×30 glyph.
    var hasCamera: Bool {
        switch self {
        case .qBrain: return false
        default: return true
        }
    }
}

enum BodyPresenceCore {
    /// One body's presence. `onlineSince` orders the strip (newest first) and is
    /// kept across ticks while the body stays online, so tiles never reshuffle.
    struct Row: Equatable {
        let id: BodyId
        var isOnline = false
        var onlineSince: Date?
        var thumb: UIImage?
        var thumbAt: Date?
        var fpsText = ""

        init(id: BodyId) { self.id = id }

        static func == (a: Row, b: Row) -> Bool {
            a.id == b.id && a.isOnline == b.isOnline && a.onlineSince == b.onlineSince
                && a.thumbAt == b.thumbAt && a.fpsText == b.fpsText && (a.thumb === b.thumb)
        }
    }

    /// Thumbnail width cap (points at 1×; the strip draws it at 46 pt, so 92 px
    /// is exactly 2× — crisp on every phone, tiny in memory).
    static let thumbMaxPixels: CGFloat = 92
    /// Frames are folded into the thumbnail at most this often.
    static let thumbInterval: TimeInterval = 0.5

    /// Apply an online/offline observation. Going online stamps `onlineSince`
    /// once; staying online keeps it; going offline clears it and the thumb
    /// (an offline tile must never show a stale picture when it comes back).
    static func transition(_ row: Row, online: Bool, now: Date) -> Row {
        var r = row
        if online {
            if !r.isOnline { r.onlineSince = now }
            r.isOnline = true
        } else if r.isOnline || r.onlineSince != nil || r.thumb != nil {
            r.isOnline = false
            r.onlineSince = nil
            r.thumb = nil
            r.thumbAt = nil
            r.fpsText = ""
        }
        return r
    }

    /// The strip's order. The owner asked to SEE the bodies, so a picture beats
    /// a glyph: rows with a live thumbnail first, then camera bodies still
    /// waiting for a frame, then glyph-only bodies (UNO Q); newest-online first
    /// within a rank; ties (same second, e.g. cold launch) fall back to the
    /// declaration order of BodyId. Build 92 on the phone ranked by time alone
    /// and the inline slots went to Q + glasses while Fomo/Scout/Reachy — the
    /// ones with video — fell into "+2".
    static func rank(_ row: Row) -> Int {
        (row.id.hasCamera ? 2 : 0) + (row.thumb != nil ? 1 : 0)
    }

    static func online(_ rows: [BodyId: Row]) -> [BodyId] {
        let order = Dictionary(uniqueKeysWithValues: BodyId.allCases.enumerated().map { ($1, $0) })
        return rows.values
            .filter { $0.isOnline }
            .sorted { a, b in
                let ra = rank(a), rb = rank(b)
                if ra != rb { return ra > rb }
                let ta = a.onlineSince ?? .distantPast, tb = b.onlineSince ?? .distantPast
                if ta != tb { return ta > tb }
                return (order[a.id] ?? 0) < (order[b.id] ?? 0)
            }
            .map(\.id)
    }

    /// Whether a new frame should be folded into the thumbnail yet (≤2 fps).
    static func wantsThumb(lastAt: Date?, now: Date) -> Bool {
        guard let lastAt else { return true }
        return now.timeIntervalSince(lastAt) >= thumbInterval
    }

    /// The fps word under a tile: "12 fps", "2 fps", "" when unknown/idle.
    static func fpsText(_ fps: Double?) -> String {
        guard let fps, fps > 0.05 else { return "" }
        return fps < 1 ? String(format: "%.1f fps", fps) : "\(Int(fps.rounded())) fps"
    }

    /// Size that fits `size` into `maxPixels` wide, aspect kept, never upscaled.
    static func thumbSize(for size: CGSize, maxPixels: CGFloat = thumbMaxPixels) -> CGSize {
        guard size.width > 0, size.height > 0 else { return .zero }
        if size.width <= maxPixels { return CGSize(width: size.width.rounded(), height: size.height.rounded()) }
        let s = maxPixels / size.width
        return CGSize(width: maxPixels, height: max(1, (size.height * s).rounded()))
    }

    /// JPEG bytes → ≤92 px thumbnail via ImageIO, which decodes at reduced size
    /// (kCGImageSourceThumbnailMaxPixelSize) instead of inflating the full frame.
    /// nonisolated + Sendable inputs: meant for Task.detached.
    nonisolated static func downsample(jpeg: Data, maxPixels: CGFloat = thumbMaxPixels) -> UIImage? {
        let opts: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let src = CGImageSourceCreateWithData(jpeg as CFData, opts as CFDictionary) else { return nil }
        let thumbOpts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(maxPixels),
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts as CFDictionary) else { return nil }
        // MaxPixelSize bounds the LONGER edge; a portrait frame could still be
        // taller than wide — the strip clips to 46×30 anyway, width is the contract.
        return UIImage(cgImage: cg, scale: 1, orientation: .up)
    }

    /// An already-decoded frame → ≤92 px thumbnail (CGContext redraw, off-main safe).
    nonisolated static func downsample(image: UIImage, maxPixels: CGFloat = thumbMaxPixels) -> UIImage? {
        guard let cg = image.cgImage else { return nil }
        let src = CGSize(width: cg.width, height: cg.height)
        let dst = thumbSize(for: src, maxPixels: maxPixels)
        guard dst.width >= 1, dst.height >= 1 else { return nil }
        if dst == src { return UIImage(cgImage: cg, scale: 1, orientation: .up) }
        let space = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: nil, width: Int(dst.width), height: Int(dst.height),
                                  bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(cg, in: CGRect(origin: .zero, size: dst))
        guard let out = ctx.makeImage() else { return nil }
        return UIImage(cgImage: out, scale: 1, orientation: .up)
    }
}

/// The live registry. One instance; ChatView mounts `TopBarStrip`, whose `.task`
/// calls `bind()` once so the tick + frame taps exist exactly while the chat is
/// on screen.
@MainActor
final class BodyPresence: ObservableObject {
    static let shared = BodyPresence()

    typealias Row = BodyPresenceCore.Row

    @Published private(set) var rows: [BodyId: Row] = Dictionary(
        uniqueKeysWithValues: BodyId.allCases.map { ($0, Row(id: $0)) })

    /// Online bodies, newest first — what the strip draws.
    var online: [BodyId] { BodyPresenceCore.online(rows) }
    func row(_ id: BodyId) -> Row { rows[id] ?? Row(id: id) }

    private var tick: AnyCancellable?
    private var taps: [AnyCancellable] = []
    private var thumbBusy: Set<BodyId> = []
    private var bound = false
    /// DEBUG/UI-test presence override (UITestFlags.fakeOnlineBodies): those
    /// bodies read online with a synthetic tile — for the "+N" overflow shot.
    private var fakeOnline: Set<BodyId> = []

    // ── Pure-ish API (fakes + tests) ────────────────────────────────────────

    func observe(_ id: BodyId, online: Bool, fps: Double? = nil, now: Date = Date()) {
        var r = BodyPresenceCore.transition(row(id), online: online, now: now)
        if online { r.fpsText = BodyPresenceCore.fpsText(fps) }
        if r != rows[id] { rows[id] = r }
    }

    /// Fold a frame into the thumbnail — throttled, decoded off the main thread.
    func offer(_ id: BodyId, jpeg: Data, now: Date = Date()) {
        guard row(id).isOnline, !thumbBusy.contains(id),
              BodyPresenceCore.wantsThumb(lastAt: row(id).thumbAt, now: now) else { return }
        thumbBusy.insert(id)
        Task.detached(priority: .utility) { [weak self] in
            let img = BodyPresenceCore.downsample(jpeg: jpeg)
            await self?.finishThumb(id, img, at: now)
        }
    }

    func offer(_ id: BodyId, image: UIImage, now: Date = Date()) {
        guard row(id).isOnline, !thumbBusy.contains(id),
              BodyPresenceCore.wantsThumb(lastAt: row(id).thumbAt, now: now) else { return }
        thumbBusy.insert(id)
        let cg = image.cgImage
        Task.detached(priority: .utility) { [weak self] in
            let img = cg.flatMap { BodyPresenceCore.downsample(image: UIImage(cgImage: $0)) }
            await self?.finishThumb(id, img, at: now)
        }
    }

    private func finishThumb(_ id: BodyId, _ img: UIImage?, at: Date) {
        thumbBusy.remove(id)
        guard var r = rows[id], r.isOnline else { return }
        if let img { r.thumb = img }
        r.thumbAt = at
        rows[id] = r
    }

    /// Drop a body's thumbnail (tile shows its glyph until the next frame).
    func clearThumb(_ id: BodyId) {
        guard var r = rows[id], r.thumb != nil || r.thumbAt != nil else { return }
        r.thumb = nil
        r.thumbAt = nil
        rows[id] = r
    }

    /// Tests: reset everything.
    func resetForTesting() {
        rows = Dictionary(uniqueKeysWithValues: BodyId.allCases.map { ($0, Row(id: $0)) })
        thumbBusy = []
    }

    // ── Live binding ────────────────────────────────────────────────────────

    /// Start reading the managers. Idempotent.
    func bind() {
        guard !bound else { return }
        bound = true
        fakeOnline = UITestFlags.fakeOnlineBodies
        refresh()
        tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
            .sink { [weak self] _ in self?.refresh() }
        // Frame taps: the managers publish at their own rate; we throttle to the
        // thumbnail interval on main, and decode off it.
        let ms = Int(BodyPresenceCore.thumbInterval * 1000)
        taps = [
            ArmManager.shared.$frame
                .compactMap { $0 }
                .throttle(for: .milliseconds(ms), scheduler: RunLoop.main, latest: true)
                .sink { [weak self] img in self?.offer(.fomo, image: img) },
            BodyManager.scout.$frame
                .compactMap { $0 }
                .throttle(for: .milliseconds(ms), scheduler: RunLoop.main, latest: true)
                .sink { [weak self] data in self?.offer(.scout, jpeg: data) },
            BodyManager.reachy.$frame
                .compactMap { $0 }
                .throttle(for: .milliseconds(ms), scheduler: RunLoop.main, latest: true)
                .sink { [weak self] data in self?.offer(.reachy, jpeg: data) },
            TinyLive.shared.$frame
                .compactMap { $0 }
                .throttle(for: .milliseconds(ms), scheduler: RunLoop.main, latest: true)
                .sink { [weak self] img in self?.offer(.necklace, image: img) },
        ]
        #if canImport(MWDATCore) && canImport(MWDATCamera)
        // Glasses POV: GlassesLive publishes UIImages while its card streams.
        taps.append(
            GlassesLive.shared.$frame
                .compactMap { $0 }
                .throttle(for: .milliseconds(ms), scheduler: RunLoop.main, latest: true)
                .sink { [weak self] img in self?.offer(.glasses, image: img) }
        )
        #endif
    }

    func unbind() {
        bound = false
        tick = nil
        taps = []
    }

    /// One tick: derive every row's online verdict from what the managers hold.
    /// Health is age-based, so this must run on a clock, not only on publishes.
    func refresh(now: Date = Date()) {
        let arm = ArmManager.shared
        let armHealth = QBrainCore.health(stateAt: arm.stateAt, now: now)
        let armOnline = arm.device != nil && (armHealth == .live || armHealth == .stale || arm.badge != .none)
        observe(.fomo, online: armOnline || fakeOnline.contains(.fomo), fps: nil, now: now)

        for (id, m) in [(BodyId.scout, BodyManager.scout), (.reachy, BodyManager.reachy)] {
            let h = BodyCore.health(stateAt: m.stateAt, now: now)
            let on = m.device != nil && (h == .live || h == .stale)
            observe(id, online: on || fakeOnline.contains(id), fps: m.fps, now: now)
        }

        let q = QBrainManager.shared
        let qh = QBrainCore.health(stateAt: q.stateAt, now: now)
        observe(.qBrain, online: (q.device != nil && (qh == .live || qh == .stale)) || fakeOnline.contains(.qBrain), now: now)

        observe(.necklace, online: TinyLive.shared.running || fakeOnline.contains(.necklace), now: now)

        // Glasses: online = worn (DAT link `.connected`) or streaming. Linked-
        // but-in-the-case is NOT online — that is the owner's whole rule.
        #if canImport(MWDATCore) && canImport(MWDATCamera)
        let wm = WearablesManager.shared
        let glassesLive = GlassesLive.shared.running
        let glasses = (wm.isConnected || glassesLive) || UITestFlags.fakeGlassesLinked
        #else
        let glassesLive = false
        let glasses = UITestFlags.fakeGlassesLinked
        #endif
        observe(.glasses, online: glasses || fakeOnline.contains(.glasses), now: now)
        // A POV thumbnail is only truthful while the stream runs; when it stops
        // the tile falls back to the glyph rather than a frozen old frame.
        if !glassesLive, rows[.glasses]?.thumb != nil, !fakeOnline.contains(.glasses) { clearThumb(.glasses) }

        #if DEBUG
        for id in fakeOnline where rows[id]?.thumb == nil && id.hasCamera {
            if let img = Self.fakeTile(for: id) { offer(id, image: img, now: now) }
        }
        #endif
    }

    #if DEBUG
    /// A flat coloured 92×60 card per body — enough for the overflow screenshot.
    private static func fakeTile(for id: BodyId) -> UIImage? {
        let hue = CGFloat(BodyId.allCases.firstIndex(of: id) ?? 0) / CGFloat(BodyId.allCases.count)
        let size = CGSize(width: 92, height: 60)
        return UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor(hue: hue, saturation: 0.55, brightness: 0.75, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
    }
    #endif
}

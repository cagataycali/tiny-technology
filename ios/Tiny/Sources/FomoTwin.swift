/*
 * FomoTwin — native RealityKit twin of Fomo (the SO-101 arm).
 *
 *  · Mesh + kinematic tree: GET <fomo>/models/arm.usdz (1.99 MB, immutable, ETag) — cached on disk at
 *    Caches/fomo-twin/arm-<etag>.usdz, revalidated with one HEAD per launch; offline = last cached file.
 *  · Drive: exactly like docs/js/twin.js — root `arm` rotated -pi/2 about x, and for every joint the CHILD LINK
 *    Xform (shoulder_link, upper_arm_link, lower_arm_link, wrist_link, head_yoke, head_cradle) rotated about the
 *    joint axis by FomoTwinMath.q(servo deg). Joint pivots are baked into the USDZ and never change.
 *  · Two arms: ACTUAL (solid, the readings from /api/state) and COMMANDED (ghost, 30 % opacity, the last target this
 *    phone or a slider asked for). Fomo's state has no commanded field, so the ghost is the app's own memory.
 *  · Camera: our own PerspectiveCamera orbited by one-finger drag (yaw/pitch) and pinch (distance); framed on the arm.
 *  · Proof without pictures: `fomo-twin` a11y element with value "loaded=true|false stage=… joints=n"; the HUD rows
 *    `fomo-twin-joint-<servo>` carry "actual → target" degrees. If RealityKit fails, `fomo-twin-fallback`
 *    shows a WKWebView of the web twin (documented, never silent).
 */

import SwiftUI
import RealityKit
import WebKit
import Combine
import simd

// MARK: - Asset cache

enum FomoTwinAsset {
    static var dir: URL {
        let c = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("fomo-twin")
        try? FileManager.default.createDirectory(at: c, withIntermediateDirectories: true)
        return c
    }
    static func cached() -> URL? {
        (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]))?
            .filter { $0.pathExtension == "usdz" }
            .sorted { (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast) ?? .distantPast
                    > (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast) ?? .distantPast }
            .first
    }
    static func tag(_ etag: String?) -> String {
        let t = (etag ?? "noetag").replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "W/", with: "")
        return t.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }.isEmpty ? "noetag" : t.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }
    /// The local USDZ to load: cached file matching the server's ETag, else a fresh download, else any cached file.
    static func localURL(base: URL, session: URLSession = .shared) async throws -> (URL, String) {
        let remote = base.appendingPathComponent("models/arm.usdz")
        var head = URLRequest(url: remote, timeoutInterval: 8); head.httpMethod = "HEAD"
        var etag: String?
        if let (_, r) = try? await session.data(for: head), let h = r as? HTTPURLResponse, h.statusCode == 200 {
            etag = h.value(forHTTPHeaderField: "ETag")
        }
        if let etag {
            let f = dir.appendingPathComponent("arm-\(tag(etag)).usdz")
            if FileManager.default.fileExists(atPath: f.path) { return (f, "cache hit \(tag(etag))") }
            let (tmp, r) = try await session.download(for: URLRequest(url: remote, timeoutInterval: 30))
            guard let h = r as? HTTPURLResponse, h.statusCode == 200 else {
                throw NSError(domain: "FomoTwin", code: 1, userInfo: [NSLocalizedDescriptionKey: "arm.usdz HTTP \((r as? HTTPURLResponse)?.statusCode ?? -1)"])
            }
            try? FileManager.default.removeItem(at: f)
            try FileManager.default.moveItem(at: tmp, to: f)
            let bytes = (try? FileManager.default.attributesOfItem(atPath: f.path)[.size] as? Int) ?? 0
            return (f, "downloaded \(bytes) B \(tag(etag))")
        }
        if let c = cached() { return (c, "offline, cached \(c.lastPathComponent)") }
        throw NSError(domain: "FomoTwin", code: 2, userInfo: [NSLocalizedDescriptionKey: "arm.usdz unreachable and nothing cached"])
    }
}

// MARK: - Scene model (one per twin view)

@MainActor
final class FomoTwinScene: ObservableObject {
    enum Stage: String { case idle, fetching, loading, ready, failed }
    @Published private(set) var stage: Stage = .idle
    @Published private(set) var note: String = ""
    @Published private(set) var loaded = false
    @Published private(set) var ghostVisible = true

    let root = Entity()               // scene root: camera + light + arms
    let actual = Entity()             // `arm` clone, solid
    let ghost = Entity()              // `arm` clone, translucent
    let cameraAnchor = Entity()
    let camera = PerspectiveCamera()
    private var actualLinks: [String: Entity] = [:]
    private var ghostLinks: [String: Entity] = [:]
    private var joints = FomoTwinMath.joints
    private var loadTask: Task<Void, Never>?

    // orbit state (radians / metres), framed like twin.js: target at ~0.12 m up, 0.72/0.42/0.62 direction
    var yaw: Float = 0.86, pitch: Float = 0.45, distance: Float = 0.55
    var target = SIMD3<Float>(0, 0.12, 0)

    init() {
        root.addChild(cameraAnchor)
        cameraAnchor.addChild(camera)
        camera.camera.fieldOfViewInDegrees = 40
        let sun = DirectionalLight()
        sun.light.intensity = 2200
        sun.look(at: [0, 0, 0], from: [0.6, 1.2, 0.8], relativeTo: nil)
        root.addChild(sun)
        let fill = PointLight(); fill.light.intensity = 900; fill.position = [-0.5, 0.4, -0.4]
        root.addChild(fill)
        // twin.js: robot.rotation.x = -pi/2 (Z-up URDF data in a Y-up world)
        actual.orientation = FomoTwinMath.rootRotation
        ghost.orientation = FomoTwinMath.rootRotation
        root.addChild(actual); root.addChild(ghost)
        updateCamera()
    }

    func load(base: URL?, armJSON: [String: Any]? = nil) {
        guard loadTask == nil, !loaded, let base else { return }
        if let j = armJSON.flatMap(FomoTwinMath.joints(fromArmJSON:)) { joints = j }
        stage = .fetching
        loadTask = Task { [weak self] in
            do {
                let (file, how) = try await FomoTwinAsset.localURL(base: base)
                await MainActor.run { self?.stage = .loading; self?.note = how }
                let entity = try await Entity(contentsOf: file)
                await MainActor.run { self?.install(entity) }
            } catch {
                await MainActor.run { self?.stage = .failed; self?.note = error.localizedDescription }
            }
            await MainActor.run { self?.loadTask = nil }
        }
    }

    private func install(_ arm: Entity) {
        for child in actual.children { child.removeFromParent() }
        for child in ghost.children { child.removeFromParent() }
        let a = arm.clone(recursive: true), g = arm.clone(recursive: true)
        actual.addChild(a); ghost.addChild(g)
        actualLinks = [:]; ghostLinks = [:]
        for j in joints {
            actualLinks[j.name] = a.findEntity(named: j.child)
            ghostLinks[j.name] = g.findEntity(named: j.child)
        }
        ghost.components.set(OpacityComponent(opacity: 0.3))
        let found = joints.filter { actualLinks[$0.name] != nil }.count
        loaded = found == joints.count
        stage = loaded ? .ready : .failed
        if !loaded { note = "USDZ missing link entities: \(joints.filter { actualLinks[$0.name] == nil }.map(\.child).joined(separator: ","))" }
        else { note += " · links \(found)/\(joints.count)" }
        frame()
    }

    /// Servo readings {id: deg} → link rotations, exactly twin.js `_setTargets` + `setRotationFromAxisAngle`.
    func apply(actual degrees: [Int: Double]) {
        guard degrees != lastActual else { return }
        lastActual = degrees
        apply(degrees, to: actualLinks)
    }
    /// Called from RealityView's `update:` — MUST NOT publish unless something changed, or SwiftUI re-runs `update:`
    /// forever (this exact loop starved the main thread on the sim and hung XCUITest's idle wait).
    func apply(commanded degrees: [Int: Double]?) {
        let visible = degrees != nil
        if ghostVisible != visible { ghostVisible = visible; ghost.isEnabled = visible }
        if let degrees, degrees != lastGhost { lastGhost = degrees; apply(degrees, to: ghostLinks) }
    }
    private var lastGhost: [Int: Double]?
    private var lastActual: [Int: Double]?
    private func apply(_ degrees: [Int: Double], to links: [String: Entity]) {
        for j in joints {
            guard let d = degrees[j.id], let e = links[j.name] else { continue }
            let q = FomoTwinMath.q(id: j.id, deg: d, limits: (j.lower, j.upper))
            e.transform.rotation = FomoTwinMath.rotation(j, q: q)
        }
    }

    /// Fit the posed actual arm (twin.js `frame`): span → distance, target a little below the centre.
    func frame() {
        let b = actual.visualBounds(relativeTo: root)
        guard !b.extents.x.isNaN, b.extents.x > 0 else { return }
        let span = max(b.extents.x, b.extents.y * 1.2, b.extents.z)
        distance = span / (2 * tan(camera.camera.fieldOfViewInDegrees * .pi / 360)) * 1.3
        target = [b.center.x, max(0.06, b.center.y * 0.92), b.center.z]
        updateCamera()
    }

    func orbit(dYaw: Float, dPitch: Float) {
        yaw += dYaw
        pitch = min(max(pitch + dPitch, -0.2), 1.35)
        updateCamera()
    }
    func zoom(scale: Float) {
        distance = min(max(distance / max(scale, 0.01), 0.15), 3)
        updateCamera()
    }
    func updateCamera() {
        let p = SIMD3<Float>(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw)) * distance + target
        cameraAnchor.position = p
        cameraAnchor.look(at: target, from: p, relativeTo: nil)
    }
}

// MARK: - SwiftUI view

struct FomoTwinView: View {
    @ObservedObject var fomo: FomoManager
    @StateObject private var scene = FomoTwinScene()
    var compact = false
    @State private var lastDrag: CGSize = .zero
    @State private var lastScale: CGFloat = 1

    var body: some View {
        ZStack {
            Rectangle().fill(Color(white: 0.09))
            if scene.stage == .failed {
                FomoTwinWebFallback(url: fomo.client?.base)
                    .accessibilityIdentifier("fomo-twin-fallback")
                    .overlay(alignment: .bottom) {
                        Text("native twin failed: \(scene.note) — showing the web twin")
                            .font(.caption2).foregroundStyle(.secondary).padding(4)
                            .accessibilityIdentifier("fomo-twin-fallback-why")
                    }
            } else {
                RealityView { content in
                    content.add(scene.root)
                } update: { _ in
                    if let s = fomo.state { scene.apply(actual: Dictionary(uniqueKeysWithValues: s.joints.map { ($0.id, $0.deg) })) }
                    scene.apply(commanded: fomo.commandedDegrees)
                }
                .gesture(DragGesture(minimumDistance: 2)
                    .onChanged { v in
                        let dx = Float(v.translation.width - lastDrag.width), dy = Float(v.translation.height - lastDrag.height)
                        lastDrag = v.translation
                        scene.orbit(dYaw: -dx * 0.008, dPitch: dy * 0.008)
                    }
                    .onEnded { _ in lastDrag = .zero })
                .simultaneousGesture(MagnifyGesture()
                    .onChanged { v in scene.zoom(scale: Float(v.magnification / lastScale)); lastScale = v.magnification }
                    .onEnded { _ in lastScale = 1 })
                if scene.stage != .ready {
                    VStack(spacing: 6) {
                        ProgressView().tint(.white)
                        Text(stageLine).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .accessibilityIdentifier("fomo-twin-stage")
                }
            }
        }
        .overlay(alignment: .topLeading) { badge }
        .overlay(alignment: .bottomLeading) { if !compact { legend } }
        .onAppear { scene.load(base: fomo.client?.base) }
        .onChange(of: fomo.client?.base) { _, b in scene.load(base: b) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-twin")
        .accessibilityValue("loaded=\(scene.loaded) stage=\(scene.stage.rawValue) ghost=\(scene.ghostVisible) \(scene.note)")
    }

    private var stageLine: String {
        switch scene.stage {
        case .idle: return fomo.client == nil ? "waiting for the arm's address…" : "twin idle"
        case .fetching: return "fetching arm.usdz from \(fomo.client?.base.host ?? "Fomo")…"
        case .loading: return "loading the twin (\(scene.note))…"
        case .ready: return ""
        case .failed: return scene.note
        }
    }

    private var badge: some View {
        // Expire even if polling fails silently and publishes no new state.
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let fresh = FomoCore.stateFresh(fomo.state, requestStartedAt: fomo.stateAt, now: context.date)
            HStack(spacing: 4) {
                Circle().fill(scene.loaded ? (fresh ? Color.green : Color.orange) : Color.secondary).frame(width: 5, height: 5)
                Text(scene.loaded ? FomoCore.twinStatus(fomo.state, requestStartedAt: fomo.stateAt, now: context.date) : "twin")
                    .font(.caption2.weight(.medium))
            }
        }
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(.black.opacity(0.6), in: Capsule())
        .foregroundStyle(.white.opacity(0.9))
        .padding(8)
        .accessibilityIdentifier("fomo-twin-badge")
    }

    private var legend: some View {
        HStack(spacing: 10) {
            Label("actual", systemImage: "circle.fill").foregroundStyle(.white.opacity(0.9))
            Label(fomo.commandedDegrees == nil ? "no target yet" : "target (this phone)", systemImage: "circle.dotted")
                .foregroundStyle(.white.opacity(0.55))
        }
        .font(.caption2)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.black.opacity(0.5), in: Capsule())
        .padding(8)
        .accessibilityIdentifier("fomo-twin-legend")
    }
}

/// Per-joint HUD under the twin: actual vs target degrees, rail, torque, guard words verbatim.
struct FomoTwinHUD: View {
    @ObservedObject var fomo: FomoManager

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(FomoTwinMath.joints) { j in
                let actual = fomo.state?.joints.first { $0.id == j.id }
                let target = fomo.commandedDegrees?[j.id]
                HStack {
                    Text(j.servo).font(.caption.monospaced()).frame(width: 96, alignment: .leading)
                    Text(actual.map { String(format: "%.1f°", $0.deg) } ?? "—").font(.caption.monospaced())
                    Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.secondary)
                    Text(target.map { String(format: "%.1f°", $0) } ?? "·").font(.caption.monospaced())
                        .foregroundStyle(target == nil ? .secondary : .primary)
                    Spacer()
                    if let a = actual, let t = target {
                        Text(String(format: "%+.1f", FomoTwinMath.wrap(t - a.deg))).font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                    Image(systemName: actual?.torque == true ? "bolt.fill" : "bolt.slash").font(.caption2)
                        .foregroundStyle(actual?.torque == true ? .orange : .secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("fomo-twin-joint-\(j.servo)")
                .accessibilityValue("\(actual.map { String(format: "%.1f", $0.deg) } ?? "-") -> \(target.map { String(format: "%.1f", $0) } ?? "-") torque=\(actual?.torque ?? false)")
            }
            HStack(spacing: 12) {
                Text(fomo.state?.voltage.map { String(format: "rail %.1f V", $0) } ?? "rail —")
                Text(fomo.state?.busy.map { "busy: \($0)" } ?? (fomo.state?.folded == true ? "folded" : "idle"))
                if let t = fomo.lastRefusal { Text(t).foregroundStyle(.red).lineLimit(2) }
            }
            .font(.caption2).foregroundStyle(.secondary)
            .accessibilityIdentifier("fomo-twin-status")
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-twin-hud")
    }
}

/// Fallback only when RealityKit cannot load the USDZ on this device: the web dash's twin.
struct FomoTwinWebFallback: UIViewRepresentable {
    let url: URL?
    func makeUIView(context: Context) -> WKWebView {
        let w = WKWebView()
        w.isOpaque = false
        if let url { w.load(URLRequest(url: url)) }   // the dash is an SPA; its home shows the twin panel
        return w
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

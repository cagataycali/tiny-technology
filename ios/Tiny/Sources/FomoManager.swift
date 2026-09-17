/**
 * 🦾 FomoManager — the model behind the Fomo PiP card and FomoScreen.
 *
 * It rides on ArmManager for what already works (device discovery from the
 * account's device rows, the MJPEG stream / snapshot fallback and the freshness
 * badge) and adds what Fomo's real API offers: the flat /api/state HUD (rail V,
 * torque, folded, Nicla, RL, motion progress), the motions and poses galleries,
 * control through FomoClient (every refusal → `toast` verbatim), the photo, the
 * RL seat and the /ws/agent conversation. PiP layout preferences (corner, size,
 * open) persist in UserDefaults so the card comes back where it was left.
 */
import Combine
import SwiftUI
import UIKit

enum FomoPiPCorner: String, CaseIterable, Codable {
    case topLeading, topTrailing, bottomLeading, bottomTrailing
    var isTop: Bool { self == .topLeading || self == .topTrailing }
    var isLeading: Bool { self == .topLeading || self == .bottomLeading }

    /// Nearest corner to a point inside `size` — the snap decision (pure, tested).
    static func nearest(to p: CGPoint, in size: CGSize) -> FomoPiPCorner {
        let top = p.y < size.height / 2
        let leading = p.x < size.width / 2
        switch (top, leading) {
        case (true, true): return .topLeading
        case (true, false): return .topTrailing
        case (false, true): return .bottomLeading
        case (false, false): return .bottomTrailing
        }
    }
}

enum FomoPiPSize: String, CaseIterable, Codable {
    case thumb, half
    var next: FomoPiPSize { self == .thumb ? .half : .thumb }
    /// Picture size for a given container width (16:9 for half, the old 4:3 thumb).
    func picture(in width: CGFloat) -> CGSize {
        switch self {
        case .thumb: return CGSize(width: 236, height: 177)
        case .half:
            let w = max(240, width - 16)
            return CGSize(width: w, height: (w * 9 / 16).rounded())
        }
    }
}

/// UserDefaults-backed layout prefs. Static so the ChatView's `showArmLive`
/// initial value can read `open` without any model.
enum FomoPiPView: String, CaseIterable { case camera, twin }

enum FomoPiPPrefs {
    static let cornerKey = "fomo.pip.corner", sizeKey = "fomo.pip.size", openKey = "fomo.pip.open", viewKey = "fomo.pip.view"
    static var view: FomoPiPView {
        get { UserDefaults.standard.string(forKey: viewKey).flatMap(FomoPiPView.init) ?? .camera }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: viewKey) }
    }
    static var corner: FomoPiPCorner {
        get { UserDefaults.standard.string(forKey: cornerKey).flatMap(FomoPiPCorner.init) ?? .topTrailing }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: cornerKey) }
    }
    static var size: FomoPiPSize {
        get { UserDefaults.standard.string(forKey: sizeKey).flatMap(FomoPiPSize.init) ?? .thumb }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: sizeKey) }
    }
    static var open: Bool {
        get { UserDefaults.standard.bool(forKey: openKey) }
        set { UserDefaults.standard.set(newValue, forKey: openKey) }
    }
}

@MainActor
final class FomoManager: ObservableObject {
    static let shared = FomoManager()

    /// Mirrors ArmManager.device so the card and the screen can observe THIS
    /// object only: ArmManager also publishes `frame` at stream rate (~19 fps),
    /// and a view observing it re-lays out its whole body on every frame (the
    /// segmented picker missed taps under that). Only FomoPicture observes ArmManager.
    @Published private(set) var device: ArmDevice?
    @Published private(set) var client: FomoClient?
    @Published private(set) var state: FomoCore.State?
    /// Request start (not receipt), so liveness includes transport delay.
    @Published private(set) var stateAt: Date?
    @Published private(set) var motions: [FomoCore.Motion] = []
    @Published private(set) var poses: [FomoCore.Pose] = []
    @Published private(set) var listsAt: Date?
    @Published var toast: String?
    @Published private(set) var lastPhoto: UIImage?
    @Published private(set) var lastPhotoPath: String?
    @Published private(set) var photoBusy = false
    /// What the phone asked for and is waiting on ("motion wave", "torque on"…).
    @Published private(set) var pending: String?
    @Published private(set) var target: ArmCore.Look?
    @Published private(set) var agent: FomoAgent?
    /// The ghost arm: last target THIS phone asked for, per servo id in absolute servo degrees. Fomo's state has no
    /// commanded field, so this is the app's own memory; nil until the first command. Cleared by STOP.
    @Published private(set) var commandedDegrees: [Int: Double]?
    /// The guard's last refusal, verbatim (422/409 body.error), shown under the servo row and in the twin HUD.
    @Published private(set) var lastRefusal: String?
    /// Servo id whose slider is being dragged (coalesced sends), and its pending target.
    @Published private(set) var servoPending: [Int: Double] = [:]
    /// Which view the PiP card shows: camera or twin (persisted).
    @Published var pipView: FomoPiPView = FomoPiPPrefs.view { didSet { FomoPiPPrefs.view = pipView } }

    @Published var corner: FomoPiPCorner = FomoPiPPrefs.corner { didSet { FomoPiPPrefs.corner = corner } }
    @Published var size: FomoPiPSize = FomoPiPPrefs.size { didSet { FomoPiPPrefs.size = size } }

    private var pollTask: Task<Void, Never>?
    private var deviceSub: AnyCancellable?

    private init() {
        device = ArmManager.shared.device
        deviceSub = ArmManager.shared.$device
            .removeDuplicates { $0?.id == $1?.id && $0?.url == $1?.url && $0?.name == $1?.name }
            .receive(on: RunLoop.main)
            .sink { [weak self] d in self?.device = d }
    }
    private var sessionToken: String?
    private var lastSentAt: TimeInterval?
    private var lastSent: ArmCore.Look?
    private var pendingLook: ArmCore.Look?
    private var flushTask: Task<Void, Never>?
    private var servoLastSentAt: [Int: TimeInterval] = [:]
    private var servoQueued: [Int: Double] = [:]
    private var servoFlushTask: Task<Void, Never>?
    /// The arm's stream/badge/frame come from ArmManager (one MJPEG reader, not two).
    var arm: ArmManager { ArmManager.shared }

    var lookRange: ArmCore.LookRange { state?.look ?? .fallback }
    var currentLook: ArmCore.Look? { state?.currentLook }
    var hasKey: Bool { Keychain.get(ArmManager.tokenKey) != nil || sessionToken != nil }
    var stateFresh: Bool { FomoCore.stateFresh(state, requestStartedAt: stateAt) }

    // ── Wiring ──────────────────────────────────────────────────────────────

    /// Point at the arm row ArmManager found; the bearer is the pasted arm token
    /// if any, else the owner's tiny session (Fomo's auth.py verifies it upstream).
    func configure(device: ArmDevice?, sessionToken: String?) {
        self.sessionToken = sessionToken
        guard let device else { client = nil; agent?.close(); agent = nil; stopPolling(); return }
        if client?.base.absoluteString != device.url {
            let tokenBox = TokenBox()
            tokenBox.session = sessionToken
            let key = ArmManager.tokenKey
            client = FomoClient(baseString: device.url) { [tokenBox] in Keychain.get(key) ?? tokenBox.session }
            self.tokenBox = tokenBox
            agent?.close(); agent = nil
            motions = []; poses = []; listsAt = nil
        }
        tokenBox?.session = sessionToken
    }
    private var tokenBox: TokenBox?
    private final class TokenBox: @unchecked Sendable { var session: String? }

    func startPolling() {
        guard pollTask == nil, client != nil else { return }
        pollTask = Task { [weak self] in await self?.pollLoop() }
    }

    func stopPolling() {
        pollTask?.cancel(); pollTask = nil
        flushTask?.cancel(); flushTask = nil
        pendingLook = nil; target = nil
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            if arm.sceneActive, let client {
                let requestStartedAt = Date()
                if let s = try? await client.state() {
                    if Task.isCancelled { return }
                    state = s; stateAt = requestStartedAt
                }
                if listsAt.map({ Date().timeIntervalSince($0) > 30 }) ?? true { await refreshLists() }
            }
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    func refreshLists() async {
        guard let client else { return }
        if let m = try? await client.motions() { motions = m }
        if let p = try? await client.poses() { poses = p }
        listsAt = Date()
    }

    func ensureAgent() -> FomoAgent? {
        if let agent { return agent }
        guard let client else { return nil }
        let a = FomoAgent(client: client)
        agent = a
        a.connect()
        return a
    }

    // ── Control ─────────────────────────────────────────────────────────────

    /// Joystick: latest target wins, sent at most every 100 ms (10 Hz).
    func requestLook(_ look: ArmCore.Look) {
        let r = lookRange
        let clamped = ArmCore.Look(pan: min(max(look.pan, r.pan.lowerBound), r.pan.upperBound),
                                   tilt: min(max(look.tilt, r.tilt.lowerBound), r.tilt.upperBound))
        target = clamped
        guard ArmCore.changed(lastSent, clamped) else { return }
        pendingLook = clamped
        let now = Date().timeIntervalSince1970
        if ArmCore.shouldSend(now: now, last: lastSentAt, minInterval: FomoCore.minLookInterval) {
            flushLook()
        } else if flushTask == nil {
            let wait = FomoCore.minLookInterval - (now - (lastSentAt ?? now))
            flushTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(Int(max(wait, 0.02) * 1000)))
                await MainActor.run { self?.flushTask = nil; self?.flushLook() }
            }
        }
    }

    private func flushLook() {
        guard let look = pendingLook, let client else { return }
        pendingLook = nil
        lastSentAt = Date().timeIntervalSince1970
        lastSent = look
        if let p = state?.joints.first(where: { $0.id == 5 }), let t = state?.joints.first(where: { $0.id == 6 }) {
            var c = commandedDegrees ?? [:]
            c[5] = p.home + look.pan; c[6] = t.home + look.tilt
            commandedDegrees = c
        }
        Task { [weak self] in
            do { try await client.look(pan: look.pan, tilt: look.tilt) }
            catch let e as FomoError { self?.refused(e) }
            catch {}
        }
    }

    func stop() { commandedDegrees = nil; servoQueued = [:]; servoPending = [:]; run("stop", quiet: true) { try await $0.stop() } }
    func home() { commandHome(); run("home") { try await $0.home() } }
    func fold() { commandHome(); run("fold") { try await $0.pose("home") } }
    private func commandHome() {
        guard let s = state, !s.joints.isEmpty else { return }
        commandedDegrees = Dictionary(uniqueKeysWithValues: s.joints.map { ($0.id, $0.home) })
    }

    // ── Per-servo control (Servos tab + twin ghost) ─────────────────────────

    /// Slider window for a servo: the guard's calibrated EEPROM window, else URDF limits in servo degrees.
    func servoWindow(_ id: Int) -> ClosedRange<Double> {
        FomoTwinMath.window(id: id, windows: state?.windows ?? [:])
    }

    /// Drag → target in absolute servo degrees. Coalesced latest-wins at ≤ 10 Hz per servo; the ghost previews at once.
    func moveServo(_ id: Int, to deg: Double, final: Bool = false) {
        guard let j = FomoTwinMath.joint(id: id) else { return }
        let w = servoWindow(id)
        let clamped = min(max(deg, w.lowerBound), w.upperBound)
        var c = commandedDegrees ?? [:]; c[id] = clamped; commandedDegrees = c
        servoPending[id] = clamped
        servoQueued[id] = clamped
        let now = Date().timeIntervalSince1970
        if final || ArmCore.shouldSend(now: now, last: servoLastSentAt[id], minInterval: FomoCore.minLookInterval) {
            flushServo(id, j)
        } else if servoFlushTask == nil {
            let wait = FomoCore.minLookInterval - (now - (servoLastSentAt[id] ?? now))
            servoFlushTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(Int(max(wait, 0.02) * 1000)))
                await MainActor.run {
                    guard let self else { return }
                    self.servoFlushTask = nil
                    for (qid, _) in self.servoQueued { if let qj = FomoTwinMath.joint(id: qid) { self.flushServo(qid, qj) } }
                }
            }
        }
    }

    private func flushServo(_ id: Int, _ j: FomoTwinMath.Joint) {
        guard let deg = servoQueued.removeValue(forKey: id), let client else { return }
        servoLastSentAt[id] = Date().timeIntervalSince1970
        lastRefusal = nil
        Task { [weak self] in
            do {
                _ = try await client.move(FomoTwinMath.moveBody(joint: j, to: deg))
                await MainActor.run { if self?.servoQueued[id] == nil { self?.servoPending[id] = nil } }
            } catch let e as FomoError {
                await MainActor.run {
                    guard let self else { return }
                    self.lastRefusal = e.message
                    self.servoPending[id] = nil
                    // the ghost snaps back to the reading the guard refused to leave
                    if let a = self.state?.joints.first(where: { $0.id == id }) { self.commandedDegrees?[id] = a.deg }
                    TinyDesign.haptic(.rigid)
                }
            } catch {}
        }
    }

    /// Torque for ONE servo. Fomo echoes `ids`; if it switched more than asked, say so in the toast.
    func servoTorque(_ id: Int, _ on: Bool) {
        guard let client else { toast = "No arm known yet."; return }
        lastRefusal = nil
        Task { [weak self] in
            do {
                let r = try await client.torque(on, ids: [id])
                let ids = (r["ids"] as? [Any])?.compactMap { EndpointTelemetry.number($0) }.map { Int($0) } ?? []
                await MainActor.run {
                    if ids.count > 1 { self?.toast = "Fomo switched torque for \(ids.count) servos (its /api/control/torque ignores ids yet)" }
                    TinyDesign.haptic(.light)
                }
            } catch let e as FomoError { await MainActor.run { self?.lastRefusal = e.message; self?.refused(e) } }
            catch {}
        }
    }
    func torque(_ on: Bool) { run(on ? "torque on" : "torque off") { try await $0.torque(on) } }
    func motion(_ name: String) { run("motion \(name)") { try await $0.motion(name) } }
    func pose(_ name: String) { run("pose \(name)") { try await $0.pose(name) } }
    func rlShadow(_ policy: String, seconds: Double = 20) { run("shadow \(policy)") { try await $0.rlShadow(policy: policy, seconds: seconds) } }
    func rlLive(seconds: Double = 20) { run("rl live") { try await $0.rlLive(seconds: seconds) } }
    func rlStop() { run("rl stop") { try await $0.rlStop() } }

    func photo() async {
        guard let client, !photoBusy else { return }
        photoBusy = true
        defer { photoBusy = false }
        do {
            let (data, path) = try await client.takePhoto()
            if let img = UIImage(data: data) {
                lastPhoto = img; lastPhotoPath = path
                TinyDesign.haptic(.light)
            } else {
                toast = "Photo answered but was not a JPEG (\(data.count) B)."
            }
        } catch let e as FomoError { refused(e) } catch { toast = error.localizedDescription }
    }

    private func run(_ label: String, quiet: Bool = false, _ op: @escaping @Sendable (FomoClient) async throws -> Any) {
        guard let client else { toast = "No arm known yet."; return }
        pending = label
        Task { [weak self] in
            defer { Task { @MainActor in if self?.pending == label { self?.pending = nil } } }
            do {
                _ = try await op(client)
                if !quiet { TinyDesign.haptic(.light) }
            } catch let e as FomoError { self?.refused(e) } catch { self?.toast = error.localizedDescription }
        }
    }

    private func refused(_ e: FomoError) {
        toast = e.message
        TinyDesign.haptic(.rigid)
    }
}

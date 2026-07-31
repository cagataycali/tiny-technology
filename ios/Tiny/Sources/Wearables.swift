/**
 * 🕶️ Meta Wearables (DAT) — the glasses join the tiny device fleet.
 *
 * One @MainActor manager over the Meta Wearables Device Access Toolkit:
 * `configure()` once at launch, `link()`/`unlink()` hand off to the Meta AI
 * app (which calls back via tinyapp:// or the /wearables universal link —
 * `handle(url:)` gives the SDK first claim), and `capturePhoto()` runs the
 * full session dance (session → started → stream → streaming → capture →
 * teardown) to turn "what am I looking at?" into JPEG bytes for the agent.
 *
 * ⚠️ Everything is behind `#if canImport(MWDATCore)`: the 0.8.0 xcframeworks
 * ship device + simulator slices ONLY. A Mac Catalyst build has no module,
 * so this whole file compiles to nothing there — and the package link in
 * project.yml carries `platformFilter: iOS` for the same reason. Call sites
 * (TinyApp, Settings) repeat the guard.
 */
import Foundation
import SwiftUI
import UIKit

#if canImport(MWDATCore) && canImport(MWDATCamera)
import MWDATCore
import MWDATCamera

enum WearablesCaptureError: LocalizedError {
    case notConfigured
    case notLinked
    case notConnected
    case cameraDenied
    case noStream
    case sessionEnded
    case timedOut

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "The glasses SDK is not running on this device."
        case .notLinked: return "No Meta glasses are linked — link them in Settings first."
        case .notConnected: return "The glasses are linked but not reachable right now — make sure they're on your face (not folded/in the case), awake, and near the phone, then ask again."
        case .cameraDenied: return "Camera permission for the glasses was denied in the Meta AI app."
        case .noStream: return "The glasses session could not open a camera stream."
        case .sessionEnded: return "The glasses session ended before a photo arrived."
        case .timedOut: return "Timed out waiting for the glasses."
        }
    }
}

@MainActor
final class WearablesManager: ObservableObject {
    static let shared = WearablesManager()

    @Published private(set) var registration: RegistrationState = .unavailable
    @Published private(set) var deviceNames: [String] = []
    @Published var lastError: String?
    /// Live thermal level of the active glasses (deviceStateStream) — the one
    /// piece of device telemetry DAT 0.8.0 exposes beyond link state.
    @Published private(set) var thermal: ThermalLevel?
    private var thermalTask: Task<Void, Never>?

    private var configured = false
    private var registrationTask: Task<Void, Never>?
    private var devicesTask: Task<Void, Never>?
    /// ONE long-lived selector, created at configure() like the sample's
    /// DeviceSessionManager — a selector discovers the active device by
    /// OBSERVING, so one built fresh inside capturePhoto() knows nothing yet
    /// and createSession() throws noEligibleDevice ("No eligible device
    /// available", the first live capture's exact failure).
    private var selector: AutoDeviceSelector?

    var isLinked: Bool { registration == .registered }

    var statusText: String {
        switch registration {
        case .unavailable: return "Meta AI app unavailable"
        case .available: return "Not linked"
        case .registering: return "Linking…"
        case .registered:
            return deviceNames.isEmpty ? "Linked — no glasses nearby" : deviceNames.joined(separator: ", ")
        }
    }

    /// Must run before any other SDK call (TinyApp.init). Reads MWDAT config
    /// from Info.plist; failure is surfaced, not fatal — the rest of the app
    /// owes nothing to the glasses.
    func configure() {
        guard !configured else { return }
        do { try Wearables.configure() } catch {
            lastError = "Glasses SDK failed to start: \(error.localizedDescription)"
            return
        }
        configured = true
        let wearables = Wearables.shared
        selector = AutoDeviceSelector(wearables: wearables)
        registration = wearables.registrationState
        deviceNames = Self.names(wearables.devices)
        registrationTask = Task { [weak self] in
            for await state in wearables.registrationStateStream() {
                self?.registration = state
            }
        }
        devicesTask = Task { [weak self] in
            for await ids in wearables.devicesStream() {
                self?.deviceNames = Self.names(ids)
                self?.reaimThermal(ids.first)
            }
        }
    }

    /// One thermal observer, re-aimed at the first device whenever the set
    /// changes (a second pair is a rarity not worth N streams).
    private func reaimThermal(_ id: DeviceIdentifier?) {
        thermalTask?.cancel()
        thermalTask = nil
        thermal = nil
        guard let id else { return }
        thermalTask = Task { [weak self] in
            for await state in Wearables.shared.deviceStateStream(for: id) {
                self?.thermal = state.thermalLevel
            }
        }
    }

    /// Real, non-empty names only — freshly-linked glasses can report an
    /// empty name, which made statusText render as NOTHING next to "Status"
    /// (user QA, 2026-07-28). An unnamed device still counts as present.
    private static func names(_ ids: [DeviceIdentifier]) -> [String] {
        let wearables = Wearables.shared
        let named = ids.compactMap { wearables.deviceForIdentifier($0)?.name }.filter { !$0.isEmpty }
        if named.isEmpty && !ids.isEmpty { return ["Glasses connected"] }
        return named
    }

    /// Process a DAT callback URL (caller has already matched the
    /// metaWearablesAction query item). The error is SHOWN, not swallowed —
    /// a silent catch here is a link flow that fails with "still not linked"
    /// and no way to know why.
    @discardableResult
    func handle(url: URL) async -> Bool {
        guard configured else { return false }
        do {
            return try await Wearables.shared.handleUrl(url)
        } catch {
            lastError = "Link callback failed: \(error.localizedDescription)"
            return false
        }
    }

    /// Re-read state on foregrounding: if the Meta AI app finished without a
    /// callback (or we missed it), the truth is one property read away.
    func refresh() {
        guard configured else { return }
        registration = Wearables.shared.registrationState
        deviceNames = Self.names(Wearables.shared.devices)
    }

    /// One line of live device context for the agent (nil when not linked) —
    /// rides extraSystem beside the location block, so the model knows the
    /// glasses exist before it reaches for meta_take_photo.
    func contextIfLinked() -> String? {
        guard configured, isLinked else { return nil }
        let wearables = Wearables.shared
        var lines: [String] = []

        // Per-device facts: everything DAT 0.8.0 exposes (name, type, link
        // state, thermal, display) — deep context so the agent "just works"
        // instead of guessing at the hardware.
        let devices = wearables.devices.compactMap { wearables.deviceForIdentifier($0) }
        if devices.isEmpty {
            lines.append("🕶 Meta glasses: linked to this phone, but none nearby right now — the user may need to wear or wake them before camera asks.")
        } else {
            let parts = devices.map { device -> String in
                var bits: [String] = []
                switch device.linkState {
                case .connected: bits.append("connected")
                case .connecting: bits.append("connecting")
                case .disconnected: bits.append("disconnected")
                }
                bits.append(device.deviceType().rawValue)
                if device.supportsDisplay() { bits.append("has a display") }
                if let thermal, thermal != .unknown {
                    bits.append("thermal \(String(describing: thermal))")
                }
                return "\(device.nameOrId()) (\(bits.joined(separator: ", ")))"
            }
            let ready = selector?.activeDevice != nil
                ? "ready — meta_take_photo will capture what the user is LOOKING AT (their first-person camera)"
                : "not reachable for capture right now (asleep/folded/out of range — tell the user to wear or wake them before you try)"
            lines.append("🕶 Meta glasses: \(parts.joined(separator: "; ")) — \(ready).")
        }

        // Live HUD: when the user is watching the feed, say so — and carry
        // what the glasses just HEARD (on-device transcript) into context.
        if GlassesLive.shared.running {
            lines.append("The user has the live glasses feed OPEN on their phone right now.")
            let heard = GlassesLive.shared.transcript
            if !heard.isEmpty {
                lines.append("Heard through the glasses moments ago (on-device transcript): \"\(String(heard.suffix(400)))\"")
            }
        }
        return lines.joined(separator: "\n")
    }

    /// Execute the agent's meta_take_photo call: glasses photo → JPEG →
    /// /api/media (R2) → mailbox result. Same contract as Screenshot.run —
    /// EVERY path posts something; a silent failure strands the server
    /// callback until its 90s timeout.
    func runPhotoTool(toolUseId: String, token: String?) async -> GeneratedImage? {
        do {
            let image = try await captureAndUpload(id: toolUseId, token: token)
            await postResult(toolUseId, token: token, payload: ["ok": true, "url": image.url, "format": "jpeg"])
            return image
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            await postResult(toolUseId, token: token, payload: ["ok": false, "error": message])
            return nil
        }
    }

    /// Capture → downscale → upload once to /api/media. Shared by the chat
    /// mailbox executor above and the voice bridge (which answers over its
    /// own WS instead of the mailbox).
    func captureAndUpload(id: String, token: String?) async throws -> GeneratedImage {
        let raw = try await capturePhoto()
        guard let image = UIImage(data: raw) else {
            throw WearablesCaptureError.noStream
        }
        // Cap the long side like Screenshot: the glasses shoot large and
        // the model only needs legibility, not megapixels.
        guard let jpeg = Self.jpeg(image, maxSide: 1600, quality: 0.8) else {
            throw WearablesCaptureError.noStream
        }
        let preview = Self.jpeg(image, maxSide: 512, quality: 0.6) ?? jpeg
        let up: [String: Any] = try await Api.post("/api/media", token: token, body: [
            "data": jpeg.base64EncodedString(),
            "contentType": "image/jpeg",
        ])
        guard let url = up["url"] as? String else {
            throw WearablesCaptureError.timedOut
        }
        return GeneratedImage(id: id, url: url, prompt: "Glasses photo",
                              preview: preview.base64EncodedString())
    }

    /// Mirrors Screenshot/ImageGen's copies — best-effort; a failed post
    /// degrades to the server's timeout message.
    private func postResult(_ toolUseId: String, token: String?, payload: [String: Any]) async {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
            "toolUseId": toolUseId, "payload": json,
        ]) as [String: Any]
    }

    private static func jpeg(_ image: UIImage, maxSide: CGFloat, quality: CGFloat) -> Data? {
        let side = max(image.size.width, image.size.height)
        guard side > maxSide else { return image.jpegData(compressionQuality: quality) }
        let scale = maxSide / side
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }.jpegData(compressionQuality: quality)
    }

    /// Hand off to the Meta AI app to link the glasses (async — the result
    /// arrives through the URL callback and the registration stream).
    func link() {
        guard configured else { return }
        lastError = nil
        Task { [weak self] in
            do { try await Wearables.shared.startRegistration() }
            catch { self?.lastError = error.localizedDescription }
        }
    }

    func unlink() {
        guard configured else { return }
        lastError = nil
        Task { [weak self] in
            do { try await Wearables.shared.startUnregistration() }
            catch { self?.lastError = error.localizedDescription }
        }
    }

    /// The meta_glasses_status payload — the same facts contextIfLinked()
    /// narrates, as JSON for the on-demand tool (chat mailbox + voice WS).
    func statusFacts() -> [String: Any] {
        guard configured else {
            return ["ok": true, "linked": false, "note": "glasses SDK not running on this device"]
        }
        let wearables = Wearables.shared
        let devices: [[String: Any]] = wearables.devices.compactMap { id in
            guard let d = wearables.deviceForIdentifier(id) else { return nil }
            let link: String
            switch d.linkState {
            case .connected: link = "connected"
            case .connecting: link = "connecting"
            case .disconnected: link = "disconnected"
            }
            return [
                "name": d.nameOrId(),
                "type": d.deviceType().rawValue,
                "link": link,
                "hasDisplay": d.supportsDisplay(),
            ]
        }
        var facts: [String: Any] = [
            "ok": true,
            "linked": isLinked,
            "readyForCapture": selector?.activeDevice != nil,
            "devices": devices,
            "liveHudOpen": GlassesLive.shared.running,
            "recording": GlassesRecorder.shared.isRecording,
        ]
        if let thermal, thermal != .unknown { facts["thermal"] = String(describing: thermal) }
        return facts
    }

    // MARK: - Session opening (shared by photo capture and the live HUD)

    /// Glasses-camera permission, asking via Meta AI only when not yet granted.
    func ensureCameraPermission() async throws -> Bool {
        var status = try await Wearables.shared.checkPermissionStatus(.camera)
        if status != .granted { status = try await Wearables.shared.requestPermission(.camera) }
        return status == .granted
    }

    /// A STARTED DeviceSession against the active glasses, or a thrown
    /// reason. Callers own stop(). Handles the two live-QA-found races:
    /// waits for the long-lived selector to see an active device (≤15s),
    /// and retries once when eligibility flickers during link re-establish.
    func openSession(timeout: TimeInterval) async throws -> DeviceSession {
        guard configured, let selector else { throw WearablesCaptureError.notConfigured }
        guard isLinked else { throw WearablesCaptureError.notLinked }

        if selector.activeDevice == nil {
            _ = await Self.waitForActiveDevice(selector, seconds: 15)
        }
        guard selector.activeDevice != nil else { throw WearablesCaptureError.notConnected }

        let wearables = Wearables.shared
        let session: DeviceSession
        do {
            session = try wearables.createSession(deviceSelector: selector)
        } catch DeviceSessionError.noEligibleDevice {
            try await Task.sleep(nanoseconds: 2_000_000_000)
            do {
                session = try wearables.createSession(deviceSelector: selector)
            } catch DeviceSessionError.noEligibleDevice {
                throw WearablesCaptureError.notConnected
            }
        }

        // The state change is delivered off-thread and the stream does not
        // buffer past events — take the stream BEFORE start() and re-check
        // current state after (the sample app's own race note).
        let sessionStates = session.stateStream()
        do {
            try session.start()
        } catch {
            session.stop()
            throw error
        }
        if session.state != .started {
            do {
                let started = try await Self.first(of: sessionStates, timeout: timeout) { state -> Result<Bool, WearablesCaptureError>? in
                    if state == .started { return .success(true) }
                    if state == .stopped { return .failure(.sessionEnded) }
                    return nil
                }
                if case .failure(let error) = started { throw error }
            } catch {
                session.stop()
                throw error
            }
        }
        return session
    }

    // MARK: - One-shot photo capture

    /// One JPEG from the glasses camera, or a thrown reason. Session and
    /// stream are torn down before returning either way.
    func capturePhoto(timeout: TimeInterval = 45) async throws -> Data {
        // Glasses-camera permission lives in the Meta stack (the phone's own
        // NSCameraUsageDescription is a different camera).
        guard try await ensureCameraPermission() else { throw WearablesCaptureError.cameraDenied }

        let session = try await openSession(timeout: timeout)
        defer { session.stop() }

        guard let camStream = try session.addStream(config: StreamConfiguration()) else {
            throw WearablesCaptureError.noStream
        }

        // Bridge the listener-token world into one AsyncStream of outcomes.
        // Tokens must stay alive until the photo lands; the capture trigger
        // rides the state listener so it fires the moment streaming starts.
        var tokens: [AnyListenerToken] = []
        let outcomes = AsyncStream<Result<Data, StreamError>> { cont in
            tokens.append(camStream.photoDataPublisher.listen { photo in
                cont.yield(.success(photo.data))
            })
            tokens.append(camStream.errorPublisher.listen { err in
                cont.yield(.failure(err))
            })
            tokens.append(camStream.statePublisher.listen { state in
                if state == .streaming { _ = camStream.capturePhoto(format: .jpeg) }
            })
        }
        defer {
            camStream.stop()
            tokens.removeAll()
        }
        camStream.start()
        if camStream.state == .streaming { _ = camStream.capturePhoto(format: .jpeg) }

        let result = try await Self.first(of: outcomes, timeout: timeout) { $0 }
        switch result {
        case .success(let data): return data
        case .failure(let error): throw error
        }
    }

    /// Bounded wait for the selector to know an active device. True the
    /// moment one appears; false when `seconds` pass without one.
    private static func waitForActiveDevice(_ selector: AutoDeviceSelector, seconds: TimeInterval) async -> Bool {
        if selector.activeDevice != nil { return true }
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await device in selector.activeDeviceStream() where device != nil { return true }
                return false
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return selector.activeDevice != nil
            }
            let hit = await group.next() ?? false
            group.cancelAll()
            return hit
        }
    }

    /// First non-nil `pick` from `stream`, or `.timedOut` / `.sessionEnded`.
    private static func first<S: Sendable, T: Sendable>(
        of stream: AsyncStream<S>,
        timeout: TimeInterval,
        pick: @escaping @Sendable (S) -> T?
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                for await element in stream {
                    if let hit = pick(element) { return hit }
                }
                throw WearablesCaptureError.sessionEnded
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw WearablesCaptureError.timedOut
            }
            guard let value = try await group.next() else {
                throw WearablesCaptureError.sessionEnded
            }
            group.cancelAll()
            return value
        }
    }
}
#endif

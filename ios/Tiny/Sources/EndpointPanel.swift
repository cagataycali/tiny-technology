/**
 * 🤖 EndpointPanel — a robot's chamber camera + telemetry, inside the Devices sheet.
 *
 * Web parity: app/devices/page.tsx's EndpointPanel, same two polls (frames every
 * 2s, readings every 10s) and the same failure copy. Three things differ on iOS,
 * and each is a real constraint rather than a style choice:
 *
 *  1. The web can point an `<img src>` at the proxy and let the browser do the
 *     fetching, because its session rides a cookie. This app authenticates with a
 *     Bearer token, and a plain `AsyncImage` sends no headers — so frames must be
 *     fetched explicitly and decoded into a UIImage. That also means WE own the
 *     content-type check that the browser's image decoder gave us for free.
 *
 *  2. `document.hidden` becomes `scenePhase`. Same rule, and it matters more here:
 *     a phone that pockets mid-poll must stop calling someone's printer, and iOS
 *     will keep a Task alive briefly after backgrounding.
 *
 *  3. There is no polling `<img>` to lean on, so a slow frame could overlap the
 *     next tick. The fetch is serialized: one frame in flight at a time, a late
 *     one simply loses its turn.
 */
import SwiftUI
import UIKit

// ── Telemetry projection (pure — unit-tested) ───────────────────────────────

/// One labelled reading, ready to draw.
struct TelemetryReading: Identifiable, Equatable {
    var id: String { label }
    let label: String
    let value: String
}

/// Projection over a robot's telemetry payload.
///
/// This is a machine's own JSON, so every field is optional and every number is
/// suspect: a Bambu answers `chamber: null`, a mid-boot printer answers strings
/// where numbers belong. A missing or unparseable field is SKIPPED rather than
/// rendered — the web's rule (`Number.isFinite` or drop the row), because
/// "nozzle: NaN°" reads as a broken app rather than an absent sensor.
enum EndpointTelemetry {
    /// Tolerant numeric read: accepts a JSON number OR a numeric string, and
    /// rejects null/NaN/non-numeric. Bambu's MQTT payload mixes both forms
    /// (`temps.nozzle` is a number, `fan.cooling` is the string "0").
    static func number(_ any: Any?) -> Double? {
        if let d = any as? Double, d.isFinite { return d }
        if let i = any as? Int { return Double(i) }
        if let n = any as? NSNumber {
            let d = n.doubleValue
            return d.isFinite ? d : nil
        }
        if let s = any as? String, let d = Double(s), d.isFinite { return d }
        return nil
    }

    /// A temperature, with its target when the machine is actually heating to one.
    /// A target of 0 means "not heating" — printing "41° → 0°" would suggest an
    /// active cooldown command that doesn't exist.
    private static func temp(_ t: [String: Any], _ key: String) -> String? {
        guard let temps = t["temps"] as? [String: Any], let now = number(temps[key]) else { return nil }
        let target = number(temps["\(key)_target"]) ?? 0
        return target > 0 ? "\(Int(now.rounded()))° → \(Int(target.rounded()))°" : "\(Int(now.rounded()))°"
    }

    /// The readings worth a glance, in the web's reading order. Absent fields drop
    /// out entirely, so an idle printer shows a short list rather than a grid of
    /// dashes.
    static func readings(_ t: [String: Any]) -> [TelemetryReading] {
        var out: [TelemetryReading] = []
        func add(_ label: String, _ value: String?) {
            if let v = value, !v.isEmpty { out.append(TelemetryReading(label: label, value: v)) }
        }

        if let state = t["gcode_state"] as? String, !state.isEmpty {
            add("state", state.lowercased())
        }

        let job = (t["subtask_name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        if !job.isEmpty {
            // Only show a percentage when there IS one: "job · 0%" on a queued
            // print is less honest than just the name.
            if let pct = number(t["progress"]), pct > 0 {
                add("job", "\(job) · \(Int(pct))%")
            } else {
                add("job", job)
            }
        }

        add("nozzle", temp(t, "nozzle"))
        add("bed", temp(t, "bed"))

        if let layer = number(t["layer"]), let total = number(t["total_layers"]), total > 0 {
            add("layer", "\(Int(layer)) / \(Int(total))")
        }
        if let mins = number(t["remaining_min"]), mins > 0 {
            add("remaining", "\(Int(mins)) min")
        }
        return out
    }

    /// Is the machine mid-job? Drives the accent tint on the state row and the
    /// live badge, so a running printer reads differently at a glance.
    static func isRunning(_ t: [String: Any]?) -> Bool {
        ((t?["gcode_state"] as? String) ?? "").uppercased() == "RUNNING"
    }

    /// The one-line note for a failed poll.
    ///
    /// ⚠️ These must stay DISTINCT (web parity). A thinking robot is not an absent
    /// one, and a rejected credential is not a network problem — collapsing them
    /// is how a busy printer gets reported as unplugged, or how an expired token
    /// sends someone out to check cables.
    static func note(unauthorized: Bool, timeout: Bool, unreachable: Bool) -> String {
        if unauthorized { return "Credential rejected — re-enroll this device." }
        if timeout { return "Still working — no answer yet." }
        if unreachable { return "Not answering right now." }
        return "Telemetry unavailable."
    }

    /// Does this device show a camera?
    ///
    /// ⚠️ The live printer's capabilities are ["chat","telemetry","print","cad"] —
    /// no "camera" — so keying only on `camera` would hide the working chamber
    /// view. `print` implies a build chamber worth watching. A device claiming
    /// neither gets telemetry only, rather than a permanently-failing image box.
    static func hasCamera(_ capabilities: [String]) -> Bool {
        capabilities.contains("camera") || capabilities.contains("print")
    }

    /// `capabilities` arrives as a JSON *string* on the wire. A malformed one must
    /// mean "no capabilities", never a crash.
    static func parseCapabilities(_ raw: Any?) -> [String] {
        if let arr = raw as? [String] { return arr }
        guard let s = raw as? String, let data = s.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        return arr.compactMap { $0 as? String }
    }
}

// ── Camera frame fetch ──────────────────────────────────────────────────────

/// Fetches one camera frame from the app's endpoint proxy.
enum EndpointCamera {
    /// Types we will decode.
    ///
    /// ⚠️ Load-bearing, not hygiene. The proxy pins the type, but this app decodes
    /// bytes from a machine nobody here controls — so it re-asserts the allowlist
    /// rather than trusting a header. Anything else is treated as the JSON error
    /// body it almost certainly is. `image/svg+xml` is absent on purpose: UIImage
    /// won't decode it anyway, and it is the one image type that can script.
    static let types = ["image/jpeg", "image/png", "image/webp"]

    /// A robot is not a trusted size. Matches the worker's own 8MB cap.
    static let maxBytes = 8 * 1024 * 1024

    /// One frame, or nil. Deliberately nil-on-anything-wrong: the caller keeps the
    /// previous frame on screen, so a failed tick is invisible rather than a flash
    /// of empty box.
    static func frame(deviceId: String, token: String?) async -> UIImage? {
        // Cache-bust for the same reason the web does: URLSession's default cache
        // policy plus an identical URL can serve the same frame forever, and the
        // poll interval would be meaningless.
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        guard let url = URL(string: Api.base
            + "/api/devices/endpoint?deviceId=\(deviceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? deviceId)"
            + "&action=snapshot&t=\(stamp)") else { return nil }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        // Tighter than the JSON house rule (30s) on purpose: a frame is polled on
        // a timer, so a slow one should lose its turn rather than delay the ticks
        // behind it. Sits above the worker's own 10s image budget so the worker's
        // typed error wins the race.
        req.timeoutInterval = 15
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
        let type = (http.value(forHTTPHeaderField: "Content-Type") ?? "")
            .split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        guard types.contains(type), data.count <= maxBytes, !data.isEmpty else { return nil }
        return UIImage(data: data)
    }
}

// ── The panel ───────────────────────────────────────────────────────────────

struct EndpointPanel: View {
    let deviceId: String
    let deviceName: String
    let capabilities: [String]
    let token: String?

    @Environment(\.tinyAccent) private var accent
    @Environment(\.scenePhase) private var scenePhase

    @State private var telemetry: [String: Any]?
    @State private var note: String?
    @State private var frame: UIImage?
    @State private var cameraFailed = false
    /// Serializes the frame fetch: one in flight at a time, so a slow frame can't
    /// stack ticks behind it (the web gets this free from the browser's <img>).
    @State private var fetchingFrame = false

    private var hasCamera: Bool { EndpointTelemetry.hasCamera(capabilities) }
    private var running: Bool { EndpointTelemetry.isRunning(telemetry) }
    private var readings: [TelemetryReading] { telemetry.map { EndpointTelemetry.readings($0) } ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if hasCamera { cameraView }
            if !readings.isEmpty {
                // Two columns of label/value — a phone-width version of the web's
                // definition grid.
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                                    GridItem(.flexible(), alignment: .leading)],
                          alignment: .leading, spacing: 4) {
                    ForEach(readings) { r in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.label).font(.caption2).foregroundStyle(.secondary)
                            Text(r.value).font(.caption.monospaced())
                                .foregroundStyle(r.label == "state" && running ? accent : Color.primary)
                                .lineLimit(1)
                        }
                    }
                }
            }
            // One line, and only when there's something true to say. The last good
            // reading stays visible above it.
            if let note {
                Text(note).font(.caption2).foregroundStyle(.secondary)
            } else if telemetry == nil {
                Text("Reading telemetry…").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.top, 6)
        .task { await pollLoop() }
        .task(id: hasCamera) { await cameraLoop() }
    }

    private var cameraView: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.secondary.opacity(0.08))
            if let frame {
                Image(uiImage: frame)
                    .resizable()
                    .scaledToFill()
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .accessibilityLabel("Live camera view from \(deviceName)")
            } else {
                Text(cameraFailed ? "Camera unavailable" : "Connecting to camera…")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if frame != nil {
                // "live" badge, tinted only while a job is actually running.
                VStack {
                    HStack {
                        HStack(spacing: 4) {
                            Circle().fill(running ? accent : Color.secondary).frame(width: 5, height: 5)
                            Text("live").font(.caption2.weight(.medium))
                        }
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(.black.opacity(0.6), in: Capsule())
                        .foregroundStyle(running ? accent : Color.white.opacity(0.85))
                        Spacer()
                    }
                    Spacer()
                }
                .padding(8)
            }
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
        .clipped()
    }

    // ── Polls ───────────────────────────────────────────────────────────────

    /// Telemetry every 10s. `.task` is cancelled when the row disappears, which is
    /// what stops the loop — the sleep is the cancellation point.
    private func pollLoop() async {
        while !Task.isCancelled {
            // Backgrounded: skip the call, don't exit the loop. A phone in a pocket
            // must not keep calling someone's printer, but tabbing back should
            // resume without a re-mount.
            if scenePhase == .active { await tickTelemetry() }
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
        }
    }

    private func cameraLoop() async {
        guard hasCamera else { return }
        while !Task.isCancelled {
            if scenePhase == .active, !fetchingFrame {
                fetchingFrame = true
                let img = await EndpointCamera.frame(deviceId: deviceId, token: token)
                if Task.isCancelled { return }
                if let img {
                    frame = img
                    cameraFailed = false
                } else if frame == nil {
                    // Only admit failure while we've never had a frame. Once one
                    // has landed, a dropped tick leaves the last frame up rather
                    // than flashing an error over a working camera.
                    cameraFailed = true
                }
                fetchingFrame = false
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    private func tickTelemetry() async {
        // `getBody`, not `get`: the route answers a TYPED failure (unreachable /
        // timeout / unauthorized) with a 502, and `Api.get` throws those bodies
        // away. 40s matches the web's client deadline for this route, which sits
        // above the proxy's own 25s telemetry budget so the proxy's typed answer
        // wins the race.
        guard let body = await Api.getBody(
            "/api/devices/endpoint?deviceId=\(deviceId)&action=telemetry",
            token: token, timeoutSeconds: 40
        ) else {
            // nil is a true transport failure — no response at all.
            note = EndpointTelemetry.note(unauthorized: false, timeout: false, unreachable: true)
            return
        }
        if let result = body["result"] as? [String: Any], (body["ok"] as? Bool) == true {
            telemetry = result
            note = nil
            return
        }
        // ⚠️ Keep the LAST good reading: blanking the panel on one failed tick
        // makes a working machine look broken.
        note = EndpointTelemetry.note(
            unauthorized: (body["unauthorized"] as? Bool) == true,
            timeout: (body["timeout"] as? Bool) == true,
            unreachable: (body["unreachable"] as? Bool) == true)
    }
}

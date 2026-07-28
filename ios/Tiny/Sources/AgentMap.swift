/**
 * 🗺️ Agent map bridge — the iOS third of web's __tinyMapBridge and
 * Android's AgentMap.kt (agi-diy index.html:2607 lineage). The chat stream
 * feeds map tool calls here; TinyMapView and the ambient map observe and
 * draw. Pins are keyed by the id the AGENT chose (re-using an id moves that
 * pin), so remove/fly-to/tour need no round-trip — the model references ids
 * it assigned. State outlives any one map view on purpose: pins placed
 * while the map is hidden greet the user when 📍 goes on.
 *
 * Foundation-only math/parsing lives in nonisolated statics so TinyTests
 * can pin the clamps without MapKit or a MainActor hop.
 */
import Foundation
import Combine

@MainActor
final class AgentMap: ObservableObject {
    static let shared = AgentMap()

    struct Pin: Identifiable, Equatable {
        let id: String
        let lat: Double
        let lng: Double
        let label: String?
        /// raw CSS-ish hex from the tool call; color-mapped at render time
        let color: String?
    }

    /// One camera gesture; `seq` makes each command a distinct Equatable
    /// value so .onChange fires even for a repeated destination.
    struct Camera: Equatable {
        let seq: Int
        let lat: Double
        let lng: Double
        let zoom: Double?
    }

    @Published private(set) var pins: [String: Pin] = [:]
    @Published private(set) var camera: Camera?

    private var autoId = 0
    private var seq = 0
    private var tourTask: Task<Void, Never>?

    // Mounted map surfaces (ambient/full-screen) check in so the chat can
    // tell when a map gesture would be INVISIBLE and hint instead (web
    // parity: the "tap 📍 to see it" toast).
    @Published private(set) var visibleMaps = 0
    var mapVisible: Bool { visibleMaps > 0 }
    func mapDidAppear() { visibleMaps += 1 }
    func mapDidDisappear() { visibleMaps = max(0, visibleMaps - 1) }

    /// Returns true when the tool name was a map tool (handled here).
    @discardableResult
    func handle(name: String, argsJson: String) -> Bool {
        let input = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8))) as? [String: Any] ?? [:]
        switch name {
        case "add_map_marker":
            guard let (lat, lng) = Self.coords(input) else { return true }
            var id = (input["id"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            if id.isEmpty {
                autoId += 1
                id = "pin-\(autoId)"
            }
            id = String(id.prefix(32))
            let label = (input["label"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(40)) }
            let color = (input["color"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            pins[id] = Pin(id: id, lat: lat, lng: lng, label: label, color: color)
        case "remove_map_marker":
            if let p = Self.resolvePin(input["id"] as? String ?? "", in: pins) {
                pins.removeValue(forKey: p.id)
            }
        case "clear_map_markers":
            clearPins()
        case "fly_to_location":
            if let (lat, lng) = Self.coords(input) { fly(lat: lat, lng: lng, zoom: Self.zoom(input)) }
        case "fly_to_marker":
            if let p = Self.resolvePin(input["id"] as? String ?? "", in: pins) {
                fly(lat: p.lat, lng: p.lng, zoom: Self.zoom(input))
            }
        case "tour_markers":
            let stops = Self.tourStops(input, pins: pins)
            guard !stops.isEmpty else { return true }
            let pause = Self.tourPauseMs(input)
            tourTask?.cancel()
            tourTask = Task { [weak self] in
                for p in stops {
                    guard let self, !Task.isCancelled else { return }
                    self.fly(lat: p.lat, lng: p.lng, zoom: nil)
                    try? await Task.sleep(nanoseconds: UInt64(pause) * 1_000_000)
                }
            }
        default:
            return false
        }
        return true
    }

    /// When the agent last steered the camera — the ambient follow loop
    /// yields for 30s after a gesture instead of stomping it on its next
    /// 15s tick (fly_to_marker looked broken: the map snapped home).
    private(set) var lastGestureAt: Date?
    var followSuspended: Bool {
        guard let t = lastGestureAt else { return false }
        return Date().timeIntervalSince(t) < 30
    }

    /// Spotlight: while the agent is presenting (fly/tour), the ambient
    /// wash thins so the map comes FORWARD, then fades back. Duration is
    /// settable for tests.
    @Published private(set) var spotlight = false
    var spotlightSeconds: Double = 8
    private var spotlightTask: Task<Void, Never>?

    private func fly(lat: Double, lng: Double, zoom: Double?) {
        seq += 1
        lastGestureAt = Date()
        camera = Camera(seq: seq, lat: lat, lng: lng, zoom: zoom)
        spotlight = true
        spotlightTask?.cancel()
        spotlightTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.spotlightSeconds * 1_000_000_000))
            if !Task.isCancelled { self.spotlight = false }
        }
    }

    /// Drop every agent pin and stop a running tour — the agent's
    /// clear_map_markers and the map screen's "clear pins" button.
    func clearPins() {
        tourTask?.cancel()
        tourTask = nil
        pins = [:]
    }

    /// Tests only — the singleton outlives XCTest cases.
    func resetForTest() {
        tourTask?.cancel()
        tourTask = nil
        spotlightTask?.cancel()
        spotlightTask = nil
        spotlight = false
        spotlightSeconds = 8
        pins = [:]
        camera = nil
        autoId = 0
        seq = 0
        visibleMaps = 0
        lastGestureAt = nil
    }

    // MARK: - pure parsing/math (web schema clamp parity)

    nonisolated static func coords(_ input: [String: Any]) -> (Double, Double)? {
        guard let lat = (input["lat"] as? NSNumber)?.doubleValue,
              let lng = (input["lng"] as? NSNumber)?.doubleValue,
              lat.isFinite, lng.isFinite,
              (-90.0...90.0).contains(lat), (-180.0...180.0).contains(lng) else { return nil }
        return (lat, lng)
    }

    nonisolated static func zoom(_ input: [String: Any]) -> Double? {
        guard let z = (input["zoom"] as? NSNumber)?.doubleValue, z.isFinite else { return nil }
        return min(20, max(1, z))
    }

    nonisolated static func tourPauseMs(_ input: [String: Any]) -> Int {
        let ms = (input["pause_ms"] as? NSNumber)?.intValue ?? 2000
        return min(10_000, max(500, ms))
    }

    /// id → pin, with a LABEL fallback: the model often skips the optional
    /// id on add_map_marker (the auto "pin-N" is never echoed back — these
    /// tools are fire-and-forget), then references the pin by its label.
    /// "fly to the coffee pin" must fly. Exact id wins; else the first
    /// case-insensitive label match.
    nonisolated static func resolvePin(_ ref: String, in pins: [String: Pin]) -> Pin? {
        if let p = pins[ref] { return p }
        let needle = ref.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return nil }
        return pins.values.first { ($0.label ?? "").lowercased() == needle }
    }

    /// Known pins in tour order — unknown refs skipped, capped at 12.
    nonisolated static func tourStops(_ input: [String: Any], pins: [String: Pin]) -> [Pin] {
        let ids = (input["ids"] as? [Any])?.compactMap { $0 as? String } ?? []
        return Array(ids.compactMap { resolvePin($0, in: pins) }.prefix(12))
    }

    /// Web zoom level → MapKit span degrees (360° at zoom 0, halved per
    /// level — the Mercator convention agi-diy zooms mean). nil zoom keeps
    /// the streets-ish default the follow loops use.
    nonisolated static func spanDegrees(forZoom zoom: Double?) -> Double {
        guard let zoom else { return 0.02 }
        return 360.0 / pow(2.0, min(20, max(1, zoom)))
    }

    /// #rgb/#rrggbb → 0…1 components; nil for junk (render falls back to
    /// the tiny's accent). Pure math — usable off MainActor and in tests.
    nonisolated static func rgb(fromHex color: String?) -> (r: Double, g: Double, b: Double)? {
        guard var hex = color?.trimmingCharacters(in: .whitespaces), hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        let parts: [String]
        switch hex.count {
        case 3: parts = hex.map { "\($0)\($0)" }
        case 6: parts = stride(from: 0, to: 6, by: 2).map {
            let s = hex.index(hex.startIndex, offsetBy: $0)
            return String(hex[s..<hex.index(s, offsetBy: 2)])
        }
        default: return nil
        }
        let vals = parts.compactMap { Int($0, radix: 16) }
        guard vals.count == 3 else { return nil }
        return (Double(vals[0]) / 255, Double(vals[1]) / 255, Double(vals[2]) / 255)
    }
}

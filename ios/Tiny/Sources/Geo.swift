/**
 * 📍 Geo — device location → agent context (maps-location loop c8).
 *
 * iOS port of web lib/geo.ts / Android geo/Geo.kt: the pure half (kmh /
 * cardinal / contextBlock) renders the exact same `### Location` markdown
 * block, so every client teaches the tiny one shape (String(format:) with
 * no locale is C-locale — no tr-TR comma-splitting the coordinate pair).
 *
 * The CoreLocation half is snapshot-based like Motion/Bluetooth: one
 * requestLocation per ask — 30s-cached, 5s-bounded, never a standing
 * watch. Permission is asked by the Settings toggle (requestPermission),
 * never implicitly; unauthorized just means "no location line".
 */
import CoreLocation
import Foundation

final class Geo: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    static let shared = Geo()

    struct Fix {
        let lat: Double
        let lng: Double
        /// meters, nil when the platform won't say
        let accuracyM: Int?
        /// meters above sea level
        let altitudeM: Int?
        /// m/s — nil when stationary/unknown (CLLocation sends -1)
        let speedMs: Double?
        /// degrees clockwise from true north; nil when not moving
        let headingDeg: Double?
        let timestampMs: Double
    }

    // ── pure half (byte-parity with web tests/geo.test.ts + GeoTest.kt) ──

    private static let cardinals = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

    /// m/s → km/h at 1dp; nil for junk/negative.
    static func kmh(_ speedMs: Double?) -> Double? {
        guard let s = speedMs, s.isFinite, s >= 0 else { return nil }
        return (s * 3.6 * 10).rounded() / 10
    }

    /// 0-360° → compass point; wraps, nil for junk.
    static func cardinal(_ deg: Double?) -> String? {
        guard let d = deg, d.isFinite else { return nil }
        let norm = (d.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        return cardinals[Int((norm / 45).rounded()) % 8]
    }

    /// The agent-facing `### Location` block — same grammar on every client.
    static func contextBlock(_ fix: Fix?) -> String {
        guard let f = fix, f.lat.isFinite, f.lng.isFinite else { return "" }
        var lines = ["### Location"]
        lines.append("- **Coordinates**: \(String(format: "%.4f", f.lat)), \(String(format: "%.4f", f.lng))")
        if let a = f.accuracyM { lines.append("- **Accuracy**: ±\(a)m") }
        if let alt = f.altitudeM { lines.append("- **Altitude**: \(alt)m") }
        if let v = kmh(f.speedMs), v > 0 {
            lines.append("- **Speed**: \(String(format: "%.1f", v)) km/h")
        }
        if let c = cardinal(f.headingDeg), let deg = f.headingDeg {
            lines.append("- **Heading**: \(c) (\(Int(deg.rounded()))°)")
        }
        return lines.joined(separator: "\n")
    }

    /// CLLocation → Fix (CoreLocation's "invalid" sentinels → nil fields).
    static func fix(from loc: CLLocation) -> Fix {
        Fix(
            lat: loc.coordinate.latitude,
            lng: loc.coordinate.longitude,
            accuracyM: loc.horizontalAccuracy >= 0 ? Int(loc.horizontalAccuracy.rounded()) : nil,
            altitudeM: loc.verticalAccuracy > 0 ? Int(loc.altitude.rounded()) : nil,
            speedMs: loc.speed >= 0 ? loc.speed : nil,
            headingDeg: loc.course >= 0 ? loc.course : nil,
            timestampMs: loc.timestamp.timeIntervalSince1970 * 1000
        )
    }

    // ── CoreLocation half ──

    private let manager = CLLocationManager()
    private let lock = NSLock()
    private var pending: [UUID: CheckedContinuation<Fix?, Never>] = [:]
    private var cached: Fix?

    private static let cacheMs: Double = 30_000
    private static let fixTimeoutS: Double = 5

    override private init() {
        super.init()
        manager.delegate = self
        // Hundred-meter class: the context block is 4-decimal (~11m) anyway,
        // and coarse fixes answer in well under the 5s bound.
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var authorized: Bool {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: return true
        default: return false
        }
    }

    /// The user said no (or a profile did) — as opposed to .notDetermined,
    /// where the ask dialog is still the next step. UIs use this to swap
    /// "waiting for position…" for the truth.
    var denied: Bool {
        switch manager.authorizationStatus {
        case .denied, .restricted: return true
        default: return false
        }
    }

    /// Settings-toggle hook — the ONLY place the system prompt fires.
    func requestPermission() {
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    /// Sync (lockable — Swift 6 bars NSLock in async bodies): fresh cache or nil.
    private func freshCached() -> Fix? {
        lock.lock()
        defer { lock.unlock() }
        if let c = cached, Date().timeIntervalSince1970 * 1000 - c.timestampMs < Self.cacheMs {
            return c
        }
        return nil
    }

    /// One bounded fix: 30s cache → requestLocation (≤5s) → nil.
    func current() async -> Fix? {
        guard authorized else { return nil }
        if let c = freshCached() { return c }

        let id = UUID()
        return await withCheckedContinuation { (cont: CheckedContinuation<Fix?, Never>) in
            lock.lock()
            pending[id] = cont
            let first = pending.count == 1
            lock.unlock()
            if first {
                DispatchQueue.main.async { self.manager.requestLocation() }
            }
            // Timeout: whoever still owns the id resumes it — the id-keyed
            // map is the double-resume guard (delegate may have raced us).
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.fixTimeoutS) {
                self.lock.lock()
                let c = self.pending.removeValue(forKey: id)
                self.lock.unlock()
                c?.resume(returning: nil)
            }
        }
    }

    /// The per-send hook (ChatController extraSystem): the location block
    /// when the Settings toggle is on AND permission granted, else nil and
    /// the request is byte-identical to before.
    func contextIfEnabled() async -> String? {
        guard Config.locationContext, authorized else { return nil }
        guard let f = await current() else { return nil }
        let block = Self.contextBlock(f)
        return block.isEmpty ? nil : block
    }

    private func flush(_ fix: Fix?) {
        lock.lock()
        if let f = fix { cached = f }
        let conts = pending
        pending = [:]
        lock.unlock()
        conts.values.forEach { $0.resume(returning: fix) }
    }

    // MARK: CLLocationManagerDelegate (nonisolated — flush() is lock-guarded)

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        flush(locations.last.map(Self.fix(from:)))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        flush(nil)
    }
}

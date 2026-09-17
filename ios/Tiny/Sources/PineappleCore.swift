import Foundation

/// The Pager's versioned wire contract. No networking or device side effects.
enum PineappleCore {
    static let maxBytes = 262_144
    static let chunkBytes = 3_072

    static func matches(platform: String, capabilities: [String]) -> Bool {
        // Old enrolled MVPs cannot advertise the new marker until they reconnect.
        platform == "openwrt-mips" && (capabilities.contains("pineapple_v1") ||
            Set(["payload_inventory", "network", "battery"]).isSubset(of: Set(capabilities)))
    }
    static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && value.range(of: #"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"#, options: .regularExpression) != nil
    }
    static func authorizedBSSID(_ value: String) -> Bool {
        guard value.utf8.count == 17, value.range(of: #"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$"#, options: .regularExpression) != nil,
              let first = UInt8(value.prefix(2), radix: 16), first & 1 == 0 else { return false }
        return value != "00:00:00:00:00:00"
    }
    static func reason(_ code: String?) -> String? {
        switch code {
        case "no_default_route": return "Pager reported no default internet route. USB SSH alone does not provide internet."
        case "dns_failed": return "Pager could not resolve tiny.technology."
        case "clock_invalid": return "Pager's clock needs correction before a capture can start."
        case "transport_unverified": return "Pager is retrying its connection; the cause is not verified."
        default: return nil
        }
    }
    struct Interface: Identifiable, Equatable {
        let name: String
        let state: String
        var id: String { name }
    }
    struct CaptureInterface: Identifiable, Equatable {
        let name: String
        let channel: Int?
        var frequency: Int? = nil
        let linkType: String
        var id: String { name }
    }
    struct RadioPlan: Equatable {
        let frequency: Int
        static func decode(_ r: [String: Any]) -> Self? {
            guard r["interface"] as? String == "wlan1mon", r["phy"] as? String == "phy1",
                  r["width_mhz"] as? Int == 20, r["tuning_required"] as? Bool == true,
                  r["vendor_pause_required"] as? Bool == true, r["disrupts_uplink"] as? Bool == false,
                  let frequency = r["frequency_mhz"] as? Int, channel(for: frequency) != nil else { return nil }
            return Self(frequency: frequency)
        }
    }
    static func channel(for f: Int) -> Int? {
        if f == 2484 { return 14 }
        if (2412...2472).contains(f), (f - 2407) % 5 == 0 { return (f - 2407) / 5 }
        if (5005...5895).contains(f), (f - 5000) % 5 == 0 { return (f - 5000) / 5 }
        if f == 5935 { return 2 }
        if (5955...7115).contains(f), (f - 5950) % 5 == 0 { return (f - 5950) / 5 }
        return nil
    }
    struct AccessPoint: Identifiable, Equatable {
        let bssid: String
        let ssid: String
        let hidden: Bool
        let channel: Int?
        let frequency: Int?
        let band: String
        let signal: Int?
        let security: String
        let age: Double?
        let stale: Bool
        let captureInterface: String?
        let unavailableReason: String?
        var radioPlan: RadioPlan? = nil
        var id: String { bssid }
        var name: String { hidden ? "Hidden network" : ssid }
        static func decode(_ r: [String: Any]) -> Self? {
            guard let bssid = r["bssid"] as? String, authorizedBSSID(bssid),
                  let ssid = r["ssid"] as? String, ssid.utf8.count <= 512 else { return nil }
            // SSIDs are untrusted labels: literal text, no Markdown, controls or bidi overrides.
            let safe = String(String.UnicodeScalarView(ssid.unicodeScalars.map {
                CharacterSet.controlCharacters.contains($0) || (0x202A...0x202E).contains($0.value) ||
                (0x2066...0x2069).contains($0.value) ? UnicodeScalar(0xFFFD)! : $0
            }))
            return Self(bssid: bssid, ssid: safe, hidden: r["hidden"] as? Bool == true || safe.isEmpty,
                        channel: r["channel"] as? Int, frequency: r["frequency_mhz"] as? Int,
                        band: String((r["band"] as? String ?? "Unknown").prefix(20)), signal: r["signal_dbm"] as? Int,
                        security: String((r["security"] as? String ?? "Unknown").prefix(40)),
                        age: r["age_seconds"] as? Double, stale: r["stale"] as? Bool != false,
                        captureInterface: r["capture_interface"] as? String,
                        unavailableReason: (r["unavailable_reason"] as? String).map { String($0.prefix(200)) },
                        radioPlan: (r["radio_plan"] as? [String: Any]).flatMap(RadioPlan.decode))
        }
    }
    struct NetworkScan {
        let networks: [AccessPoint]
        let fetchedAt: Date
        let truncated: Bool
        static func decode(_ r: [String: Any]) throws -> Self {
            guard r["version"] as? Int == 1, r["source"] as? String == "kernel_bss_cache",
                  let epoch = r["fetched_at"] as? Double, epoch.isFinite,
                  let rows = r["networks"] as? [[String: Any]], rows.count <= 24 else {
                throw PineappleError.message("Network discovery is unsupported by this firmware. Manual entry remains available.")
            }
            var ids = Set<String>()
            let points = rows.compactMap(AccessPoint.decode).filter { ids.insert($0.id).inserted }
            return Self(networks: points, fetchedAt: Date(timeIntervalSince1970: epoch), truncated: r["truncated"] as? Bool == true)
        }
        func isFresh(_ ap: AccessPoint, now: Date = Date()) -> Bool {
            guard !ap.stale, let age = ap.age, age >= 0, age.isFinite else { return false }
            let elapsed = now.timeIntervalSince(fetchedAt)
            return elapsed >= -5 && age + max(0, elapsed) <= 30
        }
        func reason(for bssid: String?, interface: CaptureInterface?, now: Date = Date()) -> String? {
            guard let bssid else { return "Select a network. Selection does not join Wi-Fi or start capture." }
            guard let ap = networks.first(where: { $0.bssid == bssid }) else { return "Selected network is no longer in the results. Refresh or choose another AP." }
            guard isFresh(ap, now: now) else { return "Selected observation is stale. Refresh before capture." }
            if let reason = ap.unavailableReason { return reason }
            guard let interface, interface.name == "wlan1mon", ap.captureInterface == interface.name,
                  let plan = ap.radioPlan, plan.frequency == ap.frequency,
                  ap.channel == channel(for: plan.frequency) else {
                return "No verified safe radio plan for this exact frequency. Refresh or update Pager."
            }
            return nil
        }
    }

    struct Capture: Identifiable, Equatable {
        let id: String
        let state: String
        let size: Int
        let sha256: String?
        let linkType: String
        var reason: String? = nil
        var active: Bool { ["starting", "tuning", "running", "stopping", "restoring", "restore_failed"].contains(state) }
        var phaseLabel: String {
            switch state {
            case "starting": "Preparing capture"
            case "tuning": "Tuning independent radio"
            case "running": "Capturing"
            case "stopping": "Stopping capture"
            case "restoring": "Restoring radio"
            case "restore_failed": "Radio restoration needs attention"
            default: state.capitalized
            }
        }
        var downloadable: Bool { state == "complete" && size >= 24 && size <= maxBytes && sha256 != nil }
        static func decode(_ raw: [String: Any]) -> Self? {
            guard let id = raw["job_id"] as? String, uuid(id),
                  let state = raw["state"] as? String else { return nil }
            let size = raw["size"] as? Int ?? 0
            let hash = raw["sha256"] as? String
            let validHash = hash?.utf8.count == 64 && hash?.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
            return Self(id: id, state: state, size: size, sha256: validHash ? hash : nil,
                        linkType: raw["link_type"] as? String ?? "Unknown link type",
                        reason: (raw["reason"] as? String).map { String($0.prefix(300)) })
        }
    }
    struct Overview {
        var battery: Int?
        var charging: String?
        var uptime: String?
        var reason: String?
        var transport: String?
        var interfaces: [Interface] = []
        var captureAvailable = false
        var tuningSupported = false
        var radioPhase: String?
        var radioError: String?
        var captureInterfaces: [CaptureInterface] = []
        var active: Capture?
        var storage: String?

        static func decode(_ raw: [String: Any]) -> Self {
            var out = Self()
            let battery = raw["battery"] as? [String: Any] ?? [:]
            if let percent = Int(battery["capacity_percent"] as? String ?? ""), (0...100).contains(percent) { out.battery = percent }
            out.charging = battery["status"] as? String
            out.uptime = (raw["status"] as? [String: Any])?["uptime"] as? String
            let network = raw["network"] as? [String: Any] ?? [:]
            out.interfaces = (network["interfaces"] as? [[String: Any]] ?? []).prefix(32).compactMap {
                guard let name = $0["name"] as? String, !name.isEmpty, name.count <= 32 else { return nil }
                return Interface(name: name, state: $0["state"] as? String ?? "unknown")
            }
            let connectivity = raw["connectivity"] as? [String: Any] ?? [:]
            out.reason = connectivity["reason"] as? String
            out.transport = connectivity["transport"] as? String
            out.storage = (raw["storage"] as? [String: Any])?["usage"] as? String
            let capture = raw["capture"] as? [String: Any] ?? [:]
            out.captureAvailable = capture["available"] as? Bool == true
            out.tuningSupported = capture["radio_tuning_supported"] as? Bool == true
            let radio = capture["radio"] as? [String: Any] ?? [:]
            out.radioPhase = radio["phase"] as? String
            out.radioError = (radio["error"] as? String).map { String($0.prefix(300)) }
            out.captureInterfaces = (capture["interfaces"] as? [[String: Any]] ?? []).prefix(2).compactMap {
                guard let name = $0["name"] as? String, ["lo", "wlan1mon"].contains(name) else { return nil }
                return CaptureInterface(name: name, channel: $0["channel"] as? Int, frequency: $0["frequency_mhz"] as? Int, linkType: $0["link_type"] as? String ?? "unknown")
            }
            out.active = (capture["active"] as? [String: Any]).flatMap(Capture.decode)
            return out
        }
    }
    static func wirelessRequest(scan: NetworkScan, bssid: String, interface: CaptureInterface?,
                                id: String, duration: Int, maxBytes: Int, authorized: Bool,
                                tuningConfirmed: Bool, now: Date = Date()) throws -> [String: Any] {
        guard authorized, tuningConfirmed, uuid(id), [10,30,60].contains(duration),
              [65_536,131_072,262_144].contains(maxBytes),
              scan.reason(for: bssid, interface: interface, now: now) == nil,
              let ap = scan.networks.first(where: { $0.bssid == bssid }), let plan = ap.radioPlan else {
            throw PineappleError.message("Refresh the exact target and confirm its radio plan before capture.")
        }
        return ["action": "capture_start", "job_id": id, "interface": "wlan1mon", "bssid": bssid,
                "channel": ap.channel!, "frequency_mhz": plan.frequency, "filter": "data_headers",
                "duration_seconds": duration, "max_bytes": maxBytes, "authorized": true,
                "tuning_confirmed": true, "expires_at": Int(now.timeIntervalSince1970) + 90]
    }
    /// Refuse oversized/malformed data before it reaches a file. PCAP, not pcapng.
    static func chunk(_ raw: [String: Any], job: String, offset: Int, size: Int) throws -> Data {
        guard raw["job_id"] as? String == job, raw["offset"] as? Int == offset,
              let encoded = raw["data_base64"] as? String, encoded.utf8.count <= 4096,
              let data = Data(base64Encoded: encoded), !data.isEmpty,
              data.count <= chunkBytes, offset >= 0, size >= 24, size <= maxBytes, offset <= size,
              data.count <= size - offset else { throw PineappleError.message("Invalid capture chunk. No file was saved.") }
        if offset == 0 {
            let magic = Array(data.prefix(4))
            guard [[0xd4,0xc3,0xb2,0xa1], [0xa1,0xb2,0xc3,0xd4], [0x4d,0x3c,0xb2,0xa1], [0xa1,0xb2,0x3c,0x4d]].contains(magic) else {
                throw PineappleError.message("The device did not return a PCAP file.")
            }
        }
        return data
    }
}

enum PineappleError: LocalizedError {
    case message(String)
    case refused(String)
    var errorDescription: String? { switch self { case .message(let s), .refused(let s): return s } }
}

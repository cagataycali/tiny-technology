import SwiftUI
#if DEBUG
import CryptoKit
#endif

/// A Pager is a device, not a list of tool names. Capture stays opt-in and scoped.
struct PineappleScreen: View {
    let device: DeviceRow
    let token: String?
    @State private var presence: DevicePresence = .unknown
    @State private var overview: PineappleCore.Overview?
    @State private var stamp: Date?
    @State private var error: String?
    @State private var busy = false
    @State private var stopping = false
    @State private var selected = "wlan1mon"
    @State private var bssid = ""
    @State private var networkScan: PineappleCore.NetworkScan?
    @State private var scanning = false
    @State private var scanError: String?
    @State private var chosen: PineappleCore.AccessPoint?
    @State private var manual = false
    @State private var maxBytes = PineappleCore.maxBytes
    @State private var previewRefreshCount = 0
    @State private var duration = 10
    @State private var authorized = false
    @State private var confirmStart = false
    @State private var files: [PineappleCore.Capture] = []
    @State private var export: PineappleCore.Capture?
    @State private var deletion: PineappleCore.Capture?
    @State private var downloadTask: Task<Void, Never>?
    @State private var downloadProgress: Double?
    @State private var downloaded: URL?
    @State private var pendingJob: String?

    private var demo: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--pineapple-harness")
        #else
        false
        #endif
    }
    private var online: Bool { presence == .online }
    private var canCapture: Bool { online && overview?.captureAvailable == true }
    private var selectedInterface: PineappleCore.CaptureInterface? {
        overview?.captureInterfaces.first { $0.name == selected }
    }
    private var targetReason: String? {
        guard selected != "lo" else { return nil }
        guard overview?.tuningSupported == true else { return "Radio recovery is unavailable or Pager needs an update. Refresh status." }
        guard let networkScan else { return "Find networks first. Manual BSSID must also match a fresh observed AP." }
        return networkScan.reason(for: bssid.isEmpty ? nil : bssid.lowercased(), interface: selectedInterface)
    }
    private var target: PineappleCore.AccessPoint? {
        networkScan?.networks.first { $0.bssid == bssid.lowercased() }
    }
    private var startReady: Bool {
        canCapture && !busy && !scanning && targetReason == nil && pendingJob == nil && overview?.active == nil && authorized &&
        selectedInterface != nil && (selected == "lo" ||
            (PineappleCore.authorizedBSSID(bssid.lowercased()) && target?.radioPlan != nil)) &&
        stamp.map { Date().timeIntervalSince($0) < 30 } == true
    }

    var body: some View {
        List {
            connectionSection
            if let overview {
                Section("Pager") {
                    LabeledContent("Battery", value: overview.battery.map { "\($0)%" } ?? "Unavailable")
                    if let charge = overview.charging { LabeledContent("Power", value: charge) }
                    if let stamp { Text("Read \(stamp.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary) }
                }
                Section("Interfaces") {
                    ForEach(overview.interfaces) { iface in
                        LabeledContent(iface.name, value: iface.state)
                    }
                    Text("Management and client Wi-Fi stay connected. Capture temporarily tunes only the independent radio; no Hak5 payloads.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let storage = overview.storage {
                    Section("Storage") { Text(storage).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
            discoverySection
            captureSection
            filesSection
            Section("Capabilities") {
                Label("Battery, status, interfaces and storage", systemImage: "checkmark.circle")
                Label("Scoped packet capture — explicit start only", systemImage: canCapture ? "checkmark.circle" : "clock")
                Text("No deauthentication, rogue APs, credential collection, arbitrary shell or payload execution. PCAPs can contain private traffic; share only with people you trust.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Pineapple")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("pineapple-screen")
        .toolbar { ToolbarItem(placement: .topBarTrailing) {
            Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel("Refresh Pager").disabled(busy).accessibilityIdentifier("pineapple-refresh")
        } }
        .refreshable { await refresh() }
        .task { presence = device.presence; await refresh() }
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(overview?.active != nil || pendingJob != nil ? 3 : 20)) } catch { return }
                if downloadTask == nil && !confirmStart { await refresh() }
            }
        }
        .onDisappear { downloadTask?.cancel() }
        .onChange(of: bssid) { _, _ in authorized = false; confirmStart = false }
        .onChange(of: selected) { _, _ in authorized = false; confirmStart = false }
        .onChange(of: manual) { _, _ in authorized = false; confirmStart = false }
        .onChange(of: duration) { _, _ in authorized = false; confirmStart = false }
        .onChange(of: maxBytes) { _, _ in authorized = false; confirmStart = false }
        .confirmationDialog("Start this capture?", isPresented: $confirmStart, titleVisibility: .visible) {
            Button("Start authorized capture") { Task { await start() } }
        } message: {
            Text(selected == "lo" ? "Record only generated loopback test UDP for \(duration) seconds. No Wi-Fi traffic."
                 : "Record data packets for BSSID \(bssid) on \(selected), channel \(target?.channel ?? 0) at \(target?.frequency ?? 0) MHz, for \(duration) seconds. Maximum \(maxBytes / 1024) KiB; truncated to 128 bytes per packet. Temporarily pause Hak5 on the independent radio, tune at 20 MHz, then restore. Home Wi-Fi stays connected. Wider-channel traffic may be missed. Only networks you own or have permission to inspect.")
        }
        .confirmationDialog("Download privately?", isPresented: Binding(get: { export != nil }, set: { if !$0 { export = nil } }),
                            titleVisibility: .visible, presenting: export) { capture in
            Button("Transfer to this device") { beginDownload(capture) }
        } message: { _ in
            Text("This explicitly uploads encrypted-in-transit chunks through tiny's owner-only relay. Replies remain available for about 24 hours before cleanup. The verified .pcap is saved temporarily on this device; use Share to save to Files. Nothing is published.")
        }
        .confirmationDialog("Delete capture from Pager?", isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }),
                            titleVisibility: .visible, presenting: deletion) { capture in
            Button("Delete capture", role: .destructive) { Task { await remove(capture) } }
        } message: { _ in Text("This permanently removes the selected capture from Pager. Copies already downloaded are not removed.") }
    }

    private var connectionSection: some View {
        Section {
            HStack {
                Label(online ? "Connected" : "Offline", systemImage: online ? "wifi" : "wifi.slash")
                    .foregroundStyle(online ? Color.green : Color.secondary)
                    .accessibilityIdentifier("pineapple-connection")
                Spacer()
                if busy { ProgressView() }
            }
            Text(device.name).font(.caption).foregroundStyle(.secondary)
            if !online {
                Text("Pager is not reporting online. Its current offline reason is unknown from this phone. Check Pager's internet connection; USB alone may only provide SSH.")
                    .font(.caption).accessibilityIdentifier("pineapple-offline-reason")
            }
            if let reason = PineappleCore.reason(overview?.reason) {
                Text("Last device report: " + reason).font(.caption).foregroundStyle(.secondary)
            }
            if let transport = overview?.transport { Text("Last transport: \(transport)").font(.caption) }
            if let error { Text(error).foregroundStyle(.orange).font(.caption).accessibilityIdentifier("pineapple-error") }
            if demo { Text("Preview data — no device commands").font(.caption).foregroundStyle(.orange) }
        } header: { Text("Connection") }
    }

    private var discoverySection: some View {
        Section {
            Button(networkScan == nil ? "Find networks" : "Refresh networks") { Task { await findNetworks() } }
                .disabled(!online || scanning || busy || confirmStart)
                .accessibilityIdentifier("pineapple-find-networks")
            if scanning { ProgressView("Finding networks…").accessibilityIdentifier("pineapple-scanning") }
            if !online { Text("Network discovery is offline.").font(.caption) }
            if let scanError { Text(scanError).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("pineapple-scan-error") }
            if let scan = networkScan {
                Text("Read kernel observations \(scan.fetchedAt.formatted(.relative(presentation: .named))). Not a full-band scan; no channel changes.")
                    .font(.caption).foregroundStyle(.secondary)
                if scan.networks.isEmpty { Text("No networks in the current cache. Refresh later or use manual entry.").accessibilityIdentifier("pineapple-networks-empty") }
                ForEach(scan.networks) { ap in
                    Button { choose(ap) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(verbatim: ap.name).font(.body)
                                Spacer()
                                if chosen?.bssid == ap.bssid && !manual { Image(systemName: "checkmark.circle.fill") }
                            }
                            Text(verbatim: "\(ap.signal.map { "\($0) dBm" } ?? "Signal unknown") · ch \(ap.channel.map(String.init) ?? "?") · \(ap.band) · \(ap.security)")
                                .font(.caption).foregroundStyle(.secondary)
                            Text(verbatim: ap.bssid).font(.caption.monospaced()).foregroundStyle(.secondary)
                            if !scan.isFresh(ap) { Text("Stale observation — refresh").font(.caption).foregroundStyle(.orange) }
                            else if let reason = ap.unavailableReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
                        }
                    }.buttonStyle(.borderless)
                    .disabled(!online || scanning || confirmStart)
                    .accessibilityIdentifier("pineapple-ap-\(ap.bssid)")
                }
                if scan.truncated { Text("Results limited to fit the private relay. Not all APs are shown.").font(.caption) }
            }
            Toggle("Advanced: manual BSSID", isOn: $manual).accessibilityIdentifier("pineapple-manual")
            Text("Selecting an AP does not join Wi-Fi or start sniffing. Only capture networks you own or have permission to inspect.")
                .font(.caption).foregroundStyle(.secondary)
        } header: { Text("Nearby networks") }
    }

    @MainActor private func choose(_ ap: PineappleCore.AccessPoint) {
        chosen = ap; bssid = ap.bssid; manual = false
        selected = ap.captureInterface ?? "wlan1mon"
        authorized = false; confirmStart = false
    }

    @MainActor private func findNetworks() async {
        guard online, !scanning, !busy else { return }
        scanning = true; scanError = nil; authorized = false
        defer { scanning = false }
        do {
            let raw: [String: Any]
            #if DEBUG
            if demo {
                previewRefreshCount += 1
                raw = PineapplePreview.scan(refresh: previewRefreshCount)
            } else {
                raw = try await PineappleClient.invoke(device: device.id, token: token, prompt: "network_scan")
            }
            #else
            raw = try await PineappleClient.invoke(device: device.id, token: token, prompt: "network_scan")
            #endif
            let scan = try PineappleCore.NetworkScan.decode(raw)
            networkScan = scan
            // Identity is BSSID. Preserve a missing selection visibly, but never substitute another AP.
            if let chosen, let updated = scan.networks.first(where: { $0.bssid == chosen.bssid }) {
                choose(updated)
            }
        } catch {
            scanError = error.localizedDescription
            // A failed refresh never leaves a previous result eligible to start.
            networkScan = nil
        }
    }

    private var captureSection: some View {
        Section {
            if let active = overview?.active {
                LabeledContent("Capture", value: active.phaseLabel).accessibilityIdentifier("pineapple-capture-phase")
                if let reason = active.reason { Text(reason).font(.caption).foregroundStyle(.orange) }
                Text(String(active.id.prefix(8))).font(.caption.monospaced())
                Button("Stop capture", role: .destructive) { Task { await stop(active.id) } }
                    .disabled(stopping || !online).accessibilityIdentifier("pineapple-stop")
            } else if let pendingJob {
                Text("Start outcome not yet known. Refresh status before starting another capture.").font(.caption)
                Button("Stop pending capture", role: .destructive) { Task { await stop(pendingJob) } }
                    .disabled(stopping || !online)
            }
            if let radioError = overview?.radioError {
                Text(radioError).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("pineapple-radio-error")
            }
            if !canCapture {
                Text(online ? "Capture service is not available on this firmware yet. Live status above still works."
                     : "Connect Pager to inspect capture support. No start will be queued while offline.")
                    .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("pineapple-capture-unavailable")
            } else {
                Picker("Interface", selection: $selected) {
                    ForEach(overview?.captureInterfaces ?? []) { iface in
                        Text("\(iface.name) · \(iface.linkType)").tag(iface.name)
                    }
                }
                if selected != "lo" {
                    if manual {
                        TextField("Authorized BSSID (aa:bb:cc:dd:ee:ff)", text: $bssid)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().font(.callout.monospaced())
                            .accessibilityIdentifier("pineapple-bssid")
                    } else if let chosen {
                        Text(verbatim: "Target: \(chosen.name) · \(chosen.bssid) · channel \(chosen.channel ?? 0) · \(chosen.frequency ?? 0) MHz")
                            .font(.caption).accessibilityIdentifier("pineapple-target")
                    }
                    if let reason = targetReason {
                        Text(reason).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("pineapple-target-reason")
                    }
                    Text("Target channel \(target?.channel.map(String.init) ?? "unavailable") · data frames · 128-byte snapshots")
                        .font(.caption).foregroundStyle(.secondary)
                    if target?.radioPlan != nil {
                        Text(verbatim: "Independent radio → \(target?.frequency ?? 0) MHz · 20 MHz. Temporarily pause Hak5, then restore. Home Wi-Fi stays connected; wider-channel packets may be missed.")
                            .font(.caption).accessibilityIdentifier("pineapple-radio-plan")
                    }
                } else { Text("Synthetic loopback UDP only — not a Wi-Fi capture.").font(.caption) }
                Picker("Duration", selection: $duration) {
                    Text("10 seconds").tag(10); Text("30 seconds").tag(30); Text("60 seconds").tag(60)
                }
                Picker("Size limit", selection: $maxBytes) {
                    Text("64 KiB").tag(65_536); Text("128 KiB").tag(131_072); Text("256 KiB").tag(PineappleCore.maxBytes)
                }
                Toggle("I own this network or have permission", isOn: $authorized)
                    .accessibilityIdentifier("pineapple-authorized")
            }
            Button("Start capture") { confirmStart = true }
                .disabled(!startReady).accessibilityIdentifier("pineapple-start")
        } header: { Text("Packet capture") }
    }

    private var filesSection: some View {
        Section {
            if files.isEmpty {
                Text(canCapture ? "No retained captures." : "Capture files are not available yet.")
                    .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("pineapple-files-empty")
            }
            ForEach(files) { file in
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(file.id.prefix(8)).pcap").font(.callout.monospaced())
                    Text("\(file.phaseLabel) · \(file.size) bytes · \(file.linkType)").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("Download") { export = file }
                            .disabled(!online || !file.downloadable || downloadTask != nil || busy)
                        Spacer()
                        Button("Delete", role: .destructive) { deletion = file }
                            .disabled(!online || downloadTask != nil || busy || file.active)
                    }.buttonStyle(.borderless)
                }
            }
            if let progress = downloadProgress {
                ProgressView("Downloading privately…", value: progress)
                Button("Cancel download", role: .cancel) { downloadTask?.cancel() }
            }
            if let downloaded {
                ShareLink(item: downloaded) { Label("Share PCAP / Save to Files", systemImage: "square.and.arrow.up") }
                    .accessibilityIdentifier("pineapple-share")
                Text("Size, PCAP header and SHA-256 verified.").font(.caption).foregroundStyle(.secondary)
            }
        } header: { Text("Capture files") } footer: {
            Text("Stored on Pager by default. Up to four files, 256 KiB each. No automatic deletion.")
        }
    }

    @MainActor private func refresh() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        if demo {
            #if DEBUG
            presence = ProcessInfo.processInfo.arguments.contains("--pineapple-offline") ? .offline : .online
            overview = PineappleCore.Overview.decode(PineapplePreview.overview)
            if ProcessInfo.processInfo.arguments.contains("--pineapple-files") { files = [PineapplePreview.capture] }
            stamp = Date()
            #endif
            return
        }
        do {
            let registry: [String: Any] = try await Api.get("/api/devices", token: token, cachePolicy: .reloadIgnoringLocalCacheData)
            guard let row = DevicesView.decodeDevices(registry["devices"] as? [[String: Any]] ?? []).first(where: { $0.id == device.id }) else {
                presence = .offline; throw PineappleError.message("This device is no longer enrolled on your account.")
            }
            presence = row.presence
            guard online else { return }
            let raw = try await PineappleClient.invoke(device: device.id, token: token, prompt: "overview")
            overview = PineappleCore.Overview.decode(raw)
            stamp = Date()
            if overview?.captureAvailable == true {
                let listing = try await PineappleClient.command(device: device.id, token: token, request: ["action": "capture_list"])
                files = (listing["files"] as? [[String: Any]] ?? []).prefix(4).compactMap(PineappleCore.Capture.decode)
                if let pendingJob, files.contains(where: { $0.id == pendingJob }) || overview?.active?.id == pendingJob { self.pendingJob = nil }
            }
        } catch { self.error = error.localizedDescription }
    }
    @MainActor private func start() async {
        guard startReady, !demo else { return }
        let id = UUID().uuidString.lowercased()
        pendingJob = id; busy = true; error = nil
        var sent = false
        var request: [String: Any] = ["action": "capture_start", "job_id": id, "interface": selected,
            "duration_seconds": duration, "max_bytes": maxBytes, "authorized": true,
            "expires_at": Int(Date().timeIntervalSince1970) + 90,
            "filter": selected == "lo" ? "synthetic_udp" : "data_headers"]
        do {
            if selected != "lo" {
                guard let networkScan else { throw PineappleError.message("Refresh network observations first.") }
                request = try PineappleCore.wirelessRequest(scan: networkScan, bssid: bssid.lowercased(),
                    interface: selectedInterface, id: id, duration: duration, maxBytes: maxBytes,
                    authorized: authorized, tuningConfirmed: true)
            }
            sent = true
            _ = try await PineappleClient.command(device: device.id, token: token, request: request)
            pendingJob = nil; authorized = false
        } catch PineappleError.refused(let reason) {
            pendingJob = nil; authorized = false; self.error = reason
        } catch {
            if !sent { pendingJob = nil }
            self.error = error.localizedDescription
        }
        busy = false
        // Keep a refusal/uncertain-outcome sentence; polling will reconcile later.
        if error == nil { await refresh() }
    }
    @MainActor private func stop(_ id: String) async {
        guard !demo, online, !stopping else { return }
        stopping = true
        defer { stopping = false }
        do {
            _ = try await PineappleClient.command(device: device.id, token: token, request: ["action": "capture_stop", "job_id": id])
            if pendingJob == id { pendingJob = nil }
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    @MainActor private func remove(_ capture: PineappleCore.Capture) async {
        guard !demo, !busy, online else { return }
        busy = true
        do {
            _ = try await PineappleClient.command(device: device.id, token: token, request: ["action": "capture_delete", "job_id": capture.id, "delete_confirmed": true])
            files.removeAll { $0.id == capture.id }
        } catch { self.error = error.localizedDescription }
        busy = false
    }
    @MainActor private func beginDownload(_ capture: PineappleCore.Capture) {
        guard downloadTask == nil else { return }
        downloaded = nil; error = nil; downloadProgress = 0
        downloadTask = Task {
            defer { downloadTask = nil; downloadProgress = nil }
            do {
                #if DEBUG
                if demo {
                    downloaded = try await PineappleClient.download(capture, read: PineapplePreview.chunk) { downloadProgress = $0 }
                    return
                }
                #endif
                downloaded = try await PineappleClient.download(capture, device: device.id, token: token) { downloadProgress = $0 }
            } catch is CancellationError { error = "Download cancelled. The incomplete local file was removed." }
            catch { self.error = error.localizedDescription }
        }
    }
}

#if DEBUG
@MainActor enum PineapplePreview {
    static let bytes = Data([0xd4,0xc3,0xb2,0xa1,2,0,4,0,0,0,0,0,0,0,0,0,128,0,0,0,1,0,0,0])
    static let capture = PineappleCore.Capture(id: "01234567-89ab-4cde-8fab-0123456789ab", state: "complete", size: bytes.count,
        sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), linkType: "Ethernet (synthetic loopback)")
    static func chunk(_ request: [String: Any]) async throws -> [String: Any] {
        guard request["job_id"] as? String == capture.id,
              let offset = request["offset"] as? Int, let length = request["length"] as? Int,
              offset >= 0, length > 0, offset <= bytes.count, length <= bytes.count - offset else {
            throw PineappleError.message("Invalid preview request")
        }
        return ["ok": true, "job_id": capture.id, "offset": offset,
                "data_base64": bytes.subdata(in: offset..<(offset + length)).base64EncodedString()]
    }
    static let overview: [String: Any] = [
        "battery": ["capacity_percent": "55", "status": "Charging"],
        "network": ["interfaces": [["name": "wlan1mon", "state": "up"], ["name": "wlan0mgmt", "state": "up"]]],
        "capture": ["available": true, "radio_tuning_supported": true, "radio": ["phase": "restored"], "interfaces": [["name": "wlan1mon", "channel": 153, "frequency_mhz": 5765, "link_type": "Radiotap"]]]
    ]
    static func scan(refresh: Int) -> [String: Any] {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--pineapple-scan-unsupported") { return [:] }
        var points: [[String: Any]] = []
        for i in 1...4 {
            let name: String = i == 4 ? "" : (i == 3 ? "$(reboot) <script> **literal**" : "Test network")
            let row: [String: Any] = ["bssid": String(format: "02:00:00:00:00:%02d", i),
             "ssid": name,
             "hidden": i == 4, "channel": 153, "frequency_mhz": 5765, "band": "5 GHz",
             "signal_dbm": -40 - i, "security": "WPA2/3", "age_seconds": 0.1,
             "stale": args.contains("--pineapple-scan-stale"), "capture_interface": "wlan1mon",
             "radio_plan": ["phy": "phy1", "interface": "wlan1mon", "frequency_mhz": 5765,
                "width_mhz": 20, "tuning_required": true, "vendor_pause_required": true, "disrupts_uplink": false]]
            points.append(row)
        }
        if args.contains("--pineapple-offchannel") {
            points[0]["channel"] = 6; points[0]["frequency_mhz"] = 2437
            points[0]["radio_plan"] = ["phy": "phy1", "interface": "wlan1mon", "frequency_mhz": 2437,
                "width_mhz": 20, "tuning_required": true, "vendor_pause_required": true, "disrupts_uplink": false]
        }
        if args.contains("--pineapple-no-plan") { points[0].removeValue(forKey: "radio_plan") }
        if args.contains("--pineapple-scan-wrong-band") {
            points[0]["channel"] = 9; points[0]["frequency_mhz"] = 5995
            points[0]["unavailable_reason"] = "Unsupported frequency: passive tuning is not qualified for this band."
        }
        if args.contains("--pineapple-scan-empty") { points = [] }
        if args.contains("--pineapple-scan-missing") && refresh > 1 { points.removeFirst() }
        return ["version": 1, "source": "kernel_bss_cache", "fetched_at": Date().timeIntervalSince1970,
                "networks": points, "truncated": false]
    }
    static var row: DeviceRow { DeviceRow(id: "pineapple-preview", name: "My Pager", kind: "daemon", platform: "openwrt-mips", online: true, lastSeen: Date(), capabilities: ["pineapple_v1", "battery", "network"]) }
}
#endif

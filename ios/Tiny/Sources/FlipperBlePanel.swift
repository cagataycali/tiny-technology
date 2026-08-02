/**
 * FlipperBlePanel — the phone's own Flipper link, on this phone's device row.
 *
 * FlipperDevicePanel (Panels.swift) is about a Flipper on the far end of a USB
 * cable: it reports the HOST's name and presence, because that machine being
 * asleep is the usual reason the Flipper is unreachable. This panel is the other
 * route — no cable and no host, just the board in the user's pocket and the phone
 * next to it. So it sits on this phone's row, where the link actually lives.
 *
 * The pairing flow is a scan rather than a QR or a code entry, because the
 * Flipper's serial characteristics are ATTR_PERMISSION_AUTHEN_* in firmware: iOS
 * raises the system pairing sheet the moment we subscribe, and the 6-digit code
 * appears on the Flipper's own screen. Nothing this file can do replaces that
 * moment, so it gets out of the way and explains what to expect.
 */
import SwiftUI

struct FlipperBlePanel: View {
    @ObservedObject private var flipper = FlipperGateway.shared
    @State private var showPairing = false
    @State private var showFiles = false
    @State private var busy = false
    @State private var note: String?
    /// When `flipper.info` was last read. The line it dates is a battery
    /// percentage and a free-space figure, and neither stays true because the
    /// sheet is still open — the same rule FlipperDevicePanel established.
    @State private var stamp: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "wave.3.right").foregroundStyle(.orange)
                Text("Flipper Zero").font(.caption.bold())
                Text("over Bluetooth").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                if busy { ProgressView().controlSize(.mini) }
            }

            if flipper.unit == nil {
                // The pitch, in one line, because this is the only place the
                // feature is discoverable.
                Text("Link the Flipper to this phone and it answers from your pocket — no cable, no laptop awake.")
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Find my Flipper") { showPairing = true }
                    .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
            } else {
                paired
            }

            if let n = note {
                Text(n).font(.caption2).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let e = flipper.lastError {
                Text(e).font(.caption2).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .devicePanel()
        .sheet(isPresented: $showPairing) { FlipperPairingSheet() }
        .sheet(isPresented: $showFiles) { FlipperFilesSheet() }
    }

    @ViewBuilder private var paired: some View {
        let u = flipper.unit
        HStack(spacing: 6) {
            Circle()
                .fill(flipper.linked ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 7, height: 7)
            Text(u?.name ?? "Flipper").font(.caption2)
            Spacer()
        }
        if flipper.linked {
            if let info = flipper.info {
                Text(info.summary)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // Inside the same branch, so an age is never drawn without the
                // reading it ages.
                if let asOf = ReadingAge.asOf(stamp) {
                    Text(asOf).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !flipper.activity.isEmpty {
                Text(flipper.activity).font(.caption2).foregroundStyle(.blue)
            }
            HStack(spacing: 6) {
                Button("Refresh") { Task { await refresh() } }
                // Find-my-Flipper, and the friendliest proof the link is real —
                // the board beeps and blinks in the user's hand.
                Button("Beep") { Task { await beep() } }
                Button("Files") { showFiles = true }
            }
            .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
            .disabled(busy)
        } else {
            // "Out of range" is the normal state of something in a bag, not an
            // error. Say what it means rather than colouring it red.
            Text("Not connected — bring the Flipper nearby and make sure Bluetooth is on in its settings.")
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Button("Reconnect") { flipper.start() }
                Button("Unlink") { flipper.forget() }
            }
            .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
        }
    }

    private func refresh() async {
        busy = true
        defer { busy = false }
        note = nil
        await flipper.refresh()
        stamp = Date()
    }

    private func beep() async {
        busy = true
        defer { busy = false }
        note = nil
        do {
            try await flipper.alert()
            note = "🔔 the Flipper beeped."
        } catch {
            note = error.localizedDescription
        }
    }
}

/// The scan list. Foreground-only and short-lived by design.
struct FlipperPairingSheet: View {
    @ObservedObject private var flipper = FlipperGateway.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(flipper.found) { f in
                        Button {
                            flipper.pair(f.id, name: f.name)
                            dismiss()
                        } label: {
                            HStack {
                                Image(systemName: "wave.3.right").foregroundStyle(.orange)
                                Text(f.name)
                                Spacer()
                                Text("\(f.rssi) dBm").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if flipper.found.isEmpty {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.mini)
                            Text("Looking…").foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Flippers nearby")
                } footer: {
                    // The one thing the user must know before tapping, because
                    // the prompt comes from iOS and the code comes from the
                    // board — neither is something this app can show.
                    Text("Bluetooth has to be enabled on the Flipper itself (Settings → Bluetooth). When you pick it, iOS asks to pair and the Flipper shows a 6-digit code — confirm it on both.")
                }
            }
            .navigationTitle("Link a Flipper")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { flipper.stopScan(); dismiss() }
                }
            }
        }
        .onAppear { flipper.startScan() }
        .onDisappear { flipper.stopScan() }
    }
}

/// Browse the SD card over BLE. Storage.List is genuinely nicer than the CLI's
/// text listing here — sizes arrive as fields, so nothing has to be parsed.
struct FlipperFilesSheet: View {
    @ObservedObject private var flipper = FlipperGateway.shared
    @Environment(\.dismiss) private var dismiss
    @State private var path = "/ext"
    @State private var entries: [FlipperEntry] = []
    @State private var loading = false
    @State private var error: String?
    @State private var preview: (name: String, body: String)?

    var body: some View {
        NavigationStack {
            List {
                if path != "/ext" {
                    Button {
                        path = Self.parent(of: path)
                        Task { await load() }
                    } label: {
                        Label("Up", systemImage: "arrow.up.left")
                    }
                }
                ForEach(entries) { e in
                    Button { Task { await open(e) } } label: {
                        HStack {
                            Image(systemName: e.isDir ? "folder" : "doc")
                                .foregroundStyle(e.isDir ? .blue : .secondary)
                            Text(e.name)
                            Spacer()
                            if !e.isDir {
                                Text(Self.bytes(e.size))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if loading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text("Reading the card…").foregroundStyle(.secondary)
                    }
                }
                if let e = error {
                    Text(e).font(.caption).foregroundStyle(.orange)
                }
                if let p = preview {
                    Section(p.name) {
                        Text(p.body).font(.caption2.monospaced())
                    }
                }
            }
            .navigationTitle(path)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        error = nil
        preview = nil
        do {
            entries = try await flipper.list(path)
        } catch let err {
            // Bound explicitly: a bare `catch` shadows `error` with the thrown
            // value, so `error = error.localizedDescription` assigns to the
            // immutable binding and never reaches the @State the view reads.
            entries = []
            error = err.localizedDescription
        }
    }

    private func open(_ e: FlipperEntry) async {
        if e.isDir {
            path = path.hasSuffix("/") ? path + e.name : path + "/" + e.name
            await load()
            return
        }
        loading = true
        defer { loading = false }
        error = nil
        let full = path.hasSuffix("/") ? path + e.name : path + "/" + e.name
        do {
            let data = try await flipper.read(full)
            let text = String(data: data, encoding: .utf8)
            // A .nfc or .sub dump that isn't UTF-8 shows as hex rather than as
            // replacement characters pretending to be content.
            preview = (e.name, text?.contains("\u{FFFD}") == false
                ? text!
                : data.prefix(512).map { String(format: "%02x", $0) }.joined())
        } catch let err {
            // The credential guard's refusal lands here, in the user's own words
            // — it is a sentence, not a failure code.
            error = err.localizedDescription
        }
    }

    static func parent(of p: String) -> String {
        let parts = p.split(separator: "/").dropLast()
        return parts.isEmpty ? "/ext" : "/" + parts.joined(separator: "/")
    }

    static func bytes(_ n: UInt64) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
        return String(format: "%.1f MB", Double(n) / 1_048_576)
    }
}

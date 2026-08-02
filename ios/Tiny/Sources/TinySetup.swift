/**
 * TinySetup — BLE provisioning for tiny hardware beacons (Nicla necklace).
 *
 * The firmware (strands-nicla firmware/tiny_ble.py, firmware/voice/tiny_voice)
 * advertises a connectable "tiny-XXXX" beacon and exposes one GATT
 * characteristic that accepts newline-terminated JSON, chunked across writes:
 *
 *   {"ssid","key","device_id","token","name"}\n
 *   → notify {"ok":true,"complete":true[,"missing":[…]]}  → device reboots
 *
 * Flow here mirrors the Meta-glasses pairing UX: NearbyView spots the beacon
 * (TinyBeaconInfo) → "Set up" sheet → this LINKS to the board first, and only
 * then enrolls a device record (POST /api/devices mints the tind_ token ONCE)
 * and writes the config.
 *
 * Order matters, and two bugs taught us why:
 *
 *   - Enrolling before the link minted a registry row on every failed attempt.
 *     That's where the orphaned "registered, seen 2 min ago, out of range"
 *     devices came from — and their token is returned exactly once, so an
 *     orphan can never be provisioned, only revoked.
 *   - `retrievePeripherals(withIdentifiers:)` hands back a CBPeripheral for an
 *     identifier that may be gone (the board reboots on every provision, and
 *     iOS can resolve it to a new identifier). `connect()` on a stale one never
 *     calls didFailToConnect — it waits forever. That was the setup hanging on
 *     "Connecting…" while the board sat there happily advertising. So: every
 *     phase is watchdogged, and a parallel scan for the service UUID rescues
 *     the attempt by dialing whoever is provably on air right now.
 *
 * The account bearer JWT is deliberately NOT sent. The firmware retired it
 * (tiny_upload authenticates media uploads with the device token, which is
 * scoped to this one board and revocable from the Devices panel); shipping an
 * account-wide credential into a wearable's flash was authority it never
 * needed.
 */
import CoreBluetooth
import SwiftUI

// File-scope: the CBPeripheralDelegate callbacks that filter on these run off
// the main actor. CBUUID is immutable, just not annotated Sendable.
private nonisolated(unsafe) let tinyServiceUUID = CBUUID(string: "74696e79-5f62-6c65-5f70-726f76697331")
private nonisolated(unsafe) let tinyConfigUUID = CBUUID(string: "74696e79-5f63-6667-5f77-726974653031")

/// Config payload ceilings, per board — they are NOT the same, and this sheet
/// provisions both. The Vision (tiny_ble.py) sets a 1024-byte GATT buffer sized
/// for a ~400-byte bearer JWT; the Voice keeps a 256-byte static buffer
/// (`TV_CFG_MAX` in tiny_voice.ino) because that board has no heap to spare.
/// Sending 900 bytes to a Voice would be refused on the board after crossing the
/// air, so bound it correctly here instead. Both leave headroom for the
/// newline terminator and JSON punctuation.
private let tinyConfigLimitVision = 900
private let tinyConfigLimitVoice = 240

// Not @MainActor: CoreBluetooth hands non-Sendable objects to the delegate,
// and region-isolation rejects moving them onto an actor. Instead the manager
// is created with queue: .main, so every callback and every state mutation
// happens on the main thread — same guarantee, no sending.
final class TinyProvisioner: NSObject, ObservableObject, @unchecked Sendable {

    enum Phase: Equatable {
        case idle, connecting, discovering, linked, writing, waiting
        case done(complete: Bool)
        case failed(String)
    }

    @Published var phase: Phase = .idle
    /// Extra context for the current phase (e.g. which config keys the board
    /// still considers missing) — shown under the status line.
    @Published var detail: String?

    private var central: CBCentralManager?
    private var target: UUID?
    private var payload = Data()
    private var peripheral: CBPeripheral?
    private var configChar: CBCharacteristic?
    /// Peripherals seen advertising the tiny service during this attempt. Held
    /// strongly: CoreBluetooth discards peripherals you don't retain.
    private var onAir: [CBPeripheral] = []
    private var scanning = false
    /// Bumped by every arm()/disarm() — a stale watchdog sees a changed value
    /// and returns instead of failing a phase that already moved on.
    private var generation = 0
    private var linkCont: CheckedContinuation<Bool, Never>?

    // ── Step 1: get a live link + the config characteristic ───────────────

    /// Connect and discover, WITHOUT touching the registry. Returns false with
    /// `phase == .failed(reason)` so the caller can abandon the attempt before
    /// minting a device token that would otherwise be orphaned.
    func link(beaconId: UUID) async -> Bool {
        // Already linked (e.g. retrying after an enrollment hiccup) — reuse it.
        if configChar != nil, peripheral?.state == .connected {
            phase = .linked
            return true
        }
        target = beaconId
        peripheral = nil
        configChar = nil
        onAir = []
        detail = nil
        phase = .connecting
        arm(25, "Couldn't reach the device. Bring it closer, make sure it's powered, then rescan Nearby.")
        scheduleRescue()
        return await withCheckedContinuation { cont in
            linkCont = cont
            if let c = central, c.state == .poweredOn {
                begin()
            } else if central == nil {
                central = CBCentralManager(delegate: self, queue: .main)
            }
            // Otherwise centralManagerDidUpdateState drives begin().
        }
    }

    // ── Step 2: write the config, wait for the board's verdict ────────────

    func send(config: [String: String], limit: Int = tinyConfigLimitVision) {
        guard let p = peripheral, let ch = configChar, p.state == .connected else {
            fail("Lost the link before the configuration could be sent — try again.")
            return
        }
        var json = (try? JSONSerialization.data(withJSONObject: config)) ?? Data()
        json.append(0x0A) // newline terminates one payload on the firmware side
        guard json.count <= limit else {
            fail("Configuration is too large for the device (\(json.count) bytes).")
            return
        }
        payload = json
        phase = .writing
        arm(20, "The device never confirmed the configuration. Bring it closer and try again.")
        let mtu = min(max(20, p.maximumWriteValueLength(for: .withResponse)), 512)
        var offset = 0
        while offset < payload.count {
            let end = min(offset + mtu, payload.count)
            p.writeValue(payload.subdata(in: offset ..< end), for: ch, type: .withResponse)
            offset = end
        }
        phase = .waiting
    }

    func cancel() {
        disarm()
        stopScan()
        settleLink(false)
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil
        configChar = nil
        phase = .idle
        detail = nil
    }

    // ── Connection machinery ─────────────────────────────────────────────

    fileprivate func begin() {
        guard let c = central, c.state == .poweredOn else { return }
        if let id = target, let p = c.retrievePeripherals(withIdentifiers: [id]).first {
            peripheral = p
            p.delegate = self
            c.connect(p)
        }
        // In parallel, watch for whoever is actually advertising: the cached
        // identifier above may be a ghost, and dialing a ghost never fails.
        startScan()
    }

    private func startScan() {
        guard let c = central, c.state == .poweredOn, !scanning else { return }
        scanning = true
        c.scanForPeripherals(withServices: [tinyServiceUUID], options: nil)
    }

    private func stopScan() {
        if scanning { central?.stopScan(); scanning = false }
    }

    /// Halfway through the connect budget, if we're still dialing, switch to a
    /// peripheral we've actually heard from.
    private func scheduleRescue() {
        let g = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 9) { [weak self] in
            guard let self, self.generation == g else { return }
            guard case .connecting = self.phase else { return }
            guard let fresh = self.onAir.first(where: { $0.state != .connected }) ?? self.onAir.first
            else { return } // nothing on air yet; the 25s watchdog still owns this
            if let stale = self.peripheral, stale.identifier != fresh.identifier {
                self.central?.cancelPeripheralConnection(stale)
            }
            self.peripheral = fresh
            fresh.delegate = self
            self.central?.connect(fresh)
        }
    }

    fileprivate func ready(_ ch: CBCharacteristic) {
        disarm()
        stopScan()
        configChar = ch
        phase = .linked
        settleLink(true)
    }

    fileprivate func finish(_ data: Data?) {
        disarm()
        guard let d = data,
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
        else {
            phase = .failed("The device sent a reply we couldn't read.")
            return
        }
        guard obj["ok"] as? Bool == true else {
            let why = (obj["error"] as? String).map { " (\($0))" } ?? ""
            phase = .failed("The device rejected the configuration\(why).")
            return
        }
        let complete = obj["complete"] as? Bool ?? false
        if let missing = obj["missing"] as? [String], !missing.isEmpty {
            detail = "Still missing: \(missing.joined(separator: ", "))."
        }
        phase = .done(complete: complete)
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
    }

    fileprivate func fail(_ why: String) {
        disarm()
        stopScan()
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        phase = .failed(why)
        settleLink(false)
    }

    // ── Watchdog + continuation plumbing (main thread only) ───────────────

    private func arm(_ seconds: TimeInterval, _ message: String) {
        generation += 1
        let g = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.generation == g else { return }
            self.fail(message)
        }
    }

    private func disarm() { generation += 1 }

    private func settleLink(_ ok: Bool) {
        guard let c = linkCont else { return }
        linkCont = nil
        c.resume(returning: ok)
    }
}

extension TinyProvisioner: CBCentralManagerDelegate, CBPeripheralDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn: begin()
        case .unauthorized: fail("Bluetooth permission is off for tiny — enable it in Settings.")
        case .poweredOff: fail("Bluetooth is off — turn it on to set up your tiny.")
        default: break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard !onAir.contains(where: { $0.identifier == peripheral.identifier }) else { return }
        onAir.append(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral.identifier == self.peripheral?.identifier else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        stopScan()
        phase = .discovering
        arm(15, "The device connected but never answered. Power-cycle it and try again.")
        peripheral.discoverServices([tinyServiceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        // Don't fail the attempt outright: the parallel scan may still rescue
        // it, and the connect watchdog is the real deadline.
        guard case .connecting = phase else {
            fail(error?.localizedDescription ?? "Connection failed.")
            return
        }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        // The firmware resets ~1s after acking, so a disconnect once we're done
        // is the success path, not a fault.
        if case .done = phase { return }
        if case .failed = phase { return }
        if case .idle = phase { return }
        fail("The device disconnected before setup finished — try again.")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == tinyServiceUUID }) else {
            fail("That isn't a tiny device (setup service missing).")
            return
        }
        peripheral.discoverCharacteristics([tinyConfigUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let ch = service.characteristics?.first(where: { $0.uuid == tinyConfigUUID }) else {
            fail("That isn't a tiny device (config characteristic missing).")
            return
        }
        peripheral.setNotifyValue(true, for: ch)
        ready(ch)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error, case .waiting = phase {
            fail("Sending the configuration failed: \(error.localizedDescription)")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == tinyConfigUUID else { return }
        // Only the post-write notify is a verdict. A notify that arrives while
        // we're still linking (or after we're done) is not ours to act on.
        switch phase {
        case .writing, .waiting: break
        default: return
        }
        // ECHO GUARD. ArduinoBLE notifies subscribers on a CENTRAL write too
        // (BLELocalCharacteristic::writeValue(device,…) calls the notifying
        // overload), so the board echoes every chunk we send back at us before
        // it ever answers. Measured on wire, a 4-chunk write produced:
        //   {"device_id": "phyte / st-0001", "token": " / … / {"ok":true,…}
        // Acting on the first notify therefore fed our own truncated payload to
        // finish(), which failed to parse it and reported "the device sent a
        // reply we couldn't read" — with a perfectly healthy board on the desk.
        // A verdict is the only thing carrying "ok", so wait for that and drop
        // anything else instead of trusting arrival order.
        guard let d = characteristic.value,
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              obj["ok"] != nil
        else { return }
        finish(d)
    }
}

/// Sheet launched from NearbyView on an unprovisioned (or any) tiny beacon.
struct TinySetupView: View {
    let beacon: BleDevice
    @EnvironmentObject var session: TinySession
    @StateObject private var prov = TinyProvisioner()
    @Environment(\.dismiss) private var dismiss

    /// Remembered across setups: iOS won't hand an app the current SSID without
    /// a location entitlement, and re-provisioning a board (or setting up a
    /// second one) shouldn't mean retyping the network name.
    @AppStorage("cfg_last_wifi_ssid") private var ssid = ""
    @State private var password = ""
    @State private var enrolling = false
    @State private var error: String?

    /// A Nicla Voice is an nRF52832: BLE only, no WiFi radio at all. Showing it
    /// a WiFi form would collect credentials it can never use and imply a
    /// connection it can never make — a phone is its gateway instead.
    private var isVoice: Bool { beacon.tiny?.kind == .voice }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Device", value: beacon.name)
                    LabeledContent("Kind", value: isVoice ? "Nicla Voice" : "Nicla Vision")
                    LabeledContent("Status", value: beacon.tiny?.provisioned == true ? "Configured" : "New")
                } header: { Text("tiny hardware") }

                if isVoice {
                    Section {
                        Label("Always-on wake word", systemImage: "waveform.badge.mic")
                        Label("This phone is its gateway", systemImage: "iphone.radiowaves.left.and.right")
                    } header: { Text("How it works") } footer: {
                        Text("Nicla Voice listens on its own neural chip and has no WiFi. It stays paired to this phone over Bluetooth, and your phone relays what it hears to your tiny.")
                    }
                } else {
                    Section {
                        TextField("WiFi network", text: $ssid)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("WiFi password", text: $password)
                    } header: { Text("Home WiFi") } footer: {
                        Text("Type the 2.4GHz network name exactly — the board's radio is 2.4GHz only and can't see a 5GHz network. Credentials go straight to the device over Bluetooth.")
                    }
                }

                if let e = error { Text(e).foregroundStyle(.red).font(.caption) }

                Section {
                    switch prov.phase {
                    case .idle, .failed:
                        Button {
                            Task { await setUp() }
                        } label: {
                            if enrolling { ProgressView() } else { Text("Set up") }
                        }
                        .disabled((!isVoice && ssid.isEmpty) || enrolling || session.token == nil)
                        if session.token == nil {
                            Text("Log in first — setup enrolls the device to your tiny.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    case .connecting: Label("Connecting…", systemImage: "dot.radiowaves.left.and.right")
                    case .discovering: Label("Handshaking…", systemImage: "point.3.connected.trianglepath.dotted")
                    case .linked: Label("Linked — enrolling…", systemImage: "link")
                    case .writing, .waiting: Label("Sending configuration…", systemImage: "arrow.up.circle")
                    case .done(let complete):
                        Label(complete ? "Done — device is rebooting onto your WiFi."
                                       : "Saved, but configuration is incomplete.",
                              systemImage: complete ? "checkmark.circle.fill" : "exclamationmark.triangle")
                            .foregroundStyle(complete ? .green : .orange)
                    }
                    if case .failed(let why) = prov.phase {
                        Text(why).foregroundStyle(.red).font(.caption)
                    }
                    if let d = prov.detail {
                        Text(d).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Set up tiny")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(prov.phase == .idle ? "Cancel" : "Close") { prov.cancel(); dismiss() }
                }
            }
        }
    }

    /// Link first, enroll second, write third. Anything that fails before the
    /// link leaves the registry untouched — no orphaned device row whose token
    /// was minted once and lost.
    private func setUp() async {
        guard let token = session.token else { return }
        error = nil

        guard await prov.link(beaconId: beacon.id) else { return } // phase carries why

        enrolling = true
        defer { enrolling = false }
        // Capabilities claim ONLY what the board has. An agent that sees
        // `camera` on a Voice will call a photo tool that can never succeed, and
        // a confident failure is worse than an absent capability.
        let platform = beacon.tiny?.platform ?? "nicla-vision"
        let caps = isVoice
            ? ["mic", "wake", "imu", "ble"]
            : ["camera", "mic", "tof", "imu", "ble", "wifi"]

        guard let r: [String: Any] = try? await Api.post("/api/devices", token: token, body: [
            "name": beacon.name,
            "platform": platform,
            "kind": "daemon",
            "capabilities": caps,
        ]),
            let deviceId = r["device_id"] as? String,
            let deviceToken = r["device_token"] as? String
        else {
            error = "Could not enroll the device — check your connection and login."
            prov.cancel()
            return
        }

        // Identity only for the Voice: it has no radio that could use ssid/key,
        // and the firmware ignores those keys. Same chunked-JSON contract either
        // way, which is why one provisioner serves both boards.
        var config: [String: String] = [
            "device_id": deviceId,
            "token": deviceToken,
            "name": beacon.name,
        ]
        if !isVoice {
            config["ssid"] = ssid
            config["key"] = password
        }
        prov.send(config: config, limit: isVoice ? tinyConfigLimitVoice : tinyConfigLimitVision)

        // Remember which unit is a Voice so the gateway knows to keep a BLE
        // link to it after setup — the device cannot heartbeat for itself.
        if isVoice {
            NiclaVoiceGateway.shared.register(deviceId: deviceId, token: deviceToken, beaconId: beacon.id)
        }
    }
}

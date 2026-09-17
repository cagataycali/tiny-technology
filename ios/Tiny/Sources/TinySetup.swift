/**
 * TinySetup — BLE provisioning for tiny hardware beacons (Nicla necklace).
 *
 * The firmware (strands-nicla firmware/tiny_ble.py, firmware/voice/tiny_voice)
 * advertises a connectable "tiny-XXXX" beacon and exposes one GATT
 * characteristic that accepts newline-terminated JSON, chunked across writes:
 *
 *   {"networks":[{"ssid","key"},…],"ssid","key","device_id","token","name"}\n
 *   → notify {"ok":true,"complete":true[,"missing":[…]]}  → device reboots
 *
 * WiFi is a LIST (`WifiNetworks`): the board sweeps it in order so one necklace
 * roams between home, a phone hotspot and an office without being re-provisioned
 * at every doorway. The top-level pair is the first entry repeated, for a board
 * on firmware older than the list.
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

    func send(config: [String: String],
              networks: [WifiNetwork] = [],
              limit: Int = tinyConfigLimitVision) {
        guard let p = peripheral, let ch = configChar, p.state == .connected else {
            fail("Lost the link before the configuration could be sent — try again.")
            return
        }
        // WifiNetworks.encoded owns the frame, newline included: the sheet sizes
        // its list against the same function, and a second encoder here is how
        // what it promises drifts from what crosses the air.
        let json = WifiNetworks.encoded(identity: config, networks: networks)
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

/// 🔴 What this app may CLAIM about a board it has just tried to enroll.
///
/// Enrolment is the one irreversible step in setup — `POST /api/devices` mints
/// the board's token and returns it exactly once (see this file's header), so a
/// row created and not configured is an orphan that "can never be provisioned,
/// only revoked". The sheet answered every way that request could end with one
/// composite `guard` and one sentence:
///
///     "Could not enroll the device — check your connection and login."
///
/// Three separate things wrong with that, and the app already knew better:
///
///   1. **Two mutually exclusive causes with opposite remedies**, which is inc
///      15's whole lesson (`LoadFailure`) reappearing on the highest-stakes
///      action in the panel. The reader is told to check a login the button has
///      already verified — `Set up` is `.disabled(session.token == nil)` — so
///      the only honest half is the one about the connection.
///   2. **`try?` threw away the answer.** The route's refusals are TYPED and one
///      of them is the account cap, whose words the devices footer already
///      quotes: a 424 carrying `device limit reached (20) — revoke one first`
///      arrived here as "check your connection". `Api.httpMessage` prefers the
///      server's own sentence for exactly this status.
///   3. ⚠️⚠️ **"Could not enroll" is a claim about the SERVER's state that the
///      app cannot make when no answer arrived.** `app/api/devices/route.ts`
///      turns a worker that took longer than its 10s budget into a 503 —
///      `relay()`'s `transient` branch — and that worker may have inserted the
///      row already. Told "could not enroll", the user presses Set up again and
///      mints a SECOND row for one necklace, the first holding a token that was
///      returned once into a dropped connection. That is precisely the orphan
///      this file's link-then-enroll ordering exists to prevent.
///
/// `Api.swift` states the rule verbatim, for a different caller: a transport
/// failure means the request "may well have been delivered and acted on … so
/// PayQuote must not turn this into a claim about the payment not happening"
/// (`putBody`'s doc). Same wire, same absence of a decision, same rule.
///
/// So: **a 4xx is a DECISION and a 5xx or a dead connection is the absence of
/// one.** Every refusal on this route is decided before the INSERT (missing
/// name, lapsed session, the cap), which is what makes `refused` safe to retry.
/// Pure and file-scope like `DevicesFooter` and `RevokeFailure`: what a surface
/// may claim is decided where a test can call it.
enum EnrollOutcome: Equatable {
    /// The registry minted the row AND handed back the token. The only state
    /// setup may continue from, because the config write needs that token.
    case enrolled(id: String, token: String)
    /// The server looked at this request and declined it. Nothing was created.
    case refused(String)
    /// ⚠️ The third answer: no decision reached us, so the row may exist.
    case unknown(String)

    /// Nothing was created, so the reason is the whole message.
    static let refusedLead = "Not enrolled."
    /// Leads with the doubt, because the next thing the user does depends on it.
    static let unknownLead = "Not confirmed — this board may already be enrolled."
    /// The remedy that belongs ONLY to the unknown case: a second Set up would
    /// mint a second row, and the first one's token is already gone.
    static let checkFleet = "Check My devices first — revoke a row for this board before setting it up again."
    /// A 2xx we cannot provision from. The row is real; the token isn't ours.
    static let unreadable = "The server accepted it but sent no usable token."

    /// The red line under the form, or nil for the one outcome that has nothing
    /// to say here — `.enrolled` moves straight on to writing the config, and
    /// that phase reports itself.
    var message: String? {
        switch self {
        case .enrolled: return nil
        case .refused(let why): return "\(Self.refusedLead) \(why)"
        case .unknown(let why): return "\(Self.unknownLead) \(why) \(Self.checkFleet)"
        }
    }

    /// A 2xx body. Both fields are required and both are trimmed: an empty-string
    /// token passes `as? String` and would be written into the board's flash,
    /// where every upload it authenticates 401s forever.
    nonisolated static func read(_ body: [String: Any]) -> EnrollOutcome {
        let id = (body["device_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = (body["device_token"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty, !token.isEmpty else { return .unknown(unreadable) }
        return .enrolled(id: id, token: token)
    }

    /// A thrown request. `LoadFailure.message` is the house table — this is an
    /// action the user took, so it gets the chat-flavoured wording every other
    /// POST failure in the app gets, not the list flavour.
    nonisolated static func read(error: Error) -> EnrollOutcome {
        let why = LoadFailure.message(error)
        guard let status = (error as? ApiError)?.status, (400...499).contains(status)
        else { return .unknown(why) }
        return .refused(why)
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

    /// The saved networks themselves live outside this sheet — a board is set up
    /// once, and the list is meant to outlive that.
    @ObservedObject private var wifi = WifiStore.shared

    /// A Nicla Voice is an nRF52832: BLE only, no WiFi radio at all. Showing it
    /// a WiFi form would collect credentials it can never use and imply a
    /// connection it can never make — a phone is its gateway instead.
    private var isVoice: Bool { beacon.tiny?.kind == .voice }

    /// The identity half of the payload, at its real size, BEFORE it exists.
    ///
    /// `POST /api/devices` answers with a `crypto.randomUUID()` (36 chars) and a
    /// `tind_` + base64url(32 bytes) token — 5 + 43 = 48 (worker
    /// `src/devices.ts`, `mintToken`). Both widths are fixed and neither needs
    /// JSON escaping, so this measures the very payload that will be written.
    /// That matters because the alternative is discovering the overflow AFTER
    /// enrolling, and this board's token is returned exactly once.
    private var plannedIdentity: [String: String] {
        ["device_id": String(repeating: "x", count: 36),
         "token": String(repeating: "x", count: 48),
         "name": beacon.name]
    }

    /// The tail of the list this board cannot hold — named in the UI, never cut
    /// away quietly.
    private var dropped: [WifiNetwork] {
        WifiNetworks.fit(wifi.networks,
                         identity: plannedIdentity,
                         budget: tinyConfigLimitVision).dropped
    }

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
                        if wifi.networks.isEmpty {
                            Text("None saved yet — add the network this board should join below. A phone hotspot counts.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(Array(wifi.networks.enumerated()), id: \.element.id) { i, net in
                            HStack {
                                Text("\(i + 1)").font(.caption).monospacedDigit()
                                    .foregroundStyle(.secondary).frame(width: 16, alignment: .trailing)
                                Text(net.ssid)
                                Spacer()
                                if dropped.contains(net) {
                                    Text("won't fit").font(.caption2).foregroundStyle(.orange)
                                }
                            }
                        }
                        .onDelete { wifi.remove(at: $0) }
                        .onMove { wifi.move(from: $0, to: $1) }
                    } header: {
                        HStack {
                            Text("Saved WiFi networks")
                            Spacer()
                            if !wifi.networks.isEmpty { EditButton().font(.caption) }
                        }
                    } footer: {
                        Text("The board tries these in order and keeps the first that answers, so it can roam between home and your hotspot without being set up again. Drag to change which one wins. 2.4GHz only — its radio cannot see a 5GHz network.")
                    }

                    Section {
                        TextField("WiFi network", text: $ssid)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("WiFi password", text: $password)
                        Button("Add network") {
                            wifi.add(ssid: ssid, password: password)
                            password = ""
                        }
                        .disabled(ssid.trimmingCharacters(in: .whitespaces).isEmpty)
                    } header: { Text("Add a network") } footer: {
                        // Naming the overflow, not just refusing it: the board's
                        // buffer is the limit, and a list silently cut to fit
                        // reads as one that was saved whole.
                        if !dropped.isEmpty {
                            Text("Only the first \(wifi.networks.count - dropped.count) fit this board's \(tinyConfigLimitVision)-byte configuration. \(dropped.map(\.ssid).joined(separator: ", ")) won't be sent — remove one, or drag the ones you need above it.")
                                .foregroundStyle(.orange)
                        } else {
                            Text("Type the name exactly. Adding a name that's already saved just updates its password. Kept in this phone's keychain and written to the board over Bluetooth.")
                        }
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
                        .disabled((!isVoice && wifi.networks.isEmpty) || enrolling || session.token == nil)
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

        // ⚠️ do/catch, not `try?`. The thrown ApiError is the only thing that
        // knows whether the server DECIDED against this enrolment or never
        // answered at all, and those two have different remedies — see
        // `EnrollOutcome`, which owns every sentence this can end in.
        let outcome: EnrollOutcome
        do {
            outcome = EnrollOutcome.read(try await Api.post("/api/devices", token: token, body: [
                "name": beacon.name,
                "platform": platform,
                "kind": "daemon",
                "capabilities": caps,
            ]))
        } catch let thrown {
            // Named, because the implicit `error` would shadow this view's own
            // `@State error` and the next line assigns to that one.
            outcome = EnrollOutcome.read(error: thrown)
        }
        guard case .enrolled(let deviceId, let deviceToken) = outcome else {
            error = outcome.message
            prov.cancel()
            return
        }

        // Identity only for the Voice: it has no radio that could use a network
        // list, and its 256-byte buffer would refuse one after it crossed the air.
        // Same chunked-JSON contract either way, which is why one provisioner
        // serves both boards.
        let config: [String: String] = [
            "device_id": deviceId,
            "token": deviceToken,
            "name": beacon.name,
        ]
        let planned = isVoice
            ? []
            : WifiNetworks.fit(wifi.networks,
                               identity: config,
                               budget: tinyConfigLimitVision).sent
        prov.send(config: config,
                  networks: planned,
                  limit: isVoice ? tinyConfigLimitVoice : tinyConfigLimitVision)

        // Remember which unit is a Voice so the gateway knows to keep a BLE
        // link to it after setup — the device cannot heartbeat for itself.
        if isVoice {
            NiclaVoiceGateway.shared.register(deviceId: deviceId, token: deviceToken, beaconId: beacon.id)
        }
    }
}

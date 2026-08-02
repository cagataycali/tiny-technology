/**
 * NiclaVoiceGateway — the phone stands in for a device that cannot reach the
 * internet.
 *
 * The Nicla Vision necklace is a full node: WiFi, its own `tind_` token, it
 * heartbeats and polls the relay by itself (strands-nicla firmware/tiny_node.py).
 * The Nicla Voice cannot. It is an nRF52832 + NDP120 — BLE only, no WiFi radio
 * at all — so nothing it hears can leave the board without a gateway. That is
 * this file: while the phone is near the necklace it holds a BLE link and acts
 * as the device's network stack.
 *
 * Two jobs, both on the device's behalf, not the phone's:
 *
 *   1. Presence. POST /api/devices/heartbeat with the VOICE's deviceId+token
 *      every 30s while connected, so /devices and the agent's tools see the
 *      necklace as online. The window is 60s server-side (PRESENCE_WINDOW_S),
 *      so a dropped link goes 🔴 within a minute — which is the truth: with no
 *      phone in range the board is unreachable, however happily it is listening.
 *
 *   2. Wake events. The firmware notifies {"wake":n,"label":"alexa"} the instant
 *      the NDP120 matches (firmware/voice/tiny_voice/tiny_voice.ino). We forward
 *      it to the owner's event ring via POST /api/devices/event, authenticated
 *      with the DEVICE token — so the agent can answer "did my necklace hear
 *      anything?" without the phone having to be the one asked.
 *
 * What this deliberately does NOT do: claim to carry audio. The board has no
 * audio characteristic — 64KB of RAM with ~60% spent on statics could not hold
 * a buffer, and a 128-byte characteristic added during bring-up broke every BLE
 * connection outright. So a wake is an EVENT, not a recording. If the user wants
 * the words after the wake word, the phone's own mic and on-device recognizer
 * are right there (VoiceMode) — and calling that "the necklace's audio" would be
 * a lie about which microphone heard it.
 */
import CoreBluetooth
import Foundation

// File scope for the same reason as TinySetup's: the CBPeripheralDelegate
// callbacks that compare against these run off the main actor, and CBUUID is
// immutable but not annotated Sendable.
private nonisolated(unsafe) let voiceServiceUUID = CBUUID(string: "74696e79-5f62-6c65-5f70-726f76697331")
private nonisolated(unsafe) let voiceWakeUUID = CBUUID(string: "74696e79-5f77-616b-655f-65766e743031")
private nonisolated(unsafe) let voiceStatusUUID = CBUUID(string: "74696e79-5f73-7461-745f-72643031ffff")

/// One wake the necklace reported, as the phone saw it.
struct VoiceWake: Identifiable, Equatable {
    let id = UUID()
    let label: String
    let count: Int
    let at: Date
}

/// What the board says about itself (status characteristic, JSON with short
/// keys because the whole notify has to fit a 64-byte buffer).
struct VoiceStatus: Equatable {
    var ndpUp = false     // "ndp" — all three .synpkg loads returned 1
    var micOn = false     // "mic" — turnOnMicrophone() returned 0
    var wakes = 0         // "w"   — matches since boot
    var labels = 0        // "l"   — classes in the loaded net
    var uptimeS = 0       // "up"  — seconds since boot

    /// The distinction that matters for a wearable: advertising and *deaf* looks
    /// exactly like advertising and listening from the outside. Without this the
    /// only symptom of a failed model load is a necklace that never fires.
    var listening: Bool { ndpUp && micOn }
}

/// Not @MainActor, same reasoning as TinyProvisioner: CoreBluetooth hands
/// non-Sendable objects to the delegate and region isolation rejects moving
/// them onto an actor. The manager is created with `queue: .main`, so every
/// callback and every mutation below happens on the main thread anyway.
final class NiclaVoiceGateway: NSObject, ObservableObject, @unchecked Sendable {
    static let shared = NiclaVoiceGateway()

    /// A Voice unit this phone has paired and speaks for.
    struct Unit: Equatable {
        let deviceId: String
        let beaconId: UUID
        var name: String
    }

    @Published private(set) var unit: Unit?
    @Published private(set) var connected = false
    @Published private(set) var status: VoiceStatus?
    /// Newest first, bounded — a wearable can fire all day and this is a UI
    /// tail, not a log. The durable copy is the server event ring.
    @Published private(set) var wakes: [VoiceWake] = []
    @Published private(set) var lastError: String?

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var statusChar: CBCharacteristic?
    private var beatTask: Task<Void, Never>?
    /// Pending backoff re-dial. Held so stop()/a successful link can cancel it
    /// instead of letting a stale timer fire into a link we already have.
    private var reconnectTask: Task<Void, Never>?
    /// Literal, not `Self.reconnectBaseS`: a covariant `Self` cannot be
    /// referenced from a stored property initializer.
    private var reconnectDelay: TimeInterval = 1
    /// When the current link reached `connected`. Used to judge, at disconnect,
    /// whether the link was worth resetting the backoff for.
    private var connectedAt: Date?
    /// Set once we have ever been asked to run. Guards the lazy manager: merely
    /// instantiating CBCentralManager triggers the permission prompt, and a user
    /// with no Voice should never see it because of this file.
    private var wanted = false

    private static let unitKey = "nicla_voice_unit"
    private static let wakesMax = 20
    private static let beatSeconds: UInt64 = 30
    private static let capabilities = ["mic", "wake", "imu", "ble"]
    /// Reconnect backoff bounds. The board allows ONE central, so re-dialling is
    /// mutually exclusive with anyone else reaching it — see scheduleReconnect().
    private static let reconnectBaseS: TimeInterval = 1
    private static let reconnectMaxS: TimeInterval = 32
    /// A link this long counts as having worked, and earns a backoff reset. One
    /// heartbeat period: shorter than this and we never even reported presence.
    private static let goodLinkS: TimeInterval = 30

    override private init() {
        super.init()
        // Token stays in the Keychain; the id/beacon pair is not a credential.
        if let d = UserDefaults.standard.dictionary(forKey: Self.unitKey),
           let deviceId = d["deviceId"] as? String,
           let beaconRaw = d["beaconId"] as? String,
           let beaconId = UUID(uuidString: beaconRaw) {
            unit = Unit(deviceId: deviceId, beaconId: beaconId, name: d["name"] as? String ?? "tiny voice")
        }
    }

    // MARK: - Registration

    /// Called from TinySetup once the Voice has accepted its identity over BLE,
    /// and from VoiceDevicePanel.adopt() for a board that was enrolled ELSEWHERE
    /// (paired from a laptop, or from a phone that has since been reinstalled).
    /// That second caller exists because provisioning was the only way in, and
    /// provisioning mints a new device row — so a Voice the owner could see in
    /// their fleet was permanently ungatewayable by this phone.
    ///
    /// One Voice per phone for now: a second register REPLACES the first rather
    /// than silently keeping a stale unit whose token no longer matches.
    func register(deviceId: String, token: String, beaconId: UUID, name: String = "tiny voice") {
        Keychain.set(Self.tokenKey(deviceId), token)
        UserDefaults.standard.set(
            ["deviceId": deviceId, "beaconId": beaconId.uuidString, "name": name],
            forKey: Self.unitKey)
        unit = Unit(deviceId: deviceId, beaconId: beaconId, name: name)
        start()
    }

    /// Forget the unit locally. Does NOT revoke the device server-side — that is
    /// the Devices panel's swipe action, and conflating the two would mean
    /// closing this sheet silently killed a token.
    func forget() {
        if let u = unit { Keychain.delete(Self.tokenKey(u.deviceId)) }
        UserDefaults.standard.removeObject(forKey: Self.unitKey)
        stop()
        unit = nil
        status = nil
        wakes = []
    }

    private static func tokenKey(_ deviceId: String) -> String { "nicla_voice_token_\(deviceId)" }
    private var token: String? { unit.flatMap { Keychain.get(Self.tokenKey($0.deviceId)) } }

    /// The necklace's identity, for callers acting ON ITS BEHALF (NiclaRecorder
    /// posts transcripts as the device that heard them, not as the phone).
    var credentials: (deviceId: String, token: String)? {
        unit.flatMap { u in Keychain.get(Self.tokenKey(u.deviceId)).map { (u.deviceId, $0) } }
    }

    // MARK: - Link lifecycle

    /// Bring the link up. Safe to call repeatedly (app launch, foreground,
    /// after setup) — a no-op when there is no registered Voice.
    func start() {
        guard unit != nil else { return }
        wanted = true
        // An explicit start (app launch, foreground, finished setup) is a user
        // intent, so it jumps the backoff queue rather than waiting out a delay
        // earned by earlier failures.
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectDelay = Self.reconnectBaseS
        if central == nil {
            // Restore identifier: pairs with the `bluetooth-central` background
            // mode. iOS may terminate a backgrounded app and, when the necklace
            // reconnects or notifies, relaunch it and hand this manager back
            // through willRestoreState — so a necklace worn under a coat keeps
            // delivering wakes across an app termination the user never saw.
            // Without it the link is gone until someone opens the app again,
            // which for a wearable means it silently stops working.
            central = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionRestoreIdentifierKey: "technology.tiny.nicla.voice",
            ])
        } else {
            connectIfPossible()
        }
    }

    func stop() {
        wanted = false
        beatTask?.cancel()
        beatTask = nil
        // A pending backoff re-dial outlives this call otherwise, and would grab
        // the board's single connection slot again after the user asked us to let
        // go of it.
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectDelay = Self.reconnectBaseS
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil
        statusChar = nil
        connected = false
        connectedAt = nil
    }

    /// Ask for the status JSON now (the firmware also notifies it periodically).
    func refreshStatus() {
        guard let p = peripheral, let ch = statusChar else { return }
        p.readValue(for: ch)
    }

    fileprivate func connectIfPossible() {
        guard wanted, let c = central, c.state == .poweredOn, let u = unit else { return }
        guard let p = c.retrievePeripherals(withIdentifiers: [u.beaconId]).first else {
            // The beacon is known to iOS by UUID only after it has been seen; a
            // phone restored from backup has the id but no cached peripheral.
            lastError = "Bring the necklace nearby and open Nearby devices once."
            return
        }
        peripheral = p
        p.delegate = self
        // No timeout by design: CoreBluetooth keeps a pending connection alive
        // until the peripheral appears, which is exactly the behaviour a wearable
        // wants — walk back into range and the link restores itself with no UI.
        c.connect(p)
    }

    /// Re-dial after a drop, with BACKOFF. Never call `connectIfPossible()`
    /// straight from a disconnect handler.
    ///
    /// The board is `cordio.max-connections: 1` (Nicla variant mbed_app.json):
    /// exactly one central, ever. Re-dialling instantly from
    /// didDisconnect/didFailToConnect turned that slot into a spin lock — the
    /// phone reclaimed it the microsecond it freed, so no other central could
    /// ever complete service discovery, and the board looked broken from
    /// everywhere else. Measured on hardware by counting connects in the beacon's
    /// manufacturer data (readable WITHOUT connecting, so contention cannot hide
    /// it): 11 connect/disconnect cycles in 45s with nothing else connected.
    ///
    /// That was also the confound that made three firmware "fixes" read as
    /// failures in a row: every local measurement was competing with this loop.
    ///
    /// Backoff doubles 1s → 32s and resets only on a link that reached
    /// `connected`. A wearable does not need sub-second reconnects; it needs to
    /// not deny its own hardware.
    private func scheduleReconnect() {
        guard wanted else { return }
        reconnectTask?.cancel()
        let delay = reconnectDelay
        reconnectDelay = min(delay * 2, Self.reconnectMaxS)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.connectIfPossible() }
        }
    }

    // MARK: - Proxy presence

    /// Heartbeat as the DEVICE, for as long as we hold its link. Runs only while
    /// connected: a heartbeat sent while the necklace is out of range would
    /// report a reachable device that no tool call could actually reach.
    private func startBeating() {
        beatTask?.cancel()
        beatTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.beat()
                try? await Task.sleep(for: .seconds(Double(Self.beatSeconds)))
            }
        }
    }

    private func beat() async {
        guard connected, let u = unit, let tok = token else { return }
        let body: [String: Any] = ["deviceId": u.deviceId, "token": tok,
                                   "capabilities": Self.capabilities]
        let res = try? await Api.postRaw("/api/devices/heartbeat", body: body)
        // 401 means the owner revoked this device from the Devices panel. Keep
        // holding the BLE link (the board is still ours physically) but stop
        // claiming presence, and say why — a silent stop looks like a bug.
        if let res, res["ok"] as? Bool == false {
            let why = (res["error"] as? String) ?? "heartbeat rejected"
            lastError = why.contains("unknown device") ? "This necklace was revoked — set it up again." : why
        }
    }

    // MARK: - Wake fan-out

    fileprivate func handleWake(_ data: Data?) {
        guard let d = data, !d.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
        // The firmware strips the net's "NN0:" prefix already; default to the
        // model name rather than "?" so a label-less match is still legible.
        let label = (obj["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let count = (obj["wake"] as? NSNumber)?.intValue ?? 0
        let wake = VoiceWake(label: label.isEmpty ? "wake" : label, count: count, at: Date())
        wakes.insert(wake, at: 0)
        if wakes.count > Self.wakesMax { wakes.removeLast(wakes.count - Self.wakesMax) }
        // A wearable's feedback loop: the necklace has one LED you cannot see
        // while it's on your chest, so the phone is where "it heard you" lands.
        Task { @MainActor in Haptic.shared.play(pattern: "tap", times: 1, intensity: 0.6) }
        Task { await forward(wake) }
        // 🎙️ The recorder half: the wake word is the record button. The
        // necklace can't carry audio (see header), so the PHONE captures the
        // 10s that follow and transcribes on-device. NiclaRecorder refuses to
        // double-start, so a wake mid-recording is just the haptic + event.
        if Config.recordOnWake {
            Task { @MainActor in
                _ = await NiclaRecorder.shared.record(
                    seconds: 10, label: "wake: \(wake.label)", token: nil)
            }
        }
    }

    /// Put the wake on the owner's event ring so the agent can see it later.
    /// Device-token authed (no session needed): the phone may be relaying for a
    /// necklace while nobody is logged into anything on screen.
    private func forward(_ wake: VoiceWake) async {
        guard let u = unit, let tok = token else { return }
        _ = try? await Api.postRaw("/api/devices/event", body: [
            "deviceId": u.deviceId,
            "token": tok,
            "kind": "nicla_wake",
            "detail": "heard “\(wake.label)” (#\(wake.count))",
        ])
    }

    fileprivate func handleStatus(_ data: Data?) {
        guard let d = data, !d.isEmpty,
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
        let int = { (k: String) in (o[k] as? NSNumber)?.intValue ?? 0 }
        var s = VoiceStatus()
        s.ndpUp = int("ndp") == 1
        s.micOn = int("mic") == 1
        s.wakes = int("w")
        s.labels = int("l")
        s.uptimeS = int("up")
        status = s
    }
}

extension NiclaVoiceGateway: CBCentralManagerDelegate, CBPeripheralDelegate {
    /// iOS relaunched us and is handing back the connection it kept alive.
    /// REQUIRED once CBCentralManagerOptionRestoreIdentifierKey is set: without
    /// this delegate method CoreBluetooth logs a warning and the restored
    /// peripheral is dropped, which would leave the app holding a link it does
    /// not know about — worse than not restoring at all, because the board's
    /// single connection slot is occupied while we sit there re-dialling it.
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]),
              let u = unit,
              let p = restored.first(where: { $0.identifier == u.beaconId })
        else { return }
        self.central = central
        peripheral = p
        p.delegate = self
        wanted = true
        if p.state == .connected {
            // Already live: re-discover rather than assume the characteristic
            // handles survived. didDiscoverCharacteristicsFor is what sets
            // `connected` and starts the heartbeat, so the normal path resumes.
            p.discoverServices([voiceServiceUUID])
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn: connectIfPossible()
        case .poweredOff:
            connected = false
            lastError = "Bluetooth is off — the necklace can't reach your tiny without it."
        case .unauthorized:
            connected = false
            lastError = "Bluetooth permission denied — the necklace needs it to reach your tiny."
        default:
            connected = false
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        lastError = nil
        peripheral.discoverServices([voiceServiceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connected = false
        lastError = error?.localizedDescription ?? "Couldn't connect to the necklace."
        scheduleReconnect() // backoff, not an instant re-dial — see scheduleReconnect()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        connected = false
        beatTask?.cancel()
        beatTask = nil
        statusChar = nil
        // Reset the backoff only for a link that actually LASTED. A link is
        // "good" if it survived long enough to be useful (one heartbeat period),
        // which is the only definition that distinguishes walking out of range
        // from the board dropping us mid-session. Anything shorter keeps the
        // earned delay and keeps doubling, so a board that connects-and-drops
        // gets tried every 32s instead of every second.
        if let since = connectedAt, Date().timeIntervalSince(since) >= Self.goodLinkS {
            reconnectDelay = Self.reconnectBaseS
        }
        connectedAt = nil
        // Out of range is the NORMAL state of a wearable, not an error worth
        // showing — re-arm silently and let presence go stale on its own.
        scheduleReconnect()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == voiceServiceUUID }) else {
            lastError = "That device isn't a tiny necklace."
            return
        }
        peripheral.discoverCharacteristics([voiceWakeUUID, voiceStatusUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for ch in service.characteristics ?? [] {
            switch ch.uuid {
            case voiceWakeUUID:
                peripheral.setNotifyValue(true, for: ch)
            case voiceStatusUUID:
                statusChar = ch
                peripheral.setNotifyValue(true, for: ch)
                peripheral.readValue(for: ch)
            default:
                break
            }
        }
        // Only now is the link USEFUL. Marking connected at didConnect would
        // start heartbeating for a device we might still fail to subscribe to,
        // and presence would claim a wake path that isn't wired up.
        connected = true
        connectedAt = Date()
        // Backoff is NOT reset here. Reaching discovery is not evidence of a
        // working link: the board completes discovery and then drops ~2s later,
        // so resetting on this callback pinned the delay at 1s forever and the
        // phone re-dialled about once a second. Measured from the board's own
        // beacon counters, which count connections without needing one: 61
        // connects / 61 disconnects, longest hold 2s, during a window where this
        // Mac attempted exactly 3. See didDisconnectPeripheral for where the
        // reset moved to.
        startBeating()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        switch characteristic.uuid {
        case voiceWakeUUID: handleWake(characteristic.value)
        case voiceStatusUUID: handleStatus(characteristic.value)
        default: break
        }
    }
}

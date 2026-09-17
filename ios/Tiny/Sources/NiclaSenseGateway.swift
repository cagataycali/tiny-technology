/**
 * NiclaSenseGateway — the phone stands in for the Nicla Sense ME.
 *
 * Same situation as the Voice (NiclaVoiceGateway): an nRF52832, BLE only, no
 * WiFi radio, so nothing it measures can leave the board without a gateway.
 * While this phone holds a BLE link to the board it IS the board's network
 * stack, and performs the device contract with the BOARD's `tind_` token:
 *
 *   1. Presence — POST /api/devices/heartbeat every 30s while linked. No link,
 *      no heartbeat: the fleet shows it offline within 60s, which is the truth.
 *   2. Work — PUT /api/devices/relay every 5s while linked, and PATCH the reply.
 *      The Voice gateway never did this (a wake is a push event, nobody "asks"
 *      a wake word anything). A sensor board is the opposite: `use_device` asks
 *      "what's the temperature" and something has to answer. The board has no
 *      agent, so the answer is its LAST SAMPLE, stamped with its age.
 *
 * Wire contract (firmware/sense/tiny_sense/tiny_sense.ino):
 *   service  74696e79-5f62-6c65-5f70-726f76697331   shared with Vision/Voice
 *   env      74696e79-5f65-6e76-5f72-643031ffffff   JSON every 2s
 *   motion   74696e79-5f6d-6f74-5f72-643031ffffff   JSON at 4Hz while a central is connected
 *   status   74696e79-5f73-7461-745f-72643031ffff   JSON every 5s
 *   beacon   mfg 0xFFFF 'TN' 03 <prov> <fault> <uptime_min>
 *
 * Raw motion is scaled HERE (BHI260 defaults: 4096 LSB/g, 16.4 LSB/dps), same
 * as the Mac gateway (strands-nicla/scripts/sense_gateway.py) — one place to be
 * wrong, and it is a place that ships without a reflash.
 *
 * Identity: the board cannot store a token (no config characteristic — there is
 * nothing it could DO with one), so it is enrolled host-side and this phone
 * ADOPTS the existing fleet row (POST /api/devices/adopt rotates the token onto
 * us). Never enroll it from here: that mints a second row and orphans the first.
 */
import CoreBluetooth
import Foundation

private nonisolated(unsafe) let senseServiceUUID = CBUUID(string: "74696e79-5f62-6c65-5f70-726f76697331")
private nonisolated(unsafe) let senseEnvUUID = CBUUID(string: "74696e79-5f65-6e76-5f72-643031ffffff")
private nonisolated(unsafe) let senseMotionUUID = CBUUID(string: "74696e79-5f6d-6f74-5f72-643031ffffff")
private nonisolated(unsafe) let senseStatusUUID = CBUUID(string: "74696e79-5f73-7461-745f-72643031ffff")

/// The board's environment sample. Keys on the wire are short (the whole
/// object rides one notification); names here are for readers.
struct SenseEnv: Equatable {
    var tempC = 0.0
    var humidityPct = 0.0
    var pressureHpa = 0.0
    var gasOhm = 0
    var iaq = 0
    var co2Eq = 0
    var bvocEq = 0.0
    /// BSEC calibration state 0…3. Below 3 the IAQ/CO2eq/VOC numbers are the
    /// algorithm's placeholders (25 / 500 / 0.49), not measurements.
    var bsecAccuracy = 0
    var batteryPct = 0
    var at = Date()

    var calibrated: Bool { bsecAccuracy >= 3 }
}

/// One motion sample, already scaled to g and °/s.
struct SenseMotion: Equatable {
    var accelG: SIMD3<Double> = .zero
    var gyroDps: SIMD3<Double> = .zero
    var steps = 0
    var at = Date()

    /// Magnitude of acceleration — 1.0 at rest, anywhere else while moving.
    var accelMagnitude: Double { (accelG * accelG).sum().squareRoot() }
    var gyroMagnitude: Double { (gyroDps * gyroDps).sum().squareRoot() }
}

struct SenseStatus: Equatable {
    var fw = ""
    var uptimeS = 0
    var samples = 0
    var connects = 0
    var fault = 0
    var vbat = 0.0
}

/// Pure motion judgement, kept out of the class so a test can drive it with
/// numbers. "Moving" is any of: rotating faster than a slow wrist turn, or
/// acceleration magnitude off 1g by more than sensor noise. Held for a short
/// window so a badge does not flicker between 4Hz samples.
enum SenseMotionRule {
    static let gyroThresholdDps = 8.0
    static let accelDeviationG = 0.08
    static let holdSeconds: TimeInterval = 1.5

    static func isMoving(_ m: SenseMotion) -> Bool {
        m.gyroMagnitude > gyroThresholdDps || abs(m.accelMagnitude - 1.0) > accelDeviationG
    }
}

final class NiclaSenseGateway: NSObject, ObservableObject, @unchecked Sendable {
    static let shared = NiclaSenseGateway()

    struct Unit: Equatable {
        let deviceId: String
        let beaconId: UUID
        var name: String
    }

    @Published private(set) var unit: Unit?
    @Published private(set) var connected = false
    @Published private(set) var rssi: Int?
    @Published private(set) var env: SenseEnv?
    @Published private(set) var motion: SenseMotion?
    @Published private(set) var status: SenseStatus?
    /// The UI's one-word answer: is the board being moved RIGHT NOW. Sticky
    /// for `SenseMotionRule.holdSeconds` after the last moving sample.
    @Published private(set) var moving = false
    @Published private(set) var lastMovedAt: Date?
    @Published private(set) var lastError: String?
    /// Envelopes answered on the board's behalf this session — a small receipt
    /// that the relay path is alive, since nothing else on this screen proves it.
    @Published private(set) var answered = 0

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var beatTask: Task<Void, Never>?
    private var relayTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var motionHoldTask: Task<Void, Never>?
    private var rssiTask: Task<Void, Never>?
    private var reconnectDelay: TimeInterval = 1
    private var connectedAt: Date?
    private var wanted = false

    private static let unitKey = "nicla_sense_unit"
    private static let beatSeconds: UInt64 = 30
    private static let relaySeconds: UInt64 = 5
    static let capabilities = ["env", "temp", "humidity", "pressure", "gas", "iaq", "imu", "battery", "ble"]
    private static let reconnectBaseS: TimeInterval = 1
    private static let reconnectMaxS: TimeInterval = 32
    private static let goodLinkS: TimeInterval = 30
    static let accLsbPerG = 4096.0
    static let gyroLsbPerDps = 16.4

    override private init() {
        super.init()
        if let d = UserDefaults.standard.dictionary(forKey: Self.unitKey),
           let deviceId = d["deviceId"] as? String,
           let beaconRaw = d["beaconId"] as? String,
           let beaconId = UUID(uuidString: beaconRaw) {
            unit = Unit(deviceId: deviceId, beaconId: beaconId, name: d["name"] as? String ?? "tiny sense")
        }
    }

    // MARK: - Registration

    func register(deviceId: String, token: String, beaconId: UUID, name: String) {
        Keychain.set(Self.tokenKey(deviceId), token)
        UserDefaults.standard.set(
            ["deviceId": deviceId, "beaconId": beaconId.uuidString, "name": name],
            forKey: Self.unitKey)
        unit = Unit(deviceId: deviceId, beaconId: beaconId, name: name)
        start()
    }

    /// Forget locally only. Revoking is the Devices panel's swipe action.
    func forget() {
        if let u = unit { Keychain.delete(Self.tokenKey(u.deviceId)) }
        UserDefaults.standard.removeObject(forKey: Self.unitKey)
        stop()
        unit = nil
        env = nil
        motion = nil
        status = nil
        moving = false
    }

    private static func tokenKey(_ deviceId: String) -> String { "nicla_sense_token_\(deviceId)" }
    private var token: String? { unit.flatMap { Keychain.get(Self.tokenKey($0.deviceId)) } }

    /// Adopt the fleet row that matches this beacon and start relaying it.
    ///
    /// The board was enrolled elsewhere (a Mac, `scripts/sense_gateway.py`),
    /// under the SAME name it advertises — the enroll doc's rule, and what
    /// makes this lookup possible without the board carrying an id. Adoption
    /// rotates the token: the previous gateway's next heartbeat 401s, which is
    /// the handover, not a side effect.
    @MainActor
    func adopt(beacon: BleDevice, sessionToken: String?) async -> String? {
        guard let sessionToken else { return "Sign in first — adopting needs your tiny account." }
        let rows: [String: Any]
        do {
            rows = try await Api.get("/api/devices", token: sessionToken)
        } catch {
            return "Couldn't read your devices: \(error.localizedDescription)"
        }
        let list = (rows["devices"] as? [[String: Any]]) ?? []
        guard let row = list.first(where: {
            ($0["platform"] as? String) == "nicla-sense" && ($0["name"] as? String) == beacon.name
        }), let deviceId = row["id"] as? String else {
            return "No fleet row named “\(beacon.name)” with platform nicla-sense. Enroll it from a computer first (strands-nicla/NICLA_SENSE.md) — enrolling from the phone would mint a duplicate."
        }
        let r: [String: Any]
        do {
            r = try await Api.post("/api/devices/adopt", token: sessionToken, body: ["deviceId": deviceId])
        } catch {
            return AdoptFailure.classify(error).message
        }
        guard let tok = r["device_token"] as? String, !tok.isEmpty else {
            return AdoptFailure.keyNotDelivered.message
        }
        register(deviceId: deviceId, token: tok, beaconId: beacon.id, name: beacon.name)
        return nil
    }

    // MARK: - Link lifecycle

    func start() {
        guard unit != nil else { return }
        wanted = true
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectDelay = Self.reconnectBaseS
        if central == nil {
            central = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionRestoreIdentifierKey: "technology.tiny.nicla.sense",
            ])
        } else {
            connectIfPossible()
        }
    }

    func stop() {
        wanted = false
        for t in [beatTask, relayTask, reconnectTask, motionHoldTask, rssiTask] { t?.cancel() }
        beatTask = nil; relayTask = nil; reconnectTask = nil; motionHoldTask = nil; rssiTask = nil
        reconnectDelay = Self.reconnectBaseS
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil
        connected = false
        connectedAt = nil
        moving = false
    }

    fileprivate func connectIfPossible() {
        guard wanted, let c = central, c.state == .poweredOn, let u = unit else { return }
        guard let p = c.retrievePeripherals(withIdentifiers: [u.beaconId]).first else {
            lastError = "Bring the board nearby and open Nearby devices once."
            return
        }
        peripheral = p
        p.delegate = self
        c.connect(p)
    }

    /// Backoff re-dial — the board is `cordio.max-connections: 1`; an instant
    /// re-dial turns its only slot into a spin lock (measured on the Voice).
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

    // MARK: - Proxy presence + relay

    private func startProxying() {
        beatTask?.cancel()
        beatTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.beat()
                try? await Task.sleep(for: .seconds(Double(Self.beatSeconds)))
            }
        }
        relayTask?.cancel()
        relayTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollRelay()
                try? await Task.sleep(for: .seconds(Double(Self.relaySeconds)))
            }
        }
        rssiTask?.cancel()
        rssiTask = Task { [weak self] in
            while !Task.isCancelled {
                await MainActor.run { self?.peripheral?.readRSSI() }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func stopProxying() {
        beatTask?.cancel(); beatTask = nil
        relayTask?.cancel(); relayTask = nil
        rssiTask?.cancel(); rssiTask = nil
    }

    private func beat() async {
        guard connected, let u = unit, let tok = token else { return }
        let res = try? await Api.postRaw("/api/devices/heartbeat", body: [
            "deviceId": u.deviceId, "token": tok, "capabilities": Self.capabilities])
        if let res, res["ok"] as? Bool == false {
            let why = (res["error"] as? String) ?? "heartbeat rejected"
            lastError = why.contains("unknown device")
                ? "This board was revoked or adopted elsewhere — adopt it again."
                : why
        }
    }

    private func pollRelay() async {
        guard connected, let u = unit, let tok = token else { return }
        guard let r = try? await Api.putJson("/api/devices/relay", body: [
            "deviceId": u.deviceId, "token": tok, "max": 5]) else { return }
        for msg in (r["messages"] as? [[String: Any]]) ?? [] {
            guard let id = msg["id"] as? String else { continue }
            let reply = SenseReply.text(env: env, motion: motion, status: status,
                                        moving: moving, rssi: rssi, connected: connected, name: u.name)
            let payload: [String: Any] = ["result": reply]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let str = String(data: data, encoding: .utf8) else { continue }
            _ = try? await Api.patchJson("/api/devices/relay", body: [
                "deviceId": u.deviceId, "token": tok, "inReplyTo": id, "payload": str])
            answered += 1
        }
    }

    // MARK: - Samples

    private static func json(_ data: Data?) -> [String: Any]? {
        guard let d = data, !d.isEmpty else { return nil }
        return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
    }

    fileprivate func handleEnv(_ data: Data?) {
        guard let o = Self.json(data) else { return }
        let dbl = { (k: String) in (o[k] as? NSNumber)?.doubleValue ?? 0 }
        let int = { (k: String) in (o[k] as? NSNumber)?.intValue ?? 0 }
        env = SenseEnv(tempC: dbl("t"), humidityPct: dbl("h"), pressureHpa: dbl("p"),
                       gasOhm: int("g"), iaq: int("iaq"), co2Eq: int("co2"), bvocEq: dbl("voc"),
                       bsecAccuracy: int("acc"), batteryPct: int("bat"), at: Date())
    }

    fileprivate func handleMotion(_ data: Data?) {
        guard let o = Self.json(data) else { return }
        let dbl = { (k: String) in (o[k] as? NSNumber)?.doubleValue ?? 0 }
        let m = SenseMotion(
            accelG: SIMD3(dbl("ax"), dbl("ay"), dbl("az")) / Self.accLsbPerG,
            gyroDps: SIMD3(dbl("gx"), dbl("gy"), dbl("gz")) / Self.gyroLsbPerDps,
            steps: (o["st"] as? NSNumber)?.intValue ?? 0, at: Date())
        motion = m
        if SenseMotionRule.isMoving(m) {
            lastMovedAt = m.at
            if !moving {
                moving = true
                Task { @MainActor in Haptic.shared.play(pattern: "tap", times: 1, intensity: 0.3) }
            }
            motionHoldTask?.cancel()
            motionHoldTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(SenseMotionRule.holdSeconds))
                guard !Task.isCancelled else { return }
                await MainActor.run { self?.moving = false }
            }
        }
    }

    fileprivate func handleStatus(_ data: Data?) {
        guard let o = Self.json(data) else { return }
        let int = { (k: String) in (o[k] as? NSNumber)?.intValue ?? 0 }
        status = SenseStatus(fw: o["fw"] as? String ?? "", uptimeS: int("up"), samples: int("n"),
                             connects: int("c"), fault: int("f"),
                             vbat: (o["vbat"] as? NSNumber)?.doubleValue ?? 0)
    }
}

/// The reply a relay envelope gets. Pure so a test can pin the wording. Only
/// `result` is rendered by `use_device`, so the numbers live in the sentence.
enum SenseReply {
    static func text(env: SenseEnv?, motion: SenseMotion?, status: SenseStatus?,
                     moving: Bool, rssi: Int?, connected: Bool, name: String) -> String {
        var parts: [String] = []
        if let e = env {
            let age = Int(Date().timeIntervalSince(e.at))
            parts.append(String(format: "%.1f C, %.0f%% RH, %.1f hPa, gas %d ohm, IAQ %d (CO2eq %d ppm, bVOC %.2f ppm, BSEC accuracy %d/3), sample %ds old",
                                e.tempC, e.humidityPct, e.pressureHpa, e.gasOhm, e.iaq, e.co2Eq, e.bvocEq, e.bsecAccuracy, age))
            if !e.calibrated {
                parts.append("BSEC still calibrating: IAQ/CO2eq/VOC are placeholders until accuracy reaches 3; temp reads high on USB power")
            }
        }
        if let m = motion {
            parts.append(String(format: "accel [%+.2f, %+.2f, %+.2f] g (|a| %.2f), gyro [%+.1f, %+.1f, %+.1f] dps, %@, steps %d",
                                m.accelG.x, m.accelG.y, m.accelG.z, m.accelMagnitude,
                                m.gyroDps.x, m.gyroDps.y, m.gyroDps.z, moving ? "MOVING" : "still", m.steps))
        }
        if let e = env, let s = status { parts.append(String(format: "battery %d%% (%.2f V)", e.batteryPct, s.vbat)) }
        parts.append("BLE link \(connected ? "up" : "DOWN") via iPhone gateway, rssi \(rssi.map(String.init) ?? "?")" +
                     (status.map { "; fw \($0.fw), board uptime \($0.uptimeS) s, fault \($0.fault)" } ?? ""))
        if env == nil && motion == nil { parts.append("no sample received yet") }
        return "\(name) (Nicla Sense ME): " + parts.joined(separator: " | ")
    }
}

extension NiclaSenseGateway: CBCentralManagerDelegate, CBPeripheralDelegate {
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]),
              let u = unit,
              let p = restored.first(where: { $0.identifier == u.beaconId })
        else { return }
        self.central = central
        peripheral = p
        p.delegate = self
        wanted = true
        if p.state == .connected { p.discoverServices([senseServiceUUID]) }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn: connectIfPossible()
        case .poweredOff:
            connected = false
            lastError = "Bluetooth is off — the board can't reach your tiny without it."
        case .unauthorized:
            connected = false
            lastError = "Bluetooth permission denied — the board needs it to reach your tiny."
        default:
            connected = false
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        lastError = nil
        peripheral.discoverServices([senseServiceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connected = false
        lastError = error?.localizedDescription ?? "Couldn't connect to the board."
        scheduleReconnect()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        connected = false
        moving = false
        stopProxying()
        if let since = connectedAt, Date().timeIntervalSince(since) >= Self.goodLinkS {
            reconnectDelay = Self.reconnectBaseS
        }
        connectedAt = nil
        scheduleReconnect()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == senseServiceUUID }) else {
            lastError = "That device isn't a tiny board."
            return
        }
        peripheral.discoverCharacteristics([senseEnvUUID, senseMotionUUID, senseStatusUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for ch in service.characteristics ?? [] {
            switch ch.uuid {
            case senseEnvUUID, senseMotionUUID, senseStatusUUID:
                peripheral.setNotifyValue(true, for: ch)
                peripheral.readValue(for: ch)   // prime: env/status only refresh every 2/5 s
            default:
                break
            }
        }
        connected = true
        connectedAt = Date()
        startProxying()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        switch characteristic.uuid {
        case senseEnvUUID: handleEnv(characteristic.value)
        case senseMotionUUID: handleMotion(characteristic.value)
        case senseStatusUUID: handleStatus(characteristic.value)
        default: break
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        if error == nil { rssi = RSSI.intValue }
    }
}

/**
 * Bluetooth — the phone's eyes on nearby devices (fleet expansion: the web
 * agent can ask this phone what's around it).
 *
 * CBCentralManager BLE scan, two consumers:
 *   - NearbyView (menu → "Nearby devices"): live list with signal strength
 *   - Relay invokes mentioning bluetooth/nearby: scanSummary() text is
 *     appended to the prompt proxied through /api/chat, so the server agent
 *     answers with REAL radio data the server itself could never see.
 *
 * Lazy CBCentralManager: the permission prompt appears on first use, not
 * at launch. Foreground-only (background BLE needs the bluetooth-central
 * mode + different scan semantics — not this pass).
 */
import CoreBluetooth

/// A tiny hardware beacon (e.g. the Nicla Vision necklace) recognized from
/// manufacturer data: 0xFFFF · 'TN' · version · provisioned flag — the
/// counterpart of firmware tiny_ble.adv_payload in strands-nicla.
struct TinyBeaconInfo: Equatable {
    let version: Int
    let provisioned: Bool

    /// Which board is advertising. The version byte doubles as a device-type
    /// marker so Nearby can tell a Vision from a Voice WITHOUT connecting —
    /// which matters because the two need different setup (the Voice has no
    /// WiFi, so asking for an SSID would be asking for something it cannot use).
    enum Kind: Equatable {
        case vision   // version 1 — firmware/tiny_ble.py
        case voice    // version 2 — firmware/voice/tiny_voice
        case sense    // version 3 — firmware/sense/tiny_sense (Nicla Sense ME)
        case unknown
    }

    var kind: Kind {
        switch version {
        case 1: return .vision
        case 2: return .voice
        case 3: return .sense
        default: return .unknown
        }
    }

    /// The platform string this board enrolls as. Keep in sync with the web
    /// side's per-platform tool rosters.
    var platform: String {
        switch kind {
        case .vision: return "nicla-vision"
        case .voice: return "nicla-voice"
        case .sense: return "nicla-sense"
        case .unknown: return "nicla-vision"
        }
    }

    /// Parse CBAdvertisementDataManufacturerDataKey bytes; nil if not a tiny.
    ///
    /// CoreBluetooth hands over the company id as the first two bytes, so this
    /// sees the full 0xFFFF · 'TN' · version · provisioned layout. (Worth
    /// knowing when cross-checking against a Python/bleak scan, which strips
    /// the company id into a dictionary key and so reports only four bytes —
    /// the same packet, a shorter-looking payload.)
    static func parse(_ mfg: Data?) -> TinyBeaconInfo? {
        guard let d = mfg, d.count >= 6,
              d[0] == 0xFF, d[1] == 0xFF,              // test/dev company id (LE)
              d[2] == 0x54, d[3] == 0x4E               // 'T' 'N'
        else { return nil }
        return TinyBeaconInfo(version: Int(d[4]), provisioned: d[5] != 0)
    }
}

struct BleDevice: Identifiable, Equatable {
    let id: UUID
    let name: String
    var rssi: Int
    var tiny: TinyBeaconInfo?
}

@MainActor
final class Bluetooth: NSObject, ObservableObject {
    static let shared = Bluetooth()

    @Published var devices: [BleDevice] = []
    @Published var scanning = false
    /// idle | poweredOn | poweredOff | unauthorized | unsupported
    @Published var state = "idle"

    /// True once a scan has actually run to completion, so an empty list can
    /// tell "nothing is out there" apart from "nothing has looked yet". Those
    /// are different claims and only one of them is ever true.
    @Published private(set) var completedScan = false

    private var central: CBCentralManager?
    private var stopTask: Task<Void, Never>?
    /// Somebody WANTS a scan — kept apart from `scanning`, which means one is
    /// really running. They diverge precisely when the radio isn't available,
    /// and conflating them is how the panel came to say "No devices found yet."
    /// about a scan that never happened: with Bluetooth off, the first
    /// `startScan` was stood down by the delegate, and turning Bluetooth ON
    /// afterwards found nothing left asking, so no scan started — while the
    /// list, seeing `scanning == false` and no error state, reported a
    /// confident empty answer.
    private var wanted = false
    private var window: TimeInterval = 8

    override private init() { super.init() }

    func startScan(duration: TimeInterval = 8) {
        devices = []
        completedScan = false
        wanted = true
        window = duration
        stopTask?.cancel()
        if central == nil {
            // First use — instantiating triggers the permission prompt, whose
            // verdict arrives asynchronously. Claim the scan for now; the
            // delegate corrects it either way, in every branch.
            scanning = true
            central = CBCentralManager(delegate: self, queue: .main)
        } else {
            // Second use onward there is no prompt, and an UNCHANGED radio
            // state produces no delegate callback to correct an optimistic
            // `true` — so a switched-off adapter has to be read here, or the
            // list spins for the full window over a radio doing nothing.
            scanning = false
            beginIfPowered()
        }
    }

    func stopScan() {
        // A scan that was running and is now stopped has, in fact, looked.
        if scanning { completedScan = true }
        wanted = false
        stopTask?.cancel()
        central?.stopScan()
        scanning = false
    }

    /// The one place a scan really begins — and therefore the only place that
    /// may set `scanning` or arm the auto-stop. Reached both from `startScan`
    /// and from the delegate when the user turns Bluetooth on after the fact.
    fileprivate func beginIfPowered() {
        guard let c = central,
              BleScanGate.shouldScan(wanted: wanted, poweredOn: c.state == .poweredOn)
        else { return }
        c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        scanning = true
        stopTask?.cancel()
        stopTask = Task { [window] in
            try? await Task.sleep(for: .seconds(window))
            if !Task.isCancelled { Bluetooth.shared.stopScan() }
        }
    }

    /// One-shot scan → text block for relay answers (strongest signal first).
    /// Piggybacks on a scan already running (NearbyView open) instead of
    /// resetting the device list out from under it.
    func scanSummary(duration: TimeInterval = 6) async -> String {
        if !scanning { startScan(duration: duration) }
        try? await Task.sleep(for: .seconds(duration + 0.5))
        let found = devices.sorted { $0.rssi > $1.rssi }
        if found.isEmpty {
            // ⚠️ This string is appended to the prompt and comes back out of the
            // model's mouth as a fact about the user's room, so the obstacle goes
            // FIRST: "no BLE devices" is reserved for a scan that really looked.
            // The three cases this used to miss — no radio at all, a verdict
            // still in flight, and a scan the radio never let start — all read as
            // a confidently empty room.
            return BleEmptyState.obstacle(scanning: scanning, state: state,
                                          completedScan: completedScan)
                ?? "No BLE devices discovered nearby."
        }
        return found.prefix(25)
            .map { "- \($0.name) · RSSI \($0.rssi) dBm" }
            .joined(separator: "\n")
    }
}

extension Bluetooth: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let st = central.state
        Task { @MainActor in
            let b = Bluetooth.shared
            switch st {
            case .poweredOn:
                b.state = "poweredOn"
                // Resume on `wanted`, NOT on `scanning`. When Bluetooth was off
                // as the panel opened, `scanning` is already false by the time
                // this fires, so gating on it meant the user's fix — flipping
                // Bluetooth on — started nothing at all.
                b.beginIfPowered()
            case .poweredOff: b.state = "poweredOff"; b.scanning = false
            case .unauthorized: b.state = "unauthorized"; b.scanning = false
            case .unsupported: b.state = "unsupported"; b.scanning = false
            default: b.state = "idle"
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        // Extract Sendables before hopping — advertisementData is not Sendable
        let id = peripheral.identifier
        let name = BleName.pick(
            advertised: advertisementData[CBAdvertisementDataLocalNameKey] as? String,
            cached: peripheral.name)
        let rssi = RSSI.intValue
        let tiny = TinyBeaconInfo.parse(advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data)
        Task { @MainActor in
            let b = Bluetooth.shared
            if let i = b.devices.firstIndex(where: { $0.id == id }) {
                b.devices[i].rssi = rssi
                if tiny != nil { b.devices[i].tiny = tiny }
            } else {
                b.devices.append(BleDevice(id: id, name: name, rssi: rssi, tiny: tiny))
            }
        }
    }
}

/// Which of a peripheral's two names to show.
///
/// ⚠️ They are two different names and CoreBluetooth prefers the wrong one.
/// `CBPeripheral.name` is the CACHED GAP device name: it can be older than the
/// packet in hand, and it survives the board being renamed or reflashed. The
/// advertised local name arrives in the packet being handled right now.
///
/// Measured on air 2026-08-04, three identical necklaces on one build:
///
///     cbname='tiny-d82b'   advname='tiny-d82b'
///     cbname='MPY NIMBLE'  advname='tiny-b3d3'    <- the provisioned one
///     cbname='tiny-ae1d'   advname='tiny-ae1d'
///
/// Only the board a central had ever CONNECTED to was wrong, because connecting
/// is what fills the cache — so the necklace an owner had already set up, and is
/// therefore most likely to go looking for by name, is the one that showed up as
/// NimBLE's factory default. The firmware now sets its GAP name to match
/// (strands-nicla `tiny_ble.start`), but a phone holding the old cache would keep
/// showing it, so both halves are needed. FlipperGateway already reads them in
/// this order.
enum BleName {
    static func pick(advertised: String?, cached: String?) -> String {
        for candidate in [advertised, cached] {
            if let s = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
               !s.isEmpty { return s }
        }
        return "Unnamed device"
    }
}

/// Whether a BLE scan should be running right now.
///
/// Two inputs, and the bug was reading the wrong one. `wanted` is a standing
/// request from a view; `poweredOn` is the radio. The old code resumed on
/// `scanning` — a RESULT, not a request — which is already false by the time a
/// powered-off radio comes back, so the user's own fix (turning Bluetooth on)
/// started nothing at all. Pure and named so the distinction can't be quietly
/// collapsed again: neither input alone is sufficient.
enum BleScanGate {
    static func shouldScan(wanted: Bool, poweredOn: Bool) -> Bool { wanted && poweredOn }
}

/// Signal strength as something a person can act on.
///
/// RSSI in dBm is engineering detail — nobody decides where to stand based on
/// "-63". Bars answer the only question a pairing card actually raises: is this
/// close enough, and would moving closer help? The thresholds are the ones the
/// nearby list already coloured its dots by, kept in one place so two surfaces
/// can't come to different conclusions about one radio.
enum BleSignal {
    static let maxBars = 3

    static func bars(rssi: Int) -> Int {
        if rssi > -55 { return 3 }
        if rssi > -75 { return 2 }
        return 1
    }

    /// The same reading in words, for VoiceOver — where bars are invisible.
    static func label(rssi: Int) -> String {
        let b = bars(rssi: rssi)
        if b == 3 { return "very close" }
        if b == 2 { return "nearby" }
        return "far — move closer"
    }
}

/// What a nearby list may SAY while it has no rows.
///
/// Five different situations used to share one line of screen, and the view
/// picked between them with `scanning` first — so an unavailable radio read as
/// "Scanning…" for the whole window, and a scan that had never run read as the
/// flat, confident "No devices found yet.". Pure and separate so each claim can
/// be pinned to the exact condition that earns it.
///
/// ⚠️ FOUR surfaces ask this question and only one of them used to ask HERE.
/// `NearbyView` kept its own ternary — `scanning` first, no `unsupported` arm,
/// no `completedScan`, i.e. the original bug preserved intact. `scanSummary`
/// answered the AGENT with "No BLE devices discovered nearby.", a sentence the
/// model repeats to the user as fact. `adopt()` told someone to go carry a
/// necklace closer to a phone that had never looked for it. One question, four
/// answers, three of them written against a radio state nobody had checked.
///
/// `situation` is the single decision now, and the radio-state STRINGS live in
/// it and nowhere else. What a surface may still vary is the WORDS.
enum BleEmptyState {
    /// What is true about the search — the only thing a caller may branch on.
    enum Situation: Equatable {
        case noPermission, radioOff, noRadio, looking, lookedAndFoundNothing, neverLooked
    }

    static func situation(scanning: Bool, state: String, completedScan: Bool) -> Situation {
        // Radio trouble outranks everything: it is both the true answer and the
        // only one the user can act on.
        switch state {
        case "unauthorized": return .noPermission
        case "poweredOff": return .radioOff
        case "unsupported": return .noRadio
        default: break
        }
        if scanning { return .looking }
        // Only a finished scan has earned the right to say nothing is there.
        return completedScan ? .lookedAndFoundNothing : .neverLooked
    }

    /// The caption under an empty list.
    static func message(scanning: Bool, state: String, completedScan: Bool) -> String {
        switch situation(scanning: scanning, state: state, completedScan: completedScan) {
        case .noPermission:
            return "Bluetooth permission denied — enable it for tiny in Settings."
        case .radioOff:
            return "Bluetooth is off. Turn it on and this list fills in by itself."
        case .noRadio:
            return "This device has no Bluetooth radio."
        case .looking:
            return "Looking for devices nearby…"
        case .lookedAndFoundNothing:
            return "Nothing nearby yet. Wake the device and scan again."
        case .neverLooked:
            return "Ready to scan."
        }
    }

    /// Why the phone could not answer what is nearby — or **nil when it really
    /// did look**, in which case the answer is genuinely "nothing" and the caller
    /// says so in its own words.
    ///
    /// That one case is the only sentence a surface still owns, because a
    /// transcript and an instruction are different things: the agent reports
    /// ("No BLE devices discovered nearby."), the adoption sheet asks for
    /// something ("Bring it closer…"). Written as `obstacle(…) ?? <sentence>`,
    /// the check sits in front of the claim — so a surface can no longer assert
    /// an empty room by forgetting to ask.
    static func obstacle(scanning: Bool, state: String, completedScan: Bool) -> String? {
        switch situation(scanning: scanning, state: state, completedScan: completedScan) {
        case .noPermission:
            return "Bluetooth permission is denied for tiny on this phone."
        case .radioOff:
            return "Bluetooth is turned off on this phone."
        case .noRadio:
            return "This phone has no Bluetooth radio."
        case .looking:
            return "The phone is still scanning — ask again in a moment."
        case .neverLooked:
            return "The phone hasn't scanned yet, so nothing is known about what's nearby."
        case .lookedAndFoundNothing:
            return nil
        }
    }
}

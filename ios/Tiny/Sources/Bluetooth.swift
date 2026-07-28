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

struct BleDevice: Identifiable, Equatable {
    let id: UUID
    let name: String
    var rssi: Int
}

@MainActor
final class Bluetooth: NSObject, ObservableObject {
    static let shared = Bluetooth()

    @Published var devices: [BleDevice] = []
    @Published var scanning = false
    /// idle | poweredOn | poweredOff | unauthorized | unsupported
    @Published var state = "idle"

    private var central: CBCentralManager?
    private var stopTask: Task<Void, Never>?

    override private init() { super.init() }

    func startScan(duration: TimeInterval = 8) {
        devices = []
        scanning = true
        if central == nil {
            // First use — instantiating triggers the permission prompt;
            // scanning begins in centralManagerDidUpdateState once powered on
            central = CBCentralManager(delegate: self, queue: .main)
        } else {
            beginIfPowered()
        }
        stopTask?.cancel()
        stopTask = Task {
            try? await Task.sleep(for: .seconds(duration))
            if !Task.isCancelled { stopScan() }
        }
    }

    func stopScan() {
        central?.stopScan()
        scanning = false
    }

    fileprivate func beginIfPowered() {
        guard let c = central, c.state == .poweredOn else { return }
        c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    /// One-shot scan → text block for relay answers (strongest signal first).
    /// Piggybacks on a scan already running (NearbyView open) instead of
    /// resetting the device list out from under it.
    func scanSummary(duration: TimeInterval = 6) async -> String {
        if !scanning { startScan(duration: duration) }
        try? await Task.sleep(for: .seconds(duration + 0.5))
        let found = devices.sorted { $0.rssi > $1.rssi }
        if found.isEmpty {
            return state == "unauthorized" ? "Bluetooth permission denied on the phone."
                 : state == "poweredOff" ? "Bluetooth is turned off on the phone."
                 : "No BLE devices discovered nearby."
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
                if b.scanning { b.beginIfPowered() }
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
        let name = peripheral.name
            ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? "Unnamed device"
        let rssi = RSSI.intValue
        Task { @MainActor in
            let b = Bluetooth.shared
            if let i = b.devices.firstIndex(where: { $0.id == id }) {
                b.devices[i].rssi = rssi
            } else {
                b.devices.append(BleDevice(id: id, name: name, rssi: rssi))
            }
        }
    }
}

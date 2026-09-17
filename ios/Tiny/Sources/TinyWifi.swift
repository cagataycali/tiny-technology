/**
 * TinyWifi — change a necklace's WiFi over Bluetooth, without re-enrolling it.
 *
 * Until now the app had exactly one way to put a board on a different network:
 * `TinySetupView`, which enrolls first. `POST /api/devices` mints the board's
 * token and returns it ONCE (see TinySetup.swift's header), so "the WiFi here
 * changed" cost an orphaned device row every single time — a row that "can never
 * be provisioned, only revoked". Moving a necklace between a home network, an
 * office and a phone hotspot is the ordinary case, not the exotic one, so it
 * needed a path that touches the registry not at all.
 *
 * That path is the same GATT characteristic provisioning already uses
 * (strands-nicla `firmware/tiny_ble.py`), with a `cmd` in the payload:
 *
 *   {"cmd":"status"}                    → what it is joined to right now
 *   {"cmd":"scan"}                      → what the BOARD's radio can see
 *   {"cmd":"join","ssid":…[,"key":…]}   → put one network first, then apply
 *   {"cmd":"forget","ssid":…}           → drop one, then apply
 *   {"cmd":"wifi","networks":[…]}       → replace the whole list, then apply
 *   {"cmd":"reboot"}                    → hard reset
 *
 * Three properties of that wire drive nearly every decision in this file:
 *
 *  1. ⚠️ **A reply that does not echo `cmd` means the firmware is OLDER than this
 *     feature — and that the board is rebooting.** `cmd` is not in the firmware's
 *     config allowlist, so an old board reads `{"cmd":"status"}` as an empty
 *     provisioning payload, answers `{"ok":true,"complete":true}` and RESETS.
 *     A bare `ok` therefore cannot be read as success: asking the question was
 *     enough to restart the necklace, and the sheet has to say so. See
 *     `TinyWifiFrame.legacyAck`.
 *  2. **Replies are chunked and newline-terminated.** A notification carries
 *     MTU-3 bytes and NimBLE drops the rest silently, so a scan list arrives in
 *     pieces; `TinyWifiInbox` is the reassembler, and the newline is the only
 *     boundary either side has.
 *  3. **The board echoes our own writes back on some hardware.** ArduinoBLE
 *     notifies subscribers on a central write too (see TinySetup's ECHO GUARD,
 *     found with a healthy board on the desk). Nothing here acts on a frame that
 *     does not carry `ok`.
 *
 * A Nicla **Voice** never reaches this sheet: nRF52832, no WiFi radio at all. It
 * has no network to change, and offering it one would be a control that cannot
 * do anything — `TinyBeaconSheet.tapped` routes it to identity setup instead.
 *
 * Everything above the CoreBluetooth class is pure and nonisolated so TinyTests
 * can pin the wire format, the reassembly and every sentence this sheet can
 * show, without a radio or a MainActor hop.
 */
import CoreBluetooth
import SwiftUI

// File-scope for the same reason TinySetup's are: the delegate callbacks that
// filter on these run off the main actor, and CBUUID is immutable but not
// annotated Sendable.
private nonisolated(unsafe) let wifiServiceUUID = CBUUID(string: "74696e79-5f62-6c65-5f70-726f76697331")
private nonisolated(unsafe) let wifiConfigUUID = CBUUID(string: "74696e79-5f63-6667-5f77-726974653031")

// MARK: - Requests

/// One control request: the bytes, the command they will be answered with, and
/// how long that answer is worth waiting for.
///
/// `cmd` travels beside the frame because it is the CORRELATION key — the board
/// answers with it, and a reply that names a different command belongs to an
/// earlier request whose watchdog already fired.
struct TinyWifiRequest: Equatable, Sendable {
    let cmd: String
    let frame: Data
    let patience: TimeInterval

    /// Config edits are answered from the firmware's GATT interrupt (flash only,
    /// no radio), so they come back promptly even while the board is mid-sweep.
    static let quick: TimeInterval = 10
    /// A scan is the one command the board defers to its own loop, because it has
    /// to drive the WiFi module: the loop may be parked inside an HTTPS POST, and
    /// the scan itself takes seconds.
    static let radioPatience: TimeInterval = 25

    private init(_ cmd: String, _ body: [String: Any], patience: TimeInterval = TinyWifiRequest.quick) {
        var obj = body
        obj["cmd"] = cmd
        self.cmd = cmd
        self.patience = patience
        // Sorted keys so a test can pin the exact bytes; the board does not care.
        var data = (try? JSONSerialization.data(withJSONObject: obj,
                                                options: [.sortedKeys])) ?? Data()
        data.append(0x0A)   // the firmware's frame terminator, in both directions
        self.frame = data
    }

    static func status() -> TinyWifiRequest { .init("status", [:]) }

    static func scan() -> TinyWifiRequest { .init("scan", [:], patience: radioPatience) }

    static func reboot() -> TinyWifiRequest { .init("reboot", [:]) }

    /// Switch to one network. A nil `key` means "use the password you already
    /// have": the board keeps it, and the phone may genuinely not know it.
    /// An empty string is a REAL key — an open network — not an absent one.
    static func join(ssid: String, key: String? = nil) -> TinyWifiRequest {
        var body: [String: Any] = ["ssid": ssid]
        if let key { body["key"] = key }
        return .init("join", body)
    }

    static func forget(ssid: String) -> TinyWifiRequest { .init("forget", ["ssid": ssid]) }

    /// Replace the board's whole list with the phone's, in the phone's order.
    /// The wire shape is `WifiNetworks.wire`, not a second encoder here: one
    /// owner of "what a network looks like on the air".
    static func push(_ nets: [WifiNetwork]) -> TinyWifiRequest {
        .init("wifi", ["networks": WifiNetworks.wire(nets)])
    }
}

// MARK: - Who may be dialled

/// Which advertisement this sheet is allowed to treat as a WiFi-capable board.
///
/// The scan that feeds `onAir` is unfiltered (see `startScan`), so this is the
/// only thing standing between the rescue path and a stranger's headphones.
enum TinyWifiBeaconGate {

    /// True for a tiny board that HAS a WiFi radio.
    ///
    /// A Nicla Voice is excluded here even though it is a genuine tiny board: it
    /// is an nRF52832 with no WiFi at all, so dialling one spends the link budget
    /// to arrive at "setup service missing" — a true sentence about the wrong
    /// device, shown while the Vision the owner meant was still on air.
    ///
    /// There is deliberately no local-name fallback. The Voice advertises the
    /// same `tiny-XXXX` shape (firmware/voice/tiny_voice.ino sets it so Nearby
    /// groups the two together), so matching on the name would let back in
    /// exactly the device the line above rules out — and the Vision's name and
    /// manufacturer record travel in ONE 31-byte payload, so requiring the
    /// record costs nothing that the name would have caught.
    static func isCandidate(manufacturerData: Data?) -> Bool {
        guard let info = TinyBeaconInfo.parse(manufacturerData) else { return false }
        return info.kind != .voice
    }
}

// MARK: - Replies

struct TinyScannedNetwork: Equatable, Identifiable, Sendable {
    let ssid: String
    let rssi: Int
    let secure: Bool

    var id: String { ssid }

    /// Four buckets, because dBm is not a thing to show a person and the board's
    /// radio is the one doing the listening.
    var strength: String {
        if rssi >= -55 { return "strong" }
        if rssi >= -70 { return "good" }
        if rssi >= -80 { return "weak" }
        return "very weak"
    }
}

/// A parsed control answer. Every field is optional-shaped on purpose: `status`
/// answers with the live half only when the board has published one, and an
/// ABSENT ssid ("the board hasn't said") is a different claim from a null one
/// ("it is not on a network"). Flattening those would let the sheet report a
/// board that never answered as disconnected.
struct TinyWifiReply: Equatable, Sendable {
    var cmd: String
    var ok: Bool
    var error: String?
    var saved: [String]?
    var scanned: [TinyScannedNetwork]?
    /// "reconnect" (the loop re-runs its sweep) or "reset" (a hard reboot), and
    /// nil when the edit changed nothing the board is currently doing.
    var applying: String?
    var mode: String?
    var ssid: String?
    var ip: String?
    var provisioned: Bool?

    /// Did this answer say the board is about to drop the link on purpose?
    /// A disconnect right after is the success path, not a fault.
    var expectsReboot: Bool { applying == "reset" }

    /// ⚠️ Same again, for the case that does NOT reboot.
    ///
    /// `reconnect` means the node loop will re-run its WiFi sweep — and on a
    /// Nicla Vision the WiFi and the Bluetooth are one CYW4343W, so associating
    /// commonly takes the BLE link down with it. Measured over the air on
    /// 2026-08-04: a `join` was acked, the board re-associated and came back on
    /// `192.168.1.207`, and the central's next call raised "Service Discovery has
    /// not been performed yet". The change had landed perfectly; the sheet is the
    /// only thing that called it a failure.
    ///
    /// Kept separate from `expectsReboot` because the recoveries differ: a reset
    /// board comes back through its whole boot, while this one never stopped
    /// running and can simply be dialled again.
    var expectsDrop: Bool { applying == "reconnect" }
}

/// What one reassembled frame turns out to be.
enum TinyWifiFrame: Equatable, Sendable {
    /// A control answer, correlated by its echoed `cmd`.
    case reply(TinyWifiReply)
    /// ⚠️ `ok` with no `cmd`: firmware older than the control surface, which has
    /// just merged our request as an empty config and hard-reset itself.
    case legacyAck
    /// Our own echoed write, or anything else without a verdict in it.
    case noise
}

enum TinyWifiWire {

    /// One complete frame → what it is. Pure.
    static func read(_ data: Data) -> TinyWifiFrame {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ok = obj["ok"] as? Bool
        else { return .noise }      // a chunk of our own payload, or garbage
        guard let cmd = obj["cmd"] as? String, !cmd.isEmpty else {
            // The provisioning verdict shape. On a board that understands `cmd`
            // this never happens; on one that doesn't, it is the reboot notice.
            return ok ? .legacyAck : .noise
        }
        return .reply(TinyWifiReply(
            cmd: cmd,
            ok: ok,
            error: obj["error"] as? String,
            saved: obj["saved"] as? [String],
            scanned: (obj["networks"] as? [[String: Any]]).map(scanned),
            applying: obj["applying"] as? String,
            mode: obj["mode"] as? String,
            ssid: obj["ssid"] as? String,
            ip: obj["ip"] as? String,
            provisioned: obj["provisioned"] as? Bool))
    }

    /// Rows the board measured. A row missing its name is dropped rather than
    /// shown blank; a missing rssi sorts last rather than pretending to be 0,
    /// which on this scale would read as the strongest signal in the room.
    static func scanned(_ rows: [[String: Any]]) -> [TinyScannedNetwork] {
        rows.compactMap { row in
            guard let ssid = row["ssid"] as? String, !ssid.isEmpty else { return nil }
            return TinyScannedNetwork(ssid: ssid,
                                      rssi: (row["rssi"] as? Int) ?? -127,
                                      secure: (row["secure"] as? Bool) ?? true)
        }
    }
}

/// The reassembler. Notifications are MTU-sized pieces of one newline-terminated
/// document, so a frame is only whole at the newline — acting on a partial one
/// means parsing half a JSON object and reporting "the device sent a reply we
/// couldn't read" about a board that is answering perfectly.
struct TinyWifiInbox {
    /// A stream that never terminates must not grow without bound: a board that
    /// resets mid-notification leaves a fragment behind, and this object lives as
    /// long as the sheet. Two full scan replies' worth is plenty of room.
    static let ceiling = 4096

    private var buffer = Data()

    /// Bytes held back waiting for a terminator. Exposed so the bound above is
    /// observable: it is the only property of this type a test cannot reach
    /// through `accept`, because an unbounded buffer produces exactly the same
    /// frames as a bounded one right up until the memory is gone.
    var pending: Int { buffer.count }

    /// Frames completed by this chunk, in arrival order.
    mutating func accept(_ chunk: Data) -> [TinyWifiFrame] {
        buffer.append(chunk)
        var out: [TinyWifiFrame] = []
        while let i = buffer.firstIndex(of: 0x0A) {
            let frame = buffer[buffer.startIndex ..< i]
            buffer = buffer[buffer.index(after: i)...]
            if !frame.isEmpty { out.append(TinyWifiWire.read(Data(frame))) }
        }
        if buffer.count > Self.ceiling { buffer = Data() }
        return out
    }
}

// MARK: - Outcomes

/// How one request ended — and what the sheet may CLAIM because of it.
///
/// The distinction that matters is the same one `EnrollOutcome` draws: a refusal
/// is a DECISION the board made and reported, while a timeout is the absence of
/// one. A `join` that timed out may well have been applied — the board answers
/// from its interrupt handler and then spends up to 20s PER network trying to
/// associate, and a notification can be dropped on a link that is about to be
/// re-established. Saying "it didn't work" there would be a claim about the
/// board's flash that this phone cannot make.
enum TinyWifiOutcome: Equatable, Sendable {
    case answered(TinyWifiReply)
    /// The board looked at the request and said no. Its own words.
    case refused(String)
    /// ⚠️ Firmware without the control surface — and asking restarted the board.
    case unsupported
    /// No answer inside the budget. The request may still have been applied.
    case timedOut
    /// The link failed or was never made.
    case offline(String)

    static let unsupportedMessage =
        "This board's firmware doesn't know how to change WiFi over Bluetooth — and asking restarted it. Update the firmware (strands-nicla `deploy`), then try again."
    static let timedOutMessage =
        "The board didn't answer in time. It may have applied the change anyway — wait for it to rejoin, then refresh before trying again."

    /// The line under the form, or nil when the outcome speaks for itself.
    var message: String? {
        switch self {
        case .answered: return nil
        case .refused(let why): return "The board refused: \(why)."
        case .unsupported: return Self.unsupportedMessage
        case .timedOut: return Self.timedOutMessage
        case .offline(let why): return why
        }
    }

    /// Should the sheet stop showing controls that need a live link?
    var isFatal: Bool {
        switch self {
        case .offline, .unsupported: return true
        case .answered, .refused, .timedOut: return false
        }
    }
}

/// Everything the sheet knows about the board, accumulated across replies.
///
/// Accumulated rather than replaced: a `join` answer carries the new saved order
/// and says nothing about the IP, and overwriting the snapshot with it would blank
/// a line that is still true.
struct TinyWifiSnapshot: Equatable, Sendable {
    var saved: [String] = []
    var scanned: [TinyScannedNetwork] = []
    var mode: String?
    var ssid: String?
    var ip: String?
    var provisioned: Bool?
    /// Has the board answered anything yet? Distinguishes "no networks saved"
    /// from "we have not asked", which look identical in an empty list.
    var heard = false

    mutating func apply(_ r: TinyWifiReply) {
        guard r.ok else { return }
        heard = true
        if let saved = r.saved { self.saved = saved }
        if let scanned = r.scanned { self.scanned = scanned }
        // `status` OWNS the live half, absences included: a board that has stopped
        // publishing an ssid has left that network, and carrying the old value
        // forward would show a necklace as connected to a network it is no longer
        // on. Every other reply says nothing about it and must not touch it —
        // a join answer carries the new order and no address at all.
        if r.cmd == "status" {
            mode = r.mode
            ssid = r.ssid
            ip = r.ip
        } else if let mode = r.mode {
            self.mode = mode
        }
        if let p = r.provisioned { provisioned = p }
    }

    /// One sentence for the top of the sheet. The board's three modes need three
    /// different sentences, and the one that used to be missing is the middle one:
    /// a board sweeping its list reports no network, exactly like a board that has
    /// given up, and only one of those is worth waiting out.
    var line: String {
        guard heard else { return "Asking the board…" }
        if mode == "portal" {
            return "In setup mode — it couldn't join anything, so it opened its own hotspot."
        }
        if mode == "joining" { return "Trying its saved networks…" }
        guard let ssid, !ssid.isEmpty else {
            return mode == nil ? "The board hasn't reported a network yet."
                               : "Not on a network."
        }
        guard let ip, !ip.isEmpty else { return "On \(ssid)" }
        return "On \(ssid) · \(ip)"
    }

    /// The board is reachable on the LAN, i.e. the change worked.
    var isOnline: Bool {
        guard let ip, !ip.isEmpty, let ssid, !ssid.isEmpty else { return false }
        return mode != "portal"
    }
}

// MARK: - Routing

/// Which sheet a nearby beacon's button opens.
///
/// Pure and file-scope so both beacon lists (DevicesView's `nearbySection` and
/// NearbyView) make the same decision — they had two copies of the "Reconfigure"
/// ternary already, and this adds a third state to it.
enum TinyBeaconSheet: Identifiable, Equatable {
    case setUp(BleDevice)
    case wifi(BleDevice)
    case adopt(BleDevice)

    var id: String {
        switch self {
        case .setUp(let d): return "setup-\(d.id.uuidString)"
        case .wifi(let d): return "wifi-\(d.id.uuidString)"
        case .adopt(let d): return "adopt-\(d.id.uuidString)"
        }
    }

    var beacon: BleDevice {
        switch self {
        case .setUp(let d), .wifi(let d), .adopt(let d): return d
        }
    }

    /// ⚠️ A CONFIGURED Vision goes to the WiFi sheet, not to setup. Setup enrolls,
    /// and enrolling a board that already has a device row mints a second one
    /// whose token was handed out once — the orphan this whole file exists to
    /// avoid. A Voice always goes to setup: it has no WiFi radio, so identity is
    /// the only thing about it that can be reconfigured.
    static func tapped(_ d: BleDevice) -> TinyBeaconSheet {
        // A Sense never goes to setup: it cannot hold an identity, so setup
        // would enroll a duplicate. Its row exists already; adopt it.
        if d.tiny?.kind == .sense { return .adopt(d) }
        guard let t = d.tiny, t.provisioned, t.kind == .vision else { return .setUp(d) }
        return .wifi(d)
    }

    /// The button's words. "Reconfigure" was doing double duty for two different
    /// destinations, one of which enrolls; naming WiFi is what makes the safe one
    /// findable by the person whose network just changed.
    static func actionLabel(_ d: BleDevice) -> String {
        switch tapped(d) {
        case .wifi: return "WiFi"
        case .setUp: return d.tiny?.provisioned == true ? "Reconfigure" : "Set up"
        case .adopt: return NiclaSenseGateway.shared.unit?.beaconId == d.id ? "Relaying" : "Adopt"
        }
    }
}

// MARK: - The link

/// A live control link to one board: connect, then ask questions.
///
/// Not @MainActor for the reason TinyProvisioner isn't — CoreBluetooth hands
/// non-Sendable objects to the delegate and region isolation rejects moving them
/// onto an actor. The manager is created with `queue: .main`, so every callback
/// and every published mutation happens on the main thread anyway.
final class TinyWifiLink: NSObject, ObservableObject, @unchecked Sendable {

    enum Phase: Equatable {
        case idle, connecting, linked
        case asking(String)
        case failed(String)
    }

    @Published var phase: Phase = .idle
    @Published var snapshot = TinyWifiSnapshot()
    /// The most recent thing that went wrong, kept until the next request starts.
    @Published var outcome: TinyWifiOutcome?

    private var central: CBCentralManager?
    private var target: UUID?
    private var peripheral: CBPeripheral?
    private var configChar: CBCharacteristic?
    /// Held strongly: CoreBluetooth discards peripherals you don't retain, and
    /// the rescue path below dials one of these.
    private var onAir: [CBPeripheral] = []
    private var scanning = false
    private var inbox = TinyWifiInbox()

    private var linkGen = 0
    private var askGen = 0
    private var linkCont: CheckedContinuation<Bool, Never>?
    private var askCont: CheckedContinuation<TinyWifiOutcome, Never>?
    private var askCmd: String?
    /// Set when a reply said the board is rebooting on purpose, so the disconnect
    /// that follows is not reported as a fault.
    private var expectingReboot = false
    /// Set when a reply promised a WiFi re-association, which on this hardware
    /// often drops Bluetooth with it (see `TinyWifiReply.expectsDrop`).
    private var expectingDrop = false
    /// Guards the re-dial in `ask` against re-entering itself.
    private var relinking = false

    // ── Connect ──────────────────────────────────────────────────────────

    func connect(beaconId: UUID) async -> Bool {
        if configChar != nil, peripheral?.state == .connected {
            phase = .linked
            return true
        }
        target = beaconId
        peripheral = nil
        configChar = nil
        onAir = []
        inbox = TinyWifiInbox()
        expectingReboot = false
        expectingDrop = false
        outcome = nil
        phase = .connecting
        armLink(25, "Couldn't reach the board. Bring it closer, check it's powered, then try again.")
        scheduleRescue()
        return await withCheckedContinuation { cont in
            linkCont = cont
            if let c = central, c.state == .poweredOn {
                begin()
            } else if central == nil {
                central = CBCentralManager(delegate: self, queue: .main)
            }
        }
    }

    // ── Ask ──────────────────────────────────────────────────────────────

    /// Send one request and wait for the board's answer. Serialized: the wire has
    /// no request ids beyond the echoed `cmd`, so two in flight at once could not
    /// be told apart.
    @discardableResult
    func ask(_ req: TinyWifiRequest) async -> TinyWifiOutcome {
        guard askCont == nil else {
            return .offline("Still waiting on the last request.")
        }
        // A board that re-associated on our instructions took the link down with
        // it, and it is still sitting there advertising. Telling the owner to
        // "close this and try again" is asking them to do by hand the one thing
        // we know how to do — so dial it again, once, and only when the drop was
        // the expected consequence of something they asked for.
        if peripheral?.state != .connected || configChar == nil,
           expectingDrop, !relinking, let id = target {
            expectingDrop = false
            relinking = true
            _ = await connect(beaconId: id)
            relinking = false
        }
        guard let p = peripheral, let ch = configChar, p.state == .connected else {
            let dead = TinyWifiOutcome.offline("The link to the board dropped. Close this and try again.")
            outcome = dead
            phase = .failed("Link lost")
            return dead
        }
        outcome = nil
        phase = .asking(req.cmd)
        askCmd = req.cmd
        expectingReboot = req.cmd == "reboot"
        let result = await withCheckedContinuation { (cont: CheckedContinuation<TinyWifiOutcome, Never>) in
            askCont = cont
            armAsk(req.patience)
            // Chunked exactly like the provisioner: the negotiated write length is
            // usually smaller than a pushed network list.
            let mtu = min(max(20, p.maximumWriteValueLength(for: .withResponse)), 512)
            var offset = 0
            while offset < req.frame.count {
                let end = min(offset + mtu, req.frame.count)
                p.writeValue(req.frame.subdata(in: offset ..< end), for: ch, type: .withResponse)
                offset = end
            }
        }
        if case .answered(let r) = result { snapshot.apply(r) }
        outcome = result.message == nil ? nil : result
        phase = result.isFatal ? .failed(result.message ?? "Link lost") : .linked
        return result
    }

    /// Status, then whatever the caller wanted — the opening move of the sheet.
    func refresh() async {
        await ask(.status())
    }

    func disconnect() {
        disarmLink()
        disarmAsk()
        stopScan()
        settleLink(false)
        settleAsk(.offline("Cancelled."))
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil
        configChar = nil
        phase = .idle
    }

    // ── Machinery (main thread only) ─────────────────────────────────────

    fileprivate func begin() {
        guard let c = central, c.state == .poweredOn else { return }
        if let id = target, let p = c.retrievePeripherals(withIdentifiers: [id]).first {
            peripheral = p
            p.delegate = self
            c.connect(p)
        }
        startScan()
    }

    /// ⚠️ Unfiltered on purpose. The board does not ADVERTISE the setup service.
    ///
    /// `firmware/tiny_ble.py` registers it on connect, but `adv_payload` builds
    /// exactly three AD structures — flags (0x01), complete local name (0x09) and
    /// manufacturer data (0xFF). There is no 0x02/0x03/0x06/0x07 service-UUID
    /// record in the 31 bytes, and CoreBluetooth's `withServices:` matches on the
    /// advertisement alone: it cannot connect to find out. So a scan filtered on
    /// `wifiServiceUUID` matched no tiny board ever — this sheet could only ever
    /// reach one through the cached-identifier path in `begin()`, and the rescue
    /// that exists because that cache goes stale had nothing to rescue with.
    ///
    /// The filter therefore moves to `didDiscover`, where the manufacturer record
    /// is readable and `Bluetooth.swift` already recognizes it. Without that half
    /// the change would be worse than the bug: `onAir` would fill with every
    /// peripheral in the room and `scheduleRescue` would dial someone's earbuds.
    private func startScan() {
        guard let c = central, c.state == .poweredOn, !scanning else { return }
        scanning = true
        c.scanForPeripherals(withServices: nil,
                             options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    private func stopScan() {
        if scanning { central?.stopScan(); scanning = false }
    }

    /// The cached identifier may be a ghost, and `connect()` on a ghost never
    /// calls didFailToConnect — it waits forever (TinySetup's second bug). So
    /// halfway through the budget, switch to something provably on air.
    private func scheduleRescue() {
        let g = linkGen
        DispatchQueue.main.asyncAfter(deadline: .now() + 9) { [weak self] in
            guard let self, self.linkGen == g, case .connecting = self.phase else { return }
            guard let fresh = self.onAir.first(where: { $0.state != .connected }) ?? self.onAir.first
            else { return }
            if let stale = self.peripheral, stale.identifier != fresh.identifier {
                self.central?.cancelPeripheralConnection(stale)
            }
            self.peripheral = fresh
            fresh.delegate = self
            self.central?.connect(fresh)
        }
    }

    private func armLink(_ seconds: TimeInterval, _ message: String) {
        linkGen += 1
        let g = linkGen
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.linkGen == g else { return }
            self.failLink(message)
        }
    }

    private func disarmLink() { linkGen += 1 }

    private func armAsk(_ seconds: TimeInterval) {
        askGen += 1
        let g = askGen
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.askGen == g else { return }
            self.settleAsk(.timedOut)
        }
    }

    private func disarmAsk() { askGen += 1 }

    fileprivate func failLink(_ why: String) {
        disarmLink()
        stopScan()
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        phase = .failed(why)
        outcome = .offline(why)
        settleLink(false)
        settleAsk(.offline(why))
    }

    private func settleLink(_ ok: Bool) {
        guard let c = linkCont else { return }
        linkCont = nil
        c.resume(returning: ok)
    }

    private func settleAsk(_ outcome: TinyWifiOutcome) {
        disarmAsk()
        askCmd = nil
        guard let c = askCont else { return }
        askCont = nil
        c.resume(returning: outcome)
    }
}

extension TinyWifiLink: CBCentralManagerDelegate, CBPeripheralDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn: begin()
        case .unauthorized: failLink("Bluetooth permission is off for tiny — enable it in Settings.")
        case .poweredOff: failLink("Bluetooth is off — turn it on to reach the board.")
        default: break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard TinyWifiBeaconGate.isCandidate(
            manufacturerData: advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data)
        else { return }
        guard !onAir.contains(where: { $0.identifier == peripheral.identifier }) else { return }
        onAir.append(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral.identifier == self.peripheral?.identifier else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        stopScan()
        armLink(15, "The board connected but never answered. Power-cycle it and try again.")
        peripheral.discoverServices([wifiServiceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        // The parallel scan may still rescue this; the link watchdog is the
        // deadline that matters.
        guard case .connecting = phase else {
            failLink(error?.localizedDescription ?? "Connection failed.")
            return
        }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        configChar = nil
        if expectingReboot {
            // We asked it to reboot (or an edit asked for a reset): the board
            // resets ~1s after acking, so this disconnect is the change landing.
            expectingReboot = false
            phase = .idle
            settleAsk(.answered(TinyWifiReply(cmd: askCmd ?? "reboot", ok: true, applying: "reset")))
            return
        }
        if expectingDrop {
            // ⚠️ The change LANDED. The board answered, then re-associated, and
            // the shared CYW4343W took Bluetooth down on the way — so this
            // disconnect is the last step of a success and must not be dressed as
            // a fault. The flag stays set: `ask` consumes it to re-dial, because
            // the board is still running and still advertising.
            disarmLink()
            stopScan()
            self.peripheral = nil       // the delegate's parameter shadows ours
            phase = .idle
            // Only a request still in flight needs an answer here; the usual case
            // is a drop AFTER the reply, with nothing waiting.
            if askCont != nil { settleAsk(.timedOut) }
            settleLink(false)
            return
        }
        if case .idle = phase { return }
        if case .failed = phase { return }
        failLink("The board disconnected. It may be rejoining a network — try again in a moment.")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == wifiServiceUUID }) else {
            failLink("That isn't a tiny board (setup service missing).")
            return
        }
        peripheral.discoverCharacteristics([wifiConfigUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let ch = service.characteristics?.first(where: { $0.uuid == wifiConfigUUID }) else {
            failLink("That isn't a tiny board (config characteristic missing).")
            return
        }
        peripheral.setNotifyValue(true, for: ch)
        disarmLink()
        stopScan()
        configChar = ch
        phase = .linked
        settleLink(true)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error, askCont != nil {
            settleAsk(.offline("Sending that failed: \(error.localizedDescription)"))
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == wifiConfigUUID, let chunk = characteristic.value else { return }
        for frame in inbox.accept(chunk) {
            switch frame {
            case .noise:
                continue        // our own echoed write, or a fragment
            case .legacyAck:
                // Firmware without the control surface. It has already reset.
                expectingReboot = true
                settleAsk(.unsupported)
                outcome = .unsupported
                phase = .failed(TinyWifiOutcome.unsupportedMessage)
            case .reply(let r):
                // Correlate on the echoed cmd: a late answer to a request whose
                // watchdog already fired must not be handed to the next one.
                guard r.cmd == askCmd else { continue }
                if r.expectsReboot { expectingReboot = true }
                if r.expectsDrop { expectingDrop = true }
                if !r.ok {
                    settleAsk(.refused(r.error ?? "no reason given"))
                } else {
                    settleAsk(.answered(r))
                }
            }
        }
    }
}

// MARK: - The sheet

/// Change a configured necklace's WiFi over Bluetooth.
///
/// Reachable from both beacon lists via `TinyBeaconSheet.tapped`. It never calls
/// the registry, which is the entire point: the board keeps the device row and
/// token it already has.
struct TinyWifiView: View {
    let beacon: BleDevice
    @StateObject private var link = TinyWifiLink()
    @ObservedObject private var wifi = WifiStore.shared
    @Environment(\.dismiss) private var dismiss

    @AppStorage("cfg_last_wifi_ssid") private var newSsid = ""
    @State private var newPassword = ""
    /// A scanned network the owner tapped that the board has no password for.
    @State private var askingFor: TinyScannedNetwork?
    @State private var askedPassword = ""
    @State private var reprovision = false
    @State private var busy = false

    private var live: Bool {
        switch link.phase {
        case .linked, .asking: return true
        default: return false
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                boardSection
                if live || link.snapshot.heard {
                    savedSection
                    scanSection
                    addSection
                    pushSection
                    dangerSection
                }
                if let why = link.outcome?.message {
                    Section { Text(why).font(.caption).foregroundStyle(.orange) }
                }
            }
            .navigationTitle("WiFi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { link.disconnect(); dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        run { await link.refresh() }
                    } label: {
                        if busy { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                    }
                    .disabled(busy || !live)
                    .accessibilityLabel("Refresh the board's status")
                }
            }
            .task {
                if await link.connect(beaconId: beacon.id) { await link.refresh() }
            }
            .onDisappear { link.disconnect() }
            .alert("Password for \(askingFor?.ssid ?? "")",
                   isPresented: Binding(get: { askingFor != nil },
                                        set: { if !$0 { askingFor = nil } })) {
                SecureField("WiFi password", text: $askedPassword)
                Button("Join") {
                    if let net = askingFor { join(ssid: net.ssid, key: askedPassword) }
                    askedPassword = ""
                }
                Button("Cancel", role: .cancel) { askedPassword = "" }
            } message: {
                Text("The board doesn't have this one saved yet. It's stored on the board and in this phone's keychain.")
            }
            .sheet(isPresented: $reprovision) { TinySetupView(beacon: beacon) }
        }
    }

    // ── Sections ─────────────────────────────────────────────────────────

    @ViewBuilder private var boardSection: some View {
        Section {
            LabeledContent("Board", value: beacon.name)
            HStack {
                Text("Status")
                Spacer()
                Text(statusLine)
                    .foregroundStyle(link.snapshot.isOnline ? .green : .secondary)
                    .multilineTextAlignment(.trailing)
            }
        } header: { Text("tiny hardware") } footer: {
            Text("Changing WiFi here does NOT re-register the board — it keeps the device and token it already has. 2.4GHz only: its radio cannot see a 5GHz network.")
        }
    }

    private var statusLine: String {
        switch link.phase {
        case .idle: return "Not connected"
        case .connecting: return "Connecting…"
        case .asking(let cmd): return cmd == "scan" ? "Scanning…" : "Working…"
        case .failed(let why): return why
        case .linked: return link.snapshot.line
        }
    }

    @ViewBuilder private var savedSection: some View {
        Section {
            if link.snapshot.saved.isEmpty {
                Text(link.snapshot.heard
                     ? "The board has no networks saved."
                     : "Asking the board…")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(link.snapshot.saved.enumerated()), id: \.element) { i, ssid in
                HStack {
                    Text("\(i + 1)").font(.caption).monospacedDigit()
                        .foregroundStyle(.secondary).frame(width: 16, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ssid)
                        if ssid == link.snapshot.ssid {
                            Text("connected now").font(.caption2).foregroundStyle(.green)
                        }
                    }
                    Spacer()
                    if i > 0 {
                        Button("Use") { join(ssid: ssid) }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                .swipeActions {
                    // The board refuses to forget its last one — being stranded in
                    // the AP portal costs a walk to wherever the necklace is.
                    if link.snapshot.saved.count > 1 {
                        Button("Forget", role: .destructive) {
                            run { await link.ask(.forget(ssid: ssid)) }
                        }
                    }
                }
            }
        } header: { Text("Saved on the board") } footer: {
            Text("Tried in this order, 20 seconds each. “Use” moves one to the front and reconnects — no password needed for one the board already knows.")
        }
        .disabled(busy || !live)
    }

    @ViewBuilder private var scanSection: some View {
        Section {
            Button {
                run { await link.ask(.scan()) }
            } label: {
                Label("Scan from the board", systemImage: "antenna.radiowaves.left.and.right")
            }
            .disabled(busy || !live)
            ForEach(link.snapshot.scanned) { net in
                Button {
                    tapScanned(net)
                } label: {
                    HStack {
                        Image(systemName: net.secure ? "lock.fill" : "lock.open")
                            .font(.caption2).foregroundStyle(.secondary)
                        Text(net.ssid).foregroundStyle(.primary)
                        Spacer()
                        Text(net.strength).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .disabled(busy || !live)
            }
        } header: { Text("Networks in range") } footer: {
            Text("This is what the BOARD's radio hears, not this phone's — the point of asking. A network your phone sees on 5GHz simply isn't there for the necklace.")
        }
    }

    @ViewBuilder private var addSection: some View {
        Section {
            TextField("WiFi network", text: $newSsid)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField("WiFi password", text: $newPassword)
            Button("Add and switch to it") {
                let ssid = newSsid.trimmingCharacters(in: .whitespaces)
                join(ssid: ssid, key: newPassword)
                newPassword = ""
            }
            .disabled(busy || !live || newSsid.trimmingCharacters(in: .whitespaces).isEmpty)
        } header: { Text("Add a network") } footer: {
            Text("Goes to the front of the board's list and it reconnects straight away. Also saved in this phone's keychain, so the next board can have it too.")
        }
    }

    @ViewBuilder private var pushSection: some View {
        Section {
            Button {
                run { await link.ask(.push(wifi.networks)) }
            } label: {
                Label("Replace with my \(wifi.networks.count) saved network\(wifi.networks.count == 1 ? "" : "s")",
                      systemImage: "arrow.up.arrow.down")
            }
            .disabled(busy || !live || wifi.networks.isEmpty)
        } header: { Text("This phone's list") } footer: {
            Text(wifi.networks.isEmpty
                 ? "This phone has no networks saved yet."
                 : "Overwrites the board's whole list with this phone's, in this phone's order: \(wifi.networks.map(\.ssid).joined(separator: ", ")).")
        }
    }

    @ViewBuilder private var dangerSection: some View {
        Section {
            Button {
                run { await link.ask(.reboot()) }
            } label: {
                Label("Restart the board", systemImage: "arrow.clockwise.circle")
            }
            .disabled(busy || !live)
            Button {
                link.disconnect()
                reprovision = true
            } label: {
                Label("Set up again (registers a new device)", systemImage: "person.badge.plus")
            }
        } header: { Text("Other") } footer: {
            Text("Setting up again enrolls a NEW device row and its token is issued once, so the old row becomes an orphan you can only revoke. Use it when the board is moving to another account, not to change WiFi.")
        }
    }

    // ── Actions ──────────────────────────────────────────────────────────

    /// Tapping a scanned network: if the board already knows it, no password is
    /// needed. Otherwise reuse this phone's if it has one, and only then ask.
    private func tapScanned(_ net: TinyScannedNetwork) {
        if link.snapshot.saved.contains(net.ssid) {
            join(ssid: net.ssid)
        } else if let known = wifi.networks.first(where: { $0.ssid == net.ssid }) {
            join(ssid: net.ssid, key: known.password)
        } else if net.secure {
            askedPassword = ""
            askingFor = net
        } else {
            join(ssid: net.ssid, key: "")   // open network: "" is the real key
        }
    }

    /// Switch the board, and remember the network on this phone too — a password
    /// typed into a board and nowhere else is one the next board has to be told
    /// again by hand.
    private func join(ssid: String, key: String? = nil) {
        guard !ssid.isEmpty else { return }
        if let key { wifi.add(ssid: ssid, password: key) }
        run {
            await link.ask(.join(ssid: ssid, key: key))
            // The board is re-associating; its own report of what happened is the
            // only thing worth showing, so ask once it has had a moment.
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await link.refresh()
        }
    }

    private func run(_ work: @escaping () async -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            await work()
            busy = false
        }
    }
}

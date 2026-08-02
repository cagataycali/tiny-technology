/**
 * FlipperGateway — the phone holds the Flipper's link so the cable doesn't have to.
 *
 * The Flipper Zero reaches tiny.technology through whatever machine it is plugged
 * into: `hasFlipper()` scans /dev for cu.usbmodemflip_* and pushes the capability
 * label `flipper` into that host's heartbeat, and the flipper_* tools resolve a
 * host by that label (lib/chat/tools/flipper.ts). Which means the Flipper in your
 * pocket is unreachable, and the one on the desk is only reachable while the desk
 * machine is awake. This file is the other route: the phone that is actually near
 * the Flipper holds a BLE link and answers for it.
 *
 * ⚠️ THE TRANSPORTS ARE NOT THE SAME PROTOCOL, and that is the whole reason this
 * is a new implementation rather than a port of tiny-tech/src/agent/flipper.ts:
 *
 *   • Over USB the Flipper speaks a TEXT CLI — a `>: ` prompt, 40-odd commands,
 *     `ir rx`, `subghz rx`, `rfid read`. That is what use_flipper drives.
 *   • Over BLE it speaks PROTOBUF RPC — nanopb, varint-length-prefixed PB.Main
 *     frames on a serial-shaped GATT service. Different verbs entirely.
 *
 * Neither is a superset. Measured on hardware (unlshd-075, protobuf 0.23), RPC
 * covers status and the whole SD card — richer than the CLI in places, since
 * Storage.List returns md5 and sizes as fields instead of text to parse. But
 * there is NO RECEIVE RPC: ir/subghz/rfid/ibutton capture cannot be done over
 * BLE at all, by any client, because the firmware exposes no such command. So
 * flipper_listen stays cable-only and says so, rather than returning an empty
 * capture that reads exactly like a capture which heard silence.
 *
 * No protobuf dependency. The codec below is ~90 lines of varint and tag/length
 * for the twelve messages we need — the same shape the spike proved on the wire,
 * and cheaper than generating and vendoring the whole 0.23 schema.
 */
import CoreBluetooth
import Foundation

// File scope for the same reason as NiclaVoiceGateway's: the delegate callbacks
// that compare against these run off the main actor, and CBUUID is immutable but
// not annotated Sendable.
//
// Byte-reversed out of the ST 128-bit defines in the firmware itself
// (targets/f7/ble_glue/services/serial_service_uuid.inc) rather than trusted to
// memory — the .inc lists them least-significant byte first.
private nonisolated(unsafe) let flipperServiceUUID = CBUUID(string: "8FE5B3D5-2E7F-4A98-2A48-7ACC60FE0000")
/// Flipper → phone, notify. RPC responses arrive here.
private nonisolated(unsafe) let flipperTxUUID = CBUUID(string: "19ED82AE-ED21-4C9D-4145-228E61FE0000")
/// phone → Flipper, write. RPC requests go here.
private nonisolated(unsafe) let flipperRxUUID = CBUUID(string: "19ED82AE-ED21-4C9D-4145-228E62FE0000")
/// Free space in the board's RX buffer, big-endian uint32. See `credits`.
private nonisolated(unsafe) let flipperFlowUUID = CBUUID(string: "19ED82AE-ED21-4C9D-4145-228E63FE0000")

// MARK: - Protobuf

/// One field as it appeared on the wire. Protobuf is not self-describing, so a
/// varint could be a number, a bool or an enum, and a length-delimited blob could
/// be a string, bytes, or a submessage — the reader decides, per field.
enum PBField {
    case num(UInt64)
    case data(Data)
}

/// A parsed protobuf message: field number → values, repeated fields kept in
/// order. Deliberately tolerant — an unknown field is collected, not an error,
/// because a firmware newer than this file will send fields we don't know.
struct PBMsg {
    private let fields: [Int: [PBField]]

    init(_ data: Data) { self.init(Array(data)) }

    init(_ bytes: [UInt8]) {
        var i = 0
        var f: [Int: [PBField]] = [:]
        while i < bytes.count {
            guard let (key, afterKey) = PBMsg.varint(bytes, i) else { break }
            i = afterKey
            let field = Int(key >> 3)
            switch key & 7 {
            case 0: // varint
                guard let (v, n) = PBMsg.varint(bytes, i) else { i = bytes.count; break }
                f[field, default: []].append(.num(v))
                i = n
            case 1: // 64-bit
                guard i + 8 <= bytes.count else { i = bytes.count; break }
                f[field, default: []].append(.data(Data(bytes[i..<i + 8])))
                i += 8
            case 2: // length-delimited
                guard let (len, n) = PBMsg.varint(bytes, i),
                      len <= UInt64(bytes.count - n) else { i = bytes.count; break }
                let end = n + Int(len)
                f[field, default: []].append(.data(Data(bytes[n..<end])))
                i = end
            case 5: // 32-bit
                guard i + 4 <= bytes.count else { i = bytes.count; break }
                f[field, default: []].append(.data(Data(bytes[i..<i + 4])))
                i += 4
            default:
                // Groups (3/4) are deprecated and the Flipper never emits them.
                // Stop rather than guess a length and mis-parse the rest.
                i = bytes.count
            }
        }
        fields = f
    }

    func num(_ field: Int) -> UInt64? {
        if case .num(let v)? = fields[field]?.first { return v }
        return nil
    }

    func bytes(_ field: Int) -> Data? {
        if case .data(let d)? = fields[field]?.first { return d }
        return nil
    }

    func str(_ field: Int) -> String? {
        bytes(field).flatMap { String(data: $0, encoding: .utf8) }
    }

    func msg(_ field: Int) -> PBMsg? { bytes(field).map { PBMsg($0) } }

    /// Every value of a repeated length-delimited field, as submessages.
    func msgs(_ field: Int) -> [PBMsg] {
        (fields[field] ?? []).compactMap {
            if case .data(let d) = $0 { return PBMsg(d) }
            return nil
        }
    }

    var isEmpty: Bool { fields.isEmpty }
    func has(_ field: Int) -> Bool { fields[field] != nil }

    static func varint(_ b: [UInt8], _ start: Int) -> (UInt64, Int)? {
        var v: UInt64 = 0, shift: UInt64 = 0, i = start
        while i < b.count {
            let byte = b[i]
            i += 1
            v |= UInt64(byte & 0x7f) << shift
            if byte & 0x80 == 0 { return (v, i) }
            shift += 7
            if shift > 63 { return nil }
        }
        return nil // truncated — the caller waits for more bytes
    }
}

/// Encoder. Small on purpose: every request we send is a path, a flag, or nothing.
enum PB {
    static func varint(_ v: UInt64) -> Data {
        var n = v, out = Data()
        while n > 0x7f {
            out.append(UInt8(n & 0x7f | 0x80))
            n >>= 7
        }
        out.append(UInt8(n))
        return out
    }

    static func tag(_ field: Int, _ wire: Int) -> Data { varint(UInt64(field << 3 | wire)) }
    /// A length-delimited field: submessage, string or bytes.
    static func sub(_ field: Int, _ body: Data) -> Data { tag(field, 2) + varint(UInt64(body.count)) + body }
    static func str(_ field: Int, _ s: String) -> Data { sub(field, Data(s.utf8)) }
    static func int(_ field: Int, _ n: UInt64) -> Data { tag(field, 0) + varint(n) }
    /// proto3 omits false: an encoded `false` and an absent field are the same
    /// value, and the shorter one is what every other client sends.
    static func bool(_ field: Int, _ b: Bool) -> Data { b ? int(field, 1) : Data() }
    /// An empty submessage still needs its tag — PB.Main's `oneof` is what names
    /// the command, so `Storage.InfoRequest{}` is tag + a zero length.
    static func empty(_ field: Int) -> Data { sub(field, Data()) }
    /// PB_ENCODE_DELIMITED: the length prefix the RPC parser reads first.
    static func frame(_ body: Data) -> Data { varint(UInt64(body.count)) + body }
}

/// PB.Main's `oneof` field numbers ARE the command names (flipper.proto, tag
/// 0.23). Pinned here so a firmware bump that renumbers them fails loudly in one
/// place instead of decoding into plausible nonsense.
private enum Cmd {
    static let commandId = 1, status = 2, hasNext = 3
    static let stopSession = 19
    static let pingReq = 5
    static let deviceInfoReq = 32, deviceInfoResp = 33
    static let powerInfoReq = 44, powerInfoResp = 45
    static let alertReq = 38
    static let storageListReq = 7, storageListResp = 8
    static let storageReadReq = 9, storageReadResp = 10
    static let storageInfoReq = 28, storageInfoResp = 29
    static let storageStatReq = 24, storageStatResp = 25
    static let storageMd5Req = 14, storageMd5Resp = 15
}

/// CommandStatus, for turning a code into something a person can read. The ones
/// that actually happen: 7 when a path is wrong, 17 when an app holds the screen.
private func flipperStatusText(_ code: UInt64) -> String {
    switch code {
    case 1: return "the Flipper reported an unspecified error"
    case 2: return "the Flipper couldn't decode the request"
    case 3: return "this Flipper's firmware doesn't implement that"
    case 4: return "the Flipper is busy — something holds a global lock"
    case 5: return "the SD card isn't ready"
    case 6: return "that path already exists"
    case 7: return "no such file or folder on the Flipper"
    case 8: return "invalid path"
    case 9: return "the Flipper denied access to that path"
    case 10: return "invalid name or path"
    case 11: return "the Flipper's storage hit an internal error"
    case 15: return "the request was missing something the Flipper needs"
    case 17: return "an app is running on the Flipper — close it on the device first"
    default: return "the Flipper answered with error \(code)"
    }
}

enum FlipperError: LocalizedError {
    case notLinked
    case timeout(String)
    case status(UInt64)
    case refused(String)
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case .notLinked:
            return "No Flipper is linked to this phone over Bluetooth."
        case .timeout(let what):
            return "The Flipper didn't answer \(what) in time."
        case .status(let code):
            return flipperStatusText(code)
        case .refused(let why):
            return why
        case .malformed(let what):
            return "The Flipper's answer to \(what) didn't parse."
        }
    }
}

/// One SD-card entry, as Storage.List reported it.
struct FlipperEntry: Identifiable, Equatable {
    var id: String { name }
    let isDir: Bool
    let name: String
    let size: UInt64
    let md5: String?
}

/// What the phone can say about the Flipper without touching the SD card.
struct FlipperInfo: Equatable {
    var firmware = ""
    var model = ""
    var deviceName = ""
    var batteryPct: Int?
    var chargeState = ""
    var freeBytes: UInt64?
    var totalBytes: UInt64?

    /// One line, for a panel row and for the relay reply — same words both
    /// places, so the phone and the web agent can't describe it differently.
    var summary: String {
        var bits: [String] = []
        if !firmware.isEmpty { bits.append(firmware) }
        if !model.isEmpty { bits.append(model) }
        if let pct = batteryPct {
            bits.append(chargeState.isEmpty ? "🔋 \(pct)%" : "🔋 \(pct)% \(chargeState)")
        }
        if let free = freeBytes {
            bits.append(String(format: "%.2f GB free", Double(free) / 1_000_000_000))
        }
        return bits.isEmpty ? "linked over Bluetooth" : bits.joined(separator: " · ")
    }
}

// MARK: - Gateway

/// Not @MainActor, same reasoning as NiclaVoiceGateway: CoreBluetooth hands
/// non-Sendable objects to the delegate and region isolation rejects moving them
/// onto an actor. The manager is created with `queue: .main`, so every callback
/// and every @Published mutation happens on the main thread.
///
/// The RPC bookkeeping is the exception: `pending` is read from the delegate (main
/// queue) and written by callers awaiting a response (any thread, off a Task), so
/// it takes an explicit lock rather than an assumption.
final class FlipperGateway: NSObject, ObservableObject, @unchecked Sendable {
    static let shared = FlipperGateway()

    /// A Flipper this phone has bonded with and speaks for.
    struct Unit: Equatable {
        let peripheralId: UUID
        var name: String
    }

    /// Something seen during a scan, for the pairing list.
    struct Found: Identifiable, Equatable {
        let id: UUID
        let name: String
        let rssi: Int
    }

    @Published private(set) var unit: Unit?
    /// True only once RPC has actually answered — see `finishLink()`. Reaching
    /// characteristic discovery is not the same as being able to ask anything.
    @Published private(set) var linked = false
    @Published private(set) var info: FlipperInfo?
    @Published private(set) var lastError: String?
    @Published private(set) var scanning = false
    @Published private(set) var found: [Found] = []
    /// Set while a relay envelope is being served, so the devices panel can show
    /// that the web agent is talking to the Flipper through this phone.
    @Published var activity = ""

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var rxChar: CBCharacteristic?
    private var rxWriteType: CBCharacteristicWriteType = .withResponse
    private var reconnectTask: Task<Void, Never>?
    /// Literal, not `Self.reconnectBaseS`: a covariant `Self` cannot be
    /// referenced from a stored property initializer.
    private var reconnectDelay: TimeInterval = 1
    private var linkedAt: Date?
    /// Guards the permission prompt: merely instantiating CBCentralManager asks
    /// for Bluetooth, and a user with no Flipper should never be asked because of
    /// this file.
    private var wanted = false

    /// Rolling inbound bytes. BLE notifies arrive in MTU-sized pieces with no
    /// regard for frame boundaries, so a 60-frame DeviceInfo can land as any
    /// number of notifies and one notify can hold several frames.
    private var inbox: [UInt8] = []

    private let lock = NSLock()
    private var nextId: UInt32 = 1
    private struct Pending {
        var frames: [PBMsg] = []
        var cont: CheckedContinuation<[PBMsg], Error>?
    }
    private var pending: [UInt32: Pending] = [:]
    /// Free bytes in the board's RX buffer, as the flow-control characteristic
    /// last reported. nil = never notified, so we have no information and send
    /// anyway; the firmware only warns about overflow once it has told us.
    private var credits: UInt32?

    private static let unitKey = "flipper_ble_unit"
    private static let reconnectBaseS: TimeInterval = 1
    private static let reconnectMaxS: TimeInterval = 32
    /// A link this long counts as having worked and earns a backoff reset.
    private static let goodLinkS: TimeInterval = 30
    /// Largest file the phone will pull off the SD card. The relay caps an
    /// envelope at 8KB and truncates a reply at 7000 characters, so anything
    /// bigger cannot be delivered — refuse it by SIZE before reading it, rather
    /// than spending the transfer and then throwing the bytes away.
    static let maxReadBytes = 6000
    /// Folders holding the user's scanned credentials. Ported from
    /// tiny-tech/src/agent/flipper.ts SENSITIVE_DIRS — see `refuseSweep`.
    static let sensitiveDirs = ["/ext/nfc", "/ext/lfrfid", "/ext/ibutton", "/ext/u2f", "/ext/subghz"]

    override private init() {
        super.init()
        if let d = UserDefaults.standard.dictionary(forKey: Self.unitKey),
           let raw = d["peripheralId"] as? String,
           let id = UUID(uuidString: raw) {
            unit = Unit(peripheralId: id, name: d["name"] as? String ?? "Flipper")
        }
    }

    // MARK: - Pairing

    /// Look for Flippers. Foreground only by design: a nil-service scan is not
    /// allowed in the background, and pairing is a thing the user is watching.
    func startScan() {
        wanted = true
        found = []
        if central == nil {
            central = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionRestoreIdentifierKey: "technology.tiny.flipper.ble",
            ])
        } else {
            beginScanIfPossible()
        }
    }

    func stopScan() {
        scanning = false
        central?.stopScan()
    }

    private func beginScanIfPossible() {
        guard let c = central, c.state == .poweredOn, !c.isScanning else { return }
        // Scanned with nil rather than [flipperServiceUUID] on purpose: iOS only
        // matches a service filter against the ADVERTISEMENT, and whether the
        // serial service appears there varies by firmware. Filtering ourselves on
        // name-or-advertised-service finds the board either way, and this scan is
        // short and user-initiated.
        scanning = true
        c.scanForPeripherals(withServices: nil, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false,
        ])
    }

    /// Adopt one of the scanned boards. The system pairing prompt (and the
    /// 6-digit code on the Flipper's screen) appears when we subscribe to the TX
    /// characteristic, because every serial characteristic is
    /// ATTR_PERMISSION_AUTHEN_* in the firmware — bonding is not optional.
    func pair(_ id: UUID, name: String) {
        UserDefaults.standard.set(["peripheralId": id.uuidString, "name": name], forKey: Self.unitKey)
        unit = Unit(peripheralId: id, name: name)
        stopScan()
        start()
    }

    /// Forget the board locally. Does NOT unpair it in iOS Settings and does not
    /// touch the Flipper's own paired-devices list — that list holds the user's
    /// other pairings, and clearing it to tidy up after ourselves would take
    /// their laptop and the official app with it.
    func forget() {
        UserDefaults.standard.removeObject(forKey: Self.unitKey)
        stop()
        unit = nil
        info = nil
        lastError = nil
    }

    // MARK: - Link lifecycle

    func start() {
        guard unit != nil else { return }
        wanted = true
        // An explicit start is user intent, so it jumps the backoff queue.
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectDelay = Self.reconnectBaseS
        if central == nil {
            central = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionRestoreIdentifierKey: "technology.tiny.flipper.ble",
            ])
        } else {
            connectIfPossible()
        }
    }

    func stop() {
        wanted = false
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectDelay = Self.reconnectBaseS
        stopScan()
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil
        rxChar = nil
        linked = false
        linkedAt = nil
        failAllPending(FlipperError.notLinked)
    }

    private func connectIfPossible() {
        guard wanted, let c = central, c.state == .poweredOn, let u = unit else { return }
        guard let p = c.retrievePeripherals(withIdentifiers: [u.peripheralId]).first else {
            // iOS knows a peripheral by UUID only after it has seen it; a phone
            // restored from backup has the id and no cached peripheral.
            lastError = "Bring the Flipper nearby and scan for it once."
            return
        }
        peripheral = p
        p.delegate = self
        // No timeout by design: CoreBluetooth holds a pending connection until
        // the peripheral appears, so walking back into range restores the link
        // with no UI.
        c.connect(p)
    }

    /// Re-dial after a drop, with BACKOFF. Never call `connectIfPossible()`
    /// straight from a disconnect handler.
    ///
    /// The Flipper accepts ONE central at a time, exactly like the Nicla Voice —
    /// and the measured consequence there is in NiclaVoiceGateway.scheduleReconnect():
    /// an instant re-dial turns that single slot into a spin lock, so no other
    /// central can finish discovery and the board looks broken from everywhere
    /// else. Here that "everywhere else" is the user's own laptop and the official
    /// Flipper app. 1s → 32s, reset only by a link that lasted.
    private func scheduleReconnect() {
        guard wanted else { return }
        reconnectTask?.cancel()
        let delay = reconnectDelay
        reconnectDelay = min(delay * 2, Self.reconnectMaxS)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            // Bound to a `let` before the nested hop: a weak-captured `self`
            // referenced inside MainActor.run is a captured *var*, which Swift 6
            // rejects outright.
            guard !Task.isCancelled, let me = self else { return }
            await MainActor.run { me.connectIfPossible() }
        }
    }

    /// Called once the characteristics are in hand. Proves the link with a ping
    /// before claiming it, then fills in `info` so the panel has something true
    /// to show without the user pressing anything.
    private func finishLink() {
        Task {
            do {
                try await ping()
            } catch {
                await MainActor.run {
                    self.linked = false
                    self.lastError = "Bluetooth connected, but the Flipper's RPC didn't answer. If its screen is showing an app, close it."
                }
                return
            }
            await MainActor.run {
                self.linked = true
                self.linkedAt = Date()
                self.lastError = nil
            }
            await refresh()
        }
    }

    // MARK: - RPC transport

    /// Send one command and collect its response frames.
    ///
    /// `has_next` is how the Flipper streams: DeviceInfo answers with SIXTY
    /// frames, one key each, every one but the last flagged. So a request is done
    /// when a frame for our command_id arrives WITHOUT it — not when the first
    /// frame lands, which is what a naive read returns halfway through a listing.
    private func request(_ content: Data, timeout: TimeInterval = 15,
                         label: String) async throws -> [PBMsg] {
        guard linked || content.isEmpty == false else { throw FlipperError.notLinked }
        let id = lock.withLock { () -> UInt32 in
            let v = nextId
            nextId = nextId == UInt32.max ? 1 : nextId + 1
            return v
        }
        let body = PB.int(Cmd.commandId, UInt64(id)) + content
        let framed = PB.frame(body)

        let timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(timeout))
            guard !Task.isCancelled, let me = self else { return }
            me.fail(id, FlipperError.timeout(label))
        }
        defer { timer.cancel() }

        return try await withCheckedThrowingContinuation { cont in
            lock.withLock {
                var p = pending[id] ?? Pending()
                p.cont = cont
                pending[id] = p
            }
            // Strong capture: the class is a @unchecked Sendable singleton, and a
            // weak one here reads as a `var` to Swift 6's closure checker.
            Task { @MainActor in
                self.write(framed, id: id)
            }
        }
    }

    /// Write one framed request, chunked to what the link and the board's buffer
    /// will take.
    @MainActor
    private func write(_ data: Data, id: UInt32) {
        guard let p = peripheral, let ch = rxChar else {
            fail(id, FlipperError.notLinked)
            return
        }
        let mtu = max(20, p.maximumWriteValueLength(for: rxWriteType))
        var offset = 0
        while offset < data.count {
            let n = min(mtu, data.count - offset)
            // Flow control is not decoration: the flow-control characteristic
            // reports free RX buffer, and the firmware logs "Received %d, while
            // was ready to receive %d bytes. Can lead to buffer overflow!" when a
            // writer ignores it. Hold back rather than overrun the board.
            let room = lock.withLock { credits }
            if let room, room < UInt32(n) { break }
            p.writeValue(data.subdata(in: offset..<offset + n), for: ch, type: rxWriteType)
            lock.withLock {
                if let c = credits { credits = c > UInt32(n) ? c - UInt32(n) : 0 }
            }
            offset += n
        }
    }

    /// Feed inbound bytes through the deframer. One notify can carry part of a
    /// frame, a whole frame, or several.
    private func consume(_ chunk: Data) {
        inbox.append(contentsOf: chunk)
        while true {
            guard let (len, afterLen) = PBMsg.varint(inbox, 0) else { return } // truncated prefix
            if len == 0 {
                // Not a shape the Flipper emits, but dropping the prefix is the
                // only way out that doesn't spin forever on it.
                inbox.removeFirst(afterLen)
                continue
            }
            let end = afterLen + Int(len)
            guard inbox.count >= end else { return } // frame still arriving
            let msg = PBMsg(Array(inbox[afterLen..<end]))
            inbox.removeFirst(end)
            deliver(msg)
        }
    }

    private func deliver(_ msg: PBMsg) {
        let id = UInt32(truncatingIfNeeded: msg.num(Cmd.commandId) ?? 0)
        let more = (msg.num(Cmd.hasNext) ?? 0) != 0
        var resume: CheckedContinuation<[PBMsg], Error>?
        var frames: [PBMsg] = []
        lock.withLock {
            guard var p = pending[id] else { return }
            p.frames.append(msg)
            if more {
                pending[id] = p
            } else {
                pending[id] = nil
                resume = p.cont
                frames = p.frames
            }
        }
        resume?.resume(returning: frames)
    }

    private func fail(_ id: UInt32, _ error: Error) {
        var cont: CheckedContinuation<[PBMsg], Error>?
        lock.withLock {
            cont = pending[id]?.cont
            pending[id] = nil
        }
        cont?.resume(throwing: error)
    }

    private func failAllPending(_ error: Error) {
        var conts: [CheckedContinuation<[PBMsg], Error>] = []
        lock.withLock {
            conts = pending.values.compactMap { $0.cont }
            pending = [:]
        }
        for c in conts { c.resume(throwing: error) }
    }

    /// Throw on a non-OK status. The status rides the LAST frame in practice, but
    /// any frame can carry it, so check them all.
    private func checkStatus(_ frames: [PBMsg]) throws {
        for f in frames {
            if let s = f.num(Cmd.status), s != 0 { throw FlipperError.status(s) }
        }
    }

    // MARK: - Commands

    func ping() async throws {
        let frames = try await request(PB.empty(Cmd.pingReq), timeout: 8, label: "a ping")
        try checkStatus(frames)
    }

    /// DeviceInfo and PowerInfo are both streams of key/value frames.
    private func keyValues(_ field: Int, respField: Int, timeout: TimeInterval,
                           label: String) async throws -> [String: String] {
        let frames = try await request(PB.empty(field), timeout: timeout, label: label)
        try checkStatus(frames)
        var out: [String: String] = [:]
        for f in frames {
            guard let kv = f.msg(respField), let k = kv.str(1) else { continue }
            out[k] = kv.str(2) ?? ""
        }
        return out
    }

    func deviceInfo() async throws -> [String: String] {
        // 60 keys, one frame each — the slowest thing we ask for.
        try await keyValues(Cmd.deviceInfoReq, respField: Cmd.deviceInfoResp,
                            timeout: 25, label: "device info")
    }

    func powerInfo() async throws -> [String: String] {
        try await keyValues(Cmd.powerInfoReq, respField: Cmd.powerInfoResp,
                            timeout: 15, label: "power info")
    }

    func storageInfo(_ path: String = "/ext") async throws -> (total: UInt64, free: UInt64) {
        let frames = try await request(PB.sub(Cmd.storageInfoReq, PB.str(1, path)),
                                      timeout: 12, label: "free space")
        try checkStatus(frames)
        guard let r = frames.compactMap({ $0.msg(Cmd.storageInfoResp) }).first else {
            throw FlipperError.malformed("free space")
        }
        return (r.num(1) ?? 0, r.num(2) ?? 0)
    }

    /// One `alert` — the Flipper beeps, blinks and buzzes. Find-my-Flipper, and
    /// the friendliest possible proof that the link is real.
    func alert() async throws {
        let frames = try await request(PB.empty(Cmd.alertReq), timeout: 10, label: "an alert")
        try checkStatus(frames)
    }

    func md5(_ path: String) async throws -> String {
        let frames = try await request(PB.sub(Cmd.storageMd5Req, PB.str(1, path)),
                                      timeout: 20, label: "a checksum")
        try checkStatus(frames)
        guard let s = frames.compactMap({ $0.msg(Cmd.storageMd5Resp)?.str(1) }).first else {
            throw FlipperError.malformed("a checksum")
        }
        return s
    }

    /// List a folder.
    ///
    /// ⚠️ Storage.ListResponse nests TWICE: Main.8 → ListResponse.1 (repeated
    /// File) → File.{1 type, 2 name, 3 size, 5 md5sum}. Reading File's fields
    /// straight off ListResponse decodes into plausible garbage — every entry a
    /// file, every name empty, and nothing errors. That cost a spike run.
    func list(_ path: String, includeMd5: Bool = false) async throws -> [FlipperEntry] {
        var body = PB.str(1, path)
        if includeMd5 { body += PB.bool(2, true) }
        let frames = try await request(PB.sub(Cmd.storageListReq, body),
                                      timeout: 25, label: "a folder listing")
        try checkStatus(frames)
        var out: [FlipperEntry] = []
        for frame in frames {
            guard let resp = frame.msg(Cmd.storageListResp) else { continue }
            for file in resp.msgs(1) {
                guard let name = file.str(2), !name.isEmpty else { continue }
                out.append(FlipperEntry(isDir: (file.num(1) ?? 0) == 1,
                                        name: name,
                                        size: file.num(3) ?? 0,
                                        md5: file.str(5).flatMap { $0.isEmpty ? nil : $0 }))
            }
        }
        // Folders first, then alphabetical — the Flipper returns SD order, which
        // is creation order and looks arbitrary on screen.
        return out.sorted { ($0.isDir ? 0 : 1, $0.name.lowercased()) < ($1.isDir ? 0 : 1, $1.name.lowercased()) }
    }

    /// Read one file. Chunked by the firmware — a 701-byte .ir came back in two
    /// frames — so the File.data of every frame concatenates into the content.
    func read(_ path: String, maxBytes: Int = FlipperGateway.maxReadBytes) async throws -> Data {
        if let why = Self.refuseSweep(path) { throw FlipperError.refused(why) }
        // Size first. Reading and then discarding would spend the user's time and
        // the board's battery to deliver nothing.
        let stat = try await request(PB.sub(Cmd.storageStatReq, PB.str(1, path)),
                                    timeout: 12, label: "a file's size")
        try checkStatus(stat)
        let size = stat.compactMap { $0.msg(Cmd.storageStatResp)?.msg(1) }.first?.num(3) ?? 0
        if size > UInt64(maxBytes) {
            throw FlipperError.refused(
                "\(path) is \(size) bytes — too big to carry back over the relay (limit \(maxBytes)). Ask for a smaller file, or read it on the Flipper.")
        }
        let frames = try await request(PB.sub(Cmd.storageReadReq, PB.str(1, path)),
                                      timeout: 30, label: "a file")
        try checkStatus(frames)
        var data = Data()
        for f in frames {
            if let chunk = f.msg(Cmd.storageReadResp)?.msg(1)?.bytes(4) { data.append(chunk) }
        }
        return data
    }

    /// A path naming a folder of scanned credentials rather than one file in it.
    ///
    /// Ported from tiny-tech/src/agent/flipper.ts `isSensitiveSweep`, and it has
    /// to be ported rather than relied upon: that check runs in Node on the cable
    /// path, so a BLE path without its own copy is a new route around a guard
    /// that exists because these folders hold the user's real passports, national
    /// IDs and bank cards. Bulk verbs only — reading one named .nfc still works,
    /// because a person asking for one card is not an agent walking the whole
    /// wallet into a transcript.
    static func refuseSweep(_ path: String) -> String? {
        let p = path.lowercased().replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard Self.sensitiveDirs.contains(p) else { return nil }
        return "\(path) is a folder of the user's scanned cards and IDs — name a single file to read (list it first)."
    }

    // MARK: - Status

    /// Fill `info` from the board. Each piece is independent: a Flipper that
    /// answers DeviceInfo but not Storage.Info (no SD card) should still show its
    /// firmware rather than one blanket failure.
    func refresh() async {
        var next = FlipperInfo()
        if let d = try? await deviceInfo() {
            next.firmware = d["firmware_version"] ?? ""
            next.model = d["hardware_model"] ?? ""
            next.deviceName = d["hardware_name"] ?? ""
        }
        if let p = try? await powerInfo() {
            next.batteryPct = p["charge_level"].flatMap { Int($0) }
            next.chargeState = p["charge_state"] ?? ""
        }
        if let s = try? await storageInfo() {
            next.totalBytes = s.total
            next.freeBytes = s.free
        }
        // `let` before the hop: a var captured by a concurrently-executing
        // closure is an error under Swift 6.
        let reading = next
        await MainActor.run {
            // Keep the last good reading if this attempt learned nothing — a
            // blank panel is worse than a stale line, and the caller shows when.
            if reading != FlipperInfo() { self.info = reading }
        }
    }

    /// The one-line answer for `flipper_status` when the phone is the host.
    /// Names the transport, because "over Bluetooth from this phone" is the
    /// difference between a Flipper in the user's pocket and one on a desk.
    func statusLine() async -> String {
        guard linked else {
            return unit == nil
                ? "No Flipper is paired with this phone."
                : "\(unit!.name) is paired but not connected right now — it's out of range or powered off."
        }
        await refresh()
        let name = unit?.name ?? "Flipper"
        return "\(name) — \(info?.summary ?? "linked") (over Bluetooth from this phone)"
    }
}

// MARK: - CoreBluetooth

extension FlipperGateway: CBCentralManagerDelegate, CBPeripheralDelegate {
    /// REQUIRED once CBCentralManagerOptionRestoreIdentifierKey is set: without
    /// it CoreBluetooth drops the restored peripheral, which leaves the app
    /// holding a link it does not know about — worse than not restoring, because
    /// the board's single connection slot is occupied while we re-dial it.
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
              let u = unit,
              let p = restored.first(where: { $0.identifier == u.peripheralId })
        else { return }
        self.central = central
        peripheral = p
        p.delegate = self
        wanted = true
        if p.state == .connected {
            // Re-discover rather than assume the characteristic handles survived.
            p.discoverServices([flipperServiceUUID])
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if unit != nil { connectIfPossible() }
            if scanning { beginScanIfPossible() }
        case .poweredOff:
            linked = false
            lastError = "Bluetooth is off — the phone can't reach the Flipper without it."
        case .unauthorized:
            linked = false
            lastError = "Bluetooth permission denied — the Flipper link needs it."
        default:
            linked = false
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let advName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
        let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        // Either signal is enough: the serial service in the advertisement, or
        // the name the Flipper ships with ("Flipper <Name>").
        guard services.contains(flipperServiceUUID) || advName.lowercased().hasPrefix("flipper") else { return }
        let f = Found(id: peripheral.identifier,
                      name: advName.isEmpty ? "Flipper" : advName,
                      rssi: RSSI.intValue)
        if let i = found.firstIndex(where: { $0.id == f.id }) {
            found[i] = f
        } else {
            found.append(f)
        }
        found.sort { $0.rssi > $1.rssi } // nearest first
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        lastError = nil
        inbox = []
        lock.withLock { credits = nil }
        peripheral.discoverServices([flipperServiceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        linked = false
        lastError = error?.localizedDescription ?? "Couldn't connect to the Flipper."
        scheduleReconnect() // backoff, not an instant re-dial
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        linked = false
        rxChar = nil
        inbox = []
        lock.withLock { credits = nil }
        // Anything mid-flight is gone with the link. Failing it now turns a
        // 15-second wait into an immediate, accurate answer.
        failAllPending(FlipperError.notLinked)
        // Reset the backoff only for a link that LASTED — that is what tells
        // walking out of range apart from a board that drops us on sight.
        if let since = linkedAt, Date().timeIntervalSince(since) >= Self.goodLinkS {
            reconnectDelay = Self.reconnectBaseS
        }
        linkedAt = nil
        scheduleReconnect()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == flipperServiceUUID }) else {
            lastError = "That device doesn't expose the Flipper's serial service."
            return
        }
        peripheral.discoverCharacteristics([flipperTxUUID, flipperRxUUID, flipperFlowUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for ch in service.characteristics ?? [] {
            switch ch.uuid {
            case flipperTxUUID:
                // This subscribe is what raises the pairing prompt: the
                // characteristic is authenticated-read/write in the firmware, so
                // iOS bonds here and the Flipper shows its 6-digit code.
                peripheral.setNotifyValue(true, for: ch)
            case flipperRxUUID:
                rxChar = ch
                rxWriteType = ch.properties.contains(.write) ? .withResponse : .withoutResponse
            case flipperFlowUUID:
                peripheral.setNotifyValue(true, for: ch)
            default:
                break
            }
        }
        guard rxChar != nil else {
            lastError = "The Flipper's serial service is missing its write characteristic."
            return
        }
        // RPC is already open: the firmware calls rpc_session_open(RpcOwnerBle)
        // from its own GapEventTypeConnected handler (bt.c). There is no
        // start_rpc_session over BLE — sending one would be a protobuf frame of
        // ASCII text. So the next thing to do is simply ask it something.
        finishLink()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let value = characteristic.value else { return }
        switch characteristic.uuid {
        case flipperTxUUID:
            consume(value)
        case flipperFlowUUID:
            // Big-endian uint32, byte-reversed relative to everything else on
            // this service. Straight from the firmware's serial service.
            guard value.count >= 4 else { return }
            let free = value.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
            lock.withLock { credits = free }
        default:
            break
        }
    }
}

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
import UIKit

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
    // The two things BLE can do that the USB CLI cannot: see the screen and
    // press the buttons. There is no `screenshot` and no `input` command in the
    // text CLI at all, so this half of the panel has no cabled equivalent.
    static let guiStartStreamReq = 20, guiStopStreamReq = 21
    static let guiScreenFrame = 22, guiInputReq = 23
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
    /// Asked with no link at all: `writeFrame` found no characteristic to write
    /// to, so nothing left the phone and nothing can have happened.
    ///
    /// ⚠️ NOT the error for a link that dropped with a request already in flight.
    /// That is `.linkDropped`, and keeping the two apart is the whole of c31: this
    /// sentence is a promise that the board is untouched, and only a request that
    /// never reached the write can keep it.
    case notLinked
    /// An answer that never came — and, second, whether the question did.
    ///
    /// ⚠️ `sent` is the fact this case used to leave out, and it is the one the
    /// reader needs. The timeout timer in `request(_:timeout:label:)` runs
    /// independently of the write queue, so it can fire in two completely
    /// different worlds: the frame was still queued behind another command (the
    /// board never saw it, `writeFrame`'s `pending[id]` guard then drops it
    /// unsent), or the bytes went out and only the reply is missing. For a read
    /// those are the same story. For anything that CHANGES the board they are
    /// opposite ones, and "the Flipper didn't answer" reads as "it didn't
    /// happen" — which is how a beep that sounded gets reported as a dead link,
    /// and asked for again. `.noRoom` has said "the command wasn't sent" since
    /// P1 precisely because that distinction decides what to do next; this case
    /// simply never carried it.
    case timeout(String, sent: Bool)
    /// The link went away with this request in flight — the phone walked out of
    /// range, Bluetooth was switched off, the board was powered down, or `stop()`
    /// tore the link down on purpose.
    ///
    /// ⚠️ Carries `sent` for the same reason `.timeout` does, and it is the same
    /// bug one terminator over: c30 taught the timer to say which of the two
    /// worlds it was in, and this — the terminator P5's own acceptance run walks
    /// into, because walking away from the board IS the disconnect — went on
    /// answering with `.notLinked`, i.e. "no Flipper is linked to this phone", a
    /// sentence whose only reading is "so nothing happened". For a beep already
    /// sounding in the next room that is false, and the remedy it suggests is the
    /// pairing screen, one row away from "Forget all paired devices".
    case linkDropped(sent: Bool)
    case status(UInt64)
    case refused(String)
    case malformed(String)
    /// The inbound stream lost its place, so this request's answer can never be
    /// read even if the bytes are sitting in the buffer (see `desync(_:)`).
    ///
    /// Distinct from `.malformed`, which is an answer that DID arrive whole and
    /// then failed to parse — there the board is known to have acted; here, as
    /// with `.timeout` and `.linkDropped`, only `sent` knows.
    case desynced(sent: Bool)
    /// The board's receive buffer never drained enough to take the whole
    /// command. Its own error, not a timeout, because the cause and the cure are
    /// different: nothing was sent, and retrying in a moment usually works.
    case noRoom

    var errorDescription: String? {
        switch self {
        case .notLinked:
            return "No Flipper is linked to this phone over Bluetooth."
        case .timeout(let what, let sent):
            return sent
                ? "The Flipper didn't answer \(what) in time, though the request did reach it."
                : "The Flipper never received \(what) — the request was still queued behind another command when time ran out."
        case .linkDropped(let sent):
            return sent
                ? "The Bluetooth link to the Flipper dropped before its answer came back, though the request did reach the board."
                : "The Bluetooth link to the Flipper dropped while the request was still queued, so the board never saw it."
        case .status(let code):
            return flipperStatusText(code)
        case .refused(let why):
            return why
        case .malformed(let what):
            return "The Flipper's answer to \(what) didn't parse."
        case .desynced(let sent):
            return sent
                ? "The Flipper's Bluetooth stream lost its place, so its answer can no longer be read, though the request did reach the board."
                : "The Flipper's Bluetooth stream lost its place while the request was still queued, so the board never saw it."
        case .noRoom:
            return "The Flipper's Bluetooth buffer stayed full, so the command wasn't sent. Try again in a moment."
        }
    }

    /// Whether the board may have carried the command out in spite of this error.
    ///
    /// The one fact that decides what the reader should do next, and the reason
    /// three of these cases carry `sent` at all: a request that reached the board
    /// may already have beeped, pressed a button or written a file, so "ask
    /// again" is a second effect rather than a second answer.
    ///
    /// ⚠️ Exhaustive on purpose — no `default:`. A case added later cannot compile
    /// until somebody decides which side of this line it falls on, which is a
    /// guarantee no test in this repo can make: what let c31 exist is that c30
    /// answered the question for `.timeout` in an `if case` at the call site, so
    /// the other two terminators were never asked.
    var mayHaveRun: Bool {
        switch self {
        // The three that end a request with no answer. Only the flag recorded at
        // the commit point in `writeFrame` knows, so ask it rather than guess.
        case .timeout(_, let sent): return sent
        case .linkDropped(let sent): return sent
        case .desynced(let sent): return sent
        // An answer came back and would not parse. Whatever the board did, it did
        // — the frame was written, acknowledged, and reassembled this far.
        case .malformed: return true
        // Definite noes, each from a different party: the board itself reported it
        // did not do it (`.status`); its buffer never took the frame (`.noRoom`);
        // there was no link to write to (`.notLinked`); the phone's own credential
        // guard turned the command down before any of this (`.refused`).
        case .status, .noRoom, .notLinked, .refused: return false
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

/// The three independent reads one `refresh()` makes, so a reading that came back
/// short can say WHICH part is missing.
///
/// ⚠️ Every bit of `FlipperInfo.summary` is conditional, which means a read that
/// never landed does not show up as an error or a gap — the line simply gets
/// shorter. "unlshd-075 · Flipper C2" is what a board that answered DeviceInfo and
/// nothing else looks like, and it is indistinguishable from a Flipper with no
/// battery and no SD card, on a line stamped "read just now".
enum FlipperRead: String, CaseIterable {
    case device, power, storage

    /// What the reader loses when this read leaves nothing behind. No "its" — the
    /// frame in `missingLine(_:)` supplies one, so three gaps read as one list
    /// rather than three claims.
    var subject: String {
        switch self {
        case .device: return "firmware and model"
        case .power: return "battery level"
        case .storage: return "SD card"
        }
    }
}

/// How one read ENDED — recorded while it is still knowable, because nothing in
/// the values can tell these three apart afterwards.
///
/// ⚠️ This exists because the sentence that explained a gap was true of one road
/// to it and said so for all three. A read this phone never issued, a read that
/// failed, and a read the board ANSWERED WITHOUT THE FIELD take exactly the same
/// words out of `FlipperInfo.summary`, and only the first of them is this phone's
/// clock running out. Blaming the clock for the other two is c31's `.notLinked`
/// over a frame that went out, one layer up: a cause invented for a state nobody
/// recorded.
enum FlipperReadOutcome {
    /// Never issued: `allow()` had less than `minRequestS` of the budget left, so
    /// this phone ran out of its own time. ⚠️ Only reachable on a rail that passes
    /// a budget at all — the panel's `refresh()` and `finishLink`'s pass none, so
    /// on those rails a gap is NEVER this.
    case unasked
    /// Issued, and it failed — with the board's or the link's own words, which are
    /// the only words about it worth printing (`.status(17)` is an app open on the
    /// board's screen, said by the board).
    case failed(Error)
    /// Issued, and the board answered — the value simply was not in the answer.
    /// `keyValues` returns an empty dictionary rather than throwing when no frame
    /// carries a key, and `p["charge_level"].flatMap { Int($0) }` is nil for a key
    /// that is absent OR that does not parse (`Int("94.5")` is nil). Nothing
    /// throws, nothing was skipped, and there is nothing for the reader to fix on
    /// this side.
    case answered
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

    /// Which reads left nothing in this reading — asked of the VALUES, not of the
    /// requests.
    ///
    /// It has to be the values, because the values are what the reader sees: a read
    /// that failed, a read this phone never got round to asking, and a board that
    /// answered without the field all take the same words out of `summary` above.
    /// Deriving it from the same properties `summary` tests is what keeps the line
    /// and the sentence that explains it from disagreeing (hazard 21).
    ///
    /// `deviceName` is deliberately not here: `summary` never prints it, so nothing
    /// is missing from the reader's line when it is absent.
    var gaps: [FlipperRead] {
        var out: [FlipperRead] = []
        // One read fills both, so either one present means DeviceInfo answered.
        if firmware.isEmpty && model.isEmpty { out.append(.device) }
        if batteryPct == nil { out.append(.power) }
        if freeBytes == nil { out.append(.storage) }
        return out
    }
}

/// One redraw of the Flipper's screen, exactly as the board sent it.
struct FlipperFrame: Equatable {
    /// 1024 bytes: u8g2's page buffer, which is what the firmware hands the
    /// framebuffer callback. Eight pages of 128 columns, one byte per column per
    /// page, and the byte's bits run DOWN the screen — bit `y % 8`, LSB topmost.
    /// Read it as 128 bytes per row instead and you get a recognisable-looking
    /// smear rather than an obvious failure.
    let data: Data
    /// PB_Gui.ScreenOrientation: 0 horizontal, 1 flipped 180°, 2/3 vertical.
    /// The buffer is always 128×64 page-major — orientation says how the board
    /// wants it shown, it does not change the layout.
    let orientation: Int
    /// Frames since this stream started. Two identical redraws are equal by
    /// content, so without a counter a live-but-static screen is indistinguishable
    /// from a stream that died.
    let seq: Int
}

/// PB_Gui.InputKey. The Flipper's six buttons, by their firmware numbers.
enum FlipperKey: Int, CaseIterable, Identifiable {
    case up = 0, down = 1, right = 2, left = 3, ok = 4, back = 5

    var id: Int { rawValue }

    var symbol: String {
        switch self {
        case .up: return "chevron.up"
        case .down: return "chevron.down"
        case .right: return "chevron.right"
        case .left: return "chevron.left"
        case .ok: return "circle"
        case .back: return "arrow.uturn.backward"
        }
    }

    var label: String {
        switch self {
        case .up: return "Up"
        case .down: return "Down"
        case .right: return "Right"
        case .left: return "Left"
        case .ok: return "OK"
        case .back: return "Back"
        }
    }
}

/// PB_Gui.InputType. REPEAT (4) is deliberately absent: auto-repeat is something
/// the board's own input service synthesises for a key it can see being held, and
/// a client that sends REPEAT for a finger it cannot feel is guessing.
enum FlipperInputType: Int {
    case press = 0, release = 1, short = 2, long = 3
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
    /// When `info` was actually READ off the board — not when someone last asked.
    ///
    /// ⚠️ These are the two facts a reading has, and they have to travel together.
    /// `refresh()` keeps the previous `info` when a read fails, deliberately (a
    /// blank panel is worse than a stale line), which means every consumer is
    /// holding something that may be minutes old with no way to tell. A battery
    /// percentage and a free-space figure are exactly the kind of fact that reads
    /// as current, so a stale one presented plainly is not a small inaccuracy —
    /// it is the app saying a dead board is at 100%.
    ///
    /// ⚠️ A reading is replaced WHOLE, never merged field by field, so everything in
    /// `info` was read at `infoAt` and one date can speak for all of it. The price is
    /// that a partial reading drops values nothing refuted (yesterday's battery is
    /// gone when only DeviceInfo answers today) — paid deliberately: carrying them
    /// forward under this one timestamp is exactly the "🔋 100% charged" lie above,
    /// and `FlipperInfo.gaps` says what is absent instead of quietly filling it in.
    @Published private(set) var infoAt: Date?
    @Published private(set) var lastError: String?
    /// THIS PHONE's Bluetooth radio, as CoreBluetooth last reported it.
    ///
    /// ⚠️ Published, and not merely readable off `central?.state`, because a
    /// sentence on a screen that depends on a value needs that value to be
    /// observable. `outage(radio:unit:for:)` is that sentence: with the radio off
    /// it says the phone is the reason. A `central.state` read behind a
    /// non-`@Published` `private var` cannot move that row when the user switches
    /// the radio back on, and `connectIfPossible()` may then sit in a connection
    /// that never calls back — leaving the panel accusing a radio that is on.
    ///
    /// ⚠️ Read THIS, never `lastError`, when deciding what is wrong now: a stored
    /// diagnosis proves its writer ran, not that it is still true. `lastError`
    /// survives until `didConnect` clears it, so it is a description of the past.
    @Published private(set) var radio: CBManagerState = .unknown
    @Published private(set) var scanning = false
    @Published private(set) var found: [Found] = []
    /// Set while a relay envelope is being served, so the devices panel can show
    /// that the web agent is talking to the Flipper through this phone.
    @Published var activity = ""
    /// True between StartScreenStream and StopScreenStream. The board pushes a
    /// frame on every redraw until it is told to stop, so this is also the flag
    /// that says whether someone still owes it a stop.
    @Published private(set) var streaming = false
    /// The last redraw. nil while not streaming — a frozen picture of a menu the
    /// user has since walked away from would be a lie about a live view.
    @Published private(set) var screenFrame: FlipperFrame?

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var rxChar: CBCharacteristic?
    private var rxWriteType: CBCharacteristicWriteType = .withResponse
    private var reconnectTask: Task<Void, Never>?
    /// Literal, not `Self.reconnectBaseS`: a covariant `Self` cannot be
    /// referenced from a stored property initializer.
    private var reconnectDelay: TimeInterval = 1
    private var linkedAt: Date?
    /// True from the moment the TX subscription is confirmed until the proving
    /// ping resolves. iOS re-writes the CCCD on a state restore, so
    /// `didUpdateNotificationStateFor` can fire for a characteristic that is
    /// already notifying — without this, that second callback starts a second
    /// ping against a link the first one is still proving.
    private var linking = false
    /// Guards the permission prompt: merely instantiating CBCentralManager asks
    /// for Bluetooth, and a user with no Flipper should never be asked because of
    /// this file.
    ///
    /// ⚠️ Also the difference between "not connected" and "not coming back".
    /// `scheduleReconnect()` returns at this flag, so with it clear NOTHING
    /// re-dials — and `stop()` clears it in exactly one situation that leaves a
    /// board still remembered: a TX subscription that failed, i.e. a pairing that
    /// did not hold. `outage(radio:unit:dialling:for:)` reads it, which is why it
    /// is `@Published` (same reason as `radio`): a plain `private var` cannot move
    /// the row when the phone gives up or when Reconnect starts it again.
    @Published private var wanted = false
    /// `wanted`'s counterpart for the mirror: a view is on screen showing it.
    /// Distinct from `streaming`, which is whether the BOARD is pushing frames —
    /// the two diverge on purpose while the app is in the background, where the
    /// stream is stopped but still owed back to the view that asked for it.
    private var streamWanted = false
    /// The same split for the pairing scan: a sheet is asking to see Flippers.
    /// `scanning` is whether the RADIO is scanning, and the two diverge in exactly
    /// the window that matters — backgrounded, where a scan cannot work and must
    /// not be left armed, but is still owed to the sheet that is still on screen.
    private var scanWanted = false
    /// Whether this app can currently show a frame, maintained by the two phase
    /// observers in `init()`. A resume needs BOTH this and `streamWanted`: a view
    /// wanting frames says nothing about whether anyone can see them.
    ///
    /// ⚠️ Deliberately NOT derived from `UIApplication.applicationState`. Every
    /// read would happen *during* a phase transition, which is the one moment that
    /// value is ambiguous: at `willEnterForegroundNotification` the app has not yet
    /// become active, so a guard written against `.active` would block the very
    /// resume that notification exists to trigger.
    ///
    /// Starting `true` is safe even for a process launched straight into the
    /// background (a BGAppRefresh beat): `streamWanted` is not persisted, so a
    /// fresh process has nothing owed, and only a view on screen can set it.
    private var foreground = true
    /// Kept so the pair can be found from one place. NotificationCenter owns the
    /// blocks and this singleton never deinits, so nothing removes them.
    private var phaseObservers: [NSObjectProtocol] = []

    /// Rolling inbound bytes. BLE notifies arrive in MTU-sized pieces with no
    /// regard for frame boundaries, so a 60-frame DeviceInfo can land as any
    /// number of notifies and one notify can hold several frames.
    private var inbox: [UInt8] = []
    private var frameSeq = 0
    /// The tail of the button-event chain. See `send(_:hold:)`.
    private var inputChain: Task<Error?, Never>?
    /// The tail of the outbound frame chain. See `enqueueWrite`.
    private var writeChain: Task<Void, Never>?

    private let lock = NSLock()
    private var nextId: UInt32 = 1
    private struct Pending {
        var frames: [PBMsg] = []
        var cont: CheckedContinuation<[PBMsg], Error>?
        /// True once the last chunk of this request's frame is on the wire, so a
        /// timeout can say whether the board ever got the command. Lives here
        /// rather than in a set beside `pending` because it dies with the entry:
        /// `fail` clears the id, and anything asking afterwards would read the
        /// default and report a sent command as never sent.
        var sent = false
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
    /// Largest file the phone will pull off the SD card — refused by SIZE before
    /// reading, rather than spending the transfer and then throwing the bytes away.
    ///
    /// ⚠️ ONE number, TWO readers, and only one of them is a relay. Both stop at
    /// 6000 for reasons that happen to agree: the relay cannot deliver more (an
    /// 8 KB envelope, a reply truncated at 7000 characters), and the Files sheet
    /// would spend a slow Bluetooth link pulling a 90 KB `.fap` in order to render
    /// `hexPreviewBytes` of it. The NUMBER is shared on purpose — a private copy
    /// per surface is the exact drift that once made one file read two ways — but
    /// the SENTENCE cannot be, because the two remedies belong to different
    /// people. See `ReadAudience`.
    static let maxReadBytes = 6000

    /// Who the bytes are for, which decides what to say when they will not fit.
    ///
    /// ⚠️ There was one refusal and it was the relay's, so the only caller that
    /// actually reads files got the wrong one. Tap `/ext/Manifest` — 78745 bytes
    /// on this board, measured over the cable, in the first folder the SD browser
    /// opens — and the app answered *"too big to carry back over the relay (limit
    /// 6000). Ask for a smaller file, or read it on the Flipper."* The person
    /// holding the phone is not using a relay, cannot "ask" anyone for a smaller
    /// file, and never mentioned one; two thirds of that sentence was addressed to
    /// somebody else. Nor is it a corner case — **6 of the 26 files in this
    /// board's non-sensitive folders are over the ceiling**, and 5 of those live
    /// in one folder of installed apps.
    enum ReadAudience {
        /// Bound for a relay reply, read by the agent (`Session.swift`).
        case relayReply
        /// Bound for this phone's own screen, read by the person holding it.
        case panelSheet
    }

    /// The refusal for a file that will not fit, in the words of whoever asked.
    static func tooBig(_ path: String, size: UInt64, limit: Int,
                       for audience: ReadAudience) -> String {
        switch audience {
        case .relayReply:
            return "\(path) is \(size) bytes — too big to carry back over the relay (limit \(limit)). Ask for a smaller file, or read it on the Flipper."
        case .panelSheet:
            // No relay in this sentence, and a remedy the reader can act on with
            // the board in their other hand. It deliberately does NOT offer a
            // preview instead: a text file under the limit is shown WHOLE here, so
            // "you would only see the first 1024 bytes" would be false for exactly
            // the files this sheet reads best.
            return "\(path) is \(size) bytes — more than this phone will pull over Bluetooth (limit \(limit)). Open it on the Flipper itself."
        }
    }

    /// What an `alert()` that came back OK actually proves — in the words of
    /// whoever asked for it.
    ///
    /// ⚠️ NOT "it beeped". `Gui.PlayAudiovisualAlert` hands the board a
    /// notification and the BOARD decides what that turns into. Measured on the
    /// user's own C2 (unlshd-075) by reading `/int/.notification.settings` over
    /// the cable — 24 bytes, version 2: display 1.0 · LED 1.0 · speaker 1.0 ·
    /// display-off 1800000ms · **vibro_on 0**. So the sentence this replaced
    /// ("beeped, blinked *and buzzed*") was already false on that very board in
    /// the third of its three claims, and the RPC answers OK either way: the
    /// protocol carries no acoustic feedback, so nothing on this side can ever
    /// know what was heard. What an OK does prove is the LINK — so that is what
    /// this says, and the rest is named as the board's own switches.
    ///
    /// This matters most where the loop leans on it hardest: `flipper_find` is
    /// step one of the P5 acceptance run (docs/flipper-ble-ios-design.md §5)
    /// *because* a noise from the board is the one answer nothing can fake. A
    /// muted board must therefore not read as a dead link.
    ///
    /// The screen is named exactly as the board's own menu names it — `loader list`
    /// on this board answers "LCD and Notifications" — and that row sits directly
    /// BELOW "Bluetooth", so a vaguer "check its settings" aims the reader at the
    /// menu holding **"Forget all paired devices"**. Hazard 4; c24 deleted a whole
    /// sentence for pointing there.
    static func alertSent(for audience: ReadAudience) -> String {
        switch audience {
        case .relayReply:
            return "🔔 The Flipper accepted the alert over Bluetooth from this phone. That is the board acknowledging the command, not a sound anybody heard: it plays its own audiovisual alert, whose volume, vibration and LED are three separate switches on the board (Settings → LCD and Notifications), and it answers OK with any of them turned down. So this proves the Bluetooth link is live — if nobody found the Flipper, doubt that screen before the link."
        case .panelSheet:
            return "🔔 Sent — the Flipper acknowledged it. If you heard nothing, volume, vibration and the LED are separate switches on the board itself: Settings → LCD and Notifications."
        }
    }

    /// Envelope actions that only ever LOOK at the board. Everything else is
    /// assumed to have changed something.
    ///
    /// ⚠️ The polarity is the point, and it is the opposite of the obvious one. An
    /// allow-list of *effects* would be wrong the first time an action is added —
    /// the new verb would inherit "nothing on the board changed, so asking again
    /// is free", which is the sentence you least want in front of a `delete` or a
    /// `write`. Listing the reads instead means an unclassified action inherits
    /// the careful sentence and the worst case is one turn of unnecessary caution.
    /// Hazard 25(a): the side of a list that ages is the side that lies, so age it
    /// toward silence, not toward reassurance.
    ///
    /// It is not a hypothetical either. `press` and `screen` — the panel's own
    /// buttons — are in neither list and take the cautious arm today, which is
    /// the correct sentence for both: a keypress whose reply was late was very
    /// possibly taken by the board (`send(_:hold:)`'s doc, which is why it always
    /// sends the RELEASE).
    ///
    /// `status`/`info` were listed here for a reader that did not exist yet, and
    /// c30 said so: `statusLine()` wrapped its own three reads in `try?`, so no
    /// status failure could reach a sentence at all. c32 handed it the failure, and
    /// this classification is what turns it into "asking again costs nothing but
    /// the wait" instead of a warning about a board that a read never touched.
    /// Being a read is a property of the ACTION, which is exactly why it was right
    /// to classify them before anything could ask.
    static let readOnlyActions: Set<String> = ["status", "info", "files", "ls", "list", "read", "md5"]

    /// The actions that make the board do something a person in the room can
    /// perceive. Mirrors `handleFlipperEnvelope`'s alert case; `tests/flipper-ble.test.ts`
    /// pins the two to each other, because a label added there and not here would
    /// silently downgrade the beep to "nothing changed".
    static let alertActions: Set<String> = ["alert", "beep", "find"]

    /// What an unconfirmed command leaves undecided — the sentence that has to sit
    /// beside any `FlipperError` whose `mayHaveRun` is true, in the words of
    /// whoever asked.
    ///
    /// The fact itself is in the error: the request reached the board, so the
    /// answer is what went missing. What that MEANS is per-action, and for one
    /// action it is the whole point of the feature. `flipper_find` is step one of
    /// the P5 acceptance run (docs/flipper-ble-ios-design.md §5) *because* a noise
    /// from the board is the one answer nothing can fake — so a beep that sounded
    /// while the reply was late must not come back looking like a dead link.
    /// Whoever reads that will do the obvious thing and ask again, and on this
    /// rail asking again is a SECOND ALERT, not a second answer.
    ///
    /// This is `lib/chat/tools/flipper.ts`'s `bleStillQueued` one layer down and
    /// for a different reason: there the backend stopped waiting while the
    /// envelope was still queued; here the phone waited, the board has the
    /// command, and the reply is the only thing that did not arrive. Both are the
    /// same omission — a give-up is not a cancel — and this is the layer that
    /// knows it happened, so it is the layer that has to say so.
    ///
    /// ⚠️ Not just the timer, which is why this is no longer called
    /// `afterTimeout`. THREE terminators end a request with no answer — the timer,
    /// a link that dropped mid-flight (`linkLost`), and a stream that lost its
    /// place (`desync`) — and the last two are the ones P5's acceptance run
    /// actually walks into, because walking away from the board with a request in
    /// flight is a disconnect. Naming this after the timer is what kept the other
    /// two from being asked; `FlipperError.mayHaveRun` now decides, exhaustively.
    ///
    /// ONE `switch audience`, with the action classified ahead of it. Two
    /// switches on this enum in one body make every by-label slice in
    /// `tests/flipper-ble.test.ts` ambiguous — it would read the first arm it
    /// found and cover the other for free (see `abandoned`, which exists for
    /// that reason).
    static func afterUnconfirmed(action: String, for audience: ReadAudience) -> String {
        let a = action.lowercased()
        let reads = readOnlyActions.contains(a)
        let perceivable = alertActions.contains(a)
        switch audience {
        case .relayReply:
            if reads {
                return "Nothing on the board changed — this only reads it — so asking again costs nothing but the wait."
            }
            return perceivable
                ? "The board has the alert, so it may well have sounded already — asking again sends a SECOND alert rather than getting a second answer. If somebody is near the Flipper, have them listen before this is retried."
                : "The board has the command, so it may already have run. Repeating it is not a safe way to find out; read the board's own state first."
        case .panelSheet:
            if reads {
                return "Nothing on the Flipper changed; try again when it is closer."
            }
            return perceivable
                ? "It may have sounded already — listen for it before tapping again, since a second tap is a second alert rather than an answer."
                : "The Flipper may have done it anyway — check the board before repeating it."
        }
    }

    /// The sentence a failed Flipper action gets, for whoever asked — the single
    /// place that decides when a failure needs `afterUnconfirmed`'s clause.
    ///
    /// Both readers of a thrown `FlipperError` go through here (the relay reply in
    /// `Session.handleFlipperEnvelope`, the Beep button in `FlipperBlePanel`), so
    /// the two cannot disagree about what a timeout meant — hazard 21: the fact
    /// and the sentence that discloses it are ONE thing.
    ///
    /// ⚠️ The decision is `FlipperError.mayHaveRun`, asked of the error, not a
    /// pattern match on one case. c30 wrote `if case .timeout(_, let sent)` here,
    /// and the shape of that line is why c31 exists: it answers the question for
    /// the case it names and silently answers "no" for every other terminator,
    /// including the two that fail a request in flight without any timer. Asking
    /// the error means a case added later has to have decided (that switch is
    /// exhaustive, no `default:`) before it can compile at all.
    ///
    /// The errors that must keep their sentence word for word still do: `.noRoom`
    /// says the command was *not* sent, `.refused` is the credential guard turning
    /// down a folder of passports, and appending "it may already have run" to
    /// either would be a lie in the one direction that matters.
    static func actionFailed(_ error: Error, action: String,
                             for audience: ReadAudience) -> String {
        let text = error.localizedDescription
        if let flip = error as? FlipperError, flip.mayHaveRun {
            return "\(text) \(afterUnconfirmed(action: action, for: audience))"
        }
        return text
    }

    /// Why ONE read left nothing behind, in the words of whoever is asking.
    ///
    /// ⚠️ The three roads to a gap are three different parties, and the version of
    /// this that took an `Error?` could only tell two of them apart: nil meant "this
    /// phone ran out of time", so a board that answered WITHOUT the field — which
    /// throws nothing — was reported as this phone being slow. On the panel rail
    /// that was wrong every time: `refresh()` there is given no budget, so no read
    /// can ever be skipped, and `.unasked` is unreachable (hazard 35(a): compute who
    /// can reach a branch per rail, not from the constant). It also handed one read's
    /// error to a read that was never made, because there was one cause for a whole
    /// reading.
    ///
    /// ⚠️ No `switch audience` of its own, deliberately: `actionFailed` already owns
    /// that decision, and a second `switch audience` in this file's status path makes
    /// every by-label slice in `tests/flipper-ble.test.ts` ambiguous (31(c)). The
    /// action is `"status"` — the `readOnlyActions` entry whose only reader is this —
    /// so a read that may have landed says "asking again costs nothing but the wait".
    static func whyGap(_ outcome: FlipperReadOutcome, for audience: ReadAudience) -> String {
        switch outcome {
        // Not the board's silence: `refresh`'s own budget ran out before it could
        // spend `minRequestS` here. Blaming the Flipper for a request this phone
        // never made is the same lie as `.notLinked` over a frame that went out
        // (c31) — so say whose clock it was.
        case .unasked: return "This phone ran out of its own time before it could ask."
        // The board reports its own reasons and they were being thrown away by three
        // `try?`s (c32), after which both surfaces invented one in the same words for
        // every cause. A guess that is right sometimes is still a guess, and this
        // one pointed at the board — which on P5's acceptance run is the thing the
        // asker walked away from, one room and one dropped link ago.
        case .failed(let error): return actionFailed(error, action: "status", for: audience)
        // Nothing about this phone, the link or the clock is wrong, so no remedy is
        // offered: what a reader can do about a board that answers without a field is
        // not knowable from here, and pointing them at the board is 38(b). The one
        // honest thing is that it ANSWERED — which rules out everything the other two
        // sentences would have them chase.
        case .answered: return "The Flipper answered; what is missing was not in what it said."
        }
    }

    /// One clause per distinct reason, with the reads that share a reason grouped
    /// under it, in the order the reads are made.
    ///
    /// Grouped by the SENTENCE rather than by the case: two reads that failed the
    /// same way are one fact, and a reader handed the same sentence twice reads it as
    /// two problems. It also means two reads that failed DIFFERENTLY each keep their
    /// own words, which the single `because:` this replaces could not do.
    static func gapReasons(_ reads: [FlipperRead], _ outcomes: [FlipperRead: FlipperReadOutcome],
                           for audience: ReadAudience) -> [(reads: [FlipperRead], why: String)] {
        var out: [(reads: [FlipperRead], why: String)] = []
        for read in reads {
            let why = whyGap(outcomes[read] ?? .unasked, for: audience)
            if let i = out.firstIndex(where: { $0.why == why }) { out[i].reads.append(read) }
            else { out.append((reads: [read], why: why)) }
        }
        return out
    }

    /// Why nothing usable came back, in the words of whoever is asking — the two
    /// no-reading arms' clause.
    ///
    /// The same sentences a gap gets, because a total failure is every read leaving
    /// nothing and one read leaving nothing is a gap (39(c)): a second maker is how
    /// one reading ends up described two ways. No subjects are named here — the arm
    /// that prints this has already said no reading came back at all.
    static func whyNoReading(_ reading: Reading, for audience: ReadAudience) -> String {
        gapReasons(reading.missing, reading.outcomes, for: audience)
            .map(\.why).joined(separator: " ")
    }

    /// What a reading does not contain, in one sentence — nil when it contains
    /// everything.
    ///
    /// ONE frame, and no audience: this is the same fact for the person holding the
    /// phone and for a web chat. A second frame is how the same reading ends up
    /// described two ways (hazard 21).
    ///
    /// Two kinds of caller, and the difference is WHICH reading: `gapClause` asks it
    /// of the one a caller just took, while the panel row and `statusLine`'s
    /// remembered-reading arm ask it of the one that is STORED — because a short line
    /// stays short for as long as it is on screen or in a reply, long after the
    /// refresh that took it is over. Anywhere `FlipperInfo.summary` is rendered, this
    /// belongs beside it; the arm that quoted a remembered summary WITHOUT it was
    /// found by counting the summary's renderers rather than this function's callers.
    static func missingLine(_ gaps: [FlipperRead]) -> String? {
        guard !gaps.isEmpty else { return nil }
        return "Missing from this reading: its \(subjectList(gaps))."
    }

    /// Some reads as one list of subjects — "battery level and SD card".
    ///
    /// The ONLY place a read becomes words: the frame above and the per-reason
    /// clauses below both build their lists here, so a surface cannot word its own
    /// (39(f) — a count of MY frame's words is blind to a sentence that rewords, and
    /// a mutant that had the panel row invent its own list survived exactly that).
    ///
    /// No verb — "its firmware and model" is one read but reads plural, so any
    /// is/are agreement is wrong for one of the three cases. A label cannot be
    /// conjugated wrongly.
    static func subjectList(_ reads: [FlipperRead]) -> String {
        let subjects = reads.map(\.subject)
        return subjects.count == 1
            ? subjects[0]
            : subjects.dropLast().joined(separator: ", ") + " and " + (subjects.last ?? "")
    }

    /// The clause a PARTIAL reading gets appended to it — what is missing, then why,
    /// in the words of whoever is asking. Empty when nothing is missing, so the
    /// complete case is unchanged.
    ///
    /// The causes are `whyGap`'s, which is the point: a gap and a total failure have
    /// exactly the same causes, and the board's own words about a running app
    /// (`.status(17)`) explain a missing battery as well as they explain a missing
    /// reading. What is NOT shared is one cause for a whole reading — each gap is
    /// explained by what happened to ITS read.
    ///
    /// ⚠️ One reason for every gap and the sentence stands alone: the frame has just
    /// named them all. Two or more and each names the gaps it accounts for, because a
    /// cause that names no subject is read as the cause of all of them — which is how
    /// "this phone ran out of time" came to be printed for a read the board had
    /// answered.
    static func gapClause(_ reading: Reading, for audience: ReadAudience) -> String {
        guard let line = missingLine(reading.missing) else { return "" }
        let reasons = gapReasons(reading.missing, reading.outcomes, for: audience)
        let why = reasons
            .map { reasons.count == 1 ? $0.why : "Its \(subjectList($0.reads)): \($0.why)" }
            .joined(separator: " ")
        return " \(line) \(why)"
    }

    /// Folders holding the user's scanned credentials. Ported from
    /// tiny-tech/src/agent/flipper.ts SENSITIVE_DIRS — see `refuseSweep`.
    static let sensitiveDirs = ["/ext/nfc", "/ext/lfrfid", "/ext/ibutton", "/ext/u2f", "/ext/subghz"]
    /// How long `waitForRoom` will hold a frame back waiting for the board to
    /// drain. Deliberately well inside the shortest request timeout (8s) so the
    /// caller learns it ran out of BUFFER rather than out of time.
    private static let roomWaitTries = 60
    private static let roomWaitMs = 50
    /// Largest inbound frame we will believe. The real ones are small: a screen
    /// frame is 1024 bytes plus its wrapper, a `Storage.Read` chunk about the
    /// same, a DeviceInfo frame is one key. A length past this did not come from
    /// the firmware, it came from a stream that lost its place — so it is a
    /// signal to resynchronise, not a buffer to wait for.
    private static let maxFrameBytes: UInt64 = 16384
    /// A varint is ten bytes at most. More than that at the head of the buffer
    /// without one parsing means those bytes are not a length prefix at all.
    private static let maxVarintBytes = 10

    // MARK: - How long a status read may take

    /// Per-request ceilings. DeviceInfo is the slowest thing the board does — 60
    /// frames, one key each — and free space is the quickest.
    static let deviceInfoS: TimeInterval = 25
    static let powerInfoS: TimeInterval = 15
    static let storageInfoS: TimeInterval = 12
    /// A folder listing. Generous on purpose: `/ext/subghz` on a used card is
    /// hundreds of entries, and every one of them crosses BLE behind flow
    /// control, so this is the slowest thing a person waits on in the panel.
    static let listS: TimeInterval = 25

    /// Total time `statusLine()` may spend, which is NOT the sum of the three
    /// above (52s) — and that gap is the point.
    ///
    /// `flipper_status` waits `STATUS_WAIT_S` = 45s for this phone's reply
    /// (`lib/chat/tools/flipper.ts`), and each relay hop costs up to ~5s of poll
    /// on the way there and back. A background beat is tighter still: a
    /// BGAppRefresh window is about 30 seconds for everything, heartbeat
    /// included. So an unbounded status read had a worst case that outlived every
    /// caller it has — the tool reported "no answer" while the phone was still
    /// dutifully asking, and the answer it eventually built was thrown away.
    static let relayStatusBudgetS: TimeInterval = 20

    /// Same rule for a listing asked for over the relay, and it needs its own
    /// constant because `listS` is calibrated for a DIFFERENT caller.
    ///
    /// In the panel a person is watching a spinner and 25s of patience is a
    /// feature. Over the relay nobody is watching: the phone's own poll loop
    /// sleeps 5s between looks (15s in Low Power Mode) before it even SEES the
    /// envelope, and only then does the listing start. `FILES_WAIT_S` = 45s is
    /// what the backend waits in total, so the listing has to be short enough
    /// that `poll lag + this` still lands inside it — with room left for the
    /// reply to be POSTed back and picked up.
    ///
    /// ⚠️ A listing that overruns is not a slow success, it is a **wrong
    /// diagnosis**: the caller gives up, and the sentence the user reads blames
    /// Bluetooth range for a board that answered fine 4 seconds later.
    static let relayFilesBudgetS: TimeInterval = 20

    /// Not worth issuing a request with less than this left: the reply cannot
    /// land before the budget is gone, and a request nobody is waiting for still
    /// spends the board's battery.
    private static let minRequestS: TimeInterval = 4

    // MARK: - What fits in a relay reply

    /// Characters of reply the phone will spend. The relay itself truncates at
    /// 7000 (`relay.ts`: `String(result).slice(0, 7000)`), so stopping short of
    /// that leaves the envelope's own JSON room to exist.
    static let replyBudget = 6500
    /// Bytes of a non-text file rendered as hex. Deliberately the same window
    /// the cable path uses (`tiny-tech/src/agent/flipper.ts`), so one `.sub`
    /// reads identically whichever transport fetched it — the point of a preview
    /// is to recognise the file, not to carry it.
    static let hexPreviewBytes = 1024

    /// Trim a reply to the budget **and say in the reply that it was trimmed.**
    ///
    /// ⚠️ The marker is the whole point; the trimming is incidental. A cut reply
    /// is indistinguishable from a complete one, and the agent relays it as the
    /// answer — so a listing missing its tail becomes "you don't have that card"
    /// about a card the user does have, and a half-rendered capture reads as the
    /// whole file. `String(...).prefix(n)` on its own produces exactly that lie,
    /// which is why no caller here should use it directly.
    static func fitReply(_ body: String, _ what: String) -> String {
        guard body.count > replyBudget else { return body }
        let note = "\n…\n(cut here — \(what) is longer than one reply can carry.)"
        return String(body.prefix(max(0, replyBudget - note.count))) + note
    }

    /// A non-text file as hex, with the sentence that says it is a preview.
    ///
    /// ⚠️ TWO surfaces render a Flipper file on this phone — the relay reply and
    /// the panel's Files sheet — and they were free to disagree, so they did. The
    /// reply used this window and named both numbers; the sheet cut a bare
    /// `prefix(512)` and said nothing, which is the exact lie `fitReply` above
    /// forbids its callers in writing. Same board, same file, same phone: a 2 KB
    /// `.fap` read as "the first 1024 of 2048 bytes" through the agent and as a
    /// complete-looking file in the user's hand, at a quarter of it.
    ///
    /// So the window and the admission live together, once. `cut` is empty when
    /// the whole file fits — then the hex IS the file and there is nothing to
    /// admit. Returned in two pieces because the reply wraps a header around it
    /// and the sheet does not.
    static func hexPreview(_ data: Data) -> (hex: String, cut: String) {
        let window = min(data.count, hexPreviewBytes)
        let hex = data.prefix(window).map { String(format: "%02x", $0) }.joined()
        let cut = window < data.count
            ? "…\n(preview: the first \(window) of \(data.count) bytes.)" : ""
        return (hex, cut)
    }

    override private init() {
        super.init()
        if let d = UserDefaults.standard.dictionary(forKey: Self.unitKey),
           let raw = d["peripheralId"] as? String,
           let id = UUID(uuidString: raw) {
            unit = Unit(peripheralId: id, name: d["name"] as? String ?? "Flipper")
        }
        // ⚠️ A screen stream must not outlive the foreground, and `.onDisappear`
        // cannot cover that: a sheet still on screen when the phone locks, or when
        // the user switches to a browser, never disappears. So the board keeps
        // rendering and pushing a kilobyte per redraw — on its own battery, at a
        // mirror nobody is looking at, waking this app for every frame. And it
        // lands on exactly the wrong rail: backgrounded is when the relay poll IS
        // the feature (the web agent reaches the board only through it), and a
        // redraw flood shares that link and this app's scraps of background time.
        //
        // The scenePhase observer lives in TinyApp, which cannot reach this
        // singleton, so observe the UIKit notifications directly — Views.swift's
        // backgrounding flush, same pattern. Strong self: the class is an
        // @unchecked Sendable singleton, as in `request`.
        phaseObservers = [
            NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
            ) { [self] _ in
                // The flag is set HERE, synchronously, not inside the Task: with
                // `queue: nil` this block runs on the thread UIKit posts from, while
                // the Task is a hop later. That hop is a window in which a re-link
                // could restart the mirror into a phone that is already in a pocket
                // — the exact cost this flag exists to prevent.
                foreground = false
                // Synchronously, for the same reason as the flag above and one more:
                // stopping a scan needs nothing from the board, so it must not wait
                // on a hop that iOS may suspend us before reaching. The stream's stop
                // is a frame and takes the background assertion instead.
                suspendScan()
                Task { @MainActor in await suspendScreenStream() }
            },
            NotificationCenter.default.addObserver(
                forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
            ) { [self] _ in
                foreground = true
                resumeScanIfWanted()
                Task { @MainActor in await resumeScreenStreamIfWanted(.returnedToForeground) }
            },
        ]
    }

    // MARK: - Pairing

    /// Look for Flippers. Foreground only by design: a nil-service scan is not
    /// allowed in the background, and pairing is a thing the user is watching.
    func startScan() {
        wanted = true
        scanWanted = true
        found = []
        if central == nil {
            central = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionRestoreIdentifierKey: "technology.tiny.flipper.ble",
            ])
        } else {
            beginScanIfPossible()
        }
    }

    /// The user is done looking: Cancel, the sheet dismissing, or the board being
    /// adopted. The DELIBERATE stop, so it also settles the debt — nothing is owed
    /// a resume. `suspendScan()` is the other stop, and the difference between them
    /// is the whole point of `scanWanted`.
    func stopScan() {
        scanWanted = false
        scanning = false
        central?.stopScan()
    }

    private func beginScanIfPossible() {
        // ⚠️ `foreground` is a requirement, not politeness, and this is the choke
        // point that holds it so no caller can reintroduce a background scan: with
        // no service UUIDs, iOS discovers **nothing** while the app is in the
        // background (a background scan has to name the services it wants). So a
        // scan armed there cannot succeed — it can only spend the radio, next to a
        // BLE link and a relay poll that are the features actually running.
        guard foreground, let c = central, c.state == .poweredOn, !c.isScanning else { return }
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

    /// Stop scanning because nobody can see the result, without deciding the user
    /// is finished.
    ///
    /// ⚠️⚠️ **`.onDisappear` is not "the app left the foreground"** — c9 established
    /// that for the screen stream, and the pairing sheet had the identical hole with
    /// no cover at all. A sheet still on screen when the phone auto-locks never
    /// disappears, and neither does one the user switches away from, so `stopScan()`
    /// — reachable only from Cancel and `.onDisappear` — was never called. The scan
    /// then stayed armed for as long as the app was backgrounded, and with
    /// `bluetooth-central` in `Info.plist` that is not bounded by anything: iOS keeps
    /// scanning on a suspended app's behalf, which is the point of the mode.
    ///
    /// And it is the NORMAL case, not an edge: this sheet's own footer sends the user
    /// to the Flipper's Settings → Bluetooth, and `subscribeFailureText` sends them
    /// there again when a bond fails. Leaving the app with the sheet open is the
    /// instruction. Auto-lock is 30 seconds.
    ///
    /// Called synchronously from the notification block rather than from the `Task`
    /// hop beside it, and that is deliberate: unlike the stream's stop — a frame that
    /// has to cross BLE behind flow control, which is why it holds a background task
    /// assertion — this one is local to the phone. Nothing has to reach the board, so
    /// there is no window in which iOS can suspend us first.
    private func suspendScan() {
        guard scanning else { return }
        scanning = false
        central?.stopScan()
        // `scanWanted` deliberately survives: the sheet did not go anywhere.
    }

    /// Put the scan back for a sheet that never went away.
    private func resumeScanIfWanted() {
        guard scanWanted, foreground else { return }
        beginScanIfPossible()
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
        infoAt = nil
        lastError = nil
    }

    // MARK: - Link lifecycle

    func start() {
        guard unit != nil else { return }
        wanted = true
        // A start is either user intent (pair, Reconnect) or a fresh launch
        // dialling a board it already owns, and both jump the backoff queue —
        // neither should have to wait out a delay grown by an earlier session.
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
        stopScan()
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil
        linkLost()
        // After `linkLost()`, which resets the backoff only for a link that lasted.
        // A deliberate stop is user intent either way, so the next `start()` begins
        // from a clean slate instead of inheriting the last link's penalty.
        reconnectDelay = Self.reconnectBaseS
        // Unlinking is deliberate, so nothing is owed a resume: left standing, the
        // next background/foreground pair after a re-link would start a stream for
        // a mirror that closed long ago. A DISCONNECT is the opposite case and
        // deliberately leaves this alone — it reconnects by itself, and a sheet
        // that is still open still wants its frames.
        streamWanted = false
    }

    /// Everything that stops being true when the link goes away — in ONE place,
    /// because there are three ways to lose a Flipper and only one of them is a
    /// disconnect.
    ///
    /// ⚠️⚠️ The third is what this exists for: **Bluetooth itself going away**.
    /// The user flips it off in Control Center, turns on Airplane mode, or
    /// `bluetoothd` restarts under a `.resetting` state — and every peripheral is
    /// invalidated through `centralManagerDidUpdateState`, which is a *different*
    /// callback from the one that used to hold this list. The delegate contract
    /// does not promise a disconnect event as well, and for `.resetting` there is
    /// no disconnect to wait for at all, so a teardown that lives only in
    /// `didDisconnectPeripheral` is a bet on which callback the system chooses to
    /// deliver. That arm cleared exactly ONE of the facts below (`linked`) and the
    /// other eight survived a Bluetooth toggle:
    ///
    /// - `streaming` stayed true over the last `screenFrame`, and the mirror sheet
    ///   renders whatever frame it last saw — so a dead mirror kept showing the
    ///   board's final picture as a live one, above a d-pad captioned "a press
    ///   here is a press on the board".
    /// - Worse, it did not recover. `resumeScreenStreamIfWanted` — whose whole job
    ///   is putting the mirror back after a link returns — is guarded on
    ///   `!streaming`, so once that flag was stuck the resume was silently blocked
    ///   *forever*. Bluetooth came back, the board relinked, and the mirror stayed
    ///   frozen with the only recovery (close the sheet and reopen it) never
    ///   suggested. That is precisely the state the resume was written to end.
    /// - Requests in flight waited out their own timers (up to 25s for a status
    ///   read) instead of failing at once, and with `rxChar` still standing the
    ///   NEXT request was handed to an invalidated peripheral — where a dropped
    ///   ATT write is invisible, because nothing implements `didWriteValueFor`.
    ///
    /// Every line here is idempotent, so calling it from both paths is safe even
    /// where the system does deliver both.
    ///
    /// ⚠️ NOT `stop()`, which is the caller's decision to make: that also clears
    /// `wanted` and `streamWanted`, which would read a Bluetooth toggle as "the
    /// user is done with the Flipper" — no reconnect when the radio comes back,
    /// and no resume for a sheet still on screen.
    private func linkLost() {
        linked = false
        // Cleared here as well as in the ping's own catch: that runs a hop later,
        // and a `linking` left standing would make the NEXT confirmed
        // subscription a no-op — a link that can never be proved.
        linking = false
        // `write()` is the gate `request()` relies on to refuse instantly; with the
        // characteristic gone, a request fails as `.notLinked` rather than being
        // written into a peripheral iOS has already invalidated.
        rxChar = nil
        inbox = []
        // The board's stream dies with the RPC session, so the flag and the last
        // picture have to go too — a mirror that keeps showing its final frame
        // claims to be live.
        streaming = false
        screenFrame = nil
        lock.withLock { credits = nil }
        // Anything mid-flight is gone with the link. Failing it now turns a
        // 15-second wait into an immediate answer — and the answer has to say
        // whether the board already had the command, because `.notLinked` ("no
        // Flipper is linked to this phone") reads as "so nothing happened", which
        // for a beep already sounding is false and asks for a second one.
        failAllPending { FlipperError.linkDropped(sent: $0) }
        // Reset the backoff only for a link that LASTED — that is what tells
        // walking out of range apart from a board that drops us on sight.
        if let since = linkedAt, Date().timeIntervalSince(since) >= Self.goodLinkS {
            reconnectDelay = Self.reconnectBaseS
        }
        linkedAt = nil
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

    /// Called once the TX subscription is CONFIRMED — never merely requested.
    /// Proves the link with a ping before claiming it, then fills in `info` so the
    /// panel has something true to show without the user pressing anything.
    ///
    /// ⚠️ The caller matters as much as the body. This used to run at the end of
    /// `didDiscoverCharacteristicsFor`, i.e. immediately after `setNotifyValue` was
    /// *issued*, and the ping's 8-second timeout then raced the one step of this
    /// whole feature that a human performs by hand: iOS defers the CCCD write until
    /// bonding completes, so on a first pair the ping was in flight while the user
    /// was still reading six digits off a 1.4-inch screen and typing them. Nothing
    /// retries afterwards, so the board finished bonding into a panel that had
    /// already given up — and the message it left blamed an app on the Flipper's
    /// screen. Answers only arrive on TX, so there is no link to prove until TX is
    /// actually notifying.
    private func finishLink() {
        guard !linking else { return }
        linking = true
        Task {
            do {
                try await ping()
            } catch {
                await MainActor.run {
                    self.linking = false
                    self.linked = false
                    self.lastError = "Bluetooth connected and paired, but the Flipper's RPC didn't answer. If its screen is showing an app, close it."
                }
                return
            }
            await MainActor.run {
                self.linking = false
                self.linked = true
                self.linkedAt = Date()
                self.lastError = nil
            }
            // A dropped link takes the board's RPC session and the screen stream
            // with it, but NOT the sheet that was watching — the panel's `.task`
            // has already run, so before this nothing put the mirror back and a
            // healthy reconnected board went on showing an empty view forever,
            // with no text saying to close and reopen it. `streamWanted` survives a
            // disconnect for exactly this moment; a deliberate `stop()` clears it.
            //
            // Ahead of `refresh()` on purpose: the mirror is the thing being looked
            // at, and a status read can spend the better part of a minute on a slow
            // board. Costs nothing when no sheet is open — the guard sees no debt.
            await resumeScreenStreamIfWanted(.relinked)
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
        // No `guard linked` here on purpose: finishLink() proves the link with a
        // ping BEFORE `linked` is true, so a strict check would make the link
        // unprovable. `write()` is the real gate — with no characteristic to
        // write to it fails the request with .notLinked immediately.
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
            me.failTimedOut(id, label)
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
                self.enqueueWrite(framed, id: id)
            }
        }
    }

    /// Queue one framed request behind whatever is already on its way out.
    ///
    /// Whole frames, one at a time. `writeFrame` can suspend waiting for the
    /// board's buffer to drain, and two suspended writers would interleave their
    /// chunks on the wire — which the board reads as one corrupt frame, exactly
    /// what the reservation in `writeFrame` exists to prevent. Same shape as
    /// `inputChain` in `send(_:hold:)`, for the same reason.
    @MainActor
    private func enqueueWrite(_ data: Data, id: UInt32) {
        let previous = writeChain
        writeChain = Task { @MainActor in
            _ = await previous?.value
            await self.writeFrame(data, id: id)
        }
    }

    /// Write one framed request, chunked to what the link will take — and not a
    /// byte of it until the whole frame is sure to fit.
    ///
    /// ⚠️ **A PARTIAL FRAME IS UNRECOVERABLE.** The board reads the varint length
    /// and then waits for exactly that many bytes, so a frame cut short leaves
    /// its parser mid-message: the NEXT request's bytes are eaten as this one's
    /// tail, and every command after that decodes as garbage until the link
    /// drops. The only symptom is a timeout, which reads as "the Flipper isn't
    /// answering" rather than "we broke the stream". So flow control here is a
    /// RESERVATION for the entire frame taken before the first chunk goes out —
    /// never a per-chunk gate that can give up halfway.
    @MainActor
    private func writeFrame(_ data: Data, id: UInt32) async {
        // Flow control is not decoration: the flow-control characteristic reports
        // free RX buffer, and the firmware logs "Received %d, while was ready to
        // receive %d bytes. Can lead to buffer overflow!" when a writer ignores
        // it. Hold the whole frame back rather than overrun the board.
        guard await waitForRoom(data.count) else {
            fail(id, FlipperError.noRoom)
            return
        }
        // The caller's timeout runs independently of this queue, so the wait is
        // where a request gets abandoned. Sending it anyway would run a command
        // nobody is listening for — a delete or a clock set landing after the
        // user gave up and moved on.
        guard lock.withLock({ pending[id] != nil }) else { return }
        // Re-read the link AFTER the wait — it may have dropped while we waited,
        // in which case `didDisconnectPeripheral` has already failed this id and
        // `rxChar` belongs to a peripheral we no longer hold.
        guard let p = peripheral, let ch = rxChar else {
            fail(id, FlipperError.notLinked)
            return
        }
        // Past the guard above, this frame is going out: the chunk loop below has
        // no suspension point and nothing after it can call the send off. So this
        // is the line where a timeout stops meaning "the board never saw it" and
        // starts meaning "the answer is what's missing" — the one fact
        // `FlipperError.timeout`'s reader needs, recorded at the moment it
        // becomes true rather than inferred afterwards by somebody guessing.
        lock.withLock { pending[id]?.sent = true }
        let mtu = max(20, p.maximumWriteValueLength(for: rxWriteType))
        var offset = 0
        while offset < data.count {
            let n = min(mtu, data.count - offset)
            p.writeValue(data.subdata(in: offset..<offset + n), for: ch, type: rxWriteType)
            lock.withLock {
                if let c = credits { credits = c > UInt32(n) ? c - UInt32(n) : 0 }
            }
            offset += n
        }
    }

    /// Wait until the board has room for `bytes`.
    ///
    /// Returns false only if the buffer never freed up — and in that case
    /// NOTHING has been written, which is the whole point: a request that fails
    /// here fails cleanly, where one abandoned halfway poisons every request
    /// after it.
    private func waitForRoom(_ bytes: Int) async -> Bool {
        for _ in 0..<Self.roomWaitTries {
            // nil = the characteristic has never notified, so there is no budget
            // to honour and holding back would deadlock on information that is
            // not coming. Send, as the firmware's own clients do.
            guard let room = lock.withLock({ credits }) else { return true }
            if room >= UInt32(bytes) { return true }
            try? await Task.sleep(for: .milliseconds(Self.roomWaitMs))
        }
        return false
    }

    /// Feed inbound bytes through the deframer. One notify can carry part of a
    /// frame, a whole frame, or several.
    private func consume(_ chunk: Data) {
        inbox.append(contentsOf: chunk)
        while true {
            guard let (len, afterLen) = PBMsg.varint(inbox, 0) else {
                // A truncated prefix is ordinary — wait for the rest. Unless
                // there are already more bytes here than any varint can be, in
                // which case waiting means waiting forever.
                if inbox.count > Self.maxVarintBytes { desync("a length prefix that never ended") }
                return
            }
            if len == 0 {
                // Not a shape the Flipper emits, but dropping the prefix is the
                // only way out that doesn't spin forever on it.
                inbox.removeFirst(afterLen)
                continue
            }
            guard len <= Self.maxFrameBytes else {
                desync("a frame claiming \(len) bytes")
                return
            }
            let end = afterLen + Int(len)
            guard inbox.count >= end else { return } // frame still arriving
            let msg = PBMsg(Array(inbox[afterLen..<end]))
            inbox.removeFirst(end)
            deliver(msg)
        }
    }

    /// The inbound stream lost its place. Drop what is buffered and fail what is
    /// waiting, so the next request starts from a known-empty buffer.
    ///
    /// Without this a deframer holding one impossible length never delivers
    /// another frame: every later notify just appends, every request times out,
    /// and nothing anywhere says why. Recovering costs one round of errors;
    /// stalling costs the session.
    private func desync(_ what: String) {
        inbox = []
        lastError = "The Flipper's Bluetooth stream lost sync (\(what)). The next command starts fresh."
        // `.desynced`, not `.malformed`: a malformed answer is one that ARRIVED,
        // which says the board acted. Here the answer may not exist yet, so the
        // request's own `sent` is the only thing that knows.
        failAllPending { FlipperError.desynced(sent: $0) }
    }

    private func deliver(_ msg: PBMsg) {
        // Screen frames are routed by CONTENT, ahead of the command_id lookup,
        // because they are not answers to anything: once the stream is on the
        // board pushes one per redraw, unprompted. Whether the firmware stamps
        // them with 0 or echoes the id of the request that started the stream is
        // not a thing this file should depend on — and if it echoes, matching on
        // the id would resolve the start request with a picture instead of its
        // acknowledgement, then keep appending frames to an entry nobody holds.
        if let sf = msg.msg(Cmd.guiScreenFrame) {
            // Same main queue as every other delegate callback (the manager is
            // created with `queue: .main`), so the @Published write is on-thread.
            if streaming {
                frameSeq += 1
                screenFrame = FlipperFrame(data: sf.bytes(1) ?? Data(),
                                          orientation: Int(sf.num(2) ?? 0),
                                          seq: frameSeq)
            }
            return
        }
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

    /// Time up: fail the request with the timeout that knows whether the board
    /// got the command.
    ///
    /// The flag is read HERE, in the same call that ends the request, because
    /// `fail` removes the id — a caller that asked afterwards would find nothing
    /// pending and report every timeout as never sent.
    private func failTimedOut(_ id: UInt32, _ label: String) {
        let sent = lock.withLock { pending[id]?.sent ?? false }
        fail(id, FlipperError.timeout(label, sent: sent))
    }

    private func fail(_ id: UInt32, _ error: Error) {
        var cont: CheckedContinuation<[PBMsg], Error>?
        lock.withLock {
            cont = pending[id]?.cont
            pending[id] = nil
        }
        cont?.resume(throwing: error)
    }

    /// End every request in flight, each with an error built from ITS OWN state.
    ///
    /// ⚠️ The parameter is a closure over `sent`, not an error value, and that is
    /// the entire point of it. Whether the board got the command is a fact about
    /// one request; this function ends several at once, so a single error value
    /// here is a constant standing in for a variable — c7's shape (a heartbeat
    /// posting a static capability list) at the error layer, and invisible for the
    /// same reason: the call site reads perfectly well on its own. `Pending.sent`
    /// sat in the dictionary being deleted, one line away, unread.
    ///
    /// What that cost: a beep the board had already run and a beep still queued
    /// behind it were handed the same sentence, and it was the wrong one for
    /// exactly the request that mattered.
    private func failAllPending(_ error: (Bool) -> Error) {
        var conts: [(CheckedContinuation<[PBMsg], Error>, Bool)] = []
        lock.withLock {
            for p in pending.values {
                if let c = p.cont { conts.append((c, p.sent)) }
            }
            pending = [:]
        }
        for (c, sent) in conts { c.resume(throwing: error(sent)) }
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

    func deviceInfo(timeout: TimeInterval = FlipperGateway.deviceInfoS) async throws -> [String: String] {
        // 60 keys, one frame each — the slowest thing we ask for.
        try await keyValues(Cmd.deviceInfoReq, respField: Cmd.deviceInfoResp,
                            timeout: timeout, label: "device info")
    }

    func powerInfo(timeout: TimeInterval = FlipperGateway.powerInfoS) async throws -> [String: String] {
        try await keyValues(Cmd.powerInfoReq, respField: Cmd.powerInfoResp,
                            timeout: timeout, label: "power info")
    }

    func storageInfo(_ path: String = "/ext",
                     timeout: TimeInterval = FlipperGateway.storageInfoS) async throws -> (total: UInt64, free: UInt64) {
        let frames = try await request(PB.sub(Cmd.storageInfoReq, PB.str(1, path)),
                                      timeout: timeout, label: "free space")
        try checkStatus(frames)
        guard let r = frames.compactMap({ $0.msg(Cmd.storageInfoResp) }).first else {
            throw FlipperError.malformed("free space")
        }
        return (r.num(1) ?? 0, r.num(2) ?? 0)
    }

    /// One `alert` — the board plays its own audiovisual alert. Find-my-Flipper,
    /// and the friendliest possible proof that the link is real.
    ///
    /// ⚠️ Do not describe what this DOES as a beep: the board decides that, and on
    /// the user's own board vibration is already switched off. What it proves and
    /// what it does not is `alertSent(for:)`'s whole job — every reader of this
    /// call goes through that function.
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
    func list(_ path: String, includeMd5: Bool = false,
              timeout: TimeInterval = FlipperGateway.listS) async throws -> [FlipperEntry] {
        var body = PB.str(1, path)
        if includeMd5 { body += PB.bool(2, true) }
        let frames = try await request(PB.sub(Cmd.storageListReq, body),
                                      timeout: timeout, label: "a folder listing")
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
    ///
    /// `audience` has no default: the sentence a refusal produces is addressed to
    /// somebody, and a default is how the wrong somebody got it for sixteen cycles.
    func read(_ path: String, maxBytes: Int = FlipperGateway.maxReadBytes,
              for audience: ReadAudience) async throws -> Data {
        if let why = Self.refuseSweep(path) { throw FlipperError.refused(why) }
        // Size first. Reading and then discarding would spend the user's time and
        // the board's battery to deliver nothing.
        let stat = try await request(PB.sub(Cmd.storageStatReq, PB.str(1, path)),
                                    timeout: 12, label: "a file's size")
        try checkStatus(stat)
        let size = stat.compactMap { $0.msg(Cmd.storageStatResp)?.msg(1) }.first?.num(3) ?? 0
        if size > UInt64(maxBytes) {
            throw FlipperError.refused(
                Self.tooBig(path, size: size, limit: maxBytes, for: audience))
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

    // MARK: - Screen and buttons

    /// Start mirroring the Flipper's screen.
    ///
    /// This and `send(_:hold:)` are the two things the cable cannot do at all —
    /// the text CLI has no screenshot command and no way to inject input, so a
    /// mirror is not a BLE consolation prize for the missing capture, it is a
    /// capability only this transport has.
    ///
    /// ⚠️ Whoever starts it owes it a `stopScreenStream()`. The board keeps
    /// pushing a kilobyte per redraw until it is told to stop, and it is running
    /// on its own battery in someone's pocket.
    func startScreenStream() async throws {
        // `streaming` goes up BEFORE the request, not after the acknowledgement:
        // the board pushes on REDRAW, and a Flipper sitting on a static menu may
        // not redraw for a long time. A first frame dropped because the flag
        // wasn't up yet is a mirror that stays blank on a board that is working.
        await MainActor.run {
            self.frameSeq = 0
            self.screenFrame = nil
            self.streaming = true
            // From here until a view says it is done, a trip through the background
            // owes this stream a resume. Set before the request, and NOT cleared by
            // the catch below: a start that failed still leaves a sheet on screen
            // wanting frames, and a free retry on the way back is worth more than a
            // tidier flag.
            self.streamWanted = true
        }
        do {
            let frames = try await request(PB.empty(Cmd.guiStartStreamReq),
                                          timeout: 10, label: "the screen stream")
            try checkStatus(frames)
        } catch {
            await MainActor.run { self.streaming = false }
            throw error
        }
    }

    /// Stop mirroring because a view is done with it. Deliberately non-throwing:
    /// this runs when a sheet closes or a view disappears, and the only thing a
    /// caller could do with a failure is leave the board streaming to nobody.
    func stopScreenStream() async {
        // The view is done, so nothing is owed a resume. This is the ONLY
        // difference between this and `suspendScreenStream`.
        await MainActor.run { self.streamWanted = false }
        await endStream()
    }

    /// Stop mirroring because the app is leaving the foreground — without
    /// forgetting that a view still wants it back.
    ///
    /// ⚠️ This is the case `.onDisappear` cannot see. A sheet is still on screen
    /// when the phone locks, so the stream used to run on into the background,
    /// where the board pays for every redraw and nobody sees one.
    @MainActor
    func suspendScreenStream() async {
        // Nothing to stop; a StopScreenStream on every backgrounding would be an
        // RPC round trip for its own sake.
        guard streaming else { return }
        // The stop has to reach the board before iOS suspends this app, and the
        // write may sit waiting on flow-control credits first. Views.swift holds
        // one of these across a chat stream for the same reason.
        let hold = UIApplication.shared.beginBackgroundTask(withName: "flipper-stop-stream")
        await endStream()
        if hold != .invalid { UIApplication.shared.endBackgroundTask(hold) }
    }

    /// Why a mirror is being put back. The two callers agree on everything except
    /// the sentence a failure produces, and that sentence has to name the real
    /// cause: telling someone the app was in the background when what actually
    /// happened is that their Flipper walked out of range sends them to fix the
    /// wrong thing.
    enum ResumeCause {
        case returnedToForeground
        case relinked

        var failureText: String {
            switch self {
            case .returnedToForeground:
                return "The screen mirror was stopped while the app was in the background and couldn't be restarted"
            case .relinked:
                return "The Flipper reconnected, but the screen mirror couldn't be restarted"
            }
        }
    }

    /// Put the mirror back: on the way in from the background, or after the link
    /// dropped and came back under a sheet that is still open.
    ///
    /// ⚠️ Both arms are load-bearing and they are not the same question.
    /// `streamWanted` = a view wants frames; `foreground` = anyone can see them.
    /// Resuming on a re-link without the second arm would restart the kilobyte-per
    /// -redraw flood into a pocketed phone — reopening, through the link's door,
    /// exactly the hole the phase observers were added to close.
    @MainActor
    func resumeScreenStreamIfWanted(_ cause: ResumeCause) async {
        // `linked`, because a stream needs an RPC session; `!streaming`, because
        // these notifications are not guaranteed to alternate (a relaunch straight
        // into the foreground), and a second start under a live mirror would reset
        // its frame counter.
        guard streamWanted, foreground, linked, !streaming else { return }
        do {
            try await startScreenStream()
        } catch {
            // Not silent: otherwise FlipperScreenSheet just says "Not streaming."
            // about a mirror the user left running, and the stop we sent looks like
            // the board's fault.
            //
            // ⚠️ That sheet, and nothing else, is what this sentence has to reach —
            // the guard above requires `streamWanted, foreground`, which IS "a
            // screen sheet is open on this phone right now". This comment said "the
            // panel" for a while, and it was wrong in a load-bearing way: the panel
            // ROW was the only reader `lastError` had, the sheet covers it, and so
            // the one diagnosis written to replace a bare "Not streaming." was the
            // one sentence nobody could ever read. `FlipperLinkProblem` is the
            // reader now, mounted by every surface that can be the one on screen.
            lastError = "\(cause.failureText): \(error.localizedDescription)"
        }
    }

    /// The wire half of stopping: flag down, last picture gone, StopScreenStream
    /// sent. Shared so the view's stop and the background suspend cannot drift —
    /// what separates them is only whether a resume is still owed.
    private func endStream() async {
        await MainActor.run {
            self.streaming = false
            self.screenFrame = nil
        }
        _ = try? await request(PB.empty(Cmd.guiStopStreamReq),
                              timeout: 8, label: "stopping the screen stream")
    }

    /// Press one button, as the hardware would report it.
    ///
    /// PRESS, then SHORT (or LONG), then RELEASE — all three, in order. Not SHORT
    /// alone: a Flipper view that tracks the key being down, like a game or the
    /// IR app transmitting while OK is held, would see a key go short without
    /// ever being pressed or released and stay stuck in whatever state that left.
    /// The board's own input service emits all three, so the mirror does too.
    ///
    /// Sequences are chained rather than fired concurrently. Two overlapping taps
    /// would interleave on the wire as PRESS(up), PRESS(ok), SHORT(up)… which the
    /// input service reads as a chord nobody pressed.
    ///
    /// ⚠️⚠️ **RELEASE is not the third step of a sequence, it is the guaranteed undo
    /// of the first**, and that is why this is not a loop over three events. A loop
    /// that gives up on the first failure abandons the RELEASE — so a tap whose
    /// middle event times out or runs out of the board's receive buffer leaves the
    /// input service holding that key **down**, with the user's thumb already off
    /// it and nothing on screen saying so. On a board sitting in the Sub-GHz or IR
    /// app, "OK held down" is not a stuck menu, it is a **transmitter still keyed**
    /// — the exact harm that keeps input out of the relay in the first place. The
    /// window is not theoretical either: the likeliest moment to tap is while the
    /// screen mirror is running, which is precisely when a kilobyte per redraw has
    /// the flow-control credits and the 8-second timeouts under pressure.
    @MainActor
    func send(_ key: FlipperKey, hold: Bool = false) async throws {
        let previous = inputChain
        // Strong self: the class is a @unchecked Sendable singleton, and a weak
        // capture reads as a captured `var` to Swift 6's closure checker.
        let mine = Task { () -> Error? in
            _ = await previous?.value
            var failure: Error?
            do { try await self.input(key, .press) } catch { failure = error }
            // Skipped when the press failed: a SHORT with no PRESS behind it is
            // the "key went short without ever being pressed" state the board's
            // own views get stuck in, which is what the sequence exists to avoid.
            if failure == nil {
                do { try await self.input(key, hold ? .long : .short) } catch { failure = error }
            }
            // Sent even when the press failed, because a FAILED press is not a
            // press that didn't land: `.timeout` means the reply never came back,
            // and the frame may well have been delivered and acted on. A release
            // for a key that is not down is ignored by the input service; a key
            // left down is a radio nobody told to stop.
            do { try await self.input(key, .release) } catch { failure = failure ?? error }
            // The first error is the cause and the one worth reporting; a release
            // that also failed is a symptom of the same broken link.
            return failure
        }
        inputChain = mine
        if let failure = await mine.value { throw failure }
    }

    private func input(_ key: FlipperKey, _ type: FlipperInputType) async throws {
        // Explicit zeros. UP and PRESS are both 0, and proto3 omits defaults —
        // so an encoder being clever here would send an EMPTY body, which is
        // indistinguishable from a message we forgot to fill in. nanopb reads a
        // present zero the same as an absent one, so writing it costs nothing.
        let body = PB.int(1, UInt64(key.rawValue)) + PB.int(2, UInt64(type.rawValue))
        let frames = try await request(PB.sub(Cmd.guiInputReq, body),
                                      timeout: 8, label: "a button press")
        try checkStatus(frames)
    }

    // MARK: - Status

    /// What one `refresh` attempt came back with.
    ///
    /// A `Bool` here is the reason both status surfaces had to GUESS. `refresh`
    /// wrapped all three reads in `try?`, so the board's own account of itself —
    /// `.status(17)`, "an app is running on the Flipper — close it on the device
    /// first" — was discarded at the same instant it arrived, along with the two
    /// errors c31 had just taught to say which world they fired in
    /// (`.linkDropped(sent:)`, `.desynced(sent:)`). All the caller was left with
    /// was `false`, and it filled the gap with a sentence about an app being open
    /// that no board had said.
    /// ⚠️ And `.learned` was the same bug one step in. It answered "yes" for a
    /// reading that came back with ONE of its three parts, dropped the cause of the
    /// other two, and left every surface stamping "read just now" on a line that had
    /// silently lost the battery and the SD card — the two facts anybody asks for.
    /// The likeliest partial on this rail needs no broken board at all: DeviceInfo
    /// alone may spend the whole `relayStatusBudgetS`, and then Power and Storage are
    /// never asked (`allow` returns nil), nothing throws, and the answer is a short
    /// line with a fresh timestamp.
    /// ⚠️ And ONE cause for a whole reading was that bug a third time. A single
    /// `because: Error?` cannot say which read it belongs to, so it was handed to
    /// every gap — including the reads that were never issued, and the reads the
    /// board ANSWERED without the field, where nil then meant "this phone ran out of
    /// time" about a request it had made and had an answer to. Each read now carries
    /// its own `FlipperReadOutcome` and the cause is derived from those, so no gap can
    /// be explained by something that happened to a different read.
    enum Reading {
        /// At least one value came back. `info` and `infoAt` have moved.
        ///
        /// `missing` is empty when all three reads landed, and `outcomes` says how
        /// each read ENDED — the fact no value can carry, and the only thing that
        /// distinguishes a read this phone never made from one the board answered
        /// without the field.
        case learned(missing: [FlipperRead], outcomes: [FlipperRead: FlipperReadOutcome])
        /// Nothing usable came back — every read left nothing, each for its own
        /// recorded reason. A request this phone never made must not be reported as
        /// the board's silence, and a request the board ANSWERED must not be reported
        /// as this phone's clock; both are c31's `.notLinked`-over-a-sent-frame in
        /// another costume.
        case silent(outcomes: [FlipperRead: FlipperReadOutcome])

        /// Named `didLearn` rather than `learned` so it cannot be confused with —
        /// or shadow — the case of the same name.
        var didLearn: Bool {
            // No `default:`. A third outcome added later must decide which side of
            // "did we learn anything" it is on before this compiles (c31's rule).
            switch self {
            case .learned: return true
            case .silent: return false
            }
        }

        /// How each read ended. Seeded off `FlipperRead.allCases` by `refresh`, so it
        /// is total: a read with no entry would be answered `.unasked`, which is a
        /// claim about this phone's clock that nobody recorded.
        var outcomes: [FlipperRead: FlipperReadOutcome] {
            switch self {
            case .learned(_, let outcomes): return outcomes
            case .silent(let outcomes): return outcomes
            }
        }

        /// ⚠️ There is deliberately no `failure: Error?` here any more. One cause for
        /// a whole reading is what handed a failed read's words to the two reads that
        /// never ran, and an accessor that answers "the reason" for three independent
        /// reads is an invitation to ask it again. Ask `outcomes` about a READ.
        ///
        /// What the reader did not get. Everything, when nothing came back: that is
        /// literally true, and it keeps this accessor total without a special case.
        /// The two no-reading sentences already say so in their own words, so
        /// `gapClause` is only ever asked of a reading that learned something.
        var missing: [FlipperRead] {
            switch self {
            case .learned(let gaps, _): return gaps
            case .silent: return FlipperRead.allCases
            }
        }
    }

    /// Fill `info` from the board. Each piece is independent: a Flipper that
    /// answers DeviceInfo but not Storage.Info (no SD card) should still show its
    /// firmware rather than one blanket failure.
    /// Read firmware, battery and free space.
    ///
    /// Returns **what this attempt learned, what it did not, and why not**. All
    /// three reads are attempted regardless of each other's failure, on purpose —
    /// a board that answers two of three is worth showing — but a failure is now
    /// KEPT rather than dropped by a `try?`, because total failure otherwise looked
    /// identical to every caller no matter what the board said. `infoAt` moves only
    /// when the reading does, so nothing downstream can date a memory as fresh.
    ///
    /// ⚠️ "Worth showing" is only true if the reader is told what is not in it.
    /// Two of three came back as `.learned` with no way to ask what the third was,
    /// so the shorter line went out stamped "read just now" — and `summary` prints
    /// every field conditionally, so the missing battery left no trace at all.
    /// `Reading.missing` is that trace, and `gapClause(_:for:)` is the sentence.
    ///
    /// ⚠️ And each read records HOW IT ENDED, which is a fact about the read that no
    /// value and no single error can carry. `keyValues` returns an empty dictionary
    /// rather than throwing when the board answers with no keys, and `Int("94.5")` is
    /// nil — so "the board answered without it" throws nothing, was reported as the
    /// same nil as "never asked", and came out as a sentence about this phone's clock.
    /// On this method's OTHER two callers (`finishLink` and the panel button) there is
    /// no budget at all, so nothing can ever be skipped and that sentence was wrong
    /// every single time it appeared.
    ///
    /// Three reads that ended the SAME way are still one fact — `gapReasons` groups
    /// them under one sentence, so a link that never came up says so once — but a
    /// reading whose reads ended DIFFERENTLY now explains each of them by what
    /// happened to it, in words that name whose gap they are.
    ///
    /// `budget` caps the WHOLE read, not each request: with three ceilings adding
    /// up to 52s, an unbounded refresh could outlive the relay caller waiting for
    /// it. Reads are dropped from the end when time runs short, so a slow board
    /// still yields firmware and battery rather than nothing at all.
    @discardableResult
    func refresh(within budget: TimeInterval = .infinity) async -> Reading {
        let started = Date()
        /// What this read may ask for, or nil when there is no point asking.
        func allow(_ want: TimeInterval) -> TimeInterval? {
            guard budget.isFinite else { return want }
            let left = budget - Date().timeIntervalSince(started)
            return left >= Self.minRequestS ? min(want, left) : nil
        }
        var next = FlipperInfo()
        /// How each read ended. Seeded from `allCases` rather than left to grow keys,
        /// so a read is `.unasked` because nothing overwrote it — a read missing from
        /// this map would be answered "never asked" on a rail that cannot skip one.
        var outcomes = Dictionary(uniqueKeysWithValues:
            FlipperRead.allCases.map { ($0, FlipperReadOutcome.unasked) })
        if let t = allow(Self.deviceInfoS) {
            do {
                let d = try await deviceInfo(timeout: t)
                next.firmware = d["firmware_version"] ?? ""
                next.model = d["hardware_model"] ?? ""
                next.deviceName = d["hardware_name"] ?? ""
                // `.answered` even when those keys were absent — the board DID answer,
                // and an empty dictionary is exactly the road that used to be reported
                // as this phone running out of time.
                outcomes[.device] = .answered
            } catch { outcomes[.device] = .failed(error) }
        }
        if let t = allow(Self.powerInfoS) {
            do {
                let p = try await powerInfo(timeout: t)
                next.batteryPct = p["charge_level"].flatMap { Int($0) }
                next.chargeState = p["charge_state"] ?? ""
                outcomes[.power] = .answered
            } catch { outcomes[.power] = .failed(error) }
        }
        if let t = allow(Self.storageInfoS) {
            do {
                let s = try await storageInfo(timeout: t)
                next.totalBytes = s.total
                next.freeBytes = s.free
                outcomes[.storage] = .answered
            } catch { outcomes[.storage] = .failed(error) }
        }
        // `let` before the hop: a var captured by a concurrently-executing
        // closure is an error under Swift 6.
        let reading = next
        // An answer that carried no values is not a reading. The board can reply
        // OK to DeviceInfo and hand back nothing usable, and treating that as
        // success would re-date the old line without replacing it.
        let learned = reading != FlipperInfo()
        // Which parts are missing comes off the READING, not off which requests
        // threw: `summary` prints every field conditionally, so a skipped read and a
        // refused one take the same words away from whoever is looking.
        let gaps = reading.gaps
        await MainActor.run {
            // Keep the last good reading if this attempt learned nothing — a
            // blank panel is worse than a stale line. What must NOT be kept is
            // the impression that it is current, which is what `infoAt` is for.
            if learned {
                self.info = reading
                self.infoAt = Date()
            }
        }
        return learned ? .learned(missing: gaps, outcomes: outcomes) : .silent(outcomes: outcomes)
    }

    /// How old a reading is, in words, for a reader who cannot see this phone's
    /// clock. A relay reply lands in a web chat, so "as of 8:35:12" would be a
    /// timestamp in an unstated timezone — an elapsed time is the same fact
    /// without the ambiguity.
    static func age(of when: Date, now: Date = Date()) -> String {
        let s = Int(max(0, now.timeIntervalSince(when)))
        if s < 10 { return "seconds ago" }
        if s < 90 { return "\(s)s ago" }
        if s < 5400 { return "\(Int((Double(s) / 60).rounded()))min ago" }
        return "\(Int((Double(s) / 3600).rounded()))h ago"
    }

    /// Why nothing can reach the board right now — ONE source, in the words of
    /// whoever is asking.
    ///
    /// ⚠️ There were three of these, worded three different ways, and the one under
    /// the user's thumb sent them to the screen that can destroy their pairing. The
    /// panel row said *"bring the Flipper nearby and make sure Bluetooth is on in
    /// its settings"* — the BOARD's Settings → Bluetooth, which is where "Forget all
    /// paired devices" lives — and it said it only in the state where a bond exists
    /// to lose, because `FlipperBlePanel.paired` renders only when `unit != nil`.
    /// The same advice is right in the pairing SHEET, where there is no bond yet.
    /// It is right before a bond and harmful after one. `lib/chat/tools/flipper.ts`
    /// was scrubbed of exactly this remedy for exactly this reason and a test pins
    /// it dead there — while the phone, whose wording outranks the backend's (it
    /// arrives as the tool RESULT, and on the panel it is under a thumb), went on
    /// giving it.
    ///
    /// ⚠️ And none of the three could name the one cause with a one-tap fix.
    /// `centralManagerDidUpdateState` diagnoses `.poweredOff` and `.unauthorized`
    /// already — into `lastError`, whose only readers are this phone's own panel and
    /// sheets. Nobody asking through the relay can see that screen: a phone in a
    /// pocket and a browser somewhere else is the entire point of this rail. So a
    /// Bluetooth switch flipped on the PHONE came back as a story about the BOARD.
    ///
    /// ⚠️ And a third reader was being told to WAIT for something switched off.
    /// Both sentences below promised the phone was re-dialling with a backoff — true
    /// in the ordinary out-of-range case, and false in the one state that is not
    /// recoverable without a human: `didUpdateNotificationStateFor` calling `stop()`
    /// after the TX subscription failed. That is a pairing that did not hold, and
    /// `stop()` clears `wanted` on purpose (re-dialling would re-raise the system
    /// prompt every couple of seconds at someone who just declined one), so nothing
    /// re-dials, ever. The remote asker got "it returns by itself once it is near";
    /// the one thing that could not work was waiting. `dialling` is that fact, and
    /// like the audience it has NO default — a caller that forgets it would inherit
    /// the promise, which is the bug.
    ///
    /// No default audience, deliberately — the same reason as
    /// `tooBig(_:size:limit:for:)`. A default is how the wrong reader inherits the
    /// wrong words.
    static func outage(radio: CBManagerState, unit name: String?, dialling: Bool,
                       for audience: ReadAudience) -> String {
        // Nothing paired: the radio is not the story, and both readers need the same
        // one thing — where the pairing sheet is. (The panel's `unit == nil` branch
        // shows its own pitch and button, so in practice this arm is the relay's.)
        guard let board = name else {
            return "No Flipper is linked to this phone over Bluetooth. Pair it in the tiny app: Devices → this phone → Find my Flipper."
        }
        if let mine = radioProblem(radio, for: audience) { return mine }
        // The radio is fine and the board is remembered, but the phone has stopped
        // trying — so "wait for it" is the one answer that cannot come true. Asked
        // AFTER the radio, because with Bluetooth off nobody can re-pair anything
        // either and that has the one-tap fix.
        if !dialling { return abandoned(board, for: audience) }
        switch audience {
        case .relayReply:
            return "\(board) is paired with this phone but not connected right now — out of range, or powered off. The phone re-dials it on its own with a backoff, so it returns by itself once it is near; if it stays away, this phone stops offering the Flipper within a beat or two and you get a plain \"no route\" instead of this."
        case .panelSheet:
            return "Not connected — bring \(board) nearby, or tap Reconnect. It links again by itself once it is in range."
        }
    }

    /// A board that is remembered but no longer being dialled: the pairing did not
    /// hold, and only a person standing at this phone can start it again.
    ///
    /// Its own function rather than a second `switch audience` inside `outage`, for
    /// the same reason `radioProblem` is one: two switches on the same enum in one
    /// body make every slice of "the .relayReply arm" ambiguous — to a reader and to
    /// the tests, which cut these arms by label.
    ///
    /// ⚠️ Names Reconnect and the 6-digit code, and NOT the Flipper's own
    /// Settings → Bluetooth. This state is reached with a board the user still
    /// believes is theirs, and that screen is one row above "Forget all paired
    /// devices" — which would take their laptop and the official app with it. The
    /// pairing prompt is the whole remedy: iOS raises it again on the next subscribe.
    private static func abandoned(_ board: String, for audience: ReadAudience) -> String {
        switch audience {
        case .relayReply:
            return "\(board) is remembered by this phone, but the Bluetooth pairing did not hold — a declined prompt, a mistyped code, or the board no longer recognising this phone. The phone has deliberately stopped re-dialling it (retrying would re-raise the pairing prompt every few seconds), so waiting will not bring it back: somebody has to open tiny on that phone and tap Reconnect on the Flipper row, then confirm the 6-digit code the board shows."
        case .panelSheet:
            return "Not connected — the pairing didn't hold, so this phone is no longer retrying. Tap Reconnect and confirm the 6-digit code the Flipper shows."
        }
    }

    /// This PHONE's own radio, when IT is the reason — nil when the radio is fine
    /// and the board is the story.
    ///
    /// `.resetting` and `.unknown` are transients, not verdicts: bluetoothd restarts
    /// under us for half a second, and `.unknown` is simply the state before the
    /// first callback. Blaming the user's radio over either would be a false
    /// diagnosis in the one place a false diagnosis costs a pairing.
    private static func radioProblem(_ radio: CBManagerState,
                                     for audience: ReadAudience) -> String? {
        switch (radio, audience) {
        case (.poweredOff, .relayReply):
            return "THIS PHONE's Bluetooth is switched off, so nothing running on it can reach the Flipper — that is the phone's radio, not the board's, and the board is probably fine. It goes back on from the phone itself, in Control Centre or Settings; ask again after that."
        case (.poweredOff, .panelSheet):
            return "Not connected — this phone's Bluetooth is off, so nothing can reconnect until it is back on."
        case (.unauthorized, .relayReply):
            return "This phone has not allowed the tiny app to use Bluetooth, so it cannot reach the Flipper at all. That is granted on the phone, in Settings → tiny → Bluetooth; ask again after that."
        case (.unauthorized, .panelSheet):
            return "Not connected — tiny hasn't been allowed to use this phone's Bluetooth. Settings → tiny → Bluetooth."
        case (.unsupported, .relayReply):
            return "This phone has no Bluetooth LE radio the app can use, so it can never hold the Flipper over Bluetooth — the USB cable route is the only one left."
        case (.unsupported, .panelSheet):
            return "Not connected — this phone has no Bluetooth LE radio the app can use."
        default:
            return nil
        }
    }

    /// `outage(radio:unit:dialling:for:)` bound to this gateway's live state. Every
    /// surface that has to explain an unreachable board calls this and nothing else.
    func outageLine(for audience: ReadAudience) -> String {
        Self.outage(radio: radio, unit: unit?.name, dialling: wanted, for: audience)
    }

    /// Where THIS phone stands as the SECOND route to the Flipper.
    ///
    /// Only ever read to finish a sentence about the FIRST one being unreachable,
    /// so the cases are about what the phone can do for a reader who has just been
    /// told to go and wake a laptop.
    enum LocalRoute {
        /// Holding the board right now. Waking anything is optional.
        case holding
        /// A pairing exists but the board is not connected. WHICH of the six
        /// reasons applies belongs to the row that owns the link
        /// (`outageLine(for: .panelSheet)` says all of them), so this arm states
        /// the route is not the way in and sends the reader there.
        case notReaching
        /// No pairing yet, and a radio that could make one: one tap away.
        case offerable
        /// No pairing, and this phone's Bluetooth cannot make one — so the cable
        /// really is the only route, and offering a tap that cannot work would be
        /// worse than saying nothing.
        case noRadio
    }

    /// What this phone can do about a Flipper whose CABLE HOST is asleep — the
    /// clause that finishes `FlipperDevicePanel`'s "wake that machine" line.
    ///
    /// ⚠️ THE FIND: that panel is the surface this whole feature was built to
    /// obsolete, and it had never heard of the second route. Its asleep branch
    /// renders on a device row that still declares `flipper` (capabilities survive
    /// an offline period — it is the same state the backend's own `!host.online`
    /// arm exists for), and it answered with one remedy: *"wake that machine to
    /// reach the Flipper."* Meanwhile this phone can be holding that very board
    /// over Bluetooth, one row down, with `flipper_status` answering through it —
    /// so the app told the user to go and wake a laptop for a board in their
    /// pocket, and the agent and the panel disagreed about the same hardware.
    ///
    /// `lib/chat/tools/flipper.ts` already had exactly this clause for the agent
    /// (`aboutTheOtherRoute`, three arms, appended to the same refusal) — hazard
    /// 26(c): when a sibling rail has already worded a state, mirror it rather
    /// than invent a second vocabulary. This is that clause for the person holding
    /// the phone, so "capturing IR, Sub-GHz, RFID or iButton" is deliberately the
    /// backend's own list of what the cable is still for.
    ///
    /// ONE reader, so no `ReadAudience`: the relay's copy of this fact is the
    /// backend's, and no relay answer is ever built from a cable host's presence.
    /// Adding an audience here would be inventing a second reader (hazard 22).
    ///
    /// ⚠️ Every arm leads with a space — it is appended to a finished sentence,
    /// not returned on its own — and no arm names the Flipper's own
    /// Settings → Bluetooth screen, one row above "Forget all paired devices"
    /// (hazard 4). The radio it can talk about is THIS PHONE's.
    static func otherRoute(_ route: LocalRoute) -> String {
        switch route {
        case .holding:
            return " This phone is holding the Flipper over Bluetooth right now, though — tap Refresh on this phone's own row for its status. That machine is only needed for capturing IR, Sub-GHz, RFID or iButton, which Bluetooth cannot do."
        case .notReaching:
            return " The Bluetooth link on this phone isn't reaching it either — this phone's own Flipper row says why."
        case .offerable:
            return " Or skip the cable: this phone can hold the Flipper over Bluetooth — tap Find my Flipper on this phone's own row."
        case .noRadio:
            return " This phone could hold the Flipper over Bluetooth instead, but its own Bluetooth isn't available, so that machine is the way in for now."
        }
    }

    /// The live facts, in the order that decides which one is the story: a link
    /// that is up outranks everything, a pairing outranks the radio (the row it
    /// points at diagnoses the radio itself), and only a phone with no pairing AND
    /// no usable radio has nothing to offer.
    ///
    /// ⚠️ `linked`, `unit` and `radio` are all `@Published` — a sentence built from
    /// a plain `private var` cannot move the row when the user switches Bluetooth
    /// on (hazard 30(b), which cost `radio` its own fix).
    var localRoute: LocalRoute {
        if linked { return .holding }
        if unit != nil { return .notReaching }
        return radio == .poweredOn ? .offerable : .noRadio
    }

    /// `otherRoute(_:)` bound to this gateway's live state.
    func otherRouteClause() -> String { Self.otherRoute(localRoute) }

    /// The one-line answer for `flipper_status` when the phone is the host.
    /// Names the transport, because "over Bluetooth from this phone" is the
    /// difference between a Flipper in the user's pocket and one on a desk.
    ///
    /// ⚠️ And it names WHEN, because the interesting failure here is not a link
    /// that is down — that one is obvious and handled below — but a link that is
    /// up while the board has stopped answering RPC, which is what happens the
    /// moment an app opens on its screen. Every read then fails, `refresh()`
    /// keeps the last good `info`, and a line built from it states a remembered
    /// battery level in the present tense. The board can be flat, or not there.
    ///
    /// ⚠️ The cause comes from the READING — each read's own `FlipperReadOutcome` —
    /// never from this method, and never from one error stood in for all three. Guessing
    /// "something may be open on its screen" was right for one cause out of six and
    /// pointed the reader at the board's own screen for all of them — including the
    /// two that mean the opposite (this phone's radio went away, or the reader
    /// walked out of range), where the board is the one thing they cannot reach.
    /// `.status(17)` is what an open app actually looks like, and the board says it
    /// in those words itself.
    ///
    /// ⚠️ And BOTH arms that quote a `summary` have to say what is not in it, not
    /// just the fresh one. A reading is stored the moment it learns anything, so the
    /// line this method remembers may itself be two of three — and the arm that hands
    /// it over calls it "the last reading that worked", which reads as a whole one.
    /// c33 gave the fresh arm its clause and the panel row its live frame; the
    /// remembered line was the third renderer of the same conditional `summary`, and
    /// the only one with nothing beside it. **Count the renderers of the VALUE, not
    /// the callers of the disclosure.**
    func statusLine() async -> String {
        let name = unit?.name ?? "Flipper"
        // Unreachable as things stand — `handleFlipperEnvelope` guards `fg.linked`
        // before it dispatches, and that is this method's only caller. Kept, and
        // routed through the shared sentence anyway: an arm that answers the same
        // question in its own words is how the divergence this replaces got in.
        guard linked else { return outageLine(for: .relayReply) }
        let reading = await refresh(within: Self.relayStatusBudgetS)
        if reading.didLearn, let i = info {
            // ⚠️ The clause, not another sentence here. A reading that came back
            // without its battery is still a reading taken just now — what it is not
            // is the answer to the question that was asked, and "🔋" simply not being
            // in the line is not something a reader can notice.
            return "\(name) — \(i.summary) (over Bluetooth from this phone, read just now)\(Self.gapClause(reading, for: .relayReply))"
        }
        // ⚠️ Asked AGAIN, after the await. `linked` was last true up to
        // relayStatusBudgetS (20s) ago, and P5's acceptance run — pair it, unplug
        // the cable, walk away, ask from web chat — spends those seconds walking out
        // of range. The arm below used to open with "the Bluetooth link is up" in
        // exactly the case where the link dropping IS the answer. A stale `linked`
        // is hazard 30(b) read the other way round: the value moved, the sentence
        // did not.
        guard linked else { return outageLine(for: .relayReply) }
        let why = Self.whyNoReading(reading, for: .relayReply)
        if let i = info, let at = infoAt {
            // ⚠️ `i.gaps` — the STORED reading's own values, and NOT
            // `reading.missing`, which belongs to the attempt that just failed and
            // is already spoken for by `why`. The line quoted after the colon is an
            // OLDER reading, and the likeliest one to be sitting here came back with
            // two of its three parts: `deviceInfoS` (25s) outlasts this rail's whole
            // budget, so the read that stored it may never have asked for the battery
            // or the SD card. "The last reading that worked" is then a claim about
            // completeness that nothing in the sentence could refute, and a remembered
            // half-line reads as a Flipper with a flat battery and no card.
            //
            // The panel row has been refuting it live off these same values since c33
            // — this is the surface with no second line to put it on, so it carries
            // the frame inline (hazard 21: one fact, and the surface that keeps quiet
            // is the one that diverges).
            let short = Self.missingLine(i.gaps).map { " \($0)" } ?? ""
            return "\(name) — the Bluetooth link is still up, but no reading came back just now. \(why) This is the last reading that worked, \(Self.age(of: at)): \(i.summary)\(short)"
        }
        return "\(name) — connected over Bluetooth, but no reading has come back yet. \(why)"
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

    /// ⚠️ Every state below `.poweredOn` invalidates the peripheral we were
    /// holding, so every one of them is a lost link and gets the full teardown —
    /// not just the `linked` flag this used to clear. See `linkLost()` for what the
    /// other eight facts did when they survived a Bluetooth toggle.
    ///
    /// ⚠️ And none of them re-dials. `connectIfPossible()` is guarded on
    /// `state == .poweredOn`, so a `scheduleReconnect()` here would fire into a
    /// guard that returns — while still DOUBLING `reconnectDelay` on the way,
    /// inflating the backoff for the reconnect that will actually matter. The
    /// `.poweredOn` arm below is the wake-up, and it is immediate.
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        // Before the switch, so EVERY arm publishes it — including `.poweredOn`,
        // which reports no error and would otherwise leave the panel and the relay
        // still saying the radio is off after the user has turned it back on. This
        // is the fact `outage(radio:unit:for:)` reads.
        radio = central.state
        switch central.state {
        case .poweredOn:
            if unit != nil { connectIfPossible() }
            // `scanWanted`, not `scanning`: a radio that was off is exactly when the
            // flag the radio sets is false while a sheet is still asking. Reading it
            // would make a Bluetooth toggle the one loss a scan could NOT recover
            // from — the same shape of bug as the teardown below, one flag over.
            if scanWanted { beginScanIfPossible() }
        case .poweredOff:
            linkLost()
            lastError = "Bluetooth is off — the phone can't reach the Flipper without it."
        case .unauthorized:
            linkLost()
            lastError = "Bluetooth permission denied — the Flipper link needs it."
        default:
            // `.resetting` (bluetoothd restarting under us), `.unsupported`,
            // `.unknown` — same invalidated peripheral, and `.resetting` in
            // particular has no disconnect callback to fall back on.
            linkLost()
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
        // The firmware closes the RPC session on disconnect, which takes the screen
        // stream with it — so there is nothing to stop and nothing true left to
        // show. `linkLost()` holds that list, shared with the Bluetooth-went-away
        // path so the two cannot drift apart again.
        linkLost()
        // The only line that is NOT shared, and the reason it isn't: this is the
        // one loss the phone can dial its way out of. A radio that is off cannot.
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
        var txAlreadyNotifying = false
        var sawTx = false
        for ch in service.characteristics ?? [] {
            switch ch.uuid {
            case flipperTxUUID:
                sawTx = true
                // This subscribe is what raises the pairing prompt: the
                // characteristic is authenticated-read/write in the firmware, so
                // iOS bonds here and the Flipper shows its 6-digit code. It is
                // therefore the slowest step in the link, and the only one whose
                // duration is a person's — so nothing may assume it succeeded.
                // `didUpdateNotificationStateFor` carries the answer.
                if ch.isNotifying {
                    // A restored central can hand back a characteristic already
                    // subscribed. Re-requesting it is not guaranteed to produce
                    // another state callback, so treat the existing subscription
                    // as the confirmation it is.
                    txAlreadyNotifying = true
                } else {
                    peripheral.setNotifyValue(true, for: ch)
                }
            case flipperRxUUID:
                rxChar = ch
                rxWriteType = ch.properties.contains(.write) ? .withResponse : .withoutResponse
            case flipperFlowUUID:
                // Deliberately NOT gated on: credits absent means `waitForRoom`
                // sends anyway, which is the documented fail-open. A link that
                // works without flow control is worth more than a link refused
                // over decoration.
                peripheral.setNotifyValue(true, for: ch)
            default:
                break
            }
        }
        guard rxChar != nil else {
            lastError = "The Flipper's serial service is missing its write characteristic."
            return
        }
        // Without this the wait below is silent and permanent: no subscription
        // request was issued, so no state callback is coming, and the panel would
        // sit on "connecting" with nothing to read.
        guard sawTx else {
            lastError = "The Flipper's serial service is missing the characteristic it answers on."
            return
        }
        // RPC is already open: the firmware calls rpc_session_open(RpcOwnerBle)
        // from its own GapEventTypeConnected handler (bt.c). There is no
        // start_rpc_session over BLE — sending one would be a protobuf frame of
        // ASCII text. But asking it something is still premature until TX is
        // notifying, because that is the only path an answer can take.
        if txAlreadyNotifying { finishLink() }
    }

    /// The TX subscription's verdict — and the only place a failed bond is
    /// visible.
    ///
    /// Every characteristic on this service is `ATTR_PERMISSION_AUTHEN_*`, so a
    /// declined pairing prompt or a mistyped 6-digit code surfaces here as an ATT
    /// authentication error and NOWHERE else: the connection stays up, discovery
    /// already succeeded, and no write reports back (this file writes RPC frames
    /// without waiting on `didWriteValueFor`). Unobserved, the sole symptom was a
    /// ping timeout, and the sentence it produced sent the user to the Flipper's
    /// screen to close an app that was not the problem.
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        // Flow control failing is survivable; only TX decides whether there is a
        // link at all.
        guard characteristic.uuid == flipperTxUUID else { return }
        if let error {
            linked = false
            lastError = Self.subscribeFailureText(error)
            // Release the board's single central slot rather than hold a
            // connection that can never carry a frame — an occupied slot is how
            // the Flipper looks broken to the user's laptop and to the official
            // app. `stop()` also clears `wanted`, so `scheduleReconnect()` returns
            // immediately: re-dialling here would re-raise the pairing prompt every
            // couple of seconds at a user who just declined one.
            stop()
            return
        }
        guard characteristic.isNotifying else {
            // An unsubscribe we did not ask for. Nothing can answer now, and
            // claiming a link would be a lie about a one-way pipe.
            linked = false
            return
        }
        finishLink()
    }

    /// Why a subscription failed, in the user's terms. Pairing is the likely
    /// cause and the only one they can act on, so it gets named explicitly instead
    /// of arriving as "The operation couldn't be completed."
    ///
    /// ⚠️ It said "Tap Pair again", and there is no Pair button — not on the panel
    /// row this renders under (Reconnect / Unlink), not in the pairing sheet, where
    /// the control is the board's own name in a list. `FlipperLinkProblem` puts this
    /// sentence on all four Flipper surfaces, so the action it names has to be one
    /// that exists on the one where the link is resumed.
    static func subscribeFailureText(_ error: Error) -> String {
        let pairing: String
        if let att = error as? CBATTError {
            switch att.code {
            case .insufficientAuthentication, .insufficientEncryption, .insufficientAuthorization:
                pairing = "Pairing didn't complete"
            default:
                pairing = ""
            }
        } else if let cb = error as? CBError, cb.code == .peerRemovedPairingInformation {
            pairing = "The Flipper no longer recognises this phone"
        } else {
            pairing = ""
        }
        guard pairing.isEmpty else {
            return "\(pairing), so the Flipper won't talk over Bluetooth. Tap Reconnect and enter the 6-digit code the Flipper shows — if it shows none, turn Bluetooth off and on in the Flipper's own settings first."
        }
        return "Couldn't subscribe to the Flipper's serial service: \(error.localizedDescription)"
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

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
    case notLinked
    case timeout(String)
    case status(UInt64)
    case refused(String)
    case malformed(String)
    /// The board's receive buffer never drained enough to take the whole
    /// command. Its own error, not a timeout, because the cause and the cure are
    /// different: nothing was sent, and retrying in a moment usually works.
    case noRoom

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
        case .noRoom:
            return "The Flipper's Bluetooth buffer stayed full, so the command wasn't sent. Try again in a moment."
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
    @Published private(set) var infoAt: Date?
    @Published private(set) var lastError: String?
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
    private var wanted = false
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
        // 15-second wait into an immediate, accurate answer.
        failAllPending(FlipperError.notLinked)
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
        failAllPending(FlipperError.malformed("the Bluetooth stream"))
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
            // Not silent: otherwise the panel just says "Not streaming." about a
            // mirror the user left running, and the stop we sent looks like the
            // board's fault.
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

    /// Fill `info` from the board. Each piece is independent: a Flipper that
    /// answers DeviceInfo but not Storage.Info (no SD card) should still show its
    /// firmware rather than one blanket failure.
    /// Read firmware, battery and free space.
    ///
    /// Returns **whether this attempt actually learned anything**, which is the
    /// half that used to be missing. Every read is `try?` on purpose — a board
    /// that answers two of three is worth showing — but that also means total
    /// failure looked exactly like success to every caller, and the previous
    /// reading was then presented as the current one. `infoAt` moves only when
    /// the reading does, so nothing downstream can date a memory as fresh.
    ///
    /// `budget` caps the WHOLE read, not each request: with three ceilings adding
    /// up to 52s, an unbounded refresh could outlive the relay caller waiting for
    /// it. Reads are dropped from the end when time runs short, so a slow board
    /// still yields firmware and battery rather than nothing at all.
    @discardableResult
    func refresh(within budget: TimeInterval = .infinity) async -> Bool {
        let started = Date()
        /// What this read may ask for, or nil when there is no point asking.
        func allow(_ want: TimeInterval) -> TimeInterval? {
            guard budget.isFinite else { return want }
            let left = budget - Date().timeIntervalSince(started)
            return left >= Self.minRequestS ? min(want, left) : nil
        }
        var next = FlipperInfo()
        if let t = allow(Self.deviceInfoS), let d = try? await deviceInfo(timeout: t) {
            next.firmware = d["firmware_version"] ?? ""
            next.model = d["hardware_model"] ?? ""
            next.deviceName = d["hardware_name"] ?? ""
        }
        if let t = allow(Self.powerInfoS), let p = try? await powerInfo(timeout: t) {
            next.batteryPct = p["charge_level"].flatMap { Int($0) }
            next.chargeState = p["charge_state"] ?? ""
        }
        if let t = allow(Self.storageInfoS), let s = try? await storageInfo(timeout: t) {
            next.totalBytes = s.total
            next.freeBytes = s.free
        }
        // `let` before the hop: a var captured by a concurrently-executing
        // closure is an error under Swift 6.
        let reading = next
        // An answer that carried no values is not a reading. The board can reply
        // OK to DeviceInfo and hand back nothing usable, and treating that as
        // success would re-date the old line without replacing it.
        let learned = reading != FlipperInfo()
        await MainActor.run {
            // Keep the last good reading if this attempt learned nothing — a
            // blank panel is worse than a stale line. What must NOT be kept is
            // the impression that it is current, which is what `infoAt` is for.
            if learned {
                self.info = reading
                self.infoAt = Date()
            }
        }
        return learned
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
    func statusLine() async -> String {
        let name = unit?.name ?? "Flipper"
        guard linked else {
            return unit == nil
                ? "No Flipper is paired with this phone."
                : "\(name) is paired but not connected right now — it's out of range or powered off."
        }
        let fresh = await refresh(within: Self.relayStatusBudgetS)
        if fresh, let i = info {
            return "\(name) — \(i.summary) (over Bluetooth from this phone, read just now)"
        }
        if let i = info, let at = infoAt {
            return "\(name) — the Bluetooth link is up, but it didn't answer a status request just now; something may be open on its screen. This is the last reading that worked, \(Self.age(of: at)): \(i.summary)"
        }
        return "\(name) — connected over Bluetooth, but it hasn't answered a status request yet. If an app is open on its screen, close it and ask again."
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
            return "\(pairing), so the Flipper won't talk over Bluetooth. Tap Pair again and enter the 6-digit code the Flipper shows — if it shows none, turn Bluetooth off and on in the Flipper's own settings first."
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

/**
 * TinyWifiTests — the wire, the reassembly, and every claim the WiFi sheet makes.
 *
 * Own file rather than more suites in TinyTests.swift: this is one feature's
 * contract with one piece of firmware (strands-nicla `firmware/tiny_ble.py`), and
 * the pairs of tests that only make sense read together — a request beside the
 * reply it correlates with — are the point.
 */
import Testing
import Foundation
@testable import Tiny

// ── Requests ──────────────────────────────────────────────────────────────

@Suite struct TinyWifiRequestTests {

    private func body(_ req: TinyWifiRequest) -> [String: Any] {
        let frame = req.frame
        #expect(frame.last == 0x0A, "every request ends in the firmware's terminator")
        let json = frame.dropLast()
        return (try? JSONSerialization.jsonObject(with: Data(json)) as? [String: Any]) ?? [:]
    }

    @Test func statusCarriesNothingButTheCommand() {
        let req = TinyWifiRequest.status()
        #expect(req.cmd == "status")
        #expect(body(req) as? [String: String] == ["cmd": "status"])
    }

    @Test func joinWithoutAKeyOmitsItEntirely() {
        // ⚠️ Not `"key": ""`. The firmware reads a MISSING key as "keep the
        // password you already have" and an empty string as a real one (an open
        // network), so sending "" for "I don't know it" would overwrite a working
        // password with a blank and the board would never associate again.
        let req = TinyWifiRequest.join(ssid: "Office")
        let obj = body(req)
        #expect(obj["cmd"] as? String == "join")
        #expect(obj["ssid"] as? String == "Office")
        #expect(obj["key"] == nil)
        #expect(obj.count == 2)
    }

    @Test func joinWithAnEmptyKeySendsIt() {
        let obj = body(TinyWifiRequest.join(ssid: "Airport", key: ""))
        #expect(obj["key"] as? String == "")
    }

    @Test func joinCarriesThePasswordVerbatim() {
        let obj = body(TinyWifiRequest.join(ssid: "Hotspot", key: "p@ss word\"1"))
        #expect(obj["key"] as? String == "p@ss word\"1")
    }

    @Test func pushSpeaksTheFirmwaresFieldNames() {
        // `key`, not `password` — and via WifiNetworks.wire, so there is exactly
        // one place in the app that knows what a network looks like on the air.
        let req = TinyWifiRequest.push([WifiNetwork(ssid: "Home", password: "h"),
                                        WifiNetwork(ssid: "Cafe", password: "")])
        let nets = body(req)["networks"] as? [[String: String]]
        #expect(nets == [["ssid": "Home", "key": "h"], ["ssid": "Cafe", "key": ""]])
    }

    @Test func pushPreservesOrderBecauseOrderIsThePreference() {
        let req = TinyWifiRequest.push([WifiNetwork(ssid: "B", password: "1"),
                                        WifiNetwork(ssid: "A", password: "2")])
        let nets = body(req)["networks"] as? [[String: String]]
        #expect(nets?.map { $0["ssid"] } == ["B", "A"])
    }

    @Test func onlyTheScanWaitsForTheRadio() {
        // A scan is the one command the board defers to its own loop, which may be
        // parked inside an HTTPS POST. Everything else is answered from its GATT
        // interrupt, so a long budget there would only make a dead link feel dead
        // for longer.
        #expect(TinyWifiRequest.scan().patience > TinyWifiRequest.status().patience)
        for req in [TinyWifiRequest.status(), .join(ssid: "A"), .forget(ssid: "A"),
                    .reboot(), .push([WifiNetwork(ssid: "A", password: "")])] {
            #expect(req.patience == TinyWifiRequest.quick, "\(req.cmd)")
        }
    }
}

// ── Reading replies ───────────────────────────────────────────────────────

@Suite struct TinyWifiWireTests {

    private func read(_ text: String) -> TinyWifiFrame {
        TinyWifiWire.read(Data(text.utf8))
    }

    @Test func aStatusReplyCarriesTheSavedListAndTheLiveHalf() {
        guard case .reply(let r) = read(#"{"ok":true,"cmd":"status","saved":["Sofa","Office"],"provisioned":true,"mode":"node","ssid":"Sofa","ip":"10.0.0.9"}"#)
        else { Issue.record("expected a reply"); return }
        #expect(r.ok && r.cmd == "status")
        #expect(r.saved == ["Sofa", "Office"])
        #expect(r.ssid == "Sofa" && r.ip == "10.0.0.9" && r.mode == "node")
        #expect(r.provisioned == true)
    }

    @Test func aRefusalKeepsTheBoardsOwnWords() {
        guard case .reply(let r) = read(#"{"ok":false,"cmd":"forget","error":"last network"}"#)
        else { Issue.record("expected a reply"); return }
        #expect(!r.ok && r.error == "last network" && r.cmd == "forget")
    }

    @Test func anAckWithNoCmdIsOldFirmwareAndItHasAlreadyRebooted() {
        // ⚠️ The capability probe, and the reason a bare `ok` cannot be read as
        // success: `cmd` is not in the firmware's config allowlist, so a board
        // older than this feature merges {"cmd":"status"} as an empty config,
        // answers exactly this, and hard-resets. Treating it as a successful
        // status would leave the sheet claiming a board is fine while it reboots.
        #expect(read(#"{"ok":true,"complete":true}"#) == .legacyAck)
        #expect(read(#"{"ok":true,"complete":false,"missing":["token"]}"#) == .legacyAck)
    }

    @Test func ourOwnEchoedWriteIsNotAnAnswer() {
        // ArduinoBLE notifies subscribers on a central write too, so the board can
        // hand our own chunks back before it ever replies. Nothing without `ok` in
        // it is a verdict.
        #expect(read(#"{"cmd":"join","ssid":"Office"}"#) == .noise)
        #expect(read(#"{"cmd": "join", "ss"#) == .noise)
        #expect(read("") == .noise)
        #expect(read("[1,2,3]") == .noise)
        #expect(read(#"{"ok":"yes"}"#) == .noise, "ok must be a bool, not a truthy string")
    }

    @Test func aRefusalWithoutACmdIsNotReadAsARebootNotice() {
        // {"ok":false,"error":"bad json"} is what the CURRENT firmware answers to a
        // corrupt payload — and it carries no cmd. Calling that `legacyAck` would
        // tell the owner to reflash a board that merely failed to parse a frame.
        #expect(read(#"{"ok":false,"error":"bad json"}"#) == .noise)
    }

    @Test func aScanReplyParsesTheRowsTheBoardMeasured() {
        guard case .reply(let r) = read(#"{"ok":true,"cmd":"scan","networks":[{"ssid":"Home","rssi":-42,"secure":true},{"ssid":"Cafe","rssi":-80,"secure":false}]}"#)
        else { Issue.record("expected a reply"); return }
        #expect(r.scanned == [TinyScannedNetwork(ssid: "Home", rssi: -42, secure: true),
                              TinyScannedNetwork(ssid: "Cafe", rssi: -80, secure: false)])
    }

    @Test func aScanRowWithoutARssiSortsLastRatherThanStrongest() {
        // On this scale 0 dBm is a signal in the same room. A row missing its rssi
        // must not be shown as the best network in range.
        let rows = TinyWifiWire.scanned([["ssid": "Ghost"], ["ssid": ""], ["rssi": -40]])
        #expect(rows.count == 1)
        #expect(rows[0].ssid == "Ghost" && rows[0].rssi == -127)
        #expect(rows[0].strength == "very weak")
    }

    @Test func anUnknownSecurityFlagAssumesAPasswordIsNeeded() {
        // Guessing "open" would make the sheet skip the password prompt and send a
        // join the board answers with 20 seconds of failure.
        let rows = TinyWifiWire.scanned([["ssid": "Mystery", "rssi": -50]])
        #expect(rows[0].secure)
    }

    @Test func onlyAResetIsAnnouncedAsOne() {
        guard case .reply(let reconnect) = read(#"{"ok":true,"cmd":"join","saved":["A"],"applying":"reconnect"}"#),
              case .reply(let reset) = read(#"{"ok":true,"cmd":"reboot","applying":"reset"}"#),
              case .reply(let nothing) = read(#"{"ok":true,"cmd":"forget","saved":["A"],"applying":null}"#)
        else { Issue.record("expected replies"); return }
        #expect(!reconnect.expectsReboot)
        #expect(reset.expectsReboot)
        #expect(!nothing.expectsReboot && nothing.applying == nil)
    }
}

// ── Reassembly ────────────────────────────────────────────────────────────

@Suite struct TinyWifiInboxTests {

    @Test func aFrameIsOnlyWholeAtTheNewline() {
        // A notification carries MTU-3 bytes and the controller drops the rest
        // silently, so a scan list arrives in pieces. Parsing a piece is how a
        // board that is answering perfectly gets reported as unreadable.
        var inbox = TinyWifiInbox()
        let whole = #"{"ok":true,"cmd":"status","saved":["Sofa","Office","Hotspot"],"mode":"node","ssid":"Sofa","ip":"10.0.0.9"}"# + "\n"
        let bytes = Array(whole.utf8)
        var frames: [TinyWifiFrame] = []
        for i in stride(from: 0, to: bytes.count, by: 20) {
            let chunk = Data(bytes[i ..< min(i + 20, bytes.count)])
            frames += inbox.accept(chunk)
        }
        #expect(frames.count == 1)
        guard case .reply(let r) = frames[0] else { Issue.record("not a reply"); return }
        #expect(r.saved == ["Sofa", "Office", "Hotspot"] && r.ip == "10.0.0.9")
    }

    @Test func twoRepliesInOneChunkBothArrive() {
        var inbox = TinyWifiInbox()
        let frames = inbox.accept(Data((#"{"ok":true,"cmd":"join","saved":["A"]}"# + "\n"
                                        + #"{"ok":true,"cmd":"status","saved":["A"]}"# + "\n").utf8))
        #expect(frames.count == 2)
        if case .reply(let a) = frames[0], case .reply(let b) = frames[1] {
            #expect(a.cmd == "join" && b.cmd == "status")
        } else {
            Issue.record("expected two replies")
        }
    }

    @Test func anIncompleteTailIsHeldForTheNextNotification() {
        var inbox = TinyWifiInbox()
        #expect(inbox.accept(Data(#"{"ok":true,"cmd":"sca"#.utf8)).isEmpty)
        let frames = inbox.accept(Data(("n\",\"networks\":[]}" + "\n").utf8))
        #expect(frames.count == 1)
        if case .reply(let r) = frames[0] { #expect(r.cmd == "scan" && r.scanned == []) }
        else { Issue.record("expected a reply") }
    }

    @Test func aStrandedFragmentCannotGrowForever() {
        // The board resets mid-notification and leaves a partial document behind;
        // this object outlives that, for as long as the sheet is open. An unbounded
        // buffer produces exactly the same frames as a bounded one right up until
        // the memory is gone, which is why the byte count is asserted directly.
        var inbox = TinyWifiInbox()
        for _ in 0 ..< 40 {
            #expect(inbox.accept(Data(repeating: 0x41, count: 200)).isEmpty)
            #expect(inbox.pending <= TinyWifiInbox.ceiling)
        }
        // The fragment is only ever DELIMITED by the next newline, so whatever is
        // glued onto it is one corrupt line — and it reads as noise, never as a
        // reply. Losing a frame to a board that reset mid-notification is honest;
        // inventing one from half a document is not.
        let glued = inbox.accept(Data((#"{"ok":true,"cmd":"status","saved":[]}"# + "\n").utf8))
        #expect(glued == [.noise])

        // And the stream recovers: the frame AFTER that boundary parses normally.
        let frames = inbox.accept(Data((#"{"ok":true,"cmd":"status","saved":["A"]}"# + "\n").utf8))
        #expect(frames.count == 1)
        if case .reply(let r) = frames[0] { #expect(r.cmd == "status" && r.saved == ["A"]) }
        else { Issue.record("a newline must resynchronize the stream") }
    }

    @Test func anEmptyLineIsNotAFrame() {
        var inbox = TinyWifiInbox()
        #expect(inbox.accept(Data("\n\n".utf8)).isEmpty)
    }
}

// ── The snapshot and its sentences ────────────────────────────────────────

@Suite struct TinyWifiSnapshotTests {

    private func reply(_ text: String) -> TinyWifiReply {
        guard case .reply(let r) = TinyWifiWire.read(Data(text.utf8)) else {
            Issue.record("fixture is not a reply: \(text)")
            return TinyWifiReply(cmd: "?", ok: false)
        }
        return r
    }

    @Test func beforeAnyAnswerTheSheetClaimsNothing() {
        // An empty saved list and "we have not asked" look identical, and only one
        // of them is a statement about the board.
        let fresh = TinyWifiSnapshot()
        #expect(!fresh.heard && fresh.line == "Asking the board…")
        #expect(!fresh.isOnline)
    }

    @Test func aJoinReplyDoesNotEraseTheAddressStatusReported() {
        // ⚠️ The reason this accumulates instead of replacing. A join answer carries
        // the new order and says nothing about the IP; overwriting would blank a
        // line that is still true, and the sheet would read as "not connected"
        // immediately after a successful switch.
        var s = TinyWifiSnapshot()
        s.apply(reply(#"{"ok":true,"cmd":"status","saved":["Sofa","Office"],"mode":"node","ssid":"Sofa","ip":"10.0.0.9"}"#))
        s.apply(reply(#"{"ok":true,"cmd":"join","saved":["Office","Sofa"],"applying":"reconnect"}"#))
        #expect(s.saved == ["Office", "Sofa"])
        #expect(s.ssid == "Sofa" && s.ip == "10.0.0.9")
    }

    @Test func aStatusReplyWithoutALiveHalfClearsTheOldOne() {
        // The other direction, and it matters more: the board publishes its live
        // half only while a loop owns the radio, so status answering WITHOUT an
        // ssid means it is no longer on that network. Keeping the previous value
        // would show a necklace as connected to a network it has left.
        var s = TinyWifiSnapshot()
        s.apply(reply(#"{"ok":true,"cmd":"status","saved":["Sofa"],"mode":"node","ssid":"Sofa","ip":"10.0.0.9"}"#))
        s.apply(reply(#"{"ok":true,"cmd":"status","saved":["Sofa"],"mode":"joining"}"#))
        #expect(s.ssid == nil && s.ip == nil)
        #expect(s.line == "Trying its saved networks…")
        #expect(!s.isOnline)
    }

    @Test func aRefusalChangesNothingAtAll() {
        var s = TinyWifiSnapshot()
        s.apply(reply(#"{"ok":true,"cmd":"status","saved":["Sofa"],"mode":"node","ssid":"Sofa","ip":"10.0.0.9"}"#))
        s.apply(reply(#"{"ok":false,"cmd":"forget","error":"last network"}"#))
        #expect(s.saved == ["Sofa"] && s.ssid == "Sofa")
    }

    @Test func theThreeModesGetThreeDifferentSentences() {
        // A board sweeping its list and a board that gave up both report no
        // network. Only one is worth waiting out, and only one needs the owner to
        // walk over to it.
        var joining = TinyWifiSnapshot()
        joining.apply(reply(#"{"ok":true,"cmd":"status","saved":["A"],"mode":"joining"}"#))
        var portal = TinyWifiSnapshot()
        portal.apply(reply(#"{"ok":true,"cmd":"status","saved":["A"],"mode":"portal"}"#))
        var node = TinyWifiSnapshot()
        node.apply(reply(#"{"ok":true,"cmd":"status","saved":["A"],"mode":"node","ssid":"A","ip":"10.0.0.4"}"#))

        #expect(joining.line == "Trying its saved networks…")
        #expect(portal.line.contains("setup mode"))
        #expect(node.line == "On A · 10.0.0.4")
        #expect(Set([joining.line, portal.line, node.line]).count == 3)
        #expect(node.isOnline && !joining.isOnline && !portal.isOnline)
    }

    @Test func aBoardOnANetworkWithNoAddressYetIsNotCalledOnline() {
        // Associated but no DHCP lease is 0.0.0.0 territory: nothing on the LAN
        // can reach it, so the green line would be a promise the app can't keep.
        var s = TinyWifiSnapshot()
        s.apply(reply(#"{"ok":true,"cmd":"status","saved":["A"],"mode":"node","ssid":"A","ip":""}"#))
        #expect(s.line == "On A")
        #expect(!s.isOnline)
    }

    @Test func anAnswerWithNoModeAtAllSaysSoRatherThanGuessing() {
        // The firmware omits the live half entirely when no loop has published one
        // (a board mid-boot). "Not on a network" would be a claim it never made.
        var s = TinyWifiSnapshot()
        s.apply(reply(#"{"ok":true,"cmd":"status","saved":["A"],"provisioned":true}"#))
        #expect(s.heard && s.line == "The board hasn't reported a network yet.")
    }

    @Test func aScanReplaceSurvivesTheNextStatus() {
        var s = TinyWifiSnapshot()
        s.apply(reply(#"{"ok":true,"cmd":"scan","networks":[{"ssid":"Home","rssi":-40,"secure":true}]}"#))
        s.apply(reply(#"{"ok":true,"cmd":"status","saved":["Home"],"mode":"node","ssid":"Home","ip":"10.0.0.2"}"#))
        #expect(s.scanned.map(\.ssid) == ["Home"])
    }
}

// ── Outcomes ──────────────────────────────────────────────────────────────

@Suite struct TinyWifiOutcomeTests {

    @Test func successSaysNothing() {
        #expect(TinyWifiOutcome.answered(TinyWifiReply(cmd: "join", ok: true)).message == nil)
    }

    @Test func aTimeoutDoesNotClaimTheChangeFailed() {
        // ⚠️ The same rule EnrollOutcome draws: a refusal is a DECISION the board
        // reported, a timeout is the absence of one. A join is answered from the
        // firmware's interrupt and then takes up to 20s PER network to associate,
        // so "it didn't work" is a claim about the board's flash this phone cannot
        // make — and it invites a second write while the first is being applied.
        let text = TinyWifiOutcome.timedOut.message ?? ""
        #expect(text.contains("may have applied"))
        #expect(!TinyWifiOutcome.timedOut.isFatal, "the link is still there; let them retry")
    }

    @Test func aRefusalQuotesTheBoard() {
        #expect(TinyWifiOutcome.refused("last network").message == "The board refused: last network.")
        #expect(!TinyWifiOutcome.refused("x").isFatal)
    }

    @Test func oldFirmwareIsFatalAndSaysWhatAskingCost() {
        let text = TinyWifiOutcome.unsupported.message ?? ""
        #expect(text.contains("restarted"), "asking rebooted the board — say so")
        #expect(text.contains("firmware"))
        #expect(TinyWifiOutcome.unsupported.isFatal, "no further command can work")
    }

    @Test func everyOutcomeThatIsNotSuccessHasSomethingToSay() {
        for outcome in [TinyWifiOutcome.refused("why"), .unsupported, .timedOut,
                        .offline("gone")] {
            #expect(outcome.message?.isEmpty == false, "\(outcome)")
        }
    }
}

// ── Routing ───────────────────────────────────────────────────────────────

@Suite struct TinyBeaconSheetTests {

    private func beacon(version: Int, provisioned: Bool) -> BleDevice {
        BleDevice(id: UUID(uuidString: "00000000-0000-0000-0000-0000000000\(version)0")!,
                  name: "tiny-a1b2", rssi: -50,
                  tiny: TinyBeaconInfo(version: version, provisioned: provisioned))
    }

    @Test func aConfiguredVisionGoesToWifiNotToEnrollment() {
        // ⚠️ The whole point of the feature. Setup mints a device token and returns
        // it ONCE, so sending a configured board back through it creates a second
        // row for one necklace and orphans the first — permanently. Changing WiFi
        // must not be able to reach that flow by accident.
        let d = beacon(version: 1, provisioned: true)
        #expect(TinyBeaconSheet.tapped(d) == .wifi(d))
        #expect(TinyBeaconSheet.actionLabel(d) == "WiFi")
    }

    @Test func anUnconfiguredVisionStillNeedsEnrolling() {
        let d = beacon(version: 1, provisioned: false)
        #expect(TinyBeaconSheet.tapped(d) == .setUp(d))
        #expect(TinyBeaconSheet.actionLabel(d) == "Set up")
    }

    @Test func aVoiceNeverGetsAWifiSheetEvenWhenConfigured() {
        // nRF52832: no WiFi radio at all. A sheet of network controls for it would
        // be a screen where nothing can succeed.
        let d = beacon(version: 2, provisioned: true)
        #expect(TinyBeaconSheet.tapped(d) == .setUp(d))
        #expect(TinyBeaconSheet.actionLabel(d) == "Reconfigure")
    }

    @Test func anUnknownBoardIsTreatedAsSetupOnly() {
        // A version byte this build has never seen may be a board with no radio.
        // Offering WiFi to it is a guess; offering setup is what already happened.
        let d = beacon(version: 9, provisioned: true)
        #expect(TinyBeaconSheet.tapped(d) == .setUp(d))
    }

    @Test func aPlainBluetoothDeviceIsNeverOfferedWifi() {
        let d = BleDevice(id: UUID(), name: "Someone's AirPods", rssi: -60, tiny: nil)
        #expect(TinyBeaconSheet.tapped(d) == .setUp(d))
        #expect(TinyBeaconSheet.actionLabel(d) == "Set up")
    }

    @Test func thetwoSheetsAreDistinctItemsForOneBoard() {
        // The sheets are presented by `item:`; identical ids would let SwiftUI
        // reuse the presented sheet and show the wrong one for the same beacon.
        let d = beacon(version: 1, provisioned: true)
        #expect(TinyBeaconSheet.wifi(d).id != TinyBeaconSheet.setUp(d).id)
        #expect(TinyBeaconSheet.wifi(d).beacon == d)
    }
}

// ── Who may be dialled ────────────────────────────────────────────────────

/// The scan filter, and the reason it had to move out of `scanForPeripherals`.
///
/// `VISION_ADV` is the real 31-byte-budget payload the necklace transmits, taken
/// byte for byte from `firmware/tiny_ble.py adv_payload("tiny-b3d3", …)` — the
/// board's own code, run for both provisioned states. Every gate case below is
/// fed a record EXTRACTED from that payload rather than a second hand-typed copy
/// of it, so a change to the firmware's layout breaks these tests instead of
/// quietly agreeing with them.
@Suite struct TinyWifiBeaconGateTests {

    static let visionAdvUnprovisioned: [UInt8] = [
        0x02, 0x01, 0x06,
        0x0a, 0x09, 0x74, 0x69, 0x6e, 0x79, 0x2d, 0x62, 0x33, 0x64, 0x33,   // "tiny-b3d3"
        0x07, 0xff, 0xff, 0xff, 0x54, 0x4e, 0x01, 0x00,
    ]
    static let visionAdvProvisioned: [UInt8] =
        Array(TinyWifiBeaconGateTests.visionAdvUnprovisioned.dropLast()) + [0x01]

    /// The Voice's record as CoreBluetooth reports it: company id, then the eight
    /// bytes of `tvMfg` from firmware/voice/tiny_voice/tiny_voice.ino — 'T','N',
    /// TV_BEACON_VERSION = 2, provisioned, then its link-health counters. TEN
    /// bytes, not six: the counters are appended after the contract prefix.
    static let voiceMfg = Data([0xff, 0xff, 0x54, 0x4e, 0x02, 0x01, 0x03, 0x02, 0x11, 0x00])

    /// Walk the length-prefixed AD structures and hand back one record's value.
    private func record(_ payload: [UInt8], type: UInt8) -> Data? {
        var i = 0
        while i < payload.count, payload[i] != 0 {
            let len = Int(payload[i])
            guard len >= 2, i + len < payload.count else { return nil }
            if payload[i + 1] == type {
                return Data(payload[(i + 2) ... (i + len)])
            }
            i += len + 1
        }
        return nil
    }

    @Test func theBoardAdvertisesNoServiceUuidAtAll() {
        // ⚠️ THE POSITIVE CONTROL for the scan fix. CoreBluetooth's
        // `withServices:` matches on the advertisement and cannot connect to look
        // further, so a scan filtered on the setup service found this board
        // never. These are the four AD types that could have carried one
        // (16-bit/128-bit, partial and complete lists) and not one is present.
        for type: UInt8 in [0x02, 0x03, 0x06, 0x07] {
            #expect(record(Self.visionAdvUnprovisioned, type: type) == nil,
                    "AD type \(type) would have made the old filtered scan work")
        }
        // What IS there: the name and the manufacturer record.
        #expect(record(Self.visionAdvUnprovisioned, type: 0x09)
                == Data("tiny-b3d3".utf8))
        #expect(record(Self.visionAdvUnprovisioned, type: 0xff) != nil)
    }

    @Test func aVisionIsDialledWhicheverWayItIsConfigured() {
        // Both, because the sheet is reached from the beacon list in either state
        // and an unprovisioned board is exactly the one an owner is setting up.
        for payload in [Self.visionAdvUnprovisioned, Self.visionAdvProvisioned] {
            let mfg = record(payload, type: 0xff)
            #expect(mfg != nil)
            #expect(TinyWifiBeaconGate.isCandidate(manufacturerData: mfg))
        }
    }

    @Test func aVoiceIsLeftAlone() {
        // A real tiny board with no WiFi radio. Dialling it spends the link
        // budget to arrive at "setup service missing" — about the wrong device.
        #expect(TinyBeaconInfo.parse(Self.voiceMfg)?.kind == .voice)
        #expect(!TinyWifiBeaconGate.isCandidate(manufacturerData: Self.voiceMfg))
    }

    @Test func aStrangersHeadphonesAreNotADevice() {
        // The scan is unfiltered now, so this is the case that keeps `onAir`
        // from filling with the room and the rescue path from dialling into it.
        #expect(!TinyWifiBeaconGate.isCandidate(
            manufacturerData: Data([0x4c, 0x00, 0x07, 0x19, 0x01, 0x02])))   // Apple
        #expect(!TinyWifiBeaconGate.isCandidate(manufacturerData: nil))
        #expect(!TinyWifiBeaconGate.isCandidate(manufacturerData: Data()))
    }

    @Test func theMagicAndTheLengthAreBothRequired() {
        var truncated = Self.voiceMfg
        truncated.removeLast(6)                                     // 4 bytes left
        #expect(!TinyWifiBeaconGate.isCandidate(manufacturerData: truncated))
        // Right company id, wrong magic — some other 0xFFFF test beacon.
        #expect(!TinyWifiBeaconGate.isCandidate(
            manufacturerData: Data([0xff, 0xff, 0x58, 0x59, 0x01, 0x01])))
    }

    @Test func aFutureBoardIsGivenTheBenefitOfTheDoubt() {
        // An unrecognized version is not a Voice, and refusing to dial it would
        // make a firmware bump look like a broken necklace.
        let v9 = Data([0xff, 0xff, 0x54, 0x4e, 0x09, 0x01])
        #expect(TinyBeaconInfo.parse(v9)?.kind == .unknown)
        #expect(TinyWifiBeaconGate.isCandidate(manufacturerData: v9))
    }
}

// ── A drop the board promised ─────────────────────────────────────────────

/// `applying` names what the board is about to do to itself, and both values it
/// can send take the Bluetooth link with them — for different reasons and with
/// different recoveries.
@Suite struct TinyWifiExpectedDropTests {

    private func reply(_ applying: String?) -> TinyWifiReply {
        TinyWifiReply(cmd: "join", ok: true, applying: applying)
    }

    @Test func aReconnectPromisesADropWithoutAReboot() {
        // ⚠️ WiFi and Bluetooth are one CYW4343W on a Nicla Vision. Measured over
        // the air: a `join` was acked, the board re-associated and came back on
        // 192.168.1.207, and the link died mid-session. Success, reported as
        // "The board disconnected" until this flag existed.
        let r = reply("reconnect")
        #expect(r.expectsDrop)
        #expect(!r.expectsReboot)
    }

    @Test func aResetIsStillAReboot() {
        let r = reply("reset")
        #expect(r.expectsReboot)
        #expect(!r.expectsDrop)
    }

    @Test func anEditThatChangedNothingPromisesNothing() {
        // No `applying` means the board is not about to move, so a disconnect
        // after this one really is a fault and must keep saying so.
        let r = reply(nil)
        #expect(!r.expectsDrop)
        #expect(!r.expectsReboot)
    }

    @Test func theTwoPromisesAreNeverBothTrue() {
        // They arm different recoveries — re-dial the running board, or wait out
        // a boot — so a value that set both would pick one at random.
        for applying in ["reconnect", "reset", "", "rebooting", "somethingelse"] {
            let r = reply(applying)
            #expect(!(r.expectsDrop && r.expectsReboot), "both for \(applying)")
        }
    }

    @Test func aRefusalNeverPromisesADrop() {
        // The firmware answers refusals from the same interrupt with no
        // `applying` at all; a drop flag armed by a rejected edit would swallow
        // the next real failure.
        var r = TinyWifiReply(cmd: "join", ok: false, error: "unknown ssid")
        #expect(!r.expectsDrop)
        r.applying = nil
        #expect(!r.expectsDrop)
    }
}

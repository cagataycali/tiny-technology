import Foundation
import Testing
import CryptoKit
import XCTest
@testable import Tiny

@Suite struct PineappleTests {
    private let id = "01234567-89ab-4cde-8fab-0123456789ab"
    @Test func identifiesPlatformAndCapabilitiesNotName() {
        #expect(PineappleCore.matches(platform: "openwrt-mips", capabilities: ["pineapple_v1"]))
        #expect(PineappleCore.matches(platform: "openwrt-mips", capabilities: ["payload_inventory", "battery", "network"]))
        #expect(!PineappleCore.matches(platform: "darwin-arm64", capabilities: ["pineapple_v1"]))
        #expect(!PineappleCore.matches(platform: "openwrt-mips", capabilities: ["network"]))
    }
    @Test func doesNotInventAnOfflineReason() {
        #expect(PineappleCore.reason(nil) == nil)
        #expect(PineappleCore.reason("unknown") == nil)
        #expect(PineappleCore.reason("no_default_route")?.contains("reported") == true)
    }
    @Test func existingMVPOverviewIsUsableWithoutCaptureSupport() {
        let raw: [String: Any] = ["battery": ["capacity_percent": "55", "status": "Charging"],
            "network": ["interfaces": [["name": "wlan1mon", "state": "unknown"]]],
            "connectivity": ["reason": "no_default_route"]]
        let s = PineappleCore.Overview.decode(raw)
        #expect(s.battery == 55 && s.interfaces.count == 1)
        #expect(!s.captureAvailable && s.captureInterfaces.isEmpty)
        #expect(s.reason == "no_default_route")
        #expect(PineappleCore.Overview.decode([:]).battery == nil)
    }
    @Test func bssidRejectsBroadcastMulticastAndInjection() {
        #expect(PineappleCore.authorizedBSSID("02:00:00:00:00:01"))
        for bad in ["ff:ff:ff:ff:ff:ff", "01:00:00:00:00:01", "00:00:00:00:00:00", "x;id", "02:00:00:00:00:01\n", "02:00:00:00:00:01;id"] {
            #expect(!PineappleCore.authorizedBSSID(bad))
        }
    }
    @Test func rejectsPathNamesAndIncompleteMetadata() {
        #expect(PineappleCore.uuid(id))
        #expect(!PineappleCore.uuid(id + "\n"))
        #expect(!PineappleCore.uuid("../state/identity.json"))
        #expect(PineappleCore.Capture.decode(["job_id": "../../etc/shadow", "state": "complete"]) == nil)
        let partial = PineappleCore.Capture.decode(["job_id": id, "state": "running", "size": 24])
        #expect(partial?.downloadable == false)
        let oversized = PineappleCore.Capture.decode(["job_id": id, "state": "complete", "size": 262145, "sha256": String(repeating: "a", count: 64)])
        #expect(oversized?.downloadable == false)
    }
    private func scanRow(id: String = "02:00:00:00:00:01", ssid: String = "Demo", frequency: Int = 5765) -> [String: Any] {
        ["bssid": id, "ssid": ssid, "channel": 153, "frequency_mhz": frequency,
         "age_seconds": 0.1, "stale": false, "capture_interface": "wlan1mon",
         "radio_plan": ["phy": "phy1", "interface": "wlan1mon", "frequency_mhz": frequency,
            "width_mhz": 20, "tuning_required": true, "vendor_pause_required": true, "disrupts_uplink": false]]
    }
    private func scan(_ rows: [[String: Any]]) throws -> PineappleCore.NetworkScan {
        try PineappleCore.NetworkScan.decode(["version": 1, "source": "kernel_bss_cache", "fetched_at": 1000.0, "networks": rows])
    }
    @Test func nearbyNamesAreLiteralAndDuplicateSSIDsAreSeparate() throws {
        let hostile = "$(reboot) <script> **not markdown**"
        let result = try scan([scanRow(ssid: hostile), scanRow(id: "02:00:00:00:00:02", ssid: hostile), scanRow(id: "02:00:00:00:00:03", ssid: "")])
        #expect(result.networks.count == 3)
        #expect(result.networks[0].ssid == hostile && result.networks[1].ssid == hostile)
        #expect(result.networks[2].name == "Hidden network")
        #expect(PineappleCore.AccessPoint.decode(scanRow(ssid: "a\n\u{202E}b"))?.ssid == "a��b")
        #expect(PineappleCore.AccessPoint.decode(scanRow(id: "x;id")) == nil)
    }
    @Test func scannerFreshnessAgesAndDoesNotInventMissingAge() throws {
        let result = try scan([scanRow()]), ap = try #require(result.networks.first)
        #expect(result.isFresh(ap, now: Date(timeIntervalSince1970: 1029)))
        #expect(!result.isFresh(ap, now: Date(timeIntervalSince1970: 1031)))
        #expect(!result.isFresh(ap, now: Date(timeIntervalSince1970: 900)))
        var row = scanRow(); row.removeValue(forKey: "age_seconds")
        #expect(!result.isFresh(try #require(PineappleCore.AccessPoint.decode(row)), now: Date(timeIntervalSince1970: 1000)))
    }
    @Test func eligibilityRequiresExactFrequencyAndExistingBSSID() throws {
        let result = try scan([scanRow()]), now = Date(timeIntervalSince1970: 1001)
        let iface = PineappleCore.CaptureInterface(name: "wlan1mon", channel: 153, frequency: 5765, linkType: "Radiotap")
        #expect(result.reason(for: "02:00:00:00:00:01", interface: iface, now: now) == nil)
        #expect(result.reason(for: "02:00:00:00:00:02", interface: iface, now: now)?.contains("no longer") == true)
        #expect(result.reason(for: nil, interface: iface, now: now) != nil)
        let wrong = PineappleCore.CaptureInterface(name: "wlan1mon", channel: 153, frequency: 5995, linkType: "Radiotap")
        #expect(result.reason(for: "02:00:00:00:00:01", interface: wrong, now: now) == nil) // Current channel may differ; the advertised plan is authoritative.
        #expect(result.reason(for: "02:00:00:00:00:01", interface: iface, now: Date(timeIntervalSince1970: 1100)) != nil)
    }
    @Test func scannerRejectsMalformedOrOversizeAndDeduplicatesIdentity() throws {
        #expect(throws: Error.self) { try PineappleCore.NetworkScan.decode([:]) }
        #expect(throws: Error.self) { try scan(Array(repeating: scanRow(), count: 25)) }
        #expect(try scan([scanRow(), scanRow()]).networks.count == 1)
        #expect(try scan([]).networks.isEmpty)
    }
    @Test func rejectsMissingUnsafeOrMismatchedRadioPlans() throws {
        let iface = PineappleCore.CaptureInterface(name: "wlan1mon", channel: 6, frequency: 2437, linkType: "Radiotap")
        for mutation in ["missing", "shared", "uplink", "width", "frequency", "consent"] {
            var row = scanRow()
            var plan = row["radio_plan"] as! [String: Any]
            switch mutation {
            case "shared": plan["phy"] = "phy0"
            case "uplink": plan["disrupts_uplink"] = true
            case "width": plan["width_mhz"] = 80
            case "frequency": plan["frequency_mhz"] = 2437
            case "consent": plan["vendor_pause_required"] = false
            default: break
            }
            row["radio_plan"] = mutation == "missing" ? nil : plan
            #expect(try scan([row]).reason(for: "02:00:00:00:00:01", interface: iface, now: Date(timeIntervalSince1970: 1001)) != nil)
        }
    }
    @Test func offChannelRequestUsesSelectedPlanNotMonitorAndRequiresConsent() throws {
        let result = try scan([scanRow()])
        let iface = PineappleCore.CaptureInterface(name: "wlan1mon", channel: 6, frequency: 2437, linkType: "Radiotap")
        let now = Date(timeIntervalSince1970: 1001)
        let req = try PineappleCore.wirelessRequest(scan: result, bssid: "02:00:00:00:00:01", interface: iface,
            id: id, duration: 10, maxBytes: 65536, authorized: true, tuningConfirmed: true, now: now)
        #expect(req["frequency_mhz"] as? Int == 5765 && req["channel"] as? Int == 153)
        #expect(req["tuning_confirmed"] as? Bool == true && req["authorized"] as? Bool == true)
        for consent in [false, true] {
            #expect(throws: Error.self) { try PineappleCore.wirelessRequest(scan: result, bssid: "02:00:00:00:00:01", interface: iface,
                id: id, duration: 10, maxBytes: 65536, authorized: consent, tuningConfirmed: !consent, now: now) }
        }
        #expect(throws: Error.self) { try PineappleCore.wirelessRequest(scan: result, bssid: "02:00:00:00:00:01", interface: iface,
            id: id, duration: 10, maxBytes: 65536, authorized: true, tuningConfirmed: true, now: Date(timeIntervalSince1970: 1100)) }
    }
    @Test func radioPhasesBlockDownloadsAndExposeRecoveryFailure() throws {
        for phase in ["starting", "tuning", "running", "stopping", "restoring", "restore_failed"] {
            let capture = try #require(PineappleCore.Capture.decode(["job_id": id, "state": phase, "size": 104,
                "sha256": String(repeating: "a", count: 64), "reason": "Radio recovery required"]))
            #expect(capture.active && !capture.downloadable && !capture.phaseLabel.isEmpty)
            #expect(capture.reason == "Radio recovery required")
        }
        let overview = PineappleCore.Overview.decode(["capture": ["available": true, "radio_tuning_supported": false,
            "radio": ["phase": "restore_failed", "error": "Local inspection required"]]])
        #expect(!overview.tuningSupported && overview.radioError == "Local inspection required")
    }
    @Test func validatesChunkIdentityBoundsAndMagic() throws {
        let bytes = Data([0xd4,0xc3,0xb2,0xa1] + Array(repeating: UInt8(0), count: 20))
        let raw: [String: Any] = ["job_id": id, "offset": 0, "data_base64": bytes.base64EncodedString()]
        #expect(try PineappleCore.chunk(raw, job: id, offset: 0, size: 24) == bytes)
        #expect(throws: Error.self) { try PineappleCore.chunk(raw, job: "wrong", offset: 0, size: 24) }
        #expect(throws: Error.self) { try PineappleCore.chunk(raw, job: id, offset: 1, size: 24) }
        #expect(throws: Error.self) { try PineappleCore.chunk(raw, job: id, offset: 0, size: 23) }
        #expect(throws: Error.self) { try PineappleCore.chunk(["job_id": id, "offset": 0, "data_base64": "bm90IHBjYXA="], job: id, offset: 0, size: 24) }
    }
}

@Suite(.serialized) @MainActor struct PineappleDownloadTests {
    private let id = "01234567-89ab-4cde-8fab-0123456789ab"
    private var bytes: Data { Data([0xd4,0xc3,0xb2,0xa1] + Array(repeating: UInt8(0), count: 3196)) }
    private func metadata(hash: String? = nil) -> PineappleCore.Capture {
        PineappleCore.Capture(id: id, state: "complete", size: bytes.count,
            sha256: hash ?? SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), linkType: "Synthetic test")
    }
    private func folders() -> Set<URL> {
        Set(((try? FileManager.default.contentsOfDirectory(at: FileManager.default.temporaryDirectory,
            includingPropertiesForKeys: nil)) ?? []).filter { $0.lastPathComponent.hasPrefix("Pineapple-") })
    }
    private func read(_ request: [String: Any]) throws -> [String: Any] {
        #expect(request["export_confirmed"] as? Bool == true)
        let offset = try #require(request["offset"] as? Int)
        let length = try #require(request["length"] as? Int)
        return ["job_id": id, "offset": offset, "data_base64": bytes.subdata(in: offset..<(offset + length)).base64EncodedString()]
    }
    @Test func multipleChunksHashProgressAndProtectedFile() async throws {
        var offsets: [Int] = []; var progress: [Double] = []
        let url = try await PineappleClient.download(metadata(), read: { req in
            offsets.append(req["offset"] as! Int); return try read(req)
        }, progress: { progress.append($0) })
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        #expect(try Data(contentsOf: url) == bytes)
        #expect(offsets == [0, 3072] && progress.last == 1)
        #expect(url.pathExtension == "pcap")
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #if !targetEnvironment(simulator)
        #expect(attrs[.protectionKey] as? FileProtectionType == .complete)
        #endif
    }
    @Test func wrongHashRemovesPartial() async throws {
        let before = folders()
        do {
            _ = try await PineappleClient.download(metadata(hash: String(repeating: "0", count: 64)), read: read, progress: { _ in })
            Issue.record("Wrong hash was accepted")
        } catch { #expect(error.localizedDescription.contains("hash")) }
        #expect(folders() == before)
    }
    @Test func malformedAndShortRepliesRemovePartial() async throws {
        for mode in ["wrong-id", "short", "empty"] {
            let before = folders()
            do {
                _ = try await PineappleClient.download(metadata(), read: { req in
                    var reply = try read(req)
                    if mode == "wrong-id" { reply["job_id"] = "wrong" }
                    else { reply["data_base64"] = (mode == "empty" ? Data() : bytes.prefix(24)).base64EncodedString() }
                    return reply
                }, progress: { _ in })
                Issue.record("Malformed chunk accepted")
            } catch { }
            #expect(folders() == before)
        }
    }
    @Test func cancellationAfterAwaitDoesNotLeaveAFile() async throws {
        let before = folders()
        let task = Task {
            try await PineappleClient.download(metadata(), read: { req in
                try await Task.sleep(for: .seconds(5)); return try read(req)
            }, progress: { _ in })
        }
        try await Task.sleep(for: .milliseconds(30)); task.cancel()
        do { _ = try await task.value; Issue.record("Cancelled download succeeded") }
        catch is CancellationError { }
        #expect(folders() == before)
    }
}

/// Opt-in live test. Host stages a mode0600 fixture in the app's temporary folder;
/// never check it in or print its contents. Only reads the known synthetic job.
@MainActor final class PineappleLiveTests: XCTestCase {
    func testOwnerRelayDownloadSyntheticFixture() async throws {
        let config = FileManager.default.temporaryDirectory.appendingPathComponent("pineapple-live-test.json")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: config.path), "No private live-test fixture staged")
        defer { try? FileManager.default.removeItem(at: config) }
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: config)) as? [String: String])
        let device = try XCTUnwrap(raw["device"]), token = try XCTUnwrap(raw["token"]), job = try XCTUnwrap(raw["job"])
        let discovery = try await PineappleClient.invoke(device: device, token: token, prompt: "network_scan")
        let scan = try PineappleCore.NetworkScan.decode(discovery)
        XCTAssertLessThanOrEqual(scan.networks.count, 24)
        XCTAssertLessThan(abs(scan.fetchedAt.timeIntervalSinceNow), 90)
        print("PINEAPPLE_LIVE: real Swift client discovery decode PASS; count=\(scan.networks.count), no AP identifiers logged")
        let overview = PineappleCore.Overview.decode(try await PineappleClient.invoke(device: device, token: token, prompt: "overview"))
        XCTAssertTrue(overview.tuningSupported)
        let planned = scan.networks.filter { $0.captureInterface != nil && !$0.stale }
        for ap in planned {
            XCTAssertEqual(ap.radioPlan?.frequency, ap.frequency)
        }
        print("PINEAPPLE_LIVE: safe tuning plans decoded count=\(planned.count); no capture Start sent")
        let response = try await PineappleClient.command(device: device, token: token, request: ["action": "capture_list"])
        let list = try XCTUnwrap(response["files"] as? [[String: Any]])
        let capture = try XCTUnwrap(list.compactMap(PineappleCore.Capture.decode).first { $0.id == job })
        XCTAssertEqual(capture.linkType, "Ethernet (synthetic loopback)")
        XCTAssertEqual(capture.size, 104)
        let url = try await PineappleClient.download(capture, device: device, token: token, progress: { _ in })
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let data = try Data(contentsOf: url)
        XCTAssertNotNil(data.range(of: Data("TINY-pineapple-fixture".utf8)))
        XCTAssertEqual(data.count, capture.size)
        print("PINEAPPLE_LIVE: real Swift client owner relay, 104-byte synthetic PCAP/hash PASS")
    }
}

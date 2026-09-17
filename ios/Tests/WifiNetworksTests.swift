/**
 * 📶 WifiNetworks — the saved WiFi list, and the payload written to a necklace.
 *
 * The user's report was "i'm unable to set this in the nicla voice and nicla
 * vision": the board held ONE ssid/key pair, so it was pinned to the network it
 * was provisioned on and a phone hotspot could not be put on it at all. The list
 * is the fix, and its failure modes are all quiet ones — a list saved in an order
 * the board doesn't sweep, a duplicate that looks like a second network, a
 * trailing space that reads as a wrong password, or a tail trimmed to fit a
 * buffer without anyone being told. None of those crash; each one just leaves a
 * board that won't come up on a network the owner is certain they typed in.
 */
import Foundation
import Testing
@testable import Tiny

@Suite struct WifiNetworksTests {

    private let home = WifiNetwork(ssid: "Home_WiFi", password: "homepass")
    private let hotspot = WifiNetwork(ssid: "owner-phone", password: "hotspot-pass")

    // Same widths the worker mints: crypto.randomUUID() and tind_ + base64url(32).
    private var identity: [String: String] {
        ["device_id": String(repeating: "x", count: 36),
         "token": String(repeating: "x", count: 48),
         "name": "tiny-a1b2"]
    }

    private func obj(_ data: Data) -> [String: Any] {
        #expect(data.last == 0x0A, "the firmware frames on a newline")
        let body = data.dropLast()
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
    }

    // ── the list itself ───────────────────────────────────────────────────

    @Test func theOrderSavedIsTheOrderSwept() {
        let out = WifiNetworks.clean([hotspot, home])
        #expect(out.map(\.ssid) == ["owner-phone", "Home_WiFi"])
    }

    @Test func aRepeatedNameIsOneNetworkNotTwo() {
        // Keeping the FIRST is what tiny_config._clean does; keeping the last
        // would move the entry and change which network the board prefers.
        let out = WifiNetworks.clean([hotspot, home, WifiNetwork(ssid: "owner-phone", password: "other")])
        #expect(out.map(\.ssid) == ["owner-phone", "Home_WiFi"])
        #expect(out.first?.password == "hotspot-pass")
    }

    @Test func aBlankRowIsDroppedWithoutCostingTheList() {
        let out = WifiNetworks.clean([WifiNetwork(ssid: "   ", password: "x"), home])
        #expect(out.map(\.ssid) == ["Home_WiFi"])
    }

    @Test func aTypedTrailingSpaceIsNotPartOfTheName() {
        // The board compares byte for byte and answers "no association in 20s",
        // which is also what a wrong password looks like.
        let out = WifiNetworks.clean([WifiNetwork(ssid: " owner-phone ", password: "p")])
        #expect(out.map(\.ssid) == ["owner-phone"])
    }

    @Test func addingASavedNameUpdatesItInPlace() {
        let list = WifiNetworks.upsert(WifiNetwork(ssid: "owner-phone", password: "new"),
                                      into: [hotspot, home])
        #expect(list.map(\.ssid) == ["owner-phone", "Home_WiFi"], "position is a preference — it must not move")
        #expect(list.first?.password == "new")
    }

    @Test func aNewNameGoesLastSoItCannotDemoteTheWorkingOne() {
        let list = WifiNetworks.upsert(hotspot, into: [home])
        #expect(list.map(\.ssid) == ["Home_WiFi", "owner-phone"])
    }

    @Test func addingNothingChangesNothing() {
        let list = WifiNetworks.upsert(WifiNetwork(ssid: "", password: "p"), into: [home])
        #expect(list.map(\.ssid) == ["Home_WiFi"])
    }

    // ── the payload ───────────────────────────────────────────────────────

    @Test func thePayloadCarriesTheWholeListInOrder() {
        let body = obj(WifiNetworks.encoded(identity: identity, networks: [hotspot, home]))
        let nets = body["networks"] as? [[String: String]]
        #expect(nets?.map { $0["ssid"] ?? "" } == ["owner-phone", "Home_WiFi"])
        // `key`, not `password` — that is the firmware's name for it.
        #expect(nets?.first?["key"] == "hotspot-pass")
    }

    @Test func theFirstEntryAlsoGoesOutAsThePairAnOlderBoardUnderstands() {
        let body = obj(WifiNetworks.encoded(identity: identity, networks: [hotspot, home]))
        #expect(body["ssid"] as? String == "owner-phone")
        #expect(body["key"] as? String == "hotspot-pass")
    }

    @Test func aBoardWithNoRadioIsSentNoCredentialsAtAll() {
        // The Voice branch passes no networks. If a WiFi key showed up here it
        // would be collected for a radio that does not exist, and its 256-byte
        // buffer would refuse the payload after it crossed the air.
        let body = obj(WifiNetworks.encoded(identity: identity, networks: []))
        #expect(body["networks"] == nil)
        #expect(body["ssid"] == nil)
        #expect(body["key"] == nil)
        #expect(body["device_id"] as? String != nil, "identity still goes out")
    }

    @Test func junkInTheListNeverReachesTheWire() {
        let body = obj(WifiNetworks.encoded(identity: identity,
                                            networks: [WifiNetwork(ssid: "", password: "p"), home]))
        let nets = body["networks"] as? [[String: String]]
        #expect(nets?.count == 1)
        #expect(body["ssid"] as? String == "Home_WiFi", "the pair follows the cleaned list, not the raw one")
    }

    // ── fitting the board's buffer ────────────────────────────────────────

    @Test func aListThatFitsIsSentWhole() {
        let out = WifiNetworks.fit([hotspot, home], identity: identity, budget: 900)
        #expect(out.sent.map(\.ssid) == ["owner-phone", "Home_WiFi"])
        #expect(out.dropped.isEmpty)
    }

    @Test func whatIsDroppedIsTheTailAndItIsReported() {
        let many = (0..<40).map { WifiNetwork(ssid: "net-\($0)", password: "password-\($0)") }
        let out = WifiNetworks.fit(many, identity: identity, budget: 900)
        #expect(!out.sent.isEmpty, "a 900-byte board holds several networks")
        #expect(!out.dropped.isEmpty, "40 networks cannot fit in 900 bytes")
        // Nothing is lost between the two halves, and preference order decides.
        #expect(out.sent.map(\.ssid) + out.dropped.map(\.ssid) == many.map(\.ssid))
    }

    @Test func whatIsSentAlwaysActuallyFits() {
        let many = (0..<40).map { WifiNetwork(ssid: "net-\($0)", password: "password-\($0)") }
        for budget in [200, 300, 500, 900] {
            let out = WifiNetworks.fit(many, identity: identity, budget: budget)
            let size = WifiNetworks.encoded(identity: identity, networks: out.sent).count
            if !out.sent.isEmpty {
                #expect(size <= budget, "fit(\(budget)) promised \(out.sent.count) networks in \(size) bytes")
            }
        }
    }

    @Test func aBudgetTooSmallForEvenTheIdentityDropsEverything() {
        // Better than looping forever, and the sheet then names every network.
        let out = WifiNetworks.fit([hotspot, home], identity: identity, budget: 10)
        #expect(out.sent.isEmpty)
        #expect(out.dropped.count == 2)
    }

    // ── persistence ───────────────────────────────────────────────────────

    @Test func theListSurvivesARoundTripThroughStorage() {
        let saved = WifiStore.encode([hotspot, home])
        #expect(WifiStore.decode(saved) == [hotspot, home])
    }

    @Test func nothingStoredIsAnEmptyListNotACrash() {
        #expect(WifiStore.decode(nil).isEmpty)
        #expect(WifiStore.decode("not json at all").isEmpty)
        #expect(WifiStore.decode("{}").isEmpty)
    }

    @Test func storedJunkIsCleanedOnTheWayBackIn() {
        // The slot is a string; a half-written or hand-edited one should not put
        // a duplicate or a blank name in front of a real network.
        let raw = #"[{"ssid":"","password":"x"},{"ssid":"owner-phone","password":"a"},{"ssid":"owner-phone","password":"b"}]"#
        #expect(WifiStore.decode(raw) == [WifiNetwork(ssid: "owner-phone", password: "a")])
    }
}

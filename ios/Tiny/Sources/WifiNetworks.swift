/**
 * WifiNetworks — the phone's saved WiFi list, and the rule for writing it to a board.
 *
 * A Nicla Vision used to be born onto ONE network: `/flash/tiny.json` held a
 * single `ssid`/`key` pair, so the necklace could only ever join the network it
 * was provisioned on, and a phone hotspot could not be put on it at all. The
 * firmware now keeps `networks: [{ssid,key},…]` in preference order and sweeps
 * it on boot — 20s PER network, not a shared budget (strands-nicla
 * `firmware/tiny_config.py`, `tiny_node.wifi_connect`). This is the phone's
 * half: the list the owner keeps, and the one place that turns it into a
 * provisioning payload.
 *
 * Order IS the meaning — entry 0 is what the board tries first — so this is a
 * sequence the owner drags, never a set.
 *
 * A Nicla **Voice** gets none of it: nRF52832, BLE only, no WiFi radio at all.
 * Its config buffer is 256 bytes too (`TV_CFG_MAX` in tiny_voice.ino), so a list
 * it could never use is also how identity provisioning starts answering
 * `{"ok":false,"error":"too long"}`. `encoded` writes WiFi keys only when it is
 * given networks, and the setup sheet gives it none for a Voice.
 *
 * The rules are nonisolated statics so TinyTests can pin them without a
 * MainActor hop; only the store that persists them is main-actor bound.
 */
import Foundation
// SwiftUI, not just Combine: `remove(atOffsets:)` / `move(fromOffsets:toOffset:)`
// — the two operations a dragged, swipe-to-delete list needs — are declared there.
import SwiftUI

struct WifiNetwork: Codable, Equatable, Identifiable, Sendable {
    var ssid: String
    var password: String

    /// The SSID is the identity here and on the board — `tiny_config` de-dupes by
    /// name as well, so two rows with one name could never mean two networks.
    var id: String { ssid }
}

enum WifiNetworks {

    /// Valid, de-duplicated entries in preference order — the phone-side twin of
    /// `tiny_config._clean`, keeping the FIRST occurrence of a name like it does.
    ///
    /// The SSID is trimmed because the board compares it byte for byte: a name
    /// with a keyboard's trailing space produces "no association in 20s" and
    /// nothing else, which looks exactly like a wrong password or an absent
    /// router. A blank entry is dropped rather than refused — this also runs over
    /// whatever was last persisted, and one bad row should not cost the list.
    static func clean(_ raw: [WifiNetwork]) -> [WifiNetwork] {
        var out: [WifiNetwork] = []
        for net in raw {
            let ssid = net.ssid.trimmingCharacters(in: .whitespaces)
            if ssid.isEmpty { continue }
            if out.contains(where: { $0.ssid == ssid }) { continue }
            out.append(WifiNetwork(ssid: ssid, password: net.password))
        }
        return out
    }

    /// Adding a name the list already holds UPDATES that entry's password and
    /// keeps its position. A new name goes to the END: the order is a preference,
    /// so inserting at the front would silently demote the network the board is
    /// currently joining. (The board's own AP portal does insert at the front —
    /// it reboots on save and has no way to reorder. This sheet has drag.)
    static func upsert(_ net: WifiNetwork, into list: [WifiNetwork]) -> [WifiNetwork] {
        guard let one = clean([net]).first else { return list }
        var out = clean(list)
        if let i = out.firstIndex(where: { $0.ssid == one.ssid }) {
            out[i] = one
            return out
        }
        out.append(one)
        return out
    }

    /// The wire form of the list: the firmware reads `key`, not `password`.
    static func wire(_ nets: [WifiNetwork]) -> [[String: String]] {
        clean(nets).map { ["ssid": $0.ssid, "key": $0.password] }
    }

    /// One provisioning payload, newline-terminated (the firmware's frame
    /// terminator). ONE owner: `fit` measures what this produces and
    /// `TinyProvisioner.send` transmits it, so the size the sheet promises and
    /// the size that crosses the air cannot drift apart.
    ///
    /// The first entry also goes out as a top-level `ssid`/`key` pair. A board on
    /// firmware older than the list filters `networks` out through its
    /// ALLOWED_KEYS and would otherwise be provisioned with no network at all;
    /// `tiny_config.merge` prefers `networks` whenever both are present, so a
    /// current board never reads the pair at all.
    static func encoded(identity: [String: String], networks: [WifiNetwork]) -> Data {
        var obj: [String: Any] = identity
        let nets = clean(networks)
        if let first = nets.first {
            obj["networks"] = wire(nets)
            obj["ssid"] = first.ssid
            obj["key"] = first.password
        }
        var json = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
        json.append(0x0A)
        return json
    }

    /// As many networks as the board's config buffer can hold, plus the ones that
    /// did not fit.
    ///
    /// Dropping happens from the END — the least-preferred entries — and the
    /// caller is expected to NAME them. A silent trim reads as "all of them were
    /// saved", and the board would then never know about a network the owner
    /// watched themselves type in.
    static func fit(_ nets: [WifiNetwork],
                    identity: [String: String],
                    budget: Int) -> (sent: [WifiNetwork], dropped: [WifiNetwork]) {
        let all = clean(nets)
        var keep = all
        while !keep.isEmpty, encoded(identity: identity, networks: keep).count > budget {
            keep.removeLast()
        }
        return (keep, Array(all.dropFirst(keep.count)))
    }
}

/// The saved list, persisted between setups.
///
/// Keychain, not `@AppStorage`: these are WiFi passwords, and the account token
/// next to them already sets the precedent (`Keychain.swift`). That wrapper is
/// ThisDeviceOnly, so a backup restored onto a new phone does not carry the
/// owner's home network — and the boards are re-provisioned from the app anyway.
@MainActor
final class WifiStore: ObservableObject {
    static let shared = WifiStore()

    private static let slot = "wifi_networks"

    @Published private(set) var networks: [WifiNetwork] = []

    init() {
        networks = Self.decode(Keychain.get(Self.slot))
    }

    nonisolated static func decode(_ raw: String?) -> [WifiNetwork] {
        guard let raw, let data = raw.data(using: .utf8),
              let list = try? JSONDecoder().decode([WifiNetwork].self, from: data)
        else { return [] }
        return WifiNetworks.clean(list)
    }

    nonisolated static func encode(_ nets: [WifiNetwork]) -> String {
        guard let data = try? JSONEncoder().encode(WifiNetworks.clean(nets)),
              let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    func add(ssid: String, password: String) {
        commit(WifiNetworks.upsert(WifiNetwork(ssid: ssid, password: password), into: networks))
    }

    func forget(ssid: String) {
        commit(networks.filter { $0.ssid != ssid })
    }

    func remove(at offsets: IndexSet) {
        var next = networks
        next.remove(atOffsets: offsets)
        commit(next)
    }

    func move(from source: IndexSet, to destination: Int) {
        var next = networks
        next.move(fromOffsets: source, toOffset: destination)
        commit(next)
    }

    private func commit(_ nets: [WifiNetwork]) {
        networks = WifiNetworks.clean(nets)
        Keychain.set(Self.slot, Self.encode(networks))
    }
}

/**
 * ⛓️ CHAIN STATUS (iOS) — the PURE half of the native chain explorer.
 *
 * The user's gap, verbatim: "we dont see the chain details in the mobile apps."
 * The web has `/chain` — a server-rendered page showing which chain this
 * deployment runs, whether the node agrees, the latest block, the TinyUSDC
 * contract, and recent transfers. On phone there was nothing: `Explorer.swift`
 * only decides what to CALL an explorer a receipt links to. So a user paying with
 * tiny on our own chain had no way to see the chain their money moves on.
 *
 * WHY THERE'S NO JSON-RPC HERE. The obvious build is `eth_getLogs` from the
 * device — the public proxy allows it. That would make iOS the fourth
 * implementation of Transfer-log decoding and the uint256 clamp, each free to
 * drift. `GET /api/chain/status` decodes once on the server and sends flat,
 * already-formatted values; this file only reads them out of a dictionary.
 *
 * The decisions that live here, and why each is a decision rather than a default:
 *
 *  • THREE UNRELATED FAILURES MUST READ DIFFERENTLY. "This deployment has no
 *    chain" (Base — correct, permanent), "the node didn't answer" (transient),
 *    and "the node says it's a different chain" (misconfiguration) are the same
 *    empty screen if you only check for data. `ChainStatus.Health` keeps them
 *    apart, because the sentence a user needs differs in every case, and one of
 *    them means the numbers on screen belong to a DIFFERENT chain.
 *
 *  • MONEY IS NEVER RE-FORMATTED. The server sends `amount` as a display string.
 *    Parsing `amountMicro` and formatting it here would reintroduce the Double
 *    problem the server already solved: JSONSerialization turns a value past 2^53
 *    into a lossy Double, so a clamped transfer would print a confident wrong
 *    number on exactly the transfer someone is auditing. We render the string and
 *    only read the number to sanity-check it.
 *
 *  • A MISSING FIELD IS NOT A ZERO. `latestBlock` absent means "we don't know";
 *    rendering it as block 0 claims a genesis-height chain. Optionals, not `?? 0`.
 *
 * PURE (no SwiftUI, no URLSession) so every branch is asserted in
 * ChainStatusTests rather than eyeballed on a device.
 */
import Foundation

enum ChainStatusModel {

    /// One TinyUSDC movement, ready to render — no client-side decoding.
    struct Transfer: Identifiable, Equatable {
        let hash: String
        let hashShort: String
        let from: String
        let fromShort: String
        let to: String
        let toShort: String
        let blockNumber: Int?
        /// The display string from the server ("$1.50", "—", "> $9e9 (clamped)").
        let amount: String
        /// True when the on-chain value exceeded what JSON can carry losslessly.
        let clamped: Bool
        /// mint | burn | transfer — the server names it so we don't compare to 0x0.
        let kind: String
        var id: String { "\(hash):\(fromShort)->\(toShort):\(amount)" }

        /// Content emoji (TinyDesign: emoji belong to content, not chrome).
        var kindLabel: String {
            switch kind {
            case "mint": return "🌱 Issued"
            case "burn": return "🔥 Burned"
            default: return "↔️ Transfer"
            }
        }
    }

    /**
     * What the screen must SAY, which is not the same as what it has.
     *
     * Ordered by what a user can act on: a mismatch outranks unreachability
     * because a mismatch means the visible numbers may belong to another chain,
     * and that's worse than having no numbers.
     */
    enum Health: Equatable {
        /// This deployment settles on Base — there is no tiny chain to show.
        case notConfigured
        /// Configured, and the node's `eth_chainId` contradicts our config.
        case mismatch(configured: Int, reported: Int)
        /// Configured, but the node didn't answer.
        case unreachable
        case ok
    }

    struct Status: Equatable {
        var health: Health = .notConfigured
        var chainId: Int?
        var caip2: String?
        var usdc: String?
        var latestBlock: Int?
        var moneyNote: String = ""
        var transfers: [Transfer] = []
        var span: Int?

        /// Whether to show the activity list at all (vs. an explanatory state).
        var showsActivity: Bool {
            switch health {
            case .ok, .mismatch: return true
            case .notConfigured, .unreachable: return false
            }
        }
    }

    /**
     * Parse `GET /api/chain/status`. `nil` body (transport failure) is NOT the
     * same as an unconfigured chain — a dropped request must not tell a user on
     * our own chain that this deployment doesn't have one. Returns nil so the
     * caller can retry / show a network error.
     */
    static func parse(_ body: [String: Any]?) -> Status? {
        guard let body else { return nil }
        // An HTTP error body (the route's own 500 shape, or a proxy's HTML-ish
        // JSON) has no `configured` key at all. Treating a missing key as `false`
        // would render "this deployment has no chain" on a 502 — a confident claim
        // built from an error page.
        guard let configured = truthy(body["configured"]) else { return nil }

        var s = Status()
        s.moneyNote = body["moneyNote"] as? String ?? ""
        s.span = int(body["span"])

        guard configured else {
            s.health = .notConfigured
            return s
        }

        s.chainId = int(body["chainId"])
        s.caip2 = body["caip2"] as? String
        s.usdc = (body["usdc"] as? String)?.lowercased()
        s.latestBlock = int(body["latestBlock"])

        let identity = body["identity"] as? String
        let reported = int(body["reportedChainId"])
        // Mismatch first, and it requires BOTH numbers: a "mismatch" with no
        // reported id can't be explained to the user ("this chain disagrees with
        // itself"), so it degrades to unreachable — which is at least true, since
        // we evidently didn't get a usable answer.
        if identity == "mismatch", let configuredId = s.chainId, let reported {
            s.health = .mismatch(configured: configuredId, reported: reported)
        } else if s.latestBlock == nil || truthy(body["reachable"]) == false {
            // Either signal alone is enough: `reachable` is the server's summary,
            // a null height is the raw evidence. Trusting only the summary would
            // hide a future bug in it; trusting only the height would ignore a
            // server that knows more than we do.
            s.health = .unreachable
        } else {
            s.health = .ok
        }

        s.transfers = (body["transfers"] as? [[String: Any]] ?? []).compactMap(transfer)
        return s
    }

    private static func transfer(_ raw: [String: Any]) -> Transfer? {
        // A row with no hash can't be tapped through to the explorer and can't be
        // deduped; a row with no amount string has nothing to show. Dropping it
        // beats rendering a blank line that looks like a transfer of nothing.
        guard let hash = raw["hash"] as? String, !hash.isEmpty,
              let amount = raw["amount"] as? String, !amount.isEmpty else { return nil }
        return Transfer(
            hash: hash,
            hashShort: raw["hashShort"] as? String ?? shorten(hash),
            from: raw["from"] as? String ?? "",
            fromShort: raw["fromShort"] as? String ?? shorten(raw["from"] as? String ?? ""),
            to: raw["to"] as? String ?? "",
            toShort: raw["toShort"] as? String ?? shorten(raw["to"] as? String ?? ""),
            blockNumber: int(raw["blockNumber"]),
            amount: amount,
            clamped: truthy(raw["clamped"]) ?? false,
            kind: raw["kind"] as? String ?? "transfer")
    }

    /// 0xabcd…1234 — only a fallback; the server sends these pre-shortened.
    static func shorten(_ s: String, head: Int = 6, tail: Int = 4) -> String {
        guard s.count > head + tail + 2 else { return s }
        return "\(s.prefix(head + 2))…\(s.suffix(tail))"
    }

    /**
     * Int from a JSON number, or nil.
     *
     * ⚠️ Deliberately does NOT accept a numeric string, and deliberately returns
     * nil rather than 0: `latestBlock: null` means "we couldn't ask", and a `?? 0`
     * here would render that as a chain sitting at genesis — a specific, wrong,
     * plausible-looking claim. A Bool is rejected too, because `NSNumber` bridges
     * `true` to 1 and "latest block: 1" is a real-looking height.
     */
    static func int(_ value: Any?) -> Int? {
        if value is Bool { return nil }
        guard let n = value as? NSNumber else { return nil }
        // JSONSerialization hands back __NSCFBoolean as an NSNumber, so the `is
        // Bool` check above catches it before this point.
        let d = n.doubleValue
        guard d.isFinite, d >= Double(Int.min), d <= Double(Int.max) else { return nil }
        return n.intValue
    }

    /// Tri-state truthiness: nil means the key was absent or unusable, which is
    /// what lets `parse` tell an error body apart from `configured: false`.
    static func truthy(_ value: Any?) -> Bool? {
        if let b = value as? Bool { return b }
        if let n = value as? NSNumber { return n.boolValue }
        return nil
    }

    /// The headline under the chain name, per health state.
    static func headline(_ s: Status) -> String {
        switch s.health {
        case .notConfigured:
            return "This deployment settles payments on Base, not on a tiny chain."
        case .mismatch(let configured, let reported):
            // Name both numbers and claim neither. Whichever is right, the
            // deployment is misconfigured and only its operator can say which.
            return "⚠️ Configured as chain \(configured), but the node reports \(reported). "
                + "The details below may belong to a different chain."
        case .unreachable:
            return "Can't reach the chain right now. This is a connection problem, not an empty chain."
        case .ok:
            return "Every tiny payment settles here, on a chain anyone can run."
        }
    }
}

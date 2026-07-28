/**
 * 💧 TOP-UP PRESENTATION (iOS) — what to offer a user with no money, and what to
 * call the chain their money lives on.
 *
 * The third and last client of the self-hosted chain's copy work (web:
 * `lib/x402/top-up.ts`, Android: `WalletCore.kt`'s top-up block), ported
 * function-for-function so the three can't drift. iOS still renders
 * Coinbase + bridge.base.org on mainnet and faucet.circle.com on Sepolia — three
 * REAL-MONEY rails that are actively misleading on a chain we own. Nobody sells
 * TinyUSDC, and faucet.circle.com hands out SEPOLIA USDC, so a user who follows
 * any of them spends real money (or real time) and arrives holding a token this
 * deployment cannot credit. A stale on-ramp on our own chain isn't a dead link,
 * it's a trap. The in-house faucet (`POST /api/wallet/faucet`) is the only
 * source, and the server already says whether it exists
 * (`deposit_info.faucet.available`).
 *
 * PURE — no SwiftUI, no URLSession, no UIKit — because what's interesting here is
 * PRODUCT JUDGEMENT, not markup: which of three mutually-exclusive routes a
 * deployment offers, and how a refusal is phrased. Both look right in review and
 * are wrong in front of a user; you find out when someone is staring at a button
 * that 424s, or at "try again later" when the true answer is "you've had all of
 * it". So they get asserted (TopUpTests) instead of eyeballed.
 *
 * The one thing iOS has to decide for itself is PARSING. Every figure here
 * arrives as an `Any?` out of JSONSerialization, where a worker float is an
 * NSNumber and `Int(someDouble)` TRAPS on infinity/NaN/over-Int.max — a crash,
 * not a wrong number, on the money surface. See `micro(_:)`.
 */
import Foundation

enum TopUp {

    // MARK: - networks

    /// The three networks the payments stack settles on (worker `PayNetwork`).
    enum PayNetwork: String, CaseIterable {
        case base
        case baseSepolia = "base-sepolia"
        case tiny
    }

    /// Coerce an unknown network string, defaulting to the SAFEST reading (real
    /// Base): a client that guessed "trial" for an unknown name would label real,
    /// withdrawable money as un-withdrawable trial credit.
    static func asNetwork(_ raw: String?) -> PayNetwork {
        let n = (raw ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return PayNetwork(rawValue: n) ?? .base
    }

    /**
     * Label for a network, in the user's terms. `trial` is the load-bearing word:
     * both `tiny` and `base-sepolia` credit balance that is spendable inside tiny
     * but NOT withdrawable as real money, and a user who doesn't know that before
     * they earn on it will feel defrauded when the withdrawal is refused.
     */
    static func networkLabel(_ n: PayNetwork) -> String {
        switch n {
        case .tiny: return "Tiny Chain (trial credit)"
        case .baseSepolia: return "Base Sepolia (trial credit)"
        case .base: return "Base (real USDC)"
        }
    }

    /// Conservative display mapper for a quote/receipt `network` field: EXACT
    /// known names get the money-kind label ("Tiny Chain (trial credit)"),
    /// anything else renders verbatim — deliberately NOT through asNetwork(),
    /// whose default-to-base would label an unknown chain "real USDC", the one
    /// direction an approval card must never err.
    static func payNetworkDisplay(_ raw: String?) -> String? {
        guard let n = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty else { return nil }
        guard let known = PayNetwork(rawValue: n) else { return n }
        return networkLabel(known)
    }

    /// Short form for a tight picker segment or a confirm dialog.
    static func networkShort(_ n: PayNetwork) -> String {
        switch n {
        case .tiny: return "Tiny Chain"
        case .baseSepolia: return "Sepolia"
        case .base: return "Base"
        }
    }

    /// True when balance earned on this network can leave as real money.
    static func isRealMoney(_ n: PayNetwork) -> Bool { n == .base }

    /**
     * Which networks a picker should show: only ever the deployment's OWN network
     * plus real Base, never all three.
     *
     * A deployment configures ONE chain, and offering the other trial network lets
     * a user paste a tx hash the receipt scanner can't see — the permanent "no
     * matching USDC transfer" 400 this repo already fixed once by seeding the
     * selector. Base stays listed on a trial deployment because a real deposit is
     * still the documented way to get withdrawable balance.
     *
     * iOS's pickers were a HARDCODED base/base-sepolia pair, so on a tiny-chain
     * deployment the user's own network wasn't offerable at all: every claim and
     * withdrawal was aimed at a chain their money isn't on.
     */
    static func networkChoices(_ defaultNetwork: String?) -> [PayNetwork] {
        let n = asNetwork(defaultNetwork)
        return n == .base ? [.base] : [n, .base]
    }

    // MARK: - money out of JSON

    /**
     * A micro-USDC figure from a JSON body, clamped so it can never trap.
     *
     * `Int(someDouble)` is a TRAP in Swift for infinity/NaN/over-`Int.max` — it
     * crashes rather than wrapping — and these numbers arrive from a worker as
     * JSON floats, where `1e999` decodes to `Double.infinity`. Same guard as
     * `Wallet.swift:207`, `loadPrice()` and `ChatStreamDecoder.safeMicro`;
     * deliberately a second copy rather than a shared call, because those two live
     * in targets this file isn't in (the watch app and the widget extension
     * compile ChatStreamDecoder, not the wallet) and a five-line trap-guard is
     * cheaper to duplicate than a cross-target dependency.
     *
     * Negative → 0: every field here is a non-negative allowance, and a negative
     * remaining that reached `min()` would enable a button the server refuses.
     */
    static func micro(_ value: Any?) -> Int {
        guard let n = value as? NSNumber else { return 0 }
        let d = n.doubleValue
        guard !d.isNaN else { return 0 }
        if d <= 0 { return 0 }
        return d >= Double(Int.max) ? Int.max : Int(d)
    }

    /**
     * micro-USDC → "$1.2" for a BUTTON. No min-2 padding, so a whole dollar reads
     * "$1" rather than "$1.00", and up to 6dp for the odd MIN-clamped drip. Web's
     * `usdShort` / Android's `priceLabel`.
     *
     * Locale-pinned: `String(format:)` uses the C locale for `%f`, which is what we
     * want here (a de_DE phone must not render the button as "$1,2" while the
     * server, the web app and Android all say "$1.2").
     */
    static func usdShort(_ micro: Int) -> String {
        var s = String(format: "%.6f", Double(micro) / 1_000_000)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return "$\(s.isEmpty ? "0" : s)"
    }

    /// Human "2h 5m" until the next drip. Empty when it isn't in the future, so
    /// the caller can fall back to "after midnight UTC" rather than print "in 0m".
    static func untilNextDrip(_ seconds: Int) -> String {
        guard seconds > 0 else { return "" }
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        if h > 0 && m > 0 { return "\(h)h \(m)m" }
        if h > 0 { return "\(h)h" }
        // A sub-minute wait rounds UP: "in 0m" reads as a bug, and the drip really
        // is imminent.
        return "\(max(1, m))m"
    }

    // MARK: - the faucet block

    /// `deposit_info.faucet` (worker `PayDepositInfoCall`) — absent ⟺ no faucet.
    struct FaucetInfo: Equatable {
        var available = false
        var network: String?
        var dripMicro = 0
        var capMicro = 0
        var grantedMicro = 0
        var remainingMicro = 0
        var claimedToday = false
        var nextDripInSeconds = 0
        var reputation = 0
        var microPerPoint = 0
        var maxMicro = 0
    }

    /**
     * Parse the faucet block. A missing object is `nil` (no faucet); an
     * `{available:false}` parses to `available == false` rather than nil, so the
     * two server answers stay distinguishable — every consumer fails closed on
     * both, but "this deployment has no faucet" and "no card at all" are different
     * things to show.
     */
    static func parseFaucetInfo(_ raw: Any?) -> FaucetInfo? {
        guard let o = raw as? [String: Any] else { return nil }
        return FaucetInfo(
            // The worker sends a real JSON boolean, but a D1-ish 0/1 would read as
            // nil through `as? Bool` — and this one flag gates the whole card, so
            // read it through NSNumber's boolValue like the rest of the app does.
            available: truthy(o["available"]),
            network: o["network"] as? String,
            dripMicro: micro(o["drip_micro"]),
            capMicro: micro(o["cap_micro"]),
            grantedMicro: micro(o["granted_micro"]),
            // NOT defaulted to the cap: a missing `remaining_micro` must read as NO
            // credit (fail closed), or the button enables and 400s on press.
            remainingMicro: micro(o["remaining_micro"]),
            claimedToday: truthy(o["claimed_today"]),
            nextDripInSeconds: micro(o["next_drip_in_seconds"]),
            reputation: micro(o["reputation"]),
            microPerPoint: micro(o["micro_per_point"]),
            maxMicro: micro(o["max_micro"]))
    }

    /// A JSON flag that may arrive as `true` or as a D1 integer 1.
    static func truthy(_ value: Any?) -> Bool {
        if let b = value as? Bool { return b }
        if let n = value as? NSNumber { return n.boolValue }
        return false
    }

    // MARK: - the route

    /**
     * Which top-up route this deployment offers. Exactly one, always — mutually
     * exclusive ON PURPOSE. A fiat card button offered "just in case" beside the
     * faucet, on a chain where the card cannot deliver, IS the bug this deletes.
     *
     *  - `faucet`  — we own the chain, so we issue the credit.
     *  - `testnet` — Sepolia: the public faucet is the one true source; fiat
     *                on-ramps deliver MAINNET USDC the claim scanner can't see.
     *  - `fiat`    — real Base: cards/bridges work and a faucet would be nonsense.
     */
    enum Route { case faucet, testnet, fiat }

    /**
     * Pick the route.
     *
     * Keyed on `faucet.available` — the server's own answer — and NOT on
     * `chain == "tiny"`, because those two legitimately disagree: the faucet needs
     * a mintable token AND a deployer key, so a half-configured tiny-chain
     * deployment reports `tiny` with no faucet, and a claim button there 424s on
     * every press. Fall back to what the network can actually do.
     */
    static func route(chain: String?, faucet: FaucetInfo?) -> Route {
        if faucet?.available == true { return .faucet }
        return asNetwork(chain) == .baseSepolia ? .testnet : .fiat
    }

    /// The top-up card's blurb, one per route (web + Android parity).
    static func blurb(_ route: Route) -> String {
        switch route {
        case .faucet:
            return "This deployment runs its own chain, so credit comes straight from us — no card, no exchange, no wallet needed. It's spendable on any tiny; it isn't withdrawable as real USDC."
        case .testnet:
            return "This deployment runs on Base Sepolia — grab free testnet USDC, then claim it below to try risk-free. (Testnet credits aren't withdrawable as real USDC.)"
        case .fiat:
            return "Buy or bridge USDC on Base into your linked address, then claim it below."
        }
    }

    /// The card's own title — the faucet route isn't "Get USDC", it's credit.
    static func title(_ route: Route) -> String {
        route == .faucet ? "💧 Get credit (free daily top-up)" : "💳 Get USDC"
    }

    /**
     * The EXTERNAL deposit sources, reached only on the TESTNET and FIAT routes.
     * On the FAUCET route this is deliberately EMPTY — the card renders a claim
     * button instead, and no external rail can deliver a token only this
     * deployment mints.
     */
    static func usdcSources(_ route: Route) -> [(label: String, url: String)] {
        switch route {
        case .faucet: return []
        case .testnet: return [("🧪 Get free testnet USDC", "https://faucet.circle.com")]
        case .fiat: return [("Coinbase", "https://www.coinbase.com/price/usdc"),
                            ("Bridge to Base", "https://bridge.base.org")]
        }
    }

    // MARK: - the claim button

    struct FaucetCta: Equatable {
        var enabled: Bool
        var label: String
        /// Why it's disabled — "" when enabled.
        var reason: String
    }

    /**
     * Three states, and the two REFUSALS must never collapse into one sentence.
     * They're the client mirror of the worker's deliberately-distinct 429
     * (`already_claimed`) vs 400 (`ceiling_reached`): "wait until UTC midnight"
     * and "you've spent your lifetime ceiling, get followed to raise it" are
     * OPPOSITE instructions, so a shared "try again later" sends a permanently
     * capped user back to the button every day, and a user who merely claimed
     * today off to farm reputation they don't need.
     *
     * Ceiling is checked BEFORE the daily claim: someone fully capped AND claimed
     * today is capped — "come back tomorrow" would be a lie, because tomorrow's
     * drip is refused too.
     */
    static func faucetCta(_ f: FaucetInfo?) -> FaucetCta {
        guard let f, f.available else {
            return FaucetCta(enabled: false, label: "Top-up unavailable",
                             reason: "This deployment has no in-house faucet.")
        }
        let remaining = max(0, f.remainingMicro)
        if remaining <= 0 {
            return FaucetCta(
                enabled: false, label: "Lifetime credit used",
                // The actionable half: the ceiling is reputation-scaled, so it GROWS.
                reason: "You've used all \(usdShort(f.capMicro)) of your trial credit. Get followed to raise the ceiling, or deposit real USDC on Base.")
        }
        if f.claimedToday {
            let wait = untilNextDrip(f.nextDripInSeconds)
            return FaucetCta(
                enabled: false, label: "Claimed today",
                reason: "Next top-up \(wait.isEmpty ? "after midnight UTC" : "in \(wait)") — \(usdShort(remaining)) still left on your ceiling.")
        }
        // The worker credits MIN(drip, remaining), so the button must promise what
        // will actually land — "Claim $1" that pays $0.30 is the client breaking a
        // promise the server never made.
        let credit = min(max(0, f.dripMicro), remaining)
        return FaucetCta(enabled: true, label: "Claim \(usdShort(credit)) free credit", reason: "")
    }

    /**
     * The one-line explanation of the ceiling. Separate from the CTA because it's
     * shown in ALL faucet states — a user who just claimed still needs to know why
     * their ceiling is what it is, and that being followed is what raises it.
     */
    static func ceilingNote(_ f: FaucetInfo?) -> String {
        guard let f, f.available else { return "" }
        let per = usdShort(f.microPerPoint)
        let rep = f.reputation
        let earned = rep > 0
            ? " Your \(rep) reputation \(rep == 1 ? "point adds" : "points add") \(per) each"
            : " Earn reputation (\(per) per point) by getting followed"
        return "\(usdShort(f.grantedMicro)) of \(usdShort(f.capMicro)) used.\(earned), up to \(usdShort(f.maxMicro))."
    }

    // MARK: - the claim reply

    /**
     * The outcome of `POST /api/wallet/faucet`.
     *
     * The two refusals stay SEPARATE cases rather than one failure with a flag,
     * for the same reason `faucetCta` keeps two messages — and the route passes
     * the worker's own sentences through verbatim, so re-wording them here would
     * undo that on purpose.
     */
    enum FaucetResult: Equatable {
        /// Credited. `reserveBacked` = the matching TinyUSDC mint landed on-chain
        /// (best-effort by design — the credit is real either way).
        case ok(creditedMicro: Int, reserveBacked: Bool, explorer: String?)
        /// 429 — today's drip is spent; the wording carries `next_drip_in_seconds`.
        case alreadyClaimed(String)
        /// 400 — the reputation-scaled lifetime ceiling is spent; waiting won't help.
        case ceilingReached(String)
        /// 424 (no faucet here) / 401 / 500 — everything else.
        case failed(String)
    }

    /// `status` is the HTTP code when the caller could capture it (Wallet's
    /// `post()` injects `_status`), used only as a fallback: the worker sets the
    /// flags explicitly, and a proxy that rewrote the body is the case the code is
    /// for.
    static func parseFaucetResult(_ body: [String: Any]?) -> FaucetResult {
        guard let d = body else { return .failed("couldn't reach the faucet") }
        if truthy(d["ok"]) {
            return .ok(creditedMicro: micro(d["credited_micro"]),
                       reserveBacked: truthy(d["reserve_backed"]),
                       explorer: d["explorer"] as? String)
        }
        let err = (d["error"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "faucet unavailable"
        // Flag first, status second — and ceiling BEFORE already-claimed, matching
        // faucetCta: a capped user who also claimed today must hear about the cap.
        if truthy(d["ceiling_reached"]) { return .ceilingReached(err) }
        if truthy(d["already_claimed"]) { return .alreadyClaimed(err) }
        if micro(d["_status"]) == 429 { return .alreadyClaimed(err) }
        return .failed(err)
    }
}

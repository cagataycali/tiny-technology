/**
 * 🏅 STANDING (iOS) — what this builder's reputation is worth, said BEFORE the
 * wall instead of at it.
 *
 * Port of `lib/standing.ts` (web `ModelSettings`' free-tier footer). The whole
 * arc so far speaks only at the moment of refusal: c8 sized a signed-in
 * builder's daily allowance by reputation, c37 made the 429 explain the curve,
 * c38 put the caller's own numbers on `/api/me`. Every one of those is a
 * consolation prize — you learn the lever exists by being stopped by it.
 *
 * iOS's mirror of that footer (`Settings.swift`, "Model & API key") said
 * "Using the free, rate-limited Tiny model" and named **no number at all** — so
 * a builder with 40 points, whose enforced window is 250/day, could not find out
 * from this app that standing had already bought them 200 extra requests, nor
 * that being followed is what buys more.
 *
 * ⚠️ **The curve is NOT redeclared here.** `perPoint` and `maxBonus` come off the
 * wire (`/api/me` → `standing`) precisely because a `let requestsPerPoint = 5`
 * in Swift is a fork of `lib/rate-limit-curve.ts` that agrees with it right up
 * until the curve moves — and then lies from an installed build the user has no
 * reason to update. Same call `TopUp.FaucetInfo` already makes for the faucet's
 * `micro_per_point`/`max_micro`.
 *
 * PURE (no SwiftUI, no URLSession) so every sentence a user can read is asserted
 * in StandingTests rather than eyeballed on a device — the c25/c26 lesson that
 * the untestable file is where the stale copy lives.
 */
import Foundation

struct Standing: Equatable {
    /// Reputation points the network granted this user (0 = none yet).
    var score = 0
    /// The allowance before reputation — this deployment's free tier.
    var base = 0
    /// What the limiter actually builds the window with.
    var allowance = 0
    /// Extra requests standing has earned (allowance − base, never negative).
    var bonus = 0
    /// Requests one more point buys, per the SERVER's curve (never hardcoded).
    var perPoint = 0
    /// Ceiling on the earned bonus — what "the full 200" refers to.
    var maxBonus = 0

    /// Is the earning lever spent? Guarded against a `maxBonus` of 0: an older
    /// or partial payload must not make every reader look capped, because the
    /// capped branch is the one that goes SILENT about earning more.
    var atCap: Bool { maxBonus > 0 && bonus >= maxBonus }

    // MARK: - parse

    /**
     * Parse the `standing` object from `GET /api/me`.
     *
     * nil for anything unusable — a pre-c38 server (no field), a signed-out
     * probe, junk. Every caller then falls back to copy that quotes no number,
     * which is what iOS showed before this existed: strictly no worse.
     *
     * `identified:false` also yields nil, deliberately. Signed out the window is
     * IP-keyed and SHARED with everyone on that network, so there is no personal
     * allowance to report; quoting the base as "your" allowance would be the
     * exact class of bug this file fixes — a correct number under a label naming
     * something else.
     */
    static func parse(_ raw: Any?) -> Standing? {
        guard let o = raw as? [String: Any] else { return nil }
        if let identified = o["identified"] {
            guard truthy(identified) else { return nil }
        }
        let base = int(o["base"])
        // A base of 0 means the field is missing or nonsense; a real deployment
        // always has at least 1 (lib/free-tier fails closed to 50).
        guard base >= 1 else { return nil }
        let allowance = max(base, int(o["allowance"]))
        return Standing(score: int(o["score"]),
                        base: base,
                        allowance: allowance,
                        bonus: allowance - base,
                        // camelCase, matching the `atCap` this same object has
                        // shipped since c38 — one convention per payload, and
                        // tests/standing.test.ts asserts every key read here is
                        // a key `standingFor` actually writes.
                        perPoint: int(o["perPoint"]),
                        maxBonus: int(o["maxBonus"]))
    }

    /**
     * A JSON count → Int, without the trap.
     *
     * `Int(Double.infinity)` **crashes** rather than overflowing (last-mile c134,
     * menubar c24, `TopUp.micro`, `ChatStreamDecoder.safeMicro` — the fourth copy
     * of this five-line guard, because these files live in different targets and
     * a cross-target dependency costs more than the duplication). Non-finite,
     * negative and non-numeric all read as 0, which every caller treats as
     * "unknown" and falls back on.
     */
    static func int(_ value: Any?) -> Int {
        guard let n = value as? NSNumber else { return 0 }
        let d = n.doubleValue
        guard d.isFinite, d > 0 else { return 0 }
        return d >= Double(Int.max) ? Int.max : Int(d)
    }

    /// A flag that may arrive as `true` or as an integer 1 (TopUp.truthy's rule).
    static func truthy(_ value: Any?) -> Bool {
        if let b = value as? Bool { return b }
        if let n = value as? NSNumber { return n.boolValue }
        return false
    }

    // MARK: - copy

    /// Count grammar without a shared helper: iOS has no `pluralize`, and
    /// "1 requests a day" on a free tier of 1 is the kind of tell that makes a
    /// number look computed by nobody.
    private static func plural(_ n: Int, _ word: String) -> String {
        "\(n) \(word)\(n == 1 ? "" : "s")"
    }

    /// The allowance as a phrase — "250 requests a day". The period matters as
    /// much as the count: an allowance with no window is not a limit.
    var allowancePhrase: String { "\(Self.plural(allowance, "request")) a day" }

    /**
     * The breakdown, or "" when there is nothing true to add.
     *
     * Empty at zero points on purpose: "50 = 50 free plus 0 earned from 0 points"
     * is noise, and the honest message there is the invitation (`nextStep`).
     */
    var detail: String {
        guard bonus > 0 else { return "" }
        if atCap { return "\(base) free plus the full \(maxBonus) that reputation can earn." }
        return "\(base) free plus \(bonus) earned from \(Self.plural(score, "point")) of reputation."
    }

    /**
     * What earning more would get them, or "" when nothing would.
     *
     * ⚠️ Silent at the cap: "each point adds 5 more" is FALSE there, and dangling
     * a spent lever is worse than saying nothing — a user can act on it for weeks
     * for zero effect (the rule `lib/limit-message.ts` and `lib/standing.ts`
     * both follow). Also silent when the server didn't send a curve: an
     * invented number is worse than an absent sentence.
     *
     * Names *being followed* because that is the gesture that pays — following
     * pays nothing (worker `reputation.ts`).
     */
    var nextStep: String {
        guard !atCap, perPoint > 0, maxBonus > 0 else { return "" }
        let room = max(0, maxBonus - bonus)
        return "Each reputation point adds \(perPoint) more a day (\(room) still to earn) — being followed is what pays."
    }

    /**
     * The whole free-tier sentence for the Settings footer, standing or not.
     *
     * Built here rather than interpolated at the call site so the four render
     * states are one testable function instead of a `if let` ladder inside a
     * SwiftUI `Text` — the same reason `ChatStreamDecoder` exists.
     */
    static func freeTierFooter(_ s: Standing?) -> String {
        guard let s else {
            // No standing (signed out, older server, junk): quote no number.
            // Naming the deployment's base would be wrong for the signed-out
            // case in the way that matters — that window is shared with every
            // visitor on this network, not theirs.
            return "Using the free, rate-limited Tiny model. Pick a provider to bring your own key."
        }
        var out = "Using Tiny's free model — \(s.allowancePhrase)"
        let d = s.detail
        out += d.isEmpty ? ". " : ": \(d) "
        out += "Pick a provider to bring your own key and bypass the limit."
        let next = s.nextStep
        if !next.isEmpty { out += " \(next)" }
        return out
    }
}

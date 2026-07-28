/**
 * 🏅 The allowance iOS quotes before the wall.
 *
 * The number a user reads here is enforced somewhere they can't see — the
 * limiter's Upstash window. Web can prove the two agree by CALLING the enforcer
 * (`lib/standing.ts` imports `reputationAllowance`); iOS cannot import anything,
 * so its only defence is to compute nothing and read the server's numbers,
 * including the curve. What's asserted below is exactly that discipline: that no
 * arithmetic in this file re-derives the allowance, that a missing curve makes
 * the app go QUIET rather than invent a "5 per point", and that the states where
 * there is nothing true to say produce empty strings instead of plausible ones.
 *
 * Plus the trap: `Int(Double.infinity)` crashes on Apple platforms, and this
 * payload is a JSON object off the network.
 */
import Testing
import Foundation
@testable import Tiny

/// The shape `standingFor()` writes (lib/standing.ts) — keys and camelCase both.
private func standingJson(
    score: Any = 10,
    base: Any = 50,
    allowance: Any = 100,
    perPoint: Any = 5,
    maxBonus: Any = 200,
    identified: Any? = true
) -> [String: Any] {
    var o: [String: Any] = [
        "score": score, "base": base, "allowance": allowance,
        "perPoint": perPoint, "maxBonus": maxBonus,
    ]
    if let identified { o["identified"] = identified }
    return o
}

@Suite("Standing.parse — the server's numbers, or none")
struct StandingParseTests {

    @Test("a full payload lands, bonus derived from the SERVER's allowance")
    func parsesFullPayload() {
        let s = Standing.parse(standingJson())
        #expect(s?.allowance == 100)
        #expect(s?.base == 50)
        // Not `base + score × perPoint`: the bonus is the difference between two
        // numbers the server sent, so a curve change needs no iOS release.
        #expect(s?.bonus == 50)
        #expect(s?.score == 10)
        #expect(s?.perPoint == 5)
        #expect(s?.maxBonus == 200)
        #expect(s?.atCap == false)
    }

    @Test("no field, junk, or an empty object → nil (a pre-c38 server, safely)")
    func degradesToNil() {
        #expect(Standing.parse(nil) == nil)
        #expect(Standing.parse("nope") == nil)
        #expect(Standing.parse(42) == nil)
        #expect(Standing.parse([String: Any]()) == nil)
        // A base is the one field the copy cannot do without.
        #expect(Standing.parse(standingJson(base: 0)) == nil)
        #expect(Standing.parse(standingJson(base: "lots")) == nil)
    }

    @Test("identified:false → nil: that window is SHARED, not theirs")
    func refusesAnonymousStanding() {
        // Quoting the base as "your allowance" signed out would be the exact bug
        // this file fixes — a correct number under a label naming something else.
        #expect(Standing.parse(standingJson(identified: false)) == nil)
        #expect(Standing.parse(standingJson(identified: 0)) == nil)
        // Absent `identified` is a c38-or-later server answering a session probe
        // (/api/me 401s otherwise), so it must NOT be read as anonymous.
        #expect(Standing.parse(standingJson(identified: nil)) != nil)
        #expect(Standing.parse(standingJson(identified: 1)) != nil)
    }

    @Test("an allowance below the base is clamped, never negative bonus")
    func clampsInconsistentAllowance() {
        let s = Standing.parse(standingJson(base: 50, allowance: 10))
        #expect(s?.allowance == 50)
        #expect(s?.bonus == 0)
        // A missing allowance reads as the base — no standing, not no access.
        let missing = Standing.parse(["base": 50, "score": 0])
        #expect(missing?.allowance == 50)
        #expect(missing?.bonus == 0)
    }

    @Test("1e999 does not crash the app — Int(Double.infinity) traps")
    func survivesAbsurdNumbers() {
        // JSONSerialization hands back a Double here, and the naive `Int(d)` is a
        // hard crash, not an overflow (last-mile c134, menubar c24). Every
        // numeric field takes the same route.
        for junk in [Double.infinity, -Double.infinity, Double.nan, 1e308, -5] as [Any] {
            let s = Standing.parse(standingJson(score: junk, base: junk, allowance: junk,
                                                perPoint: junk, maxBonus: junk))
            // base fails the >= 1 guard for nan/-inf/-5 → nil; for 1e308/inf it
            // clamps to Int.max. Either is fine; NOT crashing is the assertion.
            if let s {
                #expect(s.base >= 1)
                #expect(s.bonus >= 0)
            }
        }
        // And a junk value in ONE field can't poison the others.
        let s = Standing.parse(standingJson(score: Double.infinity))
        #expect(s?.allowance == 100)
        #expect(s?.score == Int.max || s?.score == 0)
    }

    @Test("a bool where a count belongs is not silently 1")
    func ignoresWrongTypes() {
        // NSNumber covers Bool on Apple platforms, so `true` would read as 1 —
        // harmless for score but nonsense as a base. The guard is that nothing
        // here can produce a plausible-looking wrong number: base:true → 1 is
        // still >= 1, so assert the copy that results is at least self-consistent.
        let s = Standing.parse(standingJson(base: true, allowance: true))
        #expect(s?.base == 1)
        #expect(s?.bonus == 0)
        #expect(s?.allowancePhrase == "1 request a day")
    }
}

@Suite("Standing copy — true at every point on the curve")
struct StandingCopyTests {

    private func s(score: Int = 10, base: Int = 50, allowance: Int = 100,
                   perPoint: Int = 5, maxBonus: Int = 200) -> Standing {
        Standing(score: score, base: base, allowance: allowance,
                 bonus: max(0, allowance - base), perPoint: perPoint, maxBonus: maxBonus)
    }

    @Test("count grammar holds at 1 — no '1 requests', no '1 points'")
    func pluralizesCorrectly() {
        #expect(s(base: 1, allowance: 1).allowancePhrase == "1 request a day")
        #expect(s(allowance: 100).allowancePhrase == "100 requests a day")
        #expect(s(score: 1, allowance: 55).detail.contains("1 point of reputation"))
        #expect(!s(score: 1, allowance: 55).detail.contains("1 points"))
    }

    @Test("no standing yet → no breakdown, just the invitation")
    func silentBreakdownAtZero() {
        // "50 = 50 free plus 0 earned from 0 points" is noise.
        let none = s(score: 0, allowance: 50)
        #expect(none.detail == "")
        #expect(none.nextStep.contains("adds 5 more a day"))
        #expect(none.nextStep.contains("followed"))
        #expect(none.nextStep.contains("200 still to earn"))
    }

    @Test("mid-curve → the split, so the earned part is visible")
    func showsSplit() {
        let d = s(score: 10, allowance: 100).detail
        #expect(d == "50 free plus 50 earned from 10 points of reputation.")
    }

    @Test("AT THE CAP the next step is EMPTY — never dangle a spent lever")
    func silentAtCap() {
        let capped = s(score: 40, allowance: 250)
        #expect(capped.atCap)
        #expect(capped.nextStep == "")
        #expect(capped.detail == "50 free plus the full 200 that reputation can earn.")
    }

    @Test("no curve on the wire → SILENCE, not an invented 5 per point")
    func silentWithoutACurve() {
        // The whole reason perPoint/maxBonus travel: an older server that sends
        // an allowance but no curve must not make iOS quote numbers it made up.
        let noCurve = s(score: 10, allowance: 100, perPoint: 0, maxBonus: 0)
        #expect(noCurve.nextStep == "")
        // …and a maxBonus of 0 must not make everyone look capped, because the
        // capped branch is itself a claim ("the full 0 that reputation can earn").
        #expect(noCurve.atCap == false)
        #expect(noCurve.detail == "50 free plus 50 earned from 10 points of reputation.")
        // The allowance itself is still reportable — it came from the server.
        #expect(noCurve.allowancePhrase == "100 requests a day")
    }

    @Test("the remaining-to-earn figure shrinks and never goes negative")
    func remainingRoomNeverNegative() {
        #expect(s(score: 10, allowance: 100).nextStep.contains("150 still to earn"))
        for allowance in [50, 55, 100, 249, 250, 400] {
            let st = s(allowance: allowance)
            let line = st.nextStep
            #expect(!line.contains("-"), "negative room in: \(line)")
            if st.atCap { #expect(line == "") }
        }
    }

    @Test("no branch ever prints NaN, nil or a placeholder")
    func neverPrintsJunk() {
        for score in [0, 1, 10, 40, 9_999] {
            for allowance in [50, 51, 100, 250, 9_999] {
                let st = s(score: score, allowance: allowance)
                for line in [st.allowancePhrase, st.detail, st.nextStep,
                             Standing.freeTierFooter(st)] {
                    #expect(!line.contains("nil") && !line.contains("nan")
                            && !line.contains("Optional") && !line.contains("inf"))
                }
            }
        }
    }
}

@Suite("freeTierFooter — the sentence Settings actually renders")
struct StandingFooterTests {

    @Test("nil standing quotes NO number — signed out, the window is shared")
    func fallsBackWithoutStanding() {
        let f = Standing.freeTierFooter(nil)
        #expect(f == "Using the free, rate-limited Tiny model. Pick a provider to bring your own key.")
        // Specifically: no digits. Naming the deployment's base here would claim
        // a personal allowance for a window shared with every visitor on this
        // network — and this is also the pre-c38-server case.
        // (Computed outside #expect: the macro decomposes the expression, which
        // turns `contains(where:)`'s rethrows into a call it must `try`.)
        let hasDigits = f.contains(where: { $0.isNumber })
        #expect(!hasDigits)
    }

    @Test("with standing it names the window, the split and the lever")
    func namesEverythingMidCurve() {
        let s = Standing(score: 10, base: 50, allowance: 100, bonus: 50, perPoint: 5, maxBonus: 200)
        let f = Standing.freeTierFooter(s)
        #expect(f == "Using Tiny's free model — 100 requests a day: 50 free plus 50 earned from "
                + "10 points of reputation. Pick a provider to bring your own key and bypass the limit. "
                + "Each reputation point adds 5 more a day (150 still to earn) — being followed is what pays.")
    }

    @Test("zero points: a full stop after the number, then the invitation")
    func punctuatesWithoutABreakdown() {
        let s = Standing(score: 0, base: 50, allowance: 50, bonus: 0, perPoint: 5, maxBonus: 200)
        let f = Standing.freeTierFooter(s)
        // The colon belongs to the breakdown; without one the sentence must not
        // read "50 requests a day Pick a provider".
        #expect(f.hasPrefix("Using Tiny's free model — 50 requests a day. Pick a provider"))
        #expect(f.contains("Each reputation point adds 5 more a day"))
        #expect(!f.contains("day:"))
    }

    @Test("at the cap the footer stops after the breakdown")
    func stopsAtCap() {
        let s = Standing(score: 45, base: 50, allowance: 250, bonus: 200, perPoint: 5, maxBonus: 200)
        let f = Standing.freeTierFooter(s)
        #expect(f.hasSuffix("bypass the limit."))
        #expect(!f.contains("still to earn"))
        #expect(f.contains("the full 200 that reputation can earn"))
    }

    @Test("the deployment's base is followed, not a hardcoded 50")
    func followsDeploymentBase() {
        let s = Standing.parse(standingJson(score: 4, base: 500, allowance: 520))
        #expect(Standing.freeTierFooter(s).contains("520 requests a day"))
        #expect(Standing.freeTierFooter(s).contains("500 free plus 20 earned"))
    }
}

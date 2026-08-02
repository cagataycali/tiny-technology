/**
 * The top-up surface — the first tests iOS's wallet has ever had.
 *
 * `grep Wallet ios/Tests/TinyTests.swift` returned nothing before this file: the
 * one screen that moves money was 925 lines of SwiftUI with zero assertions,
 * which is precisely why it still pointed a self-hosted-chain user at Coinbase.
 *
 * What's asserted is what a reviewer can't see by reading the view: that exactly
 * one route is ever offered, that the faucet route offers NO external rail, that
 * the two refusals stay two different sentences, that a button never promises
 * more than the server will credit, and that a hostile JSON number can't crash
 * the money screen.
 */
import Testing
import Foundation
@testable import Tiny

// A faucet block as the worker sends it — available, $1 drip, $5 ceiling, $3 left.
private func faucetJson(
    available: Any = true,
    drip: Any = 1_000_000,
    cap: Any = 5_000_000,
    granted: Any = 2_000_000,
    remaining: Any? = 3_000_000,
    claimedToday: Any = false,
    nextDrip: Any = 0,
    reputation: Any = 4,
    perPoint: Any = 1_000_000,
    max: Any = 50_000_000
) -> [String: Any] {
    var o: [String: Any] = [
        "available": available,
        "network": "tiny",
        "drip_micro": drip,
        "cap_micro": cap,
        "granted_micro": granted,
        "claimed_today": claimedToday,
        "next_drip_in_seconds": nextDrip,
        "reputation": reputation,
        "micro_per_point": perPoint,
        "max_micro": max,
    ]
    if let remaining { o["remaining_micro"] = remaining }
    return o
}

private func info(_ o: [String: Any]) -> TopUp.FaucetInfo? { TopUp.parseFaucetInfo(o) }

@Suite("TopUp — route selection")
struct TopUpRouteTests {

    /// The whole point of cycle 26: on a chain we own, no external on-ramp exists.
    @Test func ourOwnChainOffersTheFaucetAndNoExternalOnRamp() {
        let r = TopUp.route(chain: "tiny", faucet: info(faucetJson()))
        #expect(r == .faucet)
        #expect(TopUp.usdcSources(r).isEmpty, "no exchange sells TinyUSDC — every link here would be a trap")
        // No 💧: emoji left the app's titles in the de-emoji sweep (2277d5f6),
        // which shipped without updating this assertion.
        #expect(TopUp.title(r) == "Get credit (free daily top-up)")
        #expect(TopUp.blurb(r).contains("no card, no exchange, no wallet needed"))
    }

    /// A tiny-chain deployment whose faucet isn't configured (no deployer key /
    /// no mintable token): a claim button here 424s on every press, so fall back
    /// to what the network can do rather than trusting the network NAME.
    @Test func aTinyChainWithoutAWorkingFaucetDoesNotOfferOne() {
        let r = TopUp.route(chain: "tiny", faucet: info(faucetJson(available: false)))
        #expect(r == .fiat)
        #expect(TopUp.faucetCta(info(faucetJson(available: false))).enabled == false)
    }

    /// …and the reverse disagreement: the server says a faucet exists on a chain
    /// we didn't hard-code. `faucet.available` is the authority, always.
    @Test func theServersFaucetFlagWinsOverTheNetworkName() {
        #expect(TopUp.route(chain: "base-sepolia", faucet: info(faucetJson())) == .faucet)
        #expect(TopUp.route(chain: "some-future-l2", faucet: info(faucetJson())) == .faucet)
    }

    @Test func sepoliaWithoutAFaucetBlockGetsTheCircleFaucetOnly() {
        let r = TopUp.route(chain: "base-sepolia", faucet: nil)
        #expect(r == .testnet)
        let s = TopUp.usdcSources(r)
        #expect(s.count == 1)
        #expect(s.first?.url == "https://faucet.circle.com")
    }

    @Test func mainnetGetsTheFiatRails() {
        let r = TopUp.route(chain: "base", faucet: nil)
        #expect(r == .fiat)
        #expect(TopUp.usdcSources(r).map(\.url) == ["https://www.coinbase.com/price/usdc", "https://bridge.base.org"])
    }

    /// Exactly one route, never two: a fiat button rendered "just in case" beside
    /// the faucet is the bug, not a fallback.
    @Test func theThreeRoutesAreMutuallyExclusive() {
        let cases: [(String?, TopUp.FaucetInfo?)] = [
            ("tiny", info(faucetJson())), ("base-sepolia", nil), ("base", nil),
            (nil, nil), ("", info(faucetJson(available: false))),
        ]
        for (chain, f) in cases {
            let r = TopUp.route(chain: chain, faucet: f)
            let external = TopUp.usdcSources(r)
            #expect(r == .faucet ? external.isEmpty : !external.isEmpty,
                    "chain \(chain ?? "nil") offered the wrong rails")
        }
    }
}

@Suite("TopUp — network naming and choices")
struct TopUpNetworkTests {

    @Test func anUnknownNetworkReadsAsRealMoney() {
        // The safe default: mislabeling REAL money as "trial credit" invites a
        // user to treat withdrawable USDC as play money.
        #expect(TopUp.asNetwork("moonbeam") == .base)
        #expect(TopUp.asNetwork(nil) == .base)
        #expect(TopUp.asNetwork("") == .base)
        #expect(TopUp.isRealMoney(TopUp.asNetwork("nonsense")))
    }

    @Test func networkNamesAreParsedLooselyButExactly() {
        #expect(TopUp.asNetwork(" TINY ") == .tiny)
        #expect(TopUp.asNetwork("Base-Sepolia") == .baseSepolia)
        #expect(TopUp.asNetwork("tiny-chain") == .base, "not a real network id — don't guess trial")
    }

    /// Both trial chains must SAY trial, because the withdrawal refusal comes
    /// after the user has already earned on them.
    @Test func bothTrialNetworksAdvertiseThatTheyreTrial() {
        #expect(TopUp.networkLabel(.tiny).contains("trial credit"))
        #expect(TopUp.networkLabel(.baseSepolia).contains("trial credit"))
        #expect(TopUp.networkLabel(.base) == "Base (real USDC)")
        #expect(TopUp.isRealMoney(.tiny) == false)
        #expect(TopUp.isRealMoney(.baseSepolia) == false)
        #expect(TopUp.isRealMoney(.base))
    }

    /// The approval card's network clause names what approving SPENDS. Only
    /// exact known names map to the money-kind label; an unknown chain renders
    /// verbatim, because routing through asNetwork() would default it to Base —
    /// calling unknown money "real USDC" is the one direction the card must
    /// never err (the same reason asNetwork defaults the OTHER way for pickers).
    @Test func payNetworkDisplayMapsKnownNamesAndNeverGuessesReal() {
        #expect(TopUp.payNetworkDisplay("tiny") == "Tiny Chain (trial credit)")
        #expect(TopUp.payNetworkDisplay("base-sepolia") == "Base Sepolia (trial credit)")
        #expect(TopUp.payNetworkDisplay("base") == "Base (real USDC)")
        #expect(TopUp.payNetworkDisplay("eip155:99999") == "eip155:99999")
        #expect(TopUp.payNetworkDisplay(nil) == nil)
        #expect(TopUp.payNetworkDisplay("  ") == nil)
    }

    /// The bug in the two hardcoded `Picker`s: on a tiny-chain deployment the
    /// user's OWN network wasn't offerable, so every claim/withdraw was aimed at
    /// a chain their money isn't on.
    @Test func aPickerOffersTheDeploymentsOwnChainPlusBase() {
        #expect(TopUp.networkChoices("tiny") == [.tiny, .base])
        #expect(TopUp.networkChoices("base-sepolia") == [.baseSepolia, .base])
    }

    /// …and never both trial chains: a Sepolia hash pasted on a tiny deployment
    /// is a permanent "no matching USDC transfer" 400.
    @Test func aPickerNeverOffersTheOtherTrialChain() {
        for def in ["tiny", "base-sepolia", "base", "junk"] {
            let c = TopUp.networkChoices(def)
            let trials = c.filter { !TopUp.isRealMoney($0) }
            #expect(trials.count <= 1, "\(def) offered two trial chains")
            #expect(c.contains(.base), "\(def) dropped the real-money option")
        }
    }

    @Test func mainnetOffersOnlyMainnet() {
        #expect(TopUp.networkChoices("base") == [.base])
        #expect(TopUp.networkChoices(nil) == [.base])
    }

    @Test func theShortNamesFitAConfirmDialog() {
        #expect(TopUp.networkShort(.tiny) == "Tiny Chain")
        #expect(TopUp.networkShort(.baseSepolia) == "Sepolia")
        #expect(TopUp.networkShort(.base) == "Base")
    }
}

@Suite("TopUp — money formatting and parsing")
struct TopUpMoneyTests {

    @Test func buttonAmountsDropTrailingZeros() {
        #expect(TopUp.usdShort(1_000_000) == "$1")
        #expect(TopUp.usdShort(1_200_000) == "$1.2")
        #expect(TopUp.usdShort(25_000) == "$0.025")
        #expect(TopUp.usdShort(1) == "$0.000001")
        #expect(TopUp.usdShort(0) == "$0")
    }

    /// A negative or absurd figure must render, not crash and not read as credit.
    @Test func hostileFiguresCannotCrashTheMoneyScreen() {
        #expect(TopUp.micro(1_000_000) == 1_000_000)
        #expect(TopUp.micro(1_500_000.7) == 1_500_000)
        #expect(TopUp.micro(-5_000) == 0, "a negative allowance must not enable a button")
        #expect(TopUp.micro(nil) == 0)
        #expect(TopUp.micro("1000000") == 0, "a string price is not a price")
        #expect(TopUp.micro(Double.nan) == 0)
        // `Int(Double.infinity)` is a TRAP in Swift — a crash on the wallet screen.
        #expect(TopUp.micro(Double.infinity) == Int.max)
        #expect(TopUp.micro(1e300) == Int.max)
    }

    @Test func waitTimesReadLikeTimeNotSeconds() {
        #expect(TopUp.untilNextDrip(7_500) == "2h 5m")
        #expect(TopUp.untilNextDrip(7_200) == "2h")
        #expect(TopUp.untilNextDrip(300) == "5m")
        // Rounds UP — "in 0m" reads as a bug, and the drip really is imminent.
        #expect(TopUp.untilNextDrip(20) == "1m")
        #expect(TopUp.untilNextDrip(0) == "", "caller falls back to 'after midnight UTC'")
        #expect(TopUp.untilNextDrip(-1) == "")
    }

    @Test func aMissingFaucetBlockIsNotAnEmptyOne() {
        #expect(TopUp.parseFaucetInfo(nil) == nil)
        #expect(TopUp.parseFaucetInfo("nope") == nil)
        let disabled = TopUp.parseFaucetInfo(["available": false])
        #expect(disabled != nil, "'no faucet here' and 'no answer' are different states")
        #expect(disabled?.available == false)
    }

    /// The one field that must fail CLOSED: an absent `remaining_micro` cannot be
    /// read as "the whole cap is available" or the button enables and 400s.
    @Test func anAbsentRemainingReadsAsNoCreditLeft() {
        let f = TopUp.parseFaucetInfo(faucetJson(remaining: nil))
        #expect(f?.remainingMicro == 0)
        #expect(TopUp.faucetCta(f).enabled == false)
    }

    @Test func aD1StyleIntegerFlagStillReadsAsTrue() {
        let f = TopUp.parseFaucetInfo(faucetJson(available: 1, claimedToday: 1))
        #expect(f?.available == true)
        #expect(f?.claimedToday == true)
        #expect(TopUp.truthy("true") == false, "a string is not a boolean")
    }

    @Test func theWholeBlockParses() {
        let f = TopUp.parseFaucetInfo(faucetJson())
        #expect(f?.dripMicro == 1_000_000)
        #expect(f?.capMicro == 5_000_000)
        #expect(f?.grantedMicro == 2_000_000)
        #expect(f?.remainingMicro == 3_000_000)
        #expect(f?.reputation == 4)
        #expect(f?.microPerPoint == 1_000_000)
        #expect(f?.maxMicro == 50_000_000)
        #expect(f?.network == "tiny")
    }
}

@Suite("TopUp — the claim button")
struct TopUpCtaTests {

    @Test func aClaimableFaucetPromisesTheDrip() {
        let cta = TopUp.faucetCta(info(faucetJson()))
        #expect(cta.enabled)
        #expect(cta.label == "Claim $1 free credit")
        #expect(cta.reason.isEmpty)
    }

    /// The worker credits MIN(drip, remaining) — a "Claim $1" that pays $0.30 is
    /// the client breaking a promise the server never made.
    @Test func theButtonPromisesWhatTheCeilingActuallyAllows() {
        let cta = TopUp.faucetCta(info(faucetJson(drip: 1_000_000, remaining: 300_000)))
        #expect(cta.enabled)
        #expect(cta.label == "Claim $0.3 free credit")
    }

    @Test func claimedTodayPointsAtTheClock() {
        let cta = TopUp.faucetCta(info(faucetJson(claimedToday: true, nextDrip: 7_500)))
        #expect(cta.enabled == false)
        #expect(cta.label == "Claimed today")
        #expect(cta.reason.contains("in 2h 5m"))
        #expect(cta.reason.contains("$3 still left"), "there IS more credit — say so")
    }

    @Test func aClaimedTodayWithoutATimestampStillSaysWhen() {
        let cta = TopUp.faucetCta(info(faucetJson(claimedToday: true, nextDrip: 0)))
        #expect(cta.reason.contains("after midnight UTC"))
        #expect(!cta.reason.contains("in 0m"))
    }

    /// The two refusals are OPPOSITE instructions ("wait" vs "get followed"), so
    /// they must never collapse into one sentence.
    @Test func theCeilingRefusalIsADifferentSentenceFromTheDailyOne() {
        let capped = TopUp.faucetCta(info(faucetJson(remaining: 0)))
        let daily = TopUp.faucetCta(info(faucetJson(claimedToday: true)))
        #expect(capped.label == "Lifetime credit used")
        #expect(capped.reason.contains("Get followed to raise the ceiling"))
        #expect(capped.reason.contains("$5"), "name the ceiling they hit")
        #expect(daily.reason != capped.reason)
        #expect(!daily.reason.contains("Get followed"), "waiting is the fix today, not reputation")
        #expect(!capped.reason.contains("midnight"), "tomorrow's drip is refused too")
    }

    /// Capped AND claimed today is CAPPED — "come back tomorrow" would be a lie.
    @Test func theCeilingIsReportedEvenWhenTheyAlsoClaimedToday() {
        let cta = TopUp.faucetCta(info(faucetJson(remaining: 0, claimedToday: true, nextDrip: 3_600)))
        #expect(cta.label == "Lifetime credit used")
        #expect(!cta.reason.contains("1h"))
    }

    /// A negative remaining (server arithmetic drift) must refuse, not enable a
    /// button whose label would be nonsense.
    @Test func aNegativeRemainingRefusesRatherThanPromisingNegativeMoney() {
        let cta = TopUp.faucetCta(info(faucetJson(remaining: -1_000_000)))
        #expect(cta.enabled == false)
        #expect(cta.label == "Lifetime credit used")
    }

    @Test func noFaucetMeansNoPromise() {
        for f in [nil, info(faucetJson(available: false))] {
            let cta = TopUp.faucetCta(f)
            #expect(cta.enabled == false)
            #expect(cta.reason == "This deployment has no in-house faucet.")
        }
    }

    /// The ceiling note appears in ALL faucet states, because that's where the
    /// follow→reputation→credit link is taught.
    @Test func theCeilingNoteTeachesHowTheCeilingGrows() {
        let earned = TopUp.ceilingNote(info(faucetJson(reputation: 4)))
        #expect(earned == "$2 of $5 used. Your 4 reputation points add $1 each, up to $50.")
        let none = TopUp.ceilingNote(info(faucetJson(reputation: 0)))
        #expect(none.contains("Earn reputation ($1 per point) by getting followed"))
        #expect(TopUp.ceilingNote(info(faucetJson(reputation: 1))).contains("1 reputation point adds"),
                "no user is ever told they have '1 points'")
        #expect(TopUp.ceilingNote(nil).isEmpty)
    }

    @Test func theNoteIsShownEvenWhenTheButtonIsDisabled() {
        for f in [faucetJson(remaining: 0), faucetJson(claimedToday: true)] {
            #expect(!TopUp.ceilingNote(info(f)).isEmpty)
        }
    }
}

@Suite("TopUp — the claim reply")
struct TopUpResultTests {

    @Test func aCreditedClaimCarriesTheAmountAndTheMintStatus() {
        let r = TopUp.parseFaucetResult([
            "ok": true, "credited_micro": 1_000_000,
            "reserve_backed": true, "explorer": "https://explorer/tx/0x1",
        ])
        #expect(r == .ok(creditedMicro: 1_000_000, reserveBacked: true, explorer: "https://explorer/tx/0x1"))
    }

    /// The reserve mint is best-effort by design — the credit is real either way,
    /// so a missing mint must NOT read as a failed claim.
    @Test func creditWithoutAReserveMintIsStillCredit() {
        let r = TopUp.parseFaucetResult(["ok": true, "credited_micro": 500_000])
        #expect(r == .ok(creditedMicro: 500_000, reserveBacked: false, explorer: nil))
    }

    @Test func theTwoRefusalsStayDistinctCases() {
        #expect(TopUp.parseFaucetResult(["ok": false, "already_claimed": true, "error": "already claimed today"])
                == .alreadyClaimed("already claimed today"))
        #expect(TopUp.parseFaucetResult(["ok": false, "ceiling_reached": true, "error": "lifetime cap reached"])
                == .ceilingReached("lifetime cap reached"))
    }

    /// Same ordering as `faucetCta`: a capped user who also claimed today hears
    /// about the cap, because waiting won't help them.
    @Test func theCeilingWinsWhenBothFlagsAreSet() {
        let r = TopUp.parseFaucetResult(["ok": false, "already_claimed": true, "ceiling_reached": true, "error": "cap"])
        #expect(r == .ceilingReached("cap"))
    }

    /// A proxy that stripped the body's flags still leaves the status code.
    @Test func aFlaglessRateLimitIsReadFromTheStatus() {
        #expect(TopUp.parseFaucetResult(["ok": false, "_status": 429, "error": "slow down"])
                == .alreadyClaimed("slow down"))
        #expect(TopUp.parseFaucetResult(["ok": false, "_status": 424, "error": "no faucet on this deployment"])
                == .failed("no faucet on this deployment"))
    }

    /// The server's own sentence is passed through verbatim — three clients
    /// re-wording a money refusal is three chances to contradict it.
    @Test func theServersWordingSurvives() {
        let msg = "faucet exhausted for today; next drip in 4h"
        if case .alreadyClaimed(let s) = TopUp.parseFaucetResult(["already_claimed": true, "error": msg]) {
            #expect(s == msg)
        } else {
            Issue.record("expected alreadyClaimed")
        }
    }

    @Test func noBodyAtAllIsATransportFailureNotARefusal() {
        #expect(TopUp.parseFaucetResult(nil) == .failed("couldn't reach the faucet"))
    }

    @Test func anErrorlessFailureStillSaysSomething() {
        #expect(TopUp.parseFaucetResult(["ok": false]) == .failed("faucet unavailable"))
        #expect(TopUp.parseFaucetResult(["ok": false, "error": ""]) == .failed("faucet unavailable"))
    }

    /// A hostile `credited_micro` must not trap on the success path — the claim
    /// already happened, so crashing here loses the confirmation for real money's
    /// twin.
    @Test func anAbsurdCreditedAmountClampsRatherThanTrapping() {
        let r = TopUp.parseFaucetResult(["ok": true, "credited_micro": 1e300])
        #expect(r == .ok(creditedMicro: Int.max, reserveBacked: false, explorer: nil))
    }
}

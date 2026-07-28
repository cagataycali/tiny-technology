/**
 * ⛓️ ChainStatusModel — the native chain explorer's parsing and state decisions.
 *
 * The screen this backs closes the user's gap: "we dont see the chain details in
 * the mobile apps." What makes it worth testing rather than eyeballing is that its
 * failure mode isn't a crash — it's a screen that looks fine and says something
 * false: our own chain's numbers under the wrong id, "no activity" for a node that
 * never answered, or "this deployment has no chain" built out of an error page.
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct ChainStatusTests {

    // A representative healthy body, matching lib/chain/status.ts's output shape.
    private func okBody(_ over: [String: Any] = [:]) -> [String: Any] {
        var b: [String: Any] = [
            "configured": true,
            "chainId": 8470,
            "caip2": "eip155:8470",
            "usdc": "0xabcdef0123456789abcdef0123456789abcdef01",
            "identity": "match",
            "reportedChainId": NSNull(),
            "latestBlock": 5000,
            "reachable": true,
            "moneyNote": "Balances here are trial credit — spendable across tiny, not withdrawable as real USDC.",
            "span": 10000,
            "transfers": [transferRow()],
        ]
        for (k, v) in over { b[k] = v }
        return b
    }

    private func transferRow(_ over: [String: Any] = [:]) -> [String: Any] {
        var r: [String: Any] = [
            "hash": "0x" + String(repeating: "a", count: 64),
            "hashShort": "0xaaaaaa…aaaa",
            "from": "0x" + String(repeating: "1", count: 40),
            "fromShort": "0x111111…1111",
            "to": "0x" + String(repeating: "2", count: 40),
            "toShort": "0x222222…2222",
            "blockNumber": 4242,
            "amountMicro": 1_500_000,
            "amount": "$1.50",
            "clamped": false,
            "kind": "transfer",
        ]
        for (k, v) in over { r[k] = v }
        return r
    }

    // ── The three failures that look identical if you only check for data ────

    @Test func healthyChainReportsOk() {
        let s = ChainStatusModel.parse(okBody())
        #expect(s?.health == .ok)
        #expect(s?.chainId == 8470)
        #expect(s?.caip2 == "eip155:8470")
        #expect(s?.latestBlock == 5000)
        #expect(s?.transfers.count == 1)
        #expect(s?.showsActivity == true)
    }

    @Test func unconfiguredDeploymentIsNotAFailure() {
        // Base deployments have no tiny chain. This is permanent and correct, and
        // must not read as "something is broken" — nor show a network section made
        // of nils.
        let s = ChainStatusModel.parse(["configured": false, "moneyNote": "note", "span": 10000])
        #expect(s?.health == .notConfigured)
        #expect(s?.chainId == nil)
        #expect(s?.showsActivity == false)
        #expect(ChainStatusModel.headline(s!).contains("Base"))
    }

    @Test func unreachableNodeIsNotAnEmptyChain() {
        // The dangerous version of this screen shows "No recent activity" when the
        // node is down: an absence of data presented as a fact about the chain.
        let s = ChainStatusModel.parse(okBody([
            "identity": "unknown", "latestBlock": NSNull(), "reachable": false, "transfers": [],
        ]))
        #expect(s?.health == .unreachable)
        #expect(s?.latestBlock == nil)
        // Activity is HIDDEN, not shown as empty.
        #expect(s?.showsActivity == false)
        #expect(ChainStatusModel.headline(s!).contains("connection problem"))
    }

    @Test func mismatchNamesBothIdsAndClaimsNeither() {
        // TINY_CHAIN_RPC_URL defaults to 127.0.0.1:8545 — the LIVE chain on the
        // host. Config says 8470, the node says 8469: every number real, the
        // heading wrong. Neither value is knowably right, so the UI states the
        // disagreement instead of picking a side.
        let s = ChainStatusModel.parse(okBody([
            "identity": "mismatch", "reportedChainId": 8469,
        ]))
        #expect(s?.health == .mismatch(configured: 8470, reported: 8469))
        let h = ChainStatusModel.headline(s!)
        #expect(h.contains("8470") && h.contains("8469"))
        // And it warns that what's below may not belong to this chain.
        #expect(h.lowercased().contains("different chain"))
    }

    @Test func mismatchOutranksUnreachable() {
        // A node that disagrees AND gave no height: the mismatch is the more
        // actionable fact, and hiding it behind "can't reach" would leave a
        // misconfiguration invisible.
        let s = ChainStatusModel.parse(okBody([
            "identity": "mismatch", "reportedChainId": 8469,
            "latestBlock": NSNull(), "reachable": false,
        ]))
        #expect(s?.health == .mismatch(configured: 8470, reported: 8469))
    }

    @Test func mismatchWithoutTheOtherNumberDegradesHonestly() {
        // "Mismatch" with no reported id can't be explained to a user — it would
        // render "configured as 8470 but the node reports nothing". Unreachable is
        // at least true: we evidently got no usable answer.
        let s = ChainStatusModel.parse(okBody([
            "identity": "mismatch", "reportedChainId": NSNull(),
            "latestBlock": NSNull(), "reachable": false,
        ]))
        #expect(s?.health == .unreachable)
    }

    @Test func eitherUnreachableSignalAloneIsEnough() {
        // `reachable:false` with a height present, and a null height with
        // `reachable:true`, both mean unreachable. Trusting only the server's
        // summary would hide a future bug in it; trusting only the height would
        // ignore a server that knows more than we do.
        #expect(ChainStatusModel.parse(okBody(["reachable": false]))?.health == .unreachable)
        #expect(ChainStatusModel.parse(okBody(["latestBlock": NSNull()]))?.health == .unreachable)
    }

    @Test func blockZeroIsReachable() {
        // A brand-new chain sits at genesis. `!latestBlock` logic calls that down.
        let s = ChainStatusModel.parse(okBody(["latestBlock": 0]))
        #expect(s?.health == .ok)
        #expect(s?.latestBlock == 0)
    }

    // ── An error body must never become a claim about the chain ──────────────

    @Test func nilBodyIsNotAnUnconfiguredChain() {
        // A dropped request must not tell a user on our own chain that this
        // deployment doesn't have one. nil lets the caller show a network error.
        #expect(ChainStatusModel.parse(nil) == nil)
    }

    @Test func bodyWithoutConfiguredKeyIsRejected() {
        // A 500/502 body ({error:…} or a proxy's JSON) has no `configured` key.
        // Defaulting a missing key to false would render "this deployment has no
        // chain" out of an error page — a confident claim from nothing.
        #expect(ChainStatusModel.parse(["error": "boom"]) == nil)
        #expect(ChainStatusModel.parse([:]) == nil)
        // A non-boolean `configured` is equally unusable.
        #expect(ChainStatusModel.parse(["configured": "yes"]) == nil)
    }

    // ── Money is never re-derived on the device ─────────────────────────────

    @Test func amountIsTheServersStringNotOurArithmetic() {
        let s = ChainStatusModel.parse(okBody())
        #expect(s?.transfers.first?.amount == "$1.50")
    }

    @Test func clampedTransferIsFlagged() {
        // Past 2^53 JSONSerialization gives a lossy Double. The server marks the
        // clamp and sends a display string that says so; the device must carry the
        // flag rather than print a confident wrong number.
        let s = ChainStatusModel.parse(okBody([
            "transfers": [transferRow([
                "amountMicro": 9_007_199_254_740_991,
                "amount": "> $9e9 (clamped)",
                "clamped": true,
            ])],
        ]))
        #expect(s?.transfers.first?.clamped == true)
        #expect(s?.transfers.first?.amount.contains("clamped") == true)
    }

    @Test func missingAmountRowIsDroppedNotShownAsBlank() {
        // A row with no amount string has nothing to render; a blank line in a
        // money list reads as a transfer of nothing.
        var bad = transferRow(); bad.removeValue(forKey: "amount")
        var noHash = transferRow(); noHash["hash"] = ""
        let s = ChainStatusModel.parse(okBody(["transfers": [bad, noHash, transferRow()]]))
        #expect(s?.transfers.count == 1)
    }

    @Test func mintAndBurnAreNamedByTheServer() {
        // On a chain whose supply is ours, "where did this money come from" is the
        // question the explorer answers. The device must not decode 0x0 itself.
        let s = ChainStatusModel.parse(okBody(["transfers": [
            transferRow(["kind": "mint", "hash": "0x" + String(repeating: "b", count: 64)]),
            transferRow(["kind": "burn", "hash": "0x" + String(repeating: "c", count: 64)]),
            transferRow(["kind": "transfer"]),
        ]]))
        #expect(s?.transfers.map(\.kindLabel) == ["🌱 Issued", "🔥 Burned", "↔️ Transfer"])
    }

    @Test func unknownKindFallsBackToTransferWording() {
        // A future server kind must not render an empty label.
        let s = ChainStatusModel.parse(okBody(["transfers": [transferRow(["kind": "rebase"])]]))
        #expect(s?.transfers.first?.kindLabel == "↔️ Transfer")
    }

    @Test func transferKeepsFullHexForCopyAndTapThrough() {
        let t = ChainStatusModel.parse(okBody())?.transfers.first
        #expect(t?.hash.count == 66)
        #expect(t?.from.count == 42)
        #expect(t?.hashShort.count ?? 99 < 20)
    }

    // ── int(): a missing number is not zero ────────────────────────────────

    @Test func intRefusesToTurnAbsenceIntoZero() {
        // `latestBlock ?? 0` would render "unknown" as a chain at genesis — a
        // specific, wrong, plausible-looking claim.
        #expect(ChainStatusModel.int(nil) == nil)
        #expect(ChainStatusModel.int(NSNull()) == nil)
        #expect(ChainStatusModel.int("5000") == nil, "a numeric string is a shape we don't serve")
        #expect(ChainStatusModel.int(5000) == 5000)
        #expect(ChainStatusModel.int(0) == 0)
    }

    @Test func intRejectsBoolsWhichNSNumberWouldMakeInto1() {
        // `reachable: true` read as a block height gives "#1" — a real-looking
        // height built from a boolean. NSNumber bridges Bool, so this needs a
        // guard rather than a cast.
        #expect(ChainStatusModel.int(true) == nil)
        #expect(ChainStatusModel.int(false) == nil)
    }

    @Test func intSurvivesAJSONDecodedBool() throws {
        // The path above is a Swift literal; this is what JSONSerialization
        // actually hands us (__NSCFBoolean, which IS an NSNumber). If the guard
        // only catches the literal, real payloads still slip through.
        let data = Data(#"{"reachable":true,"latestBlock":7}"#.utf8)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(ChainStatusModel.int(obj["reachable"]) == nil)
        #expect(ChainStatusModel.int(obj["latestBlock"]) == 7)
    }

    @Test func truthyIsTriStateSoAbsenceIsDistinguishable() {
        #expect(ChainStatusModel.truthy(true) == true)
        #expect(ChainStatusModel.truthy(false) == false)
        // nil, not false — this is what lets parse() reject an error body.
        #expect(ChainStatusModel.truthy(nil) == nil)
        #expect(ChainStatusModel.truthy("true") == nil)
        #expect(ChainStatusModel.truthy(NSNull()) == nil)
    }

    // ── Cross-client agreement ──────────────────────────────────────────────

    @Test func usdcIsLowercasedForComparisonWithLogTopics() {
        let s = ChainStatusModel.parse(okBody(["usdc": "0xABCDEF0123456789ABCDEF0123456789ABCDEF01"]))
        #expect(s?.usdc == "0xabcdef0123456789abcdef0123456789abcdef01")
    }

    @Test func moneyNoteIsCarriedVerbatimNotReworded() {
        // It's a promise about money; three clients phrasing it three ways is how
        // one of them ends up implying withdrawability.
        let s = ChainStatusModel.parse(okBody())
        #expect(s?.moneyNote.contains("trial credit") == true)
        #expect(s?.moneyNote.contains("not withdrawable as real USDC") == true)
    }

    @Test func spanIsCarriedSoEmptyActivityCanScopeItself() {
        // "No activity" is a bigger claim than we can support; "none in the last
        // 10000 blocks" is the one we can.
        #expect(ChainStatusModel.parse(okBody(["span": 500]))?.span == 500)
    }

    @Test func shortenIsOnlyAFallbackAndPreservesShortInput() {
        #expect(ChainStatusModel.shorten("0x1234") == "0x1234")
        let long = "0x" + String(repeating: "f", count: 40)
        #expect(ChainStatusModel.shorten(long) == "0xffffff…ffff")
    }

    @Test func serverShortFormsWinOverOurFallback() {
        // The server's shortening is the shared one; recomputing would let the
        // clients drift on head/tail lengths.
        let s = ChainStatusModel.parse(okBody(["transfers": [transferRow(["hashShort": "SERVER"])]]))
        #expect(s?.transfers.first?.hashShort == "SERVER")
    }

    @Test func missingShortFormsAreDerivedRatherThanLeftBlank() {
        var r = transferRow()
        r.removeValue(forKey: "hashShort"); r.removeValue(forKey: "fromShort")
        let s = ChainStatusModel.parse(okBody(["transfers": [r]]))
        #expect(s?.transfers.first?.hashShort.contains("…") == true)
        #expect(s?.transfers.first?.fromShort.contains("…") == true)
    }
}

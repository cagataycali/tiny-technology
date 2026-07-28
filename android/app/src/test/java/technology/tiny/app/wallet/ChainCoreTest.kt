package technology.tiny.app.wallet

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ⛓️ ChainCore — the pure brain behind the native chain explorer.
 *
 * The screen closes the user's gap: "we dont see the chain details in the mobile
 * apps." What makes it worth unit-testing rather than eyeballing on a Pixel is
 * that its failure mode isn't a crash — it's a screen that looks perfectly fine
 * and says something FALSE: our own chain's blocks under the wrong id, "no
 * activity" for a node that never answered, or "this deployment has no chain"
 * assembled out of an error page.
 *
 * These mirror ios/Tests/ChainStatusTests.swift case for case, because the whole
 * point of decoding server-side is that the three clients agree.
 */
class ChainCoreTest {

    private fun transferRow(overrides: Map<String, Any?> = emptyMap()): JSONObject {
        val o = JSONObject()
        o.put("hash", "0x" + "a".repeat(64))
        o.put("hashShort", "0xaaaaaa…aaaa")
        o.put("from", "0x" + "1".repeat(40))
        o.put("fromShort", "0x111111…1111")
        o.put("to", "0x" + "2".repeat(40))
        o.put("toShort", "0x222222…2222")
        o.put("blockNumber", 4242)
        o.put("amountMicro", 1_500_000)
        o.put("amount", "$1.50")
        o.put("clamped", false)
        o.put("kind", "transfer")
        for ((k, v) in overrides) if (v == null) o.remove(k) else o.put(k, v)
        return o
    }

    private fun okBody(overrides: Map<String, Any?> = emptyMap()): JSONObject {
        val o = JSONObject()
        o.put("configured", true)
        o.put("chainId", 8470)
        o.put("caip2", "eip155:8470")
        o.put("usdc", "0xabcdef0123456789abcdef0123456789abcdef01")
        o.put("identity", "match")
        o.put("reportedChainId", JSONObject.NULL)
        o.put("latestBlock", 5000)
        o.put("reachable", true)
        o.put(
            "moneyNote",
            "Balances here are trial credit — spendable across tiny, not withdrawable as real USDC.",
        )
        o.put("span", 10000)
        o.put("transfers", org.json.JSONArray().put(transferRow()))
        for ((k, v) in overrides) if (v == null) o.remove(k) else o.put(k, v)
        return o
    }

    // -- The three failures that look identical if you only check for data --

    @Test fun `a healthy chain reports Ok with its identity and activity`() {
        val s = ChainCore.parseStatus(okBody())!!
        assertEquals(ChainCore.Health.Ok, s.health)
        assertEquals(8470L, s.chainId)
        assertEquals("eip155:8470", s.caip2)
        assertEquals(5000L, s.latestBlock)
        assertEquals(1, s.transfers.size)
        assertTrue(s.showsActivity)
    }

    @Test fun `an unconfigured deployment is a state, not a failure`() {
        // Base deployments have no tiny chain. That is permanent and correct, and
        // must not read as "something is broken" — nor render a network card of nulls.
        val body = JSONObject().put("configured", false).put("moneyNote", "note").put("span", 10000)
        val s = ChainCore.parseStatus(body)!!
        assertEquals(ChainCore.Health.NotConfigured, s.health)
        assertNull(s.chainId)
        assertFalse(s.showsActivity)
        assertTrue(ChainCore.headline(s).contains("Base"))
    }

    @Test fun `an unreachable node is not an empty chain`() {
        // The dangerous version of this screen prints "No recent activity" while
        // the node is down: an absence of data presented as a fact about the chain.
        val s = ChainCore.parseStatus(
            okBody(
                mapOf(
                    "identity" to "unknown",
                    "latestBlock" to JSONObject.NULL,
                    "reachable" to false,
                    "transfers" to org.json.JSONArray(),
                ),
            ),
        )!!
        assertEquals(ChainCore.Health.Unreachable, s.health)
        assertNull(s.latestBlock)
        // Activity is HIDDEN, not shown as an empty list.
        assertFalse(s.showsActivity)
        assertTrue(ChainCore.headline(s).contains("connection problem"))
    }

    @Test fun `a mismatch names both ids and claims neither`() {
        // TINY_CHAIN_RPC_URL defaults to 127.0.0.1:8545 — on the host machine that
        // IS the live chain. Config says 8470, the node says 8469: every number
        // real, the heading wrong. Neither value is knowably right, so the UI
        // states the disagreement instead of silently picking a side.
        val s = ChainCore.parseStatus(
            okBody(mapOf("identity" to "mismatch", "reportedChainId" to 8469)),
        )!!
        assertEquals(ChainCore.Health.Mismatch(8470L, 8469L), s.health)
        val h = ChainCore.headline(s)
        assertTrue(h.contains("8470"))
        assertTrue(h.contains("8469"))
        // And it warns that what's below may not belong to this chain at all.
        assertTrue(h.contains("different chain"))
    }

    @Test fun `mismatch outranks unreachable`() {
        // A node that disagrees AND gave no height: the mismatch is the more
        // actionable fact, and hiding it behind "can't reach" would leave a
        // misconfiguration completely invisible.
        val s = ChainCore.parseStatus(
            okBody(
                mapOf(
                    "identity" to "mismatch",
                    "reportedChainId" to 8469,
                    "latestBlock" to JSONObject.NULL,
                    "reachable" to false,
                ),
            ),
        )!!
        assertEquals(ChainCore.Health.Mismatch(8470L, 8469L), s.health)
    }

    @Test fun `a mismatch missing the other number degrades honestly`() {
        // "Mismatch" with no reported id can't be explained to a user — it renders
        // "configured as 8470 but the node reports nothing". Unreachable is at
        // least true: we evidently got no usable answer.
        val s = ChainCore.parseStatus(
            okBody(
                mapOf(
                    "identity" to "mismatch",
                    "reportedChainId" to JSONObject.NULL,
                    "latestBlock" to JSONObject.NULL,
                    "reachable" to false,
                ),
            ),
        )!!
        assertEquals(ChainCore.Health.Unreachable, s.health)
    }

    @Test fun `either unreachable signal alone is enough`() {
        // `reachable:false` with a height present, and a null height with
        // `reachable:true`, both mean unreachable. Trusting only the server's
        // summary would hide a future bug in it; trusting only the height would
        // ignore a server that knows more than we do.
        assertEquals(
            ChainCore.Health.Unreachable,
            ChainCore.parseStatus(okBody(mapOf("reachable" to false)))!!.health,
        )
        assertEquals(
            ChainCore.Health.Unreachable,
            ChainCore.parseStatus(okBody(mapOf("latestBlock" to JSONObject.NULL)))!!.health,
        )
    }

    @Test fun `block zero is reachable because a fresh chain is not a down chain`() {
        val s = ChainCore.parseStatus(okBody(mapOf("latestBlock" to 0)))!!
        assertEquals(ChainCore.Health.Ok, s.health)
        assertEquals(0L, s.latestBlock)
    }

    // -- An error body must never become a claim about the chain --

    @Test fun `a null body is not an unconfigured chain`() {
        // A dropped request must not tell a user on our own chain that this
        // deployment doesn't have one. null lets the screen offer a retry.
        assertNull(ChainCore.parseStatus(null))
    }

    @Test fun `a body without the configured key is refused`() {
        // A 500/502 body ({error:…}, or TinyApi's `_status`-stamped shape) has no
        // `configured` key. Defaulting that to false would render "this deployment
        // has no chain" out of an error page.
        assertNull(ChainCore.parseStatus(JSONObject().put("error", "boom")))
        assertNull(ChainCore.parseStatus(JSONObject()))
        assertNull(ChainCore.parseStatus(JSONObject().put("_status", 502)))
    }

    @Test fun `a non-boolean configured is refused rather than coerced`() {
        // Unlike truthyFlag (which exists for D1's 0/1 columns), this is our own
        // route serving real JSON booleans. Coercing here would let
        // `"configured":"no"` read as a chain that doesn't exist.
        assertNull(ChainCore.parseStatus(JSONObject().put("configured", "yes")))
        assertNull(ChainCore.parseStatus(JSONObject().put("configured", 1)))
    }

    // -- Money is never re-derived on the device --

    @Test fun `the amount is the server's string, not our arithmetic`() {
        val s = ChainCore.parseStatus(okBody())!!
        assertEquals("$1.50", s.transfers[0].amount)
    }

    @Test fun `a clamped transfer is flagged rather than printed as a plain number`() {
        // The server clamps a uint256 wider than a JS-safe integer and says so in
        // the display string; the device must carry the flag so the UI can mark a
        // number nobody can stand behind.
        val s = ChainCore.parseStatus(
            okBody(
                mapOf(
                    "transfers" to org.json.JSONArray().put(
                        transferRow(
                            mapOf(
                                "amountMicro" to 9_007_199_254_740_991L,
                                "amount" to "> \$9e9 (clamped)",
                                "clamped" to true,
                            ),
                        ),
                    ),
                ),
            ),
        )!!
        assertTrue(s.transfers[0].clamped)
        assertTrue(s.transfers[0].amount.contains("clamped"))
    }

    @Test fun `rows with no hash or no amount are dropped, not blanked`() {
        // A blank line in a money list reads as a transfer of nothing.
        val arr = org.json.JSONArray()
            .put(transferRow(mapOf("amount" to null)))
            .put(transferRow(mapOf("hash" to null)))
            .put(transferRow(mapOf("hash" to JSONObject.NULL)))
            .put(transferRow())
        val s = ChainCore.parseStatus(okBody(mapOf("transfers" to arr)))!!
        assertEquals(1, s.transfers.size)
    }

    @Test fun `mints and burns are named by the server`() {
        // On a chain whose supply is ours, "where did this money come from" is the
        // question the explorer exists to answer. The device must not decode 0x0.
        val arr = org.json.JSONArray()
            .put(transferRow(mapOf("kind" to "mint")))
            .put(transferRow(mapOf("kind" to "burn")))
            .put(transferRow(mapOf("kind" to "transfer")))
        val s = ChainCore.parseStatus(okBody(mapOf("transfers" to arr)))!!
        assertEquals(
            listOf("🌱 Issued", "🔥 Burned", "↔️ Transfer"),
            s.transfers.map { it.kindLabel },
        )
    }

    @Test fun `an unknown kind falls back to transfer wording, never empty`() {
        val s = ChainCore.parseStatus(
            okBody(mapOf("transfers" to org.json.JSONArray().put(transferRow(mapOf("kind" to "rebase"))))),
        )!!
        assertEquals("↔️ Transfer", s.transfers[0].kindLabel)
    }

    @Test fun `full hex survives for copy and tap-through`() {
        val t = ChainCore.parseStatus(okBody())!!.transfers[0]
        assertEquals(66, t.hash.length)
        assertEquals(42, t.from.length)
        assertTrue(t.hashShort.length < 20)
    }

    // -- optLongOrNull: absence is not zero (the org.json trap) --

    @Test fun `optLongOrNull refuses to turn absence into zero`() {
        // `optLong(key, 0L)` returns the default for BOTH an absent key and an
        // explicit null, so `latestBlock: null` would render as block 0 — a chain
        // that has never produced a block. Same family as optString's "null".
        val o = JSONObject().put("present", 7).put("nulled", JSONObject.NULL)
        assertEquals(7L, ChainCore.optLongOrNull(o, "present"))
        assertNull(ChainCore.optLongOrNull(o, "nulled"))
        assertNull(ChainCore.optLongOrNull(o, "absent"))
        assertEquals(0L, ChainCore.optLongOrNull(JSONObject().put("z", 0), "z"))
    }

    @Test fun `optLongOrNull rejects booleans, which would print as block one`() {
        // `reachable: true` misread as a height gives "#1" — a real-looking block
        // number built from a flag.
        val o = JSONObject().put("t", true).put("f", false)
        assertNull(ChainCore.optLongOrNull(o, "t"))
        assertNull(ChainCore.optLongOrNull(o, "f"))
    }

    @Test fun `optLongOrNull rejects a numeric string`() {
        // The endpoint sends numbers; accepting strings would hide a wire change
        // behind a value that happens to parse.
        assertNull(ChainCore.optLongOrNull(JSONObject().put("s", "5000"), "s"))
    }

    @Test fun `optLongOrNull survives a real parsed payload`() {
        // The tests above build JSONObjects by hand; this is what the wire gives us.
        val o = JSONObject("""{"reachable":true,"latestBlock":7,"reportedChainId":null}""")
        assertNull(ChainCore.optLongOrNull(o, "reachable"))
        assertEquals(7L, ChainCore.optLongOrNull(o, "latestBlock"))
        assertNull(ChainCore.optLongOrNull(o, "reportedChainId"))
    }

    @Test fun `optBooleanOrNull is tri-state so absence is distinguishable`() {
        val o = JSONObject().put("t", true).put("f", false).put("n", JSONObject.NULL).put("s", "true")
        assertEquals(true, ChainCore.optBooleanOrNull(o, "t"))
        assertEquals(false, ChainCore.optBooleanOrNull(o, "f"))
        // null, not false — this is what lets parseStatus refuse an error body.
        assertNull(ChainCore.optBooleanOrNull(o, "n"))
        assertNull(ChainCore.optBooleanOrNull(o, "absent"))
        assertNull(ChainCore.optBooleanOrNull(o, "s"))
    }

    // -- Cross-client agreement --

    @Test fun `usdc is lowercased for comparison against log topics`() {
        val s = ChainCore.parseStatus(
            okBody(mapOf("usdc" to "0xABCDEF0123456789ABCDEF0123456789ABCDEF01")),
        )!!
        assertEquals("0xabcdef0123456789abcdef0123456789abcdef01", s.usdc)
    }

    @Test fun `the money note is carried verbatim, not reworded`() {
        // It's a promise about money; three clients phrasing it three ways is how
        // one of them ends up implying withdrawability.
        val s = ChainCore.parseStatus(okBody())!!
        assertTrue(s.moneyNote.contains("trial credit"))
        assertTrue(s.moneyNote.contains("not withdrawable as real USDC"))
    }

    @Test fun `empty activity scopes itself to the window actually scanned`() {
        // "No activity" is a bigger claim than the endpoint supports; "none in the
        // last 10000 blocks" is the one it can back.
        assertEquals(500L, ChainCore.parseStatus(okBody(mapOf("span" to 500)))!!.span)
        assertTrue(ChainCore.emptyActivityNote(500L).contains("500 blocks"))
        // And with no span at all it must not invent one.
        assertFalse(ChainCore.emptyActivityNote(null).contains("last"))
    }

    @Test fun `server short forms win over our fallback`() {
        // The server's shortening is the shared one; recomputing would let the
        // clients drift on head and tail lengths.
        val s = ChainCore.parseStatus(
            okBody(mapOf("transfers" to org.json.JSONArray().put(transferRow(mapOf("hashShort" to "SERVER"))))),
        )!!
        assertEquals("SERVER", s.transfers[0].hashShort)
    }

    @Test fun `missing short forms are derived rather than left blank`() {
        val s = ChainCore.parseStatus(
            okBody(
                mapOf(
                    "transfers" to org.json.JSONArray().put(
                        transferRow(mapOf("hashShort" to null, "fromShort" to null)),
                    ),
                ),
            ),
        )!!
        assertTrue(s.transfers[0].hashShort.contains("…"))
        assertTrue(s.transfers[0].fromShort.contains("…"))
    }

    @Test fun `shorten preserves short input and never fabricates an ellipsis`() {
        assertEquals("0x1234", ChainCore.shorten("0x1234"))
        assertEquals("0xffffff…ffff", ChainCore.shorten("0x" + "f".repeat(40)))
    }
}

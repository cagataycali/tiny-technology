package technology.tiny.app.wallet

import org.json.JSONObject
import technology.tiny.app.net.optStringOrNull

/**
 * ⛓️ CHAIN STATUS (Android) — the pure brain behind the native chain explorer.
 *
 * The user's gap, verbatim: "we dont see the chain details in the mobile apps."
 * Web has `/chain`; iOS got its screen last cycle; this is the Android half. What
 * a user sees: which chain this deployment settles on, whether the node agrees
 * with our config, the latest block, the TinyUSDC contract, and recent money
 * movement — beside the wallet whose balance lives on that chain.
 *
 * WHY THERE IS NO JSON-RPC HERE. The obvious build is `eth_getLogs` from the
 * device — our public proxy allows it. That would make Android the fourth
 * implementation of ERC-20 Transfer decoding and the uint256 clamp, each free to
 * drift from web/iOS on its own schedule. `GET /api/chain/status` decodes once on
 * the server and sends flat, already-formatted values; this file only reads them
 * out of a JSONObject. Port of `ios/Tiny/Sources/ChainStatus.swift` and
 * `lib/chain/status.ts`, function for function, so the three clients can't
 * disagree about what the chain is doing.
 *
 * The decisions that live here, each a decision rather than a default:
 *
 *  • THREE UNRELATED FAILURES MUST READ DIFFERENTLY. "This deployment has no
 *    chain" (Base — correct and permanent), "the node didn't answer" (transient),
 *    and "the node says it's a different chain" (misconfiguration) collapse into
 *    the same empty screen if you only check for data. [Health] keeps them apart,
 *    because the sentence a user needs differs in every case — and in one of them
 *    the numbers on screen belong to a DIFFERENT chain than the heading claims.
 *
 *  • MONEY IS NEVER RE-FORMATTED. The server sends `amount` as a display string.
 *    Re-deriving it from `amountMicro` would reintroduce the precision problem
 *    the server already solved for us, and would let Android's rounding drift
 *    from web's. We render the string; the number is only carried.
 *
 *  • A MISSING NUMBER IS NOT A ZERO. `latestBlock` absent means "we don't know";
 *    rendering it as block 0 asserts a genesis-height chain. org.json makes this
 *    trap easy to fall into — `optInt` returns 0 for an absent OR JSON-null key,
 *    exactly like `optString` returns "null" (see JsonFlags) — so reads go
 *    through [optLongOrNull], never `optLong`.
 */
object ChainCore {

    /**
     * Read an optional number, returning null when absent, JSON null, or not a
     * number.
     *
     * ⚠️ `optLong(key, 0L)` cannot express "we don't know": it hands back the
     * default for both an absent key and an explicit `null`, so
     * `"latestBlock": null` would render as block 0 — a chain that has never
     * produced a block. Same family of org.json trap as `optString` returning
     * the literal "null" (JsonFlags.optStringOrNull).
     *
     * A Boolean is REJECTED rather than coerced: `reachable: true` misread as a
     * height would print "#1", a real-looking block number built from a flag.
     */
    fun optLongOrNull(o: JSONObject, key: String): Long? {
        if (!o.has(key) || o.isNull(key)) return null
        return when (val v = o.opt(key)) {
            // REDUNDANT and known to be: `java.lang.Boolean` is not a `Number`, so a
            // boolean already falls to `else`. A mutation test proved deleting this
            // line changes no behaviour. It stays as a DECLARATION — the dangerous
            // version of this function (`is Boolean -> if (v) 1L else 0L`, which is
            // exactly what `optInt` would do) kills two tests, and this branch is
            // what stops someone from "fixing" the else into a coercion. Don't read
            // it as the guard; the guard is `else -> null`.
            is Boolean -> null
            is Number -> v.toLong()
            else -> null
        }
    }

    /**
     * Tri-state boolean: null when the key is absent or unusable.
     *
     * The tri-state is load-bearing, not fussiness — it is what lets [parse] tell
     * an ERROR BODY apart from a genuine `configured: false`. Deliberately does
     * NOT coerce 0/1/"true" like `truthyFlag`: this endpoint is our own route
     * serving real JSON booleans, not a D1 column, and accepting a string here
     * would let `"configured": "no"` read as a chain that doesn't exist.
     */
    fun optBooleanOrNull(o: JSONObject, key: String): Boolean? {
        if (!o.has(key) || o.isNull(key)) return null
        return o.opt(key) as? Boolean
    }

    /**
     * What the screen must SAY, which is not the same as what it has.
     *
     * Ordered by what a user can act on: [Mismatch] outranks [Unreachable]
     * because a mismatch means the visible numbers may belong to another chain,
     * and that is worse than having no numbers at all.
     */
    sealed interface Health {
        /** This deployment settles on Base — there is no tiny chain to show. */
        data object NotConfigured : Health

        /** Configured, and the node's `eth_chainId` contradicts our config. */
        data class Mismatch(val configured: Long, val reported: Long) : Health

        /** Configured, but the node did not answer. */
        data object Unreachable : Health

        data object Ok : Health
    }

    /** One TinyUSDC movement, ready to render — no client-side decoding. */
    data class Transfer(
        val hash: String,
        val hashShort: String,
        val from: String,
        val fromShort: String,
        val to: String,
        val toShort: String,
        val blockNumber: Long?,
        /** The server's display string ("$1.50", "—", "> $9e9 (clamped)"). */
        val amount: String,
        /** True when the on-chain value exceeded what JSON carries losslessly. */
        val clamped: Boolean,
        /** mint | burn | transfer — named by the server so we don't compare to 0x0. */
        val kind: String,
    ) {
        /** Content emoji (TinyDesign: emoji belong to content, not chrome). */
        val kindLabel: String
            get() = when (kind) {
                "mint" -> "🌱 Issued"
                "burn" -> "🔥 Burned"
                else -> "↔️ Transfer"
            }
    }

    data class Status(
        val health: Health,
        val chainId: Long?,
        val caip2: String?,
        val usdc: String?,
        val latestBlock: Long?,
        val moneyNote: String,
        val transfers: List<Transfer>,
        val span: Long?,
    ) {
        /** Whether to show the activity list at all, vs. an explanatory state. */
        val showsActivity: Boolean
            get() = health is Health.Ok || health is Health.Mismatch
    }

    /**
     * Parse `GET /api/chain/status`. Returns null when the body is unusable, and
     * that is NOT the same as an unconfigured chain: a dropped request must never
     * tell a user on our own chain that this deployment doesn't have one. The
     * caller shows a retry instead.
     */
    fun parseStatus(res: JSONObject?): Status? {
        if (res == null) return null
        // An HTTP error body (our own 500 shape, a proxy's JSON, TinyApi's
        // `_status` stamp) has no `configured` key at all. Defaulting a missing
        // key to false would render "this deployment has no chain" out of a 502 —
        // a confident, permanent-sounding claim built from an error page.
        val configured = optBooleanOrNull(res, "configured") ?: return null

        val moneyNote = res.optString("moneyNote", "")
        val span = optLongOrNull(res, "span")

        if (!configured) {
            return Status(
                health = Health.NotConfigured,
                chainId = null, caip2 = null, usdc = null, latestBlock = null,
                moneyNote = moneyNote, transfers = emptyList(), span = span,
            )
        }

        val chainId = optLongOrNull(res, "chainId")
        val latestBlock = optLongOrNull(res, "latestBlock")
        val identity = res.optStringOrNull("identity")
        val reported = optLongOrNull(res, "reportedChainId")

        // Mismatch FIRST, and it requires BOTH numbers: a "mismatch" with no
        // reported id can't be explained to a user ("configured as 8470 but the
        // node reports nothing"), so it degrades to Unreachable — which is at
        // least true, since we evidently got no usable answer.
        val health = if (identity == "mismatch" && chainId != null && reported != null) {
            Health.Mismatch(configured = chainId, reported = reported)
        } else if (latestBlock == null || optBooleanOrNull(res, "reachable") == false) {
            // Either signal alone suffices: `reachable` is the server's summary, a
            // null height is the raw evidence. Trusting only the summary would
            // hide a future bug in it; trusting only the height would ignore a
            // server that knows more than we do.
            Health.Unreachable
        } else {
            Health.Ok
        }

        val raw = res.optJSONArray("transfers")
        val transfers = buildList {
            if (raw != null) {
                for (i in 0 until raw.length()) {
                    val o = raw.optJSONObject(i) ?: continue
                    parseTransfer(o)?.let { add(it) }
                }
            }
        }

        return Status(
            health = health,
            chainId = chainId,
            caip2 = res.optStringOrNull("caip2"),
            usdc = res.optStringOrNull("usdc")?.lowercase(),
            latestBlock = latestBlock,
            moneyNote = moneyNote,
            transfers = transfers,
            span = span,
        )
    }

    private fun parseTransfer(o: JSONObject): Transfer? {
        // A row with no hash can't be copied or tapped through, and a row with no
        // amount string has nothing to show. Dropping it beats rendering a blank
        // line that reads as a transfer of nothing.
        val hash = o.optStringOrNull("hash") ?: return null
        val amount = o.optStringOrNull("amount") ?: return null
        val from = o.optStringOrNull("from") ?: ""
        val to = o.optStringOrNull("to") ?: ""
        return Transfer(
            hash = hash,
            hashShort = o.optStringOrNull("hashShort") ?: shorten(hash),
            from = from,
            fromShort = o.optStringOrNull("fromShort") ?: shorten(from),
            to = to,
            toShort = o.optStringOrNull("toShort") ?: shorten(to),
            blockNumber = optLongOrNull(o, "blockNumber"),
            amount = amount,
            clamped = optBooleanOrNull(o, "clamped") ?: false,
            kind = o.optStringOrNull("kind") ?: "transfer",
        )
    }

    /** 0xabcd…1234 — only a fallback; the server sends these pre-shortened. */
    fun shorten(s: String, head: Int = 6, tail: Int = 4): String =
        if (s.length > head + tail + 2) "${s.take(head + 2)}…${s.takeLast(tail)}" else s

    /** The headline under the chain name, per health state. */
    fun headline(s: Status): String = when (val h = s.health) {
        is Health.NotConfigured ->
            "This deployment settles payments on Base, not on a tiny chain."
        is Health.Mismatch ->
            // Name both numbers and claim neither. Whichever is right, the
            // deployment is misconfigured and only its operator can say which.
            "⚠️ Configured as chain ${h.configured}, but the node reports ${h.reported}. " +
                "The details below may belong to a different chain."
        is Health.Unreachable ->
            "Can't reach the chain right now. This is a connection problem, not an empty chain."
        is Health.Ok ->
            "Every tiny payment settles here, on a chain anyone can run."
    }

    /**
     * The empty-activity line, SCOPED to the window we actually scanned. "No
     * activity" without the span is a bigger claim than the endpoint supports.
     */
    fun emptyActivityNote(span: Long?): String =
        if (span != null) "No TinyUSDC movement in the last $span blocks."
        else "No recent TinyUSDC movement."
}

package technology.tiny.app.wallet

import technology.tiny.app.net.TinyApi

/**
 * Thin async glue between the (upcoming) native Wallet screen and the worker's
 * session-gated wallet endpoints — the repository slice (slice 2) that sits on
 * top of the pure [WalletCore] brain (slice 1).
 *
 * It owns NO logic of its own: it POSTs the bodies WalletCore shapes and folds
 * every reply back through WalletCore's parsers into a typed result. That keeps
 * this class a boring transport wrapper (the screen never touches TinyApi or
 * JSON directly) while every decision — money math, status→result mapping, the
 * request bodies — stays in the unit-tested pure core. Mirrors the wear surface's
 * split (WearChat pure + the callbackFlow that calls it).
 *
 * `null` from a call = the request never reached a parseable reply (transport
 * failure / timeout — TinyApi.getJson/postJson threw and we swallowed it); the
 * screen shows "couldn't reach the wallet service". A non-null result already
 * encodes server-side outcomes, including the non-2xx ones TinyApi stamps with
 * `_status` (425 claim-not-confirmed → Retry, 202 withdraw-broadcast → Pending).
 *
 * Contract (verified against ChatViewModel's slash-command path + iOS WalletView):
 *   GET  /api/wallet                                  → {balance_micro, history[]}
 *   POST /api/wallet {action:deposit_info}            → {configured, deposit_address, …}
 *   POST /api/wallet {action:link_address, address}   → {ok, address}
 *   POST /api/wallet {action:claim, txHash, network?} → {ok, credited_micro, …} | 425{retry}
 *   POST /api/wallet/faucet {}                        → {ok, credited_micro, …} | 429{already_claimed} | 400{ceiling_reached}
 *   POST /api/wallet/withdraw {amount_micro, network?}→ {ok, net_micro, …}      | 202{pending}
 */
class WalletRepository(private val api: TinyApi) {

    /** Balance + recent ledger activity, or null on a transport failure. */
    suspend fun ledger(): WalletCore.Ledger? =
        runCatching { api.getJson("/api/wallet") }.getOrNull()?.let { WalletCore.parseLedger(it) }

    /** Deposit configuration + the user's linked address, or null on a transport failure. */
    suspend fun depositInfo(): WalletCore.DepositInfo? =
        runCatching { api.postJson("/api/wallet", WalletCore.depositInfoBody()) }
            .getOrNull()?.let { WalletCore.parseDepositInfo(it) }

    /** Bind a sending/withdrawal address (re-link overwrites; one address per user). */
    suspend fun linkAddress(address: String): WalletCore.LinkResult? =
        runCatching { api.postJson("/api/wallet", WalletCore.linkAddressBody(address)) }
            .getOrNull()?.let { WalletCore.parseLinkResult(it, address.trim()) }

    /** Credit an on-chain deposit by its tx hash (425 → Retry: seen but unconfirmed). */
    suspend fun claim(txHash: String, network: String? = null): WalletCore.ClaimResult? =
        runCatching { api.postJson("/api/wallet", WalletCore.claimBody(txHash, network)) }
            .getOrNull()?.let { WalletCore.parseClaimResult(it) }

    /**
     * 💧 Claim the in-house faucet's daily drip (self-hosted chain only).
     *
     * POSTs an EMPTY body: the route derives the user from the session and the
     * amount from the reputation-scaled ceiling — there is no client-supplied
     * figure, which is what makes a replayed request harmless.
     *
     * Uses the SETTLE (long-timeout) path, not postJson: the route grants the ledger
     * credit and then mints the backing TinyUSDC, waiting up to ~20s for the receipt.
     * A normal 30s cap is close enough to that to abort a request the server has
     * already credited — the user would see "couldn't reach the faucet" for money
     * they now have, and today's drip ref is spent, so a retry reads 429 and they'd
     * conclude the app lost it. The reply is never ambiguous like a withdrawal's
     * (nothing leaves the user's balance here), so the only cost of waiting is time.
     */
    suspend fun claimFaucet(): WalletCore.FaucetResult? =
        runCatching { api.postJsonSettle("/api/wallet/faucet", org.json.JSONObject()) }
            .getOrNull()?.let { WalletCore.parseFaucetResult(it) }

    /**
     * Pay out to the linked address (202 → Pending: broadcast, not yet confirmed).
     * Uses the long-timeout settle path — the server broadcasts + waits up to ~105s
     * for the receipt; a normal 30s client cap would abort mid-flight and get
     * mislabeled a failure, inviting a double-pay retry (the server's 202 path
     * exists to prevent exactly that). A null return here is a TRUE transport
     * failure (unknown outcome), which the caller must NOT present as retryable.
     */
    suspend fun withdraw(amountMicro: Long, network: String? = null): WalletCore.WithdrawResult? =
        runCatching { api.postJsonSettle("/api/wallet/withdraw", WalletCore.withdrawBody(amountMicro, network)) }
            .getOrNull()?.let { WalletCore.parseWithdrawResult(it) }

    /**
     * The monetize card's state (iOS loadPricedTinys, after 3e34200): whether the
     * user owns ANY tiny, plus the priced subset. Best-effort — fetch owned names
     * from /api/me, then price-check each via {action:pricing}; keep only the
     * priced ones, order preserved. Web + iOS show the card to every owner, so
     * `ownsTinys` (not a non-empty priced list) is what gates it; an owner with
     * nothing priced sees the pricing hint. Returns ownsTinys=false on a transport
     * failure or when nothing is owned — the card then hides entirely.
     */
    suspend fun monetize(): WalletCore.Monetize {
        val me = runCatching { api.getJson("/api/me") }.getOrNull()
            ?: return WalletCore.Monetize(false, emptyList())
        // Price-check EVERY owned tiny (private included, iOS loadPricedTinys): a
        // public priced one lists its URLs, a priced-but-PRIVATE one only steers
        // the empty-state hint to "make it public" (its x402/ERC-8004 URLs 403).
        val owned = WalletCore.myOwnedTinys(me)
        val priced = mutableListOf<WalletCore.PricedTiny>()
        var hasPricedPrivate = false
        for (t in owned) {
            val micro = runCatching { api.postJson("/api/wallet", WalletCore.pricingBody(t.name)) }
                .getOrNull()
                ?.let { WalletCore.parsePriceMicro(it) }
                ?: continue
            if (t.isPrivate) hasPricedPrivate = true
            else priced.add(WalletCore.PricedTiny(t.name, micro))
        }
        return WalletCore.Monetize(
            ownsTinys = owned.isNotEmpty(),
            priced = priced,
            hasPricedPrivate = hasPricedPrivate,
        )
    }

    /**
     * ⛓️ The chain the wallet's money moves on — `GET /api/chain/status`.
     *
     * Unauthenticated by design on the server (it is a blockchain; the same reads
     * are already open through the public RPC proxy), but it rides `getJson` like
     * everything else so it inherits the session header, timeouts and base URL
     * rather than growing a second HTTP path.
     *
     * `null` here means BOTH "the request never landed" and "the body wasn't a
     * status" — [ChainCore.parseStatus] refuses an error body rather than reading
     * a missing `configured` key as "this deployment has no chain". Either way the
     * screen must offer a retry, never a claim about the chain.
     */
    suspend fun chainStatus(): ChainCore.Status? =
        ChainCore.parseStatus(runCatching { api.getJson("/api/chain/status") }.getOrNull())
}

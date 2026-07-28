package technology.tiny.app.wallet

import org.json.JSONObject
import technology.tiny.app.net.optStringOrNull
import technology.tiny.app.net.truthyFlag

/**
 * Pure wallet logic — the money math, ledger labels, on-chain-input validation,
 * and /api/wallet response parsing behind the (upcoming) native Wallet screen.
 *
 * Today the wallet lives only as text slash-commands inside the core ChatViewModel
 * (walletSummary/walletWithdraw/…). iOS has a full navigable WalletView; this is
 * the tested brain for the Android screen that closes that gap. Kept PURE +
 * separate (no Android, no network) so the number formatting, the address/tx
 * regexes, and the wire shapes are unit-tested once and shared by the screen —
 * the same pure-first pattern the wear surface used (WatchCore/WearBriefing).
 *
 * Money is micro-USDC: 1_000_000 = $1.00 (USDC's 6-decimal base unit), matching
 * the worker's D1 ledger, the web, and ChatViewModel.usd.
 */
object WalletCore {
    const val MICRO_PER_USD = 1_000_000L

    /** Withdrawal terms (iOS WalletView copy / worker rules): min $1, flat $0.10
     *  gas fee, $500/day cap. Surfaced so the screen and its tests agree. */
    const val WITHDRAW_MIN_USD = 1.0
    const val WITHDRAW_FEE_MICRO = 100_000L // $0.10
    const val WITHDRAW_DAILY_CAP_USD = 500.0

    private val ADDR_RE = Regex("^0x[0-9a-fA-F]{40}$")
    private val TXHASH_RE = Regex("^0x[0-9a-fA-F]{64}$")

    /**
     * micro-USDC → "$1.23" — byte-identical to ChatViewModel.usd: 2–6 fraction
     * digits, trailing zeros trimmed past cents, always at least 2 decimals
     * (".50" not ".5"), never a dangling dot. Negatives keep the sign ("-$0.40").
     *
     * The integer part is thousand-grouped with a COMMA ("$1,234.57"), matching
     * iOS (NumberFormatter .currency, grouping on) and web (toLocaleString("en-US",
     * {style:"currency"})) — a true 2-vs-1 that only shows past $1,000, so it went
     * unnoticed. The comma is HARD-CODED (US), not from a device locale: like the
     * pinned Locale.US on %.6f (dot decimal), the money format must not track the
     * device — a de/fr/tr phone still shows "$1,234.57", never "$1.234,57". See
     * [NumberFormatLocaleTest] for the standing locale-independence contract.
     */
    fun usd(micro: Long): String {
        val neg = micro < 0
        val dollars = kotlin.math.abs(micro) / 1_000_000.0
        val s = String.format(java.util.Locale.US, "%.6f", dollars).trimEnd('0')
        val trimmed = if (s.endsWith(".")) s + "00" else s
        val dot = trimmed.indexOf('.')
        val padded = if (dot >= 0 && trimmed.length - dot - 1 < 2) trimmed + "0" else trimmed
        return (if (neg) "-$" else "$") + groupInteger(padded)
    }

    /**
     * Insert comma thousand-separators into the integer part of a "1234.567"-style
     * string, leaving the fractional part untouched: "1234.567" → "1,234.567",
     * "1234" → "1,234". Hard-coded comma (US) so the money format is
     * locale-independent (see usd()). Only the integer digits are grouped.
     */
    private fun groupInteger(numeric: String): String {
        val dot = numeric.indexOf('.')
        val intPart = if (dot >= 0) numeric.substring(0, dot) else numeric
        val fracPart = if (dot >= 0) numeric.substring(dot) else ""
        if (intPart.length <= 3) return numeric
        val grouped = StringBuilder()
        val firstGroup = intPart.length % 3
        var idx = 0
        if (firstGroup > 0) { grouped.append(intPart, 0, firstGroup); idx = firstGroup }
        while (idx < intPart.length) {
            if (grouped.isNotEmpty()) grouped.append(',')
            grouped.append(intPart, idx, idx + 3)
            idx += 3
        }
        return grouped.toString() + fracPart
    }

    /**
     * micro-USDC → the up-front per-message PRICE BADGE label ("💵 $X/msg").
     * UNLIKE usd(), this strips ALL trailing zeros with NO min-2 padding, so a
     * $1 tiny reads "$1" (not "$1.00") and a half-cent one "$0.5" (not "$0.50") —
     * byte-identical to iOS priceLabel (Views.swift:2722) and web
     * (Chat.tsx:2669 `.toFixed(6).replace(/0+$/,'').replace(/\.$/,'')`). Only the
     * BADGE strips zeros; the wallet monetize listing keeps min-2 currency fmt, so
     * usd() stays as-is. Empty → "$0" (iOS's guard; the badge is hidden for
     * free tinys anyway). Prices are never negative, so no sign handling.
     */
    fun priceLabel(micro: Long): String {
        var s = String.format(java.util.Locale.US, "%.6f", micro / 1_000_000.0).trimEnd('0')
        if (s.endsWith(".")) s = s.dropLast(1)
        return "$" + s.ifEmpty { "0" }
    }

    /** Ledger-row emoji label (iOS WalletView.kindLabel — emoji belong to content).
     *  Unknown kinds pass through verbatim so a new server kind still renders. */
    fun kindLabel(kind: String): String = when (kind) {
        "deposit" -> "⬇️ Deposit"
        "admin_credit" -> "🎁 Credit"
        "invoke_debit" -> "🤖 Invocation"
        "invoke_credit" -> "💰 Earned"
        "platform_fee" -> "🏛️ Fee"
        "withdrawal" -> "⬆️ Withdrawal"
        "refund" -> "↩️ Refund"
        // First-party x402 payer (pay_x402): the user pays ANOTHER agent →
        // spend_debit; a reversal (no USDC moved) → spend_refund. (spend_reimburse
        // only hits the platform pseudo-account, so a real user never sees it.)
        "spend_debit" -> "🤝 Agent payment"
        "spend_refund" -> "↩️ Payment refund"
        else -> kind
    }

    /** A linked/withdrawal EVM address must be 0x + 40 hex (trimmed). */
    fun isValidAddress(input: String): Boolean = ADDR_RE.matches(input.trim())

    /** A deposit tx hash must be 0x + 64 hex (trimmed). */
    fun isValidTxHash(input: String): Boolean = TXHASH_RE.matches(input.trim())

    /**
     * Parse a withdrawal amount string to micro-USDC, or null if it isn't a valid
     * withdrawal (iOS withdrawAmount / web app/wallet/page.tsx:209): must parse as
     * a FINITE number ≥ the $1 minimum. Rounds to the nearest micro (Math.round,
     * matching ChatViewModel.walletWithdraw).
     *
     * The isFinite guard is the shared cross-client contract — web checks
     * `!Number.isFinite(amount)` and iOS `v.isFinite` before the min. Kotlin's
     * toDoubleOrNull ACCEPTS "NaN"/"Infinity", and `NaN < WITHDRAW_MIN_USD` is
     * false, so without it a NaN slipped past the min-guard and a huge finite
     * entry (e.g. a keypad "10000000000000") overflowed `v * MICRO_PER_USD` in
     * Math.round to Long.MAX_VALUE — a garbage micro amount driving the confirm
     * dialog + POST body on a money screen. (No crash here, unlike iOS's Int()
     * trap, but the number still lied.) Fail closed to null so the Withdraw
     * button stays disabled on a non-finite entry.
     *
     * COMMA-DECIMAL parity (the last client on this): the withdraw field is a
     * KeyboardType.Decimal input, which renders the DEVICE LOCALE's decimal
     * separator — a COMMA on de/fr/tr keypads. Bare toDoubleOrNull only accepts
     * a dot, so "10,50" returned null and the Withdraw button stayed PERMANENTLY
     * disabled — comma-locale users could never withdraw their USDC. Web
     * (parseDecimalInput → `.replace(',', '.')`, lib/utils.ts) and iOS
     * (`Double(raw) ?? Double(raw.replacingOccurrences(of: ",", with: "."))`,
     * Wallet.swift:203-204) both fall back to a comma→dot swap; mirror that
     * chain here: dot-parse first (handles "10.50"), else swap a decimal comma
     * to a dot (handles "10,50"). A narrow decimal money field never receives
     * grouped-thousands input, so a comma is always the decimal mark.
     */
    fun parseWithdrawMicro(input: String): Long? {
        val raw = input.trim()
        val v = raw.toDoubleOrNull() ?: raw.replace(',', '.').toDoubleOrNull() ?: return null
        if (!v.isFinite() || v < WITHDRAW_MIN_USD) return null
        return Math.round(v * MICRO_PER_USD)
    }

    /**
     * The withdraw-confirmation body — states the exact split so the pre-commit
     * number can't contradict the post-commit success toast on an irreversible
     * money action (iOS Wallet.swift:335 / web wallet/page.tsx:197 parity, after
     * 640f771). The worker debits the full [micro] and sends net = micro − flat
     * $0.10 gas on-chain; the confirm must say BOTH numbers, not imply the gross
     * arrives. Net floors at $0 (a $1.00 min withdrawal nets $0.90, never negative).
     *
     * Formats through usd() (the 2–6dp MONEY formatter), NOT a fixed %.2f: the
     * amount field is free-text decimal (no 2dp step clamp), so a typed "12.3456"
     * quantizes to 12_345_600 micro — the full precision that ACTUALLY leaves the
     * balance and that the success toast (Wallet.kt:151) reports via usd(). A %.2f
     * confirm ("$12.35") would contradict what left, on an irreversible action —
     * the exact drift f99933e fixed on web (usd()) + iOS (usd()). The Long here is
     * the SAME value fed to the payload (parseWithdrawMicro → onWithdraw), so
     * confirm, payload, and toast can't diverge.
     */
    fun withdrawConfirmText(micro: Long, network: String): String {
        val net = maxOf(0L, micro - WITHDRAW_FEE_MICRO)
        // networkShort(), not a two-way `if (network == "base")`: that ternary called
        // EVERY non-mainnet network "Base Sepolia", so a `tiny` withdrawal was
        // confirmed as happening on a chain it has nothing to do with — on the one
        // irreversible action in the app. Web fixed the identical ternary in c16
        // (wallet/page.tsx:369).
        val netLabel = networkShort(asNetwork(network))
        return "${usd(micro)} leaves your balance on $netLabel. After a flat \$0.10 gas fee, " +
            "${usd(net)} USDC arrives at your linked address. Instant and can't be undone."
    }

    /** Balance + recent activity from GET /api/wallet: {balance_micro, history:[…]}. */
    data class Ledger(val balanceMicro: Long, val entries: List<Entry>)

    /** One ledger row (web LedgerEntry / iOS WalletEntry shape). */
    data class Entry(val deltaMicro: Long, val kind: String, val ref: String, val created: Double?)

    fun parseLedger(res: JSONObject): Ledger {
        val balance = res.optLong("balance_micro", 0L)
        val raw = res.optJSONArray("history")
        val entries = buildList {
            if (raw != null) {
                for (i in 0 until raw.length()) {
                    val o = raw.optJSONObject(i) ?: continue
                    add(
                        Entry(
                            deltaMicro = o.optLong("delta_micro", 0L),
                            kind = o.optString("kind", "?"),
                            ref = o.optString("ref", ""),
                            // created is optional (absent → null, not 0.0).
                            created = if (o.has("created") && !o.isNull("created")) o.optDouble("created") else null,
                        ),
                    )
                }
            }
        }
        return Ledger(balance, entries)
    }

    /** Deposit configuration + the user's linked address (POST action=deposit_info). */
    data class DepositInfo(
        val configured: Boolean,
        val depositAddress: String?,
        val chain: String?,
        val linkedAddress: String?,
        /** The in-house faucet block, or null when the deployment has none. */
        val faucet: FaucetInfo? = null,
    )

    fun parseDepositInfo(res: JSONObject): DepositInfo = DepositInfo(
        configured = res.optBoolean("configured", false),
        // optStringOrNull, not optString().ifEmpty{null}: a server-side JSON null
        // for any of these decodes to the literal "null" under org.json and would
        // render verbatim ("✓ null" on the linked-address line). See JsonFlags.
        depositAddress = res.optStringOrNull("deposit_address"),
        chain = res.optStringOrNull("default_network"),
        linkedAddress = res.optStringOrNull("linked_address"),
        faucet = parseFaucetInfo(res.optJSONObject("faucet")),
    )

    // -- 💧 TOP-UP: what to offer a user with no money, and how to name their chain --
    // The Android half of the self-hosted chain's client work (web: lib/x402/top-up.ts,
    // ported function-for-function so the three clients can't drift). Android used to
    // render Coinbase + bridge.base.org on mainnet and faucet.circle.com on Sepolia —
    // three REAL-MONEY rails that are actively misleading on a chain we own: nobody
    // sells TinyUSDC, and faucet.circle.com hands out SEPOLIA USDC, so a user who
    // follows any of them spends real money (or real time) and arrives holding a token
    // this deployment cannot credit. A stale on-ramp on our own chain is a trap, not a
    // dead link. The in-house faucet (POST /api/wallet/faucet) is the only source, and
    // the server already says whether it exists (deposit_info.faucet.available).

    /** `deposit_info.faucet` (worker PayDepositInfoCall) — absent ⟺ no faucet at all. */
    data class FaucetInfo(
        val available: Boolean,
        val network: String? = null,
        val dripMicro: Long = 0L,
        val capMicro: Long = 0L,
        val grantedMicro: Long = 0L,
        val remainingMicro: Long = 0L,
        val claimedToday: Boolean = false,
        val nextDripInSeconds: Long = 0L,
        val reputation: Int = 0,
        val microPerPoint: Long = 0L,
        val maxMicro: Long = 0L,
    )

    /**
     * Parse the faucet block. A missing object is null (no faucet), and
     * `{available:false}` parses to available=false rather than null so the two
     * server answers stay distinguishable — every consumer below fails closed on
     * both, but the honest disabled copy differs from "no card at all".
     */
    fun parseFaucetInfo(o: JSONObject?): FaucetInfo? {
        if (o == null) return null
        return FaucetInfo(
            // truthyFlag: the worker sends a real JSON boolean, but a D1-ish 0/1
            // would silently read false under optBoolean (see JsonFlags) — and this
            // one flag gates the entire top-up card.
            available = o.truthyFlag("available", false),
            network = o.optStringOrNull("network"),
            dripMicro = o.optLong("drip_micro", 0L),
            capMicro = o.optLong("cap_micro", 0L),
            grantedMicro = o.optLong("granted_micro", 0L),
            // NOT defaulted to the cap: a missing remaining_micro must read as NO
            // credit (fail closed), or the claim button enables and 400s on press.
            remainingMicro = o.optLong("remaining_micro", 0L),
            claimedToday = o.truthyFlag("claimed_today", false),
            nextDripInSeconds = o.optLong("next_drip_in_seconds", 0L),
            reputation = o.optInt("reputation", 0),
            microPerPoint = o.optLong("micro_per_point", 0L),
            maxMicro = o.optLong("max_micro", 0L),
        )
    }

    /**
     * Which top-up route this deployment offers. Exactly one, always — mutually
     * exclusive ON PURPOSE. A fiat card button "just in case" beside the faucet, on
     * a chain where the card can't deliver, is the exact bug this deletes.
     *
     *  - [FAUCET]  — we own the chain, so we issue the credit.
     *  - [TESTNET] — Sepolia: the public faucet is the one true source; fiat
     *                on-ramps deliver MAINNET USDC the claim scanner can't see.
     *  - [FIAT]    — real Base: cards/bridges work and a faucet would be nonsense.
     */
    enum class TopUpRoute { FAUCET, TESTNET, FIAT }

    /** Canonical network id for the three the payments stack settles on. */
    const val NET_BASE = "base"
    const val NET_SEPOLIA = "base-sepolia"
    const val NET_TINY = "tiny"

    /**
     * Coerce an unknown network string to one of the three, defaulting to the
     * SAFEST reading (real Base): a client that guesses "trial" for an unknown
     * name would label real money as un-withdrawable trial credit.
     */
    fun asNetwork(raw: String?): String {
        val n = raw?.trim()?.lowercase() ?: return NET_BASE
        return if (n == NET_TINY || n == NET_SEPOLIA) n else NET_BASE
    }

    /**
     * Pick the route.
     *
     * Keyed on `faucet.available` — the server's own answer — and NOT on
     * `chain == "tiny"`, because those two legitimately disagree: the faucet needs a
     * mintable token AND a deployer key, so a half-configured tiny-chain deployment
     * reports `tiny` with no faucet. Trusting the network name there renders a claim
     * button that 424s on every press. Fall back to what the network can actually do.
     */
    fun topUpRoute(info: DepositInfo?): TopUpRoute = when {
        info?.faucet?.available == true -> TopUpRoute.FAUCET
        asNetwork(info?.chain) == NET_SEPOLIA -> TopUpRoute.TESTNET
        else -> TopUpRoute.FIAT
    }

    /**
     * micro-USDC → "$1.2" for a BUTTON — no min-2 padding, so a whole dollar reads
     * "$1" not "$1.00". Same rule as [priceLabel] (and web's usdShort); kept as its
     * own name because the two call sites are different products and web has both.
     */
    fun usdShort(micro: Long): String = priceLabel(micro)

    /** Human "2h 5m" until the next drip. Empty when it isn't in the future, so the
     *  caller can fall back to "after midnight UTC" rather than print "in 0m". */
    fun untilNextDrip(seconds: Long): String {
        if (seconds <= 0) return ""
        val h = seconds / 3600
        val m = (seconds % 3600) / 60
        if (h > 0 && m > 0) return "${h}h ${m}m"
        if (h > 0) return "${h}h"
        // A sub-minute wait rounds UP: "in 0m" reads as a bug, and the drip really
        // is imminent.
        return "${maxOf(1L, m)}m"
    }

    /** The faucet button: whether it's live, what it says, and why not. */
    data class FaucetCta(val enabled: Boolean, val label: String, val reason: String)

    /**
     * Three states, and the two REFUSALS must never collapse into one sentence —
     * they're the client mirror of the worker's deliberately-distinct 429
     * (already_claimed) vs 400 (ceiling_reached). "Wait until UTC midnight" and
     * "you've spent your lifetime ceiling, get followed to raise it" are opposite
     * instructions; a shared "try again later" sends a permanently-capped user back
     * to the button every day, and a user who just claimed off to farm reputation
     * they don't need.
     *
     * Ceiling is checked BEFORE the daily claim: someone fully capped AND claimed
     * today is capped — "come back tomorrow" would be a lie, because tomorrow's
     * drip is refused too.
     */
    fun faucetCta(f: FaucetInfo?): FaucetCta {
        if (f?.available != true) {
            return FaucetCta(false, "Top-up unavailable", "This deployment has no in-house faucet.")
        }
        val remaining = maxOf(0L, f.remainingMicro)
        if (remaining <= 0L) {
            return FaucetCta(
                false, "Lifetime credit used",
                // The actionable half: the ceiling is reputation-scaled, so it GROWS.
                "You've used all ${usdShort(f.capMicro)} of your trial credit. Get followed to raise the ceiling, or deposit real USDC on Base.",
            )
        }
        if (f.claimedToday) {
            val wait = untilNextDrip(f.nextDripInSeconds)
            return FaucetCta(
                false, "Claimed today",
                "Next top-up ${if (wait.isNotEmpty()) "in $wait" else "after midnight UTC"} — ${usdShort(remaining)} still left on your ceiling.",
            )
        }
        // The worker credits MIN(drip, remaining), so the button must promise what
        // will actually land — a button reading "$1" that pays $0.30 is a broken
        // promise made by the client, not the server.
        val credit = minOf(maxOf(0L, f.dripMicro), remaining)
        return FaucetCta(true, "Claim ${usdShort(credit)} free credit", "")
    }

    /**
     * The one-line explanation of the ceiling. Separate from [faucetCta] because
     * it's shown in ALL faucet states — a user who just claimed still needs to know
     * why their ceiling is what it is, and that being followed is what raises it.
     */
    fun ceilingNote(f: FaucetInfo?): String {
        if (f?.available != true) return ""
        val rep = f.reputation
        val per = usdShort(f.microPerPoint)
        val earned = if (rep > 0)
            " Your $rep reputation ${if (rep == 1) "point adds" else "points add"} $per each"
        else
            " Earn reputation ($per per point) by getting followed"
        return "${usdShort(f.grantedMicro)} of ${usdShort(f.capMicro)} used.$earned, up to ${usdShort(f.maxMicro)}."
    }

    /**
     * Label for a network in the user's terms. `trial` is the load-bearing word:
     * both `tiny` and `base-sepolia` credit balance that's spendable inside tiny but
     * NOT withdrawable as real money, and a user who doesn't know that before they
     * earn on it will feel defrauded when the withdrawal is refused.
     */
    fun networkLabel(network: String): String = when (asNetwork(network)) {
        NET_TINY -> "Tiny Chain (trial credit)"
        NET_SEPOLIA -> "Base Sepolia (trial credit)"
        else -> "Base (real USDC)"
    }

    /**
     * Conservative display mapper for a quote/receipt `network` field: EXACT
     * known names get the money-kind label ("Tiny Chain (trial credit)"),
     * anything else renders verbatim — NOT through asNetwork(), whose
     * default-to-base would label an unknown chain "real USDC", the one
     * direction an approval card must never err.
     */
    fun payNetworkDisplay(raw: String?): String? {
        val n = raw?.trim()?.ifEmpty { null } ?: return null
        return if (n == NET_BASE || n == NET_SEPOLIA || n == NET_TINY) networkLabel(n) else n
    }

    /** Short form for a tight picker chip or a confirm dialog. */
    fun networkShort(network: String): String = when (asNetwork(network)) {
        NET_TINY -> "Tiny Chain"
        NET_SEPOLIA -> "Sepolia"
        else -> "Base"
    }

    /** True when balance earned on this network can leave as real money. */
    fun isRealMoney(network: String): Boolean = asNetwork(network) == NET_BASE

    // ─────────────────────────────────────────────────────────────────────────
    // 🔗 Explorer links — what to CALL the explorer a receipt points at, and
    // which URLs are safe to open. Port of `lib/x402/explorer.ts` (web) and
    // `Explorer.swift` (iOS).
    //
    // The server already derives every explorer URL from the network WE signed
    // for and omits it when the chain has no explorer, so the URL is correct.
    // The LABEL wasn't: PayReceiptCard and Wallet both rendered "↗ View on
    // BaseScan" with `onClickLabel = "open the transaction on BaseScan"`, so on a
    // self-hosted chain the link went to the deployment's own Blockscout while
    // both the text AND the TalkBack announcement named Base's explorer.
    //
    // The name comes from the URL's HOST, not the payment's network field: that
    // field is nullable at both sites, and `tiny` with a Blockscout and `tiny`
    // with no explorer are the same network — only the URL tells them apart.
    // ─────────────────────────────────────────────────────────────────────────

    /** Longest host we'll put in a caption. A unicode host arrives punycoded
     *  (`xn--…`), which is the SAFE form to show — decoding would render a
     *  homograph of a domain the user isn't visiting — but a 200-char one wrecks
     *  the card, so an unshowable host degrades to generic wording. */
    private const val MAX_HOST = 40

    /**
     * The URL a client may actually open, or null — the security gate.
     *
     * http/https with a host, or nothing. Both call sites passed the server's
     * string straight to `uriHandler.openUri`, which resolves an intent for
     * whatever scheme it's given. First-party today, so latent rather than live —
     * but the label work parses the URL anyway.
     */
    fun explorerHref(raw: String?): String? {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null
        val uri = try { java.net.URI(s) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "https" && scheme != "http") return null
        // `authority`, not `host`: java.net.URI returns a null HOST for any
        // authority it can't parse as server-based — including a perfectly
        // reachable `my_explorer.lan` (underscores are illegal in hostnames but
        // routine on an internal network). Gating on host would drop the proof
        // link on Android while web and iOS still showed it.
        if (hostPort(uri).isEmpty()) return null
        return s
    }

    /** host[:port] from a URI's authority, userinfo STRIPPED.
     *
     *  The strip is the security-relevant line: `https://basescan.org@evil.tld/tx/…`
     *  has authority "basescan.org@evil.tld" and goes to evil.tld. Naming it
     *  BaseScan would turn our own label into the spoof. */
    private fun hostPort(uri: java.net.URI): String =
        (uri.authority ?: "").substringAfterLast('@')

    /** Display name for the explorer — "BaseScan", else its host, else "" (a link
     *  we can't name, which is the generic-wording case, NOT the no-link case). */
    fun explorerName(raw: String?): String {
        val href = explorerHref(raw) ?: return ""
        val uri = java.net.URI(href)
        val host = hostPort(uri).lowercase().removePrefix("www.")
        // Suffix match on a DOT boundary, never `contains`: `basescan.org.evil.tld`
        // and `notbasescan.org` are other people's sites, and calling either one
        // BaseScan is what makes a wrong label dangerous rather than sloppy.
        if (host == "basescan.org" || host.endsWith(".basescan.org")) return "BaseScan"
        // No port arithmetic here: `host` came from the AUTHORITY, which already
        // carries ":4000" when there is one — and the port belongs in the label,
        // since "View on 127.0.0.1" would name a different service than the link
        // opens. (Re-appending uri.port would read "127.0.0.1:4000:4000", and
        // `uri.port` is -1 for exactly the non-server authorities this avoids.)
        if (host.length > MAX_HOST) return ""
        if (!host.all { it.code < 128 && (it.isLowerCase() || it.isDigit() || it == '.' || it == '-' || it == ':' || it == '_') }) return ""
        return host
    }

    /** The link text, WITHOUT the "↗" — each client adds its own glyph (web "→",
     *  iOS an SF Symbol), so baking one in would double up. */
    fun explorerLinkLabel(raw: String?): String {
        val n = explorerName(raw)
        return if (n.isEmpty()) "View transaction" else "View on $n"
    }

    /** TalkBack `onClickLabel` phrasing, as a verb phrase. A user who can't see
     *  the URL has no way to catch a wrong label, so this one matters most. */
    fun explorerOpenHint(raw: String?): String {
        val n = explorerName(raw)
        return if (n.isEmpty()) "open the transaction in the block explorer" else "open the transaction on $n"
    }

    /**
     * Which networks a picker should show: only ever the deployment's OWN network
     * plus real Base, never all three. A deployment configures ONE chain; offering
     * the other trial network lets a user paste a tx hash the receipt scanner can't
     * see (the permanent "no matching USDC transfer" 400 this repo already fixed
     * once by seeding the selector). Base stays listed on a trial deployment because
     * a real deposit is still the documented way to get withdrawable balance.
     */
    fun networkChoices(defaultNetwork: String?): List<String> {
        val n = asNetwork(defaultNetwork)
        return if (n == NET_BASE) listOf(NET_BASE) else listOf(n, NET_BASE)
    }

    /** The top-up card's blurb, one per route (web parity). */
    fun topUpBlurb(info: DepositInfo?): String = when (topUpRoute(info)) {
        TopUpRoute.FAUCET ->
            "This deployment runs its own chain, so credit comes straight from us — no card, no exchange, no wallet needed. It's spendable on any tiny; it isn't withdrawable as real USDC."
        TopUpRoute.TESTNET ->
            "This deployment runs on Base Sepolia — grab free testnet USDC, then claim it below to try risk-free. (Testnet credits aren't withdrawable as real USDC.)"
        TopUpRoute.FIAT ->
            "Buy or bridge USDC on Base into your linked address, then claim it below."
    }

    /** A "Get USDC" source pill — a label + the URL it opens. `faucet` flags the
     *  try-risk-free testnet source so the card can badge it (iOS 🧪 / Science glyph). */
    data class UsdcSource(val label: String, val url: String, val faucet: Boolean = false)

    /**
     * The EXTERNAL deposit sources for a deployment — only ever reached on the
     * TESTNET and FIAT routes. On the FAUCET route this is deliberately EMPTY: the
     * card renders a claim button instead, and there is no external rail that can
     * deliver a token only this deployment mints.
     *
     * On base-sepolia the fiat on-ramps + the Base bridge deliver MAINNET USDC the
     * Sepolia claim scanner can't credit, so the public faucet is the one true
     * source; on real Base the reverse — the public faucet hands out un-claimable
     * test USDC, so it's noise.
     */
    fun usdcSources(info: DepositInfo?): List<UsdcSource> = when (topUpRoute(info)) {
        TopUpRoute.FAUCET -> emptyList()
        TopUpRoute.TESTNET ->
            listOf(UsdcSource("Get free testnet USDC", "https://faucet.circle.com", faucet = true))
        TopUpRoute.FIAT -> listOf(
            UsdcSource("Coinbase", "https://www.coinbase.com/price/usdc"),
            UsdcSource("Bridge to Base", "https://bridge.base.org"),
        )
    }

    /** The x402 pay endpoint + ERC-8004 registration URL for a priced tiny (iOS
     *  PricedTiny). Only meaningful when the tiny's price_micro > 0. */
    fun x402Url(tiny: String): String = "https://tiny.technology/api/x402/chat/$tiny"
    fun registrationUrl(tiny: String): String = "https://tiny.technology/api/erc8004/registration/$tiny"

    /** An owned tiny with a per-message price > 0 — the monetize card surfaces its
     *  x402 + ERC-8004 URLs so agents can pay it (iOS Wallet.swift PricedTiny). */
    data class PricedTiny(val name: String, val priceMicro: Long) {
        val x402Url get() = x402Url(name)
        val registrationUrl get() = registrationUrl(name)
    }

    /**
     * The monetize card's state: whether the user owns ANY tiny, the priced-and-
     * PUBLIC subset (only these get their URLs listed), and whether a priced tiny
     * is PRIVATE. Web + iOS (after 3e34200) show the card to EVERY owner — an owner
     * with nothing publicly priced still sees it, with a hint that pricing is what
     * unlocks the agent-payable x402 endpoint + on-chain ERC-8004 URL. `ownsTinys`
     * gates the card; an empty `priced` under a true `ownsTinys` renders the hint
     * branch. `hasPricedPrivate` steers that hint: an owner whose ONLY priced tiny
     * is private is told to "make it public" (its URLs 403), not to "price a tiny"
     * they already priced (web pricedPrivate / iOS hasPricedPrivate).
     */
    data class Monetize(
        val ownsTinys: Boolean,
        val priced: List<PricedTiny>,
        val hasPricedPrivate: Boolean = false,
    )

    /** An owned tiny with its privacy flag. The monetize card price-checks ALL of
     *  them: a public priced one lists its x402/ERC-8004 URLs, a private priced one
     *  only steers the empty-state hint (its URLs 403). (iOS loadPricedTinys.) */
    data class OwnedTiny(val name: String, val isPrivate: Boolean)

    /** All owned tinys (name + private flag) from GET /api/me (tinys:[{name,private}]),
     *  in order. Unlike [myTinyNames] this KEEPS private ones so the caller can
     *  detect a priced-but-private tiny and steer the hint (web pricedPrivate). */
    fun myOwnedTinys(me: JSONObject): List<OwnedTiny> {
        val arr = me.optJSONArray("tinys") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val t = arr.optJSONObject(i) ?: return@mapNotNull null
            val name = t.optString("name").trim().ifEmpty { return@mapNotNull null }
            // `private` arrives as a D1 integer 0/1 here too; coerce truthily so a
            // `private:1` row reads private (optBoolean would misread it as public
            // and leak the agent-payable URLs myTinyNames filters on). Shared with
            // fetchAccent/x402Hint — see JsonFlags.truthyFlag. Absent → false (fail-open).
            OwnedTiny(name, t.truthyFlag("private", default = false))
        }
    }

    /** Public owned tiny names, in order — the names whose x402/ERC-8004 URLs are
     *  safe to advertise. PRIVATE tinys are skipped: they 403 on both /api/x402/chat
     *  and their ERC-8004 registration file (by design, the persona is masked), so
     *  their "agent-payable" URLs are dead-on-arrival and must never be advertised. */
    fun myTinyNames(me: JSONObject): List<String> =
        myOwnedTinys(me).filterNot { it.isPrivate }.map { it.name }

    /** POST /api/wallet {action:pricing, resource:"tiny:<name>"} — public price lookup. */
    fun pricingBody(tiny: String): JSONObject =
        JSONObject().put("action", "pricing").put("resource", "tiny:${tiny.trim()}")

    /** The price a pricing reply reports, or null when the tiny is free/unpriced
     *  (price_micro absent or ≤ 0). Only priced tinys reach the monetize card. */
    fun parsePriceMicro(res: JSONObject): Long? =
        res.optLong("price_micro", 0L).takeIf { it > 0L }

    // -- x402 payment receipt (pay_x402 tool result → a plain receipt card) --

    /** 0xabcd…1234 — enough hex to recognize a payee without a wall of it
     *  (web PayReceipt.shortAddr). Short/blank input passes through as-is, and
     *  so does a non-hex payee: a P2P send's payee is a @login, and truncating
     *  it would hide exactly the identity the approval is about. */
    fun shortAddr(a: String?): String {
        val s = a?.trim().orEmpty()
        return if (s.length < 12 || !s.startsWith("0x")) s else "${s.take(6)}…${s.takeLast(4)}"
    }

    /**
     * A parsed pay_x402 tool result (web PayReceipt PayResult). The pay_x402 tool
     * spends the user's REAL USDC to pay another agent over x402 — the generic
     * tool card buried that in a collapsed JSON blob, so this lifts the fields the
     * receipt shows. `paid` is the success gate (server returns ok:true only when
     * the spend settled); a ran-but-didn't-pay result (payment_required / error)
     * is a failure, distinct from still-streaming (a null result).
     */
    data class PayReceipt(
        val paid: Boolean,
        val paidMicro: Long,
        val network: String?,
        val payee: String?,
        val error: String?,
        /** P2P send (make_payment) — steers the verb ("Sent" vs "Paid") only. */
        val transfer: Boolean = false,
    ) {
        /** "$0.50 to 0xabcd…1234 on base" — the human line, sign never applies (a
         *  spend is always positive). Blank pieces are dropped. */
        val summary: String get() = buildString {
            append(if (transfer) "Sent " else "Paid ").append(usd(paidMicro))
            payee?.trim()?.ifEmpty { null }?.let { append(" to ").append(shortAddr(it)) }
            payNetworkDisplay(network)?.let { append(" on ").append(it) }
        }
    }

    /** Parse a pay_x402 tool-result JSON body into a receipt. Returns null when the
     *  body isn't the pay shape at all (so the caller can fall back to the generic
     *  card). A ran-but-failed result still parses (paid=false + error). */
    fun parsePayReceipt(res: JSONObject): PayReceipt {
        val ok = res.optBoolean("ok", false)
        val err = res.optString("error").takeIf { it.isNotEmpty() }
            ?: if (res.optBoolean("payment_required", false)) "Payment required." else null
        return PayReceipt(
            paid = ok,
            paidMicro = res.optLong("paid_micro", 0L),
            network = res.optString("network").takeIf { it.isNotEmpty() },
            payee = res.optString("payee").takeIf { it.isNotEmpty() },
            error = if (ok) null else (err ?: "The payment could not be completed."),
        )
    }

    // -- x402 quote → approval gate (CONFIRM-EVERY-PAYMENT) --
    //
    // pay_x402 does NOT move money. It returns a signed QUOTE (requires_confirmation)
    // and the user's Approve tap is the SOLE money-moving path: PUT /api/x402/pay with
    // the quote. The agent can't press that button, so a runaway agent can never drain
    // the wallet unattended. Web PayReceipt.tsx / iOS PayQuoteCard render this gate;
    // Android previously mis-read a quote (ok:false) as "Payment not sent". These pure
    // pieces classify the tool result and the PUT reply so the card is a tested brain.

    /**
     * A signed quote awaiting approval (web PayResult / iOS PayQuoteItem). `quote` is
     * an opaque token passed back verbatim to the execute route; `message` is the
     * quoted message whose hash the server re-checks. `expiresAt` is unix SECONDS.
     */
    data class PayQuote(
        val quote: String,
        val priceMicro: Long,
        val network: String?,
        val payee: String?,
        val expiresAt: Double?,
        val message: String,
        /**
         * The service URL this quote was minted for. Carried so the card can re-mint
         * a FRESH quote in place (POST /api/x402/pay, moves no money) on the recoverable
         * dead-ends — expired (410) or terms_changed (409) — instead of forcing a whole
         * new agent turn. The pay_x402 tool result echoes it (chat/route.ts:1323); a
         * free-target result or an older transcript decodes null. Web parity:
         * PayReceipt.reQuote() off `active.url`; iOS PayQuoteItem.url.
         */
        val url: String? = null,
    ) {
        /** P2P send (make_payment): the url field carries the `transfer:@login`
         *  sentinel — same re-quote plumbing, different copy. Web PayReceipt
         *  isTransfer / iOS PayQuoteCard.isTransfer parity. */
        val isTransfer: Boolean get() = url?.startsWith("transfer:") == true
    }

    /**
     * Parse a pay_x402 tool result into a [PayQuote], or null when it isn't a quote
     * awaiting approval (web `isQuote = requires_confirmation && quote`). A settled
     * receipt, a free "no payment needed" 200, and a tool failure all return null so
     * the caller falls through to the terminal states.
     */
    fun parsePayQuote(res: JSONObject): PayQuote? {
        if (!res.optBoolean("requires_confirmation", false)) return null
        val quote = res.optString("quote").takeIf { it.isNotEmpty() } ?: return null
        return PayQuote(
            quote = quote,
            priceMicro = res.optLong("price_micro", 0L),
            network = res.optString("network").takeIf { it.isNotEmpty() },
            payee = res.optString("payee").takeIf { it.isNotEmpty() },
            expiresAt = if (res.has("expires_at") && !res.isNull("expires_at")) res.optDouble("expires_at") else null,
            message = res.optString("message"),
            url = res.optString("url").takeIf { it.isNotEmpty() },
        )
    }

    /** True when a quote's TTL has passed (web `expires_at*1000 < Date.now()`). No
     *  expiry set → never expired. [nowMs] is injected so this stays pure/testable. */
    fun isQuoteExpired(expiresAt: Double?, nowMs: Long): Boolean {
        val e = expiresAt ?: return false
        return e * 1000.0 < nowMs.toDouble()
    }

    /** The "Approve payment?" body — states amount, payee, network, and that it only
     *  happens on the tap (web/iOS approveDescription verbatim). [transfer] switches
     *  to the P2P wording (a send between wallets, no x402 leg to name). */
    fun approveDescription(priceMicro: Long, payee: String?, network: String?, transfer: Boolean = false): String = buildString {
        append(if (transfer) "This will send " else "This will pay ").append(usd(priceMicro))
        payee?.trim()?.ifEmpty { null }?.let { append(" to ").append(shortAddr(it)) }
        payNetworkDisplay(network)?.let { append(" on ").append(it) }
        append(if (transfer) " from your wallet. It only happens when you tap Approve."
               else " from your wallet, over x402. It only happens when you tap Approve.")
    }

    /** POST/PUT body for the execute route (web fetch body): {quote, message}. */
    fun x402PayBody(quote: String, message: String): JSONObject =
        JSONObject().put("quote", quote).put("message", message)

    /**
     * The outcome of PUT /api/x402/pay — the ONLY money-moving call. Mirrors web
     * approve() / iOS approve() branch-for-branch: ok → Paid; already_paid (409) →
     * Paid (money DID move — never show "not sent"); pending_confirmation (202) →
     * Pending (sent, NOT retryable — a retry could double-pay); else → Failed, with
     * [needsFunds] when payment_required (recoverable: the quote wrote no ledger row,
     * so a top-up + retry settles it, not a double-charge).
     */
    sealed interface SettleResult {
        /** [explorer] is the network-correct BaseScan link the execute route derives from
         *  the settlement's X-PAYMENT-RESPONSE header (present only when the service
         *  returned an on-chain receipt). Mirrors WithdrawResult.explorer + web PayReceipt
         *  / iOS PayQuote "View on BaseScan". The 409 already_paid body carries no receipt,
         *  so it stays null there — parity with web (only the ok branch reads it). */
        data class Paid(val paidMicro: Long, val network: String?, val payee: String?, val explorer: String? = null, val transfer: Boolean = false) : SettleResult
        data class Pending(val message: String) : SettleResult
        /**
         * A non-terminal failure. [needsFunds] (payment_required) is recoverable by a
         * top-up + retry — the quote wrote no ledger row. [canReQuote] is the OTHER
         * recoverable dead-end: the quote expired (410) or the service changed its
         * price/terms (409, reservation reversed server-side); both moved no money, so
         * a fresh POST quote is safe. It requires the url the quote was minted for, so
         * it's only ever set when [PayQuote.url] is present. The two are mutually
         * exclusive in practice (a payment_required failure isn't expired/terms_changed).
         * Web parity: PayReceipt canReQuote; iOS PayQuoteCard canReQuote.
         */
        data class Failed(val error: String, val needsFunds: Boolean, val canReQuote: Boolean = false) : SettleResult
    }

    /**
     * The [SettleResult.Failed] for a NETWORK failure during settle (no server reply),
     * PRESERVING the recovery flags a prior attempt earned. iOS c198fdb: a blip during a
     * RETRY — where the first attempt already learned it was a funds shortfall
     * (needsFunds) or re-quotable (canReQuote) — must NOT erase the Add funds / Retry /
     * Get fresh quote affordance, because the quote moved no money and is still spendable.
     * On a FIRST attempt [prior] is null (or not a Failed), so both flags are false → only
     * the inert error shows, no phantom buttons. Web parity: PayReceipt re-derives both
     * from the retained `settled` and its catch leaves `settled` untouched. (A REAL server
     * reply is authoritative and goes through [parseSettleResult] instead — this is only
     * the transport-error path.)
     */
    fun networkFailure(prior: SettleResult?): SettleResult.Failed {
        val f = prior as? SettleResult.Failed
        return SettleResult.Failed(
            error = "No response — check your connection and try again.",
            needsFunds = f?.needsFunds ?: false,
            canReQuote = f?.canReQuote ?: false,
        )
    }

    /** Fold the execute reply + the originating [quote] into a [SettleResult]. The
     *  quote's price is the last fallback so a paid card never reads "$0" (409 carries
     *  price_micro, not paid_micro). */
    fun parseSettleResult(res: JSONObject, quote: PayQuote): SettleResult {
        if (res.optBoolean("ok", false)) {
            return SettleResult.Paid(
                paidMicro = res.optLong("paid_micro", 0L).takeIf { it > 0L } ?: quote.priceMicro,
                network = res.optString("network").takeIf { it.isNotEmpty() } ?: quote.network,
                payee = res.optString("payee").takeIf { it.isNotEmpty() } ?: quote.payee,
                explorer = res.optStringOrNull("explorer"),
                transfer = res.optBoolean("transfer", false) || quote.isTransfer,
            )
        }
        if (res.optBoolean("already_paid", false)) {
            val micro = res.optLong("paid_micro", 0L).takeIf { it > 0L }
                ?: res.optLong("price_micro", 0L).takeIf { it > 0L }
                ?: quote.priceMicro
            return SettleResult.Paid(
                paidMicro = micro,
                network = res.optString("network").takeIf { it.isNotEmpty() } ?: quote.network,
                payee = res.optString("payee").takeIf { it.isNotEmpty() } ?: quote.payee,
                transfer = res.optBoolean("transfer", false) || quote.isTransfer,
            )
        }
        if (res.optBoolean("pending_confirmation", false) || res.optInt("_status") == 202) {
            return SettleResult.Pending(
                res.optString("error").takeIf { it.isNotEmpty() }
                    ?: "Payment was sent — confirming on-chain.",
            )
        }
        // expired (410) / terms_changed (409, reservation reversed) → re-quotable in
        // place (both moved no money). Only offer it when we have the url the quote was
        // minted for. iOS: canReQuote = url != nil && (expired || terms_changed).
        val canReQuote = quote.url != null &&
            (res.optBoolean("expired", false) || res.optBoolean("terms_changed", false))
        return SettleResult.Failed(
            error = res.optString("error").takeIf { it.isNotEmpty() } ?: "The payment could not be completed.",
            needsFunds = res.optBoolean("payment_required", false),
            canReQuote = canReQuote,
        )
    }

    /** POST /api/x402/pay body to RE-MINT a fresh quote for the same service (quote-only,
     *  moves NO money): {url, message, prior_quote?}. The service url + quoted message ride
     *  the current quote forward. When the current (expired) quote token is passed as
     *  [priorQuote], the server decodes it (session-matched) and carries its agent-authorized
     *  spend cap forward via effectiveSpendCap — a re-quote can only tighten the cap, never
     *  widen it back to the platform ceiling. Web: reQuote() body {url, message, prior_quote};
     *  iOS reQuote() ["url","message","prior_quote"]. */
    fun reQuoteBody(url: String, message: String, priorQuote: String? = null): JSONObject =
        JSONObject().put("url", url).put("message", message).also { b ->
            priorQuote?.takeIf { it.isNotEmpty() }?.let { b.put("prior_quote", it) }
        }

    /**
     * Fold a POST /api/x402/pay re-quote reply into a fresh [PayQuote], or null when the
     * re-mint failed (so the card can surface "Couldn't get a fresh quote"). The POST
     * reply omits url + message (it only echoes them on the quote it received), so they
     * are carried forward from the request. Web: `r?.ok && r?.requires_confirmation &&
     * r?.quote` gate; iOS reQuote()'s guard.
     */
    fun parseReQuote(res: JSONObject, url: String, message: String): PayQuote? {
        if (!res.optBoolean("ok", false)) return null
        if (!res.optBoolean("requires_confirmation", false)) return null
        val quote = res.optString("quote").takeIf { it.isNotEmpty() } ?: return null
        return PayQuote(
            quote = quote,
            priceMicro = res.optLong("price_micro", 0L),
            network = res.optString("network").takeIf { it.isNotEmpty() },
            payee = res.optString("payee").takeIf { it.isNotEmpty() },
            expiresAt = if (res.has("expires_at") && !res.isNull("expires_at")) res.optDouble("expires_at") else null,
            message = message,
            url = url,
        )
    }

    /**
     * The PERSISTED terminal outcome of an approved (or declined) quote (C3). A
     * ToolCall is transient — it's NOT written to the transcript (MessageCodec) —
     * so without this a settled payment card VANISHES on reload, losing the
     * receipt of a real money movement. This rides the ChatMessage (like
     * [Paywall]) and is durable, so a reload re-renders the receipt. Only a
     * terminal, acted-on outcome persists; a `failed` attempt moved no money and
     * its quote may still be spendable, so it is NOT persisted (a reload re-offers
     * approval). Web ToolCall.paySettled / iOS PayQuoteItem.settled parity.
     */
    data class PaySettled(
        val phase: String,       // "paid" | "pending" | "declined"
        val paidMicro: Long = 0L,
        val network: String? = null,
        val payee: String? = null,
        val message: String? = null, // pending's on-chain-confirming line
        val explorer: String? = null, // paid's network-correct BaseScan link (survives cold reload)
        val transfer: Boolean = false, // P2P send — keeps "Sent … from your wallet" wording on reload
    ) {
        /** The receipt body line for a paid outcome (mirrors PayReceipt.summary). */
        val paidSummary: String get() = PayReceipt(true, paidMicro, network, payee, null, transfer).summary

        /** The full receipt body incl. the flow suffix — ONE place decides x402-vs-
         *  transfer wording so the live card and the cold-reload card can't drift. */
        val receiptBody: String get() = paidSummary + if (transfer) " from your wallet." else " over the x402 protocol."
    }

    /** Fold a post-tap [SettleResult] into the durable [PaySettled], or null for a
     *  `failed` outcome (deliberately not persisted — see [PaySettled]). */
    fun toPersisted(r: SettleResult): PaySettled? = when (r) {
        is SettleResult.Paid -> PaySettled("paid", r.paidMicro, r.network, r.payee, explorer = r.explorer, transfer = r.transfer)
        is SettleResult.Pending -> PaySettled("pending", message = r.message)
        is SettleResult.Failed -> null
    }

    // -- paywall (HTTP 402 body → an actionable payment card) --

    /**
     * A parsed 402 paywall body (web Chat.tsx err.payment). A priced tiny with an
     * unfunded (or signed-out) wallet returns `{payment_required, price_micro,
     * balance_micro, error}` — this lifts the numbers the card shows so a 402 is a
     * "💳 Add funds / ↻ Retry" card, not a bare error line. The 402 stays
     * authoritative server-side; this is display + the retry-once-funded prompt.
     */
    data class Paywall(val priceMicro: Long, val balanceMicro: Long, val signedOut: Boolean) {
        /** The card body line — mirrors web's copy branches verbatim. */
        val detail: String get() = if (signedOut) {
            "It charges ${usd(priceMicro)} per message. Sign in and add funds to continue."
        } else {
            // Surface the exact top-up shortfall so the user doesn't have to subtract
            // balance from price in their head on a money-critical card. Guard on
            // shortfall > 0: an insufficient-balance 402 always has balance < price,
            // but if the two ever read equal (stale/rounding) fall back to the plain
            // price·balance line rather than telling them to "add $0.00". Mirrors web
            // (Chat.tsx:3490) and iOS (Views.swift PaywallCard).
            val shortfallMicro = priceMicro - balanceMicro
            if (shortfallMicro > 0) {
                "It charges ${usd(priceMicro)} per message · your balance is ${usd(balanceMicro)} — add at least ${usd(shortfallMicro)} to continue."
            } else {
                "It charges ${usd(priceMicro)} per message · your balance is ${usd(balanceMicro)}."
            }
        }
    }

    /**
     * Parse a 402 body into a [Paywall], or null when it isn't the paywall shape
     * (so the caller keeps the plain error line). Prefer the server's
     * authoritative `signed_out` flag (route.ts); the balance-absent +
     * "sign in"-copy derivation is the OTA fallback for an older server that
     * predates the flag.
     */
    fun parsePaywall(res: JSONObject): Paywall? {
        if (!res.optBoolean("payment_required", false)) return null
        val balance = res.optLong("balance_micro", 0L)
        val signedOut = if (res.has("signed_out")) {
            res.optBoolean("signed_out", false)
        } else {
            balance == 0L && !res.has("balance_micro") &&
                res.optString("error").contains("sign in", ignoreCase = true)
        }
        return Paywall(
            priceMicro = res.optLong("price_micro", 0L),
            balanceMicro = balance,
            signedOut = signedOut,
        )
    }

    // -- request shaping (pure; the repository below is thin async glue over these) --
    // Extracted PURE so the endpoint bodies + network normalization are unit-tested
    // once and can't drift from ChatViewModel's slash-command path (the wear surface's
    // WearChat.buildRequestMessages pattern). The repository just POSTs these + folds
    // the reply through the parsers above.

    /**
     * Normalize a free-text network name to the worker's canonical id, or null when
     * absent (server defaults). The SINGLE source of truth — ChatViewModel's wallet
     * commands delegate here rather than duplicating the `when` (was a hand-synced twin;
     * see the delegate's note). base|mainnet → "base"; sepolia|base-sepolia|testnet|trial
     * → "base-sepolia"; tiny|tiny-chain|tinychain → "tiny"; anything else passes
     * through trimmed (server normalizes/defaults).
     *
     * `tiny` had no case at all, so a self-hosted deployment's own chain fell into the
     * passthrough — which happened to work for the literal "tiny" and silently failed
     * for every way a user says it in chat ("tiny chain", "tiny-chain"). Note "trial"
     * still maps to Sepolia, not to tiny: it's the older alias and remapping it would
     * change what an existing user's `/wallet claim … trial` settles on.
     */
    fun normNetwork(raw: String?): String? = when (raw?.trim()?.lowercase()) {
        null, "" -> null
        "base", "mainnet" -> "base"
        "sepolia", "base-sepolia", "testnet", "trial" -> "base-sepolia"
        "tiny", "tiny-chain", "tinychain" -> "tiny"
        else -> raw.trim()
    }

    /** POST /api/wallet {action:deposit_info} — the platform deposit address + linked addr. */
    fun depositInfoBody(): JSONObject = JSONObject().put("action", "deposit_info")

    /** POST /api/wallet {action:link_address, address} — bind a sending/withdrawal address. */
    fun linkAddressBody(address: String): JSONObject =
        JSONObject().put("action", "link_address").put("address", address.trim())

    /** POST /api/wallet {action:claim, txHash, network?} — credit an on-chain deposit. */
    fun claimBody(txHash: String, network: String?): JSONObject {
        val body = JSONObject().put("action", "claim").put("txHash", txHash.trim())
        normNetwork(network)?.let { body.put("network", it) }
        return body
    }

    /** POST /api/wallet/withdraw {amount_micro, network?} — pay out to the linked address. */
    fun withdrawBody(amountMicro: Long, network: String?): JSONObject {
        val body = JSONObject().put("amount_micro", amountMicro)
        normNetwork(network)?.let { body.put("network", it) }
        return body
    }

    // -- action result parsing (POST /api/wallet[/withdraw]) --
    // TinyApi.executeJson does NOT throw on non-2xx: it returns the parsed body with
    // `_status` stamped. So a 425 (claim needs more confirmations) or 202 (withdraw
    // pending) arrives as a normal JSONObject with the server's fields intact — these
    // pure parsers fold status + body into one typed result, tested without a network.

    /** Result of POST action=link_address (iOS linkAddress / ChatViewModel walletLink). */
    sealed interface LinkResult {
        data class Ok(val address: String) : LinkResult
        data class Failed(val error: String) : LinkResult
    }

    fun parseLinkResult(res: JSONObject, sentAddress: String): LinkResult =
        if (res.optBoolean("ok")) {
            LinkResult.Ok(res.optString("address", "").ifEmpty { sentAddress })
        } else {
            LinkResult.Failed(res.optString("error", "").ifEmpty { "couldn't link that address" })
        }

    /** Result of POST action=claim (iOS claimDeposit / ChatViewModel walletClaim). */
    sealed interface ClaimResult {
        /** Credited (or already credited before) — [creditedMicro] is 0 when already. */
        data class Ok(val creditedMicro: Long, val alreadyCredited: Boolean, val testnetTrial: Boolean) : ClaimResult
        /** Deposit seen but needs more confirmations (425 / retry:true) — try again soon. */
        data class Retry(val error: String) : ClaimResult
        data class Failed(val error: String) : ClaimResult
    }

    fun parseClaimResult(res: JSONObject): ClaimResult {
        if (res.optBoolean("ok")) {
            return ClaimResult.Ok(
                creditedMicro = res.optLong("credited_micro", 0L),
                alreadyCredited = res.optBoolean("already_credited"),
                testnetTrial = res.optBoolean("testnet_trial"),
            )
        }
        val err = res.optString("error", "").ifEmpty { "claim failed" }
        // 425 carries retry:true — the deposit was seen but isn't confirmed yet.
        return if (res.optBoolean("retry") || res.optInt("_status") == 425) {
            ClaimResult.Retry(err)
        } else {
            ClaimResult.Failed(err)
        }
    }

    /** Result of POST /api/wallet/withdraw (iOS withdraw / ChatViewModel walletWithdraw). */
    sealed interface WithdrawResult {
        /** Paid out on-chain — [netMicro] after the [feeMicro] gas fee; [explorer] optional. */
        data class Ok(val netMicro: Long, val feeMicro: Long, val explorer: String?) : WithdrawResult
        /** Broadcast but not yet confirmed (202) — money is moving, not an error. The
         *  tx is already on-chain, so it carries the [explorer] link too (web + iOS
         *  after dcaa95e surface BaseScan on BOTH the paid and pending paths). */
        data class Pending(val explorer: String?) : WithdrawResult
        data class Failed(val error: String) : WithdrawResult
    }

    /**
     * Result of POST /api/wallet/faucet — the in-house daily drip.
     *
     * The two refusals stay SEPARATE cases, not one Failed with a flag, for the same
     * reason [faucetCta] keeps two messages: 429 already-claimed and 400
     * ceiling-reached are opposite instructions ("come back tomorrow" vs "get
     * followed"), and the route passes the worker's own sentences through verbatim.
     */
    sealed interface FaucetResult {
        /** Credited. [reserveBacked] = the matching TinyUSDC mint landed on-chain
         *  (best-effort by design — the credit is real either way). */
        data class Ok(val creditedMicro: Long, val reserveBacked: Boolean, val explorer: String?) : FaucetResult
        /** 429 — today's drip is spent; [error] carries the server's wording. */
        data class AlreadyClaimed(val error: String) : FaucetResult
        /** 400 — the reputation-scaled lifetime ceiling is spent; waiting won't help. */
        data class CeilingReached(val error: String) : FaucetResult
        /** 424 (no faucet on this deployment) / 401 / 500 — everything else. */
        data class Failed(val error: String) : FaucetResult
    }

    fun parseFaucetResult(res: JSONObject): FaucetResult {
        if (res.optBoolean("ok")) {
            return FaucetResult.Ok(
                creditedMicro = res.optLong("credited_micro", 0L),
                reserveBacked = res.truthyFlag("reserve_backed", false),
                explorer = res.optStringOrNull("explorer"),
            )
        }
        val err = res.optString("error", "").ifEmpty { "faucet unavailable" }
        // Flag first, status second: the worker sets already_claimed/ceiling_reached
        // explicitly, and the status is the fallback for a proxy that rewrote it.
        return when {
            res.truthyFlag("ceiling_reached", false) -> FaucetResult.CeilingReached(err)
            res.truthyFlag("already_claimed", false) -> FaucetResult.AlreadyClaimed(err)
            res.optInt("_status") == 429 -> FaucetResult.AlreadyClaimed(err)
            else -> FaucetResult.Failed(err)
        }
    }

    fun parseWithdrawResult(res: JSONObject): WithdrawResult {
        if (res.optBoolean("ok")) {
            return WithdrawResult.Ok(
                netMicro = res.optLong("net_micro", 0L),
                feeMicro = res.optLong("fee_micro", 0L),
                explorer = res.optStringOrNull("explorer"),
            )
        }
        if (res.optBoolean("pending_confirmation") || res.optInt("_status") == 202) {
            return WithdrawResult.Pending(res.optStringOrNull("explorer"))
        }
        return WithdrawResult.Failed(res.optString("error", "").ifEmpty { "withdrawal failed" })
    }
}

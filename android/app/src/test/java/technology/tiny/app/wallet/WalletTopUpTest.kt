package technology.tiny.app.wallet

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 💧 TOP-UP PRESENTATION — how the Android wallet decides what to offer a user
 * who has no money, and what to name the chain their money lives on.
 *
 * The Android half of the self-hosted chain's client work; the web half
 * (lib/x402/top-up.ts + tests/top-up.test.ts) shipped first and these mirror it
 * assertion-for-assertion so the two clients can't drift.
 *
 * All three clients used to render Coinbase / MoonPay / faucet.circle.com — three
 * REAL-MONEY on-ramps that are actively misleading on a chain we own: nobody sells
 * TinyUSDC, and faucet.circle.com hands out SEPOLIA USDC, so a user who follows any
 * of them spends real money (or real time) and arrives holding a token this
 * deployment cannot credit. On our own chain a stale on-ramp is a trap, not a dead
 * link. The in-house faucet is the only source.
 *
 * Why these are TESTS and not a design review: the content is PRODUCT JUDGEMENT
 * that looks right on inspection and is wrong in front of a user — you find out
 * when someone is staring at a button that 424s, or at "try again later" when the
 * real answer is "you've had all of it". Four properties get pinned:
 *
 *  1. **Exactly one route**, chosen from what the server says it can DO
 *     (faucet.available), never from the network's NAME.
 *  2. **The two refusals never merge.** 429 already-claimed and 400
 *     ceiling-reached are opposite instructions.
 *  3. **A trial network is always named as trial**, on every surface including the
 *     irreversible withdraw confirm.
 *  4. **The picker offers the deployment's own chain + real Base, never both trial
 *     chains** — a hash from one is invisible to the other's receipt scanner.
 */
class WalletTopUpTest {

    /** A live faucet block, matching the worker's PayDepositInfoCall shape. */
    private fun faucet(
        available: Boolean = true,
        dripMicro: Long = 1_000_000L,
        capMicro: Long = 1_000_000L,
        grantedMicro: Long = 0L,
        remainingMicro: Long = 1_000_000L,
        claimedToday: Boolean = false,
        nextDripInSeconds: Long = 0L,
        reputation: Int = 0,
        microPerPoint: Long = 200_000L,
        maxMicro: Long = 25_000_000L,
    ) = WalletCore.FaucetInfo(
        available = available, network = "tiny", dripMicro = dripMicro, capMicro = capMicro,
        grantedMicro = grantedMicro, remainingMicro = remainingMicro, claimedToday = claimedToday,
        nextDripInSeconds = nextDripInSeconds, reputation = reputation,
        microPerPoint = microPerPoint, maxMicro = maxMicro,
    )

    private fun info(chain: String?, f: WalletCore.FaucetInfo? = null) =
        WalletCore.DepositInfo(configured = true, depositAddress = "0xabc", chain = chain, linkedAddress = null, faucet = f)

    // -- asNetwork: three networks, and a SAFE default --

    @Test fun `asNetwork accepts the workers three network ids`() {
        assertEquals("base", WalletCore.asNetwork("base"))
        assertEquals("base-sepolia", WalletCore.asNetwork("base-sepolia"))
        assertEquals("tiny", WalletCore.asNetwork("tiny"))
    }

    @Test fun `asNetwork normalises case and whitespace`() {
        assertEquals("tiny", WalletCore.asNetwork("  TINY "))
        assertEquals("base-sepolia", WalletCore.asNetwork("Base-Sepolia"))
    }

    @Test fun `asNetwork falls back to base for anything unknown`() {
        // Base is the SAFE default: guessing "trial" for an unknown name would label
        // real, withdrawable money as un-withdrawable trial credit.
        for (raw in listOf(null, "", "   ", "optimism", "sepolia", "mainnet", "tiny-chain")) {
            assertEquals("raw=$raw", "base", WalletCore.asNetwork(raw))
        }
    }

    // -- topUpRoute: exactly one route, chosen from what the server can DO --

    @Test fun `topUpRoute offers the in-house faucet when the server advertises one`() {
        assertEquals(WalletCore.TopUpRoute.FAUCET, WalletCore.topUpRoute(info("tiny", faucet())))
    }

    @Test fun `topUpRoute does NOT offer the faucet on a half-configured tiny chain`() {
        // THE reason this keys on faucet.available and not the network name: the
        // faucet needs a mintable token AND a deployer key, so a half-configured
        // tiny deployment reports `tiny` with faucet:{available:false}. A claim
        // button there 424s on every single press.
        val half = info("tiny", WalletCore.FaucetInfo(available = false))
        assertNotEquals(WalletCore.TopUpRoute.FAUCET, WalletCore.topUpRoute(half))
        assertEquals(WalletCore.TopUpRoute.FIAT, WalletCore.topUpRoute(half))
        // Same when the block is absent entirely (older worker).
        assertEquals(WalletCore.TopUpRoute.FIAT, WalletCore.topUpRoute(info("tiny", null)))
    }

    @Test fun `topUpRoute sends Sepolia to the public testnet faucet, not to cards`() {
        // Fiat on-ramps deliver MAINNET USDC the Sepolia claim scanner can't see.
        assertEquals(WalletCore.TopUpRoute.TESTNET, WalletCore.topUpRoute(info("base-sepolia")))
    }

    @Test fun `topUpRoute sends real Base to fiat on-ramps, where they actually work`() {
        assertEquals(WalletCore.TopUpRoute.FIAT, WalletCore.topUpRoute(info("base")))
        assertEquals(WalletCore.TopUpRoute.FIAT, WalletCore.topUpRoute(null))
    }

    @Test fun `a faucet deployment offers NO external source — the routes are exclusive`() {
        // Offering a card button "just in case" beside the faucet, on a chain where
        // the card cannot deliver, is the exact bug this replaces.
        assertTrue(WalletCore.usdcSources(info("tiny", faucet())).isEmpty())
        // And the other two routes each keep exactly their own sources.
        val testnet = WalletCore.usdcSources(info("base-sepolia"))
        assertEquals(1, testnet.size)
        assertEquals("https://faucet.circle.com", testnet[0].url)
        assertTrue(testnet[0].faucet)
        val fiat = WalletCore.usdcSources(info("base"))
        assertEquals(2, fiat.size)
        assertTrue(fiat.none { it.faucet })
        assertTrue(fiat.any { it.url.contains("coinbase.com") })
        assertTrue(fiat.any { it.url.contains("bridge.base.org") })
    }

    @Test fun `usdcSources treats an unknown or absent network as mainnet`() {
        // A missing default_network (older worker, transport miss) must NOT surface
        // the un-claimable public faucet by default.
        for (chain in listOf(null, "", "base-goerli", "ethereum")) {
            val sources = WalletCore.usdcSources(info(chain))
            assertEquals("chain=$chain should be mainnet", 2, sources.size)
            assertTrue("chain=$chain must hide the faucet", sources.none { it.faucet })
        }
    }

    @Test fun `topUpBlurb matches the route and never promises a rail that cannot deliver`() {
        val f = WalletCore.topUpBlurb(info("tiny", faucet()))
        assertTrue(f.contains("its own chain"))
        assertFalse(f.contains("card,") && f.contains("Buy")) // no purchase instruction
        assertTrue(WalletCore.topUpBlurb(info("base-sepolia")).contains("Base Sepolia"))
        assertTrue(WalletCore.topUpBlurb(info("base-sepolia")).contains("risk-free"))
        // The mainnet blurb must not advertise a testnet path.
        assertFalse(WalletCore.topUpBlurb(info("base")).contains("testnet"))
        assertFalse(WalletCore.topUpBlurb(null).contains("testnet"))
    }

    // -- usdShort / untilNextDrip: the numbers on the button --

    @Test fun `usdShort renders whole dollars without cents`() {
        assertEquals("$1", WalletCore.usdShort(1_000_000L))
        assertEquals("$25", WalletCore.usdShort(25_000_000L))
    }

    @Test fun `usdShort keeps cents and sub-cents when they exist`() {
        assertEquals("$1.2", WalletCore.usdShort(1_200_000L))
        assertEquals("$0.2", WalletCore.usdShort(200_000L))
        assertEquals("$0.000001", WalletCore.usdShort(1L))
        assertEquals("$0", WalletCore.usdShort(0L))
    }

    @Test fun `untilNextDrip renders hours and minutes`() {
        assertEquals("2h 5m", WalletCore.untilNextDrip(7500L))
        assertEquals("2h", WalletCore.untilNextDrip(7200L))
        assertEquals("5m", WalletCore.untilNextDrip(300L))
    }

    @Test fun `untilNextDrip rounds a sub-minute wait up to 1m rather than saying 0m`() {
        // "Next top-up in 0m" reads as a bug; the drip really is imminent.
        assertEquals("1m", WalletCore.untilNextDrip(30L))
        assertEquals("1m", WalletCore.untilNextDrip(59L))
    }

    @Test fun `untilNextDrip is empty for a non-future value so the caller can fall back`() {
        for (s in listOf(0L, -1L, -7200L)) assertEquals("s=$s", "", WalletCore.untilNextDrip(s))
    }

    // -- faucetCta: three states that must not be confused --

    @Test fun `faucetCta is live and names the amount when credit is claimable`() {
        val cta = WalletCore.faucetCta(faucet())
        assertTrue(cta.enabled)
        assertEquals("Claim $1 free credit", cta.label)
        assertEquals("", cta.reason)
    }

    @Test fun `faucetCta promises the CLAMPED amount, not the nominal drip`() {
        // The worker credits MIN(drip, remaining). A button reading "$1" that pays
        // $0.30 is a broken promise made by the client, not the server.
        val cta = WalletCore.faucetCta(faucet(remainingMicro = 300_000L, grantedMicro = 700_000L))
        assertTrue(cta.enabled)
        assertEquals("Claim $0.3 free credit", cta.label)
    }

    @Test fun `faucetCta says claimed-today with the wait — and that credit remains`() {
        val cta = WalletCore.faucetCta(
            faucet(claimedToday = true, nextDripInSeconds = 7500L, remainingMicro = 3_000_000L, capMicro = 4_000_000L),
        )
        assertFalse(cta.enabled)
        assertEquals("Claimed today", cta.label)
        assertTrue(cta.reason.contains("2h 5m"))
        assertTrue(cta.reason.contains("$3"))
        // NOT the ceiling message: this user has room and should come back.
        assertFalse(cta.reason.contains("used all"))
    }

    @Test fun `faucetCta falls back to midnight UTC when the server omits the countdown`() {
        val cta = WalletCore.faucetCta(faucet(claimedToday = true, nextDripInSeconds = 0L))
        assertTrue(cta.reason.contains("after midnight UTC"))
        assertFalse(cta.reason.contains("in  —"))
    }

    @Test fun `faucetCta says the LIFETIME ceiling is spent, and how to raise it`() {
        val cta = WalletCore.faucetCta(faucet(remainingMicro = 0L, grantedMicro = 1_000_000L))
        assertFalse(cta.enabled)
        assertEquals("Lifetime credit used", cta.label)
        assertTrue(cta.reason.contains("$1"))
        // The two actionable exits, neither of which is "wait until tomorrow".
        assertTrue(cta.reason.contains("followed"))
        assertTrue(cta.reason.contains("real USDC"))
        assertFalse(cta.reason.contains("tomorrow"))
        assertFalse(cta.reason.contains("midnight"))
    }

    @Test fun `faucetCta reads capped when the user is BOTH capped and claimed today`() {
        // Ceiling is checked first on purpose: telling this user to come back
        // tomorrow is a lie, because tomorrow's drip is refused too.
        val cta = WalletCore.faucetCta(faucet(remainingMicro = 0L, claimedToday = true, nextDripInSeconds = 3600L))
        assertEquals("Lifetime credit used", cta.label)
        assertFalse(cta.reason.contains("1h"))
    }

    @Test fun `faucetCta never lets the two refusals share a message`() {
        val capped = WalletCore.faucetCta(faucet(remainingMicro = 0L))
        val daily = WalletCore.faucetCta(faucet(claimedToday = true, nextDripInSeconds = 3600L))
        assertNotEquals(capped.label, daily.label)
        assertNotEquals(capped.reason, daily.reason)
    }

    @Test fun `faucetCta is disabled with an honest label when there is no faucet at all`() {
        for (f in listOf(null, WalletCore.FaucetInfo(available = false))) {
            val cta = WalletCore.faucetCta(f)
            assertFalse(cta.enabled)
            assertTrue(cta.reason.isNotEmpty())
            // No dollar figures invented from an absent payload.
            assertFalse(cta.label.contains("$"))
        }
    }

    @Test fun `faucetCta treats a missing remaining as no credit, not as unlimited`() {
        // Fail closed: parseFaucetInfo defaults remaining_micro to 0, so the ceiling
        // message shows. Enabling the button here would 400 on press.
        assertFalse(WalletCore.faucetCta(faucet(remainingMicro = 0L)).enabled)
        assertFalse(WalletCore.faucetCta(faucet(remainingMicro = -5L)).enabled)
    }

    // -- ceilingNote: why the ceiling is what it is --

    @Test fun `ceilingNote shows used-of-cap and the path to more`() {
        val note = WalletCore.ceilingNote(faucet(grantedMicro = 400_000L))
        assertTrue(note.contains("$0.4 of $1 used."))
        assertTrue(note.contains("Earn reputation"))
        assertTrue(note.contains("$0.2 per point"))
        assertTrue(note.contains("up to $25."))
    }

    @Test fun `ceilingNote credits existing reputation instead of telling that user to earn some`() {
        val note = WalletCore.ceilingNote(faucet(reputation = 3, capMicro = 1_600_000L))
        assertTrue(note.contains("Your 3 reputation points add $0.2 each"))
        assertFalse(note.contains("Earn reputation"))
    }

    @Test fun `ceilingNote says point adds for exactly one`() {
        assertTrue(WalletCore.ceilingNote(faucet(reputation = 1)).contains("1 reputation point adds"))
    }

    @Test fun `ceilingNote is empty with no faucet so no caller renders a stray line`() {
        assertEquals("", WalletCore.ceilingNote(null))
        assertEquals("", WalletCore.ceilingNote(WalletCore.FaucetInfo(available = false)))
    }

    @Test fun `ceilingNote is shown in every faucet state — including right after a claim`() {
        // It's deliberately independent of claimedToday/remaining: a user who just
        // claimed still needs to know why their ceiling is what it is.
        for (f in listOf(faucet(), faucet(claimedToday = true), faucet(remainingMicro = 0L, grantedMicro = 1_000_000L))) {
            assertTrue(WalletCore.ceilingNote(f).isNotEmpty())
        }
    }

    // -- network naming: trial credit is never mistaken for money --

    @Test fun `networkLabel marks BOTH trial networks as trial`() {
        assertTrue(WalletCore.networkLabel("tiny").contains("trial credit"))
        assertTrue(WalletCore.networkLabel("base-sepolia").contains("trial credit"))
    }

    @Test fun `networkLabel marks only real Base as real USDC`() {
        assertEquals("Base (real USDC)", WalletCore.networkLabel("base"))
        assertFalse(WalletCore.isRealMoney("tiny"))
        assertFalse(WalletCore.isRealMoney("base-sepolia"))
        assertTrue(WalletCore.isRealMoney("base"))
    }

    @Test fun `the tiny chain is never called Sepolia — they are different chains`() {
        // A user told their balance is on "Base Sepolia" would go look for it on a
        // public explorer that has never heard of it.
        assertFalse(WalletCore.networkLabel("tiny").contains("Sepolia"))
        assertEquals("Tiny Chain", WalletCore.networkShort("tiny"))
        assertEquals("Sepolia", WalletCore.networkShort("base-sepolia"))
        assertEquals("Base", WalletCore.networkShort("base"))
    }

    @Test fun `withdrawConfirmText names the tiny chain, not Base Sepolia`() {
        // The old two-way ternary (`network == "base" ? Base : Base Sepolia`) called
        // EVERY non-mainnet network Sepolia — on the app's one irreversible action.
        assertTrue(WalletCore.withdrawConfirmText(2_000_000L, "tiny").contains("on Tiny Chain."))
        assertFalse(WalletCore.withdrawConfirmText(2_000_000L, "tiny").contains("Sepolia"))
        assertTrue(WalletCore.withdrawConfirmText(2_000_000L, "base").contains("on Base."))
        assertTrue(WalletCore.withdrawConfirmText(2_000_000L, "base-sepolia").contains("on Sepolia."))
    }

    // -- networkChoices: the deployment's own chain + real Base, never both trials --

    @Test fun `networkChoices offers the deployments own trial chain and Base`() {
        assertEquals(listOf("tiny", "base"), WalletCore.networkChoices("tiny"))
        assertEquals(listOf("base-sepolia", "base"), WalletCore.networkChoices("base-sepolia"))
    }

    @Test fun `networkChoices never offers the OTHER trial chain`() {
        // A tx hash from one trial chain is invisible to the other's receipt scanner
        // — a permanent "no matching USDC transfer" 400 with no way to recover.
        assertFalse(WalletCore.networkChoices("tiny").contains("base-sepolia"))
        assertFalse(WalletCore.networkChoices("base-sepolia").contains("tiny"))
    }

    @Test fun `networkChoices shows Base alone on a mainnet deployment`() {
        assertEquals(listOf("base"), WalletCore.networkChoices("base"))
        assertEquals(listOf("base"), WalletCore.networkChoices(null))
    }

    @Test fun `the deployments default network is ALWAYS selectable — the c-g bug`() {
        // The bug this closes: the toggle hardcoded base|base-sepolia, so on a `tiny`
        // deployment the chain every deposit actually lands on could not be picked.
        for (chain in listOf("tiny", "base-sepolia", "base")) {
            val choices = WalletCore.networkChoices(chain)
            assertTrue("chain=$chain must be selectable", choices.contains(WalletCore.asNetwork(chain)))
            assertEquals("the deployment's own chain comes first", WalletCore.asNetwork(chain), choices[0])
        }
    }

    // -- parseFaucetInfo: the wire shape (worker PayDepositInfoCall) --

    @Test fun `parseFaucetInfo maps the full faucet block`() {
        val d = WalletCore.parseDepositInfo(
            JSONObject(
                """{"configured":true,"default_network":"tiny","faucet":{"available":true,"network":"tiny",
                   "drip_micro":1000000,"cap_micro":1600000,"granted_micro":400000,"remaining_micro":1200000,
                   "claimed_today":false,"next_drip_in_seconds":3600,"reputation":3,"micro_per_point":200000,
                   "max_micro":25000000}}""",
            ),
        )
        val f = d.faucet!!
        assertTrue(f.available)
        assertEquals("tiny", f.network)
        assertEquals(1_000_000L, f.dripMicro)
        assertEquals(1_600_000L, f.capMicro)
        assertEquals(400_000L, f.grantedMicro)
        assertEquals(1_200_000L, f.remainingMicro)
        assertFalse(f.claimedToday)
        assertEquals(3600L, f.nextDripInSeconds)
        assertEquals(3, f.reputation)
        assertEquals(WalletCore.TopUpRoute.FAUCET, WalletCore.topUpRoute(d))
    }

    @Test fun `parseFaucetInfo keeps absent and available-false distinguishable`() {
        // Both fail closed, but "no faucet block at all" (older worker) and an
        // explicit {available:false} (half-configured chain) are different server
        // answers, and collapsing them would lose the ability to tell them apart.
        assertNull(WalletCore.parseDepositInfo(JSONObject("""{"configured":true}""")).faucet)
        val explicit = WalletCore.parseDepositInfo(JSONObject("""{"faucet":{"available":false}}""")).faucet
        assertTrue(explicit != null && !explicit.available)
        assertNull(WalletCore.parseDepositInfo(JSONObject("""{"faucet":null}""")).faucet)
    }

    @Test fun `parseFaucetInfo coerces an integer available flag`() {
        // org.json's optBoolean does NOT coerce numbers — a 0/1 flag would silently
        // read false and hide the ONLY top-up route on a self-hosted chain.
        val one = WalletCore.parseDepositInfo(JSONObject("""{"faucet":{"available":1,"remaining_micro":1000000,"drip_micro":1000000}}""")).faucet!!
        assertTrue(one.available)
        assertTrue(WalletCore.faucetCta(one).enabled)
        val zero = WalletCore.parseDepositInfo(JSONObject("""{"faucet":{"available":0}}""")).faucet!!
        assertFalse(zero.available)
    }

    @Test fun `parseFaucetInfo defaults a missing remaining to zero, not to the cap`() {
        val f = WalletCore.parseDepositInfo(
            JSONObject("""{"faucet":{"available":true,"drip_micro":1000000,"cap_micro":1000000}}"""),
        ).faucet!!
        assertEquals(0L, f.remainingMicro)
        assertFalse("a claim button here would 400 on press", WalletCore.faucetCta(f).enabled)
    }

    // -- parseFaucetResult: the claim reply, incl. the two distinct refusals --

    @Test fun `parseFaucetResult reads a credited drip and whether the mint backed it`() {
        val r = WalletCore.parseFaucetResult(
            JSONObject("""{"ok":true,"credited_micro":1000000,"reserve_backed":true,"reserve_tx":"0xabc","explorer":"https://x/tx/0xabc"}"""),
        )
        r as WalletCore.FaucetResult.Ok
        assertEquals(1_000_000L, r.creditedMicro)
        assertTrue(r.reserveBacked)
        assertEquals("https://x/tx/0xabc", r.explorer)
    }

    @Test fun `parseFaucetResult reports an unbacked credit as still credited`() {
        // The mint is best-effort by design: refusing a drip the user has ALREADY
        // been credited for is the worst of the three outcomes (the daily ref is
        // spent, so they'd see an error and no money until tomorrow).
        val r = WalletCore.parseFaucetResult(JSONObject("""{"ok":true,"credited_micro":300000,"reserve_backed":false}"""))
        r as WalletCore.FaucetResult.Ok
        assertEquals(300_000L, r.creditedMicro)
        assertFalse(r.reserveBacked)
        assertNull(r.explorer)
    }

    @Test fun `parseFaucetResult keeps the 429 and 400 refusals as SEPARATE cases`() {
        val daily = WalletCore.parseFaucetResult(
            JSONObject("""{"error":"already claimed today's credit","next_drip_in_seconds":3600,"already_claimed":true,"_status":429}"""),
        )
        assertTrue(daily is WalletCore.FaucetResult.AlreadyClaimed)
        val capped = WalletCore.parseFaucetResult(
            // ${'$'}, not \$: a raw string keeps the backslash, which is an invalid
            // JSON escape and throws before the assertion runs.
            JSONObject("""{"error":"trial ceiling reached (${'$'}1 lifetime) — get followed to earn more room","cap_micro":1000000,"ceiling_reached":true,"_status":400}"""),
        )
        assertTrue(capped is WalletCore.FaucetResult.CeilingReached)
        // And the server's own wording survives — the UI shows it verbatim rather
        // than re-wording two opposite instructions into one.
        assertTrue((capped as WalletCore.FaucetResult.CeilingReached).error.contains("get followed"))
    }

    @Test fun `parseFaucetResult prefers the ceiling flag when BOTH are somehow set`() {
        // Same ordering as faucetCta: capped is the durable truth; "come back
        // tomorrow" would be a lie for a user whose tomorrow is refused too.
        val r = WalletCore.parseFaucetResult(
            JSONObject("""{"error":"ceiling reached","already_claimed":true,"ceiling_reached":true,"_status":429}"""),
        )
        assertTrue(r is WalletCore.FaucetResult.CeilingReached)
    }

    @Test fun `parseFaucetResult falls back to the status when a proxy dropped the flags`() {
        val r = WalletCore.parseFaucetResult(JSONObject("""{"error":"Too Many Requests","_status":429}"""))
        assertTrue(r is WalletCore.FaucetResult.AlreadyClaimed)
    }

    @Test fun `parseFaucetResult reports a deployment with no faucet as a plain failure`() {
        val r = WalletCore.parseFaucetResult(
            JSONObject("""{"error":"the in-house faucet needs a tiny-chain deployment","_status":424}"""),
        )
        r as WalletCore.FaucetResult.Failed
        assertTrue(r.error.contains("tiny-chain"))
        // A body with no error at all still gets a sentence, never an empty toast.
        val bare = WalletCore.parseFaucetResult(JSONObject("""{"ok":false}"""))
        assertTrue((bare as WalletCore.FaucetResult.Failed).error.isNotEmpty())
    }

    // -- normNetwork: the slash-command path learns the tiny chain --

    @Test fun `normNetwork canonicalizes the tiny chain and its spoken aliases`() {
        // `tiny` had no case at all: the literal "tiny" worked by passthrough luck,
        // and every way a user actually says it in chat did not.
        assertEquals("tiny", WalletCore.normNetwork("tiny"))
        assertEquals("tiny", WalletCore.normNetwork("Tiny Chain".replace(" ", "-")))
        assertEquals("tiny", WalletCore.normNetwork(" TINYCHAIN "))
        // "trial" stays Sepolia — the older alias; remapping it would change what an
        // existing user's `/wallet claim … trial` settles on.
        assertEquals("base-sepolia", WalletCore.normNetwork("trial"))
    }
}

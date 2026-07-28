package technology.tiny.app.wallet

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * WalletCore is the pure brain behind the native Wallet screen — money math,
 * ledger labels, on-chain-input validation, and /api/wallet response parsing.
 * These pin the wire shapes (matching the worker's D1 ledger + iOS WalletView)
 * and the formatting rules that ChatViewModel.usd already ships, so the screen
 * and the slash-commands can't drift.
 */
class WalletCoreTest {

    // -- usd formatting (byte-identical to ChatViewModel.usd) --

    @Test fun `usd renders whole dollars with two decimals`() {
        assertEquals("$1.00", WalletCore.usd(1_000_000))
        assertEquals("$0.00", WalletCore.usd(0))
    }

    @Test fun `usd keeps at least two decimals but no dangling dot`() {
        assertEquals("$0.50", WalletCore.usd(500_000)) // ".5" → ".50"
        assertEquals("$1.23", WalletCore.usd(1_230_000))
    }

    @Test fun `usd shows sub-cent precision up to six digits, trailing zeros trimmed`() {
        assertEquals("$0.000123", WalletCore.usd(123)) // a tiny per-invocation debit
        assertEquals("$0.0001", WalletCore.usd(100))
    }

    @Test fun `usd keeps the sign for negative deltas (a debit)`() {
        assertEquals("-$0.40", WalletCore.usd(-400_000))
    }

    @Test fun `usd comma-groups the integer part past a thousand (iOS plus web parity)`() {
        // iOS NumberFormatter(.currency) + web toLocaleString("en-US", currency)
        // both group thousands; Android's %.6f did not → "$1234.57" where the
        // other two show "$1,234.57". Only visible past $1,000, so it lurked.
        assertEquals("$1,234.56789", WalletCore.usd(1_234_567_890))
        assertEquals("$12,345.67", WalletCore.usd(12_345_670_000))
        assertEquals("$1,000.00", WalletCore.usd(1_000_000_000))
        assertEquals("$1,234.50", WalletCore.usd(1_234_500_000))
        // The fractional part is never grouped; sub-$1000 stays ungrouped.
        assertEquals("$999.999999", WalletCore.usd(999_999_999))
        assertEquals("$1.00", WalletCore.usd(1_000_000))
        // Millions get two separators; negatives keep the sign before "$".
        assertEquals("$12,345,678.90", WalletCore.usd(12_345_678_900_000))
        assertEquals("-$1,234.56789", WalletCore.usd(-1_234_567_890))
    }

    @Test fun `usd grouping uses a comma even on a comma-decimal device`() {
        // Standing locale-independence contract (see NumberFormatLocaleTest): the
        // money format must NOT track the device — a de/fr/tr phone still reads
        // "$1,234.57", never "$1.234,57". The comma separator is hard-coded (US).
        val prev = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("$1,234.50", WalletCore.usd(1_234_500_000))
            Locale.setDefault(Locale.forLanguageTag("tr-TR"))
            assertEquals("$12,345.67", WalletCore.usd(12_345_670_000))
        } finally {
            Locale.setDefault(prev)
        }
    }

    // -- priceLabel: per-message badge, strips ALL trailing zeros (iOS/web parity) --

    @Test fun `priceLabel drops cents padding a whole dollar keeps NO decimals`() {
        // The gap: usd() pads to "$1.00"; the badge must read "$1" like iOS/web.
        assertEquals("$1", WalletCore.priceLabel(1_000_000))
        assertEquals("$5", WalletCore.priceLabel(5_000_000))
    }

    @Test fun `priceLabel strips the trailing zero on a half-cent price`() {
        // usd() → "$0.50"; badge → "$0.5" (iOS priceLabel / web replace(/0+$/,'')).
        assertEquals("$0.5", WalletCore.priceLabel(500_000))
        assertEquals("$0.01", WalletCore.priceLabel(10_000))
    }

    @Test fun `priceLabel keeps sub-cent precision up to six digits`() {
        assertEquals("$0.000123", WalletCore.priceLabel(123))
        assertEquals("$0.0001", WalletCore.priceLabel(100))
    }

    @Test fun `priceLabel floors an empty fraction to a bare zero, never a dangling dot`() {
        // iOS guards s.isEmpty ? "0"; a zero price shows "$0" (badge hidden anyway).
        assertEquals("$0", WalletCore.priceLabel(0))
    }

    @Test fun `priceLabel diverges from usd exactly where padding differs`() {
        // Pin the contract: same input, badge strips where the ledger pads.
        assertEquals("$1.00", WalletCore.usd(1_000_000))
        assertEquals("$1", WalletCore.priceLabel(1_000_000))
    }

    // -- kindLabel --

    @Test fun `kindLabel maps the known ledger kinds`() {
        assertEquals("⬇️ Deposit", WalletCore.kindLabel("deposit"))
        assertEquals("🤖 Invocation", WalletCore.kindLabel("invoke_debit"))
        assertEquals("💰 Earned", WalletCore.kindLabel("invoke_credit"))
        assertEquals("⬆️ Withdrawal", WalletCore.kindLabel("withdrawal"))
    }

    @Test fun `kindLabel maps the x402-payer spend kinds`() {
        assertEquals("🤝 Agent payment", WalletCore.kindLabel("spend_debit"))
        assertEquals("↩️ Payment refund", WalletCore.kindLabel("spend_refund"))
    }

    @Test fun `kindLabel passes an unknown kind through verbatim`() {
        assertEquals("some_new_kind", WalletCore.kindLabel("some_new_kind"))
    }

    // -- address / tx-hash validation --

    @Test fun `isValidAddress accepts a 0x-prefixed 40-hex address and trims`() {
        assertTrue(WalletCore.isValidAddress("0x" + "a".repeat(40)))
        assertTrue(WalletCore.isValidAddress("  0x" + "A1b2".repeat(10) + "  "))
    }

    @Test fun `isValidAddress rejects wrong length, missing prefix, non-hex`() {
        assertFalse(WalletCore.isValidAddress("0x" + "a".repeat(39))) // too short
        assertFalse(WalletCore.isValidAddress("a".repeat(40))) // no 0x
        assertFalse(WalletCore.isValidAddress("0x" + "g".repeat(40))) // non-hex
        assertFalse(WalletCore.isValidAddress(""))
    }

    @Test fun `isValidTxHash needs 0x plus 64 hex`() {
        assertTrue(WalletCore.isValidTxHash("0x" + "f".repeat(64)))
        assertFalse(WalletCore.isValidTxHash("0x" + "f".repeat(40))) // an address, not a tx
        assertFalse(WalletCore.isValidTxHash("0x" + "f".repeat(65)))
    }

    // -- parseWithdrawMicro (min $1, rounds to micro) --

    @Test fun `parseWithdrawMicro converts a valid amount at or above the minimum`() {
        assertEquals(1_000_000L, WalletCore.parseWithdrawMicro("1"))
        assertEquals(10_500_000L, WalletCore.parseWithdrawMicro(" 10.50 "))
    }

    @Test fun `parseWithdrawMicro rejects below-minimum and non-numeric input`() {
        assertNull(WalletCore.parseWithdrawMicro("0.99")) // under $1
        assertNull(WalletCore.parseWithdrawMicro(""))
        assertNull(WalletCore.parseWithdrawMicro("abc"))
    }

    @Test fun `parseWithdrawMicro accepts a comma decimal separator (comma-locale keypad parity)`() {
        // KeyboardType.Decimal renders the DEVICE LOCALE's decimal separator — a
        // COMMA on de/fr/tr keypads. Bare toDoubleOrNull only accepts a dot, so
        // "10,50" used to return null → Withdraw button PERMANENTLY disabled for
        // those users. Web (parseDecimalInput → replace(',', '.')) and iOS
        // (Double(raw) ?? Double(raw.replace ',' → '.'), Wallet.swift:203-204)
        // both fall back to a comma→dot swap; this is that parity. A narrow money
        // field never receives grouped thousands, so a comma is the decimal mark.
        assertEquals(10_500_000L, WalletCore.parseWithdrawMicro("10,50"))
        assertEquals(1_000_000L, WalletCore.parseWithdrawMicro(" 1,00 "))
        assertEquals(1_500_000L, WalletCore.parseWithdrawMicro("1,5"))
        assertNull(WalletCore.parseWithdrawMicro("0,99")) // comma path still honors the $1 min
    }

    @Test fun `parseWithdrawMicro rejects non-finite input (isFinite guard, web + iOS parity)`() {
        // Kotlin's toDoubleOrNull ACCEPTS these, and NaN < WITHDRAW_MIN_USD is
        // false, so without the isFinite guard a NaN slipped past the min-check and
        // an infinity flowed into Math.round(v * MICRO_PER_USD). Web checks
        // !Number.isFinite (app/wallet/page.tsx:209) and iOS v.isFinite before the
        // min — this is that shared contract. Fail closed → null (button disabled).
        assertNull(WalletCore.parseWithdrawMicro("NaN"))
        assertNull(WalletCore.parseWithdrawMicro("Infinity"))
        assertNull(WalletCore.parseWithdrawMicro("-Infinity"))
        assertNull(WalletCore.parseWithdrawMicro("1e400")) // overflows a Double to +Inf
    }

    @Test fun `parseWithdrawMicro does not overflow micro on a huge finite entry`() {
        // A large plain-digit entry (typeable on a numeric keypad) previously
        // overflowed Math.round(v * 1e6) toward Long.MAX_VALUE — a garbage micro
        // amount driving the confirm dialog + POST body. A finite value now
        // round-trips honestly: 10_000_000 USD → 10_000_000_000_000 micro, which
        // fits in a Long and equals the amount × MICRO_PER_USD exactly.
        assertEquals(10_000_000_000_000L, WalletCore.parseWithdrawMicro("10000000"))
    }

    // -- withdrawConfirmText (states the exact gross→net split; net floors at $0) --

    @Test fun `withdrawConfirmText states both the gross debit and the net after the flat fee`() {
        val text = WalletCore.withdrawConfirmText(10_000_000L, "base")
        // $10.00 leaves, minus the flat $0.10 gas → $9.90 arrives. Both numbers, not just one.
        assertTrue(text.contains("\$10.00 leaves your balance"))
        assertTrue(text.contains("flat \$0.10 gas fee"))
        assertTrue(text.contains("\$9.90 USDC arrives"))
        assertTrue(text.contains("can't be undone"))
    }

    @Test fun `withdrawConfirmText labels each network by its own name`() {
        assertTrue(WalletCore.withdrawConfirmText(2_000_000L, "base").contains("on Base."))
        assertTrue(WalletCore.withdrawConfirmText(2_000_000L, "base-sepolia").contains("on Sepolia."))
        // An unknown/absent network reads as real Base — the SAFE default (calling
        // real money "trial" is the misread that matters). See WalletTopUpTest for
        // the tiny-chain label the old two-way ternary got wrong.
        assertTrue(WalletCore.withdrawConfirmText(2_000_000L, "").contains("on Base."))
    }

    @Test fun `withdrawConfirmText floors the net at zero and never shows a negative`() {
        // The $1 minimum nets $0.90; a (guarded-out) sub-fee amount would net $0, not negative.
        assertTrue(WalletCore.withdrawConfirmText(1_000_000L, "base").contains("\$0.90 USDC arrives"))
        val tiny = WalletCore.withdrawConfirmText(50_000L, "base") // below the fee
        assertTrue(tiny.contains("\$0.00 USDC arrives"))
        assertFalse(tiny.contains("-$"))
    }

    @Test fun `withdrawConfirmText shows the full sub-cent precision that actually leaves the balance`() {
        // A typed "12.3456" quantizes to 12_345_600 micro — the full precision the
        // payload (parseWithdrawMicro) sends and the success toast reports via usd().
        // The confirm must NOT round to "$12.35" (the old %.2f drift f99933e fixed on
        // web + iOS): the pre-commit number must equal what leaves on an irreversible spend.
        val text = WalletCore.withdrawConfirmText(12_345_600L, "base")
        assertTrue("gross must show full precision, not \$12.35", text.contains("\$12.3456 leaves"))
        // net = 12_345_600 − 100_000 flat fee = 12_245_600 micro → "$12.2456".
        assertTrue("net must show full precision", text.contains("\$12.2456 USDC arrives"))
    }

    // -- parseLedger --

    @Test fun `parseLedger reads balance and maps history rows`() {
        val json = JSONObject(
            """{"ok":true,"balance_micro":2500000,"history":[
                {"delta_micro":1000000,"kind":"admin_credit","ref":"welcome","created":1721000000},
                {"delta_micro":-123,"kind":"invoke_debit","ref":"tiny:foo"}
            ]}""",
        )
        val ledger = WalletCore.parseLedger(json)
        assertEquals(2_500_000L, ledger.balanceMicro)
        assertEquals(2, ledger.entries.size)
        assertEquals("admin_credit", ledger.entries[0].kind)
        assertEquals(1_000_000L, ledger.entries[0].deltaMicro)
        assertEquals(1721000000.0, ledger.entries[0].created!!, 0.0)
        // second row has no `created` → null, and a negative delta preserved
        assertEquals(-123L, ledger.entries[1].deltaMicro)
        assertNull(ledger.entries[1].created)
    }

    @Test fun `parseLedger tolerates a missing history array`() {
        val ledger = WalletCore.parseLedger(JSONObject("""{"balance_micro":0}"""))
        assertEquals(0L, ledger.balanceMicro)
        assertTrue(ledger.entries.isEmpty())
    }

    // -- parseDepositInfo --

    @Test fun `parseDepositInfo maps configured deposit fields`() {
        val json = JSONObject(
            """{"ok":true,"configured":true,"deposit_address":"0xabc","default_network":"base","linked_address":"0xdef"}""",
        )
        val d = WalletCore.parseDepositInfo(json)
        assertTrue(d.configured)
        assertEquals("0xabc", d.depositAddress)
        assertEquals("base", d.chain)
        assertEquals("0xdef", d.linkedAddress)
    }

    @Test fun `parseDepositInfo leaves absent fields null and defaults unconfigured`() {
        val d = WalletCore.parseDepositInfo(JSONObject("""{"ok":true}"""))
        assertFalse(d.configured)
        assertNull(d.depositAddress)
        assertNull(d.chain)
        assertNull(d.linkedAddress)
    }

    @Test fun `parseDepositInfo coerces an EXPLICIT JSON null to a null field, not the literal null string`() {
        // The org.json trap: optString("linked_address","") returns the literal
        // "null" for an explicit JSON null (not absent), and .ifEmpty{null} does
        // NOT catch it — so the linked-address line rendered "✓ null" verbatim.
        // A field-present-but-null response must decode to null for all three.
        val d = WalletCore.parseDepositInfo(
            JSONObject("""{"ok":true,"configured":false,"deposit_address":null,"default_network":null,"linked_address":null}"""),
        )
        assertNull(d.depositAddress)
        assertNull(d.chain)
        assertNull(d.linkedAddress)
    }

    @Test fun `parseDepositInfo treats an empty-string field as null`() {
        val d = WalletCore.parseDepositInfo(
            JSONObject("""{"ok":true,"deposit_address":"","linked_address":""}"""),
        )
        assertNull(d.depositAddress)
        assertNull(d.linkedAddress)
    }

    // -- x402 / ERC-8004 URLs (iOS PricedTiny) --

    @Test fun `x402 and registration urls embed the tiny name`() {
        assertEquals("https://tiny.technology/api/x402/chat/foo", WalletCore.x402Url("foo"))
        assertEquals("https://tiny.technology/api/erc8004/registration/foo", WalletCore.registrationUrl("foo"))
    }

    // -- action result parsing (status folded into the body via _status) --

    @Test fun `parseLinkResult ok reads the server address, falling back to the sent one`() {
        val ok = WalletCore.parseLinkResult(JSONObject("""{"ok":true,"address":"0xServer"}"""), "0xSent")
        assertEquals(WalletCore.LinkResult.Ok("0xServer"), ok)
        val fallback = WalletCore.parseLinkResult(JSONObject("""{"ok":true}"""), "0xSent")
        assertEquals(WalletCore.LinkResult.Ok("0xSent"), fallback)
    }

    @Test fun `parseLinkResult failure surfaces the server error`() {
        val r = WalletCore.parseLinkResult(JSONObject("""{"ok":false,"error":"bad address"}"""), "0xSent")
        assertEquals(WalletCore.LinkResult.Failed("bad address"), r)
    }

    @Test fun `parseClaimResult credits and flags a testnet trial`() {
        val r = WalletCore.parseClaimResult(JSONObject("""{"ok":true,"credited_micro":1000000,"testnet_trial":true}"""))
        assertEquals(WalletCore.ClaimResult.Ok(1_000_000L, alreadyCredited = false, testnetTrial = true), r)
    }

    @Test fun `parseClaimResult recognizes an already-credited tx`() {
        val r = WalletCore.parseClaimResult(JSONObject("""{"ok":true,"already_credited":true}"""))
        assertEquals(WalletCore.ClaimResult.Ok(0L, alreadyCredited = true, testnetTrial = false), r)
    }

    @Test fun `parseClaimResult maps 425 and retry-true to Retry`() {
        val byStatus = WalletCore.parseClaimResult(JSONObject("""{"ok":false,"error":"not confirmed","_status":425}"""))
        assertTrue(byStatus is WalletCore.ClaimResult.Retry)
        val byFlag = WalletCore.parseClaimResult(JSONObject("""{"ok":false,"error":"pending","retry":true}"""))
        assertTrue(byFlag is WalletCore.ClaimResult.Retry)
    }

    @Test fun `parseClaimResult maps a plain failure to Failed with a default message`() {
        val r = WalletCore.parseClaimResult(JSONObject("""{"ok":false}"""))
        assertEquals(WalletCore.ClaimResult.Failed("claim failed"), r)
    }

    @Test fun `parseWithdrawResult ok carries net, fee, and optional explorer`() {
        val r = WalletCore.parseWithdrawResult(
            JSONObject("""{"ok":true,"net_micro":4900000,"fee_micro":100000,"explorer":"https://x"}"""),
        )
        assertEquals(WalletCore.WithdrawResult.Ok(4_900_000L, 100_000L, "https://x"), r)
    }

    @Test fun `parseWithdrawResult maps 202 and pending_confirmation to Pending (not an error)`() {
        val byStatus = WalletCore.parseWithdrawResult(JSONObject("""{"ok":false,"_status":202}"""))
        assertEquals(WalletCore.WithdrawResult.Pending(null), byStatus)
        val byFlag = WalletCore.parseWithdrawResult(JSONObject("""{"pending_confirmation":true}"""))
        assertEquals(WalletCore.WithdrawResult.Pending(null), byFlag)
    }

    @Test fun `parseWithdrawResult carries the explorer link on the pending path too`() {
        // The tx is already broadcast on a 202 — web + iOS surface BaseScan on both
        // the paid and pending paths, so Pending must keep the explorer, not drop it.
        val r = WalletCore.parseWithdrawResult(
            JSONObject("""{"pending_confirmation":true,"explorer":"https://basescan.org/tx/0xabc"}"""),
        )
        assertEquals(WalletCore.WithdrawResult.Pending("https://basescan.org/tx/0xabc"), r)
    }

    @Test fun `parseWithdrawResult surfaces a real failure`() {
        val r = WalletCore.parseWithdrawResult(JSONObject("""{"ok":false,"error":"insufficient balance"}"""))
        assertEquals(WalletCore.WithdrawResult.Failed("insufficient balance"), r)
    }

    // -- request shaping (bodies the repository POSTs; must match ChatViewModel) --

    @Test fun `normNetwork canonicalizes the known aliases and passes others through`() {
        assertNull(WalletCore.normNetwork(null))
        assertNull(WalletCore.normNetwork("  "))
        assertEquals("base", WalletCore.normNetwork("MAINNET"))
        assertEquals("base", WalletCore.normNetwork(" base "))
        assertEquals("base-sepolia", WalletCore.normNetwork("testnet"))
        assertEquals("base-sepolia", WalletCore.normNetwork("trial"))
        assertEquals("optimism", WalletCore.normNetwork(" optimism ")) // unknown → trimmed passthrough
    }

    @Test fun `depositInfoBody and linkAddressBody carry the action and trim the address`() {
        assertEquals("deposit_info", WalletCore.depositInfoBody().getString("action"))
        val link = WalletCore.linkAddressBody("  0xABC  ")
        assertEquals("link_address", link.getString("action"))
        assertEquals("0xABC", link.getString("address"))
    }

    @Test fun `claimBody trims the hash and only includes a normalized network when present`() {
        val bare = WalletCore.claimBody("  0xhash  ", null)
        assertEquals("claim", bare.getString("action"))
        assertEquals("0xhash", bare.getString("txHash"))
        assertFalse(bare.has("network")) // absent network → key omitted entirely
        val netted = WalletCore.claimBody("0xhash", "testnet")
        assertEquals("base-sepolia", netted.getString("network"))
    }

    @Test fun `withdrawBody carries amount_micro and omits an absent network`() {
        val bare = WalletCore.withdrawBody(5_000_000L, null)
        assertEquals(5_000_000L, bare.getLong("amount_micro"))
        assertFalse(bare.has("network"))
        assertEquals("base", WalletCore.withdrawBody(1_000_000L, "mainnet").getString("network"))
    }

    // -- monetize card (owned priced tinys → x402 / ERC-8004 URLs) --

    @Test fun `myTinyNames reads owned names in order, skipping blanks`() {
        val me = JSONObject(
            """{"login":"me","tinys":[{"name":"foo"},{"name":""},{"name":" bar "},{"created":123}]}""",
        )
        assertEquals(listOf("foo", "bar"), WalletCore.myTinyNames(me))
    }

    @Test fun `myTinyNames is empty when there are no tinys`() {
        assertTrue(WalletCore.myTinyNames(JSONObject("""{"login":"me"}""")).isEmpty())
    }

    @Test fun `myTinyNames skips private tinys — their x402 + registration URLs 403`() {
        // A priced-but-private tiny 403s on both /api/x402/chat and its ERC-8004
        // registration file, so it must never reach the monetize URL list.
        val me = JSONObject(
            """{"tinys":[{"name":"pub"},{"name":"secret","private":true},{"name":"pub2","private":false}]}""",
        )
        assertEquals(listOf("pub", "pub2"), WalletCore.myTinyNames(me))
    }

    @Test fun `myOwnedTinys keeps private tinys with their flag, in order`() {
        // Unlike myTinyNames, this KEEPS private ones (name + flag) so the monetize
        // loader can detect a priced-but-private tiny and steer the hint.
        val me = JSONObject(
            """{"tinys":[{"name":"pub"},{"name":"secret","private":true},{"name":" ","private":true},{"name":"pub2"}]}""",
        )
        assertEquals(
            listOf(
                WalletCore.OwnedTiny("pub", false),
                WalletCore.OwnedTiny("secret", true),
                WalletCore.OwnedTiny("pub2", false),
            ),
            WalletCore.myOwnedTinys(me),
        )
    }

    @Test fun `myOwnedTinys is empty when there are no tinys`() {
        assertTrue(WalletCore.myOwnedTinys(JSONObject("""{"login":"me"}""")).isEmpty())
    }

    @Test fun `myTinyNames stays a public-only view over myOwnedTinys`() {
        // The refactor delegates myTinyNames to myOwnedTinys(...).filterNot private
        // — pin that the public-name contract is unchanged.
        val me = JSONObject("""{"tinys":[{"name":"pub"},{"name":"secret","private":true}]}""")
        assertEquals(listOf("pub"), WalletCore.myTinyNames(me))
    }

    @Test fun `the private flag reads truthy whether it arrives as a boolean or a D1 integer`() {
        // org.json optBoolean returns FALSE for the integer 1, so `private:1`
        // (the worker's D1 column form — c9a5354) would leak a private tiny's
        // payable URLs. truthyFlag must coerce 1/true → private, 0/false/absent
        // → public. Web coerces the same via `!!t.private` (wallet/page.tsx:137).
        val me = JSONObject(
            """{"tinys":[
                {"name":"boolPriv","private":true},
                {"name":"intPriv","private":1},
                {"name":"boolPub","private":false},
                {"name":"intPub","private":0},
                {"name":"absent"}
            ]}""",
        )
        assertEquals(
            listOf(
                WalletCore.OwnedTiny("boolPriv", true),
                WalletCore.OwnedTiny("intPriv", true),   // was FALSE before the coercion fix
                WalletCore.OwnedTiny("boolPub", false),
                WalletCore.OwnedTiny("intPub", false),
                WalletCore.OwnedTiny("absent", false),   // fail-open default (iOS parity)
            ),
            WalletCore.myOwnedTinys(me),
        )
        // The leak site: an integer-private tiny must NOT reach the payable-URL list.
        assertEquals(listOf("boolPub", "intPub", "absent"), WalletCore.myTinyNames(me))
    }

    @Test fun `pricingBody carries the action and the tiny resource id`() {
        val b = WalletCore.pricingBody("  foo  ")
        assertEquals("pricing", b.getString("action"))
        assertEquals("tiny:foo", b.getString("resource"))
    }

    @Test fun `parsePriceMicro keeps a positive price and drops free or absent`() {
        assertEquals(50_000L, WalletCore.parsePriceMicro(JSONObject("""{"ok":true,"price_micro":50000}""")))
        assertNull(WalletCore.parsePriceMicro(JSONObject("""{"ok":true,"price_micro":0}""")))
        assertNull(WalletCore.parsePriceMicro(JSONObject("""{"ok":true}""")))
    }

    @Test fun `PricedTiny derives the x402 and registration urls from its name`() {
        val t = WalletCore.PricedTiny("foo", 50_000L)
        assertEquals("https://tiny.technology/api/x402/chat/foo", t.x402Url)
        assertEquals("https://tiny.technology/api/erc8004/registration/foo", t.registrationUrl)
    }

    // -- x402 pay receipt (pay_x402 tool result) --

    @Test fun `shortAddr keeps head and tail of a long address`() {
        assertEquals("0xabcd…1234", WalletCore.shortAddr("0xabcdef0000000000000000000000000000001234"))
    }

    @Test fun `shortAddr passes short or blank input through`() {
        assertEquals("0xabcd", WalletCore.shortAddr("0xabcd"))
        assertEquals("", WalletCore.shortAddr(null))
        assertEquals("", WalletCore.shortAddr("  "))
    }

    @Test fun `shortAddr never truncates a login payee (P2P sends name a person, not hex)`() {
        assertEquals("@a-very-long-login-name", WalletCore.shortAddr("@a-very-long-login-name"))
        assertEquals("@alice", WalletCore.shortAddr("@alice"))
    }

    @Test fun `parsePayReceipt reads a settled payment`() {
        val r = WalletCore.parsePayReceipt(
            JSONObject("""{"ok":true,"paid_micro":500000,"network":"base","payee":"0xabcdef0000000000000000000000000000001234"}""")
        )
        assertTrue(r.paid)
        assertEquals(500_000L, r.paidMicro)
        assertEquals("base", r.network)
        assertNull(r.error)
        assertEquals("Paid \$0.50 to 0xabcd…1234 on Base (real USDC)", r.summary)
    }

    @Test fun `parsePayReceipt surfaces the error on a failed payment`() {
        val r = WalletCore.parsePayReceipt(JSONObject("""{"ok":false,"error":"insufficient balance"}"""))
        assertFalse(r.paid)
        assertEquals("insufficient balance", r.error)
    }

    @Test fun `parsePayReceipt labels a payment_required result even without an error string`() {
        val r = WalletCore.parsePayReceipt(JSONObject("""{"ok":false,"payment_required":true}"""))
        assertFalse(r.paid)
        assertEquals("Payment required.", r.error)
    }

    @Test fun `parsePayReceipt falls back to a generic failure when nothing is set`() {
        val r = WalletCore.parsePayReceipt(JSONObject("""{"ok":false}"""))
        assertFalse(r.paid)
        assertEquals("The payment could not be completed.", r.error)
    }

    @Test fun `parsePayReceipt summary drops a missing payee and network`() {
        val r = WalletCore.parsePayReceipt(JSONObject("""{"ok":true,"paid_micro":250000}"""))
        assertEquals("Paid \$0.25", r.summary)
    }

    // -- x402 quote → approval gate (CONFIRM-EVERY-PAYMENT) --

    @Test fun `parsePayQuote reads a signed quote awaiting approval`() {
        val q = WalletCore.parsePayQuote(
            JSONObject("""{"requires_confirmation":true,"quote":"tok123","price_micro":50000,"network":"base","payee":"0x1234567890abcdef1234567890abcdef12345678","expires_at":1800000000,"message":"hi"}"""),
        )!!
        assertEquals("tok123", q.quote)
        assertEquals(50_000L, q.priceMicro)
        assertEquals("base", q.network)
        assertEquals("0x1234567890abcdef1234567890abcdef12345678", q.payee)
        assertEquals(1_800_000_000.0, q.expiresAt!!, 0.0)
        assertEquals("hi", q.message)
    }

    @Test fun `parsePayQuote returns null when it is not a confirmation quote`() {
        // A settled receipt (ok:true), a free 200 (ok:true no quote), and a bare
        // failure all lack requires_confirmation+quote → no approval gate.
        assertNull(WalletCore.parsePayQuote(JSONObject("""{"ok":true,"paid_micro":50000}""")))
        assertNull(WalletCore.parsePayQuote(JSONObject("""{"ok":false,"error":"nope"}""")))
        // requires_confirmation set but no quote token → still not a usable quote.
        assertNull(WalletCore.parsePayQuote(JSONObject("""{"requires_confirmation":true}""")))
    }

    @Test fun `isQuoteExpired compares expiry seconds against now millis`() {
        assertTrue(WalletCore.isQuoteExpired(1000.0, 2_000_000L)) // exp 1000s = 1_000_000ms < now
        assertFalse(WalletCore.isQuoteExpired(1000.0, 500_000L)) // exp 1_000_000ms > now
        assertFalse(WalletCore.isQuoteExpired(null, 9_999_999L)) // no expiry → never expired
    }

    @Test fun `approveDescription states amount payee and the KIND of money, plus the tap gate`() {
        // The network clause names what approving spends — "real USDC" vs
        // "trial credit" is the entire stake of the tap (was raw "on base").
        assertEquals(
            "This will pay \$0.05 to 0x1234…5678 on Base (real USDC) from your wallet, over x402. It only happens when you tap Approve.",
            WalletCore.approveDescription(50_000L, "0x1234567890abcdef1234567890abcdef12345678", "base"),
        )
        // No payee/network → those clauses drop.
        assertEquals(
            "This will pay \$0.05 from your wallet, over x402. It only happens when you tap Approve.",
            WalletCore.approveDescription(50_000L, null, null),
        )
    }

    @Test fun `approveDescription switches to send wording for a P2P transfer`() {
        assertEquals(
            "This will send \$2.00 to @alice on Tiny Chain (trial credit) from your wallet. It only happens when you tap Approve.",
            WalletCore.approveDescription(2_000_000L, "@alice", "tiny", transfer = true),
        )
    }

    @Test fun `PayQuote isTransfer keys off the transfer sentinel url`() {
        val transfer = WalletCore.PayQuote("tok", 1L, null, "@alice", null, "", url = "transfer:@alice")
        val x402 = WalletCore.PayQuote("tok", 1L, null, "0xabc", null, "", url = "https://tiny.technology/api/x402/chat/acme")
        val none = WalletCore.PayQuote("tok", 1L, null, null, null, "")
        assertTrue(transfer.isTransfer)
        assertFalse(x402.isTransfer)
        assertFalse(none.isTransfer)
    }

    @Test fun `transfer settle keeps its wording through persistence (Sent, from your wallet)`() {
        val quote = WalletCore.PayQuote("tok", 2_000_000L, "tiny", "@alice", null, "", url = "transfer:@alice")
        val settle = WalletCore.parseSettleResult(
            JSONObject("""{"ok":true,"paid_micro":2000000,"transfer":true,"network":"tiny","payee":"@alice"}"""),
            quote,
        ) as WalletCore.SettleResult.Paid
        assertTrue(settle.transfer)
        val persisted = WalletCore.toPersisted(settle)!!
        assertTrue(persisted.transfer)
        assertEquals("Sent \$2.00 to @alice on Tiny Chain (trial credit) from your wallet.", persisted.receiptBody)
        // …and an x402 payment keeps the protocol suffix.
        val x402 = WalletCore.PaySettled("paid", 500_000L, "base", "0xabcdef0000000000000000000000000000001234")
        assertEquals("Paid \$0.50 to 0xabcd…1234 on Base (real USDC) over the x402 protocol.", x402.receiptBody)
    }

    @Test fun `payNetworkDisplay maps only exact known names and never defaults to base`() {
        assertEquals("Tiny Chain (trial credit)", WalletCore.payNetworkDisplay("tiny"))
        assertEquals("Base Sepolia (trial credit)", WalletCore.payNetworkDisplay("base-sepolia"))
        assertEquals("Base (real USDC)", WalletCore.payNetworkDisplay("base"))
        // An unknown chain renders verbatim — asNetwork()'s default-to-base would
        // call it real money, the one direction an approval card must never err.
        assertEquals("eip155:99999", WalletCore.payNetworkDisplay("eip155:99999"))
        assertEquals(null, WalletCore.payNetworkDisplay(null))
        assertEquals(null, WalletCore.payNetworkDisplay("  "))
    }

    @Test fun `a trial-network approve line never reads as real money`() {
        val s = WalletCore.approveDescription(10_000L, null, "tiny")
        assertTrue(s.contains("trial credit"))
        assertFalse(s.contains("real USDC"))
    }

    private fun quoteFixture() = WalletCore.PayQuote("tok", 50_000L, "base", "0xabcdef0000000000000000000000000000001234", 1_800_000_000.0, "hi")

    @Test fun `parseSettleResult reads a settled payment`() {
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":true,"paid_micro":50000,"network":"base","payee":"0xfeed000000000000000000000000000000005678"}"""),
            quoteFixture(),
        )
        r as WalletCore.SettleResult.Paid
        assertEquals(50_000L, r.paidMicro)
        assertEquals("base", r.network)
        assertEquals("0xfeed000000000000000000000000000000005678", r.payee)
    }

    @Test fun `parseSettleResult carries the network-correct explorer link on a paid receipt`() {
        // The execute route derives a BaseScan link from the settlement's
        // X-PAYMENT-RESPONSE header and puts it on the ok:true body; the paid card
        // surfaces it as on-chain proof (withdraw + web + iOS parity).
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":true,"paid_micro":50000,"explorer":"https://basescan.org/tx/0xabc"}"""),
            quoteFixture(),
        )
        r as WalletCore.SettleResult.Paid
        assertEquals("https://basescan.org/tx/0xabc", r.explorer)
    }

    @Test fun `parseSettleResult treats already_paid (409) as paid — never shows not-sent`() {
        // The 409 body carries price_micro (not paid_micro); the money DID move.
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":false,"already_paid":true,"price_micro":50000}"""),
            quoteFixture(),
        )
        r as WalletCore.SettleResult.Paid
        assertEquals(50_000L, r.paidMicro)
        assertEquals("base", r.network) // falls back to the quote's network
        assertNull(r.explorer) // the 409 body carries no settlement receipt (web parity)
    }

    @Test fun `parseSettleResult maps a 202 pending_confirmation to Pending (not retryable)`() {
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":false,"pending_confirmation":true,"error":"sent, confirming"}"""),
            quoteFixture(),
        )
        r as WalletCore.SettleResult.Pending
        assertEquals("sent, confirming", r.message)
    }

    @Test fun `parseSettleResult flags payment_required as a recoverable (needsFunds) failure`() {
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":false,"payment_required":true,"error":"insufficient balance"}"""),
            quoteFixture(),
        )
        r as WalletCore.SettleResult.Failed
        assertTrue(r.needsFunds)
        assertEquals("insufficient balance", r.error)
    }

    @Test fun `parseSettleResult falls back to the quote price so a paid card never reads zero`() {
        // ok:true but the server omitted paid_micro → use the quote's price.
        val r = WalletCore.parseSettleResult(JSONObject("""{"ok":true}"""), quoteFixture())
        r as WalletCore.SettleResult.Paid
        assertEquals(50_000L, r.paidMicro)
    }

    @Test fun `parseSettleResult a plain failure is not marked needsFunds`() {
        val r = WalletCore.parseSettleResult(JSONObject("""{"ok":false,"error":"quote expired"}"""), quoteFixture())
        r as WalletCore.SettleResult.Failed
        assertFalse(r.needsFunds)
        assertEquals("quote expired", r.error)
    }

    // -- networkFailure: a transport blip must not erase a retry's recovery path (iOS c198fdb) --

    @Test fun `networkFailure on a FIRST attempt shows only the inert error, no phantom buttons`() {
        // prior == null → both flags false → just the "check your connection" error.
        val f = WalletCore.networkFailure(null)
        assertFalse(f.needsFunds)
        assertFalse(f.canReQuote)
        assertTrue(f.error.contains("connection"))
    }

    @Test fun `networkFailure during a retry PRESERVES the funds-shortfall affordance`() {
        // First attempt learned it was insufficient-balance (needsFunds=true); a blip on
        // retry must keep Add funds / Retry — the quote moved no money, still spendable.
        val prior = WalletCore.SettleResult.Failed("insufficient balance", needsFunds = true)
        val f = WalletCore.networkFailure(prior)
        assertTrue("a retry blip must keep needsFunds", f.needsFunds)
        assertFalse(f.canReQuote)
    }

    @Test fun `networkFailure during a retry PRESERVES the re-quotable affordance`() {
        // First attempt was expired/terms-changed with a known url (canReQuote=true);
        // a blip on retry must keep "Get fresh quote".
        val prior = WalletCore.SettleResult.Failed("this quote expired", needsFunds = false, canReQuote = true)
        val f = WalletCore.networkFailure(prior)
        assertTrue("a retry blip must keep canReQuote", f.canReQuote)
        assertFalse(f.needsFunds)
    }

    @Test fun `networkFailure ignores a non-Failed prior (a paid or pending state never retries here)`() {
        // Defensive: approve() only enters from AWAITING/FAILED, but a Paid/Pending prior
        // must not project its fields onto the failure — both flags stay false.
        val f = WalletCore.networkFailure(WalletCore.SettleResult.Paid(50_000L, "base", "0xabc"))
        assertFalse(f.needsFunds)
        assertFalse(f.canReQuote)
    }

    // -- re-quote: expired (410) / terms_changed (409) recover in place (web/iOS parity) --

    /** A quote fixture that carries the service url — required for re-quote to be offered. */
    private fun urlQuoteFixture() = WalletCore.PayQuote(
        "tok", 50_000L, "base", "0xabcdef0000000000000000000000000000001234",
        1_800_000_000.0, "hi", url = "https://tiny.technology/api/x402/chat/foo",
    )

    @Test fun `parsePayQuote carries the service url forward for re-quoting`() {
        val q = WalletCore.parsePayQuote(
            JSONObject("""{"requires_confirmation":true,"quote":"t","message":"hi","url":"https://tiny.technology/api/x402/chat/foo"}"""),
        )!!
        assertEquals("https://tiny.technology/api/x402/chat/foo", q.url)
        // An older transcript / free-target result decodes null, not "".
        val noUrl = WalletCore.parsePayQuote(JSONObject("""{"requires_confirmation":true,"quote":"t","message":"hi"}"""))!!
        assertNull(noUrl.url)
    }

    @Test fun `parseSettleResult flags an expired (410) failure as re-quotable when the url is known`() {
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":false,"expired":true,"error":"this quote expired"}"""),
            urlQuoteFixture(),
        )
        r as WalletCore.SettleResult.Failed
        assertTrue("expired + url → re-quotable", r.canReQuote)
        assertFalse(r.needsFunds)
    }

    @Test fun `parseSettleResult flags a terms_changed (409) failure as re-quotable`() {
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":false,"terms_changed":true,"error":"the service's price changed"}"""),
            urlQuoteFixture(),
        )
        r as WalletCore.SettleResult.Failed
        assertTrue(r.canReQuote)
    }

    @Test fun `parseSettleResult never offers re-quote without a url — a fresh POST would 400`() {
        // The same expired reply against a quote that lacks the url (old transcript /
        // free target) must NOT offer re-quote: POST /api/x402/pay needs the url.
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":false,"expired":true,"error":"expired"}"""),
            quoteFixture(), // no url
        )
        r as WalletCore.SettleResult.Failed
        assertFalse(r.canReQuote)
    }

    @Test fun `parseSettleResult a plain failure with a url is still not re-quotable`() {
        // Only expired/terms_changed are re-quotable dead-ends — a generic error is not.
        val r = WalletCore.parseSettleResult(
            JSONObject("""{"ok":false,"error":"something else"}"""),
            urlQuoteFixture(),
        )
        r as WalletCore.SettleResult.Failed
        assertFalse(r.canReQuote)
    }

    @Test fun `reQuoteBody posts the url and the carried message (quote-only, no money)`() {
        val body = WalletCore.reQuoteBody("https://tiny.technology/api/x402/chat/foo", "hi")
        assertEquals("https://tiny.technology/api/x402/chat/foo", body.getString("url"))
        assertEquals("hi", body.getString("message"))
        // No quote/amount fields — this mints a NEW quote, it doesn't settle.
        assertFalse(body.has("quote"))
        // No prior_quote when none is carried — server falls back to the platform ceiling.
        assertFalse(body.has("prior_quote"))
    }

    @Test fun `reQuoteBody carries the expired quote token as prior_quote so the spend cap survives`() {
        // Web (PayReceipt.tsx reQuote() `prior_quote: active.quote`) + iOS (PayQuote.swift
        // reQuote() ["prior_quote": priorQuote]) parity: when the agent set a spend cap and
        // the quote expired, the fresh-quote POST hands the expired token back as prior_quote.
        // The server decodes it (session-matched) and threads maxSpendMicro through
        // effectiveSpendCap — a re-quote can only TIGHTEN the cap, never widen it back to $25.
        val body = WalletCore.reQuoteBody(
            "https://tiny.technology/api/x402/chat/foo", "hi", "expired.signed.token",
        )
        assertEquals("expired.signed.token", body.getString("prior_quote"))
        // Still a quote-only re-mint — NOT a settle (no `quote` key, which the PUT reads).
        assertFalse(body.has("quote"))
    }

    @Test fun `reQuoteBody ignores a blank prior_quote token`() {
        // A missing/blank current token must not post an empty prior_quote (the server
        // would reject the malformed token instead of cleanly falling back to the ceiling).
        val body = WalletCore.reQuoteBody("https://tiny.technology/api/x402/chat/foo", "hi", "")
        assertFalse(body.has("prior_quote"))
    }

    @Test fun `x402PayBody carries the opaque quote token and message verbatim — the settle PUT`() {
        // The mirror of reQuoteBody: reQuote (POST) sends url+message and NO quote;
        // this (PUT /api/x402/pay — the SOLE money-moving call) sends the opaque
        // signed quote token back verbatim plus the message. Both web
        // (PayReceipt.tsx:171 `{quote, message}`) and iOS (PayQuote.swift:360
        // `["quote": …, "message": …]`) PUT exactly these two keys; the token must
        // survive untouched or the settlement writes no ledger row (moves no money).
        val body = WalletCore.x402PayBody("opaque.signed.token", "settle this")
        assertEquals("opaque.signed.token", body.getString("quote"))
        assertEquals("settle this", body.getString("message"))
        // Exactly the two keys the execute route reads — no url (that's re-quote only).
        assertFalse(body.has("url"))
    }

    @Test fun `parseReQuote folds a fresh confirmation quote and carries url + message forward`() {
        // The POST reply omits url + message; they ride the request forward.
        val q = WalletCore.parseReQuote(
            JSONObject("""{"ok":true,"requires_confirmation":true,"quote":"fresh","price_micro":60000,"network":"base","payee":"0xfeed","expires_at":1900000000}"""),
            "https://tiny.technology/api/x402/chat/foo", "hi",
        )!!
        assertEquals("fresh", q.quote)
        assertEquals(60_000L, q.priceMicro)
        assertEquals("https://tiny.technology/api/x402/chat/foo", q.url)
        assertEquals("hi", q.message)
        assertEquals(1_900_000_000.0, q.expiresAt!!, 0.0)
    }

    @Test fun `parseReQuote returns null on a failed or non-quote reply`() {
        val url = "https://x"; val msg = "hi"
        // ok:false → the re-mint itself failed.
        assertNull(WalletCore.parseReQuote(JSONObject("""{"ok":false,"error":"nope"}"""), url, msg))
        // ok but no confirmation flag → not a usable quote.
        assertNull(WalletCore.parseReQuote(JSONObject("""{"ok":true,"quote":"x"}"""), url, msg))
        // confirmation but no quote token.
        assertNull(WalletCore.parseReQuote(JSONObject("""{"ok":true,"requires_confirmation":true}"""), url, msg))
    }

    // -- toPersisted (settle outcome → durable PaySettled, C3 reload) --

    @Test fun `toPersisted carries a Paid outcome verbatim`() {
        val s = WalletCore.toPersisted(WalletCore.SettleResult.Paid(50_000L, "base", "0xabc"))!!
        assertEquals("paid", s.phase)
        assertEquals(50_000L, s.paidMicro)
        assertEquals("base", s.network)
        assertEquals("0xabc", s.payee)
        // The reload receipt reuses the same summary the live card shows.
        assertTrue(s.paidSummary.startsWith("Paid "))
    }

    @Test fun `toPersisted keeps a Pending confirming line`() {
        val s = WalletCore.toPersisted(WalletCore.SettleResult.Pending("confirming on-chain"))!!
        assertEquals("pending", s.phase)
        assertEquals("confirming on-chain", s.message)
    }

    @Test fun `toPersisted drops a Failed outcome — it moved no money and may retry`() {
        assertNull(WalletCore.toPersisted(WalletCore.SettleResult.Failed("insufficient balance", true)))
    }

    // -- paywall (402 body → actionable card) --

    @Test fun `parsePaywall reads price and balance for a funded-but-short user`() {
        val pw = WalletCore.parsePaywall(
            JSONObject("""{"error":"Insufficient balance…","payment_required":true,"price_micro":50000,"balance_micro":10000}"""),
        )!!
        assertEquals(50_000L, pw.priceMicro)
        assertEquals(10_000L, pw.balanceMicro)
        assertFalse(pw.signedOut)
        // Shortfall $0.04 (price − balance) is surfaced so the user knows the top-up
        // amount without mental subtraction (web Chat.tsx:3490 + iOS Views.swift parity).
        assertEquals(
            "It charges \$0.05 per message · your balance is \$0.01 — add at least \$0.04 to continue.",
            pw.detail,
        )
    }

    @Test fun `paywall detail names the exact top-up shortfall (web plus iOS parity)`() {
        // The whole point: don't make the user subtract balance from price on a money card.
        val pw = WalletCore.Paywall(priceMicro = 30_000L, balanceMicro = 5_000L, signedOut = false)
        assertEquals(
            "It charges \$0.03 per message · your balance is \$0.005 — add at least \$0.025 to continue.",
            pw.detail,
        )
    }

    @Test fun `paywall detail falls back to the plain line when balance is not below price`() {
        // Guard on shortfall > 0: an insufficient-balance 402 always has balance < price,
        // but an equal/stale read must NOT render "add $0.00 to continue" — plain line instead.
        val equal = WalletCore.Paywall(priceMicro = 50_000L, balanceMicro = 50_000L, signedOut = false)
        assertEquals("It charges \$0.05 per message · your balance is \$0.05.", equal.detail)
        // Balance above price (stale) also falls back rather than showing a negative top-up.
        val over = WalletCore.Paywall(priceMicro = 50_000L, balanceMicro = 60_000L, signedOut = false)
        assertEquals("It charges \$0.05 per message · your balance is \$0.06.", over.detail)
    }

    @Test fun `parsePaywall flags a signed-out 402 (no balance field, sign-in copy)`() {
        // Server omits balance_micro when signed out and the message says "Sign in" (route.ts:259).
        val pw = WalletCore.parsePaywall(
            JSONObject("""{"error":"This tiny charges 0.05 per message. Sign in and fund your wallet at /wallet to chat.","payment_required":true,"price_micro":50000}"""),
        )!!
        assertTrue(pw.signedOut)
        assertEquals("It charges \$0.05 per message. Sign in and add funds to continue.", pw.detail)
    }

    @Test fun `parsePaywall does not flag signed-out when a balance field is present`() {
        // A funded-but-short 402 carries balance_micro even at 0 — not a sign-in case.
        val pw = WalletCore.parsePaywall(
            JSONObject("""{"error":"Insufficient balance… sign in? no.","payment_required":true,"price_micro":50000,"balance_micro":0}"""),
        )!!
        assertFalse(pw.signedOut)
    }

    @Test fun `parsePaywall returns null when the body is not the paywall shape`() {
        assertNull(WalletCore.parsePaywall(JSONObject("""{"error":"connection lost"}""")))
        assertNull(WalletCore.parsePaywall(JSONObject("""{"payment_required":false}""")))
    }

    @Test fun `parsePaywall prefers the authoritative signed_out flag over the copy derivation`() {
        // Server now emits signed_out explicitly (route.ts). When present it wins,
        // even against a body whose copy/balance would derive the OPPOSITE — the
        // whole point of the flag is to stop three clients string-matching "sign in".
        val flaggedOut = WalletCore.parsePaywall(
            JSONObject("""{"error":"charges apply","payment_required":true,"price_micro":50000,"signed_out":true}"""),
        )!!
        assertTrue(flaggedOut.signedOut) // no "sign in" in copy, yet the flag says signed-out

        val flaggedIn = WalletCore.parsePaywall(
            JSONObject("""{"error":"Please sign in first","payment_required":true,"price_micro":50000,"balance_micro":0,"signed_out":false}"""),
        )!!
        assertFalse(flaggedIn.signedOut) // "sign in" copy + zero balance, but the flag says NOT signed-out
    }

    // Get-USDC source gating + the whole top-up route decision now live in
    // [WalletTopUpTest] — they key on the server's `faucet.available`, not on a bare
    // chain string, so they need the full DepositInfo those tests build.
}

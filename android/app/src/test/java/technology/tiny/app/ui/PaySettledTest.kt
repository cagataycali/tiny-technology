package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import technology.tiny.app.wallet.WalletCore

/**
 * PaySettled — the persisted terminal outcome behind the pay_x402 receipt card.
 * It's the Android twin of iOS PaySettled (C3): a settled payment must survive
 * LazyColumn recycling / process death and come back as its RECEIPT, not a live
 * "Approve" card whose TTL has passed (an invite to pay the counterparty twice).
 * This pins the safety-critical contract:
 *   - which outcomes persist (paid/pending/declined) vs re-derive (failed)
 *   - the round-trip back to a phase + SettleResult a seeded card renders from
 */
class PaySettledTest {

    // ── What persists vs what re-derives (the double-pay guard's core rule) ──

    @Test fun `paid persists with its amount, payee, and explorer link`() {
        val s = PaySettled.of(WalletCore.SettleResult.Paid(500_000L, "base", "alice", "https://basescan.org/tx/0xabc"))!!
        assertEquals("paid", s.outcome)
        assertEquals(500_000L, s.paidMicro)
        assertEquals("base", s.network)
        assertEquals("alice", s.payee)
        // The on-chain proof must survive a cold reload so the reconstructed receipt
        // still offers "↗ View on BaseScan" (web/iOS parity).
        assertEquals("https://basescan.org/tx/0xabc", s.explorer)
    }

    @Test fun `pending persists with its confirming message`() {
        val s = PaySettled.of(WalletCore.SettleResult.Pending("confirming on-chain"))!!
        assertEquals("pending", s.outcome)
        assertEquals("confirming on-chain", s.message)
    }

    @Test fun `failed is NOT persisted — it moved no money and may be retryable`() {
        // The crux: a failed attempt must re-derive to awaiting on recycle, never
        // freeze as a receipt. of() returns null for both failure shapes.
        assertNull(PaySettled.of(WalletCore.SettleResult.Failed("insufficient balance", needsFunds = true)))
        assertNull(PaySettled.of(WalletCore.SettleResult.Failed("network error", needsFunds = false)))
    }

    // ── Round-trip back into the card's live state ──

    @Test fun `paid seeds the PAID phase and a Paid SettleResult`() {
        val s = PaySettled("paid", 250_000L, "base", "bob", explorer = "https://basescan.org/tx/0xdef")
        assertEquals(PayPhase.PAID, s.toPhase())
        val r = s.toSettleResult() as WalletCore.SettleResult.Paid
        assertEquals(250_000L, r.paidMicro)
        assertEquals("base", r.network)
        assertEquals("bob", r.payee)
        assertEquals("https://basescan.org/tx/0xdef", r.explorer)
    }

    @Test fun `pending seeds the PENDING phase and a Pending SettleResult`() {
        val s = PaySettled("pending", message = "sent, confirming")
        assertEquals(PayPhase.PENDING, s.toPhase())
        assertEquals("sent, confirming", (s.toSettleResult() as WalletCore.SettleResult.Pending).message)
    }

    @Test fun `declined seeds the DECLINED phase and carries no SettleResult`() {
        // The declined card renders from phase alone (fixed "you declined" copy),
        // so there's no SettleResult to seed.
        val s = PaySettled.DECLINED
        assertEquals("declined", s.outcome)
        assertEquals(PayPhase.DECLINED, s.toPhase())
        assertNull(s.toSettleResult())
    }
}

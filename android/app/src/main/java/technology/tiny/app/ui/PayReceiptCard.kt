package technology.tiny.app.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.wallet.WalletCore

/**
 * 🤝 x402 payment — quote → USER approval → receipt (pay_x402 tool; web
 * PayReceipt.tsx / iOS PayQuoteCard parity).
 *
 * CONFIRM-EVERY-PAYMENT: an agent that calls pay_x402 gets back a signed QUOTE —
 * NO money moves. This card is the user's approval gate: only the Approve tap
 * calls PUT /api/x402/pay (the sole money-moving path). The agent has no way to
 * press this button, so a runaway agent can never drain the wallet unattended.
 *
 * States: awaiting (quote + Approve/Decline) → paying (spinner) → paid (receipt) /
 * pending (sent, confirming — NOT retryable) / failed (reason, + Add funds/Retry
 * when recoverable) / declined. A settled receipt, a free "no payment needed" 200,
 * or a tool failure short-circuit to the right terminal state.
 *
 * Before this, Android mis-read a quote (ok:false) as "Payment not sent" — a
 * runaway agent's quote showed as a failed charge AND there was no way to approve.
 */
internal enum class PayPhase { AWAITING, PAYING, PAID, PENDING, FAILED, DECLINED }

/**
 * The terminal, PERSISTED result of an approved (or declined) quote — the Android
 * twin of iOS PaySettled (C3). Held via rememberSaveable so a settled card survives
 * LazyColumn recycling + process death and comes back as its RECEIPT, not a live
 * "Approve" card whose 5-min TTL has passed (an invite to pay twice). Only the
 * money-outcome states are representable here — `failed` is deliberately absent
 * (it moved nothing and may be retryable, so it re-derives as awaiting).
 */
internal class PaySettled(
    val outcome: String,        // "paid" | "pending" | "declined"
    val paidMicro: Long = 0L,
    val network: String? = null,
    val payee: String? = null,
    val message: String? = null,
    val explorer: String? = null, // paid's network-correct BaseScan link
    val transfer: Boolean = false, // P2P send — keeps the "Sent … from your wallet" wording
) {
    fun toPhase(): PayPhase = when (outcome) {
        "paid" -> PayPhase.PAID
        "pending" -> PayPhase.PENDING
        else -> PayPhase.DECLINED
    }

    /** The SettleResult a seeded card renders from (declined carries none). */
    fun toSettleResult(): WalletCore.SettleResult? = when (outcome) {
        "paid" -> WalletCore.SettleResult.Paid(paidMicro, network, payee, explorer, transfer)
        "pending" -> WalletCore.SettleResult.Pending(message ?: "")
        else -> null
    }

    companion object {
        val DECLINED = PaySettled("declined")

        /** A money-moved outcome to persist, or null for `failed` (not persisted). */
        fun of(r: WalletCore.SettleResult): PaySettled? = when (r) {
            is WalletCore.SettleResult.Paid -> PaySettled("paid", r.paidMicro, r.network, r.payee, explorer = r.explorer, transfer = r.transfer)
            is WalletCore.SettleResult.Pending -> PaySettled("pending", message = r.message)
            is WalletCore.SettleResult.Failed -> null
        }
    }
}

/** Flattens PaySettled to a saveable list of primitives (Bundle-safe types only). */
private val PaySettledSaver = listSaver<PaySettled?, Any?>(
    save = { s -> if (s == null) emptyList() else listOf(s.outcome, s.paidMicro, s.network, s.payee, s.message, s.explorer, s.transfer) },
    restore = { l ->
        if (l.isEmpty()) null
        else PaySettled(
            outcome = l[0] as String,
            paidMicro = l[1] as Long,
            network = l[2] as String?,
            payee = l[3] as String?,
            message = l[4] as String?,
            explorer = l.getOrNull(5) as String?,
            transfer = l.getOrNull(6) as? Boolean ?: false,
        )
    },
)

/**
 * The DURABLE receipt for an already-settled pay_x402 card, rendered on a cold
 * reload when the transient toolCall no longer exists (MessageCodec drops toolCalls,
 * so the live PayReceiptCard can't come back — only its outcome, persisted onto the
 * message, does). This is the reload twin of the live card's terminal states, driven
 * off the WalletCore.PaySettled record instead of a fresh quote. iOS/web re-render
 * the same seeded card because they persist the quote itself; Android reconstructs
 * the receipt from the outcome alone.
 */
@Composable
fun PaySettledReceiptCard(settled: WalletCore.PaySettled) {
    val accent = MaterialTheme.colorScheme.primary
    val err = MaterialTheme.colorScheme.error
    when (settled.phase) {
        "paid" -> ShellContent(tone = accent) {
            Header(tone = accent, title = "Payment sent", body = settled.receiptBody)
            settled.explorer?.let { ExplorerLink(it, accent) }
        }
        "pending" -> Shell(tone = accent, title = "Payment sent — confirming",
            body = settled.message?.takeIf { it.isNotEmpty() }
                ?: "The payment was sent and is confirming on-chain. It'll be verified shortly — no need to retry.")
        else -> Shell(tone = err, title = "Payment declined",
            body = "You declined this payment. Nothing was charged.")
    }
}

@Composable
fun PayReceiptCard(call: ToolCall, onSettled: (WalletCore.PaySettled) -> Unit = {}) {
    val result = call.resultText
        ?.takeIf { it.isNotBlank() }
        ?.let { runCatching { JSONObject(it.trim()) }.getOrNull() }
    // Still streaming when the tool hasn't landed a result or explicit error yet.
    val quoting = result == null && call.error == null && call.status != "error"
    val streamed = result?.let { runCatching { WalletCore.parsePayQuote(it) }.getOrNull() }
    // A ran-but-failed tool result that never produced a quote (login/allowlist/parse).
    val toolFailed = !quoting && streamed == null && result?.optBoolean("ok", false) != true

    val accent = MaterialTheme.colorScheme.primary
    val err = MaterialTheme.colorScheme.error

    // ── Quoting (streaming) — the quote is still being fetched.
    if (quoting) {
        Shell(tone = accent, spinner = true, title = "Preparing payment…",
            body = "Fetching the price over x402…")
        return
    }
    // ── Terminal: the tool never produced a quote (parse/login/allowlist error).
    if (toolFailed) {
        Shell(tone = err, title = "Payment not sent",
            body = result?.optString("error")?.takeIf { it.isNotEmpty() }
                ?: call.error ?: "Couldn't prepare the payment.")
        return
    }
    // ── A succeeded result that carries NO quote: no confirmation needed (the
    // target was free — a 200 relayed instead of a 402, so no quote was minted).
    if (streamed == null) {
        Shell(tone = accent, title = "No payment needed",
            body = "This service responded without charging — nothing was paid.")
        return
    }

    // ── The approval gate + its post-tap outcomes. Local state drives the flow
    // AFTER the quote lands; the settlement is triggered by the tap, not the stream.
    val ctx = LocalContext.current
    val app = ctx.applicationContext as TinyApp
    val uriHandler = LocalUriHandler.current
    val scope = rememberCoroutineScope()

    // The TERMINAL outcome, persisted across LazyColumn recycling AND process death
    // (rememberSaveable) so a payment the user already sent doesn't resurface as a
    // live "Approve" card when it scrolls off-screen and back — the double-pay trap
    // iOS PayQuoteCard.seedFromPersisted + web C3 both close. `failed` is NOT stored:
    // it moved no money and the quote may still be retryable, so it re-derives as
    // awaiting (iOS parity). jti server-dedup is only defense-in-depth behind this.
    var persisted by rememberSaveable(call.id, stateSaver = PaySettledSaver) {
        mutableStateOf<PaySettled?>(null)
    }
    // The live flow. `remember` is discarded on recycle, so it RE-SEEDS from the
    // surviving `persisted` record — a settled card comes back as its receipt.
    var phase by remember(call.id) { mutableStateOf(persisted?.toPhase() ?: PayPhase.AWAITING) }
    var settled by remember(call.id) { mutableStateOf(persisted?.toSettleResult()) }
    // Synchronous in-flight latch: the recompose that hides the button is async, so
    // a fast double-tap could fire two PUTs. The server dedupes on the quote's jti,
    // but we stop the second here too (web `inFlight` ref).
    var inFlight by remember(call.id) { mutableStateOf(false) }
    // A client re-minted quote (see reQuote). When set it REPLACES the streamed quote
    // as the live `active` one, so an expired/terms-changed dead-end recovers in place
    // without a fresh agent turn (web PayReceipt's `fresh ?? result`; iOS `fresh`).
    var fresh by remember(call.id) { mutableStateOf<WalletCore.PayQuote?>(null) }
    var reQuoting by remember(call.id) { mutableStateOf(false) }
    // The quote every render + tap reads from: a re-minted one if we have it, else the
    // streamed original.
    val quote = fresh ?: streamed

    fun approve() {
        // One PUT per tap: allow the first approval and a retry after a recoverable
        // failure, but never while in flight or after a terminal success/decline.
        if (phase != PayPhase.AWAITING && phase != PayPhase.FAILED) return
        if (inFlight) return
        // Re-check expiry at tap-time (web re-reads Date.now() in approve, not render).
        // An expired quote we hold the url for is re-quotable in place, so the failed
        // card offers "Get fresh quote" rather than dead-ending.
        if (WalletCore.isQuoteExpired(quote.expiresAt, System.currentTimeMillis())) {
            settled = WalletCore.SettleResult.Failed(
                "This quote expired — ask again for a fresh price.",
                needsFunds = false,
                canReQuote = quote.url != null,
            )
            phase = PayPhase.FAILED
            return
        }
        inFlight = true
        phase = PayPhase.PAYING
        val prior = settled // the FAILED we're retrying from (null on a first attempt)
        scope.launch {
            val r = runCatching {
                app.api.putJson("/api/x402/pay", WalletCore.x402PayBody(quote.quote, quote.message))
            }.getOrNull()
            // A null reply is a TRANSPORT failure — don't run it through parseSettleResult
            // (which would read needsFunds/canReQuote=false off the absent body and erase a
            // retry's recovery path). Preserve the prior attempt's flags instead (iOS c198fdb
            // / web PayReceipt re-derives from retained settled). A real reply is authoritative.
            val outcome = if (r == null) WalletCore.networkFailure(prior)
                else WalletCore.parseSettleResult(r, quote)
            settled = outcome
            phase = when (outcome) {
                is WalletCore.SettleResult.Paid -> PayPhase.PAID
                is WalletCore.SettleResult.Pending -> PayPhase.PENDING
                is WalletCore.SettleResult.Failed -> PayPhase.FAILED
            }
            // Persist the MONEY-MOVED terminal states only. A failed attempt moved
            // nothing and may be retryable, so it stays ephemeral (re-derives to
            // awaiting on recycle) — matching iOS's `failed`-left-as-awaiting rule.
            persisted = PaySettled.of(outcome)
            // Also persist the money-moved outcome onto the MESSAGE (via the VM), so it
            // survives a cold reload where the toolCall — and this whole card — is gone.
            WalletCore.toPersisted(outcome)?.let(onSettled)
            inFlight = false // allow a retry after a recoverable failure
        }
    }

    // ── Re-mint a fresh quote for the same service (moves NO money). Used when the
    // current quote is unusable — expired (410) or the service changed its terms (409,
    // reservation reversed server-side) — so the card recovers in place without a new
    // agent turn. The streamed quote carries the original url + message forward. Web
    // parity: reQuote(); iOS reQuote().
    fun reQuote() {
        val url = quote.url ?: return
        if (reQuoting) return
        reQuoting = true
        scope.launch {
            val r = runCatching {
                app.api.postJson("/api/x402/pay", WalletCore.reQuoteBody(url, quote.message, quote.quote))
            }.getOrElse { JSONObject().put("ok", false) }
            val fq = WalletCore.parseReQuote(r, url, quote.message)
            reQuoting = false
            if (fq != null) {
                // Swap in the fresh quote and drop back to the approval gate.
                fresh = fq
                settled = null
                phase = PayPhase.AWAITING
            } else {
                settled = WalletCore.SettleResult.Failed(
                    r.optString("error").takeIf { it.isNotEmpty() }
                        ?: "Couldn't get a fresh quote — try asking again.",
                    needsFunds = false,
                )
                phase = PayPhase.FAILED
            }
        }
    }

    when (phase) {
        PayPhase.PAYING -> Shell(tone = accent, spinner = true, title = "Sending payment…",
            body = if (quote.isTransfer) "Moving the money between wallets — don’t close this."
                   else "Settling USDC over x402 — don’t close this.")

        PayPhase.PAID -> {
            val p = settled as WalletCore.SettleResult.Paid
            val line = WalletCore.PayReceipt(true, p.paidMicro, p.network, p.payee, null, p.transfer).summary
            ShellContent(tone = accent, live = LiveRegionMode.Polite) {
                Header(tone = accent, title = "Payment sent",
                    body = line + if (p.transfer) " from your wallet." else " over the x402 protocol.")
                // On-chain proof: a tappable BaseScan link the execute route derived from
                // the settlement's X-PAYMENT-RESPONSE header (withdraw + web + iOS parity).
                p.explorer?.let { ExplorerLink(it, accent) }
            }
        }

        PayPhase.PENDING -> Shell(tone = accent, title = "Payment sent — confirming",
            body = (settled as? WalletCore.SettleResult.Pending)?.message
                ?: "The payment was sent and is confirming on-chain. It'll be verified shortly — no need to retry.",
            live = LiveRegionMode.Polite)

        PayPhase.DECLINED -> Shell(tone = err, title = "Payment declined",
            body = "You declined this payment. Nothing was charged.",
            live = LiveRegionMode.Polite)

        PayPhase.FAILED -> {
            val f = settled as? WalletCore.SettleResult.Failed
            // An insufficient-balance failure is recoverable: the quote wrote no
            // ledger row, so a top-up + retry settles it — but only while unexpired
            // (past exp the server 410s the retry).
            val stillValid = !WalletCore.isQuoteExpired(quote.expiresAt, System.currentTimeMillis())
            ShellContent(tone = err, live = LiveRegionMode.Assertive) {
                Header(tone = err, title = "Payment not sent",
                    body = f?.error ?: "The payment could not be completed.")
                if (f?.needsFunds == true && stillValid) {
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { uriHandler.openUri("${app.config.serverBase}/wallet") },
                            colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = MaterialTheme.colorScheme.onPrimary),
                            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                        ) { Text("💳 Add funds", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold) }
                        OutlinedButton(
                            onClick = { approve() },
                            border = BorderStroke(1.dp, accent.copy(alpha = 0.4f)),
                            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                        ) { Text("↻ Retry", style = MaterialTheme.typography.labelMedium, color = accent) }
                    }
                } else if (f?.canReQuote == true) {
                    // Expired (410) / terms_changed (409) — re-mint a fresh quote in
                    // place (moves no money). Web parity: "Get fresh quote".
                    Spacer(Modifier.height(10.dp))
                    Button(
                        onClick = { reQuote() },
                        enabled = !reQuoting,
                        colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = MaterialTheme.colorScheme.onPrimary),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                    ) {
                        Text(if (reQuoting) "Getting a fresh quote…" else "↻ Get fresh quote",
                            style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }

        PayPhase.AWAITING -> {
            // An already-expired quote must not present a live Approve button that
            // dead-ends on tap. When we have the url it was minted for, the primary
            // button flips to "Get fresh quote" (re-mint in place); otherwise it stays
            // a disabled Approve (iOS .disabled(expired) / web `expired ? reQuote…`).
            val expired = WalletCore.isQuoteExpired(quote.expiresAt, System.currentTimeMillis())
            val canReQuoteExpired = expired && quote.url != null
            ShellContent(tone = accent) {
                Header(tone = accent, title = "Approve payment?",
                    body = WalletCore.approveDescription(quote.priceMicro, quote.payee, quote.network, quote.isTransfer))
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { if (canReQuoteExpired) reQuote() else approve() },
                        enabled = !reQuoting && !(expired && quote.url == null),
                        colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = MaterialTheme.colorScheme.onPrimary),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                    ) {
                        Text(
                            when {
                                canReQuoteExpired -> if (reQuoting) "Getting a fresh quote…" else "↻ Get fresh quote"
                                else -> "✓ Approve ${WalletCore.usd(quote.priceMicro)}"
                            },
                            style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                        )
                    }
                    OutlinedButton(
                        onClick = {
                            phase = PayPhase.DECLINED; persisted = PaySettled.DECLINED
                            onSettled(WalletCore.PaySettled("declined"))
                        },
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                    ) { Text("Decline", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                if (expired) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        if (quote.url != null) "This quote expired — get a fresh price to continue."
                        else "This quote expired — ask again for a fresh price.",
                        style = MaterialTheme.typography.labelSmall, color = err,
                    )
                }
            }
        }
    }
}

/** A tappable "↗ View on <explorer>" link under a paid receipt — on-chain proof of
 *  a settled x402 payment. Mirrors the withdraw card's link (Wallet.kt) and
 *  web/iOS. The explorer is NAMED after wherever the URL actually points (
 *  WalletCore.explorerLinkLabel), so a self-hosted deployment doesn't credit
 *  Base's explorer for its own; explorerHref is also the scheme gate, and a URL
 *  it rejects renders no link at all rather than an unopenable one. */
@Composable
private fun ExplorerLink(url: String, tone: androidx.compose.ui.graphics.Color) {
    val uriHandler = LocalUriHandler.current
    val href = WalletCore.explorerHref(url) ?: return
    Spacer(Modifier.height(6.dp))
    Text(
        "↗ " + WalletCore.explorerLinkLabel(href),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = tone,
        modifier = Modifier.clickable(onClickLabel = WalletCore.explorerOpenHint(href)) { uriHandler.openUri(href) },
    )
}

/** One-line status shell (spinner or 🤝 icon + title + body) — the terminal states. */
@Composable
private fun Shell(
    tone: androidx.compose.ui.graphics.Color, title: String, body: String,
    spinner: Boolean = false, live: LiveRegionMode? = null,
) {
    ShellContent(tone = tone, live = live) { Header(tone = tone, title = title, body = body, spinner = spinner) }
}

/**
 * The card frame (accent/danger glass, matching PaywallCard) around arbitrary content.
 *
 * `live` announces a terminal outcome to TalkBack. This is a MONEY card: the phase
 * swaps content IN PLACE (Approve gate → PAID/FAILED) without moving focus, so
 * without a liveRegion a blind user taps Approve and hears silence exactly when
 * the payment resolves. Polite for a success/pending/declined result, Assertive
 * for a failure worth interrupting — mirroring web PayReceipt's role="status"/
 * "alert" and iOS's AccessibilityNotification.Announcement. The Approve gate and
 * the PAYING spinner pass null (the gate is a prompt, not a result; the spinner
 * already reads as busy) — the same rule web applies (PayReceipt.tsx:425).
 */
@Composable
private fun ShellContent(
    tone: androidx.compose.ui.graphics.Color,
    live: LiveRegionMode? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(tone.copy(alpha = 0.4f))
            .padding(1.dp)
            .clip(RoundedCornerShape(11.dp))
            .background(tone.copy(alpha = 0.08f))
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .animateContentSize()
            .then(if (live != null) Modifier.semantics { liveRegion = live } else Modifier),
        content = content,
    )
}

@Composable
private fun Header(tone: androidx.compose.ui.graphics.Color, title: String, body: String, spinner: Boolean = false) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        // Drop the decorative 🤝 (and the spinner) from the a11y tree — otherwise
        // TalkBack reads "handshake" as its own node before the copy on this
        // money-critical pay card. Web marks the icon aria-hidden + wraps the copy
        // in role="alert"/"status" (PayReceipt.tsx); iOS hides the SF Symbol +
        // .accessibilityElement(children:.combine) (PayQuote.swift); this is the
        // Android twin, matching the paywall card's own fix (PaywallCard.kt:66-91).
        if (spinner) {
            CircularProgressIndicator(
                Modifier.size(16.dp).padding(top = 2.dp).clearAndSetSemantics {},
                strokeWidth = 2.dp, color = tone,
            )
        } else {
            Text("🤝", modifier = Modifier.padding(top = 1.dp).clearAndSetSemantics {}, style = MaterialTheme.typography.titleSmall)
        }
        // Merge title + body into ONE announcement so TalkBack speaks the whole
        // status as a single sentence, not two isolated fragments. The buttons live
        // OUTSIDE Header (in the ShellContent callers), each a distinct actionable node.
        Column(
            Modifier.weight(1f).semantics(mergeDescendants = true) {},
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = tone)
            Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

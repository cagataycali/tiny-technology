package technology.tiny.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Eco
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.MonetizationOn
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Science
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Upload
import androidx.compose.material.icons.outlined.WaterDrop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import technology.tiny.app.TinyApp
import technology.tiny.app.ui.theme.TinyGray
import technology.tiny.app.wallet.WalletCore
import technology.tiny.app.wallet.WalletRepository

/**
 * 💰 Wallet — the native port of iOS WalletView / web app/wallet/page.tsx: the
 * one payment surface that used to live only as text slash-commands buried in
 * ChatViewModel. Balance, get-USDC onramps, deposit (link address → claim by tx
 * hash), self-serve withdraw, and the activity ledger — all against the same
 * session-gated /api/wallet the web + iOS hit.
 *
 * All decisions (money math, validation, request bodies, status→result mapping)
 * live in the pure, unit-tested [WalletCore]; every network call goes through
 * [WalletRepository] (slice 2), so this file is just the surface — no JSON, no
 * TinyApi, no wire shapes. Money is micro-USDC (1_000_000 = $1).
 *
 * The "monetize" card surfaces for every tiny owner — priced tinys show their
 * copyable x402 + ERC-8004 URLs, an owner with none priced sees the pricing hint
 * — a best-effort /api/me + per-tiny pricing load ([WalletRepository.monetize]).
 * At full iOS WalletView parity.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalletSheet(app: TinyApp, onDismiss: () -> Unit) {
    val repo = remember { WalletRepository(app.api) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val nowMs = remember { System.currentTimeMillis() }

    // 3-state load, same discipline as JobsSheet/UniverseSheet: an outage → Retry,
    // never a false-empty. null ledger + failed flag distinguishes the two.
    var ledger by remember { mutableStateOf<WalletCore.Ledger?>(null) }
    var deposit by remember { mutableStateOf<WalletCore.DepositInfo?>(null) }
    var monetize by remember { mutableStateOf(WalletCore.Monetize(false, emptyList())) }
    var failed by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        failed = false
        val l = repo.ledger()
        if (l == null) { failed = true; return@LaunchedEffect }
        ledger = l
        // Deposit info + monetize state are best-effort — their cards just hide on
        // failure or when the user owns no tiny at all (iOS loadPricedTinys).
        deposit = repo.depositInfo()
        monetize = repo.monetize()
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item {
                SheetTitle(Icons.Outlined.AccountBalanceWallet, "wallet")
                Spacer(Modifier.height(12.dp))
            }
            when {
                failed && ledger == null -> item {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        Text("couldn't reach the wallet service", color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                        TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                ledger == null -> item { Text("loading your wallet…", color = TinyGray) }
                else -> {
                    val l = ledger!!
                    item { BalanceCard(l.balanceMicro) }
                    item { Spacer(Modifier.height(12.dp)) }
                    // "What is this?" x402 explainer — the one surface that teaches
                    // what the wallet IS (pay paid AIs, earn with your own, get paid
                    // by any agent over x402, real USDC on Base) instead of only how
                    // to deposit/withdraw. Web has it (app/wallet/page.tsx:393); the
                    // natives had nothing that explained *paying another agent* — the
                    // exact gap behind "people don't understand x402." Auto-opens for
                    // newcomers (zero balance AND zero activity), like web.
                    item {
                        WhatIsWalletCard(newcomer = l.balanceMicro == 0L && l.entries.isEmpty())
                    }
                    item { Spacer(Modifier.height(12.dp)) }
                    val d = deposit
                    // The faucet route needs NO linked address (we credit the ledger
                    // directly), so it shows as soon as the server advertises one —
                    // gating it behind `configured || linkedAddress` would hide the
                    // ONLY way to get money on a chain we host from a brand-new user.
                    if (d != null && (d.linkedAddress != null || d.configured || d.faucet?.available == true)) {
                        item {
                            GetUsdcCard(
                                deposit = d,
                                context = context,
                                onClaimFaucet = { onMsg ->
                                    scope.launch {
                                        when (val r = repo.claimFaucet()) {
                                            is WalletCore.FaucetResult.Ok -> {
                                                onMsg(
                                                    "✓ Credited ${WalletCore.usd(r.creditedMicro)} trial credit — spendable inside tiny, not withdrawable as real USDC.",
                                                    false,
                                                )
                                                // Refresh BOTH the balance and the faucet's own
                                                // remaining/claimed_today figures — otherwise the
                                                // button still reads "Claim $1" after a successful
                                                // claim and 429s on the next press.
                                                reloadKey++
                                            }
                                            // The worker's 429 and 400 are DELIBERATELY different
                                            // instructions ("come back tomorrow" vs "get followed
                                            // to raise the ceiling"); pass its own sentence through
                                            // rather than collapsing them into "try again later".
                                            is WalletCore.FaucetResult.AlreadyClaimed -> { onMsg("⚠️ ${r.error}", true); reloadKey++ }
                                            is WalletCore.FaucetResult.CeilingReached -> { onMsg("⚠️ ${r.error}", true); reloadKey++ }
                                            is WalletCore.FaucetResult.Failed -> { onMsg("⚠️ ${r.error}", true); reloadKey++ }
                                            // No readable answer → UNKNOWN, not a
                                            // refusal. `executeJson` only nulls on
                                            // an IOException, and the settle
                                            // timeout is one of those: the POST
                                            // WAS delivered and the route credits
                                            // before waiting on the mint. This
                                            // said "couldn't reach the faucet —
                                            // try again", which is a cause it
                                            // never checked plus the one remedy
                                            // that 429s over money the user
                                            // already has. Same treatment
                                            // onWithdraw's null gets below:
                                            // neutral tone, no retry nudge, and a
                                            // reload — which it also skipped, so
                                            // the button kept offering the claim.
                                            null -> { onMsg(WalletCore.FAUCET_NO_ANSWER, false); reloadKey++ }
                                        }
                                    }
                                },
                            )
                        }
                        item { Spacer(Modifier.height(12.dp)) }
                    }
                    item {
                        DepositCard(
                            deposit = d,
                            onLink = { addr, onMsg ->
                                scope.launch {
                                    when (val r = repo.linkAddress(addr)) {
                                        is WalletCore.LinkResult.Ok -> {
                                            deposit = d?.copy(linkedAddress = r.address)
                                            onMsg("✓ address linked — send USDC on Base, then claim with the tx hash.", false)
                                        }
                                        is WalletCore.LinkResult.Failed -> onMsg("⚠️ ${r.error}", true)
                                        null -> onMsg("⚠️ couldn't reach the wallet service — try again", true)
                                    }
                                }
                            },
                            onClaim = { tx, network, onMsg ->
                                scope.launch {
                                    when (val r = repo.claim(tx, network)) {
                                        is WalletCore.ClaimResult.Ok -> {
                                            onMsg(
                                                if (r.alreadyCredited) "already credited — this tx was claimed before."
                                                else "✓ credited ${WalletCore.usd(r.creditedMicro)}" +
                                                    if (r.testnetTrial) " (testnet trial — \$1 lifetime cap, not withdrawable as real USDC)" else "",
                                                false,
                                            )
                                            reloadKey++
                                        }
                                        is WalletCore.ClaimResult.Retry -> onMsg("⚠️ ${r.error} — try again in a minute", true)
                                        is WalletCore.ClaimResult.Failed -> onMsg("⚠️ ${r.error}", true)
                                        null -> onMsg("⚠️ couldn't reach the wallet service — try again", true)
                                    }
                                }
                            },
                        )
                    }
                    item { Spacer(Modifier.height(12.dp)) }
                    item {
                        WithdrawCard(
                            linked = d?.linkedAddress != null,
                            // asNetwork(), not `== "base-sepolia"`: the old ternary sent a
                            // tiny-chain deployment's withdrawals to mainnet Base by default.
                            defaultNetwork = WalletCore.asNetwork(d?.chain),
                            networks = WalletCore.networkChoices(d?.chain),
                            onWithdraw = { micro, network, onMsg ->
                                scope.launch {
                                    when (val r = repo.withdraw(micro, network)) {
                                        // A broadcast payout (paid OR pending) carries the BaseScan link
                                        // so the user can watch it confirm on-chain — web opens it on both
                                        // paths (page.tsx:212,221), iOS shows it on both (dcaa95e).
                                        is WalletCore.WithdrawResult.Ok ->
                                            onMsg("✓ paid — ${WalletCore.usd(r.netMicro)} sent on-chain (${WalletCore.usd(r.feeMicro)} fee).", false, r.explorer).also { reloadKey++ }
                                        is WalletCore.WithdrawResult.Pending ->
                                            onMsg("⏳ sent — confirming on-chain. don't retry; it'll settle shortly.", false, r.explorer).also { reloadKey++ }
                                        is WalletCore.WithdrawResult.Failed ->
                                            // A STRUCTURED non-ok body is safe to retry: the route refunds on
                                            // every broadcast-that-moved-nothing (revert → refund; no broadcast
                                            // → refund), so the balance is intact (iOS dd133c1).
                                            onMsg("⚠️ ${r.error}", true, null).also { reloadKey++ } // a refund may have adjusted the balance
                                        // null = a TRUE transport failure with NO body — the outcome is
                                        // UNKNOWN and the transfer MAY have broadcast (the double-pay case
                                        // the server's 202 path prevents, re-entering by the timeout door).
                                        // Neutral, non-retry copy pointing at Activity — NEVER "try again"
                                        // (iOS dd133c1 splits the nil branch off "failed" for this reason).
                                        null -> onMsg("couldn't confirm — check Activity before retrying", false, null).also { reloadKey++ }
                                    }
                                }
                            },
                        )
                    }
                    if (monetize.ownsTinys) {
                        item { Spacer(Modifier.height(12.dp)) }
                        item { MonetizeCard(monetize.priced, monetize.hasPricedPrivate, context) }
                    }
                    item { Spacer(Modifier.height(12.dp)) }
                    item { ActivityCard(l.entries, nowMs) }
                }
            }
        }
    }
}

/** A card container — surface inside a faint accent hairline (iOS .tinyCard()). */
@Composable
private fun WalletCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.2f), RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(14.dp),
        content = content,
    )
}

/** A wallet card's header: native Material glyph beside a titleSmall label — the
 *  cards' section titles used to prefix an emoji (💳/⬇️/⬆️/💰). Tinted onSurface
 *  to sit at the same weight as the label, matching the user's native-icon ask. */
@Composable
private fun SectionHead(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun BalanceCard(balanceMicro: Long) = WalletCard {
    Text("BALANCE", style = MaterialTheme.typography.labelSmall, color = TinyGray)
    Text(
        WalletCore.usd(balanceMicro),
        style = MaterialTheme.typography.displaySmall,
        color = MaterialTheme.colorScheme.primary,
        maxLines = 1,
    )
    Text("tiny credits · micro-USDC ledger", style = MaterialTheme.typography.labelSmall, color = TinyGray)
}

/**
 * "What is the tiny wallet?" — a collapsible x402 explainer (web
 * app/wallet/page.tsx:393-465 parity). The wallet's deposit/withdraw/monetize
 * cards all assume you already know what the money is FOR; this is the one place
 * that answers "what is x402 / why would I pay an AI / how do I try it safely,"
 * which is the user's stated confusion. Auto-expands for a newcomer (zero balance
 * AND zero history) and stays collapsed once they have either, exactly like web's
 * `showIntro` default. Points at the faucet/deposit cards below for the how-to, so
 * the explainer stays education-only and doesn't duplicate the action surfaces.
 */
@Composable
private fun WhatIsWalletCard(newcomer: Boolean) = WalletCard {
    var open by remember { mutableStateOf(newcomer) }
    Row(
        Modifier.fillMaxWidth()
            .clickable(onClickLabel = if (open) "collapse" else "expand") { open = !open }
            .semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Eco, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            "What is the tiny wallet?",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        Icon(
            if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
            contentDescription = null, tint = TinyGray, modifier = Modifier.size(20.dp),
        )
    }
    if (open) {
        Spacer(Modifier.height(10.dp))
        Text(
            "Your wallet holds tiny credits — a dollar-denominated balance (USDC) that powers the AI economy here. Everything is optional: free tinys stay free forever.",
            style = MaterialTheme.typography.bodySmall, color = TinyGray,
        )
        Spacer(Modifier.height(12.dp))
        WalletPoint(
            Icons.Outlined.SmartToy, "Use paid AIs",
            "Some creators charge per message (e.g. $0.01) for specialized tinys — legal helpers, trading analysts, tutors. Your balance pays automatically as you chat, and the price is always shown up front.",
        )
        WalletPoint(
            Icons.Outlined.MonetizationOn, "Earn with your AIs",
            "Tell any tiny you own “charge $0.01 per message” — done, it's monetized. Every visitor message pays you. You keep the full price minus a flat $0.001 — never a percentage cut.",
        )
        WalletPoint(
            Icons.Outlined.Public, "Get paid by the whole internet",
            "Priced tinys are payable by ANY AI agent over the open x402 protocol — other people's agents can discover your tiny and pay it per request in USDC, no tiny.technology account needed. Your AI becomes an API that earns.",
        )
        WalletPoint(
            Icons.Outlined.AccountBalance, "Real money, your custody",
            "Deposits and withdrawals are real USDC on Base (an Ethereum L2 by Coinbase). Withdrawals go only to the address YOU linked, so a stolen session can't redirect your money. Want to try risk-free first? Testnet (Base Sepolia) deposits give you up to $1 in trial credits.",
        )
        Spacer(Modifier.height(4.dp))
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                .background(TinyGray.copy(alpha = 0.10f)).padding(12.dp),
        ) {
            Text("Quick start", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface)
            Spacer(Modifier.height(4.dp))
            Text(
                "1. Link your wallet address below · 2. Buy or send USDC on Base — or grab free testnet USDC to try · 3. Claim the deposit · 4. Chat with paid tinys, or price your own and start earning.",
                style = MaterialTheme.typography.bodySmall, color = TinyGray,
            )
        }
    }
}

/** One labelled point in the wallet explainer: a native glyph, a bold lead, its body. */
@Composable
private fun WalletPoint(icon: ImageVector, title: String, body: String) {
    Row(Modifier.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 2.dp).size(18.dp))
        Column {
            Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
            Text(body, style = MaterialTheme.typography.bodySmall, color = TinyGray)
        }
    }
}

/**
 * 💧 Get credit — THREE mutually-exclusive routes, chosen by WalletCore.topUpRoute
 * from what the server says it can actually DO (web wallet/page.tsx:595 parity):
 *
 *   FAUCET  — this deployment hosts its own chain, so credit comes from us. There
 *             is no card or bridge that can deliver a token only we mint, so
 *             offering one alongside would be a dead end dressed up as a choice.
 *   TESTNET — Sepolia: the public faucet is the one true source; fiat on-ramps
 *             deliver MAINNET USDC the claim scanner can't see.
 *   FIAT    — real Base: cards/bridges work, and a faucet is noise.
 *
 * Keyed on faucet.available, NOT on the network name: a half-configured tiny chain
 * reports `tiny` with no faucet, and a claim button there 424s on every press.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun GetUsdcCard(
    deposit: WalletCore.DepositInfo?,
    context: Context,
    onClaimFaucet: (onMsg: (String, Boolean) -> Unit) -> Unit,
) = WalletCard {
    val route = WalletCore.topUpRoute(deposit)
    val faucetRoute = route == WalletCore.TopUpRoute.FAUCET
    SectionHead(
        if (faucetRoute) Icons.Outlined.WaterDrop else Icons.Outlined.CreditCard,
        if (faucetRoute) "Get credit (free daily top-up)" else "Get USDC",
    )
    Spacer(Modifier.height(4.dp))
    Text(
        WalletCore.topUpBlurb(deposit),
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    Spacer(Modifier.height(10.dp))
    if (faucetRoute) {
        var msg by remember { mutableStateOf("") }
        var msgIsWarn by remember { mutableStateOf(false) }
        var busy by remember { mutableStateOf(false) }
        // ONE faucetCta call drives the label, the enabled state AND the reason, so
        // the button can't read "Claim $1" while the line under it says the ceiling
        // is spent.
        val cta = WalletCore.faucetCta(deposit?.faucet)
        Button(
            enabled = !busy && cta.enabled,
            onClick = {
                busy = true; msg = ""
                onClaimFaucet { m, w -> msg = m; msgIsWarn = w; busy = false }
            },
        ) { Text(if (busy) "Claiming…" else cta.label) }
        if (cta.reason.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text(cta.reason, style = MaterialTheme.typography.bodySmall, color = TinyGray)
        }
        // Shown in EVERY faucet state, including right after a claim: the ceiling is
        // reputation-scaled, so "get followed" is the one durable answer to "how do I
        // get more?".
        WalletCore.ceilingNote(deposit?.faucet).takeIf { it.isNotEmpty() }?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.labelSmall, color = TinyGray)
        }
        if (msg.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(msg, style = MaterialTheme.typography.bodySmall, color = if (msgIsWarn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
        }
    } else {
        // A wrapping row of pill links (web flex-wrap onramp buttons). The faucet
        // source carries a Science glyph to flag it as the try-risk-free path.
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            WalletCore.usdcSources(deposit).forEach { src ->
                OutlinedButton(
                    onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(src.url))) },
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.4f)),
                ) {
                    if (src.faucet) {
                        Icon(Icons.Outlined.Science, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(src.label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

@Composable
private fun DepositCard(
    deposit: WalletCore.DepositInfo?,
    onLink: (address: String, onMsg: (String, Boolean) -> Unit) -> Unit,
    onClaim: (txHash: String, network: String, onMsg: (String, Boolean) -> Unit) -> Unit,
) = WalletCard {
    val context = LocalContext.current
    // networkShort(), not a two-way ternary: a `tiny` deployment used to head this
    // card "Deposit USDC on Base" — the wrong chain, on the card that tells the user
    // where to send money.
    val chainLabel = WalletCore.networkShort(deposit?.chain ?: "")
    SectionHead(Icons.Outlined.Download, "Deposit USDC on $chainLabel")
    Spacer(Modifier.height(8.dp))

    var msg by remember { mutableStateOf("") }
    var msgIsWarn by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val setMsg: (String, Boolean) -> Unit = { m, w -> msg = m; msgIsWarn = w; busy = false }

    if (deposit?.configured != true) {
        Text(
            "USDC deposits are rolling out — the deposit address isn't configured yet. Until then, credits are granted by the platform.",
            style = MaterialTheme.typography.bodySmall, color = TinyGray,
        )
    } else {
        // 1) Link the sending/withdrawal address.
        Text(
            "1. Link the address you'll send from — makes your deposit claimable by you alone (and your withdrawal destination).",
            style = MaterialTheme.typography.bodySmall, color = TinyGray,
        )
        Spacer(Modifier.height(6.dp))
        val linked = deposit.linkedAddress
        if (linked != null) {
            Text(
                "✓ $linked",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary,
                fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        } else {
            var linkAddr by remember { mutableStateOf("") }
            val valid = WalletCore.isValidAddress(linkAddr)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = linkAddr, onValueChange = { linkAddr = it },
                    placeholder = { Text("0xYourAddress") },
                    singleLine = true, textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Button(enabled = !busy && valid, onClick = { busy = true; onLink(linkAddr.trim(), setMsg) }) { Text("Link") }
            }
        }
        Spacer(Modifier.height(10.dp))

        // 2) Send to the platform deposit address (copyable).
        Text("2. Send USDC to the platform deposit address:", style = MaterialTheme.typography.bodySmall, color = TinyGray)
        deposit.depositAddress?.let { addr ->
            Spacer(Modifier.height(4.dp))
            CopyRow(addr, "platform deposit address") {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("deposit address", addr))
                setMsg("✓ Deposit address copied.", false)
            }
        }
        Spacer(Modifier.height(10.dp))

        // 3) Claim by tx hash (network segmented control).
        Text("3. Paste the transaction hash to credit your balance:", style = MaterialTheme.typography.bodySmall, color = TinyGray)
        Spacer(Modifier.height(6.dp))
        var claimTx by remember { mutableStateOf("") }
        // Seed the selector to the DEPLOYMENT's network, not a hardcoded "base".
        // The worker reports default_network (deposit.chain) and the header above
        // already reads it ("Base Sepolia" on a testnet deploy); a selector stuck
        // on mainnet meant a user pasting a Sepolia tx hash hit the permanent 400
        // "no matching USDC transfer on base" (web f65a4c1 fixed the same). Keyed
        // on chain so a late deposit-info load re-seeds it.
        // asNetwork() so the deployment's OWN chain seeds it — the `== "base-sepolia"`
        // ternary parked a tiny-chain deployment on mainnet, the same permanent-400
        // shape it was written to fix.
        var network by remember(deposit?.chain) { mutableStateOf(WalletCore.asNetwork(deposit?.chain)) }
        NetworkToggle(WalletCore.networkChoices(deposit?.chain), network, onSelect = { network = it })
        Spacer(Modifier.height(6.dp))
        val txValid = WalletCore.isValidTxHash(claimTx)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = claimTx, onValueChange = { claimTx = it },
                placeholder = { Text("0xTransactionHash") },
                singleLine = true, textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Button(enabled = !busy && txValid, onClick = { busy = true; onClaim(claimTx.trim(), network, setMsg) }) {
                Text(if (busy) "…" else "Claim")
            }
        }
    }
    if (msg.isNotEmpty()) {
        Spacer(Modifier.height(8.dp))
        Text(msg, style = MaterialTheme.typography.bodySmall, color = if (msgIsWarn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun WithdrawCard(
    linked: Boolean,
    defaultNetwork: String,
    networks: List<String>,
    onWithdraw: (amountMicro: Long, network: String, onMsg: (String, Boolean, String?) -> Unit) -> Unit,
) = WalletCard {
    val uriHandler = LocalUriHandler.current
    SectionHead(Icons.Outlined.Upload, "Withdraw USDC")
    Spacer(Modifier.height(4.dp))
    Text(
        // Names all three trial sources, not just "testnet": a faucet drip on the tiny
        // chain is trial credit too, and a user who learns that only when the
        // withdrawal is refused has been misled (web wallet/page.tsx:789 parity).
        "Sends to your linked address instantly — no approval step. Min \$1, flat \$0.10 fee (gas), \$500/day. Trial credits (Tiny Chain, Base Sepolia, faucet top-ups) aren't withdrawable as real USDC.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    Spacer(Modifier.height(8.dp))

    var amount by remember { mutableStateOf("") }
    // Seed to the deployment default (see DepositCard) — a testnet deploy defaults
    // withdraw to Sepolia, not mainnet. Keyed so a late deposit-info load re-seeds.
    var network by remember(defaultNetwork) { mutableStateOf(defaultNetwork) }
    var msg by remember { mutableStateOf("") }
    var msgIsWarn by remember { mutableStateOf(false) }
    // The BaseScan URL for the last broadcast payout — cleared at the start of each
    // new withdrawal, set on both the paid and pending replies (iOS/web parity).
    var explorer by remember { mutableStateOf<String?>(null) }
    var withdrawing by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf(false) }
    val micro = WalletCore.parseWithdrawMicro(amount) // null when < $1 / non-numeric

    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = amount, onValueChange = { amount = it },
            leadingIcon = { Text("$", color = TinyGray) },
            placeholder = { Text("10.00") },
            singleLine = true,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal),
            textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(8.dp))
        Button(
            enabled = !withdrawing && micro != null,
            onClick = {
                // Withdrawing sends real USDC on-chain — instant + irreversible. Web
                // gates it behind a danger confirm (wallet/page.tsx); mirror as a dialog.
                if (!linked) { msg = "⚠️ link your wallet address first (in the Deposit card) — it's your withdrawal destination"; msgIsWarn = true }
                else confirm = true
            },
        ) { Text(if (withdrawing) "Sending…" else "Withdraw") }
    }
    Spacer(Modifier.height(6.dp))
    NetworkToggle(networks, network, onSelect = { network = it })
    if (msg.isNotEmpty()) {
        Spacer(Modifier.height(8.dp))
        Text(msg, style = MaterialTheme.typography.bodySmall, color = if (msgIsWarn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
    }
    // Watch the payout confirm on-chain. Web opens the explorer automatically; here
    // it's a tappable link so a broadcast tx isn't a dead end (iOS Wallet.swift
    // dcaa95e). Named after where the link goes, not after Base — see
    // WalletCore.explorerLinkLabel.
    WalletCore.explorerHref(explorer)?.let { url ->
        Spacer(Modifier.height(6.dp))
        Text(
            "↗ " + WalletCore.explorerLinkLabel(url),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.clickable(onClickLabel = WalletCore.explorerOpenHint(url)) { uriHandler.openUri(url) },
        )
    }

    if (confirm && micro != null) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Withdraw USDC?") },
            text = {
                // States BOTH the gross debited and the net that lands on-chain —
                // the confirm must match the success toast on an irreversible spend
                // (iOS Wallet.swift:335 / web wallet/page.tsx:197 parity).
                Text(WalletCore.withdrawConfirmText(micro, network))
            },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false; withdrawing = true; msg = "Signing and broadcasting…"; msgIsWarn = false; explorer = null
                    onWithdraw(micro, network) { m, w, ex -> msg = m; msgIsWarn = w; explorer = ex; withdrawing = false }
                }) { Text("Withdraw", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ActivityCard(entries: List<WalletCore.Entry>, nowMs: Long) = WalletCard {
    Text("Activity", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
    Spacer(Modifier.height(6.dp))
    if (entries.isEmpty()) {
        Text("No activity yet.", style = MaterialTheme.typography.bodySmall, color = TinyGray)
    } else {
        entries.forEachIndexed { i, e ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(WalletCore.kindLabel(e.kind), style = MaterialTheme.typography.bodySmall)
                if (e.ref.isNotEmpty()) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        e.ref, style = MaterialTheme.typography.labelSmall, color = TinyGray,
                        fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    Spacer(Modifier.weight(1f))
                }
                e.created?.let { c ->
                    Text(ago(c.toLong(), nowMs), style = MaterialTheme.typography.labelSmall, color = TinyGray)
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    (if (e.deltaMicro >= 0) "+" else "") + WalletCore.usd(e.deltaMicro),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = if (e.deltaMicro >= 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
            }
            if (i < entries.lastIndex) Divider(color = TinyGray.copy(alpha = 0.12f))
        }
    }
}

/**
 * 💰 Monetize — shown to EVERY tiny owner (iOS Wallet.swift monetizeCard, web
 * wallet parity, 3e34200). An owner with priced tinys sees each one's copyable
 * x402 pay endpoint + ERC-8004 registration URL (payable by any AI agent over the
 * open x402 protocol, registerable on-chain). An owner with nothing priced yet
 * sees the guiding hint that pricing is what unlocks those URLs — otherwise a
 * phone owner never discovers the agent-payable endpoint exists.
 */
@Composable
private fun MonetizeCard(priced: List<WalletCore.PricedTiny>, hasPricedPrivate: Boolean, context: Context) = WalletCard {
    val cm = remember { context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager }
    SectionHead(Icons.Outlined.MonetizationOn, "Monetize your tinys")
    Spacer(Modifier.height(4.dp))
    // There is NO UI price control (no Settings/Your-AI price field on any
    // client) — the only mechanism is telling the tiny in chat. Point at that,
    // not a nonexistent setting (iOS 0e28f83 / web 0e311e8 parity).
    Text(
        "To price a tiny you own, just tell it in chat: “charge $0.01 per message” — or “make yourself free again” to turn it off. Callers pay from their wallet; you earn the price minus the flat fee.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    if (priced.isEmpty()) {
        // Owns tinys but none PUBLICLY priced — the discovery hint web/iOS show, so
        // a phone owner learns pricing (and publicness) is what unlocks the agent-
        // payable x402 endpoint + on-chain ERC-8004 URL. When the owner's ONLY
        // priced tiny is private, steer to "make it public" instead of "price a
        // tiny" they already priced — its URLs 403 (web pricedPrivate / iOS
        // hasPricedPrivate).
        Spacer(Modifier.height(6.dp))
        Text(
            if (hasPricedPrivate)
                "Make a priced tiny public to unlock its x402 endpoint + on-chain (ERC-8004) registration URL — a private tiny stays walled off from agent payments."
            else
                "Price a tiny to unlock its x402 endpoint + on-chain (ERC-8004) registration URL — they'll appear here so any AI agent can discover and pay it.",
            style = MaterialTheme.typography.bodySmall, color = TinyGray,
        )
        return@WalletCard
    }
    Spacer(Modifier.height(6.dp))
    Text(
        "These priced tinys are payable by any AI agent over the open x402 protocol, and registerable on-chain via ERC-8004. Tap a URL to copy it.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    priced.forEach { t ->
        Spacer(Modifier.height(10.dp))
        Text(
            "/${t.name} · ${WalletCore.usd(t.priceMicro)}/msg",
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.height(4.dp))
        Text("X402 ENDPOINT", style = MaterialTheme.typography.labelSmall, color = TinyGray)
        CopyRow(t.x402Url, "x402 endpoint URL for ${t.name}") { cm.setPrimaryClip(ClipData.newPlainText("x402", t.x402Url)) }
        Spacer(Modifier.height(4.dp))
        Text("ERC-8004 REGISTRATION", style = MaterialTheme.typography.labelSmall, color = TinyGray)
        CopyRow(t.registrationUrl, "ERC-8004 registration URL for ${t.name}") { cm.setPrimaryClip(ClipData.newPlainText("registration", t.registrationUrl)) }
    }
}

/** A monospace address/hash row with a trailing copy affordance (iOS copy button).
 *  The trailing label flips to "✓ copied" for ~1.5s on tap — the inline tap-feedback
 *  iOS's copyableUrl gives (doc.on.doc → checkmark) that the monetize rows previously
 *  lacked (they copied silently). The deposit row ALSO drives its own toast via onCopy
 *  (setMsg); this inline flash complements it and is the sole confirmation for the
 *  monetize x402/registration rows.
 *
 *  a11y: `label` names the copy ACTION for TalkBack ("Copy the x402 endpoint URL")
 *  instead of letting it read the raw URL char-run + "copy" as isolated nodes, and the
 *  row's stateDescription flips to "Copied" on tap so the success is ANNOUNCED, not just
 *  a silent ✓ swap. Mirrors iOS copyableUrl (.accessibilityLabel + .accessibilityValue,
 *  Wallet.swift) and web's aria-label (app/wallet/page.tsx:688 `Copy ${label} URL`); the
 *  spoken confirmation improves on web, which has no announced success. */
@Composable
private fun CopyRow(text: String, label: String, onCopy: () -> Unit) {
    // A tap counter, not a bare bool: re-tapping while still showing "✓ copied"
    // bumps it so the LaunchedEffect restarts its window (the old timer cancels).
    var copyTick by remember { mutableStateOf(0) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copyTick) {
        if (copyTick == 0) return@LaunchedEffect
        copied = true
        kotlinx.coroutines.delay(1_500)
        copied = false
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
            .background(TinyGray.copy(alpha = 0.12f))
            .clickable { onCopy(); copyTick++ }.padding(8.dp)
            // ONE actionable node named for the action + an announced success, instead
            // of the raw URL + "copy" read as separate fragments (iOS/web a11y parity).
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "Copy the $label"
                stateDescription = if (copied) "Copied" else ""
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text, style = MaterialTheme.typography.labelSmall, color = TinyGray,
            fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).clearAndSetSemantics {},
        )
        Spacer(Modifier.width(8.dp))
        Text(
            if (copied) "✓ copied" else "copy",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.clearAndSetSemantics {},
        )
    }
}

/**
 * Network segmented toggle (iOS .segmented Picker) over the DEPLOYMENT's networks —
 * WalletCore.networkChoices, not a hardcoded base|base-sepolia pair. Two reasons the
 * pair was wrong: a self-hosted `tiny` deployment's own chain wasn't selectable at
 * all, and the OTHER trial chain was — a tx hash from one is invisible to the other's
 * receipt scanner, which is the permanent "no matching USDC transfer" 400.
 */
@Composable
private fun NetworkToggle(networks: List<String>, selected: String, onSelect: (String) -> Unit) {
    val options = networks.map { it to WalletCore.networkShort(it) }
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        options.forEachIndexed { i, (value, label) ->
            SegmentedButton(
                selected = selected == value,
                onClick = { onSelect(value) },
                shape = SegmentedButtonDefaults.itemShape(index = i, count = options.size),
            ) { Text(label, style = MaterialTheme.typography.labelMedium) }
        }
    }
}

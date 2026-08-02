package technology.tiny.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import technology.tiny.app.TinyApp
import technology.tiny.app.ui.theme.TinyGray
import technology.tiny.app.ui.theme.TinyWarn
import technology.tiny.app.wallet.ChainCore
import technology.tiny.app.wallet.WalletRepository

/**
 * ⛓️ Chain — the native port of the web `/chain` explorer, Android half.
 *
 * The user's gap, verbatim: "we dont see the chain details in the mobile apps."
 * Web has a server-rendered `/chain`; iOS got `ChainView` last cycle; this is the
 * third client. What it shows: which chain this deployment settles on, whether the
 * node agrees with our config, the latest block, the TinyUSDC contract, and recent
 * money movement — beside the wallet whose balance lives on that chain.
 *
 * Every "what does this state MEAN" decision lives in the pure, unit-tested
 * [ChainCore]; this file is layout only — no JSON, no RPC, no money formatting.
 * That's the whole point of decoding server-side: three clients, one meaning.
 *
 * The two places the layout itself carries a decision:
 *
 *  • The node's own chain id is rendered ONLY on a mismatch. On a match it would
 *    be the same number under a second label, which reads as a discrepancy where
 *    there is none.
 *  • The activity list is HIDDEN, not shown empty, when the node is unreachable
 *    ([ChainCore.Status.showsActivity]) — "no recent activity" for a node that
 *    never answered is an absence of data presented as a fact about the chain.
 */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChainSheet(app: TinyApp, onDismiss: () -> Unit) {
    val repo = remember { WalletRepository(app.api) }
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current

    // 3-state load (WalletSheet/JobsSheet discipline): an outage → Retry, never a
    // false-empty. A null status is BOTH transport failure and unparseable body —
    // ChainCore refuses an error body rather than reading a missing `configured`
    // key as "this deployment has no chain", so both land here as a retry.
    var status by remember { mutableStateOf<ChainCore.Status?>(null) }
    var failed by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        failed = false
        val s = repo.chainStatus()
        if (s == null) failed = true else status = s
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item {
                SheetTitle(Icons.Outlined.Link, "chain")
                Spacer(Modifier.height(12.dp))
            }
            val s = status
            when {
                failed && s == null -> item {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        Text(
                            "couldn't read the chain status",
                            color = TinyGray,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                            Text(
                                "retry",
                                color = MaterialTheme.colorScheme.primary,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
                s == null -> item { SheetLoading("reading the chain…") }
                else -> {
                    val mismatch = s.health is ChainCore.Health.Mismatch
                    item {
                        Text(
                            ChainCore.headline(s),
                            style = MaterialTheme.typography.bodyMedium,
                            // A mismatch is the one headline that changes what the
                            // numbers below MEAN, so it doesn't read as body copy.
                            color = if (mismatch) TinyWarn else TinyGray,
                        )
                        Spacer(Modifier.height(12.dp))
                    }
                    if (s.health !is ChainCore.Health.NotConfigured) {
                        item {
                            NetworkCard(s, onCopy = { label, value ->
                                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                                    .setPrimaryClip(ClipData.newPlainText(label, value))
                            })
                            Spacer(Modifier.height(12.dp))
                        }
                    }
                    if (s.showsActivity) {
                        item {
                            ActivityCard(s, onCopyHash = { hash ->
                                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                                    .setPrimaryClip(ClipData.newPlainText("transaction hash", hash))
                            })
                            Spacer(Modifier.height(12.dp))
                        }
                    }
                    item {
                        Text(s.moneyNote, style = MaterialTheme.typography.labelSmall, color = TinyGray)
                        // Anyone can run a node — the claim the chain makes about
                        // itself, and the endpoint that backs it up (GET
                        // /api/chain/join publishes the genesis bytes).
                        if (s.health is ChainCore.Health.Ok) {
                            TextButton(
                                onClick = { uriHandler.openUri("${app.config.serverBase}/api/chain/join") },
                                contentPadding = PaddingValues(0.dp),
                            ) {
                                Icon(
                                    Icons.Outlined.Dns,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "run your own node",
                                    color = MaterialTheme.colorScheme.primary,
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChainCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.2f), RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(14.dp),
        content = content,
    )
}

@Composable
private fun CardHead(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** One label → monospace value row. */
@Composable
private fun ChainRow(label: String, value: String, valueColor: Color) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = TinyGray, modifier = Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            color = valueColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun NetworkCard(s: ChainCore.Status, onCopy: (String, String) -> Unit) = ChainCard {
    CardHead(Icons.Outlined.Link, "network")
    Spacer(Modifier.height(6.dp))
    val warn = s.health as? ChainCore.Health.Mismatch
    s.caip2?.let {
        ChainRow("chain", if (warn != null) "$it ⚠️" else it, MaterialTheme.colorScheme.onSurface)
    }
    // Shown ONLY on a mismatch: on a match it's our own number under a second
    // label, which reads as a disagreement where there is none.
    warn?.let { ChainRow("node reports", "eip155:${it.reported}", TinyWarn) }
    ChainRow(
        "latest block",
        // null is "we don't know", never 0 — block 0 is a real height, and printing
        // it would claim a chain that has never produced a block.
        s.latestBlock?.let { "#$it" } ?: "unknown",
        if (s.latestBlock == null) TinyGray else MaterialTheme.colorScheme.onSurface,
    )
    s.usdc?.let { usdc ->
        Spacer(Modifier.height(8.dp))
        Text("TINYUSDC", style = MaterialTheme.typography.labelSmall, color = TinyGray)
        Spacer(Modifier.height(4.dp))
        CopyableMono(usdc, "TinyUSDC contract address") { onCopy("TinyUSDC", usdc) }
    }
}

@Composable
private fun ActivityCard(s: ChainCore.Status, onCopyHash: (String) -> Unit) = ChainCard {
    CardHead(Icons.Outlined.SwapHoriz, "recent TinyUSDC activity")
    Spacer(Modifier.height(6.dp))
    if (s.transfers.isEmpty()) {
        // Scoped, not absolute — the endpoint only scanned `span` blocks, so bare
        // "no activity" is a bigger claim than it can back.
        Text(
            ChainCore.emptyActivityNote(s.span),
            style = MaterialTheme.typography.bodySmall,
            color = TinyGray,
        )
        return@ChainCard
    }
    s.transfers.forEach { t ->
        Column(
            Modifier.fillMaxWidth()
                .clickable(onClickLabel = "copy the transaction hash") { onCopyHash(t.hash) }
                .padding(vertical = 6.dp)
                .semantics(mergeDescendants = true) {
                    role = Role.Button
                    contentDescription =
                        "${t.kindLabel}, ${t.amount}, from ${t.fromShort} to ${t.toShort}"
                },
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    t.kindLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    t.amount,
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                    // A clamped amount is not a number anyone can stand behind —
                    // mark it where it's read, not in a footnote.
                    color = if (t.clamped) TinyWarn else MaterialTheme.colorScheme.onSurface,
                )
            }
            Text(
                "${t.fromShort} → ${t.toShort}",
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = TinyGray,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(t.blockNumber?.let { "#$it" }, t.hashShort).joinToString("  "),
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = TinyGray,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
    Spacer(Modifier.height(4.dp))
    Text("tap a row to copy its transaction hash", style = MaterialTheme.typography.labelSmall, color = TinyGray)
}

/** Monospace value with a trailing copy affordance — Wallet.kt's CopyRow shape,
 *  duplicated rather than shared because that one is `private` to the wallet sheet
 *  and this screen must not reach into it. */
@Composable
private fun CopyableMono(text: String, label: String, onCopy: () -> Unit) {
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
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "Copy the $label"
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

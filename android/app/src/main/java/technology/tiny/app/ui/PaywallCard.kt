package technology.tiny.app.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.MoneyOff
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import technology.tiny.app.wallet.WalletCore

/**
 * 💸 Paywall card for a 402 (web Chat.tsx paywall bubble parity).
 *
 * A priced tiny with an unfunded wallet returns HTTP 402 mid-send. Android used to
 * surface that as a bare "⚠️ Insufficient balance…" line with a futile generic
 * Retry (retrying without funding just fails again). This makes it actionable: the
 * live price + balance, a "💳 Add funds" button that opens the wallet to top up,
 * and a "↻ Retry" that re-sends once funded (the charge settles server-side). The
 * 402 stays authoritative on the server — this is only the on-screen affordance.
 *
 * Two 402 states (server `signed_out` flag): a SIGNED-OUT 402 (the server rejected
 * the session — revoked/denylisted token that hasn't hit its local expiry yet, or
 * clock skew) shows ONLY "Sign in" — Add funds needs auth and Retry just re-hits
 * the 402, so both would dead-end. An INSUFFICIENT-BALANCE 402 shows Add funds +
 * Retry. This mirrors web (Chat.tsx:3490) and iOS (PaywallCard, Views.swift:3650):
 * the card branches its buttons on signedOut, not just its title/copy. onSignIn is
 * nullable (null in read-only contexts like a /share preview); when signed-out and
 * onSignIn is absent, no button shows rather than a misleading one.
 */
@Composable
fun PaywallCard(
    paywall: WalletCore.Paywall,
    onAddFunds: () -> Unit,
    onRetry: () -> Unit,
    onSignIn: (() -> Unit)? = null,
) {
    val accent = MaterialTheme.colorScheme.primary
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(accent.copy(alpha = 0.35f))
            .padding(1.dp)
            .clip(RoundedCornerShape(11.dp))
            .background(accent.copy(alpha = 0.06f))
            .padding(14.dp)
            .animateContentSize(),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            // Drop the decorative glyph from the a11y tree — otherwise TalkBack
            // reads the icon as its own node before the copy on this money-
            // critical card. Web marks it aria-hidden (Chat.tsx:3479); iOS hides
            // it too (Views.swift PaywallCard).
            Icon(
                Icons.Outlined.MoneyOff,
                contentDescription = null,
                tint = accent,
                modifier = Modifier.padding(top = 1.dp).size(20.dp).clearAndSetSemantics {},
            )
            // Merge title + detail into ONE announcement so TalkBack speaks the
            // whole card as a single sentence, not two isolated fragments.
            // Mirrors web (role="alert" wrapper) and iOS (.accessibilityElement
            // children:.combine). The buttons stay outside this merge, each a
            // distinct actionable node.
            Column(
                Modifier.weight(1f).semantics(mergeDescendants = true) {},
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    if (paywall.signedOut) "Sign in to chat with this tiny" else "This tiny is paid",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = accent,
                )
                Text(
                    paywall.detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (paywall.signedOut) {
                // Signed-out 402: the ONLY useful action is to authenticate. Add
                // funds (needs a session) and Retry (re-hits the same 402) would
                // both dead-end here — matches web/iOS, which hide them too.
                if (onSignIn != null) {
                    Button(
                        onClick = onSignIn,
                        colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = MaterialTheme.colorScheme.onPrimary),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                    ) {
                        Text("Sign in", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    }
                }
            } else {
                Button(
                    onClick = onAddFunds,
                    colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = MaterialTheme.colorScheme.onPrimary),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                ) {
                    Icon(Icons.Outlined.CreditCard, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Add funds", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                }
                OutlinedButton(
                    onClick = onRetry,
                    border = BorderStroke(1.dp, accent.copy(alpha = 0.4f)),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                ) {
                    Icon(Icons.Outlined.Refresh, contentDescription = null, tint = accent, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Retry", style = MaterialTheme.typography.labelMedium, color = accent)
                }
            }
        }
    }
}

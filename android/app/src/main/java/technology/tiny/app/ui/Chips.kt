package technology.tiny.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import technology.tiny.app.ui.theme.TinyAccent

/**
 * Brand pill chip (web .neon-chip parity, globals.css: accent text on an
 * accent@6% fill inside an accent@25% hairline, fully rounded). Replaces stock
 * M3 SuggestionChip on the landing + follow-up rails, which rendered as gray
 * Material template chips with undersized labels. [accent] follows the
 * per-tiny theme when the caller has one; defaults to brand green.
 */
@Composable
fun TinyChip(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    accent: Color = TinyAccent,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        color = accent.copy(alpha = 0.06f),
        contentColor = accent,
        border = BorderStroke(1.dp, accent.copy(alpha = 0.25f)),
        // Surface(onClick) is clickable but role-less — TalkBack should say
        // "button" after the chip's label like it does for stock chips.
        modifier = modifier.semantics { role = Role.Button },
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}

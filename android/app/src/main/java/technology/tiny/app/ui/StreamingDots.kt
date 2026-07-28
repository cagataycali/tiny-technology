package technology.tiny.app.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * Pre-first-token streaming indicator: three accent dots pulsing on a 150ms
 * stagger (web Chat.tsx animate-bounce trio parity; replaces the static "…"
 * that made streaming look frozen). Gates on the system animator scale —
 * "remove animations" accessibility renders the dots static (iOS gates its
 * pulses on Reduce Motion the same way).
 */
@Composable
fun StreamingDots() {
    val animationsOff = rememberAnimationsOff()
    val transition = rememberInfiniteTransition(label = "streaming-dots")
    Row(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        modifier = Modifier
            .padding(vertical = 6.dp)
            // Purely visual dots are silence to TalkBack — say what's happening.
            .semantics { contentDescription = "reply streaming" },
    ) {
        repeat(3) { i ->
            val alpha = if (animationsOff) null else transition.animateFloat(
                initialValue = 0.25f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(450, delayMillis = i * 150, easing = LinearEasing),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "dot-$i",
            )
            androidx.compose.foundation.layout.Box(
                Modifier
                    .size(7.dp)
                    .graphicsLayer { this.alpha = alpha?.value ?: 0.6f }
                    .background(MaterialTheme.colorScheme.primary, CircleShape),
            )
        }
    }
}

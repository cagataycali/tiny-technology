package technology.tiny.app.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import technology.tiny.app.TinyApp
import technology.tiny.app.fleet.GlassesLive

/**
 * 🕶️ The glasses' floating live card — iOS GlassesLiveOverlay parity,
 * TinyLiveCard's shape (the two stack when both are open). Live camera on
 * top; below it a mic toggle + the on-device transcript strip. The mic is
 * an explicit tap, never auto-started — privacy posture inherited from iOS.
 *
 * 🖐️ **DRAGGABLE**, like iOS (`GlassesLiveOverlay`: `DragGesture` onto a
 * persisted `restingOffset`). It matters more than it sounds: the card is
 * 236dp of a ~411dp-wide phone parked over the chat, and its presence IS the
 * stream's lifetime (the `DisposableEffect` below). So on a phone where it
 * couldn't move, "let me read what's underneath" cost the user the live view —
 * closing it tears the glasses session down, and re-opening walks the whole
 * session budget again (~17s of device wait + stream start). Uncovering the
 * chat and keeping the stream were mutually exclusive.
 */
@Composable
fun GlassesLiveCard(app: TinyApp, onClose: () -> Unit) {
    val frame by GlassesLive.frame.collectAsState()
    val status by GlassesLive.status.collectAsState()
    val transcribing by GlassesLive.transcribing.collectAsState()
    val transcript by GlassesLive.transcript.collectAsState()
    val lastError by GlassesLive.lastError.collectAsState()

    val micAsk = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) GlassesLive.toggleTranscription(app)
    }

    // The card's presence IS the stream's lifetime (iOS onAppear/onDisappear).
    DisposableEffect(Unit) {
        GlassesLive.start(app)
        onDispose { GlassesLive.stop() }
    }

    // Where the user has parked it. `remember`, not saved state, so it starts
    // back in the corner next time — iOS's `@State restingOffset` does the same.
    var resting by remember { mutableStateOf(Offset.Zero) }
    var card by remember { mutableStateOf(IntSize.Zero) }

    // The constraints ARE the travel limits: this composable is placed in the
    // top-end column of a fillMaxSize Box, so the incoming max is the space the
    // card is allowed to roam. Reading them here keeps the clamp local — the
    // alternative is hoisting drag state into MainActivity, which two other
    // sessions also edit.
    BoxWithConstraints(Modifier.padding(top = 8.dp, end = 8.dp)) {
        // ⚠️ An unbounded axis (a scrolling parent, one day) would make "how far
        // may it travel" meaningless and let the card be flung out of reach.
        // Zero travel is the safe reading of "unknown", not infinite travel.
        val boxW = if (constraints.hasBoundedWidth) constraints.maxWidth.toFloat() else card.width.toFloat()
        val boxH = if (constraints.hasBoundedHeight) constraints.maxHeight.toFloat() else card.height.toFloat()

        Surface(
            shape = RoundedCornerShape(14.dp),
            tonalElevation = 6.dp,
            shadowElevation = 12.dp,
            modifier = Modifier
                .offset { IntOffset(resting.x.roundToInt(), resting.y.roundToInt()) }
                .onSizeChanged { card = it }
                // The gesture is on the whole card, as on iOS. The mic and close
                // icons keep their taps: a click resolves before the drag's touch
                // slop is crossed, so the two don't compete.
                .pointerInput(Unit) {
                    detectDragGestures { _, delta ->
                        val (x, y) = clampToBox(
                            resting.x + delta.x, resting.y + delta.y,
                            card.width.toFloat(), card.height.toFloat(), boxW, boxH,
                        )
                        resting = Offset(x, y)
                    }
                }
                .width(236.dp),
        ) {
            Column {
                Box(Modifier.fillMaxWidth().height(177.dp).background(Color.Black)) {
                    frame?.let {
                        Image(
                            it.asImageBitmap(), contentDescription = "glasses live view",
                            modifier = Modifier.fillMaxWidth().height(177.dp),
                            contentScale = ContentScale.Crop,
                        )
                    } ?: Column(
                        Modifier.align(Alignment.Center).padding(horizontal = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text("🕶", style = MaterialTheme.typography.titleMedium)
                        Text(
                            lastError ?: status,
                            style = MaterialTheme.typography.labelSmall,
                            color = Color.Gray,
                        )
                    }
                }
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (transcribing) Icons.Filled.Mic else Icons.Filled.MicOff,
                        contentDescription = if (transcribing) "stop transcribing" else "transcribe what the glasses hear",
                        tint = if (transcribing) MaterialTheme.colorScheme.primary
                               else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp).clickable {
                            if (transcribing) GlassesLive.toggleTranscription(app)
                            else micAsk.launch(Manifest.permission.RECORD_AUDIO)
                        },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        transcript.ifEmpty { if (transcribing) "listening through the glasses…" else "mic off" },
                        style = MaterialTheme.typography.labelSmall,
                        color = if (transcript.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant
                                else MaterialTheme.colorScheme.onSurface,
                        maxLines = 2,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(
                        Icons.Filled.Close, contentDescription = "close glasses live view",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp).clickable { onClose() },
                    )
                }
            }
        }
    }
}

/**
 * Where a dragged card is allowed to rest, given its size and the box it roams.
 *
 * The card starts flush in the TOP-END corner, so `(0, 0)` is that corner:
 * x travels negative (leftward) and y positive (downward), and neither may take
 * a single edge past the box. That bound is the point — a card dragged off
 * screen keeps its close button off screen with it, and closing is the only way
 * to stop the glasses camera, so losing the card means a stream the user can
 * see no way to end. (iOS's overlay has no clamp; this is the reason ported, not
 * the omission.)
 *
 * ⚠️ A card LARGER than its box is why the ranges are built with `maxOf`:
 * `coerceIn(min, max)` **throws** when `min > max`, so the naive
 * `x.coerceIn(boxW - cardW, 0f)` would crash on the first drag of a card that
 * doesn't fit — a landscape phone, a small window, a foldable's cover screen.
 * No travel is the right answer there, not an exception.
 *
 * Pulled out as plain floats because a JVM unit test cannot touch Compose's
 * layout — the same seam as `WearablesBridge.scaledTo` and `GlassesCameraAsk.await`.
 */
internal fun clampToBox(
    x: Float,
    y: Float,
    cardW: Float,
    cardH: Float,
    boxW: Float,
    boxH: Float,
): Pair<Float, Float> = Pair(
    x.coerceIn(-maxOf(0f, boxW - cardW), 0f),
    y.coerceIn(0f, maxOf(0f, boxH - cardH)),
)

package technology.tiny.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Hearing
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material.icons.filled.SubtitlesOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import technology.tiny.app.TinyApp
import technology.tiny.app.fleet.TinyLive

/**
 * 💎 The necklace's floating live card — iOS TinyLiveOverlay parity.
 * Remote mode shows relay frames (~1-3s cadence, warm-camera firmware) with
 * an ear button for a 2s listen; LAN mode is the ~20fps MJPEG stream.
 */
@Composable
fun TinyLiveCard(app: TinyApp, onClose: () -> Unit) {
    val frame by TinyLive.frame.collectAsState()
    val status by TinyLive.status.collectAsState()
    val mode by TinyLive.mode.collectAsState()
    val listening by TinyLive.listening.collectAsState()
    val liveText by TinyLive.liveText.collectAsState()
    val transcribing by TinyLive.transcribe.collectAsState()
    val scribeNote by TinyLive.scribeNote.collectAsState()

    Surface(
        shape = RoundedCornerShape(14.dp),
        tonalElevation = 6.dp,
        shadowElevation = 12.dp,
        modifier = Modifier.padding(top = 8.dp, end = 8.dp).width(236.dp),
    ) {
        Column {
            Box(Modifier.fillMaxWidth().height(177.dp).background(Color.Black)) {
                frame?.let {
                    Image(
                        it.asImageBitmap(), contentDescription = "necklace live view",
                        modifier = Modifier.fillMaxWidth().height(177.dp).clip(RoundedCornerShape(0.dp)),
                        contentScale = ContentScale.Crop,
                    )
                } ?: Column(
                    Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("💎", style = MaterialTheme.typography.titleMedium)
                    Text(status, style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                }
                // The words the necklace is hearing, over its own picture, the way
                // captions sit on video — the audio was already being decoded and
                // played, and the speech in it was thrown away.
                //
                // Scrimmed and bottom-anchored because it lands ON a photograph of
                // an unknown room: white-on-bright is unreadable exactly when the
                // board is pointed somewhere well-lit.
                liveText.takeIf { it.isNotBlank() }?.let { words ->
                    Text(
                        words,
                        style = MaterialTheme.typography.labelSmall,
                        color = Color.White,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.align(Alignment.BottomStart)
                            .fillMaxWidth()
                            .background(Color.Black.copy(alpha = 0.55f))
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (mode == TinyLive.Mode.REMOTE) {
                    if (listening) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(
                            Icons.Filled.Hearing, contentDescription = "listen through the necklace",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(18.dp).clickable { TinyLive.remoteListen(app.api) },
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    if (mode == TinyLive.Mode.LAN) "tiny necklace · live" else "tiny necklace · remote",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                if (mode == TinyLive.Mode.LAN) {
                    // LAN only, and not a decoration: transcription reads the
                    // direct PCM stream, which remote mode does not have. Offered
                    // as a control because a continuously-read microphone in
                    // someone's home is something they must be able to switch off
                    // without ending the video.
                    Icon(
                        if (transcribing) Icons.Filled.Subtitles else Icons.Filled.SubtitlesOff,
                        contentDescription = if (transcribing) "stop reading the necklace's audio"
                        else "read the necklace's audio",
                        tint = if (transcribing) MaterialTheme.colorScheme.tertiary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp).clickable { TinyLive.toggleTranscribe() },
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Icon(
                    Icons.Filled.Close, contentDescription = "close live view",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp).clickable { TinyLive.stop(); onClose() },
                )
            }
            // Why there are no words, when there are none. Without this the panel
            // shows a playing stream and an empty caption bar, which reads exactly
            // like a silent room.
            scribeNote?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.padding(horizontal = 10.dp).padding(bottom = 8.dp),
                )
            }
        }
    }
}

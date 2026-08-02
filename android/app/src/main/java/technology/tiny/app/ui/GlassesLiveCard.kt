package technology.tiny.app.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import technology.tiny.app.TinyApp
import technology.tiny.app.fleet.GlassesLive

/**
 * 🕶️ The glasses' floating live card — iOS GlassesLiveOverlay parity,
 * TinyLiveCard's shape (the two stack when both are open). Live camera on
 * top; below it a mic toggle + the on-device transcript strip. The mic is
 * an explicit tap, never auto-started — privacy posture inherited from iOS.
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

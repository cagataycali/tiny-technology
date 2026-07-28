package technology.tiny.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import technology.tiny.app.fleet.Media

/**
 * Tappable "Open in Spotify" chips for any open.spotify.com URLs in an assistant
 * reply (iOS Media.spotifyLinks + Views.swift chip row parity). The agent often
 * answers a music question with a bare link; a chip makes it one tap to play
 * instead of a raw URL in the prose. Renders nothing when there are no links.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SpotifyChips(text: String) {
    val links = Media.spotifyLinks(text)
    if (links.isEmpty()) return
    val context = LocalContext.current
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.padding(top = 6.dp),
    ) {
        links.forEach { url ->
            Surface(
                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.14f),
                shape = RoundedCornerShape(999.dp),
                modifier = Modifier.clickable {
                    runCatching {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse(url))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                },
            ) {
                Text(
                    "🎵 Open in Spotify",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
    }
}

package technology.tiny.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * 🔒 Lock panel shown in the composer's place for a private tiny this device
 * isn't vouched for (web Chat.tsx lock-hero / iOS PrivateLockPanel parity). A
 * signed-in visitor taps "Unlock" (their session vouches an owner with no key);
 * anyone can also type the access key. Sits on the darkened private surface —
 * the whole room reads as gated, not just this panel.
 *
 * [signedIn] leads with a one-tap Unlock for a logged-in owner; a visitor's
 * button waits for a non-empty key. [onUnlock] receives the (possibly blank)
 * key and routes to /api/login via the ViewModel.
 */
@Composable
fun PrivateLockPanel(
    tiny: String,
    accent: Color,
    signedIn: Boolean,
    onUnlock: (String) -> Unit,
) {
    var key by remember { mutableStateOf("") }
    val canUnlock = signedIn || key.trim().isNotEmpty()
    Column(
        Modifier
            .fillMaxWidth()
            .padding(12.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(accent.copy(alpha = 0.25f))
            .padding(1.dp)
            .clip(RoundedCornerShape(19.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 16.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            Icons.Filled.Lock,
            contentDescription = null,
            tint = accent.copy(alpha = 0.85f),
            modifier = Modifier.size(30.dp),
        )
        Text(
            "$tiny is private",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            if (signedIn) "If it's yours, unlock it. Otherwise enter its access key."
            else "Its owner decides who can talk to it. Enter the access key, or sign in if it's yours.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = key,
                onValueChange = { key = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("access key") },
                singleLine = true,
                shape = RoundedCornerShape(22.dp),
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { if (canUnlock) onUnlock(key) }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = accent.copy(alpha = 0.55f),
                    unfocusedBorderColor = accent.copy(alpha = 0.25f),
                    cursorColor = accent,
                ),
            )
            Button(
                onClick = { onUnlock(key) },
                enabled = canUnlock,
                colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = MaterialTheme.colorScheme.onPrimary),
                border = BorderStroke(1.dp, accent.copy(alpha = 0.4f)),
            ) {
                Text("Unlock", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

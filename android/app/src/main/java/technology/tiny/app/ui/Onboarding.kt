package technology.tiny.app.ui

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.clickable
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.launch
import technology.tiny.app.Config
import technology.tiny.app.ui.theme.TinyAccent
import technology.tiny.app.ui.theme.TinyGray
import java.util.Locale

/** Languages scripts/gen-onboarding-voice.mjs ships (public/onboarding-voice/)
 *  — keep in sync with the script and iOS OnboardingNarrator.langs. */
private val NARRATION_LANGS = setOf(
    "en", "tr", "de", "fr", "es", "it", "pt", "nl", "ru", "ar", "hi", "ja", "ko", "zh",
)

/**
 * First-run tour — Android analog of iOS Onboarding.swift (5-page pager).
 * Sells the same story (brand → fleet node → voice → surfaces → identity) but
 * page 3 lists only surfaces that actually ship on Android (no vaporware).
 * Requests NO OS permissions — those are deferred to post-login / first use,
 * matching MainActivity.askNotificationsOnce and the mic runtime ask.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OnboardingScreen(
    initialTinyName: String,
    initialAutoSpeak: Boolean,
    onAutoSpeakChange: (Boolean) -> Unit,
    onTinyNameChange: (String) -> Unit,
    onSignIn: () -> Unit,
    onSkip: () -> Unit,
) {
    val last = 4
    val pager = rememberPagerState(pageCount = { last + 1 })
    val scope = rememberCoroutineScope()
    var autoSpeak by remember { mutableStateOf(initialAutoSpeak) }
    var tinyName by remember { mutableStateOf(initialTinyName.takeUnless { it == "tiny" } ?: "") }

    // ── Narration: one ~10s ElevenLabs clip per page, in the device language
    // when we ship it, English otherwise (iOS OnboardingNarrator twin). Clips
    // stream from the CDN; any failure stays silent — the tour reads fine
    // without sound. Mute is one obvious tap, persisted for replays.
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("tiny_onboarding", Context.MODE_PRIVATE) }
    var muted by remember { mutableStateOf(prefs.getBoolean("voice_muted", false)) }
    val serverBase = remember { Config(context).serverBase }
    val player = remember { MediaPlayer() }
    DisposableEffect(Unit) { onDispose { player.release() } }
    val audioManager = remember { context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager }
    LaunchedEffect(pager.currentPage, muted) {
        player.reset()
        if (muted) return@LaunchedEffect
        // LOCKED product decision (user, 2026-07-25, iOS twin uses .ambient):
        // a phone in silent/vibrate starts the tour silent — the ringer mode
        // outranks the narration, even though Android media streams wouldn't
        // be muted by it on their own.
        if (audioManager.ringerMode != android.media.AudioManager.RINGER_MODE_NORMAL) return@LaunchedEffect
        val lang = Locale.getDefault().language.takeIf { it in NARRATION_LANGS } ?: "en"
        try {
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            player.setDataSource("$serverBase/onboarding-voice/$lang/p${pager.currentPage}.mp3")
            player.setOnPreparedListener { it.start() }
            player.prepareAsync()
        } catch (_: Exception) { /* silent tour */ }
    }

    Surface(Modifier.fillMaxSize(), color = Color.Black) {
        Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(horizontal = 32.dp).padding(top = 48.dp, bottom = 24.dp)) {
            HorizontalPager(state = pager, modifier = Modifier.weight(1f)) { page ->
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    when (page) {
                        0 -> WelcomePage()
                        1 -> StoryPage(
                            emoji = "📡",
                            title = "Your phone becomes a node",
                            body = "Sign in and this phone joins your fleet. Your web agent can reach it from anywhere — ask what's around and the phone answers with a live scan, battery, unread messages.",
                            caption = "Manage every device at tiny.technology/devices — revoke this one anytime.",
                        )
                        2 -> StoryPage(
                            emoji = "🎙️",
                            title = "Talk to it",
                            body = "Voice mode keeps the mic open and transcribes on-device — pause 3 seconds and your thought sends itself. Replies can speak through the phone.",
                        ) {
                            Spacer(Modifier.height(20.dp))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("Speak replies aloud", color = MaterialTheme.colorScheme.onSurface)
                                Spacer(Modifier.width(12.dp))
                                Switch(
                                    checked = autoSpeak,
                                    onCheckedChange = { autoSpeak = it; onAutoSpeakChange(it) },
                                    colors = SwitchDefaults.colors(
                                        checkedTrackColor = TinyAccent,
                                        checkedThumbColor = Color.Black, // Panels.kt switch parity
                                    ),
                                )
                            }
                        }
                        3 -> StoryPage(
                            emoji = "🧩",
                            title = "It's everywhere",
                            body = "tiny lives beyond this chat — it keeps working when the app is closed.",
                        ) {
                            Spacer(Modifier.height(20.dp))
                            DiscoveryRow("🔔", "Reply from the notification", "a DM banner takes your reply inline — no need to open the app")
                            DiscoveryRow("📡", "Background fleet node", "answers your web agent and checks messages on a schedule while closed")
                            DiscoveryRow("🎙️", "Hands-free voice", "open the mic, speak, pause — it sends and can read the reply back")
                            DiscoveryRow("📎", "Photos & documents", "attach images or PDFs/docs straight into the chat")
                            DiscoveryRow("⤵️", "Updates over the air", "new versions install themselves — no store, no waiting")
                        }
                        4 -> StoryPage(
                            emoji = "🌱",
                            title = "Make it yours",
                            body = "Which tiny does this app chat with? Leave it empty for the original — change anytime in ⚙️ settings.",
                        ) {
                            Spacer(Modifier.height(20.dp))
                            OutlinedTextField(
                                value = tinyName,
                                onValueChange = { tinyName = it.trim(); onTinyNameChange(tinyName) },
                                placeholder = { Text("tiny") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(
                                    capitalization = KeyboardCapitalization.None,
                                    imeAction = ImeAction.Done,
                                ),
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
            }

            // page dots
            Row(
                Modifier.fillMaxWidth().padding(vertical = 16.dp),
                horizontalArrangement = Arrangement.Center,
            ) {
                repeat(last + 1) { i ->
                    Box(
                        Modifier.padding(horizontal = 4.dp).size(8.dp).clip(CircleShape)
                            .background(if (i == pager.currentPage) TinyAccent else TinyGray.copy(alpha = 0.4f)),
                    )
                }
            }

            if (pager.currentPage < last) {
                Button(
                    onClick = { scope.launch { pager.animateScrollToPage(pager.currentPage + 1) } },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = TinyAccent, contentColor = Color.Black),
                ) { Text("continue") }
                TextButton(onClick = onSkip, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text("skip", color = TinyGray)
                }
            } else {
                Button(
                    onClick = onSignIn,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = TinyAccent, contentColor = Color.Black),
                ) { Text("🔑 sign in with tiny.technology") }
                Spacer(Modifier.height(8.dp))
                Text(
                    "GitHub login in a secure browser tab.\nNo passwords touch this app.",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(onClick = onSkip, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text("not now", color = TinyGray)
                }
            }
        }

        // Narration mute — top-right, emoji icon per this file's style.
        Text(
            if (muted) "🔇" else "🔊",
            fontSize = 20.sp,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 12.dp, end = 16.dp)
                .clip(CircleShape)
                .clickable {
                    muted = !muted
                    prefs.edit().putBoolean("voice_muted", muted).apply()
                }
                .padding(8.dp),
        )
        }
    }
}

@Composable
private fun WelcomePage() {
    NeonMark()
    Spacer(Modifier.height(20.dp))
    Text("tiny", fontSize = 42.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, color = TinyAccent)
    Spacer(Modifier.height(16.dp))
    Text(
        "Your own AI — free, forever.\nCreate it, chat with it, grow it.\nThis app puts your tiny in your pocket.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun StoryPage(
    emoji: String,
    title: String,
    body: String,
    caption: String? = null,
    extra: @Composable (() -> Unit)? = null,
) {
    Text(emoji, fontSize = 56.sp)
    Spacer(Modifier.height(16.dp))
    Text(
        // headlineMedium (26sp sans token) — the hardcoded 26sp had no fontFamily,
        // so it silently fell back to raw Roboto over the themed body text.
        title, style = MaterialTheme.typography.headlineMedium,
        color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(12.dp))
    Text(
        body, style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
    )
    caption?.let {
        Spacer(Modifier.height(12.dp))
        Text(it, style = MaterialTheme.typography.labelSmall, color = TinyGray, textAlign = TextAlign.Center)
    }
    extra?.invoke()
}

@Composable
private fun DiscoveryRow(icon: String, title: String, sub: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(icon, fontSize = 20.sp, modifier = Modifier.width(36.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
            Text(sub, style = MaterialTheme.typography.labelSmall, color = TinyGray)
        }
    }
}

/** The launcher-icon mark, drawn in Compose: dark core, green orbit ring, a spark. */
@Composable
private fun NeonMark(size: androidx.compose.ui.unit.Dp = 132.dp) {
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val c = Offset(this.size.width / 2f, this.size.height / 2f)
        val r = this.size.minDimension * 0.30f
        // dark core
        drawCircle(color = Color(0xFF020604), radius = r, center = c)
        // green ring
        drawCircle(color = TinyAccent, radius = r, center = c, style = Stroke(width = r * 0.13f))
        // dashed orbit
        drawCircle(
            color = TinyAccent.copy(alpha = 0.5f),
            radius = r * 1.55f,
            center = c,
            style = Stroke(
                width = r * 0.06f,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(r * 0.35f, r * 0.35f)),
            ),
        )
        // spark, top-right of orbit
        drawCircle(color = Color.White, radius = r * 0.13f, center = Offset(c.x + r * 1.1f, c.y - r * 1.1f))
    }
}

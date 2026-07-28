package technology.tiny.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.ui.draganddrop.mimeTypes
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.outlined.Login
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Handyman
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Podcasts
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.Sensors
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SystemUpdateAlt
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import technology.tiny.app.chat.ChatMessage
import technology.tiny.app.chat.ChatViewModel
import technology.tiny.app.ui.bidi
import technology.tiny.app.ui.OnboardingScreen
import technology.tiny.app.ui.theme.TinyAccent
import technology.tiny.app.ui.theme.TinyTheme
import java.security.SecureRandom

class MainActivity : ComponentActivity() {

    private val app get() = application as TinyApp
    private var authError by mutableStateOf<String?>(null)
    // Set when launched/resumed from a DM notification tap → deep-links to that thread.
    private var deepLinkDm by mutableStateOf<String?>(null)
    // Set from a widget tap: tinyapp://ask|voice|memory|messages → routes in ChatScreen.
    private var deepLinkRoute by mutableStateOf<String?>(null)
    // Set from a dynamic recent-tiny launcher shortcut: tinyapp://tiny?name=<slug>.
    private var deepLinkTiny by mutableStateOf<String?>(null)
    // Set when another app shares text to tiny (ACTION_SEND) or the text-selection
    // toolbar sends a selection (ACTION_PROCESS_TEXT) → seeds the composer.
    private var sharedText by mutableStateOf<String?>(null)
    // Set when another app shares image(s) to tiny (ACTION_SEND / SEND_MULTIPLE
    // image/*) → content:// URIs (as strings) the composer encodes into attachments.
    private var sharedImageUris by mutableStateOf<List<String>>(emptyList())
    // Set when another app shares document(s) to tiny (PDF/CSV/DOCX/… SEND) →
    // content:// URIs the composer encodes into document attachments.
    private var sharedDocUris by mutableStateOf<List<String>>(emptyList())
    // Debug-only: force the first-run tour to render over a logged-in session.
    private var previewOnboarding by mutableStateOf(false)
    private val notifPermission =
        registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) {}

    private fun askNotificationsOnce() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        val prefs = getSharedPreferences("tiny_config", MODE_PRIVATE)
        if (prefs.getBoolean("asked_notifications", false)) return
        prefs.edit().putBoolean("asked_notifications", true).apply()
        notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Rebuild the recent-tiny dynamic launcher shortcuts from the MRU store so
        // they survive a cold start / process death (dynamic shortcuts aren't sticky).
        RecentTinys.refresh(this)
        // Only consume the launch intent on a FRESH create. singleTask has no
        // configChanges, so a rotation / dark-mode toggle / process-death restore
        // re-runs onCreate with the SAME retained launch intent — re-firing these
        // would replay the deep-link the UI already handled (onRouteConsumed etc.
        // null the Compose state but can't clear the sticky intent). Worst case is
        // the auth callback: saveSession already cleared pendingState, so a replay
        // hits state != pendingState → a bogus "login state mismatch" on rotate.
        // A genuinely new intent while alive arrives via onNewIntent, not here.
        if (savedInstanceState == null) {
            handleAuthCallback(intent)
            handleDebugExtras(intent)
            handleDmDeepLink(intent)
            handleWidgetRoute(intent)
            handleSharedText(intent)
        }
        setContent {
            TinyTheme {
                val user by app.auth.user.collectAsState()
                val loggedOut = user == null && !app.auth.isLoggedIn
                // A token past its stored expiry can only 401 — route to sign-in at
                // launch with honest copy instead of letting every surface fail with
                // network-looking errors (the reactive 401 message still covers
                // mid-session expiry). Chat history/config are untouched; a fresh
                // sign-in drops straight back into the same account.
                val sessionExpired = !loggedOut && app.auth.isSessionExpired
                // First-run tour: only when signed out AND never onboarded (iOS parity).
                var onboarded by remember { mutableStateOf(app.config.onboarded) }
                when {
                    previewOnboarding -> OnboardingScreen(
                        initialTinyName = app.config.tinyName,
                        initialAutoSpeak = app.config.autoSpeak,
                        onAutoSpeakChange = { app.config.autoSpeak = it },
                        onTinyNameChange = { app.config.tinyName = it.ifBlank { "tiny" } },
                        onSignIn = { previewOnboarding = false },
                        onSkip = { previewOnboarding = false },
                    )
                    sessionExpired -> LoginScreen(
                        error = "your session expired — sign in again to pick up where you left off",
                        onLogin = ::launchLogin,
                    )
                    !loggedOut -> {
                        // Reaching the main app marks the tour done (existing installs skip it).
                        LaunchedEffect(Unit) { if (!app.config.onboarded) app.config.onboarded = true }
                        technology.tiny.app.ui.AdaptiveChat(
                            login = user?.login,
                            openDmWith = deepLinkDm,
                            onDmConsumed = { deepLinkDm = null },
                            widgetRoute = deepLinkRoute,
                            onRouteConsumed = { deepLinkRoute = null },
                            tinyRoute = deepLinkTiny,
                            onTinyConsumed = { deepLinkTiny = null },
                            sharedText = sharedText,
                            onSharedTextConsumed = { sharedText = null },
                            sharedImageUris = sharedImageUris,
                            onSharedImagesConsumed = { sharedImageUris = emptyList() },
                            sharedDocUris = sharedDocUris,
                            onSharedDocsConsumed = { sharedDocUris = emptyList() },
                            onReplayTour = { previewOnboarding = true },
                            // A signed-out 402 (server rejected a not-yet-locally-expired
                            // token) can reach the in-chat paywall; give it the same
                            // launchLogin entry point the LoginScreen uses.
                            onSignIn = ::launchLogin,
                        )
                    }
                    !onboarded -> OnboardingScreen(
                        initialTinyName = app.config.tinyName,
                        initialAutoSpeak = app.config.autoSpeak,
                        onAutoSpeakChange = { app.config.autoSpeak = it },
                        onTinyNameChange = { app.config.tinyName = it.ifBlank { "tiny" } },
                        onSignIn = { app.config.onboarded = true; onboarded = true; launchLogin() },
                        onSkip = { app.config.onboarded = true; onboarded = true },
                    )
                    else -> LoginScreen(error = authError, onLogin = ::launchLogin)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthCallback(intent)
        handleDebugExtras(intent)
        handleDmDeepLink(intent)
        handleWidgetRoute(intent)
        handleSharedText(intent)
    }

    /**
     * Another app shared text to tiny (ACTION_SEND text/plain) or the text-selection
     * toolbar sent a selection (ACTION_PROCESS_TEXT) → seed the composer. iOS has no
     * share extension, so this is an Android-native reach: highlight anything
     * anywhere → "tiny" → the app opens with it in the composer, ready to ask.
     * A shared URL comes through EXTRA_TEXT too, so no separate handling needed.
     *
     * A shared IMAGE (SEND or SEND_MULTIPLE, image mime) rides EXTRA_STREAM instead — the
     * URIs are parked for the composer to encode into attachments (iOS attaches shared
     * photos; the Android picker already does, so the share entry point should too). A
     * single image share can ALSO carry a caption in EXTRA_TEXT, so both are handled.
     */
    private fun handleSharedText(intent: Intent?) {
        intent ?: return
        val text = when (intent.action) {
            Intent.ACTION_SEND ->
                intent.getStringExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_PROCESS_TEXT ->
                intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
            else -> null
        }
        text?.trim()?.takeIf { it.isNotEmpty() }?.let { sharedText = it.take(4000) }

        val type = intent.type
        val streamUris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intentStreamUri(intent))
            Intent.ACTION_SEND_MULTIPLE -> intentStreamUris(intent)
            else -> emptyList()
        }
        if (streamUris.isEmpty()) return
        // Route by mime: image/* attaches as photos, everything else is treated as a
        // document candidate (PDF/CSV/DOCX/…). A doc share can arrive typed as its
        // real mime, or generically as */* or application/octet-stream — the composer's
        // encodeDocument resolves the format by mime THEN extension and rejects anything
        // unsupported with a clear message, so parking the URIs here is safe.
        if (type?.startsWith("image/") == true) {
            sharedImageUris = streamUris.map { it.toString() }
        } else {
            sharedDocUris = streamUris.map { it.toString() }
        }
    }

    @Suppress("DEPRECATION")
    private fun intentStreamUri(intent: Intent): android.net.Uri? =
        if (android.os.Build.VERSION.SDK_INT >= 33)
            intent.getParcelableExtra(Intent.EXTRA_STREAM, android.net.Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun intentStreamUris(intent: Intent): List<android.net.Uri> =
        if (android.os.Build.VERSION.SDK_INT >= 33)
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, android.net.Uri::class.java).orEmpty()
        else intent.getParcelableArrayListExtra<android.net.Uri>(Intent.EXTRA_STREAM).orEmpty()

    /** Widget tap: tinyapp://ask|voice|memory|messages → park route for ChatScreen. */
    private fun handleWidgetRoute(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "tinyapp") return
        // tinyapp://* is a BROWSABLE scheme, so ANY web page's <a href="tinyapp://voice">
        // reaches here — and the voice route auto-starts the mic when RECORD_AUDIO is
        // already granted (see the ChatScreen LaunchedEffect). A silent web link must
        // never activate a hardware sensor. The trusted origins (widget taps, launcher
        // shortcuts) build their Intent WITHOUT CATEGORY_BROWSABLE; a browser hand-off
        // always carries it. So downgrade a browsable voice link to "ask" (focus the
        // composer — the same safe landing a no-recognizer device gets), keeping the
        // mic gated behind a real in-app gesture. Non-voice routes are inert (open a
        // panel / focus a box) and stay as-is.
        val browsable = intent.categories?.contains(Intent.CATEGORY_BROWSABLE) == true
        when (uri.host) {
            "ask", "voice", "memory", "messages" -> deepLinkRoute = safeWidgetRoute(uri.host, browsable)
            "tiny" -> uri.getQueryParameter("name")?.takeIf { it.isNotBlank() }?.let { deepLinkTiny = it }
        }
    }

    /** DM notification tap carries the sender login → open that thread. */
    private fun handleDmDeepLink(intent: Intent?) {
        intent?.getStringExtra(technology.tiny.app.fleet.DmNotifier.EXTRA_OPEN_WITH)?.let {
            deepLinkDm = it
        }
    }

    /** Debug builds only: `adb shell am start … --es update_base http://127.0.0.1:8787` */
    private fun handleDebugExtras(intent: Intent?) {
        if (!technology.tiny.app.BuildConfig.DEBUG) return
        intent?.getStringExtra("update_base")?.let { base ->
            app.config.updateBase = base.ifBlank { null }
            lifecycleScope.launch { app.updater.check() }
        }
        // `--es test_dm_notify <login>` fires a sample DM banner to exercise the
        // notification + inline-reply path (no second account needed to test).
        // `--ez preview_onboarding true` renders the tour without signing out.
        if (intent?.getBooleanExtra("preview_onboarding", false) == true) previewOnboarding = true
        // `--ez tiny_harness_graph true` swaps the memory graph's DATASET for a demo
        // one so a store screenshot doesn't publish the user's own facts. See
        // ui/GraphHarness for what stays real; it re-gates on BuildConfig.DEBUG.
        if (intent?.getBooleanExtra(technology.tiny.app.ui.GraphHarness.EXTRA_GRAPH, false) == true) {
            app.graphHarness = true
        }
        // `--ez tiny_harness_fleet true` swaps the devices sheet's ROWS for a demo fleet
        // so a store screenshot doesn't publish the user's real device hostnames. See
        // ui/FleetHarness; it re-gates on BuildConfig.DEBUG.
        if (intent?.getBooleanExtra(technology.tiny.app.ui.FleetHarness.EXTRA_FLEET, false) == true) {
            app.fleetHarness = true
        }
        // `--ez tiny_harness_memory true` swaps the memory LIST sheet's BOTH datasets
        // (server learnings AND on-device memories) for a demo set, and routes its two
        // deletes away from the account/device store. See ui/MemoryHarness; it re-gates
        // on BuildConfig.DEBUG.
        if (intent?.getBooleanExtra(technology.tiny.app.ui.MemoryHarness.EXTRA_MEMORY, false) == true) {
            app.memoryHarness = true
        }
        intent?.getStringExtra("test_dm_notify")?.let { who ->
            technology.tiny.app.fleet.DmNotifier.notifyNewDm(
                this, who, who, "test DM — reply to check the RemoteInput path 👋",
            )
        }
    }

    // Fleet loops run only while foregrounded (background story comes later
    // via WorkManager / foreground service).
    override fun onStart() {
        super.onStart()
        app.fleet.foreground = true // suppress the background-only "web agent reached" trace
        app.fleet.start()
        // Let the set_brightness device tool drive THIS window while it's foreground
        // (Android brightness is per-window; must be applied on the UI thread).
        app.deviceTools.brightnessController = { level ->
            runOnUiThread {
                window.attributes = window.attributes.apply { screenBrightness = level }
            }
        }
        lifecycleScope.launch { app.updater.checkSoon() }
        if (app.auth.isLoggedIn) {
            askNotificationsOnce()
            technology.tiny.app.fleet.DmPollWorker.schedule(this) // background DM polling
            technology.tiny.app.fleet.RelayService.sync(this) // re-arm always-on node if enabled
        }
    }

    override fun onStop() {
        super.onStop()
        app.fleet.foreground = false // relay invokes now leave a shade trace (iOS parity)
        // Drop the brightness setter so a backgrounded window isn't driven; the
        // per-window override is released with the window anyway.
        app.deviceTools.brightnessController = null
        // When always-on is enabled the foreground RelayService owns the fleet
        // loops — leave them running so the phone stays reachable while locked.
        if (!app.config.alwaysOn) app.fleet.stop()
    }

    private fun launchLogin() {
        val state = ByteArray(16).also { SecureRandom().nextBytes(it) }
            .joinToString("") { "%02x".format(it) }
        app.auth.pendingState = state
        CustomTabsIntent.Builder().build().launchUrl(
            this,
            Uri.parse("https://tiny.technology/auth/cli?scheme=tinyapp&state=$state"),
        )
    }

    private fun handleAuthCallback(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "tinyapp" || uri.host != "auth") return
        val code = uri.getQueryParameter("code") ?: return
        val state = uri.getQueryParameter("state") ?: return
        if (state != app.auth.pendingState) {
            authError = "login state mismatch — try again"
            return
        }
        exchangeCode(code, state)
    }

    private fun exchangeCode(code: String, state: String) {
        lifecycleScope.launch {
            try {
                val res = app.api.exchangeCliCode(code, state)
                val token = res.optString("token")
                if (res.optBoolean("ok") && token.isNotEmpty()) {
                    val userObj = res.optJSONObject("user") ?: org.json.JSONObject()
                    app.auth.saveSession(token, userObj, res.optString("expires"))
                    // Cross-user identity leak: local continuity (turn log + memories in
                    // filesDir) is keyed by the device-level tiny name, not per-user, and
                    // never re-syncs from the server. If a DIFFERENT account signs in on
                    // this device, wipe it + the widget snapshot so the prior user's private
                    // turns/facts don't bleed into the new user's buildContext. The anchor
                    // (in the plaintext widget prefs, which survives logout) makes this fire
                    // ONLY on a real switch — same-user re-login keeps their continuity.
                    // (iOS Session.loadMe scrub, bb0ed15; the widget half is cycle-48 parity.)
                    if (technology.tiny.app.widget.WidgetStore.recordLoginDetectSwitch(app, userObj.optString("login"))) {
                        app.continuity.scrubAllLocal()
                        technology.tiny.app.widget.WidgetBridge.scrubIdentity(app)
                        // DM state is per-user too: the unread snapshot (unread_by_login)
                        // and any posted DM banners belong to the PRIOR user. Without this
                        // the new user sees the old user's leftover DM banners and the
                        // unread diff baselines against the old user's counts (misfires
                        // until re-primed). Sign-out already calls reset (Panels.kt); a
                        // switch is the same identity boundary, so reset here too.
                        technology.tiny.app.fleet.DmNotifier.reset(app)
                        // Agent-scheduled alerts are per-user content too: without this the
                        // prior user's alerts keep FIRING on the new user's device (their
                        // title/body), and the Jobs panel lists them. Cancel the jobs + drop
                        // the sidecar. And forget the recents/launcher shortcuts — they name
                        // (and deep-link into) the prior user's tinys.
                        technology.tiny.app.tools.AlertStore.scrubAll(app)
                        technology.tiny.app.RecentTinys.clear(app)
                        // Fleet device credentials (device_id/device_token, the tind_…
                        // node identity) are user-scoped too, but saveSession() only
                        // rewrites token/user/expires — unlike logout()'s prefs.clear() —
                        // so the PRIOR user's creds survive the switch. enrollIfNeeded()
                        // early-returns on non-null creds (FleetManager:118), so the phone
                        // keeps heartbeating + relaying as the OLD user's enrolled device:
                        // A's web agent can still reach this phone via /api/devices/relay
                        // (device-token auth, not session) and drive screenshot/flashlight/
                        // open_url/speak on B's device. Clear so it re-enrolls as the new
                        // user; sign-out already drops these via logout(), a switch is the
                        // same identity boundary.
                        app.auth.clearDevice()
                        // BYO-model config lives in its OWN encrypted prefs file
                        // (tiny_model), which neither this block nor logout()'s
                        // tiny_auth clear() touches. The api_key / voice_openai_key are
                        // the PRIOR user's paid secrets: without this reset every one of
                        // the new user's chat requests carries A's key via headers()
                        // (billed to A), voice calls carry it via voiceHeaders(), and
                        // Settings → model prefills + reveals A's plaintext key. Reset to
                        // the free default so B starts clean; hydrateFromRemote() then
                        // pulls B's own synced config. Same identity boundary as the rest.
                        app.modelConfig.reset()
                        // User-scoped channels in tiny_config: A's offline send queue
                        // (flushed from B's account on reconnect — send() uses the
                        // current session token), A's half-typed composer draft, and A's
                        // activity high-water mark. Device/tiny-level prefs are kept.
                        app.config.scrubIdentity()
                    }
                    authError = null
                    app.fleet.start()
                } else {
                    authError = "login failed — try again"
                }
            } catch (t: Throwable) {
                authError = t.message ?: "login failed"
            }
        }
    }
}

/**
 * Pure deep-link route gate (unit-testable without the Android framework).
 *
 * tinyapp:// is a BROWSABLE scheme, so any web page can hand off tinyapp://voice
 * — and the voice route auto-starts the mic when RECORD_AUDIO is already granted.
 * A silent web link must never trip a hardware sensor. Trusted origins (widget
 * taps, launcher shortcuts) build their Intent without CATEGORY_BROWSABLE; a
 * browser hand-off always carries it. When [browsable] is true we downgrade the
 * mic route ("voice") to "ask" (focus the composer), so the mic stays behind a
 * real in-app gesture. Every other route is inert (opens a panel / focuses a box)
 * and passes through unchanged from either origin.
 */
/** Voice-call tools this device executes LOCALLY (runVoiceTool). Everything
 *  else — including screenshot's round-trip, handled before this check —
 *  forwards to /api/voice/tool so server-roster additions reach stale builds. */
private val LOCAL_VOICE_TOOLS = setOf(
    "vibrate", "flashlight", "copy_to_clipboard", "set_brightness", "play_sound",
    "schedule_alert", "cancel_alerts", "open_url", "render_ui", "remember", "forget",
)

fun safeWidgetRoute(host: String?, browsable: Boolean): String? = when {
    host == "voice" && browsable -> "ask"
    else -> host
}

@Composable
fun LoginScreen(error: String?, onLogin: () -> Unit) {
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            // Wordmark moment: mono stays (prose elsewhere is sans).
            Text(
                "tiny",
                style = MaterialTheme.typography.titleLarge.copy(
                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                ),
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "create your own AI by chatting",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))
            Button(onClick = onLogin, shape = RoundedCornerShape(12.dp)) {
                Icon(Icons.AutoMirrored.Outlined.Login, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("sign in with tiny.technology")
            }
            error?.let {
                Spacer(Modifier.height(16.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(
    login: String?,
    openDmWith: String? = null,
    onDmConsumed: () -> Unit = {},
    widgetRoute: String? = null,
    onRouteConsumed: () -> Unit = {},
    tinyRoute: String? = null,
    onTinyConsumed: () -> Unit = {},
    sharedText: String? = null,
    onSharedTextConsumed: () -> Unit = {},
    sharedImageUris: List<String> = emptyList(),
    onSharedImagesConsumed: () -> Unit = {},
    sharedDocUris: List<String> = emptyList(),
    onSharedDocsConsumed: () -> Unit = {},
    onReplayTour: () -> Unit = {},
    // Signed-out 402 paywall → authenticate (launchLogin). Null-safe: in a
    // context without an auth entry point the paywall card just omits the button.
    onSignIn: (() -> Unit)? = null,
    vm: ChatViewModel = viewModel(),
) {
    val app = androidx.compose.ui.platform.LocalContext.current.applicationContext as TinyApp
    // The draft must survive everything: recomposition (remember), activity
    // recreation (saveable), and — via the config write-through below — a root
    // back press (which FINISHES the activity, discarding saveable state), process
    // death, and AdaptiveChat's 600dp branch swap on rotate (which changes this
    // call's saveable slot path and orphans the bundled value). A half-typed
    // message silently vanishing is trust-killer #1 in
    // docs/android-app-audit-2026-07-23.md; reproduced live: type → back to
    // launcher → relaunch ate the draft.
    var input by androidx.compose.runtime.saveable.rememberSaveable {
        mutableStateOf(app.config.composerDraft)
    }
    LaunchedEffect(Unit) {
        snapshotFlow { input }.collect { app.config.composerDraft = it }
    }
    // Command-palette keyboard selection (hardware kbd) — web CommandPalette.tsx
    // parity: ArrowUp/Down move a clamped index, Enter runs the highlighted row.
    var paletteIndex by remember { mutableStateOf(0) }
    // Escape/Back dismisses an open palette so a hardware-keyboard user can send
    // "/c" LITERALLY instead of being forced to run the highlighted command (web
    // CommandPalette.tsx:294 + iOS paletteDismissed, 7ffff0a). Any draft edit
    // re-arms it (onValueChange), so typing another char re-opens suggestions.
    var paletteDismissed by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val inputFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    // Transcript search (iOS .searchable parity): live case-insensitive substring
    // filter over message text only, current conversation, matching bubbles only.
    var searching by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    val searchFocus = remember { androidx.compose.ui.focus.FocusRequester() }

    // System back closes the active in-chat overlay before leaving the app — the
    // gesture people expect (predictive-back is opted in at the manifest, so this
    // also drives the peek animation). Highest-priority overlay wins: search box,
    // then voice mode. Bottom sheets handle their own back via ModalBottomSheet.
    val voiceStatusForBack by vm.voice.status.collectAsState()
    val voiceLive = voiceStatusForBack == technology.tiny.app.chat.VoiceMode.Status.LISTENING ||
        voiceStatusForBack == technology.tiny.app.chat.VoiceMode.Status.HEARING
    androidx.activity.compose.BackHandler(enabled = searching) {
        searching = false; searchQuery = ""
    }
    androidx.activity.compose.BackHandler(enabled = !searching && voiceLive) {
        vm.voice.stop()
    }

    // Follow the stream only while the user is pinned near the bottom (web
    // autoScrollRef, Chat.tsx:597-617). Before this, EVERY streaming token yanked
    // the view to the last message, so scrolling up to read history mid-reply
    // dragged you straight back down each token. "Near bottom" = last item visible
    // AND scrolled within ~600px of its end; scrolling up un-pins, scrolling back
    // re-pins — same feel as web's 150px CSS-pixel threshold.
    val pinnedToBottom by remember {
        derivedStateOf {
            val layout = listState.layoutInfo
            val last = layout.visibleItemsInfo.lastOrNull()
            last == null || (last.index >= layout.totalItemsCount - 1 &&
                last.offset + last.size <= layout.viewportEndOffset + 600)
        }
    }
    LaunchedEffect(vm.messages.size, vm.messages.lastOrNull()?.text?.length, searching) {
        // Re-pin unconditionally the moment the user sends — send() appends the user
        // msg AND an empty streaming assistant placeholder together, so the tell is a
        // blank streaming reply at the tail. Web sets autoScrollRef=true on send
        // (Chat.tsx:1051) so a user scrolled up into history snaps back to watch the
        // reply. Once tokens land the placeholder is non-blank and the pin guard takes
        // over (scrolling up again un-follows). Otherwise only follow while pinned.
        val last = vm.messages.lastOrNull()
        val justSent = last?.role == "assistant" && last.streaming && last.text.isBlank()
        if (vm.messages.isNotEmpty() && !searching && (pinnedToBottom || justSent)) {
            scope.launch { listState.animateScrollToItem(vm.messages.size - 1) }
        }
    }
    // A tiny-switch / conversation load resets the anchor: always jump to the newest
    // message regardless of the prior scroll position (web re-pins autoScrollRef=true
    // on switch, Chat.tsx:1051). Without this, opening a long history lands mid-scroll.
    LaunchedEffect(vm.tiny) {
        if (vm.messages.isNotEmpty()) listState.scrollToItem(vm.messages.size - 1)
        // 👀 Visit beacon, once per tiny mount (web Chat.tsx:405 useEffect([name])).
        vm.sendVisit(vm.tiny)
        // 💵 Up-front price lookup so a paid tiny shows its per-message cost badge
        // before a 402 hits mid-send (web Chat.tsx priceMicro effect on [name]).
        vm.fetchPrice(vm.tiny)
    }

    var showSettings by remember { mutableStateOf(false) }
    var showDevices by remember { mutableStateOf(false) }
    // Overflow (⋮) menu — surfaces the browse/explore panels the top-bar icons don't
    // have room for (universe, wallet, toolbox, jobs, memory, nearby). Before this
    // they were reachable ONLY by typing a slash command or via the wide-layout
    // sidebar, so on a phone the tiny universe (users/tinys/tools) had no discoverable
    // entry (iOS Views.swift has a dedicated universe toolbar button).
    var showOverflow by remember { mutableStateOf(false) }
    // 📞 Real speech-to-speech call (voice/VoiceCall) — INLINE in this chat
    // (web/iOS inline-chat parity, replaces the old full-screen
    // VoiceCallScreen): transcripts land in the thread as real messages,
    // typed composer text joins the call, and tool_call frames run on the
    // same device executors chat uses. A slim strip above the composer is
    // the only dedicated UI.
    val liveCall = remember { technology.tiny.app.voice.VoiceCall() }
    // 📞 At the CHAT root we only care about the call's PHASE (a handful of
    // slow, discrete transitions). The full State also carries `level`, which
    // VoiceCall rewrites on every audio frame (~23×/sec during LIVE). Collecting
    // the whole State object here subscribed this entire composable to those
    // per-frame mutations, recomposing the whole chat screen ~23×/sec during a
    // live call. Mapping to phase + distinctUntilChanged keeps the root pinned
    // to the ~5 real transitions; the fast-changing `level`/`error` fields are
    // collected only inside the in-call strip below, so just that slim strip
    // repaints per frame.
    val callPhase by remember(liveCall) {
        liveCall.state.map { it.phase }.distinctUntilChanged()
    }.collectAsState(initial = liveCall.state.value.phase)
    val callScope = rememberCoroutineScope()
    DisposableEffect(Unit) { onDispose { liveCall.dispose() } }
    // System back hangs up an active call before leaving the app — back IS the
    // hang-up gesture people expect. The voice back handler above watches only
    // VoiceMode (dictation); without this, during a CONNECTING/LIVE/ERROR call
    // both handlers were disabled, so back fell through to the singleTask root
    // and QUIT THE APP (killing the call via onDispose) instead of ending it and
    // staying in chat. Mirrors the strip's End/Dismiss action + visible-when
    // condition (MainActivity.kt:1334/1404); gated !searching so the search box
    // keeps back priority, matching the handler ordering above.
    val callActiveForBack = callPhase != technology.tiny.app.voice.VoiceCall.Phase.IDLE &&
        callPhase != technology.tiny.app.voice.VoiceCall.Phase.ENDED
    androidx.activity.compose.BackHandler(enabled = !searching && callActiveForBack) {
        if (callPhase == technology.tiny.app.voice.VoiceCall.Phase.ERROR ||
            callPhase == technology.tiny.app.voice.VoiceCall.Phase.BYOK_REQUIRED
        ) liveCall.dismiss() else liveCall.stop()
    }
    // 📞 Foreground privilege tracks the call: LIVE → CallService carries
    // mic+playback through screen-off/backgrounding (started here, while the
    // activity is foreground — API 34+ requires that for a microphone FGS);
    // any other phase → stop. Keyed on phase so END/error always releases it.
    LaunchedEffect(callPhase) {
        if (callPhase == technology.tiny.app.voice.VoiceCall.Phase.LIVE) {
            // Same default-resolution as the call mint below — the notification
            // should name the tiny actually on the line.
            technology.tiny.app.voice.CallService.start(app, if (vm.tiny != "tiny") vm.tiny else app.config.tinyName)
        } else {
            technology.tiny.app.voice.CallService.stop(app)
        }
    }
    // 📞 Switching tinys hangs up: the live call is bound to the OLD tiny (its
    // persona, its WS), but the transcript hooks write into whatever thread is
    // CURRENT — without this, a mid-call switch bled the old tiny's call into
    // the new tiny's history (web parity: the [name]-keyed effect stops it).
    LaunchedEffect(vm.tiny) {
        if (callPhase == technology.tiny.app.voice.VoiceCall.Phase.LIVE ||
            callPhase == technology.tiny.app.voice.VoiceCall.Phase.CONNECTING
        ) liveCall.stop()
    }
    // Voice-call tool bridge: execute with the SAME executors the chat stream
    // routes to (DeviceTools / the MediaProjection screenshot pipeline /
    // render_ui native cards), then ALWAYS answer up the WS — a dropped
    // tool_result would stall the model's turn (iOS runVoiceTool parity).
    // Runs on the WS reader thread; DeviceTools dispatches into its own scope.
    val runVoiceTool: (String, String, org.json.JSONObject) -> Unit = { id, name, args ->
        if (name == "screenshot") {
            // Round-trip: consent activity → MediaProjection one-frame capture →
            // upload; Screenshot.deliver/postDenied emit on app.screenshots for
            // EVERY outcome ("" = denied/failed), keyed by our unique voice id —
            // replay=1 staleness can't match it. Timeout is the last resort.
            callScope.launch {
                val voiceId = "voice-" + java.util.UUID.randomUUID().toString()
                val waiter = async {
                    withTimeoutOrNull(120_000) { app.screenshots.first { it.toolUseId == voiceId } }
                }
                technology.tiny.app.tools.ScreenshotConsentActivity.launch(app, voiceId)
                val res = waiter.await()
                val out = when {
                    res == null -> org.json.JSONObject().put("ok", false)
                        .put("error", "capture timed out")
                    res.url.isEmpty() -> org.json.JSONObject().put("denied", true)
                        .put("note", "the user declined this capture")
                    else -> org.json.JSONObject().put("ok", true).put("url", res.url)
                }
                runCatching { liveCall.sendToolResult(id, out) }
            }
        } else if (name !in LOCAL_VOICE_TOOLS) {
            // Server tools (worker-backed memory + DMs — send_message was the
            // user ask) AND any roster tool this build doesn't know locally —
            // /api/voice/tool runs the same session-bound objects chat mounts;
            // a truly unknown name gets the proxy's honest 404 note back, and
            // server-roster additions work on STALE builds. viaTiny stamps
            // the sender surface for send_message.
            callScope.launch {
                val out = runCatching {
                    val r = app.api.postJson(
                        "/api/voice/tool",
                        org.json.JSONObject().put("name", name).put("args", args).put("viaTiny", vm.tiny),
                    )
                    if (r.optBoolean("ok")) r.optJSONObject("result") ?: r else r
                }.getOrElse { t ->
                    org.json.JSONObject().put("ok", false).put("error", t.message ?: "failed")
                }
                runCatching { liveCall.sendToolResult(id, out) }
            }
        } else {
            val output = runCatching {
                when (name) {
                    "vibrate", "flashlight", "copy_to_clipboard", "set_brightness",
                    "play_sound", "schedule_alert", "cancel_alerts", "open_url" -> {
                        app.deviceTools.handle(name, args)
                        org.json.JSONObject().put("ok", true)
                    }
                    "render_ui" -> {
                        // Native card on the live voice bubble (props-only contract).
                        vm.voiceRenderUi(args)
                        org.json.JSONObject().put("ok", true).put("note", "card rendered in the chat")
                    }
                    // Same Continuity store the chat stream's remember/forget use.
                    "remember" -> {
                        val content = args.optString("content").trim()
                        if (content.isEmpty()) {
                            org.json.JSONObject().put("ok", false).put("error", "content required")
                        } else {
                            val tags = args.optJSONArray("tags")
                                ?.let { t -> (0 until t.length()).map { t.optString(it) } } ?: emptyList()
                            app.continuity.addMemory(vm.tiny, content, tags)
                            org.json.JSONObject().put("ok", true).put("note", "remembered")
                        }
                    }
                    "forget" -> {
                        val match = args.optString("match").trim()
                        if (match.isEmpty()) {
                            org.json.JSONObject().put("ok", false).put("error", "match required")
                        } else {
                            app.continuity.forgetMemory(vm.tiny, match)
                            org.json.JSONObject().put("ok", true)
                        }
                    }
                    else -> org.json.JSONObject().put("ok", false)
                        .put("error", "not available on this device yet")
                }
            }.getOrElse { t ->
                org.json.JSONObject().put("ok", false).put("error", t.message ?: "failed")
            }
            runCatching { liveCall.sendToolResult(id, output) }
        }
    }
    // 📞 Start the call INSIDE this chat: wire the WS hooks into the VM's
    // voice-turn methods (they hop to main themselves), then dial. Caller
    // gates RECORD_AUDIO; VoiceCall.start no-ops while CONNECTING/LIVE.
    val startInlineCall = {
        liveCall.onUserTranscript = { vm.voiceUserSaid(it) }
        liveCall.onResponseStarted = { vm.voiceAssistantStarted() }
        liveCall.onAssistantDelta = { vm.voiceAssistantDelta(it) }
        liveCall.onResponseDone = { vm.voiceAssistantDone() }
        // Barged-over turn finalizes what was said so far (iOS parity).
        liveCall.onBargeIn = { vm.voiceAssistantDone() }
        liveCall.onToolCall = { id, name, args -> runVoiceTool(id, name, args) }
        liveCall.start(
            base = app.config.serverBase,
            // Resolve the "tiny" default to the user's configured tiny the SAME
            // way TinyApi.chat routes requests — otherwise a custom-default user
            // chats with THEIR tiny but the call answers as the meta-agent
            // (iOS Views.startInlineCall parity, fixed there in build 53).
            // Continuity stays keyed by vm.tiny: that's the key this surface
            // reads/writes turns under.
            tiny = if (vm.tiny != "tiny") vm.tiny else app.config.tinyName,
            token = app.auth.token,
            // Voice is OpenAI-only — send the dedicated voice key (or the chat key
            // iff chat is itself on OpenAI), NEVER a Bedrock/Anthropic chat key.
            modelHeaders = app.modelConfig.voiceHeaders(),
            // Continuity rides into the session instructions — the voice agent
            // starts knowing what the chat agent knows (memories + recent turns).
            context = app.continuity.buildContext(vm.tiny),
        )
    }
    // 🎙 Owner-only per-tiny call-voice picker (voice/VoicePickerSheet).
    var showVoicePicker by remember { mutableStateOf(false) }
    // Builder-profile sheet — @login tapped in the universe browser (or elsewhere).
    var profileLogin by remember { mutableStateOf<String?>(null) }
    // DM notification tap → open Messages straight into that sender's thread.
    var dmDeepLink by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(openDmWith) {
        openDmWith?.let {
            dmDeepLink = it
            vm.openPanel = "messages"
            onDmConsumed()
        }
    }
    // Widget deep links (tinyapp://ask|voice|memory|messages).
    LaunchedEffect(widgetRoute) {
        when (widgetRoute) {
            "ask" -> runCatching { inputFocus.requestFocus() }
            // On a no-recognizer device (some tablets, AOSP/emulator, Chromebooks)
            // vm.voice.start() just flips to DENIED (VoiceMode.kt:81) — the same
            // dead-end 4a097c3 gated out of the composer mic-morph via hasVoiceInput.
            // The widget-voice deep link was the ungated twin: gate it the same way
            // and fall back to focusing the composer (the "ask" route's behavior) so
            // the tap still lands somewhere useful instead of a silent/errored no-op.
            "voice" -> if (!android.speech.SpeechRecognizer.isRecognitionAvailable(app)) {
                runCatching { inputFocus.requestFocus() }
            } else if (androidx.core.content.ContextCompat.checkSelfPermission(
                    app, android.Manifest.permission.RECORD_AUDIO,
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            ) vm.voice.start()
            "memory" -> vm.openPanel = "memory"
            "messages" -> vm.openPanel = "messages"
        }
        if (widgetRoute != null) onRouteConsumed()
    }
    // Dynamic recent-tiny launcher shortcut (tinyapp://tiny?name=<slug>).
    LaunchedEffect(tinyRoute) {
        tinyRoute?.let {
            vm.switchTiny(it)
            onTinyConsumed()
        }
    }
    // Shared text (ACTION_SEND / ACTION_PROCESS_TEXT) → seed the composer + focus it.
    // Doesn't auto-send: the user may want to edit or add context before asking.
    LaunchedEffect(sharedText) {
        sharedText?.let {
            input = it
            runCatching { inputFocus.requestFocus() }
            onSharedTextConsumed()
        }
    }
    // Shared image(s) (ACTION_SEND / SEND_MULTIPLE, image mime) → encode into pending
    // attachments, same pipeline + MAX cap as the in-app picker. Encoding is off the
    // main thread (a shared 50MP photo would jank/ANR the UI); a URI we can't read is
    // surfaced, never silently dropped. Doesn't auto-send — the user adds a prompt.
    LaunchedEffect(sharedImageUris) {
        if (sharedImageUris.isEmpty()) return@LaunchedEffect
        var readFailed = false
        for (uriStr in sharedImageUris) {
            if (vm.pendingImages.size + vm.pendingDocs.size >= technology.tiny.app.chat.Attachments.MAX) {
                vm.error = "up to ${technology.tiny.app.chat.Attachments.MAX} attachments per message"
                break
            }
            val b64 = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                technology.tiny.app.chat.Attachments.encode(app, android.net.Uri.parse(uriStr))
            }
            if (b64 != null) vm.addPendingImage(b64) else readFailed = true
        }
        if (readFailed && vm.error == null) vm.error = "couldn't read that image — try another"
        runCatching { inputFocus.requestFocus() }
        onSharedImagesConsumed()
    }
    // Shared document(s) (PDF/CSV/DOCX/… SEND) → encode into pending doc attachments,
    // same encodeDocument pipeline + MAX cap + 3MB limit as the in-app doc picker. The
    // first Err message (unsupported type / too large / unreadable) is surfaced verbatim
    // — a doc's failure reason matters more than an image's, so we don't collapse it to a
    // generic line. Off the main thread; doesn't auto-send.
    LaunchedEffect(sharedDocUris) {
        if (sharedDocUris.isEmpty()) return@LaunchedEffect
        for (uriStr in sharedDocUris) {
            if (vm.pendingImages.size + vm.pendingDocs.size >= technology.tiny.app.chat.Attachments.MAX) {
                vm.error = "up to ${technology.tiny.app.chat.Attachments.MAX} attachments per message"
                break
            }
            val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                technology.tiny.app.chat.Attachments.encodeDocument(app, android.net.Uri.parse(uriStr))
            }
            when (r) {
                is technology.tiny.app.chat.Attachments.DocResult.Ok -> vm.addPendingDoc(r.doc)
                is technology.tiny.app.chat.Attachments.DocResult.Err ->
                    if (vm.error == null) vm.error = r.message
            }
        }
        runCatching { inputFocus.requestFocus() }
        onSharedDocsConsumed()
    }
    // Slash-command panel routing (/memory /universe /devices /settings)
    when (vm.openPanel) {
        "settings" -> { showSettings = true; vm.openPanel = null }
        "devices" -> { showDevices = true; vm.openPanel = null }
    }
    val accent = vm.accentHex?.let { hex ->
        runCatching { androidx.compose.ui.graphics.Color(android.graphics.Color.parseColor(hex)) }.getOrNull()
    } ?: TinyAccent
    val themeBg = vm.bgHex?.let { hex ->
        runCatching { androidx.compose.ui.graphics.Color(android.graphics.Color.parseColor(hex)) }.getOrNull()
    }
    // Status-bar icons must flip dark on a light theme.bg — the activity is
    // otherwise permanently dark-themed, so the clock/battery rendered white
    // over e.g. hashtagrobotics' #EDEFF2 page (seen on device).
    val view = androidx.compose.ui.platform.LocalView.current
    val lightBg = themeBg?.let { it.luminance() > 0.5f } ?: false
    SideEffect {
        (view.context as? android.app.Activity)?.window?.let { w ->
            androidx.core.view.WindowCompat.getInsetsController(w, view).isAppearanceLightStatusBars = lightBg
        }
    }

    // Everything inside reads colorScheme.primary as THIS tiny's accent and
    // colorScheme.background as its page color (web --tiny-accent/--tiny-bg
    // parity) — bubbles, badges, chips, send button, markdown, and the
    // sheets/dialogs emitted below.
    technology.tiny.app.ui.theme.TinyAccentTheme(accent, themeBg) {
    if (showSettings) technology.tiny.app.ui.SettingsSheet(
        app,
        onReplayTour = { showSettings = false; onReplayTour() },
    ) { showSettings = false }
    if (showDevices) technology.tiny.app.ui.DevicesSheet(app) { showDevices = false }
    if (showVoicePicker) technology.tiny.app.voice.VoicePickerSheet(
        vm = vm,
        accent = accent,
    ) { showVoicePicker = false }
    if (vm.openPanel == "memory") {
        technology.tiny.app.ui.MemorySheet(app, vm.tiny, onOpenGraph = { vm.openPanel = "graph" }) { vm.openPanel = null }
    }
    if (vm.openPanel == "graph") {
        technology.tiny.app.ui.GraphSheet(app) { vm.openPanel = null }
    }
    if (vm.openPanel == "messages") {
        technology.tiny.app.ui.MessagesSheet(
            app,
            initialWith = dmDeepLink,
            onOpenProfile = { profileLogin = it },
        ) {
            vm.openPanel = null; dmDeepLink = null
        }
    }
    if (vm.openPanel == "jobs") {
        technology.tiny.app.ui.JobsSheet(app) { vm.openPanel = null }
    }
    if (vm.openPanel == "toolbox") {
        technology.tiny.app.ui.ToolboxSheet(vm) { vm.openPanel = null }
    }
    if (vm.openPanel == "sessions") {
        technology.tiny.app.ui.SessionsSheet(vm) { vm.openPanel = null }
    }
    if (vm.openPanel == "calls") {
        technology.tiny.app.ui.CallRecordingsSheet(app) { vm.openPanel = null }
    }
    if (vm.openPanel == "nearby") {
        technology.tiny.app.ui.NearbySheet(app) { vm.openPanel = null }
    }
    if (vm.openPanel == "map") {
        technology.tiny.app.ui.MapSheet(app) { vm.openPanel = null }
    }
    if (vm.openPanel == "activity") {
        technology.tiny.app.ui.ActivitySheet(app) { vm.openPanel = null }
    }
    if (vm.openPanel == "universe") {
        technology.tiny.app.ui.UniverseSheet(
            app,
            onPick = { vm.switchTiny(it) },
            onOpenProfile = { profileLogin = it },
        ) { vm.openPanel = null }
    }
    if (vm.openPanel == "wallet") {
        technology.tiny.app.ui.WalletSheet(app) { vm.openPanel = null; vm.onWalletDismissed() }
    }
    if (vm.openPanel == "chain") {
        technology.tiny.app.ui.ChainSheet(app) { vm.openPanel = null }
    }
    profileLogin?.let { login ->
        technology.tiny.app.ui.ProfileSheet(
            app, login,
            onPickTiny = { vm.switchTiny(it); vm.openPanel = null },
        ) { profileLogin = null }
    }
    if (vm.confirmClear) {
        AlertDialog(
            onDismissRequest = { vm.confirmClear = false },
            title = { Text("Clear this conversation?") },
            text = { Text("This wipes the chat history for ${vm.tiny} on this device. It can't be undone.") },
            confirmButton = {
                TextButton(onClick = { vm.confirmClear = false; vm.clear() }) {
                    Text("clear", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { vm.confirmClear = false }) {
                    Text("cancel", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
        )
    }
    // 🕶️ Private-mode treatment (user request: "the ui will look slightly
    // dark"): a Box wraps the Scaffold so a soft dark scrim can float over the
    // WHOLE surface when the tiny is private (iOS Color.black opacity-0.22
    // overlay parity) — a private room FEELS different from the open universe.
    // Non-interactive so it never eats a tap; public tinys draw nothing.
    Box(Modifier.fillMaxSize()) {
    // 🗺️ Ambient map (phase 2, web GlobalMapBackdrop parity): while "share
    // location with your tiny" is on, a gesture-less dark map lives under the
    // whole chat and the Scaffold washes translucent over it — the same one
    // opt-in that feeds the agent's location context.
    val mapOn by technology.tiny.app.ui.rememberLocationContextOn(app)
    if (mapOn) {
        technology.tiny.app.ui.MapBackdrop(app, Modifier.matchParentSize())
    }
    // Spotlight: the wash thins while the agent presents on the map
    // (fly/tour), then fades back — AgentMap sets it for ~8s per gesture.
    val mapSpotlight by technology.tiny.app.tools.AgentMap.spotlight.collectAsState()
    val mapWashAlpha by androidx.compose.animation.core.animateFloatAsState(
        targetValue = if (mapSpotlight) 0.15f else 0.40f,
        animationSpec = androidx.compose.animation.core.tween(800),
        label = "map-wash",
    )
    Scaffold(
        // 0.55 → 0.40: the graded style (MapStyle.gradedMapStyle) now owns
        // most of the darkness — web 0.38 / iOS 0.32 siblings
        containerColor = if (mapOn) MaterialTheme.colorScheme.background.copy(alpha = mapWashAlpha)
            else MaterialTheme.colorScheme.background,
        topBar = {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (searching) {
                    OutlinedTextField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        modifier = Modifier.weight(1f).focusRequester(searchFocus),
                        placeholder = { Text("Search this chat") },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp),
                    )
                    IconButton(onClick = { searching = false; searchQuery = "" }) {
                        Icon(Icons.Filled.Close, contentDescription = "close search", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    LaunchedEffect(Unit) { runCatching { searchFocus.requestFocus() } }
                } else {
                    // Wordmark moment: mono + bold on purpose (body prose is sans).
                    Text(
                        "tiny",
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                        ),
                        color = accent,
                    )
                    if (vm.tiny != "tiny") {
                        // weight(fill=false) lets a long name shrink+ellipsize instead of
                        // shoving the ⋮ overflow menu off-screen (Mert Kırgıl, @mertkrgl).
                        Text(
                            " / ${vm.tiny}",
                            style = MaterialTheme.typography.labelSmall,
                            color = accent.copy(alpha = 0.7f),
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                    // 🔒 Private-tiny lock glyph — the owner always knows they're
                    // in a private room (the darkened surface reinforces it).
                    // Open padlock once vouched, closed while locked. Only shown
                    // when private, so a public tiny's bar is unchanged.
                    if (vm.isPrivate) {
                        Spacer(Modifier.width(6.dp))
                        Icon(
                            if (vm.isAuthorized) Icons.Filled.LockOpen else Icons.Filled.Lock,
                            contentDescription = if (vm.isAuthorized) "private, unlocked" else "private, locked",
                            tint = accent,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                    // 💵 The paid-tiny price badge moved OUT of the title bar and INTO
                    // the composer toolbar (right before the token estimate + Send) to
                    // match web Chat.tsx:2703 and iOS Views.swift:2428 — the cost now
                    // shows at the moment of commit, not up in the chrome.
                    Spacer(Modifier.weight(1f))
                    login?.let {
                        Text("@$it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { searching = true }) {
                        Icon(Icons.Filled.Search, contentDescription = "search chat", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    val unread by app.fleet.unread.collectAsState()
                    IconButton(onClick = { vm.openPanel = "messages" }) {
                        BadgedBox(badge = {
                            if (unread > 0) Badge(containerColor = MaterialTheme.colorScheme.primary) { Text("$unread") }
                        }) {
                            Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = "messages", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    val eventsUnread by app.fleet.eventsUnread.collectAsState()
                    IconButton(onClick = { vm.openPanel = "activity" }) {
                        BadgedBox(badge = {
                            if (eventsUnread > 0) Badge(containerColor = MaterialTheme.colorScheme.primary) {
                                Text(if (eventsUnread > 9) "9+" else "$eventsUnread")
                            }
                        }) {
                            Icon(Icons.Filled.Bolt, contentDescription = "activity", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Box {
                        IconButton(onClick = { showOverflow = true }) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "more", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        DropdownMenu(expanded = showOverflow, onDismissRequest = { showOverflow = false }) {
                            // Browse/explore surfaces that lack a top-bar icon. Same
                            // openPanel routes the slash commands + wide sidebar use.
                            // Soft tick when a browse surface reveals — web fires
                            // navigator.vibrate(10) on the universe drawer open
                            // (UniverseDrawer.tsx) and iOS a soft UIImpact on drawer
                            // opens (Theme.swift); the overflow was the one panel-reveal
                            // path here that stayed silent. TextHandleMove is the soft
                            // idiom (matches the send/palette tick), not the firm
                            // LongPress the attach/mic acks use.
                            val overflowHaptics = androidx.compose.ui.platform.LocalHapticFeedback.current
                            // Native leadingIcon (Material glyph) not an emoji prefix:
                            // iOS renders each of these drawer rows with an SF Symbol
                            // (Views.swift ~1968-2020: brain/wrench.and.screwdriver/
                            // clock/…radiowaves/gearshape), so the emoji labels were a
                            // 2-vs-1 gap AND the user asked for native icons here — the
                            // Material equivalents (Psychology/Handyman/Schedule/Sensors)
                            // give the polished, monochrome-tinted look the emoji lacked.
                            @Composable
                            fun item(icon: ImageVector, label: String, panel: String) = DropdownMenuItem(
                                text = { Text(label) },
                                leadingIcon = { Icon(icon, contentDescription = null) },
                                onClick = {
                                    overflowHaptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                                    showOverflow = false; vm.openPanel = panel
                                },
                            )
                            item(Icons.Outlined.Hub, "Universe", "universe")
                            item(Icons.Outlined.AccountBalanceWallet, "Wallet", "wallet")
                            // ⛓️ Directly under Wallet, because it answers the other
                            // half of the same question: the wallet says how much,
                            // the chain says on WHAT — and on a self-hosted
                            // deployment that's our own chain, which the phone had
                            // no way to see (iOS puts it in Settings' wallet
                            // section for the same reason).
                            item(Icons.Outlined.Link, "Chain", "chain")
                            item(Icons.Outlined.Handyman, "Toolbox", "toolbox")
                            item(Icons.Outlined.Schedule, "Scheduled jobs", "jobs")
                            item(Icons.Outlined.Podcasts, "Call recordings", "calls")
                            item(Icons.Outlined.Psychology, "Memory", "memory")
                            item(Icons.Outlined.Sensors, "Nearby", "nearby")
                            item(Icons.Outlined.Map, "Map", "map")
                            HorizontalDivider()
                            // Devices + Settings moved out of the icon row: with the
                            // overflow in place, SIX same-weight icons crowded the bar
                            // (design audit #4) — the badged, high-frequency surfaces
                            // (search / messages / activity) keep their icons, config
                            // lives here.
                            DropdownMenuItem(
                                text = { Text("Devices") },
                                leadingIcon = { Icon(Icons.Outlined.Devices, contentDescription = null) },
                                onClick = {
                                    overflowHaptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                                    showOverflow = false; showDevices = true
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Settings") },
                                leadingIcon = { Icon(Icons.Outlined.Settings, contentDescription = null) },
                                onClick = {
                                    overflowHaptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                                    showOverflow = false; showSettings = true
                                },
                            )
                            // Owner-only: the live-call voice is a per-tiny server
                            // field — everyone who calls this tiny hears it.
                            if (vm.isOwner) {
                                DropdownMenuItem(
                                    text = { Text("Call voice") },
                                    leadingIcon = { Icon(Icons.Outlined.GraphicEq, contentDescription = null) },
                                    onClick = {
                                        overflowHaptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                                        showOverflow = false; showVoicePicker = true
                                    },
                                )
                            }
                        }
                    }
                }
            }
        },
        bottomBar = {
            Column(Modifier.navigationBarsPadding().imePadding()) {
                UpdateBanner()
                // Hidden while any reply is still streaming (iOS Views.swift:1117
                // `!chat.streaming` guard) — mid-turn chips describe a reply the user
                // hasn't finished reading yet, and tapping one mid-stream double-sends.
                // Chip rail eases in when a reply finishes instead of popping (web
                // riseIn banner parity, toned down to a fade+slide).
                androidx.compose.animation.AnimatedVisibility(
                    visible = vm.followups.isNotEmpty() && vm.liveIds.isEmpty(),
                    enter = androidx.compose.animation.fadeIn() +
                        androidx.compose.animation.slideInVertically(initialOffsetY = { it / 2 }),
                    exit = androidx.compose.animation.fadeOut(),
                ) {
                    LazyRow(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(vm.followups.toList()) { chip ->
                            technology.tiny.app.ui.TinyChip(chip, onClick = { vm.send(chip) }, accent = accent)
                        }
                    }
                }
                val isOnline by vm.online.collectAsState()
                if (!isOnline) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Outlined.CloudOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "offline — messages will queue",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
                if (vm.autoRunning) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Outlined.Bedtime, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "working autonomously — send anything to stop",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
                // Concurrent-sends chip (web Chat.tsx:1989-2003 parity): with more than
                // one reply streaming, surface a compact "N replies streaming · stop all".
                // A single live stream keeps its per-bubble stop + the composer stop slot.
                if (vm.liveIds.size > 1) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "⏳ ${vm.liveIds.size} replies streaming",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.width(8.dp))
                        TextButton(
                            onClick = { vm.stopAll() },
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                        ) {
                            Text(
                                "stop all",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                // Transient composer banner (attachment too large / unsupported). Turn
                // failures now live inline on the reply bubble with a per-message Retry.
                vm.error?.let { err ->
                    Text(
                        err,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.labelSmall,
                        // Assertive liveRegion: this banner appears IMPERATIVELY after a
                        // user action (denied mic, oversized/unreadable attachment,
                        // session expiry) — a sighted user sees it flash in, but without
                        // this TalkBack said nothing, so a blind user got silence exactly
                        // when an action failed. Assertive (not Polite) because it's a
                        // time-sensitive error worth interrupting for; the Text's own
                        // string is the announced content. (VoiceCallScreen phase-line idiom.)
                        modifier = Modifier
                            .padding(horizontal = 16.dp)
                            .semantics { liveRegion = LiveRegionMode.Assertive },
                    )
                }
                val voiceStatus by vm.voice.status.collectAsState()
                val voicePartial by vm.voice.partial.collectAsState()
                val voiceLevel by vm.voice.level.collectAsState()
                // Derive from the collected flow — a plain property read wouldn't recompose.
                val voiceActive = voiceStatus == technology.tiny.app.chat.VoiceMode.Status.LISTENING ||
                    voiceStatus == technology.tiny.app.chat.VoiceMode.Status.HEARING
                // VoiceMode also flips to DENIED WITHOUT the permission dialog: when
                // speech recognition is unavailable (VoiceMode.kt:75) or a session
                // hits ERROR_INSUFFICIENT_PERMISSIONS mid-run (:142). The launcher's
                // else branch only catches the up-front dialog denial; the strip is
                // gated on LISTENING/HEARING and never shows DENIED, so these were
                // silent too. Pick copy by the real cause: no recognizer = a device
                // capability gap; recognizer present = a permission the user can flip.
                // (An up-front dialog denial leaves status IDLE, so this never
                // double-fires with the launcher message.)
                androidx.compose.runtime.LaunchedEffect(voiceStatus) {
                    if (voiceStatus == technology.tiny.app.chat.VoiceMode.Status.DENIED) {
                        vm.error = if (!android.speech.SpeechRecognizer.isRecognitionAvailable(app))
                            "Voice input isn't available on this device"
                        else
                            "Microphone access is off — enable it in Settings to use voice"
                    }
                }
                if (voiceActive) {
                    // 🎙️ Voice strip (web Chat.tsx:2318 + iOS 81dddc2): a pulsing
                    // accent dot + live status/partial transcript on an accent-tinted
                    // background. Was a plain 🎙 emoji + text — now matches web's
                    // `animate-ping` dot and `var(--tiny-accent)` tint (and the iOS
                    // ping strip), so themed tinys read consistently.
                    val stripAnimOff = technology.tiny.app.ui.rememberAnimationsOff()
                    val ping by androidx.compose.animation.core.rememberInfiniteTransition(label = "voice-ping")
                        .animateFloat(
                            initialValue = 0f,
                            targetValue = 1f,
                            animationSpec = androidx.compose.animation.core.infiniteRepeatable(
                                animation = androidx.compose.animation.core.tween(
                                    1100, easing = androidx.compose.animation.core.LinearEasing,
                                ),
                                repeatMode = androidx.compose.animation.core.RepeatMode.Restart,
                            ),
                            label = "voice-ping-progress",
                        )
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(accent.copy(alpha = 0.08f))
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // Solid dot + expanding ring behind it (web animate-ping).
                        Box(contentAlignment = Alignment.Center) {
                            if (!stripAnimOff) {
                                Box(
                                    Modifier
                                        .size(7.dp)
                                        .graphicsLayer {
                                            val s = 1f + ping * 1.4f
                                            scaleX = s; scaleY = s
                                            alpha = 0.6f * (1f - ping)
                                        }
                                        .background(accent, androidx.compose.foundation.shape.CircleShape),
                                )
                            }
                            Box(
                                Modifier
                                    .size(7.dp)
                                    .graphicsLayer {
                                        alpha = if (voiceStatus == technology.tiny.app.chat.VoiceMode.Status.HEARING) 1f else 0.5f
                                    }
                                    .background(accent, androidx.compose.foundation.shape.CircleShape),
                            )
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(
                            when {
                                voicePartial.isNotBlank() -> voicePartial
                                voiceStatus == technology.tiny.app.chat.VoiceMode.Status.HEARING -> "Hearing you…"
                                else -> "Listening — pause 3s to send"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = if (voicePartial.isNotBlank()) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Spacer(Modifier.weight(1f))
                        // 📊 Live mic level meter (web Chat.tsx:2337 voiceLevelRef):
                        // a thin accent bar that fills left→right with amplitude.
                        // animateFloat smooths the RMS jitter (web's 120ms linear
                        // transition); rounds to 0 when not actively listening.
                        val meterFill by androidx.compose.animation.core.animateFloatAsState(
                            targetValue = if (voiceActive) voiceLevel else 0f,
                            animationSpec = androidx.compose.animation.core.tween(120, easing = androidx.compose.animation.core.LinearEasing),
                            label = "voice-level",
                        )
                        Box(
                            Modifier
                                .padding(start = 8.dp)
                                .width(44.dp)
                                .height(3.dp)
                                .clip(RoundedCornerShape(2.dp))
                                .background(accent.copy(alpha = 0.12f)),
                        ) {
                            Box(
                                Modifier
                                    .fillMaxHeight()
                                    .fillMaxWidth(meterFill)
                                    .background(accent, RoundedCornerShape(2.dp)),
                            )
                        }
                    }
                }
                // 📞 In-call strip (inline-chat design, iOS callStrip parity): the
                // call lives INSIDE this chat now, so its only dedicated UI is this
                // slim status strip above the composer — styled like the dictation
                // voice strip above (accent-tinted row; error-tinted when the call
                // failed or needs a key). ENDED clears it; ERROR/BYOK stay visible
                // until dismissed so the user can read why.
                if (callPhase != technology.tiny.app.voice.VoiceCall.Phase.IDLE &&
                    callPhase != technology.tiny.app.voice.VoiceCall.Phase.ENDED
                ) {
                    // The fast-changing fields (`level` per audio frame, `error`)
                    // are collected HERE, scoped to the strip — so only this slim
                    // Row recomposes on the ~23×/sec mic-level updates, not the
                    // whole chat screen (the root collects phase-only above).
                    val callState by liveCall.state.collectAsState()
                    val callErr = callPhase == technology.tiny.app.voice.VoiceCall.Phase.ERROR ||
                        callPhase == technology.tiny.app.voice.VoiceCall.Phase.BYOK_REQUIRED
                    val stripTint = if (callErr) MaterialTheme.colorScheme.error else accent
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(stripTint.copy(alpha = 0.08f))
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Filled.Call,
                            contentDescription = null,
                            tint = stripTint,
                            modifier = Modifier.size(14.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            when (callPhase) {
                                technology.tiny.app.voice.VoiceCall.Phase.CONNECTING -> "Calling ${vm.tiny}…"
                                technology.tiny.app.voice.VoiceCall.Phase.LIVE ->
                                    "In call with ${vm.tiny} — recorded; type or talk"
                                else -> callState.error ?: "Call failed"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = if (callErr) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                            maxLines = 2,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Spacer(Modifier.weight(1f))
                        if (callPhase == technology.tiny.app.voice.VoiceCall.Phase.LIVE) {
                            // 📊 Mic level — the same 44×3 accent meter as the
                            // dictation voice strip above (120ms linear smoothing).
                            val callMeter by androidx.compose.animation.core.animateFloatAsState(
                                targetValue = callState.level,
                                animationSpec = androidx.compose.animation.core.tween(
                                    120, easing = androidx.compose.animation.core.LinearEasing,
                                ),
                                label = "call-level",
                            )
                            Box(
                                Modifier
                                    .padding(start = 8.dp)
                                    .width(44.dp)
                                    .height(3.dp)
                                    .clip(RoundedCornerShape(2.dp))
                                    .background(accent.copy(alpha = 0.12f)),
                            ) {
                                Box(
                                    Modifier
                                        .fillMaxHeight()
                                        .fillMaxWidth(callMeter)
                                        .background(accent, RoundedCornerShape(2.dp)),
                                )
                            }
                        }
                        if (callPhase == technology.tiny.app.voice.VoiceCall.Phase.BYOK_REQUIRED) {
                            // Route to the app's OWN model settings (the on-device
                            // encrypted key store) — a web tab couldn't set the key.
                            TextButton(
                                onClick = { liveCall.dismiss(); showSettings = true },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) {
                                Text("Add key", style = MaterialTheme.typography.labelSmall, color = accent)
                            }
                        }
                        TextButton(
                            onClick = { if (callErr) liveCall.dismiss() else liveCall.stop() },
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                        ) {
                            Text(
                                if (callErr) "Dismiss" else "End",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
                // Command palette: reveals when the composer starts with "/" (mobile-first
                // analog to web's ⌘⇧K picker — discoverable by typing, no extra button).
                // Filters live; tap runs immediately or prefills an arg-taking command.
                val trimmedInput = input.trimStart()
                // The composer stays fully usable while streams are live (concurrent
                // sends) — no busy gate on the palette either.
                val paletteOpen = trimmedInput.startsWith("/") && !trimmedInput.contains(" ") && !paletteDismissed
                val paletteMatches = if (paletteOpen) {
                    // Rank by web's fuzzyScore (CommandPalette.tsx sections useMemo),
                    // not static declaration order: the best match is the top row —
                    // the row a tap/Enter runs. A stable sort keeps declaration order
                    // among equal scores. (iOS realigned to the same ranking, c68.)
                    val q = trimmedInput.removePrefix("/")
                    technology.tiny.app.chat.SLASH_COMMANDS
                        .mapNotNull { cmd -> cmd.score(q)?.let { cmd to it } }
                        .sortedBy { it.second }
                        .map { it.first }
                } else emptyList()
                // Send haptic (iOS .sensoryFeedback(.impact, hapticSend) parity):
                // a light tick the instant a turn fires. Hoisted here (above
                // pickCommand) because iOS fires this inside the shared chat.send(),
                // so EVERY send path ticks — including a palette-run command. Android
                // fired it only in sendComposer, so a palette-run /clear or /help
                // felt dead while a normal send ticked. Honors the system setting.
                val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
                // Shared picker: run immediately or prefill an arg-taking command.
                val pickCommand: (technology.tiny.app.chat.SlashCommand) -> Unit = { cmd ->
                    if (cmd.runsImmediately) {
                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                        vm.send(cmd.insert); input = ""
                    } else { input = cmd.insert; inputFocus.requestFocus() }
                }
                // Keep the highlighted row in bounds as the live filter shrinks the list.
                LaunchedEffect(paletteMatches.size) {
                    if (paletteIndex >= paletteMatches.size) paletteIndex = 0
                }
                if (paletteMatches.isNotEmpty()) {
                    CommandPalette(
                        commands = paletteMatches,
                        selectedIndex = paletteIndex.coerceIn(0, paletteMatches.size - 1),
                        onPick = pickCommand,
                    )
                }
                // 🔒 Private tiny, this device NOT vouched: a lock panel replaces
                // the composer (web Chat.tsx lock-hero / iOS PrivateLockPanel
                // parity). The owner never sees it — fetchAccent's request carries
                // their token, the proxy vouches them (isAuthorized), and they get
                // the normal composer below (under the darkened private surface).
                if (vm.isPrivate && !vm.isAuthorized) {
                    technology.tiny.app.ui.PrivateLockPanel(
                        tiny = vm.tiny,
                        accent = accent,
                        signedIn = login != null,
                        onUnlock = { key -> vm.unlockPrivate(key) },
                    )
                } else {
                // Web composer parity (Chat.tsx:2277): ONE bordered rounded box that
                // owns the whole width — a borderless text field on top spans the full
                // width, and a toolbar row of icons ("+" attach left; camera/voice +
                // morphing send/stop/mic right) sits BELOW it inside the same border.
                // The buttons never share the field's row, so they can't steal its
                // horizontal space (the user's ask).
                //
                // STEADY accent border, brighter while focused — NO perpetual breathe.
                // The old repeatForever alpha pulse (0.22↔0.4) read as the whole text
                // bar throbbing (user-reported twice); iOS removed the same animation
                // for a steady glow (1a5a3c3 / OTA build 45), so Android matches: a
                // constant accent presence, only the focus change animates (once).
                val animationsOff = technology.tiny.app.ui.rememberAnimationsOff()
                val inputFocused = remember { androidx.compose.runtime.mutableStateOf(false) }
                val context = androidx.compose.ui.platform.LocalContext.current
                // `haptics` is hoisted above pickCommand (see there) so palette-run
                // commands tick too — every send path now matches iOS.
                // 🫳 Drag-and-drop target: highlight the box while an image drag hovers
                // (iOS dropTargeted, Views.swift:1436). A steady focus border otherwise.
                val dragTargeted = remember { androidx.compose.runtime.mutableStateOf(false) }
                val borderAlpha by androidx.compose.animation.core.animateFloatAsState(
                    targetValue = if (dragTargeted.value) 0.7f else if (inputFocused.value) 0.55f else 0.22f,
                    label = "composer-border-focus",
                )
                // Accent glow around the whole box, brighter while focused — the
                // composer is the page's figural element on web/iOS too (web
                // box-shadow 0 0 12px@0.10 idle → 24px@0.28 focus, Chat.tsx
                // composer-breathe; iOS .shadow radius 6→12 @0.10→0.28,
                // Views.swift:2365). Android had only the border ramp, so the
                // card read flat against the transcript. Compose colored shadows
                // ramp via elevation; a steady lift (no perpetual breathe, matching
                // the border decision) that only animates on the focus change.
                val glowElevation by androidx.compose.animation.core.animateDpAsState(
                    targetValue = if (inputFocused.value) 12.dp else 4.dp,
                    label = "composer-glow-focus",
                )
                // Drop an image from another app onto the composer (web onDrop /
                // iOS .dropDestination(for: Data/URL), Views.swift:1839). Natural on
                // a tablet / foldable / DeX / split-screen where two apps are visible.
                // Accepts image content URIs, honoring the same MAX cap + off-main
                // encode as the picker/paste paths; a light haptic confirms.
                val dropCallback = remember(vm) {
                    object : androidx.compose.ui.draganddrop.DragAndDropTarget {
                        override fun onDrop(event: androidx.compose.ui.draganddrop.DragAndDropEvent): Boolean {
                            val clip = event.toAndroidDragEvent().clipData ?: return false
                            var accepted = false
                            for (i in 0 until clip.itemCount) {
                                if (vm.pendingImages.size + vm.pendingDocs.size >= technology.tiny.app.chat.Attachments.MAX) break
                                val uri = clip.getItemAt(i)?.uri ?: continue
                                // Cross-app drag: take a read grant for this URI (the
                                // system extends it to the drop target for the gesture).
                                runCatching {
                                    (context as? MainActivity)?.requestDragAndDropPermissions(event.toAndroidDragEvent())
                                }
                                accepted = true
                                scope.launch {
                                    val b64 = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                        technology.tiny.app.chat.Attachments.encode(context, uri)
                                    }
                                    if (b64 != null) vm.addPendingImage(b64)
                                    else vm.error = "couldn't read the dropped image — try another"
                                }
                            }
                            if (accepted) haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                            return accepted
                        }
                        override fun onEntered(event: androidx.compose.ui.draganddrop.DragAndDropEvent) { dragTargeted.value = true }
                        override fun onExited(event: androidx.compose.ui.draganddrop.DragAndDropEvent) { dragTargeted.value = false }
                        override fun onEnded(event: androidx.compose.ui.draganddrop.DragAndDropEvent) { dragTargeted.value = false }
                    }
                }
                Column(
                    Modifier
                        // Readable measure on a tablet / unfolded foldable / landscape:
                        // cap the composer at ~760dp and center it, matching the
                        // transcript and iOS (Views.swift:1839 `.frame(maxWidth: 760)`
                        // + web max-w-4xl). Without this the bordered box stretched
                        // edge-to-edge on a wide screen — the opposite of "clean,
                        // centered". On a phone it still fills the full width.
                        .align(Alignment.CenterHorizontally)
                        .widthIn(max = 760.dp)
                        .fillMaxWidth()
                        .padding(12.dp)
                        .dragAndDropTarget(
                            shouldStartDragAndDrop = { event ->
                                event.mimeTypes().any { it.startsWith("image/") }
                            },
                            target = dropCallback,
                        )
                        // Accent glow behind the card (see glowElevation above) —
                        // BEFORE clip/background so the coloured shadow renders
                        // outside the rounded silhouette, not clipped away.
                        .shadow(
                            elevation = glowElevation,
                            shape = RoundedCornerShape(22.dp),
                            ambientColor = accent,
                            spotColor = accent,
                        )
                        .clip(RoundedCornerShape(22.dp))
                        // Translucent card fill so the composer reads as a distinct
                        // surface floating over the transcript — web has
                        // background: rgba(0,0,0,0.5) + backdrop-blur, iOS has
                        // .ultraThinMaterial. The box was transparent (only a border),
                        // so on a busy transcript the field blended into the messages
                        // behind it. A dim scrim gives it the same lift without a real
                        // blur (Compose has no cheap backdrop filter). surfaceContainer
                        // is the accent-derived translucent-black ramp from
                        // TinyAccentTheme, so a custom-bg tiny stays on-palette.
                        // r22 = the shared composer corner token (web
                        // rounded-[22px] Chat.tsx:2533, iOS RoundedRectangle
                        // cornerRadius 22 Views.swift:2240) — the documented radius
                        // scale is cards 14 / bubbles 18 / composer 22. Android sat at
                        // 20, a 2dp drift from the signature; matched to 22.
                        .background(
                            MaterialTheme.colorScheme.surfaceContainer.copy(alpha = 0.85f),
                            shape = RoundedCornerShape(22.dp),
                        )
                        .border(
                            width = 1.dp,
                            color = accent.copy(alpha = borderAlpha),
                            shape = RoundedCornerShape(22.dp),
                        ),
                ) {
                    val sendComposer = {
                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                        // 📞 In-call composer routing (inline-chat design): a TYPED
                        // message joins the live call — the tiny hears it and answers
                        // in voice; the reply lands in this thread via the transcript
                        // hooks. Attachments can't ride a realtime session, so they
                        // take the normal chat turn (iOS send() parity).
                        if (callPhase == technology.tiny.app.voice.VoiceCall.Phase.LIVE &&
                            input.isNotBlank() &&
                            vm.pendingImages.isEmpty() && vm.pendingDocs.isEmpty()
                        ) {
                            val spoken = input.trim()
                            vm.voiceUserSaid(spoken)
                            liveCall.sendUserText(spoken)
                            input = ""
                        } else {
                            vm.send(input); input = ""
                        }
                    }
                    // Multi-select up to the cap (web's file input is `multiple`,
                    // Chat.tsx:2507 + iOS PhotosPickerItem[] 3007c83) — one picker
                    // trip could attach several photos; the single-item
                    // PickVisualMedia meant reopening it once per photo. maxItems is
                    // the total cap (contract requires ≥2); the callback still counts
                    // free slots so a pick that would overshoot the current pending
                    // set is trimmed with the same message the doc path shows.
                    val imagePicker = androidx.activity.compose.rememberLauncherForActivityResult(
                        androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(
                            technology.tiny.app.chat.Attachments.MAX
                        )
                    ) { uris ->
                        if (uris.isEmpty()) return@rememberLauncherForActivityResult
                        // The picker's cap is the TOTAL, blind to what's already pending,
                        // so a pick can overshoot the free slots. clampPicks (pure, tested)
                        // computes how many fit + whether any overflowed.
                        val clamp = technology.tiny.app.chat.Attachments.clampPicks(
                            pendingCount = vm.pendingImages.size + vm.pendingDocs.size,
                            pickedCount = uris.size,
                        )
                        if (clamp.overflowed) {
                            vm.error = "up to ${technology.tiny.app.chat.Attachments.MAX} attachments per message"
                        }
                        if (clamp.full) return@rememberLauncherForActivityResult
                        // Tactile confirm on attach — matches the drop path (1374)
                        // and iOS's every-attach-path haptic (9a6d1f9). The primary
                        // "+" menu paths (library/camera/doc) + paste were silent, so
                        // a dropped photo felt better than a picked one. One buzz per
                        // pick, at the accept point (drop's own semantics).
                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                        for (uri in uris.take(clamp.accept)) {
                            scope.launch {
                                // Off the main thread: encode() decodes + rescales the full
                                // photo (a 50MP shot janks or ANRs the UI thread).
                                val b64 = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                    technology.tiny.app.chat.Attachments.encode(context, uri)
                                }
                                // A failed read must SAY so — encode() returning null used to
                                // drop the pick silently (the doc path always surfaces errors).
                                if (b64 != null) vm.addPendingImage(b64)
                                else vm.error = "couldn't read that image — try another"
                            }
                        }
                    }
                    val docPicker = androidx.activity.compose.rememberLauncherForActivityResult(
                        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
                    ) { uri ->
                        if (uri == null) return@rememberLauncherForActivityResult
                        if (vm.pendingImages.size + vm.pendingDocs.size >= technology.tiny.app.chat.Attachments.MAX) {
                            vm.error = "up to ${technology.tiny.app.chat.Attachments.MAX} attachments per message"
                            return@rememberLauncherForActivityResult
                        }
                        when (val r = technology.tiny.app.chat.Attachments.encodeDocument(context, uri)) {
                            is technology.tiny.app.chat.Attachments.DocResult.Ok -> {
                                if (vm.addPendingDoc(r.doc)) {
                                    haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                                }
                            }
                            is technology.tiny.app.chat.Attachments.DocResult.Err -> vm.error = r.message
                        }
                    }
                    // 📷 Camera capture → FileProvider uri → same encode path as a
                    // picked photo. The pending uri is held in a remembered box so
                    // the TakePicture result callback can read it back.
                    val cameraUri = remember { androidx.compose.runtime.mutableStateOf<Uri?>(null) }
                    val cameraCapture = androidx.activity.compose.rememberLauncherForActivityResult(
                        androidx.activity.result.contract.ActivityResultContracts.TakePicture()
                    ) { ok ->
                        val uri = cameraUri.value
                        cameraUri.value = null
                        if (!ok || uri == null) return@rememberLauncherForActivityResult
                        if (vm.pendingImages.size + vm.pendingDocs.size >= technology.tiny.app.chat.Attachments.MAX) {
                            vm.error = "up to ${technology.tiny.app.chat.Attachments.MAX} attachments per message"
                            return@rememberLauncherForActivityResult
                        }
                        scope.launch {
                            val b64 = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                technology.tiny.app.chat.Attachments.encode(context, uri)
                            }
                            if (b64 != null) {
                                if (vm.addPendingImage(b64)) {
                                    haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                                }
                            } else vm.error = "couldn't read that photo — try again"
                        }
                    }
                    val atCap = vm.pendingImages.size + vm.pendingDocs.size >= technology.tiny.app.chat.Attachments.MAX
                    // Camera-less device (some tablets, emulators, locked-down
                    // enterprise hardware) — iOS hides both camera affordances behind
                    // UIImagePickerController.isSourceTypeAvailable(.camera)
                    // (Views.swift:2394/2422), but Android showed the "Take Photo"
                    // menu item + quick-camera button unconditionally. TakePicture()
                    // then resolves to no activity → ActivityNotFoundException or a
                    // silent dead-end. Gate both on FEATURE_CAMERA_ANY (any lens,
                    // matching the "can this device take a photo at all" question iOS
                    // asks) so a camera-less device just doesn't offer them.
                    val hasCamera = remember {
                        context.packageManager.hasSystemFeature(
                            android.content.pm.PackageManager.FEATURE_CAMERA_ANY
                        )
                    }
                    // Voice-input-less device — the right-slot mic morph opens an
                    // on-device speech session (VoiceMode.start → SpeechRecognizer,
                    // VoiceMode.kt:81), so on a device with no recognizer (some
                    // tablets, AOSP/emulator builds without the Google app,
                    // Chromebooks) tapping it just dead-ends into a "Voice input
                    // isn't available" error AFTER a RECORD_AUDIO prompt. Web hides
                    // the mic entirely up front when voice is unsupported
                    // (`canVoice && …`, Chat.tsx:2681); this is the same gate — and
                    // the exact parallel to hasCamera above. (iOS's mic uses the
                    // always-available S2S relay, so it has no dead-affordance to
                    // gate.) The 📞 inline-call button is separate and stays.
                    val hasVoiceInput = remember {
                        android.speech.SpeechRecognizer.isRecognitionAvailable(context)
                    }
                    // Launches the camera into a fresh cache file exposed via FileProvider.
                    val launchCamera = launchCamera@{
                        if (atCap) {
                            vm.error = "up to ${technology.tiny.app.chat.Attachments.MAX} attachments per message"
                            return@launchCamera
                        }
                        val dir = java.io.File(context.cacheDir, "camera").apply { mkdirs() }
                        val file = java.io.File.createTempFile("cap", ".jpg", dir)
                        val uri = androidx.core.content.FileProvider.getUriForFile(
                            context, "${technology.tiny.app.BuildConfig.APPLICATION_ID}.files", file,
                        )
                        cameraUri.value = uri
                        cameraCapture.launch(uri)
                    }
                    val micPermission = androidx.activity.compose.rememberLauncherForActivityResult(
                        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
                    ) { granted ->
                        // A denied mic used to no-op silently — the voice strip is
                        // gated on LISTENING/HEARING, so nothing appeared and the tap
                        // was a dead-end. Surface it (web toasts on voice failure,
                        // Chat.tsx:2059; iOS banner parity, 98c3d92). vm.error is the
                        // transient composer channel attachment errors use.
                        if (granted) vm.voice.start()
                        else vm.error = "Microphone access is off — enable it in Settings to use voice"
                    }
                    // 📞 Voice-call mic gate — granted starts the inline call.
                    val callPermission = androidx.activity.compose.rememberLauncherForActivityResult(
                        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
                    ) { granted -> if (granted) startInlineCall() }

                    val attachMenu = remember { androidx.compose.runtime.mutableStateOf(false) }
                    // Web parity: the composer never blocks on a live stream — a
                    // non-empty composer (text or attachments) always sends as a new
                    // concurrent turn; only an EMPTY composer with ≥1 live stream
                    // makes Enter / the button act as Stop-all.
                    val composerFilled = input.isNotBlank() ||
                        vm.pendingImages.isNotEmpty() || vm.pendingDocs.isNotEmpty()
                    // 📎 Drop hint — a discoverable "Drop to share" affordance while a
                    // drag hovers the composer (web full-screen "Drop files to share
                    // with {name}" overlay / iOS dashed veil + capsule, Views.swift:1988).
                    // Android previously only brightened the border (borderAlpha 0.7,
                    // cycle 24) — no words, so it wasn't obvious the drop would land.
                    // A dashed-outline labeled row at the top of the box now matches.
                    androidx.compose.animation.AnimatedVisibility(visible = dragTargeted.value) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 10.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .border(
                                    width = 2.dp,
                                    brush = androidx.compose.ui.graphics.SolidColor(accent.copy(alpha = 0.6f)),
                                    shape = RoundedCornerShape(12.dp),
                                )
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Filled.AttachFile,
                                contentDescription = null,
                                tint = accent,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "Drop to share with ${vm.tiny}",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                                color = accent,
                            )
                        }
                    }
                    // Pre-send preview strip INSIDE the box, above the field (web
                    // Chat.tsx:2283 + iOS 574eb95): thumbnails + doc chips, each with
                    // its own ✕ remove, read as attached to THIS message rather than a
                    // detached row floating above the composer card.
                    if (vm.pendingImages.isNotEmpty() || vm.pendingDocs.isNotEmpty()) {
                        technology.tiny.app.ui.PendingStrip(
                            images = vm.pendingImages.toList(),
                            docs = vm.pendingDocs.toList(),
                            onRemoveImage = { idx -> vm.pendingImages.removeAt(idx) },
                            onRemoveDoc = { idx -> vm.pendingDocs.removeAt(idx) },
                        )
                    }
                    // ── Borderless text field, full width, on top (web textarea) ──
                    // BasicTextField (not Material3 TextField): the filled TextField
                    // reserves its own decoration-box content area that composited
                    // DARKER than the surrounding composer, so the text-entry region
                    // read as a hard-edged black box inset from the composer edges —
                    // "the black bg doesn't cover the full textarea" (user-reported).
                    // iOS fills the WHOLE composerBox with .ultraThinMaterial and lays
                    // a transparent TextField on top (Views.swift:2314); BasicTextField
                    // with a bare decorationBox does the same — the composer Column's
                    // one translucent fill is now the field's only surface, edge to edge.
                    androidx.compose.foundation.text.BasicTextField(
                        value = input,
                        onValueChange = { input = it; paletteIndex = 0; paletteDismissed = false },
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(accent),
                        decorationBox = { inner ->
                            Box(
                                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                                contentAlignment = Alignment.CenterStart,
                            ) {
                                if (input.isEmpty()) {
                                    Text(
                                        if (voiceActive) "Voice mode — speak; typing still works"
                                        else "Message ${vm.tiny}…",
                                        style = androidx.compose.material3.LocalTextStyle.current.copy(
                                            fontSize = 17.sp,
                                        ),
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                inner()
                            }
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(inputFocus)
                            .onFocusChanged { inputFocused.value = it.isFocused }
                            // Hardware-keyboard palette nav (web CommandPalette.tsx parity):
                            // Arrow keys move the clamped selection, Enter runs the
                            // highlighted command. Only intercept while the palette is open;
                            // otherwise keys pass through to normal text editing.
                            .onPreviewKeyEvent { e ->
                                if (e.type != androidx.compose.ui.input.key.KeyEventType.KeyDown) {
                                    return@onPreviewKeyEvent false
                                }
                                // ⎋ Escape: dismiss an open palette FIRST so "/c" can be
                                // sent literally (web CommandPalette.tsx:294 + iOS 7ffff0a),
                                // THEN exit dictation voice mode (web Chat.tsx:2459 + iOS
                                // abeab5c — "the mic shouldn't be the only way out"), else
                                // pass through so Escape keeps normal behavior when idle.
                                if (e.key == androidx.compose.ui.input.key.Key.Escape) {
                                    return@onPreviewKeyEvent when {
                                        paletteMatches.isNotEmpty() -> { paletteDismissed = true; true }
                                        voiceActive -> { vm.voice.stop(); true }
                                        else -> false
                                    }
                                }
                                val isEnter = e.key == androidx.compose.ui.input.key.Key.Enter ||
                                    e.key == androidx.compose.ui.input.key.Key.NumPadEnter
                                // Hardware/Bluetooth-keyboard send: Enter (no Shift) submits,
                                // Shift+Enter falls through to insert a newline — web parity
                                // (Chat.tsx:2288 "Enter && !shiftKey"). Only when the palette is
                                // closed; an open palette keeps Enter = run highlighted command.
                                if (paletteMatches.isEmpty()) {
                                    return@onPreviewKeyEvent if (isEnter && !e.nativeKeyEvent.isShiftPressed) {
                                        if (composerFilled) sendComposer()
                                        else if (vm.busy) vm.stopAll()
                                        true
                                    } else false
                                }
                                when (e.key) {
                                    androidx.compose.ui.input.key.Key.DirectionDown -> {
                                        paletteIndex = (paletteIndex + 1).coerceAtMost(paletteMatches.size - 1); true
                                    }
                                    androidx.compose.ui.input.key.Key.DirectionUp -> {
                                        paletteIndex = (paletteIndex - 1).coerceAtLeast(0); true
                                    }
                                    androidx.compose.ui.input.key.Key.Enter,
                                    androidx.compose.ui.input.key.Key.NumPadEnter -> {
                                        paletteMatches.getOrNull(paletteIndex.coerceIn(0, paletteMatches.size - 1))
                                            ?.let { pickCommand(it) }; true
                                    }
                                    else -> false
                                }
                            },
                        // State-aware placeholder (web Chat.tsx:2445 + iOS aed1b4e):
                        // voice mode names the dictation affordance, otherwise it
                        // greets the tiny by name — a static hint lost both cues. Now
                        // drawn inside decorationBox above (BasicTextField has no
                        // placeholder slot). (Web's private-locked case shows a lock
                        // panel here instead of the composer, same as iOS/Android.)
                        // One row at rest, grows to five: the compact WhatsApp-style
                        // single row the design targets, matching the reference (web
                        // textarea rows=1 / minHeight 56px, Chat.tsx:2752) and iOS
                        // (lineLimit(1...5), Views.swift:2577). Was minLines=2, which
                        // left Android's empty composer a two-line box while both other
                        // clients showed a clean single line — the field owns the full
                        // width (icons live on the toolbar row below), so one line reads
                        // clean and roomy without reserving the extra height.
                        minLines = 1,
                        maxLines = 5,
                        // Sentence-case autocapitalization (web <textarea> gets
                        // autocapitalize="sentences" from mobile browsers, iOS TextField
                        // defaults to .sentences) — Compose's TextField defaults to
                        // None, so the Android composer alone left "hello. how are you"
                        // lowercase while the other two clients capitalized. Match them.
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences,
                        ),
                        // Content-driven text direction (web textarea dir="auto",
                        // Chat.tsx:2439): resolve LTR/RTL from the first strong
                        // directional character so an Arabic/Hebrew/Persian draft
                        // right-aligns as you type. Merges onto the Material default
                        // style.
                        // fontSize 17sp — the composer field is a documented text
                        // token: web is `text-[17px]` (Chat.tsx:2739) and iOS's
                        // TextField uses the default `.body` (17pt), but Compose's
                        // TextField inherits `bodyLarge` = 16sp, so the Android
                        // draft typed 1sp smaller than both references on the very
                        // surface this loop tunes. Bump to 17 so the typed text
                        // matches across all three clients.
                        // color must be explicit: BasicTextField has no Material
                        // color wiring, so an unset color would default to black on
                        // the dark composer. onSurface matches the Material TextField.
                        textStyle = androidx.compose.material3.LocalTextStyle.current.copy(
                            color = MaterialTheme.colorScheme.onSurface,
                            textDirection = androidx.compose.ui.text.style.TextDirection.Content,
                            fontSize = 17.sp,
                        ),
                    )
                    // ── Toolbar row INSIDE the border: "+" attach left, camera/voice +
                    // morphing send/stop/mic right (web Chat.tsx:2352 toolbar) ──
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // ➕ Single attach entry point → menu over library/camera/document.
                        Box {
                            IconButton(onClick = { attachMenu.value = true }, enabled = !atCap) {
                                Icon(
                                    Icons.Filled.Add,
                                    contentDescription = "attach",
                                    tint = if (atCap) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            DropdownMenu(expanded = attachMenu.value, onDismissRequest = { attachMenu.value = false }) {
                                DropdownMenuItem(
                                    text = { Text("Photo Library") },
                                    leadingIcon = { Icon(Icons.Filled.PhotoLibrary, contentDescription = null) },
                                    onClick = {
                                        attachMenu.value = false
                                        imagePicker.launch(
                                            androidx.activity.result.PickVisualMediaRequest(
                                                androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly
                                            )
                                        )
                                    },
                                )
                                if (hasCamera) {
                                    DropdownMenuItem(
                                        text = { Text("Take Photo") },
                                        leadingIcon = { Icon(Icons.Filled.PhotoCamera, contentDescription = null) },
                                        onClick = { attachMenu.value = false; launchCamera() },
                                    )
                                }
                                DropdownMenuItem(
                                    // "(PDF, CSV…)" names the accepted types up front
                                    // so the picker isn't a mystery before it opens —
                                    // iOS parity (Views.swift:2397 "Document (PDF, CSV…)").
                                    text = { Text("Document (PDF, CSV…)") },
                                    leadingIcon = { Icon(Icons.Filled.InsertDriveFile, contentDescription = null) },
                                    onClick = {
                                        attachMenu.value = false
                                        docPicker.launch(technology.tiny.app.chat.Attachments.DOC_MIME_TYPES)
                                    },
                                )
                                // 📋 Paste Image — a copied screenshot/photo reaches the
                                // composer (web Chat.tsx:2453 onPaste + iOS cycle-12). Shown
                                // only when the clipboard actually holds an image so it never
                                // dead-ends; routes through the same encode + MAX cap as the
                                // picker (clipboard images arrive as a ClipData item URI).
                                val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                if (clipboard.primaryClipDescription?.hasMimeType("image/*") == true) {
                                    DropdownMenuItem(
                                        text = { Text("Paste Image") },
                                        leadingIcon = { Icon(Icons.Filled.ContentPaste, contentDescription = null) },
                                        onClick = {
                                            attachMenu.value = false
                                            val uri = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
                                            if (uri == null) {
                                                vm.error = "couldn't read the pasted image"
                                                return@DropdownMenuItem
                                            }
                                            if (vm.pendingImages.size + vm.pendingDocs.size >= technology.tiny.app.chat.Attachments.MAX) {
                                                vm.error = "up to ${technology.tiny.app.chat.Attachments.MAX} attachments per message"
                                                return@DropdownMenuItem
                                            }
                                            scope.launch {
                                                val b64 = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                                    technology.tiny.app.chat.Attachments.encode(context, uri)
                                                }
                                                if (b64 != null) {
                                                    if (vm.addPendingImage(b64)) {
                                                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                                                    }
                                                } else vm.error = "couldn't read the pasted image — try another"
                                            }
                                        },
                                    )
                                }
                            }
                        }
                        Spacer(Modifier.weight(1f))
                        // 📷 Quick camera + 📞 voice call — shown only while the composer
                        // is empty and nothing streams; typing collapses them so the send
                        // action owns the trailing slot and the toolbar stays uncluttered.
                        androidx.compose.animation.AnimatedVisibility(
                            visible = !composerFilled && !vm.busy,
                            enter = androidx.compose.animation.expandHorizontally() + androidx.compose.animation.fadeIn(),
                            exit = androidx.compose.animation.shrinkHorizontally() + androidx.compose.animation.fadeOut(),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (hasCamera) {
                                    IconButton(onClick = { launchCamera() }, enabled = !atCap) {
                                        Icon(
                                            Icons.Filled.PhotoCamera,
                                            contentDescription = "take photo",
                                            tint = if (atCap) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                                            else MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                                // 📞 Voice call — real speech-to-speech, inline in this chat.
                                IconButton(onClick = {
                                    if (androidx.core.content.ContextCompat.checkSelfPermission(
                                            app, android.Manifest.permission.RECORD_AUDIO,
                                        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                                    ) startInlineCall()
                                    else callPermission.launch(android.Manifest.permission.RECORD_AUDIO)
                                }) {
                                    Icon(
                                        Icons.Filled.Call,
                                        contentDescription = "voice call",
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                        // 🪙 Draft token estimate (~4 chars/token) — a quiet cost
                        // cue right before Send, shown only while there's a draft
                        // (web Chat.tsx:2415 `~{ceil(len/4)} tok`; iOS composerToolbar
                        // 5cf58c0). Both other clients now surface it, so Android
                        // matches; ceil so a 1-char draft still reads "~1 tok".
                        // 💵 Paid-tiny price badge — web (Chat.tsx:2703) and iOS
                        // (composerToolbar, Views.swift:2428) both sit it INSIDE the
                        // composer toolbar right before the token estimate + Send, so
                        // the per-message cost is visible at the moment you commit to a
                        // send. It lived up in the title bar here — a real drift from
                        // both references; moved down to match. Same gate
                        // (shouldShowPriceBadge: paid, not private-locked) and tap →
                        // wallet as before.
                        vm.priceMicro?.takeIf {
                            technology.tiny.app.chat.shouldShowPriceBadge(it, vm.isPrivate, vm.isAuthorized)
                        }?.let { micro ->
                            Surface(
                                onClick = { vm.openPanel = "wallet" },
                                shape = RoundedCornerShape(8.dp),
                                color = accent.copy(alpha = 0.12f),
                                modifier = Modifier.padding(end = 6.dp),
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                ) {
                                    Icon(Icons.Outlined.Payments, contentDescription = null, tint = accent, modifier = Modifier.size(12.dp))
                                    Spacer(Modifier.width(4.dp))
                                    Text(
                                        "${technology.tiny.app.wallet.WalletCore.priceLabel(micro)}/msg",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = accent,
                                    )
                                }
                            }
                        }
                        // isNotBlank (not isNotEmpty) so a whitespace-only draft shows no
                        // badge — web gates on input.trim().length (Chat.tsx:2704), iOS on
                        // !draftEmpty (trimmed), and the mic→send morph above already uses
                        // isNotBlank, so a spaces-only draft used to keep the Mic glyph
                        // while the badge still claimed "~1 tok". The count itself stays on
                        // raw length (web/iOS both count untrimmed) — only the gate trims.
                        if (input.isNotBlank()) {
                            Text(
                                "~${((input.length + 3) / 4).coerceAtLeast(1)} tok",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                                modifier = Modifier.padding(end = 4.dp),
                            )
                        }
                        // Single morphing right action: Send (composer filled) → Stop
                        // (empty + streaming) → Mic (empty + idle). Web parity: Send
                        // always wins over a live stream so concurrent turns fire.
                        // "none" when the composer is empty+idle on a device with no
                        // speech recognizer — web renders no mic at all there
                        // (`canVoice && …`), so the slot collapses rather than
                        // offering a mic that dead-ends into "Voice input isn't
                        // available" (hasVoiceInput, mirroring hasCamera).
                        val rightAction = when {
                            composerFilled -> "send"
                            vm.busy -> "stop"
                            hasVoiceInput -> "mic"
                            else -> "none"
                        }
                        androidx.compose.animation.AnimatedContent(
                            targetState = rightAction,
                            transitionSpec = {
                                if (animationsOff) {
                                    (androidx.compose.animation.fadeIn(androidx.compose.animation.core.snap()))
                                        .togetherWith(androidx.compose.animation.fadeOut(androidx.compose.animation.core.snap()))
                                } else {
                                    (androidx.compose.animation.scaleIn(initialScale = 0.7f) + androidx.compose.animation.fadeIn())
                                        .togetherWith(androidx.compose.animation.scaleOut(targetScale = 0.7f) + androidx.compose.animation.fadeOut())
                                }
                            },
                            label = "composer-right-action",
                        ) { action ->
                            when (action) {
                                "send" -> FilledIconButton(
                                    onClick = { sendComposer() },
                                    // Accent glow on the ready-to-send button (web
                                    // parity: box-shadow 0 0 14px accent@0.25).
                                    modifier = Modifier.shadow(
                                        elevation = 8.dp,
                                        shape = androidx.compose.foundation.shape.CircleShape,
                                        ambientColor = accent,
                                        spotColor = accent,
                                    ),
                                ) {
                                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "send")
                                }
                                "stop" -> FilledIconButton(
                                    onClick = { vm.stopAll() },
                                    colors = IconButtonDefaults.filledIconButtonColors(
                                        containerColor = MaterialTheme.colorScheme.errorContainer,
                                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                                    ),
                                ) {
                                    Icon(Icons.Filled.Stop, contentDescription = "stop")
                                }
                                "mic" -> IconButton(
                                    onClick = {
                                        // Toggling voice mode is a mode switch with no send
                                        // glyph to confirm it — a firm LongPress tick (matching
                                        // the attach acks) marks "mic engaged". The mic was the
                                        // ONE composer control with no haptic (iOS .rigid parity).
                                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                                        if (voiceActive) vm.voice.stop()
                                        else micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
                                    },
                                    // Toggle state for TalkBack (web aria-pressed, Chat.tsx:2675;
                                    // iOS .isSelected) — "voice mode is ON" was conveyed only
                                    // visually (accent tint + pulse); `selected` makes TalkBack
                                    // announce the persistent on/off, not just the next action.
                                    modifier = Modifier.semantics { selected = voiceActive },
                                ) {
                                    // 🎙️ Live-mic pulse: while voice mode is listening the
                                    // mic breathes (web Chat.tsx:2389 `animate-pulse` + iOS
                                    // .symbolEffect(.pulse) 2342). Held static when the
                                    // system animator scale is 0 (reduce-motion parity).
                                    val micPulse by androidx.compose.animation.core.rememberInfiniteTransition(label = "mic-pulse")
                                        .animateFloat(
                                            initialValue = 1f,
                                            targetValue = 1.18f,
                                            animationSpec = androidx.compose.animation.core.infiniteRepeatable(
                                                animation = androidx.compose.animation.core.tween(
                                                    700, easing = androidx.compose.animation.core.EaseInOutSine,
                                                ),
                                                repeatMode = androidx.compose.animation.core.RepeatMode.Reverse,
                                            ),
                                            label = "mic-pulse-scale",
                                        )
                                    val micScale = if (voiceActive && !animationsOff) micPulse else 1f
                                    Icon(
                                        Icons.Filled.Mic,
                                        contentDescription = if (voiceActive) "stop voice" else "voice mode",
                                        tint = if (voiceActive) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.graphicsLayer { scaleX = micScale; scaleY = micScale },
                                    )
                                }
                                // "none": empty+idle on a no-recognizer device — no
                                // trailing action at all (web renders no mic). A zero
                                // Spacer keeps AnimatedContent happy without reserving
                                // the 48dp slot, so the field runs cleanly to the edge.
                                else -> Spacer(Modifier.size(0.dp))
                            }
                        }
                    }
                }
                } // end else (composer shown when not a locked private tiny)
            }
        },
    ) { padding ->
        // iOS visibleMessages parity: trim query, empty → all; else case-insensitive
        // substring filter over message text only.
        val q = searchQuery.trim()
        val visible = if (!searching || q.isEmpty()) vm.messages.toList()
            else vm.messages.filter { it.text.contains(q, ignoreCase = true) }
        if (searching && q.isNotEmpty() && visible.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(
                    "No messages match \"$q\".",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Box(Modifier.fillMaxSize().padding(padding)) {
                // 🖼️ Per-tiny hero banner (web Chat.tsx:1974-1980, 2464): owner-set
                // https image behind the turn-zero landing ONLY — gone the moment the
                // conversation starts. Cover-cropped, anchored top-center, under the
                // web's darkening gradient (black 45% at top → black 70% at 55% →
                // page background fully by 96%). Broken/404/hotlink-blocked images
                // degrade silently — AsyncImage draws nothing on error.
                if (vm.messages.isEmpty() && vm.heroUrl != null) {
                    coil.compose.AsyncImage(
                        model = vm.heroUrl,
                        contentDescription = null,
                        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                        alignment = Alignment.TopCenter,
                        modifier = Modifier.matchParentSize(),
                    )
                    val bg = MaterialTheme.colorScheme.background
                    // Wash direction follows the theme: black veils on dark pages
                    // (web's exact gradient), white veils on light theme.bg pages —
                    // a black wash over a light page read as a moody hole and sank
                    // the tagline's dark text into it (seen on hashtagrobotics).
                    val veil = if (bg.luminance() > 0.5f) androidx.compose.ui.graphics.Color.White
                        else androidx.compose.ui.graphics.Color.Black
                    Box(
                        Modifier.matchParentSize().background(
                            androidx.compose.ui.graphics.Brush.verticalGradient(
                                0f to veil.copy(alpha = 0.45f),
                                0.55f to veil.copy(alpha = 0.7f),
                                0.96f to bg,
                                1f to bg,
                            ),
                        ),
                    )
                }
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(visible, key = { it.id }) { m ->
                        MessageBubble(
                            m = m,
                            onEditResend = { vm.editResend(m.id)?.let { input = it } },
                            onDelete = { vm.deleteMessage(m.id) },
                            onRetry = { vm.retry(m) },
                            onStop = { vm.stop(m.id) },
                            onAddFunds = {
                                // Arm auto-continue only when this is a paywall card's Add
                                // funds (a paywall message shows no pay_x402 card, so no
                                // misfire); the composer wallet button leaves it null.
                                if (m.paywall != null) vm.paywallAwaitingFunds = m
                                vm.openPanel = "wallet"
                            },
                            onPaywallRetry = { vm.retryPaywall(m) },
                            onSignIn = onSignIn,
                            onSettlePay = { id, s -> vm.settlePayCard(id, s) },
                        )
                    }
                }
                // 🌅 Turn-zero landing (web Chat.tsx:2464-2501 heroMode parity):
                // big accent tiny name with a soft glow, the web's exact tagline,
                // and starter chips — centered over the banner/gradient (or the
                // plain background when no hero is set). Drawn AFTER the LazyColumn
                // so the chips take the taps; gone the moment the first message
                // lands — same branch as the banner. Web's textShadow
                // `0 0 24px rgba(accent,.45)` maps to a Compose text Shadow with
                // matching blur/alpha (offset 0,0) — cheap, no extra draw pass.
                if (vm.messages.isEmpty()) {
                    Column(
                        Modifier.fillMaxSize().padding(horizontal = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        // 🪪 Per-tiny landing logo — owner-set media centered above the
                        // name: image/GIF via Coil (GIF animates through ImageDecoder,
                        // API 28+, coil-gif artifact), .mp4/.webm via a muted looping
                        // VideoView (no ExoPlayer dep). Any failure is silent — the
                        // media (and its spacer) just never renders. NOTE: the app has
                        // no reduce-motion convention yet; animated logos always play.
                        val logo = vm.logoUrl
                        var logoFailed by remember(logo) { mutableStateOf(false) }
                        if (logo != null && !logoFailed) {
                            val logoShape = RoundedCornerShape(20.dp)
                            if (technology.tiny.app.chat.isVideoLogo(logo)) {
                                androidx.compose.ui.viewinterop.AndroidView(
                                    factory = { ctx ->
                                        android.widget.VideoView(ctx).apply {
                                            setOnPreparedListener { mp ->
                                                mp.isLooping = true
                                                mp.setVolume(0f, 0f) // intro media never makes sound
                                            }
                                            // Return true = handled: suppress the stock
                                            // "Can't play this video" dialog, hide the view.
                                            setOnErrorListener { _, _, _ -> logoFailed = true; true }
                                            setVideoURI(Uri.parse(logo))
                                            start()
                                        }
                                    },
                                    modifier = Modifier.size(96.dp).clip(logoShape),
                                )
                            } else {
                                val ctx = androidx.compose.ui.platform.LocalContext.current
                                // GIFs need the coil-gif decoder to animate; SVGs need
                                // coil-svg (worker allows svg logos; the default bitmap
                                // decoders error → the logo silently hid); plain images
                                // keep the app-wide singleton loader (shared caches).
                                val loader = remember(logo) {
                                    when {
                                        technology.tiny.app.chat.isGifLogo(logo) ->
                                            coil.ImageLoader.Builder(ctx)
                                                .components { add(coil.decode.ImageDecoderDecoder.Factory()) }
                                                .build()
                                        technology.tiny.app.chat.isSvgLogo(logo) ->
                                            coil.ImageLoader.Builder(ctx)
                                                .components { add(coil.decode.SvgDecoder.Factory()) }
                                                .build()
                                        else -> coil.Coil.imageLoader(ctx)
                                    }
                                }
                                coil.compose.AsyncImage(
                                    model = logo,
                                    imageLoader = loader,
                                    // Identity, not decoration — TalkBack should say
                                    // whose landing this is (hero banner stays null).
                                    contentDescription = "${vm.tiny} logo",
                                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                    onError = { logoFailed = true },
                                    modifier = Modifier.size(96.dp).clip(logoShape),
                                )
                            }
                            Spacer(Modifier.height(16.dp))
                        }
                        Text(
                            vm.tiny.lowercase(),
                            // displaySmall = the landing-hero style (40sp bold sans —
                            // web text-4xl bold / iOS 40pt bold, neither is mono here).
                            style = MaterialTheme.typography.displaySmall.copy(
                                shadow = androidx.compose.ui.graphics.Shadow(
                                    color = accent.copy(alpha = 0.45f),
                                    blurRadius = 24f,
                                ),
                            ),
                            color = accent,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(12.dp))
                        Text(
                            vm.customTagline ?: technology.tiny.app.chat.landingTagline(vm.tiny),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(24.dp))
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        ) {
                            // Owner-set custom chips replace the defaults wholesale
                            // (validated 1-4 × ≤60 chars, else null → defaults).
                            // Same tap semantics either way.
                            val animationsOff = technology.tiny.app.ui.rememberAnimationsOff()
                            (vm.customChips ?: technology.tiny.app.chat.landingChips(vm.tiny)).forEachIndexed { i, chip ->
                                // Staggered entrance (60ms/chip fade+rise) — the
                                // landing's one moment of motion; instant when
                                // animations are off or on re-landing (keyed per
                                // tiny so a mid-session return doesn't replay).
                                var shown by remember(vm.tiny) { mutableStateOf(animationsOff) }
                                LaunchedEffect(vm.tiny) {
                                    kotlinx.coroutines.delay(60L * i)
                                    shown = true
                                }
                                androidx.compose.animation.AnimatedVisibility(
                                    visible = shown,
                                    enter = androidx.compose.animation.fadeIn(
                                        androidx.compose.animation.core.tween(220),
                                    ) + androidx.compose.animation.slideInVertically(
                                        animationSpec = androidx.compose.animation.core.tween(220),
                                        initialOffsetY = { it / 3 },
                                    ),
                                ) {
                                    technology.tiny.app.ui.TinyChip(
                                        chip,
                                        // Web: a "…" chip prefills the composer (ellipsis
                                        // stripped); the rest send immediately.
                                        onClick = {
                                            if (chip.endsWith("…")) {
                                                input = chip.removeSuffix("…")
                                                // Focus + raise the keyboard so the seeded chip
                                                // is immediately editable — web focuses the input
                                                // (Chat.tsx:3019 inputRef.focus()) and iOS sets
                                                // focused=true (Views.swift:3259). Android only set
                                                // `input`, so a seeded chip dead-ended: the text
                                                // appeared but the caret/keyboard didn't, forcing
                                                // an extra tap into the field to keep typing.
                                                runCatching { inputFocus.requestFocus() }
                                            } else vm.send(chip)
                                        },
                                        accent = accent,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
        // Private-mode scrim — floats over the whole Scaffold; animates in/out
        // so entering a private room dims perceptibly. Draws nothing (and takes
        // no touches) for a public tiny.
        androidx.compose.animation.AnimatedVisibility(
            visible = vm.isPrivate,
            enter = androidx.compose.animation.fadeIn(),
            exit = androidx.compose.animation.fadeOut(),
            modifier = Modifier.matchParentSize(),
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.22f)),
            )
        }
    } // private-mode Box
    } // TinyAccentTheme
}

/**
 * Slash-command palette (web CommandPalette.tsx parity). Renders above the composer
 * when the input is a bare "/query"; each row shows /name + description. Tapping runs
 * the command immediately (or prefills an arg-taking one — handled by the caller).
 */
@Composable
fun CommandPalette(
    commands: List<technology.tiny.app.chat.SlashCommand>,
    selectedIndex: Int = 0,
    onPick: (technology.tiny.app.chat.SlashCommand) -> Unit,
) {
    val paletteList = rememberLazyListState()
    // Keep the keyboard-highlighted row on screen as the selection moves.
    LaunchedEffect(selectedIndex) {
        if (selectedIndex in commands.indices) paletteList.animateScrollToItem(selectedIndex)
    }
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 3.dp,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .heightIn(max = 260.dp),
    ) {
        LazyColumn(state = paletteList) {
            itemsIndexed(commands, key = { _, it -> it.name }) { i, cmd ->
                val highlighted = i == selectedIndex
                Surface(
                    onClick = { onPick(cmd) },
                    color = if (highlighted) MaterialTheme.colorScheme.surfaceVariant
                            else MaterialTheme.colorScheme.surface,
                    // TalkBack: merge the two texts into ONE node reading
                    // "/name, description" and mark the keyboard-highlighted row
                    // `selected` so the arrow-key move is announced (web
                    // aria-selected + aria-activedescendant, CommandPalette.tsx:341).
                    // Without this the highlight was visual-only and the two texts
                    // read as separate unlabeled nodes.
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics(mergeDescendants = true) {
                            contentDescription = "/${cmd.name}, ${cmd.description}"
                            selected = highlighted
                        },
                ) {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                        Text(
                            "/${cmd.name}",
                            style = MaterialTheme.typography.bodyMedium,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            cmd.description,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageBubble(
    m: ChatMessage,
    onEditResend: () -> Unit = {},
    onDelete: () -> Unit = {},
    onRetry: () -> Unit = {},
    onStop: () -> Unit = {},
    onAddFunds: () -> Unit = {},
    onPaywallRetry: () -> Unit = {},
    onSignIn: (() -> Unit)? = null,
    onSettlePay: (String, technology.tiny.app.wallet.WalletCore.PaySettled) -> Unit = { _, _ -> },
) {
    if (m.role == "note") {
        Text(
            m.text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )
        return
    }
    val isUser = m.role == "user"
    val context = androidx.compose.ui.platform.LocalContext.current
    val app = context.applicationContext as TinyApp
    val speakingId by app.speech.speakingId.collectAsState()
    // Long-press context menu (iOS Views.swift:1229 .contextMenu parity):
    // Copy / Edit & resend (user) / Share / Read aloud (assistant) / Delete.
    var menuOpen by remember { mutableStateOf(false) }
    // Delete drops the turn AND persists (saveHistory) — irreversible. Web confirms
    // it even from its own menu (confirm("Delete this message?"), Chat.tsx:1798) and
    // only soft-deletes; Android hard-removes, so a guard matters MORE here. Hold a
    // confirm flag rather than deleting on the menu tap.
    var confirmDelete by remember { mutableStateOf(false) }
    // Text-selection mode (iOS .textSelection(.enabled) parity). Compose can't run a
    // SelectionContainer and the bubble's long-press menu on the SAME gesture — the
    // container would swallow the long-press the tested Copy/Edit/Share/Delete menu
    // relies on. So selection is an explicit opt-in from that menu ("Select text");
    // while active the bubble text lives in a SelectionContainer and a tap exits.
    var selecting by remember { mutableStateOf(false) }
    val canMenu = m.text.isNotEmpty() && !m.streaming
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
        Box {
            // Web bubble parity (Chat.tsx:2877-2893): user = solid accent fill with
            // black text (the brand's signature move — the old surfaceVariant fill
            // was ~1% luminance over the black page, i.e. invisible); assistant =
            // dark surface inside an accent hairline. Content colors follow the
            // Surface fill automatically (onPrimary black / onSurface).
            Surface(
                color = if (isUser) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
                border = if (isUser) null else androidx.compose.foundation.BorderStroke(
                    1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.18f),
                ),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .combinedClickable(
                        // A tap while selecting exits selection mode (the handles/menu
                        // dismiss); otherwise the bubble is inert on tap, as before.
                        onClick = { if (selecting) selecting = false },
                        onLongClick = { if (canMenu) menuOpen = true },
                        // TalkBack announces the custom action ("double tap and hold
                        // to message options") — the long-press menu was invisible
                        // to screen readers before this.
                        onLongClickLabel = "message options",
                    ),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    if (m.reasoning.isNotEmpty()) ReasoningDisclosure(m.reasoning)
                    if (m.text.isNotEmpty()) {
                        // A plain user turn resolves reading direction from its own text
                        // (RTL for Arabic/Hebrew) — the composer already does (line ~1858);
                        // this carries it into the sent bubble. Assistant text bidi's per
                        // block inside MarkdownText.
                        val body = @Composable {
                            if (isUser) Text(m.text, style = MaterialTheme.typography.bodyLarge.bidi())
                            else technology.tiny.app.ui.MarkdownText(m.text)
                        }
                        // "Select text" from the menu wraps the body in a SelectionContainer
                        // (drag handles + native copy toolbar); otherwise render bare so the
                        // bubble's own long-press menu keeps the gesture.
                        if (selecting) {
                            androidx.compose.foundation.text.selection.SelectionContainer { body() }
                        } else {
                            body()
                        }
                    }
                    // Sent-attachment previews on a user turn (iOS thumbs/docs): a row of
                    // 96px image thumbnails + document-name chips, so what was attached stays
                    // visible in the transcript instead of collapsing to the text alone.
                    if (m.thumbs.isNotEmpty() || m.docNames.isNotEmpty()) {
                        technology.tiny.app.ui.SentAttachments(
                            thumbs = m.thumbs,
                            docNames = m.docNames,
                            topPad = m.text.isNotEmpty(),
                        )
                    }
                    // Tappable Spotify chips for any open.spotify.com links in the reply.
                    if (!isUser && m.text.isNotEmpty()) technology.tiny.app.ui.SpotifyChips(m.text)
                    m.uiCards.forEach { technology.tiny.app.ui.RenderUiCard(it.title, it.propsJson) }
                    m.spawns.forEach {
                        Spacer(Modifier.height(6.dp))
                        technology.tiny.app.ui.TaskTreeCard(it)
                    }
                    m.toolCalls.forEach {
                        Spacer(Modifier.height(6.dp))
                        // pay_x402 + make_payment spend the user's balance — show a
                        // plain receipt, not a buried JSON blob (web PayReceipt
                        // parity); everything else gets the generic expandable tool
                        // card. A settled outcome is persisted onto the message so it
                        // survives reload (C3). make_payment (P2P send) rides the same
                        // card: its url carries the transfer:@login sentinel, so the
                        // re-quote plumbing works unchanged.
                        if (it.name == "pay_x402" || it.name == "make_payment")
                            technology.tiny.app.ui.PayReceiptCard(it) { s -> onSettlePay(it.id, s) }
                        else technology.tiny.app.ui.ToolCallCard(it)
                    }
                    // On a COLD reload the toolCalls above are gone (MessageCodec drops
                    // them), so a payment the user already approved would vanish. Render
                    // its persisted receipt for any settled card not covered by a live
                    // toolCall (iOS PayQuoteItem.settled / web paySettled parity).
                    m.paySettled.forEach { (id, s) ->
                        if (m.toolCalls.none { it.id == id }) {
                            Spacer(Modifier.height(6.dp))
                            technology.tiny.app.ui.PaySettledReceiptCard(s)
                        }
                    }
                    m.speechText?.let { SpeechCard(messageId = m.id, text = it) }
                    // Fallback label only while a tool is mid-flight with no detail card yet.
                    if (m.toolLabel != null && m.toolCalls.none { it.name == m.toolLabel }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Build, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("${m.toolLabel}…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                    if (m.streaming && m.text.isEmpty() && m.toolLabel == null && m.toolCalls.isEmpty()) {
                        technology.tiny.app.ui.StreamingDots()
                    }
                    // Token usage tag (iOS Views.swift:1262 — assistant only, once counted).
                    // Appends a "~$" list-price estimate when the model is priced (web parity;
                    // iOS shows tokens only). Cached reads are discounted inside estimateCost.
                    if (!isUser && !m.streaming && (m.inTok + m.outTok) > 0) {
                        val cost = technology.tiny.app.chat.ModelPricing
                            .estimateCost(m.modelId, m.inTok, m.outTok, m.cacheReadTok)
                        Text(
                            "${m.inTok}→${m.outTok} tok" +
                                (cost?.let { " · ~${technology.tiny.app.chat.ModelPricing.formatCost(it)}" } ?: ""),
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                    // Live turn → per-bubble Stop (concurrent sends: stopping this
                    // reply leaves sibling streams running; matches the existing
                    // Android stop semantics — no stopped marker, flag just flips).
                    if (!isUser && m.streaming) {
                        TextButton(
                            onClick = onStop,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                            modifier = Modifier.padding(top = 4.dp),
                        ) {
                            Text(
                                "◼ stop",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    // 💸 Paywall (402) → actionable card (💳 Add funds + ↻ Retry),
                    // not a bare error + futile generic retry (web Chat.tsx paywall).
                    m.paywall?.let { pw ->
                        Spacer(Modifier.height(6.dp))
                        technology.tiny.app.ui.PaywallCard(
                            paywall = pw,
                            onAddFunds = onAddFunds,
                            onRetry = onPaywallRetry,
                            onSignIn = onSignIn,
                        )
                    }
                    // Failed turn → per-message Retry chip (iOS Views.swift:1295-1306).
                    if (m.failedPrompt != null && !m.streaming) {
                        TextButton(
                            onClick = onRetry,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                            modifier = Modifier.padding(top = 4.dp),
                        ) {
                            Icon(Icons.Outlined.Refresh, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("retry", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text("Copy") },
                    onClick = {
                        menuOpen = false
                        technology.tiny.app.chat.Sharing.copyToClipboard(context, "tiny message", m.text)
                    },
                )
                // Enter selection mode for partial copy / lookup (iOS textSelection parity).
                DropdownMenuItem(
                    text = { Text("Select text") },
                    onClick = { menuOpen = false; selecting = true },
                )
                if (isUser) {
                    DropdownMenuItem(
                        text = { Text("Edit & resend") },
                        onClick = { menuOpen = false; onEditResend() },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Share") },
                    onClick = {
                        menuOpen = false
                        technology.tiny.app.chat.Sharing.shareText(context, "tiny message", m.text)
                    },
                )
                if (!isUser) {
                    val playing = speakingId == m.id
                    DropdownMenuItem(
                        text = { Text(if (playing) "Stop" else "Read aloud") },
                        onClick = {
                            menuOpen = false
                            if (playing) app.speech.stop() else app.speech.speak(m.text, m.id)
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                    onClick = { menuOpen = false; confirmDelete = true },
                )
            }
            if (confirmDelete) {
                AlertDialog(
                    onDismissRequest = { confirmDelete = false },
                    title = { Text("Delete this message?") },
                    confirmButton = {
                        TextButton(onClick = { confirmDelete = false; onDelete() }) {
                            Text("delete", color = MaterialTheme.colorScheme.error)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { confirmDelete = false }) {
                            Text("cancel", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    },
                )
            }
        }
    }
}

@Composable
fun ReasoningDisclosure(reasoning: String) {
    var expanded by remember { mutableStateOf(false) }
    // Eased open/close instead of a snap (iOS 0.15s easeInOut disclosure parity).
    Column(Modifier.padding(bottom = 4.dp).animateContentSize()) {
        TextButton(
            onClick = { expanded = !expanded },
            contentPadding = PaddingValues(0.dp),
            modifier = Modifier.height(24.dp),
        ) {
            // iOS ReasoningDisclosure parity: brain glyph + "thinking"/"thought
            // for a bit" + a chevron that flips with the open state.
            Icon(Icons.Outlined.Psychology, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(
                if (expanded) "thinking" else "thought for a bit",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(2.dp))
            Icon(
                if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(14.dp),
            )
        }
        if (expanded) {
            Text(
                reasoning,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun UpdateBanner() {
    val app = androidx.compose.ui.platform.LocalContext.current.applicationContext as TinyApp
    val update by app.updater.available.collectAsState()
    val installing by app.updater.installing.collectAsState()
    val scope = rememberCoroutineScope()
    var installError by remember { mutableStateOf<String?>(null) }
    val info = update ?: return
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (installError == null) {
                Icon(Icons.Outlined.SystemUpdateAlt, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
            }
            Text(
                installError ?: "tiny ${info.versionName} available",
                style = MaterialTheme.typography.labelSmall,
                color = if (installError != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                enabled = !installing,
                onClick = {
                    installError = null
                    scope.launch { installError = app.updater.install(info) }
                },
            ) { Text(if (installing) "installing…" else "update") }
            TextButton(onClick = { app.updater.dismiss() }) { Text("later") }
        }
    }
}

@Composable
fun SpeechCard(messageId: String, text: String) {
    val app = androidx.compose.ui.platform.LocalContext.current.applicationContext as TinyApp
    val speakingId by app.speech.speakingId.collectAsState()
    val playing = speakingId == messageId
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.padding(top = 6.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = { if (playing) app.speech.stop() else app.speech.speak(text, messageId) },
                modifier = Modifier.size(28.dp),
            ) {
                Icon(
                    if (playing) Icons.Filled.Stop else Icons.Filled.VolumeUp,
                    contentDescription = if (playing) "stop" else "play",
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
            )
        }
    }
}

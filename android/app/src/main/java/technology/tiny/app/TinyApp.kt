package technology.tiny.app

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import technology.tiny.app.auth.AuthManager
import technology.tiny.app.wear.WatchBridge
import technology.tiny.app.chat.Continuity
import technology.tiny.app.chat.MyShares
import technology.tiny.app.chat.Speech
import technology.tiny.app.fleet.FleetManager
import technology.tiny.app.net.ModelConfigStore
import technology.tiny.app.net.Net
import technology.tiny.app.net.TinyApi
import technology.tiny.app.tools.DeviceTools
import technology.tiny.app.update.Updater

class TinyApp : Application() {
    lateinit var auth: AuthManager
        private set
    lateinit var api: TinyApi
        private set
    lateinit var config: Config
        private set
    lateinit var continuity: Continuity
        private set
    lateinit var speech: Speech
        private set
    lateinit var fleet: FleetManager
        private set
    lateinit var updater: Updater
        private set
    lateinit var deviceTools: DeviceTools
        private set
    lateinit var net: Net
        private set
    lateinit var myShares: MyShares
        private set
    lateinit var modelConfig: ModelConfigStore
        private set

    /**
     * Captured-screenshot results, keyed by toolUseId. The screenshot capture
     * runs in a detached foreground service (ScreenshotService), off the chat
     * surface — so it can't touch ChatViewModel directly. It emits the hosted
     * R2 URL here after upload; the active ChatViewModel collects and attaches
     * it to the matching ToolCall card so the USER sees what they approved
     * (iOS shows a GeneratedImageCard inline). replay=1 covers the tiny window
     * where the VM re-subscribes across a config change mid-capture.
     */
    /**
     * 🕸 Debug-only: the memory-graph screenshot harness is armed for this process
     * (`--ez tiny_harness_graph true`, set in MainActivity.handleDebugExtras).
     *
     * Lives here rather than in Config because it must NOT persist — a flag written
     * to prefs would survive the capture and keep showing a fake graph to the user
     * on their own device, which is a far worse bug than the one it fixes. It also
     * has to outlive the composable: the graph sheet is created and destroyed each
     * time it's opened, so an Activity-local `var` would be lost. Process-scoped and
     * volatile is exactly the lifetime a screenshot flag should have.
     *
     * GraphHarness.enabled() still gates on BuildConfig.DEBUG at the point of use,
     * so this being true in a release build (it can't be — MainActivity won't set
     * it) would still substitute nothing.
     */
    var graphHarness: Boolean = false

    /**
     * 🛰 Debug-only: the fleet-list screenshot harness is armed for this process
     * (`--ez tiny_harness_fleet true`, set in MainActivity.handleDebugExtras).
     *
     * Same lifetime argument as [graphHarness] — process-scoped and non-persistent, so
     * it can't survive the capture and start showing a fake fleet to the user on their
     * own phone, and it outlives the devices sheet, which is rebuilt each time it opens.
     * FleetHarness.enabled() re-gates on BuildConfig.DEBUG at the point of use.
     */
    var fleetHarness: Boolean = false

    /**
     * 🧠 Debug-only: the memory-LIST screenshot harness is armed for this process
     * (`--ez tiny_harness_memory true`, set in MainActivity.handleDebugExtras).
     *
     * Same lifetime argument as [graphHarness] — process-scoped and non-persistent, so it
     * can't survive the capture and start showing the user fake memories (and, worse here,
     * can't leave the sheet's deletes routed away from their real handlers on the user's
     * own phone). MemoryHarness.enabled() re-gates on BuildConfig.DEBUG at the point of use.
     */
    var memoryHarness: Boolean = false

    data class ScreenshotResult(val toolUseId: String, val url: String)
    private val _screenshots = MutableSharedFlow<ScreenshotResult>(replay = 1, extraBufferCapacity = 4)
    val screenshots: SharedFlow<ScreenshotResult> = _screenshots.asSharedFlow()
    fun emitScreenshot(toolUseId: String, url: String) {
        _screenshots.tryEmit(ScreenshotResult(toolUseId, url))
    }

    override fun onCreate() {
        super.onCreate()
        auth = AuthManager(this)
        config = Config(this)
        continuity = Continuity(this)
        myShares = MyShares(this)
        modelConfig = ModelConfigStore(this)
        speech = Speech(this)
        api = TinyApi(
            tokenProvider = { auth.token },
            defaultTinyProvider = { config.tinyName },
            baseProvider = { config.serverBase },
            modelHeadersProvider = { modelConfig.headers() },
        )
        deviceTools = DeviceTools(this, quietProvider = { config.isQuietNow() })
        net = Net(this)
        fleet = FleetManager(this, api, auth, config, speech, continuity, deviceTools)
        updater = Updater(this) { config.updateBase ?: config.serverBase }
        mirrorSessionToWatch()
    }

    /**
     * Keep the Wear OS companion linked: mirror login/logout to the wrist over
     * the Data Layer (WatchBridge → the watch's PhoneLinkService). Observing
     * auth.user rather than hooking each call site keeps this ONE place and off
     * the hot MainActivity/ChatViewModel paths. Fire-and-forget: with no watch
     * ever paired, WatchBridge just logs and the app is unaffected.
     *
     * Key on account IDENTITY (user id), NOT a login-presence boolean: an account
     * SWITCH drives user A(non-null) → B(non-null) with no null between (saveSession
     * sets _user directly, never through logout), so a presence boolean stays `true`
     * and distinctUntilChanged emits NOTHING — neither pushSession (B's new token)
     * nor pushLogout fires, so A's session token stays in the watch's encrypted
     * prefs and A's cached snapshot (lastQ/lastA) stays on the wrist, and the watch
     * keeps chatting/speaking as A. Keying on id makes a switch a real transition
     * that re-pushes B's session; a null id (logout) still scrubs. (Twin of the
     * account-switch fleet-cred scrub in MainActivity.exchangeCode.)
     */
    private fun mirrorSessionToWatch() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        scope.launch {
            auth.user
                .map { it?.id } // account identity: a SWITCH is a real transition, not a no-op
                .distinctUntilChanged()
                .collect { id ->
                    val now = System.currentTimeMillis()
                    val token = auth.token
                    if (id != null && token != null) {
                        WatchBridge.pushSession(this@TinyApp, token, config.accentHex, now)
                    } else if (id == null) {
                        WatchBridge.pushLogout(this@TinyApp, now)
                    }
                }
        }
    }
}

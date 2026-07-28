package technology.tiny.app.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import technology.tiny.app.TinyApp
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Home-screen widgets (iOS TinyWidgets/ContentWidgets parity), Glance-native.
 * All read the app-written [WidgetStore] snapshot — the widget process never
 * touches the network or the encrypted config. Container is black everywhere;
 * accent falls back to tiny-green when the snapshot carries no accentHex.
 *
 * Kinds mirror iOS kind strings so the intent is legible cross-platform:
 *   TinyStatus  → fleet online/total + unread   (small)
 *   TinyLastAnswer → newest Q/A exchange        (wide)
 *   TinyMemory  → remembered facts, rotating    (wide)
 *   TinyAsk     → voice launcher                (small)
 * Lock-screen "accessory" families have no Android equivalent and are dropped.
 */

// One source of truth: the app theme's brand tokens (a private copy drifted —
// it also carried a phantom Tertiary that exists nowhere in the app theme;
// kept as a local dim-gray derivation for 10sp widget footnotes).
private val TinyGreen = technology.tiny.app.ui.theme.TinyAccent
private val Black = technology.tiny.app.ui.theme.TinyBg
private val Secondary = technology.tiny.app.ui.theme.TinyGray
private val Tertiary = technology.tiny.app.ui.theme.TinyGray.copy(alpha = 0.65f)

private fun accentOf(snap: FleetSnapshot): Color =
    snap.accentHex?.let { hex ->
        runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrNull()
    } ?: TinyGreen

/**
 * Widgets are ≥2h stale → nudge to open the app (iOS TinyStatus staleness rule,
 * TinyWidgets.swift:41 `updated < now - 2*3600`). The 2h threshold matches iOS.
 *
 * DELIBERATE DEVIATION from iOS: the `updated > 0` guard means a NEVER-populated
 * snapshot (default `updated = 0L`, e.g. a freshly-added widget before the app's
 * heartbeat has ever written the store, or a malformed JSON read) reads NOT stale
 * here, whereas iOS's `Date.distantPast` default reads STALE ("open to sync"). So
 * Android shows neutral "0 online / 0 total" on first add where iOS shows the sync
 * nudge. Pinned by TinyWidgetsTest; revisit if we want the iOS first-add nudge.
 */
internal fun isStale(snap: FleetSnapshot, now: Long): Boolean =
    snap.updated > 0 && snap.updated < now - 2 * 3600_000L

/** Widget process can't call the disallowed clock — read the OS clock directly. */
private fun nowMs(): Long = System.currentTimeMillis()

// ── Accessibility descriptions ───────────────────────────────────────────────
// TalkBack reads a Glance widget's raw child text, so without an explicit root
// contentDescription each widget announced bare emoji glyphs (🌱🟢⚫💬🧠⚡🎙 read
// as "seedling", "green circle", …) and never said what a tap does. These pure
// builders turn each snapshot into one spoken line that states the widget's
// content AND its tap action, applied via GlanceModifier.semantics on the root.
// Pure (no Glance/Context), so the spoken text is unit-testable.

/** 🌱 Status: fleet online/total + unread, or the stale nudge. */
internal fun statusA11y(snap: FleetSnapshot, now: Long): String = when {
    isStale(snap, now) -> "tiny status. Data is out of date — tap to open the app and sync."
    else -> {
        val unread = when {
            snap.unread <= 0 -> "no unread messages"
            snap.unread == 1 -> "1 unread message"
            else -> "${snap.unread} unread messages"
        }
        val dest = if (snap.unread > 0) "Tap to open messages." else "Tap to ask."
        "tiny status. ${snap.online} of ${snap.total} tinys online, $unread. $dest"
    }
}

/** 💬 Last answer: newest Q/A, or the empty prompt. */
internal fun lastAnswerA11y(snap: FleetSnapshot): String {
    val hasAnswer = !snap.lastA.isNullOrEmpty()
    if (!hasAnswer) return "tiny last answer. No answers yet — tap to ask anything."
    val q = snap.lastQ?.takeIf { it.isNotBlank() }
    val prefix = if (q != null) "tiny answer to \"$q\". " else "tiny last answer. "
    return "$prefix${snap.lastA}. Tap to ask again."
}

/** Deterministic timer-free rotation index: which of [total] facts shows at [now]
 *  (advances every 20 min). The SINGLE source of the formula so the visible body
 *  and the a11y string can't drift — both must pass the same `now` to land on the
 *  same fact (a straddled 20-min boundary within one provideGlance would otherwise
 *  announce a different fact than is shown). Returns 0 for an empty list. */
internal fun memoryIdx(total: Int, now: Long): Int =
    if (total <= 0) 0 else ((now / (20 * 60_000L)) % total).toInt()

/** 🧠 Memory: the rotating remembered fact + its position. */
internal fun memoryA11y(snap: FleetSnapshot, now: Long): String {
    val total = snap.memories.size
    if (total == 0) return "tiny memory. Nothing remembered yet — tap to open memory."
    val idx = memoryIdx(total, now)
    val pos = if (total > 1) " (${idx + 1} of $total)" else ""
    return "tiny memory$pos. ${snap.memories[idx]}. Tap to open memory."
}

/** ⚡ Briefing: interactive run button. */
internal fun briefingA11y(running: Boolean): String =
    if (running) "tiny briefing, running. Please wait for the answer in the Last answer widget."
    else "tiny briefing. Tap to run a briefing; the answer appears in the Last answer widget."

/** 🎙 Ask: voice launcher. */
internal fun askA11y(): String = "Ask tiny by voice. Tap, then speak; a 3 second pause sends."

// tinyapp:// deep link → MainActivity (registered via VIEW intent-filter).
private fun routeIntentAction(context: Context, path: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse("tinyapp://$path")).apply {
        setPackage(context.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

// ── 🌱 Status ────────────────────────────────────────────────────────────────

class TinyStatusWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = WidgetStore.read(context)
        provideContent {
            GlanceTheme {
                val accent = accentOf(snap)
                // Unread → jump to Messages; otherwise focus the ask box (iOS parity).
                val route = if (snap.unread > 0) "messages" else "ask"
                Column(
                    modifier = GlanceModifier.fillMaxSize().background(Black).padding(14.dp)
                        .semantics { contentDescription = statusA11y(snap, nowMs()) }
                        .clickable(actionStartActivity(routeIntentAction(context, route))),
                    verticalAlignment = Alignment.Top,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("🌱", style = TextStyle(fontSize = 15.sp))
                        Spacer(GlanceModifier.width(4.dp))
                        Text(
                            "tiny",
                            style = TextStyle(
                                color = ColorProvider(accent), fontWeight = FontWeight.Bold, fontSize = 16.sp,
                            ),
                        )
                    }
                    Spacer(GlanceModifier.height(10.dp))
                    if (isStale(snap, nowMs())) {
                        Text(
                            "Open tiny to sync",
                            style = TextStyle(color = ColorProvider(Secondary), fontSize = 13.sp),
                        )
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                if (snap.online > 0) "🟢" else "⚫",
                                style = TextStyle(fontSize = 11.sp),
                            )
                            Spacer(GlanceModifier.width(5.dp))
                            Text(
                                "${snap.online}/${snap.total} online",
                                style = TextStyle(color = ColorProvider(Color.White), fontSize = 13.sp),
                            )
                        }
                        Spacer(GlanceModifier.height(6.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("💬", style = TextStyle(fontSize = 11.sp))
                            Spacer(GlanceModifier.width(5.dp))
                            if (snap.unread > 0) {
                                Text(
                                    "${snap.unread} unread",
                                    style = TextStyle(color = ColorProvider(accent), fontSize = 13.sp),
                                )
                            } else {
                                Text(
                                    "no unread",
                                    style = TextStyle(color = ColorProvider(Secondary), fontSize = 13.sp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

class TinyStatusReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TinyStatusWidget()
}

// ── 💬 Last answer ───────────────────────────────────────────────────────────

class TinyLastAnswerWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = WidgetStore.read(context)
        provideContent {
            GlanceTheme {
                val accent = accentOf(snap)
                val hasAnswer = !snap.lastA.isNullOrEmpty()
                Column(
                    modifier = GlanceModifier.fillMaxSize().background(Black).padding(14.dp)
                        .semantics { contentDescription = lastAnswerA11y(snap) }
                        .clickable(actionStartActivity(routeIntentAction(context, "ask"))),
                ) {
                    Row(
                        modifier = GlanceModifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("🌱", style = TextStyle(fontSize = 13.sp))
                        Spacer(GlanceModifier.width(5.dp))
                        Text(
                            if (hasAnswer) (snap.lastQ ?: "") else "tiny",
                            maxLines = 1,
                            style = TextStyle(
                                color = ColorProvider(accent), fontWeight = FontWeight.Medium, fontSize = 12.sp,
                            ),
                        )
                    }
                    Spacer(GlanceModifier.height(4.dp))
                    Text(
                        if (hasAnswer) (snap.lastA ?: "") else "Ask anything — the newest answer lives here.",
                        maxLines = 3,
                        style = TextStyle(
                            color = ColorProvider(if (hasAnswer) Color.White else Secondary),
                            fontSize = 13.sp,
                        ),
                    )
                }
            }
        }
    }
}

class TinyLastAnswerReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TinyLastAnswerWidget()
}

// ── 🧠 Memory ────────────────────────────────────────────────────────────────

class TinyMemoryWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = WidgetStore.read(context)
        // Rotate deterministically without a timer: index by (now / 20min) % count.
        val mems = snap.memories
        provideContent {
            GlanceTheme {
                val accent = accentOf(snap)
                val total = mems.size
                // Read the clock ONCE and thread it through both the visible index and
                // the a11y string. Two independent nowMs() reads could straddle a 20-min
                // rotation boundary within a single provideGlance, so TalkBack would
                // announce a different remembered fact (and "N/total" position) than the
                // one on screen — memoryA11y recomputes idx from the same formula.
                val now = nowMs()
                val idx = memoryIdx(total, now)
                val content = when {
                    total == 0 -> "Tell tiny to remember things — they rotate here."
                    else -> mems[idx]
                }
                Column(
                    modifier = GlanceModifier.fillMaxSize().background(Black).padding(14.dp)
                        .semantics { contentDescription = memoryA11y(snap, now) }
                        .clickable(actionStartActivity(routeIntentAction(context, "memory"))),
                ) {
                    Row(
                        modifier = GlanceModifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("🧠", style = TextStyle(fontSize = 13.sp))
                        Spacer(GlanceModifier.width(5.dp))
                        Text(
                            "memory",
                            style = TextStyle(
                                color = ColorProvider(accent), fontWeight = FontWeight.Medium, fontSize = 12.sp,
                            ),
                        )
                        if (total > 1) {
                            Spacer(GlanceModifier.defaultWeight())
                            Text(
                                "${idx + 1}/$total",
                                style = TextStyle(color = ColorProvider(Tertiary), fontSize = 10.sp),
                            )
                        }
                    }
                    Spacer(GlanceModifier.height(4.dp))
                    Text(
                        content,
                        maxLines = 4,
                        style = TextStyle(color = ColorProvider(Color.White), fontSize = 13.sp),
                    )
                }
            }
        }
    }
}

class TinyMemoryReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TinyMemoryWidget()
}

// ── ⚡ Briefing (interactive, headless) ───────────────────────────────────────

/**
 * The one INTERACTIVE home-screen widget (iOS PhoneBriefingWidget parity): a tap
 * runs the briefing prompt headlessly via [BriefingAction] — no app launch — and
 * the answer lands in the shared snapshot, so the Last-answer widget shows it.
 * iOS drives this with an AppIntent (openAppWhenRun=false); Glance's analog is an
 * ActionCallback that hands off to a coroutine. While the callback runs, the
 * widget flips to a "running…" state via a store flag so the tap gives feedback.
 */
class TinyBriefingWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = WidgetStore.read(context)
        val running = WidgetStore.isBriefingRunning(context)
        provideContent {
            GlanceTheme {
                val accent = accentOf(snap)
                Column(
                    modifier = GlanceModifier.fillMaxSize().background(Black).padding(14.dp)
                        .semantics { contentDescription = briefingA11y(running) }
                        .clickable(actionRunCallback<BriefingAction>()),
                    verticalAlignment = Alignment.Top,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("⚡", style = TextStyle(fontSize = 15.sp))
                        Spacer(GlanceModifier.width(4.dp))
                        Text(
                            "briefing",
                            style = TextStyle(
                                color = ColorProvider(accent), fontWeight = FontWeight.Bold, fontSize = 16.sp,
                            ),
                        )
                    }
                    Spacer(GlanceModifier.defaultWeight())
                    Text(
                        if (running) "running…" else "Tap to run — the answer\nlands in Last answer.",
                        maxLines = 2,
                        style = TextStyle(
                            color = ColorProvider(if (running) accent else Secondary), fontSize = 12.sp,
                        ),
                    )
                }
            }
        }
    }
}

class TinyBriefingReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TinyBriefingWidget()
}

/**
 * Headless briefing turn (iOS PhoneBriefingIntent.perform parity). Guards on
 * login, runs one chatOnce with the continuity context, writes the answer to the
 * snapshot + appends it to the turn log, and re-renders the widgets — all without
 * opening the app. A store flag flips the widget to "running…" for tap feedback,
 * cleared in a finally so a failed turn can't wedge it on.
 */
class BriefingAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val app = context.applicationContext as TinyApp
        if (!app.auth.isLoggedIn) return
        // Ignore a second tap while one is already in flight (idempotent, iOS runs
        // one intent at a time too — a double-tap shouldn't fire two turns).
        if (WidgetStore.isBriefingRunning(context)) return
        WidgetStore.setBriefingRunning(context, true)
        TinyBriefingWidget().updateAll(app) // show "running…" immediately
        try {
            val tiny = app.config.tinyName
            val prompt = "Give me a tiny briefing: anything new, plus one useful or " +
                "interesting thing. 2 sentences max."
            val answer = runCatching {
                app.api.chatOnce(
                    "[Briefing widget on Android — answer in 1-2 short sentences, no markdown] $prompt",
                    tiny = tiny,
                    extraSystem = app.continuity.buildContext(tiny),
                )
            }.getOrNull()?.trim().orEmpty()
            if (answer.isNotEmpty() && !answer.startsWith("⚠")) {
                app.continuity.appendTurn(tiny, prompt, answer)
                if (tiny == "tiny") {
                    WidgetBridge.publishExchange(
                        app, "briefing", answer,
                        app.continuity.loadMemories(tiny).map { it.content },
                    )
                }
            }
        } finally {
            WidgetStore.setBriefingRunning(context, false)
            TinyBriefingWidget().updateAll(app)
        }
    }
}

// ── 🎙 Ask (voice launcher) ──────────────────────────────────────────────────

class TinyAskWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = WidgetStore.read(context)
        provideContent {
            GlanceTheme {
                val accent = accentOf(snap)
                Column(
                    modifier = GlanceModifier.fillMaxSize().background(Black).padding(14.dp)
                        .semantics { contentDescription = askA11y() }
                        .clickable(actionStartActivity(routeIntentAction(context, "voice"))),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("🎙", style = TextStyle(fontSize = 30.sp))
                    Spacer(GlanceModifier.height(6.dp))
                    Text(
                        "ask tiny",
                        style = TextStyle(
                            color = ColorProvider(accent), fontWeight = FontWeight.Bold, fontSize = 15.sp,
                        ),
                    )
                    Spacer(GlanceModifier.height(2.dp))
                    Text(
                        "tap · speak · 3s pause sends",
                        style = TextStyle(color = ColorProvider(Secondary), fontSize = 10.sp),
                    )
                }
            }
        }
    }
}

class TinyAskReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TinyAskWidget()
}

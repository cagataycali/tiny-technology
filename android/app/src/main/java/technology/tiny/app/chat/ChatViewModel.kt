package technology.tiny.app.chat

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.net.ChatEvent
import technology.tiny.app.net.truthyFlag
import java.io.File
import java.util.UUID

data class UiCard(val title: String?, val propsJson: String)

data class ChatMessage(
    val id: String = UUID.randomUUID().toString(),
    val role: String, // "user" | "assistant" | "note"
    val text: String,
    val streaming: Boolean = false,
    val toolLabel: String? = null,
    val speechText: String? = null, // speak-tool card
    val reasoning: String = "",     // collapsible thinking
    val uiCards: List<UiCard> = emptyList(), // render_ui props cards
    val spawns: List<technology.tiny.app.ui.SpawnTree> = emptyList(), // spawn_agents fan-out trees
    val toolCalls: List<technology.tiny.app.ui.ToolCall> = emptyList(), // per-tool detail cards
    val inTok: Int = 0,  // usage: input tokens (modelMetadataEvent)
    val outTok: Int = 0, // usage: output tokens
    val cacheReadTok: Int = 0, // usage: cached input reads (discounted in the $ estimate)
    val modelId: String? = null, // resolved model id — drives the per-turn $ estimate (web parity)
    // Set on the assistant reply when its turn failed (mid-stream error or dropped
    // transport). Holds the user prompt so Retry can resend it; also flags the turn
    // so it's excluded from continuity/widgets/share and reloads as failed, not
    // complete (iOS ChatMessage.failedPrompt parity).
    val failedPrompt: String? = null,
    // Sent-attachment previews on a USER turn (iOS ChatMessage.thumbs/docs): tiny 96px
    // JPEG thumbnails (base64) + document names, so a sent image/doc stays visible in the
    // transcript after send instead of vanishing to text. Durable — persisted by MessageCodec.
    val thumbs: List<String> = emptyList(),
    val docNames: List<String> = emptyList(),
    // Set on the assistant reply when the turn hit a 402 paywall (a priced tiny
    // with an unfunded/signed-out wallet). Renders an actionable card (💳 Add
    // funds + ↻ Retry) instead of the generic error+retry — the card owns the
    // retry-once-funded resend, so [failedPrompt] stays null (web m.paywall).
    val paywall: technology.tiny.app.wallet.WalletCore.Paywall? = null,
    // The prompt to re-send when the paywall's Retry is tapped (after top-up).
    val paywallPrompt: String? = null,
    // The PERSISTED terminal outcome of a pay_x402 approval (C3). toolCalls are
    // transient (MessageCodec drops them), so a settled payment card would VANISH
    // on reload — losing the receipt of real money moved. This durable field
    // rides the message (like [paywall]) and re-renders the receipt on load. Keyed
    // by toolUseId so multiple pay cards in one turn each persist independently.
    // Web ToolCall.paySettled / iOS PayQuoteItem.settled parity.
    val paySettled: Map<String, technology.tiny.app.wallet.WalletCore.PaySettled> = emptyMap(),
)

/**
 * The id of a held SIGNED-OUT paywall turn to auto-continue once the user signs in,
 * or null if there's none to resume. A signed-out 402 (the server rejected the
 * session) shows a "Sign in" card; on iOS after login() the held turn is re-sent
 * automatically (Views.swift:3383 `chat.retry(msg)`) and web reloads via return_to
 * into an authed page (Chat.tsx:3499) — otherwise the user authenticates and then
 * stares at a now-stale "Sign in" card, having to hunt for a retry. Android had no
 * such continuation. This is the pure decision extracted from that wiring.
 *
 * Resume the LAST such card (the most recent blocked turn) and ONLY when it's a
 * signed-out paywall carrying a resumable prompt — a funded-but-short paywall
 * (signedOut=false) is NOT resumed by signing in (its blocker is balance, not auth),
 * and a card with no [ChatMessage.paywallPrompt] has nothing to re-send.
 */
internal fun signedOutPaywallResumeId(messages: List<ChatMessage>): String? =
    messages.lastOrNull { it.paywall?.signedOut == true && !it.paywallPrompt.isNullOrEmpty() }?.id

/**
 * Canonical tiny-slug normalization for [ChatViewModel.switchTiny] — the single
 * point every persona switch flows through (/tiny command, MRU launcher
 * shortcut, and the BROWSABLE tinyapp://tiny?name=<slug> deep link). Matches the
 * sendVisit/fetchPrice rule: lowercase, collapse any run of non-alphanumerics to
 * a single '-', trim leading/trailing '-', and cap length so a hostile or
 * fat-fingered name can't become the stored persona verbatim. Pure so it's
 * unit-testable without an Application-backed ViewModel. Empty result = "no
 * usable slug" (caller ignores the switch), so a name of pure punctuation can't
 * blank out the current tiny.
 */
internal fun normalizeTinySlug(name: String): String =
    name.trim().lowercase()
        .replace(Regex("[^a-z0-9]+"), "-")
        .take(64)
        .trim('-') // after the cut, so a length-truncated slug can't end in '-'

private const val MAX_HISTORY = 200
private const val SEND_HISTORY = 30

// Autonomous mode (web ambient.ts): loop cap + the literal the agent emits when done.
private const val MAX_AUTONOMOUS_ITER = 5
private const val AMBIENT_DONE_SIGNAL = "[AMBIENT_DONE]"
// Idle-ambient (web ambient.ts run(): after IDLE_MS idle with an existing convo, fire
// ONE quiet background exploration; bounded per session, cooled down between runs).
private const val AMBIENT_IDLE_MS = 45_000L
private const val AMBIENT_COOLDOWN_MS = 5 * 60_000L
private const val AMBIENT_MAX_PER_SESSION = 3

/**
 * A slash command surfaced in the command palette (web CommandPalette.tsx parity).
 * [insert] is the text seeded into the composer when picked; [runsImmediately] =
 * false means it takes an argument, so we prefill + focus instead of sending
 * (e.g. /tiny <name>, mirroring web's /auto prefill behavior).
 */
data class SlashCommand(
    val name: String,
    val description: String,
    val insert: String,
    val runsImmediately: Boolean = true,
) {
    /** Does the query match at all (case-insensitive)? Thin boolean over [score]. */
    fun matches(query: String): Boolean = score(query) != null

    /**
     * Best (lowest) fuzzy score of the query against name OR description — the
     * EXACT port of web's `fuzzyScore` (CommandPalette.tsx:70) folded over both
     * fields (`min(fuzzyScore(q,name), fuzzyScore(q,description))`, the palette
     * `sections` useMemo). Lower is better; null = no match. The palette sorts by
     * this so the best match is the top row — the row a tap/Enter runs. Android
     * (and iOS, until its cycle-68 fix) previously filtered by a boolean subseq in
     * STATIC declaration order, so a query like "mem" surfaced whatever was
     * declared first that happened to contain m-e-m above /memory, and running the
     * top row could fire the wrong command.
     */
    fun score(query: String): Int? {
        val q = query.lowercase()
        if (q.isEmpty()) return 0
        val n = fuzzyScore(q, name.lowercase())
        val d = fuzzyScore(q, description.lowercase())
        return when {
            n != null && d != null -> minOf(n, d)
            n != null -> n
            else -> d
        }
    }

    /**
     * Subsequence fuzzy score (web CommandPalette.tsx:70 `fuzzyScore`): a substring
     * hit scores its index (earlier = better); a scattered subsequence scores
     * `100 + gaps` so ANY substring hit outranks ANY subsequence. null = the query
     * isn't even a subsequence of the target. Assumes q/target already lowercased.
     */
    private fun fuzzyScore(q: String, target: String): Int? {
        if (q.isEmpty()) return 0
        val idx = target.indexOf(q)
        if (idx != -1) return idx // substring beats scattered subsequence
        var ti = 0
        var gaps = 0
        var last = -1
        for (ch in q) {
            ti = target.indexOf(ch, ti)
            if (ti == -1) return null
            if (last != -1) gaps += ti - last - 1
            last = ti
            ti += 1
        }
        return 100 + gaps // any subsequence ranks below any substring hit
    }
}

/** The palette command catalog — kept in sync with ChatViewModel.handleSlash. */
val SLASH_COMMANDS = listOf(
    SlashCommand("clear", "Clear conversation history", "/clear"),
    SlashCommand("tiny", "Switch to another tiny by name", "/tiny ", runsImmediately = false),
    SlashCommand("auto", "Autonomous mode — /auto <task> works until done", "/auto ", runsImmediately = false),
    SlashCommand("loop", "Background loop — /loop [5m|2h] <prompt> runs on a schedule", "/loop ", runsImmediately = false),
    SlashCommand("share", "Share this conversation as a link", "/share"),
    SlashCommand("shares", "My share links — list and revoke", "/shares"),
    SlashCommand("tools", "Marketplace — browse & trust forged tools", "/tools browse"),
    SlashCommand("tools mine", "My forged toolbox — list, install, remove tools", "/tools mine"),
    SlashCommand("toolbox", "My forged tools — visual toolbox panel", "/toolbox"),
    SlashCommand("export", "Export conversation as markdown", "/export"),
    SlashCommand("save", "Archive this session to your account", "/save"),
    SlashCommand("load", "Restore a saved session archive", "/load"),
    SlashCommand("archives", "Cloud session archives — list and restore", "/archives"),
    SlashCommand("sessions", "Local saved conversations — save, load, delete (offline)", "/sessions"),
    SlashCommand("cost", "Token usage for this conversation", "/cost"),
    SlashCommand("wallet", "Wallet — balance, deposit, link, claim, withdraw", "/wallet"),
    SlashCommand("chain", "Chain explorer — which chain settles your payments, and recent activity", "/chain"),
    SlashCommand("price", "Price what you own — a tiny per message or a tool per install", "/price"),
    SlashCommand("telegram", "Telegram bot — connect, pair chats, pause", "/telegram status"),
    SlashCommand("memory", "Memory panel — facts, history, provenance", "/memory"),
    SlashCommand("graph", "Memory graph — facts & links, force-directed", "/graph"),
    SlashCommand("messages", "Direct messages — inbox and threads", "/messages"),
    SlashCommand("jobs", "Scheduled background jobs", "/jobs"),
    SlashCommand("nearby", "Nearby devices — live Bluetooth scan", "/nearby"),
    SlashCommand("map", "Live map — you, your pins, tiny users", "/map"),
    SlashCommand("activity", "What happened while you were away", "/activity"),
    SlashCommand("devices", "Machines enrolled to your tiny identity", "/devices"),
    SlashCommand("universe", "Browse the tiny universe", "/universe"),
    SlashCommand("settings", "App settings & fleet status", "/settings"),
    SlashCommand("forgetall", "Wipe all memories + turn log", "/forgetall"),
    SlashCommand("help", "Show all commands", "/help"),
)

class ChatViewModel(app: Application) : AndroidViewModel(app) {
    private val tinyApp = app as TinyApp

    val messages = mutableStateListOf<ChatMessage>()
    val followups = mutableStateListOf<String>()
    var tiny by mutableStateOf("tiny")
        private set

    // Concurrent streams (web lib/chat/stream-registry.ts, Option B — unbounded):
    // the live registry is the set of assistant-message ids still streaming.
    // Claimed SYNCHRONOUSLY in send() before the coroutine launches; released in
    // each stream's finally. `busy` derives from it so existing "any turn in
    // flight?" readers (ambient, /auto, share/save guards, composer) keep working.
    val liveIds = mutableStateListOf<String>()
    val busy: Boolean get() = liveIds.isNotEmpty()
    private val streamJobs = mutableMapOf<String, Job>() // keyed by assistant message id
    private val claimedAt = mutableMapOf<String, Long>() // epoch ms — "started Ns ago" annotation
    var error by mutableStateOf<String?>(null) // transient composer banner (e.g. attachment too large)
    var openPanel by mutableStateOf<String?>(null) // "memory" | "universe" | "devices" | "settings" | "toolbox" | …
    // The paywalled message whose "💳 Add funds" opened the wallet panel, so a
    // successful top-up auto-continues the held turn instead of dropping the user
    // back onto a now-stale paywall card (web Cycle-92 / iOS Cycle-93 parity).
    // Set ONLY from a paywall card's Add funds — the composer wallet button leaves
    // it null, so closing the panel there is a plain dismiss. onWalletDismissed()
    // checks the FRESH balance before re-sending (the panel closes on any dismiss,
    // funded or not — like iOS, unlike web's success-only onFunded callback).
    var paywallAwaitingFunds by mutableStateOf<ChatMessage?>(null)
    var confirmClear by mutableStateOf(false) // /clear → confirmation dialog (web's confirm() parity)
    val pendingImages = mutableStateListOf<String>() // base64 JPEGs awaiting send (≤4)
    val pendingDocs = mutableStateListOf<PendingDoc>() // documents awaiting send (Converse doc blocks)

    /**
     * Stage one image, gating on the total-payload budget (iOS `appendAttachment`
     * parity). The per-message count cap (Attachments.clampPicks) is enforced by
     * callers; this is the batch-size guard the mobile clients were missing — four
     * heavy picks can sum past the worker's body cap even when each fits its own
     * per-item limit. Returns whether it was staged; sets `error` when rejected so
     * the composer says so up front instead of the send failing server-side.
     */
    fun addPendingImage(base64: String): Boolean {
        if (!Attachments.fitsPayload(pendingImages, pendingDocs, base64)) {
            error = "attachments exceed ${Attachments.MAX_PAYLOAD_LABEL} total — remove some first"
            return false
        }
        pendingImages.add(base64)
        return true
    }

    /** Stage one document under the same total-payload guard (see [addPendingImage]). */
    fun addPendingDoc(doc: PendingDoc): Boolean {
        if (!Attachments.fitsPayload(pendingImages, pendingDocs, doc.base64)) {
            error = "attachments exceed ${Attachments.MAX_PAYLOAD_LABEL} total — remove some first"
            return false
        }
        pendingDocs.add(doc)
        return true
    }
    val online get() = tinyApp.net.online
    var accentHex by mutableStateOf<String?>(null) // per-tiny theme accent
        private set
    var bgHex by mutableStateOf<String?>(null) // per-tiny theme background (theme.bg)
        private set
    var heroUrl by mutableStateOf<String?>(null) // per-tiny hero banner (owner-set https image URL)
        private set
    var logoUrl by mutableStateOf<String?>(null) // per-tiny landing logo (image/gif/mp4/webm https URL)
        private set
    var introVibe by mutableStateOf<String?>(null) // per-tiny intro haptic (vibrate-tool pattern name)
        private set
    var customChips by mutableStateOf<List<String>?>(null) // per-tiny starter chips (replace defaults)
        private set
    var customTagline by mutableStateOf<String?>(null) // per-tiny landing subtitle (replaces the generic line)
        private set
    // 🔒 Private tiny (worker `private`) — hidden from search/list; only vouched
    // devices can chat. Drives the darkened surface + lock glyph (web Chat.tsx
    // lock-hero / iOS PrivateLockPanel parity).
    var isPrivate by mutableStateOf(false)
        private set
    // Whether THIS device is vouched for the private tiny (worker `isAuthorized`,
    // echoed via /api/tiny). Only meaningful when isPrivate; a private tiny with
    // !isAuthorized shows the lock panel instead of the composer. fetchAccent's
    // request already carries the session token (TinyApi.postJson → Bearer), so
    // an owner comes back authorized automatically.
    var isAuthorized by mutableStateOf(false)
        private set
    // Whether the signed-in account OWNS this tiny (worker `isOwner`, echoed via
    // /api/tiny only when the internal key + userId vouched a match). Gates
    // owner-only edit surfaces like the realtime call-voice picker.
    var isOwner by mutableStateOf(false)
        private set
    // Per-tiny realtime-voice (worker `voice`) — which OpenAI voice the tiny
    // speaks with on a live call. Owner-editable; "" = the marin default.
    // Named callVoice: `voice` is already the dictation VoiceMode above.
    var callVoice by mutableStateOf("")
        private set
    // Owner-only: the tiny's persona, echoed to owners by /api/tiny. Held so a
    // voice-only save can RE-SEND it — the worker's D1 mirror writes raw
    // body.systemPrompt, so an upsert omitting it would blank the relational
    // persona columns (KV is preserved, but D1 isn't).
    private var ownerSystemPrompt = ""
    private var ownerSystemKnowledge = ""
    // 💵 Up-front per-message price for a PAID tiny (micro-USDC), or null for a free
    // one — surfaces the paywall cost in the top bar BEFORE a 402 hits mid-send (web
    // Chat.tsx priceMicro badge). Reset to null at the start of each lookup so a
    // switch from a paid tiny to a free one can't strand the old price (web 2f9febf).
    var priceMicro by mutableStateOf<Long?>(null)
        private set
    private var introVibePlayed = false // intro haptic fires once per tiny open/switch

    private val queuedSends = ArrayDeque<String>()

    // Autonomous mode (/auto <task>): a client-side loop that works in the background
    // (web ambient.ts startAutonomous parity — iOS has no equivalent). autoRunning drives
    // a status pill; autoStopped is the cancel flag (set when the user types/sends). Per-
    // tiny findings accumulate here and are injected as a hidden system note on the NEXT
    // normal turn, never shown as chat bubbles.
    var autoRunning by mutableStateOf(false)
        private set
    private var autoStopped = false
    private var autoJob: Job? = null
    private val autoFindings = mutableMapOf<String, StringBuilder>()

    // Idle-ambient (web ambient.ts run() half): after a turn, arm a 45s timer; if the
    // user stays idle (no send) and hasn't hit the per-tiny session cap, fire ONE silent
    // background exploration of the last topic. Findings share the autoFindings buffer, so
    // they surface with the same "🌙 Ambient thinking" note on the next real turn. Any send
    // cancels the pending timer. Metered per-tiny (cap 3) with a 5-min cooldown between runs.
    private var idleJob: Job? = null
    private val ambientCount = mutableMapOf<String, Int>()
    private val ambientCooldownUntil = mutableMapOf<String, Long>()

    // manage_messages ops queue up during the stream and apply after it ends —
    // mutating the transcript mid-stream would shift the live reply index (iOS parity).
    private data class ManageOp(val action: String, val from: Int?, val to: Int?, val summary: String?)
    private val pendingManage = mutableListOf<ManageOp>()

    // Voice mode: mic stays open even while streaming — each utterance sends
    // immediately as its own concurrent turn (web concurrent-sends voice parity;
    // queuedSends now only buffers offline sends).
    val voice = VoiceMode(app, tinyApp.speech) { text -> send(text) }

    init {
        viewModelScope.launch { loadHistory() }
        // Restore offline-queued sends from disk — they'd otherwise die with the
        // process after the composer promised "will send when back online". The
        // reconnect watcher re-arms here too; net.online is a StateFlow, so if
        // connectivity is already back the first collect drains immediately.
        queuedSends.addAll(tinyApp.config.queuedSends)
        if (queuedSends.isNotEmpty()) watchForReconnect()
        // Screenshot capture runs off-surface (ScreenshotService) and posts the
        // hosted still back here; attach it to the matching ToolCall card so the
        // user sees what they approved inline (iOS GeneratedImageCard parity).
        viewModelScope.launch {
            tinyApp.screenshots.collect { attachScreenshot(it.toolUseId, it.url) }
        }
        // Signed-out paywall auto-continue: a 402 that says "Sign in" leaves a held
        // turn on screen. When the user completes login (auth.user goes null→present)
        // continue that turn automatically instead of leaving them on a now-stale
        // "Sign in" card (iOS Views.swift:3383 `chat.retry(msg)` after `login()`;
        // web reloads via return_to into an authed page, Chat.tsx:3499). Guard on the
        // null→present EDGE so the already-signed-in startup emission never fires.
        viewModelScope.launch {
            var wasSignedIn = tinyApp.auth.user.value != null
            tinyApp.auth.user.collect { user ->
                val signedIn = user != null
                if (signedIn && !wasSignedIn) {
                    val id = signedOutPaywallResumeId(messages)
                    messages.firstOrNull { it.id == id }?.let { retryPaywall(it) }
                }
                wasSignedIn = signedIn
            }
        }
    }

    /** Attach a captured screenshot URL to its ToolCall card (keyed by toolUseId). */
    private fun attachScreenshot(toolUseId: String, url: String) {
        if (url.isEmpty()) return // denied/failed sentinel (voice-bridge waiters consume it)
        val idx = messages.indexOfLast { m -> m.toolCalls.any { it.id == toolUseId } }
        if (idx < 0) return
        val updated = messages[idx].toolCalls.map {
            if (it.id == toolUseId) it.copy(imageUrl = url) else it
        }
        messages[idx] = messages[idx].copy(toolCalls = updated)
    }

    /** Persist a pay_x402 quote's terminal outcome onto its message (C3), keyed by
     *  toolUseId, and save AT ONCE — a money event, not a debounce-able stream
     *  partial. toolCalls aren't persisted, so this durable map is what re-renders
     *  the receipt on reload (web ToolCall.paySettled / iOS PayQuoteItem.settled). */
    fun settlePayCard(toolUseId: String, settled: technology.tiny.app.wallet.WalletCore.PaySettled) {
        val idx = messages.indexOfLast { m -> m.toolCalls.any { it.id == toolUseId } }
        if (idx < 0) return
        messages[idx] = messages[idx].copy(
            paySettled = messages[idx].paySettled + (toolUseId to settled),
        )
        saveHistory()
    }

    /** Mirror the offline queue to disk after every mutation (see Config.queuedSends). */
    private fun persistQueue() {
        tinyApp.config.queuedSends = queuedSends.toList()
    }

    override fun onCleared() {
        voice.stop()
        cancelIdleAmbient()
        super.onCleared()
    }

    /**
     * Retry a failed turn (iOS Views.swift:505-516): drop the error bubble AND its
     * paired user message (send() re-appends both), then resend the held prompt.
     * No-op if the message carries no failedPrompt or is itself still streaming;
     * OTHER live streams don't block — the retry is just a new concurrent turn.
     */
    fun retry(failed: ChatMessage) {
        val prompt = failed.failedPrompt ?: return
        if (liveIds.contains(failed.id)) return
        val i = messages.indexOfFirst { it.id == failed.id }
        if (i >= 0) {
            messages.removeAt(i)
            if (i > 0 && messages[i - 1].role == "user" && messages[i - 1].text == prompt) {
                messages.removeAt(i - 1)
            }
        }
        send(prompt)
    }

    /**
     * Retry a paid send after the user tops up (paywall card's ↻ Retry). Drops the
     * paywall bubble and its user prompt (send re-adds both), then re-sends — the
     * per-message charge settles server-side once the wallet is funded (web Chat.tsx
     * paywall Retry). No-op if the turn is somehow still live.
     */
    fun retryPaywall(paywallMsg: ChatMessage) {
        val prompt = paywallMsg.paywallPrompt ?: return
        if (liveIds.contains(paywallMsg.id)) return
        val i = messages.indexOfFirst { it.id == paywallMsg.id }
        if (i >= 0) {
            messages.removeAt(i)
            if (i > 0 && messages[i - 1].role == "user" && messages[i - 1].text == prompt) {
                messages.removeAt(i - 1)
            }
        }
        send(prompt)
    }

    /**
     * Called when the wallet panel is dismissed. If it was opened from a paywall
     * card's "Add funds" (paywallAwaitingFunds armed) and the wallet now COVERS
     * that tiny's price, auto-continue the held turn — otherwise the user funds up
     * and stares at a stale paywall, hunting for Retry (web Cycle-92 / iOS Cycle-93
     * parity). The panel closes on ANY dismiss (funded, peeked, or cancelled), so
     * gate on the FRESH balance from GET /api/wallet: a user who just looked,
     * funded too little, or hit a fetch error keeps the card, now showing the
     * smaller shortfall (Cycle-91 copy). The composer wallet button leaves
     * paywallAwaitingFunds null, so this is a plain no-op there.
     */
    fun onWalletDismissed() {
        val msg = paywallAwaitingFunds ?: return
        paywallAwaitingFunds = null
        val pw = msg.paywall ?: return
        viewModelScope.launch {
            val res = runCatching { tinyApp.api.getJson("/api/wallet") }.getOrNull() ?: return@launch
            val bal = technology.tiny.app.wallet.WalletCore.parseLedger(res).balanceMicro
            if (bal >= pw.priceMicro) retryPaywall(msg)
        }
    }

    fun send(text: String) {
        val hasAttachments = pendingImages.isNotEmpty() || pendingDocs.isNotEmpty()
        if (text.isBlank() && !hasAttachments) return
        val prompt = text.trim()
        if (prompt.startsWith("/") && handleSlash(prompt)) return
        // A real user message stops any autonomous run + pending idle timer
        // (web: send()/typing → ambient.cancel()).
        cancelAutonomous()
        cancelIdleAmbient()
        if (!tinyApp.net.online.value) {
            // Offline: queue instead of burning the turn (iOS queuedSends parity).
            queuedSends.add(prompt)
            persistQueue()
            note("📴 offline — queued, will send when back online")
            watchForReconnect()
            return
        }
        error = null
        followups.clear()
        // Snapshot sent-attachment previews onto the user turn BEFORE the pending lists
        // are drained below — 96px thumbs + doc names keep the attachment visible in the
        // transcript (iOS thumbs/docs parity) instead of vanishing to text after send.
        val sentThumbs = pendingImages.mapNotNull { Attachments.thumbnail(it) }
        val sentDocNames = pendingDocs.map { it.name }
        messages.add(ChatMessage(role = "user", text = prompt, thumbs = sentThumbs, docNames = sentDocNames))
        val reply = ChatMessage(role = "assistant", text = "", streaming = true)
        messages.add(reply)
        // CONCURRENCY SEMANTICS — "parallel exploration with cross-visibility"
        // (web lib/chat/stream-registry.ts): sends never gate on a live stream.
        // Each turn claims its slot synchronously here, snapshots history as of
        // ITS send time, and sibling turns still streaming are INCLUDED in that
        // snapshot as annotated in-progress partials (historyText below), so
        // back-to-back questions see and may build on each other's unfinished
        // answers. Every stream accumulates into its own bubble by id, so the
        // finished transcript needs no merge step.
        liveIds.add(reply.id)
        claimedAt[reply.id] = System.currentTimeMillis()
        // Persist the question NOW, not just in the stream's finally — a process
        // death mid-stream must not lose the whole turn. loadHistory's
        // reconcileInterrupted turns the empty placeholder this writes into an
        // honest "interrupted" + Retry on the next launch.
        saveHistory()
        // Per-turn live status (iOS AgentLive.start): a silent ongoing chip tracks
        // this turn even if the screen locks mid-stream. The chip is single-slot,
        // so with concurrent turns it follows the newest one.
        technology.tiny.app.fleet.AgentLive.start(tinyApp, tiny, prompt)
        // liveIds 0→1: raise the stream guard so an in-flight reply keeps
        // foreground-service priority while the app is backgrounded. Started
        // AFTER AgentLive.start so the guard's adopted notification carries this
        // turn's tiny/prompt. Degrades gracefully (no-op + log) if this send ran
        // from the background (offline-queue drain, late voice utterance) where
        // API 31+ forbids the FGS start.
        if (liveIds.size == 1) {
            technology.tiny.app.fleet.StreamGuardService.start(tinyApp)
        }

        // Converse-shape history: user/assistant turns only, text-only, last 30,
        // blank text placeholder "…" (server rejects empty blocks) — EXCEPT
        // sibling live placeholders, which pass even when empty, wrapped as
        // in-progress partials (web buildTurnHistory parity).
        val snapshotNow = System.currentTimeMillis()
        val history = JSONArray()
        messages.dropLast(2)
            .filter { it.role == "user" || it.role == "assistant" }
            .takeLast(SEND_HISTORY)
            .forEach { m ->
                val text = historyText(
                    text = m.text,
                    isLive = liveIds.contains(m.id),
                    startedAtMs = claimedAt[m.id] ?: snapshotNow,
                    nowMs = snapshotNow,
                )
                history.put(
                    JSONObject()
                        .put("role", m.role)
                        .put("content", JSONArray().put(JSONObject().put("text", text)))
                )
            }

        // Fold any autonomous findings gathered while the user was away into this turn's
        // hidden context (web Chat.tsx consumeAmbientFindings → "🌙 Ambient thinking" note).
        val extraSystem = listOfNotNull(
            tinyApp.continuity.buildContext(tiny),
            consumeAutoFindings(tiny),
        ).joinToString("\n\n").ifBlank { null }
        val userBlocks = if (pendingImages.isNotEmpty() || pendingDocs.isNotEmpty()) {
            Attachments.blocks(prompt, pendingImages.toList(), pendingDocs.toList())
                .also { pendingImages.clear(); pendingDocs.clear() }
        } else null

        val job = viewModelScope.launch {
            // 📍 Location context (web Chat.tsx geoOn parity) — resolved inside
            // the coroutine because the fused fix is a suspend call (30s-cached,
            // 5s-bounded); toggle off / no permission → extraSystem unchanged.
            val geoBlock = technology.tiny.app.geo.Geo.contextIfEnabled(
                tinyApp, tinyApp.config.locationContext,
            )
            // 🕶️ Glasses context (location's sibling, iOS parity): one line
            // when linked, null (byte-identical request) when not.
            val glassesBlock = runCatching {
                technology.tiny.app.fleet.WearablesBridge.contextIfLinked(tinyApp)
            }.getOrNull()
            val extraWithGeo = listOfNotNull(extraSystem, geoBlock, glassesBlock)
                .joinToString("\n\n").ifBlank { null }
            try {
                tinyApp.api.chat(prompt, tiny, history, extraWithGeo, userBlocks).collect { ev ->
                    val idx = messages.indexOfLast { it.id == reply.id }
                    if (idx < 0) return@collect
                    when (ev) {
                        is ChatEvent.TextDelta ->
                            messages[idx] = messages[idx].copy(text = messages[idx].text + ev.text, toolLabel = null)
                        is ChatEvent.ReasoningDelta ->
                            messages[idx] = messages[idx].copy(reasoning = messages[idx].reasoning + ev.text)
                        is ChatEvent.BeforeToolCall -> {
                            handleClientTool(ev, idx)
                            // Capture the input onto the detail card (web sets tool.input here).
                            upsertToolCall(idx, ev.toolUseId, ev.name) { it.copy(inputJson = ev.input.toString()) }
                        }
                        is ChatEvent.ToolStart -> {
                            // Seed a "calling" detail card (web toolStart handler) + transient label.
                            upsertToolCall(idx, ev.toolUseId, ev.name) { it }
                            messages[idx] = messages[idx].copy(toolLabel = ev.name)
                            technology.tiny.app.fleet.AgentLive.tool(tinyApp, ev.name)
                        }
                        is ChatEvent.AfterToolCall -> {
                            // spawn_agents batch result flips its tree nodes to ✓/✗.
                            if (ev.name == "spawn_agents" && ev.resultText != null) {
                                val spawns = messages[idx].spawns.map {
                                    if (it.id == ev.toolUseId) it.applyResults(ev.resultText) else it
                                }
                                messages[idx] = messages[idx].copy(spawns = spawns, toolLabel = null)
                                // Reflect the fan-out result count on the live chip.
                                val tree = spawns.firstOrNull { it.id == ev.toolUseId }
                                if (tree != null) technology.tiny.app.fleet.AgentLive.spawn(
                                    tinyApp,
                                    tree.nodes.count { it.ok == true },
                                    tree.nodes.size,
                                )
                            } else {
                                messages[idx] = messages[idx].copy(toolLabel = null)
                            }
                            // Flip the detail card to ✓/✗ with its result/error (web afterToolCall).
                            upsertToolCall(idx, ev.toolUseId, ev.name) {
                                it.copy(
                                    status = if (ev.error != null) "error" else "success",
                                    resultText = ev.resultText ?: it.resultText,
                                    error = ev.error,
                                )
                            }
                        }
                        is ChatEvent.Metadata -> {
                            // Accumulate usage onto the reply (iOS .usage → msg.inTok/outTok);
                            // also carry cacheReadTok + the resolved modelId so the per-turn
                            // "~$" estimate can be shown (web parity — iOS ships no estimate).
                            if (ev.inputTokens > 0 || ev.outputTokens > 0 || ev.modelId != null) {
                                messages[idx] = messages[idx].copy(
                                    inTok = messages[idx].inTok + ev.inputTokens,
                                    outTok = messages[idx].outTok + ev.outputTokens,
                                    cacheReadTok = messages[idx].cacheReadTok + ev.cacheReadInputTokens,
                                    modelId = ev.modelId ?: messages[idx].modelId,
                                )
                            }
                        }
                        is ChatEvent.Note ->
                            messages.add(ChatMessage(role = "note", text = "⚠ ${ev.text}"))
                        is ChatEvent.Error -> {
                            // 💸 Paywall (402): a priced tiny with an unfunded/signed-out
                            // wallet. NOT a lost connection and NOT retriable as-is — render an
                            // actionable card (price, balance, Add funds, retry-once-funded)
                            // instead of the generic error+retry (web Chat.tsx isPaywall). The
                            // card owns the resend, so failedPrompt stays null (no double retry).
                            val paywall = ev.paymentBody
                                ?.let { runCatching { org.json.JSONObject(it) }.getOrNull() }
                                ?.let { technology.tiny.app.wallet.WalletCore.parsePaywall(it) }
                            val cur = messages[idx]
                            if (paywall != null) {
                                messages[idx] = cur.copy(
                                    // Drop any partial pre-charge text — a 402 fails before the
                                    // stream, so there's nothing real to keep (web replaces content).
                                    text = "",
                                    streaming = false,
                                    paywall = paywall,
                                    paywallPrompt = prompt,
                                )
                            } else {
                                // Keep the partial reply but append an honest marker and enable
                                // per-message Retry (iOS Views.swift:329-343). An error AFTER partial
                                // text must never render as if the answer completed cleanly — on
                                // screen, on reload, or when shared. failedPrompt holds the prompt.
                                val marker = "⚠️ ${ev.message}"
                                messages[idx] = cur.copy(
                                    text = if (cur.text.isBlank()) marker else cur.text + "\n\n" + marker,
                                    failedPrompt = prompt,
                                )
                            }
                        }
                        is ChatEvent.Done, is ChatEvent.Result -> {
                            messages[idx] = messages[idx].copy(
                                streaming = false,
                                toolLabel = null,
                                toolCalls = reconcileTools(messages[idx].toolCalls),
                            )
                        }
                        else -> Unit
                    }
                }
            } catch (t: Throwable) {
                // A user Stop cancels streamJob → CancellationException; stop() already
                // wrote the honest un-streaming state, so don't clobber it with a scary
                // error + Retry (iOS Views.swift:346-364 guards on CancellationError).
                if (t is kotlinx.coroutines.CancellationException) throw t
                val idx = messages.indexOfLast { it.id == reply.id }
                if (idx >= 0) {
                    // Transport dropped (cell handoff, tunnel, flaky Wi-Fi — the common
                    // mobile case). Mirror the SSE .error branch: keep any partial text,
                    // append an honest marker, enable Retry. Don't leave a truncated
                    // answer looking complete.
                    val marker = "⚠️ ${t.message ?: "connection lost"}"
                    val cur = messages[idx]
                    messages[idx] = cur.copy(
                        text = if (cur.text.isBlank()) marker else cur.text + "\n\n" + marker,
                        failedPrompt = prompt,
                    )
                }
            } finally {
                // The LAST live stream is ending — drop the stream guard BEFORE
                // AgentLive.finish() below. While foregrounded the guard OWNS
                // notification id 43; stopping it first (onDestroy DETACHes a
                // still-visible chip) lets finish()'s "✓ done" linger + cancel
                // actually clear the notification instead of being pinned by an
                // active FGS. Runs on cancellation too (user Stop / stopAll),
                // where onDestroy REMOVEs the already-cancelled chip.
                if (liveIds.none { it != reply.id }) {
                    technology.tiny.app.fleet.StreamGuardService.stop(tinyApp)
                }
                val idx = messages.indexOfLast { it.id == reply.id }
                if (idx >= 0) {
                    var m = messages[idx]
                    // Stream ended with nothing to show and no error surfaced — the server
                    // returned an empty turn. Mark it retryable rather than leaving a blank
                    // bubble (iOS leaves it empty; Android surfaces the honest "no reply").
                    if (m.failedPrompt == null && m.text.isBlank() &&
                        m.speechText == null && m.uiCards.isEmpty() && m.spawns.isEmpty()
                    ) {
                        m = m.copy(text = "⚠️ no reply — try again", failedPrompt = prompt)
                    }
                    messages[idx] = m.copy(
                        streaming = false,
                        toolLabel = null,
                        toolCalls = reconcileTools(m.toolCalls),
                    )
                    // A cleanly-landed turn (no failedPrompt) with real text feeds the
                    // continuity log + widgets. A failed/errored turn is excluded — its
                    // marker text must not masquerade as an answer (iOS gates both on
                    // reply.failedPrompt == nil; Views.swift:377-395).
                    if (m.failedPrompt == null && m.text.isNotBlank()) {
                        tinyApp.continuity.appendTurn(tiny, prompt, m.text)
                        if (tiny == "tiny") {
                            technology.tiny.app.widget.WidgetBridge.publishExchange(
                                tinyApp, prompt, m.text,
                                tinyApp.continuity.loadMemories(tiny).map { it.content },
                            )
                        }
                    }
                    // Close the live chip (iOS AgentLive.finish). A user Stop cancels
                    // the coroutine → isActive is false → stop() already cleared it, so
                    // don't re-post a "done". failedPrompt marks a failed/errored turn.
                    // The chip is single-slot: only the LAST live stream closes it —
                    // a sibling still streaming keeps it up.
                    if (this.isActive && liveIds.none { it != reply.id }) {
                        val failed = m.failedPrompt != null
                        technology.tiny.app.fleet.AgentLive.finish(
                            tinyApp, error = failed, preview = if (failed) null else m.text,
                        )
                    }
                }
                // Release THIS stream's claim; per-stream work (above + saveHistory)
                // always runs, only-when-idle work runs on the last release —
                // applyPendingManage does transcript surgery that would shift the
                // indices a sibling stream is still writing under.
                liveIds.remove(reply.id)
                claimedAt.remove(reply.id)
                if (liveIds.isEmpty()) applyPendingManage()
                saveHistory()
                if (liveIds.isEmpty()) {
                    val next = queuedSends.removeFirstOrNull()
                    if (next != null) { persistQueue(); send(next) } else armIdleAmbient()
                }
            }
        }
        streamJobs[reply.id] = job
        job.invokeOnCompletion { streamJobs.remove(reply.id) }
    }

    // ── Inline voice-call turns (docs/voice-sessions-design.md, inline-chat) ──
    // A live 📞 call writes straight into THIS thread: every spoken/typed user
    // turn and every assistant reply becomes a real ChatMessage — visible
    // immediately, persisted to the same per-tiny history file, and logged to
    // Continuity so the agent remembers the call like any chat (iOS
    // Views.swift voiceUserSaid/… parity). VoiceCall's hooks fire on the
    // OkHttp WS READER THREAD and `messages` is Compose state that must only
    // be mutated on main, so every method hops via
    // viewModelScope.launch(Dispatchers.Main.immediate) — immediate keeps the
    // composer's typed-text path (already on main) synchronous, and posts from
    // the reader thread preserve per-dispatcher FIFO order.
    private var voiceReplyId: String? = null
    private var voiceLastUser = ""

    /** A user utterance was transcribed (or typed mid-call) — append it. */
    fun voiceUserSaid(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        viewModelScope.launch(Dispatchers.Main.immediate) {
            voiceLastUser = t
            messages.add(ChatMessage(role = "user", text = t))
            saveHistory()
        }
    }

    /** A fresh assistant voice turn began — open its bubble in the thread. */
    fun voiceAssistantStarted() {
        viewModelScope.launch(Dispatchers.Main.immediate) { openVoiceReply() }
    }

    // NOT streaming=true: the voice bubble accretes transcript deltas but has
    // no stream job / stop affordance behind it — it renders as a normal
    // assistant bubble that simply grows (iOS appends a plain ChatMessage too).
    private fun openVoiceReply(): String {
        val m = ChatMessage(role = "assistant", text = "")
        voiceReplyId = m.id
        messages.add(m)
        return m.id
    }

    /** A transcript delta for the current assistant voice turn. */
    fun voiceAssistantDelta(delta: String) {
        if (delta.isEmpty()) return
        viewModelScope.launch(Dispatchers.Main.immediate) {
            // Recreate the bubble if the turn never opened (or /clear ate it).
            var idx = voiceReplyId?.let { id -> messages.indexOfLast { it.id == id } } ?: -1
            if (idx < 0) {
                val id = openVoiceReply()
                idx = messages.indexOfLast { it.id == id }
            }
            messages[idx] = messages[idx].copy(text = messages[idx].text + delta)
        }
    }

    /** The assistant voice turn finished (or was barged over) — finalize. */
    fun voiceAssistantDone() {
        viewModelScope.launch(Dispatchers.Main.immediate) {
            val id = voiceReplyId ?: return@launch
            voiceReplyId = null
            val idx = messages.indexOfLast { it.id == id }
            if (idx < 0) return@launch
            if (messages[idx].text.isEmpty() && messages[idx].uiCards.isEmpty()) {
                // Nothing visible landed (barged-before-speaking) — no empty
                // bubble. A render_ui-only turn KEEPS its bubble (iOS parity).
                messages.removeAt(idx)
                return@launch
            }
            saveHistory()
            if (messages[idx].text.isNotEmpty()) {
                tinyApp.continuity.appendTurn(tiny, voiceLastUser, messages[idx].text)
            }
            voiceLastUser = ""
        }
    }

    /** Voice-bridge render_ui: attach a native card to the live voice bubble
     *  (opens one if the tiny renders without narrating) — same UiCard the
     *  chat stream's render_ui path builds; componentCode is never evaluated. */
    fun voiceRenderUi(input: org.json.JSONObject) {
        viewModelScope.launch(Dispatchers.Main.immediate) {
            if (voiceReplyId == null) voiceAssistantStarted()
            val id = voiceReplyId ?: return@launch
            val idx = messages.indexOfLast { it.id == id }
            if (idx < 0) return@launch
            val props = input.optJSONObject("props") ?: org.json.JSONObject()
            val card = UiCard(input.optString("title").takeIf { it.isNotEmpty() }, props.toString())
            messages[idx] = messages[idx].copy(uiCards = messages[idx].uiCards + card)
            saveHistory()
        }
    }

    /** Slash commands (iOS parity subset). Returns true when consumed locally. */
    private fun handleSlash(cmd: String): Boolean {
        val parts = cmd.removePrefix("/").split(Regex("\\s+"), limit = 2)
        when (parts[0].lowercase()) {
            "clear" -> {
                // Wipes the conversation + persists — the turns are gone. Web gates this
                // behind confirm("Clear conversation history?") (Chat.tsx:1878); mirror that
                // with a real AlertDialog (ChatScreen observes confirmClear). `/clear confirm`
                // still skips the dialog for power users / muscle memory (matches /forgetall).
                val confirmed = parts.getOrNull(1)?.trim()?.equals("confirm", ignoreCase = true) == true
                if (confirmed) clear() else confirmClear = true
            }
            "help" -> note(
                "/clear · /tiny <name> · /auto <task> · /loop [5m] <prompt> · /share · /shares · /tools [mine|browse|install|rm|trust|untrust] · /toolbox · /telegram [status|setup|allow|pause|resume|remove] · /export · /save · /load [id] · /archives · /sessions · /cost · /wallet [deposit|link <0x…>|claim <tx>|withdraw <usd>] · /price [<usd>|tiny <name> <usd>|tool <name> <usd>] · /memory · /graph · /messages · /jobs · /nearby · /activity · /devices · /universe · /settings · /forgetall · /help"
            )
            "cost" -> costSummary()
            // /loop [Nm|Nh] <prompt> — a recurring background job on the worker
            // scheduler (Claude Code /loop ergonomics). No interval → every 5m.
            // Runs NEVER touch this chat: results land on the ⚡ activity bus +
            // push, history in ⏰ /jobs — observable without interfering. Up to
            // 10 concurrent loops (worker MAX_JOBS_PER_USER, shared with jobs).
            "loop" -> {
                val rest = parts.getOrNull(1)?.trim().orEmpty()
                if (rest.isEmpty()) {
                    note("usage: /loop [5m|30m|2h] <prompt> — runs the prompt on a schedule in the background. Results: ⚡ activity + push · history: ⏰ /jobs · remove: /jobs → delete")
                    return true
                }
                val tokens = rest.split(Regex("\\s+"), limit = 2)
                val interval = Regex("^(\\d{1,4})(m|h)?$").matchEntire(tokens[0].lowercase())
                val (schedule, loopPrompt) = if (interval != null && tokens.size == 2) {
                    val n = interval.groupValues[1].toInt().coerceAtLeast(1)
                    val unit = interval.groupValues[2].ifEmpty { "m" }
                    "*/$n$unit" to tokens[1].trim()
                } else {
                    "*/5m" to rest // bare "/loop check my PRs" → every 5 minutes
                }
                createLoop(schedule, loopPrompt)
            }
            "wallet" -> {
                val rest = parts.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+"), limit = 2)
                when (rest.firstOrNull()?.lowercase()) {
                    null, "", "balance", "summary" -> walletSummary()
                    "deposit", "fund", "topup", "top-up" -> walletDepositInfo()
                    "link" -> {
                        val addr = rest.getOrNull(1)?.trim().orEmpty()
                        if (addr.isEmpty()) note("usage: /wallet link <0x…> — your sending address (becomes your withdrawal destination too)")
                        else walletLinkAddress(addr)
                    }
                    "claim" -> {
                        val arg = rest.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+"), limit = 2)
                        val txHash = arg.getOrNull(0).orEmpty()
                        if (txHash.isEmpty()) note("usage: /wallet claim <0x-tx-hash> [base|base-sepolia] — after you've sent USDC to the deposit address")
                        else walletClaim(txHash, arg.getOrNull(1)?.trim())
                    }
                    "withdraw", "cashout", "payout" -> {
                        // Tail tokens after the amount: an optional network and/or the literal
                        // "confirm" (order-independent) — withdrawing real USDC is irreversible,
                        // so it's a two-step confirm like web's danger dialog (wallet/page.tsx:145).
                        val tail = rest.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+")).filter { it.isNotEmpty() }
                        val amount = tail.getOrNull(0).orEmpty()
                        val flags = tail.drop(1)
                        val confirmed = flags.any { it.equals("confirm", ignoreCase = true) }
                        val network = flags.firstOrNull { !it.equals("confirm", ignoreCase = true) }
                        if (amount.isEmpty()) note("usage: /wallet withdraw <usd> [base|base-sepolia] — e.g. /wallet withdraw 5.00 (min \$1, \$0.10 fee)")
                        else walletWithdraw(amount, network, confirmed)
                    }
                    else -> note("usage: /wallet [balance|deposit|link <0x…>|claim <tx> [network]|withdraw <usd> [network]]")
                }
            }
            "price" -> {
                val rest = parts.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+"), limit = 3)
                    .filter { it.isNotEmpty() }
                when (rest.firstOrNull()?.lowercase()) {
                    // /price tool <name> [<usd>] — price/inspect a forged tool (one-time install)
                    "tool" -> {
                        val name = rest.getOrNull(1)?.trim().orEmpty()
                        if (name.isEmpty()) { note("usage: /price tool <name> [<usd>] — e.g. /price tool weather 0.05 (0 = free)"); return true }
                        val login = tinyApp.auth.login?.takeIf { it.isNotEmpty() }
                            ?: run { note("🔑 sign in first — pricing needs an authenticated owner"); return true }
                        val resource = "tool:$login/${name.removePrefix("my_")}"
                        val label = "tool my_${name.removePrefix("my_")}"
                        val usd = rest.getOrNull(2)
                        if (usd == null) walletShowPrice(resource, label) else walletSetPrice(resource, label, usd, oneTime = true)
                    }
                    // /price tiny <name> [<usd>] — price/inspect a named tiny (per message)
                    "tiny" -> {
                        val name = rest.getOrNull(1)?.trim().orEmpty()
                        if (name.isEmpty()) { note("usage: /price tiny <name> [<usd>] — e.g. /price tiny scout 0.01 (0 = free)"); return true }
                        val slug = slugify(name)
                        if (slug.isEmpty()) { note("⚠ that name has no usable slug"); return true }
                        val usd = rest.getOrNull(2)
                        if (usd == null) walletShowPrice("tiny:$slug", slug) else walletSetPrice("tiny:$slug", slug, usd, oneTime = false)
                    }
                    // bare /price → show current tiny's price · /price <usd> → set it (0 = free)
                    null, "" -> walletShowPrice("tiny:$tiny", tiny)
                    else -> walletSetPrice("tiny:$tiny", tiny, rest[0], oneTime = false)
                }
            }
            "telegram" -> {
                val rest = parts.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+"), limit = 2)
                when (rest.firstOrNull()?.lowercase()) {
                    null, "", "status" -> telegramStatus()
                    "setup", "connect" -> {
                        val token = rest.getOrNull(1)?.trim().orEmpty()
                        if (token.isEmpty()) note("usage: /telegram setup <bot-token> — get one from @BotFather")
                        else telegramSetup(token)
                    }
                    "allow" -> {
                        val chatId = rest.getOrNull(1)?.trim().orEmpty()
                        if (chatId.isEmpty()) note("usage: /telegram allow <chat-id>") else telegramAllow(chatId)
                    }
                    "pause", "disable" -> telegramSetEnabled(false)
                    "resume", "enable" -> telegramSetEnabled(true)
                    "remove", "disconnect" -> {
                        // Removes the bot token — conversations on Telegram stop. Web gates
                        // this behind a danger confirm (TelegramSettings.tsx:123); require a
                        // "confirm" token here (same idiom as /forgetall, /clear, withdraw).
                        val confirmed = rest.getOrNull(1)?.trim()?.equals("confirm", ignoreCase = true) == true
                        if (!confirmed) note("⚠️ this disconnects your Telegram bot and stops conversations there — re-run as /telegram remove confirm to proceed")
                        else telegramRemove()
                    }
                    else -> note("usage: /telegram [status|setup <token>|allow <chat-id>|pause|resume|remove]")
                }
            }
            "auto" -> {
                val task = parts.getOrNull(1)?.trim().orEmpty()
                if (task.isEmpty()) note("usage: /auto <task> — e.g. /auto research edge caching strategies")
                else startAutonomous(task)
            }
            "share" -> shareConversation()
            "shares" -> {
                val rest = parts.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+"), limit = 2)
                if (rest.firstOrNull()?.lowercase() == "revoke") {
                    val id = rest.getOrNull(1)?.trim().orEmpty()
                    if (id.isEmpty()) note("usage: /shares revoke <id>") else revokeShare(id)
                } else listShares()
            }
            "tools" -> {
                val rest = parts.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+"), limit = 2)
                when (rest.firstOrNull()?.lowercase()) {
                    null, "", "trusted", "list" -> listTrusted() // bare /tools → trusted owners (web parity)
                    "browse" -> browseTools(rest.getOrNull(1)?.trim().orEmpty())
                    "mine", "box", "forged" -> listMyTools() // my forged toolbox (GET /api/tools)
                    "rm", "remove", "delete" -> {
                        val name = rest.getOrNull(1)?.trim().orEmpty()
                        if (name.isEmpty()) note("usage: /tools rm <name>") else deleteMyTool(name)
                    }
                    "install" -> {
                        val a = rest.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+"), limit = 2)
                        val login = a.getOrNull(0)?.trim().orEmpty()
                        val name = a.getOrNull(1)?.trim().orEmpty()
                        if (login.isEmpty() || name.isEmpty()) note("usage: /tools install <github-login> <tool-name>")
                        else installTool(login, name)
                    }
                    "trust" -> {
                        val owner = rest.getOrNull(1)?.trim().orEmpty()
                        if (owner.isEmpty()) note("usage: /tools trust <github-owner>") else trustOwner(owner)
                    }
                    "untrust" -> {
                        val owner = rest.getOrNull(1)?.trim().orEmpty()
                        if (owner.isEmpty()) note("usage: /tools untrust <github-owner>") else untrustOwner(owner)
                    }
                    else -> browseTools(parts.getOrNull(1)?.trim().orEmpty()) // treat "/tools <query>" as browse
                }
            }
            "export" -> exportConversation()
            "save" -> saveArchive()
            "load" -> {
                val id = parts.getOrNull(1)?.trim().orEmpty()
                if (id.isEmpty()) listArchives() else loadArchive(id)
            }
            "archives" -> {
                val rest = parts.getOrNull(1)?.trim().orEmpty().split(Regex("\\s+"), limit = 2)
                if (rest.firstOrNull()?.lowercase() == "delete") {
                    val id = rest.getOrNull(1)?.trim().orEmpty()
                    if (id.isEmpty()) note("usage: /archives delete <id>") else deleteArchive(id)
                } else listArchives()
            }
            "tiny" -> {
                val name = parts.getOrNull(1)?.trim().orEmpty()
                if (name.isEmpty()) note("current tiny: $tiny — usage: /tiny <name>")
                else { switchTiny(name); note("switched to $name") }
            }
            "forgetall" -> {
                // Wipes ALL memories + the turn log for this tiny — irreversible. Web
                // gates it behind confirm("Wipe ALL memories and the turn log for this
                // tiny? This can't be undone.") (Chat.tsx:1602); the chat surface has no
                // modal, so require an explicit "confirm" token (same idiom as /wallet
                // withdraw c83). First call previews; only the confirmed call wipes.
                val confirmed = parts.getOrNull(1)?.trim()?.equals("confirm", ignoreCase = true) == true
                if (!confirmed) {
                    note("⚠️ this wipes ALL memories + the turn log for $tiny and can't be undone — re-run as /forgetall confirm to proceed")
                } else {
                    tinyApp.continuity.clearMemories(tiny)
                    tinyApp.continuity.clearTurns(tiny)
                    note("🧹 memories + turn log wiped for $tiny")
                }
            }
            "toolbox" -> openPanel = "toolbox"
            // Both aliases open the memory panel — iOS `runSlashCommand` treats
            // `/memory` and `/memories` identically (case "memory", "memories"),
            // and web recognizes both too; without the plural, `/memories` fell
            // through to the agent as literal text. The panel is richer than web's
            // clipboard-copy, so we follow the iOS idiom for both.
            "memory", "memories" -> openPanel = "memory"
            "graph" -> openPanel = "graph"
            "messages" -> openPanel = "messages"
            "jobs" -> openPanel = "jobs"
            "sessions" -> openPanel = "sessions"
            "nearby" -> openPanel = "nearby"
            "map" -> openPanel = "map"
            "activity" -> openPanel = "activity"
            // The chain the wallet's money actually moves on. `/wallet` answers "how
            // much"; this answers "on what" — which chain, whether the node agrees
            // with our config, and where the credit came from.
            "chain" -> openPanel = "chain"
            "universe" -> openPanel = "universe"
            "devices" -> openPanel = "devices"
            "settings" -> openPanel = "settings"
            else -> return false // unknown slash → send to the agent as-is
        }
        return true
    }

    /**
     * /loop backend: create a recurring job via the session-authed POST
     * /api/jobs proxy (worker scheduler fires it through the chat pipeline
     * with the server key; results → activity events + push, never this
     * transcript). Named "loop: <prompt head>" so it reads as a loop in
     * /jobs next to agent-scheduled jobs.
     */
    private fun createLoop(schedule: String, prompt: String) {
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson(
                    "/api/jobs",
                    JSONObject()
                        .put("tiny", tiny)
                        .put("name", "loop: ${prompt.take(40)}")
                        .put("prompt", prompt)
                        .put("schedule", schedule),
                )
            }.getOrNull()
            val status = res?.optInt("_status", 0) ?: 0
            when {
                res != null && status < 400 ->
                    note("🔁 loop armed — $schedule as $tiny: \"${prompt.take(60)}\" · results land in ⚡ activity + push · watch/remove in ⏰ /jobs")
                status == 429 -> note("⚠️ loop limit reached — up to 10 jobs+loops; remove one in /jobs first")
                else -> note("⚠️ couldn't create the loop — try again")
            }
        }
    }

    private fun note(text: String) {
        messages.add(ChatMessage(role = "note", text = text))
    }

    /** /cost — session token total across assistant turns (web Chat.tsx:1417 parity). */
    private fun costSummary() {
        val withUsage = messages.filter { it.role == "assistant" && (it.inTok + it.outTok) > 0 }
        if (withUsage.isEmpty()) { note("no token usage recorded this session yet"); return }
        val inTok = withUsage.sumOf { it.inTok }
        val outTok = withUsage.sumOf { it.outTok }
        val total = inTok + outTok
        // Sum the per-turn list-price estimates; only turns whose model is in the
        // pricing table contribute (web /cost: "~$X (priced/total turns)").
        var usd = 0.0; var priced = 0
        withUsage.forEach { m ->
            ModelPricing.estimateCost(m.modelId, m.inTok, m.outTok, m.cacheReadTok)?.let { usd += it; priced++ }
        }
        val totalStr = if (total >= 1000) String.format(java.util.Locale.US, "%.1fK", total / 1000.0) else "$total"
        val costStr = if (priced > 0) {
            " · ~${ModelPricing.formatCost(usd)}" +
                if (priced < withUsage.size) " (${priced}/${withUsage.size} turns priced)" else ""
        } else ""
        note("📊 ${withUsage.size} turn${if (withUsage.size == 1) "" else "s"} · $totalStr tok ($inTok in / $outTok out)$costStr")
    }

    // -- wallet: /wallet — balance + recent ledger (web app/wallet/page.tsx read path).
    // GET /api/wallet (session) → {ok, balance_micro, history:[{delta_micro, kind, ref?,
    // counterparty?, created?(unix s)}]}, history capped 50 newest-first. Unit is
    // micro-USDC: 1_000_000 = $1.00 (USDC's 6-decimal base unit). No polling — the web
    // page fetches on open + after each mutation; here it's on-demand per /wallet.
    // Deposit/withdraw (link-address → tx-hash claim → viem payout) is a large separate
    // crypto surface, deferred; this mirrors the balance card + activity list, which is
    // already more than iOS ships (iOS only maps a 402 to a "top up at /wallet" string).

    /**
     * micro-USDC → "$1.23" (2–6 fraction digits, trailing zeros trimmed past
     * cents, comma-grouped past $1,000). Delegates to [WalletCore.usd] so the two
     * money formatters CAN'T drift — they were maintained as byte-identical copies
     * and the grouping fix (iOS/web parity) had to land in both; one source now.
     */
    private fun usd(micro: Long): String = technology.tiny.app.wallet.WalletCore.usd(micro)

    private val walletKindLabels = mapOf(
        "deposit" to "deposit", "admin_credit" to "credit", "invoke_debit" to "spent",
        "invoke_credit" to "earned", "platform_fee" to "fee", "withdrawal" to "withdrawal",
        "refund" to "refund",
    )

    /** /wallet — balance + recent activity (GET /api/wallet). */
    private fun walletSummary() {
        if (!tinyApp.auth.isLoggedIn) { note("🔑 sign in first — your wallet lives on your account"); return }
        note("💰 checking your tiny wallet…")
        viewModelScope.launch {
            val res = runCatching { tinyApp.api.getJson("/api/wallet") }.getOrNull()
            if (res?.optBoolean("ok") != true) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't load your wallet"}")
                return@launch
            }
            val balance = res.optLong("balance_micro", 0L)
            val history = res.optJSONArray("history")
            val lines = (0 until minOf(history?.length() ?: 0, 10)).mapNotNull { i ->
                history?.optJSONObject(i)?.let { o ->
                    val delta = o.optLong("delta_micro", 0L)
                    val kind = walletKindLabels[o.optString("kind")] ?: o.optString("kind")
                    val sign = if (delta >= 0) "+" else "-"
                    "$sign${usd(kotlin.math.abs(delta))}  $kind"
                }
            }
            val body = buildString {
                append("💰 balance ").append(usd(balance)).append(" (tiny credits, micro-USDC)")
                if (lines.isNotEmpty()) {
                    append("\n\nrecent activity:\n").append(lines.joinToString("\n"))
                }
                append("\n\n/wallet deposit to add funds · /wallet withdraw <usd> to cash out")
            }
            note(body)
        }
    }

    // -- wallet deposit/withdraw crypto surface (web app/wallet/page.tsx flow).
    // The read path above is cycle 30; this adds the funding/payout half as slash
    // subcommands (iOS has NONE of this — only a 402→"top up at /wallet" string).
    // Contract (POST /api/wallet actions + POST /api/wallet/withdraw, session-gated):
    //   deposit_info → {ok, configured, deposit_address, default_network, linked_address, min_confirmations}
    //   link_address {address ^0x[40hex]} → {ok, address}   (re-link overwrites; one addr/user)
    //   claim {txHash ^0x[64hex], network?} → {ok, credited_micro, confirmations} | 425 {error, retry:true}
    //   withdraw {amount_micro, network?} → {ok, net_micro, fee_micro, explorer}  (dest = linked addr, forced)
    // Networks: "base" (real USDC, default) | "base-sepolia" (trial, $1 lifetime cap, NOT withdrawable).

    private val ADDR_RE = Regex("^0x[0-9a-fA-F]{40}$")
    private val TXHASH_RE = Regex("^0x[0-9a-fA-F]{64}$")

    /** Free-text network → the worker's canonical id. Delegates to the ONE tested copy
     *  in WalletCore rather than keeping a hand-synced duplicate here — a second
     *  byte-identical `when` was the exact drift hazard the web side just locked with a
     *  parity test (bca8e92: three hand-maintained network tables that "MUST match" but
     *  nothing enforced it). The WalletCore copy is public + covered by WalletCoreTest;
     *  routing the live call sites through it means there's no untested twin to diverge. */
    private fun normNetwork(raw: String?): String? =
        technology.tiny.app.wallet.WalletCore.normNetwork(raw)

    /** /wallet deposit — show the platform deposit address + how to fund (POST deposit_info). */
    private fun walletDepositInfo() {
        if (!tinyApp.auth.isLoggedIn) { note("🔑 sign in first — your wallet lives on your account"); return }
        note("💳 fetching deposit details…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson("/api/wallet", JSONObject().put("action", "deposit_info"))
            }.getOrNull()
            if (res?.optBoolean("ok") != true) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't load deposit info"}")
                return@launch
            }
            if (!res.optBoolean("configured")) {
                note("💳 USDC deposits are rolling out — not enabled on this deployment yet."); return@launch
            }
            val depositAddr = res.optString("deposit_address").takeIf { it.isNotEmpty() }
            val linked = res.optString("linked_address").takeIf { it.isNotEmpty() && it != "null" }
            val network = res.optString("default_network", "base")
            val confs = res.optInt("min_confirmations", 3)
            val body = buildString {
                append("💳 fund your tiny wallet with USDC on ").append(network).append(":\n")
                if (linked == null) {
                    append("\n1. link your sending address first:\n   /wallet link <0x…>")
                    append("\n   (it also becomes your withdrawal destination)")
                } else {
                    append("\n✓ linked sender: ").append(linked)
                }
                if (depositAddr != null) {
                    append("\n\n2. send USDC to the platform deposit address:\n   ").append(depositAddr)
                }
                append("\n\n3. claim it after ").append(confs).append(" confirmations:\n   /wallet claim <tx-hash>")
                append("\n\nno USDC yet? buy on Coinbase, MoonPay, or bridge.base.org; free testnet USDC at faucet.circle.com (claim with network base-sepolia, \$1 trial cap).")
            }
            note(body)
        }
    }

    /** /wallet link <addr> — bind your sending/withdrawal address (POST link_address). */
    private fun walletLinkAddress(address: String) {
        if (!tinyApp.auth.isLoggedIn) { note("🔑 sign in first"); return }
        if (!ADDR_RE.matches(address)) { note("⚠ that's not a valid 0x address (40 hex chars)"); return }
        note("🔗 linking $address…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson("/api/wallet", JSONObject().put("action", "link_address").put("address", address))
            }.getOrNull()
            if (res?.optBoolean("ok") != true) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't link that address"}")
                return@launch
            }
            note("✓ address linked: ${res.optString("address", address)}\nsend USDC on Base, then /wallet claim <tx-hash>.")
        }
    }

    /** /wallet claim <txHash> [network] — credit an on-chain USDC deposit (POST claim). */
    private fun walletClaim(txHash: String, network: String?) {
        if (!tinyApp.auth.isLoggedIn) { note("🔑 sign in first"); return }
        if (!TXHASH_RE.matches(txHash)) { note("⚠ that's not a valid tx hash (66 chars, 0x + 64 hex)"); return }
        note("🔎 verifying deposit on-chain…")
        viewModelScope.launch {
            val payload = JSONObject().put("action", "claim").put("txHash", txHash)
            normNetwork(network)?.let { payload.put("network", it) }
            val res = runCatching { tinyApp.api.postJson("/api/wallet", payload) }.getOrNull()
            if (res == null) { note("⚠ couldn't reach the wallet service — try again"); return@launch }
            if (res.optBoolean("ok")) {
                if (res.optBoolean("already_credited")) { note("✓ already credited — this tx was claimed before."); return@launch }
                val credited = res.optLong("credited_micro", 0L)
                val trial = res.optBoolean("testnet_trial")
                note(buildString {
                    append("✓ credited ").append(usd(credited))
                    if (trial) append(" (testnet trial — \$1 lifetime cap, not withdrawable as real USDC)")
                    append(" · /wallet to see your balance")
                })
                return@launch
            }
            val err = res.optString("error").takeIf { it.isNotEmpty() } ?: "claim failed"
            // 425 carries retry:true — deposit seen but needs more confirmations.
            val suffix = if (res.optBoolean("retry") || res.optInt("_status") == 425) " — try again in a minute" else ""
            note("⚠ $err$suffix")
        }
    }

    /** /wallet withdraw <usd> [network] [confirm] — pay out to the linked address (POST /api/wallet/withdraw). */
    private fun walletWithdraw(amount: String, network: String?, confirmed: Boolean) {
        if (!tinyApp.auth.isLoggedIn) { note("🔑 sign in first"); return }
        val usd = amount.removePrefix("$").trim().toDoubleOrNull()
        if (usd == null || usd <= 0) { note("⚠ enter a dollar amount, e.g. /wallet withdraw 5.00"); return }
        if (usd < 1.0) { note("⚠ minimum withdrawal is \$1"); return }
        val amountMicro = Math.round(usd * 1_000_000)
        // Withdrawing sends real USDC on-chain — instant and irreversible. Web gates it
        // behind a danger confirm dialog (wallet/page.tsx:145); mirror that as a two-step
        // chat confirm so a fat-fingered "/wallet withdraw 50" can't move money by accident.
        if (!confirmed) {
            val net = network?.let { "on ${normNetwork(it) ?: it} " } ?: ""
            note(
                "⚠️ withdraw ${usd(amountMicro)} ${net}to your linked address? this is instant and can't be undone " +
                    "(a flat \$0.10 fee covers gas).\n\nto send, run:\n/wallet withdraw $amount${network?.let { " $it" } ?: ""} confirm",
            )
            return
        }
        note("💸 sending ${usd(amountMicro)} to your linked address…")
        viewModelScope.launch {
            val payload = JSONObject().put("amount_micro", amountMicro)
            normNetwork(network)?.let { payload.put("network", it) }
            val res = runCatching { tinyApp.api.postJson("/api/wallet/withdraw", payload) }.getOrNull()
            // Broadcast succeeded but confirmation timed out (server returns 202,
            // ok:false, pending_confirmation:true and WITHHELD the refund on purpose —
            // the transfer is in the mempool and will likely land). This is NOT a
            // failure: styling it ⚠ and dropping the explorer link (as the generic
            // branch below did) both scares the user and invites a double-spend retry.
            // Mirror web (wallet/page.tsx:218) + iOS (Wallet.swift:592): neutral ⏳
            // "on its way, don't retry" + the explorer link to watch it confirm.
            if (res?.optBoolean("pending_confirmation") == true) {
                val explorer = res.optString("explorer").takeIf { it.isNotEmpty() }
                note(buildString {
                    append("⏳ sent — confirming on-chain. don't retry; it'll settle shortly")
                    explorer?.let { append("\n").append(it) }
                })
                return@launch
            }
            if (res?.optBoolean("ok") != true) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "withdrawal failed"}")
                return@launch
            }
            val net = res.optLong("net_micro", 0L)
            val fee = res.optLong("fee_micro", 0L)
            val explorer = res.optString("explorer").takeIf { it.isNotEmpty() }
            note(buildString {
                append("✓ paid — ").append(usd(net)).append(" sent on-chain (").append(usd(fee)).append(" fee)")
                explorer?.let { append("\n").append(it) }
            })
        }
    }

    // -- owner pricing: /price [<usd>] · /price tiny <name> [<usd>] · /price tool <name> [<usd>] --
    // Ports the web `set_price` agent tool + POST /api/wallet {action:set_price|pricing}
    // (iOS has NO pricing surface). Owners monetize what they OWN: a tiny per-message, or a
    // forged tool as a one-time install. Contract (session-gated proxy → worker /pay/price):
    //   set: POST {action:set_price, resource, price_micro:0..100_000_000 ($100 cap)} →
    //        {ok, resource, price_micro}; 403 "not the owner…" if you don't own it; 0 clears.
    //   show: POST {action:pricing, resource} → {ok, price_micro} (0 = free/unpriced).
    // resource is `tiny:<slug>` (per message) or `tool:<login>/<name>` (one-time). Worker
    // splits earnings: owner gets price minus a flat $0.001 platform fee.

    /**
     * slugify(name) ≈ web slugify(lower:true, strict:true): lowercase, non-alnum → '-', trim.
     * DELIBERATE APPROXIMATION (the ≈): web uses the npm `slugify` package, whose strict mode
     * TRANSLITERATES via a charmap (café→cafe, ß→ss, æ→ae) and STRIPS punctuation joining
     * adjacent alnum (a/b/c→abc, hi!@#there→hithere; tests/slug.test.ts is the contract). This
     * regex instead DROPS accents (café→caf) and DASH-REPLACES punctuation (a/b/c→a-b-c), so it
     * diverges for accented/punctuated names. Reachable via `/price tiny <accented-name>` (the
     * resource key `tiny:caf` wouldn't match a worker-stored `tiny:cafe`). Not fixed here: a
     * faithful match needs the npm charmap (not stdlib-achievable — even NFD accent-stripping
     * still diverges on A_B-c and the charmap entries), and this is a client-only surface (iOS
     * has no pricing UI) where the common ASCII case ("scout", "My Support Bot") is already
     * identical. Watch-item: if web/iOS ever surface a shared client-side slugger, revisit.
     */
    private fun slugify(name: String): String =
        name.trim().lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')

    /** /price … <usd> — set or clear a price (POST set_price). usd 0 makes it free again. */
    private fun walletSetPrice(resource: String, label: String, usdArg: String, oneTime: Boolean) {
        if (!tinyApp.auth.isLoggedIn) { note("🔑 sign in first — pricing requires an authenticated owner"); return }
        val usd = usdArg.removePrefix("$").trim().toDoubleOrNull()
        if (usd == null || usd < 0) { note("⚠ enter a price in USD, e.g. 0.05 (0 = free)"); return }
        if (usd > 100.0) { note("⚠ max price is \$100"); return }
        val priceMicro = Math.round(usd * 1_000_000)
        // Branch on the STORED micro value, not raw usd: a sub-micro price (e.g.
        // 0.0000004) is > 0 so a raw-value branch would say "pricing at $0.00…"
        // while Math.round(…) stores 0 = FREE — contradicting the final "is free
        // again" confirmation below. Matches web set_price (route.ts, quantize-then-
        // branch-on-priceMicro) so the two notes from one command never disagree.
        note(if (priceMicro > 0) "💸 pricing $label at ${usd(priceMicro)}…" else "💸 making $label free…")
        viewModelScope.launch {
            val payload = JSONObject().put("action", "set_price").put("resource", resource).put("price_micro", priceMicro)
            val res = runCatching { tinyApp.api.postJson("/api/wallet", payload) }.getOrNull()
            if (res?.optBoolean("ok") != true) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't set price"}")
                return@launch
            }
            val set = res.optLong("price_micro", priceMicro)
            note(if (set > 0)
                "✓ $label now costs ${usd(set)}${if (oneTime) " (one-time install)" else " per message"}.\nearnings land in /wallet, minus the flat \$0.001 fee.${x402Hint(resource)}"
            else "✓ $label is free again.")
        }
    }

    /**
     * For a PRICED tiny, the agent-payable x402 endpoint + on-chain (ERC-8004)
     * registration URL — served by the Next routes but otherwise undiscoverable
     * from the app. Surfaced on /price so an owner can share the endpoint or
     * point register_agent at the registration file (parity with the web/iOS
     * wallet's monetize card). Empty for tools — a tool install isn't an x402
     * endpoint and has no on-chain registration.
     */
    private suspend fun x402Hint(resource: String): String {
        if (!resource.startsWith("tiny:")) return ""
        val slug = resource.removePrefix("tiny:")
        // A PRIVATE tiny's x402-chat + ERC-8004 registration routes both 403
        // (registration route: app/api/erc8004/registration/[slug] line 84;
        // x402/chat gates the same way), so advertising them is a false
        // on-chain-payability claim + a register_agent that can never mint.
        // Fail CLOSED — treat an unresolvable tiny as private and suppress —
        // matching web (page.tsx) & iOS (Wallet.swift), which only surface the
        // monetize URLs for non-private tinys. Authoritative signal: POST
        // /api/tiny {name} → private (same field fetchAccent trusts).
        val probe = runCatching {
            tinyApp.api.postJson("/api/tiny", JSONObject().put("name", slug))
        }.getOrNull()
        // `private` from /api/tiny is the raw D1 integer (route forwards get.ts's
        // `private: db.private`). optBoolean(true) hands back its `true` default for
        // the integer 0, so a PUBLIC priced tiny (`private:0`) would be misread as
        // private and wrongly suppress its payable URLs. Coerce truthily, fail-closed
        // for an unresolvable/absent tiny (default true). See JsonFlags.truthyFlag.
        if (probe == null || probe.truthyFlag("private", default = true)) return ""
        return "\n\n🌐 payable by any AI agent via x402:\n" +
            "https://tiny.technology/api/x402/chat/$slug\n" +
            "🪪 register on-chain (ERC-8004):\n" +
            "https://tiny.technology/api/erc8004/registration/$slug"
    }

    /** /price [tiny|tool <name>] — show the current price (POST pricing). */
    private fun walletShowPrice(resource: String, label: String) {
        if (!tinyApp.auth.isLoggedIn) { note("🔑 sign in first — pricing requires an authenticated owner"); return }
        note("💸 checking price for $label…")
        viewModelScope.launch {
            val payload = JSONObject().put("action", "pricing").put("resource", resource)
            val res = runCatching { tinyApp.api.postJson("/api/wallet", payload) }.getOrNull()
            if (res?.optBoolean("ok") != true) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't read price"}")
                return@launch
            }
            val priceMicro = res.optLong("price_micro", 0L)
            note(if (priceMicro > 0)
                "$label costs ${usd(priceMicro)}.\n/price <usd> to change it · /price 0 to make it free.${x402Hint(resource)}"
            else "$label is free.\n/price <usd> to charge for it (owner only).")
        }
    }

    // -- telegram: /telegram [status|setup <token>|allow <id>|pause|resume|remove] --
    // Mirrors the web `telegram` agent tool (app/api/chat/route.ts:933-988) + Settings
    // panel — a CLI-shaped analog for Android. Connects a USER-OWNED BotFather bot to a
    // tiny (cron-poll model, no webhook/OAuth/deep-link). Session-authed GET/POST/DELETE
    // /api/telegram: GET → {bot:null} | {bot:{tiny, allowedChats, enabled, token(masked)}};
    // POST {token?,tiny?,allowedChats?,enabled?} send only changed fields, enabled as a
    // STRING, empty allowedChats = pairing mode → {ok,pairing}; DELETE → {ok}. iOS + web
    // both lack a slash for this (web uses the panel/agent tool); net-new for Android.

    /** /telegram — show connection status (GET /api/telegram). */
    private fun telegramStatus() {
        if (!requireLoginTools()) return
        note("✈️ checking your Telegram bot…")
        viewModelScope.launch {
            // Gate on transport/HTTP failure so an outage doesn't read as "no bot
            // connected" and send the user re-running @BotFather setup (masked-empty).
            val res = runCatching { tinyApp.api.getJson("/api/telegram") }.getOrNull()
            val httpStatus = res?.optInt("_status", 0) ?: 0
            if (res == null || httpStatus >= 400) {
                note("⚠ ${httpStatus.takeIf { it >= 400 }?.let { technology.tiny.app.net.friendlyHttpError(it) }
                    ?: "couldn't reach the Telegram service — try again"}")
                return@launch
            }
            val bot = res.optJSONObject("bot") ?: run {
                note("✈️ no Telegram bot connected.\n1) message @BotFather, /newbot → copy the token\n2) /telegram setup <token>\n3) message your bot, then /telegram allow <chat-id>")
                return@launch
            }
            val enabled = bot.optBoolean("enabled")
            val allowed = bot.optString("allowedChats")
            val status = if (!enabled) "⏸ paused" else if (allowed.isEmpty()) "🟡 pairing" else "🟢 connected"
            note(buildString {
                append("✈️ Telegram $status\nanswering as /").append(bot.optString("tiny"))
                append("\ntoken ").append(bot.optString("token"))
                if (allowed.isEmpty()) append("\n\npairing mode — message your bot, it'll reply with a chat id, then /telegram allow <id>")
                else append("\nallowed chats: ").append(allowed)
                append("\n\n/telegram [pause|resume|remove]")
            })
        }
    }

    /** /telegram setup <token> — POST {token, tiny, enabled:'true'} (first-time connect). */
    private fun telegramSetup(token: String) {
        if (!requireLoginTools()) return
        note("✈️ connecting your bot as /$tiny…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson(
                    "/api/telegram",
                    JSONObject().put("token", token).put("tiny", tiny).put("enabled", "true"),
                )
            }.getOrNull()
            if (res?.optBoolean("ok") == true) {
                note("✈️ bot connected as /$tiny — now message your bot on Telegram; it'll reply with a chat id, then /telegram allow <id> to let it answer there")
            } else {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't connect that bot — check the token from @BotFather"}")
            }
        }
    }

    /** /telegram allow <chat-id> — append to the allowlist (web tool allow_chat parity). */
    private fun telegramAllow(chatId: String) {
        if (!requireLoginTools()) return
        note("✈️ allowing chat $chatId…")
        viewModelScope.launch {
            val bot = fetchTelegramBot() ?: run {
                note("⚠ no Telegram bot connected — /telegram setup <token> first")
                return@launch
            }
            val existing = bot.optString("allowedChats").split(",").map { it.trim() }.filter { it.isNotEmpty() }
            if (existing.contains(chatId)) { note("✈️ chat $chatId is already allowed"); return@launch }
            val merged = (existing + chatId).joinToString(",")
            val res = runCatching {
                tinyApp.api.postJson(
                    "/api/telegram",
                    JSONObject().put("allowedChats", merged).put("enabled", "true"),
                )
            }.getOrNull()
            if (res?.optBoolean("ok") == true) note("✈️ chat $chatId allowed — your bot will now answer there")
            else note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't update the allowlist"}")
        }
    }

    /** /telegram pause|resume — POST {enabled:'true'|'false'}. */
    private fun telegramSetEnabled(enabled: Boolean) {
        if (!requireLoginTools()) return
        note(if (enabled) "✈️ resuming your bot…" else "✈️ pausing your bot…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson("/api/telegram", JSONObject().put("enabled", enabled.toString()))
            }.getOrNull()
            if (res?.optBoolean("ok") == true) note(if (enabled) "✈️ bot resumed" else "⏸ bot paused — it won't answer until /telegram resume")
            else note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't change bot state"}")
        }
    }

    /** /telegram remove — DELETE /api/telegram (disconnect). */
    private fun telegramRemove() {
        if (!requireLoginTools()) return
        note("🗑 disconnecting your Telegram bot…")
        viewModelScope.launch {
            val res = runCatching { tinyApp.api.deleteJson("/api/telegram") }.getOrNull()
            if (res?.optBoolean("ok") == true) note("🗑 Telegram bot disconnected")
            else note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't disconnect"}")
        }
    }

    /** GET /api/telegram → the `bot` object, or null when not connected / on error. */
    private suspend fun fetchTelegramBot(): JSONObject? {
        val res = runCatching { tinyApp.api.getJson("/api/telegram") }.getOrNull() ?: return null
        return res.optJSONObject("bot")
    }

    // -- autonomous mode: /auto <task> (web components/chat/ambient.ts startAutonomous) --
    // A client-side loop, up to 5 back-to-back silent /api/chat turns, each fed the last
    // 2000 chars of accumulated progress. Terminates on the [AMBIENT_DONE] signal, an
    // empty/error reply, the iteration cap, or user interrupt (any send). Output is NEVER
    // shown as chat — it accrues per-tiny and is injected as hidden context on the next
    // normal turn. Not metered against anything here; iOS has no equivalent (web-only).

    /** /auto <task> — start (or restart) the autonomous loop for [task]. */
    private fun startAutonomous(task: String) {
        if (busy) { note("⏳ wait for the current reply to finish before /auto"); return }
        cancelAutonomous() // a fresh /auto supersedes any running one (web cancel()+rerun)
        autoStopped = false
        autoRunning = true
        note("🤖 autonomous mode: working in the background — send anything to stop")
        autoJob = viewModelScope.launch {
            // Snapshot the tiny — a /tiny switch mid-run must not redirect this loop's
            // explores/findings to a different tiny (armIdleAmbient snapshots the same way;
            // stop() also cancels this loop on clear/switch/load, so the window is tiny).
            val t = tiny
            var context = ""
            var iters = 0
            try {
                for (iter in 1..MAX_AUTONOMOUS_ITER) {
                    if (autoStopped) break
                    val prompt = buildString {
                        append("[AUTONOMOUS MODE iteration $iter/$MAX_AUTONOMOUS_ITER — the user asked you to work on this until done; no one will reply between iterations.] ")
                        append("Task: \"").append(task.take(500)).append("\". ")
                        if (context.isNotEmpty()) {
                            append("Your progress so far:\n").append(context.takeLast(2000))
                            append("\n\nContinue the work — go deeper, don't repeat yourself. ")
                        } else append("Start working. ")
                        append("When (and only when) the task is genuinely complete, end your reply with $AMBIENT_DONE_SIGNAL on its own line.")
                    }
                    val text = tinyApp.api.exploreOnce(prompt, t, "ambient-auto-$iter-${System.currentTimeMillis()}")
                    if (autoStopped) break
                    if (text.isBlank()) break // empty/error → stop, keep partials
                    iters = iter
                    appendAutoFinding(t, iter, text.replace(AMBIENT_DONE_SIGNAL, "").trim())
                    note("🤖 autonomous: iteration $iter done")
                    if (text.contains(AMBIENT_DONE_SIGNAL)) break
                    context += "\n--- iteration $iter ---\n$text"
                }
            } finally {
                autoRunning = false
                if (iters > 0 && !autoStopped) {
                    note("🤖 autonomous run finished ($iters iteration${if (iters == 1) "" else "s"}) — findings arrive with your next message")
                }
            }
        }
    }

    /** Stop any running autonomous loop (called on a real user send). */
    private fun cancelAutonomous() {
        autoStopped = true
        autoJob?.cancel()
        autoJob = null
        autoRunning = false
    }

    private fun appendAutoFinding(tiny: String, iter: Int, text: String) {
        if (text.isEmpty()) return
        autoFindings.getOrPut(tiny) { StringBuilder() }
            .append("[auto ").append(iter).append("] ").append(text).append("\n\n")
    }

    /** Drain + clear this tiny's autonomous findings as a hidden system note (or null). */
    private fun consumeAutoFindings(tiny: String): String? {
        val buf = autoFindings.remove(tiny)?.toString()?.trim()
        if (buf.isNullOrEmpty()) return null
        return "## 🌙 Ambient thinking (you explored this while the user was away — surface anything relevant naturally):\n$buf"
    }

    // -- idle-ambient: the auto one-shot half of ambient mode (web ambient.ts poke()/run()) --

    /** Arm the 45s idle timer after a turn (web poke()). No-op past the session cap/cooldown. */
    private fun armIdleAmbient() {
        cancelIdleAmbient()
        if (autoRunning) return // an explicit /auto run owns the background; don't also idle-fire
        val t = tiny
        if ((ambientCount[t] ?: 0) >= AMBIENT_MAX_PER_SESSION) return
        if (android.os.SystemClock.elapsedRealtime() < (ambientCooldownUntil[t] ?: 0L)) return
        // Need an existing topic — the last user turn (web getLastTopic()).
        val topic = messages.lastOrNull { it.role == "user" && it.text.isNotBlank() }?.text ?: return
        idleJob = viewModelScope.launch {
            kotlinx.coroutines.delay(AMBIENT_IDLE_MS)
            runIdleAmbient(t, topic)
        }
    }

    /** Cancel a pending/queued idle exploration (web cancel(), on any user activity). */
    private fun cancelIdleAmbient() {
        idleJob?.cancel()
        idleJob = null
    }

    /** Fire ONE silent background turn on [topic] (web run()); findings share the auto buffer. */
    private suspend fun runIdleAmbient(t: String, topic: String) {
        if (busy) return // a turn started in the meantime — skip this round (web re-pokes)
        // Meter BEFORE the call so a hung/failed run still counts against the cap (web explore(meter=true)).
        ambientCount[t] = (ambientCount[t] ?: 0) + 1
        ambientCooldownUntil[t] = android.os.SystemClock.elapsedRealtime() + AMBIENT_COOLDOWN_MS
        val prompt = buildString {
            append("[AMBIENT MODE — the user is idle; you are thinking in the background. No one will reply.] ")
            append("Their last topic was: \"").append(topic.take(500)).append("\". ")
            append("Explore ONE useful angle they haven't considered — a risk, a better approach, a concrete next step. ")
            append("Under 120 words, no questions, no greetings. This will be shown to them as background thinking when they return.")
        }
        val text = tinyApp.api.exploreOnce(prompt, t, "ambient-idle-${System.currentTimeMillis()}")
        if (text.isNotBlank()) {
            autoFindings.getOrPut(t) { StringBuilder() }
                .append("[idle] ").append(text.trim()).append("\n\n")
        }
    }

    /** /export — client-side markdown → system share sheet (web /export parity). */
    private fun exportConversation() {
        val turns = messages.filter { (it.role == "user" || it.role == "assistant") && it.text.isNotBlank() }
        if (turns.isEmpty()) { note("nothing to export yet"); return }
        val md = Sharing.exportMarkdown(tiny, turns)
        Sharing.shareMarkdownFile(tinyApp, Sharing.exportFilename(tiny), md)
        note("📄 exported as markdown")
    }

    /** /share — POST /api/share (anonymous) → URL, copy + system share sheet. */
    private fun shareConversation() {
        if (busy) { note("⏳ wait for the reply to finish before sharing"); return }
        // Drop failed/errored turns — a public share must not carry a "⚠️ …" marker
        // as if it were an answer (iOS shareConversation guards failedPrompt == nil).
        val turns = messages.filter {
            (it.role == "user" || it.role == "assistant") && it.text.isNotBlank() && it.failedPrompt == null
        }
        if (turns.isEmpty()) { note("no messages to share yet"); return }
        note("creating share link…")
        viewModelScope.launch {
            val payload = JSONArray()
            turns.forEach { m ->
                payload.put(
                    JSONObject().put("id", m.id).put("role", m.role).put("content", m.text),
                )
            }
            val res = runCatching {
                tinyApp.api.postJson("/api/share", JSONObject().put("name", tiny).put("messages", payload))
            }.getOrNull()
            val url = res?.optString("url")?.takeIf { it.isNotEmpty() }
            if (url == null) {
                val err = res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "failed to create share link"
                note("⚠ $err")
                return@launch
            }
            // Persist id + revokeToken so /shares can list and revoke this link later —
            // the token is returned exactly once and anonymous shares aren't listable
            // server-side (web parity for localStorage["tiny_my_shares"]).
            res.optString("id").takeIf { it.isNotEmpty() }?.let { id ->
                tinyApp.myShares.add(
                    id = id,
                    name = tiny,
                    revokeToken = res.optString("revokeToken").takeIf { it.isNotEmpty() },
                    created = System.currentTimeMillis(),
                )
            }
            Sharing.copyToClipboard(tinyApp, "tiny share", url)
            Sharing.shareText(tinyApp, "Conversation with $tiny", url)
            note("🔗 share link copied: $url — /shares to manage")
        }
    }

    // -- share link management: /shares [revoke <id>] (web Chat.tsx:1637-1681 parity) --
    // Listing merges account shares (GET /api/share?mine=1, login-required, owner-
    // scoped → {shares:[{id,tiny_name,created}]}) with locally-recorded anonymous
    // ones (MyShares, since the server can't list those). Revoke is DELETE
    // /api/share {id, revokeToken?}: an owner revokes via session, an anonymous
    // share only via its stored revokeToken.

    /** /shares — list this account's + this device's share links (ids copied). */
    private fun listShares() {
        note("🔗 gathering your share links…")
        viewModelScope.launch {
            val local = tinyApp.myShares.load()
            // Fetch account-scoped shares separately so we can tell a real outage from a
            // clean "no server shares": if the logged-in fetch fails, surface it rather
            // than silently showing only local anon shares (web masked-empty class).
            var account: org.json.JSONArray? = null
            if (tinyApp.auth.isLoggedIn) {
                val res = runCatching { tinyApp.api.getJson("/api/share?mine=1") }.getOrNull()
                val status = res?.optInt("_status", 0) ?: 0
                if (res == null || status >= 400) {
                    note("⚠ ${status.takeIf { it >= 400 }?.let { technology.tiny.app.net.friendlyHttpError(it) }
                        ?: "couldn't reach your account shares — try again"}")
                    return@launch
                }
                account = res.optJSONArray("shares")
            }

            val lines = LinkedHashMap<String, String>() // id → display, dedupe by id
            if (account != null) {
                for (i in 0 until account.length()) {
                    account.optJSONObject(i)?.let { o ->
                        val id = o.optString("id")
                        if (id.isNotEmpty()) lines[id] = "$id (/${o.optString("tiny_name")})"
                    }
                }
            }
            local.forEach { s -> lines.getOrPut(s.id) { "${s.id} (/${s.name})" } }

            if (lines.isEmpty()) {
                note("no share links yet — /share to create one")
                return@launch
            }
            val body = lines.values.joinToString("\n")
            Sharing.copyToClipboard(tinyApp, "tiny shares", lines.keys.joinToString("\n"))
            note(
                "🔗 ${lines.size} share link${if (lines.size == 1) "" else "s"} (ids copied):\n" +
                    body +
                    "\n\n/shares revoke <id> to remove one",
            )
        }
    }

    /** /shares revoke <id> — DELETE /api/share {id, revokeToken?}; drop from local store. */
    private fun revokeShare(id: String) {
        note("🗑️ revoking $id…")
        viewModelScope.launch {
            val body = JSONObject().put("id", id)
            tinyApp.myShares.revokeTokenFor(id)?.let { body.put("revokeToken", it) }
            val res = runCatching { tinyApp.api.deleteJson("/api/share", body) }.getOrNull()
            if (res?.optBoolean("ok") == true) {
                tinyApp.myShares.remove(id)
                val extra = res.optString("note").takeIf { it.isNotEmpty() }
                note("🗑️ share link revoked${if (extra != null) " ($extra)" else ""}")
            } else {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't revoke that share"}")
            }
        }
    }

    // -- tool marketplace + trust: /tools [browse [q] | trust <owner> | untrust <owner>] --
    // (web Chat.tsx:1361-1416 parity). "Trust" = a per-user allowlist of GitHub repo
    // OWNER logins (max 20) gating which repos the agent's install_tool may pull from —
    // NOT tool names, NOT a run-without-confirm flag. Marketplace browse is the PUBLIC
    // worker GET /tools/browse (no auth); trust GET/POST/DELETE /api/tools/trust need a
    // session. iOS has no equivalent — web is the only reference.

    private val ownerRegex = Regex("^[a-zA-Z0-9]([a-zA-Z0-9-]{0,38})$")

    /** /tools browse [query] — public marketplace list, names+authors copied to clipboard. */
    private fun browseTools(query: String) {
        note("🧰 browsing the tool marketplace…")
        viewModelScope.launch {
            val url = buildString {
                append(technology.tiny.app.net.WORKER_URL).append("/tools/browse?limit=15")
                if (query.isNotEmpty()) append("&q=").append(java.net.URLEncoder.encode(query, "UTF-8"))
            }
            val res = runCatching { tinyApp.api.getPublic(url) }.getOrNull()
            // Outage vs empty marketplace — a null/HTTP-error result must not read as
            // "no tools yet" (web CommandPalette masked-empty fix 0c5e8f5 / a7e894b).
            val status = res?.optInt("_status", 0) ?: 0
            if (res == null || status >= 400) {
                note("⚠ ${status.takeIf { it >= 400 }?.let { technology.tiny.app.net.friendlyHttpError(it) }
                    ?: "couldn't reach the tool marketplace — try again"}")
                return@launch
            }
            val arr = res.optJSONArray("tools")
            if (arr == null || arr.length() == 0) {
                note(if (query.isEmpty()) "no tools in the marketplace yet" else "no tools match \"$query\"")
                return@launch
            }
            val lines = (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { o ->
                    val name = o.optString("name")
                    val author = o.optString("author").takeIf { it.isNotEmpty() }
                    val desc = o.optString("description").take(80)
                    "$name${if (author != null) " @$author" else ""} — $desc"
                }
            }
            Sharing.copyToClipboard(tinyApp, "tiny tools", lines.joinToString("\n"))
            note(
                "🧰 ${lines.size} tool${if (lines.size == 1) "" else "s"} (copied):\n" +
                    lines.joinToString("\n") +
                    "\n\nask me to \"install <name>\" to add one · /tools trust <owner> to allow a repo",
            )
        }
    }

    /** bare /tools — list this account's trusted GitHub owners (GET /api/tools/trust). */
    private fun listTrusted() {
        if (!requireLoginTools()) return
        viewModelScope.launch {
            val res = runCatching { tinyApp.api.getJson("/api/tools/trust") }.getOrNull()
            if (res?.optBoolean("ok") != true) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't load trusted owners"}")
                return@launch
            }
            val owners = res.optJSONArray("owners")
            val list = (0 until (owners?.length() ?: 0)).mapNotNull { owners?.optString(it)?.takeIf { s -> s.isNotEmpty() } }
            if (list.isEmpty()) note("no trusted tool owners yet — /tools trust <github-owner> to add one")
            else note("🔐 trusted tool owners (${list.size}/20): ${list.joinToString(", ")}\n/tools untrust <owner> to remove")
        }
    }

    /** /tools trust <owner> — POST /api/tools/trust {owner}. */
    private fun trustOwner(owner: String) {
        if (!ownerRegex.matches(owner)) { note("⚠ invalid GitHub owner name"); return }
        if (!requireLoginTools()) return
        note("🔐 trusting @$owner…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson("/api/tools/trust", JSONObject().put("owner", owner))
            }.getOrNull()
            if (res?.optBoolean("ok") == true) {
                val extra = res.optString("note").takeIf { it.isNotEmpty() }
                note("🔐 @$owner trusted${if (extra != null) " ($extra)" else ""} — the agent may now install tools from their repos")
            } else {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't trust that owner"}")
            }
        }
    }

    /** /tools untrust <owner> — DELETE /api/tools/trust {owner}. */
    private fun untrustOwner(owner: String) {
        if (!requireLoginTools()) return
        note("🔓 untrusting @$owner…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.deleteJson("/api/tools/trust", JSONObject().put("owner", owner))
            }.getOrNull()
            if (res?.optBoolean("ok") == true) note("🔓 @$owner untrusted")
            else note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't untrust that owner"}")
        }
    }

    // -- my forged toolbox: /tools mine | rm <name> | install <login> <name> --
    // (web Control.tsx "My Forged Tools" panel + ProfileToolCard install parity). These
    // are the SESSION-authed CRUD routes on the Next host (GET/DELETE /api/tools, POST
    // /api/tools/install) — distinct from the public marketplace worker. Creation is NOT
    // exposed here: web only forges via the agent's create_tool tool-call (no client form),
    // so Android mirrors that — the box is browse/install/remove. Stored name omits the
    // "my_" prefix; the agent invokes it as my_<name>. iOS has no toolbox at all.

    /**
     * ONE typed GET /api/tools fetch, shared by the /tools mine slash command and
     * the ToolboxSheet panel (web Control.tsx loadMyTools) so the two can't drift.
     * A transport failure or a non-ok body (401 login / 424 backend degrade) is
     * Failed — NEVER surfaced as an empty toolbox (web masked-empty class).
     */
    suspend fun fetchMyTools(): technology.tiny.app.ui.ToolboxLoad {
        val res = runCatching { tinyApp.api.getJson("/api/tools") }.getOrNull()
        if (res?.optBoolean("ok") == true) {
            return technology.tiny.app.ui.ToolboxLoad.Ok(
                technology.tiny.app.ui.parseMyTools(res.optJSONArray("tools")),
            )
        }
        val status = res?.optInt("_status", 0) ?: 0
        val msg = res?.optString("error")?.takeIf { it.isNotEmpty() }
            ?: status.takeIf { it >= 400 }?.let { technology.tiny.app.net.friendlyHttpError(it) }
            ?: "couldn't load your toolbox — try again"
        return technology.tiny.app.ui.ToolboxLoad.Failed(msg)
    }

    /**
     * DELETE /api/tools {name} — null on success, else a user-facing error.
     * Shared by /tools rm and the ToolboxSheet delete (accepts either name form;
     * the server strips my_ too).
     */
    suspend fun deleteMyToolNow(name: String): String? {
        val clean = name.removePrefix("my_")
        val res = runCatching {
            tinyApp.api.deleteJson("/api/tools", JSONObject().put("name", clean))
        }.getOrNull()
        if (res?.optBoolean("ok") == true) return null
        return res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "no tool named my_$clean"
    }

    /** /tools mine — list this account's own forged tools (GET /api/tools). */
    private fun listMyTools() {
        if (!requireLoginTools()) return
        viewModelScope.launch {
            when (val load = fetchMyTools()) {
                is technology.tiny.app.ui.ToolboxLoad.Failed -> note("⚠ ${load.message}")
                is technology.tiny.app.ui.ToolboxLoad.Ok -> {
                    val lines = load.tools.map { t ->
                        val desc = t.description.take(80).takeIf { it.isNotEmpty() }
                        "my_${t.name}${if (desc != null) " — $desc" else ""}"
                    }
                    if (lines.isEmpty()) {
                        note("your toolbox is empty — ask me to create one (\"forge a tool that…\"), or /tools install <login> <name>")
                        return@launch
                    }
                    Sharing.copyToClipboard(tinyApp, "my tiny tools", lines.joinToString("\n"))
                    note(
                        "🧰 your forged tools (${lines.size}/20, copied):\n" +
                            lines.joinToString("\n") +
                            "\n\n/tools rm <name> to delete one · /toolbox for the visual panel",
                    )
                }
            }
        }
    }

    /** /tools rm <name> — delete one of my forged tools (DELETE /api/tools {name}). */
    private fun deleteMyTool(name: String) {
        if (!requireLoginTools()) return
        val clean = name.removePrefix("my_") // server strips it too; accept either form
        note("🗑 removing my_$clean…")
        viewModelScope.launch {
            val err = deleteMyToolNow(clean)
            if (err == null) note("🗑 my_$clean removed from your toolbox")
            else note("⚠ $err")
        }
    }

    /** /tools install <login> <name> — copy a builder's tool into my box (POST /api/tools/install). */
    private fun installTool(login: String, name: String) {
        if (!requireLoginTools()) return
        val cleanLogin = login.removePrefix("@")
        note("📦 installing $name from @$cleanLogin…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson(
                    "/api/tools/install",
                    JSONObject().put("login", cleanLogin).put("name", name.removePrefix("my_")),
                )
            }.getOrNull()
            if (res?.optBoolean("ok") == true) {
                val stored = res.optString("name").takeIf { it.isNotEmpty() } ?: name
                val updated = res.optBoolean("updated")
                note("📦 my_$stored ${if (updated) "updated from" else "installed from"} @$cleanLogin — invoke it as my_$stored")
            } else {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't install that tool"}")
            }
        }
    }

    private fun requireLoginTools(): Boolean {
        if (tinyApp.auth.isLoggedIn) return true
        note("🔑 sign in first — tool trust lives on your account")
        return false
    }

    // -- cloud archives: /save /load [id] /archives [delete <id>] (web Chat.tsx parity) --
    // All /api/archives verbs REQUIRE a session token (unlike /share). The server
    // rebuilds + redacts the archive from {tiny, messages}, so the client only sends
    // raw turns. GET → {archives:[{id,tiny_name,msg_count}]}; GET ?id= → the archive
    // {tinyai_session,version,tiny,exported,messages}; POST → {ok,id}; DELETE → {ok}.

    private fun requireLogin(): Boolean {
        if (tinyApp.auth.isLoggedIn) return true
        note("🔑 sign in first — cloud archives need your account")
        return false
    }

    /** /save — POST /api/archives {tiny, messages} → cloud archive on your account. */
    private fun saveArchive() {
        if (!requireLogin()) return
        if (busy) { note("⏳ wait for the reply to finish before saving"); return }
        val turns = messages.filter {
            it.role != "system" && it.role != "note" && it.text.isNotBlank() && it.failedPrompt == null
        }
        if (turns.isEmpty()) { note("nothing to save yet"); return }
        note("☁️ archiving to your account…")
        viewModelScope.launch {
            val payload = JSONArray()
            turns.forEach { m ->
                payload.put(JSONObject().put("id", m.id).put("role", m.role).put("content", m.text))
            }
            val res = runCatching {
                tinyApp.api.postJson("/api/archives", JSONObject().put("tiny", tiny).put("messages", payload))
            }.getOrNull()
            if (res?.optBoolean("ok") == true) {
                val id = res.optString("id")
                note("☁️ archived to your account ($id) — /load $id on any device")
            } else {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't save archive"}")
            }
        }
    }

    /** /load or /archives — GET /api/archives → list, copied to clipboard. */
    private fun listArchives() {
        if (!requireLogin()) return
        note("☁️ loading your archives…")
        viewModelScope.launch {
            val res = runCatching { tinyApp.api.getJson("/api/archives") }.getOrNull()
            // Distinguish a transport/HTTP failure from a genuinely-empty archive list —
            // else an outage reads as "no cloud archives yet" and the user thinks their
            // saved sessions vanished (web masked-empty class: a7e894b/df73551).
            val status = res?.optInt("_status", 0) ?: 0
            if (res == null || status >= 400) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() }
                    ?: status.takeIf { it >= 400 }?.let { technology.tiny.app.net.friendlyHttpError(it) }
                    ?: "couldn't reach your archives — try again"}")
                return@launch
            }
            val arr = res.optJSONArray("archives")
            if (arr == null || arr.length() == 0) {
                note("no cloud archives yet — /save to create one")
                return@launch
            }
            val lines = (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { o ->
                    "${o.optString("id")} — ${o.optString("tiny_name")} (${o.optInt("msg_count")} msgs)"
                }
            }
            Sharing.copyToClipboard(tinyApp, "tiny archives", lines.joinToString("\n"))
            note(
                "☁️ ${lines.size} archive${if (lines.size == 1) "" else "s"} (copied):\n" +
                    lines.joinToString("\n") +
                    "\n\n/load <id> to restore · /archives delete <id> to remove"
            )
        }
    }

    /** /load <id> — GET /api/archives?id= → replace the current transcript. */
    private fun loadArchive(id: String) {
        if (!requireLogin()) return
        if (busy) { note("⏳ wait for the reply to finish before loading"); return }
        note("📂 restoring $id…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.getJson("/api/archives?id=" + java.net.URLEncoder.encode(id, "UTF-8"))
            }.getOrNull()
            val msgs = res?.takeIf { it.optBoolean("tinyai_session") }?.optJSONArray("messages")
            if (msgs == null) {
                note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't load archive"}")
                return@launch
            }
            val restored = (0 until msgs.length()).mapNotNull { i ->
                msgs.optJSONObject(i)?.let { o ->
                    val role = o.optString("role")
                    val content = o.optString("content")
                    if (role.isBlank() || content.isBlank()) null
                    else ChatMessage(
                        id = o.optString("id").takeIf { it.isNotEmpty() } ?: UUID.randomUUID().toString(),
                        role = role,
                        text = content,
                    )
                }
            }.filter { it.role != "system" } // fresh platform note is injected per-turn
            if (restored.isEmpty()) { note("⚠ archive had no restorable messages"); return@launch }
            stopAll()
            messages.clear()
            messages.addAll(restored)
            followups.clear()
            error = null
            saveHistory()
            note("📂 restored ${restored.size} messages")
        }
    }

    /** /archives delete <id> — DELETE /api/archives {id}. */
    private fun deleteArchive(id: String) {
        if (!requireLogin()) return
        note("🗑 removing $id…")
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.deleteJson("/api/archives", JSONObject().put("id", id))
            }.getOrNull()
            if (res?.optBoolean("ok") == true) note("🗑 archive $id removed")
            else note("⚠ ${res?.optString("error")?.takeIf { it.isNotEmpty() } ?: "couldn't delete archive"}")
        }
    }

    /** Per-message delete (iOS long-press "Delete"). Drops the turn + persists. */
    fun deleteMessage(id: String) {
        val idx = messages.indexOfFirst { it.id == id }
        if (idx < 0) return
        if (liveIds.contains(id)) stop(id) // deleting a live bubble aborts its stream
        messages.removeAt(idx)
        saveHistory()
    }

    /**
     * Edit & resend a user turn (iOS long-press "Edit & resend"). Removes the
     * message (and any turns after it, mirroring an edit that discards the stale
     * reply) and returns its text so the composer can be repopulated.
     */
    fun editResend(id: String): String? {
        val idx = messages.indexOfFirst { it.id == id }
        if (idx < 0) return null
        val text = messages[idx].text
        while (messages.size > idx) {
            val removed = messages.removeAt(messages.size - 1)
            // A live stream whose bubble just got truncated away must not keep
            // burning tokens into nowhere — abort it (siblings before idx keep going).
            if (liveIds.contains(removed.id)) stop(removed.id)
        }
        saveHistory()
        return text
    }

    private var reconnectJob: Job? = null
    private fun watchForReconnect() {
        if (reconnectJob?.isActive == true) return
        reconnectJob = viewModelScope.launch {
            tinyApp.net.online.collect { isOnline ->
                if (isOnline && queuedSends.isNotEmpty()) {
                    note("📶 back online")
                    // Drain the WHOLE queue — each queued message fires as its own
                    // concurrent turn (web parity; the queue is offline-only now).
                    // Bounded by the snapshot size so a send() that re-queues on a
                    // mid-drain drop can't loop forever.
                    repeat(queuedSends.size) {
                        queuedSends.removeFirstOrNull()?.let(::send)
                    }
                    // send() re-persists if a mid-drain drop re-queues; this write
                    // records the (usually empty) final state.
                    persistQueue()
                    reconnectJob?.cancel()
                }
            }
        }
    }

    /**
     * Add-or-update the per-tool detail card keyed by toolUseId (web dedupes the
     * ToolCall list the same way). Tools with a richer custom render (render_ui →
     * card, suggest_followups → chips, spawn_agents → TaskTree) never get a generic
     * card, matching the web filter at Chat.tsx:2585-2588.
     */
    private fun upsertToolCall(
        idx: Int,
        toolUseId: String,
        name: String,
        mutate: (technology.tiny.app.ui.ToolCall) -> technology.tiny.app.ui.ToolCall,
    ) {
        if (name in technology.tiny.app.ui.ToolCall.SUPPRESSED) return
        val calls = messages[idx].toolCalls
        val at = calls.indexOfFirst { it.id == toolUseId }
        val updated = if (at >= 0) {
            calls.toMutableList().also { it[at] = mutate(it[at]) }
        } else {
            calls + mutate(technology.tiny.app.ui.ToolCall(id = toolUseId, name = name))
        }
        messages[idx] = messages[idx].copy(toolCalls = updated)
    }

    /** A tool still "calling" when the stream ends was interrupted (web Chat.tsx:1260). */
    private fun reconcileTools(
        calls: List<technology.tiny.app.ui.ToolCall>,
    ): List<technology.tiny.app.ui.ToolCall> =
        calls.map { if (it.status == "calling") it.copy(status = "error", error = "interrupted") else it }

    // Last hidden-map hint (elapsedRealtime ms) — one toast per ~30s, not per pin
    private var lastMapHintAt = 0L

    private fun handleClientTool(ev: ChatEvent.BeforeToolCall, replyIdx: Int) {
        when (ev.name) {
            "suggest_followups" -> {
                followups.clear()
                val chips = ev.input.optJSONArray("chips") ?: return
                for (i in 0 until minOf(chips.length(), 4)) followups.add(chips.optString(i))
            }
            "remember" -> {
                val content = ev.input.optString("content")
                if (content.isNotBlank()) {
                    val tags = ev.input.optJSONArray("tags")
                        ?.let { t -> (0 until t.length()).map { t.optString(it) } } ?: emptyList()
                    tinyApp.continuity.addMemory(tiny, content, tags)
                }
            }
            "forget" -> {
                val match = ev.input.optString("match")
                if (match.isNotBlank()) tinyApp.continuity.forgetMemory(tiny, match)
            }
            "spawn_agents" -> {
                // Tasks known at call time; nodes seeded "running", flipped by AfterToolCall.
                val tasks = ev.input.optJSONArray("tasks") ?: return
                val nodes = (0 until tasks.length()).mapNotNull { i ->
                    tasks.optJSONObject(i)?.optString("prompt")?.takeIf { it.isNotEmpty() }
                }.mapIndexed { i, prompt -> technology.tiny.app.ui.SpawnNode(id = i + 1, prompt = prompt) }
                if (nodes.isNotEmpty()) {
                    val tree = technology.tiny.app.ui.SpawnTree(id = ev.toolUseId, nodes = nodes)
                    messages[replyIdx] = messages[replyIdx].copy(spawns = messages[replyIdx].spawns + tree)
                }
            }
            "manage_messages" -> {
                // Queue — applying mid-stream would shift the live reply index.
                // Applied in send()'s finally via applyPendingManage() (iOS parity).
                pendingManage.add(
                    ManageOp(
                        action = ev.input.optString("action", "stats"),
                        from = if (ev.input.has("from")) ev.input.optInt("from") else null,
                        to = if (ev.input.has("to")) ev.input.optInt("to") else null,
                        summary = ev.input.optString("summary").takeIf { it.isNotBlank() },
                    )
                )
            }
            "render_ui" -> {
                // props render natively; componentCode is NEVER evaluated (iOS parity)
                val props = ev.input.optJSONObject("props") ?: JSONObject()
                val card = UiCard(ev.input.optString("title").takeIf { it.isNotEmpty() }, props.toString())
                messages[replyIdx] = messages[replyIdx].copy(uiCards = messages[replyIdx].uiCards + card)
            }
            "speak" -> {
                val text = ev.input.optString("text")
                if (text.isNotBlank()) {
                    messages[replyIdx] = messages[replyIdx].copy(speechText = text)
                    if (tinyApp.config.autoSpeak && !tinyApp.config.isQuietNow()) {
                        tinyApp.speech.speak(text, messages[replyIdx].id)
                    }
                }
            }
            "screenshot" -> {
                // ROUND-TRIP device tool (generate_image's twin, iOS Screenshot.swift):
                // open the system MediaProjection consent dialog — which IS the
                // per-capture "allow?" prompt — then capture one frame, upload it, and
                // post the result the server callback is polling for. All of that lives
                // off the chat surface in ScreenshotConsentActivity/Service, so mark this
                // tool "running" (no toolLabel) rather than treating it as unhandled.
                technology.tiny.app.tools.ScreenshotConsentActivity.launch(getApplication(), ev.toolUseId)
            }
            "meta_take_photo" -> {
                // 🕶️ Glasses ROUND-TRIP (iOS Wearables.swift parity): capture
                // through the DAT session, upload once, post to the mailbox
                // the server tool is polling. The bridge posts on EVERY path.
                viewModelScope.launch {
                    technology.tiny.app.fleet.WearablesBridge.runPhotoTool(tinyApp, ev.toolUseId)
                }
            }
            "meta_glasses_status" -> {
                viewModelScope.launch {
                    technology.tiny.app.fleet.WearablesBridge.runStatusTool(tinyApp, ev.toolUseId)
                }
            }
            "meta_record_video" -> {
                // 🎥 Toggle recording (iOS GlassesRecorder parity) — the
                // bridge holds state between the agent's start and stop calls.
                viewModelScope.launch {
                    technology.tiny.app.fleet.GlassesRecorderBridge.runTool(tinyApp, ev.toolUseId)
                }
            }
            "meta_listen" -> {
                viewModelScope.launch {
                    technology.tiny.app.fleet.WearablesListenerBridge.runTool(
                        tinyApp, ev.toolUseId, ev.input.optInt("seconds", 10),
                    )
                }
            }
            "add_map_marker", "remove_map_marker", "clear_map_markers",
            "fly_to_location", "fly_to_marker", "tour_markers" -> {
                // 🗺️ Agent map bridge (web __tinyMapBridge parity). Pins/camera
                // land on MapBackdrop + MapSheet; placed-while-hidden pins keep —
                // they greet the user when 📍 goes on.
                technology.tiny.app.tools.AgentMap.handle(ev.name, ev.input)
                // Acting on a HIDDEN map would be invisible — say where to look
                // (web toasts "tap 📍 to see it"). Throttled: a tour of pins
                // must not stack toasts.
                if (!technology.tiny.app.tools.AgentMap.mapVisible && ev.name != "clear_map_markers") {
                    val now = android.os.SystemClock.elapsedRealtime()
                    if (now - lastMapHintAt > 30_000) {
                        lastMapHintAt = now
                        android.widget.Toast.makeText(
                            getApplication(),
                            "🗺️ your tiny is using the map — turn on 'Share location' to see it",
                            android.widget.Toast.LENGTH_LONG,
                        ).show()
                    }
                }
            }
            else -> {
                // Physical device tools (vibrate/flashlight/clipboard/…) act on the phone.
                val handled = tinyApp.deviceTools.handle(ev.name, ev.input)
                messages[replyIdx] = messages[replyIdx].copy(toolLabel = ev.name.takeUnless { handled })
            }
        }
    }

    /**
     * Apply queued manage_messages ops after the stream ends (iOS applyPendingManage parity).
     * `from`/`to` are 1-based, inclusive, over user+assistant turns only (notes/cards excluded
     * from the count the model reasons about). The last 2 real turns are protected — they include
     * the just-finished exchange the model is acting on. drop removes the range; compact replaces
     * it with a single note; stats surfaces the current turn/char counts as a note
     * (web shows a toast) so the model can calibrate positions before drop/compact.
     */
    private fun applyPendingManage() {
        if (pendingManage.isEmpty()) return
        val ops = pendingManage.toList()
        pendingManage.clear()
        for (op in ops) {
            // Indices of real turns (user/assistant) in the backing list. This is the
            // SAME basis the model reasons about: history sent to the server is filtered
            // to user/assistant turns only (see send()), so a turn's 1-based position
            // here matches what the model saw on the wire.
            val turnIdx = messages.indices.filter { messages[it].role == "user" || messages[it].role == "assistant" }
            // stats reports current counts so the model calibrates before drop/compact.
            // Surfaced as a note (web shows a toast) — no editable-range needed, so it
            // runs even when everything is protected (matches "just tell me the size").
            if (op.action == "stats") {
                val chars = turnIdx.sumOf { messages[it].text.length }
                messages.add(
                    ChatMessage(
                        role = "note",
                        text = "✂️ ${turnIdx.size} messages · ~${String.format(java.util.Locale.US, "%.1f", chars / 1000.0)}K chars",
                    )
                )
                continue
            }
            val editable = maxOf(0, turnIdx.size - 2) // protect last 2 turns
            if (editable == 0) continue
            // Reject a reversed range instead of silently coercing it to a 1-item op
            // (web Chat.tsx: from > to → "Invalid range"). from/to are 1-based positions.
            val fromPos = maxOf(1, op.from ?: 1)
            val toPos = minOf(turnIdx.size, op.to ?: turnIdx.size)
            if (fromPos > toPos) {
                messages.add(ChatMessage(role = "note", text = "✂️ invalid range"))
                continue
            }
            val lo = (fromPos - 1).coerceIn(0, editable - 1)
            val hi = (toPos - 1).coerceIn(lo, editable - 1)
            val realLo = turnIdx[lo]
            val realHi = turnIdx[hi]
            val removed = hi - lo + 1
            when (op.action) {
                "drop" -> {
                    for (i in realHi downTo realLo) messages.removeAt(i)
                }
                "compact" -> {
                    for (i in realHi downTo realLo) messages.removeAt(i)
                    val summary = op.summary?.takeIf { it.isNotBlank() } ?: "earlier context"
                    messages.add(realLo, ChatMessage(role = "note", text = "🧹 $removed messages compacted — $summary"))
                }
                // "stats" and anything else: silent no-op (iOS parity)
            }
        }
    }

    fun clear() {
        stopAll() // web /clear parity — abort every live stream first
        messages.clear()
        followups.clear()
        error = null
        saveHistory()
    }

    fun switchTiny(name: String) {
        // Normalize to a canonical slug at the single choke point every switch
        // passes through (the /tiny command, the MRU launcher shortcut, AND the
        // BROWSABLE tinyapp://tiny?name=<slug> deep link — which lets any web
        // page hand us an arbitrary name, only isNotBlank-gated in the intent
        // parser). The old `name.trim().lowercase()` kept spaces/punctuation
        // verbatim ("My Bot" → "my bot"), so a crafted or fat-fingered name
        // produced a persona that can never resolve, a junk MRU shortcut, and
        // garbage in the top bar. normalizeTinySlug matches sendVisit/fetchPrice
        // (`[a-z0-9]+ → -`, capped) so all four paths agree on the stored form.
        val slug = normalizeTinySlug(name)
        if (slug.isEmpty() || slug == tiny) return
        stopAll()
        saveHistorySync()
        tiny = slug
        // Promote to the MRU dynamic-shortcut list (launcher long-press → this tiny).
        technology.tiny.app.RecentTinys.record(tinyApp, tiny)
        messages.clear()
        followups.clear()
        accentHex = null
        bgHex = null
        heroUrl = null
        logoUrl = null
        introVibe = null
        customChips = null
        customTagline = null
        isPrivate = false    // don't flash the OLD tiny's lock over the NEW one;
        isAuthorized = false // fetchAccent re-derives both below
        isOwner = false      // never expose the OLD tiny's owner tools on the NEW
        callVoice = ""; ownerSystemPrompt = ""; ownerSystemKnowledge = ""
        introVibePlayed = false // next fetchAccent may greet with the new tiny's vibe
        viewModelScope.launch {
            loadHistory()
            fetchAccent()
        }
    }

    /**
     * 👀 Visit beacon — POST /api/visit {name}, fire-and-forget, once per tiny mount
     * (web Chat.tsx:405 `useEffect([name])`). Lets the owner know someone opened their
     * tiny; the server skips self-visits, throttles, and 300/day-rate-limits. Auth
     * header carries the visitor identity so the owner's notification says who came by.
     * Failures are swallowed — a missed beacon must never disrupt the chat. iOS has no
     * beacon, so this matches web (exceeds iOS), like the markdown/render_ui work.
     */
    fun sendVisit(name: String) {
        val slug = name.trim().lowercase().replace(Regex("[^a-z0-9-]"), "").take(64)
        if (slug.isEmpty()) return
        viewModelScope.launch {
            runCatching { tinyApp.api.postJson("/api/visit", JSONObject().put("name", slug)) }
        }
    }

    /**
     * 💵 Up-front price lookup — POST /api/wallet {action:pricing, resource:"tiny:<name>"}
     * → {price_micro}, surfacing a paid tiny's per-message cost in the top bar BEFORE the
     * user hits a 402 mid-send (web Chat.tsx priceMicro effect). Reset to null first so a
     * switch from a paid tiny to a free one — or a lookup that fails/blips — can't strand
     * the previous tiny's badge over the new one (web 2f9febf); the badge reappears only if
     * THIS lookup finds price_micro > 0. The 402 paywall stays authoritative — display only.
     */
    fun fetchPrice(name: String) {
        val slug = name.trim().lowercase()
        priceMicro = null
        if (slug.isEmpty()) return
        // Short-circuit when signed out. /api/wallet gates EVERY action behind a
        // session (worker route.ts:40 → 401 before the pricing branch), so a
        // tokenless lookup can only 401 and paint no badge — and a signed-out
        // visitor hits the sign-in paywall on send regardless. Web's badge only
        // shows for signed-in users too (the browser 401s identically when out),
        // so guarding here is true iOS/web parity (iOS loadPrice 270bbfd) and
        // saves a doomed round-trip on every mount/switch while logged out.
        if (!tinyApp.auth.isLoggedIn) return
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson("/api/wallet", technology.tiny.app.wallet.WalletCore.pricingBody(slug))
            }.getOrNull() ?: return@launch
            // Only adopt a price for the tiny still in view — a slow lookup that lands
            // after another switch must not paint a stale badge (the null-first reset
            // handles the common case; this guards the race).
            if (tiny == slug) priceMicro = technology.tiny.app.wallet.WalletCore.parsePriceMicro(res)
        }
    }

    /**
     * Per-tiny theme accent — POST /api/tiny {name} → theme.accent (object or JSON
     * string). The same response carries a top-level `hero` string (sibling of
     * `theme`, NOT inside it): an owner-set https banner image URL for the
     * turn-zero landing (web Chat.tsx:1973). Missing/invalid → null (no banner).
     */
    private suspend fun fetchAccent() {
        val res = runCatching {
            tinyApp.api.postJson("/api/tiny", JSONObject().put("name", tiny))
        }.getOrNull() ?: return
        val theme = res.optJSONObject("theme")
            ?: res.optString("theme").takeIf { it.startsWith("{") }?.let { runCatching { JSONObject(it) }.getOrNull() }
        val hex = theme?.optString("accent")?.takeIf { it.matches(Regex("#?[0-9a-fA-F]{6}")) }
        accentHex = hex?.removePrefix("#")?.let { "#$it" }
        // theme.bg rides the same object (web applies it as --tiny-bg; upsert
        // validates both as hex). Same regex → same trust level as accent.
        val bg = theme?.optString("bg")?.takeIf { it.matches(Regex("#?[0-9a-fA-F]{6}")) }
        bgHex = bg?.removePrefix("#")?.let { "#$it" }
        heroUrl = validHeroUrl(res.optString("hero"))
        // Per-tiny identity extras — top-level siblings of `hero`, all optional
        // (server ships in parallel; absent fields no-op). `logo` shares hero's
        // URL validation; `intro_vibe` must name a vibrate-tool pattern; `chips`
        // is 1-4 strings ≤60 chars or the defaults stay.
        logoUrl = validHeroUrl(res.optString("logo"))
        introVibe = validIntroVibe(res.optString("intro_vibe"))
        customChips = validCustomChips(
            res.optJSONArray("chips")?.let { arr -> List(arr.length()) { arr.optString(it) } },
        )
        customTagline = validTagline(res.optString("tagline"))
        // Private + whether this device is vouched. The proxy forwards the
        // worker's isAuthorized (default false); an owner's request carried the
        // Bearer token so they come back authorized and get the normal composer.
        // `private` from /api/tiny is the raw D1 integer; optBoolean misreads a
        // `private:1` row as public (returns false), so an authorized owner's private
        // tiny would show no lock. Coerce truthily, fail-open (default false) for an
        // unspecified tiny — matches web `!!private`. See JsonFlags.truthyFlag.
        // (isAuthorized/isOwner are worker-computed JS booleans, safe as optBoolean.)
        isPrivate = res.truthyFlag("private", default = false)
        isAuthorized = res.optBoolean("isAuthorized", false)
        isOwner = res.optBoolean("isOwner", false)
        callVoice = res.optString("voice")
        // Owners get full config back — stash the persona so a voice-only save
        // can re-send it (the worker's D1 mirror would otherwise blank it).
        ownerSystemPrompt = res.optString("systemPrompt")
        ownerSystemKnowledge = res.optString("systemKnowledge")
        // Intro haptic: the tiny's signature buzz, once per open/switch, moderate
        // intensity. Reuses the vibrate device tool verbatim (same waveforms, same
        // 15s ceiling); that tool has NO quiet-hours gate (only play_sound does),
        // so none here either — and handle() already swallows failures.
        introVibe?.takeIf { !introVibePlayed }?.let { pattern ->
            introVibePlayed = true
            tinyApp.deviceTools.handle(
                "vibrate",
                JSONObject().put("pattern", pattern).put("times", 1).put("intensity", 0.6),
            )
        }
        // Persist for the widgets (only the default tiny drives the shared accent).
        if (tiny == "tiny") tinyApp.config.accentHex = accentHex
    }

    /**
     * 🎙 Owner-only: set the tiny's realtime call-voice — the OpenAI voice heard
     * on a live call. This is a PER-TINY SERVER field (docs/voice-sessions-design.md,
     * locked design): everyone who calls this tiny hears it, not a per-device
     * override. Writes via POST /api/control (worker /upsert, owner-gated),
     * re-sending the persona so the D1 mirror can't blank it. Calls back with
     * the save result on the main thread.
     */
    fun saveVoice(next: String, onResult: (Boolean) -> Unit) {
        if (!isOwner) { onResult(false); return }
        viewModelScope.launch {
            val res = runCatching {
                tinyApp.api.postJson(
                    "/api/control",
                    JSONObject()
                        .put("name", tiny)
                        .put("voice", next)
                        // Re-send persona — the D1 mirror writes raw body.systemPrompt.
                        .put("systemPrompt", ownerSystemPrompt)
                        .put("systemKnowledge", ownerSystemKnowledge),
                )
            }.getOrNull()
            // The control route returns { message: "Success!" } on a good save.
            val ok = res?.optString("message") == "Success!"
            if (ok) callVoice = next
            onResult(ok)
        }
    }

    /**
     * 🔓 Unlock a private tiny for this device — POST /api/login {name[,key]}
     * (web Chat.tsx applyUnlock / iOS unlockPrivate parity). A signed-in OWNER
     * unlocks with no key (their Bearer token vouches them server-side); a
     * visitor supplies the access key. On success (`isAuthorized`) the lock
     * panel gives way to the composer and the lock glyph flips open. `key` is
     * blank for the owner sign-in path.
     */
    fun unlockPrivate(key: String) {
        val slug = tiny
        viewModelScope.launch {
            val body = JSONObject().put("name", slug)
            key.trim().takeIf { it.isNotEmpty() }?.let { body.put("key", it) }
            val res = runCatching { tinyApp.api.postJson("/api/login", body) }.getOrNull()
            // 429 is an IP daily cap — "try again" wrongly invites an immediate
            // retry that can't win. Name the rate-limit apart from a genuine
            // reach-the-server failure (web Chat.tsx 429 parity).
            if (res != null && res.optInt("_status", 0) == 429) {
                note("⚠️ too many unlock attempts — try again tomorrow")
                return@launch
            }
            if (res == null || res.optInt("_status", 0) >= 400) {
                note("⚠️ couldn't reach the server — try again")
                return@launch
            }
            // Guard the race: a slow unlock landing after a switch must not
            // authorize the wrong tiny.
            if (tiny != slug) return@launch
            if (res.optBoolean("isAuthorized", false)) {
                isAuthorized = true
                tinyApp.deviceTools.handle("vibrate", JSONObject().put("pattern", "success").put("times", 1).put("intensity", 0.6))
                note("🔓 unlocked $slug")
            } else {
                note(if (tinyApp.auth.token != null) "this tiny isn't yours — its owner decides who can talk to it" else "wrong key")
            }
        }
    }

    /**
     * Stop ONE streaming turn (per-bubble Stop) — sibling streams keep going.
     * Flips only that bubble's streaming flag; the stream's own finally does the
     * rest of the per-stream cleanup and releases its registry claim.
     */
    fun stop(id: String) {
        streamJobs[id]?.cancel()
        val idx = messages.indexOfLast { it.id == id }
        if (idx >= 0 && messages[idx].streaming) messages[idx] = messages[idx].copy(streaming = false)
        // The live chip is single-slot — drop it only when no OTHER stream is live.
        if (liveIds.none { it != id }) {
            technology.tiny.app.fleet.AgentLive.cancel(getApplication())
        }
    }

    /** Stop every live stream + background thinking (clear/switch/load teardown, stop-all chip). */
    fun stopAll() {
        streamJobs.values.toList().forEach { it.cancel() }
        cancelIdleAmbient() // don't let a pending idle turn fire against a cleared/switched context
        cancelAutonomous()  // clear/switch/load tear down via stopAll() — a /auto loop bound to
                            // the OLD transcript must not keep firing notes into it or redirect
                            // its findings after the surface changed (send() already cancels this)
        // Guard first, chip second (same order as the stream finally): while the
        // guard is foregrounded it pins notification id 43, so AgentLive.cancel's
        // NotificationManager.cancel would be a no-op; stopping the service makes
        // its onDestroy REMOVE the chip once cancel() has marked it not-visible.
        // Each cancelled stream's finally re-stops it too (idempotent).
        technology.tiny.app.fleet.StreamGuardService.stop(getApplication())
        technology.tiny.app.fleet.AgentLive.cancel(getApplication()) // user Stop → drop the live chip
        // Flip every live bubble off now; each stream's finally re-does its own (idempotent).
        for (i in messages.indices) {
            if (messages[i].streaming) messages[i] = messages[i].copy(streaming = false)
        }
    }

    // -- named sessions (offline save/load — iOS Sessions.swift parity) --

    private val sessionStore by lazy { SessionStore(getApplication()) }

    /** Archives for the current tiny, newest-saved first (the picker's order). */
    fun listSessions(): List<SessionArchive> = sessionStore.list(tiny)

    /**
     * Snapshot the LIVE transcript under [name] without moving it — the current
     * conversation stays on screen (iOS saveCurrent). Blank names are rejected by
     * the caller (Save button disabled); we trim + guard here too. Persisted via the
     * shared MessageCodec, so a saved session is byte-identical to the history file.
     */
    fun saveSession(name: String) {
        val label = name.trim()
        if (label.isEmpty()) return
        val snapshot = messages.toList().takeLast(MAX_HISTORY)
        val archive = SessionArchive(
            name = label,
            tiny = tiny,
            savedAt = System.currentTimeMillis(),
            messagesJson = MessageCodec.encodeToString(snapshot),
            messageCount = snapshot.size,
        )
        viewModelScope.launch(Dispatchers.IO) { sessionStore.save(archive) }
    }

    /**
     * Replace the live transcript with a saved [archive]. First auto-archives the
     * OUTGOING conversation as a one-shot safety net (so a mis-tapped load is
     * recoverable), then prunes stale auto-backups, then swaps in the loaded
     * messages and persists them as the new history (iOS load()). Streams are torn
     * down first — a live turn must not bleed into the restored transcript.
     */
    fun loadSession(archive: SessionArchive) {
        stopAll()
        val outgoing = messages.toList().takeLast(MAX_HISTORY)
        val restored = MessageCodec.decodeString(archive.messagesJson)
        messages.clear()
        messages.addAll(restored)
        followups.clear()
        error = null
        viewModelScope.launch(Dispatchers.IO) {
            if (outgoing.isNotEmpty()) {
                sessionStore.save(
                    SessionArchive(
                        name = "Auto-saved before loading \"${archive.name}\"",
                        tiny = tiny,
                        savedAt = System.currentTimeMillis(),
                        messagesJson = MessageCodec.encodeToString(outgoing),
                        messageCount = outgoing.size,
                        autoBackup = true,
                    )
                )
                sessionStore.pruneAutoBackups(tiny)
            }
            writeHistory(historyFile(), restored)
        }
    }

    fun deleteSession(archive: SessionArchive) {
        viewModelScope.launch(Dispatchers.IO) { sessionStore.delete(archive) }
    }

    // -- transcript persistence: chat-history-<tiny>.json, last 200 (iOS parity) --

    private fun historyFile(): File =
        File(getApplication<TinyApp>().filesDir, "chat-history-${tiny.replace(Regex("[^a-z0-9_-]"), "_")}.json")

    private suspend fun loadHistory() = withContext(Dispatchers.IO) {
        val f = historyFile()
        if (!f.exists()) return@withContext
        // reconcileInterrupted: a turn whose stream died with the process (empty
        // placeholder persisted by send()'s save) reloads as an honest
        // "interrupted" + Retry instead of a silent blank bubble.
        val loaded = reconcileInterrupted(
            MessageCodec.decodeString(runCatching { f.readText() }.getOrElse { "" }),
        )
        withContext(Dispatchers.Main) {
            messages.clear()
            messages.addAll(loaded)
        }
    }

    // Saves are sequence-stamped on the caller thread and stale-skipped at write
    // time: each save launches its own IO coroutine, so two rapid saves (e.g. two
    // concurrent streams finishing back-to-back) could land OUT OF ORDER and let
    // an older transcript snapshot clobber a newer one on disk.
    private val historySaveSeq = java.util.concurrent.atomic.AtomicLong(0)
    private val historyAppliedSeq = java.util.concurrent.atomic.AtomicLong(0)

    private fun saveHistory() {
        val snapshot = messages.toList().takeLast(MAX_HISTORY)
        val file = historyFile()
        val seq = historySaveSeq.incrementAndGet()
        viewModelScope.launch(Dispatchers.IO) { writeIfNewest(seq, file, snapshot) }
    }

    private fun saveHistorySync() =
        writeIfNewest(historySaveSeq.incrementAndGet(), historyFile(), messages.toList().takeLast(MAX_HISTORY))

    /** Serialized (JVM monitor) so a sync save can't interleave with an in-flight
     *  async one; a snapshot older than the newest-written is dropped, not applied. */
    @Synchronized
    private fun writeIfNewest(seq: Long, file: File, snapshot: List<ChatMessage>) {
        if (seq <= historyAppliedSeq.get()) return
        historyAppliedSeq.set(seq)
        writeHistory(file, snapshot)
    }

    // Durable-field transcript codec lives in MessageCodec (pure, unit-tested) — the
    // SAME string form SessionStore stores as its opaque messagesJson blob, so a saved
    // session and the live history file are byte-identical shapes (one codec, no drift).
    private fun writeHistory(file: File, snapshot: List<ChatMessage>) {
        // Temp-then-rename: writeText truncates in place, so process death mid-write
        // left a half-file that decodeString reads as an EMPTY transcript — total
        // silent history loss on next launch. rename() is atomic on this filesystem;
        // the in-place fallback covers exotic mounts where it isn't.
        runCatching {
            val tmp = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
            tmp.writeText(MessageCodec.encodeToString(snapshot))
            if (!tmp.renameTo(file)) {
                file.writeText(MessageCodec.encodeToString(snapshot))
                tmp.delete()
            }
        }
    }
}

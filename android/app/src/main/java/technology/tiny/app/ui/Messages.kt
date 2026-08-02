package technology.tiny.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.ui.theme.TinyGray

data class DmThread(val login: String, val name: String?, val avatar: String, val unread: Int, val lastBody: String, val lastAt: Long)
data class DmMessage(val id: String, val direction: String, val body: String, val viaTiny: String?, val created: Long = 0L)

/**
 * The under-bubble meta line for a DM — relative age, then "· via <tiny>" when the
 * message was routed through an agent (iOS Messages.swift:228 / web MessagesHUD.tsx:506
 * both render `<ago>[· via <tiny>]`). [nowMs] is injected so the age is testable
 * without a wall clock; reuses the shared ago() (byte-identical to iOS dmAgo).
 */
internal fun dmMeta(created: Long, viaTiny: String?, nowMs: Long): String =
    ago(created, nowMs) + (viaTiny?.takeIf { it.isNotEmpty() }?.let { " · via $it" } ?: "")

/**
 * The inbox thread-row title — the builder's display name, falling back to the
 * "@handle" when they have none (iOS Messages.swift:167 `t.name.isEmpty ? "@login" : t.name`
 * / web MessagesHUD.tsx:402 renders `t.name`, whose thread build defaults name to the
 * login). Android parsed `name` but always rendered "@login", dropping the friendly name.
 */
internal fun threadTitle(name: String?, login: String): String =
    name?.takeIf { it.isNotBlank() } ?: "@$login"

/** The DM body limit — the same number as lib/chat/dm-send.ts DM_MAX_CHARS,
 *  the worker's MAX_BODY, iOS kDmMaxChars and MessagesHUD's maxLength. */
internal const val DM_MAX_CHARS = 2000

/**
 * How far over the limit this draft is, counted the way a person counts and the
 * way the server now counts: CODE POINTS. Kotlin's `String.length` is UTF-16
 * units, so a 2000-emoji draft measures 4000 there and would be reported as
 * twice its real length — the mirror image of the server bug this guards
 * against (a cap measured in units on one end and code points on the other
 * truncated a legal message mid-surrogate).
 */
internal fun dmOverrun(text: String): Int =
    maxOf(0, text.codePointCount(0, text.length) - DM_MAX_CHARS)

/**
 * What to show instead of sending, or null to go ahead.
 *
 * The server REFUSES an over-long DM (400) rather than cutting it — a DM can't
 * be unsent, so truncating turns a recoverable "too long" into an unrecoverable
 * "they read half a sentence". That 400 reaches this app as a generic "send
 * failed — try again", which invites exactly the retry that can't work, so the
 * client states the real reason and keeps the draft.
 */
internal fun dmSendRefusal(text: String): String? {
    if (text.isBlank()) return null
    val over = dmOverrun(text)
    if (over <= 0) return null
    return "$over character${if (over == 1) "" else "s"} too long — a DM can't be unsent, " +
        "so nothing was sent. Trim it to $DM_MAX_CHARS or send it in parts."
}

/**
 * A thread load that did not happen: is this person unreachable for good, or is
 * this a bad minute? iOS `ThreadLoadFailure` / `DmModel.classify` (`c7314145`).
 *
 * [Gone] has no retry and names the PERSON; [Retryable] carries the shared
 * caption and keeps its button. The distinction is worth a type because the two
 * differ in what the screen OFFERS, not just in wording.
 */
internal sealed interface ThreadLoadFailure {
    object Gone : ThreadLoadFailure
    data class Retryable(val message: String) : ThreadLoadFailure
}

/**
 * ⚠️⚠️ Keyed on the BODY, not the status — the whole point, and iOS's own reason
 * verbatim: **two different things answer 404 on this path.**
 *
 *  · The worker's `{error:"peer not found"}` (`messages.ts:300`) is about the
 *    PERSON: a login it cannot resolve. `/api/messages/route.ts:34` forwards it
 *    verbatim (`new Response(await res.text(), { status: res.status })`), so it
 *    arrives here intact.
 *  · Its router's catch-all answers plain-text `404 Not Found.`
 *    (`index.ts:228`) for a PATH — which a stale build of this app reaches, as
 *    does a stale Next deploy for /api/messages itself.
 *
 * Keying on the bare status would render our own staleness as someone's absence,
 * and that is an accusation against a healthy person we cannot take back.
 *
 * The line between them falls out of [technology.tiny.app.net.TinyApi]'s parse
 * for free: `runCatching { JSONObject(text) }.getOrElse { JSONObject() }` turns
 * the plain-text body into an EMPTY object, so `error` is blank — the same
 * "did the server explain itself" test iOS spells with `Api.serverError(in:)`
 * returning nil for a non-JSON body. No new plumbing on either phone.
 *
 * ⚠️ And this is what gives [LoadFailure.contentMessage] teeth here. A bare 404
 * is the one answer where the two rules diverge: `contentMessage` falls back to
 * "couldn't load this conversation — try again (HTTP 404)", while the chat table
 * would say "that tiny doesn't exist" about a person who is fine. The retryable
 * arm must keep asking `contentMessage` for that reason.
 */
internal fun classifyThreadLoad(res: JSONObject?): ThreadLoadFailure {
    if (LoadFailure.status(res) == 404 &&
        res?.optString("error")?.trim()?.isNotEmpty() == true
    ) return ThreadLoadFailure.Gone
    // Non-null by construction: this is only reached on a failed load, and
    // `contentMessage` returns null only for a load that SUCCEEDED. The house
    // line rather than `!!` so a future caller cannot crash a sheet.
    return ThreadLoadFailure.Retryable(
        LoadFailure.contentMessage(res, "messages", "this conversation") ?: LoadFailure.noResponse
    )
}

/**
 * The sentence for a peer who is gone. Names them, and never the wire's word:
 * "peer not found" is a router's vocabulary for a person (iOS
 * `Messages.swift:355`).
 */
internal fun peerGoneLine(login: String): String = "@$login isn't reachable any more."

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessagesSheet(
    app: TinyApp,
    initialWith: String? = null,
    // Tapping the @handle in a thread header opens that person's profile (their
    // tinys + tools) — the DM screen's route into ProfileSheet. Default no-op so
    // callers that don't wire it (e.g. a preview) still compile.
    onOpenProfile: (String) -> Unit = {},
    onDismiss: () -> Unit,
) {
    var threads by remember { mutableStateOf<List<DmThread>?>(null) }
    var threadsFailed by remember { mutableStateOf<String?>(null) }
    // Keyed on initialWith so a NEW deep-link (a DM notification tapped while the
    // inbox is ALREADY open) re-seeds navigation: the parent updates dmDeepLink →
    // initialWith changes, and openWith must follow to jump to that new sender. A
    // bare `remember{}` captured the first value forever, so the second tap did
    // nothing. Internal nav (thread tap / back) only sets openWith, and initialWith
    // stays stable until dismiss, so this never fights the user's own navigation.
    var openWith by remember(initialWith) { mutableStateOf(initialWith) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(openWith, reloadKey) {
        if (openWith == null) {
            threadsFailed = null
            threads = null
            val res = runCatching { app.api.getJson("/api/messages") }.getOrNull()
            // One rule for all six list sheets ([LoadFailure]) — keep DISTINCT from a
            // clean empty so we don't render "no messages yet" on an outage (iOS
            // panel-state parity, cycle 56/57). The rule asks whether `threads`
            // ARRIVED, which a 200 that wasn't JSON fails while satisfying
            // `status < 400`.
            val body = LoadFailure.loaded(res, "threads")
            if (body == null) {
                threadsFailed = LoadFailure.contentMessage(res, "threads", "your messages")
                return@LaunchedEffect
            }
            val arr = body.optJSONArray("threads")
            threads = (0 until (arr?.length() ?: 0)).mapNotNull { i ->
                arr?.optJSONObject(i)?.let { t ->
                    DmThread(
                        login = t.optString("login"),
                        name = t.optString("name").takeIf { it.isNotEmpty() },
                        avatar = t.optString("avatar"),
                        unread = t.optInt("unread"),
                        lastBody = t.optString("lastBody"),
                        lastAt = t.optLong("lastAt"), // unix seconds (worker INBOX_SQL MAX(created))
                    )
                }
            }
            app.fleet.refreshUnread()
        }
    }

    // skipPartiallyExpanded: at half height the thread's reply composer and newest
    // message sit below the fold, so a DM thread reads as read-only (audit #4).
    // Full-height also makes one back press dismiss instead of expanded→partial→gone.
    // iOS parity: MessagesView presents as a regular full sheet.
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        val with = openWith
        // One clock for all rows' relative ages, taken at composition (sheet
        // lifetime is seconds; no ticking needed — web recomputes per render too).
        val nowMs = remember { System.currentTimeMillis() }
        if (with == null) {
            LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
                item {
                    SheetTitle(Icons.Outlined.Forum, "messages")
                    Spacer(Modifier.height(12.dp))
                }
                if (threadsFailed != null) item {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        Text(threadsFailed!!, color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                        TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                } else if (threads == null) item { SheetLoading() }
                else if (threads!!.isEmpty()) item {
                    SheetEmpty(Icons.Outlined.Forum, "no messages yet", "DM any builder from their profile in the universe")
                }
                // Row anatomy (web MessagesHUD.tsx thread rows + iOS inbox): avatar,
                // handle + preview, trailing relative age, unread badge. lastAt was
                // fetched-but-dropped before this — a bare handle+preview list gave
                // no sense of recency (audit #8).
                items(threads.orEmpty(), key = { it.login }) { t ->
                    Row(
                        Modifier.fillMaxWidth().clickable { openWith = t.login }.padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (t.avatar.isNotBlank()) {
                            coil.compose.AsyncImage(
                                model = githubAvatar(t.avatar, 32),
                                contentDescription = "@${t.login} avatar",
                                modifier = Modifier.size(32.dp).clip(CircleShape),
                            )
                        } else {
                            Box(
                                Modifier.size(32.dp).clip(CircleShape).background(TinyGray.copy(alpha = 0.3f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(t.login.take(1).uppercase(), style = MaterialTheme.typography.labelSmall)
                            }
                        }
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(threadTitle(t.name, t.login), style = MaterialTheme.typography.bodyLarge,
                                color = if (t.unread > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                            Text(t.lastBody, style = MaterialTheme.typography.labelSmall, color = TinyGray, maxLines = 1)
                        }
                        if (t.lastAt > 0) {
                            Spacer(Modifier.width(8.dp))
                            Text(ago(t.lastAt, nowMs), style = MaterialTheme.typography.labelSmall, color = TinyGray)
                        }
                        if (t.unread > 0) {
                            Spacer(Modifier.width(6.dp))
                            // The clickable Row merges descendant semantics, so
                            // TalkBack reads the bare badge number as a trailing
                            // context-free "3" after the name/preview/age. Give
                            // the count its meaning ("3 unread"), mirroring web's
                            // MessagesHUD sr-only label (last-mile c117).
                            Badge(
                                containerColor = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.semantics {
                                    contentDescription = "${t.unread} unread"
                                },
                            ) { Text("${t.unread}") }
                        }
                    }
                }
            }
        } else {
            DmThreadView(app, with, onOpenProfile = onOpenProfile, onBack = { openWith = null })
        }
    }
}

@Composable
private fun DmThreadView(app: TinyApp, login: String, onOpenProfile: (String) -> Unit, onBack: () -> Unit) {
    // ⚠️ KEYED BY LOGIN, for the same reason `draft` is. A DM notification tapped
    // while a thread is already open re-seeds `openWith` (see MessagesSheet), so
    // this view survives a login→login jump — and an unkeyed `remember` would open
    // B still holding A's messages and A's failure. iOS clears all four states
    // explicitly when a thread is opened (Messages.swift:306); the key is Compose's
    // way of saying the same thing, and it also covers the deep-link path that has
    // no tap to hang the clearing off.
    var msgs by remember(login) { mutableStateOf<List<DmMessage>?>(null) }
    var loadFailed by remember(login) { mutableStateOf<String?>(null) }
    // Distinct from `loadFailed`: this arm has no retry, so it cannot be a caption.
    var peerGone by remember(login) { mutableStateOf(false) }
    // Saveable so the draft survives activity recreation (audit #1), but KEYED BY
    // LOGIN: saveable state restores by slot position, so an unkeyed draft typed to
    // thread A re-enters this same slot when thread B opens — and a message composed
    // for one person must never sit in another's composer. The key trades
    // cross-thread survival for correctness (iOS @State drafts reset the same way).
    // Cleared only after a confirmed-successful send below.
    var draft by androidx.compose.runtime.saveable.rememberSaveable(login) { mutableStateOf("") }
    var sendError by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    // One clock for every bubble's relative age, taken at composition (a thread
    // sheet lives seconds; web/iOS recompute per render too — no ticking needed).
    val nowMs = remember { System.currentTimeMillis() }

    fun reload() {
        scope.launch {
            val res = runCatching { app.api.getJson("/api/messages?with=$login") }.getOrNull()
            // One rule for all six list sheets ([LoadFailure]), asking whether
            // `messages` ARRIVED — a 200 that wasn't JSON fails that while satisfying
            // `status < 400`, and this is the sheet where the collapse reads worst: an
            // existing conversation would look emptied.
            val body = LoadFailure.loaded(res, "messages")
            if (body == null) {
                // Only surface it when we have nothing to show — a failed refresh AFTER
                // a good load keeps the existing thread rather than blanking it (iOS: a
                // retry-fails-after-load mustn't drop contents).
                when (val why = classifyThreadLoad(res)) {
                    is ThreadLoadFailure.Gone -> { peerGone = true; loadFailed = null }
                    is ThreadLoadFailure.Retryable -> { loadFailed = why.message; peerGone = false }
                }
                return@launch
            }
            // A success clears BOTH, or a peer who came back would keep their epitaph.
            loadFailed = null
            peerGone = false
            val arr = body.optJSONArray("messages")
            msgs = (0 until (arr?.length() ?: 0)).mapNotNull { i ->
                arr?.optJSONObject(i)?.let { m ->
                    DmMessage(
                        id = m.optString("id"),
                        direction = m.optString("direction"),
                        body = m.optString("body"),
                        viaTiny = m.optString("viaTiny").takeIf { it.isNotEmpty() },
                        created = m.optLong("created"), // unix seconds (worker messages.ts)
                    )
                }
            }
        }
    }
    fun send() {
        val body = draft.trim()
        if (body.isEmpty() || sending) return
        // State the real reason before the round-trip: the server's 400 would
        // surface as "send failed — try again", inviting a retry that can't work.
        dmSendRefusal(body)?.let { sendError = it; return }
        sending = true; sendError = null
        scope.launch {
            val res = runCatching {
                app.api.postJson("/api/messages", JSONObject().put("to", login).put("message", body))
            }.getOrNull()
            sending = false
            if (res != null && res.optInt("_status", 200) < 400) {
                draft = "" // clear only on success — draft survives failures
                reload()
            } else {
                sendError = "send failed — try again"
            }
        }
    }
    LaunchedEffect(login) {
        reload()
        technology.tiny.app.fleet.DmNotifier.clear(app, login) // dismiss its banner on open
    }
    // Messages arrive oldest→newest, so the newest sits at the bottom. Pin the view
    // there on open and after every send — otherwise the thread opens on the OLDEST
    // message and a just-sent DM lands off-screen (iOS Messages.swift scrollTo(last)).
    LaunchedEffect(msgs?.size) {
        val n = msgs?.size ?: 0
        if (n > 0) listState.animateScrollToItem(n - 1)
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("← back", color = TinyGray) }
            // The handle is the tap target into this person's profile (their tinys +
            // tools) — accent-colored to read as a link, like web's /@login byline.
            Text(
                "@$login",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
                // onClickLabel: TalkBack says "double tap to open profile" instead
                // of a bare unlabeled click on what looks like plain text.
                modifier = Modifier.clickable(onClickLabel = "open profile") { onOpenProfile(login) },
            )
        }
        // 560dp cap: the sheet presents full-height (skipPartiallyExpanded), and a
        // 400dp thread viewport left a third of it dead on tall phones. Still a cap,
        // not a fill — weight(fill=false) keeps short threads wrap-height.
        LazyColumn(state = listState, modifier = Modifier.weight(1f, fill = false).heightIn(max = 560.dp), contentPadding = PaddingValues(vertical = 8.dp)) {
            // The permanent verdict, and NO retry: retrying a resolved-and-absent peer
            // ends the same way every time, so offering the button invites a loop the
            // app already knows cannot finish (iOS Messages.swift:353).
            if (msgs == null && peerGone) item {
                Text(peerGoneLine(login), color = TinyGray, style = MaterialTheme.typography.bodyMedium,
                     modifier = Modifier.padding(vertical = 4.dp))
            } else if (msgs == null && loadFailed != null) item {
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text(loadFailed!!, color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { reload() }, contentPadding = PaddingValues(0.dp)) {
                        Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                    }
                }
            } else if (msgs == null) item { SheetLoading() }
            // Third state: a good load that returned nothing. Without this the empty
            // scroll area looks identical to a still-loading / flaky one and faintly
            // invites a redundant "hi" — iOS added the same affordance (Messages.swift
            // "No messages yet — say hi 👋", d597f67) and web's MessagesHUD has it too.
            else if (msgs!!.isEmpty()) item {
                Text("no messages yet — say hi 👋", color = TinyGray, style = MaterialTheme.typography.bodyMedium)
            }
            items(msgs.orEmpty(), key = { it.id }) { m ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    // Server emits direction "sent"|"received" (worker messages.ts:256,
                    // iOS Messages.swift checks "sent") — NOT "out". Outgoing = right-aligned.
                    horizontalArrangement = if (m.direction == "sent") Arrangement.End else Arrangement.Start,
                ) {
                    Surface(
                        // One bubble system app-wide (main-chat MessageBubble parity):
                        // sent = solid accent fill w/ black text, received = surface
                        // inside an accent hairline. DMs used a third, divergent style.
                        color = if (m.direction == "sent") MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.surface,
                        border = if (m.direction == "sent") null
                                else androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)),
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.widthIn(max = 280.dp),
                    ) {
                        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                            // A DM is raw user free-text, NOT markdown, so it skips the
                            // ProseText path that .bidi()'s every line — an Arabic/Hebrew
                            // DM would render forced-LTR (mis-placed trailing punctuation,
                            // wrong-end embedded Latin/URLs). .bidi() = TextDirection.Content
                            // resolves direction from the first strong-directional char, the
                            // Compose twin of web's dir="auto" (c113 MessagesHUD.tsx:513) +
                            // iOS's native AttributedString bidi. Matches the markdown
                            // bubble's own per-line .bidi() (Markdown.kt:190-217).
                            Text(m.body, style = MaterialTheme.typography.bodyLarge.bidi())
                            // Meta line "<age> · via <tiny>" (iOS Messages.swift:228 /
                            // web MessagesHUD.tsx:506). 60% of the bubble's own content
                            // color so it reads on both the accent (sent) and surface
                            // (received) fills. Timestamp was fetched-but-dropped before.
                            Text(
                                dmMeta(m.created, m.viaTiny, nowMs),
                                style = MaterialTheme.typography.labelSmall,
                                color = LocalContentColor.current.copy(alpha = 0.6f),
                            )
                        }
                    }
                }
            }
        }
        sendError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall) }
        Row(verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text("message @$login…") },
                // Hardware/Bluetooth-keyboard Enter sends; Shift+Enter inserts a newline
                // (web + the main composer c74 + iOS DM composer 15c30e6 all do this).
                modifier = Modifier.weight(1f).onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    val isEnter = e.key == Key.Enter || e.key == Key.NumPadEnter
                    if (isEnter && !e.nativeKeyEvent.isShiftPressed) { send(); true } else false
                },
                maxLines = 3,
            )
            Spacer(Modifier.width(8.dp))
            Button(
                enabled = draft.isNotBlank() && !sending,
                onClick = { send() },
            ) { Text(if (sending) "…" else "send") }
        }
    }
}

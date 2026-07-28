/**
 * Messages — the web MessagesHUD on iOS: user↔user DMs over /api/messages
 * (Bearer session; inbox = threads + unread, ?with= = one thread, POST =
 * send). Same worker D1 store — a DM sent from the phone pops up in the
 * web HUD and vice versa.
 */
import SwiftUI

/// The DM body limit — the same number `lib/chat/dm-send.ts` (DM_MAX_CHARS),
/// the worker (`messages.ts` MAX_BODY) and the web composer's `maxLength` use.
let kDmMaxChars = 2000

/// Characters as a PERSON counts them: Swift's `String.count` is already
/// grapheme clusters, so "👋" is 1 — which is what the server counts too now
/// (code points). This exists as a named function so the parity test can point
/// at one thing, and so nobody reaches for `.utf16.count`: the server-side bug
/// this guards against was exactly a length measured in UTF-16 units on one end
/// and code points on the other, which truncated a legal message mid-emoji.
func dmOverrun(_ text: String) -> Int {
    max(0, text.count - kDmMaxChars)
}

/// What to tell the user instead of sending. Nil = go ahead.
///
/// The server now REFUSES an over-long DM (400) rather than silently cutting it
/// at 2000 — a DM cannot be unsent, so truncating turns a recoverable "too long"
/// into an unrecoverable "they read half a sentence". That refusal reaches this
/// app as a bare "HTTP 400" through Api.friendlyHTTPError, which tells the user
/// nothing they can act on. So the client says it first, in its own words, and
/// keeps the draft.
func dmSendRefusal(_ text: String) -> String? {
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
    let over = dmOverrun(text)
    guard over > 0 else { return nil }
    return "\(over) character\(over == 1 ? "" : "s") too long — a DM can't be unsent, "
        + "so nothing was sent. Trim it to \(kDmMaxChars) or send it in parts."
}

struct DmThread: Identifiable, Equatable {
    var id: String { userId }
    let userId: String
    let login: String
    let name: String
    let unread: Int
    let lastBody: String
    let lastAt: Int
}

struct DmMsg: Identifiable, Equatable {
    let id: Int
    let direction: String // sent | received
    let body: String
    let created: Int
    let viaTiny: String?
}

@MainActor
final class MessagesModel: ObservableObject {
    @Published var threads: [DmThread] = []
    @Published var msgs: [DmMsg] = []
    @Published var loading = false
    /// Distinguishes "inbox is empty" from "couldn't reach the inbox"
    @Published var failed = false
    /// Same distinction for a single thread: without it a flaky-connection
    /// load leaves an existing conversation looking brand-new (blank scroll),
    /// inviting a redundant "hi" — the exact regression the web HUD guards
    /// against (MessagesHUD.tsx threadError). loading gates the spinner.
    @Published var threadLoading = false
    @Published var threadFailed = false
    /// A DM send that didn't land — surfaced inline so the user can retry
    /// (the draft is restored) instead of the message silently vanishing.
    @Published var sendError: String?
    /// Monotonic per-thread-load token. Each loadThread bumps it and captures
    /// its value; on resume it commits only if still the latest. Without this a
    /// slow load for thread A that resolves AFTER the user switched to thread B
    /// (tap A → back → tap B, uncancelled Tasks) would overwrite B's messages
    /// with A's — the wrong conversation's contents. Web guards this with
    /// activePeerRef (MessagesHUD.tsx:145); Android's per-login LaunchedEffect
    /// cancels the prior coroutine (Messages.kt); iOS had no guard at all.
    private var threadRequest = 0

    func loadInbox(token: String?) async {
        loading = true
        defer { loading = false }
        guard let d: [String: Any] = try? await Api.get("/api/messages", token: token) else {
            failed = true
            return
        }
        failed = false
        threads = ((d["threads"] as? [[String: Any]]) ?? []).map {
            DmThread(
                userId: $0["userId"] as? String ?? "",
                login: $0["login"] as? String ?? "?",
                name: $0["name"] as? String ?? "",
                unread: $0["unread"] as? Int ?? 0,
                lastBody: $0["lastBody"] as? String ?? "",
                lastAt: $0["lastAt"] as? Int ?? 0
            )
        }
    }

    func loadThread(_ peer: DmThread, token: String?) async {
        threadRequest += 1
        let req = threadRequest
        threadLoading = true
        // Only the latest load owns the spinner: a stale A-load returning while
        // B is still in flight must not clear B's threadLoading.
        defer { if req == threadRequest { threadLoading = false } }
        let login = peer.login.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? peer.login
        guard let d: [String: Any] = try? await Api.get("/api/messages?with=\(login)", token: token) else {
            // Drop a stale failure too: a slow A-load failing after the user
            // opened B must not flip B's thread into the error state.
            if req == threadRequest { threadFailed = true }
            return
        }
        // The user switched threads (or back to the inbox) while this was in
        // flight — committing now would swap in the wrong thread's messages.
        guard req == threadRequest else { return }
        threadFailed = false
        msgs = ((d["messages"] as? [[String: Any]]) ?? []).map {
            DmMsg(
                id: $0["id"] as? Int ?? 0,
                direction: $0["direction"] as? String ?? "received",
                body: $0["body"] as? String ?? "",
                created: $0["created"] as? Int ?? 0,
                viaTiny: $0["viaTiny"] as? String
            )
        }
    }

    /// Returns true iff the DM actually posted. On failure the caller keeps the
    /// text in the field — a `try?` that swallowed the throw (with the draft
    /// already cleared) meant a dropped connection or a worker 5xx silently ate
    /// the user's message with zero feedback, on the standing-priority DM path.
    @discardableResult
    func send(to peer: DmThread, text: String, token: String?) async -> Bool {
        do {
            _ = try await Api.post("/api/messages", token: token, body: ["to": peer.login, "message": text]) as [String: Any]
            sendError = nil
            await loadThread(peer, token: token)
            return true
        } catch {
            sendError = (error as? LocalizedError)?.errorDescription ?? "Couldn't send — try again."
            return false
        }
    }
}

func dmAgo(_ ts: Int) -> String {
    // A missing/zero server timestamp decodes to 0 (`as? Int ?? 0` on lastAt +
    // created), and now-0 ≈ 1.75e9s would render "~20000d". Floor a ≤0 ts to
    // "1s" instead — the same guard Activity.ago and the web MessagesHUD apply.
    let s = ts > 0 ? max(1, Int(Date().timeIntervalSince1970) - ts) : 1
    if s < 60 { return "\(s)s" }
    if s < 3600 { return "\(s / 60)m" }
    if s < 86400 { return "\(s / 3600)h" }
    return "\(s / 86400)d"
}

struct MessagesView: View {
    @EnvironmentObject var session: TinySession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var model = MessagesModel()
    @State private var peer: DmThread?
    @State private var draft = ""
    @State private var sending = false

    var body: some View {
        NavigationStack {
            Group {
                if let peer {
                    thread(peer)
                } else {
                    inbox
                }
            }
            .navigationTitle(peer.map { "@\($0.login)" } ?? "Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if peer != nil {
                        Button {
                            peer = nil
                            model.sendError = nil
                            Task { await model.loadInbox(token: session.token) }
                        } label: { Image(systemName: "chevron.left") }
                    } else {
                        Button("Done") { dismiss() }
                    }
                }
            }
            .task { await model.loadInbox(token: session.token) }
            // Opening a thread marks it read server-side — sync the badge
            .onDisappear { Task { await session.refreshUnread() } }
        }
    }

    private var inbox: some View {
        List {
            if model.threads.isEmpty {
                Text(model.loading ? "Loading…"
                     : model.failed ? "Couldn't load messages — check your connection and pull to retry."
                     : "No conversations yet. DMs sent from the web show up here.")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.threads) { t in
                Button {
                    peer = t
                    model.msgs = []
                    model.sendError = nil
                    model.threadFailed = false
                    Task { await model.loadThread(t, token: session.token) }
                } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(t.name.isEmpty ? "@\(t.login)" : t.name).font(.subheadline.weight(.medium))
                            Text(t.lastBody).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(dmAgo(t.lastAt)).font(.caption2).foregroundStyle(.tertiary)
                            if t.unread > 0 {
                                Text("\(t.unread)")
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(.green, in: Capsule())
                                    .foregroundStyle(.black)
                            }
                        }
                    }
                }
            }
        }
        .refreshable { await model.loadInbox(token: session.token) }
    }

    private func thread(_ peer: DmThread) -> some View {
        VStack(spacing: 0) {
            // Messages arrive oldest→newest (worker ORDER BY id DESC + reverse),
            // so the newest sits at the bottom. Pin the view there on open and
            // after every send — otherwise the thread opens on the OLDEST message
            // and a just-sent DM lands off-screen. Mirrors the main chat scroll
            // (Views.swift) and the web HUD's bottomRef.
            ScrollViewReader { proxy in
                ScrollView {
                    // Empty scroll area is ambiguous: a flaky-connection load of
                    // an EXISTING thread looks identical to a genuinely empty one
                    // and invites a redundant "hi". Distinguish the three states
                    // (web HUD parity — MessagesHUD.tsx Loading/threadError/empty).
                    if model.msgs.isEmpty {
                        if model.threadLoading {
                            HStack { ProgressView().scaleEffect(0.8); Text("Loading…").foregroundStyle(.secondary) }
                                .frame(maxWidth: .infinity).padding(.top, 40)
                        } else if model.threadFailed {
                            VStack(spacing: 12) {
                                Text("Couldn't load this conversation.").font(.subheadline).foregroundStyle(.secondary)
                                Button("Retry") { Task { await model.loadThread(peer, token: session.token) } }
                                    .buttonStyle(.bordered)
                            }
                            .frame(maxWidth: .infinity).padding(.top, 40)
                        } else {
                            Text("No messages yet — say hi 👋")
                                .font(.subheadline).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, 40)
                        }
                    }
                    LazyVStack(spacing: 8) {
                        ForEach(model.msgs) { m in
                            VStack(alignment: m.direction == "sent" ? .trailing : .leading, spacing: 2) {
                                Text(m.body)
                                    .font(.subheadline)
                                    .padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(
                                        m.direction == "sent" ? Color.green.opacity(0.22) : Color(.secondarySystemBackground),
                                        in: RoundedRectangle(cornerRadius: 14)
                                    )
                                Text("\(dmAgo(m.created))\(m.viaTiny.map { " · via \($0)" } ?? "")")
                                    .font(.caption2).foregroundStyle(.tertiary)
                            }
                            .frame(maxWidth: .infinity, alignment: m.direction == "sent" ? .trailing : .leading)
                            .id(m.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: model.msgs) {
                    guard let last = model.msgs.last else { return }
                    if reduceMotion { proxy.scrollTo(last.id, anchor: .bottom) }
                    else { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            // Surface a send failure inline — the draft below is preserved so
            // the user can just tap send again rather than retype.
            if let err = model.sendError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal).padding(.top, 4)
            }
            HStack(spacing: 8) {
                TextField("Message @\(peer.login)", text: $draft)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
                    // Hardware-keyboard Return sends, matching the main chat
                    // composer (Views.swift onSubmit) — before this, an iPad
                    // keyboard's Return did nothing and only the tap button sent.
                    .onSubmit { sendDraft(to: peer) }
                Button { sendDraft(to: peer) } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(sending ? .gray : .green)
                }
                .disabled(sending)
            }
            .padding()
        }
    }

    /// Send the trimmed draft. Shared by the send button and the keyboard
    /// Return key (onSubmit) so both paths behave identically. Keeps `text`
    /// in a local and only clears the field once the send lands — on failure
    /// the draft stays put + sendError shows, so the message is never lost.
    private func sendDraft(to peer: DmThread) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        // Say why before the round-trip: the server's refusal arrives as a bare
        // "HTTP 400", and the draft has to survive either way.
        if let refusal = dmSendRefusal(text) {
            model.sendError = refusal
            return
        }
        sending = true
        Task {
            let ok = await model.send(to: peer, text: text, token: session.token)
            if ok { draft = "" }
            sending = false
        }
    }
}

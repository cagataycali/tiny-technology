/**
 * Api — thin authenticated client for tiny.technology /api endpoints + SSE chat.
 * Bearer token rides the same lib/auth.ts path as the CLI (aud:'tiny-cli').
 */
import Foundation

/// Status-aware API failure — the user sees the difference between an
/// expired session and a down server (P0.4; was a blanket cannotParseResponse).
///
/// The payload carries the server's OWN `error` string alongside the status,
/// because for a whole class of statuses the status is all we know and the body
/// is all that's useful. `request` used to throw the code and drop the body on
/// the floor, so a route answering
/// `{"error":"message is 2043 characters, 43 over the 2000 limit — nothing was
/// sent. Split it into shorter messages."}` reached the user as "HTTP 400".
enum ApiError: LocalizedError {
    /// (status, the body's `error` string when it had one)
    case http(Int, String?)
    case badResponse

    var errorDescription: String? {
        switch self {
        // One HTTP-status→message table (Api.friendlyHTTPError) for BOTH the JSON
        // verbs (here) and the SSE stream — they used to be two divergent copies
        // that disagreed (403 mapped to "session expired" here, which is wrong:
        // the worker returns 403 for OWNERSHIP errors — re-auth won't help — not
        // an expired session). Delegate so they can't drift again.
        case .http(let c, let serverMsg): return Api.httpMessage(c, serverMsg)
        case .badResponse: return "Unexpected response from the server."
        }
    }

    /// The status, for callers that branch on it without a pattern match.
    var status: Int? {
        if case .http(let c, _) = self { return c }
        return nil
    }
}

/// 🔴 Why a list sheet is empty, in words that name ONE cause.
///
/// Five sheets — My Devices, Jobs, Memory, the memory graph and Activity — put
/// the same caption under their retry button: "Login required or network error".
/// Two mutually exclusive causes, with the app committing to neither, and the
/// remedies are opposite: an expired session needs a sign-out and back in, and
/// no amount of retrying will fix it; a dropped connection needs signal, and
/// signing out would only lose the token that still works. A reader who is told
/// both learns nothing, and "Login required" is the worker's own wire phrase
/// echoed onto a human surface.
///
/// The app was never actually guessing — `try?` was. Every one of those loads
/// discarded a thrown `ApiError` whose `errorDescription` is already
/// `Api.httpMessage`, the one table `HTTPErrorTests` exists to keep from
/// drifting. Catch it instead of dropping it and the sheet can just say which.
enum LoadFailure {
    /// The caption for a load that didn't happen.
    static func message(_ error: Error) -> String {
        // Already speaks the house language, including the server's own words
        // where the server is describing THIS request (a 424 naming the
        // dependency), so a 401 reads the same here as everywhere else.
        // (`localizedDescription`, not `errorDescription ?? …`: the optional
        // form would need a fallback line for a state this enum cannot be in,
        // and copy nobody can reach is copy nobody can check. A test asserts
        // the LocalizedError bridging really does hand back the table's line.)
        if let api = error as? ApiError { return api.localizedDescription }
        // The only way to get here with nothing having arrived. URLError's own
        // description names the cause ("The Internet connection appears to be
        // offline") but never the remedy; status 0 is the house code for it.
        if error is URLError { return Api.friendlyHTTPError(0) }
        // ⚠️ Bytes DID arrive and weren't JSON — `Api.get`'s
        // `JSONSerialization` throws an NSCocoaError, not an `ApiError`, and a
        // mid-redeploy HTML error page served with a 200 is the everyday way
        // that happens. "Check your connection" would blame the wrong thing.
        return ApiError.badResponse.localizedDescription
    }

    /// The caption for a failed CONTENT load — a list or a profile someone asked
    /// to SEE, as opposed to a message they sent.
    ///
    /// ⚠️ `message` ends at `Api.friendlyHTTPError`, and that is the CHAT table:
    /// it words 404 as "That tiny doesn't exist" and 402 as "This tiny charges
    /// per message". On a community list or a builder profile those are
    /// confident answers to a question nobody asked, about a thing that is not a
    /// tiny — the same defect the devices sheet's revoke had (`4b91ceac`), and
    /// worse than a bare number, because a number is merely unhelpful.
    ///
    /// The table is right wherever it describes the TRANSPORT instead of a chat:
    /// the `statusOwnsTheMessage` set (401, 0, 5xx) plus 424's degraded
    /// dependency. And a server that sent its own `error` string is describing
    /// THIS request, so it still wins — `httpMessage` already prefers it, and
    /// that path is untouched here. What's left is a non-owning status with no
    /// body to explain itself, which is exactly the worker's router-level
    /// `404 Not Found.` reached by a stale build. For that: the code, and
    /// nothing the app can't back up.
    static func contentMessage(_ error: Error) -> String {
        if case .http(let status, let serverMsg)? = error as? ApiError,
           (serverMsg ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           !Api.statusOwnsTheMessage(status), status != 424 {
            return "Couldn't load it — try again (HTTP \(status))"
        }
        return message(error)
    }

    /// The same rule for a caller holding a status rather than a thrown error —
    /// the two panels that fetch `plugin.tiny.technology` directly, where `Api`'s
    /// own base URL doesn't apply. One rule, two doors.
    static func contentMessage(status: Int, serverMsg: String? = nil) -> String {
        contentMessage(ApiError.http(status, serverMsg))
    }
}

/// Pull the first structured object out of a tool-result `content` array. The
/// Strands SDK wraps an object return as a `{json:{…}}` block; a string return
/// arrives as `{text:"…"}` (which, for our JSON-returning tools, is a JSON
/// string). Handles both so a tool result reads the same regardless of wrapping.
func firstToolJson(_ content: Any?) -> [String: Any]? {
    guard let blocks = content as? [[String: Any]] else { return nil }
    for b in blocks {
        if let j = b["json"] as? [String: Any] { return j }
        if let t = b["text"] as? String,
           let d = t.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { return obj }
    }
    return nil
}

enum Api {
    /// Configurable (Settings → Advanced) — defaults to production
    static var base: String { Config.serverBase }

    /// The transport every JSON verb uses. A var only so a test can stub it:
    /// the interesting part of `request` is what it does with a non-2xx
    /// RESPONSE, and a pure helper test can't see that wiring at all — the
    /// original bug (throw the code, drop the body) lived in exactly the two
    /// lines no pure test touches. See TinyTests/ApiTransportTests.
    nonisolated(unsafe) static var transport: @Sendable (URLRequest) async throws -> (Data, URLResponse) = {
        try await URLSession.shared.data(for: $0)
    }

    /// One request core — every JSON verb rides this (was 5 copy-pastes)
    private static func request(_ path: String, method: String = "GET", token: String? = nil, body: [String: Any]? = nil) async throws -> Data {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = method
        // Bound every JSON verb (the web's AbortSignal.timeout house rule). The
        // URLSession default is 60s/7-day; without this, a stalled half-open
        // connection leaves the panels that await this (.loading in Universe/
        // Jobs/Devices/Memory/Messages) spinning with no escape to .failed +
        // Retry. 30s is generous for a JSON call yet still surfaces a hang.
        req.timeoutInterval = 30
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, resp) = try await transport(req)
        if let code = (resp as? HTTPURLResponse)?.statusCode, !(200...299).contains(code) {
            // Carry the body's own message with the code. Every /api route that
            // rejects a request answers `{ error: "<why>" }`, and for a 400 the
            // why is the ONLY useful part — the status table can say nothing
            // better than "HTTP 400", and a caller who reads only the code has
            // to invent a cause. Dropping it here is what made an actionable
            // refusal ("2043 characters, 43 over the limit") unreadable.
            throw ApiError.http(code, serverError(in: data))
        }
        return data
    }

    /// The `error` string from a JSON error body, or nil when there isn't one.
    ///
    /// Trimmed and length-bounded because this becomes user-visible copy: a
    /// route that returns an HTML error page or a stack trace must not be
    /// pasted into a label. Non-JSON, non-string, and blank all read as "the
    /// server said nothing" so the status table stays in charge.
    static func serverError(in data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["error"] as? String else { return nil }
        let msg = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return nil }
        return String(msg.prefix(300))
    }

    static func get<T>(_ path: String, token: String?) async throws -> T {
        let data = try await request(path, token: token)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? T else { throw ApiError.badResponse }
        return obj
    }

    /// The `Codable` twin of `get`: the raw body, with the SAME failure
    /// contract — the 30s bound, the Bearer header, and `ApiError.http(code,
    /// serverError(in:))` on a non-2xx.
    ///
    /// A caller with a `Decodable` row type used to reach past all of that to a
    /// bare `URLSession` and `try? JSONDecoder().decode`, which loses the status
    /// entirely. That is how an expired session became "No calls yet": the
    /// refusal body decoded cleanly into a struct of optionals, and a screen
    /// that never learned a status has nothing to report.
    static func getData(_ path: String, token: String?) async throws -> Data {
        try await request(path, token: token)
    }

    static func post<T>(_ path: String, token: String?, body: [String: Any]) async throws -> T {
        let data = try await request(path, method: "POST", token: token, body: body)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? T else { throw ApiError.badResponse }
        return obj
    }

    static func postRaw(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        let data = try await request(path, method: "POST", body: body)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    static func putJson(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        let data = try await request(path, method: "PUT", body: body)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    /// Authenticated GET that returns the parsed body EVEN on non-2xx (the read
    /// twin of `postBody`).
    ///
    /// `Api.get` throws `ApiError.http` and the body is lost — fine for routes
    /// whose failures are all the same, wrong for one that answers a TYPED
    /// failure the UI must distinguish. /api/devices/endpoint replies 502
    /// { unreachable | timeout | unauthorized } and the panel says something
    /// different for each: a thinking robot is not an absent one, and a rejected
    /// credential is not a network problem. `timeoutSeconds` is a parameter
    /// because a polled read wants a tighter bound than the 30s JSON house rule.
    /// nil only on a true transport failure (no response at all).
    static func getBody(_ path: String, token: String?, timeoutSeconds: TimeInterval = 30) async -> [String: Any]? {
        var req = URLRequest(url: URL(string: base + path)!)
        req.timeoutInterval = timeoutSeconds
        // A polled read must never be served from the cache — a stale frame or
        // reading is a lie about now.
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Authenticated POST that returns the parsed body EVEN on non-2xx (twin of
    /// `putBody`). Some POST routes answer with a structured error the UI must
    /// show rather than throw away — e.g. /api/tools/install replies 402
    /// { payment_required, price_micro, balance_micro, error } for a priced
    /// tool. `Api.post` throws on non-2xx, so that body is lost; this preserves
    /// it. nil only on a true transport failure (no response at all).
    static func postBody(_ path: String, token: String?, body: [String: Any]) async -> [String: Any]? {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 30
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Authenticated PUT that returns the parsed body EVEN on non-2xx (like the
    /// wallet POST helper). The x402 execute route answers 402/409/410 with an
    /// `error` string the UI must show, so we must NOT throw those away. nil on
    /// a transport failure (no response at all).
    static func putBody(_ path: String, token: String?, body: [String: Any]) async -> [String: Any]? {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 120 // settlement can take a while on-chain
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func patchJson(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        let data = try await request(path, method: "PATCH", body: body)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    /// DELETE with a JSON body — the /api/tools + /api/jobs destructive shape
    /// ({name}/{id} rides the body, not the path). Non-2xx throws ApiError.http
    /// like every other verb, so callers can tell a 404 (already gone) apart.
    static func deleteJson(_ path: String, token: String? = nil, body: [String: Any]) async throws -> [String: Any] {
        let data = try await request(path, method: "DELETE", token: token, body: body)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    /// Statuses where THIS APP knows something the server cannot phrase.
    ///
    /// 401: the worker says "login required", which is not actionable on a native
    ///      app that is holding a stored token — the user has to sign out and in.
    /// 5xx: the body is an internal detail ("messages unavailable"); the useful
    ///      part is that it's transient and worth retrying.
    /// 0:   there was no response, so there is no body to prefer.
    ///
    /// Every OTHER status yields to the server, because the server is describing
    /// THIS request while the table can only describe the number. A 400 is the
    /// clearest case — the table's best is literally "HTTP 400" — and a 402 from
    /// /api/chat carries the live price and balance, which beats a static line.
    static func statusOwnsTheMessage(_ status: Int) -> Bool {
        status == 401 || status == 0 || (500...599).contains(status)
    }

    /// The line to show for a failed request: the server's own explanation when
    /// it has one and the status isn't self-explaining, else the status table.
    ///
    /// The code is appended to a server message so a support conversation still
    /// has it — the curated lines already carry theirs.
    static func httpMessage(_ status: Int, _ serverMsg: String? = nil) -> String {
        guard let msg = serverMsg?.trimmingCharacters(in: .whitespacesAndNewlines),
              !msg.isEmpty, !statusOwnsTheMessage(status)
        else { return friendlyHTTPError(status) }
        return "\(msg) (HTTP \(status))"
    }

    /// Status → something a human can act on (P0.4, north-star ledger)
    static func friendlyHTTPError(_ status: Int) -> String {
        switch status {
        case 401: return "Session expired — sign out and back in (HTTP 401)"
        case 402: return "This tiny charges per message — top up at tiny.technology/wallet (HTTP 402)"
        // 403 is an OWNERSHIP error (e.g. a tiny/share that belongs to another
        // account), not an expired session — re-auth won't fix it.
        case 403: return "Not allowed — this belongs to another account (HTTP 403)"
        case 404: return "That tiny doesn't exist (HTTP 404)"
        case 413: return "Message or attachments too large (HTTP 413)"
        // 424 = the worker degraded a dependency (tools/prefs/wallet return it on
        // a backend hiccup); transient, so say "try again" not "failed".
        case 424: return "Backend unavailable — take a breath, try again soon (HTTP 424)"
        case 429: return "Free-tier limit hit — wait a bit, or add your own key on the web (HTTP 429)"
        case 500...599: return "Server hiccup (HTTP \(status)) — usually passes, try again"
        case 0: return "No response — check your connection"
        default: return "HTTP \(status)"
        }
    }

    /** One-shot chat: buffer the SSE stream, return final text (relay replies).
        Continuity rides along so relay answers know what you've told your tiny.
        onEvent receives every non-text event — relay callers execute device
        tools through it, so "make my phone vibrate" works from the web too
        (this type also compiles into the watch target, so the iOS-only
        gadget classes can't be referenced here directly). */
    static func chatOnce(token: String?, message: String, tiny: String = "tiny", extraSystem: String? = nil,
                         onEvent: (@Sendable (ChatEvent) async -> Void)? = nil) async throws -> String {
        var text = ""
        for try await ev in chatStream(token: token, message: message, tiny: tiny, history: [], extraSystem: extraSystem) {
            if case .text(let t) = ev { text += t } else { await onEvent?(ev) }
        }
        return text
    }

    enum ChatEvent {
        case text(String)
        case toolStart(String)
        case toolEnd(String)
        /// speak tool — the agent wants this said aloud (web renders a card; we
        /// do too). voice is the tool's Kokoro-family id (af_heart, bm_george…)
        /// — Speech maps it to the best installed neural voice of the same
        /// accent+gender, so the agent's voice choice means something here too.
        case speak(id: String, text: String, voice: String?)
        /// suggest_followups tool — tappable next-prompt chips
        case followups([String])
        /// remember tool — store a durable client-side memory (web: localStorage; here: Documents)
        case remember(content: String, tags: [String]?)
        /// forget tool — delete a memory by substring/id match
        case forget(match: String)
        /// spawn_agents tool — fan-out tree: tasks known at call time…
        case spawnTasks(id: String, prompts: [String])
        /// …results land with the tool result (JSON text payload)
        case spawnResults(id: String, resultsJson: String)
        /// render_ui tool — props JSON renders natively (Swift Charts / key-values);
        /// componentCode is React source and is NEVER evaluated here
        case renderUi(id: String, title: String?, propsJson: String)
        case done
        case error(String)
        /// reasoningDelta — the model's visible thinking (collapsible section)
        case reasoning(String)
        /// modelMetadataEvent — token usage for the turn (web's tok tag);
        /// carries the resolved modelId + cache-read count so the client can
        /// price the turn (ModelPricing), matching web/android's per-turn ~$.
        case usage(input: Int, output: Int, cacheRead: Int, modelId: String?)
        /// Non-fatal stream annotation (e.g. dropped-events warning)
        case note(String)
        /// manage_messages tool — agent-driven history surgery (client executes)
        case manageMessages(action: String, from: Int?, to: Int?, summary: String?)
        /// vibrate tool — physical haptic pattern on this phone
        case vibrate(pattern: String, times: Int, intensity: Double)
        /// flashlight tool — torch on/off/blink
        case flashlight(mode: String, times: Int, seconds: Double)
        /// generic fire-and-forget device action (clipboard/brightness/sound…);
        /// args ride as JSON so the event stays Sendable
        case deviceAction(name: String, argsJson: String)
        /// agent map tools (add_map_marker/fly_to_location/…) — pins/camera
        /// on the live map (web __tinyMapBridge / Android AgentMap parity);
        /// args ride as JSON, the watch just ignores these
        case mapTool(name: String, argsJson: String)
        /// generate_image tool — ROUND-TRIP device tool: this phone generates
        /// on-device (ImageCreator), uploads to /api/media, and posts the
        /// outcome to /api/chat/tool-result, which the server callback is
        /// polling back into the agent loop (the model SEES the image)
        case generateImage(id: String, prompt: String, style: String)
        /// screenshot tool — ROUND-TRIP device tool (generate_image's twin, but
        /// CAPTURE not generate): with the user's per-capture consent this phone
        /// grabs one whole-screen ReplayKit frame, uploads to /api/media, and
        /// posts the outcome to /api/chat/tool-result, which the server callback
        /// is polling back into the loop (the model SEES the screen). `reason`
        /// is the agent's stated purpose, shown in the consent prompt.
        case screenshot(id: String, reason: String)
        /// meta_take_photo tool — screenshot's ROUND-TRIP twin through the
        /// Meta glasses camera (what the USER is looking at). The app-target
        /// executor lives in Wearables.swift; watch/widget targets decode the
        /// event and ignore it (no MWDAT there).
        case metaTakePhoto(id: String)
        /// meta_record_video — TOGGLE recording through the glasses camera
        /// (start on first call, stop+upload on second; GlassesRecorder).
        case metaRecordVideo(id: String)
        /// meta_listen — N seconds of the glasses mic → on-device transcript
        /// posted to the mailbox (audio never leaves the phone).
        case metaListen(id: String, seconds: Int)
        /// meta_glasses_status — instant facts from state the app holds.
        case metaGlassesStatus(id: String)
        /// pay_x402 tool — CONFIRM-EVERY-PAYMENT. The tool returns a signed
        /// quote (no money moved); the user must approve. We surface the quote
        /// so the bubble can render a native Approve/Decline card whose Approve
        /// tap calls PUT /api/x402/pay to settle. Web parity: PayReceipt.
        case payQuote(id: String, quote: String, priceMicro: Int, network: String?, payee: String?, expiresAt: Double?, message: String, url: String?)
        /// pay_x402 tool result that is NOT a quote — a terminal outcome the user
        /// can't act on: the tool failed to even mint a quote (login/allowlist/
        /// over-cap/unparseable 402 → ok:false), or the target was FREE (returned
        /// 200, no 402 → ok:true, no quote). Without this the iOS bubble showed
        /// only the generic gear tool-chip for these cases while web (PayReceipt
        /// toolFailed / "No payment needed") and Android (PayReceiptCard) both
        /// render an explicit terminal card. `failed` distinguishes the two.
        case payResult(id: String, failed: Bool, error: String?)
        /// 402 payment_required from /api/chat — the tiny is PAID and either the
        /// wallet is short (balanceMicro < price) or the caller is signed out.
        /// Surfaces a native paywall card (price + balance + Add funds / Retry,
        /// or Sign in) instead of a dead red error string. Web parity: the
        /// Chat.tsx paywall bubble. Retry re-sends the held prompt once funded.
        case paywall(priceMicro: Int, balanceMicro: Int, signedOut: Bool)
    }

    /** Streaming chat over the same SSE wire the web client speaks. */
    static func chatStream(token: String?, message: String, tiny: String, history: [[String: Any]], extraSystem: String? = nil, userBlocks: [[String: Any]]? = nil) -> AsyncThrowingStream<ChatEvent, Error> {
        let (stream, continuation) = AsyncThrowingStream<ChatEvent, Error>.makeStream()

        // Build the request OUTSIDE the Task: [[String: Any]] is not Sendable,
        // but Data/URLRequest are — serialize first, capture only Sendables.
        // Platform note rides as a system message (the route folds those into
        // the prompt) — it steers render_ui toward props the native renderer
        // can draw, since componentCode never executes on iOS.
        var platformNote = """
            📱 Native iOS app: replies render in the tiny iOS app. \
            render_ui: componentCode does NOT run here — put the displayable data in `props` \
            (e.g. {"data": [{"label": "Mon", "value": 12}, …]} plus a `title`); charts/key-values render natively from props. \
            speak: plays through the phone speaker. \
            vibrate: REALLY buzzes this phone — patterns (heartbeat/sos/wave/escalate/long…), repeats, intensity all work. \
            flashlight: controls the real torch (on/off/blink). \
            copy_to_clipboard / set_brightness / play_sound also act on THIS physical phone. \
            generate_image: renders ON this phone's Neural Engine — the finished image comes back to you AND shows in the chat. \
            Keep replies mobile-width friendly.
            """
        // 🕶️ Only builds that carry the DAT executor advertise the glasses
        // tool (watch/widget targets compile this file without MWDAT).
        #if canImport(MWDATCore) && canImport(MWDATCamera)
        platformNote += " meta_take_photo: one real photo through the user's Meta glasses (when linked — the extra system context says so) showing what they are physically LOOKING AT."
        #endif
        var messages: [[String: Any]] = [[
            "role": "system",
            "content": [["text": platformNote]],
        ]]
        // Continuity context (turn log + memories) rides as a second system
        // message — exactly how the web injects buildContinuityContext()
        if let extraSystem, !extraSystem.isEmpty {
            messages.append(["role": "system", "content": [["text": extraSystem]]])
        }
        messages += history
        // userBlocks (text + image blocks, AttachmentCodec.blocks) when the
        // message carries photos; plain text block otherwise
        messages.append(["role": "user", "content": userBlocks ?? [["text": message]]])
        let body = (try? JSONSerialization.data(withJSONObject: ["messages": messages])) ?? Data()

        var req = URLRequest(url: URL(string: base + "/api/chat")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The explicit call-site tiny WINS when it names a specific tiny —
        // the Universe / "/tiny <name>" switch (Views.switchTiny) passes e.g.
        // "garden" and MUST route there, even for users who configured a
        // custom default tiny in Settings. Only when the caller passes the
        // "tiny" default (main chat surface at first launch, relay/device
        // paths that don't thread a name) do we fall back to the user's
        // configured tiny. Prior logic had this inverted (Config always won
        // over a non-default literal), so switching tinys silently answered
        // as the configured tiny while the UI showed the picked one.
        req.setValue(tiny != "tiny" ? tiny : Config.tinyName, forHTTPHeaderField: "x-tiny-name")
        req.setValue("tiny-ios", forHTTPHeaderField: "x-tiny-session")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        // BYO-model: the user's provider/key selection travels as the same
        // x-tiny-model-* headers the web sends (see ModelConfig). Empty for the
        // free default, so this is a no-op unless a key is configured.
        for (field, value) in ModelConfigStore.headers() {
            req.setValue(value, forHTTPHeaderField: field)
        }
        req.httpBody = body
        req.timeoutInterval = 300

        let request = req
        let task = Task {

                do {
                    let (bytes, resp) = try await URLSession.shared.bytes(for: request)
                    let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    guard status == 200 else {
                        // The paywall returns a rich, actionable JSON body on 402
                        // ("Insufficient balance: … your wallet has $X. Top up at
                        // /wallet.") with the live price/balance — far better than
                        // the static status string. Drain the (small, non-SSE)
                        // error body and prefer its `error` field; fall back to
                        // the status table when there's no usable message.
                        var serverMsg = ""
                        var payObj: [String: Any]?
                        if let acc = try? await bytes.reduce(into: Data(), { $0.append($1) }),
                           let obj = try? JSONSerialization.jsonObject(with: acc) as? [String: Any] {
                            payObj = obj
                            if let e = obj["error"] as? String, !e.isEmpty { serverMsg = e }
                        }
                        // 402 + payment_required → a structured paywall, not a
                        // dead-end error. Surface the price/balance so the bubble
                        // can render Add funds / Retry (or Sign in). Web parity:
                        // Chat.tsx:1255. Prefer the server's authoritative
                        // `signed_out` flag (route.ts) — the balance-absent +
                        // "sign in"-copy derivation is the OTA fallback for an
                        // older server that predates the flag.
                        if status == 402, let obj = payObj, (obj["payment_required"] as? Bool) == true {
                            let price = (obj["price_micro"] as? NSNumber)?.intValue ?? 0
                            let balance = (obj["balance_micro"] as? NSNumber)?.intValue ?? 0
                            let signedOut = (obj["signed_out"] as? Bool)
                                ?? (balance == 0
                                    && (serverMsg.range(of: "sign in", options: .caseInsensitive) != nil))
                            continuation.yield(.paywall(priceMicro: price, balanceMicro: balance, signedOut: signedOut))
                            continuation.yield(.done)
                            continuation.finish()
                            return
                        }
                        // Same precedence rule as the JSON verbs (httpMessage):
                        // the server's line wins unless the status is one only
                        // this app can phrase. Delegating keeps the stream and
                        // the verbs from drifting apart again.
                        continuation.yield(.error(Self.httpMessage(status, serverMsg)))
                        continuation.yield(.done)
                        continuation.finish()
                        return
                    }
                    // Frame decoding, seq accounting and the toolUseId→name memory
                    // all live in ChatStreamDecoder — pure, and therefore tested
                    // (TinyTests/ChatStreamDecoderTests). This loop owns only the
                    // socket. See that file for why the name has to be remembered:
                    // an unnamed tool result used to drop its whole branch, which
                    // is how a pay_x402 quote card could never appear.
                    var decoder = ChatStreamDecoder()
                    for try await line in bytes.lines {
                        for event in decoder.decode(line: line) { continuation.yield(event) }
                    }
                    if let note = decoder.droppedNote {
                        continuation.yield(.note(note))
                    }
                    continuation.yield(.done)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }
}

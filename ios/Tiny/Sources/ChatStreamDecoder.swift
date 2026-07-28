/**
 * ChatStreamDecoder — one SSE frame in, zero or more ChatEvents out.
 *
 * Lifted out of `Api.chatStream`'s Task, where it was ~150 lines of `if let`
 * nested inside a live `URLSession.bytes` loop: correct or not, none of it could
 * be tested without a network and a server, so none of it was. Everything here
 * is pure and synchronous — the Task keeps the socket, this owns the decisions.
 *
 * It is also STATEFUL by necessity, and that state is the point of the file:
 *
 * The tool-result branches are keyed on the tool's NAME, but a result event does
 * not reliably carry one. The SDK omits `toolUse` on some after-events, and the
 * name has to be recovered from the id — which is exactly what the web client
 * has always done (`Chat.tsx`: `toolCalls.find(t => t.id === toolUseId)`, the
 * name captured at the block-start event). iOS instead read `tr["name"]` and
 * dropped the whole branch when it was absent, so a nameless pay_x402 result
 * meant no quote card at all: the payment UI simply never appeared. That is
 * cause 3 in the gaps report, and the reason this decoder remembers pairings.
 *
 * The server learned the same trick server-side (cycle 10, lib/chat/events.ts
 * ToolNames), so this is the THIRD line of defence, not the first. It is worth
 * having anyway: the two upstream fallbacks live in one process on one
 * deployment, and this one keeps working against an older server — which, for a
 * shipped iOS build that updates on Apple's schedule, is the case that matters.
 */
import Foundation

/// Remembers `toolUseId → name` for one turn, and answers the question the
/// result branches actually have: "what tool is this the result of?"
///
/// Deliberately a class with an explicit lifetime rather than a global: two
/// concurrent streams (main chat + a relay turn) must not see each other's
/// pairings, and a turn's map must be collectable when the turn ends.
final class ChatToolNames {
    /// Bound, mirroring the server's MAX_REMEMBERED_TOOLS: a runaway tool loop
    /// can't grow this without limit. Keeps the FIRST pairing for an id and
    /// stops growing rather than evicting — evicting could drop the very entry
    /// a pending result needs, which is the bug this whole file exists to fix.
    static let maxRemembered = 512

    private var names: [String: String] = [:]

    var count: Int { names.count }

    func remember(id: Any?, name: Any?) {
        guard let id = id as? String, !id.isEmpty,
              let name = name as? String, !name.isEmpty else { return }
        if names[id] != nil || names.count >= Self.maxRemembered { return }
        names[id] = name
    }

    /// The name the event carried, else the one we saw at this call's start.
    /// Order matters: an explicit name on the wire always wins, so this can
    /// never *change* a correctly-named event, only rescue an unnamed one.
    func resolve(name: Any?, id: Any?) -> String? {
        if let n = name as? String, !n.isEmpty { return n }
        guard let id = id as? String, !id.isEmpty else { return nil }
        return names[id]
    }
}

/// Decodes the wire vocabulary `lib/chat/events.ts` emits.
struct ChatStreamDecoder {
    /// Per-turn tool-name memory. Owned here so `Api.chatStream` doesn't have to
    /// know it exists.
    let toolNames = ChatToolNames()

    /// Monotonic `seq` tracking — a jump means frames were lost in transit (web
    /// Chat.tsx checks the same way), and the user deserves to be told the reply
    /// may be missing pieces rather than silently trusting it.
    private(set) var lastSeq = -1
    private(set) var dropped = 0

    /// The note to emit at end-of-stream, or nil when nothing was lost.
    var droppedNote: String? {
        guard dropped > 0 else { return nil }
        return "⚠️ \(dropped) stream event\(dropped == 1 ? "" : "s") dropped — this reply may be incomplete"
    }

    /// One `data:` line → the events it produces, in order.
    ///
    /// Returns [] for the frames that carry no user-visible meaning (keepalives,
    /// `[DONE]`, lifecycle markers, unparseable payloads) — the caller yields
    /// whatever comes back and needs no cases of its own.
    mutating func decode(line: String) -> [Api.ChatEvent] {
        guard line.hasPrefix("data:") else { return [] }
        let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
        // Keepalives and the terminator carry nothing and are not losses.
        guard !payload.isEmpty, payload != "[DONE]" else { return [] }

        guard let obj = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
              let type = obj["type"] as? String else {
            // An unparseable frame is a LOST frame, and `seq` can never notice
            // because seq was inside it. Counting it here is the only way the
            // user hears about it at all.
            //
            // Not hypothetical: JSONSerialization REJECTS a numeric literal
            // outside Double's range (`1e999`, `1e309`) and fails the ENTIRE
            // object — so one absurd number in a pay_x402 quote takes the whole
            // card with it, which is the same containment failure `safeMicro`
            // guards one level down. A guarantee about a type is not a guarantee
            // about the parser that fills it, and there is no lenient mode to
            // ask for here — so the honest move is to make the loss visible
            // rather than pretend the frame never existed.
            dropped += 1
            return []
        }
        return decode(event: obj, type: type)
    }

    /// The already-parsed form, so tests can hand over a dictionary and the
    /// framing above stays a separate concern.
    mutating func decode(event obj: [String: Any], type: String) -> [Api.ChatEvent] {
        if let seq = obj["seq"] as? Int {
            if lastSeq >= 0, seq > lastSeq + 1 { dropped += seq - lastSeq - 1 }
            lastSeq = seq
        }

        switch type {
        case "modelContentBlockDeltaEvent":
            var out: [Api.ChatEvent] = []
            if let t = obj["textDelta"] as? String { out.append(.text(t)) }
            if let r = obj["reasoningDelta"] as? String { out.append(.reasoning(r)) }
            return out

        // The EARLIEST point a pairing is known, and the reason a tool whose
        // before-event never fires is still nameable at its result. The server
        // remembers here too (events.ts:101) — this is the client's own copy.
        case "modelContentBlockStartEvent":
            guard let start = obj["toolStart"] as? [String: Any] else { return [] }
            toolNames.remember(id: start["toolUseId"], name: start["name"])
            return []

        case "beforeToolCallEvent":
            return decodeBeforeToolCall(obj)

        case "afterToolCallEvent":
            return decodeAfterToolCall(obj)

        case "modelMetadataEvent":
            guard let u = obj["usage"] as? [String: Any] else { return [] }
            let inTok = (u["inputTokens"] as? Int) ?? 0
            let outTok = (u["outputTokens"] as? Int) ?? 0
            let cacheRead = (u["cacheReadInputTokens"] as? Int) ?? 0
            guard inTok > 0 || outTok > 0 else { return [] }
            return [.usage(input: inTok, output: outTok, cacheRead: cacheRead, modelId: obj["modelId"] as? String)]

        case "error":
            return [.error(String(describing: obj["error"] ?? "unknown"))]

        default:
            return []
        }
    }

    // MARK: - tool lifecycle

    private mutating func decodeBeforeToolCall(_ obj: [String: Any]) -> [Api.ChatEvent] {
        guard let tc = obj["toolCall"] as? [String: Any] else { return [] }
        // Remember before resolving: a before-event names its own call, and this
        // is the pairing every later result depends on.
        toolNames.remember(id: tc["toolUseId"], name: tc["name"])
        guard let n = toolNames.resolve(name: tc["name"], id: tc["toolUseId"]) else { return [] }

        var out: [Api.ChatEvent] = [.toolStart(n)]
        // Client-executed tools ride the same event the web client watches —
        // input is complete at this point.
        let input = tc["input"] as? [String: Any]
        // A synthesized id keeps every downstream card addressable; only used
        // when the server sent none (it always does — this is belt and braces).
        let id = tc["toolUseId"] as? String ?? UUID().uuidString

        switch n {
        case "speak":
            if let text = input?["text"] as? String {
                out.append(.speak(id: id, text: text, voice: input?["voice"] as? String))
            }
        case "suggest_followups":
            if let chips = input?["chips"] as? [String], !chips.isEmpty { out.append(.followups(chips)) }
        case "remember":
            if let content = input?["content"] as? String {
                out.append(.remember(content: content, tags: input?["tags"] as? [String]))
            }
        case "forget":
            if let match = input?["match"] as? String { out.append(.forget(match: match)) }
        case "spawn_agents":
            if let tasks = input?["tasks"] as? [[String: Any]] {
                let prompts = tasks.compactMap { $0["prompt"] as? String }
                if !prompts.isEmpty { out.append(.spawnTasks(id: id, prompts: prompts)) }
            }
        case "manage_messages":
            if let action = input?["action"] as? String {
                out.append(.manageMessages(
                    action: action,
                    from: input?["from"] as? Int,
                    to: input?["to"] as? Int,
                    summary: input?["summary"] as? String))
            }
        case "vibrate":
            out.append(.vibrate(
                pattern: input?["pattern"] as? String ?? "tap",
                times: input?["times"] as? Int ?? 1,
                intensity: (input?["intensity"] as? NSNumber)?.doubleValue ?? 1.0))
        case "flashlight":
            if let mode = input?["mode"] as? String {
                out.append(.flashlight(
                    mode: mode,
                    times: input?["times"] as? Int ?? 5,
                    seconds: (input?["seconds"] as? NSNumber)?.doubleValue ?? 10))
            }
        // Names inlined: Api.swift also compiles into the watch target, where
        // DeviceTools (UIKit) doesn't exist.
        case "copy_to_clipboard", "set_brightness", "play_sound", "schedule_alert", "open_url", "cancel_alerts":
            out.append(.deviceAction(name: n, argsJson: Self.jsonString(input)))
        // Agent map tools (web __tinyMapBridge / Android AgentMap parity) —
        // args ride as JSON for the same watch-target reason.
        case "add_map_marker", "remove_map_marker", "clear_map_markers",
             "fly_to_location", "fly_to_marker", "tour_markers":
            out.append(.mapTool(name: n, argsJson: Self.jsonString(input)))
        case "generate_image":
            if let prompt = input?["prompt"] as? String {
                out.append(.generateImage(id: id, prompt: prompt, style: input?["style"] as? String ?? "animation"))
            }
        case "screenshot":
            out.append(.screenshot(id: id, reason: input?["reason"] as? String ?? ""))
        case "render_ui":
            out.append(.renderUi(id: id, title: input?["title"] as? String, propsJson: Self.jsonString(input?["props"])))
        default:
            break
        }
        return out
    }

    private mutating func decodeAfterToolCall(_ obj: [String: Any]) -> [Api.ChatEvent] {
        guard let tr = obj["toolResult"] as? [String: Any] else { return [] }
        // 🏷️ THE FIX: the name may be absent from the result, so fall back to the
        // pairing seen at this call's start. Previously an unnamed result meant
        // `if let n = tr["name"]` failed and EVERY branch below was skipped —
        // silently, with the tool chip stuck mid-spin and no card at all.
        guard let n = toolNames.resolve(name: tr["name"], id: tr["toolUseId"]) else { return [] }

        var out: [Api.ChatEvent] = [.toolEnd(n)]
        let id = tr["toolUseId"] as? String ?? UUID().uuidString

        switch n {
        // spawn_agents: the batch result rides the tool result's first text
        // block as JSON.
        case "spawn_agents":
            if let tid = tr["toolUseId"] as? String,
               let content = tr["content"] as? [[String: Any]],
               let text = content.compactMap({ $0["text"] as? String }).first {
                out.append(.spawnResults(id: tid, resultsJson: text))
            }

        // pay_x402 + make_payment: the callback returns an object → the SDK
        // wraps it as a {json:{…}} content block (a string return would arrive
        // as {text:"…"} JSON). Only a quote awaiting approval gets an
        // approvable card. make_payment (P2P send) rides the same card: its
        // url field carries the `transfer:@login` sentinel, so the re-quote
        // plumbing works unchanged and PayQuoteCard picks transfer copy off it.
        case "pay_x402", "make_payment":
            guard let payload = firstToolJson(tr["content"]) else { break }
            if (payload["requires_confirmation"] as? Bool) == true,
               let quote = payload["quote"] as? String {
                out.append(.payQuote(
                    id: id, quote: quote,
                    priceMicro: Self.safeMicro(payload["price_micro"]),
                    network: payload["network"] as? String,
                    payee: payload["payee"] as? String,
                    expiresAt: (payload["expires_at"] as? NSNumber)?.doubleValue,
                    message: payload["message"] as? String ?? "",
                    // The service URL the quote was minted for — carried so the
                    // card can re-quote in place on the recoverable dead-ends
                    // (expired 410 / terms_changed 409) without a fresh turn.
                    url: payload["url"] as? String))
            } else {
                // Not a quote: either the tool failed (ok:false — login/
                // allowlist/over-cap) or the target was free (ok:true, no
                // quote). Surface a terminal card so the outcome isn't
                // invisible (web/Android parity).
                out.append(.payResult(
                    id: id,
                    failed: (payload["ok"] as? Bool) != true,
                    error: payload["error"] as? String))
            }

        default:
            break
        }
        return out
    }

    // MARK: - helpers

    /// `Int(someDouble)` TRAPS in Swift on infinity/NaN/over-Int.max — a crash,
    /// not a wraparound — and a price arrives from JSON, where `1e999` decodes to
    /// `Double.infinity`. Same guard as `Wallet.swift:207` and `loadPrice()`;
    /// a nonsense price must render as a nonsense number, never take the app down.
    static func safeMicro(_ value: Any?) -> Int {
        guard let n = value as? NSNumber else { return 0 }
        let d = n.doubleValue
        guard !d.isNaN else { return 0 }
        if d <= 0 { return 0 }
        return d >= Double(Int.max) ? Int.max : Int(d)
    }

    /// `Any?` rather than a dictionary: `props` is whatever the model wrote, and
    /// a non-object there must yield "{}" for the native renderer instead of
    /// throwing inside JSONSerialization (which is a crash, not a nil).
    static func jsonString(_ value: Any?) -> String {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let d = try? JSONSerialization.data(withJSONObject: value),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
}

/**
 * DeviceTools — round-3 fire-and-forget device actions the agent can call
 * (copy_to_clipboard / set_brightness / play_sound). One generic dispatch
 * keeps Api.swift from growing a ChatEvent case per gadget.
 */
import UIKit
import AudioToolbox
import UserNotifications

/**
 * 📋 What may reach the system clipboard, and what to tell the model afterwards.
 *
 * ⚠️ The clipboard is the widest sink this app hands the agent: it is the only
 * one whose value the USER then pastes into ANOTHER program, so a wrong value
 * here is spent somewhere this code will never see. Web wrote the rule down in
 * `lib/chat/clipboard-write.ts` (four rules); Android ported it; iOS was right
 * on two of them and wrong on the one that COSTS something:
 *
 *  1. **A blank `text` ERASED the user's clipboard and was audited as success.**
 *     The arm was `if let text = args["text"] as? String, !text.isEmpty` — and
 *     `" "` is not empty, so a single space went onto the clipboard over
 *     whatever the user had (a wallet address mid-paste, a password out of a
 *     manager). Emptiness is the wrong test; BLANKNESS is the test. Worse, the
 *     switch then fell through to `.ran`, so `DeviceActionAudit` told the
 *     proxied agent the copy happened and the live-voice rail SPOKE it. That is
 *     this file's own documented defect class — "a tool that did nothing must
 *     not be audited as having run" — on the one arm where doing nothing would
 *     have been the GOOD outcome, not the harmless one.
 *  2. **Non-strings were refused SILENTLY.** `as? String` is the right verdict
 *     (web coerced to `"[object Object]"`, Android's `optString` put the literal
 *     `{"a":1}` on the clipboard) — but a refusal nobody is told about is
 *     reported as a copy just the same, which is defect 1 again.
 *  3. The cap WAS enforced, as an inline `prefix(10_000)` literal — the fourth
 *     copy of one number, now a named constant with a cross-client pin on it.
 *
 * ⚠️ Accepted text is NOT trimmed. Leading/trailing whitespace is meaningful in
 * the things people copy (an indented code block, the trailing newline before a
 * paste into a terminal); trimming is only how blankness is DETECTED.
 *
 * File-scope, not nested in `DeviceTools`: a type declared inside a
 * `@MainActor` class silently inherits that isolation, and `DeviceActionAudit`
 * — which must re-run this decision on both reporting rails — carries none.
 */
enum Clipboard {
    /// The cap, shared by all three clients and DESCRIBED to the model by
    /// `client-side.ts`'s `.max(10_000)`. The schema is advisory — every
    /// executor reads the frame's args directly — so this is enforcement, and
    /// the parity suite pins the four copies equal.
    static let max = 10_000

    /// The verdict on one `text` argument.
    enum Write: Equatable {
        /// Safe to write. `text` is what to place — never the raw argument.
        case allowed(text: String, truncated: Bool)
        /// Nothing was written. The string is FOR THE MODEL: it becomes the
        /// tool result, so it says both what was wrong and that the user's
        /// clipboard is intact.
        case refused(error: String)

        /// What the model is told about a write that happened. A truncated
        /// write MUST say so, or the agent goes on to describe the whole
        /// string as copied.
        var note: String? {
            guard case .allowed(_, let truncated) = self else { return nil }
            return truncated
                ? "copied, but truncated to the first \(Clipboard.max) characters — tell the user the rest was not copied"
                : "copied to the user's clipboard"
        }

        /// The refusal's reason without its `refused: ` marker, for a sentence
        /// that already says "NOT copied".
        var reason: String? {
            guard case .refused(let error) = self else { return nil }
            let marker = "refused: "
            return error.hasPrefix(marker) ? String(error.dropFirst(marker.count)) : error
        }
    }

    /// Decide whether the agent's `text` argument may be placed on the clipboard.
    ///
    /// Takes the raw `Any?` off the parsed args rather than a `String`, because
    /// the type confusion IS one of the defects: reading it as a String first is
    /// where the other two clients coerced.
    ///
    /// ⚠️ Blank input is REFUSED rather than written, because an empty write is
    /// DESTRUCTIVE — it replaces whatever the user had with nothing. There is no
    /// "clear the clipboard" capability in this tool's contract, so a blank
    /// `text` is always a mistake, and the refusal says so because the model
    /// reads it.
    static func decide(_ raw: Any?) -> Write {
        // NSNull is what JSONSerialization yields for a JSON `null`, and its
        // description is the four characters "null" — the exact shape that
        // would otherwise be copied as a word. An absent key arrives as `nil`
        // instead, and both mean the same thing to the user: no text was given.
        guard let value = raw, !(value is NSNull) else {
            return .refused(error: "refused: no text was given — nothing was copied, the clipboard still holds what the user had")
        }
        guard let text = value as? String else {
            return .refused(error: "refused: text must be a string — nothing was copied, the clipboard still holds what the user had")
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .refused(error: "refused: text was blank, and writing it would have ERASED whatever the user had on their clipboard — call this again with the actual text")
        }
        if text.count > max {
            return .allowed(text: String(text.prefix(max)), truncated: true)
        }
        return .allowed(text: text, truncated: false)
    }

    /// The `text` argument out of a raw args payload, for the two reporting
    /// rails that hold JSON rather than a dictionary (`openURLLine`'s shape).
    static func rawText(argsJson: String) -> Any? {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
        return args["text"]
    }

    /// A one-line, bounded rendering of what landed on the clipboard.
    ///
    /// Newlines collapse to spaces: this goes in a single line of transcript, and
    /// a multi-line preview would push the rest of the reply around. Truncation
    /// is marked with an ellipsis so a "…" is distinguishable from the real end
    /// of a short string.
    static func preview(_ text: String, max: Int = 48) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.count > max ? String(flat.prefix(max)) + "…" : flat
    }

    /// The user-facing confirmation, and web's fourth rule arriving here.
    ///
    /// ⚠️ It QUOTES the preview rather than saying "Copied!", because the risk
    /// this exists for is a SUBSTITUTION — the tiny copying its own wallet
    /// address over the one the user meant — and only the value can surface
    /// that. A silent replacement is exactly what makes a substituted address
    /// dangerous, so this is the user's one chance to notice before they paste
    /// it somewhere this code will never see.
    static func confirmToast(text: String, truncated: Bool) -> String {
        let shown = "📋 Copied “\(preview(text))”"
        guard truncated else { return shown }
        // Grouped thousands, matching web's toLocaleString('en-US') and
        // Android's "%,d" — "10000 characters" reads as a machine's number in a
        // sentence meant for a person. The locale is pinned so the sentence is
        // the same one on every phone, and so a test can assert it.
        let count = max.formatted(.number.locale(Locale(identifier: "en_US")))
        return "\(shown) — trimmed to \(count) characters"
    }

    /// What the CHAT rail puts in the transcript. Android toasts this; iOS's
    /// ChatView modifier chain is at the release demangler's limit, and a line
    /// of transcript outlives a toast anyway.
    static func chatNote(argsJson: String) -> String {
        switch decide(rawText(argsJson: argsJson)) {
        case .allowed(let text, let truncated):
            return confirmToast(text: text, truncated: truncated)
        // The refusal is worth saying too: the user watched a copy be asked
        // for, and silence would read as success.
        case .refused:
            return "📋 Nothing copied — your clipboard is unchanged"
        }
    }
}

@MainActor
final class DeviceTools {
    static let shared = DeviceTools()
    private var soundTask: Task<Void, Never>?

    private init() {}

    /// Handled tool names — Api.swift routes these through .deviceAction
    /// (names inlined there too: Api compiles into the watch target)
    static let names: Set<String> = ["copy_to_clipboard", "set_brightness", "play_sound", "schedule_alert", "cancel_alerts", "open_url"]

    /// The open_url scheme allowlist (Android DeviceTools.kt parity). mailto:
    /// opens Mail's compose sheet and message:// opens the Mail app itself —
    /// "open the mail app on my iPhone" was the canonical confabulated success
    /// (use_device P4): the scheme was dropped here while the model claimed 📬.
    nonisolated static let openURLSchemes: Set<String> = ["https", "http", "maps", "spotify", "music", "shortcuts", "mailto", "message"]

    /// Pure allowlist verdict — shared by the open_url execution below and the
    /// relay reply's device-actions audit (DeviceActionAudit), so what RUNS and
    /// what is REPORTED to have run can never drift.
    nonisolated static func resolveOpenURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), openURLSchemes.contains(url.scheme ?? "") else { return nil }
        return url
    }

    /// What became of one device-tool attempt (Android DeviceTools.Outcome parity).
    ///
    /// `names.contains(name)` — what the relay audit used to ask — is a
    /// membership test, and the comment above `resolveOpenURL` already states the
    /// rule it breaks: what RUNS and what is REPORTED to have run can never
    /// drift. A name in the set says the switch has a `case`, never that the case
    /// did anything. `play_sound` under quiet hours is the proof: it returns
    /// early by design, the room stays silent, and the audit said "ran on the
    /// phone" — the exact confabulation this audit exists to prevent, one file
    /// away from the `speak` branch that reports the identical gate honestly.
    enum Outcome {
        case ran
        /// Not a name this type owns.
        case unknownTool
        /// Owned and deliberately suppressed by quiet hours — not broken.
        case silencedQuiet
    }

    @discardableResult
    func handle(name: String, argsJson: String) -> Outcome {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
        switch name {
        case "copy_to_clipboard":
            // The shared decision, never a local guard: the pasteboard is
            // touched only inside `.allowed`, and it is handed the CAPPED
            // string, so the cap is enforcement rather than a claim. Both
            // reporting rails re-run `Clipboard.decide` for the same reason
            // `openURLLine` re-runs `resolveOpenURL` — `Outcome` cannot carry
            // this fact, because the arm executes either way.
            if case .allowed(let text, _) = Clipboard.decide(args["text"]) {
                UIPasteboard.general.string = text
            }
        case "set_brightness":
            if let level = (args["level"] as? NSNumber)?.doubleValue {
                screen?.brightness = CGFloat(max(0, min(level, 1)))
            }
        case "play_sound":
            // The quiet-hours gate lives in playSound(); read it HERE too so the
            // caller can report the mute instead of claiming a sound. Same
            // constant, no second policy — Android's SILENCED_QUIET parity.
            if Config.isQuietNow { return .silencedQuiet }
            playSound(kind: args["sound"] as? String ?? "alert",
                      seconds: (args["seconds"] as? NSNumber)?.doubleValue ?? 0)
        case "schedule_alert":
            if let title = args["title"] as? String,
               let mins = (args["in_minutes"] as? NSNumber)?.doubleValue {
                scheduleAlert(title: title, body: args["body"] as? String ?? "",
                              minutes: max(0.2, min(mins, 1440)))
            }
        case "cancel_alerts":
            Task {
                let center = UNUserNotificationCenter.current()
                let pending = await center.pendingNotificationRequests()
                let mine = pending.map(\.identifier).filter { $0.hasPrefix("agent-alert-") }
                center.removePendingNotificationRequests(withIdentifiers: mine)
            }
        case "open_url":
            // Foreground gate (use_device P4): iOS ignores open() from a
            // backgrounded process — the relay's Spotify fast-path already
            // gates on .active; this now matches instead of silently no-oping.
            // The relay audit (DeviceActionAudit) reports the same verdict.
            if let raw = args["url"] as? String, let url = Self.resolveOpenURL(raw),
               UIApplication.shared.applicationState == .active {
                UIApplication.shared.open(url)
            }
        default:
            return .unknownTool
        }
        return .ran
    }

    private var screen: UIScreen? {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.screen }
            .first
    }

    /// Local alarm — fires with sound even app-closed/locked (the reason
    /// this exists next to the server-side schedule tool)
    private func scheduleAlert(title: String, body: String, minutes: Double) {
        Task {
            await Notify.requestPermission()
            let content = UNMutableNotificationContent()
            content.title = String(title.prefix(80))
            if !body.isEmpty { content.body = String(body.prefix(200)) }
            content.sound = .default
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: minutes * 60, repeats: false)
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "agent-alert-\(UUID().uuidString)",
                                      content: content, trigger: trigger))
        }
    }

    /// System sound ids (stable, long-documented by convention):
    /// tri-tone alert, alarm ringer, glass chime, keyboard tock
    private func playSound(kind: String, seconds: Double) {
        guard !Config.isQuietNow else { return } // quiet hours: no agent sounds
        let id: SystemSoundID
        switch kind {
        case "alarm": id = 1304
        case "chime": id = 1013
        case "tick":  id = 1057
        default:      id = 1007 // alert
        }
        soundTask?.cancel()
        AudioServicesPlaySystemSound(id)
        guard seconds > 1 else { return }
        let reps = Int(min(seconds, 30) / 1.5)
        soundTask = Task {
            for _ in 0..<reps {
                try? await Task.sleep(for: .seconds(1.5))
                if Task.isCancelled { break }
                AudioServicesPlaySystemSound(id)
            }
        }
    }
}

/**
 * DeviceActionAudit (use_device P4 — Android fleet/DeviceActionAudit.kt parity)
 *
 * A relay invoke ("open the mail app on my iPhone") proxies to the SERVER
 * agent; client-tool events from that stream act on this phone — but some are
 * silently impossible (scheme refused, app backgrounded, round-trip tools that
 * can't run on the relay path), and the proxied model, seeing no signal either
 * way, claims success: "Mail app opened 📬" over a no-op. The relay reply now
 * appends one factual line per attempted device action; the web-side agent
 * relays THAT instead of the model's optimism.
 */
enum DeviceActionAudit {
    static func toolLine(_ name: String, ran: Bool) -> String {
        ran ? "\(name): ran on the phone"
            : "\(name): NOT executed — this tool cannot run via the device relay on iOS"
    }

    /// Round-trip tools (generate_image / screenshot / meta_*) need the phone
    /// to hold the chat stream and post to the tool-result mailbox — the relay
    /// path drops them today (design P5 executes them; until then, say so).
    static func droppedLine(_ name: String) -> String {
        "\(name): NOT executed — not available when another surface drives this phone via use_device"
    }

    /// An action that was HANDED OFF, not completed: the phone showed the user a
    /// consent prompt and returned without waiting (a relay turn must never
    /// park on human reaction time — it would stall the envelope loop that
    /// carries this phone's pushes). The terminal truth arrives separately,
    /// through the tool-result mailbox the server callback is polling.
    ///
    /// So the tense is PRESENT and the claim is narrow: the prompt was shown.
    /// Saying "captured" here would be the exact confabulation this audit
    /// exists to prevent — at this instant nobody has tapped anything.
    /// (Android parity: DeviceActionAudit.dispatchedLine.)
    static func consentLine(_ name: String) -> String {
        "\(name): consent prompt shown on the phone — the user's answer and any result post to the chat's tool mailbox"
    }

    /// A remote round-trip tool refused for a runtime precondition, naming the
    /// precondition rather than the capability (the capability exists — this
    /// phone just can't satisfy it right now).
    static func backgroundedLine(_ name: String) -> String {
        "\(name): NOT executed — the app is backgrounded, so its consent prompt can't be shown and iOS has no foreground screen to capture; ask the user to open the tiny app first"
    }

    static func speakLine(spoke: Bool, quiet: Bool) -> String {
        spoke ? "speak: said aloud on the phone"
              : (quiet ? "speak: NOT spoken — quiet hours on the phone" : "speak: NOT spoken — empty text")
    }

    /// Outcome line for a delegated device tool, from what actually happened
    /// rather than from whether the name is known (Android `outcomeLine` parity).
    ///
    /// ⚠️ The relay used to pass `ran: DeviceTools.names.contains(name)` — a
    /// membership test. `play_sound` at 23:00 returns early by design, so the
    /// room stayed silent and the audit reported "ran on the phone", right next
    /// to a `speakLine` that names the very same gate honestly. The web agent
    /// then tells the user a sound played, and a user who hears nothing cannot
    /// tell a deliberate mute from a broken speaker.
    static func outcomeLine(_ name: String, _ outcome: DeviceTools.Outcome) -> String {
        switch outcome {
        case .ran: return toolLine(name, ran: true)
        case .unknownTool: return toolLine(name, ran: false)
        case .silencedQuiet: return "\(name): NOT played — quiet hours on the phone"
        }
    }

    /// The live-call TOOL RESULT for a delegated device tool.
    ///
    /// ⚠️ Same defect, second surface: the voice executor answered a bare
    /// `["ok": true]` for every one of these tools, so a `play_sound` the phone
    /// deliberately muted came back as plain success and the tiny SAID it had
    /// played — to a person who heard nothing. The relay path at least had an
    /// audit line; this one had no channel for the fact at all.
    ///
    /// Reuses `outcomeLine` rather than re-wording it: one sentence, two
    /// readers, so a voice call and the web agent can never be told different
    /// stories about the same action. (Android `voiceResult` parity.)
    static func voiceResult(_ name: String, _ outcome: DeviceTools.Outcome) -> [String: Any] {
        let line = outcomeLine(name, outcome)
        // An unowned name is the one FAILING result: the model asked for
        // something this build can't run, and ok:true would teach it that it
        // had. Everything else did run, or was suppressed on purpose.
        if case .unknownTool = outcome { return ["ok": false, "error": line] }
        return ["ok": true, "note": line]
    }

    /// Outcome line for copy_to_clipboard — the one tool whose no-op is
    /// DESTRUCTIVE, and the one whose refusal is the GOOD case.
    ///
    /// ⚠️ Special-cased for exactly `openURLLine`'s reason: the tool's own
    /// return value cannot carry this. `handle` reports that the arm executed,
    /// and the arm executes either way — so a `text` that was absent, the wrong
    /// type, or blank was audited as "ran on the phone" and the proxied web
    /// agent went on to tell the user their text was copied. It was not; and
    /// under the old `!text.isEmpty` guard a `" "` was actually WRITTEN, which
    /// erased what the user had while the audit vouched for it.
    ///
    /// Reads the RAW argument and re-runs `Clipboard.decide`: the audit must
    /// state the decision the write actually made, and the only way to be sure
    /// of that is to make the same one from the same input.
    static func clipboardLine(argsJson: String) -> String {
        let write = Clipboard.decide(Clipboard.rawText(argsJson: argsJson))
        switch write {
        case .allowed:
            return "copy_to_clipboard: \(write.note ?? "")"
        // The refusal's own words, not a re-wording: it already says what was
        // wrong AND that the clipboard is intact, which is the fact the model
        // needs before it claims anything to the user.
        case .refused:
            return "copy_to_clipboard: NOT copied — \(write.reason ?? "")"
        }
    }

    /// The live-call TOOL RESULT for copy_to_clipboard.
    ///
    /// ⚠️ A refusal is `ok: false`, unlike the muted `play_sound` above: quiet
    /// hours is the phone obeying the user, but a clipboard write that never
    /// happened is the model's request UNMET, and it has to know that to say
    /// something true out loud. `ok: true` here is how a tiny comes to tell a
    /// person, in speech, that their text is ready to paste when the clipboard
    /// still holds whatever it held before.
    static func clipboardResult(argsJson: String) -> [String: Any] {
        let write = Clipboard.decide(Clipboard.rawText(argsJson: argsJson))
        switch write {
        case .allowed:
            return ["ok": true, "note": write.note ?? ""]
        case .refused(let error):
            return ["ok": false, "error": error]
        }
    }

    /// open_url has silent failure layers — name the exact one.
    static func openURLLine(argsJson: String, foreground: Bool) -> String {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
        let raw = args["url"] as? String ?? ""
        if DeviceTools.resolveOpenURL(raw) == nil {
            return "open_url(\(raw)): NOT opened — scheme not allowlisted (allowed: \(DeviceTools.openURLSchemes.sorted().joined(separator: ", ")))"
        }
        if !foreground {
            return "open_url(\(raw)): NOT opened — the app is backgrounded and iOS blocks background app launches; ask the user to open the tiny app first"
        }
        return "open_url(\(raw)): opened on the phone"
    }

    /// The block appended to a relay reply ("" when no device actions ran).
    /// Bracketed so the web agent reads it as telemetry, not device prose;
    /// bounded so it can never crowd the answer out of the 8KB relay payload.
    static func render(_ lines: [String]) -> String {
        lines.isEmpty ? "" : "\n\n[device-actions: \(String(lines.joined(separator: "; ").prefix(400)))]"
    }

    /// Order-preserving collector the two relay reply paths share — the
    /// onEvent closure is @Sendable, so the lines live in an actor.
    actor Box {
        private var lines: [String] = []
        func add(_ line: String) { lines.append(line) }
        func render() -> String { DeviceActionAudit.render(lines) }
    }
}

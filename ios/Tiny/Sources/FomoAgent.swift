/**
 * 🗣️ FomoAgent — "Ask Fomo" over the dashboard's /ws/agent socket, the way the
 * web dash does it (dashboard/frontend/src/useAgent.ts):
 *
 *   in : {"prompt": "nod"}
 *   out: hello{tools,version} · text{delta} · tool{id,name,input} ·
 *        tool_result{id,status,text,photo} · done · error{error}
 *   close code 4401 = the token was refused (no reconnect).
 *
 * The reducer (`FomoAgentCore.reduce`) is pure so FomoAgentTests can pin the
 * narrative: one Fomo turn per prompt, tool receipts attached in order, `done`
 * closes the turn. When the socket cannot open, `send` falls back to the
 * single-shot POST /api/chat and renders its `result` as one finished turn.
 */
import Foundation

enum FomoAgentCore {
    struct Receipt: Equatable, Identifiable {
        let id: String
        var name: String
        var input: String?
        var status: String?
        var text: String?
        var photo: String?
    }

    struct Turn: Equatable, Identifiable {
        enum Role: Equatable { case you, fomo, note }
        let id: Int
        let role: Role
        var text: String
        var receipts: [Receipt]
        var error: String?
        var done: Bool
    }

    struct Log: Equatable {
        var turns: [Turn] = []
        var tools: [String] = []
        var busy = false
        var seq = 1

        mutating func you(_ text: String) {
            turns.append(Turn(id: seq, role: .you, text: text, receipts: [], done: true)); seq += 1
            busy = true
        }

        mutating func note(_ text: String) {
            turns.append(Turn(id: seq, role: .note, text: text, receipts: [], done: true)); seq += 1
        }
    }

    /// One frame from the socket → the log. Unknown frames are ignored.
    static func reduce(_ log: inout Log, frame: [String: Any]) {
        guard let type = frame["type"] as? String else { return }
        if type == "hello" {
            log.tools = (frame["tools"] as? [Any])?.compactMap { $0 as? String } ?? []
            return
        }
        // the current Fomo turn, or a fresh one
        if log.turns.last == nil || log.turns.last?.role != .fomo || log.turns.last?.done == true {
            log.turns.append(Turn(id: log.seq, role: .fomo, text: "", receipts: [], done: false)); log.seq += 1
        }
        var last = log.turns.removeLast()
        switch type {
        case "text":
            last.text += frame["delta"] as? String ?? ""
        case "tool":
            let id = frame["id"] as? String ?? UUID().uuidString
            var input: String?
            if let inp = frame["input"], !(inp is NSNull) {
                if let s = inp as? String { input = s }
                else if let d = try? JSONSerialization.data(withJSONObject: inp), let s = String(data: d, encoding: .utf8) { input = s }
            }
            last.receipts.append(Receipt(id: id, name: frame["name"] as? String ?? "?", input: input))
        case "tool_result":
            let id = frame["id"] as? String ?? ""
            let status = frame["status"] as? String
            let text = frame["text"] as? String
            let photo = (frame["photo"] as? String).map { "/photos/" + ($0.split(separator: "/").last.map(String.init) ?? $0) }
            if let i = last.receipts.firstIndex(where: { $0.id == id }) {
                last.receipts[i].status = status; last.receipts[i].text = text; last.receipts[i].photo = photo
            } else {
                last.receipts.append(Receipt(id: id, name: "?", input: nil, status: status, text: text, photo: photo))
            }
        case "done":
            last.done = true
            log.busy = false
        case "error":
            last.error = frame["error"] as? String ?? "error"
            last.done = true
            log.busy = false
        default:
            break
        }
        log.turns.append(last)
    }

    /// POST /api/chat answered → one finished Fomo turn.
    static func reduceChat(_ log: inout Log, result: String, tools: [String], errors: [String]) {
        var t = Turn(id: log.seq, role: .fomo, text: result, receipts: tools.map { Receipt(id: UUID().uuidString, name: $0, input: nil, status: "success") }, done: true)
        log.seq += 1
        if !errors.isEmpty { t.error = errors.joined(separator: "; ") }
        log.turns.append(t)
        log.busy = false
    }
}

/// The live socket. One per FomoClient; reconnects unless the token was refused.
@MainActor
final class FomoAgent: ObservableObject {
    enum Link: Equatable { case idle, connecting, open, closed, unauthorized }

    @Published private(set) var log = FomoAgentCore.Log()
    @Published private(set) var link: Link = .idle

    private let client: FomoClient
    private var task: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var retries = 0

    init(client: FomoClient) { self.client = client }

    func connect() {
        guard task == nil, let url = client.agentURL else { return }
        link = .connecting
        let t = client.session.webSocketTask(with: url)
        task = t
        t.resume()
        reader = Task { [weak self] in await self?.readLoop(t) }
    }

    func close() {
        reader?.cancel(); reader = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        link = .closed
    }

    private func readLoop(_ t: URLSessionWebSocketTask) async {
        while !Task.isCancelled, task === t {
            do {
                let msg = try await t.receive()
                if link != .open { link = .open; retries = 0 }
                let data: Data?
                switch msg {
                case .string(let s): data = s.data(using: .utf8)
                case .data(let d): data = d
                @unknown default: data = nil
                }
                if let data, let f = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    FomoAgentCore.reduce(&log, frame: f)
                }
            } catch {
                guard task === t else { return }
                task = nil
                let code = t.closeCode
                if code.rawValue == 4401 { link = .unauthorized; log.busy = false; return }
                link = .closed
                if log.busy { log.note("connection dropped"); log.busy = false }
                // back off 2.5 s, 5 s, 10 s … capped, like the web dash's 2.5 s retry
                retries += 1
                let wait = min(2.5 * pow(2, Double(retries - 1)), 20)
                try? await Task.sleep(for: .seconds(wait))
                if !Task.isCancelled { connect() }
                return
            }
        }
    }

    /// Send one prompt. Socket when open; otherwise the single-shot /api/chat.
    func send(_ text: String) {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !log.busy else { return }
        log.you(prompt)
        if link == .open, let task, let data = try? JSONSerialization.data(withJSONObject: ["prompt": prompt]),
           let s = String(data: data, encoding: .utf8) {
            task.send(.string(s)) { [weak self] err in
                guard let err else { return }
                Task { @MainActor in self?.fallback(prompt, why: err.localizedDescription) }
            }
        } else {
            fallback(prompt, why: nil)
        }
    }

    private func fallback(_ prompt: String, why: String?) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let r = try await client.chat(prompt)
                FomoAgentCore.reduceChat(&log, result: r.result, tools: r.tools, errors: r.errors)
            } catch let e as FomoError {
                FomoAgentCore.reduceChat(&log, result: "", tools: [], errors: [e.message])
            } catch {
                FomoAgentCore.reduceChat(&log, result: "", tools: [], errors: [why ?? error.localizedDescription])
            }
        }
    }

    func clear() { log = FomoAgentCore.Log(tools: log.tools) }
}

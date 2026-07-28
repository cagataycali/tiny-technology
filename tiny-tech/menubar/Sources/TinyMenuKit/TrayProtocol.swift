/// The tray protocol, Swift side — the exact reply shapes `src/tray.ts` writes.
///
/// This is a CLIENT of a contract that already exists. The daemon half (c22)
/// deliberately shipped first so that the shape could be argued about in tests
/// rather than through a menu that renders wrong; two of its decisions were made
/// for this file specifically and are worth naming here, because a future edit
/// on either side would break the other:
///
///   * `result` replies carry the task's state under **`state`**, not `status`.
///     A top-level `status` already means the status OBJECT, and one key with two
///     types decodes fine in JavaScript and fails here, where a reply is a single
///     `Codable`.
///   * every reply carries `protocol`. This helper is a separate binary a user
///     installs once and forgets, so a version mismatch has to be a sentence in
///     the menu ("update tiny-tech") rather than an empty menu.
///
/// And one this file has to solve alone: **`protocol` is a Swift keyword**, so
/// the wire name only reaches the struct through `CodingKeys`.
import Foundation

/// The protocol version this helper was built against. Compared with what the
/// daemon reports; see `TrayCompatibility`.
public let trayProtocol = 1

/// Every command the daemon answers, in the order `TRAY_COMMANDS` lists them.
public enum TrayCommand: String, CaseIterable, Sendable {
  case ping, status, tasks, result, ask, cancel, logs, reload, share
}

/// One ambient data card for the rotating menu-bar ticker strip.
/// Cards are CACHED data pushed by the daemon — the helper never fetches live.
public struct TickerCard: Codable, Sendable, Equatable, Identifiable {
  /// Short display text, fits in ~28 chars beside the glyph.
  public var text: String
  /// Single emoji or symbol prefix, e.g. "♫" "💰" "📬" "🕸"
  public var icon: String?
  /// "normal" rotates; "urgent" stops rotation + shows ◉.
  public var priority: String?
  /// Seconds this card stays visible before rotating (default 5).
  public var ttl: Double?

  /// Stable id for SwiftUI list diffing.
  public var id: String { (icon ?? "") + text }

  public var isUrgent: Bool { priority == "urgent" }
  public var displayText: String { icon.map { "\($0) \(text)" } ?? text }
  public var rotateDuration: TimeInterval { ttl ?? 5 }

  public init(text: String, icon: String? = nil, priority: String? = nil, ttl: Double? = nil) {
    self.text = text; self.icon = icon; self.priority = priority; self.ttl = ttl
  }
}

/// One recent activity-feed event ("push") — job results, telegram messages,
/// share views — summarised for the menu's Activity section. Same caching rule
/// as the ticker: the daemon pushes what it already fetched, never live.
public struct TrayEventCard: Codable, Sendable, Equatable, Identifiable {
  public var eventId: Double?
  public var type: String?
  public var summary: String
  public var at: Double?

  enum CodingKeys: String, CodingKey {
    case type, summary, at
    case eventId = "id"
  }

  public var id: String { "\(eventId ?? 0)-\(summary)" }

  /// Glyph per event type — a menu line is short, the glyph carries the type.
  ///
  /// ⚠️ `job`, `job_error` and `job_missed` are DELIBERATELY different glyphs.
  /// `job_missed` is a one-shot the scheduler GAVE UP on — it never ran and never
  /// will, which is different news from "it ran and threw". The daemon used
  /// to collapse both `job_result` and `job_error` to `"job"`, and this switch
  /// drew that as ⏳ — so a scheduled job that FAILED, the one event a user has to
  /// act on, appeared here as a job that ran. A menu bar has four lines and no
  /// scrollback; a wrong glyph is not a cosmetic issue, it is the whole message.
  ///
  /// `alarm` is 🚨 alone: it means x402 reconciliation needs a human. `money`
  /// covers pay_earned/received/withdrawn/refunded — good news, never the siren.
  /// The old `share_view` case is gone: the worker has never emitted a share
  /// event, so it was a phantom the daemon and this switch agreed on with each
  /// other while agreeing with nothing real.
  public var glyph: String {
    switch type {
    case "job": return "⏳"
    case "job_error": return "❗"
    case "job_missed": return "⛔"
    case "alarm": return "🚨"
    case "money": return "💵"
    case "telegram": return "✈︎"
    case "message", "dm": return "💬"
    case "device": return "💻"
    case "tool": return "🔧"
    case "visit": return "→"
    case "follow": return "🤝"
    default: return "•"
    }
  }

  public init(eventId: Double? = nil, type: String? = nil, summary: String, at: Double? = nil) {
    self.eventId = eventId; self.type = type; self.summary = summary; self.at = at
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    type = try c.decodeIfPresent(String.self, forKey: .type)
    summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
    eventId = c.lenientNumber(.eventId)
    at = c.lenientNumber(.at)
  }
}

/// What a menu bar needs to paint itself, in one round trip.
///
/// Every number is decoded as `Double`, not `Int`, and that is deliberate: a
/// `Double` field accepts both `4` and `4.0`, while an `Int` field throws on the
/// latter — and a throw here fails the WHOLE reply, so one unexpectedly-float
/// count would blank the entire menu instead of showing a slightly odd number.
/// The `…Count` accessors convert back, clamped, because `Int(Double.infinity)`
/// is a hard crash in Swift rather than an overflow.
public struct TrayStatus: Codable, Sendable, Equatable {
  public struct Device: Codable, Sendable, Equatable {
    public var name: String?
    public var id: String?
    public var online: Bool?
    public init(name: String? = nil, id: String? = nil, online: Bool? = nil) {
      self.name = name; self.id = id; self.online = online
    }
  }
  public struct Tools: Codable, Sendable, Equatable {
    public var loaded: Double?
    public var failed: Double?
    public init(loaded: Double? = nil, failed: Double? = nil) { self.loaded = loaded; self.failed = failed }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      loaded = c.lenientNumber(.loaded)
      failed = c.lenientNumber(.failed)
    }
  }
  public struct Tasks: Codable, Sendable, Equatable {
    public var running: Double?
    public var finished: Double?
    public init(running: Double? = nil, finished: Double? = nil) { self.running = running; self.finished = finished }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      running = c.lenientNumber(.running)
      finished = c.lenientNumber(.finished)
    }
  }

  public var device: Device?
  public var peers: Double?
  public var senses: [String]?
  public var tools: Tools?
  public var tasks: Tasks?
  public var relay: Bool?
  public var logPath: String?
  public var startedAt: Double?
  public var version: String?
  /// Computed mood from the daemon. Nil = treat as 'idle'.
  public var mood: String?
  /// Ambient data cards for the rotating ticker strip.
  public var ticker: [TickerCard]?
  /// Active Spotify track. Nil = nothing playing / Spotify not connected.
  public var nowPlaying: NowPlaying?
  /// Recent activity-feed events (pushes), newest first.
  public var events: [TrayEventCard]?

  public struct NowPlaying: Codable, Sendable, Equatable {
    public var title: String
    public var artist: String
    public init(title: String, artist: String) { self.title = title; self.artist = artist }
  }

  public init(
    device: Device? = nil, peers: Double? = nil, senses: [String]? = nil,
    tools: Tools? = nil, tasks: Tasks? = nil, relay: Bool? = nil,
    logPath: String? = nil, startedAt: Double? = nil, version: String? = nil
  ) {
    self.device = device; self.peers = peers; self.senses = senses
    self.tools = tools; self.tasks = tasks; self.relay = relay
    self.logPath = logPath; self.startedAt = startedAt; self.version = version
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    device = try c.decodeIfPresent(Device.self, forKey: .device)
    // `Array<String>.self`, not `[String].self`: in this position the type checker
    // reads the sugar as an array LITERAL holding a reference to String.init.
    senses = try c.decodeIfPresent(Array<String>.self, forKey: .senses)
    tools = try c.decodeIfPresent(Tools.self, forKey: .tools)
    tasks = try c.decodeIfPresent(Tasks.self, forKey: .tasks)
    relay = try c.decodeIfPresent(Bool.self, forKey: .relay)
    logPath = try c.decodeIfPresent(String.self, forKey: .logPath)
    version = try c.decodeIfPresent(String.self, forKey: .version)
    mood = try c.decodeIfPresent(String.self, forKey: .mood)
    ticker = try c.decodeIfPresent(Array<TickerCard>.self, forKey: .ticker)
    nowPlaying = try c.decodeIfPresent(NowPlaying.self, forKey: .nowPlaying)
    events = try c.decodeIfPresent(Array<TrayEventCard>.self, forKey: .events)
    peers = c.lenientNumber(.peers)
    startedAt = c.lenientNumber(.startedAt)
  }

  public var peerCount: Int { safeInt(peers) }
  public var runningTasks: Int { safeInt(tasks?.running) }
  public var finishedTasks: Int { safeInt(tasks?.finished) }
  public var loadedTools: Int { safeInt(tools?.loaded) }
  public var failedTools: Int { safeInt(tools?.failed) }
}

/// One task, as a poll sees it — the bodies are up to 20 KB each and stay behind
/// the `result` command.
public struct TraySummary: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var status: String
  public var prompt: String
  public var startedAt: Double?
  public var endedAt: Double?
  public init(id: String, status: String, prompt: String, startedAt: Double? = nil, endedAt: Double? = nil) {
    self.id = id; self.status = status; self.prompt = prompt
    self.startedAt = startedAt; self.endedAt = endedAt
  }
}

/// Any reply, from any command. One struct rather than eight, because the
/// protocol answers one command per line and the caller already knows which one
/// it sent — and because a `Codable` per command would have to agree with the
/// others about `ok`, `protocol` and `error` anyway.
public struct TrayReply: Codable, Sendable, Equatable {
  public var ok: Bool
  /// Wire name `protocol`, which Swift will not accept as an identifier.
  public var protocolVersion: Int?
  public var error: String?
  /// `true` when the daemon KNOWS the command but cannot serve it (no task
  /// runner, no log file). Distinct from `unknown cmd` on purpose: this greys a
  /// menu item out, that one means the daemon is older than this helper.
  public var unavailable: Bool?

  public var status: TrayStatus?
  public var tasks: [TraySummary]?
  public var id: String?
  /// The task's state — see the file header on why this is not `status`.
  public var state: String?
  public var result: String?
  public var message: String?
  public var text: String?
  public var commands: [String]?
  public var pid: Double?

  enum CodingKeys: String, CodingKey {
    case ok, error, unavailable, status, tasks, id, state, result, message, text, commands, pid
    case protocolVersion = "protocol"
  }

  public init(
    ok: Bool, protocolVersion: Int? = trayProtocol, error: String? = nil, unavailable: Bool? = nil,
    status: TrayStatus? = nil, tasks: [TraySummary]? = nil, id: String? = nil, state: String? = nil,
    result: String? = nil, message: String? = nil, text: String? = nil,
    commands: [String]? = nil, pid: Double? = nil
  ) {
    self.ok = ok; self.protocolVersion = protocolVersion; self.error = error; self.unavailable = unavailable
    self.status = status; self.tasks = tasks; self.id = id; self.state = state
    self.result = result; self.message = message; self.text = text
    self.commands = commands; self.pid = pid
  }

  /// A local failure dressed as a reply, so every caller has one shape to render.
  /// `protocolVersion` is nil here — nothing was on the wire to report one.
  public static func failure(_ message: String) -> TrayReply {
    TrayReply(ok: false, protocolVersion: nil, error: message)
  }

  public static func decode(_ line: String) -> TrayReply {
    guard let data = line.data(using: .utf8), !data.isEmpty else {
      return .failure("empty reply from the tray socket")
    }
    do {
      return try JSONDecoder().decode(TrayReply.self, from: data)
    } catch {
      return .failure("unreadable reply from the tray socket (\(shortDecodeError(error)))")
    }
  }
}

/// Is this helper able to talk to that daemon?
///
/// Both directions matter and they need DIFFERENT sentences, because they need
/// different actions from the user: a daemon older than the helper is fixed by
/// updating tiny-tech, a newer one by updating the helper. A single "version
/// mismatch" would leave them guessing which of the two to touch.
public enum TrayCompatibility: Equatable, Sendable {
  case ok
  case daemonOlder(daemon: Int, helper: Int)
  case helperOlder(daemon: Int, helper: Int)
  /// The daemon answered without a `protocol` key at all — so it is not a tray
  /// socket, or it predates the protocol. Either way: don't guess at its shape.
  case unversioned

  public var isUsable: Bool { self == .ok }

  public var advice: String? {
    switch self {
    case .ok: return nil
    case .daemonOlder(let d, let h):
      return "the daemon speaks tray protocol \(d), this helper needs \(h) — update tiny-tech (npm i -g tiny-tech)"
    case .helperOlder(let d, let h):
      return "the daemon speaks tray protocol \(d), newer than this helper's \(h) — update tiny-menubar"
    case .unversioned:
      return "that socket did not identify itself as a tiny-tech tray — check TINY_TRAY_SOCK"
    }
  }
}

public func trayCompatibility(_ reply: TrayReply, helper: Int = trayProtocol) -> TrayCompatibility {
  guard let daemon = reply.protocolVersion else { return .unversioned }
  if daemon == helper { return .ok }
  return daemon < helper ? .daemonOlder(daemon: daemon, helper: helper) : .helperOlder(daemon: daemon, helper: helper)
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// `Int(someDouble)` TRAPS in Swift on infinity, NaN, and anything past
/// `Int.max` — it is not a wrapping conversion, it is a crash. A daemon is not a
/// hostile input, but a JSON number arrives from a process this helper does not
/// version-lock with, and a menu bar dying is not a proportional response to a
/// surprising count.
///
/// The three cases are NOT one case. An absurdly large count is still a count and
/// clamps to `max`, so the menu says "1000000 peers" — visibly wrong, and the
/// user can see the daemon is confused. NaN is not a quantity at all, and neither
/// is a negative one, so both read as nothing rather than as a suspiciously round
/// number. Collapsing them (an earlier draft returned 0 for every non-finite
/// value, infinity included) would have reported an overflowing daemon as an idle
/// one — the failure that hides itself.
func safeInt(_ value: Double?, max: Int = 1_000_000) -> Int {
  guard let v = value, !v.isNaN else { return 0 }
  if v <= 0 { return 0 }                    // catches -infinity too
  return v >= Double(max) ? max : Int(v)    // catches +infinity: >= is true for it
}

extension KeyedDecodingContainer {
  /// A JSON number that Foundation refuses, contained to the field it arrived in.
  ///
  /// `JSONDecoder` throws `dataCorrupted` on a literal outside Double's range
  /// (`1e309`) — and a throw in a nested `init(from:)` fails the WHOLE reply, so
  /// one absurd number in `peers` would blank the entire menu. That is the exact
  /// failure the Double-not-Int choice above exists to prevent, one level up, and
  /// `Double?` alone does not prevent it: the value never reaches this type.
  ///
  /// So an unreadable number becomes `infinity` — which `safeInt` then clamps —
  /// and every OTHER field in the reply still renders. Deliberately numbers only:
  /// a string arriving where a number belongs is protocol drift worth surfacing as
  /// a decode error, not something to paper over.
  /// Three outcomes, and conflating any two of them is a bug I already wrote once:
  ///   * ABSENT      → nil. Every field here is optional in the daemon's own
  ///     interface, so "not reported" is the ordinary case and must not become a
  ///     number. (An earlier draft checked only readability, which made an empty
  ///     `{}` status report a million peers.)
  ///   * readable    → the value, float or int.
  ///   * unreadable  → `infinity`, which `safeInt` clamps to a visibly-wrong count
  ///     rather than the plausible-looking 0 of an idle daemon.
  func lenientNumber(_ key: Key) -> Double? {
    guard contains(key) else { return nil }
    if let d = try? decode(Double.self, forKey: key) { return d }
    // A JSON `null` is present-but-empty, which is "not reported", not "broken".
    if (try? decodeNil(forKey: key)) == true { return nil }
    // A numeric string is a daemon being loose with JSON — still a count.
    if let s = try? decode(String.self, forKey: key), let d = Double(s) { return d }
    return .infinity
  }
}

/// `DecodingError`'s description runs to several lines of context that means
/// nothing in a menu item. Keep the part that identifies the field.
func shortDecodeError(_ error: Error) -> String {
  guard let e = error as? DecodingError else { return String(describing: error).prefix(120).description }
  switch e {
  case .keyNotFound(let key, _): return "missing '\(key.stringValue)'"
  case .typeMismatch(let type, let ctx):
    let path = ctx.codingPath.map(\.stringValue).joined(separator: ".")
    return path.isEmpty ? "wrong type for \(type)" : "wrong type for '\(path)'"
  case .valueNotFound(_, let ctx):
    let path = ctx.codingPath.map(\.stringValue).joined(separator: ".")
    return path.isEmpty ? "missing value" : "null '\(path)'"
  case .dataCorrupted: return "not JSON"
  @unknown default: return "undecodable"
  }
}

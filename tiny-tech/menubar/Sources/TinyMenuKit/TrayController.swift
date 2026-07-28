/// Sequencing — what the helper asks the daemon, and when.
///
/// Separate from both the socket and AppKit so the polling RULES are testable
/// with a fake transport: a menu bar that hammers a socket, or that keeps polling
/// a daemon that isn't there, is a battery bug nobody reports and everybody feels.
import Foundation

/// How often to repaint while the menu is CLOSED. `status` is one round trip over
/// a Unix socket, but it wakes the daemon's event loop each time, so this is a
/// compromise between a stale badge and a daemon that never idles.
public let trayPollInterval: TimeInterval = 5

/// While the daemon is unreachable, back off — up to this. A helper that keeps a
/// 5s connect() loop running against a socket that doesn't exist burns wakeups
/// for hours after the user stops the daemon, and the cost of noticing a restart
/// a little late is one stale glyph.
public let trayPollMaxInterval: TimeInterval = 60

/// Next delay after a poll. Doubling from the base while unreachable, straight
/// back to the base the moment the daemon answers — the asymmetry is the point:
/// slow to give up, instant to recover.
public func nextPollInterval(current: TimeInterval, reachable: Bool) -> TimeInterval {
  if reachable { return trayPollInterval }
  return min(trayPollMaxInterval, max(trayPollInterval, current * 2))
}

/// A failed command, as a sentence to show. `Result`'s failure type must conform
/// to `Error`, and a bare `String` does not — but every failure here is already
/// something a user reads, so this is a message with a type rather than an error
/// hierarchy nobody would switch on. String-literal-expressible so call sites and
/// tests stay readable.
public struct TrayFailure: Error, Equatable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
  public let message: String
  public init(_ message: String) { self.message = message }
  public init(stringLiteral value: String) { self.message = value }
  public var description: String { message }
}

/// The whole helper's state, in one value.
public struct TrayViewState: Equatable, Sendable {
  public var daemon: DaemonState
  public var tasks: [TraySummary]
  /// What this daemon says it can serve — an `unavailable` reply removes a
  /// command from the set, which greys its menu item.
  public var commands: Set<String>

  public init(daemon: DaemonState = .unreachable("not polled yet"), tasks: [TraySummary] = [], commands: Set<String> = []) {
    self.daemon = daemon; self.tasks = tasks; self.commands = commands
  }

  public var title: MenuTitle { menuTitle(for: daemon) }
  public var rows: [MenuRow] { buildMenu(state: daemon, tasks: tasks, commands: commands) }
}

/// Drives the transport. Not an actor: every call is synchronous and the caller
/// (the app) runs it on one serial queue, which keeps the ordering guarantee the
/// protocol itself relies on — one command, one reply, in order.
public final class TrayController {
  private let transport: TrayTransport
  public private(set) var state = TrayViewState()
  public private(set) var interval = trayPollInterval

  public init(transport: TrayTransport) {
    self.transport = transport
  }

  /// One poll. Asks `status` always; asks `tasks` ONLY when the status says there
  /// are some — the common case is a daemon with no tasks at all, and paying two
  /// round trips every 5 seconds to be told "none" is the kind of waste that adds
  /// up over a day in the menu bar.
  @discardableResult
  public func poll() -> TrayViewState {
    let reply = transport.send(["cmd": "status"])
    let daemon = daemonState(from: reply, helper: trayProtocol)

    var tasks: [TraySummary] = []
    var commands = state.commands
    if case .running(let s) = daemon {
      if s.runningTasks > 0 || s.finishedTasks > 0 {
        let t = transport.send(["cmd": "tasks"])
        if t.ok, let list = t.tasks {
          tasks = sortedForMenu(list)
          commands.insert("tasks")
        } else if t.unavailable == true {
          commands.remove("tasks")
        }
      }
    } else {
      // Don't keep showing tasks from a daemon we can no longer reach: they'd
      // read as live state.
      tasks = []
    }

    if case .running = daemon {} else { commands = [] }

    interval = nextPollInterval(current: interval, reachable: daemon.status != nil)
    state = TrayViewState(daemon: daemon, tasks: tasks, commands: commands)
    return state
  }

  /// The handshake, run once at launch: `ping` reports the protocol version and
  /// the command list, so an old daemon greys the right items instead of
  /// answering `unknown cmd` to each click.
  @discardableResult
  public func handshake() -> TrayCompatibility {
    let reply = transport.send(["cmd": "ping"])
    guard reply.ok else { return .unversioned }
    if let cmds = reply.commands { state.commands = Set(cmds) }
    return trayCompatibility(reply, helper: trayProtocol)
  }

  /// Ask a question. Returns the sentence to show — the task id on success,
  /// because `ask` is a BACKGROUND task by construction (c22) and the id is what
  /// the user needs to find the answer later.
  public func ask(_ prompt: String) -> Result<String, TrayFailure> {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    // Checked HERE, not only in the daemon: a round trip to be told "need
    // prompt" is a round trip that didn't have to happen.
    guard !trimmed.isEmpty else { return .failure("nothing to ask") }
    let reply = transport.send(["cmd": "ask", "prompt": trimmed])
    guard reply.ok, let id = reply.id else {
      return .failure(TrayFailure(reply.error ?? "the daemon would not take that"))
    }
    return .success(id)
  }

  public func taskResult(_ id: String) -> Result<(state: String, text: String), TrayFailure> {
    let reply = transport.send(["cmd": "result", "id": id])
    guard reply.ok else { return .failure(TrayFailure(reply.error ?? "no result")) }
    // A `running` task legitimately has no result yet — say so rather than
    // showing an empty window.
    let text = reply.result?.isEmpty == false ? reply.result! : "(no output yet)"
    return .success((state: reply.state ?? "unknown", text: text))
  }

  public func cancel(_ id: String) -> String {
    let reply = transport.send(["cmd": "cancel", "id": id])
    // The daemon's own wording explains that cancelling stops the WAITING, not
    // the work — pass it through verbatim rather than inventing a cheerier one.
    return reply.ok ? (reply.message ?? "cancelled \(id)") : (reply.error ?? "could not cancel \(id)")
  }

  /// Share a file (a screenshot) with the daemon's agent. The daemon validates
  /// fast and runs the look as a background task, so this returns a sentence in
  /// one round trip.
  public func share(path: String, note: String) -> Result<String, TrayFailure> {
    let trimmedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedPath.isEmpty else { return .failure("no file to share") }
    var cmd: [String: Any] = ["cmd": "share", "path": trimmedPath]
    let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedNote.isEmpty { cmd["note"] = trimmedNote }
    let reply = transport.send(cmd)
    if reply.unavailable == true {
      state.commands.remove("share")
      return .failure(TrayFailure(reply.error ?? "this daemon cannot take a screenshot share"))
    }
    guard reply.ok else { return .failure(TrayFailure(reply.error ?? "the daemon would not take that")) }
    return .success(reply.message ?? "shared")
  }

  public func reloadTools() -> String {
    let reply = transport.send(["cmd": "reload"])
    if reply.unavailable == true {
      state.commands.remove("reload")
      return reply.error ?? "this daemon cannot reload tools"
    }
    return reply.ok ? (reply.message ?? "reloaded") : (reply.error ?? "reload failed")
  }
}

/// Running tasks first (they're the ones that will change), then newest.
///
/// `startedAt` is missing on some records, and a nil must never sort as time
/// ZERO — that would bury a task the daemon just told us about at the bottom of
/// the list. Missing timestamps sort as newest, next to the record that is most
/// likely to be new.
public func sortedForMenu(_ tasks: [TraySummary]) -> [TraySummary] {
  tasks.enumerated().sorted { a, b in
    let aRunning = a.element.status == "running"
    let bRunning = b.element.status == "running"
    if aRunning != bRunning { return aRunning }
    let aAt = a.element.startedAt ?? .greatestFiniteMagnitude
    let bAt = b.element.startedAt ?? .greatestFiniteMagnitude
    if aAt != bAt { return aAt > bAt }
    // Stable: equal keys keep the daemon's own order rather than an arbitrary one.
    return a.offset < b.offset
  }.map(\.element)
}

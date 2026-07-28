/// What the menu says — pure, so every sentence a user can see is testable
/// without a status item, a window server, or a daemon.
///
/// The whole reason the helper is split this way: a menu bar is the surface where
/// "it silently showed nothing" is the most likely bug and the hardest to notice.
/// So the decisions — is the daemon there, is it compatible, which items are
/// greyed out, what does the title say — are values here, and AppKit only draws
/// them.
import Foundation

/// The daemon as the menu understands it. Ordered by how bad the news is.
public enum DaemonState: Equatable, Sendable {
  case running(TrayStatus)
  /// Reachable, but the two halves can't understand each other.
  case incompatible(TrayCompatibility)
  /// Not reachable: no socket, a stale socket, a timeout.
  case unreachable(String)

  public var status: TrayStatus? {
    if case .running(let s) = self { return s }
    return nil
  }
}

/// The status-bar title. Deliberately a GLYPH plus at most a small number:
/// the menu bar is shared real estate and a helper that writes a sentence there
/// pushes the user's other icons off the screen.
public struct MenuTitle: Equatable, Sendable {
  public var glyph: String
  public var badge: String?
  /// The tooltip — where a sentence IS appropriate.
  public var tooltip: String

  public var display: String { badge.map { "\(glyph) \($0)" } ?? glyph }
}

public enum MenuGlyph {
  /// Distinct at a glance and legible in both light and dark menu bars.
  public static let running   = "◍"   // idle, all good
  public static let working   = "◐"   // tasks running
  public static let attention = "◑"   // needs a look
  public static let urgent    = "◉"   // stop everything
  public static let offline   = "○"   // daemon not reachable
  public static let problem   = "⊘"   // protocol mismatch

  public static func forMood(_ mood: String?) -> String {
    switch mood {
    case "working":   return working
    case "attention": return attention
    case "urgent":    return urgent
    case "offline":   return offline
    default:          return running   // 'idle' + nil
    }
  }
}

public func menuTitle(for state: DaemonState) -> MenuTitle {
  switch state {
  case .running(let s):
    let running = s.runningTasks
    let glyph = MenuGlyph.forMood(s.mood)

    // Urgent card — stops rotation, takes over the title
    if let urgentCard = s.ticker?.first(where: { $0.isUrgent }) {
      return MenuTitle(
        glyph: MenuGlyph.urgent,
        badge: nil,
        tooltip: urgentCard.displayText
      )
    }

    // Working — show task count badge
    if running > 0 {
      return MenuTitle(
        glyph: MenuGlyph.working,
        badge: String(running),
        tooltip: "tiny — \(running) task\(running == 1 ? "" : "s") running"
      )
    }

    // Now-playing compact display (shown in tooltip; ticker drives the title)
    let name = s.device?.name ?? "tiny"
    let tooltipBase = "\(name) — daemon running"
    let np = s.nowPlaying
    let tooltip = np != nil ? "\(tooltipBase) · ♫ \(np!.title) · \(np!.artist)" : tooltipBase
    return MenuTitle(glyph: glyph, badge: nil, tooltip: tooltip)

  case .incompatible(let c):
    return MenuTitle(glyph: MenuGlyph.problem, badge: nil, tooltip: c.advice ?? "tray protocol mismatch")
  case .unreachable(let why):
    return MenuTitle(glyph: MenuGlyph.offline, badge: nil, tooltip: why)
  }
}

/// The current ticker card to display given a tick index (caller rotates).
/// Returns nil when there are no normal cards to show (urgent is handled by menuTitle).
public func tickerDisplayText(cards: [TickerCard]?, tickIndex: Int) -> String? {
  guard let cards = cards else { return nil }
  let normal = cards.filter { !$0.isUrgent }
  guard !normal.isEmpty else { return nil }
  return normal[tickIndex % normal.count].displayText
}

/// One line in the menu. `action` nil = informational, not clickable.
public struct MenuRow: Equatable, Sendable {
  public enum Action: Equatable, Sendable {
    case ask
    case shareScreenshot
    case openTask(String)
    case cancelTask(String)
    case reloadTools
    case openLogs
    case openEvents
    case copyStatus
    case refresh
    case quit
  }

  /// A named color the DRAWING side maps to NSColor. An enum, not a color type,
  /// so the model keeps compiling (and testing) with no AppKit anywhere near it.
  public enum Tint: Equatable, Sendable {
    case none, accent, good, warn, bad, dim
  }

  public var label: String
  public var action: Action?
  public var enabled: Bool
  public var isSeparator: Bool
  /// Rendered dimmer / smaller — detail lines.
  public var isSecondary: Bool
  /// SF Symbol name drawn before the label. Nil = text only.
  public var symbol: String?
  public var tint: Tint
  /// A section header — rendered by the system header style where available.
  public var isHeader: Bool

  public init(
    label: String, action: Action? = nil, enabled: Bool = true,
    isSeparator: Bool = false, isSecondary: Bool = false,
    symbol: String? = nil, tint: Tint = .none, isHeader: Bool = false
  ) {
    self.label = label; self.action = action; self.enabled = enabled
    self.isSeparator = isSeparator; self.isSecondary = isSecondary
    self.symbol = symbol; self.tint = tint; self.isHeader = isHeader
  }

  public static let separator = MenuRow(label: "", isSeparator: true)
}

/// The status-bar icon, as an SF Symbol name. The text glyphs (◍ ◐ …) remain
/// the CLI's language; the menu bar gets the real icon set, template-tinted so
/// it matches every other icon in light and dark.
public func menuBarSymbol(for state: DaemonState) -> String {
  switch state {
  case .running(let s):
    if s.ticker?.contains(where: { $0.isUrgent }) == true { return "exclamationmark.triangle.fill" }
    if s.runningTasks > 0 { return "sparkles" }
    switch s.mood {
    case "attention": return "exclamationmark.circle"
    case "urgent":    return "exclamationmark.triangle.fill"
    default:          return "sparkle"
    }
  case .incompatible: return "exclamationmark.arrow.triangle.2.circlepath"
  case .unreachable:  return "circle.dotted"
  }
}

/// A task's state as symbol + color. Color carries the judgement (green good,
/// red bad) so the eye can scan a task list without reading it.
public func taskSymbol(_ status: String) -> (name: String, tint: MenuRow.Tint) {
  switch status {
  case "running":     return ("circle.dotted", .accent)
  case "done":        return ("checkmark.circle.fill", .good)
  case "failed":      return ("xmark.circle.fill", .bad)
  case "cancelled":   return ("slash.circle", .dim)
  case "interrupted": return ("exclamationmark.triangle.fill", .warn)
  case "timeout":     return ("clock.badge.exclamationmark", .warn)
  default:            return ("circle", .dim)
  }
}

/// An activity event's type as a symbol — same mapping the emoji glyphs carry
/// in the CLI, in the menu's native icon language.
/// SF Symbol per event type — the same vocabulary `TrayEventCard.glyph` switches
/// on, kept in lockstep with it (TrayProtocolTests asserts neither grows a case
/// the other lacks).
///
/// ⚠️ `clock.badge.checkmark` is a CHECKMARK, and it used to be what a FAILED
/// scheduled job drew: the daemon collapsed `job_result` and `job_error` into one
/// `"job"` type, so the symbol said the job completed. `job_error` is now its own
/// case with its own symbol, and `TRAY_EVENT_TYPES` in the daemon's tray.ts is
/// the shared roster that keeps the two halves honest.
public func eventSymbol(_ type: String?) -> String {
  switch type {
  case "job":             return "clock.badge.checkmark"
  case "job_error":       return "exclamationmark.triangle.fill"
  case "job_missed":      return "clock.badge.xmark"
  case "alarm":           return "exclamationmark.octagon.fill"
  case "money":           return "dollarsign.circle.fill"
  case "telegram":        return "paperplane.fill"
  case "message", "dm":   return "bubble.left.fill"
  case "device":          return "laptopcomputer"
  case "tool":            return "wrench.and.screwdriver.fill"
  case "visit":           return "arrow.right.circle"
  case "follow":          return "person.badge.plus"
  default:                return "bell.badge"
  }
}

/// The tasks a menu shows at once. A daemon can accumulate hundreds of finished
/// records; a menu that lists them all is unusable and slow to build, and the
/// full list already has a home (`tiny-tech tray tasks`).
public let menuTaskLimit = 6

/// Activity items shown in the menu. The full feed lives on tiny.technology.
public let menuEventLimit = 4

/// One activity event, on one line — glyph carries the type, summary the news.
public func eventLabel(_ e: TrayEventCard, width: Int = 44) -> String {
  "\(e.glyph)  \(truncateMiddle(e.summary.replacingOccurrences(of: "\n", with: " "), width: width))"
}

/// Build the whole menu. Every branch ends in at least Refresh and Quit — a menu
/// with no items reads as a broken helper, and "the daemon is not running" is
/// information the user needs *in* the menu.
public func buildMenu(state: DaemonState, tasks: [TraySummary], commands: Set<String> = []) -> [MenuRow] {
  var rows: [MenuRow] = []

  switch state {
  case .unreachable(let why):
    rows.append(MenuRow(label: "tiny daemon not running", enabled: false, symbol: "moon.zzz", tint: .dim))
    rows.append(MenuRow(label: why, enabled: false, isSecondary: true))
    rows.append(MenuRow(label: "start it with: tiny-tech daemon install", enabled: false, isSecondary: true))

  case .incompatible(let c):
    rows.append(MenuRow(label: "tray protocol mismatch", enabled: false, symbol: "exclamationmark.arrow.triangle.2.circlepath", tint: .warn))
    if let advice = c.advice {
      rows.append(MenuRow(label: advice, enabled: false, isSecondary: true))
    }

  case .running(let s):
    let device = s.device?.name ?? "(not enrolled)"
    let online = s.device?.online == true
    rows.append(MenuRow(
      label: device + (online ? " — online" : ""), enabled: false,
      symbol: online ? "circle.fill" : "circle", tint: online ? .good : .dim
    ))
    rows.append(MenuRow(label: "peers \(s.peerCount) · relay \(s.relay == true ? "polling" : "off")", enabled: false, isSecondary: true))

    var toolLine = "tools \(s.loadedTools) local"
    // A failed local tool is the user's to fix (a syntax error in their own
    // file), so it is stated rather than hidden — c18's rule, same reason.
    if s.failedTools > 0 { toolLine += " · \(s.failedTools) failed" }
    rows.append(MenuRow(
      label: toolLine, enabled: false, isSecondary: true,
      tint: s.failedTools > 0 ? .warn : .none
    ))

    if let senses = s.senses, !senses.isEmpty {
      rows.append(MenuRow(label: "senses " + senses.joined(separator: ", "), enabled: false, isSecondary: true))
    }

    rows.append(.separator)

    // `unavailable` from the daemon greys the item; an EMPTY commands set means
    // "not probed yet", so items stay enabled rather than all going grey on the
    // first paint.
    let canAsk = commands.isEmpty || commands.contains("ask")
    rows.append(MenuRow(label: "Ask tiny…", action: .ask, enabled: canAsk, symbol: "sparkles", tint: .accent))
    // Screenshot → the daemon's agent looks at it. Needs both a screen capture
    // (helper side) and the daemon's `share` command; greyed when the daemon
    // can't take it, same rule as every other command.
    let canShare = commands.isEmpty || commands.contains("share")
    rows.append(MenuRow(label: "Screenshot → tiny…", action: .shareScreenshot, enabled: canShare, symbol: "camera.viewfinder"))

    if let events = s.events, !events.isEmpty {
      rows.append(.separator)
      rows.append(MenuRow(label: "Activity", enabled: false, isSecondary: true, isHeader: true))
      for e in events.prefix(menuEventLimit) {
        // Clickable: the feed's home is the web app, so any event opens it.
        // The symbol carries the type; the label is all summary.
        rows.append(MenuRow(
          label: truncateMiddle(e.summary.replacingOccurrences(of: "\n", with: " "), width: 44),
          action: .openEvents, enabled: true, symbol: eventSymbol(e.type), tint: .dim
        ))
      }
      if events.count > menuEventLimit {
        rows.append(MenuRow(
          label: "\(events.count - menuEventLimit) more — tiny.technology",
          action: .openEvents, enabled: true, isSecondary: true
        ))
      }
    }

    if !tasks.isEmpty {
      rows.append(.separator)
      rows.append(MenuRow(label: "Tasks", enabled: false, isSecondary: true, isHeader: true))
      for t in tasks.prefix(menuTaskLimit) {
        // Symbol + color carry the state; the whole label is the prompt, which
        // is the only part the user actually recognises.
        let sym = taskSymbol(t.status)
        rows.append(MenuRow(
          label: truncateMiddle(t.prompt.replacingOccurrences(of: "\n", with: " "), width: 44),
          action: .openTask(t.id), enabled: true, symbol: sym.name, tint: sym.tint
        ))
      }
      if tasks.count > menuTaskLimit {
        // Never a silent cap: say how many are hidden and where they live.
        rows.append(MenuRow(
          label: "\(tasks.count - menuTaskLimit) more — tiny-tech tray tasks",
          enabled: false, isSecondary: true
        ))
      }
    }
  }

  rows.append(.separator)
  if case .running = state {
    let canReload = commands.isEmpty || commands.contains("reload")
    rows.append(MenuRow(label: "Reload local tools", action: .reloadTools, enabled: canReload, symbol: "arrow.clockwise"))
    if state.status?.logPath != nil {
      rows.append(MenuRow(label: "Open log", action: .openLogs, symbol: "doc.text"))
    }
    rows.append(MenuRow(label: "Copy status", action: .copyStatus, symbol: "doc.on.doc"))
  }
  rows.append(MenuRow(label: "Refresh", action: .refresh, symbol: "arrow.triangle.2.circlepath"))
  rows.append(MenuRow(label: "Quit tiny menubar", action: .quit, symbol: "power"))
  return rows
}

/// A task, on one line. The prompt is the only part the user recognises, so it
/// gets the space; the state glyph carries the rest.
public func taskLabel(_ t: TraySummary, width: Int = 44) -> String {
  "\(taskGlyph(t.status))  \(truncateMiddle(t.prompt.replacingOccurrences(of: "\n", with: " "), width: width))"
}

public func taskGlyph(_ status: String) -> String {
  switch status {
  case "running": return "◐"
  case "done": return "✓"
  case "failed": return "✗"
  case "cancelled": return "⊘"
  case "interrupted": return "⚠"
  case "timeout": return "⏱"
  default: return "·"
  }
}

/// Truncate in the MIDDLE, not the end: two background tasks asked minutes apart
/// often share a long prefix ("check the deploy status of …"), and end-truncation
/// would render them as the same line.
public func truncateMiddle(_ s: String, width: Int) -> String {
  let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
  guard trimmed.count > width, width > 4 else { return trimmed }
  let keep = width - 1
  let head = keep - keep / 2
  let tail = keep / 2
  return trimmed.prefix(head) + "…" + trimmed.suffix(tail)
}

/// Reduce a reply to the state the menu should show. Kept separate from the
/// client so a test can drive every branch with a literal reply.
public func daemonState(from reply: TrayReply, helper: Int = trayProtocol) -> DaemonState {
  guard reply.ok else { return .unreachable(reply.error ?? "the daemon did not answer") }
  let compat = trayCompatibility(reply, helper: helper)
  guard compat.isUsable else { return .incompatible(compat) }
  guard let status = reply.status else {
    // ok, compatible, but no status object — the daemon answered a different
    // command than the one we sent. Report it rather than showing an empty menu.
    return .unreachable("the daemon answered without a status")
  }
  return .running(status)
}

/// The text behind "Copy status" — the same facts the menu shows, in the shape
/// `tiny-tech tray status` prints, so a user pasting it into an issue gives the
/// same thing either way.
public func statusClipboardText(_ s: TrayStatus) -> String {
  var lines = [
    "device:  \(s.device?.name ?? "(not enrolled)")\(s.device?.online == true ? " — online" : "")",
    "peers:   \(s.peerCount)",
    "relay:   \(s.relay == true ? "polling" : "off")",
    "tasks:   \(s.runningTasks) running, \(s.finishedTasks) finished",
    "tools:   \(s.loadedTools) local\(s.failedTools > 0 ? ", \(s.failedTools) failed" : "")",
    "senses:  \(s.senses?.isEmpty == false ? s.senses!.joined(separator: ", ") : "none")",
  ]
  if let v = s.version { lines.append("version: \(v)") }
  if let log = s.logPath { lines.append("logs:    \(log)") }
  return lines.joined(separator: "\n")
}

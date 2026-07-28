/// What the menu says. Every sentence a user can read is decided by a pure
/// function, so every one of them is asserted here rather than eyeballed in a
/// screenshot.
import XCTest
@testable import TinyMenuKit

final class MenuModelTests: XCTestCase {

  private func status(
    running: Double = 0, finished: Double = 0, name: String? = "mac",
    senses: [String]? = nil, failed: Double = 0, log: String? = nil
  ) -> TrayStatus {
    TrayStatus(
      device: .init(name: name, id: "d1", online: true),
      peers: 2, senses: senses,
      tools: .init(loaded: 3, failed: failed),
      tasks: .init(running: running, finished: finished),
      relay: true, logPath: log
    )
  }

  private func task(_ id: String, _ st: String, _ prompt: String, at: Double? = nil) -> TraySummary {
    TraySummary(id: id, status: st, prompt: prompt, startedAt: at)
  }

  // ── the title ──────────────────────────────────────────────────────────────

  /// A permanent "0" badge trains the user to ignore the badge, which defeats it.
  func testNoBadgeWhenNothingIsRunning() {
    let t = menuTitle(for: .running(status(running: 0, finished: 9)))
    XCTAssertNil(t.badge)
    XCTAssertEqual(t.glyph, MenuGlyph.running)
    XCTAssertEqual(t.display, MenuGlyph.running)
    XCTAssertTrue(t.tooltip.contains("mac"))
  }

  func testBadgeCountsRunningTasksAndPluralisesHonestly() {
    let one = menuTitle(for: .running(status(running: 1)))
    XCTAssertEqual(one.badge, "1")
    XCTAssertEqual(one.glyph, MenuGlyph.working)
    XCTAssertTrue(one.tooltip.contains("1 task running"), one.tooltip)

    let many = menuTitle(for: .running(status(running: 3)))
    XCTAssertEqual(many.badge, "3")
    XCTAssertTrue(many.tooltip.contains("3 tasks running"), many.tooltip)
  }

  /// Three states, three glyphs — a helper whose icon looks the same whether the
  /// daemon is fine or gone is worse than no icon.
  func testEachStateHasItsOwnGlyph() {
    let glyphs = Set([
      menuTitle(for: .running(status())).glyph,
      menuTitle(for: .running(status(running: 1))).glyph,
      menuTitle(for: .unreachable("no socket")).glyph,
      menuTitle(for: .incompatible(.daemonOlder(daemon: 1, helper: 2))).glyph,
    ])
    XCTAssertEqual(glyphs.count, 4)
  }

  func testUnreachableTooltipCarriesTheReason() {
    let t = menuTitle(for: .unreachable("the tray socket is stale"))
    XCTAssertEqual(t.tooltip, "the tray socket is stale")
    XCTAssertEqual(t.glyph, MenuGlyph.offline)
  }

  func testUnenrolledDeviceStillGetsATooltip() {
    let t = menuTitle(for: .running(status(name: nil)))
    XCTAssertTrue(t.tooltip.contains("tiny"), t.tooltip)
    XCTAssertFalse(t.tooltip.contains("nil"))
  }

  // ── the menu ───────────────────────────────────────────────────────────────

  /// The invariant that matters most: a menu is never empty and always offers a
  /// way out. An empty menu reads as a broken helper.
  func testEveryStateYieldsAUsableMenu() {
    let states: [DaemonState] = [
      .running(status()),
      .unreachable("no socket at ~/.tiny/tray.sock"),
      .incompatible(.unversioned),
    ]
    for s in states {
      let rows = buildMenu(state: s, tasks: [])
      XCTAssertFalse(rows.isEmpty)
      let actions = rows.compactMap(\.action)
      XCTAssertTrue(actions.contains(.quit), "no way to quit in \(s)")
      XCTAssertTrue(actions.contains(.refresh), "no way to retry in \(s)")
    }
  }

  /// When the daemon is gone the menu must say how to start it — the user is in
  /// the menu precisely because something isn't working.
  func testUnreachableMenuExplainsHowToStartTheDaemon() {
    let rows = buildMenu(state: .unreachable("no tray socket at ~/.tiny/tray.sock"), tasks: [])
    let text = rows.map(\.label).joined(separator: "\n")
    XCTAssertTrue(text.contains("not running"))
    XCTAssertTrue(text.contains("tiny-tech daemon install"))
    XCTAssertTrue(text.contains("~/.tiny/tray.sock"), "the reason names the path it tried")
    // Nothing daemon-dependent should be clickable.
    XCTAssertFalse(rows.compactMap(\.action).contains(.ask))
    XCTAssertFalse(rows.compactMap(\.action).contains(.reloadTools))
  }

  func testIncompatibleMenuShowsTheAdvice() {
    let rows = buildMenu(state: .incompatible(.daemonOlder(daemon: 1, helper: 2)), tasks: [])
    XCTAssertTrue(rows.map(\.label).joined().contains("update tiny-tech"))
    XCTAssertFalse(rows.compactMap(\.action).contains(.ask), "don't offer commands we can't encode")
  }

  func testRunningMenuShowsTheFactsAndTheActions() {
    let rows = buildMenu(state: .running(status(running: 1, senses: ["browse", "desktop"], log: "/tmp/d.log")), tasks: [])
    let text = rows.map(\.label).joined(separator: "\n")
    XCTAssertTrue(text.contains("mac — online"))
    XCTAssertTrue(text.contains("peers 2"))
    XCTAssertTrue(text.contains("relay polling"))
    XCTAssertTrue(text.contains("tools 3 local"))
    XCTAssertTrue(text.contains("browse, desktop"))
    let actions = rows.compactMap(\.action)
    XCTAssertTrue(actions.contains(.ask))
    XCTAssertTrue(actions.contains(.reloadTools))
    XCTAssertTrue(actions.contains(.copyStatus))
    XCTAssertTrue(actions.contains(.openLogs))
  }

  /// No log path means no "Open log" item — an item that opens nothing is worse
  /// than a missing one.
  func testOpenLogAppearsOnlyWithALogPath() {
    let without = buildMenu(state: .running(status(log: nil)), tasks: [])
    XCTAssertFalse(without.compactMap(\.action).contains(.openLogs))
  }

  /// A failed local tool is the user's own file to fix, so it is named, not hidden.
  func testFailedToolsAreStated() {
    let rows = buildMenu(state: .running(status(failed: 2)), tasks: [])
    XCTAssertTrue(rows.map(\.label).joined().contains("2 failed"))
  }

  /// An empty command set means "not probed yet" — items stay enabled, because
  /// greying everything out on the first paint looks like a broken daemon.
  func testUnprobedCommandsLeaveItemsEnabled() {
    let rows = buildMenu(state: .running(status()), tasks: [], commands: [])
    XCTAssertTrue(rows.first { $0.action == .ask }!.enabled)
    XCTAssertTrue(rows.first { $0.action == .reloadTools }!.enabled)
  }

  /// A daemon with no task runner reports `unavailable` — the item greys out
  /// rather than clicking through to an error.
  func testDaemonWithoutTaskRunnerGreysAskOut() {
    let rows = buildMenu(state: .running(status()), tasks: [], commands: ["ping", "status", "logs"])
    XCTAssertFalse(rows.first { $0.action == .ask }!.enabled)
    XCTAssertFalse(rows.first { $0.action == .reloadTools }!.enabled)
    // Still present, still says what it is — the user learns the capability exists.
    XCTAssertTrue(rows.contains { $0.label == "Ask tiny…" })
  }

  // ── tasks ──────────────────────────────────────────────────────────────────

  func testTasksAppearWithStateSymbolsAndTints() {
    let tasks = [
      task("t1", "running", "check the deploy"),
      task("t2", "done", "summarise my inbox"),
      task("t3", "failed", "poke the printer"),
      task("t4", "interrupted", "long crawl"),
    ]
    let rows = buildMenu(state: .running(status(running: 1, finished: 3)), tasks: tasks)
    // The state travels in symbol + tint now, and color carries the judgement:
    // green good, red bad — scannable without reading.
    XCTAssertTrue(rows.contains { $0.symbol == "circle.dotted" && $0.tint == .accent })
    XCTAssertTrue(rows.contains { $0.symbol == "checkmark.circle.fill" && $0.tint == .good })
    XCTAssertTrue(rows.contains { $0.symbol == "xmark.circle.fill" && $0.tint == .bad })
    XCTAssertTrue(rows.contains { $0.symbol == "exclamationmark.triangle.fill" && $0.tint == .warn })
    for t in tasks {
      XCTAssertTrue(rows.compactMap(\.action).contains(.openTask(t.id)), "\(t.id) not clickable")
    }
  }

  func testUnknownTaskStateGetsANeutralSymbol() {
    let sym = taskSymbol("something-new")
    XCTAssertEqual(sym.name, "circle")
    XCTAssertEqual(sym.tint, .dim)
  }

  /// Never a silent cap: the hidden count and where to see the rest.
  func testTaskListCapSaysWhatItHid() {
    let many = (1...10).map { task("t\($0)", "done", "job \($0)") }
    let rows = buildMenu(state: .running(status(finished: 10)), tasks: many)
    let shown = rows.compactMap(\.action).filter { if case .openTask = $0 { return true } else { return false } }
    XCTAssertEqual(shown.count, menuTaskLimit)
    let text = rows.map(\.label).joined(separator: "\n")
    XCTAssertTrue(text.contains("\(10 - menuTaskLimit) more"), text)
    XCTAssertTrue(text.contains("tiny-tech tray tasks"))
  }

  func testNoTasksMeansNoTasksSection() {
    let rows = buildMenu(state: .running(status()), tasks: [])
    XCTAssertFalse(rows.contains { $0.label == "Tasks" })
  }

  /// A newline in a prompt would break the menu item into something unreadable.
  func testMultilinePromptsAreFlattened() {
    let label = taskLabel(task("t1", "done", "line one\nline two"))
    XCTAssertFalse(label.contains("\n"))
    XCTAssertTrue(label.contains("line one line two"))
  }

  /// Two tasks asked minutes apart often share a long prefix, so end-truncation
  /// would render them as the same line.
  func testTruncationKeepsTheEndSoSimilarPromptsStayDistinct() {
    let a = truncateMiddle("check the deployment status of the worker in staging", width: 24)
    let b = truncateMiddle("check the deployment status of the worker in production", width: 24)
    XCTAssertNotEqual(a, b)
    XCTAssertTrue(a.contains("…"))
    XCTAssertLessThanOrEqual(a.count, 24)
    XCTAssertTrue(a.hasSuffix("staging"))
    XCTAssertTrue(b.hasSuffix("production"))
  }

  func testShortPromptsAreUntouched() {
    XCTAssertEqual(truncateMiddle("hi", width: 20), "hi")
    XCTAssertEqual(truncateMiddle("  padded  ", width: 20), "padded")
  }

  /// Emoji and other multi-scalar graphemes must not be cut mid-character — Swift
  /// Strings make this safe, and this test keeps a future byte-based rewrite from
  /// breaking it.
  func testTruncationIsGraphemeSafe() {
    let s = String(repeating: "👨‍👩‍👧‍👦", count: 20)
    let out = truncateMiddle(s, width: 10)
    XCTAssertLessThanOrEqual(out.count, 10)
    XCTAssertTrue(out.contains("…"))
  }

  func testUnknownTaskStateGetsANeutralGlyph() {
    XCTAssertEqual(taskGlyph("something-new"), "·")
    XCTAssertEqual(taskGlyph(""), "·")
  }

  // ── reply → state ──────────────────────────────────────────────────────────

  func testOkStatusReplyBecomesRunning() {
    let reply = TrayReply(ok: true, protocolVersion: 1, status: status(running: 2))
    guard case .running(let s) = daemonState(from: reply) else { return XCTFail("expected running") }
    XCTAssertEqual(s.runningTasks, 2)
  }

  func testFailedReplyBecomesUnreachableWithItsReason() {
    let reply = TrayReply.failure("no tray socket at /x/tray.sock")
    guard case .unreachable(let why) = daemonState(from: reply) else { return XCTFail("expected unreachable") }
    XCTAssertEqual(why, "no tray socket at /x/tray.sock")
  }

  func testVersionMismatchBecomesIncompatibleNotUnreachable() {
    let reply = TrayReply(ok: true, protocolVersion: 99, status: status())
    guard case .incompatible = daemonState(from: reply, helper: 1) else {
      return XCTFail("a reachable-but-mismatched daemon is not the same as a missing one")
    }
  }

  /// ok + compatible + no status = the daemon answered a different command.
  /// Reporting it beats showing an empty menu.
  func testOkWithoutStatusIsReported() {
    let reply = TrayReply(ok: true, protocolVersion: 1)
    guard case .unreachable(let why) = daemonState(from: reply) else { return XCTFail("expected unreachable") }
    XCTAssertTrue(why.contains("without a status"))
  }

  // ── clipboard ──────────────────────────────────────────────────────────────

  /// Copy status has to match what `tiny-tech tray status` prints, so a user
  /// pasting into an issue gives the same thing either way.
  func testClipboardTextMatchesTheCliShape() {
    let text = statusClipboardText(status(running: 1, finished: 2, senses: ["browse"], log: "/tmp/d.log"))
    for key in ["device:", "peers:", "relay:", "tasks:", "tools:", "senses:", "logs:"] {
      XCTAssertTrue(text.contains(key), "missing \(key) in:\n\(text)")
    }
    XCTAssertTrue(text.contains("1 running, 2 finished"))
  }

  func testClipboardTextHandlesAnEmptyDaemon() {
    let text = statusClipboardText(TrayStatus())
    XCTAssertTrue(text.contains("(not enrolled)"))
    XCTAssertTrue(text.contains("senses:  none"))
    XCTAssertFalse(text.contains("nil"))
  }

  // ── activity (pushes) ────────────────────────────────────────────────────

  func testActivitySectionShowsEventsWithTypeSymbols() {
    var st = status()
    st.events = [
      TrayEventCard(type: "job", summary: "nightly digest finished"),
      TrayEventCard(type: "telegram", summary: "message from @cagatay"),
    ]
    let rows = buildMenu(state: .running(st), tasks: [])
    XCTAssertTrue(rows.contains { $0.label == "Activity" && $0.isHeader })
    XCTAssertTrue(rows.contains { $0.symbol == "clock.badge.checkmark" && $0.label.contains("nightly digest") })
    XCTAssertTrue(rows.contains { $0.symbol == "paperplane.fill" && $0.label.contains("@cagatay") })
    // Every event row opens the feed
    XCTAssertTrue(rows.filter { $0.action == .openEvents }.count >= 2)
  }

  func testHeadersAreMarkedForTheSystemHeaderStyle() {
    var st = status()
    st.events = [TrayEventCard(type: "job", summary: "x")]
    let rows = buildMenu(state: .running(st), tasks: [task("t1", "done", "y")])
    XCTAssertTrue(rows.contains { $0.label == "Activity" && $0.isHeader })
    XCTAssertTrue(rows.contains { $0.label == "Tasks" && $0.isHeader })
  }

  func testMenuBarSymbolDistinguishesEveryDaemonMood() {
    let working = status(running: 2)
    var urgent = status()
    urgent.ticker = [TickerCard(text: "disk full", priority: "urgent")]
    let symbols = Set([
      menuBarSymbol(for: .running(status())),
      menuBarSymbol(for: .running(working)),
      menuBarSymbol(for: .running(urgent)),
      menuBarSymbol(for: .unreachable("no socket")),
      menuBarSymbol(for: .incompatible(.daemonOlder(daemon: 1, helper: 2))),
    ])
    XCTAssertEqual(symbols.count, 5, "every state must be tellable at a glance: \(symbols)")
  }

  func testNoEventsMeansNoActivitySection() {
    let rows = buildMenu(state: .running(status()), tasks: [])
    XCTAssertFalse(rows.contains { $0.label == "Activity" })
  }

  func testActivityCapSaysWhatItHidAndWhere() {
    var st = status()
    st.events = (1...7).map { TrayEventCard(type: "visit", summary: "visit #\($0)") }
    let rows = buildMenu(state: .running(st), tasks: [])
    let shown = rows.filter { $0.label.contains("visit #") }
    XCTAssertEqual(shown.count, menuEventLimit)
    XCTAssertTrue(rows.contains { $0.label.contains("3 more") && $0.label.contains("tiny.technology") })
  }

  // ── screenshot share ─────────────────────────────────────────────────────

  func testScreenshotRowIsGreyedWhenTheDaemonCannotShare() {
    let with = buildMenu(state: .running(status()), tasks: [], commands: ["ping", "status", "ask", "share"])
    XCTAssertTrue(with.contains { $0.action == .shareScreenshot && $0.enabled })

    let without = buildMenu(state: .running(status()), tasks: [], commands: ["ping", "status", "ask"])
    XCTAssertTrue(without.contains { $0.action == .shareScreenshot && !$0.enabled })
  }

  func testUnprobedCommandsLeaveScreenshotEnabled() {
    let rows = buildMenu(state: .running(status()), tasks: [], commands: [])
    XCTAssertTrue(rows.contains { $0.action == .shareScreenshot && $0.enabled })
  }

  func testEventLabelFlattensNewlinesAndTruncates() {
    let e = TrayEventCard(type: "job", summary: "line one\nline two " + String(repeating: "x", count: 100))
    let label = eventLabel(e, width: 30)
    XCTAssertFalse(label.contains("\n"))
    XCTAssertTrue(label.contains("…"))
    XCTAssertTrue(label.hasPrefix("⏳"))
  }

}

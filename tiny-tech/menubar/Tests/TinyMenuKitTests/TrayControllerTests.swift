/// Polling rules, driven by a fake transport: no daemon, no socket, no waiting.
/// A menu bar that polls too often is a battery bug nobody reports, so the rules
/// are asserted rather than assumed.
import XCTest
@testable import TinyMenuKit

/// Records what was asked and answers from a script. Not `Sendable`-safe by
/// accident: the controller is documented as single-queue, and this asserts that
/// by being a plain class.
final class FakeTransport: TrayTransport, @unchecked Sendable {
  private(set) var sent: [[String: Any]] = []
  var answers: [String: TrayReply] = [:]
  var fallback: TrayReply = .failure("no answer scripted")

  init(_ answers: [String: TrayReply] = [:]) { self.answers = answers }

  func send(_ command: [String: Any]) -> TrayReply {
    sent.append(command)
    let cmd = command["cmd"] as? String ?? ""
    return answers[cmd] ?? fallback
  }

  var commandsSent: [String] { sent.compactMap { $0["cmd"] as? String } }
}

final class TrayControllerTests: XCTestCase {

  private func status(running: Double = 0, finished: Double = 0) -> TrayStatus {
    TrayStatus(
      device: .init(name: "mac", online: true), peers: 1,
      tools: .init(loaded: 0, failed: 0),
      tasks: .init(running: running, finished: finished), relay: true
    )
  }

  // ── polling ────────────────────────────────────────────────────────────────

  /// The common case is a daemon with NO tasks, and paying a second round trip
  /// every 5 seconds to be told "none" is waste that adds up all day.
  func testPollSkipsTheTasksCallWhenThereAreNoTasks() {
    let t = FakeTransport(["status": TrayReply(ok: true, status: status())])
    let c = TrayController(transport: t)
    c.poll()
    XCTAssertEqual(t.commandsSent, ["status"])
  }

  func testPollFetchesTasksWhenTheDaemonHasSome() {
    let t = FakeTransport([
      "status": TrayReply(ok: true, status: status(running: 1)),
      "tasks": TrayReply(ok: true, tasks: [TraySummary(id: "t1", status: "running", prompt: "work")]),
    ])
    let c = TrayController(transport: t)
    let state = c.poll()
    XCTAssertEqual(t.commandsSent, ["status", "tasks"])
    XCTAssertEqual(state.tasks.count, 1)
  }

  /// Finished-only still needs the list: the user's most likely reason to open
  /// the menu is to read an answer that arrived while they weren't looking.
  func testFinishedTasksAreFetchedToo() {
    let t = FakeTransport([
      "status": TrayReply(ok: true, status: status(running: 0, finished: 4)),
      "tasks": TrayReply(ok: true, tasks: [TraySummary(id: "t1", status: "done", prompt: "done thing")]),
    ])
    TrayController(transport: t).poll()
    XCTAssertEqual(t.commandsSent, ["status", "tasks"])
  }

  /// Stale tasks from a daemon we can no longer reach would read as live state.
  func testTasksAreDroppedWhenTheDaemonGoesAway() {
    let t = FakeTransport([
      "status": TrayReply(ok: true, status: status(running: 1)),
      "tasks": TrayReply(ok: true, tasks: [TraySummary(id: "t1", status: "running", prompt: "work")]),
    ])
    let c = TrayController(transport: t)
    XCTAssertEqual(c.poll().tasks.count, 1)

    t.answers["status"] = .failure("socket closed")
    let after = c.poll()
    XCTAssertTrue(after.tasks.isEmpty)
    XCTAssertTrue(after.commands.isEmpty, "capabilities of a daemon we can't reach are not facts")
  }

  /// Slow to give up, instant to recover — the asymmetry is the whole point.
  func testBackoffGrowsWhileUnreachableAndSnapsBackOnRecovery() {
    XCTAssertEqual(nextPollInterval(current: trayPollInterval, reachable: true), trayPollInterval)
    var i = trayPollInterval
    var seen: [TimeInterval] = []
    for _ in 0..<8 { i = nextPollInterval(current: i, reachable: false); seen.append(i) }
    XCTAssertEqual(seen.first, trayPollInterval * 2)
    XCTAssertEqual(seen.last, trayPollMaxInterval, "backoff must cap")
    XCTAssertEqual(nextPollInterval(current: i, reachable: true), trayPollInterval)
  }

  func testControllerBacksOffWhenTheDaemonIsMissing() {
    let t = FakeTransport()
    t.fallback = .failure("no socket")
    let c = TrayController(transport: t)
    c.poll()
    let first = c.interval
    c.poll()
    XCTAssertGreaterThan(c.interval, first)
    XCTAssertLessThanOrEqual(c.interval, trayPollMaxInterval)
  }

  /// The initial state must already be renderable — the first paint happens
  /// before the first poll returns.
  func testInitialStateRendersSomething() {
    let c = TrayController(transport: FakeTransport())
    XCTAssertFalse(c.state.rows.isEmpty)
    XCTAssertEqual(c.state.title.glyph, MenuGlyph.offline)
  }

  // ── handshake ──────────────────────────────────────────────────────────────

  func testHandshakeLearnsTheCommandList() {
    let t = FakeTransport(["ping": TrayReply(ok: true, protocolVersion: 1, commands: ["ping", "status", "logs"])])
    let c = TrayController(transport: t)
    XCTAssertEqual(c.handshake(), .ok)
    XCTAssertEqual(c.state.commands, ["ping", "status", "logs"])
    // Which greys the items this daemon can't serve.
    let rows = buildMenu(state: .running(status()), tasks: [], commands: c.state.commands)
    XCTAssertFalse(rows.first { $0.action == .ask }!.enabled)
  }

  func testHandshakeOnADeadSocketIsUnversioned() {
    let t = FakeTransport()
    t.fallback = .failure("nothing there")
    XCTAssertEqual(TrayController(transport: t).handshake(), .unversioned)
  }

  // ── ask ────────────────────────────────────────────────────────────────────

  /// A round trip to be told "need prompt" is a round trip that didn't have to
  /// happen.
  func testEmptyPromptNeverReachesTheDaemon() {
    let t = FakeTransport()
    let c = TrayController(transport: t)
    for blank in ["", "   ", "\n\t "] {
      XCTAssertEqual(c.ask(blank), .failure("nothing to ask"))
    }
    XCTAssertTrue(t.sent.isEmpty)
  }

  func testAskReturnsTheTaskIdAndTrimsThePrompt() {
    let t = FakeTransport(["ask": TrayReply(ok: true, id: "t_42")])
    let c = TrayController(transport: t)
    XCTAssertEqual(c.ask("  what happened overnight?  "), .success("t_42"))
    XCTAssertEqual(t.sent.last?["prompt"] as? String, "what happened overnight?")
  }

  /// The cap message ("3 tasks already running") is the daemon's to write — pass
  /// it through instead of inventing one.
  func testAskSurfacesTheDaemonsRefusalVerbatim() {
    let t = FakeTransport(["ask": TrayReply(ok: false, error: "3 tasks already running — wait or cancel one")])
    XCTAssertEqual(
      TrayController(transport: t).ask("go"),
      .failure("3 tasks already running — wait or cancel one")
    )
  }

  /// ok with no id would otherwise look like success and leave the user with no
  /// way to find the answer.
  func testAskWithoutAnIdIsAFailure() {
    let t = FakeTransport(["ask": TrayReply(ok: true)])
    guard case .failure = TrayController(transport: t).ask("go") else {
      return XCTFail("an id-less accept is not an accept")
    }
  }

  // ── results, cancel, reload ────────────────────────────────────────────────

  func testTaskResultReadsStateAndText() {
    let t = FakeTransport(["result": TrayReply(ok: true, id: "t1", state: "done", result: "the answer")])
    guard case .success(let r) = TrayController(transport: t).taskResult("t1") else { return XCTFail() }
    XCTAssertEqual(r.state, "done")
    XCTAssertEqual(r.text, "the answer")
  }

  /// A running task legitimately has no output yet — say so rather than showing
  /// an empty window that reads as a lost answer.
  func testRunningTaskWithNoOutputSaysSo() {
    let t = FakeTransport(["result": TrayReply(ok: true, id: "t1", state: "running", result: "")])
    guard case .success(let r) = TrayController(transport: t).taskResult("t1") else { return XCTFail() }
    XCTAssertEqual(r.state, "running")
    XCTAssertEqual(r.text, "(no output yet)")
  }

  func testMissingTaskIsAnError() {
    let t = FakeTransport(["result": TrayReply(ok: false, error: "no such task: t9")])
    guard case .failure(let why) = TrayController(transport: t).taskResult("t9") else { return XCTFail() }
    XCTAssertEqual(why, "no such task: t9")
  }

  /// Cancelling stops the WAITING, not the work — the daemon says that in those
  /// words, and softening it would be a lie about the user's laptop.
  func testCancelPassesTheDaemonsWordingThrough() {
    let honest = "stopped waiting for t1 — the work already in flight cannot be aborted"
    let t = FakeTransport(["cancel": TrayReply(ok: true, id: "t1", message: honest)])
    XCTAssertEqual(TrayController(transport: t).cancel("t1"), honest)
  }

  func testReloadReportsTheDaemonsMessage() {
    let t = FakeTransport(["reload": TrayReply(ok: true, message: "3 local tools loaded")])
    XCTAssertEqual(TrayController(transport: t).reloadTools(), "3 local tools loaded")
  }

  /// An `unavailable` reply doesn't just report — it removes the capability, so
  /// the item is greyed out from then on instead of failing on every click.
  func testUnavailableReloadGreysTheItemFromThenOn() {
    let t = FakeTransport([
      // Seeded the way the app seeds it — through the real handshake, so this
      // asserts the actual path rather than a hand-set field.
      "ping": TrayReply(ok: true, protocolVersion: 1, commands: ["ping", "status", "ask", "reload"]),
      "reload": TrayReply(ok: false, error: "reload is not available on this daemon", unavailable: true),
    ])
    let c = TrayController(transport: t)
    c.handshake()
    XCTAssertTrue(c.state.commands.contains("reload"))
    let message = c.reloadTools()
    XCTAssertTrue(message.contains("not available"))
    XCTAssertFalse(c.state.commands.contains("reload"))
    let rows = buildMenu(state: .running(status()), tasks: [], commands: c.state.commands)
    XCTAssertFalse(rows.first { $0.action == .reloadTools }!.enabled)
  }

  // ── ordering ───────────────────────────────────────────────────────────────

  func testRunningTasksSortFirstThenNewest() {
    let sorted = sortedForMenu([
      TraySummary(id: "old-done", status: "done", prompt: "a", startedAt: 100),
      TraySummary(id: "new-done", status: "done", prompt: "b", startedAt: 300),
      TraySummary(id: "running", status: "running", prompt: "c", startedAt: 200),
    ])
    XCTAssertEqual(sorted.map(\.id), ["running", "new-done", "old-done"])
  }

  /// A nil `startedAt` must not sort as time ZERO: that buries a record the
  /// daemon just told us about at the bottom of the list.
  func testMissingTimestampsSortAsNewestNotOldest() {
    let sorted = sortedForMenu([
      TraySummary(id: "timed", status: "done", prompt: "a", startedAt: 100),
      TraySummary(id: "untimed", status: "done", prompt: "b", startedAt: nil),
    ])
    XCTAssertEqual(sorted.first?.id, "untimed")
  }

  /// Equal keys keep the daemon's own order — an unstable sort makes a polling
  /// menu reshuffle itself under the user's cursor.
  func testSortIsStableForEqualKeys() {
    let input = (1...5).map { TraySummary(id: "t\($0)", status: "done", prompt: "p", startedAt: 100) }
    XCTAssertEqual(sortedForMenu(input).map(\.id), input.map(\.id))
    XCTAssertEqual(sortedForMenu(sortedForMenu(input)).map(\.id), input.map(\.id))
  }

  // ── share ─────────────────────────────────────────────────────────────────

  func testShareSendsPathAndNote() {
    let t = FakeTransport(["share": TrayReply(ok: true, message: "shared — task t9 is looking at it")])
    let c = TrayController(transport: t)
    let r = c.share(path: "/tmp/shot.png", note: "what is this error?")
    XCTAssertEqual(r, .success("shared — task t9 is looking at it"))
    XCTAssertEqual(t.sent.first?["cmd"] as? String, "share")
    XCTAssertEqual(t.sent.first?["path"] as? String, "/tmp/shot.png")
    XCTAssertEqual(t.sent.first?["note"] as? String, "what is this error?")
  }

  func testShareOmitsAnEmptyNote() {
    let t = FakeTransport(["share": TrayReply(ok: true, message: "shared")])
    let c = TrayController(transport: t)
    _ = c.share(path: "/tmp/shot.png", note: "   ")
    XCTAssertNil(t.sent.first?["note"])
  }

  func testShareRefusesAnEmptyPathWithoutARoundTrip() {
    let t = FakeTransport()
    let c = TrayController(transport: t)
    let r = c.share(path: "  ", note: "")
    XCTAssertEqual(r, .failure("no file to share"))
    XCTAssertTrue(t.sent.isEmpty)
  }

  func testShareUnavailableRemovesTheCommand() {
    let t = FakeTransport([
      "ping": TrayReply(ok: true, protocolVersion: trayProtocol, commands: ["ping", "status", "share"]),
      "share": TrayReply(ok: false, error: "share is not available on this daemon", unavailable: true),
    ])
    let c = TrayController(transport: t)
    c.handshake()
    XCTAssertTrue(c.state.commands.contains("share"))
    let r = c.share(path: "/tmp/x.png", note: "")
    if case .failure = r {} else { XCTFail("expected failure") }
    XCTAssertFalse(c.state.commands.contains("share"))
  }

}

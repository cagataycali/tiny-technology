/// Decoding the daemon's replies — the half of the contract Swift can get wrong
/// while JavaScript stays happy.
import XCTest
@testable import TinyMenuKit

final class TrayProtocolTests: XCTestCase {

  // ── the wire shape ─────────────────────────────────────────────────────────

  /// `protocol` is a Swift keyword, so this only works through CodingKeys — and
  /// if that mapping ever breaks, EVERY reply decodes as unversioned and the menu
  /// permanently says "not a tiny-tech tray".
  func testDecodesTheProtocolKeywordKey() {
    let r = TrayReply.decode(#"{"ok":true,"protocol":1,"pid":123}"#)
    XCTAssertTrue(r.ok)
    XCTAssertEqual(r.protocolVersion, 1)
    XCTAssertEqual(r.pid, 123)
  }

  /// The `result` reply carries the task state under `state`. The daemon renamed
  /// it for this decoder (c22), so pin it here too: a rename on either side
  /// should fail a test, not a user's menu.
  func testResultUsesStateNotStatus() {
    let r = TrayReply.decode(#"{"ok":true,"protocol":1,"id":"t_1","state":"done","result":"hello"}"#)
    XCTAssertEqual(r.state, "done")
    XCTAssertEqual(r.result, "hello")
    XCTAssertNil(r.status, "a task's state must never decode into the status OBJECT")
  }

  /// A `status` reply and a `result` reply both have a top-level key that used to
  /// be called `status`. One Codable has to handle both without ambiguity.
  func testStatusObjectAndTaskStateCoexist() {
    let status = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"peers":2,"relay":true}}"#)
    XCTAssertEqual(status.status?.peerCount, 2)
    XCTAssertEqual(status.status?.relay, true)
    XCTAssertNil(status.state)
  }

  func testDecodesTheFullStatusObject() {
    let json = """
    {"ok":true,"protocol":1,"status":{
      "device":{"name":"cagatay's mac","id":"dev_1","online":true},
      "peers":3,"senses":["computer","browse","desktop"],
      "tools":{"loaded":4,"failed":1},
      "tasks":{"running":2,"finished":7},
      "relay":true,"logPath":"/Users/x/.tiny/daemon.log","startedAt":1753000000000,"version":"0.8.0"}}
    """
    let s = TrayReply.decode(json).status
    XCTAssertEqual(s?.device?.name, "cagatay's mac")
    XCTAssertEqual(s?.device?.online, true)
    XCTAssertEqual(s?.peerCount, 3)
    XCTAssertEqual(s?.senses, ["computer", "browse", "desktop"])
    XCTAssertEqual(s?.loadedTools, 4)
    XCTAssertEqual(s?.failedTools, 1)
    XCTAssertEqual(s?.runningTasks, 2)
    XCTAssertEqual(s?.finishedTasks, 7)
    XCTAssertEqual(s?.version, "0.8.0")
  }

  /// Every field on TrayStatus is optional in the TypeScript interface, so a
  /// daemon that reports only what it knows must still decode.
  func testEmptyStatusDecodesToZeros() {
    let s = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{}}"#).status
    XCTAssertNotNil(s)
    XCTAssertEqual(s?.peerCount, 0)
    XCTAssertEqual(s?.runningTasks, 0)
    XCTAssertEqual(s?.loadedTools, 0)
    XCTAssertNil(s?.device)
  }

  /// `device: null` is what the daemon sends before enrollment — an explicit null
  /// must not fail the whole reply.
  func testExplicitNullDeviceDecodes() {
    let r = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"device":null,"peers":0}}"#)
    XCTAssertTrue(r.ok)
    XCTAssertNil(r.status?.device)
  }

  /// Counts are Doubles precisely so `4.0` doesn't throw. An Int field here would
  /// blank the ENTIRE menu over one float.
  func testFloatCountsDoNotFailTheReply() {
    let s = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"peers":2.0,"tasks":{"running":1.0}}}"#).status
    XCTAssertEqual(s?.peerCount, 2)
    XCTAssertEqual(s?.runningTasks, 1)
  }

  /// `Int(Double.infinity)` TRAPS in Swift — this is a crash, not an overflow.
  func testAbsurdCountsClampInsteadOfCrashing() {
    XCTAssertEqual(safeInt(Double.infinity), 1_000_000)
    XCTAssertEqual(safeInt(-Double.infinity), 0)
    XCTAssertEqual(safeInt(Double.nan), 0)
    XCTAssertEqual(safeInt(1e300), 1_000_000)
    XCTAssertEqual(safeInt(-5), 0)
    XCTAssertEqual(safeInt(nil), 0)
    XCTAssertEqual(safeInt(7.9), 7)
  }

  /// The one this suite caught. `Double?` fields are not enough on their own:
  /// Foundation's JSONDecoder throws `dataCorrupted` on a literal outside Double's
  /// range, so before `lenientNumber` this reply failed to decode ENTIRELY and the
  /// menu went blank — the exact failure the Double-not-Int choice was meant to
  /// prevent, moved one level up.
  func testHugeCountFromTheWireIsClamped() {
    let s = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"peers":1e309}}"#).status
    XCTAssertEqual(s?.peerCount, 1_000_000, "1e309 is out of Double range — it must clamp, not fail the reply")
  }

  /// And the property that actually matters: one unreadable number must cost that
  /// FIELD, not the whole menu. Everything around it still has to render.
  func testAnAbsurdNumberDoesNotBlankTheRestOfTheMenu() {
    let json = """
    {"ok":true,"protocol":1,"status":{
      "device":{"name":"mac","online":true},"peers":1e400,
      "tasks":{"running":2,"finished":1e999},"relay":true,"version":"0.8.0"}}
    """
    let r = TrayReply.decode(json)
    XCTAssertTrue(r.ok, "the reply must survive: \(r.error ?? "")")
    XCTAssertEqual(r.status?.device?.name, "mac")
    XCTAssertEqual(r.status?.relay, true)
    XCTAssertEqual(r.status?.version, "0.8.0")
    XCTAssertEqual(r.status?.runningTasks, 2, "a sane sibling of a broken field is still sane")
    XCTAssertEqual(r.status?.peerCount, 1_000_000)
    XCTAssertEqual(r.status?.finishedTasks, 1_000_000)
  }

  /// Leniency is for numbers only. A string where a count belongs is protocol
  /// drift, and a helper that quietly renders 0 peers would hide it — but a
  /// NUMERIC string is just a daemon being loose with JSON, and that still counts.
  func testStringsWhereNumbersBelong() {
    let numeric = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"peers":"3"}}"#)
    XCTAssertEqual(numeric.status?.peerCount, 3)

    let nonsense = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"peers":"lots"}}"#)
    XCTAssertEqual(nonsense.status?.peerCount, 1_000_000, "unreadable clamps rather than reading as idle")
  }

  /// An ABSENT or null count is "not reported", which is nil — never a number.
  /// The distinction is the whole reason `lenientNumber` checks presence first: an
  /// earlier draft asked only "is it readable?", which made an empty `{}` status
  /// report a million peers.
  func testAbsentAndNullCountsAreNotNumbers() {
    let empty = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{}}"#).status
    XCTAssertNil(empty?.peers, "an unreported count is not a count")
    XCTAssertEqual(empty?.peerCount, 0)

    let explicitNull = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"peers":null,"tasks":{"running":null}}}"#).status
    XCTAssertNil(explicitNull?.peers)
    XCTAssertEqual(explicitNull?.runningTasks, 0)
    XCTAssertEqual(explicitNull?.peerCount, 0)
  }

  /// Zero is a real, reported value and must stay distinguishable from unreported:
  /// "0 peers" is a fact about a lonely daemon, nil is the absence of one.
  func testZeroIsReportedNotAbsent() {
    let s = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"peers":0}}"#).status
    XCTAssertEqual(s?.peers, 0)
    XCTAssertEqual(s?.peerCount, 0)
  }

  /// A wrongly-typed STRING field still fails loudly — the lenient path is not a
  /// blanket "decode anything".
  func testWrongTypeInAStringFieldIsStillAnError() {
    let r = TrayReply.decode(#"{"ok":true,"protocol":1,"status":{"version":42}}"#)
    XCTAssertFalse(r.ok)
    XCTAssertTrue(r.error!.contains("version"), r.error!)
  }

  // ── failures ───────────────────────────────────────────────────────────────

  func testErrorReplyKeepsItsSentence() {
    let r = TrayReply.decode(#"{"ok":false,"protocol":1,"error":"need id"}"#)
    XCTAssertFalse(r.ok)
    XCTAssertEqual(r.error, "need id")
  }

  /// `unavailable` greys a menu item; a plain error tells the user something went
  /// wrong. Conflating them is what the daemon's two shapes exist to prevent.
  func testUnavailableIsDistinctFromAPlainError() {
    let unavailable = TrayReply.decode(#"{"ok":false,"protocol":1,"error":"tasks is not available on this daemon","unavailable":true}"#)
    XCTAssertEqual(unavailable.unavailable, true)
    let unknown = TrayReply.decode(#"{"ok":false,"protocol":1,"error":"unknown cmd: frobnicate","commands":["ping"]}"#)
    XCTAssertNil(unknown.unavailable)
    XCTAssertEqual(unknown.commands, ["ping"])
  }

  func testGarbageDecodesToAReadableFailure() {
    for bad in ["", "not json", "{", "[1,2,3]", "null"] {
      let r = TrayReply.decode(bad)
      XCTAssertFalse(r.ok, "\(bad.debugDescription) must not decode as a success")
      XCTAssertNotNil(r.error)
      XCTAssertFalse(r.error!.isEmpty)
    }
  }

  /// A decode error's own description is several lines of coding-path context.
  /// A menu item gets one short phrase naming the field.
  func testDecodeErrorNamesTheField() {
    let r = TrayReply.decode(#"{"protocol":1}"#)  // no `ok`
    XCTAssertFalse(r.ok)
    XCTAssertTrue(r.error!.contains("ok"), "expected the missing field named, got: \(r.error!)")
    XCTAssertFalse(r.error!.contains("\n"), "a menu item is one line")
  }

  func testLocalFailureReportsNoProtocolVersion() {
    let r = TrayReply.failure("socket vanished")
    XCTAssertNil(r.protocolVersion, "nothing was on the wire, so there is no version to report")
    XCTAssertFalse(r.ok)
  }

  // ── compatibility ──────────────────────────────────────────────────────────

  func testMatchingProtocolIsUsable() {
    XCTAssertEqual(trayCompatibility(TrayReply(ok: true, protocolVersion: 1), helper: 1), .ok)
    XCTAssertTrue(TrayCompatibility.ok.isUsable)
    XCTAssertNil(TrayCompatibility.ok.advice)
  }

  /// The two directions need DIFFERENT advice, because they need the user to
  /// update different software.
  func testOlderDaemonAndOlderHelperGiveDifferentAdvice() {
    let daemonOld = trayCompatibility(TrayReply(ok: true, protocolVersion: 1), helper: 2)
    XCTAssertEqual(daemonOld, .daemonOlder(daemon: 1, helper: 2))
    XCTAssertTrue(daemonOld.advice!.contains("tiny-tech"))

    let helperOld = trayCompatibility(TrayReply(ok: true, protocolVersion: 3), helper: 2)
    XCTAssertEqual(helperOld, .helperOlder(daemon: 3, helper: 2))
    XCTAssertTrue(helperOld.advice!.contains("tiny-menubar"))

    XCTAssertNotEqual(daemonOld.advice, helperOld.advice)
    XCTAssertFalse(daemonOld.isUsable)
    XCTAssertFalse(helperOld.isUsable)
  }

  /// A reply with no `protocol` at all isn't a tray socket. Don't guess at its
  /// shape — that's how a helper renders a menu out of someone else's IPC.
  func testMissingProtocolIsUnversioned() {
    XCTAssertEqual(trayCompatibility(TrayReply(ok: true, protocolVersion: nil)), .unversioned)
    XCTAssertTrue(TrayCompatibility.unversioned.advice!.contains("TINY_TRAY_SOCK"))
  }

  /// The constant this helper was built against must match the daemon's
  /// TRAY_PROTOCOL. A cross-language test pins the real file; this pins the value
  /// the rest of the Swift code compares against.
  func testHelperProtocolVersion() {
    XCTAssertEqual(trayProtocol, 1)
  }

  func testCommandListMatchesTheDaemonsOrder() {
    XCTAssertEqual(
      TrayCommand.allCases.map(\.rawValue),
      ["ping", "status", "tasks", "result", "ask", "cancel", "logs", "reload", "share"]
    )
  }

  // ── the event vocabulary ────────────────────────────────────────────────────

  /// The bug this exists for: a scheduled job that FAILED drew
  /// `clock.badge.checkmark` — a CHECKMARK. The daemon collapsed `job_result`
  /// and `job_error` into one `"job"` type and this switch styled it as a job
  /// that ran. The menu bar has four lines and no scrollback, so a wrong glyph
  /// is not decoration, it is the entire message.
  func testAFailedJobIsNeverStyledAsAFinishedOne() {
    XCTAssertNotEqual(card("job_error").glyph, card("job").glyph)
    XCTAssertNotEqual(eventSymbol("job_error"), eventSymbol("job"))
    XCTAssertFalse(eventSymbol("job_error").contains("checkmark"))
  }

  /// Good money news must never inherit the reconciliation siren, and the siren
  /// must never soften into a dollar sign.
  func testTheAlarmAndMoneyAreDifferentNews() {
    XCTAssertEqual(card("alarm").glyph, "🚨")
    XCTAssertNotEqual(card("money").glyph, card("alarm").glyph)
    XCTAssertNotEqual(eventSymbol("money"), eventSymbol("alarm"))
  }

  /// Every type the daemon can send has its own styling — none may fall through
  /// to the default bullet, which is what "the tray does not understand this"
  /// looks like.
  ///
  /// The roster is READ FROM `src/tray.ts`, not typed here. A hand-copied list is
  /// the same defect class as the map it guards, and this test proved it: it was
  /// written with a literal array, and one cycle later `job_missed` was added to
  /// the daemon and to `eventSymbol` — and this test passed while
  /// `TrayEventCard.glyph` had no case for it at all.
  func testEveryTrayEventTypeIsStyledAndDistinct() throws {
    let types = try trayEventTypesFromDaemonSource()
    // The parse has to be load-bearing: an empty roster would pass everything.
    XCTAssertGreaterThanOrEqual(types.count, 10, "parsed too few types: \(types)")
    let glyphs = types.map { card($0).glyph }
    let symbols = types.map { eventSymbol($0) }
    XCTAssertFalse(glyphs.contains(card("something the worker added last week").glyph))
    XCTAssertFalse(symbols.contains(eventSymbol("something the worker added last week")))
    XCTAssertEqual(Set(glyphs).count, types.count, "two types share a glyph: \(glyphs)")
    XCTAssertEqual(Set(symbols).count, types.count, "two types share a symbol: \(symbols)")
  }

  /// An unknown type still renders — a new worker kind must degrade to a bullet,
  /// never to an empty row.
  func testAnUnknownTypeStillDrawsSomething() {
    XCTAssertFalse(card("pay_teleported").glyph.isEmpty)
    XCTAssertFalse(eventSymbol(nil).isEmpty)
  }

  private func card(_ type: String?) -> TrayEventCard {
    TrayEventCard(type: type, summary: "x")
  }

  /// `TRAY_EVENT_TYPES` as the daemon declares it. `#filePath` is this file's own
  /// location at compile time, so the source tree is reachable without a bundle
  /// resource or a working-directory assumption.
  private func trayEventTypesFromDaemonSource() throws -> [String] {
    let root = URL(fileURLWithPath: #filePath)      // …/menubar/Tests/TinyMenuKitTests/this.swift
      .deletingLastPathComponent()                  // TinyMenuKitTests
      .deletingLastPathComponent()                  // Tests
      .deletingLastPathComponent()                  // menubar
      .deletingLastPathComponent()                  // repo root
    let src = try String(contentsOf: root.appendingPathComponent("src/tray.ts"), encoding: .utf8)
    guard let decl = src.range(of: "TRAY_EVENT_TYPES = ["),
          let end = src.range(of: "]", range: decl.upperBound..<src.endIndex)
    else { throw XCTSkip("could not find TRAY_EVENT_TYPES in src/tray.ts") }
    return src[decl.upperBound..<end.lowerBound]
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \n\t'\"")) }
      .filter { !$0.isEmpty && !$0.hasPrefix("//") }
  }
}

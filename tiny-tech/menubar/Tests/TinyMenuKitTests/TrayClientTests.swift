/// The socket half, against REAL Unix sockets in a real temp dir.
///
/// Mocking is not an option for most of this: a stale inode, a path the kernel
/// truncates, a peer that dies mid-reply and the SIGPIPE that follows are
/// properties of the OS, and a fake would only assert my beliefs about them.
import XCTest
@testable import TinyMenuKit

final class TrayClientTests: XCTestCase {
  private var dir: URL!

  override func setUpWithError() throws {
    // Short base path on purpose: sun_path is 104 bytes, and the system temp dir
    // under CI can be long enough that a nested name would trip the very limit
    // some of these tests are checking deliberately.
    dir = URL(fileURLWithPath: "/tmp").appendingPathComponent("tinymenu-\(getpid())-\(UInt32.random(in: 0..<0xFFFF))")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  private func path(_ name: String = "tray.sock") -> String {
    dir.appendingPathComponent(name).path
  }

  // ── path resolution ────────────────────────────────────────────────────────

  /// The same three-step resolution as the daemon's `traySocketPath()`. Two
  /// clients disagreeing about where the socket is means the menu reports a
  /// running daemon as absent.
  func testSocketPathResolutionMatchesTheDaemon() {
    XCTAssertEqual(defaultTraySocketPath(environment: ["TINY_TRAY_SOCK": "/tmp/explicit.sock"]), "/tmp/explicit.sock")
    XCTAssertEqual(defaultTraySocketPath(environment: ["TINY_HOME": "/tmp/home"]), "/tmp/home/tray.sock")
    XCTAssertTrue(defaultTraySocketPath(environment: [:]).hasSuffix("/.tiny/tray.sock"))
    // An explicit-but-empty var is not a choice.
    XCTAssertTrue(defaultTraySocketPath(environment: ["TINY_TRAY_SOCK": ""]).hasSuffix("/.tiny/tray.sock"))
  }

  /// TINY_TRAY_SOCK wins over TINY_HOME — the daemon reads them in that order.
  func testExplicitSocketBeatsTinyHome() {
    XCTAssertEqual(
      defaultTraySocketPath(environment: ["TINY_TRAY_SOCK": "/tmp/a.sock", "TINY_HOME": "/tmp/home"]),
      "/tmp/a.sock"
    )
  }

  /// The kernel TRUNCATES an over-long sun_path rather than failing, so a client
  /// that didn't check would connect to a different, shorter path and report
  /// "not running" about a daemon that is running.
  func testOverlongPathIsRefusedWithAnActionableMessage() {
    XCTAssertEqual(traySocketPathMax, 103, "must match SOCKET_PATH_MAX in src/tray.ts")
    let long = "/tmp/" + String(repeating: "x", count: 120) + ".sock"
    let err = traySocketPathError(long)
    XCTAssertNotNil(err)
    XCTAssertTrue(err!.contains("TINY_TRAY_SOCK"), "the message must name the way out: \(err!)")
    XCTAssertNil(traySocketPathError("/tmp/fine.sock"))
    XCTAssertNotNil(traySocketPathError(""))
  }

  /// Exactly at the limit is legal; one byte over is not.
  func testPathLimitBoundary() {
    let atLimit = "/tmp/" + String(repeating: "a", count: traySocketPathMax - 5)
    XCTAssertEqual(atLimit.utf8.count, traySocketPathMax)
    XCTAssertNil(traySocketPathError(atLimit))
    XCTAssertNotNil(traySocketPathError(atLimit + "b"))
  }

  /// Byte length, not character count — a path with non-ASCII characters is
  /// longer on the wire than it looks.
  func testPathLimitCountsBytesNotCharacters() {
    let emoji = "/tmp/" + String(repeating: "🙂", count: 30)  // 4 bytes each
    XCTAssertLessThan(emoji.count, traySocketPathMax)
    XCTAssertNotNil(traySocketPathError(emoji), "120 bytes must be refused even though it is 35 characters")
  }

  func testClientRefusesAnOverlongPathWithoutTouchingTheFilesystem() {
    let long = "/tmp/" + String(repeating: "y", count: 120)
    let r = TrayClient(config: TrayClientConfig(path: long)).send(["cmd": "ping"])
    XCTAssertFalse(r.ok)
    XCTAssertTrue(r.error!.contains("over the"))
  }

  // ── real round trips ───────────────────────────────────────────────────────

  func testRoundTripAgainstARealSocket() throws {
    let server = try EchoSocketServer(path: path()) { line in
      let cmd = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
      XCTAssertEqual(cmd?["cmd"] as? String, "status")
      return #"{"ok":true,"protocol":1,"status":{"peers":4,"relay":true}}"#
    }
    defer { server.stop() }

    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "status"])
    XCTAssertTrue(r.ok, r.error ?? "")
    XCTAssertEqual(r.status?.peerCount, 4)
  }

  /// The daemon writes one line per reply and JSON-escapes every newline inside
  /// strings — so a 20 KB task result full of them is still ONE frame.
  func testAReplyContainingNewlinesIsStillOneFrame() throws {
    let body = "line one\nline two\nline three"
    let encoded = String(data: try JSONSerialization.data(withJSONObject: ["ok": true, "protocol": 1, "state": "done", "result": body]), encoding: .utf8)!
    XCTAssertFalse(encoded.contains("\n"), "JSON.stringify escapes newlines — that is what makes framing work")

    let server = try EchoSocketServer(path: path()) { _ in encoded }
    defer { server.stop() }

    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "result", "id": "t1"])
    XCTAssertEqual(r.result, body, "the newlines must survive decoding intact")
  }

  /// Replies arrive in as many chunks as the kernel feels like — the client must
  /// reassemble rather than assuming one read is one reply.
  func testReplySplitAcrossManyWritesIsReassembled() throws {
    let server = try EchoSocketServer(path: path(), chunkBytes: 7) { _ in
      #"{"ok":true,"protocol":1,"message":"assembled from small pieces"}"#
    }
    defer { server.stop() }

    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "reload"])
    XCTAssertEqual(r.message, "assembled from small pieces")
  }

  /// A large reply (the daemon clamps text at 20k, but `logs 500` can approach
  /// it) must not be cut by the CLIENT.
  func testLargeReplySurvives() throws {
    let big = String(repeating: "x", count: 20_000)
    let encoded = String(data: try JSONSerialization.data(withJSONObject: ["ok": true, "protocol": 1, "text": big]), encoding: .utf8)!
    let server = try EchoSocketServer(path: path(), chunkBytes: 4096) { _ in encoded }
    defer { server.stop() }

    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "logs", "lines": 500])
    XCTAssertEqual(r.text?.count, 20_000)
  }

  // ── failure modes ──────────────────────────────────────────────────────────

  func testMissingSocketNamesThePathAndTheFix() {
    let r = TrayClient(config: TrayClientConfig(path: path("nope.sock"))).send(["cmd": "ping"])
    XCTAssertFalse(r.ok)
    XCTAssertTrue(r.error!.contains("nope.sock"))
    XCTAssertTrue(r.error!.contains("daemon status"), "tell the user how to check: \(r.error!)")
  }

  /// A crash leaves the inode behind. ECONNREFUSED on a socket that EXISTS means
  /// the daemon died — saying "connection refused" would read as a wrong path.
  func testStaleSocketIsReportedAsADeadDaemonNotAWrongPath() throws {
    let server = try EchoSocketServer(path: path()) { _ in #"{"ok":true,"protocol":1}"# }
    server.stopButLeaveTheInode()
    XCTAssertTrue(FileManager.default.fileExists(atPath: path()), "the inode must still be there for this test to mean anything")

    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "ping"])
    XCTAssertFalse(r.ok)
    XCTAssertTrue(r.error!.contains("stale"), r.error!)
    XCTAssertTrue(r.error!.contains("not running"), r.error!)
  }

  /// A daemon that accepts and then says nothing must not hang the menu forever.
  func testSilentDaemonTimesOutWithASentence() throws {
    let server = try EchoSocketServer(path: path(), silent: true)
    defer { server.stop() }

    let started = Date()
    let r = TrayClient(config: TrayClientConfig(path: path(), timeout: 0.35)).send(["cmd": "status"])
    let elapsed = Date().timeIntervalSince(started)
    XCTAssertFalse(r.ok)
    XCTAssertTrue(r.error!.contains("did not answer"), r.error!)
    XCTAssertLessThan(elapsed, 3.0, "the read deadline must actually bound the call")
  }

  /// Writing to a socket whose peer just died raises SIGPIPE, which by default
  /// KILLS the process. Node ignores it for you; Swift does not. If this test
  /// crashes the runner rather than failing, the SO_NOSIGPIPE/SIG_IGN pair is gone.
  func testPeerDyingMidRequestDoesNotKillTheProcess() throws {
    let server = try EchoSocketServer(path: path(), closeImmediately: true)
    defer { server.stop() }

    let r = TrayClient(config: TrayClientConfig(path: path(), timeout: 0.5)).send(["cmd": "status"])
    XCTAssertFalse(r.ok, "a peer that hangs up has no reply to give")
    XCTAssertNotNil(r.error)
  }

  func testGarbageFromTheSocketBecomesAReadableFailure() throws {
    let server = try EchoSocketServer(path: path()) { _ in "this is not json at all" }
    defer { server.stop() }

    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "status"])
    XCTAssertFalse(r.ok)
    XCTAssertTrue(r.error!.contains("unreadable") || r.error!.contains("not JSON"), r.error!)
  }

  /// Someone else's IPC socket answering our probe must not be rendered as a
  /// menu — that is what the protocol field is for.
  ///
  /// Note it is `.incompatible`, not `.unreachable`: something IS listening, and
  /// telling the user "no daemon" when a process answered would send them looking
  /// for a daemon to start instead of at the path they pointed this at. The
  /// `.unversioned` advice names TINY_TRAY_SOCK for exactly that reason.
  func testAForeignSocketIsReportedAsNotATray() throws {
    let server = try EchoSocketServer(path: path()) { _ in #"{"ok":true,"hello":"i am some other daemon"}"# }
    defer { server.stop() }

    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "ping"])
    XCTAssertEqual(trayCompatibility(r), .unversioned)
    guard case .incompatible(let why) = daemonState(from: r) else {
      return XCTFail("a foreign socket is not a running daemon: \(daemonState(from: r))")
    }
    XCTAssertEqual(why, .unversioned)
    XCTAssertTrue(why.advice!.contains("TINY_TRAY_SOCK"))
  }

  // ── request encoding ───────────────────────────────────────────────────────

  /// A newline in the request would be read as two commands by the daemon.
  /// JSONSerialization escapes it, so this asserts the guarantee rather than a fixup.
  func testRequestsAreAlwaysASingleLine() {
    let encoded = TrayClient.encode(["cmd": "ask", "prompt": "line one\nline two"])
    XCTAssertNotNil(encoded)
    XCTAssertFalse(encoded!.contains("\n"))
    XCTAssertTrue(encoded!.contains("\\n"))
  }

  func testUnencodableCommandIsRefusedLocally() {
    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "ask", "prompt": Double.nan])
    XCTAssertFalse(r.ok, "NaN is not representable in JSON — refuse before opening a socket")
  }

  func testUnicodePromptSurvivesEncoding() throws {
    let server = try EchoSocketServer(path: path()) { line in
      let cmd = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
      XCTAssertEqual(cmd?["prompt"] as? String, "özet çıkar 🙂")
      return #"{"ok":true,"protocol":1,"id":"t_1"}"#
    }
    defer { server.stop() }

    let r = TrayClient(config: TrayClientConfig(path: path())).send(["cmd": "ask", "prompt": "özet çıkar 🙂"])
    XCTAssertEqual(r.id, "t_1")
  }
}

// ── a minimal Unix-socket server, for tests only ─────────────────────────────

/// Deliberately not built on the daemon: these tests must run with no Node, no
/// build step and no agent. It answers one line per connection from a closure.
final class EchoSocketServer {
  private let fd: Int32
  private let thread: Thread
  private var running = true
  private let socketPath: String

  init(
    path: String,
    chunkBytes: Int = 0,
    silent: Bool = false,
    closeImmediately: Bool = false,
    reply: (@Sendable (String) -> String)? = nil
  ) throws {
    socketPath = path
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw TestSocketError.failed("socket()") }
    var nosig: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosig, socklen_t(MemoryLayout<Int32>.size))

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count <= 103 else { throw TestSocketError.failed("test path too long") }
    withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

    unlink(path)
    // A LOCAL copy: referencing `self.fd` inside the closure would capture self
    // before `thread` is initialized, which Swift rejects.
    let boundFd = fd
    let bound = withUnsafePointer(to: &addr) { ptr in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(boundFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0 else { throw TestSocketError.failed("bind(): \(String(cString: strerror(errno)))") }
    guard listen(boundFd, 4) == 0 else { throw TestSocketError.failed("listen()") }

    let serverFd = fd
    thread = Thread {
      while true {
        let client = accept(serverFd, nil, nil)
        if client < 0 { break }
        var nosig: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &nosig, socklen_t(MemoryLayout<Int32>.size))
        if closeImmediately { close(client); continue }

        var request = ""
        var buf = [UInt8](repeating: 0, count: 4096)
        while !request.contains("\n") {
          let n = read(client, &buf, buf.count)
          if n <= 0 { break }
          request += String(decoding: buf[0..<n], as: UTF8.self)
        }
        if silent {
          // Hold the connection open and say nothing — the client's deadline is
          // the only thing that can end this.
          Thread.sleep(forTimeInterval: 2.0)
          close(client)
          continue
        }
        let line = request.split(separator: "\n").first.map(String.init) ?? ""
        let out = Array(((reply?(line) ?? #"{"ok":true,"protocol":1}"#) + "\n").utf8)
        if chunkBytes > 0 {
          var i = 0
          while i < out.count {
            let end = min(i + chunkBytes, out.count)
            _ = out[i..<end].withUnsafeBytes { write(client, $0.baseAddress!, end - i) }
            i = end
            usleep(1000)
          }
        } else {
          _ = out.withUnsafeBytes { write(client, $0.baseAddress!, out.count) }
        }
        close(client)
      }
    }
    thread.start()
    // Give the accept loop a moment to be listening before a client connects.
    usleep(20_000)
  }

  func stop() {
    guard running else { return }
    running = false
    close(fd)
    unlink(socketPath)
  }

  /// Simulate a crash: the listener is gone, the inode is not.
  func stopButLeaveTheInode() {
    guard running else { return }
    running = false
    close(fd)
    usleep(20_000)
  }
}

enum TestSocketError: Error { case failed(String) }

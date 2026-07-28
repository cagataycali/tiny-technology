/// The Unix-socket client — POSIX, not Network.framework.
///
/// `NWConnection` has no `AF_UNIX` path type until macOS 14 and wants a run loop
/// to deliver its callbacks; this needs to work from a background queue on
/// macOS 13 and to be testable synchronously against a socket a test creates
/// itself. `connect(2)` over 40 lines is the smaller thing.
///
/// Three hazards this file exists to handle:
///
///   * **SIGPIPE kills the process by default.** Writing to a socket whose peer
///     just died raises it, and a `write()` on a daemon that exited mid-request
///     is an ordinary event here. Node ignores SIGPIPE for you; Swift does not.
///     So `SO_NOSIGPIPE` on the socket AND a process-level `SIG_IGN`, because the
///     first only covers the descriptors this file owns.
///   * **`sun_path` is 104 bytes and the kernel truncates silently.** The daemon
///     refuses to bind a longer path (SOCKET_PATH_MAX = 103); a client that
///     didn't check would connect to a *different, shorter* path and report
///     "daemon not running" about a daemon that is running.
///   * **A read with no deadline hangs the menu.** `SO_RCVTIMEO` bounds it, and
///     the timeout is reported as a sentence rather than as silence.
import Foundation

public struct TrayClientConfig: Sendable {
  public var path: String
  /// The daemon's own client uses 2s (`TRAY_TIMEOUT_MS`). Matched deliberately:
  /// two clients with different patience report different truths about the same
  /// daemon.
  public var timeout: TimeInterval
  public init(path: String, timeout: TimeInterval = 2.0) {
    self.path = path
    self.timeout = timeout
  }
}

/// `sun_path` capacity, minus the NUL. Mirrors `SOCKET_PATH_MAX` in src/tray.ts.
public let traySocketPathMax = 103

/// Where the daemon put its socket: `$TINY_TRAY_SOCK`, else `$TINY_HOME/tray.sock`,
/// else `~/.tiny/tray.sock` — the same three-step resolution as `traySocketPath()`.
public func defaultTraySocketPath(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
  if let explicit = environment["TINY_TRAY_SOCK"], !explicit.isEmpty { return explicit }
  if let home = environment["TINY_HOME"], !home.isEmpty {
    return (home as NSString).appendingPathComponent("tray.sock")
  }
  return (NSHomeDirectory() as NSString).appendingPathComponent(".tiny/tray.sock")
}

/// Refuse a path the kernel would silently truncate — see the file header.
public func traySocketPathError(_ path: String) -> String? {
  if path.isEmpty { return "empty socket path" }
  let bytes = path.utf8.count
  if bytes > traySocketPathMax {
    return "socket path is \(bytes) bytes, over the \(traySocketPathMax)-byte OS limit — set TINY_TRAY_SOCK to something shorter"
  }
  return nil
}

public protocol TrayTransport: Sendable {
  func send(_ command: [String: Any]) -> TrayReply
}

public struct TrayClient: TrayTransport {
  public let config: TrayClientConfig

  public init(config: TrayClientConfig) {
    self.config = config
    TrayClient.ignoreSigpipeOnce()
  }

  /// Ignoring SIGPIPE is process-wide state, so do it exactly once and never
  /// from an initializer that could run on several threads at the same time.
  private static let sigpipeIgnored: Bool = {
    signal(SIGPIPE, SIG_IGN)
    return true
  }()
  private static func ignoreSigpipeOnce() { _ = sigpipeIgnored }

  /// One command, one reply. Never throws: every caller is a menu that needs a
  /// sentence, so a failure is a `TrayReply` with `ok: false`.
  public func send(_ command: [String: Any]) -> TrayReply {
    if let pathErr = traySocketPathError(config.path) { return .failure(pathErr) }
    guard let line = Self.encode(command) else { return .failure("could not encode that command") }

    guard FileManager.default.fileExists(atPath: config.path) else {
      return .failure("no tray socket at \(config.path) — is the daemon running? (tiny-tech daemon status)")
    }

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { return .failure("socket(): \(errnoText())") }
    defer { close(fd) }

    var nosigpipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosigpipe, socklen_t(MemoryLayout<Int32>.size))
    var tv = timeval(
      tv_sec: Int(config.timeout),
      tv_usec: Int32((config.timeout - Double(Int(config.timeout))) * 1_000_000)
    )
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(config.path.utf8)
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      raw.copyBytes(from: pathBytes)  // length already checked against sun_path
    }
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

    let connected = withUnsafePointer(to: &addr) { ptr -> Int32 in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if connected != 0 {
      // ECONNREFUSED on a socket that EXISTS is the signature of a crashed
      // daemon: the inode outlived the process that was listening on it. Say
      // that, rather than "connection refused", which reads as a wrong path.
      if errno == ECONNREFUSED {
        return .failure("the tray socket at \(config.path) is stale — the daemon is not running (tiny-tech daemon status)")
      }
      return .failure("connect(): \(errnoText())")
    }

    let payload = Array((line + "\n").utf8)
    var written = 0
    while written < payload.count {
      let n = payload.withUnsafeBytes { buf in
        Darwin.write(fd, buf.baseAddress!.advanced(by: written), payload.count - written)
      }
      // A short write is normal on a stream socket; only <= 0 is a failure. EINTR
      // is a signal arriving mid-syscall, not an error — retry it.
      if n > 0 { written += n; continue }
      if errno == EINTR { continue }
      return .failure("write(): \(errnoText())")
    }

    return readLine(fd: fd)
  }

  /// Read until the first newline. The daemon writes exactly one line per reply
  /// and `JSON.stringify` escapes every newline inside strings, so a 20 KB task
  /// result full of them can never be read as two replies.
  private func readLine(fd: Int32) -> TrayReply {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
      let n = Darwin.read(fd, &chunk, chunk.count)
      if n > 0 {
        buffer.append(contentsOf: chunk[0..<n])
        if let nl = buffer.firstIndex(of: 0x0A) {
          let line = String(decoding: buffer[buffer.startIndex..<nl])
          return TrayReply.decode(line)
        }
        // Cap the accumulator: past the daemon's own line limit the frame
        // boundary is unfindable, so there is nothing to wait for.
        if buffer.count > TrayClient.replyMax {
          return .failure("tray reply over \(TrayClient.replyMax) bytes — dropping it")
        }
        continue
      }
      if n == 0 {
        // EOF before a newline: the daemon closed mid-reply.
        return .failure("tray socket closed without a reply")
      }
      if errno == EINTR { continue }
      if errno == EAGAIN || errno == EWOULDBLOCK {
        return .failure("the daemon did not answer within \(Int(config.timeout * 1000))ms")
      }
      return .failure("read(): \(errnoText())")
    }
  }

  /// Generous next to the daemon's 20k text clamp, so a legitimately large
  /// `logs 500` reply is never cut off by the CLIENT.
  static let replyMax = 256 * 1024

  static func encode(_ command: [String: Any]) -> String? {
    guard JSONSerialization.isValidJSONObject(command),
          let data = try? JSONSerialization.data(withJSONObject: command, options: [.sortedKeys]),
          let s = String(data: data, encoding: .utf8)
    else { return nil }
    // A newline inside the request would be read as two commands by the daemon;
    // JSONSerialization escapes them, so this is an assertion, not a fixup.
    return s.contains("\n") ? nil : s
  }

  private func errnoText() -> String { String(cString: strerror(errno)) }
}

/// Invalid UTF-8 in a reply must not become `nil`: the reply is still a reply,
/// and a lossy conversion loses one character where the alternative loses the
/// whole menu.
func String(decoding bytes: Data) -> String {
  Swift.String(data: bytes, encoding: .utf8) ?? Swift.String(decoding: bytes, as: UTF8.self)
}

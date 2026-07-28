// Drives the real TrayController against the real Node daemon. Not part of the
// package — compiled ad hoc by scripts/xlang-check.sh.
// Compiled as ONE module together with Sources/TinyMenuKit/*.swift, so there is
// no import: SwiftPM links the library into its executable rather than leaving a
// .a behind to link against.
import Foundation

let path = CommandLine.arguments.dropFirst().first ?? defaultTraySocketPath()
let c = TrayController(transport: TrayClient(config: TrayClientConfig(path: path)))

func check(_ label: String, _ ok: Bool, _ detail: String = "") {
  print("\(ok ? "ok  " : "FAIL") \(label)\(detail.isEmpty ? "" : "  — \(detail)")")
  if !ok { exit(1) }
}

let compat = c.handshake()
check("handshake is compatible", compat == .ok, "\(compat)")
check("learned the command list", c.state.commands.count == 9, "\(c.state.commands.sorted())")

let state = c.poll()
guard case .running(let s) = state.daemon else {
  print("FAIL poll did not see a running daemon: \(state.daemon)"); exit(1)
}
check("device name decoded", s.device?.name == "cagatay's mac", s.device?.name ?? "nil")
check("peers", s.peerCount == 3, "\(s.peerCount)")
check("tools", s.loadedTools == 4 && s.failedTools == 1)
check("tasks counts", s.runningTasks == 1 && s.finishedTasks == 2)
check("senses", s.senses == ["computer", "browse", "desktop"])
check("version", s.version == "0.8.0")
check("logPath", s.logPath == "/tmp/daemon.log")
check("tasks fetched because counts were nonzero", state.tasks.count == 2, "\(state.tasks.count)")
check("running task sorts first", state.tasks.first?.id == "t_1", state.tasks.first?.id ?? "nil")

// The title a user actually sees.
check("title badges the running task", state.title.display.contains("1"), state.title.display)

// result: the `state`-not-`status` rename, across the language boundary.
guard case .success(let r) = c.taskResult("t_2") else { print("FAIL result"); exit(1) }
check("task state decoded from `state`", r.state == "done", r.state)
check("embedded newlines survived framing", r.text == "three commits,\nall on main", r.text.debugDescription)

guard case .failure(let missing) = c.taskResult("t_9") else { print("FAIL missing task"); exit(1) }
check("missing task is an error", missing.message.contains("t_9"), missing.message)

// ask, both ways.
guard case .success(let id) = c.ask("  what happened overnight?  ") else { print("FAIL ask"); exit(1) }
check("ask returns the id", id == "t_new", id)
guard case .failure(let refusal) = c.ask("no") else { print("FAIL refusal"); exit(1) }
check("the daemon's own refusal came through", refusal.message.contains("already running"), refusal.message)

check("cancel wording is verbatim", c.cancel("t_1").contains("cannot be aborted"), c.cancel("t_1"))
check("reload message", c.reloadTools() == "3 local tools loaded")

// A command the daemon does not know must not look like a capability.
check("all 8 protocol commands are known to the daemon",
      Set(TrayCommand.allCases.map(\.rawValue)) == c.state.commands,
      "swift: \(TrayCommand.allCases.map(\.rawValue).sorted())  daemon: \(c.state.commands.sorted())")

print("\nall cross-language checks passed")

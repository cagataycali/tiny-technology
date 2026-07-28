/// tiny-menubar — the daemon, visible.
///
/// The thin half on purpose: every decision about what the user READS lives in
/// TinyMenuKit (testable with no window server, no daemon), and this file is the
/// NSStatusItem that draws it. If you're looking for why a menu says something,
/// look there.
///
/// The file is split along the one boundary that matters here, and it is split in
/// the TYPE SYSTEM rather than in a comment, because Swift 6 checks it:
///
///   * `TrayWorker` owns the controller and the socket, and lives on a serial
///     background queue. It must not touch AppKit — a `connect()` to a wedged
///     daemon blocks for the full timeout, and doing that on main would beachball
///     the entire menu bar, not just this icon. The queue being SERIAL is also
///     what preserves the protocol's one-command-one-reply ordering.
///   * `AppDelegate` is `@MainActor` and owns every pixel. It never speaks to a
///     socket; it asks the worker and gets answers back on main.
///
/// Runs as an accessory app — no Dock icon, no window — set in code so this works
/// as a plain SwiftPM binary rather than needing an app bundle and Info.plist.
import AppKit
import Carbon.HIToolbox
import TinyMenuKit

/// The daemon side of the app: a serial queue, a controller, and callbacks that
/// land on main. `@unchecked Sendable` is honest here — every mutable thing it
/// owns is touched only from `queue`, which is serial.
final class TrayWorker: @unchecked Sendable {
  private let controller: TrayController
  private let queue = DispatchQueue(label: "technology.tiny.menubar.poll")
  private var timer: DispatchSourceTimer?
  /// Read from main to answer menu clicks that need no round trip (the log path).
  /// Written on `queue`. A stale read costs one wrong menu item for one poll
  /// interval, which is why this doesn't need a lock — and why nothing that
  /// MATTERS is read this way.
  private(set) nonisolated(unsafe) var lastState = TrayViewState()

  /// Called on main with each new state.
  var onState: (@MainActor (TrayViewState) -> Void)?

  init(socketPath: String) {
    controller = TrayController(transport: TrayClient(config: TrayClientConfig(path: socketPath)))
  }

  /// Handshake once, then poll forever at whatever interval the controller's
  /// backoff decides.
  func start() {
    queue.async { [self] in
      controller.handshake()
      pollOnQueue()
    }
  }

  func refresh() {
    queue.async { [self] in pollOnQueue() }
  }

  func ask(_ prompt: String, then completion: @escaping @MainActor (Result<String, TrayFailure>) -> Void) {
    queue.async { [self] in
      let result = controller.ask(prompt)
      DispatchQueue.main.async { completion(result) }
      pollOnQueue()
    }
  }

  func taskResult(_ id: String, then completion: @escaping @MainActor (Result<(state: String, text: String), TrayFailure>) -> Void) {
    queue.async { [self] in
      let result = controller.taskResult(id)
      DispatchQueue.main.async { completion(result) }
    }
  }

  func cancel(_ id: String, then completion: @escaping @MainActor (String) -> Void) {
    queue.async { [self] in
      let message = controller.cancel(id)
      DispatchQueue.main.async { completion(message) }
      pollOnQueue()
    }
  }

  func share(path: String, note: String, then completion: @escaping @MainActor (Result<String, TrayFailure>) -> Void) {
    queue.async { [self] in
      let result = controller.share(path: path, note: note)
      DispatchQueue.main.async { completion(result) }
      pollOnQueue()
    }
  }

  func reloadTools(then completion: @escaping @MainActor (String) -> Void) {
    queue.async { [self] in
      let message = controller.reloadTools()
      DispatchQueue.main.async { completion(message) }
      pollOnQueue()
    }
  }

  // MARK: - queue-only

  private func pollOnQueue() {
    let state = controller.poll()
    lastState = state
    let handler = onState
    DispatchQueue.main.async { handler?(state) }
    scheduleOnQueue(after: controller.interval)
  }

  private func scheduleOnQueue(after seconds: TimeInterval) {
    timer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: queue)
    // A menu-bar poll isn't worth waking a sleeping CPU for on its own — leeway
    // lets the OS coalesce it with work that was happening anyway.
    t.schedule(deadline: .now() + seconds, leeway: .seconds(1))
    t.setEventHandler { [weak self] in self?.pollOnQueue() }
    t.resume()
    timer = t
  }
}

// ── the visible half ─────────────────────────────────────────────────────────

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private let worker: TrayWorker
  private let socketPath: String
  private var state = TrayViewState()

  // ── Ticker rotation ───────────────────────────────────────────────────────
  /// Index into the current normal-card array. Advances on each tick.
  private var tickerIndex = 0
  /// Timer that rotates the title. Nil when there are no cards to show.
  private var tickerTimer: Timer?

  init(socketPath: String) {
    self.socketPath = socketPath
    self.worker = TrayWorker(socketPath: socketPath)
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.title = MenuGlyph.offline
    statusItem.button?.toolTip = "tiny — connecting to the daemon"
    statusItem.menu = NSMenu()
    statusItem.menu?.delegate = self

    worker.onState = { [weak self] state in self?.render(state) }
    worker.start()
    registerHotkey()
  }

  // ── Global hotkey: ⌃⌥Space opens the Ask bar from anywhere ────────────────
  /// Carbon RegisterEventHotKey, not an NSEvent global monitor: the monitor
  /// needs Accessibility permission and cannot consume the keystroke, while a
  /// Carbon hotkey needs no permission at all and works from any app. The
  /// deprecation warnings are 20 years old and Apple ships no replacement for
  /// exactly this (a permissionless, consuming, global hotkey).
  private var hotKeyRef: EventHotKeyRef?

  private func registerHotkey() {
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
      guard let userData else { return noErr }
      let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
      DispatchQueue.main.async { delegate.perform(.ask) }
      return noErr
    }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), nil)

    let hotKeyID = EventHotKeyID(signature: OSType(0x74696E79) /* 'tiny' */, id: 1)
    RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey),
                        hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
  }

  private func render(_ state: TrayViewState) {
    self.state = state
    rebuildTickerTimer()
    applyCurrentTitle()
    // The menu is rebuilt when it OPENS (menuNeedsUpdate), so a poll while it is
    // open must not rebuild it — that would dismiss it under the user's cursor.
  }

  /// Build (or tear down) the rotation timer based on the current card set.
  private func rebuildTickerTimer() {
    tickerTimer?.invalidate()
    tickerTimer = nil
    guard case .running(let s) = state.daemon,
          let cards = s.ticker,
          cards.contains(where: { !$0.isUrgent }) else { return }

    // Use the first normal card's ttl as the initial interval;
    // a uniform 5s is fine — the exact per-card ttl can be a follow-up.
    tickerTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.tickerIndex += 1
      self.applyCurrentTitle()
    }
  }

  /// Write the current icon + ticker text (or just the icon) to the status button.
  /// The icon is an SF Symbol drawn as a TEMPLATE image, so the system tints it
  /// like every other menu-bar icon — correct in light, dark, and translucent
  /// menu bars, which a hardcoded text glyph never quite is.
  private func applyCurrentTitle() {
    let title = state.title
    guard let button = statusItem.button else { return }

    button.image = statusImage(named: menuBarSymbol(for: state.daemon))
    button.imagePosition = .imageLeading

    if case .running(let s) = state.daemon {
      // Urgent card takes over completely
      if let urgent = s.ticker?.first(where: { $0.isUrgent }) {
        button.title = " \(urgent.displayText)"
        button.toolTip = urgent.displayText
        return
      }

      // Working badge
      if s.runningTasks > 0 {
        button.title = " \(s.runningTasks)"
        button.toolTip = title.tooltip
        return
      }

      // Ticker rotation
      if let tickerText = tickerDisplayText(cards: s.ticker, tickIndex: tickerIndex) {
        button.title = " \(tickerText)"
        button.toolTip = title.tooltip
        return
      }
    }

    // Fallback: icon only
    button.title = ""
    button.toolTip = title.tooltip
  }

  private func statusImage(named symbol: String) -> NSImage? {
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "tiny")
    image?.isTemplate = true  // let the system tint it with the menu bar
    return image
  }

  // MARK: - actions

  private func perform(_ action: MenuRow.Action) {
    switch action {
    case .refresh:
      worker.refresh()

    case .quit:
      NSApp.terminate(nil)

    case .ask:
      guard let prompt = promptForText(
        title: "Ask tiny",
        message: "Runs as a background task on this daemon — the answer also reaches your chat."
      ) else { return }
      worker.ask(prompt) { [weak self] result in
        switch result {
        case .success(let id):
          self?.inform(title: "tiny is working on it", body: "task \(id)")
        case .failure(let why):
          self?.warn(title: "tiny could not take that", body: why.message)
        }
      }

    case .openTask(let id):
      worker.taskResult(id) { [weak self] result in
        switch result {
        case .success(let r):
          self?.showTask(id: id, state: r.state, text: r.text)
        case .failure(let why):
          self?.warn(title: "no result for \(id)", body: why.message)
        }
      }

    case .cancelTask(let id):
      worker.cancel(id) { [weak self] message in
        self?.inform(title: "task \(id)", body: message)
      }

    case .reloadTools:
      worker.reloadTools() { [weak self] message in
        self?.inform(title: "local tools", body: message)
      }

    case .shareScreenshot:
      captureAndShare()

    case .openEvents:
      // The feed's home. The daemon marks events read on its own poll cadence.
      NSWorkspace.shared.open(URL(string: "https://tiny.technology")!)

    case .openLogs:
      guard let path = state.daemon.status?.logPath else { return }
      NSWorkspace.shared.open(URL(fileURLWithPath: path))

    case .copyStatus:
      guard let s = state.daemon.status else { return }
      let pb = NSPasteboard.general
      pb.clearContents()
      pb.setString(statusClipboardText(s), forType: .string)
      inform(title: "copied", body: "the daemon's status is on your clipboard")
    }
  }

  // MARK: - screenshot → tiny

  /// `screencapture -i` (interactive: drag a region or press Space for a
  /// window), writing to a temp file the daemon can read — same user, same
  /// machine. Interactive mode needs NO Screen Recording permission prompt of
  /// our own: the system UI does the capture and the user aims it, which is
  /// also the consent story. Escape during selection produces an empty file
  /// and we treat that as "changed my mind", silently.
  private func captureAndShare() {
    let path = NSTemporaryDirectory() + "tiny-share-\(Int(Date().timeIntervalSince1970)).png"
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    proc.arguments = ["-i", path]
    proc.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async { self?.finishShare(path: path) }
    }
    do { try proc.run() } catch {
      warn(title: "screenshot failed", body: "could not run screencapture: \(error.localizedDescription)")
    }
  }

  private func finishShare(path: String) {
    guard FileManager.default.fileExists(atPath: path),
          let size = try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int,
          size > 0
    else { return }  // Escape pressed — not an error, not worth an alert

    guard let note = promptForText(
      title: "Send to tiny",
      message: "The screenshot rides along — say what you want done with it (or leave empty to just have tiny look).",
      placeholder: "what is this error?",
      button: "Send",
      allowEmpty: true
    ) else {
      try? FileManager.default.removeItem(atPath: path)
      return
    }

    worker.share(path: path, note: note) { [weak self] result in
      switch result {
      case .success(let message):
        self?.inform(title: "sent to tiny", body: message)
      case .failure(let why):
        self?.warn(title: "tiny could not take that", body: why.message)
      }
    }
  }

  // MARK: - UI

  /// NSAlert with an accessory field — the smallest thing that takes a sentence
  /// from a user without shipping a window controller.
  private func promptForText(
    title: String, message: String,
    placeholder: String = "what happened overnight?",
    button: String = "Ask",
    allowEmpty: Bool = false
  ) -> String? {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: button)
    alert.addButton(withTitle: "Cancel")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.placeholderString = placeholder
    alert.accessoryView = field
    // Without this the field isn't first responder and the user's first keystroke
    // goes nowhere.
    alert.window.initialFirstResponder = field
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty && !allowEmpty { return nil }
    return text
  }

  private func showTask(id: String, state taskState: String, text: String) {
    let alert = NSAlert()
    alert.messageText = "\(taskGlyph(taskState))  task \(id) — \(taskState)"
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 480, height: 240))
    let textView = NSTextView(frame: scroll.bounds)
    textView.string = text
    textView.isEditable = false
    textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    scroll.documentView = textView
    scroll.hasVerticalScroller = true
    alert.accessoryView = scroll
    alert.addButton(withTitle: "Done")
    alert.addButton(withTitle: "Copy")
    // Only offer to cancel something that is actually running.
    if taskState == "running" { alert.addButton(withTitle: "Cancel task") }
    NSApp.activate(ignoringOtherApps: true)
    switch alert.runModal() {
    case .alertSecondButtonReturn:
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    case .alertThirdButtonReturn:
      perform(.cancelTask(id))
    default:
      break
    }
  }

  /// Deliberately NOT UNUserNotificationCenter: it refuses to deliver from a
  /// process with no bundle identifier, which is exactly what `swift build`
  /// produces — so a "notification" would silently go nowhere, which is the
  /// worst possible outcome for a confirmation. The daemon already owns real
  /// notifications through `use_desktop`.
  private func inform(title: String, body: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = body
    a.alertStyle = .informational
    NSApp.activate(ignoringOtherApps: true)
    a.runModal()
  }

  private func warn(title: String, body: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = body
    a.alertStyle = .warning
    NSApp.activate(ignoringOtherApps: true)
    a.runModal()
  }
}

extension AppDelegate: NSMenuDelegate {
  /// Rebuilt from the model each time it opens, so the user reads the latest poll
  /// rather than whatever the menu happened to still hold.
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    for row in state.rows {
      if row.isSeparator {
        menu.addItem(.separator())
        continue
      }
      // Section headers get the system's real header style (macOS 14+),
      // which is smaller, bolder, and spaced the way users expect.
      if row.isHeader {
        if #available(macOS 14.0, *) {
          menu.addItem(.sectionHeader(title: row.label))
        } else {
          let h = NSMenuItem(title: row.label, action: nil, keyEquivalent: "")
          h.isEnabled = false
          h.attributedTitle = NSAttributedString(
            string: row.label,
            attributes: [
              .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold),
              .foregroundColor: NSColor.secondaryLabelColor,
            ]
          )
          menu.addItem(h)
        }
        continue
      }

      let item = NSMenuItem(title: row.label, action: nil, keyEquivalent: "")
      if let action = row.action, row.enabled {
        item.target = self
        item.action = #selector(menuItemClicked(_:))
        item.representedObject = ActionBox(action)
      } else {
        item.isEnabled = false
      }
      if let symbol = row.symbol {
        item.image = menuImage(symbol: symbol, tint: row.tint)
      }
      if row.isSecondary {
        item.attributedTitle = NSAttributedString(
          string: row.label,
          attributes: [
            .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
            .foregroundColor: NSColor.secondaryLabelColor,
          ]
        )
      }
      menu.addItem(item)
    }
    // The socket path, last and dimmest: it's the first thing to check when the
    // helper and the daemon disagree about whether anything is running.
    if state.daemon.status != nil {
      menu.addItem(.separator())
      let path = NSMenuItem(title: socketPath, action: nil, keyEquivalent: "")
      path.isEnabled = false
      path.attributedTitle = NSAttributedString(
        string: socketPath,
        attributes: [
          .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
          .foregroundColor: NSColor.tertiaryLabelColor,
        ]
      )
      menu.addItem(path)
    }
  }

  @objc private func menuItemClicked(_ sender: NSMenuItem) {
    guard let box = sender.representedObject as? ActionBox else { return }
    perform(box.action)
  }
}

/// SF Symbol → NSImage for a menu line. Hierarchical rendering keeps multi-layer
/// symbols (badges) legible at menu size; the tint is the model's judgement
/// (green done, red failed) mapped to system colors so it adapts to dark mode.
@MainActor
private func menuImage(symbol: String, tint: MenuRow.Tint) -> NSImage? {
  guard let base = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) else { return nil }
  let sized = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
  let color: NSColor? = {
    switch tint {
    case .none:   return nil
    case .accent: return .controlAccentColor
    case .good:   return .systemGreen
    case .warn:   return .systemOrange
    case .bad:    return .systemRed
    case .dim:    return .secondaryLabelColor
    }
  }()
  if let color {
    let config = sized.applying(.init(hierarchicalColor: color))
    return base.withSymbolConfiguration(config)
  }
  return base.withSymbolConfiguration(sized)
}

/// `representedObject` is `Any?`, and a class reference casts back reliably where
/// an enum in an existential does not.
private final class ActionBox {
  let action: MenuRow.Action
  init(_ action: MenuRow.Action) { self.action = action }
}

// ── entry point ──────────────────────────────────────────────────────────────

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.contains("--help") || arguments.contains("-h") {
  print("""
  tiny-menubar — the tiny-tech daemon in your menu bar

  usage: tiny-menubar [--socket <path>]

    --socket <path>   the daemon's control socket
                      (default $TINY_TRAY_SOCK, else $TINY_HOME/tray.sock,
                       else ~/.tiny/tray.sock)

  The daemon has to be running:  tiny-tech daemon install
  Same protocol as `tiny-tech tray <action>`, so everything this shows is also
  available from a terminal.
  """)
  exit(0)
}

let socketPath: String = {
  if let i = arguments.firstIndex(of: "--socket"), i + 1 < arguments.count { return arguments[i + 1] }
  return defaultTraySocketPath()
}()

// Refuse HERE rather than drawing an icon that can never work: the path is wrong
// before anything is on screen, so there is nothing to be graceful about.
if let pathError = traySocketPathError(socketPath) {
  FileHandle.standardError.write(Data("tiny-menubar: \(pathError)\n".utf8))
  exit(2)
}

let app = NSApplication.shared
// .accessory, not .regular: a Dock icon and an app-switcher entry for something
// with no window is noise.
app.setActivationPolicy(.accessory)
let delegate = AppDelegate(socketPath: socketPath)
app.delegate = delegate
app.run()

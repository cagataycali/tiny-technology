/**
 * Split — the iPad design (north-star pass: "advance the design").
 *
 * Regular width (iPad, landscape big-phones): NavigationSplitView with a
 * persistent sidebar — the Universe + every surface (Memory/Jobs/Devices/
 * Messages) one tap away, chat as the detail pane. The web equivalent is
 * the header drawer + sheets; on a 11" canvas those become resident.
 *
 * Compact width (iPhone portrait): untouched — ChatView as before.
 *
 * Sidebar → chat communication rides Router (a tiny MainActor mailbox):
 * ChatView consumes tiny switches / panel opens on its own turf, so the
 * monolithic ChatView needs only an .onReceive — no restructuring while
 * sibling agents share the file.
 */
import SwiftUI

// ── Router: sidebar → chat mailbox ─────────────────────────────────────────

@MainActor
final class Router: ObservableObject {
    static let shared = Router()
    /// Tiny slug the sidebar picked (ChatView consumes + clears)
    @Published var openTiny: String?
    /// Panel the sidebar picked (ChatView maps to its sheet flags)
    @Published var openPanel: Panel?
    /// Tiny currently on the chat surface (ChatView publishes on switch;
    /// the sidebar renders selection state from it)
    @Published var currentTiny: String = "tiny"

    enum Panel: String { case memory, jobs, toolbox, devices, messages, nearby, map, settings }
    private init() {}
}

// ── Adaptive root ──────────────────────────────────────────────────────────

struct AdaptiveRoot: View {
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        if hSize == .regular {
            SplitRoot()
        } else {
            ChatView()
        }
    }
}

private struct SplitRoot: View {
    @State private var visibility: NavigationSplitViewVisibility = .automatic

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
        } detail: {
            ChatView()
        }
        .navigationSplitViewStyle(.balanced)
    }
}

// ── Sidebar ────────────────────────────────────────────────────────────────

struct SidebarView: View {
    @EnvironmentObject var session: TinySession
    @ObservedObject private var router = Router.shared
    @State private var universe: [UniverseUser] = []
    @State private var state: LoadState = .loading

    var body: some View {
        List {
            Section("Surfaces") {
                sidebarRow("brain", "Memory", .memory, key: "1")
                sidebarRow("clock", "Scheduled jobs", .jobs, key: "2")
                // ⌘7 (appended last so the existing 3–6 chords keep their muscle memory)
                sidebarRow("wrench.and.screwdriver", "Toolbox", .toolbox, key: "7")
                sidebarRow("iphone.radiowaves.left.and.right", "Devices", .devices, key: "3")
                sidebarRow("bubble.left.and.bubble.right", "Messages", .messages, key: "4")
                sidebarRow("dot.radiowaves.left.and.right", "Nearby", .nearby, key: "5")
                // ⌘8 (appended after ⌘7 Toolbox — existing chords keep muscle memory)
                sidebarRow("map", "Map", .map, key: "8")
                sidebarRow("gearshape", "Settings", .settings, key: "6")
            }

            Section("🌌 Universe") {
                switch state {
                case .loading:
                    HStack { ProgressView().scaleEffect(0.7); Text("Loading…").font(.caption).foregroundStyle(.secondary) }
                case .failed(let e):
                    // Was a dead end — a grey "Couldn't load" with the only
                    // recovery being undiscoverable pull-to-refresh on the
                    // sidebar List. Give it the Retry the sibling panels
                    // (UniverseView/MemoryView/JobsView) all have.
                    VStack(alignment: .leading, spacing: 6) {
                        Text(e).font(.caption).foregroundStyle(.secondary)
                        Button("Retry") { Task { state = .loading; await load() } }
                            .font(.caption).buttonStyle(.bordered)
                    }
                case .loaded:
                    if universe.isEmpty {
                        Text("No tinys yet").font(.caption).foregroundStyle(.secondary)
                    }
                }
                ForEach(universe) { u in
                    DisclosureGroup {
                        ForEach(u.tinys, id: \.self) { t in
                            Button {
                                Router.shared.openTiny = t
                            } label: {
                                HStack {
                                    Label(t, systemImage: "leaf")
                                        .foregroundStyle(router.currentTiny == t ? Color.green : .primary)
                                    if router.currentTiny == t {
                                        Spacer()
                                        Image(systemName: "checkmark")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(.green)
                                    }
                                }
                            }
                            .hoverEffect(.highlight)
                        }
                    } label: {
                        HStack(spacing: 8) {
                            AsyncImage(url: URL(string: u.avatar)) { img in
                                img.resizable()
                            } placeholder: { Color.gray.opacity(0.3) }
                            .frame(width: 22, height: 22)
                            .clipShape(Circle())
                            Text("@\(u.login)")
                                .font(.subheadline)
                            Spacer()
                            Text("\(u.tinys.count)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("🌱 tiny")
        .task { await load() }
        .refreshable { await load() }
    }

    /// ⌘1–⌘6 (iPad hardware keyboard) jump straight to a surface —
    /// the sidebar rows double as the app's global panel chords.
    private func sidebarRow(_ icon: String, _ title: String, _ panel: Router.Panel, key: Character? = nil) -> some View {
        let button = Button {
            Router.shared.openPanel = panel
        } label: {
            Label(title, systemImage: icon)
                .foregroundStyle(.primary)
        }
        .hoverEffect(.highlight)
        return Group {
            if let key {
                button.keyboardShortcut(KeyEquivalent(key), modifiers: .command)
            } else {
                button
            }
        }
    }

    private func load() async {
        do {
            // Public endpoint — same one UniverseView + the web drawer fetch.
            var req = URLRequest(url: URL(string: "https://plugin.tiny.technology/community?limit=50")!)
            req.timeoutInterval = 20
            let (data, _) = try await URLSession.shared.data(for: req)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rawUsers = obj["users"] as? [[String: Any]] else {
                state = .failed("Couldn't load"); return
            }
            universe = rawUsers.compactMap { u in
                guard let login = u["login"] as? String else { return nil }
                let tinys = (u["tinys"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
                guard !tinys.isEmpty else { return nil }
                return UniverseUser(login: login,
                                    name: u["name"] as? String ?? "",
                                    avatar: u["avatar"] as? String ?? "",
                                    tinyCount: (u["tinyCount"] as? NSNumber)?.intValue ?? tinys.count,
                                    tinys: tinys)
            }
            state = .loaded
        } catch {
            state = .failed("Couldn't load")
        }
    }
}

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
    /// Text a panel wants in the chat composer (ChatView consumes + clears,
    /// then focuses the field). Used by the UNO Q screen's "Ask tiny".
    @Published var composerDraft: String?

    /// Every surface the sidebar can route to.
    ///
    /// ⚠️ THIS ENUM WAS THE iPAD'S CEILING, and it had drifted to half the app.
    /// It listed 8 cases while ChatView carries 16 sheets: `activity`, `graph`,
    /// `sessions`, `callRecordings`, `transcripts`, `wallet`, `universe` and
    /// `relayLog` existed as screens, were reachable on the phone from the ⋯
    /// menu, and had no sidebar row at all. So the iPad's answer for half its own
    /// features was "open the overflow menu" — the phone gesture the persistent
    /// sidebar exists to replace, on the one canvas with room not to need it.
    ///
    /// 🔑 The cases below are ordered, titled and iconed HERE, and `SidebarView`
    /// renders `allCases` rather than a hand-written list of rows. The old shape
    /// had the roster in two places (the enum, and eight literal `sidebarRow`
    /// calls), which is what let them disagree: adding a screen meant editing
    /// three files and nothing failed if you edited two. Same family as the
    /// SHOT_LIST crib that named 15 of 16 Android routes.
    enum Panel: String, CaseIterable, Identifiable {
        // Order = sidebar order. Grouped by `section` below.
        case memory, jobs, toolbox, graph
        case devices, nearby, map
        case messages, activity, sessions
        case callRecordings, transcripts
        case universe, wallet, relayLog, settings

        var id: String { rawValue }

        /// Which sidebar section this row sits in. A 16-row flat list on an 11"
        /// canvas is a wall — the grouping is what makes it scannable, and it is
        /// derived from the enum so a new case cannot land section-less.
        enum Section: String, CaseIterable {
            case think = "Think", fleet = "Fleet", talk = "Talk"
            case listen = "Listen", account = "Account"
        }

        var section: Section {
            switch self {
            case .memory, .jobs, .toolbox, .graph: return .think
            case .devices, .nearby, .map: return .fleet
            case .messages, .activity, .sessions: return .talk
            case .callRecordings, .transcripts: return .listen
            case .universe, .wallet, .relayLog, .settings: return .account
            }
        }

        /// The words on the row. Matched to the ⋯ menu's own labels, because two
        /// names for one screen ("My devices" / "Devices") is drift a user reads
        /// as two different screens.
        var title: String {
            switch self {
            case .memory: return "Memory"
            case .jobs: return "Scheduled jobs"
            case .toolbox: return "Toolbox"
            case .graph: return "Memory graph"
            case .devices: return "My devices"
            case .nearby: return "Nearby"
            case .map: return "Map"
            case .messages: return "Messages"
            case .activity: return "Activity"
            case .sessions: return "Sessions"
            case .callRecordings: return "Call recordings"
            case .transcripts: return "Transcripts"
            case .universe: return "Universe"
            case .wallet: return "Wallet"
            case .relayLog: return "Relay log"
            case .settings: return "Settings"
            }
        }

        var icon: String {
            switch self {
            case .memory: return "brain"
            case .jobs: return "clock"
            case .toolbox: return "wrench.and.screwdriver"
            case .graph: return "point.3.connected.trianglepath.dotted"
            case .devices: return "iphone.radiowaves.left.and.right"
            case .nearby: return "dot.radiowaves.left.and.right"
            case .map: return "map"
            case .messages: return "bubble.left.and.bubble.right"
            case .activity: return "bolt"
            case .sessions: return "square.stack.3d.up"
            case .callRecordings: return "recordingtape"
            case .transcripts: return "waveform.badge.mic"
            case .universe: return "globe"
            case .wallet: return "creditcard"
            case .relayLog: return "antenna.radiowaves.left.and.right"
            case .settings: return "gearshape"
            }
        }

        /// The filled variant, drawn when the row has an unread badge — the same
        /// pairing the ⋯ menu uses (`bolt` → `bolt.fill`). Falls back to `icon`
        /// for every case that never badges, so this stays one line per case that
        /// actually needs it instead of a second full table to keep in sync.
        var iconActive: String {
            switch self {
            case .messages: return "bubble.left.and.bubble.right.fill"
            case .activity: return "bolt.fill"
            default: return icon
            }
        }

        /// ⌘-chord, or nil for the rows that don't get one.
        ///
        /// ⚠️ The EXISTING chords are frozen: ⌘1 Memory … ⌘8 Map were shipped and
        /// are muscle memory, so the eight new rows take ⌘9/⌘0 and then nothing
        /// rather than renumbering. A chord that moves is worse than a chord that
        /// never existed — the user's hand has already learned the wrong one.
        var chord: Character? {
            switch self {
            case .memory: return "1"
            case .jobs: return "2"
            case .devices: return "3"
            case .messages: return "4"
            case .nearby: return "5"
            case .settings: return "6"
            case .toolbox: return "7"
            case .map: return "8"
            case .activity: return "9"
            case .transcripts: return "0"
            default: return nil
            }
        }
    }
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
    /// ⚠️ WAS `.automatic`, WHICH HIDES THE SIDEBAR IN PORTRAIT. Verified on an
    /// iPad Pro 13" (portrait, 1032×1376pt): the app launched with the accessibility
    /// tree showing `button "Show Sidebar"` and no rows on screen at all. So every
    /// surface the sidebar had just been widened to reach — 16 of them — was still
    /// behind one undiscovered tap, and the fix looked like it had changed nothing.
    /// 🔑 A roster nobody can see is the same defect as a roster that is incomplete.
    ///
    /// `.all` asks for both columns. In portrait the system still overlays rather
    /// than tiling (there isn't width to tile), but it opens SHOWN, which is the
    /// difference between "here is the app" and "here is a chat box".
    @State private var visibility: NavigationSplitViewVisibility = .all

    /// …and it is REMEMBERED — see `SidebarVisibility`.
    @AppStorage(SidebarVisibility.key) private var stored: String = SidebarVisibility.fallbackKey

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 380)
        } detail: {
            ChatView()
        }
        .navigationSplitViewStyle(.balanced)
        .onAppear { visibility = SidebarVisibility.decode(stored) }
        .onChange(of: visibility) { _, now in
            // nil = "not a preference" → leave the stored choice alone.
            if let encoded = SidebarVisibility.encode(now) { stored = encoded }
        }
    }
}

/// Persistence for the iPad sidebar's open/closed state.
///
/// A user who collapses the sidebar to give chat the whole canvas had that undone on
/// every cold launch; one who wants it open got it hidden again in portrait. Neither
/// is a preference the app should keep overriding.
///
/// Its own type rather than statics on `SplitRoot` because `SplitRoot` is `private`
/// and a test cannot reach it — a codec with a documented refusal case is exactly the
/// thing worth testing, and "it compiles" is not that test.
enum SidebarVisibility {
    static let key = "ipad.sidebar.visibility"
    /// First launch and a corrupted value both land on "show the user their app".
    static let fallbackKey = "all"

    /// ⚠️ `.automatic` CANNOT BE DISTINGUISHED BY `switch`, and finding that out is
    /// the reason this type exists instead of two statics.
    ///
    /// A test asserting `encode(.automatic) == nil` failed with `→ "detailOnly"`. So I
    /// probed the type in the simulator rather than guessing:
    ///
    ///     automatic:    equalTo=automatic+detailOnly  json={"kind":0,"isAutomatic":true}
    ///     detailOnly:   equalTo=automatic+detailOnly  json={"kind":0,"isAutomatic":false}
    ///     doubleColumn: equalTo=doubleColumn          json={"kind":1,"isAutomatic":false}
    ///     all:          equalTo=all                   json={"kind":2,"isAutomatic":false}
    ///
    /// `.automatic` IS `.detailOnly` plus an `isAutomatic` flag, and `==` ignores the
    /// flag. Two consequences, both of which bit:
    ///   1. A `case .automatic:` arm is unreachable — `case .detailOnly` matches first
    ///      and a `default:` never sees it. My "refusal" was decorative.
    ///   2. Much worse: the collapsed state and "no opinion" are the SAME value, so
    ///      persisting `.automatic` naively stores the sidebar-HIDDEN state — exactly
    ///      the bug this whole change is fixing, reintroduced through the back door.
    ///
    /// The flag is only readable through `Codable`, so that is what's used: encode,
    /// and treat `isAutomatic == true` as "no preference expressed" → nil.
    ///
    /// 🔑 An enum-looking SwiftUI type may be a struct whose `==` hides a field. Probe
    /// the value before assuming a `switch` over it is exhaustive in the way you mean.
    static func encode(_ v: NavigationSplitViewVisibility) -> String? {
        // `.all` and `.doubleColumn` are unambiguous — no flag involved.
        if v == .all { return "all" }
        if v == .doubleColumn { return "doubleColumn" }
        // Here v == .detailOnly, which is ALSO what .automatic compares equal to.
        // Read `isAutomatic` out of the encoded form to tell the two apart.
        if isAutomatic(v) { return nil }
        return "detailOnly"
    }

    /// True when this value is `.automatic` rather than a real `.detailOnly`.
    ///
    /// If the private shape ever changes and the flag can't be read, the answer is
    /// `false` — i.e. "treat it as a real choice". That direction is deliberate: a
    /// missed `.automatic` stores `detailOnly` and the user reopens the sidebar once,
    /// where treating a genuine `.detailOnly` as automatic would DISCARD the collapse
    /// every single time and look like the setting is broken.
    static func isAutomatic(_ v: NavigationSplitViewVisibility) -> Bool {
        guard let data = try? JSONEncoder().encode(v),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let flag = obj["isAutomatic"] as? Bool
        else { return false }
        return flag
    }

    static func decode(_ s: String) -> NavigationSplitViewVisibility {
        switch s {
        case "all": return .all
        case "doubleColumn": return .doubleColumn
        case "detailOnly": return .detailOnly
        // Anything else is a value this build doesn't know — an older/newer write, or
        // junk. Showing the sidebar is the recoverable answer: a wrong `detailOnly`
        // hides the whole app behind a button the user has to discover.
        default: return .all
        }
    }
}

// ── Panel presentation ─────────────────────────────────────────────────────

extension View {
    /// How a sidebar destination should size itself when it opens.
    ///
    /// ⚠️ EVERY panel opened as a phone-sized FORM SHEET. Verified on an iPad Pro
    /// 13" (1032×1376pt): tapping Transcripts produced an ~840pt card holding one
    /// transcript row, floating over a dimmed, inert sidebar. The same box was given
    /// to a 981-line Wallet and a 34-line Relay log, because a form sheet is a fixed
    /// size and ignores what is in it. The `.presentationDetents` already in the
    /// tree don't help: detents are a compact-width control and iPad regular width
    /// ignores them outright, so the sizes read as intentional while doing nothing.
    ///
    /// `.page` is the large variant, which is what a list/detail surface wants. It
    /// is deliberately applied UNCONDITIONALLY rather than behind an idiom check:
    /// presentation sizing has no effect at compact width, where a sheet is already
    /// full-height, so the iPhone is untouched and the app gains no second place
    /// that has to know which device it is on.
    ///
    /// Not applied to the share sheet or the voice picker — those are transient
    /// pickers whose detents ARE doing something on the phone, and a page-sized card
    /// for one row of choices is the opposite mistake.
    func panelSheet() -> some View {
        presentationSizing(.page)
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
            // 🗂️ DERIVED, not listed. Every `Router.Panel` case gets a row, in
            // its declared section — so a screen added to the enum appears here
            // and cannot be silently iPad-only-unreachable. Before this, eight
            // literal rows named 8 of the app's 16 surfaces.
            ForEach(Router.Panel.Section.allCases, id: \.self) { section in
                let rows = Router.Panel.allCases.filter { $0.section == section }
                if !rows.isEmpty {
                    Section(section.rawValue) {
                        ForEach(rows) { sidebarRow($0) }
                    }
                }
            }

            Section("Universe") {
                switch state {
                case .loading:
                    HStack { ProgressView().scaleEffect(0.7); Text("Loading…").font(.caption).foregroundStyle(.secondary) }
                case .failed(let e):
                    // An earlier pass gave this row the Retry the sibling panels
                    // (UniverseView/MemoryView/JobsView) have — the only recovery
                    // before it was undiscoverable pull-to-refresh on a sidebar
                    // List. It left the WORDS alone, so a grey two-word "Couldn't
                    // load" kept its dead-end feel next to a button that fixes
                    // some causes and not others. `e` now names one cause; see
                    // `load()`. Wraps rather than truncates — a sentence in a
                    // narrow sidebar is the point of this row.
                    VStack(alignment: .leading, spacing: 6) {
                        Text(e).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Retry") { Task { state = .loading; await load() } }
                            .font(.caption).buttonStyle(.bordered)
                    }
                case .loaded:
                    if universe.isEmpty {
                        Text("No tinys yet").font(.caption).foregroundStyle(.secondary)
                    }
                }
                ForEach(universe) { u in
                    // ⚠️ The third surface with the same defect, and the reason
                    // this cycle grepped the CLAIM instead of the feature: the
                    // badge read `u.tinys.count`, which the worker caps at 8
                    // (community.ts:53), while `tinyCount` is the builder's real
                    // SQL total. So @cagataycali (20 public tinys) got a sidebar
                    // badge of "8" — a number about rows this payload chose not
                    // to send — above a disclosure that listed those 8 and gave
                    // no hint the rest existed. Same rule as the phone card and
                    // the stats line: see `UniverseCounts` in Panels.swift.
                    let hidden = UniverseCounts.hiddenTinys(
                        tinyCount: u.tinyCount, chipsShown: u.tinys.count)
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
                        if hidden > 0 {
                            // The route to the rest. The Universe panel's builder
                            // card opens the profile sheet, which returns every
                            // tiny (/profile is not capped) — so the names are
                            // reachable, and only the affordance was missing.
                            Button {
                                Router.shared.openPanel = .universe
                            } label: {
                                Label("\(hidden) more in the Universe", systemImage: "ellipsis.circle")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
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
                            Text("\(u.tinyCount)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("tiny")
        .task { await load() }
        .refreshable { await load() }
    }

    /// One sidebar row, titled/iconed/chorded by the `Panel` case itself.
    ///
    /// The ⌘-chords (iPad hardware keyboard) jump straight to a surface — the
    /// sidebar rows double as the app's global panel chords.
    ///
    /// ⚠️ The BADGE is the other half of what a persistent sidebar is for. The ⋯
    /// menu has carried "Messages (3)" and "Activity (12)" since it was written,
    /// and the sidebar carried neither: on the one device where a resident list
    /// of surfaces is always on screen, the unread counts were only visible by
    /// opening the overflow menu the sidebar exists to replace. So an iPad user
    /// looking straight at "Messages" could not tell it had anything in it.
    private func sidebarRow(_ panel: Router.Panel) -> some View {
        let count = badge(panel)
        let button = Button {
            Router.shared.openPanel = panel
        } label: {
            HStack {
                Label(panel.title, systemImage: count > 0 ? panel.iconActive : panel.icon)
                    .foregroundStyle(.primary)
                if count > 0 {
                    Spacer()
                    // The count, not just a dot: "how many" is the whole question
                    // being asked, and the ⋯ menu already answers it that way.
                    Text("\(min(count, 99))")
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.accentColor, in: Capsule())
                        .accessibilityLabel("\(count) unread")
                }
            }
        }
        .hoverEffect(.highlight)
        return Group {
            if let key = panel.chord {
                button.keyboardShortcut(KeyEquivalent(key), modifiers: .command)
            } else {
                button
            }
        }
    }

    /// The unread count to draw on a row, or 0 for the rows that have none.
    ///
    /// Reads the SAME published counters the ⋯ menu reads (`session.unreadDms`,
    /// `session.unreadEvents`) rather than a second tally, so the two surfaces
    /// cannot disagree about how many messages are waiting.
    private func badge(_ panel: Router.Panel) -> Int {
        switch panel {
        case .messages: return session.unreadDms
        case .activity: return session.unreadEvents
        default: return 0
        }
    }

    private func load() async {
        do {
            // ⚠️ This was its own copy of UniverseView's read — down to the url
            // and the 20s bound — but with `let (data, _)`: the HTTP response
            // discarded, then `state = .failed("Couldn't load")` written twice,
            // once for a body that wasn't the right shape and once for anything
            // thrown. Four causes, two words, and a Retry offered to all of
            // them. It couldn't say more because it had thrown the evidence
            // away. `CommunityFeed` is now the only read; the error it throws
            // carries the status and the worker's own reason, and
            // `contentMessage` is the same table the sibling panels use.
            universe = try await CommunityFeed.load().users
            state = .loaded
        } catch {
            state = .failed(LoadFailure.contentMessage(error))
        }
    }
}

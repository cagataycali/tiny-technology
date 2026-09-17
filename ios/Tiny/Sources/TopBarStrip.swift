/**
 * 🎞️ TopBarStrip — the presence-driven top bar.
 *
 * The trailing toolbar item in ChatView. It draws ONE tile per body that is
 * online right now (BodyPresence), newest first: a 46×30 live thumbnail for
 * camera bodies (Fomo, Scout, Reachy, necklace, glasses), a 30×30 glyph for the
 * UNO Q — each with a hairline, a green dot, and the body's word as the
 * accessibility label. Offline bodies take NO width. Tap → the body's live card
 * (PiP for the arm, its sheet for the others until BodyPiPOverlay lands);
 * long-press → the full screen.
 *
 * Width is budgeted by TopBarPlan so iOS 26 never evicts the capsule: tiles
 * that do not fit fold into the Devices menu at the end of the strip — the menu
 * is always there (every body, offline ones dimmed, so the owner can still open
 * e.g. Fomo's screen to see WHY it is offline) and wears "+N" while it holds
 * overflow tiles.
 *
 * The strip also OWNS the bodies' loops: it discovers every endpoint body from
 * /api/devices and pins its manager (ArmManager, BodyManager.scout/.reachy,
 * QBrainManager) while the row exists and the app is in front, so tiles are
 * live before anyone taps. Before this, Scout/Reachy/Q only polled while their
 * sheet was open and the arm only while its (iPad-only) inline button existed.
 *
 * Identifiers: topbar-strip, topbar-tile-<body>, topbar-devices-menu.
 * Every piece is its own small View: ChatView's body is at the type-checker's
 * budget.
 */
import SwiftUI
import UIKit

/// The `shown` flags ChatView already keeps, one per body, handed to the strip.
struct TopBarBindings {
    var glasses: Binding<Bool>
    var necklace: Binding<Bool>
    var fomo: Binding<Bool>
    var qBrain: Binding<Bool>
    var scout: Binding<Bool>
    var reachy: Binding<Bool>

    func binding(_ id: BodyId) -> Binding<Bool> {
        switch id {
        case .glasses: return glasses
        case .necklace: return necklace
        case .fomo: return fomo
        case .qBrain: return qBrain
        case .scout: return scout
        case .reachy: return reachy
        }
    }
}

struct TopBarStrip: View {
    let bindings: TopBarBindings
    let sessionToken: String?
    /// Whether the necklace live view is offered at all (a session or a paired device).
    let hasNecklace: Bool

    @ObservedObject private var presence = BodyPresence.shared
    @ObservedObject private var arm = ArmManager.shared
    @ObservedObject private var scout = BodyManager.scout
    @ObservedObject private var reachy = BodyManager.reachy
    @ObservedObject private var brain = QBrainManager.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// The hosting column's width (ChatView measures it); 0 = unknown → screen.
    let columnWidth: CGFloat

    init(bindings: TopBarBindings, sessionToken: String?, hasNecklace: Bool, columnWidth: CGFloat = 0) {
        self.bindings = bindings
        self.sessionToken = sessionToken
        self.hasNecklace = hasNecklace
        self.columnWidth = columnWidth
    }

    /// Bodies the account can show at all: an endpoint body needs its row;
    /// the necklace needs a session; glasses/fake rows pass through.
    private var online: [BodyId] {
        presence.online.filter { id in
            switch id {
            case .fomo: return arm.device != nil || UITestFlags.fakeOnlineBodies.contains(id)
            case .scout: return scout.device != nil || UITestFlags.fakeOnlineBodies.contains(id)
            case .reachy: return reachy.device != nil || UITestFlags.fakeOnlineBodies.contains(id)
            case .qBrain: return brain.device != nil || UITestFlags.fakeOnlineBodies.contains(id)
            case .necklace: return hasNecklace || UITestFlags.fakeOnlineBodies.contains(id)
            case .glasses: return true
            }
        }
    }

    private var plan: TopBarPlan.Plan {
        TopBarPlan.make(online: online, screenWidth: Self.barWidth(column: columnWidth, regular: sizeClass == .regular))
    }

    /// The bar's width: the measured column when known (iPad split view — the
    /// detail pane, not the screen), else the foreground scene's screen.
    static func barWidth(column: CGFloat, regular: Bool) -> CGFloat {
        if column >= 320 { return column }
        return barWidth(regular: regular)
    }

    static func barWidth(regular: Bool) -> CGFloat {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let w = scenes.first(where: { $0.activationState == .foregroundActive })?.screen.bounds.width
            ?? scenes.first?.screen.bounds.width
            ?? UIScreen.main.bounds.width
        // iPad regular width: the same reserves apply; the bigger number simply
        // buys more inline tiles. Split-view halves are still ≥ 320.
        return regular ? max(w, 320) : w
    }

    /// Key that restarts the pin task when any body appears/disappears.
    private var deviceKey: String {
        [arm.device?.id ?? "", scout.device?.id ?? "", reachy.device?.id ?? "", brain.device?.id ?? ""].joined(separator: "|")
    }

    var body: some View {
        let plan = plan
        HStack(spacing: TopBarPlan.gap) {
            ForEach(plan.inline) { id in
                TopBarTile(id: id, row: presence.row(id), shown: bindings.binding(id))
                    .transition(.scale.combined(with: .opacity))
            }
            TopBarDevicesMenu(overflow: plan.overflow, bindings: bindings, hasNecklace: hasNecklace)
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: plan.inline)
        .accessibilityIdentifier("topbar-strip")
        .task(id: sessionToken) {
            await arm.discover(sessionToken: sessionToken)
            await scout.discover(sessionToken: sessionToken)
            await reachy.discover(sessionToken: sessionToken)
            await brain.discover(sessionToken: sessionToken)
        }
        .task(id: deviceKey) { applyPins() }
        .onChange(of: scenePhase) { _, phase in
            let active = phase == .active
            arm.sceneActive = active
            scout.sceneActive = active
            reachy.sceneActive = active
            brain.sceneActive = active
        }
        .onAppear { presence.bind() }
        .onDisappear {
            presence.unbind()
            arm.pin(false); scout.pin(false); reachy.pin(false); brain.pin(false)
        }
    }

    /// Pin every manager whose body row exists (and unpin the ones that lost it).
    /// UITestFlags.noDevicePolls keeps TinyUITests' account-menu isolation.
    private func applyPins() {
        let active = scenePhase == .active
        arm.sceneActive = active; scout.sceneActive = active; reachy.sceneActive = active; brain.sceneActive = active
        guard !UITestFlags.noDevicePolls else { return }
        arm.pin(arm.device != nil)
        scout.pin(scout.device != nil)
        reachy.pin(reachy.device != nil)
        brain.pin(brain.device != nil)
    }
}

// ── One tile ────────────────────────────────────────────────────────────────

struct TopBarTile: View {
    let id: BodyId
    let row: BodyPresenceCore.Row
    @Binding var shown: Bool

    private var accessibility: String {
        switch id {
        // LiveOverlayUITests / FomoPiPUITests / AccountMenuUITests look for this prefix.
        case .fomo: return shown ? "Close arm live view" : "Arm live view, \(row.fpsText.isEmpty ? "live" : row.fpsText)"
        default: return shown ? "Close \(id.title) live view" : "\(id.title) live view, \(row.fpsText.isEmpty ? "live" : row.fpsText)"
        }
    }

    /// Not a `Button`: inside a toolbar every Button becomes its own glass
    /// segment with ~22 pt of padding, and three of those squeezed the title to
    /// "ti" on a 402 pt phone. Plain tappable views inside ONE container pay
    /// the capsule padding once. The button trait keeps XCUITest/VoiceOver
    /// seeing a button ("Arm live view…" prefix is what the UI tests query).
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if id.hasCamera {
                Group {
                    if let thumb = row.thumb {
                        Image(uiImage: thumb)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        Color.primary.opacity(0.12)
                            .overlay(Image(systemName: id.symbol).font(.system(size: 13, weight: .medium)))
                    }
                }
                .frame(width: TopBarPlan.cameraTileWidth, height: 30)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .animation(.easeInOut(duration: 0.25), value: row.thumbAt)
            } else {
                Image(systemName: id.symbol)
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: TopBarPlan.glyphTileWidth, height: 30)
            }
            Circle()
                .fill(Color.green)
                .frame(width: 7, height: 7)
                .overlay(Circle().stroke(Color.black.opacity(0.35), lineWidth: 0.5))
                .offset(x: -3, y: -3)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(shown ? Color.green : Color.primary.opacity(0.35), lineWidth: 1)
        )
        .foregroundStyle(shown ? Color.green : Color.primary)
        .contentShape(Rectangle())
        .onTapGesture {
            TinyDesign.haptic()
            shown.toggle()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(accessibility)
        .accessibilityIdentifier("topbar-tile-\(id.rawValue)")
    }
}

// ── The Devices menu: overflow + every body, offline ones dimmed ────────────

struct TopBarDevicesMenu: View {
    let overflow: [BodyId]
    let bindings: TopBarBindings
    let hasNecklace: Bool
    @ObservedObject private var presence = BodyPresence.shared
    @ObservedObject private var arm = ArmManager.shared
    @ObservedObject private var scout = BodyManager.scout
    @ObservedObject private var reachy = BodyManager.reachy
    @ObservedObject private var brain = QBrainManager.shared

    init(overflow: [BodyId], bindings: TopBarBindings, hasNecklace: Bool) {
        self.overflow = overflow
        self.bindings = bindings
        self.hasNecklace = hasNecklace
    }

    /// Everything the account could show, overflow (online, not in the bar) first.
    private var rest: [BodyId] {
        BodyId.allCases.filter { id in
            guard !overflow.contains(id) else { return false }
            switch id {
            case .fomo: return arm.device != nil
            case .scout: return scout.device != nil
            case .reachy: return reachy.device != nil
            case .qBrain: return brain.device != nil
            case .necklace: return hasNecklace
            case .glasses:
                #if canImport(MWDATCore) && canImport(MWDATCamera)
                return WearablesManager.shared.isLinked || UITestFlags.fakeGlassesLinked
                #else
                return UITestFlags.fakeGlassesLinked
                #endif
            }
        }
    }

    private var anyShown: Bool {
        BodyId.allCases.contains { bindings.binding($0).wrappedValue }
    }

    var body: some View {
        Menu {
            if !overflow.isEmpty {
                Section("Also online") {
                    ForEach(overflow) { id in entry(id, online: true) }
                }
            }
            Section(overflow.isEmpty ? "Devices" : "All devices") {
                ForEach(rest) { id in entry(id, online: presence.row(id).isOnline) }
            }
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .foregroundStyle(anyShown ? Color.green : Color.primary)
                    .frame(width: TopBarPlan.menuWidth, height: 30)
                if !overflow.isEmpty {
                    Text("+\(overflow.count)")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .padding(.horizontal, 3).padding(.vertical, 1)
                        .background(Capsule().fill(Color.green))
                        .foregroundStyle(.black)
                        .offset(x: 4, y: -2)
                }
            }
        }
        .accessibilityLabel(overflow.isEmpty ? "Devices" : "Devices, \(overflow.count) more online")
        .accessibilityIdentifier("topbar-devices-menu")
    }

    @ViewBuilder private func entry(_ id: BodyId, online: Bool) -> some View {
        let shown = bindings.binding(id)
        Button {
            TinyDesign.haptic()
            shown.wrappedValue.toggle()
        } label: {
            if online {
                Label(shown.wrappedValue ? "\(id.title) · hide" : "\(id.title) · online", systemImage: id.symbol)
            } else {
                // Menus ignore foregroundStyle; the word carries the state.
                Label("\(id.title) · offline", systemImage: id.symbol)
            }
        }
    }
}

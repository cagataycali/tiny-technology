/**
 * 🦾 FomoPiPOverlay — the arm's picture-in-picture card, a real control surface.
 *
 *  - live MJPEG (ArmManager's reader) with the honest badge: "live · 17 fps",
 *    "snapshot", or "no camera" — the word says which source is on the glass;
 *  - drag anywhere: on release it snaps to the nearest screen corner (spring),
 *    the corner and the size persist (FomoPiPPrefs) so it comes back where it was;
 *  - two sizes (thumbnail / half-screen) + full screen (FomoScreen);
 *  - STOP is in the strip at every size, one tap, never hidden by the keyboard
 *    (the card floats in ChatView's overlay, above the composer);
 *  - a one-line HUD in the half size: pose, rail volts, torque, ToF, busy.
 *
 * Identifiers: arm-live-overlay / arm-live-device (kept from build 79 so
 * LiveOverlayUITests stays green), fomo-pip-stop, fomo-pip-size, fomo-pip-expand,
 * fomo-pip-close, fomo-pip-badge, fomo-pip-hud.
 */
import SwiftUI

struct FomoPiPOverlay: View {
    @Binding var shown: Bool
    @EnvironmentObject private var session: TinySession
    @ObservedObject private var fomo = FomoManager.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var dragOffset: CGSize = .zero
    @State private var full = false

    /// The card floats inside ChatView's top-trailing overlay stack. A
    /// GeometryReader claims the space left under the other cards (transparent
    /// areas pass touches through) and the corner is plain alignment, so a snap
    /// is an animated alignment change — no offset bookkeeping to drift.
    var body: some View {
        GeometryReader { geo in
            card(width: geo.size.width)
                .offset(dragOffset)
                .gesture(
                    DragGesture(minimumDistance: 6, coordinateSpace: .named("fomo-pip"))
                        .onChanged { dragOffset = $0.translation }
                        .onEnded { v in
                            let corner = FomoPiPCorner.nearest(to: v.location, in: geo.size)
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                fomo.corner = corner
                                dragOffset = .zero
                            }
                            TinyDesign.haptic(.light)
                        }
                )
                .padding(8)
                // bottom corners sit above the composer band
                .padding(.bottom, fomo.corner.isTop ? 0 : 72)
                .frame(width: geo.size.width, height: geo.size.height, alignment: alignment(fomo.corner))
        }
        .coordinateSpace(name: "fomo-pip")
        .fullScreenCover(isPresented: $full) { FomoScreen().environmentObject(session) }
        .task(id: "\(fomo.device?.id ?? "")|\(session.token ?? "")") {
            fomo.configure(device: fomo.device, sessionToken: session.token)
            if !UITestFlags.noDevicePolls { fomo.startPolling() }
        }
        .onAppear {
            ArmManager.shared.sceneActive = scenePhase == .active
            ArmManager.shared.retainViewer()
            FomoPiPPrefs.open = true
        }
        .onDisappear { ArmManager.shared.releaseViewer(); fomo.stopPolling() }
        .onChange(of: scenePhase) { _, phase in ArmManager.shared.sceneActive = phase == .active }
        .animation(.spring(response: 0.3), value: fomo.size)
    }

    private func alignment(_ c: FomoPiPCorner) -> Alignment {
        switch c {
        case .topLeading: return .topLeading
        case .topTrailing: return .topTrailing
        case .bottomLeading: return .bottomLeading
        case .bottomTrailing: return .bottomTrailing
        }
    }

    private func card(width: CGFloat) -> some View {
        let pic = fomo.size.picture(in: width)
        return VStack(spacing: 0) {
            Group {
                if fomo.pipView == .twin {
                    FomoTwinView(fomo: fomo, compact: true)          // orbit by drag; tap the strip's expand to open
                } else {
                    FomoPicture(fomo: fomo, compact: true)
                        .contentShape(Rectangle())
                        .onTapGesture { full = true }
                }
            }
            .frame(width: pic.width, height: pic.height)
            .clipped()
            if fomo.size == .half { hud }
            strip
        }
        .frame(width: pic.width)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(radius: 12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("arm-live-overlay")
        .accessibilityValue("\(fomo.corner.rawValue) \(fomo.size.rawValue)")
    }

    // ── Strip: STOP · name · size · expand · close ──────────────────────────

    private var strip: some View {
        HStack(spacing: 10) {
            FomoStopButton(fomo: fomo).accessibilityIdentifier("fomo-pip-stop")
            Text(fomo.device?.name ?? "arm")
                .font(.caption2)
                .accessibilityIdentifier("arm-live-device")
                .frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let p = fomo.pending {
                Text(p).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Button { TinyDesign.haptic(); fomo.pipView = fomo.pipView == .twin ? .camera : .twin } label: {
                Image(systemName: fomo.pipView == .twin ? "video" : "cube.transparent")
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel(fomo.pipView == .twin ? "Show the camera" : "Show the twin")
            .accessibilityIdentifier("fomo-pip-view")
            .accessibilityValue(fomo.pipView.rawValue)
            Button { TinyDesign.haptic(); fomo.size = fomo.size.next } label: {
                Image(systemName: fomo.size == .thumb ? "rectangle.expand.vertical" : "rectangle.compress.vertical")
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel(fomo.size == .thumb ? "Larger arm card" : "Smaller arm card")
            .accessibilityIdentifier("fomo-pip-size")
            Button { full = true } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right").foregroundStyle(.secondary)
            }
            .accessibilityLabel("Expand arm view")
            .accessibilityIdentifier("fomo-pip-expand")
            Button { shown = false; FomoPiPPrefs.open = false } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .accessibilityLabel("Close arm view")
            .accessibilityIdentifier("fomo-pip-close")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private var hud: some View {
        HStack(spacing: 10) {
            if let s = fomo.state {
                Text(s.folded == true ? "folded" : (s.busy ?? "ready")).lineLimit(1)
                if let v = s.voltage { Text(String(format: "%.1f V", v)) }
                Text(s.anyTorque ? (s.torqueOn ? "torque on" : "torque part") : "torque off")
                if let mm = s.nicla?.tofMm { Text("\(Int(mm)) mm") }
                if let m = s.motion, let i = m.i, let n = m.n { Text("\(m.name) \(i)/\(n)") }
            } else {
                Text(fomo.client == nil ? "no arm row" : "reaching \(fomo.device?.name ?? "the arm")…")
            }
            Spacer(minLength: 0)
        }
        .font(.caption2.monospaced())
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-pip-hud")
    }

}

// ── Shared pieces (card + full screen) ──────────────────────────────────────

/// The picture with the honest badge. Badge word = freshness (ArmCore.badge),
/// fps from Fomo's state when the stream is live.
struct FomoPicture: View {
    /// The ONLY view observing ArmManager: its ~19 fps `frame` publishes stay inside this leaf.
    @ObservedObject private var arm = ArmManager.shared
    @ObservedObject var fomo: FomoManager
    var compact = false

    var body: some View {
        ZStack {
            Rectangle().fill(.black.opacity(0.9))
            if let frame = arm.frame {
                Image(uiImage: frame)
                    .resizable()
                    .aspectRatio(contentMode: compact ? .fill : .fit)
                    .accessibilityIdentifier("arm-live-frame")
                    .accessibilityLabel("\(arm.badge.label) picture from \(arm.device?.name ?? "the arm")")
            } else {
                VStack(spacing: 6) {
                    Text("🦾").font(.title2)
                    Text(emptyLine).font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center).padding(.horizontal, 8)
                }
                .accessibilityIdentifier("arm-live-empty")
            }
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 4) {
                Circle().fill(arm.badge == .live ? Color.green : (arm.badge == .snapshot ? Color.orange : Color.secondary))
                    .frame(width: 5, height: 5)
                Text(badgeText).font(.caption2.weight(.medium))
            }
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(.black.opacity(0.6), in: Capsule())
            .foregroundStyle(.white.opacity(0.9))
            .padding(8)
            .accessibilityIdentifier("fomo-pip-badge")
        }
    }

    private var badgeText: String {
        switch arm.badge {
        case .live:
            if let fps = fomo.state?.nicla?.fps, fps > 0 { return String(format: "live · %.0f fps", fps) }
            return "live"
        case .snapshot: return "snapshot · 1 Hz"
        case .none: return "no camera"
        }
    }

    private var emptyLine: String {
        if fomo.state == nil && arm.state == nil { return "reaching \(arm.device?.name ?? "the arm")…" }
        if let n = fomo.state?.nicla, !n.ok { return "Nicla offline — the head camera is not answering" }
        return arm.badge == .none ? "no camera right now" : "waiting for a frame…"
    }
}

/// STOP: one tap, no confirm, red on purpose. Always allowed by the guard.
struct FomoStopButton: View {
    @ObservedObject var fomo: FomoManager
    var large = false
    var body: some View {
        Button(role: .destructive) { fomo.stop() } label: {
            HStack(spacing: 6) {
                Image(systemName: "stop.fill")
                if large { Text("STOP") }
            }
            .font(large ? .headline : .caption.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, large ? 18 : 8).padding(.vertical, large ? 10 : 6)
            .background(Color.red, in: Capsule())
        }
        .accessibilityLabel("Stop the arm")
    }
}

/// One line that disappears on its own. Every refusal lands here, verbatim.
struct FomoToast: View {
    @ObservedObject var fomo: FomoManager
    var body: some View {
        if let toast = fomo.toast {
            Text(toast)
                .font(.caption.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.red.opacity(0.85), in: Capsule())
                .transition(.move(edge: .top).combined(with: .opacity))
                .accessibilityIdentifier("fomo-toast")
                .task(id: toast) {
                    try? await Task.sleep(for: .seconds(4))
                    if fomo.toast == toast { fomo.toast = nil }
                }
        }
    }
}

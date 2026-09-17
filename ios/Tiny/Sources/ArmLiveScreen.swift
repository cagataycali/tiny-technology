/**
 * 🦾 ArmLiveScreen — what the arm surface looks like.
 *
 *  - `ArmToolbarButton`: the sibling of the necklace's `sparkles.tv` button. It
 *    also OWNS discovery (its `.task` asks ArmManager to look for an arm row), and
 *    renders nothing while there is none — so ChatView's body gains one line.
 *  - `ArmLiveOverlay`: now a wrapper over FomoPiPOverlay (FomoPiP.swift).
 *  - `ArmLiveScreen`: the strands-arm-dialect full screen, kept for the
 *    arm.example.com dash; Fomo opens FomoScreen from the card instead. The picture IS the joystick: drag anywhere on
 *    it and the head looks there (centre = home, edges = the guard's look range).
 *    HOME / STOP / photo always visible, a HUD of current vs target, a one-time
 *    token paste when the Keychain has none, and a toast for every refusal.
 *
 * The model (polls, MJPEG, coalescing, control) is ArmLive.swift.
 */
import SwiftUI

// ── Toolbar ─────────────────────────────────────────────────────────────────

struct ArmToolbarButton: View {
    @Binding var shown: Bool
    let sessionToken: String?
    @ObservedObject private var arm = ArmManager.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            // Always a real view here, so the modifiers below run even before
            // an arm is known (an empty Group never mounts its .task).
            Color.clear.frame(width: 1, height: 1)
            if arm.device != nil {
                Button {
                    TinyDesign.haptic()
                    shown.toggle()
                } label: {
                    // The camera IS the button: the latest frame from the head,
                    // live dot when the MJPEG stream is up. Falls back to the
                    // arm glyph while no frame has arrived yet.
                    ZStack(alignment: .bottomTrailing) {
                        if let frame = arm.frame {
                            Image(uiImage: frame)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 46, height: 30)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        } else {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(Color.primary.opacity(0.12))
                                .frame(width: 46, height: 30)
                                .overlay(Text("🦾").font(.caption))
                        }
                        Circle()
                            .fill(arm.badge == .live ? Color.green : (arm.badge == .snapshot ? Color.orange : Color.gray))
                            .frame(width: 7, height: 7)
                            .offset(x: -3, y: -3)
                    }
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(shown ? Color.green : Color.primary.opacity(0.35), lineWidth: 1)
                    )
                }
                .accessibilityLabel(shown ? "Close arm live view" : "Arm live view, \(arm.badge.label)")
            }
        }
        .task(id: sessionToken) { await arm.discover(sessionToken: sessionToken) }
        // The toolbar owns the arm's loops: camera + state run whenever an arm
        // is known and the app is in front, so the thumbnail is live before
        // anyone taps it. The overlay no longer starts/stops them.
        .task(id: arm.device?.id) {
            arm.sceneActive = scenePhase == .active
            // UITestFlags.noDevicePolls: TinyUITests isolates the account-menu
            // first-tap bug from these live ticks.
            if arm.device != nil, !UITestFlags.noDevicePolls { arm.start() } else { arm.stop() }
        }
        .onChange(of: scenePhase) { _, phase in arm.sceneActive = phase == .active }
        .onDisappear { arm.stop() }
    }
}

// ── Shared pieces ───────────────────────────────────────────────────────────

/// The picture with its badge, or the honest empty state. Used by both the card
/// and the full screen so they can never disagree about what is on the glass.
private struct ArmPicture: View {
    @ObservedObject var arm: ArmManager
    var compact = false

    var body: some View {
        ZStack {
            Rectangle().fill(.black.opacity(0.9))
            if let frame = arm.frame {
                Image(uiImage: frame)
                    .resizable()
                    .aspectRatio(contentMode: compact ? .fill : .fit)
                    .accessibilityLabel("\(arm.badge.label) picture from \(arm.device?.name ?? "the arm")")
                    .accessibilityIdentifier("arm-live-frame")
            } else {
                VStack(spacing: 6) {
                    Text("🦾").font(.title2)
                    Text(emptyLine).font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center).padding(.horizontal, 8)
                }
            }
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 4) {
                Circle().fill(arm.badge == .live ? Color.green : Color.secondary)
                    .frame(width: 5, height: 5)
                Text(arm.badge.label).font(.caption2.weight(.medium))
                if let s = arm.state, !compact {
                    Text("· \(s.pose)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(.black.opacity(0.6), in: Capsule())
            .foregroundStyle(.white.opacity(0.9))
            .padding(8)
        }
    }

    private var emptyLine: String {
        if arm.state == nil { return "reaching \(arm.device?.name ?? "the arm")…" }
        if !arm.hasToken { return "stream is down — paste the arm token for snapshots" }
        return arm.badge == .none ? "no camera right now" : "waiting for a frame…"
    }
}

/// One line that disappears on its own. Every guard refusal lands here.
private struct ArmToast: View {
    @ObservedObject var arm: ArmManager
    var body: some View {
        if let toast = arm.toast {
            Text(toast)
                .font(.caption.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.red.opacity(0.85), in: Capsule())
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: toast) {
                    try? await Task.sleep(for: .seconds(3))
                    if arm.toast == toast { arm.toast = nil }
                }
        }
    }
}

private struct StopButton: View {
    @ObservedObject var arm: ArmManager
    var large = false
    var body: some View {
        // One tap, no confirm, always allowed by the guard — red on purpose.
        Button(role: .destructive) { arm.stopArm() } label: {
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

// ── PiP card ────────────────────────────────────────────────────────────────

/// The card is FomoPiPOverlay (FomoPiP.swift): snap-to-corner, two sizes,
/// persisted layout, STOP in the strip, full screen = FomoScreen. This wrapper
/// keeps ChatView's call site (`ArmLiveOverlay(shown:)`) unchanged.
struct ArmLiveOverlay: View {
    @Binding var shown: Bool
    var body: some View { FomoPiPOverlay(shown: $shown) }
}

// ── Full screen: the picture is the joystick ────────────────────────────────

struct ArmLiveScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tinyAccent) private var accent
    @ObservedObject private var arm = ArmManager.shared
    @State private var tokenDraft = ""
    @State private var confirmHome = false
    @State private var showPhoto = false
    @State private var dragging = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                pad
                hud
                controls
                if !arm.hasToken { tokenField }
                Spacer(minLength: 0)
            }
            .padding()
            .background(Color(.systemBackground))
            .overlay(alignment: .top) { ArmToast(arm: arm).padding(.top, 4) }
            .animation(.easeInOut(duration: 0.2), value: arm.toast)
            .navigationTitle(arm.device?.name ?? "arm")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if arm.hasToken {
                        Button("Forget token") { arm.forgetToken() }.font(.caption)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Move every joint to the folded home?", isPresented: $confirmHome, titleVisibility: .visible) {
                Button("HOME the arm") { arm.home() }
            } message: {
                Text("The whole arm moves, not just the head. Keep the desk clear.")
            }
            .sheet(isPresented: $showPhoto) { photoSheet }
            .onChange(of: arm.lastPhoto) { _, img in if img != nil { showPhoto = true } }
        }
    }

    /// Drag anywhere: the head looks where the thumb is. The target follows the
    /// finger through ArmManager's ≤5 Hz coalescer; lifting sends nothing more.
    private var pad: some View {
        GeometryReader { geo in
            let size = geo.size
            let range = arm.lookRange
            ZStack {
                ArmPicture(arm: arm)
                // crosshair = home
                Path { p in
                    p.move(to: CGPoint(x: size.width / 2, y: 0)); p.addLine(to: CGPoint(x: size.width / 2, y: size.height))
                    p.move(to: CGPoint(x: 0, y: size.height / 2)); p.addLine(to: CGPoint(x: size.width, y: size.height / 2))
                }
                .stroke(.white.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 6]))
                if let cur = arm.currentLook {
                    Circle().stroke(.white, lineWidth: 2).frame(width: 18, height: 18)
                        .position(ArmCore.padPoint(for: cur, in: size, range: range))
                }
                if let t = arm.target {
                    Circle().fill(accent).frame(width: 12, height: 12)
                        .position(ArmCore.padPoint(for: t, in: size, range: range))
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { v in
                        dragging = true
                        arm.requestLook(ArmCore.lookTarget(point: v.location, in: size, range: range))
                    }
                    .onEnded { _ in dragging = false }
            )
        }
        .aspectRatio(4.0 / 3.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(dragging ? accent : Color.secondary.opacity(0.3), lineWidth: dragging ? 2 : 1))
        .accessibilityLabel("Look pad: drag to point the head")
    }

    private var hud: some View {
        HStack(spacing: 14) {
            hudCell("pan", arm.currentLook?.pan, arm.target?.pan)
            hudCell("tilt", arm.currentLook?.tilt, arm.target?.tilt)
            Spacer()
            if let s = arm.state {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(s.busy ? "guard busy" : (s.transport ?? "no head")).font(.caption2).foregroundStyle(.secondary)
                    if let mm = s.tofMm { Text("\(Int(mm)) mm").font(.caption.monospaced()) }
                }
            }
        }
    }

    private func hudCell(_ label: String, _ cur: Double?, _ target: Double?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            HStack(spacing: 4) {
                Text(cur.map { Self.deg($0) } ?? "—").font(.caption.monospaced())
                if let target, target != cur {
                    Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.secondary)
                    Text(Self.deg(target)).font(.caption.monospaced()).foregroundStyle(accent)
                }
            }
        }
    }

    static func deg(_ d: Double) -> String { String(format: "%+.1f°", d) }

    private var controls: some View {
        HStack(spacing: 12) {
            Button { confirmHome = true } label: {
                Label("HOME", systemImage: "house.fill").font(.caption.weight(.bold))
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
            }
            .disabled(!arm.hasToken)
            StopButton(arm: arm, large: true)
            Spacer()
            Button { Task { await arm.photo() } } label: {
                if arm.photoBusy { ProgressView().controlSize(.small) }
                else { Image(systemName: "camera.fill").font(.title3) }
            }
            .disabled(!arm.hasToken || arm.photoBusy)
            .accessibilityLabel("Take a photo with the head camera")
        }
    }

    /// One-time paste. Validated against /api/auth/me before it is kept; the
    /// token is the arm's own (never tiny's), and never leaves the Keychain.
    private var tokenField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Arm control token").font(.caption.weight(.semibold))
            Text("The picture and readings are public; moving the head, HOME and photos need the dashboard's STRANDS_ARM_TOKEN. Paste it once — it stays in this phone's Keychain.")
                .font(.caption2).foregroundStyle(.secondary)
            HStack {
                SecureField("paste token", text: $tokenDraft)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .font(.caption.monospaced())
                Button {
                    Task { if await arm.saveToken(tokenDraft) { tokenDraft = "" } }
                } label: {
                    if arm.tokenChecking { ProgressView().controlSize(.small) } else { Text("Save") }
                }
                .disabled(tokenDraft.trimmingCharacters(in: .whitespaces).isEmpty || arm.tokenChecking)
            }
            .padding(10)
            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var photoSheet: some View {
        VStack(spacing: 12) {
            if let img = arm.lastPhoto {
                Image(uiImage: img).resizable().aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            Text("Saved on the arm under ~/.strands-arm/snaps").font(.caption2).foregroundStyle(.secondary)
            Button("Done") { showPhoto = false }
        }
        .padding()
        .presentationDetents([.medium, .large])
    }
}

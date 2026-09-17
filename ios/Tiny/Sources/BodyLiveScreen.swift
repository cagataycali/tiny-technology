/**
 * 🤖 BodyLiveScreen — the phone surface for a robot body (Scout rover / Reachy Mini).
 *
 *  - `BodyToolbarButton(kind:)` owns discovery (`.task(id: sessionToken)` → /api/devices)
 *    and renders 1 pt of nothing while the account has no row for that body, so the
 *    toolbar never shows a button that opens an empty sheet.
 *  - `BodyLiveScreen(kind:)`: camera on top (live MJPEG / polled frames, honest badge),
 *    readings grid, then the body's controls. STOP is always the biggest control.
 *      Scout  → D-pad of bounded 0.6 s nudges + lamp + STOP
 *      Reachy → look pad (±10° steps, clamped ±25°), antennas presets, emotions menu,
 *               Say, Home, STOP
 *  - token field appears only while the robot has refused / never seen a token.
 */
import SwiftUI
import UIKit

// ── Toolbar button (owns discovery) ─────────────────────────────────────────

struct BodyToolbarButton: View {
    let kind: BodyKind
    @Binding var shown: Bool
    let sessionToken: String?
    @ObservedObject private var body_: BodyManager
    @Environment(\.scenePhase) private var scenePhase

    init(kind: BodyKind, shown: Binding<Bool>, sessionToken: String?) {
        self.kind = kind
        self._shown = shown
        self.sessionToken = sessionToken
        self._body_ = ObservedObject(wrappedValue: BodyManager.shared(kind))
    }

    var body: some View {
        ZStack {
            Color.clear.frame(width: 1, height: 1)
            if body_.device != nil {
                Button {
                    TinyDesign.haptic()
                    shown.toggle()
                } label: {
                    ZStack(alignment: .bottomTrailing) {
                        Image(systemName: kind.symbol)
                            .font(.system(size: 17, weight: .medium))
                            .frame(width: 30, height: 30)
                        Circle()
                            .fill(QBrainHealthDot.color(body_.health))
                            .frame(width: 7, height: 7)
                            .offset(x: -2, y: -2)
                    }
                    .foregroundStyle(shown ? Color.green : Color.primary)
                }
                .accessibilityLabel("\(kind.title), \(QBrainHealthDot.label(body_.health))")
            }
        }
        .task(id: sessionToken) { await body_.discover(sessionToken: sessionToken) }
        .task(id: body_.device?.id) {
            body_.sceneActive = scenePhase == .active
            // Polls only while the sheet is open (start() from the screen); the
            // button itself never streams video in the background.
        }
        .onChange(of: scenePhase) { _, phase in body_.sceneActive = phase == .active }
    }
}

/// Both bodies in ONE toolbar slot. The shared device capsule fits four buttons on
/// a 402 pt phone; a fifth made iOS 26 evict the whole custom item (build 88).
/// Owns discovery for both managers; draws 1 pt of nothing while neither has a
/// row; opens the sheet directly when only one body exists, a menu when both do.
struct BodiesToolbarButton: View {
    @Binding var showScout: Bool
    @Binding var showReachy: Bool
    let sessionToken: String?
    @ObservedObject private var scout = BodyManager.scout
    @ObservedObject private var reachy = BodyManager.reachy
    @Environment(\.scenePhase) private var scenePhase

    private var worst: BodyCore.Health {
        let hs = [scout.device == nil ? nil : scout.health, reachy.device == nil ? nil : reachy.health].compactMap { $0 }
        if hs.contains(.offline) { return .offline }
        if hs.contains(.stale) { return .stale }
        if hs.contains(.live) { return .live }
        return .unknown
    }

    var body: some View {
        ZStack {
            Color.clear.frame(width: 1, height: 1)
            if scout.device != nil && reachy.device != nil {
                Menu {
                    Button { TinyDesign.haptic(); showScout = true } label: {
                        Label("Scout rover · \(QBrainHealthDot.label(scout.health))", systemImage: BodyKind.scout.symbol)
                    }
                    Button { TinyDesign.haptic(); showReachy = true } label: {
                        Label("Reachy Mini · \(QBrainHealthDot.label(reachy.health))", systemImage: BodyKind.reachy.symbol)
                    }
                } label: { icon("figure.walk.motion") }
                .accessibilityLabel("Robots")
            } else if scout.device != nil {
                Button { TinyDesign.haptic(); showScout.toggle() } label: { icon(BodyKind.scout.symbol) }
                    .accessibilityLabel("Scout, \(QBrainHealthDot.label(scout.health))")
            } else if reachy.device != nil {
                Button { TinyDesign.haptic(); showReachy.toggle() } label: { icon(BodyKind.reachy.symbol) }
                    .accessibilityLabel("Reachy, \(QBrainHealthDot.label(reachy.health))")
            }
        }
        .task(id: sessionToken) {
            await scout.discover(sessionToken: sessionToken)
            await reachy.discover(sessionToken: sessionToken)
        }
        .onChange(of: scenePhase) { _, phase in
            scout.sceneActive = phase == .active
            reachy.sceneActive = phase == .active
        }
    }

    private func icon(_ symbol: String) -> some View {
        ZStack(alignment: .bottomTrailing) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .frame(width: 30, height: 30)
            Circle().fill(QBrainHealthDot.color(worst)).frame(width: 7, height: 7).offset(x: -2, y: -2)
        }
        .foregroundStyle((showScout || showReachy) ? Color.green : Color.primary)
    }
}

// ── The screen ──────────────────────────────────────────────────────────────

struct BodyLiveScreen: View {
    let kind: BodyKind
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var body_: BodyManager
    @State private var tokenDraft = ""
    @State private var sayDraft = ""
    @State private var pitch = 0.0
    @State private var yaw = 0.0

    init(kind: BodyKind) {
        self.kind = kind
        self._body_ = ObservedObject(wrappedValue: BodyManager.shared(kind))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    camera
                    if let t = body_.toast { notice(t, tint: .orange) }
                    if body_.stateAt == nil { waiting } else { vitals }
                    controls
                    if !body_.hasToken { tokenField }
                }
                .padding(16)
            }
            .navigationTitle(body_.device?.name ?? kind.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if let url = body_.device.flatMap({ URL(string: $0.url) }) {
                            Link(destination: url) { Label("Open dashboard", systemImage: "safari") }
                        }
                        if body_.hasToken {
                            Button(role: .destructive) { body_.forgetToken() } label: {
                                Label("Forget token", systemImage: "key.slash")
                            }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .onAppear { body_.start(); body_.retainViewer() }
        .onDisappear { body_.releaseViewer(); body_.stop() }
        .onChange(of: body_.toast) { _, t in
            guard t != nil else { return }
            Task { try? await Task.sleep(for: .seconds(4)); body_.toast = nil }
        }
        .onChange(of: body_.reachyState) { _, s in
            // Follow the real head so the first tap nudges from where it IS.
            if let s, let p = s.pitch, let y = s.yaw, !body_.busy { pitch = p; yaw = y }
        }
    }

    // ── Header / camera ──

    private var header: some View {
        HStack(spacing: 10) {
            Circle().fill(QBrainHealthDot.color(body_.health)).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(kind.title) · \(QBrainHealthDot.label(body_.health))").font(.headline)
                Text(body_.device?.url.replacingOccurrences(of: "https://", with: "") ?? "")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if body_.frameAt != nil {
                Label(body_.streaming ? "live · \(Int(body_.fps.rounded())) fps" : "frames · \(Int(body_.fps.rounded())) fps",
                      systemImage: body_.streaming ? "dot.radiowaves.up.forward" : "camera")
                    .font(.caption2.weight(.medium)).foregroundStyle(body_.streaming ? .green : .secondary)
            }
        }
    }

    private var camera: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.black)
            if let d = body_.frame, let img = UIImage(data: d) {
                Image(uiImage: img).resizable().aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityLabel("\(kind.title) camera")
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "video.slash").font(.title2)
                    Text(body_.hasToken ? "Waiting for the camera…" : "Paste the token to see the camera")
                        .font(.caption)
                }
                .foregroundStyle(.white.opacity(0.7))
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
    }

    private var waiting: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Reaching \(body_.device?.name ?? kind.title)…", systemImage: "antenna.radiowaves.left.and.right")
            Text(body_.hasToken ? "The tunnel answers slowly on first contact." : "Paste the robot's token below to read and drive it.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func notice(_ text: String, tint: Color) -> some View {
        Label(text, systemImage: "exclamationmark.triangle")
            .font(.caption)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var vitals: some View {
        let rows = body_.readings.filter { $0.label != "error" }
        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            ForEach(rows) { r in
                VStack(alignment: .leading, spacing: 3) {
                    Text(r.label.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(r.value).font(.callout.monospacedDigit()).lineLimit(2).minimumScaleFactor(0.7)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityElement(children: .combine)
            }
        }
    }

    // ── Controls ──

    @ViewBuilder private var controls: some View {
        switch kind {
        case .scout: scoutControls
        case .reachy: reachyControls
        }
    }

    private func padButton(_ symbol: String, label: String, tint: Color = .primary, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.title2.weight(.semibold))
                .frame(width: 64, height: 56)
                .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
        .disabled(!body_.hasToken || body_.busy)
        .accessibilityLabel(label)
    }

    private var stopButton: some View {
        Button {
            TinyDesign.haptic(.heavy)
            Task { await body_.emergencyStop() }
        } label: {
            Label("STOP", systemImage: "octagon.fill")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(Color.red, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .disabled(!body_.hasToken)
        .accessibilityLabel("Stop \(kind.title)")
    }

    private var scoutControls: some View {
        VStack(spacing: 10) {
            Text("Each tap is one bounded nudge (0.6 s, 40 % speed). Make sure the rover has room.")
                .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            padButton("arrow.up", label: "Forward") { Task { await body_.drive(linear: 0.4, angular: 0) } }
            HStack(spacing: 10) {
                padButton("arrow.turn.up.left", label: "Turn left") { Task { await body_.drive(linear: 0, angular: 0.6) } }
                padButton("lightbulb", label: "Toggle lamp", tint: (body_.scoutState?.lamp ?? false) ? .yellow : .primary) {
                    Task { await body_.lamp(!(body_.scoutState?.lamp ?? false)) }
                }
                padButton("arrow.turn.up.right", label: "Turn right") { Task { await body_.drive(linear: 0, angular: -0.6) } }
            }
            padButton("arrow.down", label: "Back") { Task { await body_.drive(linear: -0.4, angular: 0) } }
            stopButton
        }
    }

    private var reachyControls: some View {
        VStack(spacing: 10) {
            Text("Look pad moves the head 10° a tap (±25°). Antennas, emotions and speech below.")
                .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            padButton("arrow.up", label: "Look up") { nudge(dp: 10, dy: 0) }
            HStack(spacing: 10) {
                padButton("arrow.left", label: "Look left") { nudge(dp: 0, dy: 10) }
                padButton("scope", label: "Center") { pitch = 0; yaw = 0; Task { await body_.look(pitch: 0, yaw: 0) } }
                padButton("arrow.right", label: "Look right") { nudge(dp: 0, dy: -10) }
            }
            padButton("arrow.down", label: "Look down") { nudge(dp: -10, dy: 0) }
            HStack(spacing: 10) {
                smallButton("Antennas up") { Task { await body_.antennas(right: 60, left: 60) } }
                smallButton("Antennas down") { Task { await body_.antennas(right: 0, left: 0) } }
                smallButton("Wiggle") { Task { await body_.antennas(right: 45, left: -45) } }
            }
            HStack(spacing: 10) {
                Menu {
                    if body_.emotions.isEmpty { Text("Loading emotions…") }
                    ForEach(body_.emotions, id: \.self) { e in
                        Button(e) { Task { await body_.express(e) } }
                    }
                } label: {
                    Label("Emotion", systemImage: "theatermasks")
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .disabled(!body_.hasToken)
                smallButton("Home") { Task { await body_.home() } }
            }
            HStack {
                TextField("Say something…", text: $sayDraft)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit { sendSay() }
                Button("Say") { sendSay() }
                    .disabled(!body_.hasToken || sayDraft.trimmingCharacters(in: .whitespaces).isEmpty || body_.busy)
            }
            stopButton
        }
    }

    private func smallButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!body_.hasToken || body_.busy)
    }

    private func nudge(dp: Double, dy: Double) {
        pitch = max(-BodyCore.reachyMaxPitch, min(BodyCore.reachyMaxPitch, pitch + dp))
        yaw = max(-BodyCore.reachyMaxYaw, min(BodyCore.reachyMaxYaw, yaw + dy))
        let (p, y) = (pitch, yaw)
        Task { await body_.look(pitch: p, yaw: y) }
    }

    private func sendSay() {
        let t = sayDraft
        Task { if await body_.say(t) { sayDraft = "" } }
    }

    private var tokenField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(kind.title) token").font(.subheadline.weight(.semibold))
            Text(kind == .scout
                 ? "Scout's service token (a JWT minted on Thor). It unlocks the camera, telemetry and driving."
                 : "REACHY_TOKEN from the robot's ~/.reachy-dashboard.env. It unlocks the camera, state and moving.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                // A plain field, not SecureField: the secure one summons password
                // AutoFill (Face ID) on focus, which swallowed the paste on build 89.
                // The token is a random 48-char string, not a human password.
                TextField("\(kind.title) token", text: $tokenDraft)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.footnote.monospaced())
                    .accessibilityIdentifier("body-token-\(kind.rawValue)")
                // Universal Clipboard path: copied on the Mac → one tap here.
                Button {
                    if let s = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
                        tokenDraft = s
                        Task { if await body_.saveToken(s) { tokenDraft = "" } }
                    } else {
                        body_.toast = "Clipboard is empty."
                    }
                } label: { Label("Paste", systemImage: "doc.on.clipboard") }
                .accessibilityLabel("Paste token")
                .disabled(body_.tokenChecking)
                Button("Save") {
                    Task { if await body_.saveToken(tokenDraft) { tokenDraft = "" } }
                }
                .disabled(tokenDraft.trimmingCharacters(in: .whitespaces).isEmpty || body_.tokenChecking)
            }
        }
    }
}

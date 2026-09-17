/**
 * 🧠 QBrainLiveScreen — the UNO Q on the phone: vitals, LED matrix, chat handoff.
 *
 *  - `QBrainToolbarButton` owns discovery (`.task(id: sessionToken)` → /api/devices)
 *    and renders nothing without a q-the-brain row, so accounts without the board
 *    never see a button. It also starts/stops the manager's loops so the health
 *    dot on the button is true before anyone taps it (the ArmToolbarButton lesson:
 *    always mount a real view, an empty Group never runs its .task).
 *  - `QBrainLiveScreen` is a sheet: health header, vitals grid, LED composer,
 *    "Ask tiny" (drops a prompt naming the device into the chat composer via
 *    Router.composerDraft so the tiny agent reaches it through use_device),
 *    token paste as the fallback when the tiny session is refused, and honest
 *    error states for offline / mid-boot / simulated.
 */
import SwiftUI

// ── Toolbar button (owns discovery) ─────────────────────────────────────────

struct QBrainToolbarButton: View {
    @Binding var shown: Bool
    let sessionToken: String?
    @ObservedObject private var brain = QBrainManager.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.clear.frame(width: 1, height: 1)
            if brain.device != nil {
                Button {
                    TinyDesign.haptic()
                    shown.toggle()
                } label: {
                    ZStack(alignment: .bottomTrailing) {
                        Image(systemName: "cpu")
                            .font(.system(size: 17, weight: .medium))
                            .frame(width: 30, height: 30)
                        Circle()
                            .fill(QBrainHealthDot.color(brain.health))
                            .frame(width: 7, height: 7)
                            .offset(x: -2, y: -2)
                    }
                    .foregroundStyle(shown ? Color.green : Color.primary)
                }
                .accessibilityLabel("UNO Q board, \(QBrainHealthDot.label(brain.health))")
            }
        }
        .task(id: sessionToken) { await brain.discover(sessionToken: sessionToken) }
        .task(id: brain.device?.id) {
            brain.sceneActive = scenePhase == .active
            // UITestFlags.noDevicePolls: TinyUITests isolates the account-menu
            // first-tap bug from these live ticks.
            if brain.device != nil, !UITestFlags.noDevicePolls { brain.start() } else { brain.stop() }
        }
        .onChange(of: scenePhase) { _, phase in brain.sceneActive = phase == .active }
        .onDisappear { brain.stop() }
    }
}

enum QBrainHealthDot {
    static func color(_ h: QBrainCore.Health) -> Color {
        switch h {
        case .live: return .green
        case .stale: return .orange
        case .offline: return .red
        case .unknown: return .gray
        }
    }
    static func label(_ h: QBrainCore.Health) -> String {
        switch h {
        case .live: return "live"
        case .stale: return "stale"
        case .offline: return "offline"
        case .unknown: return "reaching"
        }
    }
}

// ── The screen ──────────────────────────────────────────────────────────────

struct QBrainLiveScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tinyAccent) private var accent
    @ObservedObject private var brain = QBrainManager.shared
    @ObservedObject private var router = Router.shared
    @State private var tokenDraft = ""
    @State private var ledDraft = ""
    @FocusState private var ledFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if let s = brain.state {
                        if let e = s.error { notice(e, tint: .orange) }
                        if s.isSim { notice("Simulated readings: the dashboard is not reading the board yet.", tint: .orange) }
                        vitals(s)
                        ledComposer(s)
                    } else {
                        waiting
                    }
                    askTiny
                    if !brain.hasToken { tokenField }
                }
                .padding(16)
            }
            .navigationTitle(brain.device?.name ?? "UNO Q")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if let url = brain.device.flatMap({ URL(string: $0.url) }) {
                            Link(destination: url) { Label("Open dashboard", systemImage: "safari") }
                        }
                        if brain.hasToken {
                            Button(role: .destructive) { brain.forgetToken() } label: {
                                Label("Forget token", systemImage: "key.slash")
                            }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("More")
                }
            }
            .overlay(alignment: .top) { QBrainToast(brain: brain) }
        }
    }

    // ── Pieces ──

    private var header: some View {
        HStack(spacing: 10) {
            Circle().fill(QBrainHealthDot.color(brain.health)).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(headline).font(.headline)
                Text(subline).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if brain.streaming {
                Label("live", systemImage: "dot.radiowaves.up.forward")
                    .font(.caption2.weight(.medium)).foregroundStyle(.green)
                    .accessibilityLabel("Live event stream")
            }
        }
    }

    private var headline: String {
        if let s = brain.state, let h = s.hostname { return "\(h) · \(QBrainHealthDot.label(brain.health))" }
        return QBrainHealthDot.label(brain.health)
    }

    private var subline: String {
        if let s = brain.state, let m = s.model { return m }
        return brain.device?.url.replacingOccurrences(of: "https://", with: "") ?? ""
    }

    private var waiting: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch brain.health {
            case .unknown:
                Label("Reaching \(brain.device?.name ?? "the board")…", systemImage: "antenna.radiowaves.left.and.right")
                Text(brain.hasToken
                     ? "The tunnel answers slowly on first contact."
                     : "Sign in to read the board, or paste its owner token below.")
                    .font(.caption).foregroundStyle(.secondary)
            case .offline, .stale:
                Label("No answer from the board.", systemImage: "wifi.exclamationmark")
                Text("Tunnel down, the board is booting, or it is off.").font(.caption).foregroundStyle(.secondary)
            case .live:
                EmptyView()
            }
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

    private func vitals(_ s: QBrainCore.State) -> some View {
        let rows = QBrainCore.readings(s).filter { $0.label != "source" && $0.label != "error" && $0.label != "led" }
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

    private func ledComposer(_ s: QBrainCore.State) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("LED matrix", systemImage: "square.grid.3x3.fill").font(.subheadline.weight(.semibold))
            if let f = s.ledFrame { QBrainMatrixView(frame: f, lit: s.ledApplied != false) }
            if let t = s.ledText, !t.isEmpty {
                Text(s.ledApplied == false ? "Queued, not shown: \(t)" : "Showing: \(t)")
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            if s.ledApplied == false, let e = s.ledError {
                Text(e).font(.caption2).foregroundStyle(.orange)
            }
            HStack(spacing: 8) {
                TextField("Text for the 13×8 matrix", text: $ledDraft)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .focused($ledFocused)
                    .submitLabel(.send)
                    .onSubmit { sendLED() }
                Button { sendLED() } label: {
                    if brain.ledBusy { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                }
                .disabled(brain.ledBusy || QBrainCore.ledText(ledDraft) == nil || !brain.hasToken)
                .accessibilityLabel("Send to LED matrix")
                Button { Task { await brain.clearLED() } } label: { Image(systemName: "xmark.circle").font(.title2) }
                    .disabled(!brain.hasToken)
                    .accessibilityLabel("Clear LED matrix")
            }
            Text("ASCII only, up to \(QBrainCore.ledMaxLength) characters.").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func sendLED() {
        let text = ledDraft
        Task {
            if await brain.sendLED(text) { ledDraft = "" }
        }
    }

    private var askTiny: some View {
        Button {
            let name = brain.device?.name ?? "q-the-brain"
            router.composerDraft = "On the \(name) board (use_device \(name)): "
            TinyDesign.haptic()
            dismiss()
        } label: {
            Label("Ask tiny about this board", systemImage: "text.bubble")
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(.bordered)
        .tint(accent)
    }

    private var tokenField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Owner token").font(.subheadline.weight(.semibold))
            Text("The board did not accept the tiny login. Paste the token from ~/.q/token on the board.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                SecureField("q token", text: $tokenDraft)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                Button("Save") {
                    Task { if await brain.saveToken(tokenDraft) { tokenDraft = "" } }
                }
                .disabled(tokenDraft.trimmingCharacters(in: .whitespaces).isEmpty || brain.tokenChecking)
            }
        }
    }
}

/// The matrix as the dashboard believes it is: one dot per cell, dim when the
/// board reports the frame was not applied (so a preview never claims light
/// that is not there). Pure geometry from `led.frame`; no image involved.
struct QBrainMatrixView: View {
    let frame: [[Int]]
    var lit = true

    var body: some View {
        let cols = frame.first?.count ?? 0
        let rows = frame.count
        GeometryReader { geo in
            let cell = min(geo.size.width / CGFloat(max(cols, 1)), 14)
            let dot = cell * 0.72
            VStack(spacing: cell - dot) {
                ForEach(0..<rows, id: \.self) { r in
                    HStack(spacing: cell - dot) {
                        ForEach(0..<cols, id: \.self) { c in
                            Circle()
                                .fill(frame[r][c] > 0
                                      ? (lit ? Color.orange : Color.orange.opacity(0.35))
                                      : Color.primary.opacity(0.08))
                                .frame(width: dot, height: dot)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: CGFloat(rows) * 14)
        .accessibilityLabel("LED matrix preview, \(frame.flatMap { $0 }.filter { $0 > 0 }.count) of \(rows * cols) lit\(lit ? "" : ", not applied on the board")")
    }
}

/// One line that disappears on its own. Every refusal lands here.
private struct QBrainToast: View {
    @ObservedObject var brain: QBrainManager
    var body: some View {
        if let toast = brain.toast {
            Text(toast)
                .font(.caption.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.red.opacity(0.85), in: Capsule())
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: toast) {
                    try? await Task.sleep(for: .seconds(3))
                    if brain.toast == toast { brain.toast = nil }
                }
        }
    }
}

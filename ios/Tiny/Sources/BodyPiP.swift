/**
 * 🤖 BodyPiPOverlay — Scout's / Reachy's picture-in-picture card, floating over
 * the chat exactly like Fomo's (FomoPiP.swift): live MJPEG with the honest
 * badge, drag → snap to the nearest corner (spring), two sizes, STOP in the
 * strip at every size, expand → the body's full screen (BodyLiveScreen).
 *
 * Several cards can float at once — the owner watches Fomo + Scout + Reachy
 * together — so each body has its own default corner (Fomo top-trailing,
 * Scout bottom-trailing, Reachy bottom-leading) and its own prefs keys
 * (`body.<kind>.pip.*`), and ChatView stacks the cards in a ZStack so each
 * card's GeometryReader spans the same area and only the card itself takes
 * touches.
 *
 * The half size adds a compact pad: Scout = ◀ ▲ ▼ ▶ + lamp (bounded 0.6 s
 * nudges, BodyManager.drive); Reachy = look ◀ ▲ ▼ ▶ + centre (10° a tap).
 * Everything goes through BodyManager, so the dashboards' refusals land in the
 * card's toast verbatim and the token gate (`hasToken`) stays authoritative.
 *
 * Identifiers: body-pip-<kind>, body-pip-<kind>-stop/-size/-expand/-close/-badge.
 */
import SwiftUI

enum BodyPiPPrefs {
    static func key(_ kind: BodyKind, _ what: String) -> String { "body.\(kind.rawValue).pip.\(what)" }

    /// Distinct defaults so three open cards do not land on one another.
    static func defaultCorner(_ kind: BodyKind) -> FomoPiPCorner {
        kind == .scout ? .bottomTrailing : .bottomLeading
    }
    static func corner(_ kind: BodyKind) -> FomoPiPCorner {
        UserDefaults.standard.string(forKey: key(kind, "corner")).flatMap(FomoPiPCorner.init) ?? defaultCorner(kind)
    }
    static func setCorner(_ kind: BodyKind, _ c: FomoPiPCorner) { UserDefaults.standard.set(c.rawValue, forKey: key(kind, "corner")) }
    static func size(_ kind: BodyKind) -> FomoPiPSize {
        UserDefaults.standard.string(forKey: key(kind, "size")).flatMap(FomoPiPSize.init) ?? .thumb
    }
    static func setSize(_ kind: BodyKind, _ s: FomoPiPSize) { UserDefaults.standard.set(s.rawValue, forKey: key(kind, "size")) }
    static func open(_ kind: BodyKind) -> Bool { UserDefaults.standard.bool(forKey: key(kind, "open")) }
    static func setOpen(_ kind: BodyKind, _ on: Bool) { UserDefaults.standard.set(on, forKey: key(kind, "open")) }
}

struct BodyPiPOverlay: View {
    let kind: BodyKind
    @Binding var shown: Bool
    @ObservedObject private var body_: BodyManager
    @State private var corner: FomoPiPCorner
    @State private var size: FomoPiPSize
    @State private var dragOffset: CGSize = .zero
    @State private var full = false
    @State private var pitch = 0.0
    @State private var yaw = 0.0

    init(kind: BodyKind, shown: Binding<Bool>) {
        self.kind = kind
        self._shown = shown
        self._body_ = ObservedObject(wrappedValue: BodyManager.shared(kind))
        self._corner = State(initialValue: BodyPiPPrefs.corner(kind))
        self._size = State(initialValue: BodyPiPPrefs.size(kind))
    }

    private var space: String { "body-pip-\(kind.rawValue)" }

    var body: some View {
        GeometryReader { geo in
            card(width: geo.size.width)
                .offset(dragOffset)
                .gesture(
                    DragGesture(minimumDistance: 6, coordinateSpace: .named(space))
                        .onChanged { dragOffset = $0.translation }
                        .onEnded { v in
                            let c = FomoPiPCorner.nearest(to: v.location, in: geo.size)
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                corner = c
                                dragOffset = .zero
                            }
                            BodyPiPPrefs.setCorner(kind, c)
                            TinyDesign.haptic(.light)
                        }
                )
                .padding(8)
                .padding(.bottom, corner.isTop ? 0 : 72)   // above the composer band
                .frame(width: geo.size.width, height: geo.size.height, alignment: alignment(corner))
        }
        .coordinateSpace(name: space)
        .fullScreenCover(isPresented: $full) { BodyLiveScreen(kind: kind) }
        .onAppear { BodyPiPPrefs.setOpen(kind, true); body_.retainViewer() }
        .onDisappear { body_.releaseViewer() }
        .onChange(of: body_.toast) { _, t in
            guard t != nil else { return }
            Task { try? await Task.sleep(for: .seconds(4)); if body_.toast == t { body_.toast = nil } }
        }
        .animation(.spring(response: 0.3), value: size)
    }

    private func alignment(_ c: FomoPiPCorner) -> Alignment {
        switch c {
        case .topLeading: return .topLeading
        case .topTrailing: return .topTrailing
        case .bottomLeading: return .bottomLeading
        case .bottomTrailing: return .bottomTrailing
        }
    }

    /// Thumb cards share the bottom edge two abreast (Reachy leading, Scout
    /// trailing), so a thumb is half the width minus gutters, capped at Fomo's
    /// 236 pt — 189 pt on a 402 pt phone, 4:3 like the arm's.
    static func picture(size: FomoPiPSize, in width: CGFloat) -> CGSize {
        switch size {
        case .half: return size.picture(in: width)
        case .thumb:
            let w = min(236, max(120, ((width - 24) / 2).rounded(.down)))
            return CGSize(width: w, height: (w * 3 / 4).rounded())
        }
    }

    private func card(width: CGFloat) -> some View {
        let pic = Self.picture(size: size, in: width)
        return VStack(spacing: 0) {
            BodyPicture(kind: kind, compact: true)
                .frame(width: pic.width, height: pic.height)
                .clipped()
                .contentShape(Rectangle())
                .onTapGesture { full = true }
                .overlay(alignment: .top) {
                    if let t = body_.toast {
                        Text(t).font(.caption2.weight(.medium)).foregroundStyle(.white)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(Color.red.opacity(0.85), in: Capsule())
                            .padding(.top, 30)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
            if size == .half { pad }
            strip
        }
        .frame(width: pic.width)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(radius: 12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body-pip-\(kind.rawValue)")
        .accessibilityValue("\(corner.rawValue) \(size.rawValue)")
    }

    // ── Strip: STOP · name · size · expand · close ──────────────────────────

    private var strip: some View {
        HStack(spacing: 10) {
            Button(role: .destructive) {
                TinyDesign.haptic(.heavy)
                Task { await body_.emergencyStop() }
            } label: {
                Image(systemName: "stop.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(Color.red, in: Capsule())
            }
            .disabled(!body_.hasToken)
            .accessibilityLabel("Stop \(kind.title)")
            .accessibilityIdentifier("body-pip-\(kind.rawValue)-stop")
            Text(body_.device?.name ?? kind.title)
                .font(.caption2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if body_.busy { ProgressView().controlSize(.mini) }
            Button { TinyDesign.haptic(); size = size.next; BodyPiPPrefs.setSize(kind, size) } label: {
                Image(systemName: size == .thumb ? "rectangle.expand.vertical" : "rectangle.compress.vertical")
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel(size == .thumb ? "Larger \(kind.title) card" : "Smaller \(kind.title) card")
            .accessibilityIdentifier("body-pip-\(kind.rawValue)-size")
            Button { full = true } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right").foregroundStyle(.secondary)
            }
            .accessibilityLabel("Expand \(kind.title) view")
            .accessibilityIdentifier("body-pip-\(kind.rawValue)-expand")
            Button { shown = false; BodyPiPPrefs.setOpen(kind, false) } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .accessibilityLabel("Close \(kind.title) view")
            .accessibilityIdentifier("body-pip-\(kind.rawValue)-close")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    // ── Compact pad (half size) ─────────────────────────────────────────────

    @ViewBuilder private var pad: some View {
        HStack(spacing: 8) {
            switch kind {
            case .scout:
                padButton("arrow.turn.up.left", "Turn left") { Task { await body_.drive(linear: 0, angular: 0.6) } }
                padButton("arrow.up", "Forward") { Task { await body_.drive(linear: 0.4, angular: 0) } }
                padButton("arrow.down", "Back") { Task { await body_.drive(linear: -0.4, angular: 0) } }
                padButton("arrow.turn.up.right", "Turn right") { Task { await body_.drive(linear: 0, angular: -0.6) } }
                padButton("lightbulb", "Toggle lamp", tint: (body_.scoutState?.lamp ?? false) ? .yellow : .primary) {
                    Task { await body_.lamp(!(body_.scoutState?.lamp ?? false)) }
                }
            case .reachy:
                padButton("arrow.left", "Look left") { nudge(dp: 0, dy: 10) }
                padButton("arrow.up", "Look up") { nudge(dp: 10, dy: 0) }
                padButton("arrow.down", "Look down") { nudge(dp: -10, dy: 0) }
                padButton("arrow.right", "Look right") { nudge(dp: 0, dy: -10) }
                padButton("scope", "Center") { pitch = 0; yaw = 0; Task { await body_.look(pitch: 0, yaw: 0) } }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body-pip-\(kind.rawValue)-pad")
    }

    private func padButton(_ symbol: String, _ label: String, tint: Color = .primary, action: @escaping () -> Void) -> some View {
        Button { TinyDesign.haptic(); action() } label: {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 36)
                .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
        .disabled(!body_.hasToken || body_.busy)
        .accessibilityLabel(label)
    }

    private func nudge(dp: Double, dy: Double) {
        pitch = max(-BodyCore.reachyMaxPitch, min(BodyCore.reachyMaxPitch, pitch + dp))
        yaw = max(-BodyCore.reachyMaxYaw, min(BodyCore.reachyMaxYaw, yaw + dy))
        let (p, y) = (pitch, yaw)
        Task { await body_.look(pitch: p, yaw: y) }
    }
}

/// The picture with the honest badge — "live · 12 fps", "frames · 2 fps"
/// (Scout's polled path), or "no camera". Decodes the manager's JPEG bytes.
struct BodyPicture: View {
    let kind: BodyKind
    var compact = false
    @ObservedObject private var body_: BodyManager

    init(kind: BodyKind, compact: Bool = false) {
        self.kind = kind
        self.compact = compact
        self._body_ = ObservedObject(wrappedValue: BodyManager.shared(kind))
    }

    var body: some View {
        ZStack {
            Rectangle().fill(.black.opacity(0.9))
            if let d = body_.frame, let img = UIImage(data: d) {
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: compact ? .fill : .fit)
                    .accessibilityLabel("\(kind.title) camera")
            } else {
                VStack(spacing: 6) {
                    Image(systemName: body_.hasToken ? "video.slash" : "key")
                        .font(.title3).foregroundStyle(.white.opacity(0.8))
                    Text(emptyLine).font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center).padding(.horizontal, 8)
                }
            }
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 4) {
                Circle().fill(body_.frameAt == nil ? Color.secondary : (body_.streaming ? Color.green : Color.orange))
                    .frame(width: 5, height: 5)
                Text(badgeText).font(.caption2.weight(.medium))
            }
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(.black.opacity(0.6), in: Capsule())
            .foregroundStyle(.white.opacity(0.9))
            .padding(8)
            .accessibilityIdentifier("body-pip-\(kind.rawValue)-badge")
        }
    }

    private var badgeText: String {
        guard body_.frameAt != nil else { return body_.hasToken ? "reaching…" : "no token" }
        let fps = Int(body_.fps.rounded())
        return body_.streaming ? "live · \(fps) fps" : "frames · \(fps) fps"
    }

    private var emptyLine: String {
        if !body_.hasToken { return "Paste \(kind.title)'s token in the full view" }
        if body_.stateAt == nil { return "reaching \(body_.device?.name ?? kind.title)…" }
        return "waiting for a frame…"
    }
}

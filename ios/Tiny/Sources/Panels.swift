/**
 * Panels — Universe / Jobs / Memory / Devices sheets (web-parity pass 5).
 *
 * Mirrors the web's UniverseDrawer, JobsPanel, MemoryPanel and /devices
 * page as native SwiftUI sheets. All data rides the same session-gated
 * /api proxies the web calls (Bearer token = CLI-token flow), except
 * the universe which hits the worker's public /community endpoint.
 */
import SwiftUI
import UserNotifications

// ── Shared row loader state ────────────────────────────────────────────────

enum LoadState { case loading, loaded, failed(String) }

// ── 🌌 Universe ────────────────────────────────────────────────────────────

struct UniverseUser: Identifiable {
    var id: String { login }
    let login: String
    let name: String
    let avatar: String
    /// True total from the worker's SQL COUNT — may exceed tinys.count, which
    /// the payload caps (web "+N more" leans on this same distinction).
    let tinyCount: Int
    let tinys: [String]
}

/// Headline-stat formatter — the byte-for-byte iOS twin of web lib/community
/// `compact()`. 1_880_100 → "1.9M", 45_300 → "45K". Pure + testable: the
/// tier thresholds sit where the tier BELOW would round up past its own
/// ceiling (999_500 → "1.0M", not "1000K"), and a non-finite/≤0 input → "0"
/// (never "NaN"/"-5" on a card). Extracted so the edge cases can be unit-pinned.
enum CommunityFmt {
    static func compact(_ n: Double) -> String {
        guard n.isFinite, n > 0 else { return "0" }
        if n >= 999_950_000 { return String(format: "%.1fB", n / 1_000_000_000) }
        if n >= 999_500 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return "\(Int((n / 1_000).rounded()))K" }
        return "\(Int(n.rounded()))"
    }
}

struct UniverseView: View {
    /// Called when the user taps a tiny — switches the chat surface
    var onPick: (String) -> Void
    /// Session token — the follow probe/toggle is identity-gated (the follower
    /// is always the session user server-side; nil token → buttons stay hidden,
    /// same as the web island when logged out).
    var token: String?
    @Environment(\.dismiss) private var dismiss
    @State private var users: [UniverseUser] = []
    @State private var state: LoadState = .loading
    @State private var query = ""
    /// slug → 0..1 trust (PageRank over public tiny-consults-tiny edges). ⚡
    /// marks a trusted tiny other tinys actually consult (web trust map).
    @State private var trust: [String: Double] = [:]
    @State private var totalMessages = 0.0
    @State private var totalPublicTinys = 0
    /// The builder whose profile sheet is open (nil = none). Tapping a
    /// universe row header opens it — web parity (drawer @login → /@login).
    /// A wrapper (not a bare String) so `.sheet(item:)` has an Identifiable.
    @State private var profileLogin: BuilderLogin?

    /// Case-insensitive match on login, display name, or any tiny's name;
    /// matching users keep only their matching tinys (unless the USER matched)
    private var visibleUsers: [UniverseUser] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return users }
        return users.compactMap { u in
            let userHit = u.login.lowercased().contains(q) || u.name.lowercased().contains(q)
            let tinys = userHit ? u.tinys : u.tinys.filter { $0.lowercased().contains(q) }
            guard !tinys.isEmpty else { return nil }
            return UniverseUser(login: u.login, name: u.name, avatar: u.avatar,
                                tinyCount: userHit ? u.tinyCount : tinys.count, tinys: tinys)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading: ProgressView("Loading the universe…")
                case .failed(let e):
                    ContentUnavailableView {
                        Label("Couldn't load", systemImage: "wifi.slash")
                    } description: {
                        Text(e)
                    } actions: {
                        Button("Retry") { Task { state = .loading; await load() } }
                    }
                case .loaded:
                    List {
                        // Headline stats (web Community header): compact
                        // messages · builders · public tinys.
                        Section {
                            Text(statsLine)
                                .font(.caption).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .listRowBackground(Color.clear)
                        }
                        if visibleUsers.isEmpty {
                            Text("No tinys match “\(query)”.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(visibleUsers) { u in
                            Section { builderCard(u) }
                        }
                    }
                    .refreshable { await load() }
                }
            }
            .searchable(text: $query, prompt: "Search tinys or builders")
            .navigationTitle("Universe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .sheet(item: $profileLogin) { item in
                ProfileView(login: item.login, token: token) { picked in
                    // Picking one of the builder's tinys switches the chat and
                    // closes BOTH the profile sheet and the universe sheet.
                    profileLogin = nil
                    dismiss()
                    onPick(picked)
                }
            }
        }
        .task { await load() }
    }

    /// "1.9M messages · 12 builders · 34 public tinys" — web's header stats.
    private var statsLine: String {
        var parts: [String] = []
        if totalMessages > 0 { parts.append("\(CommunityFmt.compact(totalMessages)) messages") }
        parts.append("\(users.count) builder\(users.count == 1 ? "" : "s")")
        parts.append("\(totalPublicTinys) public tiny\(totalPublicTinys == 1 ? "" : "s")")
        return parts.joined(separator: " · ")
    }

    /// One builder card — avatar/initial, tappable @login → profile, name,
    /// tiny-count chip, and their tinys as chips (⚡ marks trust-ranked tinys).
    /// Web caps the chip list at 8 with a "+N more →" that opens the profile.
    @ViewBuilder
    private func builderCard(_ u: UniverseUser) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { profileLogin = BuilderLogin(login: u.login) } label: {
                HStack(spacing: 10) {
                    AsyncImage(url: URL(string: u.avatar)) { img in
                        img.resizable()
                    } placeholder: {
                        // Initial-letter fallback (web parity when no avatar)
                        Circle().fill(Color.green.opacity(0.15)).overlay(
                            Text(String((u.login.first ?? "?")).uppercased())
                                .font(.headline).foregroundStyle(.green))
                    }
                    .frame(width: 40, height: 40)
                    .clipShape(Circle())
                    VStack(alignment: .leading, spacing: 1) {
                        Text("@\(u.login)").font(.subheadline.weight(.semibold)).foregroundStyle(.green)
                        if !u.name.isEmpty {
                            Text(u.name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer()
                    Text("\(u.tinyCount) tiny\(u.tinyCount == 1 ? "" : "s")")
                        .font(.caption2)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.green.opacity(0.12)))
                        .foregroundStyle(.green)
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            // Default child-merge reads "@alice, Alice Smith, 3 tinys, chevron"
            // — the @ and chevron read awkwardly. Collapse to a natural label
            // + hint (matches the FlowChips treatment below).
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(u.name.isEmpty ? u.login : u.name), \(u.tinyCount) tiny\(u.tinyCount == 1 ? "" : "s")")
            .accessibilityHint("Opens builder profile")

            if u.tinys.isEmpty {
                Text("No public tinys yet").font(.caption).foregroundStyle(.secondary)
            } else {
                // Chips flow — capped at 8 like web, then a "+N more" to profile
                FlowChips(
                    tinys: Array(u.tinys.prefix(8)),
                    trust: trust,
                    overflow: u.tinys.count > 8 ? u.tinys.count - 8 : 0,
                    onPick: { picked in dismiss(); onPick(picked) },
                    onMore: { profileLogin = BuilderLogin(login: u.login) })
            }
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        do {
            // Public endpoint — same one the web drawer fetches. Throw on a
            // non-2xx (worker 5xx carrying a JSON body): res.json() would parse
            // an error body fine, so without the r.ok gate an outage reads as
            // an empty universe (web getCommunity `failed` lesson).
            var req = URLRequest(url: URL(string: "https://plugin.tiny.technology/community?limit=50")!)
            req.timeoutInterval = 20
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200...299).contains(code) else { state = .failed("HTTP \(code)"); return }
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rawUsers = obj["users"] as? [[String: Any]] else {
                state = .failed("Bad response"); return
            }
            users = rawUsers.compactMap { u in
                guard let login = u["login"] as? String else { return nil }
                let tinys = (u["tinys"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
                let count = (u["tinyCount"] as? NSNumber)?.intValue ?? tinys.count
                // Keep builders even if the payload capped their names (count>0),
                // but drop the genuinely tiny-less (web filters on tinys too).
                guard !tinys.isEmpty else { return nil }
                return UniverseUser(login: login,
                                    name: u["name"] as? String ?? "",
                                    avatar: u["avatar"] as? String ?? "",
                                    tinyCount: count, tinys: tinys)
            }
            // Trust map: keep only well-shaped finite 0<v≤1 entries (web guard)
            var t: [String: Double] = [:]
            if let raw = obj["trust"] as? [String: Any] {
                for (k, v) in raw {
                    let n = (v as? NSNumber)?.doubleValue ?? Double("\(v)") ?? 0
                    if !k.isEmpty, n.isFinite, n > 0, n <= 1 { t[k] = n }
                }
            }
            trust = t
            totalMessages = (obj["totalMessages"] as? NSNumber)?.doubleValue ?? 0
            totalPublicTinys = (obj["totalPublicTinys"] as? NSNumber)?.intValue ?? 0
            state = .loaded
        } catch { state = .failed(error.localizedDescription) }
    }
}

/// Wrapping chip row for a builder's tinys — a tiny is a Button (tap → switch
/// chat); ⚡ prefixes trust-ranked tinys (consulted by other tinys, PageRank).
/// A trailing "+N more" chip opens the profile when the list was capped.
private struct FlowChips: View {
    let tinys: [String]
    let trust: [String: Double]
    let overflow: Int
    let onPick: (String) -> Void
    let onMore: () -> Void

    var body: some View {
        // SwiftUI has no native flow layout pre-iOS 16 Layout API; a simple
        // wrapping HStack via a lazy grid keeps chips readable at any width.
        FlexWrap(spacing: 8, lineSpacing: 8) {
            ForEach(tinys, id: \.self) { t in
                Button { onPick(t) } label: {
                    HStack(spacing: 2) {
                        if trust[t] != nil {
                            Image(systemName: "bolt.fill").font(.system(size: 9)).foregroundStyle(.green)
                        }
                        Text("/\(t)").font(.caption2)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Capsule().strokeBorder(Color.green.opacity(0.4), lineWidth: 1))
                    .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(trust[t] != nil ? "\(t), trusted — consulted by other tinys" : t)
            }
            if overflow > 0 {
                Button(action: onMore) {
                    Text("+\(overflow) more").font(.caption2).foregroundStyle(.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Minimal wrapping layout (chips flow to the next line when they run out of
/// width) via the iOS 16+ Layout protocol. Left-aligned, fixed inter-chip and
/// inter-line spacing. Deployment target is iOS 18, so Layout is available.
struct FlexWrap: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineH: CGFloat = 0, maxLineW: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > maxW { x = 0; y += lineH + lineSpacing; lineH = 0 }
            x += s.width + spacing
            lineH = max(lineH, s.height)
            maxLineW = max(maxLineW, x - spacing)
        }
        return CGSize(width: min(maxLineW, maxW), height: y + lineH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxW = bounds.width
        var x: CGFloat = 0, y: CGFloat = 0, lineH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > maxW { x = 0; y += lineH + lineSpacing; lineH = 0 }
            v.place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
                    anchor: .topLeading, proposal: ProposedViewSize(s))
            x += s.width + spacing
            lineH = max(lineH, s.height)
        }
    }
}

// ── Follow button (the user-gesture social edge) ────────────────────────────

/// Native port of web components/FollowButton.tsx. Probes /api/follow?login=
/// once on appear; the button is HIDDEN until a definitive follow-state comes
/// back — self / unknown-builder / logged-out all leave it hidden (no layout
/// flash), exactly like the web island. Tapping toggles via POST {login,action}
/// and the visual state flips ONLY on a confirmed {ok:true} so a failed toggle
/// can't lie about the edge (the follower is always the session user, enforced
/// server-side). See [[tiny-api-contract]] for the /api/follow shapes.
struct FollowButton: View {
    let login: String
    let token: String?

    /// nil = probing/hidden, false = not following, true = following
    @State private var following: Bool?
    @State private var busy = false

    var body: some View {
        Group {
            if let following {
                Button {
                    Task { await toggle(to: !following) }
                } label: {
                    Text(following ? "Following" : "Follow")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(
                            Capsule().fill(following ? Color.clear : Color.green.opacity(0.9))
                        )
                        .overlay(
                            Capsule().strokeBorder(
                                following ? Color.green.opacity(0.5) : Color.clear, lineWidth: 1)
                        )
                        .foregroundStyle(following ? Color.green : Color.black)
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .opacity(busy ? 0.5 : 1)
                .accessibilityLabel(following ? "Following @\(login), tap to unfollow" : "Follow @\(login)")
            }
        }
        .task { await probe() }
    }

    /// Probe follow state. A 401 (logged out), 400 (self), or 404 (unknown
    /// builder) all throw → `following` stays nil → button stays hidden, the
    /// web island's exact behavior. Only a 200 {ok:true, following} shows it.
    private func probe() async {
        guard let token, following == nil else { return }
        guard let d: [String: Any] = try? await Api.get(
            "/api/follow?login=\(login.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? login)",
            token: token),
              d["ok"] as? Bool == true else { return }
        following = d["following"] as? Bool ?? false
    }

    private func toggle(to next: Bool) async {
        guard let token, !busy else { return }
        busy = true
        defer { busy = false }
        let d: [String: Any]? = try? await Api.post(
            "/api/follow", token: token,
            body: ["login": login, "action": next ? "follow" : "unfollow"])
        // Flip only on a confirmed ok — a failed toggle leaves the edge as-is
        if d?["ok"] as? Bool == true { following = next }
    }
}

// ── 👤 Builder profile ──────────────────────────────────────────────────────

/// Identifiable login wrapper so `.sheet(item:)` can carry a bare login.
struct BuilderLogin: Identifiable { var id: String { login }; let login: String }

struct ProfileTiny: Identifiable { var id: String { name }; let name: String; let created: Double? }
struct ProfileToolInfo: Identifiable {
    var id: String { name }
    let name: String
    let desc: String
    /// param name → description. Public by design (tools are shareable
    /// artifacts). The worker may send this as a JSON object or a stringified
    /// JSON — the loader normalizes both (web ProfileToolCard's lesson).
    let params: [String: String]
    /// Source, public by design (tools run in the caller's own sandbox).
    let code: String
    /// >0 → one-time purchase to install (set via set_price, tool:<login>/<name>).
    /// The worker /profile LEFT JOINs the active price; 0/absent for free tools.
    var priceMicro: Int = 0

    /// One-time-install USD label ("$0.50"/"$1.00"), or "" when free. A one-time
    /// install charge is a CHARGE, not a per-message rate, so it goes through the
    /// canonical usd() (Rule B: min-2 fraction digits, up to 6 for sub-cent) —
    /// the SAME formatter the server-side install paywall (app/api/tools/install
    /// → usd()) and the wallet ledger use, so the card's "$X to install" matches
    /// the 402 exactly. The old `%.4f` + strip-trailing-zeros form rendered
    /// "$0.5"/"$1" and even a bare "$0" for a genuinely-nonzero ≤$0.00005 price;
    /// web already switched ProfileToolCard to usd() (its comment at :45-52), and
    /// this closes the same divergence on iOS.
    private static let usdFmt: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 6
        // Pin en_US so money is device-locale-INDEPENDENT ("$0.50", not "0,50 $"),
        // matching web toLocaleString("en-US") + Android Locale.US + the app's
        // other usd() formatters (Wallet.swift:105, Views.swift:3721).
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    var priceLabel: String {
        guard priceMicro > 0 else { return "" }
        return Self.usdFmt.string(from: NSNumber(value: Double(priceMicro) / 1_000_000)) ?? "$0.00"
    }
}

struct BuilderProfile {
    let login: String
    let name: String
    let avatar: String
    let joined: Double?
    let followers: Int
    let tinys: [ProfileTiny]
    /// var: the owner can delete a tool from their own profile (the card's
    /// onDeleted mutates this list in place, web ProfileTools parity).
    var tools: [ProfileToolInfo]
}

/// Builder profile sheet — native port of web components/Profile.tsx. Shows a
/// builder's public face (avatar + name + follower count), their public tinys
/// (tap to switch chat), and their forged tools as expandable cards (params +
/// source, with a one-click install into the signed-in user's own toolbox).
/// Hits the SAME public worker /profile?login= the web server component uses.
/// Distinguishes a genuine not-found (404 / login-less body) from a transient
/// fetch failure (timeout/5xx → calm retry, never "unknown builder") — web's
/// ProfileResult lesson. The FollowButton lives on the header, like web.
struct ProfileView: View {
    let login: String
    let token: String?
    /// Called when the user taps one of the builder's tinys.
    var onPickTiny: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    /// Three-way like web's ProfileResult: nil+loading, .failed (retry),
    /// .loaded(nil) = not-found, .loaded(profile) = ok.
    @State private var state: LoadState = .loading
    @State private var profile: BuilderProfile?
    /// Signed-in viewer's login (one GET /api/me for the whole sheet, web
    /// ProfileTools.tsx parity) — when it matches the profile's login the
    /// tool cards gain a delete action. nil = signed out / fetch failed:
    /// the visitor just doesn't get delete, never an error.
    @State private var viewerLogin: String?

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading: ProgressView("Loading @\(login)…")
                case .failed:
                    // Transient fetch failure — calm retry, NOT a "no such
                    // builder" claim (web ProfileUnavailable's exact lesson).
                    ContentUnavailableView {
                        Label("Couldn't load @\(login)", systemImage: "wifi.slash")
                    } description: {
                        Text("Usually momentary.")
                    } actions: {
                        Button("Try again") { Task { state = .loading; await load() } }
                    }
                case .loaded:
                    if let p = profile { profileBody(p) }
                    else {
                        ContentUnavailableView("No builder @\(login)", systemImage: "person.slash",
                            description: Text("This handle isn't a tiny.technology builder."))
                    }
                }
            }
            .navigationTitle("@\(login)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .task { await load() }
        .task { await loadViewer() }
    }

    private func profileBody(_ p: BuilderProfile) -> some View {
        List {
            Section {
                HStack(spacing: 14) {
                    AsyncImage(url: URL(string: p.avatar)) { img in
                        img.resizable()
                    } placeholder: { Color.gray.opacity(0.3) }
                    .frame(width: 56, height: 56)
                    .clipShape(Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        if !p.name.isEmpty { Text(p.name).font(.headline) }
                        Text("@\(p.login)").font(.subheadline).foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            if let joined = p.joined, let since = joinedStr(joined) {
                                Text("building since \(since)")
                            }
                            if p.followers > 0 {
                                Text("· \(p.followers) follower\(p.followers == 1 ? "" : "s")")
                            }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                // The user-gesture social edge — self/logged-out/unknown all
                // hide it (web parity). Lives on the header now, like web.
                FollowButton(login: p.login, token: token)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Section("\(p.tinys.count) public tiny\(p.tinys.count == 1 ? "" : "s")") {
                if p.tinys.isEmpty {
                    Text("No public tinys yet.").foregroundStyle(.secondary).font(.callout)
                }
                ForEach(p.tinys) { t in
                    Button {
                        onPickTiny(t.name)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("🌱 \(t.name)").foregroundStyle(.primary)
                                if let c = t.created, let since = joinedStr(c, month: true) {
                                    Text("alive since \(since)").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Image(systemName: "bubble.left").font(.caption).foregroundStyle(.green)
                        }
                    }
                    // Default merge reads "seedling foo, alive since …, speech
                    // bubble" — 🌱 and the bubble glyph are decorative. Collapse
                    // to a clean action label (matches builderCard / FlowChips).
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel({
                        if let c = t.created, let since = joinedStr(c, month: true) {
                            return "\(t.name), alive since \(since)"
                        }
                        return t.name
                    }())
                    .accessibilityHint("Opens chat with this tiny")
                }
            }

            Section("\(p.tools.count) forged tool\(p.tools.count == 1 ? "" : "s")") {
                if p.tools.isEmpty {
                    Text("No forged tools yet.").foregroundStyle(.secondary).font(.callout)
                }
                ForEach(p.tools) { t in
                    ProfileToolCard(
                        tool: t, ownerLogin: p.login, token: token,
                        // Case-insensitive like web ProfileTools (logins are
                        // GitHub handles; the worker may echo either case)
                        canDelete: viewerLogin?.lowercased() == p.login.lowercased(),
                        onDeleted: { profile?.tools.removeAll { $0.name == t.name } })
                }
            }
        }
    }

    private func joinedStr(_ ts: Double, month: Bool = false) -> String? {
        guard ts > 0 else { return nil }
        // worker stores seconds (created < 1e12) — mirror web's < 1e12 guard
        let secs = ts < 1e12 ? ts : ts / 1000
        let fmt: Date.FormatStyle = month
            ? .dateTime.month(.abbreviated).year()
            : .dateTime.month(.wide).year()
        return Date(timeIntervalSince1970: secs).formatted(fmt)
    }

    private func load() async {
        // PUBLIC worker endpoint — the same /profile?login= the web server
        // component fetches. A 404 → not-found (.loaded, profile nil); any
        // other failure (timeout/5xx/bad body) → .failed (retry), so an
        // outage never reads as "no such builder".
        guard let enc = login.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "https://plugin.tiny.technology/profile?login=\(enc)") else {
            state = .failed("bad login"); return
        }
        var req = URLRequest(url: url); req.timeoutInterval = 20
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 404 { profile = nil; state = .loaded; return }
            guard (200...299).contains(code),
                  let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let l = obj["login"] as? String else {
                // A login-less body from a 2xx is also a not-found (404 already
                // returned above); a non-2xx is a transient failure. Split them
                // the way web's normalize does.
                if (200...299).contains(code) { profile = nil; state = .loaded }
                else { state = .failed("HTTP \(code)") }
                return
            }
            let tinys = (obj["tinys"] as? [[String: Any]])?.compactMap { t -> ProfileTiny? in
                guard let n = t["name"] as? String else { return nil }
                return ProfileTiny(name: n, created: (t["created"] as? NSNumber)?.doubleValue)
            } ?? []
            let tools = (obj["tools"] as? [[String: Any]])?.compactMap { t -> ProfileToolInfo? in
                guard let n = t["name"] as? String else { return nil }
                return ProfileToolInfo(name: n, desc: t["description"] as? String ?? "",
                                       params: Self.parseParams(t["params"]),
                                       code: t["code"] as? String ?? "",
                                       priceMicro: (t["price_micro"] as? NSNumber)?.intValue ?? 0)
            } ?? []
            profile = BuilderProfile(
                login: l,
                name: obj["name"] as? String ?? "",
                avatar: obj["avatar"] as? String ?? "",
                joined: (obj["joined"] as? NSNumber)?.doubleValue,
                followers: (obj["followers"] as? NSNumber)?.intValue ?? 0,
                tinys: tinys, tools: tools)
            state = .loaded
        } catch { state = .failed(error.localizedDescription) }
    }

    /// One session check for the whole sheet (web ProfileTools.tsx:27-36) —
    /// silent on any failure: signed-out visitors just don't get delete.
    private func loadViewer() async {
        guard token != nil else { return }
        guard let d: [String: Any] = try? await Api.get("/api/me", token: token),
              let u = d["user"] as? [String: Any],
              let l = u["login"] as? String, !l.isEmpty else { return }
        viewerLogin = l
    }

    /// Normalize a tool's `params` whether the worker sends a JSON object or a
    /// stringified JSON blob (web ProfileToolCard parses both). Values are
    /// coerced to their String form; a non-object / unparseable input → [:].
    /// Pure + testable (nonisolated: callable off the MainActor from tests
    /// and from ToolboxView.parseTool).
    nonisolated static func parseParams(_ raw: Any?) -> [String: String] {
        var obj: [String: Any]?
        if let d = raw as? [String: Any] { obj = d }
        else if let s = raw as? String, let data = s.data(using: .utf8) {
            obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        guard let obj else { return [:] }
        var out: [String: String] = [:]
        for (k, v) in obj {
            if let sv = v as? String { out[k] = sv }
            else { out[k] = "\(v)" }
        }
        return out
    }
}

/// Expandable forged-tool card (web components/ProfileToolCard.tsx parity).
/// Tap the header to reveal params + source; "Use this tool" copies it into
/// the signed-in user's own account via POST /api/tools/install {login, name}
/// — the SERVER re-fetches the author's public code and re-validates, so the
/// client sends only login+name (never code). Surfaces {ok, updated}; a nil
/// token (logged out) disables install with a sign-in hint (iOS can't do the
/// web's OAuth round-trip in-place, so it tells the user to sign in).
struct ProfileToolCard: View {
    let tool: ProfileToolInfo
    let ownerLogin: String
    let token: String?
    /// Viewer owns this profile (session-checked upstream, ONE /api/me per
    /// sheet) — the card gains a confirmed delete (web ProfileToolCard parity).
    var canDelete = false
    /// Parent removes the card from its list on a successful delete.
    var onDeleted: (() -> Void)? = nil

    @State private var open = false
    @State private var installing = false
    @State private var status: (ok: Bool, msg: String)?
    @State private var copied = false
    @State private var deleting = false
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { open.toggle() } } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("🔧 \(tool.name)").font(.callout)
                            // Priced tool → one-time purchase to install (web card's
                            // "$X to install" chip). Hidden for free tools.
                            if !tool.priceLabel.isEmpty {
                                Text("\(tool.priceLabel) to install")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Capsule().fill(Color.green.opacity(0.18)))
                                    .foregroundStyle(.green)
                            }
                        }
                        if !tool.desc.isEmpty {
                            Text(tool.desc).font(.caption).foregroundStyle(.secondary)
                                .lineLimit(open ? nil : 1)
                        }
                    }
                    Spacer()
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            // 🔧 and the chevron are decorative — announce the tool name (+ desc)
            // and the expand/collapse affordance, not the glyphs.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel({
                var l = tool.desc.isEmpty ? tool.name : "\(tool.name), \(tool.desc)"
                if !tool.priceLabel.isEmpty { l += ", \(tool.priceLabel) to install" }
                return l
            }())
            .accessibilityHint(open ? "Collapse tool details" : "Expand tool details")

            if open {
                if !tool.params.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Parameters").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(tool.params.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
                            Text("• \(k)\(v.isEmpty ? "" : " — \(v)")")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                if !tool.code.isEmpty {
                    HStack {
                        Text("Source").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        Spacer()
                        // Copy full source (web card's "copy" button)
                        Button {
                            UIPasteboard.general.string = tool.code
                            copied = true
                            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                        } label: {
                            Label(copied ? "copied ✓" : "copy",
                                  systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.caption2)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(copied ? "Copied" : "Copy source code")
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(tool.code)
                            .font(.system(.caption2, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(8)
                    }
                    .frame(maxHeight: 220)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.4)))
                }

                Button {
                    Task { await install() }
                } label: {
                    HStack(spacing: 6) {
                        if installing { ProgressView().controlSize(.small) }
                        Text(installing ? "Installing…"
                             : tool.priceLabel.isEmpty ? "Use this tool" : "Buy · \(tool.priceLabel)")
                            .font(.caption.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(Capsule().fill(Color.green.opacity(token == nil ? 0.3 : 0.9)))
                    .foregroundStyle(.black)
                }
                .buttonStyle(.plain)
                .disabled(installing || token == nil)

                // One-time-charge disclosure (web card footer) — only when priced.
                if !tool.priceLabel.isEmpty {
                    Text("One-time \(tool.priceLabel) charge from your wallet on install.")
                        .font(.caption2).foregroundStyle(.secondary)
                }

                // Owner-only: remove from MY toolbox (installed copies survive
                // — the exact web card message). Confirmed, never one-tap.
                if canDelete {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        HStack(spacing: 6) {
                            if deleting { ProgressView().controlSize(.small) }
                            Label(deleting ? "Deleting…" : "Delete", systemImage: "trash")
                                .font(.caption.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Capsule().stroke(Color.red.opacity(0.5)))
                        .foregroundStyle(.red)
                    }
                    .buttonStyle(.plain)
                    .disabled(deleting)
                    .accessibilityLabel("Delete my_\(tool.name)")
                    .confirmationDialog(
                        "Delete my_\(tool.name)?",
                        isPresented: $confirmDelete, titleVisibility: .visible
                    ) {
                        Button("Delete", role: .destructive) { Task { await remove() } }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Anyone who already installed a copy keeps theirs. This removes it from your toolbox.")
                    }
                }

                if let status {
                    Text(status.msg)
                        .font(.caption2)
                        .foregroundStyle(status.ok ? .green : .red)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func install() async {
        guard let token else {
            status = (false, "Sign in to install this tool."); return
        }
        guard !installing else { return }
        installing = true
        status = nil
        defer { installing = false }
        // Server re-fetches the author's public code + re-validates — the
        // client sends only login+name. Use postBody (NOT Api.post, which
        // throws on non-2xx): a priced tool answers 402 { payment_required,
        // error } with the price + wallet balance the user must see — throwing
        // that away would render the paywall as a generic "install failed".
        // {ok:true} → added/updated; 402 → paywall message + wallet pointer.
        let d = await Api.postBody(
            "/api/tools/install", token: token,
            body: ["login": ownerLogin, "name": tool.name])
        if d?["ok"] as? Bool == true {
            let updated = d?["updated"] as? Bool ?? false
            let n = d?["name"] as? String ?? tool.name
            status = (true, updated
                      ? "Updated my_\(n) — already in your toolbox."
                      : "Added! Ask any of your tinys to use my_\(n).")
        } else if (d?["payment_required"] as? Bool) == true {
            // The API message already names the price + balance; point at /wallet.
            let msg = (d?["error"] as? String) ?? "Payment required to install."
            status = (false, "\(msg) → tiny.technology/wallet")
        } else {
            status = (false, (d?["error"] as? String) ?? "Install failed — try again.")
        }
    }

    /// DELETE /api/tools {name} — the worker strips a my_ prefix server-side
    /// and 404s a missing tool (already gone → still remove the card).
    private func remove() async {
        guard let token, !deleting else { return }
        deleting = true
        status = nil
        defer { deleting = false }
        do {
            let d = try await Api.deleteJson("/api/tools", token: token, body: ["name": tool.name])
            if d["ok"] as? Bool == true { onDeleted?() }
            else { status = (false, (d["error"] as? String) ?? "Couldn't delete — try again.") }
        } catch ApiError.http(404, _) {
            // Already deleted elsewhere — the card is stale, drop it.
            onDeleted?()
        } catch {
            status = (false, error.localizedDescription)
        }
    }
}

// ── 🛠️ Toolbox (my forged tools) ───────────────────────────────────────────

/// One forged tool owned by the signed-in account (a GET /api/tools row).
/// `name` is the unprefixed slug — agents call it my_<name>, so displays
/// add the prefix (web Control.tsx renders my_{t.name} the same way).
struct ForgedTool: Identifiable {
    var id: String { name }
    let name: String
    let desc: String
    let params: [String: String]
    let code: String
    let created: Date?
}

/// 🛠️ My Forged Tools — native port of the web Control panel's account-level
/// tool box (components/chat/Control.tsx "My Forged Tools") with the profile
/// card's expandable detail. GET /api/tools with the session token; a failed
/// load (401/424/network) is NEVER painted as "no tools yet" (the web panel's
/// myToolsFailed lesson). Rows expand to params + source (+copy); delete via
/// swipe OR the explicit button, both confirmed, DELETE /api/tools {name}
/// with optimistic removal + restore-on-failure. "N/20" mirrors the worker's
/// per-account cap.
struct ToolboxView: View {
    let token: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tinyAccent) private var accent

    @State private var tools: [ForgedTool] = []
    @State private var state: LoadState = .loading
    /// Row awaiting the destructive confirm (JobsPanel danger-confirm parity)
    @State private var pendingDelete: ForgedTool?
    /// A failed delete restored the row — tell the user why it's back.
    @State private var deleteError: String?

    var body: some View {
        NavigationStack {
            Group {
                if token == nil {
                    // Signed out — not an outage, not "empty" (web gates the
                    // whole panel behind me.authenticated)
                    ContentUnavailableView("Sign in to see your forged tools",
                        systemImage: "person.crop.circle.badge.questionmark",
                        description: Text("Tools live on your account and follow you across all your tinys."))
                } else {
                    switch state {
                    case .loading: ProgressView("Loading tools…")
                    case .failed(let e):
                        ContentUnavailableView {
                            Label("Couldn't load your tools", systemImage: "wifi.slash")
                        } description: {
                            Text(e)
                        } actions: {
                            Button("Retry") { Task { state = .loading; await load() } }
                        }
                    case .loaded:
                        if tools.isEmpty {
                            ContentUnavailableView {
                                Label("Nothing forged yet", systemImage: "hammer")
                            } description: {
                                Text("Ask any tiny to create a tool —\n\"make me a tool that …\" — or install one from a builder profile.")
                            } actions: {
                                Button("Refresh") { Task { state = .loading; await load() } }
                            }
                        } else {
                            List {
                                Section {
                                    ForEach(tools) { t in
                                        ToolboxRow(tool: t, accent: accent) { pendingDelete = t }
                                            .swipeActions {
                                                Button(role: .destructive) { pendingDelete = t } label: {
                                                    Label("Delete", systemImage: "trash")
                                                }
                                            }
                                    }
                                } header: {
                                    // The worker caps forged tools at 20/account
                                    Text("\(tools.count)/20 forged tools")
                                } footer: {
                                    Text("Tools follow your account across all your tinys as my_<name>. They're public on your profile.")
                                }
                            }
                            .refreshable { await load() }
                        }
                    }
                }
            }
            .navigationTitle("Toolbox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .confirmationDialog(
                "Delete my_\(pendingDelete?.name ?? "tool")?",
                isPresented: Binding(get: { pendingDelete != nil },
                                     set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { tool in
                Button("Delete", role: .destructive) { Task { await remove(tool) } }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Your tinys lose this tool immediately. Anyone who installed a copy keeps theirs.")
            }
            .alert("Couldn't delete", isPresented: Binding(
                get: { deleteError != nil },
                set: { if !$0 { deleteError = nil } })
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(deleteError ?? "")
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard token != nil else { return }
        do {
            let d: [String: Any] = try await Api.get("/api/tools", token: token)
            // ok:false from a 2xx would be a proxy quirk — treat as failure,
            // never as an empty toolbox (web's `if (d.ok)` branch).
            guard d["ok"] as? Bool == true, let raw = d["tools"] as? [[String: Any]] else {
                state = .failed((d["error"] as? String) ?? "Couldn't load — check connection")
                return
            }
            tools = raw.compactMap { Self.parseTool($0) }
            state = .loaded
        } catch ApiError.http(401, _) {
            state = .failed("Sign in to see your forged tools (HTTP 401)")
        } catch {
            // 424 (worker outage) arrives as ApiError.http(424) → the friendly
            // "backend unavailable" line; plain network errors read as-is.
            state = .failed(error.localizedDescription)
        }
    }

    /// Optimistic remove — the row disappears immediately; a failed DELETE
    /// restores the exact prior list and explains itself. A 404 means the
    /// tool was already gone server-side: keep it removed.
    private func remove(_ tool: ForgedTool) async {
        let snapshot = tools
        tools.removeAll { $0.name == tool.name }
        do {
            let d = try await Api.deleteJson("/api/tools", token: token, body: ["name": tool.name])
            if d["ok"] as? Bool != true {
                tools = snapshot
                deleteError = (d["error"] as? String) ?? "Couldn't delete — try again."
            }
        } catch ApiError.http(404, _) {
            // already gone — the optimistic removal was right
        } catch {
            tools = snapshot
            deleteError = error.localizedDescription
        }
    }

    /// One /api/tools row → ForgedTool. Drops nameless rows; params normalize
    /// through ProfileView.parseParams (object or stringified JSON). Pure —
    /// nonisolated so tests can call it off the MainActor (View statics are
    /// MainActor-isolated by conformance; the inner flatMap closure trapped
    /// dispatch_assert_queue under Swift Testing's global executor otherwise).
    nonisolated static func parseTool(_ t: [String: Any]) -> ForgedTool? {
        guard let n = t["name"] as? String, !n.isEmpty else { return nil }
        return ForgedTool(
            name: n,
            desc: t["description"] as? String ?? "",
            params: ProfileView.parseParams(t["params"]),
            code: t["code"] as? String ?? "",
            created: (t["created"] as? NSNumber).flatMap { Self.createdDate($0.doubleValue) })
    }

    /// Worker stores seconds; anything ≥1e12 is milliseconds (the same <1e12
    /// guard web + ProfileView.joinedStr use). ≤0 → nil (no date row). Pure.
    nonisolated static func createdDate(_ ts: Double) -> Date? {
        guard ts > 0 else { return nil }
        return Date(timeIntervalSince1970: ts < 1e12 ? ts : ts / 1000)
    }
}

/// One expandable toolbox row — header (my_<name> + description + forged
/// date), expands to params + monospace source with copy, plus an explicit
/// delete affordance (the swipe action's discoverable twin).
private struct ToolboxRow: View {
    let tool: ForgedTool
    let accent: Color
    /// Parent owns the list + the confirm dialog — this just asks.
    let onDelete: () -> Void

    @State private var open = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { open.toggle() } } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("my_\(tool.name)")
                            .font(.system(.callout, design: .monospaced).weight(.semibold))
                            .foregroundStyle(accent)
                        if !tool.desc.isEmpty {
                            Text(tool.desc).font(.caption).foregroundStyle(.secondary)
                                .lineLimit(open ? nil : 1)
                        }
                        if let c = tool.created {
                            Text("forged \(c.formatted(date: .abbreviated, time: .omitted))")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    Spacer()
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            // Chevron is decorative — announce name + description + the
            // expand/collapse affordance (ProfileToolCard convention).
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(tool.desc.isEmpty ? "my_\(tool.name)" : "my_\(tool.name), \(tool.desc)")
            .accessibilityHint(open ? "Collapse tool details" : "Expand tool details")

            if open {
                if !tool.params.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Parameters").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(tool.params.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
                            Text("• \(k)\(v.isEmpty ? "" : " — \(v)")")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                if !tool.code.isEmpty {
                    HStack {
                        Text("Source").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        Spacer()
                        Button {
                            UIPasteboard.general.string = tool.code
                            copied = true
                            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                        } label: {
                            Label(copied ? "copied ✓" : "copy",
                                  systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.caption2)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(copied ? "Copied" : "Copy source code")
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(tool.code)
                            .font(.system(.caption2, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(8)
                    }
                    .frame(maxHeight: 220)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.4)))
                }
                // Explicit delete — the swipe action's visible twin (parent
                // shows the confirm; nothing is one-tap destructive).
                Button(role: .destructive) { onDelete() } label: {
                    Label("Delete", systemImage: "trash")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Capsule().stroke(Color.red.opacity(0.5)))
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Delete my_\(tool.name)")
            }
        }
        .padding(.vertical, 4)
    }
}

// ── ⏰ Jobs ────────────────────────────────────────────────────────────────

struct JobRow: Identifiable {
    let id: String
    let name: String
    let cadence: String
    let enabled: Bool
    let fireCount: Int
    let lastFired: Date?
}

/// One row of a job's run history (worker job_runs: ✓/✗ + 300-char preview).
struct JobRun: Identifiable {
    let id = UUID()
    let jobId: String
    let started: String
    let ok: Bool
    let preview: String
}

struct LocalAlert: Identifiable {
    let id: String
    let title: String
    let fires: Date?
}

struct JobsView: View {
    let token: String?
    @Environment(\.dismiss) private var dismiss
    @State private var jobs: [JobRow] = []
    /// Run history, grouped per job in render — fetched-but-dropped before
    /// this (web JobsPanel shows it; a loop you can't observe isn't a loop).
    @State private var runs: [JobRun] = []
    @State private var state: LoadState = .loading
    /// Agent-set local alarms on THIS device (schedule_alert tool) — the
    /// remote-controlled feature earns an audit surface
    @State private var localAlerts: [LocalAlert] = []
    /// Swipe-delete of a server job is irreversible (drops the job AND its run
    /// history) — web gates it behind a danger confirm (JobsPanel.tsx:168).
    /// Hold the row here until the user confirms. (Device-local schedule_alert
    /// cancels stay instant — web treats those the same: no server history.)
    @State private var pendingDelete: JobRow?

    var body: some View {
        NavigationStack {
            Group {
                // The nice onboarding empty state only when there's genuinely
                // nothing on EITHER surface (server loaded clean + no local
                // alerts). Otherwise a List so device-local agent alerts — which
                // need no network — stay visible and cancellable even when the
                // SERVER jobs fetch fails; folding them under the state switch
                // (as before) hid them behind "Couldn't load" on any outage,
                // stranding an alarm the user can only manage here. Mirrors
                // MemoryView, whose local section sits outside its state switch.
                if case .loaded = state, jobs.isEmpty, localAlerts.isEmpty {
                    ContentUnavailableView("No scheduled jobs", systemImage: "clock",
                        description: Text("Ask your tiny to schedule something —\n\"remind me every morning at 9\""))
                } else {
                    List {
                        localAlertsSection
                        Section("☁️ Scheduled jobs") {
                            switch state {
                            case .loading: ProgressView()
                            case .failed(let e):
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(e).font(.caption).foregroundStyle(.secondary)
                                    Button("Retry") { Task { state = .loading; await load() } }
                                        .font(.caption).buttonStyle(.bordered)
                                }
                            case .loaded:
                                if jobs.isEmpty {
                                    Text("No server jobs").font(.caption).foregroundStyle(.secondary)
                                } else {
                                    ForEach(jobs) { j in
                                        VStack(alignment: .leading, spacing: 4) {
                                            HStack {
                                                StatusDot(on: j.enabled, onLabel: "enabled", offLabel: "paused")
                                                Text(j.name).fontWeight(.medium)
                                                Spacer()
                                                Text(j.cadence).font(.caption).foregroundStyle(.green)
                                            }
                                            HStack {
                                                Text("fired \(j.fireCount)×").font(.caption2).foregroundStyle(.secondary)
                                                if let lf = j.lastFired {
                                                    Text("· last \(lf.formatted(.relative(presentation: .named)))")
                                                        .font(.caption2).foregroundStyle(.secondary)
                                                }
                                            }
                                            // Last runs, newest first — ✓/✗ + result preview.
                                            ForEach(runs.filter { $0.jobId == j.id }.prefix(3)) { r in
                                                HStack(alignment: .top, spacing: 4) {
                                                    Text(r.ok ? "✓" : "✗")
                                                        .font(.caption2)
                                                        .foregroundStyle(r.ok ? Color.green : Color.red)
                                                    Text(r.preview.isEmpty ? (r.ok ? "ok" : "error") : r.preview)
                                                        .font(.caption2).foregroundStyle(.secondary)
                                                        .lineLimit(2)
                                                }
                                            }
                                        }
                                        .swipeActions {
                                            Button(role: .destructive) { pendingDelete = j } label: {
                                                Label("Delete", systemImage: "trash")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .refreshable { await loadLocalAlerts(); await load() }
                }
            }
            .navigationTitle("Jobs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .confirmationDialog(
                "Delete “\(pendingDelete?.name ?? "job")”?",
                isPresented: Binding(get: { pendingDelete != nil },
                                     set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { job in
                Button("Delete", role: .destructive) { Task { await remove(job.id) } }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("This job and its run history will be permanently deleted.")
            }
        }
        .task {
            await loadLocalAlerts()
            await load()
        }
    }

    /// Pending schedule_alert notifications (agent-alert-* only)
    @ViewBuilder
    private var localAlertsSection: some View {
        if !localAlerts.isEmpty {
            Section("⏰ On this device (agent alerts)") {
                ForEach(localAlerts) { a in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a.title).fontWeight(.medium)
                        if let f = a.fires {
                            Text("fires \(f.formatted(.relative(presentation: .named)))")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            UNUserNotificationCenter.current()
                                .removePendingNotificationRequests(withIdentifiers: [a.id])
                            localAlerts.removeAll { $0.id == a.id }
                        } label: {
                            Label("Cancel", systemImage: "trash")
                        }
                    }
                }
            }
        }
    }

    private func loadLocalAlerts() async {
        let pending = await UNUserNotificationCenter.current().pendingNotificationRequests()
        localAlerts = pending
            .filter { $0.identifier.hasPrefix("agent-alert-") }
            .map { req in
                LocalAlert(id: req.identifier,
                           title: req.content.title,
                           fires: (req.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate())
            }
            .sorted { ($0.fires ?? .distantFuture) < ($1.fires ?? .distantFuture) }
    }

    /// Same cadence phrasing as the web's JobsPanel
    private static func cadence(schedule: String?, runAt: Double?, fired: Int, enabled: Bool) -> String {
        if let s = schedule {
            // every-N-minutes/hours DSL (string parse; see worker scheduler.ts)
            if s.hasPrefix("*/"), let unit = s.last, unit == "m" || unit == "h" {
                let n = s.dropFirst(2).dropLast()
                if !n.isEmpty, n.allSatisfy(\.isNumber) {
                    return "every \(n)\(unit == "m" ? " min" : " hr")"
                }
            }
            if s.hasPrefix("daily@") { return "daily at \(s.dropFirst(6)) UTC" }
            return s
        }
        if let r = runAt {
            let done = fired > 0 || !enabled
            let dt = Date(timeIntervalSince1970: r).formatted(date: .abbreviated, time: .shortened)
            return "\(done ? "ran" : "once at") \(dt)"
        }
        return "?"
    }

    private func load() async {
        guard let d: [String: Any] = try? await Api.get("/api/jobs", token: token) else {
            state = .failed("Login required or network error"); return
        }
        let raw = d["jobs"] as? [[String: Any]] ?? []
        jobs = raw.compactMap { j in
            guard let id = j["id"] as? String else { return nil }
            let enabled = (j["enabled"] as? Int ?? 0) == 1
            let fired = j["fire_count"] as? Int ?? 0
            return JobRow(
                id: id,
                name: j["name"] as? String ?? "job",
                cadence: Self.cadence(schedule: j["schedule"] as? String,
                                      runAt: (j["run_at"] as? NSNumber)?.doubleValue,
                                      fired: fired, enabled: enabled),
                enabled: enabled,
                fireCount: fired,
                lastFired: (j["last_fired_at"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) })
        }
        // job_runs come newest-first (worker ORDER BY id DESC LIMIT 30).
        runs = (d["runs"] as? [[String: Any]] ?? []).compactMap { r in
            guard let jobId = r["job_id"] as? String else { return nil }
            return JobRun(
                jobId: jobId,
                started: (r["started"] as? String) ?? String(describing: r["started"] ?? ""),
                ok: (r["status"] as? String) == "ok",
                preview: r["result_preview"] as? String ?? "")
        }
        state = .loaded
    }

    private func remove(_ id: String) async {
        var req = URLRequest(url: URL(string: Api.base + "/api/jobs")!)
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["id": id])
        _ = try? await URLSession.shared.data(for: req)
        await load()
    }
}

// ── 🧠 Memory ──────────────────────────────────────────────────────────────

/// Which asset harness a launch is arming for the memory LIST sheet, as a pure
/// decision over the argument list so it can be unit-pinned. Deliberately the
/// twin of `GraphHarness` — two flags, same split, same reasoning:
///  - `--memory-list-harness` substitutes the dataset AND auto-opens the sheet.
///    Right for a still, where the sheet is the whole frame.
///  - `--memory-dataset-harness` substitutes the dataset and opens NOTHING.
///    Right for an app preview, where the cut opens on the chat hero and a
///    driver taps its way here; auto-opening would put the sheet on screen
///    during beat 1 and swallow the driver's first tap.
///
/// ⚠️ Why this exists: `GraphHarness` was built (c28–c30) because the GRAPH
/// sheet drew the user's real facts. The sheet *beside* it draws the same facts
/// as a legible LIST and was never given a harness — so all four video encodes
/// spend ≈3–8s on ungated account data (c54), and no check could clear that
/// beat because there was no known dataset to compare against.
///
/// 🔑 **The graph sheet got a harness BECAUSE it leaked, and nothing
/// generalised the lesson to the sheet beside it.**
///
/// ⚠️⚠️ This sheet renders **TWO** ungated sources, not one: `/api/learnings`
/// AND the on-device `Continuity.memories(tiny)` section above it. A harness
/// that substituted only the network fetch would leave the local half live and
/// still be described as "the memory harness" — the exact shape of the c54
/// defect, one layer down. Both are substituted here, and a test asserts it.
enum MemoryHarness {
    static let sheetFlag = "--memory-list-harness"
    static let datasetFlag = "--memory-dataset-harness"

    /// Substitute the demo dataset for the user's real memories? Either flag.
    static func usesDemoDataset(arguments: [String]) -> Bool {
        arguments.contains(sheetFlag) || arguments.contains(datasetFlag)
    }

    /// Auto-present the Memory sheet on appear? ONLY the stills flag.
    static func autoOpensSheet(arguments: [String]) -> Bool {
        arguments.contains(sheetFlag)
    }

    #if DEBUG
    /// The harness dataset, deliberately the SAME persona as the graph harness's
    /// (a baking tiny). A video cut walks list → graph in one continuous shot,
    /// so two unrelated demo datasets would make the app look like it forgot
    /// everything between two taps — the opposite of the claim the beat makes.
    ///
    /// Every row is something the `learn` tool genuinely stores, and the mix is
    /// chosen to exercise the view's channels rather than to look tidy:
    ///  - three `closed` rows, so the archived `StatusDot` has a referent on
    ///    screen (all-live rows render the dot in ONE state and quietly hide
    ///    half of what the frame claims — the same reason the graph harness
    ///    needs History ON for its grey nodes);
    ///  - fixed ids and no clock reads, since `Date()` would vary the frame run
    ///    to run and defeat the reference comparison the per-beat check is built
    ///    on;
    ///  - one row long enough to WRAP, because real learnings wrap and a set of
    ///    uniformly short ones would not prove the layout handles it.
    ///
    /// It lives on this enum rather than on `MemoryView` because the view is
    /// `@MainActor`-isolated, and a dataset a plain test cannot read is a
    /// dataset nothing pins.
    static func serverWire() -> [[String: Any]] {
        let live = [
            "Bakes sourdough every Sunday morning",
            "Keeps a rye starter named Bubbles, fed Saturday night",
            "Kitchen runs cold — proofs in the oven with the light on",
            "Prefers 78% hydration for an open crumb",
            "Dutch oven preheats 45 min at 250°C",
            "Scores a single long slash, never a cross",
            "Bread flour from the mill on Grand St",
            "Sunday bake has to be out of the oven by 11, because the market stall opens at noon",
            "Learning to shape baguettes, still tearing the skin",
        ]
        let closed = [
            "Proofed on the counter (superseded — kitchen too cold)",
            "Used 65% hydration (superseded — wanted a more open crumb)",
            "Fed the starter every morning (superseded — Saturdays only)",
        ]
        var wire: [[String: Any]] = []
        for (i, c) in live.enumerated() {
            wire.append(["id": NSNumber(value: 100 + i), "content": c, "freshness": "live"])
        }
        for (i, c) in closed.enumerated() {
            wire.append(["id": NSNumber(value: 200 + i), "content": c, "freshness": "closed"])
        }
        return wire
    }

    /// The on-device half. It exists because this sheet has TWO ungated sources,
    /// and a harness for one of them is not a harness for the sheet.
    static func localEntries() -> [MemoryEntry] {
        let t0 = 1_753_000_000_000.0  // ms, fixed — a live clock varies the shot
        return [
            MemoryEntry(id: "h1", content: "Calls the starter \"she\"", tags: nil, ts: t0),
            MemoryEntry(id: "h2", content: "Wants gram weights, never cups",
                        tags: nil, ts: t0 + 3_600_000),
        ]
    }
    #endif
}

struct MemoryView: View {
    let token: String?
    let tiny: String
    @Environment(\.dismiss) private var dismiss
    @State private var server: [(id: String, content: String, live: Bool)] = []
    @State private var local: [MemoryEntry] = []
    @State private var state: LoadState = .loading
    @State private var forgetError: String?
    @State private var showGraph = false

    var body: some View {
        NavigationStack {
            List {
                if !local.isEmpty {
                    Section("📱 On this phone (remember tool)") {
                        ForEach(local) { m in
                            Text(m.content).font(.subheadline)
                                .swipeActions {
                                    Button(role: .destructive) {
                                        Continuity.forgetMemory(tiny, m.id)
                                        local = Continuity.memories(tiny)
                                    } label: { Label("Forget", systemImage: "trash") }
                                }
                        }
                    }
                }
                Section("☁️ Server learnings (learn tool)") {
                    if let e = forgetError {
                        Text(e).font(.caption).foregroundStyle(.red)
                    }
                    switch state {
                    case .loading: ProgressView()
                    case .failed(let e):
                        // Was a dead end — grey caption, no way out but the
                        // non-obvious pull-to-refresh. Give it the Retry the
                        // sibling panels (Universe/Jobs/Devices) all have.
                        VStack(alignment: .leading, spacing: 6) {
                            Text(e).font(.caption).foregroundStyle(.secondary)
                            Button("Retry") { Task { state = .loading; await load() } }
                                .font(.caption).buttonStyle(.bordered)
                        }
                    case .loaded:
                        if server.isEmpty {
                            Text("No server memories yet").font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(server, id: \.id) { m in
                            HStack(alignment: .top, spacing: 8) {
                                StatusDot(on: m.live, onLabel: "live", offLabel: "archived")
                                Text(m.content).font(.subheadline)
                            }
                            .swipeActions {
                                Button(role: .destructive) { Task { await forget(m.id) } } label: {
                                    Label("Forget", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            }
            .refreshable {
                forgetError = nil
                local = Continuity.memories(tiny)
                await load()
            }
            .navigationTitle("Memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showGraph = true } label: { Label("Graph", systemImage: "point.3.connected.trianglepath.dotted") }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .sheet(isPresented: $showGraph) { MemoryGraphView(token: token) }
        }
        .task {
            #if DEBUG
            // 🧠 Asset harness — see MemoryHarness. BOTH sources are substituted:
            // the local section is read straight off disk here, so gating only
            // `load()` would leave the user's real on-device memories on screen.
            if MemoryHarness.usesDemoDataset(arguments: ProcessInfo.processInfo.arguments) {
                local = MemoryHarness.localEntries()
                await load()
                return
            }
            #endif
            local = Continuity.memories(tiny)
            await load()
        }
    }

    private func load() async {
        #if DEBUG
        // 🧠 Screenshot/video harness (`--memory-list-harness`, DEBUG only).
        //
        // Why it exists: this list draws the SIGNED-IN USER'S OWN learnings at
        // body-text size — more legible in a 1080×1920 Reel than the graph ever
        // was, because a list is meant to be read. The graph beat got a harness
        // in c28–c30 after exactly this defect; c54 found the list beside it had
        // never been looked at, in any of the four shipped encodes.
        //
        // It is HONEST about what it demonstrates. Only the DATASET is chosen:
        // the rows, the live/archived StatusDot, the section headers, the swipe
        // actions and the empty/failed states are all the shipping view on the
        // shipping code path, with different words in it. The wire dictionaries
        // go through the SAME decode below as a real response, so a dataset the
        // API could not return cannot sneak in here.
        if MemoryHarness.usesDemoDataset(arguments: ProcessInfo.processInfo.arguments) {
            server = Self.decodeLearnings(MemoryHarness.serverWire())
            state = .loaded
            return
        }
        #endif
        guard let d: [String: Any] = try? await Api.get("/api/learnings?limit=200", token: token) else {
            state = .failed("Login required or network error"); return
        }
        server = Self.decodeLearnings(d["learnings"] as? [[String: Any]] ?? [])
        state = .loaded
    }

    /// Wire → rows. Extracted so the harness dataset is decoded by the SAME code
    /// as a real response — the graph harness's rule (`parseNode`/`parseEdge`)
    /// applied here: a harness that hand-builds its rows can render a shape the
    /// server cannot produce, and then the capture is not evidence about the app.
    nonisolated static func decodeLearnings(
        _ raw: [[String: Any]]
    ) -> [(id: String, content: String, live: Bool)] {
        raw.compactMap { l in
            guard let content = l["content"] as? String else { return nil }
            let id = (l["id"] as? NSNumber)?.stringValue ?? (l["id"] as? String) ?? UUID().uuidString
            let live = (l["freshness"] as? String ?? "live") == "live"
            return (id: id, content: content, live: live)
        }
    }

    private func forget(_ id: String) async {
        var req = URLRequest(url: URL(string: Api.base + "/api/learnings")!)
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["id": id])
        // Reload server truth either way (never optimistic-drop — a failed delete
        // would otherwise vanish a memory that's still ALIVE on the server, a
        // false "forgotten" the user would trust; android hit exactly that in
        // 0c1d885). But a swallowed failure meant the row silently reappeared
        // with no explanation — surface it so the user knows to retry.
        let ok: Bool
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           let code = (resp as? HTTPURLResponse)?.statusCode {
            ok = code < 400
        } else {
            ok = false
        }
        await load()
        forgetError = ok ? nil : "Couldn't forget that — try again."
    }
}

// ── 📱 Devices ─────────────────────────────────────────────────────────────

struct DeviceRow: Identifiable {
    let id: String
    let name: String
    let kind: String
    let online: Bool
    let lastSeen: Date?
    /// Parsed from the wire's JSON *string* — drives whether a camera is drawn.
    var capabilities: [String] = []

    /// An endpoint device is a robot at its own authenticated API (printer, rover),
    /// not something that heartbeats to us. Only these get a live panel.
    var isEndpoint: Bool { kind == "endpoint" }
}

struct DevicesView: View {
    let token: String?
    let myDeviceId: String?
    @Environment(\.dismiss) private var dismiss
    @State private var devices: [DeviceRow] = []
    @State private var state: LoadState = .loading
    /// Revoking a device kills its token instantly (web app/devices parity) —
    /// irreversible, so hold the row behind a danger confirm. NEVER offered for
    /// THIS phone: revoking our own token signs the app out from under itself.
    @State private var pendingRevoke: DeviceRow?
    @State private var revokeError: String?

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading: ProgressView("Loading devices…")
                case .failed(let e):
                    ContentUnavailableView {
                        Label("Couldn't load", systemImage: "iphone.slash")
                    } description: {
                        Text(e)
                    } actions: {
                        Button("Retry") { Task { state = .loading; await load() } }
                    }
                case .loaded:
                    List {
                        if let e = revokeError {
                            Text(e).font(.caption).foregroundStyle(.red)
                        }
                        ForEach(devices) { d in
                            VStack(alignment: .leading, spacing: 0) {
                                HStack {
                                    StatusDot(on: d.online, onLabel: "online", offLabel: "offline")
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text(d.name).fontWeight(.medium)
                                            if d.id == myDeviceId {
                                                Text("this phone").font(.caption2)
                                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                                    .background(.green.opacity(0.15), in: Capsule())
                                                    .foregroundStyle(.green)
                                            }
                                        }
                                        HStack(spacing: 4) {
                                            Text(d.kind).font(.caption2).foregroundStyle(.secondary)
                                            if let ls = d.lastSeen {
                                                Text("· seen \(ls.formatted(.relative(presentation: .named)))")
                                                    .font(.caption2).foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                }
                                // 🤖 A robot's chamber camera + telemetry, always
                                // visible (web parity). Only endpoint devices poll
                                // anything — every other row costs nothing extra.
                                if d.isEndpoint {
                                    EndpointPanel(deviceId: d.id, deviceName: d.name,
                                                  capabilities: d.capabilities, token: token)
                                }
                            }
                            // Revoke — but never for THIS phone (would sign us
                            // out from under ourselves; web hides it too).
                            .swipeActions {
                                if d.id != myDeviceId {
                                    Button(role: .destructive) { pendingRevoke = d } label: {
                                        Label("Revoke", systemImage: "xmark.circle")
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .refreshable { revokeError = nil; await load() }
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .confirmationDialog(
                "Revoke “\(pendingRevoke?.name ?? "device")”?",
                isPresented: Binding(get: { pendingRevoke != nil },
                                     set: { if !$0 { pendingRevoke = nil } }),
                titleVisibility: .visible,
                presenting: pendingRevoke
            ) { dev in
                Button("Revoke", role: .destructive) { Task { await revoke(dev) } }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Its token stops working immediately.")
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let d: [String: Any] = try? await Api.get("/api/devices", token: token) else {
            state = .failed("Login required or network error"); return
        }
        let raw = d["devices"] as? [[String: Any]] ?? []
        devices = raw.compactMap { dev in
            guard let id = dev["id"] as? String else { return nil }
            return DeviceRow(
                id: id,
                name: dev["name"] as? String ?? "device",
                kind: dev["kind"] as? String ?? "?",
                // ⚠️ `online` is a THREE-state field: an endpoint device never
                // heartbeats, so the worker reports null (unknown from here)
                // rather than a false "offline". `as? Bool` on null yields nil →
                // false, which is the honest render for a dot we can't verify;
                // the panel below is what actually proves the robot is alive.
                online: (dev["online"] as? Bool) ?? ((dev["online"] as? Int) == 1),
                lastSeen: (dev["last_seen"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) },
                capabilities: EndpointTelemetry.parseCapabilities(dev["capabilities"]))
        }
        state = .loaded
    }

    /// DELETE /api/devices {deviceId} — kills the device's token server-side,
    /// then re-fetches server truth (reload-not-optimistic-drop, so a failed
    /// revoke leaves the row exactly as the server still sees it). Captures the
    /// HTTP status for a red caption when the revoke didn't take.
    private func revoke(_ dev: DeviceRow) async {
        var req = URLRequest(url: URL(string: Api.base + "/api/devices")!)
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceId": dev.id])
        let ok: Bool
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           let code = (resp as? HTTPURLResponse)?.statusCode {
            ok = code < 400
        } else {
            ok = false
        }
        await load()
        revokeError = ok ? nil : "Couldn't revoke — try again."
    }
}

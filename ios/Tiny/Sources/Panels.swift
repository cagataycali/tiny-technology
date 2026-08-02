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

/// The community read — **one** implementation for the two views that show it.
///
/// 🔴 The iPad sidebar said `Couldn't load`.
///
/// Two words, for four different situations, on the sidebar's only route to the
/// universe. It had nothing better to say because it never asked: `let (data, _)
/// = try await URLSession.shared.data(for: req)` threw the HTTP response away
/// before anyone could read it. A worker 500 carrying `{error:'community query
/// failed'}`, a stale build meeting the router's plain-text 404, an offline
/// radio and a body that simply lacked `users` all arrived indistinguishable,
/// and all four got that same string.
///
/// `UniverseView` reads the SAME url, decodes the SAME `users` into the SAME
/// `UniverseUser`, and has told the truth since `d71b1ff3` — status → the house
/// table, a wrong shape → `badResponse`, a throw → the transport's own words.
/// The sidebar was a COPY that never got the lesson, and that is the actual
/// defect here: `d71b1ff3`'s own subject line says "three panels", counted by
/// hand, so it could only reach the sites someone remembered. One read now, and
/// a second copy would have to retype this whole function to drift again.
enum CommunityFeed {
    /// Everything the two surfaces bind — the sidebar takes `users` alone.
    struct Feed {
        let users: [UniverseUser]
        let trust: [String: Double]
        let totalMessages: Double
        let totalPublicTinys: Int
    }

    /// Public worker endpoint (no token) — the same one the web drawer fetches.
    /// A `static let` so the pin suite can prove there is exactly one of it.
    static let url = "https://plugin.tiny.technology/community?limit=50"

    static func load() async throws -> Feed {
        var req = URLRequest(url: URL(string: url)!)
        // Bounded like every JSON verb (`Api.request`'s 30s, tighter for a
        // public list) — without it a half-open connection leaves both surfaces
        // spinning with no escape to .failed + Retry.
        req.timeoutInterval = 20
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        // The gate the sidebar didn't have. `JSONSerialization` parses a 500's
        // error body perfectly well, so without a status check an outage reads
        // as an empty universe — the web's own `getCommunity` lesson.
        //
        // `Api.serverError` rather than a hand-rolled `obj["error"]` read (which
        // is what this site did): it trims and bounds to 300 chars, and this
        // string becomes a LABEL. A worker answering with a stack trace or an
        // HTML error page must not be pasted into one.
        guard (200...299).contains(code) else {
            throw ApiError.http(code, Api.serverError(in: data))
        }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ApiError.badResponse
        }
        return try decode(obj)
    }

    /// Wire → model. Pure, so the two filters below can be unit-pinned: they are
    /// the reason a builder or a trust score silently doesn't show up, and until
    /// now nothing tested either of them.
    static func decode(_ obj: [String: Any]) throws -> Feed {
        // No `users` key at all is not an empty universe — it is a body we
        // couldn't read, and saying which is the whole point.
        guard let rawUsers = obj["users"] as? [[String: Any]] else { throw ApiError.badResponse }
        let users: [UniverseUser] = rawUsers.compactMap { u in
            guard let login = u["login"] as? String else { return nil }
            let tinys = (u["tinys"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
            // Keep builders even if the payload capped their names (count>0),
            // but drop the genuinely tiny-less (web filters on tinys too).
            guard !tinys.isEmpty else { return nil }
            return UniverseUser(login: login,
                                name: u["name"] as? String ?? "",
                                avatar: u["avatar"] as? String ?? "",
                                tinyCount: (u["tinyCount"] as? NSNumber)?.intValue ?? tinys.count,
                                tinys: tinys)
        }
        // Trust map: keep only well-shaped finite 0<v≤1 entries (web guard)
        var trust: [String: Double] = [:]
        if let raw = obj["trust"] as? [String: Any] {
            for (k, v) in raw {
                let n = (v as? NSNumber)?.doubleValue ?? Double("\(v)") ?? 0
                if !k.isEmpty, n.isFinite, n > 0, n <= 1 { trust[k] = n }
            }
        }
        return Feed(users: users, trust: trust,
                    totalMessages: (obj["totalMessages"] as? NSNumber)?.doubleValue ?? 0,
                    totalPublicTinys: (obj["totalPublicTinys"] as? NSNumber)?.intValue ?? 0)
    }
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
                    // ⚠️ The glyph is the SUBJECT crossed out, never a cause.
                    // `wifi.slash` here asserted a network the app never checked
                    // — and since the caption can now read "Session expired" or
                    // "Server hiccup", the picture (read first) contradicted the
                    // words. Views.swift's `wifi.slash` is the honest kind: it
                    // sits inside `if !net.online`, so reachability was measured.
                    ContentUnavailableView {
                        Label("Couldn't load", systemImage: "person.2.slash")
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
            // Every sentence this surface can say now comes from ONE place, and
            // the sidebar reads the same one — see `CommunityFeed`. Behaviour is
            // unchanged for all four outcomes (`badResponse` still worded by
            // `LoadFailure`, which is a human's word for it, not the wire's);
            // what moved is that a second view can no longer answer differently.
            let feed = try await CommunityFeed.load()
            users = feed.users
            trust = feed.trust
            totalMessages = feed.totalMessages
            totalPublicTinys = feed.totalPublicTinys
            state = .loaded
        } catch { state = .failed(LoadFailure.contentMessage(error)) }
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

    /// Ideal size, except that nothing is allowed to be wider than the container.
    ///
    /// `.unspecified` asks a subview how big it would LIKE to be, and a chip
    /// that wants more width than exists used to get it: at the accessibility
    /// text sizes the `bluetooth_scan` capability chip was wider than the phone
    /// and ran off the edge of the row, capsule and all. Re-proposing at `maxW`
    /// lets it wrap or truncate inside the row instead of escaping it.
    private func size(of v: LayoutSubviews.Element, cappedTo maxW: CGFloat) -> CGSize {
        let ideal = v.sizeThatFits(.unspecified)
        guard ideal.width > maxW else { return ideal }
        return v.sizeThatFits(ProposedViewSize(width: maxW, height: nil))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineH: CGFloat = 0, maxLineW: CGFloat = 0
        for v in subviews {
            let s = size(of: v, cappedTo: maxW)
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
            let s = size(of: v, cappedTo: maxW)
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
                case .failed(let e):
                    // Fetch failure — calm retry, NOT a "no such builder" claim
                    // (web ProfileUnavailable's exact lesson; the 400/404
                    // verdicts now leave via `.loaded` with a nil profile, so
                    // this state really is only the retryable kind).
                    //
                    // ⚠️ The description was the fixed sentence "Usually
                    // momentary." — a claim about the future, made without
                    // reading the failure, in the one place the reason belongs.
                    // The glyph asserted a cause too; it can't be `person.slash`
                    // either, because that is the not-found state four lines
                    // below and these two states mean opposite things.
                    ContentUnavailableView {
                        Label("Couldn't load @\(login)", systemImage: "exclamationmark.arrow.circlepath")
                    } description: {
                        Text(e)
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
                                Text(t.name).foregroundStyle(.primary)
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
            // A handle that won't survive percent-encoding is not a builder — the
            // same answer as the worker's 404, and one no amount of retrying
            // changes. It used to read "bad login" under a Try again button: the
            // wire's phrase, and an invitation to repeat a doomed request.
            profile = nil; state = .loaded; return
        }
        var req = URLRequest(url: url); req.timeoutInterval = 20
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            // ⚠️ 400 belongs HERE, with the 404. The worker answers
            // `400 {error:"invalid login"}` for a handle it won't even look up
            // (src/profile.ts:47) — a permanent verdict that used to land in
            // `.failed("HTTP 400")`: a crossed-out wifi, "Usually momentary." and
            // a Try again button, for a request that cannot ever succeed.
            if code == 404 || code == 400 { profile = nil; state = .loaded; return }
            guard (200...299).contains(code),
                  let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let l = obj["login"] as? String else {
                // A login-less body from a 2xx is also a not-found (404 already
                // returned above); a non-2xx is a transient failure. Split them
                // the way web's normalize does.
                if (200...299).contains(code) { profile = nil; state = .loaded }
                else {
                    let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                        .flatMap { $0["error"] as? String }
                    state = .failed(LoadFailure.contentMessage(status: code, serverMsg: msg))
                }
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
        } catch { state = .failed(LoadFailure.contentMessage(error)) }
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
                            Text(tool.name).font(.callout)
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
                        // ⚠️ Not `hammer.slash` (the empty state's subject
                        // crossed out) — that symbol does not exist; Apple's
                        // name_availability.plist has no such name, and a missing
                        // systemImage renders as blank space. The cause-free
                        // retry glyph instead.
                        ContentUnavailableView {
                            Label("Couldn't load your tools", systemImage: "exclamationmark.arrow.circlepath")
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
                // An `ok:false` on a 2xx IS an unexpected response — one house
                // sentence for it. The old line showed the SERVER's raw `error`
                // string when it had one (wire phrasing, straight onto the
                // screen) and otherwise guessed at the connection, on a request
                // whose bytes had already arrived.
                state = .failed(ApiError.badResponse.localizedDescription)
                return
            }
            tools = raw.compactMap { Self.parseTool($0) }
            state = .loaded
        } catch {
            // One branch. The 401 case had its own hand-written line, "Sign in to
            // see your forged tools (HTTP 401)" — but a 401 arriving WITH a token
            // is an expired session, and signing in is not the remedy for that
            // (the signed-OUT state is handled above, before any fetch). The
            // table says "sign out and back in", which is the thing that works.
            state = .failed(LoadFailure.contentMessage(error))
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
    /// A confirmed, irreversible delete that fails has to say so. Without this
    /// the request's result was discarded, `load()` re-fetched the still-present
    /// job, and the row simply reappeared — the user's only signal that anything
    /// went wrong being that their delete didn't seem to happen.
    @State private var deleteError: String?

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
                        Section("Scheduled jobs") {
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
            .alert("Couldn't delete", isPresented: Binding(
                get: { deleteError != nil },
                set: { if !$0 { deleteError = nil } })
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(deleteError ?? "")
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
            Section("On this device (agent alerts)") {
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
        // `do/catch` so the caption can name ONE cause — see `LoadFailure`.
        let d: [String: Any]
        do { d = try await Api.get("/api/jobs", token: token) }
        catch { state = .failed(LoadFailure.message(error)); return }
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

    /// `Api.deleteJson` rather than a hand-rolled URLRequest: its own doc names
    /// "/api/tools + /api/jobs" as the two shapes it exists for, and it throws
    /// `ApiError.http` with the server's own wording on a non-2xx. This call site
    /// predated it and discarded the response entirely — so a 401, a worker
    /// outage or a subway tunnel all looked exactly like a successful delete of a
    /// job that then came back.
    private func remove(_ id: String) async {
        deleteError = nil
        do {
            let d = try await Api.deleteJson("/api/jobs", token: token, body: ["id": id])
            // The worker deletes by (id, user_id) and answers ok even when the row
            // was already gone, so there is no "already deleted" case to forgive:
            // anything but ok is a real failure.
            if d["ok"] as? Bool != true {
                deleteError = (d["error"] as? String) ?? "The job is still there — try again."
            }
        } catch ApiError.http(let code, let serverMsg) {
            deleteError = Api.httpMessage(code, serverMsg)
        } catch {
            deleteError = error.localizedDescription
        }
        // Reload either way: server truth is the only thing worth painting, and
        // on failure that truth is the row still being there.
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
                    Section("On this phone (remember tool)") {
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
                Section("Server learnings (learn tool)") {
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
        // `do/catch` so the caption can name ONE cause — see `LoadFailure`.
        let d: [String: Any]
        do { d = try await Api.get("/api/learnings?limit=200", token: token) }
        catch { state = .failed(LoadFailure.message(error)); return }
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

/// Capability → SF Symbol for the devices list's hardware strip.
///
/// ⚠️ Every name here MUST be a real SF Symbol. `Image(systemName:)` does not
/// fail loudly on a typo — it draws a generic placeholder — which is how
/// `flipper.fill` (never an Apple symbol; the nearest real names are
/// `flipphone` and `flip.horizontal`) shipped as a stray document icon sitting
/// in the middle of the capability strip. `tests/ios-sf-symbols.test.ts` now
/// checks every symbol literal in the iOS sources against the system's own
/// symbol database so the next typo is caught before it reaches a screen.
/// Returns nil for a word we have no icon for — see CapabilityChip.
func capabilityIcon(_ c: String) -> String? {
    switch c {
    // ── The necklaces (TinySetup enrolls these) ──
    case "camera": return "camera.fill"
    case "mic": return "mic.fill"
    case "tof": return "ruler"
    case "imu": return "gyroscope"
    case "ble": return "dot.radiowaves.right"
    case "wifi": return "wifi"
    // 🎙️ Nicla Voice: always-on wake-word inference on its NDP120, the one
    // capability that is a *listening posture* rather than a piece of hardware.
    case "wake": return "waveform.badge.mic"
    // ── This phone (Session.capabilities) ──
    case "chat": return "text.bubble"
    case "bluetooth_scan": return "dot.radiowaves.left.and.right"
    case "location": return "location.fill"
    case "record": return "record.circle"
    case "speak": return "speaker.wave.2.fill"
    case "open_app": return "square.grid.2x2"
    case "image_gen": return "wand.and.stars"
    case "glasses": return "eyeglasses"
    // 📸 Screen capture — always behind a per-capture consent prompt, so the
    // glyph is the viewfinder rather than anything that suggests it's silent.
    case "screenshot": return "camera.viewfinder"
    // ── Mesh nodes: `mcp`/`files` plus one label per device tool that
    // resolved on that machine (tiny-tech device-tools.ts). A developer's
    // laptop declares a dozen, so these carry most of the strip's width.
    case "mcp": return "puzzlepiece.extension"
    case "files": return "folder"
    case "shell": return "terminal"
    // Apple Events — the grant that lets a Mac be told what to do at all.
    case "apple": return "command"
    // use_computer: reads the screen and clicks it.
    case "computer": return "cursorarrow.click"
    case "windows": return "macwindow.on.rectangle"
    case "ocr": return "text.viewfinder"
    case "browse": return "globe"
    // use_desktop is notify + clipboard: how a headless box reaches its human.
    case "desktop": return "bell.badge"
    case "voice": return "waveform"
    case "see": return "eye"
    case "spotify": return "music.note"
    case "google": return "magnifyingglass"
    case "whatsapp": return "message"
    // Android Debug Bridge.
    case "adb": return "ladybug"
    // 🐬 Flipper Zero: a USB-attached RF multi-tool (IR / Sub-GHz / RFID), so it
    // wears the waves it speaks — distinct from `wifi` and from ble's dot.
    case "flipper": return "wave.3.right"
    // 🐬📶 The same board, reached over Bluetooth by the phone wearing this chip
    // instead of down a USB cable. A SEPARATE token on purpose: one shared
    // `flipper` would let the backend route an IR capture to a phone, and BLE
    // has no receive RPC at all — docs/flipper-ble-ios-design.md §4.2.
    case "flipper_ble": return "dot.radiowaves.right"
    // ── Endpoint robots (their own API declares these) ──
    case "print": return "printer.fill"
    case "telemetry": return "waveform.path.ecg"
    default: return nil
    }
}

/// The WORD for a capability — the user's vocabulary, not the wire's.
///
/// The chips used to print the wire token verbatim, so the devices sheet showed
/// people `bluetooth_scan`, `image_gen`, `open_app`, `tof`, `imu`, `ble`, `ocr`,
/// `adb`, `mcp`. Those are identifiers a daemon sends to a server; three of them
/// carry an underscore, four are acronyms with no expansion anywhere on the
/// screen, and `windows` reads as Microsoft's. A laptop's row was a dozen of
/// them in a wrapping grey ribbon — the panel looked like a debug dump of itself.
/// VoiceOver had it worst: "can bluetooth underscore scan".
///
/// Deliberately a dictionary and not a `switch`, following DEVICE_PLATFORM_GLYPH
/// below: tests/nicla-android-parity.test.ts scrapes `case "…": return "…"` arms
/// out of THIS FILE to enumerate the capability set, so a second switch of that
/// shape would make the parity test demand an Android ICON for every word in
/// here — including `telegram` and `integrations`, which a Mac daemon really
/// declares (web DEVICE_LABELS) and which neither phone has a glyph for yet.
///
/// Terse on purpose: this is a capsule in a strip a dozen wide, not a sentence.
/// The long-form meanings live in CAPABILITY_HINTS (web lib/chat/prompt.ts),
/// which is written for the agent — it has a paragraph to spend and this has a
/// chip. Where they disagree in length they must not disagree in MEANING, so
/// each label below is that hint's headline.
/// Not `private`, unlike DEVICE_PLATFORM_GLYPH: the test that keeps this table
/// and capabilityIcon agreeing has to ask whether a KEY is present, and from
/// outside the file a word that maps to itself is indistinguishable from a word
/// nobody mapped.
let CAPABILITY_LABELS: [String: String] = [
    // ── The necklaces ──
    "camera": "camera",
    "mic": "mic",
    "tof": "distance",            // time-of-flight ranging
    "imu": "motion",              // accelerometer + gyroscope
    "ble": "bluetooth",
    "wifi": "Wi-Fi",              // Apple's own spelling
    "wake": "wake word",
    // ── This phone (Session.capabilities) ──
    "chat": "chat",
    "bluetooth_scan": "bluetooth",
    "location": "location",
    "record": "records audio",
    "speak": "speaks",
    "open_app": "opens apps",
    "image_gen": "makes images",
    "glasses": "glasses",
    // "screenshot" as a bare token reads like a noun the device HAS; it's a
    // thing the phone can be ASKED to do, and only with a tap each time.
    "screenshot": "shows its screen",
    // ── Mesh nodes (tiny-tech device-tools.ts) ──
    "mcp": "MCP",                 // an acronym, so at least let it read as a NAME
    "files": "files",
    "shell": "shell",
    "apple": "Apple apps",
    "computer": "screen control",
    "ocr": "reads text",
    // Not Microsoft's. "windows" alone is the one token here that reads as a
    // different product entirely, which is worse than reading as jargon.
    "windows": "arranges windows",
    "browse": "browser",
    "desktop": "notifications",
    "voice": "voice",
    "see": "sees images",
    "spotify": "Spotify",
    "google": "Google",
    "whatsapp": "WhatsApp",
    "telegram": "Telegram",
    "adb": "Android",
    "flipper": "Flipper Zero",
    "flipper_ble": "Flipper (Bluetooth)",
    "integrations": "integrations",
    // ── Endpoint robots ──
    "print": "prints",
    "telemetry": "telemetry",
]

/// A capability's label, falling back to the token with its separators opened up.
///
/// An unmapped word still shows — a newer daemon must not be silenced, the same
/// rule the web's capabilitySummary follows and the same one capabilityIcon
/// follows by returning nil rather than a stand-in glyph. But it shows as WORDS:
/// whatever `some_new_thing` turns out to mean, it never means an underscore.
func capabilityLabel(_ c: String) -> String {
    CAPABILITY_LABELS[c]
        ?? c.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
}

/// One capability as a chip.
///
/// Replaces a single run-on `Text` of symbol+word pairs: a laptop daemon claims
/// six or seven capabilities and they ran together into one grey ribbon with no
/// word boundaries, so `wifi` `camera` `mic` read as one long token. Chips carry
/// their own edges, and FlexWrap lets them wrap instead of truncating.
struct CapabilityChip: View {
    let cap: String

    var body: some View {
        HStack(spacing: 3) {
            // No glyph rather than a stand-in one. `circle.dashed` used to fill
            // this slot for anything unrecognised, and since the table only knew
            // the six necklace words, the real screen was a wall of identical
            // dashed circles — twenty of them on a phone-plus-laptop account,
            // reading as a rendering fault rather than as information. An icon
            // that is the same on every chip is worse than no icon: it costs
            // width on every chip and pays nothing back.
            if let icon = capabilityIcon(cap) {
                Image(systemName: icon)
            }
            Text(capabilityLabel(cap))
        }
        // `.system(size: 10)` and `size: 8` were FIXED sizes, so the strip was
        // byte-for-byte identical at extra-small and at AX-XXXL — the one part
        // of the row immune to Dynamic Type, and the part carrying the most
        // words. `.caption2` is what the presence line one row up already uses.
        .font(.caption2)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(.secondary)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .accessibilityLabel("can \(capabilityLabel(cap))")
    }
}

/// How many capability chips a collapsed row shows, and what the rest become.
///
/// The ribbon was uncapped. A laptop declares twelve capabilities — `npx tiny-tech
/// mesh` sends one per resolved device tool — so its chips wrapped to FIVE lines
/// of grey pills (measured on the harness fleet, default type, 6.9" screen) and
/// the row's own NAME was no longer the largest thing in it.
/// Across the fleet the ribbon was both the widest and the tallest element of
/// every row: six near-identical pill-walls stacked down a list whose two
/// questions are "which device is this" and "can I reach it". The chips are the
/// reference half of the row, and they were outweighing the answer.
///
/// The precedent is one screen over in this same file: `FlowChips` caps a
/// builder's tinys and offers a trailing "+N more".
///
/// ⚠️ What stays visible is the alphabetical PREFIX, not a ranking. The decoder
/// sorts capabilities by their LABEL on purpose — "a list ordered by an invisible
/// field looks like a list nobody ordered" — and ranking them by anything else
/// (which ones grow a panel, say) would order the row by a field nobody is shown.
/// The prefix is biased and worth admitting: an iPhone shows bluetooth, chat,
/// glasses, location and hides makes images, opens apps, records audio, speaks.
/// That is exactly why the rest are one tap away, and why the row's spoken label
/// keeps enumerating every one — VoiceOver hears the full list either way, since
/// `.accessibilityElement(children: .combine)` makes the row's own label the only
/// one that survives.
enum CapabilityRibbon {
    static let cap = 4

    /// Both halves from ONE function, so the chips shown and the number claimed
    /// hidden cannot disagree.
    static func split(_ caps: [String], expanded: Bool) -> (shown: [String], hidden: Int) {
        // "+1 more" is a chip that hides a chip: it costs the line space it saves,
        // so the cap only applies where it buys back at least two.
        guard !expanded, caps.count > cap + 1 else { return (caps, 0) }
        return (Array(caps.prefix(cap)), caps.count - cap)
    }

    /// The toggle's words, or nil when this row has nothing to collapse — asked
    /// of `split` itself rather than of `count`, so one rule decides both whether
    /// the ribbon is capped and whether a control admits it.
    static func toggleLabel(_ caps: [String], expanded: Bool) -> String? {
        let hidden = split(caps, expanded: false).hidden
        guard hidden > 0 else { return nil }
        return expanded ? "show fewer" : "+\(hidden) more"
    }
}

/// Identity glyph per device — WHAT the thing is, readable before its name.
///
/// Deliberately data and not a `switch`: tests/nicla-android-parity.test.ts
/// scrapes `case "…": return "…"` arms out of THIS FILE to enumerate the
/// capability set, so a second switch of that shape here would make the parity
/// test demand Android icons for "daemon" and "browser".
private let DEVICE_PLATFORM_GLYPH: [(needle: String, symbol: String)] = [
    ("nicla-vision", "camera.aperture"),
    ("nicla-voice", "mic.and.signal.meter"),
    ("darwin", "laptopcomputer"),
    ("mac", "laptopcomputer"),
    ("ipad", "ipad"),
    ("ios", "iphone"),
    ("android", "smartphone"),
    ("linux", "desktopcomputer"),
    ("win", "desktopcomputer"),
]

private let DEVICE_KIND_GLYPH: [String: String] = [
    // A robot at its own API is a BODY out on the network, not a machine of ours
    // that dialled in — web gives it a globe; a solid object reads truer.
    "endpoint": "cube.transparent",
    "browser": "globe",
    "cli": "terminal",
    "daemon": "cpu",
]

/// DEVICE_PLATFORM_GLYPH's needles, in words — the SAME needles, in the SAME
/// order, because the word and the picture describe one fact and must not be
/// able to disagree. Pinned by tests/ios-capability-words.test.ts, which is how
/// a tenth entry here ("Bambu Lab", against nine glyphs) was caught.
///
/// The glyph table was already humanised — a necklace gets an aperture, a Mac a
/// laptop — while the line printed beside it said `daemon · nicla-vision`. Two
/// renderings of one fact, and only the picture had been translated. Once the
/// capability chips underneath became words (`bluetooth`, `makes images`,
/// `opens apps`), that line was the last wire text in the row, sitting directly
/// above eight chips written in English.
///
/// Kept as a needle LIST rather than a dictionary for the same reason the glyphs
/// are: the wire carries `darwin-arm64`, `linux-x64`, `win32-x64` — a family
/// plus an arch — and matching on the family means a new arch needs no entry.
/// Order matters exactly as it does there (`ipad` before `ios`).
///
/// ⚠️ There is deliberately no "Bambu Lab" here, tempting as a printer is: only
/// a self-reporting DAEMON ever puts a platform on the wire. The enroll form
/// posts `{name, kind}` and nothing else (app/devices/page.tsx), so every robot
/// and printer arrives with `platform: ""` — the web row says as much in prose,
/// "it has no platform string", and shows the device's URL in this line's place.
/// A needle for `bambu` would therefore have matched nothing but our own harness
/// fixture, i.e. it would only ever have been visible in a screenshot.
///
/// ⚠️ `ios-arm64` is BOTH iPhone and iPad: Session.enroll hard-codes it and
/// makes only the device NAME idiom-aware ("ada-ipad"), so the `ipad` needle
/// here and in the glyph table can never match a device this app enrolled — an
/// iPad's row draws an iPhone. "iOS" is therefore the strongest true claim for
/// that token, and inventing "iPhone" would trade one wrong word for another.
/// Fixing it properly means changing what goes on the wire, and the wire string
/// is matched exactly elsewhere (`platform === 'ios-arm64'` picks the recorder
/// for the Voice necklace), so it is not this view's call to make.
private let DEVICE_PLATFORM_NAME: [(needle: String, name: String)] = [
    ("nicla-vision", "Nicla Vision"),
    ("nicla-voice", "Nicla Voice"),
    ("darwin", "Mac"),
    ("mac", "Mac"),
    ("ipad", "iPad"),
    ("ios", "iOS"),
    ("android", "Android"),
    ("linux", "Linux"),
    ("win", "Windows"),
]

/// What a `kind` is in English, for the rows whose platform says nothing.
///
/// Every one of these is a word about OUR plumbing rather than about the thing
/// on the shelf: a printer enrolls as `endpoint`, a Raspberry Pi as `cli`, and a
/// necklace and a laptop both as `daemon`. So they are the fallback, never the
/// headline — the same precedence deviceGlyph uses, and for the same reason.
private let DEVICE_KIND_NAME: [String: String] = [
    "endpoint": "robot",
    "browser": "browser",
    "cli": "computer",
    "daemon": "device",
]

/// Platform wins over kind: a necklace and a laptop both enroll as kind
/// `daemon`, and "cpu" for a camera on a lanyard tells you nothing.
func deviceGlyph(platform: String, kind: String) -> String {
    let p = platform.lowercased()
    for entry in DEVICE_PLATFORM_GLYPH where p.contains(entry.needle) { return entry.symbol }
    return DEVICE_KIND_GLYPH[kind.lowercased()] ?? "cpu"
}

/// What the hardware IS, in one word — "Mac", "Nicla Vision", "Linux".
///
/// Same precedence as `deviceGlyph`, so the word and the picture can't disagree.
/// An unrecognised platform still SHOWS, with its separators opened up, exactly
/// as `capabilityLabel` handles a capability nobody has mapped: a newer daemon
/// must not be silenced, but it never speaks in underscores. nil only when the
/// row has nothing to say at all, so the caller renders no separator.
func deviceLabel(platform: String, kind: String) -> String? {
    let p = platform.trimmingCharacters(in: .whitespaces).lowercased()
    if !p.isEmpty && p != "?" {
        for entry in DEVICE_PLATFORM_NAME where p.contains(entry.needle) { return entry.name }
        return p.replacingOccurrences(of: "_", with: " ")
                .replacingOccurrences(of: "-", with: " ")
    }
    return DEVICE_KIND_NAME[kind.trimmingCharacters(in: .whitespaces).lowercased()]
}

/// What the wire cannot say about the one device that doesn't have to ask.
///
/// `Session.enroll` posts `platform: "ios-arm64"` from every build of this app —
/// iPhone, iPad and the Mac Catalyst one — and makes only the device NAME
/// idiom-aware ("ada-ipad"). So an iPad's row draws an iPhone, says "iOS", and
/// sits under a header that calls it a phone, while the app is RUNNING on that
/// iPad. Three claims about the hardware, all made from one lossy token, all
/// wrong, on the row whose hardware is the least in doubt of any in the list.
///
/// The fix is not to change the token. One server tool matches it exactly
/// (`platform === 'ios-arm64'` picks the recorder for the Voice necklace), and a
/// fleet split across two spellings is a worse bug than a wrong glyph. What this
/// does instead is stop the app from repeating a word it can see is wrong about
/// itself: the substituted string is wire-SHAPED and never sent, so it needs no
/// server change and no new needle — `ipad` and `darwin` are already in both
/// platform tables, ahead of `ios`, waiting for a token that never arrived.
///
/// ⚠️ Only this device's own row. Every other row's platform is that device's to
/// report, and a Mac's laptop glyph is not ours to second-guess.
enum LocalHardware {
    /// The three things this app runs on. Its own type rather than
    /// `UIUserInterfaceIdiom` because Catalyst is a BUILD and not an idiom —
    /// "Scaled to Match iPad" reports `.pad` from a Mac — and because a rule
    /// that reads a UIKit singleton can only be tested on the hardware it
    /// describes, which is exactly the hardware nobody has in CI.
    enum Shape: String, CaseIterable { case phone, pad, mac }

    /// The impure edge, kept to one expression so everything below stays pure.
    ///
    /// Catalyst is checked FIRST and at compile time: a Catalyst app is on a Mac
    /// whichever idiom it chooses to report. Anything that is not an iPad falls
    /// back to `.phone`, which is the shape that changes nothing — an idiom this
    /// app doesn't ship for (TV, CarPlay) keeps exactly the words it shows today
    /// rather than acquiring a confident new one.
    @MainActor static var current: Shape {
        #if targetEnvironment(macCatalyst)
        return .mac
        #else
        return UIDevice.current.userInterfaceIdiom == .pad ? .pad : .phone
        #endif
    }

    /// The platform string to DRAW for this device, or nil when the wire's own
    /// word is already the best available.
    static func platform(wire: String, shape: Shape) -> String? {
        // Only the known-lossy token is corrected. If enroll ever learns to send
        // `ipad-arm64` itself this rule stops firing instead of double-guessing
        // it, and a row saying anything else — a necklace, a laptop, a robot —
        // was never this app's own hardware to correct.
        guard wire.lowercased().contains("ios") else { return nil }
        switch shape {
        // The wire was right: "iOS" is true of an iPhone, and this app has no
        // stronger word for it that the platform tables already know.
        case .phone: return nil
        case .pad: return "ipad-arm64"
        case .mac: return "darwin-arm64"
        }
    }

    /// The fleet with this device's row corrected and every other row untouched.
    ///
    /// A `map` over the list the view draws, rather than a fix-up at decode: the
    /// list is repopulated by a poll, an SSE nudge and a pull-to-refresh, and a
    /// correction that lives on one of those paths is a correction that blinks.
    static func corrected(_ rows: [DeviceRow], thisDeviceId: String?, shape: Shape) -> [DeviceRow] {
        rows.map { row in
            guard let id = thisDeviceId, row.id == id,
                  let shown = platform(wire: row.platform, shape: shape) else { return row }
            var fixed = row
            fixed.localPlatform = shown
            return fixed
        }
    }

    /// "phone" / "iPad" / "Mac" — the noun after "this".
    ///
    /// ONE noun for both strings below, so the section header and the row's pill
    /// cannot disagree about what the thing in your hands is.
    static func selfNoun(_ shape: Shape) -> String {
        switch shape {
        // Lowercase where the others are not: "phone" is a common noun and
        // "iPad" is a name. "This phone" is also the string this section has
        // always shown, so an iPhone's list is byte-identical after this change.
        case .phone: return "phone"
        case .pad: return "iPad"
        case .mac: return "Mac"
        }
    }

    /// The self section's header — `DeviceOrder.groupTitles`' first entry.
    static func selfTitle(_ shape: Shape) -> String { "This \(selfNoun(shape))" }

    /// The pill on the row itself.
    static func selfPill(_ shape: Shape) -> String { "this \(selfNoun(shape))" }
}

/// Presence is a THREE-state fact and only two of them are a boolean question.
///
/// An endpoint device (a robot behind its own authenticated API) never
/// heartbeats, so the worker reports `online: null` — "unknown from here" — and
/// neither "online" nor "offline" is a true statement about it. The old row
/// collapsed null to false and drew a dead grey dot on a perfectly healthy
/// printer. Web parity: `presenceOf` in app/devices/page.tsx.
enum DevicePresence {
    case online, offline, unknown

    /// Web parity: an offline device shows its relative last-seen instead of the
    /// word "offline" — "3 minutes ago" and "in March" are the same word
    /// otherwise, and that difference is the entire question being asked.
    func label(lastSeen: Date?) -> String {
        switch self {
        case .online: return "online"
        case .unknown: return "reachable when called"
        case .offline:
            guard let lastSeen else { return "never seen" }
            return "seen \(lastSeen.formatted(.relative(presentation: .named)))"
        }
    }
}

/// May a panel spend a relay round-trip on this device — and what does it say
/// when it may not?
///
/// The worker's own definition of a dial-in device answers it. `PULL_KINDS`
/// (worker/src/devices.ts) is documented as the kinds that "hold a
/// `tind_` token, heartbeat, poll the relay" — one loop, both jobs. A device
/// outside the 60s `PRESENCE_WINDOW_S` is therefore not reading the relay
/// either, so an invoke posted to it can only wait out the caller's own poll
/// budget.
///
/// `RelayCameraPanel` did exactly that, automatically, on every appearance:
/// open My devices with a necklace asleep in a drawer and the sheet spent 17
/// requests and 19 seconds on it to paint an orange "No frame in 19s — is the
/// camera awake?" above a row that already said "seen 3 days ago". The camera
/// was awake. The board was gone. Its sibling one row down —
/// `FlipperDevicePanel`, same sheet, same relay — had already learned the rule,
/// and its comment says why the wording matters as much as the call: "Saying
/// 'Flipper offline' sends the user to unplug a working cable."
///
/// ⚠️ RELAY only. An endpoint device (robot, printer) polls nothing — tiny
/// dials OUT to its own HTTPS API — and its presence is `.unknown` BY
/// CONSTRUCTION, because the worker sends `online: null` for it. Gate
/// `EndpointPanel` on this and every healthy robot on the sheet goes dark.
enum RelayReach {
    /// The one rule, so the two relay panels on this sheet cannot drift apart.
    static func canReach(_ presence: DevicePresence) -> Bool { presence == .online }

    /// nil = go ahead and fetch. Non-nil = the line to show INSTEAD of fetching.
    ///
    /// One function for both halves on purpose: a panel can't end up showing
    /// this sentence and still making the call, or making the call and having
    /// nothing to say about why no frame is coming.
    ///
    /// It names the device, as the Flipper's line does, because a panel is its
    /// own block and "it" has no antecedent inside one. It opens with the
    /// sibling's exact phrasing so one sheet speaks with one voice — and it
    /// blames the BOARD rather than the camera, which is the whole correction.
    static func cameraNote(deviceName: String, presence: DevicePresence) -> String? {
        canReach(presence) ? nil
            : "\(deviceName) isn't online — its camera answers once it's back."
    }
}

extension View {
    /// The one chrome for a device's nested live panel (camera, voice link,
    /// Flipper). They wore three slightly different greys and radii before, so a
    /// row with two panels looked like a rendering bug. `tertiarySystemFill` —
    /// not `.tinyCard()` — because these sit INSIDE a grouped List row whose
    /// background is already `secondarySystemGroupedBackground`, where a card
    /// would be invisible.
    func devicePanel() -> some View {
        padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// 🕒 "as of 8:35:12 AM" — when a reading on this sheet was actually taken.
///
/// Two panels here fetch something over the relay and then go on showing it: the
/// camera's frame, and the Flipper's firmware/battery/host line. Both are
/// PAST-TENSE facts rendered in the present tense, and only one of them admitted
/// it. The camera stamped its frame; the Flipper printed a battery percentage
/// with nothing whatsoever to say how old it was, so a reading taken while the
/// Flipper was plugged in read identically twenty minutes after it had been
/// unplugged.
///
/// One function, so the sheet has ONE voice for a reading's age — and because
/// the second site would otherwise have had to duplicate the day rule below.
///
/// SECONDS, not `.shortened`: the question this line answers is "did the thing
/// I'm looking at just update?", and two readings a minute apart that both say
/// "8:35 AM" cannot answer it.
///
/// It names an INSTANT rather than an elapsed time on purpose. "2m ago" is only
/// true at the moment it is composed and there is nothing on this sheet to
/// re-render it, so it would rot in place; a clock time stays true with no timer
/// behind it.
///
/// And it names the DAY, but only when that isn't today. These panels' `@State`
/// dies with the sheet, so the ordinary case is a reading seconds old and
/// spending a date on every row would be waste — but a sheet left open while the
/// phone sits in a pocket overnight comes back holding yesterday's reading, and
/// a bare "as of 8:35:12 AM" is then a false claim made in the most confident
/// format available.
enum ReadingAge {
    /// nil ⇒ nothing has been read yet, so there is no line to draw.
    static func asOf(_ when: Date?, now: Date = Date()) -> String? {
        guard let when else { return nil }
        let today = Calendar.current.isDate(when, inSameDayAs: now)
        return "as of " + when.formatted(date: today ? .omitted : .abbreviated,
                                         time: .standard)
    }
}

/// Who asked for the peek that failed — and therefore how loudly the camera
/// panel is allowed to say so.
///
/// `RelayCameraPanel.body` fetches on appearance, so the panel can be holding a
/// failure nobody requested, and it reported that with the chrome this app
/// reserves for "what you just did didn't work": an orange warning triangle and
/// a button labelled **Retry** — a word that names the repetition of something
/// the user had not done. Opening My devices with two online Vision necklaces
/// whose cameras don't answer raised two alarms for two requests that were never
/// made, each one louder than the device's own name beside it.
///
/// The panel already states the rule one branch up, for a sleeping board:
/// "Deliberately NOT the failure card: nothing failed." The automatic fetch is
/// the single path that escaped it. So the reason still shows in every state —
/// a swallowed failure is the bug this panel exists to prevent — and only the
/// VOLUME follows who asked.
///
/// One total decision instead of three conditions inside a `VStack`: the shapes
/// are mutually exclusive and an exhaustive `switch` cannot let the chrome drift
/// away from the provenance, which is precisely how the alarm ended up on a
/// request the user never made.
enum PeekShape: Equatable {
    /// A fetch is in flight. Outranks a stale reason — the spinner is the news.
    case working
    /// Nothing tried yet, nothing to report.
    case idle
    /// It failed, but nobody asked: the reason, in the grey one-line shape every
    /// other non-frame state on this sheet already wears.
    case quiet(String)
    /// It failed after the user asked for it: the card, the triangle, the Retry.
    case alarm(String)

    static func of(error: String?, busy: Bool, asked: Bool) -> PeekShape {
        if busy { return .working }
        // An empty message is `FrameFailure.cancelled` — the panel left the
        // screen. `refresh` already nils it; a blank alarm is what this catches
        // if that ever stops being true.
        guard let error, !error.isEmpty else { return .idle }
        return asked ? .alarm(error) : .quiet(error)
    }

    /// The reason the grey line prints, or nil when it has nothing to say.
    /// `alarm`'s reason belongs to the card, so it is not a line.
    var quietReason: String? {
        if case .quiet(let why) = self { return why }
        return nil
    }

    /// What VoiceOver reads for the grey line — which is `.combine`d, so this
    /// label REPLACES the text inside it. A reason left out of here is a reason
    /// a VoiceOver user never hears, the same way a device row lost its presence
    /// before `DeviceOrder.spokenLabel` existed.
    var spoken: String {
        switch self {
        case .working: return "Asking the camera for a frame"
        case .idle: return "Peek at the camera"
        case .quiet(let why): return why
        // The card speaks through its own children and never reads this, but
        // returning the reason keeps it honest if it ever does.
        case .alarm(let why): return why
        }
    }

    /// The affordance, for the one state whose label is the board's own words and
    /// so can't carry it. A hint, not a clause glued onto the reason: two of
    /// `FrameFailure`'s five messages are pass-through strings from the server or
    /// the board ("camera busy"), so there is no punctuation to join against —
    /// the same trap that made "Couldn't reach the relay. · tap to retry" wrong.
    /// `accessibilityHint` is the API for "what happens if you activate this".
    var spokenHint: String? {
        if case .quiet = self { return "Fetches a frame" }
        return nil
    }
}

/// A pull-device camera panel: shows the freshest frame the relay can fetch,
/// with tap-to-refresh. ~4-15s per frame (cloud round-trip) — this is the
/// "check on it" view; the 💎 toolbar button is the live one.
struct RelayCameraPanel: View {
    let deviceId: String
    /// For the one sentence this panel says when it refuses to call (RelayReach).
    let deviceName: String
    /// Read BEFORE the auto-fetch. Without it this panel asked an offline board
    /// for a frame on every appearance and then reported the silence as a camera
    /// problem — see RelayReach.
    let presence: DevicePresence
    let token: String?
    @State private var frame: UIImage?
    @State private var busy = false
    @State private var stamp: Date?
    /// Why the last peek came back empty. Before this existed, five different
    /// failures — a refused relay, a nineteen-second silence, a board answering
    /// "no camera", an unreachable URL, undecodable bytes — all rendered as the
    /// untouched "tap to peek" placeholder, which is also exactly what a user
    /// who had never tapped saw. You could not tell a broken camera from an
    /// idle one.
    @State private var error: String?
    /// Whether the peek on screen was ASKED FOR. Set inside `refresh`, beside the
    /// call it describes, so the answer can't drift from what happened. See
    /// `PeekShape`: this decides the CHROME of a failure, never whether the call
    /// is made.
    @State private var asked = false

    /// Read once, rendered once: what the non-frame area is allowed to look like.
    private var peek: PeekShape {
        PeekShape.of(error: error, busy: busy, asked: asked)
    }

    /// 130pt of black is what a FRAME looks like. Before this split, every other
    /// state wore it too: a refused relay, a board with no camera and a row
    /// nobody had tapped yet each rendered a full-size black window with a line
    /// of small text floating in the middle of it. On the devices sheet that made
    /// the loudest, largest element on the screen a camera that had failed —
    /// bigger than the device's own name, and repeated per necklace. A failure
    /// should not occupy the footprint of a success, so now only a real frame
    /// gets the window and everything else is one line.
    ///
    /// The FAILURE state is the exception to "one line", and it borrows the shape
    /// of `FlipperDevicePanel` — the panel one row down on the same sheet. It
    /// used to chain the retry onto the reason as prose, `Text(error)` followed by
    /// `Text("· tap to retry")`, which broke three ways at once:
    ///
    ///   • `·` is this app's separator for TERMINATOR-FREE fragments ("online ·
    ///     daemon · ios-arm64"), and three of `FrameFailure`'s five messages are
    ///     whole sentences — two of them the server's or the board's own words.
    ///     So the sheet read "Couldn't reach the relay. · tap to retry", a
    ///     separator landing after a full stop.
    ///   • both Texts sat in one HStack with no `fixedSize`, so at an
    ///     accessibility text size the reason and the hint competed for the same
    ///     width and whichever lost got an ellipsis. The reason IS the fix here
    ///     (see FrameFailure) — truncating it undoes the thing the panel exists
    ///     for, so now it wraps and the control keeps its own line.
    ///   • it was the app's only retry that wasn't a Button: seven other failures
    ///     offer "Retry"/"Try again", and VoiceOver announced this one as a
    ///     sentence with no action attached to it.
    ///
    /// And the exception has an exception: the card belongs to a peek the USER
    /// asked for. `body`'s automatic fetch fails too, and dressing THAT as an
    /// alarm with a Retry beside it made the sheet raise its voice about
    /// something nobody had tried — so an unasked failure keeps the reason and
    /// drops the chrome, which is `PeekShape`'s whole job.
    @ViewBuilder private var placeholder: some View {
        if case .alarm(let why) = peek {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(why).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .font(.caption2)
                .foregroundStyle(.orange)
                Button("Retry") { refresh(asked: true) }
                    .font(.caption2)
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
            }
            .devicePanel()
        } else {
            HStack(spacing: 6) {
                if case .working = peek {
                    ProgressView().controlSize(.mini)
                    // A frame is a full cloud round-trip through the relay,
                    // so say so — a silent spinner for 15s reads as a hang
                    // rather than as a camera waking up.
                    Text("asking the camera…")
                } else {
                    Image(systemName: "camera.viewfinder")
                    // The reason when there is one, the invitation when there
                    // isn't. One line either way — and the reason still wraps,
                    // because a clipped reason is the swallowed failure again.
                    Text(peek.quietReason ?? "tap to peek")
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .devicePanel()
            .contentShape(Rectangle())
            .onTapGesture { refresh(asked: true) }
            // The tap target is a rectangle with prose in it, so VoiceOver
            // had a label and no affordance — it read "tap to peek" and
            // offered nothing to activate.
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(peek.spoken)
            .accessibilityHint(peek.spokenHint ?? "")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let f = frame {
                Image(uiImage: f)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(height: 130)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(alignment: .topTrailing) {
                        if busy { ProgressView().controlSize(.mini).padding(6) }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { refresh(asked: true) }
                    // An Image built from UIImage carries no label, so the one
                    // element here a VoiceOver user could act on was silent.
                    .accessibilityElement()
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel("Latest camera frame")
                    .accessibilityHint("Fetches a new frame")
            } else if let unreachable {
                // Deliberately NOT the failure card: nothing failed. Grey and
                // one line, the shape every non-frame state on this sheet wears,
                // where the orange triangle used to sit for a board that was
                // simply asleep.
                Label(unreachable, systemImage: "moon.zzz")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .devicePanel()
            } else {
                placeholder
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                // Through ReadingAge, which the Flipper panel now shares: this
                // used to format the time inline, and the second reading on the
                // sheet was then free to date itself differently — or, as it
                // did, not at all.
                if let asOf = ReadingAge.asOf(stamp) {
                    Text(asOf).foregroundStyle(.secondary)
                }
                // The placeholder above can only speak when it's on screen; a
                // failed REFRESH keeps the last good frame, so the reason has to
                // have somewhere to go here too or it's swallowed all over again.
                // Wrapping, not clipping, for the same reason the placeholder's
                // does: a truncated reason is the failure this panel was built
                // to stop swallowing.
                if let error, frame != nil {
                    Text("· \(error)").foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(.caption2)
        }
        // Gated where it is AUTOMATIC, not inside refresh(): a tap is the user
        // overriding our guess about their own hardware, and this app's rule for
        // that is Retry, never a silent no-op. There is no tap target in the
        // unreachable state, so the two can't collide.
        //
        // `asked: false` is the ONLY false in this panel, and it is what lets a
        // failure from this line stay quiet — see PeekShape.
        .task { if unreachable == nil { refresh(asked: false) } }
    }

    /// Non-nil ⇒ don't call, say this. Read twice — once to render, once to
    /// decide — from ONE function, so the sentence and the silence agree.
    private var unreachable: String? {
        RelayReach.cameraNote(deviceName: deviceName, presence: presence)
    }

    /// `asked:` is false for exactly one caller — the appearance fetch in `body`.
    /// It records PROVENANCE and nothing else: the call happens either way, so a
    /// tap can never become a silent no-op.
    private func refresh(asked: Bool) {
        guard !busy else { return }
        self.asked = asked
        busy = true
        error = nil
        Task {
            switch await TinyLive.frameResult(deviceId: deviceId, token: token) {
            case .success(let img):
                frame = img
                stamp = Date()
            case .failure(let why):
                // A stale frame is worth more than a blank rectangle, so keep
                // whatever is already on screen and report the reason beneath.
                error = why.message.isEmpty ? nil : why.message
            }
            busy = false
        }
    }
}

/// 🕰️ The Voice panel's one-line summary of what the board says about itself.
///
/// Pulled out of the view for two reasons: the seconds needed a ladder, and two
/// of the three segments were asserting things a missing key can't distinguish
/// from a real zero. `handleStatus` decodes the status JSON with `?? 0` — the
/// whole notify has to fit a 64-byte BLE buffer, so an absent key is expected,
/// not exceptional — and both of those zeroes read as bad news:
///
///   • `up 0s` says the necklace rebooted a moment ago. On a wearable that is
///     the symptom of a reset loop, so a board that simply never sends `up`
///     would have the panel raising a crash alarm forever.
///   • `0 wake words` says the loaded net has no classes, i.e. this thing can
///     never wake — and it would sit directly under a green "listening" badge
///     saying the opposite. That contradiction has its own honest source: the
///     badge reads ndp && mic (VoiceStatus.listening), which is the fact that
///     actually answers "will it hear me".
///
/// So a zero drops its segment rather than narrating it. A freshly flashed board
/// loses one second of detail; nothing invents a failure. `wakes` is the one
/// count that keeps its zero, because "0 heard" is the expected reading rather
/// than an alarm — but only alongside a segment that proves the board answered
/// at all. A line reading just "0 heard" would be a status summary whose only
/// content is a number that might never have arrived.
///
/// The ladder is Activity.ago's and dmAgo's, deliberately: same units, same
/// round-DOWN, so "up 90m" reads as "up 1h" here exactly as an event 90 minutes
/// old reads "1h" in the activity list. A wearable's uptime is a glance, not a
/// stopwatch — the panel used to print `up \(s.uptimeS)s`, so a necklace worn
/// since breakfast read "up 41293s" in a line otherwise written in words.
enum VoiceFmt {
    /// Largest unit that still says something, or nil when the board didn't say.
    static func uptime(_ seconds: Int) -> String? {
        guard seconds > 0 else { return nil }
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3_600)h" }
        return "\(seconds / 86_400)d"
    }

    /// "3 wake words · 12 heard · up 11h" — segments joined only when they have
    /// something to say. nil when none of them do, so the caller renders no line
    /// at all instead of a stray "·" or an empty row of padding.
    /// The status this phone may still SPEAK for — nil once the link is down.
    ///
    /// Every segment of a status reading is a present-tense claim about a board
    /// somewhere else, and `status` is a LAST-KNOWN value: the gateway clears it
    /// in `forget()` only, never on disconnect, so the panel held a reading from
    /// whenever the necklace was last in range. It rendered "out of range" and,
    /// on the same line, a green "listening" — the one element that is a live
    /// claim was the one element that outlived the link, while the detail line
    /// beside it correctly went away. A necklace in a drawer looked like a
    /// necklace on a collar.
    ///
    /// One gate for both, so this panel cannot show half a stale reading. The
    /// wake list below it is untouched: those are timestamped events, and
    /// history stays true after the link drops.
    static func live(_ s: VoiceStatus?, connected: Bool) -> VoiceStatus? {
        connected ? s : nil
    }

    static func statusLine(_ s: VoiceStatus) -> String? {
        var parts: [String] = []
        if s.labels > 0 { parts.append("\(s.labels) wake word\(s.labels == 1 ? "" : "s")") }
        if s.labels > 0 || s.wakes > 0 { parts.append("\(s.wakes) heard") }
        if let up = uptime(s.uptimeS) { parts.append("up \(up)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// 🎙️ The Nicla Voice's panel — RelayCameraPanel's counterpart for a board with
/// no camera and no internet.
///
/// Everything here comes from the phone's own BLE link (NiclaVoiceGateway), not
/// from the server, because there is no server-side truth to read: the board
/// heartbeats only through this phone. That is also why the link state is shown
/// as prominently as the wake list — "no wakes" means something completely
/// different when the necklace is out of range than when it's listening.
struct VoiceDevicePanel: View {
    let deviceId: String
    @ObservedObject private var gw = NiclaVoiceGateway.shared
    @ObservedObject private var rec = NiclaRecorder.shared
    @AppStorage("cfg_record_on_wake") private var recordOnWake = true
    @State private var recordError: String?
    @State private var adopting = false
    @State private var adoptError: String?

    /// Only speak for the unit this phone actually paired. A second phone (or a
    /// necklace paired elsewhere) shows the row without claiming to gateway it.
    private var isMine: Bool { gw.unit?.deviceId == deviceId }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !isMine {
                // 🎙️ Not paired to THIS phone — and a Voice board cannot
                // heartbeat for itself, so until some phone adopts it the row
                // just sits in the fleet reading offline. This used to say "set
                // it up here to relay it", which pointed at the provisioning
                // sheet: that MINTS A NEW DEVICE ROW and leaves this one
                // orphaned forever (frozen last_seen, and its wake history and
                // transcripts stranded under the old id). Adopt instead —
                // /api/devices/adopt rotates the token on the row that already
                // exists, so the id, its events and its recordings all survive.
                Label("Paired to another phone or a computer.",
                      systemImage: "iphone.slash")
                    .font(.caption2).foregroundStyle(.secondary)
                Text("Adopting moves the necklace to this phone, keeping its history. The other client stops relaying it.")
                    .font(.caption2).foregroundStyle(.secondary)
                Button {
                    Task { await adopt() }
                } label: {
                    Label(adopting ? "Adopting…" : "Adopt on this phone",
                          systemImage: "iphone.badge.play")
                        .font(.caption2)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(adopting)
                if let adoptError {
                    Text(adoptError).font(.caption2).foregroundStyle(.orange)
                }
            } else {
                HStack(spacing: 6) {
                    Image(systemName: gw.connected ? "iphone.radiowaves.left.and.right" : "iphone.slash")
                        .foregroundStyle(gw.connected ? .green : .secondary)
                    Text(gw.connected ? "relayed by this phone" : "out of range")
                        .font(.caption2).foregroundStyle(.secondary)
                    // `live`, not `gw.status`: out of range, the last reading is
                    // not news about this board — and this badge is the only
                    // element here written in the present tense.
                    if let s = VoiceFmt.live(gw.status, connected: gw.connected) {
                        Spacer()
                        // The one thing you cannot tell from outside: a necklace
                        // whose model failed to load still advertises and still
                        // looks online, it just never hears anything.
                        Label(s.listening ? "listening" : "not listening",
                              systemImage: s.listening ? "waveform" : "waveform.slash")
                            .font(.caption2)
                            .foregroundStyle(s.listening ? .green : .orange)
                    }
                }
                // Already gated — through the same function now, so the badge and
                // the detail line cannot end up disagreeing about which readings
                // this phone is still entitled to show.
                if let s = VoiceFmt.live(gw.status, connected: gw.connected),
                   let line = VoiceFmt.statusLine(s) {
                    Text(line)
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let e = gw.lastError {
                    Text(e).font(.caption2).foregroundStyle(.orange)
                }
                if !gw.wakes.isEmpty {
                    Divider().padding(.vertical, 2)
                    ForEach(gw.wakes.prefix(4)) { w in
                        HStack(spacing: 6) {
                            Image(systemName: "waveform.badge.mic").foregroundStyle(.green)
                            Text("“\(w.label)”").font(.caption2)
                            Spacer()
                            Text(w.at.formatted(date: .omitted, time: .shortened))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                } else if gw.connected {
                    Text("Say the wake word — it appears here and on your tiny's activity.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                // 🎙️ The recorder half: wake → this phone records + transcribes
                // on-device (NiclaRecorder). Toggle is the OFF switch; the take
                // also lands in menu → Transcripts and the tiny's context.
                Divider().padding(.vertical, 2)
                Toggle(isOn: $recordOnWake) {
                    Label("Record 10s on wake", systemImage: "record.circle")
                        .font(.caption2)
                }
                .toggleStyle(.switch)
                .controlSize(.mini)
                HStack(spacing: 8) {
                    // One button, two jobs: start a take, or END the one running.
                    //
                    // It used to start a fixed 10s take and then go disabled for
                    // the duration — so a recorder a person operates had no Stop,
                    // and dictating anything longer than a sentence meant tapping
                    // again and stitching takes together. Now it opens a long
                    // window (the recorder's 120s ceiling) and you end it when
                    // you're done talking; everything captured up to that point
                    // is transcribed, uploaded and stored, and the take records
                    // its REAL length rather than the length that was requested.
                    Button {
                        if rec.isRecording {
                            NiclaRecorder.shared.stopEarly()
                            return
                        }
                        Task {
                            // `record` returns a written-out reason for every
                            // refusal — "voice mode is using the microphone —
                            // stop it first", "microphone/speech permission not
                            // granted on the phone", "speech recognition
                            // unavailable on this phone". Discarding the result
                            // with `_ =` turned all of them into a button that
                            // does nothing when pressed.
                            let r = await NiclaRecorder.shared.record(
                                seconds: 120, label: "manual", token: nil)
                            recordError = r.ok ? nil : (r.error ?? "Recording failed.")
                        }
                    } label: {
                        Label(rec.isRecording ? "Stop and save" : "Record",
                              systemImage: rec.isRecording ? "stop.circle.fill" : "mic.fill")
                            .font(.caption2)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .tint(rec.isRecording ? .red : nil)
                    // Hand back the board's ONE connection slot. The link is
                    // held permanently now (it deliberately survives
                    // backgrounding), and a BLE peripheral accepts a single
                    // central — so without this there is no way to let a Mac or
                    // another phone reach the necklace short of force-quitting
                    // the app. Re-dials on the next foreground, since .active
                    // calls start().
                    if gw.connected {
                        Button {
                            gw.stop()
                        } label: {
                            Label("Release", systemImage: "bolt.horizontal.circle")
                                .font(.caption2)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                    }
                    Spacer()
                    if rec.isRecording {
                        // A live input meter, because an open take with no
                        // feedback is indistinguishable from a broken one — and
                        // with the mic muted or the phone face-down in a pocket,
                        // "Recording…" alone is a claim the user cannot check.
                        // The recorder already publishes `level`; nothing showed
                        // it.
                        HStack(spacing: 1.5) {
                            ForEach(0 ..< 7, id: \.self) { i in
                                Capsule()
                                    .fill(Double(rec.level) * 7 > Double(i) ? Color.red : Color.secondary.opacity(0.25))
                                    .frame(width: 2, height: 4 + CGFloat(i) * 1.5)
                            }
                        }
                        .animation(.easeOut(duration: 0.15), value: rec.level)
                        .accessibilityLabel("Recording level")
                    } else if let last = rec.transcripts.first {
                        Text("last: “\(String(last.text.prefix(40)))”")
                            .font(.caption2).foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                if let recordError {
                    Text(recordError)
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
        }
        .devicePanel()
    }

    /// Take over an already-enrolled Voice without re-provisioning it.
    ///
    /// Two things are needed to gateway a board and this phone has neither: a
    /// TOKEN to heartbeat with, and the board's BLE peripheral UUID (which is
    /// host-specific — the id another phone recorded is meaningless here, so it
    /// has to be discovered locally).
    ///
    /// Order matters. The SCAN comes first, because rotating the token
    /// immediately kills the other client's credential: doing that before
    /// knowing the board is even in range would leave the necklace relayed by
    /// nobody. Failing on "can't see it" costs nothing; failing after the
    /// rotation costs the working link.
    ///
    /// Nothing is written to the BOARD. The Voice firmware never persists the
    /// identity it is sent — it only ACKs the payload and drops it (see
    /// tiny_voice.ino: cfgBuf is parsed for a terminator and never read again) —
    /// because the board has no radio to use a token with. The phone is what
    /// speaks to the API on its behalf, so the phone is the only place adoption
    /// has to land.
    @MainActor
    private func adopt() async {
        adopting = true
        adoptError = nil
        defer { adopting = false }

        let ble = Bluetooth.shared
        ble.startScan(duration: 6)
        try? await Task.sleep(for: .seconds(6.5))
        guard let found = ble.devices.first(where: { $0.tiny?.kind == .voice }) else {
            // Say WHICH failure it was. "Couldn't find it" sends the user
            // hunting for the necklace when the real problem is a radio switch.
            adoptError = ble.state == "unauthorized" ? "Bluetooth permission is denied for tiny on this phone."
                : ble.state == "poweredOff" ? "Bluetooth is turned off on this phone."
                : "Couldn't see the necklace nearby. Bring it closer — and if another phone is holding it, tap Release there first."
            return
        }

        guard let r: [String: Any] = try? await Api.post(
            "/api/devices/adopt", token: Keychain.get("tiny_token"),
            body: ["deviceId": deviceId]),
            let token = r["device_token"] as? String, !token.isEmpty
        else {
            adoptError = "Couldn't claim the necklace on the server. Check your connection and try again."
            return
        }

        // register() stores the token and starts the link. Only now does the
        // panel switch to the isMine branch, which is honest: this phone can
        // genuinely speak for the board from this point.
        gw.register(deviceId: deviceId, token: token, beaconId: found.id, name: found.name)
    }
}

/// 🐬 A Flipper Zero panel.
///
/// The Flipper has no network stack of its own: it is a CAPABILITY of whichever
/// machine it's plugged into (FLIPPER_INTEGRATION.md), so everything here is
/// really about that HOST. Two facts are free — which machine, and whether that
/// machine is awake — and those are shown immediately. The status probe costs a
/// full agent turn on the host, so it stays behind a tap instead of firing on
/// every appearance the way the old panel did.
struct FlipperDevicePanel: View {
    let deviceId: String
    let hostName: String
    let hostPresence: DevicePresence
    let token: String?
    @State private var status: String?
    /// When `status` was read. The line it dates is prose in the present tense —
    /// firmware, a battery percentage, which machine the cable is in — and none
    /// of those three facts stays true just because the panel is still on screen.
    @State private var stamp: Date?
    @State private var error: String?
    @State private var busy = false

    /// 15 × 2s. The host has to run an agent turn — open the serial port, drive
    /// the CLI, serialize a reply — so the old code's single 4s sleep reported
    /// "No reply within 4s" even when the Flipper answered perfectly.
    private static let pollTries = 15
    private static let pollEverySeconds = 2

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                // Same arm the chip reads, so header and chip can't drift; the
                // header still names itself in words if it ever goes missing.
                if let icon = capabilityIcon("flipper") {
                    Image(systemName: icon).foregroundStyle(.orange)
                }
                Text("Flipper Zero").font(.caption.bold())
                Spacer()
                if busy { ProgressView().controlSize(.mini) }
            }
            Text("plugged into \(hostName)")
                .font(.caption2).foregroundStyle(.secondary)
            // The rule this panel invented, now shared with the camera panel so
            // one sheet can't hold two answers to "can we reach it?".
            if !RelayReach.canReach(hostPresence) {
                // Honest wording, matching the backend flipper_status rule: the
                // Flipper is fine, the LAPTOP it lives on is asleep. Saying
                // "Flipper offline" sends the user to unplug a working cable.
                Label("\(hostName) isn't online — wake that machine to reach the Flipper.",
                      systemImage: "moon.zzz")
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                if let s = status {
                    Text(s)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    // Inside the same `if`, so an age can never be drawn without
                    // the reading it ages. Same words and same format as the
                    // camera panel's stamp — one sheet, one way of saying when.
                    if let asOf = ReadingAge.asOf(stamp) {
                        Text(asOf)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                if let e = error {
                    Text(e)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button(status == nil ? "Check status" : "Refresh") { Task { await check() } }
                    .font(.caption2)
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .disabled(busy)
            }
        }
        .devicePanel()
    }

    /// Ask the HOST's agent for the Flipper's status, over the device relay.
    ///
    /// Through `/api/devices/relay` — the session-authenticated proxy that holds
    /// the worker's internal key and fills in `userId` from the session. The old
    /// version POSTed `plugin.tiny.technology/device/relay/send` directly with
    /// the USER's bearer token; that route is `checkInternalKey`-gated and also
    /// requires `userId`, so it answered 401 every single time — which is the
    /// permanent "Relay send failed" this panel used to show.
    func check() async {
        guard let token, !busy else { return }
        busy = true
        // The READING survives the attempt to replace it. This began `status =
        // nil`, which blanked a good answer for the whole 30s poll and then threw
        // it away permanently if the poll failed — leaving the button reading
        // "Check status" again, as though the user had never checked. That is the
        // camera panel's documented rule inverted ("a stale frame is worth more
        // than a blank rectangle, so keep whatever is already on screen and
        // report the reason beneath"), on the same sheet, for the same event.
        // `stamp` is what makes keeping it honest rather than misleading.
        error = nil
        defer { busy = false }

        let sent = await Api.postBody("/api/devices/relay", token: token, body: [
            "toDevice": deviceId,
            // The proxy stringifies non-string payloads; the worker's contract is
            // JSON text (`sanitizeRelayPayload`), so either shape is accepted.
            "payload": ["type": "invoke",
                        "prompt": "Run flipper_status and report the Flipper's firmware, "
                                + "battery, and which machine it's plugged into."],
        ])
        guard let envId = sent?["id"] as? String, !envId.isEmpty else {
            // Show what the server actually said. "login required", "device not
            // found" and "relay unavailable" are three different problems, and
            // one blanket string sent the user looking at the wrong one.
            error = (sent?["error"] as? String) ?? "Couldn't reach the relay."
            return
        }

        let query = envId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? envId
        for _ in 0..<Self.pollTries {
            try? await Task.sleep(for: .seconds(Self.pollEverySeconds))
            guard let got: [String: Any] = await Api.getBody(
                "/api/devices/relay?inReplyTo=\(query)", token: token) else { continue }
            if let reply = got["reply"] as? [String: Any],
               let payload = reply["payload"] as? String {
                // The host's reply payload → the line to show. The agent answers
                // `{"result":"…"}`; other daemons answer `{"text":…}` or a bare
                // string. Anything unrecognised is shown verbatim rather than
                // silently dropped — a raw payload on screen is debuggable, a
                // blank panel is not. Shared with the camera panel, which faces
                // the same wire (RelayReply in TinyLive.swift).
                status = RelayReply.text(payload)
                // Beside the assignment it describes, so the reading and its age
                // cannot come from two different moments.
                stamp = Date()
                return
            }
        }
        error = "\(hostName) didn't answer in \(Self.pollTries * Self.pollEverySeconds)s — "
              + "is `tiny mesh` still running there?"
    }
}

struct DeviceRow: Identifiable {
    let id: String
    let name: String
    let kind: String
    let platform: String
    /// ⚠️ THREE-state on the wire: true/false for anything that heartbeats, and
    /// `nil` for an endpoint device, which has no heartbeat to report at all.
    /// Stays optional all the way to the view — see `DevicePresence`.
    let online: Bool?
    let lastSeen: Date?
    /// Parsed from the wire's JSON *string* — drives whether a camera is drawn.
    var capabilities: [String] = []

    /// Endpoint devices only: the https origin tiny dials out to. The worker
    /// lists it deliberately — "the owner needs to see where a body lives" — and
    /// this app was throwing it away, which is why a printer's row could only
    /// fall back to the word "robot".
    var url: String = ""

    /// Set on THIS device's row only, by `LocalHardware.corrected` — the word the
    /// app knows first-hand, where the wire's is lossy.
    ///
    /// A second field rather than a rewrite of `platform`, because `platform` is
    /// what the server said and what the server matches on: anything comparing it
    /// (`d.platform == "nicla-vision"` drives the necklace's camera panel) must
    /// keep seeing the wire, and anything DRAWING it wants this.
    var localPlatform: String? = nil

    /// The platform to draw. Identical to `platform` for every row but one.
    var shownPlatform: String { localPlatform ?? platform }

    /// An endpoint device is a robot at its own authenticated API (printer, rover),
    /// not something that heartbeats to us. Only these get a live panel.
    var isEndpoint: Bool { kind == "endpoint" }

    /// Whether the list will let you revoke this row. Revoking our own token
    /// signs the app out from under itself, so the swipe is withheld for this
    /// phone — and the footer that ADVERTISES that swipe reads this same
    /// function, because a sentence teaching a gesture has to be able to tell
    /// whether the gesture is there.
    func revocable(thisPhone: String?) -> Bool { id != thisPhone }

    var presence: DevicePresence {
        guard let online else { return .unknown }
        return online ? .online : .offline
    }

    /// "Mac" — what the thing IS, in the words the glyph beside it already uses.
    ///
    /// It printed both halves of the wire instead: "daemon · darwin-arm64",
    /// "endpoint · bambu", "daemon · nicla-vision". Three problems in one line.
    /// The words are identifiers a daemon posts to a server. They are also, read
    /// as English, false — a necklace is not a daemon and a 3D printer is not an
    /// endpoint. And they're REDUNDANT: `kind` describes how the device dialled
    /// in, which the platform already implies for every device that has one, so
    /// the honest line is one word and not two.
    ///
    /// Empty when neither field says anything, so `presenceLine` never joins a
    /// separator onto nothing.
    ///
    /// An endpoint device answers with its ADDRESS instead, matching the web row
    /// exactly (`d.url.replace(/^https:\/\//, "")`). A robot is the one device
    /// class with no platform to name — nothing self-reports for it, so the most
    /// this line could otherwise say is its `kind` in a nicer word, and "robot"
    /// is a category the glyph beside it has already drawn. Where the body lives
    /// is the fact the owner actually can't get anywhere else on this screen.
    /// The scheme is dropped because the worker normalises every endpoint to an
    /// https origin, so "https://" is eight identical characters on every row,
    /// spent on the widest thing in it.
    var descriptor: String {
        if isEndpoint {
            let host = url.trimmingCharacters(in: .whitespaces)
            if !host.isEmpty {
                return host.hasPrefix("https://") ? String(host.dropFirst(8)) : host
            }
        }
        return deviceLabel(platform: shownPlatform, kind: kind) ?? ""
    }

    /// `online · iOS` — the row's whole second line as ONE string.
    ///
    /// It lives here rather than on the view for the same reason `DeviceOrder`
    /// does: it is a pure function of the row, so it can be read and tested
    /// without a view hierarchy. Assembling it as one string is also what keeps
    /// the line whole — as four sibling views in an HStack, SwiftUI sized each
    /// piece on its own and at the accessibility text sizes the line came apart,
    /// stranding a "· ios-ar…" on a second row under a separator with nothing
    /// after it. And a row with no kind and no platform gets no trailing " · ".
    var presenceLine: String {
        [presence.label(lastSeen: lastSeen), descriptor]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /// `online` exactly as JSONSerialization hands it over: `true`/`false`,
    /// SQLite's 1/0 (NSNumber bridges to Bool for both), `NSNull` for an
    /// endpoint, or absent from an older worker. Only the first two are answers
    /// — everything else means "unknown", which is NOT the same as "offline".
    nonisolated static func parseOnline(_ raw: Any?) -> Bool? {
        if raw is NSNull { return nil }
        if let b = raw as? Bool { return b }
        return nil
    }
}

/// A titled group of rows — the devices list's shape.
struct DeviceGroup: Identifiable {
    let id: String
    let title: String
    let rows: [DeviceRow]
}

/// Ordering + grouping for the devices list. Pure, so it can be reasoned about
/// (and tested) apart from the view.
///
/// The worker sorts `ORDER BY last_seen DESC` and nothing else, and iOS added
/// no order of its own — which is not an order a person can read: a laptop that
/// went to sleep four minutes ago outranked the phone in your hand, and an
/// endpoint robot (`last_seen` NULL) sank below rows dead for a year. Presence
/// first, then recency.
enum DeviceOrder {
    /// Lower sorts first. Also the group index — the two must not drift, so the
    /// grouping below buckets on this exact function.
    static func rank(_ d: DeviceRow, myDeviceId: String?) -> Int {
        rank(d, isThisPhone: d.id == myDeviceId)
    }

    /// The same rule from the ROW's point of view: a row view knows whether it
    /// is this phone, not what the sheet's device id happens to be. One
    /// definition behind both spellings, so the line a row prints and the
    /// section it lands in cannot disagree about which section that is.
    static func rank(_ d: DeviceRow, isThisPhone: Bool) -> Int {
        if isThisPhone { return 0 }
        switch d.presence {
        case .online: return 1
        case .unknown: return 2
        case .offline: return 3
        }
    }

    /// Index 0 is not a constant: the section holding THIS device is named after
    /// it, and only the app knows what it is — see `LocalHardware`.
    ///
    /// A function of the shape rather than a `static let`, so the string a row
    /// compares its presence word against and the string on screen above it stay
    /// the same string on an iPad too — the whole of `rowLine` rests on that. The
    /// default is the shape that changes nothing, so every caller which isn't
    /// about hardware goes on saying exactly what it said before.
    static func groupTitles(_ shape: LocalHardware.Shape = .phone) -> [String] {
        [LocalHardware.selfTitle(shape), "Online", "Reachable when called", "Offline"]
    }

    /// The row's second line, given that its section header is already on
    /// screen directly above it.
    ///
    /// Presence was stated three times per row — the header, the dot, and the
    /// word — and in two of the four sections the word was a verbatim copy of
    /// the header two lines above it. It cost most where the row could least
    /// afford it: an endpoint read `reachable when called · p1s.ada.tiny.tech…`,
    /// spending 24 characters restating its own header and truncating the
    /// address, which is the one fact that row cannot get anywhere else on this
    /// screen. Settings.app draws the same distinction — its Bluetooth rows say
    /// "Connected" only because the header above them ("My Devices") doesn't.
    ///
    /// Written as a comparison and not a list of ranks so the two cannot drift:
    /// the row asks whether its presence word IS its header, so renaming a
    /// header or rewording a label keeps the rule true instead of quietly
    /// making it wrong. "Offline" keeps its word because `seen 3 days ago` is a
    /// DIFFERENT fact from the header — which is the whole reason that label
    /// exists ("3 minutes ago" and "in March" are the same word otherwise).
    ///
    /// The dot and the VoiceOver label still carry presence in full. The
    /// omission is only sound because the header is visible above the row, and
    /// a row read aloud has no header above it.
    static func rowLine(_ d: DeviceRow, isThisPhone: Bool,
                        shape: LocalHardware.Shape = .phone) -> String {
        let word = d.presence.label(lastSeen: d.lastSeen)
        let header = groupTitles(shape)[rank(d, isThisPhone: isThisPhone)]
        // Never empty the line: a daemon reporting neither platform nor kind has
        // no descriptor, and dropping the word there would DELETE the row's
        // second line rather than shorten it.
        guard header.caseInsensitiveCompare(word) == .orderedSame,
              !d.descriptor.isEmpty else { return d.presenceLine }
        return d.descriptor
    }

    /// The row as VoiceOver reads it.
    ///
    /// The row combines its children, so this string REPLACES every label inside
    /// it: the glyph is `.accessibilityHidden`, the pill and the second line are
    /// swallowed, and anything this leaves out is not available ANYWHERE on the
    /// screen to someone listening. It was leaving out what the device is. Every
    /// row read `<name>, online, can …` — a phone, a Mac, a necklace and a robot
    /// spoken in the same shape, told apart only by a name their owner chose,
    /// while the screen beside them said "iPad", "Flipper Zero", "Nicla Vision".
    /// The endpoint robot fared worst: its descriptor is its ADDRESS, documented
    /// two functions up as "the one fact that row cannot get anywhere else on
    /// this screen", and the spoken row never said it.
    ///
    /// Not raw parity with the visible row, in two places, both for the same
    /// reason `rowLine` exists — a repetition costs different amounts in
    /// different media:
    ///
    ///  - presence is stated IN FULL here. `rowLine` may drop it because the
    ///    section header is on screen directly above; a row read aloud has no
    ///    header above it.
    ///  - the sighted self row says its noun twice — a "this iPad" pill over
    ///    "online · iPad" — which an eye skips and an ear cannot. So the
    ///    duplicate is dropped by containment: "this iPad, online", but "this
    ///    phone, iOS, online", because there the second word carries a fact the
    ///    first one doesn't.
    static func spokenLabel(_ d: DeviceRow, isThisPhone: Bool,
                            shape: LocalHardware.Shape = .phone) -> String {
        let pill = isThisPhone ? LocalHardware.selfPill(shape) : ""
        let what = pill.localizedCaseInsensitiveContains(d.descriptor) ? "" : d.descriptor
        return [
            d.name,
            pill,
            what,
            d.presence.label(lastSeen: d.lastSeen),
            // Mapped, not raw: leave the tokens in and VoiceOver is the one
            // surface still reading "bluetooth underscore scan" out loud, on the
            // surface where a spoken identifier is least recoverable.
            //
            // `d.capabilities`, NOT the ribbon's visible prefix. The cap is a
            // width problem and a spoken row has no width, so the collapse is
            // visual only: this reads all twelve either way, which is also why
            // the "+N more" chip losing its own element to `.combine` costs
            // nothing — it would reveal text VoiceOver has already said.
            d.capabilities.isEmpty ? ""
                : "can \(d.capabilities.map(capabilityLabel).joined(separator: ", "))",
        ]
        // A blank name is a blank server field (`dev["name"] as? String` keeps an
        // empty string), and an empty part would open the row with a comma.
        .filter { !$0.isEmpty }
        .joined(separator: ", ")
    }

    static func sorted(_ rows: [DeviceRow], myDeviceId: String?) -> [DeviceRow] {
        rows.sorted { a, b in
            let (ra, rb) = (rank(a, myDeviceId: myDeviceId), rank(b, myDeviceId: myDeviceId))
            if ra != rb { return ra < rb }
            // Most recently seen first; a never-seen row sorts after any seen one.
            let ta = a.lastSeen?.timeIntervalSince1970 ?? -.greatestFiniteMagnitude
            let tb = b.lastSeen?.timeIntervalSince1970 ?? -.greatestFiniteMagnitude
            if ta != tb { return ta > tb }
            // Total order. Without a final tiebreak two rows matching on rank AND
            // timestamp — every endpoint, which has no timestamp at all — can
            // swap places between refreshes and the list visibly jitters.
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    static func grouped(_ rows: [DeviceRow], myDeviceId: String?,
                        shape: LocalHardware.Shape = .phone) -> [DeviceGroup] {
        let ordered = sorted(rows, myDeviceId: myDeviceId)
        return groupTitles(shape).enumerated().compactMap { i, title in
            let bucket = ordered.filter { rank($0, myDeviceId: myDeviceId) == i }
            return bucket.isEmpty ? nil : DeviceGroup(id: title, title: title, rows: bucket)
        }
    }
}

/// One device as a row: identity tile, name, presence, what it is, what it can
/// do — in that reading order.
struct DeviceRowView: View {
    let d: DeviceRow
    let isThisPhone: Bool
    @Environment(\.tinyAccent) private var accent

    /// Per row, and it survives a refresh: `ForEach(g.rows)` is keyed by device
    /// id, so a ribbon opened by hand stays open when the poll comes back —
    /// collapsing it under the user would read as the list fighting them.
    @State private var showAllCapabilities = false

    /// The dot carries presence — one of the two things the row exists to say —
    /// so it has to grow with the words. Fixed at 7pt it survived to AX-XXXL as
    /// a speck beside 30pt text, reading as dirt on the screen rather than a
    /// status light.
    @ScaledMetric(relativeTo: .caption2) private var dotSize: CGFloat = 7
    // The identity tile deliberately does NOT scale. It was tried: a
    // @ScaledMetric 38→56pt tile took 18pt out of the text column, which is
    // exactly what turned "ada-iphone" back into "ada-ipho…" at AX-XXXL. The
    // tile says what the thing IS and the name says WHICH one — when only one
    // can have the width, it goes to the name. (Settings.app makes the same
    // trade: its row icons hold still while the labels grow.)

    private var live: Bool { d.presence == .online }

    /// Three states, three shapes — filled accent / filled grey / hollow — so
    /// presence survives colour-blindness and a monochrome screenshot. Local
    /// rather than `StatusDot` because StatusDot is a two-state primitive and
    /// this is the one place in the app where "unknown" is a real answer.
    private var presenceDot: some View {
        Circle()
            .fill(live ? accent : (d.presence == .unknown ? .clear : Color.secondary.opacity(0.55)))
            .frame(width: dotSize, height: dotSize)
            .overlay {
                if d.presence == .unknown {
                    Circle().strokeBorder(Color.secondary.opacity(0.7), lineWidth: 1)
                }
            }
            .accessibilityHidden(true)
    }

    /// Two lines, because the name is the one string in the row a person is
    /// actually looking for. `lineLimit(1)` cut "ada-iphone" to "ada-…" the
    /// moment anything shared its line.
    private var name: some View {
        Text(d.name).fontWeight(.medium).lineLimit(2)
    }

    /// Read once per row, on the main actor where `body` already is. A constant
    /// for the life of the process — an iPad does not become a phone — so this is
    /// a lookup, not a subscription.
    private var shape: LocalHardware.Shape { LocalHardware.current }

    private var thisPhonePill: some View {
        // "this iPad" on an iPad. The pill and the section header above it take
        // the same noun from `LocalHardware`, so the two cannot drift.
        Text(LocalHardware.selfPill(shape))
            .font(.caption2)
            .lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(accent.opacity(0.15), in: Capsule())
            .foregroundStyle(accent)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // `shownPlatform`, not `platform`: this device's own row draws the
            // hardware the app is running on rather than the word the wire could
            // manage. Every other row is unchanged — see `LocalHardware`.
            Image(systemName: deviceGlyph(platform: d.shownPlatform, kind: d.kind))
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(live ? accent : Color.secondary)
                .frame(width: 38, height: 38)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(live ? accent.opacity(0.15) : Color(.tertiarySystemFill))
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                // At the accessibility text sizes the pill and the name fought
                // over one line and the name lost: "ada-iphone" rendered as
                // "ada-…" beside a green ellipse the size of the icon tile,
                // because a Capsule around two wrapped lines is a blob. Given
                // its own line the pill stays one line and the name keeps the
                // width. Same ViewThatFits pattern as the wallet's two capsules.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) { name; if isThisPhone { thisPhonePill } }
                    VStack(alignment: .leading, spacing: 4) { name; if isThisPhone { thisPhonePill } }
                }
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    presenceDot
                    // ONE Text, not four siblings in an HStack. As an HStack this
                    // line came apart at the accessibility sizes — SwiftUI sized
                    // each piece on its own, so "· ios-ar…" ended up stranded on
                    // a second line under a floating separator while the middle
                    // word drifted right. Prose wraps; a row of siblings shatters.
                    //
                    // `rowLine`, not `presenceLine`: under a header that already
                    // says "Online", the word "online" is the row's own echo and
                    // it is charged the width of the line it shares.
                    //
                    // The shape travels with it because the header it compares
                    // itself against is now named after this device ("This
                    // iPad"): a row asking the question against a title nobody
                    // sees would answer it for the wrong screen.
                    Text(DeviceOrder.rowLine(d, isThisPhone: isThisPhone, shape: shape))
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                if !d.capabilities.isEmpty {
                    let ribbon = CapabilityRibbon.split(d.capabilities, expanded: showAllCapabilities)
                    FlexWrap(spacing: 4, lineSpacing: 4) {
                        ForEach(ribbon.shown, id: \.self) { CapabilityChip(cap: $0) }
                        // Last, so it reads as the end of the list rather than as
                        // a chip in it — FlowChips puts its "+N more" here too.
                        if let more = CapabilityRibbon.toggleLabel(d.capabilities,
                                                                  expanded: showAllCapabilities) {
                            Button { showAllCapabilities.toggle() } label: {
                                // Accent, where a capability chip is secondary
                                // grey: the one chip in the strip that DOES
                                // something has to look unlike the ones that
                                // only say something. Same 7/3 padding, so it
                                // still belongs to the ribbon.
                                Text(more)
                                    .font(.caption2)
                                    .foregroundStyle(accent)
                                    .padding(.horizontal, 7).padding(.vertical, 3)
                                    .background(accent.opacity(0.12), in: Capsule())
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        // Assembled beside `rowLine`, not here: the spoken row and the visible
        // row are two renderings of one set of facts, and the rules for what each
        // may leave out only make sense read against each other.
        .accessibilityLabel(DeviceOrder.spokenLabel(d, isThisPhone: isThisPhone, shape: shape))
    }
}

/// One piece of tiny hardware in radio range, offered for setup — the AirPods
/// card, brought into the device list.
///
/// Pairing used to live behind its own menu item ("Nearby devices"), which you
/// had to already know existed: the necklace in your hand was invisible from
/// the one screen named after your devices, and the empty-list text could only
/// tell you to go looking elsewhere. Here the offer sits where the question
/// gets asked.
struct NearbyBeaconCard: View {
    let d: BleDevice
    let onSetUp: () -> Void
    @Environment(\.tinyAccent) private var accent

    /// Bars rather than a dBm number, and a rising staircase rather than three
    /// equal dots, so strength survives a monochrome screenshot.
    private var signal: some View {
        let lit = BleSignal.bars(rssi: d.rssi)
        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(1 ... BleSignal.maxBars, id: \.self) { i in
                Capsule()
                    .fill(i <= lit ? accent : Color.secondary.opacity(0.3))
                    .frame(width: 3, height: 3 + CGFloat(i) * 2.5)
            }
        }
        .accessibilityHidden(true)
    }

    /// The board identifies itself in its BLE local name, which is what `d.name`
    /// already shows — so this line carries the one thing the name can't:
    /// whether the thing has been configured before, i.e. whether tapping means
    /// "set up" or "redo the WiFi".
    ///
    /// It deliberately does NOT name the board type. A beacon's version byte
    /// distinguishes a Vision from a Voice, but the mapping for that is landing
    /// separately (`TinyBeaconInfo.Kind`); a second copy here would be two
    /// sources of truth for one wire format.
    private var detail: String {
        guard let t = d.tiny else { return "tiny hardware" }
        return t.provisioned ? "configured · ready to reconfigure" : "ready to set up"
    }

    var body: some View {
        HStack(spacing: 12) {
            // iOS's own "add this device" glyph — the same visual language as the
            // AirPods card this borrows its shape from.
            Image(systemName: "badge.plus.radiowaves.right")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(accent)
                .frame(width: 38, height: 38)
                .background(RoundedRectangle(cornerRadius: 10).fill(accent.opacity(0.15)))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(d.name).fontWeight(.medium).lineLimit(1)
                HStack(spacing: 5) {
                    signal
                    Text(detail).lineLimit(1)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            // Combined on the text only — the button stays its own element so
            // VoiceOver can reach the action directly.
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(d.name), \(detail), \(BleSignal.label(rssi: d.rssi))")
            Spacer(minLength: 0)
            Button(d.tiny?.provisioned == true ? "Reconfigure" : "Set up", action: onSetUp)
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.vertical, 2)
    }
}

/// A devices list with no devices in it.
///
/// Every other state-rich screen here has a harness (graph, memory list, map,
/// voice call) and this one — the screen with the most states of any of them —
/// had none, because its rows come from enrolled hardware. So the four panels
/// `cell(_:)` can grow, the three presence states, and the pairing card were
/// only ever visible to someone holding a Mac, a robot, a Flipper and two
/// necklaces at once. Nobody has that on a desk, which is exactly why the
/// screen drifted: "not properly designed" is easy to miss when you can't look
/// at it.
///
/// The dataset picks one row per branch rather than a tidy set, and follows the
/// other harnesses' rules: fixed ids, no clock reads (a `Date()` would move the
/// frame run to run), and decoded by `DevicesView.decodeDevices` — the real
/// parser — so the harness cannot pass while the wire path is broken.
enum DevicesHarness {
    static let flag = "--devices-harness"
    static let sheetFlag = "--devices-sheet-harness"

    /// Substitute the demo fleet for the account's real devices? Either flag.
    static func usesDemoDataset(arguments: [String]) -> Bool {
        arguments.contains(flag) || arguments.contains(sheetFlag)
    }

    /// Auto-present the sheet on appear? ONLY the sheet flag — the same split
    /// the graph and memory harnesses use, and for the same reason: a dataset
    /// swap must leave navigation alone so a driver can make its own taps,
    /// while a screenshot run needs the sheet up with no taps available at all.
    static func autoOpensSheet(arguments: [String]) -> Bool {
        arguments.contains(sheetFlag)
    }

    /// The id the harness fleet's phone row carries, so `isThisPhone` and the
    /// rank-0 sort render — both are invisible otherwise, and the row that must
    /// never offer Revoke is exactly the one worth photographing.
    static let myDeviceId = "dev-phone"

    #if DEBUG
    /// What /api/devices would send. One row per `cell(_:)` branch, in the wire's
    /// own shapes: `online` as a bool AND as the endpoint's `null`, capabilities
    /// as the JSON *string* the worker really sends, deliberately unsorted so
    /// `decodeDevices`' sort has something to do.
    ///
    /// Every `kind`, `platform` and capability list below comes from the code
    /// that actually enrolls that device — Session.enroll (ios-arm64; its list is
    /// now READ, not retyped, see phoneCapabilitiesJSON), TinySetup (the
    /// necklaces' 6 and 4), tiny-tech's
    /// device.ts + device-tools.ts (`mcp`/`files` plus a label per resolved
    /// tool). The first draft invented them, and invented ones are worse than
    /// none: `platform: "iphone"` misses the `ios` glyph needle and drew a CPU
    /// chip on the phone, and 2-chip rows hid what a real Mac's dozen do to the
    /// row height. A harness that renders values the wire never carries is a
    /// picture of a screen this app doesn't have.
    /// The phone row's capability list, **derived — never copied**.
    ///
    /// The comment above says "copied from the code that actually enrolls that
    /// device", and a copy drifts: the day `screenshot` joined
    /// `TinySession.capabilities` the literal here still listed 8, so the harness
    /// drew a phone that enrolls less than this app does — and this harness is
    /// what the store screenshots are shot from. A test asserts the two sets are
    /// equal, which a literal can only satisfy until the next capability lands.
    ///
    /// ⚠️ That test is NOT vacuous now: the wire carries capabilities as a JSON
    /// *string*, so it still proves `decodeDevices` round-trips this list back to
    /// exactly what we enroll. Don't delete it as tautological.
    static var phoneCapabilitiesJSON: String {
        "[" + TinySession.capabilities.map { "\"\($0)\"" }.joined(separator: ",") + "]"
    }

    static func serverWire() -> [[String: Any]] {
        [
            // This phone — the row that must never offer Revoke. Session.swift
            // enrolls `<login>-iphone` / ios-arm64 / daemon.
            ["id": myDeviceId, "name": "ada-iphone", "kind": "daemon", "platform": "ios-arm64",
             "online": true, "last_seen": NSNumber(value: 1_770_000_000),
             "capabilities": phoneCapabilitiesJSON],
            // A mesh Mac: `npx tiny-tech mesh` enrolls kind `cli`, and every
            // device tool that resolved on that machine rides along as a label.
            // A developer's laptop really does declare this many.
            ["id": "dev-mac", "name": "ada-studio", "kind": "cli", "platform": "darwin-arm64",
             "online": true, "last_seen": NSNumber(value: 1_770_000_000),
             "capabilities": "[\"mcp\",\"files\",\"apple\",\"computer\",\"windows\",\"ocr\","
                 + "\"browse\",\"desktop\",\"voice\",\"see\",\"spotify\",\"google\"]"],
            // The Flipper's host — a headless box whose capabilities grow a panel.
            ["id": "dev-flip", "name": "ada-bench-pi", "kind": "cli", "platform": "linux-arm64",
             "online": true, "last_seen": NSNumber(value: 1_769_999_400),
             "capabilities": "[\"mcp\",\"files\",\"flipper\",\"adb\",\"browse\"]"],
            // An endpoint robot: `online` is null on the wire, NOT false — the
            // three-state parse this row exists to keep honest. Its platform is
            // "" because that is what a real one has: only a self-reporting
            // daemon sends a platform, and the enroll form posts {name, kind}.
            // It read "bambu" here, which made the harness the one place in the
            // world where a printer's row said what hardware it was.
            // It carries a `url` because a real endpoint always does — the worker
            // rejects an enroll without one — and that address is this row's
            // whole second line.
            ["id": "dev-printer", "name": "bambu-p1s", "kind": "endpoint", "platform": "",
             "url": "https://p1s.ada.tiny.technology",
             "online": NSNull(), "capabilities": "[\"print\",\"camera\",\"telemetry\"]"],
            // Vision necklace — camera panel over the relay. TinySetup enrolls
            // the BLE local name, kind `daemon`, and claims six.
            ["id": "dev-vision", "name": "tiny-vision", "kind": "daemon", "platform": "nicla-vision",
             "online": true, "last_seen": NSNumber(value: 1_770_000_000),
             "capabilities": "[\"camera\",\"mic\",\"tof\",\"imu\",\"ble\",\"wifi\"]"],
            // Voice necklace — no camera, no WiFi; its panel is the BLE link.
            ["id": "dev-voice", "name": "tiny-voice", "kind": "daemon", "platform": "nicla-voice",
             "online": false, "last_seen": NSNumber(value: 1_769_913_600),
             "capabilities": "[\"mic\",\"wake\",\"imu\",\"ble\"]"],
        ]
    }

    /// What the radio would have found. Two beacons so the card renders in both
    /// of its states — an unconfigured board offering "Set up" and a configured
    /// one offering "Reconfigure" — at signal strengths either side of a bar
    /// threshold, since a pair at the same strength would leave the staircase
    /// looking like decoration.
    static func beacons() -> [BleDevice] {
        [
            BleDevice(id: UUID(uuidString: "00000000-0000-0000-0000-0000000000A1")!,
                      name: "tiny-vision", rssi: -48,
                      tiny: TinyBeaconInfo(version: 1, provisioned: false)),
            BleDevice(id: UUID(uuidString: "00000000-0000-0000-0000-0000000000A2")!,
                      name: "tiny-voice", rssi: -71,
                      tiny: TinyBeaconInfo(version: 2, provisioned: true)),
        ]
    }
    #endif
}

/// What the devices list says about itself under the rows.
///
/// The footer answered the two questions a devices list raises — how many can I
/// have, how do I add one — and then answered a third nobody asked, always the
/// same way: "Swipe a row to revoke its token." Two reachable states get that
/// sentence with nothing to swipe:
///
///   • a fresh account holding one iPhone. `cell` attaches the revoke action
///     only to a `revocable` row, so the single row on screen has no swipe at
///     all and the footer teaches a gesture that does nothing. This is the FIRST
///     thing a new user sees on this sheet.
///   • somebody holding a brand-new necklace: no devices yet, a beacon in range.
///     The "No devices yet" screen is withheld exactly so the pairing card can
///     show, so the list IS the pairing card plus this footer — which said
///     "swipe a row" under zero rows, and counted them as "0 of 20 devices".
///
/// At the other end the two sentences contradicted each other: the count said
/// the account was full while the line beneath it explained how to add another.
/// The worker refuses that enrollment with "device limit reached (20) — revoke
/// one first" (worker/src/devices.ts), so say the same thing here
/// instead of instructions that can only end in that error.
///
/// Pure, like `BleEmptyState` two rows down the same sheet: what a surface may
/// claim is decided where it can be tested, not inside a `VStack`.
enum DevicesFooter {
    /// The worker's `MAX_DEVICES_PER_USER`, not a number this app picked.
    static let cap = 20

    /// True once enrollment can only fail. `>=` rather than `==` because a cap
    /// lowered server-side leaves accounts sitting above it, and those need the
    /// same sentence.
    static func full(_ total: Int) -> Bool { total >= cap }

    /// `revocable` is the count of rows the swipe is actually offered on — see
    /// `DeviceRow.revocable`. The hint rides on there being at least one, which
    /// is the honest condition: the gesture reveals its own absence on the rows
    /// that don't have it, but only if the user finds one that does.
    static func count(total: Int, revocable: Int) -> String {
        let have = total == 0 ? "No devices yet — room for \(cap)."
                              : "\(total) of \(cap) devices."
        guard revocable > 0 else { return have }
        return "\(have) Swipe a row to revoke its token."
    }
}

/// 🔴 What to say when a revoke did NOT happen.
///
/// The sheet's one destructive action was also the one request in this app that
/// threw the server's answer away: `ok = code < 400`, body discarded, and a single
/// sentence — "Couldn't revoke — try again." — for a rejected session, a malformed
/// request, a worker that refused, and a transport blip alike.
///
/// Two of those cannot be fixed by trying again, and the app already knows which:
/// `Api.httpMessage` is the shared table `HTTPErrorTests` exists to keep from
/// drifting ("Session expired — sign out and back in" for a 401, the server's own
/// words where the server is describing THIS request). Revoke was a third copy,
/// and the least accurate one — it told the user to repeat an action that could
/// only fail again.
///
/// It also never said the thing that matters. **A revoke that fails leaves the
/// device's token working.** Someone revoking a phone they have just lost needs
/// that fact, not a diagnosis of the request — and "try again" implies the
/// opposite, that nothing has been decided yet.
///
/// Web parity: `lib/devices/revoke-message.ts`, same lead clause.
enum RevokeFailure {
    /// The outcome clause, before any reason. Byte-identical on web (pinned).
    static let lead = "Not revoked — its token still works."

    /// nil when the token really is dead; the sheet's red line when it isn't.
    ///
    /// `status == nil` means no response arrived at all, which is status 0 in the
    /// house table — not a 4xx, and not something to retry blindly.
    ///
    /// ⚠️ Success requires the route's own `ok` flag AND a 2xx. A 200 whose body
    /// says otherwise is not a revoke, and this sheet is the wrong place to
    /// assume the two always agree.
    static func message(status: Int?, body: [String: Any]?) -> String? {
        if let status, (200...299).contains(status), (body?["ok"] as? Bool) == true { return nil }
        return lead + " " + Api.httpMessage(status ?? 0, body?["error"] as? String)
    }
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
    /// 💎 Pairing lives here now, not behind a separate menu item.
    @ObservedObject private var ble = Bluetooth.shared
    @State private var setupTarget: BleDevice?

    /// A harness run has no Keychain device id, and `myDeviceId` nil silently
    /// turns off two things worth looking at: the "this phone" pill and the
    /// rank-0 sort that floats this phone to the top.
    private var thisPhone: String? {
        #if DEBUG
        if DevicesHarness.usesDemoDataset(arguments: ProcessInfo.processInfo.arguments) {
            return DevicesHarness.myDeviceId
        }
        #endif
        return myDeviceId
    }

    /// Only tiny beacons are offered. A raw BLE sweep also sees the neighbour's
    /// TV and every pair of headphones on the train, and none of those can
    /// become a tiny — listing them under "My devices" would be noise wearing
    /// the clothes of an offer. Strongest signal first: the nearest board is
    /// almost always the one being held.
    private var beacons: [BleDevice] {
        ble.devices.filter { $0.tiny != nil }.sorted { $0.rssi > $1.rssi }
    }

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
                // An account with no devices at all is possible (web-only signup),
                // and an empty List looked like a failed load. Say what a device
                // even is and how to get one. Withheld the moment a beacon is in
                // range — "no devices yet" is the wrong thing to show someone
                // holding a necklace we could enroll in the next thirty seconds.
                case .loaded where devices.isEmpty && beacons.isEmpty:
                    ContentUnavailableView {
                        Label("No devices yet", systemImage: TinyDesign.iconDevices)
                    } description: {
                        Text("Run `npx tiny-tech@latest mesh` on a Mac or Linux box and it enrolls itself here — then your tiny can act on it. A necklace in range shows up on this screen by itself.")
                    }
                case .loaded:
                    List {
                        if let e = revokeError {
                            Section { Text(e).font(.caption).foregroundStyle(.red) }
                        }
                        ForEach(groups) { g in
                            Section {
                                ForEach(g.rows) { d in cell(d) }
                            } header: {
                                Text(g.title)
                            }
                        }
                        nearbySection
                    }
                }
            }
            // Pull-to-refresh means "tell me what's true now", which includes the
            // radio: a necklace switched on since the sheet opened should appear
            // on the same gesture that refreshes everything else.
            .refreshable { revokeError = nil; ble.startScan(duration: Self.scanWindow); await load() }
            .sheet(item: $setupTarget) { d in TinySetupView(beacon: d) }
            .navigationTitle("My devices")
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
        // Presence expires after the worker's 60s window, so a panel left open
        // starts lying inside a minute — the same reason web's /devices repolls.
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
                await load(silent: true)
            }
        }
        .task {
            #if DEBUG
            // Hand the scanner its findings instead of starting one: a real scan
            // would clear the list and then find nothing on a simulator with no
            // radio, so the pairing card — the thing the harness exists to show —
            // would never appear.
            if DevicesHarness.usesDemoDataset(arguments: ProcessInfo.processInfo.arguments) {
                ble.devices = DevicesHarness.beacons()
                return
            }
            #endif
            ble.startScan(duration: Self.scanWindow)
        }
        // Clears the scanner's standing "somebody wants a scan" flag as well as
        // the radio, so a closed sheet can't have a scan resume behind it.
        .onDisappear { ble.stopScan() }
    }

    /// Longer than the 8s default: this scan runs while the user reads a list
    /// rather than while they stare at a spinner, and a necklace waking from
    /// sleep can take a few seconds to advertise.
    private static let scanWindow: TimeInterval = 14

    private var groups: [DeviceGroup] {
        // One place where the fleet becomes sections, so one place corrects the
        // one row this app has first-hand knowledge of — see `LocalHardware`.
        let shape = LocalHardware.current
        return DeviceOrder.grouped(LocalHardware.corrected(devices, thisDeviceId: thisPhone,
                                                           shape: shape),
                                   myDeviceId: thisPhone, shape: shape)
    }

    /// The pairing section, always last: it is the "add something" affordance,
    /// and it carries the list's closing footer so the counts and the offer read
    /// as one thought instead of the footer stranding mid-list.
    @ViewBuilder private var nearbySection: some View {
        Section {
            if beacons.isEmpty {
                HStack(spacing: 8) {
                    Text(BleEmptyState.message(scanning: ble.scanning, state: ble.state,
                                               completedScan: ble.completedScan))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    if !ble.scanning {
                        Button("Scan") { ble.startScan(duration: Self.scanWindow) }
                            .font(.caption.weight(.semibold))
                    }
                }
            } else {
                ForEach(beacons) { d in
                    NearbyBeaconCard(d: d) { setupTarget = d }
                }
            }
        } header: {
            HStack(spacing: 6) {
                Text("Nearby")
                if ble.scanning { ProgressView().controlSize(.mini) }
            }
        } footer: {
            footer
        }
    }

    /// Extracted from `body` on purpose: with the row, four conditional panels
    /// and the swipe action inlined, this view's type-check cost lands on the
    /// same generic-depth cliff that makes Debug builds of ChatView SIGSEGV.
    @ViewBuilder private func cell(_ d: DeviceRow) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            DeviceRowView(d: d, isThisPhone: d.id == thisPhone)
            // 🤖 A robot's chamber camera + telemetry, always visible (web
            // parity). Only endpoint devices poll anything — every other row
            // costs nothing extra.
            if d.isEndpoint {
                EndpointPanel(deviceId: d.id, deviceName: d.name,
                              capabilities: d.capabilities, token: token)
                    .devicePanel()
            }
            // 💎 The necklace's camera — EndpointPanel's sibling for PULL
            // devices: frames arrive via a relay `frame` invoke, not the
            // endpoint proxy.
            if d.platform == "nicla-vision", d.capabilities.contains("camera") {
                // `presence` travels with it for the same reason the Flipper's
                // host presence does: the panel has to know whether the relay
                // can land before it spends 19 seconds finding out.
                RelayCameraPanel(deviceId: d.id, deviceName: d.name,
                                 presence: d.presence, token: token)
            }
            // 🎙️ The Voice necklace has no camera and no WiFi — its panel
            // reports the BLE link this phone holds for it, which IS its
            // connection.
            if d.platform == "nicla-voice" {
                VoiceDevicePanel(deviceId: d.id)
            }
            // 🐬 The Flipper is USB-only: its panel is really about the host it
            // hangs off, so the host's name and presence go in with it.
            if d.capabilities.contains("flipper") {
                FlipperDevicePanel(deviceId: d.id, hostName: d.name,
                                   hostPresence: d.presence, token: token)
            }
            // 🐬📶 …and the OTHER route to the same board: the BLE link THIS
            // phone holds. It hangs off this phone's row rather than a host's,
            // because with no cable anywhere the phone IS the host — which is
            // the whole point of it (docs/flipper-ble-ios-design.md).
            if d.id == thisPhone {
                FlipperBlePanel()
            }
        }
        .padding(.vertical, 2)
        // Revoke — but never for THIS phone (would sign us out from under
        // ourselves). One rule, shared with the footer that advertises it.
        .swipeActions {
            if d.revocable(thisPhone: thisPhone) {
                Button(role: .destructive) { pendingRevoke = d } label: {
                    Label("Revoke", systemImage: "xmark.circle")
                }
            }
        }
    }

    /// How many rows the swipe is actually offered on — the same function that
    /// decides whether each row gets it, so the footer can't advertise a gesture
    /// the list withheld.
    private var revocable: Int {
        devices.filter { $0.revocable(thisPhone: thisPhone) }.count
    }

    /// Answers the two questions a devices list raises but never used to: how
    /// many can I have, and how do I add one? What it may CLAIM while answering
    /// them is `DevicesFooter`'s.
    @ViewBuilder private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(DevicesFooter.count(total: devices.count, revocable: revocable))
            // Literals, not strings from the enum: this line's backticked command
            // is Markdown that `Text` only parses in a literal, and the point of
            // naming the command is that it can be read and typed.
            if DevicesFooter.full(devices.count) {
                Text("That's the limit — revoke one to make room for another.")
            } else {
                Text("Add a Mac or Linux box with `npx tiny-tech@latest mesh` — it enrolls itself. Hold a necklace near the phone and it appears under Nearby.")
            }
        }
        .font(.caption2)
    }

    /// `silent` = a background repoll. Those must never downgrade a good list to
    /// the error screen: the rows on it were true 30 seconds ago, and a subway
    /// tunnel is not a reason to throw the user's devices away.
    private func load(silent: Bool = false) async {
        #if DEBUG
        if DevicesHarness.usesDemoDataset(arguments: ProcessInfo.processInfo.arguments) {
            devices = Self.decodeDevices(DevicesHarness.serverWire())
            state = .loaded
            return
        }
        #endif
        // ⚠️ `do/catch`, not `try?`. The thrown `ApiError` is the only thing that
        // knows WHICH failure this was, and dropping it is what made this sheet
        // offer the reader both a session fix and a signal fix at once.
        do {
            let d: [String: Any] = try await Api.get("/api/devices", token: token)
            devices = Self.decodeDevices(d["devices"] as? [[String: Any]] ?? [])
            state = .loaded
        } catch {
            if !silent { state = .failed(LoadFailure.message(error)) }
        }
    }

    /// Wire → rows. Extracted so the harness dataset goes through the SAME parser
    /// as a real response — the graph and memory harnesses' rule. A harness with
    /// its own decoder can only ever prove that the decoder it isn't using works.
    static func decodeDevices(_ raw: [[String: Any]]) -> [DeviceRow] {
        raw.compactMap { dev in
            guard let id = dev["id"] as? String else { return nil }
            return DeviceRow(
                id: id,
                name: dev["name"] as? String ?? "device",
                kind: dev["kind"] as? String ?? "?",
                platform: dev["platform"] as? String ?? "",
                // ⚠️ THREE-state — see DeviceRow.parseOnline. The old expression
                // collapsed the worker's `null` (an endpoint has no heartbeat to
                // report) into `false`, so every robot rendered as offline and
                // sorted with the dead machines.
                online: DeviceRow.parseOnline(dev["online"]),
                lastSeen: (dev["last_seen"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) },
                // Sorted so the chips don't reshuffle on every refresh: the
                // server's order is whatever the daemon happened to declare.
                //
                // By the LABEL, because that is the only order anyone can see.
                // Sorting the tokens put the necklace's strip in the order
                // ble/camera/imu/mic/tof/wifi, which reaches the screen as
                // "bluetooth camera motion mic distance Wi-Fi" — alphabetical by
                // a key the user is not shown, and therefore indistinguishable
                // from unsorted. A list ordered by an invisible field looks like
                // a list nobody ordered. Ties fall back to the token so the
                // result is still total and still stable across refreshes.
                capabilities: EndpointTelemetry.parseCapabilities(dev["capabilities"])
                    .sorted {
                        let (a, b) = (capabilityLabel($0), capabilityLabel($1))
                        return a == b ? $0 < $1
                            : a.localizedCaseInsensitiveCompare(b) == .orderedAscending
                    },
                // The worker sends this for endpoint kinds only, on purpose, and
                // this decoder dropped it — so the one device class with nothing
                // else to say about itself said nothing.
                url: dev["url"] as? String ?? "")
        }
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
        // ⚠️ The BODY, not just the status code. The route answers a typed failure
        // (login required / deviceId required / revoke failed / a transport blip
        // marked `retryable`) and the status alone cannot tell the user which of
        // those left their device's token alive.
        var status: Int?
        var body: [String: Any]?
        if let (data, resp) = try? await URLSession.shared.data(for: req) {
            status = (resp as? HTTPURLResponse)?.statusCode
            body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        // `load()` first, unconditionally: the server decides whether the row is
        // gone. A row that vanished from the list while its token still worked
        // would be the worst outcome available here, so nothing is dropped
        // optimistically — and a successful revoke needs no sentence, because the
        // row disappearing IS the message.
        await load()
        revokeError = RevokeFailure.message(status: status, body: body)
    }
}

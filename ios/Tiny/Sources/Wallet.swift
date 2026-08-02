/**
 * WalletView — the native port of the web /wallet page (app/wallet/page.tsx).
 *
 * The app used to map an HTTP 402 to a bare "top up at tiny.technology/wallet"
 * string (Api.friendlyHTTPError) — the one payment surface that hadn't come
 * home to the app. This closes it: balance, get-USDC, deposit (link address →
 * claim by tx hash), self-serve withdraw, and the ledger, all against the same
 * session-gated /api/wallet the web hits (getSession honors our Bearer token).
 *
 * Money moves in the worker's D1 (micro-USDC ledger, 1_000_000 = $1); this is
 * only the surface. Presented as a NavigationLink from Settings, so it inherits
 * the enclosing NavigationStack (no sheet chrome of its own).
 */
import SwiftUI
import UIKit

/// One ledger row (matches the web LedgerEntry shape).
private struct WalletEntry: Identifiable {
    let id = UUID()
    let deltaMicro: Int
    let kind: String
    let ref: String
    let created: Double?
}

/// Deposit configuration + the user's linked (withdrawal-destination) address.
private struct DepositInfo {
    var configured = false
    var depositAddress: String?
    var chain: String?
    var linkedAddress: String?
    /// The in-house faucet, when this deployment runs its own chain. `nil` on
    /// Base/Sepolia — see TopUp.route, which keys on this rather than on `chain`.
    var faucet: TopUp.FaucetInfo?
}

/// An owned tiny with a per-message price > 0 — i.e. one that's actually
/// x402-payable and worth an on-chain (ERC-8004) registration URL.
private struct PricedTiny: Identifiable {
    let name: String
    let priceMicro: Int
    var id: String { name }
    var x402Url: String { "https://tiny.technology/api/x402/chat/\(name)" }
    var registrationUrl: String { "https://tiny.technology/api/erc8004/registration/\(name)" }
}

struct WalletView: View {
    let token: String?
    @Environment(\.tinyAccent) private var accent
    // The withdraw amount field is a fixed-width pill; scale its width with the
    // Dynamic Type size so a larger accessibility text setting doesn't clip the
    // typed amount ("500.00" at the $500/day cap). @ScaledMetric grows the frame
    // in lockstep with .body, so the same character count always fits — the font
    // was scaling but the 80pt frame wasn't, truncating money on an AX text size.
    @ScaledMetric(relativeTo: .body) private var amountFieldWidth: CGFloat = 80

    @State private var state: LoadState = .loading
    @State private var balanceMicro = 0
    @State private var history: [WalletEntry] = []

    // ⬇️ Deposit flow
    @State private var deposit = DepositInfo()
    @State private var linkAddr = ""
    @State private var claimTx = ""
    @State private var claimNetwork = "base"
    @State private var depositMsg = ""
    @State private var busy = false

    // 💧 In-house faucet (self-hosted chain only). Separate busy flag from `busy`:
    // the claim waits on an on-chain mint (~20s) and must not freeze the link/claim
    // buttons beside it.
    @State private var faucetMsg = ""
    @State private var claimingFaucet = false

    // ⬆️ Withdraw
    @State private var withdrawUsd = ""
    @State private var withdrawNetwork = "base"
    @State private var withdrawMsg = ""
    @State private var withdrawing = false
    @State private var confirmWithdraw = false
    // The BaseScan URL for the last broadcast payout, so the user can watch it
    // confirm on-chain — web opens d.explorer on both the paid and the
    // pending-confirmation paths; iOS returned the tx but surfaced it nowhere.
    @State private var withdrawExplorer: String?

    // 🪪 Monetize — owned tinys + their per-message price, so the earn card can
    // surface the concrete x402 endpoint + ERC-8004 registration URL (mirrors
    // the web wallet's discoverability fix; the URLs are served but were shown
    // nowhere in-app, so an owner couldn't find them to share or mint on-chain).
    @State private var pricedTinys: [PricedTiny] = []
    // Whether the user owns ANY tiny (priced or not). Web shows the monetize
    // card to every owner, with a "price one to unlock its x402/ERC-8004 URL"
    // hint when none are priced yet — otherwise an owner never learns pricing
    // is what turns on the agent-payable endpoint. iOS previously hid the card
    // whenever nothing was priced, so that discovery path didn't exist on phone.
    @State private var ownsTinys = false
    // A priced tiny that's PRIVATE is walled off from x402/ERC-8004 (both 403 by
    // design), so its URLs are dead-on-arrival and never listed. When an owner's
    // ONLY priced tiny is private, the empty-list hint says "make it public to
    // unlock" instead of the generic "price a tiny" — otherwise they're told to
    // do something they've already done. Web parity (page.tsx pricedPrivate).
    @State private var hasPricedPrivate = false
    @State private var copiedTag = ""
    // 🌱 "What is the tiny wallet?" explainer — auto-expands for a NEWCOMER
    // (zero balance AND zero history), collapsed once they have either. Web
    // (app/wallet/page.tsx:393-465, showIntro) + Android (5f704002) both teach
    // what the money is FOR — using paid AIs, earning with your own, getting
    // paid by any agent over x402, real-USDC-your-custody — but iOS taught none
    // of it, the exact "I don't understand what to do" gap. Seeded once on the
    // initial load (below) so a manual collapse survives pull-to-refresh.
    @State private var showIntro = false

    // ── Formatting (mirrors the web helpers) ────────────────────────────────
    private static let usdFmt: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 6
        // Pin en_US so the money format is device-locale-INDEPENDENT ("$0.50", not a
        // de/fr/tr phone's "0,50 $"); currencyCode alone doesn't fix separators/symbol
        // placement. Web pins toLocaleString("en-US"), Android pins Locale.US.
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    private func usd(_ micro: Int) -> String {
        Self.usdFmt.string(from: NSNumber(value: Double(micro) / 1_000_000)) ?? "$0.00"
    }

    /// Content emoji labels (TinyDesign: emoji belong to content, not chrome).
    private func kindLabel(_ kind: String) -> String {
        switch kind {
        case "deposit": return "⬇️ Deposit"
        case "admin_credit": return "🎁 Credit"
        case "invoke_debit": return "🤖 Invocation"
        case "invoke_credit": return "💰 Earned"
        case "platform_fee": return "🏛️ Fee"
        case "withdrawal": return "⬆️ Withdrawal"
        case "refund": return "↩️ Refund"
        // First-party x402 payer (pay_x402): the user pays ANOTHER agent →
        // spend_debit; a reversal (no USDC moved) → spend_refund.
        case "spend_debit": return "🤝 Agent payment"
        case "spend_refund": return "↩️ Payment refund"
        default: return kind
        }
    }

    /// The kind label WITHOUT its leading emoji, for VoiceOver — else the
    /// pictograph is announced literally ("down-arrow Deposit"). Every kindLabel
    /// is "<emoji> <words>", so drop through the first space; a default kind (no
    /// space) reads verbatim. Derived from kindLabel so the two can't drift.
    /// Web parity: kindA11y() in app/wallet/page.tsx.
    private func kindA11y(_ kind: String) -> String {
        let label = kindLabel(kind)
        guard let sp = label.firstIndex(of: " ") else { return label }
        return String(label[label.index(after: sp)...])
    }

    /// One VoiceOver announcement for a ledger row: "<kind>: credit/debit $X, <when>".
    /// Mirrors the visible line but spells the sign in words (color doesn't reach a
    /// screen reader) and drops the emoji + opaque ref. Web parity: rowLabel in page.tsx.
    private func ledgerRowA11y(_ e: WalletEntry) -> String {
        let credit = e.deltaMicro >= 0
        var s = "\(kindA11y(e.kind)): \(credit ? "credit" : "debit") \(usd(abs(e.deltaMicro)))"
        if let c = e.created {
            s += ", \(Date(timeIntervalSince1970: c).formatted(.relative(presentation: .named)))"
        }
        return s
    }

    /// Speak a deposit/withdraw OUTCOME to VoiceOver. The visible string leads
    /// with a decorative status glyph (✓ / ⚠️ / ⏳) that a screen reader either
    /// skips or reads as its Unicode name ("check mark", "warning") — neither
    /// tells the user whether the money action succeeded. Strip that leading
    /// non-alphanumeric run and speak the WORDS at .high priority so the result
    /// isn't dropped mid-navigation. This is the iOS equivalent of the web
    /// wallet's `<p role="status" aria-live>` that announces depositMsg/
    /// withdrawMsg automatically (page.tsx:639,682); on iOS a plain Text swap is
    /// silent, so the most irreversible surface in the app (money OUT) gave a
    /// VoiceOver user no confirmation at all. Empty (message cleared) → no-op.
    private func announceOutcome(_ msg: String) {
        let spoken = String(msg.drop(while: { !$0.isLetter && !$0.isNumber }))
            .trimmingCharacters(in: .whitespaces)
        guard !spoken.isEmpty else { return }
        var a = AttributedString(spoken)
        a.accessibilitySpeechAnnouncementPriority = .high
        AccessibilityNotification.Announcement(a).post()
    }

    private var linkAddrValid: Bool {
        linkAddr.trimmingCharacters(in: .whitespaces).range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil
    }
    private var claimTxValid: Bool {
        claimTx.trimmingCharacters(in: .whitespaces).range(of: "^0x[0-9a-fA-F]{64}$", options: .regularExpression) != nil
    }
    /// Locale-aware decimal parse for the withdraw field. `.decimalPad` renders
    /// the CURRENT LOCALE's decimal separator (a comma in de_DE / fr_FR / …), so
    /// a plain `Double("10,50")` returned nil and the Withdraw button stayed
    /// PERMANENTLY DISABLED — comma-locale users could never withdraw their USDC.
    private static let amountParser: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        return f
    }()
    private var withdrawAmount: Double? {
        let raw = withdrawUsd.trimmingCharacters(in: .whitespaces)
        // Parse in the user's locale first; fall back to the C-locale '.' (and a
        // bare comma→dot) so both "10.50" and "10,50" resolve regardless of which
        // separator the keypad produced.
        let v = Self.amountParser.number(from: raw)?.doubleValue
            ?? Double(raw)
            ?? Double(raw.replacingOccurrences(of: ",", with: "."))
        // Guard the money-mover: finite, ≥ the $1 minimum, and ≤ the current
        // balance. The upper bound is load-bearing twice over — it stops an
        // absurd entry (e.g. 1e13) from overflowing `Int(v * 1e6)` into a fatal
        // crash at the confirm dialog / POST body, and it stops the confirm
        // dialog from promising more USDC than the balance can actually pay.
        guard let amt = v, amt.isFinite, amt >= 1 else { return nil }
        let balanceUsd = Double(balanceMicro) / 1_000_000
        return amt <= balanceUsd ? amt : nil
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView("Loading your wallet…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let e):
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "creditcard.trianglebadge.exclamationmark")
                } description: {
                    Text(e)
                } actions: {
                    Button("Retry") { Task { state = .loading; await load() } }
                }
            case .loaded:
                loaded
            }
        }
        .navigationTitle("Wallet")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var loaded: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                balanceCard
                introCard
                // The faucet needs NO linked address and no configured deposit
                // address — it's the on-ramp for a user who has neither, so gating
                // it behind them would hide the only way they can get credit
                // (Android Wallet.kt:100 parity).
                if deposit.linkedAddress != nil || deposit.configured || deposit.faucet?.available == true {
                    getUsdcCard
                }
                depositCard
                withdrawCard
                if ownsTinys { monetizeCard }
                activitySection
            }
            .padding()
        }
        .refreshable { await load() }
    }

    // ── Balance ─────────────────────────────────────────────────────────────
    private var balanceCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("BALANCE")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(usd(balanceMicro))
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .foregroundStyle(accent)
                .contentTransition(.numericText())
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text("tiny credits · micro-USDC ledger")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .tinyCard()
    }

    // ── 🌱 What is the tiny wallet? — collapsible x402 explainer ─────────────
    // Web/Android parity (page.tsx:393-465 / 5f704002): four points teaching what
    // the balance is FOR + a quick-start, so a newcomer learns paying/earning over
    // x402 instead of staring at deposit/withdraw cards that assume they know.
    private var introCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { showIntro.toggle() }
            } label: {
                HStack {
                    Text("What is the tiny wallet?")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer()
                    Image(systemName: showIntro ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("What is the tiny wallet?")
            .accessibilityValue(showIntro ? "Expanded" : "Collapsed")
            .accessibilityHint("Explains what the balance is for")

            if showIntro {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Your wallet holds **tiny credits** — a dollar-denominated balance (USDC) that powers the AI economy here. Everything is optional: free tinys stay free forever.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    introPoint("🤖", "Use paid AIs",
                               "Some creators charge per message (e.g. $0.01) for specialized tinys — legal helpers, trading analysts, tutors. Your balance pays automatically as you chat; the price is always shown up front.")
                    introPoint("💰", "Earn with your AIs",
                               "Tell any tiny you own “charge $0.01 per message” — done, it's monetized. Every visitor message pays you. You keep the full price minus a flat $0.001 — never a percentage cut.")
                    introPoint("🌐", "Get paid by the whole internet",
                               "Priced tinys are also payable by ANY AI agent via the open x402 protocol — other agents can discover your tiny and pay it per request in USDC, no tiny.technology account needed. Your AI becomes an API that earns.")
                    introPoint("🏦", "Real money, your custody",
                               "Deposits and withdrawals are real USDC on Base (an Ethereum L2 by Coinbase). Withdrawals are instant and self-serve — funds go only to the address YOU linked, so a stolen session can't redirect your money. Want to try risk-free? Testnet deposits give up to $1 in trial credits.")

                    Text("**Quick start:** 1) Link your wallet address below · 2) Buy or send USDC on Base (or grab free testnet USDC) · 3) Claim the deposit · 4) Chat with paid tinys, or price your own and start earning.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
                .padding(.top, 12)
            }
        }
        .tinyCard()
    }

    // One labelled point in the explainer — emoji + bold title + body, grouped
    // into a single VoiceOver announcement (the emoji is decorative content).
    private func introPoint(_ emoji: String, _ title: String, _ body: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(emoji).font(.subheadline).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(body)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // ── Get USDC / get credit ────────────────────────────────────────────────
    // THREE mutually exclusive routes, decided in TopUp.route (web page.tsx:491 /
    // Android WalletCore.topUpRoute):
    //
    //  · faucet  — this deployment runs its OWN chain, so credit comes from us.
    //  · testnet — Sepolia: the public faucet is the one true source (fiat rails
    //              deliver MAINNET USDC the claim scanner can't see).
    //  · fiat    — real Base: cards and bridges work.
    //
    // iOS offered Coinbase/bridge.base.org/faucet.circle.com by CHAIN only, which
    // on a self-hosted chain is worse than a dead link: nobody sells TinyUSDC and
    // faucet.circle.com hands out SEPOLIA USDC, so every one of those rails takes
    // the user's money or time and returns a token this deployment cannot credit.
    private var getUsdcCard: some View {
        let route = TopUp.route(chain: deposit.chain, faucet: deposit.faucet)
        let cta = TopUp.faucetCta(deposit.faucet)
        return VStack(alignment: .leading, spacing: 8) {
            Text(TopUp.title(route))
                .font(.subheadline.weight(.semibold))
            Text(TopUp.blurb(route))
                .font(.caption)
                .foregroundStyle(.secondary)

            if route == .faucet {
                // The claim button IS the on-ramp here.
                Button {
                    Task { await claimFaucet() }
                } label: {
                    Text(claimingFaucet ? "Claiming…" : cta.label)
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(accent)
                .disabled(claimingFaucet || !cta.enabled)
                // Both refusals are shown, never merged: "wait until midnight UTC"
                // and "you've spent your ceiling — get followed to raise it" are
                // opposite instructions.
                if !cta.reason.isEmpty {
                    Text(cta.reason)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                // Shown in EVERY faucet state — it's where the
                // follow → reputation → bigger ceiling link is taught, and a user
                // who just claimed still needs to know why their cap is what it is.
                let note = TopUp.ceilingNote(deposit.faucet)
                if !note.isEmpty {
                    Text(note)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if !faucetMsg.isEmpty {
                    Text(faucetMsg)
                        .font(.caption)
                        .foregroundStyle(faucetMsg.hasPrefix("⚠️") ? .orange : accent)
                }
            } else {
                FlowLinks(links: TopUp.usdcSources(route).map { ($0.label, $0.url) }, accent: accent)
            }
        }
        .tinyCard()
        // Credited / refused is otherwise a silent Text swap — the same live-region
        // treatment the deposit + withdraw outcomes already get (web: role="status").
        .onChange(of: faucetMsg) { _, m in announceOutcome(m) }
    }

    // ── Deposit ───────────────────────────────────────────────────────────
    private var depositCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Deposit USDC on \(deposit.chain == "base-sepolia" ? "Base Sepolia" : "Base")")
                .font(.subheadline.weight(.semibold))

            if !deposit.configured {
                Text("USDC deposits are rolling out — the deposit address isn't configured yet. Until then, credits are granted by the platform.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                // 1) Link the sending address (also your withdrawal destination)
                Text("1. Link the address you'll send from — this is what makes your deposit claimable by you alone (and your withdrawal destination).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let linked = deposit.linkedAddress {
                    Label(linked, systemImage: "checkmark.seal.fill")
                        .font(.caption.monospaced())
                        .foregroundStyle(accent)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    HStack {
                        TextField("0xYourAddress", text: $linkAddr)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.caption.monospaced())
                        Button("Link") { Task { await linkAddress() } }
                            .buttonStyle(.borderedProminent)
                            .tint(accent)
                            .disabled(busy || !linkAddrValid)
                    }
                }

                // 2) Send to the platform deposit address (copyable)
                Text("2. Send USDC to the platform deposit address:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let addr = deposit.depositAddress {
                    Button {
                        UIPasteboard.general.string = addr
                        depositMsg = "✓ Deposit address copied."
                    } label: {
                        HStack {
                            Text(addr)
                                .font(.caption2.monospaced())
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            Image(systemName: "doc.on.doc").font(.caption2)
                        }
                        .padding(8)
                        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    // Without a label VoiceOver reads the raw 42-char address as a
                    // char-run + the "doc on doc" glyph name — meaningless on a
                    // money-critical surface. Match web's aria-label ("Copy the
                    // platform deposit address", page.tsx:569) + the C110 monetize
                    // copy pattern; the success is otherwise a silent depositMsg swap.
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Copy the platform deposit address")
                    .accessibilityValue(depositMsg == "✓ Deposit address copied." ? "Copied" : "")
                }

                // 3) Claim by tx hash
                Text("3. Paste the transaction hash to credit your balance:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                // Driven by the deployment's own default (TopUp.networkChoices), not
                // a hardcoded Base/Sepolia pair: on a self-hosted chain the user's
                // OWN network wasn't offerable at all, so every claim was aimed at a
                // chain their transfer isn't on (a permanent "no matching USDC
                // transfer" 400).
                Picker("Network", selection: $claimNetwork) {
                    ForEach(TopUp.networkChoices(deposit.chain), id: \.self) { n in
                        Text(TopUp.networkLabel(n)).tag(n.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                HStack {
                    TextField("0xTransactionHash", text: $claimTx)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.caption.monospaced())
                    Button(busy ? "…" : "Claim") { Task { await claimDeposit() } }
                        .buttonStyle(.borderedProminent)
                        .tint(accent)
                        .disabled(busy || !claimTxValid)
                }
            }

            if !depositMsg.isEmpty {
                Text(depositMsg)
                    .font(.caption)
                    .foregroundStyle(depositMsg.hasPrefix("⚠️") ? .orange : accent)
            }
        }
        .tinyCard()
        // Announce link/claim outcomes to VoiceOver (web wraps depositMsg in a
        // role="status" live region; a plain Text swap is silent on iOS).
        .onChange(of: depositMsg) { _, m in announceOutcome(m) }
    }

    // ── Withdraw ─────────────────────────────────────────────────────────
    private var withdrawCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Withdraw USDC")
                .font(.subheadline.weight(.semibold))
            Text("Sends to your linked address instantly — no approval step. Min $1, flat $0.10 fee (gas), $500/day. Testnet trial credits aren't withdrawable as real USDC.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                HStack(spacing: 2) {
                    Text("$").foregroundStyle(.secondary)
                    TextField("10.00", text: $withdrawUsd)
                        .keyboardType(.decimalPad)
                        .font(.body.monospaced())
                        .frame(width: amountFieldWidth)
                }
                .padding(8)
                .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                Spacer()
                Button(withdrawing ? "Sending…" : "Withdraw") { confirmWithdraw = true }
                    .buttonStyle(.borderedProminent)
                    .tint(accent)
                    .disabled(withdrawing || withdrawAmount == nil)
            }
            Picker("Network", selection: $withdrawNetwork) {
                ForEach(TopUp.networkChoices(deposit.chain), id: \.self) { n in
                    Text(TopUp.networkShort(n)).tag(n.rawValue)
                }
            }
            .pickerStyle(.segmented)
            if !withdrawMsg.isEmpty {
                Text(withdrawMsg)
                    .font(.caption)
                    .foregroundStyle(withdrawMsg.hasPrefix("⚠️") ? .orange : accent)
            }
            // Watch the payout confirm on-chain (web opens this automatically;
            // on iOS we show it as a tappable link so the tx isn't a dead end).
            if let u = Explorer.href(withdrawExplorer) {
                Link(destination: u) {
                    Label(Explorer.linkLabel(withdrawExplorer), systemImage: "arrow.up.forward.square")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(accent)
                }
                .accessibilityLabel(Explorer.openHint(withdrawExplorer))
            }
        }
        .tinyCard()
        .confirmationDialog(
            "Withdraw USDC?",
            isPresented: $confirmWithdraw,
            titleVisibility: .visible
        ) {
            Button("Withdraw", role: .destructive) { Task { await withdraw() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            // Match the on-chain reality (and the success toast, which reports
            // net_micro): the FULL amount leaves the balance, a flat $0.10 covers
            // gas, and only the NET lands at the linked address. Web parity —
            // app/wallet/page.tsx withdraw() confirm.
            // Quantize to micro-USDC FIRST and format both lines through usd()
            // (the shared MONEY formatter, 2–6dp) — a typed "12.3456" must not
            // show "$12.35" here while 12345600 micro actually leaves the
            // balance. Mirrors the web withdraw() confirm (page.tsx amountMicro).
            let amtMicro = Int(((withdrawAmount ?? 0) * 1_000_000).rounded())
            let netMicro = max(0, amtMicro - 100_000) // flat $0.10 gas = 100_000 micro
            // Show the ACTUAL destination address in the confirm — web does
            // (page.tsx:265 appends "…arrives at your linked address:\n<0x…>"),
            // iOS only said "your linked address" in the abstract. On an
            // irreversible money-OUT the user must be able to verify WHERE the
            // USDC is going before tapping Withdraw — the address is the one
            // fact the server won't let them change (destination is forced to
            // the linked address, withdraw route.ts:16-18), so seeing it is the
            // whole point of the confirm. Fall back to the abstract phrasing if
            // it's somehow absent (withdraw() re-guards linkedAddress anyway).
            let dest = deposit.linkedAddress.map { "\n\nTo: \($0)" } ?? ""
            // The name of the chain the money leaves on, via the shared table — the
            // old `== "base" ? "Base" : "Base Sepolia"` ternary named the WRONG chain
            // on a self-hosted deployment, on the one dialog that exists so the user
            // can check the facts before an irreversible send.
            Text("\(usd(amtMicro)) leaves your balance on \(TopUp.networkShort(TopUp.asNetwork(withdrawNetwork))). After a flat $0.10 gas fee, \(usd(netMicro)) USDC arrives at your linked address. Instant and can't be undone.\(dest)")
        }
        // Announce the withdrawal outcome to VoiceOver — paid / pending / failed
        // are all a silent withdrawMsg swap otherwise, on the one surface where
        // hearing "sent" vs "failed" gates a double-pay retry. Web parity: the
        // role="status" live region on withdrawMsg (page.tsx:682).
        .onChange(of: withdrawMsg) { _, m in announceOutcome(m) }
    }

    // ── Activity ledger ──────────────────────────────────────────────────
    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Activity")
                .font(.subheadline.weight(.semibold))
            if history.isEmpty {
                Text("No activity yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
            } else {
                ForEach(history) { e in
                    HStack(spacing: 10) {
                        Text(kindLabel(e.kind)).font(.caption)
                        if !e.ref.isEmpty {
                            Text(e.ref)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 8)
                        if let c = e.created {
                            Text(Date(timeIntervalSince1970: c).formatted(.relative(presentation: .named)))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Text("\(e.deltaMicro >= 0 ? "+" : "")\(usd(e.deltaMicro))")
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(e.deltaMicro >= 0 ? accent : .red)
                    }
                    .padding(.vertical, 6)
                    // One coherent announcement per row instead of four disjoint
                    // fragments (emoji-kind, ref, relative-time, color-signed
                    // amount). The sign is spelled in WORDS — credit/debit — since
                    // color alone doesn't reach VoiceOver, the emoji is dropped via
                    // kindA11y, and the ref is omitted (it's an opaque tx hash, noise
                    // in speech). Web parity: the per-row aria-label in page.tsx.
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(ledgerRowA11y(e))
                    Divider()
                }
            }
        }
        .tinyCard()
    }

    // ── Monetize (x402 + ERC-8004 URLs for priced tinys) ────────────────────
    private var monetizeCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Monetize your tinys")
                .font(.subheadline.weight(.semibold))
            // There is NO UI price control (no Settings/Your-AI price field on any
            // client) — the only mechanism is telling the tiny in chat. Point at
            // that, not a nonexistent setting (web parity, fixed there in 0e311e8).
            Text("To price a tiny you own, just tell it in chat: \u{201C}charge $0.01 per message\u{201D} — or \u{201C}make yourself free again\u{201D} to turn it off. Callers pay from their wallet; you earn the price minus the flat fee.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if pricedTinys.isEmpty {
                // Owns tinys but none PUBLICLY priced — the discovery hint web
                // shows, so a phone owner learns pricing (and publicness) is what
                // unlocks the agent-payable x402 endpoint + on-chain ERC-8004 URL.
                Text(hasPricedPrivate
                    ? "Make a priced tiny public to unlock its x402 endpoint + on-chain (ERC-8004) registration URL — a private tiny stays walled off from agent payments."
                    : "Price a tiny to unlock its x402 endpoint + on-chain (ERC-8004) registration URL — they'll appear here so any AI agent can discover and pay it.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            } else {
                Text("These priced tinys are payable by any AI agent over the open x402 protocol, and registerable on-chain via ERC-8004. Tap a URL to copy it — share it, or point register_agent at the registration file.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                ForEach(pricedTinys) { t in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("/\(t.name) · \(usd(t.priceMicro))/msg")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(accent)
                        copyableUrl("x402 endpoint", t.x402Url, tag: "x402:\(t.name)")
                        copyableUrl("ERC-8004 registration", t.registrationUrl, tag: "reg:\(t.name)")
                    }
                }
            }
        }
        .tinyCard()
    }

    /// A labeled URL row that copies to the pasteboard on tap (parity with the
    /// deposit-address copy affordance; no raw secrets here, just public URLs).
    private func copyableUrl(_ label: String, _ url: String, tag: String) -> some View {
        Button {
            UIPasteboard.general.string = url
            copiedTag = tag
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if copiedTag == tag { copiedTag = "" }
            }
        } label: {
            HStack(spacing: 8) {
                Text(label.uppercased())
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 96, alignment: .leading)
                Text(url)
                    .font(.caption2.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                Image(systemName: copiedTag == tag ? "checkmark" : "doc.on.doc")
                    .font(.caption2)
                    .foregroundStyle(copiedTag == tag ? accent : .secondary)
            }
            .padding(8)
            .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        // Give VoiceOver ONE clear action name instead of reading the label
        // fragment + the whole raw URL char-run + the "doc on doc" glyph name;
        // the .accessibilityValue flips to "Copied" on tap so the success is
        // ANNOUNCED, not just a silent checkmark swap. Web has a static
        // aria-label here (page.tsx:688) but no spoken success — this matches
        // its accessible name and improves on the confirmation.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Copy \(label) URL")
        .accessibilityValue(copiedTag == tag ? "Copied" : "")
    }

    // ── Networking ─────────────────────────────────────────────────────────

    /// POST to a session-gated path; returns the parsed body even on non-2xx
    /// (URLSession doesn't throw on HTTP status) so we can surface the worker's
    /// own error/425-retry message, exactly like the web page reads `d.error`.
    private func post(_ path: String, _ body: [String: Any], timeout: TimeInterval = 60) async -> [String: Any]? {
        // Api.base is user-configurable (Settings → Advanced); a malformed value
        // must not crash the wallet — guard the URL instead of force-unwrapping.
        guard let url = URL(string: Api.base + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = timeout
        guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return nil }
        guard var body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        // Carry the HTTP status INTO the body under a reserved key, the way Android's
        // postJsonSettle does. The worker's money routes set explicit flags
        // (already_claimed / ceiling_reached / retry), and those stay authoritative —
        // this is the fallback for a proxy or gateway that rewrote the body and left
        // only the code, where 429 ("wait") and 400 ("you're capped") are opposite
        // instructions to the user. Existing callers read named keys only, so an
        // extra key is inert to them.
        if let code = (resp as? HTTPURLResponse)?.statusCode, body["_status"] == nil {
            body["_status"] = code
        }
        return body
    }

    private func load() async {
        // Balance + ledger
        do {
            let d: [String: Any] = try await Api.get("/api/wallet", token: token)
            balanceMicro = (d["balance_micro"] as? NSNumber)?.intValue ?? 0
            let raw = d["history"] as? [[String: Any]] ?? []
            history = raw.map {
                WalletEntry(
                    deltaMicro: ($0["delta_micro"] as? NSNumber)?.intValue ?? 0,
                    kind: $0["kind"] as? String ?? "?",
                    ref: $0["ref"] as? String ?? "",
                    created: ($0["created"] as? NSNumber)?.doubleValue)
            }
            // Auto-expand the explainer for a NEWCOMER (zero balance AND zero
            // history) on the FIRST load only — web sets showIntro here on
            // deposit_info/balance load. Gate on `.loading` so a manual collapse
            // isn't undone by a pull-to-refresh (load() re-runs after every action).
            if case .loading = state {
                showIntro = balanceMicro == 0 && history.isEmpty
            }
            state = .loaded
        } catch {
            // Only escalate to the full-screen failed state on the INITIAL load
            // (state still .loading). load() re-runs after every claim/withdraw —
            // a blip on that refresh must NOT tear down an already-loaded wallet
            // (discarding the "✓ Paid" confirmation + explorer link + balance the
            // user just earned); the deposit/withdraw cards surface their own
            // inline messages. Mirrors web (app/wallet/page.tsx) + Android
            // (Wallet.kt `failed && ledger == null`).
            if case .loading = state {
                state = .failed((error as? ApiError)?.errorDescription ?? "Couldn't reach the wallet service.")
            }
            return
        }
        // Deposit info. Try twice on a transport blip: post() returns nil ONLY on
        // a dropped connection / malformed base URL (a parsed body — even a clean
        // {ok:false} — comes back non-nil), so nil is the transient case worth a
        // retry and any body is the honest answer to stop on. Without the retry a
        // single dropped POST on a deposits-CONFIGURED deployment left `deposit`
        // at its configured=false default, so the card falsely claimed "deposits
        // aren't configured yet" (recoverable via pull-to-refresh, but a
        // misleading money-surface state). Mirrors web's retry-twice
        // (app/wallet/page.tsx:137-164) + WalletSheet (components/chat/WalletSheet).
        var info: [String: Any]?
        for _ in 0..<2 {
            info = await post("/api/wallet", ["action": "deposit_info"])
            if info != nil { break } // a body (incl. {ok:false}) is the honest answer
        }
        if let d = info, d["ok"] as? Bool != false {
            deposit = DepositInfo(
                configured: (d["configured"] as? Bool) ?? false,
                depositAddress: d["deposit_address"] as? String,
                // Worker emits `default_network` (deposits.ts) — NOT `chain`;
                // reading the wrong key left this nil, so the header always
                // said "Base" even on a testnet-default deployment.
                chain: d["default_network"] as? String,
                linkedAddress: d["linked_address"] as? String,
                faucet: TopUp.parseFaucetInfo(d["faucet"]))
            // Seed both network selectors to the deployment's default. On a
            // testnet (PAYMENTS_TESTNET) deployment the header reads "Base
            // Sepolia" but the pickers defaulted to mainnet — so a user pasting
            // a Sepolia tx hash hit the permanent 400 "no matching USDC transfer
            // on base". Follow the default the worker already reports (web
            // app/wallet/page.tsx does the same on deposit_info load).
            //
            // Generalized off the `== "base-sepolia"` literal: it seeded nothing on
            // a self-hosted chain, leaving both selectors on mainnet — the exact bug
            // this line was written to fix, reappearing for the third network.
            let def = TopUp.asNetwork(deposit.chain)
            if def != .base {
                claimNetwork = def.rawValue
                withdrawNetwork = def.rawValue
            }
        }
        // Owned tinys + their prices → the monetize card surfaces the x402 +
        // ERC-8004 URLs for the priced ones. Best-effort: the card just hides
        // if this fails or the user owns nothing priced.
        await loadPricedTinys()
    }

    /// Fetch owned tinys (/api/me) and look up each price; keep only priced ones.
    /// A PRIVATE tiny is excluded even when priced — it 403s on both
    /// /api/x402/chat and its ERC-8004 registration file (by design, its persona
    /// is masked), so its "agent-payable" URLs are dead-on-arrival. Advertising
    /// them would hand the owner two links that every caller/minter gets a 403 on.
    private func loadPricedTinys() async {
        guard let me: [String: Any] = try? await Api.get("/api/me", token: token),
              let tinys = me["tinys"] as? [[String: Any]] else { return }
        // Keep name + private together so a private tiny is dropped from the URLs.
        // `private` arrives from the worker as a D1 integer (0/1) → an NSNumber,
        // NOT a Swift Bool — so read boolValue, not `as? Bool`. And fail CLOSED
        // when the flag is absent/null: web (page.tsx:157) treats a missing flag
        // as private on purpose, mirroring the server's 403 gates — we can't prove
        // a tiny is public, so we must not surface its payable URLs on a guess (a
        // private tiny 403s on both x402/chat AND its ERC-8004 registration file,
        // so those links would be dead-on-arrival for every caller/minter). The
        // old `?? false` failed OPEN, leaking a private tiny's URLs.
        let owned = tinys.compactMap { t -> (name: String, isPrivate: Bool)? in
            guard let n = t["name"] as? String, !n.isEmpty else { return nil }
            return (n, (t["private"] as? NSNumber)?.boolValue ?? true)
        }
        guard !owned.isEmpty else { return }
        ownsTinys = true // the card shows for every owner; unpriced → guiding hint
        var priced: [PricedTiny] = []
        var pricedPrivate = false
        // Price-check EVERY owned tiny (incl. private) so a priced-but-private one
        // can steer the empty-list hint (web parity); private tinys are still kept
        // OUT of `priced` — their x402/ERC-8004 URLs would 403.
        for t in owned {
            guard let d = await post("/api/wallet", ["action": "pricing", "resource": "tiny:\(t.name)"]),
                  let micro = (d["price_micro"] as? NSNumber)?.intValue, micro > 0 else { continue }
            if t.isPrivate { pricedPrivate = true } else { priced.append(PricedTiny(name: t.name, priceMicro: micro)) }
        }
        pricedTinys = priced
        hasPricedPrivate = pricedPrivate
    }

    private func linkAddress() async {
        guard !busy else { return }
        busy = true; depositMsg = ""
        defer { busy = false }
        let d = await post("/api/wallet", ["action": "link_address", "address": linkAddr.trimmingCharacters(in: .whitespaces)])
        if let d, d["ok"] as? Bool == true {
            deposit.linkedAddress = d["address"] as? String
            depositMsg = "✓ Address linked — send USDC on Base, then claim with the tx hash."
            linkAddr = ""
        } else {
            depositMsg = "⚠️ \((d?["error"] as? String) ?? "link failed")"
        }
    }

    /// Claim the daily drip from the in-house faucet (self-hosted chain only).
    ///
    /// Empty POST body — the amount is the server's decision (MIN(drip, remaining)),
    /// and a client-supplied figure would be a request the route ignores.
    ///
    /// The long timeout is load-bearing: `/api/wallet/faucet` credits the ledger and
    /// THEN waits on the TinyUSDC mint receipt (~20s). Aborting at the default would
    /// show "couldn't reach the faucet" for credit the user already has — and the
    /// retry they'd then make comes back 429, so they'd end up believing the claim
    /// failed twice while holding the money (Android WalletRepository.claimFaucet).
    private func claimFaucet() async {
        guard !claimingFaucet else { return }
        claimingFaucet = true; faucetMsg = ""
        defer { claimingFaucet = false }
        switch TopUp.parseFaucetResult(await post("/api/wallet/faucet", [:], timeout: 120)) {
        case .ok(let credited, let backed, _):
            // Say "not withdrawable" at the moment of crediting, not later in the
            // withdraw card's fine print: this is trial credit, and a user who
            // learns that only when a withdrawal is refused feels defrauded.
            faucetMsg = "✓ Credited \(TopUp.usdShort(credited)) trial credit — spendable inside tiny, not withdrawable as real USDC."
            // The reserve mint is best-effort; the credit is real either way, so a
            // missing mint is not worth alarming the user about.
            _ = backed
            await load()
        // All three refusals pass the SERVER's own sentence through — it knows the
        // reset time and the ceiling arithmetic, and three clients paraphrasing a
        // money refusal is three chances to contradict it. Reload either way: the
        // faucet block's counters moved, and a stale card offers a claim that 429s.
        case .alreadyClaimed(let e), .ceilingReached(let e), .failed(let e):
            faucetMsg = "⚠️ \(e)"
            await load()
        }
    }

    private func claimDeposit() async {
        guard !busy else { return }
        busy = true; depositMsg = ""
        defer { busy = false }
        let d = await post("/api/wallet", ["action": "claim", "txHash": claimTx.trimmingCharacters(in: .whitespaces), "network": claimNetwork])
        if let d, d["ok"] as? Bool == true {
            if d["already_credited"] as? Bool == true {
                depositMsg = "Already credited — this tx was claimed before."
            } else {
                let credited = (d["credited_micro"] as? NSNumber)?.intValue ?? 0
                // A base-sepolia claim credits capped TRIAL balance — say so, or the
                // user thinks they hold real, withdrawable USDC (worker deposits.ts:242).
                let trial = d["testnet_trial"] as? Bool == true
                depositMsg = "✓ Credited \(usd(credited))"
                    + (trial ? " (testnet trial — $1 lifetime cap, not withdrawable as real USDC)" : "")
            }
            claimTx = ""
            await load()
        } else {
            let retry = (d?["retry"] as? Bool == true) ? " — try again in a minute" : ""
            depositMsg = "⚠️ \((d?["error"] as? String) ?? "claim failed")\(retry)"
        }
    }

    private func withdraw() async {
        guard !withdrawing, let usdAmt = withdrawAmount else { return }
        guard deposit.linkedAddress != nil else {
            withdrawMsg = "⚠️ link your wallet address first (in the Deposit card) — it's your withdrawal destination"
            return
        }
        withdrawing = true; withdrawMsg = "Signing and broadcasting…"; withdrawExplorer = nil
        defer { withdrawing = false }
        // Give the on-chain broadcast + receipt wait real headroom ABOVE the
        // server's own deadline (route maxDuration 60s + a 45s receipt wait).
        // A client timeout at the same 60s ceiling was a race: when the client
        // aborted first, post() returned nil and we mislabeled a possibly-
        // broadcast transfer as "failed" (inviting a double-pay retry). Mirror
        // the x402 settlement path, which allows 120s for the same reason.
        let d = await post("/api/wallet/withdraw", [
            "amount_micro": Int((usdAmt * 1_000_000).rounded()),
            "network": withdrawNetwork,
        ], timeout: 120)
        if let d, d["ok"] as? Bool == true {
            let net = (d["net_micro"] as? NSNumber)?.intValue ?? 0
            withdrawMsg = "✓ Paid — \(usd(net)) sent on-chain."
            withdrawExplorer = d["explorer"] as? String
            withdrawUsd = ""
            await load()
        } else if let d, d["pending_confirmation"] as? Bool == true {
            // The tx broadcast but confirmation timed out — the server withheld
            // the refund ON PURPOSE (the transfer is in the mempool and will
            // likely land; /api/wallet/withdraw returns 202 here). NOT a
            // failure: show a neutral "on its way" note, not the orange ⚠️, and
            // don't invite a double-spend retry. Uses accent, not orange.
            withdrawMsg = "⏳ Sent — confirming on-chain. Don't retry; it'll settle shortly."
            withdrawExplorer = d["explorer"] as? String
            withdrawUsd = ""
            await load()
        } else if d == nil {
            // UNKNOWN outcome — no response body at all (client timeout beyond
            // 120s, or a transport drop / 504 at the platform cap). Unlike a
            // structured server error below, we do NOT know whether the transfer
            // broadcast. Money MAY have moved, so this must NOT read as a plain
            // "failed" that invites a retry (the double-pay the 202 path guards
            // against, re-entering through the timeout door). Treat as pending:
            // neutral tone, no retry nudge, point the user at Activity to verify.
            withdrawMsg = "⏳ Couldn't confirm the withdrawal. It may still be processing — check Activity before retrying."
            withdrawUsd = ""
            await load()
        } else {
            // A structured non-ok body: the server explicitly rejected BEFORE
            // broadcasting (e.g. insufficient balance, bad address) OR broadcast
            // then refunded — either way no un-refunded money moved, so a hard
            // ⚠️ + retry is safe and correct.
            withdrawMsg = "⚠️ \((d?["error"] as? String) ?? "withdrawal failed")"
            await load() // a refund may have adjusted the displayed balance
        }
    }
}

/// A wrapping row of pill links (the web's flex-wrap onramp buttons).
private struct FlowLinks: View {
    let links: [(String, String)]
    let accent: Color

    var body: some View {
        // A simple wrapping layout via a lazy grid of adaptive pills.
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], alignment: .leading, spacing: 8) {
            ForEach(links, id: \.1) { label, url in
                if let u = URL(string: url) {
                    Link(destination: u) {
                        Text(label)
                            .font(.caption.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(accent.opacity(0.4), lineWidth: 1))
                            .foregroundStyle(accent)
                    }
                }
            }
        }
    }
}

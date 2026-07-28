/**
 * PayQuote — native Approve/Decline card for the pay_x402 tool (web: PayReceipt.tsx).
 *
 * CONFIRM-EVERY-PAYMENT: an agent that calls pay_x402 gets back a signed QUOTE
 * — NO money moves. This card is the user's approval gate: only the Approve tap
 * calls PUT /api/x402/pay (the sole money-moving path), which runs the
 * spend→sign→settle flow on the platform hot wallet and debits the user's
 * ledger. The agent has no way to press this button, so a runaway agent can
 * never drain the wallet unattended.
 *
 * States: awaiting (quote + buttons) → paying (spinner) → paid (receipt) /
 * failed (reason) / declined. Expiry is re-checked at tap-time (the server
 * enforces it authoritatively too).
 */
import SwiftUI

/// The quote awaiting approval — rides the ChatMessage so a re-render keeps it.
/// Codable so a persisted transcript can still show the terminal state, but a
/// quote restored from disk is treated as expired (its 5-min TTL has passed).
struct PayQuoteItem: Identifiable, Equatable, Codable {
    let id: String          // toolUseId
    let quote: String       // opaque signed token — passed back verbatim to PUT
    let priceMicro: Int
    let network: String?
    let payee: String?
    let expiresAt: Double?  // unix seconds
    let message: String     // the quoted message — PUT re-checks its hash
    /// The service URL this quote was minted for. Carried so the card can
    /// re-mint a fresh quote in place (POST /api/x402/pay, moves no money) on the
    /// recoverable dead-ends — expired (410) or terms_changed (409) — instead of
    /// forcing a whole new agent turn. Web parity: PayReceipt.reQuote() off
    /// `active.url`. Optional: old transcripts + free-target results decode nil.
    var url: String? = nil
    /// The terminal outcome once the user acts, persisted so a reload shows the
    /// RECEIPT — not a dead "Approve" card whose 5-min TTL has long passed.
    /// nil = still awaiting (old transcripts + un-acted quotes decode here).
    var settled: PaySettled? = nil
}

/// The terminal, PERSISTED result of an approved (or declined) quote. Without
/// it a reload restored the quote as `.awaiting` over an expired TTL, so a
/// SETTLED payment resurfaced as a dead "Approve" card — the opposite of the
/// truth, and an invite to pay twice. Codable; rides PayQuoteItem.settled.
struct PaySettled: Equatable, Codable {
    enum Outcome: String, Codable { case paid, pending, failed, declined }
    let outcome: Outcome
    let paidMicro: Int
    let network: String?
    let payee: String?
    let error: String?
    /// On-chain proof — a network-correct BaseScan link the execute route derives
    /// from the settlement (X-PAYMENT-RESPONSE) header. Optional: absent for a
    /// service that returned no settlement receipt + old persisted transcripts.
    var explorer: String? = nil
}

/// A terminal pay_x402 outcome that carries NO quote — the user can't act on it.
/// Either the tool failed to mint a quote (login/allowlist/over-cap/unparseable
/// 402 → `failed`) or the target was free (returned 200, nothing to pay).
/// Codable so it survives a persisted transcript. Web parity: PayReceipt's
/// `toolFailed` ("Payment not sent") and `!isQuote` ("No payment needed") cards.
struct PayResultItem: Identifiable, Equatable, Codable {
    let id: String          // toolUseId
    let failed: Bool        // true = ok:false (error); false = free/no-payment-needed
    let error: String?
}

/// Renders a terminal pay_x402 outcome (no Approve gate — nothing to approve).
struct PayResultCard: View {
    let item: PayResultItem
    @Environment(\.tinyAccent) private var accent

    var body: some View {
        // Group the icon + title + body into ONE VoiceOver announcement and hide
        // the decorative SF Symbol — else a screen reader hears the symbol then
        // each text fragment in isolation on a money-critical outcome card.
        // Mirrors web PayReceipt (role="status"/"alert" + aria-hidden icon) and
        // the paywall card's own grouping (Views.swift:3755-3764).
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: item.failed ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                .foregroundStyle(item.failed ? .red : accent)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.failed ? "Payment not sent" : "No payment needed")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(item.failed ? .red : accent)
                Text(item.failed
                     ? (item.error?.isEmpty == false ? item.error! : "Couldn’t prepare the payment.")
                     : "This service responded without charging — nothing was paid.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.4), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .stroke((item.failed ? Color.red : accent).opacity(0.4), lineWidth: 1))
    }
}

struct PayQuoteCard: View {
    let item: PayQuoteItem
    /// Insufficient-balance "Add funds" tap — presents the native WalletView
    /// sheet in place of bouncing to Safari (web opens the in-app WalletSheet).
    var onAddFunds: (() -> Void)? = nil
    /// Persist a terminal outcome onto the owning message so a reload shows the
    /// receipt, not a dead expired-quote card (C3). nil = don't persist (previews).
    var onSettled: ((PaySettled) -> Void)? = nil
    @Environment(\.tinyAccent) private var accent

    enum Phase: Equatable { case awaiting, paying, paid, pending, failed, declined }
    @State private var phase: Phase = .awaiting
    @State private var paidMicro: Int = 0
    @State private var settleErr: String = ""
    @State private var settledNetwork: String?
    @State private var settledPayee: String?
    @State private var settledExplorer: String?
    // A recoverable failure — insufficient balance. The quote is still spendable
    // (an insufficient-balance spend wrote NO ledger row), so a top-up + retry
    // settles it. Drives the Add funds / Retry affordance on the failed card.
    @State private var needsFunds: Bool = false
    // A recoverable, RE-QUOTABLE dead-end: the quote's 5-min TTL lapsed (410) or
    // the service changed its price/terms (409, reservation reversed) — both move
    // no money, so a fresh POST quote is safe. Drives "Get fresh quote".
    @State private var canReQuote: Bool = false
    // A client-side re-minted quote. When set it REPLACES `item` as the live quote
    // (`active`), so an expired/terms-changed card recovers in place without a
    // fresh agent turn. Web parity: PayReceipt's `fresh ?? result`.
    @State private var fresh: PayQuoteItem? = nil
    @State private var reQuoting: Bool = false
    @Environment(\.openURL) private var openURL

    /// The quote every render + tap reads from: a client re-minted quote if we
    /// have one, else the streamed original.
    private var active: PayQuoteItem { fresh ?? item }

    private static let usdFmt: NumberFormatter = {
        let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = "USD"
        f.maximumFractionDigits = 6; f.minimumFractionDigits = 2
        // Pin en_US so the money format is device-locale-INDEPENDENT: "$0.50" /
        // "$1,234.50", never a de/fr/tr phone's "0,50 $" / "1.234,50 $". currencyCode
        // sets the currency but NOT the separators/symbol placement — those follow
        // the formatter's locale, which defaults to the device. Web pins
        // toLocaleString("en-US") and Android pins Locale.US (NumberFormatLocaleTest);
        // this closes the iOS drift on a money-critical card.
        f.locale = Locale(identifier: "en_US")
        return f
    }()
    private func usd(_ micro: Int) -> String {
        Self.usdFmt.string(from: NSNumber(value: Double(micro) / 1_000_000)) ?? "$0.00"
    }
    private func shortAddr(_ a: String?) -> String {
        // Only hex addresses shorten — a P2P payee is a @login and truncating
        // it would hide exactly the identity the approval is about.
        guard let a, a.count >= 12, a.hasPrefix("0x") else { return a ?? "" }
        return "\(a.prefix(6))…\(a.suffix(4))"
    }
    private var expired: Bool {
        guard let e = active.expiresAt else { return false }
        return e < Date().timeIntervalSince1970
    }
    /// P2P send (make_payment) vs x402 service payment — steers copy only; the
    /// approve/settle flow is identical. The `transfer:` sentinel rides the
    /// persisted url, so restored transcripts keep the right wording too.
    private var isTransfer: Bool { active.url?.hasPrefix("transfer:") == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch phase {
            case .awaiting: awaiting
            case .paying:   status(icon: nil, spinner: true, title: "Sending payment…",
                                   body: isTransfer ? "Moving the money between wallets — don’t close this."
                                                    : "Settling USDC over x402 — don’t close this.")
            case .paid:
                status(icon: "checkmark.seal.fill", spinner: false, title: "Payment sent",
                       body: paidBody)
                // On-chain proof — a tappable explorer link when the settlement
                // returned one, NAMED after wherever it actually points (web
                // parity: PayReceipt's explorerLinkLabel). Explorer.href is also
                // the scheme gate; `URL(string:)` alone would build a
                // `javascript:` URL and hand it to openURL.
                if let u = Explorer.href(settledExplorer) {
                    Link(destination: u) {
                        Text("\(Explorer.linkLabel(settledExplorer)) →")
                            .font(.caption.weight(.semibold)).foregroundStyle(accent)
                    }
                    .accessibilityLabel(Explorer.openHint(settledExplorer))
                    .padding(.leading, 26)
                }
            case .pending:  status(icon: "clock.badge.checkmark", spinner: false, title: "Payment sent — confirming",
                                   body: settleErr.isEmpty ? "The payment was sent and is confirming on-chain. It’ll be verified shortly — no need to retry." : settleErr)
            case .failed:   failed
            case .declined: status(icon: "hand.raised.fill", spinner: false, title: "Payment declined",
                                   body: "You declined this payment. Nothing was charged.", danger: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.4), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(tone.opacity(0.4), lineWidth: 1))
        .onAppear(perform: seedFromPersisted)
        // Speak the OUTCOME when the card settles. Tapping Approve swaps the
        // button subtree out from under VoiceOver focus, so without this a blind
        // user hears nothing after approving — the result just silently replaces
        // the gate. Web parity: PayReceipt wraps each outcome in aria-live
        // (role="status"/"alert"), which VoiceOver-web announces; this is the
        // native equivalent. Only terminal phases announce (paying/awaiting are
        // transient and already focus-visible); the string mirrors the on-screen
        // title + body so speech and display can't drift.
        .onChange(of: phase) { _, newPhase in
            guard let msg = announcement(for: newPhase) else { return }
            var a = AttributedString(msg)
            // Wait for VoiceOver to finish the current utterance rather than
            // cutting it off — a money outcome shouldn't be clipped.
            a.accessibilitySpeechAnnouncementPriority = .high
            AccessibilityNotification.Announcement(a).post()
        }
    }

    /// The VoiceOver announcement for a terminal phase — mirrors the visible
    /// title + body so what's spoken matches what's shown. nil for the transient
    /// phases (awaiting/paying), which are already focus-visible and shouldn't
    /// interrupt with speech.
    private func announcement(for phase: Phase) -> String? {
        switch phase {
        case .paid:     return "Payment sent. \(paidBody)"
        case .pending:  return "Payment sent, confirming on-chain. \(settleErr.isEmpty ? "It will be verified shortly." : settleErr)"
        case .failed:   return "Payment not sent. \(settleErr.isEmpty ? "The payment could not be completed." : settleErr)"
        case .declined: return "Payment declined. Nothing was charged."
        case .awaiting, .paying: return nil
        }
    }

    // Restore the terminal state a prior tap already reached (C3): a reload
    // decodes item.settled, so a paid/pending/declined quote comes back as its
    // receipt instead of a dead expired "Approve" card. `failed` is left to
    // re-derive as awaiting — a failed attempt moved no money and the quote may
    // still be spendable, so offering approval again is safe (and honest).
    private func seedFromPersisted() {
        guard phase == .awaiting, let s = item.settled else { return }
        switch s.outcome {
        case .paid, .pending, .declined:
            paidMicro = s.paidMicro
            settledNetwork = s.network
            settledPayee = s.payee
            settledExplorer = s.explorer
            settleErr = s.error ?? ""
            phase = s.outcome == .paid ? .paid : (s.outcome == .pending ? .pending : .declined)
        case .failed:
            break
        }
    }

    private var tone: Color { phase == .failed || phase == .declined ? .red : accent }

    private var paidBody: String {
        var s = isTransfer ? "Sent \(usd(paidMicro))" : "Paid \(usd(paidMicro))"
        if let p = settledPayee { s += " to \(shortAddr(p))" }
        // The money-kind label ("trial credit" vs "real USDC"), never the raw
        // short name — TopUp.payNetworkDisplay maps only exact known networks.
        if let n = TopUp.payNetworkDisplay(settledNetwork) { s += " on \(n)" }
        return s + (isTransfer ? " from your wallet." : " over the x402 protocol.")
    }

    // ── Awaiting approval — THE gate ─────────────────────────────────────────
    private var awaiting: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Group the wallet icon + "Approve payment?" + the amount/payee prose
            // into ONE announcement and hide the decorative symbol — the buttons
            // stay OUTSIDE so each remains a distinct actionable element. Matches
            // the paywall card (Views.swift:3755-3764) + web PayReceipt.
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "wallet.pass.fill").foregroundStyle(accent).accessibilityHidden(true)
                    Text("Approve payment?").font(.subheadline.weight(.semibold)).foregroundStyle(accent)
                }
                Text(approveDescription)
                    .font(.caption).foregroundStyle(.primary.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            HStack(spacing: 8) {
                // An expired quote flips the primary button to "Get fresh quote"
                // (re-mint in place) when we have the url; otherwise it stays a
                // disabled Approve. Web parity: PayReceipt's `expired ? reQuote…`.
                Button {
                    if canReQuoteExpired { reQuote() } else { approve() }
                } label: {
                    Text(primaryButtonLabel)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(accent, in: Capsule())
                        .foregroundStyle(.black)
                }
                .disabled(reQuoting || (expired && active.url == nil))
                .opacity((expired && active.url == nil) ? 0.5 : 1)
                Button {
                    phase = .declined
                    onSettled?(PaySettled(outcome: .declined, paidMicro: 0,
                                          network: nil, payee: nil, error: nil))
                } label: {
                    Text("Decline")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .overlay(Capsule().stroke(Color.secondary.opacity(0.4), lineWidth: 1))
                        .foregroundStyle(.secondary)
                }
            }
            if expired {
                Text(active.url != nil
                     ? "This quote expired — get a fresh price to continue."
                     : "This quote expired — ask again for a fresh price.")
                    .font(.caption2).foregroundStyle(.red)
            }
        }
    }

    // ── Failed — inert reason, plus an Add funds / Retry path when recoverable ─
    private var failed: some View {
        VStack(alignment: .leading, spacing: 8) {
            status(icon: "exclamationmark.triangle.fill", spinner: false, title: "Payment not sent",
                   body: settleErr.isEmpty ? "The payment could not be completed." : settleErr, danger: true)
            // An insufficient-balance failure is recoverable: the quote is still
            // valid (no ledger row was written) so a top-up + retry settles it.
            // Only offer it while the quote hasn't expired — past exp the server
            // 410s the retry.
            if needsFunds && !expired {
                HStack(spacing: 8) {
                    Button {
                        if let onAddFunds { onAddFunds() }
                        else if let u = URL(string: "\(Config.serverBase)/wallet") { openURL(u) }
                    } label: {
                        Text("💳 Add funds")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(accent, in: Capsule())
                            .foregroundStyle(.black)
                    }
                    Button(action: approve) {
                        Text("↻ Retry")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .overlay(Capsule().stroke(Color.secondary.opacity(0.4), lineWidth: 1))
                            .foregroundStyle(.secondary)
                    }
                }
            } else if canReQuote {
                // Expired (410) / terms_changed (409) — re-mint a fresh quote in
                // place (moves no money). Web parity: PayReceipt's "Get fresh quote".
                Button(action: reQuote) {
                    Text(reQuoting ? "Getting a fresh quote…" : "↻ Get fresh quote")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(accent, in: Capsule())
                        .foregroundStyle(.black)
                }
                .disabled(reQuoting)
                .opacity(reQuoting ? 0.6 : 1)
            }
        }
    }

    /// The expired-but-re-quotable case: the primary button re-mints instead of
    /// paying (needs the url the quote was minted for).
    private var canReQuoteExpired: Bool { expired && active.url != nil }

    /// Label for the primary awaiting-gate button — "Get fresh quote" when an
    /// expired quote can be re-minted, else the Approve call-to-action.
    private var primaryButtonLabel: String {
        if canReQuoteExpired { return reQuoting ? "Getting a fresh quote…" : "↻ Get fresh quote" }
        return "✓ Approve \(usd(active.priceMicro))"
    }

    private var approveDescription: String {
        var s = isTransfer ? "This will send \(usd(active.priceMicro))" : "This will pay \(usd(active.priceMicro))"
        if let p = active.payee { s += " to \(shortAddr(p))" }
        if let n = TopUp.payNetworkDisplay(active.network) { s += " on \(n)" }
        return s + (isTransfer ? " from your wallet. It only happens when you tap Approve."
                               : " from your wallet, over x402. It only happens when you tap Approve.")
    }

    private func status(icon: String?, spinner: Bool, title: String, body: String, danger: Bool = false) -> some View {
        // One VoiceOver announcement (title + body) with the decorative icon
        // hidden — same money-critical grouping as PayResultCard + the paywall
        // card. The spinner is inherently decorative and carries no a11y text.
        HStack(alignment: .top, spacing: 8) {
            if spinner { ProgressView().scaleEffect(0.7).padding(.top, 1).accessibilityHidden(true) }
            else if let icon { Image(systemName: icon).foregroundStyle(danger ? .red : accent).accessibilityHidden(true) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(danger ? .red : accent)
                Text(body).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Snapshot the current terminal state onto the owning message (C3). Called
    /// only from paid/pending branches — reads the @State the branch just set.
    private func persist(_ outcome: PaySettled.Outcome) {
        onSettled?(PaySettled(outcome: outcome, paidMicro: paidMicro,
                              network: settledNetwork, payee: settledPayee,
                              error: settleErr.isEmpty ? nil : settleErr,
                              explorer: settledExplorer))
    }

    // ── The ONLY money-moving action ─────────────────────────────────────────
    private func approve() {
        // One PUT per tap: allow the first approval and a retry after a
        // recoverable (insufficient-balance) failure, but never while a request
        // is in flight or after a terminal success/decline.
        guard phase == .awaiting || phase == .failed else { return }
        if expired {
            // The quote's 5-min TTL lapsed between render and this tap — the
            // common case is a user who hit an insufficient-balance failure,
            // tapped "Add funds", topped up, and came back past the TTL to tap
            // Retry. No money moved, so a fresh POST quote is safe: offer "Get
            // fresh quote" in place (when we have the url the quote was minted
            // for) rather than dead-ending on an inert error. Web parity:
            // PayReceipt's failed-card canReQuote includes `(nowExpired &&
            // !needsFunds)`, so an expired-at-tap retry there shows the re-quote
            // button — iOS was the only client that froze here.
            settleErr = active.url != nil
                ? "This quote expired — get a fresh price to continue."
                : "This quote expired — ask again for a fresh price."
            needsFunds = false
            canReQuote = active.url != nil
            phase = .failed
            return
        }
        phase = .paying
        settleErr = ""
        // The quote is spendable by ONE session — the execute route resolves the
        // same user from this bearer token (Keychain, like WatchBridge.sync).
        let token = Keychain.get("tiny_token")
        Task {
            // Read `active` — after a re-quote the fresh quote is what we settle.
            let r = await Api.putBody("/api/x402/pay", token: token,
                                      body: ["quote": active.quote, "message": active.message])
            await MainActor.run {
                guard let r else {
                    settleErr = "No response — check your connection and try again."
                    // Don't clobber needsFunds/canReQuote here: a network blip
                    // during a RETRY (the first attempt already learned it was a
                    // funds shortfall / re-quotable) must keep the recovery path
                    // visible — the quote moved no money and is still spendable, so
                    // Add funds + Retry (or Get fresh quote) is still the right
                    // offer. Web parity: PayReceipt re-derives both from the
                    // retained `settled`, and its catch leaves `settled` untouched.
                    // On a FIRST attempt both are still their initial false, so this
                    // correctly shows only the inert error, no phantom buttons.
                    phase = .failed
                    return
                }
                if (r["ok"] as? Bool) == true {
                    paidMicro = (r["paid_micro"] as? NSNumber)?.intValue ?? active.priceMicro
                    settledNetwork = r["network"] as? String ?? active.network
                    settledPayee = r["payee"] as? String ?? active.payee
                    // On-chain proof — present when the service returned a
                    // settlement header (web parity: settled.explorer → BaseScan
                    // link). The already_paid 409 body carries no explorer.
                    settledExplorer = r["explorer"] as? String
                    phase = .paid
                    persist(.paid)
                } else if (r["already_paid"] as? Bool) == true {
                    // 409: this exact quote already settled on-chain (re-approve
                    // after a dropped response, a raced double-tap, or a retry
                    // whose first attempt secretly succeeded). The money DID
                    // move — showing "not sent" would be the opposite of the
                    // truth and could push the user to pay twice. Treat as paid.
                    // The 409 body carries price_micro, not paid_micro.
                    paidMicro = (r["paid_micro"] as? NSNumber)?.intValue
                        ?? (r["price_micro"] as? NSNumber)?.intValue ?? active.priceMicro
                    settledNetwork = r["network"] as? String ?? active.network
                    settledPayee = r["payee"] as? String ?? active.payee
                    phase = .paid
                    persist(.paid)
                } else if (r["pending_confirmation"] as? Bool) == true {
                    // The signed authorization LEFT us — the service may have
                    // settled on-chain but didn't confirm in time (202). NOT
                    // "not sent": retrying could double-pay a third-party. Show
                    // an "on its way" state and offer no retry (mirror withdraw).
                    settleErr = (r["error"] as? String) ?? "Payment was sent — confirming on-chain."
                    needsFunds = false
                    phase = .pending
                    persist(.pending)
                } else {
                    settleErr = (r["error"] as? String) ?? "The payment could not be completed."
                    // payment_required → recoverable: show Add funds + Retry.
                    needsFunds = (r["payment_required"] as? Bool) == true
                    // expired (410) / terms_changed (409, reservation reversed) →
                    // re-quotable in place (both moved no money). Needs the url the
                    // quote was minted for. Web parity: PayReceipt canReQuote.
                    canReQuote = active.url != nil
                        && ((r["expired"] as? Bool) == true || (r["terms_changed"] as? Bool) == true)
                    phase = .failed
                    // A failed attempt is NOT persisted as terminal: no money
                    // moved and the quote may still be spendable, so a reload
                    // should offer approval again rather than freeze on the error.
                }
            }
        }
    }

    // ── Re-mint a fresh quote for the same service (moves NO money) ───────────
    // POST /api/x402/pay is quote-only. Used when the current quote is unusable —
    // expired (410) or the service changed its terms (409, reservation reversed
    // server-side) — so the card recovers in place without a new agent turn. The
    // streamed quote carries the original url + message. Web parity: reQuote().
    private func reQuote() {
        guard let url = active.url, !reQuoting else { return }
        reQuoting = true
        let msg = active.message
        let priorQuote = active.quote
        let token = Keychain.get("tiny_token")
        Task {
            // Hand back the expired quote token as `prior_quote` so the server can
            // decode its (HMAC-bound, un-forgeable) maxSpendMicro and carry the
            // agent's ORIGINAL spend cap into the fresh quote. Without it a
            // re-quote reverts to the $25 platform ceiling, so a price hike between
            // quotes could show an approval over the cap the agent was told to
            // stay under. Web parity: PayReceipt.reQuote's prior_quote.
            let r = await Api.postBody("/api/x402/pay", token: token,
                                       body: ["url": url, "message": msg, "prior_quote": priorQuote])
            await MainActor.run {
                reQuoting = false
                guard let r,
                      (r["ok"] as? Bool) == true,
                      (r["requires_confirmation"] as? Bool) == true,
                      let quote = r["quote"] as? String else {
                    settleErr = (r?["error"] as? String) ?? "Couldn’t get a fresh quote — try asking again."
                    needsFunds = false
                    canReQuote = false
                    phase = .failed
                    return
                }
                // Swap in the fresh quote (carry url/message forward — the POST
                // response omits them) and drop back to the approval gate.
                fresh = PayQuoteItem(
                    id: item.id, quote: quote,
                    priceMicro: (r["price_micro"] as? NSNumber)?.intValue ?? 0,
                    network: r["network"] as? String,
                    payee: r["payee"] as? String,
                    expiresAt: (r["expires_at"] as? NSNumber)?.doubleValue,
                    message: msg, url: url)
                settleErr = ""
                needsFunds = false
                canReQuote = false
                phase = .awaiting
            }
        }
    }
}

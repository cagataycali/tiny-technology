/**
 * ⛓️ ChainView — the native port of the web /chain explorer.
 *
 * Closes the user's gap ("we dont see the chain details in the mobile apps"):
 * which chain this deployment settles on, whether the node agrees with our config,
 * the latest block, the TinyUSDC contract, and recent money movement — on phone,
 * where the wallet already is.
 *
 * All parsing and every "what does this state mean" decision lives in
 * `ChainStatusModel` (pure, tested). This file is layout: it reads a `Status` and
 * renders it. Presented as a NavigationLink from Settings so it inherits the
 * enclosing NavigationStack, exactly like WalletView.
 */
import SwiftUI
import UIKit

struct ChainView: View {
    let token: String?
    @Environment(\.tinyAccent) private var accent

    @State private var state: LoadState = .loading
    @State private var status = ChainStatusModel.Status()
    @State private var copied = ""

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView("Reading the chain…")
            case .failed(let e):
                ContentUnavailableView {
                    Label("Couldn't reach the chain", systemImage: "link.badge.plus")
                } description: {
                    Text(e)
                } actions: {
                    Button("Retry") { Task { state = .loading; await load() } }
                }
            case .loaded:
                List {
                    Section {
                        Text(ChainStatusModel.headline(status))
                            .font(.callout)
                            // A mismatch is the one headline that changes what the
                            // numbers below MEAN, so it doesn't read as body copy.
                            .foregroundStyle(isMismatch ? .primary : .secondary)
                    }

                    if status.health != .notConfigured {
                        networkSection
                    }

                    if status.showsActivity {
                        activitySection
                    }

                    Section {
                        Text(status.moneyNote).font(.caption).foregroundStyle(.secondary)
                        // Anyone can run a node — the claim the chain makes about
                        // itself, and the endpoint that backs it up.
                        if status.health == .ok {
                            Link(destination: URL(string: "\(Api.base)/api/chain/join")!) {
                                Label("Run your own node", systemImage: "server.rack")
                            }
                            .foregroundStyle(accent)
                        }
                    }
                }
            }
        }
        .refreshable { await load() }
        .navigationTitle("Chain")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var isMismatch: Bool {
        if case .mismatch = status.health { return true }
        return false
    }

    // ── Network ─────────────────────────────────────────────────────────────
    private var networkSection: some View {
        Section("⛓️ Network") {
            if let caip2 = status.caip2 {
                LabeledContent("Chain") {
                    HStack(spacing: 6) {
                        Text(caip2).font(.system(.footnote, design: .monospaced))
                        if isMismatch {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.caption2).foregroundStyle(.orange)
                        }
                    }
                }
            }
            // The node's own answer, shown ONLY when it contradicts us. On a match
            // it would be the same number under a second label, which reads as a
            // discrepancy where there is none.
            if case .mismatch(_, let reported) = status.health {
                LabeledContent("Node reports") {
                    Text("eip155:\(reported)")
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.orange)
                }
            }
            LabeledContent("Latest block") {
                // nil is "we don't know", never 0 — block 0 is a real height and
                // showing it would claim a chain that has never produced a block.
                Text(status.latestBlock.map { "#\($0)" } ?? "unknown")
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(status.latestBlock == nil ? .secondary : .primary)
            }
            if let usdc = status.usdc {
                Button {
                    UIPasteboard.general.string = usdc
                    copied = usdc
                } label: {
                    LabeledContent("TinyUSDC") {
                        HStack(spacing: 4) {
                            Text(ChainStatusModel.shorten(usdc))
                                .font(.system(.footnote, design: .monospaced))
                            Image(systemName: copied == usdc ? "checkmark" : "doc.on.doc")
                                .font(.caption2)
                        }
                        .foregroundStyle(copied == usdc ? .green : accent)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy the TinyUSDC contract address")
            }
        }
    }

    // ── Activity ────────────────────────────────────────────────────────────
    private var activitySection: some View {
        Section {
            if status.transfers.isEmpty {
                // Scoped, not absolute: we only looked at the last `span` blocks,
                // so "no activity" without the window is a bigger claim than we
                // can support.
                Text(status.span.map { "No TinyUSDC movement in the last \($0) blocks." }
                    ?? "No recent TinyUSDC movement.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(status.transfers) { t in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(t.kindLabel).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Text(t.amount)
                                .font(.system(.footnote, design: .monospaced))
                                .fontWeight(.medium)
                                // A clamped amount is not a number we can stand
                                // behind — mark it where it's read.
                                .foregroundStyle(t.clamped ? .orange : .primary)
                        }
                        HStack(spacing: 4) {
                            Text(t.fromShort)
                            Image(systemName: "arrow.right").font(.caption2)
                            Text(t.toShort)
                        }
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            if let b = t.blockNumber {
                                Text("#\(b)").font(.caption2).foregroundStyle(.secondary)
                            }
                            Text(t.hashShort).font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        UIPasteboard.general.string = t.hash
                        copied = t.hash
                    }
                    .accessibilityLabel("\(t.kindLabel), \(t.amount), from \(t.fromShort) to \(t.toShort)")
                }
            }
        } header: {
            Text("💸 Recent TinyUSDC activity")
        } footer: {
            if !status.transfers.isEmpty {
                Text("Tap a row to copy its transaction hash.")
            }
        }
    }

    private func load() async {
        let body = await Api.getBody("/api/chain/status", token: token)
        guard let parsed = ChainStatusModel.parse(body) else {
            // A transport failure or an unparseable body. Only escalate to the
            // full-screen failure on the INITIAL load: a blip during
            // pull-to-refresh must not tear down a screen that's already showing
            // valid chain data (same rule as WalletView.load).
            if case .loading = state {
                state = .failed("Couldn't read the chain status. Pull to try again.")
            }
            return
        }
        status = parsed
        state = .loaded
    }
}

"use client";
/**
 * Expandable tool card for builder profiles — click to reveal the tool's
 * params + source, "Use this tool" copies it into the visitor's own
 * account via /api/tools/install (401 → GitHub sign-in round-trip).
 */
import { useState } from "react";
import { useConfirm } from "./chat/ConfirmDialog";
import { IconTrash } from "./chat/icons";
import { usd } from "@/lib/utils";
import { deadlineFor, failureMessage } from "@/lib/deadlines";

export type ProfileTool = {
  name: string;
  description: string;
  params?: Record<string, string>;
  code?: string;
  created: number;
  price_micro?: number; // >0 → one-time purchase to install (set via set_price)
};

const GREEN = "var(--tiny-accent)";
const BORDER = "rgba(var(--tiny-accent-rgb),0.2)";

export default function ProfileToolCard({
  tool,
  ownerLogin,
  canDelete,
  onDeleted,
}: {
  tool: ProfileTool;
  ownerLogin: string;
  canDelete?: boolean; // visitor owns this profile (session-checked upstream)
  onDeleted?: () => void; // parent removes the card from its list
}) {
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { confirm, dialog } = useConfirm();

  const params = tool.params || {};
  const paramEntries = Object.entries(params);

  // Paid tool → one-time purchase on install. A one-time install charge is a
  // CHARGE, not a per-message rate, so format it through the canonical usd()
  // (Rule B: min-2 fraction digits → "$0.50"/"$1.00", up to 6 for sub-cent) —
  // the SAME formatter the server-side install paywall message uses
  // (app/api/tools/install/route.ts → usd()) and the wallet ledger. The old
  // local `.toFixed(4).replace(/\.?0+$/,"")` claimed to mirror them but did the
  // opposite: it rendered "$0.5"/"$1" (and a bare "$" for a ≤$0.00005 price),
  // so the card said "$0.5 to install" while the 402 paywall said "$0.50".
  const priceMicro = Number(tool.price_micro || 0);
  const priceLabel = priceMicro > 0 ? usd(priceMicro) : "";

  async function install(e: React.MouseEvent) {
    e.stopPropagation();
    setInstalling(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tools/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: ownerLogin, name: tool.name }),
        // An install can settle a payment (402 path), so the budget comes from
        // the table — /api/tools/install gives the worker 15s.
        signal: AbortSignal.timeout(deadlineFor("/api/tools/install")),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        // Not signed in — GitHub OAuth round-trip back to this profile
        window.location.href = `/api/auth?return_to=${encodeURIComponent(`/@${ownerLogin}`)}`;
        return;
      }
      if (data.ok) {
        setStatus({
          kind: "ok",
          msg: data.updated
            ? `Updated my_${data.name} — already in your toolbox.`
            : `Added! Ask any of your tinys to use my_${data.name}.`,
        });
      } else if (res.status === 402 || data.payment_required) {
        // Paywalled: the tool has a one-time install price and the wallet is
        // short (or settlement failed). The API message already names the
        // price + balance; point the user at /wallet to top up.
        setStatus({ kind: "err", msg: `${data.error || "Payment required to install."} → /wallet` });
      } else {
        setStatus({ kind: "err", msg: data.error || `install failed (${res.status})` });
      }
    } catch (err: any) {
      // This used to stringify the exception straight into the card, which
      // renders a deadline as "signal timed out" — failureMessage classifies it
      // and returns copy a person can act on.
      setStatus({ kind: "err", msg: failureMessage(err, "Install failed — try again") || "" });
    } finally {
      setInstalling(false);
    }
  }

  async function copyCode(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(tool.code || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { }
  }

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    // On-brand confirm (portaled, focus-trapped) instead of native
    // window.confirm() — matches the /devices + /wallet destructive flows.
    const ok = await confirm({
      title: "Delete tool?",
      message: `my_${tool.name} — anyone who already installed a copy keeps theirs. This removes it from your toolbox.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tools", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tool.name }),
        signal: AbortSignal.timeout(deadlineFor("/api/tools")),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        onDeleted?.();
      } else {
        setStatus({ kind: "err", msg: data.error || `delete failed (${res.status})` });
      }
    } catch (err: any) {
      setStatus({ kind: "err", msg: failureMessage(err, "Delete failed — try again") || "" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
    <div
      // 14px = the tinyCard signature (cards are 14 app-wide, c1/c27)
      className="rounded-[14px] border transition-all"
      style={{ background: "rgba(255,255,255,0.06)", borderColor: open ? "rgba(var(--tiny-accent-rgb),0.45)" : BORDER }}
    >
      {/* Real <button> header: keyboard-expandable (Enter/Space, tab stop,
          aria-expanded) — was a div onClick, invisible to keyboards. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="w-full p-4 flex items-center gap-3 text-left rounded-[14px] transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.04)]"
      >
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold flex items-center gap-2" style={{ color: GREEN }}>
            my_{tool.name}
            {priceLabel && (
              <span
                className="text-[10px] font-sans font-semibold px-1.5 py-0.5 rounded-full"
                style={{ background: "rgba(var(--tiny-accent-rgb),0.15)", color: GREEN }}
              >
                {priceLabel} to install
              </span>
            )}
          </div>
          {tool.description && (
            <div className="text-xs text-gray-400 mt-1">{tool.description}</div>
          )}
        </div>
        <span className="text-xs text-gray-600 select-none" aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {paramEntries.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Params</div>
              <div className="rounded-lg border p-2 space-y-1" style={{ borderColor: BORDER }}>
                {paramEntries.map(([k, desc]) => (
                  <div key={k} className="text-xs">
                    <span className="font-mono" style={{ color: GREEN }}>{k}</span>
                    <span className="text-gray-400"> — {String(desc || "")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tool.code && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs uppercase tracking-wide text-gray-500">Source</div>
                <button
                  onClick={copyCode}
                  aria-live="polite"
                  className="text-xs px-2 py-0.5 rounded border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
                  style={{ borderColor: BORDER, color: GREEN }}
                >
                  {copied ? "copied ✓" : "copy"}
                </button>
              </div>
              <pre
                className="rounded-lg border p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words"
                style={{ borderColor: BORDER, color: "#b9ffd9", background: "rgba(var(--tiny-accent-rgb),0.04)" }}
              >{tool.code}</pre>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={install}
              disabled={installing}
              className="px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
              style={{ background: GREEN, color: "#000", boxShadow: "0 0 12px rgba(var(--tiny-accent-rgb),0.3)" }}
            >
              {installing ? "Installing…" : priceLabel ? `Buy · ${priceLabel} →` : "Use this tool →"}
            </button>
            {canDelete && (
              <button
                onClick={remove}
                disabled={deleting}
                className="px-3 py-2 rounded-xl text-sm transition-colors border hover:bg-red-500/10 disabled:opacity-50"
                style={{ borderColor: "rgba(var(--tiny-danger-rgb), 0.4)", color: "var(--tiny-danger)" }}
              >
                {deleting ? "Deleting…" : <span className="inline-flex items-center gap-1.5"><IconTrash className="w-4 h-4" /> Delete</span>}
              </button>
            )}
            {status && (
              <span role={status.kind === "err" ? "alert" : "status"} className="text-xs" style={{ color: status.kind === "ok" ? GREEN : "var(--tiny-danger)" }}>
                {status.msg}
              </span>
            )}
          </div>
          <div className="text-[10px] text-gray-500">
            {priceLabel && `One-time ${priceLabel} charge from your wallet on install. `}
            Runs in your own sandbox — public https fetch only, 10s timeout, no secrets.
          </div>
        </div>
      )}
    </div>
    {dialog}
    </>
  );
}

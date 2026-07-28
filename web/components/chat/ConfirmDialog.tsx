"use client";

/**
 * Shared confirm/type-to-confirm dialog — the on-brand replacement for the
 * native window.confirm()/prompt() that broke the app's portaled, blurred,
 * neon-bordered overlay aesthetic (and ignored its focus-return / exit
 * choreography).
 *
 * Usage — a promise-based API that mirrors native confirm() so call sites
 * stay imperative:
 *
 *   const { confirm, dialog } = useConfirm();
 *   // …
 *   const ok = await confirm({ message: "Delete this job?", confirmLabel: "Delete", danger: true });
 *   if (!ok) return;
 *   // …and render {dialog} once anywhere in the component's tree.
 *
 * Type-to-confirm (the /api/delete "type the name" flow): pass `requireText`;
 * the promise resolves true only when the input matches it exactly.
 *
 * Grammar match: portaled to <body>, aria-modal dialog, focus moves in on
 * open and returns to the opener on close (useOverlayExit), Escape / backdrop
 * / Cancel all dismiss, riseIn/riseOut enter+exit (reduced-motion clamps to
 * 0.01ms globally so animationend still fires instantly).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";

export interface ConfirmOptions {
  message: string;
  /** Optional bold heading above the message. */
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red destructive styling on the confirm button. */
  danger?: boolean;
  /** Require the user to type this exact string to enable confirm. */
  requireText?: string;
  /** Placeholder for the requireText input. */
  requirePlaceholder?: string;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // If a confirm is already open, settle its promise (as declined) before
      // replacing it — otherwise its awaiting caller hangs forever. Current
      // call sites are one-confirm-per-gesture so this is defensive, but the
      // API shouldn't strand a promise if that ever changes.
      setPending((prev) => {
        prev?.resolve(false);
        return { ...opts, resolve };
      });
    });
  }, []);

  const dialog = pending ? (
    <ConfirmDialog
      key={pending.message}
      opts={pending}
      onResolve={(ok) => {
        pending.resolve(ok);
        setPending(null);
      }}
    />
  ) : null;

  return { confirm, dialog };
}

function ConfirmDialog({ opts, onResolve }: { opts: ConfirmOptions; onResolve: (ok: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The value the exit resolves with. Cancel/backdrop/Escape leave it false;
  // accept() flips it true before requesting close, so BOTH paths flow through
  // useOverlayExit's finish() — same riseOut exit AND the same focus-return to
  // the opener. Without this the confirm button called onResolve(true) directly,
  // unmounting the dialog without ever restoring focus (it fell to <body>), so
  // every destructive flow — delete job/memory/DM/tiny, disconnect telegram,
  // revoke device — stranded keyboard/SR users at the top of the page on
  // confirm while cancel correctly returned them.
  const resultRef = useRef(false);
  // Centered element → riseIn/riseOut is fine (translateY-only, no -translate-x
  // to fight). useOverlayExit returns focus to whatever opened us on close.
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(
    () => onResolve(resultRef.current), openerRef,
  );

  // Capture the opener at mount; move focus into the dialog (aria-modal).
  // Prefer the text input when type-to-confirm; else the panel container.
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    (opts.requireText ? inputRef.current : panelRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Trap Tab inside (WCAG 2.4.3) — the dialog only mounts while pending, and
  // aria-modal marks everything behind it (including the overlay that opened
  // it) inert. Cancel and Confirm are the only two Tab stops.
  useFocusTrap(panelRef, true);

  useEffect(() => {
    // Capture phase + stopPropagation: the opener (JobsPanel, MessagesHUD, …)
    // has its own document-level Escape→close listener. Without this, one
    // Escape would dismiss both the dialog AND the panel underneath it. The
    // dialog is topmost, so it consumes Escape first and alone.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); requestClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [requestClose]);

  const matched = !opts.requireText || typed === opts.requireText;
  const accept = () => { if (matched) { resultRef.current = true; requestClose(); } };

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* Backdrop click = cancel (requestClose plays the exit + returns focus) */}
      <div className="fixed inset-0 z-[110] bg-black/50" style={{ backdropFilter: "blur(2px)" }} onClick={requestClose} />
      <div
        className="fixed inset-0 z-[111] flex items-center justify-center px-4 pointer-events-none"
      >
        <div
          ref={panelRef}
          role="alertdialog"
          aria-modal="true"
          aria-label={opts.title || "Confirm"}
          tabIndex={-1}
          onAnimationEnd={onAnimationEnd}
          className={`pointer-events-auto outline-none w-full max-w-sm max-h-[90dvh] overflow-y-auto rounded-2xl border p-5 space-y-4 ${exitClass}`}
          style={{
            background: "rgba(10,10,10,0.98)",
            borderColor: "rgba(var(--tiny-accent-rgb),0.3)",
            boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
          }}
        >
          {opts.title && (
            <div className="text-sm font-semibold text-white">{opts.title}</div>
          )}
          <p className="text-sm text-gray-300 whitespace-pre-wrap">{opts.message}</p>

          {opts.requireText && (
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && matched) { e.preventDefault(); accept(); } }}
              placeholder={opts.requirePlaceholder || opts.requireText}
              // text-base on mobile: iOS Safari auto-zooms on focus of any
              // input under 16px, shifting this centered modal partly
              // off-screen — and this field is REQUIRED to confirm a
              // destructive action. sm:text-sm keeps the desktop size.
              className="w-full rounded-xl border px-3 py-2 text-base sm:text-sm bg-transparent text-white placeholder-gray-600 focus:outline-none transition-colors"
              style={{ borderColor: "rgba(255,255,255,0.18)" }}
              aria-label="Type to confirm"
            />
          )}

          <div className="flex gap-3 justify-end">
            <button
              onClick={requestClose}
              className="px-4 py-2 rounded-xl text-sm border text-gray-300 transition-colors hover:text-white hover:border-white/40"
              style={{ background: "rgba(0,0,0,0.5)", borderColor: "rgba(255,255,255,0.2)" }}
            >
              {opts.cancelLabel || "Cancel"}
            </button>
            <button
              onClick={accept}
              disabled={!matched}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:scale-105 active:scale-100 disabled:opacity-40 disabled:hover:scale-100 disabled:cursor-not-allowed ${
                opts.danger ? "text-white" : "text-black"
              }`}
              style={opts.danger
                ? { background: "rgba(var(--tiny-danger-rgb),0.9)" }
                : { background: "var(--tiny-accent)", boxShadow: "0 0 20px rgba(var(--tiny-accent-rgb),0.25)" }}
            >
              {opts.confirmLabel || "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

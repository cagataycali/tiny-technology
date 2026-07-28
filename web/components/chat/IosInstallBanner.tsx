"use client";

/**
 * "Get the app on your phone" banner — the PWA install path (no App Store, no
 * Apple Developer account needed). Complements InstallPrompt, which fires only
 * on `beforeinstallprompt` — an event **iOS Safari never dispatches**, so iOS
 * visitors otherwise get no install affordance at all. This banner closes that
 * gap and serves two audiences:
 *
 *   - On an iPhone/iPad in Safari → step-by-step "Add to Home Screen".
 *   - On desktop → a QR that opens tiny on the phone (where they can install).
 *
 * The QR SVG is generated server-side (app/page.tsx) so the `qrcode` lib never
 * enters the client bundle. Self-hides when already installed (standalone),
 * when previously dismissed, or (on iOS) when Chrome/Firefox — whose Share
 * sheet has no "Add to Home Screen" — is detected.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { detectInstallMode, shouldShowBanner, type InstallMode } from "../../lib/chat/install-mode";
import { sanitizeQrSvg } from "../../lib/qr-svg";
import { IconShare, IconDevice } from "./icons";

const DISMISS_KEY = "tiny-a2hs-dismissed";

type Mode = InstallMode;

// Thin DOM adapter over the pure detectInstallMode (unit-tested separately).
function detectMode(): Mode {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  return detectInstallMode({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone: window.matchMedia("(display-mode: standalone)").matches,
  });
}

export default function IosInstallBanner({ url, qrSvg }: { url: string; qrSvg: string }) {
  // Gate the innerHTML payload HERE rather than at the one caller, so the rule
  // travels with the sink: `qrSvg` is a plain string prop, and "our own
  // qrcode-lib SVG, no user input" was a true statement about today's single
  // caller, not something the code enforced. sanitizeQrSvg allowlists the QR
  // vocabulary and returns '' for anything else — the SAME value app/page.tsx
  // yields when generation fails, so the existing self-hide below covers it
  // with no new state. See lib/qr-svg.ts.
  const safeQrSvg = useMemo(() => sanitizeQrSvg(qrSvg), [qrSvg]);
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  // When the browser offers a native install prompt, InstallPrompt (z-90)
  // claims the same bottom-center slot we do (z-89) — two banners would stack
  // at identical coordinates. We only OBSERVE beforeinstallprompt here (never
  // preventDefault/prompt — that stays InstallPrompt's job) so that on a
  // natively-installable desktop we yield the slot. Our desktop QR still
  // shows where no native prompt exists (desktop Safari/Firefox), and the
  // iOS Safari path is unaffected (Safari never fires the event).
  const nativeInstallRef = useRef(false);
  // Bottom-anchored centered panel → slide pair (riseOut's translateY-only
  // frames would yank a translate-x:-50% element sideways). Matches InstallPrompt.
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(
    () => setShow(false), undefined,
    { enter: "animate-slideInUp", exit: "animate-slideOutDown" },
  );

  useEffect(() => {
    const m = detectMode();
    if (!m) return;
    if (m === "desktop-qr" && !safeQrSvg) return; // nothing to show without a USABLE QR
    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch { }
    // Observe (don't consume) the native install prompt so we can yield the
    // slot to InstallPrompt on natively-installable desktops. Safari never
    // fires this, so the ios-safari path is unaffected.
    const onNative = () => { nativeInstallRef.current = true; };
    window.addEventListener("beforeinstallprompt", onNative);
    // Yield to onboarding + the PWA InstallPrompt first-visit surfaces so we
    // never race them for the bottom-center slot; bounded retries. Both state
    // sets are deferred (never synchronous in the effect body).
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retries = 5;
    const arm = () => {
      try {
        if (!localStorage.getItem("tiny_onboarded") && retries-- > 0) {
          timer = setTimeout(arm, 5000);
          return;
        }
      } catch { }
      // On iOS Safari, InstallPrompt's iOS-beta banner (z-90) claims this same
      // bottom-center slot at 4s until its own key is set — check it live at
      // arm time (after our 8s + retries the user may have just dismissed it).
      let iosBetaActive = false;
      try { iosBetaActive = m === "ios-safari" && !localStorage.getItem("tiny-ios-beta-dismissed"); } catch { }
      // A native prompt landed → InstallPrompt owns the desktop slot; our QR
      // would only stack a redundant second banner. On iOS Safari, yield to the
      // still-eligible beta banner. Either way, stand down.
      if (!shouldShowBanner(m, { nativeInstallAvailable: nativeInstallRef.current, iosBetaActive })) return;
      setMode(m);
      setShow(true);
    };
    timer = setTimeout(arm, 8000);
    return () => {
      window.removeEventListener("beforeinstallprompt", onNative);
      if (timer) clearTimeout(timer);
    };
  }, [safeQrSvg]);

  if (!show || !mode) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, Date.now().toString()); } catch { }
    requestClose();
  };

  return (
    <div
      // A passive, non-modal promo — it never receives focus and isn't a
      // dismiss-to-continue surface, so role="dialog" over-promised (a SR user
      // is told a dialog opened but never lands in it). region = a labelled
      // landmark they can navigate to, matching what this banner actually is.
      role="region"
      aria-label="Install tiny on your phone"
      className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-[89] flex items-center gap-4 px-5 py-4 rounded-2xl border w-[calc(100%-2rem)] ${mode === "desktop-qr" ? "max-w-md" : "max-w-sm"} ${exitClass}`}
      onAnimationEnd={onAnimationEnd}
      style={{
        background: "rgba(10,10,10,0.97)",
        borderColor: "rgba(var(--tiny-accent-rgb),0.3)",
        boxShadow: "0 0 40px rgba(var(--tiny-accent-rgb),0.15)",
      }}
    >
      {mode === "desktop-qr" ? (
        <>
          {/* Server-rendered QR, allowlisted by lib/qr-svg before injection —
              a QR is a fixed vocabulary (<svg>/<path>, no href, no handlers),
              so anything else is refused wholesale instead of sanitized. */}
          <a
            href={url}
            aria-label="Open tiny on this device"
            // The qrcode SVG carries fixed width/height attributes (256²) but a
            // small viewBox; force it to fill the box via [&>svg] so it scales
            // by the viewBox instead of overflowing and clipping to a corner.
            className="shrink-0 rounded-lg overflow-hidden bg-white p-1.5 leading-none transition-transform hover:scale-105 active:scale-100 [&>svg]:w-full [&>svg]:h-full [&>svg]:block"
            style={{ width: 128, height: 128 }}
            dangerouslySetInnerHTML={{ __html: safeQrSvg }}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: "var(--tiny-accent)" }}>
              Get tiny on your phone
            </div>
            <div className="text-xs text-gray-400">
              Scan to open on your iPhone, then <span className="text-gray-300">Share → Add to Home Screen</span>. No App Store needed.
            </div>
          </div>
        </>
      ) : (
        <>
          <div
            className="shrink-0 grid place-items-center rounded-xl"
            style={{ width: 44, height: 44, background: "rgba(var(--tiny-accent-rgb),0.12)", color: "var(--tiny-accent)" }}
            aria-hidden
          >
            <IconDevice className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: "var(--tiny-accent)" }}>
              Add tiny to your Home Screen
            </div>
            <div className="text-xs text-gray-400">
              Tap <IconShare className="inline-block w-3.5 h-3.5 -mt-0.5 align-middle" /> <span className="text-gray-300">Share</span>, then <span className="text-gray-300">Add to Home Screen</span> — full-screen, offline-ready. No App Store needed.
            </div>
          </div>
        </>
      )}
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="ml-auto self-start px-2 py-1 rounded-lg text-xs whitespace-nowrap transition-colors hover:text-white hover:bg-white/5"
        style={{ color: "#888" }}
      >
        ✕
      </button>
    </div>
  );
}

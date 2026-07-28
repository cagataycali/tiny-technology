"use client";

/**
 * PWA install banner (careless InstallPrompt.tsx pattern): capture
 * beforeinstallprompt, show after a 3s delay, remember dismissal,
 * skip when already standalone.
 */
import { useEffect, useState } from "react";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "tiny-pwa-install-dismissed";
const IOS_DISMISS_KEY = "tiny-ios-beta-dismissed";
const ANDROID_DISMISS_KEY = "tiny-android-app-dismissed";

// localStorage access can THROW (SecurityError in private-browsing / a
// sandboxed iframe embed / storage disabled), not just return null. These
// reads run in the mount effect and the writes in click handlers, so an
// unguarded throw would propagate out of the effect and could crash the tree
// for every private-mode visitor. Mirror the sibling banners
// (IosInstallBanner/ActivityHUD/Onboarding) which already wrap the identical
// calls. On read failure fall back to null → treated as "not dismissed" (the
// banner shows, the existing default); on write failure no-op silently.
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage blocked — dismissal just won't persist */ }
}

/** iPhone/iPad Safari — beforeinstallprompt NEVER fires there, so the PWA
 * banner is unreachable; offer the native beta instead. */
function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return isIos && !(window as any).MSStream;
}

/** Android — the native APK is a fuller experience than the PWA (voice, fleet
 * node, widgets, share target), so offer it regardless of whether
 * beforeinstallprompt fires. */
function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/.test(navigator.userAgent);
}

export default function InstallPrompt({ name }: { name: string }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);
  const [iosBeta, setIosBeta] = useState(false);
  const [androidApp, setAndroidApp] = useState(false);
  // "Not now" leaves the way the banner arrived (slide pair — the panel
  // is centered, riseOut's plain translateY would yank it sideways).
  // Install keeps the instant hide: the user just left a native sheet.
  // One hook drives all three banners (iOS beta / Android / PWA) — they're
  // mutually exclusive, so resetting every flag on close is safe and lets each
  // slide out via the same grammar instead of snapping away.
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(
    () => { setShow(false); setIosBeta(false); setAndroidApp(false); }, undefined,
    { enter: "animate-slideInUp", exit: "animate-slideOutDown" },
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    // 📱 iOS: native app beta instead of the (unfireable) PWA prompt
    if (isIosSafari()) {
      if (safeGet(IOS_DISMISS_KEY)) return;
      const t = setTimeout(() => setIosBeta(true), 4000);
      return () => clearTimeout(t);
    }

    // 🤖 Android: the native APK beats the PWA (voice, fleet node, widgets,
    // share target). Offer it directly — don't wait on beforeinstallprompt.
    if (isAndroid()) {
      if (safeGet(ANDROID_DISMISS_KEY)) return;
      const t = setTimeout(() => setAndroidApp(true), 4000);
      return () => clearTimeout(t);
    }

    if (safeGet(DISMISS_KEY)) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let armed = false;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      // Always keep the freshest event — prompt() must use the latest one.
      setDeferred(e as BeforeInstallPromptEvent);
      // …but only start the reveal-timer chain ONCE. The browser may re-fire
      // beforeinstallprompt (eligibility re-checks); a second chain would
      // overwrite `timer`, so cleanup could clear only the latest handle and
      // an orphaned earlier chain would still call setShow after unmount.
      if (armed) return;
      armed = true;
      // One first-visit surface at a time: while the onboarding modal is
      // pending/open (no tiny_onboarded flag yet), defer — the install ask
      // lands after the model choice, not on top of it. Bounded: visitors
      // who never see onboarding this load (?q= deep links set no flag)
      // still get the banner after a few retries.
      let retries = 4;
      const arm = () => {
        try {
          if (!localStorage.getItem("tiny_onboarded") && retries-- > 0) {
            timer = setTimeout(arm, 5000);
            return;
          }
        } catch { }
        setShow(true);
      };
      timer = setTimeout(arm, 3000);
    };
    const onInstalled = () => {
      setShow(false);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (iosBeta) {
    return (
      <div
        // A passive, non-modal promo — it never receives focus and isn't a
        // dismiss-to-continue surface, so role="dialog" over-promised (a SR user
        // is told a dialog opened but never lands in it). region = a labelled
        // landmark they can navigate to, matching the IosInstallBanner sibling.
        role="region"
        aria-label="Get the native iOS app"
        className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-[90] flex items-center gap-3 px-5 py-3 rounded-2xl border max-w-sm w-[calc(100%-2rem)] ${exitClass}`}
        onAnimationEnd={onAnimationEnd}
        style={{
          background: "rgba(10,10,10,0.97)",
          borderColor: "rgba(var(--tiny-accent-rgb),0.3)",
          boxShadow: "0 0 40px rgba(var(--tiny-accent-rgb),0.15)",
        }}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold" style={{ color: "var(--tiny-accent)" }}>
            🌱 tiny for iPhone
          </div>
          <div className="text-xs text-gray-400">
            Native app beta — <span style={{ color: "var(--tiny-accent)" }}>only 100 spots</span> · voice mode · your phone becomes a node
          </div>
        </div>
        <button
          onClick={() => {
            safeSet(IOS_DISMISS_KEY, Date.now().toString());
            requestClose();
          }}
          className="ml-auto px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors hover:text-white hover:bg-white/5"
          style={{ color: "#888" }}
        >
          Not now
        </button>
        <a
          href="/ios/"
          className="px-4 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all hover:scale-105"
          style={{ background: "var(--tiny-accent)", color: "#000", boxShadow: "0 0 12px rgba(var(--tiny-accent-rgb),0.25)" }}
        >
          Join beta
        </a>
      </div>
    );
  }

  if (androidApp) {
    return (
      <div
        // Passive non-modal promo (see the iOS variant above) — region, not dialog.
        role="region"
        aria-label="Get the native Android app"
        className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-[90] flex items-center gap-3 px-5 py-3 rounded-2xl border max-w-sm w-[calc(100%-2rem)] ${exitClass}`}
        onAnimationEnd={onAnimationEnd}
        style={{
          background: "rgba(10,10,10,0.97)",
          borderColor: "rgba(var(--tiny-accent-rgb),0.3)",
          boxShadow: "0 0 40px rgba(var(--tiny-accent-rgb),0.15)",
        }}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold" style={{ color: "var(--tiny-accent)" }}>
            🌱 tiny for Android
          </div>
          <div className="text-xs text-gray-400">
            Native app — voice mode · your phone becomes a node · home-screen widgets
          </div>
        </div>
        <button
          onClick={() => {
            safeSet(ANDROID_DISMISS_KEY, Date.now().toString());
            requestClose();
          }}
          className="ml-auto px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors hover:text-white hover:bg-white/5"
          style={{ color: "#888" }}
        >
          Not now
        </button>
        <a
          href="/android/"
          className="px-4 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all hover:scale-105"
          style={{ background: "var(--tiny-accent)", color: "#000", boxShadow: "0 0 12px rgba(var(--tiny-accent-rgb),0.25)" }}
        >
          Get the app
        </a>
      </div>
    );
  }

  if (!show || !deferred) return null;

  const install = async () => {
    await deferred.prompt();
    await deferred.userChoice; // accepted or dismissed — banner goes either way
    setShow(false);
    setDeferred(null);
  };

  const dismiss = () => {
    safeSet(DISMISS_KEY, Date.now().toString());
    requestClose();
  };

  return (
    <div
      // Passive non-modal promo (see the iOS variant above) — region, not dialog.
      role="region"
      aria-label={`Install ${name} as an app`}
      className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-[90] flex items-center gap-3 px-5 py-3 rounded-2xl border max-w-sm w-[calc(100%-2rem)] ${exitClass}`}
      onAnimationEnd={onAnimationEnd}
      style={{
        background: "rgba(10,10,10,0.97)",
        borderColor: "rgba(var(--tiny-accent-rgb),0.3)",
        boxShadow: "0 0 40px rgba(var(--tiny-accent-rgb),0.15)",
      }}
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold" style={{ color: "var(--tiny-accent)" }}>
          Install {name}
        </div>
        {/* "Its own app icon" became untrue when d3c4109 demoted the
            per-tiny OG card from tile duty (shared logo tile now; the
            app NAME is still the tiny's) — promise what's delivered */}
        <div className="text-xs text-gray-400">Its own home-screen app · notifications · offline shell</div>
      </div>
      <button
        onClick={dismiss}
        className="ml-auto px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors hover:text-white hover:bg-white/5"
        style={{ color: "#888" }}
      >
        Not now
      </button>
      <button
        onClick={install}
        className="px-4 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all hover:scale-105"
        style={{ background: "var(--tiny-accent)", color: "#000", boxShadow: "0 0 12px rgba(var(--tiny-accent-rgb),0.25)" }}
      >
        Install
      </button>
    </div>
  );
}

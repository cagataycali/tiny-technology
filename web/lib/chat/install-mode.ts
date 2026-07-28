/**
 * Pure detection for the "install tiny on your phone" banner (IosInstallBanner).
 * Kept DOM-free so it's unit-testable without stubbing navigator/matchMedia.
 *
 *   - "ios-safari": iOS Safari — the ONLY iOS browser whose Share sheet offers
 *     "Add to Home Screen". Show the A2HS steps.
 *   - "desktop-qr": a desktop browser — offer a QR to open tiny on a phone.
 *   - null: already installed (standalone); an iOS browser that can't A2HS
 *     (iOS Chrome/Firefox/Edge); or Android — where a "scan this QR to open on
 *     your iPhone" prompt is nonsensical (you're already on the phone, and it's
 *     not an iPhone). Android Chrome/Edge get the native beforeinstallprompt
 *     path (InstallPrompt) instead, so suppressing here loses no real affordance.
 */
export type InstallMode = "ios-safari" | "desktop-qr" | null;

export interface InstallEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean; // display-mode: standalone (already installed)
}

export function detectInstallMode(env: InstallEnv): InstallMode {
  if (env.standalone) return null; // already an installed app

  // iPadOS 13+ reports as "MacIntel" with touch points — catch it as iOS.
  const isIOS =
    /iPad|iPhone|iPod/.test(env.userAgent) ||
    (env.platform === "MacIntel" && env.maxTouchPoints > 1);

  if (isIOS) {
    // Non-Safari iOS browsers are WebKit but expose no A2HS affordance.
    const isSafari =
      /Safari/.test(env.userAgent) &&
      !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/.test(env.userAgent);
    return isSafari ? "ios-safari" : null;
  }

  // Android: the QR path tells the user to "scan to open on your iPhone" — they
  // ARE on a phone, and it isn't an iPhone. Suppress it; Android Chrome/Edge get
  // the native install prompt (InstallPrompt) anyway.
  if (/Android/.test(env.userAgent)) return null;

  // Everything else (desktop): offer the QR to open tiny on a phone.
  return "desktop-qr";
}

/**
 * Whether IosInstallBanner should actually surface, given its detected mode and
 * what else is competing for the same bottom-center slot as InstallPrompt (a
 * higher z-index). Kept pure so the collision-avoidance rules are pinned by a
 * unit test.
 *
 * Two suppressions, one per InstallPrompt branch that shares our slot:
 *   - desktop-qr + `nativeInstallAvailable`: a desktop that CAN install
 *     natively → InstallPrompt's beforeinstallprompt banner owns the slot, so
 *     our QR would just stack a redundant second banner.
 *   - ios-safari + `iosBetaActive`: iPhone/iPad Safari where InstallPrompt's
 *     iOS-beta banner (z-90, its own `tiny-ios-beta-dismissed` key, fires at
 *     4s independent of beforeinstallprompt) is still eligible. Both banners
 *     land at identical bottom-center coordinates, so we stand down and let
 *     the higher-value "Join beta" CTA own the slot. Once the visitor dismisses
 *     the beta banner, a later load surfaces the A2HS steps instead.
 *
 * `nativeInstallAvailable` is always false on iOS Safari (it never fires
 * beforeinstallprompt), so the two flags never both suppress the same view.
 */
export function shouldShowBanner(
  mode: InstallMode,
  opts: { nativeInstallAvailable: boolean; iosBetaActive?: boolean },
): boolean {
  if (!mode) return false;
  if (mode === "desktop-qr" && opts.nativeInstallAvailable) return false;
  if (mode === "ios-safari" && opts.iosBetaActive) return false;
  return true;
}

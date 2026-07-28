/**
 * Focus-trap math — the pure, testable core of useFocusTrap.
 *
 * Our aria-modal overlays (MessagesHUD, JobsPanel, MemoryPanel, ModelSettings,
 * Onboarding, ActivityHUD, UniverseDrawer, ConfirmDialog) move focus IN on open
 * and return it to the opener on close, but nothing kept Tab from walking OUT
 * into the inert page behind them (WCAG 2.4.3). This computes where a Tab /
 * Shift+Tab should land so focus wraps at the panel's edges instead of leaving.
 *
 * The DOM lives in the hook; this file only decides an index, so the wrap rules
 * are unit-tested without a browser.
 */

/**
 * Elements that can receive keyboard focus, minus the ones a trap must skip.
 * `:not([tabindex="-1"])` drops the panel container itself (it's tabIndex=-1 so
 * open() can focus it programmatically without making it a Tab stop) and any
 * other roving-tabindex-parked control. Disabled/hidden are handled by the hook
 * (offsetParent check) since CSS visibility isn't queryable via selector alone.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Given the number of focusable elements in the trap, the index of the
 * currently-focused one (-1 if focus is on the container or has escaped), and
 * whether Shift is held, return the index to move focus to — or null to let the
 * browser handle the Tab naturally (interior moves need no interception).
 *
 * Wrap rules:
 *  - no focusables            → null (hook keeps focus on the container)
 *  - focus not in the list    → first (Tab) / last (Shift+Tab): pull it inside
 *  - Tab on the last element  → wrap to first
 *  - Shift+Tab on the first   → wrap to last
 *  - anywhere in the interior → null (natural browser Tab, no preventDefault)
 */
export function trapTarget(
  count: number,
  activeIndex: number,
  shift: boolean,
): number | null {
  if (count <= 0) return null;
  const first = 0;
  const last = count - 1;

  // Focus is on the container (tabIndex=-1, not in the list) or has drifted
  // outside — pull it to the near edge in the tab direction.
  if (activeIndex < 0) return shift ? last : first;

  if (shift) return activeIndex === first ? last : null;
  return activeIndex === last ? first : null;
}

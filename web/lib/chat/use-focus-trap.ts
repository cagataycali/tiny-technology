"use client";

/**
 * useFocusTrap — keep Tab / Shift+Tab inside an aria-modal overlay.
 *
 * Our overlays already move focus IN on open (panelRef.current.focus()) and
 * return it to the opener on close (useOverlayExit / a cleanup focus()). The
 * one missing piece was the WCAG 2.4.3 trap: without it, Tab walks straight out
 * of the dialog into the page behind it, which an aria-modal surface tells the
 * AT is inert. This wraps focus at the panel's first/last focusable edges.
 *
 * Deliberately conservative so it can't make things worse than the pre-trap
 * behavior:
 *  - Only Tab is touched — every other key (incl. the overlays' own Escape /
 *    arrow-key handlers) passes through untouched.
 *  - Zero focusables → no-op (focus stays on the container; same as today).
 *  - Escape still closes every overlay, so the trap can never strand a user.
 *  - The listener is scoped to the panel node, added only while `active`.
 *
 * Pass the same ref the overlay focuses on open. The wrap math lives in
 * ./focus-trap (pure + unit-tested); this only reads the DOM and moves focus.
 */
import { useEffect, type RefObject } from "react";
import { FOCUSABLE_SELECTOR, trapTarget } from "./focus-trap";

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active = true,
) {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      // Visible, focusable elements only. offsetParent is null for
      // display:none / detached nodes (the one visibility state a CSS selector
      // can't express); disabled/tabindex=-1 are already filtered by the
      // selector. Keeps a hidden tab-panel's controls out of the cycle.
      const focusables = Array.from(
        node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      const activeIndex = focusables.indexOf(document.activeElement as HTMLElement);
      const target = trapTarget(focusables.length, activeIndex, e.shiftKey);
      if (target === null) return; // interior move — let the browser handle it

      e.preventDefault();
      focusables[target]?.focus();
    };

    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [ref, active]);
}

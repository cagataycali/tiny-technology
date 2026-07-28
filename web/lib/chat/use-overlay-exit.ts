"use client";

/**
 * Exit choreography for transient overlays (the pass-97 pattern, shared
 * by MessagesHUD / ActivityHUD / AuthButton's menu).
 *
 * Overlay grammar: surfaces that riseIn on enter settle out via riseOut
 * before unmounting, and focus returns to the opener on close (pass 59).
 * `requestClose` starts the exit; the actual unmount (`close`) fires on
 * the panel's own animationend — reduced-motion clamps durations to
 * 0.01ms globally, so the event still fires instantly there — with a
 * timeout failsafe in case the node is display-toggled mid-animation.
 *
 * Menus: use requestClose for DISMISSALS (Escape / outside click / the
 * toggle). Item activation should close instantly with plain setOpen —
 * focus belongs to the chosen action then, not back on the opener.
 */
import { useCallback, useEffect, useRef, useState, type AnimationEvent, type RefObject } from "react";

export function useOverlayExit(
  close: () => void,
  openerRef?: RefObject<HTMLElement | null>,
  // Default pair suits corner/left-aligned overlays; centered elements
  // (translate-x -50%) pass the slideInUp/slideOutDown pair instead —
  // riseOut's translateY-only frames would yank them sideways.
  classes: { enter: string; exit: string } = {
    enter: "animate-riseIn",
    exit: "animate-riseOut",
  },
) {
  const [closing, setClosing] = useState(false);
  // close comes from render scope — keep the live one without re-arming
  // the failsafe effect on every render
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });

  const finish = () => {
    setClosing(false);
    closeRef.current();
    openerRef?.current?.focus();
  };

  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(finish, 350); // riseOut is 0.2s; margin for jank
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  // Stable identity — callers list it in effect deps (Escape/outside-click
  // listeners) without re-arming those listeners every render
  const requestClose = useCallback(() => setClosing(true), []);

  return {
    closing,
    requestClose,
    /** Swap for the static animate-riseIn class on the panel */
    exitClass: closing ? classes.exit : classes.enter,
    /** Attach to the SAME element that carries exitClass */
    onAnimationEnd: (e: AnimationEvent) => {
      // riseIn ends here too, and children's animations bubble up —
      // only the panel's own exit unmounts
      if (closing && e.target === e.currentTarget) finish();
    },
  };
}

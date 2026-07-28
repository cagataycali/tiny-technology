/**
 * A `whoami()`-derived value that FOLLOWS the session (v6 E3 + E4).
 *
 * The v6 lens keeps turning up the same shape: a component reads the shared
 * `/api/me` probe once and then shows that answer for the rest of the page's
 * life. c47 and c48 taught the session to ANNOUNCE its changes (sign-in,
 * sign-out, confirmed expiry — all one `tiny:auth` event); these two consumers
 * still weren't listening.
 *
 *   - Chat's free-name claim banner (E3) probes behind a `claimProbeRef` latch,
 *     so it reads /api/me exactly ONCE per mount. Its whole job is to offer
 *     sign-in — the user takes the offer, signs in with a passkey (client-side,
 *     no reload), and the banner keeps saying "sign in to claim it" over a
 *     session that could claim the name right now.
 *   - ModelSettings' `standing` (E4) reads the allowance once when the panel
 *     opens. Sign in while it's open and it keeps quoting the deployment-wide
 *     free-tier number — the exact wrong-allowance bug its own comment says it
 *     exists to fix (told 50 while their window was 250).
 *
 * Cost: nothing extra. The read goes through the shared cache, and on
 * `tiny:auth` whoami's own module-eval listener clears that cache — so N hooks
 * re-reading after one event still collapse into ONE request, which is c12's
 * whole invariant. This deliberately does NOT pass `{fresh:true}`: that would
 * make each additional consumer its own round-trip.
 *
 * `when` defers the first read (E3 only wants to know once a free name is
 * previewed) without deferring the SUBSCRIPTION — a hook that only subscribed
 * after its first read would miss the sign-in that happens while gated off.
 */
import { useEffect, useRef, useState } from "react";
import { whoami, type Me } from "./whoami";
import { AUTH_EVENT } from "./auth-events";

export function useAuthValue<T>(
  select: (me: Me) => T,
  opts?: { when?: boolean },
): T | null {
  const when = opts?.when ?? true;
  const [value, setValue] = useState<T | null>(null);
  // `select` is an inline lambda at every call site, so it's a new function
  // each render. Keep the latest one in a ref (same pattern as
  // use-overlay-exit's `closeRef`) so the subscription can stay mounted for the
  // component's life instead of tearing the listener down every render.
  // Assigned in an effect, not during render — refs are not render values.
  const selectRef = useRef(select);
  useEffect(() => { selectRef.current = select; });

  useEffect(() => {
    if (!when) return;
    let alive = true;
    const read = () => {
      whoami()
        .then((me) => { if (alive) setValue(selectRef.current(me)); })
        // The probe already degrades to {authenticated:false} on network
        // failure, so a rejection here is unexpected — "unknown" (null) is the
        // honest answer, and it's what both call sites already render for it.
        .catch(() => { if (alive) setValue(null); });
    };
    read();
    window.addEventListener(AUTH_EVENT, read);
    return () => { alive = false; window.removeEventListener(AUTH_EVENT, read); };
  }, [when]);

  return value;
}

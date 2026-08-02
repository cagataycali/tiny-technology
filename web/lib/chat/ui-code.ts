// The render_ui contract between an agent and this client: what counts as
// component code we will claim to have rendered.
//
// The voice bridge's render_ui case used to return { ok: true, note:
// "rendered" } unconditionally — before any compile had happened and without
// checking that componentCode was even a string. A missing argument still
// appended a bubble (which DynamicUI draws as a red "No component code
// provided" box) and a syntax error compiles into "❌ Component Error: …" —
// while the model, told "rendered", narrates a UI that isn't there. Same
// defect family as copy_to_clipboard's fabricated success (clipboard-write.ts):
// on this bridge the zod schema is only DESCRIBED to the model, so any
// contract that matters has to be re-asserted in the executor.
//
// What makes the claim verifiable up front: `new Function(...)` CONSTRUCTION
// parses the code and throws SyntaxError without executing a single line of
// it — execution only happens when the built function is CALLED (DynamicUI
// does that inside its useMemo, behind the realm shadows). So the executor
// can prove "this will at least compile" for free. Runtime throws remain the
// ErrorBoundary's job; this module scopes the claim to what is checkable.
//
// buildUiComponentFunction lives HERE, not in DynamicUI, so the verifier and
// the renderer are one implementation: a shadow param added for security
// (the c31 realm-shadowing posture) or a helper added to the preamble reaches
// both, and the two can never disagree about what "compiles" means.

/**
 * The page globals shadowed away from agent component code, in the exact
 * order they are declared on the built function. localStorage holds BYOK
 * keys, fetch/XHR exfiltrate, document/window walk to both — a chart needs
 * React + recharts and nothing else. Exported so tests can pin the posture.
 */
export const UI_SHADOW_PARAMS = [
  'localStorage',
  'sessionStorage',
  'document',
  'window',
  'globalThis',
  'fetch',
  'XMLHttpRequest',
  'navigator',
  'cookieStore',
] as const

/**
 * Build (but do NOT call) the function DynamicUI renders from. Throws
 * SyntaxError on unparseable code — that throw is the verification.
 * Callers invoke it as fn(React, recharts) — the shadows stay undefined.
 */
export const buildUiComponentFunction = (componentCode: string): Function =>
  new Function(
    'React',
    'recharts',
    ...UI_SHADOW_PARAMS,
    `
    "use strict";
    const { useState, useEffect, useMemo, useCallback, useRef, createElement: h } = React;
    const createElement = React.createElement;
    return ${componentCode};
    `,
  )

export type UiCodeDecision =
  | { ok: true; code: string }
  | { ok: false; error: string }

/** Model-facing: the result is what the agent narrates — name the state. */
export const UI_CODE_MISSING_ERROR =
  'componentCode is required and must be a string of React.createElement code — nothing was rendered'
export const UI_CODE_INVALID_ERROR_PREFIX =
  'the component code failed to compile, so nothing was rendered — fix and retry: '

/**
 * Decide whether componentCode is something this client can honestly claim
 * to render. `build` is injectable for tests; the default is the real
 * compiler DynamicUI uses. Content is passed through untouched — trimming is
 * only how blankness is DETECTED (the clipboard-write lesson: whitespace can
 * be meaningful inside, never at the decision).
 */
export const decideUiCode = (
  raw: unknown,
  build: (code: string) => unknown = buildUiComponentFunction,
): UiCodeDecision => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: UI_CODE_MISSING_ERROR }
  }
  try {
    build(raw)
  } catch (e: any) {
    // The SyntaxError's own message is the most useful thing the model can
    // hear ("Unexpected token '}'") — keep it, behind words that make the
    // outcome unambiguous.
    return { ok: false, error: UI_CODE_INVALID_ERROR_PREFIX + String(e?.message ?? e) }
  }
  return { ok: true, code: raw }
}

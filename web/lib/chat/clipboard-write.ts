/**
 * `copy_to_clipboard` — the agent writes to cross-application state.
 *
 * Backlog v8 A2, same lens as [[open-url]] (A1): a third-party-authored string
 * reaching a sink. The clipboard is the widest sink in the app — it's the only
 * one whose value the user then pastes into ANOTHER program, so a wrong value
 * here is spent somewhere this code will never see.
 *
 * The old branch was one line:
 *
 *     await navigator.clipboard.writeText(String(args?.text ?? ""));
 *     return { ok: true };
 *
 * Four defects, and the first is the one that costs the user something:
 *
 *  1. **A missing `text` ERASES the clipboard and reports success.**
 *     `String(undefined ?? "")` is `""`, and `writeText("")` is a write, not a
 *     no-op — whatever the user had copied (a wallet address they were
 *     mid-paste with, a password out of a manager) is gone, silently, and the
 *     agent says it copied something.
 *  2. **Non-strings are coerced, not refused.** `{}` lands as
 *     `"[object Object]"` and `["a","b"]` as `"a,b"` — verified, not assumed.
 *     The user pastes garbage into whatever they were doing.
 *  3. **No cap is actually enforced.** `copyToClipboardTool`'s zod schema says
 *     `.max(10_000)`, but that schema is only DESCRIBED to the model —
 *     `buildVoiceTools` forwards `toolSpec.inputSchema` as advisory JSON
 *     Schema and the executor reads the websocket frame's args directly. The
 *     limit was a claim, never a check.
 *  4. **The user was told nothing at all.** Its own switch neighbours toast
 *     ("🧠 Memory stored"), and all four user-gesture clipboard flows in web
 *     (`/calls`, `/devices`, `/wallet`, `auth/cli`) confirm visibly — `/calls`
 *     got a whole cycle (c19) for claiming "✓ copied" when the write failed.
 *     A silent replacement is precisely what makes a substituted address
 *     dangerous, so the confirmation has to NAME what landed, not just say
 *     "copied" — that preview is the user's only chance to notice.
 *
 * Pure — no DOM, no navigator — so every rule above is a node test.
 */

/** Matches `copyToClipboardTool`'s zod `.max(10_000)`. The schema describes
 *  this limit to the model; this module is what enforces it. */
export const CLIPBOARD_MAX = 10_000

export type ClipboardDecision =
  /** Safe to write. `text` is what to pass to the clipboard — never the raw arg. */
  | { ok: true; text: string; truncated: boolean }
  /** Nothing was written. `error` is FOR THE MODEL — it's the tool result. */
  | { ok: false; error: string }

/**
 * Decide whether the agent's text may be placed on the clipboard.
 *
 * ⚠️ Blank input is REFUSED rather than written, because an empty write is
 * destructive: it replaces the user's clipboard with nothing. There is no
 * "clear the clipboard" capability in the tool's contract, so a blank `text`
 * is always a mistake — and the refusal says so, since the model reads it.
 *
 * ⚠️ The accepted text is NOT trimmed. Leading/trailing whitespace is
 * meaningful in the things people copy (an indented code block, a trailing
 * newline before a paste into a terminal); trimming is only how blankness is
 * detected.
 */
export function decideClipboardWrite(raw: unknown): ClipboardDecision {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error:
        'refused: text must be a string — nothing was copied, the clipboard still holds what the user had',
    }
  }
  if (!raw.trim()) {
    return {
      ok: false,
      error:
        'refused: text was blank, and writing it would have ERASED whatever the user had on their clipboard — call this again with the actual text',
    }
  }
  if (raw.length > CLIPBOARD_MAX) {
    return { ok: true, text: raw.slice(0, CLIPBOARD_MAX), truncated: true }
  }
  return { ok: true, text: raw, truncated: false }
}

/**
 * A one-line, bounded rendering of what landed on the clipboard.
 *
 * Newlines collapse to spaces: a toast is one line, and a multi-line preview
 * would either clip mid-height or push the rest of the UI around. Truncation
 * is marked with an ellipsis so the user can tell "…" apart from the real end
 * of a short string.
 */
export function clipboardPreview(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * The user-facing confirmation. It QUOTES the preview: the risk this toast
 * exists for is a substitution (the tiny copies its own address over the one
 * the user meant), and "Copied!" cannot surface that — the value can.
 */
export function clipboardConfirmToast(text: string, truncated: boolean): string {
  const shown = `📋 Copied “${clipboardPreview(text)}”`
  return truncated ? `${shown} — trimmed to ${CLIPBOARD_MAX.toLocaleString('en-US')} characters` : shown
}

/**
 * What to tell the model on success. On a truncated write it MUST know the
 * clipboard holds less than it sent, or it goes on to describe the whole
 * thing as copied.
 */
export function clipboardNote(truncated: boolean): string {
  return truncated
    ? `copied, but truncated to the first ${CLIPBOARD_MAX} characters — tell the user the rest was not copied`
    : "copied to the user's clipboard"
}

/** Shown to the user when the browser refused the write. */
export const CLIPBOARD_DENIED_TOAST = "Couldn't copy — your browser blocked clipboard access"

/**
 * The model-facing version of the same failure. Written in words rather than
 * as an exception string: the old code let a raw `DOMException` message
 * ("Document is not focused", "Write permission denied") through to the voice
 * agent, which then reads machine noise aloud. Same audience rule as
 * `/api/voice/tool`'s timeout copy (c53).
 */
export const CLIPBOARD_DENIED_NOTE =
  "the browser blocked clipboard access, so nothing was copied — the user's clipboard is unchanged"

/**
 * `open_url` — the agent asks the browser to leave the page.
 *
 * Backlog v8 A1 (lens = "a third-party string reaching a navigation sink
 * OUTSIDE the sanitized markdown renderer"). Every other sink in this codebase
 * gates the string it was handed:
 *
 *   - markdown `<a>`  — react-markdown's own uriTransformer (MarkdownContent:57)
 *   - markdown `<img>`— an explicit scheme allowlist, added because
 *                       transformImageUri isn't set (MarkdownContent:88)
 *   - wallet explorer — `explorerHref` before `window.open` (wallet:73)
 *   - attachment lightbox — `/^(data:image\/|https:\/\/|blob:)/` before the
 *                       popup, with a comment naming the origin it protects
 *
 * The voice bridge's `open_url` was the one that didn't. It took `args.url`
 * straight from a model turn and handed it to `window.open`, and the threat
 * model is the one MarkdownContent already writes down: the persona may be
 * *someone else's* public tiny, so its output is third-party content, and the
 * page it can navigate is `tiny.technology` — where the session cookie and the
 * BYOK provider keys live.
 *
 * TWO separate defects, and the second is the one a user would actually hit:
 *
 *  1. No scheme gate. `javascript:`/`data:`/`file:`/`shortcuts:` all reached
 *     `window.open`. Browsers block most of those at the top level today, so
 *     this is defence-in-depth rather than a live exploit — but "the browser
 *     probably refuses it" is not a check, and it's the only sink here relying
 *     on that.
 *  2. **The tool lied about what happened.** A voice tool call arrives on a
 *     websocket frame, so it runs with NO user gesture — `window.open` is
 *     popup-blocked and returns null, and the old code returned `{ok:true}`
 *     anyway. The agent then says "I've opened it" about a tab that does not
 *     exist. `Control.tsx:1161` learned this exact lesson already ("no longer
 *     in the synchronous user-gesture context, so browsers popup-block it and
 *     'saved!' dead-ends with no tab") and its fix is the house pattern: a
 *     toast whose action opens from a real click. This module makes that
 *     outcome expressible so the agent's sentence can match reality.
 *
 * Pure — no DOM, no window — so both halves are testable and the caller stays
 * a few lines.
 */

export type OpenUrlDecision =
  /** Safe to hand to `window.open`. Use `href`, not the caller's original. */
  | { ok: true; href: string }
  /** Refused. `error` is written FOR THE MODEL — it's the tool result. */
  | { ok: false; error: string }

/**
 * Decide whether the agent's URL may be opened, and with what string.
 *
 * http/https absolute URLs, plus same-origin relative paths (`/wallet`,
 * `#top`) — the agent legitimately says "open your wallet".
 *
 * Everything else is refused with a sentence the MODEL reads, because this
 * string becomes the tool result: a refusal that explains itself lets the agent
 * say "I can't open app links in the browser" instead of inventing a reason or
 * retrying the same call.
 *
 * ⚠️ Protocol-relative (`//evil.com`) and backslash (`/\evil.com`) forms are
 * refused even though they LOOK relative — both resolve to a different origin
 * (`new URL('//evil.com', 'https://tiny.technology')` → `https://evil.com/`),
 * so accepting them as "internal" is how an off-site navigation gets waved
 * through by a rule about paths.
 */
export function decideOpenUrl(raw: unknown): OpenUrlDecision {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'url required' }
  const url = raw.trim()

  // Relative forms: a path or a fragment on THIS origin.
  if (url.startsWith('/') || url.startsWith('#')) {
    // `//host` and `/\host` are not paths — see the docblock.
    if (/^\/[/\\]/.test(url)) {
      return { ok: false, error: 'refused: that looks like a path but leaves this site' }
    }
    return { ok: true, href: url }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not absolute and not a path — a bare word, or a scheme the URL parser
    // rejects. Tell the model the shape it needs rather than "invalid".
    return { ok: false, error: 'refused: url must be an https:// link or a path like /wallet' }
  }

  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return { ok: true, href: url }

  // App/deep-link schemes (maps:, spotify:, shortcuts:) are real capabilities
  // on the native clients — the tool's own description offers them — and the
  // browser is simply not one of those clients. Naming the scheme keeps the
  // agent from re-trying it, and keeps `javascript:`/`data:`/`file:` in the
  // same refusal rather than a special case anyone can forget to extend.
  return {
    ok: false,
    error: `refused: the browser can't open ${parsed.protocol} links — only https:// or a path on this site`,
  }
}

/**
 * What to tell the model after `window.open` returned null.
 *
 * NOT an error: the request was legitimate and the user can still complete it
 * from the toast. But it must not read as done either, or the agent narrates a
 * tab that was never created. Kept here (not inlined at the call site) so a
 * test can pin that the two outcomes say different things.
 */
export const OPEN_URL_BLOCKED_NOTE =
  'the browser blocked the popup — the user was shown a link to open it themselves'

/** Toast copy for that case. Second person, house voice. */
export const OPEN_URL_BLOCKED_TOAST = 'Your browser blocked a popup'

/** The toast's action label — the click that IS the user gesture. */
export const OPEN_URL_BLOCKED_ACTION = 'Open link'

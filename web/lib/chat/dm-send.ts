/**
 * What to actually send when an agent calls `send_message`, and what to tell it
 * afterwards.
 *
 * Backlog v9 A1 (lens = "a rule the SERVER enforces that the caller only learns
 * about after it has already been applied"). `lib/chat/tools/messages.ts` sent
 * `String(input.message || '').slice(0, 2000)` and then reported
 * `Delivered to <name> — stored in their inbox.` Three defects follow from that
 * one line:
 *
 *   1. A 2500-char message is delivered at 2000 and the note says "Delivered"
 *      with no mention of loss. The agent believes the whole thing arrived and
 *      tells the user so — and a DM is IRREVERSIBLE, so unlike a truncated
 *      clipboard write there is nothing to redo. The recipient reads a message
 *      that stops mid-sentence and the sender never knows.
 *   2. `.slice()` counts UTF-16 code units, so cutting at 2000 can land BETWEEN
 *      a surrogate pair and deliver a lone `\ud83d` — mojibake in the
 *      recipient's inbox and in the Telegram push. Verified: `('x' + '👋'×1200)
 *      .slice(0, 2000)` ends in a lone high surrogate.
 *   3. `String(input.message || '')` makes a MISSING message `''`, and the
 *      route's own `!message.trim()` 400 lives in app/api/messages — this tool
 *      path calls the worker directly, so a blank body was sent as a real DM.
 *      (Same shape as c56's clipboard erase: a `|| ''` default is only safe if
 *      the empty value is inert at the sink.)
 *
 * The rule: never silently truncate an irreversible send. Refuse, and say by
 * how much it overran, so the agent can split the message or shorten it and try
 * again — a recoverable refusal beats an unrecoverable success. That is the
 * opposite call from c56's clipboard, where truncating was ACCEPTABLE precisely
 * because the user could see the toast and copy the rest; nobody is watching a
 * DM land.
 *
 * Pure — no fetch, no session — so every rule here is a node test.
 */

/** The worker's own DM body limit; the human composer pins the same number
 *  (`MessagesHUD.tsx` `maxLength={2000}`), and a test asserts they agree. */
export const DM_MAX_CHARS = 2000

export type DmSendDecision =
  | { ok: true; body: string }
  | { ok: false; error: string }

/**
 * Count what a human (and the worker's limit) would call "characters":
 * code POINTS, not UTF-16 code units, so an emoji counts once rather than
 * twice. `Array.from` is the TS-5.1-safe spread (no downlevelIteration here).
 */
export function dmLength(text: string): number {
  return Array.from(text).length
}

/**
 * The body to send, or a refusal the AGENT can act on.
 *
 * Deliberately does NOT trim the message: leading/trailing newlines are the
 * sender's formatting. Trimming is only how blankness is detected.
 */
export function decideDmSend(raw: unknown): DmSendDecision {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'refused: message must be a string — nothing was sent' }
  }
  if (!raw.trim()) {
    return {
      ok: false,
      error:
        'refused: message was blank, and a DM cannot be unsent — call this again with the actual text',
    }
  }
  const n = dmLength(raw)
  if (n > DM_MAX_CHARS) {
    // Naming the overrun (not just the cap) is what makes this actionable: the
    // agent can split at a known point instead of guessing and retrying blind.
    return {
      ok: false,
      error:
        `refused: message is ${n} characters, ${n - DM_MAX_CHARS} over the ${DM_MAX_CHARS} limit — ` +
        `nothing was sent. Send it as ${Math.ceil(n / DM_MAX_CHARS)} shorter messages, or shorten it.`,
    }
  }
  return { ok: true, body: raw }
}

/** The recipient hint the tool echoes back, preferring the worker's resolved name. */
export function dmRecipientLabel(resolved: unknown, fallback: string): string {
  return typeof resolved === 'string' && resolved.trim() ? resolved : fallback
}

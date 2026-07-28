/**
 * What `/auto` says when it's over (fresh-lens survey c70 — "what residue
 * does a FAILED operation leave, and does retrying still work?").
 *
 * `/auto <task>` was the one command that could fail in total silence:
 *
 *   1. onSubmit clears the composer before dispatch, so the task text is gone
 *      the moment it's consumed (and the debounced draft write then REMOVES
 *      the stored copy, because the composer is now empty).
 *   2. AmbientRunner.explore() returns '' on ANY failure — HTTP 402/429/500,
 *      no route to the network, a bad body. That silence is CORRECT for the
 *      idle path, which nobody asked for ("ambient must never disturb").
 *   3. But /auto inherited it. The success branch was `if (last) toast(...)`,
 *      so an empty result — the exact shape of a provider failure on iteration
 *      one — announced nothing at all.
 *
 * Net effect: the user typed a task, saw "working in the background", watched
 * the chip vanish, and was never told the run died. Their task text was
 * unrecoverable, so retrying meant retyping it from memory — and the run's
 * `finally` had already armed a 5-minute ambient cooldown for zero work.
 *
 * A silence policy that is right for unrequested work is wrong for work the
 * user explicitly asked for. This module is that distinction, pure.
 */

export type AutoAnnounce = {
  /** The toast to show. Never empty — an explicit request always gets an answer. */
  message: string
  tone: 'info' | 'error'
  /**
   * Text to put back in the composer, or null to leave it alone. It's the WHOLE
   * command ('/auto build the thing'), not the bare task, so a retry is one
   * keystroke instead of a retype.
   */
  restore: string | null
}

export type AutoOutcomeInput = {
  /** The full trimmed command text, e.g. '/auto research edge caching'. */
  command: string
  /**
   * The runner's result. `undefined` means it never started at all —
   * `ambientRef.current?.startAutonomous(...)` short-circuited, so no promise
   * was ever returned and no iteration ran.
   */
  result: { text: string; stopped: boolean } | undefined
  /** Live composer contents — anything the user has typed since. */
  currentInput: string
}

/**
 * Restoring is a write into a field the user shares with us, so it obeys the
 * same rule as draftRestore: never overwrite text they have already typed.
 * Typing is also what STOPS an autonomous run, which makes a non-empty
 * composer the common case for the stopped outcomes specifically.
 */
export function announceAutoResult(input: AutoOutcomeInput): AutoAnnounce {
  const canRestore = !input.currentInput.trim()
  const back = canRestore ? input.command : null
  // Only claim the composer got the text back when it actually did — a message
  // that promises a side effect which didn't happen is its own bug.
  const orNothing = canRestore
    ? ' — your task is back in the composer.'
    : ' Nothing was saved.'

  if (input.result === undefined) {
    return {
      message: `🤖 Autonomous mode isn't available right now — nothing ran.${orNothing}`,
      tone: 'error',
      restore: back,
    }
  }

  const produced = !!input.result.text.trim()

  if (input.result.stopped) {
    // The user stopped it themselves. Not an error, whatever came of it.
    return produced
      ? { message: '🤖 Autonomous run stopped — partial findings arrive with your next message.', tone: 'info', restore: null }
      : { message: `🤖 Autonomous run stopped before it produced anything.${canRestore ? ' Task restored.' : ''}`, tone: 'info', restore: back }
  }

  if (produced) {
    return {
      message: '🤖 Autonomous run finished — findings arrive with your next message',
      tone: 'info',
      restore: null,
    }
  }

  // Ran to the end of its own accord with nothing to show: the provider
  // refused, the network died, or every iteration came back empty. This is the
  // case that used to say nothing.
  return {
    message: `🤖 Autonomous run came back empty — the model or network didn't answer.${orNothing}`,
    tone: 'error',
    restore: back,
  }
}

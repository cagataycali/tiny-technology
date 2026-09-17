/**
 * 📐 Fitting the live area into the terminal it actually has.
 *
 * Two constants used to bound a live panel: 12 lines of text, 6 tool chips. A
 * constant cannot be right twice. On a 24-row terminal ONE panel of 12 lines
 * plus its chips already pushes the composer off the bottom — and the composer
 * is the element that must always be reachable. On a 60-row terminal three
 * panels sit clipped to a third of the room they have, for nothing.
 *
 * Ink's useWindowSize reports the real numbers and re-renders on resize, so the
 * bounds become arithmetic instead of guesses. Pure and separate for the same
 * reason conversations.ts is: the rules are worth testing without a TTY.
 */
import stringWidth from 'string-width'

/** Everything competing with the live panels for vertical room. */
export interface Chrome {
  /** Terminal height, from useWindowSize. */
  rows: number
  /** Live conversation panels sharing what's left. */
  panels: number
  /** An agent question is on screen — a bordered box of its own. */
  question?: boolean
  /** A realtime call strip is up. */
  call?: boolean
  /** The `N running · M queued` summary line. */
  status?: boolean
  /** The `↻ loop armed` line. */
  loop?: boolean
  /** Background loops in the picture-in-picture strip (0 = no strip). */
  loops?: number
  /** Active spawn_agents batches in the spawn strip (0 = no strip). */
  spawns?: number
  /** The slash-command menu is open above the composer. */
  menu?: boolean
  /** The 💬 marquee blackboard row has an entry to show. */
  marquee?: boolean
  /** The /marquee history viewer is open — a bordered SelectList. */
  marqueeView?: boolean
  /** The `🕸 N peers on mesh` footer row under the composer. */
  meshFooter?: boolean
}

/** The composer: a blank separator, two borders, one input row. */
const COMPOSER_ROWS = 4
/** A question box: borders, the question, a hint, and room for a few options. */
const QUESTION_ROWS = 7
/** The call strip: borders, the phase row, and up to three content rows. */
const CALL_ROWS = 6
/**
 * The slash menu's rows. Sized so a bare `/` shows the WHOLE vocabulary at once
 * — that is the feature: one keystroke, the entire surface, no scrolling to
 * discover that a command exists. Longer lists (a filtered history, a future
 * command) scroll inside this frame via windowFor, which keeps the height fixed
 * so the composer never hops while you type.
 */
export const MENU_ROWS = 10
/**
 * The /marquee viewer's frame: border (2), title, hint, and 8 content rows.
 * Fixed for the same reason the menu is — windowFor scrolls the CONTENTS, so
 * the composer never hops while the list is up.
 */
export const MARQUEE_VIEW_ROWS = 12
/** One row of slack, so a live area that fills its budget still doesn't scroll. */
const SLACK = 1
/** A framed panel spends this on its border and its `#id · query · clock` row. */
const FRAMED_OVERHEAD = 3
/** The bare panel has no border — a blank line, its `❯ query` echo row, and its `thinking…` row. */
const BARE_OVERHEAD = 3

export interface PanelBudget {
  /** Rows of streaming text one panel may show. */
  text: number
  /** Tool chips one panel may show; the rest are summarised as a count. */
  chips: number
}

/**
 * How much one live panel may spend, given what else is on screen.
 *
 * Two rows of text and two chips is the floor. Below that the honest answer is
 * that the terminal is too small, not that a panel should disappear — so a very
 * short terminal overflows and scrolls, exactly as it always did, rather than
 * silently showing nothing about a turn that is running.
 */
export function panelBudget(c: Chrome): PanelBudget {
  const panels = Math.max(1, c.panels)
  const spent = COMPOSER_ROWS + SLACK
    + (c.question ? QUESTION_ROWS : 0)
    + (c.call ? CALL_ROWS : 0)
    + (c.status ? 1 : 0)
    + (c.loop ? 1 : 0)
    // The loop strip is 3 rows per running loop plus its own footer, and it is
    // capped upstream at MAX_ACTIVE_LOOPS — a term, not a constant, because a
    // machine with two loops running has 7 fewer rows for the answers.
    + (c.loops ? c.loops * 3 + 1 : 0)
    // The spawn strip is one row per batch plus its top margin — a batch has
    // no goal text or journal step, so it earns a line, not loop's three.
    + (c.spawns ? c.spawns + 1 : 0)
    + (c.menu ? MENU_ROWS + 1 : 0)
    // The marquee is one row, and only when something is on the blackboard.
    + (c.marquee ? 1 : 0)
    + (c.marqueeView ? MARQUEE_VIEW_ROWS : 0)
    + (c.meshFooter ? 1 : 0)
  const perPanel = Math.floor(Math.max(0, c.rows - spent) / panels)
  const inner = perPanel - (panels > 1 ? FRAMED_OVERHEAD : BARE_OVERHEAD)
  // Chips are capped well below the text budget: a chip is one line of "what it
  // did", the text is the answer, and a forty-tool turn should not bury it.
  const chips = clamp(Math.floor(inner / 2), 2, 8)
  return { chips, text: Math.max(2, inner - chips) }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * The last `rows` DISPLAYED rows of `text` — not the last N newline-separated
 * lines.
 *
 * A 300-character line of a stack trace occupies four rows on an 80-column
 * terminal, and a tail that counted it as one would still overflow the budget it
 * was there to respect. The text has already been through marked-terminal by
 * this point, so widths come from string-width (which discards the ANSI) rather
 * than from `.length`.
 */
export function tailRows(text: string, rows: number, columns: number): string {
  if (rows <= 0 || !text) return ''
  const lines = text.split('\n')
  const width = Math.max(1, columns)
  let budget = rows
  let i = lines.length
  while (i > 0) {
    const cost = Math.max(1, Math.ceil(stringWidth(lines[i - 1]) / width))
    if (cost > budget && i < lines.length) break
    budget -= cost
    i--
    if (budget <= 0) break
  }
  return lines.slice(i).join('\n')
}

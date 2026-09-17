/**
 * ⚡ The slash-command table — ONE source for the menu and for /help.
 *
 * These descriptions used to live inside App.tsx's `/help` string literal while
 * the names lived in a separate `SLASH_COMMANDS` array feeding the ghost
 * suggestion. Two lists for one vocabulary is how a command ends up in the
 * autocomplete with no handler (which is exactly what happened to /help itself:
 * it completed, then cost a model turn and came back as whatever the model
 * guessed this UI could do). Now the array below is the vocabulary, `helpText()`
 * renders it, and `filterCommands()` filters it.
 *
 * Pure by design — no Ink, no React, so the filtering and the ordering are
 * testable without a TTY, the same reason conversations.ts and layout.ts are
 * separate from App.tsx.
 */

export interface SlashCommand {
  /** With the slash: '/loop'. */
  name: string
  /** Argument shape, shown dim after the name. */
  args?: string
  /** One line, imperative, no trailing period. */
  description: string
  /**
   * Answered by the TUI itself, without a model turn. Worth surfacing: it is the
   * difference between a status question that costs nothing and one that costs
   * seconds plus a context slot.
   */
  local?: boolean
  /** Kept working, deliberately absent from the menu (see /tasks). */
  hidden?: boolean
}

/**
 * Order is the menu's order when nothing is typed yet, so it reads as a tour of
 * the surface rather than as an alphabet: the two everyone needs first, then the
 * background rails, then the housekeeping.
 */
export const COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'this list — every command, no model turn', local: true },
  { name: '/voice', description: 'realtime call — talk over each other, tools run mid-sentence (/voice again hangs up)' },
  { name: '/say', args: '<text>', description: 'write on the shared marquee — in a live call it types into the call instead' },
  { name: '/loop', args: '[task]', description: 'autonomous foreground loop — 3s idle → next iteration ([LOOP_DONE] or /loop stops it)' },
  { name: '/loops', description: 'background loops (use_loop) — status + journals', local: true },
  { name: '/peers', description: 'who is on the mesh right now', local: true },
  { name: '/marquee', description: 'blackboard history — everything said on the ticker, newest first', local: true },
  { name: '/model', args: '[provider:model_id[:max_tokens]]', description: 'swap the model at runtime — bare shows the current one', local: true },
  { name: '/cancel', args: '[#n|all]', description: 'stop a live turn by its panel id (bare = newest)', local: true },
  { name: '/clear', description: 'forget the conversation and wipe the screen', local: true },
  // Still dispatched (an alias for /loops) but never advertised: it was the
  // documented name for background work before use_loop, and teaching a retired
  // name to new users is worse than quietly honouring it for old ones.
  { name: '/tasks', description: 'alias for /loops', local: true, hidden: true },
]

/** Names only — the ghost-suggestion path and the dispatcher's membership test. */
export const COMMAND_NAMES = COMMANDS.filter((c) => !c.hidden).map((c) => c.name)

/**
 * Subsequence fuzzy match, ported verbatim in spirit from the web palette
 * (lib/chat/slash-commands.ts + CommandPalette.tsx) so a habit built in one
 * surface transfers to the other: 'lp' finds /loop, 'vo' finds /voice.
 *
 * Lower is better. Any substring hit beats any scattered subsequence, and among
 * subsequences the one with fewer gaps wins.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 0
  const idx = t.indexOf(q)
  if (idx !== -1) return idx
  let ti = 0
  let gaps = 0
  let last = -1
  for (const ch of q) {
    ti = t.indexOf(ch, ti)
    if (ti === -1) return null
    if (last !== -1) gaps += ti - last - 1
    last = ti
    ti += 1
  }
  return 100 + gaps
}

/**
 * The menu's contents for what is currently typed, or null when the menu should
 * not be open at all.
 *
 * Open only while the input is a bare command being typed: a leading '/' and no
 * whitespace yet. `/loop refactor the parser` is an argument being written, and a
 * list of commands hovering over it is noise — the ghost suggestion already
 * covers completing the name itself.
 *
 * A '/' alone lists everything, which is the point of the whole feature: the one
 * keystroke that used to produce a single dim '/clear' now shows the surface.
 */
export function filterCommands(input: string): SlashCommand[] | null {
  if (!input.startsWith('/')) return null
  if (/\s/.test(input)) return null
  const visible = COMMANDS.filter((c) => !c.hidden)
  const q = input.slice(1)
  if (!q) return visible
  const scored: Array<{ c: SlashCommand; s: number }> = []
  for (const c of visible) {
    const s = fuzzyScore(q, c.name.slice(1))
    if (s !== null) scored.push({ c, s })
  }
  // Stable within a score: COMMANDS order is meaningful (see above), and a sort
  // that reshuffles equal matches makes the cursor jump between keystrokes.
  scored.sort((a, b) => a.s - b.s)
  return scored.map((x) => x.c)
}

/** The completion offered next to the composer: first match, or ''. */
export function ghostFor(input: string): string {
  const matches = filterCommands(input)
  if (!matches) return ''
  const hit = matches.find((c) => c.name.startsWith(input) && c.name !== input)
  return hit ? hit.name : ''
}

/** `/loop [task]` — the label a menu row shows. */
export function commandLabel(c: SlashCommand): string {
  return c.args ? `${c.name} ${c.args}` : c.name
}

/**
 * /help, rendered from the table plus the keys — which have no slash and so
 * cannot live in COMMANDS, but belong in the same answer.
 */
export function helpText(): string {
  const rows = COMMANDS.filter((c) => !c.hidden)
  const width = Math.max(...rows.map((c) => commandLabel(c).length))
  return [
    'tiny TUI —',
    ...rows.map((c) => `  ${commandLabel(c).padEnd(width)}  ${c.description}`),
    `  ${'!cmd'.padEnd(width)}  run a shell command locally; output joins the agent context`,
    `  ${'/'.padEnd(width)}  open this list as a menu — ↑↓ move · ⇥ complete · Enter run · Esc dismiss`,
    `  ${'↑/↓'.padEnd(width)}  input history · Tab accepts the ghost suggestion`,
    `  ${'Esc'.padEnd(width)}  close the menu · clear input · drop the queue · twice = stop running turns`,
    `  ${'^C'.padEnd(width)}  cancel newest running turn · double ^C or exit/quit/q quits`,
    'Every submit runs concurrently on its own forked conversation — never wait for an answer to ask the next thing.',
  ].join('\n')
}

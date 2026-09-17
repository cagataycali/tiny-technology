/**
 * ❯ The one list control.
 *
 * There were three dialects of the same thing: onboard-app's `Picker` (the voice
 * and active-model pickers), onboard-app's `ProviderMenu`, and the select branch
 * of App.tsx's `InteractView`. All drew `❯ ` plus an inverse cursor row, all
 * wrapped ↑/↓, all printed their own hint — slightly differently. A fourth
 * dialect for the slash menu is how a surface stops feeling like one product,
 * so this is the shared primitive and they render through it.
 *
 * It takes NO keyboard. That is the design decision that makes the slash menu
 * possible: the menu lives under a FOCUSED composer, so the user keeps typing to
 * filter, and a component calling its own useInput would fight ink-text-input for
 * stdin — the exact raw-mode collision InteractView was written to avoid. Cursor
 * state and keys stay with whoever owns the screen (App.tsx's top-level handler
 * for the menu, the picker itself for a modal one), and this file is props in,
 * elements out. Same split as CallStore / VoiceCallStrip.
 */
import React from 'react'
import { Box, Text } from 'ink'
import { commandLabel, type SlashCommand } from './commands.js'

export interface SelectItem {
  /** React key + identity. */
  key: string
  label: string
  /** Dim, on the right of the label — a description, a hint, a value. */
  detail?: string
  /** Multiselect tick. Undefined = not a multiselect row. */
  checked?: boolean
}

/**
 * Which slice of a longer list to draw, keeping the cursor inside it.
 *
 * Pure and exported because the fixed-height rule is the whole point of the
 * control: VoiceCallStrip is a fixed height because "a box that grows mid-word
 * drags the cursor with it", and a menu that grows and shrinks under a composer
 * as you type has the same defect in a worse place — the composer would hop
 * while you were still typing into it. So the frame stays constant and the
 * CONTENTS scroll.
 */
export function windowFor(cursor: number, count: number, maxRows: number): { start: number; end: number } {
  if (maxRows <= 0 || count <= 0) return { start: 0, end: 0 }
  if (count <= maxRows) return { start: 0, end: count }
  // Keep the cursor centred where possible, clamped at both ends so the list
  // never shows blank rows past the last item.
  const half = Math.floor(maxRows / 2)
  const start = Math.min(Math.max(0, cursor - half), count - maxRows)
  return { start, end: start + maxRows }
}

export function SelectList({
  items, cursor, hint, title, maxRows = 8, color = 'cyan', border = false,
}: {
  items: SelectItem[]
  cursor: number
  hint?: string
  title?: string
  maxRows?: number
  color?: string
  border?: boolean
}) {
  const { start, end } = windowFor(cursor, items.length, maxRows)
  const shown = items.slice(start, end)
  const hiddenAbove = start
  const hiddenBelow = items.length - end
  return (
    <Box flexDirection="column"
      {...(border ? { borderStyle: 'round' as const, borderColor: color, paddingX: 1 } : {})}
      aria-role="listbox">
      {title ? <Text bold>{title}</Text> : null}
      {/* A count instead of a silently truncated list — the same honesty rule
          the tool chips follow when a panel runs out of rows. */}
      {hiddenAbove > 0 ? <Text dimColor>  ↑ {hiddenAbove} more</Text> : null}
      {shown.map((it, i) => {
        const idx = start + i
        const sel = idx === cursor
        return (
          <Box key={it.key} aria-role="option" aria-state={{ selected: sel, checked: !!it.checked }}>
            <Box flexShrink={0}>
              <Text color={color} aria-hidden>{sel ? '❯ ' : '  '}</Text>
              {it.checked !== undefined && (
                <Text color={it.checked ? 'green' : undefined} aria-hidden>{it.checked ? '[x] ' : '[ ] '}</Text>
              )}
              <Text bold={sel} color={sel ? color : undefined}>{it.label}</Text>
            </Box>
            {it.detail ? (
              <Box flexGrow={1} paddingLeft={2}>
                <Text dimColor wrap="truncate-end">{it.detail}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
      {hiddenBelow > 0 ? <Text dimColor>  ↓ {hiddenBelow} more</Text> : null}
      {hint ? <Text dimColor>  {hint}</Text> : null}
    </Box>
  )
}

/**
 * The slash menu — what typing `/` shows above the composer.
 *
 * Deliberately the same control as the voice picker, because it is the same
 * gesture: a list, a cursor, ↑↓, Enter. The differences are that this one is
 * filtered by what you keep typing, and that Enter here RUNS a command rather
 * than answering a question.
 */
export function SlashMenu({ matches, cursor, maxRows }: {
  matches: SlashCommand[]
  cursor: number
  maxRows: number
}) {
  if (!matches.length) {
    return <Text dimColor>  no command matches — Esc to dismiss, or keep typing to ask instead</Text>
  }
  const items: SelectItem[] = matches.map((c) => ({
    key: c.name,
    label: commandLabel(c),
    // "no model turn" is the fact worth knowing before pressing Enter.
    detail: c.local ? `${c.description} · no model turn` : c.description,
  }))
  return (
    <SelectList
      items={items}
      cursor={cursor}
      maxRows={maxRows}
      color="cyan"
      hint="↑↓ move · ⇥ complete · Enter run · Esc dismiss"
    />
  )
}

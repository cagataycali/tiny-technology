/**
 * 🎨 Component generator — use_render spec → real Ink/React elements.
 *
 * The agent's structured component spec becomes a LIVE element tree: borders
 * via Ink's borderStyle, colors as props, layout via flexbox — not a
 * pre-painted fixed-width ANSI string frozen inside a <Text>. That's what
 * "proper generation" means here: the TUI composes React components at
 * runtime from whatever the model described, and Ink handles reflow,
 * truncation and terminal resize like any other part of the tree.
 *
 * The ANSI renderer in agent/render.ts survives as the REPL/headless
 * fallback; this file is the TUI's face of the same vocabulary, so the two
 * must accept the identical spec (RenderComponent) — one schema, two
 * generators.
 */
import React from 'react'
import { Box, Text, useWindowSize } from 'ink'
import stringWidth from 'string-width'
import type { RenderComponent } from '../agent/render.js'
import { renderMarkdown } from './markdown.js'

/** Ink accepts color names directly; default accent for structure lines. */
const accent = (c?: string) => c || 'cyan'

/**
 * Columns a cell OCCUPIES, which is not its `.length`: an emoji is two columns
 * and one or two code units, and a combining mark is zero columns and one. A
 * table whose column widths came from `.length` draws its verticals a column off
 * on every row containing either — the same bug the tool-icon width rules exist
 * to prevent, one component over.
 */
const width = (s: string) => stringWidth(s)

/** Pad to a COLUMN width. `padEnd` counts code units and gets emoji wrong. */
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - width(s)))

// ─── Table ──────────────────────────────────────────────────────────────────

function TableView({ comp }: { comp: RenderComponent }) {
  const headers = comp.headers || []
  const rows = (comp.rows || []).map((r) => r.map((x) => String(x ?? '')))
  const cols = Math.max(headers.length, ...rows.map((r) => r.length), 1)
  const widths: number[] = []
  for (let i = 0; i < cols; i++) {
    widths[i] = Math.max(width(headers[i] || ''), ...rows.map((r) => width(r[i] || '')), 1)
  }
  const color = accent(comp.style)
  const Cell = ({ v, i, header }: { v?: string; i: number; header?: boolean }) => (
    <>
      <Text color={color}>│</Text>
      <Text bold={header}> {pad(v || '', widths[i])} </Text>
    </>
  )
  const Sep = ({ l, m, r }: { l: string; m: string; r: string }) => (
    <Text color={color} wrap="truncate-end">{l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r}</Text>
  )
  // A table wider than the terminal CLIPS instead of wrapping. Wrapping turns
  // every row into two, which desynchronises the rows from the rules between
  // them and leaves a shredded grid; a clipped table is still a table, just one
  // whose last columns are off-screen.
  //
  // One <Text> per ROW rather than a Box of cells, because a Box shrinks its
  // children to fit — every cell squeezed to four columns and wrapped onto a
  // second line, which is the confetti this is here to prevent. Nested <Text>
  // keeps the per-cell colour while truncation applies to the row as a whole.
  const Row = ({ children }: { children: React.ReactNode }) => (
    <Text wrap="truncate-end">{children}<Text color={color}>│</Text></Text>
  )
  return (
    <Box flexDirection="column">
      {comp.title ? <Text bold>{comp.title}</Text> : null}
      <Sep l="╭" m="┬" r="╮" />
      {headers.length > 0 && (
        <>
          <Row>{headers.map((h, i) => <Cell key={i} v={h} i={i} header />)}</Row>
          <Sep l="├" m="┼" r="┤" />
        </>
      )}
      {rows.map((r, ri) => (
        <Row key={ri}>{Array.from({ length: cols }, (_, i) => <Cell key={i} v={r[i]} i={i} />)}</Row>
      ))}
      <Sep l="╰" m="┴" r="╯" />
    </Box>
  )
}

// ─── Tree ───────────────────────────────────────────────────────────────────

function TreeView({ comp }: { comp: RenderComponent }) {
  const color = accent(comp.style)
  const lines: React.ReactNode[] = []
  let key = 0
  const walk = (items: any[], prefix: string) => {
    items.forEach((item, i) => {
      const last = i === items.length - 1
      const branch = last ? '└── ' : '├── '
      const nextPrefix = prefix + (last ? '    ' : '│   ')
      const isNode = typeof item === 'object' && item !== null && 'label' in item
      lines.push(
        <Box key={key++}>
          <Text>{prefix}</Text>
          <Text color={color}>{branch}</Text>
          <Text>{isNode ? item.label : String(item)}</Text>
        </Box>,
      )
      if (isNode && Array.isArray(item.items)) walk(item.items, nextPrefix)
    })
  }
  walk(comp.items || [], '')
  return (
    <Box flexDirection="column">
      <Text color={color} bold>{comp.label || comp.title || '•'}</Text>
      {lines}
    </Box>
  )
}

// ─── KeyValue ───────────────────────────────────────────────────────────────

function KeyValueView({ comp }: { comp: RenderComponent }) {
  const data = comp.data || {}
  const keys = Object.keys(data)
  const kw = Math.max(...keys.map(width), 1)
  return (
    <Box flexDirection="column">
      {comp.title ? <Text bold>{comp.title}</Text> : null}
      {keys.map((k) => (
        <Box key={k} columnGap={2}>
          <Box flexShrink={0} paddingLeft={2}>
            <Text color={accent(comp.style)}>{pad(k, kw)}</Text>
          </Box>
          {/* The value takes the rest of the row and truncates, so one long
              value can't wrap the pair onto two rows and break the key column. */}
          <Box flexGrow={1}><Text wrap="truncate-end">{String(data[k])}</Text></Box>
        </Box>
      ))}
    </Box>
  )
}

// ─── Progress ───────────────────────────────────────────────────────────────

function ProgressView({ comp }: { comp: RenderComponent }) {
  const { columns } = useWindowSize()
  const total = comp.total || 100
  const done = Math.min(comp.completed || 0, total)
  const label = comp.description || comp.title || ''
  const pct = Math.round((done / total) * 100)
  const counts = `${pct}% (${done}/${total})`
  // A fixed 30-column bar plus its label and its counts is 60-odd columns, so on
  // anything narrow the row wrapped and the bar arrived in two pieces. The bar is
  // the part that can go without losing information — the numbers can't — so it
  // takes whatever the label and the numbers leave, measured rather than reserved.
  // Below four columns a bar says nothing a percentage doesn't, so it goes.
  const room = columns - width(label) - width(counts) - 4   // 2 padding + 2 gaps
  const bar = room >= 4 ? Math.min(30, room) : 0
  const filled = Math.round((done / total) * bar)
  return (
    <Box columnGap={1} aria-role="progressbar" aria-state={{ busy: done < total }}>
      {/* The label is the only part allowed to lose characters, and last. */}
      <Box paddingLeft={2}><Text wrap="truncate-end">{label}</Text></Box>
      {/* The blocks are a picture of the number that follows them; a screen
          reader wants "70% (7/10)", not thirty shaded squares. */}
      {bar > 0 && (
        <Box flexShrink={0} aria-hidden>
          <Text color={comp.style || 'green'}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(bar - filled)}</Text>
        </Box>
      )}
      <Box flexShrink={0}>
        <Text>{pct}% </Text>
        <Text dimColor>({done}/{total})</Text>
      </Box>
    </Box>
  )
}

// ─── Rule ───────────────────────────────────────────────────────────────────

/**
 * A horizontal rule that is actually horizontal: it spans the terminal.
 *
 * The fixed 8 + 40 dashes this replaces were a rule for one width — short of the
 * right edge on anything wide, and wrapped onto a second line on anything under
 * fifty columns, which is the one thing a divider must never do.
 */
function RuleView({ comp }: { comp: RenderComponent }) {
  const { columns } = useWindowSize()
  const title = comp.title ? ` ${comp.title} ` : ''
  const room = Math.max(4, columns - width(title))
  const left = Math.min(8, Math.floor(room / 2))
  return (
    <Box>
      <Text color={accent(comp.style)}>{'─'.repeat(left)}</Text>
      {title ? <Text bold>{title}</Text> : null}
      <Text color={accent(comp.style)}>{'─'.repeat(room - left)}</Text>
    </Box>
  )
}

// ─── Dispatcher — one spec entry → one Ink element ──────────────────────────

function ComponentView({ comp }: { comp: RenderComponent }) {
  try {
    switch (comp.type) {
      case 'panel':
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={accent(comp.style)} paddingX={1}>
            {comp.title ? <Text bold color={accent(comp.style)}>{comp.title}</Text> : null}
            <Text>{renderMarkdown(comp.content || '')}</Text>
          </Box>
        )
      case 'table': return <TableView comp={comp} />
      case 'tree': return <TreeView comp={comp} />
      case 'keyvalue': return <KeyValueView comp={comp} />
      case 'progress': return <ProgressView comp={comp} />
      case 'markdown': return <Text>{renderMarkdown(comp.content || '')}</Text>
      case 'syntax':
        return <Text>{renderMarkdown('```' + (comp.language || '') + '\n' + (comp.code || comp.content || '') + '\n```')}</Text>
      case 'rule': return <RuleView comp={comp} />
      case 'text':
        return <Text color={comp.style}>{comp.content || ''}</Text>
      default:
        return <Text dimColor>(unknown component: {String((comp as any).type)})</Text>
    }
  } catch (e: any) {
    // One bad component loses itself, not its siblings — same contract as
    // the ANSI renderer's per-component try/catch.
    return <Text dimColor>(render error in {comp.type}: {String(e?.message || e)})</Text>
  }
}

/** The block use_render mounts into the transcript. */
export function RenderBlock({ components, title }: { components: RenderComponent[]; title?: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {title ? <Text bold color="cyan">{title}</Text> : null}
      {components.map((comp, i) => <ComponentView key={i} comp={comp} />)}
    </Box>
  )
}

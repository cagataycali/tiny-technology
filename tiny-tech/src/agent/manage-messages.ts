/**
 * 🧠 manage_messages — turn-aware surgery on the LIVE conversation.
 *
 * Port of devduck's manage_messages.py. The hard-won invariants travel intact:
 * - a TURN = one real user query + every tool cycle it triggered
 * - the ACTIVE turn (the one executing this very tool call) is never dropped,
 *   compacted or cleared — surgery only touches messages BEFORE it
 * - any surgery that orphans a toolUse gets a synthetic toolResult injected
 *   (Bedrock validates pairing across the WHOLE history, so one orphan poisons
 *   every later call), and structure is validated before history is replaced
 * - messages carrying reasoning/thinking blocks are NEVER modified — Bedrock
 *   refuses edited thinking blocks — they are kept whole or dropped whole
 *
 * The tool reaches the live history through ToolContext.agent.messages — the
 * SAME array the SDK Agent holds — and mutates it in place with splice, the
 * house idiom (agent.ts trims it in place for exactly this reason).
 */
import { Message, tool } from '@strands-agents/sdk'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

/** A message-shaped thing: SDK Message or a structural stand-in from tests. */
export interface Msg {
  role: 'user' | 'assistant'
  content: any[]
  trackingId?: string
}

/** [start, end) index pair for one turn. */
export type Turn = { start: number; end: number }

const isType = (b: any, t: string) => b?.type === t
const hasBlockOf = (m: Msg, t: string) => Array.isArray(m?.content) && m.content.some((b) => isType(b, t))

/** Does this message carry a reasoning/thinking block? Such messages are untouchable. */
export const hasReasoning = (m: Msg) => hasBlockOf(m, 'reasoningBlock')
const hasToolResult = (m: Msg) => hasBlockOf(m, 'toolResultBlock')

/** Is this a REAL user query (not a tool-result carrier)? */
const isUserQuery = (m: Msg) => m.role === 'user' && !hasToolResult(m)

/**
 * Parse messages into turns. A turn starts at a real user query and consumes
 * every assistant reply + toolResult carrier until the next real query.
 * Orphaned leading assistant/toolResult messages belong to no turn (they are
 * preamble a previous surgery left; list shows them as turn -1).
 */
export function parseTurns(messages: Msg[]): Turn[] {
  const turns: Turn[] = []
  let i = 0
  while (i < messages.length) {
    if (isUserQuery(messages[i])) {
      const start = i
      i += 1
      while (i < messages.length && !isUserQuery(messages[i])) i += 1
      turns.push({ start, end: i })
    } else {
      i += 1 // preamble: orphaned assistant msg or toolResult with no query
    }
  }
  return turns
}

/** toolUse ids that have no matching toolResult anywhere in the array. */
export function pendingToolUseIds(messages: Msg[]): string[] {
  const uses = new Set<string>()
  const results = new Set<string>()
  for (const m of messages) {
    for (const b of m?.content ?? []) {
      if (isType(b, 'toolUseBlock')) uses.add(b.toolUseId)
      else if (isType(b, 'toolResultBlock')) results.add(b.toolUseId)
    }
  }
  return [...uses].filter((id) => !results.has(id))
}

/**
 * The active turn: last real user query through end of array. While a tool
 * executes (this one included), its toolUse sits unresolved in this tail —
 * dropping it would tear the very cycle we are inside of.
 */
export function activeTurnStart(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserQuery(messages[i])) return i
  }
  return -1
}

/** Tool ids inside the active turn (plus `selfId` — this call's own toolUseId). */
export function activeToolIds(messages: Msg[], selfId?: string): Set<string> {
  const ids = new Set<string>()
  const start = activeTurnStart(messages)
  if (start >= 0) {
    for (const m of messages.slice(start)) {
      for (const b of m?.content ?? []) {
        if (isType(b, 'toolUseBlock') || isType(b, 'toolResultBlock')) ids.add(b.toolUseId)
      }
    }
  }
  if (selfId) ids.add(selfId)
  return ids
}

/** Build a real SDK user message carrying synthetic toolResults for `ids`. */
function syntheticResultMessage(ids: string[]): Msg {
  return Message.fromMessageData({
    role: 'user',
    content: ids.map((toolUseId) => ({
      toolResult: {
        toolUseId,
        status: 'success',
        content: [{ text: '[conversation modified - synthetic result]' }],
      },
    })),
  }) as unknown as Msg
}

/**
 * Repair every incomplete tool cycle: a toolUse with no toolResult gets a
 * synthetic result injected right after its assistant message. Critical after
 * ANY surgery and for imports exported mid-execution.
 */
export function fixIncompleteToolCycles(messages: Msg[]): Msg[] {
  const pending = new Set(pendingToolUseIds(messages))
  if (!pending.size) return messages
  const out: Msg[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    out.push(m)
    if (m.role !== 'assistant') continue
    const mine = (m.content ?? []).filter((b) => isType(b, 'toolUseBlock') && pending.has(b.toolUseId)).map((b) => b.toolUseId)
    if (!mine.length) continue
    // ids already answered by the immediate next message need no synthetic
    const next = messages[i + 1]
    const nextIsCarrier = next?.role === 'user' && hasToolResult(next)
    const covered = new Set<string>(
      nextIsCarrier ? (next.content ?? []).filter((b) => isType(b, 'toolResultBlock')).map((b) => b.toolUseId) : [],
    )
    const missing = mine.filter((id) => !covered.has(id))
    if (!missing.length) continue
    if (nextIsCarrier) {
      // Partially answered: merge synthetics INTO the real carrier — a separate
      // user message inserted before it would create user→user.
      const synth = syntheticResultMessage(missing)
      out.push(rebuilt(next, [...(next.content ?? []), ...(synth.content ?? [])]))
      i += 1 // carrier consumed
    } else {
      out.push(syntheticResultMessage(missing))
    }
  }
  return out
}

/**
 * Validate before replacing live history. Broken tool pairing is a HARD error
 * (providers refuse it). Same-role adjacency is only a WARNING: the SDK/provider
 * rail tolerates it (mutations legally produce it, live sessions run with it),
 * so refusing it would make import reject this tool's own exports.
 */
export function validateStructure(messages: Msg[]): { ok: boolean; error: string; warnings: string[] } {
  const pending = pendingToolUseIds(messages)
  if (pending.length) return { ok: false, error: `${pending.length} toolUse without toolResult: ${pending.slice(0, 3).join(', ')}`, warnings: [] }
  const warnings: string[] = []
  let adjacent = 0
  for (let i = 1; i < messages.length; i++) {
    if (messages[i - 1].role === messages[i].role) adjacent++
  }
  if (adjacent) warnings.push(`${adjacent} same-role adjacency(ies) — tolerated by the rail, providers merge or accept these`)
  return { ok: true, error: '', warnings }
}

/** Rebuild a message with filtered content, PRESERVING its trackingId. */
function rebuilt(m: Msg, content: any[]): Msg {
  try {
    return new (Message as any)({ role: m.role, content, trackingId: m.trackingId })
  } catch {
    return { ...m, content } // structural stand-ins in tests
  }
}

/**
 * Remove specific toolUse/toolResult blocks by id. When an edit touches a
 * reasoning-bearing message, the reasoning blocks are removed too (prior-turn
 * reasoning may be omitted, but never left beside altered siblings); messages
 * emptied by the removal are dropped entirely. Callers only pass NON-ACTIVE
 * turns — active-turn reasoning is protected by splitActive upstream.
 */
export function removeToolBlocks(messages: Msg[], ids: Set<string>): Msg[] {
  const out: Msg[] = []
  for (const m of messages) {
    const hasTarget = (m.content ?? []).some(
      (b) => (isType(b, 'toolUseBlock') || isType(b, 'toolResultBlock')) && ids.has(b.toolUseId),
    )
    if (!hasTarget) { out.push(m); continue }
    // Editing this message: drop the targeted tool blocks AND its reasoning
    // blocks — a prior-turn reasoning block may be omitted entirely, but must
    // never sit next to altered siblings (providers validate it against them).
    const kept = (m.content ?? []).filter((b) => {
      if (isType(b, 'toolUseBlock') || isType(b, 'toolResultBlock')) return !ids.has(b.toolUseId)
      return !isType(b, 'reasoningBlock')
    })
    if (kept.length === (m.content ?? []).length) out.push(m)
    else if (kept.length) out.push(rebuilt(m, kept))
    // emptied (tool-blocks-only message): dropped
  }
  return out
}

/**
 * Strip ALL tool blocks from the given turns, keeping text/image blocks —
 * the compact operation. Reasoning goes with the tool blocks it accompanied;
 * reasoning-only messages stay whole; emptied messages are dropped.
 */
export function stripToolBlocksFromTurns(messages: Msg[], turnIndices: Set<number>, turns: Turn[]): Msg[] {
  const strip = new Set<number>()
  for (const t of turnIndices) {
    if (t >= 0 && t < turns.length) for (let i = turns[t].start; i < turns[t].end; i++) strip.add(i)
  }
  const out: Msg[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!strip.has(i)) { out.push(m); continue }
    const hasTool = (m.content ?? []).some((b) => isType(b, 'toolUseBlock') || isType(b, 'toolResultBlock'))
    // Reasoning-only messages (no tool blocks) stay whole; once tool blocks
    // are stripped, sibling reasoning goes with them (see removeToolBlocks).
    const kept = (m.content ?? []).filter(
      (b) => !isType(b, 'toolUseBlock') && !isType(b, 'toolResultBlock') && !(hasTool && isType(b, 'reasoningBlock')),
    )
    if (kept.length === (m.content ?? []).length) out.push(m)
    else if (kept.length) out.push(rebuilt(m, kept))
  }
  return out
}

/** One-line preview of a message's content blocks. */
export function summarize(content: any[], maxLen = 80): string {
  const parts: string[] = []
  for (const b of (content ?? []).slice(0, 3)) {
    if (isType(b, 'textBlock')) {
      const t = String(b.text ?? '')
      parts.push(`"${t.slice(0, maxLen)}${t.length > maxLen ? '…' : ''}"`)
    } else if (isType(b, 'toolUseBlock')) parts.push(`toolUse:${b.name}`)
    else if (isType(b, 'toolResultBlock')) parts.push(`toolResult:${String(b.toolUseId).slice(0, 8)}…`)
    else if (isType(b, 'reasoningBlock')) parts.push('[reasoning]')
    else if (isType(b, 'imageBlock')) parts.push('[image]')
    else parts.push(`[${b?.type ?? 'block'}]`)
  }
  if ((content ?? []).length > 3) parts.push(`+${content.length - 3} more`)
  return parts.length ? parts.join(' | ') : '(empty)'
}

/** Every tool call with pairing status — the list_tools view's data. */
export function allToolCalls(messages: Msg[]) {
  const results = new Map<string, { status: string; preview: string }>()
  for (const m of messages) {
    for (const b of m?.content ?? []) {
      if (!isType(b, 'toolResultBlock')) continue
      const text = (b.content ?? []).find((c: any) => c?.type === 'textBlock' || typeof c?.text === 'string')
      results.set(b.toolUseId, { status: b.status ?? 'unknown', preview: String(text?.text ?? '').slice(0, 80) })
    }
  }
  const calls: { toolUseId: string; name: string; msgIdx: number; hasResult: boolean; resultStatus?: string; argsPreview: string; resultPreview?: string }[] = []
  messages.forEach((m, msgIdx) => {
    for (const b of m?.content ?? []) {
      if (!isType(b, 'toolUseBlock')) continue
      const r = results.get(b.toolUseId)
      let argsPreview = ''
      try { argsPreview = JSON.stringify(b.input ?? {}).slice(0, 80) } catch { argsPreview = String(b.input).slice(0, 80) }
      calls.push({ toolUseId: b.toolUseId, name: b.name, msgIdx, hasResult: !!r, resultStatus: r?.status, argsPreview, resultPreview: r?.preview })
    }
  })
  return calls
}

/** Parse "0,2,5" / start / end into a set of turn indices. */
export function resolveTurnIndices(turnCount: number, turns?: string, start?: number, end?: number): Set<number> | { error: string } {
  const idx = new Set<number>()
  if (turns) {
    for (const part of turns.split(',')) {
      const n = Number(part.trim())
      if (!Number.isInteger(n)) return { error: `invalid turn index: ${part.trim()}` }
      idx.add(n)
    }
  }
  if (start != null && end != null) for (let i = start; i < end; i++) idx.add(i)
  else if (start != null) for (let i = start; i < turnCount; i++) idx.add(i)
  else if (end != null) for (let i = 0; i < end; i++) idx.add(i)
  return idx
}

// ── the tool ────────────────────────────────────────────────────────────────

const ok = (text: string) => text
const err = (text: string) => `manage_messages error: ${text}`

/** In-place replacement — the SDK Agent holds this array by reference. */
function replaceHistory(live: Msg[], next: Msg[]): void {
  live.splice(0, live.length, ...next)
}

/**
 * Split live history at the active turn. Everything before it is fair game;
 * the active turn (this very tool call's cycle) always survives untouched.
 */
function splitActive(messages: Msg[]): { droppable: Msg[]; active: Msg[] } {
  const s = activeTurnStart(messages)
  if (s < 0) return { droppable: [], active: [...messages] }
  return { droppable: messages.slice(0, s), active: messages.slice(s) }
}

export function makeManageMessagesTool() {
  return tool({
    name: 'manage_messages',
    description: [
      'Inspect and edit YOUR OWN conversation history (the live message array) — the long-horizon survival tool.',
      'When a task is long, COMPACT BEFORE THE CONTEXT OVERFLOWS: `compact` strips tool blocks from old turns keeping their text (default: all but the last 3 turns). `drop` removes whole turns; `drop_tools` removes single tool calls by id or every call to a name; `clear` wipes all but the current turn.',
      'Safety: the ACTIVE turn (this very call) is never dropped; surgery that would orphan a toolUse gets a synthetic result injected; messages carrying reasoning blocks are never edited; structure is validated before history is replaced.',
      'Read: `list` (by turn, role filter), `list_tools` (ids + 🔒 active locks), `stats`. Persist: `export`/`import` (JSON file; import repairs cycles and preserves the active turn).',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['list', 'list_tools', 'stats', 'export', 'import', 'drop', 'drop_tools', 'compact', 'clear']),
      path: z.string().optional().describe('file path for export/import'),
      turns: z.string().optional().describe('comma-separated turn indices, e.g. "0,2,5"'),
      start: z.number().int().optional().describe('start turn index (inclusive)'),
      end: z.number().int().optional().describe('end turn index (exclusive)'),
      role: z.enum(['user', 'assistant']).optional().describe('filter for list'),
      tool_ids: z.string().optional().describe('comma-separated toolUse ids for drop_tools'),
      tool_name: z.string().optional().describe('drop every call to this tool (drop_tools)'),
      summary_len: z.number().int().optional().describe('preview length for list (default 80)'),
    }),
    callback: (input, context) => {
      const agent: any = context?.agent
      if (!agent || !Array.isArray(agent.messages)) return err('no live agent history reachable from this context')
      const messages: Msg[] = agent.messages
      const selfId: string | undefined = (context as any)?.toolUse?.toolUseId
      const maxLen = input.summary_len ?? 80

      switch (input.action) {
        case 'list': {
          if (!messages.length) return ok('No messages')
          if (input.role) {
            const rows = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === input.role)
            return ok([`${rows.length} ${input.role} messages:`, ...rows.map(({ m, i }) => `  [${i}] ${summarize(m.content, maxLen)}`)].join('\n'))
          }
          const turns = parseTurns(messages)
          const activeS = activeTurnStart(messages)
          const lines = [`${turns.length} turns (${messages.length} messages):`]
          const covered = new Set<number>()
          turns.forEach((t, ti) => {
            const activeMark = t.start === activeS ? ' ⚡ACTIVE' : ''
            lines.push(`--- turn ${ti} (msgs ${t.start}-${t.end - 1})${activeMark} ---`)
            for (let i = t.start; i < t.end; i++) {
              covered.add(i)
              lines.push(`  [${i}] ${messages[i].role}: ${summarize(messages[i].content, maxLen)}`)
            }
          })
          const orphans = messages.map((_, i) => i).filter((i) => !covered.has(i))
          if (orphans.length) {
            lines.push(`--- preamble (no turn) ---`)
            for (const i of orphans) lines.push(`  [${i}] ${messages[i].role}: ${summarize(messages[i].content, maxLen)}`)
          }
          return ok(lines.join('\n'))
        }

        case 'list_tools': {
          const calls = allToolCalls(messages)
          if (!calls.length) return ok('No tool calls found')
          const active = activeToolIds(messages, selfId)
          const lines = [`${calls.length} tool calls:`]
          calls.forEach((c, i) => {
            const icon = c.hasResult ? '✅' : '⏳'
            const lock = active.has(c.toolUseId) ? ' 🔒(active)' : ''
            lines.push(`${i}. ${icon} ${c.name}${lock}  id=${c.toolUseId}`)
            lines.push(`   args: ${c.argsPreview}`)
            if (c.hasResult) lines.push(`   result (${c.resultStatus}): ${c.resultPreview}`)
          })
          lines.push('Use drop_tools with tool_ids or tool_name to remove non-active calls.')
          return ok(lines.join('\n'))
        }

        case 'stats': {
          if (!messages.length) return ok('No messages')
          const turns = parseTurns(messages)
          const counts: Record<string, number> = {}
          for (const m of messages) for (const b of m.content ?? []) counts[b?.type ?? 'unknown'] = (counts[b?.type ?? 'unknown'] ?? 0) + 1
          const pending = pendingToolUseIds(messages)
          const byName: Record<string, number> = {}
          for (const c of allToolCalls(messages)) byName[c.name] = (byName[c.name] ?? 0) + 1
          const top = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ')
          const user = messages.filter((m) => m.role === 'user').length
          let text = `Turns: ${turns.length}\nMessages: ${messages.length} (user: ${user}, assistant: ${messages.length - user})\nBlocks: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}\nTop tools: ${top || 'none'}\nPending toolUse (no result): ${pending.length}`
          if (pending.length) text += `\n⚠️ ${pending.length} orphaned toolUse block(s) — the active tool cycle accounts for the one running now`
          return ok(text)
        }

        case 'export': {
          if (!input.path) return err('export needs path')
          const p = resolve(input.path.replace(/^~(?=$|\/)/, homedir()))
          mkdirSync(dirname(p), { recursive: true })
          writeFileSync(p, JSON.stringify(messages, null, 2), 'utf8')
          const pending = pendingToolUseIds(messages)
          const droppableTurns = parseTurns(splitActive(messages).droppable).length
          let text = `Exported ${parseTurns(messages).length} turns (${messages.length} messages) to ${p} — ${droppableTurns} droppable + active turn`
          if (pending.length) text += `\n⚠️ ${pending.length} pending toolUse included (active tool cycle) — import repairs them`
          return ok(text)
        }

        case 'import': {
          if (!input.path) return err('import needs path')
          const p = resolve(input.path.replace(/^~(?=$|\/)/, homedir()))
          let raw: any
          try { raw = JSON.parse(readFileSync(p, 'utf8')) } catch (e: any) { return err(`cannot read ${p}: ${e?.message ?? e}`) }
          if (!Array.isArray(raw)) return err('invalid format: expected a JSON array of messages')
          let imported: Msg[]
          try { imported = raw.map((m: any) => Message.fromMessageData(m) as unknown as Msg) } catch (e: any) { return err(`cannot parse messages: ${e?.message ?? e}`) }
          const before = imported.length
          imported = fixIncompleteToolCycles(imported)
          const fixed = imported.length - before
          const v = validateStructure(imported)
          if (!v.ok) return err(`invalid structure after repair: ${v.error}`)
          const { active } = splitActive(messages)
          replaceHistory(messages, [...imported, ...active])
          let text = `Imported ${parseTurns(imported).length} turns (${before} messages) from ${p}`
          if (fixed > 0) text += `\n🔧 repaired ${fixed} incomplete tool cycle(s) with synthetic results`
          for (const w of v.warnings) text += `\n⚠️ ${w}`
          text += ', preserved active turn'
          return ok(text)
        }

        case 'drop': {
          const { droppable, active } = splitActive(messages)
          if (!droppable.length) return ok('No droppable messages (only the active turn exists)')
          const turns = parseTurns(droppable)
          const idx = resolveTurnIndices(turns.length, input.turns, input.start, input.end)
          if ('error' in idx) return err(idx.error)
          if (!idx.size) return err("specify turns='0,1,2' or start/end")
          const dropMsgs = new Set<number>()
          const inRange = [...idx].filter((t) => t >= 0 && t < turns.length)
          for (const t of inRange) for (let i = turns[t].start; i < turns[t].end; i++) dropMsgs.add(i)
          if (!inRange.length) return err(`no such turn(s): ${[...idx].join(', ')} (droppable turns: 0-${turns.length - 1})`)
          let kept = droppable.filter((_, i) => !dropMsgs.has(i))
          kept = fixIncompleteToolCycles(kept)
          replaceHistory(messages, [...kept, ...active])
          return ok(`Dropped ${inRange.length} turn(s) (${dropMsgs.size} messages). Remaining: ${parseTurns(kept).length} turns + active turn (${messages.length} messages total)`)
        }

        case 'drop_tools': {
          if (!input.tool_ids && !input.tool_name) return err('drop_tools needs tool_ids or tool_name')
          const active = activeToolIds(messages, selfId)
          const ids = new Set<string>()
          for (const tid of (input.tool_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
            if (active.has(tid)) return err(`cannot drop active tool: ${tid}`)
            ids.add(tid)
          }
          if (input.tool_name) {
            for (const c of allToolCalls(messages)) {
              if (c.name === input.tool_name && !active.has(c.toolUseId)) ids.add(c.toolUseId)
            }
          }
          if (!ids.size) return ok(`No droppable tool calls found${input.tool_name ? ` for ${input.tool_name}` : ''}`)
          const parts = splitActive(messages)
          if (!parts.droppable.length) return ok('No droppable messages (only the active turn exists)')
          let modified = removeToolBlocks(parts.droppable, ids)
          modified = fixIncompleteToolCycles(modified)
          // Honesty: report what ACTUALLY left the history, not what was asked.
          const stillThere = new Set(allToolCalls(modified).map((c) => c.toolUseId))
          const gone = [...ids].filter((id) => !stillThere.has(id))
          replaceHistory(messages, [...modified, ...parts.active])
          if (!gone.length) return err(`drop_tools removed nothing — ${[...ids].slice(0, 3).join(', ')} still present after edit`)
          let text = `Dropped ${gone.length} tool call(s): ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? '…' : ''}`
          const survived = [...ids].filter((id) => stillThere.has(id))
          if (survived.length) text += `\n⚠️ ${survived.length} survived (could not be removed): ${survived.slice(0, 5).join(', ')}`
          return ok(text)
        }

        case 'compact': {
          const { droppable, active } = splitActive(messages)
          if (!droppable.length) return ok('No compactable messages (only the active turn exists)')
          const turns = parseTurns(droppable)
          if (!turns.length) return ok('No complete turns found to compact')
          let idx = resolveTurnIndices(turns.length, input.turns, input.start, input.end)
          if ('error' in idx) return err(idx.error)
          if (!idx.size) {
            const keepRecent = 3 // default: compact everything but the newest 3 turns
            if (turns.length <= keepRecent) return ok(`Only ${turns.length} turns — nothing to compact (keeping last ${keepRecent})`)
            idx = new Set(Array.from({ length: turns.length - keepRecent }, (_, i) => i))
          }
          const countToolBlocks = (ms: Msg[]) => ms.reduce((n, m) => n + (m.content ?? []).filter((b: any) => b?.type === 'toolUseBlock' || b?.type === 'toolResultBlock').length, 0)
          const before = countToolBlocks(droppable)
          let compacted = stripToolBlocksFromTurns(droppable, idx as Set<number>, turns)
          compacted = fixIncompleteToolCycles(compacted)
          const removed = before - countToolBlocks(compacted)
          replaceHistory(messages, [...compacted, ...active])
          return ok(`Compacted ${(idx as Set<number>).size} turn(s), removed ${removed} tool blocks. Messages: ${droppable.length} → ${compacted.length} + active turn`)
        }

        case 'clear': {
          const { droppable, active } = splitActive(messages)
          const turnCount = parseTurns(droppable).length
          replaceHistory(messages, active)
          return ok(`Cleared ${turnCount} turn(s) (${droppable.length} messages), preserved active turn`)
        }
      }
    },
  })
}

/**
 * Strands stream-event reducer (extracted from Chat.tsx's 240-line
 * processStrandsEvent) — the heart of chat streaming, previously untestable
 * inside a live component closure.
 *
 * Pure by construction: applyStrandsEvent() maps one SSE event onto the
 * streaming assistant message and returns the next message list PLUS a list
 * of effect DESCRIPTORS. Anything that touches the world (toasts, memory
 * store, the map bridge, custom CSS/JS, theme persistence, speech synthesis)
 * comes back as data for Chat.tsx's interpreter to run — the reducer never
 * imports a side effect.
 *
 * Also immutable by construction: the old code mutated tool objects in place
 * (tool.input/status/result) inside a shallow-copy map — invisible today
 * because every event replaces the whole array, but it would silently defeat
 * any per-message memoization (stale shallow-equal references). Every tool
 * update here copies the array AND the tool.
 */
import { unwrapToolContent } from './tool-content'
import { resolveTheme, type TinyTheme } from '../theme'

export type StrandsToolCall = {
  id: string
  name: string
  input?: any
  status: 'calling' | 'success' | 'error'
  result?: any
  error?: string
}

export type StrandsMessage = {
  id: string
  role: string
  content?: string
  reasoning?: string
  toolCalls?: StrandsToolCall[]
  uiComponents?: { id: string; componentCode?: string; props?: any; title?: string }[]
  speech?: { id: string; text: string; voice?: string }[]
  followups?: string[]
  failedPrompt?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens?: number }
  modelId?: string
}

/** Agent map gestures executed against the mounted map's bridge. */
export const MAP_TOOL_NAMES = [
  'add_map_marker', 'fly_to_location', 'clear_map_markers',
  'remove_map_marker', 'fly_to_marker', 'tour_markers',
] as const

export type StrandsEffect =
  | { kind: 'memory-add'; content: string; tags?: string[] }
  | { kind: 'memory-forget'; match: string }
  | { kind: 'map'; name: string; input: any }
  | { kind: 'message-surgery'; input: any }
  | { kind: 'customize-page'; input: any }
  | { kind: 'set-theme'; theme: TinyTheme | null }
  | { kind: 'speak'; id: string; text: string; voice?: string }
  | { kind: 'log-error'; error: unknown }

export function applyStrandsEvent<M extends StrandsMessage>(
  msgs: M[],
  event: any,
  asstId: string,
  promptText: string,
): { messages: M[]; effects: StrandsEffect[] } {
  const effects: StrandsEffect[] = []

  const messages = msgs.map((m) => {
    if (m.id !== asstId) return m

    // Work on the structural type; the spread carries every extra field of M,
    // and we only write fields StrandsMessage declares — the closing `as M`
    // is the honest boundary of that contract.
    const newMsg: StrandsMessage = { ...m }

    // Text deltas (don't drop falsy-but-real deltas like "0")
    if (event.type === 'modelContentBlockDeltaEvent' && event.textDelta !== undefined && event.textDelta !== null) {
      newMsg.content = (newMsg.content || '') + event.textDelta
    }

    // New model message within the same turn (text → tool → text):
    // separate from the previous text so messages don't run together
    else if (event.type === 'modelMessageStartEvent') {
      if (newMsg.content && !newMsg.content.endsWith('\n')) {
        newMsg.content += '\n\n'
      }
    }

    // Reasoning deltas
    else if (event.type === 'modelContentBlockDeltaEvent' && event.reasoningDelta) {
      newMsg.reasoning = (newMsg.reasoning || '') + event.reasoningDelta
    }

    // Tool start — append once per toolUseId
    else if (event.type === 'modelContentBlockStartEvent' && event.toolStart) {
      const toolCalls = newMsg.toolCalls || []
      if (!toolCalls.some((t) => t.id === event.toolStart.toolUseId)) {
        newMsg.toolCalls = [...toolCalls, {
          id: event.toolStart.toolUseId,
          name: event.toolStart.name,
          status: 'calling',
        }]
      }
    }

    // Before tool call — capture input; client-side tools become effects
    else if (event.type === 'beforeToolCallEvent' && event.toolCall) {
      const call = event.toolCall
      newMsg.toolCalls = (newMsg.toolCalls || []).map((t) =>
        t.id === call.toolUseId ? { ...t, input: call.input } : t)

      // 🧠 remember/forget — executed against localStorage by the interpreter
      if (call.name === 'remember' && call.input?.content) {
        effects.push({ kind: 'memory-add', content: call.input.content, tags: call.input.tags })
      }
      if (call.name === 'forget' && call.input?.match) {
        effects.push({ kind: 'memory-forget', match: call.input.match })
      }

      // 💡 suggest_followups — chips for rendering (pure message state)
      if (call.name === 'suggest_followups' && call.input?.chips) {
        newMsg.followups = (call.input.chips as string[]).slice(0, 4)
      }

      // 🗺️ Agent map controls — bridge lookup + hint live in the interpreter
      if ((MAP_TOOL_NAMES as readonly string[]).includes(call.name)) {
        effects.push({ kind: 'map', name: call.name, input: call.input || {} })
      }

      // ✂️ manage_messages — deferred conversation surgery (interpreter
      // re-reads the live list a tick later; the math is applyMessageSurgery)
      if (call.name === 'manage_messages' && call.input?.action) {
        effects.push({ kind: 'message-surgery', input: call.input })
      }

      // 🖌️ customize_page — CSS/JS application + persistence rules stay in
      // the interpreter (approval-gate comments live there)
      if (call.name === 'customize_page' && call.input) {
        effects.push({ kind: 'customize-page', input: call.input })
      }

      // 🎨 set_theme — the DECISION is pure (resolveTheme); applying is not.
      // Same gate as before: apply when something resolved, or an explicit
      // reset, or the named default preset.
      if (call.name === 'set_theme' && call.input) {
        const inp = call.input as { preset?: string; accent?: string; background?: string; reset?: boolean }
        const theme = inp.reset ? null : resolveTheme(inp)
        if (theme !== null || inp.reset || (inp.preset || '').toLowerCase() === 'tiny') {
          effects.push({ kind: 'set-theme', theme })
        }
      }

      // 🔊 speak — playback card (pure) + autoplay (effect)
      if (call.name === 'speak' && call.input?.text) {
        newMsg.speech = [...(newMsg.speech || []), {
          id: call.toolUseId,
          text: call.input.text,
          voice: call.input.voice,
        }]
        effects.push({ kind: 'speak', id: call.toolUseId, text: call.input.text, voice: call.input.voice })
      }

      // render_ui — dynamic component code (pure message state)
      if (call.name === 'render_ui' && call.input) {
        newMsg.uiComponents = [...(newMsg.uiComponents || []), {
          id: call.toolUseId,
          componentCode: call.input.componentCode,
          props: call.input.props,
          title: call.input.title,
        }]
      }
    }

    // After tool call — capture result
    else if (event.type === 'afterToolCallEvent' && event.toolResult) {
      const res = event.toolResult
      newMsg.toolCalls = (newMsg.toolCalls || []).map((t) =>
        t.id === res.toolUseId
          ? { ...t, status: res.error ? 'error' as const : 'success' as const, result: unwrapToolContent(res.content), error: res.error }
          : t)
    }

    // 📊 Token usage (accumulate across model calls within the turn)
    else if (event.type === 'modelMetadataEvent' && event.usage) {
      const prev = newMsg.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0 }
      newMsg.usage = {
        inputTokens: prev.inputTokens + (event.usage.inputTokens || 0),
        outputTokens: prev.outputTokens + (event.usage.outputTokens || 0),
        totalTokens: prev.totalTokens + (event.usage.totalTokens || 0),
        // Cached reads bill at a fraction — carried so estimateCost isn't inflated
        cacheReadInputTokens: (prev.cacheReadInputTokens || 0) + (event.usage.cacheReadInputTokens || 0),
      }
      if (event.modelId) newMsg.modelId = event.modelId // for $ estimation
    }

    // Error — server streamed a friendly error → show it and offer retry
    else if (event.type === 'error') {
      effects.push({ kind: 'log-error', error: event.error })
      newMsg.content = (newMsg.content || '') + (newMsg.content ? '\n\n' : '') + `⚠️ ${event.error}`
      newMsg.failedPrompt = promptText
    }

    return newMsg as M
  })

  return { messages, effects }
}

/**
 * ✂️ manage_messages math — pure over a message list. Positions are 1-based;
 * the streaming assistant message (protectedId) is immune to surgery.
 * `messages: null` = list unchanged; `note` = toast copy ('' = silent).
 */
export function applyMessageSurgery<M extends { id: string; content?: string }>(
  msgs: M[],
  inp: any,
  protectedId: string,
  makeSummary: (content: string) => M,
): { messages: M[] | null; note: string; error?: boolean } {
  const protectedIdx = msgs.findIndex((mm) => mm.id === protectedId)
  if (inp.action === 'stats') {
    const chars = msgs.reduce((n, mm) => n + (mm.content?.length || 0), 0)
    return { messages: null, note: `✂️ ${msgs.length} messages, ~${(chars / 1000).toFixed(1)}K chars` }
  }
  const from = Math.max(1, Number(inp.from) || 0)
  const to = Math.min(msgs.length, Number(inp.to) || from)
  if (!from || from > to) return { messages: null, note: '✂️ Invalid range', error: true }
  if (inp.action === 'drop') {
    const messages = msgs.filter((_, i) => {
      const pos = i + 1
      return pos < from || pos > to || i === protectedIdx
    })
    return { messages, note: `✂️ Dropped ${to - from + 1} message${to === from ? '' : 's'}` }
  }
  if (inp.action === 'compact' && inp.summary) {
    const summaryMsg = makeSummary(`📜 Compacted (${from}-${to}): ${inp.summary}`)
    const messages: M[] = []
    msgs.forEach((mm, i) => {
      const pos = i + 1
      if (pos === from) messages.push(summaryMsg)
      if (pos < from || pos > to || i === protectedIdx) messages.push(mm)
    })
    return { messages, note: `✂️ Compacted ${to - from + 1} messages into a summary` }
  }
  return { messages: null, note: '' }
}

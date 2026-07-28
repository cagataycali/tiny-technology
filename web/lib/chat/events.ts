/**
 * Agent-event → SSE wire-format normalization (extracted from the chat
 * route's pump loop). Strands SDK 1.10 wraps model deltas in
 * modelStreamUpdateEvent; the client speaks a flat event vocabulary.
 *
 * Pure: one event in → one wire payload out (or null to drop). The route
 * adds seq numbers and does the actual enqueueing.
 */
import { serializeToolContent } from './helpers'

/**
 * Strip base64 media bytes from a tool result's WIRE copy. generate_image
 * returns the actual pixels to the MODEL (that's the point — it sees what it
 * made), but replaying ~700KB of base64 to the client inside one SSE frame
 * helps nobody: the generating device already holds the image, and every
 * client renders from the hosted URL in the accompanying text block. The
 * serialized copy is fresh (toJSON), so replacing entries never touches the
 * agent-held result that becomes model history.
 */
function slimMediaBytes(content: any): any {
  if (!Array.isArray(content)) return content
  return content.map((c: any) =>
    c?.image?.source?.bytes
      ? { image: { format: c.image.format, source: { bytes: '' }, elided: true } }
      : c
  )
}

/**
 * Did a normalized wire payload deliver something the caller paid for? Text or
 * reasoning the user can read, or a completed tool call (real work). Metadata,
 * lifecycle markers, and empty deltas do NOT count — so a paid turn that errors
 * before any of these is refundable (chat route's settle-before-serve path).
 * Kept beside normalizeAgentEvent so a new delta type is classified in one place.
 */
export function isDeliveredOutput(payload: Record<string, any> | null): boolean {
  if (!payload) return false
  if (payload.type === 'afterToolCallEvent') return true
  // Deltas can arrive empty (''); only non-empty text/reasoning is delivery.
  return Boolean(payload.textDelta) || Boolean(payload.reasoningDelta)
}

/**
 * 🏷️ Per-turn toolUseId → tool name memory, so an `afterToolCallEvent` that
 * arrives without `toolUse` can still be named.
 *
 * Why it matters (loop item p-a): every native client gates its tool-result
 * handling on the NAME. iOS drops the whole after-event branch when it's missing
 * (`if let n = tr["name"]`, Api.swift), so a nameless result means no pay_x402
 * quote card, no spawn_agents batch result, no tool chip flipping to ✓ — the
 * payment UI simply never appears, which is exactly the symptom the gaps report
 * ranked as cause 3. `toolUseId` already had a `?? e.result?.toolUseId`
 * fallback; the name had none, and web survived only because it keys off the id
 * it captured at the BEFORE event. This gives the server the same trick: the
 * before-event (or the model's toolUseStart) always carries both, so remember
 * the pairing and resolve it later.
 *
 * A Map is enough — one per request, discarded with the turn. Callers that don't
 * pass one keep the previous behavior exactly.
 */
export type ToolNames = Map<string, string>

/** Bound on remembered pairs — a runaway loop can't grow this without limit. */
const MAX_REMEMBERED_TOOLS = 512

function rememberToolName(names: ToolNames | undefined, toolUseId: any, name: any): void {
  if (!names || typeof toolUseId !== 'string' || !toolUseId || typeof name !== 'string' || !name) return
  // Keep the FIRST pairing for an id (ids are unique per call, so a re-set would
  // only ever be the same value) and stop growing at the cap rather than evict:
  // evicting could drop the very entry the pending result needs.
  if (names.has(toolUseId) || names.size >= MAX_REMEMBERED_TOOLS) return
  names.set(toolUseId, name)
}

export function normalizeAgentEvent(
  e: any,
  resolvedModelId: string,
  names?: ToolNames,
): Record<string, any> | null {
  switch (e?.type) {
    // ---- Model streaming (wrapped) ----
    case 'modelStreamUpdateEvent': {
      const inner = e.event
      if (!inner) return null

      if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta) {
        const delta = inner.delta
        if (delta.type === 'textDelta' && delta.text !== undefined && delta.text !== null) {
          return { type: 'modelContentBlockDeltaEvent', textDelta: delta.text }
        } else if (delta.type === 'reasoningContentDelta' && delta.text) {
          return { type: 'modelContentBlockDeltaEvent', reasoningDelta: delta.text }
        } else if (delta.type === 'toolUseInputDelta' && delta.input) {
          return { type: 'modelContentBlockDeltaEvent', toolInputDelta: delta.input }
        } else if (delta.type === 'citationsDelta') {
          return { type: 'modelContentBlockDeltaEvent', citationsDelta: delta }
        }
        return null
      } else if (inner.type === 'modelContentBlockStartEvent' && inner.start?.type === 'toolUseStart') {
        // Earliest point the pairing is known — remember it here too, so a tool
        // whose before-event never fires is still nameable at its result.
        rememberToolName(names, inner.start.toolUseId, inner.start.name)
        return {
          type: 'modelContentBlockStartEvent',
          toolStart: { name: inner.start.name, toolUseId: inner.start.toolUseId },
        }
      } else if (inner.type === 'modelContentBlockStopEvent') {
        return { type: 'modelContentBlockStopEvent' }
      } else if (inner.type === 'modelMessageStartEvent') {
        return { type: 'modelMessageStartEvent' }
      } else if (inner.type === 'modelMessageStopEvent') {
        return { type: 'modelMessageStopEvent', stopReason: inner.stopReason }
      } else if (inner.type === 'modelMetadataEvent') {
        return { type: 'modelMetadataEvent', usage: inner.usage, metrics: inner.metrics, modelId: resolvedModelId }
      }
      return null
    }

    // ---- Tool lifecycle ----
    case 'beforeToolCallEvent':
      rememberToolName(names, e.toolUse?.toolUseId, e.toolUse?.name)
      return {
        type: 'beforeToolCallEvent',
        toolCall: {
          name: e.toolUse?.name,
          toolUseId: e.toolUse?.toolUseId,
          input: e.toolUse?.input,
        },
      }

    case 'afterToolCallEvent': {
      const toolUseId = e.toolUse?.toolUseId ?? e.result?.toolUseId
      // The name the SDK gave us, or the one we remembered from this call's
      // start/before event (see ToolNames — a nameless result is invisible on
      // every native client).
      const name = e.toolUse?.name ?? (typeof toolUseId === 'string' ? names?.get(toolUseId) : undefined)
      return {
        type: 'afterToolCallEvent',
        toolResult: {
          name,
          toolUseId,
          status: e.result?.status,
          content: slimMediaBytes(serializeToolContent(e.result?.content)),
          error: e.error ? String(e.error?.message ?? e.error) : undefined,
        },
      }
    }

    // Streaming progress from tools (ToolStreamEvent updates)
    case 'toolStreamUpdateEvent': {
      const innerEvent = e.event
      const streamId = e.toolUse?.toolUseId
      return {
        type: 'toolStreamUpdateEvent',
        toolStream: {
          toolUseId: streamId,
          // Same fallback as the after event: progress frames route by name on
          // the clients, so an unnamed one is dropped mid-tool.
          name: e.toolUse?.name ?? (typeof streamId === 'string' ? names?.get(streamId) : undefined),
          data: typeof innerEvent?.toJSON === 'function' ? innerEvent.toJSON() : innerEvent,
        },
      }
    }

    // Final tool result block (kept for backwards compatibility)
    case 'toolResultEvent': {
      const r = e.result
      return {
        type: 'toolResultBlock',
        toolResultBlock: {
          toolUseId: r?.toolUseId,
          status: r?.status,
          content: serializeToolContent(r?.content),
        },
      }
    }

    // ---- Agent lifecycle ----
    case 'agentResultEvent':
      return { type: 'agentResultEvent', stopReason: e.result?.stopReason }

    // Everything else (invocation/model-call/tools lifecycle, messageAdded…)
    // is forwarded as a lightweight type-only marker so clients can observe
    // the full loop without heavy payloads.
    default:
      return e?.type ? { type: e.type } : null
  }
}

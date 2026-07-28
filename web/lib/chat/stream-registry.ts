/**
 * Concurrent-stream registry (docs/concurrent-sends-implementation.md,
 * Option B) — replaces Chat.tsx's single-flight scalar gate with a bounded
 * set of live assistant-message ids.
 *
 * Semantics: "parallel exploration with cross-visibility". Each send
 * snapshots history at send time; a sibling turn that is still streaming is
 * INCLUDED in that snapshot as an annotated partial (annotateLivePartial),
 * so back-to-back questions see each other's in-progress answers. Because
 * every stream accumulates into its own message object inside one linear
 * messagesRef, the finished transcript needs no merge step — it is already
 * userA, asstA, userB, asstB in launch order, and the next turn ships the
 * complete history.
 *
 * Pure (no React): Chat.tsx holds one instance in a ref and mirrors id
 * changes into state via onChange.
 */

// Unbounded by request — every send streams immediately. The cap parameter
// remains for tests (cap=1 reproduces the old single-flight gate) and as a
// dial if billing pressure ever demands one.
export const MAX_CONCURRENT_STREAMS = Infinity

export interface StreamRegistry {
  /** Claim a slot for this id. SYNCHRONOUS — two same-tick claims both
   *  succeed only while under the cap (that's now the intended behavior;
   *  the old gate's double-submit race becomes bounded concurrency). */
  claim(id: string, now?: number): boolean
  release(id: string): void
  has(id: string): boolean
  size(): number
  /** Epoch ms the stream was claimed — feeds the "started Ns ago" annotation. */
  startedAt(id: string): number | undefined
  ids(): string[]
}

export function createStreamRegistry(
  max: number = MAX_CONCURRENT_STREAMS,
  onChange?: (ids: Set<string>) => void,
): StreamRegistry {
  const live = new Map<string, number>()
  const emit = () => onChange?.(new Set(live.keys()))
  return {
    claim(id, now = Date.now()) {
      if (live.size >= max) return false
      live.set(id, now)
      emit()
      return true
    },
    release(id) {
      if (live.delete(id)) emit()
    },
    has: (id) => live.has(id),
    size: () => live.size,
    startedAt: (id) => live.get(id),
    ids: () => Array.from(live.keys()),
  }
}

/**
 * How a still-streaming sibling reply appears in a concurrent turn's
 * history: the partial text so far, clearly marked as in-progress so the
 * model neither treats it as final nor re-answers it.
 */
export function annotateLivePartial(content: string, startedAt: number, now: number = Date.now()): string {
  const secs = Math.max(1, Math.round((now - startedAt) / 1000))
  const body = (content || '').trim()
  return body
    ? `[⏳ You are STILL WRITING this reply in a parallel turn (started ${secs}s ago). Partial text so far — do not repeat it, but you may build on it:]\n${body}`
    : `[⏳ You are still working on a reply to the previous message in a parallel turn (started ${secs}s ago) — nothing written yet. Answer the new message on its own.]`
}

/**
 * Build the outgoing history for one turn from the appended transcript —
 * THE concurrency semantics, extracted from Chat.tsx's send() so it's
 * testable. Rules:
 *  - the new turn's own placeholder is excluded
 *  - empty/deleted messages drop (strict providers reject empty text
 *    blocks) — EXCEPT sibling live placeholders, which pass even when
 *    empty and are annotated as in-progress partials
 *  - attachment-carrying messages become content blocks via the injected
 *    builder (kept as a parameter so this stays pure/testable)
 */
export function buildTurnHistory(
  appended: Array<{ id: string; role: string; content?: string; attachments?: unknown[] }>,
  asstId: string,
  live: StreamRegistry,
  buildBlocks: (text: string, attachments: any) => any[],
  now: number = Date.now(),
): Array<{ role: string; content: any[] }> {
  return appended
    .filter((m) => m.id !== asstId)
    .filter((m) => (m.content && m.content.trim() && m.content !== '_deleted..._') || m.attachments?.length || live.has(m.id))
    .map((m) => ({
      role: m.role,
      content: m.attachments?.length
        ? buildBlocks(m.content || '', m.attachments)
        : [{ text: live.has(m.id)
            ? annotateLivePartial(m.content || '', live.startedAt(m.id) || now, now)
            : m.content }],
    }))
}

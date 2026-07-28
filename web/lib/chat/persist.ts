/**
 * Transcript persistence with quota degradation (extracted from Chat.tsx's
 * two silent-catch persist sites — a full store meant every session quietly
 * evaporated on reload while the UI kept implying history persists).
 *
 * Strategy on a failed write: keep the leading system seed(s) — the page
 * must still boot themed/seeded — and drop the OLDEST half of the rest,
 * retrying up to three halvings. Recent turns are what a reload must not
 * lose. Returns what happened so the caller warns the user ONCE instead of
 * console-whispering.
 */
export type ChatMeta = { count: number; snippet: string }
export const chatMetaKey = (name: string) => `chat_meta_${name}`

/**
 * Palette-facing summary, derived at PERSIST time (v4 C12): ⌘K used to
 * JSON.parse every multi-MB transcript in localStorage just to show a count
 * and a snippet — open jank scaling with total history size. Same shape the
 * palette's old inline scan produced: total message count + the last user
 * message's first 80 chars.
 */
export function deriveChatMeta(messages: { role?: string; content?: unknown }[]): ChatMeta {
  let snippet = ''
  for (let j = messages.length - 1; j >= 0; j--) {
    const m = messages[j]
    if (m?.role === 'user' && typeof m.content === 'string') { snippet = m.content.slice(0, 80); break }
  }
  return { count: messages.length, snippet }
}

/**
 * Two tabs on the same tiny both debounce-write their whole transcript to
 * chat_messages_<name> (v4 C5): you chat in tab A, tab B still holds the
 * older history in memory, and B's next persist — or its pagehide — writes
 * that stale copy over A's turns. Last-writer-wins, so the conversation you
 * just had disappears on reload.
 *
 * The decision an idle tab makes when it learns the stored snapshot changed:
 * adopt it (and, at write time, decline to overwrite it). Only a tab with
 * nothing of its own at stake may adopt — `authored` covers a tab that has
 * sent, cleared, or loaded its own history since it last synced, and
 * `streaming` covers a reply in flight whose message ids the stored copy
 * doesn't know about. Counts come from the chat_meta_<name> blob, so the
 * multi-MB transcript is only parsed once a decision says to adopt.
 *
 * Strictly-greater is what makes this terminate: adopting re-persists the
 * same messages and beats back, and the peer then sees equal counts.
 * A cleared peer (meta gone, no count to compare) is deliberately NOT
 * adopted — "cleared" and "never written" are the same absence here.
 */
export type AdoptInput = {
  localCount: number
  remoteCount: number | null
  authored: boolean
  streaming: boolean
  viewingShare: boolean
}
export type AdoptDecision =
  | { adopt: true; remoteCount: number }
  | { adopt: false; reason: 'viewing-share' | 'streaming' | 'authored' | 'no-meta' | 'not-newer' }

export function shouldAdoptPersisted(input: AdoptInput): AdoptDecision {
  // A share view never touches the visitor's own storage in either direction.
  if (input.viewingShare) return { adopt: false, reason: 'viewing-share' }
  if (input.streaming) return { adopt: false, reason: 'streaming' }
  if (input.authored) return { adopt: false, reason: 'authored' }
  const remote = input.remoteCount
  if (typeof remote !== 'number' || !Number.isFinite(remote)) return { adopt: false, reason: 'no-meta' }
  if (remote <= input.localCount) return { adopt: false, reason: 'not-newer' }
  return { adopt: true, remoteCount: remote }
}

/**
 * The write side of the same question. A tab that adopted a peer's snapshot
 * is a MIRROR: writing its copy back would undo the peer's newer turns (and,
 * worse, freeze that peer's in-flight tool calls as interrupted), so the peer
 * keeps ownership of the key until this tab authors something of its own.
 * Anything this tab authored or is streaming must always be saved.
 */
export type PersistGuardInput = AdoptInput & { mirroring: boolean }

export function shouldWriteTranscript(input: PersistGuardInput): boolean {
  if (input.viewingShare) return false
  if (input.streaming || input.authored) return true
  if (input.mirroring) return false
  // No beat reached this tab (no BroadcastChannel, or it fired before the
  // listener) yet storage moved ahead of us: decline rather than clobber.
  return !shouldAdoptPersisted(input).adopt
}

/** Shape-guarded read of a chat_meta_<name> blob (corrupt/absent → null). */
export function parseChatMeta(raw: string | null): ChatMeta | null {
  if (!raw) return null
  try {
    const m = JSON.parse(raw)
    if (!m || typeof m.count !== 'number' || !Number.isFinite(m.count)) return null
    return { count: m.count, snippet: typeof m.snippet === 'string' ? m.snippet : '' }
  } catch { return null }
}

export type PersistOutcome =
  | { ok: true; dropped: number }
  | { ok: false }

export function persistTranscript(
  setItem: (key: string, value: string) => void,
  key: string,
  messages: { role?: string }[],
): PersistOutcome {
  let current = messages
  let dropped = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      setItem(key, JSON.stringify(current))
      return { ok: true, dropped }
    } catch {
      const firstNonSystem = current.findIndex((m) => m?.role !== 'system')
      // Nothing droppable left (all seed, or a single surviving turn) —
      // this store is truly unwritable.
      if (firstNonSystem === -1 || current.length - firstNonSystem < 2) return { ok: false }
      const head = current.slice(0, firstNonSystem)
      const tail = current.slice(firstNonSystem)
      const keep = tail.slice(Math.ceil(tail.length / 2))
      dropped += tail.length - keep.length
      current = [...head, ...keep]
    }
  }
  return { ok: false }
}

/**
 * The per-tiny browser-storage inventory (v5 D4).
 *
 * A tiny's local footprint grew one key family per cycle — transcript, then
 * `chat_meta_` (c41), `chat_draft_` (c43), `chat_pending_files_` (c45) — while
 * the "Delete this tiny forever?" button in Control kept removing exactly one
 * of them. Its own copy promises "config, search index, everything", and the
 * two families with real teeth were never in the list: `tiny_turnlog_` and
 * `tiny_memories_` (continuity.ts), which `buildContinuityContext` injects
 * into EVERY request as "Persistent Memories… survives resets". Delete a tiny
 * and the persona's memories and last 200 turns stay on the disk it was
 * deleted from; register that name again and a new persona is handed a
 * stranger's past as its own.
 *
 * So the list lives in ONE place, and a scan test fails when a new per-tiny
 * key appears in the web tree without joining it — the recurrence is the
 * actual bug, four cycles running.
 *
 * NOT in scope, deliberately: sweeping orphans for tinys deleted on some other
 * device. The browser has no authoritative list of live tinys — a draft with
 * no transcript is a perfectly good "typed something, never sent it" — so any
 * client-side orphan rule would eventually delete data somebody still wanted.
 * That needs server truth, and it isn't this module's call to fake.
 */

export type TinyKeyFamily = {
  /** Stable id for tests + call-site readability. */
  id: string
  store: 'local' | 'session'
  /** The exact key this family uses for a given tiny. */
  key: (name: string) => string
  /** What the value is, so a future reader knows what erasing it costs. */
  note: string
}

export const TINY_KEY_FAMILIES: TinyKeyFamily[] = [
  {
    id: 'transcript',
    store: 'local',
    key: (name) => `chat_messages_${name}`,
    note: 'the conversation itself',
  },
  {
    id: 'meta',
    store: 'local',
    key: (name) => `chat_meta_${name}`,
    note: 'palette summary — a ghost in ⌘K if it outlives the transcript',
  },
  {
    id: 'draft',
    store: 'local',
    key: (name) => `chat_draft_${name}`,
    note: 'unsent composer text',
  },
  {
    id: 'pending-files',
    store: 'local',
    key: (name) => `chat_pending_files_${name}`,
    note: 'names of files staged but never sent',
  },
  {
    id: 'turnlog',
    store: 'local',
    key: (name) => `tiny_turnlog_${name}`,
    note: 'continuity turn log — injected into every request, survives /clear',
  },
  {
    id: 'memories',
    store: 'local',
    key: (name) => `tiny_memories_${name}`,
    note: 'continuity memories — injected into every request, survives /clear',
  },
  {
    id: 'private-key',
    store: 'session',
    key: (name) => `${name}:key`,
    note: 'the access key for a private tiny — a secret for something now gone',
  },
  {
    id: 'ambient-findings',
    store: 'session',
    // Mirrors ambient.ts exactly, empty-name fallback included.
    key: (name) => `tiny_ambient_findings:${name || '_'}`,
    note: 'ambient run output',
  },
  {
    id: 'ambient-count',
    store: 'session',
    key: (name) => `tiny_ambient_count:${name || '_'}`,
    note: 'ambient request meter',
  },
]

/** Every key this tiny owns, per store. Order follows TINY_KEY_FAMILIES. */
export function tinyKeys(name: string): { local: string[]; session: string[] } {
  const local: string[] = []
  const session: string[] = []
  for (const f of TINY_KEY_FAMILIES) {
    ;(f.store === 'local' ? local : session).push(f.key(name))
  }
  return { local, session }
}

/** Minimal shape we need from a Storage — keeps this node-testable. */
export type KeyStore = { removeItem: (key: string) => void }

/**
 * Erase everything this browser holds for `name`. Returns the keys it removed
 * so a caller (or a test) can see the promise was kept.
 *
 * Per-key try/catch on purpose: `removeItem` throws SecurityError when site
 * data is fully blocked (the ModelSettings precedent), and one hostile key
 * must not strand the rest — a partial erase is still better than none, and
 * a delete confirmation must never blow up after the tiny is already gone
 * server-side.
 */
export function purgeTinyKeys(
  stores: { local?: KeyStore | null; session?: KeyStore | null },
  name: string,
): string[] {
  if (!name) return []
  const removed: string[] = []
  for (const f of TINY_KEY_FAMILIES) {
    const store = f.store === 'local' ? stores.local : stores.session
    if (!store) continue
    const key = f.key(name)
    try {
      store.removeItem(key)
      removed.push(key)
    } catch { /* blocked storage, or one bad key — keep going */ }
  }
  return removed
}

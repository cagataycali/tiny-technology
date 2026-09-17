/**
 * Mesh registry — file-based agent discovery, port of devduck's mesh_registry.py.
 *
 * Every tiny process that joins the mesh (daemon, repl, tui, MCP server) writes
 * itself — and every peer it discovers — into ONE json file under the temp dir.
 * Any other process on this machine can then answer "who is on the mesh?"
 * instantly, WITHOUT opening a zenoh session of its own. That is what makes
 * `tiny-tech mesh peers` cheap and what lets the MCP server list peers while
 * the daemon owns the actual multicast session.
 *
 * Crash safety, same three tricks as devduck:
 *   1. writes are serialized with a lock file (stale locks broken after 2s)
 *   2. writes are atomic — tmp file + rename() (atomic on POSIX)
 *   3. entries expire by TTL, so a killed process needs no cleanup
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface RegistryEntry {
  id: string
  type: string
  metadata: Record<string, any>
  registered_at: number
  last_seen: number
  pid?: number
}

export const REGISTRY_DIR = join(tmpdir(), 'tiny')
export const REGISTRY_PATH = join(REGISTRY_DIR, 'mesh_registry.json')

/** Entries older than this are dead (zenoh heartbeat is 5s — 30s is headroom) */
export const STALE_MS = 30_000
const LOCK_STALE_MS = 2_000

/**
 * Presence metadata is written by FOREIGN nodes, so its size is not ours to
 * trust. A devduck heartbeat carries its whole self-aware system prompt —
 * source code included — which measured 356 KB for ONE peer and pushed this
 * file past 800 KB. Every heartbeat read-modify-writes the WHOLE file under a
 * lock, so unbounded metadata turns discovery into disk churn and makes the
 * lock contention that used to drop entries (see mutate) unavoidable.
 */
export const IDENTITY_MAX_CHARS = 500
export const TOOLS_MAX = 50

/** Fields that describe THIS process and must never be trusted from the file. */
const PROCESS_LOCAL_KEYS = ['is_self', 'layer'] as const

/** Clamp foreign-authored metadata to a bounded shape before it hits disk. */
export function sanitizeMetadata(metadata: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...metadata }
  for (const k of PROCESS_LOCAL_KEYS) delete out[k]
  if (typeof out.system_prompt === 'string' && out.system_prompt.length > IDENTITY_MAX_CHARS) {
    out.system_prompt = out.system_prompt.slice(0, IDENTITY_MAX_CHARS) + '…'
  }
  if (Array.isArray(out.tools) && out.tools.length > TOOLS_MAX) out.tools = out.tools.slice(0, TOOLS_MAX)
  return out
}

export class MeshRegistry {
  constructor(
    private path: string = REGISTRY_PATH,
    private staleMs: number = STALE_MS,
  ) {}

  // ── read (no lock — we read whatever is on disk) ────────────────────────

  private readRaw(): { agents: Record<string, RegistryEntry> } {
    try {
      if (!existsSync(this.path)) return { agents: {} }
      const data = JSON.parse(readFileSync(this.path, 'utf8'))
      return { agents: data?.agents && typeof data.agents === 'object' ? data.agents : {} }
    } catch {
      return { agents: {} } // missing or corrupt — treat as empty
    }
  }

  /** Every live entry (stale filtered unless includeStale). */
  getAll(includeStale = false): Record<string, RegistryEntry> {
    const agents = this.readRaw().agents
    if (includeStale) return agents
    const now = Date.now()
    const live: Record<string, RegistryEntry> = {}
    for (const [id, e] of Object.entries(agents)) {
      if (now - (e?.last_seen || 0) <= this.staleMs) live[id] = e
    }
    return live
  }

  /** Live entries as a list, freshest first. */
  live(): RegistryEntry[] {
    return Object.values(this.getAll()).sort((a, b) => b.last_seen - a.last_seen)
  }

  get(id: string): RegistryEntry | undefined {
    return this.getAll()[id]
  }

  /** Is this entry OUR process? Derived from the pid stamp, never from metadata. */
  isSelf(entry: RegistryEntry | undefined): boolean {
    return !!entry && entry.pid === process.pid
  }

  // ── write (locked + atomic) ─────────────────────────────────────────────

  private acquireLock(): string | null {
    const lock = this.path + '.lock'
    for (let i = 0; i < 50; i++) {
      try {
        closeSync(openSync(lock, 'wx'))
        return lock
      } catch {
        // Break a lock left behind by a killed process
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock)
        } catch { /* someone else won the race */ }
        // 10ms spin — registry writes are tiny and rare
        const until = Date.now() + 10
        while (Date.now() < until) { /* busy wait, sync API by design */ }
      }
    }
    return null // never block a heartbeat on the registry
  }

  private mutate(fn: (agents: Record<string, RegistryEntry>) => void): void {
    try {
      if (!existsSync(REGISTRY_DIR)) mkdirSync(REGISTRY_DIR, { recursive: true })
      const lock = this.acquireLock()
      // No lock → SKIP the write. This used to fall through and write anyway
      // ("never block a heartbeat"), which made mutate a read-modify-write of
      // the whole map with no mutual exclusion: concurrent processes silently
      // clobbered each other's keys (that is how a node's own pid stamp went
      // missing and `mesh peers` reported the wrong ★self). Heartbeats are
      // idempotent and repeat every 5s, so dropping one costs nothing.
      if (!lock) return
      try {
        const data = this.readRaw()
        fn(data.agents)
        const tmp = `${this.path}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify({ agents: data.agents, updated_at: Date.now() }))
        renameSync(tmp, this.path) // atomic swap
      } finally {
        try { unlinkSync(lock) } catch {}
      }
    } catch { /* the registry is a convenience, never a hard dependency */ }
  }

  /**
   * `metadata.is_self` marks OUR OWN entry: it stamps the pid and is then
   * dropped rather than stored. Self-ness is a fact about a process, so it is
   * derived from the pid at read time (isSelf) — storing it in a file every
   * process may rewrite let one node overwrite another node's identity.
   */
  register(id: string, type: string, metadata: Record<string, any> = {}): void {
    const now = Date.now()
    const self = metadata.is_self === true
    this.mutate((agents) => {
      const prev = agents[id]
      agents[id] = {
        id, type,
        metadata: sanitizeMetadata({ ...(prev?.metadata || {}), ...metadata }),
        registered_at: prev?.registered_at || now,
        last_seen: now,
        pid: self ? process.pid : prev?.pid,
      }
    })
  }

  heartbeat(id: string, metadata: Record<string, any> = {}): void {
    const now = Date.now()
    const self = metadata.is_self === true
    this.mutate((agents) => {
      const prev = agents[id]
      if (!prev) {
        agents[id] = {
          id, type: 'zenoh', metadata: sanitizeMetadata(metadata),
          registered_at: now, last_seen: now, ...(self ? { pid: process.pid } : {}),
        }
        return
      }
      prev.last_seen = now
      if (self) prev.pid = process.pid
      // Re-sanitize the MERGE, not just the new keys: an entry written before
      // the clamp existed (or by an older tiny) shrinks on its next touch.
      if (Object.keys(metadata).length) prev.metadata = sanitizeMetadata({ ...prev.metadata, ...metadata })
    })
  }

  unregister(id: string): void {
    this.mutate((agents) => { delete agents[id] })
  }

  /** Drop everything that has aged out (opportunistic — TTL already hides them). */
  prune(): void {
    const now = Date.now()
    this.mutate((agents) => {
      for (const [id, e] of Object.entries(agents)) {
        if (now - (e?.last_seen || 0) > this.staleMs) delete agents[id]
      }
    })
  }
}

/** Process-wide default registry (the /tmp/tiny one). */
export const registry = new MeshRegistry()

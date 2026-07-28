/**
 * Tool mount filter (extracted from the chat route) — applies a user's
 * manage_tools disable list at agent-assembly time.
 *
 * Two invariants this protects:
 *  - protected recovery tools can NEVER be filtered out (the agent must
 *    always be able to re-enable things / manage its own context), even if
 *    a stale pref names one
 *  - a user's disable choice for any other tool is honored exactly
 */

// Tools the agent must always retain so it can never brick itself.
export const PROTECTED_TOOLS: string[] = [
  'manage_tools', 'manage_messages', 'learn', 'unlearn', 'recall',
  'create_tool', 'remove_tool', 'marketplace',
]

/**
 * Coerce a candidate tool name to Strands' registry rule
 * (`^[a-zA-Z0-9_-]{1,64}$`), or null if nothing usable remains.
 *
 * Dynamic tools take their name from RETRIEVED tinys' OpenAPI
 * operationIds — hand-written specs routinely contain spaces, slashes,
 * dots, or unicode, any of which makes the ToolRegistry THROW at mount
 * time and crash the whole chat turn. Sanitize (or drop) instead.
 */
export function sanitizeToolName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return /^[a-zA-Z0-9_-]+$/.test(cleaned) ? cleaned : null
}

/** Parse the comma-separated `disabled_tools` pref into an effective set,
 *  with protected tools stripped out (they can't be disabled). */
export function parseDisabledTools(raw: string | null | undefined): Set<string> {
  const protectedSet = new Set<string>(PROTECTED_TOOLS)
  return new Set(
    String(raw || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => !protectedSet.has(t))
  )
}

/** Drop disabled tools from a mount list (matched by `.name`). */
export function filterTools<T extends { name: string }>(tools: T[], disabled: Set<string>): T[] {
  return tools.filter((t) => !disabled.has(t.name))
}

/**
 * Deduplicate a mount list by tool name, FIRST occurrence wins.
 *
 * The Strands ToolRegistry throws on a duplicate name, so a single
 * collision crashes the whole chat turn. Dynamic tools are built from
 * user-controlled OpenAPI operationIds on RETRIEVED universe tinys — a
 * public tiny publishing a skill named e.g. `learn` or `http` would
 * otherwise DoS every user whose query surfaces it. Ordering built-ins
 * before dynamic/MCP tools means built-ins always survive; later
 * collisions are dropped instead of throwing. Nameless entries (MCP
 * clients expose tools lazily) pass through untouched.
 */
export function dedupeToolsByName<T>(tools: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const t of tools) {
    const name = (t as any)?.name
    if (typeof name !== 'string') { out.push(t); continue }
    if (seen.has(name)) continue
    seen.add(name)
    out.push(t)
  }
  return out
}

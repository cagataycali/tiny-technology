/**
 * 🧩 use_mcp — every MCP server this machine is already configured for, as a tool.
 *
 * tiny-tech has always been an MCP *server* (src/server.ts: 34 platform tools +
 * 25 device tools). It has never been an MCP *client*, so the whole ecosystem —
 * the servers the user already wired into Claude Desktop, Claude Code, Cursor —
 * was unreachable from inside a tiny conversation. devduck reads MCP servers
 * (devduck/__init__.py `_load_mcp_servers`) and this is that ability, tiny-shaped
 * and measured against it:
 *
 *   devduck                                  │ here
 *   ─────────────────────────────────────────┼──────────────────────────────────
 *   MCP_SERVERS env var only                 │ that, PLUS ~/.tiny/mcp.json,
 *                                            │ ./.mcp.json, ~/.claude.json
 *                                            │ (global AND this project),
 *                                            │ Claude Desktop, ~/.cursor/mcp.json
 *                                            │ → 10 servers on this Mac vs 0
 *   every server spawns at agent construction│ connected on first use, cached,
 *                                            │ dropped after 5 min idle
 *   transport guessed from "/sse" in the URL  │ the config's own `type` field
 *                                            │ first (every real config here has
 *                                            │ one), that heuristic only as a
 *                                            │ fallback
 *   a server that won't start is a log line   │ its stderr comes back IN the
 *                                            │ error, which is where "uvx: not
 *                                            │ found" actually needs to be
 *   no way to ask what is out there           │ servers / tools / resources
 *
 * ── the shape of a config ───────────────────────────────────────────────────
 * Measured from the 10 real definitions on this Mac (~/.claude.json):
 *   { "type": "stdio", "command": "uvx", "args": ["strands-radio"], "env": {} }
 * and the two remote forms:
 *   { "type": "sse",  "url": "https://…/sse", "headers": { … } }
 *   { "type": "http", "url": "https://…/mcp" }
 * `env: {}` is safe in both SDKs — each MERGES the config env over the safe
 * inherited set (HOME LOGNAME PATH SHELL TERM USER), so an empty object does
 * not strip PATH from the child. Checked in both implementations before relying
 * on it (@modelcontextprotocol/sdk client/stdio.js:66, python mcp
 * client/stdio/__init__.py:127) because the failure — every stdio server dying
 * with "command not found" — would look like a broken tool, not a config bug.
 *
 * ── knobs ───────────────────────────────────────────────────────────────────
 *   TINY_MCP_CLIENT=0             don't mount this tool at all
 *   TINY_MCP_CONNECT_TIMEOUT_MS   default 60000 (a cold uvx server downloads)
 *   TINY_MCP_CALL_TIMEOUT_MS      default 120000, per call/list/read
 *   TINY_HOME                     where ~/.tiny/mcp.json is looked for
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ── the config surface ──────────────────────────────────────────────────────

export type McpTransport = 'stdio' | 'sse' | 'http'

export interface McpServerDef {
  name: string
  transport: McpTransport
  /** Where this definition was found — shown to the user, never guessed. */
  source: string
  /** Deliberately switched off in the config; kept so `servers` can say so. */
  disabled?: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/** Spellings of the streamable-HTTP transport seen in real configs. */
const HTTP_TYPES = ['http', 'streamable-http', 'streamablehttp', 'streamable_http']

const asStrings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => String(x)) : undefined

const asStringMap = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val !== null && val !== undefined && typeof val !== 'object') out[k] = String(val)
  }
  return out
}

/**
 * Read one entry of an `mcpServers` map.
 *
 * The config's own `type` wins over any guessing, because every one of the 10
 * definitions on this Mac carries it and guessing gets remote servers wrong:
 * devduck decides SSE by looking for "/sse" in the URL, so an SSE endpoint
 * mounted at /events is silently opened as streamable HTTP and the connection
 * fails with a protocol error rather than a config error.
 *
 * A bad entry comes back as a reason rather than being dropped: a server the
 * user believes they configured and cannot see is the worst outcome here.
 */
export function parseServerDef(
  name: string,
  raw: unknown,
  source: string,
): { def: McpServerDef } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${name}: not an object` }
  const r = raw as Record<string, unknown>
  const declared = String(r.type ?? r.transport ?? '').trim().toLowerCase()
  const command = typeof r.command === 'string' ? r.command.trim() : ''
  const url = typeof r.url === 'string' ? r.url.trim() : ''
  // Cursor and Claude Desktop both write this when a server is toggled off.
  const disabled = r.disabled === true || r.enabled === false

  let transport: McpTransport
  if (declared === 'stdio') transport = 'stdio'
  else if (declared === 'sse') transport = 'sse'
  else if (HTTP_TYPES.includes(declared)) transport = 'http'
  else if (declared) return { error: `${name}: unknown type "${declared}" (stdio, sse, http)` }
  else if (command) transport = 'stdio'
  else if (url) transport = url.includes('/sse') ? 'sse' : 'http'
  else return { error: `${name}: no command and no url` }

  if (transport === 'stdio') {
    if (!command) return { error: `${name}: stdio needs a command` }
    return {
      def: {
        name, transport, source, ...(disabled ? { disabled } : {}),
        command,
        ...(asStrings(r.args) ? { args: asStrings(r.args) } : {}),
        ...(asStringMap(r.env) ? { env: asStringMap(r.env) } : {}),
      },
    }
  }
  if (!url) return { error: `${name}: ${transport} needs a url` }
  return {
    def: {
      name, transport, source, ...(disabled ? { disabled } : {}),
      url,
      ...(asStringMap(r.headers) ? { headers: asStringMap(r.headers) } : {}),
    },
  }
}

/**
 * Pull the `mcpServers` maps out of one config file's text.
 *
 * Two things make this more than JSON.parse. Claude Code's ~/.claude.json keeps
 * PER-PROJECT servers under projects[<dir>].mcpServers as well as global ones
 * (measured here: 9 global, 1 belonging to /Users/cagatay/tinyai-id), and the
 * project's own must rank ABOVE the global one of the same name — so this
 * returns a LIST of maps in precedence order, not one merged map. And a
 * hand-written ~/.tiny/mcp.json is allowed to be the bare map itself: the
 * wrapper key is a client convention, not something a person editing a file for
 * this tool should have to know.
 */
export function serverMapsFrom(
  source: string,
  text: string | undefined,
  projectDirs?: string[],
): { maps: { source: string; servers: Record<string, unknown> }[]; problem?: string } {
  if (!text || !text.trim()) return { maps: [] }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (e: any) {
    return { maps: [], problem: `${source}: unreadable JSON (${String(e?.message || e).split('\n')[0]})` }
  }
  if (!parsed || typeof parsed !== 'object') return { maps: [], problem: `${source}: not a JSON object` }

  const maps: { source: string; servers: Record<string, unknown> }[] = []
  // Nearest directory first: a server configured for this repo outranks one
  // configured for the directory above it, which outranks the global map.
  for (const dir of projectDirs || []) {
    const project = parsed.projects?.[dir]?.mcpServers
    if (project && typeof project === 'object' && Object.keys(project).length) {
      maps.push({ source: `${source} (project ${dir})`, servers: project })
    }
  }
  if (parsed.mcpServers && typeof parsed.mcpServers === 'object') maps.push({ source, servers: parsed.mcpServers })
  // A bare map, only when nothing above matched and it actually looks like one —
  // every value carrying a command or a url. Without that check a file with one
  // unrelated key would be reported as a broken server named after it.
  if (!maps.length) {
    const values = Object.values(parsed)
    const looksLikeServers = values.length > 0 && values.every(
      (v: any) => v && typeof v === 'object' && (typeof v.command === 'string' || typeof v.url === 'string'),
    )
    if (looksLikeServers) maps.push({ source, servers: parsed as Record<string, unknown> })
    else return { maps: [], problem: `${source}: no "mcpServers" object` }
  }
  return { maps }
}

/**
 * Merge every source into one list, first mention winning.
 *
 * Shadowed duplicates are recorded rather than dropped silently, because the
 * whole point of reading six places is that the user does not have to remember
 * which one a name came from — and "why is this server using the wrong token"
 * is answerable only if the losing definition is visible.
 */
export function collectServers(
  maps: { source: string; servers: Record<string, unknown> }[],
): { servers: McpServerDef[]; problems: string[]; shadowed: { name: string; source: string }[] } {
  const servers: McpServerDef[] = []
  const problems: string[] = []
  const shadowed: { name: string; source: string }[] = []
  const seen = new Set<string>()
  for (const map of maps) {
    for (const [name, raw] of Object.entries(map.servers || {})) {
      if (seen.has(name)) {
        shadowed.push({ name, source: map.source })
        continue
      }
      const r = parseServerDef(name, raw, map.source)
      if ('error' in r) {
        problems.push(`${map.source} → ${r.error}`)
        continue
      }
      seen.add(name)
      servers.push(r.def)
    }
  }
  return { servers, problems, shadowed }
}

/**
 * This directory and the ones above it, nearest first.
 *
 * Claude Code keys its per-project servers by the EXACT project root, so a tiny
 * running in a subdirectory of that project — src/, or a package inside a
 * monorepo — would find none of them if only cwd were checked. That is how the
 * one project-scoped server on this Mac (keyed /Users/cagatay/tinyai-id, while
 * this repo sits at tiny-tech/ inside it) went missing on the first run.
 */
export function projectChain(cwd: string): string[] {
  const out: string[] = []
  let dir = cwd
  // Stop at the filesystem root, where dirname() becomes a fixed point.
  for (let i = 0; i < 64; i++) {
    out.push(dir)
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return out
}

/**
 * The files worth reading, in precedence order.
 *
 * MCP_SERVERS first because it is the most explicit thing a caller can do (and
 * it is devduck's only channel, so a devduck config keeps working verbatim),
 * then tiny's own file, then the project, then the editors' — nearest and most
 * intentional wins. Claude Desktop's path is macOS-only; on Linux the same file
 * lives under ~/.config, and both are listed rather than branching on platform
 * because a missing file costs one failed stat.
 */
export function configSources(env: NodeJS.ProcessEnv, home: string, cwd: string): {
  source: string
  /** null for the env var, which is read as text rather than from disk. */
  path: string | null
  text?: string
  projectDirs?: string[]
}[] {
  const tinyHome = env.TINY_HOME || join(home, '.tiny')
  return [
    { source: 'MCP_SERVERS', path: null, text: env.MCP_SERVERS },
    { source: '~/.tiny/mcp.json', path: join(tinyHome, 'mcp.json') },
    { source: './.mcp.json', path: join(cwd, '.mcp.json') },
    { source: '~/.claude.json', path: join(home, '.claude.json'), projectDirs: projectChain(cwd) },
    { source: 'Claude Desktop', path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') },
    { source: 'Claude Desktop', path: join(home, '.config', 'Claude', 'claude_desktop_config.json') },
    { source: '~/.cursor/mcp.json', path: join(home, '.cursor', 'mcp.json') },
    { source: '~/.codeium/windsurf/mcp_config.json', path: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  ]
}

/** Everything configured on this machine, with where each entry came from. */
export function discover(opts: { env?: NodeJS.ProcessEnv; home?: string; cwd?: string } = {}) {
  const env = opts.env || process.env
  const home = opts.home || homedir()
  const cwd = opts.cwd || process.cwd()
  const maps: { source: string; servers: Record<string, unknown> }[] = []
  const problems: string[] = []
  for (const s of configSources(env, home, cwd)) {
    let text = s.text
    if (s.path) {
      try {
        text = fs.readFileSync(s.path, 'utf8')
      } catch {
        continue // absent or unreadable — the normal case for most of these
      }
    }
    const r = serverMapsFrom(s.source, text, s.projectDirs)
    if (r.problem) problems.push(r.problem)
    maps.push(...r.maps)
  }
  const merged = collectServers(maps)
  return { ...merged, problems: [...problems, ...merged.problems] }
}

/**
 * Whether to register the tool at all.
 *
 * Gated on a server being configured SOMEWHERE, because a tool whose every
 * answer is "nothing is configured" is a paragraph of prompt buying nothing —
 * the same rule the rest of device-tools.ts follows. Costs six failed stats and
 * one 29 KB parse (0.2ms measured) at boot; TINY_MCP_CLIENT=0 skips it.
 */
export function hasMcp(): boolean {
  if (process.env.TINY_MCP_CLIENT === '0') return false
  try {
    return discover().servers.some((s) => !s.disabled)
  } catch {
    return false
  }
}

// ── talking to a server ─────────────────────────────────────────────────────

/**
 * How long to wait for a server to come up.
 *
 * A cold `uvx` server downloads its package on first run, which is why this is
 * not the 5s a local process would need.
 */
export const CONNECT_TIMEOUT_MS = 60_000
/** How long to wait for one tool call before giving up on it. */
export const CALL_TIMEOUT_MS = 120_000
/**
 * How long a connected server is kept.
 *
 * Connections are cached because a stdio server costs a process spawn (and, for
 * uvx, an environment resolve) per connect — paying that on every call would
 * make three questions about the same server three times as slow. Dropped after
 * five idle minutes so a long-lived daemon does not hold ten child processes it
 * stopped using.
 */
export const IDLE_MS = 5 * 60_000

/**
 * The two deadlines, overridable per machine.
 *
 * Same lever the device bridge already exposes (TINY_MCP_DEVICE_TIMEOUT_MS):
 * whoever hits a legitimately slow server can say so, and junk or a zero falls
 * back rather than making every call fail instantly. It is also the only way to
 * TEST the deadlines — nothing else here can make 60 seconds pass.
 */
function envTimeout(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
export const connectTimeout = (env: NodeJS.ProcessEnv = process.env): number =>
  envTimeout(env.TINY_MCP_CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
export const callTimeout = (env: NodeJS.ProcessEnv = process.env): number =>
  envTimeout(env.TINY_MCP_CALL_TIMEOUT_MS, CALL_TIMEOUT_MS)

interface Live {
  client: any
  transport: any
  /** The child's stderr, kept so a failure can quote it. */
  stderr: string[]
  timer?: ReturnType<typeof setTimeout>
  def: McpServerDef
}

const live = new Map<string, Live>()

/** Human-readable, and identical for the same definition — cache key. */
export function serverKey(def: McpServerDef): string {
  return def.transport === 'stdio'
    ? `${def.name}|stdio|${def.command} ${(def.args || []).join(' ')}`
    : `${def.name}|${def.transport}|${def.url}`
}

function touch(key: string, l: Live) {
  clearTimeout(l.timer)
  l.timer = setTimeout(() => {
    live.delete(key)
    l.client?.close?.().catch(() => {})
  }, IDLE_MS)
  // Unref'd: an idle connection must never be the reason a CLI refuses to exit.
  l.timer.unref?.()
}

/**
 * Hang up — everything, or one server by name.
 *
 * Returns the names it actually closed rather than the ones asked for, so
 * "close X" when X was never connected says so instead of claiming success.
 */
export async function closeAll(only?: string): Promise<string[]> {
  const want = (only || '').trim().toLowerCase()
  const closed: string[] = []
  for (const [key, l] of [...live]) {
    if (want && l.def.name.toLowerCase() !== want) continue
    clearTimeout(l.timer)
    live.delete(key)
    closed.push(l.def.name)
    await closeQuietly(l.client, l.def.name)
  }
  return closed
}

/** How long a hang-up gets. The SDK's own close already races 2s internally. */
export const CLOSE_TIMEOUT_MS = 2_000

/**
 * Close one client, and come back either way.
 *
 * The deadline is not paranoia about a slow server: unhold() below unrefs the
 * child and its pipes, so while awaiting a close there may be NOTHING keeping
 * this event loop alive, and the promise would simply never settle (node's test
 * runner calls that "the event loop has already resolved" and cancels the rest
 * of the file — which is how this was found). withTimeout's timer is referenced,
 * so it holds the loop for exactly as long as the hang-up may take.
 */
async function closeQuietly(client: any, name: string): Promise<void> {
  try {
    await withTimeout(`closing ${name}`, CLOSE_TIMEOUT_MS, Promise.resolve(client?.close?.()))
  } catch { /* a server that is already gone is closed enough */ }
}

/** How many servers are connected right now — for tests and the idle rule. */
export function liveCount(): number {
  return live.size
}

async function withTimeout<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        // Sub-second deadlines exist (tests, and an impatient TINY_MCP_*_MS):
        // "timed out after 0s" reads like a bug in the tool.
        const waited = ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${waited}`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Connect (or reuse a connection) to one server.
 *
 * stdio stderr is PIPED rather than inherited for two reasons: a child writing
 * to our stderr corrupts nothing but confuses everything when tiny runs as an
 * MCP server itself, and the text is the only useful diagnostic a failed server
 * produces — "uvx: command not found" belongs in the tool's answer, not in a
 * log the model cannot read.
 */
export async function connect(def: McpServerDef): Promise<Live> {
  const key = serverKey(def)
  const existing = live.get(key)
  if (existing) {
    touch(key, existing)
    return existing
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const stderr: string[] = []
  let transport: any
  if (def.transport === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    transport = new StdioClientTransport({
      command: def.command!,
      args: def.args || [],
      ...(def.env ? { env: def.env } : {}),
      stderr: 'pipe',
    })
  } else if (def.transport === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    transport = new SSEClientTransport(new URL(def.url!), def.headers
      ? { requestInit: { headers: def.headers }, eventSourceInit: { headers: def.headers } as any }
      : undefined)
  } else {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    transport = new StreamableHTTPClientTransport(new URL(def.url!), def.headers
      ? { requestInit: { headers: def.headers } }
      : undefined)
  }

  const client = new Client({ name: 'tiny-tech', version: '1' }, { capabilities: {} })
  const l: Live = { client, transport, stderr, def }
  try {
    await withTimeout(`connecting to ${def.name}`, connectTimeout(), client.connect(transport))
  } catch (e: any) {
    // Read the child's own complaint before throwing ours away.
    const said = readStderr(transport, stderr)
    await closeQuietly(client, def.name)
    throw new Error(`${def.name} would not start: ${String(e?.message || e)}${said ? `\n   it said: ${said}` : ''}`)
  }
  if (transport?.stderr?.on) {
    transport.stderr.on('data', (d: Buffer) => {
      stderr.push(String(d))
      if (stderr.length > 50) stderr.shift() // a chatty server must not grow forever
    })
  }
  unhold(transport)
  live.set(key, l)
  touch(key, l)
  return l
}

/**
 * Stop a connected server from holding this process open.
 *
 * `tiny "some question"` answers and returns; main() never calls process.exit,
 * so anything with a referenced handle wedges the CLI at 0% CPU forever — and a
 * spawned MCP server is exactly that: a child plus three pipes. Unref'ing them
 * is safe because every request here is wrapped in withTimeout, whose (still
 * referenced) timer keeps the loop alive for as long as an answer is owed. So
 * during a call nothing changes; the moment the conversation is over, the
 * process is free to exit and the children are reaped with it.
 *
 * Reaches through the transport for the child because the SDK keeps it private
 * and exposes no unref — hence the optional calls at every step, so a future
 * SDK that renames the field costs a lingering handle, not a crash.
 */
function unhold(transport: any): void {
  const child = transport?._process
  child?.unref?.()
  for (const s of [child?.stdin, child?.stdout, child?.stderr]) s?.unref?.()
}

/**
 * Whatever the child said on stderr, best effort.
 *
 * A stdio server that dies during startup usually explains itself there and
 * then exits, and the SDK's own error ("MCP error -32000: Connection closed")
 * says nothing. The stream is read synchronously because by the time connect()
 * has rejected the process is already gone: no more 'data' events are coming.
 */
export function readStderr(transport: any, buffered: string[]): string {
  const parts = [...buffered]
  try {
    const chunk = transport?.stderr?.read?.()
    if (chunk) parts.push(String(chunk))
  } catch { /* not piped, or already closed */ }
  return parts.join('').trim().split('\n').slice(-6).join('\n   ').trim()
}

// ── formatting ──────────────────────────────────────────────────────────────

export function formatServers(d: {
  servers: McpServerDef[]
  problems: string[]
  shadowed: { name: string; source: string }[]
}): string {
  const lines: string[] = []
  const usable = d.servers.filter((s) => !s.disabled)
  lines.push(`🧩 ${usable.length} MCP server${usable.length === 1 ? '' : 's'} configured on this machine`)
  for (const s of d.servers) {
    const what = s.transport === 'stdio' ? `${s.command} ${(s.args || []).join(' ')}`.trim() : s.url
    lines.push(`   ${s.disabled ? '⏸' : '•'} ${s.name}  ${s.transport}  ${what}`)
    lines.push(`     from ${s.source}${s.disabled ? ' — disabled in that config' : ''}`)
  }
  if (!d.servers.length) {
    lines.push('   nothing found. Add one to ~/.tiny/mcp.json:')
    lines.push('     { "mcpServers": { "name": { "command": "uvx", "args": ["some-mcp-server"] } } }')
  }
  for (const s of d.shadowed) lines.push(`   ⚠ ${s.name} in ${s.source} is shadowed by the one above`)
  for (const p of d.problems) lines.push(`   ⚠ ${p}`)
  if (usable.length) lines.push(`   → use_mcp action="tools" server="${usable[0].name}" to see what it offers`)
  return lines.join('\n')
}

export function formatTools(server: string, tools: any[]): string {
  if (!tools.length) return `🧩 ${server} exposes no tools`
  const lines = [`🧩 ${server} — ${tools.length} tool${tools.length === 1 ? '' : 's'}`]
  for (const t of tools) {
    const args = Object.keys(t?.inputSchema?.properties || {})
    const required: string[] = Array.isArray(t?.inputSchema?.required) ? t.inputSchema.required : []
    const shown = args.map((a) => (required.includes(a) ? `${a}*` : a)).join(', ')
    lines.push(`   • ${t.name}(${shown})`)
    const first = String(t.description || '').split('\n')[0].trim()
    // One line each: a server with 70 tools would otherwise bury the list, and
    // the model can ask for the full description by calling it wrong once.
    if (first) lines.push(`     ${first.length > 160 ? `${first.slice(0, 157)}…` : first}`)
  }
  lines.push('   * = required. Call one: use_mcp action="call" server="…" tool="…" args=\'{"k":"v"}\'')
  return lines.join('\n')
}

/**
 * Flatten a tool result into text.
 *
 * A server may answer with text, an image, an embedded resource, or structured
 * content, and `isError` is a FIELD rather than an exception — a client that
 * only reads content[].text reports a failed call as a successful empty one.
 */
export function formatCall(server: string, toolName: string, result: any): string {
  const blocks: any[] = Array.isArray(result?.content) ? result.content : []
  const parts: string[] = []
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b?.type === 'image') parts.push(`[image ${b.mimeType || 'unknown'}, ${Math.round(String(b.data || '').length * 0.75 / 1024)} KB]`)
    else if (b?.type === 'resource') parts.push(b.resource?.text || `[resource ${b.resource?.uri || ''}]`)
    else if (b?.type === 'resource_link') parts.push(`[resource ${b.uri || ''}]`)
    else if (b) parts.push(JSON.stringify(b))
  }
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2))
  const body = parts.join('\n').trim()
  if (result?.isError) return `❌ ${server}.${toolName} failed: ${body || 'no detail given'}`
  return body || `✅ ${server}.${toolName} returned nothing`
}

export function formatResources(server: string, resources: any[]): string {
  if (!resources.length) return `🧩 ${server} exposes no resources`
  const lines = [`🧩 ${server} — ${resources.length} resource${resources.length === 1 ? '' : 's'}`]
  for (const r of resources) {
    lines.push(`   • ${r.uri}${r.name ? `  ${r.name}` : ''}${r.mimeType ? `  (${r.mimeType})` : ''}`)
    const d = String(r.description || '').split('\n')[0].trim()
    if (d) lines.push(`     ${d}`)
  }
  lines.push('   Read one: use_mcp action="read" server="…" uri="…"')
  return lines.join('\n')
}

export function formatRead(server: string, uri: string, contents: any[]): string {
  if (!contents.length) return `🧩 ${server} returned nothing for ${uri}`
  return contents.map((c: any) => c?.text ?? `[${c?.mimeType || 'binary'} at ${c?.uri || uri}]`).join('\n')
}

// ── argument handling ───────────────────────────────────────────────────────

/**
 * The `args` string a model wrote, as an object.
 *
 * Flat input is the house rule for every device tool (strings and numbers only,
 * so any provider's function calling can express it), which means a nested MCP
 * argument object arrives as JSON in a string. Failing on it is right — the
 * alternative, calling a remote tool with silently empty arguments, produces a
 * confident wrong answer instead of a fixable error.
 */
export function parseArgs(raw: unknown): { args: Record<string, any> } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { args: {} }
  if (typeof raw === 'object' && !Array.isArray(raw)) return { args: raw as Record<string, any> }
  const text = String(raw).trim()
  if (!text) return { args: {} }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (e: any) {
    return { error: `args is not JSON (${String(e?.message || e).split('\n')[0]}) — pass a JSON object like {"path":"/tmp"}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `args must be a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}` }
  }
  return { args: parsed }
}

/**
 * Pick the server a call is about.
 *
 * "The only one" is the answer when there is exactly one, because a machine
 * with a single server should not need the model to name it. Anything else asks
 * — and lists the names, so the next call can be right.
 */
export function pickServer(servers: McpServerDef[], asked: string): { def: McpServerDef } | { error: string } {
  const usable = servers.filter((s) => !s.disabled)
  const name = asked.trim()
  if (!name) {
    if (usable.length === 1) return { def: usable[0] }
    if (!usable.length) return { error: 'no MCP servers configured — use_mcp action="servers" explains where to put one' }
    return { error: `which server? ${usable.map((s) => s.name).join(', ')}` }
  }
  const hit = usable.find((s) => s.name === name)
    || usable.find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (hit) return { def: hit }
  const off = servers.find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (off) return { error: `${off.name} is disabled in ${off.source}` }
  return { error: `no server called "${name}" — configured: ${usable.map((s) => s.name).join(', ') || 'none'}` }
}

// ── the tool ────────────────────────────────────────────────────────────────

const ACTIONS = ['servers', 'tools', 'call', 'resources', 'read', 'close', 'help'] as const

const HELP = `🧩 use_mcp — the MCP servers this machine is configured for

  servers                                  what is configured, and from where
  tools      server=…                      what that server offers
  call       server=… tool=… args='{…}'    run one of its tools
  resources  server=…                      what it exposes to read
  read       server=… uri=…                read one of those
  close      [server=…]                    hang up (connections drop after 5 idle minutes anyway)

Configuration is read from MCP_SERVERS, ~/.tiny/mcp.json, ./.mcp.json,
~/.claude.json (global and per-project), Claude Desktop and ~/.cursor/mcp.json —
the first mention of a name wins. Nothing to install: if a client on this
machine can already reach a server, so can this tool.`

export function makeMcpTool() {
  return tool({
    name: 'use_mcp',
    description: '🧩 Use any MCP server this machine is already configured for — the ones in '
      + '~/.claude.json, ./.mcp.json, Claude Desktop, Cursor or MCP_SERVERS. List them, see what '
      + 'tools and resources each offers, and call them. Servers connect on first use and are '
      + 'cached, so this reaches whole tool ecosystems (files, browsers, databases, hardware) with '
      + 'nothing to install. Actions: servers, tools, call, resources, read, close, help.',
    inputSchema: z.object({
      action: z.enum(ACTIONS).describe('start with servers'),
      server: z.string().optional().describe('which server — omit when only one is configured'),
      tool: z.string().optional().describe('the tool to call (call)'),
      args: z.string().optional().describe('JSON object of arguments for that tool, e.g. {"path":"/tmp"}'),
      uri: z.string().optional().describe('the resource to read (read)'),
    }),
    callback: async (a: any) => {
      try {
        if (a.action === 'help') return HELP

        const found = discover()
        if (a.action === 'servers') return formatServers(found)
        if (a.action === 'close') {
          const only = String(a.server ?? '').trim()
          const closed = await closeAll(only)
          if (closed.length) return `🧩 closed ${closed.join(', ')}`
          return only ? `🧩 ${only} was not connected` : '🧩 nothing was connected'
        }

        const picked = pickServer(found.servers, String(a.server ?? ''))
        if ('error' in picked) return picked.error
        const def = picked.def
        const l = await connect(def)

        switch (a.action) {
          case 'tools': {
            const r: any = await withTimeout(`${def.name} listing tools`, callTimeout(), l.client.listTools())
            return formatTools(def.name, r?.tools || [])
          }
          case 'resources': {
            const r: any = await withTimeout(`${def.name} listing resources`, callTimeout(), l.client.listResources())
            return formatResources(def.name, r?.resources || [])
          }
          case 'read': {
            const uri = String(a.uri ?? '').trim()
            if (!uri) return 'need uri — action="resources" lists them'
            const r: any = await withTimeout(`${def.name} reading ${uri}`, callTimeout(), l.client.readResource({ uri }))
            return formatRead(def.name, uri, r?.contents || [])
          }
          case 'call': {
            const name = String(a.tool ?? '').trim()
            if (!name) return `need tool — action="tools" server="${def.name}" lists them`
            const parsed = parseArgs(a.args)
            if ('error' in parsed) return parsed.error
            const r: any = await withTimeout(
              `${def.name}.${name}`, callTimeout(),
              l.client.callTool({ name, arguments: parsed.args }),
            )
            return formatCall(def.name, name, r)
          }
          default:
            return `unknown action: ${a.action}`
        }
      } catch (e: any) {
        // Never throws: the house contract for every device tool. A server that
        // died mid-call is a fact the model can act on, not a crash.
        const said = String(e?.message || e)
        return `❌ ${said}`
      }
    },
  })
}

/**
 * 🔧 Local tool hot-load — the user's OWN tools, written on their machine, in
 * the daemon's tool list within one `use_tools reload` (loop item d-f).
 *
 * tiny already has a forge: `my_*` tools created with tiny_create_tool. Those
 * run in the WORKER sandbox — 10s, 4KB out, fetch-only, no filesystem, no
 * binaries, no local network. That's the right box for something the cloud
 * agent runs on anyone's behalf, and it's the wrong box for "read my work
 * calendar out of this SQLite file", "poke the 3D printer on my LAN", "run our
 * deploy script". Those are exactly the tools that only make sense ON this
 * machine, so they belong to this process, and nothing about them should have
 * to travel to a server first.
 *
 * A file in the tools dir becomes a tool. That's the whole contract.
 *
 * ── where the files live, and why NOT `src/tools/` ──────────────────────────
 * The gaps report says "`src/tools/` dir already exists (empty)" and it's the
 * wrong home: tiny-tech is installed with npx/npm -g, so `src/` sits inside
 * node_modules — it is wiped by the next `npm i -g tiny-tech@latest`, may be
 * read-only, and is not a place a person keeps their own work. User state in
 * this codebase lives in ~/.tiny (device.json, integrations.json, history), and
 * user tools are user state. So: `~/.tiny/tools/`, overridable with
 * TINY_TOOLS_DIR for a project-scoped set.
 *
 * ── the contract is a PLAIN OBJECT, and that's forced ──────────────────────
 * The obvious design is "export a Strands tool: `export default tool({...})`".
 * It cannot work. `import { tool } from '@strands-agents/sdk'` from a file in
 * the user's home directory resolves against THEIR node_modules, and the SDK is
 * a dependency of tiny-tech, not of ~/.tiny — so the import throws before the
 * tool exists. The primary contract is therefore a plain object that needs no
 * imports at all, and this loader supplies the SDK wrapper:
 *
 *   // ~/.tiny/tools/printer.mjs
 *   export default {
 *     name: 'printer_status',
 *     description: 'Bambu printer state on my LAN.',
 *     inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } },
 *     async handler({ verbose }) { return await check(verbose) },
 *   }
 *
 * A real `tool()` instance is still accepted (a project-scoped dir CAN reach
 * the SDK), as is an array or a named `tools` export — anything that already
 * has `.name` + `.stream` passes through untouched.
 *
 * ── what must not happen ───────────────────────────────────────────────────
 *  - **A misnamed file must not cost the user every other tool.** The SDK's
 *    ToolRegistry THROWS on a duplicate name — and also on one differing only
 *    by `-` vs `_` — and it throws inside the Agent constructor. So a tool
 *    named `use_google` (or `use-google`) would abort init, and the daemon
 *    would come up with NO tools at all because one file was named badly.
 *    Collisions are resolved here, before the Agent exists, by skipping the
 *    local tool and saying which name it lost to. Builtins always win: the
 *    alternative is a file in a directory silently shadowing tiny_send_message.
 *  - **A broken file must not cost the working ones.** Every file is imported
 *    inside its own try/catch; a syntax error loses that file and nothing else.
 *  - **A hanging tool must not hang the turn forever.** User code runs inside
 *    the agent's turn, which a relay envelope is waiting on, so each call is
 *    raced against a timeout and reports the timeout as a result.
 *  - **A thrown tool must not abort the turn.** Same rule the rest of the
 *    device tools follow: return the failure as text so the model can adapt.
 *
 * ── reload actually reloads ─────────────────────────────────────────────────
 * `import()` caches by specifier, so re-importing an edited file yields the OLD
 * module for the life of the process — a "hot-load" that silently never loads
 * anything twice. The specifier carries the file's mtime, which makes an edited
 * file a different module and an UNCHANGED file the same one (so module-level
 * state — an open connection, a warmed cache — survives a reload that didn't
 * touch it). And it's a `file://` URL, not a bare path: on Windows `C:\...` is
 * not a legal import specifier.
 *
 * Local tools exist only in local-model mode; in server mode there is no local
 * agent to hold them (see TinyAgent.init).
 */
import { tool } from '@strands-agents/sdk'
import { readdirSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Where a user's tool files live. TINY_TOOLS_DIR overrides for project scope. */
export function localToolsDir(): string {
  if (process.env.TINY_TOOLS_DIR) return process.env.TINY_TOOLS_DIR
  const home = process.env.TINY_HOME || join(homedir(), '.tiny')
  return join(home, 'tools')
}

/**
 * How long one local tool call may take. The turn holding it may be a relay
 * envelope with a waiting web agent on the other end (use_device waits 45s),
 * so an unbounded call doesn't just hang here — it burns the asker's budget
 * and produces nothing. A module may raise it deliberately.
 */
export const LOCAL_TOOL_TIMEOUT_MS = 60_000

/**
 * Cap on a local tool's output. The result travels into the model's context and
 * possibly across the relay (clamped again at 8KB there). Clamping here means
 * the agent is TOLD it got a prefix instead of silently reasoning over one.
 */
export const LOCAL_TOOL_OUTPUT_MAX = 20_000

/** Extensions node can import from an ESM package without a loader. */
const LOADABLE = ['.mjs', '.js', '.cjs']

/**
 * Which files in the dir are candidates. `_`-prefixed and dotfiles are shared
 * helpers a user will want to keep beside their tools without each becoming a
 * tool; `.d.ts`/`.map` are build residue.
 */
export function isLoadableFile(name: string): boolean {
  if (!name || name.startsWith('.') || name.startsWith('_')) return false
  if (name.endsWith('.d.ts') || name.endsWith('.map')) return false
  return LOADABLE.some((e) => name.endsWith(e))
}

/**
 * Why a file was passed over. `.ts` earns its own sentence because it's the
 * mistake a developer makes first and node's own error for it ("Unknown file
 * extension") explains nothing about what to do instead.
 */
export function skipReasonForFile(name: string): string | null {
  if (!isLoadableFile(name)) {
    if (name.endsWith('.ts')) return 'TypeScript needs compiling first — save it as .mjs (plain JS, ESM)'
    if (name.startsWith('_') || name.startsWith('.')) return null // deliberate helper/hidden file
    return null
  }
  return null
}

/** A tool the loader produced, with where it came from. */
export interface LoadedTool {
  name: string
  file: string
  description: string
  tool: any
}

export interface SkippedTool {
  file: string
  reason: string
}

export interface LocalToolsResult {
  dir: string
  tools: any[]
  loaded: LoadedTool[]
  skipped: SkippedTool[]
}

/** Does this look like an already-built Strands tool? */
function isStrandsTool(v: any): boolean {
  return Boolean(v && typeof v === 'object' && typeof v.name === 'string' && typeof v.stream === 'function')
}

/** The SDK's own name rule (ToolRegistry._validateProperties), checked early. */
export function isValidLocalToolName(name: unknown): boolean {
  return typeof name === 'string' && name.length >= 1 && name.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(name)
}

/**
 * The registry also refuses two names that differ only by `-` vs `_`, so
 * `my-tool` collides with `my_tool`. Collision detection has to use the same
 * key the registry does, or init throws on a pair this loader called distinct.
 */
export function toolNameKey(name: string): string {
  return String(name).replace(/-/g, '_').toLowerCase()
}

const clampOutput = (s: string): string =>
  s.length > LOCAL_TOOL_OUTPUT_MAX
    ? `${s.slice(0, LOCAL_TOOL_OUTPUT_MAX)}\n… [output truncated at ${LOCAL_TOOL_OUTPUT_MAX} chars]`
    : s

/** Whatever a handler returned, as something the model can read. */
export function stringifyToolResult(v: unknown): string {
  if (v == null) return '(no output)'
  if (typeof v === 'string') return clampOutput(v)
  try {
    const s = JSON.stringify(v)
    return s === undefined ? String(v) : clampOutput(s)
  } catch {
    // Cyclic or otherwise unserializable — String() always answers something.
    return clampOutput(String(v))
  }
}

/**
 * Wrap a user handler: bounded, non-throwing, string-returning.
 *
 * The timeout does not cancel the handler (nothing in Node can, for arbitrary
 * user code) — it stops the TURN waiting on it. A tool that later finishes
 * writes to nobody, which is the correct outcome for a call already reported.
 */
export function wrapHandler(
  fn: (input: any) => any,
  opts: { name: string; timeoutMs?: number } = { name: 'tool' },
): (input: any) => Promise<string> {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs as number) > 0
    ? (opts.timeoutMs as number)
    : LOCAL_TOOL_TIMEOUT_MS
  return async (input: any) => {
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        Promise.resolve(fn(input ?? {})),
        // NOT unref'd: an unref'd timer can't hold the event loop open, so a
        // handler that never settles would let a one-shot `tiny-tech "query"`
        // run exit silently instead of reporting the timeout. clearTimeout in
        // the finally is what keeps a COMPLETED call from outliving itself.
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`local tool "${opts.name}" timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
        }),
      ])
      return stringifyToolResult(result)
    } catch (e: any) {
      // A thrown tool aborts the agent's turn; a reported failure lets it adapt.
      return `local tool error (${opts.name}): ${String(e?.message || e).slice(0, 500)}`
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/**
 * Turn one module export into a registrable tool, or say why it can't be one.
 *
 * Pure: no imports, no filesystem. This is where every refusal lives, so the
 * refusals are testable without writing files.
 */
export function normalizeLocalTool(
  def: any,
  file: string,
  taken: Set<string>,
): { tool: any; name: string; description: string } | { reason: string } {
  if (isStrandsTool(def)) {
    if (!isValidLocalToolName(def.name)) return { reason: `invalid tool name ${JSON.stringify(def.name)}` }
    const key = toolNameKey(def.name)
    if (taken.has(key)) return { reason: `name "${def.name}" is already taken by a built-in tool` }
    return { tool: def, name: def.name, description: String(def.description || '') }
  }

  if (!def || typeof def !== 'object') {
    return { reason: 'export default must be an object { name, description, handler } (or an array of them)' }
  }
  if (!isValidLocalToolName(def.name)) {
    return { reason: `invalid or missing name ${JSON.stringify(def.name)} — 1-64 chars, letters/digits/_/-` }
  }
  const description = typeof def.description === 'string' ? def.description.trim() : ''
  if (!description) {
    // The description is not decoration: it's the only thing that tells the
    // model when to reach for this tool. An undescribed tool is never called.
    return { reason: `tool "${def.name}" needs a description — it's how the model knows when to use it` }
  }
  const fn = typeof def.handler === 'function' ? def.handler
    : typeof def.callback === 'function' ? def.callback
    : typeof def.run === 'function' ? def.run
    : null
  if (!fn) return { reason: `tool "${def.name}" needs a handler(input) function` }

  const key = toolNameKey(def.name)
  if (taken.has(key)) return { reason: `name "${def.name}" is already taken by a built-in tool` }

  if (def.inputSchema != null && typeof def.inputSchema !== 'object') {
    return { reason: `tool "${def.name}" inputSchema must be a JSON Schema object` }
  }

  // inputSchema is passed through untouched: the SDK's tool() factory decides
  // at RUNTIME whether it got a zod schema or a JSON schema, so a project-local
  // dir that can import zod gets validation for free and a home dir that can't
  // gets plain JSON Schema. No branch needed here.
  const built = tool({
    name: def.name,
    description,
    ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
    callback: wrapHandler(fn.bind(def), { name: def.name, timeoutMs: def.timeoutMs }),
  } as any)

  return { tool: built, name: def.name, description }
}

/** Every tool a module offers: default export, `tools` export, or an array of either. */
export function collectDefinitions(mod: any): any[] {
  const out: any[] = []
  const push = (v: any) => {
    if (Array.isArray(v)) out.push(...v)
    else if (v != null) out.push(v)
  }
  push(mod?.default)
  if (mod?.tools !== mod?.default) push(mod?.tools)
  // A module with neither is still worth reporting on, so return empty rather
  // than guessing at other exports (a `helper` export is not a tool).
  return out
}

/** The candidate files in a dir, sorted so load order is stable across machines. */
export function listToolFiles(dir: string): { files: string[]; skipped: SkippedTool[] } {
  const skipped: SkippedTool[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return { files: [], skipped }
  }
  const files: string[] = []
  for (const name of entries.sort()) {
    let isFile = false
    try {
      isFile = statSync(join(dir, name)).isFile()
    } catch {
      continue
    }
    if (!isFile) continue
    if (isLoadableFile(name)) { files.push(name); continue }
    const reason = skipReasonForFile(name)
    if (reason) skipped.push({ file: name, reason })
  }
  return { files, skipped }
}

/**
 * Load every tool in the dir.
 *
 * `reserved` is the set of names already registered (builtins, and on a reload
 * the other local tools) — a local tool never wins a collision, because a
 * shadowed tiny_send_message is a security surprise and a shadowed use_desktop
 * is a debugging nightmare.
 */
export async function loadLocalTools(opts: { dir?: string; reserved?: string[] } = {}): Promise<LocalToolsResult> {
  const dir = opts.dir || localToolsDir()
  const taken = new Set<string>((opts.reserved || []).map(toolNameKey))
  const { files, skipped } = listToolFiles(dir)
  const loaded: LoadedTool[] = []
  const tools: any[] = []

  for (const file of files) {
    const full = join(dir, file)
    let mod: any
    try {
      // mtime in the specifier: an edited file is a new module, an unchanged
      // one is the same module (keeping any warmed module-level state).
      let stamp = 0
      try { stamp = statSync(full).mtimeMs } catch { /* raced deletion — import will report it */ }
      mod = await import(`${pathToFileURL(full).href}?v=${stamp}`)
    } catch (e: any) {
      skipped.push({ file, reason: `import failed: ${String(e?.message || e).slice(0, 300)}` })
      continue
    }
    const defs = collectDefinitions(mod)
    if (!defs.length) {
      skipped.push({ file, reason: 'no default export and no `tools` export' })
      continue
    }
    for (const def of defs) {
      const r = normalizeLocalTool(def, file, taken)
      if ('reason' in r) { skipped.push({ file, reason: r.reason }); continue }
      taken.add(toolNameKey(r.name))
      loaded.push({ name: r.name, file, description: r.description, tool: r.tool })
      tools.push(r.tool)
    }
  }

  return { dir, tools, loaded, skipped }
}

/** One line per outcome — printed at daemon start and returned by use_tools. */
export function summarize(r: LocalToolsResult): string {
  const lines: string[] = []
  lines.push(`🔧 local tools — ${r.dir}`)
  if (!r.loaded.length && !r.skipped.length) {
    lines.push('   (none yet — drop a .mjs file here that exports { name, description, handler })')
    return lines.join('\n')
  }
  for (const t of r.loaded) {
    const first = t.description.split('\n')[0].slice(0, 100)
    lines.push(`   ✅ ${t.name} — ${first} [${t.file}]`)
  }
  for (const s of r.skipped) lines.push(`   ⚠️  ${s.file}: ${s.reason}`)
  return lines.join('\n')
}

/** Create the dir so `open ~/.tiny/tools` works before the first tool exists. */
export function ensureToolsDir(dir: string = localToolsDir()): string {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch { /* an unwritable dir just means no local tools */ }
  return dir
}

// ── hot reload ──────────────────────────────────────────────────────────────

/** The slice of the SDK's ToolRegistry this needs — so a test can fake it. */
export interface RegistryLike {
  addOrReplace(tools: any[]): void
  remove(name: string): void
  list(): { name: string }[]
}

/**
 * Re-read the dir into a live registry.
 *
 * `previous` is what the last load registered. Names that vanished from disk
 * are REMOVED: a tool the user deleted must stop being offered, or the model
 * keeps calling a file that no longer exists. Builtins are never removed and
 * never replaced — `reserved` is enforced by loadLocalTools, so a file that
 * renames itself onto a builtin is skipped, not swapped in.
 */
export async function reloadLocalTools(
  registry: RegistryLike,
  opts: { previous?: string[]; reserved?: string[]; dir?: string } = {},
): Promise<{ result: LocalToolsResult; names: string[]; removed: string[] }> {
  const result = await loadLocalTools({ dir: opts.dir, reserved: opts.reserved })
  const names = result.loaded.map((t) => t.name)
  const kept = new Set(names)
  const removed = (opts.previous || []).filter((n) => !kept.has(n))
  for (const n of removed) registry.remove(n)
  if (result.tools.length) registry.addOrReplace(result.tools)
  return { result, names, removed }
}

export const TOOLS_DESCRIPTION = `🔧 The tools on THIS machine that the user wrote themselves (~/.tiny/tools, or TINY_TOOLS_DIR). Actions:
- list — every local tool currently loaded, plus any file that failed to load and why
- reload — re-read the directory: picks up new files, edits and deletions without restarting

Use reload right after the user adds or edits a tool file — they do not need to restart the daemon. Local tools run on this machine with full access to it (unlike forged my_* tools, which run in the cloud sandbox), so prefer them for anything touching local files, the LAN or installed binaries.`

/**
 * `use_tools` — list + hot-reload, the devduck `manage_tools` shape.
 *
 * Takes accessors rather than values because the registry and the loaded-name
 * list both change underneath it: a reload during a long session must see what
 * the PREVIOUS reload registered, not what init did.
 */
export function makeToolsTool(ctx: {
  registry: () => RegistryLike | null
  reserved: () => string[]
  previous: () => string[]
  onLoaded: (names: string[]) => void
  dir?: () => string
}) {
  return tool({
    name: 'use_tools',
    description: TOOLS_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'reload'], description: 'list or reload' } },
      required: ['action'],
    },
    callback: async (input: any) => {
      const action = String(input?.action || 'list')
      const dir = ctx.dir ? ctx.dir() : localToolsDir()
      if (action === 'list') {
        const names = ctx.previous()
        const reg = ctx.registry()
        const live = reg ? new Set(reg.list().map((t) => t.name)) : new Set<string>()
        const lines = names.map((n) => `   ${live.has(n) ? '✅' : '⚠️ '} ${n}`)
        return `🔧 local tools — ${dir}\n${lines.length ? lines.join('\n') : '   (none loaded)'}`
      }
      if (action !== 'reload') return `unknown action: ${action} (list|reload)`
      const reg = ctx.registry()
      if (!reg) return 'no live tool registry (local tools need a local model — this session proxies to the server)'
      try {
        const { result, names, removed } = await reloadLocalTools(reg, {
          previous: ctx.previous(),
          reserved: ctx.reserved(),
          dir,
        })
        ctx.onLoaded(names)
        const removedLine = removed.length ? `\n   🗑  removed: ${removed.join(', ')}` : ''
        return `${summarize(result)}${removedLine}`
      } catch (e: any) {
        return `reload failed: ${String(e?.message || e).slice(0, 300)}`
      }
    },
  })
}

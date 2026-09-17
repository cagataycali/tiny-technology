/**
 * 🛠 manage_tools — runtime tool management for long-horizon work.
 *
 * Port of devduck's manage_tools.py, COMPOSED with what already exists rather
 * than duplicating it: reload delegates to local-tools.ts (reloadLocalTools —
 * the same rail use_tools rides), create/fetch WRITE INTO ~/.tiny/tools so a
 * created tool survives restarts and shows up in use_tools, and list reads the
 * LIVE SDK ToolRegistry so dynamic tools appear next to builtins.
 *
 * The non-negotiable from the python: NO dynamic code loads without passing a
 * SANDBOX first (_sandbox_test) — a subprocess `node --input-type=module`
 * imports the candidate file, reports what it exports, and only a file that
 * imports cleanly and offers at least one valid tool definition is written to
 * the tools dir and hot-loaded. A kill switch (TINY_DISABLE_LOAD_TOOL=true)
 * refuses create/fetch/reload outright.
 */
import { tool } from '@strands-agents/sdk'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  localToolsDir, ensureToolsDir, reloadLocalTools, summarize,
  isValidLocalToolName, toolNameKey, resolveRegistries, type RegistryLike,
} from './local-tools.js'

/** The kill switch — same env name as devduck so operator habits carry over. */
export function loadToolDisabled(): boolean {
  return String(process.env.TINY_DISABLE_LOAD_TOOL || '').toLowerCase() === 'true'
}

const KILL_SWITCH_MSG = 'refused: TINY_DISABLE_LOAD_TOOL=true — dynamic tool loading is disabled on this machine'

/** github.com/u/r/blob/ref/path → raw.githubusercontent.com/u/r/ref/path. Other URLs pass through. */
export function toRawUrl(url: string): string {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`
  return url
}

/** Where a created tool lands: <name>.mjs in the tools dir. */
export function toolFilePath(name: string, dir: string = localToolsDir()): string {
  return join(dir, `${name}.mjs`)
}

export interface SandboxToolInfo {
  name?: string
  description?: string
  hasHandler: boolean
  isStrandsTool: boolean
}

export interface SandboxResult {
  ok: boolean
  output: string
  tools: SandboxToolInfo[]
}

/**
 * The child-side script: import the candidate, walk default/`tools` exports
 * (arrays flattened — same shapes local-tools.ts loads), print one JSON line.
 * Runs in ITS OWN node process so a syntax error, a top-level throw or an
 * import of something missing can never touch the live agent.
 */
const SANDBOX_SNIPPET = `
const file = process.env.TINY_SANDBOX_FILE
try {
  const mod = await import(file)
  const defs = []
  const push = (v) => Array.isArray(v) ? defs.push(...v) : (v != null && defs.push(v))
  push(mod?.default)
  if (mod?.tools !== mod?.default) push(mod?.tools)
  const tools = defs.map((d) => ({
    name: typeof d?.name === 'string' ? d.name : undefined,
    description: typeof d?.description === 'string' ? d.description.slice(0, 200) : undefined,
    hasHandler: ['handler', 'callback', 'run'].some((k) => typeof d?.[k] === 'function'),
    isStrandsTool: typeof d?.stream === 'function' && typeof d?.name === 'string',
  }))
  console.log('TINY_SANDBOX_RESULT ' + JSON.stringify({ ok: true, tools }))
} catch (e) {
  console.log('TINY_SANDBOX_RESULT ' + JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 500), tools: [] }))
}
`

/**
 * Validate tool source in an isolated subprocess BEFORE it may load.
 * Port of _sandbox_test: syntax errors, import failures and missing tool
 * exports are all caught here, with the child's own words in `output`.
 */
export function sandboxValidate(code: string, opts: { timeoutMs?: number } = {}): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const dir = mkdtempSync(join(tmpdir(), 'tiny-sandbox-'))
  const file = join(dir, 'candidate.mjs')
  writeFileSync(file, code, 'utf8')
  return new Promise((resolvePromise) => {
    const done = (r: SandboxResult) => {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp cleanup is best-effort */ }
      resolvePromise(r)
    }
    execFile(
      process.execPath,
      ['--input-type=module', '-e', SANDBOX_SNIPPET],
      {
        timeout: timeoutMs,
        env: { ...process.env, TINY_SANDBOX_FILE: pathToFileURL(file).href, TINY_SANDBOX: '1' },
        cwd: dir,
      },
      (err, stdout, stderr) => {
        const line = String(stdout).split('\n').find((l) => l.startsWith('TINY_SANDBOX_RESULT '))
        if (line) {
          try {
            const parsed = JSON.parse(line.slice('TINY_SANDBOX_RESULT '.length))
            return done({ ok: parsed.ok, output: parsed.error || 'import OK', tools: parsed.tools ?? [] })
          } catch { /* fall through to the raw report */ }
        }
        // No marker line: the child died before printing (syntax error at
        // parse time, OOM, timeout kill). Its stderr is the only witness.
        const why = err?.killed ? `sandbox timed out after ${Math.round(timeoutMs / 1000)}s`
          : String(stderr || err?.message || 'sandbox produced no result').slice(0, 500)
        done({ ok: false, output: why, tools: [] })
      },
    )
  })
}

/** Judge a sandbox result: is there at least one loadable tool definition? */
export function judgeSandbox(r: SandboxResult): { ok: true; names: string[] } | { ok: false; reason: string } {
  if (!r.ok) return { ok: false, reason: `code failed to import: ${r.output}` }
  const valid = r.tools.filter((t) => isValidLocalToolName(t.name) && (t.hasHandler || t.isStrandsTool) && t.description)
  if (!valid.length) {
    const why = !r.tools.length
      ? 'no default/`tools` export found'
      : r.tools.map((t) => !isValidLocalToolName(t.name) ? `bad name ${JSON.stringify(t.name)}`
        : !t.description ? `"${t.name}" has no description`
        : `"${t.name}" has no handler(input) function`).join('; ')
    return { ok: false, reason: `no loadable tool definition: ${why}` }
  }
  return { ok: true, names: valid.map((t) => t.name as string) }
}

/** Fetch source text over https, converting github blob links to raw. */
export async function fetchToolSource(url: string): Promise<string> {
  const raw = toRawUrl(url)
  if (!/^https:\/\//.test(raw)) throw new Error('only https:// URLs are fetchable')
  const res = await fetch(raw, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`GET ${raw} → ${res.status}`)
  const text = await res.text()
  if (!text.trim()) throw new Error('fetched an empty file')
  return text
}

// ── the tool ────────────────────────────────────────────────────────────────

export interface ManageToolsCtx {
  /** The LIVE SDK registry — read through the agent every call (it doesn't exist at build time). */
  registry: () => RegistryLike | null
  /** Builtin names: never removable, never shadowable. */
  reserved: () => string[]
  /** Names the last local-tools load registered. */
  previous: () => string[]
  /** Persist the new local-tool name list (and, when a load ran, the tool objects) after a mutation. */
  onLoaded: (names: string[], tools?: any[]) => void
  /** Tools dir override (tests). */
  dir?: () => string
}

const err = (text: string) => `manage_tools error: ${text}`

export function makeManageToolsTool(ctx: ManageToolsCtx) {
  const dirOf = () => (ctx.dir ? ctx.dir() : localToolsDir())

  /** create + fetch share this: sandbox → write → hot-load → report. */
  async function admit(code: string, requestedName: string | undefined, origin: string, regs: RegistryLike[]): Promise<string> {
    const sandbox = await sandboxValidate(code)
    const verdict = judgeSandbox(sandbox)
    if (!verdict.ok) return err(`${origin} rejected by sandbox — ${verdict.reason}`)
    const name = requestedName || verdict.names[0]
    if (!isValidLocalToolName(name)) return err(`invalid tool name ${JSON.stringify(name)} — 1-64 chars, letters/digits/_/-`)
    if (requestedName && !verdict.names.includes(requestedName)) {
      return err(`the code defines ${verdict.names.join(', ')} but name=${requestedName} was requested — they must match (the file is named after the tool)`)
    }
    const reservedKeys = new Set(ctx.reserved().map(toolNameKey))
    if (reservedKeys.has(toolNameKey(name))) return err(`"${name}" is a builtin tool name — pick another`)
    const dir = ensureToolsDir(dirOf())
    const path = toolFilePath(name, dir)
    if (existsSync(path)) return err(`${path} already exists — remove it first (action=remove, name=${name}, delete_file=true) or pick another name`)
    writeFileSync(path, code, { encoding: 'utf8', mode: 0o600 })
    // Hot-load through the SAME rail use_tools rides — one loader, one truth.
    if (!regs.length) return `✅ wrote ${path} (sandbox passed: ${verdict.names.join(', ')}) — but no live registry to hot-load into; it loads on next start or use_tools reload`
    try {
      const { result, names } = await reloadLocalTools(regs, { previous: ctx.previous(), reserved: ctx.reserved(), dir })
      ctx.onLoaded(names, result.tools)
      const mine = result.loaded.filter((t) => t.file === `${name}.mjs`)
      const failed = result.skipped.find((s) => s.file === `${name}.mjs`)
      if (failed) return err(`sandbox passed but the loader refused it: ${failed.reason} (file kept at ${path})`)
      return `✅ ${origin}: ${mine.map((t) => t.name).join(', ') || name} live at ${path} — callable NOW and after restarts`
    } catch (e: any) {
      return err(`wrote ${path} but reload failed: ${String(e?.message || e).slice(0, 300)}`)
    }
  }

  return tool({
    name: 'manage_tools',
    description: [
      'Manage YOUR OWN toolset at runtime — grow capabilities mid-task instead of giving up.',
      '`list` shows every tool in the LIVE registry (builtins + local + dynamic). `create` takes ESM tool source (export default {name, description, inputSchema?, handler(input)}), validates it in a SANDBOX subprocess, writes it to ~/.tiny/tools and hot-loads it. `fetch` does the same from an https URL (github blob links auto-convert to raw). `remove` unregisters a runtime tool (delete_file=true also deletes its file). `reload` re-reads the tools dir. `discover` sandbox-inspects source or a URL WITHOUT loading it.',
      'Composes with use_tools (same loader, same dir) and use_npm (install packages a tool needs first). Long-horizon: a missing capability is a tool you can WRITE, validate and call within one task.',
      'TINY_DISABLE_LOAD_TOOL=true disables create/fetch/reload.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'fetch', 'remove', 'reload', 'discover'] },
        name: { type: 'string', description: 'tool name (create: must match the code; remove: which to drop)' },
        code: { type: 'string', description: 'ESM tool source for create/discover' },
        url: { type: 'string', description: 'https source for fetch/discover (github blob ok)' },
        delete_file: { type: 'boolean', description: 'remove: also delete the backing file in the tools dir' },
      },
      required: ['action'],
    },
    callback: async (input: any, toolContext?: unknown) => {
      const action = String(input?.action || '')
      const gated = ['create', 'fetch', 'reload'].includes(action)
      if (gated && loadToolDisabled()) return KILL_SWITCH_MSG
      // Resolved PER CALL, not at build time: tool instances are shared across
      // forked turns, so the registry captured when this tool was constructed is
      // the SESSION agent's — while the agent executing this very toolUse (a
      // fork, a loop iteration, a relay turn) has its own. ToolContext.agent is
      // the executing one; mutations reach it FIRST so a tool created mid-turn
      // is callable in the same turn, then the session so future turns keep it.
      const regs = resolveRegistries(toolContext, ctx.registry)

      switch (action) {
        case 'list': {
          if (!regs.length) return 'no live tool registry (local tools need a local model — this session proxies to the server)'
          const reg = regs[0]
          const reservedKeys = new Set(ctx.reserved().map(toolNameKey))
          const localNames = new Set(ctx.previous())
          const rows = reg.list().map((t: any) => {
            const kind = reservedKeys.has(toolNameKey(t.name)) ? 'builtin' : localNames.has(t.name) ? 'local ~/.tiny/tools' : 'dynamic'
            const desc = String(t.description || '').split('\n')[0].slice(0, 80)
            return `  ${t.name} [${kind}] — ${desc}`
          }).sort()
          return `${rows.length} tools in the live registry:\n${rows.join('\n')}`
        }

        case 'create': {
          if (!input?.code) return err('create needs code (ESM source: export default {name, description, handler})')
          return admit(String(input.code), input?.name ? String(input.name) : undefined, 'create', regs)
        }

        case 'fetch': {
          if (!input?.url) return err('fetch needs url')
          let code: string
          try { code = await fetchToolSource(String(input.url)) } catch (e: any) { return err(String(e?.message || e)) }
          return admit(code, input?.name ? String(input.name) : undefined, `fetch ${input.url}`, regs)
        }

        case 'remove': {
          const name = String(input?.name || '')
          if (!name) return err('remove needs name')
          const reservedKeys = new Set(ctx.reserved().map(toolNameKey))
          if (reservedKeys.has(toolNameKey(name))) return err(`"${name}" is a builtin — builtins cannot be removed`)
          if (!regs.length) return 'no live tool registry (local tools need a local model — this session proxies to the server)'
          const live = regs.some((r) => r.list().some((t: any) => t.name === name))
          if (!live) return err(`no tool named "${name}" in the live registry`)
          // Remove from EVERY registry that has it — executing agent's and the
          // session's — or the name resurfaces on the next fork.
          for (const reg of regs) {
            if (!reg.list().some((t: any) => t.name === name)) continue
            try { reg.remove(name) } catch (e: any) { return err(`registry refused: ${String(e?.message || e).slice(0, 200)}`) }
          }
          ctx.onLoaded(ctx.previous().filter((n) => n !== name))
          const path = toolFilePath(name, dirOf())
          if (input?.delete_file && existsSync(path)) {
            try { unlinkSync(path); return `🗑 removed "${name}" from the registry and deleted ${path}` } catch (e: any) {
              return `🗑 removed "${name}" from the registry, but could not delete ${path}: ${String(e?.message || e).slice(0, 200)}`
            }
          }
          const note = existsSync(path) ? ` — its file ${path} remains, so a reload brings it back (delete_file=true to also delete)` : ''
          return `🗑 removed "${name}" from the live registry${note}`
        }

        case 'reload': {
          if (!regs.length) return 'no live tool registry (local tools need a local model — this session proxies to the server)'
          try {
            const { result, names, removed } = await reloadLocalTools(regs, { previous: ctx.previous(), reserved: ctx.reserved(), dir: dirOf() })
            ctx.onLoaded(names, result.tools)
            return `${summarize(result)}${removed.length ? `\n   🗑 removed: ${removed.join(', ')}` : ''}`
          } catch (e: any) {
            return err(`reload failed: ${String(e?.message || e).slice(0, 300)}`)
          }
        }

        case 'discover': {
          let code: string | undefined = input?.code ? String(input.code) : undefined
          if (!code && input?.url) {
            try { code = await fetchToolSource(String(input.url)) } catch (e: any) { return err(String(e?.message || e)) }
          }
          if (!code) return err('discover needs code or url')
          const sandbox = await sandboxValidate(code)
          if (!sandbox.ok) return `❌ does not import: ${sandbox.output}`
          if (!sandbox.tools.length) return '⚠️ imports cleanly but exports no tool definitions (no default/`tools` export)'
          const lines = sandbox.tools.map((t) => {
            const v = judgeSandbox({ ok: true, output: '', tools: [t] })
            return `  ${'ok' in v && v.ok ? '✅' : '⚠️'} ${t.name ?? '(unnamed)'} — ${t.description ?? '(no description)'}${t.isStrandsTool ? ' [strands tool]' : t.hasHandler ? '' : ' [no handler]'}`
          })
          return `${sandbox.tools.length} definition(s) found:\n${lines.join('\n')}\n(discover only inspects — action=create loads it)`
        }

        default:
          return err(`unknown action: ${action}. Valid: list, create, fetch, remove, reload, discover`)
      }
    },
  } as any)
}

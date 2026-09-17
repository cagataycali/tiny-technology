/**
 * use_npm — every npm package on earth as a native tool, on the fly.
 *
 * The use_google philosophy applied to the npm registry: instead of a
 * hand-written wrapper per package, ONE tool that installs anything and
 * reflects its exported surface, so the model discovers what a package can do
 * the same way it discovers a Google API — by asking, and getting back the
 * names that actually exist.
 *
 *   search    registry.npmjs.org full-text search — find the package
 *   install   npm i into the ~/.tiny/npm sandbox (NOT tiny-tech's own
 *             node_modules — that is wiped by the next `npm i -g tiny-tech`)
 *   inspect   import it and reflect exports: functions with signatures,
 *             classes, constants — the package's own "discovery doc"
 *   call      import + invoke one export with JSON args, result back as JSON
 *   run       arbitrary ESM code with the sandbox's node_modules resolvable —
 *             for the calls that need two lines of glue (streams, callbacks)
 *   installed / remove / info
 *
 * ── why every execution is a CHILD process ─────────────────────────────────
 * A dynamic import() in-process would be faster, but a package that crashes,
 * leaks, or calls process.exit() takes the daemon with it — and unlike a local
 * tool the user wrote, this is code straight off the registry. A child node
 * with cwd inside the sandbox gets the same resolution (`import('sharp')`
 * finds sandbox node_modules) and dies alone. It also makes the timeout real:
 * the spawn is killed on its leash; an in-process await cannot be killed at all.
 * The spawn is ASYNCHRONOUS (exec.ts) — a 180s install under execFileSync froze
 * the TUI and every conversation streaming beside it, not just this tool call.
 *
 * ── the sandbox is user state ──────────────────────────────────────────────
 * ~/.tiny/npm with its own package.json, sibling of ~/.tiny/tools — the same
 * reasoning as local-tools.ts: survives upgrades, isn't read-only, and the
 * user can `cd ~/.tiny/npm && npm ls` to see exactly what their agent pulled.
 *
 * Errors return as text, never throw — the model adapts (device-tools rule).
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run, timedOut } from './exec.js'

/** One package operation's leash. Installs get longer (network + postinstall). */
export const NPM_CALL_TIMEOUT_MS = 60_000
export const NPM_INSTALL_TIMEOUT_MS = 180_000
/** Result clamp — same reasoning as LOCAL_TOOL_OUTPUT_MAX (it enters context). */
export const NPM_OUTPUT_MAX = 20_000

export function hasNpm(): boolean {
  try { execSync('command -v npm', { stdio: 'ignore' }); return true } catch { return false }
}

/** Where installed packages live. TINY_NPM_DIR overrides for project scope. */
export function npmDir(): string {
  if (process.env.TINY_NPM_DIR) return process.env.TINY_NPM_DIR
  const home = process.env.TINY_HOME || join(homedir(), '.tiny')
  return join(home, 'npm')
}

/** Create the sandbox on first touch — its own package.json, type:module. */
export function ensureNpmDir(): string {
  const dir = npmDir()
  mkdirSync(dir, { recursive: true })
  const pkgJson = join(dir, 'package.json')
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({
      name: 'tiny-npm-sandbox', private: true, type: 'module',
      description: 'packages installed by use_npm — safe to delete, reinstalls on demand',
    }, null, 2))
  }
  return dir
}

/**
 * Bare package name from a spec that may carry a version or subpath —
 * '@scope/pkg@1.2.3' → '@scope/pkg', 'lodash/fp' → 'lodash'. Needed because
 * install takes the spec but import and package.json bookkeeping need the name.
 */
export function packageName(spec: string): string {
  const s = spec.trim()
  if (s.startsWith('@')) {
    const parts = s.split('/')
    const rest = parts.slice(1).join('/')
    return `${parts[0]}/${rest.split('@')[0].split('/')[0]}`
  }
  return s.split('@')[0].split('/')[0]
}

/**
 * The code a child node runs to reflect a package's surface — the package's
 * own discovery doc. Pure string builder so tests cover it without a network
 * or an install (the google.ts request-builder lesson).
 */
export function buildInspectCode(pkg: string): string {
  return `
const pkg = ${JSON.stringify(pkg)}
const m = await import(pkg)
const seen = new Set()
function sig(fn) {
  const src = String(fn)
  const head = src.slice(0, src.indexOf(')') + 1).replace(/\\s+/g, ' ').slice(0, 200)
  return head || fn.name + '(…)'
}
function describe(obj, depth) {
  const out = {}
  for (const k of Object.getOwnPropertyNames(obj)) {
    if (k.startsWith('_')) continue
    let v
    try { v = obj[k] } catch { continue }
    const t = typeof v
    if (t === 'function') {
      const isClass = /^class[\\s{]/.test(String(v))
      out[k] = (isClass ? 'class ' : 'fn ') + sig(v)
      // one level into a class/fn statics + prototype methods
      if (isClass && depth > 0 && v.prototype) {
        const methods = Object.getOwnPropertyNames(v.prototype).filter((n) => n !== 'constructor' && !n.startsWith('_'))
        if (methods.length) out[k] += ' · methods: ' + methods.slice(0, 30).join(', ')
      }
    } else if (t === 'object' && v !== null && depth > 0) {
      if (seen.has(v)) continue // cycle guard — objects only; fns repeat legitimately (CJS default mirror)
      seen.add(v)
      out[k] = describe(v, depth - 1)
    } else {
      out[k] = t
    }
  }
  return out
}
const surface = describe(m, 1)
process.stdout.write(JSON.stringify({ package: pkg, exports: surface }, null, 1))
`.trim()
}

/**
 * The code a child node runs for `call`. Walks a dotted export path against
 * the module, falling back through .default (CJS interop puts everything
 * there), invokes with the args array, awaits, and serializes. `construct`
 * uses `new` — half of npm's useful surface is classes.
 */
export function buildCallCode(pkg: string, exportPath: string, args: unknown[], construct: boolean): string {
  return `
const pkg = ${JSON.stringify(pkg)}
const path = ${JSON.stringify(exportPath)}
const args = ${JSON.stringify(args)}
const m = await import(pkg)
function walk(root) {
  let t = root
  for (const part of path.split('.').filter(Boolean)) {
    if (t == null) return undefined
    t = t[part]
  }
  return t
}
let target = walk(m)
// CJS interop: an empty path resolves to the namespace OBJECT, but what the
// caller means is "the thing this package exports" — which interop parks on
// .default. Same when a path missed at the top level.
if (target === undefined && m.default !== undefined) target = walk(m.default)
// …and interop sometimes stacks them: cjs module.exports=fn shows up as
// m.default.default. Unwrap while a plain default chain leads to a callable.
let hops = 0
while (target && typeof target !== 'function' && typeof target === 'object' && typeof target.default !== 'undefined' && hops++ < 3) target = target.default
if (target === undefined) {
  const names = [...new Set([...Object.keys(m), ...(m.default && typeof m.default === 'object' ? Object.keys(m.default) : [])])]
  process.stdout.write(JSON.stringify({ error: 'export not found: ' + path, available: names.slice(0, 50) }))
  process.exit(0)
}
if (typeof target !== 'function') {
  process.stdout.write(JSON.stringify({ value: target }, (k, v) => typeof v === 'function' ? '[fn ' + (v.name || 'anonymous') + ']' : v))
  process.exit(0)
}
const result = await (${JSON.stringify(construct)} ? new target(...args) : target(...args))
const cache = new Set()
process.stdout.write(JSON.stringify({ result }, (k, v) => {
  if (typeof v === 'function') return '[fn ' + (v.name || 'anonymous') + ']'
  if (typeof v === 'bigint') return String(v)
  if (v instanceof Buffer || (v && v.type === 'Buffer')) return '[Buffer ' + (v.length ?? (v.data && v.data.length) ?? '?') + ' bytes]'
  if (typeof v === 'object' && v !== null) { if (cache.has(v)) return '[circular]'; cache.add(v) }
  return v
}))
`.trim()
}

/** Run code in a child node inside the sandbox. Rejects on failure — callers catch. */
function runNode(code: string, timeoutMs = NPM_CALL_TIMEOUT_MS): Promise<string> {
  return run(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ensureNpmDir(), timeoutMs,
  })
}

function npmExec(args: string[], timeoutMs = NPM_INSTALL_TIMEOUT_MS): Promise<string> {
  return run('npm', args, { cwd: ensureNpmDir(), timeoutMs })
}

const clamp = (s: string) => s.length > NPM_OUTPUT_MAX ? s.slice(0, NPM_OUTPUT_MAX) + `\n…[clamped at ${NPM_OUTPUT_MAX} chars]` : s

export function makeNpmTool() {
  return tool({
    name: 'use_npm',
    description: `Use ANY npm package as a native tool — install on demand, reflect its surface, call it. Sandbox: ~/.tiny/npm (survives upgrades). Actions:
- search (query) — find packages on registry.npmjs.org
- info (package) — registry metadata: latest version, description, deps
- install (package) — npm install into the sandbox (spec ok: pkg@1.2.3)
- inspect (package) — import it, list real exports with signatures (do this BEFORE call)
- call (package, export='path.to.fn', args=[...], construct=false) — invoke one export, JSON in/out
- run (code) — arbitrary ESM code, sandbox packages importable: await import('pkg')
- installed — what's in the sandbox
- remove (package)
Workflow: search → install → inspect → call. Prefer call; use run when glue is needed (streams, callbacks, chained APIs).`,
    inputSchema: z.object({
      action: z.enum(['search', 'info', 'install', 'inspect', 'call', 'run', 'installed', 'remove']),
      package: z.string().optional(),
      query: z.string().optional(),
      export: z.string().optional().describe("dotted export path, e.g. 'default' or 'promises.readFile'; empty = module default"),
      args: z.array(z.any()).optional().describe('JSON arguments for call'),
      construct: z.boolean().optional().describe('use `new` (class constructor)'),
      code: z.string().optional().describe('ESM source for run'),
    }),
    callback: async (a) => {
      try {
        switch (a.action) {
          case 'search': {
            if (!a.query) return 'need query'
            const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(a.query)}&size=10`)
            const d: any = await res.json()
            const rows = (d.objects || []).map((o: any) =>
              `- ${o.package.name}@${o.package.version} — ${String(o.package.description || '').slice(0, 100)}`)
            return rows.join('\n') || 'no results'
          }
          case 'info': {
            if (!a.package) return 'need package'
            const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName(a.package))}`)
            if (!res.ok) return `not found: ${a.package} (${res.status})`
            const d: any = await res.json()
            const latest = d['dist-tags']?.latest
            const v = d.versions?.[latest] || {}
            return clamp(JSON.stringify({
              name: d.name, latest, description: d.description,
              module_type: v.type || 'commonjs', main: v.main, exports: v.exports ? Object.keys(v.exports).slice(0, 20) : undefined,
              dependencies: v.dependencies ? Object.keys(v.dependencies) : [],
              homepage: d.homepage,
            }, null, 1))
          }
          case 'install': {
            if (!a.package) return 'need package'
            const out = await npmExec(['install', a.package, '--no-audit', '--no-fund', '--loglevel=error'])
            return `installed ${a.package} into ${npmDir()}\n${clamp(out.trim())}\nNext: inspect it to see the exported surface.`
          }
          case 'inspect': {
            if (!a.package) return 'need package'
            return clamp(await runNode(buildInspectCode(packageName(a.package))))
          }
          case 'call': {
            if (!a.package) return 'need package'
            return clamp(await runNode(buildCallCode(packageName(a.package), a.export || '', a.args || [], a.construct || false)))
          }
          case 'run': {
            if (!a.code) return 'need code'
            return clamp(await runNode(a.code)) || '(no output — use process.stdout.write or console.log)'
          }
          case 'installed': {
            const pkgJson = join(ensureNpmDir(), 'package.json')
            const deps = JSON.parse(readFileSync(pkgJson, 'utf-8')).dependencies || {}
            const names = Object.entries(deps).map(([k, v]) => `- ${k}@${v}`)
            return names.join('\n') || `sandbox empty (${npmDir()})`
          }
          case 'remove': {
            if (!a.package) return 'need package'
            await npmExec(['uninstall', packageName(a.package), '--no-audit', '--no-fund', '--loglevel=error'])
            return `removed ${a.package}`
          }
        }
      } catch (e: any) {
        // ERR_MODULE_NOT_FOUND from a call/inspect is the most common miss —
        // say the fix, not just the error.
        const msg = String(e?.stderr || e?.message || e).slice(0, 1500)
        if (msg.includes('ERR_MODULE_NOT_FOUND') || msg.includes('Cannot find'))
          return `error: ${msg}\nHint: install it first — use_npm install ${a.package || '<package>'}`
        if (timedOut(e)) return `error: timed out after ${a.action === 'install' ? NPM_INSTALL_TIMEOUT_MS : NPM_CALL_TIMEOUT_MS}ms`
        return `error: ${msg}`
      }
    },
  })
}

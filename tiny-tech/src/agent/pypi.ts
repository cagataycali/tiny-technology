/**
 * use_pypi — every Python package on earth as a native tool, on the fly.
 *
 * use_npm's twin for the OTHER half of the software universe: yfinance,
 * pandas, yt-dlp, transformers — the packages with no npm equivalent worth
 * having. Same discovery-doc philosophy: install anything, reflect its real
 * surface with inspect, call it with JSON in/out.
 *
 *   search    pypi.org JSON API — find the package
 *   info      registry metadata: version, summary, requires
 *   install   pip install into a dedicated venv at ~/.tiny/pypi
 *   inspect   import it and reflect: functions with inspect.signature,
 *             classes with public methods, constants
 *   call      import + invoke one dotted attr with JSON args
 *   run       arbitrary Python in the venv — for the multi-line glue
 *   installed / remove
 *
 * ── the venv is the sandbox ────────────────────────────────────────────────
 * A dedicated venv at ~/.tiny/pypi (sibling of ~/.tiny/tools and ~/.tiny/npm,
 * same user-state reasoning) — NOT the system python: `pip install` into a
 * Homebrew or OS python is exactly the mess PEP 668 exists to refuse, and
 * refuses loudly (externally-managed-environment). The venv is created lazily
 * on first install, with whatever python3 the machine has.
 *
 * ── every call is a child process, and that's structural ──────────────────
 * There is no in-process option here — python isn't node — and that's the
 * better half of the design anyway: the same isolation use_npm CHOSE, imposed.
 * The child gets the venv's interpreter, a timeout enforced by kill, and JSON on
 * stdout as its only contract. The spawn is ASYNCHRONOUS (exec.ts): `pip install
 * torch` is allowed 300 seconds, and 300 seconds of execFileSync is 300 seconds
 * with the TUI frozen and every concurrent conversation stalled — see exec.ts.
 *
 * The python snippets are pure string builders, unit-tested without a python
 * on the machine at all (google.ts request-builder lesson).
 *
 * Errors return as text, never throw — the model adapts (device-tools rule).
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run, timedOut } from './exec.js'

export const PYPI_CALL_TIMEOUT_MS = 60_000
export const PYPI_INSTALL_TIMEOUT_MS = 300_000 // torch exists
export const PYPI_OUTPUT_MAX = 20_000

export function hasPython(): boolean {
  try { execSync('command -v python3', { stdio: 'ignore' }); return true } catch { return false }
}

/** Where the venv lives. TINY_PYPI_DIR overrides for project scope. */
export function pypiDir(): string {
  if (process.env.TINY_PYPI_DIR) return process.env.TINY_PYPI_DIR
  const home = process.env.TINY_HOME || join(homedir(), '.tiny')
  return join(home, 'pypi')
}

function venvPython(): string {
  return join(pypiDir(), 'bin', 'python3')
}

/** Create the venv on first touch. Returns the venv's python path. */
export async function ensureVenv(): Promise<string> {
  const py = venvPython()
  if (existsSync(py)) return py
  mkdirSync(pypiDir(), { recursive: true })
  // First install on a machine pays this once, and it is the single longest
  // blocking call in the tree after a torch download — async for that reason.
  await run('python3', ['-m', 'venv', pypiDir()], { timeoutMs: 120_000 })
  return py
}

/**
 * Bare importable module name from a pip spec — 'yt-dlp[default]==2024.1' →
 * 'yt_dlp'. Pip names use '-', import names use '_'; extras and pins are
 * pip-side only. NOT a full mapping (Pillow→PIL, beautifulsoup4→bs4 exist),
 * but inspect's error path lists what IS importable when the guess misses.
 */
export function importName(spec: string): string {
  return spec.trim().split(/[=<>!\[ ]/)[0].replace(/-/g, '_')
}

/**
 * Ask the venv what a pip package's REAL import name is — the string guess
 * (dash→underscore) is wrong for a whole class of packages (python-dateutil→
 * dateutil, Pillow→PIL, beautifulsoup4→bs4). packages_distributions() maps
 * import names → dist names; invert it. Pure builder — tested.
 */
export function buildResolveImportCode(distName: string): string {
  return `
import json
from importlib.metadata import packages_distributions
want = ${JSON.stringify(distName)}.lower().replace('_', '-')
mods = [m for m, dists in packages_distributions().items()
        if any(d.lower().replace('_', '-') == want for d in dists)]
print(json.dumps(mods))
`.trim()
}

/** Python snippet: reflect a module's public surface. Pure builder — tested. */
export function buildInspectCode(module: string): string {
  return `
import json, inspect as _i, importlib
m = importlib.import_module(${JSON.stringify(module)})
out = {}
for name in dir(m):
    if name.startswith('_'): continue
    try: v = getattr(m, name)
    except Exception: continue
    if _i.isclass(v):
        methods = [n for n in dir(v) if not n.startswith('_')][:30]
        out[name] = 'class · methods: ' + ', '.join(methods)
    elif callable(v):
        try: out[name] = 'fn' + str(_i.signature(v))[:200]
        except (ValueError, TypeError): out[name] = 'fn(…)'
    elif _i.ismodule(v):
        out[name] = 'module'
    else:
        out[name] = type(v).__name__
print(json.dumps({'module': ${JSON.stringify(module)}, 'exports': out}, default=str))
`.trim()
}

/**
 * Python snippet: walk a dotted attr path, call it with JSON args, print JSON.
 * kwargs ride as the last arg when it's an object and kwargs=true. The error
 * path lists sibling attrs — one round trip to self-correct, like google.ts
 * resolveMethod and use_npm's call.
 */
export function buildCallCode(module: string, attrPath: string, args: unknown[], kwargs: Record<string, unknown> | null): string {
  return `
import json, importlib
m = importlib.import_module(${JSON.stringify(module)})
target = m
walked = []
root = ${JSON.stringify(module)}
for part in [p for p in ${JSON.stringify(attrPath)}.split('.') if p]:
    walked.append(part)
    try: target = getattr(target, part)
    except AttributeError:
        # lazy submodule (PIL.Image, matplotlib.pyplot): not an attr until imported
        try:
            target = importlib.import_module(root + '.' + '.'.join(walked))
            continue
        except ImportError: pass
        parent = m
        for q in walked[:-1]: parent = getattr(parent, q)
        avail = sorted(set([n for n in dir(parent) if not n.startswith('_')]))[:50]
        print(json.dumps({'error': 'attr not found: ' + '.'.join(walked), 'available': avail, 'hint': 'if this is a submodule, it may need module=' + root + '.' + walked[0]}))
        raise SystemExit(0)
args = json.loads(${JSON.stringify(JSON.stringify(args))})
kwargs = json.loads(${JSON.stringify(JSON.stringify(kwargs))}) or {}
result = target(*args, **kwargs) if callable(target) else target
def default(o):
    try: return o.__dict__
    except Exception: return str(o)
try:
    import pandas as _pd
    if isinstance(result, _pd.DataFrame): result = json.loads(result.head(50).to_json(orient='records'))
    elif isinstance(result, _pd.Series): result = json.loads(result.head(50).to_json())
except ImportError: pass
print(json.dumps({'result': result}, default=default))
`.trim()
}

async function runPython(code: string, timeoutMs = PYPI_CALL_TIMEOUT_MS): Promise<string> {
  const py = await ensureVenv()
  return await run(py, ['-c', code], {
    timeoutMs,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
}

/**
 * dist name → import name, venv-truth first, string guess as fallback.
 * Cached per process: metadata scan is a directory walk.
 */
const importNameCache = new Map<string, string>()
async function resolveImportName(distSpec: string): Promise<string> {
  const dist = distSpec.trim().split(/[=<>!\[ ]/)[0]
  const cached = importNameCache.get(dist)
  if (cached) return cached
  let name = importName(distSpec)
  try {
    const out = await runPython(buildResolveImportCode(dist), 15_000)
    const mods: string[] = JSON.parse(out.trim())
    // prefer the module matching the guess; else the first non-private one
    if (mods.length) name = mods.includes(name) ? name : (mods.find((m) => !m.startsWith('_')) || mods[0])
  } catch { /* venv may not exist yet — the guess stands */ }
  importNameCache.set(dist, name)
  return name
}

async function pipExec(args: string[]): Promise<string> {
  const py = await ensureVenv()
  return await run(py, ['-m', 'pip', ...args, '--disable-pip-version-check', '-q'], {
    timeoutMs: PYPI_INSTALL_TIMEOUT_MS,
  })
}

const clamp = (s: string) => s.length > PYPI_OUTPUT_MAX ? s.slice(0, PYPI_OUTPUT_MAX) + `\n…[clamped at ${PYPI_OUTPUT_MAX} chars]` : s

export function makePypiTool() {
  return tool({
    name: 'use_pypi',
    description: `Use ANY Python package as a native tool — pip install on demand into a dedicated venv (~/.tiny/pypi), reflect its surface, call it. Actions:
- search (query) — find packages on pypi.org
- info (package) — version, summary, requires
- install (package) — pip install into the venv (spec ok: pkg==1.2, pkg[extra])
- inspect (package, module?) — import + list real functions/classes with signatures (do this BEFORE call)
- call (package, attr='dotted.path', args=[...], kwargs={...}) — invoke, JSON in/out. DataFrames auto-serialize (head 50)
- run (code) — arbitrary Python in the venv; print JSON to return data
- installed — pip list
- remove (package)
Workflow: search → install → inspect → call. Import name may differ from pip name (yt-dlp → module yt_dlp; pass module= to inspect). Use run for chained calls: t = yf.Ticker('AAPL'); print(json.dumps(t.info)).`,
    inputSchema: z.object({
      action: z.enum(['search', 'info', 'install', 'inspect', 'call', 'run', 'installed', 'remove']),
      package: z.string().optional(),
      module: z.string().optional().describe('import name when it differs from pip name (e.g. bs4 for beautifulsoup4)'),
      query: z.string().optional(),
      attr: z.string().optional().describe("dotted attr path inside the module, e.g. 'Ticker' or 'download'"),
      args: z.array(z.any()).optional(),
      kwargs: z.record(z.string(), z.any()).optional(),
      code: z.string().optional().describe('Python source for run'),
    }),
    callback: async (a) => {
      try {
        switch (a.action) {
          case 'search': {
            if (!a.query) return 'need query'
            // PyPI killed XML-RPC search; the JSON path is per-package. Simple
            // web search endpoint returns HTML, so probe the exact name first,
            // then fall back to the (unofficial but stable) simple index grep.
            const exact = await fetch(`https://pypi.org/pypi/${encodeURIComponent(a.query)}/json`)
            if (exact.ok) {
              const d: any = await exact.json()
              return `exact match:\n- ${d.info.name}@${d.info.version} — ${String(d.info.summary || '').slice(0, 120)}`
            }
            // PyPI has no supported search API anymore (XML-RPC dead, HTML
            // blocked for non-browsers). Best real signal: try dash/underscore
            // variants of the query as exact names, in parallel.
            const q = a.query.toLowerCase().replace(/\s+/g, '-')
            const variants = [...new Set([q, q.replace(/-/g, '_'), q.replace(/-/g, '')])]
            const hits = await Promise.all(variants.map(async (v) => {
              const r = await fetch(`https://pypi.org/pypi/${encodeURIComponent(v)}/json`)
              if (!r.ok) return null
              const d: any = await r.json()
              return `- ${d.info.name}@${d.info.version} — ${String(d.info.summary || '').slice(0, 120)}`
            }))
            const found = [...new Set(hits.filter(Boolean))]
            return found.length ? found.join('\n')
              : `no exact match for '${a.query}'. PyPI has no search API — if you know roughly what you want, guess the canonical name and use info (e.g. 'yfinance', 'yt-dlp', 'beautifulsoup4'), or search the web.`
          }
          case 'info': {
            if (!a.package) return 'need package'
            const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(a.package)}/json`)
            if (!res.ok) return `not found: ${a.package} (${res.status})`
            const d: any = await res.json()
            return clamp(JSON.stringify({
              name: d.info.name, version: d.info.version, summary: d.info.summary,
              requires_python: d.info.requires_python,
              requires: (d.info.requires_dist || []).slice(0, 20),
              home_page: d.info.home_page || d.info.project_urls?.Homepage,
            }, null, 1))
          }
          case 'install': {
            if (!a.package) return 'need package'
            await pipExec(['install', a.package])
            importNameCache.clear() // new dist may shadow an old guess
            const mod = await resolveImportName(a.package)
            return `installed ${a.package} into venv ${pypiDir()}\nNext: use_pypi inspect package=${a.package}${mod !== a.package ? ` (import name: '${mod}')` : ''}`
          }
          case 'inspect': {
            if (!a.package && !a.module) return 'need package or module'
            return clamp(await runPython(buildInspectCode(a.module || await resolveImportName(a.package!))))
          }
          case 'call': {
            if (!a.package && !a.module) return 'need package or module'
            return clamp(await runPython(buildCallCode(a.module || await resolveImportName(a.package!), a.attr || '', a.args || [], a.kwargs || null)))
          }
          case 'run': {
            if (!a.code) return 'need code'
            return clamp(await runPython(a.code)) || '(no output — print() something, ideally JSON)'
          }
          case 'installed': {
            return clamp(await runPython('import json, importlib.metadata as md; print(json.dumps(sorted(f"{d.metadata[\'Name\']}=={d.version}" for d in md.distributions())))'))
          }
          case 'remove': {
            if (!a.package) return 'need package'
            await pipExec(['uninstall', '-y', a.package])
            return `removed ${a.package}`
          }
        }
      } catch (e: any) {
        const msg = String(e?.stderr || e?.message || e).slice(0, 1500)
        if (msg.includes('ModuleNotFoundError')) {
          const missing = msg.match(/No module named '([^']+)'/)?.[1]
          return `error: ${msg}\nHint: ${missing && a.package && missing !== importName(a.package) ? `import name differs — try module='${missing}' … or the pip name is different.` : `install it first — use_pypi install ${a.package || '<package>'}`}`
        }
        if (timedOut(e)) return `error: timed out after ${a.action === 'install' ? PYPI_INSTALL_TIMEOUT_MS : PYPI_CALL_TIMEOUT_MS}ms`
        return `error: ${msg}`
      }
    },
  })
}

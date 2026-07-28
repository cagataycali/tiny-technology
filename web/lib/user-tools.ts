/**
 * Runtime user tools (issue #8) — validation + sandboxed execution.
 *
 * Tools are JS function bodies of shape `(args) => result` stored per-user
 * in D1. Execution uses `new Function` with a frozen, allowlisted scope
 * (same Rubicon DynamicUI crossed client-side) plus static rejection of
 * dangerous identifiers and a hard timeout.
 *
 * Network: fetch IS allowed but wrapped with the same SSRF guard as
 * dynamic OpenAPI tools (https + public hosts only).
 *
 * Limits: the 10s timeout preempts async work only — a synchronous infinite
 * loop can't be raced in a single-threaded isolate; the edge runtime's CPU
 * limit kills the request instead (contained to the caller's own request).
 */
import { validatePublicUrl } from './utils'

const BANNED_PATTERNS: [RegExp, string][] = [
  [/\bprocess\b/, 'process'],
  [/\brequire\b/, 'require'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/\beval\b/, 'eval'],
  [/\bFunction\s*\(/, 'Function constructor'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\bself\b/, 'self'],
  // `.constructor` in ANY form is banned — `(0).constructor.constructor`
  // is the classic Function-constructor escape, and `x["constructor"]`
  // /`x['constructor']` are the bracket forms. Denylists are leaky, so
  // block the whole constructor-reachability surface, not just `[`.
  [/\bconstructor\b/, 'constructor access'],
  [/__proto__/, '__proto__'],
  [/\bprototype\b/, 'prototype access'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bimportScripts\b/, 'importScripts'],
  // Unicode/hex escapes can hide the above from the word-boundary checks
  // (e.g. "constructor"); a backslash-escape in code is never
  // legitimate for these tiny arrow-function tools.
  [/\\u|\\x/, 'escaped identifier'],
]

export function validateToolCode(code: string): { ok: true } | { ok: false; error: string } {
  if (!code || code.length > 4096) return { ok: false, error: 'code must be 1-4096 chars' }
  for (const [re, label] of BANNED_PATTERNS) {
    if (re.test(code)) return { ok: false, error: `forbidden: ${label}` }
  }
  // Must be an arrow/function expression taking args
  try {
    // Parse check only — never executed here
    new Function(`"use strict"; return (${code});`)
  } catch (e: any) {
    return { ok: false, error: `syntax error: ${e?.message || e}` }
  }
  return { ok: true }
}

const MAX_FETCH_BYTES = 100_000

/** Read a response body up to `limit` bytes WITHOUT buffering the whole
 *  thing first — a tool could target a 50MB URL to OOM the isolate, since
 *  the SSRF guard allows any public https host. Streams and stops early. */
async function readBounded(res: Response, limit: number): Promise<string> {
  // Cheap reject when the server declares an oversized body up front
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > limit * 4) { try { await res.body?.cancel() } catch { } ; return '' }
  if (!res.body) return (await res.text()).slice(0, limit)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value, { stream: true })
    }
  } finally {
    try { await reader.cancel() } catch { }
  }
  return out.slice(0, limit)
}

/**
 * Guarded fetch handed into user tool scope — returns a JSON STRING envelope,
 * never a host object.
 *
 * CRITICAL realm boundary: this runs in the HOST realm. If it returned a host
 * object (or threw a host Error, or even handed back the host Promise), the
 * tool could reach the host global via `.constructor.constructor('return
 * this')()` on that value → `process.env` (INTERNAL_API_KEY / JWT secret).
 * Deleting the raw `__fetch` reference off the sandbox global closed the
 * FUNCTION-reference hole, but the RETURN VALUE was still host-realm: a host
 * Promise resolving to a host response object, rejecting with a host Error —
 * `fetch(u).constructor…`, `.then(r => r.constructor…)`, `.catch(e =>
 * e.constructor…)` each reached the host. So marshal EVERYTHING to a primitive
 * string: a string carries no realm, and the context wrapper (runUserTool)
 * re-parses it with the CONTEXT's JSON and rebuilds the response object +
 * throws errors entirely inside the sandbox realm. This function therefore
 * NEVER throws across the boundary — every failure becomes an `__error`
 * envelope the wrapper turns into a context-realm Error.
 */
async function guardedFetch(url: string, init?: RequestInit): Promise<string> {
  const checked = validatePublicUrl(url)
  if ('error' in checked) return JSON.stringify({ __error: `fetch blocked: ${checked.error}` })
  try {
    const res = await fetch(checked.url.toString(), {
      ...init,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
    const clipped = await readBounded(res, MAX_FETCH_BYTES)
    let parsed: any = clipped
    try { parsed = JSON.parse(clipped) } catch { /* keep text */ }
    // Envelope carries exactly the fields the context wrapper reconstructs into
    // a Response-compatible { status, ok, body, json(), text() } shape.
    return JSON.stringify({ status: res.status, ok: res.ok, body: parsed, text: clipped })
  } catch (e: any) {
    return JSON.stringify({ __error: `fetch failed: ${String(e?.message || e).slice(0, 120)}` })
  }
}

const TOOL_TIMEOUT_MS = 10_000

export async function runUserTool(code: string, args: Record<string, any>): Promise<any> {
  // Re-validate at the execution boundary so the sandbox guard travels
  // WITH runUserTool, not just with its current callers. A future caller
  // that forgets validateToolCode can't accidentally run unsandboxed code.
  const check = validateToolCode(code)
  if (!check.ok) throw new Error(`forbidden: ${check.error}`)

  // THE HARD BOUNDARY: execute in a fresh V8 context (node:vm), NOT via
  // `new Function` in this realm. A source-text denylist CANNOT stop a tool
  // that builds an identifier at runtime — `Array["con"+"structor"]` reaches
  // the Function constructor without ever typing a banned word, and its
  // `("return this")()` handed back THIS realm's global (with `process`,
  // hence INTERNAL_API_KEY / the JWT secret). Confirmed exploitable.
  //
  // In a fresh context the built-ins (Array, Object, JSON, …) are the
  // CONTEXT'S own, so `Array.constructor("return this")()` returns the
  // sandbox global — which has no `process`/`require`. Prototype pollution
  // is likewise confined to the disposable context. The denylist + timeout +
  // result clamp stay as defense-in-depth, but containment no longer depends
  // on them. Lazy import so a future edge importer of this module doesn't
  // pull node:vm into an edge bundle.
  const vm = await import('node:vm')
  const context = vm.createContext(Object.create(null))

  // Seed the sandbox global. Built-ins already exist inside the context
  // natively; we only inject the host-provided extras. `args` is copied in as
  // JSON so only plain data crosses the boundary.
  //
  // CRITICAL — the realm boundary is guarded on BOTH the reference AND the
  // return value:
  //  (1) `guardedFetch` is a HOST-realm function. Left reachable on the sandbox
  //      global, its `.constructor` is the HOST `Function`, so
  //      `__fetch["cons"+"tructor"]("return this")()` hands back the host global
  //      (with `process` → INTERNAL_API_KEY / JWT secret). The denylist can't
  //      stop the word-free, runtime-built form. So capture it in a context
  //      closure and DELETE it off the global.
  //  (2) Its RETURN VALUE must also carry no host realm. guardedFetch now
  //      returns a JSON STRING (realm-less); the wrapper below awaits it, parses
  //      with the CONTEXT's JSON, and rebuilds the Response-shaped object +
  //      throws errors ENTIRELY in the sandbox realm. A host Promise / host
  //      response object / host Error would each expose `.constructor` → host
  //      global just like (1) did (`fetch(u).constructor…`, `.then(r =>
  //      r.constructor…)`, `.catch(e => e.constructor…)`). Reconstructing
  //      in-realm closes that. The wrapper is `async` so `fetch(u)` is a
  //      CONTEXT Promise and `.then(r => r.json())` tools keep working.
  context.__fetch = guardedFetch
  context.__argsJson = JSON.stringify(args ?? {})
  vm.runInContext(
    `const __f = this.__fetch;
     this.fetch = async (u, i) => {
       const raw = await __f(u, i);
       // raw is a host STRING (no realm); JSON here is the CONTEXT's own.
       const env = JSON.parse(raw);
       if (env && env.__error) throw new Error(env.__error);
       // Rebuild a context-realm Response-compatible object. body/text are
       // plain data already re-parsed into this realm.
       return {
         status: env.status,
         ok: env.ok,
         body: env.body,
         json: () => Promise.resolve(env.body),
         text: () => Promise.resolve(env.text),
       };
     };
     this.args = Object.freeze(JSON.parse(this.__argsJson));
     delete this.__argsJson;
     delete this.__fetch;`,
    context,
  )

  // vm's own `timeout` only bounds SYNCHRONOUS execution; an async tool that
  // awaits forever needs the Promise.race below. Clear the timer in finally so
  // a fast tool doesn't leave a live 10s timer holding the event loop / closure.
  const script = `"use strict"; (${code})(this.args);`
  const run = Promise.resolve(
    vm.runInContext(script, context, { timeout: TOOL_TIMEOUT_MS }),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  let result: any
  try {
    result = await Promise.race([
      run,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tool timeout (10s)')), TOOL_TIMEOUT_MS) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  // Clamp result size so a tool can't flood the context. Strings pass
  // through; objects are size-checked via a circular-safe stringify (a
  // tool returning `const o={}; o.self=o` must not throw an opaque
  // TypeError out of the sandbox). Under the cap, return the object
  // as-is; over it, return the clamped string form.
  if (typeof result === 'string') {
    return result.length > 20_000 ? result.slice(0, 20_000) + '…[truncated]' : result
  }
  let s: string
  try {
    s = JSON.stringify(result ?? null)
  } catch {
    return '[tool result could not be serialized (circular or non-JSON value)]'
  }
  if (s.length > 20_000) return s.slice(0, 20_000) + '…[truncated]'
  return result ?? null
}

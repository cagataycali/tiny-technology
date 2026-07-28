import { describe, it, expect, afterEach, vi } from 'vitest'
import { validateToolCode, runUserTool } from '../lib/user-tools'

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

describe('validateToolCode', () => {
  it('accepts a plain arrow function', () => {
    expect(validateToolCode('(args) => args.text.toUpperCase()')).toEqual({ ok: true })
  })

  it('accepts multi-line function bodies', () => {
    const code = `(args) => {
      const n = Number(args.n)
      return n * 2
    }`
    expect(validateToolCode(code)).toEqual({ ok: true })
  })

  it('rejects empty and oversized code', () => {
    expect(validateToolCode('').ok).toBe(false)
    expect(validateToolCode('(a) => ' + '1+'.repeat(3000) + '1').ok).toBe(false)
  })

  it('rejects syntax errors', () => {
    const r = validateToolCode('(args => {')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/syntax/)
  })

  // The sandbox's whole security model rides on these
  it.each([
    ['(a) => process.env.SECRET', 'process'],
    ['(a) => require("fs")', 'require'],
    ['(a) => import("node:fs")', 'dynamic import'],
    ['(a) => eval(a.x)', 'eval'],
    ['(a) => Function("return 1")()', 'Function constructor'],
    ['(a) => globalThis.fetch', 'globalThis'],
    ['(a) => self.location', 'self'],
    ['(a) => ({}).constructor["assign"]', 'constructor access'],
    ['(a) => a.__proto__', '__proto__'],
    ['(a) => new WebSocket("wss://x.com")', 'WebSocket'],
    ['(a) => new XMLHttpRequest()', 'XMLHttpRequest'],
    // Sandbox-ESCAPE vectors — the whole point of the denylist. The
    // Function-constructor-via-.constructor.constructor bypass reaches
    // global `this` (→ process/require) on the Node runtime.
    ["(a) => (0).constructor.constructor('return this')()", 'constructor access'],
    ['(a) => (0)["constructor"]["constructor"]("return this")()', 'constructor access'],
    ["(a) => (0)['constructor']['constructor']('return this')()", 'constructor access'],
    ['(a) => [].constructor', 'constructor access'],
    ['(a) => a.prototype', 'prototype access'],
    ['(a) => this.\\u0063onstructor', 'escaped identifier'],
  ])('rejects %s', (code, label) => {
    const r = validateToolCode(code)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(label)
  })

  it('the .constructor.constructor escape cannot reach globals at runtime', async () => {
    // Belt-and-suspenders: validateToolCode blocks it, but confirm the
    // execution path also refuses (validate runs inside runUserTool).
    await expect(runUserTool("(a) => (0).constructor.constructor('return this')()", {}))
      .rejects.toThrow(/forbidden|constructor/)
  })
})

describe('runUserTool', () => {
  it('runs a pure function with args', async () => {
    const out = await runUserTool('(args) => args.text.split("").reverse().join("")', { text: 'abc' })
    expect(out).toBe('cba')
  })

  it('returns structured results', async () => {
    const out = await runUserTool('(args) => ({ sum: Number(args.a) + Number(args.b) })', { a: '2', b: '3' })
    expect(out).toEqual({ sum: 5 })
  })

  it('supports async tools', async () => {
    const out = await runUserTool('async (args) => { return "done-" + args.x }', { x: '1' })
    expect(out).toBe('done-1')
  })

  it('freezes args — mutation throws in strict mode', async () => {
    await expect(runUserTool('(args) => { args.x = "hacked"; return args.x }', { x: 'safe' }))
      .rejects.toThrow()
  })

  it('clamps giant string results', async () => {
    const out = await runUserTool('(args) => "y".repeat(50000)', {})
    expect(out.length).toBeLessThan(21000)
    expect(out).toContain('…[truncated]')
  })

  it('returns objects as objects (not stringified) under the cap', async () => {
    expect(await runUserTool('(args) => ({ a: 1, b: [2, 3] })', {})).toEqual({ a: 1, b: [2, 3] })
  })

  it('circular result degrades gracefully instead of throwing', async () => {
    // JSON.stringify throws on a cycle — must be caught, not propagated.
    // (property name avoids the denylist: 'self' is a banned identifier)
    const out = await runUserTool('(args) => { const o = {}; o.loop = o; return o }', {})
    expect(typeof out).toBe('string')
    expect(out).toMatch(/could not be serialized/)
  })

  it('clamps a giant object result to the truncated string form', async () => {
    const out = await runUserTool('(args) => ({ big: "z".repeat(30000) })', {})
    expect(typeof out).toBe('string')
    expect(out).toContain('…[truncated]')
  })

  it('times out hung async tools', async () => {
    await expect(runUserTool('(args) => new Promise(() => {})', {}))
      .rejects.toThrow(/timeout/)
  }, 15_000)

  it('blocks non-https fetch through the guarded fetch', async () => {
    await expect(runUserTool('(args) => fetch("http://example.com")', {}))
      .rejects.toThrow(/blocked/)
  })

  it('blocks internal-host fetch (SSRF)', async () => {
    await expect(runUserTool('(args) => fetch("https://localhost/admin")', {}))
      .rejects.toThrow(/blocked/)
    await expect(runUserTool('(args) => fetch("https://169.254.169.254/latest/meta-data/")', {}))
      .rejects.toThrow(/blocked/)
  })

  it('bounds an oversized response body (memory-exhaustion guard)', async () => {
    // A 5MB body must not be fully buffered — guardedFetch caps at 100KB
    const huge = 'x'.repeat(5_000_000)
    global.fetch = vi.fn(async () => new Response(huge, {
      status: 200, headers: { 'content-type': 'text/plain' },
    })) as any
    const out = await runUserTool('(args) => fetch("https://example.com/big").then(r => r.text())', {})
    expect(typeof out).toBe('string')
    expect(out.length).toBeLessThanOrEqual(100_000)
  })

  it('rejects a body whose Content-Length declares it oversized (no read)', async () => {
    let bodyRead = false
    const stream = new ReadableStream({
      start(c) { bodyRead = true; c.enqueue(new TextEncoder().encode('data')); c.close() },
    })
    global.fetch = vi.fn(async () => new Response(stream, {
      status: 200, headers: { 'content-length': String(50_000_000) },
    })) as any
    const out = await runUserTool('(args) => fetch("https://example.com/huge").then(r => r.text())', {})
    // declared > 4× cap → cancelled, empty body, never fully read
    expect(out).toBe('')
  })

  it('small responses pass through intact', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, n: 42 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as any
    const out = await runUserTool('(args) => fetch("https://example.com/api").then(r => r.body)', {})
    expect(out).toEqual({ ok: true, n: 42 })
  })
})

describe('isolate containment (the HARD boundary — fresh vm context)', () => {
  // The tool runs in a fresh V8 context, so its built-ins are the CONTEXT'S
  // own. Reaching the Function constructor through them (even word-free, past
  // the denylist) yields the SANDBOX global, which has no process/require.
  // This is the property that actually matters — not that a given name is
  // undefined (in a real context Array/Object/Reflect naturally EXIST; they
  // just can't reach the host).

  it('a word-free constructor escape cannot reach the host process (was exploitable)', async () => {
    // Builds "constructor" + "process" at runtime → passes the denylist.
    // Under the old `new Function` sandbox this leaked process.env; the vm
    // context contains it. (globalThis-scoped so no banned literal.)
    const code = '(a) => { const g = Array["con"+"structor"]("return this")(); const p = g["pro"+"cess"]; return p ? "ESCAPED" : "contained"; }'
    // sanity: this specific payload is NOT caught by the denylist
    expect(validateToolCode(code).ok).toBe(true)
    expect(await runUserTool(code, {})).toBe('contained')
  })

  it('reaching through the injected fetch fn also stays contained', async () => {
    const code = '(a) => { const g = fetch["con"+"structor"]("return this")(); const p = g["pro"+"cess"]; return p ? "ESCAPED" : "contained"; }'
    expect(await runUserTool(code, {})).toBe('contained')
  })

  it('the raw host fetch fn is NOT reachable on the sandbox global (was a host escape)', async () => {
    // REGRESSION: the seed injected `guardedFetch` as `this.__fetch` (a HOST
    // function) and deleted only `__argsJson`, leaving `__fetch` reachable. Its
    // `.constructor` is the HOST realm's Function, so this word-free payload
    // read the host process.env (INTERNAL_API_KEY / JWT secret). The wrapper
    // `fetch` was always safe (context realm) — the leak was the raw `__fetch`.
    const code = '(a) => { try { const g = __fetch["con"+"structor"]("return this")(); return g["pro"+"cess"] ? "ESCAPED" : "contained"; } catch (e) { return "unreachable"; } }'
    expect(validateToolCode(code).ok).toBe(true)
    expect(await runUserTool(code, {})).toBe('unreachable')
  })

  it('the fetch RETURN VALUE carries no host realm — Promise / response / Error all contained', async () => {
    // REGRESSION (c17 return-value leak): closing the __fetch REFERENCE hole
    // left the guarded fetch's RETURN host-realm. A host Promise, the host
    // response object it resolves to, and a host Error it rejects with each
    // expose `.constructor.constructor` → host global (process.env →
    // INTERNAL_API_KEY / JWT secret). guardedFetch now returns a realm-less
    // JSON string the wrapper rebuilds in-realm. Prove all three vectors.
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ n: 1 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as any

    // (a) the Promise object returned by fetch(u)
    const viaPromise = '(a) => { const k="con"+"structor"; const g = fetch("https://example.com")[k][k]("return this")(); return g["pro"+"cess"] ? "ESCAPED" : "contained"; }'
    expect(await runUserTool(viaPromise, {})).toBe('contained')

    // (b) the response object fetch resolves to
    const viaResponse = '(a) => fetch("https://example.com").then(r => { const k="con"+"structor"; const g = r[k][k]("return this")(); return g["pro"+"cess"] ? "ESCAPED" : "contained"; })'
    expect(await runUserTool(viaResponse, {})).toBe('contained')

    // (c) the Error a blocked/failed fetch rejects with
    const viaError = '(a) => fetch("http://blocked.example.com").catch(e => { const k="con"+"structor"; const g = e[k][k]("return this")(); return g["pro"+"cess"] ? "ESCAPED" : "contained"; })'
    expect(await runUserTool(viaError, {})).toBe('contained')
  })

  it('a blocked fetch still throws a catchable (context-realm) error', async () => {
    // The envelope __error must surface as a real throw the tool can .catch,
    // not silently resolve — behavior parity with the old host-Error throw.
    const code = '(a) => fetch("http://insecure.example.com").then(() => "no-throw").catch(e => "caught:" + e.message)'
    const out = await runUserTool(code, {})
    expect(out).toContain('caught:')
    expect(out).toContain('blocked')
  })

  it('reaching through the caller-controlled args object stays contained', async () => {
    // args is the ONE object the caller fully controls — its constructor chain
    // must still resolve to the sandbox realm, not the host.
    const code = '(a) => { const k = "con"+"structor"; const g = a[k][k]("return this")(); return g["pro"+"cess"] ? "ESCAPED" : "contained"; }'
    expect(await runUserTool(code, { x: 1 })).toBe('contained')
  })

  it('reaching through an injected native (JSON) stays contained', async () => {
    const code = '(a) => { const k = "con"+"structor"; const g = JSON.stringify[k]("return this")(); return g["pro"+"cess"] ? "ESCAPED" : "contained"; }'
    expect(await runUserTool(code, {})).toBe('contained')
  })

  it('prototype pollution is confined to the disposable context, not the host', async () => {
    // Mutating a shared intrinsic inside the sandbox must not touch the host's
    // Object.prototype / Function.prototype.
    await runUserTool('(a) => { Object.getPrototypeOf(Object).__pwned = 1; return 1 }', {}).catch(() => {})
    expect(({} as any).__pwned).toBeUndefined()
    expect((function () {} as any).__pwned).toBeUndefined()
  })

  it('legit tools still run in the isolate', async () => {
    expect(await runUserTool("(a) => a.text.toUpperCase()", { text: 'hi' })).toBe('HI')
    expect(await runUserTool("(a) => [1,2,3].map(x => x * 2)", {})).toEqual([2, 4, 6])
    expect(await runUserTool("async (a) => { return Number(a.n) + 1 }", { n: '4' })).toBe(5)
    expect(await runUserTool("(a) => Object.keys(a)", { x: 1, y: 2 })).toEqual(['x', 'y'])
    // Object statics tools use are natively available in the context now
    expect(await runUserTool("(a) => Object.entries(a)", { y: 2 })).toEqual([['y', 2]])
    expect(await runUserTool("(a) => Object.fromEntries([['k','v']])", {})).toEqual({ k: 'v' })
  })
})

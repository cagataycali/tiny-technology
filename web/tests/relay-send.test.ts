// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { classifyRelaySend, relaySend, type RelaySendKind } from '../lib/chat/relay-send'

/**
 * 🔴 "relay send failed" — the user's own report, and a claim with nothing behind it.
 *
 * Five server-side callers shared one line:
 *
 *   .then(r => r.json()).catch(e => ({ error: String(e) }))
 *   if (sent.error || !sent.id) return { error: sent.error || 'relay send failed' }
 *
 * `r.status` is dropped, so a 404 "device not found" (the worker refused, nothing
 * was queued) and a 503 (the relay broke mid-decision, nobody knows) come out the
 * same. And the fallback fires exactly when NOTHING is known — a 2xx with no
 * error and no id — where "failed" is a guess that can send a user chasing a
 * device that already got the message.
 *
 * The rule these pins enforce, in one line: **`delivered: 'no'` may only be
 * claimed for a decision, and a decision is a 4xx.** `theWorkerProvesIt` below
 * checks that licence against the worker's own source rather than trusting it.
 */

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/** Comments stripped — this module quotes the line it replaced, verbatim. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ALL_KINDS: RelaySendKind[] = [
  'queued', 'no_such_device', 'too_big', 'bad_request',
  'server_key', 'relay_fault', 'unreachable', 'no_envelope',
]

/** One input per kind — the table every invariant below is quantified over. */
const CASES: { kind: RelaySendKind; input: Parameters<typeof classifyRelaySend>[0] }[] = [
  { kind: 'queued', input: { status: 200, body: { ok: true, id: 'env-1' } } },
  { kind: 'no_such_device', input: { status: 404, body: { error: 'device not found' } } },
  { kind: 'too_big', input: { status: 400, body: { error: 'payload must be valid JSON ≤8KB' } } },
  { kind: 'bad_request', input: { status: 400, body: { error: 'userId and toDevice required' } } },
  { kind: 'server_key', input: { status: 401, body: { error: 'unauthorized' } } },
  { kind: 'relay_fault', input: { status: 503, body: null } },
  { kind: 'unreachable', input: { threw: new Error('fetch failed') } },
  { kind: 'no_envelope', input: { status: 200, body: { ok: true } } },
]

describe('what the relay did, and what may be claimed about it', () => {
  it('every answer the relay can give is classified, and the table is complete', () => {
    expect(new Set(CASES.map(c => c.kind)).size, 'a kind lost its case in this table')
      .toBe(ALL_KINDS.length)
    for (const { kind, input } of CASES) {
      expect(classifyRelaySend({ ...input, deviceName: 'Mac mini' }).kind,
        `${kind}: the wrong verdict for ${JSON.stringify(input)}`).toBe(kind)
    }
  })

  it('⭐ only a 4xx decision may claim nothing was sent', () => {
    // The whole increment in one assertion. A 5xx, a dead socket and a 2xx with
    // no envelope id all mean the same thing — NOBODY KNOWS — and the old line
    // reported all three as a failure.
    const DECIDED: RelaySendKind[] = ['no_such_device', 'too_big', 'bad_request', 'server_key']
    for (const { kind, input } of CASES) {
      const out = classifyRelaySend(input)
      if (out.queued) continue
      expect(out.delivered, `${kind} claims the wrong thing about delivery`)
        .toBe(DECIDED.includes(kind) ? 'no' : 'unknown')
      // …and the sentence has to agree with the field. A verdict of "unknown"
      // paired with prose that asserts is the original defect wearing a type.
      if (out.delivered === 'unknown') {
        expect(out.error, `${kind} asserts in prose what its verdict calls unknown`)
          .toMatch(/not known|may still have/)
        expect(out.error.toLowerCase(), `${kind} still says "failed" about an unknown`)
          .not.toContain('send failed')
      } else {
        expect(out.error, `${kind} decided nothing was sent but does not say so`)
          .toMatch(/[Nn]othing (was sent|reached)/)
      }
    }
  })

  it('an identical retry is only offered where it could work', () => {
    // A 2xx-with-no-id is the trap: the insert may have happened, so an automatic
    // retry can run the same command on the device twice.
    const RETRYABLE: RelaySendKind[] = ['relay_fault', 'unreachable']
    for (const { kind, input } of CASES) {
      const out = classifyRelaySend(input)
      if (out.queued) continue
      expect(out.retryable, `${kind} is wrong about whether retrying helps`)
        .toBe(RETRYABLE.includes(kind))
    }
    const noEnvelope = classifyRelaySend({ status: 200, body: { ok: true } })
    expect(noEnvelope.queued).toBe(false)
    if (!noEnvelope.queued) {
      expect(noEnvelope.error, 'the double-execute risk is not spelled out')
        .toContain('check before sending the same thing again')
    }
  })

  it('no refusal hands the worker’s wire string to the user', () => {
    // `unauthorized` is the one that matters: it is tiny's OWN internal key being
    // rejected, and the user hears a word that means "you are not allowed".
    const seen = new Set<string>()
    for (const { kind, input } of CASES) {
      const out = classifyRelaySend({ ...input, deviceName: 'necklace' })
      if (out.queued) continue
      expect(out.error.length, `${kind} is too terse to be an explanation`).toBeGreaterThan(40)
      expect(['device not found', 'unauthorized', 'relay send failed', 'send failed'],
        `${kind} still returns a bare wire string`).not.toContain(out.error)
      expect(seen.has(out.error), `${kind} shares a sentence with another kind`).toBe(false)
      seen.add(out.error)
    }
    const key = classifyRelaySend({ status: 401, body: { error: 'unauthorized' } })
    expect(key.queued).toBe(false)
    if (!key.queued) {
      // It must NOT read as the user's problem: they are signed in correctly and
      // there is nothing for them to do.
      expect(key.error, 'a server-key fault still reads as the user being unauthorized')
        .toMatch(/tiny's own server key|server-side/)
      // ⚠️ The INSTRUCTION, not the word: a first draft banned /log ?in/ and so
      // failed on "the user's login is fine", which is the sentence doing the
      // reassuring. What may not appear is a demand that they authenticate again.
      expect(key.error.toLowerCase(), 'it tells a signed-in user to authenticate again')
        .not.toMatch(/log ?in again|sign ?in again|sign back in|re-?authenticat/)
      expect(key.error, 'it does not say the user’s own credential is fine')
        .toMatch(/login is fine|nothing they can do/)
    }
  })

  it('an absent status is treated as unknown, never as 200', () => {
    // Many existing fetch mocks implement `json` alone, and a real transport that
    // threw has no status either. Reading a missing status as 200 would let a
    // classifier call a body-less failure "queued".
    expect(classifyRelaySend({ body: { error: 'device not found' } }).kind).toBe('no_such_device')
    expect(classifyRelaySend({ body: { id: 'env-9' } })).toEqual({ queued: true, kind: 'queued', id: 'env-9' })
    const blank = classifyRelaySend({ body: null })
    expect(blank.kind, 'no status and no body was read as success').toBe('no_envelope')
    // A 4xx body whose prose the worker has since reworded still lands as a
    // decision, because the STATUS carries the verdict once the text is unknown.
    const reworded = classifyRelaySend({ status: 409, body: { error: 'device is being re-enrolled' } })
    expect(reworded.queued).toBe(false)
    if (!reworded.queued) {
      expect(reworded.delivered).toBe('no')
      expect(reworded.error, 'a reworded refusal loses its reason').toContain('device is being re-enrolled')
    }
  })

  it('a 5xx that also names a reason is still not a decision', () => {
    // The relay can break WITH a body: a proxy in front of it answering 503 and
    // echoing the last prose, a half-deployed worker returning 500 alongside its
    // old string. Matching prose BEFORE the status would turn "the relay broke"
    // into "your device is gone" — a decision nobody made, on a request whose
    // insert may already have happened. The guard order is the whole defence.
    for (const status of [500, 502, 503]) {
      const out = classifyRelaySend({
        status, body: { error: 'device not found' }, deviceName: 'Mac mini',
      })
      expect(out.queued).toBe(false)
      if (out.queued) continue
      expect(out.kind, `HTTP ${status} carrying prose was read as a decision`).toBe('relay_fault')
      expect(out.delivered, `HTTP ${status} claims to know what happened`).toBe('unknown')
      expect(out.error).toMatch(/not known whether/)
    }
  })

  it('the device is named, and it is the HOST that failed, not the peripheral', () => {
    const withName = classifyRelaySend({ status: 503, deviceName: 'Mac mini' })
    const without = classifyRelaySend({ status: 503 })
    expect(withName.queued).toBe(false)
    if (!withName.queued && !without.queued) {
      expect(withName.error).toContain('"Mac mini"')
      // A sentence-initial fallback has to be capitalised — the anonymous form
      // reached the model as `the device is not on this account…` mid-report.
      const anon = classifyRelaySend({ status: 404, body: { error: 'device not found' } })
      expect(anon.queued).toBe(false)
      if (!anon.queued) expect(anon.error.startsWith('That device')).toBe(true)
      expect(without.error, 'the anonymous form leaks an empty quote').not.toContain('""')
    }
  })
})

describe('the send itself', () => {
  const withFetch = async (impl: (url: string, init: RequestInit) => any, run: () => Promise<void>) => {
    const original = globalThis.fetch
    globalThis.fetch = ((u: any, init: RequestInit) => impl(String(u), init)) as any
    try { await run() } finally { globalThis.fetch = original }
  }

  it('carries a deadline of its own, and a hang is an unknown', async () => {
    // All four tool callers hand-rolled this fetch with NO signal, so a relay
    // that accepted the connection and went quiet held the agent's turn until
    // something else killed it — and the user was told nothing. The bound
    // belongs here, once, not in four call sites that already forgot it.
    const inits: RequestInit[] = []
    await withFetch((_u, init) => { inits.push(init); throw new Error('signal timed out') }, async () => {
      const out = await relaySend({
        worker: 'https://relay.invalid', headers: {}, userId: 'u_1',
        toDevice: 'dev_1', payload: '{}', deviceName: 'necklace',
      })
      expect(inits[0]?.signal, 'the send can hang forever again').toBeInstanceOf(AbortSignal)
      expect(out.queued).toBe(false)
      if (!out.queued) {
        expect(out.kind).toBe('unreachable')
        // ⚠️ The whole point: a timeout is NOT proof nothing was sent. The
        // request may have been read and inserted before the socket went quiet.
        expect(out.delivered).toBe('unknown')
        expect(out.error).toContain('"necklace"')
      }
    })
  })

  it("reads the response's status, which is what nobody did", async () => {
    // A body-only mock (`{ json }`, no status) is what most of this repo's fetch
    // mocks look like, and reading its absent status as 200 would call a refusal
    // a success. Both shapes have to land on the same verdict.
    for (const res of [
      { status: 404, json: async () => ({ error: 'device not found' }) },
      { json: async () => ({ error: 'device not found' }) },
    ]) {
      await withFetch(() => res as any, async () => {
        const out = await relaySend({
          worker: 'https://relay.invalid', headers: {}, userId: 'u_1',
          toDevice: 'dev_1', payload: '{}',
        })
        expect(out.kind, `status ${res.status ?? 'absent'} was misread`).toBe('no_such_device')
      })
    }
  })
})

describe('every caller asks the shared rule', () => {
  it('no server-side file invents its own send verdict', () => {
    const files: string[] = []
    for (const dir of ['lib/chat', 'lib/chat/tools', 'app/api/devices/relay']) {
      for (const f of readdirSync(join(ROOT, dir))) {
        if (f.endsWith('.ts') || f.endsWith('.tsx')) files.push(`${dir}/${f}`)
      }
    }
    expect(files.length, 'the scan found almost nothing — these pins are vacuous').toBeGreaterThan(15)
    for (const f of files) {
      const s = code(src(f))
      // ⚠️ THE DEFECT, as a regex: a fallback sentence a caller made up.
      expect(s, `${f} invents a send verdict again`).not.toMatch(/\|\|\s*'(relay )?send failed'/)
      if (f === 'lib/chat/relay-send.ts') continue
      // Nobody else may build the request either — a hand-rolled fetch is how the
      // status came to be dropped five times over.
      expect(s, `${f} builds its own relay send instead of calling relaySend`)
        .not.toMatch(/fetch\(`\$\{WORKER(_URL)?\}\/device\/relay\/send`/)
    }
  })

  it('every caller of the rule is a declared one', () => {
    // Per FILE, and enumerated: a caller gained in one file cancels one lost in
    // another when this is compared as a single total.
    const DECLARED: Record<string, number> = {
      'lib/chat/tools/nicla.ts': 1,        // the necklace's photo/video/listen invoke
      'lib/chat/tools/nicla-voice.ts': 1,  // the phone-side voice recording
      'lib/chat/tools/flipper.ts': 1,      // the Flipper's host machine or phone
      'lib/chat/tools/platform.ts': 1,     // use_device, incl. the wait:false ticket
      'app/api/devices/relay/route.ts': 1, // the session POST the iOS panels use
    }
    const found: Record<string, number> = {}
    for (const dir of ['lib/chat', 'lib/chat/tools', 'app/api/devices/relay']) {
      for (const f of readdirSync(join(ROOT, dir))) {
        if (!f.endsWith('.ts')) continue
        const p = `${dir}/${f}`
        if (p === 'lib/chat/relay-send.ts') continue
        const s = code(src(p))
        const n = (s.match(/await relaySend\(/g) ?? []).length
        if (n) {
          found[p] = n
          // Every caller knows a name for what it is talking to, and a refusal
          // that says "dev_8f3c" is about something the user has never seen. The
          // route is the exception: its caller passes an id and nothing else.
          if (!p.startsWith('app/api/'))
            expect(s, `${p} stopped naming the device in its refusals`).toMatch(/deviceName:/)
        }
      }
    }
    expect(found, 'a surface joined or left the shared rule — give it a line and a reason')
      .toEqual(DECLARED)
  })

  it('the route answers with a status per verdict, and never 200 without an envelope', () => {
    const route = code(src('app/api/devices/relay/route.ts'))
    // The old line picked the status by string-matching the worker's prose.
    expect(route, 'the route is string-matching the worker’s prose again')
      .not.toMatch(/error === 'device not found'/)
    // A success is an envelope id and nothing else. `{ok:true, id: undefined}`
    // serialises to `{ok:true}`, which iOS read as "Couldn't reach the relay."
    expect(route, 'the route can return ok:true without an id again')
      .toMatch(/if \(!sent\.queued\) return json\(/)
    expect(route).toMatch(/return json\(\{ ok: true, id: sent\.id \}\)/)
    for (const kind of ALL_KINDS) {
      if (kind === 'queued') continue
      expect(route, `the status table has no entry for ${kind}`)
        .toMatch(new RegExp(`${kind}: [45]\\d\\d`))
    }
  })

  it('⭐ every status the route answers lets the sentence through on iOS', () => {
    // The sentences above are the increment. A status the CLIENT overrides makes
    // all of them unreachable on the surface that reported the bug — and 502 for
    // a proxy whose upstream refused its key is the obvious, wrong choice.
    const api = 'ios/Tiny/Sources/Api.swift'
    if (!existsSync(join(ROOT, api))) return   // web-only checkout
    const owns = src(api).match(/static func statusOwnsTheMessage\(_ status: Int\) -> Bool \{\n\s*(.+)\n/)
    expect(owns, 'statusOwnsTheMessage is gone or renamed — the rule below is unverified')
      .not.toBeNull()
    // Read from the app, and pinned verbatim: a reformat must fail here rather
    // than let the derived set below quietly stop describing the app.
    expect(owns![1], 'the app-side rule changed shape — re-derive the swallowed set')
      .toBe('status == 401 || status == 0 || (500...599).contains(status)')
    const swallowed = (s: number) => s === 401 || s === 0 || (s >= 500 && s <= 599)

    const route = code(src('app/api/devices/relay/route.ts'))
    const at = route.indexOf('const RELAY_SEND_STATUS')
    expect(at, 'the status table was renamed').toBeGreaterThan(-1)
    // `Array.from`, not a spread: tsconfig targets es5, where `[...matchAll()]`
    // is a tsc error the vitest run would never show.
    const table = Array.from(route.slice(at, route.indexOf('}', at)).matchAll(/(\w+): (\d{3}),/g))
    expect(table.length, 'the status table did not parse — this pin is vacuous')
      .toBe(ALL_KINDS.length - 1)
    for (const [, kind, n] of table) {
      expect(swallowed(Number(n)),
        `${kind} answers ${n}, so iOS drops the sentence and shows "Server hiccup … try again"`)
        .toBe(false)
    }
  })
})

describe('the licence for claiming nothing was sent', () => {
  it('⭐ the worker proves it: every 4xx precedes the INSERT', () => {
    // `delivered: 'no'` is only honest because the worker refuses BEFORE queueing.
    // That is a fact about another repo's source, so it is checked, not assumed —
    // if a refusal ever moves below the insert, this fails and the verdict table
    // above becomes a lie that no other test can see.
    const p = 'worker/src/relay.ts'
    if (!existsSync(join(ROOT, p))) return   // worker submodule not checked out
    const s = src(p)
    const at = s.indexOf('export class RelaySendCall')
    expect(at, 'RelaySendCall not found — renamed?').toBeGreaterThan(-1)
    const handler = s.slice(at, s.indexOf('export class', at + 10))
    const insert = handler.indexOf('RELAY_INSERT_SQL')
    expect(insert, 'the insert is gone — this proof is vacuous').toBeGreaterThan(-1)
    const refusals = Array.from(handler.matchAll(/return json\(\{ error: [^)]*\}, (\d{3})\)/g))
    expect(refusals.length, 'no refusals found — the scrape broke').toBeGreaterThanOrEqual(4)
    for (const m of refusals) {
      const status = Number(m[1])
      expect(status, `the worker refuses a send with ${status}, which is not a decision`)
        .toBeLessThan(500)
      expect(m.index!, `a ${status} refusal now happens AFTER the insert — "Nothing was sent" is false`)
        .toBeLessThan(insert)
    }
    // And the success arm is the only thing past it.
    expect(handler.slice(insert), 'the queued arm stopped returning an id')
      .toMatch(/return json\(\{ ok: true, id \}\)/)
  })
})

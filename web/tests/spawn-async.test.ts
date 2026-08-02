// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { batchTicket, buildBatchResultText, buildBatchPush, runBatchInBackground } from '../lib/chat/tools/spawn'
import { workerFile, workerPresent, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('spawn-async')

/**
 * 🤖 spawn_agents wait:false (S2 — docs/spawn-agents-async-design-2026-08-02.md).
 *
 * The batch continues past the closed stream (after()) and parks its
 * aggregate on the worker as a batch_* deposit. Pinned here: the web ticket
 * satisfies the WORKER's namespace gate (lockstep across repos), the deposit
 * payload obeys the 8KB relay rule with fair per-task budgeting, the push is
 * counts-only + self-redeeming, and EVERY path deposits — including a batch
 * that dies mid-run.
 */

describe('batchTicket ↔ worker namespace (lockstep)', () => {
  it.skipIf(!workerPresent)('every generated ticket passes the worker gate that guards deposits', async () => {
    const relay: any = await import(workerFile('relay.ts') /* @vite-ignore */)
    for (let i = 0; i < 20; i++) expect(relay.isBatchTicket(batchTicket())).toBe(true)
  })

  it('tickets are batch_-namespaced and unique', () => {
    const a = batchTicket(), b = batchTicket()
    expect(a.startsWith('batch_')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('buildBatchResultText — the 8KB relay rule with fair shares', () => {
  it('a talkative sub-agent cannot evict its siblings', () => {
    const results = [
      { task: 1, ok: true, result: 'A'.repeat(50_000) },
      { task: 2, ok: true, result: 'the vital short answer' },
      { task: 3, ok: false, error: 'timeout' },
    ]
    const text = buildBatchResultText(results, 42_000)
    expect(JSON.stringify({ result: text }).length).toBeLessThanOrEqual(8192) // worker PAYLOAD_MAX
    expect(text).toContain('the vital short answer')  // task 2 survived task 1's flood
    expect(text).toContain('❌ Task 3: timeout')
    expect(text).toContain('2/3 tasks completed')
    expect(text).toContain('42s')
  })

  it('a huge batch still serializes under the payload cap', () => {
    const results = Array.from({ length: 64 }, (_, i) => ({ task: i + 1, ok: true, result: 'R'.repeat(2000) }))
    expect(JSON.stringify({ result: buildBatchResultText(results, 1000) }).length).toBeLessThanOrEqual(8192)
  })
})

describe('buildBatchPush — one notification, counts only, self-redeeming', () => {
  it('body carries counts, never result content; url teaches the redeem move', () => {
    const p = buildBatchPush('batch_abc12345', 5, 1)
    expect(p.title).toBe('🤖 agent batch finished')
    expect(p.body).toBe('5/6 tasks completed (1 failed) — tap to read the results.')
    const q = new URL('https://x' + p.url).searchParams.get('q')!
    expect(q).toContain("use_device action:'result'")
    expect(q).toContain("envelope_id:'batch_abc12345'")
    expect(p.tag).toBe('batch-batch_abc12345')
  })

  it('a clean batch drops the failure clause', () => {
    expect(buildBatchPush('batch_abc12345', 3, 0).body).toBe('3/3 tasks completed — tap to read the results.')
  })
})

describe('runBatchInBackground — every path deposits, deposit first', () => {
  let calls: Array<{ url: string; body: any }>
  const collectFetch = () => {
    calls = []
    global.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return { json: async () => ({ ok: true }) } as unknown as Response
    }) as typeof fetch
  }
  const immediate = (fn: () => Promise<void>) => { void fn() }
  const flush = () => new Promise(r => setTimeout(r, 10))

  it('success: deposit → event → push, in that order, all user-scoped and namespaced', async () => {
    collectFetch()
    runBatchInBackground({
      userId: 'u1', ticket: 'batch_ok1234567', schedule: immediate,
      run: async () => ({ results: [{ task: 1, ok: true, result: 'done' }], elapsedMs: 5000 }),
    })
    await flush()
    expect(calls.map(c => new URL(c.url).pathname)).toEqual(['/device/relay/deposit', '/events', '/push/send'])
    const dep = calls[0].body
    expect(dep.userId).toBe('u1')
    expect(dep.ticket).toBe('batch_ok1234567')
    expect(JSON.parse(dep.payload).result).toContain('done')
    expect(calls[1].body.kind).toBe('batch_result')
    expect(calls[2].body.tag).toBe('batch-batch_ok1234567')
  })

  it('a batch that THROWS still deposits an honest failure — never a silent discard', async () => {
    collectFetch()
    runBatchInBackground({
      userId: 'u1', ticket: 'batch_boom123456', schedule: immediate,
      run: async () => { throw new Error('model provider fell over') },
    })
    await flush()
    expect(new URL(calls[0].url).pathname).toBe('/device/relay/deposit')
    expect(JSON.parse(calls[0].body.payload).result).toContain('model provider fell over')
    // and the push still announces (the user must learn it ENDED, even badly)
    expect(calls.map(c => new URL(c.url).pathname)).toContain('/push/send')
  })
})

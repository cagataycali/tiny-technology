// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('relay-task-result')

/**
 * 💻 Daemon task completions (worker RelayTaskResultCall) — the LAST hole in
 * "trigger and forget on the Mac". The daemon's agent offloads long work to
 * use_tasks and replies "Task started…" IN-WINDOW, so the late-reply push
 * never fires; the finished result only showed a desktop notification. Now
 * the daemon posts completions on its DEVICE TOKEN and they get the full
 * treatment: a task_* deposit (same recv redemption), a device_task_result
 * ring event (💻 for free via the `device` prefix key), one push.
 *
 * Pinned here: the ticket namespace (device-scoped, collision-proof), the
 * push payload (summary is the user's own ask, self-redeeming url), and the
 * source-order/wiring contracts.
 */
let relay: any

beforeAll(async () => {
  if (!present) return
  relay = await import(workerFile('relay.ts') /* @vite-ignore */)
})

describe.skipIf(!present)('taskTicket — device-scoped, collision-proof', () => {
  it('binds the daemon-supplied taskId to the authed device id', () => {
    expect(relay.taskTicket('2b7f3e0f-aaaa-bbbb-cccc-dddddddddddd', 't20260802054431001'))
      .toBe('task_2b7f3e0f_t20260802054431001')
  })

  it('rejects taskIds that could escape the namespace or bloat the row', () => {
    for (const bad of ['', 'a b', "x'; --", 'x'.repeat(49), 'ü', 'a/b']) {
      expect(relay.taskTicket('d1', bad)).toBeNull()
    }
  })

  it('task_ tickets can never pass the batch deposit gate — namespaces stay disjoint', () => {
    expect(relay.isBatchTicket(relay.taskTicket('d1', 't1234567'))).toBe(false)
  })
})

describe.skipIf(!present)('buildTaskResultPush — one push, self-redeeming', () => {
  it('carries device name, the ask summary, and the redeem turn', () => {
    const p = relay.buildTaskResultPush({
      ticket: 'task_2b7f3e0f_t123', deviceName: 'studio-mac', summary: 'run the nightly build',
    })
    expect(p.title).toBe('💻 studio-mac finished a background task')
    expect(p.body).toContain('run the nightly build')
    const q = new URL('https://x' + p.url).searchParams.get('q')!
    expect(q).toContain("use_device action:'result'")
    expect(q).toContain("envelope_id:'task_2b7f3e0f_t123'")
    expect(p.tag).toBe('task-result-task_2b7f3e0f_t123')
  })

  it('degrades gracefully without a name or summary and respects push clamps', () => {
    const p = relay.buildTaskResultPush({ ticket: 'task_d1_t1', summary: 's'.repeat(1000) })
    expect(p.title).toBe('💻 your device finished a background task')
    expect(p.title.length).toBeLessThanOrEqual(100)
    expect(p.body.length).toBeLessThanOrEqual(400)
  })
})

describe.skipIf(!present)('wiring pins', () => {
  it('the route is registered and the handler deposits before it announces', () => {
    const index = readFileSync(workerFile('index.ts'), 'utf8')
    expect(index).toContain("router.post('/device/task-result', RelayTaskResultCall)")
    const src = readFileSync(workerFile('relay.ts'), 'utf8')
    const handler = src.slice(src.indexOf('class RelayTaskResultCall'))
    const deposit = handler.indexOf('RELAY_INSERT_SQL')
    const event = handler.indexOf('emitEvent(')
    const push = handler.indexOf('sendPushToUser(')
    expect(deposit).toBeGreaterThan(-1)
    expect(event).toBeGreaterThan(deposit)
    expect(push).toBeGreaterThan(event)
    // device-token auth comes BEFORE any write — the security order
    expect(handler.indexOf('authDevice(')).toBeLessThan(deposit)
  })

  it('the kind rides the existing 💻 prefix key on the web roster', async () => {
    const { iconFor, EMITTED_KINDS } = await import('../lib/chat/event-icons')
    expect(iconFor('device_task_result')).toBe('💻')
    expect(EMITTED_KINDS).toContain('device_task_result')
  })
})

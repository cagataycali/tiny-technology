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

describe.skipIf(!present)('the ticket namespaces use_device is TOLD about', () => {
  /**
   * ⚠️ The reader of this contract is the MODEL, not a test — which is why
   * every suite here was green while it was broken. `use_device`'s schema
   * described exactly two shapes ("an envelope id, or a batch_* ticket") and
   * the codebase mints THREE, the third being the one this very file creates:
   * a task_* deposit, redeemed by the identical recv path (in_reply_to =
   * ticket, to_device = ''). So the two surfaces that close the user's
   * "trigger and forget on the Mac" ask — the self-redeeming push and the
   * device_task_result ring row — both hand the model an id its own tool
   * documentation said did not exist. Nothing REJECTS it (recv is opaque, so
   * it would have worked if tried); the failure is a model that reads its
   * schema, sees an unlisted shape, and reasonably declines or asks the user
   * to re-run the task instead of fetching the result already sitting in D1.
   *
   * Derived, never transcribed: the census comes from the MINTERS' own
   * template literals, so a fourth namespace fails this the day it is minted
   * rather than the day someone remembers to update a hand-written list.
   */
  const MINTERS = [
    // [file, floor] — the floor is the fail-closed half: this scrape reads a
    // regex out of source, and a renamed helper or a moved file would yield
    // an EMPTY census that passes every assertion below vacuously.
    { src: () => readFileSync(workerFile('relay.ts'), 'utf8'), floor: 'task_' },
    { src: () => readFileSync(new URL('../lib/chat/tools/spawn.ts', import.meta.url), 'utf8'), floor: 'batch_' },
  ]

  const census = () => {
    const found = new Set<string>()
    for (const m of MINTERS) {
      const hits = Array.from(m.src().matchAll(/`([a-z][a-z0-9]*_)\$\{/g), (x) => x[1])
      expect(hits, `no ticket minter found in the source that owns "${m.floor}" — this scrape ` +
        `is anchored on a template literal like \`${m.floor}\${…}\`; if that helper was renamed ` +
        `or moved, re-anchor it, because an empty census makes every pin below vacuous`)
        .toContain(m.floor)
      hits.forEach((h) => found.add(h))
    }
    return found
  }

  it('every ticket namespace the codebase MINTS is named in the envelope_id description', async () => {
    const platform = readFileSync(new URL('../lib/chat/tools/platform.ts', import.meta.url), 'utf8')
    const at = platform.indexOf('envelope_id: z.string()')
    expect(at, 'the envelope_id field moved — re-anchor this pin').toBeGreaterThan(-1)
    // Terminate on the NEXT field in the same schema, not on a newline: the
    // description is one long line today, but wrapping it is a legal edit and
    // a newline cut would silently read a fragment and report a namespace as
    // missing when it is merely on line 2. `at + rel` fails CLOSED (an empty
    // window if the terminator is gone), and the floor below catches that.
    const rel = platform.slice(at).search(/\n\s+[a-z_]+: z\./)
    const desc = platform.slice(at, at + rel)
    expect(desc.length, 'could not bound the envelope_id describe() — the field after it no ' +
      'longer looks like `name: z.…`, so re-anchor this pin rather than trusting an empty read')
      .toBeGreaterThan(80)
    // ⚠️ A FLOOR CANNOT CATCH A READ THAT GOT BIGGER. Delete the `wait:` field
    // and this search finds the next `x: z.…` in a DIFFERENT tool's schema
    // ~10KB later: the window swells to 10,780 chars, sweeps unrelated
    // descriptions, and every namespace below "passes" against text that has
    // nothing to do with use_device. Bound it from ABOVE too, and structurally
    // — exactly one field may live in the window.
    expect((desc.match(/: z\./g) ?? []).length, 'the window ran past envelope_id into another ' +
      'field — it is no longer reading only this description').toBe(1)
    expect(desc.length, 'the envelope_id window is implausibly long').toBeLessThan(1200)

    for (const ns of Array.from(census()).sort()) {
      expect(desc, `the codebase mints "${ns}" tickets and redeems them through this exact ` +
        `field, but use_device's own schema never names the shape — so the model is handed ` +
        `a ${ns}* id by a push/ring row and has to guess whether it is even legal`)
        .toContain(ns)
    }
  })

  it('the surfaces that hand a task_* to the model point at the field that accepts it', () => {
    const src = readFileSync(workerFile('relay.ts'), 'utf8')
    const handler = src.slice(src.indexOf('class RelayTaskResultCall'))
    // The push's redeem prompt and the ring row are the ONLY two places a
    // task_* reaches a model, and both must spell the parameter it goes into.
    const push = relay.buildTaskResultPush({ ticket: 'task_d1_t1', deviceName: 'mbp' })
    expect(new URL('https://x' + push.url).searchParams.get('q')).toContain("envelope_id:'task_")
    expect(handler).toContain("envelope_id:'${ticket}'")
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

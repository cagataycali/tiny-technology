/**
 * spawn_agents async support (S2 — docs/spawn-agents-async-design-2026-08-02.md).
 *
 * The tool itself stays defined in the chat route (it closes over the turn's
 * model, ring, and session); what lives HERE is everything wait:false needs
 * beyond it: the batch ticket, the deposit/push payload builders (pure,
 * tested), and the after()-continuation that runs the fan-out once the
 * response has closed and parks the aggregate on the worker.
 *
 * The deposit rides the SAME rails as a late device reply (worker relay.ts
 * RelayDepositCall): recv redemption via use_device action:'result', the 24h
 * settled window, the self-redeeming ?q= push. The ticket namespace batch_*
 * is the worker-enforced rule that keeps deposits from ever shadowing a real
 * device envelope's reply.
 */
import { after } from 'next/server'
import { WORKER, ikey } from './platform'

export const batchTicket = () => `batch_${crypto.randomUUID()}`

/** Worker payload rule: valid JSON ≤8192 bytes (relay.ts PAYLOAD_MAX). Leave
 *  real headroom for the JSON envelope + multibyte characters. */
const RESULT_BUDGET = 7000

/**
 * Flatten the batch into the one string the user redeems. Every task gets a
 * marker (✅/❌) and a fair share of the budget — one talkative sub-agent must
 * not evict its siblings' answers from the deposit.
 */
export function buildBatchResultText(
  results: Array<{ task: number; ok: boolean; result?: string; error?: string }>,
  elapsedMs: number,
): string {
  const done = results.filter(r => r?.ok).length
  const header = `🤖 Agent batch finished: ${done}/${results.length} tasks completed in ${Math.round(elapsedMs / 1000)}s.`
  const share = Math.max(200, Math.floor(RESULT_BUDGET / Math.max(results.length, 1)) - 40)
  const sections = results.map(r =>
    r?.ok
      ? `✅ Task ${r.task}:\n${String(r.result || '').slice(0, share)}`
      : `❌ Task ${r?.task}: ${String(r?.error || 'failed').slice(0, 200)}`
  )
  return [header, ...sections].join('\n\n').slice(0, RESULT_BUDGET)
}

/**
 * The ONE aggregated notification (never N). Body carries task counts only —
 * sub-agent results can contain anything they fetched, and none of it belongs
 * on a lock screen. The url is the same self-redeeming ?q= pattern as device
 * pushes: tapping lands on the fetched results, not homework.
 */
export function buildBatchPush(ticket: string, completed: number, failed: number) {
  const redeem =
    `My background agent batch finished — fetch it with use_device ` +
    `action:'result' envelope_id:'${ticket}' and show me the results.`
  return {
    title: '🤖 agent batch finished',
    body: `${completed}/${completed + failed} tasks completed${failed ? ` (${failed} failed)` : ''} — tap to read the results.`,
    url: `/?q=${encodeURIComponent(redeem)}`,
    tag: `batch-${ticket}`,
  }
}

/**
 * Run the batch past the closed stream and announce the outcome. Every path
 * deposits — an exception that skipped the deposit would re-open the silent-
 * discard bug this whole design exists to close. Deposit FIRST (the payload
 * the user redeems), announcements second, push last.
 *
 * `schedule` is injectable for tests; the default is next/server after(),
 * which runs the callback when the response settles, inside the same function
 * lifetime (edge, maxDuration budget — the design doc covers the bound).
 */
export function runBatchInBackground(opts: {
  userId: string
  ticket: string
  run: () => Promise<{ results: any[]; elapsedMs: number }>
  schedule?: (fn: () => Promise<void>) => void
}): void {
  const schedule = opts.schedule ?? ((fn: () => Promise<void>) => after(fn))
  schedule(async () => {
    let text: string
    let completed = 0
    let failed = 0
    try {
      const { results, elapsedMs } = await opts.run()
      completed = results.filter((r: any) => r?.ok).length
      failed = results.length - completed
      text = buildBatchResultText(results, elapsedMs)
    } catch (e: any) {
      failed = 1
      text = `🤖 Agent batch failed before finishing: ${String(e?.message || e).slice(0, 500)}`
    }

    const post = (path: string, body: Record<string, any>) =>
      fetch(`${WORKER}${path}`, {
        method: 'POST',
        headers: ikey(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null)

    await post('/device/relay/deposit', {
      userId: opts.userId,
      ticket: opts.ticket,
      payload: JSON.stringify({ result: text }),
    })
    await post('/events', {
      userId: opts.userId,
      kind: 'batch_result',
      detail:
        `🤖 agent batch finished (${completed} ok${failed ? `, ${failed} failed` : ''}) — ` +
        `read it with use_device action:'result' envelope_id:'${opts.ticket}'`,
    })
    await post('/push/send', { userId: opts.userId, ...buildBatchPush(opts.ticket, completed, failed) })
  })
}

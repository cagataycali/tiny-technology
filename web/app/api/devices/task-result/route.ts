/**
 * /api/devices/task-result — a daemon's background task finished; announce it.
 *
 * The other half of "trigger and forget on the Mac" (use_device async): a
 * relay invoke the daemon offloads to use_tasks replies "Task started…"
 * in-window, so the late-reply push never fires — and the finished result
 * only showed a desktop notification on the device itself. The daemon now
 * posts completions here; the worker (relay.ts RelayTaskResultCall) deposits
 * the result under a task_* ticket, emits a device_task_result ring event,
 * and sends the one self-redeeming push.
 *
 * NO session, same as /api/devices/heartbeat and /event: the caller is the
 * device daemon and there may be nobody logged in on screen. The device token
 * both authenticates and resolves the owner (worker-side), so a device can
 * only announce into its own user's world. Off the IP limiter for the same
 * reason as heartbeat — task completions are not a per-IP quota.
 */
export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { deviceId, token, taskId, summary, result } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token || !taskId || typeof result !== 'string') {
    return json({ ok: false, error: 'deviceId, token, taskId and result required' }, 400)
  }

  // 10s bound, matching heartbeat/relay/event: a hung worker must not pin
  // this invocation to CF wall-clock.
  const res = await fetch(`${WORKER_URL}/device/task-result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      deviceId: String(deviceId),
      token: String(token),
      taskId: String(taskId),
      summary: String(summary ?? '').slice(0, 140),
      result: String(result).slice(0, 7000),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)

  if (!res) return json({ ok: false, error: 'registry unreachable' }, 424)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    return json({ ok: false, error: data.error || 'announce failed' }, res.status === 401 ? 401 : 424)
  }
  return json({ ok: true, ticket: data.ticket })
}

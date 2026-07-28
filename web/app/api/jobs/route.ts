/**
 * /api/jobs — the logged-in user's scheduled jobs (session-authorized).
 *   GET    → { jobs, runs }
 *   POST   { tiny?, name, prompt, schedule? | run_in_minutes? } → create
 *   DELETE { id } → delete a job
 */
import { getSession } from "@/lib/auth";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// A hung worker must degrade to a clean 503, not an unhandled 500 — the jobs
// UI (which drives scheduled push) shows a "try again" rather than crashing.
const passthrough = async (p: Promise<Response>, onFail: any) => {
  try {
    const res = await p
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
  } catch {
    return json(onFail, 503)
  }
}

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ jobs: [], runs: [], error: 'login required' }), { status: 401 });
  }
  return passthrough(
    fetch(`${WORKER}/jobs?userId=${encodeURIComponent(session.sub)}`, {
      headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      signal: AbortSignal.timeout(10_000),
    }),
    { jobs: [], runs: [], error: 'jobs service unavailable' }
  )
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { tiny, name, prompt, schedule, run_in_minutes } = body;
  if (!name || !prompt) {
    return new Response(JSON.stringify({ error: 'name and prompt required' }), { status: 400 });
  }
  if (!schedule && !run_in_minutes) {
    return new Response(JSON.stringify({ error: 'schedule or run_in_minutes required' }), { status: 400 });
  }
  // A truthy-but-non-numeric run_in_minutes (e.g. "abc") would otherwise
  // become runAt="NaN" → the worker stores NaN → the one-shot never fires and
  // sits enabled forever against the user's job limit. Validate up front.
  let runAt: string | undefined;
  if (run_in_minutes !== undefined && !schedule) {
    const mins = Number(run_in_minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      return new Response(JSON.stringify({ error: 'run_in_minutes must be a positive number' }), { status: 400 });
    }
    runAt = String(Math.floor(Date.now() / 1000) + Math.round(mins * 60));
  }
  return passthrough(
    fetch(`${WORKER}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({
        userId: session.sub,
        tiny: tiny || 'tiny',
        name,
        prompt,
        ...(schedule ? { schedule } : {}),
        ...(runAt ? { runAt } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    }),
    { error: 'jobs service unavailable' }
  )
}

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session) return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  const { id } = await req.json().catch(() => ({} as any));
  if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400 });
  return passthrough(
    fetch(`${WORKER}/jobs`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({ userId: session.sub, id }),
      signal: AbortSignal.timeout(10_000),
    }),
    { error: 'jobs service unavailable' }
  )
}

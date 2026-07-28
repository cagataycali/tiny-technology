/**
 * /api/telegram — the logged-in user's Telegram bot connection.
 *   GET    → { bot: { tiny, allowedChats, enabled, token(masked) } | null }
 *   POST   { token?, tiny?, allowedChats?, enabled? } → configure/update
 *   DELETE → disconnect (removes token from D1)
 * Proxies the worker's internal /telegram endpoints with the session userId.
 */
import { getSession } from "@/lib/auth";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'

const internalHeaders = {
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
}

// 15s backstop on every worker round-trip. TelegramSettings.tsx ALREADY bounds
// each call with its own 10s client timeout + proper error UI (GET failure →
// loadError → retry, not the "set up a bot" form). So this server bound is set
// ABOVE 10s deliberately: the client's nicer .catch always wins the race, and
// this only caps edge wall-clock cost when a hung worker outlives the client
// (or no client is waiting). On throw → honest 503 the consumers can read.
const T = () => ({ signal: AbortSignal.timeout(15_000) })
async function relayText(p: Promise<Response>): Promise<Response> {
  try {
    const res = await p
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch {
    return new Response(JSON.stringify({ bot: null, error: 'Telegram service unavailable — try again' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) return new Response(JSON.stringify({ bot: null, error: 'login required' }), { status: 401 });
  return relayText(fetch(`${WORKER}/telegram?userId=${encodeURIComponent(session.sub)}`, {
    headers: internalHeaders,
    ...T(),
  }));
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  const body = await req.json().catch(() => ({}));
  return relayText(fetch(`${WORKER}/telegram`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify({
      userId: session.sub,
      ...(body.token ? { token: String(body.token) } : {}),
      ...(body.tiny ? { tiny: String(body.tiny) } : {}),
      ...(body.allowedChats !== undefined ? { allowedChats: String(body.allowedChats) } : {}),
      ...(body.enabled !== undefined ? { enabled: String(body.enabled) } : {}),
    }),
    ...T(),
  }));
}

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session) return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  return relayText(fetch(`${WORKER}/telegram`, {
    method: 'DELETE',
    headers: internalHeaders,
    body: JSON.stringify({ userId: session.sub }),
    ...T(),
  }));
}

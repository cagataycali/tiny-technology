/**
 * /api/messages — the logged-in user's DMs (user↔user messaging).
 *   GET                 → inbox (threads + unread counts)
 *   GET ?with=<login>   → thread with that user (marks inbound read)
 *   POST { to, message }→ send (to = @login, login, or tiny slug; resolved
 *                          server-side by the worker). Sender = session.sub.
 *   DELETE { id }       → delete a message you sent
 */
import { getSession } from "@/lib/auth";
import { decideDmSend } from "@/lib/chat/dm-send";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'

const headers = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

// 10s bound on every worker round-trip. This route is on the DM/notification
// path — the GET is polled by the iOS badge + watch complication every
// 30-60s, the POST is the notification inline-reply send. A worker that
// connects but never responds would otherwise hold the edge invocation open
// to platform wall-clock, and neither the iOS nor watch client sets its own
// timeout. On failure we degrade to a 503 (NOT masked-empty) so clients keep
// their unread state instead of clearing the badge — the exact regression the
// worker's messages.ts guards against on its own D1-outage path.
const err = (msg: string, status = 503) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } })
const relay = async (p: Promise<Response>, onFail: string) => {
  try {
    const res = await p
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
  } catch {
    return err(onFail)
  }
}

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  const url = new URL(req.url);
  const withPeer = url.searchParams.get('with');
  const limit = url.searchParams.get('limit');
  const qs = new URLSearchParams({ userId: session.sub });
  if (withPeer) qs.set('with', withPeer.slice(0, 64));
  if (limit) qs.set('limit', String(Math.min(Math.max(Number(limit) || 50, 1), 200)));
  return relay(
    fetch(`${WORKER}/messages?${qs}`, { headers: headers(), signal: AbortSignal.timeout(10_000) }),
    'messages unavailable',
  );
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  const { to, message, viaTiny } = await req.json().catch(() => ({}));
  if (!to || typeof to !== 'string' || !message || typeof message !== 'string' || !message.trim()) {
    return new Response(JSON.stringify({ error: 'to and message required' }), { status: 400 });
  }
  // Refuse over-length rather than `.slice(0, 2000)` it. This route is what the
  // web composer, both mobile apps, the notification inline-reply and the MCP
  // tool all post to; only the agent tool ran a client-side check, so a long
  // message from any of the others arrived here, got cut, and came back 200. And
  // the cut counted UTF-16 units while every other end counts code points, so it
  // could land inside a surrogate pair (measured: 2000 emoji → 1001 kept, ending
  // in a lone 0xd83d). See lib/chat/dm-send.ts for why refusal is the right call
  // on an irreversible send. The worker enforces the same rule independently.
  const decided = decideDmSend(message);
  if (!decided.ok) {
    return new Response(JSON.stringify({ error: decided.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  // "to" can be @login, login, or a tiny slug — pass both hints; the worker
  // tries login first, then tiny-slug ownership.
  const target = to.trim().replace(/^@/, '').slice(0, 64);
  return relay(
    fetch(`${WORKER}/message`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        fromUserId: session.sub,
        toLogin: target,
        toTiny: target.toLowerCase(),
        body: decided.body,
        viaTiny: typeof viaTiny === 'string' ? viaTiny.slice(0, 40) : '',
      }),
      signal: AbortSignal.timeout(10_000),
    }),
    'send failed — try again',
  );
}

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  const { id } = await req.json().catch(() => ({}));
  if (id === undefined || id === '') {
    return new Response(JSON.stringify({ error: 'id required' }), { status: 400 });
  }
  return relay(
    fetch(`${WORKER}/message`, {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify({ userId: session.sub, id: String(id) }),
      signal: AbortSignal.timeout(10_000),
    }),
    'delete failed — try again',
  );
}

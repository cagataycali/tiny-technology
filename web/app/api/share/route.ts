/**
 * Conversation sharing.
 *   POST { name, messages[] } → { id, url }   (rate-limited)
 *   GET  ?id=                 → shared conversation
 *
 * KV-backed via the worker — replaces base64-in-URL shares (~2000 char cap).
 */
import { enforceIpDailyLimit } from "@/lib/rate-limit";
import { getSession } from "@/lib/auth";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'

// 10s bound on every worker round-trip. None of these fetches had a timeout,
// and — worse — none guarded the fetch THROWING (network/DNS error, or the
// abort itself): POST's .json().catch() guards only the PARSE, and the
// text-passthrough verbs (GET by-id, GET mine, DELETE) had no protection, so a
// thrown fetch became an opaque 500 with no JSON body. GET by-id is the PUBLIC
// share-viewer read path, so a hung worker would spin the viewer page. relayText
// wraps the passthrough verbs → honest 503 {error} the clients can read.
const T = () => ({ signal: AbortSignal.timeout(10_000) })
async function relayText(p: Promise<Response>, cacheControl?: string): Promise<Response> {
  try {
    const res = await p
    const cc = typeof cacheControl === 'string' ? cacheControl : (res.status === 200 ? undefined : 'no-store')
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...(cc ? { 'Cache-Control': cc } : {}) },
    })
  } catch {
    return new Response(JSON.stringify({ error: 'share service unavailable', shares: [] }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
}

export async function POST(req: Request) {
  // Logged-in creators get account-based (cross-device) share management — read
  // first so the limiter below can key on them.
  const session = await getSession(req);

  // shares are cheap but not free — tighter window than the global 50/day.
  // cost: 'platform' (the default) — a share consumes OUR KV, and the artifact
  // belongs to its creator, so a signed-in builder gets their own 20/day window
  // widened by standing rather than sharing one bucket with everyone on their
  // office IP. Anonymous callers are unchanged: IP-keyed, 20/day.
  const limited = await enforceIpDailyLimit(req, {
    requests: 20,
    keyPrefix: 'share_ratelimit_',
    message: 'Share limit reached for today.',
    json: true,
    userId: session?.sub,
  });
  if (limited) return limited;

  const { name, messages } = await req.json().catch(() => ({} as any));
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages required' }), { status: 400 });
  }

  // SERVER-SIDE sanitize — never trust the client to have run shareSnapshot.
  // Store only reader-facing text: drop system messages (private-prompt leak)
  // and, critically, uiComponents — their componentCode is executed via
  // `new Function` in every VIEWER's browser (DynamicUI) with access to the
  // viewer's localStorage (API keys). A hand-crafted POST could otherwise
  // plant stored XSS behind a "read-only" share link.
  const safeMessages = messages
    .filter((m: any) => m && typeof m.id === 'string' && typeof m.role === 'string' && typeof m.content === 'string' && m.role !== 'system')
    .map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      ...(Array.isArray(m.followups) && m.followups.length ? { followups: m.followups.filter((f: any) => typeof f === 'string') } : {}),
    }));
  if (safeMessages.length === 0) {
    return new Response(JSON.stringify({ error: 'nothing shareable in messages' }), { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${WORKER}/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({
        name: String(name || ''),
        messages: JSON.stringify(safeMessages),
        ...(session ? { userId: session.sub } : {}),
      }),
      ...T(),
    });
  } catch {
    // Fetch threw (timeout/network) — honest 503, NOT a silent hang or a
    // mislabeled failure the user can't retry.
    return new Response(JSON.stringify({ error: 'share service unavailable — try again' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Guard the parse (a Cloudflare 5xx serves an HTML body, not JSON) and
  // pass the worker's real status through — a blanket 502 mislabels a
  // legitimate 400 (e.g. "messages ≤ 256KB") as a gateway failure, so the
  // user sharing a huge conversation sees "server broke" instead of "too big".
  const data = await res.json().catch(() => ({} as any));
  if (!data.id) {
    const status = res.status >= 400 && res.status < 500 ? res.status : 502;
    return new Response(JSON.stringify({ error: data.error || 'share failed' }), { status });
  }
  return new Response(JSON.stringify({
    id: data.id,
    revokeToken: data.revokeToken, // creator keeps this to revoke later
    url: `https://tiny.technology/${encodeURIComponent(String(name || 'tiny'))}?share=${data.id}`,
  }), { headers: { 'Content-Type': 'application/json' } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  // ?mine=1 → the logged-in user's shares (account-based, cross-device)
  if (url.searchParams.get('mine') === '1') {
    const session = await getSession(req);
    if (!session) {
      return new Response(JSON.stringify({ shares: [], error: 'login required' }), { status: 401 });
    }
    return relayText(fetch(`${WORKER}/share/list?userId=${encodeURIComponent(session.sub)}`, {
      headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      ...T(),
    }));
  }

  const id = url.searchParams.get('id') || '';
  // Only cache a successful hit. A 404 (share not found / just revoked) or a
  // worker 5xx must NOT ride a 5-minute public max-age at the CDN edge — that
  // pins a revoked share's "gone" (or a transient error) for everyone, and a
  // share that goes live right after a miss stays 404 until the TTL expires.
  // relayText picks no-store for non-200; force max-age only on the 200 hit.
  const res = await relayText(fetch(`${WORKER}/share?id=${encodeURIComponent(id)}`, { ...T() }));
  if (res.status === 200) res.headers.set('Cache-Control', 'public, max-age=300');
  return res;
}

export async function DELETE(req: Request) {
  const { id, revokeToken } = await req.json().catch(() => ({} as any));
  if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400 });
  // Session ownership works even without the token (cross-device revoke)
  const session = await getSession(req);
  return relayText(fetch(`${WORKER}/share`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      id,
      ...(revokeToken ? { revokeToken } : {}),
      ...(session ? { userId: session.sub } : {}),
    }),
    ...T(),
  }));
}

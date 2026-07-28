/**
 * /api/graph — the logged-in user's memory graph read surface.
 *   GET ?node=<id>&hops=&rels=      → subgraph around a memory node
 *   GET ?all=1&include_closed=      → the WHOLE fact graph (Graph Panel viz)
 *   GET ?conflicts=1                → contradiction candidates (scope-aware)
 *   GET ?social=<node>              → PUBLIC social edges + trust scores
 *   GET ?feed=1&limit=              → fresh public facts from followed builders
 *   POST { keep, close[] }          → resolve a conflict (close losers, keep one)
 *
 * Session-gated proxy → worker (internal key). Fact-graph reads are scoped
 * to the session user; the social read path is public-visibility-only by
 * construction (SOCIAL_NEIGHBORS_SQL filters both edge and node level).
 */
import { getSession } from "@/lib/auth";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'
const ikey = () => ({ 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' })

// 10s bound on every worker round-trip. graph/all + graph/neighbors walk the
// fact graph (and neighbors expands hops), so a hung worker would otherwise
// hold the edge invocation open to platform wall-clock. On failure degrade to
// an honest 503 {error} (NOT masked-empty {nodes:[],edges:[]} — an outage must
// not tell a user with a rich graph they have none). Callers that read
// nodes/edges directly must guard on d.error → .catch. Matches the pattern on
// /api/learnings·messages·jobs·push·follow·prefs·events.
const relay = async (p: Promise<Response>, onFail: string) => {
  try {
    const res = await p
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: onFail, ok: false }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  }
}
const T = () => ({ signal: AbortSignal.timeout(10_000) })

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  const url = new URL(req.url);

  // Social subgraph + trust (public data; session required to rate-limit surface)
  const social = url.searchParams.get('social');
  if (social !== null) {
    const qs = new URLSearchParams();
    if (social) qs.set('node', social.slice(0, 120));
    return relay(fetch(`${WORKER}/graph/social?${qs}`, { headers: ikey(), ...T() }), 'graph unavailable');
  }

  // Whole graph: every fact node + edge (the Graph Panel visualization)
  if (url.searchParams.get('all') === '1') {
    const qs = new URLSearchParams({ userId: session.sub });
    if (url.searchParams.get('include_closed') === '1') qs.set('include_closed', '1');
    return relay(fetch(`${WORKER}/graph/all?${qs}`, { headers: ikey(), ...T() }), 'graph unavailable');
  }

  // Feed: fresh PUBLIC facts from principals the session user follows
  if (url.searchParams.get('feed') === '1') {
    const qs = new URLSearchParams({ userId: session.sub });
    const limit = url.searchParams.get('limit');
    if (limit) qs.set('limit', String(Math.min(Math.max(Number(limit) || 30, 1), 100)));
    return relay(fetch(`${WORKER}/graph/feed?${qs}`, { headers: ikey(), ...T() }), 'feed unavailable');
  }

  // Conflicts (owner's own graph)
  if (url.searchParams.get('conflicts') === '1') {
    return relay(fetch(`${WORKER}/graph/conflicts?userId=${encodeURIComponent(session.sub)}`, { headers: ikey(), ...T() }), 'conflicts unavailable');
  }

  // Neighbors (owner's own graph)
  const node = url.searchParams.get('node');
  if (!node) {
    return new Response(JSON.stringify({ error: 'node, conflicts=1 or social required' }), { status: 400 });
  }
  const qs = new URLSearchParams({ userId: session.sub, node: node.slice(0, 120) });
  const hops = url.searchParams.get('hops');
  if (hops) qs.set('hops', String(Math.min(Math.max(Number(hops) || 1, 1), 2)));
  const rels = url.searchParams.get('rels');
  if (rels) qs.set('rels', rels.slice(0, 200));
  return relay(fetch(`${WORKER}/graph/neighbors?${qs}`, { headers: ikey(), ...T() }), 'graph unavailable');
}

// Resolve a conflict: keep one candidate edge, close the rest (bitemporal —
// the losing claims become history). Powers the panel's one-tap prompt.
export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  const { keep, close } = await req.json().catch(() => ({}));
  const closeIds = Array.isArray(close)
    ? close.filter((x: any) => typeof x === 'string').slice(0, 20)
    : [];
  if (!keep || typeof keep !== 'string' || !closeIds.length) {
    return new Response(JSON.stringify({ error: 'keep and close[] (edge ids) required' }), { status: 400 });
  }
  return relay(
    fetch(`${WORKER}/graph/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ikey() },
      body: JSON.stringify({
        userId: session.sub,
        keep,
        close: JSON.stringify(closeIds), // JSON-string field (itty gotcha #8)
      }),
      ...T(),
    }),
    'resolve failed — try again',
  );
}

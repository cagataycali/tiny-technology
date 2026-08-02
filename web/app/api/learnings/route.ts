/**
 * /api/learnings — the logged-in user's server-side agent learnings.
 *   GET ?q=&limit=  → { learnings, relevant?, total } (q → semantic recall)
 *   POST { content } → store a learning (≤2000 chars)
 *   DELETE { id }    → close ONE memory (bitemporal — survives as history)
 *          { scope:'all' } or a bare {} → erase EVERY memory + purge the
 *          semantic index. Not recoverable, so a blank/unreadable id is refused
 *          with a 400 rather than read as this — see lib/chat/learnings-delete-scope.
 */
import { getSession } from "@/lib/auth";
import { learningsLimit } from "@/lib/chat/memory-list";
import { planLearningsDelete, deleteRefusalForHumans } from "@/lib/chat/learnings-delete-scope";
import { unlearnBody } from "@/lib/chat/unlearn-scope";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'

// 10s bound on every worker round-trip. The GET (memory recall) also drives
// Vectorize semantic search worker-side, which can run long; without a bound a
// hung worker holds the edge invocation open to platform wall-clock, and the
// MemoryPanel fetch sets no client-side timeout either. On failure degrade to
// a 503 (NOT masked-empty {learnings:[]}) so the panel shows its error branch
// instead of "no memories yet". Matches /api/messages·jobs·push·follow·prefs.
const relay = async (p: Promise<Response>, onFail: string) => {
  try {
    const res = await p
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: onFail }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  }
}

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ learnings: [], error: 'login required' }), { status: 401 });
  }
  // Forward recall params so CLI/MCP clients get semantic search too
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  const limit = url.searchParams.get('limit');
  const qs = new URLSearchParams({ userId: session.sub });
  if (q) qs.set('q', q.slice(0, 500));
  // Clamp to the WORKER's own bounds, not narrower ones of our own invention.
  // The old cap was a flat 100 justified by Vectorize semantic search — but
  // Vectorize only runs when `q` is present, and a plain list is one indexed D1
  // read the worker already caps at 500 ("0-500, default 100"). So the flat cap
  // protected nothing and silently truncated every honest caller: MemoryPanel
  // asks 500, iOS/Android ask 200, all three got 100 with no way to know. The
  // floor was worse — `Math.max(…, 1)` turned `limit=0` into 30 rows, and 0 is
  // a documented mode ("none, recall only") our own recall tool uses. Recall
  // keeps the tighter cap because it's the call that can actually run long.
  // See lib/chat/memory-list.
  const clamped = learningsLimit(limit, !!q);
  if (clamped !== null) qs.set('limit', clamped);
  // Bitemporal history: closed facts + freshness
  if (url.searchParams.get('include_closed') === '1') qs.set('include_closed', '1');
  // Graph expansion: hops=1 walks recall matches one hop through live edges
  if (url.searchParams.get('hops') === '1') qs.set('hops', '1');
  return relay(
    fetch(`${WORKER}/learnings?${qs}`, {
      headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      signal: AbortSignal.timeout(10_000),
    }),
    'memories unavailable',
  );
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  const { content, supersedes, edges, visibility } = await req.json().catch(() => ({}));
  if (!content || typeof content !== 'string' || !content.trim()) {
    return new Response(JSON.stringify({ error: 'content required' }), { status: 400 });
  }
  // supersedes: array of memory ids this fact replaces — worker
  // closes them bitemporally. JSON-string field (itty-router gotcha #8).
  const supersedeIds = Array.isArray(supersedes)
    ? supersedes.filter((x: any) => typeof x === 'string' || typeof x === 'number').slice(0, 20)
    : [];
  // edges: fact links ({rel, dst, scope?, ...}) — worker validates rels +
  // owner-scoped dst; same JSON-string encoding.
  const edgeInputs = Array.isArray(edges)
    ? edges.filter((e: any) => e && typeof e === 'object' && e.rel && e.dst != null).slice(0, 10)
    : [];
  return relay(
    fetch(`${WORKER}/learnings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({
        userId: session.sub,
        content: content.slice(0, 2000),
        ...(supersedeIds.length ? { supersedes: JSON.stringify(supersedeIds) } : {}),
        ...(edgeInputs.length ? { edges: JSON.stringify(edgeInputs) } : {}),
        // 'public' opts the fact into the follower feed (stage 6)
        ...(visibility === 'public' ? { visibility: 'public' } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    }),
    'save failed — try again',
  );
}

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  // Clear-all must be REQUESTED, never INFERRED. The old body spread
  // (`...(id !== undefined && id !== '' ? { id } : {})`) did not refuse a blank
  // id, it OMITTED it — and an omitted id is the wire form of "close every fact,
  // drop every legacy row, purge every vector", which is the one memory
  // operation that is not bitemporal and cannot be undone. So a swipe on a
  // SINGLE row whose id decoded empty erased the user's whole memory, as did a
  // body that failed to encode (iOS builds this one with `try?`) or to parse.
  // Same rule the agent tool got in lib/chat/unlearn-scope; see
  // lib/chat/learnings-delete-scope for why a bare `{}` is still clear-all.
  const plan = planLearningsDelete(await req.text().catch(() => ''));
  if (plan.kind === 'refuse') {
    return new Response(JSON.stringify({ error: deleteRefusalForHumans(plan.reason) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return relay(
    fetch(`${WORKER}/learnings`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify(unlearnBody(session.sub, plan)),
      signal: AbortSignal.timeout(10_000),
    }),
    'delete failed — try again',
  );
}

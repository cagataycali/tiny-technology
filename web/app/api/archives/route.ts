import { getSession } from "@/lib/auth";
import { buildArchive } from "@/lib/session-archive";

export const runtime = "edge";

/**
 * Cloud session archives (issue #7) — session-authed proxy over the
 * worker's internal /archive routes. The archive JSON is rebuilt
 * server-side from the posted messages via buildArchive so the
 * credential-redaction pass always runs, even for hand-crafted clients.
 *
 *   GET    /api/archives            → { archives } (list)
 *   GET    /api/archives?id=        → archive JSON (owner-only)
 *   POST   /api/archives            { tiny, messages } → { id }
 *   DELETE /api/archives            { id }
 */

const WORKER = "https://plugin.tiny.technology";
const ikey = () => ({ "X-Internal-Key": process.env.INTERNAL_API_KEY || "" });

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// 10s bound + fetch-throw guard on every worker round-trip. All three verbs
// did `await res.text()` with no timeout and no protection against the fetch
// rejecting (timeout/network/abort) — a hung worker held the edge invocation
// to CF wall-clock, and a thrown fetch became an opaque 500 with no JSON body.
// relayText degrades to an honest 503 {error} the Chat.tsx /save·/load·/archives
// consumers already handle (they branch on d.error / d.ok). archives:[] keeps
// the list consumer's `d.archives || []` happy.
const T = () => ({ signal: AbortSignal.timeout(10_000) });
async function relayText(p: Promise<Response>): Promise<Response> {
  try {
    const res = await p;
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return json({ error: "archive service unavailable — try again", archives: [] }, 503);
  }
}

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "login required" }, 401);
  const id = new URL(req.url).searchParams.get("id");
  const url = id
    ? `${WORKER}/archive?id=${encodeURIComponent(id)}&userId=${encodeURIComponent(session.sub)}`
    : `${WORKER}/archive/list?userId=${encodeURIComponent(session.sub)}`;
  return relayText(fetch(url, { headers: ikey(), ...T() }));
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "login required" }, 401);
  const { tiny, messages } = await req.json().catch(() => ({} as any));
  if (!tiny || !Array.isArray(messages) || messages.length === 0) {
    return json({ error: "tiny and messages[] required" }, 400);
  }
  // Server-side redaction pass — never trust the client to have scrubbed
  const archive = buildArchive(String(tiny), messages);
  return relayText(fetch(`${WORKER}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ikey() },
    body: JSON.stringify({ userId: session.sub, tiny: String(tiny), archive }),
    ...T(),
  }));
}

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "login required" }, 401);
  const { id } = await req.json().catch(() => ({} as any));
  if (!id) return json({ error: "id required" }, 400);
  return relayText(fetch(`${WORKER}/archive`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...ikey() },
    body: JSON.stringify({ userId: session.sub, id: String(id) }),
    ...T(),
  }));
}

import { getSession } from "@/lib/auth";

export const runtime = "edge";

/**
 * GET /api/events?sinceId=N — the signed-in user's activity stream
 * (scheduler fires, telegram messages, visits, learns…). Session-authed
 * proxy over the worker's internal /events ring (200-cap, D1).
 * Powers the ActivityHUD; also useful for polling with sinceId.
 */
export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: "login required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Clamp to a non-negative integer before forwarding. `Number(x) || 0` alone
  // passed floats, negatives, and Infinity straight through — `?sinceId=1e999`
  // forwarded the literal `sinceId=Infinity` to the worker's D1 query. sinceId
  // is a monotonic event-ring id, so anything non-finite/≤0 means "from the
  // start".
  const nRaw = Math.floor(Number(new URL(req.url).searchParams.get("sinceId")));
  const sinceId = Number.isFinite(nRaw) && nRaw > 0 ? nRaw : 0;
  // Distinguish "worker is down" from "genuinely no activity". Swallowing a 5xx/
  // timeout/non-JSON into {ok:true, events:[]} makes an outage read as an empty
  // ring forever — the ActivityHUD shows "Nothing yet" and the poller never
  // knows to back off. Surface the failure so the client can tell them apart.
  // Deadline the upstream read: without it a hung worker keeps this edge
  // invocation pending until the platform wall-clock kills it, and the
  // ActivityHUD's own /api/events fetch (no client timeout) spins on "Loading…"
  // forever with no path to the retry UI. 10s → AbortError → .catch → the 502
  // below, which the HUD already renders as a retryable error. Matches the SSR
  // /get + TelegramSettings 10s convention.
  const data = await fetch(
    `https://plugin.tiny.technology/events?userId=${encodeURIComponent(session.sub)}&sinceId=${sinceId}&limit=50`,
    { headers: { "X-Internal-Key": process.env.INTERNAL_API_KEY || "" }, signal: AbortSignal.timeout(10_000) }
  )
    .then(async (r) => (r.ok ? await r.json() : null))
    .catch(() => null);
  if (!data || !Array.isArray(data.events)) {
    return new Response(JSON.stringify({ ok: false, error: "events unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true, events: data.events }), {
    headers: { "Content-Type": "application/json" },
  });
}

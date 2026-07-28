/**
 * Per-user event bus (COMPARISON.md §2.6) — the connective tissue that lets
 * the agent see what happened across subsystems (scheduler fires, share
 * views, task completions) since the last turn.
 *
 *   POST /events  { userId, kind, detail? }  (internal)
 *   GET  /events?userId=&sinceId=            (internal) → { events }
 *
 * Ring semantics: capped at 200 per user (oldest pruned on write).
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const RING_CAP = 200;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function emitEvent(env: any, userId: string, kind: string, detail: string) {
  try {
    await env.DB.prepare("INSERT INTO events (user_id, kind, detail) VALUES (?, ?, ?)")
      .bind(userId, kind.slice(0, 32), String(detail || '').slice(0, 300)).run();
    // Prune beyond the ring cap
    await env.DB.prepare(
      `DELETE FROM events WHERE user_id = ? AND id NOT IN (
         SELECT id FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
    ).bind(userId, userId, RING_CAP).run();
  } catch (err) { console.log(err, 'emitEvent'); }
}

export class EventsEmitCall extends OpenAPIRoute {
  static schema = {
    tags: ["Events"],
    summary: "Internal: emit an event onto a user's ring.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      kind: new Str({ required: true, description: "Event kind (short slug)." }),
      detail: new Str({ required: false, description: "Human-readable detail (≤300 chars)." }),
    },
    responses: { "200": { description: "Emitted", schema: { response: "Emitted" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, kind, detail } = data.body;
    if (!userId || !kind) return json({ error: "userId and kind required" }, 400);
    await emitEvent(env, String(userId), String(kind), String(detail || ''));
    return json({ ok: true });
  }
}

export class EventsListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Events"],
    summary: "Internal: recent events for a user (newest last).",
    parameters: {
      userId: Query(String, { required: true, description: "User id." }),
      sinceId: Query(Number, { required: false, description: "Only events with id > sinceId." }),
      limit: Query(Number, { required: false, default: 15, description: "Max events (≤50)." }),
    },
    responses: { "200": { description: "Events", schema: { response: "Events" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const userId = q.get('userId') || '';
    const sinceId = Number(q.get('sinceId')) || 0;
    const limit = Math.min(Math.max(Number(q.get('limit')) || 15, 1), 50);
    if (!userId) return json({ error: "userId required" }, 400);
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, kind, detail, created FROM events
         WHERE user_id = ? AND id > ?
         ORDER BY id DESC LIMIT ?`
      ).bind(userId, sinceId, limit).all();
      return json({ events: (results || []).reverse() });
    } catch (err) {
      console.log(err, 'events list');
      // Fail honestly (500), NOT a masked-empty 200. A D1 read error returned
      // as {events:[]} is indistinguishable from a genuinely empty ring: the
      // Next proxy (app/api/events/route.ts checks r.ok + Array.isArray) would
      // forward {ok:true, events:[]}, the ActivityHUD would render "Nothing
      // yet" over an outage, and its poller would never back off — the exact
      // regression messages.ts guards against on its own D1-outage path.
      return json({ error: "events unavailable" }, 500);
    }
  }
}

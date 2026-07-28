/**
 * Ring attention (COMPARISON.md §2.11, agi-diy agent-mesh pattern) —
 * a per-conversation shared context ring that every consulted tiny
 * reads/writes. When researcher-tiny learns something, critic-tiny sees it
 * on the next ask_tiny call in the same conversation.
 *
 *   GET  /ring?session=   (internal) → { entries }
 *   POST /ring            (internal) { session, agentId, text }
 *
 * Storage: KV `post` under ring:<session>, capped at 20 entries,
 * 1h TTL (conversations are ephemeral; durable facts belong in learnings).
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const MAX_ENTRIES = 20;
const TTL_SECONDS = 60 * 60;
const MAX_TEXT = 500;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ringKey = (session: string) => `ring:${session.slice(0, 64)}`;

export class RingGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Ring"],
    summary: "Internal: read a conversation's shared ring.",
    parameters: {
      session: Query(String, { required: true, description: "Conversation session id." }),
    },
    responses: { "200": { description: "Ring", schema: { response: "Ring" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const session = new URL(request.url).searchParams.get('session') || '';
    if (!session) return json({ error: "session required" }, 400);
    const entries = await env.post.get(ringKey(session), { type: "json" }) || [];
    return json({ entries });
  }
}

export class RingAddCall extends OpenAPIRoute {
  static schema = {
    tags: ["Ring"],
    summary: "Internal: append to a conversation's shared ring.",
    requestBody: {
      session: new Str({ required: true, description: "Conversation session id." }),
      agentId: new Str({ required: true, description: "Which agent/tiny produced this." }),
      text: new Str({ required: true, description: "The beat (≤500 chars stored)." }),
    },
    responses: { "200": { description: "Added", schema: { response: "Added" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { session, agentId, text } = data.body;
    if (!session || !agentId || !text) return json({ error: "session, agentId, text required" }, 400);
    const key = ringKey(String(session));
    const entries: any[] = (await env.post.get(key, { type: "json" })) || [];
    entries.push({
      agentId: String(agentId).slice(0, 64),
      text: String(text).slice(0, MAX_TEXT),
      ts: Date.now(),
    });
    await env.post.put(key, JSON.stringify(entries.slice(-MAX_ENTRIES)), { expirationTtl: TTL_SECONDS });
    return json({ ok: true, size: Math.min(entries.length, MAX_ENTRIES) });
  }
}

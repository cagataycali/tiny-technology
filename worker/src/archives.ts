/**
 * Cloud session archives (issue #7 server half) — durable, account-owned
 * snapshots of full conversations. Complements /share (public, sanitized):
 * archives are PRIVATE to their owner, keep full fidelity (tool calls,
 * usage, model ids — client redacts credentials before upload), and can be
 * restored on any device.
 *
 *   POST   /archive        (internal) { userId, tiny, archive } → { id }
 *   GET    /archive?id=&userId=       (internal; owner-only)   → { archive }
 *   GET    /archive/list?userId=      (internal)               → { archives }
 *   DELETE /archive        (internal) { userId, id }
 *
 * Storage: KV `post` under archive:<id> (1y TTL), owner index in D1
 * `archives` (mirrors the shares table pattern). 20 archives/user.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const MAX_ARCHIVE_BYTES = 512 * 1024;
const TTL_SECONDS = 365 * 24 * 60 * 60;
const MAX_PER_USER = 20;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export class ArchiveCreateCall extends OpenAPIRoute {
  static schema = {
    tags: ["Archives"],
    summary: "Internal: store a private session archive for a user.",
    requestBody: {
      userId: new Str({ required: true, description: "Owner user id." }),
      tiny: new Str({ required: true, description: "Tiny name the session belongs to." }),
      archive: new Str({ required: true, description: "Archive JSON (client-built, credential-redacted)." }),
    },
    responses: { "200": { description: "Stored", schema: { response: "Stored" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, tiny, archive } = data.body;
    // Require userId like get/list/delete do — without it the row + blob land
    // under "undefined" and count against a shared bogus quota bucket.
    if (!userId) return json({ error: "userId required" }, 400);
    if (typeof archive !== "string" || archive.length > MAX_ARCHIVE_BYTES) {
      return json({ error: `archive must be JSON ≤ ${MAX_ARCHIVE_BYTES / 1024}KB` }, 400);
    }
    let parsed: any;
    try { parsed = JSON.parse(archive); } catch { return json({ error: "archive must be valid JSON" }, 400); }
    if (parsed?.tinyai_session !== true || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return json({ error: "not a tiny session archive" }, 400);
    }

    // Cap per user — oldest is the caller's to prune (explicit, no silent loss)
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM archives WHERE user_id = ?")
      .bind(String(userId)).first();
    if (Number(count?.n) >= MAX_PER_USER) {
      return json({ error: `archive limit reached (${MAX_PER_USER}) — delete one first (/archives delete <id>)` }, 400);
    }

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await env.post.put(`archive:${id}`, archive, { expirationTtl: TTL_SECONDS });
    await env.DB.prepare(
      "INSERT INTO archives (id, user_id, tiny_name, msg_count) VALUES (?, ?, ?, ?)"
    ).bind(id, String(userId), String(tiny).slice(0, 64), parsed.messages.length).run();
    return json({ ok: true, id });
  }
}

export class ArchiveGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Archives"],
    summary: "Internal: fetch one archive (owner-only).",
    parameters: {
      id: Query(String, { required: true, description: "Archive id." }),
      userId: Query(String, { required: true, description: "Requesting user id." }),
    },
    responses: { "200": { description: "Archive", schema: { response: "Archive" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const id = q.get("id") || "";
    const userId = q.get("userId") || "";
    // Ownership via the D1 index — KV blob alone carries no owner
    const row = await env.DB.prepare("SELECT user_id FROM archives WHERE id = ?").bind(id).first();
    if (!row || String(row.user_id) !== userId) return json({ error: "not found" }, 404);
    const blob = await env.post.get(`archive:${id}`);
    if (!blob) return json({ error: "archive expired" }, 404);
    return new Response(blob, { headers: { "Content-Type": "application/json" } });
  }
}

export class ArchiveListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Archives"],
    summary: "Internal: list a user's archives (newest first).",
    parameters: {
      userId: Query(String, { required: true, description: "User id." }),
    },
    responses: { "200": { description: "Archives", schema: { response: "Archives" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    const { results } = await env.DB.prepare(
      "SELECT id, tiny_name, msg_count, created FROM archives WHERE user_id = ? ORDER BY created DESC"
    ).bind(userId).all();
    return json({ archives: results || [] });
  }
}

export class ArchiveDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["Archives"],
    summary: "Internal: delete a user's archive.",
    requestBody: {
      userId: new Str({ required: true, description: "Owner user id." }),
      id: new Str({ required: true, description: "Archive id." }),
    },
    responses: { "200": { description: "Deleted", schema: { response: "Deleted" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, id } = data.body;
    const row = await env.DB.prepare("SELECT user_id FROM archives WHERE id = ?").bind(String(id)).first();
    if (!row || String(row.user_id) !== String(userId)) return json({ error: "not found" }, 404);
    await env.DB.prepare("DELETE FROM archives WHERE id = ?").bind(String(id)).run();
    await env.post.delete(`archive:${String(id)}`);
    return json({ ok: true });
  }
}

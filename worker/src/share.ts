/**
 * Shared conversations — stored in the `post` KV namespace (repurposed;
 * it was bound but unused).
 *
 *   POST /share       { name, messages } → { id }   (internal-key guarded)
 *   GET  /share?id=   → { name, messages, created }
 *
 * Replaces base64-in-URL sharing, which capped at ~2000 chars.
 * Shares are immutable, capped at 256KB, and expire after 90 days.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const MAX_SHARE_BYTES = 256 * 1024;
const TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export class ShareCreateCall extends OpenAPIRoute {
  static schema = {
    tags: ["Share"],
    summary: "Store a conversation snapshot, returns a short share id.",
    requestBody: {
      name: new Str({ required: true, description: "Tiny name the conversation belongs to." }),
      messages: new Str({ required: true, description: "Conversation JSON (array of messages)." }),
      userId: new Str({ required: false, description: "Owner user id (internal) — enables account-based revocation." }),
    },
    responses: {
      "200": { description: "Share created", schema: { response: "Share created" } },
    },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    // Only our app can create shares (prevents abuse as free KV storage)
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);

    const { name, messages, userId } = data.body;
    if (typeof messages !== "string" || messages.length > MAX_SHARE_BYTES) {
      return json({ error: `messages must be JSON ≤ ${MAX_SHARE_BYTES / 1024}KB` }, 400);
    }
    let parsed: any;
    try { parsed = JSON.parse(messages); } catch { return json({ error: "messages must be valid JSON" }, 400); }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return json({ error: "messages must be a non-empty array" }, 400);
    }

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    // Revoke token: returned only at creation; required to delete the share
    const revokeToken = crypto.randomUUID().replace(/-/g, "");
    await env.post.put(
      `share:${id}`,
      JSON.stringify({ name: String(name).slice(0, 64), messages: parsed, created: Date.now(), revokeToken }),
      { expirationTtl: TTL_SECONDS }
    );

    // Logged-in creators also get account-based management (cross-device)
    if (userId) {
      try {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO shares (id, user_id, tiny_name) VALUES (?, ?, ?)"
        ).bind(id, String(userId), String(name).slice(0, 64)).run();
      } catch (err) { console.log(err, 'shares insert'); }
    }

    return json({ id, revokeToken });
  }
}

/** GET /share/list?userId= — internal: a user's shares (newest first). */
export class ShareListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Share"],
    summary: "Internal: list shares created by a user.",
    parameters: {
      userId: Query(String, { required: true, description: "User id." }),
    },
    responses: {
      "200": { description: "User's shares", schema: { response: "User's shares" } },
    },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, tiny_name, created FROM shares WHERE user_id = ? ORDER BY created DESC LIMIT 100"
      ).bind(userId).all();
      return json({ shares: results || [] });
    } catch (err) {
      // Fail honestly: a masked-empty 200 {shares:[]} is byte-identical to a
      // user with zero shares, so a D1 outage would read as "no share links
      // yet" at the client. Mirror the sibling read handlers (profile/community
      // → {error},500) so a caller gating on `error` can tell the difference.
      console.log(err, 'shares list');
      return json({ shares: [], error: "shares unavailable" }, 500);
    }
  }
}

export class ShareDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["Share"],
    summary: "Revoke a shared conversation (requires the creation revoke token).",
    requestBody: {
      id: new Str({ required: true, description: "Share id." }),
      revokeToken: new Str({ required: false, description: "Token returned at creation." }),
      userId: new Str({ required: false, description: "Owner user id (internal) — alternative to revokeToken." }),
    },
    responses: {
      "200": { description: "Share revoked", schema: { response: "Share revoked" } },
    },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { id, revokeToken, userId } = data.body;
    if (!/^[a-f0-9]{12}$/.test(String(id))) return json({ error: "invalid id" }, 400);
    const share = await env.post.get(`share:${id}`, { type: "json" });
    if (!share) return json({ ok: true, note: "already gone" });

    // Authorize by token OR account ownership (shares table)
    let allowed = !!share.revokeToken && !!revokeToken && share.revokeToken === revokeToken;
    if (!allowed && userId) {
      try {
        const row = await env.DB.prepare("SELECT user_id FROM shares WHERE id = ?").bind(id).first();
        allowed = !!row && row.user_id === String(userId);
      } catch (err) { console.log(err, 'shares owner lookup'); }
    }
    if (!allowed) return json({ error: "not authorized to revoke this share" }, 403);

    await env.post.delete(`share:${id}`);
    try { await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(id).run(); } catch { }
    return json({ ok: true });
  }
}

export class ShareGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Share"],
    summary: "Fetch a shared conversation by id.",
    parameters: {
      id: Query(String, { required: true, description: "Share id." }),
    },
    responses: {
      "200": { description: "Shared conversation", schema: { response: "Shared conversation" } },
    },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    const id = String(data.id || data.query?.id || new URL(request.url).searchParams.get("id") || "");
    if (!/^[a-f0-9]{12}$/.test(id)) return json({ error: "invalid id" }, 400);
    const share = await env.post.get(`share:${id}`, { type: "json" });
    if (!share) return json({ error: "not found or expired" }, 404);
    const { revokeToken: _secret, ...publicShare } = share; // never leak the token
    return new Response(JSON.stringify(publicShare), {
      headers: {
        "Content-Type": "application/json",
        // private: shares are revocable (ShareDeleteCall) — a `public`
        // max-age let CDN/intermediary caches keep serving a revoked share
        // to anyone for 5 more minutes. Browser-local caching is fine.
        "Cache-Control": "private, max-age=300",
      },
    });
  }
}

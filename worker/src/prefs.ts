/**
 * Per-user preferences KV-over-D1 (internal). First consumer:
 * disabled_tools (manage_tools). Values are strings, ≤2KB.
 *
 *   GET  /prefs?userId=&key=   → { value }
 *   POST /prefs                { userId, key, value }
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export class PrefsGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Prefs"],
    summary: "Internal: read a user pref.",
    parameters: {
      userId: Query(String, { required: true, description: "User id." }),
      key: Query(String, { required: true, description: "Pref key." }),
    },
    responses: { "200": { description: "Value", schema: { response: "Value" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const userId = q.get('userId') || '';
    const key = q.get('key') || '';
    if (!userId || !key) return json({ error: "userId and key required" }, 400);
    const row = await env.DB.prepare("SELECT value FROM user_prefs WHERE user_id = ? AND key = ?")
      .bind(userId, key).first();
    return json({ value: row?.value ?? null });
  }
}

export class PrefsSetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Prefs"],
    summary: "Internal: set a user pref.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      key: new Str({ required: true, description: "Pref key." }),
      value: new Str({ required: false, description: "Value (≤2KB; empty clears)." }),
    },
    responses: { "200": { description: "Set", schema: { response: "Set" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, key, value } = data.body;
    if (!userId || !key) return json({ error: "userId and key required" }, 400);
    // Page customizations (custom_css/custom_js) get more room than plain prefs
    const cap = String(key).startsWith('custom_') ? 8192 : 2048;
    const v = String(value ?? '').slice(0, cap);
    if (!v) {
      await env.DB.prepare("DELETE FROM user_prefs WHERE user_id = ? AND key = ?")
        .bind(String(userId), String(key)).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO user_prefs (user_id, key, value, updated) VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated = unixepoch()`
      ).bind(String(userId), String(key), v).run();
    }
    return json({ ok: true });
  }
}

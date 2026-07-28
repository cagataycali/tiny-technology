/**
 * Runtime user tools (issue #8) — persistence CRUD. Validation/execution
 * happens app-side (edge sandbox); the worker just stores.
 *
 *   GET    /tools?userId=            (internal) → { tools }
 *   POST   /tools                    (internal) { userId, name, description, params, code }
 *   DELETE /tools                    (internal) { userId, name }
 *
 * Caps: 10000 tools/user (an abuse backstop, not a product limit), 4KB code each.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { escapeLike } from "./sql";

const MAX_TOOLS = 10000;
const MAX_CODE_BYTES = 4 * 1024;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export class ToolsListCall extends OpenAPIRoute {
  static schema = {
    tags: ["UserTools"],
    summary: "Internal: list a user's custom tools.",
    parameters: { userId: Query(String, { required: true, description: "User id." }) },
    responses: { "200": { description: "Tools", schema: { response: "Tools" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    try {
      const { results } = await env.DB.prepare(
        "SELECT name, description, params_json, code, created FROM user_tools WHERE user_id = ? ORDER BY created ASC"
      ).bind(userId).all();
      return json({ tools: results || [] });
    } catch (err) {
      console.log(err, 'tools list');
      // Fail honestly (500), NOT a masked-empty 200. The Next proxy
      // (app/api/tools/route.ts) gates on `data.error` to emit a 424, and the
      // Control panel keys its render on that — a 200 `{tools:[]}` here is
      // byte-identical to a user with no forged tools, so a D1 read error made
      // the tool box look EMPTY (tools apparently deleted) during a live
      // outage. Sibling read handlers (list.ts / events.ts / learnings.ts) all
      // return {error},500 for exactly this reason.
      return json({ error: "tools unavailable" }, 500);
    }
  }
}

export class ToolsUpsertCall extends OpenAPIRoute {
  static schema = {
    tags: ["UserTools"],
    summary: "Internal: create/update a user tool.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      name: new Str({ required: true, description: "Tool name (snake_case)." }),
      description: new Str({ required: false, description: "What the tool does." }),
      params: new Str({ required: false, description: "JSON {argName: description}." }),
      code: new Str({ required: true, description: "JS function body (≤4KB)." }),
    },
    responses: { "200": { description: "Stored", schema: { response: "Stored" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, name, description, params, code } = data.body;
    const toolName = String(name || '').trim();
    if (!userId || !toolName || !code) return json({ error: "userId, name, code required" }, 400);
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(toolName)) {
      return json({ error: "name must be snake_case, 3-40 chars" }, 400);
    }
    if (String(code).length > MAX_CODE_BYTES) {
      return json({ error: `code too large (max ${MAX_CODE_BYTES / 1024}KB)` }, 400);
    }
    // params rides every public /tools/browse and /profile response — cap it
    // (code is capped at 4KB; params had no bound) and require a plain object
    // so JSON like `"x"` or `5` can't replace the {} shape downstream.
    if (params && String(params).length > MAX_CODE_BYTES) {
      return json({ error: `params too large (max ${MAX_CODE_BYTES / 1024}KB)` }, 400);
    }
    let paramsObj: any = {};
    if (params) { try { paramsObj = JSON.parse(params); } catch { return json({ error: "params must be JSON" }, 400); } }
    if (typeof paramsObj !== "object" || paramsObj === null || Array.isArray(paramsObj)) {
      return json({ error: "params must be a JSON object" }, 400);
    }

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM user_tools WHERE user_id = ?"
    ).bind(String(userId)).all();
    const existing = await env.DB.prepare(
      "SELECT id FROM user_tools WHERE user_id = ? AND name = ?"
    ).bind(String(userId), toolName).first();
    if (!existing && Number(results?.[0]?.c || 0) >= MAX_TOOLS) {
      return json({ error: `tool limit reached (${MAX_TOOLS})` }, 429);
    }

    await env.DB.prepare(
      `INSERT INTO user_tools (user_id, name, description, params_json, code)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, name) DO UPDATE SET
         description = excluded.description,
         params_json = excluded.params_json,
         code = excluded.code`
    ).bind(String(userId), toolName, String(description || '').slice(0, 300),
           JSON.stringify(paramsObj), String(code)).run();
    return json({ ok: true, name: toolName, updated: !!existing });
  }
}

export class ToolsDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["UserTools"],
    summary: "Internal: delete a user tool.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      name: new Str({ required: true, description: "Tool name." }),
    },
    responses: { "200": { description: "Deleted", schema: { response: "Deleted" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, name } = data.body;
    const res = await env.DB.prepare("DELETE FROM user_tools WHERE user_id = ? AND name = ?")
      .bind(String(userId), String(name)).run();
    // Honest count — deleting a tool that doesn't exist is a 404, not ok
    if (!res?.meta?.changes) return json({ ok: false, error: `no tool named '${name}'` }, 404);
    return json({ ok: true });
  }
}

/**
 * GET /tools/browse — PUBLIC marketplace listing (issue #15).
 *
 * Every forged tool is public by design (visible on builder profiles),
 * so the marketplace is just the union of everyone's tools, newest
 * first, with the author attached so install flows can credit + trust.
 * Code included: it's already public on /profile, and install needs it.
 */
export class ToolsBrowseCall extends OpenAPIRoute {
  static schema = {
    tags: ["UserTools"],
    summary: "Public: browse all forged tools (the marketplace).",
    parameters: {
      q: Query(String, { required: false, description: "Filter by name/description substring." }),
      limit: Query(Number, { required: false, default: 30, description: "Max results (1-100)." }),
    },
    responses: { "200": { description: "Tools with authors", schema: { response: "Tools with authors" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    const sp = new URL(request.url).searchParams;
    // Escape LIKE metacharacters so a search of '%'/'_' matches literally
    const q = escapeLike(String(data.q ?? sp.get('q') ?? '').slice(0, 80));
    const limit = Math.min(Math.max(Number(data.limit ?? sp.get('limit')) || 30, 1), 100);
    try {
      const { results } = await env.DB.prepare(
        `SELECT t.name, t.description, t.params_json, t.code, t.created,
                u.github_login AS author
         FROM user_tools t JOIN users u ON u.id = t.user_id
         WHERE t.name LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\'
         ORDER BY t.created DESC LIMIT ?`
      ).bind(`%${q}%`, `%${q}%`, limit).all();
      return new Response(JSON.stringify({ tools: results || [] }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        },
      });
    } catch (err) {
      console.log(err, 'tools browse');
      // Defensive parity with ToolsListCall's fix: fail honestly (500) rather
      // than a masked-empty 200. Today's sole consumer (the chat-route
      // marketplace browse) reads d.tools without gating on status, so it
      // degrades to an empty list either way — but a 200 {tools:[]} here would
      // trap any FUTURE status-gating consumer into "no tools match" during a
      // live D1 outage. (The 60s success cache above does NOT apply to this
      // error path — json() sets no Cache-Control.)
      return json({ error: "tools unavailable" }, 500);
    }
  }
}

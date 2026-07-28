import { OpenAPIRoute, Query } from "@cloudflare/itty-router-openapi";
import { escapeLike } from "./sql";

/**
 * GET /list — public directory of tinys.
 *
 * Serves from the tiny-v2 `tinys` table (public + active only) instead of
 * raw KV keys: KV listing exposed private tinys' names and legacy debris.
 * Response keeps the KV-era shape ({ keys: [{name}], list_complete, cursor })
 * for existing consumers (list_tiny tool).
 */
export class ListCall extends OpenAPIRoute {
  static schema = {
    tags: ["List Tiny"],
    summary: "List public tinys.",
    parameters: {
      cursor: Query(String, {
        description: "Offset cursor from a previous page",
        required: false,
      }),
      limit: Query(Number, {
        description: "Results per page (max 1000)",
        required: false,
        default: 100,
      }),
      prefix: Query(String, {
        description: "Filter by name prefix",
        required: false,
      }),
    },
    responses: {
      "200": {
        description: "Successful response",
        schema: {
          response: "Listed as JSON"
        },
      },
    },
  };

  async handle(
    request: Request,
    env: any,
    _ctx: any,
    data: Record<string, any>
  ) {
    const q = new URL(request.url).searchParams;
    const limit = Math.min(Math.max(Number(data.limit ?? q.get('limit')) || 100, 1), 1000);
    const offset = Math.max(Number(data.cursor ?? q.get('cursor')) || 0, 0);
    // Escape LIKE metacharacters so a prefix of '%' or '_' matches
    // literally instead of acting as a wildcard (silently ignoring the
    // caller's filter). ESCAPE '\' below binds the escape char.
    const prefix = escapeLike(String(data.prefix ?? q.get('prefix') ?? ''));

    try {
      const { results } = await env.DB.prepare(
        `SELECT name FROM tinys
         WHERE private = 0 AND active = 1 AND name LIKE ? ESCAPE '\\'
         ORDER BY created DESC
         LIMIT ? OFFSET ?`
      ).bind(`${prefix}%`, limit + 1, offset).all();

      const rows = results || [];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);

      return new Response(JSON.stringify({
        keys: page.map((r: any) => ({ name: r.name })),
        list_complete: !hasMore,
        ...(hasMore ? { cursor: String(offset + limit) } : {}),
      }), { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      console.log(err, 'list');
      // Fail honestly (500), NOT a masked-empty 200. A D1 read error returned
      // as {keys:[], list_complete:true} is byte-identical to a legitimately
      // empty directory: CommandPalette.tsx gates on r.ok BEFORE parsing to
      // tell outage from empty ("couldn't reach the universe" vs "Nothing
      // matches"), and a 200 here defeats that guard — the exact masked-empty
      // pattern events.ts / community.ts / profile.ts siblings all avoid.
      return new Response(JSON.stringify({ error: "list unavailable" }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}

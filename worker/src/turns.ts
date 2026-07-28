/**
 * Per-tiny private turn memory (private-tinys feature — "store every turn in
 * vector index so it remembers more things").
 *
 * When an AUTHORIZED owner talks to their PRIVATE tiny, the app posts each
 * completed exchange here. We embed it into the Vectorize MEMORY index and
 * store the text in D1 `notes` — the EXACT shape retrieve.ts's private branch
 * already reads:
 *
 *   retrieve.ts:  MEMORY.query(vectors, { filter: { name } })
 *                 → vec ids → SELECT * FROM notes WHERE id IN (...)
 *                 → payload.memory → injected into the chat system prompt.
 *
 * That read path shipped with no writer; this endpoint is the writer. It never
 * touches get.ts/upsert.ts.
 *
 *   POST /turns { name, userId, user, assistant } → { ok, id, indexed, total }
 *
 * Guardrails:
 *  - Internal-key only, and the caller-forwarded userId MUST own the tiny
 *    (same ownership check as get.ts / retrieve.ts) — a turn is stored only
 *    for the vouched owner of a genuinely private tiny.
 *  - Bounded: past MAX_TURNS the oldest rows (and their vectors) are pruned,
 *    so an active private tiny can't grow the index without limit. Unlike
 *    `learnings` (deliberate, reject-when-full), turn memory is a rolling
 *    transcript — silent pruning of the tail is the intended behavior.
 */
import { OpenAPIRoute } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const OpenAI = require("openai");

// A private tiny's rolling transcript window. Large enough to "remember more
// things" across long ownership, bounded so the shared MEMORY index and D1
// stay healthy. Oldest-first pruning keeps recent context.
export const MAX_TURNS = 2000;
export const MAX_TEXT_BYTES = 4000;

/**
 * Snapshot one exchange the way retrieve.ts surfaces it back into the system
 * prompt (one "- <text>" bullet per note). Bounded so a runaway message can't
 * bloat the stored row / embed input. Pure — unit-tested.
 */
export function formatTurn(user: string, assistant: string): string {
  return `User: ${String(user || '').trim()}\nAssistant: ${String(assistant || '').trim()}`
    .slice(0, MAX_TEXT_BYTES);
}

/**
 * How many oldest rows to prune so `total` stored turns fits MAX_TURNS. Never
 * negative; 0 means nothing to prune. Pure — unit-tested.
 */
export function pruneCount(total: number): number {
  return Math.max(0, total - MAX_TURNS);
}

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function embed(env: any, text: string): Promise<number[] | null> {
  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
      encoding_format: "float",
    });
    return res.data[0].embedding;
  } catch (err) {
    console.log(err, 'turn embed');
    return null;
  }
}

export class TurnStoreCall extends OpenAPIRoute {
  static schema = {
    tags: ["Turns"],
    summary: "Internal: store one private-tiny exchange into per-tiny turn memory.",
    responses: {
      "200": { description: "Stored", schema: { response: "ok" } },
    },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);

    let body: any = {};
    try { body = await request.json(); } catch { /* {} */ }
    const name = String(body?.name || '').trim();
    const userId = String(body?.userId || '').trim();
    const user = String(body?.user || '').trim();
    const assistant = String(body?.assistant || '').trim();

    if (!name || !userId) return json({ error: "name and userId required" }, 400);
    // Nothing worth remembering — don't burn an embed call on an empty turn.
    if (!user && !assistant) return json({ ok: true, skipped: "empty" });

    try {
      // Ownership + privacy gate — mirrors get.ts / retrieve.ts. Turn memory
      // exists ONLY for the vouched owner of a genuinely private tiny; a public
      // tiny (or a non-owner) must never accumulate a stored transcript.
      const db = await env.tiny.get(name, { type: "json" });
      if (!db || !db.private) return json({ ok: true, skipped: "not-private" });
      let authorized = false;
      try {
        const row = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(name).first();
        authorized = !!row && row.user_id === userId;
      } catch (err) { console.log(err, 'turn owner lookup'); }
      if (!authorized) return json({ error: "not authorized for this tiny" }, 403);

      // Snapshot the exchange the way retrieve.ts surfaces it (one bullet per
      // note). Bounded so a runaway message can't bloat the row/embed.
      const text = formatTurn(user, assistant);

      const res = await env.DB.prepare(
        "INSERT INTO notes (name, user_id, text) VALUES (?, ?, ?) RETURNING id"
      ).bind(name, userId, text).first();
      const id = res?.id;
      if (id == null) return json({ error: "failed to store turn" }, 500);

      // Best-effort semantic index — a failed embed degrades recall, not
      // storage. Vector id = the row's integer id (bare, no prefix) with
      // {name} metadata: exactly what retrieve.ts filters + joins on.
      let indexed = false;
      const vectors = await embed(env, text);
      if (vectors) {
        try {
          await env.MEMORY.upsert([{ id: String(id), values: vectors, metadata: { name } }]);
          indexed = true;
        } catch (err) { console.log(err, 'turn vector upsert'); }
      }

      // Rolling prune: past MAX_TURNS drop the oldest rows AND their vectors so
      // the shared MEMORY index doesn't grow unbounded for a chatty private tiny.
      let total = MAX_TURNS;
      try {
        const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE name = ?").bind(name).first();
        total = Number(cnt?.n) || 0;
        const over = pruneCount(total);
        if (over > 0) {
          const { results } = await env.DB.prepare(
            "SELECT id FROM notes WHERE name = ? ORDER BY created ASC, id ASC LIMIT ?"
          ).bind(name, over).all();
          const oldIds = (results || []).map((r: any) => r.id).filter((v: any) => v != null);
          if (oldIds.length) {
            const placeholders = oldIds.map(() => "?").join(", ");
            await env.DB.prepare(`DELETE FROM notes WHERE id IN (${placeholders})`).bind(...oldIds).run();
            try { await env.MEMORY.deleteByIds(oldIds.map((v: any) => String(v))); }
            catch (err) { console.log(err, 'turn vector prune'); }
            total = MAX_TURNS;
          }
        }
      } catch (err) { console.log(err, 'turn prune'); }

      return json({ ok: true, id, indexed, total });
    } catch (err) {
      console.log(err, 'turn store');
      return json({ error: "failed to store turn" }, 500);
    }
  }
}

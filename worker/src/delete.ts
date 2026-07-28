/**
 * DELETE /tiny — permanently remove a tiny.
 *
 * Internal-key guarded; authorized by tiny-v2 ownership (userId must match).
 * Cleans every store: KV config, tinys row, vector index embedding, per-tiny
 * private turn memory (`notes` + their MEMORY vectors), and cascades to the
 * tiny's scheduled jobs (deleted) + Telegram bot (disabled).
 *
 * ⚠️ TWO ORDERING RULES, both learned from real defects:
 *
 *  1. `tinys` IS DELETED LAST, AND ONLY IF NOTHING ELSE FAILED. The
 *     authorization row is READ from `tinys`, so deleting it first destroys
 *     this operation's own permission slip: any later failure meant the
 *     "idempotent re-run" this file promises hit the 404 instead, leaving
 *     orphaned jobs firing forever against an empty /get. Order alone does not
 *     fix that — every step has its own try/catch and none of them abort the
 *     handler — so failures are collected and the last delete is withheld.
 *
 *  2. `notes` IS DELETED AT ALL. Freeing the slug while its private
 *     transcripts stay behind was a cross-tenant leak: the slug is a LEASE,
 *     anyone may claim it next (upsert's ON CONFLICT(name) DO NOTHING), and
 *     the recall path filters vectors by slug. retrieve.ts now also scopes the
 *     read by user_id, so either half alone closes the leak — the read scope
 *     is the security boundary, and this is the retention half: a deleted
 *     tiny's transcripts should not survive it regardless.
 */
import { OpenAPIRoute, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
const slugify = require('slugify');

/**
 * Every store keyed by a tiny's SLUG, and what removes it here. Exported so a
 * test can fail when a migration adds a slug-keyed column that nobody wired
 * into this cascade — the whole class of bug in rule 2 above is defined by
 * ABSENCE, which no grep for a symbol can find.
 *
 * `handled: false` entries are deliberate, documented exceptions.
 */
export const TINY_OWNED_STORES: { store: string; column: string; handled: boolean; how: string }[] = [
  { store: 'tinys', column: 'name', handled: true, how: 'DELETE (last — carries this route\'s authorization)' },
  { store: 'notes', column: 'name', handled: true, how: 'DELETE + MEMORY.deleteByIds on the row ids' },
  { store: 'jobs', column: 'tiny_slug', handled: true, how: 'DELETE, owner-scoped' },
  { store: 'job_runs', column: 'job_id', handled: true, how: 'DELETE via the jobs subquery, before jobs' },
  { store: 'telegram_bots', column: 'tiny_slug', handled: true, how: 'UPDATE enabled = 0 — user-level resource, re-pointable' },
  { store: 'shares', column: 'tiny_name', handled: false, how: 'opaque random id + TTL; a share of a deleted tiny reads as expired' },
  { store: 'archives', column: 'tiny_name', handled: false, how: 'opaque random id; the owner\'s own saved copy, deliberately outlives the tiny' },
  { store: 'voice_sessions', column: 'tiny_name', handled: false, how: 'no delete path exists yet anywhere — tracked as its own gap, not silently absent' },
];

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export class TinyDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["Delete Tiny"],
    summary: "Permanently delete a tiny (owner only).",
    requestBody: {
      name: new Str({ required: true, description: "Tiny name." }),
      userId: new Str({ required: true, description: "Owner user id (internal)." }),
    },
    responses: {
      "200": { description: "Deleted", schema: { response: "Deleted" } },
    },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);

    // Resolve the stored key the same way /get does: new tinys use upsert's
    // strict slug ("my!tiny" → "mytiny"), pre-strict legacy tinys were stored
    // loosely. A loose-only slug here would miss a strict-stored row and leave
    // the owner unable to delete their tiny. Try strict, fall back to loose.
    const rawName = String(data.body.name || '');
    const userId = String(data.body.userId || '');
    let name = slugify(rawName, { lower: true, strict: true });
    if (!name || !userId) return json({ error: "name and userId required" }, 400);

    let row: any = null;
    try {
      row = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(name).first();
      if (!row) {
        const loose = slugify(rawName, { lower: true });
        if (loose && loose !== name) {
          const legacy = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(loose).first();
          if (legacy) { row = legacy; name = loose; }
        }
      }
    } catch (err) { console.log(err, 'delete lookup'); }

    if (!row) return json({ error: "not found" }, 404);
    if (row.user_id !== userId) return json({ error: "not authorized — this tiny belongs to another account" }, 403);

    // Clean every store. ⚠️ `tinys` is NOT in this group — see rule 1 in the file
    // header. It is the LAST write in the handler, because it is the row `row`
    // above was read from.
    //
    // ⚠️ AND ORDER ALONE IS NOT ENOUGH. Every step below has its own try/catch, so
    // a failure does not abort the handler — which means moving `tinys` to the end
    // would have deleted it anyway and the "idempotent re-run" promise would still
    // have been a comment, not a behaviour. The failures have to be COLLECTED and
    // the last delete WITHHELD; that is what makes the ordering load-bearing.
    const failed: string[] = [];

    try { await env.tiny.delete(name); } catch (err) { console.log(err, 'kv delete'); failed.push('config'); }
    // Best-effort, deliberately NOT blocking: an orphaned universe-search vector
    // degrades search results and cannot serve anyone's private data. Blocking on
    // it would mean a Vectorize outage makes a tiny undeletable — a worse outcome
    // than a stale search hit, and the retry that fixes it has no deadline.
    try { await env.VECTOR_INDEX.deleteByIds([name]); } catch (err) { console.log(err, 'vector delete'); }

    // Private turn memory. Two stores, one owner: the D1 rows and their MEMORY
    // vectors, whose ids ARE the row ids (turns.ts upserts `String(id)` with
    // metadata { name }). Read the ids BEFORE deleting the rows — after the
    // DELETE there is nothing left to name the vectors, and an orphaned vector
    // still matches the slug filter, which is how the leak stayed invisible.
    //
    // Scoped by slug, not by owner: a note can only have been written for a
    // vouched owner of THIS slug (turns.ts:106), and rows from a previous
    // holder of the name are exactly what must not survive here.
    try {
      const { results } = await env.DB.prepare("SELECT id FROM notes WHERE name = ?").bind(name).all();
      const ids = (results || []).map((r: any) => r.id).filter((v: any) => v != null);
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(", ");
        await env.DB.prepare(`DELETE FROM notes WHERE id IN (${placeholders})`).bind(...ids).run();
        // This one DOES block the final delete. An orphaned MEMORY vector still
        // matches the `{ name }` recall filter, so leaving one behind while freeing
        // the slug is the leak itself — the exact opposite of the search index above.
        try { await env.MEMORY.deleteByIds(ids.map((v: any) => String(v))); }
        catch (err) { console.log(err, 'notes vector delete'); failed.push('turn-memory-vectors'); }
      }
    } catch (err) { console.log(err, 'notes delete'); failed.push('turn-memory'); }

    // Cascade to background work that targets this tiny — otherwise a deleted
    // tiny's scheduled jobs keep firing forever (against a now-empty /get,
    // burning the owner's job quota + compute + generic push spam). Scoped to
    // the owner so a slug reused by another account is untouched.
    try {
      // job_runs has no FK cascade — delete run history FIRST (while the jobs
      // rows still exist for the subquery), then the jobs. Mirrors JobsDeleteCall.
      await env.DB.prepare(
        "DELETE FROM job_runs WHERE job_id IN (SELECT id FROM jobs WHERE user_id = ? AND tiny_slug = ?)"
      ).bind(userId, name).run();
      await env.DB.prepare("DELETE FROM jobs WHERE user_id = ? AND tiny_slug = ?").bind(userId, name).run();
    } catch (err) { console.log(err, 'jobs delete'); failed.push('jobs'); }
    // Telegram bot: DISABLE (not delete) — it's a user-level resource that can
    // be re-pointed at another tiny; keep the token but stop it polling for the
    // now-gone tiny.
    try { await env.DB.prepare("UPDATE telegram_bots SET enabled = 0 WHERE user_id = ? AND tiny_slug = ?").bind(userId, name).run(); } catch (err) { console.log(err, 'telegram disable'); failed.push('telegram'); }

    // LAST, and only if everything that MUST precede it did. This row is both the
    // authorization for this route and the lock on the slug: deleting it releases
    // the name for anyone to claim (upsert's ON CONFLICT(name) DO NOTHING). So
    // while a dependent store still holds rows, keeping the row is strictly safer
    // than freeing the name — and it is the only thing that lets the caller retry.
    //
    // The tiny stays listed for its owner in the meantime, which is the honest
    // state: the delete did not finish. A 500 with the failed stores named beats
    // `ok: true` over a half-deleted tiny, because only one of the two tells the
    // owner to press the button again.
    //
    // The copy says "not finished", NOT "nothing changed" — by this point the KV
    // config may already be gone, so promising the tiny is untouched would be the
    // same species of lie as the `ok: true` this replaces.
    if (failed.length) {
      return json({
        error: `couldn't finish deleting — ${failed.join(', ')} could not be cleared, `
          + `so the tiny is still yours and its name is still reserved. Try again.`,
        stores: failed,
      }, 500);
    }

    try {
      await env.DB.prepare("DELETE FROM tinys WHERE name = ?").bind(name).run();
    } catch (err) {
      console.log(err, 'd1 delete');
      return json({ error: "couldn't finish deleting — try again.", stores: ['tiny'] }, 500);
    }

    return json({ ok: true, deleted: name });
  }
}

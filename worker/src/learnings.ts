/**
 * Per-user persistent memory (issue #14, v2 — unified learn/unlearn).
 *
 * D1 `learnings` is the source of truth; every entry is ALSO embedded into
 * the Vectorize MEMORY index (id `learning:<rowid>`, metadata {userId}) so
 * the agent can semantically recall across the user's entire memory,
 * filtered per user. All internal-key guarded; userId comes from the app's
 * session.
 *
 *   GET    /learnings?userId=&limit=&q= → { learnings, total, bytes, capacity, relevant? }
 *                                         `q` adds semantic matches; limit=0 skips the recent list
 *   POST   /learnings { userId, content } → { ok, id, total, capacity, indexed }
 *   DELETE /learnings { userId, id? }     (id absent → clear all; vectors deleted too)
 *
 * No silent eviction: v1 LRU-evicted at 8KB total, which destroyed old
 * memories one-per-write during bulk saves (see memory-tool-issue.md).
 * A full store now REJECTS the write with a clear error so the agent can
 * unlearn/consolidate deliberately instead of overwriting blindly.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { emitEvent } from "./events";
import { grantReputation, followRef, mutualRef } from "./reputation";
// Memory graph: entity table is becoming the source of
// truth; learnings stays dual-written for rollback during transition.
import { RECENT_SQL, RECENT_ALL_SQL, TOTALS_SQL, BY_VEC_SQL, CLOSE_SQL, PURGE_ALL_FACTS_SQL, PURGE_ALL_FACT_EDGES_SQL, NODES_SQL, ALL_NODES_SQL, ALL_EDGES_SQL, CONFLICTS_SQL, SOCIAL_RELS, SOCIAL_NEIGHBORS_SQL, CONSULTED_EDGES_SQL, FACT_FEED_SQL, FEED_SQL, FOLLOWING_SQL, SOCIAL_OWNER, userNodeId, insertFactEntity, resolveEntityId, legacyVecId, supersede, insertEdges, neighbors, rankExpanded, groupConflicts, resolveConflict, recordSocialEdge, trustRank, type EdgeInput } from "./graph";

const OpenAI = require("openai");

const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 2000;
const RECALL_TOP_K = 8;
const RECALL_CUTOFF = 0.3;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const vecId = (id: number | string) => `learning:${id}`;

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
    console.log(err, 'memory embed');
    return null;
  }
}

export class LearningsListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: list a user's memories; `q` adds per-user semantic recall.",
    parameters: {
      userId: Query(String, { required: true, description: "User id." }),
      limit: Query(Number, { required: false, description: "Recent entries to return (0-500, default 100; 0 = none)." }),
      q: Query(String, { required: false, description: "Semantic recall query across ALL the user's memories." }),
      include_closed: Query(String, { required: false, description: "'1' → recent list AND semantic recall also return closed (superseded/unlearned) facts with freshness fields." }),
      hops: Query(Number, { required: false, description: "0 (default) = pure vector recall; 1 = expand matches one hop through live graph edges, ranked cosine × weight × confidence × recency." }),
    },
    responses: { "200": { description: "Memories", schema: { response: "Memories" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const params = new URL(request.url).searchParams;
    const userId = params.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    // Distinguish "absent" (→ default 100) from "explicitly 0" (→ none):
    // Number(null) and Number("") are both 0, so a bare list call would
    // otherwise skip the recent-entries query and return NO memories despite
    // the documented default of 100.
    const rawLimit = params.get("limit");
    const parsed = rawLimit === null || rawLimit.trim() === "" ? 100 : Number(rawLimit);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 500) : 100;
    const q = (params.get("q") || "").trim();
    const includeClosed = params.get("include_closed") === "1";
    const hops = Math.min(Math.max(Number(params.get("hops")) || 0, 0), 1);

    try {
      // Graph-backed: live facts only — a closed (superseded/
      // unlearned) memory drops out of listings exactly like the old DELETE
      // did, but the row survives for provenance/history.
      const totals = await env.DB.prepare(TOTALS_SQL).bind(userId).first();

      let learnings: any[] = [];
      if (limit > 0) {
        const { results } = await env.DB.prepare(includeClosed ? RECENT_ALL_SQL : RECENT_SQL)
          .bind(userId, limit).all();
        learnings = (results || []).reverse(); // oldest → newest for display
      }

      // Semantic recall across the whole store, filtered to this user
      let relevant: any[] | undefined;
      if (q) {
        const vectors = await embed(env, q);
        if (vectors) {
          try {
            const res = await env.MEMORY.query(vectors, {
              topK: RECALL_TOP_K,
              filter: { userId: String(userId) },
            });
            const scored = (res.matches || [])
              .filter((m: any) => m.score > RECALL_CUTOFF)
              .map((m: any) => ({ vecId: String(m.id ?? m.vectorId), score: m.score }))
              .filter((m: any) => m.vecId && m.vecId !== 'undefined');
            if (scored.length) {
              // Join D1 by vec_id — the entity row is the truth, the vector
              // is the pointer. Closed facts are filtered here (their
              // vectors persist in Vectorize by design — bitemporal), and
              // include_closed=1 lets recall reach history deliberately.
              const { results } = await env.DB.prepare(
                BY_VEC_SQL(scored.length, includeClosed)
              ).bind(userId, ...scored.map((m: any) => m.vecId)).all();
              const byVec = new Map<string, any>((results || []).map((r: any) => [r.vec_id, r]));
              relevant = scored
                .filter((m: any) => byVec.has(m.vecId))
                .map((m: any) => {
                  const { vec_id, valid_to, ...row } = byVec.get(m.vecId);
                  return {
                    ...row,
                    score: Number(m.score.toFixed(3)),
                    ...(includeClosed ? { freshness: valid_to === null ? 'live' : 'closed' } : {}),
                  };
                });

              // Graph expansion (hops=1): expand seeds one hop through live edges —
              // connected facts join the results ranked by
              // cosine × weight × confidence × recency_decay.
              if (hops >= 1 && relevant && relevant.length) {
                try {
                  const seedRows = (results || []); // entity rows for seeds
                  const seedIds = seedRows.map((r: any) => {
                    // recover entity id: BY_VEC returns legacy id on the wire;
                    // vec_id 'learning:<n>' maps back to 'mig12:<n>'
                    const legacy = String(r.vec_id || '').split(':')[1];
                    return legacy ? `mig12:${legacy}` : null;
                  }).filter(Boolean) as string[];
                  const seeds = scored
                    .filter((m: any) => byVec.has(m.vecId))
                    .map((m: any) => ({
                      id: `mig12:${String(m.vecId).split(':')[1]}`,
                      score: m.score,
                    }));

                  // collect live edges around the seeds + hydrate neighbors
                  const edgeSet = new Map<string, any>();
                  const nodeIds = new Set<string>(seedIds);
                  for (const sid of seedIds.slice(0, 8)) {
                    const sub = await neighbors(env, { owner: String(userId), nodeId: sid, hops: 1 });
                    for (const e of sub.edges) edgeSet.set(e.id, e);
                    for (const n of sub.nodes) nodeIds.add(n.id);
                  }
                  const idList = Array.from(nodeIds);
                  const nodeMap = new Map<string, any>();
                  for (let i = 0; i < idList.length; i += 50) {
                    const chunk = idList.slice(i, i + 50);
                    const { results: nrows } = await env.DB.prepare(
                      `SELECT id, valid_from, valid_to, json_extract(attrs_json, '$.source') AS content,
                              COALESCE(json_extract(attrs_json, '$.legacy_id'), id) AS wire_id, created
                       FROM entity WHERE owner = ? AND id IN (${chunk.map(() => '?').join(',')})`
                    ).bind(String(userId), ...chunk).all();
                    for (const r of nrows || []) nodeMap.set(r.id, r);
                  }
                  const ranked = rankExpanded(
                    seeds,
                    Array.from(edgeSet.values()).map((e: any) => ({ src: e.src, dst: e.dst, weight: e.weight, confidence: e.confidence })),
                    new Map(Array.from(nodeMap, ([k, v]) => [k, { valid_from: v.valid_from }])),
                  );
                  relevant = Array.from(ranked.entries())
                    .map(([id, score]) => {
                      const n = nodeMap.get(id);
                      // closed facts stay out of recall even via edges —
                      // unless include_closed=1 asked for history (same rule
                      // as the hops=0 BY_VEC join), tagged with freshness
                      if (!n || (!includeClosed && n.valid_to !== null)) return null;
                      return {
                        id: n.wire_id, content: n.content, created: n.created,
                        score: Number(score.toFixed(3)),
                        ...(includeClosed ? { freshness: n.valid_to === null ? 'live' : 'closed' } : {}),
                      };
                    })
                    .filter(Boolean)
                    .sort((a: any, b: any) => b.score - a.score)
                    .slice(0, RECALL_TOP_K * 2);
                } catch (err) {
                  console.log(err, 'recall graph expansion'); // fall back to hops=0 results
                }
              }
            } else {
              relevant = [];
            }
          } catch (err) {
            console.log(err, 'memory recall query');
          }
        }
      }

      return json({
        learnings,
        total: Number(totals?.c || 0),
        bytes: Number(totals?.b || 0),
        capacity: MAX_ENTRIES,
        ...(relevant !== undefined ? { relevant } : {}),
      });
    } catch (err) {
      console.log(err, 'learnings list');
      // Fail honestly (500), NOT a masked-empty 200. A D1 read error returned
      // as {learnings:[], total:0} is indistinguishable from a genuinely empty
      // store across the proxy hop: app/api/learnings/route.ts passes the
      // worker's 200/body through verbatim (it only synthesizes a 503 on a
      // fetch *throw*), so MemoryPanel.load() — which routes only `d.error` to
      // its retry branch — takes the success path and renders "No memories yet"
      // over a live outage, with the panel's purpose-built loadError retry UI
      // unreachable. Every sibling here (Add/Delete/Resolve) and events.ts:89
      // already return 500 on a D1 error; only this one masked.
      return json({ error: "memories unavailable" }, 500);
    }
  }
}

export class LearningsAddCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: append a memory for a user (rejects when full — no silent eviction). supersedes closes prior facts bitemporally.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      content: new Str({ required: true, description: `The memory (≤${MAX_ENTRY_BYTES} chars).` }),
      // itty-router-openapi SILENTLY STRIPS undeclared body fields (AGENTS.md
      // gotcha #8) — JSON-string array, parsed below.
      supersedes: new Str({ required: false, description: "JSON array of memory ids this fact replaces (closes them, records supersedes edges)." }),
      edges: new Str({ required: false, description: "JSON array of {rel, dst, scope?, weight?, confidence?} linking this fact to existing memories (rels: part_of|authored|relates_to|about)." }),
      visibility: new Str({ required: false, description: "'public' surfaces this fact to followers (stage 6 feed); default 'private'." }),
    },
    responses: { "200": { description: "Added", schema: { response: "Added" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, content, supersedes: supersedesRaw, edges: edgesRaw, visibility } = data.body;
    const trimmed = String(content || '').trim().slice(0, MAX_ENTRY_BYTES);
    if (!userId || !trimmed) return json({ error: "userId and content required" }, 400);
    let supersedeIds: (string | number)[] = [];
    if (supersedesRaw) {
      try {
        const parsed = JSON.parse(String(supersedesRaw));
        if (Array.isArray(parsed)) supersedeIds = parsed.filter((x) => typeof x === 'string' || typeof x === 'number');
      } catch { /* malformed → ignore, plain learn still works */ }
    }
    let edgeInputs: EdgeInput[] = [];
    if (edgesRaw) {
      try {
        const parsed = JSON.parse(String(edgesRaw));
        if (Array.isArray(parsed)) edgeInputs = parsed.filter((e) => e && typeof e === 'object' && e.rel && e.dst != null);
      } catch { /* malformed → ignore */ }
    }

    try {
      // Capacity counts LIVE facts (closed rows don't consume quota — the
      // graph keeps history without charging the user for it)
      const count = await env.DB.prepare(TOTALS_SQL).bind(String(userId)).first();
      const total = Number(count?.c || 0);
      if (total >= MAX_ENTRIES) {
        return json({
          ok: false,
          error: `memory full (${total}/${MAX_ENTRIES}) — unlearn stale entries or consolidate before adding more`,
          total,
          capacity: MAX_ENTRIES,
        }, 400);
      }

      // Dual-write (transition): learnings row keeps the legacy numeric id
      // (the wire format + existing vec ids key off it); the entity row is
      // the graph's copy with the SAME deterministic id as migration 0012.
      const res = await env.DB.prepare(
        "INSERT INTO learnings (user_id, content) VALUES (?, ?) RETURNING id, created"
      ).bind(String(userId), trimmed).first();
      let entityId: string | null = null;
      let closed: string[] = [];
      if (res?.id != null) {
        try {
          entityId = await insertFactEntity(env, {
          owner: String(userId),
          content: trimmed,
          legacyId: Number(res.id),
          created: Number(res.created) || undefined,
          // 'public' opts the fact into the followable feed — an explicit
          // per-fact choice, never a default (visibility guardrail)
          visibility: visibility === 'public' ? 'public' : 'private',
          });
        } catch (err) {
          // Dual-write drift guard: the entity row is the READ source of
          // truth — a legacy row without its entity twin is invisible to
          // every surface yet occupies the mirror. Clean it up and fail
          // loud so the caller retries.
          console.log(err, 'learn entity dual-write');
          await env.DB.prepare("DELETE FROM learnings WHERE user_id = ? AND id = ?")
            .bind(String(userId), Number(res.id)).run().catch(() => {});
          return json({ error: "failed to store memory" }, 500);
        }
        // Explicit fact edges (part_of/authored/relates_to/about)
        // — validated against FACT_RELS + owner-scoped dst existence.
        if (edgeInputs.length && entityId) {
          try { await insertEdges(env, { owner: String(userId), src: entityId, edges: edgeInputs }); }
          catch (err) { console.log(err, 'learn edges'); }
        }
        // Supersession: this fact replaces prior ones — close them (bitemporal)
        // + record supersedes edges. Legacy mirror rows of the closed facts
        // are deleted so both stores agree on what's live.
        if (supersedeIds.length) {
          closed = await supersede(env, { owner: String(userId), newId: entityId, closeIds: supersedeIds });
          const legacyIds = closed
            .map((c) => Number(String(c).replace(/^mig12:/, '')))
            .filter(Number.isFinite);
          if (legacyIds.length) {
            await env.DB.prepare(
              `DELETE FROM learnings WHERE user_id = ? AND id IN (${legacyIds.map(() => '?').join(',')})`
            ).bind(String(userId), ...legacyIds).run();
            // Vectors are KEPT: closed facts leave default recall via the
            // BY_VEC live-only join, but stay reachable with
            // include_closed=1 — bitemporal means history is queryable,
            // not just stored. Vectors die only on clear-all.
          }
        }
      }

      // Best-effort semantic index — a failed embed degrades recall, not storage
      let indexed = false;
      const vectors = await embed(env, trimmed);
      if (vectors && res?.id != null) {
        try {
          await env.MEMORY.upsert([{
            id: vecId(res.id),
            values: vectors,
            metadata: { userId: String(userId) },
          }]);
          indexed = true;
        } catch (err) {
          console.log(err, 'memory vector upsert');
        }
      }

      return json({
        ok: true,
        id: res?.id,
        entityId,
        total: total + 1 - closed.length,
        capacity: MAX_ENTRIES,
        indexed,
        ...(closed.length ? { closed } : {}),
      });
    } catch (err) {
      console.log(err, 'learnings add');
      return json({ error: "failed to store memory" }, 500);
    }
  }
}

export class GraphNeighborsCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: subgraph around a memory node (powers Graph Panel + inline chips).",
    parameters: {
      userId: Query(String, { required: true, description: "User id (owner)." }),
      node: Query(String, { required: true, description: "Entity id or legacy memory id." }),
      hops: Query(Number, { required: false, description: "1 (default) or 2." }),
      rels: Query(String, { required: false, description: "Comma-separated rel filter (e.g. 'supersedes,part_of')." }),
    },
    responses: { "200": { description: "Subgraph", schema: { response: "Subgraph" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const params = new URL(request.url).searchParams;
    const userId = params.get("userId") || "";
    const node = params.get("node") || "";
    if (!userId || !node) return json({ error: "userId and node required" }, 400);
    const hops = Math.min(Math.max(Number(params.get("hops")) || 1, 1), 2);
    const rels = (params.get("rels") || "").split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const sub = await neighbors(env, { owner: userId, nodeId: node, hops, ...(rels.length ? { rels } : {}) });
      return json({ ok: true, ...sub });
    } catch (err) {
      console.log(err, 'graph neighbors');
      // Fail honestly (500), NOT a masked-empty 200. app/api/graph/route.ts
      // relays worker status/body verbatim and its comment promises callers
      // that guarding on `d.error` routes an outage to their retry/.catch path
      // — but a 200 {ok:false} with no `error` field defeats that guard (see
      // GraphAllCall). Mirrors LearningsListCall / GraphResolveCall.
      return json({ error: "graph unavailable" }, 500);
    }
  }
}

export class GraphAllCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: the user's whole memory graph — every fact node + edge (the Graph Panel viz).",
    parameters: {
      userId: Query(String, { required: true, description: "User id (owner)." }),
      include_closed: Query(String, { required: false, description: "'1' → closed (history) nodes/edges included, marked by freshness." }),
      limit: Query(Number, { required: false, description: "Max nodes and max edges (default 500, cap 1000)." }),
    },
    responses: { "200": { description: "Whole graph", schema: { response: "Graph" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const params = new URL(request.url).searchParams;
    const userId = params.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    const includeClosed = params.get("include_closed") === "1";
    const limit = Math.min(Math.max(Number(params.get("limit")) || 500, 1), 1000);
    try {
      const [{ results: nodes }, { results: edges }] = await Promise.all([
        env.DB.prepare(ALL_NODES_SQL(includeClosed)).bind(userId, limit).all(),
        env.DB.prepare(ALL_EDGES_SQL(includeClosed)).bind(userId, limit).all(),
      ]);
      // Edges may reference nodes past the LIMIT window (or closed ones in
      // live-only mode) — drop dangling edges so the client never renders
      // a line into nothing.
      const known = new Set((nodes || []).map((n: any) => n.id));
      return json({
        ok: true,
        nodes: nodes || [],
        edges: (edges || []).filter((e: any) => known.has(e.src) && known.has(e.dst)),
      });
    } catch (err) {
      console.log(err, 'graph all');
      // Fail honestly (500), NOT a masked-empty 200. A D1 read error returned
      // as 200 {ok:false, nodes:[], edges:[]} is indistinguishable from a
      // genuinely empty graph across the proxy hop: app/api/graph/route.ts
      // relays worker status/body verbatim (only synthesizing a 503 on a fetch
      // *throw*), and MemoryPanel.loadGraph() guards on `d.error` (never `d.ok`)
      // — so a body with no `error` field takes the success path and paints
      // "No memories yet" over a live outage for a user with a rich graph, with
      // the .catch retry unreachable. Its sibling LearningsListCall (the LIST
      // view of the SAME panel) already returns 500 on the same D1 error; this
      // GRAPH view was the straggler. Now the client's `if (d.error) throw`
      // routes to its "Failed to load the graph" + retry path.
      return json({ error: "graph unavailable" }, 500);
    }
  }
}

export class GraphConflictsCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: contradiction candidates — same (src, rel, scope), different dst, both live.",
    parameters: {
      userId: Query(String, { required: true, description: "User id (owner)." }),
    },
    responses: { "200": { description: "Conflicts", schema: { response: "Conflicts" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    try {
      const { results } = await env.DB.prepare(CONFLICTS_SQL).bind(userId).all();
      const conflicts = groupConflicts(results || []);
      // Hydrate node labels so the Conflict Prompt can render human choices
      const ids = Array.from(new Set(conflicts.flatMap((c) => [c.src, ...c.candidates.map((x) => x.dst)])));
      const labels = new Map<string, any>();
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const { results: rows } = await env.DB.prepare(NODES_SQL(chunk.length))
          .bind(userId, ...chunk).all();
        for (const r of rows || []) labels.set(r.id, { label: r.label, source: r.source, freshness: r.freshness });
      }
      return json({
        ok: true,
        conflicts: conflicts.map((c) => ({
          ...c,
          srcNode: labels.get(c.src) || null,
          candidates: c.candidates.map((x) => ({ ...x, node: labels.get(x.dst) || null })),
        })),
      });
    } catch (err) {
      console.log(err, 'graph conflicts');
      // Fail honestly (500), NOT a masked-empty 200 — same contract as
      // GraphAllCall. The conflicts consumer is best-effort (.catch swallows),
      // so this is defensive parity, not a live user-facing fix.
      return json({ error: "conflicts unavailable" }, 500);
    }
  }
}

export class GraphResolveCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: resolve a conflict — keep one edge, close the rest (valid_to, never delete).",
    requestBody: {
      userId: new Str({ required: true, description: "User id (owner)." }),
      keep: new Str({ required: true, description: "Edge id to keep live." }),
      close: new Str({ required: true, description: "JSON array of edge ids to close." }),
    },
    responses: { "200": { description: "Resolved", schema: { response: "Resolved" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, keep, close } = data.body;
    if (!userId || !keep || !close) return json({ error: "userId, keep and close required" }, 400);
    let closeIds: string[] = [];
    try {
      const parsed = JSON.parse(String(close));
      if (Array.isArray(parsed)) closeIds = parsed.filter((x) => typeof x === 'string');
    } catch { return json({ error: "close must be a JSON array of edge ids" }, 400); }
    try {
      const closed = await resolveConflict(env, { owner: String(userId), keepEdgeId: String(keep), closeEdgeIds: closeIds });
      return json({ ok: true, kept: keep, closed });
    } catch (err) {
      console.log(err, 'graph resolve');
      return json({ error: "failed to resolve" }, 500);
    }
  }
}

export class SocialRecordCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: record a social edge (consulted/visited/messaged/follows) — platform flows only.",
    requestBody: {
      rel: new Str({ required: true, description: "visited|consulted|messaged|follows" }),
      srcId: new Str({ required: true, description: "Actor node id (user:<id> or tiny:<slug>)." }),
      srcKind: new Str({ required: true, description: "person|tiny" }),
      srcLabel: new Str({ required: true, description: "Display label." }),
      dstId: new Str({ required: true, description: "Target node id." }),
      dstKind: new Str({ required: true, description: "person|tiny" }),
      dstLabel: new Str({ required: true, description: "Display label." }),
      visibility: new Str({ required: false, description: "public (default) | private" }),
    },
    responses: { "200": { description: "Recorded", schema: { response: "Recorded" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const b = data.body;
    if (!SOCIAL_RELS.includes(b.rel)) return json({ error: `rel must be one of ${SOCIAL_RELS.join('|')}` }, 400);
    const kind = (k: string) => (k === 'tiny' ? 'tiny' : 'person') as 'person' | 'tiny';
    await recordSocialEdge(env, {
      rel: b.rel,
      srcId: String(b.srcId).slice(0, 120), srcKind: kind(b.srcKind), srcLabel: String(b.srcLabel),
      dstId: String(b.dstId).slice(0, 120), dstKind: kind(b.dstKind), dstLabel: String(b.dstLabel),
      visibility: b.visibility === 'private' ? 'private' : 'public',
    });
    return json({ ok: true });
  }
}

export class SocialGraphCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: public social subgraph around a node + trust scores (PageRank over consulted).",
    parameters: {
      node: Query(String, { required: false, description: "Node id (user:<id> or tiny:<slug>) — omit for trust ranking only." }),
      limit: Query(Number, { required: false, description: "Edges to return (default 50)." }),
    },
    responses: { "200": { description: "Social graph", schema: { response: "Social" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const params = new URL(request.url).searchParams;
    const node = (params.get("node") || "").slice(0, 120);
    const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 200);
    try {
      let edges: any[] = [];
      if (node) {
        const { results } = await env.DB.prepare(SOCIAL_NEIGHBORS_SQL).bind(node, limit).all();
        edges = results || [];
      }
      // Trust: PageRank over ALL public consulted edges (bounded), so
      // scores are global — a tiny consulted by well-consulted tinys ranks up
      const { results: consulted } = await env.DB.prepare(CONSULTED_EDGES_SQL).all();
      const trust = trustRank((consulted || []) as any[]);
      return json({
        ok: true,
        edges,
        trust: Object.fromEntries(
          Array.from(trust.entries()).sort((a, b) => b[1] - a[1]).slice(0, 50)
            .map(([n, s]) => [n, Number(s.toFixed(4))])
        ),
      });
    } catch (err) {
      console.log(err, 'social graph');
      // Fail honestly (500), NOT a masked-empty 200 — same contract as
      // GraphAllCall, so no future consumer inherits the d.error-guard trap.
      return json({ error: "social graph unavailable" }, 500);
    }
  }
}

export class FollowCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: follow/unfollow/check — the user-gesture social edge (stage 6).",
    requestBody: {
      followerId: new Str({ required: true, description: "Session user id (the actor — from the app session, never client-supplied)." }),
      targetLogin: new Str({ required: true, description: "GitHub login of the builder to follow." }),
      action: new Str({ required: true, description: "follow | unfollow | check" }),
    },
    responses: { "200": { description: "Follow state", schema: { response: "Follow" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { followerId, targetLogin, action } = data.body;
    const raw = String(targetLogin || '').trim().replace(/^@/, '');
    if (!followerId || !/^[a-zA-Z0-9-]{1,39}$/.test(raw)) {
      return json({ error: "followerId and a valid targetLogin required" }, 400);
    }
    try {
      const target = await env.DB.prepare("SELECT id, github_login, name FROM users WHERE LOWER(github_login) = LOWER(?)")
        .bind(raw).first();
      if (!target) return json({ ok: false, error: "builder not found" }, 404);
      if (target.id === String(followerId)) return json({ ok: false, error: "cannot follow yourself" }, 400);

      const src = userNodeId(String(followerId));
      const dst = userNodeId(String(target.id));

      if (action === 'check') {
        const row = await env.DB.prepare(
          `SELECT 1 FROM edge WHERE owner = ? AND src = ? AND rel = 'follows' AND dst = ? AND valid_to IS NULL`
        ).bind(SOCIAL_OWNER, src, dst).first();
        return json({ ok: true, following: !!row });
      }
      if (action === 'unfollow') {
        // Bitemporal like everything else: unfollow CLOSES the edge
        const res = await env.DB.prepare(
          `UPDATE edge SET valid_to = unixepoch() WHERE owner = ? AND src = ? AND rel = 'follows' AND dst = ? AND valid_to IS NULL`
        ).bind(SOCIAL_OWNER, src, dst).run();
        return json({ ok: true, following: false, closed: Number(res?.meta?.changes || 0) });
      }
      // follow (default): re-follow after unfollow opens a FRESH edge (the
      // reinforce path only bumps LIVE edges, so history stays honest)
      const follower = await env.DB.prepare("SELECT github_login FROM users WHERE id = ?")
        .bind(String(followerId)).first();
      await recordSocialEdge(env, {
        rel: 'follows',
        srcId: src, srcKind: 'person', srcLabel: `@${follower?.github_login || followerId}`,
        dstId: dst, dstKind: 'person', dstLabel: `@${target.github_login}`,
      });
      // The builder learns someone followed them (event ring — same rail
      // as visits/DMs; push deliberately skipped: follows are not urgent)
      try {
        await emitEvent(env, target.id, 'follow', `@${follower?.github_login || 'someone'} followed you`);
      } catch { /* event is best-effort */ }

      // 🏅 Reputation (reputation.ts): being followed earns points; following
      // earns none. Deliberately asymmetric — a score you can grant yourself is
      // a score you can mint, and one account could otherwise follow 500
      // builders to buy itself past the rate limits reputation will relax.
      //
      // The grant is keyed by the PAIR (`follow:<follower>:<target>`), not by
      // the edge, precisely because a re-follow opens a genuinely FRESH edge:
      // an edge-freshness check would pay out on every unfollow/re-follow
      // cycle. UNIQUE(user_id, kind, ref) makes that farm a no-op instead.
      let mutual = false;
      try {
        await grantReputation(env, {
          userId: String(target.id), kind: 'follow_received',
          ref: followRef(String(followerId), String(target.id)),
        });
        // Mutual follow = both sides vouched, so both sides score, once, on a
        // shared symmetric ref.
        const back = await env.DB.prepare(
          `SELECT 1 FROM edge WHERE owner = ? AND src = ? AND rel = 'follows' AND dst = ? AND valid_to IS NULL`
        ).bind(SOCIAL_OWNER, dst, src).first();
        mutual = !!back;
        if (mutual) {
          const ref = mutualRef(String(followerId), String(target.id));
          await grantReputation(env, { userId: String(followerId), kind: 'mutual_follow', ref });
          await grantReputation(env, { userId: String(target.id), kind: 'mutual_follow', ref });
        }
      } catch (err) { console.log(err, 'follow reputation'); }

      return json({ ok: true, following: true, mutual });
    } catch (err) {
      console.log(err, 'follow');
      return json({ error: "follow failed" }, 500);
    }
  }
}

export class FeedCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: the follower feed — fresh PUBLIC facts + artifacts (tinys, tools) from principals the user follows.",
    parameters: {
      userId: Query(String, { required: true, description: "Session user id (the follower)." }),
      limit: Query(Number, { required: false, description: "Items per section (default 30, max 100)." }),
    },
    responses: { "200": { description: "Feed", schema: { response: "Feed" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const params = new URL(request.url).searchParams;
    const userId = params.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    const limit = Math.min(Math.max(Number(params.get("limit")) || 30, 1), 100);
    const me = userNodeId(String(userId));
    try {
      // Facts: opt-in public memories of followed principals (live only)
      const { results } = await env.DB.prepare(FACT_FEED_SQL).bind(me, limit).all();
      const items = results || [];
      const authorIds = Array.from(new Set(items.map((r: any) => r.author_id)));
      const logins = new Map<string, string>();
      for (let i = 0; i < authorIds.length; i += 50) {
        const chunk = authorIds.slice(i, i + 50);
        const { results: rows } = await env.DB.prepare(
          `SELECT id, github_login FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`
        ).bind(...chunk).all();
        for (const r of rows || []) logins.set(r.id, r.github_login);
      }

      // Artifacts: followed builders' public tinys + forged tools (the
      // already-public tables — no visibility opt-in needed)
      let artifacts: any[] = [];
      const { results: follows } = await env.DB.prepare(FOLLOWING_SQL).bind(me).all();
      const followedUserIds = (follows || [])
        .map((r: any) => String(r.dst))
        .filter((d: string) => d.startsWith('user:'))
        .map((d: string) => d.slice(5));
      if (followedUserIds.length) {
        const { results: rows } = await env.DB.prepare(FEED_SQL(followedUserIds.length))
          .bind(...followedUserIds, ...followedUserIds, limit).all();
        artifacts = rows || [];
      }

      return json({
        ok: true,
        feed: items.map((r: any) => ({
          id: r.id, content: r.content, valid_from: r.valid_from,
          author: logins.get(r.author_id) || r.author_id, via: r.via,
        })),
        artifacts,
      });
    } catch (err) {
      console.log(err, 'feed');
      // Fail honestly (500), NOT a masked-empty 200 — same contract as
      // GraphAllCall, so no future consumer inherits the d.error-guard trap.
      return json({ error: "feed unavailable" }, 500);
    }
  }
}

export class LearningsDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["Learnings"],
    summary: "Internal: close one memory (by id — bitemporal, vector kept) or clear all for a user (vectors purged).",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      id: new Str({ required: false, description: "Memory id (absent → clear all)." }),
    },
    responses: { "200": { description: "Deleted", schema: { response: "Deleted" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, id } = data.body;
    if (!userId) return json({ error: "userId required" }, 400);
    try {
      // Bitemporal (idea.md hard constraint #3): unlearn CLOSES entities
      // (valid_to = now) — the fact drops out of listings/recall exactly as
      // the old DELETE did, but the row survives for provenance/history.
      // The legacy learnings row IS still deleted (it's the transition
      // mirror, not the graph). Single-id vectors are KEPT (the live-only
      // BY_VEC join excludes them from default recall; include_closed=1
      // reaches them) — only clear-all purges vectors, since "wipe my
      // memory" means gone from every surface.
      const now = Math.floor(Date.now() / 1000);
      let vectorIds: string[] = [];
      let closed = 0;
      if (id !== undefined && id !== '') {
        const res = await env.DB.prepare(CLOSE_SQL)
          .bind(now, String(userId), resolveEntityId(id)).run();
        closed = Number(res?.meta?.changes || 0);
        // Legacy mirror + report the truth: a bogus/foreign id closes nothing.
        // Only numeric ids exist in the legacy table — an entity id like
        // 'mig12:42' would bind NaN and make D1 throw AFTER the close
        // succeeded (caller told "failed" for a memory that DID close).
        // Same Number.isFinite guard as the supersede path.
        const legacyId = Number(String(id).replace(/^mig12:/, ''));
        const legacy = Number.isFinite(legacyId)
          ? await env.DB.prepare("DELETE FROM learnings WHERE user_id = ? AND id = ?")
              .bind(String(userId), legacyId).run()
          : null;
        if (!closed && !legacy?.meta?.changes) {
          // Distinguish "already closed" (the entity exists but its
          // valid_to is set — CLOSE_SQL matched 0 rows) from "never existed"
          // (tiny's E2E finding: unlearn after supersede said 'no memory',
          // implying loss, when the fact is safely in history). idempotent.
          const owned = await env.DB.prepare(
            "SELECT valid_to FROM entity WHERE owner = ? AND id = ?"
          ).bind(String(userId), resolveEntityId(id)).first();
          if (owned) {
            return json({ ok: true, alreadyClosed: true, deleted: 0, note: `memory ${id} was already closed (kept as history)` });
          }
          return json({ ok: false, error: `no memory with id ${id}` }, 404);
        }
      } else {
        // Collect vec_ids from the ENTITY table (not learnings): closed
        // facts keep their vectors and have no legacy row anymore, so the
        // legacy table would miss them and leak orphaned vectors.
        const { results } = await env.DB.prepare(
          "SELECT vec_id FROM entity WHERE owner = ? AND kind = 'fact' AND vec_id IS NOT NULL"
        ).bind(String(userId)).all();
        vectorIds = (results || []).map((r: any) => String(r.vec_id));
        // A WIPE DELETES. Closing the rows only set
        // valid_to, and `label` + `attrs_json.$.source` still hold the
        // memory VERBATIM — which RECENT_ALL_SQL / ALL_NODES_SQL(true) /
        // BY_VEC_SQL(n, true) all render back the moment anyone passes
        // include_closed=1 (the "History" toggle in MemoryPanel, iOS
        // MemoryGraph, and tiny-tech's include_history). "Gone from every
        // surface" and "marked grey on every surface" are not the same
        // promise, and the unlearn tool makes the first one:
        // "Erase EVERY memory and the semantic index — not recoverable".
        //
        // Edges FIRST: edge.src/dst REFERENCE entity(id), and D1 enforces
        // foreign keys. Their `scope` column is caller-supplied text that
        // ALL_EDGES_SQL returns, so it is content too.
        const purged = await env.DB.batch([
          env.DB.prepare(PURGE_ALL_FACT_EDGES_SQL).bind(String(userId)),
          env.DB.prepare(PURGE_ALL_FACTS_SQL).bind(String(userId)),
          env.DB.prepare("DELETE FROM learnings WHERE user_id = ?").bind(String(userId)),
        ]);
        // The FACT count is what the caller is told about (index 1) — not the
        // edge count, which would inflate `deleted` past the number of
        // memories the user had.
        closed = Number(purged?.[1]?.meta?.changes || 0);
      }
      // Embeddings persist until explicitly deleted (AGENTS.md gotcha #9)
      for (let i = 0; i < vectorIds.length; i += 1000) {
        try {
          await env.MEMORY.deleteByIds(vectorIds.slice(i, i + 1000));
        } catch (err) {
          console.log(err, 'memory vector delete');
        }
      }
      return json({ ok: true, deleted: Math.max(vectorIds.length, closed) });
    } catch (err) {
      console.log(err, 'learnings delete');
      return json({ error: "failed to delete" }, 500);
    }
  }
}

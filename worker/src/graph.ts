/**
 * Bitemporal memory graph — core helpers + SQL.
 *
 * The entity table is the memory source of truth; the legacy `learnings`
 * table is dual-written during transition (same deterministic id scheme as
 * migration 0012, so backfill + dual-writes never collide). RETIRING a fact
 * never hard-deletes it: unlearn/supersede CLOSE a row (valid_to = now).
 * "Currently true" = valid_to IS NULL. A WIPE (clear-all) is the one
 * exception and DELETEs — see PURGE_ALL_FACTS_SQL for why closing cannot
 * serve it.
 *
 * SQL is exported (messages/scheduler pattern) so tests run the real
 * statements against sqlite.
 */

/** Migrated/dual-written entities share ids with legacy rows. */
export const migEntityId = (legacyId: number | string) => `mig12:${legacyId}`;
export const legacyVecId = (legacyId: number | string) => `learning:${legacyId}`;

/** Live memories, newest window — the GET /learnings "recent" list.
 *  Wire-compatible with the old learnings query: id (legacy numeric when
 *  present), content (attrs.source), created. */
export const RECENT_SQL = `
  SELECT COALESCE(json_extract(attrs_json, '$.legacy_id'), id) AS id,
         json_extract(attrs_json, '$.source') AS content,
         created
  FROM entity
  WHERE owner = ?1 AND valid_to IS NULL AND kind = 'fact'
  ORDER BY created DESC, CAST(json_extract(attrs_json, '$.legacy_id') AS INTEGER) DESC LIMIT ?2`;

/** Recent WITH closed facts (include_closed=1): adds freshness fields —
 *  green = live, grey = closed (badge data). Extra columns only;
 *  the base shape stays wire-compatible. */
export const RECENT_ALL_SQL = `
  SELECT COALESCE(json_extract(attrs_json, '$.legacy_id'), id) AS id,
         json_extract(attrs_json, '$.source') AS content,
         created, valid_from, valid_to,
         CASE WHEN valid_to IS NULL THEN 'live' ELSE 'closed' END AS freshness
  FROM entity
  WHERE owner = ?1 AND kind = 'fact'
  ORDER BY created DESC, CAST(json_extract(attrs_json, '$.legacy_id') AS INTEGER) DESC LIMIT ?2`;

/** Totals over LIVE facts (capacity check counts what's currently true). */
export const TOTALS_SQL = `
  SELECT COUNT(*) AS c,
         COALESCE(SUM(LENGTH(json_extract(attrs_json, '$.source'))), 0) AS b
  FROM entity WHERE owner = ?1 AND valid_to IS NULL AND kind = 'fact'`;

/** Hydrate semantic matches by vec_id; excludes closed facts unless asked
 *  (closed vectors stay in Vectorize — bitemporal keeps them queryable).
 *  All-anonymous params (owner first, then the vec ids): mixing ?1 with
 *  bare ? breaks node:sqlite binding, and D1 .bind() is positional anyway. */
export const BY_VEC_SQL = (n: number, includeClosed: boolean) => `
  SELECT COALESCE(json_extract(attrs_json, '$.legacy_id'), id) AS id,
         json_extract(attrs_json, '$.source') AS content,
         created, vec_id, valid_to
  FROM entity
  WHERE owner = ? AND vec_id IN (${Array(n).fill('?').join(',')})
  ${includeClosed ? '' : 'AND valid_to IS NULL'}`;

/** Close (never delete) — unlearn and supersede both land here. */
export const CLOSE_SQL = `
  UPDATE entity SET valid_to = ?1
  WHERE owner = ?2 AND id = ?3 AND valid_to IS NULL`;

/**
 * Clear-all — the ONE memory operation that is NOT bitemporal.
 *
 * "Facts are NEVER hard-deleted" is the rule for RETIREMENT (unlearn one,
 * supersede): the fact stops being true, and the row survives as history so
 * provenance and freshness still work. A wipe is a different request. The
 * tool the user reaches says "Erase EVERY memory and the semantic index —
 * not recoverable", and clear-all already purges the Vectorize side.
 *
 * Closing every row cannot serve it: setting valid_to leaves `label` and
 * `attrs_json.$.source` — the verbatim memory text — in the row, and three
 * opt-in read paths render exactly those columns back (RECENT_ALL_SQL,
 * ALL_NODES_SQL(true), BY_VEC_SQL(n, true), all reachable with
 * include_closed=1 / the clients' "History" toggle). "Closed" is a badge,
 * not erasure.
 *
 * So a wipe DELETEs, scoped by OWNER and nothing else:
 *   - entities: every row the user owns, NOT just kind='fact'. Today
 *     insertFactEntity is the only writer under a user owner, so the two are
 *     the same set — but the schema documents 'person'|'tiny'|'project'|
 *     'concept' as kinds, and a `label` on a person node the user's agent
 *     extracted is their memory as much as a fact is. A kind filter here
 *     would be a wipe that silently narrows the day someone adds the second
 *     kind. Social nodes are unreachable either way: they live under
 *     SOCIAL_OWNER, a different owner entirely.
 *   - edges: the user's OWN edge rows, because `edge.scope` is
 *     caller-supplied text ("Python for scope A") and ALL_EDGES_SQL returns
 *     it. Deleting the nodes and keeping the edges would leave the user's
 *     words in a column nobody thinks of as content. Social edges are NOT
 *     touched: they are owned by SOCIAL_OWNER, and a follow is a
 *     relationship the user can see and revoke, not a memory.
 */
export const PURGE_ALL_FACTS_SQL = `
  DELETE FROM entity WHERE owner = ?1`;

export const PURGE_ALL_FACT_EDGES_SQL = `
  DELETE FROM edge WHERE owner = ?1`;

export interface EntityRow {
  id: string;
  owner: string;
  kind: string;
  label: string;
  attrs_json: string;
  vec_id: string | null;
  visibility: string;
  valid_from: number;
  valid_to: number | null;
  created: number;
}

/** Insert one fact entity (dual-write partner of a learnings row).
 *  visibility='public' opts a fact into the followable feed (stage 6);
 *  anything else stays 'private' — the column default, never inferred. */
export async function insertFactEntity(
  env: any,
  opts: { owner: string; content: string; legacyId: number; created?: number; visibility?: string }
): Promise<string> {
  const id = migEntityId(opts.legacyId);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO entity (id, owner, kind, label, attrs_json, vec_id, visibility, valid_from, created)
     VALUES (?, ?, 'fact', ?, ?, ?, ?, COALESCE(?, unixepoch()), COALESCE(?, unixepoch()))`
  ).bind(
    id,
    opts.owner,
    opts.content.slice(0, 80),
    JSON.stringify({ source: opts.content, legacy_id: opts.legacyId }),
    legacyVecId(opts.legacyId),
    opts.visibility === 'public' ? 'public' : 'private',
    opts.created ?? null,
    opts.created ?? null,
  ).run();
  return id;
}

/** Resolve a caller-supplied memory id (legacy numeric OR entity text id)
 *  to the entity id. Numeric ids map through the deterministic scheme. */
export function resolveEntityId(id: string | number): string {
  const s = String(id);
  return /^\d+$/.test(s) ? migEntityId(s) : s;
}

// ── Supersession + freshness ───────────────────────────────────────────────

/**
 * Close a set of entities because a new fact supersedes them, and record
 * the supersedes edges (new fact → each closed one). Batched: the close and
 * the edge insert land atomically per D1 batch semantics — a supersede that
 * closes the old fact but loses the edge would orphan the history trail.
 * Returns the ids actually closed (a foreign/already-closed id is skipped —
 * report the truth, same rule as unlearn's 404).
 */
export async function supersede(
  env: any,
  opts: { owner: string; newId: string; closeIds: (string | number)[]; now?: number }
): Promise<string[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // Verify first: only LIVE, owner-matched targets qualify (a foreign or
  // already-closed id is skipped — report the truth). Self-supersede is
  // meaningless.
  const candidates = Array.from(new Set(
    opts.closeIds.slice(0, 20).map(resolveEntityId).filter((t) => t !== opts.newId)
  ));
  if (!candidates.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id FROM entity WHERE owner = ? AND valid_to IS NULL AND id IN (${candidates.map(() => '?').join(',')})`
  ).bind(opts.owner, ...candidates).all();
  const targets: string[] = (results || []).map((r: any) => r.id);
  if (!targets.length) return [];

  // One batch = atomic in D1: all closes + all supersedes edges, or none.
  await env.DB.batch(targets.flatMap((target) => [
    env.DB.prepare(CLOSE_SQL).bind(now, opts.owner, target),
    env.DB.prepare(
      `INSERT INTO edge (id, owner, src, rel, dst, valid_from, created)
       VALUES (?, ?, ?, 'supersedes', ?, ?, ?)`
    ).bind(crypto.randomUUID(), opts.owner, opts.newId, target, now, now),
  ]));
  return targets;
}

/** Freshness for a set of memory ids (Inline Memory Chip / badge data):
 *  green = live (valid_to IS NULL), grey = closed. Anonymous params:
 *  owner first, then entity ids. */
export const FRESHNESS_SQL = (n: number) => `
  SELECT id, label, valid_from, valid_to,
         json_extract(attrs_json, '$.source') AS source,
         CASE WHEN valid_to IS NULL THEN 'live' ELSE 'closed' END AS freshness
  FROM entity
  WHERE owner = ? AND id IN (${Array(n).fill('?').join(',')})`;

// ── Edges + traversal ──────────────────────────────────────────────────────

/** Relations the tool surface accepts today. Social rels (follows/consulted/
 *  visited) arrive later with visibility rules — reject early so a
 *  prompt-injected learn can't fabricate social edges ahead of the guardrail. */
export const FACT_RELS = ['supersedes', 'part_of', 'authored', 'relates_to', 'about'] as const;

export interface EdgeInput {
  rel: string;
  dst: string | number; // entity id or legacy numeric
  scope?: string;
  weight?: number;
  confidence?: number;
}

const clamp01 = (v: unknown, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : dflt;
};

/** Insert fact edges from a new learn(). Validates rel against FACT_RELS,
 *  resolves legacy dst ids, verifies dst entities exist AND belong to the
 *  owner (cross-tenant dst would let a crafted call link into someone
 *  else's graph). Returns the edges actually created. */
export async function insertEdges(
  env: any,
  opts: { owner: string; src: string; edges: EdgeInput[]; now?: number }
): Promise<{ rel: string; dst: string }[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const candidates = opts.edges
    .slice(0, 10)
    .filter((e) => e && FACT_RELS.includes(e.rel as any))
    .map((e) => ({ ...e, dst: resolveEntityId(e.dst) }))
    .filter((e) => e.dst !== opts.src);
  if (!candidates.length) return [];

  const dstIds = Array.from(new Set(candidates.map((e) => e.dst)));
  const { results } = await env.DB.prepare(
    `SELECT id FROM entity WHERE owner = ? AND id IN (${dstIds.map(() => '?').join(',')})`
  ).bind(opts.owner, ...dstIds).all();
  const known = new Set((results || []).map((r: any) => r.id));

  const valid = candidates.filter((e) => known.has(e.dst));
  if (!valid.length) return [];
  await env.DB.batch(valid.map((e) =>
    env.DB.prepare(
      `INSERT INTO edge (id, owner, src, rel, dst, scope, weight, confidence, valid_from, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), opts.owner, opts.src, e.rel, e.dst,
      e.scope ? String(e.scope).slice(0, 64) : null,
      clamp01(e.weight, 1), clamp01(e.confidence, 1), now, now,
    )
  ));
  return valid.map((e) => ({ rel: e.rel, dst: e.dst }));
}

/** Live edges touching a node (either direction), owner-scoped. */
export const NEIGHBOR_EDGES_SQL = `
  SELECT id, src, rel, dst, scope, weight, confidence, valid_from
  FROM edge
  WHERE owner = ?1 AND valid_to IS NULL AND (src = ?2 OR dst = ?2)
  ORDER BY created DESC LIMIT ?3`;

/** Hydrate a set of entities (nodes for a subgraph response). */
export const NODES_SQL = (n: number) => `
  SELECT id, kind, label, valid_from, valid_to,
         json_extract(attrs_json, '$.source') AS source,
         CASE WHEN valid_to IS NULL THEN 'live' ELSE 'closed' END AS freshness
  FROM entity
  WHERE owner = ? AND id IN (${Array(n).fill('?').join(',')})`;

/** The user's WHOLE graph (Graph Panel viz): every fact node + every edge
 *  between them, owner-scoped, one query each. include_closed keeps the
 *  grey history nodes in the picture (the visible signature of bitemporal
 *  validity); default shows only what's currently true. Bounded — the
 *  5000-entry capacity keeps this small, but LIMIT anyway. */
export const ALL_NODES_SQL = (includeClosed: boolean) => `
  SELECT id, kind, label, valid_from, valid_to,
         COALESCE(json_extract(attrs_json, '$.legacy_id'), id) AS wire_id,
         json_extract(attrs_json, '$.source') AS source,
         CASE WHEN valid_to IS NULL THEN 'live' ELSE 'closed' END AS freshness
  FROM entity
  WHERE owner = ?1 AND kind = 'fact'
  ${includeClosed ? '' : 'AND valid_to IS NULL'}
  ORDER BY created DESC LIMIT ?2`;

export const ALL_EDGES_SQL = (includeClosed: boolean) => `
  SELECT id, src, rel, dst, scope, weight, confidence, valid_from, valid_to
  FROM edge
  WHERE owner = ?1
  ${includeClosed ? '' : 'AND valid_to IS NULL'}
  ORDER BY created DESC LIMIT ?2`;

/**
 * Subgraph around a node: BFS over live edges up to `hops` (1-2), optional
 * rel filter. Per-hop D1 round-trips (bounded: hops ≤ 2, breadth capped)
 * — a recursive CTE would be one query but D1's CTE+param support is
 * shakier than two small indexed lookups.
 */
export async function neighbors(
  env: any,
  opts: { owner: string; nodeId: string | number; hops?: number; rels?: string[] }
): Promise<{ nodes: any[]; edges: any[] }> {
  const hops = Math.min(Math.max(opts.hops ?? 1, 1), 2);
  const start = resolveEntityId(opts.nodeId);
  const relFilter = (opts.rels || []).filter((r) => typeof r === 'string');

  const seen = new Set<string>([start]);
  const edges: any[] = [];
  const edgeIds = new Set<string>();
  let frontier = [start];

  for (let hop = 0; hop < hops && frontier.length; hop++) {
    const next: string[] = [];
    for (const node of frontier.slice(0, 25)) {
      const { results } = await env.DB.prepare(NEIGHBOR_EDGES_SQL)
        .bind(opts.owner, node, 50).all();
      for (const e of results || []) {
        if (relFilter.length && !relFilter.includes(e.rel)) continue;
        if (!edgeIds.has(e.id)) { edgeIds.add(e.id); edges.push(e); }
        for (const other of [e.src, e.dst]) {
          if (!seen.has(other)) { seen.add(other); next.push(other); }
        }
      }
    }
    frontier = next;
  }

  const ids = Array.from(seen);
  const nodes: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await env.DB.prepare(NODES_SQL(chunk.length))
      .bind(opts.owner, ...chunk).all();
    nodes.push(...(results || []));
  }
  return { nodes, edges };
}

// ── Conflict detection + resolution ────────────────────────────────────────

// Two conflict SHAPES, both scope-aware (idea.md hard constraint #1), BOTH
// gated on NON-NULL scope + about/relates_to only. scope is the "compete on
// the same axis" declaration; without it every multi-link is a false
// positive:
//  A. SUBJECT-anchored (spec shape): same src+rel+scope, DIFFERENT dst —
//     one subject, competing objects. Originally null-scope-tolerant
//     (`scope IS scope`) over every rel, which flagged the fan-out
//     learn(edges:[{rel:'relates_to',dst:A},{dst:B}]) NATURALLY produces —
//     tiny-tech's 2026-07-23 E2E audit found a live graph where 5/5
//     reported "conflicts" were benign fan-outs. Same guard as B now:
//     unscoped/authored/part_of multi-links are context, not contradiction.
//  B. TARGET-anchored (added after tiny's E2E finding): DIFFERENT src, same
//     rel+dst — competing facts ABOUT one target. This is the shape
//     learn(edges:[{rel:'about',dst:X}]) NATURALLY produces (each learn is
//     a fresh src pointing at the shared topic), so the killer feature never
//     fired for it. part_of multi-membership is not a contradiction.
// Candidate ENTITIES must be live too (the JOINs below): an edge pointing
// at a closed (unlearned) fact is history — a conflict prompt should never
// ask the user to pick against it.
export const CONFLICTS_SQL = `
  SELECT 'subject' AS shape, a.src AS anchor, a.rel, a.scope,
         a.id AS edge_a, a.src AS src_a, a.dst AS dst_a, a.valid_from AS from_a,
         b.id AS edge_b, b.src AS src_b, b.dst AS dst_b, b.valid_from AS from_b
  FROM edge a JOIN edge b
    ON a.owner = b.owner AND a.src = b.src AND a.rel = b.rel
   AND a.scope = b.scope
   AND a.id < b.id AND a.dst != b.dst
  JOIN entity da ON da.id = a.dst AND da.valid_to IS NULL
  JOIN entity db ON db.id = b.dst AND db.valid_to IS NULL
  WHERE a.owner = ?1 AND a.valid_to IS NULL AND b.valid_to IS NULL
    AND a.scope IS NOT NULL
    AND a.rel IN ('about', 'relates_to')
  UNION ALL
  SELECT 'target' AS shape, a.dst AS anchor, a.rel, a.scope,
         a.id AS edge_a, a.src AS src_a, a.dst AS dst_a, a.valid_from AS from_a,
         b.id AS edge_b, b.src AS src_b, b.dst AS dst_b, b.valid_from AS from_b
  FROM edge a JOIN edge b
    ON a.owner = b.owner AND a.dst = b.dst AND a.rel = b.rel
   AND a.scope = b.scope
   AND a.id < b.id AND a.src != b.src
  JOIN entity sa ON sa.id = a.src AND sa.valid_to IS NULL
  JOIN entity sb ON sb.id = b.src AND sb.valid_to IS NULL
  WHERE a.owner = ?1 AND a.valid_to IS NULL AND b.valid_to IS NULL
    AND a.scope IS NOT NULL
    AND a.rel IN ('about', 'relates_to')
  ORDER BY 1, 2, 3 LIMIT 100`;

export interface Conflict {
  shape: 'subject' | 'target';
  src: string;
  rel: string;
  scope: string | null;
  candidates: { edgeId: string; dst: string; validFrom: number }[];
}

/** Group pairwise rows into sets keyed by (shape, anchor, rel, scope). Each
 *  candidate's `dst` is the DIFFERING side the user chooses between: the
 *  object (subject-shape) or the competing fact node (target-shape). */
export function groupConflicts(rows: any[]): Conflict[] {
  const byKey = new Map<string, Conflict>();
  for (const r of rows || []) {
    const shape = (r.shape === 'target' ? 'target' : 'subject') as 'subject' | 'target';
    const key = `${shape} ${r.anchor} ${r.rel} ${r.scope ?? ''}`;
    let c = byKey.get(key);
    if (!c) {
      c = { shape, src: r.anchor, rel: r.rel, scope: r.scope ?? null, candidates: [] };
      byKey.set(key, c);
    }
    const sides = shape === 'target'
      ? [{ edgeId: r.edge_a, dst: r.src_a, validFrom: r.from_a },
         { edgeId: r.edge_b, dst: r.src_b, validFrom: r.from_b }]
      : [{ edgeId: r.edge_a, dst: r.dst_a, validFrom: r.from_a },
         { edgeId: r.edge_b, dst: r.dst_b, validFrom: r.from_b }];
    for (const side of sides) {
      if (!c.candidates.some((x) => x.edgeId === side.edgeId)) c.candidates.push(side);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Resolve a conflict: keep one edge, close the others (valid_to — never
 * delete; the losing claims become history). Owner-scoped; only live
 * edges close. Returns the edge ids actually closed.
 */
export async function resolveConflict(
  env: any,
  opts: { owner: string; keepEdgeId: string; closeEdgeIds: string[]; now?: number }
): Promise<string[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const targets = Array.from(new Set(opts.closeEdgeIds))
    .filter((id) => id && id !== opts.keepEdgeId)
    .slice(0, 20);
  if (!targets.length) return [];
  const results = await env.DB.batch(targets.map((id) =>
    env.DB.prepare("UPDATE edge SET valid_to = ?1 WHERE owner = ?2 AND id = ?3 AND valid_to IS NULL")
      .bind(now, opts.owner, id)
  ));
  return targets.filter((_, i) => results[i]?.meta?.changes);
}

/** Recency decay for recall ranking: 1.0 now → ~0.5 at 90 days. */
export function recencyDecay(validFrom: number, now: number = Math.floor(Date.now() / 1000)): number {
  const ageDays = Math.max(0, (now - validFrom) / 86400);
  return Math.pow(0.5, ageDays / 90);
}

/**
 * Graph-expanded recall ranking: seed matches come from Vectorize
 * (cosine), then 1 hop of live edges pulls in connected facts, each scored
 * cosine(seed) × weight × confidence × recency. Pure — the worker feeds it
 * seeds + edges + nodes; tests feed it fixtures.
 */
export function rankExpanded(
  seeds: { id: string; score: number }[],
  edges: { src: string; dst: string; weight: number; confidence: number }[],
  nodes: Map<string, { valid_from: number }>,
  now?: number,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const s of seeds) {
    const n = nodes.get(s.id);
    if (!n) continue;
    const own = s.score * recencyDecay(n.valid_from, now);
    scores.set(s.id, Math.max(scores.get(s.id) ?? 0, own));
    for (const e of edges) {
      const other = e.src === s.id ? e.dst : e.dst === s.id ? e.src : null;
      if (!other) continue;
      const on = nodes.get(other);
      if (!on) continue;
      const derived = s.score * e.weight * e.confidence * recencyDecay(on.valid_from, now);
      scores.set(other, Math.max(scores.get(other) ?? 0, derived));
    }
  }
  return scores;
}

// ── Social edges (the graph that was always there) ─────────────────────────

/** Social rels — recorded ONLY by platform flows (visit beacon, ask_tiny,
 *  DM send), never by learn(): a prompt-injected learn must not fabricate
 *  social signal (insertEdges rejects these rels for exactly that reason). */
export const SOCIAL_RELS = ['visited', 'consulted', 'messaged', 'follows'] as const;

/** Social nodes live under a platform pseudo-owner: the social graph is
 *  SHARED (one node per principal), unlike per-owner fact graphs. */
export const SOCIAL_OWNER = '_social';
export const userNodeId = (userId: string) => `user:${userId}`;
export const tinyNodeId = (slug: string) => `tiny:${slug.toLowerCase()}`;

/**
 * Record a social interaction: actor → target. Nodes upsert idempotently
 * (INSERT OR IGNORE on deterministic ids); the edge is REINFORCED rather
 * than duplicated — one live edge per (src, rel, dst), weight incremented
 * per repeat, so trust/discovery reads interaction strength instead of row
 * spam. Never throws: social recording must not break the calling flow.
 */
export async function recordSocialEdge(
  env: any,
  opts: {
    rel: (typeof SOCIAL_RELS)[number];
    srcId: string; srcKind: 'person' | 'tiny'; srcLabel: string;
    dstId: string; dstKind: 'person' | 'tiny'; dstLabel: string;
    visibility?: 'public' | 'private';
    now?: number;
  }
): Promise<void> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const visibility = opts.visibility ?? 'public';
  try {
    const upserts = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO entity (id, owner, kind, label, attrs_json, visibility, valid_from, created)
         VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`
      ).bind(opts.srcId, SOCIAL_OWNER, opts.srcKind, opts.srcLabel.slice(0, 80), visibility, now, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO entity (id, owner, kind, label, attrs_json, visibility, valid_from, created)
         VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`
      ).bind(opts.dstId, SOCIAL_OWNER, opts.dstKind, opts.dstLabel.slice(0, 80), visibility, now, now),
    ];
    if (visibility === 'public') {
      // A node first seen via a PRIVATE edge (e.g. a DM) must not stay
      // invisible once it acts publicly — public activity upgrades the
      // node. Private activity never downgrades one.
      upserts.push(
        env.DB.prepare(`UPDATE entity SET visibility = 'public' WHERE owner = ? AND id IN (?, ?)`)
          .bind(SOCIAL_OWNER, opts.srcId, opts.dstId),
      );
    }
    await env.DB.batch(upserts);
    const bumped = await env.DB.prepare(
      `UPDATE edge SET weight = weight + 1
       WHERE owner = ? AND src = ? AND rel = ? AND dst = ? AND valid_to IS NULL`
    ).bind(SOCIAL_OWNER, opts.srcId, opts.rel, opts.dstId).run();
    if (!bumped?.meta?.changes) {
      await env.DB.prepare(
        `INSERT INTO edge (id, owner, src, rel, dst, weight, confidence, visibility, valid_from, created)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`
      ).bind(crypto.randomUUID(), SOCIAL_OWNER, opts.srcId, opts.rel, opts.dstId, visibility, now, now).run();
    }
  } catch (err) {
    console.log(err, 'social edge record');
  }
}

/** Public social edges around a node — the trust/discovery read path.
 *  visibility='public' ONLY at BOTH edge and node level: the guardrail is
 *  "observable, but scoped" (idea.md stage 6). */
export const SOCIAL_NEIGHBORS_SQL = `
  SELECT e.src, e.rel, e.dst, e.weight, e.valid_from,
         s.label AS src_label, s.kind AS src_kind,
         d.label AS dst_label, d.kind AS dst_kind
  FROM edge e
  JOIN entity s ON s.id = e.src AND s.visibility = 'public'
  JOIN entity d ON d.id = e.dst AND d.visibility = 'public'
  WHERE e.owner = '${SOCIAL_OWNER}' AND e.visibility = 'public' AND e.valid_to IS NULL
    AND (e.src = ?1 OR e.dst = ?1)
  ORDER BY e.weight DESC LIMIT ?2`;

/**
 * The FACT feed (stage 6): fresh PUBLIC facts from principals the user
 * follows — the "a tiny's fresh valid_to IS NULL facts surface to
 * followers" half of the feed (FEED_SQL below covers public artifacts).
 * A follow targets a social node (tiny:<slug> or user:<id>); facts live in
 * per-owner graphs keyed by userId — the JOIN resolves tiny:<slug> through
 * the tinys table and user:<id> by prefix-strip. Only visibility='public' +
 * live (valid_to IS NULL) facts surface: "observable, but scoped".
 */
export const FACT_FEED_SQL = `
  SELECT f.id, f.label, json_extract(f.attrs_json, '$.source') AS content,
         f.valid_from, f.owner AS author_id, e.dst AS via
  FROM edge e
  JOIN entity f ON f.owner = CASE
      WHEN e.dst LIKE 'user:%' THEN substr(e.dst, 6)
      ELSE (SELECT user_id FROM tinys WHERE name = substr(e.dst, 6))
    END
  WHERE e.owner = '${SOCIAL_OWNER}' AND e.src = ?1 AND e.rel = 'follows'
    AND e.valid_to IS NULL
    AND f.kind = 'fact' AND f.visibility = 'public' AND f.valid_to IS NULL
  ORDER BY f.valid_from DESC LIMIT ?2`;

/** All public consulted edges — trustRank's input (bounded). */
export const CONSULTED_EDGES_SQL = `
  SELECT src, dst, weight FROM edge
  WHERE owner = '${SOCIAL_OWNER}' AND rel = 'consulted'
    AND visibility = 'public' AND valid_to IS NULL
  ORDER BY weight DESC LIMIT 2000`;

/** Who a user follows: live public follows edges from their node. */
export const FOLLOWING_SQL = `
  SELECT dst FROM edge
  WHERE owner = '${SOCIAL_OWNER}' AND rel = 'follows' AND src = ?1
    AND visibility = 'public' AND valid_to IS NULL
  LIMIT 200`;

/**
 * Artifact feed: followed builders' recent PUBLIC tinys + forged tools —
 * the already-public tables, no visibility opt-in needed (complements
 * FACT_FEED_SQL, the opt-in public-memories half). Params: N user ids
 * twice (UNION branches), then limit.
 */
export const FEED_SQL = (n: number) => `
  SELECT * FROM (
    SELECT 'tiny' AS type, t.name AS title, u.github_login AS author, t.created
    FROM tinys t JOIN users u ON u.id = t.user_id
    WHERE t.user_id IN (${Array(n).fill('?').join(',')}) AND t.private = 0 AND t.active = 1
    UNION ALL
    SELECT 'tool' AS type, w.name AS title, u.github_login AS author, w.created
    FROM user_tools w JOIN users u ON u.id = w.user_id
    WHERE w.user_id IN (${Array(n).fill('?').join(',')})
  ) ORDER BY created DESC LIMIT ?`;

/**
 * Trust scores over consulted edges — damped PageRank, simplified. Pure;
 * the caller feeds edges (tests feed fixtures). Node → score, max-normalized.
 */
export function trustRank(
  edges: { src: string; dst: string; weight: number }[],
  iterations = 10,
  damping = 0.85,
): Map<string, number> {
  const nodes = new Set<string>();
  for (const e of edges) { nodes.add(e.src); nodes.add(e.dst); }
  if (!nodes.size) return new Map();
  const outWeight = new Map<string, number>();
  for (const e of edges) outWeight.set(e.src, (outWeight.get(e.src) ?? 0) + e.weight);

  let rank = new Map<string, number>(Array.from(nodes, (n) => [n, 1 / nodes.size]));
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>(Array.from(nodes, (n) => [n, (1 - damping) / nodes.size]));
    for (const e of edges) {
      const share = (rank.get(e.src) ?? 0) * (e.weight / (outWeight.get(e.src) || 1));
      next.set(e.dst, (next.get(e.dst) ?? 0) + damping * share);
    }
    rank = next;
  }
  // Array.from (not spread) — the app repo's es5 tsc also typechecks this
  // file through the tests' direct import; spread of an iterator needs
  // downlevelIteration there.
  const max = Math.max(Math.max.apply(null, Array.from(rank.values())), 1e-9);
  return new Map(Array.from(rank, ([n, s]) => [n, s / max] as [string, number]));
}

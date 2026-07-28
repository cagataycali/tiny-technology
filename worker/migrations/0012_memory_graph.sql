-- Bitemporal memory graph (idea.md): flat learnings → entity/edge graph.
-- Facts are NEVER hard-deleted — retire = set valid_to (unix secs) + insert
-- the successor. "Currently true" = valid_to IS NULL. unlearn() closes.
--
-- D1 dialect notes vs the Postgres sketch in idea.md:
--   uuid        → TEXT (crypto.randomUUID() in the worker)
--   timestamptz → INTEGER unixepoch (matches every other table here)
--   jsonb       → TEXT JSON (attrs_json, parsed in the worker)
--   pgvector    → embeddings stay in Vectorize (MEMORY index); the entity
--                 row carries vec_id ('learning:<legacy id>' for migrated
--                 rows so existing vectors are REUSED, 'entity:<id>' for
--                 new ones). The row is the truth; the vector is a pointer.
CREATE TABLE IF NOT EXISTS entity (
  id TEXT PRIMARY KEY,               -- uuid
  owner TEXT NOT NULL,               -- userId (matches learnings.user_id)
  kind TEXT NOT NULL DEFAULT 'fact', -- 'fact'|'person'|'tiny'|'project'|'concept'
  label TEXT NOT NULL,               -- short human name (deterministic at migration)
  attrs_json TEXT NOT NULL DEFAULT '{}', -- {source: <raw learn() string>, ...}
  vec_id TEXT,                       -- Vectorize id; NULL = not indexed
  visibility TEXT NOT NULL DEFAULT 'private', -- 'private'|'public'
  valid_from INTEGER NOT NULL DEFAULT (unixepoch()),
  valid_to INTEGER,                  -- NULL = currently true; set = closed
  created INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_entity_owner_live ON entity(owner, valid_to);
CREATE INDEX IF NOT EXISTS idx_entity_vec ON entity(vec_id);

CREATE TABLE IF NOT EXISTS edge (
  id TEXT PRIMARY KEY,               -- uuid
  owner TEXT NOT NULL,
  src TEXT NOT NULL REFERENCES entity(id),
  rel TEXT NOT NULL,                 -- 'supersedes'|'part_of'|'authored'|'follows'|'consulted'|'visited'
  dst TEXT NOT NULL REFERENCES entity(id),
  scope TEXT,                        -- context qualifier — load-bearing for
                                     -- conflict detection (build BEFORE it):
                                     -- 'Python for scope A' vs 'TS for scope B'
                                     -- is NOT a contradiction
  weight REAL NOT NULL DEFAULT 1.0,
  confidence REAL NOT NULL DEFAULT 1.0,
  visibility TEXT NOT NULL DEFAULT 'private',
  valid_from INTEGER NOT NULL DEFAULT (unixepoch()),
  valid_to INTEGER,
  created INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_edge_owner_src_rel ON edge(owner, src, rel) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_edge_owner_dst ON edge(owner, dst) WHERE valid_to IS NULL;

-- ── Backfill: every flat learning becomes one isolated entity ─────────────
-- Deterministic (no LLM in the migration — reproducible, re-runnable):
--   kind = 'fact', label = first 80 chars, attrs.source = raw content
--   verbatim, vec_id reuses the EXISTING Vectorize vector (learning:<id>),
--   valid_from = the learning's created. Edge extraction is a separate
--   opt-in pass later; an isolated node behaves exactly like flat memory.
-- Idempotent via the deterministic id ('mig12:' prefix + legacy rowid).
INSERT OR IGNORE INTO entity (id, owner, kind, label, attrs_json, vec_id, valid_from, created)
SELECT
  'mig12:' || id,
  user_id,
  'fact',
  substr(content, 1, 80),
  json_object('source', content, 'legacy_id', id),
  'learning:' || id,
  created,
  created
FROM learnings;

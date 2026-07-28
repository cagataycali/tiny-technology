-- Per-tiny private turn memory (private-tinys feature).
--
-- A PRIVATE tiny, when talked to by its authorized owner, records each
-- exchange here so future turns semantically recall past ones ("store every
-- turn in vector index so it remembers more things"). Every row is also
-- embedded into the Vectorize MEMORY index with metadata {name} and the
-- vector id = this row's integer id — the shape retrieve.ts's private branch
-- ALREADY reads (MEMORY.query(filter:{name}) → SELECT * FROM notes WHERE id
-- IN (...)). That read path predated any writer; this is the missing writer.
--
-- Disjoint from `learnings`: those share the same MEMORY index but key off
-- `learning:<id>` ids + {userId} metadata, so the {name} filter never crosses
-- the two. `notes` is a rolling transcript (oldest pruned past a cap), NOT the
-- deliberate, reject-when-full `learnings` store.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,        -- tiny slug this turn belongs to (recall filter key)
  user_id TEXT NOT NULL,     -- authorized owner who produced the turn
  text TEXT NOT NULL,        -- "User: …\nAssistant: …" snapshot of the exchange
  created INTEGER DEFAULT (unixepoch())
);
-- Recall filters/prunes by tiny; both ordered by recency.
CREATE INDEX IF NOT EXISTS idx_notes_name ON notes(name, created);

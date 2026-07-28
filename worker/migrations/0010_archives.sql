-- Cloud session archives (issue #7 server half): owner index for KV blobs.
-- The archive JSON itself lives in KV post (archive:<id>, 1y TTL); this
-- table is the source of truth for ownership + listing.
CREATE TABLE IF NOT EXISTS archives (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tiny_name TEXT,
  msg_count INTEGER DEFAULT 0,
  created INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_archives_user ON archives(user_id, created DESC);

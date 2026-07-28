-- Persistent per-user learnings (issue #14): the agent appends durable
-- context about the user; injected into the system prompt every session.
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_learnings_user ON learnings(user_id, created);

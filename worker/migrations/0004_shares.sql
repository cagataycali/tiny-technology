-- Shares owned by users: enables cross-device listing/revocation for
-- logged-in creators (anonymous shares keep the localStorage token flow).
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  tiny_name TEXT,
  created INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
